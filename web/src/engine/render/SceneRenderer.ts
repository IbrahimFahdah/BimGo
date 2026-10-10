import { type Matrix4x4, Mat4 } from '../../core/math/Matrix4x4';
import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import type { Aabb, SceneData } from '../../core/scene/SceneData';
import { SCENE_VERTEX_SIZE } from '../../core/scene/SceneData';
import { gl } from '../gl/Gl';
import { ShaderProgram } from '../gl/ShaderProgram';
import {
  CAP_FS, CAP_STENCIL_FS, CAP_VS, EXPOSURE_FS, FULLSCREEN_VS, GEOMETRY_FS, GEOMETRY_GROUND_FS, GROUND_FS, GROUND_VS, SCENE_FS, SCENE_VS,
  SHADOW_DEPTH_FS, SHADOW_TRANSMIT_FS, SHADOW_VS, SKY_FS
} from '../gl/Shaders';
import type { LocalPlane } from '../../core/scene/SectionCut';
import { FpsCamera } from './FpsCamera';
import { ArtificialLighting, LightShadows } from './LightShadows';
import { MaterialTextures } from './MaterialTextures';
import type { ProxyPack } from './ProxyPack';
import type { DynamicInstance, DynamicSet } from '../physics/DynamicSet';
import type { MaterialData } from '../../core/scene/MaterialData';
import type { SceneBatches } from './SceneBatches';
import { ScreenEffects } from './ScreenEffects';
import { ShadowMaps, type ShadowPreset } from './ShadowMaps';
import { ReflectionProbes } from './ReflectionProbes';
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
  /** Realistic: reflections on glass, mirrors, shiny surfaces and water. */
  reflections?: boolean;
  /** Lowest reflection tier that reflects, 0.25 or 0.5 (glass and water always reflect). */
  reflectThreshold?: number;
  /** Reflection strength multiplier (0.5–2). */
  reflectGain?: number;
  /** Debug colours instead of the material: 0 off, 1 reflection tiers, 2 reflection probe cells. */
  reflectDebug?: number;
  /** Reflect the reflection probes where they exist (else the sky). */
  probes?: boolean;
  /** Seconds since the session started (water ripples). */
  time?: number;
  /** Realistic: 0 = Revit tint off, 1 = multiply. */
  tintMode?: number;
  /** Apply the section cut (setSection): the player's view and highlights only. */
  section?: boolean;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

/**
 * Texture units, as on the desktop: sun shadows 1–2, AO 3, glow 4, light shadows 5, material table 6, image arrays
 * 7–10, reflection probes 11–13. Every sampler a program declares gets its unit once at link time and always has a
 * valid texture bound, so WebGL never sees two sampler types on one unit or an incomplete sampler (both
 * INVALID_OPERATION at draw time).
 */
const UNIT = {
  shadowMap: 1, transmit: 2, aoMap: 3, lightShadowMap: 5, materialTable: 6, tex0: 7,
  probeArray: ReflectionProbes.ARRAY_UNIT, probeGrid: ReflectionProbes.GRID_UNIT, probeData: ReflectionProbes.DATA_UNIT
} as const;
const PROBE_UNIFORMS = ['uReflectThreshold', 'uReflectGain', 'uReflectDebug', 'uTime', 'uProbesOn', 'uProbeGridOrigin', 'uProbeGridCell',
  'uProbeGridSize', 'uProbeMaxLod'];

const LIGHT_UNIFORMS = ['uSun', 'uSunDir', 'uSunColor', 'uSkyColor', 'uShadowStrength', 'uShadowsOn', 'uTransmitOn', 'uCamForward',
  'uCascadeCount', 'uCascadeFar', 'uNormalOffset', 'uShadowTexel', 'uPcf', 'uShadowFar', 'uShadowMat'];
