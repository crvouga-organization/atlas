/**
 * @module Store protocol routes
 *
 * The `ObjectStore` interface over HTTP at `/api/store`: list keys under `layers/`, read and probe an object, upload one
 * (checked by `validateUpload`, immutable once stored) and remove a scratch object. This is what `httpStore` talks to. An
 * upload is told to the report only after it is stored, and a layer's manifest, parsed while it was checked, is handed on so
 * it is not read again. Everything read is served as untrusted bytes (never sniffed, never run). Where the storage can take
 * a file from a publisher directly (`direct`), `POST /api/store/<key>?upload=start` says where to send a large file and
 * `?upload=complete` checks what arrived, as an upload is checked, before it counts.
 *
 * @see docs/server.md#the-store-protocol
 */

import { Hono, type Context } from 'hono';

import { isPaged, type ObjectStore } from '../../reports/src/object-store';
import { readBytes } from '../../reports/src/object-io';
import { UNTRUSTED_HEADERS } from '../../reports/src/attachment-response';
import type { ReportLayer } from '../../reports/src/layer-types';
import { criticScopeViolation } from '../../critics/src/scope';
import type { Auth } from './auth';
import { classify, isCatalog, Refusal, sameBytes, validateUpload, validKey } from './validate';

/** What the store routes need: the `store` they read and write, the `auth` that decides who may, the largest object accepted, and `onStored`, told after each upload with its key, its kind and (for a layer catalog entry) the layer already parsed. */
export type StoreApiOptions = {
  readonly store: ObjectStore;
  readonly auth: Auth;
  readonly maxObjectBytes: number;
  /** Told after something was uploaded: its key, and what kind of thing it is. */
  readonly onStored: (key: string, kind: string, layer?: ReportLayer) => void | Promise<void>;
  /**
   * Where a publisher may send a large file's bytes itself, straight to the storage (a host whose functions refuse large
   * request bodies). Without it, `POST /api/store/<key>?upload=…` answers 404 and publishers upload through the server.
   */
  readonly direct?: DirectUploads;
};

/** A request a publisher makes to the storage itself: what `POST /api/store/<key>?upload=start` answers. */
export type UploadTarget = { readonly method: 'PUT'; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly expiresAt: string };

/** How the storage takes a file straight from a publisher: a short-lived request good for one key, one size and one type. */
export type DirectUploads = { target(key: string, upload: { readonly size: number; readonly contentType: string }): Promise<UploadTarget> };

/** The kinds of object that may go straight to storage: files, which can be large. Everything that makes them visible still comes through the server. */
const DIRECT_KINDS = new Set(['blob', 'run-file']);

/** Read a request body, refusing as soon as it is over the limit rather than after holding it all. */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) throw new Refusal(413, `That is ${declared} bytes; the limit is ${limit}`);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Refusal(413, `The body is over the limit of ${limit} bytes`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

const decode = (c: Context, prefix: string): string | null => {
  try { return decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length)); } catch { return null; }
};

const decoder = new TextDecoder();

/**
 * What a critic-role token may upload: blobs, and layers (and the catalog entries that make them visible) whose producer
 * is `critic.<name>` and whose parts are all of kind `critique`. Anything else, including a key that is not a layer at
 * all, is refused with `403` and the rule it broke, before anything is stored. Blobs are checked against their name by
 * the upload validation, so on their own they are harmless.
 */
async function assertCriticMayStore(name: string, bytes: Uint8Array, store: ObjectStore): Promise<void> {
  const known = classify(name);
  if (known?.kind === 'blob') return;
  if (known?.kind !== 'layer' && known?.kind !== 'layer-catalog') throw new Refusal(403, `A critic token may upload only critiques, not "${name}". Use a publish token for anything else.`);
  let text: string;
  if (known.kind === 'layer') text = decoder.decode(bytes);
  else {
    const stored = await store.get(`layers/manifests/${known.id}.json`);
    // A catalog entry for a layer that is not there is refused by the upload validation, as for everyone.
    if (!stored) return;
    text = decoder.decode(await readBytes(stored.body));
  }
  let layer: { producer?: unknown; parts?: unknown };
  try { layer = JSON.parse(text) as typeof layer; } catch { return; }
  const violation = criticScopeViolation(layer ?? {});
  if (violation) throw new Refusal(403, violation);
}

