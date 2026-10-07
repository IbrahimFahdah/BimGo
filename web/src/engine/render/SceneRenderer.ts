import { type Matrix4x4, Mat4 } from '../../core/math/Matrix4x4';
import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import type { Aabb, SceneData } from '../../core/scene/SceneData';
import { SCENE_VERTEX_SIZE } from '../../core/scene/SceneData';
import { gl } from '../gl/Gl';
import { ShaderProgram } from '../gl/ShaderProgram';
import {
  FULLSCREEN_VS, GEOMETRY_FS, GEOMETRY_GROUND_FS, GROUND_FS, GROUND_VS, SCENE_FS, SCENE_VS, SHADOW_DEPTH_FS, SHADOW_TRANSMIT_FS,
  SHADOW_VS, SKY_FS
} from '../gl/Shaders';
import { FpsCamera } from './FpsCamera';
import { ArtificialLighting, LightShadows } from './LightShadows';
import type { SceneBatches } from './SceneBatches';
import { ScreenEffects } from './ScreenEffects';
import { ShadowMaps, type ShadowPreset } from './ShadowMaps';
import { NO_SUN, type SunLighting } from './SunLighting';

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

type Uniforms = Record<string, WebGLUniformLocation | null>;

/**
 * Texture units, as on the desktop: sun shadows 1–2, AO 3, glow 4, light shadows 5, material table 6, image arrays
 * 7–10. Every sampler a program declares gets its unit once at link time and always has a valid texture bound, so
 * WebGL never sees two sampler types on one unit or an incomplete sampler (both INVALID_OPERATION at draw time).
 */
const UNIT = { shadowMap: 1, transmit: 2, aoMap: 3, lightShadowMap: 5, materialTable: 6, tex0: 7 } as const;

const LIGHT_UNIFORMS = ['uSun', 'uSunDir', 'uSunColor', 'uSkyColor', 'uShadowStrength', 'uShadowsOn', 'uTransmitOn', 'uCamForward',
  'uCascadeCount', 'uCascadeFar', 'uNormalOffset', 'uShadowTexel', 'uPcf', 'uShadowFar', 'uShadowMat'];
const AO_UNIFORMS = ['uAoOn', 'uAoForward', 'uAoScale'];
const ARTIFICIAL_UNIFORMS = ['uLightCount', 'uLightPos', 'uLightColor', 'uLightShadow', 'uLightShadowTexel', 'uEmissive', 'uShoulder'];
const GEOMETRY_UNIFORMS = ['uViewProj', 'uModel', 'uEye', 'uRight', 'uUp', 'uForward'];

/**
 * Draws the scene, sky and ground with sun shadows, ambient occlusion, artificial lights and glow (port of
 * BimGo.App/Rendering/SceneRenderer.cs; Realistic materials and moved / cloned elements join with their phases).
 */
export class SceneRenderer {
  static readonly FOG_COLOUR = vec3(0.80, 0.85, 0.89);
  private static readonly LIGHT_DIR = V.normalize(vec3(0.35, 0.22, 0.91));
  private static readonly SKY_ZENITH = vec3(0.34, 0.50, 0.70);
  private static readonly GROUND_HALF = 2500;

  private sceneProgram!: ShaderProgram;
  private skyProgram!: ShaderProgram;
  private groundProgram!: ShaderProgram;
  private shadowDepthProgram!: ShaderProgram;
  private shadowTransmitProgram!: ShaderProgram;
  private geometryProgram!: ShaderProgram;
  private groundGeometryProgram!: ShaderProgram;
  private scene: Uniforms = {};
  private sky: Uniforms = {};
  private ground: Uniforms = {};
  private depthU: Uniforms = {};
  private transmitU: Uniforms = {};
  private geometryU: Uniforms = {};
  private groundGeometryU: Uniforms = {};

  private vao: WebGLVertexArrayObject | null = null;
  private emptyVao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private ibo: WebGLBuffer | null = null;
  private emissiveVbo: WebGLBuffer | null = null;
  private placeholders: WebGLTexture[] = [];
  private depthPlaceholder: WebGLTexture | null = null;
  private batches!: SceneBatches;
  private multiDraw: WEBGL_multi_draw | null = null;
  private drawCounts = new Int32Array(1);
  private drawOffsets = new Int32Array(1);
  private degenerate = new Uint32Array(0);
  private readonly identity = Mat4.identity();
  private hasTransparent = false;

