import { CAMERA_KEY_MAX_HOLD, type CameraHeading, CameraPathLimits } from '../format/CameraPathModels';
import { type Vec3, vec3 } from '../math/Vector';
import { type ITourTimeline, type TourPose, TourTimeline } from './TourTimeline';

/** One key of a camera path, resolved for playback (scene-local metres, radians, the path's defaults applied). */
export interface CameraPathPoint {
  eye: Vec3;
  yaw: number;
  pitch: number;
  heading: CameraHeading;
  target: Vec3;
  smoothness: number;
  speed: number;
  holdSeconds: number;
  ease: boolean;
  /** Round K-C: a pan over the hold (radians, positive left): with its own view and a hold only (else 0). */
  swivel: number;
}

/** A resolved key with its values sanitised (CameraPathPoint's constructor). */
export function cameraPathPoint(eye: Vec3, yaw: number, pitch: number, heading: CameraHeading, target: Vec3, smoothness: number, speed: number,
  holdSeconds: number, ease: boolean, swivel = 0): CameraPathPoint {
  const hold = Number.isFinite(holdSeconds) ? Math.min(Math.max(holdSeconds, 0), CAMERA_KEY_MAX_HOLD) : 0;
  return {
    eye, heading, target,
    yaw: Number.isFinite(yaw) ? yaw : 0,
    pitch: Number.isFinite(pitch) ? Math.min(Math.max(pitch, -1.5), 1.5) : 0,
    smoothness: Number.isFinite(smoothness) ? Math.min(Math.max(smoothness, 0), 1) : 1,
    speed: Number.isFinite(speed) ? Math.min(Math.max(speed, CameraPathLimits.MIN_SPEED), CameraPathLimits.MAX_SPEED) : 1.5,
    holdSeconds: hold,
    ease: ease || hold > 0,
    swivel: heading === 'key' && hold > 0 && Number.isFinite(swivel) ? Math.min(Math.max(swivel, -Math.PI), Math.PI) : 0
  };
}

const overrides = (k: CameraPathPoint) => k.heading !== 'follow';

/** The path-wide playback settings of a CameraPathTimeline. */
export interface CameraPathSettings {
  loop: boolean;
  fadeSeconds: number;
  lookAhead: number;
  level: boolean;
  followBetween: boolean;
}

export function cameraPathSettings(loop: boolean, fadeSeconds: number, lookAhead: number, level: boolean, followBetween = false): CameraPathSettings {
  return {
    loop,
    fadeSeconds: Number.isFinite(fadeSeconds) ? Math.min(Math.max(fadeSeconds, 0), CameraPathLimits.MAX_FADE) : 0,
    lookAhead: Number.isFinite(lookAhead) ? Math.min(Math.max(lookAhead, CameraPathLimits.MIN_LOOK_AHEAD), CameraPathLimits.MAX_LOOK_AHEAD) : 3,
    level, followBetween
  };
}

/** Where a camera path's camera is at one moment. */
export interface CameraPathPose {
  key: number;
  eye: Vec3;
  yaw: number;
  pitch: number;
  black: number;
  moving: boolean;
  finished: boolean;
  blendFrom: number;
  blendTo: number;
  blendT: number;
  /** Distance along the path from the first key (m). */
  distance: number;
}

/** The tour player's pose: the eye split into feet and an eye height. */
export function pathPoseToTourPose(p: CameraPathPose, eyeHeight: number): TourPose {
  return {
    stop: p.key, feet: vec3(p.eye.x, p.eye.y, p.eye.z - eyeHeight), eyeHeight, yaw: p.yaw, pitch: p.pitch, black: p.black, moving: p.moving,
    finished: p.finished, blendFrom: p.blendFrom, blendTo: p.blendTo, blendT: p.blendT
  };
}

const SAMPLES = 48;
const EPSILON = 1e-4;
const TAU = Math.PI * 2;

const sub = (a: Vec3, b: Vec3) => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
const len = (a: Vec3) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dist2 = (a: Vec3, b: Vec3) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
const scale = (a: Vec3, s: number) => vec3(a.x * s, a.y * s, a.z * s);

