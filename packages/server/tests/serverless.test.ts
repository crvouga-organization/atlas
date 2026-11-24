/**
 * The serverless handler on a (fake) Vercel Blob store: instances that share nothing but the store, no timers between
 * requests, large files straight to storage, the scheduled pass, and a configuration problem answered as a page.
 */
import { describe, expect, test } from 'bun:test';

import { combineBackends } from '../../reports/src/compose';
import { httpStore } from '../../reports/src/http-store';
import { publishChecks } from '../../reports/src/publish-checks';
import { vercelBlobStore } from '../../reports/src/vercel-blob-store';
import { BLOB_API, BLOB_TOKEN, fakeVercelBlob } from '../../reports/tests/fake-vercel-blob';
import { createAtlasHandler } from '../src/serverless';

const ORIGIN = 'https://atlas.example.com';
const ADMIN = 'admin-token-123456';
const PUBLISH = 'publish-token-12345';
const READ = 'read-token-1234567';

function deployment(extra: Record<string, string> = {}) {
  const blob = fakeVercelBlob();
  const env = { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN, VERCEL_BLOB_API_URL: BLOB_API, ATLAS_TOKEN: ADMIN, ATLAS_PUBLISH_TOKEN: PUBLISH, ATLAS_READ_TOKEN: READ, ATLAS_LOG: '0', ...extra };
  const instance = () => createAtlasHandler({ env, cwd: '/nonexistent', fetch: blob.fetch });
  /** What reached the function, by method and body size: to prove large bodies never did. */
  const seen: { method: string; path: string; bytes: number }[] = [];
  /** A client's `fetch`: the Blob service for storage, the function for everything else. */
  const route = (handler: ReturnType<typeof instance>) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host.endsWith('blob.vercel-storage.com') || String(input).startsWith(BLOB_API)) return blob.fetch(input, init);
    const request = new Request(url, init);
    const bytes = init?.body ? (await request.clone().arrayBuffer()).byteLength : 0;
    seen.push({ method: request.method, path: url.pathname, bytes });
    return handler(request);
  }) as unknown as typeof globalThis.fetch;
  return { blob, env, instance, route, seen };
}

