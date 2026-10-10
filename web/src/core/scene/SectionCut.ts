import { type Vec3, vec3, Vec3 as V } from '../math/Vector';
import { bool, float, objOrNull } from '../format/Json';

/** One clipping plane as BCF writes it: a point and the direction towards the cut-away side. */
export interface ClipPlane {
  point: Vec3;
  direction: Vec3;
}

/** A local plane for the shaders: points where n·p > d are cut away. */
export interface LocalPlane {
  x: number;
  y: number;
  z: number;
  w: number;
}

const axis = (v: Vec3, i: number) => (i === 0 ? v.x : i === 1 ? v.y : v.z);
function setAxis(v: Vec3, i: number, value: number): void {
  if (i === 0) { v.x = value; } else if (i === 1) { v.y = value; } else { v.z = value; }
}

/**
 * A section cut (port of BimGo.Core/Scene/SectionCut.cs): an axis-aligned section box and / or one free clipping
 * plane, in Revit internal metres (like comments and bookmarks), so a cut survives re-extraction. Geometry outside
 * the box, and on the plane normal's side, is cut away. Saved with the model (visibility.json), in bookmarks and
 * comment views, and as BCF clipping planes.
 */
export class SectionCut {
  /** Most clipping planes a cut makes (6 box faces + the free plane). */
  static readonly MAX_PLANES = 7;
  /** Smallest box size along any axis (m). */
  static readonly MIN_SIZE = 0.2;

  boxOn = false;
  boxMin: Vec3 = vec3();
  boxMax: Vec3 = vec3();
  planeOn = false;
  planePoint: Vec3 = vec3();
  /** The free plane's unit normal, pointing into the side that is cut away (as BCF's direction). */
  planeNormal: Vec3 = vec3(0, 0, 1);

  get isActive(): boolean {
    return this.boxOn || this.planeOn;
  }

  clone(): SectionCut {
    const c = new SectionCut();
    c.boxOn = this.boxOn;
    c.boxMin = V.copy(this.boxMin);
    c.boxMax = V.copy(this.boxMax);
    c.planeOn = this.planeOn;
    c.planePoint = V.copy(this.planePoint);
    c.planeNormal = V.copy(this.planeNormal);
    return c;
  }

  /**
   * Makes the cut sane: finite numbers, box corners ordered and at least MIN_SIZE apart, a unit plane normal (a zero
   * normal switches the plane off).
   */
  clean(): this {
    const a = finite(this.boxMin), b = finite(this.boxMax);
    const min = V.min(a, b), max = V.max(a, b);
    for (let i = 0; i < 3; i++) {
      if (axis(max, i) - axis(min, i) < SectionCut.MIN_SIZE) { setAxis(max, i, axis(min, i) + SectionCut.MIN_SIZE); }
    }
    this.boxMin = min;
    this.boxMax = max;
    this.planePoint = finite(this.planePoint);
    let n = finite(this.planeNormal);
    if (V.lengthSquared(n) < 1e-8) {
      this.planeOn = false;
      n = vec3(0, 0, 1);
    }
    this.planeNormal = V.normalize(n);
    return this;
  }

  /**
   * The cut's planes in scene-local coordinates for the shaders, box faces first (+X, −X, +Y, −Y, +Z, −Z), then the
   * free plane.
   */
  localPlanes(origin: Vec3): LocalPlane[] {
    const planes: LocalPlane[] = [];
    if (this.boxOn) {
      const min = V.sub(this.boxMin, origin), max = V.sub(this.boxMax, origin);
      planes.push({ x: 1, y: 0, z: 0, w: max.x }, { x: -1, y: 0, z: 0, w: -min.x });
      planes.push({ x: 0, y: 1, z: 0, w: max.y }, { x: 0, y: -1, z: 0, w: -min.y });
      planes.push({ x: 0, y: 0, z: 1, w: max.z }, { x: 0, y: 0, z: -1, w: -min.z });
    }
    if (this.planeOn) {
      const n = this.planeNormal;
      planes.push({ x: n.x, y: n.y, z: n.z, w: V.dot(n, V.sub(this.planePoint, origin)) });
    }
    return planes;
  }

  /** True when a scene-local point is cut away by these planes. */
  static isCut(planes: readonly LocalPlane[], x: number, y: number, z: number): boolean {
    for (const p of planes) {
      if (p.x * x + p.y * y + p.z * z > p.w) { return true; }
    }
    return false;
  }

