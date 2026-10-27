import { strict as assert } from 'node:assert';
import { mock, test } from 'node:test';
import { resumeCommand } from '../src/commandLine';
import { SessionRecord } from '../src/model';
import { RefreshScheduler } from '../src/index/refreshScheduler';
import { matchesQuery } from '../src/scope/search';

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    agent: 'claude',
    id: '11111111-aaaa-4bbb-8ccc-000000000001',
    title: 'Fetch helper retry',
    firstPrompt: 'Add a retry flag',
    lastReply: 'Tests added and passing.',
    messageCount: 4,
    subagentCount: 0,
    model: 'claude-opus-5-5',
    gitBranch: 'feat/retry',
    cwd: 'D:\\work\\demo',
    filePath: 'x.jsonl',
    interactive: true,
    isSubagent: false,
    skippedLines: 0,
    ...overrides,
  };
}

test('resume command per agent', () => {
  assert.equal(resumeCommand(session({})), 'claude --resume 11111111-aaaa-4bbb-8ccc-000000000001');
  assert.equal(
    resumeCommand(session({ agent: 'codex', id: '01A12AA3-270E-7120-8DB1-B604B08E3EBE' })),
    'codex resume 01A12AA3-270E-7120-8DB1-B604B08E3EBE',
  );
});

test('resume command refuses anything that is not a UUID', () => {
  const refused = [
    'a; rm -rf /',
    '$(whoami)',
    'a b',
    '`x`',
    'a&b',
    '',
    '..\\x',
    '-x',
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
    '01a12aa3-270e-7120',
    '11111111-aaaa-4bbb-8ccc-000000000001 --yolo',
    '11111111-aaaa-4bbb-8ccc-000000000001\n',
  ];
  for (const id of refused) {
    assert.equal(resumeCommand(session({ id })), undefined, id);
  }
});

test('search terms all have to match, case-insensitively, across fields', () => {
  const s = session({});
  assert.ok(matchesQuery(s, ''));
  assert.ok(matchesQuery(s, '  '));
  assert.ok(matchesQuery(s, 'RETRY'));
  assert.ok(matchesQuery(s, 'retry passing'));
  assert.ok(matchesQuery(s, 'feat/retry opus'));
  assert.ok(matchesQuery(s, 'work\\demo'));
  assert.ok(matchesQuery(s, '11111111'));
  assert.ok(!matchesQuery(s, 'retry missing'));
  assert.ok(!matchesQuery(session({ firstPrompt: undefined, lastReply: undefined }), 'passing'));
});

test('scheduler runs once per interval however many events arrive, and dispose cancels', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let runs = 0;
    const scheduler = new RefreshScheduler(10_000, () => runs++);
    scheduler.notify();
    mock.timers.tick(4_000);
    scheduler.notify();
    scheduler.notify();
    mock.timers.tick(6_000);
    assert.equal(runs, 1);

    scheduler.notify();
    mock.timers.tick(9_999);
    assert.equal(runs, 1);
    mock.timers.tick(1);
    assert.equal(runs, 2);

    scheduler.notify();
    scheduler.dispose();
    mock.timers.tick(20_000);
    assert.equal(runs, 2);
  } finally {
    mock.timers.reset();
  }
});