const read = (handler: (request: Request) => Promise<Response>, path: string, token = READ) => handler(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}` } }));
const check = (id: string, status: 'passed' | 'failed' = 'passed') => ({ id, title: id, status });

describe('a deployment that is not configured yet', () => {
  test('answers every request with a page naming what to set, and never a secret', async () => {
    const handler = createAtlasHandler({ env: { BLOB_READ_WRITE_TOKEN: 'not-a-token' }, cwd: '/nonexistent' });
    const response = await handler(new Request(`${ORIGIN}/`));
    expect(response.status).toBe(503);
    const page = await response.text();
    expect(page).toContain('VERCEL BLOB STORAGE IS NOT USABLE');
    expect(page).toContain('BLOB_READ_WRITE_TOKEN');
    expect(page).not.toContain('not-a-token');
    const nothing = await createAtlasHandler({ env: {}, cwd: '/nonexistent' })(new Request(`${ORIGIN}/api/server`));
    expect(await nothing.text()).toContain('ATLAS_S3_BUCKET');
  });

  test('a public Blob store is named on the page before anything is uploaded', async () => {
    const blob = fakeVercelBlob({ access: 'public' });
    const handler = createAtlasHandler({ env: { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN, VERCEL_BLOB_API_URL: BLOB_API, ATLAS_TOKEN: ADMIN }, cwd: '/nonexistent', fetch: blob.fetch });
    const response = await handler(new Request(`${ORIGIN}/`));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Atlas needs a private store');
  });

  test.each([undefined, '1'])('requires a publishing identity even with ATLAS_INSECURE=%s', async insecure => {
    const { blob } = deployment();
    const handler = createAtlasHandler({ env: { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN, VERCEL_BLOB_API_URL: BLOB_API, ATLAS_INSECURE: insecure }, cwd: '/nonexistent', fetch: blob.fetch });
    const response = await handler(new Request(`${ORIGIN}/api/server`));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Set ATLAS_TOKEN');
  });
});

describe('instances that share only the store', () => {
  test('a layer uploaded through one instance is in the next report another instance serves', async () => {
    const { instance, route } = deployment({ ATLAS_REFRESH_SECONDS: '1' });
    const a = instance(), b = instance();
    expect((await read(b, '/api/server')).status).toBe(200);
    await publishChecks(httpStore({ url: ORIGIN, token: PUBLISH, fetch: route(a), retries: 0 }), { producer: 'ci', environment: 'web', recordedAtMs: 5, checks: [check('a'), check('b', 'failed')] });
    // No timer runs on b: the next request after the refresh interval looks at the store itself.
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const status = await (await read(b, '/api/status')).json() as { summary?: { checks?: Record<string, number> } };
    expect(JSON.stringify(status)).toContain('"failed":1');
  });

  test('a rewrite that sends every path to one function passes the path along', async () => {
    const { instance } = deployment();
    const handler = instance();
    const response = await read(handler, '/api/atlas?__atlas_path=/api/server');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'atlas', role: 'read', uploads: { directOverBytes: 4 * 1024 * 1024 }, streamMaxSeconds: 240 });
  });
});

describe('large files go straight to storage', () => {
  test('a file over the limit is sent to Blob with a one-time token, and no request to the function carries it', async () => {
    const { blob, instance, route, seen } = deployment({ ATLAS_DIRECT_UPLOAD_OVER_BYTES: '20000' });
    const handler = instance();
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i += 65_536) crypto.getRandomValues(big.subarray(i, Math.min(big.length, i + 65_536)));
    await publishChecks(httpStore({ url: ORIGIN, token: PUBLISH, fetch: route(handler), retries: 0 }), {
      producer: 'e2e', environment: 'web', recordedAtMs: 9, checks: [check('recorded')], attachments: [{ name: 'clip.bin', data: big }]
    });
    expect(blob.clientUploads()).toBeGreaterThan(0);
    expect(Math.max(...seen.map(request => request.bytes))).toBeLessThan(20_000);
    const report = await combineBackends([{ id: 'r', store: vercelBlobStore({ token: BLOB_TOKEN, apiUrl: BLOB_API, fetch: blob.fetch, env: {} }) }]);
    expect(report.summary.checks).toMatchObject({ passed: 1 });
  });

  test('bytes that do not match their name are refused when completed, and deleted', async () => {
    const { blob, instance } = deployment({ ATLAS_DIRECT_UPLOAD_OVER_BYTES: '0' });
    const handler = instance();
    const key = `layers/blobs/${'a'.repeat(64)}.gz`;
    const post = (step: string, body?: unknown) => handler(new Request(`${ORIGIN}/api/store/${key}?upload=${step}`, { method: 'POST', headers: { authorization: `Bearer ${PUBLISH}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const target = await (await post('start', { size: 5, contentType: 'application/gzip' })).json() as { url: string; headers: Record<string, string> };
    expect((await blob.fetch(target.url, { method: 'PUT', headers: target.headers, body: 'wrong' })).ok).toBe(true);
    const done = await post('complete');
    expect(done.status).toBe(422);
    expect(blob.objects.has(key)).toBe(false);
  });

  test('only a publisher may ask, only for files, and a token cannot be used for another key or size', async () => {
    const { blob, instance } = deployment({ ATLAS_DIRECT_UPLOAD_OVER_BYTES: '0' });
    const handler = instance();
    const start = (key: string, token?: string) => handler(new Request(`${ORIGIN}/api/store/${key}?upload=start`, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ size: 3, contentType: 'application/gzip' }) }));
    const blobKey = `layers/blobs/${'b'.repeat(64)}.gz`;
    expect((await start(blobKey)).status).toBe(401);
    expect((await start(blobKey, READ)).status).toBe(403);
    expect((await start(`layers/manifests/${'c'.repeat(64)}.json`, PUBLISH)).status).toBe(422);
    expect((await start('layers/%2e%2e/escape', PUBLISH)).status).toBe(422);
    const target = await (await start(blobKey, PUBLISH)).json() as { url: string; headers: Record<string, string> };
    const elsewhere = target.url.replace(encodeURIComponent(blobKey), encodeURIComponent(`layers/blobs/${'d'.repeat(64)}.gz`));
    expect((await blob.fetch(elsewhere, { method: 'PUT', headers: target.headers, body: 'abc' })).ok).toBe(false);
    expect((await blob.fetch(target.url, { method: 'PUT', headers: target.headers, body: 'too long' })).ok).toBe(false);
  });
});

describe('the scheduled pass', () => {
  test('needs CRON_SECRET or the admin token, and deletes nothing without a saved policy', async () => {
    const { instance } = deployment({ CRON_SECRET: 'cron-secret-value-1' });
    const handler = instance();
    expect((await handler(new Request(`${ORIGIN}/api/cron`))).status).toBe(401);
    expect((await read(handler, '/api/cron', PUBLISH)).status).toBe(401);
    for (const route of ['/api/cron/gc', '/api/cron/maintain']) {
      expect((await read(handler, route, READ)).status).toBe(401);
      expect((await read(handler, route, ADMIN)).status).toBe(200);
    }
    const ran = await read(handler, '/api/cron', 'cron-secret-value-1');
    expect(ran.status).toBe(200);
    expect(await ran.json()).toMatchObject({ ok: true, gc: null, note: expect.stringContaining('No garbage collection policy') });
    expect((await read(handler, '/api/cron', ADMIN)).status).toBe(200);
  });
});
