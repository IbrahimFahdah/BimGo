import { describe, expect, it } from 'vitest';
import { Rgba } from '../src/engine/ui/Rgba';
import { groupDigits, TextBuffer } from '../src/engine/ui/TextBuffer';
import { roundEven, wrapLines } from '../src/engine/ui/UiBatch';
import type { Glyph } from '../src/engine/ui/UiFont';

describe('Rgba', () => {
  it('packs R in the low byte and alpha in the high byte', () => {
    expect(Rgba.hex(0x112233)).toBe(0xff332211);
    expect(Rgba.hex(0x22d3ee, 0.35)).toBe(((0x59 << 24) | 0xeed322) >>> 0);
  });

  it('replaces alpha and unpacks', () => {
    const c = Rgba.withAlpha(Rgba.hex(0xff8000), 0);
    expect(c).toBe(0x000080ff);
    expect(Rgba.toVector(Rgba.hex(0xff0000))).toEqual([1, 0, 0, 1]);
  });
});

describe('TextBuffer', () => {
  it('uses a true minus sign and fixed decimals', () => {
    const b = new TextBuffer();
    expect(b.clear().appendNumber(-1.234, 2).text).toBe('−1.23');
    expect(b.clear().appendNumber(1.5, 1, true).text).toBe('+1.5');
    expect(b.clear().appendNumber(-0.001, 2).text).toBe('0.00');
    expect(b.clear().appendNumber(Number.NaN, 2).text).toBe('—');
  });

  it('groups thousands like N0', () => {
    expect(groupDigits(1234567)).toBe('1,234,567');
    expect(groupDigits(999)).toBe('999');
    expect(groupDigits(-1000)).toBe('-1,000');
  });

  it('caps at 512 characters', () => {
    expect(new TextBuffer().append('x'.repeat(600)).text.length).toBe(512);
  });
});

describe('roundEven', () => {
  it('matches .NET MathF.Round (banker’s rounding)', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4, 2.6].map(roundEven)).toEqual([0, 2, 2, -0, -2, -2, 2, 3]);
  });
});

describe('wrapLines', () => {
  // Every character 10 px wide
  const glyph: Glyph = { u0: 0, v0: 0, u1: 0, v1: 0, width: 10, height: 10, advance: 10, offsetX: 0, offsetY: 0, valid: true };
  const font = { get: () => glyph };

  it('breaks at the last space that fits', () => {
    expect(wrapLines(font, 100, 'hello world again', 6)).toEqual(['hello', 'world', 'again']);
  });

  it('honours newlines and the line cap', () => {
    expect(wrapLines(font, 1000, 'a\nb\nc', 2)).toEqual(['a', 'b']);
  });

  it('breaks long words mid-word', () => {
    expect(wrapLines(font, 30, 'abcdefg', 6)).toEqual(['abc', 'def', 'g']);
  });
});
