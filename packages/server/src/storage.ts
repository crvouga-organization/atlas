/**
 * @module Required object storage configuration
 *
 * The Atlas server keeps ALL reports and ALL user state (the garbage collection policy and saved settings) in object
 * storage, and nowhere else: no local folder, no memory, no database. That storage is an S3-compatible bucket
 * (`ATLAS_S3_*`) or a private Vercel Blob store (`BLOB_READ_WRITE_TOKEN`); `resolveStorage` picks one from
 * `ATLAS_STORAGE`, or, when that is unset, uses Blob only if a Blob token is the only storage configured. The settings are
 * required, come only from environment variables (they hold secrets), and have no defaults for where or as whom to
 * connect. Every variable is checked in one pass and all problems are reported together; `startupFailure` renders them
 * as a banner that cannot be missed. `S3_VARIABLES` and `BLOB_VARIABLES` are the single description of the variables:
 * the banner, `.env.example` and the documentation are made from them.
 *
 * @see docs/server.md#required-s3-storage
 */
import { blobStoreIdOf } from '../../reports/src/vercel-blob-store';

type Env = Readonly<Record<string, string | undefined>>;

/** One environment variable of the storage configuration. */
export type S3Variable = {
  readonly name: string;
  readonly required: boolean;
  /** Shown in the banner and the documentation. Never a real secret. */
  readonly meaning: string;
  readonly example: string;
  /** Secrets are never printed, not even when invalid. */
  readonly secret?: true;
  /** Returns what is wrong with a value that is set, or null when it is fine. */
  readonly check: (value: string) => string | null;
};

const hostOf = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must start with https:// (or http:// for a local S3 server)';
    if (url.username || url.password) return 'must not contain a user name or password; credentials have their own variables';
    if (url.search || url.hash) return 'must be just the address, with no query or fragment';
    return null;
  } catch {
    return 'is not a URL; write it like https://s3.eu-west-1.amazonaws.com';
  }
};

/** Every variable that configures storage, required ones first. */
export const S3_VARIABLES: readonly S3Variable[] = [
  { name: 'ATLAS_S3_ENDPOINT', required: true, meaning: 'S3 API endpoint of the object storage service', example: 'https://s3.eu-west-1.amazonaws.com', check: hostOf },
  { name: 'ATLAS_S3_BUCKET', required: true, meaning: 'Bucket that holds reports and user state; it must already exist', example: 'my-atlas-reports',
    check: value => (/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) ? null : 'must be 3-63 lowercase letters, digits, dots or hyphens, starting and ending with a letter or digit') },
  { name: 'ATLAS_S3_REGION', required: true, meaning: 'Region of the bucket (`auto` for Cloudflare R2, `us-east-1` for most self-hosted servers)', example: 'eu-west-1',
    check: value => (/^[a-z0-9][a-z0-9-]*$/.test(value) ? null : 'must be lowercase letters, digits and hyphens, like eu-west-1') },
  { name: 'ATLAS_S3_ACCESS_KEY_ID', required: true, meaning: 'Access key id of an account that may list, read, write and delete in the bucket', example: 'AKIAEXAMPLE', secret: true,
    check: value => (/^\S+$/.test(value) ? null : 'must not contain spaces or line breaks') },
  { name: 'ATLAS_S3_SECRET_ACCESS_KEY', required: true, meaning: 'Secret key that goes with the access key id', example: 'change-me', secret: true,
    check: value => (/^\S+$/.test(value) ? null : 'must not contain spaces or line breaks') },
  { name: 'ATLAS_S3_PREFIX', required: false, meaning: 'Folder inside the bucket for everything Atlas writes (default: the bucket root)', example: 'atlas',
    check: value => (/^[\w./-]+$/.test(value) && !value.split('/').includes('..') ? null : 'may contain only letters, digits, `.`, `_`, `-` and `/`, and no `..`') },
  { name: 'ATLAS_S3_PATH_STYLE', required: false, meaning: 'Address the bucket as endpoint/bucket/key (default: yes; set 0 for virtual-hosted style)', example: '1',
    check: value => (['1', '0', 'true', 'false'].includes(value) ? null : 'must be 1, 0, true or false') },
  { name: 'ATLAS_S3_SESSION_TOKEN', required: false, meaning: 'Session token, only for temporary credentials', example: '', secret: true,
    check: value => (/^\S+$/.test(value) ? null : 'must not contain spaces or line breaks') }
];

/** The storage settings once checked: everything needed to open the bucket, with credentials spelled out. */
export type S3Config = {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly prefix: string;
  readonly pathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
};

/** The state of one variable after checking, for the banner. */
export type S3Finding = { readonly variable: S3Variable; readonly status: 'ok' | 'missing' | 'invalid' | 'unset'; readonly problem?: string };

