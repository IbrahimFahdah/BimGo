import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import { CharacterController } from '../../engine/physics/CharacterController';
import type { Overlay3D } from '../../engine/render/Overlay3D';
import { Rgba } from '../../engine/ui/Rgba';
import type { UiBatch } from '../../engine/ui/UiBatch';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { type AimInfo, Gun } from './Gun';
import { GunIcons } from './GunIcons';

/** Aim-and-blink travel with a landing check and a back stack (port of TeleportGun.cs). */
export class TeleportGun extends Gun {
  private static readonly MAX_RANGE = 80;
  private static readonly DROP_DISTANCE = 4;
  private static readonly HISTORY = 12;

  private hasTarget = false;
  private valid = false;
  private feet: Vec3 = vec3();
  private reason: string | null = null;
  private distance = 0;
  private clock = 0;
  private readonly history: Vec3[] = [];

  get name(): string { return 'TELEPORT'; }
  get hintPrimary(): string { return 'Blink to marker'; }
  get hintSecondary(): string { return this.history.length > 0 ? 'Back' : 'Back (none)'; }
  get colour(): number { return UiTheme.TELEPORT; }
  get panelHeight(): number { return 80; }

  drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void { GunIcons.teleport(ui, cx, cy, size, colour); }

  override tick(dt: number): void { this.clock += dt; }
  override onDeselect(): void { this.hasTarget = false; }
  clearMarkers(): void { this.history.length = 0; }

  // #region Targeting

  override update(_dt: number, aim: AimInfo): void {
    this.hasTarget = false;
    this.valid = false;
    this.reason = null;

    const hit = aim.hit;
    if (!hit || hit.distance > TeleportGun.MAX_RANGE) {
      this.reason = hit ? 'Too far (80 m max)' : 'Aim at a surface';
      return;
    }

    this.hasTarget = true;
    this.distance = hit.distance;
    const flying = this.session.player.flying;
    let feet: Vec3;

    if (hit.normal.z > 0.7) {
      // A floor: stand on it
      feet = vec3(hit.point.x, hit.point.y, hit.point.z + 0.02);
    } else if (hit.normal.z < -0.7) {
      // A ceiling: only while flying (hang just below it)
      if (!flying) {
        this.feet = hit.point;
        this.reason = "Can't stand on a ceiling";
        return;
      }
      feet = vec3(hit.point.x, hit.point.y, hit.point.z - CharacterController.STAND_HEIGHT - 0.05);
    } else {
      // A wall: step back from it, then find the floor below (flying: stay at aim height)
      let flat = vec3(hit.normal.x, hit.normal.y, 0);
      flat = V.lengthSquared(flat) > 1e-6 ? V.normalize(flat) : V.scale(aim.direction, -1);
      const backed = V.add(hit.point, V.scale(flat, CharacterController.RADIUS + 0.08));

      if (flying) {
        feet = vec3(backed.x, backed.y, backed.z - CharacterController.STAND_EYE);
      } else {
        const floor = this.session.pick(vec3(backed.x, backed.y, backed.z + 0.3), vec3(0, 0, -1), TeleportGun.DROP_DISTANCE);
        if (floor && floor.normal.z > 0.7) {
          feet = vec3(floor.point.x, floor.point.y, floor.point.z + 0.02);
        } else {
          this.feet = backed;
          this.reason = 'No floor below that point';
          return;
        }
      }
    }

    // Room for the capsule? Try a few small lifts (thresholds, rugs) before giving up.
    for (let lift = 0; lift < 4; lift++) {
      const candidate = vec3(feet.x, feet.y, feet.z + lift * 0.06);
      if (!this.session.player.controller.overlaps(vec3(candidate.x, candidate.y, candidate.z + 0.01), CharacterController.STAND_HEIGHT)) {
        this.feet = candidate;
        this.valid = true;
        return;
      }
    }

    this.feet = feet;
    this.reason = 'Not enough room to stand there';
  }

  // #endregion

