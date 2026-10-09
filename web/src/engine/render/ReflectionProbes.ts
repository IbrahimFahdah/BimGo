import type { Matrix4x4 } from '../../core/math/Matrix4x4';
import { Mat4 } from '../../core/math/Matrix4x4';
import { type Vec3, vec3 } from '../../core/math/Vector';
import { findCategory, KEY_DOORS } from '../../core/scene/CategoryCatalog';
import { isMaterialsEmpty } from '../../core/scene/MaterialData';
import { Aabb, modelVertexCount, type RoomInfo, roomContains, SCENE_VERTEX_WORDS, type SceneData } from '../../core/scene/SceneData';
import { gl } from '../gl/Gl';
import type { Bvh } from '../physics/Bvh';
import { FpsCamera } from './FpsCamera';
import { LightShadows } from './LightShadows';

/** One probe. */
interface Probe {
  position: Vec3;
  box: Aabb;
  far: number;
  room: number;
  weight: number;
  baked: boolean;
  dirty: boolean;
  provisional: boolean;
  nextFace: number;
}

/** A reflective voxel and the room it lies in (-1 none). */
interface ShinyPoint {
  x: number;
  y: number;
  z: number;
  room: number;
}

/**
 * Reflection probes (port of BimGo.App/Rendering/ReflectionProbes.cs): static captures of the model around a point,
 * read by the scene shader for reflective surfaces instead of the sky.
 * - Where: one probe per room holding a reflective surface (shine tier 25 % + or water), a grid of probes in large
 *   rooms, fallback probes for reflective surfaces outside rooms. Rooms without reflective surfaces get none.
 * - Storage: six faces per probe (the light-shadow face table) in one mipmapped RGBA8 texture array; mips are the blur.
 * - Lookup: a plan grid holds up to two probes per cell and a blend weight (one fetch per fragment); probes blend only
 *   across open room boundaries. Each probe's position and room box sit in a small float texture.
 * - Baking: progressive, two faces per frame, nearest unbaked probe first, then stale ones.
 * Never throws: WebGL failures set {@link lastError} (the renderer then reflects the sky).
 */
export class ReflectionProbes {
  /** Texture units of the probe faces, the lookup grid and the per-probe data (1–10 are shadows, AO, lights, materials). */
  static readonly ARRAY_UNIT = 11;
  static readonly GRID_UNIT = 12;
  static readonly DATA_UNIT = 13;
  static readonly MAX_PROBES = 64;
  static readonly MEMORY_CAP = 64 * 1024 * 1024;
  static readonly FACES_PER_FRAME = 2;
  private static readonly NEAR = 0.05;
  private static readonly SMALLEST_LEVEL = 4;
  private static readonly EYE_HEIGHT = 1.7;
  private static readonly LARGE_ROOM = 12;
  private static readonly ROOM_SPACING = 8;
  private static readonly FALLBACK_CELL = 8;
  private static readonly FALLBACK_HEIGHT = 6;
  private static readonly GRID_CELL = 0.5;
  private static readonly GRID_BAND = 0.5;
  private static readonly FLOOR_TOLERANCE = 0.05;
  private static readonly ROOM_HEADROOM = 1;
  private static readonly OPEN_GAP = 1;
  private static readonly DOOR_BUCKET = 2;
  private static readonly MAX_GRID_TEXELS = 4_000_000;
  private static readonly BLEND_RADIUS = 1;
  private static readonly REFRESH_FAR = 20;
  private static readonly REFRESH_NEAR = 10;

  private scene: SceneData | null = null;
  private shiny: ShinyPoint[] | null = null;
  private readonly probes: Probe[] = [];
  private readonly planes = new Float32Array(24);

  // Lookup grid
  private gridOrigin = vec3();
  private gridCellSize = vec3(0.5, 0.5, 0.5);
  private nx = 0;
  private ny = 0;
  private nz = 0;
  private gridData = new Uint8Array(0);

  // Occluders for the open-boundary test (static walls etc.; set by the session)
  private occluders: Bvh | null = null;
  private occluderMask: boolean[] | null = null;

  // GL
  private array: WebGLTexture | null = null;
  private grid: WebGLTexture | null = null;
  private data: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private readFbo: WebGLFramebuffer | null = null;
  private depth: WebGLRenderbuffer | null = null;
  private size = 0;
  private levels = 0;
  private dataDirty = false;
  private nothingToBake = false;
  private baking = -1;

  /** True once the probes are placed and their textures allocated. */
  ready = false;
  /** The last failure, or null (the renderer reflects the sky). */
  lastError: string | null = null;
  bakedCount = 0;
  pendingCount = 0;
  gpuBytes = 0;

