import { bool, isBlank, type Json, newId, num, objOrNull, str } from '../format/Json';
import { type GridLocation, gridLocationText } from '../scene/GridData';
import { ClashMerge } from './ClashMerge';
import {
  type ClashDocument, type ClashElementRef, type ClashRecord, ClashStatus, date, elementRefKey, readRef, refJson
} from './ClashModels';

/** How a group was made (Round C-C): null by hand, or the automatic method that made it. */
export const ClashGroupAuto = {
  ELEMENT: 'element',
  LEVEL: 'level',
  CATEGORY: 'category',
  LEVEL_CATEGORY: 'levelCategory',
  /** Grids round B: the nearest grid intersection, every level ("Near C-4"). */
  GRID: 'grid',
  /** Grids round B: grid and level ("Near C-4 : Level 2"). */
  GRID_LEVEL: 'gridLevel'
} as const;

/**
 * A group's box (C-C2, GROUP BY BOX…): axis-aligned, Revit internal metres. A clash is in it when its clash point is
 * (faces included); fullHeight ignores the heights (a plan rectangle).
 */
export interface ClashGroupBox {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  fullHeight: boolean;
}

export const GroupBox = {
  contains: (b: ClashGroupBox, x: number, y: number, z: number): boolean =>
    x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && (b.fullHeight || (z >= b.minZ && z <= b.maxZ)),
  containsClash: (b: ClashGroupBox, c: ClashRecord | null): boolean => !!c && GroupBox.contains(b, c.x, c.y, c.z),
  isValid: (b: ClashGroupBox): boolean =>
    [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ].every(Number.isFinite),
  normalise(b: ClashGroupBox): ClashGroupBox {
    if (b.minX > b.maxX) { [b.minX, b.maxX] = [b.maxX, b.minX]; }
    if (b.minY > b.maxY) { [b.minY, b.maxY] = [b.maxY, b.minY]; }
    if (b.minZ > b.maxZ) { [b.minZ, b.maxZ] = [b.maxZ, b.minZ]; }
    return b;
  },
  copy: (b: ClashGroupBox): ClashGroupBox => ({ ...b }),
  union: (a: ClashGroupBox, b: ClashGroupBox): ClashGroupBox => ({
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ),
    fullHeight: a.fullHeight || b.fullHeight
  })
};

/**
 * A clash group (Round C-C1; Navisworks style): clashes of one test reviewed together, with its own status, assignee
 * and notes, and one comment / BCF topic for them all. A clash is in at most one group; clashIds is the single source
 * of truth for membership.
 */
export interface ClashGroup {
  id: string;
  testId: string;
  /** The name people gave it, or null (it then reads from keyElement / autoLabel and the member count). */
  name: string | null;
  status: string;
  assignedTo: string | null;
  notes: string | null;
  commentId: string | null;
  clashIds: string[];
  /** How it was made: null by hand, else ClashGroupAuto. */
  auto: string | null;
  /** The element every member shares (by-element groups and GROUP ALL ON), or null. */
  keyElement: ClashElementRef | null;
  /** C-C2: what the members share when it isn't one element ("Level 2", "Cluster 3 · Level 2"), or null. */
  autoLabel: string | null;
  /** C-C2: the box it was made from, or null. */
  box: ClashGroupBox | null;
  createdUtc: string;
  updated: string | null;
  updatedBy: string | null;
}

/** A group's members by status, worked out for display. */
export interface ClashGroupSummary { members: number; found: number; mixed: boolean; byStatus: number[] }

function newGroup(testId: string): ClashGroup {
  return {
    id: newId(), testId, name: null, status: ClashStatus.NEW, assignedTo: null, notes: null, commentId: null, clashIds: [], auto: null,
    keyElement: null, autoLabel: null, box: null, createdUtc: new Date().toISOString(), updated: null, updatedBy: null
  };
}

/** What an automatic name reads from ("e:<key>", "a:<label>"), or null. */
function basisOf(g: ClashGroup): string | null {
  return g.keyElement ? 'e:' + elementRefKey(g.keyElement) : !isBlank(g.autoLabel) ? 'a:' + g.autoLabel : null;
}

