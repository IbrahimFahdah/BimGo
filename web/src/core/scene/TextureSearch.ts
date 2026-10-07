/** Which deep-scan stage matched a texture, in the order the stages run (port of TextureMatchStage). */
export enum TextureMatchStage {
  None = 0,
  /** The same file name, ignoring case. */
  Exact = 1,
  /** The same name with another image extension. */
  Extension = 2,
  /** A loose name match (separators and colour-map suffixes ignored), only when unique. A proposal. */
  Loose = 3
}

/** One missing texture's deep-scan result (port of TextureSearchResult). */
export class TextureSearchResult {
  constructor(
    /** The path as the appearance stores it. */
    readonly raw: string,
    readonly stage: TextureMatchStage = TextureMatchStage.None,
    /** Every file that matched at that stage (several = ambiguous: the user chooses). */
    readonly candidates: string[] = [],
    /** The only candidate, else null. */
    readonly chosen: string | null = null
  ) {}

  get isAmbiguous(): boolean { return this.candidates.length > 1 && this.chosen === null; }

  /** Exact / extension hits with one candidate come pre-ticked; loose hits are proposals. */
  get preTicked(): boolean {
    return this.chosen !== null && (this.stage === TextureMatchStage.Exact || this.stage === TextureMatchStage.Extension);
  }
}

/** A folder to walk: the browser's FileSystemDirectoryHandle, or a test double. */
export interface FolderSource {
  name: string;
  entries(): AsyncIterable<{ kind: 'file' | 'directory'; name: string; source?: FolderSource; getFile?: () => Promise<File> }>;
}

/** A FolderSource over the browser's File System Access directory handle (Chrome / Edge). */
export function directorySource(handle: FileSystemDirectoryHandle): FolderSource {
  return {
    name: handle.name,
    async *entries() {
      const iterable = handle as unknown as { values(): AsyncIterable<FileSystemHandle> };
      for await (const entry of iterable.values()) {
        if (entry.kind === 'file') {
          const file = entry as FileSystemFileHandle;
          yield { kind: 'file' as const, name: entry.name, getFile: () => file.getFile() };
        } else {
          yield { kind: 'directory' as const, name: entry.name, source: directorySource(entry as FileSystemDirectoryHandle) };
        }
      }
    }
  };
}

/**
 * The image files under one folder, indexed by name for the scan stages (port of TextureFolderIndex). Paths are
 * relative to the folder ("Maps/Floors/a.jpg"). Recursion is capped in depth and file count.
 */
export class TextureFolderIndex {
  static readonly DEFAULT_MAX_DEPTH = 8;
  static readonly DEFAULT_MAX_FILES = 50_000;

  private readonly byName = new Map<string, string[]>();
  private readonly byStem = new Map<string, string[]>();
  private readonly byLoose = new Map<string, string[]>();
  private readonly files = new Map<string, () => Promise<File>>();
  fileCount = 0;
  folderCount = 0;
  truncated = false;

  private constructor(readonly folder: string) {}

