import type { CameraKey, CameraPath } from '../core/format/CameraPathModels';
import { clamp, Vec3 as V, vec3 } from '../core/math/Vector';
import { InputAction } from '../core/scene/InputCatalog';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { safeFileName } from '../platform/files';
import { keyOf } from '../platform/Hotkeys';
import type { InputState } from '../platform/input';
import type { GameSession } from './GameSession';

/** Frames a batch waits at a key before its shot (the sun's shadows and visibility changes settle). */
const KEY_PHOTO_SETTLE_FRAMES = 3;

/** A batch waits for earlier photos to finish saving while this many are being encoded. */
const KEY_PHOTO_MAX_SAVING = 2;

/** A running PHOTOS OF ALL KEYS. */
interface KeyPhotoBatch {
  path: CameraPath;
  /** The files' common start ("<model> <path> <time>"). */
  prefix: string;
  /** The key being shot (-1: not started). */
  index: number;
  /** Frames left before the shot. */
  settle: number;
  /** The shot was requested; taken at the next render. */
  shooting: boolean;
  taken: number;
  /** Every key shot: waiting for the saves. */
  done: boolean;
}

/**
 * Round K-C (port of GameSession.KeyPhotos.cs): camera path keys as photos.
 * - PHOTO AT THIS KEY (MEDIA → PATHS key editor, the 3D editor's dock): the camera goes to the key's view as the path
 *   plays it, the key's sun, colour profile, cut and hidden items show, and photo mode opens. Closing photo mode puts
 *   the walkthrough back (and, from the 3D editor, goes back into it).
 * - PHOTOS OF ALL KEYS (MEDIA → PATHS): plays the path through the tour player, stopping at each key for one shot with
 *   the PHOTO settings, saved as "<model> <path> <time> - 01 <key>" (the browser's downloads: one file per key).
 */
export class KeyPhotos {
  private batch: KeyPhotoBatch | null = null;
  // PHOTO AT THIS KEY: the walkthrough to put back when photo mode closes, and the 3D editor to go back to
  private restore = false;
  private editorPath: CameraPath | null = null;
  private editorKey: CameraKey | null = null;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  /** True while PHOTOS OF ALL KEYS runs. */
  get batchActive(): boolean { return this.batch !== null; }

  // #region PHOTO AT THIS KEY

  /** Opens photo mode at a key's view with its state showing; closing photo mode puts the walkthrough back. */
  openAtKey(path: CameraPath, key: CameraKey, returnToEditor: boolean): void {
    const session = this.session, tour = session.tour, player = session.player;
    if (tour.active) { return; }
    const index = path.keys.indexOf(key);
    if (index < 0) { return; }

    if (session.pathEditor.on) { session.pathEditor.exit(); }
    session.media.closePanel();
    if (session.paused) { session.setPaused(false); }
    this.endKeyPhoto();
    session.pathEditor.endState();

    // The key's view as the path plays it, and its state (sun between keyed suns, profile / cut / hidden carried on)
    const timeline = path.keys.length >= 2 ? session.paths.timeline(path) : null;
    let eye = key.local, yaw = key.yaw, pitch = key.pitch;
    if (timeline) {
      const pose = timeline.evaluate(timeline.startOf(index));
      eye = pose.eye;
      yaw = pose.yaw;
      pitch = pose.pitch;
    }
    const records = timeline ? session.paths.records(path, timeline)
      : [{ name: key.name, local: key.local, sun: key.sun, colourProfile: key.colourProfile, section: key.section, visibility: key.visibility, eyeHeight: null }];
    tour.stage(records);
    tour.applyStagedStop(index);

    if (!player.flying) { player.toggleFly(); }
    player.teleportTo(V.sub(eye, vec3(0, 0, player.controller.standEye)), yaw, pitch);
    this.restore = true;
    this.editorPath = returnToEditor ? path : null;
    this.editorKey = returnToEditor ? key : null;
    session.photo.show();
    session.toast(`Photo at “${key.name}” of ${path.name}: its sun, profile, cut and hidden items · ${keyOf(InputAction.PhotoMode)} / Esc puts the walkthrough back`, 4);
  }

  /**
   * Photo mode closed after PHOTO AT THIS KEY: the walkthrough as it was (position, eye, walking or flying, sun, profile,
   * cut, hidden items), then back into the 3D editor when it came from there.
   */
  endKeyPhoto(): void {
    if (!this.restore) { return; }
    const session = this.session;
    this.restore = false;
    session.tour.unstage(true);
    const editor = this.editorPath, key = this.editorKey;
    this.editorPath = null;
    this.editorKey = null;
    if (editor && session.paths.store.paths.includes(editor)) {
      session.pathEditor.enter(editor);
      if (key && editor.keys.includes(key)) { session.pathEditor.selectKey(key, false); }
    }
  }

  // #endregion

