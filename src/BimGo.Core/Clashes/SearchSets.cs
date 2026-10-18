using BimGo.Scene;

// The class belongs to the Clashes namespace
namespace BimGo.Clashes
{
    /// <summary>
    /// One value a rule field takes in the model: what is stored, what people read, how many elements have it.
    /// </summary>
    public readonly record struct RuleValue(string Value, string Label, int Count);

    /// <summary>
    /// Evaluates search sets against a snapshot's elements (Round C, stage 1) and seeds the starter sets and tests.
    /// </summary>
    public static class SearchSets
    {
        #region Matching

        /// <summary>
        /// True when an element belongs to a set: it matches the adding rules and groups (any, or all with
        /// <see cref="SearchSet.MatchAll"/>; none = every element) and no top-level "not" rule (those always take
        /// elements out). Rules with no value yet and groups without one are left out. Library templates never belong
        /// to a set.
        /// </summary>
        /// <param name="set">The set.</param>
        /// <param name="scene">The snapshot (for links and parameters).</param>
        /// <param name="element">The element.</param>
        /// <param name="index">
        /// Colour round A: the element's index in <c>scene.Elements</c> (parameter rules read its row), or −1 when it has
        /// none (a stand-in: parameter rules then see no value).
        /// </param>
        public static bool Matches(SearchSet set, SceneData scene, ElementRecord element, int index = -1)
        {
            if (set == null || element == null || element.IsLibraryTemplate) { return false; }

            bool anyInclude = false, included = set.MatchAll;
            foreach (SetRule rule in set.Rules ?? Enumerable.Empty<SetRule>())
            {
                if (rule == null || !rule.IsComplete) { continue; }
                bool hit = RuleMatches(rule, scene, element, index);
                if (RuleOp.IsNegative(rule.Operator))
                {
                    if (hit) { return false; }
                    continue;
                }
                anyInclude = true;
                included = set.MatchAll ? included && hit : included || hit;
            }

            // C-B4: each group with a condition is one more condition (inside it, "not" rules are ordinary conditions)
            foreach (RuleGroup group in set.Groups ?? Enumerable.Empty<RuleGroup>())
            {
                if (group == null || !group.HasConditions) { continue; }
                bool hit = GroupMatches(group, scene, element, index);
                anyInclude = true;
                included = set.MatchAll ? included && hit : included || hit;
            }
            return !anyInclude || included;
        }

        /// <summary>
        /// C-B4: true when an element meets a group: any (or all, with <see cref="RuleGroup.MatchAll"/>) of its rules
        /// with a value, a "not" rule being true for elements whose field does not match. Polish round P-C: each group
        /// inside with a condition is one more condition (to any depth). No condition at all: false (callers leave such
        /// groups out).
        /// </summary>
        public static bool GroupMatches(RuleGroup group, SceneData scene, ElementRecord element, int index = -1)
        {
            bool any = false, result = group.MatchAll;
            foreach (SetRule rule in group.Rules ?? Enumerable.Empty<SetRule>())
            {
                if (rule == null || !rule.IsComplete) { continue; }
                bool hit = RuleMatches(rule, scene, element, index);
                if (RuleOp.IsNegative(rule.Operator)) { hit = !hit; }
                any = true;
                result = group.MatchAll ? result && hit : result || hit;
                if (group.MatchAll ? !result : result) { return result; } // decided: no need to read further
            }
            foreach (RuleGroup inner in group.Groups ?? Enumerable.Empty<RuleGroup>())
            {
                if (inner == null || !inner.HasConditions) { continue; }
                bool hit = GroupMatches(inner, scene, element, index);
                any = true;
                result = group.MatchAll ? result && hit : result || hit;
                if (group.MatchAll ? !result : result) { return result; }
            }
            return any && result;
        }

