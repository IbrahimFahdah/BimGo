import { clamp, f32, type Vec3, vec3 } from '../math/Vector';
import type { SiteInfo } from '../scene/ModelInfo';
import { SectionCut } from '../scene/SectionCut';
import { Appearance, type AppearanceSettings } from '../scene/AppearanceProfiles';
import { GridView, type GridViewSettings } from '../scene/GridData';
import type { TourTransition } from '../scene/TourTimeline';
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
  /** Issue status: one of CommentStatus (absent in older files = open). */
  status: string;
  /** Who it is assigned to (free text), or null. */
  assignedTo: string | null;
  /** One of CommentPriority (absent = normal). */
  priority: string;
  /** When the status, assignee or priority last changed (null = never), and by whom. */
  updated: string | null;
  updatedBy: string | null;
  /** Follow-up replies, oldest first (null = none). */
  replies: CommentReply[] | null;
  /** The viewpoint the comment was made from (GO returns there), or null (older comments). */
  view: CommentView | null;
  /** A small picture of that view (base64 JPEG, 192 × 108), or null. */
  thumbnail: string | null;
  /**
   * The commented element's Revit UniqueId (BCF round: lets BCF exports name the right element even when an
   * ElementId repeats in a linked model), or null.
   */
  elementUniqueId: string | null;
  /** The larger picture used for BCF snapshots: its name, "comments/<id>.jpg" (inside the .bimgo), or null. */
  snapshot: string | null;
  /** Runtime only: the snapshot's JPEG bytes (loaded with the comments, or just taken), or null. */
  snapshotData: Uint8Array | null;
  /**
   * The picture before markup (review tools round): "comments/<id>_original.jpg", kept beside the marked-up snapshot
   * so MARKUP… starts from the clean view. Null when the picture has no markup. The markup itself is burned into the
   * snapshot and the thumbnail (so BCF carries it).
   */
  snapshotOriginal: string | null;
  /** Runtime only: the unmarked picture's JPEG bytes, or null. */
  snapshotOriginalData: Uint8Array | null;
  /**
   * The clash this comment was made from (Round C-B2: TO COMMENT), or null. BCF exports such a comment as a "Clash"
   * topic with both elements as components.
   */
  clashId: string | null;
  /** Runtime only: scene-local position. */
  local: Vec3;
  /** Runtime only: the list header. */
  header: string;
}

/** One reply in a comment's thread. */
export interface CommentReply {
  id: string;
  author: string;
  created: string;
  text: string;
}

/** Where a comment was made from: the player's feet (Revit internal metres), the view direction and fly state. */
export interface CommentView {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flying: boolean;
  /** Polish round P-C: the standing eye height when the view was saved (m); null (older comments) uses the current preset. */
  eyeHeight: number | null;
  /**
   * The section cut when the view was saved: GO restores it, BCF exports it as clipping planes; a cut with nothing
   * on clears the cut; null (older comments) leaves the current cut alone.
   */
  section: SectionCut | null;
}

/** Comment issue statuses (stored as these strings; port of CommentStatus). */
export const CommentStatus = {
  OPEN: 'open',
  IN_PROGRESS: 'inProgress',
  CLOSED: 'closed',
  ALL: ['open', 'inProgress', 'closed'] as readonly string[],
  /** A known status (case-insensitive), else open. */
  normalise(status: unknown): string {
    const s = typeof status === 'string' ? status.trim().toLowerCase() : '';
    return CommentStatus.ALL.find(v => v.toLowerCase() === s) ?? CommentStatus.OPEN;
  },
  label(status: string): string {
    switch (CommentStatus.normalise(status)) {
      case CommentStatus.IN_PROGRESS: return 'In progress';
      case CommentStatus.CLOSED: return 'Closed';
      default: return 'Open';
    }
  }
};

/** Comment priorities (stored as these strings; port of CommentPriority). */
export const CommentPriority = {
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  ALL: ['low', 'normal', 'high'] as readonly string[],
  /** A known priority (case-insensitive), else normal. */
  normalise(priority: unknown): string {
    const p = typeof priority === 'string' ? priority.trim().toLowerCase() : '';
    return CommentPriority.ALL.find(v => v === p) ?? CommentPriority.NORMAL;
  },
  label(priority: string): string {
    switch (CommentPriority.normalise(priority)) {
      case CommentPriority.LOW: return 'Low';
      case CommentPriority.HIGH: return 'High';
      default: return 'Normal';
    }
  }
};