/** The storage configuration could not be used. `findings` has every variable, not only the first problem. `kind` is the storage it is about. */
export class S3ConfigError extends Error {
  constructor(readonly findings: readonly S3Finding[], readonly reason: string = 'the S3 configuration is missing or invalid', readonly kind: StorageKind = 's3') {
    super(startupFailure(findings, reason, undefined, kind));
    this.name = 'S3ConfigError';
  }
}

/** The kinds of storage the server can keep everything in. */
export type StorageKind = 's3' | 'vercel-blob';

/** Every variable that configures Vercel Blob storage. */
export const BLOB_VARIABLES: readonly S3Variable[] = [
  { name: 'BLOB_READ_WRITE_TOKEN', required: true, meaning: 'Read-write token of a private Vercel Blob store (Vercel sets it when a Blob store is connected to the project)', example: 'vercel_blob_rw_storeid_secret', secret: true,
    check: value => (blobStoreIdOf(value) ? null : 'is not a Vercel Blob read-write token (one starts with vercel_blob_rw_)') },
  { name: 'ATLAS_BLOB_PREFIX', required: false, meaning: 'Folder inside the Blob store for everything Atlas writes (default: the store root)', example: 'atlas',
    check: value => (/^[\w./-]+$/.test(value) && !value.split('/').includes('..') ? null : 'may contain only letters, digits, `.`, `_`, `-` and `/`, and no `..`') }
];

/** Vercel Blob storage once checked. */
export type BlobConfig = { readonly token: string; readonly prefix: string; /** `VERCEL_BLOB_API_URL`, as Vercel's own SDK reads it; absent for the real service. */ readonly apiUrl?: string };

/** Where the server keeps everything: an S3-compatible bucket or a Vercel Blob store. */
export type StorageConfig = { readonly kind: 's3'; readonly s3: S3Config } | { readonly kind: 'vercel-blob'; readonly blob: BlobConfig };

/** Looks at every variable of one kind of storage and returns what each is. Nothing here throws. */
export function inspectStorageEnv(env: Env, kind: StorageKind): readonly S3Finding[] {
  return (kind === 's3' ? S3_VARIABLES : BLOB_VARIABLES).map<S3Finding>(variable => {
    const raw = env[variable.name];
    if (raw === undefined || raw.trim() === '') return { variable, status: variable.required ? 'missing' : 'unset' };
    const problem = variable.check(raw.trim());
    return problem ? { variable, status: 'invalid', problem } : { variable, status: 'ok' };
  });
}

/**
 * Which storage the environment asks for: `ATLAS_STORAGE` (`s3` or `vercel-blob`) when it is set; otherwise Vercel Blob
 * when `BLOB_READ_WRITE_TOKEN` is set and no `ATLAS_S3_*` variable is, and S3 in every other case (so an unconfigured
 * server still names the S3 variables, as it always has). Throws a `ConfigError`-like `Error` for an unknown `ATLAS_STORAGE`.
 */
export function storageKindOf(env: Env): StorageKind {
  const chosen = env.ATLAS_STORAGE?.trim().toLowerCase();
  if (chosen === 's3' || chosen === 'vercel-blob') return chosen;
  if (chosen) throw new S3ConfigError(inspectS3Env(env), `ATLAS_STORAGE is "${env.ATLAS_STORAGE}"; it must be s3 or vercel-blob`);
  const anyS3 = S3_VARIABLES.some(variable => env[variable.name]?.trim());
  return !anyS3 && env.BLOB_READ_WRITE_TOKEN?.trim() ? 'vercel-blob' : 's3';
}

/**
 * The storage settings from the environment, of the kind {@link storageKindOf} picks. Throws {@link S3ConfigError}, whose
 * message lists every variable of that kind and marks each missing or invalid one.
 *
 * @example
 * const storage = resolveStorage(process.env); // { kind: 'vercel-blob', blob: { token, prefix } } on Vercel
 */
export function resolveStorage(env: Env): StorageConfig {
  const kind = storageKindOf(env);
  if (kind === 's3') return { kind, s3: resolveS3Config(env) };
  const findings = inspectStorageEnv(env, kind);
  if (findings.some(finding => finding.status === 'missing' || finding.status === 'invalid')) throw new S3ConfigError(findings, 'the Vercel Blob configuration is missing or invalid', kind);
  const apiUrl = env.VERCEL_BLOB_API_URL?.trim();
  return { kind, blob: { token: env.BLOB_READ_WRITE_TOKEN!.trim(), prefix: (env.ATLAS_BLOB_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, ''), ...(apiUrl ? { apiUrl } : {}) } };
}

