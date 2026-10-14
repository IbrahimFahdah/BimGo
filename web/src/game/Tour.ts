import {
  type BookmarkRecord, type SunTime, TourLimits, type TourSettings, type TourSwivelDirection, tourHoldFor, tourSwivelFor, type VisibilitySettings,
  cleanTourSettings
} from '../core/format/DocumentModels';
import { clamp, Vec3 as V } from '../core/math/Vector';
import type { SectionCut } from '../core/scene/SectionCut';
import { type TourPose, TourTimeline, type TourTransition, tourStop } from '../core/scene/TourTimeline';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { InputAction } from '../core/scene/InputCatalog';
import type { InputState } from '../platform/input';
import type { EyePreset } from './ViewerSettings';
import type { GameSession } from './GameSession';
import type { Widgets } from './Menus';
import { Hints } from './Hints';
import { keyOf } from '../platform/Hotkeys';

const DEGREES = Math.PI / 180;

/** Within this many seconds of a stop's start, "previous" goes to the stop before; later, to this stop's start. */
const TOUR_PREVIOUS_GRACE = 1.5;

const TRANSITION_OPTIONS = ['Fade', 'Glide'];
const SWIVEL_DIRECTION_OPTIONS = ['Left', 'Right'];
const SLIDER_TOUR_FADE = 40, SLIDER_TOUR_GLIDE = 41, SLIDER_TOUR_HOLD = 42, SLIDER_TOUR_SWIVEL = 43;

/** The walkthrough's state when the tour started (put back at the end; also used by stops that kept nothing). */
interface SavedState {
  feet: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  sun: SunTime;
  shadows: boolean;
  sunPlaying: boolean;
  section: SectionCut;
  visibility: VisibilitySettings;
  isolate: boolean[] | null;
  eye: number;
  preset: EyePreset;
  eyeCustom: boolean;
  uiHidden: boolean;
}

/**
 * Bookmark tour (port of GameSession.Tour.cs): plays the bookmarks in list order, hands-free. Each stop fades in,
 * holds (with an optional slow swivel) and fades out, or the camera glides from stop to stop. Every stop applies what
 * its bookmark kept (sun time, section cut, hidden categories / links / elements, eye height); a bookmark without one
 * of those uses the walkthrough's own state from when the tour started. When the tour ends (or Esc stops it) the
 * player, the sun, the cut, the visibility and the eye height go back to what they were, and nothing is marked
 * changed.
 *
 * Keys while playing: Space pause, → / Page Down / LMB next stop, ← / Page Up / RMB previous (or the start of this
 * stop), Esc stop, F11 fullscreen. Started from the pause menu (BOOKMARKS → PLAY TOUR).
 */
export class TourPlayer {
  // Playback
  active = false;
  paused = false;
  timeline: TourTimeline | null = null;
  records: BookmarkRecord[] = [];
  /** The settings this run plays with. */
  run: TourSettings | null = null;
  time = 0;
  pose: TourPose | null = null;
  private appliedStop = -1;
  private hintUntil = 0;
  private saved: SavedState | null = null;

  // What the current stop applied (reference checks skip re-applying the same state)
  private appliedSun: SunTime | null = null;
  private appliedSection: SectionCut | null = null;
  private appliedVisibility: VisibilitySettings | null = null;

  // The tour settings view in the bookmark list: a draft saved when a change is finished (not mid-drag)
  settingsOpen = false;
  private draft: TourSettings | null = null;
  private draftDirty = false;
  private stopScroll = 0;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  // #region Start / stop