  // #region PHOTOS OF ALL KEYS

  /** PHOTOS OF ALL KEYS: plays the path through the tour player, one shot per key with the PHOTO settings. */
  start(path: CameraPath): void {
    const session = this.session;
    if (session.tour.active || session.video.active) { return; }
    if (path.keys.length === 0) {
      session.media.notice = 'The path has no keys yet: ADD KEY HERE adds this view';
      session.sound.play(SoundId.Error);
      return;
    }
    if (session.pathEditor.on) { session.pathEditor.exit(); }
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const model = safeFileName(session.documentName.replace(/\.bimgo$/i, ''));
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    if (!session.tour.startPath(path, true, true)) { return; } // one key works too (no segments)
    this.batch = { path, prefix: `${model} ${safeFileName(path.name)} ${stamp}`, index: -1, settle: 0, shooting: false, taken: 0, done: false };
    session.clearToast();
    console.info(`Key photos: ${path.name}, ${path.keys.length} key(s), ${session.photo.kind === 0 ? 'stills' : '360s'}.`);
  }

  /** Per frame while the batch runs (from the tour's update): Esc stops; else the next key, its settle frames, its shot. */
  update(input: InputState): void {
    const batch = this.batch!, session = this.session, photo = session.photo, tour = session.tour;
    if (input.pressed(InputAction.Back)) {
      this.finish(true);
      return;
    }
    if (photo.shotPending) { return; } // the shot renders this frame

    if (batch.shooting) {
      batch.shooting = false;
      batch.taken++;
      photo.named = null;
    }
    if (batch.done) {
      if (photo.saving === 0) { this.finish(false); }
      return;
    }
    if (batch.index >= 0 && batch.settle > 0) {
      if (--batch.settle === 0) {
        // The shot, named by its place and key
        const key = batch.path.keys[batch.index];
        photo.shootNamed(`${batch.prefix} - ${String(batch.index + 1).padStart(2, '0')} ${safeFileName(key.name)}`);
        batch.shooting = true;
      }
      return;
    }

    // On to the next key (waiting while earlier photos are still being saved)
    if (photo.saving >= KEY_PHOTO_MAX_SAVING) { return; }
    const next = batch.index + 1;
    if (!tour.timeline || next >= tour.timeline.count || next >= batch.path.keys.length) {
      batch.done = true;
      return;
    }
    batch.index = next;
    batch.settle = KEY_PHOTO_SETTLE_FRAMES;
    tour.jumpTo(next);
    session.updateRoom();
  }

  /** Ends the batch: the walkthrough comes back; a toast says how many photos were saved. */
  private finish(cancelled: boolean): void {
    const batch = this.batch, session = this.session;
    if (!batch) { return; }
    this.batch = null;
    session.photo.named = null;
    session.photo.cancelShot();
    session.tour.stop(!cancelled, true);
    session.toast(batch.taken === 0
      ? 'Key photos stopped: none taken'
      : cancelled
        ? `Key photos stopped: ${batch.taken} saved (your Downloads folder)`
        : `${batch.taken} key photo${batch.taken === 1 ? '' : 's'} saved (your Downloads folder: “${batch.prefix} - …”)`, 5);
    session.sound.play(cancelled ? SoundId.UiClick : SoundId.Commit);
    console.info(`Key photos ${cancelled ? 'stopped' : 'done'}: ${batch.taken} taken.`);
  }

  /** The batch's progress over the view (not in the photos). */
  buildOverlay(f: FontAtlas, width: number, height: number): void {
    const batch = this.batch!, ui = this.session.ui;
    const count = batch.path.keys.length;
    const shown = clamp(batch.index + 1, 0, count);
    const label = `PHOTOS OF ALL KEYS · ${shown} / ${count}${batch.done ? ' · SAVING…' : ''}`;
    const w = Math.min(this.s(560), width - this.s(40)), h = this.s(64);
    const x = Math.round((width - w) * 0.5), y = height - this.s(24) - h;
    ui.panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.ACCENT);
    ui.text(f.small, x + this.s(14), y + this.s(12), label, UiTheme.ACCENT, this.s(1.4));
    const name = batch.index >= 0 && batch.index < count ? batch.path.keys[batch.index].name : batch.path.name;
    ui.textWrapped(f.bold, x + this.s(14), y + this.s(32), w - this.s(150), name, UiTheme.TEXT, 1);
    ui.textRight(f.small, x + w - this.s(14), y + this.s(36), 'Esc stops', UiTheme.TEXT_MUTED);
    const fraction = count > 0 ? (shown - (batch.settle > 0 || batch.shooting ? 0.5 : 0)) / count : 1;
    ui.rect(x + this.s(14), y + h - this.s(8), (w - this.s(28)) * clamp(fraction, 0, 1), this.s(3), UiTheme.ACCENT);
  }

  // #endregion
}
