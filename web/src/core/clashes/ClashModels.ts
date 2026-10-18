import { CommentPriority, CommentStatus } from '../format/DocumentModels';
import { arr, bool, isBlank, type Json, newId, num, obj, objOrNull, str } from '../format/Json';
import { type ClashGroup, cleanClashGroups, clashGroupJson, readClashGroup } from './ClashGroups';

/**
 * Clash detection's data (port of BimGo.Core/Clashes/ClashModels.cs, Round C): search sets, tests, clashes and run
 * history, in the same JSON shape as the desktop (camelCase, nulls left out), so clashes.json moves between the two.
 * Records are plain objects; the functions below do what the desktop's methods do.
 */

/** Clash statuses, stored as words. */
export const ClashStatus = {
  NEW: 'new',
  ACTIVE: 'active',
  REVIEWED: 'reviewed',
  APPROVED: 'approved',
  RESOLVED: 'resolved',
  /** Every status in display order. */
  ALL: ['new', 'active', 'reviewed', 'approved', 'resolved'] as readonly string[],

  /** A known status for any text (unknown or empty reads as new). */
  normalise(status: string | null | undefined): string {
    const s = (status ?? '').trim().toLowerCase();
    return ClashStatus.ALL.find(k => k === s) ?? ClashStatus.NEW;
  },

  /** The index of a status in ALL (0 for unknown). */
  indexOf(status: string | null | undefined): number {
    return Math.max(0, ClashStatus.ALL.indexOf(ClashStatus.normalise(status)));
  },

  /** A label for people ("Reviewed"). */
  label(status: string | null | undefined): string {
    const s = ClashStatus.normalise(status);
    return s[0].toUpperCase() + s.slice(1);
  }
};

/** The two kinds of test. */
export const ClashKind = {
  HARD: 'hard',
  CLEARANCE: 'clearance',
  normalise(kind: string | null | undefined): string {
    return (kind ?? '').trim().toLowerCase() === 'clearance' ? 'clearance' : 'hard';
  }
};

/** The clash detection defaults agreed for Round C. */
export const ClashDefaults = {
  /** Hard tests ignore crossings up to 5 mm. */
  HARD_TOLERANCE: 0.005,
  /** Clearance tests report anything closer than 50 mm. */
  CLEARANCE_DISTANCE: 0.05,
  /** The largest tolerance / distance accepted (2 m). */
  MAX_TOLERANCE: 2.0,
  /** A test stops at this many clashes. */
  MAX_CLASHES_PER_TEST: 10_000,
  /** Run history kept. */
  MAX_RUNS: 200,
  toleranceFor(kind: string): number {
    return ClashKind.normalise(kind) === ClashKind.CLEARANCE ? ClashDefaults.CLEARANCE_DISTANCE : ClashDefaults.HARD_TOLERANCE;
  }
};

/** Clash → comment: how a clash's review state reads on its comment (the comment follows the clash, one way). */
export const ClashCommentRules = {
  /** A hard clash crossing deeper than this (m) makes a high-priority comment. */
  HIGH_PRIORITY_DEPTH: 0.05,
  /** The most clashes made into comments in one go. */
  BATCH_LIMIT: 500,
  /** new / active → open, reviewed → in progress, approved / resolved → closed. */
  commentStatusFor(clashStatus: string): string {
    switch (ClashStatus.normalise(clashStatus)) {
      case ClashStatus.REVIEWED: return CommentStatus.IN_PROGRESS;
      case ClashStatus.APPROVED: case ClashStatus.RESOLVED: return CommentStatus.CLOSED;
      default: return CommentStatus.OPEN;
    }
  },
  /** High for a hard clash crossing deeper than 50 mm, else normal. */
  priorityFor(clash: ClashRecord | null, testKind: string): string {
    return clash && ClashKind.normalise(testKind) === ClashKind.HARD && clash.crossing && clash.distance > ClashCommentRules.HIGH_PRIORITY_DEPTH
      ? CommentPriority.HIGH : CommentPriority.NORMAL;
  }
};

