/**
 * Opening files in the browser (replaces BimGo.App/Platform/FileDialogs.cs).
 * Chrome / Edge get a File System Access handle (save in place later); other browsers get a plain File.
 */

/** The .bimgo extension (BimGoFormat.EXTENSION). */
export const BIMGO_EXTENSION = '.bimgo';

/** A file the user chose. */
export interface PickedFile {
  file: File;
  /** A writable handle on Chrome / Edge, for Save in place; null elsewhere. */
  handle: FileSystemFileHandle | null;
}

/** True when the name ends in .bimgo (any case), like BimGoFormat.HasExtension. */
export function hasBimGoExtension(name: string): boolean {
  return name.toLowerCase().endsWith(BIMGO_EXTENSION);
}

interface OpenFilePickerWindow {
  showOpenFilePicker?: (options: unknown) => Promise<FileSystemFileHandle[]>;
}

/**
 * Shows the Open dialog. Must run soon after a user gesture (click or key press).
 * @returns The chosen file, or null when cancelled.
 */
export async function pickBimGoFile(): Promise<PickedFile | null> {
  const picker = (window as unknown as OpenFilePickerWindow).showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker.call(window, {
        id: 'bimgo-open',
        types: [{ description: 'BimGo model', accept: { 'application/octet-stream': [BIMGO_EXTENSION] } }],
        excludeAcceptAllOption: false,
        multiple: false
      });
      return { file: await handle.getFile(), handle };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') { return null; }
      // SecurityError (no gesture) or similar: fall back to the input element
    }
  }
  const file = await pickWithInput();
  return file ? { file, handle: null } : null;
}

function pickWithInput(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = BIMGO_EXTENSION;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/** A human-readable size (e.g. "12.4 MB"). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Saves a blob through the browser's download (screenshots, CSV exports). */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** A file name without characters Windows / macOS refuse. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'BimGo';
}
