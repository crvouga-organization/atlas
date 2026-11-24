/** @module Settings page
 * The administrator's React and Mantine entry point. A built site carries it prebuilt (`admin/settings.js` and
 * `admin/settings.css`, written by `atlas client build`), which is what a server without Bun's bundler (a Node function)
 * serves; otherwise it is bundled lazily with Bun, for API-only servers too. Credentials remain in page memory; the
 * settings API owns authorization and validation.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { visualizerRoot } from './site';

/** Document shell for the shared React settings UI. No configuration or credentials are embedded. */
export const SETTINGS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Settings · Atlas</title><!-- atlas-admin-styles --></head><body><div id="root"><h1>Atlas server settings</h1><p>Loading settings interface…</p></div><!-- atlas-admin-script --></body></html>`;
/** The page, once made, by the site it was read from (`''` for the one Bun bundled). */
const pages = new Map<string, Promise<string>>();
/** What `/admin` shows where there is neither a prebuilt settings page nor Bun's bundler to build one. */
const SETTINGS_ON_NODE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Settings · Atlas</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1>Atlas server settings</h1><p>This server has no prebuilt settings page (build the site with <code>atlas client build</code>) and runs without Bun's bundler, so the page cannot be built here. Settings come from environment variables (see <a href="/llms.txt">/llms.txt</a>), and the garbage collection policy is saved with the admin token through the API: <code>PUT /api/settings/gc</code> (see <a href="/api/openapi.json">/api/openapi.json</a>).</p></body></html>`;

/** The page shell with one stylesheet and one module script in it; a closing tag inside either cannot end it early. */
function assemble(js: readonly string[], css: readonly string[]): string {
  return SETTINGS_PAGE.replace(
    '<!-- atlas-admin-styles -->',
    () => `<style>${css.join('\n').replaceAll('</style', '<\\/style')}</style>`
  ).replace('<!-- atlas-admin-script -->', () => `<script type="module">${js.join('\n').replaceAll('</script', '<\\/script')}</script>`);
}

/** Where a built site keeps the prebuilt settings page, relative to the site. */
export const PREBUILT_SETTINGS = { script: 'admin/settings.js', styles: 'admin/settings.css' } as const;

/**
 * Render the settings UI with the same provider and theme as the viewer. With a built `site` that carries the prebuilt
 * page (`atlas client build` writes it), that page, read once; otherwise bundled with Bun once on first request; on a
 * runtime with neither, a page that says how to change settings without it. No configuration data, no import-time work,
 * and a failed build can be retried.
 * @example
 * const html = await renderSettingsPage(options.site);
 */
export function renderSettingsPage(site?: string): Promise<string> {
  const prebuilt = site && existsSync(path.join(site, PREBUILT_SETTINGS.script)) ? path.resolve(site) : '';
  let page = pages.get(prebuilt);
  if (page) return page;
  page = (async () => {
    if (prebuilt) {
      const [js, css] = await Promise.all([readFile(path.join(prebuilt, PREBUILT_SETTINGS.script), 'utf8'), readFile(path.join(prebuilt, PREBUILT_SETTINGS.styles), 'utf8').catch(() => '')]);
      return assemble([js], css ? [css] : []);
    }
    // Without a prebuilt page, Bun bundles it at first request. On another runtime say what to do instead of failing.
    if (typeof Bun === 'undefined') return SETTINGS_ON_NODE;
    const root = visualizerRoot();
    if (!root) throw new Error('The Atlas client is not installed alongside the server.');
    const result = await Bun.build({ entrypoints: [path.join(root, 'src/admin/main.tsx')], target: 'browser', minify: true });
    if (!result.success) throw new Error(`The settings interface could not be built: ${result.logs.join('\n')}`);
    const js = await Promise.all(result.outputs.filter((output) => output.path.endsWith('.js')).map((output) => output.text()));
    const css = await Promise.all(result.outputs.filter((output) => output.path.endsWith('.css')).map((output) => output.text()));
    return assemble(js, css);
  })().catch((error) => {
    pages.delete(prebuilt);
    throw error;
  });
  pages.set(prebuilt, page);
  return page;
}
