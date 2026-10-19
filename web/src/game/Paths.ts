import {
  type CameraHeading, type CameraKey, type CameraPath, CameraPathLimits, CAMERA_KEY_MAX_HOLD, keyHasTarget, pathEasesAt, pathHeadingFor, pathSmoothnessFor,
  pathSpeedFor
} from '../core/format/CameraPathModels';
import { type SunTime, sunBlend, TourLimits, type VisibilitySettings } from '../core/format/DocumentModels';
import { clamp, Vec3 as V } from '../core/math/Vector';
import { cameraPathPoint, cameraPathSettings, CameraPathTimeline } from '../core/scene/CameraPathTimeline';
import { InputAction } from '../core/scene/InputCatalog';
import type { SectionCut } from '../core/scene/SectionCut';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { keyOf } from '../platform/Hotkeys';
import type { InputState } from '../platform/input';
import type { GameSession } from './GameSession';
import { Hints } from './Hints';
import type { Widgets } from './Menus';
import { ScrollRegion } from './PanelShell';
import { PathStore } from './PathStore';
import type { TourRecord } from './Tour';
import { UnitFormat } from './UnitFormat';

const DEGREES = Math.PI / 180;
const PATH_HEADING_OPTIONS = ['Follow path', 'Key views'];
const KEY_EASE_OPTIONS = ['Auto', 'On', 'Off'];
const KEY_HEADING_OPTIONS = ['Path', 'Follow', 'Own view', 'Look at'];
/** Distance a look-at target goes ahead of the eye when nothing is aimed at (m). */
const TARGET_FALLBACK_DISTANCE = 10;

/** A path's cached timing for the lists (rebuilt when the store changes, never per frame). */
interface PathStats { duration: number; length: number; label: string }

const two = (n: number) => String(n).padStart(2, '0');

/**
 * Round K-A (port of GameSession.Paths.cs): keyframed camera paths. MEDIA → PATHS lists the model's paths (left) and
 * edits the selected one (right): its settings in a strip, its keys in a list, and the selected key's fields (hold,
 * speed, smoothness, ease, heading and look-at target, sun time, colour profile, swivel, cut and hidden items; SET TO
 * THIS VIEW, GO TO, reorder, duplicate, delete). PLAY PATH plays it through the tour player; RECORD VIDEO records it.
 */
export class CameraPaths {
  readonly store: PathStore;
  /** The selected path and key in MEDIA → PATHS. */
  path: CameraPath | null = null;
  key: CameraKey | null = null;
  private pathDeleteArmed: CameraPath | null = null;
  private keyDeleteArmed: CameraKey | null = null;
  private deleteArmedUntil = 0;
  readonly pathListScroll = new ScrollRegion();
  readonly keyListScroll = new ScrollRegion();
  readonly keyEditorScroll = new ScrollRegion();
  private readonly stats = new Map<CameraPath, PathStats>();
  private statsKey = '';

  constructor(private readonly session: GameSession, live: boolean) {
    this.store = new PathStore(session.scene.modelTitle, session.scene.originOffset, live);
    this.store.loadFrom(session.document.paths);
  }

  private s(v: number): number { return this.session.s(v); }

  // #region Timing

  /** A path's timeline (allocates: on start and when the store changes). Look-at keys without a target hold their own view. */
  timeline(path: CameraPath): CameraPathTimeline {
    const points = path.keys.map((key, i) => {
      let heading: CameraHeading = pathHeadingFor(path, key);
      if (heading === 'lookAt' && !key.targetLocal) { heading = 'key'; }
      return cameraPathPoint(key.local, key.yaw, key.pitch, heading, key.targetLocal ?? key.local, pathSmoothnessFor(path, key), pathSpeedFor(path, key),
        key.holdSeconds, pathEasesAt(path, i), (key.swivel ?? 0) * DEGREES); // K-C: the swivel
    });
    return new CameraPathTimeline(points, cameraPathSettings(path.loop, path.fadeSeconds, path.lookAhead, path.level, path.followBetween),
      this.session.player.controller.standEye);
  }

  /**
   * Each key's state as a record for the tour player: name, the sun (filled in between keyed suns), and the colour
   * profile, cut and hidden items carried on from the key that set them.
   */
  records(path: CameraPath, timeline: CameraPathTimeline): TourRecord[] {
    let profile: string | null = null;
    let section: SectionCut | null = null;
    let visibility: VisibilitySettings | null = null;
    return path.keys.map((key, i) => {
      profile = key.colourProfile ?? profile;
      section = key.section ?? section;
      visibility = key.visibility ?? visibility;
      return { name: key.name, local: key.local, sun: sunForKey(path, timeline, i), colourProfile: profile, section, visibility, eyeHeight: null };
    });
  }

