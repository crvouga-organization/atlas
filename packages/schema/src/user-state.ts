/**
 * @module User state schema
 *
 * The one JSON document that holds everything a person using Atlas has chosen, as opposed to what an operator deployed:
 * the garbage collection policy and the saved server settings. The server keeps it in S3-compatible object storage
 * (`server/state.json` under the configured prefix) and nowhere else: not in a file, a database or the browser. A
 * document that does not exist yet means nothing has been chosen; a document that cannot be read is an error, never
 * an empty state. Unknown keys are kept, so an older server does not drop what a newer one wrote.
 *
 * @see docs/server.md#user-state-and-garbage-collection
 */
import { z } from 'zod/v4';

import { ServerEditableSettingsSchema } from './server-config';

import { GcPolicySchema } from './gc-policy';
export { GcPolicySchema, type GcPolicy, type GcPolicyInput } from './gc-policy';

/** What one pass of garbage collection found and did, for one project. */
export const GcRunSchema = z.looseObject({
  project: z.string(),
  dryRun: z.boolean(),
  at: z.string().describe('When the pass finished, ISO 8601'),
  candidates: z.number().int().min(0).describe('Layers the policy would delete'),
  deletedLayers: z.number().int().min(0),
  deletedBlobs: z.number().int().min(0),
  keptLayers: z.number().int().min(0),
  error: z.string().optional().describe('Why the pass stopped early, when it did'),
  strippedLayers: z.number().int().nonnegative().optional().describe('Retained layers with newly expired attachment files, including planned expiry in a dry run'),
  candidateBlobs: z.number().int().min(0).optional().describe('Captured-file blobs only the deleted layers used: what a real pass deletes (and did delete, unless a layer could not be read). The same in a dry run. Absent from a server that predates it'),
  candidateBytes: z.number().int().min(0).optional().describe('Bytes of those blobs and of the deleted layers\' manifests: what a real pass frees. The same in a dry run'),
  deletedBytes: z.number().int().min(0).optional().describe('Bytes a real pass removed; 0 for a dry run')
});
/** One pass of garbage collection, see {@link GcRunSchema}. */
export type GcRun = z.output<typeof GcRunSchema>;

/** The user state document stored in S3. Both parts are optional: absent means "never chosen". */
export const UserStateSchema = z.looseObject({
  schemaVersion: z.literal(1),
  gc: GcPolicySchema.optional().describe('The garbage collection policy. Absent until someone saves one: then nothing is deleted'),
  settings: ServerEditableSettingsSchema.optional().describe('Report and live-run settings saved from the settings page, applied at the next start')
});
/** The user state document, see {@link UserStateSchema}. */
export type UserState = z.output<typeof UserStateSchema>;

/**
 * `GET /api/settings/gc` and `PUT /api/settings/gc`: the effective deployment or saved policy (`null` when neither exists), the
 * revision to send back in `If-Match`, and the result of the last pass this server ran.
 */
export const GcSnapshotSchema = z.looseObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  policy: GcPolicySchema.nullable(),
  source: z.enum(['env', 'config', 'saved', 'none']).optional().describe('Where the effective policy came from'),
  saved: z.boolean().describe('Whether a policy exists in S3'),
  lastRuns: z.array(GcRunSchema).describe('The most recent pass over each project, newest first; empty before the first pass'),
  stateKey: z.string().describe('Where the user state lives in the bucket, relative to the configured prefix'),
  currentPass: z.lazy(() => GcPassSchema).nullable().optional().describe('The pass running now, or null. Absent from a server that predates passes')
});
/** The garbage collection settings response, see {@link GcSnapshotSchema}. */
export type GcSnapshot = z.output<typeof GcSnapshotSchema>;

/** How far a garbage collection pass has come, over every project. */
export const GcPassProgressSchema = z.looseObject({
  projects: z.number().int().min(0).describe('Projects the pass covers'),
  projectsDone: z.number().int().min(0),
  project: z.string().nullable().describe('The project being collected now, or null'),
  phase: z.string().nullable().describe('What the pass is doing in that project: `layers` (deleting superseded layers), `scan` (reading the layers that stay), `blobs` (deleting files only deleted layers used)'),
  candidates: z.number().int().min(0).describe('Layers the policy deletes, in the projects reached so far'),
  layersExamined: z.number().int().min(0),
  deletedLayers: z.number().int().min(0),
  deletedBlobs: z.number().int().min(0),
  candidateBlobs: z.number().int().min(0),
  candidateBytes: z.number().int().min(0),
  deletedBytes: z.number().int().min(0)
});

/**
 * One garbage collection pass over every project, kept in the store (`server/gc/runs/<id>.json`) so any server instance
 * can report and continue it: `GET /api/settings/gc/runs/{id}`. At most one pass is `running` at a time.
 */
export const GcPassSchema = z.looseObject({
  id: z.string().regex(/^[a-z0-9-]{8,64}$/),
  status: z.enum(['running', 'done', 'failed']).describe('`running` until every project is collected; a pass that stops midway is continued by the next request, scheduled pass or step, never started over'),
  dryRun: z.boolean(),
  startedAt: z.string().describe('ISO 8601'),
  updatedAt: z.string().describe('When the pass last made progress, ISO 8601'),
  finishedAt: z.string().nullable().describe('When it finished, or null while running'),
  progress: GcPassProgressSchema,
  runs: z.array(GcRunSchema).describe('One per project finished so far'),
  error: z.string().optional().describe('Why the pass failed, when it did')
});
/** A garbage collection pass, see {@link GcPassSchema}. */
export type GcPass = z.output<typeof GcPassSchema>;

/**
 * `POST /api/settings/gc/run`: the passes that ran, one per project. The answer is also the pass itself (`id`, `status`,
 * `progress`, …): `200` once it is done (`runs` complete), `202` while it continues in the background (`runs` so far).
 */
export const GcRunResultSchema = GcPassSchema.partial().extend({ runs: z.array(GcRunSchema), policy: GcPolicySchema.nullable() });
