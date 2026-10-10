import { type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import { type RoomInfo, roomContains, roomDistanceToBoundary } from '../core/scene/SceneData';
import { Daylight } from '../core/scene/Daylight';
import { horizontalOffset, StudyMode, SunHours, type SunHoursSettings } from '../core/scene/SunHours';

type Triangle = [Vec3, Vec3, Vec3];

/** One surface of a sun hours study: coplanar triangles of one element, the room it is clipped to and how its normal is chosen. */
export class SunHoursFace {
  readonly triangles: Triangle[] = [];
  /** The room the cells are clipped to, or -1 (the whole face). */
  room = -1;
  /** Walls found from a room: each cell faces whichever side is inside the room. */
  bothSides = false;
  /** Picked by clicking (not part of the room selection). */
  picked = false;

  constructor(
    /** The element (index into SceneData.elements). */
    readonly element: number,
    /** The plane normal (for bothSides faces its sign is arbitrary). */
    readonly normal: Vec3,
    /** dot(normal, point). */
    readonly offset: number
  ) {}

  /** Floors and other upward / downward faces (they take the floor offset). */
  get horizontal(): boolean { return Math.abs(this.normal.z) > 0.7; }

  /** True when another face lies in the same plane of the same element (either normal sign). */
  samePlane(element: number, normal: Vec3, offset: number): boolean {
    const d = V.dot(normal, this.normal);
    return element === this.element && Math.abs(d) > 0.995 && Math.abs(offset * Math.sign(d) - this.offset) < 0.02;
  }
}

/** Where a daylight ray ends (daylight round). */
export enum RayOutcome {
  /** Reaches the sky (above the horizon). */
  Sky,
  /** Reaches the ground outside (below the horizon, nothing in the way). */
  Ground,
  /** Hits a surface outside the cell's room (lit by the sky: one external bounce). */
  External,
  /** Hits the cell's own room (its light is the internally reflected component). */
  Internal
}

/** Follows a daylight ray from a test point: where it ends, and the transmittance of glass it passed (1 = none). */
export type RayClassifier = (origin: Vec3, direction: Vec3, room: number) => { outcome: RayOutcome; transmit: number };

/** A room's daylight figures: surface area, reflectances, glazing and the split-flux internally reflected component. */
export interface RoomLight {
  valid: boolean;
  totalArea: number;
  windowArea: number;
  averageReflectance: number;
  lowerReflectance: number;
  upperReflectance: number;
  ceilingReflectance: number;
  wallReflectance: number;
  floorReflectance: number;
  /** The internally reflected component under the overcast sky (% of the outdoor horizontal). */
  ircPercent: number;
}

export const NO_ROOM_LIGHT: RoomLight = {
  valid: false, totalArea: 0, windowArea: 0, averageReflectance: 0, lowerReflectance: 0, upperReflectance: 0,
  ceilingReflectance: 0, wallReflectance: 0, floorReflectance: 0, ircPercent: 0
};

/** What a daylight run needs, prepared once at RUN (skies per time sample, rooms, rays). */
export interface DaylightInputs {
  mode: StudyMode;
  classify: RayClassifier;
  /** Cosine-weighted ray directions around +Z (rotated into each cell's frame). */
  rays: Vec3[];
  /** Daylight factor: overcast patch luminances scaled to a unit horizontal illuminance. */
  overcast: Float32Array | null;
  /** Illuminance, per time sample with the sun up: sun direction, clear-sky patches, diffuse horizontal and direct normal (lux). */
  suns: Vec3[];
  clear: Float32Array[];
  diffuse: number[];
  directNormal: number[];
  totalSamples: number;
  directSun: boolean;
  luxTarget: number;
  /** Per room index, its daylight figures. */
  rooms: RoomLight[] | null;
  /** A cell's area (m²): the grid size squared. */
  cellArea: number;
}

/**
 * A direct sun hours study (port of SunHoursStudy.cs): a pixelated test grid over the chosen faces, and per cell the
 * hours of direct sun over the study's time range. The grid is built at once; the ray casting runs a few milliseconds
 * per frame ({@link step}), so moved / placed elements block the sun too. Never throws.
 */
export class SunHoursStudy {
  /** Most cells in one study (a larger grid is suggested beyond this). */
  static readonly MAX_CELLS = 80_000;
  /** Test points sit this far off their surface on top of the offset (m), clear of it for the rays. */
  private static readonly LIFT = 0.02;
  /** A sun this close to grazing a surface (cosine) gives it no sun. */
  private static readonly GRAZING = 0.02;
  /** Rays stop at this distance (m): anything further can't shade a room. */
  static readonly MAX_DISTANCE = 1500;
  /** Most cells × time samples an illuminance run keeps in memory (floats). */
  static readonly MAX_LUX_VALUES = 12_000_000;

  // Cells: point, normal, in-plane axes (3 floats each), and face index
  private points: number[] = [];
  private normals: number[] = [];
  private us: number[] = [];
  private vs: number[] = [];
  private faceOf: number[] = [];

  settings: SunHoursSettings | null = null;
  faces: SunHoursFace[] = [];
  truncated = false;
  /**
   * The value per cell (valid up to done), or null before a run: hours of direct sun, daylight factor (%) or average
   * illuminance (lux), by mode.
   */
  hours: Float32Array | null = null;
  /** Illuminance runs: per cell, the share of time samples at or above the lux target (else null). */
  shares: Float32Array | null = null;
  /** What the current results are. */
  mode = StudyMode.SunHours;
  done = 0;
  running = false;
  finished = false;
  /** Changes whenever cells or results change (the overlay rebuilds on a change). */
  revision = 0;
  sunSamples = 0;
  totalSamples = 0;
  runSettings: SunHoursSettings | null = null;
  /** Run time (ms). */
  elapsed = 0;
  private directions: Vec3[] = [];
  private daylight: DaylightInputs | null = null;
  private readonly patchWeights = new Float32Array(Daylight.PATCHES);
  /** Illuminance: cells × samples (lux), the sun bounce added at the end. */
  private luxSamples: Float32Array | null = null;
  /** Illuminance: per room, per sample, direct sun landing on its floor cells (lm). */
  private roomSunFlux: (Float32Array | null)[] | null = null;

  get cellCount(): number { return this.faceOf.length; }

  /**
   * Lays the test grid over the faces: square cells of the grid size in each face's plane (U horizontal on walls,
   * along X on floors; snapped to the plane's own origin so neighbouring faces line up), kept where the cell centre
   * lies on a triangle and, for faces clipped to a room, where its tested side faces into the room. Clears results.
   */
  build(faces: SunHoursFace[], settings: SunHoursSettings, rooms: RoomInfo[]): void {
    this.cancel();
    this.settings = settings;
    this.faces = faces;
    this.points = [];
    this.normals = [];
    this.us = [];
    this.vs = [];
    this.faceOf = [];
    this.hours = null;
    this.shares = null;
    this.daylight = null;
    this.finished = false;
    this.done = 0;
    this.truncated = false;
    this.revision++;

    const g = settings.gridSize;
    for (let f = 0; f < faces.length && !this.truncated; f++) {
      const face = faces[f];
      if (face.triangles.length === 0) { continue; }
      const n = face.normal;
      const u = Math.abs(n.z) > 0.7 ? V.normalize(V.sub(vec3(1, 0, 0), V.scale(n, n.x))) : V.normalize(V.cross(vec3(0, 0, 1), n));
      const v = V.cross(n, u);
      const origin = V.scale(n, face.offset); // the plane's point nearest the scene origin: shared by coplanar faces

      // The face in plane coordinates
      const flat: number[] = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const triangle of face.triangles) {
        for (const p of triangle) {
          const d = V.sub(p, origin);
          const x = V.dot(d, u), y = V.dot(d, v);
          flat.push(x, y);
          minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
      }

      const room = face.room >= 0 && face.room < rooms.length ? rooms[face.room] : null;
      const offset = (face.horizontal ? horizontalOffset(settings) : settings.wallOffset) + SunHoursStudy.LIFT;
      const i0 = Math.floor(minX / g), i1 = Math.floor(maxX / g), j0 = Math.floor(minY / g), j1 = Math.floor(maxY / g);
      for (let j = j0; j <= j1 && !this.truncated; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = (i + 0.5) * g, cy = (j + 0.5) * g;
          if (!onFace(flat, cx, cy)) { continue; }
          const p = V.add(origin, V.add(V.scale(u, cx), V.scale(v, cy)));
          const normal = sideOf(face, room, p);
          if (!normal) { continue; }
          if (this.faceOf.length >= SunHoursStudy.MAX_CELLS) {
            this.truncated = true;
            break;
          }
          const q = V.add(p, V.scale(normal, offset));
          this.points.push(q.x, q.y, q.z);
          this.normals.push(normal.x, normal.y, normal.z);
          this.us.push(u.x, u.y, u.z);
          this.vs.push(v.x, v.y, v.z);
          this.faceOf.push(f);
        }
      }
    }
  }

  /** Starts (or restarts) the run with these sun directions (scene axes, sun above the horizon). */
  start(directions: Vec3[], totalSamples: number, settings: SunHoursSettings): void {
    this.directions = directions;
    this.sunSamples = directions.length;
    this.totalSamples = totalSamples;
    this.runSettings = settings;
    this.mode = StudyMode.SunHours;
    this.daylight = null;
    this.hours = new Float32Array(this.cellCount);
    this.shares = null;
    this.done = 0;
    this.finished = false;
    this.running = this.cellCount > 0;
    this.elapsed = 0;
    this.revision++;
  }

  /**
   * Starts a daylight factor or illuminance run.
   * @returns False when an illuminance run would need too much memory (cells × samples).
   */
  startDaylight(inputs: DaylightInputs, settings: SunHoursSettings): boolean {
    const samples = inputs.suns.length;
    const lux = inputs.mode === StudyMode.Illuminance;
    if (lux && this.cellCount * Math.max(1, samples) > SunHoursStudy.MAX_LUX_VALUES) { return false; }
    this.daylight = inputs;
    this.mode = inputs.mode;
    this.runSettings = settings;
    this.sunSamples = samples;
    this.totalSamples = lux ? inputs.totalSamples : 0;
    this.hours = new Float32Array(this.cellCount);
    this.shares = lux ? new Float32Array(this.cellCount) : null;
    this.luxSamples = lux ? new Float32Array(this.cellCount * Math.max(1, samples)) : null;
    this.roomSunFlux = lux && inputs.rooms ? inputs.rooms.map(r => (r.valid ? new Float32Array(Math.max(1, samples)) : null)) : null;
    this.done = 0;
    this.finished = false;
    this.running = this.cellCount > 0;
    this.elapsed = 0;
    this.revision++;
    return true;
  }

  /** Stops a run (cells computed so far keep their hours). */
  cancel(): void {
    if (!this.running) { return; }
    this.running = false;
    this.revision++;
  }

  /**
   * Computes cells for up to budgetMs: per cell, every sun sample in front of its surface whose ray reaches the sky
   * adds one step of sun.
   * @param blocked True when a ray from a point towards a direction hits something.
   */
  step(blocked: (origin: Vec3, direction: Vec3, distance: number) => boolean, budgetMs: number): void {
    if (!this.running || !this.hours || !this.runSettings) { return; }
    if (this.daylight) {
      this.stepDaylight(budgetMs);
      return;
    }
    const started = performance.now();
    const hoursPerSample = this.runSettings.stepMinutes / 60;
    const startDone = this.done;
    const count = this.cellCount;
    while (this.done < count) {
      const o = this.done * 3;
      const p = vec3(this.points[o], this.points[o + 1], this.points[o + 2]);
      const nx = this.normals[o], ny = this.normals[o + 1], nz = this.normals[o + 2];
      let sunny = 0;
      for (const d of this.directions) {
        if (d.x * nx + d.y * ny + d.z * nz <= SunHoursStudy.GRAZING) { continue; }
        if (!blocked(p, d, SunHoursStudy.MAX_DISTANCE)) { sunny++; }
      }
      this.hours[this.done] = sunny * hoursPerSample;
      this.done++;
      if (((this.done - startDone) & 7) === 0 && performance.now() - started >= budgetMs) { break; }
    }
    this.elapsed += performance.now() - started;
    this.revision++;
    if (this.done >= count) {
      this.running = false;
      this.finished = true;
    }
  }

  /**
   * Daylight cells for up to budgetMs: per cell, rays over its hemisphere binned into sky patches (sky, ground,
   * outside surfaces; rays into its own room are left to the internally reflected component), then the daylight
   * factor, or per time sample the clear-sky + sun illuminance.
   */
  private stepDaylight(budgetMs: number): void {
    const started = performance.now();
    const d = this.daylight!;
    const hours = this.hours!;
    const startDone = this.done;
    const weight = Math.PI / d.rays.length;
    const count = this.cellCount;
    const pw = this.patchWeights;
    while (this.done < count) {
      const i = this.done, o = i * 3;
      const p = vec3(this.points[o], this.points[o + 1], this.points[o + 2]);
      const nx = this.normals[o], ny = this.normals[o + 1], nz = this.normals[o + 2];
      const ux = this.us[o], uy = this.us[o + 1], uz = this.us[o + 2];
      const vx = this.vs[o], vy = this.vs[o + 1], vz = this.vs[o + 2];
      const room = this.faces[this.faceOf[i]].room;
      const light = d.rooms && room >= 0 && room < d.rooms.length ? d.rooms[room] : NO_ROOM_LIGHT;

      pw.fill(0);
      let ground = 0, outside = 0;
      for (const r of d.rays) {
        const direction = V.normalize(vec3(ux * r.x + vx * r.y + nx * r.z, uy * r.x + vy * r.y + ny * r.z, uz * r.x + vz * r.y + nz * r.z));
        const { outcome, transmit } = d.classify(p, direction, room);
        if (outcome === RayOutcome.Sky) {
          const patch = Daylight.patchOf(direction.x, direction.y, direction.z);
          if (patch >= 0) { pw[patch] += weight * transmit; } else { ground += weight * transmit; }
        } else if (outcome === RayOutcome.Ground) {
          ground += weight * transmit;
        } else if (outcome === RayOutcome.External) {
          outside += weight * transmit;
        }
      }

      if (d.mode === StudyMode.DaylightFactor) {
        // Sky + ground + outside surfaces (relative to a unit outdoor horizontal illuminance) + the room's IRC
        let sky = 0;
        for (let k = 0; k < Daylight.PATCHES; k++) { sky += pw[k] * d.overcast![k]; }
        const external = ground * Daylight.GROUND_REFLECTANCE / Math.PI + outside * Daylight.OBSTRUCTION_REFLECTANCE / (2 * Math.PI);
        hours[i] = (sky + external) * 100 + (light.valid ? light.ircPercent : 0);
      } else {
        this.stepLuxCell(i, p, vec3(nx, ny, nz), room, light, ground, outside);
      }

      this.done++;
      if (((this.done - startDone) & 3) === 0 && performance.now() - started >= budgetMs) { break; }
    }
    this.elapsed += performance.now() - started;
    this.revision++;
    if (this.done >= count) {
      if (d.mode === StudyMode.Illuminance) { this.finishLux(); }
      this.running = false;
      this.finished = true;
    }
  }

  /**
   * One illuminance cell: per time sample, clear sky + ground + outside surfaces + the room's sky IRC + direct sun
   * (when on and it reaches the cell); direct sun on horizontal cells adds to the room's floor flux for the sun bounce.
   */
  private stepLuxCell(i: number, p: Vec3, n: Vec3, room: number, light: RoomLight, ground: number, outside: number): void {
    const d = this.daylight!;
    const samples = d.suns.length;
    const flux = this.roomSunFlux && room >= 0 && room < this.roomSunFlux.length ? this.roomSunFlux[room] : null;
    const floorCell = n.z > 0.7 && flux !== null;
    const pw = this.patchWeights;
    for (let s = 0; s < samples; s++) {
      const sky = d.clear[s];
      let e = 0;
      for (let k = 0; k < Daylight.PATCHES; k++) { e += pw[k] * sky[k]; }

      const sun = d.suns[s];
      const direct = d.directSun ? d.directNormal[s] : 0;
      const globalHorizontal = d.diffuse[s] + direct * Math.max(0, sun.z);
      e += ground * Daylight.GROUND_REFLECTANCE * globalHorizontal / Math.PI;
      e += outside * Daylight.OBSTRUCTION_REFLECTANCE * globalHorizontal / (2 * Math.PI);
      if (light.valid) { e += light.ircPercent * 0.01 * d.diffuse[s]; }

      const cos = V.dot(sun, n);
      if (direct > 0 && cos > SunHoursStudy.GRAZING) {
        const { outcome, transmit } = d.classify(p, sun, room);
        if (outcome === RayOutcome.Sky) {
          const sunLux = direct * cos * transmit;
          e += sunLux;
          if (floorCell) { flux![s] += sunLux * d.cellArea; }
        }
      }
      this.luxSamples![i * samples + s] = e;
    }
    this.hours![i] = 0; // the average is set once the sun bounce is known (finishLux)
  }

  /** Adds each room's sun bounce and works out every cell's average illuminance and the share of samples at or above the target. */
  private finishLux(): void {
    const d = this.daylight!;
    const samples = d.suns.length;
    const hours = this.hours!, shares = this.shares!;
    for (let i = 0; i < this.cellCount; i++) {
      if (samples === 0) {
        hours[i] = 0;
        shares[i] = 0;
        continue;
      }
      const room = this.faces[this.faceOf[i]].room;
      const flux = this.roomSunFlux && room >= 0 && room < this.roomSunFlux.length ? this.roomSunFlux[room] : null;
      const light = flux ? d.rooms![room] : NO_ROOM_LIGHT;
      let sum = 0, reached = 0;
      for (let s = 0; s < samples; s++) {
        let e = this.luxSamples![i * samples + s];
        if (flux) { e += Daylight.floorBounceLux(flux[s], light.totalArea, light.averageReflectance, light.lowerReflectance); }
        sum += e;
        if (e >= d.luxTarget) { reached++; }
      }
      hours[i] = sum / samples;
      shares[i] = reached / samples;
    }
    this.luxSamples = null;
    this.roomSunFlux = null;
  }

  /**
   * Shows saved results on the grid just built (a loaded study whose cells still match): values per cell, the run's
   * settings and sample counts. False when the cell count doesn't match.
   */
  setResults(hours: ArrayLike<number>, runSettings: SunHoursSettings, sunSamples: number, totalSamples: number,
    shares: ArrayLike<number> | null = null): boolean {
    if (hours.length !== this.cellCount) { return false; }
    const lux = runSettings.mode === StudyMode.Illuminance;
    if (lux && (!shares || shares.length !== hours.length)) { return false; }
    this.running = false;
    this.daylight = null;
    this.mode = runSettings.mode;
    this.shares = lux ? Float32Array.from(shares!) : null;
    this.hours = Float32Array.from(hours);
    this.done = this.hours.length;
    this.finished = true;
    this.runSettings = runSettings;
    this.sunSamples = sunSamples;
    this.totalSamples = totalSamples;
    this.elapsed = 0;
    this.revision++;
    return true;
  }

  /**
   * True when cell i passes the settings' test: sun hours ≥ the hours target, daylight factor ≥ the % target, or (lux)
   * the lux target reached for at least the share of samples.
   */
  passes(i: number, settings: SunHoursSettings): boolean {
    const hours = this.hours!;
    switch (this.mode) {
      case StudyMode.DaylightFactor: return hours[i] >= settings.factorTarget - 1e-4;
      case StudyMode.Illuminance: return this.shares !== null && this.shares[i] >= settings.luxShare - 1e-4;
      default: return SunHours.passes(hours[i], settings.targetHours);
    }
  }

  /** The share of computed cells that pass the settings' test (0–1). */
  passShare(settings: SunHoursSettings): number {
    if (!this.hours || this.done === 0 || this.running) { return 0; }
    let pass = 0;
    for (let i = 0; i < this.done; i++) {
      if (this.passes(i, settings)) { pass++; }
    }
    return pass / this.done;
  }

  /** Cell i: its test point, normal, in-plane axes and face index. */
  cell(i: number): { point: Vec3; normal: Vec3; u: Vec3; v: Vec3; face: number } {
    const o = i * 3;
    return {
      point: vec3(this.points[o], this.points[o + 1], this.points[o + 2]),
      normal: vec3(this.normals[o], this.normals[o + 1], this.normals[o + 2]),
      u: vec3(this.us[o], this.us[o + 1], this.us[o + 2]),
      v: vec3(this.vs[o], this.vs[o + 1], this.vs[o + 2]),
      face: this.faceOf[i]
    };
  }

  /** Average, min and max hours of the computed cells, and the share with at least 2 h and 3 h (equal-area cells). */
  statistics(): { average: number; min: number; max: number; atLeast2: number; atLeast3: number } {
    if (!this.hours || this.done === 0) { return { average: 0, min: 0, max: 0, atLeast2: 0, atLeast3: 0 }; }
    let sum = 0, min = Number.MAX_VALUE, max = 0, two = 0, three = 0;
    for (let i = 0; i < this.done; i++) {
      const h = this.hours[i];
      sum += h;
      min = Math.min(min, h);
      max = Math.max(max, h);
      if (h >= 2 - 1e-4) { two++; }
      if (h >= 3 - 1e-4) { three++; }
    }
    return { average: sum / this.done, min, max, atLeast2: two / this.done, atLeast3: three / this.done };
  }
}

