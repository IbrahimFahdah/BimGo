import { clamp, type Vec3, vec3 } from '../core/math/Vector';
import { CharacterController } from '../engine/physics/CharacterController';
import { type InputState, Vk } from '../platform/input';

/**
 * The walker / flyer: mouse look, keyboard movement on a fixed tick, interpolated eye
 * (port of BimGo.App/Game/Player.cs).
 */
export class Player {
  private static readonly WALK_SPEED = 3.2;
  private static readonly RUN_SPEED = 6.5;
  private static readonly CROUCH_SPEED = 1.6;
  private static readonly FLY_SPEED = 6;
  private static readonly FLY_FAST_SPEED = 18;
  private static readonly LOOK_SCALE = 0.0022;

  flying = false;
  yaw = 0;
  pitch = 0;

  homeFeet: Vec3 = vec3();
  homeYaw = 0;
  homePitch = 0;
  homeFlying = false;

  private previousFeet: Vec3 = vec3();
  private currentFeet: Vec3 = vec3();
  private visualZ = 0;
  private eyeHeight = CharacterController.STAND_EYE;
  private jumpQueued = false;

  constructor(readonly controller: CharacterController) {}

  get feet(): Vec3 {
    return this.controller.feet;
  }

  // #region Per-frame (variable rate)

  look(dx: number, dy: number, sensitivity: number, invertY: boolean): void {
    this.yaw -= dx * Player.LOOK_SCALE * sensitivity;
    this.pitch += (invertY ? dy : -dy) * Player.LOOK_SCALE * sensitivity;
    this.pitch = clamp(this.pitch, -1.55, 1.55);
    if (this.yaw > Math.PI) { this.yaw -= Math.PI * 2; }
    if (this.yaw < -Math.PI) { this.yaw += Math.PI * 2; }
  }

  queueJump(): void {
    this.jumpQueued = true;
  }

  toggleFly(): void {
    this.flying = !this.flying;
    this.controller.velocity = vec3();
    this.controller.grounded = false;
  }

  /** The eye between the last two ticks (alpha 0..1), with stair smoothing and crouch easing. */
  getEye(alpha: number, dt: number): Vec3 {
    const a = this.previousFeet, b = this.currentFeet;
    const fx = a.x + (b.x - a.x) * alpha, fy = a.y + (b.y - a.y) * alpha, fz = a.z + (b.z - a.z) * alpha;

    // Smooth small vertical jumps (stairs) while grounded; follow exactly otherwise
    const difference = fz - this.visualZ;
    if (!this.flying && this.controller.grounded && Math.abs(difference) < 0.45) {
      this.visualZ += difference * (1 - Math.exp(-16 * dt));
    } else {
      this.visualZ = fz;
    }

    const targetEye = this.controller.crouching && !this.flying ? CharacterController.CROUCH_EYE : CharacterController.STAND_EYE;
    this.eyeHeight += (targetEye - this.eyeHeight) * (1 - Math.exp(-12 * dt));

    return vec3(fx, fy, this.visualZ + this.eyeHeight);
  }

  // #endregion

  // #region Fixed tick

  fixedUpdate(dt: number, input: InputState, inputEnabled: boolean): void {
    this.previousFeet = this.currentFeet;

    let forward = 0, strafe = 0;
    let run = false, up = false, down = false;
    if (inputEnabled) {
      if (input.isDown(Vk.key('W')) || input.isDown(Vk.UP)) { forward += 1; }
      if (input.isDown(Vk.key('S')) || input.isDown(Vk.DOWN)) { forward -= 1; }
      if (input.isDown(Vk.key('D')) || input.isDown(Vk.RIGHT)) { strafe += 1; }
      if (input.isDown(Vk.key('A')) || input.isDown(Vk.LEFT)) { strafe -= 1; }
      run = input.isDown(Vk.SHIFT);
      up = input.isDown(Vk.SPACE);
      down = input.isDown(Vk.CONTROL);
    }

    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const c = this.controller;

    if (this.flying) {
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const vertical = (up ? 1 : 0) - (down ? 1 : 0);
      let mx = cp * cy * forward + sy * strafe;
      let my = cp * sy * forward - cy * strafe;
      let mz = sp * forward + vertical;
      const l2 = mx * mx + my * my + mz * mz;
      if (l2 > 1) { const l = Math.sqrt(l2); mx /= l; my /= l; mz /= l; }
      const speed = (run ? Player.FLY_FAST_SPEED : Player.FLY_SPEED) * dt;
      c.feet = vec3(c.feet.x + mx * speed, c.feet.y + my * speed, c.feet.z + mz * speed);
      c.velocity = vec3();
      this.jumpQueued = false;
    } else {
      let wx = cy * forward + sy * strafe;
      let wy = sy * forward - cy * strafe;
      const l2 = wx * wx + wy * wy;
      if (l2 > 1) { const l = Math.sqrt(l2); wx /= l; wy /= l; }
      const speed = c.crouching ? Player.CROUCH_SPEED : run ? Player.RUN_SPEED : Player.WALK_SPEED;
      c.step(dt, wx * speed, wy * speed, this.jumpQueued, down);
      this.jumpQueued = false;
    }

    this.currentFeet = vec3(c.feet.x, c.feet.y, c.feet.z);
  }

  // #endregion

  // #region Teleport and home

  teleportTo(feet: Vec3, yaw?: number, pitch?: number): void {
    this.controller.teleport(feet);
    this.previousFeet = vec3(feet.x, feet.y, feet.z);
    this.currentFeet = vec3(feet.x, feet.y, feet.z);
    this.visualZ = feet.z;
    if (yaw !== undefined) { this.yaw = yaw; }
    if (pitch !== undefined) { this.pitch = pitch; }
  }

  setHome(): void {
    this.homeFeet = vec3(this.feet.x, this.feet.y, this.feet.z);
    this.homeYaw = this.yaw;
    this.homePitch = this.pitch;
    this.homeFlying = this.flying;
  }

  goHome(): void {
    if (this.flying !== this.homeFlying) { this.toggleFly(); }
    this.teleportTo(this.homeFeet, this.homeYaw, this.homePitch);
  }

  // #endregion
}
