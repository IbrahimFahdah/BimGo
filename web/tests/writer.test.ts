import { existsSync, openAsBlob } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BimGoReader } from '../src/core/format/BimGoReader';
import { f, writeBimGo } from '../src/core/format/BimGoWriter';
import { readCommentDocument, readBookmarkDocument } from '../src/core/format/DocumentModels';
import { crc32 } from '../src/core/format/ZipWriter';
import { EditJournal } from '../src/core/edits/EditJournal';
import { vec3 } from '../src/core/math/Vector';
import { buildGeometry, buildZip } from './zipFixture';

const manifest = JSON.stringify({
  format: 'bimgo', formatVersion: 1, kind: 'revit-export', title: 'Box', createdUtc: '2026-01-02T03:04:05Z',
  extraction: { enabledCategories: ['walls'], triangleThreshold: 20000, overLimit: 'Proxy' }
});
const model = JSON.stringify({
  originOffset: [100, 200, 0.3], boundsMin: [0, 0, 0], boundsMax: [1, 1, 1],
  categories: [{ key: 'walls', loaded: true }], levels: [{ name: 'L1', elevation: 0.1 }],
  rooms: [{ number: '1', name: 'R', bottomZ: 0, topZ: 3, loops: [[0, 0, 1, 0, 1, 1]] }]
});
const elements = JSON.stringify({ elements: [{ id: 7, uniqueId: 'u7', name: 'Wall', category: 0, opaque: [0, 3], movable: true, pivot: [0.5, 0.5, 0], boundsMin: [0, 0, 0], boundsMax: [1, 1, 0] }] });

function content(doc: Awaited<ReturnType<typeof BimGoReader.read>>) {
  return {
    comments: readCommentDocument({ comments: [{ id: 'c1', author: 'Ann', created: '2026-01-01T00:00:00Z', text: 'Check this', x: 100.5, y: 200.5, z: 1.25, elementId: 7, level: 'L1' }] }),
    journal: new EditJournal([{
      seq: 1, op: 'transform', mode: null, elementId: 7, uniqueId: 'u7', targetCloneKey: 0, newCloneKey: 0, pivot: vec3(100.5, 200.5, 0.3),
      offset: vec3(0.25, 0, 0), angle: 0.5, label: 'Move Wall', utc: '2026-01-01T00:00:00Z', user: 'Ann', appliedToRevit: false, revitElementId: 0
    }]),
    bookmarks: readBookmarkDocument({ bookmarks: [{ id: 'b1', name: 'Door', x: 100, y: 200, z: 0.3, yaw: 1.5, pitch: -0.2, sun: { month: 3, day: 4, minutes: 600 } }] }),
    sun: { version: 1, enabled: true, time: { month: 6, day: 21, minutes: 780, daylightSaving: false }, sunIntensity: 1.2, skyIntensity: 1, shadowIntensity: 0.8, glassTransmission: 1 },
    visibility: { hiddenCategories: ['walls'], hiddenLinks: [], hiddenElements: [{ link: null, uniqueId: 'u7', id: 7 }], groundOffset: 0.35, section: null },
    materials: doc.scene.materials,
    savedBy: 'Ann'
  };
}

describe('BimGoWriter', () => {
  it('computes CRC-32 like zlib', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('writes float32 values in their shortest form', () => {
    expect(f(Math.fround(0.3))).toBe(0.3);
    expect(f(Math.fround(1.62))).toBe(1.62);
    expect(f(NaN)).toBe(0);
  });

  it('round-trips a model with comments, journal, bookmarks, sun and visibility', async () => {
    const source = buildZip({ 'manifest.json': manifest, 'model.json': model, 'elements.json': elements, 'geometry.bin': buildGeometry([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2]) });
    const doc = await BimGoReader.read(source, 'Box.bimgo');
    const saved = await writeBimGo(doc, content(doc), { generator: 'BimGo Web', version: 'test' }, 'save');
    const back = await BimGoReader.read(saved, 'Box.bimgo');

    expect(back.kind).toBe('save');
    expect(back.createdUtc).toBe('2026-01-02T03:04:05Z');
    expect(back.manifest.generator).toBe('BimGo Web');
    expect((back.manifest.extraction as { enabledCategories: string[] }).enabledCategories).toEqual(['walls']);
    expect([...back.scene.geometry.vertexBytes]).toEqual([...doc.scene.geometry.vertexBytes]);
    expect([...back.scene.geometry.indices]).toEqual([0, 1, 2]);
    expect(back.scene.originOffset).toEqual({ x: 100, y: 200, z: Math.fround(0.3) });
    expect(back.scene.rooms[0].loops[0].length).toBe(3);
    expect(back.scene.elements[0]).toMatchObject({ elementId: 7, uniqueId: 'u7', name: 'Wall', movable: true });

    expect(back.comments.comments[0]).toMatchObject({ id: 'c1', author: 'Ann', text: 'Check this', x: 100.5, elementId: 7, edited: null });
    expect(back.journal.entries[0]).toMatchObject({ seq: 1, op: 'transform', uniqueId: 'u7', label: 'Move Wall', angle: 0.5 });
    expect(back.journal.entries[0].offset).toEqual({ x: 0.25, y: 0, z: 0 });
    expect(back.bookmarks.bookmarks[0]).toMatchObject({ id: 'b1', name: 'Door', sun: { month: 3, day: 4, minutes: 600, daylightSaving: false } });
    expect(back.sun).toMatchObject({ enabled: true, sunIntensity: Math.fround(1.2), shadowIntensity: Math.fround(0.8) });
    expect(back.visibility).toEqual({ hiddenCategories: ['walls'], hiddenLinks: [], hiddenElements: [{ link: null, uniqueId: 'u7', id: 7 }], groundOffset: Math.fround(0.35), section: null });
  });
});

const MATERIALS = resolve(__dirname, '../../../test-models/Snowdon materials.bimgo');

describe.runIf(existsSync(MATERIALS))('Snowdon materials round trip', () => {
  it('keeps geometry, materials, streams and textures', async () => {
    const doc = await BimGoReader.read(await openAsBlob(MATERIALS), 'Snowdon materials.bimgo');
    const saved = await writeBimGo(doc, content(doc), { generator: 'BimGo Web', version: 'test' }, 'save');
    const back = await BimGoReader.read(saved, 'x.bimgo');
    expect(back.scene.geometry.vertexCount).toBe(doc.scene.geometry.vertexCount);
    expect(back.scene.geometry.indices).toEqual(doc.scene.geometry.indices);
    expect(back.scene.elements.length).toBe(doc.scene.elements.length);
    expect(back.scene.materials.materials.map(m => [m.name, m.texture, m.textureState])).toEqual(doc.scene.materials.materials.map(m => [m.name, m.texture, m.textureState]));
    expect(back.scene.materials.vertexMaterial).toEqual(doc.scene.materials.vertexMaterial);
    expect(back.scene.materials.vertexUv).toEqual(doc.scene.materials.vertexUv);
    expect([...back.scene.materials.textures.keys()]).toEqual([...doc.scene.materials.textures.keys()]);
    expect(back.scene.levels).toEqual(doc.scene.levels);
    expect(back.scene.rooms.length).toBe(doc.scene.rooms.length);
  }, 120000);
});
