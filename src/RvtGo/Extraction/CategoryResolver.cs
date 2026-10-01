using RvtGo.Scene;

// The class belongs to the Extraction namespace
namespace RvtGo.Extraction
{
    /// <summary>
    /// Resolves catalog definitions to Revit BuiltInCategory values for the running Revit version.
    /// Names that don't exist in this version are skipped silently (and logged once).
    /// </summary>
    internal static class CategoryResolver
    {
        private static readonly Dictionary<string, BuiltInCategory[]> CACHE = new();

        /// <summary>
        /// Gets the built-in categories of a definition.
        /// </summary>
        /// <param name="def">The category definition.</param>
        /// <returns>An array (possibly empty).</returns>
        public static BuiltInCategory[] Resolve(CategoryDef def)
        {
            lock (CACHE)
            {
                if (CACHE.TryGetValue(def.Key, out BuiltInCategory[] cached)) { return cached; }

                var resolved = new List<BuiltInCategory>();
                foreach (string name in def.BuiltInCategoryNames)
                {
                    if (Enum.TryParse(name, out BuiltInCategory bic))
                    {
                        resolved.Add(bic);
                    }
                    else
                    {
                        Utilities.Log_Utils.Write($"Category '{name}' does not exist in this Revit version; skipped.");
                    }
                }

                BuiltInCategory[] result = resolved.ToArray();
                CACHE[def.Key] = result;
                return result;
            }
        }

        /// <summary>
        /// Creates a collector of model elements (not types) for a definition.
        /// </summary>
        /// <param name="doc">The document.</param>
        /// <param name="def">The category definition.</param>
        /// <returns>A collector, or null if the definition resolves to no categories.</returns>
        public static FilteredElementCollector Collect(Document doc, CategoryDef def)
        {
            BuiltInCategory[] bics = Resolve(def);
            if (bics.Length == 0) { return null; }

            return new FilteredElementCollector(doc)
                .WhereElementIsNotElementType()
                .WherePasses(new ElementMulticategoryFilter(bics));
        }

        /// <summary>
        /// Counts the elements of a definition (used by the Options dialog estimate).
        /// </summary>
        /// <param name="doc">The document.</param>
        /// <param name="def">The category definition.</param>
        /// <returns>The element count.</returns>
        public static int Count(Document doc, CategoryDef def)
        {
            try
            {
                return Collect(doc, def)?.GetElementCount() ?? 0;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Count failed for {def.Key}: {ex.Message}");
                return 0;
            }
        }
    }
}
