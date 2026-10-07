import { type Matrix4x4, Mat4 } from '../../core/math/Matrix4x4';
import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import { SCENE_VERTEX_SIZE, type SceneData } from '../../core/scene/SceneData';
import { gl } from '../gl/Gl';
import { ShaderProgram } from '../gl/ShaderProgram';
import { FULLSCREEN_VS, GROUND_FS, GROUND_VS, SCENE_FS, SCENE_VS, SKY_FS } from '../gl/Shaders';
import { FpsCamera } from './FpsCamera';
import type { SceneBatches } from './SceneBatches';

/** Per-draw settings of the scene pass (port of SceneDrawParams). */
export interface SceneDrawParams {
  viewProjection: Matrix4x4;
  planes: Float32Array;
  eye: Vec3;
  whitecard: boolean;
  plan: boolean;
  clipZMin: number;
  clipZMax: number;
  fogDensity: number;
  sun: boolean;
  realistic: boolean;
}

/**
 * Texture units, as on the desktop: sun shadows 1–2, AO 3, light shadows 5, material table 6, image arrays 7–10.
 * Every sampler a program declares gets its unit once at link time and a valid placeholder texture, so WebGL never
 * sees two sampler types on one unit (an INVALID_OPERATION at draw time).
 */
const UNIT = { shadowMap: 1, transmit: 2, aoMap: 3, lightShadowMap: 5, materialTable: 6, tex0: 7 } as const;

/**
 * Draws the static scene, sky and ground (port of BimGo.App/Rendering/SceneRenderer.cs, Phase 1 subset: the classic
 * fixed light). Sun shadows, AO, artificial lights and Realistic materials keep their uniforms switched off until
 * their phases port the systems that feed them.
 */
export class SceneRenderer {
  static readonly FOG_COLOUR = vec3(0.80, 0.85, 0.89);
  private static readonly LIGHT_DIR = V.normalize(vec3(0.35, 0.22, 0.91));
  private static readonly GROUND_HALF = 2500;

  private sceneProgram!: ShaderProgram;
  private skyProgram!: ShaderProgram;
  private groundProgram!: ShaderProgram;
  private scene: Record<string, WebGLUniformLocation | null> = {};
  private sky: Record<string, WebGLUniformLocation | null> = {};
  private ground: Record<string, WebGLUniformLocation | null> = {};

  private vao: WebGLVertexArrayObject | null = null;
  private emptyVao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private ibo: WebGLBuffer | null = null;
  private placeholders: WebGLTexture[] = [];
  private batches!: SceneBatches;
  private multiDraw: WEBGL_multi_draw | null = null;
  private drawCounts = new Int32Array(1);
  private drawOffsets = new Int32Array(1);
  private degenerate = new Uint32Array(0);
  private readonly identity = Mat4.identity();

  /** Chunks drawn by the last opaque pass (HUD statistics). */
  chunksDrawn = 0;

