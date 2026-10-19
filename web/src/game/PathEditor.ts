import {
  type CameraKey, type CameraPath, CameraPathLimits, CAMERA_KEY_MAX_HOLD, keyHasTarget, pathHeadingFor, pathSmoothnessFor, pathSpeedFor, snapshotPath
} from '../core/format/CameraPathModels';
import { type SunTime, sunBlend } from '../core/format/DocumentModels';
import { clamp, type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import { type CameraPathPose, type CameraPathTimeline, pathPoseToTourPose } from '../core/scene/CameraPathTimeline';
import { InputAction } from '../core/scene/InputCatalog';
import { SolarPosition } from '../core/scene/SolarPosition';
import { TourTimeline } from '../core/scene/TourTimeline';
import { Overlay3D } from '../engine/render/Overlay3D';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { keyOf } from '../platform/Hotkeys';
import type { InputState } from '../platform/input';
import type { GameSession } from './GameSession';
import { Hints } from './Hints';
import { MediaTab } from './MediaPanel';
import { DOCK_BACK, DOCK_CLOSE, ScrollRegion } from './PanelShell';
import { closestOnAxis } from './SectionMode';
import type { TourRecord } from './Tour';

/** The editor's fly keys (forward, back, left, right, fast). */
export const PATH_MOVES: readonly InputAction[] = [
  InputAction.PathMoveForward, InputAction.PathMoveBack, InputAction.PathMoveLeft, InputAction.PathMoveRight, InputAction.PathFlyFast
];

const KEY_EASE_OPTIONS = ['Auto', 'On', 'Off'];
const KEY_HEADING_OPTIONS = ['Path', 'Follow', 'Own view', 'Look at'];
/** K inserts into the path when the eye is this close to it (m). */
const PATH_ON_DISTANCE = 1;
/** The path line's sample spacing (m; longer paths space them out to PATH_MAX_SAMPLES). */
const PATH_SAMPLE_STEP = 0.25;
const PATH_MAX_SAMPLES = 4000;
/** Handle drag steps: position (m) and view (radians). */
const PATH_SNAP = 0.05, PATH_VIEW_SNAP = 5 * Math.PI / 180;
/** Undo steps kept per session. */
const PATH_UNDO_MAX = 40;
const HANDLE_X = 0, HANDLE_Y = 1, HANDLE_Z = 2, HANDLE_VIEW = 3;
/** K-C: the scrubber's sun strip cells. */
const PATH_SUN_CELLS = 96;

type Rect = [number, number, number, number];
const inside = (r: Rect, x: number, y: number) => r[2] > 0 && x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];
const viewDirection = (yaw: number, pitch: number): Vec3 => vec3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch));
const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.trunc(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Round K-B (port of GameSession.PathEditor.cs): the camera path editor in 3D (Shift+K, or MEDIA → PATHS → EDIT IN 3D).
 * Like clash mode: a dock on the right, a free cursor, the editor's own fly keys (WASD, E / Q, Shift faster), RMB-drag
 * looks. The path is drawn (red where it passes through the model) with its keys, views, targets and K's insert marker;
 * K adds a key, Del deletes, ← / → snap into keys, Enter sets the view; the selected key (or its target) has X / Y / Z
 * arrows and a view handle; the scrubber drives the camera along the path; Space previews; Ctrl+Z undoes.
 */
export class PathEditor {
  on = false;
  private notice: string | null = null;
  private readonly dockScroll = new ScrollRegion();
  private dockRect: Rect = [0, 0, 0, 0];
  private barRect: Rect = [0, 0, 0, 0];
  private overlay: Overlay3D | null = null;

  // The edited path's timeline and its drawing (rebuilt when the store changes; collision when the path rests)
  private timeline: CameraPathTimeline | null = null;
  private timelineFor: CameraPath | null = null;
  private revision = -1;
  private readonly samples: Vec3[] = [];
  private readonly blocked: boolean[] = [];
  private sampleStep = 0;
  private collisionDirty = false;
  private blockedSegments = 0;

  // Snapped into a key (← / →): the key and the view it was snapped at
  private snapped: CameraKey | null = null;
  private snapEye: Vec3 = vec3();
  private snapYaw = 0;
  private snapPitch = 0;

  // Scrubber and preview; the camera was put on the path there (until it moves)
  private scrubTime = 0;
  private scrubDrag = false;
  private previewPlaying = false;
  private onScrub = false;
  private scrubEye: Vec3 = vec3();

  // Picking and handles
  private keyHover = -1;
  private targetHover = -1;
  private handleHover = -1;
  private handleDrag = -1;
  private subjectTarget = false;
  private pickTarget = false;
  private dragOrigin: Vec3 = vec3();
  private dragAxis: Vec3 = vec3();
  private dragStartParameter = 0;
  private dragApplied = NaN;
  private dragStartYaw = 0;
  private dragStartPitch = 0;

  // K's insert marker
  private insertShown = false;
  private insertPoint: Vec3 = vec3();

  // Undo: (path, snapshot before a change), newest last
  private readonly undo: { path: CameraPath; snapshot: CameraPath }[] = [];

  // K-C: the path's state shows while the camera is on the path (the tour player's staging); the preview's fade
  private records: TourRecord[] | null = null;
  private black = 0;
  private readonly sunStrip = new Array<number>(PATH_SUN_CELLS).fill(0);
  private sunStripOn = false;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  private get paths() { return this.session.paths; }

  /** True while the player waits for the editor: a preview, a scrub or a handle drag moves the camera. */
  get freezesPlayer(): boolean { return this.on && (this.previewPlaying || this.scrubDrag || this.handleDrag >= 0); }

  // #region Enter / leave

  /** Opens the editor on a path (null: the selected or first one; none: a new one): panels close, the player flies. */
  enter(path: CameraPath | null): void {
    const session = this.session, store = this.paths.store;
    if (!path || !store.paths.includes(path)) { path = store.paths.length > 0 ? store.paths[0] : store.addPath(); }
    if (session.clashModeOn) { session.clashes.exit(); }
    session.media.closePanel();
    session.menu.closeBookmarks();
    session.menu.closeOverlay();
    session.closeModes(null);
    const gun = session.guns[session.activeGun];
    if (gun.capturesInput) { gun.onCancel(); }
    if (session.paused) { session.setPaused(false); }
    session.showUi();

    if (this.paths.path !== path) { this.paths.key = null; }
    this.paths.path = path;
    this.on = true;
    this.notice = null;
    this.snapped = null;
    this.scrubTime = 0;
    this.scrubDrag = this.previewPlaying = this.onScrub = false;
    this.handleDrag = this.handleHover = this.keyHover = this.targetHover = -1;
    this.subjectTarget = this.pickTarget = false;
    this.revision = -1;
    this.dockScroll.reset();
    if (!session.player.flying) { session.player.toggleFly(); }
    session.releaseMouseForTyping();
    session.sound.play(SoundId.UiClick);
    session.toast(`Path editor: ${path.name} · ${keyOf(InputAction.PathAddKey)} adds a key · ${keyOf(InputAction.PathPreviousKey)} / ${keyOf(InputAction.PathNextKey)} snap into keys · `
      + `${keyOf(InputAction.PathSetKey)} sets · ${keyOf(InputAction.PathPreview)} previews · Esc leaves`, 5);
  }

  /** Leaves the editor (still flying; the path is saved as it is). */
  exit(): void {
    if (!this.on) { return; }
    const session = this.session;
    this.endDrag();
    this.endState(); // K-C: the walkthrough's sun, profile, cut and hidden items again
    this.on = false;
    this.previewPlaying = this.scrubDrag = false;
    this.snapped = null;
    this.pickTarget = false;
    session.input.releaseAll();
    if (!session.paused) { session.captureMouse(); }
    session.toast(`Path editor closed · still flying (${keyOf(InputAction.Fly)} walks)`, 2.5);
  }

  // #endregion

  // #region Frame

  /** The editor's keys and mouse (the dock and the scrubber handle their own clicks when they are drawn). */
  update(input: InputState, dt: number): void {
    const session = this.session, path = this.paths.path;
    if (!path || !this.paths.store.paths.includes(path)) {
      this.exit();
      return;
    }
    this.paths.validateSelection();
    this.ensureTimeline(path);

    // Leaving, or one step back (target picking, the preview)
    if (input.pressed(InputAction.Back)) {
      if (session.uiHidden) { session.showUi(); }
      else if (session.menu.closeOverlay()) { /* a dropdown closed */ }
      else if (this.pickTarget) { this.pickTarget = false; }
      else if (this.previewPlaying) { this.previewPlaying = false; }
      else { this.exit(); }
      return;
    }
    if (input.pressed(InputAction.PathEditMode)) {
      this.exit();
      return;
    }
    if (input.pressed(InputAction.Help)) { session.showHelp = !session.showHelp; }
    if (input.pressed(InputAction.HideUi)) { session.toggleUiHidden(); }
    if (input.pressed(InputAction.Fullscreen)) { session.toggleFullscreen(); }
    if (input.pressed(InputAction.Screenshot)) { session.requestScreenshot(); }
    if (input.down(InputAction.DragLook) && !this.previewPlaying && !this.scrubDrag) {
      session.player.look(input.mouseDeltaX, input.mouseDeltaY, session.settings.mouseSensitivity, session.settings.invertY);
    }
    if (!this.previewPlaying && !this.scrubDrag) { session.padEditorLook(input); }
    session.updateRoom();

    // The preview plays the camera along the path
    if (this.previewPlaying) { this.advancePreview(dt); }

    // Off the scrubber's spot once the camera moves
    if (this.onScrub && !this.previewPlaying && !this.scrubDrag && V.distanceSquared(session.camera.position, this.scrubEye) > 1e-4) {
      this.onScrub = false;
      this.endState(); // K-C
    }

    // Keys
    if (input.pressed(InputAction.PathUndo)) { this.undoChange(); }
    else if (input.pressed(InputAction.PathAddKey)) { this.addKeyHere(); }
    else if (input.pressed(InputAction.PathDeleteKey)) { this.deleteSelectedKey(); }
    else if (input.pressed(InputAction.PathSetKey)) { this.setSelectedKey(); }
    else if (input.pressedOrRepeated(InputAction.PathNextKey)) { this.snapToKey(+1); }
    else if (input.pressedOrRepeated(InputAction.PathPreviousKey)) { this.snapToKey(-1); }
    else if (input.pressed(InputAction.PathPreview)) { this.togglePreview(); }

    // The mouse in the scene (not over the dock or the scrubber)
    const mx = input.mouseX, my = input.mouseY;
    const overUi = inside(this.dockRect, mx, my) || inside(this.barRect, mx, my) || session.menu.overlays.isOpen;
    if (this.handleDrag >= 0) {
      if (!input.leftDown) { this.endDrag(); } else { this.dragHandle(mx, my, input.down(InputAction.PathFlyFast)); }
      this.insertShown = false;
      return;
    }

    const looking = input.down(InputAction.DragLook);
    this.handleHover = overUi || looking || this.pickTarget ? -1 : this.handleUnder(mx, my);
    this.keyHover = overUi || looking || this.handleHover >= 0 ? -1 : this.keyUnder(mx, my);
    this.targetHover = overUi || looking || this.handleHover >= 0 || this.keyHover >= 0 ? -1 : this.targetUnder(mx, my);
    this.updateInsertMarker();

    if (!input.leftPressed || overUi) { return; }
    if (this.pickTarget) {
      input.consumeClicks();
      this.pickTargetAt(mx, my);
    } else if (this.handleHover >= 0) {
      input.consumeClicks();
      this.beginDrag(this.handleHover, mx, my);
    } else if (this.keyHover >= 0) {
      input.consumeClicks();
      this.selectKey(path.keys[this.keyHover], false);
      session.sound.play(SoundId.UiClick);
    } else if (this.targetHover >= 0) {
      input.consumeClicks();
      this.selectKey(path.keys[this.targetHover], true);
      session.sound.play(SoundId.UiClick);
    }
  }

  /** Selects a key (and whether the handles sit on it or on its target). */
  selectKey(key: CameraKey | null, target: boolean): void {
    this.paths.key = key;
    this.subjectTarget = target && key !== null && key.targetLocal !== null;
    if (this.snapped !== key) { this.snapped = null; }
  }

  // #endregion

  // #region Timeline, drawing samples, collision

  /** Rebuilds the timeline and the line's samples when the path changed (allocates only then). */
  private ensureTimeline(path: CameraPath): void {
    const store = this.paths.store;
    if (this.timelineFor === path && this.revision === store.revision) { return; }
    this.timelineFor = path;
    this.revision = store.revision;
    this.timeline = path.keys.length >= 2 ? this.paths.timeline(path) : null;
    this.samples.length = 0;
    this.blocked.length = 0;
    this.blockedSegments = 0;

    // K-C: each key's state (the preview shows it) and the scrubber's sun strip
    this.records = this.timeline ? this.paths.records(path, this.timeline) : null;
    const tour = this.session.tour;
    if (tour.isStaged) {
      if (!this.records) { this.endState(); } else { tour.stage(this.records); }
    }
    this.buildSunStrip();
    const timeline = this.timeline;
    if (!timeline) { return; }

    const length = timeline.pathLength;
    let step = Math.max(PATH_SAMPLE_STEP, length / PATH_MAX_SAMPLES);
    const count = clamp(Math.ceil(length / step), 1, PATH_MAX_SAMPLES);
    step = length / count;
    this.sampleStep = step;
    for (let i = 0; i <= count; i++) { this.samples.push(timeline.pointAt(Math.min(i * step, length - 1e-4))); }
    this.blocked.length = count;
    this.blocked.fill(false);
    this.collisionDirty = true;
    this.scrubTime = clamp(this.scrubTime, 0, timeline.duration);
  }

  /** Marks the gaps between samples that pass through the model (visible static geometry, cuts honoured). Run at rest. */
  private updateCollision(): void {
    if (!this.collisionDirty || this.handleDrag >= 0 || !this.timeline) { return; }
    this.collisionDirty = false;
    this.blockedSegments = 0;
    let lastSegment = -1;
    for (let i = 0; i + 1 < this.samples.length; i++) {
      const a = this.samples[i], b = this.samples[i + 1];
      const d = V.sub(b, a);
      const length = V.length(d);
      this.blocked[i] = length > 1e-4 && this.session.pickStaticVisible(a, V.scale(d, 1 / length), length) !== null;
      if (this.blocked[i]) {
        const segment = this.timeline.segmentAt((i + 0.5) * this.sampleStep);
        if (segment !== lastSegment) {
          this.blockedSegments++;
          lastSegment = segment;
        }
      }
    }
  }

  /** K's insert marker: the nearest point on the path when the eye is within reach of it. */
  private updateInsertMarker(): void {
    this.insertShown = false;
    const timeline = this.timeline;
    if (!timeline) { return; }
    if (this.onScrub) {
      this.insertShown = true;
      this.insertPoint = this.scrubEye;
      return;
    }
    const nearest = timeline.nearest(this.session.camera.position);
    if (nearest.distance <= PATH_ON_DISTANCE) {
      this.insertShown = true;
      this.insertPoint = timeline.pointAt(nearest.along);
    }
  }

  // #endregion

  // #region Keys

  /** The camera's view now: the eye shown, the player's look. */
  private currentView(): { eye: Vec3; yaw: number; pitch: number } {
    const session = this.session;
    return { eye: V.copy(session.camera.position), yaw: session.player.yaw, pitch: session.player.pitch };
  }

  /** K: a key at the view. Placed by the scrubber: exactly there; near the path: into that segment; else after the selection. */
  private addKeyHere(): void {
    const session = this.session, path = this.paths.path!, timeline = this.timeline;
    let { eye, yaw, pitch } = this.currentView();
    let index: number;
    let where: string;
    if (this.onScrub && timeline) {
      const pose = timeline.evaluate(this.scrubTime);
      index = insertIndex(path, timeline.segmentAt(pose.distance));
      eye = pose.eye;
      yaw = pose.yaw;
      pitch = pose.pitch;
      where = 'on the path at the scrubber';
    } else if (timeline && timeline.nearest(eye).distance <= PATH_ON_DISTANCE) {
      index = insertIndex(path, timeline.nearest(eye).segment);
      where = 'into the path here';
    } else {
      const selected = this.paths.key ? path.keys.indexOf(this.paths.key) : -1;
      index = selected >= 0 ? selected + 1 : path.keys.length;
      where = selected >= 0 ? 'after the selected key' : 'at the end';
    }

    this.pushUndo(path);
    const key = this.paths.store.addKey(path, index, eye, yaw, pitch);
    if (!key) {
      this.undo.pop();
      this.notice = `A path holds at most ${CameraPathLimits.MAX_KEYS} keys`;
      session.sound.play(SoundId.Error);
      return;
    }
    this.selectKey(key, false);
    this.snapped = key;
    this.rememberSnapView();
    this.notice = `Added “${key.name}” ${where} (key ${path.keys.indexOf(key) + 1} of ${path.keys.length})`;
    session.sound.play(SoundId.Commit);
    session.flash(UiTheme.BOOKMARK, 0.12);
  }

  /** Del: deletes the selected key (Ctrl+Z brings it back); the next one is selected. */
  private deleteSelectedKey(): void {
    const session = this.session, path = this.paths.path!, key = this.paths.key;
    if (!key) {
      this.notice = 'Pick a key first (click it, or ← / →)';
      session.sound.play(SoundId.Error);
      return;
    }
    const index = path.keys.indexOf(key);
    this.pushUndo(path);
    this.paths.store.removeKey(path, key);
    this.selectKey(path.keys.length === 0 ? null : path.keys[clamp(index, 0, path.keys.length - 1)], false);
    this.snapped = null;
    this.notice = `Deleted “${key.name}” · ${keyOf(InputAction.PathUndo)} brings it back`;
    session.sound.play(SoundId.Remove);
  }

  /** Enter / SET: the selected key takes the view (position and look). */
  private setSelectedKey(): void {
    const session = this.session, path = this.paths.path!, key = this.paths.key;
    if (!key) {
      this.notice = `Pick a key first (${keyOf(InputAction.PathPreviousKey)} / ${keyOf(InputAction.PathNextKey)} snap into one)`;
      session.sound.play(SoundId.Error);
      return;
    }
    const { eye, yaw, pitch } = this.currentView();
    this.pushUndo(path);
    this.paths.store.setKeyView(path, key, eye, yaw, pitch);
    this.snapped = key;
    this.rememberSnapView();
    this.notice = `“${key.name}” set to this view`;
    session.sound.play(SoundId.Commit);
    session.flash(UiTheme.BOOKMARK, 0.12);
  }

  /** ← / →: the camera snaps into the previous / next key (from the selected one; none selected: the first / last). */
  private snapToKey(direction: number): void {
    const session = this.session, path = this.paths.path!, player = session.player;
    const count = path.keys.length;
    if (count === 0) {
      this.notice = `No keys yet: ${keyOf(InputAction.PathAddKey)} adds one at this view`;
      return;
    }
    const index = this.paths.key ? path.keys.indexOf(this.paths.key) : -1;
    const target = index < 0 ? (direction > 0 ? 0 : count - 1)
      : path.loop ? (index + direction + count) % count
        : clamp(index + direction, 0, count - 1);
    const key = path.keys[target];
    this.previewPlaying = false;
    this.selectKey(key, false);
    this.snapped = key;
    this.onScrub = false;
    this.endState(); // K-C: off the path: the walkthrough's state
    player.teleportTo(V.sub(key.local, vec3(0, 0, player.controller.standEye)), key.yaw, key.pitch);
    this.snapEye = V.copy(key.local);
    this.snapYaw = key.yaw;
    this.snapPitch = key.pitch;
    if (this.timeline) { this.scrubTime = this.timeline.startOf(target); }
    session.sound.play(SoundId.UiClick);
  }

  /** Remembers the view a key was snapped or set at (moving off it makes SET meaningful again). */
  private rememberSnapView(): void {
    const view = this.currentView();
    this.snapEye = view.eye;
    this.snapYaw = view.yaw;
    this.snapPitch = view.pitch;
  }

  /** True when the camera moved or turned since it snapped into the key. */
  private get snapMoved(): boolean {
    const session = this.session;
    return this.snapped !== null && (V.distanceSquared(session.camera.position, this.snapEye) > 1e-4
      || Math.abs(TourTimeline.lerpAngle(this.snapYaw, session.player.yaw, 1) - this.snapYaw) > 1e-3 || Math.abs(session.player.pitch - this.snapPitch) > 1e-3);
  }

  /** PICK TARGET, then a click: the selected key looks at the surface clicked. */
  private pickTargetAt(mx: number, my: number): void {
    const session = this.session, path = this.paths.path!, key = this.paths.key;
    this.pickTarget = false;
    if (!key) { return; }
    const ray = session.screenRay(mx, my);
    const hit = session.pickStaticVisible(ray.origin, ray.direction, 500);
    if (!hit) {
      this.notice = 'Nothing there: click a surface for the target';
      session.sound.play(SoundId.Error);
      return;
    }
    this.pushUndo(path);
    if (key.heading !== 'lookAt' && pathHeadingFor(path, key) !== 'lookAt') { key.heading = 'lookAt'; }
    this.paths.store.setKeyTarget(path, key, hit.point);
    this.subjectTarget = true;
    this.notice = `“${key.name}” looks at the point clicked (drag its handles to adjust)`;
    session.sound.play(SoundId.Commit);
  }

  // #endregion

  // #region Undo

  /** Remembers the path before a change (Ctrl+Z puts it back). */
  private pushUndo(path: CameraPath | null): void {
    if (!path) { return; }
    this.undo.push({ path, snapshot: snapshotPath(path) });
    if (this.undo.length > PATH_UNDO_MAX) { this.undo.shift(); }
  }

  /** Ctrl+Z: the last change to a path still in the store is undone (the selection follows by id). */
  private undoChange(): void {
    const session = this.session, store = this.paths.store;
    while (this.undo.length > 0) {
      const { path, snapshot } = this.undo.pop()!;
      if (!store.paths.includes(path)) { continue; }
      const selected = this.paths.key?.id ?? null;
      store.restore(path, snapshot);
      this.paths.path = path;
      this.paths.key = selected === null ? null : path.keys.find(k => k.id === selected) ?? null;
      this.snapped = null;
      this.subjectTarget = this.subjectTarget && this.paths.key?.targetLocal !== null && this.paths.key !== null;
      this.notice = this.undo.length === 0 ? 'Undone (nothing more to undo)' : `Undone (${this.undo.length} more)`;
      session.sound.play(SoundId.UiClick);
      return;
    }
    this.notice = 'Nothing to undo';
    session.sound.play(SoundId.Error);
  }

  // #endregion

  // #region Scrubber and preview

  /** Puts the camera on the path at a time (scrubber, preview): its position and heading. */
  private placeCamera(time: number): void {
    const timeline = this.timeline;
    if (!timeline) { return; }
    const player = this.session.player;
    this.scrubTime = clamp(time, 0, timeline.duration);
    const pose = timeline.evaluate(Math.min(this.scrubTime, timeline.duration - 1e-4));
    player.teleportTo(V.sub(pose.eye, vec3(0, 0, player.controller.standEye)), pose.yaw, pose.pitch);
    this.scrubEye = V.copy(pose.eye);
    this.onScrub = true;
    this.snapped = null;
    this.showState(pose); // K-C
  }

  /** K-C: the path's state at a pose (the key's, the sun blending between keys); the fade while previewing. */
  private showState(pose: CameraPathPose): void {
    const tour = this.session.tour;
    this.black = this.previewPlaying ? pose.black : 0;
    const records = this.records;
    if (!records || tour.active || pose.key < 0 || pose.key >= records.length) { return; }
    tour.stage(records);
    tour.showStaged(pathPoseToTourPose(pose, this.session.player.controller.standEye));
  }

  /** K-C: the camera left the path (or the editor closed, or a tour starts): the walkthrough's state again. */
  endState(): void {
    this.black = 0;
    this.session.tour.unstage(false);
  }

  /** Space: plays the camera along the path from the scrubber (from the start at the end), or pauses. */
  private togglePreview(): void {
    const session = this.session, timeline = this.timeline;
    if (!timeline) {
      this.notice = 'The path needs two keys or more to preview';
      session.sound.play(SoundId.Error);
      return;
    }
    this.previewPlaying = !this.previewPlaying;
    this.black = 0; // K-C: a paused preview shows the view
    if (this.previewPlaying && this.scrubTime >= timeline.duration - 0.01) { this.scrubTime = 0; }
    if (this.previewPlaying) { this.placeCamera(this.scrubTime); }
    session.sound.play(SoundId.UiClick);
  }

  /** The preview's clock: on along the path (round again when looping; stops at the end). */
  private advancePreview(dt: number): void {
    const timeline = this.timeline;
    if (!timeline) {
      this.previewPlaying = false;
      return;
    }
    let time = this.scrubTime + dt;
    if (time >= timeline.duration) {
      if (this.paths.path!.loop && timeline.duration > 0) { time %= timeline.duration; }
      else {
        time = timeline.duration;
        this.previewPlaying = false;
      }
    }
    this.placeCamera(time);
  }

  /** K-C: the scrubber's sun strip: the sun's height along the path (the same blend as playback), as colours. */
  private buildSunStrip(): void {
    this.sunStripOn = false;
    const timeline = this.timeline, records = this.records;
    if (!timeline || !records || timeline.duration <= 0 || records.length === 0 || !records[0].sun) { return; }
    const year = new Date().getFullYear();
    const scratch = { ...records[0].sun } as SunTime;
    const location = this.session.sun.location;
    for (let c = 0; c < PATH_SUN_CELLS; c++) {
      const pose = timeline.evaluate((c + 0.5) / PATH_SUN_CELLS * timeline.duration);
      const key = clamp(pose.key, 0, records.length - 1);
      const from = clamp(pose.blendFrom, 0, records.length - 1), to = clamp(pose.blendTo, 0, records.length - 1);
      const own = records[key].sun!;
      const a = records[from].sun ?? own, b = records[to].sun ?? own;
      const minutes = from !== to && pose.blendT < 1 ? sunBlend(a, b, pose.blendT, year, scratch) : sunBlend(own, own, 0, year, scratch);
      const { altitude } = SolarPosition.compute(location, year, scratch.month, scratch.day, minutes, scratch.daylightSaving);
      this.sunStrip[c] = sunStripColour(altitude * 180 / Math.PI);
    }
    this.sunStripOn = true;
  }

  // #endregion

  // #region Handles

  /** The handles' subject: the selected key, or its look-at target. */
  private subject(): Vec3 | null {
    const key = this.paths.key;
    if (!key) { return null; }
    if (this.subjectTarget && key.targetLocal) { return key.targetLocal; }
    return key.local;
  }

  /** The handles' length: about the same on screen at any distance. */
  private handleLength(subject: Vec3): number { return clamp(V.distance(this.session.camera.position, subject) * 0.12, 0.25, 4); }

  /** A handle's position and axis (X, Y, Z arrows; the view handle on the key only). */
  private handlePosition(handle: number): { position: Vec3; axis: Vec3 } | null {
    const subject = this.subject();
    if (!subject) { return null; }
    const length = this.handleLength(subject);
    let axis: Vec3;
    switch (handle) {
      case HANDLE_X: axis = vec3(1, 0, 0); break;
      case HANDLE_Y: axis = vec3(0, 1, 0); break;
      case HANDLE_Z: axis = vec3(0, 0, 1); break;
      case HANDLE_VIEW: {
        if (this.subjectTarget) { return null; }
        const key = this.paths.key!;
        axis = viewDirection(key.yaw, key.pitch);
        return { position: V.add(subject, V.scale(axis, length * 1.4)), axis };
      }
      default: return null;
    }
    return { position: V.add(subject, V.scale(axis, length)), axis };
  }

  /** The handle nearest the mouse (within 16 px), or -1. */
  private handleUnder(mx: number, my: number): number {
    let best = -1, bestDistance = this.s(16);
    for (let h = 0; h <= HANDLE_VIEW; h++) {
      const handle = this.handlePosition(h);
      const screen = handle ? this.session.camera.worldToScreen(handle.position) : null;
      if (!screen) { continue; }
      const distance = Math.hypot(screen.x - mx, screen.y - my);
      if (distance < bestDistance) { bestDistance = distance; best = h; }
    }
    return best;
  }

  /** The key marker nearest the mouse (within 14 px), or -1. */
  private keyUnder(mx: number, my: number): number {
    const keys = this.paths.path!.keys;
    let best = -1, bestDistance = this.s(14);
    for (let i = 0; i < keys.length; i++) {
      const screen = this.session.camera.worldToScreen(keys[i].local);
      if (!screen) { continue; }
      const distance = Math.hypot(screen.x - mx, screen.y - my);
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    return best;
  }

  /** The look-at target nearest the mouse (within 14 px): its key's index, or -1. */
  private targetUnder(mx: number, my: number): number {
    const path = this.paths.path!, keys = path.keys;
    let best = -1, bestDistance = this.s(14);
    for (let i = 0; i < keys.length; i++) {
      const target = keys[i].targetLocal;
      if (!target || pathHeadingFor(path, keys[i]) !== 'lookAt') { continue; }
      const screen = this.session.camera.worldToScreen(target);
      if (!screen) { continue; }
      const distance = Math.hypot(screen.x - mx, screen.y - my);
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    return best;
  }

  /** Starts dragging a handle (the path is remembered for undo). */
  private beginDrag(handle: number, mx: number, my: number): void {
    const session = this.session, key = this.paths.key;
    const h = this.handlePosition(handle), subject = this.subject();
    if (!h || !subject || !key) { return; }
    const ray = session.screenRay(mx, my);
    let parameter = 0;
    if (handle !== HANDLE_VIEW) {
      const p = closestOnAxis(subject, h.axis, ray.origin, ray.direction);
      if (p === null) { return; }
      parameter = p;
    }
    this.pushUndo(this.paths.path);
    this.handleDrag = handle;
    this.dragOrigin = V.copy(subject);
    this.dragAxis = h.axis;
    this.dragStartParameter = parameter;
    this.dragApplied = NaN;
    this.dragStartYaw = key.yaw;
    this.dragStartPitch = key.pitch;
    this.snapped = null;
    session.sound.play(SoundId.UiClick);
  }

  /** Moves the subject along the arrow to where the mouse ray passes closest (5 cm steps unless free), or turns the view. */
  private dragHandle(mx: number, my: number, free: boolean): void {
    const session = this.session, path = this.paths.path!, key = this.paths.key, store = this.paths.store;
    if (!key) {
      this.endDrag();
      return;
    }
    const ray = session.screenRay(mx, my);
    if (this.handleDrag === HANDLE_VIEW) {
      // Where the ray meets the sphere round the key (the near side), else its closest approach
      const radius = this.handleLength(this.dragOrigin) * 1.4;
      const m = V.sub(ray.origin, this.dragOrigin);
      const b = V.dot(m, ray.direction), c = V.lengthSquared(m) - radius * radius;
      const discriminant = b * b - c;
      const root = discriminant >= 0 ? Math.sqrt(discriminant) : 0;
      let t = discriminant >= 0 ? -b - root : -b;
      if (t < 0) { t = discriminant >= 0 ? -b + root : Math.max(0, -b); } // the eye inside the sphere: the far side
      let towards = V.sub(V.add(ray.origin, V.scale(ray.direction, t)), this.dragOrigin);
      if (V.lengthSquared(towards) < 1e-8) { return; }
      towards = V.normalize(towards);
      let yaw = Math.atan2(towards.y, towards.x);
      let pitch = clamp(Math.asin(clamp(towards.z, -1, 1)), -1.5, 1.5);
      if (!free) {
        yaw = Math.round(yaw / PATH_VIEW_SNAP) * PATH_VIEW_SNAP;
        pitch = clamp(Math.round(pitch / PATH_VIEW_SNAP) * PATH_VIEW_SNAP, -1.5, 1.5);
      }
      if (Math.abs(yaw - key.yaw) < 1e-5 && Math.abs(pitch - key.pitch) < 1e-5) { return; }
      store.setKeyView(path, key, key.local, yaw, pitch, false);
      return;
    }

    const parameter = closestOnAxis(this.dragOrigin, this.dragAxis, ray.origin, ray.direction);
    if (parameter === null) { return; }
    let delta = parameter - this.dragStartParameter;
    if (!free) { delta = Math.round(delta / PATH_SNAP) * PATH_SNAP; }
    if (Math.abs(delta - this.dragApplied) < 1e-5) { return; }
    this.dragApplied = delta;
    const moved = V.add(this.dragOrigin, V.scale(this.dragAxis, delta));
    if (this.subjectTarget) { store.setKeyTarget(path, key, moved, false); }
    else { store.setKeyView(path, key, moved, key.yaw, key.pitch, false); }
  }

  /** Ends a drag: the path is saved and its collision checked again. */
  private endDrag(): void {
    if (this.handleDrag < 0) { return; }
    const key = this.paths.key;
    const changed = !Number.isNaN(this.dragApplied) || (key !== null && (key.yaw !== this.dragStartYaw || key.pitch !== this.dragStartPitch));
    this.handleDrag = -1;
    if (changed) {
      this.paths.store.touch(this.paths.path);
      this.collisionDirty = true;
      this.session.sound.play(SoundId.UiClick);
    } else if (this.undo.length > 0) {
      this.undo.pop(); // nothing moved: no undo step
    }
  }

  // #endregion

  // #region Drawing (3D)

  /**
   * The path in the scene while the editor is on: the line (red through the model), direction ticks, keys and their
   * views, look-at targets, the handles and K's insert marker. Depth-tested, then a faint copy through walls.
   */
  draw(): void {
    const session = this.session, path = this.paths.path;
    if (!this.on || session.tour.active || !path) { return; }
    if (!this.overlay) {
      this.overlay = new Overlay3D();
      this.overlay.initialise();
    }
    this.updateCollision();
    const overlay = this.overlay, camera = session.camera;
    overlay.begin(camera);

    // The line and the direction ticks (about every 2 m)
    const lineColour = Rgba.hex(0x22d3ee, 0.95), blockedColour = Rgba.hex(0xef4444, 1);
    const tickEvery = Math.max(1, Math.round(2 / Math.max(this.sampleStep, 0.01)));
    for (let i = 0; i + 1 < this.samples.length; i++) {
      const a = this.samples[i], b = this.samples[i + 1];
      overlay.line(a, b, 3, this.blocked[i] ? blockedColour : lineColour);
      if (i % tickEvery !== Math.trunc(tickEvery / 2)) { continue; }
      let d = V.sub(b, a);
      if (V.lengthSquared(d) < 1e-8) { continue; }
      d = V.normalize(d);
      const side = V.normalize(V.cross(d, Math.abs(d.z) > 0.95 ? vec3(1, 0, 0) : vec3(0, 0, 1)));
      const tip = V.add(a, V.scale(d, 0.15));
      overlay.line(tip, V.add(V.sub(tip, V.scale(d, 0.22)), V.scale(side, 0.14)), 2, lineColour);
      overlay.line(tip, V.sub(V.sub(tip, V.scale(d, 0.22)), V.scale(side, 0.14)), 2, lineColour);
    }

    // Keys: a dot, the view as a short line; look-at targets
    const keyColour = Rgba.hex(0xfbbf24, 1), viewColour = Rgba.hex(0xfde68a, 0.85), targetColour = Rgba.hex(0xe879f9, 1), white = Rgba.hex(0xffffff, 1);
    path.keys.forEach((key, i) => {
      const selected = key === this.paths.key, hover = i === this.keyHover;
      if (!selected) { overlay.line(key.local, V.add(key.local, V.scale(viewDirection(key.yaw, key.pitch), 0.7)), 2, viewColour); }
      overlay.dot(key.local, selected ? 10 : hover ? 9 : 7, selected || hover ? white : keyColour);
      if (key.targetLocal && pathHeadingFor(path, key) === 'lookAt') {
        overlay.line(key.local, key.targetLocal, selected ? 2 : 1, Rgba.withAlpha(targetColour, selected ? 0.9 : 0.5));
        const targetOn = (selected && this.subjectTarget) || i === this.targetHover;
        overlay.dot(key.targetLocal, targetOn ? 9 : 6, targetOn ? white : targetColour);
      }
    });

    // K's insert marker
    if (this.insertShown) { overlay.dot(this.insertPoint, 6, Rgba.hex(0x4ade80, 1)); }

    // The handles on the selected key (or its target)
    const subject = this.subject();
    if (subject) {
      for (let h = 0; h <= HANDLE_VIEW; h++) {
        const handle = this.handlePosition(h);
        if (!handle) { continue; }
        const active = h === this.handleDrag || (h === this.handleHover && this.handleDrag < 0);
        const colour = active ? white : h === HANDLE_X ? UiTheme.AXIS_X : h === HANDLE_Y ? UiTheme.AXIS_Y : h === HANDLE_Z ? UiTheme.AXIS_Z : Rgba.hex(0xfde68a, 1);
        overlay.line(subject, handle.position, h === HANDLE_VIEW ? 3 : 2.5, colour);
        overlay.dot(handle.position, active ? 10 : 7, colour);
      }
    }

    overlay.draw(camera, true, 1, false);
    overlay.draw(camera, false, 0.3, false);
  }

  // #endregion

  // #region HUD

  /** The editor's HUD: key numbers, the dock, the scrubber, the snapped banner (the session adds the info column). */
  buildHud(f: FontAtlas, width: number, height: number): void {
    const session = this.session, ui = session.ui, path = this.paths.path;
    if (!path) { return; }

    // K-C: the path's fades while previewing (under the dock and the scrubber)
    if (this.previewPlaying && this.black > 0.002) { ui.rect(0, 0, width, height, Rgba.hex(0x000000, clamp(this.black, 0, 1))); }

    // Key numbers beside the markers
    path.keys.forEach((key, i) => {
      const screen = session.camera.worldToScreen(key.local);
      if (!screen) { return; }
      ui.text(f.bold, screen.x + this.s(9), screen.y - this.s(18), String(i + 1), key === this.paths.key ? UiTheme.TEXT : Rgba.hex(0xfbbf24, 0.95));
    });

    this.buildDock(f, session.input);
    if (!this.on) { return; } // the dock left the editor
    this.buildScrubber(f, session.input, width, height);
    this.buildSnapBanner(f, width, height);
  }

  /** The line above the scrubber: snapped into a key (and whether SET would change it), or picking a target. */
  private buildSnapBanner(f: FontAtlas, width: number, height: number): void {
    const session = this.session, ui = session.ui;
    let text: string | null = null;
    let colour = UiTheme.TEXT;
    const centre = this.barRect[2] > 0 ? this.barRect[0] + this.barRect[2] * 0.5 : width * 0.5;
    const top = (this.barRect[3] > 0 ? this.barRect[1] : height - this.s(80)) - this.s(40);
    if (this.pickTarget) {
      text = 'Click a surface for the key\'s look-at target (Esc cancels)';
      colour = Rgba.hex(0xe879f9);
    } else if (this.previewPlaying) {
      text = Hints.pathEditPreview.text;
    } else if (this.snapped && this.snapped === this.paths.key) {
      const moved = this.snapMoved;
      const line = moved
        ? `Moved from “${this.snapped.name}”: ${keyOf(InputAction.PathSetKey)} sets it here · ← / → leaves it as it was`
        : `At “${this.snapped.name}”: fly and look, then ${keyOf(InputAction.PathSetKey)} sets it`;
      const tw = UiBatch.measure(f.body, line) + this.s(28);
      const tx = Math.round(centre - tw * 0.5);
      ui.panel(tx, top, tw, this.s(30), UiTheme.PANEL_STRONG, moved ? UiTheme.ACCENT : UiTheme.PANEL_BORDER);
      ui.text(f.body, tx + this.s(14), top + this.s(7), line, moved ? UiTheme.ACCENT : UiTheme.TEXT);
      return;
    }
    if (text === null) { return; }
    const w = UiBatch.measure(f.body, text) + this.s(28);
    const x = Math.round(centre - w * 0.5);
    ui.panel(x, top, w, this.s(30), UiTheme.PANEL_STRONG, UiTheme.PANEL_BORDER);
    ui.text(f.body, x + this.s(14), top + this.s(7), text, colour);
  }

  /** The scrubber (bottom, left of the dock): the timeline with the keys as ticks and the playhead; drag to fly along. */
  private buildScrubber(f: FontAtlas, input: InputState, width: number, height: number): void {
    const session = this.session, ui = session.ui, w = session.menu.widgets, path = this.paths.path!;
    const right = this.dockRect[2] > 0 ? this.dockRect[0] - this.s(16) : width - this.s(16);
    let left = this.s(UiTheme.COLUMN_MARGIN) + this.s(UiTheme.INFO_WIDTH) + this.s(16);
    if (right - left < this.s(320)) { left = this.s(16); }
    const bw = right - left, h = this.s(58);
    const x = left, y = height - this.s(16) - h;
    this.barRect = [x, y, bw, h];
    ui.panel(x, y, bw, h, UiTheme.PANEL_STRONG, UiTheme.PANEL_BORDER);

    const timeline = this.timeline;
    const playW = this.s(70);
    if (w.smallButton(f, x + this.s(10), y + this.s(14), playW, this.s(30), this.previewPlaying ? 'PAUSE' : 'PLAY')) { this.togglePreview(); }
    const tx = x + this.s(10) + playW + this.s(16), tw = bw - playW - this.s(10) - this.s(16) - this.s(110);
    const trackY = y + this.s(34);
    if (!timeline || timeline.duration <= 0) {
      ui.text(f.small, tx, y + this.s(20), 'Add two keys or more to see the timeline', UiTheme.TEXT_FAINT);
      this.scrubDrag = false;
      return;
    }

    // The track, the keys' ticks and numbers, the playhead
    const duration = timeline.duration;
    ui.rect(tx, trackY - this.s(2), tw, this.s(4), Rgba.hex(0xffffff, 0.15));
    const fraction = clamp(this.scrubTime / duration, 0, 1);
    ui.rect(tx, trackY - this.s(2), tw * fraction, this.s(4), UiTheme.BOOKMARK);
    for (let i = 0; i < timeline.count; i++) {
      const kx = tx + tw * clamp(timeline.startOf(i) / duration, 0, 1);
      const selected = i < path.keys.length && path.keys[i] === this.paths.key;
      ui.rect(kx - this.s(1), trackY - this.s(8), this.s(2), this.s(16), selected ? UiTheme.TEXT : Rgba.hex(0xfbbf24, 0.8));
      ui.textCentred(f.small, kx, y + this.s(6), String(i + 1), selected ? UiTheme.TEXT : UiTheme.TEXT_MUTED);
    }
    // K-C: the sun along the path (dark: night; orange: dawn and dusk; pale: high sun), dots at keys with their own sun
    if (this.sunStripOn) {
      const stripY = trackY + this.s(12), cell = tw / PATH_SUN_CELLS;
      for (let c = 0; c < PATH_SUN_CELLS; c++) { ui.rect(tx + c * cell, stripY, cell + 0.5, this.s(4), this.sunStrip[c]); }
      for (let i = 0; i < timeline.count && i < path.keys.length; i++) {
        if (!path.keys[i].sun) { continue; }
        ui.circle(tx + tw * clamp(timeline.startOf(i) / duration, 0, 1), stripY + this.s(2), this.s(3.5), Rgba.hex(0xfbbf24), 10);
      }
    }
    ui.circle(tx + tw * fraction, trackY, this.s(7), this.scrubDrag ? Rgba.hex(0xffffff) : UiTheme.ACCENT, 16);

    // Drag along the track: the camera follows
    const overTrack = w.hover(tx - this.s(8), trackY - this.s(14), tw + this.s(16), this.s(28));
    if (overTrack && input.leftPressed) {
      input.consumeClicks();
      this.scrubDrag = true;
      this.previewPlaying = false;
    }
    if (this.scrubDrag) {
      if (!input.leftDown) { this.scrubDrag = false; }
      else { this.placeCamera(clamp((input.mouseX - tx) / tw, 0, 1) * duration); }
    }
    ui.textRight(f.mono, x + bw - this.s(12), y + this.s(20), `${clock(this.scrubTime)} / ${clock(duration)}`, UiTheme.TEXT_SOFT);
  }

  /** A compact labelled stepper (as MEDIA → PATHS): label, −, the value, + and (resettable) ×. */
  private stepper(f: FontAtlas, x: number, y: number, label: string, value: number, step: number, min: number, max: number, decimals: number,
    unit: string, own: boolean, resettable = false): { value: number; reset: boolean } {
    const ui = this.session.ui, w = this.session.menu.widgets;
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

  /** The dock: the path (switch, summary, collision), the selected key's settings, MEDIA and DONE. */
  private buildDock(f: FontAtlas, input: InputState): void {
    const session = this.session, ui = session.ui, shell = session.shell, w = session.menu.widgets, store = this.paths.store;
    const path = this.paths.path!;
    this.paths.refreshStats();
    const d = shell.beginDock('PATH EDITOR', UiTheme.BOOKMARK_LABEL, Rgba.withAlpha(UiTheme.BOOKMARK, 0.6), this.s(UiTheme.DOCK_WIDTH_WIDE), this.dockScroll,
      this.notice !== null);
    this.dockRect = [d.x, d.y, d.w, d.h];
    if (input.rightPressed && inside(this.dockRect, input.mouseX, input.mouseY)) { input.consumeClicks(); }
    const x = d.ix, width = d.iw;
    let cy = shell.beginDockBody(d, this.dockScroll, input);
    const gap = this.s(6);
    let changed = false;
    const key = this.paths.key;
    const index = key ? path.keys.indexOf(key) : -1;

    // The path: switch, name, summary, collision
    let previousPath = false, nextPath = false;
    if (store.paths.length > 1) {
      previousPath = w.smallButton(f, x, cy, this.s(28), this.s(28), '‹');
      nextPath = w.smallButton(f, x + width - this.s(28), cy, this.s(28), this.s(28), '›');
      ui.textWrapped(f.bold, x + this.s(36), cy + this.s(5), width - this.s(72), path.name, UiTheme.TEXT, 1);
    } else {
      ui.textWrapped(f.bold, x, cy + this.s(5), width, path.name, UiTheme.TEXT, 1);
    }
    cy += this.s(34);
    ui.textWrapped(f.small, x, cy, width, this.paths.statsLabel(path), UiTheme.TEXT_MUTED, 1);
    cy += this.s(20);
    if (this.timeline) {
      if (this.blockedSegments > 0) {
        ui.text(f.small, x, cy, `${this.blockedSegments}${this.blockedSegments === 1 ? ' segment passes' : ' segments pass'} through the model (red)`, Rgba.hex(0xf87171));
      } else {
        ui.text(f.small, x, cy, 'Clear of the model', UiTheme.TEXT_FAINT);
      }
      cy += this.s(20);
    }
    ui.rect(x, cy + this.s(4), width, Math.max(1, ui.scale), UiTheme.DIVIDER);
    cy += this.s(14);

    // Key buttons: previous / SET / next, add / delete
    const third = (width - gap * 2) / 3, half = (width - gap) * 0.5;
    const previous = w.smallButton(f, x, cy, third, this.s(30), '‹ KEY');
    const set = w.smallButton(f, x + third + gap, cy, third, this.s(30), Hints.pathSetButton.text);
    const next = w.smallButton(f, x + (third + gap) * 2, cy, third, this.s(30), 'KEY ›');
    cy += this.s(36);
    const add = w.smallButton(f, x, cy, half, this.s(30), Hints.pathAddButton.text);
    const del = w.smallButton(f, x + half + gap, cy, half, this.s(30), Hints.pathDeleteButton.text, true);
    cy += this.s(42);

    let pickTarget = false, clearTarget = false, resetSpeed = false, resetSmooth = false;
    let sunNow = false, sunEarlier = false, sunLater = false, sunClear = false, photo = false; // K-C
    if (!key) {
      cy += ui.textWrapped(f.small, x, cy, width, path.keys.length === 0
        ? `No keys yet: fly to where the path starts and press ${keyOf(InputAction.PathAddKey)}.`
        : `Click a key in the scene, or ${keyOf(InputAction.PathPreviousKey)} / ${keyOf(InputAction.PathNextKey)} to snap into one.`, UiTheme.TEXT_MUTED, 3) + this.s(8);
    } else {
      ui.text(f.small, x, cy, `KEY ${index + 1} OF ${path.keys.length}${this.subjectTarget ? ' · ITS TARGET' : ''}`, UiTheme.TEXT_MUTED, this.s(1.4));
      cy += this.s(18);
      ui.textWrapped(f.bold, x, cy, width, key.name, UiTheme.TEXT, 1);
      cy += this.s(28);

      const hold = this.stepper(f, x, cy, 'Hold', key.holdSeconds, 0.5, 0, CAMERA_KEY_MAX_HOLD, 1, ' s', key.holdSeconds > 0).value;
      if (hold !== key.holdSeconds) { this.pushUndo(path); key.holdSeconds = hold; changed = true; }
      cy += this.s(36);
      const speed = this.stepper(f, x, cy, 'Speed', pathSpeedFor(path, key), 0.25, CameraPathLimits.MIN_SPEED, CameraPathLimits.MAX_SPEED, 2, ' m/s', key.speed !== null, true);
      resetSpeed = speed.reset;
      if (!resetSpeed && speed.value !== pathSpeedFor(path, key)) { this.pushUndo(path); key.speed = speed.value; changed = true; }
      cy += this.s(36);
      const smooth = this.stepper(f, x, cy, 'Smoothness', pathSmoothnessFor(path, key) * 100, 10, 0, 100, 0, ' %', key.smoothness !== null, true);
      resetSmooth = smooth.reset;
      if (!resetSmooth && Math.abs(smooth.value / 100 - pathSmoothnessFor(path, key)) > 1e-4) { this.pushUndo(path); key.smoothness = smooth.value / 100; changed = true; }
      cy += this.s(38);

      ui.text(f.body, x, cy + this.s(7), 'Ease', UiTheme.TEXT_SOFT);
      const easeIndex = key.ease === null ? 0 : key.ease ? 1 : 2;
      const ease = w.segmented(f, x + this.s(92), cy, width - this.s(92), KEY_EASE_OPTIONS, easeIndex);
      if (ease !== easeIndex) { this.pushUndo(path); key.ease = ease === 1 ? true : ease === 2 ? false : null; changed = true; }
      cy += this.s(38);

      // K-C: the key's sun (the scrubber's strip shows it along the path)
      ui.text(f.body, x, cy + this.s(2), 'Sun', UiTheme.TEXT_SOFT);
      if (key.sun) {
        const s = key.sun;
        ui.text(f.bold, x + this.s(92), cy + this.s(1), `${s.day}/${s.month}  ${String(Math.trunc(s.minutes / 60)).padStart(2, '0')}:${String(s.minutes % 60).padStart(2, '0')}`, Rgba.hex(0x67e8f9));
      } else {
        ui.textWrapped(f.small, x + this.s(92), cy + this.s(3), width - this.s(92), 'Between its neighbours\'', UiTheme.TEXT_FAINT, 1);
      }
      cy += this.s(24);
      const stepW = this.s(58), clearW = this.s(28);
      const nowW = key.sun ? width - stepW * 2 - clearW - gap * 3 : width;
      sunNow = w.smallButton(f, x, cy, nowW, this.s(28), 'USE THE SUN NOW');
      if (key.sun) {
        sunEarlier = w.smallButton(f, x + nowW + gap, cy, stepW, this.s(28), '−30 MIN');
        sunLater = w.smallButton(f, x + nowW + gap + stepW + gap, cy, stepW, this.s(28), '+30 MIN');
        sunClear = w.smallButton(f, x + width - clearW, cy, clearW, this.s(28), '×');
      }
      cy += this.s(38);

      ui.text(f.body, x, cy, 'Heading', UiTheme.TEXT_SOFT);
      cy += this.s(22);
      const headingIndex = key.heading === 'follow' ? 1 : key.heading === 'key' ? 2 : key.heading === 'lookAt' ? 3 : 0;
      const pickedHeading = w.segmented(f, x, cy, width, KEY_HEADING_OPTIONS, headingIndex);
      if (pickedHeading !== headingIndex) {
        this.pushUndo(path);
        key.heading = pickedHeading === 1 ? 'follow' : pickedHeading === 2 ? 'key' : pickedHeading === 3 ? 'lookAt' : null;
        changed = true;
      }
      cy += this.s(38);
      const heading = pathHeadingFor(path, key);
      if (heading === 'lookAt') {
        const pickW = width - (keyHasTarget(key) ? this.s(34) : 0);
        pickTarget = w.smallButton(f, x, cy, pickW, this.s(28), this.pickTarget ? 'CLICK A SURFACE…' : keyHasTarget(key) ? 'PICK ANOTHER TARGET' : 'PICK THE TARGET');
        if (keyHasTarget(key)) { clearTarget = w.smallButton(f, x + width - this.s(28), cy, this.s(28), this.s(28), '×'); }
        cy += this.s(34);
      } else if (heading === 'key') {
        cy += ui.textWrapped(f.small, x, cy, width, 'Holds the key\'s own view: drag the yellow handle, or snap in, look and SET', UiTheme.TEXT_FAINT, 2) + this.s(6);
      }
      photo = w.smallButton(f, x, cy, width, this.s(30), 'PHOTO AT THIS KEY'); // K-C
      cy += this.s(38);
      cy += ui.textWrapped(f.small, x, cy, width, Hints.pathHandles.text, UiTheme.TEXT_FAINT, 3) + this.s(6);
      cy += ui.textWrapped(f.small, x, cy, width, 'Colour profile, swivel, cut and the path\'s own settings: MEDIA → PATHS', UiTheme.TEXT_FAINT, 2) + this.s(4);
    }
    shell.endDockBody(this.dockScroll, input, cy);
    const footer = shell.endDock(d, this.notice, null, 'MEDIA', 'DONE');

    // Act after drawing
    if (key) {
      if (resetSpeed) { this.pushUndo(path); key.speed = null; changed = true; }
      if (resetSmooth) { this.pushUndo(path); key.smoothness = null; changed = true; }
      const sun = session.sun;
      if (sunNow) {
        // K-C: the sun showing (on the path: the path's own, as previewed)
        this.pushUndo(path);
        key.sun = { ...sun.settings.time };
        if (sun.playing) { key.sun.minutes = clamp(Math.trunc(sun.playMinutes), 0, 1439); }
        changed = true;
        this.notice = sun.enabled ? null : 'Shadows are off now: the path turns them on from this key when it plays';
      } else if ((sunEarlier || sunLater) && key.sun) {
        this.pushUndo(path);
        key.sun.minutes = clamp(key.sun.minutes + (sunLater ? 30 : -30), 0, 1439);
        changed = true;
      } else if (sunClear) {
        this.pushUndo(path);
        key.sun = null;
        changed = true;
      }
    }
    if (changed) {
      store.touch(path);
      this.paths.refreshStats();
    }
    if (pickTarget) { this.pickTarget = !this.pickTarget; }
    else if (clearTarget && key) {
      this.pushUndo(path);
      store.setKeyTarget(path, key, null);
      this.subjectTarget = false;
    }
    if (photo && key) { session.keyPhotos.openAtKey(path, key, true); } // K-C (leaves the editor until photo mode closes)
    else if (previous) { this.snapToKey(-1); }
    else if (next) { this.snapToKey(+1); }
    else if (set) { this.setSelectedKey(); }
    else if (add) { this.addKeyHere(); }
    else if (del) { this.deleteSelectedKey(); }
    else if (previousPath || nextPath) {
      const at = store.paths.indexOf(path), count = store.paths.length;
      this.endState(); // K-C
      this.paths.path = store.paths[((at + (nextPath ? 1 : -1)) % count + count) % count];
      this.paths.key = null;
      this.snapped = null;
      this.subjectTarget = false;
      this.scrubTime = 0;
      this.previewPlaying = false;
      this.notice = null;
    }

    if (footer === DOCK_BACK) {
      // MEDIA → PATHS over the editor (CLOSE there comes back here)
      this.previewPlaying = false;
      session.media.open(MediaTab.Paths);
    } else if (footer === DOCK_CLOSE) {
      this.exit();
    }
  }

  // #endregion
}

/** The key index a key inserted into a segment takes (the segment after the last key: the end). */
const insertIndex = (path: CameraPath, segment: number) => (segment < 0 ? path.keys.length : Math.min(segment + 1, path.keys.length));

/** K-C: a sun height (degrees) as a strip colour: night, dusk orange, low warm sun, high pale sun. */
function sunStripColour(altitude: number): number {
  // Stops: −8° night, 0° orange, 12° warm yellow, 45° pale
  const night = [0.16, 0.20, 0.33], dusk = [0.98, 0.45, 0.09], low = [0.99, 0.83, 0.30], high = [1, 0.97, 0.84];
  const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
  const c = altitude <= -8 ? night : altitude <= 0 ? lerp(night, dusk, (altitude + 8) / 8) : altitude <= 12 ? lerp(dusk, low, altitude / 12)
    : lerp(low, high, clamp((altitude - 12) / 33, 0, 1));
  return Rgba.fromFloat(c[0], c[1], c[2], 0.9);
}
