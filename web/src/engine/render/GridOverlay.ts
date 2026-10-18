import { type GridLine, GridLayout } from '../../core/scene/GridData';
import type { LevelInfo } from '../../core/scene/SceneData';
import { gl } from '../gl/Gl';
import { ShaderProgram } from '../gl/ShaderProgram';
import { GRID_FS, GRID_VS } from '../gl/Shaders';
import type { FpsCamera } from './FpsCamera';

/** Bytes per vertex: position, direction, along, side (floats) and a packed RGBA colour. */
const VERTEX_SIZE = 36;
const VERTEX_WORDS = 9;

/**
 * Grids round A: the grid lines and level outlines on each shown level (port of GridOverlay), in one static vertex
 * buffer rebuilt only when what is shown changes. Widths are constant in pixels (the vertex shader faces each segment
 * to the eye); bubbles and tags are 2D UI drawn by the session.
 */
export class GridOverlay {
  /** Lines sit this far above the level (m). */
  static readonly LIFT = 0.03;

  private data = new ArrayBuffer(4096 * VERTEX_SIZE);
  private floats = new Float32Array(this.data);
  private words = new Uint32Array(this.data);
  private count = 0;
  private capacityOnGpu = 0;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private program: ShaderProgram | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private uploaded = false;

  /** Segments in the buffer (stats). */
  get segmentCount(): number { return this.count / 6; }

  initialise(): void {
    this.program = ShaderProgram.create('grids', GRID_VS, GRID_FS);
    for (const name of ['uViewProj', 'uEye', 'uHalfWidth', 'uAlpha', 'uDashed']) { this.u[name] = this.program.uniform(name); }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    this.capacityOnGpu = this.data.byteLength;
    gl.bufferData(gl.ARRAY_BUFFER, this.capacityOnGpu, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_SIZE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, VERTEX_SIZE, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, VERTEX_SIZE, 24);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, VERTEX_SIZE, 28);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, VERTEX_SIZE, 32);
    gl.bindVertexArray(null);
  }

  /** Rebuilds the buffer: every included grid on every shown level it reaches, and an outline per level when asked. */
  build(grids: readonly GridLine[], levels: readonly LevelInfo[], shown: readonly number[], links: boolean, respectExtents: boolean,
    outlines: boolean, lineColour: number, outlineColour: number): void {
    this.count = 0;
    this.uploaded = false;
    for (const index of shown) {
      if (index < 0 || index >= levels.length) { continue; }
      const elevation = levels[index].elevation;
      const z = elevation + GridOverlay.LIFT;
      for (const grid of grids) {
        if (!GridLayout.included(grid, links) || !GridLayout.showsAt(grid, elevation, respectExtents)) { continue; }
        let along = 0;
        for (let i = 1; i < grid.points.length; i++) {
          const a = grid.points[i - 1], b = grid.points[i];
          const length = Math.hypot(b.x - a.x, b.y - a.y);
          this.segment(a.x, a.y, z, b.x, b.y, z, along, along + length, lineColour);
          along += length;
        }
      }
      if (outlines) {
        const bounds = GridLayout.planBounds(grids, elevation, respectExtents, links);
        if (bounds) {
          const { min, max } = bounds;
          this.segment(min.x, min.y, z, max.x, min.y, z, -1, -1, outlineColour);
          this.segment(max.x, min.y, z, max.x, max.y, z, -1, -1, outlineColour);
          this.segment(max.x, max.y, z, min.x, max.y, z, -1, -1, outlineColour);
          this.segment(min.x, max.y, z, min.x, min.y, z, -1, -1, outlineColour);
        }
      }
    }
  }

  /** Empties the buffer (grids off). */
  clear(): void {
    this.count = 0;
    this.uploaded = false;
  }

  private segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, alongA: number, alongB: number, colour: number): void {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-5) { return; }
    dx /= length; dy /= length; dz /= length;
    if ((this.count + 6) * VERTEX_SIZE > this.data.byteLength) {
      const bigger = new ArrayBuffer(this.data.byteLength * 2);
      new Uint8Array(bigger).set(new Uint8Array(this.data));
      this.data = bigger;
      this.floats = new Float32Array(bigger);
      this.words = new Uint32Array(bigger);
    }
    const put = (x: number, y: number, z: number, along: number, side: number) => {
      const o = this.count * VERTEX_WORDS;
      const f = this.floats;
      f[o] = x; f[o + 1] = y; f[o + 2] = z;
      f[o + 3] = dx; f[o + 4] = dy; f[o + 5] = dz;
      f[o + 6] = along; f[o + 7] = side;
      this.words[o + 8] = colour >>> 0;
      this.count++;
    };
    put(ax, ay, az, alongA, -1);
    put(ax, ay, az, alongA, 1);
    put(bx, by, bz, alongB, 1);
    put(ax, ay, az, alongA, -1);
    put(bx, by, bz, alongB, 1);
    put(bx, by, bz, alongB, -1);
  }

  /** Draws the lines. depthMode: 0 faint through walls, 1 depth-tested only, 2 x-ray; dashed: the Revit-like dash-dot. */
  draw(camera: FpsCamera, depthMode: number, opacity: number, widthPixels: number, dashed: boolean): void {
    if (this.count === 0 || !this.program) { return; }
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (!this.uploaded) {
      if (this.data.byteLength > this.capacityOnGpu) {
        this.capacityOnGpu = this.data.byteLength;
        gl.bufferData(gl.ARRAY_BUFFER, this.capacityOnGpu, gl.STATIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(this.data, 0, this.count * VERTEX_SIZE));
      this.uploaded = true;
    }
    this.program.use();
    const u = this.u;
    gl.uniformMatrix4fv(u.uViewProj, false, camera.viewProjection);
    gl.uniform3f(u.uEye, camera.position.x, camera.position.y, camera.position.z);
    gl.uniform1f(u.uHalfWidth, 0.5 * widthPixels * camera.pixelScale);
    gl.uniform1i(u.uDashed, dashed ? 1 : 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    if (depthMode === 2) {
      gl.disable(gl.DEPTH_TEST);
      gl.uniform1f(u.uAlpha, opacity);
      gl.drawArrays(gl.TRIANGLES, 0, this.count);
    } else {
      if (depthMode === 0) {
        gl.disable(gl.DEPTH_TEST);
        gl.uniform1f(u.uAlpha, opacity * 0.25);
        gl.drawArrays(gl.TRIANGLES, 0, this.count);
      }
      gl.enable(gl.DEPTH_TEST);
      gl.uniform1f(u.uAlpha, opacity);
      gl.drawArrays(gl.TRIANGLES, 0, this.count);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.program?.dispose();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    this.vbo = this.vao = null;
  }
}
