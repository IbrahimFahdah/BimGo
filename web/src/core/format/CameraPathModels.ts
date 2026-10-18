import { clamp, f32, type Vec3, vec3 } from '../math/Vector';
import { SectionCut } from '../scene/SectionCut';
import { copyVisibility, currentUser, readSunTime, readVisibility, type SunTime, TourLimits, type VisibilitySettings } from './DocumentModels';
import { arr, bool, float, isBlank, type Json, newId, num, objOrNull, str } from './Json';

/** Which way a camera path's camera looks (Round K; stored as "follow" / "key" / "lookAt"). */
export type CameraHeading = 'follow' | 'key' | 'lookAt';

const HEADINGS: readonly CameraHeading[] = ['follow', 'key', 'lookAt'];

/** A heading from JSON (the desktop's string enum, case ignored; numbers as the enum order), or null. */
function readHeading(v: unknown): CameraHeading | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < HEADINGS.length) { return HEADINGS[v]; }
  if (typeof v !== 'string') { return null; }
  const s = v.trim().toLowerCase();
  return HEADINGS.find(h => h.toLowerCase() === s) ?? null;
}

/**
 * One key of a camera path (Round K, port of CameraKey): the eye position (Revit internal metres, like bookmarks), its
 * own view and how the path behaves there. Optional fields left null use the path's setting.
 */
export interface CameraKey {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  heading: CameraHeading | null;
  targetX: number | null;
  targetY: number | null;
  targetZ: number | null;
  smoothness: number | null;
  speed: number | null;
  holdSeconds: number;
  /** null = automatic (ends and holds), true = always, false = never. */
  ease: boolean | null;
  sun: SunTime | null;
  /** The colour profile from this key on (its id; "" = none), or null to leave it. */
  colourProfile: string | null;
  /** Round K-C: a pan over the hold (degrees, positive left), or null. */
  swivel: number | null;
  /** Round K-C: the section cut from this key on, or null. */
  section: SectionCut | null;
  /** Round K-C: what is hidden from this key on, or null. */
  visibility: VisibilitySettings | null;
  /** Runtime: scene-local eye. */
  local: Vec3;
  /** Runtime: scene-local target, or null. */
  targetLocal: Vec3 | null;
}

export const CAMERA_KEY_MAX_HOLD = 60;

export const keyHasTarget = (k: CameraKey) => k.targetX !== null && k.targetY !== null && k.targetZ !== null;

export function newCameraKey(): CameraKey {
  return {
    id: newId(), name: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, heading: null, targetX: null, targetY: null, targetZ: null, smoothness: null,
    speed: null, holdSeconds: 0, ease: null, sun: null, colourProfile: null, swivel: null, section: null, visibility: null, local: vec3(), targetLocal: null
  };
}

/** Round K-B: an exact deep copy (same id) for undo. */
export function snapshotKey(k: CameraKey): CameraKey {
  return {
    ...k, sun: k.sun ? { ...k.sun } : null, section: k.section?.clone() ?? null, visibility: k.visibility ? copyVisibility(k.visibility) : null,
    local: { ...k.local }, targetLocal: k.targetLocal ? { ...k.targetLocal } : null
  };
}

/** A deep copy with a new id (DUPLICATE). */
export function copyKey(k: CameraKey): CameraKey {
  return { ...snapshotKey(k), id: newId() };
}

