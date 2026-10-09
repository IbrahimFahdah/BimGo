import { describe, expect, it } from 'vitest';
import { BimGoReader } from '../src/core/format/BimGoReader';
import { writeBimGo } from '../src/core/format/BimGoWriter';
import {
  cleanComment, cleanGroundOffset, CommentPriority, CommentStatus, readBookmarkDocument, readCommentDocument, readVisibility
} from '../src/core/format/DocumentModels';
import { EditJournal, journalOpCreates, JournalOps } from '../src/core/edits/EditJournal';
import { EditOp } from '../src/core/edits/EditMessages';
import { editRequestJson } from '../src/core/live/LiveProtocol';
import { vec2, vec3 } from '../src/core/math/Vector';
import { findLibraryEntry, placeableCount } from '../src/core/scene/FamilyLibrary';
import { cleanMaterial } from '../src/core/scene/MaterialData';
import { modelVertexCount, type RoomInfo, roomContains, roomDistanceToBoundary } from '../src/core/scene/SceneData';
import { cleanSunHoursSettings, defaultSunHoursSettings, SunHours } from '../src/core/scene/SunHours';
import { ShadowQuality } from '../src/engine/render/ShadowMaps';
import { LightMode } from '../src/game/Lights';
import { type ProfileValues, QualityProfile, QualityProfiles } from '../src/game/QualityProfiles';
import { ColourMode } from '../src/game/ViewerSettings';
import { buildGeometry, buildZip } from './zipFixture';

// A model with one wall (element 0) and one family library template (element 1, vertices 3..5)
const manifest = JSON.stringify({ format: 'bimgo', formatVersion: 1, kind: 'live-snapshot', title: 'Lib', createdUtc: '2026-10-09T00:00:00Z' });
const model = JSON.stringify({
  originOffset: [10, 20, 0], boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], categories: [{ key: 'walls', loaded: true }, { key: 'furniture', loaded: true }]
});
const elements = JSON.stringify({
  elements: [
    { id: 7, uniqueId: 'u7', name: 'Wall', category: 0, opaque: [0, 3], boundsMin: [0, 0, 0], boundsMax: [1, 1, 0] },
    { id: 0, uniqueId: '', name: 'Desk', category: 1, opaque: [3, 3], movable: true, pivot: [0, 0, -2000], boundsMin: [0, 0, -2000], boundsMax: [1, 1, -1999], library: true }
  ]
});
const library = JSON.stringify({
  version: 1, vertexStart: 3, entries: [
    { typeId: 11, typeUniqueId: 't-desk', family: 'Desk', type: '1600', category: 'furniture', placement: 'levelBased', placeable: true, element: 1, preview: 'library/0.png', placed: 2 },
    { typeId: 12, typeUniqueId: 't-shelf', family: 'Shelf', type: 'Wall', category: 'furniture', placement: 'hosted', placeable: false, reason: 'Wall-hosted', element: -1 },
    { typeId: 13, typeUniqueId: 't-bad', family: 'X', type: 'Y', category: 'not-a-category', placeable: true, element: 1 },
    { typeId: 14, typeUniqueId: 't-wall', family: 'W', type: 'W', category: 'walls', placeable: true, element: 0 }
  ]
});
const geometry = buildGeometry([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, -2000], [1, 0, -2000], [0, 1, -2000]], [0, 1, 2, 3, 4, 5]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function readLibraryModel() {
  const source = buildZip({ 'manifest.json': manifest, 'model.json': model, 'elements.json': elements, 'geometry.bin': geometry, 'library.json': library, 'library/0.png': png });
  return BimGoReader.read(source, 'Lib.bimgo');
}

