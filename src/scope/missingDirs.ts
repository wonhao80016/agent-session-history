import { stat } from 'node:fs/promises';
import { normalizePath } from './paths';

export type DirectoryProbe = (dir: string) => Promise<boolean>;

const PROBE_CONCURRENCY = 8;

/** Only a definite "not found" counts as missing; permission or I/O errors keep the directory, since missing groups offer deletion. */
export const directoryIsMissing: DirectoryProbe = async (dir) => {
  try {
    await stat(dir);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
};

/** Returns the normalized paths of the given directories that no longer exist. */
export async function findMissingDirs(
  dirs: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
  isMissing: DirectoryProbe = directoryIsMissing,
): Promise<Set<string>> {
  const pending = new Map<string, string>();
  for (const dir of dirs) {
    const key = normalizePath(dir, platform);
    if (!pending.has(key)) {
      pending.set(key, dir);
    }
  }
  const missing = new Set<string>();
  const queue = [...pending];
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [key, dir] = item;
      if (await isMissing(dir)) {
        missing.add(key);
      }
    }
  });
  await Promise.all(workers);
  return missing;
}
