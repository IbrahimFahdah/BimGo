import type { Vec3 } from '../math/Vector';

/** Journal operation names (port of JournalOps). */
export const JournalOps = {
  HIDE: 'hide',
  TRANSFORM: 'transform',
  CLONE: 'clone',
  /** A new instance of a family type (the family library), placed at the pivot and turned by the angle. */
  PLACE: 'place',
  MODE_DEMOLISH: 'demolish',
  MODE_DELETE: 'delete'
} as const;

/** True for the ops that create a new instance with a clone key (clone, place). */
export function journalOpCreates(op: string): boolean {
  return op === JournalOps.CLONE || op === JournalOps.PLACE;
}

/** One recorded edit (the journal.json shape, camelCase). */
export interface JournalEntry {
  seq: number;
  op: string;
  mode: string | null;
  elementId: number;
  uniqueId: string;
  targetCloneKey: number;
  newCloneKey: number;
  /** Place: the family type's UniqueId (null otherwise, and not written). */
  typeUniqueId?: string | null;
  /** Place: the family type's ElementId value (0 otherwise, and not written). */
  typeId?: number;
  pivot: Vec3;
  offset: Vec3;
  angle: number;
  label: string;
  utc: string;
  user: string;
  appliedToRevit: boolean;
  revitElementId: number;
}

/**
 * The ordered list of edits with undo / redo (port of EditJournal.cs). Seq numbers are always 1..n in order.
 */
export class EditJournal {
  private readonly list: JournalEntry[] = [];
  // Undone entries, most recent last (redo pops from the end). Cleared by any new edit.
  private readonly redoList: JournalEntry[] = [];

  /** Bumped on every change (for "unsaved" tracking). */
  revision = 0;

  constructor(entries?: Iterable<JournalEntry | null>) {
    if (!entries) { return; }
    for (const entry of entries) {
      if (entry) { this.list.push(entry); }
    }
    this.renumber();
  }

  get entries(): readonly JournalEntry[] { return this.list; }
  get count(): number { return this.list.length; }
  get redoCount(): number { return this.redoList.length; }

  add(entry: JournalEntry): void {
    entry.seq = this.list.length + 1;
    this.list.push(entry);
    this.redoList.length = 0;
    this.revision++;
  }

  removeLast(): JournalEntry | null {
    const last = this.list.pop();
    if (!last) { return null; }
    this.redoList.push(last);
    this.revision++;
    return last;
  }

  redo(): JournalEntry | null {
    const entry = this.redoList.pop();
    if (!entry) { return null; }
    entry.seq = this.list.length + 1;
    this.list.push(entry);
    this.revision++;
    return entry;
  }

  peekRedo(): JournalEntry | null {
    return this.redoList.length === 0 ? null : this.redoList[this.redoList.length - 1];
  }

  maxCloneKey(): number {
    let max = 0;
    for (const e of this.list) { max = Math.max(max, e.newCloneKey, e.targetCloneKey); }
    // Undone clones keep their keys reserved, so a redo never collides with a clone made in between
    for (const e of this.redoList) { max = Math.max(max, e.newCloneKey, e.targetCloneKey); }
    return max;
  }

  countNotInRevit(): number {
    return this.list.filter(e => !e.appliedToRevit).length;
  }

  pendingForRevit(): JournalEntry[] {
    return this.list.filter(e => !e.appliedToRevit);
  }

  markApplied(seq: number, revitElementId: number): boolean {
    if (seq < 1 || seq > this.list.length) { return false; }
    const entry = this.list[seq - 1];
    if (entry.seq !== seq) { return false; }
    if (entry.appliedToRevit && (revitElementId <= 0 || entry.revitElementId === revitElementId)) { return false; }

    entry.appliedToRevit = true;
    if (revitElementId > 0) { entry.revitElementId = revitElementId; }
    this.revision++;
    return true;
  }

  private renumber(): void {
    this.list.forEach((e, i) => { e.seq = i + 1; });
  }
}
