import { mulberry32 } from './audio';

const SAMPLE_RATE = 22050;
const TAU = Math.PI * 2;

/** The rain loop's length (s) and the cross-fade that makes it seamless. */
const RAIN_SECONDS = 4, RAIN_FADE = 0.5;
/** Thunder variants, their length (s), and how many can sound at once. */
const THUNDERS = 3, ACTIVE_THUNDERS = 3, THUNDER_SECONDS = 7;
/** The muffling under a roof: the low-pass's cut-off (Hz) in the open and covered (the desktop's one-pole 1 → 0.12). */
const OPEN_CUTOFF = 11000, COVERED_CUTOFF = 450;

/**
 * Round W-C: the weather's sound (port of BimGo.App/Audio/WeatherSound.cs): the rain's looping hiss and thunder
 * rumbles, synthesised the first time they're needed (no sound files) and played through Web Audio: rain and thunder
 * into one low-pass (the muffling under a roof) and the master gain. The game loop calls update every frame; level and
 * muffling glide (setTargetAtTime), so nothing restarts. The desktop streams its own waveOut buffers instead.
 */
export class WeatherSound {
  private started = false;
  private failed = false;
  private rainBuffer: AudioBuffer | null = null;
  private thunderBuffers: AudioBuffer[] = [];
  private rainSource: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private master: GainNode | null = null;
  private readonly thunders: { source: AudioBufferSourceNode; gain: number }[] = [];
  private nextVariant = 0;
  private rainTarget = -1;
  private muffleTarget = -1;
  private volumeTarget = -1;

  /** Master volume (0–1), as the other sounds. */
  volume = 0.35;

  constructor(private readonly context: () => AudioContext | null) {}

  /**
   * Per frame: sets the rain's level and the muffling. Builds the graph the first time there is something to hear.
   * @param rain The rain's loudness (0 = none, 1 = a downpour).
   * @param covered Under a roof: quieter and muffled.
   */
  update(rain: number, covered: boolean): void {
    const target = Math.min(Math.max(rain, 0), 1) * (covered ? 0.45 : 1);
    if (!this.started) {
      if (this.failed || target <= 0) { return; }
      this.start();
      if (!this.started) { return; }
    }
    const context = this.context();
    if (!context || !this.rainGain || !this.filter || !this.master) { return; }
    const now = context.currentTime;
    if (target !== this.rainTarget) {
      this.rainTarget = target;
      this.rainGain.gain.setTargetAtTime(target, now, 0.35);
    }
    const muffle = covered ? COVERED_CUTOFF : OPEN_CUTOFF;
    if (muffle !== this.muffleTarget) {
      this.muffleTarget = muffle;
      this.filter.frequency.setTargetAtTime(muffle, now, 0.3);
    }
    const volume = Math.min(Math.max(this.volume, 0), 1) * 1.9;
    if (volume !== this.volumeTarget) {
      this.volumeTarget = volume;
      this.master.gain.setTargetAtTime(volume, now, 0.05);
    }
  }

  /**
   * Queues a thunder rumble delay seconds from now (the next variant; the quietest one is stopped when all are busy).
   * @param gain 0–1 (near and loud – far and soft).
   * @param covered Under a roof: quieter.
   */
  thunder(delay: number, gain: number, covered: boolean): void {
    if (this.failed) { return; }
    if (!this.started) { this.start(); }
    const context = this.context();
    if (!this.started || !context || !this.filter || context.state !== 'running') { return; }
    if (this.thunders.length >= ACTIVE_THUNDERS) {
      let quietest = 0;
      for (let i = 1; i < this.thunders.length; i++) { if (this.thunders[i].gain < this.thunders[quietest].gain) { quietest = i; } }
      try { this.thunders[quietest].source.stop(); } catch { /* already ended */ }
      this.thunders.splice(quietest, 1);
    }
    const level = Math.min(Math.max(gain, 0), 1) * (covered ? 0.6 : 1);
    const source = context.createBufferSource();
    source.buffer = this.thunderBuffers[this.nextVariant];
    this.nextVariant = (this.nextVariant + 1) % THUNDERS;
    const node = context.createGain();
    node.gain.value = level;
    source.connect(node);
    node.connect(this.filter);
    const entry = { source, gain: level };
    this.thunders.push(entry);
    source.onended = () => {
      const i = this.thunders.indexOf(entry);
      if (i >= 0) { this.thunders.splice(i, 1); }
      node.disconnect();
    };
    source.start(context.currentTime + Math.max(delay, 0));
  }