/** What a search set rule looks at. */
export const RuleField = {
  /** BimGo's category key ("ducts", "framing"…): the same in every Revit language. */
  CATALOG: 'catalog',
  /** The Revit category name as extracted. */
  CATEGORY: 'category',
  /** The family name (before the colon of "Family: Type"; empty for system families). */
  FAMILY: 'family',
  /** The type name (after the colon, or the whole name for system families). */
  TYPE: 'type',
  LEVEL: 'level',
  /** The model: empty = the host model, else the link instance's UniqueId (or its name). */
  LINK: 'link',
  /** Colour round A: the element's phase role ("existing", "new", "between", "unphased"). */
  PHASE: 'phase',
  /** Colour round A: one of the extra extracted parameters (the rule's parameter names it). */
  PARAMETER: 'parameter',
  /** The built-in fields in display order (parameters follow them, one per extracted name). */
  ALL: ['catalog', 'category', 'family', 'type', 'level', 'link', 'phase'] as readonly string[],
  /** The stored phase values, in PhaseRole order. */
  PHASE_VALUES: ['existing', 'new', 'between', 'unphased'] as readonly string[],
  PHASE_LABELS: ['Existing', 'New', 'Between phases', 'Not phased'] as readonly string[],
  /** A known field for any text (unknown reads as category). */
  normalise(field: string | null | undefined): string {
    const f = (field ?? '').trim().toLowerCase();
    if (f === 'parameter') { return RuleField.PARAMETER; }
    return RuleField.ALL.find(k => k === f) ?? RuleField.CATEGORY;
  },
  /** The stored value of a phase role. */
  phaseValue(role: number): string {
    return RuleField.PHASE_VALUES[Math.min(Math.max(role, 0), RuleField.PHASE_VALUES.length - 1)];
  },
  /** The label of a stored phase value (the value itself when unknown). */
  phaseLabel(value: string | null): string {
    const i = RuleField.PHASE_VALUES.findIndex(v => v === (value ?? '').toLowerCase());
    return i >= 0 ? RuleField.PHASE_LABELS[i] : value ?? '';
  }
};

/** How a rule compares; the "not" operators always take matching elements out of the set. */
export const RuleOp = {
  IS: 'is',
  IS_ONE_OF: 'isOneOf',
  IS_NOT: 'isNot',
  IS_NOT_ANY_OF: 'isNotAnyOf',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'notContains',
  /** Colour round B: the field's first number is at least the value. */
  AT_LEAST: 'atLeast',
  AT_MOST: 'atMost',
  /** Colour round B: between the two values (inclusive, either order). */
  BETWEEN: 'between',
  ALL: ['is', 'isOneOf', 'isNot', 'isNotAnyOf', 'contains', 'notContains', 'atLeast', 'atMost', 'between'] as readonly string[],
  LABELS: ['IS', 'IS ONE OF', 'IS NOT', 'IS NOT ANY OF', 'CONTAINS', 'DOES NOT CONTAIN', 'AT LEAST (≥)', 'AT MOST (≤)', 'BETWEEN'] as readonly string[],
  indexOf(op: string | null | undefined): number {
    const o = (op ?? '').trim().toLowerCase();
    return RuleOp.ALL.findIndex(k => k.toLowerCase() === o);
  },
  isKnown(op: string | null | undefined): boolean { return RuleOp.indexOf(op) >= 0; },
  normalise(op: string | null | undefined): string {
    const index = RuleOp.indexOf(op);
    return index < 0 ? RuleOp.IS : RuleOp.ALL[index];
  },
  /** The operator an older rule meant (contains + exclude switches). */
  fromLegacy(contains: boolean, exclude: boolean): string {
    return contains ? (exclude ? RuleOp.NOT_CONTAINS : RuleOp.CONTAINS) : (exclude ? RuleOp.IS_NOT : RuleOp.IS);
  },
  isNegative(op: string): boolean { return op === RuleOp.IS_NOT || op === RuleOp.IS_NOT_ANY_OF || op === RuleOp.NOT_CONTAINS; },
  isList(op: string): boolean { return op === RuleOp.IS_ONE_OF || op === RuleOp.IS_NOT_ANY_OF; },
  isText(op: string): boolean { return op === RuleOp.CONTAINS || op === RuleOp.NOT_CONTAINS; },
  /** Colour round B: the number operators (typed numbers). */
  isNumeric(op: string): boolean { return op === RuleOp.AT_LEAST || op === RuleOp.AT_MOST || op === RuleOp.BETWEEN; },
  /** How many values the operator keeps (between: 2; the list operators: any). */
  maxValues(op: string): number { return RuleOp.isList(op) ? Number.MAX_SAFE_INTEGER : op === RuleOp.BETWEEN ? 2 : 1; },
  /** A lower-case label for descriptions ("is not any of", "at least"). */
  words(op: string): string {
    if (op === RuleOp.AT_LEAST) { return 'at least'; }
    if (op === RuleOp.AT_MOST) { return 'at most'; }
    return RuleOp.LABELS[Math.max(0, RuleOp.indexOf(op))].toLowerCase();
  }
};

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * Colour round B: numbers in rule values and element texts (port of RuleNumbers). The first number in a text counts
 * ("600 mm" → 600); spaces / apostrophes between digit groups are dropped; a comma followed by three digits is a
 * thousands separator, otherwise a decimal mark.
 */
