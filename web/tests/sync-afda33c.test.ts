import { describe, expect, it } from 'vitest';
import { ClashGroupAuto, ClashGrouping, ClashGroups, GroupBox } from '../src/core/clashes/ClashGroups';
import { ClashFiles } from '../src/core/clashes/ClashFiles';
import { ClashMerge } from '../src/core/clashes/ClashMerge';
import {
  type ClashElementRef, type ClashRecord, ClashStatus, type ClashTest, emptyClashDocument, newClash, newElementRef, newRule, newSet, newTest,
  normaliseRule, type RuleGroup, RuleField, RuleNumbers, RuleOp, ruleIsComplete, ruleValueCount, setRuleOperator
} from '../src/core/clashes/ClashModels';
import { ClashReportGroups, ClashReports, defaultReportOptions } from '../src/core/clashes/ClashReports';
import { ClashSetupFiles } from '../src/core/clashes/ClashSetupFiles';
import { SearchSets } from '../src/core/clashes/SearchSets';
import { cleanPath, newCameraKey, newCameraPath, readPathsDocument } from '../src/core/format/CameraPathModels';
import { readSunSettings, readVisibility, sunBlend, type SunTime } from '../src/core/format/DocumentModels';
import { Mat4 } from '../src/core/math/Matrix4x4';
import { type Vec3, vec2, vec3 } from '../src/core/math/Vector';
import {
  Appearance, AppearanceProfiler, BinMethod, cleanProfile, copyProfile, newProfile, newProfileRule, ProfileFiles, UnmatchedLook
} from '../src/core/scene/AppearanceProfiles';
import { CameraPathTimeline, cameraPathPoint, cameraPathSettings } from '../src/core/scene/CameraPathTimeline';
import { findCategory } from '../src/core/scene/CategoryCatalog';
import { EMPTY_LIBRARY } from '../src/core/scene/FamilyLibrary';
import { GrassField, grassTriangle } from '../src/core/scene/GrassField';
import { type GridLine, GridLayout, GridLevelMode, GridLocator, GridNodes, GridView, gridsFromJson, gridsToJson } from '../src/core/scene/GridData';
import { InputAction, InputCatalog, Situations } from '../src/core/scene/InputCatalog';
import { KeyMap } from '../src/core/scene/KeyMap';
import { EMPTY_LIGHTING } from '../src/core/scene/LightingData';
import type { LinkInfo } from '../src/core/scene/LinkInfo';
import { LunarPosition } from '../src/core/scene/LunarPosition';
import { EMPTY_MATERIALS, type SceneMaterial } from '../src/core/scene/MaterialData';
import { MaterialOverrides } from '../src/core/scene/MaterialOverrides';
import { ParameterTable } from '../src/core/scene/ModelInfo';
import { Aabb, type ElementRecord, type LevelInfo, PhaseRole, type SceneData, SceneGeometry } from '../src/core/scene/SceneData';
import { SolarPosition } from '../src/core/scene/SolarPosition';
import { TourTimeline, tourStop } from '../src/core/scene/TourTimeline';

// Ports of the upstream Core tests added between f19fbf2 and afda33c (GridTests, GridNodeTests, ClashGroupTests,
// ClashGroupToolTests, ClashSetupTests, ClashReportTests, AppearanceProfileTests, MaterialOverrideTests, GrassTests,
// NightSkyTests, SkyTests, CameraPathTests, TourTests and the ControlsTests additions).

const T0 = '2026-10-17T00:00:00.000Z';
const T1 = '2026-10-17T01:00:00.000Z';

// #region Fixtures

const level = (name: string, elevation: number, isStorey = true): LevelInfo => ({ name, elevation, isStorey });

function grid(name: string, points: [number, number][], extra: Partial<GridLine> = {}): GridLine {
  return { name, link: 0, points: points.map(([x, y]) => vec2(x, y)), bottom: -Infinity, top: Infinity, curved: false, ...extra };
}

const link: LinkInfo = {
  index: 1, name: 'Structure.rvt : 1', title: 'Structure', instanceId: 77, instanceUniqueId: 'link-uid', modelKey: '', modelPath: '',
  originX: 0, originY: 0, originZ: 0, basisX: vec3(1, 0, 0), basisY: vec3(0, 1, 0), basisZ: vec3(0, 0, 1), phaseName: null,
  existingPhaseName: null, elementCount: 0, roomCount: 0
};

function element(catalog: string, familyType: string, levelName: string, phase = PhaseRole.Existing, linkIndex = 0, template = false): ElementRecord {
  const def = findCategory(catalog)!;
  return {
    elementId: 0, uniqueId: '', ifcGuid: '', hostId: 0, name: '', categoryName: def.label, familyType, levelName, categoryIndex: def.index,
    opaqueStart: 0, opaqueCount: 0, transparentStart: 0, transparentCount: 0, bounds: new Aabb(vec3(), vec3()), isProxy: false, movable: true,
    moveBlockReason: null, pivot: vec3(), phase, link: linkIndex, isLibraryTemplate: template
  };
}

/** A parameter table from per-element name / value pairs. */
function parameters(rows: [string, string][][]): ParameterTable {
  const names: string[] = [], values: string[] = [];
  const intern = (list: string[], s: string) => { let i = list.indexOf(s); if (i < 0) { i = list.length; list.push(s); } return i; };
  return new ParameterTable(names, values, rows.map(r => r.length === 0 ? null : r.flatMap(([n, v]) => [intern(names, n), intern(values, v)])));
}

function sceneWith(elements: ElementRecord[], params = ParameterTable.empty, extra: Partial<SceneData> = {}): SceneData {
  return {
    geometry: new SceneGeometry(new Uint8Array(0), new Uint32Array(0)), elements, levels: [level('Level 1', 0), level('Level 2', 3)], grids: [], rooms: [],
    phaseId: -1, phaseName: null, existingPhaseId: -1, existingPhaseName: null, phaseNote: null, spawn: null, bounds: new Aabb(vec3(), vec3(1, 1, 1)),
    originOffset: vec3(), modelTitle: 'Model', commentsPath: null, provenance: {} as SceneData['provenance'], site: {} as SceneData['site'],
    links: [link], lighting: EMPTY_LIGHTING, materials: EMPTY_MATERIALS, library: EMPTY_LIBRARY, parameters: params, categoryLoaded: [],
    categoryElementCounts: [], sourceView: null, proxyCount: 0, skippedCount: 0, extractionSeconds: 0, ...extra
  };
}

/** Two walls, a door (new phase), a linked column with no parameters and a library template (AppearanceProfileTests.Scene). */
function profileScene(): SceneData {
  return sceneWith([
    element('walls', 'Basic Wall: Fire 60', 'Level 1'),
    element('walls', 'Basic Wall: Fire 120', 'Level 1'),
    element('doors', 'Single: 820', 'Level 2', PhaseRole.New),
    element('structcolumns', 'UC: 150', 'Level 2', PhaseRole.Unphased, 1),
    element('walls', 'Basic Wall: Fire 60', 'Level 1', PhaseRole.Existing, 0, true)
  ], parameters([
    [['Fire Rating', '60/60/60'], ['Mark', 'W1'], ['Width', '600 mm']],
    [['Fire Rating', '-/120/120'], ['Width', '1 200 mm']],
    [['Fire Rating', '60/60/60'], ['Mark', '  '], ['Width', '900 mm']],
    [],
    []
  ]));
}

