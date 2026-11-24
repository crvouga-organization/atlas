/** @module Attachment retention
 * Expiry receipts identify captured files in a superseded layer while preserving its content-addressed manifest.
 * Bundle chunks can hold several files. A chunk is reclaimable only after every retained layer and file releases it.
 */
import type { GcPolicy } from '../../schema/src/user-state';
import type { ReportLayer } from './layer-types';
import type { ObjectStore } from './object-store';

type Holder = {
  attachments?: { bundleKey?: string; role?: string; name: string }[];
  annotations?: { type: string; message: string }[];
  status?: string;
  parts?: Holder[];
  checks?: Holder[];
  attempts?: Holder[];
  steps?: Holder[];
};
const walked = (holder: Holder, visit: (holder: Holder, status?: string) => void, status?: string) => {
  visit(holder, status);
  for (const part of holder.parts ?? []) walked(part, visit, status);
  for (const check of holder.checks ?? []) walked(check, visit, check.status);
  for (const child of [...holder.attempts ?? [], ...holder.steps ?? []]) walked(child, visit, status);
};

/** Private object keys for a layer’s expired attachment receipts. */
export const expiryPrefix = (id: string) => `server/attachment-expiry/${id}/`;

/** Bundle keys already marked expired. An unreadable receipt listing fails the read. */
export async function expiredFiles(store: ObjectStore, id: string): Promise<string[]> {
  const prefix = expiryPrefix(id);
  return (await store.listKeys(prefix)).map(key => key.slice(prefix.length));
}

/** Which content-addressed attachment files may expire under the policy. Any protected reference keeps the file. */
export function expirableFiles(layer: ReportLayer, policy: NonNullable<GcPolicy['attachments']>, nowMs: number, defaultBranch?: string): string[] {
  const expire = new Set<string>();
  const protect = new Set<string>();
  walked(layer as unknown as Holder, (holder, status) => {
    for (const attachment of holder.attachments ?? []) {
      const key = attachment.bundleKey;
      if (!key || !/^attachments\/[0-9a-f]{64}$/.test(key) || !Object.hasOwn(layer.bundle, key)) continue;
      const rule = policy.rules?.find(rule => (!rule.role || rule.role === attachment.role) && (!rule.status || rule.status === status) &&
        (!rule.branch || (rule.branch === '!default' ? Boolean(layer.branch && !(defaultBranch ? [defaultBranch] : ['main', 'master']).includes(layer.branch)) : rule.branch === layer.branch)));
      const age = rule?.maxAgeDays ?? policy.maxAgeDays;
      if (nowMs - layer.recordedAtMs >= age * 86400000 && !(status && policy.keepForStatus?.includes(status))) expire.add(key);
      else protect.add(key);
    }
  });
  return [...expire].filter(key => !protect.has(key));
}

/** A presentation copy with expired files replaced by a note at the same check, step, attempt, part or layer. */
export function withoutExpiredFiles(layer: ReportLayer, keys: readonly string[]): ReportLayer {
  if (!keys.length) return layer;
  const expired = new Set(keys);
  const copy = structuredClone(layer);
  for (const key of expired) delete copy.bundle[key];
  walked(copy as unknown as Holder, holder => {
    const gone = holder.attachments?.filter(file => file.bundleKey && expired.has(file.bundleKey));
    if (!gone?.length) return;
    holder.attachments = holder.attachments!.filter(file => !file.bundleKey || !expired.has(file.bundleKey));
    holder.annotations = [...holder.annotations ?? [], ...gone.map(file => ({ type: 'attachment-expired', message: `Evidence expired: ${file.name}` }))];
  });
  return copy;
}
