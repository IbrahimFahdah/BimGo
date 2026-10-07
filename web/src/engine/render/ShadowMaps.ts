import { type Matrix4x4, Mat4 } from '../../core/math/Matrix4x4';
import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import type { Aabb } from '../../core/scene/SceneData';
import { gl } from '../gl/Gl';
import { FpsCamera } from './FpsCamera';

/** Shadow quality (port of ShadowQuality). */
export enum ShadowQuality {
  Low = 0,
  Medium = 1,
  High = 2
}

/** Cascades, map size, PCF radius, distance covered (port of ShadowMaps.Preset). */
export interface ShadowPreset {
  cascades: number;
  size: number;
  pcfRadius: number;
  distance: number;
}

export function shadowPresetFor(quality: ShadowQuality): ShadowPreset {
  switch (quality) {
    case ShadowQuality.Low: return { cascades: 1, size: 2048, pcfRadius: 0, distance: 60 };
    case ShadowQuality.High: return { cascades: 4, size: 3072, pcfRadius: 2, distance: 200 };
    default: return { cascades: 3, size: 2048, pcfRadius: 1, distance: 120 };
  }
}

const samePreset = (a: ShadowPreset, b: ShadowPreset) => a.cascades === b.cascades && a.size === b.size && a.pcfRadius === b.pcfRadius && a.distance === b.distance;
const sameMatrix = (a: Matrix4x4, b: Matrix4x4) => a.every((v, i) => v === b[i]);

/**
 * Cascaded sun shadow maps with glass transmittance (port of BimGo.App/Rendering/ShadowMaps.cs): a depth array (one
 * layer per cascade) and, when the model has glass, a colour array of the light that gets through.
 */
export class ShadowMaps {
  static readonly DEPTH_UNIT = 1;
  static readonly TRANSMIT_UNIT = 2;
  static readonly MAX_CASCADES = 4;

  private depth: WebGLTexture | null = null;
  private transmit: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private size = 1;
  private withTransmit = false;

  readonly matrices: Matrix4x4[] = Array.from({ length: ShadowMaps.MAX_CASCADES }, () => Mat4.identity());
  readonly rendered: Matrix4x4[] = Array.from({ length: ShadowMaps.MAX_CASCADES }, () => Mat4.identity());
  private readonly valid = new Array<boolean>(ShadowMaps.MAX_CASCADES).fill(false);
  readonly cascadeFar = new Float32Array(ShadowMaps.MAX_CASCADES);
  readonly normalOffset = new Float32Array(ShadowMaps.MAX_CASCADES);
  private readonly planes = new Float32Array(24);
  private readonly corners: Vec3[] = Array.from({ length: 8 }, () => vec3());

  private renderedSun: Vec3 = vec3(NaN, NaN, NaN);
  private renderedSceneKey = Number.NaN;
  private renderedGlass = -1;
  private frame = 0;

  current: ShadowPreset = shadowPresetFor(ShadowQuality.Medium);
  ready = false;
  lastError: string | null = null;
  renderedLastFrame = 0;

  get texel(): number { return 1 / Math.max(this.size, 1); }
  get hasTransmit(): boolean { return this.withTransmit && this.ready; }

  initialise(): void {
    this.fbo = gl.createFramebuffer();
    this.allocate(1, 1, false);
    this.ready = false;
  }

  /** Makes the maps match a preset; false (with lastError) when the GPU can't. */
  ensure(preset: ShadowPreset, withTransmit: boolean): boolean {
    if (this.ready && samePreset(preset, this.current) && withTransmit === this.withTransmit) { return true; }
    this.lastError = null;
    this.current = preset;
    if (!this.allocate(preset.size, preset.cascades, withTransmit)) {
      this.allocate(1, 1, false);
      this.ready = false;
      return false;
    }
    this.ready = true;
    this.invalidate();
    console.info(`Shadow maps: ${preset.cascades} × ${preset.size} px${withTransmit ? ' + glass' : ''}, ${preset.distance} m.`);
    return true;
  }

  /** Frees the big maps (sun off), keeping valid 1 × 1 placeholders bound. */
  release(): void {
    if (!this.ready) { return; }
    this.allocate(1, 1, false);
    this.ready = false;
  }