  /** Rebuilds every path's cached duration, length and list label when the store (or the units) changed. */
  refreshStats(): void {
    const key = `${this.store.revision}|${UnitFormat.isImperial}|${UnitFormat.decimalFeet}`;
    if (key === this.statsKey) { return; }
    this.statsKey = key;
    this.stats.clear();
    for (const path of this.store.paths) {
      let duration = 0, length = 0;
      if (path.keys.length >= 2) {
        const timeline = this.timeline(path);
        duration = timeline.duration;
        length = timeline.pathLength;
      }
      const seconds = Math.round(duration);
      const keys = path.keys.length === 1 ? '1 key' : `${path.keys.length} keys`;
      const label = path.keys.length < 2
        ? keys + ' · add keys to play it'
        : `${keys} · ${UnitFormat.appendLength(this.session.text.clear(), length, 1).text} · ${Math.trunc(seconds / 60)}:${two(seconds % 60)}${path.loop ? ' · loop' : ''}`;
      this.stats.set(path, { duration, length, label });
    }
  }

  /** A path's list label ("6 keys · 48.2 m · 0:36"). */
  statsLabel(path: CameraPath): string { return this.stats.get(path)?.label ?? ''; }

  /** A path's duration (s; 0 below two keys). */
  duration(path: CameraPath): number {
    this.refreshStats();
    return this.stats.get(path)?.duration ?? 0;
  }

  // #endregion

  // #region Selection

  /** Drops a selection that is no longer in the store. */
  validateSelection(): void {
    const paths = this.store.paths;
    if (this.path && !paths.includes(this.path)) { this.path = null; }
    if (!this.path && paths.length > 0) { this.path = paths[0]; }
    if (this.key && (!this.path || !this.path.keys.includes(this.key))) { this.key = null; }
  }

  /** Resets the tab's scrolls and delete arming (MEDIA switching to PATHS). */
  resetView(): void {
    this.pathDeleteArmed = null;
    this.keyDeleteArmed = null;
    this.pathListScroll.reset();
    this.keyListScroll.reset();
    this.keyEditorScroll.reset();
  }

  /** Disarms the delete buttons (MEDIA closing or switching tab). */
  disarm(): void {
    this.pathDeleteArmed = null;
    this.keyDeleteArmed = null;
  }

  /** Selects a path (a converted tour, a new path). */
  select(path: CameraPath | null): void {
    this.path = path;
    this.key = null;
    this.pathListScroll.scrollToEnd();
  }

  /** The camera's view now (ADD KEY HERE / SET TO THIS VIEW): the eye shown, the player's look. */
  private currentView(): { eye: { x: number; y: number; z: number }; yaw: number; pitch: number } {
    const session = this.session;
    return { eye: V.copy(session.camera.position), yaw: session.player.yaw, pitch: session.player.pitch };
  }

  /** GO TO: closes the panel and flies the player to a key's view (fly mode, the eye on the key). */
  private goToKey(path: CameraPath, key: CameraKey): void {
    const session = this.session, player = session.player;
    this.path = path;
    this.key = key;
    session.media.closePanel();
    session.setPaused(false);
    if (!player.flying) { player.toggleFly(); }
    player.teleportTo(V.sub(key.local, { x: 0, y: 0, z: player.controller.standEye }), key.yaw, key.pitch);
    session.sound.play(SoundId.Teleport);
    session.flash(UiTheme.BOOKMARK, 0.2);
    session.toast(`${key.name} of ${path.name}: fly to adjust, then ${keyOf(InputAction.MediaPanel)} → SET TO THIS VIEW`, 4);
  }

  // #endregion

  // #region Tab

  /** PATHS: the path list on the left; the selected path's settings, keys and key editor on the right. */
  buildTab(f: FontAtlas, w: Widgets, input: InputState, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui;
    this.refreshStats();
    this.validateSelection();
    if ((this.pathDeleteArmed || this.keyDeleteArmed) && session.clock > this.deleteArmedUntil) { this.disarm(); }

    const lw = Math.min(this.s(270), width * 0.26);
    this.buildPathList(f, w, input, x, y, lw, bottom);
    if (!session.media.isOpen) { return; }

    const rx = x + lw + this.s(UiTheme.GAP_LARGE), rw = width - lw - this.s(UiTheme.GAP_LARGE);
    ui.rect(rx - this.s(10), y, Math.max(1, ui.scale), bottom - y, UiTheme.DIVIDER);
    if (!this.path) {
      ui.textWrapped(f.body, rx, y + this.s(8), rw, Hints.pathsEmpty.text, UiTheme.TEXT_MUTED, 4);
      return;
    }
    const path = this.path;
    const cy = this.buildPathSettings(f, w, path, rx, y, rw);
    this.buildKeyArea(f, w, input, path, rx, cy, rw, bottom);
  }

