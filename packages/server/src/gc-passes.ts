/**
 * @module Garbage collection passes
 *
 * A garbage collection pass over every project, kept in the store so that any server instance can report it and carry
 * it on. A pass is started once (a second start while one runs returns that one), then advanced: on a long-running server
 * to the end in the background; on a serverless host in steps bounded by a time budget, each continued by the next
 * request, scheduled pass or poll. Each project's part is applied with `stepGarbage`, whose findings are kept in the store
 * too (`server/gc/runs/<id>/<project>/`), so a pass that stops or is killed is finished by the next step, never started
 * over, and never deletes more than one unbounded pass would. The time a pass judges ages against is fixed when it starts.
 *
 * Two instances could try to advance one pass at once: a lease in the pass record keeps them apart (the store has no
 * conditional writes, so the lease is written, then read back). What each batch found is written before it acts, so
 * even an overlap repeats idempotent work rather than deleting anything that is still used.
 *
 * @see docs/server.md#user-state-and-garbage-collection
 */
import { randomUUID } from 'node:crypto';

import { planGarbage, stepGarbage, storeScratch, type GcPlan, type GcStep } from '../../reports/src/garbage';
import { readUtf8, writeUtf8 } from '../../reports/src/object-io';
import type { ObjectStore } from '../../reports/src/object-store';
import type { GcPass, GcPolicy, GcRun } from '../../schema/src/user-state';

/** Where passes are kept, beside the other server state. */
export const GC_PREFIX = 'server/gc/';
const CURRENT = `${GC_PREFIX}current.json`;
/** The runs of the newest finished real pass, for `GET /api/settings/gc` on any instance. */
export const GC_LAST_RUNS = `${GC_PREFIX}last-runs.json`;
/** A worker's claim on a pass lasts this long past its budget; one that stops renewing it is taken over after that. */
const LEASE_SLACK_MS = 60_000;
/** How many finished passes are kept for `GET /api/settings/gc/runs/{id}`. */
const KEEP_FINISHED = 20;

type Stored = GcPass & { readonly policy: GcPolicy; readonly nowMs: number; readonly projectList: readonly string[]; readonly lease?: { readonly owner: string; readonly until: number } | null };

/** What one project offers a pass: its store, and the layers its report has read that no longer decide any result. */
export type GcSource = { readonly store: ObjectStore; readonly eligible: ReadonlySet<string>; readonly defaultBranch?: string };

/** What `GcPasses` needs from the server. */
export type GcPassesOptions = {
  /** Where pass records and their findings are kept: the node's own store. */
  readonly store: ObjectStore;
  /** The projects a pass covers, in order. */
  readonly projects: () => Promise<readonly string[]>;
  /** A project's store and eligible layers, or null when it cannot be collected now (the reason is recorded). */
  readonly source: (project: string) => Promise<GcSource | { readonly error: string }>;
  /** Told of the runs of every finished real pass. */
  readonly record?: (runs: readonly GcRun[]) => void;
  /** The clock ages are judged by and times are recorded with. Default `Date.now`. */
  readonly now?: () => number;
  /** The clock budgets and leases are measured with: one that moves. Default `Date.now`. */
  readonly tick?: () => number;
  readonly log?: (line: Record<string, unknown>) => void;
};

const emptyProgress = (projects: number): GcPass['progress'] => ({ projects, projectsDone: 0, project: null, phase: null, candidates: 0, layersExamined: 0, deletedLayers: 0, deletedBlobs: 0, candidateBlobs: 0, candidateBytes: 0, deletedBytes: 0 });

/** The public view of a stored pass: what the API answers. */
export function publicPass(stored: Stored): GcPass {
  const { policy: _policy, nowMs: _now, projectList: _projects, lease: _lease, ...pass } = stored;
  return pass;
}

/**
 * Garbage collection passes kept in the store. One instance per server; every method may be called from any instance of a
 * deployment, since nothing it relies on is held only in memory.
 *
 * @example
 * const passes = new GcPasses({ store, projects: async () => ['default'], source: async () => ({ store, eligible: index.superseded() }) });
 * const pass = await passes.start(policy, { dryRun: false });
 * await passes.advance(pass.id, { budgetMs: 60_000 });
 */
