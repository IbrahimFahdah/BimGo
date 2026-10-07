import type { Vec3 } from '../math/Vector';

/** A linked Revit model in the scene (port of LinkInfo). */
export interface LinkInfo {
  /** 1-based number, assigned in file order when read. */
  index: number;
  name: string;
  title: string;
  instanceId: number;
  instanceUniqueId: string;
  modelKey: string;
  modelPath: string;
  originX: number;
  originY: number;
  originZ: number;
  basisX: Vec3;
  basisY: Vec3;
  basisZ: Vec3;
  phaseName: string | null;
  existingPhaseName: string | null;
  elementCount: number;
  roomCount: number;
}

/** The name shown for a link. */
export function linkLabel(link: LinkInfo): string {
  return link.title.trim() ? link.title : link.name.trim() ? link.name : `Link ${link.index}`;
}
