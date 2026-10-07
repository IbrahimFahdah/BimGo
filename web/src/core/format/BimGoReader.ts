import { EditJournal, type JournalEntry } from '../edits/EditJournal';
import { type Vec2, vec2, vec3 } from '../math/Vector';
import { CATEGORIES, findCategory, KEY_GENERIC } from '../scene/CategoryCatalog';
import { EMPTY_LIGHTING, type EmissiveRun, type LightingData, type LightSource } from '../scene/LightingData';
import type { LinkInfo } from '../scene/LinkInfo';
import {
  cleanMaterial, EMPTY_MATERIALS, MATERIAL_NONE, MAX_MATERIALS, type MaterialData, nearestTextureSize, TextureState
} from '../scene/MaterialData';
import { type ModelProvenance, ParameterTable, type SiteInfo, type SitePoint } from '../scene/ModelInfo';
import {
  Aabb, type ElementRecord, type LevelInfo, type RoomInfo, SCENE_VERTEX_SIZE, type SceneData, SceneGeometry, type SpawnInfo
} from '../scene/SceneData';
import { BimGoFormat, FileKinds, parsePhaseRole } from './BimGoFormat';
import {
  type BookmarkDocument, type CommentDocument, readBookmarkDocument, readCommentDocument, readSunSettings, readVisibility,
  type SunSettings, type VisibilitySettings
} from './DocumentModels';
import { arr, bool, float, int, isBlank, type Json, num, obj, objOrNull, readVector3, str } from './Json';
import { ZipError, type ZipReader as ZipReaderType, ZipReader } from './Zip';

/** A .bimgo opened for a walkthrough (port of BimGoDocument). */
export interface BimGoDocument {
  scene: SceneData;
  comments: CommentDocument;
  journal: EditJournal;
  bookmarks: BookmarkDocument;
  sun: SunSettings | null;
  visibility: VisibilitySettings | null;
  createdUtc: string;
  kind: string;
  /** The file name (the browser has no path). */
  name: string;
  readFormatVersion: number;
  /** The manifest as read (the writer keeps its extraction settings and provenance). */
  manifest: Json;
}