  static async build(root: FolderSource, signal?: AbortSignal, onProgress?: (files: number, folders: number) => void,
    maxDepth = TextureFolderIndex.DEFAULT_MAX_DEPTH, maxFiles = TextureFolderIndex.DEFAULT_MAX_FILES): Promise<TextureFolderIndex> {
    const index = new TextureFolderIndex(root.name);
    const pending: { source: FolderSource; path: string; depth: number }[] = [{ source: root, path: '', depth: 0 }];
    while (pending.length > 0) {
      if (signal?.aborted) { throw new DOMException('Cancelled.', 'AbortError'); }
      const { source, path, depth } = pending.pop()!;
      index.folderCount++;
      try {
        for await (const entry of source.entries()) {
          if (entry.kind === 'file') {
            if (!TextureSearch.isImageFile(entry.name)) { continue; }
            if (index.fileCount >= maxFiles) {
              index.truncated = true;
              return index;
            }
            index.add(path + entry.name);
            if (entry.getFile) { index.files.set(path + entry.name, entry.getFile); }
            if ((index.fileCount & 255) === 0) {
              if (signal?.aborted) { throw new DOMException('Cancelled.', 'AbortError'); }
              onProgress?.(index.fileCount, index.folderCount);
            }
          } else if (entry.source) {
            if (depth >= maxDepth) { index.truncated = true; continue; }
            pending.push({ source: entry.source, path: `${path}${entry.name}/`, depth: depth + 1 });
          }
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') { throw e; }
        // Unreadable folder: skip it
      }
    }
    onProgress?.(index.fileCount, index.folderCount);
    return index;
  }

  private add(file: string): void {
    const name = TextureSearch.fileNameOf(file);
    if (!name) { return; }
    this.fileCount++;
    addTo(this.byName, name.toLowerCase(), file);
    addTo(this.byStem, TextureSearch.stemOf(name).toLowerCase(), file);
    if (!TextureSearch.isAuxiliaryMap(name)) { addTo(this.byLoose, TextureSearch.looseStem(name), file); }
  }

  /** Opens an indexed file (null for test doubles without file access). */
  openFile(path: string): Promise<File> | null {
    return this.files.get(path)?.() ?? null;
  }

  lookupName(fileName: string): string[] { return this.byName.get(fileName.toLowerCase()) ?? []; }
  lookupStem(stem: string): string[] { return this.byStem.get(stem.toLowerCase()) ?? []; }
  lookupLoose(looseStem: string): string[] { return this.byLoose.get(looseStem) ?? []; }
}

function addTo(map: Map<string, string[]>, key: string, file: string): void {
  if (!key) { return; }
  const list = map.get(key);
  if (list) { list.push(file); } else { map.set(key, [file]); }
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.gif'];
const COLOUR_SUFFIX = /[_\-. ]+(colou?r|diffuse|diff|albedo|col|base[_\-. ]?colou?r)$/i;
const AUXILIARY_SUFFIX = /[_\-. ]+(bump|normal|nrm|norm|normalgl|normaldx|cutout|opacity|alpha|mask|refl|reflect|reflection|rough|roughness|gloss|glossiness|spec|specular|disp|displacement|height|ao|ambientocclusion|metalness|metallic|emissive)\d*$/i;

/**
 * The staged matcher that finds missing material images in a folder (port of BimGo.Core/Scene/TextureSearch.cs).
 */
export const TextureSearch = {
  IMAGE_EXTENSIONS,

  isImageFile(path: string): boolean {
    const name = TextureSearch.fileNameOf(path);
    if (!name) { return false; }
    const dot = name.lastIndexOf('.');
    return dot > 0 && IMAGE_EXTENSIONS.includes(name.slice(dot).toLowerCase());
  },

  fileNameOf(path: string | null | undefined): string | null {
    if (!path?.trim()) { return null; }
    const trimmed = path.trim().replace(/^"+|"+$/g, '').replace(/[\\/]+$/, '');
    const slash = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
    return name.length === 0 ? null : name;
  },

  /** The file names in a raw appearance path ("a|b" alternatives, either slash), case-insensitively distinct. */
  fileNamesOf(raw: string | null | undefined): string[] {
    const names: string[] = [];
    if (!raw?.trim()) { return names; }
    for (const part of raw.split('|')) {
      const name = TextureSearch.fileNameOf(part);
      if (name && !names.some(n => n.toLowerCase() === name.toLowerCase())) { names.push(name); }
    }
    return names;
  },

  stemOf(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(0, dot) : fileName;
  },

  looseStem(fileName: string): string {
    return TextureSearch.stemOf(fileName ?? '').trim().replace(COLOUR_SUFFIX, '').replace(/[_\-. ]/g, '').toLowerCase();
  },

  isAuxiliaryMap(fileName: string): boolean {
    return AUXILIARY_SUFFIX.test(TextureSearch.stemOf(fileName ?? ''));
  },

  runStage(index: TextureFolderIndex, rawPaths: Iterable<string>, stage: TextureMatchStage): TextureSearchResult[] {
    const results: TextureSearchResult[] = [];
    const seen = new Set<string>();
    for (const raw of rawPaths) {
      if (!raw?.trim() || seen.has(raw.toLowerCase())) { continue; }
      seen.add(raw.toLowerCase());
      let candidates = candidatesFor(index, raw, stage);
      // Loose hits are only proposed when exactly one file matches; several loose hits are no hit at all
      if (stage === TextureMatchStage.Loose && candidates.length !== 1) { candidates = []; }
      results.push(new TextureSearchResult(raw, candidates.length > 0 ? stage : TextureMatchStage.None, candidates,
        candidates.length === 1 ? candidates[0] : null));
    }
    return results;
  },

  runAll(index: TextureFolderIndex, rawPaths: Iterable<string>, lastStage = TextureMatchStage.Loose): TextureSearchResult[] {
    const order: string[] = [];
    for (const raw of rawPaths) {
      if (raw?.trim() && !order.some(o => o.toLowerCase() === raw.toLowerCase())) { order.push(raw); }
    }
    const final = new Map<string, TextureSearchResult>();
    let remaining = [...order];
    for (let stage = TextureMatchStage.Exact; stage <= lastStage && remaining.length > 0; stage++) {
      const results = TextureSearch.runStage(index, remaining, stage);
      remaining = [];
      for (const result of results) {
        final.set(result.raw.toLowerCase(), result);
        if (result.stage === TextureMatchStage.None) { remaining.push(result.raw); }
      }
    }
    return order.map(raw => final.get(raw.toLowerCase()) ?? new TextureSearchResult(raw));
  }
};

function candidatesFor(index: TextureFolderIndex, raw: string, stage: TextureMatchStage): string[] {
  const found: string[] = [];
  for (const name of TextureSearch.fileNamesOf(raw)) {
    const hits = stage === TextureMatchStage.Exact ? index.lookupName(name)
      : stage === TextureMatchStage.Extension ? index.lookupStem(TextureSearch.stemOf(name)).filter(f => !TextureSearch.isAuxiliaryMap(TextureSearch.fileNameOf(f) ?? ''))
        : stage === TextureMatchStage.Loose ? index.lookupLoose(TextureSearch.looseStem(name)) : [];
    for (const hit of hits) {
      if (!found.some(f => f.toLowerCase() === hit.toLowerCase())) { found.push(hit); }
    }
  }
  return found.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
