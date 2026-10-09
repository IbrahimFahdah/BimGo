import type { SceneDrawParams } from '../engine/render/SceneRenderer';
import { ReflectionProbes } from '../engine/render/ReflectionProbes';
import { SoundId } from '../platform/audio';
import type { GameSession } from './GameSession';
import { QualityProfile, QualityProfiles } from './QualityProfiles';
import { ColourMode } from './ViewerSettings';

/** Seconds without further change before stale probes re-bake (a sun slider drag is one change). */
const PROBE_SETTLE = 1;

/**
 * Reflections and quality profiles for a walkthrough (port of GameSession.Reflections.cs and GameSession.Profiles.cs):
 * the probes' bake and re-bake triggers, the status line, and applying a profile to the viewer settings.
 */
export class Reflections {
  /** Debug colours: 0 off, 1 reflection tiers, 2 probe cells (not saved). */
  debug = 0;
  // Re-bake trigger: what the probes captured, and when it last changed (-1 = settled)
  private probeKey = '';
  private probeKeyChangedAt = -1;
  // Bake timing for the log
  private bakeStartedAt = -1;

  constructor(private readonly session: GameSession) {}

  /** The reflection fields of this frame's scene parameters. */
  drawParams(): Pick<SceneDrawParams, 'reflections' | 'reflectThreshold' | 'reflectGain' | 'reflectDebug' | 'probes' | 'time'> {
    const s = this.session.settings;
    return {
      reflections: s.reflections,
      reflectThreshold: s.reflectionThreshold / 100,
      reflectGain: s.reflectionStrength,
      reflectDebug: this.debug,
      probes: s.reflectionProbes,
      time: this.session.clock
    };
  }

  /**
   * Places and bakes the reflection probes this frame (a couple of faces), and marks them stale a moment after the sun,
   * the lights, the colour mode or the model changed. Probes are only kept while chosen; baked only while shown.
   */
  update(template: SceneDrawParams, sceneKey: string): void {
    const session = this.session, s = session.settings, renderer = session.renderer;
    const wanted = (s.reflections && s.reflectionProbes) || this.debug === 2;
    const shown = wanted && s.colour === ColourMode.Realistic;
    const error = renderer.updateReflectionProbes(wanted, shown, s.probeResolution >= 192 ? 256 : 128, session.camera.position,
      template, session.groupVisible, session.groundZ);
    if (error) {
      s.reflectionProbes = false;
      session.sound.play(SoundId.Error);
      session.toast(error, 6, true);
    }

    const probes = renderer.probes;
    if (!probes.ready) {
      this.probeKey = '';
      this.probeKeyChangedAt = this.bakeStartedAt = -1;
      return;
    }

    // Stale after a change, once things have settled for a moment
    const l = renderer.lighting;
    const key = [sceneKey, l.enabled, l.sunDirection.x, l.sunDirection.y, l.sunDirection.z, l.sunColour.x, l.skyColour.x, l.zenith.x, l.horizon.x,
      l.shadowStrength, l.glass, s.lightMode, s.lightIntensity, s.colour, s.revitTint].join('|');
    if (this.probeKey === '') { this.probeKey = key; }
    else if (key !== this.probeKey) {
      this.probeKey = key;
      this.probeKeyChangedAt = session.clock;
    }
    if (this.probeKeyChangedAt >= 0 && session.clock - this.probeKeyChangedAt > PROBE_SETTLE) {
      this.probeKeyChangedAt = -1;
      renderer.invalidateProbes();
    }

    // Log how long a full (re)bake took
    if (probes.pendingCount > 0 && this.bakeStartedAt < 0) { this.bakeStartedAt = session.clock; }
    else if (probes.pendingCount === 0 && this.bakeStartedAt >= 0) {
      console.info(`Reflection probes: ${probes.count} baked in ${(session.clock - this.bakeStartedAt).toFixed(1)} s ` +
        `(${ReflectionProbes.FACES_PER_FRAME} faces per frame, ${probes.faceSize} px).`);
      this.bakeStartedAt = -1;
    }
  }

  /** The Reflections tab's status line. */
  status(): string {
    const s = this.session.settings, probes = this.session.renderer.probes;
    if (!s.reflections) { return 'Reflections off'; }
    if (!s.reflectionProbes) { return 'Sky only (no probes)'; }
    if (s.colour !== ColourMode.Realistic) { return 'Probes: Realistic mode only'; }
    if (!probes.ready) {
      return probes.lastError ? 'Probes unavailable: sky' : probes.nothingReflective ? 'No reflective surfaces: nothing to bake' : 'Probes: placing…';
    }
    let text = `Probes ${probes.bakedCount} / ${probes.count}`;
    if (probes.pendingCount > 0) { text += ` · baking ${probes.pendingCount}`; }
    return `${text} · ${Math.round(probes.gpuBytes / 1048576)} MB`;
  }

  /** REFRESH re-bakes every probe; switching probes on retries after a failure. */
  refresh(rebake: boolean): void {
    const renderer = this.session.renderer;
    if (rebake) {
      if (renderer.probes.ready) { renderer.invalidateProbes(); }
    } else {
      renderer.retryProbes();
    }
  }

  /**
   * Applies a quality profile (it takes effect this frame and is saved with the settings). Shadows on / off is left
   * alone (a per-model choice); only their quality changes.
   */
  applyProfile(profile: QualityProfile): void {
    const session = this.session, s = session.settings;
    const probesWereOn = s.reflectionProbes;
    QualityProfiles.apply(s, profile);
    s.save();
    session.qualityChosenByUser = true;
    if (s.reflectionProbes && !probesWereOn) { session.renderer.retryProbes(); }
    if (s.colour === ColourMode.Realistic && !session.renderer.hasMaterials) {
      // Realistic is kept; this file shows material colours
      session.toast('Realistic profile: no textures in this file, so material colours show. Export with “Extract materials and textures” ticked.', 5);
      return;
    }
    session.toast(profile === QualityProfile.Basic ? 'Basic: whitecard and AO; lights, bloom and reflections off'
      : profile === QualityProfile.Medium ? 'Medium: material colours, medium shadows, lights, sky reflections'
        : 'Realistic: textures, high shadows, lights, probe reflections', 3);
  }
}