function rule(field: string, op: string, parameter: string | null, ...values: string[]) {
  const r = newRule(field, op, values);
  r.parameter = parameter;
  return normaliseRule(r);
}

function ref(uid: string, id = 0, type = '', category = 'Ducts', lvl = ''): ClashElementRef {
  return { ...newElementRef(uid), elementId: id, familyType: type, category, level: lvl };
}

function clashOf(test: ClashTest, a: string | ClashElementRef, b: string | ClashElementRef, status: string = ClashStatus.ACTIVE): ClashRecord {
  const c = newClash(test.id, typeof a === 'string' ? ref(a) : a, typeof b === 'string' ? ref(b) : b);
  c.status = status;
  return c;
}

function newDocument() {
  const document = emptyClashDocument();
  const test = newTest('T');
  document.tests.push(test);
  return { document, test };
}

// #endregion

describe('grids (round A)', () => {
  const sample = () => [
    grid('A', [[0, 0], [0, 30]], { bottom: -0.5, top: 7.5 }),
    grid('1', [[-2, 5], [40, 5]]),
    grid('S1', [[10, 0], [12, 4], [15, 6]], { link: 1, curved: true, bottom: 0, top: 3.5 })
  ];

  it('round-trips grids.json and reads damaged grids safely', () => {
    const back = gridsFromJson(JSON.parse(JSON.stringify(gridsToJson(sample()))), 1);
    expect(back.length).toBe(3);
    expect(back[0]).toMatchObject({ name: 'A', link: 0, top: 7.5 });
    expect(Number.isFinite(back[1].bottom)).toBe(false);
    expect(back[2]).toMatchObject({ link: 1, curved: true });
    expect(back[2].points[2]).toEqual(vec2(15, 6));
    expect(gridsToJson([])).toBeNull();
    const damaged = gridsFromJson({ grids: [{ name: ' B ', link: 7, points: [0, 0, 0, 0, 5, 0], bottom: 3, top: 1 }, { points: [1, 1] }, null] }, 1);
    expect(damaged.length).toBe(1);
    expect(damaged[0]).toMatchObject({ name: 'B', link: 0 });
    expect(damaged[0].points.length).toBe(2);
    expect(Number.isFinite(damaged[0].top)).toBe(false);
  });

  it('shows grids by extent and picks levels per mode', () => {
    const g = sample();
    expect(GridLayout.showsAt(g[0], 7.54, true)).toBe(true);
    expect(GridLayout.showsAt(g[0], 10.5, true)).toBe(false);
    expect(GridLayout.showsAt(g[0], 10.5, false)).toBe(true);
    expect(GridLayout.showsAt(g[1], 100, true)).toBe(true);
    const levels = [level('L1', 0), level('L2', 3.5), level('Roof', 7), level('Parapet', 7.6, false)];
    const into: number[] = [];
    const shown = (mode: GridLevelMode, under: number, eye: number, storeys = true) => { GridLayout.shownLevels(levels, mode, under, eye, storeys, into); return [...into]; };
    expect(shown(GridLevelMode.Off, 1, 5)).toEqual([]);
    expect(shown(GridLevelMode.Underfoot, 3, 5)).toEqual([3]);
    expect(shown(GridLevelMode.All, 0, 5)).toEqual([0, 1, 2]);
    expect(shown(GridLevelMode.All, 0, 5, false)).toEqual([0, 1, 2, 3]);
    expect(shown(GridLevelMode.Above, 1, 5)).toEqual([2]);
    expect(shown(GridLevelMode.Above, 2, 8)).toEqual([]);
    expect(shown(GridLevelMode.Above, 2, 8, false)).toEqual([3]);
    expect(shown(GridLevelMode.Below, 2, 8)).toEqual([1]);
    expect(shown(GridLevelMode.Adjacent, 1, 5)).toEqual([0, 1, 2]);
    expect(shown(GridLevelMode.Nearest, 0, 6.2)).toEqual([2]);
    expect(GridLayout.next(GridLevelMode.Nearest)).toBe(GridLevelMode.All);
    const bounds = GridLayout.planBounds(g, 0, true, false)!;
    expect(bounds.min).toEqual(vec2(-4, -2));
    expect(bounds.max).toEqual(vec2(42, 32));
    expect(GridLayout.planBounds([g[2]], 1, true, false)).toBeNull();
  });

  it('chains multi-segment grids', () => {
    const line = GridLayout.chain([[vec2(10, 0), vec2(10, 10)], [vec2(10, 0), vec2(0, 0)], [vec2(20, 10), vec2(10, 10)]]);
    expect(line.length).toBe(4);
    const forward = [vec2(0, 0), vec2(10, 0), vec2(10, 10), vec2(20, 10)];
    expect(line[0].x === 0 ? line : [...line].reverse()).toEqual(forward);
  });

  it('cleans the view settings and keeps them in visibility.json', () => {
    for (const mode of GridLayout.PANEL_ORDER) {
      const s = GridView.defaults();
      GridView.setMode(s, mode);
      expect(GridView.mode(GridView.clean(s))).toBe(mode);
    }
    const bad = GridView.clean({ ...GridView.defaults(), levels: 'x', depth: 'y', colour: 'red', opacity: 5, width: 0, labelDistance: NaN, line: 'wavy' });
    expect(bad).toMatchObject({ levels: 'off', depth: 'faint', colour: '#4FC3F7', opacity: 1, width: 1, labelDistance: 120, line: 'solid' });
    expect(readVisibility({ grids: GridView.defaults() }).grids).toBeNull();
    const v = readVisibility({ grids: { levels: 'all', linkGrids: true, depth: 'xray', colour: 'ff0000' } });
    expect(v.grids).toMatchObject({ levels: 'all', linkGrids: true, depth: 'xray', colour: '#FF0000' });
  });
});

