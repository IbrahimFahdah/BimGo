import { type Vec3, vec3 } from '../../core/math/Vector';
import type { Bvh } from './Bvh';
import { closestSegmentTriangle } from './GeoMath';

/** What a move touched (port of MoveResult). */
interface MoveResult {
  ground: boolean;
  ceiling: boolean;
  wall: boolean;
  wallNormalX: number;
  wallNormalY: number;
  wallNormalZ: number;
}

const newResult = (): MoveResult => ({ ground: false, ceiling: false, wall: false, wallNormalX: 0, wallNormalY: 0, wallNormalZ: 0 });

/**
 * A capsule walker with gravity, stairs and edge riding (port of BimGo.App/Physics/CharacterController.cs).
 * Same constants and order of operations as the desktop; the inner loops work on numbers and the BVH's flat arrays.
 */
export class CharacterController {
  static readonly RADIUS = 0.3;
  static readonly STAND_HEIGHT = 1.75;
  static readonly CROUCH_HEIGHT = 1.2;
  static readonly STAND_EYE = 1.62;
  static readonly CROUCH_EYE = 1.07;
  static readonly GRAVITY = 12;
  static readonly JUMP_SPEED = 4.6;
  private static readonly SUBSTEP = 0.08;
  private static readonly WALKABLE = 0.7;
  private static readonly ITERATIONS = 4;
  /** Contacts lower than this above the feet are the floor itself, not an edge to ride. */
  private static readonly EDGE_MIN_RISE = 0.004;
  /** Edge contacts must sit at least this far below the bottom sphere's centre. */
  private static readonly EDGE_BELOW_CENTRE = 0.02;

  feet: Vec3 = vec3();
  velocity: Vec3 = vec3();
  grounded = false;
  height = CharacterController.STAND_HEIGHT;
  crouching = false;
  stepHeight = 0.2;
  groundZ = 0;
  steppedThisTick = false;

  /** Per element: true = collides. */
  collisionMask: boolean[] | null = null;

  private readonly closest = new Float64Array(6);

  constructor(private readonly bvh: Bvh) {}

  // #region Step

  step(dt: number, wishX: number, wishY: number, jump: boolean, crouch: boolean): void {
    const R = CharacterController.RADIUS;
    this.steppedThisTick = false;
    this.updateCrouch(crouch);

    // Horizontal response (snappy on the ground, light air control)
    const accel = this.grounded ? 14 : 2.5;
    const k = Math.min(1, accel * dt);
    this.velocity.x += (wishX - this.velocity.x) * k;
    this.velocity.y += (wishY - this.velocity.y) * k;

    let jumped = false;
    if (this.grounded && jump && !this.crouching) {
      this.velocity.z = CharacterController.JUMP_SPEED;
      this.grounded = false;
      jumped = true;
    }
    this.velocity.z -= CharacterController.GRAVITY * dt;
    this.velocity.z = Math.max(this.velocity.z, -40);

    const wasGrounded = this.grounded;

    // Horizontal move with step-up
    const deltaX = this.velocity.x * dt, deltaY = this.velocity.y * dt;
    if (deltaX * deltaX + deltaY * deltaY > 1e-12) {
      let result = newResult();
      let moved = this.move(this.feet, vec3(deltaX, deltaY, 0), result);
      const wanted = Math.hypot(deltaX, deltaY);
      const got = Math.hypot(moved.x - this.feet.x, moved.y - this.feet.y);

      // Blocked by something taller than the round bottom can ride (edge riding handles ordinary risers inside
      // resolve): probe a capsule radius ahead at step height for a floor to land on
      if (wasGrounded && !jumped && got < wanted * 0.5 && this.stepHeight > 0) {
        const raised = vec3(this.feet.x, this.feet.y, this.feet.z + this.stepHeight);
        if (!this.overlaps(raised, this.height)) {
          const dirX = deltaX / wanted, dirY = deltaY / wanted;
          const probe = Math.max(wanted, R + 0.05);
          const across = this.move(raised, vec3(dirX * probe, dirY * probe, 0), newResult());
          const r3 = newResult();
          const landed = this.move(across, vec3(0, 0, -this.stepHeight - 0.01), r3);
          const rise = landed.z - this.feet.z;
          const probed = Math.hypot(landed.x - this.feet.x, landed.y - this.feet.y);

          // A real step: we got clearly further, landed on a floor, and it's up (not back down)
          if (r3.ground && probed > got + probe * 0.5 && rise > 0.01 && rise <= this.stepHeight + 0.01) {
            // Lift to the step's height, then make only this tick's move (no forward jump)
            const lifted = vec3(this.feet.x, this.feet.y, this.feet.z + rise);
            if (!this.overlaps(lifted, this.height)) {
              const r4 = newResult();
              moved = this.move(lifted, vec3(deltaX, deltaY, 0), r4);
              result = r4;
              this.steppedThisTick = true;
            }
          }
        }
      }

      this.feet = moved;
      if (result.wall) { this.clipVelocity(result.wallNormalX, result.wallNormalY); }
    }

    // Vertical move
    const vertical = newResult();
    this.feet = this.move(this.feet, vec3(0, 0, this.velocity.z * dt), vertical);
    this.grounded = false;
    if (vertical.ground && this.velocity.z <= 0) {
      this.grounded = true;
      this.velocity.z = 0;
    }
    if (vertical.ceiling && this.velocity.z > 0) { this.velocity.z = 0; }

    // Snap down (walking down stairs or off small lips) instead of falling
    if (!this.grounded && wasGrounded && !jumped && this.velocity.z <= 0) {
      const snap = newResult();
      const snapped = this.move(this.feet, vec3(0, 0, -this.stepHeight - 0.02), snap);
      if (snap.ground) {
        this.feet = snapped;
        this.grounded = true;
        this.velocity.z = 0;
      }
    }

    // Ground plane catches falls
    if (this.feet.z <= this.groundZ) {
      this.feet.z = this.groundZ;
      if (this.velocity.z <= 0) {
        this.grounded = true;
        this.velocity.z = 0;
      }
    }
  }

