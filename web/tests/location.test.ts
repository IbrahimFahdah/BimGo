import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SidecarJson } from '../src/core/format/BimGoWriter';
import { readSunSettings } from '../src/core/format/DocumentModels';
import type { SiteInfo } from '../src/core/scene/ModelInfo';
import { PlaceIndex, TimeZones } from '../src/core/scene/Places';
import { type GeoLocation, SolarPosition } from '../src/core/scene/SolarPosition';
import { defaultSunHoursSettings, SunHours } from '../src/core/scene/SunHours';

// Port of tests/BimGo.Core.Tests/LocationTests.cs (tour round, build A2): the location override (place search, typed
// coordinates, the effective site, daylight saving from the zone). The browser reads IANA zones through Intl.

const LIST =
  '# comment line\n' +
  'Sydney\tNew South Wales\tAustralia\t-33.9181\t151.1832\tAustralia/Sydney\t4630000\n' +
  'Sydney\tNova Scotia\tCanada\t46.0661\t-60.1800\tAmerica/Halifax\t37538\n' +
  'Perth\tWestern Australia\tAustralia\t-31.9531\t115.8381\tAustralia/Perth\t1532000\n' +
  'Perth\tPerthshire and Kinross\tUnited Kingdom\t56.4003\t-3.4700\tEurope/London\t39654\n' +
  'São Paulo\tSão Paulo\tBrazil\t-23.5567\t-46.6270\tAmerica/Sao_Paulo\t18845000\n' +
  'São Carlos\tSão Paulo\tBrazil\t-22.0200\t-47.8900\tAmerica/Sao_Paulo\t200000\n' +
  'Broken line without enough fields\n' +
  'Nowhere\tX\tY\t123.0\t0.0\t\t1\n';

const index = () => PlaceIndex.load(LIST);

function site(values: Partial<SiteInfo>): SiteInfo {
  return {
    trueNorthAngle: 0, projectBasePoint: null, surveyPoint: null, hasSharedTransform: false, sharedEast: 0, sharedNorth: 0, sharedElevation: 0,
    sharedAngle: 0, hasLocation: false, latitude: 0, longitude: 0, timeZone: 0, placeName: '', sunStart: '', ...values
  };
}

describe('PlaceIndex', () => {
  it('skips comments and bad lines', () => {
    expect(index().count).toBe(6); // the comment, the short line and the out-of-range latitude are skipped
  });

  it('ranks names, then population', () => {
    const places = index();
    let results = places.search('sydney');
    expect(results.length).toBe(2);
    expect(results[0].country).toBe('Australia'); // the bigger Sydney first
    expect(results[0].label).toBe('Sydney, New South Wales, Australia');

    results = places.search('perth united');
    expect(results.length).toBe(1); // every word must match
    expect(results[0].country).toBe('United Kingdom');

    results = places.search('sao paulo');
    expect(results[0].name).toBe('São Paulo'); // accents are ignored; the exact name wins
    expect(results[0].label).toBe('São Paulo, Brazil'); // the region is left out when it repeats the name
    expect(results.length).toBe(2); // São Carlos is in São Paulo state

    expect(places.search('  ').length).toBe(0);
    expect(places.search('syd', 1).length).toBe(1);
  });

  it('reads decimal, hemisphere and degrees / minutes coordinates', () => {
    expect(PlaceIndex.parseCoordinates('-33.8688, 151.2093')).toEqual({ latitude: -33.8688, longitude: 151.2093 });
    expect(PlaceIndex.parseCoordinates('-33.8688 151.2093')?.longitude).toBeCloseTo(151.2093, 9); // a space works too
    expect(PlaceIndex.parseCoordinates('33.8688S 151.2093E')?.latitude).toBeCloseTo(-33.8688, 9);
    const london = PlaceIndex.parseCoordinates('51°30′N, 0°7′W')!;
    expect(london.latitude).toBeCloseTo(51.5, 9);
    expect(london.longitude).toBeCloseTo(-7 / 60, 9);
    expect(PlaceIndex.parseCoordinates('−33.86, 151.21')?.latitude).toBeCloseTo(-33.86, 9); // a true minus, as BimGo shows them
    expect(PlaceIndex.parseCoordinates('sydney')).toBeNull();
    expect(PlaceIndex.parseCoordinates('95, 10')).toBeNull(); // latitude out of range
    expect(PlaceIndex.parseCoordinates('10, 200')).toBeNull(); // longitude out of range
  });

  it('finds the nearest place within the limit', () => {
    const near = index().nearest(-33.8, 151.0, 300)!;
    expect(near.place.zoneId).toBe('Australia/Sydney');
    expect(near.km > 10 && near.km < 30).toBe(true);
    expect(index().nearest(0, 0, 300)).toBeNull(); // nothing within 300 km of 0°, 0°
    expect(PlaceIndex.distanceKm(10, 20, 10, 20)).toBeCloseTo(0, 9);
    expect(PlaceIndex.distanceKm(0, 0, 1, 0)).toBeCloseTo(111.19, 1); // one degree of latitude
  });

  it('folds case and accents', () => {
    expect(PlaceIndex.fold('São  Paulo')).toBe('sao paulo');
    expect(PlaceIndex.fold('Łódź')).toBe('lodz');
  });

  it('loads the bundled list', () => {
    const places = PlaceIndex.load(readFileSync(resolve(__dirname, '../public/places.tsv'), 'utf-8'));
    expect(places.count).toBeGreaterThan(7000);
    expect(places.search('sydney')[0].zoneId).toBe('Australia/Sydney');
    expect(places.search('perth aus')[0].country).toBe('Australia');
  });
});

