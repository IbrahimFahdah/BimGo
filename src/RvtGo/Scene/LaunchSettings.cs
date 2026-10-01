using System.Text.Json;
using System.Text.Json.Serialization;

// The class belongs to the Scene namespace
namespace RvtGo.Scene
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
    /// Options chosen in the launch dialog. Persisted between sessions as JSON in %AppData%\RvtGo.
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
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RvtGo", "settings.json");

        /// <summary>
        /// Loads saved settings, or defaults if none exist or the file can't be read.
        /// </summary>
        /// <returns>A LaunchSettings object.</returns>
        public static LaunchSettings LoadOrDefault()
        {
            try
            {
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
        /// Saves the settings. Failures are logged, never thrown.
        /// </summary>
        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath));
                File.WriteAllText(SettingsPath, JsonSerializer.Serialize(this, JSON_OPTIONS));
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
            TriangleThreshold = Math.Clamp(TriangleThreshold, 100, 5_000_000);
            Msaa = Msaa >= 4 ? 4 : Msaa >= 2 ? 2 : 0;
            MouseSensitivity = Math.Clamp(MouseSensitivity, 0.1f, 3f);
            FieldOfView = Math.Clamp(FieldOfView, 60f, 120f);
            MaxStepHeightMm = Math.Clamp(MaxStepHeightMm, 50f, 450f);
        }

        #endregion
    }
}