  private updateCrouch(crouch: boolean): void {
    if (crouch) {
      this.crouching = true;
      this.height = CharacterController.CROUCH_HEIGHT;
    } else if (this.crouching && !this.overlaps(this.feet, CharacterController.STAND_HEIGHT)) {
      this.crouching = false;
      this.height = CharacterController.STAND_HEIGHT;
    }
  }

  private clipVelocity(nx: number, ny: number): void {
    const length = Math.hypot(nx, ny);
    if (length < 1e-5) { return; }
    nx /= length;
    ny /= length;
    const into = this.velocity.x * nx + this.velocity.y * ny;
    if (into < 0) {
      this.velocity.x -= nx * into;
      this.velocity.y -= ny * into;
    }
  }

  teleport(feet: Vec3): void {
    this.feet = vec3(feet.x, feet.y, feet.z);
    this.velocity = vec3();
    this.grounded = false;
  }

  // #endregion

  // #region Movement and resolution

  /** Moves the capsule in sub-steps, resolving penetration after each. */
  move(start: Vec3, delta: Vec3, result: MoveResult): Vec3 {
    const length = Math.hypot(delta.x, delta.y, delta.z);
    const steps = Math.max(1, Math.ceil(length / CharacterController.SUBSTEP));
    const feet = vec3(start.x, start.y, start.z);
    for (let i = 0; i < steps; i++) {
      feet.x += delta.x / steps;
      feet.y += delta.y / steps;
      feet.z += delta.z / steps;
      this.resolve(feet, this.height, result);
    }
    return feet;
  }

  private resolve(feet: Vec3, height: number, result: MoveResult): void {
    const pad = CharacterController.RADIUS + 0.02;
    for (let iteration = 0; iteration < CharacterController.ITERATIONS; iteration++) {
      let pushed = false;
      let minX = feet.x - pad, minY = feet.y - pad, minZ = feet.z - 0.02;
      let maxX = feet.x + pad, maxY = feet.y + pad, maxZ = feet.z + height + 0.02;

      const count = this.bvh.query(minX, minY, minZ, maxX, maxY, maxZ, this.collisionMask);
      const results = this.bvh.results, tris = this.bvh.triangles;
      for (let i = 0; i < count; i++) {
        const o = results[i] * 9;
        if (!triangleOverlaps(tris, o, minX, minY, minZ, maxX, maxY, maxZ)) { continue; }
        if (this.pushOut(feet, height, tris, o, result)) {
          pushed = true;
          minX = feet.x - pad; minY = feet.y - pad; minZ = feet.z - 0.02;
          maxX = feet.x + pad; maxY = feet.y + pad; maxZ = feet.z + height + 0.02;
        }
      }

      if (feet.z < this.groundZ) {
        feet.z = this.groundZ;
        result.ground = true;
      }

      if (!pushed) { break; }
    }
  }

