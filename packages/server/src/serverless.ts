/**
 * @module Serverless handler (`@crvouga/atlas/server/serverless`)
 *
 * The Atlas server as one `(Request) => Promise<Response>` for a host that runs functions instead of a process, such as
 * Vercel. Configuration comes from the environment exactly as for `atlas serve` (storage, tokens, trusted publishers),
 * and the differences of a function host are handled here:
 *
 * - Nothing runs between requests, so nothing relies on a timer: a request looks at the store when the last look is older
 *   than the refresh interval, and `GET /api/cron` does the scheduled work (garbage collection when a policy is due).
 * - Any number of instances may run: everything is in the store, and an instance only caches it.
 * - Request bodies are small, so large files go straight to storage (Vercel Blob) and the server checks them after.
 * - Responses are billed by the second, so a browser playing a run's recording is sent to the store with a five-minute URL.
 * - Requests have a maximum duration, so live streams end on their own before it and viewers reconnect.
 * - A server with neither tokens nor trusted publishers would let anyone administer it, so it refuses to serve.
 *
 * A configuration problem is answered as a 503 page that names every variable to set (never a value), so whoever opens a
 * fresh deployment sees what is missing.
 *
 * @see docs/deploying.md#vercel
 */

import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { createAtlasServer, type AtlasServer } from './app';
import { ConfigError, loadServerConfig, type ResolvedServerConfig } from './config';
import { connectStorage, serverOptionsOf } from './main';
import { storedSettings } from './settings';
import { S3ConfigError } from './storage';
import { USER_STATE_KEY, userStateStore } from './user-state';

type Env = Readonly<Record<string, string | undefined>>;

/** What a function host's handler is built from. Everything is optional: by default the environment and the working directory of the function. */
export type AtlasHandlerOptions = {
  /** The configuration: the same variables as `atlas serve`. Default `process.env`. */
  readonly env?: Env;
  /** Where a configuration file and the built viewer (`atlas-site`) are looked for. Default `process.cwd()`. */
  readonly cwd?: string;
  /** The built viewer, served at `/`. Default `ATLAS_SITE`, then `./atlas-site` when it exists, else the API only. */
  readonly site?: string;
  /** The `fetch` storage requests are sent with; for tests. */
  readonly fetch?: typeof fetch;
  /** Where log lines go. Default one JSON line per entry on standard output when the configuration's `log` is on. */
  readonly log?: (line: Record<string, unknown>) => void;
};

/** A function host's request handler, and, for tests and embedding, the server once it has started. */
export type AtlasHandler = ((request: Request) => Promise<Response>) & { readonly server: () => Promise<AtlasServer | null> };

/** Request bodies a function host accepts are about 4.5 MB: anything larger than this goes straight to storage. */
const DEFAULT_DIRECT_UPLOAD_OVER = 4 * 1024 * 1024;
/** Most function hosts end a request after five minutes; streams end before that. */
const DEFAULT_STREAM_SECONDS = 240;
/** Where a rewrite that sends every path to one function puts the path the browser asked for. */
const PATH_PARAM = '__atlas_path';

