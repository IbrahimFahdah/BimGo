import { EditOp, type EditRequest, type EditResult } from '../edits/EditMessages';
import type { SceneData } from '../scene/SceneData';

/** Where edits go: a .bimgo file (journal) or a live Revit session (port of IModelSource). */
export interface ModelSource {
  readonly displayName: string;
  readonly isRevit: boolean;
  readonly canEdit: boolean;
  /** Edits sent and not yet answered. */
  readonly pending: number;
  /** Sends an edit; returns its ticket, or −1 when refused up front. */
  submit(request: EditRequest): number;
  /** Takes the next answer, or null. */
  takeResult(): EditResult | null;
  pump(dt: number): void;
}

/**
 * Edits recorded in the file (port of BimGo.Core/Sources/FileEditSource.cs): every edit succeeds at once; removals
 * take hosted elements (doors, windows…) with them, as Revit would.
 */
export class FileEditSource implements ModelSource {
  private readonly results: EditResult[] = [];
  private readonly hosted = new Map<number, number[]>();
  private nextTicket = 0;

  readonly isRevit = false;
  readonly canEdit = true;
  readonly pending = 0;

  constructor(scene: SceneData, public displayName: string) {
    for (const record of scene.elements) {
      if (record.hostId <= 0 || record.link > 0) { continue; } // linked ids are another model's namespace
      const list = this.hosted.get(record.hostId);
      if (list) { list.push(record.elementId); } else { this.hosted.set(record.hostId, [record.elementId]); }
    }
  }

  submit(request: EditRequest): number {
    request.ticket = ++this.nextTicket;
    this.results.push({ ticket: request.ticket, op: request.op, success: true, affectedIds: this.affectedBy(request), cloneKey: request.newCloneKey });
    return request.ticket;
  }

  takeResult(): EditResult | null {
    return this.results.shift() ?? null;
  }

  pump(): void { /* immediate */ }

  affectedBy(request: EditRequest): number[] {
    const removal = request.op === EditOp.Delete || request.op === EditOp.PhaseDemolish;
    if (!removal || request.elementId <= 0) { return []; }
    const affected = [request.elementId];
    for (let i = 0; i < affected.length && i < 10_000; i++) {
      for (const id of this.hosted.get(affected[i]) ?? []) { affected.push(id); }
    }
    return [...new Set(affected)];
  }
}
