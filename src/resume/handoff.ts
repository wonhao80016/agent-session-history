import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { isSessionId } from '../commandLine';
import { normalizePath } from '../scope/paths';

/** A Claude session waiting for the window opened on its folder to resume it. */
export interface PendingResume {
  id: string;
  folder: string;
  createdAt: number;
}

export const PENDING_RESUME_TTL_MS = 120_000;

export async function writePendingResume(file: string, pending: PendingResume): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(pending), 'utf8');
  await rename(temp, file);
}

/**
 * Returns the entry when it targets `folder` and has not expired. A taken, expired, or malformed entry is deleted;
 * the delete doubles as a lock, so only the window that removes the file resumes the session.
 */
export async function takePendingResume(
  file: string,
  folder: string,
  now: number,
  platform: NodeJS.Platform,
): Promise<PendingResume | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const pending = parsePendingResume(raw);
  const usable = pending !== undefined && Math.abs(now - pending.createdAt) <= PENDING_RESUME_TTL_MS;
  if (usable && normalizePath(pending.folder, platform) !== normalizePath(folder, platform)) {
    return undefined;
  }
  try {
    await unlink(file);
  } catch {
    return undefined;
  }
  return usable ? pending : undefined;
}

export function parsePendingResume(raw: string): PendingResume | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { id, folder, createdAt } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !isSessionId(id) || typeof folder !== 'string' || folder === '' || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return undefined;
  }
  return { id, folder, createdAt };
}
