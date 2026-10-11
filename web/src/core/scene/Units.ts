/**
 * The units lengths and areas are shown in (port of UnitSystem). Per browser; the model always stays in metres.
 */
export enum UnitSystem {
  /** Metres, millimetres and square metres (the default). */
  Metric = 0,
  /** Feet and inches (or decimal feet) and square feet. */
  Imperial = 1
}

/** Feet, inches and a reduced fraction of an inch (nearest 1/8"). */
export interface FeetInches {
  /** True for a negative length that doesn't round to zero. */
  negative: boolean;
  feet: number;
  /** Whole inches (0–11). */
  inches: number;
  /** Fraction numerator (0 when none). */
  numerator: number;
  /** Fraction denominator (2, 4 or 8; 1 when none). */
  denominator: number;
}

/**
 * Unit conversions and display text for lengths and areas (port of BimGo.Core/Scene/Units.cs).
 * - Metric: "1.625 m", areas "14.2 m²".
 * - Imperial: feet-inches to the nearest 1/8" ("5' 7 1/2\""), or decimal feet ("5.33'") when chosen; areas
 *   "152.8 ft²". Survey coordinates use decimal feet either way.
 */
export const Units = {
  /** Metres in an international foot. */
  METRES_PER_FOOT: 0.3048,
  /** Metres in an inch. */
  METRES_PER_INCH: 0.0254,
  /** Square feet in a square metre. */
  SQFT_PER_SQM: 1 / (0.3048 * 0.3048),
  /** Feet-inches are rounded to this fraction of an inch (1/8"). */
  INCH_DIVISIONS: 8,

  /** Metres → feet. */
  toFeet(metres: number): number {
    return metres / Units.METRES_PER_FOOT;
  },

  /** Square metres → square feet. */
  toSquareFeet(squareMetres: number): number {
    return squareMetres * Units.SQFT_PER_SQM;
  },

  /**
   * Splits a length into whole feet, whole inches and a reduced fraction of an inch (nearest 1/8"; 11 7/8" that rounds
   * up carries into the next foot).
   * @returns Null for a value that isn't finite.
   */
  feetInches(metres: number): FeetInches | null {
    if (!Number.isFinite(metres)) { return null; }
    // Round half away from zero (MidpointRounding.AwayFromZero)
    const steps = Math.floor(Math.abs(metres) / Units.METRES_PER_INCH * Units.INCH_DIVISIONS + 0.5);
    const perFoot = 12 * Units.INCH_DIVISIONS;
    const rest = steps % perFoot;
    let numerator = rest % Units.INCH_DIVISIONS, denominator = Units.INCH_DIVISIONS;
    if (numerator === 0) {
      denominator = 1;
    } else {
      while (numerator % 2 === 0 && denominator > 1) {
        numerator /= 2;
        denominator /= 2;
      }
    }
    return {
      negative: metres < 0 && steps > 0,
      feet: Math.trunc(steps / perFoot),
      inches: Math.trunc(rest / Units.INCH_DIVISIONS),
      numerator,
      denominator
    };
  },

  /**
   * A length as text: "1.625 m" (metric, the given decimals), "5' 7 1/2\"" (feet-inches) or "5.33'" (decimal feet:
   * the metric decimals, at least 2). Negative values carry a true minus sign.
   */
  length(metres: number, system: UnitSystem, decimalFeet = false, metricDecimals = 3): string {
    if (!Number.isFinite(metres)) { return '—'; }
    if (system === UnitSystem.Metric) { return signed(metres, metricDecimals) + ' m'; }
    if (decimalFeet) { return signed(Units.toFeet(metres), Math.max(2, metricDecimals)) + "'"; }
    const fi = Units.feetInches(metres)!;
    const fraction = fi.numerator > 0 ? ` ${fi.numerator}/${fi.denominator}` : '';
    return `${fi.negative ? '−' : ''}${fi.feet}' ${fi.inches}${fraction}"`;
  },

  /** A survey coordinate or elevation: metres in metric, decimal feet in imperial (both 3 decimals). */
  coordinate(metres: number, system: UnitSystem): string {
    return system === UnitSystem.Metric ? signed(metres, 3) + ' m' : signed(Units.toFeet(metres), 3) + "'";
  },

  /** An area as text: "14.2 m²" or "152.8 ft²" (the given decimals in both). */
  area(squareMetres: number, system: UnitSystem, decimals = 1): string {
    if (!Number.isFinite(squareMetres)) { return '—'; }
    return system === UnitSystem.Metric ? signed(squareMetres, decimals) + ' m²' : signed(Units.toSquareFeet(squareMetres), decimals) + ' ft²';
  },

  /** The unit's area symbol: "m²" or "ft²". */
  areaSymbol(system: UnitSystem): string {
    return system === UnitSystem.Metric ? 'm²' : 'ft²';
  }
};

/** Fixed decimals, true minus sign (none for a value that rounds to zero). */
function signed(value: number, decimals: number): string {
  decimals = Math.min(Math.max(Math.trunc(decimals), 0), 6);
  const text = Math.abs(value).toFixed(decimals);
  const zero = Math.abs(value) < 0.5 * Math.pow(10, -decimals);
  return value < 0 && !zero ? '−' + text : text;
}