describe('grid intersections and locations (round B)', () => {
  const grids = () => [
    grid('A', [[0, -2], [0, 10]]), grid('B', [[8, -2], [8, 10]]), grid('1', [[-2, 0], [20, 0]]), grid('2', [[-2, 6], [20, 6]]),
    grid('C', [[16, -2], [16, 10]], { bottom: -0.5, top: 3.5 })
  ];
  const LEVELS = [level('Level 1', 0), level('Level 2', 3.5), level('Level 3', 7), level('Parapet', 8, false)];

  it('names crossings letter first and keeps links apart', () => {
    const nodes = GridNodes.build(grids());
    expect(nodes.map(n => n.name).sort()).toEqual(['A-1', 'A-2', 'B-1', 'B-2', 'C-1', 'C-2']);
    expect(nodes.find(n => n.name === 'B-2')!.point).toEqual(vec2(8, 6));
    expect(GridNodes.nodeName('4', 'C')).toBe('C-4');
    expect(GridNodes.nodeName('12', '1')).toBe('1-12');
    const mixed = [grid('A', [[0, -5], [0, 0], [0, 5]]), grid('1', [[-5, 0], [5, 0]]), grid('S1', [[-5, 1], [5, 1]], { link: 1 }), grid('2', [[-5, 3], [5, 3]])];
    expect(GridNodes.build(mixed).length).toBe(2);
    expect(GridNodes.intersect(vec2(0, 0), vec2(1, 0), vec2(2, -1), vec2(2, 1))).toBeNull();
  });

  it('locates points by storey, nearest reaching node and links', () => {
    const g = grids();
    const locator = GridLocator.create(g, GridNodes.build(g), LEVELS, vec3(100, 200, 0));
    const at = locator.locate(107.2, 205.5, 4)!;
    expect(at.node).toBe('B-2');
    expect(at.level).toBe('Level 2');
    expect(at.offset).toBeCloseTo(Math.sqrt(0.89), 4);
    expect(locator.text(100.3, 199.9, 8.5)).toBe('A-1 : Level 3');
    expect(locator.text(115, 206, 7.5)).toBe('B-2 : Level 3');
    expect(locator.text(115, 206, 1)).toBe('C-2 : Level 1');
    expect(locator.text(100, 200, -3)).toBe('A-1 : Level 1');
    expect(GridLocator.EMPTY.text(0, 0, 0)).toBeNull();
    const linked = [grid('X', [[0, -5], [0, 5]], { link: 1 }), grid('9', [[-5, 0], [5, 0]], { link: 1 })];
    expect(GridLocator.create(linked, GridNodes.build(linked), LEVELS, vec3()).text(1, 1, 1)).toBe('X-9 : Level 1');
    const both = [...g, ...linked];
    expect(GridLocator.create(both, GridNodes.build(both), LEVELS, vec3()).text(0.5, 0.5, 1)).toBe('A-1 : Level 1');
  });

  it('groups clashes by grid and carries the location into reports', () => {
    const { document, test } = newDocument();
    const g = grids();
    const locator = GridLocator.create(g, GridNodes.build(g), LEVELS, vec3());
    const at = (id: string, x: number, y: number, z: number) => Object.assign(clashOf(test, id + 'a', id + 'b'), { x, y, z });
    const c1 = at('1', 0.5, 0.5, 1), c2 = at('2', -0.3, 0.2, 4), c3 = at('3', 0.1, 0.1, 4), c4 = at('4', 8, 6, 1);
    document.clashes.push(c1, c2, c3, c4);
    const byGrid = ClashGrouping.byGrid(document, test.id, c => locator.locate(c.x, c.y, c.z), false, 2, 'gavin', T0);
    expect(byGrid.length).toBe(1);
    expect(byGrid[0]).toMatchObject({ autoLabel: 'Near A-1', auto: ClashGroupAuto.GRID, clashIds: [c1.id, c2.id, c3.id] });
    ClashGroups.ungroup(document, byGrid[0]);
    const perLevel = ClashGrouping.byGrid(document, test.id, c => locator.locate(c.x, c.y, c.z), true, 2, 'gavin', T0);
    expect(perLevel[0]).toMatchObject({ autoLabel: 'Near A-1 : Level 2', clashIds: [c2.id, c3.id] });
    expect(ClashGrouping.gridLabel(null, true)).toBe('No grid');

    const options = { ...defaultReportOptions(), gridLocation: (c: ClashRecord) => locator.text(c.x, c.y, c.z) };
    expect(ClashReports.xml(document, [c4], options)).toContain('<gridlocation>B-2 : Level 1</gridlocation>');
    const html = ClashReports.html(document, [c4], options);
    expect(html).toContain('B-2 : Level 1');
    expect(html).toContain('By grid');
  });
});

