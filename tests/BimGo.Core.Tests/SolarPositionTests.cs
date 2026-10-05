using System;
using System.Numerics;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Sun position against reference values. The expected numbers come from an independent algorithm (the
    /// Astronomical Almanac low-precision solar position, computed outside BimGo), not from BimGo's own NOAA series,
    /// so the tolerances allow for the small difference between the two (largest near the equinox).
    /// The cases are the v6 checks: Sydney summer solstice noon, London summer solstice noon, Adelaide afternoon.
    /// </summary>
    [TestClass]
    public sealed class SolarPositionTests
    {
        private const double DEG = Math.PI / 180.0;

        private static readonly GeoLocation SYDNEY = new(-33.8688, 151.2093, 10.0, "Sydney");
        private static readonly GeoLocation LONDON = new(51.5074, -0.1278, 0.0, "London");
        private static readonly GeoLocation ADELAIDE = new(-34.9285, 138.6007, 9.5, "Adelaide");

        private static void AssertSun(GeoLocation where, int month, int day, int minutes, bool dst,
            double expectedAltitudeDeg, double expectedAzimuthDeg, double altitudeTolerance, double azimuthTolerance)
        {
            SolarPosition.Compute(where, 2026, month, day, minutes, dst, out double altitude, out double azimuth);
            Assert.AreEqual(expectedAltitudeDeg, altitude / DEG, altitudeTolerance, $"{where.Name} altitude");
            Assert.AreEqual(expectedAzimuthDeg, azimuth / DEG, azimuthTolerance, $"{where.Name} azimuth");
        }

        [TestMethod]
        public void Sydney_SummerSolsticeNoon() => AssertSun(SYDNEY, 12, 21, 12 * 60, false, 79.45, 351.2, 0.2, 0.5);

        [TestMethod]
        public void London_SummerSolsticeNoon() => AssertSun(LONDON, 6, 21, 12 * 60, false, 61.92, 178.9, 0.2, 0.6);

        [TestMethod]
        public void Adelaide_EquinoxAfternoon() => AssertSun(ADELAIDE, 3, 20, 15 * 60, false, 39.55, 304.9, 0.4, 0.5);

        [TestMethod]
        public void Adelaide_SummerAfternoonWithDaylightSaving() => AssertSun(ADELAIDE, 1, 15, 15 * 60, true, 64.98, 297.2, 0.2, 0.6);

        [TestMethod]
        public void DaylightSaving_IsTheSameSunAnHourEarlier()
        {
            SolarPosition.Compute(ADELAIDE, 2026, 1, 15, 15 * 60, true, out double altDst, out double azDst);
            SolarPosition.Compute(ADELAIDE, 2026, 1, 15, 14 * 60, false, out double alt, out double az);
            Assert.AreEqual(alt, altDst, 1e-3);
            Assert.AreEqual(az, azDst, 1e-3);
        }

        [TestMethod]
        public void Midnight_SunIsBelowTheHorizon()
        {
            SolarPosition.Compute(SYDNEY, 2026, 6, 21, 0, false, out double altitude, out _);
            Assert.IsTrue(altitude < 0);
        }

        [TestMethod]
        public void OutOfRangeInputs_AreClampedNotThrown()
        {
            SolarPosition.Compute(SYDNEY, 2026, 2, 31, 5000, false, out double altitude, out double azimuth);
            Assert.IsTrue(double.IsFinite(altitude));
            Assert.IsTrue(double.IsFinite(azimuth));
        }

        [TestMethod]
        public void Direction_IsUnitLengthEastNorthUp()
        {
            Vector3 east = SolarPosition.Direction(0, 90 * DEG);
            Assert.AreEqual(1f, east.X, 1e-5f);
            Assert.AreEqual(0f, east.Y, 1e-5f);

            Vector3 north = SolarPosition.Direction(0, 0);
            Assert.AreEqual(1f, north.Y, 1e-5f);

            Vector3 high = SolarPosition.Direction(60 * DEG, 200 * DEG);
            Assert.AreEqual(1f, high.Length(), 1e-5f);
            Assert.AreEqual(MathF.Sin(60 * MathF.PI / 180f), high.Z, 1e-5f);
        }

        [TestMethod]
        public void ToModel_RotatesByMinusTheNorthAngle()
        {
            // An internal → shared angle of 90°: true north maps onto model +X
            Vector3 model = SolarPosition.ToModel(Vector3.UnitY, Math.PI / 2);
            Assert.AreEqual(1f, model.X, 1e-5f);
            Assert.AreEqual(0f, model.Y, 1e-5f);
        }

        [TestMethod]
        public void LocationOf_UsesTheSiteWhenKnown()
        {
            var site = new SiteInfo { HasLocation = true, Latitude = -34.9285, Longitude = 138.6007, TimeZone = 9.5, PlaceName = " Adelaide " };
            GeoLocation location = SolarPosition.LocationOf(site, out bool known);
            Assert.IsTrue(known);
            Assert.AreEqual("Adelaide", location.Name);
            Assert.AreEqual(9.5, location.TimeZone);
        }

        [TestMethod]
        public void LocationOf_FallsBackForMissingOrInvalidSites()
        {
            Assert.AreEqual(GeoLocation.Fallback, SolarPosition.LocationOf(null, out bool known));
            Assert.IsFalse(known);

            var invalid = new SiteInfo { HasLocation = true, Latitude = 120, Longitude = 0 };
            Assert.AreEqual(GeoLocation.Fallback, SolarPosition.LocationOf(invalid, out known));
            Assert.IsFalse(known);
        }

        [TestMethod]
        public void SunTime_StartFor_ReadsTheSiteStart()
        {
            SunTime start = SunTime.StartFor(new SiteInfo { SunStart = "2026-03-20T15:30" });
            Assert.AreEqual(3, start.Month);
            Assert.AreEqual(20, start.Day);
            Assert.AreEqual(15 * 60 + 30, start.Minutes);
        }

        [TestMethod]
        public void SunSettings_Clean_ClampsBadValues()
        {
            var sun = new SunSettings
            {
                Time = new SunTime { Month = 14, Day = 40, Minutes = -5 },
                SunIntensity = 9f, SkyIntensity = float.NaN, ShadowIntensity = -1f, GlassTransmission = 5f
            }.Clean();

            Assert.AreEqual(12, sun.Time.Month);
            Assert.AreEqual(31, sun.Time.Day);
            Assert.AreEqual(0, sun.Time.Minutes);
            Assert.AreEqual(SunSettings.MAX_INTENSITY, sun.SunIntensity);
            Assert.AreEqual(1f, sun.SkyIntensity);
            Assert.AreEqual(0f, sun.ShadowIntensity);
            Assert.AreEqual(2f, sun.GlassTransmission);
        }
    }
}