const AO_UNIFORMS = ['uAoOn', 'uAoForward', 'uAoScale'];
const ARTIFICIAL_UNIFORMS = ['uLightCount', 'uLightPos', 'uLightColor', 'uLightShadow', 'uLightShadowTexel', 'uEmissive', 'uShoulder'];
const GEOMETRY_UNIFORMS = ['uViewProj', 'uModel', 'uEye', 'uRight', 'uUp', 'uForward'];
const CLIP_UNIFORMS = ['uClipCount', 'uClipPlanes'];

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
  private colour2dPlaceholder: WebGLTexture | null = null;
  private batches!: SceneBatches;
  private multiDraw: WEBGL_multi_draw | null = null;
  private drawCounts = new Int32Array(1);
  private drawOffsets = new Int32Array(1);
  private degenerate = new Uint32Array(0);
  private readonly identity = Mat4.identity();
  private hasTransparent = false;

  // Moved / cloned elements: their triangles copied once into a small index buffer, drawn with a model matrix
  private dynamicVao: WebGLVertexArrayObject | null = null;
  private dynamicIbo: WebGLBuffer | null = null;
  private dynamicIndices: number[] = [];
  private readonly dynamicRanges = new Map<number, [number, number, number, number]>();
  private dynamicDirty = false;

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

  // Realistic materials
  readonly materials = new MaterialTextures();
  private materialVbo: WebGLBuffer | null = null;
  private uvVbo: WebGLBuffer | null = null;
  /** Null, or why some textures could not be shown. */
  materialWarning: string | null = null;
  /** Proxy suggestions for missing images (the "Proxy textures for missing images" setting). */
  autoProxy = true;

  // Reflection probes (Realistic mode, reflections set to probes)
  readonly probes = new ReflectionProbes();
  private readonly probeFaces: [number, number][] = [];
  private sceneData: SceneData | null = null;
  private probesActive = false;
  private probeErrorReported = false;
  private colourArrayPlaceholder: WebGLTexture | null = null;

  // Section cut: planes for the scene and geometry passes, and the cap programs
  private readonly clipPlanes = new Float32Array(4 * 7);
  private clipCount = 0;
  private clipBox = false;
  private capStencilProgram!: ShaderProgram;
  private capProgram!: ShaderProgram;
  private capStencilU: Uniforms = {};
  private capU: Uniforms = {};
  private capVao: WebGLVertexArrayObject | null = null;
  private capVbo: WebGLBuffer | null = null;
  private readonly capCorners = new Float32Array(6 * 3);

  // Photo mode exposure
  private exposureProgram!: ShaderProgram;
  private exposureColour: WebGLUniformLocation | null = null;

  /** This frame's sun and sky (set by the session before UpdateShadows). */
  lighting: SunLighting = NO_SUN;

  /** Chunks drawn by the last opaque pass (HUD statistics). */
  chunksDrawn = 0;

  get hasEmissive(): boolean { return this.emissiveVbo !== null; }
  get hasMaterials(): boolean { return this.materialVbo !== null && this.materials.ready; }
  get fogColour(): Vec3 { return this.lighting.enabled ? this.lighting.horizon : SceneRenderer.FOG_COLOUR; }

  // #region Setup

  /** Creates programs and uploads the static scene. */
  initialise(scene: SceneData, batches: SceneBatches): void {
    this.batches = batches;
    this.sceneData = scene;
    this.multiDraw = gl.getExtension('WEBGL_multi_draw');

    this.sceneProgram = ShaderProgram.create('scene', SCENE_VS, SCENE_FS);
    this.skyProgram = ShaderProgram.create('sky', FULLSCREEN_VS, SKY_FS);
    this.groundProgram = ShaderProgram.create('ground', GROUND_VS, GROUND_FS);
    this.shadowDepthProgram = ShaderProgram.create('shadow depth', SHADOW_VS, SHADOW_DEPTH_FS);
    this.shadowTransmitProgram = ShaderProgram.create('shadow glass', SHADOW_VS, SHADOW_TRANSMIT_FS);
    this.geometryProgram = ShaderProgram.create('ao geometry', SCENE_VS, GEOMETRY_FS);
    this.groundGeometryProgram = ShaderProgram.create('ao ground geometry', GROUND_VS, GEOMETRY_GROUND_FS);

    this.scene = locations(this.sceneProgram, ['uViewProj', 'uModel', 'uEye', 'uLightDir', 'uFogColor', 'uFogDensity', 'uWhitecard',
      'uPlan', 'uClipZ', 'uOverride', 'uRealistic', 'uReflections', 'uTintMode', 'uSkyZenith', 'uSkyHorizon', ...PROBE_UNIFORMS, ...LIGHT_UNIFORMS,
      ...AO_UNIFORMS, ...ARTIFICIAL_UNIFORMS, ...CLIP_UNIFORMS]);
    this.sky = locations(this.skyProgram, ['uInvViewProj', 'uEye', 'uSun', 'uSunDir', 'uZenith', 'uHorizon', 'uSunDisc']);
    this.ground = locations(this.groundProgram, ['uViewProj', 'uCenter', 'uHalf', 'uEye', 'uFogColor', ...LIGHT_UNIFORMS, ...AO_UNIFORMS, ...ARTIFICIAL_UNIFORMS]);
    this.depthU = locations(this.shadowDepthProgram, ['uViewProj', 'uModel']);
    this.transmitU = locations(this.shadowTransmitProgram, ['uViewProj', 'uModel', 'uGlass', 'uWhitecard']);
    this.geometryU = locations(this.geometryProgram, [...GEOMETRY_UNIFORMS, 'uGlow', ...CLIP_UNIFORMS]);
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
    this.uploadMaterialStreams(scene);
    this.createDynamicVao();

    let maxChunks = 1;
    for (const batch of batches.batches) {
      maxChunks = Math.max(maxChunks, batch.chunkCount);
      if (batch.transparent) { this.hasTransparent = true; }
    }
    this.drawCounts = new Int32Array(maxChunks);
    this.drawOffsets = new Int32Array(maxChunks);

    this.emptyVao = gl.createVertexArray();
    this.initialiseSection();
    this.initialisePhoto();
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
    bind(UNIT.probeArray, gl.TEXTURE_2D_ARRAY, colourArray);
    bind(UNIT.probeGrid, gl.TEXTURE_2D_ARRAY, colourArray);
    bind(UNIT.probeData, gl.TEXTURE_2D, colour2d);
    gl.activeTexture(gl.TEXTURE0);
    this.placeholders = [depthArray, colourArray, colour2d];
    this.colourArrayPlaceholder = colourArray;
    this.colour2dPlaceholder = colour2d;
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

  /** The VAO for moved / cloned elements: the same vertex streams, its own index buffer. */
  private createDynamicVao(): void {
    this.dynamicVao = gl.createVertexArray();
    gl.bindVertexArray(this.dynamicVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    setVertexLayout();
    if (this.emissiveVbo) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.emissiveVbo);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 4, 0);
    }
    if (this.materialVbo) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.materialVbo);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.UNSIGNED_SHORT, false, 2, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvVbo);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 8, 0);
    }
    this.dynamicIbo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.dynamicIbo);
    gl.bindVertexArray(null);
  }

  /** Makes an element's triangles available to the dynamic pass (copied once per source element; clones share them). */
  ensureDynamicGeometry(element: number): void {
    if (this.dynamicRanges.has(element)) { return; }
    const r = this.batches.ranges, src = this.batches.indices;
    const opaqueStart = this.dynamicIndices.length, opaqueCount = r[element * 4 + 1];
    for (let i = 0; i < opaqueCount; i++) { this.dynamicIndices.push(src[r[element * 4] + i]); }
    const transparentStart = this.dynamicIndices.length, transparentCount = r[element * 4 + 3];
    for (let i = 0; i < transparentCount; i++) { this.dynamicIndices.push(src[r[element * 4 + 2] + i]); }
    this.dynamicRanges.set(element, [opaqueStart, opaqueCount, transparentStart, transparentCount]);
    this.dynamicDirty = true;
  }

  private flushDynamic(): void {
    if (!this.dynamicDirty) { return; }
    this.dynamicDirty = false;
    gl.bindVertexArray(this.dynamicVao);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint32Array.from(this.dynamicIndices), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
  }

  /** Draws the active moved / cloned elements of one pass with the scene program. */
  drawDynamic(p: SceneDrawParams, set: DynamicSet | null, transparent: boolean): void {
    if (!set || set.instances.length === 0) { return; }
    this.flushDynamic();
    this.sceneProgram.use();
    this.applyUniforms(p, 0, 0, 0, 0, !transparent);
    this.drawDynamicInstances(set, p.planes, transparent, this.scene.uModel);
  }

  /** Draws a moved / cloned element again with a colour override (highlights). */
  drawDynamicHighlight(p: SceneDrawParams, instance: DynamicInstance, r: number, g: number, b: number, a: number): void {
    if (!this.dynamicRanges.has(instance.element)) { return; }
    this.flushDynamic();
    this.sceneProgram.use();
    this.applyUniforms(p, r, g, b, a, true);
    gl.bindVertexArray(this.dynamicVao);
    this.drawDynamicRange(instance, false, this.scene.uModel);
    this.drawDynamicRange(instance, true, this.scene.uModel);
    gl.uniformMatrix4fv(this.scene.uModel, false, this.identity);
    gl.bindVertexArray(null);
  }

  private drawDynamicInstances(set: DynamicSet, planes: Float32Array, transparent: boolean, modelUniform: WebGLUniformLocation | null): void {
    gl.bindVertexArray(this.dynamicVao);
    for (const instance of set.instances) {
      if (!set.isActive(instance) || !this.dynamicRanges.has(instance.element)) { continue; }
      if (!FpsCamera.isVisible(planes, instance.worldBounds)) { continue; }
      this.drawDynamicRange(instance, transparent, modelUniform);
    }
    gl.uniformMatrix4fv(modelUniform, false, this.identity);
    gl.bindVertexArray(null);
  }

  private drawDynamicRange(instance: DynamicInstance, transparent: boolean, modelUniform: WebGLUniformLocation | null): void {
    const range = this.dynamicRanges.get(instance.element)!;
    const start = transparent ? range[2] : range[0], count = transparent ? range[3] : range[1];
    if (count <= 0) { return; }
    gl.uniformMatrix4fv(modelUniform, false, instance.model);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, start * 4);
  }

  /** Moved / cloned elements for the passes below (set by the session each frame). */
  dynamics: DynamicSet | null = null;

  /**
   * Realistic mode: the per-vertex material index (ushort → float, attribute 4) and surface coordinates (float2,
   * attribute 5). Skipped when the file has no materials.
   */
  private uploadMaterialStreams(scene: SceneData): void {
    const m = scene.materials;
    const vertices = scene.geometry.vertexCount;
    if (m.materials.length === 0 || m.vertexMaterial.length !== vertices) { return; }
    gl.bindVertexArray(this.vao);
    this.materialVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.materialVbo);
    gl.bufferData(gl.ARRAY_BUFFER, m.vertexMaterial, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.UNSIGNED_SHORT, false, 2, 0);
    this.uvVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvVbo);
    gl.bufferData(gl.ARRAY_BUFFER, m.vertexUv.length === vertices * 2 ? m.vertexUv : new Float32Array(vertices * 2), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
  }

  /**
   * Builds (or rebuilds, from the Textures panel) the material table and texture arrays. Asynchronous: Realistic
   * shows material colours until it resolves.
   * @returns Null, or a short reason the textures couldn't all be shown.
   */
  async loadMaterials(materials: MaterialData, proxies: ProxyPack | null): Promise<string | null> {
    if (this.materialVbo === null || materials.materials.length === 0) { return null; }
    this.materialWarning = await this.materials.initialise(materials, proxies, this.autoProxy);
    return this.materialWarning;
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
    this.flushDynamic();
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
    if (this.dynamics && this.dynamics.instances.length > 0) { this.drawDynamicInstances(this.dynamics, planes, false, this.depthU.uModel); }
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
      if (this.dynamics && this.dynamics.instances.length > 0) { this.drawDynamicInstances(this.dynamics, planes, true, this.transmitU.uModel); }
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
    this.applyClip(this.geometryU, true);
    this.flushDynamic();
    this.drawBatches(camera.planes, groupVisible, false, false);
    if (this.dynamics && this.dynamics.instances.length > 0) { this.drawDynamicInstances(this.dynamics, camera.planes, false, this.geometryU.uModel); }

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
      this.flushDynamic();
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
          if (this.dynamics && this.dynamics.instances.length > 0) { this.drawDynamicInstances(this.dynamics, planes, false, this.depthU.uModel); }
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

  /**
   * Reflection probes for this frame (after the shadow maps, light maps and screen effects, before binding the scene
   * target): places them and allocates their textures the first time, then captures this frame's few faces. A capture
   * is the normal scene draw (sky, opaque, moved elements, ground, glass) from the probe, without AO or reflections.
   * With probes not wanted the textures are freed.
   * @param wanted Reflections set to probes (or the probe debug colours): keeps the probes allocated.
   * @param capture They are shown now (Realistic mode): bake this frame's faces.
   * @returns Null, or (once) why probes can't be shown (the caller switches to sky reflections).
   */
  updateReflectionProbes(wanted: boolean, capture: boolean, size: number, eye: Vec3, template: SceneDrawParams, groupVisible: boolean[],
    groundZ: number): string | null {
    this.probesActive = false;
    if (!wanted || !this.hasMaterials || !this.sceneData) {
      if (this.probes.ready) {
        this.probes.release();
        this.bindProbePlaceholders();
      }
      return null;
    }
    if (!this.probes.ensure(this.sceneData, size)) {
      const error = this.probes.lastError;
      if (error === null || this.probeErrorReported) { return null; }
      this.probeErrorReported = true;
      this.bindProbePlaceholders();
      return error;
    }
    this.probeErrorReported = false;

    if (!capture) { return null; }
    this.probes.nextFaces(eye, this.probeFaces);
    if (this.probeFaces.length > 0) { this.captureProbeFaces(template, groupVisible, groundZ); }
    this.probes.bind();
    this.probesActive = this.probes.bakedCount > 0;
    return null;
  }

  /** Marks every probe stale (a moment after the sun, lights, colour mode or the model changed). */
  invalidateProbes(): void {
    this.probes.invalidate();
  }

  /** Lets probes try again after a failure (the user switched them on again). */
  retryProbes(): void {
    this.probes.clearError();
    this.probeErrorReported = false;
  }

  private bindProbePlaceholders(): void {
    gl.activeTexture(gl.TEXTURE0 + UNIT.probeArray);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.colourArrayPlaceholder);
    gl.activeTexture(gl.TEXTURE0 + UNIT.probeGrid);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.colourArrayPlaceholder);
    gl.activeTexture(gl.TEXTURE0 + UNIT.probeData);
    gl.bindTexture(gl.TEXTURE_2D, this.colour2dPlaceholder);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Captures this frame's probe faces with the scene program. */
  private captureProbeFaces(template: SceneDrawParams, groupVisible: boolean[], groundZ: number): void {
    this.flushDynamic();
    const aoWas = this.aoActive;
    this.aoActive = false;
    const p: SceneDrawParams = {
      ...template, reflections: false, probes: false, reflectDebug: 0, plan: false, sun: true, clipZMin: -1e7, clipZMax: 1e7
    };
    const clear = this.fogColour;
    const dynamics = this.dynamics;
    const hasDynamics = dynamics !== null && dynamics.instances.length > 0;

    for (const [probe, face] of this.probeFaces) {
      const { matrix, eye, planes } = this.probes.faceMatrix(probe, face);
      this.probes.beginFace(probe, face, clear, this.colourArrayPlaceholder);
      this.drawSkyView(Mat4.invert(matrix) ?? Mat4.identity(), eye);

      p.viewProjection = matrix;
      p.planes = planes;
      p.eye = eye;
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(true);

      this.sceneProgram.use();
      this.applyUniforms(p, 0, 0, 0, 0, true);
      this.drawBatches(planes, groupVisible, false, false);
      if (hasDynamics) { this.drawDynamicInstances(dynamics, planes, false, this.scene.uModel); }
      this.drawGroundView(matrix, eye, groundZ);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      this.sceneProgram.use();
      this.applyUniforms(p, 0, 0, 0, 0, false);
      this.drawBatches(planes, groupVisible, true, false);
      if (hasDynamics) { this.drawDynamicInstances(dynamics, planes, true, this.scene.uModel); }
      gl.depthMask(true);
      gl.disable(gl.BLEND);

      this.probes.endFace(probe, face);
    }
    this.aoActive = aoWas;
    this.probes.endCapture();
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
    this.drawSkyView(camera.inverseViewProjection, camera.position);
  }

  /** Draws the gradient sky (no depth) for any view (the camera, or a probe face). */
  private drawSkyView(inverseViewProjection: Matrix4x4, eye: Vec3): void {
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    this.skyProgram.use();
    const u = this.sky, l = this.lighting;
    gl.uniformMatrix4fv(u.uInvViewProj, false, inverseViewProjection);
    gl.uniform3f(u.uEye, eye.x, eye.y, eye.z);
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
    this.drawGroundView(camera.viewProjection, camera.position, groundZ);
  }

  /** Draws the ground plane for any view (the camera, or a probe face). */
  private drawGroundView(viewProjection: Matrix4x4, eye: Vec3, groundZ: number): void {
    this.groundProgram.use();
    const u = this.ground;
    gl.uniformMatrix4fv(u.uViewProj, false, viewProjection);
    gl.uniform3f(u.uCenter, eye.x, eye.y, groundZ);
    gl.uniform1f(u.uHalf, SceneRenderer.GROUND_HALF);
    gl.uniform3f(u.uEye, eye.x, eye.y, eye.z);
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
    const dir = SceneRenderer.LIGHT_DIR;
    gl.uniform3f(u.uLightDir, dir.x, dir.y, dir.z);
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
    this.applyClip(u, p.section === true);
    gl.uniform4f(u.uOverride, r, g, b, a);

    const realistic = p.realistic && !p.whitecard && this.hasMaterials;
    gl.uniform1i(u.uRealistic, realistic ? 1 : 0);
    if (!realistic) { return; }
    this.materials.bind();
    gl.uniform1i(u.uReflections, p.reflections ? 1 : 0);
    gl.uniform1f(u.uReflectThreshold, p.reflectThreshold && p.reflectThreshold > 0 ? p.reflectThreshold : 0.5);
    gl.uniform1f(u.uReflectGain, p.reflectGain && p.reflectGain > 0 ? p.reflectGain : 1);
    gl.uniform1i(u.uReflectDebug, p.reflectDebug ?? 0);
    gl.uniform1f(u.uTime, p.time ?? 0);
    const probes = (p.probes === true || p.reflectDebug === 2) && this.probesActive;
    gl.uniform1i(u.uProbesOn, probes ? 1 : 0);
    if (probes) {
      const origin = this.probes.origin, cell = this.probes.cell, size = this.probes.gridSize;
      gl.uniform3f(u.uProbeGridOrigin, origin.x, origin.y, origin.z);
      gl.uniform3f(u.uProbeGridCell, cell.x, cell.y, cell.z);
      gl.uniform3f(u.uProbeGridSize, size.x, size.y, size.z);
      gl.uniform1f(u.uProbeMaxLod, this.probes.maxLod);
    }
    gl.uniform1i(u.uTintMode, p.tintMode ?? 1);
    const l = this.lighting;
    const zenith = l.enabled ? l.zenith : SceneRenderer.SKY_ZENITH, horizon = l.enabled ? l.horizon : SceneRenderer.FOG_COLOUR;
    gl.uniform3f(u.uSkyZenith, zenith.x, zenith.y, zenith.z);
    gl.uniform3f(u.uSkyHorizon, horizon.x, horizon.y, horizon.z);
  }

  /** The classic sky's zenith (matches SKY_FS with the sun off). */
  static get skyZenith(): Vec3 { return SceneRenderer.SKY_ZENITH; }

  // #endregion

  // #region Section cut (port of SceneRenderer.Section.cs)

  // The scene and geometry pre-pass shaders discard what the cut's planes remove; drawSectionCaps fills the cut
  // solids. Shadows, light shadows and reflection probes ignore the cut (the whole building still casts and reflects).
  // Caps, per plane whose cut-away side holds the eye: (1) the opaque scene cut by that plane alone is drawn into the
  // stencil with INVERT, no colour, no depth test, so a pixel stays odd when its ray, from the plane on, ends inside a
  // solid; (2) the cap polygon (the box face, or a large square on the free plane, cut by the other planes) is drawn
  // where the stencil is odd, depth-tested, in one flat colour.

  private initialiseSection(): void {
    this.capStencilProgram = ShaderProgram.create('section stencil', SCENE_VS, CAP_STENCIL_FS);
    this.capStencilU = locations(this.capStencilProgram, ['uViewProj', 'uModel', 'uCapPlane', 'uCapShade']);
    this.capProgram = ShaderProgram.create('section cap', CAP_VS, CAP_FS);
    this.capU = locations(this.capProgram, ['uViewProj', 'uClipCount', 'uClipPlanes', 'uSkip', 'uColor']);
    gl.useProgram(null);

    this.capVao = gl.createVertexArray();
    gl.bindVertexArray(this.capVao);
    this.capVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.capVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.capCorners.byteLength, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
  }

  /**
   * Sets the cut for the coming frames (scene-local (n, d), n·p > d cut away; box faces first when box, then the free
   * plane). An empty list removes the cut.
   */
  setSection(planes: readonly LocalPlane[], box: boolean): void {
    this.clipCount = Math.min(planes.length, 7);
    for (let i = 0; i < this.clipCount; i++) {
      const p = planes[i];
      this.clipPlanes.set([p.x, p.y, p.z, p.w], i * 4);
    }
    this.clipBox = box && this.clipCount >= 6;
  }

  get hasSection(): boolean { return this.clipCount > 0; }

  /** Uploads the cut (or none) to the current program. */
  private applyClip(u: Uniforms, on: boolean): void {
    const count = on ? this.clipCount : 0;
    gl.uniform1i(u.uClipCount, count);
    if (count > 0) { gl.uniform4fv(u.uClipPlanes, this.clipPlanes, 0, count * 4); }
  }

  /**
   * Fills the cut solids (after the opaque scene, before the ground; the target must have a stencil).
   * @param colour The caps' flat colour (RGB 0–1).
   * @param extent Half size of the free plane's cap square (m): larger than the model.
   */
  drawSectionCaps(viewProjection: Matrix4x4, frustum: Float32Array, eye: Vec3, groupVisible: boolean[], dynamics: DynamicSet | null,
    colour: Vec3, extent: number): void {
    if (this.clipCount === 0) { return; }
    this.flushDynamic();
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    const cp = this.clipPlanes;
    for (let i = 0; i < this.clipCount; i++) {
      const o = i * 4;
      if (cp[o] * eye.x + cp[o + 1] * eye.y + cp[o + 2] * eye.z <= cp[o + 3]) { continue; } // the eye is on the kept side

      // (1) Parity of the scene cut by this plane alone
      gl.clearStencil(0);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.colorMask(false, false, false, false);
      gl.depthMask(false);
      gl.disable(gl.DEPTH_TEST);
      gl.stencilFunc(gl.ALWAYS, 0, 1);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      this.capStencilProgram.use();
      gl.uniformMatrix4fv(this.capStencilU.uViewProj, false, viewProjection);
      gl.uniformMatrix4fv(this.capStencilU.uModel, false, this.identity);
      gl.uniform4f(this.capStencilU.uCapPlane, cp[o], cp[o + 1], cp[o + 2], cp[o + 3]);
      gl.uniform1f(this.capStencilU.uCapShade, 1);
      this.drawBatches(frustum, groupVisible, false, false);
      if (dynamics && dynamics.instances.length > 0) { this.drawDynamicInstances(dynamics, frustum, false, this.capStencilU.uModel); }

      gl.colorMask(true, true, true, true);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.stencilFunc(gl.EQUAL, 1, 1);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

      // (2) The cap polygon in the flat cap colour
      if (!this.capPolygon(i, eye, extent)) { continue; }
      gl.depthMask(true);
      this.capProgram.use();
      gl.uniformMatrix4fv(this.capU.uViewProj, false, viewProjection);
      gl.uniform1i(this.capU.uClipCount, this.clipCount);
      gl.uniform4fv(this.capU.uClipPlanes, cp, 0, this.clipCount * 4);
      gl.uniform1i(this.capU.uSkip, i);
      gl.uniform4f(this.capU.uColor, colour.x, colour.y, colour.z, 1);
      gl.bindVertexArray(this.capVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.capVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.capCorners);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    }
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  }

  /** The cap polygon of plane i as two triangles: a box face, or a square of half size extent around the eye's foot on a free plane. */
  private capPolygon(i: number, eye: Vec3, extent: number): boolean {
    const cp = this.clipPlanes;
    if (this.clipBox && i < 6) {
      const min = [-cp[7], -cp[15], -cp[23]], max = [cp[3], cp[11], cp[19]];
      const axis = i >> 1, at = i % 2 === 0 ? max[axis] : min[axis];
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const corner = (a: number, b: number): Vec3 => {
        const c = [0, 0, 0];
        c[axis] = at;
        c[u] = a;
        c[v] = b;
        return vec3(c[0], c[1], c[2]);
      };
      this.quad(corner(min[u], min[v]), corner(max[u], min[v]), corner(max[u], max[v]), corner(min[u], max[v]));
      return true;
    }
    const o = i * 4;
    const normal = vec3(cp[o], cp[o + 1], cp[o + 2]);
    if (V.lengthSquared(normal) < 1e-8) { return false; }
    const centre = V.sub(eye, V.scale(normal, V.dot(normal, eye) - cp[o + 3]));
    const tangent = Math.abs(normal.z) < 0.9 ? V.normalize(V.cross(vec3(0, 0, 1), normal)) : V.normalize(V.cross(vec3(1, 0, 0), normal));
    const bitangent = V.cross(normal, tangent);
    const a = V.scale(tangent, extent), b = V.scale(bitangent, extent);
    this.quad(V.sub(V.sub(centre, a), b), V.sub(V.add(centre, a), b), V.add(V.add(centre, a), b), V.add(V.sub(centre, a), b));
    return true;
  }

  private quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    let k = 0;
    for (const p of [a, b, c, a, c, d]) {
      this.capCorners[k++] = p.x;
      this.capCorners[k++] = p.y;
      this.capCorners[k++] = p.z;
    }
  }

  // #endregion

  // #region Photo exposure (port of SceneRenderer.Photo.cs)

  private initialisePhoto(): void {
    this.exposureProgram = ShaderProgram.create('photo exposure', FULLSCREEN_VS, EXPOSURE_FS);
    this.exposureColour = this.exposureProgram.uniform('uColor');
    gl.useProgram(null);
  }

  /** Scales the colours already in the bound target by 2^ev (no-op at 0); brightening in steps of at most ×2. */
  applyExposure(ev: number): void {
    if (Math.abs(ev) < 0.01) { return; }
    let factor = Math.pow(2, Math.min(Math.max(ev, -3), 3));
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    this.exposureProgram.use();
    gl.bindVertexArray(this.emptyVao);
    if (factor < 1) {
      gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      gl.uniform3f(this.exposureColour, factor, factor, factor);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.blendFunc(gl.DST_COLOR, gl.ONE);
      while (factor > 1.001) {
        const step = Math.min(factor, 2);
        gl.uniform3f(this.exposureColour, step - 1, step - 1, step - 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        factor /= step;
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  // #endregion

  /** Releases GL resources. */
  dispose(): void {
    for (const p of [this.sceneProgram, this.skyProgram, this.groundProgram, this.shadowDepthProgram, this.shadowTransmitProgram,
      this.geometryProgram, this.groundGeometryProgram, this.capStencilProgram, this.capProgram, this.exposureProgram]) { p?.dispose(); }
    gl.deleteBuffer(this.capVbo);
    gl.deleteVertexArray(this.capVao);
    this.shadows.dispose();
    this.effects.dispose();
    this.lightShadows.dispose();
    this.probes.dispose();
    this.materials.dispose();
    gl.deleteBuffer(this.materialVbo);
    gl.deleteBuffer(this.uvVbo);
    for (const t of this.placeholders) { gl.deleteTexture(t); }
    gl.deleteBuffer(this.emissiveVbo);
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.emptyVao);
    gl.deleteVertexArray(this.dynamicVao);
    gl.deleteBuffer(this.dynamicIbo);
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
  set('uProbeArray', UNIT.probeArray);
  set('uProbeGrid', UNIT.probeGrid);
  set('uProbeData', UNIT.probeData);
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
