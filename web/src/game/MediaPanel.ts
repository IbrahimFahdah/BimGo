import type { CameraPath } from '../core/format/CameraPathModels';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import type { InputState } from '../platform/input';
import type { GameSession } from './GameSession';
import { Hints } from './Hints';
import type { Widgets } from './Menus';
import { FOOTER_LEFT, FOOTER_NONE, PanelSize, ScrollRegion, ShellStyle } from './PanelShell';
import { PANO_SIZES, PHOTO_FORMATS, PHOTO_KINDS, PHOTO_SCALES } from './PhotoMode';
import { VIDEO_FPS_OPTIONS, VIDEO_SIZE_OPTIONS, VideoMode } from './VideoMode';

/** The MEDIA panel's tabs (Round K-A). */
export enum MediaTab { Photo = 0, Tour = 1, Paths = 2, Video = 3 }

const MEDIA_TABS = ['PHOTO', 'TOUR', 'PATHS', 'VIDEO'];

const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.trunc(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Round K-A (port of GameSession.Media.cs): the MEDIA panel (pause menu → MEDIA, or Shift+M), one place for what BimGo
 * makes for others to watch, on the panel shell with four tabs:
 * - PHOTO: photo mode's settings (still / 360°, size, format, exposure, grids) and OPEN PHOTO MODE.
 * - TOUR: the bookmark tour's settings and each stop's overrides (moved from BOOKMARKS); PLAY TOUR, RECORD VIDEO.
 * - PATHS: keyframed camera paths (CameraPaths.buildTab).
 * - VIDEO: the video's source (the tour or a path), size and frame rate; RECORD VIDEO.
 */
export class MediaPanel {
  private openNow = false;
  private tab = MediaTab.Paths;
  /** The line over the footer (results, errors), or null. */
  notice: string | null = null;
  /** VIDEO: the source (null = the bookmark tour). */
  videoPath: CameraPath | null = null;
  private readonly videoSourceScroll = new ScrollRegion();
  private readonly photoScroll = new ScrollRegion();

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  /** True while the panel shows (it replaces the pause menu). */
  get isOpen(): boolean { return this.openNow; }

  setNotice(text: string | null): void { this.notice = text; }

  // #region Open / close

  /** Opens the panel on a tab (pausing first when walking). */
  open(tab: MediaTab = this.tab): void {
    const session = this.session;
    if (!session.paused) { session.setPaused(true); }
    session.menu.closeBookmarks();
    this.openNow = true;
    this.notice = null;
    this.switchTab(Math.min(Math.max(tab, MediaTab.Photo), MediaTab.Video), true);
  }

  /** Changes tab: the tour draft is saved; the TOUR tab starts from the saved settings. */
  private switchTab(tab: MediaTab, force = false): void {
    if (tab === this.tab && !force) { return; }
    const session = this.session, w = session.menu.widgets;
    session.tour.flushDraft();
    this.tab = tab;
    w.activeSlider = -1;
    session.paths.disarm();
    if (tab === MediaTab.Tour) { session.tour.resetSettingsView(w); }
    if (tab === MediaTab.Paths) { session.paths.resetView(); }
    if (tab === MediaTab.Video) { this.videoSourceScroll.reset(); }
  }

  /** One level back: the panel closes (to the pause menu). True if it was open. */
  close(): boolean {
    if (!this.openNow) { return false; }
    this.closePanel();
    return true;
  }

  /** Closes the panel (CLOSE, a tour or path starting): the tour draft is saved first. */
  closePanel(): void {
    if (!this.openNow) { return; }
    this.session.tour.closeSettings();
    this.openNow = false;
    this.session.paths.disarm();
  }

  // #endregion

  // #region Panel

  /** Draws and handles the MEDIA panel (in place of the pause menu): tabs in the header, the tab's body, its footer. */
  build(): void {
    const session = this.session, ui = session.ui, f = ui.atlas, input = session.input, shell = session.shell, w = session.menu.widgets;
    if (!input.leftDown) { w.activeSlider = -1; }

    let sub: string;
    switch (this.tab) {
      case MediaTab.Photo: sub = 'Stills and 360° panoramas · saved to your Downloads folder'; break;
      case MediaTab.Tour: sub = `The bookmark tour · ${session.bookmarks.bookmarks.length.toLocaleString('en')} bookmarks · saved to ${session.bookmarks.fileName}`; break;
      case MediaTab.Paths: sub = `Keyframed camera paths · ${session.paths.store.paths.length.toLocaleString('en')} · saved to ${session.paths.store.fileName}`; break;
      default: sub = 'Walkthrough videos (MP4) · saved to your Downloads folder'; break;
    }
    const tabsW = Math.min(this.s(440), session.screenWidth * 0.4);
    const frame = shell.beginPanel(PanelSize.Wide, 'MEDIA', UiTheme.BOOKMARK_LABEL, sub, tabsW);
    const tabsX = shell.takeHeaderSlot(frame, tabsW, this.s(UiTheme.GAP_SMALL));
    const tab = w.tabs(f, tabsX, frame.headerControlY + this.s(2), tabsW, MEDIA_TABS, this.tab);
    if (tab !== this.tab) {
      this.switchTab(tab);
      this.notice = null;
    }

    const x = frame.ix, y = frame.bodyTop, width = frame.iw, bottom = frame.bodyBottom;
    let action1 = FOOTER_NONE, action3 = FOOTER_NONE;
    let action2: number;
    let hint: string;
    let convert = false;
    switch (this.tab) {
      case MediaTab.Photo:
        this.buildPhotoTab(f, w, input, x, y, width, bottom);
        action2 = shell.footerAction(Hints.mediaPhotoOpen.text, ShellStyle.Primary);
        hint = Hints.mediaPhoto.text;
        break;
      case MediaTab.Tour:
        convert = session.tour.buildSettings(f, w, x, y, width, bottom);
        action1 = shell.footerAction('RECORD VIDEO', ShellStyle.Normal, VideoMode.supported);
        action2 = shell.footerAction('PLAY TOUR', ShellStyle.Primary);
        hint = Hints.bookmarksTour.text;
        break;
      case MediaTab.Paths: {
        session.paths.buildTab(f, w, input, x, y, width, bottom);
        if (!this.openNow) { return; } // GO TO left the panel
        const path = session.paths.path;
        const playable = path !== null && path.keys.length >= 2;
        action1 = shell.footerAction('RECORD VIDEO', ShellStyle.Normal, playable && VideoMode.supported);
        action3 = shell.footerAction(session.pathEditor.on ? 'BACK TO THE 3D EDITOR' : 'EDIT IN 3D', ShellStyle.Normal, path !== null); // Round K-B
        action2 = shell.footerAction('PLAY PATH', ShellStyle.Primary, playable);
        hint = Hints.mediaPaths.text;
        break;
      }
      default:
        this.buildVideoTab(f, w, input, x, y, width, bottom);
        action2 = shell.footerAction('RECORD VIDEO', ShellStyle.Primary, VideoMode.supported);
        hint = 'Rendered off-screen at a fixed frame rate (smooth on any computer) · Esc cancels a recording · MP4 (H.264) via the browser\'s encoder';
        break;
    }

    const pressed = shell.endPanel(frame, this.notice, hint);
    if (convert) {
      // CONVERT TO PATH (after drawing: it switches to PATHS)
      const path = session.tour.convertToPath();
      if (path) {
        this.switchTab(MediaTab.Paths);
        session.paths.select(path);
      }
    }
    if (pressed === FOOTER_NONE || pressed === FOOTER_LEFT || !this.openNow) { return; }
    switch (this.tab) {
      case MediaTab.Photo:
        if (pressed === action2) {
          this.closePanel();
          session.setPaused(false);
          session.photo.show();
        }
        break;
      case MediaTab.Tour:
        if (pressed === action1) { session.video.start(); }
        else if (pressed === action2) { session.tour.start(); }
        break;
      case MediaTab.Paths:
        if (pressed === action1) { session.video.start(session.paths.path); }
        else if (pressed === action2) { session.tour.startPath(session.paths.path); }
        else if (pressed === action3) { session.pathEditor.enter(session.paths.path); }
        break;
      default:
        if (pressed === action2) { session.video.start(this.videoPath); }
        break;
    }
  }

  // #endregion

  // #region PHOTO

  /** PHOTO: photo mode's settings on the left (shared with photo mode's own panel), what photo mode does on the right. */
  private buildPhotoTab(f: FontAtlas, w: Widgets, input: InputState, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, shell = session.shell, photo = session.photo;
    const lw = Math.min(this.s(380), width * 0.45);
    let cy = shell.beginScroll(this.photoScroll, input, x, y, lw + this.s(UiTheme.SCROLL_GUTTER), bottom - y);
    const label = this.s(96);

    cy = shell.sectionLabel(f, x, cy, 'PHOTO SETTINGS');
    photo.kind = w.segmented(f, x, cy, lw, PHOTO_KINDS, photo.kind);
    cy += this.s(44);
    if (photo.kind === 0) {
      ui.text(f.body, x, cy + this.s(7), 'Size', UiTheme.TEXT_SOFT);
      photo.scale = w.segmented(f, x + label, cy, lw - label, PHOTO_SCALES, photo.scale - 1) + 1;
      cy += this.s(36);
      ui.text(f.small, x + label, cy, `${session.screenWidth * photo.scale} × ${session.screenHeight * photo.scale} px (this window × ${photo.scale})`, UiTheme.TEXT_FAINT);
      cy += this.s(24);
      ui.text(f.body, x, cy + this.s(7), 'Format', UiTheme.TEXT_SOFT);
      photo.jpeg = w.segmented(f, x + label, cy, lw - label, PHOTO_FORMATS, photo.jpeg ? 1 : 0) === 1;
      cy += this.s(42);
      ui.text(f.body, x, cy + this.s(7), 'View', UiTheme.TEXT_SOFT);
      const fov = w.stepper(f, x + label, cy, session.settings.fieldOfView, 5, 30, 120, 0, '° wide');
      if (fov !== session.settings.fieldOfView) {
        session.settings.fieldOfView = fov;
        session.settings.save();
      }
      cy += this.s(40);
    } else {
      ui.text(f.body, x, cy + this.s(7), 'Size', UiTheme.TEXT_SOFT);
      photo.eightK = w.segmented(f, x + label, cy, lw - label, PANO_SIZES, photo.eightK ? 1 : 0) === 1;
      cy += this.s(36);
      ui.text(f.small, x + label, cy, photo.eightK ? '8192 × 4096 px JPEG' : '4096 × 2048 px JPEG', UiTheme.TEXT_FAINT);
      cy += this.s(28);
    }

    ui.text(f.body, x, cy + this.s(7), 'Exposure', UiTheme.TEXT_SOFT);
    photo.exposure = w.stepper(f, x + label, cy, photo.exposure, 0.5, -3, 3, 1, ' EV');
    cy += this.s(42);
    photo.grid = w.checkbox(f, x, cy + this.s(4), lw, 'Thirds grid (not in the photo)', photo.grid);
    cy += this.s(32);
    photo.gridLines = w.checkbox(f, x, cy + this.s(4), lw, session.grids.showing ? 'Grid lines in the photo' : 'Grid lines in the photo (grids are off)', photo.gridLines);
    cy += this.s(40);
    shell.endScroll(this.photoScroll, input, cy);

    // What photo mode does (right)
    const rx = x + lw + this.s(40), rw = width - lw - this.s(40);
    let ry = shell.sectionLabel(f, rx, y, 'PHOTO MODE');
    ry += ui.textWrapped(f.body, rx, ry, rw, Hints.mediaPhotoAbout.text, UiTheme.TEXT_SOFT, 6) + this.s(16);
    if (!session.sun.enabled) { ry += ui.textWrapped(f.small, rx, ry, rw, Hints.photoShadows.text, UiTheme.TEXT_FAINT, 2) + this.s(12); }
    if (photo.lastName) {
      ry = shell.sectionLabel(f, rx, ry, 'LAST PHOTO');
      ui.textWrapped(f.small, rx, ry, rw, photo.lastName, UiTheme.TEXT_MUTED, 2);
    }
  }

  // #endregion

  // #region VIDEO

  /** VIDEO: the source (the tour or a path) on the left; size, frame rate and what will be recorded on the right. */
  private buildVideoTab(f: FontAtlas, w: Widgets, input: InputState, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, shell = session.shell, paths = session.paths, settings = session.settings;
    paths.refreshStats();
    if (this.videoPath && !paths.store.paths.includes(this.videoPath)) { this.videoPath = null; }

    // Sources (left)
    const lw = Math.min(this.s(420), width * 0.45);
    const ly = shell.sectionLabel(f, x, y, 'RECORD');
    const rowH = this.s(48);
    const count = 1 + paths.store.paths.length;
    const top = shell.beginScroll(this.videoSourceScroll, input, x, ly, lw, bottom - ly);
    const cw = lw - this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.videoSourceScroll.visibleRows(rowH, count);
    let picked = this.videoPath;
    let pickedTour = false;
    for (let i = first; i < last; i++) {
      const ry = top + i * rowH;
      const path = i === 0 ? null : paths.store.paths[i - 1];
      const on = path === this.videoPath;
      if (on) { ui.rect(x, ry, cw, rowH - this.s(4), Rgba.withAlpha(UiTheme.ACCENT, 0.16)); }
      else if ((i & 1) === 0) { ui.rect(x, ry, cw, rowH - this.s(4), UiTheme.ROW_STRIPE); }
      if (w.hover(x, ry, cw, rowH - this.s(4)) && input.leftPressed) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        if (path === null) { pickedTour = true; } else { picked = path; }
      }
      ui.circle(x + this.s(14), ry + rowH * 0.5 - this.s(2), this.s(5), on ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER, 12);
      if (path === null) {
        const { length, stops } = session.tour.length(session.bookmarks.tour);
        ui.textWrapped(f.bold, x + this.s(30), ry + this.s(5), cw - this.s(40), 'Bookmark tour', UiTheme.TEXT, 1);
        ui.text(f.small, x + this.s(30), ry + this.s(26), `${stops} ${stops === 1 ? 'stop' : 'stops'} · ${clock(length)}`, UiTheme.TEXT_MUTED);
      } else {
        ui.textWrapped(f.bold, x + this.s(30), ry + this.s(5), cw - this.s(40), path.name, UiTheme.TEXT, 1);
        ui.textWrapped(f.small, x + this.s(30), ry + this.s(26), cw - this.s(40), paths.statsLabel(path), UiTheme.TEXT_MUTED, 1);
      }
    }
    shell.endScroll(this.videoSourceScroll, input, top + count * rowH);
    if (pickedTour) { this.videoPath = null; } else if (picked !== this.videoPath) { this.videoPath = picked; }

    // Size, rate and the summary (right)
    const rx = x + lw + this.s(40), rw = Math.min(width - lw - this.s(40), this.s(460));
    let cy = shell.sectionLabel(f, rx, y, 'SIZE AND FRAME RATE (THIS BROWSER)');
    const size = w.segmented(f, rx, cy, rw, VIDEO_SIZE_OPTIONS, settings.videoSize);
    if (size !== settings.videoSize) { settings.videoSize = size; settings.save(); }
    cy += this.s(42);
    const rate = settings.videoFps >= 60 ? 1 : 0;
    const pickedRate = w.segmented(f, rx, cy, rw, VIDEO_FPS_OPTIONS, rate);
    if (pickedRate !== rate) { settings.videoFps = pickedRate === 1 ? 60 : 30; settings.save(); }
    cy += this.s(52);

    cy = shell.sectionLabel(f, rx, cy, 'THE VIDEO');
    const { width: vw, height: vh } = session.video.frameSize();
    const fps = settings.videoFps >= 60 ? 60 : 30;
    const seconds = this.videoPath ? paths.duration(this.videoPath) : session.tour.length(session.bookmarks.tour).length;
    ui.text(f.mono, rx, cy, `${vw} × ${vh} · ${fps} fps · ${clock(seconds)} · ${Math.ceil(seconds * fps).toLocaleString('en')} frames`, UiTheme.TEXT_SOFT);
    cy += this.s(26);
    const showUi = this.videoPath ? this.videoPath.showUi : session.bookmarks.tour.showUi;
    const loop = this.videoPath ? this.videoPath.loop : session.bookmarks.tour.loop;
    ui.textWrapped(f.small, rx, cy, rw, showUi
      ? (loop ? 'With the HUD (the source\'s setting) · a looping source records one lap' : 'With the HUD (the source\'s setting)')
      : (loop ? 'A clean view, no HUD (the source\'s setting) · a looping source records one lap' : 'A clean view, no HUD (the source\'s setting)'),
    UiTheme.TEXT_MUTED, 2);
    cy += this.s(44);
    if (!VideoMode.supported) {
      ui.textWrapped(f.small, rx, cy, rw, 'This browser can\'t encode video: use Chrome, Edge or Safari 16.4+', UiTheme.MEASURE_LABEL, 2);
      cy += this.s(40);
    }
    if (session.video.lastName) {
      cy = shell.sectionLabel(f, rx, cy, 'LAST VIDEO');
      ui.textWrapped(f.small, rx, cy, rw, session.video.lastName, UiTheme.TEXT_MUTED, 2);
    }
  }

  // #endregion
}
