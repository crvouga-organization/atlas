/**
 * @module Atlas server as an ObjectStore
 *
 * `httpStore` speaks the server's store protocol (`/api/store`) as an `ObjectStore`, so everything that publishes to a store
 * (`publishChecks`, spec sets, run uploads, `copyStore`, `createReporter`) publishes to a server unchanged. It retries what a
 * retry can fix (network errors, 5xx, 429, 408) with jittered backoff, never what it cannot (401, 403, 409, 413, 422), and
 * every refusal says what to do about it. Behind a platform's sign-in it sends the extra headers of `ATLAS_HEADERS`, and a
 * sign-in page where Atlas should have answered is an error that says so, never a parse failure.
 *
 * @see docs/server.md#the-store-protocol
 */

import type { ObjectStore, PagedListing, StoredObject } from './object-store';
import { ObjectStoreWithPrefix } from './store-prefix';
import { sha256Hex } from './sigv4';
import { ProjectSlugSchema } from '../../schema/src/project';
import { isSignInPage, processHeaders, signInMessage } from './request-headers';
import type { IdentitySource } from './ci-identity';

/** How to reach a server: its `url`, the `token` to send (never in the URL), and, for tests and special runtimes, `fetch`, the retry count, the per-attempt timeout and `sleep`. */
export type HttpStoreOptions = {
  /** Project namespace on a shared Atlas node. Omit for the legacy default project. */
  readonly project?: string;
  /** The Atlas server, such as `https://atlas.example.com`. A path on it (`/atlas`) is kept. */
  readonly url: string;
  /** A publish or admin token to write with, a read token to read with. Never put it in the URL. */
  readonly token?: string;
  /**
   * Without a `token`: where to get a CI identity token for this server (trusted publishing). `openStore` gives one in
   * GitHub Actions with `id-token: write`. A server that trusts the repository lets it publish with no secret.
   */
  readonly identity?: IdentitySource;
  /**
   * Extra headers for every request, for a server behind a platform's sign-in (`x-vercel-protection-bypass`, Cloudflare
   * Access service tokens). Default: `ATLAS_HEADERS` from the process environment (throws when it is malformed). Their
   * values are never printed.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  /** Retries after the first attempt, for network errors and server errors. Default 4. */
  readonly retries?: number;
  /** Per attempt, to start answering, in milliseconds. Default 30 000. */
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

/** What an Atlas server said no to, with what to do about it. */
export class AtlasHttpError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable = false) {
    super(message);
    this.name = 'AtlasHttpError';
  }
}

/** An `ObjectStore` (with paged listing) over an Atlas server, plus what only a server can answer: `ping` (is it there, and what may this token do) and `status` (the gate, worked out by the server). */
export type HttpStore = ObjectStore & PagedListing & {
  /** The same authenticated node connection, scoped to another project. */
  forProject(project: string): HttpStore;
  /** `https://atlas.example.com`, with no secrets. */
  readonly label: string;
  readonly url: string;
  /** The names (never the values) of the extra headers sent with every request. */
  readonly headerNames: readonly string[];
  /** Is the server there, and does it know this token? */
  ping(): Promise<{ readonly ok: boolean; readonly ms: number; readonly role?: string; readonly error?: string }>;
  /** The gate, worked out by the server from the layers it holds: the `atlas report status --format json` document. Needs a token that may read. */
  status(query?: URLSearchParams): Promise<unknown>;
  /**
   * Any other operation of this server's API (of the selected project), such as `call('POST', '/ui-catalog/claims', { json })`:
   * the token is sent, a body given as `json` is sent as JSON, and what a retry can fix is retried. A status listed in
   * `accept` is returned instead of thrown; any other refusal throws an {@link AtlasHttpError} that says what to do.
   */
  call(method: string, path: string, init?: { readonly json?: unknown; readonly headers?: Readonly<Record<string, string>>; readonly accept?: readonly number[] }): Promise<Response>;
};

const encode = (key: string) => key.split('/').map(encodeURIComponent).join('/');
/** The keys that may go straight to storage: files (blobs and the files of a run), never what makes something visible. */
const DIRECT_KEY = /^layers\/(blobs\/[0-9a-f]{64}\.gz|runs\/(?!index\/)[\w.-]+\/(?!manifest\.json$).+)$/;

