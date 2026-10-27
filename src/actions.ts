import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { resumeCommand } from './commandLine';
import { SessionRecord } from './model';
import { truncate } from './sources/text';
import { agentLabel } from './view/format';

export async function resumeSession(session: SessionRecord): Promise<void> {
  const command = resumeCommand(session);
  if (!command) {
    void vscode.window.showErrorMessage(`Session ID "${session.id}" is not a UUID; not resuming.`);
    return;
  }
  // Resume in the original directory so the agent keeps operating on the same files.
  if (!session.cwd || !existsSync(session.cwd)) {
    const copy = 'Copy Command';
    const choice = await vscode.window.showWarningMessage(
      `The session directory no longer exists: ${session.cwd ?? '(unknown)'}`,
      copy,
    );
    if (choice === copy) {
      await vscode.env.clipboard.writeText(command);
    }
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: truncate(`${agentLabel(session.agent)}: ${session.title}`, 60),
    cwd: session.cwd,
  });
  terminal.show();
  terminal.sendText(command);
}

export async function openTranscript(session: SessionRecord): Promise<void> {
  if (!existsSync(session.filePath)) {
    void vscode.window.showWarningMessage(`The transcript no longer exists: ${session.filePath}`);
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(session.filePath));
  await vscode.window.showTextDocument(document, { preview: true });
  await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
}

export async function copySessionId(session: SessionRecord): Promise<void> {
  await vscode.env.clipboard.writeText(session.id);
  void vscode.window.setStatusBarMessage(`Copied session ID ${session.id}`, 3_000);
}

export async function revealTranscript(session: SessionRecord): Promise<void> {
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(session.filePath));
}
