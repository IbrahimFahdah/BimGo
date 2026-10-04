using BimGo.Scene;

// The class belongs to the Extraction namespace
namespace BimGo.Extraction
{
    /// <summary>
    /// Lists parameter names available in the model for the Options dialog's extra-parameter picker.
    /// Samples a limited number of elements per catalog category (instance parameters) plus every type met
    /// (type parameters), so it stays quick on large models. Revit API thread only.
    /// </summary>
    internal static class ParameterScanner
    {
        /// <summary>Elements sampled per category definition.</summary>
        private const int SAMPLES_PER_CATEGORY = 150;

        /// <summary>
        /// Scans the model.
        /// </summary>
        /// <param name="doc">The document.</param>
        /// <returns>Distinct parameter names, sorted.</returns>
        public static List<string> ScanNames(Document doc)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            var typesSeen = new HashSet<long>();

            foreach (CategoryDef def in CategoryCatalog.All)
            {
                FilteredElementCollector collector = CategoryResolver.Collect(doc, def);
                if (collector == null) { continue; }

                int sampled = 0;
                foreach (Element element in collector)
                {
                    if (++sampled > SAMPLES_PER_CATEGORY) { break; }
                    AddNames(element, names);

                    ElementId typeId = element.GetTypeId();
                    if (typeId != null && typeId != ElementId.InvalidElementId && typesSeen.Add(typeId.Value))
                    {
                        AddNames(doc.GetElement(typeId), names);
                    }
                }
            }

            Utilities.Log_Utils.Write($"Parameter scan: {names.Count} names from {typesSeen.Count} types.");
            return names.OrderBy(n => n, StringComparer.CurrentCultureIgnoreCase).ToList();
        }

        private static void AddNames(Element element, HashSet<string> names)
        {
            if (element == null) { return; }
            try
            {
                foreach (Parameter parameter in element.Parameters)
                {
                    string name = parameter?.Definition?.Name;
                    if (!string.IsNullOrWhiteSpace(name)) { names.Add(name); }
                }
            }
            catch
            {
                // Some elements throw on parameter access; skip them
            }
        }
    }
}