function stamp(group: ClashGroup, user: string, utc: string): void {
  group.updated = utc;
  group.updatedBy = user;
}

/** The clashes once each, of one test (null: any). */
function distinct(clashes: Iterable<ClashRecord> | null, testId: string | null): ClashRecord[] {
  const seen = new Set<string>();
  const list: ClashRecord[] = [];
  for (const clash of clashes ?? []) {
    if (!clash || (testId !== null && clash.testId !== testId) || seen.has(clash.id)) { continue; }
    seen.add(clash.id);
    list.push(clash);
  }
  return list;
}

/** Takes clashes out of their groups (except keep), removing groups left empty. Returns how many left a group. */
function detach(document: ClashDocument, clashes: ClashRecord[], keep: ClashGroup | null = null): number {
  if (!document.groups || clashes.length === 0) { return 0; }
  const ids = new Set(clashes.map(c => c.id));
  let removed = 0;
  for (const group of document.groups) {
    if (group === keep) { continue; }
    const before = group.clashIds.length;
    group.clashIds = group.clashIds.filter(id => !ids.has(id));
    removed += before - group.clashIds.length;
  }
  document.groups = document.groups.filter(g => g === keep || g.clashIds.length > 0);
  if (document.groups.length === 0) { document.groups = null; }
  return removed;
}

/**
 * Clash group operations (port of ClashGroups). Every change keeps one group per clash: a clash joining a group leaves
 * the one it was in, and a group left with no members is removed.
 */