/** Progress and cancellation for a read (replaces OperationProgress). */
export interface ReadProgress {
  /** Called with 0..1. */
  step?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** A read failure with a message fit for the user (BimGoReader's Describe). */
export class BimGoReadError extends Error {}

/**
 * Reads .bimgo files (port of BimGoReader.cs). Same validation and fallbacks as the desktop: unknown categories read
 * as generic models, out-of-range element / room links read as host, bad index ranges are dropped, damaged optional
 * entries (materials) are ignored, and an out-of-range vertex index fails the read.
 */
export const BimGoReader = {
  /** Reads only the manifest (quick checks, recent-file details). */
  async readManifest(file: Blob): Promise<Json> {
    try {
      const zip = await ZipReader.open(file);
      return (await readJson(zip, BimGoFormat.ENTRY_MANIFEST, true))!;
    } catch (e) {
      throw new BimGoReadError(describe(e));
    }
  },

  /** Reads a whole model. Throws {@link BimGoReadError}. */
  async read(file: Blob, name: string, progress?: ReadProgress): Promise<BimGoDocument> {
    try {
      return await readDocument(file, name, progress);
    } catch (e) {
      console.warn(`Could not read ${name}:`, e);
      throw new BimGoReadError(describe(e));
    }
  }
};

async function readDocument(file: Blob, name: string, progress?: ReadProgress): Promise<BimGoDocument> {
  const signal = progress?.signal;
  const zip = await ZipReader.open(file);
  const manifest = (await readJson(zip, BimGoFormat.ENTRY_MANIFEST, true))!;
  if (str(manifest.format, BimGoFormat.FORMAT_NAME).toLowerCase() !== BimGoFormat.FORMAT_NAME) {
    throw new InvalidData('This is not a BimGo model.');
  }
  const formatVersion = int(manifest.formatVersion, BimGoFormat.FORMAT_VERSION);
  if (formatVersion > BimGoFormat.FORMAT_VERSION) {
    throw new InvalidData(`This file was made by a newer BimGo (format ${formatVersion}; this version reads up to ${BimGoFormat.FORMAT_VERSION}). Please update BimGo.`);
  }

  const model = (await readJson(zip, BimGoFormat.ENTRY_MODEL, true))!;
  const elements = (await readJson(zip, BimGoFormat.ENTRY_ELEMENTS, true))!;
  const parameters = await readJson(zip, BimGoFormat.ENTRY_PARAMETERS, false);
  const comments = readCommentDocument(await readJson(zip, BimGoFormat.ENTRY_COMMENTS, false));
  const journal = await readJson(zip, BimGoFormat.ENTRY_JOURNAL, false);
  const bookmarks = readBookmarkDocument(await readJson(zip, BimGoFormat.ENTRY_BOOKMARKS, false));
  const sunJson = await readJson(zip, BimGoFormat.ENTRY_SUN, false);
  const visibilityJson = await readJson(zip, BimGoFormat.ENTRY_VISIBILITY, false);
  const lighting = await readJson(zip, BimGoFormat.ENTRY_LIGHTING, false);
  const materials = await readOptionalJson(zip, BimGoFormat.ENTRY_MATERIALS);
  progress?.step?.(0.1);
  throwIfAborted(signal);

  const geometry = await readGeometry(zip, progress);
  throwIfAborted(signal);

  const materialData = await readMaterials(zip, materials, geometry.vertexCount);
  const scene = buildScene(name, manifest, model, elements, parameters, geometry, lighting, materialData);
  const entries = arr(obj(journal).entries).map(e => objOrNull(e)).filter((e): e is Json => e !== null).map(readJournalEntry);

  console.info(`Read ${name}: ${scene.elements.length} elements, ${geometry.indices.length / 3} triangles, ` +
    `${comments.comments.length} comments, ${entries.length} journal entries, ${bookmarks.bookmarks.length} bookmarks (format ${formatVersion}).`);

  return {
    scene,
    comments,
    journal: new EditJournal(entries),
    bookmarks,
    sun: sunJson ? readSunSettings(sunJson) : null,
    visibility: visibilityJson ? readVisibility(visibilityJson) : null,
    createdUtc: str(manifest.createdUtc, ''),
    kind: str(manifest.kind, FileKinds.EXPORT),
    name,
    readFormatVersion: formatVersion,
    manifest
  };
}

// #region Scene

function buildScene(name: string, manifest: Json, model: Json, elementsJson: Json, parametersJson: Json | null,
  geometry: SceneGeometry, lightingJson: Json | null, materials: MaterialData): SceneData {
  const genericIndex = findCategory(KEY_GENERIC)?.index ?? 0;
  const indexCount = geometry.indices.length;

  // Map the file's categories onto this build's catalog (by key)
  const fileCategories = arr(model.categories).map(c => objOrNull(c));
  const categoryMap = new Array<number>(fileCategories.length);
  const loaded = new Array<boolean>(CATEGORIES.length).fill(false);
  const counts = new Array<number>(CATEGORIES.length).fill(0);
  fileCategories.forEach((c, i) => {
    const def = findCategory(c ? str(c.key, null) : null);
    if (!def && c) { console.info(`Unknown category '${str(c.key, '')}' in file; shown as generic models.`); }
    categoryMap[i] = def?.index ?? genericIndex;
    if (c && bool(c.loaded)) { loaded[categoryMap[i]] = true; }
  });

  // Links: renumbered 1..n in file order (element / room link numbers outside that range read as host)
  const links = arr(model.links).map(l => objOrNull(l)).filter((l): l is Json => l !== null).map(readLink);
  links.forEach((l, i) => { l.index = i + 1; });

  // Elements (index ranges validated against the geometry)
  const records: ElementRecord[] = arr(obj(elementsJson).elements).map(raw => {
    const dto = obj(raw);
    const fileCategory = int(dto.category);
    const category = fileCategory >= 0 && fileCategory < categoryMap.length ? categoryMap[fileCategory] : genericIndex;
    const [opaqueStart, opaqueCount] = validRange(dto.opaque, indexCount);
    const [transparentStart, transparentCount] = validRange(dto.transparent, indexCount);
    const movable = bool(dto.movable);
    counts[category]++;
    loaded[category] = true;
    return {
      elementId: num(dto.id),
      uniqueId: str(dto.uniqueId, ''),
      hostId: num(dto.hostId),
      name: str(dto.name, '(unnamed)'),
      categoryName: str(dto.categoryName, CATEGORIES[category].label),
      familyType: str(dto.familyType, '—'),
      levelName: str(dto.level, '—'),
      categoryIndex: category,
      opaqueStart, opaqueCount, transparentStart, transparentCount,
      bounds: new Aabb(readVector3(dto.boundsMin), readVector3(dto.boundsMax)),
      isProxy: bool(dto.proxy),
      movable,
      moveBlockReason: movable ? null : str(dto.moveBlockReason, 'Not movable'),
      pivot: readVector3(dto.pivot),
      phase: parsePhaseRole(dto.phase),
      link: validLink(dto.link, links.length)
    };
  });

  // Indices must point at real vertices
  const vertexCount = geometry.vertexCount;
  const indices = geometry.indices;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) { throw new InvalidData('The geometry is damaged (index out of range).'); }
  }