/**
 * Normalises a comment's issue fields (port of CommentRecord.Clean): unknown status or priority → open / normal,
 * blank assignee → null, blank replies dropped (none left → null), a non-finite view dropped.
 */
export function cleanComment(c: CommentRecord): CommentRecord {
  c.status = CommentStatus.normalise(c.status);
  c.priority = CommentPriority.normalise(c.priority);
  c.assignedTo = isBlank(c.assignedTo) ? null : c.assignedTo!.trim();
  c.replies = c.replies?.filter(r => r && !isBlank(r.text)) ?? null;
  if (c.replies && c.replies.length === 0) { c.replies = null; }
  const v = c.view;
  if (v && ![v.x, v.y, v.z, v.yaw, v.pitch].every(Number.isFinite)) { c.view = null; }
  c.view?.section?.clean();
  if (isBlank(c.thumbnail)) { c.thumbnail = null; }
  if (isBlank(c.elementUniqueId)) { c.elementUniqueId = null; }
  if (isBlank(c.clashId)) { c.clashId = null; }
  if (!CommentSnapshots.isValidName(c.snapshot)) { c.snapshot = null; }
  if (!CommentSnapshots.isValidName(c.snapshotOriginal) || c.snapshot === null) { c.snapshotOriginal = null; }
  return c;
}

/** True when a comment's picture carries markup (an unmarked original is kept). */
export function hasMarkup(c: CommentRecord): boolean {
  return c.snapshotOriginal !== null;
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
    status: str(j.status, CommentStatus.OPEN),
    assignedTo: str(j.assignedTo, null),
    priority: str(j.priority, CommentPriority.NORMAL),
    updated: str(j.updated, null),
    updatedBy: str(j.updatedBy, null),
    replies: Array.isArray(j.replies)
      ? arr(j.replies).map(r => objOrNull(r)).filter((r): r is Json => r !== null).map(r => ({
        id: str(r.id, newId()), author: str(r.author, currentUser), created: str(r.created, new Date().toISOString()), text: str(r.text, '')
      }))
      : null,
    view: readCommentView(objOrNull(j.view)),
    thumbnail: str(j.thumbnail, null),
    elementUniqueId: str(j.elementUniqueId, null),
    snapshot: str(j.snapshot, null),
    snapshotData: null,
    snapshotOriginal: str(j.snapshotOriginal, null),
    snapshotOriginalData: null,
    clashId: str(j.clashId, null),
    local: vec3(),
    header: ''
  };
}

function readCommentView(j: Json | null): CommentView | null {
  return j
    ? {
      x: num(j.x), y: num(j.y), z: num(j.z), yaw: float(j.yaw), pitch: float(j.pitch), flying: bool(j.flying), eyeHeight: nullableFloat(j.eyeHeight),
      section: SectionCut.read(j.section)
    }
    : null;
}

/**
 * The larger comment pictures used for BCF snapshots (port of CommentSnapshots): JPEGs named
 * "comments/<comment id>.jpg", stored as entries inside a .bimgo.
 */
export const CommentSnapshots = {
  FOLDER: 'comments/',

  /** The picture name for a comment id (characters other than letters, digits and '-' replaced). */
  nameFor(commentId: string): string {
    let file = (commentId ?? '').replace(/[^A-Za-z0-9-]/g, '_');
    if (!file) { file = newId(); }
    return `comments/${file}.jpg`;
  },

  /** The name of a comment's unmarked picture (review tools round): "comments/<id>_original.jpg". */
  originalNameFor(commentId: string): string {
    return CommentSnapshots.nameFor(commentId).slice(0, -4) + '_original.jpg';
  },

  /** True for "comments/<safe name>.jpg" (no sub-folders, no ".."). */
  isValidName(name: string | null | undefined): boolean {
    if (!name || !name.startsWith('comments/') || !name.toLowerCase().endsWith('.jpg')) { return false; }
    const file = name.slice('comments/'.length, -4);
    return file.length > 0 && file.length <= 80 && /^[A-Za-z0-9_-]+$/.test(file);
  }
};

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
    .filter(c => !isBlank(c.text)).map(cleanComment);
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

