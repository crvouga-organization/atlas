import { describe, expect, test } from 'bun:test';

import { verifyObjectStore } from '../src/object-store-conformance';
import { vercelBlobStore } from '../src/vercel-blob-store';

/**
 * Against a real, private Vercel Blob store. Off unless a token is given:
 *   ATLAS_TEST_BLOB_TOKEN=vercel_blob_rw_… bun test vercel-blob-store.integration
 * Everything is written under a fresh atlas-it-… folder and removed again.
 */
const token = process.env.ATLAS_TEST_BLOB_TOKEN;
if (!token) console.info('vercel-blob-store.integration: skipped, set ATLAS_TEST_BLOB_TOKEN to a read-write token of a private Blob store to run it');
const suite = token ? describe : describe.skip;

suite('vercelBlobStore against Vercel Blob', () => {
  const unique = () => `atlas-it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}/`;
  const make = (prefix: string) => vercelBlobStore({ token: token!, prefix, env: {} });

  test('meets the ObjectStore contract', async () => {
    expect(await verifyObjectStore(make(unique()))).toEqual({ ok: true, failures: [] });
  }, 60_000);

  test('keys Atlas writes round-trip with their content type, and list in order', async () => {
    const store = make(unique());
    const keys = ['layers/manifests/9007199254740991-0a1b2c.json', 'layers/blobs/ab/cdef0123456789.webm', 'server/state.json'];
    try {
      for (const key of keys) await store.put(key, new TextEncoder().encode(key), key.endsWith('.webm') ? 'video/webm' : 'application/json');
      expect(await store.listKeys()).toEqual([...keys].sort());
      for (const key of keys) {
        const stored = (await store.get(key))!;
        expect(stored.contentType.startsWith(key.endsWith('.webm') ? 'video/webm' : 'application/json')).toBe(true);
        expect(await new Response(stored.body).text()).toBe(key);
      }
      // An overwrite is read back at once.
      await store.put('server/state.json', new TextEncoder().encode('2'), 'application/json');
      expect(await new Response((await store.get('server/state.json'))!.body).text()).toBe('2');
      // A private object cannot be read without the token, and no URL is handed out.
      expect(await store.getUri('server/state.json')).toBeNull();
    } finally {
      await store.deleteMany(keys);
    }
  }, 60_000);
});
