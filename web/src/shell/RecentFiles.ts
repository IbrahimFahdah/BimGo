import { readJson, writeJson } from '../platform/settings';

/** One recent file. The browser can't reopen by path, so this is the name list the plan allows outside Chrome / Edge. */
export interface RecentFile {
  name: string;
  size: number;
  lastUsedUtc: string;
}

const KEY = 'recent';
const MAX = 12;

/**
 * The recent files list (port of BimGo.App/Shell/RecentFiles.cs, names only). File handles in IndexedDB, so a click
 * reopens without a dialog on Chrome / Edge, come later.
 */
export class RecentFiles {
  private constructor(private list: RecentFile[]) {}

  /** Loads the list (empty when storage is unavailable). */
  static load(): RecentFiles {
    const raw = readJson<unknown>(KEY, []);
    const list = Array.isArray(raw)
      ? raw.filter((e): e is RecentFile => typeof e?.name === 'string' && typeof e?.size === 'number' && typeof e?.lastUsedUtc === 'string')
      : [];
    return new RecentFiles(list.slice(0, MAX));
  }

  /** Most recent first. */
  get entries(): readonly RecentFile[] {
    return this.list;
  }

  /** Moves a file to the top (adding it when new). */
  touch(name: string, size: number, now = new Date()): void {
    this.list = [{ name, size, lastUsedUtc: now.toISOString() }, ...this.list.filter(e => e.name !== name)].slice(0, MAX);
    writeJson(KEY, this.list);
  }

  /** Removes a file from the list. */
  remove(name: string): void {
    this.list = this.list.filter(e => e.name !== name);
    writeJson(KEY, this.list);
  }
}
