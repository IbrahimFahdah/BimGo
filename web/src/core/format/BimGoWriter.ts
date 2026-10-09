import type { EditJournal, JournalEntry } from '../edits/EditJournal';
import type { Vec3 } from '../math/Vector';
import { CATEGORIES } from '../scene/CategoryCatalog';
import type { LightingData } from '../scene/LightingData';
import type { LinkInfo } from '../scene/LinkInfo';
import { formatTextureState, type MaterialData, type SceneMaterial } from '../scene/MaterialData';
import type { SiteInfo, SitePoint } from '../scene/ModelInfo';
import { modelVertexCount, SCENE_VERTEX_SIZE, type SceneData } from '../scene/SceneData';
import { isLibraryEmpty, type LibraryEntry } from '../scene/FamilyLibrary';
import { BimGoFormat, FileKinds, formatPhaseRole } from './BimGoFormat';
import type { BimGoDocument } from './BimGoReader';
import {
  type BookmarkDocument, type BookmarkRecord, type CommentDocument, isVisibilityEmpty, type SunSettings, type SunTime, type VisibilitySettings
} from './DocumentModels';
import { obj, type Json } from './Json';
import { ZipWriter } from './ZipWriter';

/** Who wrote the file (port of WriterInfo). */
export interface WriterInfo {
  generator: string;
  version: string;
}

/** What a save writes beyond the scene (the walkthrough's current state). */
export interface SaveContent {
  comments: CommentDocument;
  journal: EditJournal;
  bookmarks: BookmarkDocument;
  sun: SunSettings | null;
  visibility: VisibilitySettings | null;
  /** The material set to write (the Textures panel's, else the file's). */
  materials: MaterialData;
  savedBy: string;
}

/**
 * Writes .bimgo files (port of BimGo.Core/Format/BimGoWriter.cs): the same entries and JSON shapes as the desktop
 * (camelCase, nulls left out, float32 values in their shortest form), geometry exactly as read.
 * @returns The finished file.
 */
export async function writeBimGo(document: BimGoDocument, content: SaveContent, writer: WriterInfo, kind: string,
  progress?: (fraction: number) => void, signal?: AbortSignal): Promise<Blob> {
  const scene = document.scene;
  const zip = new ZipWriter();
  const json = (value: unknown, indented: boolean) => JSON.stringify(value, replacer, indented ? 2 : undefined);

  await zip.addText(BimGoFormat.ENTRY_MANIFEST, json(buildManifest(document, content, writer, kind), true), signal);
  await zip.addText(BimGoFormat.ENTRY_MODEL, json(buildModel(scene), true), signal);
  await zip.addText(BimGoFormat.ENTRY_ELEMENTS, json(buildElements(scene), false), signal);
  progress?.(0.12);
  if (!scene.parameters.isEmpty) {
    await zip.addText(BimGoFormat.ENTRY_PARAMETERS, json({ names: scene.parameters.names, values: scene.parameters.values, rows: scene.parameters.rows }, false), signal);
  }

  // Geometry: header + the vertex block + indices, exactly as read
  const g = scene.geometry;
  const geometry = new Uint8Array(24 + g.vertexBytes.byteLength + g.indices.byteLength);
  const header = new DataView(geometry.buffer, 0, 24);
  header.setUint32(0, BimGoFormat.GEOMETRY_MAGIC, true);
  header.setInt32(4, BimGoFormat.GEOMETRY_VERSION, true);
  header.setInt32(8, SCENE_VERTEX_SIZE, true);
  header.setInt32(12, g.vertexCount, true);
  header.setInt32(16, g.indices.length, true);
  geometry.set(g.vertexBytes, 24);
  geometry.set(new Uint8Array(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength), 24 + g.vertexBytes.byteLength);
  await zip.add(BimGoFormat.ENTRY_GEOMETRY, geometry, true, signal);
  progress?.(0.9);

  await zip.addText(BimGoFormat.ENTRY_COMMENTS, json(commentDocument(content.comments), true), signal);
  await zip.addText(BimGoFormat.ENTRY_JOURNAL, json({ entries: content.journal.entries.map(journalEntry) }, true), signal);

  // Optional parts: older readers ignore entries they don't know, so no format bump is needed
  if (content.bookmarks.bookmarks.length > 0 || content.bookmarks.home) {
    await zip.addText(BimGoFormat.ENTRY_BOOKMARKS, json(bookmarkDocument(content.bookmarks), true), signal);
  }
  const v = content.visibility;
  if (v && !isVisibilityEmpty(v)) {
    await zip.addText(BimGoFormat.ENTRY_VISIBILITY, json(visibility(v), true), signal);
  }
  if (content.sun) { await zip.addText(BimGoFormat.ENTRY_SUN, json(sunSettings(content.sun), true), signal); }
  if (scene.lighting.emissive.length > 0 || scene.lighting.lights.length > 0) {
    await zip.addText(BimGoFormat.ENTRY_LIGHTING, json(buildLighting(scene.lighting), false), signal);
  }
  if (!isLibraryEmpty(scene.library)) { await writeLibrary(zip, scene, json, signal); }
  const materials = content.materials;
  if (materials.materials.length > 0 && materials.vertexMaterial.length === g.vertexCount) {
    await writeMaterials(zip, materials, json, signal);
  }
  progress?.(1);
  return zip.finish();
}

