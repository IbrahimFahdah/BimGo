using System;
using System.Collections.Generic;
using System.Numerics;
using System.Text.Json;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Round W-B: the cover map (what keeps the rain and snow off, seen from above) and the weather settings.
    /// </summary>
    [TestClass]
    public sealed class WeatherTests
    {
        /// <summary>Six corners: an axis-aligned rectangle at height z.</summary>
        private static IEnumerable<Vector3> Rect(float x0, float y0, float x1, float y1, float z) => new[]
        {
            new Vector3(x0, y0, z), new Vector3(x1, y0, z), new Vector3(x1, y1, z),
            new Vector3(x0, y0, z), new Vector3(x1, y1, z), new Vector3(x0, y1, z)
        };

        /// <summary>Six corners: a vertical wall face along X at y, from z0 to z1.</summary>
        private static IEnumerable<Vector3> Wall(float x0, float x1, float y, float z0, float z1) => new[]
        {
            new Vector3(x0, y, z0), new Vector3(x1, y, z0), new Vector3(x1, y, z1),
            new Vector3(x0, y, z0), new Vector3(x1, y, z1), new Vector3(x0, y, z1)
        };

        [TestMethod]
        public void Cover_HighestSurfaceWins_OpenOutside()
        {
            var corners = new List<Vector3>();
            corners.AddRange(Rect(0, 0, 40, 40, 0f));    // the site
            corners.AddRange(Rect(10, 10, 20, 20, 3f));  // a floor
            corners.AddRange(Rect(9, 9, 21, 21, 6.5f));  // the roof over it, a little overhang
            CoverMap map = CoverMap.FromTriangles(corners);
            Assert.IsFalse(map.IsEmpty);
            Assert.AreEqual(CoverMap.CELL, map.Cell, 1e-6f);
            Assert.AreEqual(6.5f, map.TopAt(15f, 15f), 1e-4f);
            Assert.AreEqual(0f, map.TopAt(30f, 30f), 1e-4f);
            Assert.AreEqual(CoverMap.NONE, map.TopAt(100f, 100f), "off the map");

            Assert.IsTrue(map.IsCovered(new Vector3(15f, 15f, 3f + 1.7f)), "standing on the floor, under the roof");
            Assert.IsFalse(map.IsCovered(new Vector3(30f, 30f, 1.7f)), "out on the site");
            Assert.IsFalse(map.IsCovered(new Vector3(15f, 15f, 6.5f + 1.7f)), "up on the roof");
        }

        [TestMethod]
        public void Cover_ThinWallsAndSlopes()
        {
            var corners = new List<Vector3>();
            corners.AddRange(Wall(0, 20, 5.1f, 0f, 2.4f));                                                   // a wall, no top face
            corners.AddRange(new[] { new Vector3(30, 0, 3), new Vector3(40, 0, 3), new Vector3(30, 10, 8) }); // a sloped roof
            CoverMap map = CoverMap.FromTriangles(corners);
            Assert.AreEqual(2.4f, map.TopAt(10f, 5.1f), 1e-3f, "the wall's top edge marks its cells");
            Assert.AreEqual(2.4f, map.TopAt(1.3f, 5.1f), 1e-3f);
            Assert.AreEqual(CoverMap.NONE, map.TopAt(10f, 7f), "beside the wall");
            float z = map.TopAt(32f, 4f);
            Assert.AreEqual(5f, z, 0.4f, "the slope's height at the cell");
        }

        [TestMethod]
        public void Cover_BigModelsGetBiggerCells()
        {
            CoverMap map = CoverMap.FromTriangles(new List<Vector3>(Rect(0, 0, 2000, 300, 0f)));
            Assert.IsTrue(map.Width <= CoverMap.MAX_SIDE && map.Height <= CoverMap.MAX_SIDE);
            Assert.IsTrue(map.Cell > 1.9f, $"cell {map.Cell}");
            Assert.AreEqual(0f, map.TopAt(1000f, 150f), 1e-4f);
            Assert.IsTrue(CoverMap.FromTriangles(Array.Empty<Vector3>()).IsEmpty);
        }

        [TestMethod]
        public void WeatherSettings_DefaultCleanCopyAndOlderFiles()
        {
            var sun = new SunSettings();
            Assert.AreEqual(SunSettings.WEATHER_OFF, sun.Weather);
            Assert.IsFalse(sun.Raining || sun.Snowing);

            var bad = new SunSettings { Weather = " Snow ", WeatherIntensity = 0f, Wetness = 7f, SnowCover = float.NaN }.Clean();
            Assert.IsTrue(bad.Snowing);
            Assert.AreEqual(0.05f, bad.WeatherIntensity);
            Assert.AreEqual(1f, bad.Wetness);
            Assert.AreEqual(0.6f, bad.SnowCover);
            Assert.AreEqual(SunSettings.WEATHER_OFF, new SunSettings { Weather = "hail" }.Clean().Weather, "unknown kinds read as off");
            Assert.AreEqual(SunSettings.WEATHER_OFF, new SunSettings { Weather = null }.Clean().Weather);

            SunSettings copy = new SunSettings { Weather = SunSettings.WEATHER_RAIN, WeatherIntensity = 0.8f, Wetness = 0.4f, SnowCover = 0.2f }.Copy();
            Assert.IsTrue(copy.Raining);
            Assert.AreEqual(0.8f, copy.WeatherIntensity);
            Assert.AreEqual(0.4f, copy.Wetness);
            Assert.AreEqual(0.2f, copy.SnowCover);

            SunSettings old = JsonSerializer.Deserialize<SunSettings>("{\"Enabled\":true,\"CloudCover\":0.5}").Clean();
            Assert.AreEqual(SunSettings.WEATHER_OFF, old.Weather, "files from before W-B stay dry");
            string json = JsonSerializer.Serialize(new SunSettings { Weather = SunSettings.WEATHER_SNOW });
            Assert.IsFalse(json.Contains("Raining", StringComparison.Ordinal) || json.Contains("Snowing", StringComparison.Ordinal));
            Assert.IsTrue(JsonSerializer.Deserialize<SunSettings>(json).Clean().Snowing);
        }
    }
}