  // Levels, rooms, spawn
  const levels: LevelInfo[] = arr(model.levels)
    .map(l => objOrNull(l)).filter((l): l is Json => l !== null)
    .map(l => ({ name: str(l.name, 'Level'), elevation: float(l.elevation) }))
    .sort((a, b) => a.elevation - b.elevation);

  const rooms: RoomInfo[] = [];
  for (const raw of arr(model.rooms)) {
    const room = objOrNull(raw);
    if (!room || !Array.isArray(room.loops)) { continue; }
    const loops: Vec2[][] = [];
    let minX = Number.MAX_VALUE, minY = Number.MAX_VALUE, maxX = -Number.MAX_VALUE, maxY = -Number.MAX_VALUE;
    for (const flat of room.loops as unknown[]) {
      if (!Array.isArray(flat) || flat.length < 6) { continue; }
      const loop: Vec2[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const p = vec2(float(flat[i]), float(flat[i + 1]));
        loop.push(p);
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      loops.push(loop);
    }
    if (loops.length === 0) { continue; }
    rooms.push({
      number: str(room.number, '—'),
      name: str(room.name, 'Room'),
      loops,
      min: vec2(minX, minY),
      max: vec2(maxX, maxY),
      bottomZ: float(room.bottomZ),
      topZ: float(room.topZ),
      link: validLink(room.link, links.length)
    });
  }

  const spawnJson = objOrNull(model.spawn);
  const spawn: SpawnInfo | null = spawnJson ? {
    eye: readVector3(spawnJson.eye),
    yaw: float(spawnJson.yaw),
    pitch: float(spawnJson.pitch),
    source: str(spawnJson.source, 'saved view')
  } : null;

  let bounds = new Aabb(readVector3(model.boundsMin), readVector3(model.boundsMax));
  if (!bounds.isValid) {
    bounds = Aabb.empty();
    for (const record of records) { bounds.include(record.bounds); }
    if (!bounds.isValid) { bounds = new Aabb(vec3(-10, -10, 0), vec3(10, 10, 3)); }
  }

  const extraction = obj(manifest.extraction);
  return {
    geometry,
    elements: records,
    levels,
    rooms,
    phaseId: num(model.phaseId, -1),
    phaseName: str(model.phaseName, null),
    existingPhaseId: num(model.existingPhaseId, -1),
    existingPhaseName: str(model.existingPhaseName, null),
    phaseNote: str(model.phaseNote, null),
    spawn,
    bounds,
    originOffset: readVector3(model.originOffset),
    modelTitle: isBlank(str(manifest.title, null)) ? name.replace(/\.bimgo$/i, '') : (manifest.title as string),
    commentsPath: str(manifest.kind, FileKinds.EXPORT) === FileKinds.SNAPSHOT ? str(manifest.commentsSidecar, null) : null,
    provenance: readProvenance(objOrNull(manifest.provenance)),
    site: readSite(objOrNull(model.site)),
    links,
    lighting: buildLighting(lightingJson, vertexCount, records.length),
    materials,
    parameters: buildParameters(parametersJson, records.length),
    categoryLoaded: loaded,
    categoryElementCounts: counts,
    sourceView: str(extraction.activeView, null),
    proxyCount: int(extraction.proxyCount),
    skippedCount: int(extraction.skippedCount),
    extractionSeconds: Math.max(0, num(extraction.extractionSeconds))
  };
}

function validLink(link: unknown, linkCount: number): number {
  const n = typeof link === 'number' ? Math.trunc(link) : 0;
  return n > 0 && n <= linkCount ? n : 0;
}

function validRange(range: unknown, indexCount: number): [number, number] {
  if (!Array.isArray(range) || range.length < 2) { return [0, 0]; }
  const start = int(range[0]), count = int(range[1]);
  if (start < 0 || count <= 0 || start > indexCount || start + count > indexCount) { return [0, 0]; }
  return [start, count - count % 3];
}

function buildLighting(dto: Json | null, vertexCount: number, elementCount: number): LightingData {
  if (!dto) { return EMPTY_LIGHTING; }

  const emissive: EmissiveRun[] = [];
  let next = 0;
  for (const run of arr(dto.emissive)) {
    if (!Array.isArray(run) || run.length < 3) { continue; }
    const start = int(run[0]), count = int(run[1]), colour = num(run[2], -1);
    if (start < next || count <= 0 || start + count > vertexCount || colour < 0 || colour > 0xffffffff) { continue; }
    emissive.push({ start, count, emissive: colour >>> 0 });
    next = start + count;
  }

  const lights: LightSource[] = [];
  for (const raw of arr(dto.lights)) {
    const light = objOrNull(raw);
    if (!light) { continue; }
    const element = int(light.element);
    if (element < 0 || element >= elementCount) { continue; }
    const p = readVector3(light.position);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) { continue; }
    const lumens = float(light.lumens, 1000), kelvin = float(light.kelvin, 3500), downward = float(light.downward, 0.7);
    lights.push({
      element,
      position: p,
      lumens: Number.isFinite(lumens) ? Math.min(Math.max(lumens, 10), 100000) : 1000,
      kelvin: Number.isFinite(kelvin) ? Math.min(Math.max(kelvin, 1000), 15000) : 3500,
      downward: Number.isFinite(downward) ? Math.min(Math.max(downward, 0), 1) : 0.7,
      estimated: bool(light.estimated)
    });
  }

