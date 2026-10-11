import { describe, expect, it } from 'vitest';
import { SidecarJson } from '../src/core/format/BimGoWriter';
import { defaultTourSettings, readBookmarkDocument, readTourSettings, TourLimits, tourHoldFor, tourSwivelFor } from '../src/core/format/DocumentModels';
import { vec3 } from '../src/core/math/Vector';
import { TourTimeline, tourStop } from '../src/core/scene/TourTimeline';
import { EyeHeights, EyePreset, VideoSize, ViewerSettings } from '../src/game/ViewerSettings';

// Port of tests/BimGo.Core.Tests/TourTests.cs (tour round): the tour timeline, the new bookmark fields and the
// eye-height and video settings.

const DEG = Math.PI / 180;

const threeStops = (swivelDegrees = 0) => [
  tourStop(vec3(0, 0, 0), 1.62, 0, 0, 4, swivelDegrees * DEG),
  tourStop(vec3(10, 0, 0), 1.2, Math.PI / 2, 0.1, 2, swivelDegrees * DEG),
  tourStop(vec3(10, 10, 3), 1.62, Math.PI, 0, 3, swivelDegrees * DEG)
];

describe('TourTimeline', () => {
  it('fades: holds plus two fades per stop', () => {
    const timeline = new TourTimeline(threeStops(), 'fade', 0.5, 3);
    expect(timeline.count).toBe(3);
    expect(timeline.duration).toBeCloseTo(4 + 2 + 3 + 6 * 0.5, 4);
    expect(timeline.startOf(0)).toBeCloseTo(0, 5);
    expect(timeline.startOf(1)).toBeCloseTo(5, 5); // 0.5 in + 4 hold + 0.5 out
    expect(timeline.startOf(2)).toBeCloseTo(8, 5);
  });

  it('is black at the edges and clear in the hold', () => {
    const timeline = new TourTimeline(threeStops(), 'fade', 0.5, 3);
    expect(timeline.evaluate(0).black).toBeCloseTo(1, 4);
    expect(timeline.evaluate(0.25).black).toBeCloseTo(0.5, 4);
    expect(timeline.evaluate(2).black).toBeCloseTo(0, 4);
    expect(timeline.evaluate(4.75).black).toBeCloseTo(0.5, 4);

    const next = timeline.evaluate(5.01);
    expect(next.stop).toBe(1); // the stop changes at black
    expect(next.black).toBeGreaterThan(0.9);
    expect(next.feet.x).toBeCloseTo(10, 4);
    expect(next.eyeHeight).toBeCloseTo(1.2, 4); // each stop keeps its own eye height
  });

  it('eases the swivel across the visible stop', () => {
    const timeline = new TourTimeline(threeStops(30), 'fade', 0.5, 3);
    expect(timeline.evaluate(0).yaw).toBeCloseTo(0, 4);
    expect(timeline.evaluate(2.5).yaw).toBeCloseTo(15 * DEG, 3); // smoothstep is symmetric
    expect(timeline.evaluate(4.999).yaw).toBeCloseTo(30 * DEG, 3);
    const early = timeline.evaluate(0.25).yaw;
    expect(early > 0 && early < 30 * DEG * 0.05).toBe(true); // eased in: slower than a linear pan at first
  });

  it('finishes past the end', () => {
    const timeline = new TourTimeline(threeStops(), 'fade', 0.5, 3);
    const end = timeline.evaluate(timeline.duration + 1);
    expect(end.finished).toBe(true);
    expect(end.stop).toBe(2);
    expect(end.black).toBeCloseTo(1, 4);
    expect(timeline.evaluate(timeline.duration - 0.01).finished).toBe(false);
  });

  it('glides between stops the short way round', () => {
    const stops = [tourStop(vec3(0, 0, 0), 1.6, 170 * DEG, 0, 2, 0), tourStop(vec3(4, 0, 0), 1.2, -170 * DEG, 0, 2, 0)];
    const timeline = new TourTimeline(stops, 'glide', 0.5, 2);
    // 0.5 fade in + 2 hold + 2 glide (4 m at 4 m/s is 1 s, so the set 2 s wins) + 2 hold + 0.5 fade out
    expect(timeline.duration).toBeCloseTo(7, 4);
    expect(timeline.startOf(1)).toBeCloseTo(2.5, 4);

    const middle = timeline.evaluate(3.5);
    expect(middle.moving).toBe(true);
    expect(middle.stop).toBe(1); // a glide belongs to the stop it flies to
    expect(middle.feet.x).toBeCloseTo(2, 3);
    expect(middle.eyeHeight).toBeCloseTo(1.4, 3);
    expect(Math.abs(middle.yaw)).toBeCloseTo(Math.PI, 3); // through 180°, not back through 0°
    expect(middle.black).toBeCloseTo(0, 5);
    expect(timeline.evaluate(6.75).black).toBeCloseTo(0.5, 4); // the last stop fades out
  });

  it('glides longer between far stops', () => {
    const stops = [tourStop(vec3(), 1.6, 0, 0, 1, 0), tourStop(vec3(40, 0, 0), 1.6, 0, 0, 1, 0)];
    expect(new TourTimeline(stops, 'glide', 0, 2).duration).toBeCloseTo(1 + 40 / TourTimeline.GLIDE_SPEED + 1, 4);
  });

  it('finds stops and handles empty tours', () => {
    const timeline = new TourTimeline(threeStops(), 'fade', 0.5, 3);
    expect(timeline.indexAt(0)).toBe(0);
    expect(timeline.indexAt(5)).toBe(1);
    expect(timeline.indexAt(100)).toBe(2);

    const empty = new TourTimeline([], 'fade', 0.5, 3);
    expect(empty.duration).toBe(0);
    expect(empty.evaluate(0).finished).toBe(true);
    expect(empty.indexAt(0)).toBe(-1);
  });

  it('wraps angles and clamps the easing', () => {
    expect(TourTimeline.smooth(-1)).toBe(0);
    expect(TourTimeline.smooth(2)).toBe(1);
    expect(TourTimeline.smooth(0.5)).toBeCloseTo(0.5, 6);
    // 175° → −165° is 20° the short way: half-way is 185° (= −175°), not 5°
    expect(TourTimeline.lerpAngle(175 * DEG, -165 * DEG, 0.5)).toBeCloseTo(185 * DEG, 4);
    expect(TourTimeline.lerpAngle(-5 * DEG, 15 * DEG, 0.5)).toBeCloseTo(5 * DEG, 4);
  });
});

