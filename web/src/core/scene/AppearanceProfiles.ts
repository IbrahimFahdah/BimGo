import { type ClashSetupLink, ClashSetupFiles } from '../clashes/ClashSetupFiles';
import {
  allRules, copySet, jsonWithoutNulls, normaliseRule, normaliseSetRules, readSet, RuleField, RuleNumbers, ruleValueAt, ruleValueCount,
  type SearchSet, setJson, setRuleValues
} from '../clashes/ClashModels';
import { SearchSets } from '../clashes/SearchSets';
import { arr, bool, isBlank, type Json, newId, num, obj, objOrNull, str } from '../format/Json';
import { type LinkInfo, linkLabel } from './LinkInfo';
import type { SceneData } from './SceneData';

/** "#3D4045" → 0x3d4045, or null (LaunchSettings.TryParseColour). */
function parseRgb(text: unknown): number | null {
  const hex = typeof text === 'string' ? text.trim().replace(/^#/, '') : '';
  return /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : null;
}

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'accent' }) === 0;

/** Colour round A: what a colour profile colours by. */
export const ProfileKind = {
  BY_SET: 'bySet',
  BY_VALUE: 'byValue',
  normalise: (kind: string | null | undefined): string => ((kind ?? '').trim().toLowerCase() === 'byset' ? 'bySet' : 'byValue')
};

/** Colour round A: how the elements no rule colours look. */
export const UnmatchedLook = {
  GHOST: 'ghost',
  NORMAL: 'normal',
  FLAT: 'flat',
  ALL: ['ghost', 'normal', 'flat'] as readonly string[],
  LABELS: ['Ghosted', 'Normal', 'Flat colour'] as readonly string[],
  normalise(look: string | null | undefined): string {
    const l = (look ?? '').trim().toLowerCase();
    return UnmatchedLook.ALL.find(k => k === l) ?? UnmatchedLook.GHOST;
  }
};

/** Polish round P-C: how a ranges profile cuts its numbers. */
export const BinMethod = {
  EQUAL: 'equal',
  QUANTILE: 'quantile',
  CUSTOM: 'custom',
  ALL: ['equal', 'quantile', 'custom'] as readonly string[],
  LABELS: ['EQUAL WIDTH', 'EQUAL COUNT', 'CUSTOM'] as readonly string[],
  normalise(method: string | null | undefined): string {
    const m = (method ?? '').trim().toLowerCase();
    return BinMethod.ALL.find(k => k === m) ?? BinMethod.EQUAL;
  }
};

/** Colour round A: one row of a colour profile: a search set or a value (or B: a number range) and its colour. */
export interface ProfileRule {
  setId: string | null;
  value: string | null;
  label: string | null;
  /** "#RRGGBB". */
  colour: string;
  on: boolean;
  from: number | null;
  to: number | null;
  /** 0 (solid) to 0.9. */
  transparency: number;
  hidden: boolean;
}

export function newProfileRule(): ProfileRule {
  return { setId: null, value: null, label: null, colour: '#9CA3AF', on: true, from: null, to: null, transparency: 0, hidden: false };
}

export const ruleRgb = (r: ProfileRule): number => parseRgb(r.colour) ?? 0x9ca3af;
export const ruleIsRange = (r: ProfileRule): boolean => r.from !== null && r.to !== null;
const copyProfileRule = (r: ProfileRule): ProfileRule => ({ ...r });

/** Colour round A: a named colour profile (as Navisworks' appearance profiler). */
export interface AppearanceProfile {
  id: string;
  name: string;
  kind: string;
  field: string;
  parameter: string | null;
  palette: string;
  unmatched: string;
  unmatchedColour: string;
  /** How much of the surface's own detail shows through the colour (0 flat – 1 multiply). */
  detail: number;
  ranges: boolean;
  bins: number;
  binning: string;
  breaks: number[] | null;
  ramp: string;
  rules: ProfileRule[];
}

export const isBySet = (p: AppearanceProfile): boolean => ProfileKind.normalise(p.kind) === ProfileKind.BY_SET;

export function newProfile(name = 'New profile'): AppearanceProfile {
  return {
    id: newId(), name, kind: ProfileKind.BY_VALUE, field: RuleField.CATALOG, parameter: null, palette: AppearanceProfiler.PALETTE_BRIGHT,
    unmatched: UnmatchedLook.GHOST, unmatchedColour: '#D6DADF', detail: AppearanceProfiler.DEFAULT_DETAIL, ranges: false,
    bins: AppearanceProfiler.DEFAULT_BINS, binning: BinMethod.EQUAL, breaks: null, ramp: AppearanceProfiler.RAMP_BLUE_RED, rules: []
  };
}

