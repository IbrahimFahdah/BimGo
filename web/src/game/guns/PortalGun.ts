import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import { CharacterController } from '../../engine/physics/CharacterController';
import type { Overlay3D } from '../../engine/render/Overlay3D';
import { Rgba } from '../../engine/ui/Rgba';
import type { UiBatch } from '../../engine/ui/UiBatch';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import type { Player } from '../Player';
import { type AimInfo, Gun } from './Gun';
import { GunIcons } from './GunIcons';

interface Portal {
  active: boolean;
  centre: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
  radiusU: number;
  radiusV: number;
  age: number;
  level: string;
}

const isWall = (p: Portal) => Math.abs(p.normal.z) < 0.7;
const inactive = (): Portal => ({ active: false, centre: vec3(), normal: vec3(0, 0, 1), u: vec3(1, 0, 0), v: vec3(0, 1, 0), radiusU: 1, radiusV: 1, age: 0, level: '' });

const FILL = [Rgba.withAlpha(UiTheme.PORTAL_BLUE_DARK, 0.55), Rgba.withAlpha(UiTheme.PORTAL_RED_DARK, 0.55)];
const RING = [UiTheme.PORTAL_BLUE, UiTheme.PORTAL_RED];
const GLOW = [UiTheme.PORTAL_BLUE_LIGHT, UiTheme.PORTAL_RED_LIGHT];
const NAMES = ['Blue', 'Red'];

/** Two linked portals on walls, floors or ceilings; walk into one, come out of the other (port of PortalGun.cs). */
export class PortalGun extends Gun {
  private readonly portals: Portal[] = [inactive(), inactive()];
  private cooldown = 0;

  get name(): string { return 'PORTAL'; }
  get hintPrimary(): string { return 'Blue portal'; }
  get hintSecondary(): string { return 'Red portal'; }
  get colour(): number { return UiTheme.PORTAL_BLUE; }
  get panelHeight(): number { return 96; }

  drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void { GunIcons.portal(ui, cx, cy, size, colour); }

  isActive(index: number): boolean { return this.portals[index].active; }
  centreOf(index: number): Vec3 { return this.portals[index].centre; }
  static colourOf(index: number): number { return RING[index]; }

  override onPrimary(aim: AimInfo): void { this.place(0, aim); }
  override onSecondary(aim: AimInfo): void { this.place(1, aim); }

  clearMarkers(): void {
    this.portals[0].active = false;
    this.portals[1].active = false;
  }

  override tick(dt: number): void {
    for (const p of this.portals) { p.age += dt; }
  }

  private place(index: number, aim: AimInfo): void {
    const hit = aim.hit;
    if (!hit) {
      this.session.sound.play(SoundId.Error);
      return;
    }

    const normal = hit.normal;
    const centre = V.copy(hit.point);
    let u: Vec3, v: Vec3, ru: number, rv: number;

    if (Math.abs(normal.z) < 0.7) {
      // Wall: upright ellipse standing on the floor below if there is one nearby
      u = V.normalize(V.cross(vec3(0, 0, 1), normal));
      v = V.cross(normal, u);
      ru = 0.55;
      rv = 1.0;
      const probe = V.add(V.add(centre, V.scale(normal, 0.4)), vec3(0, 0, 0.2));
      const floor = this.session.pick(probe, vec3(0, 0, -1), 3);
      if (floor && floor.normal.z > 0.7) { centre.z = floor.point.z + rv + 0.05; }
    } else {
      // Floor / ceiling: round, aligned to the view
      const right = this.session.camera.right;
      u = V.normalize(V.sub(right, V.scale(normal, V.dot(right, normal))));
      v = V.cross(normal, u);
      ru = rv = 0.65;
    }

    this.portals[index] = {
      active: true,
      centre: V.add(centre, V.scale(normal, 0.015)),
      normal, u, v, radiusU: ru, radiusV: rv, age: 0,
      level: this.session.levelNameAt(centre.z)
    };
    this.session.sound.play(index === 0 ? SoundId.PortalBlue : SoundId.PortalRed);
    this.session.flash(RING[index], 0.12);
  }