describe('clash groups (C-C1, C-C2)', () => {
  it('groups by element: the duct through three beams', () => {
    const { document, test } = newDocument();
    const duct = ref('duct', 101, 'Rectangular Duct: 600x300');
    for (const beam of ['b1', 'b2', 'b3']) { document.clashes.push(clashOf(test, duct, beam, ClashStatus.NEW)); }
    document.clashes.push(clashOf(test, duct, 'b4', ClashStatus.RESOLVED));
    const groups = ClashGrouping.byElement(document, test.id, 2, 'gavin', T0);
    expect(groups.length).toBe(1);
    expect(groups[0].clashIds.length).toBe(3);
    expect(groups[0].name).toBeNull();
    expect(ClashGroups.displayName(groups[0])).toBe('Rectangular Duct: 600x300 (101) × 3 clashes');
    expect(groups[0].status).toBe(ClashStatus.NEW);
    expect(groups[0].updated).toBeNull();
  });

  it('breaks ties by the smaller key whatever the order', () => {
    for (const reversed of [false, true]) {
      const { document, test } = newDocument();
      const clashes = [clashOf(test, 'd1', 'b1'), clashOf(test, 'd1', 'b2'), clashOf(test, 'd2', 'b2'), clashOf(test, 'd2', 'b3')];
      if (reversed) { clashes.reverse(); }
      document.clashes.push(...clashes);
      const groups = ClashGrouping.byElement(document, test.id, 2, 'gavin', T0);
      expect(groups.length).toBe(1);
      expect(groups[0].keyElement!.uniqueId).toBe('b2');
    }
  });

  it('keeps one group per clash: move, merge, status and remove', () => {
    const { document, test } = newDocument();
    const c1 = clashOf(test, 'a', 'b'), c2 = clashOf(test, 'c', 'd'), c3 = clashOf(test, 'e', 'f', ClashStatus.REVIEWED), c4 = clashOf(test, 'g', 'h');
    document.clashes.push(c1, c2, c3, c4);
    const g1 = ClashGroups.create(document, test.id, [c1, c2], null, null, null, null, 'gavin', T0).group!;
    expect(g1.name).toBe('Group 1');
    const second = ClashGroups.create(document, test.id, [c2, c3], null, null, null, null, 'gavin', T0);
    expect(second.moved).toBe(1);
    expect(second.group!).toMatchObject({ name: 'Group 2', status: ClashStatus.ACTIVE });
    expect(g1.clashIds).toEqual([c1.id]);
    const third = ClashGroups.create(document, test.id, [c1], null, null, null, null, 'gavin', T0);
    expect(document.groups!.includes(g1)).toBe(false);
    expect(third.group!.name).toBe('Group 3');
    ClashGroups.setNotes(second.group, 'Check the drop', 'gavin', T0);
    const merged = ClashGroups.merge(document, [third.group!, second.group!], 'gavin', T1)!;
    expect(merged).toBe(third.group);
    expect(merged.clashIds).toEqual([c1.id, c2.id, c3.id]);
    expect(merged.notes).toBe('Group 2: Check the drop');
    expect(merged.updated).toBe(T1);
    const byId = ClashGroups.clashesById(document);
    expect(ClashGroups.setStatus(merged, ClashStatus.APPROVED, byId, 'gavin', T0).length).toBe(3);
    ClashMerge.setStatus(c1, ClashStatus.NEW, 'gavin', T0);
    expect(ClashGroups.summarise(merged, byId)).toMatchObject({ mixed: true, byStatus: [1, 0, 0, 2, 0] });
    expect(ClashGroups.addTo(document, merged, [c4, c1], 'gavin', T0)).toEqual({ added: 1, moved: 0 });
    expect(ClashGroups.remove(document, [c1, c2, c3, c4])).toBe(4);
    expect(document.groups).toBeNull();
  });

  it('freezes an automatic name when merged with another basis, and renames back', () => {
    const { document, test } = newDocument();
    const duct = ref('duct', 7, 'Duct');
    document.clashes.push(clashOf(test, duct, 'b1'), clashOf(test, duct, 'b2'), clashOf(test, 'p', 'q'), clashOf(test, 'p', 'r'));
    const groups = ClashGrouping.byElement(document, test.id, 2, 'gavin', T0);
    const ductGroup = groups.find(g => g.keyElement!.uniqueId === 'duct')!;
    ClashGroups.merge(document, [ductGroup, groups.find(g => g !== ductGroup)!], 'gavin', T0);
    expect(ductGroup).toMatchObject({ name: 'Duct (7) × 4 clashes', keyElement: null, auto: null });
    ClashGroups.rename(document, ductGroup, '  Level 2 ducts ', 'gavin', T0);
    expect(ductGroup.name).toBe('Level 2 ducts');
    ClashGroups.rename(document, ductGroup, '', 'gavin', T0);
    expect(ductGroup.name).toBe('Group 1');
  });

  it('groups by level and category pair, clusters, and boxes', () => {
    const { document, test } = newDocument();
    const mk = (a: string, ca: string, la: string, b: string, cb: string, x: number) =>
      Object.assign(clashOf(test, ref(a, 0, '', ca, la), ref(b, 0, '', cb, '')), { x, y: 0, z: 0 });
    const c1 = mk('a1', 'Ducts', 'Level 1', 'b1', 'Structural Framing', 0);
    const c2 = mk('a2', 'Structural Framing', 'Level 1', 'b2', 'Ducts', 1);
    const c3 = mk('a3', 'Pipes', 'Level 2', 'b3', 'Walls', 5);
    const c4 = mk('a4', 'Pipes', '', 'b4', 'Walls', 6);
    document.clashes.push(c1, c2, c3, c4);
    expect(ClashGrouping.categoryPairOf(c2)).toBe('Ducts × Structural Framing');
    expect(ClashGrouping.levelOf(c4)).toBe('—');
    const byLevel = ClashGrouping.byLevel(document, test.id, 2, 'gavin', T0);
    expect(byLevel.map(g => g.autoLabel)).toEqual(['Level 1']);
    const pairs = ClashGrouping.byCategoryPair(document, test.id, false, 2, 'gavin', T0);
    expect(pairs.map(g => g.autoLabel)).toEqual(['Pipes × Walls']);
    expect(ClashGroups.displayName(pairs[0])).toBe('Pipes × Walls × 2 clashes');
    expect(ClashGrouping.inSphere([c1, c2, c3, c4], 0, 0, 0, 1).map(c => c.id)).toEqual([c1.id, c2.id]);
    expect(ClashGrouping.clusterLabel(document, test.id, [c1, c2])).toBe('Cluster 1 · Level 1');
    const box = { minX: -0.5, minY: -1, minZ: -1, maxX: 1.5, maxY: 1, maxZ: 1, fullHeight: false };
    expect(ClashGrouping.inBox(document.clashes, box).length).toBe(2);
    expect(GroupBox.contains({ ...box, fullHeight: true }, 0, 0, 99)).toBe(true);
    const group = byLevel[0];
    ClashGroups.setBox(group, { ...box, minX: 1.5, maxX: -0.5 }, 'gavin', T0);
    expect(group.box!.minX).toBe(-0.5);
    group.box!.maxX = 0.5;
    const split = ClashGroups.boxSplit(document, group, null)!;
    expect(split.outside.map(c => c.id)).toEqual([c2.id]);
  });

  it('survives clashes.json with groups, follows runs and resets', () => {
    const { document, test } = newDocument();
    const c1 = clashOf(test, 'a', 'b'), c2 = clashOf(test, 'c', 'd');
    document.clashes.push(c1, c2);
    const { group } = ClashGroups.create(document, test.id, [c1, c2], 'Mine', null, null, null, 'gavin', T0);
    group!.box = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1, fullHeight: true };
    const back = ClashFiles.parse(ClashFiles.serialize(document)).document!;
    expect(back.groups!.length).toBe(1);
    expect(back.groups![0]).toMatchObject({ name: 'Mine', clashIds: [c1.id, c2.id], box: { fullHeight: true } });
    c1.status = c2.status = ClashStatus.RESOLVED;
    expect(ClashGroups.followRun(document, test.id).length).toBe(1);
    expect(group!.status).toBe(ClashStatus.RESOLVED);
    ClashMerge.resetTest(document, test);
    expect(document.groups).toBeNull();
    // A damaged group list is cleaned on read
    const raw = JSON.parse(new TextDecoder().decode(ClashFiles.serialize(back)));
    raw.groups.push({ testId: test.id, clashIds: [c1.id, 'nope'] }, { testId: '', clashIds: [c2.id] });
    const cleaned = ClashFiles.parse(JSON.stringify(raw)).document!;
    expect(cleaned.groups!.length).toBe(1);
  });
});

describe('rules: parameters, phases, numbers and nested groups', () => {
  it('reads parameter values and phases', () => {
    const scene = profileScene();
    expect(scene.parameters.indexOfName('fire rating')).toBe(scene.parameters.indexOfName('Fire Rating'));
    expect(SearchSets.elementsIn({ ...newSet(), rules: [rule(RuleField.PARAMETER, RuleOp.IS, 'Fire Rating', '60/60/60')] }, scene)).toEqual([0, 2]);
    expect(SearchSets.elementsIn({ ...newSet(), rules: [rule(RuleField.PHASE, RuleOp.IS, null, 'New')] }, scene)).toEqual([2]);
    expect(SearchSets.valuesOf(scene, RuleField.PARAMETER, 'Mark').map(v => v.label)).toEqual(['(no value)', 'W1']);
    expect(rule(RuleField.LEVEL, RuleOp.IS, 'Ignored', 'x').parameter).toBeNull();
    expect(SearchSets.describe(rule(RuleField.PARAMETER, RuleOp.IS, 'Fire Rating', '60/60/60'), scene)).toBe('Fire Rating is 60/60/60');
  });

  it('reads the first number in a text', () => {
    const cases: [string | null, number | null][] = [
      ['600 mm', 600], ['1 200 mm', 1200], ['1,200', 1200], ['2,5 m', 2.5], ['12.75', 12.75], ['60/60/60', 60], ['-/120/120', 120],
      ['-40 °C', -40], ['Level 2', 2], ['.5', 0.5], ['Type A', null], ['', null], [null, null]
    ];
    for (const [text, expected] of cases) { expect(RuleNumbers.tryParse(text)).toBe(expected); }
    expect(RuleNumbers.all('300 to 600')).toEqual([300, 600]);
    expect(RuleNumbers.all('300-600')).toEqual([300, 600]);
    expect(RuleNumbers.all('300 and -50')).toEqual([300, -50]);
    expect(RuleNumbers.format(1200.5)).toBe('1200.5');
  });

  it('matches the number operators', () => {
    const scene = profileScene();
    const set = (...rules: ReturnType<typeof rule>[]) => ({ ...newSet(), rules });
    expect(SearchSets.elementsIn(set(rule(RuleField.PARAMETER, RuleOp.AT_LEAST, 'Width', '900')), scene)).toEqual([1, 2]);
    expect(SearchSets.elementsIn(set(rule(RuleField.PARAMETER, RuleOp.AT_MOST, 'Width', '900')), scene)).toEqual([0, 2]);
    expect(SearchSets.elementsIn(set(rule(RuleField.PARAMETER, RuleOp.BETWEEN, 'Width', '1000', '700')), scene)).toEqual([2]);
    expect(SearchSets.elementsIn(set(rule(RuleField.LEVEL, RuleOp.AT_LEAST, null, '2')), scene)).toEqual([2, 3]);
    const between = rule(RuleField.PARAMETER, RuleOp.BETWEEN, 'Width', '1', '2', '3');
    expect(ruleValueCount(between)).toBe(2);
    expect(ruleIsComplete(rule(RuleField.PARAMETER, RuleOp.AT_LEAST, 'Width', 'wide'))).toBe(false);
    expect(ruleIsComplete(rule(RuleField.PARAMETER, RuleOp.BETWEEN, 'Width', '1'))).toBe(false);
    setRuleOperator(between, RuleOp.IS);
    expect(ruleValueCount(between)).toBe(0);
    expect(SearchSets.describe(rule(RuleField.PARAMETER, RuleOp.BETWEEN, 'Width', '1', '2'), scene)).toBe('Width is between 1 and 2');
  });

  it('nests rule groups to any depth and round-trips them', () => {
    const scene = profileScene();
    const g = (matchAll: boolean, rules: ReturnType<typeof rule>[], groups: RuleGroup[] | null = null): RuleGroup => ({ matchAll, rules, groups });
    // walls AND (Level 2 OR (Fire Rating 60/60/60 AND type contains 60))
    const set = { ...newSet(), matchAll: true, rules: [rule(RuleField.CATALOG, RuleOp.IS, null, 'walls')],
      groups: [g(false, [rule(RuleField.LEVEL, RuleOp.IS, null, 'Level 2')],
        [g(true, [rule(RuleField.PARAMETER, RuleOp.IS, 'Fire Rating', '60/60/60'), rule(RuleField.TYPE, RuleOp.CONTAINS, null, '60')])])] };
    expect(SearchSets.elementsIn(set, scene)).toEqual([0]);
    const document = emptyClashDocument();
    document.sets.push(set);
    const back = ClashFiles.parse(ClashFiles.serialize(document)).document!;
    expect(back.sets[0].groups![0].groups![0].rules[0].parameter).toBe('Fire Rating');
    expect(SearchSets.elementsIn(back.sets[0], scene)).toEqual([0]);
  });
});

