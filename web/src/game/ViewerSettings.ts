import { BcfCoordinates } from '../core/format/Bcf';
import { clamp } from '../core/math/Vector';
import { CoordinateReadout } from '../core/scene/SiteCoordinates';
import { UnitSystem } from '../core/scene/Units';
import { ShadowQuality } from '../engine/render/ShadowMaps';
import { LightMode } from './Lights';
import { readJson, writeJson } from '../platform/settings';

/** The player's eye-height preset (port of EyePreset). */
export enum EyePreset {
  /** A standing adult (the default, 1.62 m). */
  Standing = 0,
  /** Seated, or a wheelchair user (1.20 m). */
  Seated = 1,
  /** A child (1.10 m). */
  Child = 2
}

/** The walkthrough video's frame size (port of VideoSize). */
export enum VideoSize {
  /** The window's size (rounded down to even numbers). */
  Window = 0,
  /** 1920 × 1080 (the default). */
  FullHd = 1,
  /** 3840 × 2160. */
  Uhd4K = 2
}

/** Eye-height defaults and limits (m). */
export const EyeHeights = {
  DEFAULT_STANDING: 1.62,
  DEFAULT_SEATED: 1.2,
  DEFAULT_CHILD: 1.1,
  MIN: 0.9,
  MAX: 2.0,
  /** A height clamped and rounded to the centimetre, or the fallback when not a number. */
  clean(metres: unknown, fallback: number): number {
    return typeof metres === 'number' && Number.isFinite(metres) ? Math.round(clamp(metres, EyeHeights.MIN, EyeHeights.MAX) * 100) / 100 : fallback;
  }
};

/** Colour mode (port of ColourMode). */
export enum ColourMode {
  Whitecard = 0,
  Material = 1,
  Realistic = 2
}

/**
 * The walkthrough settings the web viewer keeps per browser (the subset of LaunchSettings that matters in the
 * viewer; defaults as on the desktop).
 */
export class ViewerSettings {
  colour = ColourMode.Whitecard;
  fieldOfView = 90;
  mouseSensitivity = 1;
  invertY = false;
  showFps = true;
  maxStepHeightMm = 200;
  coordinateReadout = CoordinateReadout.Off;
  /** Author shown on comments and bookmarks (the browser has no user name). */
  userName = 'Web user';
  shadowQuality = ShadowQuality.Medium;
  ambientOcclusion = true;
  lightMode = LightMode.Lights;
  lightIntensity = 1;
  bloomIntensity = 1;
  /** Realistic: Revit's tint (multiply) on. */
  revitTint = true;
  /** Realistic: reflections on glass, mirrors, shiny surfaces and water. */
  reflections = true;
  /** Lowest reflection tier that reflects (%): 50 = shiny things only ("Some"), 25 = also satin surfaces ("All"). */
  reflectionThreshold = 50;
  /** Reflection strength multiplier (0.5–2). */
  reflectionStrength = 1;
  /** Reflections read reflection probes (captures of the rooms around reflective surfaces); false = the sky only. */
  reflectionProbes = true;
  /** Probe face size in px: 128 (default) or 256 ("Probes HQ"). */
  probeResolution = 128;
  /** Realistic: CC0 proxies for missing images. */
  proxyMissing = true;
  /** Realistic: proxies take the material's colour. */
  proxyMaterialColour = true;
  /** The coordinates BCF viewpoints are written in and read with. */
  bcfCoordinates = BcfCoordinates.Shared;
  /** Section box cap colour, "#RRGGBB" (default dark grey). */
  sectionCapColour = '#3D4045';
  /** Units for lengths and areas on screen (review tools round). */
  displayUnits = UnitSystem.Metric;
  /** Imperial lengths as decimal feet (5.33') instead of feet-inches to 1/8" (5' 4"). */
  decimalFeet = false;
  /** The eye-height preset in use (tour round; the pause menu changes it). */
  eyePreset = EyePreset.Standing;
  eyeHeightStanding = EyeHeights.DEFAULT_STANDING;
  eyeHeightSeated = EyeHeights.DEFAULT_SEATED;
  eyeHeightChild = EyeHeights.DEFAULT_CHILD;
  /** Walkthrough video frame size. */
  videoSize = VideoSize.FullHd;
  /** Walkthrough video frames per second: 30 or 60. */
  videoFps = 30;

  /** The eye height of a preset (m). */
  eyeHeightFor(preset: EyePreset): number {
    return preset === EyePreset.Seated ? this.eyeHeightSeated : preset === EyePreset.Child ? this.eyeHeightChild : this.eyeHeightStanding;
  }

  /** Sets a preset's eye height (clamped, rounded to the centimetre). */
  setEyeHeight(preset: EyePreset, metres: number): void {
    const value = EyeHeights.clean(metres, this.eyeHeightFor(preset));
    if (preset === EyePreset.Seated) { this.eyeHeightSeated = value; }
    else if (preset === EyePreset.Child) { this.eyeHeightChild = value; }
    else { this.eyeHeightStanding = value; }
  }

  get whitecard(): boolean {
    return this.colour === ColourMode.Whitecard;
  }

