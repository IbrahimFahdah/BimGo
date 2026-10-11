import { Units, UnitSystem } from '../core/scene/Units';
import type { TextBuffer } from '../engine/ui/TextBuffer';

let current = UnitSystem.Metric;
let decimalFeet = false;
let revision = 0;

/**
 * The viewer's current display units (port of BimGo.App/Game/UnitFormat.cs) and formatting into a TextBuffer. One
 * walkthrough runs per page and the choice is per browser, so it lives here rather than being passed to every gun and
 * panel. Set from the viewer settings when a session starts and when the pause menu changes it. Lux and daylight %
 * never change with it.
 */
export const UnitFormat = {
  /** Metric or imperial. */
  get current(): UnitSystem { return current; },
  /** Imperial lengths as decimal feet rather than feet-inches. */
  get decimalFeet(): boolean { return decimalFeet; },
  /** True when imperial units are shown. */
  get isImperial(): boolean { return current === UnitSystem.Imperial; },
  /** Incremented on every change (labels cached as strings rebuild when it moves). */
  get revision(): number { return revision; },

  /** Sets the units (no-op when unchanged). */
  set(system: UnitSystem, decimal: boolean): void {
    if (system !== UnitSystem.Imperial) { system = UnitSystem.Metric; }
    if (system === current && decimal === decimalFeet) { return; }
    current = system;
    decimalFeet = decimal;
    revision++;
  },

  /** Appends a length: "1.625 m" (the given metric decimals), "5' 7 1/2\"" or "5.33'". */
  appendLength(text: TextBuffer, metres: number, metricDecimals = 3, plusSign = false): TextBuffer {
    if (!Number.isFinite(metres)) { return text.append('—'); }
    if (current === UnitSystem.Metric) { return text.appendNumber(metres, metricDecimals, plusSign).append(' m'); }
    if (decimalFeet) { return text.appendNumber(Units.toFeet(metres), Math.max(2, metricDecimals), plusSign).append("'"); }
    const fi = Units.feetInches(metres)!;
    if (fi.negative) { text.append('−'); } else if (plusSign) { text.append('+'); }
    text.append(`${fi.feet}' ${fi.inches}`);
    if (fi.numerator > 0) { text.append(` ${fi.numerator}/${fi.denominator}`); }
    return text.append('"');
  },

  /** Appends a survey coordinate or elevation: metres, or decimal feet in imperial (3 decimals). */
  appendCoordinate(text: TextBuffer, metres: number): TextBuffer {
    return current === UnitSystem.Metric ? text.appendNumber(metres, 3).append(' m') : text.appendNumber(Units.toFeet(metres), 3).append("'");
  },

  /** Appends an area: "14.2 m²" or "152.8 ft²". */
  appendArea(text: TextBuffer, squareMetres: number, decimals = 1): TextBuffer {
    return current === UnitSystem.Metric ? text.appendNumber(squareMetres, decimals).append(' m²') : text.appendNumber(Units.toSquareFeet(squareMetres), decimals).append(' ft²');
  },

  /** A length as a string (toasts and labels made once). */
  length(metres: number, metricDecimals = 3): string {
    return Units.length(metres, current, decimalFeet, metricDecimals);
  },

  /** An area as a string. */
  area(squareMetres: number, decimals = 1): string {
    return Units.area(squareMetres, current, decimals);
  },

  /** "Metric" / "Imperial". */
  get label(): string {
    return current === UnitSystem.Metric ? 'Metric' : decimalFeet ? 'Imperial (decimal feet)' : 'Imperial';
  }
};