        /// <summary>
        /// True when an element's field matches a rule's values, ignoring case and the rule's "not": equals one of the
        /// values (is / is one of / is not / is not any of), or contains one of the texts (contains / does not contain).
        /// </summary>
        public static bool RuleMatches(SetRule rule, SceneData scene, ElementRecord element, int index = -1)
        {
            if (RuleOp.IsNumeric(rule.Operator)) { return NumberMatches(rule, scene, element, index); }
            bool contains = RuleOp.IsText(rule.Operator);
            int count = rule.ValueCount;

            // Colour round A: a parameter rule reads the element's value once (missing = empty)
            string field = RuleField.Normalise(rule.Field);
            string parameterValue = field == RuleField.PARAMETER ? ParameterValue(scene, index, rule.Parameter) ?? string.Empty : null;
            for (int i = 0; i < count; i++)
            {
                string value = rule.ValueAt(i).Trim();
                if (contains && value.Length == 0) { continue; } // empty text: no condition
                if (parameterValue != null)
                {
                    if (Compare(parameterValue, value, contains)) { return true; }
                    continue;
                }
                if (ValueMatches(field, contains, value, scene, element)) { return true; }
            }
            return false;
        }

        /// <summary>
        /// Colour round B: at least / at most / between on the first number of the element's field text (no number: no
        /// match).
        /// </summary>
        private static bool NumberMatches(SetRule rule, SceneData scene, ElementRecord element, int index)
        {
            if (!NumberOf(scene, element, index, rule.Field, rule.Parameter, out double number)) { return false; }
            if (rule.ValueCount < 1 || !RuleNumbers.TryParse(rule.ValueAt(0), out double a)) { return false; }
            switch (rule.Operator)
            {
                case RuleOp.AT_LEAST:
                    return number >= a;
                case RuleOp.AT_MOST:
                    return number <= a;
                default:
                    if (rule.ValueCount < 2 || !RuleNumbers.TryParse(rule.ValueAt(1), out double b)) { return false; }
                    return number >= Math.Min(a, b) && number <= Math.Max(a, b);
            }
        }

        /// <summary>
        /// Colour round B: the first number in an element's field text (a parameter's value, a type name "600x300"…),
        /// or false.
        /// </summary>
        public static bool NumberOf(SceneData scene, ElementRecord element, int index, string field, string parameter, out double number)
        {
            number = 0;
            field = RuleField.Normalise(field);
            string text;
            if (field == RuleField.PARAMETER) { text = ParameterValue(scene, index, parameter); }
            else if (!ElementValue(scene, element, index, field, -1, out text, out _)) { return false; }
            return RuleNumbers.TryParse(text, out number);
        }

        /// <summary>
        /// Colour round A: an element's value of an extracted parameter (instance, else type; display text), or null when
        /// it doesn't have it or the parameter wasn't extracted.
        /// </summary>
        /// <param name="scene">The snapshot.</param>
        /// <param name="index">The element's index in <c>scene.Elements</c> (−1: none).</param>
        /// <param name="parameter">The parameter's name.</param>
        public static string ParameterValue(SceneData scene, int index, string parameter)
        {
            ParameterTable table = scene?.Parameters;
            if (table == null || table.IsEmpty || index < 0) { return null; }
            return table.ValueOf(index, table.IndexOfName(parameter));
        }

        /// <summary>One value against one element's field.</summary>
        private static bool ValueMatches(string field, bool contains, string value, SceneData scene, ElementRecord element)
        {
            switch (field)
            {
                case RuleField.CATALOG:
                {
                    // The catalogue key, or its label (so "Ducts + fittings" and "ducts" both work)
                    CategoryDef def = element.CategoryIndex >= 0 && element.CategoryIndex < CategoryCatalog.All.Count
                        ? CategoryCatalog.All[element.CategoryIndex] : null;
                    return def != null && (Compare(def.Key, value, contains) || Compare(def.Label, value, contains));
                }
                case RuleField.CATEGORY:
                    return Compare(element.CategoryName, value, contains);
                case RuleField.FAMILY:
                    SplitFamilyType(element.FamilyType, out string family, out _);
                    return Compare(family, value, contains);
                case RuleField.TYPE:
                    SplitFamilyType(element.FamilyType, out _, out string type);
                    return Compare(type, value, contains);
                case RuleField.LEVEL:
                    return Compare(element.LevelName, value, contains);
                case RuleField.PHASE:
                    // Colour round A: the stored value ("new"), or its label ("New") for typed text
                    return Compare(RuleField.PhaseValue(element.Phase), value, contains)
                        || Compare(RuleField.PhaseLabel(RuleField.PhaseValue(element.Phase)), value, contains);
                case RuleField.LINK:
                {
                    // Empty value = the host model; else the link instance's UniqueId, or its name / title
                    LinkInfo link = scene?.LinkOf(element);
                    if (value.Length == 0) { return link == null && !element.IsLinked; }
                    if (link == null) { return false; }
                    return string.Equals(link.InstanceUniqueId, value, StringComparison.OrdinalIgnoreCase)
                        || Compare(link.Name, value, contains) || Compare(link.Label, value, contains);
                }
                default:
                    return false;
            }
        }