describe('Family library', () => {
  it('reads entries, validates templates and keeps templates out of counts and bounds', async () => {
    const doc = await readLibraryModel();
    const scene = doc.scene;
    expect(scene.elements[1].isLibraryTemplate).toBe(true);
    expect(scene.categoryElementCounts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(scene.library.entries.map(e => e.typeUniqueId)).toEqual(['t-desk', 't-shelf', 't-wall']);
    expect(findLibraryEntry(scene.library, 't-wall')).toMatchObject({ element: -1, placeable: false, reason: 'No geometry was captured for this type' });
    expect(placeableCount(scene.library)).toBe(1);
    expect([...scene.library.previews.get('library/0.png')!]).toEqual([...png]);
    expect(modelVertexCount(scene)).toBe(3);
  });

  it('round-trips the library, previews, template flag and place journal entries', async () => {
    const doc = await readLibraryModel();
    const journal = new EditJournal([{
      seq: 1, op: JournalOps.PLACE, mode: null, elementId: 0, uniqueId: '', targetCloneKey: 0, newCloneKey: 3, typeUniqueId: 't-desk', typeId: 11,
      pivot: vec3(12, 22, 0), offset: vec3(), angle: 0.25, label: 'Place Desk : 1600', utc: '2026-10-09T00:00:00Z', user: 'Ann', appliedToRevit: false, revitElementId: 0
    }]);
    const saved = await writeBimGo(doc, {
      comments: doc.comments, journal, bookmarks: readBookmarkDocument(null), sun: null, visibility: null, materials: doc.scene.materials, savedBy: 'Ann'
    }, { generator: 'BimGo Web', version: 'test' }, 'session-save');
    const back = await BimGoReader.read(saved, 'Lib.bimgo');
    expect(back.scene.elements[1].isLibraryTemplate).toBe(true);
    expect(back.scene.library.entries.length).toBe(3);
    expect(back.scene.library.vertexStart).toBe(3);
    expect(back.scene.library.previews.size).toBe(1);
    expect(back.journal.entries[0]).toMatchObject({ op: 'place', newCloneKey: 3, typeUniqueId: 't-desk', typeId: 11, angle: 0.25 });
    expect(journalOpCreates('place')).toBe(true);
    expect(journal.maxCloneKey()).toBe(3);
  });

  it('sends place edits with the type, and leaves the type out of other ops', () => {
    const place = editRequestJson({ ticket: 1, op: EditOp.Place, elementId: 0, newCloneKey: 3, typeUniqueId: 't', typeId: 9, pivot: vec3(1, 2, 3), label: 'Place' });
    expect(place).toMatchObject({ op: 'place', typeUniqueId: 't', typeId: 9, newCloneKey: 3 });
    expect('typeUniqueId' in editRequestJson({ op: EditOp.Transform, elementId: 1, label: 'Move' })).toBe(false);
  });
});

describe('Comments as issues', () => {
  it('reads older comments as open, normal, unassigned', () => {
    const doc = readCommentDocument({ comments: [{ id: 'c', text: 'Old', author: 'A' }] });
    expect(doc.comments[0]).toMatchObject({ status: 'open', priority: 'normal', assignedTo: null, replies: null, view: null, thumbnail: null });
  });

  it('cleans unknown values, blank replies and broken views', () => {
    const doc = readCommentDocument({ comments: [{ id: 'c', text: 'T', status: 'INPROGRESS', priority: 'urgent', assignedTo: '  ', thumbnail: '',
      replies: [{ text: ' ' }, { text: 'Yes', author: 'B' }], view: { x: 1, y: 2, z: 'NaN', yaw: 0, pitch: 0 } }] });
    expect(doc.comments[0]).toMatchObject({ status: CommentStatus.IN_PROGRESS, priority: CommentPriority.NORMAL, assignedTo: null, view: null, thumbnail: null });
    expect(doc.comments[0].replies!.map(r => r.text)).toEqual(['Yes']);
    const c = cleanComment({ ...doc.comments[0], replies: [] });
    expect(c.replies).toBeNull();
    expect(CommentStatus.label('closed')).toBe('Closed');
  });
});

describe('Visibility and materials', () => {
  it('keeps the ground offset finite, clamped and null at zero', () => {
    expect(cleanGroundOffset(0)).toBeNull();
    expect(cleanGroundOffset(25)).toBe(10);
    expect(cleanGroundOffset(Number.NaN)).toBeNull();
    expect(readVisibility({ groundOffset: -0.5 }).groundOffset).toBe(-0.5);
  });

  it('reads reflection fields with defaults for older files', () => {
    expect(cleanMaterial({ name: 'Old' })).toMatchObject({ shine: 0, roughness: null, metallic: false, water: false, waterBump: 0, reflectSource: null });
    expect(cleanMaterial({ shine: 2, roughness: -1, metallic: true, water: true, waterBump: 0.1 })).toMatchObject({ shine: 1, roughness: 0, metallic: true, water: true });
  });
});

describe('Quality profiles', () => {
  const values = (): ProfileValues => ({
    colour: ColourMode.Whitecard, ambientOcclusion: true, shadowQuality: ShadowQuality.Medium, lightMode: LightMode.Lights, bloomIntensity: 1,
    reflections: true, reflectionThreshold: 50, reflectionProbes: true, probeResolution: 128
  });

  it('applies and recognises each profile; a manual change reads Custom', () => {
    for (const profile of QualityProfiles.PICKABLE) {
      const s = values();
      QualityProfiles.apply(s, profile);
      expect(QualityProfiles.detect(s)).toBe(profile);
    }
    const s = values();
    QualityProfiles.apply(s, QualityProfile.Realistic);
    s.probeResolution = 256; // HQ is never part of a profile
    expect(QualityProfiles.detect(s)).toBe(QualityProfile.Custom);
  });

  it('Basic keeps the reflection threshold for when reflections come back on', () => {
    const s = values();
    s.reflectionThreshold = 25;
    QualityProfiles.apply(s, QualityProfile.Basic);
    expect(s.reflections).toBe(false);
    expect(s.reflectionThreshold).toBe(25);
  });
});

describe('Sun hours', () => {
  it('samples mid-step and only counts the sun above the horizon', () => {
    const settings = defaultSunHoursSettings(); // 21 June 9:00–15:00, 5 min
    const { directions, samples, locationKnown } = SunHours.sunDirections(null, 2026, settings);
    expect(samples).toBe(72);
    expect(locationKnown).toBe(false); // Sydney assumed
    expect(directions.length).toBe(72);  // midwinter in Sydney: the sun is up all day
    expect(directions.every(d => d.z > 0)).toBe(true);

    const night = SunHours.sunDirections(null, 2026, { ...settings, startMinutes: 0, endMinutes: 60 });
    expect(night.directions.length).toBe(0);
  });

  it('cleans settings and maps hours onto the Ladybug legend', () => {
    const s = cleanSunHoursSettings({ ...defaultSunHoursSettings(), startMinutes: 900, endMinutes: 600, stepMinutes: 7, gridSize: 0.3, day: 31, month: 2 }, 2026);
    expect(s).toMatchObject({ endMinutes: 905, stepMinutes: 5, gridSize: 0.25, day: 28 });
    expect(SunHours.legendColour(0)).toEqual([75 / 255, 107 / 255, 169 / 255]);
    expect(SunHours.legendColour(99)).toEqual([234 / 255, 38 / 255, 0]);
  });
});

describe('Room geometry', () => {
  const room: RoomInfo = {
    number: '1', name: 'L', bottomZ: 0, topZ: 3, link: 0, min: vec2(0, 0), max: vec2(4, 4),
    loops: [[vec2(0, 0), vec2(4, 0), vec2(4, 4), vec2(0, 4)], [vec2(1, 1), vec2(2, 1), vec2(2, 2), vec2(1, 2)]]
  };
  it('treats islands as holes and measures the distance to the boundary', () => {
    expect(roomContains(room, vec2(3, 3))).toBe(true);
    expect(roomContains(room, vec2(1.5, 1.5))).toBe(false);
    expect(roomContains(room, vec2(5, 1))).toBe(false);
    expect(roomDistanceToBoundary(room, vec2(3, 3))).toBeCloseTo(1, 5);
    expect(roomDistanceToBoundary(room, vec2(2.5, 1.5))).toBeCloseTo(0.5, 5);
  });
});
