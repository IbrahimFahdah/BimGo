import { f32, type Vec3, vec3 } from '../math/Vector';

/**
 * Typed reads from parsed JSON, matching the desktop's System.Text.Json options: camelCase names, missing members
 * keep their defaults, Vector3 as [x, y, z] (null = zero), and the named literals "NaN" / "Infinity" /
 * "-Infinity" accepted for numbers (AllowNamedFloatingPointLiterals).
 */

export type Json = Record<string, unknown>;

/** An object member, or an empty object. */
export function obj(v: unknown): Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

/** An object member, or null. */
export function objOrNull(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

/** An array member, or an empty array. */
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A number (including the named literals), or the fallback. */
export function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number') { return v; }
  if (typeof v === 'string') {
    switch (v) {
      case 'NaN': return NaN;
      case 'Infinity': return Infinity;
      case '-Infinity': return -Infinity;
    }
  }
  return fallback;
}

/** An integer (truncated), or the fallback. */
export function int(v: unknown, fallback = 0): number {
  const n = num(v, fallback);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** A float32 (the desktop's float members). */
export function float(v: unknown, fallback = 0): number {
  return f32(num(v, fallback));
}

/** A string, or the fallback. */
export function str(v: unknown, fallback: string): string;
export function str(v: unknown, fallback: null): string | null;
export function str(v: unknown, fallback: string | null): string | null {
  return typeof v === 'string' ? v : fallback;
}

/** A bool, or the fallback. */
export function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** A Vector3 from [x, y, z] (null or missing = zero; extra values ignored; floats rounded to float32). */
export function readVector3(v: unknown, fallback: Vec3 = vec3()): Vec3 {
  if (v === null) { return vec3(); }
  if (!Array.isArray(v)) { return fallback; }
  return vec3(f32(num(v[0])), f32(num(v[1])), f32(num(v[2])));
}

/** True when the string is null, empty or only white space (string.IsNullOrWhiteSpace). */
export function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim().length === 0;
}

/** A new random id as a 32-digit hex string (Guid.ToString("N")). */
export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
