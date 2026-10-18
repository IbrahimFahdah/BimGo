import { describe, expect, it } from 'vitest';
import { ClashEngine, type ClashItem, ClashItems, type ClashJob, type ClashRunResult } from '../src/core/clashes/ClashEngine';
import { ClashFiles } from '../src/core/clashes/ClashFiles';
import { ClashFraming } from '../src/core/clashes/ClashFraming';
import { ClashGeometry, ClashTriangle, ClosestResult, CrossResult } from '../src/core/clashes/ClashGeometry';
import { ClashMerge } from '../src/core/clashes/ClashMerge';
import {
  allRules, ClashCommentRules, clashKey, ClashKind, type ClashRecord, ClashStatus, copySet, emptyClashDocument, findTest, isSelfTest, newClash,
  newElementRef, newRule, newSet, newTest, type RuleGroup, RuleField, RuleOp, ruleIsComplete, setRuleField, setRuleOperator, toggleRuleValue
} from '../src/core/clashes/ClashModels';
import { SearchSets } from '../src/core/clashes/SearchSets';
import { BimGoReader } from '../src/core/format/BimGoReader';
import { writeBimGo } from '../src/core/format/BimGoWriter';
import { CommentPriority, CommentStatus, readBookmarkDocument, readCommentDocument } from '../src/core/format/DocumentModels';
import { EditJournal } from '../src/core/edits/EditJournal';
import { Mat4 } from '../src/core/math/Matrix4x4';
import { type Vec3, vec3 } from '../src/core/math/Vector';
import { findCategory } from '../src/core/scene/CategoryCatalog';
import { EMPTY_LIBRARY } from '../src/core/scene/FamilyLibrary';
import { EMPTY_LIGHTING } from '../src/core/scene/LightingData';
import type { LinkInfo } from '../src/core/scene/LinkInfo';
import { EMPTY_MATERIALS } from '../src/core/scene/MaterialData';
import { ParameterTable } from '../src/core/scene/ModelInfo';
import { Aabb, type ElementRecord, PhaseRole, type SceneData, SceneGeometry } from '../src/core/scene/SceneData';
import { transformBounds } from '../src/engine/physics/DynamicSet';
import { buildGeometry, buildZip } from './zipFixture';

// Port of tests/BimGo.Core.Tests/ClashTests.cs (Round C): clash detection on known geometry (closed boxes, optionally
// with subdivided faces so large elements take the triangle-tree path), hard and clearance tests, skipped pairs, the
// model as walked, search sets, merging across runs, storage in a .bimgo and reports.

const HARD = 0.005;

interface BoxSpec {
  min: Vec3;
  max: Vec3;
  catalog?: string;
  id?: number;
  hostId?: number;
  link?: number;
  subdivide?: number;
  familyType?: string;
  level?: string;
}

const box = (min: Vec3, max: Vec3, catalog = 'ducts', extra: Partial<BoxSpec> = {}): BoxSpec => ({ min, max, catalog, ...extra });

/** A scene of closed boxes (outward normals; each face split n × n into two triangles per cell). */
function scene(...boxes: BoxSpec[]): SceneData {
  const positions: number[][] = [];
  const indices: number[] = [];
  const elements: ElementRecord[] = boxes.map((b, e) => {
    const start = indices.length;
    addBox(positions, indices, b.min, b.max, b.subdivide ?? 1);
    const def = findCategory(b.catalog ?? 'ducts')!;
    return {
      elementId: b.id ?? 1000 + e, uniqueId: `uid-${e}`, ifcGuid: '', hostId: b.hostId ?? 0, name: def.key, categoryName: def.label,
      familyType: b.familyType ?? 'Family: Type', levelName: b.level ?? 'Level 1', categoryIndex: def.index,
      opaqueStart: start, opaqueCount: indices.length - start, transparentStart: 0, transparentCount: 0,
      bounds: new Aabb(vec3(b.min.x, b.min.y, b.min.z), vec3(b.max.x, b.max.y, b.max.z)), isProxy: false, movable: true, moveBlockReason: null,
      pivot: vec3(), phase: PhaseRole.Existing, link: b.link ?? 0, isLibraryTemplate: false
    };
  });
  const link: LinkInfo = {
    index: 1, name: 'Structure.rvt : 1', title: 'Structure', instanceId: 77, instanceUniqueId: 'link-uid', modelKey: '', modelPath: '',
    originX: 0, originY: 0, originZ: 0, basisX: vec3(1, 0, 0), basisY: vec3(0, 1, 0), basisZ: vec3(0, 0, 1), phaseName: null,
    existingPhaseName: null, elementCount: 0, roomCount: 0
  };
  return {
    geometry: new SceneGeometry(buildGeometry(positions, indices).subarray(24, 24 + positions.length * 28), Uint32Array.from(indices)),
    elements, levels: [{ name: 'Level 1', elevation: 0, isStorey: true }], grids: [], rooms: [], phaseId: -1, phaseName: null, existingPhaseId: -1, existingPhaseName: null,
    phaseNote: null, spawn: null, bounds: new Aabb(vec3(-10, -10, -10), vec3(10, 10, 10)), originOffset: vec3(100, 200, 300),
    modelTitle: 'Clash Model', commentsPath: null, provenance: {} as SceneData['provenance'], site: {} as SceneData['site'], links: [link],
    lighting: EMPTY_LIGHTING, materials: EMPTY_MATERIALS, library: EMPTY_LIBRARY, parameters: ParameterTable.empty, categoryLoaded: [],
    categoryElementCounts: [], sourceView: null, proxyCount: 0, skippedCount: 0, extractionSeconds: 0
  };
}

