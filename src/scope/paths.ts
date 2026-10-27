import { homedir } from 'node:os';
import * as path from 'node:path';

/** Produces a comparison key: Windows paths are case-insensitive and may use either separator. */
export function normalizePath(input: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    const normalized = path.posix.normalize(input);
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  }
  const normalized = path.win32.normalize(input.replace(/\//g, '\\'));
  return normalized.replace(/\\+$/, '').toLowerCase();
}

export function displayName(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  return path.win32.basename(trimmed) || trimmed;
}

export function expandHome(input: string): string {
  if (input === '~') {
    return homedir();
  }
  return /^~[\\/]/.test(input) ? path.join(homedir(), input.slice(2)) : input;
}