        /// <summary>
        /// The indices of a scene's elements in a set (library templates left out).
        /// </summary>
        public static List<int> ElementsIn(SearchSet set, SceneData scene)
        {
            var result = new List<int>();
            if (set == null || scene?.Elements == null) { return result; }
            for (int i = 0; i < scene.Elements.Length; i++)
            {
                if (Matches(set, scene, scene.Elements[i], i)) { result.Add(i); }
            }
            return result;
        }

        /// <summary>
        /// Splits "Family: Type" (system families have only the type name, so the family is empty).
        /// </summary>
        public static void SplitFamilyType(string familyType, out string family, out string type)
        {
            familyType ??= string.Empty;
            int colon = familyType.IndexOf(": ", StringComparison.Ordinal);
            if (colon < 0)
            {
                family = string.Empty;
                type = familyType.Trim();
                return;
            }
            family = familyType[..colon].Trim();
            type = familyType[(colon + 2)..].Trim();
        }

        private static bool Compare(string text, string value, bool contains)
        {
            text ??= string.Empty;
            return contains
                ? value.Length == 0 || text.Contains(value, StringComparison.CurrentCultureIgnoreCase)
                : string.Equals(text.Trim(), value, StringComparison.CurrentCultureIgnoreCase);
        }

        #endregion

        #region Values in the model

        /// <summary>
        /// The values a rule field takes in the model (for the rule value picker): stored value, label, element count;
        /// sorted by label. Library templates are left out. Catalogue values are keys (labelled by their names); the
        /// link field's host value is empty (labelled "Host model"), links are their instance UniqueIds (labelled by title).
        /// Colour round A: phase values are "existing" / "new"… (labelled); a parameter's values are its texts, with the
        /// elements that don't have it (or have it empty) as the empty value, labelled "(no value)".
        /// </summary>
        /// <param name="scene">The snapshot.</param>
        /// <param name="field">The field (<see cref="RuleField"/>).</param>
        /// <param name="parameter">The parameter's name, for <see cref="RuleField.PARAMETER"/>.</param>
        public static List<RuleValue> ValuesOf(SceneData scene, string field, string parameter = null)
        {
            field = RuleField.Normalise(field);
            var counts = new Dictionary<string, (string Label, int Count)>(StringComparer.CurrentCultureIgnoreCase);
            if (scene?.Elements == null) { return new List<RuleValue>(); }

            ParameterTable table = scene.Parameters ?? ParameterTable.Empty;
            int nameIndex = field == RuleField.PARAMETER ? table.IndexOfName(parameter) : -1;
            for (int i = 0; i < scene.Elements.Length; i++)
            {
                ElementRecord e = scene.Elements[i];
                if (e == null || e.IsLibraryTemplate) { continue; }
                if (!ElementValue(scene, e, i, field, nameIndex, out string value, out string label)) { continue; }
                counts[value] = counts.TryGetValue(value, out (string Label, int Count) known) ? (known.Label, known.Count + 1) : (label, 1);
            }

            var result = counts.Select(kv => new RuleValue(kv.Key, kv.Value.Label, kv.Value.Count)).ToList();

            // Colour round B: links of one model share its title: those read as their instance names instead
            if (field == RuleField.LINK)
            {
                var shared = new HashSet<string>(result.GroupBy(v => v.Label, StringComparer.CurrentCultureIgnoreCase).Where(g => g.Count() > 1).Select(g => g.Key),
                    StringComparer.CurrentCultureIgnoreCase);
                for (int i = 0; i < result.Count; i++)
                {
                    if (!shared.Contains(result[i].Label) || result[i].Value.Length == 0) { continue; }
                    string id = result[i].Value;
                    LinkInfo link = scene.Links?.FirstOrDefault(l => string.Equals(l.InstanceUniqueId, id, StringComparison.OrdinalIgnoreCase) || l.Name == id);
                    if (link != null && !string.IsNullOrWhiteSpace(link.Name)) { result[i] = result[i] with { Label = link.Name }; }
                }
            }
            result.Sort((x, y) => string.Compare(x.Label, y.Label, StringComparison.CurrentCultureIgnoreCase));
            return result;
        }

