import { type Vec3, Vec3 as V, vec3 } from '../math/Vector';

/** How the tour moves from one stop to the next (port of TourTransition; stored as "fade" / "glide"). */
export type TourTransition = 'fade' | 'glide';

/**
 * One stop of a bookmark tour, resolved for playback (port of TourStop): where the camera stands and looks, how long
 * it holds and how far it pans. Scene-local metres; angles in radians.
 */
export interface TourStop {
  feet: Vec3;
  /** Eye height above the feet (m). */
  eyeHeight: number;
  /** Look direction about +Z (radians, 0 = +X, counter-clockwise). */
  yaw: number;
  /** Look pitch (radians, positive up). */
  pitch: number;
  /** Seconds at the stop. */
  holdSeconds: number;
  /** Pan over the stop (radians, positive turns left, 0 none). */
  swivel: number;
}

/** A stop with its hold and swivel sanitised (TourStop's constructor). */
export function tourStop(feet: Vec3, eyeHeight: number, yaw: number, pitch: number, holdSeconds: number, swivel: number): TourStop {
  return {
    feet, eyeHeight, yaw, pitch,
    holdSeconds: Math.max(0, Number.isFinite(holdSeconds) ? holdSeconds : 0),
    swivel: Number.isFinite(swivel) ? swivel : 0
  };
}

/** Where the tour's camera is at one moment (port of TourPose). */
export interface TourPose {
  /** The stop whose state should be showing; during a glide, the stop being flown to (−1 when none). */
  stop: number;
  feet: Vec3;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  /** How black the frame is (0 clear, 1 black): the fades. */
  black: number;
  /** True while gliding between stops. */
  moving: boolean;
  /** True once the tour has played to its end. */
  finished: boolean;
  /**
   * Polish round P-C: the state (sun) blends from stop blendFrom to blendTo by blendT (0–1, eased). Glide: over the
   * glide; fades: half over the fade-out and half over the next fade-in. Holding: from = to = stop, 1.
   */
  blendFrom: number;
  blendTo: number;
  blendT: number;
}

/** Round K: what the tour player plays: a bookmark tour or a camera path (port of ITourTimeline). */
export interface ITourTimeline {
  readonly duration: number;
  readonly count: number;
  startOf(stop: number): number;
  indexAt(time: number): number;
  pose(time: number): TourPose;
}

function setBlend(pose: TourPose, from: number, to: number, t: number): void {
  pose.blendFrom = from;
  pose.blendTo = to;
  pose.blendT = Math.min(Math.max(t, 0), 1);
}

/** The eye position of a pose. */
export function poseEye(pose: TourPose): Vec3 {
  return vec3(pose.feet.x, pose.feet.y, pose.feet.z + pose.eyeHeight);
}

/**
 * The timing of a bookmark tour (port of BimGo.Core/Scene/TourTimeline.cs): pure maths, shared by live playback and
 * video recording, which steps it at a fixed frame rate.
 * - Fade: each stop is fade in → hold → fade out; the stop changes at black. The swivel pans over the whole visible
 *   stop, eased in and out.
 * - Glide: the first stop fades in and the last fades out; between stops the camera flies from the end of one stop's
 *   swivel to the next stop's view. A glide takes at least `glide` s, longer when the stops are far apart (at most
 *   GLIDE_SPEED m/s). The swivel pans over the hold.
 */
export class TourTimeline implements ITourTimeline {
  /** Fastest glide between stops (m/s): far-apart stops glide for longer than the set time. */
  static readonly GLIDE_SPEED = 4;
  /** Longest single glide (s), however far apart the stops are. */
  static readonly MAX_GLIDE_SECONDS = 30;

  private readonly stops: TourStop[];
  private readonly start: number[];     // when each stop becomes the current one
  private readonly holdStart: number[]; // when each stop's hold begins
  private readonly glide: number[];     // glide into each stop (glide transition; 0 for the first)
  private readonly glideMode: boolean;
  private readonly fade: number;
  /** Total length (s). */
  readonly duration: number;

  constructor(stops: readonly TourStop[], transition: TourTransition, fadeSeconds: number, glideSeconds: number) {
    this.stops = [...stops];
    this.glideMode = transition === 'glide';
    this.fade = Number.isFinite(fadeSeconds) ? Math.max(0, fadeSeconds) : 0;
    const glide = Number.isFinite(glideSeconds) ? Math.max(0.1, glideSeconds) : 3;

    const n = this.stops.length;
    this.start = new Array<number>(n).fill(0);
    this.holdStart = new Array<number>(n).fill(0);
    this.glide = new Array<number>(n).fill(0);
    let t = 0;
    for (let i = 0; i < n; i++) {
      if (!this.glideMode) {
        this.start[i] = t;
        this.holdStart[i] = t + this.fade;
        t += this.fade + this.stops[i].holdSeconds + this.fade;
      } else if (i === 0) {
        this.start[i] = 0;
        this.holdStart[i] = this.fade;
        t = this.fade + this.stops[i].holdSeconds;
      } else {
        const distance = V.distance(this.stops[i - 1].feet, this.stops[i].feet);
        this.glide[i] = TourTimeline.glideFor(distance, glide);
        this.start[i] = t;
        this.holdStart[i] = t + this.glide[i];
        t = this.holdStart[i] + this.stops[i].holdSeconds;
      }
    }
    this.duration = n === 0 ? 0 : this.glideMode ? t + this.fade : t;
  }

