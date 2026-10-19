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
    /// Round K-C: a sun time part way between two others (the tour and camera paths animate the sun with it). The date
    /// moves the short way round the year (December → January goes through New Year, not back through the whole year);
    /// the clock time moves straight from one to the other; daylight saving switches halfway.
    /// </summary>
    public static class SunBlend
    {
        /// <summary>
        /// Fills <paramref name="into"/> with the time <paramref name="t"/> of the way from <paramref name="a"/> to
        /// <paramref name="b"/>. Allocation-free.
        /// </summary>
        /// <param name="a">From.</param>
        /// <param name="b">To.</param>
        /// <param name="t">0 (a) – 1 (b); clamped.</param>
        /// <param name="year">The year (leap days).</param>
        /// <param name="into">Receives the month, day, whole minutes and daylight saving.</param>
        /// <returns>The clock time in fractional minutes (0 – 1439.99), so the sun can move smoothly.</returns>
        public static double Between(SunTime a, SunTime b, float t, int year, SunTime into)
        {
            t = float.IsFinite(t) ? Math.Clamp(t, 0f, 1f) : 0f;
            year = Math.Clamp(year, 1, 9998);
            int days = DateTime.IsLeapYear(year) ? 366 : 365;
            int dayA = DayOfYear(year, a), dayB = DayOfYear(year, b);
            int span = dayB - dayA;
            if (span > days / 2) { span -= days; }
            else if (span < -(days / 2)) { span += days; }
            int day = (int)MathF.Round(dayA + span * t);
            day = ((day - 1) % days + days) % days + 1;
            DateTime date = new DateTime(year, 1, 1).AddDays(day - 1);
            into.Month = date.Month;
            into.Day = date.Day;
            int minutesA = Math.Clamp(a.Minutes, 0, 1439), minutesB = Math.Clamp(b.Minutes, 0, 1439);
            double minutes = Math.Clamp(minutesA + (minutesB - minutesA) * (double)t, 0.0, 1439.99);
            into.Minutes = Math.Clamp((int)minutes, 0, 1439);
            into.DaylightSaving = t < 0.5f ? a.DaylightSaving : b.DaylightSaving;
            return minutes;
        }

        /// <summary>A sun time's day of the year (1–366) in <paramref name="year"/> (the day clamped to its month).</summary>
        public static int DayOfYear(int year, SunTime time)
        {
            int month = Math.Clamp(time.Month, 1, 12);
            return new DateTime(year, month, Math.Clamp(time.Day, 1, DateTime.DaysInMonth(year, month))).DayOfYear;
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

        /// <summary>Sky round: cloud cover, 0 = clear sky (the default), 1 = overcast. A look only: lighting is unchanged.</summary>
        public float CloudCover { get; set; }

        /// <summary>Sky round: cloud drift speed multiplier (0 = still, 1 = default, 2 = double).</summary>
        public float CloudSpeed { get; set; } = 1f;

        /// <summary>Sky round: sun disc size multiplier (0.25–2, 1 = default). A look only.</summary>
        public float SunSize { get; set; } = 1f;

        /// <summary>Sky round: sun glare (halo) multiplier (0 = none, 1 = default, 2 = double). A look only.</summary>
        public float SunGlare { get; set; } = 1f;

        /// <summary>Smallest sun disc size multiplier.</summary>
        public const float MIN_SUN_SIZE = 0.25f;

        /// <summary>
        /// Round W-A: the moon in the night sky (its real place and phase). When the sun is down it lights the scene and
        /// casts the shadows (dim, cool, by its phase). Older files read as on.
        /// </summary>
        public bool Moon { get; set; } = true;

        /// <summary>
        /// Round W-A: a chosen phase (the lit fraction, 0.05–1: full 1, gibbous 0.8, half 0.5, crescent 0.2) instead of
        /// the real one for the date, or null for the real phase. The moon stays where it really is in the sky.
        /// </summary>
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public float? MoonPhase { get; set; }

        /// <summary>Round W-A: moonlight multiplier (0 = no moonlight, 1 = default, 2 = double).</summary>
        public float MoonLight { get; set; } = 1f;

        /// <summary>Round W-A: stars at night (turning with the sky for the site's latitude).</summary>
        public bool Stars { get; set; } = true;

        /// <summary>Round W-A: how many stars (0–2, 1 = default).</summary>
        public float StarDensity { get; set; } = 1f;

        /// <summary>Round W-A: how bright the stars are (0–2, 1 = default).</summary>
        public float StarBrightness { get; set; } = 1f;

        /// <summary>Round W-A: how much the stars twinkle (0 = steady, 1 = default, 2 = double).</summary>
        public float StarTwinkle { get; set; } = 1f;

        /// <summary>Round W-A: the Milky Way band's strength (0 = none, 1 = default, 2 = double).</summary>
        public float MilkyWay { get; set; } = 1f;

        /// <summary>
        /// Round W-B: the weather: "off" (the default), "rain" or "snow" (a string, so a later kind never fails an older
        /// reader; anything unknown reads as off). Shows in the classic light and with shadows on.
        /// </summary>
        public string Weather { get; set; } = WEATHER_OFF;

        /// <summary>Round W-B: the weather's values.</summary>
        public const string WEATHER_OFF = "off", WEATHER_RAIN = "rain", WEATHER_SNOW = "snow";

        /// <summary>Round W-B: how hard it rains or snows (0.05–1; 0.5 = steady).</summary>
        public float WeatherIntensity { get; set; } = 0.5f;

        /// <summary>Round W-B: how wet open surfaces look while it rains (0 = dry, 1 = the default, soaked with puddles).</summary>
        public float Wetness { get; set; } = 1f;

        /// <summary>Round W-B: how much snow has settled on open, up-facing surfaces while it snows (0 = none, 1 = deep).</summary>
        public float SnowCover { get; set; } = 0.6f;

        /// <summary>Round W-C: lightning while it rains (off by default).</summary>
        public bool Lightning { get; set; }

        /// <summary>Round W-C: how often it strikes: 0 rare, 1 sometimes (the default), 2 often.</summary>
        public int LightningFrequency { get; set; } = 1;

        /// <summary>Round W-C: how much a strike brightens the scene (0 = sky only, 1 = strongest; 0.35 = the default).</summary>
        public float LightningFlash { get; set; } = 0.35f;

        /// <summary>Round W-C: photosensitive comfort: each strike is one slow glow instead of flickers.</summary>
        public bool ReduceFlashing { get; set; }

        /// <summary>Round W-C: drops (rain) and melting flakes (snow) on the lens now and then, outdoors (never in photos or videos).</summary>
        public bool LensDrops { get; set; } = true;

        /// <summary>Round W-C: the rain's hiss (quieter under a roof) and thunder.</summary>
        public bool WeatherSound { get; set; } = true;

        /// <summary>Round W-B: true when it is raining.</summary>
        [System.Text.Json.Serialization.JsonIgnore]
        public bool Raining => Weather == WEATHER_RAIN;

        /// <summary>Round W-B: true when it is snowing.</summary>
        [System.Text.Json.Serialization.JsonIgnore]
        public bool Snowing => Weather == WEATHER_SNOW;

        /// <summary>
        /// A location chosen in BimGo instead of the model's (location override), or null to use the Revit site's.
        /// Older readers ignore it; Revit is never changed.
        /// </summary>
        public LocationOverride Location { get; set; }

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
            CloudCover = Clamp(CloudCover, 0f, 1f, 0f);
            CloudSpeed = Clamp(CloudSpeed, 0f, 2f, 1f);
            SunSize = Clamp(SunSize, MIN_SUN_SIZE, 2f, 1f);
            SunGlare = Clamp(SunGlare, 0f, 2f, 1f);
            MoonLight = Clamp(MoonLight, 0f, 2f, 1f);
            if (MoonPhase is float phase) { MoonPhase = float.IsFinite(phase) ? Math.Clamp(phase, 0.05f, 1f) : null; }
            StarDensity = Clamp(StarDensity, 0f, 2f, 1f);
            StarBrightness = Clamp(StarBrightness, 0f, 2f, 1f);
            StarTwinkle = Clamp(StarTwinkle, 0f, 2f, 1f);
            MilkyWay = Clamp(MilkyWay, 0f, 2f, 1f);
            string weather = Weather?.Trim().ToLowerInvariant();
            Weather = weather is WEATHER_RAIN or WEATHER_SNOW ? weather : WEATHER_OFF;
            WeatherIntensity = Clamp(WeatherIntensity, 0.05f, 1f, 0.5f);
            Wetness = Clamp(Wetness, 0f, 1f, 1f);
            SnowCover = Clamp(SnowCover, 0f, 1f, 0.6f);
            LightningFrequency = Math.Clamp(LightningFrequency, 0, 2);
            LightningFlash = Clamp(LightningFlash, 0f, 1f, 0.35f);
            if (Location != null && !Location.Clean().IsValid) { Location = null; }
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
            GlassTransmission = GlassTransmission,
            CloudCover = CloudCover,
            CloudSpeed = CloudSpeed,
            SunSize = SunSize,
            SunGlare = SunGlare,
            Moon = Moon,
            MoonPhase = MoonPhase,
            MoonLight = MoonLight,
            Stars = Stars,
            StarDensity = StarDensity,
            StarBrightness = StarBrightness,
            StarTwinkle = StarTwinkle,
            MilkyWay = MilkyWay,
            Weather = Weather,
            WeatherIntensity = WeatherIntensity,
            Wetness = Wetness,
            SnowCover = SnowCover,
            Lightning = Lightning,
            LightningFrequency = LightningFrequency,
            LightningFlash = LightningFlash,
            ReduceFlashing = ReduceFlashing,
            LensDrops = LensDrops,
            WeatherSound = WeatherSound,
            Location = Location?.Copy()
        };

        /// <summary>
        /// Defaults for a model: shadows off, time from the model's sun-study start (else today, 12:00).
        /// </summary>
        public static SunSettings DefaultsFor(SiteInfo site) => new() { Time = SunTime.StartFor(site) };

        private static float Clamp(float value, float min, float max, float fallback) =>
            float.IsFinite(value) ? Math.Clamp(value, min, max) : fallback;
    }

    /// <summary>
    /// A site location chosen in BimGo (searched from the bundled place list, or typed as latitude / longitude) that
    /// replaces the Revit site's for the sun, shadows and the daylight studies. True north stays the model's.
    /// </summary>
    public sealed class LocationOverride
    {
        /// <summary>Latitude (degrees, north positive).</summary>
        public double Latitude { get; set; }

        /// <summary>Longitude (degrees, east positive).</summary>
        public double Longitude { get; set; }

        /// <summary>Standard time zone (hours from UTC, without daylight saving).</summary>
        public double TimeZone { get; set; }

        /// <summary>The IANA time zone (e.g. "Australia/Sydney"), or null when only the offset is known.</summary>
        public string ZoneId { get; set; }

        /// <summary>
        /// Daylight saving follows <see cref="ZoneId"/>'s rules for the date (default). Off: the manual +1 h DST tick
        /// decides, as for the model's own location.
        /// </summary>
        public bool AutoDaylightSaving { get; set; } = true;

        /// <summary>What to call the place ("Sydney, New South Wales, Australia" or "−33.86°, 151.21°").</summary>
        public string Name { get; set; } = string.Empty;

        /// <summary>True when the coordinates and the offset are usable.</summary>
        [System.Text.Json.Serialization.JsonIgnore]
        public bool IsValid => double.IsFinite(Latitude) && double.IsFinite(Longitude) && double.IsFinite(TimeZone)
            && Math.Abs(Latitude) <= 90.0 && Math.Abs(Longitude) <= 180.0;

        /// <summary>
        /// Clamps the offset, trims the texts (hand-edited files). Returns this for chaining; check <see cref="IsValid"/>.
        /// </summary>
        public LocationOverride Clean()
        {
            if (double.IsFinite(TimeZone)) { TimeZone = Math.Clamp(TimeZone, -14.0, 14.0); }
            ZoneId = string.IsNullOrWhiteSpace(ZoneId) ? null : ZoneId.Trim();
            Name = (Name ?? string.Empty).Trim();
            if (Name.Length > 120) { Name = Name[..120]; }
            return this;
        }

        /// <summary>A copy.</summary>
        public LocationOverride Copy() => (LocationOverride)MemberwiseClone();
    }
}
