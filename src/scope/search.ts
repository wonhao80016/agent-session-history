import { SessionRecord } from '../model';

/** Every whitespace-separated term must appear (case-insensitively) in one of the searchable fields. */
export function matchesQuery(session: SessionRecord, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) {
    return true;
  }
  const haystack = [session.title, session.firstPrompt, session.lastReply, session.id, session.cwd, session.gitBranch, session.model]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
