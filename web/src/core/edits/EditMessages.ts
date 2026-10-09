import type { Vec3 } from '../math/Vector';

/** What an edit does (port of EditOp). */
export enum EditOp {
  /** Set the element's demolished phase (stays in the model). */
  PhaseDemolish,
  /** Remove the element. */
  Delete,
  /** Move and / or rotate about Z. */
  Transform,
  /** Copy, then move / rotate the copy. */
  Copy,
  /**
   * Place a new instance of a family type (the family library) at the pivot, turned by the angle. Additive to
   * protocol 1: an older add-in can't read it (the viewer times out).
   */
  Place
}

/** An edit sent to the model source (port of EditRequest). Positions in Revit internal coordinates. */
export interface EditRequest {
  ticket?: number;
  op: EditOp;
  elementId: number;
  targetCloneKey?: number;
  newCloneKey?: number;
  /** Place: the family type's UniqueId. */
  typeUniqueId?: string;
  /** Place: the family type's ElementId value (fallback). */
  typeId?: number;
  /** Rotation pivot; for Place, where the new instance's location point goes. */
  pivot?: Vec3;
  translation?: Vec3;
  angle?: number;
  label: string;
}

/** The source's answer (port of EditResult). */
export interface EditResult {
  ticket: number;
  op: EditOp;
  success: boolean;
  message?: string;
  /** Ids removed with the target (hosted doors, windows…). */
  affectedIds: number[];
  newElementId?: number;
  cloneKey?: number;
}