  /** Creates programs and uploads the static scene. */
  initialise(scene: SceneData, batches: SceneBatches): void {
    this.batches = batches;
    this.multiDraw = gl.getExtension('WEBGL_multi_draw');

    this.sceneProgram = ShaderProgram.create('scene', SCENE_VS, SCENE_FS);
    this.skyProgram = ShaderProgram.create('sky', FULLSCREEN_VS, SKY_FS);
    this.groundProgram = ShaderProgram.create('ground', GROUND_VS, GROUND_FS);

    this.scene = locations(this.sceneProgram, ['uViewProj', 'uModel', 'uEye', 'uLightDir', 'uFogColor', 'uFogDensity', 'uWhitecard',
      'uPlan', 'uClipZ', 'uOverride', 'uRealistic', 'uSun', 'uShadowsOn', 'uAoOn', 'uLightCount', 'uEmissive', 'uShoulder']);
    this.sky = locations(this.skyProgram, ['uInvViewProj', 'uEye', 'uSun', 'uSunDir', 'uZenith', 'uHorizon', 'uSunDisc']);
    this.ground = locations(this.groundProgram, ['uViewProj', 'uCenter', 'uHalf', 'uEye', 'uFogColor', 'uSun', 'uShadowsOn',
      'uAoOn', 'uLightCount', 'uEmissive', 'uShoulder']);
    for (const program of [this.sceneProgram, this.groundProgram]) { assignSamplerUnits(program); }
    this.createPlaceholders();

    // Static geometry: the interleaved vertex block exactly as read from geometry.bin
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, scene.geometry.vertexBytes, gl.STATIC_DRAW);
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, batches.indices, gl.STATIC_DRAW);
    setVertexLayout();
    gl.bindVertexArray(null);

    let maxChunks = 1;
    for (const batch of batches.batches) { maxChunks = Math.max(maxChunks, batch.chunkCount); }
    this.drawCounts = new Int32Array(maxChunks);
    this.drawOffsets = new Int32Array(maxChunks);

    this.emptyVao = gl.createVertexArray();
  }

  /** A 1×1 texture of the right kind on every sampler unit the shaders declare. */
  private createPlaceholders(): void {
    const depthArray = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthArray);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.DEPTH_COMPONENT16, 1, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, new Uint16Array([0xffff]));
    setNearest(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

    const colourArray = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, colourArray);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    setNearest(gl.TEXTURE_2D_ARRAY);

    const colour2d = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colour2d);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    setNearest(gl.TEXTURE_2D);

    const bind = (unit: number, target: GLenum, texture: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, texture);
    };
    bind(UNIT.shadowMap, gl.TEXTURE_2D_ARRAY, depthArray);
    bind(UNIT.lightShadowMap, gl.TEXTURE_2D_ARRAY, depthArray);
    bind(UNIT.transmit, gl.TEXTURE_2D_ARRAY, colourArray);
    for (let i = 0; i < 4; i++) { bind(UNIT.tex0 + i, gl.TEXTURE_2D_ARRAY, colourArray); }
    bind(UNIT.aoMap, gl.TEXTURE_2D, colour2d);
    bind(UNIT.materialTable, gl.TEXTURE_2D, colour2d);
    gl.activeTexture(gl.TEXTURE0);
    this.placeholders = [depthArray, colourArray, colour2d];
  }

  // #region Element visibility

  /**
   * Hides or restores an element in the static batches by overwriting its index ranges with degenerate triangles
   * (zero raster cost), so the batch / chunk draw lists never change.
   */
  setElementHidden(element: number, hidden: boolean): void {
    gl.bindVertexArray(this.vao);
    for (const pass of [0, 2]) {
      const start = this.batches.ranges[element * 4 + pass], count = this.batches.ranges[element * 4 + pass + 1];
      if (count <= 0) { continue; }
      if (hidden) {
        if (this.degenerate.length < count) { this.degenerate = new Uint32Array(Math.max(count, this.degenerate.length * 2)); }
        this.degenerate.fill(this.batches.indices[start], 0, count);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, start * 4, this.degenerate, 0, count);
      } else {
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, start * 4, this.batches.indices, start, count);
      }
    }
    gl.bindVertexArray(null);
  }

  // #endregion

  // #region Drawing

  /** Draws the gradient sky (no depth). */
  drawSky(camera: FpsCamera): void {
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    this.skyProgram.use();
    const u = this.sky;
    gl.uniformMatrix4fv(u.uInvViewProj, false, camera.inverseViewProjection);
    gl.uniform3f(u.uEye, camera.position.x, camera.position.y, camera.position.z);
    gl.uniform1i(u.uSun, 0);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Draws the infinite-looking ground plane. */
  drawGround(camera: FpsCamera, groundZ: number): void {
    this.groundProgram.use();
    const u = this.ground;
    gl.uniformMatrix4fv(u.uViewProj, false, camera.viewProjection);
    gl.uniform3f(u.uCenter, camera.position.x, camera.position.y, groundZ);
    gl.uniform1f(u.uHalf, SceneRenderer.GROUND_HALF);
    gl.uniform3f(u.uEye, camera.position.x, camera.position.y, camera.position.z);
    const fog = SceneRenderer.FOG_COLOUR;
    gl.uniform3f(u.uFogColor, fog.x, fog.y, fog.z);
    this.applyOff(u);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Draws all visible batches of one pass with frustum-culled chunks. */
  drawStatic(p: SceneDrawParams, groupVisible: boolean[], transparent: boolean): void {
    if (!transparent) { this.chunksDrawn = 0; }
    this.sceneProgram.use();
    this.applyUniforms(p, 0, 0, 0, 0);
    this.drawBatches(p.planes, groupVisible, transparent);
  }

  private drawBatches(planes: Float32Array, groupVisible: boolean[], transparent: boolean): void {
    gl.bindVertexArray(this.vao);
    const b = this.batches;
    const bounds = b.chunkBounds, counts = this.drawCounts, offsets = this.drawOffsets;

    for (const batch of b.batches) {
      if (batch.transparent !== transparent || !groupVisible[batch.group]) { continue; }

      let drawCount = 0;
      const end = batch.chunkStart + batch.chunkCount;
      for (let c = batch.chunkStart; c < end; c++) {
        const o = c * 6;
        if (!FpsCamera.isBoxVisible(planes, bounds[o], bounds[o + 1], bounds[o + 2], bounds[o + 3], bounds[o + 4], bounds[o + 5])) { continue; }
        counts[drawCount] = b.chunkCount[c];
        offsets[drawCount] = b.chunkStart[c] * 4;
        drawCount++;
      }
      if (drawCount === 0) { continue; }

      if (this.multiDraw) {
        this.multiDraw.multiDrawElementsWEBGL(gl.TRIANGLES, counts, 0, gl.UNSIGNED_INT, offsets, 0, drawCount);
      } else {
        for (let i = 0; i < drawCount; i++) { gl.drawElements(gl.TRIANGLES, counts[i], gl.UNSIGNED_INT, offsets[i]); }
      }
      if (!transparent) { this.chunksDrawn += drawCount; }
    }
    gl.bindVertexArray(null);
  }

  /** Draws an element again with a colour override (scan highlight). */
  drawElementHighlight(p: SceneDrawParams, element: number, r: number, g: number, b: number, a: number): void {
    this.sceneProgram.use();
    this.applyUniforms(p, r, g, b, a);
    gl.bindVertexArray(this.vao);
    const ranges = this.batches.ranges;
    for (const pass of [0, 2]) {
      const start = ranges[element * 4 + pass], count = ranges[element * 4 + pass + 1];
      if (count > 0) { gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, start * 4); }
    }
    gl.bindVertexArray(null);
  }

  private applyUniforms(p: SceneDrawParams, r: number, g: number, b: number, a: number): void {
    const u = this.scene;
    gl.uniformMatrix4fv(u.uViewProj, false, p.viewProjection);
    gl.uniformMatrix4fv(u.uModel, false, this.identity);
    gl.uniform3f(u.uEye, p.eye.x, p.eye.y, p.eye.z);
    const l = SceneRenderer.LIGHT_DIR;
    gl.uniform3f(u.uLightDir, l.x, l.y, l.z);
    const fog = SceneRenderer.FOG_COLOUR;
    gl.uniform3f(u.uFogColor, fog.x, fog.y, fog.z);
    this.applyOff(u);
    gl.uniform1f(u.uFogDensity, p.fogDensity);
    gl.uniform1i(u.uWhitecard, p.whitecard ? 1 : 0);
    gl.uniform1i(u.uPlan, p.plan ? 1 : 0);
    gl.uniform2f(u.uClipZ, p.clipZMin, p.clipZMax);
    gl.uniform4f(u.uOverride, r, g, b, a);
    gl.uniform1i(u.uRealistic, 0);
  }

  /** The sun, AO, artificial-light and glow blocks, all off (Phase 1). */
  private applyOff(u: Record<string, WebGLUniformLocation | null>): void {
    gl.uniform1i(u.uSun, 0);
    gl.uniform1i(u.uShadowsOn, 0);
    gl.uniform1i(u.uAoOn, 0);
    gl.uniform1i(u.uLightCount, 0);
    gl.uniform1f(u.uEmissive, 0);
    gl.uniform1i(u.uShoulder, 0);
  }

  // #endregion

  /** Releases GL resources. */
  dispose(): void {
    this.sceneProgram?.dispose();
    this.skyProgram?.dispose();
    this.groundProgram?.dispose();
    for (const t of this.placeholders) { gl.deleteTexture(t); }
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.emptyVao);
  }
}

