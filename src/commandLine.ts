import { SessionRecord } from './model';

/**
 * Claude and Codex session IDs are UUIDs. Anything else is refused, because the ID comes from files on disk
 * and would otherwise reach the CLI as an argument (for example a value starting with "--").
 */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export function resumeCommand(session: Pick<SessionRecord, 'agent' | 'id'>): string | undefined {
  if (!isSessionId(session.id)) {
    return undefined;
  }
  return session.agent === 'claude' ? `claude --resume ${session.id}` : `codex resume ${session.id}`;
}
