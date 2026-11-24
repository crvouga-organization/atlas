/**
 * @module Report checkpoint
 *
 * A server that starts would read every layer's catalog entry and manifest (two requests per layer, every start). The
 * checkpoint keeps, in the store, what folding each layer needs (its evidence and the specs it recorded), packed into
 * gzip segments of a few hundred layers, and a head that names the segments with their SHA-256. A starting `ReportIndex`
 * reads the head and the segments (tens of requests instead of tens of thousands) and uses them as a cache of
 * catalog entry to evidence: the catalog listing still decides which layers take part, so a layer deleted by garbage
 * collection is not folded and a layer the checkpoint does not know is read as before. The report is therefore exactly
 * the one recomputed from every layer, with or without a checkpoint, current or stale.
 *
 * Segments are immutable and named by their content, so instances that write at once never conflict; the head is
 * overwritten, and any head names a correct set. A head that cannot be read, is of another format, or names a segment
 * whose bytes do not match is ignored with a notice, and the index reads everything as before.
 *
 * @see docs/server.md#performance
 */

import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import type { LayerEvidence } from './evidence-types';
import type { SpecEntry } from './explorer-types';
import { readBytes } from './object-io';
import type { ObjectStore } from './object-store';
import { sha256Hex } from './sigv4';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Where the checkpoint lives in a store. */
export const CHECKPOINT_PREFIX = 'server/checkpoint/v1/';
const HEAD = `${CHECKPOINT_PREFIX}head.json`;
const SEGMENTS = `${CHECKPOINT_PREFIX}segments/`;
/** The format a reader understands. Another is ignored and rebuilt, never guessed at. */
const FORMAT = 'atlas-report-checkpoint';
const VERSION = 1;
/** Layers per closed segment. */
export const SEGMENT_SIZE = 500;
/** The largest segment a reader accepts, uncompressed: a guard against a corrupt or hostile object. */
const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;

/** What folding one layer needs: which catalog entry of which backend (`mark`, `<backend>|<key>`), its evidence and its recorded specs. */
export type CheckpointEntry = { readonly mark: string; readonly evidence: LayerEvidence; readonly specs: readonly SpecEntry[] };

type SegmentRef = { readonly key: string; readonly sha256: string; readonly count: number };
type Head = { readonly format: typeof FORMAT; readonly version: number; readonly writtenAtMs: number; readonly layers: number; readonly segments: readonly SegmentRef[] };

/** A checkpoint as read: every entry by mark, the closed segments (with the marks in each) that may be named again unchanged, and the open segment's entries. */
export type LoadedCheckpoint = { readonly entries: Map<string, CheckpointEntry>; readonly closed: readonly { readonly ref: SegmentRef; readonly marks: readonly string[] }[]; readonly open: readonly CheckpointEntry[] };

/**
 * Reads the checkpoint in `store`. Returns `null` when there is none, and `{ error }` when there is one that cannot be
 * trusted (unreadable, another format, a segment missing or not matching its digest): the caller reads everything instead.
 */
