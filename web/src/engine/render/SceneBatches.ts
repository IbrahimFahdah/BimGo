import { CATEGORIES } from '../../core/scene/CategoryCatalog';
import type { ElementRecord, SceneData } from '../../core/scene/SceneData';

/**
 * The scene's indices re-ordered for drawing (port of BimGo.App/Rendering/SceneBatches.cs): one batch per visibility
 * group (category × model) and pass (opaque / transparent), each split into spatially compact chunks for frustum
 * culling. Chunk bounds are flat arrays (6 floats per chunk) so culling allocates nothing.
 */
export class SceneBatches {
  private static readonly MAX_ELEMENTS_PER_CHUNK = 48;
  private static readonly MAX_INDICES_PER_CHUNK = 96_000;
  private static readonly MAX_CHUNK_EXTENT = 14;

  /** The visibility group of an element: link × categories + category. */
  static groupOf(record: ElementRecord): number {
    return record.link * CATEGORIES.length + record.categoryIndex;
  }

  static groupCount(scene: SceneData): number {
    return CATEGORIES.length * (scene.links.length + 1);
  }

  readonly indices: Uint32Array;
  /** Per chunk: minX, minY, minZ, maxX, maxY, maxZ. */
  readonly chunkBounds: Float32Array;
  readonly chunkStart: Int32Array;
  readonly chunkCount: Int32Array;
  readonly batches: RenderBatch[] = [];
  /** Per element: where its triangles now live (opaqueStart, opaqueCount, transparentStart, transparentCount). */
  readonly ranges: Int32Array;

  constructor(scene: SceneData) {
    const elements = scene.elements;
    const source = scene.geometry.indices;
    const indices = new Uint32Array(source.length);
    const bounds: number[] = [];
    const starts: number[] = [];
    const counts: number[] = [];
    this.ranges = new Int32Array(elements.length * 4);
    let write = 0;

    // Scene-wide quantisation for sort keys
    const sb = scene.bounds;
    const sizeX = Math.max(sb.max.x - sb.min.x, 1), sizeY = Math.max(sb.max.y - sb.min.y, 1);

    const categoryCount = CATEGORIES.length;
    const groupCount = SceneBatches.groupCount(scene);
    const buckets: number[][] = Array.from({ length: groupCount }, () => []);

    for (let pass = 0; pass < 2; pass++) {
      const transparent = pass === 1;

      // Bucket the pass's elements by group once (host groups first, then each link's)
      for (const bucket of buckets) { bucket.length = 0; }
      for (let e = 0; e < elements.length; e++) {
        const record = elements[e];
        if ((transparent ? record.transparentCount : record.opaqueCount) === 0) { continue; }
        const g = SceneBatches.groupOf(record);
        if (g < 0 || g >= groupCount) { continue; }
        buckets[g].push(e);
      }

      for (let group = 0; group < groupCount; group++) {
        const members = buckets[group];
        if (members.length === 0) { continue; }

        // Sort by Morton order of the element centres (z in coarse slabs)
        const keyed = members.map(e => {
          const c = elements[e].bounds.center;
          const qx = clampInt((c.x - sb.min.x) / sizeX * 1023, 0, 1023);
          const qy = clampInt((c.y - sb.min.y) / sizeY * 1023, 0, 1023);
          const qz = clampInt((c.z - sb.min.z) / 3, 0, 1023);
          return { e, key: qz * 0x100000 + morton2D(qx, qy) };
        });
        keyed.sort((a, b) => a.key - b.key);

        const batch: RenderBatch = { categoryIndex: group % categoryCount, group, transparent, chunkStart: starts.length, chunkCount: 0 };
        let chunkElements = 0;
        let cMinX = 0, cMinY = 0, cMinZ = 0, cMaxX = 0, cMaxY = 0, cMaxZ = 0, cStart = 0, cCount = 0;
        const closeChunk = () => {
          bounds.push(cMinX, cMinY, cMinZ, cMaxX, cMaxY, cMaxZ);
          starts.push(cStart);
          counts.push(cCount);
          chunkElements = 0;
        };

        for (const { e } of keyed) {
          const record = elements[e];
          const start = transparent ? record.transparentStart : record.opaqueStart;
          const count = transparent ? record.transparentCount : record.opaqueCount;
          const b = record.bounds;

          // Close the current chunk if this element would make it too big or too spread out
          if (chunkElements > 0) {
            const extentX = Math.max(cMaxX, b.max.x) - Math.min(cMinX, b.min.x);
            const extentY = Math.max(cMaxY, b.max.y) - Math.min(cMinY, b.min.y);
            if (chunkElements >= SceneBatches.MAX_ELEMENTS_PER_CHUNK
              || cCount + count > SceneBatches.MAX_INDICES_PER_CHUNK
              || Math.max(extentX, extentY) > SceneBatches.MAX_CHUNK_EXTENT) {
              closeChunk();
            }
          }

          if (chunkElements === 0) {
            cMinX = cMinY = cMinZ = Number.MAX_VALUE;
            cMaxX = cMaxY = cMaxZ = -Number.MAX_VALUE;
            cStart = write;
            cCount = 0;
          }

          indices.set(source.subarray(start, start + count), write);
          const r = e * 4 + (transparent ? 2 : 0);
          this.ranges[r] = write;
          this.ranges[r + 1] = count;

          write += count;
          cCount += count;
          cMinX = Math.min(cMinX, b.min.x); cMinY = Math.min(cMinY, b.min.y); cMinZ = Math.min(cMinZ, b.min.z);
          cMaxX = Math.max(cMaxX, b.max.x); cMaxY = Math.max(cMaxY, b.max.y); cMaxZ = Math.max(cMaxZ, b.max.z);
          chunkElements++;
        }
        if (chunkElements > 0) { closeChunk(); }

        batch.chunkCount = starts.length - batch.chunkStart;
        this.batches.push(batch);
      }
    }

    this.indices = indices;
    this.chunkBounds = Float32Array.from(bounds);
    this.chunkStart = Int32Array.from(starts);
    this.chunkCount = Int32Array.from(counts);
  }

  get chunkTotal(): number {
    return this.chunkStart.length;
  }
}

export interface RenderBatch {
  categoryIndex: number;
  /** Visibility group (category × model). */
  group: number;
  transparent: boolean;
  chunkStart: number;
  chunkCount: number;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.trunc(Math.min(Math.max(value, min), max));
}

function morton2D(x: number, y: number): number {
  let result = 0;
  for (let bit = 0; bit < 10; bit++) {
    result |= (((x >> bit) & 1) << (2 * bit)) | (((y >> bit) & 1) << (2 * bit + 1));
  }
  return result >>> 0;
}
