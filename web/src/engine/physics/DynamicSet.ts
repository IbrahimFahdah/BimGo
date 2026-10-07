import { type Matrix4x4, Mat4 } from '../../core/math/Matrix4x4';
import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import { Aabb, type ElementRecord } from '../../core/scene/SceneData';
import { SceneBatches } from '../render/SceneBatches';
import type { Bvh, RayHit } from './Bvh';
import { rayAabb, reciprocal } from './GeoMath';

/**
 * A moved original or a clone of a static element (port of DynamicInstance): drawn and collided through its transform
 * (move by offset, rotate about Z around the element's pivot).
 */
export class DynamicInstance {
  offset: Vec3 = vec3();
  angle = 0;
  model: Matrix4x4 = Mat4.identity();
  inverseModel: Matrix4x4 = Mat4.identity();
  worldBounds: Aabb = Aabb.empty();
  /** Revit element id (originals, and clones once Revit created them); 0 for an uncommitted / file-only clone. */
  revitId: number;
  /** Clones: false until RMB commits them. */
  committed: boolean;
  /** Demolished / deleted. */
  hidden = false;

  constructor(
    readonly id: number,
    readonly element: number,
    readonly basePivot: Vec3,
    readonly isClone: boolean,
    readonly cloneKey: number,
    revitId: number
  ) {
    this.revitId = revitId;
    this.committed = !isClone;
  }

  get pivot(): Vec3 { return V.add(this.basePivot, this.offset); }

  setTransform(offset: Vec3, angle: number, sourceBounds: Aabb): void {
    this.offset = V.copy(offset);
    this.angle = angle;
    this.model = Mat4.multiply(Mat4.multiply(Mat4.createTranslation(V.scale(this.basePivot, -1)), Mat4.createRotationZ(angle)),
      Mat4.createTranslation(V.add(this.basePivot, offset)));
    this.inverseModel = Mat4.invert(this.model) ?? Mat4.identity();
    this.worldBounds = transformBounds(sourceBounds, this.model);
  }
}

export function transformBounds(box: Aabb, m: Matrix4x4): Aabb {
  const result = Aabb.empty();
  for (let i = 0; i < 8; i++) {
    result.includePoint(Mat4.transformPoint(vec3((i & 1) === 0 ? box.min.x : box.max.x, (i & 2) === 0 ? box.min.y : box.max.y,
      (i & 4) === 0 ? box.min.z : box.max.z), m));
  }
  return result;
}

/**
 * The moved and cloned elements (port of BimGo.App/Physics/DynamicSet.cs): picking and collision go through each
 * instance's transform into the static BVH, restricted to its source element.
 */
export class DynamicSet {
  readonly instances: DynamicInstance[] = [];
  private readonly solo: boolean[];
  private nextId = 1;
  /** Triangles collected by the last {@link collectTriangles} (9 floats each). */
  triangles = new Float32Array(256 * 9);

  constructor(private readonly bvh: Bvh, private readonly elements: ElementRecord[], private readonly groupVisible: boolean[]) {
    this.solo = new Array<boolean>(elements.length).fill(false);
  }

  create(element: number, offset: Vec3, angle: number, revitId: number, isClone: boolean, cloneKey: number): DynamicInstance {
    const instance = new DynamicInstance(this.nextId++, element, this.elements[element].pivot, isClone, cloneKey, revitId);
    instance.setTransform(offset, angle, this.elements[element].bounds);
    this.instances.push(instance);
    return instance;
  }

  setTransform(instance: DynamicInstance, offset: Vec3, angle: number): void {
    instance.setTransform(offset, angle, this.elements[instance.element].bounds);
  }

  remove(instance: DynamicInstance): void {
    const i = this.instances.indexOf(instance);
    if (i >= 0) { this.instances.splice(i, 1); }
  }

  find(id: number): DynamicInstance | null {
    return id <= 0 ? null : this.instances.find(i => i.id === id) ?? null;
  }

  findOriginal(element: number): DynamicInstance | null {
    return this.instances.find(i => !i.isClone && i.element === element) ?? null;
  }

  isActive(instance: DynamicInstance): boolean {
    return !instance.hidden && this.groupVisible[SceneBatches.groupOf(this.elements[instance.element])];
  }

  /** The nearest hit on a moved / cloned element, within maxDistance. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null {
    if (this.instances.length === 0) { return null; }
    const ix = reciprocal(direction.x), iy = reciprocal(direction.y), iz = reciprocal(direction.z);
    let best = maxDistance;
    let hit: RayHit | null = null;

    for (const instance of this.instances) {
      if (!this.isActive(instance)) { continue; }
      const b = instance.worldBounds;
      if (rayAabb(origin.x, origin.y, origin.z, ix, iy, iz, b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z, best) < 0) { continue; }

      // Into source space (rigid transform: distances are preserved)
      const localOrigin = Mat4.transformPoint(origin, instance.inverseModel);
      const localDirection = transformNormal(direction, instance.inverseModel);
      this.solo[instance.element] = true;
      const local = this.bvh.raycast(localOrigin, localDirection, best, this.solo);
      this.solo[instance.element] = false;

      if (local && local.distance < best) {
        best = local.distance;
        hit = {
          distance: local.distance,
          point: Mat4.transformPoint(local.point, instance.model),
          normal: V.normalize(transformNormal(local.normal, instance.model)),
          element: instance.element,
          dynamicId: instance.id
        };
      }
    }
    return hit;
  }

  /** Collects the world-space triangles of active instances overlapping a box into {@link triangles}; returns the count. */
  collectTriangles(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
    let count = 0;
    const query = new Aabb(vec3(minX, minY, minZ), vec3(maxX, maxY, maxZ));
    for (const instance of this.instances) {
      if (!this.isActive(instance) || !instance.worldBounds.overlaps(query)) { continue; }

      const local = transformBounds(query, instance.inverseModel);
      this.solo[instance.element] = true;
      const found = this.bvh.query(local.min.x, local.min.y, local.min.z, local.max.x, local.max.y, local.max.z, this.solo);
      this.solo[instance.element] = false;

      const m = instance.model, results = this.bvh.results, source = this.bvh.triangles;
      for (let t = 0; t < found; t++) {
        if ((count + 1) * 9 > this.triangles.length) {
          const bigger = new Float32Array(this.triangles.length * 2);
          bigger.set(this.triangles);
          this.triangles = bigger;
        }
        const s = results[t] * 9, o = count * 9;
        for (let k = 0; k < 9; k += 3) {
          const x = source[s + k], y = source[s + k + 1], z = source[s + k + 2];
          this.triangles[o + k] = x * m[0] + y * m[4] + z * m[8] + m[12];
          this.triangles[o + k + 1] = x * m[1] + y * m[5] + z * m[9] + m[13];
          this.triangles[o + k + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
        }
        count++;
      }
    }
    return count;
  }
}

/** Vector3.TransformNormal: the direction part of the matrix only. */
export function transformNormal(v: Vec3, m: Matrix4x4): Vec3 {
  return vec3(v.x * m[0] + v.y * m[4] + v.z * m[8], v.x * m[1] + v.y * m[5] + v.z * m[9], v.x * m[2] + v.y * m[6] + v.z * m[10]);
}
