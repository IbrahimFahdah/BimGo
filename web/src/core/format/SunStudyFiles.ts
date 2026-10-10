import type { ModelProvenance } from '../scene/ModelInfo';
import { cleanSunHoursSettings, defaultSunHoursSettings, type SunHoursSettings } from '../scene/SunHours';
import { arr, bool, float, int, type Json, num, obj, objOrNull, str } from './Json';

/**
 * One surface of a saved study (port of SunStudyFace): which element and plane it is (so the grid can be laid again),
 * the room it was clipped to and labels for the export. Coordinates are Revit internal metres.
 */
export interface SunStudyFace {
  uniqueId: string | null;
  elementId: number;
  link: number;
  elementName: string;
  /** The plane normal (internal axes). */
  nx: number;
  ny: number;
  nz: number;
  /** The plane offset in internal coordinates (dot(normal, point)). */
  offset: number;
  bothSides: boolean;
  picked: boolean;
  /** The room the cells were clipped to: "number|name|level" (empty = none). */
  roomKey: string;
  /** "2.05 Kitchen" for the export. */
  roomLabel: string;
}

/** A saved study (port of SunStudyDocument): settings, surfaces, every cell's test point and its value. */
export interface SunStudyDocument {
  version: number;
  name: string;
  saved: string;
  savedBy: string;
  model: string;
  units: string;
  /** The grid settings (cell size, offsets). */
  grid: SunHoursSettings;
  /** The run settings (day, times, step, glass, target, mode). */
  run: SunHoursSettings;
  sunSamples: number;
  totalSamples: number;
  faces: SunStudyFace[];
  /** Per cell, its face index. */
  cellFaces: number[];
  /** Per cell, its test point x, y, z (internal metres, flat). */
  points: number[];
  /** Per cell, its value: hours, daylight factor (%) or average illuminance (lux), by the run's mode. */
  hours: number[];
  /** Illuminance studies: per cell, the share of time samples at or above the lux target (else null). */
  shares: number[] | null;
}

/** A saved study in a model's list. */
export interface SunStudyInfo {
  name: string;
  saved: string;
}

/** True when the arrays agree (one face index, three coordinates and one value per cell, finite numbers). */
export function isStudyConsistent(d: SunStudyDocument): boolean {
  const cells = d.hours.length;
  if (d.cellFaces.length !== cells || d.points.length !== cells * 3) { return false; }
  if (d.cellFaces.some(f => !Number.isInteger(f) || f < 0 || f >= d.faces.length)) { return false; }
  if (d.points.some(v => !Number.isFinite(v))) { return false; }
  if (d.hours.some(v => !Number.isFinite(v) || v < 0)) { return false; }
  if (d.shares) {
    if (d.shares.length !== cells || d.shares.some(v => !Number.isFinite(v) || v < 0 || v > 1.0001)) { return false; }
  }
  return true;
}

function readSettings(v: unknown): SunHoursSettings {
  const j = obj(v);
  const d = defaultSunHoursSettings();
  return cleanSunHoursSettings({
    month: int(j.month, d.month), day: int(j.day, d.day), startMinutes: int(j.startMinutes, d.startMinutes), endMinutes: int(j.endMinutes, d.endMinutes),
    stepMinutes: int(j.stepMinutes, d.stepMinutes), daylightSaving: bool(j.daylightSaving), gridSize: float(j.gridSize, d.gridSize),
    floorOffset: float(j.floorOffset), wallOffset: float(j.wallOffset), glassBlocks: bool(j.glassBlocks), target: int(j.target, 0),
    targetHours: float(j.targetHours, d.targetHours), mode: int(j.mode, 0), workPlane: float(j.workPlane, d.workPlane), rays: int(j.rays, d.rays),
    directSun: bool(j.directSun, true), standardReflectance: bool(j.standardReflectance), factorTarget: float(j.factorTarget, d.factorTarget),
    luxTarget: float(j.luxTarget, d.luxTarget), luxShare: float(j.luxShare, d.luxShare)
  }, new Date().getFullYear());
}

const numbers = (v: unknown) => arr(v).map(x => (typeof x === 'number' ? x : NaN));

