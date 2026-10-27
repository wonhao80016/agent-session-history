import { createReadStream } from 'node:fs';

/** A skipped line carries its first bytes as `head`, enough for a parser to tell which record type it was. */
export type LineEvent = { kind: 'line'; text: string } | { kind: 'skipped'; bytes: number; head: string };

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const HEAD_BYTES = 4096;

/**
 * Streams a file line by line; lines longer than maxLineBytes (excluding the line terminator)
 * are reported as skipped without being buffered.
 */
export async function* readLines(filePath: string, maxLineBytes: number): AsyncGenerator<LineEvent> {
  let parts: Buffer[] = [];
  let length = 0;
  let lastByte = -1;
  let oversized = false;
  let head: Buffer | undefined;

  const flush = (): LineEvent | undefined => {
    const contentLength = lastByte === CARRIAGE_RETURN ? length - 1 : length;
    let event: LineEvent | undefined;
    if (oversized || contentLength > maxLineBytes) {
      const start = head ?? firstBytes(parts, HEAD_BYTES);
      event = { kind: 'skipped', bytes: contentLength, head: start.subarray(0, Math.min(HEAD_BYTES, contentLength)).toString('utf8') };
    } else if (contentLength > 0) {
      event = { kind: 'line', text: Buffer.concat(parts, length).subarray(0, contentLength).toString('utf8') };
    }
    parts = [];
    length = 0;
    lastByte = -1;
    oversized = false;
    head = undefined;
    return event;
  };

  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      if (piece.length > 0) {
        length += piece.length;
        lastByte = piece[piece.length - 1];
      }
      // One extra byte is tolerated while streaming because it may be a CR that flush() strips.
      if (length > maxLineBytes + 1) {
        if (!oversized) {
          head = firstBytes([...parts, piece], HEAD_BYTES);
        }
        oversized = true;
        parts = [];
      } else if (!oversized) {
        parts.push(piece);
      }
      if (newline === -1) {
        break;
      }
      const event = flush();
      if (event) {
        yield event;
      }
      start = newline + 1;
    }
  }

  const tail = flush();
  if (tail) {
    yield tail;
  }
}

function firstBytes(buffers: readonly Buffer[], count: number): Buffer {
  const kept: Buffer[] = [];
  let total = 0;
  for (const buffer of buffers) {
    if (total >= count) {
      break;
    }
    const slice = buffer.subarray(0, count - total);
    kept.push(slice);
    total += slice.length;
  }
  return Buffer.concat(kept, total);
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