  private pushOut(feet: Vec3, height: number, T: Float32Array, o: number, result: MoveResult): boolean {
    const R = CharacterController.RADIUS;
    const px = feet.x, py = feet.y, pz = feet.z + R;
    const qz = feet.z + height - R;
    const c = this.closest;
    const distanceSquared = closestSegmentTriangle(px, py, pz, px, py, qz, T, o, c);
    if (distanceSquared >= R * R) { return false; }
    const sx = c[0], sy = c[1], sz = c[2], tx = c[3], ty = c[4], tz = c[5];

    // Edge riding: a contact on the round bottom, below its centre and no higher than a step above the feet, lifts
    // the capsule straight up until the sphere just clears it (it rolls up nosings and riser tops). The whole
    // triangle must be within step height too: a steep slope or a wall reaching higher is a wall.
    const rise = tz - feet.z;
    const top = Math.max(T[o + 2], T[o + 5], T[o + 8]) - feet.z;
    if (rise > CharacterController.EDGE_MIN_RISE && rise <= this.stepHeight && top <= this.stepHeight + 0.01
      && tz < pz - CharacterController.EDGE_BELOW_CENTRE && sz <= pz + 1e-4) {
      const dx = px - tx, dy = py - ty;
      const horizontalSquared = dx * dx + dy * dy;
      if (horizontalSquared < R * R) {
        const centreZ = tz + Math.sqrt(R * R - horizontalSquared) + 0.0005;
        const lift = centreZ - pz;
        if (lift > 0) {
          feet.z += lift;
          result.ground = true;
          return true;
        }
      }
    }

    const distance = Math.sqrt(distanceSquared);
    let nx: number, ny: number, nz: number;
    if (distance > 1e-5) {
      nx = (sx - tx) / distance; ny = (sy - ty) / distance; nz = (sz - tz) / distance;
    } else {
      // Pierced: use the face normal facing the capsule centre
      const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
      const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
      nx = e1y * e2z - e1z * e2y; ny = e1z * e2x - e1x * e2z; nz = e1x * e2y - e1y * e2x;
      const length = Math.hypot(nx, ny, nz);
      if (length < 1e-12) { return false; }
      nx /= length; ny /= length; nz /= length;
      const centreZ = (pz + qz) * 0.5;
      if ((px - tx) * nx + (py - ty) * ny + (centreZ - tz) * nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    }

    const depth = R - distance + 0.0005;
    if (nz > CharacterController.WALKABLE) {
      feet.z += depth / nz;
      result.ground = true;
    } else if (nz < -CharacterController.WALKABLE) {
      feet.x += nx * depth; feet.y += ny * depth; feet.z += nz * depth;
      result.ceiling = true;
    } else {
      feet.x += nx * depth; feet.y += ny * depth; feet.z += nz * depth;
      result.wall = true;
      result.wallNormalX += nx; result.wallNormalY += ny; result.wallNormalZ += nz;
    }
    return true;
  }

  /** True when a capsule of this height at these feet would intersect the scene. */
  overlaps(feet: Vec3, height: number): boolean {
    const R = CharacterController.RADIUS;
    const px = feet.x, py = feet.y, pz = feet.z + R, qz = feet.z + height - R;
    const limit = (R - 0.01) * (R - 0.01);

    const count = this.bvh.query(feet.x - R, feet.y - R, feet.z, feet.x + R, feet.y + R, feet.z + height, this.collisionMask);
    const results = this.bvh.results, tris = this.bvh.triangles;
    for (let i = 0; i < count; i++) {
      if (closestSegmentTriangle(px, py, pz, px, py, qz, tris, results[i] * 9, this.closest) < limit) { return true; }
    }
    return false;
  }

  // #endregion
}

function triangleOverlaps(T: Float32Array, o: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
  return Math.max(T[o], T[o + 3], T[o + 6]) >= minX && Math.min(T[o], T[o + 3], T[o + 6]) <= maxX
    && Math.max(T[o + 1], T[o + 4], T[o + 7]) >= minY && Math.min(T[o + 1], T[o + 4], T[o + 7]) <= maxY
    && Math.max(T[o + 2], T[o + 5], T[o + 8]) >= minZ && Math.min(T[o + 2], T[o + 5], T[o + 8]) <= maxZ;
}