/** Where the storage is, without a secret: what the log may say. */
export const describeStorage = (config: StorageConfig): string => config.kind === 's3'
  ? describeS3(config.s3)
  : `vercel-blob://${config.blob.prefix ? `${config.blob.prefix}/` : ''} (store ${blobStoreIdOf(config.blob.token)})`;

/** Looks at every storage variable and returns what each is. Nothing here throws. */
export function inspectS3Env(env: Env): readonly S3Finding[] {
  return S3_VARIABLES.map<S3Finding>(variable => {
    const raw = env[variable.name];
    if (raw === undefined || raw.trim() === '') return { variable, status: variable.required ? 'missing' : 'unset' };
    const problem = variable.check(raw.trim());
    return problem ? { variable, status: 'invalid', problem } : { variable, status: 'ok' };
  });
}

/**
 * The storage settings from the environment. Throws {@link S3ConfigError}, whose message lists every variable and
 * marks each missing or invalid one, when any required variable is absent or any set variable is malformed.
 *
 * @example
 * const s3 = resolveS3Config(process.env);
 */
export function resolveS3Config(env: Env): S3Config {
  const findings = inspectS3Env(env);
  if (findings.some(finding => finding.status === 'missing' || finding.status === 'invalid')) throw new S3ConfigError(findings);
  const value = (name: string) => env[name]?.trim() ?? '';
  const style = value('ATLAS_S3_PATH_STYLE');
  return {
    endpoint: value('ATLAS_S3_ENDPOINT').replace(/\/+$/, ''), bucket: value('ATLAS_S3_BUCKET'), region: value('ATLAS_S3_REGION'),
    prefix: value('ATLAS_S3_PREFIX').replace(/^\/+|\/+$/g, ''), pathStyle: style === '' ? true : style === '1' || style === 'true',
    accessKeyId: value('ATLAS_S3_ACCESS_KEY_ID'), secretAccessKey: value('ATLAS_S3_SECRET_ACCESS_KEY'),
    ...(value('ATLAS_S3_SESSION_TOKEN') ? { sessionToken: value('ATLAS_S3_SESSION_TOKEN') } : {})
  };
}

/** Where the storage is, without a secret: what the log may say. */
export const describeS3 = (config: S3Config): string => `s3://${config.bucket}/${config.prefix ? `${config.prefix}/` : ''} on ${new URL(config.endpoint).host} (${config.region})`;

const RULE = '='.repeat(78);

/**
 * The banner printed when the server cannot start because of storage: why storage is required, then EVERY variable by
 * name with what is wrong with it. Values of secrets are never printed.
 */
export function startupFailure(findings: readonly S3Finding[], reason: string, detail?: string, kind: StorageKind = 's3'): string {
  const width = Math.max(...findings.map(finding => finding.variable.name.length));
  const mark = (finding: S3Finding) => finding.status === 'missing' ? '[MISSING]' : finding.status === 'invalid' ? '[INVALID]' : finding.status === 'ok' ? '[ok]     ' : '[not set]';
  const line = (finding: S3Finding) => {
    const { variable } = finding;
    const note = finding.status === 'invalid' ? `${finding.problem}` : variable.meaning;
    return `  ${mark(finding)} ${variable.name.padEnd(width)}  ${note}`;
  };
  const required = findings.filter(finding => finding.variable.required);
  const optional = findings.filter(finding => !finding.variable.required);
  const bad = findings.filter(finding => finding.status === 'missing' || finding.status === 'invalid').map(finding => finding.variable.name);
  return [
    '', RULE,
    `  ATLAS CANNOT START: ${kind === 's3' ? 'S3' : 'VERCEL BLOB'} STORAGE IS NOT USABLE`,
    RULE,
    `  Why:    ${reason}.`,
    '  Reason: Atlas stores ALL reports and ALL user state (the garbage collection policy and saved',
    '          settings) in object storage (an S3-compatible bucket or a Vercel Blob store), and nowhere',
    '          else. There is no local-disk, in-memory or database fallback, so the server refuses to',
    `          start without working storage.${kind === 's3' ? ' On Vercel, connect a Blob store instead (BLOB_READ_WRITE_TOKEN).' : ''}`,
    ...(detail ? ['', `  ${kind === 's3' ? 'S3' : 'Vercel Blob'} said: ${detail}`] : []),
    '',
    '  Required environment variables:',
    ...required.map(line),
    '',
    '  Optional environment variables:',
    ...optional.map(line),
    '',
    bad.length ? `  Fix these ${bad.length}: ${bad.join(', ')}` : '  Every variable is well-formed, so the values themselves are wrong; check them against the storage service.',
    '  See .env.example for a complete example and docs/server.md#required-s3-storage.',
    '  Exiting with status 2.', RULE, ''
  ].join('\n');
}