function addBox(positions: number[][], indices: number[], min: Vec3, max: Vec3, n: number): void {
  const d = vec3(max.x - min.x, max.y - min.y, max.z - min.z);
  const face = (o: Vec3, u: Vec3, v: Vec3) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const p = vec3(o.x + u.x * i / n + v.x * j / n, o.y + u.y * i / n + v.y * j / n, o.z + u.z * i / n + v.z * j / n);
        const a = vec3(p.x + u.x / n, p.y + u.y / n, p.z + u.z / n);
        const c = vec3(p.x + v.x / n, p.y + v.y / n, p.z + v.z / n);
        const bb = vec3(a.x + v.x / n, a.y + v.y / n, a.z + v.z / n);
        const k = positions.length;
        positions.push([p.x, p.y, p.z], [a.x, a.y, a.z], [bb.x, bb.y, bb.z], [c.x, c.y, c.z]);
        indices.push(k, k + 1, k + 2, k, k + 2, k + 3);
      }
    }
  };
  face(min, vec3(0, d.y, 0), vec3(d.x, 0, 0));
  face(vec3(min.x, min.y, max.z), vec3(d.x, 0, 0), vec3(0, d.y, 0));
  face(min, vec3(d.x, 0, 0), vec3(0, 0, d.z));
  face(vec3(min.x, max.y, min.z), vec3(0, 0, d.z), vec3(d.x, 0, 0));
  face(min, vec3(0, 0, d.z), vec3(0, d.y, 0));
  face(vec3(max.x, min.y, min.z), vec3(0, d.y, 0), vec3(0, 0, d.z));
}

const itemsOf = (s: SceneData): ClashItem[] => s.elements.map((_, i) => ClashItems.static(s, i));

function run(s: SceneData, a: number[], b: number[] | null, kind = ClashKind.HARD, tolerance = HARD, items: ClashItem[] | null = null): Promise<ClashRunResult> {
  return ClashEngine.run({ scene: s, items: items ?? itemsOf(s), setA: a, setB: b, kind, tolerance });
}

const BEAM = box(vec3(0, 0, 2.6), vec3(4, 0.3, 3.0), 'framing');
const DUCT = box(vec3(1.8, -2, 2.7), vec3(2.2, 2, 2.9), 'ducts');
const ONE = vec3(1, 1, 1), ZERO = vec3(0, 0, 0);

describe('Clash geometry', () => {
  it('tells crossing, touching and distance apart', () => {
    const t = ClashTriangle.make(vec3(0, 0, 0), vec3(2, 0, 0), vec3(0, 2, 0));
    const crossing = ClashTriangle.make(vec3(0.5, 0.5, -1), vec3(0.5, 0.5, 1), vec3(1.5, 0.5, 0));
    const out = new CrossResult();
    expect(ClashGeometry.crosses(t, crossing, out)).toBe(true);
    expect(out.proper).toBe(true);

    const standing = ClashTriangle.make(vec3(0.5, 0.5, 0), vec3(0.6, 0.5, 1), vec3(0.5, 0.6, 1));
    if (ClashGeometry.crosses(t, standing, out)) { expect(out.proper).toBe(false); }

    const coplanar = ClashTriangle.make(vec3(0.2, 0.2, 0), vec3(1, 0.2, 0), vec3(0.2, 1, 0));
    expect(ClashGeometry.crosses(t, coplanar, out)).toBe(false);

    const above = ClashTriangle.make(vec3(0, 0, 0.3), vec3(2, 0, 0.3), vec3(0, 2, 0.3));
    expect(ClashGeometry.distance(t, above, new ClosestResult())).toBeCloseTo(0.3, 5);
  });

  it('finds points inside a closed box', () => {
    const positions: number[][] = [], indices: number[] = [];
    addBox(positions, indices, ZERO, ONE, 3);
    const mesh: ClashTriangle[] = [];
    for (let k = 0; k < indices.length; k += 3) {
      const [a, b, c] = [positions[indices[k]], positions[indices[k + 1]], positions[indices[k + 2]]];
      mesh.push(new ClashTriangle().set(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]));
    }
    expect(ClashGeometry.inside(0.5, 0.5, 0.5, mesh)).toBe(true);
    expect(ClashGeometry.inside(0.999, 0.999, 0.999, mesh)).toBe(true);
    expect(ClashGeometry.inside(1.5, 0.5, 0.5, mesh)).toBe(false);
  });
});

