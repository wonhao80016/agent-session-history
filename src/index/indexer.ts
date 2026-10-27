import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { ParseOptions, SessionRecord, UNTITLED } from '../model';
import { parseClaudeSession } from '../sources/claude';
import { parseCodexSession, readCodexTitleIndex } from '../sources/codex';
import { CacheEntry, IndexCache } from './cache';
import { discoverSessionFiles, SourceDirs } from './discover';

export interface IndexOptions extends SourceDirs, ParseOptions {
  includeNonInteractive: boolean;
  concurrency: number;
}

export interface IndexStats {
  files: number;
  parsed: number;
  cached: number;
  failed: number;
  skippedLines: number;
  durationMs: number;
}

export interface IndexResult {
  sessions: SessionRecord[];
  stats: IndexStats;
}

export type IndexLogger = (message: string) => void;

export class SessionIndexer {
  constructor(
    private readonly cache: IndexCache,
    private readonly log: IndexLogger = () => undefined,
  ) {}

  async build(options: IndexOptions): Promise<IndexResult> {
    const started = Date.now();
    await this.cache.ready();
    this.cache.useOptions(JSON.stringify({ maxLineBytes: options.maxLineBytes }));
    const files = await discoverSessionFiles(options);
    const codexTitles = await readCodexTitleIndex(path.join(options.codexHome, 'session_index.jsonl'), options);
    const jobs = [
      ...files.claude.map((filePath) => ({ filePath, parse: () => parseClaudeSession(filePath, options) })),
      ...files.codex.map((filePath) => ({ filePath, parse: () => parseCodexSession(filePath, new Map(), options) })),
    ];

    const stats: IndexStats = { files: jobs.length, parsed: 0, cached: 0, failed: 0, skippedLines: 0, durationMs: 0 };
    const nextEntries = new Map<string, CacheEntry>();
    const records: SessionRecord[] = [];

    await forEachLimited(jobs, options.concurrency, async (job) => {
      let info;
      try {
        info = await stat(job.filePath);
      } catch {
        return;
      }
      let entry = this.cache.lookup(job.filePath, info.mtimeMs, info.size);
      if (entry) {
        stats.cached++;
      } else {
        try {
          entry = { mtimeMs: info.mtimeMs, size: info.size, record: (await job.parse()) ?? null };
          stats.parsed++;
        } catch (error) {
          stats.failed++;
          this.log(`Failed to parse ${job.filePath}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
      nextEntries.set(job.filePath, entry);
      if (entry.record) {
        stats.skippedLines += entry.record.skippedLines;
        records.push(entry.record);
      }
    });

    this.cache.replaceAll(nextEntries);
    try {
      await this.cache.save();
    } catch (error) {
      this.log(`Failed to save index cache: ${error instanceof Error ? error.message : String(error)}`);
    }

    const sessions = finalizeSessions(records, codexTitles, options.includeNonInteractive);
    stats.durationMs = Date.now() - started;
    return { sessions, stats };
  }
}

/** Codex thread names are applied here, not cached, so a rename needs no reparse. */
export function finalizeSessions(
  records: readonly SessionRecord[],
  codexTitles: ReadonlyMap<string, string>,
  includeNonInteractive: boolean,
): SessionRecord[] {
  const sessions = mergePages(records);
  const children = new Map<string, string[]>();
  for (const record of sessions) {
    if (record.agent === 'codex' && record.parentId) {
      const siblings = children.get(record.parentId) ?? [];
      siblings.push(record.id);
      children.set(record.parentId, siblings);
    }
  }

  const visible: SessionRecord[] = [];
  for (const record of sessions) {
    if (record.isSubagent || (!record.interactive && !includeNonInteractive)) {
      continue;
    }
    if (record.agent === 'codex') {
      visible.push({
        ...record,
        title: codexTitles.get(record.id) ?? record.firstPrompt ?? UNTITLED,
        subagentCount: countDescendants(record.id, children),
      });
    } else {
      visible.push(record);
    }
  }
  return visible.sort(compareByUpdatedDesc);
}

/**
 * Codex paginated history splits one thread across `rollout-…-<id>.jsonl` and `rollout-…-<id>_<page>.jsonl`;
 * every page repeats the thread id in session_meta and holds only turns after the previous page.
 */
export function mergePages(records: readonly SessionRecord[]): SessionRecord[] {
  const byKey = new Map<string, SessionRecord[]>();
  for (const record of records) {
    const key = `${record.agent}:${record.id}`;
    const pages = byKey.get(key);
    if (pages) {
      pages.push(record);
    } else {
      byKey.set(key, [record]);
    }
  }
  return [...byKey.values()].map((pages) => (pages.length === 1 ? pages[0] : mergeOrderedPages(pages)));
}

function mergeOrderedPages(pages: SessionRecord[]): SessionRecord {
  const ordered = [...pages].sort((a, b) => timeValue(a.startedAt) - timeValue(b.startedAt));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const newestFirst = [...ordered].reverse();
  return {
    ...first,
    firstPrompt: ordered.find((page) => page.firstPrompt)?.firstPrompt,
    lastReply: newestFirst.find((page) => page.lastReply)?.lastReply,
    model: newestFirst.find((page) => page.model)?.model,
    gitBranch: ordered.find((page) => page.gitBranch)?.gitBranch,
    cwd: ordered.find((page) => page.cwd)?.cwd,
    updatedAt: newestFirst.find((page) => page.updatedAt)?.updatedAt,
    filePath: last.filePath,
    messageCount: ordered.reduce((sum, page) => sum + page.messageCount, 0),
    skippedLines: ordered.reduce((sum, page) => sum + page.skippedLines, 0),
  };
}

function countDescendants(id: string, children: ReadonlyMap<string, string[]>): number {
  let count = 0;
  const stack = [...(children.get(id) ?? [])];
  const seen = new Set<string>([id]);
  while (stack.length > 0) {
    const child = stack.pop() as string;
    if (seen.has(child)) {
      continue;
    }
    seen.add(child);
    count++;
    stack.push(...(children.get(child) ?? []));
  }
  return count;
}

export function compareByUpdatedDesc(a: SessionRecord, b: SessionRecord): number {
  return timeValue(b.updatedAt) - timeValue(a.updatedAt);
}

function timeValue(iso: string | undefined): number {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(value) ? 0 : value;
}

async function forEachLimited<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}
