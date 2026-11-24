/**
 * @module Vercel Blob object store
 *
 * An `ObjectStore` on Vercel Blob, written without the `@vercel/blob` SDK: its HTTP API is called with `fetch`, the
 * same way the S3 store signs its own requests, so it adds nothing to the install and runs on Bun and Node. Objects
 * are private and kept under their exact keys (no random suffix, overwrite allowed, so a retried write lands on the
 * same key with the same bytes), and are read back with the store's token. `getUri` never returns a URL that works
 * without the token: it answers `null`, and the server streams the bytes instead. Importing the module does no work.
 *
 * @see docs/deploying.md#vercel-blob
 * @see docs/report-contract.md#backends
 */
import type { ObjectStore, PagedListing, StoredObject } from './object-store';
import { ObjectStoreWithPrefix } from './store-prefix';

/** How to reach a Blob store. Everything is optional: the token comes from `BLOB_READ_WRITE_TOKEN` by default. */
export type VercelBlobStoreOptions = {
  /** A read-write token of the Blob store (`vercel_blob_rw_<store id>_…`). Default: `BLOB_READ_WRITE_TOKEN`. Never put it in a store URL. */
  readonly token?: string;
  /** A folder inside the Blob store that holds everything: `atlas/my-project`. */
  readonly prefix?: string;
  /** The Blob API. Default: `VERCEL_BLOB_API_URL`, then `https://vercel.com/api/blob`. Set it for a local emulator. */
  readonly apiUrl?: string;
  /** Where private objects are read from, given the store id. Default: `https://<store id>.private.blob.vercel-storage.com`. */
  readonly contentUrl?: (storeId: string) => string;
  /** The environment variables to read (`BLOB_READ_WRITE_TOKEN`, `VERCEL_BLOB_API_URL`). Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The `fetch` to send requests with. Default: the global one; inject a fake in tests. */
  readonly fetch?: typeof fetch;
  /** Attempts after the first for a request that failed in a way worth retrying. Default 4. */
  readonly retries?: number;
  /** For the service to start answering, per attempt, in milliseconds. Default 30 000. */
  readonly timeoutMs?: number;
  /** The wait between retries, in milliseconds. Default: a real timer; inject in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * An error from the Blob store. The message names the store folder and what to do; `status` and `code` are what the
 * service answered (`forbidden`, `store_not_found`, `rate_limited`, …), `null` when it was never reached. `retryable`
 * says whether trying again can help; the store already retried before throwing.
 */
export class VercelBlobError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null, readonly retryable = false) {
    super(message);
    this.name = 'VercelBlobError';
  }
}

/** An `ObjectStore` on Vercel Blob with paged listing, a secret-free label, and a cheap reachability check. */
export type VercelBlobStore = ObjectStore & PagedListing & {
  /** A description with no secrets: `vercel-blob://my-project/ (store abc123)`. */
  readonly label: string;
  /**
   * A request someone else may make to write exactly this key, this size and this type, for a short while, without the
   * store's token: a client token signed with it. For files too large to pass through a serverless function.
   */
  uploadTarget(key: string, upload: { readonly size: number; readonly contentType: string; readonly validForMs?: number }): Promise<{ readonly method: 'PUT'; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly expiresAt: string }>;
  /** One cheap round trip: can this store be listed with this token? Used by `atlas report doctor`. */
  ping(): Promise<{ readonly ok: boolean; readonly ms: number; readonly error?: string }>;
};

/** The Blob HTTP API version this store speaks: the one `@vercel/blob` 2.9 sends. */
const API_VERSION = '13';
const RETRYABLE_CODES = new Set(['unknown_error', 'service_unavailable', 'internal_server_error', 'rate_limited']);
/** The most keys one listing request returns. */
const PAGE = 1000;
/** Keys per delete request. */
const DELETE_BATCH = 100;

/** The store id inside a read-write token: `vercel_blob_rw_<store id>_<secret>`. */
export function blobStoreIdOf(token: string): string | null {
  const [vercel, blob, rw, storeId] = token.split('_');
  return vercel === 'vercel' && blob === 'blob' && rw === 'rw' && storeId ? storeId : null;
}

function hint(code: string | null, status: number | null, where: string): string {
  switch (code) {
    case 'forbidden': return `${where}: access denied. BLOB_READ_WRITE_TOKEN must be a read-write token of this Blob store.`;
    case 'store_not_found': return `${where}: the Blob store of this token does not exist. Copy BLOB_READ_WRITE_TOKEN again from the store's settings.`;
    case 'store_suspended': return `${where}: the Blob store is suspended. See its page in the Vercel dashboard.`;
    case 'file_too_large': return `${where}: the object is larger than the Blob store accepts in one request.`;
    case 'rate_limited': return `${where}: the Blob API is rate limiting these requests.`;
    case 'bad_request': return `${where}: the Blob API refused the request as malformed. If the store is public, Atlas needs a private store.`;
    default: return `${where}: ${code ?? `HTTP ${status}`}`;
  }
}

