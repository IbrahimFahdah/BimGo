import { gl } from '../gl/Gl';

/**
 * One glyph's atlas rectangle and metrics (pixels).
 */
export interface Glyph {
  u0: number; v0: number; u1: number; v1: number;
  width: number; height: number;
  advance: number;
  offsetX: number; offsetY: number;
  valid: boolean;
}

const INVALID: Glyph = { u0: 0, v0: 0, u1: 0, v1: 0, width: 0, height: 0, advance: 0, offsetX: 0, offsetY: 0, valid: false };

/**
 * A rasterised font inside the shared atlas (port of BimGo.App/Rendering/UiFont.cs).
 */
export class UiFont {
  constructor(
    /** Line height in pixels. */
    readonly lineHeight: number,
    private readonly latin: Glyph[],
    private readonly extraChars: string[],
    private readonly extraGlyphs: Glyph[]
  ) {}

  /** Gets a glyph ('?' for anything not in the atlas). */
  get(c: string): Glyph {
    const code = c.charCodeAt(0);
    if (code < 256) {
      const glyph = this.latin[code];
      if (glyph.valid) { return glyph; }
    } else {
      const i = this.extraChars.indexOf(c);
      if (i >= 0) { return this.extraGlyphs[i]; }
    }
    return this.latin[63];
  }
}

/**
 * A CSS font choice. The desktop app asks GDI+ for Windows families; the browser gets the same families first and
 * falls back to the platform's UI fonts elsewhere (open decision: ship OFL fallbacks).
 */
interface FontSpec {
  families: string;
  weight: number;
}

const SANS = "Bahnschrift, 'Segoe UI', system-ui, sans-serif";
const MONO = "Consolas, 'Courier New', ui-monospace, monospace";

/**
 * Builds the UI font atlas with a 2D canvas once at start-up (white glyphs on transparent, plus a white block for
 * solid fills). Port of FontAtlas in UiFont.cs.
 */
export class FontAtlas {
  /** Extra non-Latin-1 characters used by the HUD. */
  private static readonly EXTRA = ['Δ', '−', '—', '–', '…', '•', '↑', '↓', '←', '→', '“', '”', '’', '≈'];

  /** The GL texture. */
  texture: WebGLTexture | null = null;
  /** Atlas size in pixels. */
  size = 0;
  /** UV of the solid white block. */
  whiteU = 0;
  whiteV = 0;

  /** Small caps labels (11 px). */
  small!: UiFont;
  /** Body text (14 px). */
  body!: UiFont;
  /** Emphasised body (16 px semibold). */
  bold!: UiFont;
  /** Large title (40 px bold). */
  title!: UiFont;
  /** Monospace readouts (13 px). */
  mono!: UiFont;
  /** Large monospace readouts (26 px). */
  monoLarge!: UiFont;

  /**
   * Rasterises all fonts and uploads the atlas.
   * @param scale UI scale (device pixel ratio; the desktop uses DPI / 96).
   */
  build(scale: number): void {
    this.size = scale <= 1.01 ? 1024 : scale <= 2.01 ? 2048 : 4096;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = this.size;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) { throw new Error('No 2D canvas for the font atlas.'); }

    g.clearRect(0, 0, this.size, this.size);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 4, 4);
    this.whiteU = 2 / this.size;
    this.whiteV = 2 / this.size;

    const packer: Packer = { x: 6, y: 0, rowHeight: 6 };
    this.small = this.rasterise(g, packer, { families: SANS, weight: 600 }, 11 * scale);
    this.body = this.rasterise(g, packer, { families: SANS, weight: 400 }, 14 * scale);
    this.bold = this.rasterise(g, packer, { families: SANS, weight: 600 }, 16 * scale);
    this.title = this.rasterise(g, packer, { families: SANS, weight: 700 }, 40 * scale);
    this.mono = this.rasterise(g, packer, { families: MONO, weight: 400 }, 13 * scale);
    this.monoLarge = this.rasterise(g, packer, { families: MONO, weight: 700 }, 26 * scale);

    this.upload(g);
  }

  /** Rasterises one font into the atlas. */
  private rasterise(g: CanvasRenderingContext2D, p: Packer, spec: FontSpec, pixelSize: number): UiFont {
    g.font = `${spec.weight} ${pixelSize}px ${spec.families}`;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillStyle = '#fff';

    // GDI+ Font.GetHeight ≈ ascent + descent of the font box; the glyph's em top sits one pixel into its cell
    const box = g.measureText('Hg');
    const ascent = box.fontBoundingBoxAscent ?? pixelSize * 0.9;
    const descent = box.fontBoundingBoxDescent ?? pixelSize * 0.25;
    const lineHeight = Math.ceil(ascent + descent);

    // Accented capitals and some descenders draw outside the font box; widen the cell so their ink stays inside it
    // (else it bleeds into the glyphs of the next atlas row). Layout still uses lineHeight, as on the desktop.
    const tall = g.measureText('ÀÁÂÃÄÅÉÊÎÏÔÕÖÛÜÝ');
    const deep = g.measureText('gjpqyÇçþÿ');
    const overTop = Math.max(0, Math.ceil(tall.actualBoundingBoxAscent - ascent));
    const overBottom = Math.max(0, Math.ceil(deep.actualBoundingBoxDescent - descent));
    const cellHeight = Math.trunc(lineHeight) + 2 + overTop + overBottom;
    const latin: Glyph[] = new Array<Glyph>(256).fill(INVALID);
    const extra: Glyph[] = [];

    const add = (c: string): Glyph => {
      const advance = g.measureText(c).width;
      const cellWidth = Math.trunc(Math.ceil(advance)) + 5;

      if (p.x + cellWidth >= this.size) { p.x = 0; p.y += p.rowHeight + 1; p.rowHeight = 0; }
      if (p.y + cellHeight >= this.size) { return INVALID; }

      g.fillText(c, p.x + 2, p.y + 1 + overTop + ascent);
      const glyph: Glyph = {
        u0: p.x / this.size,
        v0: p.y / this.size,
        u1: (p.x + cellWidth) / this.size,
        v1: (p.y + cellHeight) / this.size,
        width: cellWidth,
        height: cellHeight,
        advance,
        offsetX: -2,
        offsetY: -1 - overTop,
        valid: true
      };
      p.x += cellWidth + 1;
      p.rowHeight = Math.max(p.rowHeight, cellHeight);
      return glyph;
    };

    for (let c = 32; c < 256; c++) {
      if (c >= 127 && c < 160) { continue; }
      latin[c] = add(String.fromCharCode(c));
    }
    for (const c of FontAtlas.EXTRA) {
      extra.push(add(c));
    }

    // Next font starts on a fresh row
    p.x = 0;
    p.y += p.rowHeight + 2;
    p.rowHeight = 0;

    return new UiFont(lineHeight, latin, FontAtlas.EXTRA, extra);
  }

  /** Converts to white-with-alpha RGBA and uploads. */
  private upload(g: CanvasRenderingContext2D): void {
    const pixels = g.getImageData(0, 0, this.size, this.size).data;
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255;
      pixels[i + 1] = 255;
      pixels[i + 2] = 255;
    }

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.size, this.size, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Deletes the texture. */
  dispose(): void {
    gl.deleteTexture(this.texture);
    this.texture = null;
  }
}

/** Shelf packer state. */
interface Packer {
  x: number;
  y: number;
  rowHeight: number;
}
