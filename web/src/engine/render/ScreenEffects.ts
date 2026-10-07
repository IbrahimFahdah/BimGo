import { caps, gl } from '../gl/Gl';
import { ShaderProgram } from '../gl/ShaderProgram';
import { AO_BLUR_FS, AO_FS, FULLSCREEN_VS, GLOW_BLUR_FS, GLOW_COMPOSITE_FS, GLOW_DOWN_FS } from '../gl/Shaders';
import type { FpsCamera } from './FpsCamera';

/**
 * Screen-space ambient occlusion and bloom (port of BimGo.App/Rendering/ScreenEffects.cs): a half-resolution geometry
 * pre-pass (view normal + depth, and glow), AO with a depth-aware blur, and a quarter-resolution blurred glow added
 * over the frame. Needs EXT_color_buffer_float; without it Ensure fails and the caller switches the effects off.
 */
export class ScreenEffects {
  static readonly AO_UNIT = 3;
  static readonly GLOW_UNIT = 4;
  static readonly RADIUS = 0.6;
  static readonly INTENSITY = 3.5;
  static readonly MAX_DEPTH = 120;

  private aoProgram!: ShaderProgram;
  private blurProgram!: ShaderProgram;
  private glowDownProgram!: ShaderProgram;
  private glowBlurProgram!: ShaderProgram;
  private glowCompositeProgram!: ShaderProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};

  private geometryFbo: WebGLFramebuffer | null = null;
  private geometryTexture: WebGLTexture | null = null;
  private geometryDepth: WebGLRenderbuffer | null = null;
  private glowTexture: WebGLTexture | null = null;
  private fboA: WebGLFramebuffer | null = null;
  private textureA: WebGLTexture | null = null;
  private fboB: WebGLFramebuffer | null = null;
  private textureB: WebGLTexture | null = null;
  private glowFboA: WebGLFramebuffer | null = null;
  private glowTextureA: WebGLTexture | null = null;
  private glowFboB: WebGLFramebuffer | null = null;
  private glowTextureB: WebGLTexture | null = null;
  private placeholder: WebGLTexture | null = null;
  private emptyVao: WebGLVertexArrayObject | null = null;
  private aoComputed = false;

  ready = false;
  lastError: string | null = null;
  width = 0;
  height = 0;
  glowWidth = 0;
  glowHeight = 0;
  fullWidth = 0;
  fullHeight = 0;

  initialise(): void {
    this.aoProgram = ShaderProgram.create('ambient occlusion', FULLSCREEN_VS, AO_FS);
    this.blurProgram = ShaderProgram.create('ambient occlusion blur', FULLSCREEN_VS, AO_BLUR_FS);
    this.glowDownProgram = ShaderProgram.create('glow downsample', FULLSCREEN_VS, GLOW_DOWN_FS);
    this.glowBlurProgram = ShaderProgram.create('glow blur', FULLSCREEN_VS, GLOW_BLUR_FS);
    this.glowCompositeProgram = ShaderProgram.create('glow composite', FULLSCREEN_VS, GLOW_COMPOSITE_FS);
    const ao = this.aoProgram, blur = this.blurProgram;
    this.u = {
      aoTan: ao.uniform('uTan'), aoProjScale: ao.uniform('uProjScale'), aoRadius: ao.uniform('uRadius'),
      aoIntensity: ao.uniform('uIntensity'), aoMaxDepth: ao.uniform('uMaxDepth'), blurDir: blur.uniform('uDir'),
      glowDownTexel: this.glowDownProgram.uniform('uTexel'), glowBlurStep: this.glowBlurProgram.uniform('uStep'),
      glowStrength: this.glowCompositeProgram.uniform('uStrength')
    };

    // The AO programs read the AO unit; the glow programs the glow unit (never unit 0: the UI atlas lives there)
    ao.use();
    gl.uniform1i(ao.uniform('uGeometry'), ScreenEffects.AO_UNIT);
    blur.use();
    gl.uniform1i(blur.uniform('uAoInput'), ScreenEffects.AO_UNIT);
    for (const glow of [this.glowDownProgram, this.glowBlurProgram, this.glowCompositeProgram]) {
      glow.use();
      gl.uniform1i(glow.uniform('uGlowInput'), ScreenEffects.GLOW_UNIT);
    }
    gl.useProgram(null);

    // Placeholder: AO = 1 (the shaders don't read it while AO is off, but the sampler must be complete)
    this.placeholder = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.placeholder);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    setFilter(gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.emptyVao = gl.createVertexArray();
    this.bind();
  }

  ensure(fullWidth: number, fullHeight: number): boolean {
    fullWidth = Math.max(fullWidth, 1);
    fullHeight = Math.max(fullHeight, 1);
    if (this.ready && fullWidth === this.fullWidth && fullHeight === this.fullHeight) { return true; }

    this.lastError = null;
    if (!this.allocate(fullWidth, fullHeight)) {
      this.freeTargets();
      this.ready = false;
      return false;
    }
    this.ready = true;
    this.aoComputed = false;
    return true;
  }

  release(): void {
    if (!this.ready) { return; }
    this.freeTargets();
    this.ready = false;
    this.aoComputed = false;
    this.bind();
  }

  private allocate(fullWidth: number, fullHeight: number): boolean {
    if (!caps.colorBufferFloat) {
      this.lastError = 'This browser or GPU cannot render float targets (EXT_color_buffer_float): ambient occlusion and glow are off';
      return false;
    }
    while (gl.getError() !== gl.NO_ERROR) { /* clear stale errors */ }
    this.freeTargets();

    this.fullWidth = fullWidth;
    this.fullHeight = fullHeight;
    this.width = (fullWidth + 1) >> 1;
    this.height = (fullHeight + 1) >> 1;
    this.glowWidth = (this.width + 1) >> 1;
    this.glowHeight = (this.height + 1) >> 1;

    // Geometry: view normal + view depth (32-bit: depth must stay precise far from the eye), and glow
    this.geometryTexture = createTexture(this.width, this.height, gl.RGBA32F, gl.NEAREST);
    this.glowTexture = createTexture(this.width, this.height, gl.RGBA16F, gl.LINEAR);
    this.geometryDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.geometryDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.width, this.height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.geometryFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.geometryFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.geometryTexture, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.glowTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.geometryDepth);
    setDrawBuffers(true);
    let complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

    // AO ping-pong: (AO, view depth)
    this.textureA = createTexture(this.width, this.height, gl.RG16F, gl.NEAREST);
    [this.fboA, complete] = colourTarget(this.textureA, complete);
    this.textureB = createTexture(this.width, this.height, gl.RG16F, gl.NEAREST);
    [this.fboB, complete] = colourTarget(this.textureB, complete);

    // Bloom ping-pong at quarter resolution (linear filtering: the blur and upsample read between texels)
    this.glowTextureA = createTexture(this.glowWidth, this.glowHeight, gl.RGBA16F, gl.LINEAR);
    [this.glowFboA, complete] = colourTarget(this.glowTextureA, complete);
    this.glowTextureB = createTexture(this.glowWidth, this.glowHeight, gl.RGBA16F, gl.LINEAR);
    [this.glowFboB, complete] = colourTarget(this.glowTextureB, complete);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      this.lastError = error === gl.OUT_OF_MEMORY
        ? 'Not enough graphics memory for ambient occlusion and glow: they have been switched off'
        : `Ambient occlusion and glow could not be set up (WebGL error 0x${error.toString(16)}): they have been switched off`;
      console.warn(this.lastError);
      return false;
    }
    if (!complete) {
      this.lastError = 'Ambient occlusion and glow are not supported on this graphics device: they have been switched off';
      console.warn(this.lastError);
      return false;
    }
    return true;
  }

  private freeTargets(): void {
    for (const fbo of [this.geometryFbo, this.fboA, this.fboB, this.glowFboA, this.glowFboB]) { gl.deleteFramebuffer(fbo); }
    for (const t of [this.geometryTexture, this.glowTexture, this.textureA, this.textureB, this.glowTextureA, this.glowTextureB]) { gl.deleteTexture(t); }
    gl.deleteRenderbuffer(this.geometryDepth);
    this.geometryFbo = this.fboA = this.fboB = this.glowFboA = this.glowFboB = null;
    this.geometryTexture = this.glowTexture = this.textureA = this.textureB = this.glowTextureA = this.glowTextureB = null;
    this.geometryDepth = null;
  }

  beginGeometry(glow: boolean): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.geometryFbo);
    setDrawBuffers(glow);
    gl.viewport(0, 0, this.width, this.height);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
  }

  compute(camera: FpsCamera, ao: boolean, glow: boolean): void {
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);
    const u = this.u;

    if (ao) {
      gl.viewport(0, 0, this.width, this.height);
      gl.activeTexture(gl.TEXTURE0 + ScreenEffects.AO_UNIT);

      // AO: geometry → A
      const tanY = Math.tan(camera.fovY * 0.5);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
      gl.bindTexture(gl.TEXTURE_2D, this.geometryTexture);
      this.aoProgram.use();
      gl.uniform2f(u.aoTan, tanY * camera.aspect, tanY);
      gl.uniform1f(u.aoProjScale, 0.5 * this.height / Math.max(tanY, 1e-4));
      gl.uniform1f(u.aoRadius, ScreenEffects.RADIUS);
      gl.uniform1f(u.aoIntensity, ScreenEffects.INTENSITY);
      gl.uniform1f(u.aoMaxDepth, ScreenEffects.MAX_DEPTH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Blur: A → B (horizontal), B → A (vertical)
      this.blurProgram.use();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
      gl.bindTexture(gl.TEXTURE_2D, this.textureA);
      gl.uniform2f(u.blurDir, 1, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
      gl.bindTexture(gl.TEXTURE_2D, this.textureB);
      gl.uniform2f(u.blurDir, 0, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Result on the AO unit for the scene pass
      gl.bindTexture(gl.TEXTURE_2D, this.textureA);
    }
    this.aoComputed = ao;
    if (!ao) {
      gl.activeTexture(gl.TEXTURE0 + ScreenEffects.AO_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.placeholder);
    }

    if (glow) {
      gl.viewport(0, 0, this.glowWidth, this.glowHeight);
      gl.activeTexture(gl.TEXTURE0 + ScreenEffects.GLOW_UNIT);

      // Half-res glow → quarter (A)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.glowFboA);
      gl.bindTexture(gl.TEXTURE_2D, this.glowTexture);
      this.glowDownProgram.use();
      gl.uniform2f(u.glowDownTexel, 1 / this.width, 1 / this.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Blur: A → B (horizontal), B → A (vertical)
      this.glowBlurProgram.use();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.glowFboB);
      gl.bindTexture(gl.TEXTURE_2D, this.glowTextureA);
      gl.uniform2f(u.glowBlurStep, 1 / this.glowWidth, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.glowFboA);
      gl.bindTexture(gl.TEXTURE_2D, this.glowTextureB);
      gl.uniform2f(u.glowBlurStep, 0, 1 / this.glowHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, this.glowTextureA);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Adds the blurred glow over the frame (additive; call after the transparent pass). */
  compositeGlow(strength: number): void {
    if (!this.ready || strength <= 0) { return; }
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.activeTexture(gl.TEXTURE0 + ScreenEffects.GLOW_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.glowTextureA);
    gl.activeTexture(gl.TEXTURE0);
    this.glowCompositeProgram.use();
    gl.uniform1f(this.u.glowStrength, strength);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Puts the AO result (or the placeholder) on the AO unit. */
  bind(): void {
    gl.activeTexture(gl.TEXTURE0 + ScreenEffects.AO_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.ready && this.aoComputed ? this.textureA : this.placeholder);
    gl.activeTexture(gl.TEXTURE0 + ScreenEffects.GLOW_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.placeholder);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Pre-pass size / full size (the scene shader's AO lookup scale). */
  get scaleX(): number { return this.width / Math.max(this.fullWidth, 1); }
  get scaleY(): number { return this.height / Math.max(this.fullHeight, 1); }

  dispose(): void {
    this.freeTargets();
    gl.deleteTexture(this.placeholder);
    gl.deleteVertexArray(this.emptyVao);
    for (const p of [this.aoProgram, this.blurProgram, this.glowDownProgram, this.glowBlurProgram, this.glowCompositeProgram]) { p?.dispose(); }
    this.ready = false;
  }
}

function createTexture(width: number, height: number, internalFormat: GLenum, filter: GLenum): WebGLTexture | null {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
  setFilter(filter);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function colourTarget(texture: WebGLTexture | null, complete: boolean): [WebGLFramebuffer | null, boolean] {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  return [fbo, complete && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE];
}

function setFilter(filter: GLenum): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function setDrawBuffers(glow: boolean): void {
  gl.drawBuffers(glow ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
}