// #region Parts

function buildManifest(document: BimGoDocument, content: SaveContent, writer: WriterInfo, kind: string): Json {
  const scene = document.scene;
  const read = document.manifest;
  const extraction = obj(read.extraction);
  return {
    format: BimGoFormat.FORMAT_NAME,
    formatVersion: BimGoFormat.FORMAT_VERSION,
    generator: writer.generator,
    generatorVersion: writer.version,
    kind: kind || document.kind || FileKinds.SAVE,
    title: scene.modelTitle,
    createdUtc: document.createdUtc || new Date().toISOString(),
    savedUtc: new Date().toISOString(),
    savedBy: content.savedBy,
    units: 'metres',
    axes: 'Z up; geometry is scene-local (add model.originOffset for Revit internal coordinates)',
    provenance: read.provenance ?? scene.provenance,
    extraction: {
      enabledCategories: extraction.enabledCategories ?? [],
      triangleThreshold: extraction.triangleThreshold ?? 0,
      overLimit: extraction.overLimit ?? '',
      extraParameters: scene.parameters.names,
      proxyCount: scene.proxyCount,
      skippedCount: scene.skippedCount,
      extractionSeconds: Math.round(scene.extractionSeconds * 100) / 100,
      activeView: scene.sourceView
    },
    commentsSidecar: kind === FileKinds.SNAPSHOT ? scene.commentsPath : null,
    counts: {
      elements: scene.elements.length,
      vertices: scene.geometry.vertexCount,
      indices: scene.geometry.indices.length,
      levels: scene.levels.length,
      rooms: scene.rooms.length,
      comments: content.comments.comments.length,
      journalEntries: content.journal.count,
      bookmarks: content.bookmarks.bookmarks.length,
      links: scene.links.length
    }
  };
}

function buildModel(scene: SceneData): Json {
  return {
    originOffset: vec(scene.originOffset),
    boundsMin: vec(scene.bounds.min),
    boundsMax: vec(scene.bounds.max),
    site: site(scene.site),
    phaseId: scene.phaseId,
    phaseName: scene.phaseName,
    existingPhaseId: scene.existingPhaseId,
    existingPhaseName: scene.existingPhaseName,
    phaseNote: scene.phaseNote,
    spawn: scene.spawn ? { eye: vec(scene.spawn.eye), yaw: f(scene.spawn.yaw), pitch: f(scene.spawn.pitch), source: scene.spawn.source } : null,
    levels: scene.levels.map(l => ({ name: l.name, elevation: f(l.elevation) })),
    rooms: scene.rooms.map(r => ({
      number: r.number, name: r.name, bottomZ: f(r.bottomZ), topZ: f(r.topZ), link: r.link > 0 ? r.link : null,
      loops: r.loops.map(loop => loop.flatMap(p => [f(p.x), f(p.y)]))
    })),
    // Category list in catalog order: element category indices refer to positions in this list
    categories: CATEGORIES.map(d => ({ key: d.key, loaded: scene.categoryLoaded[d.index] ?? false, count: scene.categoryElementCounts[d.index] ?? 0 })),
    links: scene.links.length > 0 ? scene.links.map(linkInfo) : null
  };
}