/** AppearanceProfile.Clean: normalises the fields and drops broken rows. Returns the same object. */
export function cleanProfile(p: AppearanceProfile): AppearanceProfile {
  if (isBlank(p.id)) { p.id = newId(); }
  p.name = isBlank(p.name) ? 'Profile' : p.name.trim();
  p.kind = ProfileKind.normalise(p.kind);
  p.field = RuleField.normalise(p.field);
  p.parameter = p.field === RuleField.PARAMETER ? (p.parameter ?? '').trim() : null;
  p.palette = AppearanceProfiler.normalisePalette(p.palette);
  p.unmatched = UnmatchedLook.normalise(p.unmatched);
  p.unmatchedColour = AppearanceProfiler.cleanColour(p.unmatchedColour, '#D6DADF');
  p.detail = Number.isFinite(p.detail) ? Math.min(Math.max(p.detail, 0), 1) : AppearanceProfiler.DEFAULT_DETAIL;
  const bySet = isBySet(p);
  if (bySet) { p.ranges = false; }
  p.bins = Math.min(Math.max(Math.trunc(Number.isFinite(p.bins) ? p.bins : AppearanceProfiler.DEFAULT_BINS), AppearanceProfiler.MIN_BINS), AppearanceProfiler.MAX_BINS);
  p.binning = BinMethod.normalise(p.binning);
  p.breaks = AppearanceProfiler.cleanBreaks(p.breaks);
  p.ramp = AppearanceProfiler.normaliseRamp(p.ramp);
  p.rules = (p.rules ?? []).filter(r => r && (bySet ? !isBlank(r.setId)
    : p.ranges ? ruleIsRange(r) && Number.isFinite(r.from!) && Number.isFinite(r.to!) : r.value !== null));
  for (const rule of p.rules) {
    rule.colour = AppearanceProfiler.cleanColour(rule.colour, '#9CA3AF');
    rule.transparency = Number.isFinite(rule.transparency) ? Math.min(Math.max(rule.transparency, 0), AppearanceProfiler.MAX_TRANSPARENCY) : 0;
    if (bySet) { rule.value = rule.label = null; } else { rule.setId = null; }
    if (!p.ranges) { rule.from = rule.to = null; } else { rule.value = null; }
  }
  return p;
}

export function copyProfile(p: AppearanceProfile, freshId = false): AppearanceProfile {
  return { ...p, id: freshId ? newId() : p.id, breaks: p.breaks ? [...p.breaks] : null, rules: (p.rules ?? []).filter(r => r).map(copyProfileRule) };
}

/** Colour round A: a model's colour profiles, which one is active, and whether it shows (visibility.json → appearance). */
export interface AppearanceSettings {
  profiles: AppearanceProfile[];
  active: string | null;
  on: boolean;
  legend: boolean;
  legendInShots: boolean;
}

export const Appearance = {
  defaults: (): AppearanceSettings => ({ profiles: [], active: null, on: false, legend: true, legendInShots: false }),
  isDefault: (a: AppearanceSettings): boolean => (a.profiles?.length ?? 0) === 0,
  find: (a: AppearanceSettings | null, id: string | null): AppearanceProfile | null =>
    !a || !id ? null : a.profiles.find(p => p && p.id === id) ?? null,

  /** Cleans every profile, drops duplicates and keeps active valid. Returns the same object. */
  clean(a: AppearanceSettings): AppearanceSettings {
    a.profiles = (a.profiles ?? []).filter(p => p).map(cleanProfile);
    const seen = new Set<string>();
    a.profiles = a.profiles.filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));
    if (!Appearance.find(a, a.active)) { a.active = a.profiles[0]?.id ?? null; }
    if (a.active === null) { a.on = false; }
    return a;
  },

  copy: (a: AppearanceSettings): AppearanceSettings => ({ ...a, profiles: a.profiles.filter(p => p).map(p => copyProfile(p)) }),

  read(j: unknown): AppearanceSettings | null {
    const o = objOrNull(j);
    if (!o) { return null; }
    return Appearance.clean({
      profiles: arr(o.profiles).map(p => objOrNull(p)).filter((p): p is Json => p !== null).map(readProfile),
      active: str(o.active, null),
      on: bool(o.on),
      legend: bool(o.legend, true),
      legendInShots: bool(o.legendInShots)
    });
  },

  json(a: AppearanceSettings): Json {
    return jsonWithoutNulls({
      profiles: a.profiles.map(profileJson), active: a.active, on: a.on, legend: a.legend, legendInShots: a.legendInShots
    }) as Json;
  }
};

function readProfileRule(j: Json): ProfileRule {
  const nullableNum = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    setId: str(j.setId, null), value: str(j.value, null), label: str(j.label, null), colour: str(j.colour, '#9CA3AF'), on: bool(j.on, true),
    from: nullableNum(j.from), to: nullableNum(j.to), transparency: Math.fround(num(j.transparency)), hidden: bool(j.hidden)
  };
}