describe('clash setup files (QOL)', () => {
  function doc() {
    const document = emptyClashDocument();
    const ducts = { ...newSet('Ducts'), rules: [rule(RuleField.LINK, RuleOp.IS, null, 'link-uid'), rule(RuleField.LEVEL, RuleOp.IS, null, 'Level 9')] };
    const spare = newSet('Spare');
    document.sets.push(ducts, spare);
    const test = newTest('Ducts × Ducts');
    test.setA = ducts.id;
    document.tests.push(test);
    return document;
  }

  it('exports tests with the sets they use and the link names', () => {
    const file = ClashSetupFiles.build(doc(), 'tests', [link], 'Model', 'BimGo');
    expect(file.sets.map(s => s.name)).toEqual(['Ducts']);
    expect(file.links).toEqual([{ uniqueId: 'link-uid', name: 'Structure' }]);
    const text = ClashSetupFiles.serialize(file);
    expect(ClashSetupFiles.parse(text, 'sets').error).toContain('TESTS tab');
    expect(ClashSetupFiles.parse(JSON.stringify({ format: 'bimgo-clash-report' }), 'tests').error).toContain('clash report');
  });

  it('plans and applies: links matched by name, levels mapped, name clashes', () => {
    const file = ClashSetupFiles.parse(ClashSetupFiles.serialize(ClashSetupFiles.build(doc(), 'sets', [link], 'Model', 'BimGo')), 'sets').file!;
    const into = emptyClashDocument();
    into.sets.push(newSet('Ducts'));
    const otherLink = { ...link, instanceUniqueId: 'other-uid' };
    const plan = ClashSetupFiles.plan(file, into, [otherLink], ['Level 1']);
    expect(plan.nameClashes).toEqual(['Ducts']);
    expect(plan.missing.map(m => [m.field, m.label, m.autoMatched])).toEqual([['link', 'Structure', true], ['level', 'Level 9', false]]);
    plan.missing[1].replacement = 'Level 1';
    plan.onNameClash = 'keepBoth';
    const result = ClashSetupFiles.apply(plan, into);
    expect(result).toMatchObject({ setsAdded: 2, valuesChanged: 2 });
    expect(into.sets.map(s => s.name)).toEqual(['Ducts', 'Ducts (2)', 'Spare']);
    expect(into.sets[1].rules.map(r => r.values[0])).toEqual(['other-uid', 'Level 1']);
    expect(ClashSetupFiles.uniqueName('A', ['a', 'A (2)'])).toBe('A (3)');
  });
});

describe('clash reports (C-C3)', () => {
  function reportDocument() {
    const { document, test } = newDocument();
    const c1 = clashOf(test, ref('a', 1, 'Duct <600>', 'Ducts', 'Level 1'), ref('b', 2, 'Beam', 'Structural Framing', 'Level 1'));
    c1.crossing = true;
    c1.distance = 0.07;
    const c2 = clashOf(test, 'c', 'd'), c3 = clashOf(test, 'e', 'f');
    document.clashes.push(c1, c2, c3);
    const { group } = ClashGroups.create(document, test.id, [c2, c3], 'G', null, null, null, 'gavin', T0);
    return { document, c1, c2, c3, group: group! };
  }

  it('orders sections and pictures by group mode', () => {
    const { document, c1, c2, c3, group } = reportDocument();
    const sections = ClashReports.sections(document, [c2, c1, c3], ClashReportGroups.SECTIONS);
    expect(sections.map(s => s.group?.id ?? null)).toEqual([group.id, null]);
    expect(ClashReports.sections(document, [c1, c2], ClashReportGroups.NONE).length).toBe(1);
    expect(ClashReports.pictures(document, [c1, c2, c3], ClashReportGroups.COMPACT).map(p => p.id)).toEqual([group.id, c1.id]);
    expect(ClashReports.pictures(document, [c1, c2, c3], ClashReportGroups.SECTIONS).length).toBe(4);
  });

  it('writes escaped HTML with pictures and Navisworks-style XML', () => {
    const { document, c1, c2, c3 } = reportDocument();
    const options = { ...defaultReportOptions(), modelTitle: 'M', groupMode: ClashReportGroups.COMPACT };
    const html = ClashReports.html(document, [c1, c2, c3], options, new Map([[c1.id, Uint8Array.of(1, 2, 3)]]));
    expect(html).toContain('Duct &lt;600&gt;');
    expect(html).toContain('data:image/jpeg;base64,AQID');
    expect(html).toContain('Category pairs');
    const xml = ClashReports.xml(document, [c1, c2, c3], options);
    expect(xml).toContain('<clashgroup name="G"');
    expect(xml).toContain('distance="-0.07"');
    expect(xml).toContain('<smarttag>');
    expect(ClashReports.countBy([c1, c2, c3], c => (c === c1 ? 'b' : 'a'))).toEqual([['a', 2], ['b', 1]]);
  });
});

