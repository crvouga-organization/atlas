/**
 * @module Garbage collection policy tests
 *
 * The policy is defined through the API the Atlas UI uses, stored as JSON in S3 (a fake S3 here) and nowhere else, read
 * back from S3 every time the server collects, and applied to every project. With no policy saved, nothing is deleted.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { publishChecks } from '../../reports/src/publish-checks';
import { writeUtf8 } from '../../reports/src/object-io';
import { createAtlasServer, type AtlasServer } from '../src/app';
import { loadServerConfig } from '../src/config';
import { storedSettings } from '../src/settings';
import { USER_STATE_KEY, userStateStore } from '../src/user-state';
import { fakeS3, S3_TEST_ENV } from './fake-s3';
import { storeOn } from './fake-s3-store';

const DAY = 86_400_000;
const NOW = 1000 * DAY;
const apps: AtlasServer[] = [];
const dirs: string[] = [];
afterEach(async () => { apps.splice(0).forEach(app => app.close()); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function layersOf(store: ReturnType<typeof storeOn>, days: number[]) {
  for (const day of days) await publishChecks(store, { producer: 'suite', recordedAtMs: day * DAY, checks: [{ id: 'login', title: 'login', status: 'passed', attachments: [{ name: 'log.txt', text: `day ${day} `.repeat(3000) }] }] });
}

async function setup(options: { gcCheckMs?: number; days?: number[]; gcWaitMs?: number; gcBudgetMs?: number; slowMs?: number; s3?: ReturnType<typeof fakeS3> } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'atlas-gc-'));
  dirs.push(dir);
  const s3 = options.s3 ?? fakeS3();
  if (!options.s3) await layersOf(storeOn(s3), options.days ?? [1, 2, 3, 4]);
  // A store that answers slowly, so a pass is still running when it is asked about.
  const served = options.slowMs ? { ...s3, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { await new Promise(resolve => setTimeout(resolve, options.slowMs)); return s3.fetch(input, init); }) as typeof s3.fetch } : s3;
  const config = loadServerConfig([], S3_TEST_ENV, dir, () => '{}');
  const { settings, gc } = storedSettings(config, [], S3_TEST_ENV, dir, userStateStore(storeOn(served)));
  const app = createAtlasServer({
    backends: [{ id: 's3', store: storeOn(served) }], write: 's3', settings, gc, now: () => NOW, refreshMs: 60_000,
    tokens: [{ name: 'admin', role: 'admin', token: 'admin-token-123' }, { name: 'ci', role: 'publish', token: 'publish-token-123' }],
    ...(options.gcCheckMs ? { gcCheckMs: options.gcCheckMs } : {}),
    ...(options.gcWaitMs !== undefined ? { gcWaitMs: options.gcWaitMs } : {}),
    ...(options.gcBudgetMs !== undefined ? { gcBudgetMs: options.gcBudgetMs } : {})
  });
  apps.push(app);
  await app.ready;
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://atlas${url}`, { method, headers: { authorization: 'Bearer admin-token-123', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const read = async () => (await (await call('GET', '/api/settings/gc')).json()) as { revision: string; policy: unknown; saved: boolean; lastRuns: { project: string; deletedLayers: number }[]; stateKey: string };
  const save = async (policy: unknown) => call('PUT', '/api/settings/gc', policy, { 'if-match': `"${(await read()).revision}"` });
  return { dir, s3, app, call, read, save, layerKeys: () => storeOn(s3).listKeys('layers/index/') };
}

const POLICY = { enabled: true, maxAgeDays: 30, keepLatest: 1, intervalHours: 24 };

describe('the garbage collection policy', () => {
  test('before one is saved, the API says so explicitly, nothing is deleted, and nothing is written to S3', async () => {
    const { read, call, s3, layerKeys } = await setup();
    expect(await read()).toMatchObject({ policy: null, saved: false, lastRuns: [], stateKey: 'server/state.json' });
    const run = await call('POST', '/api/settings/gc/run');
    expect(run.status).toBe(409);
    expect((await run.json()).detail).toContain('No garbage collection policy has been saved yet');
    expect((await layerKeys()).length).toBe(4);
    expect(s3.text(USER_STATE_KEY)).toBeNull();
  });

  test('a policy saved through the API is stored as JSON in S3 and read back from there, and nowhere on disk', async () => {
    const { save, read, s3, dir } = await setup();
    const saved = await save(POLICY);
    expect(saved.status).toBe(200);
    expect(JSON.parse(s3.text(USER_STATE_KEY)!)).toEqual({ schemaVersion: 1, gc: POLICY });
    expect(await read()).toMatchObject({ saved: true, policy: POLICY });
    expect(await readdir(dir)).toEqual([]);
    // Defaults are filled for a partial policy, so what is stored is complete.
    expect((await (await save({ enabled: false, maxAgeDays: 7 })).json()).policy).toEqual({ enabled: false, maxAgeDays: 7, keepLatest: 20, intervalHours: 24 });
  });

  test('it is validated, needs the current revision and an admin, and a refused save changes nothing', async () => {
    const { call, read, s3 } = await setup();
    const { revision } = await read();
    const ifMatch = { 'if-match': `"${revision}"` };
    expect((await call('PUT', '/api/settings/gc', { ...POLICY, maxAgeDays: 0 }, ifMatch)).status).toBe(422);
    expect((await call('PUT', '/api/settings/gc', { ...POLICY, extra: 1 }, ifMatch)).status).toBe(422);
    expect((await call('PUT', '/api/settings/gc', { enabled: true }, ifMatch)).status).toBe(422);
    expect((await call('PUT', '/api/settings/gc', POLICY)).status).toBe(428);
    expect((await call('PUT', '/api/settings/gc', POLICY, { ...ifMatch, authorization: 'Bearer publish-token-123' })).status).toBe(403);
    expect((await call('GET', '/api/settings/gc', undefined, { authorization: 'Bearer publish-token-123' })).status).toBe(403);
    expect((await call('PUT', '/api/settings/gc', POLICY, { ...ifMatch, origin: 'http://evil' })).status).toBe(403);
    expect(s3.text(USER_STATE_KEY)).toBeNull();
    expect((await call('PUT', '/api/settings/gc', POLICY, ifMatch)).status).toBe(200);
    expect((await call('PUT', '/api/settings/gc', { ...POLICY, maxAgeDays: 5 }, ifMatch)).status).toBe(409);
  });

  test('saving the policy leaves the saved settings alone, and saving the settings leaves the policy alone', async () => {
    const { call, read, s3 } = await setup();
    const settings = async (body: unknown) => call('PUT', '/api/settings', body, { 'if-match': `"${(await read()).revision}"` });
    expect((await settings({ refreshSeconds: 12 })).status).toBe(200);
    expect((await call('PUT', '/api/settings/gc', POLICY, { 'if-match': `"${(await read()).revision}"` })).status).toBe(200);
    expect((await settings({ refreshSeconds: 13 })).status).toBe(200);
    expect(JSON.parse(s3.text(USER_STATE_KEY)!)).toEqual({ schemaVersion: 1, gc: POLICY, settings: { refreshSeconds: 13 } });
  });

  test('a policy the server cannot read is an error, never an empty policy, and the object is left alone', async () => {
    const { call, s3 } = await setup();
    await writeUtf8(storeOn(s3), USER_STATE_KEY, '{"schemaVersion":1,"gc":{"enabled":"yes"}}', 'application/json');
    const response = await call('GET', '/api/settings/gc');
    expect(response.status).toBe(503);
    expect((await response.json()).detail).toContain('Atlas will not overwrite it');
    expect((await call('POST', '/api/settings/gc/run')).status).toBeGreaterThanOrEqual(500);
    expect(s3.text(USER_STATE_KEY)).toBe('{"schemaVersion":1,"gc":{"enabled":"yes"}}');
  });
});

describe('applying the policy', () => {
  test('a disabled policy deletes nothing, but can be previewed', async () => {
    const { save, call, layerKeys } = await setup();
    await save({ ...POLICY, enabled: false });
    expect((await call('POST', '/api/settings/gc/run')).status).toBe(409);
    const preview = await (await call('POST', '/api/settings/gc/run?dryRun=1')).json();
    expect(preview.runs[0]).toMatchObject({ project: 'default', dryRun: true, candidates: 3, deletedLayers: 0 });
    expect((await layerKeys()).length).toBe(4);
  });

  test('a preview deletes nothing; a run deletes the old superseded layers and the files only they used, from S3', async () => {
    const { save, call, layerKeys, s3, read } = await setup();
    await save(POLICY);
    const preview = await (await call('POST', '/api/settings/gc/run?dryRun=1')).json();
    expect(preview.runs[0]).toMatchObject({ candidates: 3, deletedLayers: 0, keptLayers: 1 });
    expect((await layerKeys()).length).toBe(4);
    expect([...s3.objects.keys()].filter(key => key.startsWith('layers/blobs/')).length).toBe(4);

    const run = await (await call('POST', '/api/settings/gc/run')).json();
    expect(run.runs[0]).toMatchObject({ project: 'default', dryRun: false, candidates: 3, deletedLayers: 3, deletedBlobs: 3, keptLayers: 1 });
    expect((await layerKeys()).length).toBe(1);
    expect([...s3.objects.keys()].filter(key => key.startsWith('layers/blobs/')).length).toBe(1);
    expect((await read()).lastRuns[0]).toMatchObject({ project: 'default', deletedLayers: 3 });
    // The report still shows the newest result.
    const effective = await (await call('GET', '/api/reports/evidence/effective')).json();
    expect(effective.layers.length).toBe(1);
  });

  test('the policy is read from S3 each time, so a change made in S3 is the one applied', async () => {
    const { save, call, layerKeys, s3 } = await setup();
    await save({ ...POLICY, keepLatest: 100 });
    expect((await (await call('POST', '/api/settings/gc/run')).json()).runs[0]).toMatchObject({ candidates: 0, deletedLayers: 0 });
    const state = JSON.parse(s3.text(USER_STATE_KEY)!);
    await writeUtf8(storeOn(s3), USER_STATE_KEY, JSON.stringify({ ...state, gc: { ...state.gc, keepLatest: 0 } }), 'application/json');
    expect((await (await call('POST', '/api/settings/gc/run')).json()).runs[0]).toMatchObject({ deletedLayers: 3 });
    expect((await layerKeys()).length).toBe(1);
  });

  test('every project is collected, each over its own part of the bucket', async () => {
    const { save, call, s3, app } = await setup();
    await layersOf(storeOn(s3, 'projects/alpha'), [5, 6, 7]);
    await writeUtf8(storeOn(s3), 'server/projects/alpha.json', '{"slug":"alpha"}', 'application/json');
    await save(POLICY);
    const run = await (await call('POST', '/api/settings/gc/run')).json();
    expect(run.runs.map((item: { project: string }) => item.project)).toEqual(['default', 'alpha']);
    expect(run.runs.map((item: { deletedLayers: number }) => item.deletedLayers)).toEqual([3, 2]);
    expect((await storeOn(s3, 'projects/alpha').listKeys('layers/index/')).length).toBe(1);
    expect(app.routes.some(route => route.path === '/api/settings/gc/run')).toBe(true);
  });

  test('the server applies the saved policy on its own schedule', async () => {
    const { save, layerKeys } = await setup({ gcCheckMs: 20 });
    expect((await layerKeys()).length).toBe(4);
    await save(POLICY);
    for (let i = 0; i < 200 && (await layerKeys()).length > 1; i++) await new Promise(resolve => setTimeout(resolve, 25));
    expect((await layerKeys()).length).toBe(1);
  });

  test('without a policy the schedule deletes nothing', async () => {
    const { layerKeys } = await setup({ gcCheckMs: 20 });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await layerKeys()).length).toBe(4);
  });

  test('running needs an admin and a same-origin request', async () => {
    const { save, call, layerKeys } = await setup();
    await save(POLICY);
    expect((await call('POST', '/api/settings/gc/run', undefined, { authorization: 'Bearer publish-token-123' })).status).toBe(403);
    expect((await call('POST', '/api/settings/gc/run', undefined, { origin: 'http://evil' })).status).toBe(403);
    expect((await call('POST', '/api/settings/gc/run', undefined, { authorization: '' })).status).toBe(401);
    expect((await layerKeys()).length).toBe(4);
  });
});

type Pass = { id: string; status: string; dryRun: boolean; progress: Record<string, unknown>; runs: { project: string; deletedLayers: number; deletedBlobs: number; candidateBlobs?: number; candidateBytes?: number; deletedBytes?: number }[] };

describe('garbage collection passes', () => {
  test('a long pass answers 202 with where to poll; asking again while it runs is the same pass; it runs to the end', async () => {
    const { save, call, layerKeys, read } = await setup({ gcWaitMs: 0, slowMs: 15 });
    await save(POLICY);
    const first = await call('POST', '/api/settings/gc/run');
    expect(first.status).toBe(202);
    const pass = await first.json() as Pass;
    expect(first.headers.get('location')).toBe(`/api/settings/gc/runs/${pass.id}`);
    expect(pass).toMatchObject({ status: 'running', dryRun: false });
    const again = await call('POST', '/api/settings/gc/run');
    expect(again.status).toBe(202);
    expect((await again.json() as Pass).id).toBe(pass.id);
    expect((await read() as unknown as { currentPass: Pass | null }).currentPass?.id).toBe(pass.id);

    let polled: Pass = pass;
    for (let i = 0; i < 400 && polled.status === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      polled = await (await call('GET', first.headers.get('location')!)).json() as Pass;
    }
    expect(polled).toMatchObject({ id: pass.id, status: 'done', progress: { projectsDone: 1, deletedLayers: 3, deletedBlobs: 3 } });
    expect(polled.runs[0]).toMatchObject({ project: 'default', deletedLayers: 3, deletedBlobs: 3 });
    expect(polled.runs[0]!.deletedBytes).toBeGreaterThan(0);
    expect((await layerKeys()).length).toBe(1);
    const settings = await read() as unknown as { currentPass: Pass | null; lastRuns: Pass['runs'] };
    expect(settings.currentPass).toBeNull();
    expect(settings.lastRuns[0]).toMatchObject({ deletedLayers: 3 });
    // A new pass may start once that one is done.
    const next = await (await call('POST', '/api/settings/gc/run?dryRun=1&wait=1')).json() as Pass;
    expect(next.id).not.toBe(pass.id);
  });

  test('?wait=1 answers when the pass is done, as before passes existed', async () => {
    const { save, call } = await setup({ gcWaitMs: 0, slowMs: 5 });
    await save(POLICY);
    const response = await call('POST', '/api/settings/gc/run?wait=1');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'done', runs: [{ project: 'default', deletedLayers: 3 }], policy: POLICY });
  });

  test('a dry run reports the layers, blobs and bytes a real pass deletes, and deletes nothing', async () => {
    const { save, call, layerKeys, s3 } = await setup();
    await save(POLICY);
    const preview = (await (await call('POST', '/api/settings/gc/run?dryRun=1')).json() as Pass).runs[0]!;
    expect(preview).toMatchObject({ candidates: 3, deletedLayers: 0, deletedBlobs: 0, deletedBytes: 0, candidateBlobs: 3 });
    expect((await layerKeys()).length).toBe(4);
    const sizes = new Map([...s3.objects].map(([key, value]) => [key, value.bytes.length]));
    const run = (await (await call('POST', '/api/settings/gc/run')).json() as Pass).runs[0]!;
    const freed = [...sizes].filter(([key]) => !s3.objects.has(key) && /^layers\/(manifests|blobs)\//.test(key)).reduce((sum, [, size]) => sum + size, 0);
    expect(run.deletedBytes).toBe(freed);
    expect(preview.candidateBytes).toBe(freed);
    expect(preview.candidateBlobs).toBe(run.deletedBlobs);
  });

  test('bounded steps on instances that share only the store finish the pass, deleting what one unbounded pass deletes', async () => {
    const s3 = fakeS3();
    await layersOf(storeOn(s3), [1, 2, 3, 4, 5, 6]);
    // Two instances, each allowed no time at all per request: every request moves the pass on by one batch.
    const a = await setup({ s3, gcBudgetMs: 0 });
    const b = await setup({ s3, gcBudgetMs: 0 });
    await a.save(POLICY);
    let response = await a.call('POST', '/api/settings/gc/run');
    const id = (await response.json() as Pass).id;
    let requests = 1;
    while (response.status === 202 && requests < 50) {
      // Alternate instances, and alternate polling the pass with asking to run it again.
      const on = requests % 2 ? b : a;
      response = requests % 3 ? await on.call('GET', `/api/settings/gc/runs/${id}`) : await on.call('POST', '/api/settings/gc/run');
      requests += 1;
    }
    const pass = await response.json() as Pass;
    expect(response.status).toBe(200);
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(pass).toMatchObject({ id, status: 'done' });
    expect(pass.runs[0]).toMatchObject({ deletedLayers: 5, deletedBlobs: 5 });
    expect((await a.layerKeys()).length).toBe(1);
    expect([...s3.objects.keys()].filter(key => key.startsWith('layers/blobs/')).length).toBe(1);
    // What the pass kept while it ran is gone, its record stays.
    expect([...s3.objects.keys()].filter(key => key.startsWith(`server/gc/runs/${id}/`))).toEqual([]);
    const effective = await (await a.call('GET', '/api/reports/evidence/effective')).json();
    expect(effective.layers.length).toBe(1);
  });

  test('a scheduled pass on a bounded host carries on a pass that is under way', async () => {
    const { save, app, layerKeys } = await setup({ gcBudgetMs: 0, days: [1, 2, 3, 4, 5] });
    await save(POLICY);
    let result = await app.maintain!();
    for (let i = 0; i < 50 && result.pass?.status === 'running'; i++) result = await app.maintain!();
    expect(result.pass).toMatchObject({ status: 'done' });
    expect(result.gc?.[0]).toMatchObject({ deletedLayers: 4 });
    expect((await layerKeys()).length).toBe(1);
  });
});
