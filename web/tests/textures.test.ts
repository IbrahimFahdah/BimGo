import { describe, expect, it } from 'vitest';
import { cleanMaterial, withMaterials, type MaterialData } from '../src/core/scene/MaterialData';
import { ProxyCatalog } from '../src/core/scene/ProxyCatalog';
import { type FolderSource, TextureFolderIndex, TextureMatchStage, TextureSearch } from '../src/core/scene/TextureSearch';

// Ported from tests/BimGo.Core.Tests/TextureSearchTests.cs

/** An in-memory folder tree from relative paths ("A/b.jpg"). */
function folder(paths: string[], name = 'root'): FolderSource {
  const files = new Set<string>(), dirs = new Map<string, string[]>();
  for (const path of paths) {
    const slash = path.indexOf('/');
    if (slash < 0) { files.add(path); } else {
      const dir = path.slice(0, slash);
      dirs.set(dir, [...(dirs.get(dir) ?? []), path.slice(slash + 1)]);
    }
  }
  return {
    name,
    async *entries() {
      for (const f of files) { yield { kind: 'file' as const, name: f }; }
      for (const [d, inner] of dirs) { yield { kind: 'directory' as const, name: d, source: folder(inner, d) }; }
    }
  };
}

describe('TextureSearch names', () => {
  it('splits alternatives and both slashes', () => {
    expect(TextureSearch.fileNamesOf('1/Mats/x.jpg|2/Mats/x.jpg|3\\mats\\X.JPG')).toEqual(['x.jpg']);
    expect(TextureSearch.fileNamesOf('BG_Carpet_Plain1.jpg')).toEqual(['BG_Carpet_Plain1.jpg']);
    expect(TextureSearch.fileNamesOf('"C:\\Maps\\a.png"')).toEqual(['a.png']);
    expect(TextureSearch.fileNamesOf('')).toEqual([]);
    expect(TextureSearch.fileNamesOf(null)).toEqual([]);
  });

  it('builds loose stems ignoring case, separators and colour suffixes', () => {
    expect(TextureSearch.looseStem('BG_Carpet_Plain1.jpg')).toBe('bgcarpetplain1');
    expect(TextureSearch.looseStem('bg-carpet-plain-1.JPEG')).toBe('bgcarpetplain1');
    expect(TextureSearch.looseStem('BG Carpet Plain1_Color.png')).toBe('bgcarpetplain1');
    expect(TextureSearch.looseStem('Oak_diffuse.tif')).toBe('oak');
    expect(TextureSearch.looseStem('oak-albedo.jpg')).toBe('oak');
  });

  it('recognises auxiliary maps', () => {
    for (const name of ['BG_Carpet_Plain1_Bump.jpg', 'leaf_cutout.png', 'Brick_refl.jpg', 'Wood_NormalGL.jpg']) {
      expect(TextureSearch.isAuxiliaryMap(name)).toBe(true);
    }
    expect(TextureSearch.isAuxiliaryMap('BG_Carpet_Plain1.jpg')).toBe(false);
    expect(TextureSearch.isAuxiliaryMap('Brushed_Metal.jpg')).toBe(false);
  });
});

describe('TextureSearch stages', () => {
  it('indexes only images', async () => {
    const index = await TextureFolderIndex.build(folder(['a.jpg', 'b.png', 'notes.txt']));
    expect(index.fileCount).toBe(2);
    expect(index.truncated).toBe(false);
  });

  it('matches exact names case-insensitively and recursively, using every alternative', async () => {
    const index = await TextureFolderIndex.build(folder(['Maps/Floors/bg_carpet_plain1.JPG', 'Brick.jpg']));
    const carpet = TextureSearch.runStage(index, ['BG_Carpet_Plain1.jpg'], TextureMatchStage.Exact)[0];
    expect(carpet.stage).toBe(TextureMatchStage.Exact);
    expect(carpet.chosen).toBe('Maps/Floors/bg_carpet_plain1.JPG');
    expect(carpet.preTicked).toBe(true);
    expect(TextureSearch.runStage(index, ['1/Mats/Brick.jpg|2/Mats/Brick.jpg'], TextureMatchStage.Exact)[0].chosen).toBe('Brick.jpg');
  });

  it('swaps extensions but never offers bump maps', async () => {
    const index = await TextureFolderIndex.build(folder(['brick.png', 'carpet_bump.png']));
    expect(TextureSearch.runStage(index, ['brick.jpg'], TextureMatchStage.Exact)[0].stage).toBe(TextureMatchStage.None);
    const result = TextureSearch.runStage(index, ['brick.jpg'], TextureMatchStage.Extension)[0];
    expect(result.chosen).toBe('brick.png');
    expect(result.preTicked).toBe(true);
    expect(TextureSearch.runStage(index, ['carpet_bump.jpg'], TextureMatchStage.Extension)[0].stage).toBe(TextureMatchStage.None);
  });

  it('proposes loose matches only when unique and never pre-ticks them', async () => {
    const index = await TextureFolderIndex.build(folder(['bg-carpet-plain-1.JPEG', 'BG_Carpet_Plain1_bump.jpg', 'tile_a.png', 'Tile-A.jpg']));
    const carpet = TextureSearch.runStage(index, ['BG_Carpet_Plain1.jpg'], TextureMatchStage.Loose)[0];
    expect(carpet.chosen).toBe('bg-carpet-plain-1.JPEG');
    expect(carpet.preTicked).toBe(false);
    expect(TextureSearch.runStage(index, ['Tile A.tif'], TextureMatchStage.Loose)[0].stage).toBe(TextureMatchStage.None);
  });

  it('reports ambiguity with all candidates and no choice', async () => {
    const index = await TextureFolderIndex.build(folder(['A/wood.jpg', 'B/wood.jpg']));
    const result = TextureSearch.runStage(index, ['wood.jpg'], TextureMatchStage.Exact)[0];
    expect(result.isAmbiguous).toBe(true);
    expect(result.chosen).toBeNull();
    expect(result.preTicked).toBe(false);
    expect(result.candidates.sort()).toEqual(['A/wood.jpg', 'B/wood.jpg']);
  });

  it('runs each stage on what is left, skipping blanks and duplicates', async () => {
    const index = await TextureFolderIndex.build(folder(['one.jpg', 'two.png', 'three-a.jpg']));
    const results = TextureSearch.runAll(index, ['one.jpg', 'two.jpg', 'Three_A.jpg', 'four.jpg', '', 'one.jpg']);
    expect(results.map(r => r.stage)).toEqual([TextureMatchStage.Exact, TextureMatchStage.Extension, TextureMatchStage.Loose, TextureMatchStage.None]);
    expect(results.map(r => r.chosen)).toEqual(['one.jpg', 'two.png', 'three-a.jpg', null]);
    expect(TextureSearch.runAll(index, ['two.jpg'], TextureMatchStage.Exact)[0].stage).toBe(TextureMatchStage.None);
  });

  it('caps depth and file count', async () => {
    const shallow = await TextureFolderIndex.build(folder(['a.jpg', 'Deep/b.jpg']), undefined, undefined, 0);
    expect(shallow.fileCount).toBe(1);
    expect(shallow.truncated).toBe(true);
    const capped = await TextureFolderIndex.build(folder(['f0.jpg', 'f1.jpg', 'f2.jpg', 'f3.jpg', 'f4.jpg']), undefined, undefined, 8, 3);
    expect(capped.fileCount).toBe(3);
    expect(capped.truncated).toBe(true);
  });

  it('stops when cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(TextureFolderIndex.build(folder(['a.jpg']), abort.signal)).rejects.toThrow();
  });
});

