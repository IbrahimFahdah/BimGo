import type { Matrix4x4 } from '../math/Matrix4x4';
import { type Vec3, vec3 } from '../math/Vector';
import { Aabb, SCENE_VERTEX_WORDS, type SceneData } from '../scene/SceneData';
import { ClashGeometry, ClashTriangle, ClosestResult, CrossResult } from './ClashGeometry';
import { ClashDefaults, ClashKind } from './ClashModels';

/**
 * One thing to test: an element's triangles, where they are now. A static element uses the snapshot's coordinates; a
 * moved original, clone or placement carries its rigid transform (the walkthrough "as walked").
 */
export interface ClashItem {
  /** Index into scene.elements (the source of the triangles). */
  element: number;
  /** The walkthrough clone key of a clone / placement, else 0. */
  cloneKey: number;
  /** Snapshot → current position (row vectors), or null for a static element. */
  transform: Matrix4x4 | null;
  /** The current bounds (scene-local metres). */
  bounds: Aabb;
}

export const ClashItems = {
  /** An element where the snapshot has it. */
  static(scene: SceneData, element: number): ClashItem {
    return { element, cloneKey: 0, transform: null, bounds: scene.elements[element].bounds };
  },
  /** A moved element, clone or placement: the source element's triangles under a transform. */
  moved(element: number, transform: Matrix4x4, bounds: Aabb, cloneKey: number): ClashItem {
    return { element, cloneKey, transform, bounds };
  }
};

/** What one run tests. */
export interface ClashJob {
  scene: SceneData;
  /** Everything that can take part (one entry per element as walked; demolished / deleted left out). */
  items: ClashItem[];
  /** Set A: indices into items. */
  setA: number[];
  /** Set B: indices into items, or null to test set A against itself. */
  setB: number[] | null;
  kind?: string;
  /** Metres (hard: depth ignored; clearance: the distance). */
  tolerance?: number;
  /** The run stops after this many clashes. */
  maxClashes?: number;
}

/** One clash found: the two items (set A's first), the point (scene-local), and the depth or gap. */
export interface ClashHit {
  itemA: number;
  itemB: number;
  point: Vec3;
  distance: number;
  crossing: boolean;
  approximate: boolean;
}

export interface ClashRunResult {
  hits: ClashHit[];
  truncated: boolean;
  cancelled: boolean;
  /** Element pairs whose boxes met. */
  candidates: number;
  countA: number;
  countB: number;
  seconds: number;
}

/** Progress for a run: stages, steps, a detail line, and a cancel flag the caller sets. */
export interface ClashProgress {
  begin(stage: string, from: number, to: number): void;
  step(done: number, total: number): void;
  detail(text: string): void;
  readonly cancelRequested: boolean;
}

/** Elements with at least this many triangles get a triangle tree for the run. */
const TREE_MIN_TRIANGLES = 384;
/** The trees of one run stop growing past this many triangles in total (memory guard). */
const TREE_TRIANGLE_BUDGET = 3_000_000;
/** Corners per element tried by the inside test of a shallow crossing. */
const MAX_INSIDE_CORNERS = 512;
/** Crossing points kept per pair for the width estimate. */
const MAX_CROSSING_POINTS = 4096;
/** Milliseconds of work between yields to the page (the progress screen draws meanwhile). */
const SLICE_MS = 24;

/**
 * Clash detection (port of BimGo.Core/Clashes/ClashEngine.cs, Round C): sweep and prune over the items' boxes (clearance
 * tests grow each box by half the distance); pairs skipped (an element with itself, a host with its inserts in the
 * same model); per pair, each element's triangles inside the pair's overlap box (large elements keep a triangle tree
 * for the run), a second sweep over those triangles' boxes and exact triangle tests. Hard depth is an estimate: the
 * narrowest width of the crossing outline; when that is within the tolerance, corners of one element lying inside the
 * other deeper than the tolerance still make a clash. Clearance reports crossings (tagged) and gaps under the distance.
 * The browser has one thread for this: the run works in slices and yields between them (job progress shows).
 */
