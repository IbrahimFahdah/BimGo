/**
 * Builds HUD strings with the desktop formatting rules (port of BimGo.App/Rendering/TextBuffer.cs):
 * invariant culture, a true minus sign (U+2212) for negatives, an optional plus, and "—" for NaN / infinity.
 * Usage: buffer.clear().append('FPS ').appendNumber(fps, 0).text
 */
export class TextBuffer {
  private static readonly CAPACITY = 512;
  private _text = '';

  /** The current text. */
  get text(): string {
    return this._text;
  }

  /** Clears the buffer. */
  clear(): this {
    this._text = '';
    return this;
  }

  /** Appends text (truncated at the desktop buffer's 512 characters). */
  append(text: string): this {
    const room = TextBuffer.CAPACITY - this._text.length;
    if (room > 0) { this._text += text.length <= room ? text : text.slice(0, room); }
    return this;
  }

  /** Appends an integer. */
  appendInteger(value: number): this {
    return this.append(Math.trunc(value).toString());
  }

  /** Appends an integer with thousands separators ("N0"). */
  appendGrouped(value: number): this {
    return this.append(groupDigits(Math.round(value)));
  }

  /**
   * Appends a number with fixed decimals (0–3); negatives use a true minus sign, and an optional plus for positives.
   */
  appendNumber(value: number, decimals: number, plusSign = false): this {
    if (!Number.isFinite(value)) { return this.append('—'); }
    const places = Math.min(Math.max(Math.trunc(decimals), 0), 3);

    if (value < 0 && Math.abs(value) >= 0.5 * Math.pow(10, -places)) { this.append('−'); }
    else if (plusSign) { this.append('+'); }

    return this.append(Math.abs(value).toFixed(places));
  }
}

/** Formats an integer with comma thousands separators (invariant "N0"). */
export function groupDigits(value: number): string {
  const negative = value < 0;
  const digits = Math.abs(value).toFixed(0);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) { out += ','; }
    out += digits[i];
  }
  return negative ? '-' + out : out;
}
