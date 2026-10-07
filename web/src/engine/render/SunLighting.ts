import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';

/** The sun and sky colours for one sun direction (port of BimGo.App/Rendering/SunLighting.cs). */
export interface SunLighting {
  enabled: boolean;
  sunDirection: Vec3;
  sunColour: Vec3;
  skyColour: Vec3;
  zenith: Vec3;
  horizon: Vec3;
  sunDisc: Vec3;
  shadowStrength: number;
  glass: number;
  altitudeDegrees: number;
}

export const NO_SUN: SunLighting = Object.freeze({
  enabled: false, sunDirection: vec3(0, 0, 1), sunColour: vec3(), skyColour: vec3(), zenith: vec3(), horizon: vec3(),
  sunDisc: vec3(), shadowStrength: 0, glass: 0, altitudeDegrees: 0
}) as SunLighting;

export function createSunLighting(sunDirection: Vec3, sunIntensity: number, skyIntensity: number, shadowStrength: number, glass: number): SunLighting {
  const altitude = Math.asin(Math.min(Math.max(sunDirection.z, -1), 1)) * 180 / Math.PI;

  // Day factor: direct sun fades in over the first few degrees above the horizon
  const day = smoothStep(-1, 4, altitude);
  const high = smoothStep(4, 30, altitude);   // 0 at sunrise colours, 1 at full daylight
  const twilight = smoothStep(-10, 2, altitude);

  // Direct light: warm and weak near the horizon, near-white high up
  const lowSun = vec3(1.00, 0.62, 0.36);
  const highSun = vec3(1.00, 0.97, 0.92);
  const sun = V.scale(V.lerp(lowSun, highSun, high), 0.62 * day * Math.max(sunIntensity, 0));

  // Sky: night → twilight → day gradients
  const zenith = V.lerp(V.lerp(vec3(0.025, 0.035, 0.07), vec3(0.16, 0.22, 0.38), twilight), vec3(0.34, 0.50, 0.70), high);
  const horizon = V.lerp(V.lerp(vec3(0.08, 0.10, 0.15), vec3(0.93, 0.66, 0.48), twilight), vec3(0.80, 0.85, 0.89), high);

  // Ambient follows the sky's brightness (never fully black, so night scenes stay navigable)
  const ambientLevel = 0.12 + 0.38 * smoothStep(-10, 20, altitude);
  const skyTint = V.lerp(vec3(0.70, 0.78, 1.00), vec3(0.94, 0.97, 1.00), high);

  return {
    enabled: true,
    sunDirection,
    sunColour: sun,
    skyColour: V.scale(skyTint, ambientLevel * Math.max(skyIntensity, 0)),
    zenith,
    horizon,
    sunDisc: V.scale(V.lerp(lowSun, highSun, high), 1.6 * day),
    shadowStrength: Math.min(Math.max(shadowStrength, 0), 1),
    glass: Math.min(Math.max(glass, 0), 2),
    altitudeDegrees: altitude
  };
}

export function smoothStep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) { return x >= edge1 ? 1 : 0; }
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