export async function readCheckpoint(store: ObjectStore): Promise<LoadedCheckpoint | { readonly error: string } | null> {
  let head: Head;
  try {
    const found = await store.get(HEAD);
    if (!found) return null;
    head = JSON.parse(new TextDecoder().decode(await readBytes(found.body))) as Head;
  } catch (error) {
    return { error: `the report checkpoint's head could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (head?.format !== FORMAT || head.version !== VERSION || !Array.isArray(head.segments)) return { error: `the report checkpoint is not format ${FORMAT} v${VERSION}` };
  try {
    const segments = await Promise.all(head.segments.map(async ref => {
      if (typeof ref?.key !== 'string' || !ref.key.startsWith(SEGMENTS) || typeof ref.sha256 !== 'string') throw new Error('a segment reference is malformed');
      const found = await store.get(ref.key);
      if (!found) throw new Error(`segment ${ref.key} is missing`);
      const packed = await readBytes(found.body);
      if ((await sha256Hex(packed)) !== ref.sha256) throw new Error(`segment ${ref.key} does not match its digest`);
      const entries = JSON.parse(new TextDecoder().decode(await gunzipAsync(packed, { maxOutputLength: MAX_SEGMENT_BYTES }))) as CheckpointEntry[];
      if (!Array.isArray(entries) || entries.length !== ref.count || !entries.every(entry => typeof entry?.mark === 'string' && entry.evidence && typeof entry.evidence.id === 'string' && Array.isArray(entry.evidence.rows))) throw new Error(`segment ${ref.key} is not what its head says`);
      share(entries);
      return { ref, entries };
    }));
    const entries = new Map<string, CheckpointEntry>();
    for (const segment of segments) for (const entry of segment.entries) entries.set(entry.mark, entry);
    const closed = segments.filter(segment => segment.ref.count >= SEGMENT_SIZE).map(segment => ({ ref: segment.ref, marks: segment.entries.map(entry => entry.mark) }));
    const open = segments.filter(segment => segment.ref.count < SEGMENT_SIZE).flatMap(segment => segment.entries);
    return { entries, closed, open };
  } catch (error) {
    return { error: `the report checkpoint cannot be used (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * Parsed text makes a new copy of every repeated string and of every small object rows share when read from a layer
 * (a check's variant, its empty lists), which would cost several times the memory of reading the layers. The fields that
 * repeat are made one value again as a segment is read: strings by their text, a flat object by its plain values.
 */
function share(entries: CheckpointEntry[]): void {
  const strings = new Map<string, string>();
  const objects = new Map<string, unknown>();
  const text = <T>(value: T): T => {
    if (typeof value !== 'string' || value.length > 512) return value;
    const found = strings.get(value);
    if (found !== undefined) return found as T;
    strings.set(value, value);
    return value;
  };
  const flat = <T>(value: T): T => {
    if (value === null || typeof value !== 'object') return value;
    let id: string;
    if (Array.isArray(value)) {
      if (value.length) return value;
      id = '[]';
    } else {
      id = '{';
      for (const [name, item] of Object.entries(value)) {
        if (item !== null && typeof item === 'object') return value;
        id += `${name}\u0001${typeof item}\u0001${String(item)}\u0002`;
      }
    }
    const found = objects.get(id);
    if (found !== undefined) return found as T;
    objects.set(id, value);
    return value;
  };
  for (const entry of entries) {
    for (const row of entry.evidence.rows as unknown as Record<string, unknown>[]) {
      for (const field of ['kind', 'id', 'title', 'status', 'specPath', 'detail', 'testId']) if (field in row) row[field] = text(row[field]);
      row.variant = flat(row.variant);
      row.measurements = flat(row.measurements);
    }
    const layer = entry.evidence.layer as unknown as Record<string, unknown>;
    for (const field of ['backend', 'producer', 'packageDir', 'sha', 'branch', 'environment', 'runUrl']) if (field in layer) layer[field] = text(layer[field]);
    for (const field of ['parameters', 'counts', 'recording', 'execution', 'live']) if (field in layer) layer[field] = flat(layer[field]);
  }
}

/** Writes one segment (named by its content, so writing it again is harmless) and returns its reference. */
export async function writeSegment(store: ObjectStore, entries: readonly CheckpointEntry[]): Promise<SegmentRef> {
  const packed = new Uint8Array(await gzipAsync(new TextEncoder().encode(JSON.stringify(entries))));
  const sha256 = await sha256Hex(packed);
  const key = `${SEGMENTS}${sha256}.json.gz`;
  // Always written: one already there under this name may be damaged, and the same bytes again are harmless.
  await store.put(key, packed, 'application/gzip');
  return { key, sha256, count: entries.length };
}

/** Points the checkpoint at these segments. Written last, so a reader never sees a head whose segments are not there. */
export async function writeHead(store: ObjectStore, segments: readonly SegmentRef[], now: number): Promise<void> {
  const head: Head = { format: FORMAT, version: VERSION, writtenAtMs: now, layers: segments.reduce((sum, segment) => sum + segment.count, 0), segments };
  await store.put(HEAD, new TextEncoder().encode(JSON.stringify(head)), 'application/json');
}

/**
 * Removes segments the current head does not name and `keep` does not either (the segments this writer just named, in
 * case another head was written meanwhile). A segment another writer names in a head written after this reads it is
 * at worst re-read as missing: that reader then reads everything, and writes a checkpoint again.
 */
export async function pruneSegments(store: ObjectStore, keep: ReadonlySet<string>): Promise<number> {
  const current = await store.get(HEAD).then(async found => (found ? JSON.parse(new TextDecoder().decode(await readBytes(found.body))) as Head : null), () => null);
  const named = new Set([...keep, ...(current?.segments ?? []).map(segment => segment.key)]);
  const unused = (await store.listKeys(SEGMENTS)).filter(key => !named.has(key));
  if (unused.length) await store.deleteMany(unused);
  return unused.length;
}

/** Removes the checkpoint: the next start reads every layer and writes a new one. */
export async function dropCheckpoint(store: ObjectStore): Promise<void> {
  await store.delete(HEAD);
}

/**
 * What a `ReportIndex` keeps to write its checkpoint: the closed segments already in the store, and the entries folded
 * since (at most a segment's worth, so memory stays small). `flush` closes full segments, rewrites the open one and
 * the head; it is called after a refresh, at most every `everyMs`, and does nothing when nothing changed.
 */
export class CheckpointWriter {
  readonly #store: ObjectStore;
  readonly #now: () => number;
  readonly #everyMs: number;
  readonly #log: ((line: Record<string, unknown>) => void) | undefined;
  #closed: SegmentRef[] = [];
  #open: CheckpointEntry[] = [];
  #marks = new Set<string>();
  #dirty = false;
  #flushedAt = 0;
  #flushes = 0;
  /** Writes happen one after another. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: { readonly store: ObjectStore; readonly now?: () => number; readonly everyMs?: number; readonly log?: (line: Record<string, unknown>) => void }) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#everyMs = options.everyMs ?? 5 * 60_000;
    this.#log = options.log;
  }

  /**
   * Start from what was read: closed segments whose every layer is still in the report are named again unchanged; the
   * rest of their layers (and the open segment's) are carried as open entries. `kept` says which marks took part.
   */
  resume(loaded: LoadedCheckpoint, kept: ReadonlySet<string>): void {
    for (const { ref, marks } of loaded.closed) {
      // A closed segment whose layers all still take part is named again as it is; one that lost a layer is repacked.
      if (marks.every(mark => kept.has(mark))) { this.#closed.push(ref); for (const mark of marks) this.#marks.add(mark); }
      else this.#dirty = true;
    }
    for (const entry of loaded.entries.values()) if (kept.has(entry.mark)) this.add(entry);
    if (loaded.open.length) this.#dirty = true;
  }

  /** A layer was folded. A full segment is written at once, so a first read of a large store never holds every layer. */
  add(entry: CheckpointEntry): void {
    if (this.#marks.has(entry.mark)) return;
    this.#marks.add(entry.mark);
    this.#open.push(entry);
    this.#dirty = true;
    if (this.#open.length >= SEGMENT_SIZE) {
      const full = this.#open.splice(0, SEGMENT_SIZE);
      this.#run(async () => { this.#closed.push(await writeSegment(this.#store, full)); });
    }
  }

  /** Write what changed, if anything did and the last write is old enough (or `force`). Never throws: a failed write is logged and tried again later. */
  flush(force = false): Promise<void> {
    if (!this.#dirty || (!force && this.#now() - this.#flushedAt < this.#everyMs)) return this.#queue;
    this.#dirty = false;
    return this.#run(async () => {
      const open = this.#open.length ? [await writeSegment(this.#store, [...this.#open])] : [];
      await writeHead(this.#store, [...this.#closed, ...open], this.#now());
      this.#flushedAt = this.#now();
      // Now and then, remove what no head names any more (open segments replaced since).
      if (++this.#flushes % 20 === 1) await pruneSegments(this.#store, new Set([...this.#closed, ...open].map(segment => segment.key)));
    });
  }

  #run(task: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(task).catch(error => {
      // Not written: say so, and write everything again next time.
      this.#dirty = true;
      this.#log?.({ level: 'warn', checkpoint: 'write', error: error instanceof Error ? error.message : String(error) });
    });
    return this.#queue;
  }
}
