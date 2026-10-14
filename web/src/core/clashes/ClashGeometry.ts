import type { Vec3 } from '../math/Vector';

/**
 * A triangle prepared for clash tests: corners, bounds and unit normal (zero for a degenerate triangle). The engine
 * stores corners relative to the pair's centre, so the maths stays well conditioned. Mutable so lists can reuse them.
 */
export class ClashTriangle {
  ax = 0; ay = 0; az = 0;
  bx = 0; by = 0; bz = 0;
  cx = 0; cy = 0; cz = 0;
  minX = 0; minY = 0; minZ = 0;
  maxX = 0; maxY = 0; maxZ = 0;
  nx = 0; ny = 0; nz = 0;

  /** Sets the corners (and the bounds and normal). */
  set(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): this {
    this.ax = ax; this.ay = ay; this.az = az;
    this.bx = bx; this.by = by; this.bz = bz;
    this.cx = cx; this.cy = cy; this.cz = cz;
    this.minX = Math.min(ax, bx, cx); this.minY = Math.min(ay, by, cy); this.minZ = Math.min(az, bz, cz);
    this.maxX = Math.max(ax, bx, cx); this.maxY = Math.max(ay, by, cy); this.maxZ = Math.max(az, bz, cz);
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length > 1e-12) {
      this.nx = nx / length; this.ny = ny / length; this.nz = nz / length;
    } else {
      this.nx = this.ny = this.nz = 0;
    }
    return this;
  }

  copyFrom(t: ClashTriangle, dx = 0, dy = 0, dz = 0): this {
    return this.set(t.ax - dx, t.ay - dy, t.az - dz, t.bx - dx, t.by - dy, t.bz - dz, t.cx - dx, t.cy - dy, t.cz - dz);
  }

  static make(a: Vec3, b: Vec3, c: Vec3): ClashTriangle {
    return new ClashTriangle().set(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }

  /** True when the triangle has no area. */
  get isDegenerate(): boolean { return this.nx === 0 && this.ny === 0 && this.nz === 0; }
}

/** The result of a crossing test: the shared segment p–q and whether it is a proper crossing. */
export class CrossResult {
  px = 0; py = 0; pz = 0;
  qx = 0; qy = 0; qz = 0;
  proper = false;
}

/** Closest points between two triangles (or segments): on the first (a) and on the second (b). */
export class ClosestResult {
  ax = 0; ay = 0; az = 0;
  bx = 0; by = 0; bz = 0;
}

const EPSILON = 1e-6;

// Scratch for the plane points
const PLANE = new Float64Array(6);
const PLANE2 = new Float64Array(6);
const CLOSE = { x: 0, y: 0, z: 0 };
const SEG = new ClosestResult();
const CROSS = new CrossResult();

/**
 * Clash geometry (port of BimGo.Core/Clashes/ClashGeometry.cs, Round C): triangle–triangle crossing with its segment,
 * triangle–triangle distance, point-in-solid. Own implementations of published methods: Möller's interval test for
 * triangle–triangle intersection (1997), closest points on a triangle and between segments (the standard region /
 * clamping formulas, as in Ericson, "Real-Time Collision Detection", 2005, ch. 5), Möller–Trumbore ray–triangle
 * intersection (1997) and the even–odd ray parity rule for inside tests. No allocations in the hot paths.
 */