describe('Hard tests', () => {
  it('a duct through a beam: depth and point', async () => {
    const result = await run(scene(BEAM, DUCT), [0], [1]);
    expect(result.hits.length).toBe(1);
    const hit = result.hits[0];
    expect(hit.itemA).toBe(0);
    expect(hit.crossing).toBe(true);
    expect(hit.distance).toBeCloseTo(0.2, 2); // the duct's height is the narrowest width
    expect(Math.abs(hit.point.x - 2)).toBeLessThan(0.05);
    expect(Math.abs(hit.point.y - 0.15)).toBeLessThan(0.05);
    expect(Math.abs(hit.point.z - 2.8)).toBeLessThan(0.05);
  });

  it('touching and shallow follow the tolerance', async () => {
    const a = box(ZERO, ONE, 'framing');
    expect((await run(scene(a, box(vec3(1, 0, 0), vec3(2, 1, 1))), [0], [1])).hits.length).toBe(0);
    const overlap3mm = scene(a, box(vec3(0.997, 0, 0), vec3(2, 1, 1)));
    expect((await run(overlap3mm, [0], [1])).hits.length).toBe(0);
    const tight = await run(overlap3mm, [0], [1], ClashKind.HARD, 0.001);
    expect(tight.hits.length).toBe(1);
    expect(Math.abs(tight.hits[0].distance - 0.003)).toBeLessThan(0.0005);
  });

  it('a pipe sunk into a slab counts by its buried corners', async () => {
    const pipe = box(vec3(0.5, 1, 0.16), vec3(3.5, 1.1, 0.26), 'pipes');
    for (const subdivide of [1, 8]) { // 8: 768 triangles, the triangle-tree path
      const slab = box(ZERO, vec3(4, 4, 0.2), 'floors', { subdivide });
      const result = await run(scene(slab, pipe), [0], [1]);
      expect(result.hits.length, `subdivide ${subdivide}`).toBe(1);
      expect(Math.abs(result.hits[0].distance - 0.04)).toBeLessThan(0.002);
    }
    const shallow = box(vec3(0.5, 1, 0.197), vec3(3.5, 1.1, 0.3), 'pipes');
    expect((await run(scene(box(ZERO, vec3(4, 4, 0.2), 'floors'), shallow), [0], [1])).hits.length).toBe(0);
  });

  it('leaves a contained element out', async () => {
    expect((await run(scene(box(ZERO, vec3(4, 4, 4), 'floors'), box(ONE, vec3(2, 2, 2), 'pipes')), [0], [1])).hits.length).toBe(0);
  });
});

describe('Clearance tests', () => {
  it('reports gaps, crossings and touching', async () => {
    const gap = scene(box(ZERO, ONE), box(vec3(1.03, 0, 0), vec3(2, 1, 1)));
    const near = await run(gap, [0], [1], ClashKind.CLEARANCE, 0.05);
    expect(near.hits.length).toBe(1);
    expect(near.hits[0].crossing).toBe(false);
    expect(near.hits[0].distance).toBeCloseTo(0.03, 3);
    expect((await run(gap, [0], [1], ClashKind.CLEARANCE, 0.02)).hits.length).toBe(0);

    const crossing = await run(scene(BEAM, DUCT), [0], [1], ClashKind.CLEARANCE, 0.05);
    expect(crossing.hits.length).toBe(1);
    expect(crossing.hits[0].crossing).toBe(true);

    const touching = await run(scene(box(ZERO, ONE), box(vec3(1, 0, 0), vec3(2, 1, 1))), [0], [1], ClashKind.CLEARANCE, 0.05);
    expect(touching.hits.length).toBe(1);
    expect(touching.hits[0].crossing).toBe(false);
    expect(touching.hits[0].distance).toBeCloseTo(0, 5);
  });
});

describe('Clash pairs', () => {
  it('skips a host and its insert, same model only', async () => {
    const wall = box(ZERO, vec3(4, 0.2, 3), 'walls', { id: 500 });
    const door = box(vec3(1, -0.1, 0), vec3(2, 0.3, 2.1), 'doors', { id: 600, hostId: 500 });
    expect((await run(scene(wall, door), [0], [1])).hits.length).toBe(0);
    expect((await run(scene(wall, { ...door, hostId: 0 }), [0], [1])).hits.length).toBe(1);
    expect((await run(scene(wall, { ...door, link: 1 }), [0], [1])).hits.length).toBe(1);
  });

  it('counts self tests and shared members once', async () => {
    const s = scene(box(ZERO, vec3(4, 0.4, 0.4)), box(vec3(1, -1, 0.1), vec3(1.4, 1, 0.3)), box(vec3(8, 8, 8), vec3(9, 9, 9)));
    expect((await run(s, [0, 1, 2], null)).hits.length).toBe(1);
    expect((await run(s, [0, 1], [0, 1, 2])).hits.length).toBe(1);
  });

  it('tests the model as walked: moved elements and clones', async () => {
    const s = scene(BEAM, DUCT);
    const items = itemsOf(s);
    const away = Mat4.createTranslation(vec3(3, 0, 0));
    items[1] = ClashItems.moved(1, away, transformBounds(s.elements[1].bounds, away), 0);
    expect((await run(s, [0], [1], ClashKind.HARD, HARD, items)).hits.length).toBe(0);

    const withClone = [...items, ClashItems.moved(1, Mat4.identity(), s.elements[1].bounds, 7)];
    const job: ClashJob = { scene: s, items: withClone, setA: [0], setB: [1, 2] };
    const result = await ClashEngine.run(job);
    expect(result.hits.length).toBe(1);
    const record = ClashMerge.toRecords(job, result, 't')[0];
    expect(record.b.cloneKey).toBe(7);
    expect(clashKey(record)).toContain('/clone:7');
  });

  it('stops at the limit', async () => {
    const specs = [box(ZERO, vec3(10, 10, 0.2), 'floors')];
    for (let i = 0; i < 6; i++) { specs.push(box(vec3(i + 0.2, 1, 0.1), vec3(i + 0.5, 2, 0.5), 'pipes')); }
    const s = scene(...specs);
    const result = await ClashEngine.run({ scene: s, items: itemsOf(s), setA: [0], setB: [1, 2, 3, 4, 5, 6], maxClashes: 3 });
    expect(result.truncated).toBe(true);
    expect(result.hits.length).toBe(3);
  });
});

const rule = (field: string, op: string, ...values: string[]) => newRule(field, op, values);
const legacy = (field: string, value: string, extra: { exclude?: boolean; contains?: boolean } = {}) =>
  ({ ...newRule(field, null, []), value, exclude: extra.exclude ?? false, contains: extra.contains ?? false });

