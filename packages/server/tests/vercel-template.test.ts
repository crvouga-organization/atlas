/**
 * The Vercel template (`examples/deploy/vercel`) holds no Atlas logic, so what can go wrong is the wiring: the function's
 * import, the rewrite that sends every path to it, the cron path, what it lets people do. These hold it to the code.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '../../../examples/deploy/vercel');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => statSync(path.join(dir, name)).isDirectory() ? files(path.join(dir, name)) : [path.join(dir, name)]);

describe('the Vercel template', () => {
  const vercel = JSON.parse(read('vercel.json')) as { functions: Record<string, { includeFiles?: string; maxDuration?: number }>; rewrites: { source: string; destination: string }[]; crons: { path: string }[] };
  const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; scripts: Record<string, string> };

  test('never ships ATLAS_INSECURE: a platform sign-in everyone passes is no reason to make everyone an admin', () => {
    for (const file of files(root)) expect(readFileSync(file, 'utf8'), path.relative(root, file)).not.toContain('ATLAS_INSECURE');
  });

  test('its one function imports the serverless entry point the package exports, and ships the built viewer', () => {
    expect(read('api/atlas.ts')).toContain("from '@crvouga/atlas/server/serverless'");
    const exported = JSON.parse(readFileSync(path.resolve(import.meta.dir, '../../../package.json'), 'utf8')) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(exported.exports['./server/serverless']).toBeDefined();
    expect(exported.publishConfig.exports['./server/serverless']).toBeDefined();
    expect(vercel.functions['api/atlas.ts']?.includeFiles).toBe('public/admin/**');
    expect(pkg.scripts.build).toBe('atlas client build --no-data --out public --api-base /api');
    expect(pkg.dependencies['@crvouga/atlas']).toMatch(/^\^1\./);
  });

  test('every path reaches the function with the path it asked for, and the cron path is the scheduled pass', async () => {
    expect(vercel.rewrites).toContainEqual({ source: '/api/:path*', destination: '/api/atlas?__atlas_path=/api/:path*' });
    expect(vercel.rewrites.at(-1)?.destination).toBe('/index.html');
    expect(vercel.crons.map(cron => cron.path)).toEqual(['/api/cron']);
    // Hobby plans allow one run a day: a more frequent schedule would fail the deployment.
    expect(vercel.crons.every(cron => /^\d+ \d+ \* \* \*$/.test((cron as unknown as { schedule: string }).schedule))).toBe(true);
  });

  test('the function module loads and answers; unconfigured, with what to set', async () => {
    const saved = { ...process.env };
    for (const name of Object.keys(process.env)) if (/^(ATLAS_|BLOB_|VERCEL_|RAILWAY_)/.test(name)) delete process.env[name];
    // Inside this repository the template's own package.json hides the package name: load a copy that names the source.
    const dir = mkdtempSync(path.join(tmpdir(), 'atlas-vercel-template-'));
    const copy = path.join(dir, 'atlas.ts');
    writeFileSync(copy, read('api/atlas.ts').replace("'@crvouga/atlas/server/serverless'", JSON.stringify(path.resolve(import.meta.dir, '../src/serverless.ts'))));
    try {
      const module = await import(copy) as Record<string, (request: Request) => Promise<Response>>;
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) expect(typeof module[method]).toBe('function');
      const response = await module.GET!(new Request('https://atlas.example.com/api/atlas?__atlas_path=/'));
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('ATLAS CANNOT START');
    } finally {
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('the template build serves a deep link and its assets beside the Blob-backed API and cron routes', async () => {
  const { fakeVercelBlob, BLOB_API, BLOB_TOKEN } = await import('../../reports/tests/fake-vercel-blob');
  const { createAtlasHandler } = await import('../src/serverless');
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-vercel-site-'));
  const token = 'template-test-publisher';
  const blob = fakeVercelBlob();
  const instance = () => createAtlasHandler({ env: { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN, VERCEL_BLOB_API_URL: BLOB_API, ATLAS_TOKEN: token },
    cwd: dir, site: path.join(dir, 'public'), fetch: blob.fetch });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return instance()(request);
    const file = url.pathname.startsWith('/assets/') ? url.pathname : '/index.html';
    return new Response(Bun.file(path.join(dir, 'public', file)));
  } });
  try {
    const args = JSON.parse(read('package.json')).scripts.build.split(' ').slice(1);
    const build = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../../core/bin/atlas.mjs'), ...args], { cwd: dir, stdout: 'ignore', stderr: 'pipe' });
    const [code, errors] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    expect(code, errors).toBe(0);
    const html = await (await fetch(new URL('/tests', server.url))).text();
    expect(html).not.toContain('window.__ATLAS_CONFIG__');
    const asset = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
    expect(asset).toBeTruthy();
    expect((await (await fetch(new URL(asset!, server.url))).arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const publish = await fetch(new URL('/api/checks', server.url), { method: 'POST', headers,
      body: JSON.stringify({ producer: 'template', checks: [{ id: 'smoke', title: 'Smoke', status: 'passed' }] }) });
    expect(publish.ok).toBe(true);
    expect(await (await fetch(new URL('/api/reports/evidence/effective', server.url), { headers })).text()).toContain('Smoke');
    for (const job of ['gc', 'maintain']) expect((await fetch(new URL(`/api/cron/${job}`, server.url), { headers })).ok).toBe(true);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