  get count(): number { return this.probes.length; }
  get faceSize(): number { return this.size; }
  /** True after a placement found nothing reflective (no probes, no cost). */
  get nothingReflective(): boolean { return this.nothingToBake; }
  /** Highest mip level the shader may read (the blur of a fully rough surface). */
  get maxLod(): number { return Math.max(0, this.levels - 1); }
  get origin(): Vec3 { return this.gridOrigin; }
  get cell(): Vec3 { return this.gridCellSize; }
  get gridSize(): Vec3 { return vec3(this.nx, this.ny, this.nz); }

  // #region Setup

  /**
   * Places the probes and allocates their textures for a face size (128 or 256). Does nothing when already set up at
   * that size or after a failure.
   * @returns False when probes can't be shown (see lastError; null error = nothing reflective).
   */
  ensure(scene: SceneData, size: number): boolean {
    size = size >= 256 ? 256 : 128;
    if (this.ready && this.size === size && scene === this.scene) { return true; }
    if (this.lastError !== null) { return false; }
    if (this.nothingToBake && scene === this.scene) { return false; }

    this.release();
    const started = performance.now();
    try {
      if (scene !== this.scene || !this.shiny) {
        this.scene = scene;
        this.nothingToBake = false;
        this.shiny = gatherShiny(scene);
      }
      const perProbe = bytesPerProbe(size);
      const maxLayers = Math.max(6, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number);
      const budget = Math.trunc(Math.min(ReflectionProbes.MAX_PROBES, ReflectionProbes.MEMORY_CAP / perProbe, maxLayers / 6));
      this.placeProbes(scene, budget);
      if (this.probes.length === 0) {
        this.nothingToBake = true;
        console.info('Reflection probes: no reflective surfaces (tier 25 % + or water): nothing to bake.');
        return false;
      }
      this.buildGrid(scene);
    } catch (e) {
      this.lastError = 'Reflection probes could not be placed: reflections show the sky';
      console.warn(this.lastError, e);
      this.release();
      return false;
    }
    const planMs = performance.now() - started;

    if (!this.allocate(size)) { return false; }
    this.ready = true;
    this.pendingCount = this.probes.length;
    const inRooms = this.probes.filter(p => p.room >= 0).length;
    console.info(`Reflection probes: ${this.probes.length} placed (${inRooms} in rooms, ${this.probes.length - inRooms} fallback) from ` +
      `${this.shiny!.length.toLocaleString('en')} reflective voxels in ${Math.round(planMs)} ms; ${size} px faces, grid ${this.nx}×${this.ny}×${this.nz} ` +
      `at ${this.gridCellSize.x.toFixed(2)} m, ≈ ${Math.round(this.gpuBytes / 1048576)} MB.`);
    return true;
  }