        /// <summary>
        /// One element's value of a field as stored in a rule, and its label (<see cref="ValuesOf"/>); false when the
        /// element has no value worth listing (a blank category, type or level). Parameters: pass the name's index
        /// (<see cref="ParameterTable.IndexOfName"/>); a missing or blank value is the empty value, "(no value)".
        /// </summary>
        public static bool ElementValue(SceneData scene, ElementRecord e, int index, string field, int nameIndex, out string value, out string label)
        {
            switch (field)
            {
                case RuleField.CATALOG:
                {
                    CategoryDef def = e.CategoryIndex >= 0 && e.CategoryIndex < CategoryCatalog.All.Count ? CategoryCatalog.All[e.CategoryIndex] : null;
                    value = def?.Key ?? string.Empty;
                    label = def?.Label ?? string.Empty;
                    return def != null;
                }
                case RuleField.CATEGORY:
                    value = label = e.CategoryName ?? string.Empty;
                    break;
                case RuleField.FAMILY:
                    SplitFamilyType(e.FamilyType, out value, out _);
                    label = value.Length == 0 ? "(system families)" : value;
                    return true;
                case RuleField.TYPE:
                    SplitFamilyType(e.FamilyType, out _, out value);
                    label = value;
                    break;
                case RuleField.LEVEL:
                    value = label = e.LevelName ?? string.Empty;
                    break;
                case RuleField.PHASE:
                    value = RuleField.PhaseValue(e.Phase);
                    label = RuleField.PhaseLabel(value);
                    return true;
                case RuleField.PARAMETER:
                {
                    string text = scene?.Parameters?.ValueOf(index, nameIndex);
                    value = string.IsNullOrWhiteSpace(text) ? string.Empty : text.Trim();
                    label = value.Length == 0 ? NO_VALUE : value;
                    return true;
                }
                default:
                {
                    LinkInfo link = scene?.LinkOf(e);
                    value = link == null ? string.Empty : (string.IsNullOrEmpty(link.InstanceUniqueId) ? link.Name : link.InstanceUniqueId);
                    label = link == null ? "Host model" : link.Label;
                    return true;
                }
            }
            return !string.IsNullOrWhiteSpace(value);
        }

        /// <summary>Colour round A: the label of a parameter's empty value (elements without it, or with it blank).</summary>
        public const string NO_VALUE = "(no value)";

        /// <summary>
        /// How a rule reads for people ("BimGo category is one of Ducts, Pipes", "Type contains 600", "Level is not
        /// Level 2"); a long list shows its first three values and how many more.
        /// </summary>
        public static string Describe(SetRule rule, SceneData scene)
        {
            string field = RuleField.Normalise(rule.Field);
            string op = rule.Operator;
            string values;
            if (rule.ValueCount == 0) { values = "(nothing picked)"; }
            else
            {
                var parts = new List<string>();
                if (op == RuleOp.BETWEEN && rule.ValueCount >= 2) { return $"{FieldLabel(rule)} is between {rule.ValueAt(0)} and {rule.ValueAt(1)}"; }
                int shown = Math.Min(rule.ValueCount, 3);
                for (int i = 0; i < shown; i++) { parts.Add(ValueLabel(field, rule.ValueAt(i), RuleOp.IsText(op), scene)); }
                values = string.Join(", ", parts) + (rule.ValueCount > shown ? $" +{rule.ValueCount - shown} more" : string.Empty);
            }
            return $"{FieldLabel(rule)} {RuleOp.Words(op)} {values}";
        }

