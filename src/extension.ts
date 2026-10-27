import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { copySessionId, openClaudeSession, openTranscript, ResumeHost, resumeInTerminal, resumeSession, revealTranscript } from './actions';
import { DEFAULT_MAX_LINE_BYTES, MIN_MAX_LINE_BYTES, SessionRecord } from './model';
import { IndexCache } from './index/cache';
import { IndexOptions, IndexResult, SessionIndexer } from './index/indexer';
import { RefreshScheduler } from './index/refreshScheduler';
import { Scope, SCOPES, SORT_KEYS, SortKey, WebviewMessage } from './protocol';
import { takePendingResume, writePendingResume } from './resume/handoff';
import { ScopeContext } from './scope/filter';
import { GitRepoResolver, runGitWorktreeList } from './scope/gitRepo';
import { expandHome } from './scope/paths';
import { moveSessionToTrash } from './trash';
import { buildViewState, ScanSummary, sessionKey } from './view/viewModel';
import { SessionWebviewProvider } from './view/webviewProvider';

const VIEW_ID = 'agentSessionHistory.sessions';
const CONFIG_SECTION = 'agentSessionHistory';
const CACHE_FILE = 'index-v1.json';
const PENDING_RESUME_FILE = 'pending-resume.json';
const SCOPE_STATE_KEY = 'agentSessionHistory.scope';
const SORT_STATE_KEY = 'agentSessionHistory.sort';
const WATCH_INTERVAL_MS = 10_000;
const OPEN_DEBOUNCE_MS = 1_500;

/** Shown in the `⋯` quick pick and registered as `agentSessionHistory.session.<command>` for the webview context menu. */
interface SessionAction {
  command: string;
  icon: string;
  label: (session: SessionRecord) => string;
  run: (session: SessionRecord) => Promise<void>;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Agent Session History');
  const logError = (error: unknown): void => {
    output.appendLine(`Action failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  };
  const cache = new IndexCache(path.join(context.globalStorageUri.fsPath, CACHE_FILE));
  const indexer = new SessionIndexer(cache, (message) => output.appendLine(message));
  const repos = new GitRepoResolver();
  let sessions: SessionRecord[] | undefined;
  let sessionsByKey = new Map<string, SessionRecord>();
  let scan: ScanSummary | undefined;
  let scope = readStored(context, SCOPE_STATE_KEY, SCOPES, 'workspace');
  let sort = readStored(context, SORT_STATE_KEY, SORT_KEYS, 'updated');
  let query = '';
  let querySeq = 0;
  let indexing = false;
  let indexFailed = false;
  let running: Promise<void> | undefined;
  let rerunRequested = false;
  let progressRequested = false;
  let retryRepoMisses = false;
  let lastOpen: { key: string; at: number } | undefined;
  let started = false;
  let watchers: vscode.Disposable[] = [];
  const pendingResumeFile = path.join(context.globalStorageUri.fsPath, PENDING_RESUME_FILE);

  // Claude Code resolves sessions against the first workspace folder, or the home directory when none is open.
  const resumeHost: ResumeHost = {
    claudeWindowDirs: async () => {
      const first = vscode.workspace.workspaceFolders?.[0];
      if (!first) {
        return [homedir()];
      }
      return first.uri.scheme === 'file' ? [first.uri.fsPath, ...(await runGitWorktreeList(first.uri.fsPath))] : [];
    },
    handOff: (pending) => writePendingResume(pendingResumeFile, pending),
  };

  // A window without a local folder never takes the entry, but still discards an expired one.
  const resumeHandedOff = async (): Promise<void> => {
    const first = vscode.workspace.workspaceFolders?.[0];
    const folder = first?.uri.scheme === 'file' ? first.uri.fsPath : '';
    const pending = await takePendingResume(pendingResumeFile, folder, Date.now(), process.platform);
    if (pending && folder) {
      await openClaudeSession(pending.id);
    }
  };

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
    provider.update(buildViewState({ sessions, scope, sort, query, querySeq, indexing, indexFailed, scan, context: scopeContext() }));
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

  // Watcher-driven refreshes stay silent, so a session being written does not flash "Indexing…" every interval.
  const runIndex = async (showProgress: boolean): Promise<void> => {
    if (showProgress) {
      indexing = true;
      render();
    }
    try {
      const options = readOptions();
      const build = async (): Promise<IndexResult> => {
        const built = await indexer.build(options);
        if (retryRepoMisses) {
          retryRepoMisses = false;
          repos.forgetMisses();
        }
        await resolveRepos(built.sessions);
        return built;
      };
      const result = showProgress ? await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, build) : await build();
      // Publish only after repositories are resolved, so a scope switch mid-index never sees half-resolved groups.
      sessions = result.sessions;
      sessionsByKey = new Map(sessions.map((session) => [sessionKey(session), session]));
      const { files, parsed, cached, failed, skippedLines, durationMs } = result.stats;
      scan = { files, failed, skippedLines, maxLineBytes: options.maxLineBytes, finishedAt: new Date().toISOString() };
      indexFailed = false;
      output.appendLine(
        `Indexed ${files} files in ${durationMs} ms (parsed ${parsed}, cached ${cached}, failed ${failed}, skipped lines ${skippedLines}); ${sessions.length} sessions in total.`,
      );
    } catch (error) {
      indexFailed = true;
      output.appendLine(`Indexing failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    } finally {
      indexing = false;
      render();
    }
  };