export const ClashEngine = {
  async run(job: ClashJob, progress: ClashProgress | null = null, yieldToPage: (() => Promise<void>) | null = null): Promise<ClashRunResult> {
    const started = performance.now();
    const scene = job.scene, items = job.items ?? [];
    const self = job.setB === null;
    const clearance = ClashKind.normalise(job.kind ?? ClashKind.HARD) === ClashKind.CLEARANCE;
    const tolerance = Math.max(0, job.tolerance ?? ClashDefaults.HARD_TOLERANCE);
    const maxClashes = job.maxClashes ?? ClashDefaults.MAX_CLASHES_PER_TEST;
    let sliceStart = performance.now();
    const pause = async (): Promise<void> => {
      if (!yieldToPage || performance.now() - sliceStart < SLICE_MS) { return; }
      await yieldToPage();
      sliceStart = performance.now();
    };

    // Membership: 1 = set A, 2 = set B (a self test puts set A in both)
    const member = new Uint8Array(items.length);
    let countA = 0, countB = 0;
    for (const i of job.setA ?? []) {
      if (i < 0 || i >= items.length || (member[i] & 1) !== 0) { continue; }
      member[i] |= self ? 3 : 1;
      countA++;
    }
    if (self) { countB = countA; }
    else {
      for (const i of job.setB!) {
        if (i < 0 || i >= items.length || (member[i] & 2) !== 0) { continue; }
        member[i] |= 2;
        countB++;
      }
    }

    progress?.begin('Finding elements near each other', 0, 0.1);
    const pairs = await findPairs(scene, items, member, self, clearance ? tolerance * 0.5 : 1e-4, progress, pause);
    if (progress?.cancelRequested) {
      return { hits: [], truncated: false, cancelled: true, candidates: 0, countA, countB, seconds: (performance.now() - started) / 1000 };
    }

    progress?.begin('Testing triangles', 0.1, 1);
    progress?.detail(`${pairs.length.toLocaleString('en')} element pairs to test`);
    const context = new RunContext(scene, items);
    const scratch = new PairScratch();
    const hits: ClashHit[] = [];
    let truncated = false;
    for (let index = 0; index < pairs.length; index += 2) {
      if (progress?.cancelRequested) { break; }
      if (hits.length >= maxClashes) {
        truncated = true;
        break;
      }
      const a = pairs[index], b = pairs[index + 1];
      try {
        const hit = testPair(context, scratch, a, b, clearance, tolerance);
        if (hit) {
          hits.push(hit);
          if (hits.length >= maxClashes) { truncated = true; }
        }
      } catch (e) {
        // A broken element must not stop the run
        console.info(`Clash test skipped a pair (${items[a].element} × ${items[b].element}): ${e instanceof Error ? e.message : String(e)}`);
      }
      const finished = index / 2 + 1;
      if ((finished & 255) === 0 && progress) {
        progress.step(finished, pairs.length / 2);
        progress.detail(`${finished.toLocaleString('en')} of ${(pairs.length / 2).toLocaleString('en')} pairs · ${hits.length.toLocaleString('en')} clashes`);
      }
      if ((finished & 15) === 0) { await pause(); }
    }
    if (truncated && hits.length < maxClashes) { truncated = false; }

    const cancelled = progress?.cancelRequested ?? false;
    const seconds = (performance.now() - started) / 1000;
    console.info(`Clash run (${clearance ? 'clearance' : 'hard'} ${(tolerance * 1000).toFixed(1)} mm): ${countA} × ${self ? 'itself' : countB} elements, `
      + `${pairs.length / 2} pairs, ${hits.length} clashes${truncated ? ' (limit reached)' : ''}${cancelled ? ' (cancelled)' : ''}, `
      + `${context.treeTriangles} triangles in trees, ${seconds.toFixed(1)} s.`);
    return { hits, truncated, cancelled, candidates: pairs.length / 2, countA, countB, seconds };
  }
};

// #region Broad phase

/**
 * Sweep and prune: every pair of items whose boxes (grown) meet and that the test asks for, set A's item first (self
 * test: the lower index first). Returned flat (a0, b0, a1, b1…), sorted.
 */
