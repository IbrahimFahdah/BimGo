import type { Matrix4x4 } from '../math/Matrix4x4';
import { type GeoLocation, SolarPosition } from './SolarPosition';

const DEG = Math.PI / 180;

/** An angle in degrees into 0–360. */
function rev(degrees: number): number {
  const r = degrees % 360;
  return r < 0 ? r + 360 : r;
}

const sinD = (degrees: number) => Math.sin(degrees * DEG);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Schlyter's day number (days from 2000 Jan 0.0 UT) for a local clock time, and the universal time in hours. */
function dayNumber(location: GeoLocation, year: number, month: number, day: number, minutes: number, daylightSaving: boolean): { d: number; ut: number } {
  year = clamp(Math.trunc(year), 1, 9999);
  month = clamp(Math.trunc(month), 1, 12);
  day = clamp(Math.trunc(day), 1, daysInMonth(year, month));
  minutes = clamp(minutes, 0, 1440);
  const dst = SolarPosition.isDaylightSaving(location, year, month, day, daylightSaving);
  const zone = location.timeZone + (dst ? 1 : 0);
  const ut = minutes / 60 - zone;
  const days = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1999, 11, 31)) / 86400000);
  return { d: days + ut / 24, ut };
}

/** Local sidereal time (radians) from the sun's mean longitude (degrees), UT hours and east longitude. */
function siderealFromDay(sunMeanLongitude: number, ut: number, longitude: number): number {
  return rev(sunMeanLongitude + 180 + ut * 15 + longitude) * DEG;
}

/** An equatorial unit vector in true-north axes (east, north, up). */
function equatorialToLocal(ex: number, ey: number, ez: number, lst: number, lat: number): [number, number, number] {
  const ra = Math.atan2(ey, ex);
  const dec = Math.asin(clamp(ez, -1, 1));
  const ha = lst - ra;
  return [
    -Math.cos(dec) * Math.sin(ha),
    Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(ha),
    Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha)
  ];
}

/**
 * Round W-A: the moon's place in the sky, its phase, and the frame the stars turn in (port of LunarPosition): Paul
 * Schlyter's low-precision orbital elements with the main perturbations and topocentric parallax. Directions use
 * true-north axes (X east, Y north, Z up); azimuths are clockwise from true north.
 */
