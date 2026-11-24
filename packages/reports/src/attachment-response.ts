/**
 * @module Serving attachment bytes safely
 *
 * Builds the HTTP response for an attachment's bytes. A producer chose the media type, and the bytes come from a
 * test run, so they are treated as untrusted: never sniffed, never allowed to run scripts, never embedded by
 * another site. Videos can be sought (HTTP range requests). Every route that serves attachment bytes must go
 * through here (or add {@link UNTRUSTED_HEADERS}); it never reads from a store itself.
 *
 * The one exception to "through the server" is decided here too, by {@link storeRedirect}: a large recording a browser
 * plays or downloads may be sent straight from the store (a `302` to a URL that works for a few minutes), when the store
 * can sign one and the stored media type is one that cannot run (video, audio, a zip). It is served from the store's own
 * origin, never this one, so it can reach nothing of Atlas's.
 *
 * @see docs/report-contract.md (evidence rule 8)
 */
import { canSign, type ObjectStore } from './object-store';

/**
 * Headers for bytes that came from a test run: never sniffed (`nosniff`), a sandboxing content-security policy so a
 * page navigated to at this address runs locked down, and `cross-origin-resource-policy: same-origin` so
 * another site cannot embed it. Spread these into every response that serves attachment or recorded bytes.
 */
export const UNTRUSTED_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  // If a page is ever navigated to or framed from this address, it runs as a locked-down document.
  'content-security-policy': "sandbox; default-src 'none'; img-src data:; media-src 'self'; style-src 'unsafe-inline'",
  'cross-origin-resource-policy': 'same-origin'
};

/**
 * Answers a request for one attachment's bytes with the untrusted-bytes headers, long-lived immutable caching
 * and range support.
 *
 * The producer's `contentType` is used only when it is a well-formed media type (`type/subtype` with simple
 * parameters); anything else is served as `application/octet-stream`. A matching `if-none-match` answers 304.
 * A single `bytes=a-b`, `bytes=a-` or `bytes=-n` range answers 206, an unsatisfiable one 416; multiple ranges are
 * not understood and get the whole body (200).
 *
 * @param etag A strong validator the caller derives from content identity (it is sent as given, so include the quotes).
 */
export function attachmentResponse(request: Request, entry: { readonly bytes: Uint8Array; readonly contentType: string }, etag: string): Response {
  // A media type is a short token list; anything with line breaks or odd characters is not one.
  const type = /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.-]+=[\w.\-"]+)*$/.test(entry.contentType) ? entry.contentType : 'application/octet-stream';
  const headers: Record<string, string> = {
    'content-type': type,
    ...UNTRUSTED_HEADERS,
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    etag
  };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const size = entry.bytes.length;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  if (!range || (range[1] === '' && range[2] === '')) return new Response(entry.bytes as BodyInit, { headers: { ...headers, 'content-length': String(size) } });
  // `bytes=-500` is the last 500 bytes; `bytes=500-` is from 500 on.
  const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  return new Response(entry.bytes.slice(start, end + 1) as BodyInit, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
}

/**
 * Media types that may be sent from the store's origin instead of through the server: recordings and archives, which a
 * browser plays or saves and never runs. Not HTML, SVG, XML, scripts, PDF, images (screenshots are small) or unknown bytes.
 */
const REDIRECTABLE = /^(?:video|audio)\/[\w.+-]+$|^application\/(?:zip|x-zip-compressed)$/;

/** Is this stored media type one a browser may be sent to the store for? Parameters (`; codecs=…`) are ignored. */
export function redirectableType(contentType: string): boolean {
  return REDIRECTABLE.test(contentType.split(';')[0]!.trim().toLowerCase());
}

/** How long a download URL from {@link storeRedirect} works, in seconds. A player that seeks later asks Atlas again. */
export const REDIRECT_SECONDS = 300;

/**
 * A `302` to a short-lived URL of `key` in `store`, or `null` to serve the bytes through the server as usual. Call it only
 * after the caller's role was checked: it is answered only when the store can sign URLs (`SignedDownloads`), the object
 * exists, its stored media type is {@link redirectableType}, and the request is a browser playing or downloading it
 * (`sec-fetch-dest` of `video`, `audio` or `document`). A script's `fetch` (which would need the store to allow this
 * origin) and a client that is not a browser always get the bytes from the server. The answer is never cached
 * (`private, no-store`) and sends no referrer. A store that fails to sign is answered `null`, not an error.
 *
 * @example
 * const redirect = await storeRedirect(request, store, `layers/runs/${id}/clip.webm`);
 * if (redirect) return redirect;
 */
export async function storeRedirect(request: Request, store: ObjectStore, key: string): Promise<Response | null> {
  if (!canSign(store) || !['video', 'audio', 'document'].includes(request.headers.get('sec-fetch-dest') ?? '')) return null;
  const signed = await store.signedUrl(key, { expiresInSeconds: REDIRECT_SECONDS }).catch(() => null);
  if (!signed || !redirectableType(signed.contentType)) return null;
  return new Response(null, { status: 302, headers: { location: signed.url, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', vary: 'authorization, cookie, sec-fetch-dest' } });
}
