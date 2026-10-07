import { existsSync, openAsBlob } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BimGoReader } from '../src/core/format/BimGoReader';
import { Mat4 } from '../src/core/math/Matrix4x4';
import { vec3 } from '../src/core/math/Vector';
import { Aabb, type ElementRecord, PhaseRole, type SceneData, SceneGeometry } from '../src/core/scene/SceneData';
import { EMPTY_LIGHTING } from '../src/core/scene/LightingData';
import { EMPTY_MATERIALS } from '../src/core/scene/MaterialData';
import { ParameterTable } from '../src/core/scene/ModelInfo';
import { Bvh } from '../src/engine/physics/Bvh';
import { CharacterController } from '../src/engine/physics/CharacterController';
import { closestPointOnTriangle, closestSegmentTriangle, rayTriangle } from '../src/engine/physics/GeoMath';
import { FpsCamera } from '../src/engine/render/FpsCamera';
import { SceneBatches } from '../src/engine/render/SceneBatches';
import { InputState, Vk } from '../src/platform/input';
import { Player } from '../src/game/Player';

describe('Matrix4x4', () => {
  it('inverts', () => {
    const m = Mat4.multiply(Mat4.createLookAt(vec3(3, -2, 1.6), vec3(4, 0, 1), vec3(0, 0, 1)), FpsCamera.perspective(1.2, 1.6, 0.06, 4000));
    const product = Mat4.multiply(m, Mat4.invert(m)!);
    const identity = Mat4.identity();
    product.forEach((v, i) => expect(v).toBeCloseTo(identity[i], 4));
  });

  it('looks along the target direction (view space −Z)', () => {
    const view = Mat4.createLookAt(vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 0, 1));
    const p = Mat4.transformPoint(vec3(5, 0, 0), view);
    expect(p.z).toBeCloseTo(-5);
    expect(p.x).toBeCloseTo(0);
  });

  it('rotates about Z counter-clockwise', () => {
    const p = Mat4.transformPoint(vec3(1, 0, 0), Mat4.createRotationZ(Math.PI / 2));
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
  });
});

describe('FpsCamera', () => {
  it('culls boxes behind the camera and keeps boxes ahead', () => {
    const c = new FpsCamera();
    c.position = vec3(0, 0, 1.6);
    c.update();
    expect(FpsCamera.isVisible(c.planes, new Aabb(vec3(4, -1, 0), vec3(6, 1, 3)))).toBe(true);
    expect(FpsCamera.isVisible(c.planes, new Aabb(vec3(-6, -1, 0), vec3(-4, 1, 3)))).toBe(false);
    const screen = c.worldToScreen(vec3(10, 0, 1.6))!;
    expect(screen.x).toBeCloseTo(c.viewportWidth / 2);
    expect(screen.y).toBeCloseTo(c.viewportHeight / 2);
  });
});

describe('GeoMath', () => {
  const tri = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0);

  it('finds the closest point on a triangle', () => {
    const out = new Float64Array(3);
    closestPointOnTriangle(0.2, 0.2, 5, tri, 0, out, 0);
    expect([...out]).toEqual([0.2, 0.2, 0].map(v => expect.closeTo(v, 6)));
    closestPointOnTriangle(2, 2, 0, tri, 0, out, 0);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBeCloseTo(0.5);
  });

  it('hits a triangle with a ray and misses beside it', () => {
    expect(rayTriangle(0.2, 0.2, 1, 0, 0, -1, tri, 0, 10)).toBeCloseTo(1);
    expect(rayTriangle(2, 2, 1, 0, 0, -1, tri, 0, 10)).toBe(-1);
  });

  it('measures segment to triangle distance, zero when piercing', () => {
    const out = new Float64Array(6);
    expect(closestSegmentTriangle(0.2, 0.2, -1, 0.2, 0.2, 1, tri, 0, out)).toBe(0);
    expect(closestSegmentTriangle(0.2, 0.2, 0.5, 0.2, 0.2, 1, tri, 0, out)).toBeCloseTo(0.25);
  });
});

