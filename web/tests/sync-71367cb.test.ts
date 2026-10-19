import { describe, expect, it } from 'vitest';
import { readSunSettings, weatherDefaults } from '../src/core/format/DocumentModels';
import { type Vec3, vec3 } from '../src/core/math/Vector';
import { CoverMap } from '../src/core/scene/CoverMap';
import { LightningStorm, thunderDelay, thunderGain } from '../src/core/scene/LightningStorm';
import { createSunLighting, withLightning, withWeather } from '../src/engine/render/SunLighting';

// Upstream 71367cb: rounds W-B (rain and snow: the cover map, the weather settings) and W-C (lightning, its settings),
// ported from WeatherTests.cs and LightningTests.cs.

/** Six corners: an axis-aligned rectangle at height z. */
const rect = (x0: number, y0: number, x1: number, y1: number, z: number): Vec3[] => [
  vec3(x0, y0, z), vec3(x1, y0, z), vec3(x1, y1, z),
  vec3(x0, y0, z), vec3(x1, y1, z), vec3(x0, y1, z)
];

/** Six corners: a vertical wall face along X at y, from z0 to z1. */
const wall = (x0: number, x1: number, y: number, z0: number, z1: number): Vec3[] => [
  vec3(x0, y, z0), vec3(x1, y, z0), vec3(x1, y, z1),
  vec3(x0, y, z0), vec3(x1, y, z1), vec3(x0, y, z1)
];

describe('cover map (W-B)', () => {
  it('the highest surface wins; open outside', () => {
    const map = CoverMap.fromTriangles([...rect(0, 0, 40, 40, 0), ...rect(10, 10, 20, 20, 3), ...rect(9, 9, 21, 21, 6.5)]);
    expect(map.isEmpty).toBe(false);
    expect(map.cell).toBeCloseTo(CoverMap.CELL, 6);
    expect(map.topAt(15, 15)).toBeCloseTo(6.5, 4);
    expect(map.topAt(30, 30)).toBeCloseTo(0, 4);
    expect(map.topAt(100, 100)).toBe(CoverMap.NONE);
    expect(map.isCovered(vec3(15, 15, 3 + 1.7))).toBe(true);
    expect(map.isCovered(vec3(30, 30, 1.7))).toBe(false);
    expect(map.isCovered(vec3(15, 15, 6.5 + 1.7))).toBe(false);
  });

  it('thin walls and slopes', () => {
    const map = CoverMap.fromTriangles([...wall(0, 20, 5.1, 0, 2.4), vec3(30, 0, 3), vec3(40, 0, 3), vec3(30, 10, 8)]);
    expect(map.topAt(10, 5.1)).toBeCloseTo(2.4, 3);
    expect(map.topAt(1.3, 5.1)).toBeCloseTo(2.4, 3);
    expect(map.topAt(10, 7)).toBe(CoverMap.NONE);
    expect(Math.abs(map.topAt(32, 4) - 5)).toBeLessThanOrEqual(0.4);
  });

  it('big models get bigger cells', () => {
    const map = CoverMap.fromTriangles(rect(0, 0, 2000, 300, 0));
    expect(map.width).toBeLessThanOrEqual(CoverMap.MAX_SIDE);
    expect(map.height).toBeLessThanOrEqual(CoverMap.MAX_SIDE);
    expect(map.cell).toBeGreaterThan(1.9);
    expect(map.topAt(1000, 150)).toBeCloseTo(0, 4);
    expect(CoverMap.fromTriangles([]).isEmpty).toBe(true);
  });
});

describe('weather settings (W-B / W-C)', () => {
  it('defaults, clean and older files', () => {
    const old = readSunSettings({ enabled: true, cloudCover: 0.5 });
    expect(old.weather).toBe('off');
    expect(old.lightning).toBe(false);
    expect(old.lensDrops && old.weatherSound).toBe(true);
    expect(old.lightningFrequency).toBe(1);

    const bad = readSunSettings({ weather: ' Snow ', weatherIntensity: 0, wetness: 7, snowCover: 'x', lightningFrequency: 9, lightningFlash: null });
    expect(bad.weather).toBe('snow');
    expect(bad.weatherIntensity).toBeCloseTo(0.05, 6);
    expect(bad.wetness).toBe(1);
    expect(bad.snowCover).toBeCloseTo(0.6, 6);
    expect(bad.lightningFrequency).toBe(2);
    expect(bad.lightningFlash).toBeCloseTo(0.35, 6);
    expect(readSunSettings({ weather: 'hail' }).weather).toBe('off');
    expect(readSunSettings({ weather: null }).weather).toBe('off');

    const rain = readSunSettings({ weather: 'rain', lightning: true, lightningFrequency: 0, reduceFlashing: true, lensDrops: false, weatherSound: false });
    expect(rain.lightning && rain.reduceFlashing).toBe(true);
    expect(rain.lensDrops || rain.weatherSound).toBe(false);
    expect(rain.lightningFrequency).toBe(0);
    expect(weatherDefaults()).toMatchObject({ weather: 'off', weatherIntensity: 0.5, wetness: 1, snowCover: 0.6, lightning: false, lensDrops: true });
  });

  it('rain greys the sky and dims the sun; a flash lifts the sky light; both off with the sun off', () => {
    const clear = createSunLighting(vec3(0.3, 0.2, 0.9), 1, 1, 1, 1, vec3(0, 0, -1), 0.5, true, 1);
    const storm = withWeather(clear, 1, false);
    expect(storm.sunColour.x).toBeCloseTo(clear.sunColour.x * 0.4, 5);
    expect(storm.shadowStrength).toBeCloseTo(clear.shadowStrength * 0.5, 5);
    expect(withWeather(clear, 0, false)).toBe(clear);
    const flash = withLightning(storm, 1);
    expect(flash.skyColour.z).toBeCloseTo(storm.skyColour.z + 0.95 * 0.5, 5);
    const off = { ...clear, enabled: false };
    expect(withWeather(off, 1, true)).toBe(off);
    expect(withLightning(off, 1)).toBe(off);
  });
});

