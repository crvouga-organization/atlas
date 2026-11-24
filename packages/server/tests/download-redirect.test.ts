/**
 * Recordings a browser plays are sent from the store with a short-lived signed URL instead of through the server, when the
 * store can sign one; everything else, and every request that is not a browser playing or downloading, stays in.
 */
import { describe, expect, test } from 'bun:test';

import { redirectableType, REDIRECT_SECONDS, storeRedirect } from '../../reports/src/attachment-response';
import { s3Store } from '../../reports/src/s3-store';
import { presignedGet, vercelBlobStore } from '../../reports/src/vercel-blob-store';
import { BLOB_API, BLOB_CONTENT, BLOB_TOKEN, fakeVercelBlob } from '../../reports/tests/fake-vercel-blob';
import { memoryStore } from '../../reports/tests/memory-store';
import { createAtlasServer } from '../src/app';
import { createAtlasHandler } from '../src/serverless';
import { fakeS3 } from './fake-s3';

const ORIGIN = 'https://atlas.example.com';
const READ = 'read-token-1234567';
const CLIP = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));

async function deployment(extra: Record<string, string> = {}) {
  const blob = fakeVercelBlob();
  const store = vercelBlobStore({ token: BLOB_TOKEN, apiUrl: BLOB_API, fetch: blob.fetch, env: {} });
  await store.put('layers/runs/run-1/clip.webm', CLIP, 'video/webm');
  await store.put('layers/runs/run-1/trace.zip', CLIP, 'application/zip');
  await store.put('layers/runs/run-1/page.html', new TextEncoder().encode('<script>alert(1)</script>'), 'text/html');
  await store.put('layers/runs/run-1/icon.svg', new TextEncoder().encode('<svg onload="alert(1)"/>'), 'image/svg+xml');
  // A file named like a video whose uploader said it was a page: the stored type decides, not the name.
  await store.put('layers/runs/run-1/lies.webm', new TextEncoder().encode('<script>alert(1)</script>'), 'text/html');
  const handler = createAtlasHandler({ env: { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN, VERCEL_BLOB_API_URL: BLOB_API, ATLAS_TOKEN: 'admin-token-123456', ATLAS_READ_TOKEN: READ, ATLAS_LOG: '0', ...extra }, cwd: '/nonexistent', fetch: blob.fetch });
  const get = (file: string, headers: Record<string, string> = {}) => handler(new Request(`${ORIGIN}/api/data/runs/run-1/${file}`, { headers: { authorization: `Bearer ${READ}`, 'sec-fetch-dest': 'video', ...headers } }));
  return { blob, handler, get };
}

describe('a recording a browser plays comes from the store', () => {
  test('a video asked for with a Range is a 302 to a five-minute URL, and the store serves the range without any token', async () => {
    const { blob, get } = await deployment();
    const response = await get('clip.webm', { range: 'bytes=0-9' });
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe(BLOB_CONTENT);
    const until = Number(location.searchParams.get('vercel-blob-valid-until'));
    expect(until).toBeGreaterThan(Date.now());
    expect(until).toBeLessThanOrEqual(Date.now() + REDIRECT_SECONDS * 1000 + 1000);
    // The browser follows it with its Range, and no Atlas token or Blob token goes along.
    const played = await blob.fetch(location.toString(), { headers: { range: 'bytes=0-9' } });
    expect(played.status).toBe(206);
    expect(played.headers.get('content-range')).toBe('bytes 0-9/64');
    expect([...new Uint8Array(await played.arrayBuffer())]).toEqual([...CLIP.slice(0, 10)]);
    expect(blob.presignedReads()).toBe(1);
  });

  test('a trace zip opened as a download is sent to the store too, and one delegation serves many URLs', async () => {
    const { blob, get } = await deployment();
    expect((await get('trace.zip', { 'sec-fetch-dest': 'document' })).status).toBe(302);
    expect((await get('clip.webm')).status).toBe(302);
    expect(blob.delegationsIssued()).toBe(1);
  });

  test('without the read role the answer is 401 and no URL is made', async () => {
    const { blob, handler } = await deployment();
    const response = await handler(new Request(`${ORIGIN}/api/data/runs/run-1/clip.webm`, { headers: { 'sec-fetch-dest': 'video' } }));
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(blob.delegationsIssued()).toBe(0);
  });

  test('pages, SVG and anything stored as active content never leave through a redirect', async () => {
    const { get } = await deployment();
    for (const file of ['page.html', 'icon.svg', 'lies.webm']) {
      const response = await get(file, { 'sec-fetch-dest': 'document' });
      expect(response.status, file).toBe(200);
      expect(response.headers.get('content-security-policy'), file).toContain('sandbox');
    }
  });

  test('a script fetching the file, or a client that is not a browser, gets the bytes from the server', async () => {
    const { get } = await deployment();
    for (const dest of ['empty', '']) {
      const response = await get('clip.webm', { 'sec-fetch-dest': dest });
      expect(response.status).toBe(200);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...CLIP]);
    }
  });

  test('ATLAS_REDIRECT_DOWNLOADS=0 keeps every byte in the server', async () => {
    const { get } = await deployment({ ATLAS_REDIRECT_DOWNLOADS: '0' });
    expect((await get('clip.webm')).status).toBe(200);
  });

  test('a store that cannot sign streams through the server as before', async () => {
    const store = memoryStore();
    await store.put('layers/runs/run-1/clip.webm', CLIP, 'video/webm');
    const server = createAtlasServer({ backends: [{ id: 'data', store }], write: 'data', redirectDownloads: true, refreshMs: 60_000 });
    await server.ready;
    const response = await server.fetch(new Request(`${ORIGIN}/api/data/runs/run-1/clip.webm`, { headers: { 'sec-fetch-dest': 'video' } }));
    expect(response.status).toBe(200);
    server.close();
  });
});

