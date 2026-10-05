using System.Text.Json;
using System.Text.Json.Serialization;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// What to do with an element whose triangle count exceeds the threshold.
    /// </summary>
    public enum OverLimitMode
    {
        /// <summary>Replace the element with its bounding box.</summary>
        Proxy = 0,

        /// <summary>Leave the element out.</summary>
        Skip = 1
    }

    /// <summary>
    /// Shadow-map quality: resolution, number of cascades and edge softening (see the renderer's presets).
    /// </summary>
    public enum ShadowQuality
    {
        /// <summary>One 2048 px map near the player, hard edges.</summary>
        Low = 0,

        /// <summary>Three 2048 px cascades, softened edges.</summary>
        Medium = 1,

        /// <summary>Four 3072 px cascades, softer edges, longer shadow distance.</summary>
        High = 2
    }

    /// <summary>
    /// How geometry is coloured.
    /// </summary>
    public enum ColourMode
    {
        /// <summary>Greyscale study-model look.</summary>
        Whitecard = 0,

        /// <summary>Material colours cached from Revit.</summary>
        Material = 1
    }

    /// <summary>
    /// Options chosen in the launch dialog. Persisted as JSON in %AppData%\BimGo\settings.json and
    /// shared by the Revit add-in (extraction options) and the standalone app (display options).
    /// </summary>
    public sealed class LaunchSettings
    {
        /// <summary>Keys of the enabled category definitions.</summary>
        public List<string> EnabledCategories { get; set; } = Scene.CategoryCatalog.DefaultEnabledKeys();

        /// <summary>
        /// Extract only what the active view shows (off by default): every model element visible in the view comes in,
        /// whatever its category tick, phase or design option; ticked links contribute what the view shows of them.
        /// </summary>
        public bool ActiveViewOnly { get; set; }

        /// <summary>
        /// Leave out helper geometry: the Light Source subcategory (IES / photometric cones) and any subcategory whose
        /// name contains one of <see cref="HelperSubcategoryKeywords"/> (clearance zones, spray cones…). On by default.
        /// </summary>
        public bool SkipHelperGeometry { get; set; } = true;

        /// <summary>Subcategory name fragments (case-insensitive) treated as helper geometry.</summary>
        public List<string> HelperSubcategoryKeywords { get; set; } = DefaultHelperKeywords();

        /// <summary>The default helper subcategory keywords.</summary>
        public static List<string> DefaultHelperKeywords() => new() { "light source", "clearance", "zone", "cone", "photometric" };

        /// <summary>Triangle threshold per element (FFE and Services only).</summary>
        public int TriangleThreshold { get; set; } = 20000;

        /// <summary>Fallback for elements over the threshold.</summary>
        public OverLimitMode OverLimit { get; set; } = OverLimitMode.Proxy;

        /// <summary>Colour mode at launch.</summary>
        public ColourMode Colour { get; set; } = ColourMode.Whitecard;

        /// <summary>MSAA samples (0, 2 or 4).</summary>
        public int Msaa { get; set; } = 0;

        /// <summary>Mouse sensitivity multiplier.</summary>
        public float MouseSensitivity { get; set; } = 1.0f;

        /// <summary>Horizontal field of view in degrees.</summary>
        public float FieldOfView { get; set; } = 90f;

        /// <summary>Invert vertical mouse look.</summary>
        public bool InvertY { get; set; }

        /// <summary>Synchronise presentation to the display refresh rate.</summary>
        public bool VSync { get; set; } = true;

        /// <summary>Load comments from the JSON sidecar.</summary>
        public bool LoadComments { get; set; } = true;

        /// <summary>Show the FPS readout.</summary>
        public bool ShowFps { get; set; } = true;

        /// <summary>Maximum riser the player steps up without jumping (mm).</summary>
        public float MaxStepHeightMm { get; set; } = 200f;

        /// <summary>Gizmo / Clone: move and rotate in fixed increments (G toggles in the walkthrough).</summary>
        public bool GizmoSnap { get; set; }

        /// <summary>Gizmo / Clone snap: move increment (mm), one of <see cref="SNAP_MOVE_STEPS_MM"/>.</summary>
        public float SnapMoveMm { get; set; } = 50f;

        /// <summary>Gizmo / Clone snap: rotation increment (degrees), one of <see cref="SNAP_ANGLE_STEPS_DEG"/>.</summary>
        public float SnapAngleDeg { get; set; } = 15f;

        /// <summary>
        /// Extra parameter names to extract per element (instance first, then type). Shown by the Scan gun and
        /// stored in .bimgo files. Empty by default.
        /// </summary>
        public List<string> ExtraParameters { get; set; } = new();

        /// <summary>
        /// The "existing" phase by name: what is there before the works. Only elements that exist in this phase (and
        /// still stand in <see cref="NewPhase"/>) can be demolished. Empty = the phase before the new phase.
        /// Names (not ids) are stored because the settings are shared by every model.
        /// </summary>
        public string ExistingPhase { get; set; } = string.Empty;

        /// <summary>
        /// The "new" phase by name: the walkthrough shows the model as it stands in this phase, demolition sets
        /// Phase Demolished to it and clones are created in it. Empty = the launch view's phase, else the last phase.
        /// </summary>
        public string NewPhase { get; set; } = string.Empty;

        /// <summary>
        /// Linked models to extract with each host model: host model key (<c>ProjectInformation.UniqueId</c>) → the
        /// UniqueIds of the ticked RevitLinkInstances. A model with no entry extracts no links (the default); the
        /// Options dialog pre-ticks the saved choice and Refresh (F5) reuses it.
        /// </summary>
        public Dictionary<string, List<string>> LinkedModels { get; set; } = new(StringComparer.Ordinal);

        /// <summary>Most host models remembered in <see cref="LinkedModels"/> (oldest entries are dropped).</summary>
        public const int MAX_LINKED_MODEL_ENTRIES = 200;

        /// <summary>
        /// The link instances (UniqueIds) ticked for a host model; empty when none (never null).
        /// </summary>
        /// <param name="hostModelKey">The host model key.</param>
        public IReadOnlyList<string> LinksFor(string hostModelKey)
        {
            if (string.IsNullOrEmpty(hostModelKey) || LinkedModels == null) { return Array.Empty<string>(); }
            return LinkedModels.TryGetValue(hostModelKey, out List<string> links) && links != null ? links : Array.Empty<string>();
        }

        /// <summary>
        /// Remembers the link instances ticked for a host model (an empty choice removes the entry).
        /// </summary>
        /// <param name="hostModelKey">The host model key.</param>
        /// <param name="linkInstanceIds">The ticked RevitLinkInstance UniqueIds.</param>
        public void SetLinksFor(string hostModelKey, IEnumerable<string> linkInstanceIds)
        {
            if (string.IsNullOrEmpty(hostModelKey)) { return; }
            LinkedModels ??= new Dictionary<string, List<string>>(StringComparer.Ordinal);
            List<string> links = (linkInstanceIds ?? Enumerable.Empty<string>())
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Distinct(StringComparer.Ordinal)
                .ToList();

            // Keep the list bounded (models not seen for a long time lose their choice: none, the default)
            LinkedModels.Remove(hostModelKey);
            if (links.Count > 0) { LinkedModels[hostModelKey] = links; }
            while (LinkedModels.Count > MAX_LINKED_MODEL_ENTRIES) { LinkedModels.Remove(LinkedModels.Keys.First()); }
        }

        /// <summary>Shadow-map quality on this machine (the sun panel and the Options dialog change it).</summary>
        public ShadowQuality ShadowQuality { get; set; } = ShadowQuality.Medium;

        /// <summary>The walkthrough's coordinate readout (L cycles it; remembered between sessions).</summary>
        public CoordinateReadout CoordinateReadout { get; set; } = CoordinateReadout.Off;

        /// <summary>Move increments offered for gizmo snapping (mm).</summary>
        public static readonly float[] SNAP_MOVE_STEPS_MM = { 5f, 10f, 25f, 50f, 100f, 250f, 500f, 1000f };

        /// <summary>Rotation increments offered for gizmo snapping (degrees).</summary>
        public static readonly float[] SNAP_ANGLE_STEPS_DEG = { 1f, 5f, 10f, 15f, 30f, 45f, 90f };

        /// <summary>
        /// The preset nearest to a value (keeps hand-edited settings on the offered steps).
        /// </summary>
        public static float NearestStep(float[] steps, float value)
        {
            float best = steps[0];
            foreach (float step in steps)
            {
                if (MathF.Abs(step - value) < MathF.Abs(best - value)) { best = step; }
            }
            return best;
        }

        /// <summary>Upper bound on extra parameters (keeps the Scan panel and file size sensible).</summary>
        public const int MAX_EXTRA_PARAMETERS = 24;

        #region Persistence

        private static readonly JsonSerializerOptions JSON_OPTIONS = new()
        {
            WriteIndented = true,
            Converters = { new JsonStringEnumConverter() }
        };

        /// <summary>
        /// The path of the settings file.
        /// </summary>
        public static string SettingsPath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BimGo", "settings.json");

        /// <summary>
        /// The pre-BimGo settings file (%AppData%\RvtGo\settings.json), copied across once if no BimGo file exists.
        /// </summary>
        private static string LegacySettingsPath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RvtGo", "settings.json");

        /// <summary>
        /// Loads saved settings, or defaults if none exist or the file can't be read.
        /// </summary>
        /// <returns>A LaunchSettings object.</returns>
        public static LaunchSettings LoadOrDefault()
        {
            try
            {
                MigrateLegacy();
                if (File.Exists(SettingsPath))
                {
                    string json = File.ReadAllText(SettingsPath);
                    if (JsonSerializer.Deserialize<LaunchSettings>(json, JSON_OPTIONS) is LaunchSettings loaded)
                    {
                        loaded.Sanitise();
                        return loaded;
                    }
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Settings could not be read, using defaults: {ex.Message}");
            }
            return new LaunchSettings();
        }

        /// <summary>
        /// Copies the RvtGo settings file to the BimGo location once (the old file is left in place).
        /// </summary>
        private static void MigrateLegacy()
        {
            try
            {
                if (File.Exists(SettingsPath) || !File.Exists(LegacySettingsPath)) { return; }
                Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath));
                File.Copy(LegacySettingsPath, SettingsPath, overwrite: false);
                Utilities.Log_Utils.Write("Settings migrated from RvtGo.");
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Settings migration skipped: {ex.Message}");
            }
        }

        /// <summary>
        /// Saves the settings. Failures are logged, never thrown.
        /// </summary>
        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath));
                string temp = SettingsPath + ".tmp";
                File.WriteAllText(temp, JsonSerializer.Serialize(this, JSON_OPTIONS));
                File.Move(temp, SettingsPath, overwrite: true);
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Settings could not be saved: {ex.Message}");
            }
        }

        /// <summary>
        /// Clamps values into valid ranges (guards against hand-edited files).
        /// </summary>
        public void Sanitise()
        {
            EnabledCategories ??= Scene.CategoryCatalog.DefaultEnabledKeys();
            ExtraParameters = (ExtraParameters ?? new List<string>())
                .Where(n => !string.IsNullOrWhiteSpace(n))
                .Select(n => n.Trim())
                .Distinct(StringComparer.Ordinal)
                .Take(MAX_EXTRA_PARAMETERS)
                .ToList();
            LinkedModels = LinkedModels == null
                ? new Dictionary<string, List<string>>(StringComparer.Ordinal)
                : LinkedModels
                    .Where(p => !string.IsNullOrEmpty(p.Key) && p.Value != null && p.Value.Count > 0)
                    .ToDictionary(p => p.Key, p => p.Value.Where(id => !string.IsNullOrWhiteSpace(id)).Distinct(StringComparer.Ordinal).ToList(), StringComparer.Ordinal);
            HelperSubcategoryKeywords = (HelperSubcategoryKeywords ?? DefaultHelperKeywords())
                .Where(k => !string.IsNullOrWhiteSpace(k))
                .Select(k => k.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(40)
                .ToList();
            ExistingPhase = ExistingPhase?.Trim() ?? string.Empty;
            NewPhase = NewPhase?.Trim() ?? string.Empty;
            if (!Enum.IsDefined(CoordinateReadout)) { CoordinateReadout = CoordinateReadout.Off; }
            if (!Enum.IsDefined(ShadowQuality)) { ShadowQuality = ShadowQuality.Medium; }
            TriangleThreshold = Math.Clamp(TriangleThreshold, 100, 5_000_000);
            Msaa = Msaa >= 4 ? 4 : Msaa >= 2 ? 2 : 0;
            MouseSensitivity = Math.Clamp(MouseSensitivity, 0.1f, 3f);
            FieldOfView = Math.Clamp(FieldOfView, 60f, 120f);
            MaxStepHeightMm = Math.Clamp(MaxStepHeightMm, 50f, 450f);
            SnapMoveMm = NearestStep(SNAP_MOVE_STEPS_MM, SnapMoveMm);
            SnapAngleDeg = NearestStep(SNAP_ANGLE_STEPS_DEG, SnapAngleDeg);
        }

        #endregion
    }
}
