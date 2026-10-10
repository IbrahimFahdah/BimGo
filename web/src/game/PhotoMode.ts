import { Mat4, type Matrix4x4 } from '../core/math/Matrix4x4';
import { type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import { Panorama } from '../core/scene/Panorama';
import { gl } from '../engine/gl/Gl';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { downloadBlob, safeFileName } from '../platform/files';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import { Widgets } from './Menus';

const PHOTO_KINDS = ['STILL', '360°'];
const PHOTO_SCALES = ['1×', '2×', '3×', '4×'];
const PHOTO_FORMATS = ['PNG', 'JPEG'];
const PANO_SIZES = ['4K', '8K'];
/** Field of view of each panorama view (degrees): wider than 90° so the stitch never reads an edge. */
const PANO_FACE_FOV = 96;

/** An off-screen target the photo renders into: RGBA8 colour, depth + stencil (section caps). */
class PhotoTarget {
  framebuffer: WebGLFramebuffer | null = null;
  private colour: WebGLRenderbuffer | null = null;
  private depth: WebGLRenderbuffer | null = null;
  width = 0;
  height = 0;

  ensure(width: number, height: number): boolean {
    if (this.framebuffer && this.width === width && this.height === height) { return true; }
    this.dispose();
    this.width = width;
    this.height = height;
    this.colour = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.colour);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
    this.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.colour);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) { this.dispose(); }
    return complete;
  }

  /** The colour as bottom-up RGBA. */
  read(): Uint8Array {
    const pixels = new Uint8Array(this.width * this.height * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    return pixels;
  }

  dispose(): void {
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteRenderbuffer(this.colour);
    gl.deleteRenderbuffer(this.depth);
    this.framebuffer = this.colour = this.depth = null;
    this.width = this.height = 0;
  }
}

/**
 * Photo mode (port of GameSession.Photo.cs). M opens it: the UI goes except the photo panel and an optional thirds
 * grid, the player stands still (RMB-drag looks, the wheel changes the field of view), and Enter (or TAKE PHOTO)
 * shoots.
 * - Still: the view rendered off-screen at 1–4× the window (one pass, so AO, bloom and shadows match the preview),
 *   PNG or JPEG.
 * - 360°: six 96° views from the eye stitched into a 2:1 equirectangular JPEG (4K or 8K) with Photo Sphere metadata.
 * Exposure (−3 to +3 EV) applies to the preview and the photo. Files go to the browser's downloads.
 */
export class PhotoMode {
  open = false;
  /** The field of view while open (the setting comes back on close). */
  fov = 90;
  exposure = 0;
  private kind = 0;
  private scale = 2;
  private jpeg = false;
  private eightK = false;
  private grid = true;
  /** Frames until the shot (one frame shows "RENDERING…" first). */
  private shotIn = 0;
  private busy = false;
  private notice: string | null = null;
  private panelRect = [0, 0, 0, 0];
  private readonly w: Widgets;
  private target: PhotoTarget | null = null;

  constructor(private readonly session: GameSession) {
    this.w = new Widgets(session);
  }

  private s(v: number): number { return this.session.s(v); }

  // #region Open / close

  show(): void {
    const session = this.session;
    if (this.open) { return; }
    if (session.paused) { session.setPaused(false); }
    session.closeModes(this);
    session.showUi();
    this.open = true;
    this.fov = session.settings.fieldOfView;
    this.notice = null;
    session.releaseMouseForTyping();
    session.sound.play(SoundId.UiClick);
  }

  close(): void {
    if (!this.open) { return; }
    this.open = false;
    this.shotIn = 0;
    this.session.input.releaseAll();
  }

