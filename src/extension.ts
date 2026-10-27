import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_MAX_LINE_BYTES, SessionRecord } from './model';
import { IndexCache } from './index/cache';
import { IndexOptions, SessionIndexer } from './index/indexer';
import { filterByScope, groupIdentity, Scope, ScopeContext, scopeLabel, SCOPES } from './scope/filter';
import { GitRepoResolver } from './scope/gitRepo';
import { expandHome } from './scope/paths';
import { groupSessions } from './view/grouping';
import { SessionTreeProvider } from './view/treeProvider';

const VIEW_ID = 'agentSessionHistory.sessions';
const CONFIG_SECTION = 'agentSessionHistory';
const CACHE_FILE = 'index-v1.json';
const SCOPE_STATE_KEY = 'agentSessionHistory.scope';
const SCOPE_CONTEXT_KEY = 'agentSessionHistory.scope';
const INDEXED_CONTEXT_KEY = 'agentSessionHistory.indexed';
const HAS_SESSIONS_CONTEXT_KEY = 'agentSessionHistory.hasSessions';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Agent Session History');
  const provider = new SessionTreeProvider();
  const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
  const cache = new IndexCache(path.join(context.globalStorageUri.fsPath, CACHE_FILE));
  const indexer = new SessionIndexer(cache, (message) => output.appendLine(message));
  const repos = new GitRepoResolver();
  let sessions: SessionRecord[] | undefined;
  let scope = readStoredScope(context);
  let running: Promise<void> | undefined;
  let rerunRequested = false;
  let retryRepoMisses = false;
  let indexing = false;

  const workspaceDirs = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);

  const scopeContext = (): ScopeContext => {
    const dirs = workspaceDirs();
    const repoKeys = new Set<string>();
    for (const dir of dirs) {
      const repo = repos.lookup(dir);
      if (repo) {
        repoKeys.add(repo.key);
      }
    }
    return { workspaceDirs: dirs, workspaceRepoKeys: repoKeys, repoOf: (cwd) => repos.lookup(cwd), platform: process.platform };
  };

  const render = (): void => {
    if (!sessions) {
      return;
    }
    const contextNow = scopeContext();
    const visible = filterByScope(sessions, scope, contextNow);
    provider.setGroups(groupSessions(visible, (session) => groupIdentity(session, contextNow)));
    treeView.description = `${scopeLabel(scope)} · ${visible.length} ${visible.length === 1 ? 'session' : 'sessions'}`;
    treeView.message = statusMessage(contextNow.workspaceDirs.length > 0, visible.length);
  };

  const statusMessage = (hasWorkspace: boolean, visibleCount: number): string | undefined => {
    if (indexing) {
      return 'Indexing sessions…';
    }
    if (scope !== 'all' && !hasWorkspace) {
      return `Open a folder to use ${scopeLabel(scope)} scope, or switch to All.`;
    }
    if (visibleCount === 0 && (sessions?.length ?? 0) > 0) {
      return `No sessions in ${scopeLabel(scope)} scope. Switch to ${scope === 'workspace' ? 'Project or All' : 'All'} to see others.`;
    }
    return undefined;
  };

  const resolveRepos = async (indexed: readonly SessionRecord[]): Promise<void> => {
    const dirs = new Set(workspaceDirs());
    for (const session of indexed) {
      if (session.cwd) {
        dirs.add(session.cwd);
      }
    }
    await repos.resolveAll(dirs);
  };

  const runIndex = async (): Promise<void> => {
    indexing = true;
    treeView.message = 'Indexing sessions…';
    try {
      const result = await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, async () => {
        const built = await indexer.build(readOptions());
        if (retryRepoMisses) {
          retryRepoMisses = false;
          repos.forgetMisses();
        }
        await resolveRepos(built.sessions);
        return built;
      });
      // Publish only after repositories are resolved, so a scope switch mid-index never sees half-resolved groups.
      sessions = result.sessions;
      await vscode.commands.executeCommand('setContext', HAS_SESSIONS_CONTEXT_KEY, sessions.length > 0);
      await vscode.commands.executeCommand('setContext', INDEXED_CONTEXT_KEY, true);
      indexing = false;
      render();
      const { files, parsed, cached, failed, skippedLines, durationMs } = result.stats;
      output.appendLine(
        `Indexed ${files} files in ${durationMs} ms (parsed ${parsed}, cached ${cached}, failed ${failed}, skipped lines ${skippedLines}); ${result.sessions.length} sessions in total.`,
      );
    } catch (error) {
      indexing = false;
      treeView.message = 'Indexing failed. See the Agent Session History output for details.';
      output.appendLine(`Indexing failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  };

  const refresh = async (): Promise<void> => {
    if (running) {
      rerunRequested = true;
      return running;
    }
    running = (async () => {
      do {
        rerunRequested = false;
        await runIndex();
      } while (rerunRequested);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  const setScope = async (next: Scope): Promise<void> => {
    scope = next;
    await context.workspaceState.update(SCOPE_STATE_KEY, next);
    await vscode.commands.executeCommand('setContext', SCOPE_CONTEXT_KEY, next);
    render();
  };

  context.subscriptions.push(
    output,
    treeView,
    // Directories that were not repositories are re-checked only on an explicit refresh; each check spawns git.
    vscode.commands.registerCommand('agentSessionHistory.refresh', () => {
      retryRepoMisses = true;
      return refresh();
    }),
    ...SCOPES.map((value) => vscode.commands.registerCommand(`agentSessionHistory.scope.${value}`, () => setScope(value))),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        void refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await repos.resolveAll(workspaceDirs());
      render();
    }),
  );

  void vscode.commands.executeCommand('setContext', SCOPE_CONTEXT_KEY, scope);
  void cache.load().then(refresh);
}

export function deactivate(): void {}

function readStoredScope(context: vscode.ExtensionContext): Scope {
  const stored = context.workspaceState.get<string>(SCOPE_STATE_KEY);
  return SCOPES.includes(stored as Scope) ? (stored as Scope) : 'workspace';
}

function readOptions(): IndexOptions {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    claudeHome: expandHome(config.get<string>('claudeDir', '~/.claude')),
    codexHome: expandHome(config.get<string>('codexDir', '~/.codex')),
    includeCodexArchived: config.get<boolean>('includeCodexArchived', false),
    includeNonInteractive: config.get<boolean>('includeNonInteractive', false),
    maxLineBytes: config.get<number>('maxLineBytes', DEFAULT_MAX_LINE_BYTES),
    concurrency: 4,
  };
}
