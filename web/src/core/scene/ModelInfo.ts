import type { Vec3 } from '../math/Vector';

/** Where a model came from (port of ModelProvenance). */
export interface ModelProvenance {
  modelTitle: string;
  modelPath: string;
  modelKey: string;
  isCloud: boolean;
  cloudProjectId: string;
  cloudModelId: string;
  isWorkshared: boolean;
  revitVersion: string;
  addinVersion: string;
  user: string;
  machine: string;
  extractedUtc: string;
}

/** A Revit reference point: internal position and shared (survey) position. */
export interface SitePoint {
  position: Vec3;
  sharedPosition: Vec3;
}

/** Site location and coordinate data (port of SiteInfo). */
export interface SiteInfo {
  trueNorthAngle: number;
  projectBasePoint: SitePoint | null;
  surveyPoint: SitePoint | null;
  hasSharedTransform: boolean;
  sharedEast: number;
  sharedNorth: number;
  sharedElevation: number;
  sharedAngle: number;
  hasLocation: boolean;
  latitude: number;
  longitude: number;
  timeZone: number;
  placeName: string;
  sunStart: string;
  /**
   * The IANA time zone of a location chosen in BimGo (location override), else absent. Never saved in model.json: only
   * on the session's effective copy (SolarPosition.effectiveSite).
   */
  zoneId?: string | null;
  /** With zoneId: daylight saving follows the zone's rules for each date (not saved in model.json). */
  autoDaylightSaving?: boolean;
}

/**
 * Per-element parameter name / value pairs, with names and values interned (port of ParameterTable).
 */
export class ParameterTable {
  static readonly empty = new ParameterTable([], [], []);

  /** Colour round A: names → pool index (case ignored; the first spelling wins). */
  private readonly nameIndex = new Map<string, number>();

  constructor(
    readonly names: string[],
    readonly values: string[],
    readonly rows: (number[] | null)[]
  ) {
    names.forEach((n, i) => {
      const key = (n ?? '').toLowerCase();
      if (key && !this.nameIndex.has(key)) { this.nameIndex.set(key, i); }
    });
  }

  /** Colour round A: a parameter name's index in names (case ignored), or −1 when it wasn't extracted. */
  indexOfName(name: string | null | undefined): number {
    return name ? this.nameIndex.get(name.trim().toLowerCase()) ?? -1 : -1;
  }

  /** Colour round A: an element's value of one parameter (by indexOfName), or null when the element doesn't have it. */
  valueOf(element: number, nameIndex: number): string | null {
    if (nameIndex < 0 || element < 0 || element >= this.rows.length) { return null; }
    const row = this.rows[element];
    if (!row) { return null; }
    for (let i = 0; i + 1 < row.length; i += 2) {
      if (row[i] !== nameIndex) { continue; }
      const v = row[i + 1];
      return v >= 0 && v < this.values.length ? this.values[v] : null;
    }
    return null;
  }

  /** Colour round A: the extracted parameter names, sorted (case ignored), blanks left out. */
  sortedNames(): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const n of this.names) {
      if (!n || !n.trim() || seen.has(n.toLowerCase())) { continue; }
      seen.add(n.toLowerCase());
      names.push(n);
    }
    return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }));
  }

  get isEmpty(): boolean {
    return this.names.length === 0;
  }

  countFor(element: number): number {
    const row = this.rows[element];
    return row ? Math.trunc(row.length / 2) : 0;
  }

  get(element: number, slot: number): { name: string; value: string } | null {
    const row = this.rows[element];
    if (!row || slot < 0 || slot * 2 + 1 >= row.length) { return null; }
    const n = row[slot * 2], v = row[slot * 2 + 1];
    if (n < 0 || n >= this.names.length || v < 0 || v >= this.values.length) { return null; }
    return { name: this.names[n], value: this.values[v] };
  }
}
