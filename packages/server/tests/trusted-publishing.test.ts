/**
 * Trusted publishing: CI identity tokens signed like GitHub Actions signs them (RS256, a published key set), verified by the
 * server against an allowlist, and fetched by the CLI the way a GitHub Actions job asks for one.
 */
import { describe, expect, test } from 'bun:test';

import { combineBackends } from '../../reports/src/compose';
import { publishChecks } from '../../reports/src/publish-checks';
import { openStore } from '../../reports/src/store-url';
import { memoryStore } from '../../reports/tests/memory-store';
import { createAtlasServer } from '../src/app';
import { loadServerConfig } from '../src/config';
import { describeRule, GITHUB_ISSUER, parsePublisherRules, PINS_KEY, publisherRulesOf, TrustedPublishers } from '../src/trusted-publishing';
import { S3_TEST_ENV } from './fake-s3';

const HOST = 'atlas.example.com';
const SERVER = `https://${HOST}`;
const JWKS = 'https://keys.test/jwks';

const encode = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** A signing key like GitHub's, its key set behind a fake `fetch`, and a way to mint tokens with any claims. */
async function issuer() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  let keyFetches = 0;
  const fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === JWKS) { keyFetches += 1; return Response.json({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }); }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const mint = async (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => {
    const head = encode({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...header });
    const body = encode({ iss: GITHUB_ISSUER, aud: SERVER, repository: 'acme/web', repository_owner: 'acme', repository_owner_id: 1001, ref: 'refs/heads/main', iat: nowSeconds, nbf: nowSeconds, exp: nowSeconds + 300, ...claims });
    const signature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`))).toString('base64url');
    return `${head}.${body}.${signature}`;
  };
  return { fetch, mint, keyFetches: () => keyFetches };
}

const trustFor = (rules: string, fetch: typeof globalThis.fetch, store = memoryStore()) => new TrustedPublishers({ rules: parsePublisherRules(rules), store, fetch, jwksUrl: JWKS });
const failure = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message);

describe('the allowlist', () => {
  test('names owners, repositories and refs; anything else is refused by name', () => {
    expect(parsePublisherRules('github:Acme, github:other/web@refs/heads/main').map(describeRule)).toEqual(['github:acme', 'github:other/web@refs/heads/main']);
    expect(parsePublisherRules('none')).toEqual([]);
    expect(() => parsePublisherRules('acme')).toThrow('"acme"');
    expect(() => parsePublisherRules('github:acme@refs/heads/main')).toThrow('without a repository');
  });

  test('defaults to the GitHub owner the platform deployed the server from', () => {
    expect(publisherRulesOf({ VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'acme' }).rules.map(describeRule)).toEqual(['github:acme']);
    expect(publisherRulesOf({ RAILWAY_GIT_REPO_OWNER: 'acme' }).rules.map(describeRule)).toEqual(['github:acme']);
    expect(publisherRulesOf({ VERCEL_GIT_PROVIDER: 'gitlab', VERCEL_GIT_REPO_OWNER: 'acme' }).rules).toEqual([]);
    expect(publisherRulesOf({ ATLAS_TRUSTED_PUBLISHERS: 'none', VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'acme' }).rules).toEqual([]);
    expect(publisherRulesOf({}).rules).toEqual([]);
  });

  test('is part of the server configuration, and a bad entry stops the server', () => {
    expect(loadServerConfig([], { ...S3_TEST_ENV, VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'acme' }, '/w', () => '{}').trustedPublishers.map(describeRule)).toEqual(['github:acme']);
    expect(() => loadServerConfig([], { ...S3_TEST_ENV, ATLAS_TRUSTED_PUBLISHERS: 'acme' }, '/w', () => '{}')).toThrow('ATLAS_TRUSTED_PUBLISHERS');
    // Trusted publishers say who may upload, so the server may listen publicly with them and no tokens.
    expect(loadServerConfig(['--host', '0.0.0.0'], { ...S3_TEST_ENV, ATLAS_TRUSTED_PUBLISHERS: 'github:acme' }, '/w', () => '{}').host).toBe('0.0.0.0');
  });
});

describe('verifying a CI identity token', () => {
  test('a token GitHub signed for this server, from a trusted repository, is that repository', async () => {
    const github = await issuer();
    const identity = await trustFor('github:acme', github.fetch).verify(await github.mint(), [HOST]);
    expect(identity).toMatchObject({ name: 'github:acme/web', repository: 'acme/web', ref: 'refs/heads/main' });
  });

  test('every way a token can be wrong is refused, saying which', async () => {
    const github = await issuer();
    const trust = trustFor('github:acme/web@refs/heads/main', github.fetch);
    const now = Math.floor(Date.now() / 1000);
    const token = await github.mint();
    const [head, body] = token.split('.');
    expect(await failure(trust.verify(`${head}.${body}.${encode('forged')}`, [HOST]))).toContain('signature');
    expect(await failure(trust.verify(`${head}.${encode({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), repository: 'acme/other' })}.${token.split('.')[2]}`, [HOST]))).toContain('signature');
    expect(await failure(trust.verify(await github.mint({ exp: now - 120 }), [HOST]))).toContain('expired');
    expect(await failure(trust.verify(await github.mint({ nbf: now + 600 }), [HOST]))).toContain('not valid yet');
    expect(await failure(trust.verify(await github.mint({ iss: 'https://gitlab.com' }), [HOST]))).toContain('issuer');
    expect(await failure(trust.verify(await github.mint({ aud: 'https://evil.example.com' }), [HOST]))).toContain('audience');
    expect(await failure(trust.verify(await github.mint({ repository: 'acme/api' }), [HOST]))).toContain('not a trusted publisher');
    expect(await failure(trust.verify(await github.mint({ ref: 'refs/heads/feature' }), [HOST]))).toContain('not a trusted publisher');
    expect(await failure(trust.verify(await github.mint({ repository: 'evil/web', repository_owner: 'evil' }), [HOST]))).toContain('not a trusted publisher');
    expect(await failure(trust.verify(await github.mint({}, { alg: 'none' }), [HOST]))).toContain('algorithm');
    expect(await failure(trust.verify(await github.mint({}, { kid: 'other' }), [HOST]))).toContain('unknown signing key');
  });

  test('an owner trusted by name is pinned to its numeric id: a recycled name is someone else', async () => {
    const github = await issuer();
    const store = memoryStore();
    await trustFor('github:acme', github.fetch, store).verify(await github.mint(), [HOST]);
    expect(JSON.parse(new TextDecoder().decode(await new Response((await store.get(PINS_KEY))!.body).arrayBuffer()))).toEqual({ 'github:acme': 1001 });
    // Another instance, starting fresh, reads the pin from the store.
    const later = trustFor('github:acme', github.fetch, store);
    expect(await failure(later.verify(await github.mint({ repository_owner_id: 6666 }), [HOST]))).toContain('trusted id 1001');
    expect((await later.verify(await github.mint(), [HOST])).name).toBe('github:acme/web');
  });

  test('the signing keys are fetched once and kept', async () => {
    const github = await issuer();
    const trust = trustFor('github:acme', github.fetch);
    for (let i = 0; i < 3; i++) await trust.verify(await github.mint(), [HOST]);
    expect(github.keyFetches()).toBe(1);
  });
});

describe('a server with trusted publishers', () => {
  const TOKENS = [{ name: 'admin', role: 'admin' as const, token: 'admin-token-123456' }];

  async function serve(rules = 'github:acme') {
    const github = await issuer();
    const store = memoryStore();
    const server = createAtlasServer({ backends: [{ id: 'data', store }], write: 'data', tokens: TOKENS, trust: trustFor(rules, github.fetch, store), refreshMs: 60_000 });
    await server.ready;
    return { github, store, server };
  }
  const put = (server: { fetch: (request: Request) => Promise<Response> }, bearer: string, key = 'layers/doctor-x/probe.txt') =>
    server.fetch(new Request(`${SERVER}/api/store/${key}`, { method: 'PUT', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'text/plain' }, body: 'atlas' }));

  test('CI publishes with its identity token and no secret; the token may read, as a publish token may, and nothing more', async () => {
    const { github, server } = await serve();
    const token = await github.mint();
    expect((await put(server, token)).status).toBeLessThan(300);
    const who = await (await server.fetch(new Request(`${SERVER}/api/server`, { headers: { authorization: `Bearer ${token}` } }))).json() as { role: string };
    expect(who.role).toBe('publish');
    const admin = await server.fetch(new Request(`${SERVER}/api/settings`, { headers: { authorization: `Bearer ${token}` } }));
    expect(admin.status).toBe(403);
    server.close();
  });

  test('an untrusted repository, a token for another server, and garbage are all refused', async () => {
    const { github, server } = await serve();
    expect((await put(server, await github.mint({ repository: 'evil/web', repository_owner: 'evil', repository_owner_id: 9 }))).status).toBe(401);
    expect((await put(server, await github.mint({ aud: 'https://other.example.com' }))).status).toBe(401);
    expect((await put(server, 'a.b.c')).status).toBe(401);
    server.close();
  });

  test('the CLI in GitHub Actions publishes without ATLAS_TOKEN, asking GitHub for a token addressed to the server', async () => {
    const { github, store, server } = await serve('github:acme/web');
    const audiences: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host === 'actions.test') {
        expect(new Headers(init?.headers).get('authorization')).toBe('bearer runtime-request-token');
        audiences.push(url.searchParams.get('audience')!);
        return Response.json({ value: await github.mint({ aud: url.searchParams.get('audience') }) });
      }
      return server.fetch(new Request(url, init));
    }) as unknown as typeof globalThis.fetch;
    const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.test/token?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-request-token' };
    const opened = openStore(SERVER, { base: '/w', env, fetch });
    await publishChecks(opened.store, { producer: 'ci', environment: 'web', recordedAtMs: 5, checks: [{ id: 'a', title: 'a', status: 'passed' }] });
    expect(audiences.length).toBe(1);
    expect(audiences[0]).toBe(SERVER);
    expect((await combineBackends([{ id: 'r', store }])).summary.checks).toMatchObject({ passed: 1 });
    server.close();
  });

  test('outside CI, with no token, the CLI sends nothing and is told how to publish', async () => {
    const { server } = await serve();
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) => server.fetch(new Request(String(input), init))) as unknown as typeof globalThis.fetch;
    const opened = openStore(SERVER, { base: '/w', env: {}, fetch });
    const message = await failure(opened.store.put('layers/doctor-x/probe.txt', new TextEncoder().encode('x'), 'text/plain'));
    expect(message).toContain('id-token: write');
    server.close();
  });
});