/** Reads a study's JSON (the desktop's camelCase file), or null when it is damaged. */
export function readSunStudy(j: Json | null, fallbackName: string): SunStudyDocument | null {
  if (!j) { return null; }
  const document: SunStudyDocument = {
    version: int(j.version, 1),
    name: str(j.name, '') || fallbackName,
    saved: str(j.saved, new Date().toISOString()),
    savedBy: str(j.savedBy, ''),
    model: str(j.model, ''),
    units: str(j.units, 'metres, Revit internal coordinates'),
    grid: readSettings(j.grid),
    run: readSettings(j.run),
    sunSamples: int(j.sunSamples),
    totalSamples: int(j.totalSamples),
    faces: arr(j.faces).map(f => objOrNull(f)).filter((f): f is Json => f !== null).map(f => ({
      uniqueId: str(f.uniqueId, null), elementId: num(f.elementId), link: int(f.link), elementName: str(f.elementName, ''),
      nx: float(f.nx), ny: float(f.ny), nz: float(f.nz), offset: num(f.offset), bothSides: bool(f.bothSides), picked: bool(f.picked),
      roomKey: str(f.roomKey, ''), roomLabel: str(f.roomLabel, '')
    })),
    cellFaces: numbers(j.cellFaces),
    points: numbers(j.points),
    hours: numbers(j.hours),
    shares: Array.isArray(j.shares) ? numbers(j.shares) : null
  };
  return isStudyConsistent(document) ? document : null;
}

/**
 * The key a model's studies are stored under (port of ModelFolders.KeySourceFor): "cloud:<project>/<model>", else
 * "local:<model path>", else "file:<the .bimgo name>".
 */
export function studyKeySource(provenance: ModelProvenance | null, fileName: string): string {
  if (provenance?.isCloud && provenance.cloudProjectId.trim() && provenance.cloudModelId.trim()) {
    return `cloud:${provenance.cloudProjectId.trim()}/${provenance.cloudModelId.trim()}`;
  }
  if (provenance?.modelPath?.trim()) { return 'local:' + provenance.modelPath.trim(); }
  return 'file:' + (fileName ?? '');
}

/**
 * Saved studies (port of SunStudyFiles). The desktop writes JSON files into the model's BimGo folder; the browser
 * keeps the same JSON in IndexedDB, keyed by the model's key source and the study name. Never throws.
 */
export const SunStudyFiles = {
  MAX_NAME: 60,

  /** A file-safe study name: invalid characters replaced, trimmed, at most MAX_NAME characters, "Study" when blank. */
  safeName(name: string): string {
    // eslint-disable-next-line no-control-regex
    let safe = (name ?? '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[ .]+|[ .]+$/g, '');
    if (safe.length > SunStudyFiles.MAX_NAME) { safe = safe.slice(0, SunStudyFiles.MAX_NAME).replace(/[ .]+$/, ''); }
    return safe.length === 0 ? 'Study' : safe;
  },

  /** The saved studies of a model, newest first. */
  async list(model: string): Promise<SunStudyInfo[]> {
    try {
      const rows = await request<{ model: string; name: string; saved: string }[]>('readonly', s => s.index('model').getAll(model));
      return rows.map(r => ({ name: r.name, saved: r.saved })).sort((a, b) => b.saved.localeCompare(a.saved));
    } catch (e) {
      console.warn('Sun studies not listed', e);
      return [];
    }
  },

  /** Writes a study (replacing one of the same name). Returns an error message, or null. */
  async write(model: string, document: SunStudyDocument): Promise<string | null> {
    if (!isStudyConsistent(document)) { return 'The study is incomplete'; }
    document.name = SunStudyFiles.safeName(document.name);
    try {
      const json = JSON.parse(JSON.stringify(document)) as Json;
      await request('readwrite', s => s.put({ id: `${model}\n${document.name.toLowerCase()}`, model, name: document.name, saved: document.saved, json }));
      return null;
    } catch (e) {
      console.warn('Sun study not saved', e);
      return e instanceof Error ? e.message : 'Browser storage is unavailable';
    }
  },

  /** Reads a study; an error message instead when it is missing or damaged. */
  async read(model: string, name: string): Promise<{ document: SunStudyDocument | null; error: string | null }> {
    try {
      const row = await request<{ json: Json } | undefined>('readonly', s => s.get(`${model}\n${name.toLowerCase()}`));
      const document = readSunStudy(row?.json ?? null, name);
      return document ? { document, error: null } : { document: null, error: 'The study file is damaged' };
    } catch (e) {
      return { document: null, error: 'The study could not be read: ' + (e instanceof Error ? e.message : String(e)) };
    }
  },

  async delete(model: string, name: string): Promise<boolean> {
    try {
      await request('readwrite', s => s.delete(`${model}\n${name.toLowerCase()}`));
      return true;
    } catch {
      return false;
    }
  }
};

// #region IndexedDB

const DB_NAME = 'bimgo';
const STORE = 'sunStudies';
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('model', 'model', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  }).catch(e => {
    opening = null;
    throw e;
  });
  return opening;
}

async function request<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const req = body(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

// #endregion