  /**
   * Starts the tour from the first bookmark that isn't left out. Closes the pause menu and any panel.
   * @param capture False to leave the mouse free (a recording: its CANCEL must stay clickable).
   * @returns False (with a notice) when there is nothing to play.
   */
  start(capture = true): boolean {
    const session = this.session;
    if (this.active) { return false; }
    this.flushDraft();

    const records = session.bookmarks.bookmarks.filter(b => !b.tourSkip);
    if (records.length === 0) {
      session.menu.setBookmarksNotice(session.bookmarks.bookmarks.length === 0
        ? `No bookmarks to tour yet: press ${keyOf(InputAction.AddBookmark)} where you want a stop`
        : 'Every bookmark is left out of the tour (TOUR SETTINGS ticks them back in)');
      session.sound.play(SoundId.Error);
      return false;
    }

    // Remember the walkthrough as it is
    const player = session.player, sun = session.sun;
    const run = cleanTourSettings({ ...session.bookmarks.tour });
    const sunTime: SunTime = { ...sun.settings.time };
    if (sun.playing) { sunTime.minutes = clamp(Math.round(sun.playMinutes), 0, 1439); }
    this.saved = {
      feet: V.copy(player.feet), yaw: player.yaw, pitch: player.pitch,
      sun: sunTime, shadows: sun.settings.enabled, sunPlaying: sun.playing,
      section: session.section.current.clone(), visibility: session.toVisibilitySettings(), isolate: session.isolateBackup,
      eye: player.controller.standEye, preset: session.eye.preset, eyeCustom: session.eye.custom, uiHidden: session.uiHidden
    };

    // Lay the stops out (eye height: the bookmark's, else the current one)
    this.run = run;
    this.records = records;
    const stops = records.map(r => tourStop(r.local, r.eyeHeight ?? this.saved!.eye, r.yaw, clamp(r.pitch, -1.5, 1.5),
      tourHoldFor(run, r), tourSwivelFor(run, r) * DEGREES));
    this.timeline = new TourTimeline(stops, run.transition, run.fadeSeconds, run.glideSeconds);

    // Clear the stage: menu, panels, a gun mid-move
    session.menu.closeBookmarks();
    session.closeModes(null);
    const gun = session.guns[session.activeGun];
    if (gun.capturesInput) { gun.onCancel(); }
    if (session.paused) {
      if (capture) { session.setPaused(false); } else { session.resumeWithoutCapture(); }
    }

    this.active = true;
    this.paused = false;
    this.time = 0;
    this.appliedStop = -1;
    this.appliedSun = null;
    this.appliedSection = null;
    this.appliedVisibility = null;
    session.uiHidden = !run.showUi;
    session.clearToast();
    this.hintUntil = session.clock + 4;
    session.input.releaseAll();
    this.evaluate();
    console.info(`Tour started: ${this.timeline.count} stop(s), ${this.timeline.duration.toFixed(1)} s, ${run.transition}.`);
    return true;
  }

  /**
   * Ends the tour and puts the walkthrough back as it was when the tour started.
   * @param finished True when it played to the end (else Esc stopped it).
   * @param quiet True to skip the toast (a recording ends it with its own notice).
   */
  stop(finished: boolean, quiet = false): void {
    const session = this.session, saved = this.saved;
    if (!this.active || !saved) { return; }
    this.active = false;
    this.paused = false;

    session.sun.setQuiet(saved.sun, saved.shadows);
    if (saved.sunPlaying && saved.shadows) { session.sun.togglePlay(); }
    session.section.setQuiet(saved.section);
    session.applyVisibility(saved.visibility, false);
    session.isolateBackup = saved.isolate;
    session.player.controller.setStandingEye(saved.eye, true);
    session.eye.preset = saved.preset;
    session.eye.custom = saved.eyeCustom;
    session.player.teleportTo(saved.feet, saved.yaw, saved.pitch);
    session.uiHidden = saved.uiHidden;

    this.timeline = null;
    this.records = [];
    this.saved = null;
    this.pose = null;
    session.input.releaseAll();
    if (!quiet) { session.toast(finished ? 'Tour finished: back where you were' : 'Tour stopped: back where you were', 2.4); }
  }

  // #endregion

  // #region Playback

