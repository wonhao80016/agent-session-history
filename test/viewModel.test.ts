import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SessionRecord } from '../src/model';
import { parseWebviewMessage } from '../src/protocol';
import { RepoInfo } from '../src/scope/gitRepo';
import { buildViewState, ScanSummary, ViewInput } from '../src/view/viewModel';

const APP = 'D:\\code\\app';
const APP_WORKTREE = 'D:\\code\\app-wt';
const OTHER = 'D:\\code\\other';
const APP_REPO: RepoInfo = { key: 'd:\\code\\app\\.git', name: 'app', root: APP };

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    agent: 'claude',
    id: 'id',
    title: 'title',
    messageCount: 0,
    subagentCount: 0,
    filePath: 'f.jsonl',
    interactive: true,
    isSubagent: false,
    skippedLines: 0,
    ...overrides,
  };
}

const SESSIONS: SessionRecord[] = [
  session({ id: 'a', title: 'Fix login', cwd: APP, messageCount: 4, startedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' }),
  session({ id: 'b', agent: 'codex', title: 'Add tests', cwd: APP_WORKTREE, messageCount: 40, startedAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z', gitBranch: 'feat/tests', lastReply: 'Done.' }),
  session({ id: 'c', title: 'Other repo work', cwd: OTHER, messageCount: 9, startedAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z' }),
];

const SCAN: ScanSummary = { files: 12, failed: 0, skippedLines: 0, maxLineBytes: 10 * 1024 * 1024, finishedAt: '2026-10-27T12:00:00.000Z' };

function input(overrides: Partial<ViewInput> = {}): ViewInput {
  return {
    sessions: SESSIONS,
    scope: 'all',
    sort: 'updated',
    query: '',
    querySeq: 0,
    indexing: false,
    indexFailed: false,
    scan: SCAN,
    context: {
      workspaceDirs: [APP],
      workspaceRepoKeys: new Set([APP_REPO.key]),
      repoOf: (cwd) => (cwd === APP || cwd === APP_WORKTREE ? APP_REPO : undefined),
      platform: 'win32',
    },
    ...overrides,
  };
}

function groupIds(state: ReturnType<typeof buildViewState>): Array<[string, string[]]> {
  return state.groups.map((group) => [group.label, group.cards.map((card) => card.key)]);
}

test('scopes narrow the list and group worktrees with their repository', () => {
  assert.deepEqual(groupIds(buildViewState(input({ scope: 'workspace' }))), [['app', ['claude:a']]]);
  assert.deepEqual(groupIds(buildViewState(input({ scope: 'project' }))), [['app', ['claude:a', 'codex:b']]]);
  assert.deepEqual(groupIds(buildViewState(input())), [
    ['app', ['claude:a', 'codex:b']],
    ['other', ['claude:c']],
  ]);
});

test('sorting applies within groups and orders groups by their first session', () => {
  assert.deepEqual(groupIds(buildViewState(input({ sort: 'created' }))), [
    ['other', ['claude:c']],
    ['app', ['codex:b', 'claude:a']],
  ]);
  assert.deepEqual(groupIds(buildViewState(input({ sort: 'messages' }))), [
    ['app', ['codex:b', 'claude:a']],
    ['other', ['claude:c']],
  ]);
});

test('search reports visible and in-scope counts and trims the query', () => {
  const state = buildViewState(input({ query: '  tests ' }));

  assert.equal(state.query, 'tests');
  assert.equal(state.visibleCount, 1);
  assert.equal(state.inScopeCount, 3);
  assert.deepEqual(groupIds(state), [['app', ['codex:b']]]);
});

test('cards carry display fields and a key the host can resolve', () => {
  const card = buildViewState(input({ scope: 'project' })).groups[0].cards[1];

  assert.deepEqual(card, {
    key: 'codex:b',
    agent: 'codex',
    title: 'Add tests',
    lastReply: 'Done.',
    messageCount: 40,
    subagentCount: 0,
    model: undefined,
    branch: 'feat/tests',
    updatedAt: '2026-10-06T00:00:00Z',
    interactive: true,
  });
});

test('empty states distinguish indexing, nothing indexed, no folder, empty scope, and no match', () => {
  assert.equal(buildViewState(input({ sessions: undefined, indexing: true, scan: undefined })).emptyMessage, 'Indexing sessions…');

  const none = buildViewState(input({ sessions: [] }));
  assert.deepEqual(none.emptyActions, ['openSettings', 'refresh']);
  assert.match(none.emptyMessage ?? '', /^No sessions found/);

  const firstIndexFailed = buildViewState(input({ sessions: undefined, indexFailed: true, scan: undefined }));
  assert.deepEqual(firstIndexFailed.emptyActions, ['refresh']);
  assert.deepEqual(buildViewState(input({ sessions: undefined, indexFailed: true, indexing: true, scan: undefined })).emptyActions, []);

  const noFolder = buildViewState(input({ scope: 'project', context: { ...input().context, workspaceDirs: [], workspaceRepoKeys: new Set() } }));
  assert.equal(noFolder.emptyMessage, 'Open a folder to use Project scope, or switch to All.');
  assert.deepEqual(noFolder.emptyActions, []);

  const emptyScope = buildViewState(input({ scope: 'workspace', sessions: [SESSIONS[2]] }));
  assert.equal(emptyScope.emptyMessage, 'No sessions in Workspace scope. Switch to Project or All to see others.');

  assert.equal(buildViewState(input({ query: 'zzz' })).emptyMessage, 'No sessions match "zzz".');
  assert.equal(buildViewState(input()).emptyMessage, undefined);
});

test('notices report index failure, skipped lines, and unreadable files', () => {
  assert.deepEqual(buildViewState(input()).notices, []);

  const notices = buildViewState(input({ indexFailed: true, scan: { ...SCAN, skippedLines: 1, failed: 2 } })).notices;
  assert.deepEqual(notices, [
    'Indexing failed. See the Agent Session History output for details.',
    'Skipped 1 oversized transcript line over the 10.0 MB limit. The rest of each session was read.',
    '2 transcript files could not be read. See the Agent Session History output.',
  ]);
});

test('webview messages are accepted only in their documented shapes', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'setScope', scope: 'project' }), { type: 'setScope', scope: 'project' });
  assert.deepEqual(parseWebviewMessage({ type: 'open', key: 'claude:a', extra: 1 }), { type: 'open', key: 'claude:a' });
  assert.deepEqual(parseWebviewMessage({ type: 'refresh', key: 'x' }), { type: 'refresh' });

  assert.equal(parseWebviewMessage({ type: 'setScope', scope: 'everything' }), undefined);
  assert.equal(parseWebviewMessage({ type: 'setSort', sort: 'size' }), undefined);
  assert.deepEqual(parseWebviewMessage({ type: 'setQuery', query: 'a', seq: 3 }), { type: 'setQuery', query: 'a', seq: 3 });
  assert.equal(parseWebviewMessage({ type: 'setQuery', query: 42, seq: 1 }), undefined);
  assert.equal(parseWebviewMessage({ type: 'setQuery', query: 'x'.repeat(501), seq: 1 }), undefined);
  assert.equal(parseWebviewMessage({ type: 'setQuery', query: 'a' }), undefined);
  assert.equal(parseWebviewMessage({ type: 'setQuery', query: 'a', seq: -1 }), undefined);
  assert.equal(parseWebviewMessage({ type: 'setQuery', query: 'a', seq: 1.5 }), undefined);
  assert.equal(parseWebviewMessage({ type: 'open' }), undefined);
  assert.equal(parseWebviewMessage({ type: 'runCommand', command: 'rm' }), undefined);
  assert.equal(parseWebviewMessage('open'), undefined);
  assert.equal(parseWebviewMessage(null), undefined);
});
