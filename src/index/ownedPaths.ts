import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { SessionRecord } from '../model';

/** A Claude transcript keeps subagent and tool-output files in a sibling directory named after the session. */
export function sessionPaths(session: SessionRecord): string[] {
  if (session.agent === 'claude') {
    return [session.filePath, session.filePath.replace(/\.jsonl$/, '')];
  }
  return [...new Set(session.ownedFiles ?? [session.filePath])];
}

export interface PathSummary {
  existing: string[];
  fileCount: number;
  totalBytes: number;
  newestMtimeMs: number;
}

export async function summarizePaths(paths: readonly string[]): Promise<PathSummary> {
  const summary: PathSummary = { existing: [], fileCount: 0, totalBytes: 0, newestMtimeMs: 0 };
  for (const target of paths) {
    let info;
    try {
      info = await lstat(target);
    } catch {
      continue;
    }
    summary.existing.push(target);
    await accumulate(target, info, summary);
  }
  return summary;
}

export interface SessionsSummary extends PathSummary {
  /** Newest modification time of each session's existing paths, in input order; 0 when none exist. */
  newestPerSession: number[];
}

/** A path owned by more than one session is counted once, for the first session that owns it. */
export async function summarizeSessions(sessions: readonly SessionRecord[]): Promise<SessionsSummary> {
  const seen = new Set<string>();
  const total: SessionsSummary = { existing: [], fileCount: 0, totalBytes: 0, newestMtimeMs: 0, newestPerSession: [] };
  for (const session of sessions) {
    const paths = sessionPaths(session).filter((target) => !seen.has(target));
    paths.forEach((target) => seen.add(target));
    const summary = await summarizePaths(paths);
    total.existing.push(...summary.existing);
    total.fileCount += summary.fileCount;
    total.totalBytes += summary.totalBytes;
    total.newestMtimeMs = Math.max(total.newestMtimeMs, summary.newestMtimeMs);
    total.newestPerSession.push(summary.newestMtimeMs);
  }
  return total;
}

/** Links (including Windows junctions) are counted as themselves and never followed. */
async function accumulate(target: string, info: Awaited<ReturnType<typeof lstat>>, summary: PathSummary): Promise<void> {
  summary.newestMtimeMs = Math.max(summary.newestMtimeMs, Number(info.mtimeMs));
  if (!info.isDirectory()) {
    summary.fileCount++;
    summary.totalBytes += Number(info.size);
    return;
  }
  for (const entry of await readdir(target)) {
    const child = path.join(target, entry);
    try {
      await accumulate(child, await lstat(child), summary);
    } catch {
      continue;
    }
  }
}
