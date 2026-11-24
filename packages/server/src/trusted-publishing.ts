/**
 * @module Trusted publishing (CI identity by OIDC)
 *
 * CI uploads results without any secret: a GitHub Actions job asks GitHub for a short-lived OIDC ID token addressed to this
 * server, and the server checks GitHub's signature, the audience (this server's origin), the expiry, and that the repository
 * is on an allowlist. The allowlist is `ATLAS_TRUSTED_PUBLISHERS` (`github:acme`, `github:acme/web`,
 * `github:acme/web@refs/heads/main`); when it is not set and the server was deployed from a GitHub repository (Vercel and
 * Railway say which), every repository of that repository's owner is trusted. An owner trusted by name is pinned to its
 * numeric GitHub id the first time it publishes (kept in the store), so a renamed or re-registered name cannot inherit
 * the trust. A trusted publisher has the publish role, like a publish token: it may upload and read (so a CI gate needs no
 * secret either); critiquing settings and administering still need tokens.
 *
 * Verification is asynchronous (the signing keys are fetched and cached), the role checks are not: `prepare` verifies a
 * request's token once and remembers the identity until the token expires, and `identityOf` answers from that memory.
 *
 * @see docs/server.md#trusted-publishing
 */

import { readUtf8, writeUtf8 } from '../../reports/src/object-io';
import type { ObjectStore } from '../../reports/src/object-store';

type Env = Readonly<Record<string, string | undefined>>;

/** GitHub Actions' token issuer. */
export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS = `${GITHUB_ISSUER}/.well-known/jwks`;
/** Where owner pins are kept, beside the other server state. */
export const PINS_KEY = 'server/trusted-publishers.json';
/** Clock skew allowed on `exp`, `nbf` and `iat`, in seconds. */
const SKEW = 60;

/** One allowlist entry: an owner, or one repository, optionally only from one git ref. */
export type PublisherRule = { readonly provider: 'github'; readonly owner: string; readonly repo: string | null; readonly ref: string | null };

/** Who a verified token says it is: `name` is `github:owner/repo`, never the token. */
export type PublisherIdentity = { readonly name: string; readonly repository: string; readonly ref: string; readonly expiresAtMs: number };

/**
 * Parses `ATLAS_TRUSTED_PUBLISHERS`: entries separated by commas, spaces or new lines, each `github:<owner>`,
 * `github:<owner>/<repo>` or `github:<owner>/<repo>@<ref>` (such as `@refs/heads/main`). `none` alone trusts nobody.
 * Throws an error naming the entry that is not one of these.
 *
 * @example
 * parsePublisherRules('github:acme, github:other/web@refs/heads/main');
 */
export function parsePublisherRules(text: string): readonly PublisherRule[] {
  const entries = text.split(/[\s,]+/).filter(Boolean);
  if (entries.length === 1 && entries[0]!.toLowerCase() === 'none') return [];
  return entries.map(entry => {
    const match = /^github:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9._-]{1,100}))?(?:@(\S+))?$/.exec(entry);
    if (!match) throw new Error(`ATLAS_TRUSTED_PUBLISHERS entry "${entry}" is not github:<owner>, github:<owner>/<repo> or github:<owner>/<repo>@<ref>`);
    if (match[3] && !match[2]) throw new Error(`ATLAS_TRUSTED_PUBLISHERS entry "${entry}" names a ref without a repository: write github:<owner>/<repo>@<ref>`);
    return { provider: 'github', owner: match[1]!.toLowerCase(), repo: match[2]?.toLowerCase() ?? null, ref: match[3] ?? null };
  });
}

/**
 * The allowlist this deployment uses, and where it came from: `ATLAS_TRUSTED_PUBLISHERS` when set; otherwise the owner of
 * the GitHub repository the platform deployed it from (`VERCEL_GIT_REPO_OWNER` with `VERCEL_GIT_PROVIDER=github`, or
 * `RAILWAY_GIT_REPO_OWNER`); otherwise nobody. Throws as {@link parsePublisherRules} does.
 */
export function publisherRulesOf(env: Env): { readonly rules: readonly PublisherRule[]; readonly source: string } {
  const given = env.ATLAS_TRUSTED_PUBLISHERS?.trim();
  if (given) return { rules: parsePublisherRules(given), source: 'ATLAS_TRUSTED_PUBLISHERS' };
  const vercel = env.VERCEL_GIT_PROVIDER === 'github' ? env.VERCEL_GIT_REPO_OWNER?.trim() : undefined;
  const owner = vercel || env.RAILWAY_GIT_REPO_OWNER?.trim();
  if (owner) return { rules: parsePublisherRules(`github:${owner}`), source: `the GitHub owner this server was deployed from (${vercel ? 'VERCEL_GIT_REPO_OWNER' : 'RAILWAY_GIT_REPO_OWNER'})` };
  return { rules: [], source: 'nothing: set ATLAS_TRUSTED_PUBLISHERS to let CI publish without a token' };
}

