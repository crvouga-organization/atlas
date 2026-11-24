/**
 * An in-memory Vercel Blob service behind a `fetch`, answering the requests `@vercel/blob` 2.9 sends: `PUT /?pathname=`
 * (with `x-vercel-blob-access`, `x-content-type`, `x-add-random-suffix`, `x-allow-overwrite`), `GET ?url=` (head),
 * `POST /delete`, `GET ?prefix&limit&cursor` (list), and reads from the private content host with the token. It is
 * strict where the real service is: a put without `x-allow-overwrite: 1` on an existing pathname is refused, a random
 * suffix changes the pathname, and every request needs the token.
 */
export const BLOB_TOKEN = 'vercel_blob_rw_teststore_secretpart';
export const BLOB_API = 'https://blob-api.test/api/blob';
export const BLOB_CONTENT = 'https://teststore.private.blob.vercel-storage.com';

type Stored = { bytes: Uint8Array; contentType: string };

export function fakeVercelBlob(options: { token?: string } = {}) {
  const token = options.token ?? BLOB_TOKEN;
  const objects = new Map<string, Stored>();
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  /** Answers the next N requests with 503, to prove retries. */
  let failNext = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const error = (status: number, code: string, message = code) => json(status, { error: { code, message } });

  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    requests.push({ method, url: url.toString(), headers });
    if (failNext > 0) { failNext -= 1; return error(503, 'service_unavailable'); }
    if (headers.authorization !== `Bearer ${token}`) return error(403, 'forbidden', 'Access denied');

    if (url.origin === new URL(BLOB_CONTENT).origin) {
      const pathname = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
      const stored = objects.get(pathname);
      if (!stored) return new Response('Not found', { status: 404 });
      return new Response(stored.bytes.slice(), { headers: { 'content-type': stored.contentType, 'content-length': String(stored.bytes.length) } });
    }
    if (!url.toString().startsWith(BLOB_API)) return new Response('unknown host', { status: 502 });
    if (headers['x-api-version'] === undefined) return error(400, 'bad_request', 'x-api-version is required');
    const route = url.pathname.slice(new URL(BLOB_API).pathname.length);

    if (method === 'PUT' && (route === '/' || route === '')) {
      let pathname = url.searchParams.get('pathname') ?? '';
      if (!pathname || pathname.includes('//')) return error(400, 'bad_request', 'invalid pathname');
      if (headers['x-vercel-blob-access'] !== 'private') return error(400, 'bad_request', 'this store is private');
      if (headers['x-add-random-suffix'] !== '0') pathname = pathname.replace(/(\.[^./]*)?$/, `-${Math.random().toString(36).slice(2, 8)}$1`);
      if (objects.has(pathname) && headers['x-allow-overwrite'] !== '1') return error(400, 'bad_request', 'This blob already exists');
      const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      objects.set(pathname, { bytes, contentType: headers['x-content-type'] ?? 'application/octet-stream' });
      return json(200, { url: `${BLOB_CONTENT}/${pathname}`, pathname, contentType: headers['x-content-type'] });
    }
    if (method === 'POST' && route === '/delete') {
      const body = JSON.parse(String(init.body)) as { urls: string[] };
      for (const name of body.urls) objects.delete(name);
      return json(200, {});
    }
    if (method === 'GET' && route === '' && url.searchParams.has('url')) {
      const pathname = url.searchParams.get('url')!;
      const stored = objects.get(pathname);
      return stored ? json(200, { pathname, size: stored.bytes.length, contentType: stored.contentType, url: `${BLOB_CONTENT}/${pathname}` }) : error(404, 'not_found', 'The requested blob does not exist');
    }
    if (method === 'GET' && route === '') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      const cursor = url.searchParams.get('cursor');
      const after = cursor ? atob(cursor) : '';
      const names = [...objects.keys()].filter(name => name.startsWith(prefix) && name > after).sort();
      const page = names.slice(0, limit);
      const hasMore = names.length > limit;
      return json(200, { blobs: page.map(pathname => ({ pathname, size: objects.get(pathname)!.bytes.length, url: `${BLOB_CONTENT}/${pathname}` })), cursor: hasMore ? btoa(page.at(-1)!) : undefined, hasMore });
    }
    return error(400, 'bad_request', `no route ${method} ${route}`);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    objects,
    requests,
    failNext(count: number) { failNext = count; },
    /** The options that point a store at this fake (its content host is the default one, so it is not given). */
    options: { token, apiUrl: BLOB_API, sleep: async () => {} }
  };
}
