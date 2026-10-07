import type { SiteInfo, SitePoint } from './ModelInfo';

/** Which coordinates the readout shows (port of CoordinateReadout). */
export enum CoordinateReadout {
  Off = 0,
  Shared = 1,
  Project = 2,
  Internal = 3
}

/** Internal → shared (survey) transform: rotate by the angle about the internal origin, then offset. */
export class SharedTransform {
  readonly cos: number;
  readonly sin: number;

  constructor(
    readonly east: number,
    readonly north: number,
    readonly elevation: number,
    readonly angle: number,
    /** True when worked out from reference points (older files), not captured from Revit. */
    readonly approximate: boolean
  ) {
    this.cos = Math.cos(angle);
    this.sin = Math.sin(angle);
  }

  apply(x: number, y: number, z: number): [number, number, number] {
    return [x * this.cos - y * this.sin + this.east, x * this.sin + y * this.cos + this.north, z + this.elevation];
  }
}

/**
 * Revit coordinate systems from the exported site data (port of BimGo.Core/Scene/SiteCoordinates.cs).
 */
export const SiteCoordinates = {
  /** The internal → shared transform, or null when the file has no shared coordinates. */
  tryGetShared(site: SiteInfo | null): SharedTransform | null {
    if (!site) { return null; }
    if (site.hasSharedTransform) {
      return new SharedTransform(site.sharedEast, site.sharedNorth, site.sharedElevation, site.sharedAngle, false);
    }

    // Older files: anchor on the survey point (else the project base point), rotation from true north
    const anchor = site.surveyPoint ?? site.projectBasePoint;
    if (!anchor) { return null; }

    const angle = SiteCoordinates.chooseAngleSign(site, site.trueNorthAngle);
    const p = anchor.position, s = anchor.sharedPosition;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return new SharedTransform(s.x - (p.x * cos - p.y * sin), s.y - (p.x * sin + p.y * cos), s.z - p.z, angle, true);
  },

  /** The project base point (internal coordinates), or null. */
  tryGetProjectBase(site: SiteInfo | null): [number, number, number] | null {
    const p = site?.projectBasePoint?.position;
    return p ? [p.x, p.y, p.z] : null;
  },

  /** Picks the sign of the angle that best maps the base point onto the survey point (older files). */
  chooseAngleSign(site: SiteInfo | null, angle: number): number {
    if (!site?.surveyPoint || !site.projectBasePoint || Math.abs(angle) < 1e-9) { return angle; }
    const id = sub(site.projectBasePoint.position, site.surveyPoint.position);
    const sd = sub(site.projectBasePoint.sharedPosition, site.surveyPoint.sharedPosition);
    const length = Math.hypot(id[0], id[1]);
    if (length < 2) { return angle; }
    // The two candidates must land clearly apart (> 1 m) for the test to beat float noise on grid coordinates
    if (length * 2 * Math.abs(Math.sin(angle)) < 1) { return angle; }
    return misfit(id, sd, -angle) < misfit(id, sd, angle) ? -angle : angle;
  }
};

function sub(a: SitePoint['position'], b: SitePoint['position']): [number, number] {
  return [a.x - b.x, a.y - b.y];
}

function misfit(id: [number, number], sd: [number, number], angle: number): number {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return Math.abs(id[0] * cos - id[1] * sin - sd[0]) + Math.abs(id[0] * sin + id[1] * cos - sd[1]);
}
