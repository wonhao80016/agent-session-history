import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { ParseOptions, SessionRecord, UNTITLED } from '../model';
import { readLines, tryParseJson } from './lineReader';
import { asString, extractText, isObject, looksInjected, summarize } from './text';

const NON_INTERACTIVE_ENTRYPOINTS = new Set(['sdk-cli']);
const RELEVANT_TYPES = ['"type":"user"', '"type":"assistant"', '"type":"ai-title"'];
const TITLE_CHARS = 120;
const REPLY_CHARS = 200;

/** Parses one top-level Claude Code transcript (`<projects>/<encoded-cwd>/<sessionId>.jsonl`). */
export async function parseClaudeSession(filePath: string, options: ParseOptions): Promise<SessionRecord> {
  const id = path.basename(filePath, '.jsonl');
  let aiTitle: string | undefined;
  let firstPrompt: string | undefined;
  let lastReply: string | undefined;
  let model: string | undefined;
  let gitBranch: string | undefined;
  let cwd: string | undefined;
  let entrypoint: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let messageCount = 0;
  let skippedLines = 0;

  for await (const event of readLines(filePath, options.maxLineBytes)) {
    if (event.kind === 'skipped') {
      skippedLines++;
      continue;
    }
    if (!RELEVANT_TYPES.some((marker) => event.text.includes(marker))) {
      continue;
    }
    const record = tryParseJson(event.text);
    if (!isObject(record)) {
      continue;
    }

    if (record.type === 'ai-title') {
      aiTitle = asString(record.aiTitle) ?? aiTitle;
      continue;
    }
    if (record.type !== 'user' && record.type !== 'assistant') {
      continue;
    }

    const timestamp = asString(record.timestamp);
    if (timestamp) {
      startedAt ??= timestamp;
      updatedAt = timestamp;
    }
    cwd ??= asString(record.cwd);
    gitBranch = asString(record.gitBranch) ?? gitBranch;
    entrypoint ??= asString(record.entrypoint);

    const message = isObject(record.message) ? record.message : undefined;
    if (record.type === 'user') {
      const prompt = userPromptText(record, message);
      if (prompt !== undefined) {
        messageCount++;
        firstPrompt ??= summarize(prompt, TITLE_CHARS);
      }
      continue;
    }

    const reply = extractText(message?.content, ['text']);
    if (reply.trim().length > 0) {
      messageCount++;
      lastReply = summarize(reply, REPLY_CHARS);
    }
    const replyModel = asString(message?.model);
    if (replyModel && !replyModel.startsWith('<')) {
      model = replyModel;
    }
  }

  return {
    agent: 'claude',
    id,
    title: aiTitle ?? firstPrompt ?? UNTITLED,
    firstPrompt,
    lastReply,
    messageCount,
    subagentCount: await countSubagents(filePath),
    model,
    gitBranch,
    cwd,
    startedAt,
    updatedAt,
    filePath,
    interactive: entrypoint === undefined || !NON_INTERACTIVE_ENTRYPOINTS.has(entrypoint),
    isSubagent: false,
    skippedLines,
  };
}

/** Returns the prompt a person typed, or undefined for tool results, meta records, and system-injected text. */
function userPromptText(record: Record<string, unknown>, message: Record<string, unknown> | undefined): string | undefined {
  if (record.isMeta === true || record.isSidechain === true || record.promptSource === 'system') {
    return undefined;
  }
  const text = extractText(message?.content, ['text']);
  if (text.trim().length === 0 || looksInjected(text)) {
    return undefined;
  }
  return text;
}

async function countSubagents(transcriptPath: string): Promise<number> {
  const subagentDir = path.join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents');
  try {
    const entries = await readdir(subagentDir);
    return entries.filter((name) => name.endsWith('.jsonl')).length;
  } catch {
    return 0;
  }
}