/** CameraKey.Clean: drops non-finite and out-of-range values; false when the key is unusable. */
export function cleanKey(k: CameraKey): boolean {
  if (![k.x, k.y, k.z, k.yaw, k.pitch].every(Number.isFinite)) { return false; }
  if (isBlank(k.id)) { k.id = newId(); }
  k.name ??= '';
  k.pitch = f32(clamp(k.pitch, -1.5, 1.5));
  if (!keyHasTarget(k) || ![k.targetX, k.targetY, k.targetZ].every(v => Number.isFinite(v))) { k.targetX = k.targetY = k.targetZ = null; }
  if (k.smoothness !== null) { k.smoothness = Number.isFinite(k.smoothness) ? f32(clamp(k.smoothness, 0, 1)) : null; }
  if (k.speed !== null) { k.speed = Number.isFinite(k.speed) ? f32(clamp(k.speed, CameraPathLimits.MIN_SPEED, CameraPathLimits.MAX_SPEED)) : null; }
  k.holdSeconds = Number.isFinite(k.holdSeconds) ? f32(clamp(k.holdSeconds, 0, CAMERA_KEY_MAX_HOLD)) : 0;
  if (k.swivel !== null) { k.swivel = Number.isFinite(k.swivel) && k.swivel !== 0 ? f32(clamp(k.swivel, -TourLimits.MAX_SWIVEL, TourLimits.MAX_SWIVEL)) : null; }
  if (k.visibility) {
    k.visibility.groundOffset = null;
    k.visibility.section = null;
    k.visibility.appearance = null;
  }
  return true;
}

/** CameraPath limits. */
export const CameraPathLimits = {
  MIN_SPEED: 0.2, MAX_SPEED: 30, MAX_FADE: 2, MIN_LOOK_AHEAD: 0.5, MAX_LOOK_AHEAD: 20, MAX_KEYS: 200
} as const;

/**
 * A keyframed camera path (Round K, port of CameraPath): keys in order, played at constant speed along a smooth curve
 * through them, with holds, easing, a heading and the sun / colour profile changing along it.
 */
export interface CameraPath {
  id: string;
  name: string;
  author: string;
  created: string;
  keys: CameraKey[];
  speed: number;
  smoothness: number;
  heading: CameraHeading;
  lookAhead: number;
  level: boolean;
  fadeSeconds: number;
  showUi: boolean;
  loop: boolean;
  /** Round K-C: between two keys with their own views, follow the path in the middle. */
  followBetween: boolean;
}

export function newCameraPath(name = 'Path'): CameraPath {
  return {
    id: newId(), name, author: currentUser, created: new Date().toISOString(), keys: [], speed: 1.5, smoothness: f32(0.8), heading: 'follow',
    lookAhead: 3, level: true, fadeSeconds: 0.5, showUi: false, loop: false, followBetween: false
  };
}

/** CameraPath.Clean: clamps every value and drops unusable keys. Returns the same object. */
export function cleanPath(p: CameraPath): CameraPath {
  const L = CameraPathLimits;
  if (isBlank(p.id)) { p.id = newId(); }
  if (isBlank(p.name)) { p.name = 'Path'; }
  p.author ??= '';
  p.keys = (p.keys ?? []).filter(k => k && cleanKey(k)).slice(0, L.MAX_KEYS);
  p.speed = Number.isFinite(p.speed) ? f32(clamp(p.speed, L.MIN_SPEED, L.MAX_SPEED)) : 1.5;
  p.smoothness = Number.isFinite(p.smoothness) ? f32(clamp(p.smoothness, 0, 1)) : f32(0.8);
  if (!HEADINGS.includes(p.heading)) { p.heading = 'follow'; }
  p.lookAhead = Number.isFinite(p.lookAhead) ? f32(clamp(p.lookAhead, L.MIN_LOOK_AHEAD, L.MAX_LOOK_AHEAD)) : 3;
  p.fadeSeconds = Number.isFinite(p.fadeSeconds) ? f32(clamp(p.fadeSeconds, 0, L.MAX_FADE)) : 0.5;
  return p;
}

export const pathSmoothnessFor = (p: CameraPath, k: CameraKey | null) => k?.smoothness ?? p.smoothness;
export const pathSpeedFor = (p: CameraPath, k: CameraKey | null) => k?.speed ?? p.speed;
export const pathHeadingFor = (p: CameraPath, k: CameraKey | null): CameraHeading => k?.heading ?? p.heading;