export const RuleNumbers = {
  /** The first number in a text, or null. */
  tryParse(text: string | null | undefined): number | null {
    if (!text) { return null; }
    let i = 0;
    while (i < text.length && !isDigit(text[i])) { i++; }
    if (i >= text.length) { return null; }
    const negative = i > 0 && (text[i - 1] === '-' || text[i - 1] === '−') && (i < 2 || !isDigit(text[i - 2]));
    if (i > 0 && text[i - 1] === '.') { i--; }
    const groupFollows = (start: number) => {
      if (start + 3 > text.length) { return false; }
      for (let k = start; k < start + 3; k++) { if (!isDigit(text[k])) { return false; } }
      return start + 3 === text.length || !isDigit(text[start + 3]);
    };
    let digits = '';
    let decimalSeen = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (isDigit(c)) { digits += c; continue; }
      if (!isDigit(text[i + 1])) { break; }
      if ((c === ' ' || c === ' ' || c === ' ' || c === '\'') && digits.length > 0 && !decimalSeen && groupFollows(i + 1)) { continue; }
      if (c === '.' && !decimalSeen) { decimalSeen = true; digits += '.'; continue; }
      if (c === ',' && !decimalSeen) {
        if (groupFollows(i + 1)) { continue; }
        decimalSeen = true;
        digits += '.';
        continue;
      }
      break;
    }
    if (digits.length === 0 || digits === '.') { return null; }
    let value = Number(digits.startsWith('.') ? '0' + digits : digits);
    if (!Number.isFinite(value)) { return null; }
    if (negative) { value = -value; }
    return value;
  },

  /** The numbers in a typed text ("300 to 600" → 300, 600), at most max. */
  all(text: string | null | undefined, max = 2): number[] {
    const result: number[] = [];
    let rest = text ?? '';
    while (result.length < max) {
      let i = 0;
      while (i < rest.length && !isDigit(rest[i])) { i++; }
      if (i >= rest.length) { break; }
      let j = i;
      while (j < rest.length && (isDigit(rest[j]) || ((rest[j] === '.' || rest[j] === ',') && isDigit(rest[j + 1])))) { j++; }
      const from = i > 0 && (rest[i - 1] === '-' || rest[i - 1] === '−') && (i < 2 || rest[i - 2] === ' ') ? i - 1 : i;
      const value = RuleNumbers.tryParse(rest.slice(from, j));
      if (value === null) { break; }
      result.push(value);
      rest = rest.slice(j);
      if (rest.length > 0 && (rest[0] === '-' || rest[0] === '–')) { rest = rest.slice(1); }
    }
    return result;
  },

  /** A number as rules store it (invariant, up to 6 decimals, no trailing zeros). */
  format(value: number): string {
    let fixed = value.toFixed(6);
    if (fixed.includes('.')) { fixed = fixed.replace(/0+$/, '').replace(/\.$/, ''); }
    return fixed === '-0' ? '0' : fixed;
  }
};

/**
 * One rule of a search set: a field, an operator and its values. A rule with no value yet is left out of matching.
 * The host model (link field) and system families (family field) are the empty value. contains / value / exclude are
 * the earlier form, still written (kept in step) so older builds read a rule as nearly as they can.
 */
export interface SetRule {
  field: string;
  /** Colour round A: the parameter's name when field is "parameter", else null (not written). */
  parameter: string | null;
  /** Null in files from builds before operators (contains / exclude say what it is then). */
  op: string | null;
  values: string[];
  contains: boolean;
  value: string;
  exclude: boolean;
}

export function newRule(field = RuleField.CATALOG, op: string | null = RuleOp.IS, values: string[] = []): SetRule {
  return { field, parameter: null, op, values: [...values], contains: false, value: '', exclude: false };
}

/** The operator in effect (an older rule's from its switches). */
export function ruleOperator(rule: SetRule): string {
  return RuleOp.isKnown(rule.op) ? RuleOp.normalise(rule.op) : RuleOp.fromLegacy(rule.contains, rule.exclude);
}

/** How many values the rule compares with (an older rule has its one value). */
export function ruleValueCount(rule: SetRule): number {
  return RuleOp.isKnown(rule.op) ? rule.values?.length ?? 0 : 1;
}

/** One of the values (an older rule's value). */
export function ruleValueAt(rule: SetRule, index: number): string {
  return RuleOp.isKnown(rule.op) ? rule.values[index] ?? '' : rule.value ?? '';
}

