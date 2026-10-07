import { type Vec3, vec3 } from './Vector';

/**
 * A 4×4 matrix with System.Numerics.Matrix4x4 semantics: row vectors (v * M), translation in row 4, stored row-major
 * as M11, M12, … M44. Uploading this array to GLSL unchanged (transpose = false) gives the same "M * v" the
 * desktop's shaders use, so every ported formula stays literal.
 */
export type Matrix4x4 = Float32Array;

const idx = (row: number, col: number) => (row - 1) * 4 + (col - 1);

export const Mat4 = {
  identity(): Matrix4x4 {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },

  /** M[row][col], 1-based like M11. */
  get: (m: Matrix4x4, row: number, col: number): number => m[idx(row, col)],

  /** a * b (apply a, then b). */
  multiply(a: Matrix4x4, b: Matrix4x4, out: Matrix4x4 = new Float32Array(16)): Matrix4x4 {
    const r = out === a || out === b ? new Float32Array(16) : out;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
      }
    }
    if (r !== out) { out.set(r); }
    return out;
  },

  /** Matrix4x4.CreateLookAt (right-handed). */
  createLookAt(eye: Vec3, target: Vec3, up: Vec3): Matrix4x4 {
    let zx = eye.x - target.x, zy = eye.y - target.y, zz = eye.z - target.z;
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l; zy /= l; zz /= l;
    let xx = up.y * zz - up.z * zy, xy = up.z * zx - up.x * zz, xz = up.x * zy - up.y * zx;
    l = Math.hypot(xx, xy, xz) || 1;
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return Float32Array.of(
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye.x + xy * eye.y + xz * eye.z), -(yx * eye.x + yy * eye.y + yz * eye.z), -(zx * eye.x + zy * eye.y + zz * eye.z), 1);
  },

  createTranslation(t: Vec3): Matrix4x4 {
    const m = Mat4.identity();
    m[12] = t.x; m[13] = t.y; m[14] = t.z;
    return m;
  },

  /** Matrix4x4.CreateRotationZ (counter-clockwise looking down -Z with row vectors). */
  createRotationZ(radians: number): Matrix4x4 {
    const c = Math.cos(radians), s = Math.sin(radians);
    const m = Mat4.identity();
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
  },

  /** Matrix4x4.Invert; null when singular. */
  invert(m: Matrix4x4): Matrix4x4 | null {
    const [a, b, c, d, e, f, g, h, i, j, k, l, mm, n, o, p] = m;
    const kp_lo = k * p - l * o, jp_ln = j * p - l * n, jo_kn = j * o - k * n;
    const ip_lm = i * p - l * mm, io_km = i * o - k * mm, in_jm = i * n - j * mm;
    const a11 = +(f * kp_lo - g * jp_ln + h * jo_kn);
    const a12 = -(e * kp_lo - g * ip_lm + h * io_km);
    const a13 = +(e * jp_ln - f * ip_lm + h * in_jm);
    const a14 = -(e * jo_kn - f * io_km + g * in_jm);
    const det = a * a11 + b * a12 + c * a13 + d * a14;
    if (Math.abs(det) < 1e-30) { return null; }
    const inv = 1 / det;

    const gp_ho = g * p - h * o, fp_hn = f * p - h * n, fo_gn = f * o - g * n;
    const ep_hm = e * p - h * mm, eo_gm = e * o - g * mm, en_fm = e * n - f * mm;
    const gl_hk = g * l - h * k, fl_hj = f * l - h * j, fk_gj = f * k - g * j;
    const el_hi = e * l - h * i, ek_gi = e * k - g * i, ej_fi = e * j - f * i;

    return Float32Array.of(
      a11 * inv,
      -(b * kp_lo - c * jp_ln + d * jo_kn) * inv,
      +(b * gp_ho - c * fp_hn + d * fo_gn) * inv,
      -(b * gl_hk - c * fl_hj + d * fk_gj) * inv,
      a12 * inv,
      +(a * kp_lo - c * ip_lm + d * io_km) * inv,
      -(a * gp_ho - c * ep_hm + d * eo_gm) * inv,
      +(a * gl_hk - c * el_hi + d * ek_gi) * inv,
      a13 * inv,
      -(a * jp_ln - b * ip_lm + d * in_jm) * inv,
      +(a * fp_hn - b * ep_hm + d * en_fm) * inv,
      -(a * fl_hj - b * el_hi + d * ej_fi) * inv,
      a14 * inv,
      +(a * jo_kn - b * io_km + c * in_jm) * inv,
      -(a * fo_gn - b * eo_gm + c * en_fm) * inv,
      +(a * fk_gj - b * ek_gi + c * ej_fi) * inv);
  },

  /** Vector3.Transform(position, M): (x, y, z, 1) * M with the w divide left out (affine matrices). */
  transformPoint(v: Vec3, m: Matrix4x4): Vec3 {
    return vec3(
      v.x * m[0] + v.y * m[4] + v.z * m[8] + m[12],
      v.x * m[1] + v.y * m[5] + v.z * m[9] + m[13],
      v.x * m[2] + v.y * m[6] + v.z * m[10] + m[14]);
  },

  /** Vector4.Transform((x, y, z, w), M). */
  transform4(x: number, y: number, z: number, w: number, m: Matrix4x4): [number, number, number, number] {
    return [
      x * m[0] + y * m[4] + z * m[8] + w * m[12],
      x * m[1] + y * m[5] + z * m[9] + w * m[13],
      x * m[2] + y * m[6] + z * m[10] + w * m[14],
      x * m[3] + y * m[7] + z * m[11] + w * m[15]];
  }
};
