import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { SessionRecord } from '../src/model';
import { filterByScope, groupIdentity, isInside, ScopeContext } from '../src/scope/filter';
import { GitRepoResolver, RepoInfo } from '../src/scope/gitRepo';
import { groupSessions } from '../src/view/grouping';

function session(id: string, cwd: string | undefined, updatedAt = '2026-10-01T00:00:00Z'): SessionRecord {
  return {
    agent: 'claude',
    id,
    title: id,
    messageCount: 1,
    subagentCount: 0,
    cwd,
    updatedAt,
    filePath: `${id}.jsonl`,
    interactive: true,
    isSubagent: false,
    skippedLines: 0,
  };
}

const repoA: RepoInfo = { key: 'd:\\code\\app\\.git', root: 'D:\\code\\app', name: 'app' };
const repos = new Map<string, RepoInfo>([
  ['d:\\code\\app', repoA],
  ['d:\\code\\app\\src', repoA],
  ['c:\\worktrees\\app-fix', repoA],
]);

function context(workspaceDirs: string[]): ScopeContext {
  const repoOf = (dir: string) => repos.get(dir.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, ''));
  const workspaceRepoKeys = new Set(workspaceDirs.map(repoOf).filter((r): r is RepoInfo => r !== undefined).map((r) => r.key));
  return { workspaceDirs, workspaceRepoKeys, repoOf, platform: 'win32' };
}

const sessions = [
  session('root', 'D:\\code\\app'),
  session('nested', 'd:/code/app/src'),
  session('worktree', 'C:\\worktrees\\app-fix'),
  session('deleted-worktree-in-workspace', 'D:\\code\\app\\old-wt'),
  session('sibling-prefix', 'D:\\code\\application'),
  session('other', 'D:\\code\\other'),
  session('no-cwd', undefined),
];

test('isInside respects path boundaries and Windows case rules', () => {
  assert.ok(isInside('D:\\code\\app\\src', 'd:/code/app', 'win32'));
  assert.ok(isInside('D:\\code\\app', 'D:\\code\\app\\', 'win32'));
  assert.ok(!isInside('D:\\code\\application', 'D:\\code\\app', 'win32'));
  assert.ok(isInside('D:\\anything', 'D:\\', 'win32'));
  assert.ok(!isInside('/home/a/App', '/home/a/app', 'linux'));
});

test('workspace scope keeps sessions under a workspace folder only', () => {
  const ids = filterByScope(sessions, 'workspace', context(['D:\\code\\app'])).map((s) => s.id);

  assert.deepEqual(ids, ['root', 'nested', 'deleted-worktree-in-workspace']);
});

test('project scope adds linked worktrees of the workspace repository', () => {
  const ids = filterByScope(sessions, 'project', context(['D:\\code\\app'])).map((s) => s.id);

  assert.deepEqual(ids, ['root', 'nested', 'worktree', 'deleted-worktree-in-workspace']);
});

test('without a workspace folder only All scope lists sessions', () => {
  assert.equal(filterByScope(sessions, 'workspace', context([])).length, 0);
  assert.equal(filterByScope(sessions, 'project', context([])).length, 0);
  assert.equal(filterByScope(sessions, 'all', context([])).length, sessions.length);
});

test('a repository and its worktrees share one group named after the repository', () => {
  const ctx = context(['D:\\code\\app']);
  const groups = groupSessions(
    [session('root', 'D:\\code\\app', '2026-10-01T00:00:00Z'), session('worktree', 'C:\\worktrees\\app-fix', '2026-10-02T00:00:00Z'), session('other', 'D:\\code\\other')],
    (s) => groupIdentity(s, ctx),
  );

  assert.deepEqual(groups.map((g) => [g.label, g.sessions.map((s) => s.id)]), [
    ['app', ['worktree', 'root']],
    ['other', ['other']],
  ]);
  assert.equal(groups[0].path, 'D:\\code\\app');
});

test('resolver runs git once per normalized directory and can retry misses', async () => {
  const calls: string[] = [];
  const resolver = new GitRepoResolver(async (dir) => {
    calls.push(dir);
    return dir.toLowerCase().startsWith('d:\\code\\app') ? 'D:/code/app/.git' : undefined;
  }, 'win32');

  await resolver.resolveAll(['D:\\code\\app', 'd:/code/app/', 'D:\\code\\none']);
  assert.equal(calls.length, 2);
  assert.deepEqual(resolver.lookup('D:\\CODE\\APP'), { key: 'd:\\code\\app\\.git', root: 'D:/code/app', name: 'app' });
  assert.equal(resolver.lookup('D:\\code\\none'), undefined);

  await resolver.resolveAll(['D:\\code\\none']);
  assert.equal(calls.length, 2);
  resolver.forgetMisses();
  await resolver.resolveAll(['D:\\code\\none']);
  assert.equal(calls.length, 3);
});

let workDir: string;

before(async () => {
  workDir = await realpath(await mkdtemp(path.join(tmpdir(), 'ash-git-')));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test('real git: a linked worktree resolves to the same repository as its main checkout', async () => {
  const main = path.join(workDir, 'main');
  const linked = path.join(workDir, 'linked');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', main], { stdio: 'pipe' });
  await writeFile(path.join(main, 'readme.txt'), 'x');
  git(main, 'add', 'readme.txt');
  git(main, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'side', linked);

  const resolver = new GitRepoResolver();
  await resolver.resolveAll([main, linked, path.join(workDir, 'not-a-repo')]);

  const mainRepo = resolver.lookup(main);
  assert.ok(mainRepo);
  assert.deepEqual(resolver.lookup(linked), mainRepo);
  assert.equal(mainRepo.name, 'main');
  assert.equal(resolver.lookup(path.join(workDir, 'not-a-repo')), undefined);
});