describe('Tour settings and bookmarks', () => {
  it('resolves overrides and cleans hand-edited values', () => {
    const settings = { ...defaultTourSettings(), holdSeconds: 5, swivel: true, swivelDegrees: 20, swivelDirection: 'right' as const };
    const plain = readBookmarkDocument({ bookmarks: [{ name: 'A' }] }).bookmarks[0];
    const custom = readBookmarkDocument({ bookmarks: [{ name: 'B', tourHold: 9, tourSwivel: 0 }] }).bookmarks[0];
    expect(tourHoldFor(settings, plain)).toBe(5);
    expect(tourSwivelFor(settings, plain)).toBe(-20); // right is negative
    expect(tourHoldFor(settings, custom)).toBe(9);
    expect(tourSwivelFor(settings, custom)).toBe(0); // a bookmark can switch its swivel off
    settings.swivel = false;
    expect(tourSwivelFor(settings, plain)).toBe(0);

    const bad = readTourSettings({ holdSeconds: 0, fadeSeconds: 'NaN', glideSeconds: 99, swivelDegrees: 720, transition: 'warp' })!;
    expect(bad.holdSeconds).toBe(TourLimits.MIN_HOLD);
    expect(bad.fadeSeconds).toBeCloseTo(0.6, 6);
    expect(bad.glideSeconds).toBe(TourLimits.MAX_GLIDE);
    expect(bad.swivelDegrees).toBe(TourLimits.MAX_SWIVEL);
    expect(bad.transition).toBe('fade');
  });

  it('round-trips the tour fields as the desktop writes them and reads old files', () => {
    const document = readBookmarkDocument({
      version: 1,
      tour: { transition: 'Glide', loop: true }, // the desktop's string enum converter reads any case
      bookmarks: [{
        name: 'Kitchen', x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0, eyeHeight: 1.2, tourHold: 6, tourSwivel: -45, tourSkip: true,
        visibility: { hiddenCategories: ['furniture'], groundOffset: 2 }
      }]
    });
    const json = SidecarJson.bookmarks(document);
    expect((json.tour as Record<string, unknown>).transition).toBe('glide');
    const back = readBookmarkDocument(JSON.parse(JSON.stringify(json)));
    const kitchen = back.bookmarks[0];
    expect(kitchen.eyeHeight).toBeCloseTo(1.2, 5);
    expect(kitchen.tourHold).toBe(6);
    expect(kitchen.tourSwivel).toBe(-45);
    expect(kitchen.tourSkip).toBe(true);
    expect(kitchen.visibility?.hiddenCategories).toEqual(['furniture']);
    expect(kitchen.visibility?.groundOffset).toBeNull(); // bookmarks never move the ground
    expect(back.tour?.transition).toBe('glide');
    expect(back.tour?.loop).toBe(true);

    // A bookmark file from before the tour round: everything optional stays null
    const legacy = readBookmarkDocument({ version: 1, bookmarks: [{ name: 'Old', x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0 }] });
    expect(legacy.tour).toBeNull();
    expect(legacy.bookmarks[0]).toMatchObject({ visibility: null, eyeHeight: null, tourHold: null, tourSkip: false });
    expect('tour' in SidecarJson.bookmarks(legacy)).toBe(false); // nulls are left out, as the desktop writes them
  });

  it('clamps hand-edited bookmark values', () => {
    const b = readBookmarkDocument({ bookmarks: [{ name: 'A', eyeHeight: 9, tourHold: 0.1, tourSwivel: 'NaN' }] }).bookmarks[0];
    expect(b.eyeHeight).toBe(TourLimits.MAX_EYE_HEIGHT);
    expect(b.tourHold).toBe(TourLimits.MIN_HOLD);
    expect(b.tourSwivel).toBeNull();
  });
});

describe('Eye-height and video settings', () => {
  it('defaults, clamps and keeps presets', () => {
    const settings = new ViewerSettings();
    expect(settings.eyePreset).toBe(EyePreset.Standing);
    expect(settings.eyeHeightFor(EyePreset.Standing)).toBe(1.62);
    expect(settings.eyeHeightFor(EyePreset.Seated)).toBe(1.2);
    expect(settings.eyeHeightFor(EyePreset.Child)).toBe(1.1);
    settings.setEyeHeight(EyePreset.Seated, 1.234);
    expect(settings.eyeHeightSeated).toBeCloseTo(1.23, 5); // rounded to the centimetre
    expect(EyeHeights.clean(0.2, 1)).toBe(EyeHeights.MIN);
    expect(EyeHeights.clean(NaN, EyeHeights.DEFAULT_STANDING)).toBe(EyeHeights.DEFAULT_STANDING);
  });

  it('defaults the video to 1080p at 30 fps', () => {
    const settings = new ViewerSettings();
    expect(settings.videoSize).toBe(VideoSize.FullHd);
    expect(settings.videoFps).toBe(30);
  });
});
