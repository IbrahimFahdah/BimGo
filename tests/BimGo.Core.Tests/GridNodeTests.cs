using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Xml.Linq;
using BimGo.Clashes;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Grids round B: grid intersections (names, links kept apart, joints counted once), the clash grid locator (nearest
    /// intersection, level by storey, extents preferred, link fallback), AUTO GROUP by grid / grid + level, the reports'
    /// grid location, and the new grid view settings (line style, nodes, clash comments).
    /// </summary>
    [TestClass]
    public sealed class GridNodeTests
    {
        private static readonly DateTime T0 = new(2026, 10, 17, 0, 0, 0, DateTimeKind.Utc);

        // Lettered grids A, B run north (x = 0, 8); numbered 1, 2 run east (y = 0, 6). C stops at 3.5 m (3D extent).
        private static GridLine[] Grids() => new[]
        {
            new GridLine { Name = "A", Points = new[] { new Vector2(0, -2), new Vector2(0, 10) } },
            new GridLine { Name = "B", Points = new[] { new Vector2(8, -2), new Vector2(8, 10) } },
            new GridLine { Name = "1", Points = new[] { new Vector2(-2, 0), new Vector2(20, 0) } },
            new GridLine { Name = "2", Points = new[] { new Vector2(-2, 6), new Vector2(20, 6) } },
            new GridLine { Name = "C", Points = new[] { new Vector2(16, -2), new Vector2(16, 10) }, Bottom = -0.5f, Top = 3.5f }
        };

        private static readonly LevelInfo[] LEVELS =
        {
            new("Level 1", 0f), new("Level 2", 3.5f), new("Level 3", 7f), new("Parapet", 8f, IsStorey: false)
        };

        [TestMethod]
        public void Build_CrossingsNamedLetterFirst()
        {
            GridNode[] nodes = GridNodes.Build(Grids());
            Assert.AreEqual(6, nodes.Length, "A, B, C × 1, 2");
            CollectionAssert.AreEquivalent(new[] { "A-1", "A-2", "B-1", "B-2", "C-1", "C-2" }, nodes.Select(n => n.Name).ToArray());
            GridNode b2 = nodes.Single(n => n.Name == "B-2");
            Assert.AreEqual(new Vector2(8, 6), b2.Point);

            Assert.AreEqual("C-4", GridNodes.NodeName("4", "C"));
            Assert.AreEqual("1-12", GridNodes.NodeName("12", "1"), "two numbers: ordinal");
            Assert.AreEqual("A-B", GridNodes.NodeName("B", "A"));
        }

        [TestMethod]
        public void Build_LinksApartJointsOnceParallelsNone()
        {
            var grids = new[]
            {
                new GridLine { Name = "A", Points = new[] { new Vector2(0, -5), new Vector2(0, 0), new Vector2(0, 5) } }, // joint at the crossing
                new GridLine { Name = "1", Points = new[] { new Vector2(-5, 0), new Vector2(5, 0) } },
                new GridLine { Name = "S1", Link = 1, Points = new[] { new Vector2(-5, 1), new Vector2(5, 1) } },        // crosses A, but another model
                new GridLine { Name = "2", Points = new[] { new Vector2(-5, 3), new Vector2(5, 3) } }
            };
            GridNode[] nodes = GridNodes.Build(grids);
            Assert.AreEqual(2, nodes.Length, "A-1 once (the joint), A-2; no host × link node; 1 ∥ 2");
            Assert.IsFalse(GridNodes.Intersect(new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1), new Vector2(1, 1), out _));
            Assert.IsFalse(GridNodes.Intersect(new Vector2(0, 0), new Vector2(1, 0), new Vector2(2, -1), new Vector2(2, 1), out _), "past the end");
        }

        [TestMethod]
        public void Locator_NearestStoreyLevelAndExtents()
        {
            GridLine[] grids = Grids();
            var origin = new Vector3(100, 200, 0);
            GridLocator locator = GridLocator.Create(grids, GridNodes.Build(grids), LEVELS, origin);
            Assert.IsFalse(locator.IsEmpty);

            // Near B-2 on level 2 (internal = local + origin)
            Assert.IsTrue(locator.Locate(100 + 7.2, 200 + 5.5, 4.0, out GridLocation at));
            Assert.AreEqual("B-2", at.Node);
            Assert.AreEqual("Level 2", at.Level);
            Assert.AreEqual("B-2 : Level 2", at.Text);
            Assert.AreEqual(MathF.Sqrt(0.64f + 0.25f), at.Offset, 1e-4f);

            // Above the parapet (not a storey): still Level 3
            Assert.AreEqual("A-1 : Level 3", locator.Text(100.3, 199.9, 8.5));

            // Nearest C-2 by distance, but C stops at 3.5 m: on level 3 the nearest reaching node is B-2
            Assert.AreEqual("B-2 : Level 3", locator.Text(100 + 15, 200 + 6, 7.5));
            Assert.AreEqual("C-2 : Level 1", locator.Text(100 + 15, 200 + 6, 1.0));
            Assert.AreEqual("A-1 : Level 1", locator.Text(100, 200, -3), "below the lowest: the lowest");

            Assert.IsTrue(GridLocator.Create(grids, Array.Empty<GridNode>(), LEVELS, origin).IsEmpty);
            Assert.IsNull(GridLocator.Empty.Text(0, 0, 0));
        }

        [TestMethod]
        public void Locator_LinksOnlyWhenTheHostHasNone()
        {
            var grids = new[]
            {
                new GridLine { Name = "X", Link = 1, Points = new[] { new Vector2(0, -5), new Vector2(0, 5) } },
                new GridLine { Name = "9", Link = 1, Points = new[] { new Vector2(-5, 0), new Vector2(5, 0) } }
            };
            GridLocator links = GridLocator.Create(grids, GridNodes.Build(grids), LEVELS, Vector3.Zero);
            Assert.AreEqual("X-9 : Level 1", links.Text(1, 1, 1));

            GridLine[] both = Grids().Concat(grids).ToArray();
            GridLocator host = GridLocator.Create(both, GridNodes.Build(both), LEVELS, Vector3.Zero);
            Assert.AreEqual("A-1 : Level 1", host.Text(0.5, 0.5, 1), "the host's own intersections win");
        }

        [TestMethod]
        public void ByGrid_GroupsPerIntersectionAndPerLevel()
        {
            var document = new ClashDocument();
            var test = new ClashTest { Name = "T" };
            document.Tests.Add(test);
            GridLine[] grids = Grids();
            GridLocator locator = GridLocator.Create(grids, GridNodes.Build(grids), LEVELS, Vector3.Zero);
            ClashRecord At(string id, double x, double y, double z) => new()
            {
                TestId = test.Id, A = new ClashElementRef { UniqueId = id + "a" }, B = new ClashElementRef { UniqueId = id + "b" },
                Status = ClashStatus.ACTIVE, X = x, Y = y, Z = z
            };
            ClashRecord c1 = At("1", 0.5, 0.5, 1), c2 = At("2", -0.3, 0.2, 4), c3 = At("3", 0.1, 0.1, 4), c4 = At("4", 8, 6, 1);
            document.Clashes.AddRange(new[] { c1, c2, c3, c4 });
            GridLocation? Locate(ClashRecord c) => locator.Locate(c.X, c.Y, c.Z, out GridLocation l) ? l : null;

            List<ClashGroup> byGrid = ClashGrouping.ByGrid(document, test.Id, Locate, perLevel: false, ClashGrouping.MIN_SIZE, "gavin", T0);
            Assert.AreEqual(1, byGrid.Count, "B-2 has one clash: below the minimum");
            Assert.AreEqual("Near A-1", byGrid[0].AutoLabel);
            Assert.AreEqual(ClashGroupAuto.GRID, byGrid[0].Auto);
            CollectionAssert.AreEqual(new[] { c1.Id, c2.Id, c3.Id }, byGrid[0].ClashIds);

            document.Groups = null;
            List<ClashGroup> perLevel = ClashGrouping.ByGrid(document, test.Id, Locate, perLevel: true, ClashGrouping.MIN_SIZE, "gavin", T0);
            Assert.AreEqual(1, perLevel.Count);
            Assert.AreEqual("Near A-1 : Level 2", perLevel[0].AutoLabel);
            Assert.AreEqual(ClashGroupAuto.GRID_LEVEL, perLevel[0].Auto);
            CollectionAssert.AreEqual(new[] { c2.Id, c3.Id }, perLevel[0].ClashIds);

            Assert.AreEqual("No grid", ClashGrouping.GridLabel(null, true));
        }

        [TestMethod]
        public void Reports_CarryTheGridLocation()
        {
            var document = new ClashDocument();
            var test = new ClashTest { Name = "MEP" };
            document.Tests.Add(test);
            var clash = new ClashRecord
            {
                TestId = test.Id, Status = ClashStatus.NEW, X = 8, Y = 6, Z = 1, Crossing = true, Distance = 0.02,
                A = new ClashElementRef { UniqueId = "a", Category = "Ducts", Level = "Level 1" },
                B = new ClashElementRef { UniqueId = "b", Category = "Pipes", Level = "Level 1" }
            };
            document.Clashes.Add(clash);
            var options = new ClashReportOptions { ModelTitle = "Tower", GridLocation = c => "B-2 : Level 1" };

            XDocument xml = XDocument.Parse(System.Text.Encoding.UTF8.GetString(ClashReports.Xml(document, new[] { clash }, options, null)));
            Assert.AreEqual("B-2 : Level 1", (string)xml.Descendants("clashresult").Single().Element("gridlocation"));
            XDocument plain = XDocument.Parse(System.Text.Encoding.UTF8.GetString(ClashReports.Xml(document, new[] { clash }, new ClashReportOptions(), null)));
            Assert.AreEqual("Level 1", (string)plain.Descendants("clashresult").Single().Element("gridlocation"), "no locator: the level, as before");

            string html = ClashReports.Html(document, new[] { clash }, options, null, null);
            StringAssert.Contains(html, "B-2 : Level 1");
            StringAssert.Contains(html, "By grid");
        }

        [TestMethod]
        public void ViewSettings_LineStyleNodesAndComments()
        {
            var d = new GridViewSettings();
            Assert.IsFalse(d.DashDot, "solid by default");
            Assert.IsTrue(d.Nodes);
            Assert.IsFalse(d.ClashComments);
            Assert.IsTrue(d.IsDefault);

            Assert.IsFalse(new GridViewSettings { DashDot = true }.IsDefault);
            Assert.IsFalse(new GridViewSettings { Nodes = false }.IsDefault);
            Assert.IsFalse(new GridViewSettings { ClashComments = true }.IsDefault);
            Assert.AreEqual(GridViewSettings.LINE_SOLID, new GridViewSettings { Line = "wavy" }.Clean().Line);
            Assert.AreEqual(GridViewSettings.LINE_DASH_DOT, new GridViewSettings { DashDot = true }.Clean().Line);
        }
    }
}
