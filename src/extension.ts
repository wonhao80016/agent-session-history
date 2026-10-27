import * as vscode from 'vscode';
import { SessionTreeProvider } from './view/treeProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SessionTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('agentSessionHistory.sessions', provider),
  );
}

export function deactivate(): void {}
