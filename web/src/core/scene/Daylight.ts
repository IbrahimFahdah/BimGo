import { type Vec3, vec3 } from '../math/Vector';
import { SunHours } from './SunHours';

const ALT_BANDS = 8, AZ_BINS = 24, PATCHES = ALT_BANDS * AZ_BINS;
const BAND = Math.PI / 2 / ALT_BANDS;
const BIN = 2 * Math.PI / AZ_BINS;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Patch centres and solid angles, worked out once. */
const CENTRES: Vec3[] = [];
const SOLID: number[] = [];
for (let p = 0; p < PATCHES; p++) {
  const altitude = (Math.trunc(p / AZ_BINS) + 0.5) * BAND;
  const azimuth = (p % AZ_BINS + 0.5) * BIN;
  const c = Math.cos(altitude);
  CENTRES.push(vec3(Math.fround(c * Math.cos(azimuth)), Math.fround(c * Math.sin(azimuth)), Math.fround(Math.sin(altitude))));
  const band = Math.trunc(p / AZ_BINS);
  SOLID.push(BIN * (Math.sin((band + 1) * BAND) - Math.sin(band * BAND)));
}

/**
 * Daylight maths (port of BimGo.Core/Scene/Daylight.cs):
 * - a fixed sky of 192 patches (8 altitude bands of 11.25° × 24 azimuth bins of 15°, scene axes, Z up): rays are
 *   binned into patches once per cell, then any sky is a 192-term sum;
 * - CIE overcast and CIE clear sky luminance distributions (the clear sky scaled to the IES clear-sky diffuse
 *   horizontal illuminance), the sun's direct normal illuminance by the IES extinction formula;
 * - BRE split-flux internally reflected component, reflectance from a colour, cosine-weighted ray directions.
 * Results are early design indicators, not a validated simulation such as Radiance.
 */
