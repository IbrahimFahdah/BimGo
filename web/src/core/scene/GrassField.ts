import type { Matrix4x4 } from '../math/Matrix4x4';
import { type Vec3, vec3 } from '../math/Vector';
import { MaterialOverrides } from './MaterialOverrides';
import type { SceneData } from './SceneData';

/** One triangle for the field: corners and palette slot (0 = a cover, else palette index + 1). */
export interface GrassTriangle {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  palette: number;
}

export function grassTriangle(a: Vec3, b: Vec3, c: Vec3, palette: number): GrassTriangle {
  return { ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, cx: c.x, cy: c.y, cz: c.z, palette };
}

/** Milliseconds of work between yields to the page. */
const SLICE_MS = 24;

/**
 * Grass round (build B): where grass grows, seen from above (port of GrassField). Grass materials (by keyword) are
 * rasterised into a grid of cells holding the highest grass surface's height and its colour; any other upward surface
 * just above the grass takes the cell away. The renderer uploads the grid as a texture and places blades from it.
 */
export class GrassField {
  static readonly MAX_SIDE = 2048;
  static readonly MIN_CELL = 0.1;
  static readonly MIN_UP = 0.34;
  static readonly COVER_BELOW = 0.02;
  static readonly COVER_ABOVE = 0.3;
  static readonly MAX_PALETTE = 16;
  static readonly DEFAULT_GREEN: Vec3 = Object.freeze(vec3(0.24, 0.38, 0.12));
  static readonly EMPTY = new GrassField(0, 0, 0, 0, 0, new Float32Array(0), new Uint8Array(0), [], 0, 0);

  private constructor(
    readonly minX: number, readonly minY: number, readonly cell: number, readonly width: number, readonly height: number,
    /** Per cell (row-major, Y rows): the grass height, valid where palette is not 0. */
    readonly heights: Float32Array,
    /** Per cell: 0 = no grass, else the palette index + 1. */
    readonly palette: Uint8Array,
    /** The grass colours (display space). */
    readonly colours: Vec3[],
    readonly grassCells: number,
    readonly grassTriangles: number
  ) {}

  get isEmpty(): boolean { return this.grassCells === 0; }

