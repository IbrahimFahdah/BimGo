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
        /// <param name="scene">The snapshot (for links).</param>
        /// <param name="element">The element.</param>
        public static bool Matches(SearchSet set, SceneData scene, ElementRecord element)
        {
            if (set == null || element == null || element.IsLibraryTemplate) { return false; }

            bool anyInclude = false, included = set.MatchAll;
            foreach (SetRule rule in set.Rules ?? Enumerable.Empty<SetRule>())
            {
                if (rule == null || !rule.IsComplete) { continue; }
                bool hit = RuleMatches(rule, scene, element);
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
                bool hit = GroupMatches(group, scene, element);
                anyInclude = true;
                included = set.MatchAll ? included && hit : included || hit;
            }
            return !anyInclude || included;
        }

        /// <summary>
        /// C-B4: true when an element meets a group: any (or all, with <see cref="RuleGroup.MatchAll"/>) of its rules
        /// with a value, a "not" rule being true for elements whose field does not match. No rule with a value: false
        /// (callers leave such groups out).
        /// </summary>
        public static bool GroupMatches(RuleGroup group, SceneData scene, ElementRecord element)
        {
            bool any = false, result = group.MatchAll;
            foreach (SetRule rule in group.Rules ?? Enumerable.Empty<SetRule>())
            {
                if (rule == null || !rule.IsComplete) { continue; }
                bool hit = RuleMatches(rule, scene, element);
                if (RuleOp.IsNegative(rule.Operator)) { hit = !hit; }
                any = true;
                result = group.MatchAll ? result && hit : result || hit;
            }
            return any && result;
        }

        /// <summary>
        /// True when an element's field matches a rule's values, ignoring case and the rule's "not": equals one of the
        /// values (is / is one of / is not / is not any of), or contains one of the texts (contains / does not contain).
        /// </summary>
        public static bool RuleMatches(SetRule rule, SceneData scene, ElementRecord element)
        {
            bool contains = RuleOp.IsText(rule.Operator);
            int count = rule.ValueCount;
            for (int i = 0; i < count; i++)
            {
                string value = rule.ValueAt(i).Trim();
                if (contains && value.Length == 0) { continue; } // empty text: no condition
                if (ValueMatches(rule.Field, contains, value, scene, element)) { return true; }
            }
            return false;
        }

        /// <summary>One value against one element's field.</summary>
        private static bool ValueMatches(string field, bool contains, string value, SceneData scene, ElementRecord element)
        {
            switch (RuleField.Normalise(field))
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
                if (Matches(set, scene, scene.Elements[i])) { result.Add(i); }
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
        /// </summary>
        public static List<RuleValue> ValuesOf(SceneData scene, string field)
        {
            field = RuleField.Normalise(field);
            var counts = new Dictionary<string, (string Label, int Count)>(StringComparer.CurrentCultureIgnoreCase);
            if (scene?.Elements == null) { return new List<RuleValue>(); }

            foreach (ElementRecord e in scene.Elements)
            {
                if (e == null || e.IsLibraryTemplate) { continue; }
                string value, label;
                switch (field)
                {
                    case RuleField.CATALOG:
                    {
                        CategoryDef def = e.CategoryIndex >= 0 && e.CategoryIndex < CategoryCatalog.All.Count ? CategoryCatalog.All[e.CategoryIndex] : null;
                        if (def == null) { continue; }
                        value = def.Key;
                        label = def.Label;
                        break;
                    }
                    case RuleField.CATEGORY:
                        value = label = e.CategoryName ?? string.Empty;
                        break;
                    case RuleField.FAMILY:
                        SplitFamilyType(e.FamilyType, out value, out _);
                        label = value.Length == 0 ? "(system families)" : value;
                        break;
                    case RuleField.TYPE:
                        SplitFamilyType(e.FamilyType, out _, out value);
                        label = value;
                        break;
                    case RuleField.LEVEL:
                        value = label = e.LevelName ?? string.Empty;
                        break;
                    default:
                    {
                        LinkInfo link = scene.LinkOf(e);
                        value = link == null ? string.Empty : (string.IsNullOrEmpty(link.InstanceUniqueId) ? link.Name : link.InstanceUniqueId);
                        label = link == null ? "Host model" : link.Label;
                        break;
                    }
                }
                if (field != RuleField.LINK && field != RuleField.FAMILY && string.IsNullOrWhiteSpace(value)) { continue; }
                counts[value] = counts.TryGetValue(value, out (string Label, int Count) known) ? (known.Label, known.Count + 1) : (label, 1);
            }

            var result = counts.Select(kv => new RuleValue(kv.Key, kv.Value.Label, kv.Value.Count)).ToList();
            result.Sort((x, y) => string.Compare(x.Label, y.Label, StringComparison.CurrentCultureIgnoreCase));
            return result;
        }

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
                int shown = Math.Min(rule.ValueCount, 3);
                for (int i = 0; i < shown; i++) { parts.Add(ValueLabel(field, rule.ValueAt(i), RuleOp.IsText(op), scene)); }
                values = string.Join(", ", parts) + (rule.ValueCount > shown ? $" +{rule.ValueCount - shown} more" : string.Empty);
            }
            return $"{FieldLabel(field)} {RuleOp.Words(op)} {values}";
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
            return value.Length == 0 ? "(empty)" : value;
        }

        /// <summary>A field's label ("BimGo category", "Revit category", "Family", "Type", "Level", "Model").</summary>
        public static string FieldLabel(string field) => RuleField.Normalise(field) switch
        {
            RuleField.CATALOG => "BimGo category",
            RuleField.CATEGORY => "Revit category",
            RuleField.FAMILY => "Family",
            RuleField.TYPE => "Type",
            RuleField.LEVEL => "Level",
            _ => "Model"
        };

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
