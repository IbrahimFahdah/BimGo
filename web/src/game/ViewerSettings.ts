import { BcfCoordinates } from '../core/format/Bcf';
import { clamp } from '../core/math/Vector';
import { CoordinateReadout } from '../core/scene/SiteCoordinates';
import { ShadowQuality } from '../engine/render/ShadowMaps';
import { LightMode } from './Lights';
import { readJson, writeJson } from '../platform/settings';

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
      sectionCapColour: this.sectionCapColour
    });
  }
}
