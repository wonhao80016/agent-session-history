import { SessionRecord } from '../model';
import { compareByUpdatedDesc } from '../index/indexer';
import { GroupIdentity } from '../scope/filter';

export interface ProjectGroup {
  key: string;
  label: string;
  path?: string;
  sessions: SessionRecord[];
}

/** Groups are ordered by their most recent session. */
export function groupSessions(
  sessions: readonly SessionRecord[],
  identify: (session: SessionRecord) => GroupIdentity,
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    const identity = identify(session);
    let group = groups.get(identity.key);
    if (!group) {
      group = { ...identity, sessions: [] };
      groups.set(identity.key, group);
    }
    group.sessions.push(session);
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.sessions.sort(compareByUpdatedDesc);
  }
  return result.sort((a, b) => compareByUpdatedDesc(a.sessions[0], b.sessions[0]));
}
