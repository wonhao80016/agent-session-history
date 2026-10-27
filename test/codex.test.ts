import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MAX_LINE_BYTES } from '../src/model';
import { parseCodexSession, readCodexTitleIndex } from '../src/sources/codex';

const codexHome = path.join(__dirname, '..', '..', 'test', 'fixtures', 'codex');
const sessionsDir = path.join(codexHome, 'sessions', '2026', '10');
const options = { maxLineBytes: DEFAULT_MAX_LINE_BYTES };

test('title index keeps the newest name and ignores malformed or nameless entries', async () => {
  const titles = await readCodexTitleIndex(path.join(codexHome, 'session_index.jsonl'), options);

  assert.equal(titles.size, 1);
  assert.equal(titles.get('0aaaaaaa-0000-7000-8000-000000000001'), 'Rename config loader');
});

test('missing title index yields an empty map', async () => {
  const titles = await readCodexTitleIndex(path.join(codexHome, 'missing.jsonl'), options);

  assert.equal(titles.size, 0);
});

test('interactive VS Code session skips injected messages, unwraps the IDE request, and ignores compacted and truncated records', async () => {
  const titles = await readCodexTitleIndex(path.join(codexHome, 'session_index.jsonl'), options);
  const filePath = path.join(sessionsDir, '03', 'rollout-2026-10-03T10-00-00-0aaaaaaa-0000-7000-8000-000000000001.jsonl');
  const session = await parseCodexSession(filePath, titles, options);

  assert.ok(session);
  assert.equal(session.agent, 'codex');
  assert.equal(session.id, '0aaaaaaa-0000-7000-8000-000000000001');
  assert.equal(session.title, 'Rename config loader');
  assert.equal(session.firstPrompt, 'Rename the config loader');
  assert.equal(session.lastReply, 'Docs updated in README.');
  assert.equal(session.messageCount, 4);
  assert.equal(session.model, 'gpt-5.6-sol');
  assert.equal(session.gitBranch, 'feat/config-loader');
  assert.equal(session.cwd, 'D:\\work\\demo');
  assert.equal(session.startedAt, '2026-10-03T10:00:00.000Z');
  assert.equal(session.updatedAt, '2026-10-03T10:05:30.000Z');
  assert.equal(session.interactive, true);
  assert.equal(session.parentId, undefined);
});

test('exec session is non-interactive and titled by its first prompt', async () => {
  const filePath = path.join(sessionsDir, '04', 'rollout-2026-10-04T11-00-00-0aaaaaaa-0000-7000-8000-000000000002.jsonl');
  const session = await parseCodexSession(filePath, new Map(), options);

  assert.ok(session);
  assert.equal(session.interactive, false);
  assert.equal(session.title, 'Review the diff');
  assert.equal(session.messageCount, 1);
});

test('subagent thread records its parent and is not interactive', async () => {
  const filePath = path.join(sessionsDir, '04', 'rollout-2026-10-04T11-30-00-0aaaaaaa-0000-7000-8000-000000000003.jsonl');
  const session = await parseCodexSession(filePath, new Map(), options);

  assert.ok(session);
  assert.equal(session.parentId, '0aaaaaaa-0000-7000-8000-000000000001');
  assert.equal(session.interactive, false);
});

test('review subagent without a parent thread is still non-interactive', async () => {
  const filePath = path.join(sessionsDir, '04', 'rollout-2026-10-04T12-00-00-0aaaaaaa-0000-7000-8000-000000000004.jsonl');
  const session = await parseCodexSession(filePath, new Map(), options);

  assert.ok(session);
  assert.equal(session.parentId, undefined);
  assert.equal(session.interactive, false);
});

test('rollout without session_meta is rejected', async () => {
  const filePath = path.join(sessionsDir, '05', 'rollout-2026-10-05T12-00-00-no-meta.jsonl');

  assert.equal(await parseCodexSession(filePath, new Map(), options), undefined);
});