        /// <summary>
        /// How one value reads: a catalogue key as its label, the host model, a link by its title, "(empty)".
        /// </summary>
        public static string ValueLabel(string field, string value, bool text, SceneData scene)
        {
            field = RuleField.Normalise(field);
            value ??= string.Empty;
            if (text) { return value.Length == 0 ? "(empty)" : value; }
            if (field == RuleField.CATALOG) { return CategoryCatalog.Find(value)?.Label ?? (value.Length == 0 ? "(empty)" : value); }
            if (field == RuleField.LINK)
            {
                if (value.Length == 0) { return "the host model"; }
                LinkInfo link = scene?.Links?.FirstOrDefault(l => string.Equals(l.InstanceUniqueId, value, StringComparison.OrdinalIgnoreCase));
                return link?.Label ?? value;
            }
            if (field == RuleField.FAMILY && value.Length == 0) { return "(system families)"; }
            if (field == RuleField.PHASE) { return RuleField.PhaseLabel(value); }
            if (field == RuleField.PARAMETER && value.Length == 0) { return NO_VALUE; }
            return value.Length == 0 ? "(empty)" : value;
        }

        /// <summary>A field's label ("BimGo category", "Revit category", "Family", "Type", "Level", "Model", "Phase", "Parameter").</summary>
        public static string FieldLabel(string field) => RuleField.Normalise(field) switch
        {
            RuleField.CATALOG => "BimGo category",
            RuleField.CATEGORY => "Revit category",
            RuleField.FAMILY => "Family",
            RuleField.TYPE => "Type",
            RuleField.LEVEL => "Level",
            RuleField.PHASE => "Phase",
            RuleField.PARAMETER => "Parameter",
            _ => "Model"
        };

        /// <summary>Colour round A: a field's label, a parameter by its name ("Fire Rating").</summary>
        public static string FieldLabel(string field, string parameter) =>
            RuleField.Normalise(field) == RuleField.PARAMETER && !string.IsNullOrWhiteSpace(parameter) ? parameter.Trim() : FieldLabel(field);

        /// <summary>Colour round A: a rule's field label, a parameter rule by its parameter's name.</summary>
        public static string FieldLabel(SetRule rule) => rule == null ? string.Empty : FieldLabel(rule.Field, rule.Parameter);

        #endregion

        #region Starter sets and tests

        /// <summary>Catalogue keys of the seeded "Structure" set.</summary>
        public static readonly string[] STRUCTURE_KEYS = { "structcolumns", "framing", "foundations", "floors" };

        /// <summary>Catalogue keys of the seeded "Services" set.</summary>
        public static readonly string[] SERVICES_KEYS = { "ducts", "pipes", "cabletrays", "conduits", "mechequipment", "sprinklers", "airterminals" };

        /// <summary>
        /// A new document with the two starter sets (Structure, Services: catalogue rules, editable) and tests
        /// (Structure × Services and Services × Services, hard, 5 mm).
        /// </summary>
        public static ClashDocument Seeded()
        {
            SearchSet structure = SetOfCatalog("Structure", STRUCTURE_KEYS);
            SearchSet services = SetOfCatalog("Services", SERVICES_KEYS);
            return new ClashDocument
            {
                Sets = { structure, services },
                Tests =
                {
                    new ClashTest { Name = "Structure × Services", Kind = ClashKind.HARD, SetA = structure.Id, SetB = services.Id, Tolerance = ClashDefaults.HARD_TOLERANCE },
                    new ClashTest { Name = "Services × Services", Kind = ClashKind.HARD, SetA = services.Id, SetB = null, Tolerance = ClashDefaults.HARD_TOLERANCE }
                }
            };
        }

        /// <summary>
        /// A set holding the elements of some catalogue categories (any of them).
        /// </summary>
        public static SearchSet SetOfCatalog(string name, IEnumerable<string> keys) => new()
        {
            Name = name,
            MatchAll = false,
            Rules = keys.Select(k => new SetRule { Field = RuleField.CATALOG, Op = RuleOp.IS, Values = { k } }.Normalise()).ToList()
        };

        #endregion
    }
}
