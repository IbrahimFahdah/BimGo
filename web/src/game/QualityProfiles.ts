import { ShadowQuality } from '../engine/render/ShadowMaps';
import { LightMode } from './Lights';
import { ColourMode, type ViewerSettings } from './ViewerSettings';

/** A quick choice of display quality (port of QualityProfile). Any manual change makes it Custom. */
export enum QualityProfile {
  Custom = 0,
  Basic = 1,
  Medium = 2,
  Realistic = 3
}

/** The values a profile governs (the ViewerSettings subset; the browser has no MSAA, so anti-aliasing isn't one). */
export type ProfileValues = Pick<ViewerSettings,
  'colour' | 'ambientOcclusion' | 'shadowQuality' | 'lightMode' | 'bloomIntensity' | 'reflections' | 'reflectionThreshold' | 'reflectionProbes' | 'probeResolution'>;

/**
 * The values each profile sets, applied to and recognised from the viewer settings (port of QualityProfiles.cs; same
 * values as the desktop and the Revit Options window, less anti-aliasing). Shadows on / off is a per-model choice and
 * is left alone; only their quality changes. Probes HQ is never part of a profile.
 */
export const QualityProfiles = {
  /** The profiles a user can pick (Custom is only ever shown). */
  PICKABLE: [QualityProfile.Basic, QualityProfile.Medium, QualityProfile.Realistic] as const,
  LABELS: ['Basic', 'Medium', 'Realistic'],
  /** Probe resolution the Realistic profile uses (HQ, 256, stays a manual choice). */
  PROBE_RESOLUTION: 128,

  apply(s: ProfileValues, profile: QualityProfile): void {
    switch (profile) {
      case QualityProfile.Basic:
        Object.assign(s, {
          colour: ColourMode.Whitecard, ambientOcclusion: true, shadowQuality: ShadowQuality.Low, lightMode: LightMode.Off,
          bloomIntensity: 0, reflections: false // threshold and probe choices are kept for when they come back on
        });
        break;
      case QualityProfile.Medium:
        Object.assign(s, {
          colour: ColourMode.Material, ambientOcclusion: true, shadowQuality: ShadowQuality.Medium, lightMode: LightMode.Lights,
          bloomIntensity: 1, reflections: true, reflectionThreshold: 50, reflectionProbes: false
        });
        break;
      case QualityProfile.Realistic:
        Object.assign(s, {
          colour: ColourMode.Realistic, ambientOcclusion: true, shadowQuality: ShadowQuality.High, lightMode: LightMode.Lights,
          bloomIntensity: 1, reflections: true, reflectionThreshold: 25, reflectionProbes: true, probeResolution: QualityProfiles.PROBE_RESOLUTION
        });
        break;
    }
  },

  /** True if every value the profile governs is as the profile sets it. */
  matches(s: ProfileValues, profile: QualityProfile): boolean {
    const bloomOn = s.bloomIntensity > 0.999 && s.bloomIntensity < 1.001;
    const bloomOff = s.bloomIntensity < 0.001;
    if (!s.ambientOcclusion) { return false; }
    switch (profile) {
      case QualityProfile.Basic:
        return s.colour === ColourMode.Whitecard && s.shadowQuality === ShadowQuality.Low && s.lightMode === LightMode.Off && bloomOff && !s.reflections;
      case QualityProfile.Medium:
        return s.colour === ColourMode.Material && s.shadowQuality === ShadowQuality.Medium && s.lightMode === LightMode.Lights && bloomOn
          && s.reflections && s.reflectionThreshold > 37 && !s.reflectionProbes;
      case QualityProfile.Realistic:
        return s.colour === ColourMode.Realistic && s.shadowQuality === ShadowQuality.High && s.lightMode === LightMode.Lights && bloomOn
          && s.reflections && s.reflectionThreshold <= 37 && s.reflectionProbes && s.probeResolution < 192;
      default:
        return false;
    }
  },

  /** The profile the settings match, else Custom. */
  detect(s: ProfileValues): QualityProfile {
    for (const profile of QualityProfiles.PICKABLE) {
      if (QualityProfiles.matches(s, profile)) { return profile; }
    }
    return QualityProfile.Custom;
  }
};