  /** M / Esc close, Enter shoots, RMB-drag looks, the wheel changes the field of view, [ ] the sun time. */
  updateMode(input: InputState): void {
    const session = this.session;
    if (input.isPressed(Vk.ESCAPE) || input.isPressed(Vk.key('M'))) {
      this.close();
      return;
    }
    if (input.isPressed(Vk.RETURN)) { this.request(); }
    if (input.rightDown) { session.player.look(input.mouseDeltaX, input.mouseDeltaY, session.settings.mouseSensitivity, session.settings.invertY); }
    const [px, py, pw, ph] = this.panelRect;
    const overPanel = input.mouseX >= px && input.mouseX < px + pw && input.mouseY >= py && input.mouseY < py + ph;
    if (input.wheel !== 0 && this.kind === 0 && !overPanel) { this.fov = Math.min(Math.max(this.fov - Math.sign(input.wheel) * 2, 30), 120); }
    if (session.sun.enabled && input.isPressedOrRepeated(Vk.OEM_4)) { session.stepSunTime(input.isDown(Vk.SHIFT) ? -1 : -5); }
    if (session.sun.enabled && input.isPressedOrRepeated(Vk.OEM_6)) { session.stepSunTime(input.isDown(Vk.SHIFT) ? 1 : 5); }
  }

  private request(): void {
    if (this.shotIn > 0 || this.busy) { return; }
    this.shotIn = 2;
    this.notice = null;
  }

  /** Called at the start of each frame's render: renders a due shot off-screen (camera restored afterwards). */
  renderPending(): void {
    if (this.shotIn <= 0 || --this.shotIn > 0) { return; }
    const session = this.session, camera = session.camera;
    const saved = {
      position: camera.position, yaw: camera.yaw, pitch: camera.pitch, fov: camera.horizontalFovDegrees,
      width: camera.viewportWidth, height: camera.viewportHeight, aspect: camera.aspect
    };
    try {
      const maxSize = Math.min(16384, Math.max(1024, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number),
        ...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array));
      if (this.kind === 0) { this.takeStill(maxSize); } else { this.takePanorama(maxSize, saved.yaw); }
      session.flash(0x60ffffff, 0.15);
      session.sound.play(SoundId.UiClick);
    } catch (e) {
      console.warn('Photo failed', e);
      this.notice = 'The photo failed: ' + (e instanceof Error ? e.message : String(e));
      session.sound.play(SoundId.Error);
    } finally {
      camera.clearCustomView();
      camera.position = saved.position;
      camera.yaw = saved.yaw;
      camera.pitch = saved.pitch;
      camera.horizontalFovDegrees = saved.fov;
      camera.viewportWidth = saved.width;
      camera.viewportHeight = saved.height;
      camera.aspect = saved.aspect;
      camera.update();
      this.target?.dispose();
      this.target = null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  // #endregion

  // #region Shots

  /** A still at the chosen multiple of the window (reduced to what the GPU allows). */
  private takeStill(maxSize: number): void {
    const session = this.session, camera = session.camera;
    let scale = Math.min(Math.max(this.scale, 1), 4);
    let width = session.screenWidth * scale, height = session.screenHeight * scale;
    while (scale > 1 && (width > maxSize || height > maxSize)) {
      scale--;
      width = session.screenWidth * scale;
      height = session.screenHeight * scale;
    }
    camera.viewportWidth = width;
    camera.viewportHeight = height;
    camera.aspect = width / Math.max(height, 1);
    camera.update();
    const pixels = this.renderView(width, height);

    const jpeg = this.jpeg;
    const name = this.fileName(jpeg ? '.jpg' : '.png', ` ${width}x${height}`);
    const reduced = scale < this.scale ? ` (reduced to ${scale}× for this GPU)` : '';
    this.notice = 'Saving…';
    this.busy = true;
    void encode(pixels, width, height, true, jpeg).then(blob => {
      downloadBlob(blob, name);
      this.notice = `Saved ${name}${reduced} (your Downloads folder)`;
    }).catch(e => {
      console.warn('Photo could not be saved', e);
      this.notice = 'The photo could not be saved: ' + (e instanceof Error ? e.message : String(e));
    }).finally(() => { this.busy = false; });
  }

  /** A 360° panorama: six 96° views from the eye, stitched into an equirectangular JPEG with Photo Sphere metadata. */
  private takePanorama(maxSize: number, heading: number): void {
    const session = this.session, camera = session.camera;
    const width = this.eightK ? 8192 : 4096, height = width / 2;
    const face = Math.min(Panorama.faceSize(width, PANO_FACE_FOV), maxSize);
    const eye = camera.position;
    const forward = vec3(Math.cos(heading), Math.sin(heading), 0);
    const left = vec3(-forward.y, forward.x, 0);
    const up = vec3(0, 0, 1), down = vec3(0, 0, -1);
    const forwards = [forward, left, V.scale(forward, -1), V.scale(left, -1), up, down];
    const ups = [up, up, up, up, V.scale(forward, -1), forward];

    const faces: Uint8Array[] = [];
    const matrices: Matrix4x4[] = [];
    camera.horizontalFovDegrees = PANO_FACE_FOV;
    camera.viewportWidth = face;
    camera.viewportHeight = face;
    camera.aspect = 1;
    for (let i = 0; i < 6; i++) {
      camera.setCustomView(forwards[i], ups[i]);
      camera.update();
      matrices.push(Float32Array.from(camera.viewProjection));
      faces.push(this.renderView(face, face));
    }

    const name = this.fileName('.jpg', ` 360 ${this.eightK ? '8K' : '4K'}`);
    this.notice = 'Stitching the 360…';
    this.busy = true;
    void stitch(faces, matrices, forwards, eye, face, width, height, heading)
      .then(rgba => encode(rgba, width, height, false, true))
      .then(async blob => {
        const bytes = Panorama.addPhotoSphereXmp(new Uint8Array(await blob.arrayBuffer()), width, height);
        downloadBlob(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), name);
        this.notice = `Saved ${name} (360°: open it on a phone or in a panorama viewer)`;
      })
      .catch(e => {
        console.warn('Panorama could not be saved', e);
        this.notice = 'The 360 could not be saved: ' + (e instanceof Error ? e.message : String(e));
      })
      .finally(() => { this.busy = false; });
  }