async function findPairs(scene: SceneData, items: ClashItem[], member: Uint8Array, self: boolean, grow: number,
  progress: ClashProgress | null, pause: () => Promise<void>): Promise<number[]> {
  const list: number[] = [];
  let lox = Infinity, loy = Infinity, loz = Infinity, hix = -Infinity, hiy = -Infinity, hiz = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const b = items[i].bounds;
    if (member[i] === 0 || !b.isValid) { continue; }
    list.push(i);
    const cx = (b.min.x + b.max.x) * 0.5, cy = (b.min.y + b.max.y) * 0.5, cz = (b.min.z + b.max.z) * 0.5;
    lox = Math.min(lox, cx); loy = Math.min(loy, cy); loz = Math.min(loz, cz);
    hix = Math.max(hix, cx); hiy = Math.max(hiy, cy); hiz = Math.max(hiz, cz);
  }
  const found: [number, number][] = [];
  if (list.length < 2) { return []; }

  // Sweep along the axis the centres spread most
  const sx = hix - lox, sy = hiy - loy, sz = hiz - loz;
  const axis = sx >= sy && sx >= sz ? 'x' : sy >= sz ? 'y' : 'z';
  const order = list.slice().sort((p, q) => items[p].bounds.min[axis] - items[q].bounds.min[axis]);

  const active: number[] = [];
  for (let k = 0; k < order.length; k++) {
    if ((k & 1023) === 0) {
      progress?.step(k, order.length);
      if (progress?.cancelRequested) { return []; }
      await pause();
    }
    const p = order[k];
    const pb = items[p].bounds;
    const start = pb.min[axis] - grow;
    for (let j = active.length - 1; j >= 0; j--) {
      if (items[active[j]].bounds.max[axis] + grow < start) {
        active[j] = active[active.length - 1];
        active.pop();
      }
    }
    for (const q of active) {
      const qb = items[q].bounds;
      if (!overlap(pb, qb, grow * 2)) { continue; }
      const pair = wanted(member, self, p, q);
      if (!pair) { continue; }
      if (skipped(scene, items[pair[0]], items[pair[1]])) { continue; }
      found.push(pair);
    }
    active.push(p);
  }

  // A stable order makes runs repeatable (and the progress bar honest)
  found.sort((x, y) => x[0] !== y[0] ? x[0] - y[0] : x[1] - y[1]);
  const flat: number[] = new Array<number>(found.length * 2);
  found.forEach(([a, b], i) => { flat[i * 2] = a; flat[i * 2 + 1] = b; });
  return flat;
}

/** The pair in the test's order (set A's item first), or null when the test doesn't ask for it. */
function wanted(member: Uint8Array, self: boolean, p: number, q: number): [number, number] | null {
  const lo = Math.min(p, q), hi = Math.max(p, q);
  if (self) { return [lo, hi]; }
  const pA = (member[p] & 1) !== 0, pB = (member[p] & 2) !== 0, qA = (member[q] & 1) !== 0, qB = (member[q] & 2) !== 0;
  if (pA && qB && qA && pB) { return [lo, hi]; } // both in both sets: once, lower index first
  if (pA && qB) { return [p, q]; }
  if (qA && pB) { return [q, p]; }
  return null;
}

/** Pairs never tested: an element with itself, a host with its own inserts (same model). */
function skipped(scene: SceneData, a: ClashItem, b: ClashItem): boolean {
  const ea = scene.elements[a.element], eb = scene.elements[b.element];
  if (a.cloneKey !== 0 || b.cloneKey !== 0) { return a.cloneKey === b.cloneKey && a.element === b.element; }
  if (a.element === b.element) { return true; }
  if (ea.link !== eb.link) { return false; }
  return (ea.hostId !== 0 && ea.hostId === eb.elementId) || (eb.hostId !== 0 && eb.hostId === ea.elementId);
}

function overlap(a: Aabb, b: Aabb, grow: number): boolean {
  return a.min.x <= b.max.x + grow && a.max.x + grow >= b.min.x
    && a.min.y <= b.max.y + grow && a.max.y + grow >= b.min.y
    && a.min.z <= b.max.z + grow && a.max.z + grow >= b.min.z;
}

// #endregion

// #region Narrow phase

/** Box (min / max) as six numbers. */
interface Box { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

function boxOf(b: Aabb, grow = 0): Box {
  return { minX: b.min.x - grow, minY: b.min.y - grow, minZ: b.min.z - grow, maxX: b.max.x + grow, maxY: b.max.y + grow, maxZ: b.max.z + grow };
}

function intersect(a: Box, b: Box): Box {
  return { minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), minZ: Math.max(a.minZ, b.minZ), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY), maxZ: Math.min(a.maxZ, b.maxZ) };
}

function growBox(b: Box, amount: number): Box {
  return { minX: b.minX - amount, minY: b.minY - amount, minZ: b.minZ - amount, maxX: b.maxX + amount, maxY: b.maxY + amount, maxZ: b.maxZ + amount };
}

const validBox = (b: Box) => b.minX <= b.maxX && b.minY <= b.maxY && b.minZ <= b.maxZ;

