/**
 * @module Layer garbage collection
 *
 * Applies a garbage collection policy (`GcPolicy`, chosen by a person in the Atlas UI and kept in the user state) to the
 * layers in a store. Atlas is otherwise deletion-free, so this is deliberately conservative: a layer is deleted only when
 * (1) the caller says the report has read it and every result it carries has been replaced by a newer layer (`eligible`),
 * (2) it was recorded longer ago than the policy allows, and (3) it is not among the newest `keepLatest` layers. Deleting
 * it therefore cannot change the combined report. Its catalog entry goes first, so nothing visible ever points at a
 * missing manifest; its manifest next; then the captured-file blobs that no remaining layer refers to. If any remaining
 * layer cannot be read, no blob is deleted: what cannot be read is unknown, never unused. Specs, runs and commit
 * inventories are not touched.
 *
 * A pass can run in bounded steps (`stepGarbage`): it works in batches of layers, writes what each batch found to a
 * scratch place before deleting anything, and stops starting batches when its deadline passes. The next step continues
 * from there, so a host that ends long requests (a serverless function) still finishes the pass, a pass killed midway is
 * finished by the next one, and the steps together delete exactly what one unbounded pass would. A dry run walks the
 * same steps without deleting, so it reports what a real pass would delete: layers, blobs and bytes.
 *
 * @see docs/server.md#user-state-and-garbage-collection
 */
import { projectObjectSizes } from './storage-usage';
import { expiredFiles, expirableFiles, expiryPrefix } from './attachment-retention';
import type { ReportLayer } from './layer-types';
import { eachLimited } from './completion-order';
import { LAYER_INDEX, layerKey } from './layer-store';
import { readBytes, readUtf8, writeUtf8 } from './object-io';
import type { ObjectStore } from './object-store';
import { parseLayerDocument } from '../../schema/src/layer';
import type { GcPolicy } from '../../schema/src/user-state';

const DAY_MS = 86_400_000;
const CATALOG = /^layers\/index\/(\d{16})-([0-9a-f]{64})\.json$/;

/** One layer the policy would delete. */
export type GcCandidate = { readonly id: string; readonly catalogKey: string; readonly recordedAtMs: number };

/** What a policy would delete from a store right now. */
export type GcPlan = {
  /** Layers to delete, oldest first. */
  readonly candidates: readonly GcCandidate[];
  /** Layers in the catalog that stay. */
  readonly kept: number;
  /** The ids of the layers that stay, when `planGarbage` made the plan: what a pass reads to keep the blobs they use. */
  readonly remaining?: readonly string[];
  /** Retained superseded layers to inspect for earlier evidence expiry. */
  readonly expiry?: { readonly ids: readonly string[]; readonly defaultBranch?: string; readonly policy: NonNullable<GcPolicy['attachments']>; readonly nowMs: number };
};

/**
 * The outcome of applying a plan. `candidateBlobs` and `candidateBytes` are what the pass found to delete (the blobs only
 * the deleted layers used, and the bytes of those blobs and of the layers' manifests), the same for a dry run as for a
 * real one; `deletedBytes` is what a real pass removed (0 for a dry run).
 */
export type GcOutcome = { readonly strippedLayers?: number; readonly deletedLayers: number; readonly deletedBlobs: number; readonly candidateBlobs?: number; readonly candidateBytes?: number; readonly deletedBytes?: number };

/**
 * Decides which layers a policy deletes, without deleting anything. `eligible` is the set of layer ids the caller has
 * read and knows no longer decide any result (`ReportIndex.superseded()`); a layer not in it is never a candidate.
 * A byte budget also measures stored objects and references. With `policy.enabled === false` the plan is empty.
 *
 * @example
 * const plan = await planGarbage(store, { policy, nowMs: Date.now(), eligible: index.superseded() });
 */
