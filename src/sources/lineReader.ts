import { createReadStream } from 'node:fs';

export type LineEvent = { kind: 'line'; text: string } | { kind: 'skipped'; bytes: number };

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * Streams a file line by line; lines longer than maxLineBytes (excluding the line terminator)
 * are reported as skipped without being buffered.
 */
export async function* readLines(filePath: string, maxLineBytes: number): AsyncGenerator<LineEvent> {
  let parts: Buffer[] = [];
  let length = 0;
  let lastByte = -1;
  let oversized = false;

  const flush = (): LineEvent | undefined => {
    const contentLength = lastByte === CARRIAGE_RETURN ? length - 1 : length;
    let event: LineEvent | undefined;
    if (oversized || contentLength > maxLineBytes) {
      event = { kind: 'skipped', bytes: contentLength };
    } else if (contentLength > 0) {
      event = { kind: 'line', text: Buffer.concat(parts, length).subarray(0, contentLength).toString('utf8') };
    }
    parts = [];
    length = 0;
    lastByte = -1;
    oversized = false;
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

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
