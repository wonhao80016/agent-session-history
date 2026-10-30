import { SessionRecord } from '../model';
import { compareByStartedDesc, compareByUpdatedDesc } from '../index/indexer';
import { CardView, EmptyAction, GroupView, Scope, scopeLabel, SortKey, ViewState } from '../protocol';
import { filterByScope, groupIdentity, isInside, ScopeContext } from '../scope/filter';
import { matchesQuery } from '../scope/search';
import { countOf, formatBytes } from './format';
import { groupSessions, ProjectGroup, SessionComparator } from './grouping';

export interface ScanSummary {
  files: number;
  failed: number;
  skippedLines: number;
  maxLineBytes: number;
  finishedAt: string;
}

export interface ViewInput {
  /** Undefined until the first index completes. */
  sessions: readonly SessionRecord[] | undefined;
  scope: Scope;
  sort: SortKey;
  query: string;
  querySeq: number;
  indexing: boolean;
  indexFailed: boolean;
  scan: ScanSummary | undefined;
  context: ScopeContext;
}

const COMPARATORS: Record<SortKey, SessionComparator> = {
  updated: compareByUpdatedDesc,
  created: (a, b) => compareByStartedDesc(a, b) || compareByUpdatedDesc(a, b),
  messages: (a, b) => b.messageCount - a.messageCount || compareByUpdatedDesc(a, b),
};

export function sessionKey(session: Pick<SessionRecord, 'agent' | 'id'>): string {
  return `${session.agent}:${session.id}`;
}

export function buildViewState(input: ViewInput): ViewState {
  const query = input.query.trim();
  const inScope = input.sessions ? filterByScope(input.sessions, input.scope, input.context) : [];
  const visible = query ? inScope.filter((session) => matchesQuery(session, query)) : inScope;
  const groups = groupSessions(visible, (session) => groupIdentity(session, input.context), COMPARATORS[input.sort]);
  return {
    scope: input.scope,
    sort: input.sort,
    query,
    querySeq: input.querySeq,
    indexing: input.indexing,
    scan: input.scan && { files: input.scan.files, finishedAt: input.scan.finishedAt },
    notices: buildNotices(input),
    inScopeCount: inScope.length,
    visibleCount: visible.length,
    emptyMessage: buildEmptyMessage(input, query, inScope.length, visible.length),
    emptyActions: buildEmptyActions(input),
    groups: groups.map((group) => toGroupView(group, input)),
  };
}

/** Settings are offered only when nothing was indexed at all; a failed first index offers a retry. */
function buildEmptyActions(input: ViewInput): EmptyAction[] {
  if (input.sessions?.length === 0) {
    return ['openSettings', 'refresh'];
  }
  if (!input.sessions && input.indexFailed && !input.indexing) {
    return ['refresh'];
  }
  return [];
}

function buildEmptyMessage(input: ViewInput, query: string, inScopeCount: number, visibleCount: number): string | undefined {
  if (visibleCount > 0) {
    return undefined;
  }
  if (!input.sessions) {
    return input.indexing ? 'Indexing sessions…' : undefined;
  }
  if (input.sessions.length === 0) {
    return 'No sessions found. Check the Claude and Codex directory settings.';
  }
  const label = scopeLabel(input.scope);
  if (input.scope !== 'all' && input.context.workspaceDirs.length === 0) {
    return `Open a folder to use ${label} scope, or switch to All.`;
  }
  if (inScopeCount === 0) {
    return `No sessions in ${label} scope. Switch to ${input.scope === 'workspace' ? 'Project or All' : 'All'} to see others.`;
  }
  return `No sessions match "${query}".`;
}

function buildNotices(input: ViewInput): string[] {
  const notices: string[] = [];
  if (input.indexFailed) {
    notices.push('Indexing failed. See the Agent Session History output for details.');
  }
  const scan = input.scan;
  if (scan && scan.skippedLines > 0) {
    notices.push(
      `Skipped ${countOf(scan.skippedLines, 'oversized transcript line')} over the ${formatBytes(scan.maxLineBytes)} limit. The rest of each session was read.`,
    );
  }
  if (scan && scan.failed > 0) {
    notices.push(`${countOf(scan.failed, 'transcript file')} could not be read. See the Agent Session History output.`);
  }
  return notices;
}

function toGroupView(group: ProjectGroup, input: ViewInput): GroupView {
  return {
    key: group.key,
    label: group.label,
    path: group.path,
    missing: group.missing,
    cards: group.sessions.map((session) => toCardView(session, input)),
  };
}

function toCardView(session: SessionRecord, input: ViewInput): CardView {
  const { workspaceDirs, platform } = input.context;
  const cwd = session.cwd;
  return {
    key: sessionKey(session),
    id: session.id,
    agent: session.agent,
    title: session.title,
    firstPrompt: session.firstPrompt,
    lastReply: session.lastReply,
    messageCount: session.messageCount,
    subagentCount: session.subagentCount,
    model: session.model,
    branch: session.gitBranch,
    cwd,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    interactive: session.interactive,
    currentWorkspace: input.scope !== 'workspace' && cwd !== undefined && workspaceDirs.some((dir) => isInside(cwd, dir, platform)),
  };
}