export async function planGarbage(store: ObjectStore, input: { readonly defaultBranch?: string; readonly policy: GcPolicy; readonly nowMs: number; readonly eligible: ReadonlySet<string> }): Promise<GcPlan> {
  const entries = (await store.listKeys(LAYER_INDEX)).flatMap(key => {
    const match = CATALOG.exec(key);
    return match ? [{ id: match[2]!, catalogKey: key, recordedAtMs: Number.MAX_SAFE_INTEGER - Number(match[1]) }] : [];
  });
  // Catalog keys sort newest first (the time is inverted), so the layers to always keep are the first `keepLatest`.
  entries.sort((a, b) => b.recordedAtMs - a.recordedAtMs || (a.id < b.id ? -1 : 1));
  if (!input.policy.enabled) return { candidates: [], kept: entries.length, remaining: entries.map(entry => entry.id) };
  const cutoff = input.nowMs - input.policy.maxAgeDays * DAY_MS;
  const candidates = entries.slice(input.policy.keepLatest).filter(entry => entry.recordedAtMs < cutoff && input.eligible.has(entry.id));
  if (input.policy.maxBytes !== undefined) {
    const value = input.policy.maxBytes;
    const units: Record<string, number> = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
    const budget = typeof value === 'number' ? value : parseInt(value, 10) * units[value.slice(-2).toUpperCase()]!;
    const sizes = await projectObjectSizes(store);
    let projected = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    if (projected > budget) {
      const files = new Map<string, string[]>(), uses = new Map<string, number>();
      let unknown = false;
      await eachLimited(entries, 16, async entry => {
        const layer = await readSizedLayer(store, entry.id);
        if (!layer) { unknown = true; return; }
        files.set(entry.id, layer.blobs);
        for (const blob of layer.blobs) uses.set(blob, (uses.get(blob) ?? 0) + 1);
      });
      const aged = new Set(candidates.map(entry => entry.id));
      for (const entry of entries.slice(input.policy.keepLatest).reverse()) {
        if (!input.eligible.has(entry.id) || !files.has(entry.id)) continue;
        if (!aged.has(entry.id)) {
          if (projected <= budget) break;
          candidates.push(entry);
        }
        projected -= (sizes.get(entry.catalogKey) ?? 0) + (sizes.get(layerKey(entry.id)) ?? 0);
        for (const blob of files.get(entry.id)!) {
          const count = uses.get(blob)! - 1;
          uses.set(blob, count);
          if (!count && !unknown) projected -= sizes.get(blob) ?? 0;
        }
      }
      candidates.sort((a, b) => b.recordedAtMs - a.recordedAtMs || a.catalogKey.localeCompare(b.catalogKey));
    }
  }
  const doomed = new Set(candidates.map(candidate => candidate.id));
  const expiry = input.policy.attachments && { ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}), policy: input.policy.attachments, nowMs: input.nowMs, ids: entries.filter(entry => !doomed.has(entry.id) && input.eligible.has(entry.id)).map(entry => entry.id) };
  return { ...(expiry?.ids.length ? { expiry } : {}), candidates: candidates.reverse(), kept: entries.length - candidates.length, remaining: entries.filter(entry => !doomed.has(entry.id)).map(entry => entry.id) };
}

/**
 * Where a bounded pass keeps what it has found between steps: small JSON documents by name. `storeScratch` keeps them in
 * a store under a prefix (so another process can continue the pass); `memoryScratch` keeps them for one call.
 */
export type GcScratch = {
  /** A document written earlier, or null. */
  read<T>(name: string): Promise<T | null>;
  /** Writes (or replaces) a document. */
  write(name: string, value: unknown): Promise<void>;
  /** Removes everything this pass wrote. */
  clear(): Promise<void>;
};

/** Scratch documents in `store` under `prefix`, so a pass can be continued by another process. */
export function storeScratch(store: ObjectStore, prefix: string): GcScratch {
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return {
    async read<T>(name: string) { const text = await readUtf8(store, `${base}${name}`); return text === null ? null : JSON.parse(text) as T; },
    write: (name, value) => writeUtf8(store, `${base}${name}`, JSON.stringify(value), 'application/json'),
    async clear() { await store.deleteMany(await store.listKeys(base)); }
  };
}

