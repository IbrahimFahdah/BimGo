import { type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import { type RoomInfo, roomContains, roomDistanceToBoundary } from '../core/scene/SceneData';
import type { SunHoursSettings } from '../core/scene/SunHours';

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

  // Cells: point, normal, in-plane axes (3 floats each), and face index
  private points: number[] = [];
  private normals: number[] = [];
  private us: number[] = [];
  private vs: number[] = [];
  private faceOf: number[] = [];

  settings: SunHoursSettings | null = null;
  faces: SunHoursFace[] = [];
  truncated = false;
  /** Hours of direct sun per cell (valid up to done), or null before a run. */
  hours: Float32Array | null = null;
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
      const offset = (face.horizontal ? settings.floorOffset : settings.wallOffset) + SunHoursStudy.LIFT;
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
    this.hours = new Float32Array(this.cellCount);
    this.done = 0;
    this.finished = false;
    this.running = this.cellCount > 0;
    this.elapsed = 0;
    this.revision++;
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

/**
 * The side a cell is tested on (null when the cell is dropped): for room-clipped faces the cell's side must lie inside
 * the room (walls: within 6 cm of its boundary, so the far face of a thin partition isn't taken); otherwise the face's
 * own normal.
 */
function sideOf(face: SunHoursFace, room: RoomInfo | null, p: Vec3): Vec3 | null {
  if (!room) { return face.normal; }
  if (face.horizontal) {
    return roomContains(room, p) && p.z > room.bottomZ - 0.3 && p.z < room.topZ + 0.5 ? face.normal : null;
  }
  if (p.z < room.bottomZ - 0.05 || p.z > room.topZ + 0.5) { return null; }
  if (face.bothSides && roomDistanceToBoundary(room, p) > 0.06) { return null; }
  const n = face.normal;
  if (roomContains(room, { x: p.x + n.x * 0.1, y: p.y + n.y * 0.1 })) { return n; }
  if (!face.bothSides) { return null; }
  if (!roomContains(room, { x: p.x - n.x * 0.1, y: p.y - n.y * 0.1 })) { return null; }
  return V.scale(n, -1);
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
