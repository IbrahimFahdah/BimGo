using BimGo.Scene;

// The class belongs to the Extraction namespace
namespace BimGo.Extraction
{
    /// <summary>
    /// Active-view-only extraction: which view to use, which of its elements are model geometry, and how they map onto
    /// the category catalog. Revit API thread only. Never throws.
    /// </summary>
    internal static class ViewScope
    {
        /// <summary>The last usable view per host model (F5 from another active document reuses it).</summary>
        private static readonly Dictionary<string, long> LAST_VIEW = new(StringComparer.Ordinal);

        /// <summary>BuiltInCategory → catalog index, built once.</summary>
        private static Dictionary<long, int> _catalogByCategory;

        /// <summary>
        /// Model categories that never become walkthrough geometry (spatial elements, link instances, groups and
        /// assemblies whose members come in on their own, cameras…).
        /// </summary>
        private static readonly HashSet<long> EXCLUDED = new()
        {
            (long)BuiltInCategory.OST_Rooms,
            (long)BuiltInCategory.OST_Areas,
            (long)BuiltInCategory.OST_MEPSpaces,
            (long)BuiltInCategory.OST_HVAC_Zones,
            (long)BuiltInCategory.OST_RvtLinks,
            (long)BuiltInCategory.OST_IOSModelGroups,
            (long)BuiltInCategory.OST_Assemblies,
            (long)BuiltInCategory.OST_Cameras,
            (long)BuiltInCategory.OST_Lines,
            (long)BuiltInCategory.OST_LightingFixtureSource
        };

        /// <summary>
        /// True for views that show model elements (3D, plans, ceiling plans, sections, elevations, details).
        /// </summary>
        public static bool ShowsModel(DB.View view)
        {
            if (view == null) { return false; }
            try
            {
                if (view.IsTemplate) { return false; }
                return view.ViewType is ViewType.ThreeD or ViewType.FloorPlan or ViewType.CeilingPlan or ViewType.EngineeringPlan
                    or ViewType.AreaPlan or ViewType.Section or ViewType.Elevation or ViewType.Detail;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// The view to extract: the active view if it shows model elements (remembered for the model), else the view
        /// remembered for this model (a refresh while another document is active), else null.
        /// </summary>
        public static DB.View Resolve(UIDocument uiDoc, Document doc)
        {
            string key = LinkResolver.HostKey(doc);
            DB.View active = null;
            try { active = uiDoc?.ActiveView; }
            catch { /* not the active document */ }

            if (ShowsModel(active))
            {
                LAST_VIEW[key] = active.Id.Value;
                return active;
            }
            if (LAST_VIEW.TryGetValue(key, out long id) && doc.GetElement(new ElementId(id)) is DB.View remembered && ShowsModel(remembered))
            {
                return remembered;
            }
            return null;
        }

        /// <summary>
        /// The host elements visible in a view (not types), or null if the view can't be collected.
        /// </summary>
        public static FilteredElementCollector CollectHost(Document doc, DB.View view)
        {
            try
            {
                return new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType();
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"View collector failed: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// The elements of a linked model that the host view shows (Revit 2024+), or null.
        /// </summary>
        public static FilteredElementCollector CollectLink(Document hostDoc, DB.View view, long linkInstanceId)
        {
            try
            {
                return new FilteredElementCollector(hostDoc, view.Id, new ElementId(linkInstanceId)).WhereElementIsNotElementType();
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Linked view collector failed: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// True if a link instance (or the Revit Links category) is hidden in the view.
        /// </summary>
        public static bool HidesLink(DB.View view, long linkInstanceId)
        {
            try
            {
                if (view.GetCategoryHidden(new ElementId(BuiltInCategory.OST_RvtLinks))) { return true; }
                return view.Document.GetElement(new ElementId(linkInstanceId)) is Element instance && instance.IsHidden(view);
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Approximately how many elements a view shows (the Options dialog's estimate), or 0.
        /// </summary>
        public static int Count(Document doc, DB.View view)
        {
            if (!ShowsModel(view)) { return 0; }
            try { return CollectHost(doc, view)?.GetElementCount() ?? 0; }
            catch { return 0; }
        }

        /// <summary>
        /// The catalog definition a visible element belongs to ("Other (active view)" for unlisted model categories),
        /// or null if it isn't walkthrough geometry (annotation, view-specific, spatial, groups, component stairs…).
        /// </summary>
        public static CategoryDef DefinitionOf(Element element)
        {
            try
            {
                if (element == null || element.ViewSpecific) { return null; }
                Category category = element.Category;
                if (category == null || category.CategoryType != CategoryType.Model) { return null; }

                long id = category.Id.Value;
                if (EXCLUDED.Contains(id)) { return null; }

                // Component stairs: runs, landings and supports are listed on their own
                if (element is Autodesk.Revit.DB.Architecture.Stairs stairs && stairs.GetStairsRuns().Count > 0) { return null; }

                return CatalogByCategory().TryGetValue(id, out int index)
                    ? CategoryCatalog.All[index]
                    : CategoryCatalog.Find(CategoryCatalog.KEY_OTHER);
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// BuiltInCategory value → catalog index for every catalog definition.
        /// </summary>
        private static Dictionary<long, int> CatalogByCategory()
        {
            if (_catalogByCategory != null) { return _catalogByCategory; }
            var map = new Dictionary<long, int>();
            foreach (CategoryDef def in CategoryCatalog.All)
            {
                foreach (BuiltInCategory bic in CategoryResolver.Resolve(def))
                {
                    map.TryAdd((long)bic, def.Index);
                }
            }
            return _catalogByCategory = map;
        }
    }
}
