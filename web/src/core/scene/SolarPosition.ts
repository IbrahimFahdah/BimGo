import { f32, type Vec3, vec3 } from '../math/Vector';
import type { SiteInfo } from './ModelInfo';
import { SiteCoordinates } from './SiteCoordinates';

/** Where the sun is computed for (port of GeoLocation). */
export interface GeoLocation {
  latitude: number;
  longitude: number;
  /** Hours from UTC (standard time). */
  timeZone: number;
  name: string;
}

export const FALLBACK_LOCATION: GeoLocation = Object.freeze({ latitude: -33.8688, longitude: 151.2093, timeZone: 10, name: 'Sydney (assumed)' });

const DEG = Math.PI / 180;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayOfYear(year: number, month: number, day: number): number {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86400000) + 1;
}

/**
 * The sun's altitude and azimuth from NOAA's declination and equation-of-time series (port of
 * BimGo.Core/Scene/SolarPosition.cs).
 */
export const SolarPosition = {
  /**
   * Sun position for a local clock time.
   * @returns altitude (radians above the horizon) and azimuth (radians clockwise from true north, 0..2π).
   */
  compute(location: GeoLocation, year: number, month: number, day: number, minutes: number, daylightSaving: boolean): { altitude: number; azimuth: number } {
    year = Math.min(Math.max(Math.trunc(year), 1), 9999);
    month = Math.min(Math.max(Math.trunc(month), 1), 12);
    day = Math.min(Math.max(Math.trunc(day), 1), daysInMonth(year, month));
    minutes = Math.min(Math.max(minutes, 0), 1440);

    const n = dayOfYear(year, month, day);
    const daysInYear = isLeap(year) ? 366 : 365;
    const hour = minutes / 60;

    // Fractional year (radians)
    const g = 2 * Math.PI / daysInYear * (n - 1 + (hour - 12) / 24);

    // Equation of time (minutes) and declination (radians), NOAA
    const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
      - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
      + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);

    // True solar time (minutes) and hour angle
    const zone = location.timeZone + (daylightSaving ? 1 : 0);
    const trueSolar = minutes + eqTime + 4 * location.longitude - 60 * zone;
    const hourAngle = (trueSolar / 4 - 180) * DEG;

    const lat = location.latitude * DEG;
    const sinAlt = Math.min(Math.max(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle), -1), 1);
    const altitude = Math.asin(sinAlt);

    const cosAlt = Math.cos(altitude), cosLat = Math.cos(lat);
    if (Math.abs(cosAlt) < 1e-9 || Math.abs(cosLat) < 1e-9) { return { altitude, azimuth: 0 }; }

    // Azimuth clockwise from north
    const sinAz = -Math.sin(hourAngle) * Math.cos(decl) / cosAlt;
    const cosAz = (Math.sin(decl) - Math.sin(lat) * sinAlt) / (cosLat * cosAlt);
    let azimuth = Math.atan2(sinAz, cosAz);
    if (azimuth < 0) { azimuth += 2 * Math.PI; }
    return { altitude, azimuth };
  },

  /** Unit vector towards the sun: X east, Y (true) north, Z up. */
  direction(altitude: number, azimuth: number): Vec3 {
    const cosAlt = Math.cos(altitude);
    const x = f32(Math.sin(azimuth) * cosAlt), y = f32(Math.cos(azimuth) * cosAlt), z = f32(Math.sin(altitude));
    const l = Math.hypot(x, y, z);
    return l * l > 1e-12 ? vec3(x / l, y / l, z / l) : vec3(0, 0, 1);
  },

  /** True-north vector → model (internal) coordinates: rotate by minus the internal → shared angle. */
  toModel(trueNorth: Vec3, internalToSharedAngle: number): Vec3 {
    const c = Math.cos(-internalToSharedAngle), s = Math.sin(-internalToSharedAngle);
    return vec3(trueNorth.x * c - trueNorth.y * s, trueNorth.x * s + trueNorth.y * c, trueNorth.z);
  },

  /** The internal → true north angle: the shared transform's, else the site's true-north angle. */
  northAngle(site: SiteInfo | null): number {
    if (!site) { return 0; }
    return SiteCoordinates.tryGetShared(site)?.angle ?? site.trueNorthAngle;
  },

  /** The site's location, or the Sydney fallback (known = false). */
  locationOf(site: SiteInfo | null): { location: GeoLocation; known: boolean } {
    const known = !!site && site.hasLocation && Number.isFinite(site.latitude) && Number.isFinite(site.longitude)
      && Math.abs(site.latitude) <= 90 && Math.abs(site.longitude) <= 180;
    if (!known || !site) { return { location: FALLBACK_LOCATION, known: false }; }
    const name = site.placeName.trim() || `${round3(site.latitude)}°, ${round3(site.longitude)}°`;
    return { location: { latitude: site.latitude, longitude: site.longitude, timeZone: Math.min(Math.max(site.timeZone, -14), 14), name }, known: true };
  }
};

function round3(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}