/** Centripetal knot spacing (the square root of the distance), never zero. */
const knot = (a: Vec3, b: Vec3) => Math.max(Math.sqrt(dist(a, b)), 1e-3);

/** Distance covered over a smoothstep velocity ramp, as a fraction of ramp time × speed (0 → 0.5). */
function ramp(x: number): number {
  x = Math.min(Math.max(x, 0), 1);
  const x3 = x * x * x;
  return x3 - 0.5 * x3 * x;
}

/**
 * The timing and shape of a keyframed camera path (Round K, port of CameraPathTimeline): a centripetal Catmull-Rom
 * curve through the keys (Hermite segments, tangents scaled by each key's smoothness), constant speed along it with
 * smoothstep ramps where keys ease, holds and end fades, and a heading that follows the path (look-ahead) or a key's
 * own view near it.
 */
export class CameraPathTimeline implements ITourTimeline {
  static readonly EASE_ACCELERATION = 1.5;
  static readonly MIN_RAMP_SECONDS = 0.4;
  static readonly MAX_RAMP_SECONDS = 4;
  static readonly STILL_SEGMENT_SECONDS = 1.5;

  private readonly keys: CameraPathPoint[];
  private readonly settings: CameraPathSettings;
  private readonly segments: number;
  private readonly p0: Vec3[]; private readonly m0: Vec3[]; private readonly p1: Vec3[]; private readonly m1: Vec3[];
  private readonly arc: Float64Array;
  private readonly length: Float64Array;
  private readonly offset: Float64Array;
  private readonly total: number;
  private readonly speed: Float64Array; private readonly rampA: Float64Array; private readonly rampB: Float64Array;
  private readonly cruise: Float64Array; private readonly time: Float64Array;
  private readonly arrive: Float64Array; private readonly segmentStart: Float64Array;
  private readonly fade: number;
  private readonly endDirection: Vec3;
  readonly duration: number;
  readonly eyeHeight: number;

  constructor(keys: readonly CameraPathPoint[], settings: CameraPathSettings, eyeHeight = 1.6) {
    this.keys = [...(keys ?? [])];
    this.settings = settings;
    this.eyeHeight = Number.isFinite(eyeHeight) ? Math.min(Math.max(eyeHeight, 0.1), 5) : 1.6;
    const n = this.keys.length;
    const loop = settings.loop && n >= 2;
    const S = n < 2 ? 0 : loop ? n : n - 1;
    this.segments = S;
    this.fade = loop ? 0 : settings.fadeSeconds;
    this.p0 = new Array<Vec3>(S); this.m0 = new Array<Vec3>(S); this.p1 = new Array<Vec3>(S); this.m1 = new Array<Vec3>(S);
    this.arc = new Float64Array(S * (SAMPLES + 1));
    this.length = new Float64Array(S); this.offset = new Float64Array(S);
    this.speed = new Float64Array(S); this.rampA = new Float64Array(S); this.rampB = new Float64Array(S);
    this.cruise = new Float64Array(S); this.time = new Float64Array(S);
    this.arrive = new Float64Array(n); this.segmentStart = new Float64Array(S);

    // Centripetal Catmull-Rom tangents at every key
    const tangents = new Array<Vec3>(n).fill(vec3());
    for (let i = 0; i < n && n >= 2; i++) {
      const p = this.keys[i].eye;
      const previous = loop || i > 0 ? this.keys[(i - 1 + n) % n].eye : sub(scale(p, 2), this.keys[1].eye);
      const next = loop || i < n - 1 ? this.keys[(i + 1) % n].eye : sub(scale(p, 2), this.keys[n - 2].eye);
      const d0 = knot(previous, p), d1 = knot(p, next);
      const a = scale(sub(p, previous), 1 / d0), b = scale(sub(next, previous), 1 / (d0 + d1)), c = scale(sub(next, p), 1 / d1);
      tangents[i] = vec3(a.x - b.x + c.x, a.y - b.y + c.y, a.z - b.z + c.z);
    }

    let total = 0;
    for (let s = 0; s < S; s++) {
      const a = s, b = (s + 1) % n;
      const pa = this.keys[a].eye, pb = this.keys[b].eye;
      const span = knot(pa, pb);
      this.p0[s] = pa;
      this.p1[s] = pb;
      const still = dist2(pa, pb) < EPSILON * EPSILON;
      this.m0[s] = still ? vec3() : scale(tangents[a], span * this.keys[a].smoothness);
      this.m1[s] = still ? vec3() : scale(tangents[b], span * this.keys[b].smoothness);
      const base = s * (SAMPLES + 1);
      let length = 0;
      this.arc[base] = 0;
      for (let k = 1; k <= SAMPLES; k++) {
        length += this.spanLength(s, (k - 1) / SAMPLES, k / SAMPLES);
        this.arc[base + k] = length;
      }
      this.length[s] = length;
      this.offset[s] = total;
      total += length;
      this.layOutMotion(s, length, this.keys[a].speed, this.keys[a].ease, this.keys[b].ease);
    }
    this.total = total;

    let t = this.fade;
    for (let i = 0; i < n; i++) {
      this.arrive[i] = i === 0 ? 0 : t;
      t += this.keys[i].holdSeconds;
      if (i < S) {
        this.segmentStart[i] = t;
        t += this.time[i];
      }
    }
    this.duration = loop ? t : n === 0 ? 0 : t + this.fade;

    let end = vec3(1, 0, 0);
    if (S > 0) {
      const s = S - 1;
      let direction = sub(this.hermite(s, 1), this.hermite(s, 1 - 1 / SAMPLES));
      if (len(direction) < EPSILON) { direction = sub(this.p1[s], this.p0[s]); }
      if (len(direction) > EPSILON) { end = scale(direction, 1 / len(direction)); }
    }
    this.endDirection = end;
  }