describe('Search sets', () => {
  it('include / exclude rules and fields', () => {
    const s = scene(
      box(ZERO, ONE, 'ducts', { familyType: 'Rectangular Duct: 600x300', level: 'Level 1' }),
      box(ZERO, ONE, 'pipes', { familyType: 'Pipe Types: Copper', level: 'Level 2' }),
      box(ZERO, ONE, 'framing', { familyType: '310UB40', level: 'Level 2', link: 1 }));

    const services = SearchSets.setOfCatalog('Services', ['ducts', 'pipes']);
    expect(SearchSets.elementsIn(services, s)).toEqual([0, 1]);
    services.rules.push(legacy(RuleField.LEVEL, 'Level 2', { exclude: true }));
    expect(SearchSets.elementsIn(services, s)).toEqual([0]);

    const all = { ...newSet(), matchAll: true, rules: [legacy(RuleField.LEVEL, 'level 2'), legacy(RuleField.LINK, 'Structure')] };
    expect(SearchSets.elementsIn(all, s)).toEqual([2]);

    const family = { ...newSet(), rules: [legacy(RuleField.FAMILY, 'Rectangular Duct'), legacy(RuleField.TYPE, '310UB', { contains: true })] };
    expect(SearchSets.elementsIn(family, s)).toEqual([0, 2]);

    const host = { ...newSet(), rules: [legacy(RuleField.LINK, '')] };
    expect(SearchSets.elementsIn(host, s)).toEqual([0, 1]);
    expect(SearchSets.elementsIn(newSet(), s).length).toBe(3);
    expect(SearchSets.splitFamilyType('Basic Wall')).toEqual({ family: '', type: 'Basic Wall' });
  });

  it('seeds the starter tests', () => {
    const document = SearchSets.seeded();
    expect(document.sets.length).toBe(2);
    expect(document.tests.length).toBe(2);
    expect(isSelfTest(document.tests[0])).toBe(false);
    expect(isSelfTest(document.tests[1])).toBe(true);
    expect(document.tests.every(t => t.kind === ClashKind.HARD && Math.abs(t.tolerance - 0.005) < 1e-9)).toBe(true);
    for (const key of [...SearchSets.STRUCTURE_KEYS, ...SearchSets.SERVICES_KEYS]) { expect(findCategory(key), key).not.toBeNull(); }
  });

  it('operators: not rules always subtract', () => {
    const s = scene(
      box(ZERO, ONE, 'ducts', { familyType: 'Rectangular Duct: 600x300', level: 'Level 1' }),
      box(ZERO, ONE, 'pipes', { familyType: 'Pipe Types: Copper', level: 'Level 2' }),
      box(ZERO, ONE, 'framing', { familyType: '310UB40', level: 'Level 3' }),
      box(ZERO, ONE, 'walls', { familyType: 'Generic - 200mm', level: 'Level 2' }));
    const set = (matchAll: boolean, ...rules: ReturnType<typeof rule>[]) => ({ ...newSet(), matchAll, rules });

    expect(SearchSets.elementsIn(set(false, rule(RuleField.CATALOG, RuleOp.IS_ONE_OF, 'ducts', 'pipes')), s)).toEqual([0, 1]);
    expect(SearchSets.elementsIn(set(false, rule(RuleField.CATALOG, RuleOp.IS_NOT_ANY_OF, 'ducts', 'pipes')), s)).toEqual([2, 3]);
    expect(SearchSets.elementsIn(set(false, rule(RuleField.CATALOG, RuleOp.IS, 'ducts'), rule(RuleField.CATALOG, RuleOp.IS_NOT, 'walls')), s)).toEqual([0]);
    expect(SearchSets.elementsIn(set(false, rule(RuleField.LEVEL, RuleOp.IS, 'level 2'), rule(RuleField.CATALOG, RuleOp.IS_NOT, 'walls')), s)).toEqual([1]);

    const types = set(false, rule(RuleField.TYPE, RuleOp.CONTAINS, '600'), rule(RuleField.TYPE, RuleOp.CONTAINS, 'UB'));
    expect(SearchSets.elementsIn(types, s)).toEqual([0, 2]);
    types.rules.push(rule(RuleField.TYPE, RuleOp.NOT_CONTAINS, '310'));
    expect(SearchSets.elementsIn(types, s)).toEqual([0]);

    const unfinished = set(false, rule(RuleField.CATALOG, RuleOp.IS), rule(RuleField.TYPE, RuleOp.CONTAINS, ' '));
    expect(unfinished.rules.some(ruleIsComplete)).toBe(false);
    expect(SearchSets.elementsIn(unfinished, s).length).toBe(4);
    unfinished.rules.push(rule(RuleField.LEVEL, RuleOp.IS_NOT, 'Level 2'));
    expect(SearchSets.elementsIn(unfinished, s)).toEqual([0, 2]);

    const list = rule(RuleField.CATALOG, RuleOp.IS_ONE_OF, 'ducts', 'pipes');
    setRuleOperator(list, RuleOp.IS_NOT_ANY_OF);
    expect(list.values.length).toBe(2);
    expect(list.exclude && !list.contains && list.value === 'ducts').toBe(true);
    setRuleOperator(list, RuleOp.IS);
    expect(list.values).toEqual(['ducts']);
    setRuleOperator(list, RuleOp.IS_ONE_OF);
    toggleRuleValue(list, 'Pipes');
    toggleRuleValue(list, 'DUCTS');
    expect(list.values).toEqual(['Pipes']);
    setRuleField(list, RuleField.LEVEL);
    expect(list.values.length).toBe(0);
  });

  it('groups: any / all and not inside', () => {
    const s = scene(
      box(ZERO, ONE, 'ducts', { familyType: 'Rectangular Duct: 600x300', level: 'Level 1' }),
      box(ZERO, ONE, 'pipes', { familyType: 'Pipe Types: Copper', level: 'Level 2' }),
      box(ZERO, ONE, 'framing', { familyType: '310UB40', level: 'Level 3' }),
      box(ZERO, ONE, 'walls', { familyType: 'Generic - 200mm', level: 'Level 2' }));
    const group = (matchAll: boolean, ...rules: ReturnType<typeof rule>[]): RuleGroup => ({ matchAll, rules, groups: null });

    const orOfAnds = { ...newSet(), matchAll: false, groups: [
      group(true, rule(RuleField.CATALOG, RuleOp.IS, 'ducts'), rule(RuleField.LEVEL, RuleOp.IS, 'Level 1')),
      group(true, rule(RuleField.CATALOG, RuleOp.IS, 'walls'), rule(RuleField.LEVEL, RuleOp.IS, 'Level 2'))] };
    expect(SearchSets.elementsIn(orOfAnds, s)).toEqual([0, 3]);

    const andOfOrs = { ...newSet(), matchAll: true, groups: [
      group(false, rule(RuleField.CATALOG, RuleOp.IS, 'ducts'), rule(RuleField.CATALOG, RuleOp.IS, 'pipes')),
      group(false, rule(RuleField.LEVEL, RuleOp.IS, 'Level 2'), rule(RuleField.LEVEL, RuleOp.IS, 'Level 3'))] };
    expect(SearchSets.elementsIn(andOfOrs, s)).toEqual([1]);

    const notInside = { ...newSet(), matchAll: false, rules: [rule(RuleField.CATALOG, RuleOp.IS, 'framing')],
      groups: [group(true, rule(RuleField.LEVEL, RuleOp.IS_NOT, 'Level 2'), rule(RuleField.CATALOG, RuleOp.IS_NOT, 'framing'))] };
    expect(SearchSets.elementsIn(notInside, s)).toEqual([0, 2]);
    expect(SearchSets.elementsIn({ ...newSet(), groups: [group(false, rule(RuleField.LEVEL, RuleOp.IS_NOT, 'Level 2'))] }, s)).toEqual([0, 2]);

    const topNot = { ...newSet(), rules: [rule(RuleField.LEVEL, RuleOp.IS_NOT, 'Level 1')], groups: [group(false, rule(RuleField.CATALOG, RuleOp.IS_ONE_OF, 'ducts', 'pipes'))] };
    expect(SearchSets.elementsIn(topNot, s)).toEqual([1]);

    expect(SearchSets.elementsIn({ ...newSet(), matchAll: true, groups: [group(true, rule(RuleField.CATALOG, RuleOp.IS))] }, s).length).toBe(4);

    const copy = copySet(orOfAnds, true);
    setRuleOperator(copy.groups![0].rules[0], RuleOp.IS_NOT);
    expect(orOfAnds.groups[0].rules[0].op).toBe(RuleOp.IS);
    expect(allRules(copy).length).toBe(4);
  });

  it('round-trips groups through the file', () => {
    const document = SearchSets.seeded();
    expect(new TextDecoder().decode(ClashFiles.serialize(document))).not.toContain('"groups"');
    document.sets[0].groups = [group(true, rule(RuleField.LEVEL, RuleOp.IS_NOT, 'Level 2')), { matchAll: false, rules: [], groups: null }];
    const again = ClashFiles.parse(ClashFiles.serialize(document)).document!;
    expect(again.sets[0].groups!.length).toBe(2);
    expect(again.sets[0].groups![0].matchAll).toBe(true);
    expect(again.sets[0].groups![0].rules[0].op).toBe(RuleOp.IS_NOT);
    expect(again.sets[0].groups![0].rules[0].values).toEqual(['Level 2']);
    expect(again.sets[0].groups![1].rules.length).toBe(0);
    expect(again.sets[1].groups).toBeNull();
    again.sets[0].groups = [];
    expect(new TextDecoder().decode(ClashFiles.serialize(again))).not.toContain('"groups"');

    function group(matchAll: boolean, ...rules: ReturnType<typeof rule>[]): RuleGroup { return { matchAll, rules, groups: null }; }
  });

  it('reads older rules as operators', () => {
    const json = '{"format":"bimgo-clashes","version":1,"sets":[{"id":"s1","name":"Old","rules":['
      + '{"field":"catalog","value":"ducts"},{"field":"level","value":"Level 2","exclude":true},'
      + '{"field":"type","value":"600","contains":true},{"field":"type","value":"x","contains":true,"exclude":true},'
      + '{"field":"link","value":""}]}],"tests":[],"clashes":[],"runs":[]}';
    const document = ClashFiles.parse(json).document!;
    const rules = document.sets[0].rules;
    expect(rules.map(r => r.op)).toEqual([RuleOp.IS, RuleOp.IS_NOT, RuleOp.CONTAINS, RuleOp.NOT_CONTAINS, RuleOp.IS]);
    expect(rules[0].values).toEqual(['ducts']);
    expect(rules[4].values).toEqual(['']);
    expect(ruleIsComplete(rules[4])).toBe(true);

    setRuleOperator(rules[0], RuleOp.IS_ONE_OF);
    toggleRuleValue(rules[0], 'pipes');
    const again = ClashFiles.parse(ClashFiles.serialize(document)).document!;
    expect(again.sets[0].rules[0].values).toEqual(['ducts', 'pipes']);
    expect(again.sets[0].rules[0].op).toBe(RuleOp.IS_ONE_OF);
    expect(again.sets[0].rules[0].value).toBe('ducts');
    expect(again.sets[0].rules[1].exclude).toBe(true);
  });

  it('keeps sets A and B as picked', () => {
    const document = SearchSets.seeded();
    const structure = document.sets[0].id, services = document.sets[1].id;
    const test = document.tests[0];
    test.setA = services;
    expect(isSelfTest(test)).toBe(true);
    expect(test.setB).toBe(services);
    test.setA = structure;
    expect(isSelfTest(test)).toBe(false);
    test.setB = structure;
    const again = ClashFiles.parse(ClashFiles.serialize(document)).document!;
    expect(again.tests[0].setA).toBe(structure);
    expect(again.tests[0].setB).toBe(structure);
    expect(isSelfTest(again.tests[0])).toBe(true);
    expect(again.tests[1].setB).toBeNull();
    expect(isSelfTest(again.tests[1])).toBe(true);
  });
});

