using System.Globalization;
using BimGo.Scene;

// The class belongs to the Format namespace
namespace BimGo.Format
{
    /// <summary>
    /// A date and local clock time for the sun (the year is always the current one: it only matters for leap days).
    /// </summary>
    public sealed class SunTime
    {
        /// <summary>Month, 1–12.</summary>
        public int Month { get; set; } = 6;

        /// <summary>Day of the month, 1–31 (clamped to the month).</summary>
        public int Day { get; set; } = 21;

        /// <summary>Local clock time, minutes after midnight (0–1439).</summary>
        public int Minutes { get; set; } = 12 * 60;

        /// <summary>True if the clock is on daylight saving (one hour ahead of the site's standard time).</summary>
        public bool DaylightSaving { get; set; }

        /// <summary>
        /// A copy with every value clamped to something sensible (day to the month's length in <paramref name="year"/>).
        /// </summary>
        public SunTime Clamped(int year)
        {
            int month = Math.Clamp(Month, 1, 12);
            return new SunTime
            {
                Month = month,
                Day = Math.Clamp(Day, 1, DateTime.DaysInMonth(Math.Clamp(year, 1, 9999), month)),
                Minutes = Math.Clamp(Minutes, 0, 24 * 60 - 1),
                DaylightSaving = DaylightSaving
            };
        }

        /// <summary>A copy.</summary>
        public SunTime Copy() => new() { Month = Month, Day = Day, Minutes = Minutes, DaylightSaving = DaylightSaving };

        /// <summary>
        /// The start time for a model: the launch view's sun-study start (<see cref="SiteInfo.SunStart"/>), else
        /// today at 12:00.
        /// </summary>
        public static SunTime StartFor(SiteInfo site)
        {
            if (!string.IsNullOrWhiteSpace(site?.SunStart) &&
                DateTime.TryParseExact(site.SunStart.Trim(), "yyyy-MM-ddTHH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime start))
            {
                return new SunTime { Month = start.Month, Day = start.Day, Minutes = start.Hour * 60 + start.Minute };
            }
            DateTime today = DateTime.Today;
            return new SunTime { Month = today.Month, Day = today.Day, Minutes = 12 * 60 };
        }
    }

    /// <summary>
    /// The walkthrough's sun and shadow state as saved with a model (sun.json in a .bimgo, or
    /// &lt;model&gt;.bimgo-sun.json beside a Revit model in live sessions). Shadow quality is a per-machine setting
    /// (<see cref="LaunchSettings.ShadowQuality"/>), not stored here.
    /// </summary>
    public sealed class SunSettings
    {
        /// <summary>Lowest / highest intensity multiplier offered by the sliders.</summary>
        public const float MIN_INTENSITY = 0f, MAX_INTENSITY = 2f;

        public int Version { get; set; } = 1;

        /// <summary>Shadows (and sun lighting) on.</summary>
        public bool Enabled { get; set; }

        /// <summary>Date and time.</summary>
        public SunTime Time { get; set; } = new();

        /// <summary>Direct sunlight multiplier (1 = default).</summary>
        public float SunIntensity { get; set; } = 1f;

        /// <summary>Sky / diffuse (ambient) light multiplier (1 = default).</summary>
        public float SkyIntensity { get; set; } = 1f;

        /// <summary>How much direct light shadows remove: 1 = full shadows, 0 = none.</summary>
        public float ShadowIntensity { get; set; } = 1f;

        /// <summary>Light through transparent materials: 1 = as the material's transparency, 0 = opaque, 2 = double.</summary>
        public float GlassTransmission { get; set; } = 1f;

        /// <summary>
        /// Clamps everything into range (guards against hand-edited files). Returns this for chaining.
        /// </summary>
        public SunSettings Clean()
        {
            Time = (Time ?? new SunTime()).Clamped(DateTime.Today.Year);
            SunIntensity = Clamp(SunIntensity, MIN_INTENSITY, MAX_INTENSITY, 1f);
            SkyIntensity = Clamp(SkyIntensity, MIN_INTENSITY, MAX_INTENSITY, 1f);
            ShadowIntensity = Clamp(ShadowIntensity, 0f, 1f, 1f);
            GlassTransmission = Clamp(GlassTransmission, 0f, 2f, 1f);
            return this;
        }

        /// <summary>A copy.</summary>
        public SunSettings Copy() => new()
        {
            Enabled = Enabled,
            Time = Time?.Copy() ?? new SunTime(),
            SunIntensity = SunIntensity,
            SkyIntensity = SkyIntensity,
            ShadowIntensity = ShadowIntensity,
            GlassTransmission = GlassTransmission
        };

        /// <summary>
        /// Defaults for a model: shadows off, time from the model's sun-study start (else today, 12:00).
        /// </summary>
        public static SunSettings DefaultsFor(SiteInfo site) => new() { Time = SunTime.StartFor(site) };

        private static float Clamp(float value, float min, float max, float fallback) =>
            float.IsFinite(value) ? Math.Clamp(value, min, max) : fallback;
    }
}
