/**
 * Where `/admin` comes from: the page a built site carries (what a server without Bun's bundler serves), else one Bun
 * bundles at first request. Either way it is the same shell with one stylesheet and one module script, and the same
 * protective headers.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { memoryStore } from '../../reports/tests/memory-store';
import { createAtlasServer } from '../src/app';
import { PREBUILT_SETTINGS, renderSettingsPage } from '../src/settings-page';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A built site with a prebuilt settings page whose script and styles hold markers (and a closing tag that must not end the page). */
function builtSite(): string {
  const site = mkdtempSync(path.join(tmpdir(), 'atlas-settings-site-'));
  dirs.push(site);
  writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><head></head><body>viewer</body></html>');
  mkdirSync(path.join(site, 'admin'));
  writeFileSync(path.join(site, PREBUILT_SETTINGS.script), 'console.log("prebuilt-settings-marker", "</script>");');
  writeFileSync(path.join(site, PREBUILT_SETTINGS.styles), 'body{--prebuilt-settings-style:1}');
  return site;
}

describe('the settings page', () => {
  test('a built site serves its prebuilt page, without bundling anything at runtime', async () => {
    const html = await renderSettingsPage(builtSite());
    expect(html).toContain('<title>Settings · Atlas</title>');
    expect(html).toContain('<script type="module">console.log("prebuilt-settings-marker", "<\\/script>");</script>');
    expect(html).toContain('<style>body{--prebuilt-settings-style:1}</style>');
    expect(html).not.toContain('<!-- atlas-admin-script -->');
  });

  test('a site without one falls back to Bun bundling the page (the real interface, not the fallback text)', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'atlas-settings-empty-'));
    dirs.push(empty);
    const html = await renderSettingsPage(empty);
    expect(html).not.toContain('prebuilt-settings-marker');
    expect(html).toContain('<script type="module">');
    expect(html).not.toContain('has no prebuilt settings page');
  }, 60_000);

  test('/admin serves the site\'s prebuilt page with the protective headers', async () => {
    const site = builtSite();
    const server = createAtlasServer({ backends: [{ id: 'data', store: memoryStore() }], write: 'data', site, tokens: [{ name: 'admin', role: 'admin', token: 'admin-token-123456' }], refreshMs: 60_000 });
    await server.ready;
    const response = await server.fetch(new Request('http://localhost/admin', { headers: { authorization: 'Bearer admin-token-123456' } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain('prebuilt-settings-marker');
    server.close();
  });
});
