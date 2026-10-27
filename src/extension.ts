import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_MAX_LINE_BYTES } from './model';
import { IndexCache } from './index/cache';
import { IndexOptions, SessionIndexer } from './index/indexer';
import { expandHome } from './scope/paths';
import { SessionTreeProvider } from './view/treeProvider';

const VIEW_ID = 'agentSessionHistory.sessions';
const CONFIG_SECTION = 'agentSessionHistory';
const CACHE_FILE = 'index-v1.json';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Agent Session History');
  const provider = new SessionTreeProvider();
  const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
  const cache = new IndexCache(path.join(context.globalStorageUri.fsPath, CACHE_FILE));
  const indexer = new SessionIndexer(cache, (message) => output.appendLine(message));
  let running: Promise<void> | undefined;
  let rerunRequested = false;

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

  const runIndex = async (): Promise<void> => {
    treeView.message = 'Indexing sessions…';
    try {
      const result = await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, () =>
        indexer.build(readOptions()),
      );
      provider.setSessions(result.sessions);
      treeView.description = `All · ${result.sessions.length} sessions`;
      treeView.message = undefined;
      const { files, parsed, cached, failed, skippedLines, durationMs } = result.stats;
      output.appendLine(
        `Indexed ${files} files in ${durationMs} ms (parsed ${parsed}, cached ${cached}, failed ${failed}, skipped lines ${skippedLines}); listing ${result.sessions.length} sessions.`,
      );
    } catch (error) {
      treeView.message = 'Indexing failed. See the Agent Session History output for details.';
      output.appendLine(`Indexing failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  };

  context.subscriptions.push(
    output,
    treeView,
    vscode.commands.registerCommand('agentSessionHistory.refresh', refresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        void refresh();
      }
    }),
  );

  void cache.load().then(refresh);
}

export function deactivate(): void {}

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
