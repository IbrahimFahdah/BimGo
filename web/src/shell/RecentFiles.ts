import { readJson, writeJson } from '../platform/settings';

/** One recent file. The browser can't reopen by path, so this is the name list the plan allows outside Chrome / Edge. */
export interface RecentFile {
  name: string;
  size: number;
  lastUsedUtc: string;
  /** The file's thumbnail.jpg as base64 (review tools round), or absent (older files, Revit exports). */
  thumbnail?: string;
}

const KEY = 'recent';
const MAX = 12;

/** Largest thumbnail kept in the list (base64 characters): the 384 × 216 JPEGs BimGo writes are 15–40 kB. */
const MAX_THUMBNAIL = 120_000;

/**
 * The recent files list (port of BimGo.App/Shell/RecentFiles.cs, names only, with each file's start-screen thumbnail).
 * File handles in IndexedDB, so a click reopens without a dialog on Chrome / Edge, come later.
 */
export class RecentFiles {
  private constructor(private list: RecentFile[]) {}

  /** Loads the list (empty when storage is unavailable). */
  static load(): RecentFiles {
    const raw = readJson<unknown>(KEY, []);
    const list = Array.isArray(raw)
      ? raw.filter((e): e is RecentFile => typeof e?.name === 'string' && typeof e?.size === 'number' && typeof e?.lastUsedUtc === 'string')
        .map(e => (typeof e.thumbnail === 'string' && e.thumbnail.length <= MAX_THUMBNAIL ? e : { name: e.name, size: e.size, lastUsedUtc: e.lastUsedUtc }))
      : [];
    return new RecentFiles(list.slice(0, MAX));
  }

  /** Most recent first. */
  get entries(): readonly RecentFile[] {
    return this.list;
  }

  /**
   * Moves a file to the top (adding it when new).
   * @param thumbnail The file's thumbnail JPEG; undefined keeps the one already listed, null removes it.
   */
  touch(name: string, size: number, thumbnail?: Uint8Array | null, now = new Date()): void {
    const previous = this.list.find(e => e.name === name);
    const entry: RecentFile = { name, size, lastUsedUtc: now.toISOString() };
    const picture = thumbnail === undefined ? previous?.thumbnail : thumbnail ? toBase64(thumbnail) : undefined;
    if (picture && picture.length <= MAX_THUMBNAIL) { entry.thumbnail = picture; }
    this.list = [entry, ...this.list.filter(e => e.name !== name)].slice(0, MAX);
    this.write();
  }

  /** Removes a file from the list. */
  remove(name: string): void {
    this.list = this.list.filter(e => e.name !== name);
    this.write();
  }

  /** Writes the list; when storage is full, drops the oldest thumbnails until it fits. */
  private write(): void {
    for (let i = this.list.length - 1; !writeJson(KEY, this.list) && i >= 0; i--) { delete this.list[i].thumbnail; }
  }
}

/** The last Revit model walked live (the start screen shows it greyed: "open it in Revit and press Go"). */
export interface LastLiveSession {
  docTitle: string;
  revitVersion: string;
  lastUsedUtc: string;
}

const LAST_LIVE_KEY = 'lastLive';

export const LastLive = {
  /** The last live session, or null (none yet, or unreadable). */
  load(): LastLiveSession | null {
    const raw = readJson<Partial<LastLiveSession> | null>(LAST_LIVE_KEY, null);
    if (!raw || typeof raw.docTitle !== 'string' || !raw.docTitle.trim()) { return null; }
    return { docTitle: raw.docTitle, revitVersion: typeof raw.revitVersion === 'string' ? raw.revitVersion : '', lastUsedUtc: typeof raw.lastUsedUtc === 'string' ? raw.lastUsedUtc : '' };
  },

  /** Records a joined session. */
  save(docTitle: string, revitVersion: string, now = new Date()): void {
    writeJson(LAST_LIVE_KEY, { docTitle, revitVersion, lastUsedUtc: now.toISOString() });
  }
};

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) { binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); }
  return btoa(binary);
}
