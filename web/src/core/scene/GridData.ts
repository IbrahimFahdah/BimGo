import { type Vec2, vec2 } from '../math/Vector';
import type { LevelInfo } from './SceneData';

/**
 * Grids round A: one Revit grid as the walkthrough draws it (port of GridLine): its name, its plan line (straight, an
 * arc's points, or a multi-segment grid's segments joined in order) and its 3D vertical extent. Scene-local metres.
 */
export interface GridLine {
  /** The grid's name (its bubble text, e.g. "A" or "12"). */
  name: string;
  /** 0 for the host, n for scene.links[n - 1]. */
  link: number;
  /** The plan polyline (at least two points; arcs are tessellated). */
  points: Vec2[];
  /** Bottom of the grid's 3D extent (scene Z, m), or −∞ when unknown. */
  bottom: number;
  /** Top of the grid's 3D extent (scene Z, m), or +∞ when unknown. */
  top: number;
  /** True for an arc grid (or a multi-segment grid with an arc). */
  curved: boolean;
}

/** True when the vertical extent is known (both ends finite, top at or above bottom). */
export const gridHasExtent = (g: GridLine) => Number.isFinite(g.bottom) && Number.isFinite(g.top) && g.top >= g.bottom;

/** True when the line can be drawn (two or more points). */
export const gridIsValid = (g: GridLine | null | undefined): g is GridLine => !!g && Array.isArray(g.points) && g.points.length >= 2;

function outward(tip: Vec2, inner: Vec2): Vec2 {
  const dx = tip.x - inner.x, dy = tip.y - inner.y;
  const length = Math.hypot(dx, dy);
  return length > 1e-6 ? vec2(dx / length, dy / length) : vec2(1, 0);
}

/** Direction leaving the start, pointing away from the line (unit; +X when degenerate). */
export const gridStartOutward = (g: GridLine) => outward(g.points[0], g.points[1]);

/** Direction leaving the end, pointing away from the line (unit; +X when degenerate). */
export const gridEndOutward = (g: GridLine) => outward(g.points[g.points.length - 1], g.points[g.points.length - 2]);

/** Grids round A: which levels the grids are drawn on (the C key cycles them). */
export enum GridLevelMode { Off = 0, Underfoot = 1, All = 2, Above = 3, Below = 4, Nearest = 5, Adjacent = 6 }

const dist2 = (a: Vec2, b: Vec2) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

/**
 * Grids round A: the pure rules behind the grid overlay (port of GridLayout): which grids show on which level, the plan
 * bounds the level outlines frame.
 */