  private allocate(size: number): boolean {
    while (gl.getError() !== gl.NO_ERROR) { /* clear stale errors */ }
    this.size = size;
    this.levels = 0;
    for (let s = size; s >= ReflectionProbes.SMALLEST_LEVEL; s >>= 1) { this.levels++; }
    const layers = this.probes.length * 6;

    this.array = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + ReflectionProbes.ARRAY_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.array);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, this.levels, gl.RGBA8, size, size, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, this.levels - 1);

    // Lookup grid: RGBA8 (first probe + 1, second probe + 1, second's weight), read with texelFetch
    this.grid = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + ReflectionProbes.GRID_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.grid);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, this.nx, this.ny, this.nz, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.gridData);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 0);

    // Per-probe data: three RGBA32F texels per probe
    this.data = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + ReflectionProbes.DATA_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    this.dataDirty = true;
    this.uploadData();
    gl.activeTexture(gl.TEXTURE0);

    // Capture: colour = one layer of the array, depth = a renderbuffer; a second framebuffer reads for mip blits
    this.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, size, size);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.array, 0, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    this.readFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const error = gl.getError();
    if (error !== gl.NO_ERROR || status !== gl.FRAMEBUFFER_COMPLETE) {
      this.lastError = error === gl.OUT_OF_MEMORY
        ? 'Not enough graphics memory for reflection probes: reflections show the sky'
        : `Reflection probes are not supported by this browser or GPU (0x${(error !== gl.NO_ERROR ? error : status).toString(16)}): reflections show the sky`;
      console.warn(this.lastError);
      this.release();
      return false;
    }
    this.gpuBytes = bytesPerProbe(size) * this.probes.length + this.gridData.length;
    return true;
  }

  /** Frees the GL resources and forgets the placement (the gathered reflective voxels are kept). */
  release(): void {
    gl.deleteTexture(this.array);
    gl.deleteTexture(this.grid);
    gl.deleteTexture(this.data);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteFramebuffer(this.readFbo);
    gl.deleteRenderbuffer(this.depth);
    this.array = this.grid = this.data = null;
    this.fbo = this.readFbo = null;
    this.depth = null;
    this.probes.length = 0;
    this.size = this.levels = 0;
    this.baking = -1;
    this.bakedCount = this.pendingCount = 0;
    this.gpuBytes = 0;
    this.ready = false;
  }

  /** Forgets a failure so the next ensure tries again (the user switched probes on again). */
  clearError(): void {
    this.lastError = null;
  }

  /**
   * The geometry that closes a room boundary for blending: the static BVH and a per-element mask (doors and movable
   * furniture left out). Takes effect at the next placement; without it only door boxes count as openings.
   */
  setOccluders(bvh: Bvh, mask: boolean[]): void {
    this.occluders = bvh;
    this.occluderMask = mask;
  }

  // #endregion

  // #region Placement

  /** Rooms with reflective surfaces (a grid in large rooms), then fallback cells; keeps the budget heaviest. */
  private placeProbes(scene: SceneData, budget: number): void {
    this.probes.length = 0;
    const rooms = scene.rooms;
    const candidates: Probe[] = [];
    const shiny = this.shiny ?? [];
    const probe = (position: Vec3, box: Aabb, far: number, room: number, weight: number): Probe =>
      ({ position, box, far, room, weight, baked: false, dirty: true, provisional: false, nextFace: 0 });

    // Rooms
    const byRoom = new Map<number, ShinyPoint[]>();
    for (const s of shiny) {
      if (s.room < 0) { continue; }
      const list = byRoom.get(s.room);
      if (list) { list.push(s); } else { byRoom.set(s.room, [s]); }
    }
    for (const [r, points] of byRoom) {
      const room = rooms[r];
      const box = new Aabb(vec3(room.min.x, room.min.y, room.bottomZ), vec3(room.max.x, room.max.y, room.topZ));
      const z = Math.min(room.bottomZ + ReflectionProbes.EYE_HEIGHT, (room.bottomZ + room.topZ) * 0.5);
      const s = box.size;
      const far = Math.min(Math.max(Math.hypot(s.x, s.y, s.z) + 15, 25), 80);
      const sizeX = room.max.x - room.min.x, sizeY = room.max.y - room.min.y;

      const spots: { x: number; y: number }[] = [];
      if (Math.max(sizeX, sizeY) <= ReflectionProbes.LARGE_ROOM) {
        spots.push(insideSpot(room, points));
      } else {
        // A grid, kept where it is inside the room and near a reflective surface
        const spacing = ReflectionProbes.ROOM_SPACING;
        const cx = Math.max(1, Math.ceil(sizeX / spacing)), cy = Math.max(1, Math.ceil(sizeY / spacing));
        for (let i = 0; i < cx; i++) {
          for (let j = 0; j < cy; j++) {
            const spot = { x: room.min.x + (i + 0.5) * sizeX / cx, y: room.min.y + (j + 0.5) * sizeY / cy };
            if (!roomContains(room, spot)) { continue; }
            if (points.some(p => (p.x - spot.x) ** 2 + (p.y - spot.y) ** 2 < spacing * spacing)) { spots.push(spot); }
          }
        }
        if (spots.length === 0) { spots.push(insideSpot(room, points)); }
      }

      // Each reflective voxel counts for its nearest probe in the room
      const first = candidates.length;
      for (const spot of spots) { candidates.push(probe(vec3(spot.x, spot.y, z), box, far, r, 0)); }
      for (const p of points) {
        let best = first;
        for (let k = first + 1; k < candidates.length; k++) {
          if (dist2(candidates[k].position, p) < dist2(candidates[best].position, p)) { best = k; }
        }
        candidates[best].weight++;
      }
    }

    // Outside rooms: one probe per fallback cell, above the surfaces' average
    const cells = new Map<string, { sx: number; sy: number; sz: number; n: number }>();
    for (const s of shiny) {
      if (s.room >= 0) { continue; }
      const key = `${Math.floor(s.x / ReflectionProbes.FALLBACK_CELL)},${Math.floor(s.y / ReflectionProbes.FALLBACK_CELL)},${Math.floor(s.z / ReflectionProbes.FALLBACK_HEIGHT)}`;
      const acc = cells.get(key);
      if (acc) { acc.sx += s.x; acc.sy += s.y; acc.sz += s.z; acc.n++; } else { cells.set(key, { sx: s.x, sy: s.y, sz: s.z, n: 1 }); }
    }
    for (const { sx, sy, sz, n } of cells.values()) {
      const ax = sx / n, ay = sy / n, az = sz / n;
      const box = new Aabb(vec3(ax - 12, ay - 12, az - 1), vec3(ax + 12, ay + 12, az + 10));
      candidates.push(probe(vec3(ax, ay, az + ReflectionProbes.EYE_HEIGHT), box, 80, -1, n));
    }

    candidates.sort((a, b) => b.weight - a.weight);
    this.probes.push(...candidates.slice(0, Math.max(0, budget)));
  }

  /**
   * The lookup grid over the probes' boxes, built once per placement: every room claims its cells (the room whose
   * floor is nearest below the cell centre wins), cells take their own room's nearest probe (roomless cells the nearest
   * fallback probe holding them), and probes blend only across open boundaries (a short ray at the band's height
   * crosses no occluder, or the gap is in a door's box; probes of one large room always blend).
   */
  private buildGrid(scene: SceneData): void {
    const started = performance.now();
    const bounds = Aabb.empty();
    for (const p of this.probes) { bounds.include(p.box); }
    const sb = scene.bounds;
    let minX = bounds.min.x, minY = bounds.min.y, minZ = bounds.min.z, maxX = bounds.max.x, maxY = bounds.max.y, maxZ = bounds.max.z;
    if (sb.isValid) {
      minX = Math.max(minX, sb.min.x - 1); minY = Math.max(minY, sb.min.y - 1); minZ = Math.max(minZ, sb.min.z - 1);
      maxX = Math.min(maxX, sb.max.x + 1); maxY = Math.min(maxY, sb.max.y + 1); maxZ = Math.min(maxZ, sb.max.z + 1);
    }

    let cell = ReflectionProbes.GRID_CELL, band = ReflectionProbes.GRID_BAND;
    const ex = Math.max(maxX - minX, 0.1), ey = Math.max(maxY - minY, 0.1), ez = Math.max(maxZ - minZ, 0.1);
    for (;;) {
      this.nx = Math.max(1, Math.ceil(ex / cell));
      this.ny = Math.max(1, Math.ceil(ey / cell));
      this.nz = Math.max(1, Math.ceil(ez / band));
      if (this.nx * this.ny * this.nz <= ReflectionProbes.MAX_GRID_TEXELS && this.nx <= 2048 && this.ny <= 2048 && this.nz <= 256) { break; }
      cell *= 1.25;
      band *= 1.25;
    }
    this.gridOrigin = vec3(minX, minY, minZ);
    this.gridCellSize = vec3(cell, cell, band);
    if (cell > ReflectionProbes.GRID_CELL * 1.5) {
      console.info(`Reflection probes: the lookup grid grew to ${cell.toFixed(2)} m cells × ${band.toFixed(2)} m bands over ` +
        `${ex.toFixed(0)} × ${ey.toFixed(0)} × ${ez.toFixed(0)} m: room edges are coarser on this model.`);
    }

    const nx = this.nx, ny = this.ny, nz = this.nz;
    const total = nx * ny * nz;
    const rooms = scene.rooms;
    const roomOf = this.assignRooms(rooms, total);
    const ox = minX, oy = minY, oz = minZ;
    const centreX = (x: number) => ox + (x + 0.5) * cell, centreY = (y: number) => oy + (y + 0.5) * cell, centreZ = (z: number) => oz + (z + 0.5) * band;

    // Probe per cell: the room's nearest probe, else (outside rooms) the nearest fallback probe holding the cell
    const primary = new Int16Array(total).fill(-1);
    const roomProbes = new Map<number, number[]>();
    this.probes.forEach((probe, i) => {
      if (probe.room >= 0) {
        const list = roomProbes.get(probe.room);
        if (list) { list.push(i); } else { roomProbes.set(probe.room, [i]); }
        return;
      }
      const [x0, y0, z0, x1, y1, z1] = this.cellRange(probe.box);
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const c = (z * ny + y) * nx + x;
            if (roomOf[c] >= 0) { continue; }
            const centre = vec3(centreX(x), centreY(y), centreZ(z));
            const current = primary[c];
            if (current >= 0 && dist2(this.probes[current].position, centre) <= dist2(probe.position, centre)) { continue; }
            primary[c] = i;
          }
        }
      }
    });
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        const cy = centreY(y);
        for (let x = 0; x < nx; x++) {
          const c = (z * ny + y) * nx + x;
          const list = roomOf[c] >= 0 ? roomProbes.get(roomOf[c]) : undefined;
          if (!list) { continue; }
          const cx = centreX(x);
          let best = list[0];
          for (let k = 1; k < list.length; k++) {
            if (planDist2(this.probes[list[k]].position, cx, cy) < planDist2(this.probes[best].position, cx, cy)) { best = list[k]; }
          }
          primary[c] = best;
        }
      }
    }

    // Blending: only across open boundaries (or between the probes of one large room)
    const secondary = new Int16Array(total).fill(-1);
    const distance = new Float32Array(total).fill(Number.MAX_VALUE);
    const reach = Math.max(1, Math.ceil(ReflectionProbes.BLEND_RADIUS / cell));
    const radius = (reach + 0.5) * cell;
    const gap = Math.max(1, Math.ceil(ReflectionProbes.OPEN_GAP / cell));
    const doors = doorBoxes(scene);
    let open = 0, closed = 0;

    // Spreads probe 'other' into this probe's cells within the blend radius of the boundary cell (x, y, z)
    const spread = (x: number, y: number, z: number, self: number, other: number) => {
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= nx || ty >= ny) { continue; }
          const t = (z * ny + ty) * nx + tx;
          if (primary[t] !== self) { continue; }
          const d = Math.sqrt(dx * dx + dy * dy) * cell + 0.5 * cell;
          if (d < distance[t] && d < radius) {
            distance[t] = d;
            secondary[t] = other;
          }
        }
      }
    };

    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const c = (z * ny + y) * nx + x;
          const p = primary[c];
          if (p < 0) { continue; }
          // +X and +Y only: each boundary is found once and spread both ways (the neighbour may sit across a wall)
          for (let axis = 0; axis < 2; axis++) {
            const dx = axis === 0 ? 1 : 0, dy = axis === 1 ? 1 : 0;
            for (let k = 1; k <= gap + 1; k++) {
              const tx = x + dx * k, ty = y + dy * k;
              if (tx >= nx || ty >= ny) { break; }
              const t = (z * ny + ty) * nx + tx;
              const q = primary[t];
              if (q < 0) { continue; }
              if (q === p) { break; }
              const sameRoom = roomOf[c] >= 0 && roomOf[c] === roomOf[t];
              if (sameRoom || this.isOpen(centreX(x), centreY(y), centreZ(z), centreX(tx), centreY(ty), roomOf[c], roomOf[t], rooms, doors)) {
                open++;
                spread(x, y, z, p, q);
                spread(tx, ty, z, q, p);
              } else {
                closed++;
              }
              break;
            }
          }
        }
      }
    }

    this.gridData = new Uint8Array(total * 4);
    for (let c = 0; c < total; c++) {
      const o = c * 4;
      this.gridData[o] = primary[c] + 1;
      if (secondary[c] >= 0) {
        this.gridData[o + 1] = secondary[c] + 1;
        const weight = 0.5 * (1 - distance[c] / radius);
        this.gridData[o + 2] = Math.min(Math.max(Math.round(weight * 255), 0), 255);
      }
      this.gridData[o + 3] = 255;
    }
    console.info(`Reflection probes: lookup grid ${nx}×${ny}×${nz} (${cell.toFixed(2)} m cells, ${band.toFixed(2)} m bands), ` +
      `${open.toLocaleString('en')} open / ${closed.toLocaleString('en')} closed boundary cells (${this.occluders ? 'rays' : 'doors only'}, ` +
      `${doors.size} door buckets) in ${Math.round(performance.now() - started)} ms.`);
  }

  /**
   * The room of every lookup cell (-1 none): the cell centre inside the room's plan, and of the rooms there the one
   * whose floor is the nearest below the centre (5 cm under it at most, 1 m of headroom above its top). Host rooms win ties.
   */
  private assignRooms(rooms: RoomInfo[], total: number): Int32Array {
    const roomOf = new Int32Array(total).fill(-1);
    const nx = this.nx, ny = this.ny, cell = this.gridCellSize, o = this.gridOrigin;
    const tol = ReflectionProbes.FLOOR_TOLERANCE, headroom = ReflectionProbes.ROOM_HEADROOM;
    const grid = new Aabb(o, vec3(o.x + cell.x * nx, o.y + cell.y * ny, o.z + cell.z * this.nz));
    rooms.forEach((room, r) => {
      if (room.loops.length === 0 || room.topZ <= room.bottomZ) { return; }
      const box = new Aabb(vec3(room.min.x, room.min.y, room.bottomZ - tol), vec3(room.max.x, room.max.y, room.topZ + headroom));
      if (!box.overlaps(grid)) { return; }
      const [x0, y0, z0, x1, y1, z1] = this.cellRange(box);
      for (let y = y0; y <= y1; y++) {
        const py = o.y + (y + 0.5) * cell.y;
        for (let x = x0; x <= x1; x++) {
          if (!roomContains(room, { x: o.x + (x + 0.5) * cell.x, y: py })) { continue; }
          for (let z = z0; z <= z1; z++) {
            const cz = o.z + (z + 0.5) * cell.z;
            if (cz < room.bottomZ - tol || cz > room.topZ + headroom) { continue; }
            const c = (z * ny + y) * nx + x;
            const current = roomOf[c];
            if (current >= 0) {
              const other = rooms[current];
              // The nearest floor below wins; on a tie the host room (then the first) stays
              if (other.bottomZ > room.bottomZ || (other.bottomZ === room.bottomZ && other.link <= room.link)) { continue; }
            }
            roomOf[c] = r;
          }
        }
      }
    });
    return roomOf;
  }

  /**
   * True when the boundary between two neighbouring cells is open: the gap lies in a door's box, or a horizontal ray
   * across it hits no occluder (at the band's height, kept 0.15 m above the higher floor and below the lower top).
   */
  private isOpen(ax: number, ay: number, az: number, bx: number, by: number, roomA: number, roomB: number, rooms: RoomInfo[],
    doors: Map<string, Aabb[]>): boolean {
    let low = -Number.MAX_VALUE, high = Number.MAX_VALUE;
    if (roomA >= 0) { low = rooms[roomA].bottomZ; high = rooms[roomA].topZ; }
    if (roomB >= 0) { low = Math.max(low, rooms[roomB].bottomZ); high = Math.min(high, rooms[roomB].topZ); }
    let z = az;
    if (low > -Number.MAX_VALUE) { z = Math.max(z, low + 0.15); }
    if (high < Number.MAX_VALUE && high - 0.1 > low + 0.15) { z = Math.min(z, high - 0.1); }

    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
    const list = doors.get(`${Math.floor(mx / ReflectionProbes.DOOR_BUCKET)},${Math.floor(my / ReflectionProbes.DOOR_BUCKET)}`);
    if (list) {
      for (const door of list) {
        if (mx >= door.min.x && mx <= door.max.x && my >= door.min.y && my <= door.max.y && z >= door.min.z && z <= door.max.z) { return true; }
      }
    }
    if (!this.occluders) { return false; }

    let dx = bx - ax, dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length < 1e-4) { return true; }
    dx /= length; dy /= length;
    const pad = 0.25 * this.gridCellSize.x;
    return this.occluders.raycast(vec3(ax - dx * pad, ay - dy * pad, z), vec3(dx, dy, 0), length + 2 * pad, this.occluderMask) === null;
  }

  private cellRange(box: Aabb): [number, number, number, number, number, number] {
    const o = this.gridOrigin, c = this.gridCellSize;
    const clampI = (v: number, n: number) => Math.min(Math.max(Math.floor(v), 0), n - 1);
    return [
      clampI((box.min.x - o.x) / c.x, this.nx), clampI((box.min.y - o.y) / c.y, this.ny), clampI((box.min.z - o.z) / c.z, this.nz),
      clampI((box.max.x - o.x) / c.x, this.nx), clampI((box.max.y - o.y) / c.y, this.ny), clampI((box.max.z - o.z) / c.z, this.nz)
    ];
  }

  // #endregion

  // #region Baking

  /** Marks every probe stale (sun, lights, colour mode or the model changed); they keep their old capture until re-baked. */
  invalidate(): void {
    for (const p of this.probes) { p.dirty = true; }
    this.pendingCount = this.probes.length;
  }

  /**
   * Picks this frame's faces into `faces` (pairs of probe, face): the probe being baked continues; otherwise the
   * nearest unbaked, then the nearest stale, then a provisional one the player came near.
   */
  nextFaces(eye: Vec3, faces: [number, number][]): void {
    faces.length = 0;
    if (!this.ready) { return; }
    while (faces.length < ReflectionProbes.FACES_PER_FRAME) {
      if (this.baking < 0) {
        this.baking = this.pick(eye);
        if (this.baking < 0) { break; }
        const p = this.probes[this.baking];
        p.nextFace = 0;
        p.provisional = Math.sqrt(dist2(p.position, eye)) > ReflectionProbes.REFRESH_FAR;
      }
      const probe = this.probes[this.baking];
      faces.push([this.baking, probe.nextFace]);
      probe.nextFace++;
      if (probe.nextFace >= 6) { this.baking = -1; }
    }
  }

  private pick(eye: Vec3): number {
    let best = -1, bestRank = Number.MAX_SAFE_INTEGER, bestDistance = Number.MAX_VALUE;
    const near2 = ReflectionProbes.REFRESH_NEAR * ReflectionProbes.REFRESH_NEAR;
    this.probes.forEach((p, i) => {
      const d = dist2(eye, p.position);
      const rank = !p.baked ? 0 : p.dirty ? 1 : p.provisional && d < near2 ? 2 : Number.MAX_SAFE_INTEGER;
      if (rank === Number.MAX_SAFE_INTEGER) { return; }
      if (rank < bestRank || (rank === bestRank && d < bestDistance)) {
        best = i;
        bestRank = rank;
        bestDistance = d;
      }
    });
    return best;
  }

  /** The view-projection, eye and culling planes of one probe face. */
  faceMatrix(probe: number, face: number): { matrix: Matrix4x4; eye: Vec3; planes: Float32Array } {
    const p = this.probes[probe];
    const eye = p.position, f = LightShadows.FACE_FORWARD[face];
    const view = Mat4.createLookAt(eye, vec3(eye.x + f.x, eye.y + f.y, eye.z + f.z), LightShadows.FACE_UP[face]);
    const projection = FpsCamera.perspective(2 * Math.atan(LightShadows.PAD), 1, ReflectionProbes.NEAR, p.far);
    const matrix = Mat4.multiply(view, projection);
    FpsCamera.extractPlanes(matrix, this.planes);
    return { matrix, eye, planes: this.planes };
  }

  /**
   * Binds the capture framebuffer to one face's layer, clears it and sets the viewport. The face array is swapped for a
   * placeholder on its sampling unit while capturing (WebGL refuses a feedback loop).
   */
  beginFace(probe: number, face: number, clear: Vec3, placeholder: WebGLTexture | null): void {
    gl.activeTexture(gl.TEXTURE0 + ReflectionProbes.ARRAY_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, placeholder);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.array, 0, probe * 6 + face);
    gl.viewport(0, 0, this.size, this.size);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.clearColor(clear.x, clear.y, clear.z, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** After a face's capture: builds its mip chain (2× box-filter blits); the sixth face marks the probe baked. */
  endFace(probe: number, face: number): void {
    const layer = probe * 6 + face;
    for (let level = 1; level < this.levels; level++) {
      const from = this.size >> (level - 1), to = this.size >> level;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.readFbo);
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.array, level - 1, layer);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo);
      gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.array, level, layer);
      gl.blitFramebuffer(0, 0, from, from, 0, 0, to, to, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.array, 0, layer);

    if (face === 5) {
      const p = this.probes[probe];
      if (!p.baked) { this.bakedCount++; }
      p.baked = true;
      p.dirty = false;
      this.dataDirty = true;
      this.pendingCount = this.probes.filter(x => !x.baked || x.dirty).length;
    }
  }

  /** Restores the default framebuffer, uploads changed probe data and binds the probe textures to their units. */
  endCapture(): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.uploadData();
    this.bind();
  }

  /** The per-probe data texture: (position, first layer), (box min, baked), (box max, 0); rows are probes. */
  private uploadData(): void {
    if (!this.dataDirty || !this.data) { return; }
    this.dataDirty = false;
    const count = Math.max(1, this.probes.length);
    const values = new Float32Array(count * 12);
    this.probes.forEach((p, i) => {
      const o = i * 12;
      values.set([p.position.x, p.position.y, p.position.z, i * 6, p.box.min.x, p.box.min.y, p.box.min.z, p.baked ? 1 : 0,
        p.box.max.x, p.box.max.y, p.box.max.z, 0], o);
    });
    gl.activeTexture(gl.TEXTURE0 + ReflectionProbes.DATA_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.data);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 3, count, 0, gl.RGBA, gl.FLOAT, values);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Binds the faces, grid and data to their units (leaves unit 0 active). */
  bind(): void {
    gl.activeTexture(gl.TEXTURE0 + ReflectionProbes.ARRAY_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.array);
    gl.activeTexture(gl.TEXTURE0 + ReflectionProbes.GRID_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.grid);
    gl.activeTexture(gl.TEXTURE0 + ReflectionProbes.DATA_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.data);
    gl.activeTexture(gl.TEXTURE0);
  }

  // #endregion

  dispose(): void {
    this.release();
  }
}

