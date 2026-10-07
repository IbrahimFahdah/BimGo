/**
 * The small slice of System.Numerics the port needs. Plain objects with x / y / z, so DTOs read from JSON and runtime
 * values share one shape. Functions return new objects; hot loops (physics, BVH) work on Float32Arrays instead.
 */

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const Vec3 = {
  zero: (): Vec3 => vec3(0, 0, 0),
  one: (): Vec3 => vec3(1, 1, 1),
  unitX: (): Vec3 => vec3(1, 0, 0),
  unitY: (): Vec3 => vec3(0, 1, 0),
  unitZ: (): Vec3 => vec3(0, 0, 1),
  add: (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z),
  sub: (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z),
  scale: (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s),
  mul: (a: Vec3, b: Vec3): Vec3 => vec3(a.x * b.x, a.y * b.y, a.z * b.z),
  dot: (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a: Vec3, b: Vec3): Vec3 => vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x),
  length: (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z),
  lengthSquared: (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z,
  distance: (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
  normalize(a: Vec3): Vec3 {
    const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    return l > 0 ? vec3(a.x / l, a.y / l, a.z / l) : vec3(0, 0, 0);
  },
  min: (a: Vec3, b: Vec3): Vec3 => vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
  max: (a: Vec3, b: Vec3): Vec3 => vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)),
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t),
  clamp: (v: Vec3, lo: Vec3, hi: Vec3): Vec3 =>
    vec3(Math.min(Math.max(v.x, lo.x), hi.x), Math.min(Math.max(v.y, lo.y), hi.y), Math.min(Math.max(v.z, lo.z), hi.z)),
  isFinite: (v: Vec3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z),
  copy: (v: Vec3): Vec3 => vec3(v.x, v.y, v.z)
};

/** Rounds to float32, as the desktop stores most values. */
export const f32 = Math.fround;

/** Clamps a number. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
