import { linkOf, type SceneData } from '../scene/SceneData';
import type { ClashItem, ClashJob, ClashRunResult } from './ClashEngine';
import {
  clashKey, type ClashDocument, type ClashElementRef, ClashDefaults, type ClashRecord, ClashStatus, type ClashTest, elementRefKey, newClash
} from './ClashModels';
import { ClashGroups } from './ClashGroups';

/** What merging one run changed. */
export interface ClashMergeResult {
  found: number;
  new: number;
  reopened: number;
  newlyResolved: number;
}

/**
 * Turns a run's hits into clash records and merges them into the document (port of BimGo.Core/Clashes/ClashMerge.cs):
 * a clash is the same clash in a later run when its test and element pair match. Found again: new → active, resolved →
 * active; reviewed / approved stay. Missing from a complete run: resolved. A truncated run resolves nothing.
 * Assignee, notes and comment links always stay.
 */
export const ClashMerge = {
  /** A record per hit (points in Revit internal metres; the element pair as stable references). */
  toRecords(job: ClashJob, result: ClashRunResult, testId: string): ClashRecord[] {
    const scene = job.scene, o = scene.originOffset;
    return result.hits.map(hit => {
      const record = newClash(testId, ClashMerge.refOf(scene, job.items[hit.itemA]), ClashMerge.refOf(scene, job.items[hit.itemB]));
      record.x = hit.point.x + o.x;
      record.y = hit.point.y + o.y;
      record.z = hit.point.z + o.z;
      record.distance = hit.distance;
      record.crossing = hit.crossing;
      record.approximate = hit.approximate;
      // Self tests: a stable order inside the pair, so the record reads the same run after run
      if (job.setB === null && elementRefKey(record.a) > elementRefKey(record.b)) { [record.a, record.b] = [record.b, record.a]; }
      return record;
    });
  },

  /** A model element's key as clashes store it (link + UniqueId, or ElementId): lets the app find a clash's elements again. */
  elementKey(scene: SceneData, element: number): string {
    const e = scene.elements[element];
    return linkKey(scene, element) + '/' + (e.uniqueId ? e.uniqueId : 'id:' + e.elementId);
  },

  /** The stable reference to an item's element. */
  refOf(scene: SceneData, item: ClashItem): ClashElementRef {
    const e = scene.elements[item.element];
    const clone = item.cloneKey > 0;
    return {
      uniqueId: clone ? '' : e.uniqueId ?? '',
      elementId: clone ? 0 : e.elementId,
      link: linkKey(scene, item.element),
      cloneKey: item.cloneKey,
      ifcGuid: clone || !e.ifcGuid ? null : e.ifcGuid,
      category: e.categoryName ?? '',
      familyType: e.familyType ?? '',
      level: e.levelName ?? ''
    };
  },

  /**
   * Merges a finished run of a test into the document and records it in the history.
   * @param complete False when the run stopped at the limit (nothing is resolved then).
   * @param modelState The model state stamp (for "model changed since the last run").
   */
  apply(document: ClashDocument, test: ClashTest, found: readonly ClashRecord[], complete: boolean, utc: string, modelState: string,
    countA: number, countB: number, seconds: number, user = ''): ClashMergeResult {
    const existing = new Map<string, ClashRecord>();
    for (const clash of document.clashes) {
      if (clash.testId === test.id && !existing.has(clashKey(clash))) { existing.set(clashKey(clash), clash); }
    }

    const seen = new Set<string>();
    let added = 0, reopened = 0;
    for (const record of found) {
      record.testId = test.id; // the key includes the test: set it before matching
      const key = clashKey(record);
      if (seen.has(key)) { continue; }
      seen.add(key);
      const known = existing.get(key);
      if (known) {
        known.a = record.a;
        known.b = record.b;
        known.x = record.x;
        known.y = record.y;
        known.z = record.z;
        known.distance = record.distance;
        known.crossing = record.crossing;
        known.approximate = record.approximate;
        known.lastSeenUtc = utc;
        if (known.status === ClashStatus.RESOLVED) {
          known.status = ClashStatus.ACTIVE;
          known.resolvedUtc = null;
          reopened++;
        } else if (known.status === ClashStatus.NEW) {
          known.status = ClashStatus.ACTIVE;
        }
        continue;
      }
      record.status = ClashStatus.NEW;
      record.foundUtc = utc;
      record.lastSeenUtc = utc;
      document.clashes.push(record);
      added++;
    }

    let resolved = 0;
    if (complete) {
      for (const [key, clash] of existing) {
        if (seen.has(key) || clash.status === ClashStatus.RESOLVED) { continue; }
        clash.status = ClashStatus.RESOLVED;
        clash.resolvedUtc = utc;
        resolved++;
      }
    }

    ClashGroups.followRun(document, test.id); // C-C1: all members resolved → the group too; one back → active

    test.lastRunUtc = utc;
    test.lastRunModel = modelState;
    test.lastRunTruncated = !complete;

    document.runs.push({
      utc, testId: test.id, user, found: seen.size, new: added, newlyResolved: resolved, byStatus: ClashMerge.countByStatus(document, test.id),
      elementsA: countA, elementsB: countB, seconds: Math.round(seconds * 100) / 100, truncated: !complete
    });
    if (document.runs.length > ClashDefaults.MAX_RUNS) { document.runs.splice(0, document.runs.length - ClashDefaults.MAX_RUNS); }
    return { found: seen.size, new: added, reopened, newlyResolved: resolved };
  },

  /** A test's clashes per status (ClashStatus.ALL order). */
  countByStatus(document: ClashDocument, testId: string): number[] {
    const counts = new Array<number>(ClashStatus.ALL.length).fill(0);
    for (const clash of document.clashes) { if (clash.testId === testId) { counts[ClashStatus.indexOf(clash.status)]++; } }
    return counts;
  },

  /** A person changes a clash's status (stamped, so report imports keep the newer change). */
  setStatus(clash: ClashRecord, status: string, user: string, utc: string): void {
    clash.status = ClashStatus.normalise(status);
    if (clash.status !== ClashStatus.RESOLVED) { clash.resolvedUtc = null; }
    clash.updated = utc;
    clash.updatedBy = user;
  },

  /** A person changes the assignee or notes (null leaves that one alone; empty clears it). */
  setDetails(clash: ClashRecord, assignedTo: string | null, notes: string | null, user: string, utc: string): void {
    if (assignedTo !== null) { clash.assignedTo = assignedTo.length === 0 ? null : assignedTo; }
    if (notes !== null) { clash.notes = notes.length === 0 ? null : notes; }
    clash.updated = utc;
    clash.updatedBy = user;
  },

  /** RESET RESULTS: keeps the test but drops its clashes and history; the next run starts fresh. Returns how many went. */
  resetTest(document: ClashDocument, test: ClashTest): number {
    const before = document.clashes.length;
    document.clashes = document.clashes.filter(c => c.testId !== test.id);
    document.runs = document.runs.filter(r => r.testId !== test.id);
    ClashGroups.removeTest(document, test.id); // C-C1: its groups go with its clashes
    test.lastRunUtc = null;
    test.lastRunModel = null;
    test.lastRunTruncated = false;
    return before - document.clashes.length;
  },

  /** True when a test has results: it has run, or has clashes. */
  hasResults(document: ClashDocument, test: ClashTest): boolean {
    return test.lastRunUtc !== null || document.clashes.some(c => c.testId === test.id);
  },

  /** Removes a test and its clashes and history (its sets stay). */
  removeTest(document: ClashDocument, testId: string): void {
    document.tests = document.tests.filter(t => t.id !== testId);
    document.clashes = document.clashes.filter(c => c.testId !== testId);
    document.runs = document.runs.filter(r => r.testId !== testId);
    ClashGroups.removeTest(document, testId); // C-C1
  }
};

/** The link part of an element's key: empty for the host, else the link instance's UniqueId. */
function linkKey(scene: SceneData, element: number): string {
  const e = scene.elements[element];
  const link = linkOf(scene, e);
  return link ? (link.instanceUniqueId ? link.instanceUniqueId : 'link:' + link.index) : e.link > 0 ? 'link:' + e.link : '';
}