  /**
   * Per frame while the tour plays (instead of the walkthrough's keys): pause, next / previous, stop, then the clock
   * and the pose.
   */
  update(input: InputState, dt: number): void {
    const session = this.session, timeline = this.timeline!;
    if (input.pressed(InputAction.Back)) {
      this.stop(false);
      return;
    }
    if (input.pressed(InputAction.Fullscreen)) { session.toggleFullscreen(); }
    if (input.pressed(InputAction.TourPause)) {
      this.paused = !this.paused;
      session.sound.play(SoundId.UiClick);
    }

    const next = input.pressed(InputAction.TourNext);
    const previous = input.pressed(InputAction.TourPrevious);
    if (input.leftPressed || input.rightPressed) { session.captureMouse(); } // a click is a gesture: hide the cursor again
    if (next || previous) {
      input.consumeClicks();
      if (!this.seek(next ? +1 : -1)) { return; }
    }

    if (!this.paused) { this.time += dt; }
    if (this.time >= timeline.duration) {
      if (this.run!.loop && timeline.duration > 0) { this.time %= timeline.duration; }
      else {
        this.stop(true);
        return;
      }
    }

    this.evaluate();
    session.updateRoom();
  }

  /**
   * Jumps to the next stop, or to the previous one (to this stop's start when it has been showing a while).
   * @returns False if the tour ended (next past the last stop without looping).
   */
  private seek(direction: number): boolean {
    const timeline = this.timeline!;
    const current = timeline.indexAt(this.time);
    let target: number;
    if (direction > 0) {
      target = current + 1;
      if (target >= timeline.count) {
        if (!this.run!.loop) {
          this.stop(true);
          return false;
        }
        target = 0;
      }
    } else {
      const early = this.time - timeline.startOf(current) < TOUR_PREVIOUS_GRACE;
      target = early && current > 0 ? current - 1 : current;
    }
    this.time = timeline.startOf(target);
    this.session.sound.play(SoundId.UiClick);
    return true;
  }

  /**
   * The pose at the tour clock: applies a new stop's state, and moves the player there (the minimap, room and level
   * readouts follow). The camera takes the pose in GameSession.updateCamera.
   */
  evaluate(): void {
    const pose = this.timeline!.evaluate(this.time);
    this.pose = pose;
    if (pose.stop < 0) { return; }
    if (pose.stop !== this.appliedStop) { this.applyStop(pose.stop); }
    this.session.player.teleportTo(pose.feet, pose.yaw, pose.pitch);
  }

  /**
   * Applies what a stop's bookmark kept, without recording anything for saving: sun, cut, visibility, eye height.
   * Parts the bookmark didn't keep fall back to the state from the tour's start.
   */
  private applyStop(index: number): void {
    const session = this.session, saved = this.saved!;
    this.appliedStop = index;
    const record = this.records[index];

    const sun = record.sun ?? saved.sun;
    if (sun !== this.appliedSun) {
      session.sun.setQuiet(sun, record.sun !== null || saved.shadows);
      this.appliedSun = sun;
    }

    const section = record.section ?? saved.section;
    if (section !== this.appliedSection) {
      session.section.setQuiet(section);
      this.appliedSection = section;
    }

    const visibility = record.visibility ?? saved.visibility;
    if (visibility !== this.appliedVisibility) {
      session.applyVisibility(visibility, false);
      this.appliedVisibility = visibility;
    }

    session.eye.apply(this.timeline!.stopAt(index).eyeHeight);
  }

  // #endregion

  // #region Overlay

