import * as vscode from 'vscode';
import { SessionRecord } from './model';
import { summarizePaths, summarizeSessions } from './index/ownedPaths';
import { agentLabel, countOf, formatBytes } from './view/format';

/** A transcript touched this recently may belong to a CLI session that is still running. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

export function moveSessionToTrash(session: SessionRecord, clock: () => number = Date.now): Promise<boolean> {
  return moveSessionsToTrash([session], session.title, clock);
}

/** Moves every session in one confirmed batch; the whole batch is refused while any of them may still be in use. */
export async function moveSessionsToTrash(sessions: readonly SessionRecord[], label: string, clock: () => number = Date.now): Promise<boolean> {
  const single = sessions.length === 1 ? sessions[0] : undefined;
  const summary = await summarizeSessions(sessions);
  if (summary.existing.length === 0) {
    void vscode.window.showWarningMessage('The session files no longer exist.');
    return false;
  }
  const activeCount = summary.newestPerSession.filter((mtime) => clock() - mtime < ACTIVE_WINDOW_MS).length;
  if (activeCount > 0) {
    void vscode.window.showWarningMessage(
      single
        ? `"${single.title}" changed in the last 10 minutes and may still be in use. Close it in ${agentLabel(single.agent)} and try again later.`
        : `${countOf(activeCount, 'session')} in "${label}" changed in the last 10 minutes and may still be in use; nothing was moved. Close them and try again later.`,
    );
    return false;
  }

  const confirm = 'Move to Recycle Bin';
  const choice = await vscode.window.showWarningMessage(
    single
      ? `Move the ${agentLabel(single.agent)} session "${single.title}" to the Recycle Bin?`
      : `Move all ${countOf(sessions.length, 'session')} in "${label}" to the Recycle Bin?`,
    {
      modal: true,
      detail: `${summary.fileCount} ${summary.fileCount === 1 ? 'file' : 'files'}, ${formatBytes(summary.totalBytes)}. You can restore them from the Recycle Bin.`,
    },
    confirm,
  );
  if (choice !== confirm) {
    return false;
  }
  // The dialog can stay open for a while, so activity is checked again right before moving.
  const recheck = await summarizePaths(summary.existing);
  if (clock() - recheck.newestMtimeMs < ACTIVE_WINDOW_MS) {
    void vscode.window.showWarningMessage(`"${label}" changed while the confirmation was open; nothing was moved.`);
    return false;
  }

  const failures: string[] = [];
  for (const target of summary.existing) {
    try {
      // Never fall back to a permanent delete when the trash is unavailable.
      await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
    } catch (error) {
      failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    void vscode.window.showErrorMessage(`Could not move ${failures.length} of ${summary.existing.length} paths to the Recycle Bin.`, {
      modal: true,
      detail: failures.join('\n'),
    });
  }
  return failures.length < summary.existing.length;
}
