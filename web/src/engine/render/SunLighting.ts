import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';

/** The sun and sky colours for one sun direction (port of BimGo.App/Rendering/SunLighting.cs). */
export interface SunLighting {
  enabled: boolean;
  /** Towards the light that shades the scene and casts the shadows: the sun, or (Round W-A) the moon at night. */
  sunDirection: Vec3;
  /** Round W-A: the real sun's direction (the sky's sun disc, glare and the moon's lit side). */
  skySunDirection: Vec3;
  /** Round W-A: towards the moon. */
  moonDirection: Vec3;
  /** Round W-A: towards the light on the moon's face (the sun, or a chosen phase's direction). */
  moonSunDirection: Vec3;
  /** Round W-A: the moon disc's colour (zero when the moon is off). */
  moonDisc: Vec3;
  /** Round W-A: moonlight on the clouds. */
  moonGlow: Vec3;
  /** Round W-A: true while the moon is the scene's light (shadows from it). */
  moonLights: boolean;
  /** Round W-A: how dark the sky is for the stars (0 day – 1 night). */
  night: number;
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
  enabled: false, sunDirection: vec3(0, 0, 1), skySunDirection: vec3(0, 0, 1), moonDirection: vec3(0, 0, 1), moonSunDirection: vec3(0, 0, 1),
  moonDisc: vec3(), moonGlow: vec3(), moonLights: false, night: 0, sunColour: vec3(), skyColour: vec3(), zenith: vec3(), horizon: vec3(),
  sunDisc: vec3(), shadowStrength: 0, glass: 0, altitudeDegrees: 0
}) as SunLighting;

/** W-A: a full moon's direct light against the sun's. */
const MOONLIGHT = 0.10;

/**
 * The frame's lighting (Round W-A: with the moon: once the sun is below −1° the moon, when on and up, is the light,
 * cool and dim by its phase; a moonlit night also lifts the ambient and the sky a little).
 */
export function createSunLighting(sunDirection: Vec3, sunIntensity: number, skyIntensity: number, shadowStrength: number, glass: number,
  moonDirection: Vec3 = vec3(0, 0, 1), moonLit = 0, moonOn = false, moonLight = 0): SunLighting {
  const altitude = Math.asin(Math.min(Math.max(sunDirection.z, -1), 1)) * 180 / Math.PI;

  // Day factor: direct sun fades in over the first few degrees above the horizon
  const day = smoothStep(-1, 4, altitude);
  const high = smoothStep(4, 30, altitude);   // 0 at sunrise colours, 1 at full daylight
  const twilight = smoothStep(-10, 2, altitude);

  // Direct light: warm and weak near the horizon, near-white high up
  const lowSun = vec3(1.00, 0.62, 0.36);
  const highSun = vec3(1.00, 0.97, 0.92);
  let sun = V.scale(V.lerp(lowSun, highSun, high), 0.62 * day * Math.max(sunIntensity, 0));

  // Sky: night → twilight → day gradients
  let zenith = V.lerp(V.lerp(vec3(0.025, 0.035, 0.07), vec3(0.16, 0.22, 0.38), twilight), vec3(0.34, 0.50, 0.70), high);
  let horizon = V.lerp(V.lerp(vec3(0.08, 0.10, 0.15), vec3(0.93, 0.66, 0.48), twilight), vec3(0.80, 0.85, 0.89), high);

  // Ambient follows the sky's brightness (never fully black, so night scenes stay navigable)
  const ambientLevel = 0.12 + 0.38 * smoothStep(-10, 20, altitude);
  const skyTint = V.lerp(vec3(0.70, 0.78, 1.00), vec3(0.94, 0.97, 1.00), high);
  let sky = V.scale(skyTint, ambientLevel * Math.max(skyIntensity, 0));

  // W-A: the moon (its light by phase: a thin crescent still gives a little)
  const night = 1 - smoothStep(-14, -2, altitude);
  const moonAltitude = Math.asin(Math.min(Math.max(moonDirection.z, -1), 1)) * 180 / Math.PI;
  const moonUp = moonOn ? smoothStep(-1, 4, moonAltitude) : 0;
  const phase = 0.12 + 0.88 * Math.min(Math.max(moonLit, 0), 1);
  const moonNight = 1 - smoothStep(-6, -1, altitude);
  const moonStrength = moonUp * moonNight * phase * Math.max(moonLight, 0);
  const moonTint = vec3(0.62, 0.72, 0.95);
  let lightDirection = sunDirection;
  const moonLights = altitude < -1 && moonStrength > 0.001;
  if (moonLights) {
    lightDirection = moonDirection;
    sun = V.scale(moonTint, MOONLIGHT * moonStrength * Math.max(sunIntensity, 0));
  }
  sky = V.add(sky, V.scale(moonTint, 0.06 * moonStrength * Math.max(skyIntensity, 0)));
  zenith = V.add(zenith, V.scale(vec3(0.020, 0.030, 0.060), moonStrength * night * 0.6));
  horizon = V.add(horizon, V.scale(vec3(0.020, 0.028, 0.045), moonStrength * night * 0.6));

  return {
    enabled: true,
    sunDirection: lightDirection,
    skySunDirection: sunDirection,
    moonDirection,
    moonSunDirection: sunDirection,
    moonDisc: moonOn ? V.scale(vec3(0.96, 0.94, 0.88), 0.30 + 0.55 * night) : vec3(),
    moonGlow: V.scale(moonTint, 0.35 * moonStrength),
    moonLights,
    night,
    sunColour: sun,
    skyColour: sky,
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

/**
 * Sky round: how the sky looks this frame (port of SkyLook): clouds, the sun disc's size and glare, and (W-A) the stars.
 * A look only: the scene's lighting doesn't change with it.
 */
export interface SkyLook {
  cloudCover: number;
  cloudOffsetX: number;
  cloudOffsetY: number;
  sunSize: number;
  sunGlare: number;
  /** Round W-A: density, brightness, twinkle, Milky Way (density 0 = none). */
  stars: [number, number, number, number];
  /** Round W-A: the clock for the twinkle (seconds, wrapped). */
  time: number;
  /** Round W-A: the equatorial axes in scene axes. */
  celestialX: Vec3;
  celestialY: Vec3;
  celestialZ: Vec3;
}

export const SkyLooks = {
  /** The disc's outer and inner edge at size 1 (radians). */
  DISC_OUTER: 0.0300,
  DISC_INNER: 0.0224,
  defaults: (): SkyLook => ({
    cloudCover: 0, cloudOffsetX: 0, cloudOffsetY: 0, sunSize: 1, sunGlare: 1, stars: [0, 0, 0, 0], time: 0,
    celestialX: vec3(1, 0, 0), celestialY: vec3(0, 1, 0), celestialZ: vec3(0, 0, 1)
  })
};