/**
 * The store protocol: the seven operations of an object store over HTTP, for what the server keeps. A client
 * that publishes to it uses the same code that publishes to a folder or a bucket. It differs from a bucket in
 * that the server checks what it is given, keeps layers immutable, and tells every viewer when something lands.
 *
 *   GET    /api/store?prefix=&after=&limit=   a page of keys, in order
 *   GET    /api/store/<key>                   the object
 *   HEAD   /api/store/<key>                   does it exist
 *   PUT    /api/store/<key>                   upload it (publish token, Bearer)
 *   DELETE /api/store/<key>                   remove a scratch object (publish token, Bearer)
 */
/** A plain relative path: no traversal, no backslash, no control characters. */
const safePath = (value: string) => value.length > 0 && value.length <= 1024 && !value.startsWith('/') && !value.includes('\\') && !/[\u0000-\u001f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

/** The Hono app of the store protocol, to be mounted at `/api/store`. Reads need role `read`; writes need `publish` through a Bearer token. */
export function storeApi(options: StoreApiOptions) {
  const app = new Hono();
  const { store, auth } = options;
  // A layer's manifest is validated when it arrives and its catalog entry follows: what was read the first time serves the second.
  const recent = new Map<string, ReportLayer>();
  // Serialize only competing writes to the same key. Other uploads retain their concurrency.
  const writing = new Map<string, Promise<unknown>>();
  async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = writing.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    writing.set(key, next);
    try { return await next; } finally { if (writing.get(key) === next) writing.delete(key); }
  }
  const refuse = (c: Context, status: number, message: string) => c.json({ error: message }, status as 400);

  app.get('/', async c => {
    const verdict = auth.check(c.req.raw, 'read');
    if (!verdict.ok) return refuse(c, verdict.status, verdict.message);
    // Only layers/ is listed: the whole store may hold other things.
    const prefix = c.req.query('prefix') || 'layers/';
    const after = c.req.query('after');
    const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? 1000) || 1000, 1000));
    const named = prefix.replace(/\/$/, '');
    if (prefix !== 'layers/' && !validKey(named)) {
      // Older layouts keep things outside layers/. A server holds none of them: nothing there, not an error.
      if (safePath(named)) return c.json({ keys: [], next: null });
      return refuse(c, 422, 'Not a prefix Atlas holds');
    }
    if (isPaged(store)) return c.json(await store.listPage(prefix, { ...(after === undefined ? {} : { after }), limit }));
    const all = (await store.listKeys(prefix)).filter(key => after === undefined || key > after);
    return c.json({ keys: all.slice(0, limit), next: all.length > limit ? all[limit - 1]! : null });
  });

  const key = (c: Context) => decode(c, '/api/store/');

  app.on(['GET', 'HEAD'], '/*', async c => {
    const verdict = auth.check(c.req.raw, 'read');
    if (!verdict.ok) return refuse(c, verdict.status, verdict.message);
    const name = key(c);
    if (name === null || !validKey(name)) {
      if (name !== null && safePath(name)) return new Response(c.req.method === 'HEAD' ? null : JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      return refuse(c, 422, 'Not a key Atlas holds');
    }
    const stored = await store.get(name);
    if (!stored) return new Response(c.req.method === 'HEAD' ? null : JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    // Everything under layers/ is immutable, so it may be kept for good.
    // What is stored came from a test run: it is never run, sniffed or embedded, whatever type its uploader gave it.
    const type = /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.-]+=[\w.\-"]+)*$/.test(stored.contentType) ? stored.contentType : 'application/octet-stream';
    const headers = { 'content-type': type, ...UNTRUSTED_HEADERS, 'cache-control': 'public, max-age=31536000, immutable', ...(stored.size ? { 'content-length': String(stored.size) } : {}) };
    if (c.req.method === 'HEAD') { await stored.body.cancel(); return new Response(null, { headers }); }
    return new Response(stored.body, { headers });
  });

  app.put('/*', async c => {
    // A critic may upload too, but only what a critic publishes (see `assertCriticMayStore`).
    const verdict = auth.check(c.req.raw, 'critic');
    if (!verdict.ok) return refuse(c, verdict.status, verdict.message);
    const name = key(c);
    if (name === null || !validKey(name)) return refuse(c, 422, 'Not a key Atlas holds');
    try {
      const bytes = await readLimited(c.req.raw, options.maxObjectBytes);
      return await exclusive(name, async () => {
        if (verdict.identity.role === 'critic') await assertCriticMayStore(name, bytes, store);
        const kind = await validateUpload(name, bytes, store, layer => { recent.set(layer.id, layer); if (recent.size > 8) recent.delete(recent.keys().next().value!); });
        // A blob's name is the digest of what is in it, which was just checked: one that is there is this one, however it was compressed.
        const present = kind === 'blob' && (await store.head(name)) ? 'same' : await sameBytes(store, name, bytes);
        // Scratch objects may be overwritten (an object store's contract says writing a key twice is fine); layers may not.
        if (present === 'different' && kind !== 'scratch') throw new Refusal(409, `${name} already exists with other content. Layers are immutable: publish a new one.`);
        if (present !== 'same') await store.put(name, bytes, c.req.header('content-type') ?? 'application/octet-stream');
        // Catalog entries make a layer, spec set or run visible, so everyone is told only once they are in.
        if (present === 'absent' || isCatalog(kind)) await options.onStored(name, kind, kind === 'layer-catalog' ? recent.get(classify(name)?.id ?? '') : undefined);
        return c.json({ ok: true, key: name, kind, created: present === 'absent' }, present === 'absent' ? 201 : 200);
      });
    } catch (error) {
      if (error instanceof Refusal) return refuse(c, error.status, error.message);
      throw error;
    }
  });

  // A large file, straight to storage: the server says where (after the same checks as an upload), the publisher sends
  // the bytes there, and the server then checks what arrived exactly as it checks an upload, deleting it if it fails.
  app.post('/*', async c => {
    const verdict = auth.check(c.req.raw, 'publish');
    if (!verdict.ok) return refuse(c, verdict.status, verdict.message);
    const step = c.req.query('upload');
    if (!options.direct || (step !== 'start' && step !== 'complete')) return refuse(c, 404, 'This server takes uploads in the request body: PUT /api/store/<key>');
    const name = key(c);
    if (name === null || !validKey(name)) return refuse(c, 422, 'Not a key Atlas holds');
    const kind = classify(name)?.kind;
    if (!kind || !DIRECT_KINDS.has(kind)) return refuse(c, 422, 'Only files (blobs and run files) go straight to storage; upload the rest with PUT');
    if (step === 'start') {
      const body = await c.req.json().catch(() => null) as { size?: unknown; contentType?: unknown } | null;
      const size = Number(body?.size);
      const contentType = typeof body?.contentType === 'string' && /^[\w.+-]+\/[\w.+-]+/.test(body.contentType) ? body.contentType : 'application/octet-stream';
      if (!Number.isSafeInteger(size) || size < 0) return refuse(c, 422, 'Say the size of the file in bytes');
      if (size > options.maxObjectBytes) return refuse(c, 413, `An object may be at most ${Math.floor(options.maxObjectBytes / 1048576)} MiB`);
      // A blob is named for its content: one already there is this one, and needs no bytes.
      if (kind === 'blob' && (await store.head(name))) return c.json({ exists: true });
      return c.json({ exists: false, ...(await options.direct.target(name, { size, contentType })) }, 200, { 'cache-control': 'no-store' });
    }
    try {
      return await exclusive(name, async () => {
        const stored = await store.get(name);
        if (!stored) return refuse(c, 422, `Nothing arrived at ${name}: send the bytes to the upload target first`);
        if (stored.size > options.maxObjectBytes) { await stored.body.cancel(); await store.delete(name); return refuse(c, 413, 'What arrived is larger than the server accepts'); }
        const bytes = await readBytes(stored.body);
        try {
          await validateUpload(name, bytes, store);
        } catch (error) {
          // What fails the checks never becomes part of a report.
          if (error instanceof Refusal) { await store.delete(name); return refuse(c, 422, error.message); }
          throw error;
        }
        await options.onStored(name, kind);
        return c.json({ ok: true, key: name, kind, created: true }, 201);
      });
    } catch (error) {
      if (error instanceof Refusal) return refuse(c, error.status, error.message);
      throw error;
    }
  });

  app.delete('/*', async c => {
    const verdict = auth.check(c.req.raw, 'publish');
    if (!verdict.ok) return refuse(c, verdict.status, verdict.message);
    const name = key(c);
    // Nothing a report is made of can be taken away. Only what `atlas report doctor` writes to try the store.
    if (name === null || classify(name)?.kind !== 'scratch') return refuse(c, 403, 'Layers, specs and runs are never removed through the API');
    await store.delete(name);
    return c.body(null, 204);
  });

  return app;
}

export { readBytes };