describe('signed URLs', () => {
  test('only recordings and archives may be redirected', () => {
    for (const type of ['video/webm', 'video/mp4; codecs="avc1"', 'audio/ogg', 'application/zip', 'VIDEO/WEBM']) expect(redirectableType(type), type).toBe(true);
    for (const type of ['text/html', 'image/svg+xml', 'image/png', 'application/pdf', 'application/xml', 'text/javascript', 'application/octet-stream', '']) expect(redirectableType(type), type).toBe(false);
  });

  test('a Blob URL works for its own object only, and not once it has expired', async () => {
    const blob = fakeVercelBlob();
    const store = vercelBlobStore({ token: BLOB_TOKEN, apiUrl: BLOB_API, fetch: blob.fetch, env: {} });
    await store.put('a.webm', CLIP, 'video/webm');
    await store.put('b.webm', CLIP, 'video/webm');
    const signed = (await store.signedUrl('a.webm', { expiresInSeconds: 60 }))!;
    expect(signed).toMatchObject({ contentType: 'video/webm', size: 64 });
    expect((await blob.fetch(signed.url)).status).toBe(200);
    expect((await blob.fetch(signed.url.replace('/a.webm', '/b.webm'))).status).toBe(403);
    const url = new URL(signed.url);
    const delegation = url.searchParams.get('vercel-blob-delegation')!;
    // Signed with the right key but already past its time.
    const stale = new URL(signed.url);
    stale.searchParams.set('vercel-blob-valid-until', String(Date.now() - 1000));
    expect((await blob.fetch(stale.toString())).status).toBe(403);
    // A forged signature, and a forged delegation, are refused.
    const forged = new URL(signed.url);
    forged.searchParams.set('vercel-blob-signature', 'A'.repeat(43));
    expect((await blob.fetch(forged.toString())).status).toBe(403);
    expect((await blob.fetch(await presignedGet(BLOB_CONTENT, 'a.webm', Date.now() + 60_000, Date.now() + 3_600_000, delegation, 'not-the-signing-key'))).status).toBe(403);
    expect(await store.signedUrl('missing.webm', { expiresInSeconds: 60 })).toBeNull();
  });

  test('S3 signs for as long as asked, with the type and size S3 will serve', async () => {
    const s3 = fakeS3();
    const store = s3Store({ bucket: 'atlas-test', endpoint: 'http://s3.test', region: 'us-east-1', credentials: { accessKeyId: 'testkey', secretAccessKey: 'testsecret' }, env: {}, fetch: s3.fetch });
    await store.put('layers/runs/r/clip.webm', CLIP, 'video/webm');
    const signed = (await store.signedUrl('layers/runs/r/clip.webm', { expiresInSeconds: REDIRECT_SECONDS }))!;
    expect(signed).toMatchObject({ contentType: 'video/webm', size: 64 });
    expect(new URL(signed.url).searchParams.get('X-Amz-Expires')).toBe(String(REDIRECT_SECONDS));
    expect(await store.signedUrl('layers/runs/r/missing.webm', { expiresInSeconds: 60 })).toBeNull();
    // Through a prefix, as a project's store is.
    expect(await storeRedirect(new Request(`${ORIGIN}/x`, { headers: { 'sec-fetch-dest': 'video' } }), store.withPrefix('layers/runs/r'), 'clip.webm')).not.toBeNull();
  });
});