function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const problemPage = (text: string) => new Response(text, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/**
 * The Atlas server as a function: storage, tokens and trusted publishers from the environment, the viewer from `atlas-site`.
 * The server starts on the first request of each instance and is kept for the rest; a start that failed is tried again on
 * the next request.
 *
 * @example
 * // api/atlas.ts in a Vercel project
 * import { createAtlasHandler } from '@crvouga/atlas/server/serverless';
 * const handle = createAtlasHandler();
 * export const GET = handle, POST = handle, PUT = handle, DELETE = handle, HEAD = handle, PATCH = handle, OPTIONS = handle;
 */
export function createAtlasHandler(options: AtlasHandlerOptions = {}): AtlasHandler {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  let starting: Promise<{ readonly server: AtlasServer; readonly config: ResolvedServerConfig } | { readonly failure: string }> | null = null;

  async function start() {
    let config: ResolvedServerConfig;
    try {
      config = loadServerConfig([], env, cwd);
    } catch (error) {
      if (error instanceof S3ConfigError || error instanceof ConfigError) return { failure: error.message };
      throw error;
    }
    if (!config.tokens.length && !config.trustedPublishers.length && !config.insecure) {
      return { failure: 'Atlas will not serve without tokens: anyone could administer it. Set ATLAS_TOKEN to a long random admin token (openssl rand -hex 24), and ATLAS_READ_TOKEN for people who only look (or ATLAS_ANONYMOUS_READ=1).\n' };
    }
    // Proven usable (list, write, read back, delete) before anything is served, as `atlas serve` does: a wrong token or a
    // public Blob store is named on the page, not discovered at the first upload.
    const connected = await connectStorage(config, env, options.fetch ? { fetch: options.fetch } : {});
    if ('failure' in connected) return { failure: connected.failure };
    const { backends, stored } = connected;
    const users = userStateStore(backends[0]!.store);
    if (stored.state.settings) {
      try {
        config = loadServerConfig([], env, cwd, undefined, stored.state.settings);
      } catch (error) {
        if (error instanceof ConfigError) return { failure: `The settings saved in ${USER_STATE_KEY} do not work with this deployment: ${error.message}\n` };
        throw error;
      }
    }
    const log = options.log ?? (config.log ? (line: Record<string, unknown>) => console.log(JSON.stringify(line)) : undefined);
    const site = options.site ?? env.ATLAS_SITE ?? (existsSync(path.join(cwd, 'atlas-site', 'index.html')) ? path.join(cwd, 'atlas-site') : undefined);
    const { settings, gc } = storedSettings(config, [], env, cwd, users);
    const number = (value: string | undefined, fallback: number) => (value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
    const server = createAtlasServer({
      settings, gc, ...serverOptionsOf(config, backends, log, options.fetch), ...(site ? { site } : {}),
      refreshOnRequestMs: config.refreshSeconds * 1000,
      // Instances come and go: keep the checkpoint close behind, so the next one starts from it.
      checkpointEveryMs: 30_000,
      streamMaxMs: number(env.ATLAS_STREAM_MAX_SECONDS, DEFAULT_STREAM_SECONDS) * 1000,
      directUploadOverBytes: number(env.ATLAS_DIRECT_UPLOAD_OVER_BYTES, DEFAULT_DIRECT_UPLOAD_OVER),
      // Recordings a browser plays come from the store, not through the function (ATLAS_REDIRECT_DOWNLOADS=0 to keep them in).
      redirectDownloads: env.ATLAS_REDIRECT_DOWNLOADS !== '0' && env.ATLAS_REDIRECT_DOWNLOADS !== 'false'
    });
    await server.ready;
    return { server, config };
  }

  const handle = (async (request: Request): Promise<Response> => {
    const started = await (starting ??= start().catch(error => ({ failure: `Atlas could not start: ${error instanceof Error ? error.message : String(error)}\n` })));
    if ('failure' in started) {
      // Try again next time: the variable may have been set, or the storage may be back.
      starting = null;
      return problemPage(started.failure);
    }
    const url = new URL(request.url);
    // A host rewrite that sends every path to this one function passes the path it was asked for.
    const asked = url.searchParams.get(PATH_PARAM);
    if (asked !== null) {
      url.pathname = asked.startsWith('/') ? asked : `/${asked}`;
      url.searchParams.delete(PATH_PARAM);
      request = new Request(url, request);
    }
    if (url.pathname === '/api/cron') return cron(request, started.server, started.config);
    return started.server.fetch(request);
  }) as AtlasHandler;

  /** The scheduled pass, for the host's scheduler: with `CRON_SECRET` (which Vercel Cron sends) or the admin token. */
  async function cron(request: Request, server: AtlasServer, config: ResolvedServerConfig): Promise<Response> {
    const header = request.headers.get('authorization') ?? '';
    const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const secrets = [env.CRON_SECRET?.trim(), ...config.tokens.filter(token => token.role === 'admin').map(token => token.token)].filter((value): value is string => Boolean(value));
    if (!presented || !secrets.some(secret => same(secret, presented))) {
      return Response.json({ error: 'The scheduled pass needs CRON_SECRET (Vercel Cron sends it) or the admin token, as Authorization: Bearer.' }, { status: 401, headers: { 'cache-control': 'no-store' } });
    }
    const result = await server.maintain!();
    return Response.json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store' } });
  }

  Object.defineProperty(handle, 'server', { value: async () => {
    const started = await (starting ??= start());
    return 'server' in started ? started.server : null;
  } });
  return handle;
}
