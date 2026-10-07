/**
 * The synthesised sound effects (port of BimGo.App/Audio/SoundSystem.cs): the same recipes rendered once into Web
 * Audio buffers. Browsers start audio suspended until a user gesture, so the context is resumed on the first click
 * or key press; sounds requested before that are skipped.
 */

export enum SoundId {
  ScanLock,
  Click,
  PortalBlue,
  PortalRed,
  Teleport,
  CommentPlace,
  Remove,
  Error,
  UiClick,
  Blink,
  Prime,
  Demolish,
  Grab,
  Commit,
  Count
}

const SAMPLE_RATE = 22050;
const TAU = Math.PI * 2;

export class SoundSystem {
  private context: AudioContext | null = null;
  private buffers: AudioBuffer[] = [];
  private playing = 0;

  /** Linear volume (0 = muted). */
  volume = 0.35;

  /** Creates the context and renders every sound; resumes on the first gesture. */
  initialise(): void {
    try {
      this.context = new AudioContext();
      for (let s = 0; s < SoundId.Count; s++) {
        const pcm = synthesise(s, this.volume);
        const buffer = this.context.createBuffer(1, pcm.length, SAMPLE_RATE);
        buffer.copyToChannel(pcm, 0);
        this.buffers.push(buffer);
      }
      const resume = () => { void this.context?.resume(); };
      window.addEventListener('pointerdown', resume, { capture: true });
      window.addEventListener('keydown', resume, { capture: true });
    } catch (e) {
      console.info(`Audio disabled: ${e instanceof Error ? e.message : String(e)}`);
      this.context = null;
    }
  }

  play(sound: SoundId): void {
    const context = this.context;
    if (!context || context.state !== 'running' || this.volume <= 0 || this.playing >= 4) { return; }
    const source = context.createBufferSource();
    source.buffer = this.buffers[sound];
    source.connect(context.destination);
    this.playing++;
    source.onended = () => { this.playing--; };
    source.start();
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
  }
}

/** Renders one effect (same recipes and envelopes as the desktop; noise from a seeded generator). */
function synthesise(sound: SoundId, volume: number): Float32Array<ArrayBuffer> {
  const random = mulberry32(1234 + sound);
  const duration = DURATIONS[sound] ?? 0.02;
  const count = Math.trunc(duration * SAMPLE_RATE);
  const pcm = new Float32Array(count);
  let phase = 0, phase2 = 0, lowpass = 0;

  for (let i = 0; i < count; i++) {
    const t = i / SAMPLE_RATE;
    const u = t / duration;
    const attack = Math.min(1, t / 0.004);
    const release = Math.min(1, (duration - t) / 0.02);
    const env = attack * Math.max(release, 0);
    let sample: number;

    switch (sound) {
      case SoundId.ScanLock:
        phase += TAU * (u < 0.45 ? 880 : 1320) / SAMPLE_RATE;
        sample = Math.sin(phase) * 0.6;
        break;
      case SoundId.Click:
        phase += TAU * 1600 / SAMPLE_RATE;
        sample = Math.sin(phase) * (1 - u) * 0.7;
        break;
      case SoundId.PortalBlue:
      case SoundId.PortalRed: {
        const f0 = sound === SoundId.PortalBlue ? 320 : 900;
        const f1 = sound === SoundId.PortalBlue ? 900 : 320;
        const f = f0 + (f1 - f0) * u + Math.sin(t * 60) * 25;
        phase += TAU * f / SAMPLE_RATE;
        phase2 += TAU * f * 1.5 / SAMPLE_RATE;
        sample = (Math.sin(phase) * 0.45 + Math.sin(phase2) * 0.2) * (1 - u * 0.6);
        break;
      }
      case SoundId.Teleport: {
        const noise = random() * 2 - 1;
        const cutoff = 0.05 + 0.45 * Math.sin(Math.PI * u);
        lowpass += (noise - lowpass) * cutoff;
        phase += TAU * (200 + 500 * u) / SAMPLE_RATE;
        sample = lowpass * 0.7 + Math.sin(phase) * 0.2;
        break;
      }
      case SoundId.CommentPlace:
        phase += TAU * (u < 0.4 ? 660 : 990) / SAMPLE_RATE;
        sample = Math.sin(phase) * 0.5 * (1 - u * 0.5);
        break;
      case SoundId.Remove:
        phase += TAU * (440 - 220 * u) / SAMPLE_RATE;
        sample = Math.sin(phase) * 0.5;
        break;
      case SoundId.Error:
        phase += TAU * 140 / SAMPLE_RATE;
        sample = Math.sign(Math.sin(phase)) * 0.25;
        break;
      case SoundId.Blink: {
        const noise = random() * 2 - 1;
        lowpass += (noise - lowpass) * (0.08 + 0.5 * u);
        phase += TAU * (300 + 1400 * u * u) / SAMPLE_RATE;
        sample = lowpass * 0.45 * (1 - u) + Math.sin(phase) * 0.3;
        break;
      }
      case SoundId.Prime:
        phase += TAU * (u < 0.5 ? 520 : 390) / SAMPLE_RATE;
        sample = Math.sign(Math.sin(phase)) * 0.18 + Math.sin(phase) * 0.2;
        break;
      case SoundId.Demolish: {
        const noise = random() * 2 - 1;
        lowpass += (noise - lowpass) * 0.12;
        phase += TAU * (90 - 50 * u) / SAMPLE_RATE;
        sample = (Math.sin(phase) * 0.7 + lowpass * 0.8) * Math.exp(-5 * u);
        break;
      }
      case SoundId.Grab:
        phase += TAU * (600 + 300 * u) / SAMPLE_RATE;
        sample = Math.sin(phase) * 0.45 * (1 - u);
        break;
      case SoundId.Commit:
        phase += TAU * (u < 0.35 ? 740 : 1110) / SAMPLE_RATE;
        phase2 += TAU * (u < 0.35 ? 1480 : 2220) / SAMPLE_RATE;
        sample = (Math.sin(phase) * 0.45 + Math.sin(phase2) * 0.12) * (1 - u * 0.4);
        break;
      default:
        phase += TAU * 1000 / SAMPLE_RATE;
        sample = Math.sin(phase) * 0.3;
        break;
    }
    pcm[i] = Math.max(-1, Math.min(1, sample * env * volume));
  }
  return pcm;
}

const DURATIONS: Record<number, number> = {
  [SoundId.ScanLock]: 0.09,
  [SoundId.Click]: 0.035,
  [SoundId.PortalBlue]: 0.28,
  [SoundId.PortalRed]: 0.28,
  [SoundId.Teleport]: 0.42,
  [SoundId.CommentPlace]: 0.24,
  [SoundId.Remove]: 0.12,
  [SoundId.Error]: 0.14,
  [SoundId.Blink]: 0.22,
  [SoundId.Prime]: 0.16,
  [SoundId.Demolish]: 0.45,
  [SoundId.Grab]: 0.12,
  [SoundId.Commit]: 0.2
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
