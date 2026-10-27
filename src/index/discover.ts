import { readdir } from 'node:fs/promises';
import * as path from 'node:path';

export interface SourceDirs {
  claudeHome: string;
  codexHome: string;
  includeCodexArchived: boolean;
}

export interface DiscoveredFiles {
  claude: string[];
  codex: string[];
}

export async function discoverSessionFiles(dirs: SourceDirs): Promise<DiscoveredFiles> {
  const codexRoots = [path.join(dirs.codexHome, 'sessions')];
  if (dirs.includeCodexArchived) {
    codexRoots.push(path.join(dirs.codexHome, 'archived_sessions'));
  }
  const [claude, ...codexLists] = await Promise.all([
    listClaudeTranscripts(path.join(dirs.claudeHome, 'projects')),
    ...codexRoots.map((root) => listRecursive(root, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))),
  ]);
  return { claude, codex: codexLists.flat() };
}

/** Only `<projects>/<project>/<id>.jsonl` are sessions; deeper files belong to subagents or tool output. */
async function listClaudeTranscripts(projectsDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const project of await readDirSafe(projectsDir)) {
    if (!project.isDirectory()) {
      continue;
    }
    const projectDir = path.join(projectsDir, project.name);
    for (const entry of await readDirSafe(projectDir)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path.join(projectDir, entry.name));
      }
    }
  }
  return files;
}

async function listRecursive(root: string, accept: (name: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of await readDirSafe(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && accept(entry.name)) {
        files.push(full);
      }
    }
  }
  return files;
}

async function readDirSafe(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
