/**
 * @module Extra headers for an Atlas server behind a sign-in
 *
 * A server hosted behind a platform's sign-in (Vercel Deployment Protection, Cloudflare Access, an identity-aware proxy)
 * only lets a machine through with that platform's own header, beside Atlas's token. `ATLAS_HEADERS` names those
 * headers once (`name=value`, separated by commas or new lines) and every client that talks to an Atlas server sends
 * them. Their values are secrets: nothing here ever prints one, not even when an entry is malformed.
 *
 * @see docs/deploying.md#a-server-behind-a-sign-in
 */

type Env = Readonly<Record<string, string | undefined>>;

/** What an HTTP header name may be made of (RFC 9110 `token`). */
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers Atlas sets itself, so `ATLAS_HEADERS` may not replace them. */
const RESERVED = new Set(['authorization', 'content-type', 'content-length', 'host', 'x-atlas-project']);

/**
 * Parses an `ATLAS_HEADERS` value: `name=value` entries separated by commas or new lines; spaces around each are
 * ignored, and a value may itself contain `=`. Names are lower-cased.
 *
 * Throws an error that names the entry by its position (and its name, when it has one), never its value, when an
 * entry has no `=`, an empty name or value, a name that is not a valid header name, a name Atlas sets itself
 * (`authorization`, `content-type`, `content-length`, `host`, `x-atlas-project`), or a name given twice.
 *
 * @example
 * parseHeaders('x-vercel-protection-bypass=abc123'); // { 'x-vercel-protection-bypass': 'abc123' }
 */
export function parseHeaders(text: string): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  const entries = text.split(/[\n,]/).map(entry => entry.trim()).filter(Boolean);
  entries.forEach((entry, i) => {
    const at = `ATLAS_HEADERS entry ${i + 1} of ${entries.length}`;
    const split = entry.indexOf('=');
    // Without `=`, the entry may be nothing but a secret: name only its position.
    if (split < 0) throw new Error(`${at} is not name=value. Write ATLAS_HEADERS='x-header-name=value', several separated by commas.`);
    const name = entry.slice(0, split).trim().toLowerCase();
    const value = entry.slice(split + 1).trim();
    if (!NAME.test(name)) throw new Error(`${at} does not start with a header name. Write ATLAS_HEADERS='x-header-name=value', several separated by commas.`);
    if (!value) throw new Error(`${at} ("${name}") has no value.`);
    if (/[\0\r\n]/.test(value)) throw new Error(`${at} ("${name}") has a control character in its value.`);
    if (RESERVED.has(name)) throw new Error(`${at} ("${name}") is a header Atlas sets itself. Put the Atlas token in ATLAS_TOKEN.`);
    if (name in headers) throw new Error(`${at} ("${name}") repeats a header given earlier.`);
    headers[name] = value;
  });
  return headers;
}

/**
 * The extra headers to send to an Atlas server, from `ATLAS_HEADERS` in `env`; empty when it is not set. Throws as
 * {@link parseHeaders} does for a malformed value, so a command fails before it sends anything.
 *
 * @example
 * const headers = atlasHeaders(process.env);
 */
export function atlasHeaders(env: Env): Readonly<Record<string, string>> {
  const text = env.ATLAS_HEADERS;
  return text && text.trim() ? parseHeaders(text) : {};
}

/** `ATLAS_HEADERS` from the process environment, where there is one (not in a browser). */
export function processHeaders(): Readonly<Record<string, string>> {
  return typeof process === 'undefined' || !process.env ? {} : atlasHeaders(process.env);
}

/**
 * Did a request meant for an Atlas server get a platform's sign-in page instead? True when the request was redirected to
 * another origin (a sign-in host), or the answer is HTML where Atlas answers JSON (`expectJson`), or a 401 or 403 that is
 * HTML (Atlas refuses in JSON). Reads only the status, headers and final URL, never the body.
 */
export function isSignInPage(response: Response, requested: string, expectJson: boolean): boolean {
  const html = (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
  if (response.redirected && response.url) {
    try {
      if (new URL(response.url).origin !== new URL(requested).origin) return true;
    } catch {
      // An unparsable final URL says nothing.
    }
  }
  if (response.status === 401 || response.status === 403) return html;
  return expectJson && response.ok && html;
}

/** What to say when {@link isSignInPage} is true: the host's sign-in stopped the request before Atlas saw it. */
export function signInMessage(base: string, headers: Readonly<Record<string, string>>): string {
  const sent = Object.keys(headers);
  return `${base} answered with a sign-in page: the host asked for sign-in before Atlas was reached: `
    + (sent.length
      ? `ATLAS_HEADERS sent ${sent.join(', ')}, which the host did not accept. Check its value (a protection bypass secret, an access service token).`
      : 'set ATLAS_HEADERS to the header the host lets machines through with, such as ATLAS_HEADERS=\'x-vercel-protection-bypass=<secret>\'.');
}
