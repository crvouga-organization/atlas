/**
 * @module Authentication and roles
 *
 * Who is asking, and may they. Tokens have a role (`read` < `critic` < `publish` < `admin`) and are compared in constant time. Reading
 * accepts a Bearer token or the browser's sign-in box (any user name, the token as the password); changing anything needs
 * the Bearer header, because a browser sends the sign-in box's credentials to any page that asks, which would let another
 * site upload with them. A CI job may also present an OIDC identity token of a trusted publisher (`trusted-publishing.ts`),
 * which may publish and nothing more. A server with no tokens and no trusted publishers is open, and refuses to listen
 * beyond this machine unless told it may.
 */

import { timingSafeEqual } from 'node:crypto';

import type { ServerRole } from '../../schema/src/server-config';
import type { ResolvedToken } from './config';
import type { TrustedPublishers } from './trusted-publishing';

const RANK: Readonly<Record<ServerRole, number>> = { read: 1, critic: 2, publish: 3, admin: 4 };

/** Who a request is: the token's `name` (never the token), its `role`, and how it was presented (`bearer`, `basic`, or `none` for an open server or an anonymous reader). */
export type Identity = {
  readonly name: string;
  readonly role: ServerRole;
  /** `bearer` for a token in a header, `basic` for the browser's sign-in box, `oidc` for a trusted publisher's identity token, `none` for a server with no tokens. */
  readonly via: 'bearer' | 'basic' | 'oidc' | 'none';
};

/** The answer to "may this request do that": allowed with the identity, or refused with the status to answer (`401` no or unknown token, `403` a known token that may not) and a message that says what to do. */
export type Verdict =
  | { readonly ok: true; readonly identity: Identity }
  | { readonly ok: false; readonly status: 401 | 403; readonly message: string };

function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Who is asking, and may they. A server with no tokens is open (and refuses to listen beyond this machine
 * unless told it may). With tokens, every request must carry one, except where `anonymousRead` lets anyone look.
 *
 * Changing anything needs a token in an `Authorization: Bearer` header, never the browser's sign-in box: the
 * browser sends that box's credentials on its own to any page that asks, which would let another site upload
 * with them.
 */
export function createAuth(tokens: readonly ResolvedToken[], anonymousRead: boolean, trust?: TrustedPublishers) {
  const open = tokens.length === 0 && !trust?.enabled;
  function identify(request: Request): Identity | null {
    if (open) return { name: 'open', role: 'admin', via: 'none' };
    const header = request.headers.get('authorization') ?? '';
    const lower = header.toLowerCase();
    let presented: string | null = null;
    let via: Identity['via'] = 'bearer';
    if (lower.startsWith('bearer ')) presented = header.slice(7).trim();
    else if (lower.startsWith('basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      presented = decoded.slice(decoded.indexOf(':') + 1);
      via = 'basic';
    }
    if (presented) {
      const found = tokens.find(token => same(token.token, presented!));
      if (found) return { name: found.name, role: found.role, via };
      // Verified by `prepare` before the request reached here; a token that did not verify is no one.
      const publisher = via === 'bearer' ? trust?.identityOf(presented) : null;
      if (publisher) return { name: publisher.name, role: 'publish', via: 'oidc' };
    }
    return anonymousRead ? { name: 'anonymous', role: 'read', via: 'none' } : null;
  }

  function check(request: Request, need: ServerRole): Verdict {
    const identity = identify(request);
    if (!identity) return { ok: false, status: 401, message: 'A token is needed. Send it as Authorization: Bearer <token>, or sign in with it as the password.' };
    // Someone who showed no token is asked for one; someone whose token is too small is told so.
    if (identity.name === 'anonymous' && need !== 'read') return { ok: false, status: 401, message: 'A token is needed to upload. Send it as Authorization: Bearer <token>.' };
    if (RANK[identity.role] < RANK[need]) return { ok: false, status: 403, message: `This token is "${identity.role}" and this needs "${need}".` };
    if (need !== 'read' && identity.via === 'basic') return { ok: false, status: 403, message: 'Uploading needs the token in an Authorization: Bearer header.' };
    return { ok: true, identity };
  }

  /** Verify a trusted publisher's identity token, if the request carries one, so `identify` and `check` know it. Call before them. */
  const prepare = (request: Request): Promise<void> => trust ? trust.prepare(request, value => tokens.some(token => same(token.token, value))) : Promise.resolve();

  return { identify, check, prepare, open };
}

/** The authentication of one server: `identify` (who is this), `check` (may they, for a needed role) and `open` (the server has no tokens). */
export type Auth = ReturnType<typeof createAuth>;