  /** Renders the camera's current view off-screen and reads it back (bottom-up RGBA). */
  private renderView(width: number, height: number): Uint8Array {
    this.target ??= new PhotoTarget();
    if (!this.target.ensure(width, height)) { throw new Error(`the GPU refused a ${width} × ${height} target`); }
    this.session.renderScene(width, height, this.target.framebuffer, true);
    return this.target.read();
  }

  /** "<model> photo <kind> <time>.ext". */
  private fileName(extension: string, kind: string): string {
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    return `${safeFileName(this.session.scene.modelTitle)} photo${kind} ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
      `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}${extension}`;
  }

  // #endregion

  // #region Panel

  /** The thirds grid (stills), "RENDERING…" while a shot is due, and the panel. */
  buildOverlay(f: FontAtlas, input: InputState, width: number, height: number): void {
    const session = this.session, ui = session.ui, w = this.w;
    if (!input.leftDown) { w.activeSlider = -1; }
    if (this.grid && this.kind === 0) {
      const line = Rgba.hex(0xffffff, 0.35);
      for (let i = 1; i < 3; i++) {
        ui.rect(width * i / 3, 0, Math.max(1, ui.scale), height, line);
        ui.rect(0, height * i / 3, width, Math.max(1, ui.scale), line);
      }
    } else if (this.kind === 1) {
      ui.textCentred(f.body, width * 0.5, height * 0.5 + this.s(20), '360° from where you stand · the centre faces this way', Rgba.hex(0xffffff, 0.8));
    }
    if (this.shotIn > 0) {
      ui.panel(width * 0.5 - this.s(120), height * 0.5 - this.s(30), this.s(240), this.s(60), UiTheme.PANEL_STRONG, UiTheme.ACCENT);
      ui.textCentred(f.bold, width * 0.5, height * 0.5 - this.s(8), this.kind === 0 ? 'RENDERING…' : 'RENDERING 360…', UiTheme.TEXT);
    }

    const pw = this.s(320), x = width - this.s(20) - pw, y = this.s(20), ph = this.s(434);
    this.panelRect = [x, y, pw, ph];
    ui.panel(x, y, pw, ph, UiTheme.PANEL_STRONG, UiTheme.ACCENT);
    const ix = x + this.s(16), iw = pw - this.s(32);
    let cy = y + this.s(14);
    ui.text(f.small, ix, cy, 'PHOTO MODE', UiTheme.ACCENT, this.s(1.4));
    cy += this.s(26);
    ui.textWrapped(f.small, ix, cy, iw, 'RMB-drag looks · wheel: field of view · Enter: take', UiTheme.TEXT_MUTED, 1);
    cy += this.s(24);

    this.kind = w.segmented(f, ix, cy, iw, PHOTO_KINDS, this.kind);
    cy += this.s(42);

    if (this.kind === 0) {
      ui.text(f.body, ix, cy + this.s(7), 'Size', UiTheme.TEXT_SOFT);
      this.scale = w.segmented(f, ix + this.s(90), cy, iw - this.s(90), PHOTO_SCALES, this.scale - 1) + 1;
      cy += this.s(36);
      ui.text(f.small, ix + this.s(90), cy, `${session.screenWidth * this.scale} × ${session.screenHeight * this.scale} px`, UiTheme.TEXT_FAINT);
      cy += this.s(22);
      ui.text(f.body, ix, cy + this.s(7), 'Format', UiTheme.TEXT_SOFT);
      this.jpeg = w.segmented(f, ix + this.s(90), cy, iw - this.s(90), PHOTO_FORMATS, this.jpeg ? 1 : 0) === 1;
      cy += this.s(40);
      ui.text(f.body, ix, cy + this.s(7), 'View', UiTheme.TEXT_SOFT);
      this.fov = w.stepper(f, ix + this.s(90), cy, this.fov, 5, 30, 120, 0, '° wide');
      cy += this.s(38);
    } else {
      ui.text(f.body, ix, cy + this.s(7), 'Size', UiTheme.TEXT_SOFT);
      this.eightK = w.segmented(f, ix + this.s(90), cy, iw - this.s(90), PANO_SIZES, this.eightK ? 1 : 0) === 1;
      cy += this.s(36);
      ui.text(f.small, ix + this.s(90), cy, this.eightK ? '8192 × 4096 px JPEG' : '4096 × 2048 px JPEG', UiTheme.TEXT_FAINT);
      cy += this.s(22 + 78);
    }

    ui.text(f.body, ix, cy + this.s(7), 'Exposure', UiTheme.TEXT_SOFT);
    this.exposure = w.stepper(f, ix + this.s(90), cy, this.exposure, 0.5, -3, 3, 1, ' EV');
    cy += this.s(38);

    if (session.sun.enabled) {
      ui.text(f.body, ix, cy + this.s(7), 'Sun', UiTheme.TEXT_SOFT);
      if (w.smallButton(f, ix + this.s(90), cy, this.s(30), this.s(30), '−')) { session.stepSunTime(-15); }
      const minutes = session.sun.settings.time.minutes;
      ui.textCentred(f.bold, ix + this.s(90) + this.s(94), cy + this.s(6), `${Math.trunc(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`, UiTheme.TEXT);
      if (w.smallButton(f, ix + this.s(90) + this.s(158), cy, this.s(30), this.s(30), '+')) { session.stepSunTime(15); }
    } else {
      ui.textWrapped(f.small, ix, cy + this.s(4), iw, 'Shadows off: O (or the sun panel) for sunlight', UiTheme.TEXT_FAINT, 1);
    }
    cy += this.s(38);

    this.grid = w.checkbox(f, ix, cy + this.s(4), iw, 'Thirds grid (not in the photo)', this.grid);
    cy += this.s(34);

    const due = this.shotIn > 0 || this.busy;
    if (w.menuButton(f, ix, cy, iw, due ? 'RENDERING…' : 'TAKE PHOTO (ENTER)', true, false, !due, this.s(44))) { this.request(); }
    cy += this.s(52);
    if (this.notice) { ui.textWrapped(f.small, ix, cy, iw, this.notice, UiTheme.MEASURE_TEXT, 2); }
    if (w.smallButton(f, ix, y + ph - this.s(44), iw, this.s(30), 'CLOSE (M / ESC)')) { this.close(); }
  }

  // #endregion

  dispose(): void {
    this.target?.dispose();
    this.target = null;
  }
}

/**
 * Builds the equirectangular image (top-down RGBA) from the six views: per pixel its direction, the view facing it
 * most, then a bilinear read where that view's projection puts it. Yields to the browser between bands of rows.
 */
async function stitch(faces: Uint8Array[], matrices: Matrix4x4[], forwards: Vec3[], eye: Vec3, face: number, width: number, height: number,
  heading: number): Promise<Uint8Array> {
  const output = new Uint8Array(width * height * 4);
  const band = 64;
  for (let start = 0; start < height; start += band) {
    const end = Math.min(height, start + band);
    for (let row = start; row < end; row++) {
      for (let column = 0; column < width; column++) {
        const d = Panorama.direction(column, row, width, height, heading);
        let best = 0, bestDot = -Infinity;
        for (let f = 0; f < 6; f++) {
          const dot = d.x * forwards[f].x + d.y * forwards[f].y + d.z * forwards[f].z;
          if (dot > bestDot) { bestDot = dot; best = f; }
        }
        const [cx, cy, , cw] = Mat4.transform4(eye.x + d.x, eye.y + d.y, eye.z + d.z, 1, matrices[best]);
        const x = (cx / cw * 0.5 + 0.5) * face - 0.5;
        const y = (cy / cw * 0.5 + 0.5) * face - 0.5; // GL rows, bottom-up like the read-back
        bilinear(faces[best], face, x, y, output, (row * width + column) * 4);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return output;
}

function bilinear(image: Uint8Array, size: number, x: number, y: number, output: Uint8Array, o: number): void {
  x = Math.min(Math.max(x, 0), size - 1.001);
  y = Math.min(Math.max(y, 0), size - 1.001);
  const x0 = Math.trunc(x), y0 = Math.trunc(y);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * size + x0) * 4, i10 = i00 + 4, i01 = i00 + size * 4, i11 = i01 + 4;
  for (let c = 0; c < 3; c++) {
    const top = image[i00 + c] + (image[i10 + c] - image[i00 + c]) * fx;
    const bottom = image[i01 + c] + (image[i11 + c] - image[i01 + c]) * fx;
    output[o + c] = Math.min(Math.max(Math.trunc(top + (bottom - top) * fy + 0.5), 0), 255);
  }
  output[o + 3] = 255;
}

/** Encodes RGBA pixels (bottom-up as read from GL, or top-down) as PNG or JPEG (quality 0.92), opaque. */
async function encode(rgba: Uint8Array, width: number, height: number, bottomUp: boolean, jpeg: boolean): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) { throw new Error('no 2D canvas for encoding'); }
  const image = context.createImageData(width, height);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const source = (bottomUp ? height - 1 - y : y) * stride;
    image.data.set(rgba.subarray(source, source + stride), y * stride);
  }
  for (let i = 3; i < image.data.length; i += 4) { image.data[i] = 255; }
  context.putImageData(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(
    blob => (blob ? resolve(blob) : reject(new Error('the image could not be encoded'))), jpeg ? 'image/jpeg' : 'image/png', 0.92));
}