/** Round W-B: the weather kinds in sun.json. */
export type WeatherKind = 'off' | 'rain' | 'snow';

/** Round W-B: reads a weather string (anything unknown is off). */
export function readWeather(v: unknown): WeatherKind {
  const w = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return w === 'rain' || w === 'snow' ? w : 'off';
}

export interface SunSettings {
  version: number;
  enabled: boolean;
  time: SunTime;
  sunIntensity: number;
  skyIntensity: number;
  shadowIntensity: number;
  glassTransmission: number;
  /** Sky round: cloud cover, 0 = clear (default) – 1 = overcast. A look only. */
  cloudCover: number;
  /** Sky round: cloud drift speed (0 = still, 1 = default, 2 = double). */
  cloudSpeed: number;
  /** Sky round: sun disc size multiplier (0.25–2). A look only. */
  sunSize: number;
  /** Sky round: sun glare multiplier (0–2). A look only. */
  sunGlare: number;
  /** Round W-A: the moon in the night sky (when the sun is down it lights the scene and casts the shadows). */
  moon: boolean;
  /** Round W-A: a chosen phase (lit fraction 0.05–1) instead of the real one, or null for the real phase. */
  moonPhase: number | null;
  /** Round W-A: moonlight multiplier (0–2). */
  moonLight: number;
  /** Round W-A: stars at night. */
  stars: boolean;
  starDensity: number;
  starBrightness: number;
  starTwinkle: number;
  /** Round W-A: the Milky Way band's strength (0–2). */
  milkyWay: number;
  /**
   * Round W-B: the weather: "off" (the default), "rain" or "snow" (a string, so a later kind never fails an older
   * reader; anything unknown reads as off). Shows in the classic light and with shadows on.
   */
  weather: WeatherKind;
  /** Round W-B: how hard it rains or snows (0.05–1; 0.5 = steady). */
  weatherIntensity: number;
  /** Round W-B: how wet open surfaces look while it rains (0 = dry, 1 = soaked with puddles). */
  wetness: number;
  /** Round W-B: how much snow has settled on open, up-facing surfaces while it snows (0 = none, 1 = deep). */
  snowCover: number;
  /** Round W-C: lightning while it rains (off by default). */
  lightning: boolean;
  /** Round W-C: how often it strikes: 0 rare, 1 sometimes (the default), 2 often. */
  lightningFrequency: number;
  /** Round W-C: how much a strike brightens the scene (0 = sky only, 1 = strongest; 0.35 = the default). */
  lightningFlash: number;
  /** Round W-C: photosensitive comfort: each strike is one slow glow instead of flickers. */
  reduceFlashing: boolean;
  /** Round W-C: drops (rain) and melting flakes (snow) on the lens now and then, outdoors (never in photos or videos). */
  lensDrops: boolean;
  /** Round W-C: the rain's hiss (quieter under a roof) and thunder. */
  weatherSound: boolean;
  /**
   * A location chosen in BimGo instead of the model's (location override), or null to use the Revit site's. Older
   * readers ignore it; Revit is never changed.
   */
  location: LocationOverride | null;
}

/**
 * A site location chosen in BimGo (searched from the bundled place list, or typed as latitude / longitude) that
 * replaces the Revit site's for the sun, shadows and the daylight studies (port of LocationOverride). True north stays
 * the model's.
 */
export interface LocationOverride {
  /** Degrees, north positive. */
  latitude: number;
  /** Degrees, east positive. */
  longitude: number;
  /** Standard time zone (hours from UTC, without daylight saving). */
  timeZone: number;
  /** The IANA time zone (e.g. "Australia/Sydney"), or null when only the offset is known. */
  zoneId: string | null;
  /** Daylight saving follows zoneId's rules for the date (default); off: the manual +1 h tick decides. */
  autoDaylightSaving: boolean;
  /** What to call the place ("Sydney, New South Wales, Australia" or "−33.86°, 151.21°"). */
  name: string;
}