  // Sun shadows
  readonly shadows = new ShadowMaps();
  private readonly cascadeDirty = new Array<boolean>(ShadowMaps.MAX_CASCADES).fill(false);
  private cameraForward: Vec3 = vec3(1, 0, 0);
  private shadowsActive = false;
  private readonly shadowMatrices = new Float32Array(16 * ShadowMaps.MAX_CASCADES);

  // Ambient occlusion and glow
  readonly effects = new ScreenEffects();
  private aoActive = false;
  private glowActive = false;
  private aoForward: Vec3 = vec3(1, 0, 0);

  // Artificial lights
  readonly artificial = new ArtificialLighting();
  private readonly lightShadows = new LightShadows();
  private readonly lightSlot = new Int32Array(ArtificialLighting.MAX_LIGHTS);
  private readonly lightsToRender: number[] = [];
  private lightShadowsReported = false;

  /** This frame's sun and sky (set by the session before UpdateShadows). */
  lighting: SunLighting = NO_SUN;

  /** Chunks drawn by the last opaque pass (HUD statistics). */
  chunksDrawn = 0;

  get hasEmissive(): boolean { return this.emissiveVbo !== null; }
  get fogColour(): Vec3 { return this.lighting.enabled ? this.lighting.horizon : SceneRenderer.FOG_COLOUR; }

  // #region Setup

  /** Creates programs and uploads the static scene. */
  initialise(scene: SceneData, batches: SceneBatches): void {
    this.batches = batches;
    this.multiDraw = gl.getExtension('WEBGL_multi_draw');

    this.sceneProgram = ShaderProgram.create('scene', SCENE_VS, SCENE_FS);
    this.skyProgram = ShaderProgram.create('sky', FULLSCREEN_VS, SKY_FS);
    this.groundProgram = ShaderProgram.create('ground', GROUND_VS, GROUND_FS);
    this.shadowDepthProgram = ShaderProgram.create('shadow depth', SHADOW_VS, SHADOW_DEPTH_FS);
    this.shadowTransmitProgram = ShaderProgram.create('shadow glass', SHADOW_VS, SHADOW_TRANSMIT_FS);
    this.geometryProgram = ShaderProgram.create('ao geometry', SCENE_VS, GEOMETRY_FS);
    this.groundGeometryProgram = ShaderProgram.create('ao ground geometry', GROUND_VS, GEOMETRY_GROUND_FS);

    this.scene = locations(this.sceneProgram, ['uViewProj', 'uModel', 'uEye', 'uLightDir', 'uFogColor', 'uFogDensity', 'uWhitecard',
      'uPlan', 'uClipZ', 'uOverride', 'uRealistic', ...LIGHT_UNIFORMS, ...AO_UNIFORMS, ...ARTIFICIAL_UNIFORMS]);
    this.sky = locations(this.skyProgram, ['uInvViewProj', 'uEye', 'uSun', 'uSunDir', 'uZenith', 'uHorizon', 'uSunDisc']);
    this.ground = locations(this.groundProgram, ['uViewProj', 'uCenter', 'uHalf', 'uEye', 'uFogColor', ...LIGHT_UNIFORMS, ...AO_UNIFORMS, ...ARTIFICIAL_UNIFORMS]);
    this.depthU = locations(this.shadowDepthProgram, ['uViewProj', 'uModel']);
    this.transmitU = locations(this.shadowTransmitProgram, ['uViewProj', 'uModel', 'uGlass', 'uWhitecard']);
    this.geometryU = locations(this.geometryProgram, [...GEOMETRY_UNIFORMS, 'uGlow']);
    this.groundGeometryU = locations(this.groundGeometryProgram, [...GEOMETRY_UNIFORMS, 'uCenter', 'uHalf']);
    for (const program of [this.sceneProgram, this.groundProgram]) { assignSamplerUnits(program); }
    for (const [u, program] of [[this.scene, this.sceneProgram], [this.ground, this.groundProgram]] as const) {
      program.use();
      gl.uniform1f(u.uLightShadowTexel, LightShadows.texel);
    }
    gl.useProgram(null);
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

    // Glowing surfaces: a second vertex stream (left disabled when there are none: reads as no glow)
    this.uploadEmissive(scene);

    let maxChunks = 1;
    for (const batch of batches.batches) {
      maxChunks = Math.max(maxChunks, batch.chunkCount);
      if (batch.transparent) { this.hasTransparent = true; }
    }
    this.drawCounts = new Int32Array(maxChunks);
    this.drawOffsets = new Int32Array(maxChunks);

    this.emptyVao = gl.createVertexArray();
    this.shadows.initialise();
    this.effects.initialise();
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
    this.depthPlaceholder = depthArray;
  }

