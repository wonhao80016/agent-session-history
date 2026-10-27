import { AgentKind, SessionRecord } from '../model';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function agentLabel(agent: AgentKind): string {
  return agent === 'claude' ? 'Claude' : 'Codex';
}

export function relativeTime(iso: string | undefined, now: number): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) {
    return 'unknown';
  }
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) {
    return 'just now';
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }
  if (elapsed < 30 * DAY) {
    return `${Math.floor(elapsed / DAY)}d ago`;
  }
  if (elapsed < 365 * DAY) {
    return `${Math.floor(elapsed / (30 * DAY))}mo ago`;
  }
  return `${Math.floor(elapsed / (365 * DAY))}y ago`;
}

export function sessionDescription(session: SessionRecord, now: number): string {
  const messages = `${session.messageCount} ${session.messageCount === 1 ? 'msg' : 'msgs'}`;
  return `${agentLabel(session.agent)} · ${messages} · ${relativeTime(session.updatedAt, now)}`;
}

export interface TooltipField {
  label: string;
  value: string;
}

export function tooltipFields(session: SessionRecord): TooltipField[] {
  const fields: TooltipField[] = [
    { label: 'Agent', value: agentLabel(session.agent) },
    { label: 'Model', value: session.model ?? '—' },
    { label: 'Branch', value: session.gitBranch ?? '—' },
    { label: 'Messages', value: String(session.messageCount) },
    { label: 'Subagents', value: String(session.subagentCount) },
    { label: 'Updated', value: session.updatedAt ? new Date(session.updatedAt).toLocaleString() : '—' },
    { label: 'Directory', value: session.cwd ?? '—' },
    { label: 'Session', value: session.id },
  ];
  if (!session.interactive) {
    fields.push({ label: 'Mode', value: 'non-interactive' });
  }
  return fields;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
