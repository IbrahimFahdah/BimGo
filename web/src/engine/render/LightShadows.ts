import { type Matrix4x4, Mat4 } from '../../core/math/Matrix4x4';
import { type Vec3, vec3 } from '../../core/math/Vector';
import { gl } from '../gl/Gl';
import { FpsCamera } from './FpsCamera';

/** The fixtures lit this frame, nearest first (port of BimGo.App/Rendering/ArtificialLighting.cs). */
export class ArtificialLighting {
  static readonly MAX_LIGHTS = 32;

  /** Per light: x, y, z, radius. */
  readonly position = new Float32Array(ArtificialLighting.MAX_LIGHTS * 4);
  /** Per light: r, g, b, downward share. */
  readonly colour = new Float32Array(ArtificialLighting.MAX_LIGHTS * 4);
  /** Per light: first shadow layer (or −1), fade, 0, 0. */
  readonly shadow = new Float32Array(ArtificialLighting.MAX_LIGHTS * 4);
  /** Identity of the light (light index, plus instance id for moved / cloned copies). */
  readonly key = new Float64Array(ArtificialLighting.MAX_LIGHTS);
  count = 0;
  emissive = 0;
  bloom = 0;

  removeAt(k: number): void {
    for (let i = k; i < this.count - 1; i++) {
      this.position.copyWithin(i * 4, (i + 1) * 4, (i + 2) * 4);
      this.colour.copyWithin(i * 4, (i + 1) * 4, (i + 2) * 4);
      this.shadow.copyWithin(i * 4, (i + 1) * 4, (i + 2) * 4);
      this.key[i] = this.key[i + 1];
    }
    this.count--;
  }

  clear(): void {
    this.count = 0;
    this.emissive = 0;
    this.bloom = 0;
  }
}

interface Slot {
  assigned: boolean;
  rendered: boolean;
  key: number;
  sceneKey: number;
  position: Vec3;
  radius: number;
  lastUsed: number;
  readyFrame: number;
}

const emptySlot = (): Slot => ({ assigned: false, rendered: false, key: 0, sceneKey: NaN, position: vec3(), radius: 0, lastUsed: 0, readyFrame: 0 });

/**
 * Cached omnidirectional shadow maps for the nearest lights (port of BimGo.App/Rendering/LightShadows.cs): 32 slots
 * × 6 faces of 256 px depth in one array; a few maps are (re)rendered per frame, new lights fade in once theirs exist.
 */