function site(s: SiteInfo): Json {
  const point = (p: SitePoint | null) => (p ? { position: vec(p.position), sharedPosition: vec(p.sharedPosition) } : null);
  return {
    trueNorthAngle: f(s.trueNorthAngle), projectBasePoint: point(s.projectBasePoint), surveyPoint: point(s.surveyPoint),
    hasSharedTransform: s.hasSharedTransform, sharedEast: s.sharedEast, sharedNorth: s.sharedNorth, sharedElevation: s.sharedElevation,
    sharedAngle: s.sharedAngle, hasLocation: s.hasLocation, latitude: s.latitude, longitude: s.longitude, timeZone: s.timeZone,
    placeName: s.placeName, sunStart: s.sunStart
  };
}

function linkInfo(l: LinkInfo): Json {
  return {
    index: l.index, name: l.name, title: l.title, instanceId: l.instanceId, instanceUniqueId: l.instanceUniqueId, modelKey: l.modelKey,
    modelPath: l.modelPath, originX: l.originX, originY: l.originY, originZ: l.originZ, basisX: vec(l.basisX), basisY: vec(l.basisY),
    basisZ: vec(l.basisZ), phaseName: l.phaseName, existingPhaseName: l.existingPhaseName, elementCount: l.elementCount, roomCount: l.roomCount
  };
}

function buildElements(scene: SceneData): Json {
  return {
    elements: scene.elements.map(r => ({
      id: r.elementId,
      uniqueId: r.uniqueId || null,
      name: r.name,
      category: r.categoryIndex,
      categoryName: r.categoryName,
      familyType: r.familyType,
      level: r.levelName,
      hostId: r.hostId,
      proxy: r.isProxy,
      movable: r.movable,
      moveBlockReason: r.moveBlockReason,
      pivot: vec(r.pivot),
      phase: formatPhaseRole(r.phase),
      link: r.link > 0 ? r.link : null,
      boundsMin: vec(r.bounds.min),
      boundsMax: vec(r.bounds.max),
      opaque: r.opaqueCount > 0 ? [r.opaqueStart, r.opaqueCount] : null,
      transparent: r.transparentCount > 0 ? [r.transparentStart, r.transparentCount] : null,
      library: r.isLibraryTemplate ? true : null
    }))
  };
}

function buildLighting(lighting: LightingData): Json {
  return {
    version: 1,
    emissive: lighting.emissive.map(r => [r.start, r.count, r.emissive]),
    lights: lighting.lights.map(l => ({ element: l.element, position: vec(l.position), lumens: f(l.lumens), kelvin: f(l.kelvin), downward: f(l.downward), estimated: l.estimated }))
  };
}

function commentDocument(d: CommentDocument): Json {
  return {
    version: d.version, model: d.model, units: d.units,
    comments: d.comments.map(c => ({
      id: c.id, author: c.author, created: c.created, text: c.text, x: c.x, y: c.y, z: c.z, elementId: c.elementId, level: c.level,
      edited: c.edited, editedBy: c.editedBy, status: c.status, assignedTo: c.assignedTo, priority: c.priority, updated: c.updated,
      updatedBy: c.updatedBy, replies: c.replies?.map(r => ({ id: r.id, author: r.author, created: r.created, text: r.text })) ?? null,
      view: c.view ? { x: c.view.x, y: c.view.y, z: c.view.z, yaw: f(c.view.yaw), pitch: f(c.view.pitch), flying: c.view.flying } : null,
      thumbnail: c.thumbnail
    }))
  };
}

