using System;
using System.Numerics;
using System.Text.Json;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Round W-A: the moon's place and phase, the turning sky, and the night settings. The maths was also checked in a
    /// Python port (the 2024 eclipse over Dallas, the April 2024 quarters, sidereal time at J2000).
    /// </summary>
    [TestClass]
    public sealed class NightSkyTests
    {
        private static readonly GeoLocation Utc = new(0.0, 0.0, 0.0, "Greenwich");

        private static float AngleDegrees(Vector3 a, Vector3 b) => MathF.Acos(Math.Clamp(Vector3.Dot(Vector3.Normalize(a), Vector3.Normalize(b)), -1f, 1f)) * 180f / MathF.PI;

        [TestMethod]
        public void Moon_CoversTheSunInTheDallasEclipse()
        {
            // 8 April 2024, 13:40 CDT (UTC−6 + daylight saving): totality
            var dallas = new GeoLocation(32.78, -96.80, -6.0, "Dallas");
            LunarPosition.Compute(dallas, 2024, 4, 8, 13 * 60 + 40, true, out double moonAltitude, out double moonAzimuth, out double lit, out _);
            SolarPosition.Compute(dallas, 2024, 4, 8, 13 * 60 + 40, true, out double sunAltitude, out double sunAzimuth);
            Vector3 moon = SolarPosition.Direction(moonAltitude, moonAzimuth), sun = SolarPosition.Direction(sunAltitude, sunAzimuth);
            Assert.IsTrue(AngleDegrees(moon, sun) < 1f, $"{AngleDegrees(moon, sun)}° apart");
            Assert.IsTrue(lit < 0.01, "new moon");
        }

        [TestMethod]
        public void Phases_FullNewAndQuarters()
        {
            LunarPosition.Compute(Utc, 2024, 4, 23, 23 * 60 + 49, false, out _, out _, out double full, out _);
            LunarPosition.Compute(Utc, 2024, 4, 15, 19 * 60 + 13, false, out _, out _, out double first, out bool waxing);
            LunarPosition.Compute(Utc, 2024, 5, 1, 11 * 60 + 27, false, out _, out _, out double last, out bool waxingLast);
            Assert.IsTrue(full > 0.98, $"full {full}");
            Assert.AreEqual(0.5, first, 0.05);
            Assert.IsTrue(waxing);
            Assert.AreEqual(0.5, last, 0.05);
            Assert.IsFalse(waxingLast);
        }

        [TestMethod]
        public void Sky_TurnsRoundThePoleAtTheLatitude()
        {
            // The celestial pole stands at the latitude above due north (south of the equator: below it)
            foreach (double latitude in new[] { -33.87, 0.0, 51.5 })
            {
                Matrix4x4 m = LunarPosition.EquatorialToTrueNorth(1.234, latitude);
                Vector3 pole = Vector3.Transform(Vector3.UnitZ, m);
                Assert.AreEqual(Math.Sin(latitude * Math.PI / 180.0), pole.Z, 1e-4, $"latitude {latitude}");
                Assert.AreEqual(0f, pole.X, 1e-4f, "due north");
                Assert.AreEqual(1f, Vector3.Transform(Vector3.UnitX, m).Length(), 1e-4f, "a rotation");
            }

            // Sidereal time at J2000.0 (1 Jan 2000, 12:00 UT) is 280.46°; it gains about 361° a day
            double lst = LunarPosition.LocalSiderealTime(Utc, 2000, 1, 1, 720, false) * 180.0 / Math.PI;
            Assert.AreEqual(280.46, lst, 0.1);
            double next = LunarPosition.LocalSiderealTime(Utc, 2000, 1, 2, 720, false) * 180.0 / Math.PI;
            Assert.AreEqual(0.9856, (next - lst + 360.0) % 360.0, 0.01);
        }

        [TestMethod]
        public void NightSettings_DefaultCleanCopyAndOlderFiles()
        {
            var night = new SunSettings();
            Assert.IsTrue(night.Moon && night.Stars);
            Assert.IsNull(night.MoonPhase, "the real phase");
            var bad = new SunSettings { MoonLight = 9f, StarDensity = -1f, StarTwinkle = float.NaN, MoonPhase = 0f }.Clean();
            Assert.AreEqual(2f, bad.MoonLight);
            Assert.AreEqual(0f, bad.StarDensity);
            Assert.AreEqual(1f, bad.StarTwinkle);
            Assert.AreEqual(0.05f, bad.MoonPhase);
            SunSettings copy = new SunSettings { Moon = false, MoonPhase = 0.5f, MilkyWay = 0.3f }.Copy();
            Assert.IsFalse(copy.Moon);
            Assert.AreEqual(0.5f, copy.MoonPhase);
            Assert.AreEqual(0.3f, copy.MilkyWay);

            SunSettings old = JsonSerializer.Deserialize<SunSettings>("{\"Enabled\":true,\"CloudCover\":0.5}");
            Assert.IsTrue(old.Moon && old.Stars, "files from before W-A get the night sky");
            Assert.IsFalse(JsonSerializer.Serialize(new SunSettings()).Contains("MoonPhase", StringComparison.Ordinal));
        }
    }
}