export const ClashGroups = {
  /** Clash id → its group. */
  index(document: ClashDocument | null): Map<string, ClashGroup> {
    const index = new Map<string, ClashGroup>();
    for (const group of document?.groups ?? []) {
      for (const id of group.clashIds) { if (!index.has(id)) { index.set(id, group); } }
    }
    return index;
  },

  /** Clash id → clash. */
  clashesById(document: ClashDocument | null): Map<string, ClashRecord> {
    const byId = new Map<string, ClashRecord>();
    for (const clash of document?.clashes ?? []) { if (!byId.has(clash.id)) { byId.set(clash.id, clash); } }
    return byId;
  },

  find(document: ClashDocument | null, id: string | null): ClashGroup | null {
    if (!document?.groups || !id) { return null; }
    return document.groups.find(g => g.id === id) ?? null;
  },

  ofTest(document: ClashDocument | null, testId: string): ClashGroup[] {
    return (document?.groups ?? []).filter(g => g.testId === testId);
  },

  /** A group's members still in the document, in member order. */
  members(group: ClashGroup | null, byId: ReadonlyMap<string, ClashRecord>): ClashRecord[] {
    const members: ClashRecord[] = [];
    for (const id of group?.clashIds ?? []) {
      const clash = byId.get(id);
      if (clash) { members.push(clash); }
    }
    return members;
  },

  summarise(group: ClashGroup, byId: ReadonlyMap<string, ClashRecord>): ClashGroupSummary {
    const counts = new Array<number>(ClashStatus.ALL.length).fill(0);
    let found = 0, mixed = false;
    const status = ClashStatus.normalise(group.status);
    for (const id of group.clashIds) {
      const clash = byId.get(id);
      if (!clash) { continue; }
      found++;
      counts[ClashStatus.indexOf(clash.status)]++;
      if (clash.status !== status) { mixed = true; }
    }
    return { members: group.clashIds.length, found, mixed, byStatus: counts };
  },

  /** The name a group shows: its own, else from its key element or auto label with the member count, else "Group". */
  displayName(group: ClashGroup | null): string {
    if (!group) { return ''; }
    if (!isBlank(group.name)) { return group.name!; }
    const count = group.clashIds.length;
    const clashes = ` × ${count} clash${count === 1 ? '' : 'es'}`;
    if (group.keyElement) { return ClashGroups.elementName(group.keyElement) + clashes; }
    if (!isBlank(group.autoLabel)) { return group.autoLabel!.trim() + clashes; }
    return 'Group';
  },

  /** True when the name reads from keyElement or autoLabel (nobody named it). */
  hasAutoName: (g: ClashGroup): boolean => g.name === null && (g.keyElement !== null || !isBlank(g.autoLabel)),

  /** "Rectangular Duct: 600x300 (123456)". */
  elementName(element: ClashElementRef | null): string {
    if (!element) { return 'Element'; }
    const name = !isBlank(element.familyType) ? element.familyType.trim() : !isBlank(element.category) ? element.category.trim() : 'Element';
    const id = element.cloneKey > 0 ? 'clone ' + element.cloneKey : element.elementId > 0 ? String(element.elementId) : null;
    return id === null ? name : `${name} (${id})`;
  },

  /** "Group N" with the next free number in the test. */
  nextName(document: ClashDocument | null, testId: string): string {
    let next = 1;
    for (const group of ClashGroups.ofTest(document, testId)) {
      const m = group.name ? /^Group (\d+)$/.exec(group.name) : null;
      if (m) { next = Math.max(next, Number(m[1]) + 1); }
    }
    return 'Group ' + next;
  },

  /** The element every clash shares (A or B side), or null. */
  commonElement(clashes: readonly ClashRecord[]): ClashElementRef | null {
    if (!clashes || clashes.length === 0) { return null; }
    for (const candidate of [clashes[0].a, clashes[0].b]) {
      const key = elementRefKey(candidate);
      if (clashes.every(c => elementRefKey(c.a) === key || elementRefKey(c.b) === key)) { return candidate; }
    }
    return null;
  },

  /**
   * Makes a group of clashes (only those of testId; each leaves the group it was in). Its status starts as the least
   * advanced of the members', its assignee as theirs when they all share one. Returns the group (null when none was
   * given) and how many came out of other groups.
   */
  create(document: ClashDocument | null, testId: string, clashes: Iterable<ClashRecord>, name: string | null, keyElement: ClashElementRef | null,
    autoLabel: string | null, auto: string | null, user: string, utc: string): { group: ClashGroup | null; moved: number } {
    autoLabel = isBlank(autoLabel) ? null : autoLabel!.trim();
    const members = distinct(clashes, testId);
    if (!document || members.length === 0) { return { group: null, moved: 0 }; }
    const moved = detach(document, members);
    let least = ClashStatus.ALL.length - 1;
    let assignee = members[0].assignedTo;
    for (const clash of members) {
      least = Math.min(least, ClashStatus.indexOf(clash.status));
      if (clash.assignedTo !== assignee) { assignee = null; }
    }
    const group = newGroup(testId);
    group.name = isBlank(name) ? (keyElement === null && autoLabel === null ? ClashGroups.nextName(document, testId) : null) : name!.trim();
    group.status = ClashStatus.ALL[least];
    group.assignedTo = isBlank(assignee) ? null : assignee;
    group.auto = auto;
    group.keyElement = keyElement;
    group.autoLabel = autoLabel;
    group.createdUtc = utc;
    group.clashIds = members.map(c => c.id);
    if (auto === null) { stamp(group, user, utc); }
    (document.groups ??= []).push(group);
    return { group, moved };
  },

  /** Adds clashes (of the group's test) to a group; returns how many joined and how many came out of other groups. */
  addTo(document: ClashDocument | null, group: ClashGroup | null, clashes: Iterable<ClashRecord>, user: string, utc: string): { added: number; moved: number } {
    if (!document || !group) { return { added: 0, moved: 0 }; }
    const have = new Set(group.clashIds);
    const joining = distinct(clashes, group.testId).filter(c => !have.has(c.id));
    if (joining.length === 0) { return { added: 0, moved: 0 }; }
    const moved = detach(document, joining, group);
    for (const clash of joining) { group.clashIds.push(clash.id); }
    stamp(group, user, utc);
    return { added: joining.length, moved };
  },

  /** Takes clashes out of whatever group they are in; returns how many left a group. */
  remove(document: ClashDocument | null, clashes: Iterable<ClashRecord>): number {
    return document ? detach(document, distinct(clashes, null)) : 0;
  },

  /** UNGROUP: the group goes; its clashes stay, ungrouped. */
  ungroup(document: ClashDocument | null, group: ClashGroup | null): boolean {
    if (!document?.groups || !group) { return false; }
    const i = document.groups.indexOf(group);
    if (i < 0) { return false; }
    document.groups.splice(i, 1);
    if (document.groups.length === 0) { document.groups = null; }
    return true;
  },

  /** MERGE GROUPS: the first group takes every other's members; the others' notes are added under their names. */
  merge(document: ClashDocument | null, groups: readonly ClashGroup[], user: string, utc: string): ClashGroup | null {
    if (!document?.groups || !groups || groups.length < 2) { return null; }
    const first = groups[0];
    const have = new Set(first.clashIds);
    const notes: string[] = [];
    if (!isBlank(first.notes)) { notes.push(first.notes!.trim()); }
    let otherBasis = false;
    let allBoxes = first.box !== null;
    let box = first.box ? GroupBox.copy(first.box) : null;
    for (let i = 1; i < groups.length; i++) {
      const other = groups[i];
      if (!other || other === first || other.testId !== first.testId) { continue; }
      for (const id of other.clashIds) {
        if (!have.has(id)) { have.add(id); first.clashIds.push(id); }
      }
      if (!isBlank(other.notes)) { notes.push(`${ClashGroups.displayName(other)}: ${other.notes!.trim()}`); }
      otherBasis ||= basisOf(first) === null || basisOf(other) !== basisOf(first);
      if (!other.box) { allBoxes = false; } else if (box) { box = GroupBox.union(box, other.box); }
      const at = document.groups.indexOf(other);
      if (at >= 0) { document.groups.splice(at, 1); }
    }
    if (first.name === null && otherBasis) {
      first.name = ClashGroups.displayName(first);
      first.keyElement = null;
      first.autoLabel = null;
    }
    first.box = allBoxes ? box : null;
    first.auto = null;
    first.notes = notes.length === 0 ? null : notes.join('\n');
    stamp(first, user, utc);
    return first;
  },

  /** RENAME…: an empty name goes back to the automatic one (or "Group N"). */
  rename(document: ClashDocument | null, group: ClashGroup | null, name: string, user: string, utc: string): void {
    if (!group) { return; }
    const automatic = group.keyElement !== null || !isBlank(group.autoLabel);
    group.name = isBlank(name) ? (automatic ? null : ClashGroups.nextName(document, group.testId)) : name.trim();
    stamp(group, user, utc);
  },

  /** C-C2: the group's box (null clears; stamped). */
  setBox(group: ClashGroup | null, box: ClashGroupBox | null, user: string, utc: string): void {
    if (!group) { return; }
    group.box = box ? GroupBox.normalise(GroupBox.copy(box)) : null;
    stamp(group, user, utc);
  },

  /**
   * C-C2, RECOLLECT / EDIT BOX…: against the group's box (or `box`), the test's unresolved clashes inside it that
   * aren't members yet, and the members whose clash point is now outside it. Null when there is no box.
   */
  boxSplit(document: ClashDocument | null, group: ClashGroup | null, box: ClashGroupBox | null): { joining: ClashRecord[]; outside: ClashRecord[] } | null {
    box ??= group?.box ?? null;
    if (!document || !group || !box) { return null; }
    const members = new Set(group.clashIds);
    const joining = document.clashes.filter(c => c.testId === group.testId && !members.has(c.id) && c.status !== ClashStatus.RESOLVED
      && GroupBox.containsClash(box!, c));
    const outside = ClashGroups.members(group, ClashGroups.clashesById(document)).filter(c => !GroupBox.containsClash(box!, c));
    return { joining, outside };
  },

  /** The group's status, and every member's (stamped). Returns the members whose status changed. */
  setStatus(group: ClashGroup | null, status: string, byId: ReadonlyMap<string, ClashRecord>, user: string, utc: string): ClashRecord[] {
    const changed: ClashRecord[] = [];
    if (!group) { return changed; }
    status = ClashStatus.normalise(status);
    group.status = status;
    stamp(group, user, utc);
    for (const clash of ClashGroups.members(group, byId)) {
      if (clash.status === status) { continue; }
      ClashMerge.setStatus(clash, status, user, utc);
      changed.push(clash);
    }
    return changed;
  },

  /** ASSIGN… on a group: the group's and every member's assignee (empty clears). Returns the members. */
  setAssignee(group: ClashGroup | null, assignedTo: string | null, byId: ReadonlyMap<string, ClashRecord>, user: string, utc: string): ClashRecord[] {
    if (!group) { return []; }
    const text = (assignedTo ?? '').trim();
    group.assignedTo = text.length === 0 ? null : text;
    stamp(group, user, utc);
    const members = ClashGroups.members(group, byId);
    for (const clash of members) { ClashMerge.setDetails(clash, group.assignedTo ?? '', null, user, utc); }
    return members;
  },

  /** NOTES… on a group: the group's own notes (empty clears). */
  setNotes(group: ClashGroup | null, notes: string | null, user: string, utc: string): void {
    if (!group) { return; }
    group.notes = isBlank(notes) ? null : notes!.trim();
    stamp(group, user, utc);
  },

  /** After a run: all members resolved → the group resolved; a resolved group with a member back → active. */
  followRun(document: ClashDocument | null, testId: string): ClashGroup[] {
    const changed: ClashGroup[] = [];
    if (!document?.groups) { return changed; }
    let byId: Map<string, ClashRecord> | null = null;
    for (const group of document.groups) {
      if (group.testId !== testId) { continue; }
      byId ??= ClashGroups.clashesById(document);
      let any = false, allResolved = true;
      for (const id of group.clashIds) {
        const clash = byId.get(id);
        if (!clash) { continue; }
        any = true;
        if (clash.status !== ClashStatus.RESOLVED) { allResolved = false; }
      }
      if (!any) { continue; }
      if (allResolved && group.status !== ClashStatus.RESOLVED) {
        group.status = ClashStatus.RESOLVED;
        changed.push(group);
      } else if (!allResolved && group.status === ClashStatus.RESOLVED) {
        group.status = ClashStatus.ACTIVE;
        changed.push(group);
      }
    }
    return changed;
  },

  /** Removes a test's groups (reset or delete of the test). */
  removeTest(document: ClashDocument | null, testId: string): number {
    if (!document?.groups) { return 0; }
    const before = document.groups.length;
    document.groups = document.groups.filter(g => g.testId !== testId);
    const removed = before - document.groups.length;
    if (document.groups.length === 0) { document.groups = null; }
    return removed;
  },

  /**
   * Merges a report's groups (after its clashes): a group we have takes the report's fields when its change is newer;
   * members join only when not already in one of our groups; groups we don't have are added. Returns groups added.
   */
  mergeFrom(from: ClashDocument, into: ClashDocument, theirClashToOurs: ReadonlyMap<string, string>): number {
    if (!from.groups || from.groups.length === 0) { return 0; }
    const index = ClashGroups.index(into);
    let added = 0;
    for (const theirs of from.groups) {
      const ids: string[] = [];
      for (const id of theirs.clashIds) {
        const ours = theirClashToOurs.get(id);
        if (ours !== undefined && !index.has(ours)) { ids.push(ours); }
      }
      const mine = ClashGroups.find(into, theirs.id);
      if (mine) {
        const newer = theirs.updated !== null && (mine.updated === null || Date.parse(theirs.updated) > Date.parse(mine.updated));
        if (newer) {
          mine.name = theirs.name;
          mine.status = theirs.status;
          mine.assignedTo = theirs.assignedTo;
          mine.notes = theirs.notes;
          mine.autoLabel = theirs.autoLabel ?? mine.autoLabel;
          mine.box = theirs.box ? GroupBox.copy(theirs.box) : mine.box;
          mine.updated = theirs.updated;
          mine.updatedBy = theirs.updatedBy;
        }
        mine.commentId ??= theirs.commentId;
        for (const id of ids) {
          mine.clashIds.push(id);
          index.set(id, mine);
        }
        continue;
      }
      if (ids.length === 0) { continue; }
      theirs.clashIds = ids;
      (into.groups ??= []).push(theirs);
      for (const id of ids) { index.set(id, theirs); }
      added++;
    }
    return added;
  }
};

