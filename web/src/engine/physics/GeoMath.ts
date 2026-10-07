/**
 * Geometry queries for collision and picking (port of BimGo.App/Physics/GeoMath.cs), allocation-free: points are
 * passed as numbers, triangles as 9 consecutive floats in an array (ax ay az bx by bz cx cy cz), and results go to
 * caller-supplied buffers. The physics runs thousands of these per tick, so no Vector3 objects are created here.
 */

const EPSILON = 1e-9;

/** Closest point on triangle T[o..o+8] to p, written to out[k..k+2]. */
export function closestPointOnTriangle(px: number, py: number, pz: number, T: ArrayLike<number>, o: number, out: Float64Array, k: number): void {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
  const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[k] = ax; out[k + 1] = ay; out[k + 2] = az; return; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[k] = bx; out[k + 1] = by; out[k + 2] = bz; return; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[k] = ax + v * abx; out[k + 1] = ay + v * aby; out[k + 2] = az + v * abz;
    return;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[k] = cx; out[k + 1] = cy; out[k + 2] = cz; return; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[k] = ax + w * acx; out[k + 1] = ay + w * acy; out[k + 2] = az + w * acz;
    return;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[k] = bx + w * (cx - bx); out[k + 1] = by + w * (cy - by); out[k + 2] = bz + w * (cz - bz);
    return;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out[k] = ax + abx * v + acx * w;
  out[k + 1] = ay + aby * v + acy * w;
  out[k + 2] = az + abz * v + acz * w;
}

/**
 * Closest points between segments p1q1 and p2q2 (Ericson). Writes c1 to out[0..2], c2 to out[3..5]; returns the squared
 * distance.
 */
export function closestSegmentSegment(
  p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number,
  p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number, out: Float64Array): number {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s: number, t: number;

  if (a <= EPSILON && e <= EPSILON) {
    s = 0; t = 0;
  } else if (a <= EPSILON) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPSILON) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
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

  out[0] = p1x + d1x * s; out[1] = p1y + d1y * s; out[2] = p1z + d1z * s;
  out[3] = p2x + d2x * t; out[4] = p2y + d2y * t; out[5] = p2z + d2z * t;
  const dx = out[0] - out[3], dy = out[1] - out[4], dz = out[2] - out[5];
  return dx * dx + dy * dy + dz * dz;
}

const point = new Float64Array(3);
const pair = new Float64Array(6);

/**
 * Closest points between segment pq and triangle T[o..o+8]. Writes the point on the segment to out[0..2] and on the
 * triangle to out[3..5]; returns the squared distance (0 when the segment pierces the triangle).
 */
export function closestSegmentTriangle(px: number, py: number, pz: number, qx: number, qy: number, qz: number,
  T: ArrayLike<number>, o: number, out: Float64Array): number {
  // Piercing
  const dx = qx - px, dy = qy - py, dz = qz - pz;
  const hitT = rayTriangle(px, py, pz, dx, dy, dz, T, o, 1);
  if (hitT >= 0) {
    out[0] = out[3] = px + dx * hitT;
    out[1] = out[4] = py + dy * hitT;
    out[2] = out[5] = pz + dz * hitT;
    return 0;
  }

  // Segment end points against the face
  closestPointOnTriangle(px, py, pz, T, o, point, 0);
  let best = sq(px - point[0], py - point[1], pz - point[2]);
  out[0] = px; out[1] = py; out[2] = pz; out[3] = point[0]; out[4] = point[1]; out[5] = point[2];

  closestPointOnTriangle(qx, qy, qz, T, o, point, 0);
  const dq = sq(qx - point[0], qy - point[1], qz - point[2]);
  if (dq < best) { best = dq; out[0] = qx; out[1] = qy; out[2] = qz; out[3] = point[0]; out[4] = point[1]; out[5] = point[2]; }

  // Segment against each edge
  for (let edge = 0; edge < 3; edge++) {
    const s = o + edge * 3, e = o + ((edge + 1) % 3) * 3;
    const d = closestSegmentSegment(px, py, pz, qx, qy, qz, T[s], T[s + 1], T[s + 2], T[e], T[e + 1], T[e + 2], pair);
    if (d < best) { best = d; out.set(pair); }
  }
  return best;
}

/**
 * Möller–Trumbore ray / triangle test against T[o..o+8]. Returns the hit distance t in [0, tMax] (in units of the
 * direction's length), or −1 for a miss.
 */
export function rayTriangle(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  T: ArrayLike<number>, o: number, tMax: number): number {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const e1x = T[o + 3] - ax, e1y = T[o + 4] - ay, e1z = T[o + 5] - az;
  const e2x = T[o + 6] - ax, e2y = T[o + 7] - ay, e2z = T[o + 8] - az;
  const pvx = dy * e2z - dz * e2y, pvy = dz * e2x - dx * e2z, pvz = dx * e2y - dy * e2x;
  const det = e1x * pvx + e1y * pvy + e1z * pvz;
  if (Math.abs(det) < 1e-12) { return -1; }

  const inv = 1 / det;
  const tvx = ox - ax, tvy = oy - ay, tvz = oz - az;
  const u = (tvx * pvx + tvy * pvy + tvz * pvz) * inv;
  if (u < 0 || u > 1) { return -1; }

  const qvx = tvy * e1z - tvz * e1y, qvy = tvz * e1x - tvx * e1z, qvz = tvx * e1y - tvy * e1x;
  const v = (dx * qvx + dy * qvy + dz * qvz) * inv;
  if (v < 0 || u + v > 1) { return -1; }

  const t = (e2x * qvx + e2y * qvy + e2z * qvz) * inv;
  return t >= 0 && t <= tMax ? t : -1;
}

/**
 * Slab test of a ray (with reciprocal direction) against a box. Returns the entry distance, or −1 for a miss.
 */
export function rayAabb(ox: number, oy: number, oz: number, ix: number, iy: number, iz: number,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, tMax: number): number {
  const t0x = (minX - ox) * ix, t1x = (maxX - ox) * ix;
  const t0y = (minY - oy) * iy, t1y = (maxY - oy) * iy;
  const t0z = (minZ - oz) * iz, t1z = (maxZ - oz) * iz;
  const tNear = Math.max(Math.max(Math.min(t0x, t1x), Math.min(t0y, t1y)), Math.max(Math.min(t0z, t1z), 0));
  const tFar = Math.min(Math.min(Math.max(t0x, t1x), Math.max(t0y, t1y)), Math.min(Math.max(t0z, t1z), tMax));
  return tNear <= tFar ? tNear : -1;
}

/** 1 / d per component, with a large signed value for (near) zero. */
export function reciprocal(d: number): number {
  return Math.abs(d) > 1e-12 ? 1 / d : 1e12 * Math.sign(d === 0 ? 1 : d);
}

function sq(x: number, y: number, z: number): number {
  return x * x + y * y + z * z;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