/** A 20 m square floor at z = 0 made of two triangles, as one element. */
function floorScene(): SceneData {
  const positions = [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]];
  const bytes = new Uint8Array(positions.length * 28);
  const view = new DataView(bytes.buffer);
  positions.forEach((p, i) => {
    view.setFloat32(i * 28, p[0], true);
    view.setFloat32(i * 28 + 4, p[1], true);
    view.setFloat32(i * 28 + 8, p[2], true);
    view.setFloat32(i * 28 + 20, 1, true);
    view.setUint32(i * 28 + 24, 0xffffffff, true);
  });
  const element: ElementRecord = {
    elementId: 1, uniqueId: 'floor', hostId: 0, name: 'Floor', categoryName: 'Floors', familyType: '', levelName: '', categoryIndex: 1,
    opaqueStart: 0, opaqueCount: 6, transparentStart: 0, transparentCount: 0,
    bounds: new Aabb(vec3(-10, -10, 0), vec3(10, 10, 0)), isProxy: false, movable: false, moveBlockReason: null, pivot: vec3(),
    phase: PhaseRole.Existing, link: 0
  };
  return {
    geometry: new SceneGeometry(bytes, Uint32Array.of(0, 1, 2, 0, 2, 3)),
    elements: [element], levels: [], rooms: [], phaseId: -1, phaseName: null, existingPhaseId: -1, existingPhaseName: null, phaseNote: null,
    spawn: null, bounds: element.bounds, originOffset: vec3(), modelTitle: 'Floor', commentsPath: null,
    provenance: {} as SceneData['provenance'], site: {} as SceneData['site'], links: [], lighting: EMPTY_LIGHTING, materials: EMPTY_MATERIALS,
    parameters: ParameterTable.empty, categoryLoaded: [], categoryElementCounts: [], sourceView: null, proxyCount: 0, skippedCount: 0, extractionSeconds: 0
  };
}

describe('CharacterController', () => {
  it('lands on a floor and walks forward on it', () => {
    const scene = floorScene();
    const controller = new CharacterController(new Bvh(scene));
    controller.groundZ = -100;
    const player = new Player(controller);
    player.teleportTo(vec3(0, 0, 1));

    const input = new InputState();
    for (let i = 0; i < 120; i++) { player.fixedUpdate(1 / 120, input, true); }
    expect(controller.grounded).toBe(true);
    expect(controller.feet.z).toBeCloseTo(0, 2);

    input.onKey(Vk.key('W'), true, false);
    for (let i = 0; i < 120; i++) { player.fixedUpdate(1 / 120, input, true); }
    expect(controller.feet.x).toBeGreaterThan(2.5);
    expect(controller.feet.z).toBeCloseTo(0, 2);
  });

  it('batches every triangle exactly once', () => {
    const scene = floorScene();
    const batches = new SceneBatches(scene);
    expect(batches.indices.length).toBe(6);
    expect(batches.chunkTotal).toBe(1);
    expect([...batches.ranges.subarray(0, 4)]).toEqual([0, 6, 0, 0]);
  });
});

const SNOWDON = resolve(__dirname, '../../../test-models/Snowdon Towers Sample Architectural.bimgo');

describe.runIf(existsSync(SNOWDON))('Snowdon walk', () => {
  it('builds batches and a BVH and keeps a walker on a floor', async () => {
    const { scene } = await BimGoReader.read(await openAsBlob(SNOWDON), 'Snowdon.bimgo');
    let t = performance.now();
    const batches = new SceneBatches(scene);
    const batchMs = performance.now() - t;
    t = performance.now();
    const bvh = new Bvh(scene);
    const bvhMs = performance.now() - t;
    expect(batches.indices.length).toBe(scene.geometry.indices.length);
    expect(bvh.triangleCount).toBeGreaterThan(700000);

    // Drop onto the first level's floor somewhere near the middle, then walk for 5 s
    const level = scene.levels.find(l => l.elevation >= scene.bounds.min.z) ?? scene.levels[0];
    const c = scene.bounds.center;
    const hit = bvh.raycast(vec3(c.x, c.y, level.elevation + 1.7), vec3(0, 0, -1), 3, null);
    const controller = new CharacterController(bvh);
    controller.groundZ = scene.levels[0].elevation - 0.1;
    const player = new Player(controller);
    player.teleportTo(hit ? vec3(hit.point.x, hit.point.y, hit.point.z + 0.02) : vec3(c.x, c.y, level.elevation + 0.5));
    const input = new InputState();
    input.onKey(Vk.key('W'), true, false);

    t = performance.now();
    for (let i = 0; i < 600; i++) {
      player.yaw += 0.01;
      player.fixedUpdate(1 / 120, input, true);
    }
    const tickMs = (performance.now() - t) / 600;
    expect(Number.isFinite(controller.feet.z)).toBe(true);
    expect(controller.feet.z).toBeGreaterThan(controller.groundZ - 0.01);
    console.info(`Snowdon: batches ${batchMs.toFixed(0)} ms (${batches.chunkTotal} chunks), BVH ${bvhMs.toFixed(0)} ms (${bvh.nodeCount} nodes), ` +
      `${tickMs.toFixed(3)} ms per physics tick, ended at z ${controller.feet.z.toFixed(2)} (grounded ${controller.grounded})`);
  }, 120000);
});