/** A room's own wall face may lie this far inside the room (m): rooms bounded at wall centres put it half a wall in. */
const WALL_INSIDE = 0.4;
/** ... or this far outside it (m): rooms bounded at finishes put it on the boundary; a partition's far face stays out. */
const WALL_OUTSIDE = 0.03;
/** How far either side of a wall face is probed to find the side that leads into the room (m). */
const WALL_PROBE = 0.45;

/**
 * The side a cell is tested on (null when the cell is dropped). Floors: inside the room's plan near its height. Walls
 * found from a room: the face must be the room's own (between WALL_INSIDE inside and WALL_OUTSIDE outside its
 * boundary, so rooms bounded at wall finishes and at wall centres both work), tested on the side that leads deeper
 * into the room. Picked faces: their own side, which must face into the room they were clipped to.
 */
function sideOf(face: SunHoursFace, room: RoomInfo | null, p: Vec3): Vec3 | null {
  if (!room) { return face.normal; }
  if (face.horizontal) {
    return roomContains(room, p) && p.z > room.bottomZ - 0.3 && p.z < room.topZ + 0.5 ? face.normal : null;
  }
  if (p.z < room.bottomZ - 0.05 || p.z > room.topZ + 0.5) { return null; }
  const n = face.normal;
  let ax = n.x, ay = n.y;
  const length = Math.hypot(ax, ay);
  if (length > 1e-4) { ax /= length; ay /= length; }

  if (face.bothSides) {
    const depth = signedDepth(room, p.x, p.y);
    if (depth > WALL_INSIDE || depth < -WALL_OUTSIDE) { return null; }
    const front = signedDepth(room, p.x + ax * WALL_PROBE, p.y + ay * WALL_PROBE);
    const back = signedDepth(room, p.x - ax * WALL_PROBE, p.y - ay * WALL_PROBE);
    if (Math.max(front, back) <= 0) { return null; }
    return front >= back ? n : V.scale(n, -1);
  }
  return roomContains(room, { x: p.x + ax * 0.1, y: p.y + ay * 0.1 }) ? n : null;
}

/** Distance to the room's boundary: positive inside, negative outside. */
function signedDepth(room: RoomInfo, x: number, y: number): number {
  const point = { x, y };
  const distance = roomDistanceToBoundary(room, point);
  return roomContains(room, point) ? distance : -distance;
}

/** True when a plane point lies on any of the face's triangles (flat: 6 floats per triangle). */
function onFace(flat: number[], px: number, py: number): boolean {
  for (let t = 0; t < flat.length; t += 6) {
    const ax = flat[t], ay = flat[t + 1], bx = flat[t + 2], by = flat[t + 3], cx = flat[t + 4], cy = flat[t + 5];
    const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
    const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
    const negative = d1 < -1e-6 || d2 < -1e-6 || d3 < -1e-6;
    const positive = d1 > 1e-6 || d2 > 1e-6 || d3 > 1e-6;
    if (!(negative && positive)) { return true; }
  }
  return false;
}
