import type { Matrix4x4 } from '../core/math/Matrix4x4';
import { type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import { CoverMap } from '../core/scene/CoverMap';
import { LightningStorm, thunderDelay, thunderGain } from '../core/scene/LightningStorm';
import { noWeather, SceneRenderer, type SceneDrawParams } from '../engine/render/SceneRenderer';
import { type SunLighting, withLightning } from '../engine/render/SunLighting';
import { TextBuffer } from '../engine/ui/TextBuffer';
import { WeatherSound } from '../platform/weatherSound';
import type { GameSession } from './GameSession';
import { CLOUD_WIND_X, CLOUD_WIND_Y } from './SunState';
import { UnitFormat } from './UnitFormat';

/** A changed scene waits this long (s) before the cover map is rebuilt (the grass field's settle rule). */
const COVER_SETTLE = 0.75;
/** The wind (m/s) at cloud drift 100 %: the rain slants with it, the snow drifts at under half. */
const WEATHER_WIND = 2.5;

const yieldToPage = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** One drop (or flake) on the lens (Round W-C). */
interface LensDrop {
  x: number; y: number;
  radius: number; age: number; life: number; slide: number; slideAfter: number; seed: number; trail: number;
  flake: boolean;
}

/**
 * Round W-B: rain and snow (port of GameSession.Weather.cs; the WEATHER tab is in SunPanel.ts). The cover map (what
 * keeps the weather off, seen from above) is built in slices on the main thread the first time rain or snow is turned
 * on, and again a moment after the shown model changes (the desktop uses a worker); until it is ready the weather shows
 * everywhere. Rain and snow show in the classic light too; with shadows on the clouds thicken and the light dims.
 *
 * Round W-C: lightning while it rains (photosensitive limits in LightningStorm), drops and melting flakes on the lens
 * outdoors (main view only), and the rain's sound (WeatherSound).
 */
export class Weather {
  private map: CoverMap | null = null;
  private task: Promise<CoverMap> | null = null;
  private taskDone = false;
  private taskResult: CoverMap | null = null;
  private taskFailed: unknown = null;
  private abort: AbortController | null = null;
  private builtScene = -1;
  private taskScene = -1;
  private seenScene = -1;
  private sceneChangedAt = -1;
  /** Why the cover map is missing (shown in the WEATHER tab), or null. */
  error: string | null = null;

  /** The weather's own clock (s): video frames take theirs from the frame number. */
  private clock = 0;

  // W-C: the sound, the eye under a roof, this frame's flash, the last strike whose thunder was queued
  readonly sound: WeatherSound;
  private eyeCovered = false;
  private flashAmount = 0;
  private heardStrike = Number.MIN_SAFE_INTEGER;
  /** The frame's lighting without a lightning flash (the reflection probes are keyed on it). */
  probeLighting: SunLighting | null = null;

  // W-C: drops on the lens (fixed pool), what the shader gets, the spawn accumulator
  private readonly drops: LensDrop[] = [];
  private readonly dropData = new Float32Array(SceneRenderer.MAX_LENS_DROPS * 4);
  private readonly dropShapes = new Float32Array(SceneRenderer.MAX_LENS_DROPS * 4);
  private spawn = 0;
  private random = seeded(97);

  private readonly text = new TextBuffer();
  private statusKey = '';
  private statusText = '';

  constructor(private readonly session: GameSession) {
    this.sound = new WeatherSound(() => session.sound.audioContext);
  }

  /** True when it rains or snows. */
  get on(): boolean { return this.session.sun?.weatherOn ?? false; }

  /** Round W-C: lightning shows (it's raining and lightning is ticked). */
  private get lightningOn(): boolean {
    const s = this.session.sun?.settings;
    return !!s && s.weather === 'rain' && s.lightning;
  }

  /** The cover map (null until built). */
  get coverMap(): CoverMap | null { return this.map; }

  /** Fog thickens in the rain or snow (the main pass's density × this). */
  get fog(): number {
    const s = this.session.sun?.settings;
    return s && this.on ? 1 + (s.weather === 'snow' ? 3 : 2) * s.weatherIntensity : 1;
  }

  /** Advances the weather clock, the rain's sound and the lens drops (every frame). */
  advance(dt: number): void {
    this.clock += dt;
    if (this.clock > 3600) { this.clock -= 3600; }
    const s = this.session.sun?.settings;
    const rain = s && s.weather === 'rain' && s.weatherSound ? 0.35 + 0.65 * s.weatherIntensity : 0;
    this.sound.volume = this.session.sound.volume;
    this.sound.update(rain, this.eyeCovered);
    this.simulateLensDrops(dt);
  }

  /** Before the 3D passes: builds / uploads the cover map when needed and hands the renderer this frame's weather. */
  update(): void {
    const session = this.session, renderer = session.renderer, sun = session.sun;
    if (!renderer || !sun) { return; }
    this.updateCoverMap();

    this.flashAmount = 0;
    const sky = renderer.sky;
    sky.lightning = [0, 0, 0, 0];
    sky.bolt = [0, 0, 0, 0];
    if (!this.on) {
      renderer.weather = noWeather();
      this.eyeCovered = false;
      return;
    }
    const s = sun.settings, snow = s.weather === 'snow';
    const time = session.video.frameTime ?? this.clock;
    this.eyeCovered = this.map !== null && this.map.isCovered(session.camera.position, 0.3);
    this.evaluateLightning(time);
    const wind = WEATHER_WIND * s.cloudSpeed;
    renderer.weather = {
      kind: snow ? 2 : 1,
      intensity: s.weatherIntensity,
      wet: snow ? 0 : s.wetness,
      snow: snow ? s.snowCover : 0,
      windX: -CLOUD_WIND_X * wind, // with the clouds' drift
      windY: -CLOUD_WIND_Y * wind,
      time,
      groundZ: session.groundZ
    };
  }

  /**
   * The cover map: a finished build is uploaded; a new one starts when the weather is on and the map is missing or the
   * shown model changed (once it has settled: a drag is one change).
   */
  private updateCoverMap(): void {
    const session = this.session;
    if (this.task !== null && this.taskDone) {
      const result = this.taskResult, failed = this.taskFailed;
      this.task = null;
      this.abort = null;
      if (failed !== null) {
        this.error = 'The roofs could not be mapped: rain and snow show indoors too (see the console).';
        console.warn('Cover map failed:', failed);
        session.toast(this.error, 5, true);
      } else if (result) {
        this.map = result;
        this.builtScene = this.taskScene;
        this.error = session.renderer.setCoverMap(result);
        if (this.error) { session.toast(this.error, 6, true); }
      }
    }

    if (!this.on || this.error !== null) { return; }
    const sceneKey = session.sceneKey;
    if (sceneKey !== this.seenScene) {
      this.seenScene = sceneKey;
      this.sceneChangedAt = session.clock;
    }
    const settled = this.sceneChangedAt < 0 || (session.clock - this.sceneChangedAt > COVER_SETTLE && !session.activeGunCapturesInput);
    if (this.map !== null && (sceneKey === this.builtScene || !settled)) { return; }
    if (this.task !== null) {
      if (settled && this.taskScene !== sceneKey) { this.abort?.abort(); }
      return;
    }

    // Start a build (visibility and copies are snapshots)
    const visible = session.grassVisibility();
    const instances = session.dynamics.instances.filter(i => session.dynamics.isActive(i)).map(i => ({ element: i.element, model: i.model as Matrix4x4 }));
    const abort = new AbortController();
    this.abort = abort;
    this.taskScene = sceneKey;
    this.sceneChangedAt = -1;
    this.taskDone = false;
    this.taskResult = null;
    this.taskFailed = null;
    this.task = CoverMap.build(session.scene, visible, instances, yieldToPage, abort.signal);
    this.task.then(map => { this.taskResult = abort.signal.aborted ? null : map; this.taskDone = true; },
      e => { this.taskFailed = e ?? 'failed'; this.taskDone = true; });
  }

  /**
   * Round W-C: the strike lighting the sky now (zone, bolt), the scene flash, and (live frames) the thunder queued the
   * first time a strike shows. The storm is worked out from the clock, so videos get the same lightning.
   */
  private evaluateLightning(time: number): void {
    if (!this.lightningOn) { return; }
    const session = this.session, s = session.sun.settings;
    const hit = LightningStorm.evaluate(time, s.lightningFrequency, s.reduceFlashing);
    if (!hit) { return; }
    const { strike, brightness } = hit;
    const near = 1 - strike.distance;
    const cosElevation = Math.cos(strike.elevation);
    const sky = session.renderer.sky;
    sky.lightning = [cosElevation * Math.cos(strike.azimuth), cosElevation * Math.sin(strike.azimuth), Math.sin(strike.elevation),
      brightness * (0.55 + 0.45 * near)];
    sky.bolt = [strike.seed, strike.bolt ? 1 : 0, 0.16 + 0.16 * near, 0];
    this.flashAmount = brightness * s.lightningFlash * (0.4 + 0.6 * near);

    if (!session.video.active && strike.index !== this.heardStrike) {
      this.heardStrike = strike.index;
      if (s.weatherSound) { this.sound.thunder(thunderDelay(strike), thunderGain(strike), this.eyeCovered); }
    }
  }

  /** The frame's lighting: the sun's (with the weather), and a lightning flash lifting the sky light. */
  frameLighting(): SunLighting {
    const lighting = this.session.sun.lighting();
    this.probeLighting = lighting;
    return withLightning(lighting, this.flashAmount);
  }

  /** Round W-C: a flash in the classic light (a capped brightening of the frame). */
  drawLightningFlash(): void {
    if (this.flashAmount > 0 && !this.session.sun.enabled) { this.session.renderer.applyFlash(this.flashAmount * 0.3); }
  }

  /** Draws the falling rain or snow (main view, photos and video frames: after the glass). */
  draw(p: SceneDrawParams): void {
    if (!this.on) { return; }
    const camera = this.session.camera;
    const right = camera.right;
    let up: Vec3 = V.cross(right, camera.forward);
    up = V.lengthSquared(up) > 1e-6 ? V.normalize(up) : vec3(0, 0, 1);
    this.session.renderer.drawPrecipitation(p, right, up);
  }

  /**
   * Round W-C: ages, slides and melts the drops on the lens, and lets new ones land: outdoors only, more when looking
   * up, none in photo mode.
   */
  private simulateLensDrops(dt: number): void {
    const drops = this.drops;
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      d.age += dt;
      if (d.age >= d.life || d.y < -0.1) {
        drops[i] = drops[drops.length - 1];
        drops.pop();
        i--;
        continue;
      }
      const melted = !d.flake || d.age > d.life * 0.55;
      if (melted && d.slide > 0 && d.age > d.slideAfter) {
        d.y -= d.slide * dt;
        d.trail = Math.min(d.trail + d.slide * dt / Math.max(d.radius, 1e-3) * 0.6, 2.5);
      }
    }

    const session = this.session, s = session.sun?.settings;
    if (!s || !this.on || !s.lensDrops || this.eyeCovered || session.photo.open || session.paused) {
      this.spawn = 0;
      return;
    }
    const look = Math.min(Math.max(0.15 + 1.8 * (session.camera.forward.z + 0.1), 0.03), 2.5);
    const snowing = s.weather === 'snow';
    const rate = (snowing ? 0.12 + 0.6 * s.weatherIntensity : 0.2 + 1.3 * s.weatherIntensity) * look;
    this.spawn += rate * dt;
    const r = this.random;
    while (this.spawn >= 1) {
      this.spawn -= 1;
      if (drops.length >= SceneRenderer.MAX_LENS_DROPS) { break; }
      const flake = snowing;
      drops.push({
        x: 0.04 + 0.92 * r(), y: 0.1 + 0.86 * r(),
        radius: flake ? 0.012 + 0.01 * r() : 0.01 + 0.02 * r(),
        age: 0,
        life: flake ? 3 + 2 * r() : 2.5 + 3.5 * r(),
        slide: r() < (flake ? 0.25 : 0.45) ? 0.02 + 0.06 * r() : 0,
        slideAfter: 0.4 + 1.6 * r(),
        seed: r(),
        trail: 0,
        flake
      });
    }
  }

  /** Round W-C: draws the drops on the lens over the main view (the caller leaves out photos, videos and captures). */
  drawLensDrops(width: number, height: number): void {
    const drops = this.drops;
    if (drops.length === 0) { return; }
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      const alpha = 0.85 * Math.min(1, d.age / 0.12) * Math.min(Math.max((d.life - d.age) / 0.8, 0), 1);
      const melt = d.flake ? Math.min(Math.max(d.age / (d.life * 0.55), 0), 1) : 1;
      const k = i * 4;
      this.dropData[k] = d.x; this.dropData[k + 1] = d.y; this.dropData[k + 2] = d.radius; this.dropData[k + 3] = alpha;
      this.dropShapes[k] = d.seed; this.dropShapes[k + 1] = d.flake ? 1 : 0; this.dropShapes[k + 2] = melt; this.dropShapes[k + 3] = d.trail;
    }
    this.session.renderer.drawLensDrops(width, height, this.dropData, this.dropShapes, drops.length);
  }

  /** The WEATHER tab's status line (where the cover map is up to), made again only when what it says changes. */
  status(): string {
    const s = this.session.sun.settings;
    const key = `${this.error}|${this.task !== null}|${this.map?.coveredCells ?? -1}|${s.weather}|${UnitFormat.revision}`;
    if (key === this.statusKey) { return this.statusText; }
    this.statusKey = key;
    this.statusText = this.makeStatus();
    return this.statusText;
  }

  private makeStatus(): string {
    if (this.error) { return this.error; }
    const what = this.session.sun.settings.weather === 'snow' ? 'Snow' : 'Rain';
    const map = this.map;
    if (!map || this.task !== null) { return 'Mapping the roofs and canopies…'; }
    if (map.isEmpty) { return `${what} falls everywhere (nothing in the model covers anything).`; }
    const area = map.coveredCells * map.cell * map.cell;
    const cell = UnitFormat.appendLength(this.text.clear(), map.cell, 1).text;
    return `${what} stops at roofs and canopies (${Math.round(area).toLocaleString('en')} m² mapped, ${cell} cells).`;
  }

  /** Stops the sound and any build. */
  dispose(): void {
    this.abort?.abort();
    this.sound.dispose();
  }
}

/** A small seeded generator for the lens drops (the desktop's Random(97); the exact sequence differs). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
