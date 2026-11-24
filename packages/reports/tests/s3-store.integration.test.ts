import { describe, expect, test } from 'bun:test';

import { createAtlasServer } from '../../server/src/app';
import { httpStore } from '../src/http-store';
import { combineBackends } from '../src/compose';
import { copyStore } from '../src/copy-store';
import { verifyObjectStore } from '../src/object-store-conformance';
import { publishChecks } from '../src/publish-checks';
import { s3Store } from '../src/s3-store';

/**
 * Against a real S3-protocol server. Off unless one is named:
 *   ATLAS_TEST_S3_ENDPOINT=http://localhost:18333 ATLAS_TEST_S3_BUCKET=atlas-test \
 *   ATLAS_TEST_S3_KEY=… ATLAS_TEST_S3_SECRET=… bun test s3-store.integration
 * CI starts SeaweedFS for it.
 */
const endpoint = process.env.ATLAS_TEST_S3_ENDPOINT;
const suite = endpoint ? describe : describe.skip;

suite('s3Store against a real server', () => {
  const make = (prefix: string) => s3Store({
    bucket: process.env.ATLAS_TEST_S3_BUCKET ?? 'atlas-test',
    prefix,
    endpoint: endpoint!,
    region: 'us-east-1',
    credentials: { accessKeyId: process.env.ATLAS_TEST_S3_KEY ?? 'atlaskey', secretAccessKey: process.env.ATLAS_TEST_S3_SECRET ?? 'atlassecret' },
    env: {}
  });
  const unique = () => `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}/`;

  test('meets the ObjectStore contract', async () => {
    expect(await verifyObjectStore(make(unique()))).toEqual({ ok: true, failures: [] });
  });

  test('keys with spaces, plus signs, unicode and deep folders round-trip and list', async () => {
    const store = make(unique());
    const keys = ['a b/c+d.json', 'ünï/cødé.txt', 'deep/er/and/deeper/x.bin', 'trailing space /y', 'q?x=1&y=2'];
    for (const key of keys) await store.put(key, new TextEncoder().encode(key), 'text/plain');
    expect(await store.listKeys()).toEqual([...keys].sort());
    for (const key of keys) expect(await new Response((await store.get(key))!.body).text()).toBe(key);
  });

  test('lists more than one page of keys, in order, and only under the prefix', async () => {
    const root = make(unique());
    const store = root.withPrefix('many/');
    const names = Array.from({ length: 1_150 }, (_, i) => `k${String(i).padStart(5, '0')}`);
    let next = 0;
    await Promise.all(Array.from({ length: 32 }, async () => { for (let i = next++; i < names.length; i = next++) await store.put(names[i]!, new Uint8Array([1]), 'application/octet-stream'); }));
    await root.put('outside', new Uint8Array([1]), 'text/plain');
    const listed = await store.listKeys();
    expect(listed).toEqual(names);
    expect((await root.listKeys('many/k0000')).length).toBe(10);
  }, 120_000);

  test('a presigned address can be fetched without credentials', async () => {
    const store = make(unique());
    await store.put('shared.txt', new TextEncoder().encode('hello'), 'text/plain');
    const url = await store.getUri('shared.txt');
    expect(url).not.toBeNull();
    expect(await (await fetch(url!)).text()).toBe('hello');
    expect(await store.getUri('nope')).toBeNull();
  });

  test('a signed staging upload commits verified bytes and preserves the first immutable file', async () => {
    const store = make(unique());
    const bytes = new TextEncoder().encode('recorded evidence');
    const target = await store.stagedUploadTarget('server/uploads/sample', { size: bytes.length, contentType: 'video/webm' });
    expect((await fetch(target.url, { method: target.method, headers: target.headers, body: bytes })).ok).toBe(true);
    expect(await store.head('server/uploads/sample')).toBe(true);
    expect(await store.putIfAbsent('recording', bytes, 'video/webm')).toBe(true);
    expect(await store.putIfAbsent('recording', bytes, 'video/webm')).toBe(false);
    const original = await store.get('recording');
    await original!.body.cancel();
    expect(original?.etag).toBeTruthy();
    expect(await store.putConditional('recording', new Uint8Array([0]), 'video/webm', original!.etag!)).toBe(true);
    expect(await store.putConditional('recording', bytes, 'video/webm', original!.etag!)).toBe(false);
  });

  test('the HTTP publisher sends file bytes only to S3 and a second instance validates completion', async () => {
    const store = make(unique()).withPrefix('project');
    const options = { backends: [{ id: 'bucket', store }], write: 'bucket', directUploadOverBytes: 128 };
    const servers = [createAtlasServer(options), createAtlasServer(options)];
    try {
      await Promise.all(servers.map(server => server.ready));
      let direct = 0;
      const route = (async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname !== 'atlas.test') {
          expect(new Headers(init?.headers).has('authorization')).toBe(false);
          expect(new Headers(init?.headers).has('x-atlas-extra')).toBe(false);
          expect(await store.head('layers/runs/recording/clip.webm')).toBe(false);
          direct++;
          return fetch(input, init);
        }
        if (init?.body) expect((await new Response(init.body).arrayBuffer()).byteLength).toBeLessThan(512);
        return servers[url.searchParams.get('upload') === 'complete' ? 1 : 0]!.fetch(new Request(url, init));
      }) as typeof fetch;
      const client = httpStore({ url: 'http://atlas.test', fetch: route, headers: { 'x-atlas-extra': 'test' }, retries: 0 });
      const key = 'layers/runs/recording/clip.webm';
      const bytes = new Uint8Array(4096).fill(42);
      await client.put(key, bytes, 'video/webm');
      await client.put(key, bytes, 'video/webm');
      expect(direct).toBe(1);
      expect(new Uint8Array(await new Response((await store.get(key))!.body).arrayBuffer())).toEqual(bytes);
      expect(await store.listKeys('server/uploads/')).toEqual([]);
      await expect(client.put(key, new Uint8Array(4096), 'video/webm')).rejects.toThrow('immutable file');
    } finally { servers.forEach(server => server.close()); }
  });

  test('wrong keys and a missing bucket say what is wrong', async () => {
    const bad = s3Store({ bucket: process.env.ATLAS_TEST_S3_BUCKET ?? 'atlas-test', endpoint: endpoint!, region: 'us-east-1', credentials: { accessKeyId: 'nope', secretAccessKey: 'nope' }, env: {}, retries: 0 });
    expect((await bad.ping()).ok).toBe(false);
    const missing = s3Store({ bucket: 'no-such-bucket-here', endpoint: endpoint!, region: 'us-east-1', credentials: { accessKeyId: process.env.ATLAS_TEST_S3_KEY ?? 'atlaskey', secretAccessKey: process.env.ATLAS_TEST_S3_SECRET ?? 'atlassecret' }, env: {}, retries: 0 });
    const ping = await missing.ping();
    expect(ping.ok).toBe(false);
    expect(ping.error).toContain('bucket');
  });

  test('layers published to the bucket combine with layers from elsewhere, and copy up idempotently', async () => {
    const bucket = make(unique());
    await publishChecks(bucket, { producer: 'ci', environment: 'ios', recordedAtMs: 2, checks: [{ id: 'a', title: 'a', status: 'failed' }] });
    const local = (await import('./memory-store')).memoryStore();
    await publishChecks(local, { producer: 'ci', environment: 'ios', recordedAtMs: 3, checks: [{ id: 'a', title: 'a', status: 'passed' }] });
    const before = await combineBackends([{ id: 'shared', store: bucket }, { id: 'laptop', store: local }]);
    expect(before.summary.checks).toMatchObject({ passed: 1, failed: 0 });
    const first = await copyStore(local, bucket);
    expect(first.copied).toBeGreaterThan(0);
    expect(await copyStore(local, bucket)).toMatchObject({ copied: 0 });
    expect((await combineBackends([{ id: 'shared', store: bucket }])).summary.checks).toMatchObject({ passed: 1, failed: 0 });
  });
});
