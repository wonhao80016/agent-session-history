import { SessionRecord } from '../model';
import { compareByUpdatedDesc } from '../index/indexer';
import { displayName, normalizePath } from '../scope/paths';

export interface ProjectGroup {
  key: string;
  label: string;
  path?: string;
  sessions: SessionRecord[];
}

const UNKNOWN_KEY = '<unknown>';

/** Groups are ordered by their most recent session. */
export function groupByDirectory(
  sessions: readonly SessionRecord[],
  platform: NodeJS.Platform = process.platform,
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    const key = session.cwd ? normalizePath(session.cwd, platform) : UNKNOWN_KEY;
    let group = groups.get(key);
    if (!group) {
      group = session.cwd
        ? { key, label: displayName(session.cwd), path: session.cwd, sessions: [] }
        : { key, label: 'Unknown directory', sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.sessions.sort(compareByUpdatedDesc);
  }
  return result.sort((a, b) => compareByUpdatedDesc(a.sessions[0], b.sessions[0]));
}