/** LocationOverride.Clean: clamps the offset, trims the texts. Returns the same object. */
export function cleanLocation(l: LocationOverride): LocationOverride {
  if (Number.isFinite(l.timeZone)) { l.timeZone = clamp(l.timeZone, -14, 14); }
  l.zoneId = isBlank(l.zoneId) ? null : l.zoneId!.trim();
  l.name = (l.name ?? '').trim().slice(0, 120);
  return l;
}

/** Reads a location override (null when missing or not usable). */
export function readLocation(j: Json | null): LocationOverride | null {
  if (!j) { return null; }
  const l = cleanLocation({
    latitude: num(j.latitude, NaN), longitude: num(j.longitude, NaN), timeZone: num(j.timeZone, 0),
    zoneId: str(j.zoneId, null), autoDaylightSaving: bool(j.autoDaylightSaving, true), name: str(j.name, '')
  });
  const valid = Number.isFinite(l.latitude) && Number.isFinite(l.longitude) && Number.isFinite(l.timeZone) && Math.abs(l.latitude) <= 90 && Math.abs(l.longitude) <= 180;
  return valid ? l : null;
}

export const SUN_MIN_INTENSITY = 0;
export const SUN_MAX_INTENSITY = 2;
/** Smallest sun disc size multiplier. */
export const SUN_MIN_SIZE = 0.25;

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

/** A sun time's day of the year (1–366) in a year (the day clamped to its month). */
export function sunDayOfYear(year: number, time: SunTime): number {
  const month = clamp(time.month, 1, 12);
  const day = clamp(time.day, 1, daysInMonth(year, month));
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86400000) + 1;
}

/**
 * Round K-C: a sun time part way between two others (port of SunBlend.Between). The date moves the short way round the
 * year; the clock time moves straight; daylight saving switches halfway. Fills `into`; returns the clock time in
 * fractional minutes (0 – 1439.99).
 */
export function sunBlend(a: SunTime, b: SunTime, t: number, year: number, into: SunTime): number {
  t = Number.isFinite(t) ? clamp(t, 0, 1) : 0;
  year = clamp(year, 1, 9998);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = leap ? 366 : 365;
  const dayA = sunDayOfYear(year, a), dayB = sunDayOfYear(year, b);
  let span = dayB - dayA;
  if (span > Math.trunc(days / 2)) { span -= days; } else if (span < -Math.trunc(days / 2)) { span += days; }
  let day = Math.round(Math.fround(dayA + span * t));
  day = (((day - 1) % days) + days) % days + 1;
  const date = new Date(Date.UTC(year, 0, day));
  into.month = date.getUTCMonth() + 1;
  into.day = date.getUTCDate();
  const minutesA = clamp(a.minutes, 0, 1439), minutesB = clamp(b.minutes, 0, 1439);
  const minutes = clamp(minutesA + (minutesB - minutesA) * Math.fround(t), 0, 1439.99);
  into.minutes = clamp(Math.trunc(minutes), 0, 1439);
  into.daylightSaving = t < 0.5 ? a.daylightSaving : b.daylightSaving;
  return minutes;
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
    glassTransmission: clampOr(j.glassTransmission, 0, 2, 1),
    cloudCover: clampOr(j.cloudCover, 0, 1, 0),
    cloudSpeed: clampOr(j.cloudSpeed, 0, 2, 1),
    sunSize: clampOr(j.sunSize, SUN_MIN_SIZE, 2, 1),
    sunGlare: clampOr(j.sunGlare, 0, 2, 1),
    moon: bool(j.moon, true),
    moonPhase: typeof j.moonPhase === 'number' && Number.isFinite(j.moonPhase) ? Math.fround(clamp(j.moonPhase, 0.05, 1)) : null,
    moonLight: clampOr(j.moonLight, 0, 2, 1),
    stars: bool(j.stars, true),
    starDensity: clampOr(j.starDensity, 0, 2, 1),
    starBrightness: clampOr(j.starBrightness, 0, 2, 1),
    starTwinkle: clampOr(j.starTwinkle, 0, 2, 1),
    milkyWay: clampOr(j.milkyWay, 0, 2, 1),
    weather: readWeather(j.weather),
    weatherIntensity: clampOr(j.weatherIntensity, 0.05, 1, 0.5),
    wetness: clampOr(j.wetness, 0, 1, 1),
    snowCover: clampOr(j.snowCover, 0, 1, 0.6),
    lightning: bool(j.lightning),
    lightningFrequency: clamp(int(j.lightningFrequency, 1), 0, 2),
    lightningFlash: clampOr(j.lightningFlash, 0, 1, 0.35),
    reduceFlashing: bool(j.reduceFlashing),
    lensDrops: bool(j.lensDrops, true),
    weatherSound: bool(j.weatherSound, true),
    location: readLocation(objOrNull(j.location))
  };
}