/** Tests one pair. Hard: crossings, depth over the tolerance. Clearance: crossings or gaps under the distance. */
function testPair(context: RunContext, s: PairScratch, a: number, b: number, clearance: boolean, tolerance: number): ClashHit | null {
  const ia = context.items[a], ib = context.items[b];
  const ea = context.scene.elements[ia.element], eb = context.scene.elements[ib.element];

  // Where the two can meet (clearance: each box grown by the distance towards the other)
  const reach = clearance ? tolerance : 0;
  const overlapA = intersect(boxOf(ia.bounds), boxOf(ib.bounds, reach + 1e-4));
  const overlapB = intersect(boxOf(ib.bounds), boxOf(ia.bounds, reach + 1e-4));
  if (!validBox(overlapA) || !validBox(overlapB)) { return null; }
  const cx = (overlapA.minX + overlapA.maxX + overlapB.minX + overlapB.maxX) * 0.25;
  const cy = (overlapA.minY + overlapA.maxY + overlapB.minY + overlapB.maxY) * 0.25;
  const cz = (overlapA.minZ + overlapA.maxZ + overlapB.minZ + overlapB.maxZ) * 0.25;

  // Hard tests also take faces within the tolerance around the overlap (the inside test needs the nearest surface)
  context.gather(a, clearance ? overlapA : growBox(overlapA, tolerance), cx, cy, cz, s.trianglesA);
  if (s.trianglesA.count === 0) { return null; }
  context.gather(b, clearance ? overlapB : growBox(overlapB, tolerance), cx, cy, cz, s.trianglesB);
  if (s.trianglesB.count === 0) { return null; }

  const approximate = ea.isProxy || eb.isProxy;
  return clearance ? testClearance(s, a, b, tolerance, cx, cy, cz, approximate) : testHard(context, s, a, b, tolerance, cx, cy, cz, approximate);
}

function testHard(context: RunContext, s: PairScratch, a: number, b: number, tolerance: number, cx: number, cy: number, cz: number, approximate: boolean): ClashHit | null {
  s.points.length = 0;
  s.directions.length = 0;
  s.directions.push(1, 0, 0, 0, 1, 0, 0, 0, 1);
  const ta = s.trianglesA.items, tb = s.trianglesB.items, cross = s.cross;
  sweepTriangles(s, 0, (i, j) => {
    if (!ClashGeometry.crosses(ta[i], tb[j], cross)) { return true; }
    if (s.points.length < (MAX_CROSSING_POINTS - 1) * 3) { s.points.push(cross.px, cross.py, cross.pz, cross.qx, cross.qy, cross.qz); }
    addDirection(s.directions, ta[i]);
    addDirection(s.directions, tb[j]);
    return true;
  });
  if (s.points.length === 0) { return null; }

  // Depth: the narrowest width of the crossing outline
  let depth = Number.MAX_VALUE;
  const points = s.points, directions = s.directions;
  for (let d = 0; d < directions.length; d += 3) {
    const dx = directions[d], dy = directions[d + 1], dz = directions[d + 2];
    let min = Number.MAX_VALUE, max = -Number.MAX_VALUE;
    for (let p = 0; p < points.length; p += 3) {
      const t = points[p] * dx + points[p + 1] * dy + points[p + 2] * dz;
      if (t < min) { min = t; }
      if (t > max) { max = t; }
    }
    depth = Math.min(depth, max - min);
  }

  // Shallow outline: corners buried deeper than the tolerance still count (a pipe lying sunk in a slab)
  if (depth <= tolerance) {
    const buried = Math.max(
      buriedDepth(context, s, s.trianglesA, b, s.trianglesB, tolerance, cx, cy, cz),
      buriedDepth(context, s, s.trianglesB, a, s.trianglesA, tolerance, cx, cy, cz));
    depth = Math.max(depth, buried);
  }
  if (depth <= tolerance) { return null; }

  let sx = 0, sy = 0, sz = 0;
  for (let p = 0; p < points.length; p += 3) { sx += points[p]; sy += points[p + 1]; sz += points[p + 2]; }
  const n = points.length / 3;
  return { itemA: a, itemB: b, point: vec3(sx / n + cx, sy / n + cy, sz / n + cz), distance: depth, crossing: true, approximate };
}

