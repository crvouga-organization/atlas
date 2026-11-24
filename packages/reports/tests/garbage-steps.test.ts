/**
 * Garbage collection in bounded steps: steps of any size delete exactly what one unbounded pass does, a pass killed
 * midway is finished by the next step without deleting anything that still decides a result, a layer published midway
 * keeps the blobs it uses, and a dry run reports what a real pass deletes, blobs and bytes included.
 */
import { describe, expect, test } from 'bun:test';

import { combineBackends } from '../src/compose';
import { collectGarbage, memoryScratch, planGarbage, stepGarbage, storeScratch, type GcPlan } from '../src/garbage';
import type { ObjectStore } from '../src/object-store';
import { publishChecks } from '../src/publish-checks';
import { ReportIndex } from '../src/report-index';
import { memoryStore } from './memory-store';

const DAY = 86_400_000;
const NOW = 1000 * DAY;
const POLICY = { enabled: true, maxAgeDays: 30, keepLatest: 1, intervalHours: 24 };

/** Twelve days of results for two checks: each day a new log, and a file every day shares. Older layers are superseded. */
async function history(store: ObjectStore, days = 12) {
  for (let day = 1; day <= days; day++) {
    await publishChecks(store, {
      producer: 'suite', recordedAtMs: day * DAY,
      checks: [
        { id: 'login', title: 'login', status: day % 3 ? 'passed' : 'failed', attachments: [{ name: 'log.txt', text: `login day ${day} `.repeat(3000) }, { name: 'shared.txt', text: 'the same every day' }] },
        { id: 'logout', title: 'logout', status: 'passed', attachments: [{ name: 'log.txt', text: `logout day ${day} `.repeat(3000) }] }
      ]
    });
  }
}

async function planFor(store: ObjectStore): Promise<GcPlan> {
  const index = new ReportIndex([{ id: 's', store }]);
  await index.refresh();
  return planGarbage(store, { policy: POLICY, nowMs: NOW, eligible: index.superseded() });
}

/** Sizes of every object, to compare stores and count bytes. */
const contents = async (store: ObjectStore) => {
  const sizes = new Map<string, number>();
  for (const key of await store.listKeys('layers/')) { const stored = (await store.get(key))!; sizes.set(key, stored.size); await stored.body.cancel(); }
  return sizes;
};

/** A clock that moves one millisecond each time it is read, so a deadline of `now()` allows exactly one batch per step. */
const ticking = () => { let at = 0; return () => (at += 1); };

describe('garbage collection in bounded steps', () => {
  test('steps of one batch each delete exactly what one unbounded pass deletes', async () => {
    const whole = memoryStore(), stepped = memoryStore();
    await history(whole);
    await history(stepped);
    const unbounded = await collectGarbage(whole, await planFor(whole));
    const plan = await planFor(stepped);
    const scratch = memoryScratch();
    const now = ticking();
    let steps = 0;
    let step;
    do { step = await stepGarbage(stepped, scratch, plan, { batch: 2, now, deadline: now() }); steps += 1; } while (!step.done && steps < 1000);
    expect(step.done).toBe(true);
    expect(steps).toBeGreaterThan(5);
    expect(unbounded).toMatchObject({ deletedLayers: 11, deletedBlobs: 11 });
    expect({ deletedLayers: step.deletedLayers, deletedBlobs: step.deletedBlobs, deletedBytes: step.deletedBytes }).toEqual({ deletedLayers: unbounded.deletedLayers, deletedBlobs: unbounded.deletedBlobs, deletedBytes: unbounded.deletedBytes });
    expect([...(await contents(stepped)).keys()]).toEqual([...(await contents(whole)).keys()]);
  });

  test('a pass killed midway is finished by the next step, and nothing that still decides a result is deleted', async () => {
    const reference = memoryStore(), store = memoryStore();
    await history(reference);
    await history(store);
    await collectGarbage(reference, await planFor(reference));
    const before = await combineBackends([{ id: 's', store }]);
    const plan = await planFor(store);
    // The pass keeps what it found in the store itself, so a new process can carry it on.
    const scratch = () => storeScratch(store, 'server/gc/runs/test/default/');
    // Kill it on the fifth delete request: mid-batch, after some layers went and before the blobs.
    let deletes = 0;
    const dying: ObjectStore = { ...store, withPrefix: store.withPrefix.bind(store), deleteMany: async keys => { if (++deletes === 5) throw new Error('killed'); return store.deleteMany(keys); } };
    expect(await stepGarbage(dying, scratch(), plan, { batch: 2 }).then(() => 'finished', (error: Error) => error.message)).toBe('killed');
    const halfway = await combineBackends([{ id: 's', store }]);
    expect(halfway.summary).toEqual(before.summary);
    // A fresh process, the same plan and scratch: it finishes.
    const step = await stepGarbage(store, scratch(), plan, { batch: 2 });
    expect(step.done).toBe(true);
    const after = await combineBackends([{ id: 's', store }]);
    expect(after.summary).toEqual(before.summary);
    expect([...(await contents(store)).keys()].filter(key => !key.startsWith('server/'))).toEqual([...(await contents(reference)).keys()]);
  });

  test('a layer published midway keeps the blobs it uses', async () => {
    const store = memoryStore();
    await history(store);
    const plan = await planFor(store);
    const scratch = memoryScratch();
    const now = ticking();
    let step = await stepGarbage(store, scratch, plan, { batch: 2, now, deadline: now() });
    while (step.phase !== 'blobs' && !step.done) step = await stepGarbage(store, scratch, plan, { batch: 2, now, deadline: now() });
    // Day 1's login log, about to be deleted as an orphan, is published again by a new layer.
    await publishChecks(store, { producer: 'other', recordedAtMs: 13 * DAY, checks: [{ id: 'audit', title: 'audit', status: 'passed', attachments: [{ name: 'log.txt', text: `login day 1 `.repeat(3000) }] }] });
    while (!step.done) step = await stepGarbage(store, scratch, plan, { batch: 2 });
    const report = await combineBackends([{ id: 's', store }]);
    expect(report.notices).toEqual([]);
    for (const key of await store.listKeys('layers/manifests/')) {
      const layer = JSON.parse(await new Response((await store.get(key))!.body).text()) as { bundle: Record<string, { parts: { blob: string }[] }> };
      for (const file of Object.values(layer.bundle)) for (const part of file.parts) expect(await store.head(part.blob)).toBe(true);
    }
  });

  test('a dry run deletes nothing and reports the layers, blobs and bytes a real pass deletes', async () => {
    const dry = memoryStore(), real = memoryStore();
    await history(dry);
    await history(real);
    const keysBefore = [...(await contents(dry)).keys()];
    const preview = await collectGarbage(dry, await planFor(dry), { dryRun: true });
    expect([...(await contents(dry)).keys()]).toEqual(keysBefore);
    expect(preview).toMatchObject({ deletedLayers: 0, deletedBlobs: 0, deletedBytes: 0, candidateBlobs: 11 });

    const sizes = await contents(real);
    const done = await collectGarbage(real, await planFor(real));
    const left = await contents(real);
    const freed = [...sizes].filter(([key]) => !left.has(key) && !key.startsWith('layers/index/')).reduce((sum, [, size]) => sum + size, 0);
    expect(done.deletedBytes).toBe(freed);
    expect(preview.candidateBytes).toBe(freed);
    expect(preview.candidateBlobs).toBe(done.deletedBlobs);
  });
});
