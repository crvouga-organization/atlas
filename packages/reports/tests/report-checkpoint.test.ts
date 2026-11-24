/**
 * The report checkpoint (issue #112): a start reads it instead of every layer, and the report is still exactly the one
 * every layer makes, whether the checkpoint is current, stale, written by several instances at once, or broken.
 */
import { describe, expect, test } from 'bun:test';

import { layerCatalogKey } from '../src/layer-store';
import type { ObjectStore } from '../src/object-store';
import { publishChecks } from '../src/publish-checks';
import { CHECKPOINT_PREFIX, SEGMENT_SIZE } from '../src/report-checkpoint';
import { ReportIndex } from '../src/report-index';
import { memoryStore } from './memory-store';

/** A store that counts reads, as a remote store would bill them. */
function counted(store: ReturnType<typeof memoryStore>) {
  let gets = 0;
  const wrapped = { ...store, get: (key: string) => { gets += 1; return store.get(key); }, gets: () => gets, reset: () => { gets = 0; store.lists = 0; } };
  return wrapped as typeof wrapped & ObjectStore;
}

/** `count` layers over a few environments and checks, so later layers supersede earlier ones and the history has depth. */
async function seed(store: ObjectStore, count: number, from = 0) {
  for (let i = from; i < from + count; i++) {
    await publishChecks(store, {
      producer: 'ci', environment: `env${i % 2}`, recordedAtMs: 1_000 + i, branch: i % 5 ? 'main' : 'feature',
      checks: [{ id: `c${i % 3}`, title: `check ${i % 3}`, status: i % 6 ? 'passed' : 'failed' }, { id: `d${i % 4}`, title: `d ${i % 4}`, status: 'passed' }]
    });
  }
}

/** The report and the history, as text: what must be equal however the index was built. */
async function built(store: ObjectStore, checkpoint?: ObjectStore, log?: (line: Record<string, unknown>) => void) {
  const index = new ReportIndex([{ id: 'data', store }], { ...(checkpoint ? { checkpoint } : {}), ...(log ? { log } : {}) });
  const fromCheckpoint = await index.restore();
  return { index, fromCheckpoint, report: index.json().text, history: JSON.stringify(index.history.tests()), runs: index.history.layers, stats: index.stats() };
}

describe('the report checkpoint', () => {
  test('a start from it reads tens of objects, not two per layer, and serves the same report and history', async () => {
    const store = counted(memoryStore());
    await seed(store, SEGMENT_SIZE + 120);
    const truth = await built(store);
    const first = await built(store, store);
    expect(first.fromCheckpoint).toBe(0);
    expect(first.report).toBe(truth.report);
    expect((await store.listKeys(CHECKPOINT_PREFIX)).length).toBeGreaterThan(1);

    store.reset();
    const second = await built(store, store);
    expect(second.fromCheckpoint).toBe(SEGMENT_SIZE + 120);
    expect(second.report).toBe(truth.report);
    expect(second.history).toBe(truth.history);
    expect(second.runs).toBe(truth.runs);
    expect(second.stats.slots).toBe(truth.stats.slots);
    // The head and two segments, not 2 × 620 objects.
    expect(store.gets()).toBeLessThan(10);
  });

  test('layers added after the checkpoint are read and join it', async () => {
    const store = counted(memoryStore());
    await seed(store, 40);
    await built(store, store);
    await seed(store, 25, 40);
    store.reset();
    const truth = await built(store);
    const everything = store.gets();
    store.reset();
    const restored = await built(store, store);
    expect(restored.fromCheckpoint).toBe(40);
    expect(restored.report).toBe(truth.report);
    // Only the 25 new layers are read (and the checkpoint): about 25/65 of reading everything.
    expect(store.gets()).toBeLessThan(everything * 0.5);
    store.reset();
    expect((await built(store, store)).fromCheckpoint).toBe(65);
  });

  test('a layer deleted since (by garbage collection) is left out: nothing points at a missing manifest', async () => {
    const store = memoryStore();
    await seed(store, 30);
    const before = await built(store, store);
    // Delete a superseded layer the way garbage collection does: its catalog entry and its manifest.
    const superseded = [...before.index.superseded()][0]!;
    const entry = (await store.listKeys('layers/index/')).find(key => key.endsWith(`-${superseded}.json`))!;
    await store.deleteMany([entry, `layers/manifests/${superseded}.json`]);
    const restored = await built(store, store);
    const truth = await built(store);
    expect(restored.report).toBe(truth.report);
    expect(restored.history).toBe(truth.history);
    expect(restored.stats.layers).toBe(29);
    expect(before.stats.layers).toBe(30);
    expect(restored.index.snapshot().notices).toEqual([]);
  });

  test('a corrupt or foreign checkpoint is ignored with a reason, and everything is read instead', async () => {
    for (const damage of ['head', 'segment', 'format'] as const) {
      const store = memoryStore();
      await seed(store, 20);
      await built(store, store);
      if (damage === 'head') await store.put(`${CHECKPOINT_PREFIX}head.json`, new TextEncoder().encode('{not json'), 'application/json');
      if (damage === 'format') await store.put(`${CHECKPOINT_PREFIX}head.json`, new TextEncoder().encode(JSON.stringify({ format: 'atlas-report-checkpoint', version: 99, segments: [] })), 'application/json');
      if (damage === 'segment') {
        const segment = (await store.listKeys(`${CHECKPOINT_PREFIX}segments/`))[0]!;
        await store.put(segment, new Uint8Array([1, 2, 3]), 'application/gzip');
      }
      const lines: Record<string, unknown>[] = [];
      const restored = await built(store, store, line => { lines.push(line); });
      expect(restored.fromCheckpoint, damage).toBe(0);
      expect(restored.report, damage).toBe((await built(store)).report);
      expect(lines.some(line => line.checkpoint === 'ignored'), damage).toBe(true);
      // And it is written again, good this time.
      expect((await built(store, store)).fromCheckpoint, damage).toBe(20);
    }
  });

  test('instances writing it at once leave one that a third reads into the full report', async () => {
    const store = memoryStore();
    await seed(store, 50);
    const a = new ReportIndex([{ id: 'data', store }], { checkpoint: store, checkpointEveryMs: 0 });
    const b = new ReportIndex([{ id: 'data', store }], { checkpoint: store, checkpointEveryMs: 0 });
    await Promise.all([a.restore(), b.restore()]);
    await seed(store, 10, 50);
    await Promise.all([a.refresh(), b.refresh()]);
    const third = await built(store, store);
    expect(third.report).toBe((await built(store)).report);
    expect(third.history).toBe((await built(store)).history);
  });

  test('an upload taken in is written to the checkpoint without reading anything back', async () => {
    const store = memoryStore();
    await seed(store, 5);
    const index = new ReportIndex([{ id: 'data', store }], { checkpoint: store, checkpointEveryMs: 0 });
    await index.restore();
    const layer = await publishChecks(store, { producer: 'ci', environment: 'web', recordedAtMs: 99_999, checks: [{ id: 'z', title: 'z', status: 'failed' }] });
    await index.accept('data', layerCatalogKey(layer.recordedAtMs, layer.id), layer);
    expect((await built(store, store)).fromCheckpoint).toBe(6);
  });
});