function testClearance(s: PairScratch, a: number, b: number, distance: number, cx: number, cy: number, cz: number, approximate: boolean): ClashHit | null {
  const ta = s.trianglesA.items, tb = s.trianglesB.items, cross = s.cross, closest = s.closest;
  let best = Number.MAX_VALUE;
  let crossing = false;
  let bx = 0, by = 0, bz = 0;
  sweepTriangles(s, distance, (i, j) => {
    if (ClashGeometry.crosses(ta[i], tb[j], cross)) {
      best = 0;
      bx = (cross.px + cross.qx) * 0.5;
      by = (cross.py + cross.qy) * 0.5;
      bz = (cross.pz + cross.qz) * 0.5;
      if (!cross.proper) { return true; } // touching: distance 0, keep looking for a real crossing
      crossing = true;
      return false; // a crossing settles it
    }
    const d = ClashGeometry.distance(ta[i], tb[j], closest);
    if (d < best) {
      best = d;
      bx = (closest.ax + closest.bx) * 0.5;
      by = (closest.ay + closest.by) * 0.5;
      bz = (closest.az + closest.bz) * 0.5;
    }
    return true;
  });
  if (!crossing && best >= distance) { return null; }
  return { itemA: a, itemB: b, point: vec3(bx + cx, by + cy, bz + cz), distance: best, crossing, approximate };
}

/** Sweep and prune over the two triangle lists' boxes (grown), calling test for each pair that meets until it returns false. */
function sweepTriangles(s: PairScratch, grow: number, test: (i: number, j: number) => boolean): void {
  const na = s.trianglesA.count, nb = s.trianglesB.count;
  const ta = s.trianglesA.items, tb = s.trianglesB.items;
  const oa = s.order(0, na), ob = s.order(1, nb);
  for (let i = 0; i < na; i++) { oa[i] = i; }
  for (let j = 0; j < nb; j++) { ob[j] = j; }
  oa.sort((x, y) => ta[x].minX - ta[y].minX);
  ob.sort((x, y) => tb[x].minX - tb[y].minX);

  // For each A triangle (by min x), walk B triangles from the first that could still reach it
  let startB = 0;
  for (let ii = 0; ii < na; ii++) {
    const t = ta[oa[ii]];
    while (startB < nb && tb[ob[startB]].maxX + grow < t.minX) { startB++; } // dead for every later A triangle too
    for (let jj = startB; jj < nb; jj++) {
      const u = tb[ob[jj]];
      if (u.minX - grow > t.maxX) { break; }
      if (u.maxX + grow < t.minX) { continue; }
      if (t.minY > u.maxY + grow || t.maxY + grow < u.minY || t.minZ > u.maxZ + grow || t.maxZ + grow < u.minZ) { continue; }
      if (!test(oa[ii], ob[jj])) { return; }
    }
  }
}

/**
 * How deep the corners of one list sit inside the other item: the largest distance to the other's surface among
 * corners inside it and further than the tolerance from every face near them (0 when none).
 */
function buriedDepth(context: RunContext, s: PairScratch, corners: TriangleList, other: number, otherNear: TriangleList,
  tolerance: number, cx: number, cy: number, cz: number): number {
  let deepest = 0, tried = 0;
  const near = otherNear.items, closest = s.point;
  for (let i = 0; i < corners.count && tried < MAX_INSIDE_CORNERS; i++) {
    const t = corners.items[i];
    for (let k = 0; k < 3 && tried < MAX_INSIDE_CORNERS; k++) {
      const px = k === 0 ? t.ax : k === 1 ? t.bx : t.cx;
      const py = k === 0 ? t.ay : k === 1 ? t.by : t.cy;
      const pz = k === 0 ? t.az : k === 1 ? t.bz : t.cz;
      tried++;

      // Nearest face of the other element (among those within reach of this pair)
      let nearest = Number.MAX_VALUE;
      for (let j = 0; j < otherNear.count; j++) {
        const u = near[j];
        if (px < u.minX - nearest || px > u.maxX + nearest || py < u.minY - nearest || py > u.maxY + nearest
          || pz < u.minZ - nearest || pz > u.maxZ + nearest) { continue; }
        ClashGeometry.closestOnTriangle(px, py, pz, u, closest);
        const d = Math.hypot(px - closest.x, py - closest.y, pz - closest.z);
        if (d < nearest) { nearest = d; }
        if (nearest <= tolerance) { break; }
      }
      if (nearest <= tolerance || nearest <= deepest) { continue; }
      if (!context.inside(other, px + cx, py + cy, pz + cz, s)) { continue; }

      // No face of the other element within reach: its box gives an upper bound for the depth
      if (nearest === Number.MAX_VALUE) { nearest = depthInBox(context.items[other].bounds, px + cx, py + cy, pz + cz); }
      deepest = Math.max(deepest, nearest);
    }
  }
  return deepest;
}

