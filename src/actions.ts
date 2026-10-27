import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { isSessionId, resumeCommand } from './commandLine';
import { SessionRecord } from './model';
import { claudeCanOpenInWindow, claudeProjectDirMatches, claudeProjectDirOf } from './resume/claudeWindow';
import { PendingResume } from './resume/handoff';
import { truncate } from './sources/text';
import { agentLabel } from './view/format';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CODEX_EXTENSION_ID = 'openai.chatgpt';

export interface ResumeHost {
  /** Directories whose Claude project folders the Claude Code extension in this window can resume from. */
  claudeWindowDirs(): Promise<string[]>;
  handOff(pending: PendingResume): Promise<void>;
}

/** Resumes in the agent's own VS Code extension; the terminal is only an explicit fallback. */
export async function resumeSession(session: SessionRecord, host: ResumeHost): Promise<void> {
  if (!isSessionId(session.id)) {
    void vscode.window.showErrorMessage(`Session ID "${session.id}" is not a UUID; not resuming.`);
    return;
  }
  if (session.agent === 'codex') {
    await resumeInCodex(session);
  } else {
    await resumeInClaude(session, host);
  }
}

export async function openClaudeSession(id: string): Promise<void> {
  await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', id);
}

async function resumeInClaude(session: SessionRecord, host: ResumeHost): Promise<void> {
  if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
    await offerTerminal(session, `The Claude Code extension (${CLAUDE_EXTENSION_ID}) is not installed or is disabled.`);
    return;
  }
  if (claudeCanOpenInWindow(session.filePath, await host.claudeWindowDirs(), process.platform)) {
    await openClaudeSession(session.id);
    return;
  }
  if (!session.cwd || !existsSync(session.cwd)) {
    await warnMissingDirectory(session);
    return;
  }
  if (!claudeProjectDirMatches(claudeProjectDirOf(session.filePath), session.cwd, process.platform)) {
    await offerTerminal(session, `Claude Code cannot find this session from a window opened on ${session.cwd}, because its transcript is stored under another project.`);
    return;
  }
  const openWindow = 'Open in New Window';
  const choice = await vscode.window.showInformationMessage(
    'Claude Code can resume this session only from a window opened on its folder.',
    { modal: true, detail: `Open ${session.cwd} in a new window and resume "${session.title}" there?` },
    openWindow,
  );
  if (choice !== openWindow) {
    return;
  }
  await host.handOff({ id: session.id, folder: session.cwd, createdAt: Date.now() });
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.cwd), { forceNewWindow: true });
}

/** Codex resumes a thread in its own recorded cwd, so any thread opens from any window. */
async function resumeInCodex(session: SessionRecord): Promise<void> {
  if (!vscode.extensions.getExtension(CODEX_EXTENSION_ID)) {
    await offerTerminal(session, `The Codex extension (${CODEX_EXTENSION_ID}) is not installed or is disabled.`);
    return;
  }
  const thread = vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: `/local/${session.id}` });
  await vscode.commands.executeCommand('vscode.openWith', thread, 'chatgpt.conversationEditor', { preview: false });
}

async function offerTerminal(session: SessionRecord, message: string): Promise<void> {
  const terminal = 'Resume in Terminal';
  if ((await vscode.window.showWarningMessage(message, terminal)) === terminal) {
    await resumeInTerminal(session);
  }
}

export async function resumeInTerminal(session: SessionRecord): Promise<void> {
  const command = resumeCommand(session);
  if (!command) {
    void vscode.window.showErrorMessage(`Session ID "${session.id}" is not a UUID; not resuming.`);
    return;
  }
  // Resume in the original directory so the agent keeps operating on the same files.
  if (!session.cwd || !existsSync(session.cwd)) {
    await warnMissingDirectory(session);
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: truncate(`${agentLabel(session.agent)}: ${session.title}`, 60),
    cwd: session.cwd,
  });
  terminal.show();
  terminal.sendText(command);
}

async function warnMissingDirectory(session: SessionRecord): Promise<void> {
  const copy = 'Copy Command';
  const choice = await vscode.window.showWarningMessage(`The session directory no longer exists: ${session.cwd ?? '(unknown)'}`, copy);
  const command = resumeCommand(session);
  if (choice === copy && command) {
    await vscode.env.clipboard.writeText(command);
  }
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
