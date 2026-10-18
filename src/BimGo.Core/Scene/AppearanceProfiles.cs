using System.Text.Json.Serialization;
using BimGo.Clashes;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Colour round A: what a colour profile colours by.
    /// </summary>
    public static class ProfileKind
    {
        /// <summary>One colour per search set (the first set an element is in wins).</summary>
        public const string BY_SET = "bySet";

        /// <summary>One colour per value of a field or extracted parameter.</summary>
        public const string BY_VALUE = "byValue";

        /// <summary>A known kind for any text (unknown reads as <see cref="BY_VALUE"/>).</summary>
        public static string Normalise(string kind) =>
            string.Equals(kind?.Trim(), BY_SET, StringComparison.OrdinalIgnoreCase) ? BY_SET : BY_VALUE;
    }

    /// <summary>
    /// Colour round A: how the elements no rule colours look.
    /// </summary>
    public static class UnmatchedLook
    {
        /// <summary>Faint grey glass (as the clash view's ghost).</summary>
        public const string GHOST = "ghost";

        /// <summary>Their normal colours (the colour mode's).</summary>
        public const string NORMAL = "normal";

        /// <summary>One flat colour (<see cref="AppearanceProfile.UnmatchedColour"/>), shaded like the rules' colours.</summary>
        public const string FLAT = "flat";

        /// <summary>Every look in display order.</summary>
        public static readonly string[] All = { GHOST, NORMAL, FLAT };

        /// <summary>Labels of <see cref="All"/>.</summary>
        public static readonly string[] Labels = { "Ghosted", "Normal", "Flat colour" };

        /// <summary>A known look for any text (unknown reads as <see cref="GHOST"/>).</summary>
        public static string Normalise(string look)
        {
            foreach (string known in All)
            {
                if (string.Equals(known, look?.Trim(), StringComparison.OrdinalIgnoreCase)) { return known; }
            }
            return GHOST;
        }
    }

    /// <summary>
    /// Colour round A: one row of a colour profile: a search set (<see cref="SetId"/>) or a value (<see cref="Value"/>)
    /// and its colour. A row that is off leaves its elements to the next row (sets) or unmatched (values).
    /// </summary>
    public sealed class ProfileRule
    {
        /// <summary>The search set's id (by set), else null.</summary>
        public string SetId { get; set; }

        /// <summary>The value as stored in rules (by value; empty = "(no value)" for parameters), else null.</summary>
        public string Value { get; set; }

        /// <summary>The value's label when it was last seen (shown for values the model no longer has).</summary>
        public string Label { get; set; }

        /// <summary>The colour, "#RRGGBB".</summary>
        public string Colour { get; set; } = "#9CA3AF";

        /// <summary>False: the row is skipped (its elements fall through).</summary>
        public bool On { get; set; } = true;

        /// <summary>Colour round B: number ranges: the range's low end (inclusive), else null.</summary>
        public double? From { get; set; }

        /// <summary>Colour round B: number ranges: the range's high end (inclusive for the last range), else null.</summary>
        public double? To { get; set; }

        /// <summary>Colour round B: how see-through the row's elements are, 0 (solid) to 0.9.</summary>
        public float Transparency { get; set; }

        /// <summary>Colour round B: the row's elements aren't drawn, picked or collided with while the profile shows.</summary>
        public bool Hidden { get; set; }

        /// <summary>The colour as 0xRRGGBB (a mid grey when the text isn't a colour).</summary>
        [JsonIgnore]
        public uint Rgb => LaunchSettings.TryParseColour(Colour, out uint rgb) ? rgb : 0x9CA3AF;

        /// <summary>True for a number range row.</summary>
        [JsonIgnore]
        public bool IsRange => From.HasValue && To.HasValue;

        /// <summary>A copy.</summary>
        public ProfileRule Copy() => new()
        {
            SetId = SetId, Value = Value, Label = Label, Colour = Colour, On = On, From = From, To = To, Transparency = Transparency, Hidden = Hidden
        };
    }

    /// <summary>
    /// Colour round A: a named colour profile (as Navisworks' appearance profiler): rows of search sets or of a field's
    /// values, each with a colour, and how the rest of the model looks. Saved per model in <c>visibility.json</c>
    /// (<see cref="AppearanceSettings"/>).
    /// </summary>
    public sealed class AppearanceProfile
    {
        /// <summary>Stable id.</summary>
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        /// <summary>The name people see.</summary>
        public string Name { get; set; } = "New profile";

        /// <summary><see cref="ProfileKind"/>.</summary>
        public string Kind { get; set; } = ProfileKind.BY_VALUE;

        /// <summary>By value: the field (<see cref="RuleField"/>).</summary>
        public string Field { get; set; } = RuleField.CATALOG;

        /// <summary>By value: the parameter's name when <see cref="Field"/> is <see cref="RuleField.PARAMETER"/>.</summary>
        public string Parameter { get; set; }

        /// <summary>The palette new rows take their colours from (<see cref="AppearanceProfiler.PALETTES"/>).</summary>
        public string Palette { get; set; } = AppearanceProfiler.PALETTE_BRIGHT;

        /// <summary><see cref="UnmatchedLook"/>.</summary>
        public string Unmatched { get; set; } = UnmatchedLook.GHOST;

        /// <summary>The flat colour of unmatched elements ("#RRGGBB").</summary>
        public string UnmatchedColour { get; set; } = "#D6DADF";

        /// <summary>
        /// How much of the surface's own detail (texture, material shade) shows through the colour: 0 = flat colour,
        /// 1 = the colour multiplies the surface. Lighting and shadows always stay.
        /// </summary>
        public float Detail { get; set; } = AppearanceProfiler.DEFAULT_DETAIL;

        /// <summary>
        /// Colour round B: by value, colour number ranges (equal bins from the lowest to the highest number found; the
        /// first number in each text, units ignored) instead of each value.
        /// </summary>
        public bool Ranges { get; set; }

        /// <summary>Colour round B: how many ranges (2–12).</summary>
        public int Bins { get; set; } = AppearanceProfiler.DEFAULT_BINS;

        /// <summary>
        /// Polish round P-C: how the ranges are cut (<see cref="BinMethod"/>): equal widths (as before), equal counts
        /// (quantiles) or the user's own break values (<see cref="Breaks"/>).
        /// </summary>
        public string Binning { get; set; } = BinMethod.EQUAL;

        /// <summary>Polish round P-C: custom break values (ascending; null when none). A value on a break goes in the lower range.</summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public List<double> Breaks { get; set; }

        /// <summary>Colour round B: the ranges' colour ramp (<see cref="AppearanceProfiler.RAMPS"/>).</summary>
        public string Ramp { get; set; } = AppearanceProfiler.RAMP_BLUE_RED;

        /// <summary>The rows, first match first.</summary>
        public List<ProfileRule> Rules { get; set; } = new();

        /// <summary>True for a by-set profile.</summary>
        [JsonIgnore]
        public bool IsBySet => ProfileKind.Normalise(Kind) == ProfileKind.BY_SET;

        /// <summary>Normalises the fields and drops broken rows (guards against hand-edited files). Returns itself.</summary>
        public AppearanceProfile Clean()
        {
            if (string.IsNullOrWhiteSpace(Id)) { Id = Guid.NewGuid().ToString("N"); }
            Name = string.IsNullOrWhiteSpace(Name) ? "Profile" : Name.Trim();
            Kind = ProfileKind.Normalise(Kind);
            Field = RuleField.Normalise(Field);
            Parameter = Field == RuleField.PARAMETER ? (Parameter ?? string.Empty).Trim() : null;
            Palette = AppearanceProfiler.NormalisePalette(Palette);
            Unmatched = UnmatchedLook.Normalise(Unmatched);
            UnmatchedColour = AppearanceProfiler.CleanColour(UnmatchedColour, "#D6DADF");
            Detail = float.IsFinite(Detail) ? Math.Clamp(Detail, 0f, 1f) : AppearanceProfiler.DEFAULT_DETAIL;
            if (IsBySet) { Ranges = false; }
            Bins = Math.Clamp(Bins, AppearanceProfiler.MIN_BINS, AppearanceProfiler.MAX_BINS);
            Binning = BinMethod.Normalise(Binning);
            Breaks = AppearanceProfiler.CleanBreaks(Breaks);
            Ramp = AppearanceProfiler.NormaliseRamp(Ramp);
            Rules = (Rules ?? new List<ProfileRule>()).Where(r => r != null && (IsBySet ? !string.IsNullOrEmpty(r.SetId)
                : Ranges ? r.IsRange && double.IsFinite(r.From.Value) && double.IsFinite(r.To.Value) : r.Value != null)).ToList();
            foreach (ProfileRule rule in Rules)
            {
                rule.Colour = AppearanceProfiler.CleanColour(rule.Colour, "#9CA3AF");
                rule.Transparency = float.IsFinite(rule.Transparency) ? Math.Clamp(rule.Transparency, 0f, AppearanceProfiler.MAX_TRANSPARENCY) : 0f;
                if (IsBySet) { rule.Value = rule.Label = null; }
                else { rule.SetId = null; }
                if (!Ranges) { rule.From = rule.To = null; }
                else { rule.Value = null; }
            }
            return this;
        }

        /// <summary>A copy (new id when <paramref name="newId"/>).</summary>
        public AppearanceProfile Copy(bool newId = false) => new()
        {
            Id = newId ? Guid.NewGuid().ToString("N") : Id,
            Name = Name,
            Kind = Kind,
            Field = Field,
            Parameter = Parameter,
            Palette = Palette,
            Unmatched = Unmatched,
            UnmatchedColour = UnmatchedColour,
            Detail = Detail,
            Ranges = Ranges,
            Bins = Bins,
            Binning = Binning,
            Breaks = Breaks?.ToList(),
            Ramp = Ramp,
            Rules = Rules?.Where(r => r != null).Select(r => r.Copy()).ToList() ?? new List<ProfileRule>()
        };
    }

    /// <summary>
    /// Polish round P-C: how a ranges profile cuts its numbers.
    /// </summary>
    public static class BinMethod
    {
        /// <summary>Equal widths from the lowest to the highest number (colour round B).</summary>
        public const string EQUAL = "equal";

        /// <summary>Equal counts (quantiles): about as many elements in each range.</summary>
        public const string QUANTILE = "quantile";

        /// <summary>The user's own break values.</summary>
        public const string CUSTOM = "custom";

        /// <summary>In display order.</summary>
        public static readonly string[] All = { EQUAL, QUANTILE, CUSTOM };

        /// <summary>Labels in <see cref="All"/>'s order.</summary>
        public static readonly string[] Labels = { "EQUAL WIDTH", "EQUAL COUNT", "CUSTOM" };

        /// <summary>A known method (unknown or empty: equal).</summary>
        public static string Normalise(string method)
        {
            foreach (string known in All)
            {
                if (string.Equals(known, method?.Trim(), StringComparison.OrdinalIgnoreCase)) { return known; }
            }
            return EQUAL;
        }
    }

    /// <summary>
    /// Colour round A: a model's colour profiles, which one is active, and whether it shows. Saved per model in
    /// <c>visibility.json</c> → <c>appearance</c> (older readers ignore it).
    /// </summary>
    public sealed class AppearanceSettings
    {
        /// <summary>The profiles.</summary>
        public List<AppearanceProfile> Profiles { get; set; } = new();

        /// <summary>The active profile's id (the one the hotkey shows), or null.</summary>
        public string Active { get; set; }

        /// <summary>True when the active profile colours the model.</summary>
        public bool On { get; set; }

        /// <summary>The on-screen legend while a profile shows.</summary>
        public bool Legend { get; set; } = true;

        /// <summary>Colour round B: the legend is drawn into photos (stills) and screenshots (F12) too.</summary>
        public bool LegendInShots { get; set; }

        /// <summary>True when there is nothing to save (no profiles).</summary>
        [JsonIgnore]
        public bool IsDefault => (Profiles?.Count ?? 0) == 0;

        /// <summary>The profile with an id, or null.</summary>
        public AppearanceProfile Find(string id) =>
            string.IsNullOrEmpty(id) ? null : Profiles?.FirstOrDefault(p => p != null && string.Equals(p.Id, id, StringComparison.Ordinal));

        /// <summary>Cleans every profile, drops duplicates and keeps <see cref="Active"/> valid. Returns itself.</summary>
        public AppearanceSettings Clean()
        {
            Profiles = (Profiles ?? new List<AppearanceProfile>()).Where(p => p != null).Select(p => p.Clean()).ToList();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            Profiles.RemoveAll(p => !seen.Add(p.Id));
            if (Find(Active) == null) { Active = Profiles.FirstOrDefault()?.Id; }
            if (Active == null) { On = false; }
            return this;
        }

        /// <summary>A deep copy.</summary>
        public AppearanceSettings Copy() => new()
        {
            Profiles = Profiles?.Where(p => p != null).Select(p => p.Copy()).ToList() ?? new List<AppearanceProfile>(),
            Active = Active,
            On = On,
            Legend = Legend,
            LegendInShots = LegendInShots
        };
    }

    /// <summary>
    /// Colour round A: what a profile does to each element, ready for the renderer: one packed RGBA8 per element
    /// (R | G &lt;&lt; 8 | B &lt;&lt; 16 | A &lt;&lt; 24; A is the code, see <see cref="AppearanceProfiler"/>), plus counts
    /// for the legend.
    /// </summary>
    public sealed class ProfileResult
    {
        /// <summary>Per element (same order as <c>SceneData.Elements</c>).</summary>
        public uint[] Codes { get; init; }

        /// <summary>Per rule: the elements it coloured (by set: the first match only; off rows 0).</summary>
        public int[] RuleCounts { get; init; }

        /// <summary>Elements no row coloured (library templates left out).</summary>
        public int Unmatched { get; init; }

        /// <summary>True when some element is ghosted (the renderer then draws a ghost pass).</summary>
        public bool AnyGhost { get; init; }

        /// <summary>Colour round B: true when some element is ghosted or see-through (drawn in the blended pass).</summary>
        public bool AnyBlended { get; init; }

        /// <summary>Colour round B: true when some element is hidden by its row.</summary>
        public bool AnyHidden { get; init; }

        /// <summary>Colour round B (ranges): elements whose field has no number (left unmatched).</summary>
        public int NoNumber { get; init; }

        /// <summary>By set: rows whose set no longer exists.</summary>
        public int MissingSets { get; init; }
    }

    /// <summary>
    /// Colour round A: evaluates colour profiles (by set or by value) into per-element codes, and builds and refreshes
    /// their rows (palettes, values found in the model).
    /// </summary>
    public static class AppearanceProfiler
    {
        #region Codes and defaults

        /// <summary>Code (alpha byte): the element keeps its normal look.</summary>
        public const byte CODE_NONE = 0;

        /// <summary>Code: the element is drawn as faint grey glass.</summary>
        public const byte CODE_GHOST = 1;

        /// <summary>Code: the element isn't drawn (its row is hidden; the session also stops picking and collision).</summary>
        public const byte CODE_HIDDEN = 2;

        /// <summary>
        /// Code: the element takes the colour in RGB, solid. Colour round B: codes 128–254 are the colour see-through,
        /// opacity (code − 128) / 127 (drawn in the blended pass).
        /// </summary>
        public const byte CODE_COLOUR = 255;

        /// <summary>Colour round B: the lowest code of a see-through colour.</summary>
        public const byte CODE_SEE_THROUGH = 128;

        /// <summary>Colour round B: the most a row can be see-through.</summary>
        public const float MAX_TRANSPARENCY = 0.9f;

        /// <summary>Colour round B: ranges.</summary>
        public const int MIN_BINS = 2, MAX_BINS = 12, DEFAULT_BINS = 5;

        /// <summary>Colour round B: ramps for number ranges.</summary>
        public const string RAMP_BLUE_RED = "blueRed", RAMP_GREEN_RED = "greenRed", RAMP_COOL_WARM = "coolWarm", RAMP_LIGHT_DARK = "lightDark";

        /// <summary>Every ramp in display order.</summary>
        public static readonly string[] RAMPS = { RAMP_BLUE_RED, RAMP_GREEN_RED, RAMP_COOL_WARM, RAMP_LIGHT_DARK };

        /// <summary>Labels of <see cref="RAMPS"/>.</summary>
        public static readonly string[] RAMP_LABELS = { "Blue → red", "Green → red", "Cool → warm", "Light → dark" };

        private static readonly uint[][] RAMP_STOPS =
        {
            new uint[] { 0x2C7BB6, 0xABD9E9, 0xFFFFBF, 0xFDAE61, 0xD7191C },
            new uint[] { 0x1A9641, 0xA6D96A, 0xFFFFBF, 0xFDAE61, 0xD7191C },
            new uint[] { 0x3B4CC0, 0x8DB0FE, 0xDDDDDD, 0xF49A7B, 0xB40426 },
            new uint[] { 0xDEEBF7, 0x9ECAE1, 0x4292C6, 0x2171B5, 0x08306B }
        };

        /// <summary>A known ramp for any text (unknown reads as blue → red).</summary>
        public static string NormaliseRamp(string ramp)
        {
            foreach (string known in RAMPS)
            {
                if (string.Equals(known, ramp?.Trim(), StringComparison.OrdinalIgnoreCase)) { return known; }
            }
            return RAMP_BLUE_RED;
        }

        /// <summary>A ramp's colour at t (0–1) as "#RRGGBB" (linear between its five stops).</summary>
        public static string RampColour(string ramp, float t)
        {
            uint[] stops = RAMP_STOPS[Math.Max(0, Array.IndexOf(RAMPS, NormaliseRamp(ramp)))];
            t = Math.Clamp(float.IsFinite(t) ? t : 0f, 0f, 1f) * (stops.Length - 1);
            int i = Math.Min((int)t, stops.Length - 2);
            float f = t - i;
            uint a = stops[i], b = stops[i + 1];
            uint Mix(int shift) => (uint)Math.Clamp(MathF.Round(((a >> shift) & 0xFF) * (1f - f) + ((b >> shift) & 0xFF) * f), 0f, 255f);
            return Hex((Mix(16) << 16) | (Mix(8) << 8) | Mix(0));
        }

        /// <summary>Colour round B: a row's code: hidden, see-through colour, or solid colour.</summary>
        public static uint RuleCode(ProfileRule rule)
        {
            if (rule.Hidden) { return (uint)CODE_HIDDEN << 24; }
            float opacity = 1f - Math.Clamp(rule.Transparency, 0f, MAX_TRANSPARENCY);
            if (opacity >= 0.995f) { return Pack(rule.Rgb, CODE_COLOUR); }
            return Pack(rule.Rgb, (byte)(CODE_SEE_THROUGH + (int)MathF.Round(opacity * 126f)));
        }

        /// <summary>The default share of the surface's own detail kept under the colour.</summary>
        public const float DEFAULT_DETAIL = 0.35f;

        /// <summary>Palette: strong, well separated hues.</summary>
        public const string PALETTE_BRIGHT = "bright";

        /// <summary>Palette: light, soft hues.</summary>
        public const string PALETTE_SOFT = "soft";

        /// <summary>Palette: deep, saturated hues.</summary>
        public const string PALETTE_DEEP = "deep";

        /// <summary>Every palette in display order.</summary>
        public static readonly string[] PALETTES = { PALETTE_BRIGHT, PALETTE_SOFT, PALETTE_DEEP };

        /// <summary>Labels of <see cref="PALETTES"/>.</summary>
        public static readonly string[] PALETTE_LABELS = { "Bright", "Soft", "Deep" };

        // Twelve colours each, ordered so neighbours differ (hue jumps), then golden-angle hues beyond
        private static readonly uint[] BRIGHT =
        {
            0xE6194B, 0x3CB44B, 0x4363D8, 0xF58231, 0x911EB4, 0x42D4F4, 0xF032E6, 0xBFEF45, 0xFFE119, 0x469990, 0x9A6324, 0xDCBEFF
        };
        private static readonly uint[] SOFT =
        {
            0xF4A6A6, 0xA8DDB5, 0xA6C8F4, 0xF9C99A, 0xC9B3E6, 0x9EE3E8, 0xF2B5DD, 0xD6EDA0, 0xFBE7A1, 0xA9D3CC, 0xD9BFA3, 0xC4C9F0
        };
        private static readonly uint[] DEEP =
        {
            0xB91C1C, 0x15803D, 0x1D4ED8, 0xC2410C, 0x7E22CE, 0x0E7490, 0xBE185D, 0x4D7C0F, 0xA16207, 0x0F766E, 0x78350F, 0x4338CA
        };

        /// <summary>A known palette for any text (unknown reads as bright).</summary>
        public static string NormalisePalette(string palette)
        {
            foreach (string known in PALETTES)
            {
                if (string.Equals(known, palette?.Trim(), StringComparison.OrdinalIgnoreCase)) { return known; }
            }
            return PALETTE_BRIGHT;
        }

        /// <summary>
        /// The palette's colour for row <paramref name="index"/> as "#RRGGBB": its twelve colours, then evenly spread
        /// golden-angle hues in the palette's lightness.
        /// </summary>
        public static string PaletteColour(string palette, int index)
        {
            palette = NormalisePalette(palette);
            uint[] colours = palette == PALETTE_SOFT ? SOFT : palette == PALETTE_DEEP ? DEEP : BRIGHT;
            index = Math.Max(0, index);
            if (index < colours.Length) { return Hex(colours[index]); }

            float hue = (index - colours.Length) * 137.508f % 360f;
            (float s, float v) = palette == PALETTE_SOFT ? (0.32f, 0.95f) : palette == PALETTE_DEEP ? (0.85f, 0.62f) : (0.72f, 0.9f);
            return Hex(HsvToRgb(hue, s, v));
        }

        /// <summary>"#RRGGBB" for 0xRRGGBB.</summary>
        public static string Hex(uint rgb) => "#" + (rgb & 0xFFFFFF).ToString("X6", System.Globalization.CultureInfo.InvariantCulture);

        /// <summary>A colour as "#RRGGBB" (upper case), or the fallback when the text isn't one.</summary>
        public static string CleanColour(string text, string fallback) =>
            LaunchSettings.TryParseColour(text, out uint rgb) ? Hex(rgb) : fallback;

        private static uint HsvToRgb(float h, float s, float v)
        {
            float c = v * s, x = c * (1f - MathF.Abs(h / 60f % 2f - 1f)), m = v - c;
            (float r, float g, float b) = (int)(h / 60f) switch
            {
                0 => (c, x, 0f),
                1 => (x, c, 0f),
                2 => (0f, c, x),
                3 => (0f, x, c),
                4 => (x, 0f, c),
                _ => (c, 0f, x)
            };
            uint R = (uint)Math.Clamp(MathF.Round((r + m) * 255f), 0f, 255f), G = (uint)Math.Clamp(MathF.Round((g + m) * 255f), 0f, 255f),
                B = (uint)Math.Clamp(MathF.Round((b + m) * 255f), 0f, 255f);
            return (R << 16) | (G << 8) | B;
        }

        #endregion

        #region New profiles and rows

        /// <summary>
        /// A by-set profile with one row per set (palette colours in set order).
        /// </summary>
        public static AppearanceProfile NewBySet(string name, IEnumerable<SearchSet> sets)
        {
            var profile = new AppearanceProfile { Name = name, Kind = ProfileKind.BY_SET };
            foreach (SearchSet set in sets ?? Enumerable.Empty<SearchSet>())
            {
                if (set == null) { continue; }
                profile.Rules.Add(new ProfileRule { SetId = set.Id, Colour = PaletteColour(profile.Palette, profile.Rules.Count) });
            }
            return profile;
        }

        /// <summary>
        /// A by-value profile for a field (or parameter) with a row per value found in the model.
        /// </summary>
        public static AppearanceProfile NewByValue(string name, string field, string parameter, SceneData scene)
        {
            var profile = new AppearanceProfile { Name = name, Kind = ProfileKind.BY_VALUE, Field = RuleField.Normalise(field), Parameter = parameter };
            profile.Clean();
            SyncValues(profile, scene);
            return profile;
        }

        /// <summary>
        /// By value: adds a row (palette colour) for each value the model has that the profile lacks, keeps the rows it
        /// has (colours and switches unchanged, even for values the model no longer has: they show 0) and refreshes
        /// their labels. A profile with no rows gets the values sorted by label.
        /// </summary>
        /// <returns>How many rows were added.</returns>
        public static int SyncValues(AppearanceProfile profile, SceneData scene)
        {
            if (profile == null || profile.IsBySet || profile.Ranges || scene == null) { return 0; }
            List<RuleValue> values = SearchSets.ValuesOf(scene, profile.Field, profile.Parameter);
            var known = new Dictionary<string, ProfileRule>(StringComparer.CurrentCultureIgnoreCase);
            foreach (ProfileRule rule in profile.Rules)
            {
                if (rule?.Value != null) { known.TryAdd(rule.Value, rule); }
            }

            int added = 0;
            foreach (RuleValue value in values)
            {
                if (known.TryGetValue(value.Value, out ProfileRule rule))
                {
                    rule.Label = value.Label;
                    continue;
                }
                profile.Rules.Add(new ProfileRule
                {
                    Value = value.Value,
                    Label = value.Label,
                    Colour = PaletteColour(profile.Palette, profile.Rules.Count)
                });
                added++;
            }
            return added;
        }

        /// <summary>Recolours every row from a palette (in row order) and makes it the profile's palette.</summary>
        public static void ApplyPalette(AppearanceProfile profile, string palette)
        {
            if (profile == null) { return; }
            profile.Palette = NormalisePalette(palette);
            for (int i = 0; i < profile.Rules.Count; i++) { profile.Rules[i].Colour = PaletteColour(profile.Palette, i); }
        }

        /// <summary>
        /// By value: changes the field (or parameter): the rows belong to the old field, so they are replaced by the new
        /// field's values.
        /// </summary>
        public static void SetField(AppearanceProfile profile, string field, string parameter, SceneData scene)
        {
            if (profile == null) { return; }
            profile.Field = RuleField.Normalise(field);
            profile.Parameter = profile.Field == RuleField.PARAMETER ? parameter : null;
            profile.Rules.Clear();
            if (profile.Ranges) { BuildRanges(profile, scene); }
            else { SyncValues(profile, scene); }
        }

        /// <summary>
        /// Colour round B: replaces a by-value profile's rows with number ranges coloured from its ramp; labels keep the
        /// values' unit ("300 – 450 mm"). Polish round P-C: cut by <see cref="AppearanceProfile.Binning"/>: equal widths
        /// (<see cref="AppearanceProfile.Bins"/> from the lowest to the highest number), equal counts (quantiles; ranges
        /// that would repeat a value merge, so there can be fewer) or the custom <see cref="AppearanceProfile.Breaks"/>
        /// (those between the lowest and highest number; none: one range). One range when every number is the same.
        /// Returns how many elements have a number (0: no rows).
        /// </summary>
        public static int BuildRanges(AppearanceProfile profile, SceneData scene)
        {
            if (profile == null || profile.IsBySet || scene?.Elements == null) { return 0; }
            profile.Ranges = true;
            profile.Bins = Math.Clamp(profile.Bins, MIN_BINS, MAX_BINS);
            profile.Binning = BinMethod.Normalise(profile.Binning);
            profile.Rules.Clear();

            string field = RuleField.Normalise(profile.Field);
            int nameIndex = field == RuleField.PARAMETER ? scene.Parameters?.IndexOfName(profile.Parameter) ?? -1 : -1;
            var numbers = new List<double>();
            var units = new Dictionary<string, int>(StringComparer.Ordinal);
            for (int e = 0; e < scene.Elements.Length; e++)
            {
                ElementRecord record = scene.Elements[e];
                if (record == null || record.IsLibraryTemplate) { continue; }
                if (!SearchSets.ElementValue(scene, record, e, field, nameIndex, out string text, out _) || !RuleNumbers.TryParse(text, out double number)) { continue; }
                numbers.Add(number);
                string unit = UnitOf(text);
                units[unit] = units.TryGetValue(unit, out int n) ? n + 1 : 1;
            }
            if (numbers.Count == 0) { return 0; }

            string suffix = units.OrderByDescending(kv => kv.Value).First().Key;
            List<double> edges = RangeEdges(numbers, profile.Binning, profile.Bins, profile.Breaks);
            int bins = edges.Count - 1;
            for (int i = 0; i < bins; i++)
            {
                double from = edges[i], to = edges[i + 1];
                profile.Rules.Add(new ProfileRule
                {
                    From = from,
                    To = to,
                    Label = from == to ? FormatNumber(from) + suffix : $"{FormatNumber(from)} – {FormatNumber(to)}{suffix}",
                    Colour = RampColour(profile.Ramp, bins == 1 ? 0.5f : (float)i / (bins - 1))
                });
            }
            return numbers.Count;
        }

        /// <summary>
        /// Polish round P-C: the range edges (ascending, first = lowest number, last = highest; n edges = n − 1 ranges) for
        /// a method. Every number falls in some range; one range (two equal edges) when they are all the same.
        /// </summary>
        public static List<double> RangeEdges(IReadOnlyList<double> numbers, string method, int bins, IReadOnlyList<double> breaks)
        {
            var edges = new List<double>();
            if (numbers == null || numbers.Count == 0) { return edges; }
            double min = double.MaxValue, max = double.MinValue;
            foreach (double v in numbers)
            {
                min = Math.Min(min, v);
                max = Math.Max(max, v);
            }
            if (!(max > min))
            {
                edges.Add(min);
                edges.Add(max);
                return edges;
            }
            bins = Math.Clamp(bins, MIN_BINS, MAX_BINS);
            edges.Add(min);
            switch (BinMethod.Normalise(method))
            {
                case BinMethod.QUANTILE:
                {
                    var sorted = numbers.OrderBy(v => v).ToArray();
                    for (int i = 1; i < bins; i++)
                    {
                        double edge = sorted[(int)Math.Round(i * (sorted.Length - 1) / (double)bins)];
                        if (edge > edges[^1] && edge < max) { edges.Add(edge); }
                    }
                    break;
                }
                case BinMethod.CUSTOM:
                    foreach (double edge in CleanBreaks(breaks?.ToList()) ?? new List<double>())
                    {
                        if (edge > edges[^1] && edge < max) { edges.Add(edge); }
                    }
                    break;
                default:
                {
                    double step = (max - min) / bins;
                    for (int i = 1; i < bins; i++) { edges.Add(min + step * i); }
                    break;
                }
            }
            edges.Add(max);
            return edges;
        }

        /// <summary>Most custom break values kept.</summary>
        public const int MAX_BREAKS = 24;

        /// <summary>Polish round P-C: finite, distinct, ascending break values (at most <see cref="MAX_BREAKS"/>); null when none.</summary>
        public static List<double> CleanBreaks(List<double> breaks)
        {
            if (breaks == null) { return null; }
            List<double> clean = breaks.Where(double.IsFinite).Distinct().OrderBy(v => v).Take(MAX_BREAKS).ToList();
            return clean.Count == 0 ? null : clean;
        }

        /// <summary>
        /// Polish round P-C: break values typed by people ("300; 450; 600" or "300 450 600"; a comma followed by a space
        /// separates too: "300, 450"); units and anything that isn't a number are ignored. Null when there are none.
        /// </summary>
        public static List<double> ParseBreaks(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) { return null; }
            var values = new List<double>();
            foreach (string part in text.Replace(", ", ";").Split(new[] { ';', ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (RuleNumbers.TryParse(part, out double value)) { values.Add(value); }
            }
            return CleanBreaks(values);
        }

        /// <summary>Polish round P-C: break values as people type them ("300; 450; 600"), empty when none.</summary>
        public static string FormatBreaks(IEnumerable<double> breaks) =>
            breaks == null ? string.Empty : string.Join("; ", breaks.Select(b => b.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)));

        /// <summary>Recolours a ranges profile's rows from a ramp (and makes it the profile's ramp).</summary>
        public static void ApplyRamp(AppearanceProfile profile, string ramp)
        {
            if (profile == null) { return; }
            profile.Ramp = NormaliseRamp(ramp);
            int n = profile.Rules.Count;
            for (int i = 0; i < n; i++) { profile.Rules[i].Colour = RampColour(profile.Ramp, n <= 1 ? 0.5f : (float)i / (n - 1)); }
        }

        /// <summary>The unit after a text's first number (" mm", " m²"), with its leading space, or empty.</summary>
        private static string UnitOf(string text)
        {
            if (string.IsNullOrEmpty(text)) { return string.Empty; }
            int i = 0;
            while (i < text.Length && !char.IsDigit(text[i])) { i++; }
            while (i < text.Length && (char.IsDigit(text[i]) || text[i] == '.' || text[i] == ',' || (text[i] == ' ' && i + 1 < text.Length && char.IsDigit(text[i + 1])))) { i++; }
            string unit = text[i..].Trim();
            if (unit.Length == 0 || unit.Length > 6 || unit.Any(char.IsDigit) || unit.Contains('/')) { return string.Empty; }
            return " " + unit;
        }

        /// <summary>A range end for labels: up to 2 decimals, digit grouping ("1,250.5").</summary>
        public static string FormatNumber(double value) =>
            value.ToString(Math.Abs(value) >= 100 ? "#,0.#" : "#,0.##", System.Globalization.CultureInfo.InvariantCulture);

        /// <summary>A profile's field label ("Level", "Fire Rating").</summary>
        public static string FieldLabel(AppearanceProfile profile) =>
            profile == null ? string.Empty : SearchSets.FieldLabel(profile.Field, profile.Parameter);

        /// <summary>A short description ("By Level · 6 values", "By set · 3 sets").</summary>
        public static string Describe(AppearanceProfile profile)
        {
            if (profile == null) { return string.Empty; }
            int n = profile.Rules.Count;
            return profile.IsBySet
                ? $"By search set · {n} set{(n == 1 ? string.Empty : "s")}"
                : profile.Ranges ? $"By {FieldLabel(profile)} · {n} range{(n == 1 ? string.Empty : "s")}"
                : $"By {FieldLabel(profile)} · {n} value{(n == 1 ? string.Empty : "s")}";
        }

        #endregion

        #region Evaluation

        /// <summary>
        /// What a profile does to every element: rows in order, the first that matches colours the element (rows that
        /// are off are skipped); the rest are unmatched (ghost / normal / flat colour). Library templates keep their
        /// normal look (they are never drawn as themselves).
        /// </summary>
        /// <param name="profile">The profile.</param>
        /// <param name="scene">The snapshot.</param>
        /// <param name="findSet">Finds a search set by id (by-set profiles), or null.</param>
        public static ProfileResult Evaluate(AppearanceProfile profile, SceneData scene, Func<string, SearchSet> findSet)
        {
            ElementRecord[] elements = scene?.Elements ?? Array.Empty<ElementRecord>();
            var codes = new uint[elements.Length];
            int ruleCount = profile?.Rules?.Count ?? 0;
            var counts = new int[ruleCount];
            if (profile == null) { return new ProfileResult { Codes = codes, RuleCounts = counts }; }

            string look = UnmatchedLook.Normalise(profile.Unmatched);
            uint unmatchedCode = look switch
            {
                UnmatchedLook.GHOST => (uint)CODE_GHOST << 24,
                UnmatchedLook.FLAT => Pack(LaunchSettings.TryParseColour(profile.UnmatchedColour, out uint flat) ? flat : 0xD6DADF, CODE_COLOUR),
                _ => CODE_NONE
            };

            // Each row's code once
            var ruleCodes = new uint[ruleCount];
            for (int r = 0; r < ruleCount; r++) { ruleCodes[r] = RuleCode(profile.Rules[r]); }

            int unmatched = 0, missing = 0, noNumber = 0;
            if (profile.IsBySet)
            {
                // Sets in row order (rows that are off or whose set is gone are skipped)
                var sets = new SearchSet[ruleCount];
                for (int r = 0; r < ruleCount; r++)
                {
                    ProfileRule rule = profile.Rules[r];
                    sets[r] = findSet?.Invoke(rule.SetId);
                    if (sets[r] == null) { missing++; }
                    if (!rule.On) { sets[r] = null; }
                }
                for (int e = 0; e < elements.Length; e++)
                {
                    ElementRecord record = elements[e];
                    if (record == null || record.IsLibraryTemplate) { continue; }
                    int hit = -1;
                    for (int r = 0; r < ruleCount && hit < 0; r++)
                    {
                        if (sets[r] != null && SearchSets.Matches(sets[r], scene, record, e)) { hit = r; }
                    }
                    if (hit >= 0)
                    {
                        codes[e] = ruleCodes[hit];
                        counts[hit]++;
                    }
                    else
                    {
                        codes[e] = unmatchedCode;
                        unmatched++;
                    }
                }
            }
            else if (profile.Ranges)
            {
                // Colour round B: number ranges: the first row (in order) whose range holds the element's number
                string field = RuleField.Normalise(profile.Field);
                for (int e = 0; e < elements.Length; e++)
                {
                    ElementRecord record = elements[e];
                    if (record == null || record.IsLibraryTemplate) { continue; }
                    int hit = -1;
                    if (SearchSets.NumberOf(scene, record, e, field, profile.Parameter, out double number))
                    {
                        for (int r = 0; r < ruleCount; r++)
                        {
                            ProfileRule rule = profile.Rules[r];
                            if (!rule.IsRange || number < rule.From.Value || number > rule.To.Value) { continue; }
                            counts[r]++;
                            if (rule.On) { hit = r; }
                            break;
                        }
                    }
                    else { noNumber++; }
                    if (hit >= 0) { codes[e] = ruleCodes[hit]; }
                    else
                    {
                        codes[e] = unmatchedCode;
                        unmatched++;
                    }
                }
            }
            else
            {
                // Values: one lookup per element (the first row with a value wins when a hand-edited file repeats it)
                var byValue = new Dictionary<string, int>(StringComparer.CurrentCultureIgnoreCase);
                for (int r = 0; r < ruleCount; r++)
                {
                    if (profile.Rules[r].Value != null) { byValue.TryAdd(profile.Rules[r].Value, r); }
                }
                string field = RuleField.Normalise(profile.Field);
                int nameIndex = field == RuleField.PARAMETER ? scene.Parameters?.IndexOfName(profile.Parameter) ?? -1 : -1;
                for (int e = 0; e < elements.Length; e++)
                {
                    ElementRecord record = elements[e];
                    if (record == null || record.IsLibraryTemplate) { continue; }
                    int hit = -1;
                    if (SearchSets.ElementValue(scene, record, e, field, nameIndex, out string value, out _) && byValue.TryGetValue(value, out int r))
                    {
                        counts[r]++;
                        if (profile.Rules[r].On) { hit = r; }
                    }
                    if (hit >= 0) { codes[e] = ruleCodes[hit]; }
                    else
                    {
                        codes[e] = unmatchedCode;
                        unmatched++;
                    }
                }
            }

            // Which kinds of code are in use (the renderer's blended pass, the session's hiding)
            bool anyGhost = unmatched > 0 && look == UnmatchedLook.GHOST, anySeeThrough = false, anyHidden = false;
            for (int r = 0; r < ruleCount; r++)
            {
                if (counts[r] == 0 || !profile.Rules[r].On) { continue; }
                uint code = ruleCodes[r] >> 24;
                if (code == CODE_HIDDEN) { anyHidden = true; }
                else if (code >= CODE_SEE_THROUGH && code < CODE_COLOUR) { anySeeThrough = true; }
            }

            return new ProfileResult
            {
                Codes = codes,
                RuleCounts = counts,
                Unmatched = unmatched,
                AnyGhost = anyGhost,
                AnyBlended = anyGhost || anySeeThrough,
                AnyHidden = anyHidden,
                MissingSets = missing,
                NoNumber = noNumber
            };
        }

        /// <summary>Packs 0xRRGGBB and a code into the renderer's R | G &lt;&lt; 8 | B &lt;&lt; 16 | A &lt;&lt; 24.</summary>
        public static uint Pack(uint rgb, byte code) =>
            ((rgb >> 16) & 0xFF) | (((rgb >> 8) & 0xFF) << 8) | ((rgb & 0xFF) << 16) | ((uint)code << 24);

        #endregion
    }

    /// <summary>
    /// Colour round B: a colour profiles file (EXPORT… / IMPORT… in the COLOUR PROFILES panel): readable JSON, the
    /// profiles and, for by-set profiles, the search sets they use (matched by name on import).
    /// </summary>
    public sealed class ProfileFile
    {
        /// <summary>"bimgo-colour-profiles".</summary>
        public string Format { get; set; } = ProfileFiles.FORMAT;

        /// <summary>The file layout version.</summary>
        public int Version { get; set; } = ProfileFiles.VERSION;

        /// <summary>The model it was exported from (information only).</summary>
        public string ModelTitle { get; set; } = string.Empty;

        /// <summary>The BimGo that wrote it.</summary>
        public string Generator { get; set; } = string.Empty;

        /// <summary>When (UTC).</summary>
        public DateTime ExportedUtc { get; set; }

        /// <summary>The profiles.</summary>
        public List<AppearanceProfile> Profiles { get; set; } = new();

        /// <summary>The search sets the by-set profiles use.</summary>
        public List<SearchSet> Sets { get; set; } = new();

        /// <summary>
        /// Polish round P-C: the links the sets' rules (and link-field rows) name, with their names, so another model can
        /// match them by name (older files: none).
        /// </summary>
        public List<ClashSetupLink> Links { get; set; } = new();
    }

    /// <summary>Polish round P-C: what reconciling an imported profile file did.</summary>
    public sealed class ProfileReconcile
    {
        /// <summary>Link and level values matched to this model by name (rules rewritten).</summary>
        public int Matched { get; set; }

        /// <summary>Link and level values this model doesn't have (left as they are: they match nothing): "Link: name".</summary>
        public List<string> Missing { get; set; } = new();
    }

    /// <summary>
    /// Colour round B: writes, reads and merges colour profile files. Never throws for IO: errors come back as text.
    /// </summary>
    public static class ProfileFiles
    {
        /// <summary>The format name.</summary>
        public const string FORMAT = "bimgo-colour-profiles";

        /// <summary>The version this build writes and reads.</summary>
        public const int VERSION = 1;

        /// <summary>The file extension.</summary>
        public const string EXTENSION = ".json";

        /// <summary>The file dialog filter.</summary>
        public const string FILTER = "BimGo colour profiles (*.json)|*.json|All files (*.*)|*.*";

        /// <summary>A file holding copies of the profiles and the sets their by-set rows use.</summary>
        /// <param name="links">P-C: the model's links (their names go in the file for matching elsewhere); optional.</param>
        public static ProfileFile Build(IEnumerable<AppearanceProfile> profiles, Func<string, SearchSet> findSet, string modelTitle, string generator,
            IReadOnlyList<LinkInfo> links = null)
        {
            var file = new ProfileFile { ModelTitle = modelTitle ?? string.Empty, Generator = generator ?? string.Empty, ExportedUtc = DateTime.UtcNow };
            var setIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (AppearanceProfile profile in profiles ?? Enumerable.Empty<AppearanceProfile>())
            {
                if (profile == null) { continue; }
                file.Profiles.Add(profile.Copy());
                if (!profile.IsBySet) { continue; }
                foreach (ProfileRule rule in profile.Rules)
                {
                    SearchSet set = findSet?.Invoke(rule.SetId);
                    if (set != null && setIds.Add(set.Id)) { file.Sets.Add(set.Copy()); }
                }
            }

            // P-C: the links named, with their names
            var named = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            void Name(string value)
            {
                if (string.IsNullOrEmpty(value) || !named.Add(value)) { return; }
                LinkInfo link = ClashSetupFiles.FindLink(links, value);
                file.Links.Add(new ClashSetupLink { UniqueId = value, Name = link?.Label ?? value });
            }
            foreach (SetRule rule in file.Sets.SelectMany(s => s.AllRules()))
            {
                if (RuleField.Normalise(rule.Field) != RuleField.LINK) { continue; }
                for (int i = 0; i < rule.ValueCount; i++) { Name(rule.ValueAt(i)); }
            }
            foreach (AppearanceProfile profile in file.Profiles)
            {
                if (profile.IsBySet || profile.Ranges || RuleField.Normalise(profile.Field) != RuleField.LINK) { continue; }
                foreach (ProfileRule rule in profile.Rules) { Name(rule.Value); }
            }
            return file;
        }

        /// <summary>
        /// Polish round P-C: before <see cref="Merge"/>, rewrites the file's link and level values for this model: a link
        /// this model doesn't have is matched by the name the file gives it, a level by its name (case ignored; this
        /// model's spelling kept). In set rules and in link / level rows of by-value profiles. What can't be matched is
        /// left as it is (it matches nothing here) and reported.
        /// </summary>
        public static ProfileReconcile Reconcile(ProfileFile file, IReadOnlyList<LinkInfo> links, IEnumerable<string> levels)
        {
            var result = new ProfileReconcile();
            if (file == null) { return result; }
            List<string> levelNames = (levels ?? Enumerable.Empty<string>()).Where(l => !string.IsNullOrEmpty(l)).ToList();
            var missing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            // One value: its replacement here (the same when it is fine), or null when it can't be matched
            string Map(string field, string value)
            {
                if (string.IsNullOrEmpty(value)) { return value; }
                if (field == RuleField.LINK)
                {
                    if (links == null) { return value; }
                    LinkInfo here = links.FirstOrDefault(l => string.Equals(l.InstanceUniqueId, value, StringComparison.OrdinalIgnoreCase));
                    if (here != null) { return value; }
                    string name = file.Links?.FirstOrDefault(l => string.Equals(l.UniqueId, value, StringComparison.OrdinalIgnoreCase))?.Name ?? value;
                    LinkInfo byName = ClashSetupFiles.FindLink(links, name);
                    if (byName != null && !string.IsNullOrEmpty(byName.InstanceUniqueId)) { return byName.InstanceUniqueId; }
                    missing.Add("Link: " + name);
                    return null;
                }
                if (field == RuleField.LEVEL)
                {
                    string level = levelNames.FirstOrDefault(l => string.Equals(l, value.Trim(), StringComparison.CurrentCultureIgnoreCase));
                    if (level != null) { return level; }
                    missing.Add("Level: " + value);
                    return null;
                }
                return value;
            }

            foreach (SetRule rule in file.Sets.SelectMany(s => s.AllRules()))
            {
                string field = RuleField.Normalise(rule.Field);
                if (field != RuleField.LINK && field != RuleField.LEVEL) { continue; }
                rule.Normalise();
                bool changed = false;
                var values = new List<string>(rule.Values.Count);
                foreach (string value in rule.Values)
                {
                    string mapped = Map(field, value) ?? value;
                    if (!string.Equals(mapped, value, StringComparison.Ordinal))
                    {
                        changed = true;
                        result.Matched++;
                    }
                    if (!values.Contains(mapped, StringComparer.OrdinalIgnoreCase)) { values.Add(mapped); }
                }
                if (changed) { rule.SetValues(values); }
            }
            foreach (AppearanceProfile profile in file.Profiles)
            {
                string field = RuleField.Normalise(profile.Field);
                if (profile.IsBySet || profile.Ranges || (field != RuleField.LINK && field != RuleField.LEVEL)) { continue; }
                foreach (ProfileRule rule in profile.Rules)
                {
                    string mapped = Map(field, rule.Value) ?? rule.Value;
                    if (string.Equals(mapped, rule.Value, StringComparison.Ordinal)) { continue; }
                    rule.Value = mapped;
                    result.Matched++;
                }
            }
            result.Missing.AddRange(missing.OrderBy(m => m, StringComparer.CurrentCultureIgnoreCase));
            return result;
        }

        /// <summary>The file's JSON (indented).</summary>
        public static byte[] Serialize(ProfileFile file) => System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(file, BimGo.Format.BimGoFormat.JSON_INDENTED);

        /// <summary>Writes a file (through a temporary file).</summary>
        public static bool Export(string path, ProfileFile file, out string error)
        {
            error = null;
            try
            {
                string temp = path + ".tmp";
                File.WriteAllBytes(temp, Serialize(file));
                File.Move(temp, path, overwrite: true);
                return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
            {
                error = $"The file could not be saved: {ex.Message}";
                Utilities.Log_Utils.Write(error);
                return false;
            }
        }

        /// <summary>Reads a file's JSON (cleaned), or null with a reason.</summary>
        public static ProfileFile Parse(byte[] json, out string error)
        {
            error = null;
            if (json == null || json.Length == 0) { error = "The file is empty."; return null; }
            try
            {
                ProfileFile file = System.Text.Json.JsonSerializer.Deserialize<ProfileFile>(json, BimGo.Format.BimGoFormat.JSON_INDENTED);
                if (file == null) { error = "The file is empty."; return null; }
                if (!string.Equals(file.Format, FORMAT, StringComparison.OrdinalIgnoreCase))
                {
                    error = "This is not a BimGo colour profiles file.";
                    return null;
                }
                if (file.Version > VERSION)
                {
                    error = $"This file was made by a newer BimGo (version {file.Version}). Please update BimGo.";
                    return null;
                }
                file.Profiles = (file.Profiles ?? new List<AppearanceProfile>()).Where(p => p != null).Select(p => p.Clean()).ToList();
                file.Sets = (file.Sets ?? new List<SearchSet>()).Where(x => x != null).ToList();
                foreach (SearchSet set in file.Sets)
                {
                    if (string.IsNullOrWhiteSpace(set.Id)) { set.Id = Guid.NewGuid().ToString("N"); }
                    set.Name = string.IsNullOrWhiteSpace(set.Name) ? "Imported set" : set.Name.Trim();
                    set.NormaliseRules();
                }
                return file;
            }
            catch (Exception ex) when (ex is System.Text.Json.JsonException or NotSupportedException or InvalidOperationException)
            {
                error = $"The file could not be read: {ex.Message}";
                Utilities.Log_Utils.Write(error);
                return null;
            }
        }

        /// <summary>Reads a file from disk (as <see cref="Parse"/>).</summary>
        public static ProfileFile Read(string path, out string error)
        {
            try { return Parse(File.ReadAllBytes(path), out error); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
            {
                error = $"The file could not be read: {ex.Message}";
                return null;
            }
        }

        /// <summary>
        /// Adds a file's profiles to a model's (new ids; a taken name gets " (imported)"). Their sets are matched by name
        /// (case ignored) with the model's sets, and added (new ids) when the model has none of that name; by-set rows
        /// then point at the model's sets. Link and level values in imported sets are kept as they are.
        /// </summary>
        /// <param name="file">The file.</param>
        /// <param name="into">The model's profiles.</param>
        /// <param name="sets">The model's search sets (clash detection's), or null when the file has none to place.</param>
        /// <param name="setsMatched">Sets found by name in the model.</param>
        /// <param name="setsAdded">Sets added to the model.</param>
        /// <returns>The profiles added (in file order).</returns>
        public static List<AppearanceProfile> Merge(ProfileFile file, AppearanceSettings into, List<SearchSet> sets, out int setsMatched, out int setsAdded)
        {
            setsMatched = setsAdded = 0;
            var added = new List<AppearanceProfile>();
            if (file == null || into == null) { return added; }

            // Sets: by name, else added
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (SearchSet set in file.Sets)
            {
                if (sets == null) { break; }
                SearchSet existing = sets.FirstOrDefault(x => string.Equals(x.Name, set.Name, StringComparison.CurrentCultureIgnoreCase));
                if (existing != null)
                {
                    map[set.Id] = existing.Id;
                    setsMatched++;
                    continue;
                }
                SearchSet copy = set.Copy(newId: true);
                sets.Add(copy);
                map[set.Id] = copy.Id;
                setsAdded++;
            }

            var names = new HashSet<string>(into.Profiles.Select(p => p.Name), StringComparer.CurrentCultureIgnoreCase);
            foreach (AppearanceProfile profile in file.Profiles)
            {
                AppearanceProfile copy = profile.Copy(newId: true);
                if (names.Contains(copy.Name)) { copy.Name += " (imported)"; }
                names.Add(copy.Name);
                foreach (ProfileRule rule in copy.Rules)
                {
                    if (rule.SetId != null && map.TryGetValue(rule.SetId, out string id)) { rule.SetId = id; }
                }
                into.Profiles.Add(copy.Clean());
                added.Add(copy);
            }
            return added;
        }
    }
}