/** A profile from parsed JSON (missing members keep their defaults), cleaned. */
export function readProfile(j: Json): AppearanceProfile {
  const d = newProfile();
  return cleanProfile({
    id: str(j.id, d.id), name: str(j.name, d.name), kind: str(j.kind, d.kind), field: str(j.field, d.field), parameter: str(j.parameter, null),
    palette: str(j.palette, d.palette), unmatched: str(j.unmatched, d.unmatched), unmatchedColour: str(j.unmatchedColour, d.unmatchedColour),
    detail: Math.fround(num(j.detail, d.detail)), ranges: bool(j.ranges), bins: Math.trunc(num(j.bins, d.bins)), binning: str(j.binning, d.binning),
    breaks: Array.isArray(j.breaks) ? j.breaks.filter((b): b is number => typeof b === 'number') : null, ramp: str(j.ramp, d.ramp),
    rules: arr(j.rules).map(r => objOrNull(r)).filter((r): r is Json => r !== null).map(readProfileRule)
  });
}

/** A profile as JSON-ready members in the desktop's order. */
export function profileJson(p: AppearanceProfile): Json {
  return {
    id: p.id, name: p.name, kind: p.kind, field: p.field, parameter: p.parameter, palette: p.palette, unmatched: p.unmatched,
    unmatchedColour: p.unmatchedColour, detail: p.detail, ranges: p.ranges, bins: p.bins, binning: p.binning, breaks: p.breaks, ramp: p.ramp,
    rules: p.rules.map(r => ({
      setId: r.setId, value: r.value, label: r.label, colour: r.colour, on: r.on, from: r.from, to: r.to, transparency: r.transparency, hidden: r.hidden
    }))
  };
}

/** Colour round A: what a profile does to each element (packed RGBA8 per element; A is the code), plus legend counts. */
export interface ProfileResult {
  codes: Uint32Array;
  ruleCounts: number[];
  unmatched: number;
  anyGhost: boolean;
  anyBlended: boolean;
  anyHidden: boolean;
  noNumber: number;
  missingSets: number;
}

const BRIGHT = [0xE6194B, 0x3CB44B, 0x4363D8, 0xF58231, 0x911EB4, 0x42D4F4, 0xF032E6, 0xBFEF45, 0xFFE119, 0x469990, 0x9A6324, 0xDCBEFF];
const SOFT = [0xF4A6A6, 0xA8DDB5, 0xA6C8F4, 0xF9C99A, 0xC9B3E6, 0x9EE3E8, 0xF2B5DD, 0xD6EDA0, 0xFBE7A1, 0xA9D3CC, 0xD9BFA3, 0xC4C9F0];
const DEEP = [0xB91C1C, 0x15803D, 0x1D4ED8, 0xC2410C, 0x7E22CE, 0x0E7490, 0xBE185D, 0x4D7C0F, 0xA16207, 0x0F766E, 0x78350F, 0x4338CA];
const RAMP_STOPS = [
  [0x2C7BB6, 0xABD9E9, 0xFFFFBF, 0xFDAE61, 0xD7191C],
  [0x1A9641, 0xA6D96A, 0xFFFFBF, 0xFDAE61, 0xD7191C],
  [0x3B4CC0, 0x8DB0FE, 0xDDDDDD, 0xF49A7B, 0xB40426],
  [0xDEEBF7, 0x9ECAE1, 0x4292C6, 0x2171B5, 0x08306B]
];