  /** Expands the model's emissive runs to one RGBA8 per vertex and binds it as attribute 3. */
  private uploadEmissive(scene: SceneData): void {
    const runs = scene.lighting.emissive;
    if (runs.length === 0) { return; }
    const perVertex = new Uint32Array(scene.geometry.vertexCount);
    for (const run of runs) { perVertex.fill(run.emissive, run.start, run.start + run.count); }
    this.emissiveVbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.emissiveVbo);
    gl.bufferData(gl.ARRAY_BUFFER, perVertex, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 4, 0);
    gl.bindVertexArray(null);
  }

  // #endregion

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

  // #region Sun and shadows

  /**
   * Brings the shadow maps up to date for this frame (lighting must already be set). Only cascades whose fit, the sun
   * or the scene changed are re-rendered. With the sun off the maps are freed.
   * @returns Null, or a reason shadows could not be shown (the caller switches them off).
   */
  updateShadows(camera: FpsCamera, sceneBounds: Aabb, sceneKey: number, groupVisible: boolean[], whitecard: boolean, preset: ShadowPreset): string | null {
    this.cameraForward = camera.forward;
    this.shadowsActive = false;

    if (!this.lighting.enabled) {
      this.shadows.release();
      this.shadows.bind();
      return null;
    }
    // Sun below the horizon: no direct light, so nothing to shadow (keep the maps for when it rises)
    if (this.lighting.altitudeDegrees < -1) { return null; }

    if (!this.shadows.ensure(preset, this.hasTransparent)) {
      this.shadows.bind();
      return this.shadows.lastError;
    }
    this.shadows.fit(camera, this.lighting.sunDirection, sceneBounds, sceneKey, this.lighting.glass, this.cascadeDirty);

    let rendered = 0;
    for (let c = 0; c < preset.cascades; c++) {
      if (!this.cascadeDirty[c]) { continue; }
      this.renderCascade(c, groupVisible, whitecard);
      rendered++;
    }
    this.shadows.endRender(rendered);

    this.shadowsActive = true;
    this.shadows.bind();
    return null;
  }

  /**
   * Renders one cascade: opaque casters into depth, then glass multiplied into the transmittance layer (only glass in
   * front of the nearest opaque surface counts, so it never tints what lies behind a lit receiver).
   */
  private renderCascade(cascade: number, groupVisible: boolean[], whitecard: boolean): void {
    this.shadows.beginCascade(cascade);
    const matrix = this.shadows.matrices[cascade];
    const planes = this.shadows.planesFor(cascade);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    // Opaque casters: depth only, pushed back a little against acne
    gl.colorMask(false, false, false, false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 3);
    this.shadowDepthProgram.use();
    gl.uniformMatrix4fv(this.depthU.uViewProj, false, matrix);
    gl.uniformMatrix4fv(this.depthU.uModel, false, this.identity);
    this.drawBatches(planes, groupVisible, false, false);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);

    // Glass: multiply the light that gets through (dst = dst × src)
    if (this.shadows.hasTransmit) {
      gl.depthMask(false);
      gl.depthFunc(gl.LESS);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
      this.shadowTransmitProgram.use();
      gl.uniformMatrix4fv(this.transmitU.uViewProj, false, matrix);
      gl.uniformMatrix4fv(this.transmitU.uModel, false, this.identity);
      gl.uniform1f(this.transmitU.uGlass, this.lighting.glass);
      gl.uniform1i(this.transmitU.uWhitecard, whitecard ? 1 : 0);
      this.drawBatches(planes, groupVisible, true, false);
      gl.disable(gl.BLEND);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
    }
    this.shadows.markRendered(cascade);
  }

  /** Sets the sun / shadow block of the scene or ground program for one draw. */
  private applyLight(u: Uniforms, sun: boolean, transmit: boolean): void {
    const l = this.lighting;
    const on = sun && l.enabled;
    gl.uniform1i(u.uSun, on ? 1 : 0);
    if (!on) { return; }

    gl.uniform3f(u.uSunDir, l.sunDirection.x, l.sunDirection.y, l.sunDirection.z);
    gl.uniform3f(u.uSunColor, l.sunColour.x, l.sunColour.y, l.sunColour.z);
    gl.uniform3f(u.uSkyColor, l.skyColour.x, l.skyColour.y, l.skyColour.z);
    gl.uniform1f(u.uShadowStrength, l.shadowStrength);
    gl.uniform1i(u.uShadowsOn, this.shadowsActive ? 1 : 0);
    if (!this.shadowsActive) { return; }

    const preset = this.shadows.current;
    gl.uniform1i(u.uTransmitOn, transmit && this.shadows.hasTransmit ? 1 : 0);
    gl.uniform3f(u.uCamForward, this.cameraForward.x, this.cameraForward.y, this.cameraForward.z);
    gl.uniform1i(u.uCascadeCount, preset.cascades);
    gl.uniform4fv(u.uCascadeFar, this.shadows.cascadeFar);
    gl.uniform4fv(u.uNormalOffset, this.shadows.normalOffset);
    gl.uniform1f(u.uShadowTexel, this.shadows.texel);
    gl.uniform1i(u.uPcf, preset.pcfRadius);
    gl.uniform1f(u.uShadowFar, preset.distance);
    this.shadows.rendered.forEach((m, i) => this.shadowMatrices.set(m, i * 16));
    gl.uniformMatrix4fv(u.uShadowMat, false, this.shadowMatrices);
  }

  // #endregion

  // #region Ambient occlusion, glow and lights

  /**
   * Renders this frame's screen effects (after UpdateShadows): the opaque batches and the ground into the half-res
   * pre-pass with the player camera's culling, then the AO and / or bloom passes. With both off the targets are freed.
   * @returns Null, or a reason the effects could not be shown (the caller switches them off).
   */
  updateScreenEffects(camera: FpsCamera, width: number, height: number, groupVisible: boolean[], groundZ: number, ao: boolean, glow: boolean): string | null {
    glow &&= this.hasEmissive;
    this.aoActive = this.glowActive = false;
    if (!ao && !glow) {
      this.effects.release();
      return null;
    }
    if (!this.effects.ensure(width, height)) {
      this.effects.bind();
      return this.effects.lastError;
    }

    const eye = camera.position, forward = camera.forward, right = camera.right;
    const up = V.normalize(V.cross(right, forward));
    this.effects.beginGeometry(glow);

    this.geometryProgram.use();
    this.applyGeometry(this.geometryU, camera.viewProjection, eye, right, up, forward);
    gl.uniform1f(this.geometryU.uGlow, glow ? 1 : 0);
    this.drawBatches(camera.planes, groupVisible, false, false);

    this.groundGeometryProgram.use();
    this.applyGeometry(this.groundGeometryU, camera.viewProjection, eye, right, up, forward);
    gl.uniform3f(this.groundGeometryU.uCenter, eye.x, eye.y, groundZ);
    gl.uniform1f(this.groundGeometryU.uHalf, SceneRenderer.GROUND_HALF);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    this.effects.compute(camera, ao, glow);
    this.aoForward = forward;
    this.aoActive = ao;
    this.glowActive = glow;
    return null;
  }

  private applyGeometry(u: Uniforms, viewProjection: Matrix4x4, eye: Vec3, right: Vec3, up: Vec3, forward: Vec3): void {
    gl.uniformMatrix4fv(u.uViewProj, false, viewProjection);
    gl.uniformMatrix4fv(u.uModel, false, this.identity);
    gl.uniform3f(u.uEye, eye.x, eye.y, eye.z);
    gl.uniform3f(u.uRight, right.x, right.y, right.z);
    gl.uniform3f(u.uUp, up.x, up.y, up.z);
    gl.uniform3f(u.uForward, forward.x, forward.y, forward.z);
  }

  /** Switches AO and glow off for this frame and frees their targets (after a failure). */
  disableScreenEffects(): void {
    this.aoActive = this.glowActive = false;
    this.effects.release();
  }

  /**
   * Gives this frame's picked lights their shadow maps: renders the few that are new, moved or out of date, then
   * keeps only the lights that have a map (a new light joins, fading in, once its map exists).
   * @returns Null, or (once) why light shadows are unavailable.
   */
  updateLightShadows(groupVisible: boolean[], sceneKey: number): string | null {
    const a = this.artificial;
    if (a.count === 0) {
      if (this.lightShadows.ready) { this.lightShadows.release(); }
      this.lightShadows.bind(this.depthPlaceholder);
      return null;
    }

    if (!this.lightShadows.ensure()) {
      // No maps: light without shadows (said once)
      const error = this.lightShadowsReported ? null : this.lightShadows.lastError;
      this.lightShadowsReported = true;
      for (let k = 0; k < a.count; k++) { a.shadow[k * 4] = -1; }
      this.lightShadows.bind(this.depthPlaceholder);
      return error;
    }

    this.lightShadows.assign(a, sceneKey, this.lightSlot, this.lightsToRender);
    if (this.lightsToRender.length > 0) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.colorMask(false, false, false, false);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.5, 3);
      this.shadowDepthProgram.use();
      gl.uniformMatrix4fv(this.depthU.uModel, false, this.identity);
      for (const k of this.lightsToRender) {
        const x = a.position[k * 4], y = a.position[k * 4 + 1], z = a.position[k * 4 + 2], radius = a.position[k * 4 + 3];
        for (let face = 0; face < 6; face++) {
          const matrix = LightShadows.faceMatrix(vec3(x, y, z), radius, face);
          const planes = this.lightShadows.beginFace(this.lightSlot[k], face, matrix);
          gl.uniformMatrix4fv(this.depthU.uViewProj, false, matrix);
          this.drawBatches(planes, groupVisible, false, false);
        }
        this.lightShadows.markRendered(this.lightSlot[k], x, y, z, radius, sceneKey);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.colorMask(true, true, true, true);
      this.lightShadows.endRender(this.lightsToRender.length);
    }

    // Keep the lights that have a map (order kept: nearest first)
    for (let k = 0; k < a.count; k++) {
      const fade = this.lightShadows.mapFade(this.lightSlot[k]);
      if (fade >= 0) {
        a.shadow[k * 4] = this.lightSlot[k] * 6;
        a.shadow[k * 4 + 1] *= fade;
        continue;
      }
      a.removeAt(k);
      this.lightSlot.copyWithin(k, k + 1, a.count + 1);
      k--;
    }
    this.lightShadows.bind(this.depthPlaceholder);
    return null;
  }

  /** Adds this frame's bloom over the frame (after the transparent pass). */
  compositeGlow(): void {
    if (this.glowActive) { this.effects.compositeGlow(this.artificial.bloom); }
  }

  private applyAo(u: Uniforms, on: boolean): void {
    on &&= this.aoActive;
    gl.uniform1i(u.uAoOn, on ? 1 : 0);
    if (!on) { return; }
    gl.uniform3f(u.uAoForward, this.aoForward.x, this.aoForward.y, this.aoForward.z);
    gl.uniform2f(u.uAoScale, this.effects.scaleX, this.effects.scaleY);
  }

  /** Sets the artificial-light block for one draw (off for the plan minimap: no lights, no glow). */
  private applyArtificial(u: Uniforms, on: boolean): void {
    const a = this.artificial;
    const count = on ? a.count : 0;
    const emissive = on ? a.emissive : 0;
    gl.uniform1i(u.uLightCount, count);
    gl.uniform1f(u.uEmissive, emissive);
    gl.uniform1i(u.uShoulder, count > 0 || emissive > 0 ? 1 : 0);
    if (count === 0) { return; }
    gl.uniform4fv(u.uLightPos, a.position, 0, count * 4);
    gl.uniform4fv(u.uLightColor, a.colour, 0, count * 4);
    gl.uniform4fv(u.uLightShadow, a.shadow, 0, count * 4);
  }

  // #endregion

  // #region Drawing

  /** Draws the gradient sky (no depth). */
  drawSky(camera: FpsCamera): void {
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    this.skyProgram.use();
    const u = this.sky, l = this.lighting;
    gl.uniformMatrix4fv(u.uInvViewProj, false, camera.inverseViewProjection);
    gl.uniform3f(u.uEye, camera.position.x, camera.position.y, camera.position.z);
    gl.uniform1i(u.uSun, l.enabled ? 1 : 0);
    gl.uniform3f(u.uSunDir, l.sunDirection.x, l.sunDirection.y, l.sunDirection.z);
    gl.uniform3f(u.uZenith, l.zenith.x, l.zenith.y, l.zenith.z);
    gl.uniform3f(u.uHorizon, l.horizon.x, l.horizon.y, l.horizon.z);
    gl.uniform3f(u.uSunDisc, l.sunDisc.x, l.sunDisc.y, l.sunDisc.z);
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
    const fog = this.fogColour;
    gl.uniform3f(u.uFogColor, fog.x, fog.y, fog.z);
    this.applyLight(u, true, true);
    this.applyAo(u, true);
    this.applyArtificial(u, true);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Draws all visible batches of one pass with frustum-culled chunks. */
  drawStatic(p: SceneDrawParams, groupVisible: boolean[], transparent: boolean): void {
    if (!transparent) { this.chunksDrawn = 0; }
    this.sceneProgram.use();
    this.applyUniforms(p, 0, 0, 0, 0, !transparent);
    this.drawBatches(p.planes, groupVisible, transparent, true);
  }

  private drawBatches(planes: Float32Array, groupVisible: boolean[], transparent: boolean, countStats: boolean): void {
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
      if (countStats && !transparent) { this.chunksDrawn += drawCount; }
    }
    gl.bindVertexArray(null);
  }

  /** Draws an element again with a colour override (scan highlight). */
  drawElementHighlight(p: SceneDrawParams, element: number, r: number, g: number, b: number, a: number): void {
    this.sceneProgram.use();
    this.applyUniforms(p, r, g, b, a, true);
    gl.bindVertexArray(this.vao);
    const ranges = this.batches.ranges;
    for (const pass of [0, 2]) {
      const start = ranges[element * 4 + pass], count = ranges[element * 4 + pass + 1];
      if (count > 0) { gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, start * 4); }
    }
    gl.bindVertexArray(null);
  }

  private applyUniforms(p: SceneDrawParams, r: number, g: number, b: number, a: number, transmit: boolean): void {
    const u = this.scene;
    gl.uniformMatrix4fv(u.uViewProj, false, p.viewProjection);
    gl.uniformMatrix4fv(u.uModel, false, this.identity);
    gl.uniform3f(u.uEye, p.eye.x, p.eye.y, p.eye.z);
    const l = SceneRenderer.LIGHT_DIR;
    gl.uniform3f(u.uLightDir, l.x, l.y, l.z);
    const fog = p.sun ? this.fogColour : SceneRenderer.FOG_COLOUR;
    gl.uniform3f(u.uFogColor, fog.x, fog.y, fog.z);
    this.applyLight(u, p.sun, transmit);
    // AO follows "transmit": on for opaque surfaces and highlights, off for glass (it isn't in the pre-pass)
    this.applyAo(u, transmit && !p.plan);
    this.applyArtificial(u, !p.plan);
    gl.uniform1f(u.uFogDensity, p.fogDensity);
    gl.uniform1i(u.uWhitecard, p.whitecard ? 1 : 0);
    gl.uniform1i(u.uPlan, p.plan ? 1 : 0);
    gl.uniform2f(u.uClipZ, p.clipZMin, p.clipZMax);
    gl.uniform4f(u.uOverride, r, g, b, a);
    gl.uniform1i(u.uRealistic, 0);
  }

  /** The classic sky's zenith (matches SKY_FS with the sun off). */
  static get skyZenith(): Vec3 { return SceneRenderer.SKY_ZENITH; }

  // #endregion

  /** Releases GL resources. */
  dispose(): void {
    for (const p of [this.sceneProgram, this.skyProgram, this.groundProgram, this.shadowDepthProgram, this.shadowTransmitProgram,
      this.geometryProgram, this.groundGeometryProgram]) { p?.dispose(); }
    this.shadows.dispose();
    this.effects.dispose();
    this.lightShadows.dispose();
    for (const t of this.placeholders) { gl.deleteTexture(t); }
    gl.deleteBuffer(this.emissiveVbo);
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.emptyVao);
  }
}

function locations(program: ShaderProgram, names: string[]): Uniforms {
  const result: Uniforms = {};
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
  // Attribute 3 (emissive) is enabled only when the model glows; disabled it reads (0, 0, 0, 1) = no glow.
}
