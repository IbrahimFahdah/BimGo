import { type CameraPath, CameraPathLimits, CAMERA_KEY_MAX_HOLD, newCameraKey, newCameraPath } from '../core/format/CameraPathModels';
import {
  type BookmarkRecord, type SunTime, TourLimits, type TourSettings, type TourSwivelDirection, tourHoldFor, tourSwivelFor, type VisibilitySettings,
  cleanTourSettings, copyVisibility, sunBlend
} from '../core/format/DocumentModels';
import { clamp, type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import type { SectionCut } from '../core/scene/SectionCut';
import { type ITourTimeline, type TourPose, TourTimeline, type TourTransition, tourStop } from '../core/scene/TourTimeline';
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
import { ScrollRegion } from './PanelShell';
import { PathStore } from './PathStore';

const DEGREES = Math.PI / 180;

/** Within this many seconds of a stop's start, "previous" goes to the stop before; later, to this stop's start. */
const TOUR_PREVIOUS_GRACE = 1.5;

const TRANSITION_OPTIONS = ['Fade', 'Glide', 'Smooth']; // K-C: Smooth (TourSettings.smooth)
const SWIVEL_DIRECTION_OPTIONS = ['Left', 'Right'];
const SLIDER_TOUR_FADE = 40, SLIDER_TOUR_GLIDE = 41, SLIDER_TOUR_HOLD = 42, SLIDER_TOUR_SWIVEL = 43, SLIDER_TOUR_SPEED = 44;

/** What a stop applies (a bookmark, or a path's key as a record: Round K-A). */
export interface TourRecord {
  name: string;
  local: Vec3;
  sun: SunTime | null;
  section: SectionCut | null;
  visibility: VisibilitySettings | null;
  eyeHeight: number | null;
  colourProfile: string | null;
}

/** The walkthrough's state when the tour started (put back at the end; also used by stops that kept nothing). */
interface SavedState {
  feet: Vec3;
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
  /** P-C: the colour profile showing ("" = none). */
  profile: string;
  /** K-C: walking or flying (a key photo puts walking back). */
  flying: boolean;
}

/**
 * Bookmark tour and camera path playback (port of GameSession.Tour.cs): plays the bookmarks in list order, hands-free.
 * Each stop fades in, holds (with an optional slow swivel) and fades out, the camera glides from stop to stop, or
 * (K-C Smooth) follows one spline through them. Round K-A: a camera path plays through the same player. Every stop
 * applies what its bookmark (or key) kept (sun time, section cut, hidden items, eye height, colour profile); a stop
 * without one of those uses the walkthrough's own state from when it started. When it ends (or Esc stops it) the
 * walkthrough goes back to what it was, and nothing is marked changed.
 *
 * Keys while playing: Space pause, → / Page Down / LMB next stop, ← / Page Up / RMB previous (or the start of this
 * stop), Esc stop, F11 fullscreen. Started from MEDIA (TOUR / PATHS) or BOOKMARKS → PLAY TOUR.
 */
export class TourPlayer {
  // Playback
  active = false;
  paused = false;
  timeline: ITourTimeline | null = null;
  records: TourRecord[] = [];
  /** Round K-A: the camera path playing, or null for the bookmark tour. */
  path: CameraPath | null = null;
  /** The settings this run plays with (UI on / off, loop). */
  run: TourSettings | null = null;
  time = 0;
  pose: TourPose | null = null;
  private appliedStop = -1;
  private hintUntil = 0;
  private saved: SavedState | null = null;
  private sunBlending = false;
  private readonly blendSun: SunTime = { month: 6, day: 21, minutes: 720, daylightSaving: false } as SunTime;

  // What the current stop applied (reference checks skip re-applying the same state)
  private appliedSun: SunTime | null = null;
  private appliedSection: SectionCut | null = null;
  private appliedVisibility: VisibilitySettings | null = null;

  // The tour settings (Round K-A: MEDIA → TOUR, was in the bookmark list): a draft saved when a change is finished
  private draft: TourSettings | null = null;
  private draftDirty = false;
  private readonly stopScroll = new ScrollRegion();
  private readonly settingsScroll = new ScrollRegion();

  // Round K-C: the smooth tour's length for the TOUR / VIDEO tabs (rebuilt when the bookmarks or the settings change)
  private smoothKey = '';
  private smoothLength = 0;
  private smoothStops = -1;

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
      const notice = session.bookmarks.bookmarks.length === 0
        ? `No bookmarks to tour yet: press ${keyOf(InputAction.AddBookmark)} where you want a stop`
        : 'Every bookmark is left out of the tour (MEDIA → TOUR ticks them back in)';
      session.menu.setBookmarksNotice(notice);
      session.media.notice = notice;
      session.sound.play(SoundId.Error);
      return false;
    }

    const run = cleanTourSettings({ ...session.bookmarks.tour });
    this.saveWalkthrough();
    const saved = this.saved!;

    // Round K-C: SMOOTH plays the stops as a camera path (one player); one stop alone fades in and out
    if (run.smooth && records.length >= 2) {
      const smooth = this.tourAsPath(records, run, saved.eye, false);
      this.begin(session.paths.timeline(smooth), records, run, null, capture);
      console.info(`Tour started (smooth): ${this.timeline!.count} stop(s), ${this.timeline!.duration.toFixed(1)} s, ${run.smoothSpeed.toFixed(2)} m/s.`);
      return true;
    }

    // Lay the stops out (eye height: the bookmark's, else the current one; P-C: a crouched bookmark films from the
    // crouched eye, in the same proportion to its standing eye as the player's)
    const ratio = this.crouchRatio();
    const stops = records.map(r => tourStop(r.local, (r.eyeHeight ?? saved.eye) * (r.crouched && !r.flying ? ratio : 1), r.yaw, clamp(r.pitch, -1.5, 1.5),
      tourHoldFor(run, r), tourSwivelFor(run, r) * DEGREES));
    this.begin(new TourTimeline(stops, run.transition, run.fadeSeconds, run.glideSeconds), records, run, null, capture);
    console.info(`Tour started: ${this.timeline!.count} stop(s), ${this.timeline!.duration.toFixed(1)} s, ${run.transition}.`);
    return true;
  }

  /**
   * Round K-A: PLAY PATH: plays a camera path through the tour player (the walkthrough comes back as it was at the end).
   * @returns False (with a notice) when there is nothing to play.
   */
  startPath(path: CameraPath | null, capture = true, oneKeyOk = false): boolean {
    const session = this.session;
    if (this.active || !path) { return false; }
    this.flushDraft();
    if (path.keys.length < (oneKeyOk ? 1 : 2)) {
      session.media.notice = 'A path needs two keys or more: fly to each place and ADD KEY HERE';
      session.sound.play(SoundId.Error);
      return false;
    }
    this.saveWalkthrough();
    const timeline = session.paths.timeline(path);
    const records = session.paths.records(path, timeline);
    const run = cleanTourSettings({ ...session.bookmarks.tour, showUi: oneKeyOk ? false : path.showUi, loop: oneKeyOk ? false : path.loop });
    this.begin(timeline, records, run, path, capture);
    console.info(`Path started: ${path.name}, ${path.keys.length} keys, ${timeline.pathLength.toFixed(1)} m, ${timeline.duration.toFixed(1)} s, loop ${path.loop}.`);
    return true;
  }

  /** P-C: the crouched eye as a share of the standing eye (a crouched stop films lower). */
  private crouchRatio(): number {
    const c = this.session.player.controller;
    return c.standEye > 0.01 ? c.crouchEye / c.standEye : 0.6;
  }

  /**
   * Remembers the walkthrough as it is (put back when the tour or path ends). Round K-C: the 3D editor's preview state
   * (and a key photo's) is put back first, so it isn't what is remembered.
   */
  private saveWalkthrough(): void {
    this.session.keyPhotos.endKeyPhoto(); // a key photo's walkthrough comes back first
    this.session.pathEditor.endState();
    this.unstage(false);
    this.rememberWalkthrough();
  }

  /** K-C: remembers the walkthrough's position and state. */
  private rememberWalkthrough(): void {
    const session = this.session, player = session.player, sun = session.sun;
    const sunTime: SunTime = { ...sun.settings.time };
    sun.blendMinutes = NaN;
    if (sun.playing) { sunTime.minutes = clamp(Math.round(sun.playMinutes), 0, 1439); }
    this.saved = {
      feet: V.copy(player.feet), yaw: player.yaw, pitch: player.pitch,
      sun: sunTime, shadows: sun.settings.enabled, sunPlaying: sun.playing,
      section: session.section.current.clone(), visibility: session.toVisibilitySettings(), isolate: session.isolateBackup,
      eye: player.controller.standEye, preset: session.eye.preset, eyeCustom: session.eye.custom, uiHidden: session.uiHidden,
      profile: session.profiles.bookmarkProfile(), flying: player.flying
    };
  }

  /** Starts playing a laid-out tour or path (the walkthrough already remembered): clears the stage, shows the first pose. */
  private begin(timeline: ITourTimeline, records: TourRecord[], run: TourSettings, path: CameraPath | null, capture: boolean): void {
    const session = this.session;
    this.timeline = timeline;
    this.records = records;
    this.run = run;
    this.path = path;

    // Clear the stage: menu, panels, a gun mid-move
    session.menu.closeBookmarks();
    session.media.closePanel(); // Round K-A: drafts saved first
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
  }

  /**
   * Ends the tour and puts the walkthrough back as it was when it started.
   * @param finished True when it played to the end (else Esc stopped it).
   * @param quiet True to skip the toast (a recording ends it with its own notice).
   */
  stop(finished: boolean, quiet = false): void {
    const session = this.session, saved = this.saved;
    if (!this.active || !saved) { return; }
    this.active = false;
    this.paused = false;

    this.restoreState();
    session.player.controller.setStandingEye(saved.eye, true);
    session.eye.preset = saved.preset;
    session.eye.custom = saved.eyeCustom;
    session.player.teleportTo(saved.feet, saved.yaw, saved.pitch);
    session.uiHidden = saved.uiHidden;

    const path = this.path !== null;
    this.timeline = null;
    this.records = [];
    this.path = null;
    this.saved = null;
    this.pose = null;
    session.input.releaseAll();
    if (!quiet) {
      session.toast(path
        ? finished ? 'Path finished: back where you were' : 'Path stopped: back where you were'
        : finished ? 'Tour finished: back where you were' : 'Tour stopped: back where you were', 2.4);
    }
  }

  /** K-C: puts back the state rememberWalkthrough kept: sun, colour profile, cut, hidden items (not the position). */
  private restoreState(): void {
    const session = this.session, saved = this.saved;
    if (!saved) { return; }
    this.endSunBlend();
    session.sun.setQuiet(saved.sun, saved.shadows);
    if (saved.sunPlaying && saved.shadows) { session.sun.togglePlay(); }
    session.profiles.applySaved(saved.profile, true); // P-C: the profile as it was
    session.section.setQuiet(saved.section);
    session.applyVisibility(saved.visibility, false);
    session.isolateBackup = saved.isolate;
  }

  // #endregion

  // #region Staging (Round K-C: the 3D editor's preview and key photos)

  /** True while a path's state shows without playing it (the 3D editor's scrubber, a key photo). */
  private staged = false;

  get isStaged(): boolean { return this.staged; }

  /** Shows a path's records without playing it: the walkthrough is remembered the first time. */
  stage(records: TourRecord[]): void {
    if (this.active) { return; }
    if (!this.staged) {
      this.rememberWalkthrough();
      this.staged = true;
    }
    if (records !== this.records) {
      this.records = records;
      this.appliedStop = -1;
      this.appliedSun = null;
      this.appliedSection = null;
      this.appliedVisibility = null;
    }
  }

  /** The staged state at a pose: the key's (applied once per key) and the sun blending between keys. */
  showStaged(pose: TourPose): void {
    if (!this.staged || pose.stop < 0 || pose.stop >= this.records.length) { return; }
    if (pose.stop !== this.appliedStop) { this.applyStop(pose.stop); }
    this.blendSunFor(pose);
  }

  /** One staged stop's state now (a key photo). */
  applyStagedStop(index: number): void {
    if (this.staged && index >= 0 && index < this.records.length) { this.applyStop(index); }
  }

  /**
   * Puts the walkthrough's state back after staging (the camera left the path, the editor closed, a tour starts).
   * @param position Also the position, eye height and walking / flying (a key photo closing).
   */
  unstage(position: boolean): void {
    if (!this.staged) { return; }
    const session = this.session, saved = this.saved!;
    this.staged = false;
    this.restoreState();
    if (position) {
      session.player.controller.setStandingEye(saved.eye, true);
      session.eye.preset = saved.preset;
      session.eye.custom = saved.eyeCustom;
      if (session.player.flying !== saved.flying) { session.player.toggleFly(); }
      session.player.teleportTo(saved.feet, saved.yaw, saved.pitch);
    }
    this.records = [];
    this.saved = null;
  }

  // #endregion

  // #region Playback

  /** Per frame while it plays (instead of the walkthrough's keys): pause, next / previous, stop, then the clock and pose. */
  update(input: InputState, dt: number): void {
    const session = this.session, timeline = this.timeline!;
    // Round K-C: PHOTOS OF ALL KEYS steps from key to key itself (Esc stops)
    if (session.keyPhotos.batchActive) {
      session.keyPhotos.update(input);
      return;
    }
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

  /** Jumps to the next stop, or to the previous one (to this stop's start when it has been showing a while). */
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

  /** Jumps the clock to a stop's start (key photos). */
  jumpTo(stop: number): void {
    if (!this.timeline) { return; }
    this.time = this.timeline.startOf(stop);
    this.evaluate();
  }

  /** The pose at the clock: applies a new stop's state, blends the sun, and moves the player there. */
  evaluate(): void {
    const pose = this.timeline!.pose(this.time);
    this.pose = pose;
    if (pose.stop < 0) { return; }
    if (pose.stop !== this.appliedStop) { this.applyStop(pose.stop); }
    this.blendSunFor(pose); // polish round P-C: the sun blends between stops instead of cutting
    this.session.player.teleportTo(pose.feet, pose.yaw, pose.pitch);
  }

  /**
   * Polish round P-C: between two stops with different suns, the sun's date and time move from one to the other
   * (shadows on / off switch halfway); held at a stop, the stop's own sun.
   */
  private blendSunFor(pose: TourPose): void {
    const saved = this.saved!, records = this.records, sun = this.session.sun;
    const from = pose.blendFrom, to = pose.blendTo;
    if (from < 0 || to < 0 || from === to || pose.blendT >= 1 || from >= records.length || to >= records.length) {
      this.endSunBlend();
      return;
    }
    const a = records[from].sun ?? saved.sun, b = records[to].sun ?? saved.sun;
    const shadowsA = records[from].sun !== null || saved.shadows, shadowsB = records[to].sun !== null || saved.shadows;
    const same = a.month === b.month && a.day === b.day && a.minutes === b.minutes && a.daylightSaving === b.daylightSaving && shadowsA === shadowsB;
    if (same) {
      this.endSunBlend();
      return;
    }
    const t = pose.blendT;
    const minutes = sunBlend(a, b, t, new Date().getFullYear(), this.blendSun); // K-C: the date the short way round
    this.sunBlending = true;
    sun.playing = false;
    sun.settings.time = { ...this.blendSun };
    sun.settings.enabled = t < 0.5 ? shadowsA : shadowsB;
    sun.blendMinutes = minutes; // fractional: the sun moves smoothly
    sun.recompute();
    this.appliedSun = null; // the next stop applies its own sun
  }

  /** P-C: a blend that was showing ends: the stop's own sun again. */
  private endSunBlend(): void {
    if (!this.sunBlending) { return; }
    this.sunBlending = false;
    const sun = this.session.sun, saved = this.saved;
    sun.blendMinutes = NaN;
    if (saved && this.appliedStop >= 0 && this.appliedStop < this.records.length) {
      const record = this.records[this.appliedStop];
      sun.setQuiet(record.sun ?? saved.sun, record.sun !== null || saved.shadows);
      this.appliedSun = record.sun ?? saved.sun;
    } else {
      sun.recompute();
    }
  }

  /**
   * Applies what a stop kept, without recording anything for saving: sun, cut, visibility, eye height, colour profile.
   * Parts it didn't keep fall back to the state from the start.
   */
  private applyStop(index: number): void {
    const session = this.session, saved = this.saved!;
    this.appliedStop = index;
    const record = this.records[index];

    const sun = record.sun ?? saved.sun;
    if (sun !== this.appliedSun && !this.sunBlending) {
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

    session.eye.apply(record.eyeHeight ?? saved.eye); // P-C: the standing eye (a crouched stop's camera is lower)
    session.profiles.applySaved(record.colourProfile ?? saved.profile, true); // P-C
  }

  // #endregion

  // #region Overlay

  /**
   * The 2D layer: with the UI on, the status, coordinates, minimap, room and a bar; then the fade; then the key hint for
   * the first seconds (and while paused).
   */
  buildOverlay(width: number, height: number, mapX: number, mapY: number): void {
    const session = this.session, ui = session.ui, f = ui.atlas, pose = this.pose;
    if (session.keyPhotos.batchActive) {
      // K-C: PHOTOS OF ALL KEYS: only its progress (no fades, no hint)
      session.keyPhotos.buildOverlay(f, width, height);
      return;
    }
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
      const hint = this.path !== null
        ? this.paused ? Hints.pathPaused.text : Hints.pathPlaying.text // Round K-A
        : this.paused ? Hints.tourPaused.text : Hints.tourPlaying.text;
      const hintW = UiBatch.measure(f.body, hint) + this.s(28);
      const hx = Math.round(width * 0.5 - hintW * 0.5);
      const hy = height - this.s(session.uiHidden ? 64 : 112);
      ui.panel(hx, hy, hintW, this.s(30), Rgba.withAlpha(UiTheme.PANEL, hintAlpha), Rgba.withAlpha(UiTheme.PANEL_BORDER, hintAlpha));
      ui.textCentred(f.body, width * 0.5, hy + this.s(7), hint, Rgba.withAlpha(UiTheme.TEXT, hintAlpha));
    }
  }

  /** Bottom-centre bar (UI on): stop number, bookmark (or path) name and the progress. */
  buildBar(f: FontAtlas, width: number, height: number): void {
    const session = this.session, ui = session.ui, timeline = this.timeline!;
    const stop = Math.max(0, this.pose?.stop ?? 0);
    const w = Math.min(this.s(560), width - this.s(40)), h = this.s(58);
    const x = Math.round((width - w) * 0.5), y = height - this.s(20) - h;
    ui.panel(x, y, w, h, UiTheme.PANEL, UiTheme.PANEL_BORDER);

    const label = `${this.path ? 'PATH · KEY ' : 'TOUR · '}${stop + 1} / ${timeline.count}${this.paused ? ' · PAUSED' : ''}`;
    const used = ui.text(f.small, x + this.s(14), y + this.s(12), label, UiTheme.BOOKMARK_LABEL, this.s(1.4));
    const name = this.path ? this.path.name : this.records[stop]?.name ?? '';
    ui.textWrapped(f.bold, x + this.s(14) + used + this.s(12), y + this.s(9), w - used - this.s(40), name, UiTheme.TEXT, 1);

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

  // #region Settings view (MEDIA → TOUR)

  /** Round K-A: the TOUR tab opens on a fresh draft of the saved settings. */
  resetSettingsView(w: Widgets): void {
    this.flushDraft();
    this.draft = { ...this.session.bookmarks.tour };
    this.stopScroll.reset();
    this.settingsScroll.reset();
    w.activeSlider = -1;
  }

  /** Leaves the settings view, saving the draft. */
  closeSettings(): void {
    this.flushDraft();
    this.draft = null;
  }

  /** Saves the draft settings if they changed. */
  flushDraft(): void {
    if (!this.draftDirty || !this.draft) { return; }
    this.draftDirty = false;
    this.session.bookmarks.setTour(this.draft);
  }

  /**
   * The tour settings (MEDIA → TOUR): tour-wide settings on the left (scrolling in a short window), each bookmark's
   * overrides on the right. True when CONVERT TO PATH was pressed (the caller switches to PATHS).
   */
  buildSettings(f: FontAtlas, w: Widgets, x: number, y: number, width: number, bottom: number): boolean {
    const session = this.session, ui = session.ui, input = session.input;
    this.draft ??= { ...session.bookmarks.tour };
    if (!input.leftDown) { w.activeSlider = -1; }
    const draft = this.draft;
    const lw = Math.min(this.s(320), width * 0.42);
    let ly = session.shell.beginScroll(this.settingsScroll, input, x, y, lw + this.s(UiTheme.SCROLL_GUTTER), bottom - y);

    ui.text(f.body, x, ly, 'Between stops', UiTheme.TEXT);
    const shownTransition = draft.smooth ? 2 : draft.transition === 'glide' ? 1 : 0;
    const transition = w.segmented(f, x, ly + this.s(22), lw, TRANSITION_OPTIONS, shownTransition);
    if (transition !== shownTransition) {
      // K-C: Smooth is its own field (older builds keep reading the file); Fade / Glide switch it off
      draft.smooth = transition === 2;
      if (transition < 2) { draft.transition = (transition === 1 ? 'glide' : 'fade') as TourTransition; }
      this.draftDirty = true;
    }
    ly += this.s(64);

    if (draft.smooth) {
      const speed = Math.round(w.slider(f, SLIDER_TOUR_SPEED, x, ly, lw, 'Speed between stops', `${draft.smoothSpeed.toFixed(2)} m/s`, draft.smoothSpeed,
        TourLimits.MIN_SMOOTH_SPEED, TourLimits.MAX_SMOOTH_SPEED) * 4) / 4;
      if (w.activeSlider === SLIDER_TOUR_SPEED && speed !== draft.smoothSpeed) { draft.smoothSpeed = speed; this.draftDirty = true; }
    } else if (draft.transition === 'fade') {
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
      ly += this.s(44);
    }

    const showUi = w.checkbox(f, x, ly, lw, 'Show the UI (minimap, status, room)', draft.showUi);
    if (showUi !== draft.showUi) { draft.showUi = showUi; this.draftDirty = true; }
    ly += this.s(28);
    const loop = w.checkbox(f, x, ly, lw, 'Loop (start again after the last stop)', draft.loop);
    if (loop !== draft.loop) { draft.loop = loop; this.draftDirty = true; }
    ly += this.s(36);

    const { length, stops } = this.length(draft);
    const seconds = Math.round(length);
    ui.text(f.mono, x, ly, `${stops} ${stops === 1 ? 'stop' : 'stops'} · ${Math.trunc(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} ${draft.loop ? 'per loop' : 'in all'}`,
      UiTheme.TEXT_SOFT);
    ly += this.s(32);
    if (draft.smooth) {
      // K-C: what Smooth does
      ly += ui.textWrapped(f.small, x, ly, lw, 'Smooth: one spline through the stops; each holds (and swivels), the camera follows the path between them and turns into each view',
        UiTheme.TEXT_FAINT, 3) + this.s(10);
    }
    ui.textWrapped(f.small, x, ly, lw, 'Video size and frame rate: the VIDEO tab (RECORD VIDEO below records this tour)', UiTheme.TEXT_FAINT, 2);
    ly += this.s(44);

    // K-C: CONVERT TO PATH copies the ticked stops into a new camera path
    const convert = w.smallButton(f, x, ly, lw, this.s(30), 'CONVERT TO PATH');
    ly += this.s(36);
    ly += ui.textWrapped(f.small, x, ly, lw, 'Copies the ticked stops into a new camera path (MEDIA → PATHS) to edit freely; the tour stays as it is',
      UiTheme.TEXT_FAINT, 3) + this.s(12);
    session.shell.endScroll(this.settingsScroll, input, ly);

    // Save once a change is finished (a slider is released, a click is done)
    if (this.draftDirty && !input.leftDown) { this.flushDraft(); }

    this.buildStopRows(f, w, x + lw + this.s(32), y, width - lw - this.s(32), bottom);
    return convert;
  }

  /** The right-hand table: per bookmark, in or out of the tour, its hold and its swivel (each "TOUR" until set). */
  private buildStopRows(f: FontAtlas, w: Widgets, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, input = session.input, shell = session.shell;
    const list = session.bookmarks.bookmarks;
    ui.text(f.small, x, y + this.s(2), 'STOPS · EACH CAN OVERRIDE THE TOUR', UiTheme.TEXT_MUTED, this.s(1.4));
    y += this.s(26);
    if (list.length === 0) {
      ui.textWrapped(f.body, x, y, width, Hints.tourEmpty.text, UiTheme.TEXT_MUTED, 2);
      return;
    }

    const rowH = this.s(40);
    const listX = x;
    const top = shell.beginScroll(this.stopScroll, input, x, y, width, bottom - y);
    const cw = width - this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.stopScroll.visibleRows(rowH, list.length);
    x += this.s(6);
    width = cw - this.s(12);

    const small = this.s(28), bh = this.s(28), gap = this.s(4);
    const swivelW = this.s(96), holdW = this.s(52);
    const controlsW = small + gap + holdW + small * 3 + gap * 3 + this.s(12) + swivelW + small * 2 + gap * 2;
    const nameW = width - controlsW - small - this.s(16);
    const tour = this.draft ?? session.bookmarks.tour;

    let changed: { record: BookmarkRecord; hold: number | null; swivel: number | null; skip: boolean } | null = null;
    for (let i = first; i < last; i++) {
      const record = list[i];
      const ry = top + i * rowH + this.s(4);
      if ((i & 1) === 0) { ui.rect(listX, ry - this.s(4), cw, rowH - this.s(4), UiTheme.ROW_STRIPE); }
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
    shell.endScroll(this.stopScroll, input, top + list.length * rowH);

    // Act after drawing (the list must not change while it is being walked)
    if (changed) { session.bookmarks.setTourOverrides(changed.record, changed.hold, changed.swivel, changed.skip); }
  }

  /** The tour's length with these settings, worked out like TourTimeline without building one (smooth: from the path). */
  length(settings: TourSettings): { length: number; stops: number } {
    if (settings.smooth) {
      const smooth = this.smoothTourLength(settings);
      if (smooth) { return smooth; }
    }
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

  // #region Smooth tour and CONVERT TO PATH (Round K-C)

  /**
   * The tour's stops as a camera path (a tour is a path whose keys are the bookmarks): each key at the bookmark's eye
   * (feet + its eye height; crouched ones lower) holding its view for the stop's hold with its swivel, the path following
   * between them; the speed, fades, loop and UI from the tour.
   * @param forStore True for CONVERT TO PATH: the keys also copy each bookmark's sun, profile, cut and hidden items.
   */
  tourAsPath(records: BookmarkRecord[], run: TourSettings, standEye: number, forStore: boolean): CameraPath {
    const ratio = this.crouchRatio();
    const path = newCameraPath();
    path.speed = clamp(run.smoothSpeed, CameraPathLimits.MIN_SPEED, CameraPathLimits.MAX_SPEED);
    path.heading = 'follow';
    path.followBetween = true;
    path.level = true;
    path.fadeSeconds = clamp(run.fadeSeconds, 0, CameraPathLimits.MAX_FADE);
    path.loop = run.loop;
    path.showUi = run.showUi;
    const count = Math.min(records.length, CameraPathLimits.MAX_KEYS);
    for (let i = 0; i < count; i++) {
      const record = records[i];
      const eye = (record.eyeHeight ?? standEye) * (record.crouched && !record.flying ? ratio : 1);
      const swivel = tourSwivelFor(run, record);
      const key = newCameraKey();
      key.name = PathStore.cleanName(record.name) ?? `Stop ${i + 1}`;
      key.yaw = record.yaw;
      key.pitch = clamp(record.pitch, -1.5, 1.5);
      key.heading = 'key';
      key.holdSeconds = clamp(tourHoldFor(run, record), 0, CAMERA_KEY_MAX_HOLD);
      key.swivel = swivel !== 0 ? swivel : null;
      key.local = vec3(record.local.x, record.local.y, record.local.z + eye);
      if (forStore) {
        key.sun = record.sun ? { ...record.sun } : null;
        key.colourProfile = record.colourProfile;
        key.section = record.section?.clone() ?? null;
        key.visibility = record.visibility ? copyVisibility(record.visibility) : null;
      }
      path.keys.push(key);
    }
    return path;
  }

  /** The smooth tour's length and stop count (rebuilt only when the bookmarks or the settings change); null below two stops. */
  private smoothTourLength(settings: TourSettings): { length: number; stops: number } | null {
    const session = this.session;
    const eye = session.player.controller.standEye;
    const key = `${session.bookmarks.revision}|${eye.toFixed(4)}|${settings.smoothSpeed}|${settings.holdSeconds}|${settings.fadeSeconds}|${settings.swivel}|`
      + `${settings.swivelDegrees}|${settings.swivelDirection}|${settings.loop}`;
    if (key !== this.smoothKey) {
      this.smoothKey = key;
      const records = session.bookmarks.bookmarks.filter(r => !r.tourSkip);
      this.smoothStops = records.length;
      this.smoothLength = records.length >= 2 ? session.paths.timeline(this.tourAsPath(records, cleanTourSettings({ ...settings }), eye, false)).duration : 0;
    }
    return this.smoothStops >= 2 ? { length: this.smoothLength, stops: this.smoothStops } : null;
  }

  /**
   * CONVERT TO PATH (MEDIA → TOUR): copies the ticked stops into a new camera path ("<model> tour"). The tour itself is
   * left as it is. Returns the new path, or null (with a notice).
   */
  convertToPath(): CameraPath | null {
    const session = this.session;
    this.flushDraft();
    const records = session.bookmarks.bookmarks.filter(r => !r.tourSkip);
    if (records.length === 0) {
      session.media.notice = session.bookmarks.bookmarks.length === 0
        ? `No bookmarks to convert yet: press ${keyOf(InputAction.AddBookmark)} where you want a stop`
        : 'Every bookmark is left out of the tour: tick the stops to convert';
      session.sound.play(SoundId.Error);
      return null;
    }
    const path = this.tourAsPath(records, cleanTourSettings({ ...session.bookmarks.tour }), session.player.controller.standEye, true);
    const model = session.document.name.replace(/\.[^.]+$/, '').trim();
    path.name = (model || 'Bookmark') + ' tour';
    const added = session.paths.store.addBuiltPath(path);
    if (!added) {
      session.media.notice = 'The path could not be made';
      session.sound.play(SoundId.Error);
      return null;
    }
    const capped = records.length > CameraPathLimits.MAX_KEYS ? ` (the first ${CameraPathLimits.MAX_KEYS})` : '';
    session.media.notice = `Made “${added.name}” from ${added.keys.length} stop${added.keys.length === 1 ? '' : 's'}${capped}: `
      + 'each key keeps its bookmark\'s view, hold, swivel, sun, profile, cut and hidden items · EDIT IN 3D to shape it';
    session.sound.play(SoundId.Commit);
    console.info(`Tour converted to path: ${added.name}, ${added.keys.length} keys.`);
    return added;
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