function visibility(v: VisibilitySettings): Json {
  return {
    hiddenCategories: v.hiddenCategories, hiddenLinks: v.hiddenLinks, hiddenElements: v.hiddenElements,
    groundOffset: v.groundOffset === null ? null : f(v.groundOffset)
  };
}

function libraryEntry(e: LibraryEntry): Json {
  return {
    typeId: e.typeId, typeUniqueId: e.typeUniqueId, family: e.family, type: e.type, category: e.category, placement: e.placement,
    placeable: e.placeable, reason: e.reason, element: e.element, preview: e.preview, placed: e.placed
  };
}

/** library.json (the offered types and the first template vertex) and the preview images under library/ (as is: PNG). */
async function writeLibrary(zip: ZipWriter, scene: SceneData, json: (v: unknown, indented: boolean) => string, signal?: AbortSignal): Promise<void> {
  const library = scene.library;
  await zip.addText(BimGoFormat.ENTRY_LIBRARY, json({ version: 1, vertexStart: modelVertexCount(scene), entries: library.entries.map(libraryEntry) }, false), signal);
  const written = new Set<string>();
  for (const entry of library.entries) {
    const name = entry.preview;
    if (name === null || written.has(name) || !name.startsWith(BimGoFormat.LIBRARY_FOLDER)) { continue; }
    written.add(name);
    const bytes = library.previews.get(name);
    if (bytes && bytes.length > 0) { await zip.add(name, bytes, false, signal); }
  }
}

function sunTime(t: SunTime): Json {
  return { month: t.month, day: t.day, minutes: t.minutes, daylightSaving: t.daylightSaving };
}

function sunSettings(s: SunSettings): Json {
  return {
    version: s.version, enabled: s.enabled, time: sunTime(s.time), sunIntensity: f(s.sunIntensity), skyIntensity: f(s.skyIntensity),
    shadowIntensity: f(s.shadowIntensity), glassTransmission: f(s.glassTransmission)
  };
}

function bookmark(b: BookmarkRecord): Json {
  return {
    id: b.id, name: b.name, author: b.author, created: b.created, x: b.x, y: b.y, z: b.z, yaw: f(b.yaw), pitch: f(b.pitch),
    flying: b.flying, level: b.level, sun: b.sun ? sunTime(b.sun) : null, thumbnail: b.thumbnail
  };
}

function bookmarkDocument(d: BookmarkDocument): Json {
  return { version: d.version, model: d.model, units: d.units, bookmarks: d.bookmarks.map(bookmark), home: d.home ? bookmark(d.home) : null };
}

function journalEntry(e: JournalEntry): Json {
  return {
    seq: e.seq, op: e.op, mode: e.mode, elementId: e.elementId, uniqueId: e.uniqueId, targetCloneKey: e.targetCloneKey, newCloneKey: e.newCloneKey,
    typeUniqueId: e.op === 'place' ? e.typeUniqueId ?? null : null, typeId: e.op === 'place' && e.typeId ? e.typeId : null,
    pivot: vec(e.pivot), offset: vec(e.offset), angle: f(e.angle), label: e.label, utc: e.utc, user: e.user, appliedToRevit: e.appliedToRevit,
    revitElementId: e.revitElementId
  };
}