describe('lightning storm (W-C)', () => {
  /** The times flashes start: brightness rising through 0.3 after it fell below 0.15 (step s). */
  const flashStarts = (from: number, to: number, frequency: number, reduce: boolean, step = 0.001) => {
    const starts: number[] = [];
    let armed = true;
    for (let t = from; t < to; t += step) {
      const b = LightningStorm.evaluate(t, frequency, reduce)?.brightness ?? 0;
      if (armed && b >= 0.3) { starts.push(t); armed = false; }
      else if (!armed && b < 0.15) { armed = true; }
    }
    return starts;
  };

  it('never more than three flashes in any second', () => {
    for (let frequency = LightningStorm.RARE; frequency <= LightningStorm.OFTEN; frequency++) {
      const starts = flashStarts(0, 600, frequency, false);
      expect(starts.length).toBeGreaterThan(3);
      for (let i = 3; i < starts.length; i++) { expect(starts[i] - starts[i - 3]).toBeGreaterThan(1); }
    }
  });

  it('reduce flashing: one slow glow per strike', () => {
    const starts = flashStarts(0, 600, LightningStorm.OFTEN, true);
    expect(starts.length).toBeGreaterThan(20);
    for (let i = 1; i < starts.length; i++) { expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(LightningStorm.MIN_STRIKE_GAP - 0.01); }
    let previous = 0;
    for (let t = 0; t < 300; t += 0.01) {
      const b = LightningStorm.evaluate(t, LightningStorm.OFTEN, true)?.brightness ?? 0;
      expect(Math.abs(b - previous)).toBeLessThan(0.02);
      expect(b).toBeLessThanOrEqual(0.6 + 1e-4);
      previous = b;
    }
  });

  it('same clock, same storm; often means more', () => {
    const a = LightningStorm.evaluate(1234.567, LightningStorm.SOMETIMES, false);
    const b = LightningStorm.evaluate(1234.567, LightningStorm.SOMETIMES, false);
    expect(a?.strike.index).toBe(b?.strike.index);
    expect(a?.brightness).toBe(b?.brightness);

    const count = (frequency: number) => {
      let n = 0;
      for (let w = 0; w < 500; w++) {
        const s = LightningStorm.tryGetStrike(w, frequency);
        if (s && s.start < 3600) { n++; }
      }
      return n;
    };
    const rare = count(LightningStorm.RARE), sometimes = count(LightningStorm.SOMETIMES), often = count(LightningStorm.OFTEN);
    expect(rare).toBeLessThan(sometimes);
    expect(sometimes).toBeLessThan(often);
    expect(rare).toBeGreaterThanOrEqual(40);
    expect(often).toBeLessThanOrEqual(450);

    const s = LightningStorm.tryGetStrike(7, LightningStorm.OFTEN) ?? LightningStorm.tryGetStrike(8, LightningStorm.OFTEN);
    expect(s).not.toBeNull();
    if (!s) { return; }
    expect(s.pulses).toBeGreaterThanOrEqual(1);
    expect(s.pulses).toBeLessThanOrEqual(3);
    expect(s.pulseGap).toBeGreaterThanOrEqual(LightningStorm.MIN_PULSE_GAP);
    expect(s.elevation).toBeGreaterThan(0.1);
    expect(s.elevation).toBeLessThan(0.7);
    expect(thunderDelay(s)).toBeGreaterThanOrEqual(0.8);
    expect(thunderGain(s)).toBeGreaterThan(0);
    expect(LightningStorm.brightness(s, LightningStorm.FLASH_LENGTH, false)).toBe(0);
  });

  it('matches the desktop hash (SplitMix64 over ulong, negative windows wrapped)', () => {
    // Reference values from an independent Python SplitMix64 of the C# recipe
    expect(LightningStorm.tryGetStrike(7, LightningStorm.OFTEN)?.start).toBeCloseTo(56.62197665275226, 9);
    expect(LightningStorm.tryGetStrike(7, LightningStorm.OFTEN)?.pulses).toBe(2);
    expect(LightningStorm.tryGetStrike(8, LightningStorm.OFTEN)?.start).toBeCloseTo(64.95110893865196, 9);
    expect(LightningStorm.tryGetStrike(-1, LightningStorm.RARE)?.start).toBeCloseTo(-21.172987588968137, 9);
  });
});