/**
 * Repairs groups (called by cleanClashDocument): drops null groups, members that aren't clashes of the group's test, a
 * clash's later memberships and groups left with none; fixes missing / duplicate ids and unknown statuses.
 */
export function cleanClashGroups(document: ClashDocument): void {
  if (!document.groups) { return; }
  const testOf = new Map<string, string>();
  for (const clash of document.clashes) { if (!testOf.has(clash.id)) { testOf.set(clash.id, clash.testId); } }
  const groupIds = new Set<string>();
  const taken = new Set<string>();
  const kept: ClashGroup[] = [];
  for (const group of document.groups) {
    if (!group || !group.testId) { continue; }
    if (isBlank(group.id) || groupIds.has(group.id)) { group.id = newId(); }
    groupIds.add(group.id);
    group.status = ClashStatus.normalise(group.status);
    if (isBlank(group.name)) { group.name = null; }
    if (isBlank(group.autoLabel)) { group.autoLabel = null; }
    if (group.box) { group.box = GroupBox.isValid(group.box) ? GroupBox.normalise(group.box) : null; }
    if (group.keyElement) {
      group.keyElement.link ??= '';
      group.keyElement.uniqueId ??= '';
    }
    const members: string[] = [];
    for (const id of group.clashIds ?? []) {
      if (typeof id !== 'string' || testOf.get(id) !== group.testId || taken.has(id)) { continue; }
      taken.add(id);
      members.push(id);
    }
    group.clashIds = members;
    if (members.length > 0) { kept.push(group); }
  }
  document.groups = kept.length === 0 ? null : kept;
}

