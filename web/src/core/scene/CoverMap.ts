import type { Matrix4x4 } from '../math/Matrix4x4';
import type { Vec3 } from '../math/Vector';
import type { SceneData } from './SceneData';

/** Milliseconds of work between yields to the page. */
const SLICE_MS = 24;

/**
 * Round W-B (weather): what covers each spot of the site, seen from above (port of CoverMap). A grid of cells (about
 * 0.5 m) over the model holding the highest surface's height in each cell, built once when rain or snow is first turned
 * on (and again a moment after the shown model changes). Rain and snow stop at it (they fall past windows but never under
 * a roof or a canopy), and the wet and snow looks only reach surfaces that are open to the sky.
 *
 * Every triangle counts, whatever way it faces: up and down faces by the cells their area covers, and each triangle's
 * edges mark the cells they pass over too (walls, thin members and slivers narrower than a cell).
 */
export class CoverMap {
  /** Most cells along one side. */
  static readonly MAX_SIDE = 1024;
  /** The cell size (m) when the model is small enough (bigger models get bigger cells). */
  static readonly CELL = 0.5;
  /** A cell nothing covers. */
  static readonly NONE = -1e9;
  /** An empty map (everything is open to the sky). */
  static readonly EMPTY = new CoverMap(0, 0, CoverMap.CELL, 0, 0, new Float32Array(0));

  /** Cells with something in them. */
  coveredCells = 0;
  /** Triangles rasterised. */
  triangles = 0;

  private constructor(
    /** The grid's lower-left corner (scene-local metres). */
    readonly minX: number, readonly minY: number,
    /** Cell size (m). */
    readonly cell: number,
    /** Cells across (X) and up (Y). */
    readonly width: number, readonly height: number,
    /** Per cell (row-major, Y rows): the highest surface's height, or NONE. */
    readonly tops: Float32Array
  ) {}

  /** True when nothing covers anything (no model). */
  get isEmpty(): boolean { return this.coveredCells === 0; }