export const LunarPosition = {
  /** The moon's altitude and azimuth (radians), lit fraction (0 new – 1 full) and whether it is waxing. */
  compute(location: GeoLocation, year: number, month: number, day: number, minutes: number, daylightSaving: boolean):
    { altitude: number; azimuth: number; illuminated: number; waxing: boolean } {
    const { d, ut } = dayNumber(location, year, month, day, minutes, daylightSaving);
    const ms = rev(356.0470 + 0.9856002585 * d);
    const ws = 282.9404 + 4.70935e-5 * d;
    const ls = rev(ms + ws);
    const sunLongitude = rev(ls + 1.915 * Math.sin(ms * DEG) + 0.020 * Math.sin(2 * ms * DEG));

    const n = rev(125.1228 - 0.0529538083 * d);
    const i = 5.1454;
    const w = rev(318.0634 + 0.1643573223 * d);
    const a = 60.2666, e = 0.054900;
    const m = rev(115.3654 + 13.0649929509 * d);

    let ecc = m * DEG + e * Math.sin(m * DEG) * (1 + e * Math.cos(m * DEG));
    for (let k = 0; k < 5; k++) { ecc -= (ecc - e * Math.sin(ecc) - m * DEG) / (1 - e * Math.cos(ecc)); }
    const xv = a * (Math.cos(ecc) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(ecc);
    const v = Math.atan2(yv, xv) / DEG;
    let r = Math.sqrt(xv * xv + yv * yv);

    const vw = (v + w) * DEG;
    const xh = r * (Math.cos(n * DEG) * Math.cos(vw) - Math.sin(n * DEG) * Math.sin(vw) * Math.cos(i * DEG));
    const yh = r * (Math.sin(n * DEG) * Math.cos(vw) + Math.cos(n * DEG) * Math.sin(vw) * Math.cos(i * DEG));
    const zh = r * Math.sin(vw) * Math.sin(i * DEG);
    let lon = Math.atan2(yh, xh) / DEG;
    let lat = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)) / DEG;

    const lm = rev(m + w + n), dd = rev(lm - ls), f = rev(lm - n);
    lon += -1.274 * sinD(m - 2 * dd) + 0.658 * sinD(2 * dd) - 0.186 * sinD(ms) - 0.059 * sinD(2 * m - 2 * dd) - 0.057 * sinD(m - 2 * dd + ms)
      + 0.053 * sinD(m + 2 * dd) + 0.046 * sinD(2 * dd - ms) + 0.041 * sinD(m - ms) - 0.035 * sinD(dd) - 0.031 * sinD(m + ms)
      - 0.015 * sinD(2 * f - 2 * dd) + 0.011 * sinD(m - 4 * dd);
    lat += -0.173 * sinD(f - 2 * dd) - 0.055 * sinD(m - f - 2 * dd) - 0.046 * sinD(m + f - 2 * dd) + 0.033 * sinD(f + 2 * dd) + 0.017 * sinD(2 * m + f);
    r += -0.58 * Math.cos((m - 2 * dd) * DEG) - 0.46 * Math.cos(2 * dd * DEG);

    const cosElongation = Math.cos(lat * DEG) * Math.cos((lon - sunLongitude) * DEG);
    const illuminated = clamp((1 - cosElongation) * 0.5, 0, 1);
    const waxing = rev(lon - sunLongitude) < 180;

    const obliquity = (23.4393 - 3.563e-7 * d) * DEG;
    const xe = Math.cos(lat * DEG) * Math.cos(lon * DEG);
    const ye = Math.cos(lat * DEG) * Math.sin(lon * DEG) * Math.cos(obliquity) - Math.sin(lat * DEG) * Math.sin(obliquity);
    const ze = Math.cos(lat * DEG) * Math.sin(lon * DEG) * Math.sin(obliquity) + Math.sin(lat * DEG) * Math.cos(obliquity);
    const ra = Math.atan2(ye, xe);
    const dec = Math.atan2(ze, Math.sqrt(xe * xe + ye * ye));

    const lst = siderealFromDay(ls, ut, location.longitude);
    const latR = location.latitude * DEG, ha = lst - ra;
    const east = -Math.cos(dec) * Math.sin(ha);
    const north = Math.cos(latR) * Math.sin(dec) - Math.sin(latR) * Math.cos(dec) * Math.cos(ha);
    const up = Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(ha);
    let altitude = Math.asin(clamp(up, -1, 1));
    let azimuth = Math.atan2(east, north);
    if (azimuth < 0) { azimuth += 2 * Math.PI; }
    altitude -= Math.asin(clamp(1 / Math.max(r, 50), -1, 1)) * Math.cos(altitude);
    return { altitude, azimuth, illuminated, waxing };
  },

  /** The local sidereal time (radians, 0–2π). */
  localSiderealTime(location: GeoLocation, year: number, month: number, day: number, minutes: number, daylightSaving: boolean): number {
    const { d, ut } = dayNumber(location, year, month, day, minutes, daylightSaving);
    const ms = rev(356.0470 + 0.9856002585 * d);
    const ls = rev(ms + 282.9404 + 4.70935e-5 * d);
    return siderealFromDay(ls, ut, location.longitude);
  },

  /**
   * The rotation from equatorial axes (X vernal equinox, Z celestial pole) into true-north axes (X east, Y north, Z up),
   * row-vector convention (as Matrix4x4); its transpose turns a sky direction into equatorial axes.
   */
  equatorialToTrueNorth(localSiderealTime: number, latitude: number, out: Matrix4x4 = new Float32Array(16)): Matrix4x4 {
    const lat = latitude * DEG;
    const x = equatorialToLocal(1, 0, 0, localSiderealTime, lat);
    const y = equatorialToLocal(0, 1, 0, localSiderealTime, lat);
    const z = equatorialToLocal(0, 0, 1, localSiderealTime, lat);
    out.set([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1]);
    return out;
  }
};
