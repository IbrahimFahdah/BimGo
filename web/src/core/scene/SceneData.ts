import { type Vec2, type Vec3, vec3 } from '../math/Vector';
import { isLibraryEmpty, type LibraryData } from './FamilyLibrary';
import type { LightingData } from './LightingData';
import type { MaterialData } from './MaterialData';
import type { ModelProvenance, ParameterTable, SiteInfo } from './ModelInfo';
import type { LinkInfo } from './LinkInfo';

/** Bytes per vertex in geometry.bin: position (3 × f32), normal (3 × f32), packed RGBA8 colour. */
export const SCENE_VERTEX_SIZE = 28;
/** 32-bit words per vertex (SCENE_VERTEX_SIZE / 4). */
export const SCENE_VERTEX_WORDS = 7;

/**
 * The scene's vertices and indices, kept as the bytes read from geometry.bin (no copy): the interleaved vertex block
 * uploads to the GPU as is, and the typed views read single vertices (port of SceneVertex[] / uint[]).
 */
export class SceneGeometry {
  /** Positions and normals as float32 (7 words per vertex: px py pz nx ny nz, colour). */
  readonly floats: Float32Array;
  /** The same words as uint32 (colour at word 6). */
  readonly words: Uint32Array;

  constructor(
    /** The interleaved vertex bytes (vertexCount × 28). */
    readonly vertexBytes: Uint8Array,
    /** Triangle list indices. */
    readonly indices: Uint32Array
  ) {
    this.floats = new Float32Array(vertexBytes.buffer, vertexBytes.byteOffset, vertexBytes.byteLength / 4);
    this.words = new Uint32Array(vertexBytes.buffer, vertexBytes.byteOffset, vertexBytes.byteLength / 4);
  }

  get vertexCount(): number {
    return this.vertexBytes.byteLength / SCENE_VERTEX_SIZE;
  }

  position(i: number): Vec3 {
    const w = i * SCENE_VERTEX_WORDS;
    return vec3(this.floats[w], this.floats[w + 1], this.floats[w + 2]);
  }

  normal(i: number): Vec3 {
    const w = i * SCENE_VERTEX_WORDS;
    return vec3(this.floats[w + 3], this.floats[w + 4], this.floats[w + 5]);
  }

  colour(i: number): number {
    return this.words[i * SCENE_VERTEX_WORDS + 6];
  }
}

/** An axis-aligned bounding box. Empty boxes have min > max. */
export class Aabb {
  constructor(public min: Vec3, public max: Vec3) {}

  static empty(): Aabb {
    return new Aabb(vec3(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE), vec3(-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE));
  }

  get isValid(): boolean { return this.min.x <= this.max.x; }
  get center(): Vec3 { return vec3((this.min.x + this.max.x) * 0.5, (this.min.y + this.max.y) * 0.5, (this.min.z + this.max.z) * 0.5); }
  get size(): Vec3 { return vec3(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z); }

  includePoint(p: Vec3): void {
    this.min = vec3(Math.min(this.min.x, p.x), Math.min(this.min.y, p.y), Math.min(this.min.z, p.z));
    this.max = vec3(Math.max(this.max.x, p.x), Math.max(this.max.y, p.y), Math.max(this.max.z, p.z));
  }

  include(other: Aabb): void {
    this.min = vec3(Math.min(this.min.x, other.min.x), Math.min(this.min.y, other.min.y), Math.min(this.min.z, other.min.z));
    this.max = vec3(Math.max(this.max.x, other.max.x), Math.max(this.max.y, other.max.y), Math.max(this.max.z, other.max.z));
  }

  overlaps(o: Aabb): boolean {
    return this.min.x <= o.max.x && this.max.x >= o.min.x
      && this.min.y <= o.max.y && this.max.y >= o.min.y
      && this.min.z <= o.max.z && this.max.z >= o.min.z;
  }
}