export const ClashGeometry = {
  EPSILON,

  /**
   * True when two triangles meet across their planes (coplanar triangles only touch: never). The shared segment goes
   * to out (p–q), with proper = a real crossing (each has corners strictly on both sides of the other's plane).
   */
  crosses(t: ClashTriangle, u: ClashTriangle, out: CrossResult = CROSS): boolean {
    out.proper = false;
    if (t.isDegenerate || u.isDegenerate) { return false; }

    // t's corners against u's plane
    const a0 = snap(u.nx * (t.ax - u.ax) + u.ny * (t.ay - u.ay) + u.nz * (t.az - u.az));
    const a1 = snap(u.nx * (t.bx - u.ax) + u.ny * (t.by - u.ay) + u.nz * (t.bz - u.az));
    const a2 = snap(u.nx * (t.cx - u.ax) + u.ny * (t.cy - u.ay) + u.nz * (t.cz - u.az));
    if (sameSide(a0, a1, a2)) { return false; }
    if (a0 === 0 && a1 === 0 && a2 === 0) { return false; } // coplanar: touching, not crossing

    // u's corners against t's plane
    const b0 = snap(t.nx * (u.ax - t.ax) + t.ny * (u.ay - t.ay) + t.nz * (u.az - t.az));
    const b1 = snap(t.nx * (u.bx - t.ax) + t.ny * (u.by - t.ay) + t.nz * (u.bz - t.az));
    const b2 = snap(t.nx * (u.cx - t.ax) + t.ny * (u.cy - t.ay) + t.nz * (u.cz - t.az));
    if (sameSide(b0, b1, b2)) { return false; }
    if (b0 === 0 && b1 === 0 && b2 === 0) { return false; }

    // Where each triangle meets the other's plane, then their overlap on the common line
    if (!planePoints(t, a0, a1, a2, PLANE)) { return false; }
    if (!planePoints(u, b0, b1, b2, PLANE2)) { return false; }
    const dx = t.ny * u.nz - t.nz * u.ny, dy = t.nz * u.nx - t.nx * u.nz, dz = t.nx * u.ny - t.ny * u.nx;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 1e-12) { return false; }

    let t0 = 0, t1 = 3;
    let s0 = dx * PLANE[0] + dy * PLANE[1] + dz * PLANE[2], s1 = dx * PLANE[3] + dy * PLANE[4] + dz * PLANE[5];
    if (s1 < s0) { const s = s0; s0 = s1; s1 = s; t0 = 3; t1 = 0; }
    let u0 = 0, u1 = 3;
    let r0 = dx * PLANE2[0] + dy * PLANE2[1] + dz * PLANE2[2], r1 = dx * PLANE2[3] + dy * PLANE2[4] + dz * PLANE2[5];
    if (r1 < r0) { const r = r0; r0 = r1; r1 = r; u0 = 3; u1 = 0; }

    const slack = EPSILON * Math.max(1, Math.sqrt(d2));
    if (s0 > r1 + slack || r0 > s1 + slack) { return false; }
    const pFrom = s0 >= r0 ? PLANE : PLANE2, pIndex = s0 >= r0 ? t0 : u0;
    const qFrom = s1 <= r1 ? PLANE : PLANE2, qIndex = s1 <= r1 ? t1 : u1;
    out.px = pFrom[pIndex]; out.py = pFrom[pIndex + 1]; out.pz = pFrom[pIndex + 2];
    out.qx = qFrom[qIndex]; out.qy = qFrom[qIndex + 1]; out.qz = qFrom[qIndex + 2];
    out.proper = bothSides(a0, a1, a2) && bothSides(b0, b1, b2) && s1 - s0 > slack && r1 - r0 > slack && Math.min(s1, r1) - Math.max(s0, r0) > slack;
    return true;
  },

  /** The shortest distance between two triangles (0 when they cross or touch), with the closest points in out. */
  distance(t: ClashTriangle, u: ClashTriangle, out: ClosestResult): number {
    if (ClashGeometry.crosses(t, u, CROSS)) {
      out.ax = out.bx = (CROSS.px + CROSS.qx) * 0.5;
      out.ay = out.by = (CROSS.py + CROSS.qy) * 0.5;
      out.az = out.bz = (CROSS.pz + CROSS.qz) * 0.5;
      return 0;
    }
    const state = { best: Number.MAX_VALUE };
    // Corners against the other triangle
    corner(state, out, t.ax, t.ay, t.az, u, false);
    corner(state, out, t.bx, t.by, t.bz, u, false);
    corner(state, out, t.cx, t.cy, t.cz, u, false);
    corner(state, out, u.ax, u.ay, u.az, t, true);
    corner(state, out, u.bx, u.by, u.bz, t, true);
    corner(state, out, u.cx, u.cy, u.cz, t, true);
    // Edges against edges
    edgePair(state, out, t.ax, t.ay, t.az, t.bx, t.by, t.bz, u);
    edgePair(state, out, t.bx, t.by, t.bz, t.cx, t.cy, t.cz, u);
    edgePair(state, out, t.cx, t.cy, t.cz, t.ax, t.ay, t.az, u);
    return Math.sqrt(state.best);
  },

  /** The closest point of a triangle to a point (by the region the point projects into), written to out. */
  closestOnTriangle(px: number, py: number, pz: number, t: ClashTriangle, out: { x: number; y: number; z: number }): void {
    const ax = t.ax, ay = t.ay, az = t.az;
    const abx = t.bx - ax, aby = t.by - ay, abz = t.bz - az;
    const acx = t.cx - ax, acy = t.cy - ay, acz = t.cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { out.x = ax; out.y = ay; out.z = az; return; }

    const bpx = px - t.bx, bpy = py - t.by, bpz = pz - t.bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { out.x = t.bx; out.y = t.by; out.z = t.bz; return; }

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      out.x = ax + abx * v; out.y = ay + aby * v; out.z = az + abz * v;
      return;
    }

    const cpx = px - t.cx, cpy = py - t.cy, cpz = pz - t.cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { out.x = t.cx; out.y = t.cy; out.z = t.cz; return; }

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      out.x = ax + acx * w; out.y = ay + acy * w; out.z = az + acz * w;
      return;
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      out.x = t.bx + (t.cx - t.bx) * w; out.y = t.by + (t.cy - t.by) * w; out.z = t.bz + (t.cz - t.bz) * w;
      return;
    }

    const sum = va + vb + vc;
    if (Math.abs(sum) < 1e-20) { out.x = ax; out.y = ay; out.z = az; return; } // degenerate triangle
    const v = vb / sum, w = vc / sum;
    out.x = ax + abx * v + acx * w; out.y = ay + aby * v + acy * w; out.z = az + abz * v + acz * w;
  },

  /** The squared distance between two segments, with the closest points in out (a on the first, b on the second). */
  closestBetweenSegments(p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number,
    p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number, out: ClosestResult): number {
    const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
    const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
    const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
    const TINY = 1e-14;
    let s: number, t: number;
    if (a <= TINY && e <= TINY) {
      s = t = 0;
    } else if (a <= TINY) {
      s = 0;
      t = clamp01(f / e);
    } else {
      const c = d1x * rx + d1y * ry + d1z * rz;
      if (e <= TINY) {
        t = 0;
        s = clamp01(-c / a);
      } else {
        const b = d1x * d2x + d1y * d2y + d1z * d2z;
        const denom = a * e - b * b;
        s = denom > TINY ? clamp01((b * f - c * e) / denom) : 0;
        t = (b * s + f) / e;
        if (t < 0) {
          t = 0;
          s = clamp01(-c / a);
        } else if (t > 1) {
          t = 1;
          s = clamp01((b - c) / a);
        }
      }
    }
    out.ax = p1x + d1x * s; out.ay = p1y + d1y * s; out.az = p1z + d1z * s;
    out.bx = p2x + d2x * t; out.by = p2y + d2y * t; out.bz = p2z + d2z * t;
    const ex = out.ax - out.bx, ey = out.ay - out.by, ez = out.az - out.bz;
    return ex * ex + ey * ey + ez * ez;
  },

  /** True when a point is inside a closed mesh (even–odd along three skewed rays, two of three agreeing). */
  inside(px: number, py: number, pz: number, mesh: readonly ClashTriangle[], count = mesh.length): boolean {
    let votes = 0;
    if ((ClashGeometry.rayCrossings(px, py, pz, RAYS[0], mesh, count) & 1) === 1) { votes++; }
    if ((ClashGeometry.rayCrossings(px, py, pz, RAYS[1], mesh, count) & 1) === 1) { votes++; }
    if (votes === 1 && (ClashGeometry.rayCrossings(px, py, pz, RAYS[2], mesh, count) & 1) === 1) { votes++; }
    return votes >= 2;
  },

  /** The skewed ray directions inside() uses. */
  insideRay(index: number): Float64Array { return RAYS[Math.min(index, 2)]; },

  /** How many triangles a ray from a point crosses (in front of the point). */
  rayCrossings(ox: number, oy: number, oz: number, direction: Float64Array, mesh: readonly ClashTriangle[], count = mesh.length): number {
    let hits = 0;
    for (let i = 0; i < count; i++) { if (ClashGeometry.rayHits(ox, oy, oz, direction[0], direction[1], direction[2], mesh[i])) { hits++; } }
    return hits;
  },

  /** True when a ray from the origin along the direction crosses a triangle in front of the origin (Möller–Trumbore). */
  rayHits(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, t: ClashTriangle): boolean {
    const e1x = t.bx - t.ax, e1y = t.by - t.ay, e1z = t.bz - t.az;
    const e2x = t.cx - t.ax, e2y = t.cy - t.ay, e2z = t.cz - t.az;
    const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-14) { return false; }
    const inv = 1 / det;
    const sx = ox - t.ax, sy = oy - t.ay, sz = oz - t.az;
    const u = (sx * hx + sy * hy + sz * hz) * inv;
    if (u < 0 || u > 1) { return false; }
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) { return false; }
    return (e2x * qx + e2y * qy + e2z * qz) * inv > EPSILON;
  }
};