function material(m: SceneMaterial): Json {
  return {
    name: m.name, link: m.link, materialId: m.materialId, schema: m.schema, uniqueId: m.uniqueId, colour: vec(m.colour),
    renderColour: m.renderColour ? vec(m.renderColour) : null, assetTint: m.assetTint ? vec(m.assetTint) : null, texture: m.texture,
    textureState: formatTextureState(m.textureState), textureSource: m.textureSource, textureOrigin: m.textureOrigin, proxy: m.proxy,
    invert: m.invert ? true : null, autodesk: m.autodesk, scaleU: f(m.scaleU), scaleV: f(m.scaleV), offsetU: f(m.offsetU),
    offsetV: f(m.offsetV), angle: f(m.angle), fade: f(m.fade), tint: vec(m.tint), reflectivity: f(m.reflectivity),
    // Reflection fields: left out at their defaults (as the desktop's WhenWritingDefault), so older files stay the same
    shine: m.shine > 0 ? f(m.shine) : null, roughness: m.roughness === null ? null : f(m.roughness), metallic: m.metallic ? true : null,
    water: m.water ? true : null, waterBump: m.waterBump > 0 ? f(m.waterBump) : null, reflectSource: m.reflectSource
  };
}

async function writeMaterials(zip: ZipWriter, materials: MaterialData, json: (v: unknown, indented: boolean) => string, signal?: AbortSignal): Promise<void> {
  await zip.addText(BimGoFormat.ENTRY_MATERIALS, json({ version: 1, textureMaxSize: materials.textureMaxSize, materials: materials.materials.map(material) }, false), signal);

  const count = materials.vertexMaterial.length;
  const hasUv = materials.vertexUv.length === count * 2;
  const stream = new Uint8Array(16 + count * 2 + (hasUv ? count * 8 : 0));
  const header = new DataView(stream.buffer, 0, 16);
  header.setUint32(0, BimGoFormat.MATERIAL_MAGIC, true);
  header.setInt32(4, BimGoFormat.MATERIAL_VERSION, true);
  header.setInt32(8, count, true);
  header.setInt32(12, hasUv ? 1 : 0, true); // flags: bit 0 = surface coordinates follow
  stream.set(new Uint8Array(materials.vertexMaterial.buffer, materials.vertexMaterial.byteOffset, count * 2), 16);
  if (hasUv) { stream.set(new Uint8Array(materials.vertexUv.buffer, materials.vertexUv.byteOffset, count * 8), 16 + count * 2); }
  await zip.add(BimGoFormat.ENTRY_MATERIAL_STREAMS, stream, true, signal);

  const written = new Set<string>();
  for (const m of materials.materials) {
    const name = m.texture;
    if (name === null || written.has(name) || !name.startsWith(BimGoFormat.TEXTURE_FOLDER)) { continue; }
    written.add(name);
    const bytes = materials.textures.get(name);
    if (bytes && bytes.length > 0) { await zip.add(name, bytes, false, signal); } // JPEG / PNG: already compressed
  }
}

// #endregion

// #region JSON helpers

/**
 * The sidecar documents in the same JSON as inside a .bimgo (live sessions keep them beside the Revit model, written by
 * the add-in): nulls left out, float32 values in their shortest form.
 */
export const SidecarJson = {
  comments: (d: CommentDocument): Json => plain(commentDocument(d)),
  bookmarks: (d: BookmarkDocument): Json => plain(bookmarkDocument(d)),
  sun: (s: SunSettings): Json => plain(sunSettings(s)),
  visibility: (v: VisibilitySettings): Json => plain(visibility(v))
};

function plain(value: unknown): Json {
  return JSON.parse(JSON.stringify(value, replacer)) as Json;
}

/** Leaves nulls out, as the desktop's WhenWritingNull does. */
function replacer(_key: string, value: unknown): unknown {
  return value === null ? undefined : value;
}

/** A float32 member in its shortest round-trip form (System.Text.Json writes floats this way). */
export function f(value: number): number {
  if (!Number.isFinite(value)) { return 0; }
  const single = Math.fround(value);
  for (let precision = 1; precision < 10; precision++) {
    const candidate = Number(single.toPrecision(precision));
    if (Math.fround(candidate) === single) { return candidate; }
  }
  return single;
}

function vec(v: Vec3): number[] {
  return [f(v.x), f(v.y), f(v.z)];
}

// #endregion
