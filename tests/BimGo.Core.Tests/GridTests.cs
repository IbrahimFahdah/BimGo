using System;
using System.Collections.Generic;
using System.IO.Compression;
using System.Linq;
using System.Numerics;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Grids round A: grids in a .bimgo (grids.json), storeys on levels, which grids show on which level, the level
    /// modes and the C cycle, multi-segment chaining, and the per-model grid view settings in visibility.json.
    /// </summary>
    [TestClass]
    public sealed class GridTests
    {
        private static GridLine[] SampleGrids() => new[]
        {
            new GridLine { Name = "A", Points = new[] { new Vector2(0, 0), new Vector2(0, 30) }, Bottom = -0.5f, Top = 7.5f },
            new GridLine { Name = "1", Points = new[] { new Vector2(-2, 5), new Vector2(40, 5) } }, // no extent: every level
            new GridLine { Name = "S1", Link = 1, Points = new[] { new Vector2(10, 0), new Vector2(12, 4), new Vector2(15, 6) }, Curved = true, Bottom = 0f, Top = 3.5f }
        };

        [TestMethod]
        public void Grids_RoundTripThroughBimgo()
        {
            using var folder = new TempFolder();
            string path = folder.File("grids.bimgo");
            BimGoDocument document = TestData.BuildDocument(grids: SampleGrids());
            Assert.IsTrue(BimGoWriter.Write(path, document, TestData.Writer, FileKinds.SAVE, out string error), error);

            BimGoDocument read = BimGoReader.Read(path, new LaunchSettings(), out error);
            Assert.IsNotNull(read, error);
            GridLine[] grids = read.Scene.Grids;
            Assert.AreEqual(3, grids.Length);
            Assert.AreEqual("A", grids[0].Name);
            Assert.AreEqual(0, grids[0].Link);
            Assert.IsTrue(grids[0].HasExtent);
            Assert.AreEqual(7.5f, grids[0].Top, 1e-5f);
            Assert.IsFalse(grids[1].HasExtent, "an unknown extent stays open");
            Assert.AreEqual(1, grids[2].Link);
            Assert.IsTrue(grids[2].Curved);
            Assert.AreEqual(3, grids[2].Points.Length);
            Assert.AreEqual(new Vector2(15, 6), grids[2].End);
        }

        [TestMethod]
        public void Grids_AbsentEntryAndDamagedGridsReadSafely()
        {
            using var folder = new TempFolder();
            string path = folder.File("plain.bimgo");
            Assert.IsTrue(BimGoWriter.Write(path, TestData.BuildDocument(), TestData.Writer, FileKinds.SAVE, out string error), error);
            using (ZipArchive zip = ZipFile.OpenRead(path)) { Assert.IsNull(zip.GetEntry("grids.json"), "no grids: no entry"); }
            Assert.AreEqual(0, BimGoReader.Read(path, new LaunchSettings(), out error).Scene.Grids.Length);

            var dto = new GridsDto
            {
                Grids = new List<GridDto>
                {
                    null,
                    new() { Name = "short", Points = new[] { 1f, 2f } },
                    new() { Name = "nan", Points = new[] { 0f, 0f, float.NaN, 1f } },
                    new() { Name = " B ", Link = 9, Points = new[] { 0f, 0f, 0f, 0f, 5f, 0f }, Bottom = 3f, Top = 1f }
                }
            };
            GridLine[] grids = GridFiles.FromDto(dto, linkCount: 1);
            Assert.AreEqual(1, grids.Length);
            Assert.AreEqual("B", grids[0].Name);
            Assert.AreEqual(0, grids[0].Link, "an unknown link reads as the host");
            Assert.AreEqual(2, grids[0].Points.Length, "the repeated point is dropped");
            Assert.IsFalse(grids[0].HasExtent, "top below bottom: unknown");
        }

        [TestMethod]
        public void Levels_StoreyFlagRoundTripsAndOldFilesAreStoreys()
        {
            using var folder = new TempFolder();
            string path = folder.File("levels.bimgo");
            BimGoDocument document = TestData.BuildDocument();
            var scene = document.Scene;
            var levels = new[] { new LevelInfo("Level 1", 0f), new LevelInfo("T.O. Parapet", 4f, IsStorey: false) };
            var withLevels = new BimGoDocument { Scene = CopyWithLevels(scene, levels), Comments = document.Comments };
            Assert.IsTrue(BimGoWriter.Write(path, withLevels, TestData.Writer, FileKinds.SAVE, out string error), error);

            LevelInfo[] read = BimGoReader.Read(path, new LaunchSettings(), out error).Scene.Levels;
            Assert.IsTrue(read[0].IsStorey);
            Assert.IsFalse(read[1].IsStorey);
            Assert.IsTrue(new LevelDto().Storey != false, "absent = a storey");
        }

        private static SceneData CopyWithLevels(SceneData s, LevelInfo[] levels) => new()
        {
            Vertices = s.Vertices, Indices = s.Indices, Elements = s.Elements, Levels = levels, Rooms = s.Rooms, Links = s.Links,
            Bounds = s.Bounds, OriginOffset = s.OriginOffset, ModelTitle = s.ModelTitle, Provenance = s.Provenance, Site = s.Site,
            Parameters = s.Parameters, CategoryLoaded = s.CategoryLoaded, CategoryElementCounts = s.CategoryElementCounts, Settings = s.Settings
        };

        [TestMethod]
        public void ShowsAt_RespectsExtentsWithTolerance()
        {
            GridLine[] grids = SampleGrids();
            Assert.IsTrue(GridLayout.ShowsAt(grids[0], 0f, true));
            Assert.IsTrue(GridLayout.ShowsAt(grids[0], 7.54f, true), "within 50 mm of the top");
            Assert.IsFalse(GridLayout.ShowsAt(grids[0], 10.5f, true));
            Assert.IsTrue(GridLayout.ShowsAt(grids[0], 10.5f, false), "extents ignored");
            Assert.IsTrue(GridLayout.ShowsAt(grids[1], 100f, true), "no extent: every level");
            Assert.IsFalse(GridLayout.ShowsAt(new GridLine { Name = "x", Points = new[] { Vector2.Zero } }, 0f, false), "one point: not drawn");
        }

        [TestMethod]
        public void ShownLevels_ModesAndStoreys()
        {
            // Sorted by elevation, as SceneData.Levels are: L1 0, L2 3.5, Roof 7 (storey), Parapet 7.6 (not)
            var levels = new[] { new LevelInfo("L1", 0f), new LevelInfo("L2", 3.5f), new LevelInfo("Roof", 7f), new LevelInfo("Parapet", 7.6f, false) };
            var into = new List<int>();
            GridLayout.ShownLevels(levels, GridLevelMode.Off, 1, 5f, true, into);
            Assert.AreEqual(0, into.Count);
            GridLayout.ShownLevels(levels, GridLevelMode.Underfoot, 3, 5f, true, into);
            CollectionAssert.AreEqual(new[] { 3 }, into, "underfoot shows even a non-storey");
            GridLayout.ShownLevels(levels, GridLevelMode.All, 0, 5f, true, into);
            CollectionAssert.AreEqual(new[] { 0, 1, 2 }, into);
            GridLayout.ShownLevels(levels, GridLevelMode.All, 0, 5f, false, into);
            CollectionAssert.AreEqual(new[] { 0, 1, 2, 3 }, into);
            GridLayout.ShownLevels(new[] { new LevelInfo("Ref", 0f, false) }, GridLevelMode.All, 0, 0f, true, into);
            CollectionAssert.AreEqual(new[] { 0 }, into, "no storeys at all: every level");

            GridLayout.ShownLevels(levels, GridLevelMode.Above, 1, 5f, true, into);
            CollectionAssert.AreEqual(new[] { 2 }, into, "the parapet isn't a storey: above L2 is the roof");
            GridLayout.ShownLevels(levels, GridLevelMode.Above, 2, 8f, true, into);
            Assert.AreEqual(0, into.Count, "nothing above the top storey");
            GridLayout.ShownLevels(levels, GridLevelMode.Above, 2, 8f, false, into);
            CollectionAssert.AreEqual(new[] { 3 }, into, "storeys only off: the parapet");
            GridLayout.ShownLevels(levels, GridLevelMode.Below, 0, 1f, true, into);
            Assert.AreEqual(0, into.Count, "nothing below the bottom");
            GridLayout.ShownLevels(levels, GridLevelMode.Below, 2, 8f, true, into);
            CollectionAssert.AreEqual(new[] { 1 }, into);
            GridLayout.ShownLevels(levels, GridLevelMode.Adjacent, 1, 5f, true, into);
            CollectionAssert.AreEqual(new[] { 0, 1, 2 }, into);
            GridLayout.ShownLevels(levels, GridLevelMode.Nearest, 0, 6.2f, true, into);
            CollectionAssert.AreEqual(new[] { 2 }, into, "6.2 m is nearest the roof (7 m)");

            Assert.AreEqual(GridLevelMode.Underfoot, GridLayout.Next(GridLevelMode.Off));
            Assert.AreEqual(GridLevelMode.All, GridLayout.Next(GridLevelMode.Underfoot));
            Assert.AreEqual(GridLevelMode.Off, GridLayout.Next(GridLevelMode.All));
            Assert.AreEqual(GridLevelMode.All, GridLayout.Next(GridLevelMode.Nearest), "a panel-picked mode cycles on to all");

            foreach (GridLevelMode mode in GridLayout.PANEL_ORDER)
            {
                var settings = new GridViewSettings { Mode = mode };
                Assert.AreEqual(mode, settings.Clean().Mode, "every mode survives its string");
            }
        }

        [TestMethod]
        public void PlanBounds_ShownGridsOnlyWithMargin()
        {
            GridLine[] grids = SampleGrids();
            Assert.IsTrue(GridLayout.PlanBounds(grids, 0f, true, links: false, out Vector2 min, out Vector2 max));
            Assert.AreEqual(new Vector2(-2 - GridLayout.OUTLINE_MARGIN, -GridLayout.OUTLINE_MARGIN), min);
            Assert.AreEqual(new Vector2(40 + GridLayout.OUTLINE_MARGIN, 30 + GridLayout.OUTLINE_MARGIN), max);

            Assert.IsTrue(GridLayout.PlanBounds(new[] { grids[2] }, 1f, true, links: true, out _, out _));
            Assert.IsFalse(GridLayout.PlanBounds(new[] { grids[2] }, 1f, true, links: false, out _, out _), "link grids off");
            Assert.IsFalse(GridLayout.PlanBounds(new[] { grids[2] }, 10f, true, links: true, out _, out _), "outside its extent");
        }

        [TestMethod]
        public void Chain_JoinsSegmentsInAnyOrderAndDirection()
        {
            // An L-shaped multi-segment grid given middle-first and with one segment reversed
            var segments = new List<Vector2[]>
            {
                new[] { new Vector2(10, 0), new Vector2(10, 10) },
                new[] { new Vector2(10, 0), new Vector2(0, 0) },        // reversed: runs back to the free end
                new[] { new Vector2(20, 10), new Vector2(10, 10) }      // reversed too
            };
            List<Vector2> line = GridLayout.Chain(segments);
            Assert.AreEqual(4, line.Count, "shared joints kept once");
            Assert.IsTrue(line[0] == new Vector2(0, 0) || line[0] == new Vector2(20, 10), "starts at a free end");
            Vector2[] expected = line[0] == new Vector2(0, 0)
                ? new[] { new Vector2(0, 0), new Vector2(10, 0), new Vector2(10, 10), new Vector2(20, 10) }
                : new[] { new Vector2(20, 10), new Vector2(10, 10), new Vector2(10, 0), new Vector2(0, 0) };
            CollectionAssert.AreEqual(expected, line);

            Assert.AreEqual(0, GridLayout.Chain(new List<Vector2[]>()).Count);
        }

        [TestMethod]
        public void GridViewSettings_CleanDefaultsAndVisibilityRoundTrip()
        {
            var d = new GridViewSettings();
            Assert.IsTrue(d.IsDefault);
            Assert.AreEqual(GridLevelMode.Off, d.Mode);
            Assert.AreEqual(0, d.DepthIndex);

            var bad = new GridViewSettings { Levels = "sideways", Depth = "??", Colour = "nope", Opacity = 5f, Width = 0f, LabelDistance = float.NaN }.Clean();
            Assert.AreEqual(GridLevelMode.Off, bad.Mode);
            Assert.AreEqual(GridViewSettings.DEPTH_FAINT, bad.Depth);
            Assert.AreEqual(GridViewSettings.DEFAULT_COLOUR, bad.Colour);
            Assert.AreEqual(1f, bad.Opacity);
            Assert.AreEqual(GridViewSettings.MIN_WIDTH, bad.Width);
            Assert.AreEqual(120f, bad.LabelDistance);

            // Defaults leave visibility.json's entry out; a change keeps it
            Assert.IsNull(new VisibilitySettings { Grids = new GridViewSettings() }.Clean().Grids);
            Assert.IsTrue(new VisibilitySettings { Grids = new GridViewSettings() }.Clean().IsEmpty);

            using var folder = new TempFolder();
            string path = folder.File("view.bimgo");
            BimGoDocument document = TestData.BuildDocument();
            var visibility = new VisibilitySettings { Grids = new GridViewSettings { Mode = GridLevelMode.All, LinkGrids = true, DepthIndex = 2, Colour = "#ff0000" } };
            var saved = new BimGoDocument { Scene = document.Scene, Comments = document.Comments, Visibility = visibility.Clean() };
            Assert.IsTrue(BimGoWriter.Write(path, saved, TestData.Writer, FileKinds.SAVE, out string error), error);
            GridViewSettings read = BimGoReader.Read(path, new LaunchSettings(), out error).Visibility?.Grids;
            Assert.IsNotNull(read, error);
            Assert.AreEqual(GridLevelMode.All, read.Mode);
            Assert.IsTrue(read.LinkGrids);
            Assert.AreEqual(GridViewSettings.DEPTH_XRAY, read.Depth);
            Assert.AreEqual("#FF0000", read.Colour);
        }
    }
}
