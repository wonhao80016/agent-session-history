import * as vscode from 'vscode';
import { SessionRecord } from '../model';
import { sessionDescription, tooltipFields } from './format';
import { ProjectGroup } from './grouping';

export type TreeNode = { kind: 'project'; group: ProjectGroup } | { kind: 'session'; session: SessionRecord };

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private groups: ProjectGroup[] = [];

  setGroups(groups: ProjectGroup[]): void {
    this.groups = groups;
    this.changeEmitter.fire(undefined);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.groups.map((group) => ({ kind: 'project', group }));
    }
    if (element.kind === 'project') {
      return element.group.sessions.map((session) => ({ kind: 'session', session }));
    }
    return [];
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element.kind === 'project' ? this.projectItem(element.group) : this.sessionItem(element.session);
  }

  private projectItem(group: ProjectGroup): vscode.TreeItem {
    const isNewest = group === this.groups[0];
    const item = new vscode.TreeItem(
      group.label,
      isNewest ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `project:${group.key}`;
    item.description = String(group.sessions.length);
    item.tooltip = group.path ?? group.label;
    item.iconPath = new vscode.ThemeIcon('folder');
    item.contextValue = 'project';
    return item;
  }

  private sessionItem(session: SessionRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
    item.id = `session:${session.agent}:${session.id}`;
    item.description = sessionDescription(session, Date.now());
    item.tooltip = buildTooltip(session);
    item.iconPath = new vscode.ThemeIcon(session.agent === 'claude' ? 'sparkle' : 'robot');
    item.contextValue = `session.${session.agent}`;
    return item;
  }
}

function buildTooltip(session: SessionRecord): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown('**').appendText(session.title).appendMarkdown('**\n\n');
  if (session.lastReply) {
    tooltip.appendText(session.lastReply).appendMarkdown('\n\n---\n\n');
  }
  for (const field of tooltipFields(session)) {
    tooltip.appendMarkdown(`**${field.label}:** `).appendText(field.value).appendMarkdown('  \n');
  }
  return tooltip;
}