/** Scratch documents in memory, for a pass that runs to the end in one call. */
export function memoryScratch(): GcScratch {
  const docs = new Map<string, string>();
  return {
    async read<T>(name: string) { const text = docs.get(name); return text === undefined ? null : JSON.parse(text) as T; },
    async write(name, value) { docs.set(name, JSON.stringify(value)); },
    async clear() { docs.clear(); }
  };
}

/** How far a bounded pass over one store has come. When `done`, nothing is left and the counts are final. */
export type GcStep = GcOutcome & {
  readonly done: boolean;
  readonly phase: 'layers' | 'scan' | 'blobs' | 'done';
  readonly candidates: number;
  /** Candidate layers examined (and, in a real pass, deleted) so far. */
  readonly layersExamined: number;
  /** Remaining layers read so far, to find the blobs they still use. */
  readonly layersScanned: number;
  /** True when a layer could not be read, so no blob is deleted: what cannot be read is unknown, never unused. */
  readonly unreadable: boolean;
};

/** Options of one step of a bounded pass. */
export type GcStepOptions = {
  /** Count and report, delete nothing. */
  readonly dryRun?: boolean;
  /** Start no new batch once the clock passes this (epoch ms). Default: never stop early. */
  readonly deadline?: number;
  /** The clock the deadline is read with. Default `Date.now`. */
  readonly now?: () => number;
  /** Layers or blobs per batch. Default 50. */
  readonly batch?: number;
  /** Told after every batch, with the progress so far. */
  readonly onBatch?: (progress: GcStep) => void | Promise<void>;
};

type StepState = { phase: GcStep['phase']; offset: number };
type LayerBatch = { ids: string[]; blobs: string[]; bytes: number; unreadable: boolean };
type UsedBatch = { blobs: string[]; unreadable: boolean; expired?: string[]; receipts?: { id: string; keys: string[] }[] };
type Orphans = { strippedLayers?: number; blobs: string[]; considered: string[]; unreadable: boolean };
type BlobBatch = { count: number; bytes: number };

const decoder = new TextDecoder();

/** The blobs a layer's manifest names and the manifest's size in bytes, or null when it is missing or unreadable. */
async function readSizedLayer(store: ObjectStore, id: string): Promise<{ blobs: string[]; bytes: number; layer: ReportLayer } | null> {
  try {
    const stored = await store.get(layerKey(id));
    if (!stored) return null;
    const bytes = await readBytes(stored.body);
    const parsed = parseLayerDocument(JSON.parse(decoder.decode(bytes)));
    if (!parsed.ok) return null;
    const bundle = (parsed.layer as unknown as { bundle: Record<string, { parts: { blob: string }[] }> }).bundle;
    return { layer: parsed.layer as unknown as ReportLayer, blobs: [...new Set(Object.values(bundle).flatMap(file => file.parts.map(part => part.blob)))], bytes: bytes.length };
  } catch {
    return null;
  }
}

/** The size of one object without reading its bytes; 0 when it is missing. */
async function sizeOf(store: ObjectStore, key: string): Promise<number> {
  const stored = await store.get(key).catch(() => null);
  if (!stored) return 0;
  await stored.body.cancel().catch(() => {});
  return stored.size;
}

const chunk = <T>(items: readonly T[], size: number, index: number) => items.slice(index * size, (index + 1) * size);

/**
 * One bounded step of applying a plan, continuing from what `scratch` holds. Batches of candidate layers are read (the
 * blobs they use and their sizes written to scratch first) and then deleted, catalog entry first; then the remaining
 * layers are read to see which blobs they still use; then the blobs only the deleted layers used are counted and deleted.
 * What each batch found is written before anything is deleted and every delete is idempotent, so a step that is stopped
 * or killed is finished by the next, and the steps together delete exactly what one unbounded pass would. Layers
 * published after the plan are read before any blob is deleted, so a blob a new layer uses is kept. No new batch starts
 * after `deadline`.
 *
 * Give every step of one pass the same `plan` (with `remaining`) and the same scratch; the server keeps both in the store.
 *
 * @example
 * const scratch = storeScratch(store, 'server/gc/runs/abc/default/');
 * let step;
 * do step = await stepGarbage(store, scratch, plan, { deadline: Date.now() + 60_000 }); while (!step.done);
 */