  private start(): void {
    const context = this.context();
    if (!context) { return; } // audio off (or not yet created): try again later
    try {
      this.rainBuffer = toBuffer(context, synthesiseRain());
      for (let t = 0; t < THUNDERS; t++) { this.thunderBuffers.push(toBuffer(context, synthesiseThunder(t))); }
      this.master = context.createGain();
      this.master.gain.value = 0;
      this.master.connect(context.destination);
      this.filter = context.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.Q.value = 0.5;
      this.filter.frequency.value = OPEN_CUTOFF;
      this.filter.connect(this.master);
      this.rainGain = context.createGain();
      this.rainGain.gain.value = 0;
      this.rainGain.connect(this.filter);
      this.rainSource = context.createBufferSource();
      this.rainSource.buffer = this.rainBuffer;
      this.rainSource.loop = true;
      this.rainSource.connect(this.rainGain);
      this.rainSource.start();
      this.started = true;
    } catch (e) {
      console.info(`Weather sound disabled: ${e instanceof Error ? e.message : String(e)}`);
      this.failed = true;
    }
  }

  /** Stops playback and frees everything. */
  dispose(): void {
    try { this.rainSource?.stop(); } catch { /* not started */ }
    for (const t of this.thunders) { try { t.source.stop(); } catch { /* ended */ } }
    this.thunders.length = 0;
    this.master?.disconnect();
    this.rainSource = null;
    this.rainGain = this.master = null;
    this.filter = null;
    this.started = false;
  }
}

function toBuffer(context: AudioContext, pcm: Float32Array<ArrayBuffer>): AudioBuffer {
  const buffer = context.createBuffer(1, pcm.length, SAMPLE_RATE);
  buffer.copyToChannel(pcm, 0);
  return buffer;
}

/**
 * The rain: a soft wash (low-passed noise), a brighter hiss, and scattered drop ticks; the end cross-fades into the start
 * so it loops without a seam. Peak about ±0.5.
 */
function synthesiseRain(): Float32Array<ArrayBuffer> {
  const loop = Math.trunc(RAIN_SECONDS * SAMPLE_RATE), fade = Math.trunc(RAIN_FADE * SAMPLE_RATE);
  const raw = new Float32Array(loop + fade);
  const random = mulberry32(4242);
  let wash = 0, hissLow = 0, tick = 0, tickPhase = 0;
  for (let i = 0; i < raw.length; i++) {
    const white = random() * 2 - 1;
    wash += (white - wash) * 0.05;
    hissLow += (white - hissLow) * 0.5;
    const hiss = white - hissLow; // high-passed
    if (random() < 0.0035) {
      tick = 0.25 + 0.35 * random();
      tickPhase = 0;
    }
    tickPhase += TAU * 2600 / SAMPLE_RATE;
    const drop = tick * Math.sin(tickPhase);
    tick *= 0.993;
    raw[i] = wash * 1.1 + hiss * 0.18 + drop * 0.18;
  }
  const rain = new Float32Array(loop);
  for (let i = 0; i < loop; i++) {
    let v = raw[i];
    if (i < fade) {
      const t = i / fade;
      v = raw[i] * t + raw[loop + i] * (1 - t);
    }
    rain[i] = v;
  }
  normalise(rain, 0.5);
  return rain;
}

/**
 * A thunder rumble: a short crack (stronger in the first variant: a near strike), then deep rolling rumbles (low-passed
 * noise under a slow random swell) dying away over a few seconds. Peak about ±0.8.
 */
function synthesiseThunder(variant: number): Float32Array<ArrayBuffer> {
  const count = Math.trunc(THUNDER_SECONDS * SAMPLE_RATE);
  const pcm = new Float32Array(count);
  const random = mulberry32(777 + variant * 31);
  let deep = 0, low = 0, crack = 0, swell = 0, swellTarget = 0.6;
  const crackStrength = variant === 0 ? 0.8 : variant === 1 ? 0.35 : 0.12;
  for (let i = 0; i < count; i++) {
    const t = i / SAMPLE_RATE;
    const white = random() * 2 - 1;
    deep += (white - deep) * 0.015; // ~50 Hz and below: the roll
    low += (white - low) * 0.06;    // ~200 Hz: the body
    crack += (white - crack) * 0.35;
    if (i % 2205 === 0) { swellTarget = 0.35 + 0.65 * random(); }
    swell += (swellTarget - swell) * 0.0004;
    const attack = Math.min(1, t / 0.05);
    const body = attack * Math.exp(-t / (1.6 + 0.4 * variant)) * swell;
    const snap = crackStrength * Math.exp(-t / 0.18) * Math.min(1, t / 0.01);
    const release = Math.min(1, (THUNDER_SECONDS - t) / 0.5);
    pcm[i] = ((deep * 3 + low) * body + crack * snap) * release;
  }
  normalise(pcm, 0.8);
  return pcm;
}

/** Scales a sound so its loudest sample is peak. */
function normalise(pcm: Float32Array, peak: number): void {
  let max = 1e-6;
  for (let i = 0; i < pcm.length; i++) { max = Math.max(max, Math.abs(pcm[i])); }
  const scale = peak / max;
  for (let i = 0; i < pcm.length; i++) { pcm[i] *= scale; }
}
