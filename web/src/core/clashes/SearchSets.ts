import { CATEGORIES, findCategory } from '../scene/CategoryCatalog';
import { linkLabel } from '../scene/LinkInfo';
import { type ElementRecord, linkOf, type SceneData } from '../scene/SceneData';
import {
  type ClashDocument, ClashDefaults, ClashKind, emptyClashDocument, groupHasConditions, newRule, newSet, newTest, normaliseRule, type RuleGroup,
  RuleField, RuleOp, ruleIsComplete, ruleOperator, ruleValueAt, ruleValueCount, type SearchSet, type SetRule
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
  /**
   * True when an element belongs to a set: it matches the adding rules and groups (any, or all with matchAll; none =
   * every element) and no top-level "not" rule. Rules with no value yet are left out; library templates never belong.
   */
  matches(set: SearchSet, scene: SceneData, element: ElementRecord): boolean {
    if (!set || !element || element.isLibraryTemplate) { return false; }
    let anyInclude = false, included = set.matchAll;
    for (const rule of set.rules ?? []) {
      if (!rule || !ruleIsComplete(rule)) { continue; }
      const hit = SearchSets.ruleMatches(rule, scene, element);
      if (RuleOp.isNegative(ruleOperator(rule))) {
        if (hit) { return false; }
        continue;
      }
      anyInclude = true;
      included = set.matchAll ? included && hit : included || hit;
    }
    for (const group of set.groups ?? []) {
      if (!group || !groupHasConditions(group)) { continue; }
      const hit = SearchSets.groupMatches(group, scene, element);
      anyInclude = true;
      included = set.matchAll ? included && hit : included || hit;
    }
    return !anyInclude || included;
  },

  /** True when an element meets a group (inside it, a "not" rule is true for elements whose field does not match). */
  groupMatches(group: RuleGroup, scene: SceneData, element: ElementRecord): boolean {
    let any = false, result = group.matchAll;
    for (const rule of group.rules ?? []) {
      if (!rule || !ruleIsComplete(rule)) { continue; }
      let hit = SearchSets.ruleMatches(rule, scene, element);
      if (RuleOp.isNegative(ruleOperator(rule))) { hit = !hit; }
      any = true;
      result = group.matchAll ? result && hit : result || hit;
    }
    return any && result;
  },

  /** True when an element's field matches one of a rule's values (equals, or contains for the text operators), ignoring "not". */
  ruleMatches(rule: SetRule, scene: SceneData, element: ElementRecord): boolean {
    const contains = RuleOp.isText(ruleOperator(rule));
    const count = ruleValueCount(rule);
    for (let i = 0; i < count; i++) {
      const value = ruleValueAt(rule, i).trim();
      if (contains && value.length === 0) { continue; }
      if (valueMatches(rule.field, contains, value, scene, element)) { return true; }
    }
    return false;
  },

  /** The indices of a scene's elements in a set (library templates left out). */
  elementsIn(set: SearchSet, scene: SceneData): number[] {
    const result: number[] = [];
    if (!set) { return result; }
    scene.elements.forEach((e, i) => { if (SearchSets.matches(set, scene, e)) { result.push(i); } });
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
   */
  valuesOf(scene: SceneData, field: string): RuleValue[] {
    field = RuleField.normalise(field);
    const counts = new Map<string, RuleValue>();
    for (const e of scene.elements) {
      if (!e || e.isLibraryTemplate) { continue; }
      let value: string, label: string;
      switch (field) {
        case RuleField.CATALOG: {
          const def = CATEGORIES[e.categoryIndex];
          if (!def) { continue; }
          value = def.key;
          label = def.label;
          break;
        }
        case RuleField.CATEGORY:
          value = label = e.categoryName ?? '';
          break;
        case RuleField.FAMILY:
          value = SearchSets.splitFamilyType(e.familyType).family;
          label = value.length === 0 ? '(system families)' : value;
          break;
        case RuleField.TYPE:
          value = label = SearchSets.splitFamilyType(e.familyType).type;
          break;
        case RuleField.LEVEL:
          value = label = e.levelName ?? '';
          break;
        default: {
          const link = linkOf(scene, e);
          value = !link ? '' : link.instanceUniqueId || link.name;
          label = !link ? 'Host model' : linkLabel(link);
        }
      }
      if (field !== RuleField.LINK && field !== RuleField.FAMILY && value.trim().length === 0) { continue; }
      const key = lower(value);
      const known = counts.get(key);
      if (known) { known.count++; } else { counts.set(key, { value, label, count: 1 }); }
    }
    return [...counts.values()].sort((x, y) => x.label.localeCompare(y.label, undefined, { sensitivity: 'accent' }));
  },

  /** How a rule reads for people ("BimGo category is one of Ducts, Pipes", "Level is not Level 2"). */
  describe(rule: SetRule, scene: SceneData | null): string {
    const field = RuleField.normalise(rule.field);
    const op = ruleOperator(rule);
    let values: string;
    const count = ruleValueCount(rule);
    if (count === 0) { values = '(nothing picked)'; }
    else {
      const shown = Math.min(count, 3);
      const parts: string[] = [];
      for (let i = 0; i < shown; i++) { parts.push(SearchSets.valueLabel(field, ruleValueAt(rule, i), RuleOp.isText(op), scene)); }
      values = parts.join(', ') + (count > shown ? ` +${count - shown} more` : '');
    }
    return `${SearchSets.fieldLabel(field)} ${RuleOp.words(op)} ${values}`;
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
    return value.length === 0 ? '(empty)' : value;
  },

  /** A field's label ("BimGo category", "Revit category", "Family", "Type", "Level", "Model"). */
  fieldLabel(field: string): string {
    switch (RuleField.normalise(field)) {
      case RuleField.CATALOG: return 'BimGo category';
      case RuleField.CATEGORY: return 'Revit category';
      case RuleField.FAMILY: return 'Family';
      case RuleField.TYPE: return 'Type';
      case RuleField.LEVEL: return 'Level';
      default: return 'Model';
    }
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

/** One value against one element's field. */
function valueMatches(field: string, contains: boolean, value: string, scene: SceneData, element: ElementRecord): boolean {
  switch (RuleField.normalise(field)) {
    case RuleField.CATALOG: {
      // The catalogue key, or its label (so "Ducts + fittings" and "ducts" both work)
      const def = CATEGORIES[element.categoryIndex];
      return !!def && (compare(def.key, value, contains) || compare(def.label, value, contains));
    }
    case RuleField.CATEGORY: return compare(element.categoryName, value, contains);
    case RuleField.FAMILY: return compare(SearchSets.splitFamilyType(element.familyType).family, value, contains);
    case RuleField.TYPE: return compare(SearchSets.splitFamilyType(element.familyType).type, value, contains);
    case RuleField.LEVEL: return compare(element.levelName, value, contains);
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
