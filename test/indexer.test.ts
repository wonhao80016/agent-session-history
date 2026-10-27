import { strict as assert } from 'node:assert';
import { appendFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_MAX_LINE_BYTES } from '../src/model';
import { IndexCache } from '../src/index/cache';
import { IndexOptions, SessionIndexer } from '../src/index/indexer';

const fixtures = path.join(__dirname, '..', '..', 'test', 'fixtures');
const CODEX_PAGED_ID = '0aaaaaaa-0000-7000-8000-000000000001';
const FILE_COUNT = 9;
let workDir: string;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'ash-indexer-'));
  await cp(fixtures, path.join(workDir, 'data'), { recursive: true });
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function options(overrides: Partial<IndexOptions> = {}): IndexOptions {
  return {
    claudeHome: path.join(workDir, 'data', 'claude'),
    codexHome: path.join(workDir, 'data', 'codex'),
    includeCodexArchived: false,
    includeNonInteractive: false,
    maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    concurrency: 4,
    ...overrides,
  };
}

test('lists interactive top-level sessions newest first with Codex titles and descendant counts', async () => {
  const indexer = new SessionIndexer(new IndexCache(undefined));
  const { sessions, stats } = await indexer.build(options());

  assert.deepEqual(
    sessions.map((s) => s.id),
    [CODEX_PAGED_ID, '33333333-aaaa-4bbb-8ccc-000000000003', '11111111-aaaa-4bbb-8ccc-000000000001'],
  );
  const codex = sessions[0];
  assert.equal(codex.title, 'Rename config loader');
  assert.equal(codex.subagentCount, 1);
  assert.deepEqual({ files: stats.files, parsed: stats.parsed, cached: stats.cached, failed: stats.failed }, {
    files: FILE_COUNT,
    parsed: FILE_COUNT,
    cached: 0,
    failed: 0,
  });
});

test('paginated Codex thread is merged into one session', async () => {
  const indexer = new SessionIndexer(new IndexCache(undefined));
  const { sessions } = await indexer.build(options());
  const paged = sessions.filter((s) => s.id === CODEX_PAGED_ID);

  assert.equal(paged.length, 1);
  const [session] = paged;
  assert.equal(session.messageCount, 6);
  assert.equal(session.firstPrompt, 'Rename the config loader');
  assert.equal(session.lastReply, 'Changelog updated.');
  assert.equal(session.model, 'test-model-b');
  assert.equal(session.gitBranch, 'feat/config-loader');
  assert.equal(session.startedAt, '2026-10-03T10:00:00.000Z');
  assert.equal(session.updatedAt, '2026-10-07T09:01:00.000Z');
  assert.ok(session.filePath.endsWith('0000000000f1.jsonl'));
});

test('non-interactive sessions are opt-in while subagent threads stay hidden', async () => {
  const indexer = new SessionIndexer(new IndexCache(undefined));
  const { sessions } = await indexer.build(options({ includeNonInteractive: true }));
  const ids = sessions.map((s) => s.id);

  assert.equal(sessions.length, 5);
  assert.ok(ids.includes('22222222-aaaa-4bbb-8ccc-000000000002'));
  assert.ok(ids.includes('0aaaaaaa-0000-7000-8000-000000000002'));
  assert.ok(!ids.includes('0aaaaaaa-0000-7000-8000-000000000003'));
  assert.ok(!ids.includes('0aaaaaaa-0000-7000-8000-000000000004'));
});

test('persisted cache skips unchanged files and reparses modified ones', async () => {
  const cacheFile = path.join(workDir, 'cache-reuse', 'index.json');
  const first = await new SessionIndexer(new IndexCache(cacheFile)).build(options());
  assert.equal(first.stats.parsed, FILE_COUNT);

  const reloaded = new IndexCache(cacheFile);
  await reloaded.load();
  const second = await new SessionIndexer(reloaded).build(options());
  assert.equal(second.stats.parsed, 0);
  assert.equal(second.stats.cached, FILE_COUNT);
  assert.deepEqual(JSON.parse(JSON.stringify(second.sessions)), JSON.parse(JSON.stringify(first.sessions)));

  const exec = path.join(workDir, 'data', 'codex', 'sessions', '2026', '10', '04', 'rollout-2026-10-04T11-00-00-0aaaaaaa-0000-7000-8000-000000000002.jsonl');
  await appendFile(exec, '{"timestamp":"2026-10-04T11:10:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}\n');
  const third = await new SessionIndexer(reloaded).build(options());
  assert.equal(third.stats.parsed, 1);
  assert.equal(third.stats.cached, FILE_COUNT - 1);
});

test('cache is discarded when parse options change', async () => {
  const cacheFile = path.join(workDir, 'cache-options', 'index.json');
  await new SessionIndexer(new IndexCache(cacheFile)).build(options());

  const reloaded = new IndexCache(cacheFile);
  await reloaded.load();
  const result = await new SessionIndexer(reloaded).build(options({ maxLineBytes: 200 }));

  assert.equal(result.stats.cached, 0);
  assert.equal(result.stats.parsed, FILE_COUNT);
  assert.ok(result.stats.skippedLines > 0);
});

test('build waits for an in-flight cache load before applying parse options', async () => {
  const cacheFile = path.join(workDir, 'cache-race', 'index.json');
  await new SessionIndexer(new IndexCache(cacheFile)).build(options());

  const reloaded = new IndexCache(cacheFile);
  const loading = reloaded.load();
  const result = await new SessionIndexer(reloaded).build(options({ maxLineBytes: 200 }));
  await loading;

  assert.equal(result.stats.cached, 0);
  assert.equal(result.stats.parsed, FILE_COUNT);
});

test('cache with another schema version is discarded', async () => {
  const cacheFile = path.join(workDir, 'cache-version', 'index.json');
  await new SessionIndexer(new IndexCache(cacheFile)).build(options());
  await writeFile(cacheFile, JSON.stringify({ version: 0, optionsKey: '', entries: {} }), 'utf8');

  const reloaded = new IndexCache(cacheFile);
  await reloaded.load();
  const result = await new SessionIndexer(reloaded).build(options());

  assert.equal(result.stats.cached, 0);
  assert.equal(result.stats.parsed, FILE_COUNT);
});

test('missing data directories produce an empty result', async () => {
  const indexer = new SessionIndexer(new IndexCache(undefined));
  const { sessions, stats } = await indexer.build(
    options({ claudeHome: path.join(workDir, 'nope'), codexHome: path.join(workDir, 'nope') }),
  );

  assert.equal(sessions.length, 0);
  assert.equal(stats.files, 0);
});