  invalidate(): void {
    this.valid.fill(false);
    this.renderedSceneKey = Number.NaN;
  }

  private allocate(size: number, layers: number, withTransmit: boolean): boolean {
    while (gl.getError() !== gl.NO_ERROR) { /* clear stale errors */ }
    gl.deleteTexture(this.depth);
    gl.deleteTexture(this.transmit);

    this.depth = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.depth);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT24, size, size, layers);
    setParameters(gl.TEXTURE_2D_ARRAY, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

    // Transmittance needs the same size as the depth it is tested against; without glass a 1×1 white layer set
    this.transmit = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.transmit);
    if (withTransmit) {
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, size, size, layers);
    } else {
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(layers * 4).fill(255));
    }
    setParameters(gl.TEXTURE_2D_ARRAY, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      this.lastError = error === gl.OUT_OF_MEMORY
        ? 'Not enough graphics memory for shadows at this quality: try a lower quality'
        : `Shadow maps could not be created (WebGL error 0x${error.toString(16)})`;
      console.warn(this.lastError);
      return false;
    }

    this.size = size;
    this.withTransmit = withTransmit;

    // A complete framebuffer for the first layer means every layer works
    if (size > 1) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      this.attachLayer(0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        this.lastError = `Shadow framebuffer incomplete (0x${status.toString(16)}): shadows are not supported on this graphics device`;
        console.warn(this.lastError);
        return false;
      }
    }
    return true;
  }

  private attachLayer(layer: number): void {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, this.depth, 0, layer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.withTransmit ? this.transmit : null, 0, this.withTransmit ? layer : 0);
    gl.drawBuffers([this.withTransmit ? gl.COLOR_ATTACHMENT0 : gl.NONE]);
    gl.readBuffer(this.withTransmit ? gl.COLOR_ATTACHMENT0 : gl.NONE);
  }

  /**
   * Fits each cascade around its slice of the view frustum and marks which ones need rendering: all of them after a
   * change of sun, scene or glass; otherwise cascade c every (c + 1)th frame when its fit moved.
   */
  fit(camera: FpsCamera, sun: Vec3, sceneBounds: Aabb, sceneKey: number, glass: number, dirty: boolean[]): void {
    const preset = this.current;
    this.frame++;
    const everything = !V.isFinite(this.renderedSun) || sun.x !== this.renderedSun.x || sun.y !== this.renderedSun.y || sun.z !== this.renderedSun.z
      || sceneKey !== this.renderedSceneKey || Math.abs(glass - this.renderedGlass) > 1e-4;

    // Light view: looking down the sun's rays (an "up" that isn't parallel to them)
    const up = Math.abs(sun.z) > 0.99 ? vec3(0, 1, 0) : vec3(0, 0, 1);
    const lightView = Mat4.createLookAt(vec3(), V.scale(sun, -1), up);

    // Casters: the scene's depth range along the light (with a margin for moved / cloned elements)
    const min = V.sub(sceneBounds.min, vec3(5, 5, 5)), max = V.add(sceneBounds.max, vec3(5, 5, 5));
    let casterMin = Number.MAX_VALUE, casterMax = -Number.MAX_VALUE;
    for (let i = 0; i < 8; i++) {
      const corner = vec3((i & 1) === 0 ? min.x : max.x, (i & 2) === 0 ? min.y : max.y, (i & 4) === 0 ? min.z : max.z);
      const z = Mat4.transformPoint(corner, lightView).z;
      casterMin = Math.min(casterMin, z);
      casterMax = Math.max(casterMax, z);
    }

    const near = FpsCamera.NEAR, far = preset.distance;
    const tanY = Math.tan(camera.fovY * 0.5), tanX = tanY * camera.aspect;
    const forward = camera.forward, right = camera.right;
    const cameraUp = V.normalize(V.cross(right, forward));

    let sliceNear = near;
    for (let c = 0; c < preset.cascades; c++) {
      // Practical split (mostly logarithmic near the eye, linear further out)
      const t = (c + 1) / preset.cascades;
      const logSplit = near * Math.pow(far / near, t);
      const linSplit = near + (far - near) * t;
      const sliceFar = c === preset.cascades - 1 ? far : 0.8 * logSplit + 0.2 * linSplit;
      this.cascadeFar[c] = sliceFar;

      // Bounding sphere of the slice (its radius depends only on the slice, so it never wobbles)
      let centre = vec3();
      for (let i = 0; i < 8; i++) {
        const d = (i & 4) === 0 ? sliceNear : sliceFar;
        const sx = (i & 1) === 0 ? -1 : 1, sy = (i & 2) === 0 ? -1 : 1;
        this.corners[i] = V.add(V.add(V.add(camera.position, V.scale(forward, d)), V.scale(right, sx * d * tanX)), V.scale(cameraUp, sy * d * tanY));
        centre = V.add(centre, this.corners[i]);
      }
      centre = V.scale(centre, 1 / 8);
      let radius = 0;
      for (const corner of this.corners) { radius = Math.max(radius, V.distance(centre, corner)); }
      radius = Math.ceil(radius * 4) / 4;

      // Snap the centre to whole texels in light space
      const texelWorld = 2 * radius / this.size;
      const centreLight = Mat4.transformPoint(centre, lightView);
      centreLight.x = Math.floor(centreLight.x / texelWorld) * texelWorld;
      centreLight.y = Math.floor(centreLight.y / texelWorld) * texelWorld;

      // Depth: from the nearest caster to the far side of the slice (view looks down -Z)
      const zNear = -Math.max(casterMax, centreLight.z + radius) - 1;
      const zFar = -Math.min(casterMin, centreLight.z - radius) + 1;
      const projection = orthographicOffCenter(centreLight.x - radius, centreLight.x + radius, centreLight.y - radius, centreLight.y + radius, zNear, zFar);

      this.matrices[c] = Mat4.multiply(lightView, projection);
      this.normalOffset[c] = texelWorld * 1.5;
      dirty[c] = everything || !this.valid[c] || (!sameMatrix(this.rendered[c], this.matrices[c]) && this.frame % (c + 1) === 0);
      sliceNear = sliceFar;
    }
    for (let c = preset.cascades; c < ShadowMaps.MAX_CASCADES; c++) {
      this.cascadeFar[c] = 0;
      dirty[c] = false;
    }

    if (everything) {
      this.renderedSun = V.copy(sun);
      this.renderedSceneKey = sceneKey;
      this.renderedGlass = glass;
    }
  }

  beginCascade(cascade: number): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    this.attachLayer(cascade);
    gl.viewport(0, 0, this.size, this.size);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.clearColor(1, 1, 1, 1);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT | (this.withTransmit ? gl.COLOR_BUFFER_BIT : 0));
  }

  markRendered(cascade: number): void {
    this.rendered[cascade] = Float32Array.from(this.matrices[cascade]);
    this.valid[cascade] = true;
  }

  endRender(renderedCount: number): void {
    this.renderedLastFrame = renderedCount;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
  }

  planesFor(cascade: number): Float32Array {
    FpsCamera.extractPlanes(this.matrices[cascade], this.planes);
    return this.planes;
  }

  bind(): void {
    gl.activeTexture(gl.TEXTURE0 + ShadowMaps.DEPTH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.depth);
    gl.activeTexture(gl.TEXTURE0 + ShadowMaps.TRANSMIT_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.transmit);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    gl.deleteTexture(this.depth);
    gl.deleteTexture(this.transmit);
    gl.deleteFramebuffer(this.fbo);
    this.depth = this.transmit = this.fbo = null;
  }
}

function setParameters(target: GLenum, filter: GLenum): void {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** OpenGL-style off-centre orthographic projection in the row-vector layout. */
function orthographicOffCenter(left: number, right: number, bottom: number, top: number, near: number, far: number): Matrix4x4 {
  return Float32Array.of(
    2 / (right - left), 0, 0, 0,
    0, 2 / (top - bottom), 0, 0,
    0, 0, -2 / (far - near), 0,
    -(right + left) / (right - left), -(top + bottom) / (top - bottom), -(far + near) / (far - near), 1);
}