function readBox(v: unknown): ClashGroupBox | null {
  const j = objOrNull(v);
  if (!j) { return null; }
  return {
    minX: num(j.minX, NaN), minY: num(j.minY, NaN), minZ: num(j.minZ, NaN), maxX: num(j.maxX, NaN), maxY: num(j.maxY, NaN), maxZ: num(j.maxZ, NaN),
    fullHeight: bool(j.fullHeight)
  };
}

/** A group from parsed JSON (cleaned with the document). */
export function readClashGroup(j: Json): ClashGroup {
  return {
    id: str(j.id, ''),
    testId: str(j.testId, ''),
    name: str(j.name, null),
    status: str(j.status, ClashStatus.NEW),
    assignedTo: str(j.assignedTo, null),
    notes: str(j.notes, null),
    commentId: str(j.commentId, null),
    clashIds: Array.isArray(j.clashIds) ? j.clashIds.filter((id): id is string => typeof id === 'string') : [],
    auto: str(j.auto, null),
    keyElement: readRef(j.keyElement),
    autoLabel: str(j.autoLabel, null),
    box: readBox(j.box),
    createdUtc: date(j.createdUtc) ?? new Date().toISOString(),
    updated: date(j.updated),
    updatedBy: str(j.updatedBy, null)
  };
}

