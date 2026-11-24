/** @module Garbage collection policy shared by deployment configuration and saved settings */
import { z } from 'zod/v4';

/**
 * The garbage collection policy: which report layers the server may delete from S3, and when. Only layers that the
 * report has loaded and that no longer decide any result (every check they carry has since been superseded by a newer
 * layer) are ever candidates, and the newest `keepLatest` layers are always kept. With `enabled: false` nothing is deleted.
 */
export const GcPolicySchema = z.strictObject({
  enabled: z.boolean().describe('Delete eligible layers on a schedule. `false` keeps the policy but deletes nothing'),
  maxAgeDays: z.number().int().min(1).max(3650).describe('A superseded layer is eligible once it was recorded more than this many days ago'),
  maxBytes: z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d*(?:KB|MB|GB|TB)$/i)]).optional().describe('Project storage budget in bytes or decimal units such as 10GB. Above budget the oldest eligible layers may be collected before their age limit.'),
  attachments: z.strictObject({
    maxAgeDays: z.number().nonnegative(),
    keepForStatus: z.array(z.string()).optional(),
    rules: z.array(z.strictObject({ role: z.string().optional(), status: z.string().optional(), branch: z.string().optional(), maxAgeDays: z.number().nonnegative() })).optional()
  }).optional().describe('Expire captured attachments of superseded layers independently from their result history. The first matching rule sets the age. Protected statuses take precedence.'),
  keepLatest: z.number().int().min(0).max(1_000_000).default(20).describe('Always keep this many of the newest layers, however old, so recent history stays'),
  intervalHours: z.number().min(1).max(720).default(24).describe('How often the server applies the policy')
});
/** A garbage collection policy as stored, defaults applied. */
export type GcPolicy = z.output<typeof GcPolicySchema>;
/** A garbage collection policy as written, before defaults are applied. */
export type GcPolicyInput = z.input<typeof GcPolicySchema>;
