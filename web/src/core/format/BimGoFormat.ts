import { PhaseRole } from '../scene/SceneData';

/** Constants of the .bimgo format (port of BimGoFormat.cs). */
export const BimGoFormat = {
  EXTENSION: '.bimgo',
  FORMAT_NAME: 'bimgo',
  /** The newest format version this build reads and writes. */
  FORMAT_VERSION: 1,

  SIDECAR_SUFFIX: '.bimgo-comments.json',
  BOOKMARK_SIDECAR_SUFFIX: '.bimgo-bookmarks.json',
  SUN_SIDECAR_SUFFIX: '.bimgo-sun.json',
  VISIBILITY_SIDECAR_SUFFIX: '.bimgo-visibility.json',
  /** Round K: the camera path sidecar suffix beside an older snapshot. */
  PATHS_SIDECAR_SUFFIX: '.bimgo-paths.json',
  LEGACY_SIDECAR_SUFFIX: '.rvtgo.json',

  ENTRY_MANIFEST: 'manifest.json',
  ENTRY_MODEL: 'model.json',
  ENTRY_ELEMENTS: 'elements.json',
  ENTRY_PARAMETERS: 'parameters.json',
  ENTRY_GEOMETRY: 'geometry.bin',
  ENTRY_COMMENTS: 'comments.json',
  ENTRY_JOURNAL: 'journal.json',
  ENTRY_BOOKMARKS: 'bookmarks.json',
  ENTRY_SUN: 'sun.json',
  ENTRY_VISIBILITY: 'visibility.json',
  ENTRY_LIGHTING: 'lighting.json',
  ENTRY_MATERIALS: 'materials.json',
  ENTRY_MATERIAL_STREAMS: 'material.bin',
  ENTRY_LIBRARY: 'library.json',
  /** Optional picture of the view at the last save (review tools round: the start screen's card). */
  ENTRY_THUMBNAIL: 'thumbnail.jpg',
  /** Largest thumbnail read back (bytes). */
  MAX_THUMBNAIL_BYTES: 2 * 1024 * 1024,
  /** Optional (Round C): clash sets, tests, results and history (clashes/ClashModels ClashDocument). */
  ENTRY_CLASHES: 'clashes.json',
  /** Optional (grids round A): the host's and extracted links' grids. */
  ENTRY_GRIDS: 'grids.json',
  /** Optional (Round K): keyframed camera paths. */
  ENTRY_PATHS: 'paths.json',
  TEXTURE_FOLDER: 'textures/',
  /** The folder family library previews live under. */
  LIBRARY_FOLDER: 'library/',

  /** "BMAT" little-endian. */
  MATERIAL_MAGIC: 0x54414d42,
  MATERIAL_VERSION: 1,
  /** "BGEO" little-endian. */
  GEOMETRY_MAGIC: 0x4f454742,
  GEOMETRY_VERSION: 1
} as const;

/** The manifest's "kind" values (port of FileKinds). */
export const FileKinds = {
  EXPORT: 'revit-export',
  SESSION_SAVE: 'session-save',
  SAVE: 'save',
  SNAPSHOT: 'live-snapshot'
} as const;

export function hasBimGoExtension(name: string): boolean {
  return name.toLowerCase().endsWith(BimGoFormat.EXTENSION);
}

export function formatPhaseRole(role: PhaseRole): string | null {
  switch (role) {
    case PhaseRole.New: return 'new';
    case PhaseRole.Between: return 'between';
    case PhaseRole.Unphased: return 'unphased';
    default: return null;
  }
}

export function parsePhaseRole(value: unknown): PhaseRole {
  switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
    case 'new': return PhaseRole.New;
    case 'between': return PhaseRole.Between;
    case 'unphased': return PhaseRole.Unphased;
    default: return PhaseRole.Existing;
  }
}