  /**
   * Builds the map from the scene's static triangles (library templates left out), opaque and transparent alike (a
   * glass canopy keeps the rain off). visible: per element, false to leave it out; instances: moved / cloned / placed
   * copies. Yields to the page between slices; returns EMPTY when aborted.
   */
  static async build(scene: SceneData, visible: readonly boolean[] | null = null,
    instances: readonly { element: number; model: Matrix4x4 }[] | null = null, yieldToPage: (() => Promise<void>) | null = null,
    signal: AbortSignal | null = null): Promise<CoverMap> {
    if (!scene?.geometry || !scene.elements) { return CoverMap.EMPTY; }
    const geometry = scene.geometry;
    const f = geometry.floats, indices = geometry.indices, vertexCount = geometry.vertexCount;
    const builder = new Builder();
    let model: Matrix4x4 | null = null;
    let sliceStart = performance.now();
    const pause = async () => {
      if (!yieldToPage || performance.now() - sliceStart < SLICE_MS) { return; }
      await yieldToPage();
      sliceStart = performance.now();
    };
    const pa = new Float64Array(3), pb = new Float64Array(3), pc = new Float64Array(3);
    const point = (v: number, out: Float64Array) => {
      const w = v * 7;
      const x = f[w], y = f[w + 1], z = f[w + 2];
      if (!model) { out[0] = x; out[1] = y; out[2] = z; return; }
      const m = model;
      out[0] = x * m[0] + y * m[4] + z * m[8] + m[12];
      out[1] = x * m[1] + y * m[5] + z * m[9] + m[13];
      out[2] = x * m[2] + y * m[6] + z * m[10] + m[14];
    };
    const visit = async (start: number, count: number) => {
      for (let i = start; i + 2 < start + count && i + 2 < indices.length; i += 3) {
        if ((i & 8191) === 0) {
          await pause();
          if (signal?.aborted) { return; }
        }
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a >= vertexCount || b >= vertexCount || c >= vertexCount) { continue; }
        point(a, pa); point(b, pb); point(c, pc);
        if (builder.allocated) { builder.add(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2], pc[0], pc[1], pc[2]); }
        else { builder.grow(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2], pc[0], pc[1], pc[2]); }
      }
    };

    // Pass 1: the bounds of what will be rasterised; pass 2: the triangles
    for (let pass = 0; pass < 2; pass++) {
      model = null;
      for (let e = 0; e < scene.elements.length; e++) {
        const element = scene.elements[e];
        if (!element || element.isLibraryTemplate) { continue; }
        if (visible && e < visible.length && !visible[e]) { continue; }
        await visit(element.opaqueStart, element.opaqueCount);
        await visit(element.transparentStart, element.transparentCount);
        if (signal?.aborted) { return CoverMap.EMPTY; }
      }
      for (const instance of instances ?? []) {
        const element = instance.element >= 0 && instance.element < scene.elements.length ? scene.elements[instance.element] : null;
        if (!element) { continue; }
        model = instance.model;
        await visit(element.opaqueStart, element.opaqueCount);
        await visit(element.transparentStart, element.transparentCount);
      }
      if (signal?.aborted) { return CoverMap.EMPTY; }
      if (pass === 0 && !builder.allocate()) { return CoverMap.EMPTY; }
    }
    return builder.finish();
  }

  /** A map from loose triangles (three corners each; testable without a scene). */
  static fromTriangles(corners: readonly Vec3[]): CoverMap {
    if (!corners || corners.length < 3) { return CoverMap.EMPTY; }
    const builder = new Builder();
    for (let i = 0; i + 2 < corners.length; i += 3) {
      const a = corners[i], b = corners[i + 1], c = corners[i + 2];
      builder.grow(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    if (!builder.allocate()) { return CoverMap.EMPTY; }
    for (let i = 0; i + 2 < corners.length; i += 3) {
      const a = corners[i], b = corners[i + 1], c = corners[i + 2];
      builder.add(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    return builder.finish();
  }

  /** @internal Sizes a grid (Builder only). */
  static create(minX: number, minY: number, cell: number, width: number, height: number): CoverMap {
    return new CoverMap(minX, minY, cell, width, height, new Float32Array(width * height).fill(CoverMap.NONE));
  }

  /** Raises the cells along an edge (seen from above), sampled at half a cell, to the edge's height there. */
  edge(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
    const length = Math.sqrt((tx - fx) * (tx - fx) + (ty - fy) * (ty - fy));
    const steps = Math.min(Math.ceil(length / (this.cell * 0.5)), CoverMap.MAX_SIDE * 4);
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      this.raise(fx + (tx - fx) * t, fy + (ty - fy) * t, fz + (tz - fz) * t);
    }
  }

  private raise(x: number, y: number, z: number): void {
    const cx = Math.floor((x - this.minX) / this.cell), cy = Math.floor((y - this.minY) / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) { return; }
    const index = cy * this.width + cx;
    if (z > this.tops[index]) { this.tops[index] = z; }
  }

  /** The highest surface over a point (scene-local), or NONE where nothing covers it. */
  topAt(x: number, y: number): number {
    if (this.isEmpty) { return CoverMap.NONE; }
    const cx = Math.floor((x - this.minX) / this.cell), cy = Math.floor((y - this.minY) / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) { return CoverMap.NONE; }
    return this.tops[cy * this.width + cx];
  }

  /**
   * True when something is over a point by more than clearance (a roof over the eye, say); the point's own surface (the
   * top of the cell it stands in) never counts.
   */
  isCovered(point: Vec3, clearance = 0.3): boolean {
    return this.topAt(point.x, point.y) > point.z + clearance;
  }
}

/** Grows the bounds, then sizes the grid and rasterises triangles into it (no per-triangle allocation). */
class Builder {
  private minX = Number.MAX_VALUE;
  private minY = Number.MAX_VALUE;
  private maxX = -Number.MAX_VALUE;
  private maxY = -Number.MAX_VALUE;
  private map: CoverMap | null = null;
  private count = 0;

  get allocated(): boolean { return this.map !== null; }

  grow(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    if (!finite(ax, ay, az) || !finite(bx, by, bz) || !finite(cx, cy, cz)) { return; }
    this.minX = Math.min(this.minX, ax, bx, cx); this.minY = Math.min(this.minY, ay, by, cy);
    this.maxX = Math.max(this.maxX, ax, bx, cx); this.maxY = Math.max(this.maxY, ay, by, cy);
  }

  allocate(): boolean {
    if (this.minX > this.maxX || this.minY > this.maxY) { return false; }
    const sx = this.maxX - this.minX, sy = this.maxY - this.minY;
    const cell = Math.max(CoverMap.CELL, Math.max(sx, sy) / (CoverMap.MAX_SIDE - 2));
    const width = Math.min(Math.max(Math.ceil(sx / cell) + 2, 1), CoverMap.MAX_SIDE);
    const height = Math.min(Math.max(Math.ceil(sy / cell) + 2, 1), CoverMap.MAX_SIDE);
    this.map = CoverMap.create(this.minX - cell, this.minY - cell, cell, width, height);
    return true;
  }

  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    const m = this.map;
    if (!m || !finite(ax, ay, az) || !finite(bx, by, bz) || !finite(cx, cy, cz)) { return; }
    this.count++;

    // The edges mark the cells they pass over (walls, slivers, thin members narrower than a cell)
    m.edge(ax, ay, az, bx, by, bz);
    m.edge(bx, by, bz, cx, cy, cz);
    m.edge(cx, cy, cz, ax, ay, az);

    // The area: every cell whose centre lies inside, at the height there
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-8) { return; }
    const inverse = 1 / area;
    const x0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - m.minX) / m.cell));
    const y0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - m.minY) / m.cell));
    const x1 = Math.min(m.width - 1, Math.floor((Math.max(ax, bx, cx) - m.minX) / m.cell));
    const y1 = Math.min(m.height - 1, Math.floor((Math.max(ay, by, cy) - m.minY) / m.cell));
    const EDGE = -1e-4;
    const tops = m.tops;
    for (let y = y0; y <= y1; y++) {
      const py = m.minY + (y + 0.5) * m.cell;
      const row = y * m.width;
      for (let x = x0; x <= x1; x++) {
        const px = m.minX + (x + 0.5) * m.cell;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inverse;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inverse;
        const w2 = 1 - w0 - w1;
        if (w0 < EDGE || w1 < EDGE || w2 < EDGE) { continue; }
        const z = w0 * az + w1 * bz + w2 * cz;
        if (z > tops[row + x]) { tops[row + x] = z; }
      }
    }
  }

  finish(): CoverMap {
    const m = this.map;
    if (!m) { return CoverMap.EMPTY; }
    let covered = 0;
    for (let i = 0; i < m.tops.length; i++) {
      if (m.tops[i] > CoverMap.NONE) { covered++; }
    }
    m.coveredCells = covered;
    m.triangles = this.count;
    return covered === 0 ? CoverMap.EMPTY : m;
  }
}

function finite(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}