/** True when the rule takes part in matching: it has a value (a text operator: some text). */
export function ruleIsComplete(rule: SetRule): boolean {
  const count = ruleValueCount(rule);
  if (count === 0) { return false; }
  const op = ruleOperator(rule);
  if (RuleOp.isNumeric(op)) {
    const needed = op === RuleOp.BETWEEN ? 2 : 1;
    if (count < needed) { return false; }
    for (let i = 0; i < needed; i++) { if (RuleNumbers.tryParse(ruleValueAt(rule, i)) === null) { return false; } }
    return true;
  }
  if (!RuleOp.isText(op)) { return true; }
  for (let i = 0; i < count; i++) { if (!isBlank(ruleValueAt(rule, i))) { return true; } }
  return false;
}

/** Makes the rule explicit, trims a single-value operator to one value and keeps the earlier fields in step. */
export function normaliseRule(rule: SetRule): SetRule {
  rule.field = RuleField.normalise(rule.field);
  rule.parameter = rule.field === RuleField.PARAMETER ? (rule.parameter ?? '').trim() : null;
  if (!RuleOp.isKnown(rule.op)) {
    rule.op = RuleOp.fromLegacy(rule.contains, rule.exclude);
    rule.values = [rule.value ?? ''];
  }
  rule.op = RuleOp.normalise(rule.op);
  rule.values = (rule.values ?? []).map(v => v ?? '');
  const keep = RuleOp.maxValues(rule.op);
  if (rule.values.length > keep) { rule.values.length = keep; }
  rule.contains = RuleOp.isText(rule.op);
  rule.exclude = RuleOp.isNegative(rule.op);
  rule.value = rule.values.length > 0 ? rule.values[0] : '';
  return rule;
}

/** Changes the operator: a list keeps its values; a single-value operator keeps the first one. */
export function setRuleOperator(rule: SetRule, op: string): void {
  normaliseRule(rule);
  const wasNumeric = RuleOp.isNumeric(rule.op ?? '');
  rule.op = RuleOp.normalise(op);
  if (wasNumeric !== RuleOp.isNumeric(rule.op)) { rule.values = []; } // colour round B: numbers and names don't mix
  normaliseRule(rule);
}

/** Replaces the values (single-value operators keep the first). */
export function setRuleValues(rule: SetRule, values: readonly string[]): void {
  normaliseRule(rule);
  rule.values = values.map(v => v ?? '');
  normaliseRule(rule);
}

/** Changes the field (the values belong to the old field, so they go). */
export function setRuleField(rule: SetRule, field: string, parameter: string | null = null): void {
  normaliseRule(rule);
  rule.field = RuleField.normalise(field);
  rule.parameter = parameter;
  rule.values = [];
  normaliseRule(rule);
}

/** True when the rule looks at the same field (and parameter) as another field choice. */
export function ruleIsField(rule: SetRule, field: string, parameter: string | null): boolean {
  const normal = RuleField.normalise(field);
  if (RuleField.normalise(rule.field) !== normal) { return false; }
  return normal !== RuleField.PARAMETER || (rule.parameter ?? '').toLowerCase() === (parameter ?? '').toLowerCase();
}

const sameText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** True when the rule holds a value (case ignored). */
export function ruleHasValue(rule: SetRule, value: string): boolean {
  for (let i = 0; i < ruleValueCount(rule); i++) { if (sameText(ruleValueAt(rule, i), value ?? '')) { return true; } }
  return false;
}

/** List operators: adds the value, or takes it out when it is there. */
export function toggleRuleValue(rule: SetRule, value: string): void {
  normaliseRule(rule);
  const index = rule.values.findIndex(v => sameText(v, value ?? ''));
  if (index >= 0) { rule.values.splice(index, 1); } else { rule.values.push(value ?? ''); }
  normaliseRule(rule);
}

export function copyRule(rule: SetRule): SetRule {
  return {
    field: rule.field, parameter: rule.parameter, op: rule.op, values: [...(rule.values ?? [])], contains: rule.contains, value: rule.value,
    exclude: rule.exclude
  };
}

/**
 * A group of rules inside a search set (C-B4): ANY or ALL of its rules, each an ordinary condition. Polish round P-C:
 * groups inside groups, to any depth (each one more condition).
 */
export interface RuleGroup {
  matchAll: boolean;
  rules: SetRule[];
  /** Groups inside this group (null: none, nothing written). */
  groups: RuleGroup[] | null;
}

/** Deepest nesting kept when reading. */
export const RULE_GROUP_MAX_DEPTH = 16;

export function groupHasConditions(group: RuleGroup): boolean {
  return (group.rules ?? []).some(r => r && ruleIsComplete(r)) || (group.groups ?? []).some(g => g && groupHasConditions(g));
}