export const GridLayout = {
  /** A level within this of a grid's 3D extent still shows it (m): Revit extents end on the level line. */
  EXTENT_TOLERANCE: 0.05,

  /** How far the level outline stands off the grids' plan bounds (m). */
  OUTLINE_MARGIN: 2,

  /** True when the grid is drawn at this elevation. */
  showsAt(grid: GridLine | null, elevation: number, respectExtents: boolean): boolean {
    if (!gridIsValid(grid)) { return false; }
    if (!respectExtents || !gridHasExtent(grid)) { return true; }
    return elevation >= grid.bottom - GridLayout.EXTENT_TOLERANCE && elevation <= grid.top + GridLayout.EXTENT_TOLERANCE;
  },

  /** The level indices to draw on, in elevation order, into `into` (cleared first). */
  shownLevels(levels: readonly LevelInfo[], mode: GridLevelMode, underfoot: number, eyeZ: number, storeysOnly: boolean, into: number[]): void {
    into.length = 0;
    if (!levels || levels.length === 0 || mode === GridLevelMode.Off) { return; }
    const here = Math.min(Math.max(underfoot, 0), levels.length - 1);
    const anyStorey = levels.some(l => l.isStorey);
    const filter = storeysOnly && anyStorey;
    const step = (from: number, direction: number) => {
      for (let i = from + direction; i >= 0 && i < levels.length; i += direction) {
        if (!filter || levels[i].isStorey) { return i; }
      }
      return -1;
    };
    const addIfAny = (index: number) => { if (index >= 0) { into.push(index); } };
    switch (mode) {
      case GridLevelMode.Underfoot: into.push(here); return;
      case GridLevelMode.Above: addIfAny(step(here, +1)); return;
      case GridLevelMode.Below: addIfAny(step(here, -1)); return;
      case GridLevelMode.Nearest: {
        let best = 0;
        for (let i = 1; i < levels.length; i++) {
          if (Math.abs(levels[i].elevation - eyeZ) < Math.abs(levels[best].elevation - eyeZ)) { best = i; }
        }
        into.push(best);
        return;
      }
      case GridLevelMode.Adjacent:
        addIfAny(step(here, -1));
        into.push(here);
        addIfAny(step(here, +1));
        return;
      default:
        for (let i = 0; i < levels.length; i++) {
          if (!filter || levels[i].isStorey) { into.push(i); }
        }
    }
  },

  /** The level modes in the panel's order (its dropdown). */
  PANEL_ORDER: [GridLevelMode.Off, GridLevelMode.Underfoot, GridLevelMode.Above, GridLevelMode.Below, GridLevelMode.Adjacent,
    GridLevelMode.Nearest, GridLevelMode.All] as readonly GridLevelMode[],

  /** A mode's label (panel, toasts). */
  label(mode: GridLevelMode): string {
    switch (mode) {
      case GridLevelMode.Underfoot: return 'Underfoot';
      case GridLevelMode.Above: return 'Above';
      case GridLevelMode.Below: return 'Below';
      case GridLevelMode.Nearest: return 'Nearest the eye';
      case GridLevelMode.Adjacent: return 'Underfoot ±1';
      case GridLevelMode.All: return 'All levels';
      default: return 'Off';
    }
  },

  /** The plan bounds of the grids drawn at an elevation, grown by OUTLINE_MARGIN; null when none shows there. */
  planBounds(grids: readonly GridLine[], elevation: number, respectExtents: boolean, links: boolean): { min: Vec2; max: Vec2 } | null {
    let minX = Number.MAX_VALUE, minY = Number.MAX_VALUE, maxX = -Number.MAX_VALUE, maxY = -Number.MAX_VALUE;
    let any = false;
    for (const grid of grids ?? []) {
      if (!GridLayout.included(grid, links) || !GridLayout.showsAt(grid, elevation, respectExtents)) { continue; }
      for (const p of grid.points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      any = true;
    }
    if (!any) { return null; }
    const m = GridLayout.OUTLINE_MARGIN;
    return { min: vec2(minX - m, minY - m), max: vec2(maxX + m, maxY + m) };
  },

  /** True when the grid is drawn at all: valid, and a host grid or link grids are on. */
  included: (grid: GridLine | null, links: boolean): boolean => gridIsValid(grid) && (grid.link === 0 || links),

  /** The next mode the cycle key goes to: off → underfoot → all → off (the others go to all). */
  next(mode: GridLevelMode): GridLevelMode {
    return mode === GridLevelMode.Off ? GridLevelMode.Underfoot : mode === GridLevelMode.All ? GridLevelMode.Off : GridLevelMode.All;
  },

  /** Joins a multi-segment grid's segments (any order and direction) into one polyline. */
  chain(segments: readonly Vec2[][]): Vec2[] {
    const line: Vec2[] = [];
    const pending = (segments ?? []).filter(s => s && s.length >= 2);
    if (pending.length === 0) { return line; }
    const nearAnyEnd = (self: number, p: Vec2, tolerance: number) => {
      const t2 = tolerance * tolerance;
      return pending.some((s, j) => j !== self && (dist2(s[0], p) < t2 || dist2(s[s.length - 1], p) < t2));
    };
    let first = 0, flip = false, found = false;
    for (let i = 0; i < pending.length && !found; i++) {
      for (let end = 0; end < 2 && !found; end++) {
        const p = end === 0 ? pending[i][0] : pending[i][pending[i].length - 1];
        if (!nearAnyEnd(i, p, 0.01)) { first = i; flip = end === 1; found = true; }
      }
    }
    const start = pending.splice(first, 1)[0];
    line.push(...(flip ? [...start].reverse() : start));
    while (pending.length > 0) {
      let best = 0, bestDistance = Number.MAX_VALUE;
      const last = line[line.length - 1];
      pending.forEach((s, i) => {
        const d = Math.min(dist2(last, s[0]), dist2(last, s[s.length - 1]));
        if (d < bestDistance) { bestDistance = d; best = i; }
      });
      GridLayout.appendSegment(line, pending.splice(best, 1)[0]);
    }
    return line;
  },

  /** Joins a segment's points onto a polyline in order (reversed when its far end meets the line; a shared joint kept once). */
  appendSegment(line: Vec2[], segment: readonly Vec2[]): void {
    if (!segment || segment.length === 0) { return; }
    if (line.length === 0) { line.push(...segment); return; }
    const last = line[line.length - 1];
    const reverse = dist2(last, segment[segment.length - 1]) < dist2(last, segment[0]);
    for (let k = 0; k < segment.length; k++) {
      const p = segment[reverse ? segment.length - 1 - k : k];
      if (dist2(line[line.length - 1], p) < 1e-8) { continue; }
      line.push(p);
    }
  }
};

/** Grids round B: a grid intersection: the two grids (indices), where they cross and its name ("C-4"). */
export interface GridNode { a: number; b: number; point: Vec2; name: string }

/** Grids round B: a point's grid location: the nearest intersection's name, its level and the plan offset. */
export interface GridLocation { node: string; level: string | null; offset: number; point: Vec2 }

/** "C-4 : Level 2" (Navisworks' gridlocation), or "C-4" without a level. */
export const gridLocationText = (l: GridLocation) => (l.level ? l.node + ' : ' + l.level : l.node);

const isLetter = (c: string) => c.toLowerCase() !== c.toUpperCase();
const compareOrdinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Grids round B: grid intersections (port of GridNodes). */
export const GridNodes = {
  /** Every crossing of two grids of the same model, each segment pair tested; a crossing found twice is kept once. */
  build(grids: readonly GridLine[]): GridNode[] {
    const nodes: GridNode[] = [];
    if (!grids) { return nodes; }
    for (let a = 0; a < grids.length; a++) {
      const ga = grids[a];
      if (!gridIsValid(ga)) { continue; }
      for (let b = a + 1; b < grids.length; b++) {
        const gb = grids[b];
        if (!gridIsValid(gb) || gb.link !== ga.link) { continue; }
        const first = nodes.length;
        for (let i = 1; i < ga.points.length; i++) {
          for (let j = 1; j < gb.points.length; j++) {
            const x = GridNodes.intersect(ga.points[i - 1], ga.points[i], gb.points[j - 1], gb.points[j]);
            if (!x) { continue; }
            let seen = false;
            for (let k = first; k < nodes.length && !seen; k++) { seen = dist2(nodes[k].point, x) < 1e-6; }
            if (!seen) { nodes.push({ a, b, point: x, name: GridNodes.nodeName(ga.name, gb.name) }); }
          }
        }
      }
    }
    return nodes;
  },

  /** "C-4": the name starting with a letter first; two of a kind in ordinal order. */
  nodeName(a: string, b: string): string {
    a = !a || !a.trim() ? '?' : a.trim();
    b = !b || !b.trim() ? '?' : b.trim();
    const la = isLetter(a[0]), lb = isLetter(b[0]);
    const aFirst = la !== lb ? la : compareOrdinal(a, b) <= 0;
    return aFirst ? a + '-' + b : b + '-' + a;
  },

  /** Two segments' crossing (ends included; parallel: none). */
  intersect(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): Vec2 | null {
    const rx = p2.x - p1.x, ry = p2.y - p1.y, sx = q2.x - q1.x, sy = q2.y - q1.y;
    const denom = rx * sy - ry * sx;
    const scale = Math.hypot(rx, ry) * Math.hypot(sx, sy);
    if (scale < 1e-12 || Math.abs(denom) < 1e-6 * scale) { return null; }
    const qx = q1.x - p1.x, qy = q1.y - p1.y;
    const t = (qx * sy - qy * sx) / denom;
    const u = (qx * ry - qy * rx) / denom;
    const E = 1e-5;
    if (t < -E || t > 1 + E || u < -E || u > 1 + E) { return null; }
    return vec2(p1.x + rx * t, p1.y + ry * t);
  },

  /** True when both grids are drawn at this elevation. */
  showsAt: (node: GridNode, grids: readonly GridLine[], elevation: number, respectExtents: boolean): boolean =>
    node.a >= 0 && node.a < grids.length && node.b >= 0 && node.b < grids.length
    && GridLayout.showsAt(grids[node.a], elevation, respectExtents) && GridLayout.showsAt(grids[node.b], elevation, respectExtents)
};

/**
 * Grids round B: where a point is on the grid (port of GridLocator): the level it is on (the highest storey at or below
 * it) and the nearest intersection (host grids; the links' when the host has none), preferring intersections whose
 * grids reach that level.
 */
export class GridLocator {
  static readonly EMPTY = new GridLocator([], [], [], { x: 0, y: 0, z: 0 });

  private constructor(private readonly grids: readonly GridLine[], private readonly nodes: readonly GridNode[],
    private readonly levels: readonly LevelInfo[], private readonly origin: { x: number; y: number; z: number }) {}

  get isEmpty(): boolean { return this.nodes.length === 0; }

  static create(grids: readonly GridLine[], nodes: readonly GridNode[], levels: readonly LevelInfo[], origin: { x: number; y: number; z: number }): GridLocator {
    if (!grids || !nodes || nodes.length === 0) { return GridLocator.EMPTY; }
    const host = nodes.filter(n => grids[n.a].link === 0);
    const use = host.length > 0 ? host : nodes;
    let storeys = (levels ?? []).filter(l => l.isStorey);
    if (storeys.length === 0) { storeys = [...(levels ?? [])]; }
    return new GridLocator(grids, use, storeys, origin);
  }

  /** The location of a point in Revit internal metres (clash points), or null when there are no intersections. */
  locate(x: number, y: number, z: number): GridLocation | null {
    if (this.nodes.length === 0) { return null; }
    const p = vec2(Math.fround(x - this.origin.x), Math.fround(y - this.origin.y));
    const local = Math.fround(z - this.origin.z);
    let level = -1;
    for (let i = 0; i < this.levels.length; i++) {
      if (this.levels[i].elevation <= local + 0.01) { level = i; }
    }
    if (level < 0 && this.levels.length > 0) { level = 0; }
    const elevation = level >= 0 ? this.levels[level].elevation : local;
    let best = this.nearest(p, elevation, true);
    if (best < 0) { best = this.nearest(p, elevation, false); }
    const node = this.nodes[best];
    return { node: node.name, level: level >= 0 ? this.levels[level].name : null, offset: Math.sqrt(dist2(p, node.point)), point: node.point };
  }

  private nearest(p: Vec2, elevation: number, respectExtents: boolean): number {
    let best = -1, bestDistance = Number.MAX_VALUE;
    for (let i = 0; i < this.nodes.length; i++) {
      if (respectExtents && !GridNodes.showsAt(this.nodes[i], this.grids, elevation, true)) { continue; }
      const d = dist2(p, this.nodes[i].point);
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    return best;
  }

  /** "C-4 : Level 2" for a point (internal metres), or null without intersections. */
  text(x: number, y: number, z: number): string | null {
    const l = this.locate(x, y, z);
    return l ? gridLocationText(l) : null;
  }
}

// #region grids.json and the grids panel's settings (port of GridModels.cs)

/** Most points kept per grid. */
export const GRID_MAX_POINTS = 2048;

/** grids.json for a scene's grids, or null when it has none. */
export function gridsToJson(grids: readonly GridLine[]): Record<string, unknown> | null {
  const list = (grids ?? []).filter(gridIsValid).map(g => ({
    name: g.name ?? '',
    link: g.link > 0 ? g.link : null,
    points: g.points.flatMap(p => [Math.fround(p.x), Math.fround(p.y)]),
    bottom: gridHasExtent(g) ? Math.fround(g.bottom) : null,
    top: gridHasExtent(g) ? Math.fround(g.top) : null,
    curved: g.curved ? true : null
  }));
  return list.length === 0 ? null : { version: 1, grids: list };
}

/** The grids grids.json holds (damaged entries dropped; never throws). */
export function gridsFromJson(j: unknown, linkCount: number): GridLine[] {
  const raw = j && typeof j === 'object' ? (j as Record<string, unknown>).grids : null;
  if (!Array.isArray(raw)) { return []; }
  const grids: GridLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') { continue; }
    const g = item as Record<string, unknown>;
    const flat = Array.isArray(g.points) ? g.points : null;
    if (!flat || flat.length < 4) { continue; }
    const points: Vec2[] = [];
    const count = Math.min(Math.floor(flat.length / 2), GRID_MAX_POINTS);
    for (let i = 0; i < count; i++) {
      const x = flat[i * 2], y = flat[i * 2 + 1];
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) { continue; }
      const p = vec2(Math.fround(x), Math.fround(y));
      if (points.length > 0 && dist2(points[points.length - 1], p) < 1e-8) { continue; }
      points.push(p);
    }
    if (points.length < 2) { continue; }
    const b = g.bottom, t = g.top;
    const extent = typeof b === 'number' && typeof t === 'number' && Number.isFinite(b) && Number.isFinite(t) && t >= b;
    const link = typeof g.link === 'number' && g.link > 0 && g.link <= linkCount ? Math.trunc(g.link) : 0;
    const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim() : '?';
    grids.push({
      name, link, points,
      bottom: extent ? Math.fround(b) : -Infinity,
      top: extent ? Math.fround(t) : Infinity,
      curved: g.curved === true
    });
  }
  return grids;
}