export const Daylight = {
  ALT_BANDS, AZ_BINS, PATCHES,
  /** Visible transmittance used for glazing (one layer). */
  GLASS_VLT: 0.7,
  /** Ground reflectance outside. */
  GROUND_REFLECTANCE: 0.2,
  /** Reflectance of external obstructions. */
  OBSTRUCTION_REFLECTANCE: 0.2,
  /** Standard reflectances used when colours aren't (and as fallbacks). */
  CEILING_REFLECTANCE: 0.7,
  WALL_REFLECTANCE: 0.5,
  FLOOR_REFLECTANCE: 0.2,
  /** BRE's C for an unobstructed view. */
  SPLIT_FLUX_C: 39,
  /** Legend tops: daylight factor (%) and illuminance (lux). */
  DF_LEGEND_MAX: 5,
  LUX_LEGEND_MAX: 2000,

  /** The patch a direction above the horizon falls in (at or below it: -1). */
  patchOf(x: number, y: number, z: number): number {
    if (z <= 0) { return -1; }
    const altitude = Math.asin(clamp(z, 0, 1));
    const band = Math.min(ALT_BANDS - 1, Math.trunc(altitude / BAND));
    let azimuth = Math.atan2(y, x);
    if (azimuth < 0) { azimuth += 2 * Math.PI; }
    const bin = Math.min(AZ_BINS - 1, Math.trunc(azimuth / BIN));
    return band * AZ_BINS + bin;
  },

  /** The unit direction through a patch's centre. */
  patchCentre(patch: number): Vec3 {
    return CENTRES[patch];
  },

  /** A patch's solid angle (sr). */
  patchSolidAngle(patch: number): number {
    return SOLID[patch];
  },

  /** The illuminance a set of patch luminances gives an unobstructed horizontal plane (Σ L · sin(altitude) · Ω). */
  horizontalIlluminance(luminance: Float32Array): number {
    let sum = 0;
    for (let p = 0; p < PATCHES; p++) { sum += luminance[p] * CENTRES[p].z * SOLID[p]; }
    return sum;
  },

  /** CIE overcast sky luminance relative to the zenith: (1 + 2 sin altitude) / 3. */
  overcastLuminance(z: number): number {
    return (1 + 2 * Math.max(0, z)) / 3;
  },

  /** The overcast sky's patch luminances, scaled so the unobstructed horizontal illuminance is 1. */
  overcastPatches(luminance: Float32Array): void {
    for (let p = 0; p < PATCHES; p++) { luminance[p] = Daylight.overcastLuminance(CENTRES[p].z); }
    scale(luminance, 1 / Daylight.horizontalIlluminance(luminance));
  },

  /** CIE clear sky luminance relative to the zenith for a sky direction and a sun direction (both unit, Z up). */
  clearLuminance(direction: Vec3, sun: Vec3): number {
    const cosZ = Math.max(0.01, direction.z);
    const chi = Math.acos(clamp(direction.x * sun.x + direction.y * sun.y + direction.z * sun.z, -1, 1));
    const zs = Math.acos(clamp(sun.z, -1, 1));
    const f = 0.91 + 10 * Math.exp(-3 * chi) + 0.45 * Math.cos(chi) * Math.cos(chi);
    const fs = 0.91 + 10 * Math.exp(-3 * zs) + 0.45 * Math.cos(zs) * Math.cos(zs);
    const phi = 1 - Math.exp(-0.32 / cosZ);
    const phi0 = 1 - Math.exp(-0.32);
    return f * phi / (fs * phi0);
  },

  /**
   * The clear sky's patch luminances (cd/m²) for a sun direction, scaled to the clear-sky diffuse horizontal
   * illuminance. Returns that illuminance (lux), 0 with the sun down.
   */
  clearPatches(sun: Vec3, luminance: Float32Array): number {
    const diffuse = Daylight.diffuseHorizontalClear(sun.z);
    if (diffuse <= 0) {
      luminance.fill(0);
      return 0;
    }
    for (let p = 0; p < PATCHES; p++) { luminance[p] = Daylight.clearLuminance(CENTRES[p], sun); }
    scale(luminance, diffuse / Daylight.horizontalIlluminance(luminance));
    return diffuse;
  },

  /** Clear-sky diffuse horizontal illuminance (lux, IES): 800 + 15 500 √(sin altitude); 0 with the sun down. */
  diffuseHorizontalClear(sinAltitude: number): number {
    return sinAltitude <= 0 ? 0 : 800 + 15500 * Math.sqrt(sinAltitude);
  },

  /** Clear-sky direct normal illuminance of the sun (lux, IES): 127 500 · e^(−0.21 / sin altitude); 0 below 1°. */
  directNormalClear(sinAltitude: number): number {
    return sinAltitude <= 0.0175 ? 0 : 127500 * Math.exp(-0.21 / sinAltitude);
  },

  /** count cosine-weighted directions over a hemisphere around +Z (Hammersley points). */
  cosineDirections(count: number): Vec3[] {
    const n = Math.max(1, count);
    const directions: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const u1 = (i + 0.5) / n;
      const u2 = radicalInverse(i);
      const r = Math.sqrt(u1), angle = 2 * Math.PI * u2;
      directions.push(vec3(Math.fround(r * Math.cos(angle)), Math.fround(r * Math.sin(angle)), Math.fround(Math.sqrt(Math.max(0, 1 - u1)))));
    }
    return directions;
  },

  /** BRE split-flux internally reflected component (% of the outdoor horizontal illuminance). */
  internalReflectedPercent(windowArea: number, totalArea: number, averageReflectance: number, lowerReflectance: number, upperReflectance: number,
    c = 39): number {
    if (windowArea <= 0 || totalArea <= 0) { return 0; }
    const r = clamp(averageReflectance, 0, 0.95);
    return Math.fround(0.85 * windowArea / (totalArea * (1 - r)) * (c * clamp(lowerReflectance, 0, 1) + 5 * clamp(upperReflectance, 0, 1)));
  },

  /** Illuminance (lux) from light entering a room and landing on the floor first: F · Rfw / (A (1 − R)). */
  floorBounceLux(flux: number, totalArea: number, averageReflectance: number, lowerReflectance: number): number {
    if (flux <= 0 || totalArea <= 0) { return 0; }
    return Math.fround(flux * clamp(lowerReflectance, 0, 1) / (totalArea * (1 - clamp(averageReflectance, 0, 0.95))));
  },

  /** A surface reflectance from its colour (bytes 0–255): relative luminance of the linear sRGB, within 0.05–0.9. */
  reflectanceOf(r: number, g: number, b: number): number {
    const linear = (v: number) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return Math.fround(clamp(0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b), 0.05, 0.9));
  },

  /** The legend colour of a daylight factor (0 → blue, 5 %+ → red). */
  factorColour(percent: number): [number, number, number] {
    return SunHours.legendColour(percent / Daylight.DF_LEGEND_MAX * SunHours.LEGEND_MAX);
  },

  /** The legend colour of an illuminance (0 → blue, 2000 lux+ → red). */
  luxColour(lux: number): [number, number, number] {
    return SunHours.legendColour(lux / Daylight.LUX_LEGEND_MAX * SunHours.LEGEND_MAX);
  }
};

function scale(values: Float32Array, factor: number): void {
  for (let i = 0; i < values.length; i++) { values[i] = values[i] * factor; }
}

function radicalInverse(i: number): number {
  let bits = i >>> 0;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits * 2.3283064365386963e-10;
}