  /**
   * The tour's 2D layer: with the UI on, the status, coordinates, minimap, room and a tour bar; then the fade; then the
   * key hint for the first seconds (and while paused).
   */
  buildOverlay(width: number, height: number, mapX: number, mapY: number): void {
    const session = this.session, ui = session.ui, f = ui.atlas, pose = this.pose;
    if (!session.uiHidden) {
      session.buildTourHud(mapX, mapY);
      this.buildBar(f, width, height);
      session.buildToast(f, width);
    } else if (session.toastIsImportant) {
      session.buildToast(f, width);
    }

    if (pose && pose.black > 0.002) { ui.rect(0, 0, width, height, Rgba.hex(0x000000, clamp(pose.black, 0, 1))); }

    // Key hint: fades out after a few seconds; stays while paused
    const hintAlpha = this.paused ? 1 : clamp((this.hintUntil - session.clock) / 0.6, 0, 1);
    if (hintAlpha > 0) {
      const hint = this.paused
        ? Hints.tourPaused.text
        : Hints.tourPlaying.text;
      const hintW = UiBatch.measure(f.body, hint) + this.s(28);
      const hx = Math.round(width * 0.5 - hintW * 0.5);
      const hy = height - this.s(session.uiHidden ? 64 : 112);
      ui.panel(hx, hy, hintW, this.s(30), Rgba.withAlpha(UiTheme.PANEL, hintAlpha), Rgba.withAlpha(UiTheme.PANEL_BORDER, hintAlpha));
      ui.textCentred(f.body, width * 0.5, hy + this.s(7), hint, Rgba.withAlpha(UiTheme.TEXT, hintAlpha));
    }
  }

  /** Bottom-centre bar (UI on): stop number, bookmark name and the tour's progress. */
  buildBar(f: FontAtlas, width: number, height: number): void {
    const session = this.session, ui = session.ui, timeline = this.timeline!;
    const stop = Math.max(0, this.pose?.stop ?? 0);
    const w = Math.min(this.s(560), width - this.s(40)), h = this.s(58);
    const x = Math.round((width - w) * 0.5), y = height - this.s(20) - h;
    ui.panel(x, y, w, h, UiTheme.PANEL, UiTheme.PANEL_BORDER);

    const label = `TOUR · ${stop + 1} / ${timeline.count}${this.paused ? ' · PAUSED' : ''}`;
    const used = ui.text(f.small, x + this.s(14), y + this.s(12), label, UiTheme.BOOKMARK_LABEL, this.s(1.4));
    ui.textWrapped(f.bold, x + this.s(14) + used + this.s(12), y + this.s(9), w - used - this.s(40), this.records[stop]?.name ?? '', UiTheme.TEXT, 1);

    const fraction = timeline.duration > 0 ? clamp(this.time / timeline.duration, 0, 1) : 1;
    const barY = y + h - this.s(16), barW = w - this.s(28);
    ui.rect(x + this.s(14), barY, barW, this.s(4), Rgba.hex(0xffffff, 0.15));
    ui.rect(x + this.s(14), barY, barW * fraction, this.s(4), UiTheme.BOOKMARK);
    for (let i = 1; i < timeline.count; i++) {
      const tick = timeline.startOf(i) / Math.max(timeline.duration, 0.001);
      ui.rect(x + this.s(14) + barW * tick - this.s(1), barY - this.s(2), this.s(2), this.s(8), Rgba.hex(0xffffff, 0.35));
    }
  }

  // #endregion

  // #region Settings view (bookmark list)

  /** Opens or closes the tour settings view in place of the bookmark rows. */
  toggleSettings(w: Widgets): void {
    this.flushDraft();
    this.settingsOpen = !this.settingsOpen;
    this.draft = this.settingsOpen ? { ...this.session.bookmarks.tour } : null;
    this.stopScroll = 0;
    w.activeSlider = -1;
  }

  /** Opens the settings view (after a recording, with its notice). */
  openSettings(): void {
    this.settingsOpen = true;
    this.draft = { ...this.session.bookmarks.tour };
  }

  /** Leaves the settings view (the bookmark list closes), saving the draft. */
  closeSettings(): void {
    this.flushDraft();
    this.settingsOpen = false;
    this.draft = null;
  }