  return emissive.length === 0 && lights.length === 0 ? EMPTY_LIGHTING : { emissive, lights };
}

function buildParameters(dto: Json | null, elementCount: number): ParameterTable {
  const names = arr(dto?.names).map(n => (typeof n === 'string' ? n : ''));
  if (names.length === 0) { return ParameterTable.empty; }
  const values = arr(dto?.values).map(v => (typeof v === 'string' ? v : ''));
  const fileRows = arr(dto?.rows);
  const rows: (number[] | null)[] = new Array(elementCount).fill(null);
  for (let i = 0; i < Math.min(fileRows.length, elementCount); i++) {
    const row = fileRows[i];
    rows[i] = Array.isArray(row) ? row.map(n => int(n, -1)) : null;
  }
  return new ParameterTable(names, values, rows);
}

function readLink(j: Json): LinkInfo {
  return {
    index: int(j.index),
    name: str(j.name, ''),
    title: str(j.title, ''),
    instanceId: num(j.instanceId),
    instanceUniqueId: str(j.instanceUniqueId, ''),
    modelKey: str(j.modelKey, ''),
    modelPath: str(j.modelPath, ''),
    originX: num(j.originX),
    originY: num(j.originY),
    originZ: num(j.originZ),
    basisX: readVector3(j.basisX, vec3(1, 0, 0)),
    basisY: readVector3(j.basisY, vec3(0, 1, 0)),
    basisZ: readVector3(j.basisZ, vec3(0, 0, 1)),
    phaseName: str(j.phaseName, null),
    existingPhaseName: str(j.existingPhaseName, null),
    elementCount: int(j.elementCount),
    roomCount: int(j.roomCount)
  };
}

function readProvenance(j: Json | null): ModelProvenance {
  const p = j ?? {};
  return {
    modelTitle: str(p.modelTitle, ''),
    modelPath: str(p.modelPath, ''),
    modelKey: str(p.modelKey, ''),
    isCloud: bool(p.isCloud),
    cloudProjectId: str(p.cloudProjectId, ''),
    cloudModelId: str(p.cloudModelId, ''),
    isWorkshared: bool(p.isWorkshared),
    revitVersion: str(p.revitVersion, ''),
    addinVersion: str(p.addinVersion, ''),
    user: str(p.user, ''),
    machine: str(p.machine, ''),
    extractedUtc: str(p.extractedUtc, '')
  };
}

