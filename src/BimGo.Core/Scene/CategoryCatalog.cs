// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// The three category groups offered at launch and in the pause menu.
    /// </summary>
    public enum CategoryGroup
    {
        /// <summary>Architectural and structural elements (always collidable, no triangle limit).</summary>
        System = 0,

        /// <summary>Furniture, fixtures and equipment (triangle limit applies).</summary>
        Ffe = 1,

        /// <summary>Building services (triangle limit applies).</summary>
        Services = 2
    }

    /// <summary>
    /// One user-facing category toggle. A definition can map to several Revit built-in categories
    /// (e.g. Roofs also covers gutters and fascias).
    ///
    /// Built-in categories are stored as enum NAMES and resolved at runtime with Enum.TryParse,
    /// so a name that doesn't exist in a given Revit version is skipped rather than breaking the build.
    /// </summary>
    public sealed class CategoryDef
    {
        /// <summary>Index of this definition in <see cref="CategoryCatalog.All"/>.</summary>
        public int Index { get; init; }

        /// <summary>Stable key used for settings persistence.</summary>
        public string Key { get; init; }

        /// <summary>Display label.</summary>
        public string Label { get; init; }

        /// <summary>The group the category belongs to.</summary>
        public CategoryGroup Group { get; init; }

        /// <summary>BuiltInCategory enum names covered by this definition.</summary>
        public string[] BuiltInCategoryNames { get; init; }

        /// <summary>High-volume categories (ducts, pipes...) offered separately and off by default.</summary>
        public bool Heavy { get; init; }

        /// <summary>Whether the triangle threshold applies (FFE and Services only).</summary>
        public bool ThresholdApplies => Group != CategoryGroup.System;
    }

    /// <summary>
    /// The fixed catalog of loadable categories. Order here is also the draw order.
    /// </summary>
    public static class CategoryCatalog
    {
        /// <summary>Key of the Doors definition (doors get special handling).</summary>
        public const string KEY_DOORS = "doors";

        /// <summary>Key of the Stairs definition.</summary>
        public const string KEY_STAIRS = "stairs";

        /// <summary>Key of the Generic models definition (fallback for unknown keys read from a file).</summary>
        public const string KEY_GENERIC = "generic";

        /// <summary>
        /// Model elements in categories the catalog doesn't list. Only active-view-only extraction fills it (it has no
        /// categories of its own, so the Options dialog doesn't offer it).
        /// </summary>
        public const string KEY_OTHER = "other";

        /// <summary>All category definitions, in draw order.</summary>
        public static IReadOnlyList<CategoryDef> All { get; } = Build();

        /// <summary>Display names of the groups, indexed by <see cref="CategoryGroup"/>.</summary>
        public static readonly string[] GROUP_NAMES = { "System", "FFE", "Services" };

        /// <summary>
        /// Finds a definition by key.
        /// </summary>
        /// <param name="key">The key to search for.</param>
        /// <returns>The definition, or null.</returns>
        public static CategoryDef Find(string key)
        {
            if (string.IsNullOrEmpty(key)) { return null; }
            foreach (CategoryDef def in All)
            {
                if (def.Key == key) { return def; }
            }
            return null;
        }

        /// <summary>
        /// The keys enabled by default (System + FFE, Services off, heavy services off).
        /// </summary>
        /// <returns>A list of keys.</returns>
        public static List<string> DefaultEnabledKeys()
        {
            return All.Where(d => d.Group != CategoryGroup.Services && !d.Heavy).Select(d => d.Key).ToList();
        }

        /// <summary>
        /// Builds the catalog.
        /// </summary>
        private static List<CategoryDef> Build()
        {
            var list = new List<CategoryDef>();

            void Add(CategoryGroup group, string key, string label, bool heavy, params string[] bics)
            {
                list.Add(new CategoryDef
                {
                    Index = list.Count,
                    Key = key,
                    Label = label,
                    Group = group,
                    Heavy = heavy,
                    BuiltInCategoryNames = bics
                });
            }

            // System (collidable, no threshold)
            Add(CategoryGroup.System, "walls", "Walls", false, "OST_Walls");
            Add(CategoryGroup.System, "floors", "Floors + slab edges", false, "OST_Floors", "OST_EdgeSlab");
            Add(CategoryGroup.System, "ceilings", "Ceilings", false, "OST_Ceilings");
            Add(CategoryGroup.System, "roofs", "Roofs + gutters, fascias", false, "OST_Roofs", "OST_Gutter", "OST_Fascia", "OST_RoofSoffit");
            Add(CategoryGroup.System, "curtainpanels", "Curtain panels", false, "OST_CurtainWallPanels");
            Add(CategoryGroup.System, "mullions", "Curtain wall mullions", false, "OST_CurtainWallMullions");
            Add(CategoryGroup.System, KEY_DOORS, "Doors", false, "OST_Doors");
            Add(CategoryGroup.System, "windows", "Windows", false, "OST_Windows");
            Add(CategoryGroup.System, KEY_STAIRS, "Stairs + runs, landings", false, "OST_Stairs", "OST_StairsRuns", "OST_StairsLandings", "OST_StairsStringerCarriage");
            Add(CategoryGroup.System, "ramps", "Ramps", false, "OST_Ramps");
            Add(CategoryGroup.System, "columns", "Columns", false, "OST_Columns");
            Add(CategoryGroup.System, "structcolumns", "Structural columns", false, "OST_StructuralColumns");
            Add(CategoryGroup.System, "framing", "Structural framing", false, "OST_StructuralFraming");
            Add(CategoryGroup.System, "foundations", "Structural foundations", false, "OST_StructuralFoundation");
            Add(CategoryGroup.System, "topo", "Toposolid / topography", false, "OST_Toposolid", "OST_Topography");

            // FFE (collidable, threshold applies)
            Add(CategoryGroup.Ffe, "casework", "Casework", false, "OST_Casework");
            Add(CategoryGroup.Ffe, "furniture", "Furniture", false, "OST_Furniture");
            Add(CategoryGroup.Ffe, "furnsys", "Furniture systems", false, "OST_FurnitureSystems");
            Add(CategoryGroup.Ffe, KEY_GENERIC, "Generic models", false, "OST_GenericModel");
            Add(CategoryGroup.Ffe, "parking", "Parking", false, "OST_Parking");
            Add(CategoryGroup.Ffe, "specialty", "Specialty equipment", false, "OST_SpecialityEquipment");
            Add(CategoryGroup.Ffe, "plumbing", "Plumbing fixtures", false, "OST_PlumbingFixtures");
            Add(CategoryGroup.Ffe, "railings", "Railings", false, "OST_StairsRailing", "OST_RailingTopRail", "OST_RailingHandRail", "OST_RailingSupport", "OST_RailingTermination");
            Add(CategoryGroup.Ffe, "foodservice", "Food service equipment", false, "OST_FoodServiceEquipment");
            Add(CategoryGroup.Ffe, "planting", "Planting", false, "OST_Planting");
            Add(CategoryGroup.Ffe, "entourage", "Entourage", false, "OST_Entourage");
            Add(CategoryGroup.Ffe, "signage", "Signage", false, "OST_Signage");

            // Services (collidable, threshold applies)
            Add(CategoryGroup.Services, "elecfixtures", "Electrical fixtures", false, "OST_ElectricalFixtures");
            Add(CategoryGroup.Services, "elecequipment", "Electrical equipment", false, "OST_ElectricalEquipment");
            Add(CategoryGroup.Services, "mechequipment", "Mechanical equipment", false, "OST_MechanicalEquipment");
            Add(CategoryGroup.Services, "lightfixtures", "Lighting fixtures", false, "OST_LightingFixtures");
            Add(CategoryGroup.Services, "lightdevices", "Lighting devices", false, "OST_LightingDevices");
            Add(CategoryGroup.Services, "security", "Security devices", false, "OST_SecurityDevices");
            Add(CategoryGroup.Services, "firealarm", "Fire alarm devices", false, "OST_FireAlarmDevices");
            Add(CategoryGroup.Services, "comms", "Communication devices", false, "OST_CommunicationDevices");
            Add(CategoryGroup.Services, "data", "Data devices", false, "OST_DataDevices");
            Add(CategoryGroup.Services, "nursecall", "Nurse call devices", false, "OST_NurseCallDevices");
            Add(CategoryGroup.Services, "sprinklers", "Sprinklers", false, "OST_Sprinklers");
            Add(CategoryGroup.Services, "airterminals", "Air terminals", false, "OST_DuctTerminal");

            // Services, heavy (optional, off by default)
            Add(CategoryGroup.Services, "ducts", "Ducts + fittings", true, "OST_DuctCurves", "OST_DuctFitting", "OST_FlexDuctCurves");
            Add(CategoryGroup.Services, "pipes", "Pipes + fittings", true, "OST_PipeCurves", "OST_PipeFitting", "OST_FlexPipeCurves");
            Add(CategoryGroup.Services, "cabletrays", "Cable trays + fittings", true, "OST_CableTray", "OST_CableTrayFitting");
            Add(CategoryGroup.Services, "conduits", "Conduits + fittings", true, "OST_Conduit", "OST_ConduitFitting");

            // Anything else a view shows (active-view-only extraction): masses, site, parts, accessories…
            Add(CategoryGroup.Ffe, KEY_OTHER, "Other (active view)", false);

            return list;
        }
    }
}