  get count(): number { return this.keys.length; }

  /** Total length along the curve (m). */
  get pathLength(): number { return this.total; }

  /** True when the path loops. */
  get loops(): boolean { return this.settings.loop && this.keys.length >= 2; }

  /** A key as resolved. */
  keyAt(index: number): CameraPathPoint { return this.keys[index]; }

  private layOutMotion(s: number, length: number, speed: number, easeA: boolean, easeB: boolean): void {
    const C = CameraPathTimeline;
    const ramps = (easeA ? 1 : 0) + (easeB ? 1 : 0);
    if (length < EPSILON) {
      this.speed[s] = 0;
      this.time[s] = C.STILL_SEGMENT_SECONDS;
      return;
    }
    let r = Math.min(Math.max(speed / C.EASE_ACCELERATION, C.MIN_RAMP_SECONDS), C.MAX_RAMP_SECONDS);
    let rampDistance = speed * r * 0.5;
    if (ramps > 0 && rampDistance * ramps > length) {
      const top = Math.sqrt(2 * length * speed / (ramps * r));
      r *= top / speed;
      speed = top;
      rampDistance = speed * r * 0.5;
    }
    this.speed[s] = speed;
    this.rampA[s] = easeA ? r : 0;
    this.rampB[s] = easeB ? r : 0;
    this.cruise[s] = Math.max(0, (length - rampDistance * ramps) / speed);
    this.time[s] = Math.max(this.rampA[s] + this.cruise[s] + this.rampB[s], 0.05);
  }

  private hermite(s: number, u: number): Vec3 {
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const a = this.p0[s], b = this.m0[s], c = this.p1[s], d = this.m1[s];
    return vec3(h00 * a.x + h10 * b.x + h01 * c.x + h11 * d.x, h00 * a.y + h10 * b.y + h01 * c.y + h11 * d.y, h00 * a.z + h10 * b.z + h01 * c.z + h11 * d.z);
  }

  private slopeLength(s: number, u: number): number {
    const u2 = u * u;
    const k0 = 6 * u2 - 6 * u, k1 = 3 * u2 - 4 * u + 1, k2 = -6 * u2 + 6 * u, k3 = 3 * u2 - 2 * u;
    const a = this.p0[s], b = this.m0[s], c = this.p1[s], d = this.m1[s];
    return Math.hypot(k0 * a.x + k1 * b.x + k2 * c.x + k3 * d.x, k0 * a.y + k1 * b.y + k2 * c.y + k3 * d.y, k0 * a.z + k1 * b.z + k2 * c.z + k3 * d.z);
  }

