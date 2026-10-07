import { clamp, type Vec2, type Vec3, vec3 } from '../math/Vector';

/** Vertex material index meaning "no material". */
export const MATERIAL_NONE = 0xffff;
export const MAX_MATERIALS = 0xffff;
export const TEXTURE_SIZES = [256, 512, 1024, 2048];

export enum TextureState {
  None = 0,
  Embedded = 1,
  Missing = 2,
  Procedural = 3,
  Unreadable = 4
}

const TEXTURE_STATE_NAMES = ['none', 'embedded', 'missing', 'procedural', 'unreadable'];

/** Parses the camelCase enum name (or number) the C# writer uses. */
export function parseTextureState(value: unknown): TextureState {
  if (typeof value === 'number') { return value >= 0 && value <= 4 ? value : TextureState.None; }
  const i = typeof value === 'string' ? TEXTURE_STATE_NAMES.indexOf(value.trim().toLowerCase()) : -1;
  return i >= 0 ? i : TextureState.None;
}

export function formatTextureState(state: TextureState): string {
  return TEXTURE_STATE_NAMES[state] ?? 'none';
}

/** One Revit material's look (port of SceneMaterial). */
export interface SceneMaterial {
  name: string;
  link: number;
  materialId: number;
  schema: string;
  uniqueId: string | null;
  colour: Vec3;
  renderColour: Vec3 | null;
  assetTint: Vec3 | null;
  texture: string | null;
  textureState: TextureState;
  textureSource: string | null;
  textureOrigin: string | null;
  proxy: string | null;
  invert: boolean;
  autodesk: boolean;
  scaleU: number;
  scaleV: number;
  offsetU: number;
  offsetV: number;
  angle: number;
  fade: number;
  tint: Vec3;
  reflectivity: number;
}

/** The material table and per-vertex streams of a Realistic-mode export (port of MaterialData). */
export interface MaterialData {
  materials: SceneMaterial[];
  vertexMaterial: Uint16Array;
  /** Per-vertex UVs (u, v pairs), empty when the file has none. */
  vertexUv: Float32Array;
  textures: Map<string, Uint8Array>;
  textureMaxSize: number;
}

export const EMPTY_MATERIALS: MaterialData = Object.freeze({
  materials: [],
  vertexMaterial: new Uint16Array(0),
  vertexUv: new Float32Array(0),
  textures: new Map(),
  textureMaxSize: 512
}) as MaterialData;

export function isMaterialsEmpty(m: MaterialData): boolean {
  return m.materials.length === 0 || m.vertexMaterial.length === 0;
}

export function nearestTextureSize(value: number): number {
  let best = TEXTURE_SIZES[0];
  for (const size of TEXTURE_SIZES) {
    if (Math.abs(size - value) < Math.abs(best - value)) { best = size; }
  }
  return best;
}

/** ProxyCatalog.Normalise: trimmed, lower case, at most 64 characters; null when blank. */
export function normaliseProxy(keyword: unknown): string | null {
  if (typeof keyword !== 'string' || !keyword.trim()) { return null; }
  const value = keyword.trim().toLowerCase();
  return value.length > 64 ? value.slice(0, 64) : value;
}

/**
 * A material from JSON with every value made safe (port of SceneMaterial.Clean).
 */
export function cleanMaterial(raw: Record<string, unknown> | null | undefined): SceneMaterial {
  const m = raw ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const blank = (v: unknown): boolean => typeof v !== 'string' || !v.trim();
  const fin = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const positiveOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 1e-4 ? Math.min(v, 1e4) : fallback);
  const grey = vec3(0.8, 0.8, 0.8), one = vec3(1, 1, 1);

  return {
    name: str(m.name) ?? '',
    uniqueId: blank(m.uniqueId) ? null : (m.uniqueId as string),
    link: Math.max(0, Math.trunc(fin(m.link))),
    materialId: fin(m.materialId),
    schema: str(m.schema) ?? '',
    colour: clampVec(readVec(m.colour), 0, 1, grey),
    renderColour: m.renderColour == null ? null : clampVec(readVec(m.renderColour), 0, 1, grey),
    assetTint: m.assetTint == null ? null : clampVec(readVec(m.assetTint), 0, 4, one),
    texture: blank(m.texture) ? null : (m.texture as string),
    textureState: parseTextureState(m.textureState),
    textureSource: str(m.textureSource),
    textureOrigin: blank(m.textureOrigin) ? null : (m.textureOrigin as string).trim().toLowerCase(),
    proxy: normaliseProxy(m.proxy),
    invert: m.invert === true,
    autodesk: m.autodesk === true,
    scaleU: positiveOr(m.scaleU ?? 1, 1),
    scaleV: positiveOr(m.scaleV ?? 1, 1),
    offsetU: fin(m.offsetU),
    offsetV: fin(m.offsetV),
    angle: fin(m.angle) % 360,
    fade: typeof m.fade === 'number' && Number.isFinite(m.fade) ? clamp(m.fade, 0, 1) : 1,
    tint: m.tint == null ? one : clampVec(readVec(m.tint), 0, 4, one),
    reflectivity: typeof m.reflectivity === 'number' && Number.isFinite(m.reflectivity) ? clamp(m.reflectivity, 0, 1) : 0
  };
}

/** Reads a JSON [x, y, z] (missing values are 0; NaN when not an array, so callers fall back). */
function readVec(v: unknown): Vec3 {
  if (!Array.isArray(v)) { return vec3(NaN, NaN, NaN); }
  const n = (i: number) => (typeof v[i] === 'number' ? v[i] as number : 0);
  return vec3(n(0), n(1), n(2));
}

function clampVec(v: Vec3, min: number, max: number, fallback: Vec3): Vec3 {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    ? vec3(clamp(v.x, min, max), clamp(v.y, min, max), clamp(v.z, min, max))
    : fallback;
}

/** UV of one vertex. */
export function vertexUv(m: MaterialData, i: number): Vec2 {
  return { x: m.vertexUv[i * 2] ?? 0, y: m.vertexUv[i * 2 + 1] ?? 0 };
}

/**
 * A changed material table over the same vertex streams (port of MaterialData.With): textures no material references
 * any more are dropped; added images join.
 */
export function withMaterials(data: MaterialData, materials: SceneMaterial[], addedTextures?: Map<string, Uint8Array>): MaterialData {
  if (materials.length !== data.materials.length) {
    throw new Error('The material table must keep its length (the vertex indices point into it).');
  }
  const referenced = new Set(materials.map(m => m.texture).filter((t): t is string => t !== null));
  const textures = new Map<string, Uint8Array>();
  for (const [key, bytes] of data.textures) { if (referenced.has(key)) { textures.set(key, bytes); } }
  for (const [key, bytes] of addedTextures ?? []) { if (referenced.has(key) && bytes.length > 0) { textures.set(key, bytes); } }
  return { materials, vertexMaterial: data.vertexMaterial, vertexUv: data.vertexUv, textures, textureMaxSize: data.textureMaxSize };
}

/** A copy of a material (the table is edited by replacing entries). */
export function copyMaterial(m: SceneMaterial): SceneMaterial {
  return { ...m, colour: { ...m.colour }, tint: { ...m.tint }, renderColour: m.renderColour ? { ...m.renderColour } : null, assetTint: m.assetTint ? { ...m.assetTint } : null };
}

/** Texture origins (port of TextureOrigins). */
export const TextureOrigins = { ASSET: 'asset', SEARCH: 'search', OVERRIDE: 'override', PROXY: 'proxy' } as const;
