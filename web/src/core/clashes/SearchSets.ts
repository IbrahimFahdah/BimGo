import { CATEGORIES, findCategory } from '../scene/CategoryCatalog';
import { linkLabel } from '../scene/LinkInfo';
import { ParameterTable } from '../scene/ModelInfo';
import { type ElementRecord, linkOf, type SceneData } from '../scene/SceneData';
import {
  type ClashDocument, ClashDefaults, ClashKind, emptyClashDocument, groupHasConditions, newRule, newSet, newTest, normaliseRule, type RuleGroup,
  RuleField, RuleNumbers, RuleOp, ruleIsComplete, ruleOperator, ruleValueAt, ruleValueCount, type SearchSet, type SetRule
} from './ClashModels';

/** One value a rule field takes in the model: what is stored, what people read, how many elements have it. */
export interface RuleValue {
  value: string;
  label: string;
  count: number;
}

const lower = (s: string) => s.toLocaleLowerCase();
const sameText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/**
 * Evaluates search sets against a snapshot's elements and seeds the starter sets and tests (port of
 * BimGo.Core/Clashes/SearchSets.cs).
 */
export const SearchSets = {
  /** Colour round A: the label of a parameter's empty value (elements without it, or with it blank). */
  NO_VALUE: '(no value)',

  /**
   * True when an element belongs to a set: it matches the adding rules and groups (any, or all with matchAll; none =
   * every element) and no top-level "not" rule. Rules with no value yet are left out; library templates never belong.
   * `index` is the element's index in scene.elements (parameter rules read its row; −1: none).
   */
  matches(set: SearchSet, scene: SceneData, element: ElementRecord, index = -1): boolean {
    if (!set || !element || element.isLibraryTemplate) { return false; }
    let anyInclude = false, included = set.matchAll;
    for (const rule of set.rules ?? []) {
      if (!rule || !ruleIsComplete(rule)) { continue; }
      const hit = SearchSets.ruleMatches(rule, scene, element, index);
      if (RuleOp.isNegative(ruleOperator(rule))) {
        if (hit) { return false; }
        continue;
      }
      anyInclude = true;
      included = set.matchAll ? included && hit : included || hit;
    }
    for (const group of set.groups ?? []) {
      if (!group || !groupHasConditions(group)) { continue; }
      const hit = SearchSets.groupMatches(group, scene, element, index);
      anyInclude = true;
      included = set.matchAll ? included && hit : included || hit;
    }
    return !anyInclude || included;
  },

  /**
   * True when an element meets a group (inside it, a "not" rule is true for elements whose field does not match). P-C:
   * each group inside with a condition is one more condition, to any depth.
   */
  groupMatches(group: RuleGroup, scene: SceneData, element: ElementRecord, index = -1): boolean {
    let any = false, result = group.matchAll;
    for (const rule of group.rules ?? []) {
      if (!rule || !ruleIsComplete(rule)) { continue; }
      let hit = SearchSets.ruleMatches(rule, scene, element, index);
      if (RuleOp.isNegative(ruleOperator(rule))) { hit = !hit; }
      any = true;
      result = group.matchAll ? result && hit : result || hit;
      if (group.matchAll ? !result : result) { return result; }
    }
    for (const inner of group.groups ?? []) {
      if (!inner || !groupHasConditions(inner)) { continue; }
      const hit = SearchSets.groupMatches(inner, scene, element, index);
      any = true;
      result = group.matchAll ? result && hit : result || hit;
      if (group.matchAll ? !result : result) { return result; }
    }
    return any && result;
  },

  /** True when an element's field matches one of a rule's values (equals, contains, or the number operators), ignoring "not". */
  ruleMatches(rule: SetRule, scene: SceneData, element: ElementRecord, index = -1): boolean {
    const op = ruleOperator(rule);
    if (RuleOp.isNumeric(op)) { return numberMatches(rule, op, scene, element, index); }
    const contains = RuleOp.isText(op);
    const count = ruleValueCount(rule);
    const field = RuleField.normalise(rule.field);
    const parameterValue = field === RuleField.PARAMETER ? SearchSets.parameterValue(scene, index, rule.parameter) ?? '' : null;
    for (let i = 0; i < count; i++) {
      const value = ruleValueAt(rule, i).trim();
      if (contains && value.length === 0) { continue; }
      if (parameterValue !== null) {
        if (compare(parameterValue, value, contains)) { return true; }
        continue;
      }
      if (valueMatches(field, contains, value, scene, element)) { return true; }
    }
    return false;
  },

  /** Colour round B: the first number in an element's field text, or null. */
  numberOf(scene: SceneData, element: ElementRecord, index: number, field: string, parameter: string | null): number | null {
    field = RuleField.normalise(field);
    const text = field === RuleField.PARAMETER ? SearchSets.parameterValue(scene, index, parameter) : SearchSets.elementValue(scene, element, index, field, -1)?.value ?? null;
    return RuleNumbers.tryParse(text);
  },

  /** Colour round A: an element's value of an extracted parameter, or null. */
  parameterValue(scene: SceneData | null, index: number, parameter: string | null): string | null {
    const table = scene?.parameters;
    if (!table || table.isEmpty || index < 0) { return null; }
    return table.valueOf(index, table.indexOfName(parameter));
  },

  /** The indices of a scene's elements in a set (library templates left out). */
  elementsIn(set: SearchSet, scene: SceneData): number[] {
    const result: number[] = [];
    if (!set) { return result; }
    scene.elements.forEach((e, i) => { if (SearchSets.matches(set, scene, e, i)) { result.push(i); } });
    return result;
  },

  /** Splits "Family: Type" (system families have only the type name, so the family is empty). */
  splitFamilyType(familyType: string | null): { family: string; type: string } {
    const text = familyType ?? '';
    const colon = text.indexOf(': ');
    if (colon < 0) { return { family: '', type: text.trim() }; }
    return { family: text.slice(0, colon).trim(), type: text.slice(colon + 2).trim() };
  },

  /**
   * The values a rule field takes in the model (the value picker): stored value, label, element count; sorted by
   * label. Catalogue values are keys (labelled by their names); the host model's link value is empty ("Host model").
   * Colour round A: phases are "existing" / "new"… (labelled); a parameter's values are its texts, with elements
   * without it as the empty value, "(no value)".
   */
  valuesOf(scene: SceneData, field: string, parameter: string | null = null): RuleValue[] {
    field = RuleField.normalise(field);
    const counts = new Map<string, RuleValue>();
    const table = scene.parameters ?? ParameterTable.empty;
    const nameIndex = field === RuleField.PARAMETER ? table.indexOfName(parameter) : -1;
    scene.elements.forEach((e, i) => {
      if (!e || e.isLibraryTemplate) { return; }
      const v = SearchSets.elementValue(scene, e, i, field, nameIndex);
      if (!v) { return; }
      const key = lower(v.value);
      const known = counts.get(key);
      if (known) { known.count++; } else { counts.set(key, { value: v.value, label: v.label, count: 1 }); }
    });
    const result = [...counts.values()];
    if (field === RuleField.LINK) {
      // Colour round B: links of one model share its title: those read as their instance names instead
      const byLabel = new Map<string, number>();
      for (const v of result) { byLabel.set(lower(v.label), (byLabel.get(lower(v.label)) ?? 0) + 1); }
      for (const v of result) {
        if ((byLabel.get(lower(v.label)) ?? 0) < 2 || v.value.length === 0) { continue; }
        const link = scene.links.find(l => sameText(l.instanceUniqueId, v.value) || l.name === v.value);
        if (link && link.name.trim()) { v.label = link.name; }
      }
    }
    return result.sort((x, y) => x.label.localeCompare(y.label, undefined, { sensitivity: 'accent' }));
  },

  /**
   * One element's value of a field as stored in a rule, and its label; null when the element has no value worth
   * listing (a blank category, type or level). Parameters: pass the name's index; missing / blank is "(no value)".
   */
  elementValue(scene: SceneData | null, e: ElementRecord, index: number, field: string, nameIndex: number): { value: string; label: string } | null {
    let value: string, label: string;
    switch (field) {
      case RuleField.CATALOG: {
        const def = CATEGORIES[e.categoryIndex];
        return def ? { value: def.key, label: def.label } : null;
      }
      case RuleField.CATEGORY:
        value = label = e.categoryName ?? '';
        break;
      case RuleField.FAMILY:
        value = SearchSets.splitFamilyType(e.familyType).family;
        return { value, label: value.length === 0 ? '(system families)' : value };
      case RuleField.TYPE:
        value = label = SearchSets.splitFamilyType(e.familyType).type;
        break;
      case RuleField.LEVEL:
        value = label = e.levelName ?? '';
        break;
      case RuleField.PHASE:
        value = RuleField.phaseValue(e.phase);
        return { value, label: RuleField.phaseLabel(value) };
      case RuleField.PARAMETER: {
        const text = scene?.parameters?.valueOf(index, nameIndex) ?? null;
        value = text === null || text.trim().length === 0 ? '' : text.trim();
        return { value, label: value.length === 0 ? SearchSets.NO_VALUE : value };
      }
      default: {
        const link = scene ? linkOf(scene, e) : null;
        return { value: !link ? '' : link.instanceUniqueId || link.name, label: !link ? 'Host model' : linkLabel(link) };
      }
    }
    return value.trim().length === 0 ? null : { value, label };
  },

  /** How a rule reads for people ("BimGo category is one of Ducts, Pipes", "Level is not Level 2"). */
  describe(rule: SetRule, scene: SceneData | null): string {
    const field = RuleField.normalise(rule.field);
    const op = ruleOperator(rule);
    let values: string;
    const count = ruleValueCount(rule);
    if (count === 0) { values = '(nothing picked)'; }
    else if (op === RuleOp.BETWEEN && count >= 2) {
      return `${SearchSets.ruleFieldLabel(rule)} is between ${ruleValueAt(rule, 0)} and ${ruleValueAt(rule, 1)}`;
    } else {
      const shown = Math.min(count, 3);
      const parts: string[] = [];
      for (let i = 0; i < shown; i++) { parts.push(SearchSets.valueLabel(field, ruleValueAt(rule, i), RuleOp.isText(op), scene)); }
      values = parts.join(', ') + (count > shown ? ` +${count - shown} more` : '');
    }
    return `${SearchSets.ruleFieldLabel(rule)} ${RuleOp.words(op)} ${values}`;
  },

  /** How one value reads: a catalogue key as its label, the host model, a link by its title, "(empty)". */
  valueLabel(field: string, value: string, text: boolean, scene: SceneData | null): string {
    field = RuleField.normalise(field);
    value ??= '';
    if (text) { return value.length === 0 ? '(empty)' : value; }
    if (field === RuleField.CATALOG) { return findCategory(value)?.label ?? (value.length === 0 ? '(empty)' : value); }
    if (field === RuleField.LINK) {
      if (value.length === 0) { return 'the host model'; }
      const link = scene?.links.find(l => sameText(l.instanceUniqueId, value));
      return link ? linkLabel(link) : value;
    }
    if (field === RuleField.FAMILY && value.length === 0) { return '(system families)'; }
    if (field === RuleField.PHASE) { return RuleField.phaseLabel(value); }
    if (field === RuleField.PARAMETER && value.length === 0) { return SearchSets.NO_VALUE; }
    return value.length === 0 ? '(empty)' : value;
  },

  /** A field's label ("BimGo category", "Revit category", "Family", "Type", "Level", "Model", "Phase"); a parameter by its name. */
  fieldLabel(field: string, parameter: string | null = null): string {
    switch (RuleField.normalise(field)) {
      case RuleField.CATALOG: return 'BimGo category';
      case RuleField.CATEGORY: return 'Revit category';
      case RuleField.FAMILY: return 'Family';
      case RuleField.TYPE: return 'Type';
      case RuleField.LEVEL: return 'Level';
      case RuleField.PHASE: return 'Phase';
      case RuleField.PARAMETER: return parameter && parameter.trim() ? parameter.trim() : 'Parameter';
      default: return 'Model';
    }
  },

  /** A rule's field label, a parameter rule by its parameter's name. */
  ruleFieldLabel(rule: SetRule | null): string {
    return rule ? SearchSets.fieldLabel(rule.field, rule.parameter) : '';
  },

  /** Catalogue keys of the seeded "Structure" set. */
  STRUCTURE_KEYS: ['structcolumns', 'framing', 'foundations', 'floors'] as readonly string[],
  /** Catalogue keys of the seeded "Services" set. */
  SERVICES_KEYS: ['ducts', 'pipes', 'cabletrays', 'conduits', 'mechequipment', 'sprinklers', 'airterminals'] as readonly string[],

  /** A new document with the two starter sets and tests (Structure × Services, Services × Services; hard, 5 mm). */
  seeded(): ClashDocument {
    const structure = SearchSets.setOfCatalog('Structure', SearchSets.STRUCTURE_KEYS);
    const services = SearchSets.setOfCatalog('Services', SearchSets.SERVICES_KEYS);
    const document = emptyClashDocument();
    document.sets.push(structure, services);
    const a = newTest('Structure × Services');
    a.kind = ClashKind.HARD;
    a.setA = structure.id;
    a.setB = services.id;
    a.tolerance = ClashDefaults.HARD_TOLERANCE;
    const b = newTest('Services × Services');
    b.setA = services.id;
    b.setB = null;
    document.tests.push(a, b);
    return document;
  },

  /** A set holding the elements of some catalogue categories (any of them). */
  setOfCatalog(name: string, keys: readonly string[]): SearchSet {
    const set = newSet(name);
    set.rules = keys.map(k => normaliseRule(newRule(RuleField.CATALOG, RuleOp.IS, [k])));
    return set;
  }
};

