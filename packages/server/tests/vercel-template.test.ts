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
    expect(vercel.functions['api/atlas.ts']?.includeFiles).toBe('atlas-site/**');
    expect(pkg.scripts.build).toBe('atlas client build --no-data --out atlas-site');
    expect(pkg.dependencies['@crvouga/atlas']).toMatch(/^\^1\./);
  });

  test('every path reaches the function with the path it asked for, and the cron path is the scheduled pass', async () => {
    expect(vercel.rewrites).toEqual([{ source: '/(.*)', destination: '/api/atlas?__atlas_path=/$1' }]);
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
