import { clampSunTime, cleanLocation, type LocationOverride, readSunSettings, type SunSettings, type SunTime, sunDefaultsFor } from '../core/format/DocumentModels';
import { type Vec3, vec3 } from '../core/math/Vector';
import type { SiteInfo } from '../core/scene/ModelInfo';
import { TimeZones } from '../core/scene/Places';
import { type GeoLocation, isLocationValid, SolarPosition } from '../core/scene/SolarPosition';
import { createSunLighting, NO_SUN, type SunLighting } from '../engine/render/SunLighting';

export const TIME_STEP = 5;           // minutes per slider / [ ] step
const PLAY_SPEED = 60;                // clock minutes per real second while playing
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The sun of a walkthrough: settings (from the file's sun.json, else the site's start), location, direction and the
 * day-cycle player (port of the state half of BimGo.App/Game/GameSession.Sun.cs and the effective-site half of
 * GameSession.Location.cs; the panel is in SunPanel.ts).
 */
export class SunState {
  settings: SunSettings;
  /** The site the sun, shadows and studies use: the model's, or a copy with the location override. */
  site: SiteInfo;
  location!: GeoLocation;
  locationKnown = false;
  private readonly northAngle: number;
  direction: Vec3 = vec3(0, 0, 1);
  /** Degrees. */
  altitude = 0;
  /** Degrees clockwise from true north. */
  azimuth = 0;
  playing = false;
  playMinutes = 0;
  revision = 0;
  placeLabel = '';
  /** The model's own location ("Sydney · UTC+10"), for the location picker. */
  modelPlaceLabel = '';
  /** The override's UTC offset ("UTC+10", "UTC+5:30 (manual)"), or null without an override. */
  offsetLabel: string | null = null;

  constructor(private readonly modelSite: SiteInfo, saved: SunSettings | null) {
    this.northAngle = SolarPosition.northAngle(modelSite);
    this.settings = saved ? readSunSettings({ ...saved, time: { ...saved.time }, location: saved.location ? { ...saved.location } : null }) : sunDefaultsFor(modelSite);
    this.site = modelSite;
    this.refreshLocation();
  }

  get enabled(): boolean { return this.settings.enabled; }

  /** True when a BimGo location replaces the model's. */
  get hasOverride(): boolean { return this.settings.location !== null; }

  /** Rebuilds the effective site, the location and the labels from the model and the override, then the sun. */
  refreshLocation(): void {
    this.site = SolarPosition.effectiveSite(this.modelSite, this.settings.location);
    const { location, known } = SolarPosition.locationOf(this.site);
    this.location = location;
    this.locationKnown = known;

    const model = SolarPosition.locationOf(this.modelSite);
    this.modelPlaceLabel = model.known ? `${model.location.name} · UTC${formatZone(model.location.timeZone)}` : 'none in this file (Sydney assumed)';
    const override = this.settings.location;
    this.offsetLabel = override ? `UTC${formatZone(location.timeZone)}${override.zoneId === null ? ' (manual)' : ''}` : null;
    if (override) {
      this.placeLabel = `${location.name} · UTC${formatZone(location.timeZone)}${location.autoDaylightSaving ? ' · DST auto' : ''} (set in BimGo)`;
    } else {
      this.placeLabel = known ? `${location.name} · UTC${formatZone(location.timeZone)}` : 'No site location in this file: Sydney is assumed (CHANGE… picks one)';
    }
    this.recompute();
  }

  /**
   * Sets (or with null clears) the override and records it for saving. Revit is never changed; true north stays the
   * model's.
   */
  setLocation(location: LocationOverride | null): void {
    this.settings.location = location && isLocationValid(cleanLocation(location)) ? location : null;
    this.playing = false;
    this.changed();
    this.refreshLocation();
  }

  /** − / + on the override's UTC offset (half hours): the offset becomes manual (no zone, the DST tick decides). */
  stepOffset(direction: number): void {
    const current = this.settings.location;
    if (!current) { return; }
    const location = { ...current };
    location.timeZone = Math.min(Math.max(Math.round((location.timeZone + direction * 0.5) * 2) / 2, -12), 14);
    if (location.autoDaylightSaving) { this.settings.time.daylightSaving = this.daylightSavingNow; }
    location.zoneId = null;
    location.autoDaylightSaving = false;
    this.settings.location = cleanLocation(location);
    this.changed();
    this.refreshLocation();
  }

  /** The sun panel's DST control when the location decides daylight saving: switch to (or back from) the manual tick. */
  setAutoDaylightSaving(auto: boolean): void {
    const current = this.settings.location;
    if (!current || current.zoneId === null) { return; }
    if (!auto) { this.settings.time.daylightSaving = this.daylightSavingNow; }
    this.settings.location = { ...current, autoDaylightSaving: auto && TimeZones.isKnown(current.zoneId) };
    this.changed();
    this.refreshLocation();
  }

  /** True when the override has a zone the browser knows (the manual tick can go back to AUTO). */
  get canAutoDaylightSaving(): boolean {
    const zone = this.settings.location?.zoneId;
    return !!zone && TimeZones.isKnown(zone);
  }