/** How far a point inside a box is from the box's nearest face. */
function depthInBox(box: Aabb, px: number, py: number, pz: number): number {
  return Math.max(0, Math.min(px - box.min.x, py - box.min.y, pz - box.min.z, box.max.x - px, box.max.y - py, box.max.z - pz));
}

function addDirection(directions: number[], t: ClashTriangle): void {
  if (t.isDegenerate || directions.length >= 45) { return; }
  for (let d = 0; d < directions.length; d += 3) {
    if (Math.abs(directions[d] * t.nx + directions[d + 1] * t.ny + directions[d + 2] * t.nz) > 0.995) { return; }
  }
  directions.push(t.nx, t.ny, t.nz);
}

// #endregion

// #region Per-run state

/** A growable list of reusable triangles. */
export class TriangleList {
  items: ClashTriangle[] = [];
  count = 0;

  clear(): void {
    this.count = 0;
  }

  /** The next triangle to fill (reused across pairs). */
  next(): ClashTriangle {
    if (this.count === this.items.length) { this.items.push(new ClashTriangle()); }
    return this.items[this.count++];
  }
}

/** The buffers of a run (reused across pairs). */
class PairScratch {
  readonly trianglesA = new TriangleList();
  readonly trianglesB = new TriangleList();
  readonly whole = new TriangleList();
  readonly points: number[] = [];
  readonly directions: number[] = [];
  readonly nodes: number[] = [];
  readonly cross = new CrossResult();
  readonly closest = new ClosestResult();
  readonly point = { x: 0, y: 0, z: 0 };
  private readonly orders: number[][] = [[], []];

  order(which: number, n: number): number[] {
    const list = this.orders[which];
    list.length = n;
    return list;
  }
}

/** The run's shared state: the scene, the items and the triangle trees of large elements (built on first use). */
class RunContext {
  private readonly trees = new Map<number, TriangleTree | null>();
  treeTriangles = 0;

  constructor(readonly scene: SceneData, readonly items: ClashItem[]) {}

  /** An item's triangles whose boxes meet the query box, relative to the centre. */
  gather(itemIndex: number, query: Box, cx: number, cy: number, cz: number, output: TriangleList): void {
    output.clear();
    const tree = this.treeFor(itemIndex);
    if (tree) {
      tree.query(query, cx, cy, cz, output);
      return;
    }
    const item = this.items[itemIndex], e = this.scene.elements[item.element];
    gatherRange(this.scene, item, e.opaqueStart, e.opaqueCount, query, cx, cy, cz, output);
    gatherRange(this.scene, item, e.transparentStart, e.transparentCount, query, cx, cy, cz, output);
  }

  /** True when a point (scene-local) is inside an item's solid (even–odd rule over all its triangles). */
  inside(itemIndex: number, px: number, py: number, pz: number, scratch: PairScratch): boolean {
    const item = this.items[itemIndex], b = item.bounds;
    if (px < b.min.x || px > b.max.x || py < b.min.y || py > b.max.y || pz < b.min.z || pz > b.max.z) { return false; }
    const tree = this.treeFor(itemIndex);
    if (tree) { return tree.inside(px, py, pz, scratch.nodes); }
    const e = this.scene.elements[item.element];
    const all: Box = { minX: -Infinity, minY: -Infinity, minZ: -Infinity, maxX: Infinity, maxY: Infinity, maxZ: Infinity };
    scratch.whole.clear();
    gatherRange(this.scene, item, e.opaqueStart, e.opaqueCount, all, px, py, pz, scratch.whole);
    gatherRange(this.scene, item, e.transparentStart, e.transparentCount, all, px, py, pz, scratch.whole);
    return ClashGeometry.inside(0, 0, 0, scratch.whole.items, scratch.whole.count);
  }

  private treeFor(itemIndex: number): TriangleTree | null {
    const known = this.trees.get(itemIndex);
    if (known !== undefined) { return known; }
    const item = this.items[itemIndex], e = this.scene.elements[item.element];
    const triangles = Math.trunc((e.opaqueCount + e.transparentCount) / 3);
    if (triangles < TREE_MIN_TRIANGLES || this.treeTriangles + triangles > TREE_TRIANGLE_BUDGET) {
      if (triangles < TREE_MIN_TRIANGLES) { this.trees.set(itemIndex, null); }
      return null;
    }
    // Keyed by item (a moved original and its clone sit in different places)
    this.treeTriangles += triangles;
    const tree = TriangleTree.build(this.scene, item);
    this.trees.set(itemIndex, tree);
    return tree;
  }
}