/** A group as JSON-ready members in the desktop's order (nulls dropped by the document writer). */
export function clashGroupJson(g: ClashGroup): Json {
  return {
    id: g.id, testId: g.testId, name: g.name, status: g.status, assignedTo: g.assignedTo, notes: g.notes, commentId: g.commentId,
    clashIds: g.clashIds, auto: g.auto, keyElement: g.keyElement ? refJson(g.keyElement) : null, autoLabel: g.autoLabel,
    box: g.box ? { ...g.box } : null, createdUtc: g.createdUtc, updated: g.updated, updatedBy: g.updatedBy
  };
}

/** The fewest clashes an automatic group takes. */
export const GROUP_MIN_SIZE = 2;

const compareOrdinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Automatic and element grouping (port of ClashGrouping). */
export const ClashGrouping = {
  MIN_SIZE: GROUP_MIN_SIZE,

  /** GROUP ALL ON <element>: every clash of the test with the element on either side, in document order. */
  forElement(document: ClashDocument | null, testId: string, elementKey: string, includeResolved = false): ClashRecord[] {
    if (!document || !elementKey) { return []; }
    return document.clashes.filter(c => c.testId === testId && (includeResolved || c.status !== ClashStatus.RESOLVED)
      && (elementRefKey(c.a) === elementKey || elementRefKey(c.b) === elementKey));
  },

  /**
   * AUTO GROUP → by element: among the test's ungrouped, unresolved clashes, the element in the most of them gets a
   * group; then the next, over the clashes left, until none has minSize. Ties go to the smaller key (ordinal).
   */
  byElement(document: ClashDocument | null, testId: string, minSize: number, user: string, utc: string): ClashGroup[] {
    const made: ClashGroup[] = [];
    if (!document) { return made; }
    minSize = Math.max(1, minSize);
    const grouped = ClashGroups.index(document);
    const candidates: ClashRecord[] = [];
    const byKey = new Map<string, number[]>();
    const refOf = new Map<string, ClashElementRef>();
    const addKey = (key: string, element: ClashElementRef, index: number) => {
      let list = byKey.get(key);
      if (!list) { list = []; byKey.set(key, list); refOf.set(key, element); }
      list.push(index);
    };
    for (const clash of document.clashes) {
      if (clash.testId !== testId || clash.status === ClashStatus.RESOLVED || grouped.has(clash.id)) { continue; }
      const index = candidates.length;
      candidates.push(clash);
      const a = elementRefKey(clash.a), b = elementRefKey(clash.b);
      addKey(a, clash.a, index);
      if (b !== a) { addKey(b, clash.b, index); }
    }
    const counts = new Map<string, number>();
    for (const [key, list] of byKey) { counts.set(key, list.length); }
    const taken = new Array<boolean>(candidates.length).fill(false);
    // The element with most untaken clashes first (count descending, key ordinal ascending)
    for (;;) {
      let bestKey: string | null = null, bestCount = -1;
      for (const [key, count] of counts) {
        if (count > bestCount || (count === bestCount && bestKey !== null && compareOrdinal(key, bestKey) < 0)) { bestKey = key; bestCount = count; }
      }
      if (bestKey === null || bestCount < minSize) { break; }
      const members: ClashRecord[] = [];
      for (const index of byKey.get(bestKey)!) {
        if (taken[index]) { continue; }
        taken[index] = true;
        const clash = candidates[index];
        members.push(clash);
        const ka = elementRefKey(clash.a);
        const other: string = ka === bestKey ? elementRefKey(clash.b) : ka;
        if (other !== bestKey && counts.has(other)) { counts.set(other, counts.get(other)! - 1); }
      }
      counts.delete(bestKey);
      const { group } = ClashGroups.create(document, testId, members, null, refOf.get(bestKey)!, null, ClashGroupAuto.ELEMENT, user, utc);
      if (group) { made.push(group); }
    }
    return made;
  },

  /** A clash's level: element A's, else B's, else "—". */
  levelOf(clash: ClashRecord | null): string {
    if (!clash) { return '—'; }
    if (!isBlank(clash.a?.level) && clash.a.level.trim() !== '—') { return clash.a.level.trim(); }
    if (!isBlank(clash.b?.level) && clash.b.level.trim() !== '—') { return clash.b.level.trim(); }
    return '—';
  },

  /** "Ducts × Structural Framing": the two categories in ordinal order. */
  categoryPairOf(clash: ClashRecord | null): string {
    const name = (e: ClashElementRef | undefined) => (isBlank(e?.category) ? 'Element' : e!.category.trim());
    const a = name(clash?.a), b = name(clash?.b);
    return compareOrdinal(a, b) <= 0 ? `${a} × ${b}` : `${b} × ${a}`;
  },

  levelLabel(clash: ClashRecord): string {
    const level = ClashGrouping.levelOf(clash);
    return level === '—' ? 'No level' : level;
  },

  byLevel(document: ClashDocument | null, testId: string, minSize: number, user: string, utc: string): ClashGroup[] {
    return byLabel(document, testId, ClashGrouping.levelLabel, ClashGroupAuto.LEVEL, minSize, user, utc);
  },

  byCategoryPair(document: ClashDocument | null, testId: string, perLevel: boolean, minSize: number, user: string, utc: string): ClashGroup[] {
    return perLevel
      ? byLabel(document, testId, c => ClashGrouping.levelLabel(c) + ' · ' + ClashGrouping.categoryPairOf(c), ClashGroupAuto.LEVEL_CATEGORY, minSize, user, utc)
      : byLabel(document, testId, ClashGrouping.categoryPairOf, ClashGroupAuto.CATEGORY, minSize, user, utc);
  },

  /** AUTO GROUP → by grid: one group per nearest intersection ("Near C-4"), or per intersection and level. */
  byGrid(document: ClashDocument | null, testId: string, locate: ((c: ClashRecord) => GridLocation | null) | null, perLevel: boolean,
    minSize: number, user: string, utc: string): ClashGroup[] {
    return byLabel(document, testId, c => ClashGrouping.gridLabel(locate?.(c) ?? null, perLevel),
      perLevel ? ClashGroupAuto.GRID_LEVEL : ClashGroupAuto.GRID, minSize, user, utc);
  },

  /** "Near C-4" / "Near C-4 : Level 2", or "No grid". */
  gridLabel(location: GridLocation | null, withLevel: boolean): string {
    if (!location || !location.node) { return 'No grid'; }
    return 'Near ' + (withLevel ? gridLocationText(location) : location.node);
  },

  /** CLUSTER AROUND…: the clashes within radius of a centre (internal metres), nearest first. */
  inSphere(candidates: Iterable<ClashRecord> | null, x: number, y: number, z: number, radius: number): ClashRecord[] {
    if (!candidates || !(radius >= 0)) { return []; }
    const r2 = radius * radius;
    const found: { d: number; order: number; clash: ClashRecord }[] = [];
    let order = 0;
    for (const clash of candidates) {
      if (!clash) { continue; }
      const dx = clash.x - x, dy = clash.y - y, dz = clash.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d <= r2) { found.push({ d, order, clash }); }
      order++;
    }
    found.sort((p, q) => (p.d !== q.d ? p.d - q.d : p.order - q.order));
    return found.map(f => f.clash);
  },

  /** "Cluster N · Level 2": the next free cluster number and the level most members are on. */
  clusterLabel(document: ClashDocument | null, testId: string, members: readonly ClashRecord[]): string {
    let next = 1;
    for (const group of ClashGroups.ofTest(document, testId)) {
      for (const text of [group.autoLabel, group.name]) {
        const m = text ? /^Cluster (\d+)/.exec(text) : null;
        if (m) { next = Math.max(next, Number(m[1]) + 1); }
      }
    }
    const label = 'Cluster ' + next;
    if (!members || members.length === 0) { return label; }
    const counts = new Map<string, number>();
    let best: string | null = null, bestCount = 0;
    for (const clash of members) {
      const level = ClashGrouping.levelLabel(clash);
      const c = (counts.get(level) ?? 0) + 1;
      counts.set(level, c);
      if (c > bestCount) { bestCount = c; best = level; }
    }
    return label + ' · ' + best;
  },

  /** GROUP BY BOX…: the candidates whose clash point is inside the box, in the given order. */
  inBox(candidates: Iterable<ClashRecord> | null, box: ClashGroupBox | null): ClashRecord[] {
    if (!candidates || !box) { return []; }
    return [...candidates].filter(c => GroupBox.containsClash(box, c));
  }
};

/** The test's ungrouped, unresolved clashes bucketed by a label; buckets of minSize or more become groups. */
function byLabel(document: ClashDocument | null, testId: string, labelOf: (c: ClashRecord) => string, auto: string, minSize: number,
  user: string, utc: string): ClashGroup[] {
  const made: ClashGroup[] = [];
  if (!document) { return made; }
  minSize = Math.max(1, minSize);
  const grouped = ClashGroups.index(document);
  const buckets = new Map<string, ClashRecord[]>();
  for (const clash of document.clashes) {
    if (clash.testId !== testId || clash.status === ClashStatus.RESOLVED || grouped.has(clash.id)) { continue; }
    const label = labelOf(clash);
    let list = buckets.get(label);
    if (!list) { list = []; buckets.set(label, list); }
    list.push(clash);
  }
  const ordered = [...buckets].filter(([, list]) => list.length >= minSize)
    .sort((p, q) => (q[1].length !== p[1].length ? q[1].length - p[1].length : compareOrdinal(p[0], q[0])));
  for (const [label, list] of ordered) {
    const { group } = ClashGroups.create(document, testId, list, null, null, label, auto, user, utc);
    if (group) { made.push(group); }
  }
  return made;
}