describe('ProxyCatalog', () => {
  const rows: [string, string | null, string | null][] = [
    ['BG_Carpet_Plain1', null, 'carpet'], ['Concrete Block 200', null, 'blockwork'], ['Masonry - Brick', null, 'brick'],
    ['Concrete, Board Formed', null, 'concrete-board'], ['Concrete - Cast-in-Place', null, 'concrete'],
    ['Timber Floor - Spotted Gum', null, 'timber-floor'], ['Oak veneer', null, 'timber-panel'], ['Plywood', null, 'plywood'],
    ['Tile 600 x 600 Porcelain', null, 'tile-600'], ['Ceramic Tile White', null, 'tile-300'], ['Colorbond Roof Sheet', null, 'metal-galvanised'],
    ['Stainless Steel', null, 'metal-brushed'], ['Sandstone', null, 'stone'], ['Glass - Clear', null, null],
    ['Acoustic Ceiling Tile 600x600', null, null], ['Cloak Room Paint', null, null], ['Default Wall', 'MasonryCMUSchema', 'blockwork'],
    ['Default Wall', 'MasonrySchema', 'brick'], ['Some floor', 'HardwoodSchema', 'timber-floor'], ['Paint - White', 'WallPaintSchema', null],
    ['Thing', 'GenericSchema', null]
  ];
  it.each(rows)('suggests for %s (%s)', (name, schema, expected) => {
    expect(ProxyCatalog.suggest(name, schema)).toBe(expected);
  });

  it('has unique lower-case sized keywords', () => {
    const keywords = ProxyCatalog.ALL.map(k => k.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
    for (const k of ProxyCatalog.ALL) {
      expect(k.keyword).toBe(k.keyword.toLowerCase());
      expect(k.sizeU > 0 && k.sizeV > 0).toBe(true);
      expect(ProxyCatalog.find(k.keyword.toUpperCase())).toBe(k);
    }
    expect(ProxyCatalog.find('nope')).toBeNull();
    expect(ProxyCatalog.normalise('  Brick ')).toBe('brick');
    expect(ProxyCatalog.normalise(' ')).toBeNull();
  });
});

describe('MaterialData', () => {
  it('keeps referenced textures and drops the rest when the table changes', () => {
    const a = cleanMaterial({ name: 'A', texture: 'textures/a.jpg', textureState: 'embedded' });
    const b = cleanMaterial({ name: 'B', texture: 'textures/b.jpg', textureState: 'embedded' });
    const data: MaterialData = {
      materials: [a, b], vertexMaterial: new Uint16Array([0, 1]), vertexUv: new Float32Array(4),
      textures: new Map([['textures/a.jpg', new Uint8Array([1])], ['textures/b.jpg', new Uint8Array([2])]]), textureMaxSize: 512
    };
    const changed = withMaterials(data, [a, { ...b, texture: 'textures/c.jpg' }], new Map([['textures/c.jpg', new Uint8Array([3])]]));
    expect([...changed.textures.keys()].sort()).toEqual(['textures/a.jpg', 'textures/c.jpg']);
    expect(changed.vertexMaterial).toBe(data.vertexMaterial);
    expect(() => withMaterials(data, [a])).toThrow();
  });
});