  /** The path list: NEW PATH, the paths (name, keys · length · time), the selected path's buttons. */
  private buildPathList(f: FontAtlas, w: Widgets, input: InputState, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, shell = session.shell, store = this.store;
    const add = w.smallButton(f, x, y, width, this.s(30), 'NEW PATH');
    const listTop = y + this.s(38);
    const selected = this.path !== null;
    const controlsH = selected ? this.s(30) * 3 + this.s(8) * 2 + this.s(10) : 0; // K-C: a third row (PHOTOS OF ALL KEYS)
    const listBottom = bottom - controlsH;

    const rowH = this.s(52);
    const list = store.paths;
    const top = shell.beginScroll(this.pathListScroll, input, x, listTop, width, listBottom - listTop);
    const cw = width - this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.pathListScroll.visibleRows(rowH, list.length);
    let picked: CameraPath | null = null;
    for (let i = first; i < last; i++) {
      const path = list[i];
      const ry = top + i * rowH;
      const on = path === this.path;
      if (on) {
        ui.rect(x, ry, cw, rowH - this.s(4), Rgba.withAlpha(UiTheme.ACCENT, 0.16));
        ui.rect(x, ry, this.s(3), rowH - this.s(4), UiTheme.ACCENT);
      } else if ((i & 1) === 0) { ui.rect(x, ry, cw, rowH - this.s(4), UiTheme.ROW_STRIPE); }
      if (w.hover(x, ry, cw, rowH - this.s(4)) && input.leftPressed && !on) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        picked = path;
      }
      ui.textWrapped(f.bold, x + this.s(12), ry + this.s(6), cw - this.s(20), path.name, on ? UiTheme.TEXT : UiTheme.TEXT_SOFT, 1);
      ui.textWrapped(f.small, x + this.s(12), ry + this.s(28), cw - this.s(20), this.statsLabel(path), UiTheme.TEXT_MUTED, 1);
    }
    shell.endScroll(this.pathListScroll, input, top + list.length * rowH);
    if (list.length === 0) { ui.textWrapped(f.small, x, listTop + this.s(4), width, 'No paths yet', UiTheme.TEXT_FAINT, 1); }

    // The selected path's buttons
    let rename = false, duplicate = false, up = false, down = false, del = false, photos = false;
    if (selected) {
      let by = listBottom + this.s(10);
      const gap = this.s(6), half = (width - gap) * 0.5, third = (width - gap * 2) / 3;
      rename = w.smallButton(f, x, by, half, this.s(30), 'RENAME…');
      duplicate = w.smallButton(f, x + half + gap, by, half, this.s(30), 'DUPLICATE');
      by += this.s(38);
      up = w.smallButton(f, x, by, third, this.s(30), '↑');
      down = w.smallButton(f, x + third + gap, by, third, this.s(30), '↓');
      const armed = this.pathDeleteArmed === this.path;
      del = w.smallButton(f, x + (third + gap) * 2, by, third, this.s(30), armed ? 'SURE?' : 'DELETE', true);
      by += this.s(38);
      photos = w.smallButton(f, x, by, width, this.s(30), 'PHOTOS OF ALL KEYS'); // K-C
    }

