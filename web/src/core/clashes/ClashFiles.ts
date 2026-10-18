import type { Json } from '../format/Json';
import {
  CLASH_FORMAT, CLASH_REPORT_FORMAT, CLASH_VERSION, cleanClashDocument, clashDocumentJson, clashKey, type ClashDocument, type ClashRecord,
  findSet, findTest, normaliseSetRules, readClashDocument
} from './ClashModels';
import { ClashGroups } from './ClashGroups';
import { newId } from '../format/Json';

/** What importing a report changed. */
export interface ClashImportResult {
  setsAdded: number;
  testsAdded: number;
  clashesAdded: number;
  clashesUpdated: number;
  unchanged: number;
  sameModel: boolean;
  /** C-C1: groups added. */
  groupsAdded: number;
}

/**
 * Clash storage (port of BimGo.Core/Clashes/ClashFiles.cs): clashes.json inside a .bimgo (kept as raw bytes until clash
 * detection is switched on, so a file opened without it costs nothing), and EXPORT / IMPORT REPORT (the same JSON,
 * readable, with a header). Never throws: failures come back as an error text.
 */
export const ClashFiles = {
  FORMAT: CLASH_FORMAT,
  REPORT_FORMAT: CLASH_REPORT_FORMAT,
  VERSION: CLASH_VERSION,

  /** Reads a stored document or a report from JSON bytes (cleaned), or an error. */
  parse(bytes: Uint8Array | string | null): { document: ClashDocument | null; error: string | null } {
    if (bytes === null || bytes.length === 0) { return { document: null, error: null }; }
    let raw: unknown;
    try {
      raw = JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
    } catch (e) {
      return { document: null, error: `The clash data could not be read: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return { document: null, error: 'The clash data is empty.' }; }
    const document = readClashDocument(raw as Json);
    const format = document.format.toLowerCase();
    if (format !== CLASH_FORMAT && format !== CLASH_REPORT_FORMAT) { return { document: null, error: 'This is not BimGo clash data.' }; }
    if (document.version > CLASH_VERSION) {
      return { document: null, error: `This clash data was made by a newer BimGo (version ${document.version}). Please update BimGo.` };
    }
    return { document: cleanClashDocument(document), error: null };
  },

  /** The stored form (compact JSON bytes; header fields left out). */
  serialize(document: ClashDocument): Uint8Array {
    document.format = CLASH_FORMAT;
    document.version = CLASH_VERSION;
    document.modelTitle = null;
    document.modelKey = null;
    document.generator = null;
    document.exportedUtc = null;
    for (const set of document.sets) { normaliseSetRules(set); }
    return new TextEncoder().encode(JSON.stringify(clashDocumentJson(document)));
  },

  /** A report: the whole document as readable JSON with a header. */
  exportReport(document: ClashDocument, modelTitle: string, modelKey: string | null, generator: string): string {
    const copy = ClashFiles.parse(ClashFiles.serialize(document)).document!;
    copy.format = CLASH_REPORT_FORMAT;
    copy.modelTitle = modelTitle;
    copy.modelKey = modelKey;
    copy.generator = generator;
    copy.exportedUtc = new Date().toISOString();
    return JSON.stringify(clashDocumentJson(copy), null, 2);
  },

  /**
   * Merges one clash document into another: missing sets and tests are added; clashes matched by test + element pair
   * take the report's status, assignee and notes when its change is newer; other clashes are added; history merged.
   */
  merge(from: ClashDocument, into: ClashDocument, modelKey: string | null): ClashImportResult {
    let setsAdded = 0, testsAdded = 0, added = 0, updated = 0, unchanged = 0;
    for (const set of from.sets) {
      if (findSet(into, set.id)) { continue; }
      into.sets.push(set);
      setsAdded++;
    }
    for (const test of from.tests) {
      if (findTest(into, test.id)) { continue; }
      into.tests.push(test);
      testsAdded++;
    }

    const ours = new Map<string, ClashRecord>();
    for (const clash of into.clashes) { if (!ours.has(clashKey(clash))) { ours.set(clashKey(clash), clash); } }
    const oursById = new Set(into.clashes.map(c => c.id));
    const theirToOurs = new Map<string, string>(); // C-C1: group members by clash
    for (const theirs of from.clashes) {
      const key = clashKey(theirs);
      const mine = ours.get(key);
      if (!mine) {
        const theirId = theirs.id;
        if (oursById.has(theirs.id)) { theirs.id = newId(); } // an id we use for another pair
        oursById.add(theirs.id);
        into.clashes.push(theirs);
        ours.set(key, theirs);
        theirToOurs.set(theirId, theirs.id);
        added++;
        continue;
      }
      theirToOurs.set(theirs.id, mine.id);
      const newer = theirs.updated !== null && (mine.updated === null || Date.parse(theirs.updated) > Date.parse(mine.updated));
      if (!newer && (mine.commentId !== null || theirs.commentId === null)) {
        unchanged++;
        continue;
      }
      if (newer) {
        mine.status = theirs.status;
        mine.assignedTo = theirs.assignedTo;
        mine.notes = theirs.notes;
        mine.updated = theirs.updated;
        mine.updatedBy = theirs.updatedBy;
        mine.resolvedUtc = theirs.resolvedUtc;
      }
      mine.commentId ??= theirs.commentId;
      updated++;
    }

    const runs = new Set(into.runs.map(r => `${Date.parse(r.utc)}|${r.testId}`));
    for (const run of from.runs) {
      const key = `${Date.parse(run.utc)}|${run.testId}`;
      if (!runs.has(key)) {
        runs.add(key);
        into.runs.push(run);
      }
    }
    into.runs.sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc));
    const groupsAdded = ClashGroups.mergeFrom(from, into, theirToOurs); // C-C1
    cleanClashDocument(into);

    const sameModel = !from.modelKey || !modelKey || from.modelKey.toLowerCase() === modelKey.toLowerCase();
    return { setsAdded, testsAdded, clashesAdded: added, clashesUpdated: updated, unchanged, sameModel, groupsAdded };
  }
};