/**
 * An {@link ObjectStore} on Vercel Blob. No SDK: the Blob HTTP API is called with `fetch`, so it runs on Bun and Node and adds
 * nothing to the install.
 *
 * Objects are written private, under the exact key (no random suffix), overwriting what is there, with the content type
 * given; they are read back from the store's private host with the token, uncached, so an overwrite is seen at once.
 * Throttling, server errors and network failures are retried with jittered backoff.
 *
 * Behaviour to know: the constructor throws when there is no token, or the token is not a read-write token (the store
 * id is read from it). `getUri` always answers `null`: a private object has no URL that works without the token, and a
 * permanently public one is never handed out. `listKeys` pages through the whole listing and sorts it. `listPage`
 * continues from the service's cursor when it is asked for the page after the one it last returned, and otherwise
 * lists the prefix and filters it, so it is always correct and usually one request. `deleteMany` sends 100 keys per request.
 *
 * @example
 * const store = vercelBlobStore({ token: process.env.BLOB_READ_WRITE_TOKEN!, prefix: 'my-project/' });
 * await store.put('layers/manifests/x.json', bytes, 'application/json');
 * const { ok, error } = await store.ping();
 */
export function vercelBlobStore(options: VercelBlobStoreOptions = {}): VercelBlobStore {
  const env = options.env ?? process.env;
  const token = (options.token ?? env.BLOB_READ_WRITE_TOKEN ?? '').trim();
  if (!token) throw new Error('A Vercel Blob store needs a read-write token: set BLOB_READ_WRITE_TOKEN (the Blob store\'s settings show it).');
  const storeId = blobStoreIdOf(token);
  if (!storeId) throw new Error('BLOB_READ_WRITE_TOKEN is not a Vercel Blob read-write token (one starts with vercel_blob_rw_).');
  const api = (options.apiUrl ?? env.VERCEL_BLOB_API_URL ?? 'https://vercel.com/api/blob').replace(/\/+$/, '');
  const content = (options.contentUrl ?? (id => `https://${id}.private.blob.vercel-storage.com`))(storeId).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const retries = options.retries ?? 4;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const prefix = (options.prefix ?? '').replace(/^\/+/, '');
  const base = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  const where = `vercel-blob://${base}`;
  const auth = { authorization: `Bearer ${token}`, 'x-api-version': API_VERSION, 'x-vercel-blob-store-id': storeId };
  // The cursor that continues after a page, by the last key of that page, so the next page is one request.
  const cursors = new Map<string, string>();

  /** One request with retries; a 404 is `null` when `allow404`. */
  async function send(url: string, init: { method: string; headers?: Record<string, string>; body?: Uint8Array | string; allow404?: boolean }, key = ''): Promise<Response | null> {
    for (let attempt = 0; ; attempt++) {
      let failure: VercelBlobError;
      let timedOut = false;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        let response: Response;
        try {
          response = await doFetch(url, { method: init.method, headers: { ...auth, ...init.headers }, ...(init.body !== undefined ? { body: init.body as BodyInit } : {}), signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (response.ok) return response;
        const said = await response.json().then((body: { error?: { code?: string; message?: string } }) => body?.error ?? null, () => null);
        const code = said?.code ?? null;
        if (response.status === 404 && init.allow404 && code !== 'store_not_found') return null;
        const retryable = response.status >= 500 || response.status === 429 || response.status === 408 || RETRYABLE_CODES.has(code ?? '');
        failure = new VercelBlobError(`${hint(code, response.status, `${where}${key}`)}${said?.message && code !== 'forbidden' ? ` (${said.message})` : ''}`, response.status, code, retryable);
      } catch (error) {
        const reason = timedOut ? `timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error);
        failure = new VercelBlobError(`${where}: cannot reach the Blob store (${reason})`, null, null, true);
      }
      if (!failure.retryable || attempt >= retries) throw failure;
      await sleep(Math.random() * Math.min(8_000, 100 * 2 ** attempt));
    }
  }

  const encode = (key: string) => key.split('/').map(encodeURIComponent).join('/');

  async function list(listPrefix: string, cursor: string | undefined, limit = PAGE): Promise<{ keys: string[]; cursor: string | null }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (base + listPrefix) query.set('prefix', base + listPrefix);
    if (cursor) query.set('cursor', cursor);
    const response = (await send(`${api}?${query}`, { method: 'GET' }))!;
    const body = await response.json() as { blobs?: { pathname?: unknown }[]; cursor?: string | null; hasMore?: boolean };
    if (!Array.isArray(body.blobs)) throw new VercelBlobError(`${where}: the listing had no blobs`, response.status, null);
    const keys = body.blobs.map(blob => String(blob.pathname)).filter(name => name.startsWith(base + listPrefix)).map(name => name.slice(base.length));
    return { keys, cursor: body.hasMore && body.cursor ? body.cursor : null };
  }

  const store: VercelBlobStore = {
    label: `${where} (store ${storeId})`,

    async get(key): Promise<StoredObject | null> {
      // `cache=0` reads the object as stored now, not as a CDN cached it before an overwrite.
      const response = await send(`${content}/${encode(base + key)}?cache=0`, { method: 'GET', allow404: true }, key);
      if (!response) return null;
      return { body: response.body ?? new Blob([]).stream(), contentType: response.headers.get('content-type') ?? 'application/octet-stream', size: Number(response.headers.get('content-length') ?? 0) };
    },

    async put(key, bytes, contentType) {
      const query = new URLSearchParams({ pathname: base + key });
      const response = await send(`${api}/?${query}`, {
        method: 'PUT', body: bytes,
        headers: { 'x-vercel-blob-access': 'private', 'x-content-type': contentType, 'x-add-random-suffix': '0', 'x-allow-overwrite': '1' }
      }, key);
      await response?.arrayBuffer();
    },

    async head(key) {
      const response = await send(`${api}?${new URLSearchParams({ url: base + key })}`, { method: 'GET', allow404: true }, key);
      await response?.arrayBuffer();
      return response !== null;
    },

    async delete(key) {
      await store.deleteMany([key]);
    },

    async deleteMany(keys) {
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const urls = keys.slice(i, i + DELETE_BATCH).map(key => base + key);
        const response = await send(`${api}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls }), allow404: true });
        await response?.arrayBuffer();
      }
    },

    async getUri() {
      // A private object has no URL that works without the token, and a public one is never handed out.
      return null;
    },

    async listKeys(listPrefix = '') {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list(listPrefix, cursor);
        keys.push(...page.keys);
        cursor = page.cursor ?? undefined;
      } while (cursor);
      // The contract is code-unit order, whatever order the service lists in.
      return keys.sort();
    },

    async listPage(listPrefix = '', page = {}) {
      const limit = Math.max(1, Math.min(page.limit ?? PAGE, PAGE));
      const remembered = page.after === undefined ? undefined : cursors.get(`${listPrefix}\0${page.after}`);
      if (page.after === undefined || remembered !== undefined) {
        let found = await list(listPrefix, remembered, limit);
        let keys = found.keys.filter(key => page.after === undefined || key > page.after).sort();
        // A page that held nothing new is not the end while the service says there is more.
        while (!keys.length && found.cursor) {
          found = await list(listPrefix, found.cursor, limit);
          keys = found.keys.filter(key => page.after === undefined || key > page.after).sort();
        }
        const next = found.cursor && keys.length ? keys.at(-1)! : null;
        if (next !== null) {
          if (cursors.size >= 256) cursors.delete(cursors.keys().next().value!);
          cursors.set(`${listPrefix}\0${next}`, found.cursor!);
        }
        return { keys, next };
      }
      // Asked to continue from a key this store did not end a page on: list and filter, which is always right.
      const after = page.after;
      const rest = (await store.listKeys(listPrefix)).filter(key => key > after);
      return { keys: rest.slice(0, limit), next: rest.length > limit ? rest[limit - 1]! : null };
    },

    withPrefix(extra) {
      return new ObjectStoreWithPrefix(store, extra);
    },

    async uploadTarget(key, upload) {
      const pathname = base + key;
      const validUntil = Date.now() + (upload.validForMs ?? 15 * 60_000);
      // The client token @vercel/blob makes: an HMAC of the allowed upload, signed with the read-write token, good for this one pathname.
      const payload = btoa(JSON.stringify({ pathname, validUntil, maximumSizeInBytes: upload.size, allowedContentTypes: [upload.contentType], addRandomSuffix: false, allowOverwrite: true }));
      const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', keyMaterial, new TextEncoder().encode(payload)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const clientToken = `vercel_blob_client_${storeId}_${btoa(`${signature}.${payload}`)}`;
      return {
        method: 'PUT', url: `${api}/?${new URLSearchParams({ pathname })}`, expiresAt: new Date(validUntil).toISOString(),
        headers: { authorization: `Bearer ${clientToken}`, 'x-api-version': API_VERSION, 'x-vercel-blob-store-id': storeId, 'x-vercel-blob-access': 'private', 'x-content-type': upload.contentType, 'x-add-random-suffix': '0', 'x-allow-overwrite': '1' }
      };
    },

    async ping() {
      const started = performance.now();
      try {
        await list('', undefined, 1);
        return { ok: true, ms: Math.round(performance.now() - started) };
      } catch (error) {
        return { ok: false, ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
      }
    }
  };
  return store;
}