  /** The effective daylight saving for the panel's date (the zone's when automatic, else the tick). */
  get daylightSavingNow(): boolean {
    const t = this.settings.time;
    return SolarPosition.isDaylightSaving(this.location, new Date().getFullYear(), t.month, t.day, t.daylightSaving);
  }

  recompute(): void {
    const t = this.settings.time;
    const minutes = this.playing ? this.playMinutes : t.minutes;
    const { altitude, azimuth } = SolarPosition.compute(this.location, new Date().getFullYear(), t.month, t.day, minutes, t.daylightSaving);
    this.altitude = altitude * 180 / Math.PI;
    this.azimuth = azimuth * 180 / Math.PI;
    this.direction = SolarPosition.toModel(SolarPosition.direction(altitude, azimuth), this.northAngle);
  }

  /** After any edit: clamp, bump the revision and recompute. */
  changed(): void {
    const s = this.settings;
    s.time = clampSunTime(s.time, new Date().getFullYear());
    const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : 1);
    s.sunIntensity = clamp(s.sunIntensity, 0, 2);
    s.skyIntensity = clamp(s.skyIntensity, 0, 2);
    s.shadowIntensity = clamp(s.shadowIntensity, 0, 1);
    s.glassTransmission = clamp(s.glassTransmission, 0, 2);
    this.revision++;
    this.recompute();
  }

  /** The sun time and shadows on / off, without recording a change (the tour). */
  setQuiet(time: SunTime, shadows: boolean): void {
    this.playing = false;
    this.settings.time = { ...time };
    this.settings.enabled = shadows;
    this.recompute();
  }

  toggle(): void {
    this.settings.enabled = !this.settings.enabled;
    if (!this.settings.enabled) { this.playing = false; }
    this.changed();
  }

  stepTime(minutes: number): void {
    if (this.playing) {
      this.playing = false;
      this.settings.time.minutes = Math.min(Math.max(Math.round(this.playMinutes), 0), 1439);
    }
    this.settings.time.minutes = ((this.settings.time.minutes + minutes) % 1440 + 1440) % 1440;
    this.changed();
  }

  togglePlay(): void {
    if (!this.settings.enabled) { return; }
    if (this.playing) {
      // Stop on the nearest minute and keep it
      this.playing = false;
      this.settings.time.minutes = Math.min(Math.max(Math.round(this.playMinutes), 0), 1439);
      this.changed();
    } else {
      this.playing = true;
      this.playMinutes = this.settings.time.minutes;
    }
  }

  applyTime(time: SunTime): void {
    this.playing = false;
    this.settings.time = { ...time };
    this.settings.enabled = true;
    this.changed();
  }

  /** The time to store with a bookmark (null while shadows are off). */
  bookmarkTime(): SunTime | null {
    if (!this.settings.enabled) { return null; }
    const time = { ...this.settings.time };
    if (this.playing) { time.minutes = Math.min(Math.max(Math.trunc(this.playMinutes), 0), 1439); }
    return time;
  }

  update(dt: number): void {
    if (this.playing && this.settings.enabled) {
      this.playMinutes += dt * PLAY_SPEED;
      if (this.playMinutes >= 1440) { this.playMinutes -= 1440; }
      this.recompute();
    }
  }

  lighting(): SunLighting {
    const s = this.settings;
    return s.enabled ? createSunLighting(this.direction, s.sunIntensity, s.skyIntensity, s.shadowIntensity, s.glassTransmission) : NO_SUN;
  }

  describeTime(): string {
    const t = this.settings.time;
    return `${t.day} ${MONTHS[Math.min(Math.max(t.month, 1), 12) - 1]} ${two(Math.trunc(t.minutes / 60))}:${two(t.minutes % 60)}${this.daylightSavingNow ? ' DST' : ''}`;
  }

  heightText(): string {
    if (this.altitude <= 0) { return 'below the horizon'; }
    return `${Math.round(this.altitude)}° high in the ${COMPASS[Math.round((((this.azimuth % 360) + 360) % 360) / 45) % 8]}`;
  }

  info(): string {
    const alt = Math.round(this.altitude), az = Math.round(this.azimuth) % 360;
    if (alt <= 0) { return `SUN BELOW THE HORIZON (${alt}°) · SKY LIGHT ONLY`; }
    return `SUN ${alt}° HIGH · BEARING ${az}° (${COMPASS[Math.round(az / 45) % 8]}, TRUE NORTH)`;
  }
}

export function two(n: number): string {
  return Math.min(Math.max(Math.trunc(n), 0), 99).toString().padStart(2, '0');
}

/** "+10", "−3:30". */
export function formatZone(hours: number): string {
  const sign = hours < 0 ? '−' : '+';
  const abs = Math.abs(hours);
  const h = Math.trunc(abs), m = Math.round((abs - h) * 60);
  return m === 0 ? `${sign}${h}` : `${sign}${h}:${two(m)}`;
}
