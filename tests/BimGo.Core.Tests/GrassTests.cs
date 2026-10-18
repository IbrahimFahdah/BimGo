using System.Numerics;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Grass round (build B): the grass field (where blades grow, seen from above): heights, the highest surface,
    /// covers just above the grass, surfaces well above, colours.
    /// </summary>
    [TestClass]
    public sealed class GrassTests
    {
        /// <summary>Two triangles: an axis-aligned rectangle at height z.</summary>
        private static GrassField.Triangle[] Rect(float x0, float y0, float x1, float y1, float z, byte palette) => new[]
        {
            new GrassField.Triangle(new Vector3(x0, y0, z), new Vector3(x1, y0, z), new Vector3(x1, y1, z), palette),
            new GrassField.Triangle(new Vector3(x0, y0, z), new Vector3(x1, y1, z), new Vector3(x0, y1, z), palette)
        };

        private static readonly Vector3[] COLOURS = { new(0.2f, 0.4f, 0.1f), new(0.3f, 0.5f, 0.2f) };

        [TestMethod]
        public void Lawn_HeightsAndBounds()
        {
            GrassField field = GrassField.Rasterise(Rect(0, 0, 10, 10, 0.5f, 1), null, COLOURS);
            Assert.IsFalse(field.IsEmpty);
            Assert.AreEqual(0.1f, field.Cell, 1e-6f);
            Assert.IsTrue(field.Width is 102 or 103, $"width {field.Width}"); // 10 m / 0.1 m (+ a cell each side; float rounding)
            Assert.IsTrue(field.TryGet(5f, 5f, out float z, out int palette));
            Assert.AreEqual(0.5f, z, 1e-5f);
            Assert.AreEqual(0, palette);
            Assert.IsFalse(field.TryGet(10.5f, 5f, out _, out _), "outside the lawn");
            Assert.AreEqual(10000, field.GrassCells, 200); // 100 × 100 cells, edges shared
        }

        [TestMethod]
        public void HighestGrassWins_SlopeInterpolates()
        {
            var grass = new System.Collections.Generic.List<GrassField.Triangle>(Rect(0, 0, 10, 10, 0f, 1));
            grass.AddRange(Rect(6, 6, 9, 9, 1f, 2));
            grass.Add(new GrassField.Triangle(new Vector3(20, 0, 0), new Vector3(30, 0, 1), new Vector3(20, 10, 0), 1)); // rises 1 m over 10 m in X
            GrassField field = GrassField.Rasterise(grass, null, COLOURS);
            Assert.IsTrue(field.TryGet(7.5f, 7.5f, out float z, out int palette));
            Assert.AreEqual(1f, z, 1e-5f);
            Assert.AreEqual(1, palette);
            Assert.IsTrue(field.TryGet(22.05f, 2.05f, out z, out _));
            Assert.AreEqual(0.205f, z, 0.02f);
        }

        [TestMethod]
        public void Covers_JustAboveRemoveGrass_WellAboveDont()
        {
            var covers = new System.Collections.Generic.List<GrassField.Triangle>(Rect(4, 4, 6, 6, 0.15f, 0)); // a slab on the lawn
            covers.AddRange(Rect(0, 0, 3, 3, 3.0f, 0));                                                        // a roof 3 m up
            covers.AddRange(Rect(7, 6, 9, 9, 0.6f, 0));                                                        // a deck 600 mm up
            covers.AddRange(Rect(7, 0, 9, 2, -0.5f, 0));                                                       // a basement floor below
            GrassField field = GrassField.Rasterise(Rect(0, 0, 10, 10, 0f, 1), covers, COLOURS);
            Assert.IsFalse(field.TryGet(5f, 5f, out _, out _), "under the slab");
            Assert.IsTrue(field.TryGet(2f, 2f, out _, out _), "under the roof");
            Assert.IsTrue(field.TryGet(8f, 7.5f, out _, out _), "under a deck more than 300 mm up");
            Assert.IsTrue(field.TryGet(8f, 1f, out _, out _), "above the basement");
            Assert.IsTrue(field.TryGet(3.5f, 5f, out _, out _), "beside the slab");
        }

        [TestMethod]
        public void Empty_AndColours()
        {
            Assert.IsTrue(GrassField.Rasterise(System.Array.Empty<GrassField.Triangle>(), null, COLOURS).IsEmpty);
            Assert.AreEqual(GrassField.DEFAULT_GREEN, GrassField.GrassColour(new Vector3(0.5f, 0.5f, 0.5f)), "grey reads as the default green");
            Vector3 green = GrassField.GrassColour(new Vector3(0.2f, 0.6f, 0.2f));
            Assert.AreEqual(0.2f * 0.7f + GrassField.DEFAULT_GREEN.X * 0.3f, green.X, 1e-5f);
            Assert.AreEqual(0.6f * 0.7f + GrassField.DEFAULT_GREEN.Y * 0.3f, green.Y, 1e-5f);
        }

        [TestMethod]
        public void Settings_GrassAndWaterCleaned()
        {
            var settings = new LaunchSettings();
            Assert.IsTrue(settings.GrassBlades);
            Assert.AreEqual(1, settings.GrassDensity);
            Assert.AreEqual(string.Empty, settings.WaterColour);
            Assert.AreEqual(1f, settings.WaterReflection);

            settings.GrassDensity = 7;
            settings.GrassHeightMm = 5;
            settings.GrassDistance = 500;
            settings.WaterColour = " 3b9aa6 ";
            settings.WaterReflection = -2f;
            settings.Sanitise();
            Assert.AreEqual(2, settings.GrassDensity);
            Assert.AreEqual(LaunchSettings.MIN_GRASS_HEIGHT, settings.GrassHeightMm);
            Assert.AreEqual(LaunchSettings.MAX_GRASS_DISTANCE, settings.GrassDistance);
            Assert.AreEqual("#3B9AA6", settings.WaterColour);
            Assert.AreEqual(0f, settings.WaterReflection);
            Assert.AreEqual(1, MaterialOverrides.WaterPresetIndex(settings.WaterColour), "the Pool preset");

            settings.WaterColour = "blue";
            settings.Sanitise();
            Assert.AreEqual(string.Empty, settings.WaterColour);
            Assert.AreEqual(0, MaterialOverrides.WaterPresetIndex(settings.WaterColour), "empty = Revit's colour");
            Assert.AreEqual(-1, MaterialOverrides.WaterPresetIndex("#123456"));
        }

        [TestMethod]
        public void Build_FromSceneByKeyword()
        {
            // One upward quad with material 0 ("Lawn grass"), one wall with material 0 too (not upward: left out)
            var vertices = new[]
            {
                new SceneVertex(new Vector3(0, 0, 0), Vector3.UnitZ, 0xFFFFFFFF), new SceneVertex(new Vector3(4, 0, 0), Vector3.UnitZ, 0xFFFFFFFF),
                new SceneVertex(new Vector3(4, 4, 0), Vector3.UnitZ, 0xFFFFFFFF), new SceneVertex(new Vector3(0, 4, 0), Vector3.UnitZ, 0xFFFFFFFF),
                new SceneVertex(new Vector3(10, 0, 0), Vector3.UnitY, 0xFFFFFFFF), new SceneVertex(new Vector3(14, 0, 0), Vector3.UnitY, 0xFFFFFFFF),
                new SceneVertex(new Vector3(14, 0, 3), Vector3.UnitY, 0xFFFFFFFF)
            };
            var scene = new SceneData
            {
                Vertices = vertices,
                Indices = new uint[] { 0, 1, 2, 0, 2, 3, 4, 5, 6 },
                Elements = new[] { new ElementRecord { ElementId = 1, OpaqueStart = 0, OpaqueCount = 9 } },
                Materials = new MaterialData
                {
                    Materials = new[] { new SceneMaterial { Name = "Lawn grass", Colour = new Vector3(0.5f) } },
                    VertexMaterial = new ushort[7]
                }
            };
            GrassField field = GrassField.Build(scene, new[] { "grass" });
            Assert.AreEqual(2, field.GrassTriangles);
            Assert.IsTrue(field.TryGet(2f, 2f, out _, out _));
            Assert.AreEqual(GrassField.DEFAULT_GREEN, field.Colours[0]);
            Assert.IsTrue(GrassField.Build(scene, new[] { "turf" }).IsEmpty);
        }
    }
}
