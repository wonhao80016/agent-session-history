import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { displayName, normalizePath } from './paths';

export interface RepoInfo {
  /** Normalized git common dir; identical for a repository and all of its linked worktrees. */
  key: string;
  root: string;
  name: string;
}

export type GitCommonDirRunner = (dir: string) => Promise<string | undefined>;

const GIT_TIMEOUT_MS = 5_000;
const RESOLVE_CONCURRENCY = 4;

export const runGitCommonDir: GitCommonDirRunner = (dir) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
    );
  });

export class GitRepoResolver {
  /** null records a directory where git found no repository or failed (missing directory, timeout, no git). */
  private readonly resolved = new Map<string, RepoInfo | null>();

  constructor(
    private readonly run: GitCommonDirRunner = runGitCommonDir,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async resolveAll(dirs: Iterable<string>): Promise<void> {
    const pending = new Map<string, string>();
    for (const dir of dirs) {
      const key = normalizePath(dir, this.platform);
      if (!this.resolved.has(key) && !pending.has(key)) {
        pending.set(key, dir);
      }
    }
    const queue = [...pending];
    const workers = Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const [key, dir] = item;
        const commonDir = await this.run(dir);
        this.resolved.set(key, commonDir ? this.toRepoInfo(commonDir) : null);
      }
    });
    await Promise.all(workers);
  }

  lookup(dir: string): RepoInfo | undefined {
    return this.resolved.get(normalizePath(dir, this.platform)) ?? undefined;
  }

  /** Lets directories that were not repositories be checked again on the next resolveAll. */
  forgetMisses(): void {
    for (const [key, info] of this.resolved) {
      if (info === null) {
        this.resolved.delete(key);
      }
    }
  }

  private toRepoInfo(commonDir: string): RepoInfo {
    const trimmed = commonDir.replace(/[\\/]+$/, '');
    const isDotGit = path.win32.basename(trimmed).toLowerCase() === '.git';
    const root = isDotGit ? trimmed.slice(0, -'.git'.length).replace(/[\\/]+$/, '') : trimmed;
    return { key: normalizePath(trimmed, this.platform), root, name: displayName(root) };
  }
}