  /**
   * A cut rebuilt from clipping planes (internal metres): six axis-aligned planes facing ±X, ±Y and ±Z (one each)
   * make a box; any other plane becomes the free plane (the first one; further odd planes are dropped). Null when
   * there are none.
   */
  static fromPlanes(planes: readonly ClipPlane[] | null): { cut: SectionCut | null; dropped: number } {
    let dropped = 0;
    if (!planes || planes.length === 0) { return { cut: null, dropped }; }
    const cut = new SectionCut();
    const faces: (number | null)[] = [null, null, null, null, null, null]; // +X −X +Y −Y +Z −Z
    const others: ClipPlane[] = [];
    for (const { point, direction } of planes) {
      if (V.lengthSquared(direction) < 1e-8) { dropped++; continue; }
      const n = V.normalize(direction);
      const face = axisFace(n);
      if (face >= 0 && faces[face] === null) { faces[face] = axis(point, face >> 1); }
      else { others.push({ point, direction: n }); }
    }

    if (faces.every(f => f !== null)) {
      cut.boxOn = true;
      cut.boxMin = vec3(faces[1]!, faces[3]!, faces[5]!);
      cut.boxMax = vec3(faces[0]!, faces[2]!, faces[4]!);
    } else {
      // An incomplete box: its planes are free planes too
      for (let f = 0; f < 6; f++) {
        if (faces[f] === null) { continue; }
        const s = f % 2 === 0 ? 1 : -1;
        const n = vec3(f >> 1 === 0 ? s : 0, f >> 1 === 1 ? s : 0, f >> 1 === 2 ? s : 0);
        const p = vec3();
        setAxis(p, f >> 1, faces[f]!);
        others.unshift({ point: p, direction: n });
      }
    }

    if (others.length > 0) {
      cut.planeOn = true;
      cut.planePoint = V.copy(others[0].point);
      cut.planeNormal = V.copy(others[0].direction);
      dropped += others.length - 1;
    }
    return { cut: cut.isActive ? cut.clean() : null, dropped };
  }

  /** The cut as clipping planes (internal metres): the box's six faces, then the free plane. */
  toPlanes(): ClipPlane[] {
    const planes: ClipPlane[] = [];
    if (this.boxOn) {
      const min = this.boxMin, max = this.boxMax;
      planes.push({ point: vec3(max.x, min.y, min.z), direction: vec3(1, 0, 0) });
      planes.push({ point: V.copy(min), direction: vec3(-1, 0, 0) });
      planes.push({ point: vec3(min.x, max.y, min.z), direction: vec3(0, 1, 0) });
      planes.push({ point: V.copy(min), direction: vec3(0, -1, 0) });
      planes.push({ point: vec3(min.x, min.y, max.z), direction: vec3(0, 0, 1) });
      planes.push({ point: V.copy(min), direction: vec3(0, 0, -1) });
    }
    if (this.planeOn) { planes.push({ point: V.copy(this.planePoint), direction: V.copy(this.planeNormal) }); }
    return planes;
  }

  /** Reads the JSON form (as System.Text.Json writes it: flat camelCase members), cleaned; null for none. */
  static read(v: unknown): SectionCut | null {
    const j = objOrNull(v);
    if (!j) { return null; }
    const c = new SectionCut();
    c.boxOn = bool(j.boxOn);
    c.boxMin = vec3(float(j.minX), float(j.minY), float(j.minZ));
    c.boxMax = vec3(float(j.maxX), float(j.maxY), float(j.maxZ));
    c.planeOn = bool(j.planeOn);
    c.planePoint = vec3(float(j.planeX), float(j.planeY), float(j.planeZ));
    c.planeNormal = vec3(float(j.normalX), float(j.normalY), float(j.normalZ, 1));
    return c.clean();
  }
}

function finite(v: Vec3): Vec3 {
  return vec3(Number.isFinite(v.x) ? v.x : 0, Number.isFinite(v.y) ? v.y : 0, Number.isFinite(v.z) ? v.z : 0);
}

function axisFace(n: Vec3): number {
  for (let i = 0; i < 3; i++) {
    const c = axis(n, i);
    if (Math.abs(c) > 0.9999) { return i * 2 + (c > 0 ? 0 : 1); }
  }
  return -1;
}
