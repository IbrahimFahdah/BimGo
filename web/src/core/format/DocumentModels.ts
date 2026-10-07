import { clamp, type Vec3, vec3 } from '../math/Vector';
import type { SiteInfo } from '../scene/ModelInfo';
import { arr, bool, float, int, isBlank, type Json, newId, num, objOrNull, str } from './Json';

// Ports of CommentModels.cs, BookmarkModels.cs, SunModels.cs and VisibilityModels.cs: the optional document
// entries of a .bimgo. Readers fill every missing member with the desktop default and apply the same Clean() rules.

/** The current user's name for new records (the desktop uses Environment.UserName). */
export let currentUser = 'web';
export function setCurrentUser(name: string): void { currentUser = name || 'web'; }

// #region Comments

export interface CommentRecord {
  id: string;
  author: string;
  created: string;
  text: string;
  /** Revit internal coordinates (metres). */
  x: number;
  y: number;
  z: number;
  elementId: number;
  level: string;
  edited: string | null;
  editedBy: string | null;
  /** Runtime only: scene-local position. */
  local: Vec3;
  /** Runtime only: the list header. */
  header: string;
}

export interface CommentDocument {
  version: number;
  model: string;
  units: string;
  comments: CommentRecord[];
}

export function readComment(j: Json): CommentRecord {
  return {
    id: str(j.id, newId()),
    author: str(j.author, currentUser),
    created: str(j.created, new Date().toISOString()),
    text: str(j.text, ''),
    x: num(j.x), y: num(j.y), z: num(j.z),
    elementId: num(j.elementId, -1),
    level: str(j.level, ''),
    edited: str(j.edited, null),
    editedBy: str(j.editedBy, null),
    local: vec3(),
    header: ''
  };
}

export function emptyComments(): CommentDocument {
  return { version: 1, model: '', units: 'metres, Revit internal coordinates', comments: [] };
}

/** Reads comments.json, dropping empty comments (as BimGoReader does). */
export function readCommentDocument(j: Json | null): CommentDocument {
  const doc = emptyComments();
  if (!j) { return doc; }
  doc.version = int(j.version, 1);
  doc.model = str(j.model, '');
  doc.units = str(j.units, doc.units);
  doc.comments = arr(j.comments).map(c => objOrNull(c)).filter((c): c is Json => c !== null).map(readComment)
    .filter(c => !isBlank(c.text));
  return doc;
}

// #endregion

// #region Sun

export interface SunTime {
  month: number;
  day: number;
  /** Minutes after midnight, local clock time. */
  minutes: number;
  daylightSaving: boolean;
}

export interface SunSettings {
  version: number;
  enabled: boolean;
  time: SunTime;
  sunIntensity: number;
  skyIntensity: number;
  shadowIntensity: number;
  glassTransmission: number;
}

export const SUN_MIN_INTENSITY = 0;
export const SUN_MAX_INTENSITY = 2;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function readSunTime(j: Json | null): SunTime {
  const t = j ?? {};
  return { month: int(t.month, 6), day: int(t.day, 21), minutes: int(t.minutes, 12 * 60), daylightSaving: bool(t.daylightSaving) };
}

/** SunTime.Clamped. */
export function clampSunTime(t: SunTime, year: number): SunTime {
  const month = clamp(t.month, 1, 12);
  return {
    month,
    day: clamp(t.day, 1, daysInMonth(clamp(year, 1, 9999), month)),
    minutes: clamp(t.minutes, 0, 24 * 60 - 1),
    daylightSaving: t.daylightSaving
  };
}

/** SunTime.StartFor: the site's sun start ("yyyy-MM-ddTHH:mm"), else today at noon. */
export function sunStartFor(site: SiteInfo | null): SunTime {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(site?.sunStart?.trim() ?? '');
  if (m) {
    const month = Number(m[2]), day = Number(m[3]), hour = Number(m[4]), minute = Number(m[5]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(Number(m[1]), month) && hour < 24 && minute < 60) {
      return { month, day, minutes: hour * 60 + minute, daylightSaving: false };
    }
  }
  const today = new Date();
  return { month: today.getMonth() + 1, day: today.getDate(), minutes: 12 * 60, daylightSaving: false };
}

