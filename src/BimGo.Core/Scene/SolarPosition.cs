using System.Numerics;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// A place on Earth for sun calculations: latitude / longitude in degrees (east and north positive) and the
    /// standard time zone in hours from UTC (daylight saving is applied separately, see <see cref="SolarPosition"/>).
    /// </summary>
    public readonly record struct GeoLocation(double Latitude, double Longitude, double TimeZone, string Name)
    {
        /// <summary>
        /// Used when a model carries no site location (files exported before v6): Sydney.
        /// </summary>
        public static GeoLocation Fallback { get; } = new(-33.8688, 151.2093, 10.0, "Sydney (assumed)");
    }

    /// <summary>
    /// Solar position from location, date and local clock time. Ported from Gavin's Pickles.Helpers.SunPosition, with
    /// the NOAA "General Solar Position Calculations" series for declination and the equation of time (about 0.01°
    /// instead of about 1°). Pure maths, double precision, no allocations, never throws.
    ///
    /// Directions use true-north axes: X = east, Y = north, Z = up. <see cref="ToModel"/> turns them into the model's
    /// internal axes using the extraction's internal → shared rotation (the same correction as
    /// <c>GetRevitSunVector</c>'s rotation by −true north).
    /// </summary>
    public static class SolarPosition
    {
        private const double DEG = Math.PI / 180.0;

        /// <summary>
        /// The sun's altitude (radians above the horizon) and azimuth (radians clockwise from true north).
        /// </summary>
        /// <param name="location">Where.</param>
        /// <param name="year">Calendar year (leap years matter for the day count).</param>
        /// <param name="month">1–12 (clamped).</param>
        /// <param name="day">1–31 (clamped to the month).</param>
        /// <param name="minutes">Local clock time in minutes after midnight (0–1440).</param>
        /// <param name="daylightSaving">True if the clock is on daylight saving (one hour ahead of standard time).</param>
        public static void Compute(GeoLocation location, int year, int month, int day, double minutes, bool daylightSaving,
            out double altitude, out double azimuth)
        {
            year = Math.Clamp(year, 1, 9999);
            month = Math.Clamp(month, 1, 12);
            day = Math.Clamp(day, 1, DateTime.DaysInMonth(year, month));
            minutes = Math.Clamp(minutes, 0.0, 1440.0);

            int dayOfYear = new DateTime(year, month, day).DayOfYear;
            int daysInYear = DateTime.IsLeapYear(year) ? 366 : 365;
            double hour = minutes / 60.0;

            // Fractional year (radians)
            double g = 2.0 * Math.PI / daysInYear * (dayOfYear - 1 + (hour - 12.0) / 24.0);

            // Equation of time (minutes) and declination (radians), NOAA
            double eqTime = 229.18 * (0.000075 + 0.001868 * Math.Cos(g) - 0.032077 * Math.Sin(g)
                - 0.014615 * Math.Cos(2 * g) - 0.040849 * Math.Sin(2 * g));
            double decl = 0.006918 - 0.399912 * Math.Cos(g) + 0.070257 * Math.Sin(g) - 0.006758 * Math.Cos(2 * g)
                + 0.000907 * Math.Sin(2 * g) - 0.002697 * Math.Cos(3 * g) + 0.00148 * Math.Sin(3 * g);

            // True solar time (minutes) and hour angle
            double zone = location.TimeZone + (daylightSaving ? 1.0 : 0.0);
            double trueSolar = minutes + eqTime + 4.0 * location.Longitude - 60.0 * zone;
            double hourAngle = (trueSolar / 4.0 - 180.0) * DEG;

            double lat = location.Latitude * DEG;
            double sinAlt = Math.Sin(lat) * Math.Sin(decl) + Math.Cos(lat) * Math.Cos(decl) * Math.Cos(hourAngle);
            sinAlt = Math.Clamp(sinAlt, -1.0, 1.0);
            altitude = Math.Asin(sinAlt);

            double cosAlt = Math.Cos(altitude);
            double cosLat = Math.Cos(lat);
            if (Math.Abs(cosAlt) < 1e-9 || Math.Abs(cosLat) < 1e-9)
            {
                azimuth = 0.0; // overhead or at a pole: azimuth undefined
                return;
            }

            // Azimuth clockwise from north (as in SunPosition.GetSunVector)
            double sinAz = -Math.Sin(hourAngle) * Math.Cos(decl) / cosAlt;
            double cosAz = (Math.Sin(decl) - Math.Sin(lat) * sinAlt) / (cosLat * cosAlt);
            azimuth = Math.Atan2(sinAz, cosAz);
            if (azimuth < 0) { azimuth += 2.0 * Math.PI; }
        }

        /// <summary>
        /// The unit vector towards the sun in true-north axes (X east, Y north, Z up).
        /// </summary>
        public static Vector3 Direction(double altitude, double azimuth)
        {
            double cosAlt = Math.Cos(altitude);
            var v = new Vector3((float)(Math.Sin(azimuth) * cosAlt), (float)(Math.Cos(azimuth) * cosAlt), (float)Math.Sin(altitude));
            return v.LengthSquared() > 1e-12f ? Vector3.Normalize(v) : Vector3.UnitZ;
        }

        /// <summary>
        /// A true-north direction in the model's internal (and scene) axes: rotated by −(internal → shared angle).
        /// </summary>
        /// <param name="trueNorth">The direction in true-north axes.</param>
        /// <param name="internalToSharedAngle">The model's internal → shared rotation (radians, counter-clockwise).</param>
        public static Vector3 ToModel(Vector3 trueNorth, double internalToSharedAngle)
        {
            double c = Math.Cos(-internalToSharedAngle), s = Math.Sin(-internalToSharedAngle);
            return new Vector3((float)(trueNorth.X * c - trueNorth.Y * s), (float)(trueNorth.X * s + trueNorth.Y * c), trueNorth.Z);
        }

        /// <summary>
        /// The model's internal → shared (true north) rotation from its site data (0 when unknown).
        /// </summary>
        public static double NorthAngle(SiteInfo site)
        {
            if (site == null) { return 0.0; }
            return SiteCoordinates.TryGetShared(site, out SiteCoordinates.SharedTransform shared) ? shared.Angle : site.TrueNorthAngle;
        }

        /// <summary>
        /// The model's site location, or <see cref="GeoLocation.Fallback"/> when the file has none.
        /// </summary>
        /// <param name="site">The site data.</param>
        /// <param name="known">False when the fallback was used.</param>
        public static GeoLocation LocationOf(SiteInfo site, out bool known)
        {
            known = site != null && site.HasLocation && double.IsFinite(site.Latitude) && double.IsFinite(site.Longitude)
                && Math.Abs(site.Latitude) <= 90.0 && Math.Abs(site.Longitude) <= 180.0;
            if (!known) { return GeoLocation.Fallback; }
            string name = string.IsNullOrWhiteSpace(site.PlaceName) ? $"{site.Latitude:0.###}°, {site.Longitude:0.###}°" : site.PlaceName.Trim();
            return new GeoLocation(site.Latitude, site.Longitude, Math.Clamp(site.TimeZone, -14.0, 14.0), name);
        }
    }
}