/** Every rule: the group's, then its groups' (depth first). */
export function groupAllRules(group: RuleGroup): SetRule[] {
  return [...(group.rules ?? []), ...(group.groups ?? []).flatMap(g => (g ? groupAllRules(g) : []))];
}

/** Drops null rules / groups, normalises the rest (deeper than the limit dropped), groups null when empty. */
export function normaliseGroup(group: RuleGroup, depth = 1): RuleGroup {
  group.rules = (group.rules ?? []).filter(r => r);
  group.rules.forEach(normaliseRule);
  if (group.groups) {
    group.groups = group.groups.filter(g => g);
    if (depth >= RULE_GROUP_MAX_DEPTH) { group.groups = []; }
    for (const inner of group.groups) { normaliseGroup(inner, depth + 1); }
    if (group.groups.length === 0) { group.groups = null; }
  }
  return group;
}

export function copyGroup(group: RuleGroup): RuleGroup {
  const groups = (group.groups ?? []).filter(g => g).map(copyGroup);
  return { matchAll: group.matchAll, rules: (group.rules ?? []).filter(r => r).map(copyRule), groups: groups.length > 0 ? groups : null };
}

/**
 * A named group of elements chosen by rules. An element is in the set when it matches the adding rules and groups (any
 * of them, or all of them with matchAll) and no top-level "not" rule.
 */
export interface SearchSet {
  id: string;
  name: string;
  matchAll: boolean;
  rules: SetRule[];
  /** Rule groups (null: none, the file stays as before). */
  groups: RuleGroup[] | null;
}

export function newSet(name = 'New set'): SearchSet {
  return { id: newId(), name, matchAll: false, rules: [], groups: null };
}

/** Every rule: the set's own, then each group's (nested groups' too, depth first). */
export function allRules(set: SearchSet): SetRule[] {
  return [...(set.rules ?? []), ...(set.groups ?? []).flatMap(g => (g ? groupAllRules(g) : []))];
}

/** Drops null rules / groups, normalises every rule, and leaves groups null when empty (in place). */
export function normaliseSetRules(set: SearchSet): void {
  set.rules = (set.rules ?? []).filter(r => r);
  set.rules.forEach(normaliseRule);
  if (set.groups) {
    set.groups = set.groups.filter(g => g);
    for (const group of set.groups) { normaliseGroup(group); }
    if (set.groups.length === 0) { set.groups = null; }
  }
}

export function copySet(set: SearchSet, freshId = false): SearchSet {
  return {
    id: freshId ? newId() : set.id,
    name: set.name,
    matchAll: set.matchAll,
    rules: (set.rules ?? []).filter(r => r).map(copyRule),
    groups: set.groups ? set.groups.filter(g => g).map(copyGroup) : null
  };
}

/** One clash test: set A against set B (or against itself), hard or clearance, with its tolerance. */
export interface ClashTest {
  id: string;
  name: string;
  kind: string;
  setA: string | null;
  /** Set B's id, or null to test set A against itself (stored as picked: set A moving never changes it). */
  setB: string | null;
  /** Metres. Hard: crossings up to this depth are ignored. Clearance: anything closer is reported. */
  tolerance: number;
  /** False leaves the test out of RUN ALL. */
  enabled: boolean;
  /** When the test last ran to the end (ISO UTC), or null. */
  lastRunUtc: string | null;
  /** The model state at that run (to say "model changed since"). */
  lastRunModel: string | null;
  lastRunTruncated: boolean;
}

export function newTest(name = 'New test'): ClashTest {
  return { id: newId(), name, kind: ClashKind.HARD, setA: null, setB: null, tolerance: ClashDefaults.HARD_TOLERANCE, enabled: true, lastRunUtc: null, lastRunModel: null, lastRunTruncated: false };
}

/** True when set B is set A (or empty). */
export function isSelfTest(test: ClashTest): boolean {
  return !test.setB || test.setB === test.setA;
}

/** How a clash names one of its elements: stable identity first, then what people read. */
export interface ClashElementRef {
  uniqueId: string;
  elementId: number;
  /** The link instance's UniqueId for a linked element, or empty for the host model. */
  link: string;
  /** The walkthrough clone key of a clone / placement (0 for model elements). */
  cloneKey: number;
  ifcGuid: string | null;
  category: string;
  familyType: string;
  level: string;
}

export function newElementRef(uniqueId = ''): ClashElementRef {
  return { uniqueId, elementId: 0, link: '', cloneKey: 0, ifcGuid: null, category: '', familyType: '', level: '' };
}

