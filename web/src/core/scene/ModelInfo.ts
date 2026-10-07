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
}

/**
 * Per-element parameter name / value pairs, with names and values interned (port of ParameterTable).
 */
export class ParameterTable {
  static readonly empty = new ParameterTable([], [], []);

  constructor(
    readonly names: string[],
    readonly values: string[],
    readonly rows: (number[] | null)[]
  ) {}

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
