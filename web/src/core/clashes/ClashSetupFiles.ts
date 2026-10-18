import { arr, isBlank, type Json, newId, num, obj, objOrNull, str } from '../format/Json';
import { type LinkInfo, linkLabel } from '../scene/LinkInfo';
import {
  allRules, CLASH_REPORT_FORMAT, ClashKind, type ClashDocument, type ClashTest, copyRule, copyGroup, copySet, findSet, findTest, jsonWithoutNulls,
  normaliseRule, normaliseSetRules, readSet, readTest, RuleField, ruleValueAt, ruleValueCount, type SearchSet, setJson, setRuleValues, testJson
} from './ClashModels';

/** What an imported tests / sets file holds. */
export type ClashSetupKind = 'tests' | 'sets';

/** What to do with an imported test / set whose name is already taken (one choice for the whole file). */
export type ClashNameClash = 'replace' | 'keepBoth' | 'skip';

/** A link named in an exported file (rules hold the instance UniqueId; the name helps match it elsewhere). */
export interface ClashSetupLink { uniqueId: string; name: string }

/** QOL round: a tests or sets file (EXPORT TESTS… / EXPORT SETS…), never clashes or history (port of ClashSetupFile). */
export interface ClashSetupFile {
  format: string;
  version: number;
  modelTitle: string | null;
  generator: string | null;
  exportedUtc: string | null;
  sets: SearchSet[];
  tests: ClashTest[];
  links: ClashSetupLink[];
}

/** A rule value the importing model doesn't have (a link or a level), and what it will become. */
export interface ClashSetupMissing {
  /** "link" or "level". */
  field: string;
  value: string;
  label: string;
  uses: number;
  /** A current link's UniqueId / a level's name; null = leave as it is; DROP = take it out of its rules. */
  replacement: string | null;
  autoMatched: boolean;
}

/** What an import will meet: the file, names already taken and values to reconcile. */
export interface ClashSetupPlan {
  file: ClashSetupFile;
  nameClashes: string[];
  missing: ClashSetupMissing[];
  onNameClash: ClashNameClash;
}

/** What an import changed. */
export interface ClashSetupResult { testsAdded: number; testsReplaced: number; setsAdded: number; setsReplaced: number; skipped: number; valuesChanged: number }

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'accent' }) === 0;
const sameId = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

const kindOf = (file: ClashSetupFile): ClashSetupKind => (sameId(file.format, ClashSetupFiles.TESTS_FORMAT) ? 'tests' : 'sets');

function copyTest(test: ClashTest, keepRun: boolean): ClashTest {
  return {
    id: test.id, name: test.name, kind: test.kind, setA: test.setA, setB: test.setB, tolerance: test.tolerance, enabled: test.enabled,
    lastRunUtc: keepRun ? test.lastRunUtc : null, lastRunModel: keepRun ? test.lastRunModel : null, lastRunTruncated: keepRun && test.lastRunTruncated
  };
}