    // Act after drawing (the list must not change while it is being walked)
    const media = session.media;
    if (picked) {
      this.path = picked;
      this.key = null;
      this.keyListScroll.reset();
      this.keyEditorScroll.reset();
      this.disarm();
    } else if (add) {
      this.path = store.addPath();
      this.key = null;
      this.pathListScroll.scrollToEnd();
      media.notice = `Made “${this.path.name}”: ADD KEY HERE adds this view; fly to the next place (${keyOf(InputAction.MediaPanel)} brings you back) and add again`;
      session.sound.play(SoundId.Commit);
    } else if (rename && this.path) {
      const target = this.path;
      session.editor.beginCustom('PATH NAME', target.name, PathStore.MAX_NAME, text => {
        if (store.rename(target, text)) { media.notice = `Renamed “${target.name}”`; }
      });
    } else if (duplicate && this.path) {
      const copy = store.duplicate(this.path);
      if (copy) {
        this.path = copy;
        this.key = null;
        media.notice = `Made “${copy.name}”`;
        session.sound.play(SoundId.Commit);
      }
    } else if ((up || down) && this.path) {
      store.move(this.path, up ? -1 : +1);
    } else if (photos && this.path) {
      session.keyPhotos.start(this.path); // K-C
    } else if (del && this.path) {
      if (this.pathDeleteArmed === this.path) {
        const name = this.path.name;
        if (media.videoPath === this.path) { media.videoPath = null; }
        store.remove(this.path);
        this.path = null;
        this.key = null;
        this.pathDeleteArmed = null;
        media.notice = `Deleted “${name}”`;
        session.sound.play(SoundId.Remove);
        this.validateSelection();
      } else {
        this.pathDeleteArmed = this.path;
        this.keyDeleteArmed = null;
        this.deleteArmedUntil = session.clock + 3;
      }
    }
  }

  /** The path's settings strip: speed, smoothness and heading; look-ahead, fade, level, loop and UI; the summary. */
  private buildPathSettings(f: FontAtlas, w: Widgets, path: CameraPath, x: number, y: number, width: number): number {
    const session = this.session, ui = session.ui, L = CameraPathLimits;
    let changed = false;
    let fx = x, fy = y;
    const rowH = this.s(38), gap = this.s(16), blockW = this.s(260);
    // Places a block in the strip, starting a new row when it doesn't fit
    const place = (blockWidth: number) => {
      if (fx > x && fx + blockWidth > x + width) {
        fx = x;
        fy += rowH;
      }
    };

    place(blockW);
    const speed = this.stepper(f, w, fx, fy, 'Speed', path.speed, 0.25, L.MIN_SPEED, L.MAX_SPEED, 2, ' m/s', true).value;
    if (speed !== path.speed) { path.speed = speed; changed = true; }
    fx += blockW + gap;

    place(blockW);
    const smooth = this.stepper(f, w, fx, fy, 'Smoothness', path.smoothness * 100, 10, 0, 100, 0, ' %', true).value / 100;
    if (Math.abs(smooth - path.smoothness) > 1e-4) { path.smoothness = smooth; changed = true; }
    fx += blockW + gap;

    const headingW = Math.min(this.s(240), width);
    place(headingW);
    const shownHeading = path.heading === 'key' ? 1 : 0;
    const heading = w.segmented(f, fx, fy, headingW, PATH_HEADING_OPTIONS, shownHeading);
    if (heading !== shownHeading) { path.heading = heading === 1 ? 'key' : 'follow'; changed = true; }
    fx = x;
    fy += rowH;

    place(blockW);
    const ahead = this.stepper(f, w, fx, fy, 'Look ahead', path.lookAhead, 0.5, L.MIN_LOOK_AHEAD, L.MAX_LOOK_AHEAD, 1, ' m', true).value;
    if (ahead !== path.lookAhead) { path.lookAhead = ahead; changed = true; }
    fx += blockW + gap;

    place(blockW);
    const fade = this.stepper(f, w, fx, fy, 'Fade', path.fadeSeconds, 0.25, 0, L.MAX_FADE, 2, ' s', true).value;
    if (fade !== path.fadeSeconds) { path.fadeSeconds = fade; changed = true; }
    fx += blockW + gap;

    const checkW = this.s(110);
    place(checkW * 3);
    const level = w.checkbox(f, fx, fy + this.s(8), checkW - this.s(6), 'Level', path.level);
    if (level !== path.level) { path.level = level; changed = true; }
    const loop = w.checkbox(f, fx + checkW, fy + this.s(8), checkW - this.s(6), 'Loop', path.loop);
    if (loop !== path.loop) { path.loop = loop; changed = true; }
    const showUi = w.checkbox(f, fx + checkW * 2, fy + this.s(8), checkW - this.s(6), 'Show UI', path.showUi);
    if (showUi !== path.showUi) { path.showUi = showUi; changed = true; }
    fx += checkW * 3 + gap;

    // K-C: between two keys with their own views, follow the path in the middle (a converted tour has it on)
    const betweenW = this.s(210);
    place(betweenW);
    const between = w.checkbox(f, fx, fy + this.s(8), betweenW - this.s(6), 'Follow between key views', path.followBetween);
    if (between !== path.followBetween) { path.followBetween = between; changed = true; }
    fy += rowH;

    if (changed) {
      this.store.touch(path);
      this.refreshStats();
    }

    // Summary
    ui.textWrapped(f.mono, x, fy + this.s(2), width, this.statsLabel(path), UiTheme.TEXT_SOFT, 1);
    fy += this.s(28);
    ui.rect(x, fy, width, Math.max(1, ui.scale), UiTheme.DIVIDER);
    return fy + this.s(10);
  }

  /** A compact labelled stepper: label, −, the value, + (and, for a key's own value, × back to the path's). */
  private stepper(f: FontAtlas, w: Widgets, x: number, y: number, label: string, value: number, step: number, min: number, max: number, decimals: number,
    unit: string, own: boolean, resettable = false): { value: number; reset: boolean } {
    const ui = this.session.ui;
    const labelW = this.s(92), button = this.s(28), valueW = this.s(96);
    ui.text(f.body, x, y + this.s(6), label, UiTheme.TEXT_SOFT);
    const bx = x + labelW;
    let changed = value;
    if (w.smallButton(f, bx, y, button, this.s(30), '−')) { changed = value - step; }
    ui.textCentred(f.bold, bx + button + valueW * 0.5, y + this.s(6), value.toFixed(decimals) + unit, own ? Rgba.hex(0x67e8f9) : UiTheme.TEXT_FAINT);
    if (w.smallButton(f, bx + button + valueW, y, button, this.s(30), '+')) { changed = value + step; }
    const reset = resettable && own && w.smallButton(f, bx + button * 2 + valueW + this.s(4), y, button, this.s(30), '×');
    return { value: changed === value ? value : Math.round(clamp(changed, min, max) / step) * step, reset };
  }

  /** The key list (left) and the selected key's editor (right). */
  private buildKeyArea(f: FontAtlas, w: Widgets, input: InputState, path: CameraPath, x: number, y: number, width: number, bottom: number): void {
    const kw = Math.min(this.s(330), width * 0.42);
    this.buildKeyList(f, w, input, path, x, y, kw, bottom);
    const ex = x + kw + this.s(UiTheme.GAP_LARGE), ew = width - kw - this.s(UiTheme.GAP_LARGE);
    this.buildKeyEditor(f, w, input, path, ex, y, ew, bottom);
  }

  /** The keys: ADD KEY HERE, then one row each (number, name, what it does). */
  private buildKeyList(f: FontAtlas, w: Widgets, input: InputState, path: CameraPath, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, shell = session.shell;
    ui.text(f.small, x, y + this.s(8), 'KEYS', UiTheme.TEXT_MUTED, this.s(1.8));
    const addW = Math.min(this.s(150), width * 0.55);
    const add = w.smallButton(f, x + width - addW, y, addW, this.s(30), 'ADD KEY HERE');
    const listTop = y + this.s(40);

    const keys = path.keys;
    const rowH = this.s(44);
    if (keys.length === 0) { ui.textWrapped(f.small, x, listTop, width, Hints.keysEmpty.text, UiTheme.TEXT_MUTED, 5); }
    const top = shell.beginScroll(this.keyListScroll, input, x, listTop, width, bottom - listTop);
    const cw = width - this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.keyListScroll.visibleRows(rowH, keys.length);
    let picked: CameraKey | null = null;
    for (let i = first; i < last; i++) {
      const key = keys[i];
      const ry = top + i * rowH;
      const on = key === this.key;
      if (on) {
        ui.rect(x, ry, cw, rowH - this.s(4), Rgba.withAlpha(UiTheme.ACCENT, 0.16));
        ui.rect(x, ry, this.s(3), rowH - this.s(4), UiTheme.ACCENT);
      } else if ((i & 1) === 0) { ui.rect(x, ry, cw, rowH - this.s(4), UiTheme.ROW_STRIPE); }
      if (w.hover(x, ry, cw, rowH - this.s(4)) && input.leftPressed && !on) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        picked = key;
      }
      ui.text(f.mono, x + this.s(10), ry + this.s(5), String(i + 1), UiTheme.BOOKMARK_LABEL);
      ui.textWrapped(f.bold, x + this.s(40), ry + this.s(4), cw - this.s(48), key.name, on ? UiTheme.TEXT : UiTheme.TEXT_SOFT, 1);
      ui.textWrapped(f.small, x + this.s(40), ry + this.s(24), cw - this.s(48), keyDetail(path, key, i), UiTheme.TEXT_MUTED, 1);
    }
    shell.endScroll(this.keyListScroll, input, top + keys.length * rowH);

    if (picked) {
      this.key = picked;
      this.keyDeleteArmed = null;
      this.keyEditorScroll.reset();
    } else if (add) {
      // After the selected key (or at the end)
      const view = this.currentView();
      const index = this.key ? keys.indexOf(this.key) + 1 : keys.length;
      const key = this.store.addKey(path, index, view.eye, view.yaw, view.pitch);
      if (!key) {
        session.media.notice = `A path holds at most ${CameraPathLimits.MAX_KEYS} keys`;
        session.sound.play(SoundId.Error);
      } else {
        this.key = key;
        if (index >= keys.length - 1) { this.keyListScroll.scrollToEnd(); }
        session.media.notice = `Added “${key.name}” at this view · fly to the next place and ${keyOf(InputAction.MediaPanel)} → ADD KEY HERE`;
        session.sound.play(SoundId.Commit);
        session.flash(UiTheme.BOOKMARK, 0.15);
      }
    }
  }

  /** The selected key's fields (a scroll region): name, view buttons, order, motion, heading, sun, profile, swivel, cut. */
  private buildKeyEditor(f: FontAtlas, w: Widgets, input: InputState, path: CameraPath, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, shell = session.shell, store = this.store, media = session.media;
    const key = this.key;
    if (!key) {
      ui.textWrapped(f.body, x, y + this.s(8), width, path.keys.length === 0 ? 'The selected key\'s settings show here.' : 'Pick a key on the left to edit it.',
        UiTheme.TEXT_FAINT, 3);
      return;
    }
    const index = path.keys.indexOf(key);
    let cy = shell.beginScroll(this.keyEditorScroll, input, x, y, width, bottom - y);
    const cw = width - this.s(UiTheme.SCROLL_GUTTER);
    const gap = this.s(6);
    let changed = false;

    // Name
    ui.text(f.small, x, cy + this.s(2), `KEY ${index + 1} OF ${path.keys.length}`, UiTheme.TEXT_MUTED, this.s(1.6));
    const rename = w.smallButton(f, x + cw - this.s(100), cy, this.s(100), this.s(26), 'RENAME…');
    cy += this.s(24);
    ui.textWrapped(f.bold, x, cy, cw, key.name, UiTheme.TEXT, 1);
    cy += this.s(30);

    // The view and the order
    const half = (cw - gap) * 0.5;
    const setView = w.smallButton(f, x, cy, half, this.s(30), 'SET TO THIS VIEW');
    const goTo = w.smallButton(f, x + half + gap, cy, half, this.s(30), 'GO TO');
    cy += this.s(36);
    const quarter = (cw - gap * 3) / 4;
    const up = w.smallButton(f, x, cy, quarter, this.s(30), '↑');
    const down = w.smallButton(f, x + quarter + gap, cy, quarter, this.s(30), '↓');
    const duplicate = w.smallButton(f, x + (quarter + gap) * 2, cy, quarter, this.s(30), 'DUPLICATE');
    const armed = this.keyDeleteArmed === key;
    const del = w.smallButton(f, x + (quarter + gap) * 3, cy, quarter, this.s(30), armed ? 'SURE?' : 'DELETE', true);
    cy += this.s(36);
    const photo = w.smallButton(f, x, cy, cw, this.s(30), 'PHOTO AT THIS KEY'); // K-C
    cy += this.s(44);

    // Motion
    const hold = this.stepper(f, w, x, cy, 'Hold', key.holdSeconds, 0.5, 0, CAMERA_KEY_MAX_HOLD, 1, ' s', key.holdSeconds > 0).value;
    if (hold !== key.holdSeconds) { key.holdSeconds = hold; changed = true; }
    cy += this.s(38);
    const speed = this.stepper(f, w, x, cy, 'Speed', pathSpeedFor(path, key), 0.25, CameraPathLimits.MIN_SPEED, CameraPathLimits.MAX_SPEED, 2, ' m/s', key.speed !== null, true);
    if (speed.reset) { key.speed = null; changed = true; } else if (speed.value !== pathSpeedFor(path, key)) { key.speed = speed.value; changed = true; }
    cy += this.s(38);
    const smooth = this.stepper(f, w, x, cy, 'Smoothness', pathSmoothnessFor(path, key) * 100, 10, 0, 100, 0, ' %', key.smoothness !== null, true);
    if (smooth.reset) { key.smoothness = null; changed = true; }
    else if (Math.abs(smooth.value / 100 - pathSmoothnessFor(path, key)) > 1e-4) { key.smoothness = smooth.value / 100; changed = true; }
    cy += this.s(40);

    ui.text(f.body, x, cy + this.s(7), 'Ease', UiTheme.TEXT_SOFT);
    const easeIndex = key.ease === null ? 0 : key.ease ? 1 : 2;
    const ease = w.segmented(f, x + this.s(92), cy, Math.min(this.s(240), cw - this.s(92)), KEY_EASE_OPTIONS, easeIndex);
    if (ease !== easeIndex) { key.ease = ease === 1 ? true : ease === 2 ? false : null; changed = true; }
    cy += this.s(36);
    if (key.holdSeconds > 0) { ui.text(f.small, x + this.s(92), cy, 'A key that holds always eases', UiTheme.TEXT_FAINT); cy += this.s(20); }
    cy += this.s(8);

    // Heading
    ui.text(f.body, x, cy + this.s(7), 'Heading', UiTheme.TEXT_SOFT);
    const headingIndex = key.heading === 'follow' ? 1 : key.heading === 'key' ? 2 : key.heading === 'lookAt' ? 3 : 0;
    const pickedHeading = w.segmented(f, x + this.s(92), cy, cw - this.s(92), KEY_HEADING_OPTIONS, headingIndex);
    if (pickedHeading !== headingIndex) {
      key.heading = pickedHeading === 1 ? 'follow' : pickedHeading === 2 ? 'key' : pickedHeading === 3 ? 'lookAt' : null;
      changed = true;
    }
    cy += this.s(38);
    let setTarget = false, clearTarget = false;
    const sx = x + this.s(92);
    switch (pathHeadingFor(path, key)) {
      case 'key':
        cy += ui.textWrapped(f.small, sx, cy, cw - this.s(92), 'Holds the view this key was set with (SET TO THIS VIEW changes it); the camera turns into it and back out',
          UiTheme.TEXT_FAINT, 2) + this.s(8);
        break;
      case 'lookAt': {
        if (key.targetLocal) {
          const distance = UnitFormat.appendLength(session.text.clear(), V.distance(key.targetLocal, key.local), 1).text;
          ui.text(f.small, sx, cy + this.s(8), `Target ${distance} from the key`, Rgba.hex(0x67e8f9));
        } else {
          ui.text(f.small, sx, cy + this.s(8), 'No target yet: holds its own view', UiTheme.TEXT_FAINT);
        }
        const tw = this.s(150);
        setTarget = w.smallButton(f, x + cw - tw - (keyHasTarget(key) ? this.s(34) : 0), cy, tw, this.s(28), 'SET TARGET: AIMED');
        if (keyHasTarget(key)) { clearTarget = w.smallButton(f, x + cw - this.s(28), cy, this.s(28), this.s(28), '×'); }
        cy += this.s(36);
        cy += ui.textWrapped(f.small, sx, cy, cw - this.s(92), 'The target is the surface you were aiming at when you opened this panel (or a point 10 m ahead)',
          UiTheme.TEXT_FAINT, 2) + this.s(8);
        break;
      }
      default:
        cy += ui.textWrapped(f.small, sx, cy, cw - this.s(92), 'Looks ahead along the path, turning with it', UiTheme.TEXT_FAINT, 1) + this.s(8);
        break;
    }

    // Sun
    ui.text(f.body, x, cy + this.s(7), 'Sun', UiTheme.TEXT_SOFT);
    if (key.sun) {
      ui.text(f.bold, sx, cy + this.s(6), `${key.sun.day}/${key.sun.month}  ${two(Math.trunc(key.sun.minutes / 60))}:${two(key.sun.minutes % 60)}`, Rgba.hex(0x67e8f9));
    } else {
      ui.text(f.small, sx, cy + this.s(8), 'Between its neighbours\' (or the walkthrough\'s)', UiTheme.TEXT_FAINT);
    }
    cy += this.s(30);
    const sunW = this.s(72);
    const sunNow = w.smallButton(f, sx, cy, this.s(120), this.s(28), 'USE THE SUN NOW');
    const sunEarlier = key.sun !== null && w.smallButton(f, sx + this.s(126), cy, sunW, this.s(28), '−30 MIN');
    const sunLater = key.sun !== null && w.smallButton(f, sx + this.s(126) + sunW + gap, cy, sunW, this.s(28), '+30 MIN');
    const sunClear = key.sun !== null && w.smallButton(f, sx + this.s(126) + (sunW + gap) * 2, cy, this.s(28), this.s(28), '×');
    cy += this.s(40);

    // Colour profile
    ui.text(f.body, x, cy + this.s(7), 'Profile', UiTheme.TEXT_SOFT);
    const profileLabel = key.colourProfile === null ? 'Leave as it is'
      : key.colourProfile === '' ? 'None (profiles off)'
        : session.profiles.profileName(key.colourProfile) ?? '(gone)';
    const cycleProfile = w.smallButton(f, sx, cy, Math.min(this.s(240), cw - this.s(92)), this.s(30), profileLabel);
    cy += this.s(36);
    ui.textWrapped(f.small, sx, cy, cw - this.s(92), 'Switches at this key; the next keys keep it until one changes it', UiTheme.TEXT_FAINT, 2);
    cy += this.s(34);

    // K-C: the swivel (own view + a hold) and the cut / hidden items
    const swivelOn = pathHeadingFor(path, key) === 'key' && key.holdSeconds > 0;
    const swivelValue = key.swivel ?? 0;
    let resetSwivel = false;
    if (swivelOn) {
      const swivel = this.stepper(f, w, x, cy, 'Swivel', swivelValue, 15, -TourLimits.MAX_SWIVEL, TourLimits.MAX_SWIVEL, 0, '°', key.swivel !== null, true);
      resetSwivel = swivel.reset;
      if (!resetSwivel && swivel.value !== swivelValue) { key.swivel = swivel.value === 0 ? null : swivel.value; changed = true; }
      cy += this.s(34);
      ui.text(f.small, sx, cy, 'Pans over the hold: + turns left, − right', UiTheme.TEXT_FAINT);
      cy += this.s(26);
    } else {
      ui.text(f.body, x, cy + this.s(2), 'Swivel', UiTheme.TEXT_SOFT);
      ui.text(f.small, sx, cy + this.s(4), 'With Own view and a hold', UiTheme.TEXT_FAINT);
      cy += this.s(30);
    }

    ui.text(f.body, x, cy + this.s(7), 'Cut, hidden', UiTheme.TEXT_SOFT);
    ui.textWrapped(f.small, sx, cy + this.s(8), cw - this.s(92), keyStateLabel(key), key.section || key.visibility ? Rgba.hex(0x67e8f9) : UiTheme.TEXT_FAINT, 1);
    cy += this.s(30);
    const stateNow = w.smallButton(f, sx, cy, this.s(120), this.s(28), 'USE THE VIEW NOW');
    const stateClear = (key.section !== null || key.visibility !== null) && w.smallButton(f, sx + this.s(126), cy, this.s(28), this.s(28), '×');
    cy += this.s(36);
    ui.textWrapped(f.small, sx, cy, cw - this.s(92), 'The section cut and hidden items from this key on (a converted tour keeps each bookmark\'s)', UiTheme.TEXT_FAINT, 2);
    cy += this.s(34);
    shell.endScroll(this.keyEditorScroll, input, cy);

    if (resetSwivel) { key.swivel = null; changed = true; }
    if (stateNow) {
      key.section = session.section.current.clone();
      key.visibility = session.bookmarkVisibility();
      changed = true;
      media.notice = `“${key.name}” keeps the cut and hidden items showing now`;
    } else if (stateClear) {
      key.section = null;
      key.visibility = null;
      changed = true;
    }

    // Act after drawing
    const sun = session.sun;
    if (sunNow) {
      key.sun = { ...sun.settings.time };
      if (sun.playing) { key.sun.minutes = clamp(Math.trunc(sun.playMinutes), 0, 1439); }
      changed = true;
      if (!sun.enabled) { media.notice = 'Shadows are off now: the path turns them on from this key when it plays'; }
    } else if ((sunEarlier || sunLater) && key.sun) {
      key.sun.minutes = clamp(key.sun.minutes + (sunLater ? 30 : -30), 0, 1439);
      changed = true;
    } else if (sunClear) {
      key.sun = null;
      changed = true;
    }
    if (cycleProfile) {
      key.colourProfile = session.profiles.nextChoice(key.colourProfile);
      changed = true;
    }
    if (setTarget) {
      const aim = session.aim;
      const point = aim.hit ? aim.hit.point : V.add(session.camera.position, V.scale(session.camera.forward, TARGET_FALLBACK_DISTANCE));
      store.setKeyTarget(path, key, point);
      media.notice = aim.hit ? 'Target set to the aimed surface' : 'Nothing aimed at: the target is 10 m ahead of the view';
    } else if (clearTarget) {
      store.setKeyTarget(path, key, null);
    }
    if (changed) {
      store.touch(path);
      this.refreshStats();
    }

    if (rename) {
      const target = key;
      session.editor.beginCustom('KEY NAME', target.name, PathStore.MAX_NAME, text => { store.renameKey(path, target, text); });
    } else if (setView) {
      const view = this.currentView();
      store.setKeyView(path, key, view.eye, view.yaw, view.pitch);
      media.notice = `“${key.name}” now sits at this view`;
      session.sound.play(SoundId.Commit);
    } else if (goTo) {
      this.goToKey(path, key);
    } else if (photo) {
      session.keyPhotos.openAtKey(path, key, false); // K-C
    } else if (up || down) {
      store.moveKey(path, key, up ? -1 : +1);
    } else if (duplicate) {
      const copy = store.duplicateKey(path, key);
      if (!copy) {
        media.notice = `A path holds at most ${CameraPathLimits.MAX_KEYS} keys`;
      } else {
        this.key = copy;
        media.notice = `Made “${copy.name}” (at the same place: SET TO THIS VIEW moves it)`;
      }
    } else if (del) {
      if (armed) {
        const name = key.name;
        store.removeKey(path, key);
        this.key = path.keys.length === 0 ? null : path.keys[clamp(index, 0, path.keys.length - 1)];
        this.keyDeleteArmed = null;
        media.notice = `Deleted “${name}”`;
        session.sound.play(SoundId.Remove);
      } else {
        this.keyDeleteArmed = key;
        this.pathDeleteArmed = null;
        this.deleteArmedUntil = session.clock + 3;
      }
    }
  }

  // #endregion
}

