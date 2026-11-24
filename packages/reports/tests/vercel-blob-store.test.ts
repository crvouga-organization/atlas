import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { combineBackends } from '../src/compose';
import { directoryStore } from '../src/directory-store';
import { verifyObjectStore } from '../src/object-store-conformance';
import { publishChecks } from '../src/publish-checks';
import { reportMain } from '../src/report-cli';
import { openStore, parseStoreLocation, storeId } from '../src/store-url';
import { blobStoreIdOf, vercelBlobStore } from '../src/vercel-blob-store';
import { BLOB_API, BLOB_TOKEN, fakeVercelBlob } from './fake-vercel-blob';

const text = (value: string) => new TextEncoder().encode(value);

describe('vercelBlobStore', () => {
  test('meets the ObjectStore contract', async () => {
    const blob = fakeVercelBlob();
    expect(await verifyObjectStore(vercelBlobStore({ ...blob.options, fetch: blob.fetch, prefix: 'atlas/' }))).toEqual({ ok: true, failures: [] });
  });

  test('keys Atlas writes round-trip byte for byte under their exact pathname, with their content type', async () => {
    const blob = fakeVercelBlob();
    const store = vercelBlobStore({ ...blob.options, fetch: blob.fetch, prefix: 'my-project' });
    const keys = ['layers/manifests/9007199254740991-0a1b2c.json', 'layers/blobs/ab/cdef0123456789.webm', 'server/state.json', 'layers/specs/index/x-y.z.json'];
    for (const key of keys) await store.put(key, text(key), key.endsWith('.webm') ? 'video/webm' : 'application/json');
    expect([...blob.objects.keys()].sort()).toEqual(keys.map(key => `my-project/${key}`).sort());
    expect(await store.listKeys()).toEqual([...keys].sort());
    for (const key of keys) {
      const stored = (await store.get(key))!;
      expect(stored.contentType).toBe(key.endsWith('.webm') ? 'video/webm' : 'application/json');
      expect(await new Response(stored.body).text()).toBe(key);
    }
    // Every write is private, exact and allowed to overwrite: a retry writes the same key again.
    const puts = blob.requests.filter(request => request.method === 'PUT');
    expect(puts.every(request => request.headers['x-vercel-blob-access'] === 'private' && request.headers['x-add-random-suffix'] === '0' && request.headers['x-allow-overwrite'] === '1')).toBe(true);
    // Reads bypass the CDN cache, so an overwrite is seen at once.
    expect(blob.requests.filter(request => request.url.includes('.blob.vercel-storage.com')).every(request => request.url.endsWith('?cache=0'))).toBe(true);
  });

  test('getUri signs only the requested private object for at most five minutes', async () => {
    const blob = fakeVercelBlob();
    const store = vercelBlobStore({ ...blob.options, fetch: blob.fetch });
    await store.put('a.txt', text('a'), 'text/plain');
    const url = new URL((await store.getUri('a.txt'))!);
    const until = Number(url.searchParams.get('vercel-blob-valid-until'));
    expect(until).toBeGreaterThan(Date.now());
    expect(until).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(await (await blob.fetch(url.href)).text()).toBe('a');
    url.search = '';
    expect((await blob.fetch(url.href)).ok).toBe(false);
    expect(await store.getUri('missing.txt')).toBeNull();
  });

  test('listPage continues from the cursor after a page it returned, and from any key by filtering', async () => {
    const blob = fakeVercelBlob();
    const store = vercelBlobStore({ ...blob.options, fetch: blob.fetch, prefix: 'p' });
    const names = Array.from({ length: 25 }, (_, i) => `layers/k${String(i).padStart(3, '0')}`);
    for (const name of names) await store.put(name, text(name), 'text/plain');
    await store.put('other/x', text('x'), 'text/plain');
    const seen: string[] = [];
    for (let after: string | undefined; ;) {
      const page = await store.listPage('layers/', { limit: 10, ...(after === undefined ? {} : { after }) });
      seen.push(...page.keys);
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual(names);
    // Each continued page was one request: three pages, three listings.
    expect(blob.requests.filter(request => request.method === 'GET' && request.url.includes('limit=10')).length).toBe(3);
    expect(await store.listPage('layers/', { after: 'layers/k020', limit: 3 })).toEqual({ keys: ['layers/k021', 'layers/k022', 'layers/k023'], next: 'layers/k023' });
    expect(await store.listPage('layers/', { after: 'layers/k022', limit: 5 })).toEqual({ keys: ['layers/k023', 'layers/k024'], next: null });
  });

  test('deleteMany removes in batches and ignores missing keys', async () => {
    const blob = fakeVercelBlob();
    const store = vercelBlobStore({ ...blob.options, fetch: blob.fetch });
    const keys = Array.from({ length: 205 }, (_, i) => `k${i}`);
    for (const key of keys) await store.put(key, text(key), 'text/plain');
    await store.deleteMany([...keys, 'missing']);
    expect(blob.objects.size).toBe(0);
    expect(blob.requests.filter(request => request.url.endsWith('/delete')).length).toBe(3);
  });

  test('retries what the service may answer differently next time', async () => {
    const blob = fakeVercelBlob();
    const store = vercelBlobStore({ ...blob.options, fetch: blob.fetch });
    blob.failNext(2);
    await store.put('a', text('a'), 'text/plain');
    expect(await store.head('a')).toBe(true);
  });

  test('a wrong token is refused with what to do, and the token is never in the message', async () => {
    const blob = fakeVercelBlob();
    const store = vercelBlobStore({ ...blob.options, token: 'vercel_blob_rw_teststore_wrongsecret', fetch: blob.fetch });
    const error = await store.put('a', text('a'), 'text/plain').then(() => null, (caught: Error) => caught);
    expect(error?.message).toContain('BLOB_READ_WRITE_TOKEN');
    expect(error?.message).not.toContain('wrongsecret');
    const ping = await store.ping();
    expect(ping.ok).toBe(false);
  });

  test('a token is required, and must be a read-write token', () => {
    expect(() => vercelBlobStore({ env: {} })).toThrow('BLOB_READ_WRITE_TOKEN');
    expect(() => vercelBlobStore({ token: 'not-a-token' })).toThrow('read-write token');
    expect(blobStoreIdOf(BLOB_TOKEN)).toBe('teststore');
    expect(vercelBlobStore({ env: { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN } }).label).toBe('vercel-blob:// (store teststore)');
  });
});

describe('vercel-blob:// store URLs', () => {
  test('name a folder of the store; the token comes from the environment only', () => {
    expect(parseStoreLocation('vercel-blob://my-project', '/w')).toEqual({ kind: 'vercel-blob', prefix: 'my-project' });
    expect(parseStoreLocation('vercel-blob://atlas/my-project/', '/w')).toEqual({ kind: 'vercel-blob', prefix: 'atlas/my-project' });
    expect(parseStoreLocation('vercel-blob://', '/w')).toEqual({ kind: 'vercel-blob', prefix: '' });
    expect(() => parseStoreLocation('vercel-blob://tok@my-project', '/w')).toThrow('BLOB_READ_WRITE_TOKEN');
    expect(() => parseStoreLocation('vercel-blob://p?token=x', '/w')).toThrow('BLOB_READ_WRITE_TOKEN');
    expect(() => parseStoreLocation('vercel-blob://a/../b', '/w')).toThrow('not a folder');
    expect(storeId({ kind: 'vercel-blob', prefix: 'my-project' }, new Set())).toBe('blob-my-project');
  });

  test('open a Blob store with the token from the environment', async () => {
    const blob = fakeVercelBlob();
    const opened = openStore('vercel-blob://my-project', { base: '/w', env: { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN, VERCEL_BLOB_API_URL: BLOB_API }, fetch: blob.fetch });
    expect(opened.blob).toBeDefined();
    await opened.store.put('a.json', text('{}'), 'application/json');
    expect(blob.objects.has('my-project/a.json')).toBe(true);
    expect(() => openStore('vercel-blob://my-project', { base: '/w', env: {} })).toThrow('BLOB_READ_WRITE_TOKEN');
  });
});

describe('moving an existing deployment to Blob', () => {
  const realFetch = globalThis.fetch;
  let dir = '';
  afterEach(() => { globalThis.fetch = realFetch; if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('atlas report merge --into vercel-blob://… shows the same report from Blob as from the old store', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'atlas-blob-merge-'));
    const old = directoryStore(dir);
    await publishChecks(old, { producer: 'ci', environment: 'ios', recordedAtMs: 2, checks: [{ id: 'a', title: 'a', status: 'failed' }, { id: 'b', title: 'b', status: 'passed' }] });
    await publishChecks(old, { producer: 'ci', environment: 'ios', recordedAtMs: 3, checks: [{ id: 'a', title: 'a', status: 'passed' }] });
    const blob = fakeVercelBlob();
    globalThis.fetch = blob.fetch;
    const out: string[] = [];
    const env = { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN, VERCEL_BLOB_API_URL: BLOB_API };
    expect(await reportMain(['merge', '--store', dir, '--into', 'vercel-blob://my-project'], { out: line => { out.push(line); }, env, cwd: dir })).toBe(0);
    expect(out.join('')).toContain('objects copied');
    const fromBlob = await combineBackends([{ id: 'r', store: vercelBlobStore({ ...blob.options, fetch: blob.fetch, prefix: 'my-project' }) }]);
    const fromDisk = await combineBackends([{ id: 'r', store: old }]);
    expect(fromBlob.summary).toEqual(fromDisk.summary);
    expect(fromBlob.summary.checks).toMatchObject({ passed: 2, failed: 0 });
  });
});
