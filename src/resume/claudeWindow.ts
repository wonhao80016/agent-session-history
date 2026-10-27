import * as path from 'node:path';

const MAX_PROJECT_DIR_LENGTH = 200;

/** Claude Code stores a session under `projects/<dir>`, where `<dir>` is its cwd with every non-alphanumeric character replaced by `-`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeProjectDirOf(transcriptPath: string): string {
  return path.basename(path.dirname(transcriptPath));
}

/** Names longer than 200 characters are cut and suffixed with `-<hash>`; only the kept prefix is compared, not the hash. */
export function claudeProjectDirMatches(projectDir: string, cwd: string, platform: NodeJS.Platform): boolean {
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value);
  const expected = fold(claudeProjectDirName(cwd));
  const actual = fold(projectDir);
  if (expected.length <= MAX_PROJECT_DIR_LENGTH) {
    return actual === expected;
  }
  return actual.startsWith(`${expected.slice(0, MAX_PROJECT_DIR_LENGTH)}-`);
}

/**
 * The Claude Code extension resumes only transcripts stored under the project dir of the window's first folder or of
 * another worktree of its repository; any other ID silently opens a blank chat (read from anthropic.claude-code 2.1.311).
 */
export function claudeCanOpenInWindow(transcriptPath: string, windowDirs: readonly string[], platform: NodeJS.Platform): boolean {
  const projectDir = claudeProjectDirOf(transcriptPath);
  return windowDirs.some((dir) => claudeProjectDirMatches(projectDir, dir, platform));
}