  /** The glide between two stops this far apart (s): the set time, longer when far, at most 30 s. */
  static glideFor(distance: number, glide: number): number {
    return Math.min(Math.max(Math.max(glide, distance / TourTimeline.GLIDE_SPEED), glide), Math.max(glide, TourTimeline.MAX_GLIDE_SECONDS));
  }

  /** Number of stops. */
  get count(): number {
    return this.stops.length;
  }

  /** A stop (for the HUD and for applying its state). */
  stopAt(index: number): TourStop {
    return this.stops[index];
  }

  /** When a stop becomes the current one (s): its fade-in, or the start of the glide into it. */
  startOf(stop: number): number {
    return this.stops.length === 0 ? 0 : this.start[Math.min(Math.max(stop, 0), this.stops.length - 1)];
  }

  /** The current stop at a time (clamped to the tour), or −1 for an empty tour. */
  indexAt(time: number): number {
    if (this.stops.length === 0) { return -1; }
    let stop = 0;
    for (let i = 1; i < this.start.length; i++) {
      if (this.start[i] <= time) { stop = i; } else { break; }
    }
    return stop;
  }

  /** The camera at a time (past the end: finished, black when there are fades). */
  evaluate(time: number): TourPose {
    const pose: TourPose = {
      stop: -1, feet: vec3(), eyeHeight: 0, yaw: 0, pitch: 0, black: 0, moving: false, finished: true, blendFrom: -1, blendTo: -1, blendT: 1
    };
    const n = this.stops.length;
    if (n === 0) { return pose; }

    if (!Number.isFinite(time) || time < 0) { time = 0; }
    if (time >= this.duration) {
      // The last stop's final view
      const last = this.stops[n - 1];
      pose.stop = n - 1;
      pose.blendFrom = pose.blendTo = n - 1;
      pose.feet = last.feet;
      pose.eyeHeight = last.eyeHeight;
      pose.yaw = last.yaw + last.swivel;
      pose.pitch = last.pitch;
      pose.black = this.fade > 0 ? 1 : 0;
      return pose;
    }

    pose.finished = false;
    const i = this.indexAt(time);
    const stop = this.stops[i];
    pose.stop = i;
    pose.blendFrom = pose.blendTo = i;
    pose.pitch = stop.pitch;

    if (!this.glideMode) {
      // Fade in → hold → fade out; the swivel runs across the whole visible stop
      const local = time - this.start[i];
      const window = this.fade + stop.holdSeconds + this.fade;
      pose.feet = stop.feet;
      pose.eyeHeight = stop.eyeHeight;
      pose.yaw = stop.yaw + stop.swivel * TourTimeline.smooth(window > 0 ? local / window : 1);
      if (this.fade > 0) {
        if (local < this.fade) {
          pose.black = 1 - local / this.fade;
          if (i > 0) { setBlend(pose, i - 1, i, 0.5 + 0.5 * TourTimeline.smooth(local / this.fade)); } // P-C
        } else if (local > this.fade + stop.holdSeconds) {
          pose.black = Math.min(Math.max((local - this.fade - stop.holdSeconds) / this.fade, 0), 1);
          if (i + 1 < n) { setBlend(pose, i, i + 1, 0.5 * TourTimeline.smooth(pose.black)); }
        }
      }
      return pose;
    }

    // Glide: flying in from the previous stop?
    if (i > 0 && time < this.holdStart[i]) {
      const from = this.stops[i - 1];
      const s = TourTimeline.smooth((time - this.start[i]) / this.glide[i]);
      pose.feet = V.lerp(from.feet, stop.feet, s);
      pose.eyeHeight = from.eyeHeight + (stop.eyeHeight - from.eyeHeight) * s;
      pose.yaw = TourTimeline.lerpAngle(from.yaw + from.swivel, stop.yaw, s);
      pose.pitch = from.pitch + (stop.pitch - from.pitch) * s;
      pose.moving = true;
      setBlend(pose, i - 1, i, s); // P-C: the sun blends over the glide
      return pose;
    }

    // The first stop's fade-in, the hold (swivel), and the last stop's fade-out
    const hold = time - this.holdStart[i];
    pose.feet = stop.feet;
    pose.eyeHeight = stop.eyeHeight;
    if (hold < 0) {
      pose.yaw = stop.yaw;
      pose.black = this.fade > 0 ? Math.min(Math.max(-hold / this.fade, 0), 1) : 0;
    } else if (hold <= stop.holdSeconds) {
      pose.yaw = stop.yaw + stop.swivel * TourTimeline.smooth(stop.holdSeconds > 0 ? hold / stop.holdSeconds : 1);
    } else {
      pose.yaw = stop.yaw + stop.swivel;
      pose.black = this.fade > 0 ? Math.min(Math.max((hold - stop.holdSeconds) / this.fade, 0), 1) : 0;
    }
    return pose;
  }

  /** Round K: the tour player's pose (the same as evaluate). */
  pose(time: number): TourPose {
    return this.evaluate(time);
  }

  /** Smoothstep: eases in and out over 0..1 (clamped). */
  static smooth(u: number): number {
    u = Math.min(Math.max(u, 0), 1);
    return u * u * (3 - 2 * u);
  }

  /** Interpolates two angles the short way round (radians). */
  static lerpAngle(from: number, to: number, t: number): number {
    const tau = Math.PI * 2;
    let delta = (to - from) % tau;
    if (delta > Math.PI) { delta -= tau; } else if (delta < -Math.PI) { delta += tau; }
    return from + delta * t;
  }
}
