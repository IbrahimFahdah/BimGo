import { describe, expect, it } from 'vitest';
import { Mp4Writer } from '../src/core/format/Mp4Writer';

/** A box: type, payload start and end (absolute offsets). */
interface Box { type: string; start: number; end: number }

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) { size = Number(view.getBigUint64(at + 8)); header = 16; }
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  expect(at).toBe(end);
  return out;
}

function child(bytes: Uint8Array, parent: Box, type: string, skip = 0): Box {
  const found = boxes(bytes, parent.start + skip, parent.end).find(b => b.type === type);
  expect(found, type).toBeDefined();
  return found!;
}

describe('Mp4Writer', () => {
  it('lays out ftyp, mdat and a sample table that points at each sample', async () => {
    const writer = new Mp4Writer(1920, 1080, 30);
    writer.setDecoderConfig(Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0]));
    const samples = [Uint8Array.from([0, 0, 0, 2, 0x65, 1]), Uint8Array.from([0, 0, 0, 1, 0x41]), Uint8Array.from([0, 0, 0, 3, 0x41, 2, 3])];
    writer.addSample(samples[0], true);
    writer.addSample(samples[1], false);
    writer.addSample(samples[2], false);
    const bytes = new Uint8Array(await writer.finish().arrayBuffer());
    const view = new DataView(bytes.buffer);

    const top = boxes(bytes, 0, bytes.length);
    expect(top.map(b => b.type)).toEqual(['ftyp', 'mdat', 'moov']);
    expect(top[1].end - top[1].start).toBe(6 + 5 + 7);

    const moov = top[2];
    const mvhd = child(bytes, moov, 'mvhd');
    expect(view.getUint32(mvhd.start + 12)).toBe(1000); // movie timescale
    expect(view.getUint32(mvhd.start + 16)).toBe(100); // 3 frames at 30 fps = 100 ms
    const trak = child(bytes, moov, 'trak');
    const tkhd = child(bytes, trak, 'tkhd');
    expect(view.getUint32(tkhd.end - 8) / 65536).toBe(1920);
    expect(view.getUint32(tkhd.end - 4) / 65536).toBe(1080);
    const stbl = child(bytes, child(bytes, child(bytes, trak, 'mdia'), 'minf'), 'stbl');

    const stsd = child(bytes, stbl, 'stsd');
    const avc1 = child(bytes, stsd, 'avc1', 8);
    expect(view.getUint16(avc1.start + 24)).toBe(1920);
    const avcC = child(bytes, avc1, 'avcC', 78);
    expect([...bytes.subarray(avcC.start, avcC.end)]).toEqual([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0]);

    const stts = child(bytes, stbl, 'stts');
    expect([view.getUint32(stts.start + 8), view.getUint32(stts.start + 12)]).toEqual([3, 3000]); // 3 samples of 1/30 s at 90 kHz
    const stss = child(bytes, stbl, 'stss');
    expect([view.getUint32(stss.start + 4), view.getUint32(stss.start + 8)]).toEqual([1, 1]); // one keyframe: sample 1
    const stsz = child(bytes, stbl, 'stsz');
    expect(view.getUint32(stsz.start + 8)).toBe(3);
    const stco = child(bytes, stbl, 'stco');
    for (let i = 0; i < 3; i++) {
      const size = view.getUint32(stsz.start + 12 + i * 4), offset = view.getUint32(stco.start + 8 + i * 4);
      expect([...bytes.subarray(offset, offset + size)]).toEqual([...samples[i]]);
    }
  });

  it('refuses to finish without a configuration or frames', () => {
    expect(() => new Mp4Writer(2, 2, 30).finish()).toThrow();
    const writer = new Mp4Writer(2, 2, 30);
    writer.setDecoderConfig(new Uint8Array(4));
    expect(() => writer.finish()).toThrow();
  });
});
