import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MAX_LINE_BYTES, UNTITLED } from '../src/model';
import { parseClaudeSession } from '../src/sources/claude';

const projectDir = path.join(__dirname, '..', '..', 'test', 'fixtures', 'claude', 'D--work-demo');
const options = { maxLineBytes: DEFAULT_MAX_LINE_BYTES };

test('interactive session: title, counts, model, branch, subagents; truncated JSON lines are ignored', async () => {
  const filePath = path.join(projectDir, '11111111-aaaa-4bbb-8ccc-000000000001.jsonl');
  const session = await parseClaudeSession(filePath, options);

  assert.equal(session.agent, 'claude');
  assert.equal(session.id, '11111111-aaaa-4bbb-8ccc-000000000001');
  assert.equal(session.title, 'Fetch helper retry and tests');
  assert.equal(session.firstPrompt, 'Add a retry flag to the fetch helper');
  assert.equal(session.lastReply, 'Tests added and passing.');
  assert.equal(session.messageCount, 4);
  assert.equal(session.model, 'claude-sonnet-5-5');
  assert.equal(session.gitBranch, 'feat/retry');
  assert.equal(session.cwd, 'D:\\work\\demo');
  assert.equal(session.startedAt, '2026-10-01T08:00:00.000Z');
  assert.equal(session.updatedAt, '2026-10-01T08:04:00.000Z');
  assert.equal(session.subagentCount, 2);
  assert.equal(session.interactive, true);
  assert.equal(session.skippedLines, 0);
});

test('print-mode session is non-interactive and falls back to the first typed prompt', async () => {
  const filePath = path.join(projectDir, '22222222-aaaa-4bbb-8ccc-000000000002.jsonl');
  const session = await parseClaudeSession(filePath, options);

  assert.equal(session.interactive, false);
  assert.equal(session.messageCount, 2);
  assert.equal(Array.from(session.title).length, 120);
  assert.ok(session.title.startsWith('Summarize the open review findings'));
  assert.ok(session.title.endsWith('…'));
  assert.equal(session.subagentCount, 0);
  assert.equal(session.gitBranch, undefined);
});

test('session without an AI title or typed prompt is untitled', async () => {
  const filePath = path.join(projectDir, '33333333-aaaa-4bbb-8ccc-000000000003.jsonl');
  const session = await parseClaudeSession(filePath, options);

  assert.equal(session.title, UNTITLED);
  assert.equal(session.firstPrompt, undefined);
  assert.equal(session.lastReply, undefined);
  assert.equal(session.messageCount, 0);
  assert.equal(session.model, 'claude-opus-5-5');
  assert.equal(session.interactive, true);
});

test('lines over the size limit are skipped and counted', async () => {
  const filePath = path.join(projectDir, '11111111-aaaa-4bbb-8ccc-000000000001.jsonl');
  const session = await parseClaudeSession(filePath, { maxLineBytes: 200 });

  assert.equal(session.skippedLines, 8);
  assert.equal(session.title, 'Fetch helper retry and tests');
  assert.equal(session.messageCount, 0);
});
