import { describe, expect, it } from 'vitest';
import { readSunSettings, sunStartFor } from '../src/core/format/DocumentModels';
import { vec3 } from '../src/core/math/Vector';
import type { SiteInfo } from '../src/core/scene/ModelInfo';
import { FALLBACK_LOCATION, type GeoLocation, SolarPosition } from '../src/core/scene/SolarPosition';
import { createSunLighting } from '../src/engine/render/SunLighting';

// Ported from tests/BimGo.Core.Tests/SolarPositionTests.cs (same expected values and tolerances)
const DEG = Math.PI / 180;
const SYDNEY: GeoLocation = { latitude: -33.8688, longitude: 151.2093, timeZone: 10, name: 'Sydney' };
const LONDON: GeoLocation = { latitude: 51.5074, longitude: -0.1278, timeZone: 0, name: 'London' };
const ADELAIDE: GeoLocation = { latitude: -34.9285, longitude: 138.6007, timeZone: 9.5, name: 'Adelaide' };

function assertSun(where: GeoLocation, month: number, day: number, minutes: number, dst: boolean,
  altitude: number, azimuth: number, altitudeTolerance: number, azimuthTolerance: number): void {
  const sun = SolarPosition.compute(where, 2026, month, day, minutes, dst);
  expect(Math.abs(sun.altitude / DEG - altitude)).toBeLessThanOrEqual(altitudeTolerance);
  expect(Math.abs(sun.azimuth / DEG - azimuth)).toBeLessThanOrEqual(azimuthTolerance);
}

function site(extra: Partial<SiteInfo>): SiteInfo {
  return {
    trueNorthAngle: 0, projectBasePoint: null, surveyPoint: null, hasSharedTransform: false, sharedEast: 0, sharedNorth: 0,
    sharedElevation: 0, sharedAngle: 0, hasLocation: false, latitude: 0, longitude: 0, timeZone: 0, placeName: '', sunStart: '', ...extra
  };
}

describe('SolarPosition', () => {
  it('Sydney summer solstice noon', () => assertSun(SYDNEY, 12, 21, 12 * 60, false, 79.45, 351.2, 0.2, 0.5));
  it('London summer solstice noon', () => assertSun(LONDON, 6, 21, 12 * 60, false, 61.92, 178.9, 0.2, 0.6));
  it('Adelaide equinox afternoon', () => assertSun(ADELAIDE, 3, 20, 15 * 60, false, 39.55, 304.9, 0.4, 0.5));
  it('Adelaide summer afternoon with daylight saving', () => assertSun(ADELAIDE, 1, 15, 15 * 60, true, 64.98, 297.2, 0.2, 0.6));

  it('daylight saving is the same sun an hour earlier', () => {
    const a = SolarPosition.compute(ADELAIDE, 2026, 1, 15, 15 * 60, true);
    const b = SolarPosition.compute(ADELAIDE, 2026, 1, 15, 14 * 60, false);
    expect(a.altitude).toBeCloseTo(b.altitude, 3);
    expect(a.azimuth).toBeCloseTo(b.azimuth, 3);
  });

  it('puts the sun below the horizon at midnight and clamps bad input', () => {
    expect(SolarPosition.compute(SYDNEY, 2026, 6, 21, 0, false).altitude).toBeLessThan(0);
    const odd = SolarPosition.compute(SYDNEY, 2026, 2, 31, 5000, false);
    expect(Number.isFinite(odd.altitude) && Number.isFinite(odd.azimuth)).toBe(true);
  });

  it('gives unit east-north-up directions', () => {
    const east = SolarPosition.direction(0, 90 * DEG);
    expect(east.x).toBeCloseTo(1, 5);
    expect(east.y).toBeCloseTo(0, 5);
    expect(SolarPosition.direction(0, 0).y).toBeCloseTo(1, 5);
    const high = SolarPosition.direction(60 * DEG, 200 * DEG);
    expect(Math.hypot(high.x, high.y, high.z)).toBeCloseTo(1, 5);
    expect(high.z).toBeCloseTo(Math.sin(60 * DEG), 5);
  });

  it('rotates true north into the model by minus the north angle', () => {
    const model = SolarPosition.toModel(vec3(0, 1, 0), Math.PI / 2);
    expect(model.x).toBeCloseTo(1, 5);
    expect(model.y).toBeCloseTo(0, 5);
  });

  it('uses the site location when known, else Sydney', () => {
    const known = SolarPosition.locationOf(site({ hasLocation: true, latitude: -34.9285, longitude: 138.6007, timeZone: 9.5, placeName: ' Adelaide ' }));
    expect(known.known).toBe(true);
    expect(known.location.name).toBe('Adelaide');
    expect(known.location.timeZone).toBe(9.5);
    expect(SolarPosition.locationOf(null)).toEqual({ location: FALLBACK_LOCATION, known: false });
    expect(SolarPosition.locationOf(site({ hasLocation: true, latitude: 120 })).known).toBe(false);
  });

  it('reads the site sun start and cleans sun settings', () => {
    const start = sunStartFor(site({ sunStart: '2026-03-20T15:30' }));
    expect([start.month, start.day, start.minutes]).toEqual([3, 20, 15 * 60 + 30]);
    const sun = readSunSettings({ enabled: true, time: { month: 14, day: 40, minutes: -5 }, sunIntensity: 9, shadowIntensity: 'NaN', glassTransmission: -1 });
    expect(sun.time.month).toBe(12);
    expect(sun.time.day).toBe(31);
    expect(sun.time.minutes).toBe(0);
    expect(sun.sunIntensity).toBe(2);
    expect(sun.shadowIntensity).toBe(1);
    expect(sun.glassTransmission).toBe(0);
  });
});

describe('SunLighting', () => {
  it('is bright and white at noon, dark and without direct sun at night', () => {
    const noon = createSunLighting(vec3(0, 0.5, Math.sqrt(0.75)), 1, 1, 1, 1);
    expect(noon.altitudeDegrees).toBeCloseTo(60, 3);
    expect(noon.sunColour.x).toBeCloseTo(0.62, 2);
    const night = createSunLighting(vec3(0, 0.9, -Math.sqrt(0.19)), 1, 1, 1, 1);
    expect(night.sunColour.x).toBe(0);
    expect(night.skyColour.x).toBeGreaterThan(0);
  });
});