/** The key matching the element across runs: link + UniqueId (or clone key, or ElementId as a last resort). */
export function elementRefKey(ref: ClashElementRef): string {
  return (ref.link ?? '') + '/' + (ref.cloneKey > 0 ? 'clone:' + ref.cloneKey : ref.uniqueId ? ref.uniqueId : 'id:' + ref.elementId);
}

/** A short label for lists ("Ducts · Rectangular Duct: 600x300"). */
export function elementRefLabel(ref: ClashElementRef): string {
  return isBlank(ref.familyType) ? ref.category : `${ref.category} · ${ref.familyType}`;
}

/** One clash: a test, an element pair, where and how much, and its review state (points in Revit internal metres). */
export interface ClashRecord {
  id: string;
  testId: string;
  a: ClashElementRef;
  b: ClashElementRef;
  x: number;
  y: number;
  z: number;
  /** Metres: a crossing's estimated depth, or a clearance gap. */
  distance: number;
  crossing: boolean;
  approximate: boolean;
  status: string;
  assignedTo: string | null;
  notes: string | null;
  /** The comment made from this clash, or null. */
  commentId: string | null;
  foundUtc: string;
  lastSeenUtc: string;
  resolvedUtc: string | null;
  /** When a person last changed the status, assignee or notes (imports keep the newer). */
  updated: string | null;
  updatedBy: string | null;
}

export function newClash(testId: string, a: ClashElementRef, b: ClashElementRef): ClashRecord {
  const now = new Date().toISOString();
  return {
    id: newId(), testId, a, b, x: 0, y: 0, z: 0, distance: 0, crossing: false, approximate: false, status: ClashStatus.NEW,
    assignedTo: null, notes: null, commentId: null, foundUtc: now, lastSeenUtc: now, resolvedUtc: null, updated: null, updatedBy: null
  };
}

/** Test id + both element keys, the smaller first (A × B and B × A in a self test are the same clash). */
export function clashKeyFor(testId: string, a: ClashElementRef, b: ClashElementRef): string {
  const ka = a ? elementRefKey(a) : '', kb = b ? elementRefKey(b) : '';
  return ka <= kb ? `${testId}|${ka}|${kb}` : `${testId}|${kb}|${ka}`;
}

export function clashKey(clash: ClashRecord): string {
  return clashKeyFor(clash.testId, clash.a, clash.b);
}

/** One finished run of a test. */
export interface ClashRunRecord {
  utc: string;
  testId: string;
  user: string;
  found: number;
  new: number;
  newlyResolved: number;
  /** The test's clashes per status after the run (ClashStatus.ALL order). */
  byStatus: number[];
  elementsA: number;
  elementsB: number;
  seconds: number;
  truncated: boolean;
}

/** Everything clash detection keeps for a model (clashes.json; the same shape with a header is the exported report). */
export interface ClashDocument {
  format: string;
  version: number;
  modelTitle: string | null;
  modelKey: string | null;
  generator: string | null;
  exportedUtc: string | null;
  sets: SearchSet[];
  tests: ClashTest[];
  clashes: ClashRecord[];
  runs: ClashRunRecord[];
  /** C-C1: clash groups (null when there are none, so files without groups stay as they were). */
  groups: ClashGroup[] | null;
}

export const CLASH_FORMAT = 'bimgo-clashes';
export const CLASH_REPORT_FORMAT = 'bimgo-clash-report';
export const CLASH_VERSION = 1;

export function emptyClashDocument(): ClashDocument {
  return { format: CLASH_FORMAT, version: CLASH_VERSION, modelTitle: null, modelKey: null, generator: null, exportedUtc: null, sets: [], tests: [], clashes: [], runs: [], groups: null };
}

export function findSet(document: ClashDocument, id: string | null | undefined): SearchSet | null {
  if (!id) { return null; }
  for (const set of document.sets) { if (set.id === id) { return set; } }
  return null;
}

export function findTest(document: ClashDocument, id: string | null | undefined): ClashTest | null {
  if (!id) { return null; }
  for (const test of document.tests) { if (test.id === id) { return test; } }
  return null;
}