function locations(program: ShaderProgram, names: string[]): Record<string, WebGLUniformLocation | null> {
  const result: Record<string, WebGLUniformLocation | null> = {};
  for (const name of names) { result[name] = program.uniform(name); }
  return result;
}

/** Points each sampler uniform at its fixed unit (unused ones are optimised out and ignored). */
function assignSamplerUnits(program: ShaderProgram): void {
  program.use();
  const set = (name: string, unit: number) => {
    const location = program.uniform(name);
    if (location) { gl.uniform1i(location, unit); }
  };
  set('uShadowMap', UNIT.shadowMap);
  set('uTransmit', UNIT.transmit);
  set('uAoMap', UNIT.aoMap);
  set('uLightShadowMap', UNIT.lightShadowMap);
  set('uMaterialTable', UNIT.materialTable);
  for (let i = 0; i < 4; i++) { set(`uTex${i}`, UNIT.tex0 + i); }
}

function setNearest(target: GLenum): void {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function setVertexLayout(): void {
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, SCENE_VERTEX_SIZE, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, SCENE_VERTEX_SIZE, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, SCENE_VERTEX_SIZE, 24);
  // Attribute 3 (emissive) stays disabled: it reads (0, 0, 0, 1) = no glow. 4 / 5 (materials) read 0.
}