describe('colour profiles (colour A, B, P-C)', () => {
  it('builds value rows, codes and counts', () => {
    const scene = profileScene();
    const profile = AppearanceProfiler.newByValue('Levels', RuleField.LEVEL, null, scene);
    expect(profile.rules.map(r => r.value)).toEqual(['Level 1', 'Level 2']);
    profile.rules[0].colour = '#FF0000';
    profile.rules[1].on = false;
    let result = AppearanceProfiler.evaluate(profile, scene, null);
    expect(result.codes[0]).toBe(0xFF0000FF);
    expect(result.codes[2]).toBe((AppearanceProfiler.CODE_GHOST << 24) >>> 0);
    expect(result.codes[4]).toBe(0);
    expect(result.ruleCounts).toEqual([2, 2]);
    expect(result.unmatched).toBe(2);
    profile.unmatched = UnmatchedLook.FLAT;
    profile.unmatchedColour = '#102030';
    result = AppearanceProfiler.evaluate(profile, scene, null);
    expect(result.codes[2]).toBe(AppearanceProfiler.pack(0x102030, 255));
  });

  it('colours by parameter, refreshes and changes field', () => {
    const scene = profileScene();
    const profile = AppearanceProfiler.newByValue('Fire', RuleField.PARAMETER, 'Fire Rating', scene);
    expect(profile.rules.length).toBe(3);
    expect(AppearanceProfiler.describe(profile)).toBe('By Fire Rating · 3 values');
    expect(AppearanceProfiler.evaluate(profile, scene, null).unmatched).toBe(0);
    profile.rules.find(r => r.value === '60/60/60')!.colour = '#00FF00';
    profile.rules.push({ ...newProfileRule(), value: 'Gone', label: 'Gone' });
    profile.rules = profile.rules.filter(r => r.value !== '-/120/120');
    expect(AppearanceProfiler.syncValues(profile, scene)).toBe(1);
    expect(profile.rules.find(r => r.value === '60/60/60')!.colour).toBe('#00FF00');
    expect(profile.rules.length).toBe(4);
    AppearanceProfiler.setField(profile, RuleField.PHASE, null, scene);
    expect(profile.rules.map(r => r.value)).toEqual(['existing', 'new', 'unphased']);
  });

  it('colours by set, first match wins', () => {
    const scene = profileScene();
    const walls = SearchSets.setOfCatalog('Walls', ['walls']);
    const levelOne = { ...newSet('Level 1'), rules: [rule(RuleField.LEVEL, RuleOp.IS, null, 'Level 1')] };
    const sets = new Map([[walls.id, walls], [levelOne.id, levelOne]]);
    const profile = AppearanceProfiler.newBySet('Sets', [walls, levelOne]);
    profile.rules.push({ ...newProfileRule(), setId: 'missing' });
    const find = (id: string | null) => sets.get(id ?? '') ?? null;
    let result = AppearanceProfiler.evaluate(profile, scene, find);
    expect(result.ruleCounts).toEqual([2, 0, 0]);
    expect(result.missingSets).toBe(1);
    profile.rules[0].on = false;
    result = AppearanceProfiler.evaluate(profile, scene, find);
    expect(result.ruleCounts).toEqual([0, 2, 0]);
  });

  it('has distinct palettes, ranges, see-through and hidden rows', () => {
    for (const palette of AppearanceProfiler.PALETTES) {
      const colours = Array.from({ length: 40 }, (_, i) => AppearanceProfiler.paletteColour(palette, i));
      expect(new Set(colours.slice(0, 12)).size).toBe(12);
      expect(new Set(colours).size).toBeGreaterThanOrEqual(36);
    }
    const scene = profileScene();
    const profile = AppearanceProfiler.newByValue('Width', RuleField.PARAMETER, 'Width', scene);
    profile.bins = 3;
    expect(AppearanceProfiler.buildRanges(profile, scene)).toBe(3);
    expect(profile.rules.map(r => [r.from, r.to])).toEqual([[600, 800], [800, 1000], [1000, 1200]]);
    expect(profile.rules[0].label).toBe('600 – 800 mm');
    expect(profile.rules[2].colour).toBe('#D7191C');
    const result = AppearanceProfiler.evaluate(profile, scene, null);
    expect(result.ruleCounts).toEqual([1, 1, 1]);
    expect(result.noNumber).toBe(1);
    AppearanceProfiler.applyRamp(profile, AppearanceProfiler.RAMP_LIGHT_DARK);
    expect(profile.rules[2].colour).toBe('#08306B');
    const copy = cleanProfile(copyProfile(profile));
    expect(copy.rules.length).toBe(3);
    copy.ranges = false;
    expect(cleanProfile(copy).rules.length).toBe(0);

    const levels = AppearanceProfiler.newByValue('Levels', RuleField.LEVEL, null, scene);
    levels.unmatched = UnmatchedLook.NORMAL;
    levels.rules[0].transparency = 0.5;
    levels.rules[1].hidden = true;
    const codes = AppearanceProfiler.evaluate(levels, scene, null);
    const seeThrough = codes.codes[0] >>> 24;
    expect((seeThrough - 128) / 126).toBeCloseTo(0.5, 2);
    expect(codes.codes[2] >>> 24).toBe(AppearanceProfiler.CODE_HIDDEN);
    expect(codes.anyBlended && codes.anyHidden && !codes.anyGhost).toBe(true);
  });

  it('cuts equal, quantile and custom edges and parses breaks', () => {
    const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    expect(AppearanceProfiler.rangeEdges(numbers, BinMethod.EQUAL, 4, null)).toEqual([1, 25.75, 50.5, 75.25, 100]);
    const quantile = AppearanceProfiler.rangeEdges(numbers, BinMethod.QUANTILE, 4, null);
    expect(quantile[1] < 10 && quantile[quantile.length - 2] < 10).toBe(true);
    expect(AppearanceProfiler.rangeEdges([5, 5, 5, 5, 5, 5, 9], BinMethod.QUANTILE, 4, null)).toEqual([5, 9]);
    expect(AppearanceProfiler.rangeEdges(numbers, BinMethod.CUSTOM, 4, [-5, 5, 50, 500])).toEqual([1, 5, 50, 100]);
    expect(AppearanceProfiler.rangeEdges([7, 7], BinMethod.EQUAL, 5, null)).toEqual([7, 7]);
    expect(AppearanceProfiler.parseBreaks('600; 300 mm; 450')).toEqual([300, 450, 600]);
    expect(AppearanceProfiler.parseBreaks('1,200, 1,500')).toEqual([1200, 1500]);
    expect(AppearanceProfiler.parseBreaks('none here')).toBeNull();
    expect(AppearanceProfiler.formatBreaks([300, 450.5])).toBe('300; 450.5');
    expect(cleanProfile({ ...newProfile(), ranges: true, binning: 'QUANTILE', breaks: [3, NaN, 1, 3] })).toMatchObject({ binning: 'quantile', breaks: [1, 3] });
  });

  it('saves in visibility.json and moves between models in profile files', () => {
    const scene = profileScene();
    const walls = SearchSets.setOfCatalog('Walls', ['walls']);
    const settings = { ...Appearance.defaults(), profiles: [AppearanceProfiler.newBySet('Sets', [walls]), AppearanceProfiler.newByValue('Levels', RuleField.LEVEL, null, scene)], on: true };
    const back = readVisibility({ appearance: JSON.parse(JSON.stringify(Appearance.json(settings))) }).appearance!;
    expect(back.profiles.length).toBe(2);
    expect(back.active).toBe(settings.profiles[0].id);
    const file = ProfileFiles.parse(ProfileFiles.serialize(ProfileFiles.build(settings.profiles, id => (id === walls.id ? walls : null), 'M', 'BimGo', [link]))).file!;
    expect(file.sets.map(s => s.name)).toEqual(['Walls']);
    const into = { ...Appearance.defaults(), profiles: [newProfile('Levels')] };
    const sets = [{ ...newSet('walls') }];
    const merged = ProfileFiles.merge(file, into, sets);
    expect(merged).toMatchObject({ setsMatched: 1, setsAdded: 0 });
    expect(into.profiles.map(p => p.name)).toEqual(['Levels', 'Sets', 'Levels (imported)']);
    expect(into.profiles[1].rules[0].setId).toBe(sets[0].id);
  });
});

