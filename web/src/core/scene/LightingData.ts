import { clamp, type Vec3, vec3 } from '../math/Vector';

/** A run of vertices with one packed emissive colour (RGB normalised to the peak, A = strength / MAX_STRENGTH). */
export interface EmissiveRun {
  start: number;
  count: number;
  emissive: number;
}

/** A light fixture's light. */
export interface LightSource {
  element: number;
  position: Vec3;
  lumens: number;
  kelvin: number;
  downward: number;
  estimated: boolean;
}

/** Glowing surfaces and light sources (port of LightingData). */
export interface LightingData {
  emissive: EmissiveRun[];
  lights: LightSource[];
}

export const EMPTY_LIGHTING: LightingData = Object.freeze({ emissive: [], lights: [] }) as LightingData;

/** The strength that maps to alpha 255. */
export const MAX_EMISSIVE_STRENGTH = 4;

export function isLightingEmpty(l: LightingData): boolean {
  return l.emissive.length === 0 && l.lights.length === 0;
}

/** Strength from a luminance in cd/m² (log scale, 0.5–4). */
export function strengthFromLuminance(luminance: number): number {
  return clamp(Math.log10(Math.max(luminance, 1)) - 1, 0.5, MAX_EMISSIVE_STRENGTH);
}

/** A colour temperature as RGB normalised to its peak (Tanner Helland's fit of the blackbody locus). */
export function kelvinToRgb(kelvin: number): Vec3 {
  const t = clamp(kelvin, 1000, 15000) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const rgb = vec3(clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255);
  const peak = Math.max(rgb.x, rgb.y, rgb.z);
  return peak > 0 ? vec3(rgb.x / peak, rgb.y / peak, rgb.z / peak) : vec3(1, 1, 1);
}
