/** @module Live run leases
 * Tracks producer heartbeats independently of progress, publishes completed checks incrementally, and persists
 * bounded run summaries. A server restart interrupts outstanding leases rather than inventing continued progress.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod/v4';
import { LiveRunSchema, type LiveRun, type LiveRunStartSchema, type LiveRunUpdateSchema } from '../../schema/src/live-run';
import { isPaged, canWriteConditionally, type ConditionalWrites, type ObjectStore } from '../../reports/src/object-store';
import { readBytes, readUtf8, writeUtf8 } from '../../reports/src/object-io';
import { publishChecks } from '../../reports/src/publish-checks';
import { layerEvidence, layerResultKeys, combineEvidence, replaces } from '../../reports/src/layer-merge';
import { eachLimited } from '../../reports/src/completion-order';
import { layerKey, readLayer, layerCatalogKey } from '../../reports/src/layer-store';
import type { ReportLayer } from '../../reports/src/layer-types';

type Start = z.output<typeof LiveRunStartSchema>;
type Update = z.output<typeof LiveRunUpdateSchema>;
type Attempt = { sequence: number; digest: string; at: number; input: Update };
class Changed extends Error {}
type Held = { tag?: string; run: LiveRun; owner: string; digest: string; states: Map<string, string> };
const PREFIX = 'server/live/';
const keyOf = (run: Pick<LiveRun, 'id' | 'startedAtMs'>) => `${PREFIX}${String(Number.MAX_SAFE_INTEGER - run.startedAtMs).padStart(16, '0')}-${run.id}.json`;

/** A refused run update: 403 another publisher, 404 unknown run, 409 stale/terminal run, or 429 capacity. */
export class LiveRunError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 429, message: string) { super(message); }
}

/**
 * One server's live feed. Heartbeats never create result layers. Persisted summaries contain at most 20 recent
 * checks and 10 active checks; completed results live in ordinary immutable layers. Leases expire by server time.
 * @example
 * const live = new LiveRuns({ store, timeoutMs: 30_000, stalledMs: 900_000, onChange: () => {}, onLayer: async () => {} });
 */