/** QOL round: export / import of clash tests and search sets as files, with link / level reconciliation (port of ClashSetupFiles). */
export const ClashSetupFiles = {
  TESTS_FORMAT: 'bimgo-clash-tests',
  SETS_FORMAT: 'bimgo-clash-sets',
  VERSION: 1,
  /** A replacement that takes the value out of its rules. */
  DROP: '\u0000drop',

  kindOf,

  /** The file: every test with the sets it uses, or every set, plus the names of the links their rules name. */
  build(document: ClashDocument | null, kind: ClashSetupKind, links: readonly LinkInfo[] | null, modelTitle: string, generator: string): ClashSetupFile {
    const file: ClashSetupFile = {
      format: kind === 'tests' ? ClashSetupFiles.TESTS_FORMAT : ClashSetupFiles.SETS_FORMAT, version: ClashSetupFiles.VERSION, modelTitle, generator,
      exportedUtc: new Date().toISOString(), sets: [], tests: [], links: []
    };
    if (!document) { return file; }
    if (kind === 'tests') {
      const used = new Set<string>();
      for (const test of document.tests) {
        file.tests.push(copyTest(test, false));
        if (test.setA) { used.add(test.setA); }
        if (test.setB) { used.add(test.setB); }
      }
      for (const set of document.sets) { if (used.has(set.id)) { file.sets.push(copySet(set)); } }
    } else {
      for (const set of document.sets) { file.sets.push(copySet(set)); }
    }
    const named = new Set<string>();
    for (const set of file.sets) {
      normaliseSetRules(set);
      for (const rule of allRules(set)) {
        if (rule.field !== RuleField.LINK) { continue; }
        for (let i = 0; i < ruleValueCount(rule); i++) {
          const value = ruleValueAt(rule, i);
          if (value.length === 0 || named.has(value.toLowerCase())) { continue; }
          named.add(value.toLowerCase());
          const link = links?.find(l => sameId(l.instanceUniqueId, value));
          file.links.push({ uniqueId: value, name: link ? linkLabel(link) : value });
        }
      }
    }
    return file;
  },

  /** The file as readable JSON. */
  serialize(file: ClashSetupFile): string {
    return JSON.stringify(jsonWithoutNulls({
      format: file.format, version: file.version, modelTitle: file.modelTitle, generator: file.generator, exportedUtc: file.exportedUtc,
      sets: file.sets.map(setJson), tests: file.tests.map(testJson), links: file.links.map(l => ({ uniqueId: l.uniqueId, name: l.name }))
    }), null, 2);
  },

  /** Reads a tests / sets file (cleaned), or an error; the kind must match the tab it is imported on. */
  parse(text: string | null, expected: ClashSetupKind): { file: ClashSetupFile | null; error: string | null } {
    if (!text) { return { file: null, error: 'The file is empty.' }; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (e) {
      return { file: null, error: `The file could not be read: ${e instanceof Error ? e.message : String(e)}` };
    }
    const j = objOrNull(raw);
    if (!j) { return { file: null, error: 'The file is empty.' }; }
    const format = str(j.format, '');
    const tests = sameId(format, ClashSetupFiles.TESTS_FORMAT), sets = sameId(format, ClashSetupFiles.SETS_FORMAT);
    if (!tests && !sets) {
      return {
        file: null,
        error: sameId(format, CLASH_REPORT_FORMAT) ? 'This is a clash report: import it from clash mode (REPORT… → IMPORT REPORT…).'
          : 'This is not a BimGo tests or sets file.'
      };
    }
    const file: ClashSetupFile = {
      format, version: num(j.version, 1), modelTitle: str(j.modelTitle, null), generator: str(j.generator, null), exportedUtc: str(j.exportedUtc, null),
      sets: arr(j.sets).map(s => objOrNull(s)).filter((s): s is Json => s !== null).map(readSet),
      tests: arr(j.tests).map(t => objOrNull(t)).filter((t): t is Json => t !== null).map(readTest),
      links: arr(j.links).map(l => obj(l)).map(l => ({ uniqueId: str(l.uniqueId, ''), name: str(l.name, '') })).filter(l => l.uniqueId.length > 0)
    };
    if (kindOf(file) !== expected) {
      return { file: null, error: kindOf(file) === 'tests' ? 'This is a tests file: import it on the TESTS tab.' : 'This is a sets file: import it on the SETS tab.' };
    }
    if (file.version > ClashSetupFiles.VERSION) {
      return { file: null, error: `This file was made by a newer BimGo (version ${file.version}). Please update BimGo.` };
    }
    for (const set of file.sets) {
      if (isBlank(set.id)) { set.id = newId(); }
      set.name = isBlank(set.name) ? 'Imported set' : set.name.trim();
      normaliseSetRules(set);
    }
    const ids = new Set(file.sets.map(s => s.id));
    for (const test of file.tests) {
      if (isBlank(test.id)) { test.id = newId(); }
      test.name = isBlank(test.name) ? 'Imported test' : test.name.trim();
      test.kind = ClashKind.normalise(test.kind);
      if (!Number.isFinite(test.tolerance) || test.tolerance < 0) { test.tolerance = 0; }
      if (test.setA !== null && !ids.has(test.setA)) { test.setA = null; }
      if (test.setB && !ids.has(test.setB)) { test.setB = null; }
    }
    return { file, error: null };
  },

  /** What importing the file will meet: names already taken and link / level values this model doesn't have. */
  plan(file: ClashSetupFile, into: ClashDocument, links: readonly LinkInfo[] | null, levels: Iterable<string>): ClashSetupPlan {
    const plan: ClashSetupPlan = { file, nameClashes: [], missing: [], onNameClash: 'keepBoth' };
    if (kindOf(file) === 'tests') {
      plan.nameClashes.push(...file.tests.filter(t => into.tests.some(x => sameText(x.name, t.name))).map(t => t.name));
    } else {
      plan.nameClashes.push(...file.sets.filter(s => into.sets.some(x => sameText(x.name, s.name))).map(s => s.name));
    }
    const levelNames = [...levels];
    const found = new Map<string, ClashSetupMissing>();
    for (const rule of file.sets.flatMap(allRules)) {
      if (rule.field !== RuleField.LINK && rule.field !== RuleField.LEVEL) { continue; }
      for (let i = 0; i < ruleValueCount(rule); i++) {
        const value = ruleValueAt(rule, i);
        if (value.length === 0) { continue; }
        const known = rule.field === RuleField.LINK ? ClashSetupFiles.findLink(links, value) !== null : levelNames.some(l => sameText(l, value));
        if (known) { continue; }
        const key = rule.field + '|' + value.toLowerCase();
        const seen = found.get(key);
        if (seen) { seen.uses++; continue; }
        const missing: ClashSetupMissing = { field: rule.field, value, label: value, uses: 1, replacement: null, autoMatched: false };
        if (rule.field === RuleField.LINK) {
          const name = file.links.find(l => sameId(l.uniqueId, value))?.name ?? null;
          if (name) { missing.label = name; }
          const byName = name === null ? null : ClashSetupFiles.findLink(links, name);
          if (byName) {
            missing.replacement = byName.instanceUniqueId;
            missing.autoMatched = true;
          }
        }
        found.set(key, missing);
        plan.missing.push(missing);
      }
    }
    plan.missing.sort((a, b) => (a.field !== b.field ? (a.field < b.field ? 1 : -1) : a.label.localeCompare(b.label, undefined, { sensitivity: 'accent' })));
    return plan;
  },

  /** The link a rule value names here (UniqueId, then name or label, case ignored), or null. */
  findLink(links: readonly LinkInfo[] | null, value: string | null): LinkInfo | null {
    if (!links || !value) { return null; }
    return links.find(l => sameId(l.instanceUniqueId, value))
      ?? links.find(l => sameId(l.name, value) || sameId(linkLabel(l), value)) ?? null;
  },

  /** Imports the planned file: values replaced as planned, then sets / tests added, replaced, copied or skipped. */
  apply(plan: ClashSetupPlan, into: ClashDocument): ClashSetupResult {
    const file = plan.file;
    const valuesChanged = ClashSetupFiles.reconcile(file, plan.missing);
    let testsAdded = 0, testsReplaced = 0, setsAdded = 0, setsReplaced = 0, skipped = 0;
    const fresh = (incoming: SearchSet) => copySet(incoming, findSet(into, incoming.id) !== null);
    if (kindOf(file) === 'sets') {
      for (const incoming of file.sets) {
        const existing = into.sets.find(s => sameText(s.name, incoming.name));
        if (!existing) { into.sets.push(fresh(incoming)); setsAdded++; continue; }
        if (plan.onNameClash === 'replace') {
          existing.matchAll = incoming.matchAll;
          existing.rules = incoming.rules.map(copyRule);
          existing.groups = incoming.groups ? incoming.groups.map(copyGroup) : null;
          setsReplaced++;
        } else if (plan.onNameClash === 'keepBoth') {
          const copy = fresh(incoming);
          copy.name = ClashSetupFiles.uniqueName(incoming.name, into.sets.map(s => s.name));
          into.sets.push(copy);
          setsAdded++;
        } else {
          skipped++;
        }
      }
      return { testsAdded: 0, testsReplaced: 0, setsAdded, setsReplaced, skipped, valuesChanged };
    }
    const setMap = new Map<string, string>();
    for (const incoming of file.sets) {
      let here = findSet(into, incoming.id) ?? into.sets.find(s => sameText(s.name, incoming.name)) ?? null;
      if (!here) {
        here = fresh(incoming);
        into.sets.push(here);
        setsAdded++;
      }
      setMap.set(incoming.id, here.id);
    }
    for (const incoming of file.tests) {
      const setA = incoming.setA !== null ? setMap.get(incoming.setA) ?? null : null;
      const setB = incoming.setB ? setMap.get(incoming.setB) ?? null : null;
      const existing = into.tests.find(t => sameText(t.name, incoming.name));
      if (existing && plan.onNameClash === 'skip') { skipped++; continue; }
      if (existing && plan.onNameClash === 'replace') {
        existing.kind = incoming.kind;
        existing.setA = setA;
        existing.setB = setB;
        existing.tolerance = incoming.tolerance;
        existing.enabled = incoming.enabled;
        existing.lastRunModel = null;
        testsReplaced++;
        continue;
      }
      const test = copyTest(incoming, false);
      test.id = findTest(into, incoming.id) === null ? incoming.id : newId();
      test.setA = setA;
      test.setB = setB;
      if (existing) { test.name = ClashSetupFiles.uniqueName(incoming.name, into.tests.map(t => t.name)); }
      into.tests.push(test);
      testsAdded++;
    }
    return { testsAdded, testsReplaced, setsAdded, setsReplaced, skipped, valuesChanged };
  },

  /** Replaces (or drops) the planned values in the file's rules; returns how many changed. */
  reconcile(file: ClashSetupFile, missing: readonly ClashSetupMissing[]): number {
    if (!missing || missing.length === 0) { return 0; }
    let changed = 0;
    for (const rule of file.sets.flatMap(allRules)) {
      if (rule.field !== RuleField.LINK && rule.field !== RuleField.LEVEL) { continue; }
      normaliseRule(rule);
      let any = false;
      const values: string[] = [];
      for (const value of rule.values) {
        const m = missing.find(x => x.field === rule.field && sameId(x.value, value));
        if (!m || m.replacement === null) { values.push(value); continue; }
        any = true;
        changed++;
        if (m.replacement !== ClashSetupFiles.DROP && !values.some(v => sameId(v, m.replacement))) { values.push(m.replacement); }
      }
      if (any) { setRuleValues(rule, values); }
    }
    return changed;
  },

  /** "Name (2)", "Name (3)"… the first not taken. */
  uniqueName(name: string, taken: Iterable<string>): string {
    const names = [...taken];
    if (!names.some(n => sameText(n, name))) { return name; }
    for (let n = 2; ; n++) {
      const candidate = `${name} (${n})`;
      if (!names.some(x => sameText(x, candidate))) { return candidate; }
    }
  }
};
