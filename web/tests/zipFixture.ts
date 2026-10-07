import { deflateRawSync } from 'node:zlib';

/**
 * Builds a small ZIP in memory (deflated entries, UTF-8 names) for reader tests, without a ZIP package.
 */
export function buildZip(entries: Record<string, Uint8Array | string>): Blob {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const packed = new Uint8Array(deflateRawSync(data));
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + packed.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(packed, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, end] as BlobPart[]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let k = 0; k < 8; k++) { crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A geometry.bin with the given vertices (x, y, z each; normal +Z; white) and indices. */
export function buildGeometry(positions: number[][], indices: number[]): Uint8Array {
  const bytes = new Uint8Array(24 + positions.length * 28 + indices.length * 4);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0x4f454742, true);
  v.setInt32(4, 1, true);
  v.setInt32(8, 28, true);
  v.setInt32(12, positions.length, true);
  v.setInt32(16, indices.length, true);
  positions.forEach((p, i) => {
    const o = 24 + i * 28;
    v.setFloat32(o, p[0], true);
    v.setFloat32(o + 4, p[1], true);
    v.setFloat32(o + 8, p[2], true);
    v.setFloat32(o + 20, 1, true);
    v.setUint32(o + 24, 0xffffffff, true);
  });
  indices.forEach((n, i) => v.setUint32(24 + positions.length * 28 + i * 4, n, true));
  return bytes;
}
