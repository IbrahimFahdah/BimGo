import { Mp4Writer } from '../core/format/Mp4Writer';
import { clamp } from '../core/math/Vector';
import { poseEye } from '../core/scene/TourTimeline';
import { gl } from '../engine/gl/Gl';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { downloadBlob, safeFileName } from '../platform/files';
import { InputAction } from '../core/scene/InputCatalog';
import type { InputState } from '../platform/input';
import type { GameSession } from './GameSession';
import type { Widgets } from './Menus';
import { PhotoTarget } from './PhotoMode';
import { VideoSize } from './ViewerSettings';

const VIDEO_SIZE_OPTIONS = ['Window', '1080p', '4K'];
const VIDEO_FPS_OPTIONS = ['30 fps', '60 fps'];

/** Milliseconds of video rendering per window frame (the page stays responsive). */
const VIDEO_BUDGET_MS = 45;

/** Frames waiting in the encoder before rendering pauses (backpressure). */
const MAX_QUEUED_FRAMES = 6;

/** H.264 profiles tried in order: High, Main, Baseline (level 5.1 covers 4K60; the encoder picks lower when it can). */
const CODECS = ['avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'avc1.640028', 'avc1.42e028'];

interface Recording {
  width: number;
  height: number;
  fps: number;
  frame: number;
  frames: number;
  encoder: VideoEncoder | null;
  mp4: Mp4Writer;
  target: PhotoTarget;
  ui: UiBatch | null;
  /** Waiting for the encoder's configuration check. */
  preparing: boolean;
  finishing: boolean;
  error: string | null;
  started: number;
  header: string;
  name: string;
  /** Flipped (top-down) pixels for the next VideoFrame (reused). */
  rows: Uint8Array;
}

/**
 * Walkthrough video (port of GameSession.Video.cs and VideoRecorder.cs): BOOKMARKS → TOUR SETTINGS → RECORD VIDEO
 * renders the bookmark tour to an MP4 (H.264) with its fades, holds, swivels and glides, and its UI setting.
 * - Frames are rendered off-screen at a fixed rate (the tour clock steps 1 / fps per frame), not in real time, so the
 *   video is smooth on any computer; as many frames as fit in ~45 ms are rendered per page frame.
 * - Each frame: the scene (photo path: no markers, highlights or gizmos), then with the UI on the HUD drawn at the
 *   video's height (a second UI batch at a matching scale), then the fade; read back and handed to the browser's
 *   H.264 encoder (WebCodecs), then packaged as MP4 (Mp4Writer). The desktop uses Media Foundation for both.
 * - The page shows the frames as they come (letterboxed) with progress, time left and CANCEL (Esc). The file goes to
 *   the browser's downloads.
 * Size (window / 1080p / 4K) and rate (30 / 60) are per-browser settings.
 */
export class VideoMode {
  private recording: Recording | null = null;
  private lastName: string | null = null;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  /** True while a video is being recorded (or its file finished). */
  get active(): boolean {
    return this.recording !== null;
  }

  /** True when this browser can encode H.264 video (WebCodecs). */
  static get supported(): boolean {
    return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  }

  /** The frame size for the current setting (even numbers). */
  private frameSize(): { width: number; height: number } {
    switch (this.session.settings.videoSize) {
      case VideoSize.Uhd4K: return { width: 3840, height: 2160 };
      case VideoSize.Window: return { width: Math.max(2, this.session.screenWidth & ~1), height: Math.max(2, this.session.screenHeight & ~1) };
      default: return { width: 1920, height: 1080 };
    }
  }

  // #region Settings (tour settings view)

  /** The VIDEO rows of the tour settings: size and frame rate, and the last file's name. */
  buildSettings(f: FontAtlas, w: Widgets, x: number, y: number, width: number): void {
    const session = this.session, ui = session.ui, settings = session.settings;
    ui.text(f.small, x, y, 'VIDEO (RECORD VIDEO BELOW)', UiTheme.TEXT_MUTED, this.s(1.4));
    y += this.s(20);
    const sizeW = width * 0.6;
    const size = w.segmented(f, x, y, sizeW - this.s(6), VIDEO_SIZE_OPTIONS, settings.videoSize);
    if (size !== settings.videoSize) { settings.videoSize = size; settings.save(); }
    const rate = settings.videoFps >= 60 ? 1 : 0;
    const pickedRate = w.segmented(f, x + sizeW, y, width - sizeW, VIDEO_FPS_OPTIONS, rate);
    if (pickedRate !== rate) { settings.videoFps = pickedRate === 1 ? 60 : 30; settings.save(); }
    y += this.s(40);
    const note = !VideoMode.supported ? 'This browser can\'t encode video: use Chrome, Edge or Safari 16.4+'
      : this.lastName ? `Last: ${this.lastName} (your Downloads folder)` : 'MP4 (H.264), saved to your Downloads folder';
    ui.textWrapped(f.small, x, y, width, note, VideoMode.supported ? UiTheme.TEXT_FAINT : UiTheme.MEASURE_LABEL, 2);
  }

  // #endregion

  // #region Start / finish

  /** RECORD VIDEO: starts the tour and a recording of it. */
  start(): void {
    const session = this.session;
    if (this.recording || session.tour.active) { return; }
    if (!VideoMode.supported) {
      session.menu.setBookmarksNotice('This browser can\'t encode video (WebCodecs): use Chrome, Edge or Safari 16.4+');
      session.sound.play(SoundId.Error);
      return;
    }
    const { width, height } = this.frameSize();
    const max = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    if (max > 0 && (width > max || height > max)) {
      session.menu.setBookmarksNotice(`This graphics card can't render ${width} × ${height} frames (its limit is ${max} px): pick a smaller size`);
      session.sound.play(SoundId.Error);
      return;
    }
    const target = new PhotoTarget();
    if (!target.ensure(width, height)) {
      session.menu.setBookmarksNotice(`The graphics card refused a ${width} × ${height} frame: pick a smaller size`);
      session.sound.play(SoundId.Error);
      return;
    }
    if (!session.tour.start(false)) {
      target.dispose();
      return;
    }

    const fps = session.settings.videoFps >= 60 ? 60 : 30;
    const timeline = session.tour.timeline!;
    let ui: UiBatch | null = null;
    if (session.tour.run!.showUi) {
      // The HUD at the video's height: its own UI batch (fonts rasterised at that scale)
      ui = new UiBatch();
      ui.initialise(session.ui.scale * height / Math.max(1, session.screenHeight));
    }
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const name = `${safeFileName(session.documentName.replace(/\.bimgo$/i, ''))} tour ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
      `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.mp4`;
    const recording: Recording = {
      width, height, fps, frame: 0, frames: Math.max(1, Math.ceil(timeline.duration * fps)), encoder: null, mp4: new Mp4Writer(width, height, fps),
      target, ui, preparing: true, finishing: false, error: null, started: performance.now(),
      header: `RECORDING VIDEO · ${width} × ${height} · ${fps} FPS · ${formatClock(timeline.duration)}`, name,
      rows: new Uint8Array(width * height * 4)
    };
    this.recording = recording;
    void this.configure(recording);
  }

  /** Finds a supported H.264 configuration and creates the encoder (the frames start once it is ready). */
  private async configure(recording: Recording): Promise<void> {
    const pixels = recording.width * recording.height;
    const bitrate = clamp(Math.round(pixels * recording.fps / 5), 4_000_000, 80_000_000); // ~0.2 bits per pixel
    try {
      let config: VideoEncoderConfig | null = null;
      for (const codec of CODECS) {
        const candidate: VideoEncoderConfig = {
          codec, width: recording.width, height: recording.height, bitrate, framerate: recording.fps, avc: { format: 'avc' }, latencyMode: 'quality'
        };
        const support = await VideoEncoder.isConfigSupported(candidate);
        if (support.supported) {
          config = candidate;
          break;
        }
      }
      if (this.recording !== recording) { return; } // cancelled meanwhile
      if (!config) { throw new Error(`this browser has no H.264 encoder for ${recording.width} × ${recording.height}`); }

      const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const description = metadata?.decoderConfig?.description;
          if (description) {
            recording.mp4.setDecoderConfig(ArrayBuffer.isView(description)
              ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
              : new Uint8Array(description));
          }
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          recording.mp4.addSample(data, chunk.type === 'key');
        },
        error: e => { recording.error = e.message || String(e); }
      });
      encoder.configure(config);
      recording.encoder = encoder;
      recording.preparing = false;
      console.info(`Video: ${recording.name}, ${recording.width}x${recording.height} @ ${recording.fps} fps, ${recording.frames} frames, ${config.codec}, ${(bitrate / 1e6).toFixed(1)} Mb/s.`);
    } catch (e) {
      recording.error = e instanceof Error ? e.message : String(e);
      recording.preparing = false;
    }
  }

  /** Per page frame while recording (instead of the tour's keys): Esc cancels; a failed recording ends here. */
  update(input: InputState): void {
    const recording = this.recording;
    if (!recording) { return; }
    if (input.pressed(InputAction.Back)) {
      this.cancel();
      return;
    }
    if (input.pressed(InputAction.Fullscreen)) { this.session.toggleFullscreen(); }
    if (recording.error && !recording.finishing) {
      this.end(`The video couldn't be made: ${recording.error}`);
      this.session.sound.play(SoundId.Error);
    }
  }

  /** Esc / CANCEL: stops the recording; nothing is saved. */
  cancel(): void {
    if (!this.recording) { return; }
    this.end('Recording cancelled (nothing was saved)');
  }

  /** The last frame was sent: flush the encoder, package the MP4 and download it. */
  private async finish(recording: Recording): Promise<void> {
    recording.finishing = true;
    try {
      await recording.encoder!.flush();
      if (this.recording !== recording) { return; }
      if (recording.error) { throw new Error(recording.error); }
      const blob = recording.mp4.finish();
      downloadBlob(blob, recording.name);
      this.lastName = recording.name;
      const seconds = (performance.now() - recording.started) / 1000;
      console.info(`Video saved: ${recording.name} (${recording.mp4.count} frames, ${(blob.size / 1e6).toFixed(1)} MB in ${seconds.toFixed(1)} s).`);
      this.end(`Saved ${recording.name} (${recording.width} × ${recording.height}, ${recording.fps} fps, ${formatClock(recording.frames / recording.fps)}) to your Downloads folder`);
      this.session.sound.play(SoundId.Commit);
    } catch (e) {
      if (this.recording !== recording) { return; }
      this.end(`The video couldn't be made: ${e instanceof Error ? e.message : String(e)}`);
      this.session.sound.play(SoundId.Error);
    }
  }

  /** Releases the recording, ends the tour (the walkthrough comes back as it was) and opens the tour settings with a notice. */
  private end(notice: string): void {
    this.release();
    const session = this.session;
    session.tour.stop(true, true);
    session.clearToast();
    session.setPaused(true);
    session.menu.openBookmarks();
    session.tour.openSettings();
    session.menu.setBookmarksNotice(notice);
  }

  /** Stops a recording without the menu (the page is closing): nothing is saved. */
  abort(): void {
    this.release();
  }

  private release(): void {
    const recording = this.recording;
    if (!recording) { return; }
    this.recording = null;
    try {
      if (recording.encoder && recording.encoder.state !== 'closed') { recording.encoder.close(); }
    } catch (e) {
      console.info(`Video encoder cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    recording.target.dispose();
    recording.ui?.dispose();
  }

  // #endregion

  // #region Rendering

  /** The page frame while recording: render video frames for up to 45 ms, then show the last one with the progress panel. */
  render(): void {
    const session = this.session, recording = this.recording;
    if (!recording) { return; }
    const width = session.screenWidth, height = session.screenHeight;
    if (!recording.preparing && !recording.finishing && !recording.error) {
      const start = performance.now();
      while (this.renderFrame(recording)) {
        if (performance.now() - start >= VIDEO_BUDGET_MS) { break; }
      }
    }
    if (this.recording !== recording) { return; }

    // The last frame, letterboxed
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (recording.frame > 0) {
      const scale = Math.min(width / recording.width, height / recording.height);
      const w = Math.max(1, Math.trunc(recording.width * scale)), h = Math.max(1, Math.trunc(recording.height * scale));
      const x = Math.trunc((width - w) / 2), y = Math.trunc((height - h) / 2);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, recording.target.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, recording.width, recording.height, x, y, x + w, y + h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, width, height);
    this.buildProgress(session.ui.atlas, session.input, width, height, recording);
    session.ui.flush(width, height);
  }

  /**
   * Renders, reads back and encodes one video frame at the tour clock for the next frame number.
   * @returns False when there is nothing more to render now (the last frame was sent, or the encoder is busy).
   */
  private renderFrame(recording: Recording): boolean {
    const session = this.session, tour = session.tour, encoder = recording.encoder!;
    if (recording.frame >= recording.frames) {
      void this.finish(recording);
      return false;
    }
    if (encoder.encodeQueueSize > MAX_QUEUED_FRAMES) { return false; }

    // The tour at this frame's time (fixed step: smooth whatever the computer's speed)
    tour.time = recording.frame / recording.fps;
    tour.evaluate();
    session.updateRoom();
    const pose = tour.pose!;

    const w = recording.width, h = recording.height, camera = session.camera;
    camera.clearCustomView();
    camera.position = poseEye(pose);
    camera.yaw = pose.yaw;
    camera.pitch = pose.pitch;
    camera.horizontalFovDegrees = session.settings.fieldOfView;
    camera.viewportWidth = w;
    camera.viewportHeight = h;
    camera.aspect = w / h;
    camera.update();
    session.renderScene(w, h, recording.target.framebuffer, true);

    // 2D into the frame: the HUD (UI on) and the fade
    gl.bindFramebuffer(gl.FRAMEBUFFER, recording.target.framebuffer);
    if (recording.ui) { session.buildVideoHud(recording.ui, w, h); }
    if (pose.black > 0.002) {
      session.ui.rect(0, 0, w, h, Rgba.hex(0x000000, clamp(pose.black, 0, 1)));
      session.ui.flush(w, h);
    }

    // Read back (bottom-up) and flip into top-down rows for the encoder
    const pixels = recording.target.read();
    const stride = w * 4, rows = recording.rows;
    for (let y = 0; y < h; y++) { rows.set(pixels.subarray((h - 1 - y) * stride, (h - y) * stride), y * stride); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const frame = new VideoFrame(rows, {
      format: 'RGBX', codedWidth: w, codedHeight: h,
      timestamp: Math.round(recording.frame * 1_000_000 / recording.fps), duration: Math.round(1_000_000 / recording.fps)
    });
    try {
      encoder.encode(frame, { keyFrame: recording.frame % (recording.fps * 2) === 0 });
    } finally {
      frame.close();
    }
    recording.frame++;
    return true;
  }

  /** The page's progress panel while recording: what is being made, a progress bar, frames and time left, CANCEL. */
  private buildProgress(f: FontAtlas, input: InputState, width: number, height: number, recording: Recording): void {
    const session = this.session, ui = session.ui;
    const w = Math.min(this.s(620), width - this.s(40)), h = this.s(104);
    const x = Math.round((width - w) * 0.5), y = height - this.s(24) - h;
    ui.panel(x, y, w, h, UiTheme.PANEL_STRONG, Rgba.withAlpha(UiTheme.BOOKMARK, 0.6));
    const ix = x + this.s(16), iw = w - this.s(32);

    ui.text(f.small, ix, y + this.s(14), recording.header, UiTheme.BOOKMARK_LABEL, this.s(1.2));
    if (session.clock % 1 < 0.6 && !recording.finishing) { ui.circle(ix + iw - this.s(6), y + this.s(20), this.s(5), UiTheme.DANGER, 12); }

    const fraction = recording.frames > 0 ? clamp(recording.frame / recording.frames, 0, 1) : 1;
    const barY = y + this.s(42);
    ui.rect(ix, barY, iw, this.s(6), Rgba.hex(0xffffff, 0.15));
    ui.rect(ix, barY, iw * fraction, this.s(6), UiTheme.BOOKMARK);

    let line: string;
    if (recording.preparing) { line = 'Starting the encoder…'; }
    else if (recording.finishing) { line = 'Finishing the file…'; }
    else {
      line = `Frame ${recording.frame.toLocaleString('en')} of ${recording.frames.toLocaleString('en')} · ${formatClock(recording.frame / recording.fps)} of ${formatClock(recording.frames / recording.fps)}`;
      const elapsed = (performance.now() - recording.started) / 1000;
      if (recording.frame > 10 && elapsed > 1) { line += ` · about ${formatClock(elapsed / recording.frame * (recording.frames - recording.frame))} left`; }
    }
    ui.text(f.body, ix, barY + this.s(16), line, UiTheme.TEXT_SOFT);

    if (session.menu.widgets.smallButton(f, ix + iw - this.s(120), y + h - this.s(40), this.s(120), this.s(28), 'CANCEL (ESC)')) {
      input.consumeClicks();
      this.cancel();
      return;
    }
    ui.text(f.small, ix, y + h - this.s(32), 'Rendered off-screen at a fixed frame rate: smooth on any computer', UiTheme.TEXT_FAINT);
  }

  // #endregion
}

/** "m:ss". */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.trunc(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
