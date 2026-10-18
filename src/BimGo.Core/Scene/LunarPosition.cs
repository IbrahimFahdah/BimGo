using System.Numerics;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Round W-A: the moon's place in the sky, its phase, and the frame the stars turn in, from the location, date and
    /// local clock time (the same inputs as <see cref="SolarPosition"/>). Paul Schlyter's low-precision orbital
    /// elements with the main perturbations and topocentric parallax: about a quarter of a degree, plenty for a sky.
    /// Pure maths, double precision, no allocations, never throws. Directions use true-north axes (X east, Y north,
    /// Z up), as <see cref="SolarPosition.Direction"/>; azimuths are clockwise from true north.
    /// </summary>
    public static class LunarPosition
    {
        private const double DEG = Math.PI / 180.0;

        /// <summary>
        /// The moon's altitude (radians above the horizon, parallax corrected), azimuth (radians clockwise from true
        /// north), lit fraction (0 new – 1 full) and whether it is waxing.
        /// </summary>
        public static void Compute(GeoLocation location, int year, int month, int day, double minutes, bool daylightSaving,
            out double altitude, out double azimuth, out double illuminated, out bool waxing)
        {
            double d = DayNumber(location, year, month, day, minutes, daylightSaving, out double ut);

            // The sun (for the perturbations, sidereal time and the phase)
            double ms = Rev(356.0470 + 0.9856002585 * d);
            double ws = 282.9404 + 4.70935e-5 * d;
            double ls = Rev(ms + ws);
            double sunLongitude = Rev(ls + 1.915 * Math.Sin(ms * DEG) + 0.020 * Math.Sin(2.0 * ms * DEG));

            // The moon's orbit
            double n = Rev(125.1228 - 0.0529538083 * d);
            const double i = 5.1454;
            double w = Rev(318.0634 + 0.1643573223 * d);
            const double a = 60.2666, e = 0.054900;
            double m = Rev(115.3654 + 13.0649929509 * d);

            double ecc = m * DEG + e * Math.Sin(m * DEG) * (1.0 + e * Math.Cos(m * DEG));
            for (int k = 0; k < 5; k++) { ecc -= (ecc - e * Math.Sin(ecc) - m * DEG) / (1.0 - e * Math.Cos(ecc)); }
            double xv = a * (Math.Cos(ecc) - e), yv = a * Math.Sqrt(1.0 - e * e) * Math.Sin(ecc);
            double v = Math.Atan2(yv, xv) / DEG;
            double r = Math.Sqrt(xv * xv + yv * yv);

            double vw = (v + w) * DEG;
            double xh = r * (Math.Cos(n * DEG) * Math.Cos(vw) - Math.Sin(n * DEG) * Math.Sin(vw) * Math.Cos(i * DEG));
            double yh = r * (Math.Sin(n * DEG) * Math.Cos(vw) + Math.Cos(n * DEG) * Math.Sin(vw) * Math.Cos(i * DEG));
            double zh = r * Math.Sin(vw) * Math.Sin(i * DEG);
            double lon = Math.Atan2(yh, xh) / DEG;
            double lat = Math.Atan2(zh, Math.Sqrt(xh * xh + yh * yh)) / DEG;

            // The main perturbations (degrees; distance in Earth radii)
            double lm = Rev(m + w + n), dd = Rev(lm - ls), f = Rev(lm - n);
            lon += -1.274 * Sin(m - 2 * dd) + 0.658 * Sin(2 * dd) - 0.186 * Sin(ms) - 0.059 * Sin(2 * m - 2 * dd) - 0.057 * Sin(m - 2 * dd + ms)
                + 0.053 * Sin(m + 2 * dd) + 0.046 * Sin(2 * dd - ms) + 0.041 * Sin(m - ms) - 0.035 * Sin(dd) - 0.031 * Sin(m + ms)
                - 0.015 * Sin(2 * f - 2 * dd) + 0.011 * Sin(m - 4 * dd);
            lat += -0.173 * Sin(f - 2 * dd) - 0.055 * Sin(m - f - 2 * dd) - 0.046 * Sin(m + f - 2 * dd) + 0.033 * Sin(f + 2 * dd) + 0.017 * Sin(2 * m + f);
            r += -0.58 * Math.Cos((m - 2 * dd) * DEG) - 0.46 * Math.Cos(2 * dd * DEG);

            // Phase: the elongation from the sun
            double cosElongation = Math.Cos(lat * DEG) * Math.Cos((lon - sunLongitude) * DEG);
            illuminated = Math.Clamp((1.0 - cosElongation) * 0.5, 0.0, 1.0);
            waxing = Rev(lon - sunLongitude) < 180.0;

            // Ecliptic → equatorial
            double obliquity = (23.4393 - 3.563e-7 * d) * DEG;
            double xe = Math.Cos(lat * DEG) * Math.Cos(lon * DEG);
            double ye = Math.Cos(lat * DEG) * Math.Sin(lon * DEG) * Math.Cos(obliquity) - Math.Sin(lat * DEG) * Math.Sin(obliquity);
            double ze = Math.Cos(lat * DEG) * Math.Sin(lon * DEG) * Math.Sin(obliquity) + Math.Sin(lat * DEG) * Math.Cos(obliquity);
            double ra = Math.Atan2(ye, xe);
            double dec = Math.Atan2(ze, Math.Sqrt(xe * xe + ye * ye));

            // Horizontal, then the parallax (the moon is close: up to a degree lower)
            double lst = SiderealFromDay(ls, ut, location.Longitude);
            Horizontal(location.Latitude * DEG, lst - ra, dec, out altitude, out azimuth);
            altitude -= Math.Asin(Math.Clamp(1.0 / Math.Max(r, 50.0), -1.0, 1.0)) * Math.Cos(altitude);
        }

        /// <summary>
        /// The local sidereal time (radians, 0–2π): how far the sky has turned (the stars' right ascension on the
        /// meridian).
        /// </summary>
        public static double LocalSiderealTime(GeoLocation location, int year, int month, int day, double minutes, bool daylightSaving)
        {
            double d = DayNumber(location, year, month, day, minutes, daylightSaving, out double ut);
            double ms = Rev(356.0470 + 0.9856002585 * d);
            double ls = Rev(ms + 282.9404 + 4.70935e-5 * d);
            return SiderealFromDay(ls, ut, location.Longitude);
        }

        /// <summary>
        /// The rotation from equatorial axes (X towards the vernal equinox, Z the celestial north pole) into true-north
        /// axes (X east, Y north, Z up) for a sidereal time and latitude. Row-vector convention
        /// (<see cref="Vector3.Transform(Vector3, Matrix4x4)"/>); its transpose turns a sky direction into equatorial axes.
        /// </summary>
        /// <param name="localSiderealTime">Radians (<see cref="LocalSiderealTime"/>).</param>
        /// <param name="latitude">Degrees, north positive.</param>
        public static Matrix4x4 EquatorialToTrueNorth(double localSiderealTime, double latitude)
        {
            Vector3 x = EquatorialToLocal(new Vector3(1f, 0f, 0f), localSiderealTime, latitude * DEG);
            Vector3 y = EquatorialToLocal(new Vector3(0f, 1f, 0f), localSiderealTime, latitude * DEG);
            Vector3 z = EquatorialToLocal(new Vector3(0f, 0f, 1f), localSiderealTime, latitude * DEG);
            return new Matrix4x4(x.X, x.Y, x.Z, 0f, y.X, y.Y, y.Z, 0f, z.X, z.Y, z.Z, 0f, 0f, 0f, 0f, 1f);
        }

        /// <summary>An equatorial unit vector in true-north axes (east, north, up).</summary>
        private static Vector3 EquatorialToLocal(Vector3 equatorial, double lst, double lat)
        {
            double ra = Math.Atan2(equatorial.Y, equatorial.X);
            double dec = Math.Asin(Math.Clamp(equatorial.Z, -1f, 1f));
            double ha = lst - ra;
            double east = -Math.Cos(dec) * Math.Sin(ha);
            double north = Math.Cos(lat) * Math.Sin(dec) - Math.Sin(lat) * Math.Cos(dec) * Math.Cos(ha);
            double up = Math.Sin(lat) * Math.Sin(dec) + Math.Cos(lat) * Math.Cos(dec) * Math.Cos(ha);
            return new Vector3((float)east, (float)north, (float)up);
        }

        /// <summary>Altitude and azimuth (clockwise from north) from latitude, hour angle and declination (radians).</summary>
        private static void Horizontal(double lat, double hourAngle, double dec, out double altitude, out double azimuth)
        {
            double east = -Math.Cos(dec) * Math.Sin(hourAngle);
            double north = Math.Cos(lat) * Math.Sin(dec) - Math.Sin(lat) * Math.Cos(dec) * Math.Cos(hourAngle);
            double up = Math.Sin(lat) * Math.Sin(dec) + Math.Cos(lat) * Math.Cos(dec) * Math.Cos(hourAngle);
            altitude = Math.Asin(Math.Clamp(up, -1.0, 1.0));
            azimuth = Math.Atan2(east, north);
            if (azimuth < 0.0) { azimuth += 2.0 * Math.PI; }
        }

        /// <summary>
        /// Schlyter's day number (days from 2000 Jan 0.0 UT) for a local clock time; <paramref name="ut"/> receives the
        /// universal time in hours (may be outside 0–24: the day number carries the date).
        /// </summary>
        private static double DayNumber(GeoLocation location, int year, int month, int day, double minutes, bool daylightSaving, out double ut)
        {
            year = Math.Clamp(year, 1, 9999);
            month = Math.Clamp(month, 1, 12);
            day = Math.Clamp(day, 1, DateTime.DaysInMonth(year, month));
            minutes = Math.Clamp(minutes, 0.0, 1440.0);
            bool dst = SolarPosition.IsDaylightSaving(location, year, month, day, daylightSaving);
            double zone = location.TimeZone + (dst ? 1.0 : 0.0);
            ut = minutes / 60.0 - zone;
            double days = (new DateTime(year, month, day) - new DateTime(1999, 12, 31)).TotalDays;
            return days + ut / 24.0;
        }

        /// <summary>Local sidereal time (radians) from the sun's mean longitude at the moment (degrees), UT hours and east longitude.</summary>
        private static double SiderealFromDay(double sunMeanLongitude, double ut, double longitude)
        {
            double gmst0 = sunMeanLongitude + 180.0; // degrees at 0h UT
            return Rev(gmst0 + ut * 15.0 + longitude) * DEG;
        }

        private static double Sin(double degrees) => Math.Sin(degrees * DEG);

        /// <summary>An angle in degrees into 0–360.</summary>
        private static double Rev(double degrees)
        {
            double r = degrees % 360.0;
            return r < 0.0 ? r + 360.0 : r;
        }
    }
}
