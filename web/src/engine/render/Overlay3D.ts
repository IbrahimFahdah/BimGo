import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import { gl } from '../gl/Gl';
import { ShaderProgram } from '../gl/ShaderProgram';
import { OVERLAY_FS, OVERLAY_VS } from '../gl/Shaders';
import type { FpsCamera } from './FpsCamera';

const VERTEX_SIZE = 16;
const WORDS = 4;
const TAU = Math.PI * 2;

/**
 * World-space markers (measure lines, portals, teleport arcs, comment pins): screen-width lines and discs, batched
 * per frame (port of BimGo.App/Rendering/Overlay3D.cs).
 */
export class Overlay3D {
  private buffer = new ArrayBuffer(16384 * VERTEX_SIZE);
  private floats = new Float32Array(this.buffer);
  private words = new Uint32Array(this.buffer);
  private count = 0;
  private capacityOnGpu = 0;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private program: ShaderProgram | null = null;
  private viewProj: WebGLUniformLocation | null = null;
  private alpha: WebGLUniformLocation | null = null;
  private eye: Vec3 = vec3();
  private pixelScale = 0;

  initialise(): void {
    this.program = ShaderProgram.create('overlay', OVERLAY_VS, OVERLAY_FS);
    this.viewProj = this.program.uniform('uViewProj');
    this.alpha = this.program.uniform('uAlpha');

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    this.capacityOnGpu = this.capacity;
    gl.bufferData(gl.ARRAY_BUFFER, this.capacityOnGpu * VERTEX_SIZE, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_SIZE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, VERTEX_SIZE, 12);
    gl.bindVertexArray(null);
  }

  private get capacity(): number {
    return this.buffer.byteLength / VERTEX_SIZE;
  }

  begin(camera: FpsCamera): void {
    this.count = 0;
    this.eye = camera.position;
    this.pixelScale = camera.pixelScale;
  }

  /** A line of constant screen width (pixels) facing the eye. */
  line(a: Vec3, b: Vec3, widthPixels: number, colour: number): void {
    let dir = V.sub(b, a);
    const length = V.length(dir);
    if (length < 1e-5) { return; }
    dir = V.scale(dir, 1 / length);

    const mid = V.scale(V.add(a, b), 0.5);
    let side = V.cross(dir, V.sub(this.eye, mid));
    const sideLength = V.length(side);
    if (sideLength < 1e-6) { return; }
    side = V.scale(side, 1 / sideLength);

    const halfA = 0.5 * widthPixels * this.pixelScale * Math.max(V.distance(this.eye, a), 0.05);
    const halfB = 0.5 * widthPixels * this.pixelScale * Math.max(V.distance(this.eye, b), 0.05);
    this.quad(V.sub(a, V.scale(side, halfA)), V.add(a, V.scale(side, halfA)), V.add(b, V.scale(side, halfB)), V.sub(b, V.scale(side, halfB)), colour);
  }

  /** A filled ellipse in the plane of two axes. */
  disc(centre: Vec3, axisU: Vec3, axisV: Vec3, radiusU: number, radiusV: number, colour: number, segments = 32): void {
    let previous = V.add(centre, V.scale(axisU, radiusU));
    for (let i = 1; i <= segments; i++) {
      const angle = i * TAU / segments;
      const next = V.add(V.add(centre, V.scale(axisU, Math.cos(angle) * radiusU)), V.scale(axisV, Math.sin(angle) * radiusV));
      this.triangle(centre, previous, next, colour);
      previous = next;
    }
  }

  /** An elliptical ring (world thickness). */
  ring(centre: Vec3, axisU: Vec3, axisV: Vec3, radiusU: number, radiusV: number, thickness: number, colour: number, segments = 40): void {
    const at = (angle: number, ru: number, rv: number) =>
      V.add(V.add(centre, V.scale(axisU, Math.cos(angle) * ru)), V.scale(axisV, Math.sin(angle) * rv));
    for (let i = 0; i < segments; i++) {
      const a0 = i * TAU / segments, a1 = (i + 1) * TAU / segments;
      this.quad(at(a0, radiusU, radiusV), at(a0, radiusU + thickness, radiusV + thickness),
        at(a1, radiusU + thickness, radiusV + thickness), at(a1, radiusU, radiusV), colour);
    }
  }

  /** A dot of constant screen radius (pixels) facing the eye. */
  dot(centre: Vec3, radiusPixels: number, colour: number, segments = 16): void {
    const toEye = V.sub(this.eye, centre);
    const distance = V.length(toEye);
    if (distance < 1e-4) { return; }
    const forward = V.scale(toEye, 1 / distance);
    const up = Math.abs(forward.z) > 0.95 ? vec3(1, 0, 0) : vec3(0, 0, 1);
    const u = V.normalize(V.cross(up, forward));
    const v = V.cross(forward, u);
    const r = radiusPixels * this.pixelScale * distance;
    this.disc(centre, u, v, r, r, colour, segments);
  }

  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, colour: number): void {
    this.triangle(a, b, c, colour);
    this.triangle(a, c, d, colour);
  }

  triangle(a: Vec3, b: Vec3, c: Vec3, colour: number): void {
    if (this.count + 3 > this.capacity) { this.grow(); }
    for (const p of [a, b, c]) {
      const i = this.count++ * WORDS;
      this.floats[i] = p.x;
      this.floats[i + 1] = p.y;
      this.floats[i + 2] = p.z;
      this.words[i + 3] = colour;
    }
  }

  private grow(): void {
    const bigger = new ArrayBuffer(this.buffer.byteLength * 2);
    new Uint8Array(bigger).set(new Uint8Array(this.buffer));
    this.buffer = bigger;
    this.floats = new Float32Array(bigger);
    this.words = new Uint32Array(bigger);
  }

  /** Draws the batch (kept for a second pass, e.g. the faint x-ray copy). */
  draw(camera: FpsCamera, depthTest: boolean, alpha: number, additive: boolean): void {
    if (this.count === 0 || !this.program) { return; }

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (this.capacity > this.capacityOnGpu) {
      this.capacityOnGpu = this.capacity;
      gl.bufferData(gl.ARRAY_BUFFER, this.capacityOnGpu * VERTEX_SIZE, gl.STREAM_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.floats, 0, this.count * WORDS);

    this.program.use();
    gl.uniformMatrix4fv(this.viewProj, false, camera.viewProjection);
    gl.uniform1f(this.alpha, alpha);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    if (depthTest) { gl.enable(gl.DEPTH_TEST); } else { gl.disable(gl.DEPTH_TEST); }
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);

    gl.drawArrays(gl.TRIANGLES, 0, this.count);

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
  }
}
