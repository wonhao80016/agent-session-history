import * as vscode from 'vscode';

export class SessionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return [];
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }
}