/** Reads one corner of an item's triangle (transformed when the item moved). */
function corner(scene: SceneData, item: ClashItem, vertex: number, out: Float64Array, offset: number): void {
  const f = scene.geometry.floats, w = vertex * SCENE_VERTEX_WORDS;
  const x = f[w], y = f[w + 1], z = f[w + 2];
  const m = item.transform;
  if (m) {
    out[offset] = x * m[0] + y * m[4] + z * m[8] + m[12];
    out[offset + 1] = x * m[1] + y * m[5] + z * m[9] + m[13];
    out[offset + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
  } else {
    out[offset] = x;
    out[offset + 1] = y;
    out[offset + 2] = z;
  }
}

const CORNERS = new Float64Array(9);

function gatherRange(scene: SceneData, item: ClashItem, start: number, count: number, query: Box, cx: number, cy: number, cz: number, output: TriangleList): void {
  const indices = scene.geometry.indices;
  const end = Math.min(indices.length, start + count);
  const p = CORNERS;
  for (let k = Math.max(0, start); k + 2 < end; k += 3) {
    corner(scene, item, indices[k], p, 0);
    corner(scene, item, indices[k + 1], p, 3);
    corner(scene, item, indices[k + 2], p, 6);
    if (Math.min(p[0], p[3], p[6]) > query.maxX || Math.max(p[0], p[3], p[6]) < query.minX
      || Math.min(p[1], p[4], p[7]) > query.maxY || Math.max(p[1], p[4], p[7]) < query.minY
      || Math.min(p[2], p[5], p[8]) > query.maxZ || Math.max(p[2], p[5], p[8]) < query.minZ) { continue; }
    output.next().set(p[0] - cx, p[1] - cy, p[2] - cz, p[3] - cx, p[4] - cy, p[5] - cz, p[6] - cx, p[7] - cy, p[8] - cz);
  }
}

/**
 * A small bounding-volume tree over one large element's triangles (as walked), built once per run so the many pairs
 * touching that element (a slab under a hundred pipes) don't each scan all its triangles (port of TriangleTree). Median
 * split on the longest axis, up to LEAF_SIZE triangles per leaf.
 */
class TriangleTree {
  private static readonly LEAF_SIZE = 8;
  private triangles: ClashTriangle[] = [];
  private bounds: number[] = []; // per node: min x y z, max x y z
  private first: number[] = [];
  private count: number[] = [];
  private right: number[] = [];
  private nodes = 0;

  static build(scene: SceneData, item: ClashItem): TriangleTree {
    const e = scene.elements[item.element];
    const list = new TriangleList();
    const all: Box = { minX: -Infinity, minY: -Infinity, minZ: -Infinity, maxX: Infinity, maxY: Infinity, maxZ: Infinity };
    gatherRange(scene, item, e.opaqueStart, e.opaqueCount, all, 0, 0, 0, list);
    gatherRange(scene, item, e.transparentStart, e.transparentCount, all, 0, 0, 0, list);
    const tree = new TriangleTree();
    tree.triangles = list.items.slice(0, list.count);
    if (tree.triangles.length > 0) { tree.buildNode(0, tree.triangles.length); }
    return tree;
  }

  private buildNode(start: number, count: number): number {
    const node = this.nodes++;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cminX = Infinity, cminY = Infinity, cminZ = Infinity, cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;
    for (let i = start; i < start + count; i++) {
      const t = this.triangles[i];
      minX = Math.min(minX, t.minX); minY = Math.min(minY, t.minY); minZ = Math.min(minZ, t.minZ);
      maxX = Math.max(maxX, t.maxX); maxY = Math.max(maxY, t.maxY); maxZ = Math.max(maxZ, t.maxZ);
      const cx = (t.minX + t.maxX) * 0.5, cy = (t.minY + t.maxY) * 0.5, cz = (t.minZ + t.maxZ) * 0.5;
      cminX = Math.min(cminX, cx); cminY = Math.min(cminY, cy); cminZ = Math.min(cminZ, cz);
      cmaxX = Math.max(cmaxX, cx); cmaxY = Math.max(cmaxY, cy); cmaxZ = Math.max(cmaxZ, cz);
    }
    this.bounds[node * 6] = minX; this.bounds[node * 6 + 1] = minY; this.bounds[node * 6 + 2] = minZ;
    this.bounds[node * 6 + 3] = maxX; this.bounds[node * 6 + 4] = maxY; this.bounds[node * 6 + 5] = maxZ;

    const sx = cmaxX - cminX, sy = cmaxY - cminY, sz = cmaxZ - cminZ;
    if (count <= TriangleTree.LEAF_SIZE || sx * sx + sy * sy + sz * sz < 1e-12) {
      this.first[node] = start;
      this.count[node] = count;
      return node;
    }

    // Median split along the centres' longest axis
    const centre = sx >= sy && sx >= sz ? (t: ClashTriangle) => t.minX + t.maxX : sy >= sz ? (t: ClashTriangle) => t.minY + t.maxY : (t: ClashTriangle) => t.minZ + t.maxZ;
    const part = this.triangles.slice(start, start + count).sort((a, b) => centre(a) - centre(b));
    for (let i = 0; i < count; i++) { this.triangles[start + i] = part[i]; }
    const half = Math.trunc(count / 2);
    this.count[node] = 0;
    const left = this.buildNode(start, half);
    const right = this.buildNode(start + half, count - half);
    this.first[node] = left;
    this.right[node] = right;
    return node;
  }

  /** Adds the triangles whose boxes meet the query (scene-local) to output, relative to the centre. */
  query(query: Box, cx: number, cy: number, cz: number, output: TriangleList): void {
    if (this.nodes === 0) { return; }
    const stack = [0];
    const b = this.bounds;
    while (stack.length > 0) {
      const node = stack.pop()!;
      const o = node * 6;
      if (b[o] > query.maxX || b[o + 3] < query.minX || b[o + 1] > query.maxY || b[o + 4] < query.minY || b[o + 2] > query.maxZ || b[o + 5] < query.minZ) { continue; }
      if (this.count[node] > 0) {
        for (let i = this.first[node]; i < this.first[node] + this.count[node]; i++) {
          const t = this.triangles[i];
          if (t.minX > query.maxX || t.maxX < query.minX || t.minY > query.maxY || t.maxY < query.minY || t.minZ > query.maxZ || t.maxZ < query.minZ) { continue; }
          output.next().copyFrom(t, cx, cy, cz);
        }
        continue;
      }
      stack.push(this.first[node], this.right[node]);
    }
  }

  /** True when a scene-local point is inside the element's solid (even–odd along three skewed rays, two of three agreeing). */
  inside(px: number, py: number, pz: number, stack: number[]): boolean {
    let votes = 0;
    if ((this.crossings(px, py, pz, ClashGeometry.insideRay(0), stack) & 1) === 1) { votes++; }
    if ((this.crossings(px, py, pz, ClashGeometry.insideRay(1), stack) & 1) === 1) { votes++; }
    if (votes === 1 && (this.crossings(px, py, pz, ClashGeometry.insideRay(2), stack) & 1) === 1) { votes++; }
    return votes >= 2;
  }

  private crossings(ox: number, oy: number, oz: number, direction: Float64Array, stack: number[]): number {
    if (this.nodes === 0) { return 0; }
    const dx = direction[0], dy = direction[1], dz = direction[2];
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let count = 0;
    stack.length = 0;
    stack.push(0);
    const b = this.bounds;
    while (stack.length > 0) {
      const node = stack.pop()!;
      const o = node * 6;
      // Slab test from the origin forwards
      const t1x = (b[o] - ox) * ix, t2x = (b[o + 3] - ox) * ix;
      const t1y = (b[o + 1] - oy) * iy, t2y = (b[o + 4] - oy) * iy;
      const t1z = (b[o + 2] - oz) * iz, t2z = (b[o + 5] - oz) * iz;
      const enter = Math.max(Math.min(t1x, t2x), Math.min(t1y, t2y), Math.min(t1z, t2z));
      const leave = Math.min(Math.max(t1x, t2x), Math.max(t1y, t2y), Math.max(t1z, t2z));
      if (leave < Math.max(enter, 0)) { continue; }
      if (this.count[node] > 0) {
        for (let i = this.first[node]; i < this.first[node] + this.count[node]; i++) {
          if (ClashGeometry.rayHits(ox, oy, oz, dx, dy, dz, this.triangles[i])) { count++; }
        }
        continue;
      }
      stack.push(this.first[node], this.right[node]);
    }
    return count;
  }
}

// #endregion
