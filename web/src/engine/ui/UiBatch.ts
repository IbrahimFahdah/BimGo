import { gl } from '../gl/Gl';
import { ShaderProgram } from '../gl/ShaderProgram';
import { UI_FS, UI_VS } from '../gl/Shaders';
import { FontAtlas, type UiFont } from './UiFont';

/** A UI vertex: x, y, u, v (float32) + packed RGBA8 colour = 20 bytes. */
const VERTEX_SIZE = 20;
const WORDS = VERTEX_SIZE / 4;
const TAU = Math.PI * 2;

/**
 * Rounds half to even, like .NET MathF.Round, so text lands on the same pixels as the desktop app.
 */
export function roundEven(value: number): number {
  const r = Math.round(value);
  return Math.abs(value % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * Immediate-mode 2D batcher: solid shapes and text from one atlas texture, drawn in a single call per flush.
 * Coordinates are device pixels with the origin at the top-left. Port of BimGo.App/Rendering/UiBatch.cs.
 */
export class UiBatch {
  private buffer = new ArrayBuffer(32768 * VERTEX_SIZE);
  private floats = new Float32Array(this.buffer);
  private words = new Uint32Array(this.buffer);
  private count = 0;
  private capacityOnGpu = 0;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private program: ShaderProgram | null = null;
  private screen: WebGLUniformLocation | null = null;
  private atlasUniform: WebGLUniformLocation | null = null;
  private wu = 0;
  private wv = 0;

  /** The atlas (fonts). */
  atlas!: FontAtlas;

  /** UI scale factor (device pixel ratio). */
  scale = 1;

  /** Creates GL objects and the font atlas. */
  initialise(scale: number): void {
    this.program ??= ShaderProgram.create('ui', UI_VS, UI_FS);
    this.screen = this.program.uniform('uScreen');
    this.atlasUniform = this.program.uniform('uAtlas');
    this.rebuildAtlas(scale);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    this.capacityOnGpu = this.capacity;
    gl.bufferData(gl.ARRAY_BUFFER, this.capacityOnGpu * VERTEX_SIZE, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, VERTEX_SIZE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERTEX_SIZE, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, VERTEX_SIZE, 16);
    gl.bindVertexArray(null);
  }

  /** Re-rasterises the fonts for a new scale (the window moved to a screen with another pixel ratio). */
  rebuildAtlas(scale: number): void {
    this.atlas?.dispose();
    this.scale = scale;
    this.atlas = new FontAtlas();
    this.atlas.build(scale);
    this.wu = this.atlas.whiteU;
    this.wv = this.atlas.whiteV;
  }

  private get capacity(): number {
    return this.buffer.byteLength / VERTEX_SIZE;
  }

  // #region Shapes

  /** A filled rectangle. */
  rect(x: number, y: number, w: number, h: number, colour: number): void {
    if (this.clipDepth > 0) {
      this.quad(x, y, x + w, y + h, this.wu, this.wv, this.wu, this.wv, colour);
      return;
    }
    const u = this.wu, v = this.wv;
    this.push(x, y, u, v, colour);
    this.push(x + w, y, u, v, colour);
    this.push(x + w, y + h, u, v, colour);
    this.push(x, y, u, v, colour);
    this.push(x + w, y + h, u, v, colour);
    this.push(x, y + h, u, v, colour);
  }

  /** A rectangle outline. */
  outline(x: number, y: number, w: number, h: number, t: number, colour: number): void {
    this.rect(x, y, w, t, colour);
    this.rect(x, y + h - t, w, t, colour);
    this.rect(x, y + t, t, h - 2 * t, colour);
    this.rect(x + w - t, y + t, t, h - 2 * t, colour);
  }

  /** A panel: translucent fill with a hairline border. */
  panel(x: number, y: number, w: number, h: number, fill: number, border: number): void {
    this.rect(x, y, w, h, fill);
    this.outline(x, y, w, h, Math.max(1, roundEven(this.scale)), border);
  }

  /** A thick line. */
  line(x0: number, y0: number, x1: number, y1: number, width: number, colour: number): void {
    const dx = x1 - x0, dy = y1 - y0;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1e-4) { return; }
    const nx = -dy / length * width * 0.5, ny = dx / length * width * 0.5;
    this.triangle(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, colour);
    this.triangle(x0 + nx, y0 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, colour);
  }

  /** A filled triangle. */
  triangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, colour: number): void {
    if (this.clipDepth > 0) {
      this.clippedTriangle(x0, y0, x1, y1, x2, y2, colour);
      return;
    }
    this.push(x0, y0, this.wu, this.wv, colour);
    this.push(x1, y1, this.wu, this.wv, colour);
    this.push(x2, y2, this.wu, this.wv, colour);
  }

  /** A filled circle. */
  circle(cx: number, cy: number, r: number, colour: number, segments = 20): void {
    let px = cx + r, py = cy;
    for (let i = 1; i <= segments; i++) {
      const a = i * TAU / segments;
      const nx = cx + Math.cos(a) * r, ny = cy + Math.sin(a) * r;
      this.triangle(cx, cy, px, py, nx, ny, colour);
      px = nx;
      py = ny;
    }
  }

  /** A circular ring. */
  ring(cx: number, cy: number, r: number, thickness: number, colour: number, segments = 28): void {
    const ri = r - thickness * 0.5, ro = r + thickness * 0.5;
    for (let i = 0; i < segments; i++) {
      const a0 = i * TAU / segments, a1 = (i + 1) * TAU / segments;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      this.triangle(cx + c0 * ri, cy + s0 * ri, cx + c0 * ro, cy + s0 * ro, cx + c1 * ro, cy + s1 * ro, colour);
      this.triangle(cx + c0 * ri, cy + s0 * ri, cx + c1 * ro, cy + s1 * ro, cx + c1 * ri, cy + s1 * ri, colour);
    }
  }

  /** A filled pie wedge (view cone). */
  wedge(cx: number, cy: number, r: number, angleStart: number, angleEnd: number, colour: number, segments = 12): void {
    const step = (angleEnd - angleStart) / segments;
    for (let i = 0; i < segments; i++) {
      const a0 = angleStart + i * step, a1 = a0 + step;
      this.triangle(cx, cy, cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, colour);
    }
  }

  // #endregion

  // #region Text

  /**
   * Draws text with its top-left at (x, y).
   * @returns The advance width.
   */
  text(font: UiFont, x: number, y: number, text: string, colour: number, tracking = 0): number {
    let pen = roundEven(x);
    const top = roundEven(y);
    for (const ch of text) {
      const glyph = font.get(ch);
      if (!glyph.valid) { continue; }

      if (ch !== ' ') {
        const gx = roundEven(pen + glyph.offsetX), gy = top + glyph.offsetY;
        const gx1 = gx + glyph.width, gy1 = gy + glyph.height;
        this.quad(gx, gy, gx1, gy1, glyph.u0, glyph.v0, glyph.u1, glyph.v1, colour);
      }
      pen += glyph.advance + tracking;
    }
    return pen - roundEven(x);
  }

  /** Measures text width. */
  static measure(font: UiFont, text: string, tracking = 0): number {
    let width = 0;
    for (const ch of text) {
      width += font.get(ch).advance + tracking;
    }
    return width;
  }

  /** Draws text right-aligned to x. */
  textRight(font: UiFont, right: number, y: number, text: string, colour: number, tracking = 0): number {
    const width = UiBatch.measure(font, text, tracking);
    this.text(font, right - width, y, text, colour, tracking);
    return width;
  }

  /** Draws text centred on x. */
  textCentred(font: UiFont, centreX: number, y: number, text: string, colour: number, tracking = 0): number {
    const width = UiBatch.measure(font, text, tracking);
    this.text(font, centreX - width * 0.5, y, text, colour, tracking);
    return width;
  }

  /**
   * Draws text wrapped to a width (word wrap, honours '\n'); returns the height used.
   * Pass draw = false to measure only.
   */
  textWrapped(font: UiFont, x: number, y: number, maxWidth: number, text: string, colour: number, maxLines = 6, draw = true): number {
    const lineHeight = font.lineHeight * 1.15;
    let lines = 0;
    for (const line of wrapLines(font, maxWidth, text, maxLines)) {
      if (draw) { this.text(font, x, y + lines * lineHeight, line, colour); }
      lines++;
    }
    return lines * lineHeight;
  }

  /**
   * Runs the same word wrap as {@link textWrapped} and reports the line count and the width of the last line
   * (used to place a text caret).
   */
  static wrapEnd(font: UiFont, maxWidth: number, text: string, maxLines: number): { lines: number; lastWidth: number } {
    const lines = wrapLines(font, maxWidth, text, maxLines);
    return { lines: lines.length, lastWidth: lines.length > 0 ? UiBatch.measure(font, lines[lines.length - 1]) : 0 };
  }

  // #endregion

  // #region Clipping (polish round P-A1)

  // The clip stack: each entry is the clip rectangle in force before a push. Clipping is done on the CPU as shapes are
  // queued (no scissor, so the single batch is kept): rectangles, glyphs and images are cut with their texture
  // coordinates; triangles are cut to polygons.
  private static readonly MAX_CLIP_DEPTH = 16;
  private readonly clipStack = new Float32Array(UiBatch.MAX_CLIP_DEPTH * 4);
  private clipDepth = 0;
  private clipX0 = 0;
  private clipY0 = 0;
  private clipX1 = 0;
  private clipY1 = 0;

  /** True while a clip rectangle is in force. */
  get clipActive(): boolean { return this.clipDepth > 0; }

  /** Clips what is queued next to a rectangle (intersected with the clip in force) until popClip. */
  pushClip(x: number, y: number, w: number, h: number): void {
    if (this.clipDepth >= UiBatch.MAX_CLIP_DEPTH) { throw new Error('UI clip stack overflow.'); }
    const at = this.clipDepth * 4;
    this.clipStack[at] = this.clipX0;
    this.clipStack[at + 1] = this.clipY0;
    this.clipStack[at + 2] = this.clipX1;
    this.clipStack[at + 3] = this.clipY1;
    let x0 = x, y0 = y, x1 = x + Math.max(w, 0), y1 = y + Math.max(h, 0);
    if (this.clipDepth > 0) {
      x0 = Math.max(x0, this.clipX0);
      y0 = Math.max(y0, this.clipY0);
      x1 = Math.min(x1, this.clipX1);
      y1 = Math.min(y1, this.clipY1);
    }
    this.clipX0 = x0;
    this.clipY0 = y0;
    this.clipX1 = Math.max(x1, x0);
    this.clipY1 = Math.max(y1, y0);
    this.clipDepth++;
  }

  /** Ends the innermost pushClip. */
  popClip(): void {
    if (this.clipDepth === 0) { return; }
    this.clipDepth--;
    const at = this.clipDepth * 4;
    this.clipX0 = this.clipStack[at];
    this.clipY0 = this.clipStack[at + 1];
    this.clipX1 = this.clipStack[at + 2];
    this.clipY1 = this.clipStack[at + 3];
  }

  /** Drops every clip (a frame that ended without popping them all). */
  resetClip(): void { this.clipDepth = 0; }

  /** The clip rectangle in force, or null when none (gamepad focus targets keep the part that shows). */
  getClip(): { x0: number; y0: number; x1: number; y1: number } | null {
    return this.clipDepth === 0 ? null : { x0: this.clipX0, y0: this.clipY0, x1: this.clipX1, y1: this.clipY1 };
  }

  /** True when a point is inside the clip in force (always true without one). */
  clipContains(x: number, y: number): boolean {
    return this.clipDepth === 0 || (x >= this.clipX0 && x < this.clipX1 && y >= this.clipY0 && y < this.clipY1);
  }

  /** An axis-aligned textured quad, cut to the clip with its texture coordinates. */
  private quad(x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number, colour: number): void {
    if (x1 < x0) { [x0, x1] = [x1, x0]; [u0, u1] = [u1, u0]; }
    if (y1 < y0) { [y0, y1] = [y1, y0]; [v0, v1] = [v1, v0]; }
    if (this.clipDepth > 0) {
      if (x1 <= this.clipX0 || x0 >= this.clipX1 || y1 <= this.clipY0 || y0 >= this.clipY1) { return; }
      const w = x1 - x0, h = y1 - y0;
      if (x0 < this.clipX0) { u0 += (u1 - u0) * (this.clipX0 - x0) / w; x0 = this.clipX0; }
      if (x1 > this.clipX1) { u1 -= (u1 - u0) * (x1 - this.clipX1) / (x1 - x0); x1 = this.clipX1; }
      if (y0 < this.clipY0) { v0 += (v1 - v0) * (this.clipY0 - y0) / h; y0 = this.clipY0; }
      if (y1 > this.clipY1) { v1 -= (v1 - v0) * (y1 - this.clipY1) / (y1 - y0); y1 = this.clipY1; }
    }
    this.push(x0, y0, u0, v0, colour);
    this.push(x1, y0, u1, v0, colour);
    this.push(x1, y1, u1, v1, colour);
    this.push(x0, y0, u0, v0, colour);
    this.push(x1, y1, u1, v1, colour);
    this.push(x0, y1, u0, v1, colour);
  }

  private readonly clipAx = new Float32Array(8);
  private readonly clipAy = new Float32Array(8);
  private readonly clipBx = new Float32Array(8);
  private readonly clipBy = new Float32Array(8);

  /** A flat triangle cut to the clip (Sutherland-Hodgman against the four edges, then a fan). */
  private clippedTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, colour: number): void {
    const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2), minY = Math.min(y0, y1, y2), maxY = Math.max(y0, y1, y2);
    if (maxX <= this.clipX0 || minX >= this.clipX1 || maxY <= this.clipY0 || minY >= this.clipY1) { return; }
    if (minX >= this.clipX0 && maxX <= this.clipX1 && minY >= this.clipY0 && maxY <= this.clipY1) {
      this.push(x0, y0, this.wu, this.wv, colour);
      this.push(x1, y1, this.wu, this.wv, colour);
      this.push(x2, y2, this.wu, this.wv, colour);
      return;
    }
    const ax = this.clipAx, ay = this.clipAy, bx = this.clipBx, by = this.clipBy;
    ax[0] = x0; ay[0] = y0; ax[1] = x1; ay[1] = y1; ax[2] = x2; ay[2] = y2;
    let count = 3;
    count = clipEdge(ax, ay, count, bx, by, 0, this.clipX0);
    count = clipEdge(bx, by, count, ax, ay, 1, this.clipX1);
    count = clipEdge(ax, ay, count, bx, by, 2, this.clipY0);
    count = clipEdge(bx, by, count, ax, ay, 3, this.clipY1);
    for (let i = 1; i + 1 < count; i++) {
      this.push(ax[0], ay[0], this.wu, this.wv, colour);
      this.push(ax[i], ay[i], this.wu, this.wv, colour);
      this.push(ax[i + 1], ay[i + 1], this.wu, this.wv, colour);
    }
  }

  // #endregion

  // #region Flush

  private push(x: number, y: number, u: number, v: number, colour: number): void {
    if (this.count === this.capacity) { this.grow(); }
    const i = this.count++ * WORDS;
    this.floats[i] = x;
    this.floats[i + 1] = y;
    this.floats[i + 2] = u;
    this.floats[i + 3] = v;
    this.words[i + 4] = colour;
  }

  private grow(): void {
    const bigger = new ArrayBuffer(this.buffer.byteLength * 2);
    new Uint8Array(bigger).set(new Uint8Array(this.buffer));
    this.buffer = bigger;
    this.floats = new Float32Array(bigger);
    this.words = new Uint32Array(bigger);
  }

  /**
   * Draws a texture (e.g. a bookmark thumbnail) as a rectangle, in order with everything batched so far: what
   * was queued before is drawn first (under it), what is queued after is drawn over it.
   */
  image(texture: WebGLTexture | null, x: number, y: number, w: number, h: number, screenWidth: number, screenHeight: number, tint = 0xffffffff): void {
    if (!texture) { return; }
    this.flushWith(screenWidth, screenHeight, null);
    this.quad(x, y, x + w, y + h, 0, 0, 1, 1, tint);
    this.flushWith(screenWidth, screenHeight, texture);
  }

  /** Draws everything queued and clears the queue. */
  /**
   * Draws what has been queued, laid out on a screen of this size, over a viewport of that size (or, P-C, a bigger
   * one: the legend in a 2–4× photo is drawn k× bigger).
   */
  flush(screenWidth: number, screenHeight: number, viewportWidth = screenWidth, viewportHeight = screenHeight): void {
    this.flushWith(screenWidth, screenHeight, null, viewportWidth, viewportHeight);
  }

  /** Draws what has been queued with the atlas (null) or another texture. */
  private flushWith(screenWidth: number, screenHeight: number, texture: WebGLTexture | null, viewportWidth = screenWidth, viewportHeight = screenHeight): void {
    if (this.count === 0 || !this.program) { return; }

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (this.capacity > this.capacityOnGpu) {
      this.capacityOnGpu = this.capacity;
      gl.bufferData(gl.ARRAY_BUFFER, this.capacityOnGpu * VERTEX_SIZE, gl.STREAM_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.floats, 0, this.count * WORDS);

    this.program.use();
    gl.uniform2f(this.screen, screenWidth, screenHeight);
    gl.uniform1i(this.atlasUniform, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture ?? this.atlas.texture);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, viewportWidth, viewportHeight);

    gl.drawArrays(gl.TRIANGLES, 0, this.count);

    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
    this.count = 0;
  }

  /** Releases GL resources. */
  dispose(): void {
    this.program?.dispose();
    this.atlas?.dispose();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
  }

  // #endregion
}