/** Repairs what a hand-edited or damaged file may hold: unknown words, missing or duplicate ids. Returns the document. */
export function cleanClashDocument(document: ClashDocument): ClashDocument {
  document.sets = (document.sets ?? []).filter(s => s);
  document.tests = (document.tests ?? []).filter(t => t);
  document.clashes = (document.clashes ?? []).filter(c => c && c.a && c.b && c.testId);
  document.runs = (document.runs ?? []).filter(r => r);

  const setIds = new Set<string>();
  for (const set of document.sets) {
    if (isBlank(set.id) || setIds.has(set.id)) { set.id = newId(); }
    setIds.add(set.id);
    set.name = isBlank(set.name) ? 'Set' : set.name.trim();
    normaliseSetRules(set);
  }
  const testIds = new Set<string>();
  for (const test of document.tests) {
    if (isBlank(test.id) || testIds.has(test.id)) { test.id = newId(); }
    testIds.add(test.id);
    test.name = isBlank(test.name) ? 'Test' : test.name.trim();
    test.kind = ClashKind.normalise(test.kind);
    if (!Number.isFinite(test.tolerance)) { test.tolerance = ClashDefaults.toleranceFor(test.kind); }
    test.tolerance = Math.min(Math.max(test.tolerance, 0), ClashDefaults.MAX_TOLERANCE);
  }
  const clashIds = new Set<string>();
  for (const clash of document.clashes) {
    if (isBlank(clash.id) || clashIds.has(clash.id)) { clash.id = newId(); }
    clashIds.add(clash.id);
    clash.status = ClashStatus.normalise(clash.status);
    clash.a.link ??= '';
    clash.b.link ??= '';
    clash.a.uniqueId ??= '';
    clash.b.uniqueId ??= '';
  }
  for (const run of document.runs) {
    if (!Array.isArray(run.byStatus) || run.byStatus.length !== ClashStatus.ALL.length) {
      const counts = new Array<number>(ClashStatus.ALL.length).fill(0);
      (run.byStatus ?? []).slice(0, counts.length).forEach((v, i) => { counts[i] = v; });
      run.byStatus = counts;
    }
  }
  if (document.runs.length > ClashDefaults.MAX_RUNS) { document.runs.splice(0, document.runs.length - ClashDefaults.MAX_RUNS); }
  cleanClashGroups(document); // C-C1: after the clash ids are fixed
  return document;
}

// #region JSON

export const date = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

function readRule(j: Json): SetRule {
  return {
    field: str(j.field, RuleField.CATALOG),
    parameter: str(j.parameter, null),
    op: str(j.op, null),
    values: arr(j.values).map(v => (typeof v === 'string' ? v : '')),
    contains: bool(j.contains),
    value: str(j.value, ''),
    exclude: bool(j.exclude)
  };
}

function readGroup(o: Json, depth: number): RuleGroup {
  const inner = depth < RULE_GROUP_MAX_DEPTH && Array.isArray(o.groups) ? o.groups.map(g => readGroup(obj(g), depth + 1)) : null;
  return { matchAll: bool(o.matchAll), rules: arr(o.rules).map(r => readRule(obj(r))), groups: inner };
}

export function readSet(j: Json): SearchSet {
  const groups = Array.isArray(j.groups) ? j.groups.map(g => readGroup(obj(g), 1)) : null;
  return { id: str(j.id, ''), name: str(j.name, 'New set'), matchAll: bool(j.matchAll), rules: arr(j.rules).map(r => readRule(obj(r))), groups };
}

export function readTest(j: Json): ClashTest {
  return {
    id: str(j.id, ''),
    name: str(j.name, 'New test'),
    kind: str(j.kind, ClashKind.HARD),
    setA: str(j.setA, null),
    setB: str(j.setB, null),
    tolerance: num(j.tolerance, ClashDefaults.HARD_TOLERANCE),
    enabled: bool(j.enabled, true),
    lastRunUtc: date(j.lastRunUtc),
    lastRunModel: str(j.lastRunModel, null),
    lastRunTruncated: bool(j.lastRunTruncated)
  };
}

export function readRef(v: unknown): ClashElementRef | null {
  const j = objOrNull(v);
  if (!j) { return null; }
  return {
    uniqueId: str(j.uniqueId, ''),
    elementId: num(j.elementId),
    link: str(j.link, ''),
    cloneKey: num(j.cloneKey),
    ifcGuid: str(j.ifcGuid, null),
    category: str(j.category, ''),
    familyType: str(j.familyType, ''),
    level: str(j.level, '')
  };
}

function readClash(j: Json): ClashRecord {
  const now = new Date().toISOString();
  return {
    id: str(j.id, ''),
    testId: str(j.testId, ''),
    a: readRef(j.a)!,
    b: readRef(j.b)!,
    x: num(j.x), y: num(j.y), z: num(j.z),
    distance: num(j.distance),
    crossing: bool(j.crossing),
    approximate: bool(j.approximate),
    status: str(j.status, ClashStatus.NEW),
    assignedTo: str(j.assignedTo, null),
    notes: str(j.notes, null),
    commentId: str(j.commentId, null),
    foundUtc: date(j.foundUtc) ?? now,
    lastSeenUtc: date(j.lastSeenUtc) ?? now,
    resolvedUtc: date(j.resolvedUtc),
    updated: date(j.updated),
    updatedBy: str(j.updatedBy, null)
  };
}