  const refresh = async (showProgress = false): Promise<void> => {
    progressRequested ||= showProgress;
    if (running) {
      rerunRequested = true;
      return running;
    }
    running = (async () => {
      do {
        rerunRequested = false;
        const show = progressRequested || !sessions;
        progressRequested = false;
        await runIndex(show);
      } while (rerunRequested);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  // Every window activates at startup to pick up handed-off resumes; indexing waits until the view is first shown.
  const ensureStarted = (): void => {
    if (started) {
      return;
    }
    started = true;
    restartWatchers();
    void cache.load().then(() => refresh(true));
  };

  // Directories that were not repositories are re-checked only on an explicit refresh; each check spawns git.
  const manualRefresh = (): Promise<void> => {
    retryRepoMisses = true;
    ensureStarted();
    return refresh(true);
  };

  const setScope = async (next: Scope): Promise<void> => {
    scope = next;
    render();
    await context.workspaceState.update(SCOPE_STATE_KEY, next);
  };

  const setSort = async (next: SortKey): Promise<void> => {
    sort = next;
    render();
    await context.workspaceState.update(SORT_STATE_KEY, next);
  };

  const setQuery = (next: string): void => {
    query = next.trim();
    render();
  };

  const trashSession = async (session: SessionRecord): Promise<void> => {
    if (await moveSessionToTrash(session)) {
      await refresh();
    }
  };

  const openSession = async (key: string): Promise<void> => {
    const session = sessionsByKey.get(key);
    if (!session) {
      return;
    }
    // A double click on a card must not resume the same session twice.
    const now = Date.now();
    if (lastOpen?.key === key && now - lastOpen.at < OPEN_DEBOUNCE_MS) {
      return;
    }
    lastOpen = { key, at: now };
    await resumeSession(session, resumeHost);
  };

  const sessionActions: SessionAction[] = [
    {
      command: 'resume',
      icon: 'play',
      label: (session) => `Resume in ${session.agent === 'claude' ? 'Claude Code' : 'Codex'}`,
      run: (session) => resumeSession(session, resumeHost),
    },
    { command: 'resumeInTerminal', icon: 'terminal', label: () => 'Resume in Terminal', run: resumeInTerminal },
    { command: 'openTranscript', icon: 'go-to-file', label: () => 'Open Transcript', run: openTranscript },
    { command: 'reveal', icon: 'folder-opened', label: () => 'Reveal Transcript in File Explorer', run: revealTranscript },
    { command: 'copyId', icon: 'copy', label: () => 'Copy Session ID', run: copySessionId },
    { command: 'moveToTrash', icon: 'trash', label: () => 'Move to Recycle Bin…', run: trashSession },
  ];

  const showActions = async (key: string): Promise<void> => {
    const session = sessionsByKey.get(key);
    if (!session) {
      return;
    }
    const items = sessionActions.map((action) => ({ label: `$(${action.icon}) ${action.label(session)}`, action }));
    const picked = await vscode.window.showQuickPick(items, { title: session.title, placeHolder: 'Choose an action' });
    if (picked) {
      await picked.action.run(session);
    }
  };

  // The webview context menu passes the card's data-vscode-context object, which carries only the session key.
  const runFromContextMenu = async (action: SessionAction, target: unknown): Promise<void> => {
    const key = typeof target === 'object' && target !== null ? (target as Record<string, unknown>).sessionKey : undefined;
    const session = typeof key === 'string' ? sessionsByKey.get(key) : undefined;
    if (session) {
      await action.run(session);
    }
  };

  const handleMessage = async (message: WebviewMessage): Promise<void> => {
    switch (message.type) {
      case 'ready':
        ensureStarted();
        return;
      case 'setScope':
        return setScope(message.scope);
      case 'setSort':
        return setSort(message.sort);
      case 'setQuery':
        querySeq = message.seq;
        return setQuery(message.query);
      case 'refresh':
        return manualRefresh();
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
        return;
      case 'open':
        return openSession(message.key);
      case 'showActions':
        return showActions(message.key);
    }
  };

  const reportActionError = (error: unknown): void => {
    logError(error);
    void vscode.window.showErrorMessage(
      `Agent Session History: ${error instanceof Error ? error.message : String(error)}. See the Agent Session History output for details.`,
    );
  };

  const provider = new SessionWebviewProvider(context.extensionUri, (message) => {
    handleMessage(message).catch(reportActionError);
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

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand('agentSessionHistory.refresh', manualRefresh),
    ...SCOPES.map((value) => vscode.commands.registerCommand(`agentSessionHistory.scope.${value}`, () => setScope(value))),
    vscode.commands.registerCommand('agentSessionHistory.search', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      provider.focusSearch();
    }),
    vscode.commands.registerCommand('agentSessionHistory.clearSearch', () => setQuery('')),
    ...sessionActions.map((action) =>
      vscode.commands.registerCommand(`agentSessionHistory.session.${action.command}`, (target: unknown) =>
        runFromContextMenu(action, target).catch(reportActionError),
      ),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (started && event.affectsConfiguration(CONFIG_SECTION)) {
        restartWatchers();
        void refresh(true);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      if (!started) {
        return;
      }
      await repos.resolveAll(workspaceDirs());
      render();
    }),
    // Opening a folder that another window already shows focuses that window instead of starting a new one.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void resumeHandedOff().catch(logError);
      }
    }),
    { dispose: () => watchers.forEach((watcher) => watcher.dispose()) },
  );

  render();
  void resumeHandedOff().catch(logError);
}

export function deactivate(): void {}

function readStored<T extends string>(context: vscode.ExtensionContext, key: string, allowed: readonly T[], fallback: T): T {
  const stored = context.workspaceState.get<string>(key);
  return allowed.includes(stored as T) ? (stored as T) : fallback;
}

/** Codex session_meta lines reach about 23 KB, so a smaller limit would silently drop whole sessions. */
function readMaxLineBytes(configured: unknown): number {
  return typeof configured === 'number' && Number.isFinite(configured) ? Math.max(MIN_MAX_LINE_BYTES, configured) : DEFAULT_MAX_LINE_BYTES;
}

function readOptions(): IndexOptions {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    claudeHome: expandHome(config.get<string>('claudeDir', '~/.claude')),
    codexHome: expandHome(config.get<string>('codexDir', '~/.codex')),
    includeCodexArchived: config.get<boolean>('includeCodexArchived', false),
    includeNonInteractive: config.get<boolean>('includeNonInteractive', false),
    maxLineBytes: readMaxLineBytes(config.get<unknown>('maxLineBytes')),
    concurrency: 4,
  };
}