/**
 * A key's sun for playback: its own; else between the nearest keys before and after that have one (by the time each is
 * reached); else the nearest one's; else null (the walkthrough's).
 */
function sunForKey(path: CameraPath, timeline: CameraPathTimeline, index: number): SunTime | null {
  const keys = path.keys;
  if (keys[index].sun) { return { ...keys[index].sun }; }
  let before = -1, after = -1;
  for (let i = index - 1; i >= 0; i--) { if (keys[i].sun) { before = i; break; } }
  for (let i = index + 1; i < keys.length; i++) { if (keys[i].sun) { after = i; break; } }
  if (before < 0 && after < 0) { return null; }
  if (before < 0) { return { ...keys[after].sun! }; }
  if (after < 0) { return { ...keys[before].sun! }; }
  const t0 = timeline.startOf(before), t1 = timeline.startOf(after), t = timeline.startOf(index);
  const u = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
  const sun: SunTime = { ...keys[before].sun! };
  const minutes = sunBlend(keys[before].sun!, keys[after].sun!, u, new Date().getFullYear(), sun); // K-C: the short way round
  sun.minutes = clamp(Math.round(minutes), 0, 1439);
  return sun;
}

/** A key row's detail: hold, own speed, heading, sun, profile, swivel, cut. */
function keyDetail(path: CameraPath, key: CameraKey, index: number): string {
  const parts: string[] = [];
  if (key.holdSeconds > 0) { parts.push(`hold ${key.holdSeconds.toFixed(1)} s`); }
  else if (pathEasesAt(path, index)) { parts.push('eases'); }
  if (key.speed !== null) { parts.push(`${key.speed.toFixed(2)} m/s`); }
  const heading = pathHeadingFor(path, key);
  if (heading === 'key') { parts.push('own view'); }
  else if (heading === 'lookAt') { parts.push(keyHasTarget(key) ? 'looks at a point' : 'look at (no target)'); }
  if (key.sun) { parts.push(`sun ${Math.trunc(key.sun.minutes / 60)}:${two(key.sun.minutes % 60)}`); }
  if (key.colourProfile !== null) { parts.push(key.colourProfile === '' ? 'profile off' : 'profile'); }
  if (key.swivel !== null && key.holdSeconds > 0 && heading === 'key') { parts.push(`swivel ${key.swivel.toFixed(0)}°`); } // K-C
  if (key.section || key.visibility) { parts.push('cut / hidden'); } // K-C
  return parts.length === 0 ? 'passes through' : parts.join(' · ');
}

/** K-C: a key's cut and hidden items ("Leave as it is", "a cut · 3 hidden"…). */
function keyStateLabel(key: CameraKey): string {
  if (!key.section && !key.visibility) { return 'Leave as it is'; }
  const parts: string[] = [];
  if (key.section) { parts.push(key.section.isActive ? 'a cut' : 'no cut'); }
  if (key.visibility) {
    const v = key.visibility;
    const hidden = (v.hiddenCategories?.length ?? 0) + (v.hiddenLinks?.length ?? 0) + (v.hiddenElements?.length ?? 0);
    parts.push(hidden === 0 ? 'shows everything' : `${hidden} hidden`);
  }
  return parts.join(' · ');
}