export function sunDefaultsFor(site: SiteInfo | null): SunSettings {
  return {
    version: 1, enabled: false, time: sunStartFor(site), sunIntensity: 1, skyIntensity: 1, shadowIntensity: 1, glassTransmission: 1,
    cloudCover: 0, cloudSpeed: 1, sunSize: 1, sunGlare: 1, moon: true, moonPhase: null, moonLight: 1, stars: true, starDensity: 1,
    starBrightness: 1, starTwinkle: 1, milkyWay: 1, ...weatherDefaults(), location: null
  };
}

/** Round W-B / W-C: the weather fields' defaults (RESET WEATHER). */
export function weatherDefaults(): Pick<SunSettings, 'weather' | 'weatherIntensity' | 'wetness' | 'snowCover' | 'lightning'
  | 'lightningFrequency' | 'lightningFlash' | 'reduceFlashing' | 'lensDrops' | 'weatherSound'> {
  return {
    weather: 'off', weatherIntensity: 0.5, wetness: 1, snowCover: 0.6, lightning: false, lightningFrequency: 1, lightningFlash: 0.35,
    reduceFlashing: false, lensDrops: true, weatherSound: true
  };
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
  /**
   * The section cut when the bookmark was set: GO restores it; a cut with nothing on clears the cut; null (older
   * bookmarks) leaves the current cut alone.
   */
  section: SectionCut | null;
  /**
   * What was hidden when the bookmark was set (tour round): hidden categories, links and elements. GO and the tour
   * restore it (an empty set shows everything); null (older bookmarks) leaves visibility alone. Never the ground
   * offset or the section (the section has its own field).
   */
  visibility: VisibilitySettings | null;
  /** The standing eye height when the bookmark was set (m): GO and the tour use it. Null keeps the current one. */
  eyeHeight: number | null;
  /** Polish round P-C: the player was crouching (walking) when it was saved: GO arrives crouched. */
  crouched: boolean;
  /** Polish round P-C: the colour profile showing when it was saved (its id; "" = none); null leaves the profile alone. */
  colourProfile: string | null;
  /** Tour: seconds to hold at this stop, or null for the tour's hold time. */
  tourHold: number | null;
  /** Tour: this stop's swivel in degrees (positive left, negative right, 0 none), or null for the tour's. */
  tourSwivel: number | null;
  /** Tour: leave this bookmark out of the tour (it stays in the list). */
  tourSkip: boolean;
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
  /** The bookmark tour's settings (tour round), or null for the defaults. Older readers ignore it. */
  tour: TourSettings | null;
}

/** Which way the tour's swivel turns. */
export type TourSwivelDirection = 'left' | 'right';

/**
 * The bookmark tour's settings (port of TourSettings), saved with the bookmarks. Each bookmark can override the hold
 * and swivel (tourHold, tourSwivel) or be left out (tourSkip).
 */
export interface TourSettings {
  transition: TourTransition;
  /** Seconds at each stop (between the fades), unless a bookmark overrides it. */
  holdSeconds: number;
  /** Seconds to fade out, and again to fade in (0 = cut). */
  fadeSeconds: number;
  /** Seconds to glide from one stop to the next (glide transition). */
  glideSeconds: number;
  /** Pan slowly at each stop. */
  swivel: boolean;
  /** How far the swivel pans over a stop (degrees). */
  swivelDegrees: number;
  swivelDirection: TourSwivelDirection;
  /** Show the HUD (minimap, status, room) during the tour; off = a clean view. */
  showUi: boolean;
  /** Start again from the first stop after the last. */
  loop: boolean;
  /** Round K-C: play the tour as a smooth camera path through the stops (a field, so older builds still read it). */
  smooth: boolean;
  /** Round K-C: the smooth tour's speed between stops (m/s). */
  smoothSpeed: number;
}

