/**
 * A minimal ZIP writer (replaces ZipArchive in create mode): entries are deflated with the browser's
 * CompressionStream('deflate-raw') or stored, CRC-32 computed here, UTF-8 names. The result is a Blob, assembled
 * without copying the entry data again. Limited to 4 GB (no ZIP64), far beyond what a browser can hold anyway.
 */
export class ZipWriter {
  private readonly parts: BlobPart[] = [];
  private readonly central: Uint8Array[] = [];
  private offset = 0;
  private count = 0;
  private readonly encoder = new TextEncoder();

  /** Adds an entry. */
  async add(name: string, data: Uint8Array, compress = true, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) { throw new DOMException('Cancelled.', 'AbortError'); }
    const crc = crc32(data);
    const packed = compress ? await deflate(data) : data;
    const method = compress ? 8 : 0;
    const nameBytes = this.encoder.encode(name);
    if (this.offset + 30 + nameBytes.length + packed.length > 0xffffffff) { throw new Error('The file would be larger than 4 GB.'); }

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);            // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);               // time
    lv.setUint16(12, 0x21, true);            // date: 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const header = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, this.offset, true);
    header.set(nameBytes, 46);

    this.parts.push(local as BlobPart, packed as BlobPart);
    this.central.push(header);
    this.offset += local.length + packed.length;
    this.count++;
  }

  /** Adds a UTF-8 text entry. */
  addText(name: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.add(name, this.encoder.encode(text), true, signal);
  }

  /** The finished archive. */
  finish(): Blob {
    const dirSize = this.central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, dirSize, true);
    ev.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...(this.central as BlobPart[]), end as BlobPart], { type: 'application/octet-stream' });
  }
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    table[n] = c >>> 0;
  }
  // Slicing-by-8 tables
  for (let n = 0; n < 256; n++) {
    for (let k = 1; k < 8; k++) { table[k * 256 + n] = (table[(k - 1) * 256 + n] >>> 8) ^ table[table[(k - 1) * 256 + n] & 0xff]; }
  }
  return table;
})();

/** CRC-32 (IEEE), slicing-by-8 so a 35 MB geometry entry takes tens of milliseconds. */
export function crc32(data: Uint8Array): number {
  const t = CRC_TABLE;
  let crc = 0xffffffff;
  let i = 0;
  const n8 = data.length - (data.length % 8);
  for (; i < n8; i += 8) {
    const a = (crc ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24))) >>> 0;
    crc = t[7 * 256 + (a & 0xff)] ^ t[6 * 256 + ((a >>> 8) & 0xff)] ^ t[5 * 256 + ((a >>> 16) & 0xff)] ^ t[4 * 256 + (a >>> 24)]
      ^ t[3 * 256 + data[i + 4]] ^ t[2 * 256 + data[i + 5]] ^ t[256 + data[i + 6]] ^ t[data[i + 7]];
  }
  for (; i < data.length; i++) { crc = t[(crc ^ data[i]) & 0xff] ^ (crc >>> 8); }
  return (crc ^ 0xffffffff) >>> 0;
}
