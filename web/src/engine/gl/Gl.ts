/**
 * The WebGL2 facade (replaces Native/Gl.cs). Ported code calls the context directly (gl.bindTexture, …), which keeps
 * the same call shape as the desktop Gl.Xxx wrappers; this module owns context creation and the optional extensions.
 */

/** The current context. Set once by {@link initGl}. */
export let gl: WebGL2RenderingContext;

/** Optional features, detected at start-up. */
export const caps = {
  /** Render to RGBA16F / RGBA32F (EXT_color_buffer_float): needed by AO and glow. */
  colorBufferFloat: false,
  /** Linear filtering of RGBA32F textures (OES_texture_float_linear). */
  floatLinear: false,
  /** Anisotropic filtering (EXT_texture_filter_anisotropic); 0 when missing. */
  maxAnisotropy: 0,
  /** The TEXTURE_MAX_ANISOTROPY_EXT enum, when available. */
  anisotropyEnum: 0
};

/** Thrown when the browser or GPU has no WebGL2. */
export class WebGl2UnavailableError extends Error {
  constructor() {
    super('This browser or GPU does not support WebGL2. Try a current Chrome, Edge or Firefox.');
  }
}

/**
 * Creates the context on a canvas and detects the optional extensions.
 */
export function initGl(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const context = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance'
  });
  if (!context) { throw new WebGl2UnavailableError(); }
  gl = context;

  caps.colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null;
  caps.floatLinear = gl.getExtension('OES_texture_float_linear') !== null;
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) {
    caps.anisotropyEnum = aniso.TEXTURE_MAX_ANISOTROPY_EXT;
    caps.maxAnisotropy = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
  }
  return gl;
}