function readSitePoint(j: Json | null): SitePoint | null {
  return j ? { position: readVector3(j.position), sharedPosition: readVector3(j.sharedPosition) } : null;
}

function readSite(j: Json | null): SiteInfo {
  const s = j ?? {};
  return {
    trueNorthAngle: float(s.trueNorthAngle),
    projectBasePoint: readSitePoint(objOrNull(s.projectBasePoint)),
    surveyPoint: readSitePoint(objOrNull(s.surveyPoint)),
    hasSharedTransform: bool(s.hasSharedTransform),
    sharedEast: num(s.sharedEast),
    sharedNorth: num(s.sharedNorth),
    sharedElevation: num(s.sharedElevation),
    sharedAngle: num(s.sharedAngle),
    hasLocation: bool(s.hasLocation),
    latitude: num(s.latitude),
    longitude: num(s.longitude),
    timeZone: num(s.timeZone),
    placeName: str(s.placeName, ''),
    sunStart: str(s.sunStart, '')
  };
}

function readJournalEntry(j: Json): JournalEntry {
  return {
    seq: int(j.seq),
    op: str(j.op, ''),
    mode: str(j.mode, null),
    elementId: num(j.elementId),
    uniqueId: str(j.uniqueId, ''),
    targetCloneKey: int(j.targetCloneKey),
    newCloneKey: int(j.newCloneKey),
    pivot: readVector3(j.pivot),
    offset: readVector3(j.offset),
    angle: float(j.angle),
    label: str(j.label, ''),
    utc: str(j.utc, ''),
    user: str(j.user, ''),
    appliedToRevit: bool(j.appliedToRevit),
    revitElementId: num(j.revitElementId)
  };
}

// #endregion

// #region Entries

async function readGeometry(zip: ZipReaderType, progress?: ReadProgress): Promise<SceneGeometry> {
  const entry = zip.get(BimGoFormat.ENTRY_GEOMETRY);
  if (!entry) { throw new InvalidData('The file has no geometry.'); }

  // Geometry is most of the work: it fills the bar from 10 % to 92 %
  const total = Math.max(1, entry.size);
  const bytes = await zip.read(entry, done => progress?.step?.(0.1 + 0.82 * (done / total)), progress?.signal);
  if (bytes.byteLength < 24) { throw new EndOfStream(); }

  const header = new DataView(bytes.buffer, bytes.byteOffset, 24);
  if (header.getUint32(0, true) !== BimGoFormat.GEOMETRY_MAGIC) { throw new InvalidData('The geometry is damaged (bad header).'); }
  const version = header.getInt32(4, true);
  if (version > BimGoFormat.GEOMETRY_VERSION) { throw new InvalidData('The geometry was written by a newer BimGo.'); }
  const vertexSize = header.getInt32(8, true);
  const vertexCount = header.getInt32(12, true);
  const indexCount = header.getInt32(16, true);

  if (vertexSize !== SCENE_VERTEX_SIZE) { throw new InvalidData(`Unsupported vertex layout (${vertexSize} bytes).`); }
  if (vertexCount < 0 || indexCount < 0 || indexCount % 3 !== 0) { throw new InvalidData('The geometry is damaged (bad counts).'); }

  const vertexEnd = 24 + vertexCount * SCENE_VERTEX_SIZE;
  if (bytes.byteLength < vertexEnd + indexCount * 4) { throw new EndOfStream(); }

  // Views over the inflated bytes (offsets are multiples of 4; all browsers are little-endian like the file)
  const vertexBytes = bytes.subarray(24, vertexEnd);
  const indices = new Uint32Array(bytes.buffer, bytes.byteOffset + vertexEnd, indexCount);
  return new SceneGeometry(vertexBytes, indices);
}