  private spanLength(s: number, from: number, to: number): number {
    const mid = 0.5 * (from + to);
    return (to - from) / 6 * (this.slopeLength(s, from) + 4 * this.slopeLength(s, mid) + this.slopeLength(s, to));
  }

  private distanceIn(s: number, tau: number): number {
    const length = this.length[s];
    if (this.speed[s] <= 0 || length < EPSILON) { return 0; }
    const v = this.speed[s], ra = this.rampA[s], rb = this.rampB[s];
    if (tau <= 0) { return 0; }
    if (tau >= this.time[s]) { return length; }
    if (ra > 0 && tau < ra) { return v * ra * ramp(tau / ra); }
    const afterRamp = ra > 0 ? v * ra * 0.5 : 0;
    if (tau < ra + this.cruise[s]) { return Math.min(length, afterRamp + v * (tau - ra)); }
    if (rb > 0) {
      const left = Math.max(0, this.time[s] - tau);
      return Math.min(Math.max(length - v * rb * ramp(left / rb), 0), length);
    }
    return length;
  }

  private pointIn(s: number, distance: number): Vec3 {
    const base = s * (SAMPLES + 1);
    const length = this.length[s];
    if (length < EPSILON) { return this.p0[s]; }
    distance = Math.min(Math.max(distance, 0), length);
    let lo = 0, hi = SAMPLES;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.arc[base + mid] <= distance) { lo = mid; } else { hi = mid; }
    }
    const a = this.arc[base + lo], b = this.arc[base + hi];
    const f = b - a > 1e-6 ? (distance - a) / (b - a) : 0;
    const uLow = lo / SAMPLES, uHigh = hi / SAMPLES;
    let u = (lo + f) / SAMPLES;
    for (let step = 0; step < 2; step++) {
      const rate = this.slopeLength(s, u);
      if (rate < 1e-5) { break; }
      u = Math.min(Math.max(u - (a + this.spanLength(s, uLow, u) - distance) / rate, uLow), uHigh);
    }
    return this.hermite(s, u);
  }

  /** The point at a distance from the first key (wraps when looping; carries on straight past the end). */
  pointAt(distance: number): Vec3 {
    if (this.keys.length === 0) { return vec3(); }
    if (this.segments === 0 || this.total < EPSILON) { return this.keys[0].eye; }
    if (this.loops) {
      distance %= this.total;
      if (distance < 0) { distance += this.total; }
    } else if (distance >= this.total) {
      const e = this.p1[this.segments - 1], d = distance - this.total;
      return vec3(e.x + this.endDirection.x * d, e.y + this.endDirection.y * d, e.z + this.endDirection.z * d);
    } else if (distance <= 0) {
      return this.p0[0];
    }
    const s = this.segmentHolding(distance);
    return this.pointIn(s, distance - this.offset[s]);
  }

  private segmentHolding(distance: number): number {
    let lo = 0, hi = this.segments - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offset[mid] <= distance) { lo = mid; } else { hi = mid - 1; }
    }
    return lo;
  }

  /** Round K-B: the segment holding a distance from the first key (−1 when there are no segments). */
  segmentAt(distance: number): number {
    if (this.segments === 0) { return -1; }
    if (this.loops && this.total > EPSILON) {
      distance %= this.total;
      if (distance < 0) { distance += this.total; }
    }
    return this.segmentHolding(distance);
  }

  /** Round K-B: the point on the path nearest a point: its distance from it, the segment and the distance along. */
  nearest(point: Vec3): { distance: number; segment: number; along: number } {
    let segment = -1, along = 0, best = Infinity;
    for (let s = 0; s < this.segments; s++) {
      const base = s * (SAMPLES + 1);
      let previous = this.p0[s];
      for (let k = 1; k <= SAMPLES; k++) {
        const next = this.hermite(s, k / SAMPLES);
        const cx = next.x - previous.x, cy = next.y - previous.y, cz = next.z - previous.z;
        const l2 = cx * cx + cy * cy + cz * cz;
        const t = l2 > 1e-10 ? Math.min(Math.max(((point.x - previous.x) * cx + (point.y - previous.y) * cy + (point.z - previous.z) * cz) / l2, 0), 1) : 0;
        const d = Math.hypot(point.x - (previous.x + cx * t), point.y - (previous.y + cy * t), point.z - (previous.z + cz * t));
        if (d < best) {
          best = d;
          segment = s;
          along = this.offset[s] + this.arc[base + k - 1] + (this.arc[base + k] - this.arc[base + k - 1]) * t;
        }
        previous = next;
      }
    }
    return { distance: best, segment, along };
  }

  /** Round K-B: the time at which the camera is a distance along the path (the first time it gets there, holds excluded). */
  timeAtDistance(distance: number): number {
    const s = this.segmentAt(distance);
    if (s < 0) { return 0; }
    const local = Math.min(Math.max(distance - this.offset[s], 0), this.length[s]);
    let lo = 0, hi = this.time[s];
    for (let i = 0; i < 32; i++) {
      const mid = 0.5 * (lo + hi);
      if (this.distanceIn(s, mid) < local) { lo = mid; } else { hi = mid; }
    }
    return this.segmentStart[s] + 0.5 * (lo + hi);
  }

  /** When a key is reached (s): the start of its hold. */
  startOf(stop: number): number {
    return this.keys.length === 0 ? 0 : this.arrive[Math.min(Math.max(stop, 0), this.keys.length - 1)];
  }

  /** The key last reached at a time. */
  indexAt(time: number): number {
    if (this.keys.length === 0) { return -1; }
    let key = 0;
    for (let i = 1; i < this.arrive.length; i++) {
      if (this.arrive[i] <= time) { key = i; } else { break; }
    }
    return key;
  }

  segmentSeconds(segment: number): number { return segment >= 0 && segment < this.segments ? this.time[segment] : 0; }
  segmentLength(segment: number): number { return segment >= 0 && segment < this.segments ? this.length[segment] : 0; }

  /** The tour player's pose at a time (the eye stood on eyeHeight). */
  pose(time: number): TourPose {
    return pathPoseToTourPose(this.evaluate(time), this.eyeHeight);
  }

  /** The camera at a time (at or past the duration: finished, the last key's view, black when there are fades). */
  evaluate(time: number): CameraPathPose {
    const pose: CameraPathPose = {
      key: -1, eye: vec3(), yaw: 0, pitch: 0, black: 0, moving: false, finished: true, blendFrom: -1, blendTo: -1, blendT: 1, distance: 0
    };
    const n = this.keys.length;
    if (n === 0) { return pose; }
    if (!Number.isFinite(time) || time < 0) { time = 0; }
    let key: number, distance: number, segment = -1, u = 0, held = 1;
    if (time >= this.duration) {
      key = this.loops ? 0 : n - 1;
      distance = this.loops ? 0 : this.total;
      pose.black = this.fade > 0 ? 1 : 0;
      held = this.loops ? 0 : 1;
    } else {
      pose.finished = false;
      key = this.indexAt(time);
      const holdStart = key === 0 ? this.fade : this.arrive[key];
      const holdEnd = holdStart + this.keys[key].holdSeconds;
      distance = key < this.segments ? this.offset[key] : this.total;
      if (time < holdStart) {
        pose.black = this.fade > 0 ? Math.min(Math.max(1 - time / this.fade, 0), 1) : 0;
        held = 0;
      } else if (time < holdEnd) {
        held = TourTimeline.smooth((time - holdStart) / this.keys[key].holdSeconds);
      } else if (key < this.segments) {
        segment = key;
        const tau = time - this.segmentStart[segment];
        u = this.time[segment] > 0 ? Math.min(Math.max(tau / this.time[segment], 0), 1) : 1;
        distance = this.offset[segment] + this.distanceIn(segment, tau);
        pose.moving = true;
        pose.blendFrom = key;
        pose.blendTo = (key + 1) % n;
        pose.blendT = u;
      } else if (this.fade > 0) {
        pose.black = Math.min(Math.max((time - holdEnd) / this.fade, 0), 1);
      }
    }
    pose.key = key;
    if (pose.blendFrom < 0) { pose.blendFrom = pose.blendTo = key; }
    pose.distance = distance;
    pose.eye = segment >= 0 ? this.pointIn(segment, distance - this.offset[segment]) : this.keys[key].eye;
    this.applyHeading(pose, key, segment, u, held);
    return pose;
  }

  private applyHeading(pose: CameraPathPose, key: number, segment: number, u: number, held: number): void {
    let followYaw: number, followPitch: number;
    const p = this.pointAt(pose.distance + this.settings.lookAhead);
    let ax = p.x - pose.eye.x, ay = p.y - pose.eye.y, az = p.z - pose.eye.z;
    const l2 = ax * ax + ay * ay + az * az;
    if (this.segments > 0 && l2 > 1e-6) {
      const l = Math.sqrt(l2);
      ax /= l; ay /= l; az /= l;
      followYaw = Math.atan2(ay, ax);
      followPitch = this.settings.level ? 0 : Math.asin(Math.min(Math.max(az, -1), 1));
    } else {
      followYaw = this.keys[key].yaw;
      followPitch = this.settings.level ? 0 : this.keys[key].pitch;
    }
    let yaw = followYaw, pitch = followPitch;
    const lerp = TourTimeline.lerpAngle, smooth = TourTimeline.smooth;
    if (segment < 0) {
      if (overrides(this.keys[key])) { [yaw, pitch] = this.keyView(key, pose.eye, held); }
    } else {
      const a = segment, b = (segment + 1) % this.keys.length;
      const overA = overrides(this.keys[a]), overB = overrides(this.keys[b]);
      const between = overA && overB && this.settings.followBetween && this.length[segment] >= 2 * this.settings.lookAhead;
      if (between) {
        if (u < 0.5) {
          const [yawA, pitchA] = this.keyView(a, pose.eye, 1);
          const w = 1 - smooth(u * 2);
          yaw = lerp(followYaw, yawA, w);
          pitch = followPitch + (pitchA - followPitch) * w;
        } else {
          const [yawB, pitchB] = this.keyView(b, pose.eye, 0);
          const w = smooth(u * 2 - 1);
          yaw = lerp(followYaw, yawB, w);
          pitch = followPitch + (pitchB - followPitch) * w;
        }
      } else if (overA && overB) {
        const [yawA, pitchA] = this.keyView(a, pose.eye, 1);
        const [yawB, pitchB] = this.keyView(b, pose.eye, 0);
        const w = smooth(u);
        yaw = lerp(yawA, yawB, w);
        pitch = pitchA + (pitchB - pitchA) * w;
      } else if (overA) {
        const [yawA, pitchA] = this.keyView(a, pose.eye, 1);
        const w = 1 - smooth(u * 2);
        yaw = lerp(followYaw, yawA, w);
        pitch = followPitch + (pitchA - followPitch) * w;
      } else if (overB) {
        const [yawB, pitchB] = this.keyView(b, pose.eye, 0);
        const w = smooth(u * 2 - 1);
        yaw = lerp(followYaw, yawB, w);
        pitch = followPitch + (pitchB - followPitch) * w;
      }
    }
    yaw %= TAU;
    if (yaw > Math.PI) { yaw -= TAU; } else if (yaw <= -Math.PI) { yaw += TAU; }
    pose.yaw = yaw;
    pose.pitch = Math.min(Math.max(pitch, -1.5), 1.5);
  }

  /** A key's own heading from an eye position: its view (panned by its swivel), or towards its target. */
  private keyView(index: number, eye: Vec3, swivel: number): [number, number] {
    const key = this.keys[index];
    let yaw = key.yaw + key.swivel * swivel, pitch = key.pitch;
    if (key.heading !== 'lookAt') { return [yaw, pitch]; }
    const tx = key.target.x - eye.x, ty = key.target.y - eye.y, tz = key.target.z - eye.z;
    const flat = Math.sqrt(tx * tx + ty * ty);
    if (flat < 1e-4 && Math.abs(tz) < 1e-4) { return [yaw, pitch]; }
    if (flat > 1e-4) { yaw = Math.atan2(ty, tx); }
    pitch = Math.atan2(tz, Math.max(flat, 1e-4));
    return [yaw, pitch];
  }
}