const clash = (a: string, b: string): ClashRecord => newClash('', newElementRef(a), newElementRef(b));
const at = (hours: number) => new Date(Date.UTC(2026, 9, 12) + hours * 3600_000).toISOString();

describe('Clash merge', () => {
  it('reset: the next run starts fresh', () => {
    const document = emptyClashDocument();
    const test = newTest('T'), other = newTest('U');
    document.tests.push(test, other);
    ClashMerge.apply(document, test, [clash('a', 'b')], true, at(0), 'm1', 1, 1, 1);
    ClashMerge.apply(document, test, [clash('a', 'b')], true, at(1), 'm1', 1, 1, 1);
    ClashMerge.apply(document, other, [clash('c', 'd')], true, at(0), 'm1', 1, 1, 1);
    const ab = document.clashes.find(c => c.testId === test.id)!;
    ClashMerge.setDetails(ab, 'Services', 'Drop it', 'gavin', at(2));
    expect(ab.status).toBe(ClashStatus.ACTIVE);
    expect(ClashMerge.hasResults(document, test)).toBe(true);

    expect(ClashMerge.resetTest(document, test)).toBe(1);
    expect(ClashMerge.hasResults(document, test)).toBe(false);
    expect(test.lastRunUtc).toBeNull();
    expect(test.lastRunModel).toBeNull();
    expect(document.runs.filter(r => r.testId === test.id).length).toBe(0);
    expect(document.clashes.filter(c => c.testId === other.id).length).toBe(1);
    expect(document.runs.filter(r => r.testId === other.id).length).toBe(1);

    const again = ClashMerge.apply(document, test, [clash('a', 'b')], true, at(3), 'm1', 1, 1, 1);
    expect(again.new).toBe(1);
    const back = document.clashes.find(c => c.testId === test.id)!;
    expect(back.status).toBe(ClashStatus.NEW);
    expect(back.assignedTo).toBeNull();
    expect(back.notes).toBeNull();
  });

  it('statuses across runs', () => {
    const document = emptyClashDocument();
    const test = newTest('T');
    document.tests.push(test);
    const first = ClashMerge.apply(document, test, [clash('a', 'b'), clash('c', 'd')], true, at(0), 'm1', 2, 2, 1);
    expect(first.new).toBe(2);
    expect(document.clashes.every(c => c.status === ClashStatus.NEW)).toBe(true);

    ClashMerge.apply(document, test, [clash('b', 'a'), clash('c', 'd')], true, at(1), 'm1', 2, 2, 1);
    expect(document.clashes.every(c => c.status === ClashStatus.ACTIVE)).toBe(true);
    const cd = document.clashes.find(c => c.a.uniqueId === 'c')!;
    ClashMerge.setStatus(cd, ClashStatus.REVIEWED, 'gavin', at(2));
    ClashMerge.setDetails(cd, 'Services', 'Drop the duct', 'gavin', at(2));

    ClashMerge.apply(document, test, [], false, at(3), 'm2', 2, 2, 1);
    expect(document.clashes.some(c => c.status === ClashStatus.RESOLVED)).toBe(false);

    const gone = ClashMerge.apply(document, test, [], true, at(4), 'm2', 2, 2, 1);
    expect(gone.newlyResolved).toBe(2);
    expect(cd.assignedTo).toBe('Services');
    expect(cd.status).toBe(ClashStatus.RESOLVED);

    const back = ClashMerge.apply(document, test, [clash('c', 'd')], true, at(5), 'm3', 2, 2, 1);
    expect(back.reopened).toBe(1);
    expect(cd.status).toBe(ClashStatus.ACTIVE);
    expect(cd.resolvedUtc).toBeNull();
    expect(document.clashes.length).toBe(2);
    expect(document.runs.length).toBe(5);
    expect(test.lastRunModel).toBe('m3');
    expect(document.runs[document.runs.length - 1].byStatus).toEqual([0, 1, 0, 0, 1]);
  });
});