/** Grids round A/B: how the grids are shown (the grids panel), saved in visibility.json (port of GridViewSettings). */
export interface GridViewSettings {
  /** "off", "underfoot", "above", "below", "adjacent", "nearest" or "all". */
  levels: string;
  storeysOnly: boolean;
  respectExtents: boolean;
  linkGrids: boolean;
  bubbles: boolean;
  levelTags: boolean;
  levelOutlines: boolean;
  /** "faint", "depth" or "xray". */
  depth: string;
  /** #RRGGBB. */
  colour: string;
  opacity: number;
  width: number;
  labelDistance: number;
  /** "solid" or "dashdot". */
  line: string;
  nodes: boolean;
  clashComments: boolean;
}

export const GridView = {
  LEVELS: ['off', 'underfoot', 'all', 'above', 'below', 'nearest', 'adjacent'] as readonly string[],
  DEPTHS: ['faint', 'depth', 'xray'] as readonly string[],
  DEFAULT_COLOUR: '#4FC3F7',
  MIN_WIDTH: 1, MAX_WIDTH: 6, MIN_OPACITY: 0.1, MIN_LABEL_DISTANCE: 20, MAX_LABEL_DISTANCE: 500,

  defaults(): GridViewSettings {
    return {
      levels: 'off', storeysOnly: true, respectExtents: true, linkGrids: false, bubbles: true, levelTags: true, levelOutlines: true,
      depth: 'faint', colour: GridView.DEFAULT_COLOUR, opacity: Math.fround(0.85), width: 2, labelDistance: 120, line: 'solid', nodes: true,
      clashComments: false
    };
  },

  /** The level mode as an enum (unknown strings: off). */
  mode(s: GridViewSettings): GridLevelMode {
    const i = GridView.LEVELS.indexOf(s.levels);
    return i < 0 ? GridLevelMode.Off : (i as GridLevelMode);
  },

  setMode(s: GridViewSettings, mode: GridLevelMode): void { s.levels = GridView.LEVELS[mode] ?? 'off'; },

  /** 0 faint, 1 depth-tested, 2 x-ray. */
  depthIndex: (s: GridViewSettings): number => Math.max(0, GridView.DEPTHS.indexOf(s.depth)),

  dashDot: (s: GridViewSettings): boolean => s.line === 'dashdot',

  isDefault(s: GridViewSettings): boolean {
    const d = GridView.defaults();
    return s.levels === d.levels && s.storeysOnly === d.storeysOnly && s.respectExtents === d.respectExtents && s.linkGrids === d.linkGrids
      && s.bubbles === d.bubbles && s.levelTags === d.levelTags && s.levelOutlines === d.levelOutlines && s.depth === d.depth
      && s.colour.toUpperCase() === d.colour.toUpperCase() && Math.abs(s.opacity - d.opacity) < 1e-4 && Math.abs(s.width - d.width) < 1e-4
      && Math.abs(s.labelDistance - d.labelDistance) < 1e-3 && s.line === d.line && s.nodes === d.nodes && s.clashComments === d.clashComments;
  },

  /** GridViewSettings.Clean: every field into range. Returns the same object. */
  clean(s: GridViewSettings): GridViewSettings {
    if (!GridView.LEVELS.includes(s.levels)) { s.levels = 'off'; }
    if (!GridView.DEPTHS.includes(s.depth)) { s.depth = 'faint'; }
    if (s.line !== 'dashdot') { s.line = 'solid'; }
    const hex = typeof s.colour === 'string' ? s.colour.trim().replace(/^#/, '') : '';
    s.colour = /^[0-9a-fA-F]{6}$/.test(hex) ? '#' + hex.toUpperCase() : GridView.DEFAULT_COLOUR;
    const c = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    s.opacity = Number.isFinite(s.opacity) ? Math.fround(Math.round(c(s.opacity, GridView.MIN_OPACITY, 1) * 20) / 20) : Math.fround(0.85);
    s.width = Number.isFinite(s.width) ? Math.round(c(s.width, GridView.MIN_WIDTH, GridView.MAX_WIDTH) * 2) / 2 : 2;
    s.labelDistance = Number.isFinite(s.labelDistance)
      ? Math.round(c(s.labelDistance, GridView.MIN_LABEL_DISTANCE, GridView.MAX_LABEL_DISTANCE) / 10) * 10 : 120;
    return s;
  },

  /** Reads the settings (missing members keep their defaults), cleaned. */
  read(j: unknown): GridViewSettings | null {
    if (!j || typeof j !== 'object' || Array.isArray(j)) { return null; }
    const o = j as Record<string, unknown>;
    const d = GridView.defaults();
    const s = (k: keyof GridViewSettings) => (typeof o[k] === 'string' ? o[k] as string : d[k] as string);
    const b = (k: keyof GridViewSettings) => (typeof o[k] === 'boolean' ? o[k] as boolean : d[k] as boolean);
    const n = (k: keyof GridViewSettings) => (typeof o[k] === 'number' ? Math.fround(o[k] as number) : d[k] as number);
    return GridView.clean({
      levels: s('levels'), storeysOnly: b('storeysOnly'), respectExtents: b('respectExtents'), linkGrids: b('linkGrids'), bubbles: b('bubbles'),
      levelTags: b('levelTags'), levelOutlines: b('levelOutlines'), depth: s('depth'), colour: s('colour'), opacity: n('opacity'),
      width: n('width'), labelDistance: n('labelDistance'), line: s('line'), nodes: b('nodes'), clashComments: b('clashComments')
    });
  },

  copy: (s: GridViewSettings): GridViewSettings => ({ ...s })
};

// #endregion