/** Reads sun.json with SunSettings.Clean applied. */
export function readSunSettings(j: Json): SunSettings {
  const clampOr = (v: unknown, min: number, max: number, fallback: number) => {
    const n = float(v, fallback);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  };
  return {
    version: int(j.version, 1),
    enabled: bool(j.enabled),
    time: clampSunTime(readSunTime(objOrNull(j.time)), new Date().getFullYear()),
    sunIntensity: clampOr(j.sunIntensity, SUN_MIN_INTENSITY, SUN_MAX_INTENSITY, 1),
    skyIntensity: clampOr(j.skyIntensity, SUN_MIN_INTENSITY, SUN_MAX_INTENSITY, 1),
    shadowIntensity: clampOr(j.shadowIntensity, 0, 1, 1),
    glassTransmission: clampOr(j.glassTransmission, 0, 2, 1)
  };
}

export function sunDefaultsFor(site: SiteInfo | null): SunSettings {
  return { version: 1, enabled: false, time: sunStartFor(site), sunIntensity: 1, skyIntensity: 1, shadowIntensity: 1, glassTransmission: 1 };
}

// #endregion

// #region Bookmarks

export interface BookmarkRecord {
  id: string;
  name: string;
  author: string;
  created: string;
  /** Revit internal coordinates (metres). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flying: boolean;
  level: string;
  sun: SunTime | null;
  /** PNG as base64, or null. */
  thumbnail: string | null;
  /** Runtime only. */
  local: Vec3;
  detail: string;
}

export interface BookmarkDocument {
  version: number;
  model: string;
  units: string;
  bookmarks: BookmarkRecord[];
  home: BookmarkRecord | null;
}

export function readBookmark(j: Json): BookmarkRecord {
  const sun = objOrNull(j.sun);
  return {
    id: str(j.id, newId()),
    name: str(j.name, ''),
    author: str(j.author, currentUser),
    created: str(j.created, new Date().toISOString()),
    x: num(j.x), y: num(j.y), z: num(j.z),
    yaw: float(j.yaw), pitch: float(j.pitch),
    flying: bool(j.flying),
    level: str(j.level, ''),
    sun: sun ? readSunTime(sun) : null,
    thumbnail: str(j.thumbnail, null),
    local: vec3(),
    detail: ''
  };
}

export function emptyBookmarks(): BookmarkDocument {
  return { version: 1, model: '', units: 'metres, Revit internal coordinates; angles in radians', bookmarks: [], home: null };
}

const finiteBookmark = (b: BookmarkRecord) =>
  Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z) && Number.isFinite(b.yaw) && Number.isFinite(b.pitch);

/** Reads bookmarks.json with BookmarkDocument.Clean applied. */
export function readBookmarkDocument(j: Json | null): BookmarkDocument {
  const doc = emptyBookmarks();
  if (!j) { return doc; }
  doc.version = int(j.version, 1);
  doc.model = str(j.model, '');
  doc.units = str(j.units, doc.units);
  doc.bookmarks = arr(j.bookmarks).map(b => objOrNull(b)).filter((b): b is Json => b !== null).map(readBookmark).filter(finiteBookmark);
  const home = objOrNull(j.home);
  doc.home = home ? readBookmark(home) : null;
  if (doc.home && !finiteBookmark(doc.home)) { doc.home = null; }
  for (const b of doc.bookmarks) {
    if (isBlank(b.name)) { b.name = 'Viewpoint'; }
    if (isBlank(b.id)) { b.id = newId(); }
  }
  return doc;
}

// #endregion

// #region Visibility

export interface HiddenElement {
  link: string | null;
  uniqueId: string | null;
  id: number;
}

export interface VisibilitySettings {
  hiddenCategories: string[];
  hiddenLinks: string[];
  hiddenElements: HiddenElement[];
}

/** Reads visibility.json with VisibilitySettings.Clean applied. */
export function readVisibility(j: Json): VisibilitySettings {
  const keys = (v: unknown) => [...new Set(arr(v).filter((k): k is string => typeof k === 'string' && !isBlank(k)))];
  return {
    hiddenCategories: keys(j.hiddenCategories),
    hiddenLinks: keys(j.hiddenLinks),
    hiddenElements: arr(j.hiddenElements)
      .map(e => objOrNull(e))
      .filter((e): e is Json => e !== null)
      .map(e => ({ link: str(e.link, null), uniqueId: str(e.uniqueId, null), id: num(e.id) }))
      .filter(e => (e.uniqueId !== null && e.uniqueId.length > 0) || e.id > 0)
  };
}

export function isVisibilityEmpty(v: VisibilitySettings): boolean {
  return v.hiddenCategories.length === 0 && v.hiddenLinks.length === 0 && v.hiddenElements.length === 0;
}

// #endregion

