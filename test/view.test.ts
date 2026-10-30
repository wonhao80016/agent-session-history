import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SessionRecord } from '../src/model';
import { normalizePath, displayName } from '../src/scope/paths';
import { countOf, relativeTime } from '../src/view/format';
import { groupIdentity, ScopeContext } from '../src/scope/filter';
import { groupSessions } from '../src/view/grouping';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');

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

test('relative time buckets', () => {
  assert.equal(relativeTime('2026-10-27T11:59:30.000Z', NOW), 'just now');
  assert.equal(relativeTime('2026-10-27T11:57:00.000Z', NOW), '3m ago');
  assert.equal(relativeTime('2026-10-27T07:00:00.000Z', NOW), '5h ago');
  assert.equal(relativeTime('2026-10-25T12:00:00.000Z', NOW), '2d ago');
  assert.equal(relativeTime('2026-07-27T12:00:00.000Z', NOW), '3mo ago');
  assert.equal(relativeTime('2024-10-01T12:00:00.000Z', NOW), '2y ago');
  assert.equal(relativeTime(undefined, NOW), 'unknown');
});

test('counts use a singular noun only for one', () => {
  assert.equal(countOf(1, 'msg'), '1 msg');
  assert.equal(countOf(0, 'msg'), '0 msgs');
  assert.equal(countOf(22, 'subagent'), '22 subagents');
});

test('Windows paths compare case- and separator-insensitively', () => {
  assert.equal(normalizePath('D:/codebase/Demo/', 'win32'), normalizePath('d:\\codebase\\demo', 'win32'));
  assert.notEqual(normalizePath('/home/a/Demo', 'linux'), normalizePath('/home/a/demo', 'linux'));
  assert.equal(normalizePath('/home/a/demo/', 'linux'), '/home/a/demo');
  assert.equal(displayName('D:\\codebase\\stock_panel\\'), 'stock_panel');
});

test('groups by directory when no repository is known, newest group and newest session first', () => {
  const context: ScopeContext = { workspaceDirs: [], workspaceRepoKeys: new Set(), repoOf: () => undefined, isMissingDir: () => false, platform: 'win32' };
  const groups = groupSessions(
    [
      session({ id: 'a', cwd: 'D:\\x\\alpha', updatedAt: '2026-10-01T00:00:00Z' }),
      session({ id: 'b', cwd: 'd:/x/alpha', updatedAt: '2026-10-05T00:00:00Z' }),
      session({ id: 'c', cwd: 'D:\\x\\beta', updatedAt: '2026-10-03T00:00:00Z' }),
      session({ id: 'd', updatedAt: '2026-09-01T00:00:00Z' }),
    ],
    (s) => groupIdentity(s, context),
  );

  assert.deepEqual(
    groups.map((g) => [g.label, g.sessions.map((s) => s.id)]),
    [['alpha', ['b', 'a']], ['beta', ['c']], ['Unknown directory', ['d']]],
  );
});