describe('Effective site and daylight saving', () => {
  it('replaces the location only on a copy', () => {
    const model = site({ hasLocation: true, latitude: 51.5, longitude: -0.12, timeZone: 0, placeName: 'London', trueNorthAngle: 0.3 });
    const location = { latitude: -33.87, longitude: 151.21, timeZone: 10, zoneId: 'Australia/Sydney', autoDaylightSaving: true, name: 'Sydney' };

    const effective = SolarPosition.effectiveSite(model, location);
    expect(effective).not.toBe(model);
    expect(effective.latitude).toBe(-33.87);
    expect(effective.placeName).toBe('Sydney');
    expect(effective.zoneId).toBe('Australia/Sydney');
    expect(effective.autoDaylightSaving).toBe(true);
    expect(effective.trueNorthAngle).toBe(0.3); // true north stays the model's
    expect(model.latitude).toBe(51.5); // the model's site is untouched

    expect(SolarPosition.effectiveSite(model, null)).toBe(model);
    expect(SolarPosition.effectiveSite(model, { ...location, latitude: 99 })).toBe(model); // an invalid override is ignored
  });

  it('takes the tick without a zone and the zone with one', () => {
    const noZone: GeoLocation = { latitude: -33.87, longitude: 151.21, timeZone: 10, name: 'Sydney' };
    expect(SolarPosition.isDaylightSaving(noZone, 2026, 1, 15, true)).toBe(true); // no zone: the tick decides
    expect(SolarPosition.isDaylightSaving(noZone, 2026, 1, 15, false)).toBe(false);

    const unknown: GeoLocation = { latitude: 0, longitude: 0, timeZone: 0, name: 'X', zoneId: 'Not/AZone', autoDaylightSaving: true };
    expect(SolarPosition.isDaylightSaving(unknown, 2026, 1, 15, true)).toBe(true); // an unknown zone falls back to the tick

    const sydney: GeoLocation = { ...noZone, zoneId: 'Australia/Sydney', autoDaylightSaving: true };
    expect(SolarPosition.isDaylightSaving(sydney, 2026, 1, 15, false)).toBe(true); // Sydney is on DST in January
    expect(SolarPosition.isDaylightSaving(sydney, 2026, 6, 15, true)).toBe(false); // and off in June, whatever the tick
    expect(TimeZones.standardOffset('Australia/Sydney', 151.21)).toBe(10);
    expect(TimeZones.standardOffset('Asia/Kolkata', 77)).toBe(5.5);
    expect(TimeZones.standardOffset('America/New_York', -74)).toBe(-5);
    expect(TimeZones.isDaylightSaving('Europe/London', 2026, 7, 1)).toBe(true);
    expect(TimeZones.isDaylightSaving('Asia/Tokyo', 2026, 7, 1)).toBe(false);

    // compute applies it: January noon with auto = the same sun as a manual +1 h
    const auto = SolarPosition.compute(sydney, 2026, 1, 15, 720, false);
    const manual = SolarPosition.compute(noZone, 2026, 1, 15, 720, true);
    expect(auto.altitude).toBeCloseTo(manual.altitude, 12);
    expect(auto.azimuth).toBeCloseTo(manual.azimuth, 12);
  });

  it('estimates the offset from the longitude without a zone', () => {
    expect(TimeZones.standardOffset(null, 151.2)).toBe(10);
    expect(TimeZones.estimateOffset(-74)).toBe(-5);
    expect(TimeZones.estimateOffset(NaN)).toBe(0);
  });

  it('keeps a valid override in sun.json and drops a bad one', () => {
    const sun = readSunSettings({ location: { latitude: 40.7, longitude: -74, timeZone: -5, zoneId: ' America/New_York ', name: 'New York' } });
    expect(sun.location?.zoneId).toBe('America/New_York'); // trimmed
    expect(sun.location?.autoDaylightSaving).toBe(true);
    const json = SidecarJson.sun(sun);
    expect(readSunSettings(JSON.parse(JSON.stringify(json))).location).toEqual(sun.location);

    expect(readSunSettings({ location: { latitude: 'NaN' } }).location).toBeNull();
    expect('location' in SidecarJson.sun(readSunSettings({}))).toBe(false); // older readers see no change
  });

  it('moves the sun with the override', () => {
    const settings = { ...defaultSunHoursSettings(), month: 6, day: 21, startMinutes: 5 * 60, endMinutes: 21 * 60, stepMinutes: 15 };
    const london = site({ hasLocation: true, latitude: 51.5, longitude: -0.12, timeZone: 0 });
    const sydney = SolarPosition.effectiveSite(london, { latitude: -33.87, longitude: 151.21, timeZone: 10, zoneId: null, autoDaylightSaving: false, name: 'Sydney' });
    const year = new Date().getFullYear();
    const north = SunHours.sunDirections(london, year, settings);
    const south = SunHours.sunDirections(sydney, year, settings);
    expect(north.locationKnown && south.locationKnown).toBe(true);
    expect(north.directions.length).toBeGreaterThan(south.directions.length); // June: more sun samples above the horizon in London
  });
});
