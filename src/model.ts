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
  /** Codex stores subagent threads as separate rollout files; they are counted on the parent, not listed. */
  isSubagent: boolean;
  parentId?: string;
  skippedLines: number;
}

export interface ParseOptions {
  maxLineBytes: number;
}

export const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;
export const UNTITLED = '(untitled)';
