import type { CommentRecord } from '../../core/format/DocumentModels';
import { Vec3 as V, vec3 } from '../../core/math/Vector';
import type { Overlay3D } from '../../engine/render/Overlay3D';
import { Rgba } from '../../engine/ui/Rgba';
import type { UiBatch } from '../../engine/ui/UiBatch';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { type InputState, Vk } from '../../platform/input';
import { type AimInfo, Gun } from './Gun';
import { GunIcons } from './GunIcons';

/** Place, read, edit and remove comment pins (port of CommentGun.cs). */
export class CommentGun extends Gun {
  private static readonly HOVER_PIXELS = 34;
  private static readonly MAX_HOVER_DISTANCE = 60;

  private hoveredRecord: CommentRecord | null = null;
  private clearConfirmUntil = 0;
  private clock = 0;

  get name(): string { return 'COMMENT'; }
  get hintPrimary(): string { return 'Place + type comment'; }
  get hintSecondary(): string { return 'Remove marker'; }
  get colour(): number { return UiTheme.COMMENT; }
  get panelHeight(): number { return 96; }

  drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void { GunIcons.comment(ui, cx, cy, size, colour); }

  get hovered(): CommentRecord | null { return this.hoveredRecord; }

  override tick(dt: number): void {
    this.clock += dt;
    this.hoveredRecord = this.findHovered();
  }

  override onPrimary(aim: AimInfo): void {
    const hit = aim.hit;
    if (!hit) {
      this.session.sound.play(SoundId.Error);
      return;
    }
    const element = this.session.scene.elements[hit.element];
    // Linked elements' ids belong to another model: the comment records no element there
    this.session.beginCommentEdit(V.add(hit.point, V.scale(hit.normal, 0.06)), element.link > 0 ? -1 : element.elementId, this.session.levelNameAt(hit.point.z));
    this.session.sound.play(SoundId.UiClick);
  }

  override onKeys(input: InputState): void {
    if (!input.isPressed(Vk.key('E')) || !this.hoveredRecord) { return; }
    this.session.editComment(this.hoveredRecord);
    this.session.sound.play(SoundId.UiClick);
  }

  override onSecondary(): void {
    if (!this.hoveredRecord) { return; }
    this.session.comments.remove(this.hoveredRecord);
    this.hoveredRecord = null;
    this.session.sound.play(SoundId.Remove);
  }

  clearMarkers(): void {
    const comments = this.session.comments.comments;
    if (comments.length === 0) { return; }

    if (this.clock < this.clearConfirmUntil) {
      const count = comments.length;
      this.session.comments.clear();
      this.session.toast(`Deleted ${count} comment${count === 1 ? '' : 's'}`);
      this.session.sound.play(SoundId.Remove);
      this.clearConfirmUntil = 0;
    } else {
      this.clearConfirmUntil = this.clock + 2.5;
      this.session.toast(`Press X again to delete all ${comments.length} comments`);
    }
  }

  private findHovered(): CommentRecord | null {
    const camera = this.session.camera;
    const cx = camera.viewportWidth * 0.5, cy = camera.viewportHeight * 0.5;
    const limit = this.s(CommentGun.HOVER_PIXELS);
    let best: CommentRecord | null = null;
    let bestDistance = Number.MAX_VALUE;

    for (const record of this.session.comments.comments) {
      if (V.distance(camera.position, record.local) > CommentGun.MAX_HOVER_DISTANCE) { continue; }
      const screen = camera.worldToScreen(record.local);
      if (!screen) { continue; }
      const pixels = Math.hypot(screen.x - cx, screen.y - cy);
      if (pixels < limit && pixels < bestDistance) {
        best = record;
        bestDistance = pixels;
      }
    }

    // Occlusion check for the winner only
    if (best) {
      const toMarker = V.sub(best.local, camera.position);
      const distance = V.length(toMarker);
      if (distance > 1e-3 && this.session.pick(camera.position, V.scale(toMarker, 1 / distance), distance - 0.12)) { best = null; }
    }
    return best;
  }

  override drawWorld(overlay: Overlay3D): void {
    for (const record of this.session.comments.comments) {
      const hovered = record === this.hoveredRecord;
      const colour = hovered ? UiTheme.COMMENT_LABEL : UiTheme.COMMENT;
      overlay.line(record.local, V.sub(record.local, vec3(0, 0, 0.3)), 2.5, Rgba.withAlpha(colour, 0.9));
      overlay.dot(record.local, hovered ? 11 : 9, UiTheme.TEXT);
      overlay.dot(record.local, hovered ? 9 : 7, colour);
    }
    if (this.session.isEditingComment) {
      overlay.dot(this.session.editPoint, 11, UiTheme.TEXT);
      overlay.dot(this.session.editPoint, 9, UiTheme.COMMENT);
    }
  }

  override drawLabels(ui: UiBatch): void {
    const record = this.hoveredRecord;
    if (!record || this.session.isEditingComment) { return; }
    const screen = this.session.camera.worldToScreen(record.local);
    if (!screen) { return; }

    const f = ui.atlas;
    const width = this.s(250);
    const textHeight = ui.textWrapped(f.body, 0, 0, width - this.s(24), record.text, 0, 8, false);
    const height = this.s(32) + textHeight;
    const x = Math.min(screen.x + this.s(20), this.session.screenWidth - width - this.s(10));
    const y = Math.max(this.s(10), screen.y - this.s(36));

    ui.panel(x, y, width, height, UiTheme.PANEL_STRONG, UiTheme.COMMENT);
    ui.text(f.small, x + this.s(12), y + this.s(9), record.header, UiTheme.COMMENT_LABEL, this.s(0.8));
    ui.textWrapped(f.body, x + this.s(12), y + this.s(27), width - this.s(24), record.text, UiTheme.TEXT, 8);
  }

  drawPanel(ui: UiBatch, x: number, y: number, width: number): void {
    const f = ui.atlas;
    ui.text(f.small, x, y, 'COMMENTS', UiTheme.COMMENT_LABEL, this.s(1.1));
    y += this.s(20);

    const level = this.session.currentLevelName;
    const all = this.session.comments.comments;
    const onLevel = all.filter(r => r.level === level).length;
    ui.text(f.body, x, y, `${onLevel} on this level · ${all.length} total`, UiTheme.TEXT);
    y += this.s(22);
    ui.textWrapped(f.body, x, y, width, 'Hover a marker to read it, E to edit. Kept with this file (Ctrl+S saves once saving is available).', UiTheme.TEXT_MUTED, 2);
  }
}