  /** Saves the draft settings if they changed. */
  flushDraft(): void {
    if (!this.draftDirty || !this.draft) { return; }
    this.draftDirty = false;
    this.session.bookmarks.setTour(this.draft);
  }

  /** The tour settings view: tour-wide settings on the left, each bookmark's overrides on the right. */
  buildSettings(f: FontAtlas, w: Widgets, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, input = session.input;
    this.draft ??= { ...session.bookmarks.tour };
    if (!input.leftDown) { w.activeSlider = -1; }
    const draft = this.draft;
    const lw = Math.min(this.s(320), width * 0.42);
    let ly = y;

    ui.text(f.body, x, ly, 'Between stops', UiTheme.TEXT);
    const transitionIndex = draft.transition === 'glide' ? 1 : 0;
    const transition = w.segmented(f, x, ly + this.s(22), lw, TRANSITION_OPTIONS, transitionIndex);
    if (transition !== transitionIndex) { draft.transition = (transition === 1 ? 'glide' : 'fade') as TourTransition; this.draftDirty = true; }
    ly += this.s(64);

    if (draft.transition === 'fade') {
      const fade = Math.round(w.slider(f, SLIDER_TOUR_FADE, x, ly, lw, 'Fade (each way)', `${draft.fadeSeconds.toFixed(1)} s`, draft.fadeSeconds, 0, TourLimits.MAX_FADE) * 10) / 10;
      if (w.activeSlider === SLIDER_TOUR_FADE && fade !== draft.fadeSeconds) { draft.fadeSeconds = fade; this.draftDirty = true; }
    } else {
      const glide = Math.round(w.slider(f, SLIDER_TOUR_GLIDE, x, ly, lw, 'Glide (at least)', `${draft.glideSeconds.toFixed(1)} s`, draft.glideSeconds,
        TourLimits.MIN_GLIDE, TourLimits.MAX_GLIDE) * 2) / 2;
      if (w.activeSlider === SLIDER_TOUR_GLIDE && glide !== draft.glideSeconds) { draft.glideSeconds = glide; this.draftDirty = true; }
    }
    ly += this.s(58);

    const hold = Math.round(w.slider(f, SLIDER_TOUR_HOLD, x, ly, lw, 'Hold at each stop', `${draft.holdSeconds.toFixed(1)} s`, draft.holdSeconds, TourLimits.MIN_HOLD, 30) * 2) / 2;
    if (w.activeSlider === SLIDER_TOUR_HOLD && hold !== draft.holdSeconds) { draft.holdSeconds = hold; this.draftDirty = true; }
    ly += this.s(62);

    const swivel = w.checkbox(f, x, ly, lw, 'Swivel slowly at each stop', draft.swivel);
    if (swivel !== draft.swivel) { draft.swivel = swivel; this.draftDirty = true; }
    ly += this.s(30);
    if (draft.swivel) {
      const angle = Math.round(w.slider(f, SLIDER_TOUR_SWIVEL, x, ly, lw, 'Swivel angle', `${Math.round(draft.swivelDegrees)}°`, draft.swivelDegrees, 5, TourLimits.MAX_SWIVEL) / 5) * 5;
      if (w.activeSlider === SLIDER_TOUR_SWIVEL && angle !== draft.swivelDegrees) { draft.swivelDegrees = angle; this.draftDirty = true; }
      ly += this.s(54);
      const directionIndex = draft.swivelDirection === 'right' ? 1 : 0;
      const direction = w.segmented(f, x, ly, lw, SWIVEL_DIRECTION_OPTIONS, directionIndex);
      if (direction !== directionIndex) { draft.swivelDirection = (direction === 1 ? 'right' : 'left') as TourSwivelDirection; this.draftDirty = true; }
    }

    // The stops on the right; under them the UI / loop ticks, the tour's length and the walkthrough video's size and
    // rate (RECORD VIDEO is beside PLAY TOUR). The desktop keeps these under the left column, which runs out of room in
    // a browser window on a 720 px screen. The block stays above the notice line.
    const rx = x + lw + this.s(32), rw = width - lw - this.s(32), bw = Math.min(rw, this.s(420));
    const blockBottom = bottom - this.s(20);
    let by = blockBottom - this.s(176);
    this.buildStopRows(f, w, rx, y, rw, by - this.s(12));

    const showUi = w.checkbox(f, rx, by, bw, 'Show the UI (minimap, status, room)', draft.showUi);
    if (showUi !== draft.showUi) { draft.showUi = showUi; this.draftDirty = true; }
    by += this.s(28);
    const loop = w.checkbox(f, rx, by, bw, 'Loop (start again after the last stop)', draft.loop);
    if (loop !== draft.loop) { draft.loop = loop; this.draftDirty = true; }
    by += this.s(30);

    const { length, stops } = this.length(draft);
    const seconds = Math.round(length);
    ui.text(f.mono, rx, by, `${stops} ${stops === 1 ? 'stop' : 'stops'} · ${Math.trunc(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} ${draft.loop ? 'per loop' : 'in all'}`,
      UiTheme.TEXT_SOFT);
    by += this.s(30);
    session.video.buildSettings(f, w, rx, by, bw);

    // Save once a change is finished (a slider is released, a click is done)
    if (this.draftDirty && !input.leftDown) { this.flushDraft(); }
  }

