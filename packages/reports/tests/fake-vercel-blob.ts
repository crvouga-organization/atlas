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

let version = 0;
type Stored = { etag?: string; bytes: Uint8Array; contentType: string };

export function fakeVercelBlob(options: { token?: string; /** A public store refuses private writes, as the service does. */ access?: 'private' | 'public'; /** The longest delegation `POST /signed-token` grants. Default an hour. */ maxDelegationMs?: number } = {}) {
  const token = options.token ?? BLOB_TOKEN;
  const objects = new Map<string, Stored>();
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  /** Answers the next N requests with 503, to prove retries. */
  let failNext = 0;
  let uploadsWithClientToken = 0;
  /** Delegations issued by `POST /signed-token`: the client signing token each was issued with. */
  const delegations = new Map<string, string>();
  let presignedReads = 0;
  const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hmac = async (secret: string, data: string) => b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(data))));
  /** The stored bytes, or one `bytes=a-b` range of them. */
  const serve = (stored: Stored, range: string | undefined) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
    if (!match) return new Response(stored.bytes.slice(), { headers: { etag: stored.etag ?? '', 'content-type': stored.contentType, 'content-length': String(stored.bytes.length) } });
    const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), stored.bytes.length - 1) : stored.bytes.length - 1;
    return new Response(stored.bytes.slice(start, end + 1), { status: 206, headers: { 'content-type': stored.contentType, 'content-range': `bytes ${start}-${end}/${stored.bytes.length}` } });
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const error = (status: number, code: string, message = code) => json(status, { error: { code, message } });

  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    requests.push({ method, url: url.toString(), headers });
    if (failNext > 0) { failNext -= 1; return error(503, 'service_unavailable'); }
    // A presigned read, as @vercel/blob's presignUrl makes one: no token, a delegation and a signature over the pathname.
    if (url.origin === new URL(BLOB_CONTENT).origin && url.searchParams.has('vercel-blob-signature')) {
      const pathname = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
      const delegation = url.searchParams.get('vercel-blob-delegation') ?? '';
      const signing = delegations.get(delegation);
      const [payloadPart = '', signaturePart] = delegation.split('.');
      if (!signing || signaturePart !== await hmac(token, payloadPart)) return new Response('Forbidden', { status: 403 });
      const scope = JSON.parse(atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payloadPart.length / 4) * 4, '='))) as { validUntil: number; operations: string[]; pathname?: string };
      const until = url.searchParams.get('vercel-blob-valid-until');
      if (scope.validUntil <= Date.now() || (until !== null && (Number(until) <= Date.now() || Number(until) > scope.validUntil))) return new Response('Expired', { status: 403 });
      if (!scope.operations.includes('get') || (scope.pathname && scope.pathname !== '*' && scope.pathname !== pathname)) return new Response('Forbidden', { status: 403 });
      const canonical = ['operation=get', `pathname=${pathname}`, ...(until !== null ? [`vercel-blob-valid-until=${until}`] : [])].sort().join('\n');
      if (url.searchParams.get('vercel-blob-signature') !== await hmac(signing, canonical)) return new Response('Forbidden', { status: 403 });
      const stored = objects.get(pathname);
      if (!stored) return new Response('Not found', { status: 404 });
      presignedReads += 1;
      return serve(stored, headers.range);
    }
    // A client token, as @vercel/blob makes one: allowed one upload, of one pathname, size and type, until it expires.
    let client: { pathname: string; validUntil: number; maximumSizeInBytes?: number; allowedContentTypes?: string[] } | null = null;
    const bearer = headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (bearer.startsWith('vercel_blob_client_')) {
      const [, , , storeId, encoded] = bearer.split('_');
      const [signature, payload] = atob(encoded ?? '').split('.');
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const expected = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload ?? '')))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (storeId !== token.split('_')[3] || signature !== expected) return error(403, 'forbidden', 'Invalid client token');
      client = JSON.parse(atob(payload!));
      if (client!.validUntil < Date.now()) return error(400, 'bad_request', 'Token expired');
      if (method !== 'PUT') return error(403, 'client_token_not_allowed', 'This operation is not available when using a client token');
    } else if (headers.authorization !== `Bearer ${token}`) return error(403, 'forbidden', 'Access denied');

    if (url.origin === new URL(BLOB_CONTENT).origin) {
      const pathname = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
      const stored = objects.get(pathname);
      if (!stored) return new Response('Not found', { status: 404 });
      return serve(stored, headers.range);
    }
    if (!url.toString().startsWith(BLOB_API)) return new Response('unknown host', { status: 502 });
    if (headers['x-api-version'] === undefined) return error(400, 'bad_request', 'x-api-version is required');
    const route = url.pathname.slice(new URL(BLOB_API).pathname.length);

    if (method === 'PUT' && (route === '/' || route === '')) {
      let pathname = url.searchParams.get('pathname') ?? '';
      if (!pathname || pathname.includes('//')) return error(400, 'bad_request', 'invalid pathname');
      if (headers['x-vercel-blob-access'] !== (options.access ?? 'private')) return error(400, 'bad_request', `Cannot use ${headers['x-vercel-blob-access']} access on a ${options.access ?? 'private'} store`);
      if (client && client.pathname !== pathname) return error(400, 'bad_request', 'The "pathname" does not match the token payload');
      if (client?.allowedContentTypes && !client.allowedContentTypes.includes(headers['x-content-type'] ?? '')) return error(400, 'bad_request', 'contentType is not allowed');
      if (headers['x-add-random-suffix'] !== '0') pathname = pathname.replace(/(\.[^./]*)?$/, `-${Math.random().toString(36).slice(2, 8)}$1`);
      const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      if (objects.has(pathname) && headers['x-allow-overwrite'] !== '1') return error(400, 'bad_request', 'This blob already exists');
      if (headers['x-if-match'] && headers['x-if-match'] !== objects.get(pathname)?.etag) return error(412, 'precondition_failed');
      if (client?.maximumSizeInBytes !== undefined && bytes.length > client.maximumSizeInBytes) return error(400, 'bad_request', 'the file length cannot be greater than the maximum');
      uploadsWithClientToken += client ? 1 : 0;
      objects.set(pathname, { etag: String(++version), bytes, contentType: headers['x-content-type'] ?? 'application/octet-stream' });
      return json(200, { url: `${BLOB_CONTENT}/${pathname}`, pathname, contentType: headers['x-content-type'] });
    }
    if (method === 'POST' && route === '/signed-token') {
      const body = JSON.parse(String(init.body)) as { operations?: string[]; validUntil?: number; pathname?: string };
      const payload = b64url(new TextEncoder().encode(JSON.stringify({ storeId: token.split('_')[3], operations: body.operations ?? ['get'], validUntil: Math.min(body.validUntil ?? Infinity, Date.now() + (options.maxDelegationMs ?? 3_600_000)), ...(body.pathname ? { pathname: body.pathname } : {}) })));
      const delegationToken = `${payload}.${await hmac(token, payload)}`;
      const clientSigningToken = `signing-${Math.random().toString(36).slice(2)}`;
      delegations.set(delegationToken, clientSigningToken);
      return json(200, { delegationToken, clientSigningToken });
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
    /** How many objects arrived with a client token (straight from a publisher) rather than the store's token. */
    clientUploads: () => uploadsWithClientToken,
    /** How many reads were made with a presigned URL (no token). */
    presignedReads: () => presignedReads,
    /** How many delegations were issued. */
    delegationsIssued: () => delegations.size,
    /** The options that point a store at this fake (its content host is the default one, so it is not given). */
    options: { token, apiUrl: BLOB_API, sleep: async () => {} }
  };
}
