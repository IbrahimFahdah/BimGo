// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// QOL round: the water and glass material overrides (Revit options window → Materials, and pause menu →
    /// Appearance). Water is a shader flag, so the session re-applies it on a copy of the extracted materials; glass
    /// (see-through) is baked into the geometry, so its keywords only act at Go / Export.
    /// </summary>
    public static class MaterialOverrides
    {
        /// <summary>
        /// Grass round: water colour presets (label, #RRGGBB; empty = the material's own colour): clear pool teal, a
        /// green-brown pond, deep dark water.
        /// </summary>
        public static readonly (string Label, string Hex)[] WATER_PRESETS =
        {
            ("Revit", ""), ("Pool", "#3B9AA6"), ("Pond", "#3F4F33"), ("Dark", "#16222B")
        };

        /// <summary>The preset index for a colour (case ignored), or −1 for a custom colour.</summary>
        public static int WaterPresetIndex(string hex)
        {
            string value = (hex ?? string.Empty).Trim();
            for (int i = 0; i < WATER_PRESETS.Length; i++)
            {
                if (string.Equals(WATER_PRESETS[i].Hex, value, StringComparison.OrdinalIgnoreCase)) { return i; }
            }
            return -1;
        }

        /// <summary>Most keywords kept per list.</summary>
        public const int MAX_KEYWORDS = 40;

        /// <summary>Water ripple strength for a material that becomes water by keyword (Revit's typical 0.1).</summary>
        public const float KEYWORD_WATER_BUMP = 0.1f;

        /// <summary>Reflection strength and blur of a material that becomes water by keyword (as the Revit side's name rule).</summary>
        public const float KEYWORD_WATER_SHINE = 0.6f, KEYWORD_WATER_ROUGHNESS = 0.05f;

        /// <summary>
        /// Trims, drops blanks and duplicates (case-insensitive) and caps the count.
        /// </summary>
        public static List<string> CleanKeywords(IEnumerable<string> keywords)
        {
            return (keywords ?? Enumerable.Empty<string>())
                .Where(k => !string.IsNullOrWhiteSpace(k))
                .Select(k => k.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(MAX_KEYWORDS)
                .ToList();
        }

        /// <summary>
        /// Splits a comma / semicolon separated list typed by the user.
        /// </summary>
        public static List<string> ParseKeywords(string text) =>
            CleanKeywords((text ?? string.Empty).Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries));

        /// <summary>The list as the user types it ("water, pool").</summary>
        public static string FormatKeywords(IEnumerable<string> keywords) => string.Join(", ", keywords ?? Enumerable.Empty<string>());

        /// <summary>
        /// True when <paramref name="name"/> contains any keyword (case-insensitive).
        /// </summary>
        public static bool Matches(string name, IReadOnlyList<string> keywords)
        {
            if (string.IsNullOrEmpty(name) || keywords == null) { return false; }
            for (int i = 0; i < keywords.Count; i++)
            {
                if (!string.IsNullOrEmpty(keywords[i]) && name.Contains(keywords[i], StringComparison.OrdinalIgnoreCase)) { return true; }
            }
            return false;
        }

        /// <summary>True when the appearance schema is Revit's Water asset.</summary>
        public static bool IsWaterAsset(SceneMaterial material) =>
            material?.Schema?.Contains("Water", StringComparison.OrdinalIgnoreCase) == true;

        /// <summary>
        /// True when the material was see-through at extraction. Files from before the flag: glass carries
        /// <see cref="SceneMaterial.Reflectivity"/>, and water that isn't the Water asset was water by the see-through name rule.
        /// </summary>
        public static bool IsSeeThrough(SceneMaterial material)
        {
            if (material == null) { return false; }
            return material.SeeThrough || material.Reflectivity > 0f || (material.Water && !IsWaterAsset(material));
        }

        /// <summary>
        /// Whether a material is water under these settings.
        /// </summary>
        public static bool IsWater(SceneMaterial material, bool fromAsset, IReadOnlyList<string> keywords, bool keywordsOpaque)
        {
            if (material == null) { return false; }
            if (fromAsset && IsWaterAsset(material)) { return true; }
            return Matches(material.Name, keywords) && (keywordsOpaque || IsSeeThrough(material));
        }

        /// <summary>
        /// How one material draws under these settings: water or not, and the reflection values that go with it. A
        /// material that becomes water gets ripples and a water sheen; one that stops being water loses the ripples (its
        /// sheen is kept); otherwise the extracted values.
        /// </summary>
        public static (bool Water, float Shine, float? Roughness, float Bump) Look(SceneMaterial source, bool fromAsset, IReadOnlyList<string> keywords, bool keywordsOpaque)
        {
            if (source == null) { return (false, 0f, null, 0f); }
            bool on = IsWater(source, fromAsset, keywords, keywordsOpaque);
            if (on && !source.Water) { return (true, MathF.Max(source.Shine, KEYWORD_WATER_SHINE), KEYWORD_WATER_ROUGHNESS, KEYWORD_WATER_BUMP); }
            return (on, source.Shine, source.Roughness, on ? source.WaterBump : 0f);
        }

        /// <summary>
        /// Re-applies the water rule to <paramref name="target"/> from the extracted <paramref name="original"/>
        /// (same length and order), as <see cref="Look"/>.
        /// </summary>
        /// <returns>The number of water materials.</returns>
        public static int ApplyWater(SceneMaterial[] original, SceneMaterial[] target, bool fromAsset, IReadOnlyList<string> keywords, bool keywordsOpaque)
        {
            if (original == null || target == null) { return 0; }
            int count = Math.Min(original.Length, target.Length), water = 0;
            for (int i = 0; i < count; i++)
            {
                SceneMaterial source = original[i], m = target[i];
                if (source == null || m == null) { continue; }
                (m.Water, m.Shine, m.Roughness, m.WaterBump) = Look(source, fromAsset, keywords, keywordsOpaque);
                if (m.Water) { water++; }
            }
            return water;
        }
    }
}