  static load(): ViewerSettings {
    const s = new ViewerSettings();
    const raw = readJson<Record<string, unknown>>('viewer', {});
    if (typeof raw.colour === 'number' && raw.colour >= 0 && raw.colour <= 2) { s.colour = raw.colour; }
    else if (raw.whitecard === false) { s.colour = ColourMode.Material; }
    if (typeof raw.fieldOfView === 'number') { s.fieldOfView = clamp(raw.fieldOfView, 60, 120); }
    if (typeof raw.mouseSensitivity === 'number') { s.mouseSensitivity = clamp(raw.mouseSensitivity, 0.1, 3); }
    if (typeof raw.invertY === 'boolean') { s.invertY = raw.invertY; }
    if (typeof raw.showFps === 'boolean') { s.showFps = raw.showFps; }
    if (typeof raw.coordinateReadout === 'number' && raw.coordinateReadout >= 0 && raw.coordinateReadout <= 3) {
      s.coordinateReadout = raw.coordinateReadout;
    }
    if (typeof raw.userName === 'string' && raw.userName.trim()) { s.userName = raw.userName.trim().slice(0, 40); }
    if (typeof raw.shadowQuality === 'number' && raw.shadowQuality >= 0 && raw.shadowQuality <= 2) { s.shadowQuality = raw.shadowQuality; }
    if (typeof raw.ambientOcclusion === 'boolean') { s.ambientOcclusion = raw.ambientOcclusion; }
    if (typeof raw.lightMode === 'number' && raw.lightMode >= 0 && raw.lightMode <= 2) { s.lightMode = raw.lightMode; }
    if (typeof raw.lightIntensity === 'number') { s.lightIntensity = clamp(raw.lightIntensity, 0, 2); }
    if (typeof raw.bloomIntensity === 'number') { s.bloomIntensity = clamp(raw.bloomIntensity, 0, 2); }
    for (const key of ['revitTint', 'reflections', 'reflectionProbes', 'proxyMissing', 'proxyMaterialColour'] as const) {
      if (typeof raw[key] === 'boolean') { s[key] = raw[key] as boolean; }
    }
    if (typeof raw.reflectionThreshold === 'number') { s.reflectionThreshold = raw.reflectionThreshold <= 37 ? 25 : 50; }
    if (typeof raw.reflectionStrength === 'number' && Number.isFinite(raw.reflectionStrength)) { s.reflectionStrength = clamp(raw.reflectionStrength, 0.5, 2); }
    if (typeof raw.probeResolution === 'number') { s.probeResolution = raw.probeResolution >= 192 ? 256 : 128; }
    if (typeof raw.bcfCoordinates === 'number' && [0, 1, 2].includes(raw.bcfCoordinates)) { s.bcfCoordinates = raw.bcfCoordinates; }
    if (typeof raw.sectionCapColour === 'string' && /^#?[0-9a-fA-F]{6}$/.test(raw.sectionCapColour.trim())) { s.sectionCapColour = raw.sectionCapColour.trim(); }
    if (raw.displayUnits === UnitSystem.Imperial) { s.displayUnits = UnitSystem.Imperial; }
    if (typeof raw.decimalFeet === 'boolean') { s.decimalFeet = raw.decimalFeet; }
    if (typeof raw.eyePreset === 'number' && [0, 1, 2].includes(raw.eyePreset)) { s.eyePreset = raw.eyePreset; }
    s.eyeHeightStanding = EyeHeights.clean(raw.eyeHeightStanding, EyeHeights.DEFAULT_STANDING);
    s.eyeHeightSeated = EyeHeights.clean(raw.eyeHeightSeated, EyeHeights.DEFAULT_SEATED);
    s.eyeHeightChild = EyeHeights.clean(raw.eyeHeightChild, EyeHeights.DEFAULT_CHILD);
    if (typeof raw.videoSize === 'number' && [0, 1, 2].includes(raw.videoSize)) { s.videoSize = raw.videoSize; }
    if (typeof raw.videoFps === 'number') { s.videoFps = raw.videoFps >= 45 ? 60 : 30; }
    return s;
  }

  save(): void {
    writeJson('viewer', {
      colour: this.colour,
      fieldOfView: this.fieldOfView,
      mouseSensitivity: this.mouseSensitivity,
      invertY: this.invertY,
      showFps: this.showFps,
      coordinateReadout: this.coordinateReadout,
      userName: this.userName,
      shadowQuality: this.shadowQuality,
      ambientOcclusion: this.ambientOcclusion,
      lightMode: this.lightMode,
      lightIntensity: this.lightIntensity,
      bloomIntensity: this.bloomIntensity,
      revitTint: this.revitTint,
      reflections: this.reflections,
      reflectionThreshold: this.reflectionThreshold,
      reflectionStrength: this.reflectionStrength,
      reflectionProbes: this.reflectionProbes,
      probeResolution: this.probeResolution,
      proxyMissing: this.proxyMissing,
      proxyMaterialColour: this.proxyMaterialColour,
      bcfCoordinates: this.bcfCoordinates,
      sectionCapColour: this.sectionCapColour,
      displayUnits: this.displayUnits,
      decimalFeet: this.decimalFeet,
      eyePreset: this.eyePreset,
      eyeHeightStanding: this.eyeHeightStanding,
      eyeHeightSeated: this.eyeHeightSeated,
      eyeHeightChild: this.eyeHeightChild,
      videoSize: this.videoSize,
      videoFps: this.videoFps
    });
  }
}
