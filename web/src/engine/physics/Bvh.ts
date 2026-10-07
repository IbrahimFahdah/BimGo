import { type Vec3, vec3 } from '../../core/math/Vector';
import { SCENE_VERTEX_WORDS, type SceneData } from '../../core/scene/SceneData';
import { rayAabb, rayTriangle, reciprocal } from './GeoMath';

/** A ray hit (port of RayHit). */
export interface RayHit {
  distance: number;
  point: Vec3;
  /** Unit face normal, facing the ray. */
  normal: Vec3;
  element: number;
  /** Moved / cloned instance id, or 0 for the static scene. */
  dynamicId: number;
}

/**
 * A bounding volume hierarchy over the scene's triangles for collision and picking (port of
 * BimGo.App/Physics/Bvh.cs): median split on the longest centroid axis, leaves of up to 4 triangles.
 * Stored flat: triangles as 9 floats each (in leaf order) with their element, nodes as 6 floats of bounds plus
 * first / count (count 0 = inner node whose children are first and first + 1).
 */
export class Bvh {
  private static readonly LEAF_SIZE = 4;

  /** Triangle corners, 9 floats per triangle, in leaf order. */
  readonly triangles: Float32Array;
  /** The element index of each triangle. */
  readonly triangleElement: Int32Array;
  readonly nodeCount: number;
  private readonly nodeBounds: Float32Array;
  private readonly nodeFirst: Int32Array;
  private readonly nodeTriangles: Int32Array;
  private readonly stack = new Int32Array(256);

  /** Results of the last {@link query} (triangle indices); grows as needed. */
  results = new Int32Array(512);

  constructor(scene: SceneData) {
    const floats = scene.geometry.floats;
    const indices = scene.geometry.indices;
    const elements = scene.elements;

    // Gather triangles element by element so each knows its owner
    const maxTriangles = Math.trunc(indices.length / 3);
    const corners = new Float32Array(maxTriangles * 9);
    const owner = new Int32Array(maxTriangles);
    let count = 0;
    const addRange = (start: number, length: number, element: number) => {
      for (let i = start; i + 2 < start + length; i += 3) {
        const o = count * 9;
        for (let k = 0; k < 3; k++) {
          const v = indices[i + k] * SCENE_VERTEX_WORDS;
          corners[o + k * 3] = floats[v];
          corners[o + k * 3 + 1] = floats[v + 1];
          corners[o + k * 3 + 2] = floats[v + 2];
        }
        owner[count++] = element;
      }
    };
    elements.forEach((record, e) => {
      addRange(record.opaqueStart, record.opaqueCount, e);
      addRange(record.transparentStart, record.transparentCount, e);
    });

    // Build
    const centroids = new Float32Array(count * 3);
    const order = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * 9;
      centroids[i * 3] = (corners[o] + corners[o + 3] + corners[o + 6]) / 3;
      centroids[i * 3 + 1] = (corners[o + 1] + corners[o + 4] + corners[o + 7]) / 3;
      centroids[i * 3 + 2] = (corners[o + 2] + corners[o + 5] + corners[o + 8]) / 3;
      order[i] = i;
    }

    const capacity = Math.max(1, 2 * count);
    const nodeBounds = new Float32Array(capacity * 6);
    const nodeFirst = new Int32Array(capacity);
    const nodeTriangles = new Int32Array(capacity);
    let nodeCount = 1;
    nodeFirst[0] = 0;
    nodeTriangles[0] = count;

    const work: number[] = [0];
    while (work.length > 0) {
      const node = work.pop()!;
      const first = nodeFirst[node], n = nodeTriangles[node];

      // Bounds
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity, cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
      for (let i = first; i < first + n; i++) {
        const t = order[i], o = t * 9;
        for (let k = 0; k < 9; k += 3) {
          const x = corners[o + k], y = corners[o + k + 1], z = corners[o + k + 2];
          if (x < minX) { minX = x; } if (x > maxX) { maxX = x; }
          if (y < minY) { minY = y; } if (y > maxY) { maxY = y; }
          if (z < minZ) { minZ = z; } if (z > maxZ) { maxZ = z; }
        }
        const cx = centroids[t * 3], cy = centroids[t * 3 + 1], cz = centroids[t * 3 + 2];
        if (cx < cMinX) { cMinX = cx; } if (cx > cMaxX) { cMaxX = cx; }
        if (cy < cMinY) { cMinY = cy; } if (cy > cMaxY) { cMaxY = cy; }
        if (cz < cMinZ) { cMinZ = cz; } if (cz > cMaxZ) { cMaxZ = cz; }
      }
      if (n === 0) { minX = minY = minZ = maxX = maxY = maxZ = 0; }
      nodeBounds.set([minX, minY, minZ, maxX, maxY, maxZ], node * 6);

      if (n <= Bvh.LEAF_SIZE) { continue; }

      const ex = cMaxX - cMinX, ey = cMaxY - cMinY, ez = cMaxZ - cMinZ;
      const axis = ex > ey ? (ex > ez ? 0 : 2) : (ey > ez ? 1 : 2);
      if ((axis === 0 ? ex : axis === 1 ? ey : ez) < 1e-6) { continue; }

      const mid = first + (n >> 1);
      nthElement(order, centroids, axis, first, first + n - 1, mid);

      const left = nodeCount;
      nodeCount += 2;
      nodeFirst[left] = first;
      nodeTriangles[left] = mid - first;
      nodeFirst[left + 1] = mid;
      nodeTriangles[left + 1] = first + n - mid;
      nodeFirst[node] = left;
      nodeTriangles[node] = 0;

      work.push(left, left + 1);
    }
    this.nodeCount = nodeCount;
    this.nodeBounds = nodeBounds;
    this.nodeFirst = nodeFirst;
    this.nodeTriangles = nodeTriangles;

