import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_MAX_LINE_BYTES, SessionRecord } from '../src/model';
import { IndexCache } from '../src/index/cache';
import { SessionIndexer } from '../src/index/indexer';
import { sessionPaths, summarizePaths, summarizeSessions } from '../src/index/ownedPaths';
import { formatBytes } from '../src/view/format';

const fixtures = path.join(__dirname, '..', '..', 'test', 'fixtures');
let workDir: string;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'ash-owned-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function base(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    agent: 'claude',
    id: 'id',
    title: 't',
    messageCount: 0,
    subagentCount: 0,
    filePath: 'D:\\p\\abc.jsonl',
    interactive: true,
    isSubagent: false,
    skippedLines: 0,
    ...overrides,
  };
}

test('Claude session owns its transcript and the sibling directory of the same name', () => {
  assert.deepEqual(sessionPaths(base({})), ['D:\\p\\abc.jsonl', 'D:\\p\\abc']);
});

test('Codex session owns its pages and subagent rollouts, without duplicates', () => {
  const session = base({ agent: 'codex', filePath: 'b.jsonl', ownedFiles: ['a.jsonl', 'b.jsonl', 'sub.jsonl', 'b.jsonl'] });
  assert.deepEqual(sessionPaths(session), ['a.jsonl', 'b.jsonl', 'sub.jsonl']);
  assert.deepEqual(sessionPaths(base({ agent: 'codex', filePath: 'only.jsonl' })), ['only.jsonl']);
});

test('indexer records every page and descendant rollout as owned by the Codex session', async () => {
  const options = {
    claudeHome: path.join(fixtures, 'claude'),
    codexHome: path.join(fixtures, 'codex'),
    includeCodexArchived: false,
    includeNonInteractive: false,
    maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    concurrency: 4,
  };
  const { sessions } = await new SessionIndexer(new IndexCache(undefined)).build(options);
  const codex = sessions.find((s) => s.id === '0aaaaaaa-0000-7000-8000-000000000001');

  assert.ok(codex?.ownedFiles);
  assert.deepEqual(
    codex.ownedFiles.map((file) => path.basename(file)).sort(),
    [
      'rollout-2026-10-03T10-00-00-0aaaaaaa-0000-7000-8000-000000000001.jsonl',
      'rollout-2026-10-04T11-30-00-0aaaaaaa-0000-7000-8000-000000000003.jsonl',
      'rollout-2026-10-04T12-30-00-0aaaaaaa-0000-7000-8000-000000000005.jsonl',
      'rollout-2026-10-07T09-00-00-0aaaaaaa-0000-7000-8000-000000000001_0aaaaaaa-0000-7000-8000-0000000000f1.jsonl',
    ],
  );
});

test('summary counts files recursively, skips missing paths, and reports the newest mtime', async () => {
  const transcript = path.join(workDir, 's.jsonl');
  const sidecar = path.join(workDir, 's');
  await writeFile(transcript, '12345');
  await mkdir(path.join(sidecar, 'subagents'), { recursive: true });
  await writeFile(path.join(sidecar, 'subagents', 'agent-a.jsonl'), '1234567890');
  const old = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-02-01T00:00:00Z');
  await utimes(transcript, old, old);
  await utimes(path.join(sidecar, 'subagents', 'agent-a.jsonl'), newer, newer);
  await utimes(path.join(sidecar, 'subagents'), old, old);
  await utimes(sidecar, old, old);

  const summary = await summarizePaths([transcript, sidecar, path.join(workDir, 'missing.jsonl')]);

  assert.deepEqual(summary.existing, [transcript, sidecar]);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.totalBytes, 15);
  assert.equal(summary.newestMtimeMs, newer.getTime());
});

test('a batch summary combines sessions, counts shared paths once, and keeps each session newest mtime', async () => {
  const batchDir = path.join(workDir, 'batch');
  await mkdir(batchDir, { recursive: true });
  const first = path.join(batchDir, 'one.jsonl');
  const second = path.join(batchDir, 'two.jsonl');
  const shared = path.join(batchDir, 'shared.jsonl');
  await writeFile(first, '12');
  await writeFile(second, '1234');
  await writeFile(shared, '123456');
  const old = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-03-01T00:00:00Z');
  await utimes(first, old, old);
  await utimes(shared, old, old);
  await utimes(second, newer, newer);
  const sessions = [
    base({ agent: 'codex', id: 'one', filePath: first, ownedFiles: [first, shared] }),
    base({ agent: 'codex', id: 'two', filePath: second, ownedFiles: [second, shared] }),
    base({ agent: 'codex', id: 'gone', filePath: path.join(batchDir, 'gone.jsonl') }),
  ];

  const summary = await summarizeSessions(sessions);

  assert.deepEqual(summary.existing, [first, shared, second]);
  assert.equal(summary.fileCount, 3);
  assert.equal(summary.totalBytes, 12);
  assert.equal(summary.newestMtimeMs, newer.getTime());
  assert.deepEqual(summary.newestPerSession, [old.getTime(), newer.getTime(), 0]);
});

test('links inside a session directory are counted as themselves and not followed', async () => {
  const outside = path.join(workDir, 'outside');
  const sidecar = path.join(workDir, 'linked');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'big.bin'), Buffer.alloc(4096));
  await mkdir(sidecar, { recursive: true });
  await writeFile(path.join(sidecar, 'own.jsonl'), 'abc');
  await symlink(outside, path.join(sidecar, 'to-outside'), 'junction');
  await symlink(sidecar, path.join(sidecar, 'to-self'), 'junction');

  const summary = await summarizePaths([sidecar]);

  assert.equal(summary.fileCount, 3);
  assert.ok(summary.totalBytes < 4096);
});

test('byte formatting', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB');
});
