/** @module Project storage usage
 * Counts physical objects and bytes in one project. Shared blobs count once in the total and once in each group that uses them.
 */
import { eachLimited } from './completion-order';
import { layerKey, readLayer } from './layer-store';
import type { ObjectStore } from './object-store';

type Size = { objects: number; bytes: number };

/** Physical sizes of objects in one project, excluding child projects and the collector’s temporary work. */
export async function projectObjectSizes(store: ObjectStore): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const keys = (await store.listKeys()).filter(key => !key.startsWith('projects/') && !key.startsWith('server/gc/'));
  await eachLimited(keys, 16, async key => {
    const stored = await store.get(key);
    if (!stored) return;
    await stored.body.cancel();
    sizes.set(key, stored.size);
  });
  return sizes;
}

/** Measure project storage and attribute layer documents and captured files by producer, branch and attachment role. */
export async function projectStorage(store: ObjectStore) {
  const sizes = await projectObjectSizes(store);
  const measure = (keys: Iterable<string>): Size => {
    let bytes = 0, objects = 0;
    for (const key of keys) if (sizes.has(key)) { bytes += sizes.get(key)!; objects++; }
    return { bytes, objects };
  };
  const prefix = new Map<string, Set<string>>(), producer = new Map<string, Set<string>>(), branch = new Map<string, Set<string>>(), role = new Map<string, Set<string>>();
  const group = (groups: Map<string, Set<string>>, name: string, keys: Iterable<string>) => {
    const held = groups.get(name) ?? new Set<string>();
    for (const key of keys) held.add(key);
    groups.set(name, held);
  };
  for (const key of sizes.keys()) group(prefix, key.split('/').slice(0, 2).join('/'), [key]);
  const catalogs = [...sizes.keys()].filter(key => /^layers\/index\/\d{16}-[0-9a-f]{64}\.json$/.test(key));
  await eachLimited(catalogs, 16, async key => {
    const id = key.slice(-69, -5);
    const layer = await readLayer(store, id);
    if (!layer) return;
    const keys = [key, layerKey(id), ...Object.values(layer.bundle).flatMap(file => file.parts.map(part => part.blob))];
    group(producer, layer.producer, keys);
    group(branch, layer.branch ?? '(unknown)', keys);
    const attachments = (holder: { attachments?: readonly { role?: string; bundleKey?: string }[]; steps?: readonly unknown[]; attempts?: readonly unknown[] }) => {
      for (const file of holder.attachments ?? []) if (file.bundleKey) group(role, file.role ?? '(unspecified)', layer.bundle[file.bundleKey]?.parts.map(part => part.blob) ?? []);
      for (const child of [...holder.steps ?? [], ...holder.attempts ?? []]) attachments(child as typeof holder);
    };
    attachments(layer);
    for (const part of layer.parts) { attachments(part); for (const check of part.checks) attachments(check); }
  });
  const summarize = (groups: Map<string, Set<string>>) => Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, keys]) => [name, measure(keys)]));
  return { ...measure(sizes.keys()), prefix: summarize(prefix), producer: summarize(producer), branch: summarize(branch), role: summarize(role) };
}