    // Re-order triangles to match leaf ranges
    this.triangles = new Float32Array(count * 9);
    this.triangleElement = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      this.triangles.set(corners.subarray(order[i] * 9, order[i] * 9 + 9), i * 9);
      this.triangleElement[i] = owner[order[i]];
    }
  }

  get triangleCount(): number {
    return this.triangleElement.length;
  }

  // #region Queries

  /**
   * Collects the triangles whose leaf boxes overlap a box into {@link results}; skips elements whose mask entry is
   * false. Returns the count.
   */
  query(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, mask: boolean[] | null): number {
    if (this.triangleElement.length === 0) { return 0; }
    const nb = this.nodeBounds, stack = this.stack;
    let found = 0, top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top], o = node * 6;
      if (nb[o + 3] < minX || nb[o] > maxX || nb[o + 4] < minY || nb[o + 1] > maxY || nb[o + 5] < minZ || nb[o + 2] > maxZ) { continue; }

      const n = this.nodeTriangles[node], first = this.nodeFirst[node];
      if (n > 0) {
        for (let i = first; i < first + n; i++) {
          if (mask && !mask[this.triangleElement[i]]) { continue; }
          if (found === this.results.length) {
            const bigger = new Int32Array(this.results.length * 2);
            bigger.set(this.results);
            this.results = bigger;
          }
          this.results[found++] = i;
        }
      } else if (top + 2 <= stack.length) {
        stack[top++] = first;
        stack[top++] = first + 1;
      }
    }
    return found;
  }

  /** Nearest hit along a ray within maxDistance, skipping masked-out elements; null when nothing is hit. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, mask: boolean[] | null): RayHit | null {
    if (this.triangleElement.length === 0) { return null; }
    const ox = origin.x, oy = origin.y, oz = origin.z, dx = direction.x, dy = direction.y, dz = direction.z;
    const ix = reciprocal(dx), iy = reciprocal(dy), iz = reciprocal(dz);
    const nb = this.nodeBounds, tris = this.triangles, stack = this.stack;
    let best = maxDistance;
    let bestTriangle = -1;

    const enter = (node: number, limit: number) => {
      const o = node * 6;
      return rayAabb(ox, oy, oz, ix, iy, iz, nb[o], nb[o + 1], nb[o + 2], nb[o + 3], nb[o + 4], nb[o + 5], limit);
    };

    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top];
      if (enter(node, best) < 0) { continue; }

      const n = this.nodeTriangles[node], first = this.nodeFirst[node];
      if (n > 0) {
        for (let i = first; i < first + n; i++) {
          if (mask && !mask[this.triangleElement[i]]) { continue; }
          const t = rayTriangle(ox, oy, oz, dx, dy, dz, tris, i * 9, best);
          if (t > 1e-4) {
            best = t;
            bestTriangle = i;
          }
        }
      } else if (top + 2 <= stack.length) {
        // Visit the nearer child first
        const left = first, right = first + 1;
        const tl = enter(left, best), tr = enter(right, best);
        if (tl >= 0 && tr >= 0) {
          if (tl <= tr) { stack[top++] = right; stack[top++] = left; }
          else { stack[top++] = left; stack[top++] = right; }
        } else if (tl >= 0) { stack[top++] = left; }
        else if (tr >= 0) { stack[top++] = right; }
      }
    }

    if (bestTriangle < 0) { return null; }

    const o = bestTriangle * 9;
    const e1x = tris[o + 3] - tris[o], e1y = tris[o + 4] - tris[o + 1], e1z = tris[o + 5] - tris[o + 2];
    const e2x = tris[o + 6] - tris[o], e2y = tris[o + 7] - tris[o + 1], e2z = tris[o + 8] - tris[o + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }

    return {
      distance: best,
      point: vec3(ox + dx * best, oy + dy * best, oz + dz * best),
      normal: vec3(nx, ny, nz),
      element: this.triangleElement[bestTriangle],
      dynamicId: 0
    };
  }

  // #endregion
}

/** Hoare-partition quickselect on the centroid axis (same as the desktop's NthElement). */
function nthElement(order: Int32Array, centroids: Float32Array, axis: number, left: number, right: number, nth: number): void {
  while (right > left) {
    const pivot = centroids[order[(left + right) >> 1] * 3 + axis];
    let i = left, j = right;
    while (i <= j) {
      while (centroids[order[i] * 3 + axis] < pivot) { i++; }
      while (centroids[order[j] * 3 + axis] > pivot) { j--; }
      if (i <= j) {
        const t = order[i]; order[i] = order[j]; order[j] = t;
        i++;
        j--;
      }
    }
    if (nth <= j) { right = j; }
    else if (nth >= i) { left = i; }
    else { return; }
  }
}