export async function stepGarbage(store: ObjectStore, scratch: GcScratch, plan: GcPlan, options: GcStepOptions = {}): Promise<GcStep> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const size = Math.max(1, options.batch ?? 50);
  const remaining = plan.remaining ?? [];
  const inspectExpiry = new Set(plan.expiry?.ids);
  const layerBatches = Math.ceil(plan.candidates.length / size);
  const scanBatches = Math.ceil(remaining.length / size);
  let state = (await scratch.read<StepState>('state.json')) ?? { phase: plan.candidates.length ? 'layers' : inspectExpiry.size ? 'scan' : 'done', offset: 0 };
  const save = async (next: StepState) => { state = next; await scratch.write('state.json', next); };

  const progress = async (): Promise<GcStep> => {
    const layersDone = state.phase === 'layers' ? state.offset : layerBatches;
    const layers = (await Promise.all(Array.from({ length: layersDone }, (_, i) => scratch.read<LayerBatch>(`layers-${i}.json`)))).filter((batch): batch is LayerBatch => batch !== null);
    const orphans = await scratch.read<Orphans>('orphans.json');
    const blobBatches = orphans ? Math.ceil(orphans.blobs.length / size) : 0;
    const blobsDone = state.phase === 'blobs' ? state.offset : state.phase === 'done' ? blobBatches : 0;
    const blobs = (await Promise.all(Array.from({ length: blobsDone }, (_, i) => scratch.read<BlobBatch>(`blobs-${i}.json`)))).filter((batch): batch is BlobBatch => batch !== null);
    const examined = layers.reduce((sum, batch) => sum + batch.ids.length, 0);
    const bytes = layers.reduce((sum, batch) => sum + batch.bytes, 0) + blobs.reduce((sum, batch) => sum + batch.bytes, 0);
    const blobCount = blobs.reduce((sum, batch) => sum + batch.count, 0);
    return {
      done: state.phase === 'done', phase: state.phase, candidates: plan.candidates.length,
      layersExamined: state.phase === 'layers' ? Math.min(plan.candidates.length, state.offset * size) : plan.candidates.length,
      layersScanned: state.phase === 'scan' ? Math.min(remaining.length, state.offset * size) : state.phase === 'layers' ? 0 : remaining.length,
      ...(plan.expiry ? { strippedLayers: orphans?.strippedLayers ?? 0 } : {}),
      unreadable: layers.some(batch => batch.unreadable) || (orphans?.unreadable ?? false),
      deletedLayers: dryRun ? 0 : examined, deletedBlobs: dryRun ? 0 : blobCount,
      candidateBlobs: orphans?.blobs.length ?? 0, candidateBytes: bytes, deletedBytes: dryRun ? 0 : bytes
    };
  };
  const tell = async () => { if (options.onBatch) await options.onBatch(await progress()); };

  // At least one batch per step, however short the budget, so every step moves the pass on.
  let worked = false;
  while (state.phase !== 'done' && (!worked || now() < deadline)) {
    if (state.phase === 'layers') {
      if (state.offset >= layerBatches) { await save({ phase: 'scan', offset: 0 }); continue; }
      const batch = chunk(plan.candidates, size, state.offset);
      // What the batch uses is written before anything is deleted, so its blobs are known even if the pass stops here.
      let found = await scratch.read<LayerBatch>(`layers-${state.offset}.json`);
      if (!found) {
        const ids: string[] = [];
        const blobs = new Set<string>();
        let bytes = 0;
        let unreadable = false;
        await eachLimited(batch, 16, async candidate => {
          const layer = await readSizedLayer(store, candidate.id);
          // A candidate that cannot be read stays, and so does every blob: unknown is not garbage.
          if (!layer) { unreadable = true; return; }
          ids.push(candidate.id);
          bytes += layer.bytes;
          for (const blob of layer.blobs) blobs.add(blob);
        });
        found = { ids: ids.sort(), blobs: [...blobs].sort(), bytes, unreadable };
        await scratch.write(`layers-${state.offset}.json`, found);
      }
      if (!dryRun && found.ids.length) {
        const ids = new Set(found.ids);
        // The catalog entry first: nothing visible ever points at a missing manifest.
        await store.deleteMany(batch.filter(candidate => ids.has(candidate.id)).map(candidate => candidate.catalogKey));
        await store.deleteMany(found.ids.map(id => layerKey(id)));
        await eachLimited(found.ids, 16, async id => {
          const receipts = await store.listKeys(expiryPrefix(id));
          if (receipts.length) await store.deleteMany(receipts);
        });
      }
      await save({ phase: 'layers', offset: state.offset + 1 });
      worked = true;
      await tell();
      continue;
    }
    if (state.phase === 'scan') {
      if (state.offset >= scanBatches) { await save({ phase: 'blobs', offset: 0 }); continue; }
      const scanKey = `used-${state.offset}.json`;
      let used = await scratch.read<UsedBatch>(scanKey);
      if (!used) {
        const expired = new Set<string>();
        const receipts: { id: string; keys: string[] }[] = [];
        const blobs = new Set<string>();
        let unreadable = false;
        await eachLimited(chunk(remaining, size, state.offset), 16, async id => {
          const layer = await readSizedLayer(store, id);
          if (!layer) { unreadable = true; return; }
          if (!inspectExpiry.has(id) || !plan.expiry) {
            for (const blob of layer.blobs) blobs.add(blob);
            return;
          }
          const previous = new Set(await expiredFiles(store, id));
          const keys = expirableFiles(layer.layer, plan.expiry.policy, plan.expiry.nowMs, plan.expiry.defaultBranch).filter(key => !previous.has(key));
          const omit = new Set([...previous, ...keys]);
          if (keys.length) receipts.push({ id, keys });
          for (const [key, file] of Object.entries(layer.layer.bundle)) {
            for (const part of file.parts) (omit.has(key) ? expired : blobs).add(part.blob);
          }
        });
        used = { blobs: [...blobs].sort(), unreadable, expired: [...expired], receipts };
        await scratch.write(scanKey, used);
      }
      if (!dryRun) await eachLimited(used.receipts ?? [], 16, async receipt => {
        for (const key of receipt.keys) await store.put(expiryPrefix(receipt.id) + key, new Uint8Array(), 'application/octet-stream');
      });
      await save({ phase: 'scan', offset: state.offset + 1 });
      worked = true;
      await tell();
      continue;
    }
    // Blobs: which ones is worked out once from every batch, then checked against layers that arrived since.
    let orphans = await scratch.read<Orphans>('orphans.json');
    if (!orphans) {
      const doomed = new Set<string>();
      const keep = new Set<string>();
      let unreadable = false;
      for (let i = 0; i < layerBatches; i++) {
        const batch = await scratch.read<LayerBatch>(`layers-${i}.json`);
        if (!batch) { unreadable = true; continue; }
        unreadable ||= batch.unreadable;
        for (const blob of batch.blobs) doomed.add(blob);
      }
      let strippedLayers = 0;
      for (let i = 0; i < scanBatches; i++) {
        const batch = await scratch.read<UsedBatch>(`used-${i}.json`);
        if (!batch) { unreadable = true; continue; }
        unreadable ||= batch.unreadable;
        strippedLayers += batch.receipts?.length ?? 0;
        for (const blob of batch.expired ?? []) doomed.add(blob);
        for (const blob of batch.blobs) keep.add(blob);
      }
      const unused = [...doomed].filter(blob => !keep.has(blob)).sort();
      const present: string[] = [];
      if (!unreadable && plan.expiry) await eachLimited(unused, 16, async blob => { if (await store.head(blob)) present.push(blob); });
      orphans = { strippedLayers, blobs: unreadable ? [] : plan.expiry ? present.sort() : unused, considered: [...plan.candidates.map(candidate => candidate.id), ...remaining].sort(), unreadable };
    }
    // Only blobs not yet deleted can still be saved by a newly published layer; those already gone stay gone.
    const pending = orphans.blobs.slice(state.offset * size);
    if (pending.length) {
      const considered = new Set(orphans.considered);
      const arrived = (await store.listKeys(LAYER_INDEX)).flatMap(key => CATALOG.exec(key)?.[2] ?? []).filter(id => !considered.has(id));
      if (arrived.length) {
        const still = new Set<string>();
        let unreadable = false;
        await eachLimited(arrived, 16, async id => {
          const layer = await readSizedLayer(store, id);
          if (!layer) { unreadable = true; return; }
          for (const blob of layer.blobs) still.add(blob);
        });
        const done = orphans.blobs.slice(0, state.offset * size);
        orphans = unreadable
          ? { ...orphans, blobs: done, unreadable: true }
          : { ...orphans, blobs: [...done, ...pending.filter(blob => !still.has(blob))], considered: [...orphans.considered, ...arrived].sort() };
      }
    }
    await scratch.write('orphans.json', orphans);
    const blobBatches = Math.ceil(orphans.blobs.length / size);
    while (state.offset < blobBatches && (!worked || now() < deadline)) {
      const batch = chunk(orphans.blobs, size, state.offset);
      let counted = await scratch.read<BlobBatch>(`blobs-${state.offset}.json`);
      if (!counted) {
        let bytes = 0;
        // Read first, then add: `bytes += await …` would read `bytes` before the wait and lose the other sizes.
        await eachLimited(batch, 16, async blob => { const size = await sizeOf(store, blob); bytes += size; });
        counted = { count: batch.length, bytes };
        await scratch.write(`blobs-${state.offset}.json`, counted);
      }
      if (!dryRun) await store.deleteMany(batch);
      await save({ phase: 'blobs', offset: state.offset + 1 });
      worked = true;
      await tell();
    }
    if (state.offset >= blobBatches) await save({ phase: 'done', offset: 0 });
  }
  return progress();
}