export class GcPasses {
  readonly #options: GcPassesOptions;
  readonly #now: () => number;
  readonly #tick: () => number;
  readonly #owner = randomUUID();
  /** Passes this process is advancing right now, so one process never advances one pass twice at once. */
  readonly #working = new Map<string, Promise<GcPass>>();

  constructor(options: GcPassesOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#tick = options.tick ?? Date.now;
  }

  async #read(id: string): Promise<Stored | null> {
    if (!/^[a-z0-9-]{8,64}$/.test(id)) return null;
    const text = await readUtf8(this.#options.store, `${GC_PREFIX}runs/${id}.json`);
    return text === null ? null : JSON.parse(text) as Stored;
  }

  async #write(pass: Stored): Promise<void> {
    await writeUtf8(this.#options.store, `${GC_PREFIX}runs/${pass.id}.json`, JSON.stringify(pass), 'application/json');
  }

  /** A pass by its id, or null. */
  async get(id: string): Promise<GcPass | null> {
    const stored = await this.#read(id);
    return stored ? publicPass(stored) : null;
  }

  /** The pass running now, or null. */
  async current(): Promise<GcPass | null> {
    const text = await readUtf8(this.#options.store, CURRENT);
    const id = text ? (JSON.parse(text) as { id?: string }).id : undefined;
    const stored = id ? await this.#read(id) : null;
    return stored && stored.status === 'running' ? publicPass(stored) : null;
  }

  /** The runs of the newest finished real pass, as kept in the store. */
  async lastRuns(): Promise<readonly GcRun[]> {
    const text = await readUtf8(this.#options.store, GC_LAST_RUNS).catch(() => null);
    return text ? (JSON.parse(text) as { runs?: GcRun[] }).runs ?? [] : [];
  }

  /**
   * Start a pass under `policy`, or return the one already running (whatever kind it is): there is only ever one. The
   * time the policy's ages are judged against is fixed now, so every step of the pass agrees on what is old enough.
   */
  async start(policy: GcPolicy, options: { readonly dryRun: boolean }): Promise<GcPass> {
    const running = await this.current();
    if (running) return running;
    const projects = [...await this.#options.projects()];
    const at = new Date(this.#now()).toISOString();
    const pass: Stored = {
      id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, status: 'running', dryRun: options.dryRun, startedAt: at, updatedAt: at, finishedAt: null,
      progress: emptyProgress(projects.length), runs: [], policy, nowMs: this.#now(), projectList: projects, lease: null
    };
    await this.#write(pass);
    await writeUtf8(this.#options.store, CURRENT, JSON.stringify({ id: pass.id }), 'application/json');
    this.#options.log?.({ level: 'info', gc: 'start', pass: pass.id, dryRun: pass.dryRun, projects: projects.length });
    return publicPass(pass);
  }

  /**
   * Carry a running pass on, until it is done or `budgetMs` has passed (default: to the end). Returns the pass as it
   * then stands. Another worker holding the pass's lease makes this return at once, with nothing done.
   */
  advance(id: string, options: { readonly budgetMs?: number } = {}): Promise<GcPass> {
    const working = this.#working.get(id);
    if (working) return working;
    const work = this.#advance(id, options.budgetMs ?? Number.POSITIVE_INFINITY).finally(() => this.#working.delete(id));
    this.#working.set(id, work);
    return work;
  }

  /** Is this process advancing that pass right now? */
  busy(id: string): boolean {
    return this.#working.has(id);
  }

  async #advance(id: string, budgetMs: number): Promise<GcPass> {
    let pass = await this.#read(id);
    if (!pass) throw new Error(`No garbage collection pass ${id}`);
    if (pass.status !== 'running') return publicPass(pass);
    const started = this.#tick();
    const deadline = started + budgetMs;
    const leaseFor = () => Math.min(Number.MAX_SAFE_INTEGER, (Number.isFinite(budgetMs) ? deadline : this.#tick() + 10 * 60_000) + LEASE_SLACK_MS);
    if (pass.lease && pass.lease.owner !== this.#owner && pass.lease.until > started) return publicPass(pass);
    // Claim it, then make sure the claim stuck: another instance may have claimed it at the same moment.
    pass = { ...pass, lease: { owner: this.#owner, until: leaseFor() } };
    await this.#write(pass);
    const confirmed = await this.#read(id);
    if (!confirmed || confirmed.lease?.owner !== this.#owner) return publicPass(confirmed ?? pass);

    let lastWrite = this.#tick();
    const save = async (next: Stored, force = false) => {
      pass = { ...next, updatedAt: new Date(this.#now()).toISOString(), lease: { owner: this.#owner, until: leaseFor() } };
      if (force || this.#tick() - lastWrite > 1000) { lastWrite = this.#tick(); await this.#write(pass); }
    };
    try {
      // At least one project step, however short the budget, so every advance moves the pass on.
      let worked = false;
      while (pass.progress.projectsDone < pass.projectList.length) {
        if (worked && this.#tick() >= deadline) break;
        worked = true;
        const project = pass.projectList[pass.progress.projectsDone]!;
        const before = pass.runs.length;
        const step = await this.#project(pass, project, deadline, async (progress, phase) => {
          await save({ ...pass!, progress: { ...this.#totals(pass!), ...this.#add(this.#totals(pass!), progress), project, phase } });
        });
        if (step === null) break;
        if (pass.runs.length !== before) continue;
        if (!step.done) { await save({ ...pass, progress: { ...this.#totals(pass), ...this.#add(this.#totals(pass), step), project, phase: step.phase } }, true); break; }
        const run: GcRun = {
          project, dryRun: pass.dryRun, at: new Date(this.#now()).toISOString(), candidates: step.candidates, deletedLayers: step.deletedLayers, deletedBlobs: step.deletedBlobs,
          ...(step.strippedLayers !== undefined ? { strippedLayers: step.strippedLayers } : {}), keptLayers: step.kept, candidateBlobs: step.candidateBlobs ?? 0, candidateBytes: step.candidateBytes ?? 0, deletedBytes: step.deletedBytes ?? 0,
          ...(step.unreadable ? { error: 'A layer could not be read, so no captured files were deleted: what cannot be read is unknown, never unused.' } : {})
        };
        const runs = [...pass.runs, run];
        await save({ ...pass, runs, progress: { ...this.#totals({ ...pass, runs }), projects: pass.projectList.length, projectsDone: runs.length, project: null, phase: null } }, true);
        await storeScratch(this.#options.store, `${GC_PREFIX}runs/${pass.id}/${project}/`).clear().catch(() => {});
      }
      if (pass.progress.projectsDone >= pass.projectList.length) await this.#finish(pass, 'done');
      else {
        // Out of budget: let go, so the next step (on this instance or another) carries it on at once.
        pass = { ...pass, lease: null, updatedAt: new Date(this.#now()).toISOString() };
        await this.#write(pass);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#options.log?.({ level: 'error', gc: 'pass', pass: id, error: message });
      // A store error leaves the pass running: the next step carries it on from what was already written.
      pass = { ...pass, lease: null, updatedAt: new Date(this.#now()).toISOString(), error: message };
      await this.#write(pass).catch(() => {});
    }
    return publicPass(pass);
  }

  /** One project's part of a pass: its plan is made once and kept, then stepped until done or the deadline. */
  async #project(pass: Stored, project: string, deadline: number, onBatch: (progress: GcStep, phase: string) => Promise<void>): Promise<(GcStep & { readonly kept: number }) | null> {
    const scratch = storeScratch(this.#options.store, `${GC_PREFIX}runs/${pass.id}/${project}/`);
    let plan = await scratch.read<GcPlan>('plan.json');
    const source = await this.#options.source(project);
    if ('error' in source) {
      // A project that cannot be collected now is recorded as such, and the pass moves on.
      const run: GcRun = { project, dryRun: pass.dryRun, at: new Date(this.#now()).toISOString(), candidates: 0, deletedLayers: 0, deletedBlobs: 0, keptLayers: 0, error: source.error };
      Object.assign(pass, { runs: [...pass.runs, run], progress: { ...pass.progress, projectsDone: pass.runs.length + 1 } });
      await this.#write(pass);
      return { done: true, phase: 'done', candidates: 0, layersExamined: 0, layersScanned: 0, unreadable: false, deletedLayers: 0, deletedBlobs: 0, kept: 0 };
    }
    if (!plan) {
      // Made once per pass and kept: every later step of this pass works from the same plan.
      plan = await planGarbage(source.store, { policy: { ...pass.policy, enabled: true }, nowMs: pass.nowMs, defaultBranch: source.defaultBranch, eligible: source.eligible });
      await scratch.write('plan.json', plan);
    }
    const step = await stepGarbage(source.store, scratch, plan, { dryRun: pass.dryRun, deadline, now: this.#tick, onBatch: progress => onBatch(progress, progress.phase) });
    return { ...step, kept: plan.kept };
  }

  /** The totals of the projects already finished. */
  #totals(pass: Stored): GcPass['progress'] {
    const sum = (field: 'candidates' | 'deletedLayers' | 'deletedBlobs' | 'candidateBlobs' | 'candidateBytes' | 'deletedBytes') => pass.runs.reduce((total, run) => total + (run[field] ?? 0), 0);
    return { ...pass.progress, projectsDone: pass.runs.length, candidates: sum('candidates'), layersExamined: sum('candidates'), deletedLayers: sum('deletedLayers'), deletedBlobs: sum('deletedBlobs'), candidateBlobs: sum('candidateBlobs'), candidateBytes: sum('candidateBytes'), deletedBytes: sum('deletedBytes') };
  }

  /** Finished totals plus the project in progress. */
  #add(totals: GcPass['progress'], step: GcStep): Partial<GcPass['progress']> {
    return {
      candidates: totals.candidates + step.candidates, layersExamined: totals.layersExamined + step.layersExamined, deletedLayers: totals.deletedLayers + step.deletedLayers,
      deletedBlobs: totals.deletedBlobs + step.deletedBlobs, candidateBlobs: totals.candidateBlobs + (step.candidateBlobs ?? 0),
      candidateBytes: totals.candidateBytes + (step.candidateBytes ?? 0), deletedBytes: totals.deletedBytes + (step.deletedBytes ?? 0)
    };
  }

  async #finish(pass: Stored, status: 'done' | 'failed'): Promise<void> {
    const at = new Date(this.#now()).toISOString();
    const finished: Stored = { ...pass, status, finishedAt: at, updatedAt: at, lease: null, progress: { ...pass.progress, project: null, phase: null } };
    await this.#write(finished);
    Object.assign(pass, finished);
    await this.#options.store.delete(CURRENT).catch(() => {});
    await storeScratch(this.#options.store, `${GC_PREFIX}runs/${pass.id}/`).clear().catch(() => {});
    if (!pass.dryRun && status === 'done') {
      this.#options.record?.(pass.runs);
      await writeUtf8(this.#options.store, GC_LAST_RUNS, JSON.stringify({ runs: pass.runs }), 'application/json').catch(() => {});
    }
    this.#options.log?.({ level: 'info', gc: status, pass: pass.id, dryRun: pass.dryRun, deletedLayers: pass.progress.deletedLayers, deletedBlobs: pass.progress.deletedBlobs });
    await this.#prune().catch(() => {});
  }

  /** Keep the newest finished passes; older records go. */
  async #prune(): Promise<void> {
    const records = (await this.#options.store.listKeys(`${GC_PREFIX}runs/`)).filter(key => /^server\/gc\/runs\/[a-z0-9-]+\.json$/.test(key)).sort();
    if (records.length > KEEP_FINISHED) await this.#options.store.deleteMany(records.slice(0, records.length - KEEP_FINISHED));
  }
}