function readRun(j: Json): ClashRunRecord {
  return {
    utc: date(j.utc) ?? new Date().toISOString(),
    testId: str(j.testId, ''),
    user: str(j.user, ''),
    found: num(j.found), new: num(j.new), newlyResolved: num(j.newlyResolved),
    byStatus: arr(j.byStatus).map(v => num(v)),
    elementsA: num(j.elementsA), elementsB: num(j.elementsB),
    seconds: num(j.seconds),
    truncated: bool(j.truncated)
  };
}

/** A document from parsed JSON (not cleaned; ClashFiles.parse checks the format and cleans). */
export function readClashDocument(j: Json): ClashDocument {
  return {
    format: str(j.format, ''),
    version: num(j.version, CLASH_VERSION),
    modelTitle: str(j.modelTitle, null),
    modelKey: str(j.modelKey, null),
    generator: str(j.generator, null),
    exportedUtc: date(j.exportedUtc),
    sets: arr(j.sets).map(s => readSet(obj(s))),
    tests: arr(j.tests).map(t => readTest(obj(t))),
    clashes: arr(j.clashes).map(c => readClash(obj(c))),
    runs: arr(j.runs).map(r => readRun(obj(r))),
    groups: Array.isArray(j.groups) ? j.groups.map(g => readClashGroup(obj(g))) : null
  };
}

/** Drops null / undefined members (WhenWritingNull) recursively from a plain value. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(withoutNulls); }
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) { continue; }
      out[k] = withoutNulls(v);
    }
    return out;
  }
  return value;
}

/** The document as JSON-ready objects in the desktop's member order (nulls left out). */
export function clashDocumentJson(document: ClashDocument): Json {
  return withoutNulls({
    format: document.format,
    version: document.version,
    modelTitle: document.modelTitle,
    modelKey: document.modelKey,
    generator: document.generator,
    exportedUtc: document.exportedUtc,
    sets: document.sets.map(setJson),
    tests: document.tests.map(testJson),
    clashes: document.clashes.map(c => ({
      id: c.id, testId: c.testId, a: refJson(c.a), b: refJson(c.b), x: c.x, y: c.y, z: c.z, distance: c.distance,
      crossing: c.crossing, approximate: c.approximate, status: c.status, assignedTo: c.assignedTo, notes: c.notes,
      commentId: c.commentId, foundUtc: c.foundUtc, lastSeenUtc: c.lastSeenUtc, resolvedUtc: c.resolvedUtc, updated: c.updated,
      updatedBy: c.updatedBy
    })),
    runs: document.runs.map(r => ({
      utc: r.utc, testId: r.testId, user: r.user, found: r.found, new: r.new, newlyResolved: r.newlyResolved, byStatus: r.byStatus,
      elementsA: r.elementsA, elementsB: r.elementsB, seconds: r.seconds, truncated: r.truncated
    })),
    groups: document.groups ? document.groups.map(clashGroupJson) : null
  }) as Json;
}

/** A set as JSON-ready members (nulls kept: callers drop them). */
export function setJson(s: SearchSet): Json {
  return { id: s.id, name: s.name, matchAll: s.matchAll, rules: s.rules.map(ruleJson), groups: s.groups ? s.groups.map(groupJson) : null };
}

/** A test as JSON-ready members. */
export function testJson(t: ClashTest): Json {
  return {
    id: t.id, name: t.name, kind: t.kind, setA: t.setA, setB: t.setB, tolerance: t.tolerance, enabled: t.enabled,
    lastRunUtc: t.lastRunUtc, lastRunModel: t.lastRunModel, lastRunTruncated: t.lastRunTruncated
  };
}

/** Drops null / undefined members recursively (the desktop's WhenWritingNull). */
export function jsonWithoutNulls(value: unknown): unknown {
  return withoutNulls(value);
}

function groupJson(g: RuleGroup): Json {
  return { matchAll: g.matchAll, rules: g.rules.map(ruleJson), groups: g.groups ? g.groups.map(groupJson) : null };
}

function ruleJson(r: SetRule): Json {
  return { field: r.field, parameter: r.parameter, op: r.op, values: r.values, contains: r.contains, value: r.value, exclude: r.exclude };
}

export function refJson(r: ClashElementRef): Json {
  return {
    uniqueId: r.uniqueId, elementId: r.elementId, link: r.link, cloneKey: r.cloneKey, ifcGuid: r.ifcGuid, category: r.category,
    familyType: r.familyType, level: r.level
  };
}

// #endregion