export class LightShadows {
  static readonly SIZE = 256;
  static readonly UNIT = 5;
  static readonly NEAR = 0.08;
  static readonly PAD = 1.03;
  static readonly LIGHTS_PER_FRAME = 4;
  private static readonly FADE_IN_FRAMES = 8;
  static readonly FACE_FORWARD = [vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1)];
  static readonly FACE_UP = [vec3(0, 0, 1), vec3(0, 0, 1), vec3(0, 0, 1), vec3(0, 0, 1), vec3(0, 1, 0), vec3(0, 1, 0)];

  private readonly slots: Slot[] = Array.from({ length: ArtificialLighting.MAX_LIGHTS }, emptySlot);
  private readonly planes = new Float32Array(24);
  private depth: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private frame = 0;

  ready = false;
  lastError: string | null = null;
  renderedLastFrame = 0;

  static get texel(): number { return 1 / LightShadows.SIZE; }

  ensure(): boolean {
    if (this.ready) { return true; }
    if (this.lastError) { return false; }

    while (gl.getError() !== gl.NO_ERROR) { /* clear stale errors */ }
    const layers = ArtificialLighting.MAX_LIGHTS * 6;
    this.depth = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.depth);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT16, LightShadows.SIZE, LightShadows.SIZE, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, this.depth, 0, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const error = gl.getError();
    if (error !== gl.NO_ERROR || status !== gl.FRAMEBUFFER_COMPLETE) {
      this.lastError = error === gl.OUT_OF_MEMORY
        ? 'Not enough graphics memory for light shadows: lights now pass through walls'
        : `Light shadows are not supported on this graphics device (0x${(error !== gl.NO_ERROR ? error : status).toString(16)}): lights now pass through walls`;
      console.warn(this.lastError);
      this.release();
      return false;
    }

    this.slots.forEach((_, i) => { this.slots[i] = emptySlot(); });
    this.ready = true;
    return true;
  }

  release(): void {
    gl.deleteTexture(this.depth);
    gl.deleteFramebuffer(this.fbo);
    this.depth = this.fbo = null;
    this.slots.forEach((_, i) => { this.slots[i] = emptySlot(); });
    this.ready = false;
  }

  /** Gives this frame's lights a slot each (keeping existing ones) and lists which need their maps rendered. */
  assign(lights: ArtificialLighting, sceneKey: number, slotOf: Int32Array, render: number[]): void {
    this.frame++;
    render.length = 0;
    const count = lights.count;

    // Keep the slots of lights that already have one
    for (let k = 0; k < count; k++) {
      slotOf[k] = this.slots.findIndex(s => s.assigned && s.key === lights.key[k]);
      if (slotOf[k] >= 0) { this.slots[slotOf[k]].lastUsed = this.frame; }
    }

    // New lights take the least recently used free slot
    for (let k = 0; k < count; k++) {
      if (slotOf[k] >= 0) { continue; }
      let best = -1;
      for (let s = 0; s < this.slots.length; s++) {
        if (this.slots[s].lastUsed === this.frame) { continue; }
        if (best < 0 || !this.slots[s].assigned || (this.slots[best].assigned && this.slots[s].lastUsed < this.slots[best].lastUsed)) { best = s; }
        if (!this.slots[best].assigned) { break; }
      }
      if (best < 0) { continue; }
      this.slots[best] = { ...emptySlot(), assigned: true, key: lights.key[k], lastUsed: this.frame };
      slotOf[k] = best;
    }

    // What to render: never-rendered first, then moved / stale (both nearest first)
    for (let pass = 0; pass < 2 && render.length < LightShadows.LIGHTS_PER_FRAME; pass++) {
      for (let k = 0; k < count && render.length < LightShadows.LIGHTS_PER_FRAME; k++) {
        const s = slotOf[k];
        if (s < 0) { continue; }
        const slot = this.slots[s];
        const p = lights.position;
        const stale = slot.sceneKey !== sceneKey || slot.position.x !== p[k * 4] || slot.position.y !== p[k * 4 + 1]
          || slot.position.z !== p[k * 4 + 2] || slot.radius !== p[k * 4 + 3];
        if (pass === 0 ? !slot.rendered : slot.rendered && stale) { render.push(k); }
      }
    }
  }

  static faceMatrix(position: Vec3, radius: number, face: number): Matrix4x4 {
    const f = LightShadows.FACE_FORWARD[face];
    const view = Mat4.createLookAt(position, vec3(position.x + f.x, position.y + f.y, position.z + f.z), LightShadows.FACE_UP[face]);
    const projection = FpsCamera.perspective(2 * Math.atan(LightShadows.PAD), 1, LightShadows.NEAR, Math.max(radius, LightShadows.NEAR * 2));
    return Mat4.multiply(view, projection);
  }

  beginFace(slot: number, face: number, matrix: Matrix4x4): Float32Array {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, this.depth, 0, slot * 6 + face);
    gl.viewport(0, 0, LightShadows.SIZE, LightShadows.SIZE);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    FpsCamera.extractPlanes(matrix, this.planes);
    return this.planes;
  }

  markRendered(slot: number, x: number, y: number, z: number, radius: number, sceneKey: number): void {
    const s = this.slots[slot];
    if (!s.rendered) { s.readyFrame = this.frame; }
    s.rendered = true;
    s.position = vec3(x, y, z);
    s.radius = radius;
    s.sceneKey = sceneKey;
  }

  /** The fade-in (0..1) of a slot's map, or −1 when it has none yet. */
  mapFade(slot: number): number {
    if (slot < 0 || !this.slots[slot].rendered) { return -1; }
    return Math.min(Math.max((this.frame - this.slots[slot].readyFrame + 1) / LightShadows.FADE_IN_FRAMES, 0), 1);
  }

  endRender(lightsRendered: number): void {
    this.renderedLastFrame = lightsRendered;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Binds the maps on their unit (when there are none, the renderer's placeholder stays). */
  bind(placeholder: WebGLTexture | null): void {
    gl.activeTexture(gl.TEXTURE0 + LightShadows.UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ready ? this.depth : placeholder);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    this.release();
  }
}
