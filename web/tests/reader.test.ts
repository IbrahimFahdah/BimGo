import { existsSync, openAsBlob } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BimGoReadError, BimGoReader } from '../src/core/format/BimGoReader';
import { ZipReader } from '../src/core/format/Zip';
import { findCategory, KEY_GENERIC } from '../src/core/scene/CategoryCatalog';
import { PhaseRole } from '../src/core/scene/SceneData';
import { buildGeometry, buildZip } from './zipFixture';

const manifest = JSON.stringify({ format: 'bimgo', formatVersion: 1, kind: 'revit-export', title: 'Box' });

function model(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    boundsMin: [0, 0, 0],
    boundsMax: [1, 1, 1],
    categories: [{ key: 'walls', loaded: true }, { key: 'not-a-category', loaded: true }],
    levels: [{ name: 'L2', elevation: 3 }, { name: 'L1', elevation: 0 }],
    rooms: [{ number: '101', name: 'Office', bottomZ: 0, topZ: 3, link: 9, loops: [[0, 0, 1, 0, 1, 1, 0, 1]] }],
    spawn: { eye: [0.5, 0.5, 1.6], yaw: 1, pitch: 0 },
    ...extra
  });
}

const elements = JSON.stringify({
  elements: [
    { id: 11, uniqueId: 'a', name: 'Wall', category: 0, opaque: [0, 3], phase: 'new', link: 3, movable: false },
    { id: 12, uniqueId: 'b', category: 1, opaque: [0, 99], transparent: [0, 4], movable: true }
  ]
});

const geometry = buildGeometry([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2]);

describe('ZipReader', () => {
  it('lists and inflates entries', async () => {
    const zip = await ZipReader.open(buildZip({ 'a.txt': 'hello', 'dir/b.bin': new Uint8Array([1, 2, 3]) }));
    expect(zip.names).toEqual(['a.txt', 'dir/b.bin']);
    expect(await zip.readText(zip.get('a.txt')!)).toBe('hello');
    expect([...await zip.read(zip.get('dir/b.bin')!)]).toEqual([1, 2, 3]);
  });

  it('rejects something that is not a ZIP', async () => {
    await expect(ZipReader.open(new Blob(['not a zip at all']))).rejects.toThrow(/not a ZIP/);
  });
});

describe('BimGoReader', () => {
  it('reads a minimal model with the desktop fallbacks', async () => {
    const file = buildZip({ 'manifest.json': manifest, 'model.json': model(), 'elements.json': elements, 'geometry.bin': geometry });
    const doc = await BimGoReader.read(file, 'Box.bimgo');
    const scene = doc.scene;

    expect(scene.modelTitle).toBe('Box');
    expect(scene.geometry.vertexCount).toBe(3);
    expect([...scene.geometry.indices]).toEqual([0, 1, 2]);
    expect(scene.geometry.position(1)).toEqual({ x: 1, y: 0, z: 0 });

    // Levels sorted by elevation; room link 9 out of range → host
    expect(scene.levels.map(l => l.name)).toEqual(['L1', 'L2']);
    expect(scene.rooms[0].link).toBe(0);
    expect(scene.rooms[0].max).toEqual({ x: 1, y: 1 });

    // Unknown category → generic; bad range dropped; transparent count trimmed to whole triangles
    const [wall, other] = scene.elements;
    expect(wall.phase).toBe(PhaseRole.New);
    expect(wall.link).toBe(0);
    expect(wall.moveBlockReason).toBe('Not movable');
    expect(other.categoryIndex).toBe(findCategory(KEY_GENERIC)!.index);
    expect(other.name).toBe('(unnamed)');
    expect([other.opaqueStart, other.opaqueCount]).toEqual([0, 0]);
    expect(other.transparentCount).toBe(0);

    expect(doc.journal.count).toBe(0);
    expect(doc.comments.comments).toEqual([]);
    expect(doc.sun).toBeNull();
  });

  it('refuses files from a newer BimGo', async () => {
    const file = buildZip({ 'manifest.json': JSON.stringify({ format: 'bimgo', formatVersion: 99 }) });
    await expect(BimGoReader.read(file, 'x.bimgo')).rejects.toThrow(/newer BimGo/);
  });

  it('fails on an out-of-range vertex index', async () => {
    const bad = buildGeometry([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 7]);
    const file = buildZip({ 'manifest.json': manifest, 'model.json': model(), 'elements.json': elements, 'geometry.bin': bad });
    await expect(BimGoReader.read(file, 'x.bimgo')).rejects.toThrow(BimGoReadError);
    await expect(BimGoReader.read(file, 'x.bimgo')).rejects.toThrow(/index out of range/);
  });

  it('reports a missing required entry', async () => {
    const file = buildZip({ 'manifest.json': manifest, 'model.json': model() });
    await expect(BimGoReader.read(file, 'x.bimgo')).rejects.toThrow('The file is incomplete (elements.json is missing).');
  });
});

// The real Snowdon export lives outside the repo (test-models/ next to the fork); skipped in CI
const SNOWDON = resolve(__dirname, '../../../test-models/Snowdon Towers Sample Architectural.bimgo');

describe.runIf(existsSync(SNOWDON))('Snowdon Towers export', () => {
  it('reads with geometry, elements and levels', async () => {
    let last = 0;
    const doc = await BimGoReader.read(await openAsBlob(SNOWDON), 'Snowdon.bimgo', { step: f => { last = f; } });
    const s = doc.scene;
    expect(last).toBeGreaterThan(0.9);
    expect(s.geometry.vertexCount).toBeGreaterThan(100000);
    expect(s.elements.length).toBeGreaterThan(1000);
    expect(s.levels.length).toBeGreaterThan(1);
    expect(s.bounds.isValid).toBe(true);
    console.info(`Snowdon: ${s.geometry.vertexCount} vertices, ${s.geometry.indices.length / 3} triangles, ` +
      `${s.elements.length} elements, ${s.levels.length} levels, ${s.rooms.length} rooms, ${s.lighting.lights.length} lights, spawn ${s.spawn?.source ?? 'none'}`);
  }, 60000);
});

describe('sample model', () => {
  it('reads the shipped sample', async () => {
    const { openAsBlob } = await import('node:fs');
    const { resolve } = await import('node:path');
    const doc = await BimGoReader.read(await openAsBlob(resolve(__dirname, '../public/samples/BimGo Sample Pavilion.bimgo')), 'BimGo Sample Pavilion.bimgo');
    expect(doc.scene.elements.length).toBeGreaterThan(40);
    expect(doc.scene.rooms.map(r => r.name)).toEqual(['Lobby', 'Cafe', 'Studio']);
    expect(doc.scene.lighting.lights.length).toBe(7);
    expect(doc.scene.elements.some(e => e.movable)).toBe(true);
    expect(doc.bookmarks.bookmarks.length).toBe(3);
    expect(doc.sun?.enabled).toBe(true);
  });
});
