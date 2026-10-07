/**
 * A minimal ZIP reader over a Blob (a File from the picker or a drop), replacing System.IO.Compression.ZipArchive.
 * Reads only the central directory up front; entries are inflated on demand with the browser's own
 * DecompressionStream('deflate-raw'), so no package is needed and big entries stream with progress.
 * Supports stored (0) and deflated (8) entries and ZIP64 sizes / offsets.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

/** Thrown for anything that is not a readable ZIP (shown to the user as "damaged"). */
export class ZipError extends Error {}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipReader {
  private constructor(
    private readonly blob: Blob,
    private readonly entries: Map<string, ZipEntry>
  ) {}

  /** Opens a ZIP by reading its central directory. */
  static async open(blob: Blob): Promise<ZipReader> {
    const tailSize = Math.min(blob.size, 65535 + 22 + 20);
    const tailStart = blob.size - tailSize;
    const tail = new DataView(await blob.slice(tailStart).arrayBuffer());

    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === EOCD) { eocd = i; break; }
    }
    if (eocd < 0) { throw new ZipError('This is not a BimGo model (not a ZIP file).'); }

    let count = tail.getUint16(eocd + 10, true);
    let dirSize = tail.getUint32(eocd + 12, true);
    let dirOffset = tail.getUint32(eocd + 16, true);

    // ZIP64: the locator sits just before the EOCD record
    if ((count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) && eocd >= 20 && tail.getUint32(eocd - 20, true) === EOCD64_LOCATOR) {
      const recordOffset = readUint64(tail, eocd - 20 + 8);
      const record = new DataView(await blob.slice(recordOffset, recordOffset + 56).arrayBuffer());
      if (record.getUint32(0, true) !== EOCD64) { throw new ZipError('The file is damaged (bad ZIP64 directory).'); }
      count = readUint64(record, 32);
      dirSize = readUint64(record, 40);
      dirOffset = readUint64(record, 48);
    }
    if (dirOffset + dirSize > blob.size) { throw new ZipError('The file is damaged (it ends early).'); }

    const dir = new DataView(await blob.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
    const decoder = new TextDecoder();
    const entries = new Map<string, ZipEntry>();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== CENTRAL) { throw new ZipError('The file is damaged (bad ZIP directory).'); }
      const flags = dir.getUint16(p + 8, true);
      const method = dir.getUint16(p + 10, true);
      let compressedSize = dir.getUint32(p + 20, true);
      let size = dir.getUint32(p + 24, true);
      const nameLength = dir.getUint16(p + 28, true);
      const extraLength = dir.getUint16(p + 30, true);
      const commentLength = dir.getUint16(p + 32, true);
      let localHeaderOffset = dir.getUint32(p + 42, true);
      const nameBytes = new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength);
      const name = (flags & 0x800) !== 0 ? decoder.decode(nameBytes) : decodeCp437(nameBytes);

      // ZIP64 extra field (id 1): only the fields saturated in the record are present, in this order
      let e = p + 46 + nameLength;
      const extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        const id = dir.getUint16(e, true), length = dir.getUint16(e + 2, true);
        if (id === 1) {
          let q = e + 4;
          if (size === 0xffffffff) { size = readUint64(dir, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = readUint64(dir, q); q += 8; }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = readUint64(dir, q); }
        }
        e += 4 + length;
      }

      entries.set(name, { name, method, compressedSize, size, localHeaderOffset });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return new ZipReader(blob, entries);
  }

  /** The entry names, in directory order. */
  get names(): string[] {
    return [...this.entries.keys()];
  }

  /** Gets an entry by exact name, or null. */
  get(name: string): ZipEntry | null {
    return this.entries.get(name) ?? null;
  }

  /**
   * Reads and inflates an entry.
   * @param onBytes Called with the bytes written so far (for progress bars).
   * @param signal Cancels the read.
   */
  async read(entry: ZipEntry, onBytes?: (done: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
    const header = new DataView(await this.blob.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer());
    if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL) { throw new ZipError(`The file is damaged (${entry.name} has a bad header).`); }
    const dataStart = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const raw = this.blob.slice(dataStart, dataStart + entry.compressedSize);
    if (raw.size !== entry.compressedSize) { throw new ZipError('The file is damaged (it ends early).'); }

    if (entry.method === 0) {
      const bytes = new Uint8Array(await raw.arrayBuffer());
      onBytes?.(bytes.length);
      return bytes;
    }
    if (entry.method !== 8) { throw new ZipError(`The file is damaged (${entry.name} uses an unsupported compression).`); }

    const out = new Uint8Array(entry.size);
    let done = 0;
    const reader = raw.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    try {
      for (;;) {
        if (signal?.aborted) { throw signal.reason ?? new DOMException('Cancelled.', 'AbortError'); }
        const { value, done: finished } = await reader.read();
        if (finished) { break; }
        if (done + value.length > out.length) { throw new ZipError(`The file is damaged (${entry.name} is longer than recorded).`); }
        out.set(value, done);
        done += value.length;
        onBytes?.(done);
      }
    } catch (e) {
      await reader.cancel().catch(() => undefined);
      if (e instanceof TypeError) { throw new ZipError(`The file is damaged (${entry.name} could not be decompressed).`); }
      throw e;
    }
    if (done !== out.length) { throw new ZipError(`The file is damaged (${entry.name} ends early).`); }
    return out;
  }

  /** Reads an entry as UTF-8 text. */
  async readText(entry: ZipEntry, signal?: AbortSignal): Promise<string> {
    return new TextDecoder().decode(await this.read(entry, undefined, signal));
  }
}

function readUint64(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true), high = view.getUint32(offset + 4, true);
  return high * 0x100000000 + low;
}

// CP437 for names without the UTF-8 flag (.NET sets the flag for non-ASCII names, so this is mostly ASCII)
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) { s += b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128]; }
  return s;
}