/** TourSettings' limits. */
export const TourLimits = {
  MIN_HOLD: 1, MAX_HOLD: 60, MAX_FADE: 2, MIN_GLIDE: 1, MAX_GLIDE: 15, MAX_SWIVEL: 180, MIN_EYE_HEIGHT: 0.9, MAX_EYE_HEIGHT: 2.0,
  MIN_SMOOTH_SPEED: 0.25, MAX_SMOOTH_SPEED: 6
} as const;

export function defaultTourSettings(): TourSettings {
  return {
    transition: 'fade', holdSeconds: 4, fadeSeconds: f32(0.6), glideSeconds: 3, swivel: true, swivelDegrees: 30, swivelDirection: 'left',
    showUi: false, loop: false, smooth: false, smoothSpeed: 1.5
  };
}

/** TourSettings.Clean: every value into range (hand-edited files). Returns the same object. */
export function cleanTourSettings(t: TourSettings): TourSettings {
  const L = TourLimits;
  if (t.transition !== 'fade' && t.transition !== 'glide') { t.transition = 'fade'; }
  if (t.swivelDirection !== 'left' && t.swivelDirection !== 'right') { t.swivelDirection = 'left'; }
  t.holdSeconds = Number.isFinite(t.holdSeconds) ? f32(clamp(t.holdSeconds, L.MIN_HOLD, L.MAX_HOLD)) : 4;
  t.fadeSeconds = Number.isFinite(t.fadeSeconds) ? f32(clamp(t.fadeSeconds, 0, L.MAX_FADE)) : f32(0.6);
  t.glideSeconds = Number.isFinite(t.glideSeconds) ? f32(clamp(t.glideSeconds, L.MIN_GLIDE, L.MAX_GLIDE)) : 3;
  t.swivelDegrees = Number.isFinite(t.swivelDegrees) ? f32(clamp(t.swivelDegrees, 0, L.MAX_SWIVEL)) : 30;
  t.smoothSpeed = Number.isFinite(t.smoothSpeed) ? f32(clamp(t.smoothSpeed, L.MIN_SMOOTH_SPEED, L.MAX_SMOOTH_SPEED)) : 1.5;
  return t;
}

/** The tour-wide swivel in degrees, signed like tourSwivel (positive left). */
export function signedSwivelDegrees(t: TourSettings): number {
  return !t.swivel ? 0 : t.swivelDirection === 'right' ? -t.swivelDegrees : t.swivelDegrees;
}

/** A stop's hold: the bookmark's own, else the tour's (s). */
export function tourHoldFor(t: TourSettings, b: BookmarkRecord | null): number {
  return b?.tourHold ?? t.holdSeconds;
}

/** A stop's swivel: the bookmark's own, else the tour's (degrees, positive left). */
export function tourSwivelFor(t: TourSettings, b: BookmarkRecord | null): number {
  return b?.tourSwivel ?? signedSwivelDegrees(t);
}

/** Reads tour settings (enum names case-insensitive, as the desktop's string enum converter). */
export function readTourSettings(j: Json | null): TourSettings | null {
  if (!j) { return null; }
  const d = defaultTourSettings();
  const lower = (v: unknown, fallback: string) => (typeof v === 'string' ? v.toLowerCase() : fallback);
  return cleanTourSettings({
    transition: lower(j.transition, d.transition) as TourTransition,
    holdSeconds: float(j.holdSeconds, d.holdSeconds),
    fadeSeconds: float(j.fadeSeconds, d.fadeSeconds),
    glideSeconds: float(j.glideSeconds, d.glideSeconds),
    swivel: bool(j.swivel, d.swivel),
    swivelDegrees: float(j.swivelDegrees, d.swivelDegrees),
    swivelDirection: lower(j.swivelDirection, d.swivelDirection) as TourSwivelDirection,
    showUi: bool(j.showUi, d.showUi),
    loop: bool(j.loop, d.loop),
    smooth: bool(j.smooth, d.smooth),
    smoothSpeed: float(j.smoothSpeed, d.smoothSpeed)
  });
}

