/** @module Validated staged uploads
 * A publisher sends bytes directly to a private scratch key. Completion verifies them and creates the immutable
 * destination only if absent. The descriptor determines the staging key, so retries can use a different instance.
 */
import { createHash } from 'node:crypto';
import { readBytes, readUtf8, writeUtf8 } from '../../reports/src/object-io';
import type { ObjectStore, StagedUploads } from '../../reports/src/object-store';
import { Refusal, validateUpload } from './validate';

/** Verify an upload descriptor at both negotiation and completion. Returns an idempotent target or completion receipt. */
export async function stagedUpload(store: ObjectStore & StagedUploads, name: string, step: 'start' | 'complete', input: unknown, limit: number, legacyOwner?: string) {
  const pending = legacyOwner === undefined ? undefined : 'server/uploads/legacy/' + createHash('sha256').update(JSON.stringify([legacyOwner, name])).digest('hex');
  if (pending && step === 'complete') {
    const stored = await readUtf8(store, pending);
    if (stored === null) {
      if (await store.head(name)) return { ok: true, key: name, created: false };
      throw new Refusal(422, 'The staged upload has not been started.');
    }
    input = JSON.parse(stored);
  }
  const data = input as { sha256?: string; size?: number; contentType?: string } | null;
  if (!data || (!pending && (typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.sha256))) ||
      typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0 ||
      typeof data.contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+(?:;[ \w=.\-]+)*$/.test(data.contentType)) {
    throw new Refusal(422, 'A staged upload needs its SHA-256, size in bytes and media type.');
  }
  const { sha256, size, contentType } = data;
  if (size > limit) throw new Refusal(413, 'The declared size exceeds the object limit.');
  const descriptor = JSON.stringify([name, sha256 ?? pending, size, contentType]);
  const scratch = 'server/uploads/' + createHash('sha256').update(descriptor).digest('hex');
  const blob = name.startsWith('layers/blobs/');
  const existing = async (digest = sha256) => {
    if (blob) return store.head(name);
    if (!digest) return false;
    const held = await store.get(name);
    if (!held) return false;
    if (held.size !== size || held.contentType !== contentType) {
      await held.body.cancel();
      throw new Refusal(409, 'An immutable file already exists with different metadata.');
    }
    if (createHash('sha256').update(await readBytes(held.body)).digest('hex') !== digest) throw new Refusal(409, 'An immutable file already exists with different content.');
    return true;
  };
  if (await existing()) {
    if (step === 'complete') await store.delete(scratch);
    return step === 'start' ? { exists: true } : { ok: true, key: name, created: false };
  }
  if (step === 'start') {
    if (pending) await writeUtf8(store, pending, JSON.stringify({ size, contentType }), 'application/json');
    return { exists: false, ...(!pending ? { staged: true } : {}), ...await store.stagedUploadTarget(scratch, { size, contentType }) };
  }
  const staged = await store.get(scratch);
  if (!staged) {
    if (await existing()) return { ok: true, key: name, created: false };
    throw new Refusal(422, 'The staged upload has not arrived.');
  }
  try {
    if (staged.contentType !== contentType || staged.size !== size) {
      await staged.body.cancel();
      throw new Refusal(422, 'The staged file differs from its declared media type or size.');
    }
    const bytes = await readBytes(staged.body);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (sha256 && digest !== sha256) throw new Refusal(422, 'The staged bytes differ from their declared hash.');
    const kind = await validateUpload(name, bytes, store);
    const created = await store.putIfAbsent(name, bytes, contentType);
    if (!created && !await existing(digest)) throw new Refusal(409, 'The destination changed during upload. Retry the upload.');
    await store.deleteMany(pending ? [scratch, pending] : [scratch]);
    return { ok: true, key: name, kind, created };
  } catch (error) {
    if (error instanceof Refusal) await store.delete(scratch);
    throw error;
  }
}
