import { ParseOptions, SessionRecord, UNTITLED } from '../model';
import { readLines, tryParseJson } from './lineReader';
import { asString, extractText, isObject, looksInjected, summarize } from './text';

const NON_INTERACTIVE_SOURCES = new Set(['exec']);
const TITLE_CHARS = 120;
const REPLY_CHARS = 200;
const IDE_REQUEST_MARKER = '## My request for Codex:';
const RELEVANT_MARKERS = ['"session_meta"', '"turn_context"', '"role":"user"', '"role":"assistant"'];

/** Thread names keyed by session ID, read from `<codexHome>/session_index.jsonl`. */
export type CodexTitleIndex = ReadonlyMap<string, string>;

/** Parses one Codex rollout file (`<codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl`). */
export async function parseCodexSession(
  filePath: string,
  titles: CodexTitleIndex,
  options: ParseOptions,
): Promise<SessionRecord | undefined> {
  let id: string | undefined;
  let cwd: string | undefined;
  let source: unknown;
  let firstPrompt: string | undefined;
  let lastReply: string | undefined;
  let model: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let messageCount = 0;
  let skippedLines = 0;

  for await (const event of readLines(filePath, options.maxLineBytes)) {
    if (event.kind === 'skipped') {
      skippedLines++;
      continue;
    }
    if (!RELEVANT_MARKERS.some((marker) => event.text.includes(marker))) {
      continue;
    }
    const record = tryParseJson(event.text);
    if (!isObject(record) || !isObject(record.payload)) {
      continue;
    }
    const payload = record.payload;
    const noteTimestamp = (): void => {
      const timestamp = asString(record.timestamp);
      if (timestamp) {
        startedAt ??= timestamp;
        updatedAt = timestamp;
      }
    };

    switch (record.type) {
      case 'session_meta':
        noteTimestamp();
        id ??= asString(payload.id) ?? asString(payload.session_id);
        cwd ??= asString(payload.cwd);
        source ??= payload.source;
        break;
      case 'turn_context':
        noteTimestamp();
        model = asString(payload.model) ?? model;
        cwd ??= asString(payload.cwd);
        break;
      case 'response_item': {
        if (payload.type !== 'message') {
          break;
        }
        noteTimestamp();
        if (payload.role === 'user') {
          const prompt = userPromptText(payload.content);
          if (prompt !== undefined) {
            messageCount++;
            firstPrompt ??= summarize(prompt, TITLE_CHARS);
          }
        } else if (payload.role === 'assistant') {
          const reply = extractText(payload.content, ['output_text', 'text']);
          if (reply.trim().length > 0) {
            messageCount++;
            lastReply = summarize(reply, REPLY_CHARS);
          }
        }
        break;
      }
    }
  }

  if (!id) {
    return undefined;
  }
  const parentId = subagentParentId(source);
  const isSubagent = isObject(source) && 'subagent' in source;
  const isNonInteractiveSource = typeof source === 'string' && NON_INTERACTIVE_SOURCES.has(source);
  return {
    agent: 'codex',
    id,
    title: titles.get(id) ?? firstPrompt ?? UNTITLED,
    firstPrompt,
    lastReply,
    messageCount,
    subagentCount: 0,
    model,
    cwd,
    startedAt,
    updatedAt,
    filePath,
    interactive: !isSubagent && !isNonInteractiveSource,
    isSubagent,
    parentId,
    skippedLines,
  };
}

/** Returns the prompt a person typed; the VS Code extension wraps it after an IDE-context preamble. */
function userPromptText(content: unknown): string | undefined {
  const text = extractText(content, ['input_text', 'text']);
  const markerIndex = text.indexOf(IDE_REQUEST_MARKER);
  const request = markerIndex === -1 ? text : text.slice(markerIndex + IDE_REQUEST_MARKER.length);
  if (request.trim().length === 0 || looksInjected(request) || request.trimStart().startsWith('# AGENTS.md')) {
    return undefined;
  }
  return request;
}

/** Only spawned threads record a parent id; other subagent kinds (for example review) carry none. */
function subagentParentId(source: unknown): string | undefined {
  if (!isObject(source) || !isObject(source.subagent) || !isObject(source.subagent.thread_spawn)) {
    return undefined;
  }
  return asString(source.subagent.thread_spawn.parent_thread_id);
}

/** Later entries win, so a renamed thread shows its newest name. */
export async function readCodexTitleIndex(indexPath: string, options: ParseOptions): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    for await (const event of readLines(indexPath, options.maxLineBytes)) {
      if (event.kind !== 'line') {
        continue;
      }
      const entry = tryParseJson(event.text);
      if (!isObject(entry)) {
        continue;
      }
      const id = asString(entry.id);
      const name = asString(entry.thread_name);
      if (id && name) {
        titles.set(id, name);
      }
    }
  } catch {
    return titles;
  }
  return titles;
}