  // #region Actions

  override onPrimary(): void {
    if (!this.valid) {
      this.session.sound.play(SoundId.Error);
      if (this.reason) { this.session.toast(this.reason); }
      return;
    }
    if (this.history.length === TeleportGun.HISTORY) { this.history.shift(); }
    this.history.push(V.copy(this.session.player.feet));
    this.session.player.teleportTo(this.feet);
    this.session.sound.play(SoundId.Blink);
    this.session.flash(UiTheme.TELEPORT, 0.12);
  }

  override onSecondary(): void {
    const back = this.history.pop();
    if (!back) {
      this.session.sound.play(SoundId.Error);
      return;
    }
    this.session.player.teleportTo(back);
    this.session.sound.play(SoundId.Blink);
    this.session.flash(UiTheme.TELEPORT, 0.08);
  }

  // #endregion

  // #region Drawing

  override drawWorld(overlay: Overlay3D, selected: boolean): void {
    if (!selected || !this.hasTarget) { return; }

    const colour = this.valid ? UiTheme.TELEPORT : UiTheme.TELEPORT_BLOCKED;
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 6);
    const ground = vec3(this.feet.x, this.feet.y, this.feet.z + 0.015);
    const X = vec3(1, 0, 0), Y = vec3(0, 1, 0);

    // Landing marker: disc, ring and a faint standing-height column
    overlay.disc(ground, X, Y, 0.38, 0.38, Rgba.withAlpha(colour, 0.22));
    overlay.ring(ground, X, Y, 0.42 + 0.04 * pulse, 0.42 + 0.04 * pulse, 0.035, colour);
    if (this.valid) {
      const top = vec3(this.feet.x, this.feet.y, this.feet.z + CharacterController.STAND_HEIGHT);
      overlay.line(ground, top, 1.5, Rgba.withAlpha(colour, 0.45));
      overlay.ring(top, X, Y, 0.18, 0.18, 0.02, Rgba.withAlpha(colour, 0.5));
    } else {
      overlay.line(V.add(ground, vec3(-0.3, -0.3, 0)), V.add(ground, vec3(0.3, 0.3, 0)), 3, colour);
      overlay.line(V.add(ground, vec3(-0.3, 0.3, 0)), V.add(ground, vec3(0.3, -0.3, 0)), 3, colour);
    }

    // Arc from just below the eye to the marker
    const camera = this.session.camera;
    const start = V.add(V.add(camera.position, V.scale(camera.right, 0.18)), vec3(0, 0, -0.25));
    const end = ground;
    const lift = Math.min(2.5, 0.15 * V.distance(start, end) + 0.3);
    const control = V.add(V.scale(V.add(start, end), 0.5), vec3(0, 0, lift));
    let previous = start;
    const segments = 20;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const next = V.add(V.add(V.scale(start, (1 - t) * (1 - t)), V.scale(control, 2 * (1 - t) * t)), V.scale(end, t * t));
      const dash = (Math.trunc(t * segments - this.clock * 8) & 1) === 0;
      overlay.line(previous, next, 2.5, Rgba.withAlpha(colour, dash ? 0.9 : 0.45));
      previous = next;
    }
  }

  drawPanel(ui: UiBatch, x: number, y: number): void {
    const f = ui.atlas;
    ui.text(f.small, x, y, 'TELEPORT', UiTheme.TELEPORT_LABEL, this.s(1.1));
    y += this.s(20);

    if (this.valid) {
      const text = this.session.text.clear().appendNumber(this.distance, 1).append(' m · ').append(this.session.levelNameAt(this.feet.z)).text;
      ui.text(f.bold, x, y, text, UiTheme.TEXT);
    } else {
      ui.text(f.body, x, y, this.reason ?? 'Aim at a floor or wall', UiTheme.DANGER);
    }
    y += this.s(24);
    ui.text(f.body, x, y, `Back steps: ${this.history.length} · X clears`, UiTheme.TEXT_MUTED);
  }

  // #endregion
}