async function readMaterials(zip: ZipReaderType, dto: Json | null, vertexCount: number): Promise<MaterialData> {
  const list = arr(dto?.materials);
  if (list.length === 0) { return EMPTY_MATERIALS; }
  try {
    const table = list.slice(0, MAX_MATERIALS).map(m => cleanMaterial(objOrNull(m)));

    const entry = zip.get(BimGoFormat.ENTRY_MATERIAL_STREAMS);
    if (!entry) { return EMPTY_MATERIALS; }
    const bytes = await zip.read(entry);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 16 || view.getUint32(0, true) !== BimGoFormat.MATERIAL_MAGIC) { throw new Error('bad material.bin header'); }
    if (view.getInt32(4, true) > BimGoFormat.MATERIAL_VERSION) { throw new Error('material.bin from a newer BimGo'); }
    const count = view.getInt32(8, true);
    const flags = view.getInt32(12, true);
    if (count !== vertexCount) { throw new Error(`material.bin has ${count} vertices, the geometry ${vertexCount}`); }

    const uvStart = 16 + count * 2;
    const hasUvs = (flags & 1) !== 0;
    if (bytes.byteLength < uvStart + (hasUvs ? count * 8 : 0)) { throw new Error('material.bin ends early'); }

    // Copied out: the index block is 2-byte aligned, the UV block may not be 4-byte aligned
    const indices = new Uint16Array(bytes.slice(16, uvStart).buffer);
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] >= table.length) { indices[i] = MATERIAL_NONE; }
    }
    let uvs = new Float32Array(0);
    if (hasUvs) {
      uvs = new Float32Array(bytes.slice(uvStart, uvStart + count * 8).buffer);
      for (let i = 0; i < uvs.length; i += 2) {
        if (!Number.isFinite(uvs[i]) || !Number.isFinite(uvs[i + 1])) { uvs[i] = 0; uvs[i + 1] = 0; }
      }
    }

    // Images: only referenced entries under textures/, each read once
    const textures = new Map<string, Uint8Array>();
    for (const material of table) {
      if (material.texture === null) { continue; }
      if (!textures.has(material.texture)) {
        const image = material.texture.startsWith(BimGoFormat.TEXTURE_FOLDER) ? await readBytes(zip, material.texture) : null;
        if (image) { textures.set(material.texture, image); }
      }
      if (!textures.has(material.texture)) {
        material.texture = null;
        if (material.textureState === TextureState.Embedded) { material.textureState = TextureState.Missing; }
      }
    }

    return { materials: table, vertexMaterial: indices, vertexUv: uvs, textures, textureMaxSize: nearestTextureSize(int(dto?.textureMaxSize, 512)) };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') { throw e; }
    console.info(`Materials ignored (damaged): ${e instanceof Error ? e.message : String(e)}`);
    return EMPTY_MATERIALS;
  }
}

async function readBytes(zip: ZipReaderType, name: string): Promise<Uint8Array | null> {
  try {
    const entry = zip.get(name);
    if (!entry || entry.size <= 0 || entry.size > 64 * 1024 * 1024) { return null; }
    return await zip.read(entry);
  } catch (e) {
    console.info(`Texture ${name} unreadable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function readOptionalJson(zip: ZipReaderType, name: string): Promise<Json | null> {
  try {
    return await readJson(zip, name, false);
  } catch (e) {
    console.info(`${name} ignored (damaged): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function readJson(zip: ZipReaderType, name: string, required: boolean): Promise<Json | null> {
  const entry = zip.get(name);
  if (!entry) {
    if (required) { throw new InvalidData(`The file is incomplete (${name} is missing).`); }
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(await zip.readText(entry));
  } catch (e) {
    if (e instanceof SyntaxError) { throw new JsonDamaged(); }
    throw e;
  }
  const json = objOrNull(value);
  if (!json && required) { throw new InvalidData(`The file is damaged (${name} is empty).`); }
  return json;
}

// #endregion

// #region Errors

class InvalidData extends Error {}
class JsonDamaged extends Error {}
class EndOfStream extends Error {}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) { throw new DOMException('Cancelled.', 'AbortError'); }
}

function describe(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') { return 'Cancelled.'; }
  if (e instanceof InvalidData || e instanceof ZipError) { return e.message; }
  if (e instanceof JsonDamaged) { return 'The file is damaged (unreadable data).'; }
  if (e instanceof EndOfStream) { return 'The file is damaged (it ends early).'; }
  if (e instanceof DOMException && e.name === 'NotReadableError') { return 'The file could not be read (it may have been moved or changed).'; }
  if (e instanceof RangeError) { return 'The model is too large for this browser.'; }
  return e instanceof Error ? e.message : String(e);
}

// #endregion
