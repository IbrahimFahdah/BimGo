/** One lightning strike (Round W-C). */
export interface LightningStrike {
  /** The strike's number (its time window); unique and increasing. */
  readonly index: number;
  /** When it starts (s on the weather clock). */
  readonly start: number;
  /** Where in the sky (radians: azimuth from the scene's X axis towards Y; elevation above the horizon). */
  readonly azimuth: number;
  readonly elevation: number;
  /** 0 = close (bright, big, thunder soon and loud) – 1 = far. */
  readonly distance: number;
  /** Flickers in the strike (1–3) and the time between them (s, never under MIN_PULSE_GAP). */
  readonly pulses: number;
  readonly pulseGap: number;
  /** A visible bolt (else lightning inside the cloud only). */
  readonly bolt: boolean;
  /** The bolt's shape (0–1). */
  readonly seed: number;
}

/** Thunder: seconds after the strike's start. */
export function thunderDelay(s: LightningStrike): number { return 0.8 + s.distance * 5.5; }

/** Thunder: how loud (0–1). */
export function thunderGain(s: LightningStrike): number { return 1 - 0.7 * s.distance; }

const M64 = (1n << 64n) - 1n;

function hash(x: bigint): bigint {
  x = (x + 0x9E3779B97F4A7C15n) & M64;
  x = ((x ^ (x >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
  x = ((x ^ (x >> 27n)) * 0x94D049BB133111EBn) & M64;
  return x ^ (x >> 31n);
}

function frac(x: number): number { return x - Math.floor(x); }

function smoothStep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Round W-C: when and where lightning strikes, worked out from the weather clock alone (so a video frame or a photo
 * gets the same storm as the walk), and how bright it is at any moment (port of LightningStorm).
 *
 * Photosensitive-safety limits, always on: at most three flashes in any second (WCAG 2.3.1): a strike flickers at most
 * three times, at least a third of a second apart, and strikes are at least MIN_STRIKE_GAP apart; every flicker rises
 * and falls smoothly (no hard on / off). With reduceFlashing a strike is one slow glow instead.
 */
export class LightningStorm {
  /** Frequencies: rare, sometimes, often. */
  static readonly RARE = 0;
  static readonly SOMETIMES = 1;
  static readonly OFTEN = 2;
  /** The time window per frequency (s): at most one strike in each. */
  private static readonly WINDOW = [40.0, 18.0, 8.0];
  /** The chance of a strike in a window, per frequency. */
  private static readonly CHANCE = [0.7, 0.8, 0.85];
  /** Shortest time between a strike's flickers (s): three flashes a second at most. */
  static readonly MIN_PULSE_GAP = Math.fround(0.36);
  /** Shortest time between strikes (s). */
  static readonly MIN_STRIKE_GAP = 4.0;
  /** How long a strike's light lasts at most (s): normal, and as a slow glow. */
  static readonly FLASH_LENGTH = 2.2;
  static readonly GLOW_LENGTH = 3.0;
  private static readonly RISE = 0.06;
  private static readonly FALL = 0.16;
  private static readonly GLOW_RISE = 0.6;
  private static readonly GLOW_FALL = 1.6;

  /** Strikes already worked out, by window and frequency (the hash is 64-bit BigInt maths: not per frame). */
  private static readonly cache = new Map<number, LightningStrike | null>();

  /** The strike in a time window, if any. */
  static tryGetStrike(window: number, frequency: number): LightningStrike | null {
    frequency = Math.min(Math.max(Math.trunc(frequency), LightningStorm.RARE), LightningStorm.OFTEN);
    const key = window * 3 + frequency;
    const cached = LightningStorm.cache.get(key);
    if (cached !== undefined) { return cached; }
    const strike = LightningStorm.compute(window, frequency);
    if (LightningStorm.cache.size > 64) { LightningStorm.cache.clear(); }
    LightningStorm.cache.set(key, strike);
    return strike;
  }

  private static compute(window: number, frequency: number): LightningStrike | null {
    let h = hash((BigInt(window) * 3n + BigInt(frequency)) & M64);
    const unit = () => {
      h = hash(h);
      return Number(h >> 11n) * (1.0 / 2 ** 53);
    };
    if (unit() >= LightningStorm.CHANCE[frequency]) { return null; }
    const length = LightningStorm.WINDOW[frequency];
    // Starts early enough in its window that the next window's strike is at least MIN_STRIKE_GAP later
    const start = window * length + unit() * (length - LightningStorm.MIN_STRIKE_GAP - LightningStorm.FLASH_LENGTH);
    const distance = Math.fround(unit());
    const pulses = 1 + Math.trunc(unit() * 3.0);
    const pulseGap = Math.fround(LightningStorm.MIN_PULSE_GAP + Math.fround(unit()) * 0.25);
    const azimuth = Math.fround(unit() * Math.PI * 2.0);
    const elevation = Math.fround((8.0 + unit() * 26.0) * Math.PI / 180.0);
    const bolt = unit() < 0.75 - 0.4 * distance;
    const seed = Math.fround(unit());
    return { index: window, start, azimuth, elevation, distance, pulses: Math.min(Math.max(pulses, 1), 3), pulseGap, bolt, seed };
  }

  /**
   * The strike lighting the sky at time (the latest one still glowing), and how bright it is (0–1), or null when none.
   */
  static evaluate(time: number, frequency: number, reduceFlashing: boolean): { strike: LightningStrike; brightness: number } | null {
    frequency = Math.min(Math.max(Math.trunc(frequency), LightningStorm.RARE), LightningStorm.OFTEN);
    const window = Math.floor(time / LightningStorm.WINDOW[frequency]);
    for (let w = window; w >= window - 1; w--) {
      const s = LightningStorm.tryGetStrike(w, frequency);
      if (!s || time < s.start) { continue; }
      const b = LightningStorm.brightness(s, time - s.start, reduceFlashing);
      if (b > 0) { return { strike: s, brightness: b }; }
    }
    return null;
  }

  /**
   * A strike's brightness t seconds after it starts (0–1): its flickers, each a smooth rise and fall, the first the
   * strongest; or one slow glow.
   */
  static brightness(strike: LightningStrike, t: number, reduceFlashing: boolean): number {
    if (t < 0) { return 0; }
    if (reduceFlashing) {
      if (t >= LightningStorm.GLOW_LENGTH) { return 0; }
      const up = smoothStep(0, LightningStorm.GLOW_RISE, t);
      const down = t <= LightningStorm.GLOW_RISE ? 1 : 1 - smoothStep(LightningStorm.GLOW_RISE, LightningStorm.GLOW_RISE + LightningStorm.GLOW_FALL, t);
      return 0.6 * up * down;
    }
    if (t >= LightningStorm.FLASH_LENGTH) { return 0; }
    let sum = 0;
    for (let i = 0; i < strike.pulses; i++) {
      const local = t - i * strike.pulseGap;
      if (local < 0) { break; }
      const amplitude = i === 0 ? 1 : 0.55 + 0.3 * frac(strike.seed * (7.3 + i * 3.1));
      const rise = smoothStep(0, LightningStorm.RISE, local);
      const fall = local <= LightningStorm.RISE ? 1 : Math.exp(-(local - LightningStorm.RISE) / LightningStorm.FALL);
      sum = Math.max(sum, amplitude * rise * fall);
    }
    // The tail fades to nothing by the end (no step)
    const tail = 1 - smoothStep(LightningStorm.FLASH_LENGTH - 0.4, LightningStorm.FLASH_LENGTH, t);
    return Math.min(Math.max(sum * tail, 0), 1);
  }
}
