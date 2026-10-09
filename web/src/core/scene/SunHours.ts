import type { Vec3 } from '../math/Vector';
import type { SiteInfo } from './ModelInfo';
import { SolarPosition } from './SolarPosition';

/**
 * The inputs of a direct sun hours study (port of SunHoursSettings): the day, the time range and how the test grid is
 * laid out. Times are local clock minutes after midnight, as in the sun panel.
 */
export interface SunHoursSettings {
  /** 1–12 (default 21 June). */
  month: number;
  day: number;
  /** Minutes after midnight (default 9:00–15:00). */
  startMinutes: number;
  endMinutes: number;
  /** Minutes between sun positions: 5, 10 or 15. */
  stepMinutes: number;
  daylightSaving: boolean;
  /** Test grid cell size (m): 0.1, 0.25, 0.5 or 1. */
  gridSize: number;
  /** Floors (and other upward faces) are tested this high above the surface (m, 0–2). */
  floorOffset: number;
  /** Walls (and other faces) are tested this far off the surface (m, 0–1). */
  wallOffset: number;
  /** True when glass stops direct sun (default: sun passes through glazing). */
  glassBlocks: boolean;
}

export const SUN_HOURS_GRID_SIZES = [0.1, 0.25, 0.5, 1];
export const SUN_HOURS_STEPS = [5, 10, 15];

export function defaultSunHoursSettings(): SunHoursSettings {
  return { month: 6, day: 21, startMinutes: 9 * 60, endMinutes: 15 * 60, stepMinutes: 5, daylightSaving: false, gridSize: 0.25, floorOffset: 0, wallOffset: 0, glassBlocks: false };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nearest(values: number[], v: number): number {
  return values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), values[0]);
}

/** A copy with every value clamped to something sensible (end after start, known grid and step). */
export function cleanSunHoursSettings(s: SunHoursSettings, year: number): SunHoursSettings {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const month = clamp(Math.trunc(s.month), 1, 12);
  const start = clamp(Math.trunc(s.startMinutes), 0, 24 * 60 - 5);
  return {
    month,
    day: clamp(Math.trunc(s.day), 1, daysInMonth(clamp(year, 1, 9999), month)),
    startMinutes: start,
    endMinutes: clamp(Math.trunc(s.endMinutes), start + 5, 24 * 60),
    stepMinutes: nearest(SUN_HOURS_STEPS, s.stepMinutes),
    daylightSaving: s.daylightSaving,
    gridSize: nearest(SUN_HOURS_GRID_SIZES, s.gridSize),
    floorOffset: Number.isFinite(s.floorOffset) ? clamp(s.floorOffset, 0, 2) : 0,
    wallOffset: Number.isFinite(s.wallOffset) ? clamp(s.wallOffset, 0, 1) : 0,
    glassBlocks: s.glassBlocks
  };
}

/**
 * Direct sun hours (port of SunHours.cs): the sun positions of a study and the Ladybug legend colours. A test point
 * gets one step of sun for every sample whose sun is above the horizon, in front of the surface and not blocked;
 * samples sit in the middle of each step (9:00–15:00 at 5 min = 72 samples, 9:02:30 … 14:57:30).
 */
export const SunHours = {
  /** The legend's top (h): Ladybug's usual 0–7 h range; more reads as the top colour. */
  LEGEND_MAX: 7,

  /** Ladybug's default legend colours, low to high (RGB 0–255). */
  LADYBUG: [[75, 107, 169], [115, 147, 202], [170, 200, 247], [193, 213, 208], [245, 239, 103],
    [252, 230, 74], [239, 156, 21], [234, 123, 0], [234, 74, 0], [234, 38, 0]] as const,

  /**
   * The sun directions (unit vectors towards the sun, in the model's scene axes) of the samples above the horizon,
   * from the site location and true north (Sydney when the model has none).
   */
  sunDirections(site: SiteInfo | null, year: number, settings: SunHoursSettings): { directions: Vec3[]; samples: number; locationKnown: boolean } {
    const s = cleanSunHoursSettings(settings, year);
    const { location, known } = SolarPosition.locationOf(site);
    const north = SolarPosition.northAngle(site);
    const directions: Vec3[] = [];
    let samples = 0;
    for (let minutes = s.startMinutes + s.stepMinutes * 0.5; minutes < s.endMinutes; minutes += s.stepMinutes) {
      samples++;
      const { altitude, azimuth } = SolarPosition.compute(location, year, s.month, s.day, minutes, s.daylightSaving);
      if (altitude <= 0) { continue; }
      directions.push(SolarPosition.toModel(SolarPosition.direction(altitude, azimuth), north));
    }
    return { directions, samples, locationKnown: known };
  },

  /** The legend colour of a number of hours (0 → blue, LEGEND_MAX and over → red), RGB 0–1. */
  legendColour(hours: number): [number, number, number] {
    const colours = SunHours.LADYBUG;
    const t = Number.isFinite(hours) ? Math.min(Math.max(hours / SunHours.LEGEND_MAX, 0), 1) : 0;
    const position = t * (colours.length - 1);
    const i = Math.min(Math.trunc(position), colours.length - 2);
    const f = position - i;
    const a = colours[i], b = colours[i + 1];
    return [(a[0] + (b[0] - a[0]) * f) / 255, (a[1] + (b[1] - a[1]) * f) / 255, (a[2] + (b[2] - a[2]) * f) / 255];
  }
};
