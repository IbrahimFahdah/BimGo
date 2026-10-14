import { type Vec3, vec3 } from '../math/Vector';
import { Aabb } from '../scene/SceneData';

/** Where GO puts the camera and the section box for a clash (scene-local). */
export interface ClashView {
  section: Aabb;
  eye: Vec3;
  /** Radians, 0 = +X, CCW. */
  yaw: number;
  /** Radians, negative looks down. */
  pitch: number;
}

/**
 * Framing a clash (port of BimGo.Core/Clashes/ClashFraming.cs, Round C-B): the section box around the clash region and
 * a camera about 2.5 m back, looking at the clash point from the side that sees it best. Pure maths; the caller
 * supplies a line-of-sight test.
 */
export const ClashFraming = {
  /** The section box margin around the clash region (metres). */
  MARGIN: 1,
  /** The section box's smallest size along any axis (metres). */
  MIN_SIZE: 2,
  /** How far back the camera stands (metres). */
  DISTANCE: 2.5,
  /** How far the camera looks down at the clash (radians, 20°). */
  DOWN_PITCH: 0.349,

  /**
   * The section box for a clash: where the two elements' boxes meet (a gap for clearance clashes), with the point
   * included, grown by the margin and at least MIN_SIZE along every axis.
   */
  sectionFor(a: Aabb, b: Aabb, point: Vec3, margin = 1): Aabb {
    const gx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
    const gy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
    const gz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
    const reach = Math.max(gx, gy, gz) * 0.5 + 0.01;
    let region = new Aabb(
      vec3(Math.max(a.min.x, b.min.x) - reach, Math.max(a.min.y, b.min.y) - reach, Math.max(a.min.z, b.min.z) - reach),
      vec3(Math.min(a.max.x, b.max.x) + reach, Math.min(a.max.y, b.max.y) + reach, Math.min(a.max.z, b.max.z) + reach));
    if (!(region.min.x <= region.max.x && region.min.y <= region.max.y && region.min.z <= region.max.z)) { region = new Aabb(vec3(point.x, point.y, point.z), vec3(point.x, point.y, point.z)); }
    region.includePoint(point);

    const min = vec3(region.min.x - margin, region.min.y - margin, region.min.z - margin);
    const max = vec3(region.max.x + margin, region.max.y + margin, region.max.z + margin);
    const half = ClashFraming.MIN_SIZE * 0.5;
    const cx = (min.x + max.x) * 0.5, cy = (min.y + max.y) * 0.5, cz = (min.z + max.z) * 0.5;
    const hx = Math.max((max.x - min.x) * 0.5, half), hy = Math.max((max.y - min.y) * 0.5, half), hz = Math.max((max.z - min.z) * 0.5, half);
    return new Aabb(vec3(cx - hx, cy - hy, cz - hz), vec3(cx + hx, cy + hy, cz + hz));
  },

  /**
   * The camera for a clash: eight directions around the point (looking down 20°), scored by a clear line of sight, the
   * eye outside both elements' boxes, looking across the elements' long axes, then the smallest turn from currentYaw.
   */
  frame(point: Vec3, a: Aabb, b: Aabb, section: Aabb, currentYaw: number, clear: ((eye: Vec3, target: Vec3) => boolean) | null = null,
    distance = 2.5): ClashView {
    const axisA = ClashFraming.longAxis(a), axisB = ClashFraming.longAxis(b);
    const cp = Math.cos(ClashFraming.DOWN_PITCH), sp = Math.sin(ClashFraming.DOWN_PITCH);
    let bestScore = -Infinity;
    let best: ClashView = { section, eye: point, yaw: 0, pitch: -ClashFraming.DOWN_PITCH };
    for (let k = 0; k < 8; k++) {
      const yaw = k * Math.PI / 4;
      const lx = cp * Math.cos(yaw), ly = cp * Math.sin(yaw), lz = -sp;
      const eye = vec3(point.x - lx * distance, point.y - ly * distance, point.z - lz * distance);

      let score = 0;
      if (!clear || clear(eye, point)) { score += 4; }
      if (!contains(a, eye) && !contains(b, eye)) { score += 2; }
      score += 1 - 0.5 * (Math.abs(lx * axisA.x + ly * axisA.y) + Math.abs(lx * axisB.x + ly * axisB.y));
      score -= 0.1 * Math.abs(ClashFraming.angleBetween(yaw, currentYaw)) / Math.PI;
      if (score > bestScore) {
        bestScore = score;
        best = { section, eye, yaw: ClashFraming.normaliseYaw(yaw), pitch: -ClashFraming.DOWN_PITCH };
      }
    }
    return best;
  },

  /** How far back to stand to see a whole box (several clashes framed together), never closer than DISTANCE. */
  distanceToSee(box: Aabb, horizontalFovDegrees: number, aspect: number): number {
    if (!box.isValid) { return ClashFraming.DISTANCE; }
    const s = box.size;
    const radius = Math.hypot(s.x, s.y, s.z) * 0.5;
    const halfH = Math.min(Math.max(horizontalFovDegrees, 20), 150) * Math.PI / 360;
    const halfV = Math.atan(Math.tan(halfH) / Math.max(aspect, 0.1));
    return Math.max(ClashFraming.DISTANCE, radius / Math.sin(Math.min(halfH, halfV)) * 1.05);
  },

  /** The horizontal unit axis a box is longest along (zero for a box longest vertically). */
  longAxis(box: Aabb): Vec3 {
    const s = box.size;
    if (s.z >= s.x && s.z >= s.y) { return vec3(); }
    return s.x >= s.y ? vec3(1, 0, 0) : vec3(0, 1, 0);
  },

  /** The signed smallest angle from `from` to `to` (radians, −π..π). */
  angleBetween(to: number, from: number): number {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) { d -= Math.PI * 2; }
    if (d < -Math.PI) { d += Math.PI * 2; }
    return d;
  },

  normaliseYaw(yaw: number): number {
    return ClashFraming.angleBetween(yaw, 0);
  }
};

function contains(box: Aabb, p: Vec3): boolean {
  return p.x >= box.min.x && p.x <= box.max.x && p.y >= box.min.y && p.y <= box.max.y && p.z >= box.min.z && p.z <= box.max.z;
}