/** Whether the camera slows into and out of a key: its own setting, else at the path's ends (not looping) and where it holds. */
export function pathEasesAt(p: CameraPath, index: number): boolean {
  if (index < 0 || index >= p.keys.length) { return false; }
  const key = p.keys[index];
  if (key.holdSeconds > 0) { return true; }
  if (key.ease !== null) { return key.ease; }
  return !p.loop && (index === 0 || index === p.keys.length - 1);
}

/** Round K-B: an exact deep copy (same ids) for undo. */
export function snapshotPath(p: CameraPath): CameraPath {
  return { ...p, keys: p.keys.map(snapshotKey) };
}

/** Round K-B: takes every setting and key from a snapshot, keeping this object. */
export function pathCopyFrom(p: CameraPath, snapshot: CameraPath): void {
  if (!snapshot || snapshot === p) { return; }
  Object.assign(p, { ...snapshot, keys: snapshot.keys.map(snapshotKey) });
}

/** A deep copy with new ids (DUPLICATE). */
export function copyPath(p: CameraPath): CameraPath {
  return { ...p, id: newId(), created: new Date().toISOString(), author: currentUser, keys: p.keys.map(copyKey) };
}

/** The camera paths of a model (paths.json; optional). */
export interface CameraPathDocument {
  version: number;
  model: string;
  units: string;
  paths: CameraPath[];
}

export function emptyPaths(): CameraPathDocument {
  return { version: 1, model: '', units: 'metres, Revit internal coordinates; angles in radians; speeds in m/s', paths: [] };
}

export const isPathsEmpty = (d: CameraPathDocument | null) => !d || d.paths.length === 0;

const nullableNum = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const nullableFloat = (v: unknown): number | null => (typeof v === 'number' ? f32(v) : null);

function readKey(j: Json): CameraKey {
  const sun = objOrNull(j.sun), vis = objOrNull(j.visibility);
  return {
    id: str(j.id, ''), name: str(j.name, ''), x: num(j.x, NaN), y: num(j.y, NaN), z: num(j.z, NaN), yaw: float(j.yaw, NaN), pitch: float(j.pitch, NaN),
    heading: readHeading(j.heading), targetX: nullableNum(j.targetX), targetY: nullableNum(j.targetY), targetZ: nullableNum(j.targetZ),
    smoothness: nullableFloat(j.smoothness), speed: nullableFloat(j.speed), holdSeconds: float(j.holdSeconds), ease: typeof j.ease === 'boolean' ? j.ease : null,
    sun: sun ? readSunTime(sun) : null, colourProfile: str(j.colourProfile, null), swivel: nullableFloat(j.swivel), section: SectionCut.read(j.section),
    visibility: vis ? readVisibility(vis) : null, local: vec3(), targetLocal: null
  };
}

function readPath(j: Json): CameraPath {
  const d = newCameraPath();
  return {
    id: str(j.id, ''), name: str(j.name, d.name), author: str(j.author, ''), created: str(j.created, d.created),
    keys: arr(j.keys).map(k => objOrNull(k)).filter((k): k is Json => k !== null).map(readKey),
    speed: float(j.speed, d.speed), smoothness: float(j.smoothness, d.smoothness), heading: readHeading(j.heading) ?? 'follow',
    lookAhead: float(j.lookAhead, d.lookAhead), level: bool(j.level, true), fadeSeconds: float(j.fadeSeconds, d.fadeSeconds), showUi: bool(j.showUi),
    loop: bool(j.loop), followBetween: bool(j.followBetween)
  };
}

/** Reads paths.json, cleaned (null when missing). */
export function readPathsDocument(j: Json | null): CameraPathDocument | null {
  if (!j) { return null; }
  const doc = emptyPaths();
  doc.version = Math.trunc(num(j.version, 1));
  doc.model = str(j.model, '');
  doc.units = str(j.units, doc.units);
  doc.paths = arr(j.paths).map(p => objOrNull(p)).filter((p): p is Json => p !== null).map(readPath).map(cleanPath);
  return doc;
}
