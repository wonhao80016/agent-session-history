import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { claudeCanOpenInWindow, claudeProjectDirMatches, claudeProjectDirName } from '../src/resume/claudeWindow';
import { parsePendingResume, PENDING_RESUME_TTL_MS, PendingResume, takePendingResume, writePendingResume } from '../src/resume/handoff';
import { parseWorktreeList } from '../src/scope/gitRepo';

const ID = '11111111-aaaa-4bbb-8ccc-000000000001';
const NOW = Date.parse('2026-10-28T09:00:00.000Z');
let workDir: string;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'ash-resume-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test('Claude project directory names replace every non-alphanumeric character', () => {
  assert.equal(claudeProjectDirName('D:\\codebase\\side_proj\\ai_terminal'), 'D--codebase-side-proj-ai-terminal');
  assert.equal(claudeProjectDirName('C:/Users/me/orca/workspaces/app.v2'), 'C--Users-me-orca-workspaces-app-v2');
  assert.equal(claudeProjectDirName('/home/me/app'), '-home-me-app');
});

test('a Claude session opens in this window only when its project dir belongs to the window folder or a worktree', () => {
  const transcript = (dir: string): string => path.join('C:\\Users\\me\\.claude\\projects', dir, `${ID}.jsonl`);
  const windowDirs = ['d:\\code\\app', 'D:/code/app-wt'];

  assert.ok(claudeCanOpenInWindow(transcript('D--code-app'), windowDirs, 'win32'));
  assert.ok(claudeCanOpenInWindow(transcript('D--code-app-wt'), windowDirs, 'win32'));
  assert.ok(!claudeCanOpenInWindow(transcript('D--code-app-frontend'), windowDirs, 'win32'));
  assert.ok(!claudeCanOpenInWindow(transcript('D--code-other'), windowDirs, 'win32'));
  assert.ok(!claudeCanOpenInWindow(transcript('D--code-app'), windowDirs, 'linux'));
  assert.ok(!claudeCanOpenInWindow(transcript('D--code-app'), [], 'win32'));
});

test('project dir names over 200 characters match on the kept prefix and ignore the hash suffix', () => {
  const longCwd = `D:\\${'deep\\'.repeat(45)}app`;
  const encoded = claudeProjectDirName(longCwd);
  assert.ok(encoded.length > 200);
  const stored = `${encoded.slice(0, 200)}-1k3j9x`;

  assert.ok(claudeProjectDirMatches(stored, longCwd, 'win32'));
  assert.ok(!claudeProjectDirMatches(encoded, longCwd, 'win32'));
  assert.ok(!claudeProjectDirMatches(`${encoded.slice(0, 199)}-1k3j9x`, longCwd, 'win32'));
  assert.ok(claudeProjectDirMatches('d--code-app', 'D:\\code\\app', 'win32'));
  assert.ok(!claudeProjectDirMatches('d--code-app', 'D:\\code\\app', 'linux'));
});

test('worktree list keeps only worktree paths from porcelain output', () => {
  const porcelain = [
    'worktree D:/code/app',
    'HEAD 0123456789abcdef0123456789abcdef01234567',
    'branch refs/heads/main',
    '',
    'worktree D:/code/app-wt',
    'HEAD 89abcdef0123456789abcdef0123456789abcdef',
    'detached',
    '',
  ].join('\r\n');

  assert.deepEqual(parseWorktreeList(porcelain), ['D:/code/app', 'D:/code/app-wt']);
  assert.deepEqual(parseWorktreeList(''), []);
});

test('pending resume parsing rejects malformed entries and non-UUID IDs', () => {
  const valid: PendingResume = { id: ID, folder: 'D:\\code\\app', createdAt: NOW };
  assert.deepEqual(parsePendingResume(JSON.stringify(valid)), valid);
  assert.equal(parsePendingResume('not json'), undefined);
  assert.equal(parsePendingResume('null'), undefined);
  assert.equal(parsePendingResume(JSON.stringify({ ...valid, id: '--dangerously-skip-permissions' })), undefined);
  assert.equal(parsePendingResume(JSON.stringify({ ...valid, folder: '' })), undefined);
  assert.equal(parsePendingResume(JSON.stringify({ ...valid, createdAt: 'now' })), undefined);
});

test('only the window on the target folder takes a pending resume, and only once', async () => {
  const file = path.join(workDir, 'take', 'pending-resume.json');
  await writePendingResume(file, { id: ID, folder: 'D:\\code\\app', createdAt: NOW });

  assert.equal(await takePendingResume(file, 'D:\\code\\other', NOW + 1_000, 'win32'), undefined);
  assert.equal(await takePendingResume(file, '', NOW + 1_000, 'win32'), undefined);
  assert.ok(JSON.parse(await readFile(file, 'utf8')));

  const taken = await takePendingResume(file, 'd:/code/app/', NOW + 1_000, 'win32');
  assert.equal(taken?.id, ID);
  assert.equal(await takePendingResume(file, 'D:\\code\\app', NOW + 1_000, 'win32'), undefined);
});

test('expired or malformed pending resumes are discarded by any window', async () => {
  const expired = path.join(workDir, 'expired.json');
  await writePendingResume(expired, { id: ID, folder: 'D:\\code\\app', createdAt: NOW });
  assert.equal(await takePendingResume(expired, '', NOW + PENDING_RESUME_TTL_MS + 1, 'win32'), undefined);
  await assert.rejects(readFile(expired, 'utf8'));

  const malformed = path.join(workDir, 'malformed.json');
  await writeFile(malformed, '{"id":1}', 'utf8');
  assert.equal(await takePendingResume(malformed, 'D:\\code\\app', NOW, 'win32'), undefined);
  await assert.rejects(readFile(malformed, 'utf8'));

  assert.equal(await takePendingResume(path.join(workDir, 'missing.json'), 'D:\\code\\app', NOW, 'win32'), undefined);
});
