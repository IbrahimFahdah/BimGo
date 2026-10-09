/** How a family type is placed in Revit, as far as the family library cares (port of LibraryPlacement). */
export const LibraryPlacement = {
  /** Placed on a level, free in plan (non-hosted): can be placed from the walkthrough. */
  LEVEL_BASED: 'levelBased',
  /** Needs a wall, floor, ceiling or roof host: listed, not placeable yet. */
  HOSTED: 'hosted',
  /** Work-plane- or face-based: placed on the level's plane. */
  WORK_PLANE: 'workPlane',
  /** Older name of WORK_PLANE (snapshots from the first library build; listed only). */
  FACE_BASED: 'faceBased',
  /** Anything else (two-level, line-based, adaptive…): listed, not placeable. */
  OTHER: 'other'
} as const;

/**
 * One loadable family type offered in the walkthrough's family library (port of LibraryEntry). Placeable types have a
 * template element: hidden geometry at the tail of the snapshot that the Place gun clones.
 */
export interface LibraryEntry {
  /** The family type's ElementId value (a fallback; typeUniqueId is the key). */
  typeId: number;
  /** The family type's UniqueId: what a placement asks Revit to place. */
  typeUniqueId: string;
  family: string;
  type: string;
  /** Category catalog key (e.g. "furniture"). */
  category: string;
  /** One of LibraryPlacement. */
  placement: string;
  /** True when the walkthrough can place it (it then has a template element). */
  placeable: boolean;
  /** Why it can't be placed (shown greyed in the library), or null. */
  reason: string | null;
  /** The template element (index into SceneData.elements), or -1. */
  element: number;
  /** The preview image's entry name ("library/n.png"), or null. */
  preview: string | null;
  /** Instances of the type already in the snapshot. */
  placed: number;
  /** Runtime only: the catalog index of category. */
  categoryIndex: number;
}

/** The family library of a snapshot (port of LibraryData). Never null on a scene (EMPTY_LIBRARY). */
export interface LibraryData {
  /** The offered types, sorted by category, family and type. */
  entries: LibraryEntry[];
  /** Preview images (PNG) by entry name. */
  previews: Map<string, Uint8Array>;
  /** The first template vertex (whole-scene passes stop here); the vertex count when there are none. */
  vertexStart: number;
}

export const EMPTY_LIBRARY: LibraryData = Object.freeze({ entries: [], previews: new Map(), vertexStart: Number.MAX_SAFE_INTEGER }) as LibraryData;

export function isLibraryEmpty(library: LibraryData): boolean {
  return library.entries.length === 0;
}

/** "Family : Type". */
export function libraryLabel(entry: LibraryEntry): string {
  return entry.type ? `${entry.family} : ${entry.type}` : entry.family;
}

/** Number of placeable types. */
export function placeableCount(library: LibraryData): number {
  return library.entries.filter(e => e.placeable && e.element >= 0).length;
}

/** The entry of a type, by UniqueId (null when the library doesn't have it). */
export function findLibraryEntry(library: LibraryData, typeUniqueId: string | null | undefined): LibraryEntry | null {
  if (!typeUniqueId) { return null; }
  return library.entries.find(e => e.typeUniqueId === typeUniqueId) ?? null;
}
