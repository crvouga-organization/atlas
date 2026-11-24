/** @module Settings page
 * The administrator's React and Mantine entry point, bundled lazily for API-only servers too.
 * Credentials remain in page memory; the settings API owns authorization and validation.
 */
import path from 'node:path';
import { visualizerRoot } from './site';

/** Document shell for the shared React settings UI. No configuration or credentials are embedded. */
export const SETTINGS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Settings · Atlas</title><!-- atlas-admin-styles --></head><body><div id="root"><h1>Atlas server settings</h1><p>Loading settings interface…</p></div><!-- atlas-admin-script --></body></html>`;
let page: Promise<string> | undefined;
/** What `/admin` shows where Bun's bundler is not available to build the settings interface. */
const SETTINGS_ON_NODE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Settings · Atlas</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1>Atlas server settings</h1><p>This server runs on a runtime without Bun's bundler, so the settings page cannot be built here. Settings come from environment variables (see <a href="/llms.txt">/llms.txt</a>), and the garbage collection policy is saved with the admin token through the API: <code>PUT /api/settings/gc</code> (see <a href="/api/openapi.json">/api/openapi.json</a>).</p></body></html>`;
/**
 * Render the settings UI with the same provider and theme as the viewer. Bundle once on first request,
 * without a prebuilt viewer, CDN, configuration data, or import-time work. A failed build can be retried.
 * @example
 * const html = await renderSettingsPage();
 */
export function renderSettingsPage(): Promise<string> {
  page ??= (async () => {
    // The page is bundled with Bun's bundler at first request. On another runtime (a Node serverless function) say what to do instead of failing.
    if (typeof Bun === 'undefined') return SETTINGS_ON_NODE;
    const root = visualizerRoot();
    if (!root) throw new Error('The Atlas client is not installed alongside the server.');
    const result = await Bun.build({ entrypoints: [path.join(root, 'src/admin/main.tsx')], target: 'browser', minify: true });
    if (!result.success) throw new Error(`The settings interface could not be built: ${result.logs.join('\n')}`);
    const js = await Promise.all(result.outputs.filter((output) => output.path.endsWith('.js')).map((output) => output.text()));
    const css = await Promise.all(result.outputs.filter((output) => output.path.endsWith('.css')).map((output) => output.text()));
    return SETTINGS_PAGE.replace(
      '<!-- atlas-admin-styles -->',
      () => `<style>${css.join('\n').replaceAll('</style', '<\\/style')}</style>`
    ).replace('<!-- atlas-admin-script -->', () => `<script type="module">${js.join('\n').replaceAll('</script', '<\\/script')}</script>`);
  })().catch((error) => {
    page = undefined;
    throw error;
  });
  return page;
}