/** A human line for one rule: `github:acme/web@refs/heads/main`. */
export const describeRule = (rule: PublisherRule) => `github:${rule.owner}${rule.repo ? `/${rule.repo}` : ''}${rule.ref ? `@${rule.ref}` : ''}`;

const decoder = new TextDecoder();
const base64url = (part: string) => Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')), char => char.charCodeAt(0));
const json = (part: string): Record<string, unknown> | null => { try { const value = JSON.parse(decoder.decode(base64url(part))); return value && typeof value === 'object' ? value : null; } catch { return null; } };

/** Does a bearer value look like a JWT (three base64url parts)? */
export const looksLikeJwt = (value: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) && value.length < 16_384;

type Jwk = JsonWebKey & { kid?: string };

/** What `TrustedPublishers` is given: the allowlist, the store that keeps owner pins, and, for tests, `fetch`, the clock and the issuer's key URL. */
export type TrustedPublishersOptions = {
  readonly rules: readonly PublisherRule[];
  /** Where owner pins are kept (`server/trusted-publishers.json`). Without one, owners are matched by name only. */
  readonly store?: ObjectStore;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly jwksUrl?: string;
  /**
   * The URLs this server is published at (`ATLAS_PUBLIC_URL`). When given, a token must be addressed to one of them;
   * otherwise to the host the request arrived on. Set it when the server can be reached without a platform's router in
   * front, where a caller chooses the Host header.
   */
  readonly audiences?: readonly string[];
  readonly log?: (line: Record<string, unknown>) => void;
};

/**
 * Verifies CI identity tokens against an allowlist. One instance is shared by every part of a server, so a token verified
 * once is known everywhere until it expires.
 *
 * @example
 * const trust = new TrustedPublishers({ rules: publisherRulesOf(process.env).rules, store });
 * await trust.prepare(request);            // before the synchronous role checks
 * const who = trust.identityOf(bearer);    // PublisherIdentity | null
 */
export class TrustedPublishers {
  /** The allowlist this instance checks against. */
  readonly rules: readonly PublisherRule[];
  readonly #store: ObjectStore | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #jwksUrl: string;
  readonly #log: ((line: Record<string, unknown>) => void) | undefined;
  readonly #audiences: readonly string[] | undefined;
  readonly #verified = new Map<string, PublisherIdentity>();
  #keys: { at: number; keys: Map<string, CryptoKey> } | null = null;
  #fetchingKeys: Promise<Map<string, CryptoKey>> | null = null;
  #pins: Record<string, number> | null = null;

  constructor(options: TrustedPublishersOptions) {
    this.rules = options.rules;
    this.#store = options.store;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#jwksUrl = options.jwksUrl ?? GITHUB_JWKS;
    this.#log = options.log;
    this.#audiences = options.audiences?.map(url => new URL(url).host.toLowerCase());
  }

  /** Is anyone trusted at all? */
  get enabled(): boolean {
    return this.rules.length > 0;
  }