export class LiveRuns {
  private readonly progress = new Map<string, Map<string, number>>();
  private readonly held = new Map<string, Held>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Resolves after restoring summaries and interrupting leases left by a previous server process. */
  readonly ready: Promise<void>;
  private readonly shared?: ObjectStore & ConditionalWrites;
  private readonly now: () => number;
  constructor(private readonly options: { store: ObjectStore; shared?: boolean; timeoutMs: number; stalledMs: number; now?: () => number; onChange: (run: LiveRun) => void; onLayer: (key: string, layer: ReportLayer) => Promise<void> }) {
    if (options.shared && canWriteConditionally(options.store)) this.shared = options.store;
    this.now = options.now ?? Date.now;
    this.ready = this.restore();
    // Requests await ready and surface failures; no unhandled rejection while a backend is unavailable.
    void this.ready.catch(() => undefined);
  }
  private async recentKeys(): Promise<readonly string[]> {
    const store = this.options.store;
    return isPaged(store) ? (await store.listPage(PREFIX, { limit: 200 })).keys : (await store.listKeys(PREFIX)).slice(0, 200);
  }
  private async restore(): Promise<void> {
    const keys = await this.recentKeys();
    for (const key of keys) {
      if (this.shared) { await this.loadShared(key); continue; }
      const text = await readUtf8(this.options.store, key);
      if (text === null) continue;
      const stored = JSON.parse(text) as { run: unknown; owner: string; digest: string };
      const run = LiveRunSchema.parse(stored.run);
      const state: Held = { run, owner: stored.owner, digest: stored.digest, states: new Map() };
      this.held.set(run.id, state);
      if (run.status === 'running') await this.interrupt(state, 'The Atlas server restarted before the run completed.');
    }
  }
  private async loadShared(key: string): Promise<void> {
    const object = await this.options.store.get(key);
    if (!object) return;
    if (!object.etag) { await object.body.cancel(); throw new Error('The live lease has no storage version.'); }
    const snapshot = JSON.parse(new TextDecoder().decode(await readBytes(object.body))) as {
      run: LiveRun; owner: string; digest: string; states?: [string, string][]; progress?: [string, number][]; attempt?: Attempt;
    };
    const run = LiveRunSchema.parse(snapshot.run);
    const previous = this.held.get(run.id);
    const held = { run, owner: snapshot.owner, digest: snapshot.digest, states: new Map(snapshot.states), tag: object.etag };
    this.held.set(run.id, held);
    if (run.status === 'running' && !snapshot.states) {
      try { await this.interrupt(held, 'The previous server did not persist the check identities required to resume this lease.'); }
      catch (error) { if (error instanceof Changed) return this.loadShared(key); throw error; }
      return;
    }
    if (snapshot.attempt) this.attempts.set(run.id, snapshot.attempt);
    else this.attempts.delete(run.id);
    if (snapshot.progress) this.progress.set(run.id, new Map(snapshot.progress));
    else this.progress.delete(run.id);
    if (previous?.tag !== object.etag) this.options.onChange(run);
  }
  private async save(state: Held, attempt?: Attempt): Promise<void> {
    const key = keyOf(state.run);
    const core = { run: state.run, owner: state.owner, digest: state.digest };
    if (!this.shared) return writeUtf8(this.options.store, key, JSON.stringify(core), 'application/json');
    const text = JSON.stringify({ ...core, states: [...state.states], attempt,
      progress: state.run.status === 'running' && this.progress.has(state.run.id) ? [...this.progress.get(state.run.id)!] : undefined });
    if (!await this.shared.putConditional(key, new TextEncoder().encode(text), 'application/json', state.tag ?? null)) throw new Changed();
    // A reserved update must use the version of its reservation for the final write.
    if (attempt) {
      const reserved = await this.shared.get(key);
      if (!reserved) throw new Changed();
      if (new TextDecoder().decode(await readBytes(reserved.body)) !== text) throw new Changed();
      if (!reserved.etag) throw new Error('The live lease has no storage version.');
      state.tag = reserved.etag;
    }
  }
  private locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.shared) return action();
      for (let retry = 0; retry < 12; retry++) {
        try {
          const known = this.held.get(id);
          const key = known ? keyOf(known.run) : await readUtf8(this.shared, `server/live-ids/${id}`);
          if (key) await this.loadShared(key);
          return await action();
        } catch (error) { if (!(error instanceof Changed)) throw error; }
      }
      throw new LiveRunError(409, 'Another instance updated this run. Retry the request.');
    });
    this.queues.set(id, next);
    return next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); });
  }
  private state(id: string, owner: string): Held {
    const held = this.held.get(id);
    if (!held) throw new LiveRunError(404, 'Unknown run.');
    if (held.owner !== owner) throw new LiveRunError(403, 'This run belongs to another publisher.');
    return held;
  }
  private async interrupt(state: Held, reason: string): Promise<void> {
    const next: Held = { ...state, states: new Map(), run: { ...state.run, status: 'interrupted', reason, finishedAtMs: this.now(), running: 0,
      current: state.run.current.map(check => ({ ...check, status: 'not-run', detail: reason })) } };
    await this.save(next);
    this.progress.delete(next.run.id);
    this.held.set(next.run.id, next);
    this.options.onChange(next.run);
  }
  private expired(run: LiveRun): string | undefined {
    if (this.now() - run.lastHeartbeatAtMs >= this.options.timeoutMs) return 'Producer heartbeat timed out. The run may have exited or lost its connection.';
    if (this.options.stalledMs > 0 && this.now() - run.lastProgressAtMs >= this.options.stalledMs) return 'No test progress arrived before the configured stall timeout.';
    return undefined;
  }
  private async requireLive(state: Held): Promise<void> {
    if (state.run.status !== 'running') throw new LiveRunError(409, 'This run has ended.');
    const reason = this.expired(state.run);
    if (reason) { await this.interrupt(state, reason); throw new LiveRunError(409, reason); }
  }

  /** Read the most recent 50 summaries. Progress detail and counters are already bounded and cached. */
  async list(): Promise<LiveRun[]> {
    await this.ready;
    if (this.shared) await this.sweep();
    return [...this.held.values()].map(state => state.run).sort((a, b) => b.startedAtMs - a.startedAtMs || a.id.localeCompare(b.id)).slice(0, 50);
  }
  /** Register one producer lease. Retrying an identical start is idempotent. */
  async start(input: Start, owner: string): Promise<LiveRun> {
    await this.ready;
    return this.locked(input.id, async () => {
      const prior = this.held.get(input.id);
      if (prior) {
        const found = this.state(input.id, owner);
        if (Object.entries(input).some(([key, value]) => found.run[key as keyof LiveRun] !== value)) throw new LiveRunError(409, 'A run id cannot be reused with another identity.');
        return found.run;
      }
      if ([...this.held.values()].filter(state => state.run.status === 'running').length >= 100) throw new LiveRunError(429, 'Too many live runs.');
      let now = this.now();
      if (this.shared) {
        const pointer = `server/live-ids/${input.id}`;
        const key = keyOf({ startedAtMs: now, id: input.id });
        if (!await this.shared.putConditional(pointer, new TextEncoder().encode(key), 'text/plain', null)) {
          const assigned = await readUtf8(this.shared, pointer);
          if (!assigned) throw new Changed();
          now = Number.MAX_SAFE_INTEGER - Number(assigned.slice(PREFIX.length, PREFIX.length + 16));
          await this.loadShared(assigned);
          if (this.held.has(input.id)) throw new Changed();
        }
      }
      const state: Held = { owner, digest: '', states: new Map(), run: { ...input, status: 'running', sequence: 0, startedAtMs: now, lastHeartbeatAtMs: now, lastProgressAtMs: now, completed: 0, passed: 0, failed: 0, notRun: 0, running: 0, current: [], recent: [] } };
      await this.save(state);
      this.held.set(input.id, state);
      // Retain bounded terminal history in memory; durable summaries remain in the configured backend.
      if (this.held.size > 200) {
        const old = [...this.held.values()].filter(value => value.run.status !== 'running').sort((a, b) => a.run.startedAtMs - b.run.startedAtMs)[0];
        if (old) this.held.delete(old.run.id);
      }
      this.options.onChange(state.run);
      return state.run;
    });
  }
  /** Renew liveness by server receipt time, independently of whether a test made progress. */
  async heartbeat(id: string, owner: string): Promise<void> {
    await this.ready;
    await this.locked(id, async () => {
      const state = this.state(id, owner);
      if (this.shared && this.attempts.has(id)) {
        await this.apply(id, this.attempts.get(id)!.input, owner);
        throw new Changed();
      }
      await this.requireLive(state);
      const next = { ...state, run: { ...state.run, lastHeartbeatAtMs: this.now() } };
      await this.save(next);
      this.held.set(id, next);
      this.options.onChange(next.run);
    });
  }
  /** Apply one ordered progress batch and publish its completed checks before acknowledging it. */
  async update(id: string, input: Update, owner: string): Promise<LiveRun> {
    await this.ready;
    return this.locked(id, () => this.apply(id, input, owner));
  }
  private async apply(id: string, input: Update, owner: string): Promise<LiveRun> {
    const state = this.state(id, owner);
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (input.sequence === state.run.sequence && digest === state.digest) return state.run;
    if (!this.shared || !this.attempts.has(id)) await this.requireLive(state);
    if (input.sequence !== state.run.sequence + 1) throw new LiveRunError(409, 'This run ended or its progress sequence is stale.');
    if (state.states.size + input.checks.filter(check => !state.states.has(check.id)).length > 100_000) throw new LiveRunError(429, 'A live run may track at most 100000 check identities.');
    const priorAttempt = this.attempts.get(id);
    if (priorAttempt && (priorAttempt.sequence !== input.sequence || priorAttempt.digest !== digest)) throw new LiveRunError(409, 'Retry the pending sequence with identical content.');
    const now = priorAttempt?.at ?? Math.max(this.now(), state.run.lastProgressAtMs + 1);
    const states = new Map(state.states);
    const run = { ...state.run, sequence: input.sequence, lastHeartbeatAtMs: now, ...(input.checks.length ? { lastProgressAtMs: now } : {}) };
    const current = new Map(run.current.map(check => [check.id, check]));
    for (const check of input.checks) {
      const prior = states.get(check.id);
      if (prior === 'running') run.running--;
      else if (prior) { run.completed--; if (prior === 'passed') run.passed--; else if (prior === 'failed') run.failed--; else run.notRun--; }
      states.set(check.id, check.status);
      if (check.status === 'running') { run.running++; current.set(check.id, check); }
      else { run.completed++; if (check.status === 'passed') run.passed++; else if (check.status === 'failed') run.failed++; else run.notRun++; current.delete(check.id); }
    }
    run.current = [...current.values()].slice(-10);
    run.recent = [...input.checks].reverse().concat(run.recent.filter(check => !input.checks.some(next => next.id === check.id))).slice(0, 20);
    if (input.finish) {
      if (input.finish === 'completed' && run.running) throw new LiveRunError(409, 'Finish running checks before completing the run.');
      run.status = input.finish;
      run.finishedAtMs = now;
      run.reason = input.reason;
      if (input.finish === 'interrupted') { run.running = 0; run.current = run.current.map(check => ({ ...check, status: 'not-run', detail: input.reason ?? 'Run interrupted.' })); }
      states.clear();
    }
    const finished = input.checks.filter(check => check.status !== 'running');
    const attempt = { sequence: input.sequence, digest, at: now, input };
    if (this.shared && !priorAttempt) await this.save(state, attempt);
    this.attempts.set(id, attempt);
    if (finished.length) {
      const layer = await publishChecks(this.options.store, { producer: state.run.producer, environment: state.run.environment, branch: state.run.branch, sha: state.run.sha, recordedAtMs: now,
        ...(run.compactOnFinish ? { run: { id } } : {}), labels: { 'atlas.run': id }, checks: finished });
      if (run.compactOnFinish) {
        const progress = this.progress.get(id) ?? new Map<string, number>();
        progress.set(layer.id, layer.recordedAtMs);
        this.progress.set(id, progress);
      }
      await this.options.onLayer(layerCatalogKey(layer.recordedAtMs, layer.id), layer);
    }
    if (run.status === 'completed' && this.progress.has(id)) {
      await writeUtf8(this.options.store, `server/live-compaction/${id}.json`, JSON.stringify({ owner, summary: keyOf(run), layers: [...this.progress.get(id)!] }), 'application/json');
    }
    const next = { ...state, states, run, digest };
    await this.save(next);
    this.held.set(id, next);
    this.attempts.delete(id);
    if (input.finish) this.progress.delete(id);
    this.options.onChange(run);
    return run;
  }
  /** Remove progress layers that a durable final layer of this completed invocation supersedes in every slot. */
  async compact(id: string, owner: string, final: ReportLayer | readonly ReportLayer[], eligible: ReadonlySet<string>, forget: (ids: ReadonlySet<string>) => Promise<void>): Promise<void> {
    await this.ready;
    await this.locked(id, async () => {
      const receipt = `server/live-compaction/${id}.json`;
      const text = await readUtf8(this.options.store, receipt);
      if (!text) return;
      const record = JSON.parse(text) as { owner: string; summary: string; layers: [string, number][] };
      if (owner !== record.owner) throw new LiveRunError(403, 'This run belongs to another publisher.');
      const summary = await readUtf8(this.options.store, record.summary);
      if (!summary || JSON.parse(summary).run?.status !== 'completed') return;
      const finals: readonly ReportLayer[] = Array.isArray(final) ? final : [final as ReportLayer];
      const first = finals[0];
      if (!first || finals.some(layer => layer.run?.id !== id || layer.labels?.['atlas.run'] || layer.branch !== first.branch || layer.freshness !== first.freshness)) throw new LiveRunError(409, 'Expected the final layer of this invocation.');
      const finalRows = finals.map(layer => layerEvidence(layer, ''));
      const winners = new Map(combineEvidence({ specs: [], sha: null, changedFiles: [] }, finalRows).unassigned.map(result => [result.key, result]));
      const removed = new Set<string>();
      await eachLimited(record.layers, 16, async ([layerId, time]) => {
        if (!eligible.has(layerId)) return;
        const layer = await readLayer(this.options.store, layerId);
        if (layer) {
          if (layer.labels?.['atlas.run'] !== id || layer.branch !== first.branch || layer.freshness !== first.freshness) return;
          const prior = layerEvidence(layer, '');
          const keyOf = layerResultKeys(prior.layer);
          if (!prior.rows.every(row => {
            const winner = winners.get(keyOf(row));
            return winner && replaces(winner, { ...winner, layer: prior.layer, row });
          })) return;
          await this.options.store.delete(layerCatalogKey(time, layerId));
          await this.options.store.delete(layerKey(layerId));
        }
        removed.add(layerId);
      });
      await forget(removed);
      await this.options.store.delete(receipt);
    });
  }

  /** Expire silent producers and optional progress stalls. Heartbeats cannot revive an expired run. */
  async sweep(): Promise<void> {
    await this.ready;
    if (this.shared) {
      const keys = await this.recentKeys();
      const recent = new Set(keys);
      for (const [id, state] of this.held) {
        if (state.run.status !== 'running' && !recent.has(keyOf(state.run)) && !this.queues.has(id)) this.held.delete(id);
      }
      for (const key of keys) {
        const id = key.slice(PREFIX.length + 17, -5);
        if (!this.held.has(id)) await this.locked(id, () => this.loadShared(key));
      }
    }
    const running = [...this.held.values()].filter(state => state.run.status === 'running');
    await Promise.all(running.map(({ run: { id } }) => this.locked(id, async () => {
      const state = this.held.get(id)!;
      if (state.run.status !== 'running') return;
      const reason = this.expired(state.run);
      if (reason && this.shared && this.attempts.has(id)) {
        await this.apply(id, this.attempts.get(id)!.input, state.owner);
      } else if (reason) await this.interrupt(state, reason);
    })));
  }
}