describe('Clash framing, values and keys', () => {
  it('a section around the region', () => {
    const beam = new Aabb(vec3(0, 0, 2.6), vec3(4, 0.3, 3.0));
    const duct = new Aabb(vec3(1.8, -2, 2.7), vec3(2.2, 2, 2.9));
    const section = ClashFraming.sectionFor(beam, duct, vec3(2, 0.15, 2.8));
    expect(Math.abs(section.min.x - (1.8 - 1.01))).toBeLessThan(0.02);
    expect(Math.abs(section.max.x - (2.2 + 1.01))).toBeLessThan(0.02);
    expect(section.size.y >= 2 - 1e-4 && section.size.z >= 2 - 1e-4).toBe(true);

    const gap = ClashFraming.sectionFor(new Aabb(ZERO, ONE), new Aabb(vec3(1.4, 0, 0), vec3(2, 1, 1)), vec3(1.2, 0.5, 0.5));
    expect(gap.min.x <= 1 && gap.max.x >= 1.4 && gap.min.x <= 1.2 && gap.max.x >= 1.2).toBe(true);
  });

  it('the camera looks across the long element', () => {
    const point = vec3(2, 0, 2.8);
    const duct = new Aabb(vec3(1.8, -5, 2.7), vec3(2.2, 5, 2.9));
    const cube = new Aabb(vec3(1.5, -0.5, 2.5), vec3(2.5, 0.5, 3.5));
    const view = ClashFraming.frame(point, duct, cube, ClashFraming.sectionFor(duct, cube, point), 0.2);
    expect(Math.hypot(view.eye.x - point.x, view.eye.y - point.y, view.eye.z - point.z)).toBeCloseTo(ClashFraming.DISTANCE, 3);
    expect(view.pitch).toBeCloseTo(-ClashFraming.DOWN_PITCH, 5);
    expect(Math.abs(Math.cos(view.yaw))).toBeCloseTo(1, 3);
    expect(view.eye.z > point.z).toBe(true);

    const blocked = ClashFraming.frame(point, duct, cube, Aabb.empty(), 0, (eye, target) => eye.x < target.x);
    expect(blocked.eye.x < point.x).toBe(true);
    expect(Math.abs(ClashFraming.angleBetween(Math.PI / 2, -Math.PI))).toBeCloseTo(Math.PI / 2, 5);
  });

  it('values and keys from the model', () => {
    const s = scene(
      box(ZERO, ONE, 'ducts', { familyType: 'Rectangular Duct: 600x300', level: 'Level 1' }),
      box(ZERO, ONE, 'ducts', { familyType: 'Rectangular Duct: 400x200', level: 'Level 2' }),
      box(ZERO, ONE, 'walls', { familyType: 'Generic - 200mm', level: 'Level 2', link: 1 }));
    const catalog = SearchSets.valuesOf(s, RuleField.CATALOG);
    expect(catalog.length).toBe(2);
    expect(catalog.find(v => v.value === 'ducts')!.count).toBe(2);
    expect(catalog.find(v => v.value === 'ducts')!.label).toBe(findCategory('ducts')!.label);
    const families = SearchSets.valuesOf(s, RuleField.FAMILY);
    expect(families.find(v => v.value === 'Rectangular Duct')!.count).toBe(2);
    expect(families.find(v => v.value.length === 0)!.count).toBe(1);
    const links = SearchSets.valuesOf(s, RuleField.LINK);
    expect(links.find(v => v.value.length === 0)!.count).toBe(2);
    expect(links.find(v => v.value === 'link-uid')!.label).toBe('Structure');

    expect(SearchSets.describe(legacy(RuleField.LEVEL, 'Level 2', { exclude: true }), s)).toBe('Level is not Level 2');
    expect(SearchSets.describe(rule(RuleField.CATALOG, RuleOp.IS_ONE_OF, 'ducts', 'pipes'), s))
      .toBe(`BimGo category is one of ${findCategory('ducts')!.label}, ${findCategory('pipes')!.label}`);
    expect(SearchSets.describe(rule(RuleField.TYPE, RuleOp.NOT_CONTAINS, '600'), s)).toBe('Type does not contain 600');
    expect(SearchSets.describe(legacy(RuleField.LINK, 'link-uid'), s)).toBe('Model is Structure');

    const items = itemsOf(s);
    s.elements.forEach((_, i) => { expect(ClashMerge.elementKey(s, i)).toBe(clashKeyOf(ClashMerge.refOf(s, items[i]))); });
    expect(ClashMerge.elementKey(s, 2).startsWith('link-uid/')).toBe(true);

    function clashKeyOf(ref: ReturnType<typeof ClashMerge.refOf>): string { return clashKey({ ...clash('', ''), a: ref, b: ref }).split('|')[1]; }
  });

  it('several clashes: stands back to see them all', () => {
    expect(ClashFraming.distanceToSee(new Aabb(vec3(-0.5, -0.5, -0.5), vec3(0.5, 0.5, 0.5)), 90, 16 / 9)).toBeCloseTo(ClashFraming.DISTANCE, 4);
    const large = new Aabb(vec3(-10, -10, -2), vec3(10, 10, 2));
    const distance = ClashFraming.distanceToSee(large, 90, 16 / 9);
    const radius = Math.hypot(20, 20, 4) * 0.5;
    const halfV = Math.atan(Math.tan(Math.PI / 4) / (16 / 9));
    expect(distance * Math.sin(halfV) >= radius).toBe(true);
    expect(distance < radius / Math.sin(halfV) * 1.1).toBe(true);
    expect(ClashFraming.distanceToSee(large, 110, 16 / 9) < distance).toBe(true);
    expect(ClashFraming.distanceToSee(Aabb.empty(), 90, 1.6)).toBeCloseTo(ClashFraming.DISTANCE, 4);
  });
});