  /** The identity of a token verified earlier and not yet expired, or `null`. */
  identityOf(token: string): PublisherIdentity | null {
    const found = this.#verified.get(token);
    if (!found) return null;
    if (found.expiresAtMs <= this.#now()) { this.#verified.delete(token); return null; }
    return found;
  }

  /**
   * Verify the bearer token of a request if it is a JWT this server has not seen, and remember who it is. Never throws:
   * a token that fails is simply not an identity, and the role check refuses it. `staticTokens` are skipped (they are
   * Atlas's own tokens, not identity tokens).
   */
  async prepare(request: Request, isStaticToken: (value: string) => boolean = () => false): Promise<void> {
    if (!this.enabled) return;
    const header = request.headers.get('authorization') ?? '';
    if (!header.toLowerCase().startsWith('bearer ')) return;
    const token = header.slice(7).trim();
    if (!looksLikeJwt(token) || this.identityOf(token) || isStaticToken(token)) return;
    try {
      const identity = await this.verify(token, this.#audiences ?? [new URL(request.url).host.toLowerCase()]);
      if (identity) {
        if (this.#verified.size >= 1024) this.#verified.delete(this.#verified.keys().next().value!);
        this.#verified.set(token, identity);
      }
    } catch (error) {
      this.#log?.({ level: 'warn', trustedPublishing: 'rejected', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Who a GitHub Actions ID token says it is, if its signature, issuer, audience, times and repository all check out;
   * otherwise throws an error saying which did not. `hosts` are the hosts this server answers on; the token's audience
   * must be a URL on one of them (the scheme is not compared: a TLS proxy forwards plain HTTP).
   */
  async verify(token: string, hosts: readonly string[]): Promise<PublisherIdentity> {
    const [head, body, signature] = token.split('.') as [string, string, string];
    const header = json(head);
    const claims = json(body);
    if (!header || !claims) throw new Error('not a JWT');
    if (header.alg !== 'RS256') throw new Error(`unsupported algorithm ${String(header.alg)}`);
    if (claims.iss !== GITHUB_ISSUER) throw new Error(`issuer ${String(claims.iss)} is not GitHub Actions`);
    const key = await this.#key(String(header.kid ?? ''));
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64url(signature), new TextEncoder().encode(`${head}.${body}`));
    if (!valid) throw new Error('signature does not verify');
    const nowSeconds = this.#now() / 1000;
    const exp = Number(claims.exp), nbf = Number(claims.nbf ?? claims.iat ?? 0);
    if (!Number.isFinite(exp) || exp + SKEW < nowSeconds) throw new Error('token expired');
    if (nbf - SKEW > nowSeconds) throw new Error('token not valid yet');
    const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)];
    const hostOf = (value: string) => { try { return new URL(value).host.toLowerCase(); } catch { return null; } };
    if (!aud.some(value => hosts.includes(hostOf(value) ?? ''))) throw new Error(`audience ${aud.join(', ')} is not this server (${hosts.join(', ')})`);
    const repository = String(claims.repository ?? '').toLowerCase();
    const owner = String(claims.repository_owner ?? '').toLowerCase();
    const ownerId = Number(claims.repository_owner_id);
    const ref = String(claims.ref ?? '');
    if (!repository.includes('/') || !owner || !Number.isSafeInteger(ownerId)) throw new Error('token has no repository');
    const repo = repository.slice(repository.indexOf('/') + 1);
    const rule = this.rules.find(item => item.owner === owner && (item.repo === null || item.repo === repo) && (item.ref === null || item.ref === ref));
    if (!rule) throw new Error(`${repository}${ref ? `@${ref}` : ''} is not a trusted publisher`);
    await this.#checkPin(owner, ownerId);
    return { name: `github:${repository}`, repository, ref, expiresAtMs: exp * 1000 };
  }

  /** The owner's numeric id must be the one first seen under that name: a recycled name is someone else. */
  async #checkPin(owner: string, ownerId: number): Promise<void> {
    if (!this.#store) return;
    const pins = this.#pins ??= await readUtf8(this.#store, PINS_KEY).then(text => (text ? JSON.parse(text) : {}) as Record<string, number>, (): Record<string, number> => ({}));
    const pinned = pins[`github:${owner}`];
    if (pinned === ownerId) return;
    if (pinned !== undefined) throw new Error(`github:${owner} is now owner id ${ownerId}, but this server trusted id ${pinned} under that name; if the account really changed, remove it from ${PINS_KEY}`);
    // Read again before writing, so a pin written meanwhile by another instance is kept.
    const fresh = await readUtf8(this.#store, PINS_KEY).then(text => (text ? JSON.parse(text) : {}) as Record<string, number>, (): Record<string, number> => ({}));
    if (fresh[`github:${owner}`] !== undefined && fresh[`github:${owner}`] !== ownerId) { this.#pins = fresh; return this.#checkPin(owner, ownerId); }
    this.#pins = { ...fresh, [`github:${owner}`]: ownerId };
    await writeUtf8(this.#store, PINS_KEY, `${JSON.stringify(this.#pins, null, 2)}\n`, 'application/json');
    this.#log?.({ level: 'info', trustedPublishing: 'pinned', owner: `github:${owner}`, ownerId });
  }

  async #key(kid: string): Promise<CryptoKey> {
    const cached = this.#keys;
    const fresh = cached && this.#now() - cached.at < 3_600_000;
    if (fresh && cached.keys.has(kid)) return cached.keys.get(kid)!;
    // An unknown key may be a rotation: look again, but not more than once a minute.
    if (!cached || !fresh || this.#now() - cached.at > 60_000) {
      this.#fetchingKeys ??= this.#loadKeys().finally(() => { this.#fetchingKeys = null; });
      const keys = await this.#fetchingKeys;
      if (keys.has(kid)) return keys.get(kid)!;
    }
    throw new Error(`unknown signing key ${kid}`);
  }

  async #loadKeys(): Promise<Map<string, CryptoKey>> {
    const response = await this.#fetch(this.#jwksUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`could not read GitHub's signing keys (HTTP ${response.status})`);
    const { keys = [] } = await response.json() as { keys?: Jwk[] };
    const map = new Map<string, CryptoKey>();
    for (const jwk of keys) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      map.set(jwk.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    this.#keys = { at: this.#now(), keys: map };
    return map;
  }
}
