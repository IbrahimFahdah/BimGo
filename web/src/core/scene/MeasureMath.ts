import { type Vec3, Vec3 as V, vec3 } from '../math/Vector';

/**
 * Geometry behind the Measure gun's modes (port of BimGo.Core/Scene/MeasureMath.cs): planar polygon area and
 * perimeter, the angle at a vertex, and a triangulation of a (possibly concave) polygon for drawing its fill.
 */
export const MeasureMath = {
  /** Two unit axes spanning the plane with this normal (u × v = normal). */
  planeAxes(normal: Vec3): { u: Vec3; v: Vec3 } {
    const n = V.lengthSquared(normal) > 1e-12 ? V.normalize(normal) : vec3(0, 0, 1);
    const helper = Math.abs(n.z) < 0.9 ? vec3(0, 0, 1) : vec3(1, 0, 0);
    const u = V.normalize(V.cross(helper, n));
    return { u, v: V.cross(n, u) };
  },

  /** Where a ray meets a plane (only in front of the origin), or null when parallel or behind. */
  rayPlane(origin: Vec3, direction: Vec3, planePoint: Vec3, planeNormal: Vec3): Vec3 | null {
    const denominator = V.dot(direction, planeNormal);
    if (Math.abs(denominator) < 1e-6) { return null; }
    const t = V.dot(V.sub(planePoint, origin), planeNormal) / denominator;
    if (t < 0 || !Number.isFinite(t)) { return null; }
    return V.add(origin, V.scale(direction, t));
  },

  /** Projects a point onto a plane. */
  projectToPlane(point: Vec3, planePoint: Vec3, planeNormal: Vec3): Vec3 {
    const n = V.normalize(planeNormal);
    return V.sub(point, V.scale(n, V.dot(V.sub(point, planePoint), n)));
  },

  /**
   * The area of a closed planar polygon (points in order, the closing edge implied), measured in the plane with the
   * given normal. Self-intersecting outlines give the net area.
   */
  polygonArea(points: readonly Vec3[], normal: Vec3): number {
    if (points.length < 3) { return 0; }
    const { u, v } = MeasureMath.planeAxes(normal);
    const origin = points[0];
    let twice = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = V.sub(points[j], origin), b = V.sub(points[i], origin);
      twice += V.dot(a, u) * V.dot(b, v) - V.dot(b, u) * V.dot(a, v);
    }
    return Math.abs(twice) * 0.5;
  },

  /** The length of a polygon's outline (closed: the last point joins the first) or of a polyline. */
  perimeter(points: readonly Vec3[], closed = true): number {
    if (points.length < 2) { return 0; }
    let length = 0;
    for (let i = 1; i < points.length; i++) { length += V.distance(points[i - 1], points[i]); }
    if (closed && points.length > 2) { length += V.distance(points[points.length - 1], points[0]); }
    return length;
  },

  /** The angle A–vertex–B in degrees (0–180), or NaN when either arm has no length. */
  angleDegrees(a: Vec3, vertex: Vec3, b: Vec3): number {
    const p = V.sub(a, vertex), q = V.sub(b, vertex);
    const lp = V.length(p), lq = V.length(q);
    if (lp < 1e-6 || lq < 1e-6) { return NaN; }
    const cos = Math.min(Math.max(V.dot(p, q) / (lp * lq), -1), 1);
    return Math.acos(cos) * 180 / Math.PI;
  },

  /**
   * Triangulates a simple planar polygon (convex or concave, either winding) by ear clipping in the plane with the
   * given normal. Writes index triples into `triangles` (cleared first).
   * @returns False when the outline is degenerate or self-intersecting (a fan is written instead).
   */
  triangulate(points: readonly Vec3[], normal: Vec3, triangles: number[]): boolean {
    triangles.length = 0;
    const n = points.length;
    if (n < 3) { return false; }

    const { u, v } = MeasureMath.planeAxes(normal);
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = V.sub(points[i], points[0]);
      xs[i] = Math.fround(V.dot(d, u));
      ys[i] = Math.fround(V.dot(d, v));
    }

    // Work counter-clockwise
    let signedArea = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) { signedArea += xs[j] * ys[i] - xs[i] * ys[j]; }
    const remaining: number[] = [];
    if (signedArea >= 0) { for (let i = 0; i < n; i++) { remaining.push(i); } }
    else { for (let i = n - 1; i >= 0; i--) { remaining.push(i); } }

    const cross = (a: number, b: number, c: number) => (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
    const crossPoint = (a: number, b: number, p: number) => (xs[b] - xs[a]) * (ys[p] - ys[a]) - (ys[b] - ys[a]) * (xs[p] - xs[a]);
    const inTriangle = (p: number, a: number, b: number, c: number) => crossPoint(a, b, p) >= 0 && crossPoint(b, c, p) >= 0 && crossPoint(c, a, p) >= 0;

    let guard = n * n + 8;
    while (remaining.length > 3 && guard-- > 0) {
      let clipped = false;
      for (let k = 0; k < remaining.length; k++) {
        const ia = remaining[(k + remaining.length - 1) % remaining.length];
        const ib = remaining[k];
        const ic = remaining[(k + 1) % remaining.length];
        if (cross(ia, ib, ic) <= 1e-12) { continue; } // reflex or flat

        let inside = false;
        for (const ip of remaining) {
          if (ip === ia || ip === ib || ip === ic) { continue; }
          if (inTriangle(ip, ia, ib, ic)) { inside = true; break; }
        }
        if (inside) { continue; }

        triangles.push(ia, ib, ic);
        remaining.splice(k, 1);
        clipped = true;
        break;
      }
      if (!clipped) { break; }
    }

    if (remaining.length === 3) {
      triangles.push(remaining[0], remaining[1], remaining[2]);
      return true;
    }

    // Self-intersecting or degenerate: a fan still shows roughly where the area is
    triangles.length = 0;
    for (let i = 1; i < n - 1; i++) { triangles.push(0, i, i + 1); }
    return false;
  }
};