describe('Clash storage and reports', () => {
  it('round-trips inside a .bimgo and stays untouched while dormant', async () => {
    const clashes = SearchSets.seeded();
    const record = clash('x', 'y');
    record.testId = clashes.tests[0].id;
    record.x = 1.5;
    record.notes = 'n';
    clashes.clashes.push(record);
    const bytes = ClashFiles.serialize(clashes);

    const source = buildZip({
      'manifest.json': JSON.stringify({ format: 'bimgo', formatVersion: 1, kind: 'revit-export', title: 'Box' }),
      'model.json': JSON.stringify({ originOffset: [0, 0, 0], boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], categories: [{ key: 'walls', loaded: true }] }),
      'elements.json': JSON.stringify({ elements: [{ id: 7, uniqueId: 'u7', name: 'Wall', category: 0, opaque: [0, 3], boundsMin: [0, 0, 0], boundsMax: [1, 1, 0] }] }),
      'geometry.bin': buildGeometry([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2])
    });
    const doc = await BimGoReader.read(source, 'Box.bimgo');
    expect(doc.clashes).toBeNull();
    const content = { comments: readCommentDocument(null), journal: new EditJournal([]), bookmarks: readBookmarkDocument(null), sun: null, visibility: null,
      materials: doc.scene.materials, savedBy: 'Ann' };
    const saved = await writeBimGo(doc, { ...content, clashes: bytes }, { generator: 'BimGo Web', version: 'test' }, 'save');
    const back = await BimGoReader.read(saved, 'Box.bimgo');
    expect([...back.clashes!]).toEqual([...bytes]);

    const parsed = ClashFiles.parse(back.clashes).document!;
    expect(parsed.tests.length).toBe(2);
    expect(parsed.clashes[0].notes).toBe('n');
    expect(clashKey(parsed.clashes[0])).toBe(clashKey(record));

    const none = await BimGoReader.read(await writeBimGo(doc, content, { generator: 'BimGo Web', version: 'test' }, 'save'), 'Box.bimgo');
    expect(none.clashes).toBeNull();

    expect(ClashFiles.parse('{"format":"other"}').error).not.toBeNull();
    expect(ClashFiles.parse('{ not json').error).not.toBeNull();
  });

  it('export / import: newer changes win', () => {
    const theirs = SearchSets.seeded();
    const testId = theirs.tests[0].id;
    const add = (doc: typeof theirs, a: string, b: string, status: string, updated: string | null, by: string | null = null) => {
      const c = clash(a, b);
      c.testId = testId;
      c.status = status;
      c.updated = updated;
      c.updatedBy = by;
      doc.clashes.push(c);
    };
    add(theirs, 'a', 'b', ClashStatus.APPROVED, at(2), 'them');
    add(theirs, 'c', 'd', ClashStatus.REVIEWED, at(0));
    add(theirs, 'e', 'f', ClashStatus.NEW, null);
    const report = ClashFiles.exportReport(theirs, 'Clash Model', 'key-1', 'BimGo test');
    expect(report).toContain(ClashFiles.REPORT_FORMAT);

    const ours = ClashFiles.parse(ClashFiles.serialize(SearchSets.seeded())).document!;
    ours.sets = theirs.sets.map(s => copySet(s));
    ours.tests = [{ ...newTest('Mine'), id: testId, setA: theirs.sets[0].id, setB: theirs.sets[1].id }];
    add(ours, 'b', 'a', ClashStatus.ACTIVE, at(1));
    add(ours, 'c', 'd', ClashStatus.ACTIVE, at(3));

    const read = ClashFiles.parse(report).document!;
    const result = ClashFiles.merge(read, ours, 'key-1');
    expect(result.clashesAdded).toBe(1);
    expect(result.clashesUpdated).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.testsAdded).toBe(1);
    expect(result.sameModel).toBe(true);
    expect(ours.clashes.find(c => c.a.uniqueId === 'b')!.status).toBe(ClashStatus.APPROVED);
    expect(ours.clashes.find(c => c.a.uniqueId === 'c')!.status).toBe(ClashStatus.ACTIVE);
    expect(findTest(ours, testId)!.name).toBe('Mine');
    expect(ClashFiles.merge(ClashFiles.parse(report).document!, ours, 'other-key').sameModel).toBe(false);
  });

  it('comment status follows the clash; priority by depth', () => {
    expect(ClashCommentRules.commentStatusFor(ClashStatus.NEW)).toBe(CommentStatus.OPEN);
    expect(ClashCommentRules.commentStatusFor(ClashStatus.ACTIVE)).toBe(CommentStatus.OPEN);
    expect(ClashCommentRules.commentStatusFor(ClashStatus.REVIEWED)).toBe(CommentStatus.IN_PROGRESS);
    expect(ClashCommentRules.commentStatusFor(ClashStatus.APPROVED)).toBe(CommentStatus.CLOSED);
    expect(ClashCommentRules.commentStatusFor(ClashStatus.RESOLVED)).toBe(CommentStatus.CLOSED);
    expect(ClashCommentRules.commentStatusFor('whatever')).toBe(CommentStatus.OPEN);
    const deep = { ...clash('a', 'b'), crossing: true, distance: 0.08 };
    expect(ClashCommentRules.priorityFor(deep, ClashKind.HARD)).toBe(CommentPriority.HIGH);
    expect(ClashCommentRules.priorityFor({ ...deep, distance: 0.05 }, ClashKind.HARD)).toBe(CommentPriority.NORMAL);
    expect(ClashCommentRules.priorityFor(deep, ClashKind.CLEARANCE)).toBe(CommentPriority.NORMAL);
    expect(ClashCommentRules.priorityFor({ ...deep, crossing: false }, ClashKind.HARD)).toBe(CommentPriority.NORMAL);
    expect(ClashCommentRules.priorityFor(null, ClashKind.HARD)).toBe(CommentPriority.NORMAL);
  });
});