/** Reflective surfaces are gathered on this voxel (m); door boxes grow this much in plan (m); shine at or above this
 * counts as reflective for placement (the 25 % tier, rounded). */
const VOXEL = 0.5, DOOR_GROW = 0.15, PLACEMENT_SHINE = 0.125;

/** Bytes of one probe's six faces with their mips (RGBA8). */
function bytesPerProbe(size: number): number {
  let texels = 0;
  for (let s = size; s >= 4; s >>= 1) { texels += s * s; }
  return texels * 4 * 6;
}

/** The reflective surfaces (shine tier 25 % + or water), as 0.5 m voxel centres with the room they lie in. */
export function gatherShiny(scene: SceneData): ShinyPoint[] {
  const points: ShinyPoint[] = [];
  const materials = scene.materials;
  if (isMaterialsEmpty(materials) || materials.vertexMaterial.length !== scene.geometry.vertexCount) { return points; }

  const shinyMaterial = materials.materials.map(m => m.shine >= PLACEMENT_SHINE || m.water);
  if (!shinyMaterial.some(Boolean)) { return points; }

  // Voxelise (dedupes dense meshes: a tiled floor is a few thousand voxels, not a million vertices)
  const voxels = new Map<string, [number, number, number, number]>();
  const index = materials.vertexMaterial, floats = scene.geometry.floats;
  const count = modelVertexCount(scene); // family library templates (hidden, after these) never get probes
  for (let v = 0; v < count; v++) {
    const m = index[v];
    if (m >= shinyMaterial.length || !shinyMaterial[m]) { continue; }
    const w = v * SCENE_VERTEX_WORDS;
    const x = floats[w], y = floats[w + 1], z = floats[w + 2];
    const key = `${Math.floor(x / VOXEL)},${Math.floor(y / VOXEL)},${Math.floor(z / VOXEL)}`;
    const acc = voxels.get(key);
    if (acc) { acc[0] += x; acc[1] += y; acc[2] += z; acc[3]++; } else { voxels.set(key, [x, y, z, 1]); }
  }

  const rooms = new RoomIndex(scene.rooms);
  for (const [sx, sy, sz, n] of voxels.values()) {
    const x = sx / n, y = sy / n, z = sz / n;
    points.push({ x, y, z, room: rooms.find(x, y, z) });
  }
  return points;
}