/** The element's role in the phase filter. */
export enum PhaseRole {
  Existing = 0,
  New = 1,
  Between = 2,
  Unphased = 3
}

/** One Revit element in the scene. */
export interface ElementRecord {
  elementId: number;
  uniqueId: string;
  hostId: number;
  name: string;
  categoryName: string;
  familyType: string;
  levelName: string;
  categoryIndex: number;
  opaqueStart: number;
  opaqueCount: number;
  transparentStart: number;
  transparentCount: number;
  bounds: Aabb;
  isProxy: boolean;
  movable: boolean;
  moveBlockReason: string | null;
  pivot: Vec3;
  phase: PhaseRole;
  /** 0 = host model, else 1-based link number. */
  link: number;
  /**
   * A family library template: hidden geometry of a family type kept at the tail of the snapshot for the Place gun
   * to clone. Never drawn, picked or collided as itself; has no ElementId or UniqueId.
   */
  isLibraryTemplate: boolean;
}

export interface RoomInfo {
  number: string;
  name: string;
  loops: Vec2[][];
  min: Vec2;
  max: Vec2;
  bottomZ: number;
  topZ: number;
  link: number;
}

/** True when a plan point is inside the room (even-odd over all its loops, so islands are holes). */
export function roomContains(room: RoomInfo, p: Vec2): boolean {
  if (p.x < room.min.x || p.y < room.min.y || p.x > room.max.x || p.y > room.max.y) { return false; }
  let inside = false;
  for (const loop of room.loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i], b = loop[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) { inside = !inside; }
    }
  }
  return inside;
}

/** The shortest plan distance from a point to the room's boundary (any loop). */
export function roomDistanceToBoundary(room: RoomInfo, p: Vec2): number {
  let best = Number.MAX_VALUE;
  for (const loop of room.loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[j], abx = loop[i].x - a.x, aby = loop[i].y - a.y;
      const len2 = abx * abx + aby * aby;
      const t = len2 > 1e-12 ? Math.min(Math.max(((p.x - a.x) * abx + (p.y - a.y) * aby) / len2, 0), 1) : 0;
      best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)));
    }
  }
  return best;
}

export interface LevelInfo {
  name: string;
  elevation: number;
}

export interface SpawnInfo {
  eye: Vec3;
  yaw: number;
  pitch: number;
  source: string;
}

/** The read-only model a walkthrough runs on (port of SceneData). */
export interface SceneData {
  geometry: SceneGeometry;
  elements: ElementRecord[];
  levels: LevelInfo[];
  rooms: RoomInfo[];
  phaseId: number;
  phaseName: string | null;
  existingPhaseId: number;
  existingPhaseName: string | null;
  phaseNote: string | null;
  spawn: SpawnInfo | null;
  bounds: Aabb;
  originOffset: Vec3;
  modelTitle: string;
  commentsPath: string | null;
  provenance: ModelProvenance;
  site: SiteInfo;
  links: LinkInfo[];
  lighting: LightingData;
  materials: MaterialData;
  /** The family library: offered types, previews and template geometry (never null). */
  library: LibraryData;
  parameters: ParameterTable;
  categoryLoaded: boolean[];
  categoryElementCounts: number[];
  sourceView: string | null;
  proxyCount: number;
  skippedCount: number;
  extractionSeconds: number;
}

/** The link an element belongs to, or null for the host. */
export function linkOf(scene: SceneData, record: ElementRecord | null): LinkInfo | null {
  return record && record.link > 0 && record.link <= scene.links.length ? scene.links[record.link - 1] : null;
}

/** Vertices of the model itself: everything before the library templates (all of them when there is no library). */
export function modelVertexCount(scene: SceneData): number {
  const count = scene.geometry.vertexCount;
  return isLibraryEmpty(scene.library) ? count : Math.min(Math.max(scene.library.vertexStart, 0), count);
}

/** Triangles in the scene. */
export function triangleCount(scene: SceneData): number {
  return scene.geometry.indices.length / 3;
}
