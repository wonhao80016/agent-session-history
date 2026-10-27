import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { LineEvent, readLines } from '../src/sources/lineReader';

let workDir: string;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'ash-linereader-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function collect(content: string | Buffer, maxLineBytes: number): Promise<LineEvent[]> {
  const filePath = path.join(workDir, `case-${Math.random().toString(36).slice(2)}.jsonl`);
  await writeFile(filePath, content);
  const events: LineEvent[] = [];
  for await (const event of readLines(filePath, maxLineBytes)) {
    events.push(event);
  }
  return events;
}

test('splits LF and CRLF lines and keeps a final line without newline', async () => {
  const events = await collect('a\r\nb\nc', 100);

  assert.deepEqual(events, [
    { kind: 'line', text: 'a' },
    { kind: 'line', text: 'b' },
    { kind: 'line', text: 'c' },
  ]);
});

test('reports an oversized line as skipped and resumes on the next line', async () => {
  const events = await collect(`ok\n${'x'.repeat(50)}\nafter\n`, 10);

  assert.deepEqual(events, [
    { kind: 'line', text: 'ok' },
    { kind: 'skipped', bytes: 50, head: 'x'.repeat(50) },
    { kind: 'line', text: 'after' },
  ]);
});

test('the size limit excludes the CRLF terminator', async () => {
  const events = await collect('abc\r\nabcd\r\nab\r\n', 3);

  assert.deepEqual(events, [
    { kind: 'line', text: 'abc' },
    { kind: 'skipped', bytes: 4, head: 'abcd' },
    { kind: 'line', text: 'ab' },
  ]);
});

test('a skipped line keeps only its first 4 KB as head, even across stream chunks', async () => {
  const line = `{"type":"event_msg"}${'z'.repeat(300_000)}`;
  const events = await collect(`${line}\nnext\n`, 100_000);

  assert.equal(events.length, 2);
  const [skipped] = events;
  assert.equal(skipped.kind, 'skipped');
  assert.ok(skipped.kind === 'skipped' && skipped.bytes === line.length && skipped.head === line.slice(0, 4096));
  assert.deepEqual(events[1], { kind: 'line', text: 'next' });
});

test('handles a line spanning many stream chunks', async () => {
  const long = 'y'.repeat(200_000);
  const events = await collect(`${long}\nend\n`, 1_000_000);

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: 'line', text: long });
});

test('decodes multi-byte UTF-8 split across chunk boundaries', async () => {
  const text = '測試'.repeat(40_000);
  const events = await collect(`${text}\n`, 10_000_000);

  assert.deepEqual(events, [{ kind: 'line', text }]);
});

test('skips empty lines', async () => {
  const events = await collect('\n\na\n\n', 100);

  assert.deepEqual(events, [{ kind: 'line', text: 'a' }]);
});