/** A plan point inside the room: its box centre if inside, else the reflective surfaces' average, else one of them. */
function insideSpot(room: RoomInfo, points: ShinyPoint[]): { x: number; y: number } {
  const centre = { x: (room.min.x + room.max.x) * 0.5, y: (room.min.y + room.max.y) * 0.5 };
  if (roomContains(room, centre)) { return centre; }
  let ax = 0, ay = 0;
  for (const p of points) { ax += p.x; ay += p.y; }
  const average = { x: ax / Math.max(1, points.length), y: ay / Math.max(1, points.length) };
  if (roomContains(room, average)) { return average; }
  for (const p of points) {
    if (roomContains(room, p)) { return { x: p.x, y: p.y }; }
  }
  return centre;
}

/** Every door's box (host and links), grown 0.15 m in plan, bucketed on a 2 m plan grid. */
function doorBoxes(scene: SceneData): Map<string, Aabb[]> {
  const buckets = new Map<string, Aabb[]>();
  const doorCategory = findCategory(KEY_DOORS)?.index ?? -1;
  if (doorCategory < 0) { return buckets; }
  for (const element of scene.elements) {
    if (element.categoryIndex !== doorCategory || element.isLibraryTemplate || !element.bounds.isValid) { continue; }
    const b = element.bounds;
    const box = new Aabb(vec3(b.min.x - DOOR_GROW, b.min.y - DOOR_GROW, b.min.z - 0.05), vec3(b.max.x + DOOR_GROW, b.max.y + DOOR_GROW, b.max.z));
    for (let x = Math.floor(box.min.x / 2); x <= Math.floor(box.max.x / 2); x++) {
      for (let y = Math.floor(box.min.y / 2); y <= Math.floor(box.max.y / 2); y++) {
        const key = `${x},${y}`;
        const list = buckets.get(key);
        if (list) { list.push(box); } else { buckets.set(key, [box]); }
      }
    }
  }
  return buckets;
}