  /**
   * Builds the field from the scene's static triangles and the grass materials. visible: per element, false to leave
   * it out; instances: moved / cloned / placed copies (element and scene-local transform). Yields to the page between
   * slices; returns EMPTY when aborted.
   */
  static async build(scene: SceneData, keywords: readonly string[], visible: readonly boolean[] | null = null,
    instances: readonly { element: number; model: Matrix4x4 }[] | null = null, yieldToPage: (() => Promise<void>) | null = null,
    signal: AbortSignal | null = null): Promise<GrassField> {
    const materials = scene?.materials;
    if (!materials || materials.materials.length === 0 || !keywords || keywords.length === 0) { return GrassField.EMPTY; }
    const geometry = scene.geometry;
    if (materials.vertexMaterial.length !== geometry.vertexCount) { return GrassField.EMPTY; }

    const colours: Vec3[] = [];
    const slot = new Int32Array(materials.materials.length);
    materials.materials.forEach((m, i) => {
      if (!m || !MaterialOverrides.matches(m.name, keywords)) { return; }
      if (colours.length >= GrassField.MAX_PALETTE) { slot[i] = colours.length; return; }
      colours.push(GrassField.grassColour(m.renderColour ?? m.colour));
      slot[i] = colours.length;
    });
    if (colours.length === 0) { return GrassField.EMPTY; }

    const grass: GrassTriangle[] = [];
    const covers: GrassTriangle[] = [];
    const f = geometry.floats, indices = geometry.indices, vertexCount = geometry.vertexCount;
    let model: Matrix4x4 | null = null;
    let sliceStart = performance.now();
    const pause = async () => {
      if (!yieldToPage || performance.now() - sliceStart < SLICE_MS) { return; }
      await yieldToPage();
      sliceStart = performance.now();
    };
    const point = (v: number): [number, number, number] => {
      const w = v * 7;
      const x = f[w], y = f[w + 1], z = f[w + 2];
      if (!model) { return [x, y, z]; }
      const m = model;
      return [x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]];
    };
    const collect = async (start: number, count: number) => {
      for (let i = start; i + 2 < start + count && i + 2 < indices.length; i += 3) {
        if ((i & 8191) === 0) {
          await pause();
          if (signal?.aborted) { return; }
        }
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a >= vertexCount || b >= vertexCount || c >= vertexCount) { continue; }
        const pa = point(a), pb = point(b), pc = point(c);
        const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
        const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (length < 1e-9 || nz / length < GrassField.MIN_UP) { continue; }
        const material = materials.vertexMaterial[a];
        const palette = material < slot.length ? slot[material] : 0;
        const t: GrassTriangle = { ax: pa[0], ay: pa[1], az: pa[2], bx: pb[0], by: pb[1], bz: pb[2], cx: pc[0], cy: pc[1], cz: pc[2], palette };
        (palette > 0 ? grass : covers).push(t);
      }
    };
    for (let e = 0; e < scene.elements.length; e++) {
      const element = scene.elements[e];
      if (!element || element.isLibraryTemplate) { continue; }
      if (visible && e < visible.length && !visible[e]) { continue; }
      await collect(element.opaqueStart, element.opaqueCount);
      await collect(element.transparentStart, element.transparentCount);
      if (signal?.aborted) { return GrassField.EMPTY; }
    }
    for (const instance of instances ?? []) {
      const element = scene.elements[instance.element];
      if (!element) { continue; }
      model = instance.model;
      await collect(element.opaqueStart, element.opaqueCount);
      await collect(element.transparentStart, element.transparentCount);
    }
    if (signal?.aborted) { return GrassField.EMPTY; }
    return GrassField.rasterise(grass, covers, colours);
  }

  /** Rasterises grass triangles (palette slot 1..n) and cover triangles into a field (testable without a scene). */
  static rasterise(grass: readonly GrassTriangle[], covers: readonly GrassTriangle[] | null, colours: Vec3[]): GrassField {
    if (!grass || grass.length === 0) { return GrassField.EMPTY; }
    let minX = Number.MAX_VALUE, minY = Number.MAX_VALUE, maxX = -Number.MAX_VALUE, maxY = -Number.MAX_VALUE;
    for (const t of grass) {
      minX = Math.min(minX, t.ax, t.bx, t.cx); minY = Math.min(minY, t.ay, t.by, t.cy);
      maxX = Math.max(maxX, t.ax, t.bx, t.cx); maxY = Math.max(maxY, t.ay, t.by, t.cy);
    }
    const sx = maxX - minX, sy = maxY - minY;
    const cell = Math.max(GrassField.MIN_CELL, Math.max(sx, sy) / (GrassField.MAX_SIDE - 2));
    minX -= cell;
    minY -= cell;
    const width = Math.min(Math.max(Math.ceil(sx / cell) + 2, 1), GrassField.MAX_SIDE);
    const height = Math.min(Math.max(Math.ceil(sy / cell) + 2, 1), GrassField.MAX_SIDE);
    const heights = new Float32Array(width * height).fill(-Number.MAX_VALUE);
    const palette = new Uint8Array(width * height);

    const scan = (t: GrassTriangle, visit: (index: number, z: number) => void) => {
      const tMinX = Math.min(t.ax, t.bx, t.cx), tMinY = Math.min(t.ay, t.by, t.cy);
      const tMaxX = Math.max(t.ax, t.bx, t.cx), tMaxY = Math.max(t.ay, t.by, t.cy);
      const x0 = Math.max(0, Math.floor((tMinX - minX) / cell)), y0 = Math.max(0, Math.floor((tMinY - minY) / cell));
      const x1 = Math.min(width - 1, Math.floor((tMaxX - minX) / cell)), y1 = Math.min(height - 1, Math.floor((tMaxY - minY) / cell));
      const area = (t.bx - t.ax) * (t.cy - t.ay) - (t.by - t.ay) * (t.cx - t.ax);
      if (Math.abs(area) < 1e-10) { return; }
      const inverse = 1 / area;
      const EDGE = -1e-4;
      for (let y = y0; y <= y1; y++) {
        const py = minY + (y + 0.5) * cell;
        for (let x = x0; x <= x1; x++) {
          const px = minX + (x + 0.5) * cell;
          const w0 = ((t.bx - px) * (t.cy - py) - (t.by - py) * (t.cx - px)) * inverse;
          const w1 = ((t.cx - px) * (t.ay - py) - (t.cy - py) * (t.ax - px)) * inverse;
          const w2 = 1 - w0 - w1;
          if (w0 < EDGE || w1 < EDGE || w2 < EDGE) { continue; }
          visit(y * width + x, w0 * t.az + w1 * t.bz + w2 * t.cz);
        }
      }
    };

    for (const t of grass) {
      scan(t, (index, z) => {
        if (z > heights[index]) { heights[index] = z; palette[index] = t.palette; }
      });
    }
    const right = minX + width * cell, top = minY + height * cell;
    for (const t of covers ?? []) {
      if (Math.max(t.ax, t.bx, t.cx) < minX || Math.max(t.ay, t.by, t.cy) < minY || Math.min(t.ax, t.bx, t.cx) > right || Math.min(t.ay, t.by, t.cy) > top) { continue; }
      scan(t, (index, z) => {
        if (palette[index] === 0) { return; }
        const above = z - heights[index];
        if (above > GrassField.COVER_BELOW && above < GrassField.COVER_ABOVE) { palette[index] = 0; }
      });
    }
    let cells = 0;
    for (let i = 0; i < palette.length; i++) {
      if (palette[i] !== 0) { cells++; } else { heights[i] = 0; }
    }
    return cells === 0 ? GrassField.EMPTY : new GrassField(minX, minY, cell, width, height, heights, palette, colours ?? [], cells, grass.length);
  }

  /** The colour blades take from a grass material: its own when it reads green (nudged to a natural green), else the default green. */
  static grassColour(colour: Vec3): Vec3 {
    const green = colour.y > colour.x * 1.05 && colour.y > colour.z && colour.y > 0.08;
    const d = GrassField.DEFAULT_GREEN;
    return green ? vec3(colour.x + (d.x - colour.x) * 0.3, colour.y + (d.y - colour.y) * 0.3, colour.z + (d.z - colour.z) * 0.3) : vec3(d.x, d.y, d.z);
  }

  /** The grass at a point (CPU lookup): its height and palette index, or null. */
  tryGet(x: number, y: number): { z: number; palette: number } | null {
    if (this.isEmpty) { return null; }
    const cx = Math.floor((x - this.minX) / this.cell), cy = Math.floor((y - this.minY) / this.cell);
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) { return null; }
    const index = cy * this.width + cx;
    if (this.palette[index] === 0) { return null; }
    return { z: this.heights[index], palette: this.palette[index] - 1 };
  }
}
