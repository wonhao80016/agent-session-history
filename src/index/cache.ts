import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { SessionRecord } from '../model';

/** Bump when SessionRecord or parser semantics change so stale entries are discarded. */
export const CACHE_SCHEMA_VERSION = 2;

export interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** null when the file was parsed but contained no session. */
  record: SessionRecord | null;
}

interface CacheFile {
  version: number;
  optionsKey: string;
  entries: Record<string, CacheEntry>;
}

export class IndexCache {
  private entries = new Map<string, CacheEntry>();
  private optionsKey = '';
  private loading: Promise<void> | undefined;

  constructor(private readonly filePath: string | undefined) {}

  load(): Promise<void> {
    this.loading ??= this.readFromDisk();
    return this.loading;
  }

  /** Resolves once any load() in flight has finished, so indexing never runs against a half-loaded cache. */
  async ready(): Promise<void> {
    await this.loading;
  }

  private async readFromDisk(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as CacheFile;
      if (parsed.version === CACHE_SCHEMA_VERSION && parsed.entries && typeof parsed.optionsKey === 'string') {
        this.entries = new Map(Object.entries(parsed.entries));
        this.optionsKey = parsed.optionsKey;
      }
    } catch {
      this.entries = new Map();
      this.optionsKey = '';
    }
  }

  /** Entries parsed under different parse options (for example a new line-size limit) are discarded. */
  useOptions(optionsKey: string): void {
    if (optionsKey !== this.optionsKey) {
      this.entries = new Map();
      this.optionsKey = optionsKey;
    }
  }

  lookup(filePath: string, mtimeMs: number, size: number): CacheEntry | undefined {
    const entry = this.entries.get(filePath);
    return entry && entry.mtimeMs === mtimeMs && entry.size === size ? entry : undefined;
  }

  replaceAll(entries: Map<string, CacheEntry>): void {
    this.entries = entries;
  }

  async save(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    const body: CacheFile = { version: CACHE_SCHEMA_VERSION, optionsKey: this.optionsKey, entries: Object.fromEntries(this.entries) };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    // Several VS Code windows share globalStorage, so each writer needs its own temp file.
    const temp = `${this.filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(body), 'utf8');
      await rename(temp, this.filePath);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
