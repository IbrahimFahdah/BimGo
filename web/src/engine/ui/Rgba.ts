/**
 * Colour helpers (RGBA8 packed as R | G << 8 | B << 16 | A << 24, as an unsigned 32-bit number).
 * The byte order matches a little-endian Uint32Array upload read as normalised UNSIGNED_BYTE × 4.
 */
export const Rgba = {
  /** Packs from a 0xRRGGBB hex value and an alpha (0..1). */
  hex(rgb: number, alpha = 1): number {
    const r = (rgb >>> 16) & 0xff, g = (rgb >>> 8) & 0xff, b = rgb & 0xff;
    const a = clampByte(Math.floor(alpha * 255 + 0.5));
    return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
  },

  /** Replaces the alpha of a packed colour. */
  withAlpha(colour: number, alpha: number): number {
    const a = clampByte(Math.floor(alpha * 255 + 0.5));
    return ((colour & 0x00ffffff) | (a << 24)) >>> 0;
  },

  /** Unpacks to 0..1 components [r, g, b, a]. */
  toVector(colour: number): [number, number, number, number] {
    return [(colour & 0xff) / 255, ((colour >>> 8) & 0xff) / 255, ((colour >>> 16) & 0xff) / 255, (colour >>> 24) / 255];
  }
};

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}