  /** The right-hand table: per bookmark, in or out of the tour, its hold and its swivel (each "TOUR" until set). */
  private buildStopRows(f: FontAtlas, w: Widgets, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, input = session.input;
    const list = session.bookmarks.bookmarks;
    ui.text(f.small, x, y + this.s(2), 'STOPS · EACH CAN OVERRIDE THE TOUR', UiTheme.TEXT_MUTED, this.s(1.4));
    y += this.s(26);
    if (list.length === 0) {
      ui.textWrapped(f.body, x, y, width, Hints.tourEmpty.text, UiTheme.TEXT_MUTED, 2);
      return;
    }

    const rowH = this.s(40);
    const visible = Math.max(1, Math.trunc((bottom - y) / rowH));
    const maxScroll = Math.max(0, list.length - visible);
    if (input.wheel !== 0) { this.stopScroll -= input.wheel * 2; }
    this.stopScroll = clamp(this.stopScroll, 0, maxScroll);

    const small = this.s(28), bh = this.s(28), gap = this.s(4);
    const swivelW = this.s(96), holdW = this.s(52);
    const controlsW = small + gap + holdW + small * 3 + gap * 3 + this.s(12) + swivelW + small * 2 + gap * 2;
    const nameW = width - controlsW - small - this.s(16);
    const tour = this.draft ?? session.bookmarks.tour;

    let changed: { record: BookmarkRecord; hold: number | null; swivel: number | null; skip: boolean } | null = null;
    const last = Math.min(list.length, this.stopScroll + visible);
    for (let i = this.stopScroll; i < last; i++) {
      const record = list[i];
      const ry = y + (i - this.stopScroll) * rowH;
      if (((i - this.stopScroll) & 1) === 0) { ui.rect(x - this.s(6), ry - this.s(4), width + this.s(12), rowH - this.s(4), Rgba.hex(0xffffff, 0.03)); }
      const by = ry;
      const alpha = record.tourSkip ? 0.45 : 1;
      const same = { record, hold: record.tourHold, swivel: record.tourSwivel, skip: record.tourSkip };

      // In the tour?
      const inTour = w.checkbox(f, x, by + this.s(6), small, '', !record.tourSkip);
      if (inTour === record.tourSkip) { changed = { ...same, skip: !inTour }; }

      ui.textWrapped(f.body, x + small + this.s(4), by + this.s(5), nameW, `${i + 1}  ${record.name}`, Rgba.withAlpha(UiTheme.TEXT, alpha), 1);

      // Hold: value (TOUR when not set), − + × (reset)
      let bx = x + small + this.s(8) + nameW;
      const holdFor = tourHoldFor(tour, record);
      ui.textRight(f.mono, bx + holdW, by + this.s(6), `${holdFor.toFixed(1)} s`, record.tourHold !== null ? Rgba.hex(0x67e8f9) : UiTheme.TEXT_FAINT);
      bx += holdW + gap;
      if (w.smallButton(f, bx, by, small, bh, '−')) { changed = { ...same, hold: Math.max(TourLimits.MIN_HOLD, holdFor - 1) }; }
      bx += small + gap;
      if (w.smallButton(f, bx, by, small, bh, '+')) { changed = { ...same, hold: Math.min(TourLimits.MAX_HOLD, holdFor + 1) }; }
      bx += small + gap;
      if (w.smallButton(f, bx, by, small, bh, '×') && record.tourHold !== null) { changed = { ...same, hold: null }; }
      bx += small + this.s(12);

      // Swivel: TOUR → OFF → LEFT → RIGHT → TOUR; − + change a set angle
      if (w.smallButton(f, bx, by, swivelW, bh, swivelLabel(record, tour))) {
        const magnitude = Math.max(5, Math.abs(record.tourSwivel ?? tour.swivelDegrees));
        const s = record.tourSwivel;
        changed = { ...same, swivel: s === null ? 0 : s === 0 ? magnitude : s > 0 ? -magnitude : null };
      }
      bx += swivelW + gap;
      const set = record.tourSwivel;
      if (set !== null && set !== 0) {
        if (w.smallButton(f, bx, by, small, bh, '−')) { changed = { ...same, swivel: Math.sign(set) * Math.max(5, Math.abs(set) - 15) }; }
        if (w.smallButton(f, bx + small + gap, by, small, bh, '+')) { changed = { ...same, swivel: Math.sign(set) * Math.min(TourLimits.MAX_SWIVEL, Math.abs(set) + 15) }; }
      }
    }

    if (maxScroll > 0) {
      ui.textRight(f.small, x + width, bottom + this.s(2), `${this.stopScroll + 1}–${last} of ${list.length} · wheel to scroll`, UiTheme.TEXT_FAINT);
    }

    // Act after drawing (the list must not change while it is being walked)
    if (changed) { session.bookmarks.setTourOverrides(changed.record, changed.hold, changed.swivel, changed.skip); }
  }