/** One Sutherland-Hodgman pass: keeps the part of a polygon inside one clip edge (0 left, 1 right, 2 top, 3 bottom). */
function clipEdge(inX: Float32Array, inY: Float32Array, count: number, outX: Float32Array, outY: Float32Array, edge: number, value: number): number {
  if (count === 0) { return 0; }
  const inside = (x: number, y: number) => (edge === 0 ? x >= value : edge === 1 ? x <= value : edge === 2 ? y >= value : y <= value);
  let written = 0;
  let px = inX[count - 1], py = inY[count - 1];
  let pIn = inside(px, py);
  for (let i = 0; i < count; i++) {
    const cx = inX[i], cy = inY[i];
    const cIn = inside(cx, cy);
    if (cIn !== pIn && written < outX.length) {
      const t = edge < 2 ? (value - px) / (cx - px) : (value - py) / (cy - py);
      outX[written] = px + (cx - px) * t;
      outY[written] = py + (cy - py) * t;
      written++;
    }
    if (cIn && written < outX.length) {
      outX[written] = cx;
      outY[written] = cy;
      written++;
    }
    px = cx;
    py = cy;
    pIn = cIn;
  }
  return written;
}

/**
 * The shared word wrap of TextWrapped / WrapEnd: breaks at the last space that fits, or mid-word when a word is
 * wider than the line; honours '\n'; skips leading spaces on each line.
 */
export function wrapLines(font: Pick<UiFont, 'get'>, maxWidth: number, text: string, maxLines: number): string[] {
  const result: string[] = [];
  let start = 0;

  while (start < text.length && result.length < maxLines) {
    while (start < text.length && text[start] === ' ') { start++; }
    if (start >= text.length) { break; }

    let width = 0;
    let i = start, lastSpace = -1;
    while (i < text.length && text[i] !== '\n') {
      const advance = font.get(text[i]).advance;
      if (width + advance > maxWidth && i > start) { break; }
      if (text[i] === ' ') { lastSpace = i; }
      width += advance;
      i++;
    }

    const end = (i >= text.length || text[i] === '\n') ? i : (lastSpace > start ? lastSpace : i);
    result.push(text.slice(start, end));
    start = end < text.length && text[end] === '\n' ? end + 1 : end;
  }
  return result;
}
