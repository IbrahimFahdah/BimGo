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
            ExistingPhase = ExistingPhase?.Trim() ?? string.Empty;
            NewPhase = NewPhase?.Trim() ?? string.Empty;
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
