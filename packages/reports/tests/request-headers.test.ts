import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { uploadChecks } from '../../runners/src/publish';
import { httpStore } from '../src/http-store';
import { reportMain, runReportCommand } from '../src/report-cli';
import { atlasHeaders, parseHeaders } from '../src/request-headers';
import { openStore } from '../src/store-url';

const SECRET = 's3cr3t-bypass-value';
const SECOND = 'an0ther-value';

/** A server behind a platform's sign-in: without the bypass header it answers the platform's HTML sign-in page. */
function protectedServer(options: { signIn: 'html' | 'redirect' } = { signIn: 'html' }) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    seen.push({ url, headers });
    if (headers['x-vercel-protection-bypass'] !== SECRET) {
      if (options.signIn === 'redirect') {
        const page = new Response('<html>Log in to Vercel</html>', { status: 200, headers: { 'content-type': 'text/html' } });
        Object.defineProperties(page, { redirected: { value: true }, url: { value: 'https://vercel.com/login?next=x' } });
        return page;
      }
      return new Response('<!doctype html><title>Authentication Required</title>', { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    const { pathname } = new URL(url);
    if (pathname === '/api/server') return Response.json({ role: 'publish' });
    if (pathname === '/api/store' || pathname === '/api/status') return Response.json({ keys: [], next: null });
    if (init.method === 'HEAD') return new Response(null, { status: 404 });
    if (init.method === 'GET') return new Response(null, { status: 404 });
    if (pathname === '/api/checks') return Response.json({ ok: true });
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

describe('ATLAS_HEADERS', () => {
  test('is name=value entries separated by commas or new lines; a value may contain =', () => {
    expect(parseHeaders('x-a=1,x-b=2')).toEqual({ 'x-a': '1', 'x-b': '2' });
    expect(parseHeaders(' X-Vercel-Protection-Bypass = abc== \n cf-access-client-id=id.access ')).toEqual({ 'x-vercel-protection-bypass': 'abc==', 'cf-access-client-id': 'id.access' });
    expect(atlasHeaders({})).toEqual({});
    expect(atlasHeaders({ ATLAS_HEADERS: '  ' })).toEqual({});
  });

  test('a malformed entry is named by position and name, and its value is never printed', () => {
    const failure = (text: string) => { try { parseHeaders(text); return ''; } catch (error) { return (error as Error).message; } };
    expect(failure(`x-a=1,${SECRET}`)).toContain('entry 2 of 2 is not name=value');
    expect(failure(`x-a=1,${SECRET}`)).not.toContain(SECRET);
    expect(failure(`bad name=${SECRET}`)).toContain('entry 1 of 1 does not start with a header name');
    expect(failure('x-a=')).toContain('("x-a") has no value');
    expect(failure(`authorization=Bearer ${SECRET}`)).toContain('header Atlas sets itself');
    expect(failure(`x-a=1,X-A=${SECRET}`)).toContain('repeats');
    for (const text of [`x-a=1,${SECRET}`, `bad name=${SECRET}`, `authorization=Bearer ${SECRET}`, `x-a=1,X-A=${SECRET}`]) expect(failure(text)).not.toContain(SECRET);
  });

  test('both headers go on every request a CLI store makes, values never in its label or errors', async () => {
    const server = protectedServer();
    const env = { ATLAS_HEADERS: `x-vercel-protection-bypass=${SECRET},x-b=${SECOND}`, ATLAS_TOKEN: 'publish-token' };
    const opened = openStore('https://atlas.example.com', { base: '/w', env, fetch: server.fetch });
    await opened.store.put('layers/x.json', new TextEncoder().encode('{}'), 'application/json');
    await opened.store.head('layers/x.json');
    await opened.store.get('layers/x.json');
    await opened.store.listKeys('layers/');
    await opened.server!.ping();
    await opened.server!.forProject('web').head('layers/x.json');
    await opened.server!.call('POST', '/ui-catalog/claims', { json: {}, accept: [204] });
    expect(server.seen.length).toBe(7);
    for (const request of server.seen) expect(request.headers).toMatchObject({ 'x-vercel-protection-bypass': SECRET, 'x-b': SECOND, authorization: 'Bearer publish-token' });
    expect(opened.server!.headerNames).toEqual(['x-vercel-protection-bypass', 'x-b']);
    expect(opened.label).not.toContain(SECRET);
  });

  test('a store opened from a malformed ATLAS_HEADERS fails before sending anything', () => {
    expect(() => openStore('https://atlas.example.com', { base: '/w', env: { ATLAS_HEADERS: 'nonsense' } })).toThrow('ATLAS_HEADERS entry 1 of 1');
  });
});

describe('a server behind a sign-in', () => {
  test('an HTML sign-in page says so and names ATLAS_HEADERS, instead of a JSON parse error', async () => {
    for (const signIn of ['html', 'redirect'] as const) {
      const server = protectedServer({ signIn });
      const store = httpStore({ url: 'https://atlas.example.com', token: 't', headers: {}, fetch: server.fetch, sleep: async () => {} });
      const error = await store.put('layers/x.json', new TextEncoder().encode('{}'), 'application/json').then(() => null, (caught: Error) => caught);
      expect(error?.message).toContain('the host asked for sign-in before Atlas was reached');
      expect(error?.message).toContain('ATLAS_HEADERS');
      // A sign-in page is not a failure a retry can fix.
      expect(server.seen.length).toBe(1);
      expect((await store.ping()).error).toContain('sign-in');
    }
  });

  test('with a wrong bypass value, the message names the header it sent, never the value', async () => {
    const server = protectedServer();
    const store = httpStore({ url: 'https://atlas.example.com', headers: { 'x-vercel-protection-bypass': 'wrong-value' }, fetch: server.fetch, sleep: async () => {} });
    const ping = await store.ping();
    expect(ping.error).toContain('x-vercel-protection-bypass');
    expect(ping.error).not.toContain('wrong-value');
  });

  test('a stored HTML object is still an object, not a sign-in page', async () => {
    const fetch = (async () => new Response('<html>a report page</html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const store = httpStore({ url: 'https://atlas.example.com', headers: {}, fetch });
    expect(await new Response((await store.get('layers/blobs/page.html'))!.body).text()).toContain('a report page');
  });
});

describe('the atlas report commands', () => {
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  let dir = '';
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const name of ['ATLAS_HEADERS', 'ATLAS_STORE', 'ATLAS_TOKEN', 'ATLAS_SERVER_URL']) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const checksFile = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'atlas-headers-'));
    const file = path.join(dir, 'checks.json');
    writeFileSync(file, JSON.stringify({ checks: [{ id: 'a', title: 'a', status: 'passed' }] }));
    return file;
  };

  test('publish to a server behind a sign-in without ATLAS_HEADERS exits non-zero, naming the sign-in', async () => {
    const file = checksFile();
    globalThis.fetch = protectedServer().fetch;
    const failure = await reportMain(['publish', '--store', 'https://atlas.example.com', '--producer', 'ci', '--checks', file], { out: () => {}, env: { ATLAS_TOKEN: 't' }, cwd: dir }).then(() => '', (error: Error) => error.message);
    expect(failure).toContain('the host asked for sign-in before Atlas was reached: set ATLAS_HEADERS');
  });

  test('publish with ATLAS_HEADERS gets past the sign-in', async () => {
    const file = checksFile();
    const server = protectedServer();
    globalThis.fetch = server.fetch;
    const out: string[] = [];
    expect(await reportMain(['publish', '--store', 'https://atlas.example.com', '--producer', 'ci', '--checks', file], { out: line => { out.push(line); }, env: { ATLAS_TOKEN: 't', ATLAS_HEADERS: `x-vercel-protection-bypass=${SECRET}` }, cwd: dir })).toBe(0);
    expect(server.seen.length).toBeGreaterThan(0);
    expect(server.seen.every(request => request.headers['x-vercel-protection-bypass'] === SECRET)).toBe(true);
    expect(out.join('')).not.toContain(SECRET);
  });

  test('a malformed ATLAS_HEADERS exits 2 and says which entry is wrong', async () => {
    const file = checksFile();
    process.env.ATLAS_HEADERS = `x-a=1,${SECRET}`;
    const errors: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((text: string) => { errors.push(text); return true; }) as typeof process.stderr.write;
    try {
      expect(await runReportCommand(['publish', '--store', 'https://atlas.example.com', '--producer', 'ci', '--checks', file])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(errors.join('')).toContain('ATLAS_HEADERS entry 2 of 2 is not name=value');
    expect(errors.join('')).not.toContain(SECRET);
  });

  test('doctor names the headers and says the server was reached past the sign-in', async () => {
    globalThis.fetch = protectedServer().fetch;
    const out: string[] = [];
    await reportMain(['doctor', '--store', 'https://atlas.example.com', '--role', 'reader'], { out: line => { out.push(line); }, env: { ATLAS_TOKEN: 't', ATLAS_HEADERS: `x-vercel-protection-bypass=${SECRET}` }, cwd: '/' });
    expect(out.join('')).toContain("past the host's sign-in with ATLAS_HEADERS (x-vercel-protection-bypass)");
    expect(out.join('')).not.toContain(SECRET);
  });

  test('the runner reporter sends ATLAS_HEADERS with its upload', async () => {
    const server = protectedServer();
    globalThis.fetch = server.fetch;
    process.env.ATLAS_HEADERS = `x-vercel-protection-bypass=${SECRET}`;
    await uploadChecks('mocha', [{ id: 'a', title: 'a', status: 'passed' }], { url: 'https://atlas.example.com', token: 't' });
    expect(server.seen[0]!.headers['x-vercel-protection-bypass']).toBe(SECRET);
  });
});
