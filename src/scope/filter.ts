import { SessionRecord } from '../model';
import type { Scope } from '../protocol';
import { RepoInfo } from './gitRepo';
import { displayName, normalizePath } from './paths';

export interface ScopeContext {
  workspaceDirs: readonly string[];
  workspaceRepoKeys: ReadonlySet<string>;
  repoOf: (cwd: string) => RepoInfo | undefined;
  isMissingDir: (cwd: string) => boolean;
  platform: NodeJS.Platform;
}

export function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const normalizedChild = normalizePath(child, platform);
  const normalizedParent = normalizePath(parent, platform);
  if (normalizedChild === normalizedParent) {
    return true;
  }
  const separator = platform === 'win32' ? '\\' : '/';
  const prefix = normalizedParent.endsWith(separator) ? normalizedParent : normalizedParent + separator;
  return normalizedChild.startsWith(prefix);
}

/**
 * Project scope also keeps sessions inside a workspace folder whose cwd is no longer a resolvable repository,
 * so deleting a worktree or the git metadata never hides sessions that Workspace scope would show.
 */
export function filterByScope(sessions: readonly SessionRecord[], scope: Scope, context: ScopeContext): SessionRecord[] {
  if (scope === 'all') {
    return [...sessions];
  }
  return sessions.filter((session) => {
    if (!session.cwd) {
      return false;
    }
    const inWorkspace = context.workspaceDirs.some((dir) => isInside(session.cwd as string, dir, context.platform));
    if (scope === 'workspace' || inWorkspace) {
      return inWorkspace;
    }
    const repo = context.repoOf(session.cwd);
    return repo !== undefined && context.workspaceRepoKeys.has(repo.key);
  });
}

export interface GroupIdentity {
  key: string;
  label: string;
  path?: string;
  missing?: true;
}

/** Sessions from a repository and its linked worktrees share one group. */
export function groupIdentity(session: SessionRecord, context: ScopeContext): GroupIdentity {
  if (!session.cwd) {
    return { key: 'unknown', label: 'Unknown directory' };
  }
  const repo = context.repoOf(session.cwd);
  if (repo) {
    return { key: `repo:${repo.key}`, label: repo.name, path: repo.root };
  }
  const identity: GroupIdentity = { key: `dir:${normalizePath(session.cwd, context.platform)}`, label: displayName(session.cwd), path: session.cwd };
  return context.isMissingDir(session.cwd) ? { ...identity, missing: true } : identity;
}