describe('water, grass, sky and night (QOL, sky, grass, W-A)', () => {
  const material = (name: string, extra: Partial<SceneMaterial> = {}) => ({ name, schema: '', reflectivity: 0, water: false, seeThrough: false, shine: 0, roughness: null, waterBump: 0, ...extra }) as SceneMaterial;

  it('applies the water rule by asset and keyword', () => {
    expect(MaterialOverrides.parseKeywords(' Water ; pool,water, ')).toEqual(['Water', 'pool']);
    const asset = material('Pond', { schema: 'WaterSchema', water: true, waterBump: 0.2 });
    const glass = material('Pool water', { seeThrough: true });
    const heater = material('Water heater');
    expect(MaterialOverrides.isWater(asset, true, ['water'], false)).toBe(true);
    expect(MaterialOverrides.isWater(asset, false, ['water'], false)).toBe(false);
    expect(MaterialOverrides.isWater(glass, false, ['water'], false)).toBe(true);
    expect(MaterialOverrides.isWater(heater, true, ['water'], false)).toBe(false);
    expect(MaterialOverrides.isWater(heater, true, ['water'], true)).toBe(true);
    const target = [{ ...glass }];
    expect(MaterialOverrides.applyWater([glass], target, true, ['water'], false)).toBe(1);
    expect(target[0]).toMatchObject({ water: true, shine: 0.6, roughness: 0.05, waterBump: 0.1 });
    expect(MaterialOverrides.waterPresetIndex('#3b9aa6')).toBe(1);
  });

  it('rasterises lawns, covers and colours', () => {
    const lawn = [grassTriangle(vec3(0, 0, 0), vec3(10, 0, 0), vec3(10, 10, 0), 1), grassTriangle(vec3(0, 0, 0), vec3(10, 10, 0), vec3(0, 10, 0), 1)];
    const field = GrassField.rasterise(lawn, [], [GrassField.DEFAULT_GREEN]);
    expect(field.isEmpty).toBe(false);
    expect(field.tryGet(5, 5)).toEqual({ z: 0, palette: 0 });
    expect(field.tryGet(-5, 5)).toBeNull();
    const slab = [grassTriangle(vec3(2, 2, 0.15), vec3(4, 2, 0.15), vec3(4, 4, 0.15), 0), grassTriangle(vec3(2, 2, 3), vec3(8, 2, 3), vec3(8, 8, 3), 0)];
    const covered = GrassField.rasterise(lawn, slab, [GrassField.DEFAULT_GREEN]);
    expect(covered.tryGet(3.6, 2.5)).toBeNull();
    expect(covered.tryGet(7, 3)).not.toBeNull();
    expect(GrassField.rasterise([], [], []).isEmpty).toBe(true);
    expect(GrassField.grassColour(vec3(0.5, 0.5, 0.5))).toEqual(GrassField.DEFAULT_GREEN);
  });

  it('places the moon and turns the sky', () => {
    const dallas = { latitude: 32.78, longitude: -96.8, timeZone: -6, name: 'Dallas' };
    const moon = LunarPosition.compute(dallas, 2024, 4, 8, 13 * 60 + 40, true);
    const sun = SolarPosition.compute(dallas, 2024, 4, 8, 13 * 60 + 40, true);
    const dir = (alt: number, az: number): Vec3 => vec3(Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt));
    const a = dir(moon.altitude, moon.azimuth), b = dir(sun.altitude, sun.azimuth);
    expect(Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)) * 180 / Math.PI).toBeLessThan(1);
    expect(moon.illuminated).toBeLessThan(0.01);
    const utc = { latitude: 0, longitude: 0, timeZone: 0, name: 'Greenwich' };
    expect(LunarPosition.compute(utc, 2024, 4, 23, 23 * 60 + 49, false).illuminated).toBeGreaterThan(0.98);
    const first = LunarPosition.compute(utc, 2024, 4, 15, 19 * 60 + 13, false);
    expect(first.illuminated).toBeCloseTo(0.5, 1);
    expect(first.waxing).toBe(true);
    for (const latitude of [-33.87, 0, 51.5]) {
      const m = LunarPosition.equatorialToTrueNorth(1.234, latitude);
      expect(Mat4.get(m, 3, 3)).toBeCloseTo(Math.sin(latitude * Math.PI / 180), 4);
      expect(Mat4.get(m, 3, 1)).toBeCloseTo(0, 4);
    }
    const lst = LunarPosition.localSiderealTime(utc, 2000, 1, 1, 720, false) * 180 / Math.PI;
    expect(lst).toBeCloseTo(280.46, 0);
  });

  it('reads and cleans the sky and night settings', () => {
    const s = readSunSettings({ enabled: true, cloudCover: 3, sunSize: 0, moonLight: 9, starDensity: -1, starTwinkle: 'x', moonPhase: 0 });
    expect(s).toMatchObject({ cloudCover: 1, sunSize: 0.25, moonLight: 2, starDensity: 0, starTwinkle: 1, moonPhase: Math.fround(0.05), moon: true, stars: true, cloudSpeed: 1 });
    expect(readSunSettings({ enabled: true }).moonPhase).toBeNull();
  });
});