/** Colour round B: at least / at most / between on the first number of the element's field text. */
function numberMatches(rule: SetRule, op: string, scene: SceneData, element: ElementRecord, index: number): boolean {
  const number = SearchSets.numberOf(scene, element, index, rule.field, rule.parameter);
  if (number === null) { return false; }
  const a = ruleValueCount(rule) >= 1 ? RuleNumbers.tryParse(ruleValueAt(rule, 0)) : null;
  if (a === null) { return false; }
  if (op === RuleOp.AT_LEAST) { return number >= a; }
  if (op === RuleOp.AT_MOST) { return number <= a; }
  const b = ruleValueCount(rule) >= 2 ? RuleNumbers.tryParse(ruleValueAt(rule, 1)) : null;
  if (b === null) { return false; }
  return number >= Math.min(a, b) && number <= Math.max(a, b);
}

/** One value against one element's field. */
function valueMatches(field: string, contains: boolean, value: string, scene: SceneData, element: ElementRecord): boolean {
  switch (field) {
    case RuleField.CATALOG: {
      // The catalogue key, or its label (so "Ducts + fittings" and "ducts" both work)
      const def = CATEGORIES[element.categoryIndex];
      return !!def && (compare(def.key, value, contains) || compare(def.label, value, contains));
    }
    case RuleField.CATEGORY: return compare(element.categoryName, value, contains);
    case RuleField.FAMILY: return compare(SearchSets.splitFamilyType(element.familyType).family, value, contains);
    case RuleField.TYPE: return compare(SearchSets.splitFamilyType(element.familyType).type, value, contains);
    case RuleField.LEVEL: return compare(element.levelName, value, contains);
    case RuleField.PHASE: {
      // Colour round A: the stored value ("new"), or its label ("New") for typed text
      const stored = RuleField.phaseValue(element.phase);
      return compare(stored, value, contains) || compare(RuleField.phaseLabel(stored), value, contains);
    }
    case RuleField.LINK: {
      // Empty value = the host model; else the link instance's UniqueId, or its name / title
      const link = linkOf(scene, element);
      if (value.length === 0) { return !link && element.link <= 0; }
      if (!link) { return false; }
      return sameText(link.instanceUniqueId, value) || compare(link.name, value, contains) || compare(linkLabel(link), value, contains);
    }
    default: return false;
  }
}

function compare(text: string | null, value: string, contains: boolean): boolean {
  const t = text ?? '';
  return contains ? value.length === 0 || lower(t).includes(lower(value)) : sameText(t.trim(), value);
}
