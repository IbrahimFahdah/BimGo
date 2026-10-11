/**
 * A minimal MP4 (ISO BMFF) writer for one H.264 video track (the browser's stand-in for the desktop's Media Foundation
 * sink writer: WebCodecs encodes, this only packages). Samples are kept as they arrive and the file is laid out at the
 * end: ftyp, mdat (the samples in order), moov (one chunk per sample, so offsets are simple). No audio, no edit lists.
 * Files over 4 GB switch to 64-bit chunk offsets and a large mdat header.
 */
export class Mp4Writer {
  private readonly samples: Uint8Array[] = [];
  private readonly keyframes: number[] = [];
  private bytes = 0;
  private config: Uint8Array | null = null;

  /**
   * @param width Frame width (px).
   * @param height Frame height (px).
   * @param fps Frames per second (each sample lasts 1 / fps).
   */
  constructor(readonly width: number, readonly height: number, readonly fps: number) {}

  /** Number of samples so far. */
  get count(): number {
    return this.samples.length;
  }

  /** Bytes of sample data so far. */
  get size(): number {
    return this.bytes;
  }

  /** The AVCDecoderConfigurationRecord (WebCodecs' decoderConfig.description in "avc" format). */
  setDecoderConfig(description: Uint8Array): void {
    this.config = description.slice();
  }

  /** Adds the next sample (AVC length-prefixed NAL units, in decode order). */
  addSample(data: Uint8Array, keyframe: boolean): void {
    this.samples.push(data);
    this.bytes += data.length;
    if (keyframe) { this.keyframes.push(this.samples.length); } // 1-based sample numbers
  }

  /** The finished file. Throws when no decoder configuration or no sample was given. */
  finish(): Blob {
    if (!this.config) { throw new Error('the encoder gave no H.264 configuration'); }
    if (this.samples.length === 0) { throw new Error('no frames were encoded'); }

    const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
    const large = this.bytes + 16 > 0xffffffff;
    const mdatHeader = large ? concat(u32(1), ascii('mdat'), u64(this.bytes + 16)) : concat(u32(this.bytes + 8), ascii('mdat'));
    const firstOffset = ftyp.length + mdatHeader.length;
    const moov = this.moov(firstOffset, large);
    return new Blob([ftyp, mdatHeader, ...this.samples, moov] as BlobPart[], { type: 'video/mp4' });
  }

  private moov(firstOffset: number, large: boolean): Uint8Array {
    const timescale = 90000;
    const delta = Math.round(timescale / this.fps);
    const count = this.samples.length;
    const mediaDuration = delta * count;
    const movieTimescale = 1000;
    const movieDuration = Math.round(mediaDuration / timescale * movieTimescale);
    const identity = concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

    const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(movieTimescale), u32(movieDuration), u32(0x00010000), u16(0x0100), u16(0),
      u32(0), u32(0), identity, zeros(24), u32(2));
    const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDuration), zeros(8), u16(0), u16(0), u16(0), u16(0),
      identity, u32(this.width * 65536), u32(this.height * 65536));
    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0)); // language "und"
    const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('BimGo video\0'));

    const avcC = box('avcC', this.config!);
    const avc1 = box('avc1', zeros(6), u16(1), u16(0), u16(0), zeros(12), u16(this.width), u16(this.height), u32(0x00480000), u32(0x00480000),
      u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff), avcC);
    const stsd = fullBox('stsd', 0, 0, u32(1), avc1);
    const stts = fullBox('stts', 0, 0, u32(1), u32(count), u32(delta));
    const stss = fullBox('stss', 0, 0, u32(this.keyframes.length), ...this.keyframes.map(u32));
    const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));
    const sizes = new Uint8Array(count * 4);
    const sizeView = new DataView(sizes.buffer);
    this.samples.forEach((s, i) => sizeView.setUint32(i * 4, s.length));
    const stsz = fullBox('stsz', 0, 0, u32(0), u32(count), sizes);
    const offsets = new Uint8Array(count * (large ? 8 : 4));
    const offsetView = new DataView(offsets.buffer);
    let offset = firstOffset;
    this.samples.forEach((s, i) => {
      if (large) { offsetView.setBigUint64(i * 8, BigInt(offset)); } else { offsetView.setUint32(i * 4, offset); }
      offset += s.length;
    });
    const stco = fullBox(large ? 'co64' : 'stco', 0, 0, u32(count), offsets);

    const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const minf = box('minf', fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)), dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', tkhd, mdia);
    return box('moov', mvhd, trak);
  }
}

// #region Bytes

function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) { length += p.length; }
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function box(type: string, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(u32(body.length + 8), ascii(type), body);
}

function fullBox(type: string, version: number, flags: number, ...content: Uint8Array[]): Uint8Array {
  return box(type, u32(((version & 0xff) << 24 | (flags & 0xffffff)) >>> 0), ...content);
}

function u16(v: number): Uint8Array {
  return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
}

function u32(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v >>> 0);
  return out;
}

function u64(v: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(v));
  return out;
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, c => c.charCodeAt(0) & 0xff);
}

function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

// #endregion