function dist2(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

function planDist2(a: Vec3, x: number, y: number): number {
  return (a.x - x) ** 2 + (a.y - y) ** 2;
}

/**
 * Finds the room a point lies in: rooms bucketed on a 4 m plan grid, then the even-odd test and their height (± 0.3 m).
 * Of the rooms that hold it, the one whose floor is nearest below the point (within 5 cm) wins; host rooms come first.
 */
class RoomIndex {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly rooms: RoomInfo[]) {
    const order = rooms.map((_, i) => i).sort((a, b) => rooms[a].link - rooms[b].link);
    for (const r of order) {
      const room = rooms[r];
      if (room.loops.length === 0) { continue; }
      for (let x = Math.floor(room.min.x / 4); x <= Math.floor(room.max.x / 4); x++) {
        for (let y = Math.floor(room.min.y / 4); y <= Math.floor(room.max.y / 4); y++) {
          const key = `${x},${y}`;
          const list = this.buckets.get(key);
          if (list) { list.push(r); } else { this.buckets.set(key, [r]); }
        }
      }
    }
  }

  find(x: number, y: number, z: number): number {
    const list = this.buckets.get(`${Math.floor(x / 4)},${Math.floor(y / 4)}`);
    if (!list) { return -1; }
    let best = -1, loose = -1;
    for (const r of list) {
      const room = this.rooms[r];
      if (z < room.bottomZ - 0.3 || z > room.topZ + 0.3) { continue; }
      if (x < room.min.x || y < room.min.y || x > room.max.x || y > room.max.y) { continue; }
      if (!roomContains(room, { x, y })) { continue; }
      if (loose < 0) { loose = r; }
      if (z >= room.bottomZ - 0.05 && (best < 0 || room.bottomZ > this.rooms[best].bottomZ)) { best = r; }
    }
    return best >= 0 ? best : loose;
  }
}
