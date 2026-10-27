import * as path from 'node:path';
import * as vscode from 'vscode';
import { copySessionId, openTranscript, resumeSession, revealTranscript } from './actions';
import { DEFAULT_MAX_LINE_BYTES, SessionRecord } from './model';
import { IndexCache } from './index/cache';
import { IndexOptions, SessionIndexer } from './index/indexer';
import { RefreshScheduler } from './index/refreshScheduler';
import { filterByScope, groupIdentity, Scope, ScopeContext, scopeLabel, SCOPES } from './scope/filter';
import { GitRepoResolver } from './scope/gitRepo';
import { expandHome } from './scope/paths';
import { matchesQuery } from './scope/search';
import { groupSessions } from './view/grouping';
import { SessionTreeProvider, TreeNode } from './view/treeProvider';

const VIEW_ID = 'agentSessionHistory.sessions';
const CONFIG_SECTION = 'agentSessionHistory';
const CACHE_FILE = 'index-v1.json';
const SCOPE_STATE_KEY = 'agentSessionHistory.scope';
const SCOPE_CONTEXT_KEY = 'agentSessionHistory.scope';
const INDEXED_CONTEXT_KEY = 'agentSessionHistory.indexed';
const HAS_SESSIONS_CONTEXT_KEY = 'agentSessionHistory.hasSessions';
const FILTERING_CONTEXT_KEY = 'agentSessionHistory.filtering';
const WATCH_INTERVAL_MS = 10_000;

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
  let query = '';
  let watchers: vscode.Disposable[] = [];

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
    const inScope = filterByScope(sessions, scope, contextNow);
    const visible = query ? inScope.filter((session) => matchesQuery(session, query)) : inScope;
    provider.setGroups(groupSessions(visible, (session) => groupIdentity(session, contextNow)));
    const count = query ? `${visible.length} of ${inScope.length}` : String(visible.length);
    const filterSuffix = query ? ` · "${query}"` : '';
    treeView.description = `${scopeLabel(scope)} · ${count} ${inScope.length === 1 ? 'session' : 'sessions'}${filterSuffix}`;
    treeView.message = statusMessage(contextNow.workspaceDirs.length > 0, inScope.length, visible.length);
  };

  const statusMessage = (hasWorkspace: boolean, inScopeCount: number, visibleCount: number): string | undefined => {
    if (indexing) {
      return 'Indexing sessions…';
    }
    if (scope !== 'all' && !hasWorkspace) {
      return `Open a folder to use ${scopeLabel(scope)} scope, or switch to All.`;
    }
    if (query && inScopeCount > 0 && visibleCount === 0) {
      return `No sessions match "${query}".`;
    }
    if (inScopeCount === 0 && (sessions?.length ?? 0) > 0) {
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

  const setQuery = async (next: string): Promise<void> => {
    query = next.trim();
    await vscode.commands.executeCommand('setContext', FILTERING_CONTEXT_KEY, query.length > 0);
    render();
  };

  const selectedSession = (node: TreeNode | undefined): SessionRecord | undefined => {
    const target = node ?? treeView.selection[0];
    return target?.kind === 'session' ? target.session : undefined;
  };

  const sessionCommand = (id: string, action: (session: SessionRecord) => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (node?: TreeNode) => {
      const session = selectedSession(node);
      if (session) {
        await action(session);
      }
    });

  const restartWatchers = (): void => {
    for (const watcher of watchers) {
      watcher.dispose();
    }
    const options = readOptions();
    const scheduler = new RefreshScheduler(WATCH_INTERVAL_MS, () => void refresh());
    const patterns = [
      new vscode.RelativePattern(vscode.Uri.file(path.join(options.claudeHome, 'projects')), '**/*.jsonl'),
      new vscode.RelativePattern(vscode.Uri.file(path.join(options.codexHome, 'sessions')), '**/rollout-*.jsonl'),
      new vscode.RelativePattern(vscode.Uri.file(options.codexHome), 'session_index.jsonl'),
    ];
    watchers = [scheduler];
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watchers.push(watcher, watcher.onDidCreate(() => scheduler.notify()), watcher.onDidChange(() => scheduler.notify()), watcher.onDidDelete(() => scheduler.notify()));
    }
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
    vscode.commands.registerCommand('agentSessionHistory.search', async () => {
      const next = await vscode.window.showInputBox({
        prompt: 'Filter sessions by title, prompt, reply, branch, model, directory, or ID',
        placeHolder: 'Space-separated terms must all match',
        value: query,
      });
      if (next !== undefined) {
        await setQuery(next);
      }
    }),
    vscode.commands.registerCommand('agentSessionHistory.clearSearch', () => setQuery('')),
    sessionCommand('agentSessionHistory.resume', resumeSession),
    sessionCommand('agentSessionHistory.openTranscript', openTranscript),
    sessionCommand('agentSessionHistory.copyId', copySessionId),
    sessionCommand('agentSessionHistory.reveal', revealTranscript),
    vscode.commands.registerCommand('agentSessionHistory.activateSelection', async () => {
      const [node] = treeView.selection;
      if (node?.kind === 'session') {
        await resumeSession(node.session);
      } else if (node) {
        await vscode.commands.executeCommand('list.toggleExpand');
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        restartWatchers();
        void refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await repos.resolveAll(workspaceDirs());
      render();
    }),
    { dispose: () => watchers.forEach((watcher) => watcher.dispose()) },
  );

  void vscode.commands.executeCommand('setContext', SCOPE_CONTEXT_KEY, scope);
  restartWatchers();
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