// Three slightly skewed directions, so a ray rarely runs exactly along an edge or a face of axis-aligned geometry
const RAYS = [normalised(0.0131, 0.0217, 1), normalised(1, 0.0173, 0.0291), normalised(0.0237, 1, 0.0119)];

function normalised(x: number, y: number, z: number): Float64Array {
  const l = Math.sqrt(x * x + y * y + z * z);
  return new Float64Array([x / l, y / l, z / l]);
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function snap(distance: number): number { return Math.abs(distance) < EPSILON ? 0 : distance; }

function sameSide(a: number, b: number, c: number): boolean { return (a > 0 && b > 0 && c > 0) || (a < 0 && b < 0 && c < 0); }

function bothSides(a: number, b: number, c: number): boolean { return Math.max(a, b, c) > 0 && Math.min(a, b, c) < 0; }

/** The (up to two) points where a triangle meets a plane, from its corners' signed distances (out: two points). */
function planePoints(t: ClashTriangle, d0: number, d1: number, d2: number, out: Float64Array): boolean {
  let count = 0;
  const add = (x: number, y: number, z: number) => {
    if (count < 2) { out[count * 3] = x; out[count * 3 + 1] = y; out[count * 3 + 2] = z; }
    count++;
  };
  if (d0 === 0) { add(t.ax, t.ay, t.az); }
  if (d1 === 0) { add(t.bx, t.by, t.bz); }
  if (d2 === 0) { add(t.cx, t.cy, t.cz); }
  if (d0 * d1 < 0) { const k = d0 / (d0 - d1); add(t.ax + (t.bx - t.ax) * k, t.ay + (t.by - t.ay) * k, t.az + (t.bz - t.az) * k); }
  if (d1 * d2 < 0) { const k = d1 / (d1 - d2); add(t.bx + (t.cx - t.bx) * k, t.by + (t.cy - t.by) * k, t.bz + (t.cz - t.bz) * k); }
  if (d2 * d0 < 0) { const k = d2 / (d2 - d0); add(t.cx + (t.ax - t.cx) * k, t.cy + (t.ay - t.cy) * k, t.cz + (t.az - t.cz) * k); }
  if (count === 1) { out[3] = out[0]; out[4] = out[1]; out[5] = out[2]; }
  return count > 0;
}

function corner(state: { best: number }, out: ClosestResult, px: number, py: number, pz: number, other: ClashTriangle, cornerOnU: boolean): void {
  ClashGeometry.closestOnTriangle(px, py, pz, other, CLOSE);
  const ex = px - CLOSE.x, ey = py - CLOSE.y, ez = pz - CLOSE.z;
  const d = ex * ex + ey * ey + ez * ez;
  if (d >= state.best) { return; }
  state.best = d;
  if (cornerOnU) {
    out.bx = px; out.by = py; out.bz = pz;
    out.ax = CLOSE.x; out.ay = CLOSE.y; out.az = CLOSE.z;
  } else {
    out.ax = px; out.ay = py; out.az = pz;
    out.bx = CLOSE.x; out.by = CLOSE.y; out.bz = CLOSE.z;
  }
}

function edgePair(state: { best: number }, out: ClosestResult, px: number, py: number, pz: number, qx: number, qy: number, qz: number, u: ClashTriangle): void {
  segments(state, out, px, py, pz, qx, qy, qz, u.ax, u.ay, u.az, u.bx, u.by, u.bz);
  segments(state, out, px, py, pz, qx, qy, qz, u.bx, u.by, u.bz, u.cx, u.cy, u.cz);
  segments(state, out, px, py, pz, qx, qy, qz, u.cx, u.cy, u.cz, u.ax, u.ay, u.az);
}

function segments(state: { best: number }, out: ClosestResult, p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number,
  p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number): void {
  const d = ClashGeometry.closestBetweenSegments(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z, SEG);
  if (d < state.best) {
    state.best = d;
    out.ax = SEG.ax; out.ay = SEG.ay; out.az = SEG.az;
    out.bx = SEG.bx; out.by = SEG.by; out.bz = SEG.bz;
  }
}
