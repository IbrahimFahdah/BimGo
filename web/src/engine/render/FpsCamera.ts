import { type Matrix4x4, Mat4 } from '../../core/math/Matrix4x4';
import { clamp, type Vec2, type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import type { Aabb } from '../../core/scene/SceneData';

/**
 * A first-person camera: Z up, yaw about Z (0 = +X), pitch up positive, horizontal field of view
 * (port of BimGo.App/Rendering/FpsCamera.cs).
 */
export class FpsCamera {
  static readonly NEAR = 0.06;
  static readonly FAR = 4000;

  position: Vec3 = vec3();
  yaw = 0;
  pitch = 0;
  horizontalFovDegrees = 90;
  aspect = 16 / 9;
  viewportHeight = 720;
  viewportWidth = 1280;

  forward: Vec3 = vec3(1, 0, 0);
  right: Vec3 = vec3(0, -1, 0);
  flatForward: Vec3 = vec3(1, 0, 0);
  view: Matrix4x4 = Mat4.identity();
  projection: Matrix4x4 = Mat4.identity();
  viewProjection: Matrix4x4 = Mat4.identity();
  inverseViewProjection: Matrix4x4 = Mat4.identity();
  fovY = 0;
  /** World units per pixel at distance 1. */
  pixelScale = 0;
  /** Frustum planes (a, b, c, d) × 6. */
  readonly planes = new Float32Array(24);

  // Photo mode: a view direction / up given outright (360 panorama faces, straight up and down)
  private customForward: Vec3 | null = null;
  private customUp: Vec3 = vec3(0, 0, 1);

  /** Looks along a direction with a given up vector until clearCustomView (yaw / pitch are ignored meanwhile). */
  setCustomView(forward: Vec3, up: Vec3): void {
    this.customForward = V.normalize(forward);
    this.customUp = V.normalize(up);
  }

  /** Back to yaw / pitch. */
  clearCustomView(): void {
    this.customForward = null;
  }

  update(): void {
    this.pitch = clamp(this.pitch, -1.553, 1.553);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);

    this.forward = vec3(cp * cy, cp * sy, sp);
    this.flatForward = vec3(cy, sy, 0);
    this.right = vec3(sy, -cy, 0);
    let up = vec3(0, 0, 1);
    if (this.customForward) {
      const f = this.customForward;
      this.forward = f;
      up = this.customUp;
      this.right = V.normalize(V.cross(f, up));
      const flat = vec3(f.x, f.y, 0);
      this.flatForward = V.lengthSquared(flat) > 1e-6 ? V.normalize(flat) : vec3(-up.x, -up.y, 0);
    }

    const hfov = this.horizontalFovDegrees * Math.PI / 180;
    this.fovY = 2 * Math.atan(Math.tan(hfov * 0.5) / Math.max(this.aspect, 0.1));
    this.pixelScale = 2 * Math.tan(this.fovY * 0.5) / Math.max(this.viewportHeight, 1);

    const p = this.position, f = this.forward;
    this.view = Mat4.createLookAt(p, vec3(p.x + f.x, p.y + f.y, p.z + f.z), up);
    this.projection = FpsCamera.perspective(this.fovY, this.aspect, FpsCamera.NEAR, FpsCamera.FAR);
    this.viewProjection = Mat4.multiply(this.view, this.projection);
    this.inverseViewProjection = Mat4.invert(this.viewProjection) ?? Mat4.identity();
    FpsCamera.extractPlanes(this.viewProjection, this.planes);
  }

  /** OpenGL-style perspective (depth −1..1) in the row-vector layout. */
  static perspective(fovY: number, aspect: number, near: number, far: number): Matrix4x4 {
    const f = 1 / Math.tan(fovY * 0.5);
    return Float32Array.of(
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, 2 * far * near / (near - far), 0);
  }

  static orthographic(width: number, height: number, near: number, far: number): Matrix4x4 {
    return Float32Array.of(
      2 / width, 0, 0, 0,
      0, 2 / height, 0, 0,
      0, 0, -2 / (far - near), 0,
      0, 0, -(far + near) / (far - near), 1);
  }

  /** Gribb-Hartmann planes from a view-projection (left, right, bottom, top, near, far). */
  static extractPlanes(m: Matrix4x4, planes: Float32Array): void {
    // Columns of the row-vector matrix: c1 = (M11, M21, M31, M41), …
    for (let k = 0; k < 4; k++) {
      const c1 = m[k * 4], c2 = m[k * 4 + 1], c3 = m[k * 4 + 2], c4 = m[k * 4 + 3];
      planes[k] = c4 + c1;
      planes[4 + k] = c4 - c1;
      planes[8 + k] = c4 + c2;
      planes[12 + k] = c4 - c2;
      planes[16 + k] = c4 + c3;
      planes[20 + k] = c4 - c3;
    }
  }

  static isVisible(planes: Float32Array, box: Aabb): boolean {
    return FpsCamera.isBoxVisible(planes, box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z);
  }

  static isBoxVisible(planes: Float32Array, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    for (let i = 0; i < 24; i += 4) {
      const px = planes[i], py = planes[i + 1], pz = planes[i + 2];
      const x = px >= 0 ? maxX : minX;
      const y = py >= 0 ? maxY : minY;
      const z = pz >= 0 ? maxZ : minZ;
      if (px * x + py * y + pz * z + planes[i + 3] < 0) { return false; }
    }
    return true;
  }

  /** Projects a world point to window pixels (top-left origin), or null when behind the camera. */
  worldToScreen(world: Vec3): Vec2 | null {
    const [x, y, , w] = Mat4.transform4(world.x, world.y, world.z, 1, this.viewProjection);
    if (w <= 0.01) { return null; }
    return { x: (x / w * 0.5 + 0.5) * this.viewportWidth, y: (0.5 - y / w * 0.5) * this.viewportHeight };
  }
}
