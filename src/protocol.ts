import type { AgentKind } from './model';

export type Scope = 'workspace' | 'project' | 'all';

export const SCOPES: readonly Scope[] = ['workspace', 'project', 'all'];

export function scopeLabel(scope: Scope): string {
  return scope === 'workspace' ? 'Workspace' : scope === 'project' ? 'Project' : 'All';
}

export type SortKey = 'updated' | 'created' | 'messages';

export const SORT_KEYS: readonly SortKey[] = ['updated', 'created', 'messages'];

export function sortLabel(sort: SortKey): string {
  return sort === 'updated' ? 'Last updated' : sort === 'created' ? 'Created' : 'Messages';
}

export interface CardView {
  key: string;
  id: string;
  agent: AgentKind;
  title: string;
  firstPrompt?: string;
  lastReply?: string;
  messageCount: number;
  subagentCount: number;
  model?: string;
  branch?: string;
  cwd?: string;
  startedAt?: string;
  updatedAt?: string;
  interactive: boolean;
  /** The session ran inside an open workspace folder; never set in Workspace scope, where every card would carry it. */
  currentWorkspace: boolean;
}

export interface GroupView {
  key: string;
  label: string;
  path?: string;
  /** The group's directory no longer exists; such groups offer moving all of their sessions to the Recycle Bin. */
  missing?: true;
  cards: CardView[];
}

export type EmptyAction = 'openSettings' | 'refresh';

export interface ViewState {
  scope: Scope;
  sort: SortKey;
  query: string;
  /** Sequence number of the last webview query the host applied; lets the webview drop stale echoes. */
  querySeq: number;
  indexing: boolean;
  scan?: { files: number; finishedAt: string };
  notices: string[];
  inScopeCount: number;
  visibleCount: number;
  emptyMessage?: string;
  emptyActions: EmptyAction[];
  groups: GroupView[];
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'setScope'; scope: Scope }
  | { type: 'setSort'; sort: SortKey }
  | { type: 'setQuery'; query: string; seq: number }
  | { type: 'open'; key: string }
  | { type: 'showActions'; key: string }
  | { type: 'trashGroup'; key: string }
  | { type: 'refresh' }
  | { type: 'openSettings' };

export type HostMessage = { type: 'state'; state: ViewState } | { type: 'focusSearch' };

const MAX_QUERY_LENGTH = 500;
const MAX_KEY_LENGTH = 200;
/** Group keys embed a full directory path, and Windows extended-length paths reach 32,767 characters. */
const MAX_GROUP_KEY_LENGTH = 33_000;

/** Rejects anything that is not a well-formed message, so handlers never see unexpected shapes. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const message = raw as Record<string, unknown>;
  switch (message.type) {
    case 'ready':
    case 'refresh':
    case 'openSettings':
      return { type: message.type };
    case 'setScope':
      return SCOPES.includes(message.scope as Scope) ? { type: 'setScope', scope: message.scope as Scope } : undefined;
    case 'setSort':
      return SORT_KEYS.includes(message.sort as SortKey) ? { type: 'setSort', sort: message.sort as SortKey } : undefined;
    case 'setQuery':
      return typeof message.query === 'string' && message.query.length <= MAX_QUERY_LENGTH && Number.isSafeInteger(message.seq) && (message.seq as number) >= 0
        ? { type: 'setQuery', query: message.query, seq: message.seq as number }
        : undefined;
    case 'open':
    case 'showActions':
      return typeof message.key === 'string' && message.key.length <= MAX_KEY_LENGTH
        ? { type: message.type, key: message.key }
        : undefined;
    case 'trashGroup':
      return typeof message.key === 'string' && message.key.length <= MAX_GROUP_KEY_LENGTH
        ? { type: message.type, key: message.key }
        : undefined;
    default:
      return undefined;
  }
}
