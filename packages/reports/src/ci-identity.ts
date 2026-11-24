/**
 * @module CI identity tokens (trusted publishing, client side)
 *
 * In GitHub Actions with `permissions: id-token: write`, a job can ask GitHub for a short-lived OIDC token that says which
 * repository, branch and workflow it is. An Atlas server that trusts the repository accepts that token instead of a publish
 * token, so CI publishes with no secret at all. `ciIdentity` returns a source of such tokens, addressed to one server (the
 * token's audience is the server's origin, so it is useless anywhere else) and renewed shortly before each expires; it
 * returns `null` outside a CI that offers one. A token is never printed.
 *
 * @see docs/server.md#trusted-publishing
 */

type Env = Readonly<Record<string, string | undefined>>;

/** A source of identity tokens for one server: the current one, fetched or renewed when needed. */
export type IdentitySource = { (): Promise<string>; /** Where the tokens come from, for people: `GitHub Actions OIDC`. */ readonly label: string };

/** Seconds since the epoch at which a JWT expires, or 0 when it cannot be read. */
function expiryOf(token: string): number {
  try {
    const part = token.split('.')[1]!;
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))) as { exp?: number };
    return Number(claims.exp) || 0;
  } catch {
    return 0;
  }
}

/**
 * Identity tokens addressed to `serverUrl` from the CI this runs in, or `null` when it offers none (not in GitHub Actions,
 * or the workflow did not grant `id-token: write`). The source throws when GitHub refuses to mint one.
 *
 * @example
 * const identity = ciIdentity('https://atlas.example.com', process.env);
 * const bearer = identity ? await identity() : process.env.ATLAS_TOKEN;
 */
export function ciIdentity(serverUrl: string, env: Env, options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {}): IdentitySource | null {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return null;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const audience = new URL(serverUrl).origin;
  let current: { token: string; exp: number } | null = null;
  let pending: Promise<string> | null = null;
  const source = (async () => {
    // Renew a minute early, so a token never expires on its way to the server.
    if (current && current.exp * 1000 - now() > 60_000) return current.token;
    pending ??= (async () => {
      const url = new URL(requestUrl);
      url.searchParams.set('audience', audience);
      const response = await doFetch(url, { headers: { authorization: `bearer ${requestToken}`, accept: 'application/json' } });
      if (!response.ok) throw new Error(`GitHub Actions did not issue an identity token for ${audience} (HTTP ${response.status}). Check the job has permissions: id-token: write.`);
      const { value } = await response.json() as { value?: string };
      if (!value) throw new Error('GitHub Actions answered without an identity token.');
      current = { token: value, exp: expiryOf(value) };
      return value;
    })().finally(() => { pending = null; });
    return pending;
  }) as IdentitySource;
  Object.defineProperty(source, 'label', { value: 'GitHub Actions OIDC' });
  return source;
}

/**
 * What to send as the bearer to an Atlas server: the given token when there is one, else a CI identity token for
 * `serverUrl` when the CI offers one, else nothing. For clients that make their own requests (the live reporter, the
 * runner upload); `httpStore` takes the source itself.
 */
export async function bearerFor(serverUrl: string, token: string | undefined, env: Env = typeof process === 'undefined' ? {} : process.env): Promise<string | undefined> {
  if (token) return token;
  const key = `${new URL(serverUrl).origin}|${env.ACTIONS_ID_TOKEN_REQUEST_URL ?? ''}`;
  sources ??= new Map();
  let identity = sources.get(key);
  if (identity === undefined) { identity = ciIdentity(serverUrl, env); sources.set(key, identity); }
  return identity ? identity() : undefined;
}
/** One renewing source per server, so a reporter that sends many requests asks GitHub once per token lifetime. */
let sources: Map<string, IdentitySource | null> | undefined;