describe('camera paths (round K)', () => {
  const DT = 1 / 120;
  const key = (x: number, y: number, z: number, o: { speed?: number; hold?: number; ease?: boolean; smoothness?: number; heading?: 'follow' | 'key' | 'lookAt'; yaw?: number; swivel?: number } = {}) =>
    cameraPathPoint(vec3(x, y, z), o.yaw ?? 0, 0, o.heading ?? 'follow', vec3(), o.smoothness ?? 0.8, o.speed ?? 1.5, o.hold ?? 0, o.ease ?? false, o.swivel ?? 0);
  const timeline = (loop: boolean, fade: number, level: boolean, ...keys: ReturnType<typeof key>[]) =>
    new CameraPathTimeline(keys, cameraPathSettings(loop, fade, 3, level), 1.6);
  const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  it('moves without jumps at a constant speed and loops closed', () => {
    const t = timeline(false, 0.5, true, key(0, 0, 1.6, { ease: true }), key(10, 0, 1.6), key(10, 10, 1.6), key(20, 10, 3.6, { ease: true }));
    let previous = t.evaluate(0).eye, maxStep = 0, previousYaw = t.evaluate(0).yaw, maxTurn = 0;
    for (let s = DT; s < t.duration; s += DT) {
      const pose = t.evaluate(s);
      maxStep = Math.max(maxStep, dist(previous, pose.eye));
      maxTurn = Math.max(maxTurn, Math.abs(TourTimeline.lerpAngle(previousYaw, pose.yaw, 1) - previousYaw));
      previous = pose.eye;
      previousYaw = pose.yaw;
    }
    expect(maxStep).toBeLessThanOrEqual(1.5 * DT * 1.02);
    expect(maxTurn).toBeLessThan(0.05);
    const loop = timeline(true, 0.5, true, key(0, 0, 0), key(10, 0, 0), key(10, 10, 0), key(0, 10, 0));
    let prev = loop.evaluate(0).eye, slowest = Infinity, fastest = 0;
    for (let s = DT; s < loop.duration - DT; s += DT) {
      const eye = loop.evaluate(s).eye;
      const speed = dist(prev, eye) / DT;
      slowest = Math.min(slowest, speed);
      fastest = Math.max(fastest, speed);
      prev = eye;
    }
    expect(slowest).toBeCloseTo(1.5, 1);
    expect(fastest).toBeCloseTo(1.5, 1);
    expect(loop.duration).toBeCloseTo(loop.pathLength / 1.5, 2);
    expect(loop.evaluate(0).black).toBe(0);
  });

  it('eases, holds and fades', () => {
    const ease = timeline(false, 0, true, key(0, 0, 0, { speed: 5, ease: true }), key(0.5, 0, 0, { ease: true }));
    expect(dist(ease.evaluate(0.01).eye, ease.evaluate(0.02).eye) / 0.01).toBeLessThan(0.05);
    expect(ease.evaluate(ease.duration * 0.5).eye.x).toBeCloseTo(0.25, 3);
    const hold = timeline(false, 0, true, key(0, 0, 0), key(5, 0, 0, { hold: 2 }), key(5, 5, 0));
    const arrive = hold.startOf(1);
    const held = hold.evaluate(arrive + 1);
    expect(held).toMatchObject({ key: 1, moving: false });
    expect(held.eye).toEqual(vec3(5, 0, 0));
    expect(hold.indexAt(arrive - 0.01)).toBe(0);
    const fades = timeline(false, 0.5, true, key(0, 0, 0), key(10, 0, 0));
    expect(fades.evaluate(0).black).toBeCloseTo(1, 5);
    const end = fades.evaluate(fades.duration);
    expect(end.finished && end.black === 1).toBe(true);
  });

  it('follows the path and blends key views', () => {
    const level = timeline(false, 0, true, key(0, 0, 1.6), key(10, 0, 5));
    expect(level.evaluate(level.duration * 0.5).yaw).toBeCloseTo(0, 3);
    const climbing = timeline(false, 0, false, key(0, 0, 1.6), key(10, 0, 5));
    expect(Math.abs(climbing.evaluate(climbing.duration * 0.5).pitch - Math.atan2(3.4, 10))).toBeLessThan(0.02);
    const corner = timeline(false, 0, true, key(0, 0, 0, { smoothness: 0 }), key(10, 0, 0, { smoothness: 0 }), key(10, 10, 0, { smoothness: 0 }));
    expect(corner.evaluate(corner.startOf(1) - 0.5).yaw).toBeGreaterThan(0.3);
    const views = timeline(false, 0, true, key(0, 0, 0, { heading: 'key', yaw: 1, hold: 1, swivel: 0.5 }), key(10, 0, 0));
    expect(views.evaluate(0).yaw).toBeCloseTo(1, 4);
    expect(views.evaluate(1).yaw).toBeCloseTo(1.5, 4);
    expect(views.nearest(vec3(5, 1, 0)).along).toBeCloseTo(5, 1);
    const t = views.timeAtDistance(5);
    expect(views.evaluate(t).distance).toBeCloseTo(5, 2);
  });

  it('cleans and reads paths.json', () => {
    const k = { ...newCameraKey(), x: 1, y: 2, z: 3, pitch: 9, speed: 99, holdSeconds: -1, swivel: 0, smoothness: 2 };
    const path = cleanPath({ ...newCameraPath(''), keys: [k, { ...newCameraKey(), x: NaN }], speed: 0, heading: 'nope' as 'follow' });
    expect(path).toMatchObject({ name: 'Path', speed: Math.fround(0.2), heading: 'follow' });
    expect(path.keys.length).toBe(1);
    expect(path.keys[0]).toMatchObject({ pitch: 1.5, speed: 30, holdSeconds: 0, swivel: null, smoothness: 1 });
    const doc = readPathsDocument({ paths: [{ name: 'A', heading: 'LookAt', keys: [{ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, heading: 1, ease: false }] }] })!;
    expect(doc.paths[0]).toMatchObject({ heading: 'lookAt' });
    expect(doc.paths[0].keys[0]).toMatchObject({ heading: 'key', ease: false });
  });
});

describe('tour blend and sun blend (P-C, K-C)', () => {
  it('hands the state over during glides and fades', () => {
    const stops = [tourStop(vec3(0, 0, 0), 1.6, 0, 0, 2, 0), tourStop(vec3(4, 0, 0), 1.6, 0, 0, 2, 0)];
    const glide = new TourTimeline(stops, 'glide', 0.5, 2);
    const mid = glide.evaluate(0.5 + 2 + 1);
    expect(mid).toMatchObject({ blendFrom: 0, blendTo: 1, moving: true });
    expect(mid.blendT).toBeCloseTo(0.5, 2);
    expect(glide.evaluate(1).blendFrom).toBe(glide.evaluate(1).blendTo);
    const fade = new TourTimeline(stops, 'fade', 1, 2);
    const black = fade.evaluate(4 - 1e-6);
    expect(black.blendT).toBeCloseTo(0.5, 2);
    const fadeIn = fade.evaluate(4.5);
    expect(fadeIn).toMatchObject({ blendFrom: 0, blendTo: 1 });
    expect(fadeIn.blendT).toBeGreaterThan(0.5);
  });

  it('blends the sun date the short way round the year', () => {
    const into: SunTime = { month: 1, day: 1, minutes: 0, daylightSaving: false };
    const minutes = sunBlend({ month: 12, day: 21, minutes: 600, daylightSaving: false }, { month: 1, day: 10, minutes: 700, daylightSaving: true }, 0.5, 2026, into);
    expect(into.month === 12 || into.month === 1).toBe(true);
    expect(into.month === 12 ? into.day >= 21 : into.day <= 10).toBe(true);
    expect(minutes).toBeCloseTo(650, 5);
    expect(into.daylightSaving).toBe(true);
  });
});

describe('controls (P-B, K)', () => {
  it('has no default clashes, live F1 rows and a changes table that matches the defaults', () => {
    const map = new KeyMap();
    expect(map.allClashes()).toEqual([]);
    for (const situation of InputCatalog.situations) {
      for (const row of situation.help) {
        expect(row.actions.some(a => situation.contains(a)), `${situation.name}: ${row.label}`).toBe(true);
      }
    }
    expect(InputCatalog.situation(Situations.PATH)!.help.length).toBeGreaterThan(5);
    for (const change of InputCatalog.defaultsChanges) {
      const def = InputCatalog.get(change.action)!;
      expect(def.defaults.length > 0 || !def.padDefault.isEmpty, InputAction[change.action]).toBe(true);
    }
    expect(InputCatalog.changesSince(InputCatalog.DEFAULTS_VERSION)).toEqual([]);
    expect(InputCatalog.changesSince(2).every(c => c.version === 3)).toBe(true);
    expect(map.helpKeys(InputCatalog.situation(Situations.WALKING)!.help[0])).toBe('WASD');
    expect(map.helpPad(InputCatalog.situation(Situations.WALKING)!.help[0])).toBe('LS');
  });
});