/** Clamps a bookmark's tour-round fields (hand-edited files). */
function cleanTourFields(b: BookmarkRecord): void {
  const L = TourLimits;
  if (b.visibility) {
    b.visibility.groundOffset = null;
    b.visibility.section = null;
  }
  const clampOrNull = (v: number | null, min: number, max: number) => (v === null ? null : Number.isFinite(v) ? f32(clamp(v, min, max)) : null);
  b.eyeHeight = clampOrNull(b.eyeHeight, L.MIN_EYE_HEIGHT, L.MAX_EYE_HEIGHT);
  b.tourHold = clampOrNull(b.tourHold, L.MIN_HOLD, L.MAX_HOLD);
  b.tourSwivel = clampOrNull(b.tourSwivel, -L.MAX_SWIVEL, L.MAX_SWIVEL);
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
    section: SectionCut.read(j.section),
    visibility: objOrNull(j.visibility) ? readVisibility(objOrNull(j.visibility)!) : null,
    eyeHeight: nullableFloat(j.eyeHeight),
    crouched: bool(j.crouched),
    colourProfile: str(j.colourProfile, null),
    tourHold: nullableFloat(j.tourHold),
    tourSwivel: nullableFloat(j.tourSwivel),
    tourSkip: bool(j.tourSkip),
    thumbnail: str(j.thumbnail, null),
    local: vec3(),
    detail: ''
  };
}

export function emptyBookmarks(): BookmarkDocument {
  return { version: 1, model: '', units: 'metres, Revit internal coordinates; angles in radians', bookmarks: [], home: null, tour: null };
}

/** A float32 member that may be null / missing (float? on the desktop). */
function nullableFloat(v: unknown): number | null {
  return v === null || v === undefined ? null : float(v, NaN);
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
    cleanTourFields(b);
  }
  doc.tour = readTourSettings(objOrNull(j.tour));
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
  /**
   * The ground plane moved in the pause menu: metres above (+) or below (−) its default (100 mm under the lowest
   * level), so it stays right after a re-extraction. Null = the default.
   */
  groundOffset: number | null;
  /** The section cut, or null when nothing is cut. */
  section: SectionCut | null;
  /** Grids round A: how the grids are shown, or null for the defaults (grids off). */
  grids: GridViewSettings | null;
  /** Colour round A: the model's colour profiles, or null when there are none. */
  appearance: AppearanceSettings | null;
}

/** Most the ground plane can move from its default (m), as the pause menu slider. */
export const MAX_GROUND_OFFSET = 10;

/** A ground offset as stored: finite, clamped to ±10 m, null when (almost) zero. */
export function cleanGroundOffset(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) <= 1e-4) { return null; }
  return f32(clamp(value, -MAX_GROUND_OFFSET, MAX_GROUND_OFFSET));
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
      .filter(e => (e.uniqueId !== null && e.uniqueId.length > 0) || e.id > 0),
    groundOffset: cleanGroundOffset(j.groundOffset),
    section: activeSection(SectionCut.read(j.section)),
    grids: nonDefaultGrids(GridView.read(j.grids)),
    appearance: nonDefaultAppearance(Appearance.read(j.appearance))
  };
}

function nonDefaultGrids(g: GridViewSettings | null): GridViewSettings | null {
  return g && !GridView.isDefault(g) ? g : null;
}

function nonDefaultAppearance(a: AppearanceSettings | null): AppearanceSettings | null {
  return a && !Appearance.isDefault(a) ? a : null;
}

export function isVisibilityEmpty(v: VisibilitySettings): boolean {
  return v.hiddenCategories.length === 0 && v.hiddenLinks.length === 0 && v.hiddenElements.length === 0 && v.groundOffset === null
    && v.section === null && (v.grids ?? null) === null && (v.appearance ?? null) === null;
}

/** Round K-C: a copy with its own lists (the section, grids and appearance are shared: replaced, never edited in place). */
export function copyVisibility(v: VisibilitySettings): VisibilitySettings {
  return { ...v, hiddenCategories: [...v.hiddenCategories], hiddenLinks: [...v.hiddenLinks], hiddenElements: v.hiddenElements.map(e => ({ ...e })) };
}

/** A cut kept only when it cuts. */
export function activeSection(cut: SectionCut | null): SectionCut | null {
  return cut?.isActive ? cut : null;
}

// #endregion

