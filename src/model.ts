export type AgentKind = 'claude' | 'codex';

export interface SessionRecord {
  agent: AgentKind;
  id: string;
  title: string;
  firstPrompt?: string;
  lastReply?: string;
  messageCount: number;
  subagentCount: number;
  model?: string;
  gitBranch?: string;
  cwd?: string;
  startedAt?: string;
  updatedAt?: string;
  filePath: string;
  interactive: boolean;
  /** Set only for Codex subagent threads, which are stored as separate rollout files. */
  parentId?: string;
  skippedLines: number;
}

export interface ParseOptions {
  maxLineBytes: number;
}

export const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;
export const UNTITLED = '(untitled)';