function hsvToRgb(h: number, s: number, v: number): number {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r: number, g: number, b: number;
  switch (Math.trunc(h / 60)) {
    case 0: [r, g, b] = [c, x, 0]; break;
    case 1: [r, g, b] = [x, c, 0]; break;
    case 2: [r, g, b] = [0, c, x]; break;
    case 3: [r, g, b] = [0, x, c]; break;
    case 4: [r, g, b] = [x, 0, c]; break;
    default: [r, g, b] = [c, 0, x];
  }
  const to = (f: number) => Math.min(Math.max(Math.round((f + m) * 255), 0), 255);
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** The unit after a text's first number (" mm"), with its leading space, or empty. */
function unitOf(text: string | null): string {
  if (!text) { return ''; }
  let i = 0;
  while (i < text.length && !isDigit(text[i])) { i++; }
  while (i < text.length && (isDigit(text[i]) || text[i] === '.' || text[i] === ',' || (text[i] === ' ' && isDigit(text[i + 1])))) { i++; }
  const unit = text.slice(i).trim();
  if (unit.length === 0 || unit.length > 6 || /\d/.test(unit) || unit.includes('/')) { return ''; }
  return ' ' + unit;
}

/** Colour round A/B: evaluates colour profiles into per-element codes and builds their rows (port of AppearanceProfiler). */
export const AppearanceProfiler = {
  CODE_NONE: 0,
  CODE_GHOST: 1,
  CODE_HIDDEN: 2,
  CODE_COLOUR: 255,
  CODE_SEE_THROUGH: 128,
  MAX_TRANSPARENCY: 0.9,
  MIN_BINS: 2, MAX_BINS: 12, DEFAULT_BINS: 5,
  DEFAULT_DETAIL: Math.fround(0.35),
  MAX_BREAKS: 24,

  RAMP_BLUE_RED: 'blueRed', RAMP_GREEN_RED: 'greenRed', RAMP_COOL_WARM: 'coolWarm', RAMP_LIGHT_DARK: 'lightDark',
  RAMPS: ['blueRed', 'greenRed', 'coolWarm', 'lightDark'] as readonly string[],
  RAMP_LABELS: ['Blue → red', 'Green → red', 'Cool → warm', 'Light → dark'] as readonly string[],

  PALETTE_BRIGHT: 'bright', PALETTE_SOFT: 'soft', PALETTE_DEEP: 'deep',
  PALETTES: ['bright', 'soft', 'deep'] as readonly string[],
  PALETTE_LABELS: ['Bright', 'Soft', 'Deep'] as readonly string[],

  normaliseRamp(ramp: string | null | undefined): string {
    const r = (ramp ?? '').trim().toLowerCase();
    return AppearanceProfiler.RAMPS.find(k => k.toLowerCase() === r) ?? AppearanceProfiler.RAMP_BLUE_RED;
  },

  /** A ramp's colour at t (0–1) as "#RRGGBB". */
  rampColour(ramp: string, t: number): string {
    const stops = RAMP_STOPS[Math.max(0, AppearanceProfiler.RAMPS.indexOf(AppearanceProfiler.normaliseRamp(ramp)))];
    t = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), 1) * (stops.length - 1);
    const i = Math.min(Math.trunc(t), stops.length - 2);
    const f = t - i;
    const a = stops[i], b = stops[i + 1];
    const mix = (shift: number) => Math.min(Math.max(Math.round(((a >> shift) & 0xff) * (1 - f) + ((b >> shift) & 0xff) * f), 0), 255);
    return AppearanceProfiler.hex((mix(16) << 16) | (mix(8) << 8) | mix(0));
  },

  /** A row's code: hidden, see-through colour, or solid colour. */
  ruleCode(rule: ProfileRule): number {
    if (rule.hidden) { return (AppearanceProfiler.CODE_HIDDEN << 24) >>> 0; }
    const opacity = 1 - Math.min(Math.max(rule.transparency, 0), AppearanceProfiler.MAX_TRANSPARENCY);
    if (opacity >= 0.995) { return AppearanceProfiler.pack(ruleRgb(rule), AppearanceProfiler.CODE_COLOUR); }
    return AppearanceProfiler.pack(ruleRgb(rule), AppearanceProfiler.CODE_SEE_THROUGH + Math.round(opacity * 126));
  },

  normalisePalette(palette: string | null | undefined): string {
    const p = (palette ?? '').trim().toLowerCase();
    return AppearanceProfiler.PALETTES.find(k => k === p) ?? AppearanceProfiler.PALETTE_BRIGHT;
  },

  /** The palette's colour for row index: its twelve colours, then golden-angle hues. */
  paletteColour(palette: string, index: number): string {
    palette = AppearanceProfiler.normalisePalette(palette);
    const colours = palette === 'soft' ? SOFT : palette === 'deep' ? DEEP : BRIGHT;
    index = Math.max(0, index);
    if (index < colours.length) { return AppearanceProfiler.hex(colours[index]); }
    const hue = Math.fround((index - colours.length) * 137.508) % 360;
    const [s, v] = palette === 'soft' ? [0.32, 0.95] : palette === 'deep' ? [0.85, 0.62] : [0.72, 0.9];
    return AppearanceProfiler.hex(hsvToRgb(hue, s, v));
  },

  hex: (rgb: number): string => '#' + (rgb & 0xffffff).toString(16).toUpperCase().padStart(6, '0'),

  cleanColour(text: string | null | undefined, fallback: string): string {
    const rgb = parseRgb(text);
    return rgb === null ? fallback : AppearanceProfiler.hex(rgb);
  },

  /** A by-set profile with one row per set. */
  newBySet(name: string, sets: Iterable<SearchSet>): AppearanceProfile {
    const profile = newProfile(name);
    profile.kind = ProfileKind.BY_SET;
    for (const set of sets ?? []) {
      if (!set) { continue; }
      profile.rules.push({ ...newProfileRule(), setId: set.id, colour: AppearanceProfiler.paletteColour(profile.palette, profile.rules.length) });
    }
    return profile;
  },

  /** A by-value profile for a field (or parameter) with a row per value found in the model. */
  newByValue(name: string, field: string, parameter: string | null, scene: SceneData): AppearanceProfile {
    const profile = newProfile(name);
    profile.field = RuleField.normalise(field);
    profile.parameter = parameter;
    cleanProfile(profile);
    AppearanceProfiler.syncValues(profile, scene);
    return profile;
  },

  /** By value: adds a row for each value the model has that the profile lacks; keeps the others. Returns rows added. */
  syncValues(profile: AppearanceProfile | null, scene: SceneData | null): number {
    if (!profile || isBySet(profile) || profile.ranges || !scene) { return 0; }
    const values = SearchSets.valuesOf(scene, profile.field, profile.parameter);
    const known = new Map<string, ProfileRule>();
    for (const rule of profile.rules) {
      if (rule?.value !== null && rule?.value !== undefined && !known.has(rule.value.toLowerCase())) { known.set(rule.value.toLowerCase(), rule); }
    }
    let added = 0;
    for (const value of values) {
      const rule = known.get(value.value.toLowerCase());
      if (rule) { rule.label = value.label; continue; }
      profile.rules.push({ ...newProfileRule(), value: value.value, label: value.label, colour: AppearanceProfiler.paletteColour(profile.palette, profile.rules.length) });
      added++;
    }
    return added;
  },

  /** Recolours every row from a palette and makes it the profile's palette. */
  applyPalette(profile: AppearanceProfile | null, palette: string): void {
    if (!profile) { return; }
    profile.palette = AppearanceProfiler.normalisePalette(palette);
    profile.rules.forEach((r, i) => { r.colour = AppearanceProfiler.paletteColour(profile.palette, i); });
  },

  /** By value: changes the field; the rows are replaced by the new field's values (or ranges). */
  setField(profile: AppearanceProfile | null, field: string, parameter: string | null, scene: SceneData): void {
    if (!profile) { return; }
    profile.field = RuleField.normalise(field);
    profile.parameter = profile.field === RuleField.PARAMETER ? parameter : null;
    profile.rules = [];
    if (profile.ranges) { AppearanceProfiler.buildRanges(profile, scene); } else { AppearanceProfiler.syncValues(profile, scene); }
  },

  /** Colour round B / P-C: replaces a by-value profile's rows with number ranges; returns how many elements have a number. */
  buildRanges(profile: AppearanceProfile | null, scene: SceneData | null): number {
    if (!profile || isBySet(profile) || !scene) { return 0; }
    profile.ranges = true;
    profile.bins = Math.min(Math.max(profile.bins, AppearanceProfiler.MIN_BINS), AppearanceProfiler.MAX_BINS);
    profile.binning = BinMethod.normalise(profile.binning);
    profile.rules = [];
    const field = RuleField.normalise(profile.field);
    const nameIndex = field === RuleField.PARAMETER ? scene.parameters?.indexOfName(profile.parameter) ?? -1 : -1;
    const numbers: number[] = [];
    const units = new Map<string, number>();
    scene.elements.forEach((record, e) => {
      if (!record || record.isLibraryTemplate) { return; }
      const v = SearchSets.elementValue(scene, record, e, field, nameIndex);
      const n = v ? RuleNumbers.tryParse(v.value) : null;
      if (n === null) { return; }
      numbers.push(n);
      const unit = unitOf(v!.value);
      units.set(unit, (units.get(unit) ?? 0) + 1);
    });
    if (numbers.length === 0) { return 0; }
    let suffix = '', best = -1;
    for (const [unit, count] of units) { if (count > best) { best = count; suffix = unit; } }
    const edges = AppearanceProfiler.rangeEdges(numbers, profile.binning, profile.bins, profile.breaks);
    const bins = edges.length - 1;
    for (let i = 0; i < bins; i++) {
      const from = edges[i], to = edges[i + 1];
      profile.rules.push({
        ...newProfileRule(), from, to,
        label: from === to ? AppearanceProfiler.formatNumber(from) + suffix : `${AppearanceProfiler.formatNumber(from)} – ${AppearanceProfiler.formatNumber(to)}${suffix}`,
        colour: AppearanceProfiler.rampColour(profile.ramp, bins === 1 ? 0.5 : i / (bins - 1))
      });
    }
    return numbers.length;
  },

  /** P-C: the range edges (ascending; n edges = n − 1 ranges) for a method. */
  rangeEdges(numbers: readonly number[], method: string, bins: number, breaks: readonly number[] | null): number[] {
    const edges: number[] = [];
    if (!numbers || numbers.length === 0) { return edges; }
    let min = Number.MAX_VALUE, max = -Number.MAX_VALUE;
    for (const v of numbers) { min = Math.min(min, v); max = Math.max(max, v); }
    if (!(max > min)) { return [min, max]; }
    bins = Math.min(Math.max(bins, AppearanceProfiler.MIN_BINS), AppearanceProfiler.MAX_BINS);
    edges.push(min);
    switch (BinMethod.normalise(method)) {
      case BinMethod.QUANTILE: {
        const sorted = [...numbers].sort((a, b) => a - b);
        for (let i = 1; i < bins; i++) {
          const edge = sorted[Math.round(i * (sorted.length - 1) / bins)];
          if (edge > edges[edges.length - 1] && edge < max) { edges.push(edge); }
        }
        break;
      }
      case BinMethod.CUSTOM:
        for (const edge of AppearanceProfiler.cleanBreaks(breaks ? [...breaks] : null) ?? []) {
          if (edge > edges[edges.length - 1] && edge < max) { edges.push(edge); }
        }
        break;
      default: {
        const step = (max - min) / bins;
        for (let i = 1; i < bins; i++) { edges.push(min + step * i); }
      }
    }
    edges.push(max);
    return edges;
  },

  /** P-C: finite, distinct, ascending break values (at most MAX_BREAKS); null when none. */
  cleanBreaks(breaks: number[] | null | undefined): number[] | null {
    if (!breaks) { return null; }
    const clean = [...new Set(breaks.filter(Number.isFinite))].sort((a, b) => a - b).slice(0, AppearanceProfiler.MAX_BREAKS);
    return clean.length === 0 ? null : clean;
  },

  /** P-C: break values typed by people ("300; 450; 600"); null when none. */
  parseBreaks(text: string | null): number[] | null {
    if (!text || !text.trim()) { return null; }
    const values: number[] = [];
    for (const part of text.replaceAll(', ', ';').split(/[; \t]+/)) {
      if (!part) { continue; }
      const v = RuleNumbers.tryParse(part);
      if (v !== null) { values.push(v); }
    }
    return AppearanceProfiler.cleanBreaks(values);
  },

  /** P-C: break values as people type them ("300; 450; 600"). */
  formatBreaks(breaks: readonly number[] | null): string {
    return breaks ? breaks.map(b => String(Math.round(b * 1000) / 1000)).join('; ') : '';
  },

  /** Recolours a ranges profile's rows from a ramp (and makes it the profile's ramp). */
  applyRamp(profile: AppearanceProfile | null, ramp: string): void {
    if (!profile) { return; }
    profile.ramp = AppearanceProfiler.normaliseRamp(ramp);
    const n = profile.rules.length;
    profile.rules.forEach((r, i) => { r.colour = AppearanceProfiler.rampColour(profile.ramp, n <= 1 ? 0.5 : i / (n - 1)); });
  },

  /** A range end for labels: up to 2 decimals (1 from 100), digit grouping ("1,250.5"). */
  formatNumber(value: number): string {
    return value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) >= 100 ? 1 : 2, minimumFractionDigits: 0 });
  },

  fieldLabel: (profile: AppearanceProfile | null): string => (profile ? SearchSets.fieldLabel(profile.field, profile.parameter) : ''),

  /** "By Level · 6 values", "By search set · 3 sets". */
  describe(profile: AppearanceProfile | null): string {
    if (!profile) { return ''; }
    const n = profile.rules.length;
    const s = n === 1 ? '' : 's';
    return isBySet(profile) ? `By search set · ${n} set${s}`
      : profile.ranges ? `By ${AppearanceProfiler.fieldLabel(profile)} · ${n} range${s}`
        : `By ${AppearanceProfiler.fieldLabel(profile)} · ${n} value${s}`;
  },

  /**
   * What a profile does to every element: rows in order, the first that matches colours it (off rows skipped); the
   * rest are unmatched (ghost / normal / flat colour). Library templates keep their normal look.
   */
  evaluate(profile: AppearanceProfile | null, scene: SceneData | null, findSet: ((id: string | null) => SearchSet | null) | null): ProfileResult {
    const elements = scene?.elements ?? [];
    const codes = new Uint32Array(elements.length);
    const ruleCount = profile?.rules?.length ?? 0;
    const counts = new Array<number>(ruleCount).fill(0);
    const empty = { codes, ruleCounts: counts, unmatched: 0, anyGhost: false, anyBlended: false, anyHidden: false, noNumber: 0, missingSets: 0 };
    if (!profile || !scene) { return empty; }
    const P = AppearanceProfiler;
    const look = UnmatchedLook.normalise(profile.unmatched);
    const unmatchedCode = look === UnmatchedLook.GHOST ? (P.CODE_GHOST << 24) >>> 0
      : look === UnmatchedLook.FLAT ? P.pack(parseRgb(profile.unmatchedColour) ?? 0xd6dadf, P.CODE_COLOUR) : P.CODE_NONE;
    const ruleCodes = profile.rules.map(r => P.ruleCode(r));
    let unmatched = 0, missing = 0, noNumber = 0;
    if (isBySet(profile)) {
      const sets = profile.rules.map(rule => {
        const set = findSet?.(rule.setId) ?? null;
        if (!set) { missing++; }
        return rule.on ? set : null;
      });
      elements.forEach((record, e) => {
        if (!record || record.isLibraryTemplate) { return; }
        let hit = -1;
        for (let r = 0; r < ruleCount && hit < 0; r++) {
          if (sets[r] && SearchSets.matches(sets[r]!, scene, record, e)) { hit = r; }
        }
        if (hit >= 0) { codes[e] = ruleCodes[hit]; counts[hit]++; } else { codes[e] = unmatchedCode; unmatched++; }
      });
    } else if (profile.ranges) {
      const field = RuleField.normalise(profile.field);
      elements.forEach((record, e) => {
        if (!record || record.isLibraryTemplate) { return; }
        let hit = -1;
        const number = SearchSets.numberOf(scene, record, e, field, profile.parameter);
        if (number !== null) {
          for (let r = 0; r < ruleCount; r++) {
            const rule = profile.rules[r];
            if (!ruleIsRange(rule) || number < rule.from! || number > rule.to!) { continue; }
            counts[r]++;
            if (rule.on) { hit = r; }
            break;
          }
        } else { noNumber++; }
        if (hit >= 0) { codes[e] = ruleCodes[hit]; } else { codes[e] = unmatchedCode; unmatched++; }
      });
    } else {
      const byValue = new Map<string, number>();
      profile.rules.forEach((rule, r) => {
        if (rule.value !== null && !byValue.has(rule.value.toLowerCase())) { byValue.set(rule.value.toLowerCase(), r); }
      });
      const field = RuleField.normalise(profile.field);
      const nameIndex = field === RuleField.PARAMETER ? scene.parameters?.indexOfName(profile.parameter) ?? -1 : -1;
      elements.forEach((record, e) => {
        if (!record || record.isLibraryTemplate) { return; }
        let hit = -1;
        const v = SearchSets.elementValue(scene, record, e, field, nameIndex);
        const r = v ? byValue.get(v.value.toLowerCase()) : undefined;
        if (r !== undefined) {
          counts[r]++;
          if (profile.rules[r].on) { hit = r; }
        }
        if (hit >= 0) { codes[e] = ruleCodes[hit]; } else { codes[e] = unmatchedCode; unmatched++; }
      });
    }
    const anyGhost = unmatched > 0 && look === UnmatchedLook.GHOST;
    let anySeeThrough = false, anyHidden = false;
    for (let r = 0; r < ruleCount; r++) {
      if (counts[r] === 0 || !profile.rules[r].on) { continue; }
      const code = ruleCodes[r] >>> 24;
      if (code === P.CODE_HIDDEN) { anyHidden = true; } else if (code >= P.CODE_SEE_THROUGH && code < P.CODE_COLOUR) { anySeeThrough = true; }
    }
    return { codes, ruleCounts: counts, unmatched, anyGhost, anyBlended: anyGhost || anySeeThrough, anyHidden, missingSets: missing, noNumber };
  },

  /** Packs 0xRRGGBB and a code into the renderer's R | G << 8 | B << 16 | A << 24. */
  pack(rgb: number, code: number): number {
    return (((rgb >> 16) & 0xff) | (((rgb >> 8) & 0xff) << 8) | ((rgb & 0xff) << 16) | ((code & 0xff) << 24)) >>> 0;
  }
};