/**
 * Applies a plan in one call: the unbounded form of {@link stepGarbage}, with what it finds kept in memory. Deletes the
 * layers of the plan, then the blobs only they used; with `dryRun` it deletes nothing and only counts. Store errors throw
 * after whatever was already deleted; running the same plan again finishes the job, because every delete is idempotent
 * and the catalog entry (what makes a layer visible) always goes before the content.
 */
export async function collectGarbage(store: ObjectStore, plan: GcPlan, options: { readonly dryRun?: boolean } = {}): Promise<GcOutcome> {
  if (!plan.candidates.length && !plan.expiry) return { deletedLayers: 0, deletedBlobs: 0, candidateBlobs: 0, candidateBytes: 0, deletedBytes: 0 };
  const doomed = new Set(plan.candidates.map(candidate => candidate.id));
  const remaining = plan.remaining ?? (await store.listKeys(LAYER_INDEX)).flatMap(key => CATALOG.exec(key)?.[2] ?? []).filter(id => !doomed.has(id));
  const step = await stepGarbage(store, memoryScratch(), { ...plan, remaining }, { dryRun: options.dryRun ?? false });
  return { ...(plan.expiry ? { strippedLayers: step.strippedLayers } : {}), deletedLayers: step.deletedLayers, deletedBlobs: step.deletedBlobs, candidateBlobs: step.candidateBlobs ?? 0, candidateBytes: step.candidateBytes ?? 0, deletedBytes: step.deletedBytes ?? 0 };
}