function explain(status: number, base: string, message: string | null): string {
  const said = message ? `: ${message}` : '';
  switch (status) {
    case 401: return `${base} wants a token${said}. Set ATLAS_TOKEN (a publish token to upload, a read token to read), or publish from GitHub Actions with permissions: id-token: write from a repository the server trusts (ATLAS_TRUSTED_PUBLISHERS).`;
    case 403: return `${base} knows this token but it may not do that${said}. Uploading needs a publish or admin token.`;
    case 409: return `${base} refused a change to something that already exists${said}`;
    case 413: return `${base} refused an object that large${said}. Attach big files by uri, or raise the server's limits.maxObjectMiB.`;
    case 422: return `${base} did not accept it${said}`;
    default: return `${base} answered ${status}${said}`;
  }
}

/**
 * An {@link ObjectStore} on an Atlas server, over its store protocol (`/api/store`). The server holds the
 * layers (on its own disk, or in whatever backends it was given), checks what is uploaded, and shows
 * everyone the combined report at once. Anything that publishes to a store, `publishChecks`, spec sets,
 * run uploads, `copyStore`, works against it unchanged.
 */
export function httpStore(options: HttpStoreOptions): HttpStore {
  const base = options.url.replace(/\/+$/, '');
  const api = options.project ? `${base}/api/projects/${ProjectSlugSchema.parse(options.project)}` : `${base}/api`;
  const root = `${api}/store`;
  const doFetch = options.fetch ?? fetch;
  const retries = options.retries ?? 4;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const fixed: Record<string, string> = options.token ? { authorization: `Bearer ${options.token}` } : {};
  /** The token, or else a CI identity token that is renewed as it expires. */
  const authorizationOf = async (): Promise<Record<string, string>> => {
    if (options.token || !options.identity) return fixed;
    try {
      return { authorization: `Bearer ${await options.identity()}` };
    } catch (error) {
      throw new AtlasHttpError(`${base}: ${error instanceof Error ? error.message : String(error)}`, null);
    }
  };
  const extra = options.headers ?? processHeaders();

  async function request(method: string, url: string, init: { body?: Uint8Array; contentType?: string; allow404?: boolean; accept?: readonly number[]; headers?: Readonly<Record<string, string>>; json?: boolean } = {}): Promise<Response | null> {
    for (let attempt = 0; ; attempt++) {
      let failure: AtlasHttpError;
      const authorization = await authorizationOf();
      try {
        // The clock is for the server to start answering; a large body may take longer to arrive.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await doFetch(url, { method, headers: { ...extra, ...init.headers, ...authorization, ...(init.contentType ? { 'content-type': init.contentType } : {}) }, ...(init.body ? { body: init.body as BodyInit } : {}), signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        // The platform in front of the server answered, not Atlas: no retry can get past it.
        if (isSignInPage(response, url, init.json ?? false)) {
          await response.body?.cancel();
          throw new AtlasHttpError(signInMessage(base, extra), response.status);
        }
        if (response.ok || init.accept?.includes(response.status)) return response;
        if (response.status === 404 && init.allow404) { await response.body?.cancel(); return null; }
        const said = await response.json().then((body: unknown) => body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : null, () => null);
        failure = new AtlasHttpError(explain(response.status, base, said), response.status, response.status >= 500 || response.status === 429 || response.status === 408);
      } catch (error) {
        if (error instanceof AtlasHttpError) throw error;
        failure = new AtlasHttpError(`cannot reach ${base} (${error instanceof Error ? (error.name === 'AbortError' ? `no answer in ${timeoutMs} ms` : error.message) : String(error)})`, null, true);
      }
      if (!failure.retryable || attempt >= retries) throw failure;
      await sleep(Math.random() * Math.min(8_000, 100 * 2 ** attempt));
    }
  }

  // A server on a host that refuses large request bodies says how large a file may pass through it (`uploads.directOverBytes`).
  // An older server says nothing, and everything goes through it as before.
  type Uploads = { directOverBytes?: number | null; gzipManifests?: boolean };
  let negotiated: Promise<Uploads> | undefined;
  const uploads = (): Promise<Uploads> => negotiated ??= request('GET', `${base}/api/server`, { json: true })
    .then(async response => (await response!.json() as { uploads?: Uploads }).uploads ?? {})
    .catch(() => ({}));

  /** Send a large file straight to storage when the server offers it. False: send it through the server instead. */
  async function putDirect(key: string, bytes: Uint8Array, contentType: string): Promise<boolean> {
    if (!DIRECT_KEY.test(key)) return false;
    const over = (await uploads()).directOverBytes;
    if (over == null || bytes.length <= over) return false;
    const url = `${root}/${encode(key)}`;
    const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const descriptor = json({ size: bytes.length, contentType, sha256: await sha256Hex(bytes) });
    const started = await request('POST', `${url}?upload=start`, { body: descriptor, contentType: 'application/json', json: true, accept: [404, 422] });
    if (!started || started.status === 404 || started.status === 422) { await started?.body?.cancel(); return false; }
    const target = await started.json() as { exists?: boolean; staged?: boolean; method?: string; url?: string; headers?: Record<string, string> };
    if (target.exists) return true;
    if (!target.url || target.method !== 'PUT') throw new AtlasHttpError(`${base} offered an upload target it did not describe`, started.status);
    // Straight to storage: only the target's own short-lived headers go there, never the Atlas token or ATLAS_HEADERS.
    for (let attempt = 0; ; attempt++) {
      const sent = await doFetch(target.url, { method: 'PUT', headers: target.headers ?? {}, body: bytes as BodyInit }).catch((error: Error) => error);
      if (!(sent instanceof Error) && sent.ok) { await sent.body?.cancel(); break; }
      const status = sent instanceof Error ? null : sent.status;
      if (!(sent instanceof Error)) await sent.body?.cancel();
      if (attempt >= retries || (status !== null && status < 500 && status !== 429)) throw new AtlasHttpError(`storage refused ${key} sent straight to it (${status ?? (sent as Error).message})`, status, false);
      await sleep(Math.random() * Math.min(8_000, 100 * 2 ** attempt));
    }
    await (await request('POST', `${url}?upload=complete`, target.staged ? { body: descriptor, contentType: 'application/json' } : {}))?.arrayBuffer();
    return true;
  }

  const store: HttpStore = {
    forProject: project => httpStore({ ...options, headers: extra, project }),
    label: base,
    url: base,
    headerNames: Object.keys(extra),

    async get(key): Promise<StoredObject | null> {
      const response = await request('GET', `${root}/${encode(key)}`, { allow404: true });
      if (!response) return null;
      return { body: response.body ?? new Blob([]).stream(), contentType: response.headers.get('content-type') ?? 'application/octet-stream', size: Number(response.headers.get('content-length') ?? 0) };
    },
    async put(key, bytes, contentType) {
      if (await putDirect(key, bytes, contentType)) return;
      if (bytes.length > 64 * 1024 && /^layers\/manifests\/[0-9a-f]{64}\.json$/.test(key) && (await uploads()).gzipManifests) {
        const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
        const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
        if (compressed.length < bytes.length) {
          await (await request('PUT', `${root}/${encode(key)}`, { body: compressed, contentType, headers: { 'x-atlas-compression': 'gzip' } }))?.arrayBuffer();
          return;
        }
      }
      await (await request('PUT', `${root}/${encode(key)}`, { body: bytes, contentType }))?.arrayBuffer();
    },
    async head(key) {
      return (await request('HEAD', `${root}/${encode(key)}`, { allow404: true })) !== null;
    },
    async delete(key) {
      await (await request('DELETE', `${root}/${encode(key)}`, { allow404: true }))?.arrayBuffer();
    },
    async deleteMany(keys) {
      for (const key of keys) await store.delete(key);
    },
    async getUri() {
      return null;
    },
    async listPage(prefix = '', page = {}) {
      const query = new URLSearchParams({ prefix, limit: String(page.limit ?? 1000) });
      if (page.after !== undefined) query.set('after', page.after);
      const response = (await request('GET', `${root}?${query}`, { json: true }))!;
      const body = await response.json() as { keys?: string[]; next?: string | null };
      if (!Array.isArray(body.keys)) throw new AtlasHttpError(`${base} did not answer a listing`, response.status);
      return { keys: body.keys, next: body.next ?? null };
    },
    async listKeys(prefix = '') {
      const keys: string[] = [];
      for (let after: string | undefined; ;) {
        const page = await store.listPage(prefix, after === undefined ? {} : { after });
        keys.push(...page.keys);
        if (page.next === null) return keys;
        after = page.next;
      }
    },
    withPrefix(prefix) {
      return new ObjectStoreWithPrefix(store, prefix);
    },
    async call(method, path, init = {}) {
      const body = init.json === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(init.json)), contentType: 'application/json' };
      return (await request(method, `${api}${path.startsWith('/') ? path : `/${path}`}`, { ...body, ...(init.accept ? { accept: init.accept } : {}), ...(init.headers ? { headers: init.headers } : {}) }))!;
    },
    async status(query = new URLSearchParams()) {
      const suffix = query.size ? `?${query}` : '';
      return (await request('GET', `${api}/status${suffix}`, { json: true }))!.json();
    },
    async ping() {
      const started = performance.now();
      try {
        const response = (await request('GET', `${base}/api/server`, { json: true }))!;
        const info = await response.json() as { role?: string };
        return { ok: true, ms: Math.round(performance.now() - started), ...(info.role ? { role: info.role } : {}) };
      } catch (error) {
        return { ok: false, ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
      }
    }
  };
  return store;
}