  /** Called every physics tick: carries the player through when they step into an active portal. */
  checkTeleport(player: Player, dt: number): void {
    this.cooldown -= dt;
    if (this.cooldown > 0 || !this.portals[0].active || !this.portals[1].active) { return; }

    const controller = player.controller;
    const height = controller.height;
    const feet = controller.feet;

    for (let i = 0; i < 2; i++) {
      const from = this.portals[i], to = this.portals[1 - i];

      // Test point: capsule centre for walls, feet for floors, head for ceilings
      const probe = isWall(from) ? vec3(feet.x, feet.y, feet.z + height * 0.5)
        : from.normal.z > 0 ? V.copy(feet) : vec3(feet.x, feet.y, feet.z + height);

      const relative = V.sub(probe, from.centre);
      const distance = V.dot(relative, from.normal);
      if (distance > CharacterController.RADIUS + 0.15 || distance < -0.4) { continue; }

      const lateral = V.sub(relative, V.scale(from.normal, distance));
      const a = V.dot(lateral, from.u) / from.radiusU;
      const b = V.dot(lateral, from.v) / from.radiusV;
      if (a * a + b * b > 1) { continue; }

      this.travel(player, from, to, height, 1 - i);
      this.cooldown = 0.6;
      return;
    }
  }

  private travel(player: Player, from: Portal, to: Portal, height: number, toIndex: number): void {
    let feet: Vec3;
    if (isWall(to)) {
      const exit = V.add(to.centre, V.scale(to.normal, CharacterController.RADIUS + 0.2));
      feet = vec3(exit.x, exit.y, to.centre.z - to.radiusV + 0.05);
    } else if (to.normal.z > 0) {
      feet = vec3(to.centre.x, to.centre.y, to.centre.z + 0.05);
    } else {
      feet = vec3(to.centre.x, to.centre.y, to.centre.z - height - 0.1);
    }

    const velocity = V.copy(player.controller.velocity);
    let yawChange = 0;
    if (isWall(from) && isWall(to)) {
      // Entering against -from.normal, leaving along +to.normal
      yawChange = Math.atan2(to.normal.y, to.normal.x) - Math.atan2(-from.normal.y, -from.normal.x);
    }

    player.teleportTo(feet, player.yaw + yawChange);
    player.controller.velocity = velocity;
    if (isWall(to)) {
      player.rotateVelocity(yawChange, 1.5, V.normalize(vec3(to.normal.x, to.normal.y, 0)));
    } else if (to.normal.z > 0) {
      player.controller.velocity = vec3(0, 0, 2.5);
    }

    this.session.sound.play(SoundId.Teleport);
    this.session.flash(RING[toIndex], 0.35);
  }

  override drawWorld(overlay: Overlay3D): void {
    this.portals.forEach((p, i) => {
      if (!p.active) { return; }
      const pulse = 0.5 + 0.5 * Math.sin(p.age * 3.2);
      overlay.disc(p.centre, p.u, p.v, p.radiusU, p.radiusV, FILL[i], 40);
      overlay.ring(p.centre, p.u, p.v, p.radiusU, p.radiusV, 0.06, RING[i], 48);
      overlay.ring(p.centre, p.u, p.v, p.radiusU + 0.08, p.radiusV + 0.08, 0.05, Rgba.withAlpha(GLOW[i], 0.2 + 0.2 * pulse), 48);

      // Placement burst
      if (p.age < 0.6) {
        const t = p.age / 0.6, grow = 0.1 + 0.5 * t;
        overlay.ring(p.centre, p.u, p.v, p.radiusU + grow, p.radiusV + grow, 0.04, Rgba.withAlpha(GLOW[i], 0.8 * (1 - t)), 48);
      }
    });
  }

  drawPanel(ui: UiBatch, x: number, y: number, width: number): void {
    const f = ui.atlas;
    ui.text(f.small, x, y, 'PORTALS', UiTheme.PORTAL_LABEL, this.s(1.1));
    y += this.s(20);

    this.portals.forEach((p, i) => {
      ui.circle(x + this.s(6), y + this.s(9), this.s(6), RING[i]);
      const where = p.active ? `${p.level}${isWall(p) ? ' wall' : p.normal.z > 0 ? ' floor' : ' ceiling'}` : 'not placed';
      ui.text(f.body, x + this.s(20), y, `${NAMES[i]} · ${where}`, UiTheme.TEXT);
      y += this.s(20);
    });

    const linked = this.portals[0].active && this.portals[1].active;
    ui.textWrapped(f.body, x, y + this.s(2), width,
      linked ? 'Connected. Walk into one to come out of the other. X clears both.' : 'Place both portals to connect them.', UiTheme.TEXT_MUTED, 2);
  }
}