/** Colour round B: a colour profiles file (EXPORT… / IMPORT…): profiles and the sets their by-set rows use. */
export interface ProfileFile {
  format: string;
  version: number;
  modelTitle: string;
  generator: string;
  exportedUtc: string;
  profiles: AppearanceProfile[];
  sets: SearchSet[];
  links: ClashSetupLink[];
}

/** Polish round P-C: what reconciling an imported profile file did. */
export interface ProfileReconcile { matched: number; missing: string[] }

/** Colour round B: writes, reads and merges colour profile files (port of ProfileFiles). */
export const ProfileFiles = {
  FORMAT: 'bimgo-colour-profiles',
  VERSION: 1,

  build(profiles: Iterable<AppearanceProfile>, findSet: ((id: string | null) => SearchSet | null) | null, modelTitle: string, generator: string,
    links: readonly LinkInfo[] | null = null): ProfileFile {
    const file: ProfileFile = {
      format: ProfileFiles.FORMAT, version: ProfileFiles.VERSION, modelTitle: modelTitle ?? '', generator: generator ?? '',
      exportedUtc: new Date().toISOString(), profiles: [], sets: [], links: []
    };
    const setIds = new Set<string>();
    for (const profile of profiles ?? []) {
      if (!profile) { continue; }
      file.profiles.push(copyProfile(profile));
      if (!isBySet(profile)) { continue; }
      for (const rule of profile.rules) {
        const set = findSet?.(rule.setId) ?? null;
        if (set && !setIds.has(set.id)) { setIds.add(set.id); file.sets.push(copySet(set)); }
      }
    }
    const named = new Set<string>();
    const name = (value: string | null) => {
      if (!value || named.has(value.toLowerCase())) { return; }
      named.add(value.toLowerCase());
      const link = ClashSetupFiles.findLink(links, value);
      file.links.push({ uniqueId: value, name: link ? linkLabel(link) : value });
    };
    for (const rule of file.sets.flatMap(allRules)) {
      if (RuleField.normalise(rule.field) !== RuleField.LINK) { continue; }
      for (let i = 0; i < ruleValueCount(rule); i++) { name(ruleValueAt(rule, i)); }
    }
    for (const profile of file.profiles) {
      if (isBySet(profile) || profile.ranges || RuleField.normalise(profile.field) !== RuleField.LINK) { continue; }
      for (const rule of profile.rules) { name(rule.value); }
    }
    return file;
  },

  /** P-C: rewrites the file's link and level values for this model (matched by name); reports what can't be matched. */
  reconcile(file: ProfileFile, links: readonly LinkInfo[] | null, levels: Iterable<string>): ProfileReconcile {
    const result: ProfileReconcile = { matched: 0, missing: [] };
    const levelNames = [...levels].filter(l => l);
    const missing = new Map<string, string>();
    const map = (field: string, value: string | null): string | null => {
      if (!value) { return value; }
      if (field === RuleField.LINK) {
        if (!links) { return value; }
        if (links.some(l => l.instanceUniqueId.toLowerCase() === value.toLowerCase())) { return value; }
        const name = file.links.find(l => l.uniqueId.toLowerCase() === value.toLowerCase())?.name ?? value;
        const byName = ClashSetupFiles.findLink(links, name);
        if (byName && byName.instanceUniqueId) { return byName.instanceUniqueId; }
        missing.set(('Link: ' + name).toLowerCase(), 'Link: ' + name);
        return null;
      }
      if (field === RuleField.LEVEL) {
        const level = levelNames.find(l => sameText(l, value.trim()));
        if (level) { return level; }
        missing.set(('Level: ' + value).toLowerCase(), 'Level: ' + value);
        return null;
      }
      return value;
    };
    for (const rule of file.sets.flatMap(allRules)) {
      const field = RuleField.normalise(rule.field);
      if (field !== RuleField.LINK && field !== RuleField.LEVEL) { continue; }
      normaliseRule(rule);
      let changed = false;
      const values: string[] = [];
      for (const value of rule.values) {
        const mapped = map(field, value) ?? value;
        if (mapped !== value) { changed = true; result.matched++; }
        if (!values.some(v => v.toLowerCase() === mapped.toLowerCase())) { values.push(mapped); }
      }
      if (changed) { setRuleValues(rule, values); }
    }
    for (const profile of file.profiles) {
      const field = RuleField.normalise(profile.field);
      if (isBySet(profile) || profile.ranges || (field !== RuleField.LINK && field !== RuleField.LEVEL)) { continue; }
      for (const rule of profile.rules) {
        const mapped = map(field, rule.value) ?? rule.value;
        if (mapped === rule.value) { continue; }
        rule.value = mapped;
        result.matched++;
      }
    }
    result.missing = [...missing.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }));
    return result;
  },

  serialize(file: ProfileFile): string {
    return JSON.stringify(jsonWithoutNulls({
      format: file.format, version: file.version, modelTitle: file.modelTitle, generator: file.generator, exportedUtc: file.exportedUtc,
      profiles: file.profiles.map(profileJson), sets: file.sets.map(setJson), links: file.links.map(l => ({ uniqueId: l.uniqueId, name: l.name }))
    }), null, 2);
  },

  parse(text: string | null): { file: ProfileFile | null; error: string | null } {
    if (!text) { return { file: null, error: 'The file is empty.' }; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (e) {
      return { file: null, error: `The file could not be read: ${e instanceof Error ? e.message : String(e)}` };
    }
    const j = objOrNull(raw);
    if (!j) { return { file: null, error: 'The file is empty.' }; }
    if (str(j.format, '').toLowerCase() !== ProfileFiles.FORMAT) { return { file: null, error: 'This is not a BimGo colour profiles file.' }; }
    const version = num(j.version, 1);
    if (version > ProfileFiles.VERSION) {
      return { file: null, error: `This file was made by a newer BimGo (version ${version}). Please update BimGo.` };
    }
    const sets = arr(j.sets).map(s => objOrNull(s)).filter((s): s is Json => s !== null).map(readSet);
    for (const set of sets) {
      if (isBlank(set.id)) { set.id = newId(); }
      set.name = isBlank(set.name) ? 'Imported set' : set.name.trim();
      normaliseSetRules(set);
    }
    return {
      file: {
        format: ProfileFiles.FORMAT, version, modelTitle: str(j.modelTitle, ''), generator: str(j.generator, ''), exportedUtc: str(j.exportedUtc, ''),
        profiles: arr(j.profiles).map(p => objOrNull(p)).filter((p): p is Json => p !== null).map(readProfile), sets,
        links: arr(j.links).map(l => obj(l)).map(l => ({ uniqueId: str(l.uniqueId, ''), name: str(l.name, '') })).filter(l => l.uniqueId.length > 0)
      },
      error: null
    };
  },

  /**
   * Adds a file's profiles to a model's (new ids; a taken name gets " (imported)"). Sets are matched by name with the
   * model's, else added (new ids); by-set rows then point at the model's sets.
   */
  merge(file: ProfileFile, into: AppearanceSettings, sets: SearchSet[] | null): { added: AppearanceProfile[]; setsMatched: number; setsAdded: number } {
    let setsMatched = 0, setsAdded = 0;
    const added: AppearanceProfile[] = [];
    const map = new Map<string, string>();
    if (sets) {
      for (const set of file.sets) {
        const existing = sets.find(x => sameText(x.name, set.name));
        if (existing) { map.set(set.id, existing.id); setsMatched++; continue; }
        const copy = copySet(set, true);
        sets.push(copy);
        map.set(set.id, copy.id);
        setsAdded++;
      }
    }
    const names = into.profiles.map(p => p.name);
    for (const profile of file.profiles) {
      const copy = copyProfile(profile, true);
      if (names.some(n => sameText(n, copy.name))) { copy.name += ' (imported)'; }
      names.push(copy.name);
      for (const rule of copy.rules) {
        if (rule.setId !== null && map.has(rule.setId)) { rule.setId = map.get(rule.setId)!; }
      }
      into.profiles.push(cleanProfile(copy));
      added.push(copy);
    }
    return { added, setsMatched, setsAdded };
  }
};
