import { clampSunTime, readSunSettings, type SunSettings, type SunTime, sunDefaultsFor } from '../core/format/DocumentModels';
import { type Vec3, vec3 } from '../core/math/Vector';
import type { SiteInfo } from '../core/scene/ModelInfo';
import { type GeoLocation, SolarPosition } from '../core/scene/SolarPosition';
import { createSunLighting, NO_SUN, type SunLighting } from '../engine/render/SunLighting';

export const TIME_STEP = 5;           // minutes per slider / [ ] step
const PLAY_SPEED = 60;                // clock minutes per real second while playing
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The sun of a walkthrough: settings (from the file's sun.json, else the site's start), location, direction and the
 * day-cycle player (port of the state half of BimGo.App/Game/GameSession.Sun.cs; the panel is in SunPanel.ts).
 */
export class SunState {
  settings: SunSettings;
  readonly location: GeoLocation;
  readonly locationKnown: boolean;
  private readonly northAngle: number;
  direction: Vec3 = vec3(0, 0, 1);
  /** Degrees. */
  altitude = 0;
  /** Degrees clockwise from true north. */
  azimuth = 0;
  playing = false;
  playMinutes = 0;
  revision = 0;
  readonly placeLabel: string;

  constructor(site: SiteInfo, saved: SunSettings | null) {
    const { location, known } = SolarPosition.locationOf(site);
    this.location = location;
    this.locationKnown = known;
    this.northAngle = SolarPosition.northAngle(site);
    this.settings = saved ? readSunSettings({ ...saved, time: { ...saved.time } }) : sunDefaultsFor(site);
    this.placeLabel = known
      ? `${location.name} · UTC${formatZone(location.timeZone)}`
      : 'No site location in this file: Sydney is assumed (export again from Revit to use the model\'s location)';
    this.recompute();
  }

  get enabled(): boolean { return this.settings.enabled; }

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
    return `${t.day} ${MONTHS[Math.min(Math.max(t.month, 1), 12) - 1]} ${two(Math.trunc(t.minutes / 60))}:${two(t.minutes % 60)}${t.daylightSaving ? ' DST' : ''}`;
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

function formatZone(hours: number): string {
  const sign = hours < 0 ? '−' : '+';
  const abs = Math.abs(hours);
  const h = Math.trunc(abs), m = Math.round((abs - h) * 60);
  return m === 0 ? `${sign}${h}` : `${sign}${h}:${two(m)}`;
}