  /** The tour's length with these settings, worked out like TourTimeline without building one. */
  length(settings: TourSettings): { length: number; stops: number } {
    let stops = 0, total = 0;
    let previous: BookmarkRecord | null = null;
    for (const record of this.session.bookmarks.bookmarks) {
      if (record.tourSkip) { continue; }
      stops++;
      total += tourHoldFor(settings, record);
      if (settings.transition === 'fade') { total += settings.fadeSeconds * 2; }
      else if (previous) { total += TourTimeline.glideFor(V.distance(previous.local, record.local), settings.glideSeconds); }
      previous = record;
    }
    if (settings.transition === 'glide' && stops > 0) { total += settings.fadeSeconds * 2; }
    return { length: total, stops };
  }

  // #endregion
}

/** The swivel button's label for a bookmark: TOUR, OFF, or the direction and angle (to the nearest 5°). */
function swivelLabel(record: BookmarkRecord, tour: TourSettings): string {
  const swivel = record.tourSwivel;
  if (swivel === null) { return tour.swivel ? 'TOUR' : 'TOUR (OFF)'; }
  if (swivel === 0) { return 'OFF'; }
  const step = clamp(Math.round(Math.abs(swivel) / 5), 1, TourLimits.MAX_SWIVEL / 5);
  return `${swivel > 0 ? 'LEFT' : 'RIGHT'} ${step * 5}°`;
}
