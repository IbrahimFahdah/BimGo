using System;
using System.Collections.Generic;
using System.Linq;
using BimGo.Clashes;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Clash grouping tools (Round C, build C-C2): automatic groups by level / category pair / level + category pair
    /// (deterministic, ungrouped and unresolved only, minimum size, chainable), automatic labels (names, rename, merge),
    /// the cluster sphere, group boxes (full height, RECOLLECT's split, file round trip, cleaning). Expectations worked
    /// out by hand first.
    /// </summary>
    [TestClass]
    public sealed class ClashGroupToolTests
    {
        private static readonly DateTime T0 = new(2026, 10, 17, 0, 0, 0, DateTimeKind.Utc);

        private static ClashElementRef El(string uid, string category = "Ducts", string level = "") =>
            new() { UniqueId = uid, Category = category, Level = level };

        private static ClashRecord Clash(ClashTest test, ClashElementRef a, ClashElementRef b, string status = ClashStatus.ACTIVE,
            double x = 0, double y = 0, double z = 0) =>
            new() { TestId = test.Id, A = a, B = b, Status = status, X = x, Y = y, Z = z };

        private static ClashRecord At(ClashTest test, string uid, double x, double y, double z, string status = ClashStatus.ACTIVE) =>
            Clash(test, El(uid + "a"), El(uid + "b"), status, x, y, z);

        private static (ClashDocument Document, ClashTest Test) NewDocument()
        {
            var document = new ClashDocument();
            var test = new ClashTest { Name = "T" };
            document.Tests.Add(test);
            return (document, test);
        }

        #region Level and category

        [TestMethod]
        public void LevelAndCategoryPair_ReadAThenB_PairOrderAside()
        {
            (_, ClashTest test) = NewDocument();
            ClashRecord fallback = Clash(test, El("a", level: "—"), El("b", "Structural Framing", "Level 2"));
            Assert.AreEqual("Level 2", ClashGrouping.LevelOf(fallback), "A has none: B's");
            Assert.AreEqual("—", ClashGrouping.LevelOf(Clash(test, El("a"), El("b"))));
            Assert.AreEqual("Ducts × Structural Framing", ClashGrouping.CategoryPairOf(fallback));
            Assert.AreEqual("Ducts × Structural Framing",
                ClashGrouping.CategoryPairOf(Clash(test, El("a", "Structural Framing"), El("b", "Ducts"))), "B × A reads the same");
            Assert.AreEqual("Element × Pipes", ClashGrouping.CategoryPairOf(Clash(test, El("a", ""), El("b", "Pipes"))));
        }

        [TestMethod]
        public void ByLevel_OpenUngroupedOnly_MinimumTwo_TiesByLabel()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            ClashRecord c1 = Clash(test, El("1", level: "Level 1"), El("x"));
            ClashRecord c2 = Clash(test, El("2", level: "Level 1"), El("x"));
            ClashRecord c3 = Clash(test, El("3", level: "—"), El("y", level: "Level 2")); // B's level
            ClashRecord c4 = Clash(test, El("4", level: "Level 2"), El("x"));
            ClashRecord c5 = Clash(test, El("5", level: "Level 3"), El("x"));             // alone: below the minimum
            ClashRecord c6 = Clash(test, El("6", level: "Level 1"), El("x"), ClashStatus.RESOLVED);
            ClashRecord c7 = Clash(test, El("7", level: "Level 2"), El("x"));
            ClashRecord c8 = Clash(test, El("8", level: "Level 2"), El("x"));
            document.Clashes.AddRange(new[] { c1, c2, c3, c4, c5, c6, c7, c8 });
            ClashGroup hand = ClashGroups.Create(document, test.Id, new[] { c7, c8 }, "Riser", null, null, "gavin", T0, out _);

            List<ClashGroup> made = ClashGrouping.ByLevel(document, test.Id, ClashGrouping.MIN_SIZE, "gavin", T0);
            Assert.AreEqual(2, made.Count);
            Assert.AreEqual("Level 1", made[0].AutoLabel, "2 each: by label");
            Assert.AreEqual("Level 1 × 2 clashes", ClashGroups.DisplayName(made[0]));
            CollectionAssert.AreEqual(new[] { c1.Id, c2.Id }, made[0].ClashIds);
            CollectionAssert.AreEqual(new[] { c3.Id, c4.Id }, made[1].ClashIds);
            Assert.AreEqual(ClashGroupAuto.LEVEL, made[0].Auto);
            Assert.IsNull(made[0].Name);
            Assert.IsTrue(made[0].HasAutoName);
            CollectionAssert.AreEqual(new[] { c7.Id, c8.Id }, hand.ClashIds, "grouped clashes left alone");
            Assert.AreEqual(3, document.Groups.Count);
        }

        [TestMethod]
        public void ByCategoryPair_AndPerLevel_ThenChained()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            ClashRecord c1 = Clash(test, El("d1", "Ducts", "Level 1"), El("b1", "Structural Framing"));
            ClashRecord c2 = Clash(test, El("b2", "Structural Framing", "Level 1"), El("d2", "Ducts"));
            ClashRecord c3 = Clash(test, El("p1", "Pipes", "Level 1"), El("w1", "Walls"));
            ClashRecord c4 = Clash(test, El("p2", "Pipes", "Level 2"), El("w2", "Walls"));
            document.Clashes.AddRange(new[] { c1, c2, c3, c4 });

            // Per level first: only the ducts pair shares a level
            List<ClashGroup> perLevel = ClashGrouping.ByCategoryPair(document, test.Id, perLevel: true, ClashGrouping.MIN_SIZE, "gavin", T0);
            Assert.AreEqual(1, perLevel.Count);
            Assert.AreEqual("Level 1 · Ducts × Structural Framing × 2 clashes", ClashGroups.DisplayName(perLevel[0]));
            Assert.AreEqual(ClashGroupAuto.LEVEL_CATEGORY, perLevel[0].Auto);

            // Then by pair over what is left: the pipes pair across levels
            List<ClashGroup> pairs = ClashGrouping.ByCategoryPair(document, test.Id, perLevel: false, ClashGrouping.MIN_SIZE, "gavin", T0);
            Assert.AreEqual(1, pairs.Count);
            Assert.AreEqual("Pipes × Walls", pairs[0].AutoLabel);
            CollectionAssert.AreEqual(new[] { c3.Id, c4.Id }, pairs[0].ClashIds);
            Assert.AreEqual(ClashGroupAuto.CATEGORY, pairs[0].Auto);

            // Nothing ungrouped left
            Assert.AreEqual(0, ClashGrouping.ByLevel(document, test.Id, ClashGrouping.MIN_SIZE, "gavin", T0).Count);
        }

        [TestMethod]
        public void AutoLabel_RenameBack_MergeKeepsSameBasis_FreezesOtherwise()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            ClashRecord[] c = Enumerable.Range(0, 6).Select(i => At(test, "c" + i, i, 0, 0)).ToArray();
            document.Clashes.AddRange(c);
            ClashGroup a = ClashGroups.Create(document, test.Id, new[] { c[0], c[1] }, null, null, "Level 1", ClashGroupAuto.LEVEL, "gavin", T0, out _);
            ClashGroup b = ClashGroups.Create(document, test.Id, new[] { c[2], c[3] }, null, null, "Level 1", ClashGroupAuto.LEVEL, "gavin", T0, out _);
            ClashGroup other = ClashGroups.Create(document, test.Id, new[] { c[4], c[5] }, null, null, "Level 2", ClashGroupAuto.LEVEL, "gavin", T0, out _);

            ClashGroups.Rename(document, a, "Mine", "gavin", T0);
            Assert.AreEqual("Mine", ClashGroups.DisplayName(a));
            ClashGroups.Rename(document, a, "  ", "gavin", T0);
            Assert.IsNull(a.Name, "empty: back to the automatic name");
            Assert.AreEqual("Level 1 × 2 clashes", ClashGroups.DisplayName(a));

            ClashGroup merged = ClashGroups.Merge(document, new[] { a, b }, "gavin", T0);
            Assert.AreSame(a, merged);
            Assert.IsNull(merged.Name, "same label: still automatic");
            Assert.AreEqual("Level 1 × 4 clashes", ClashGroups.DisplayName(merged));

            ClashGroups.Merge(document, new[] { a, other }, "gavin", T0);
            Assert.AreEqual("Level 1 × 6 clashes", a.Name, "another label: frozen as it read");
            Assert.IsNull(a.AutoLabel);
        }

        #endregion

        #region Cluster sphere

        [TestMethod]
        public void InSphere_EdgeIncluded_NearestFirst_TiesInOrder()
        {
            (_, ClashTest test) = NewDocument();
            ClashRecord p0 = At(test, "p0", 0, 0, 0), p1 = At(test, "p1", 0.5, 0, 0), p2 = At(test, "p2", 1.0, 0, 0), p3 = At(test, "p3", 1.5, 0, 0);
            var all = new[] { p0, p1, p2, p3 };

            CollectionAssert.AreEqual(new[] { p0, p1, p2 }, ClashGrouping.InSphere(all, 0, 0, 0, 1.0), "1 m from p0: the edge counts");
            CollectionAssert.AreEqual(new[] { p2, p1, p3, p0 }, ClashGrouping.InSphere(all, 1.0, 0, 0, 1.0), "from p2: 0, then 0.5 (p1 before p3), then 1");
            Assert.AreEqual(0, ClashGrouping.InSphere(all, 0, 0, 0, -1).Count);
            Assert.AreEqual(1, ClashGrouping.InSphere(all, 0, 0, 0, 0).Count, "radius 0: the centre only");
        }

        [TestMethod]
        public void ClusterLabel_NextNumber_MostCommonLevel()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            ClashRecord a = Clash(test, El("a", level: "Level 1"), El("x"));
            ClashRecord b = Clash(test, El("b", level: "Level 2"), El("x"));
            ClashRecord c = Clash(test, El("c", level: "Level 2"), El("x"));
            document.Clashes.AddRange(new[] { a, b, c });
            Assert.AreEqual("Cluster 1 · Level 2", ClashGrouping.ClusterLabel(document, test.Id, new[] { a, b, c }));

            ClashGroup first = ClashGroups.Create(document, test.Id, new[] { a, b }, null, null, "Cluster 3 · Level 1", null, "gavin", T0, out _);
            Assert.AreEqual("Cluster 3 · Level 1 × 2 clashes", ClashGroups.DisplayName(first));
            Assert.IsNull(first.Auto, "made by hand: REMOVE AUTOMATIC GROUPS keeps it");
            Assert.IsTrue(first.HasAutoName);
            Assert.AreEqual("Cluster 4 · Level 2", ClashGrouping.ClusterLabel(document, test.Id, new[] { c }));
        }

        #endregion

        #region Boxes

        [TestMethod]
        public void Box_Inside_FullHeight_AndRecollectSplit()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            ClashRecord c1 = At(test, "c1", 0, 0, 0), c2 = At(test, "c2", 1, 1, 1);
            ClashRecord c3 = At(test, "c3", 1, 1, 1.5);                              // a later run's clash, inside
            ClashRecord c4 = At(test, "c4", 1, 1, 1.5, ClashStatus.RESOLVED);       // resolved: never joins
            ClashRecord c5 = At(test, "c5", 5, 5, 5);                                // outside
            document.Clashes.AddRange(new[] { c1, c2 });

            var box = new ClashGroupBox { MinX = 0, MinY = 0, MinZ = 0, MaxX = 2, MaxY = 2, MaxZ = 2 };
            CollectionAssert.AreEqual(new[] { c1, c2 }, ClashGrouping.InBox(document.Clashes, box), "faces count");
            ClashGroup group = ClashGroups.Create(document, test.Id, ClashGrouping.InBox(document.Clashes, box), null, null, null, "gavin", T0, out _);
            ClashGroups.SetBox(group, box, "gavin", T0);
            document.Clashes.AddRange(new[] { c3, c4, c5 });

            Assert.IsTrue(ClashGroups.BoxSplit(document, group, null, out List<ClashRecord> joining, out List<ClashRecord> outside));
            CollectionAssert.AreEqual(new[] { c3 }, joining);
            Assert.AreEqual(0, outside.Count);

            // A smaller box (EDIT BOX…): c2 now lies outside, c3 doesn't join
            var small = new ClashGroupBox { MinX = 0, MinY = 0, MinZ = 0, MaxX = 0.5, MaxY = 0.5, MaxZ = 0.5 };
            ClashGroups.BoxSplit(document, group, small, out joining, out outside);
            Assert.AreEqual(0, joining.Count);
            CollectionAssert.AreEqual(new[] { c2 }, outside);

            // Full height: a thin plan rectangle still catches everything stacked over it
            var plan = new ClashGroupBox { MinX = 0, MinY = 0, MinZ = 0, MaxX = 2, MaxY = 2, MaxZ = 0.1, FullHeight = true };
            ClashGroups.BoxSplit(document, group, plan, out joining, out outside);
            CollectionAssert.AreEqual(new[] { c3 }, joining);
            Assert.AreEqual(0, outside.Count);
            Assert.IsFalse(plan.Contains(c5));

            Assert.IsFalse(ClashGroups.BoxSplit(document, new ClashGroup { TestId = test.Id }, null, out _, out _), "no box");
        }

        [TestMethod]
        public void Box_RoundTrip_MergeUnion_Clean()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            ClashRecord[] c = Enumerable.Range(0, 6).Select(i => At(test, "c" + i, i, 0, 0)).ToArray();
            document.Clashes.AddRange(c);
            ClashGroup a = ClashGroups.Create(document, test.Id, new[] { c[0], c[1] }, "A", null, null, "gavin", T0, out _);
            ClashGroup b = ClashGroups.Create(document, test.Id, new[] { c[2], c[3] }, "B", null, null, "gavin", T0, out _);
            ClashGroup none = ClashGroups.Create(document, test.Id, new[] { c[4], c[5] }, "C", null, null, "gavin", T0, out _);
            ClashGroups.SetBox(a, new ClashGroupBox { MinX = 0, MinY = -1, MinZ = -1, MaxX = 1, MaxY = 1, MaxZ = 1, FullHeight = true }, "gavin", T0);
            ClashGroups.SetBox(b, new ClashGroupBox { MinX = 3, MinY = 1, MinZ = -1, MaxX = 2, MaxY = -1, MaxZ = 1 }, "gavin", T0); // corners swapped
            Assert.AreEqual(2.0, b.Box.MinX, "SetBox normalises");

            string json = System.Text.Encoding.UTF8.GetString(ClashFiles.Serialize(document));
            Assert.AreEqual(2, json.Split("\"box\"").Length - 1, "only groups with a box write one");
            ClashDocument back = ClashFiles.Parse(ClashFiles.Serialize(document), out string error);
            Assert.IsNull(error);
            ClashGroup readA = back.Groups.Single(g => g.Name == "A");
            Assert.IsTrue(readA.Box.FullHeight);
            Assert.AreEqual(-1.0, readA.Box.MinY);
            Assert.IsNull(back.Groups.Single(g => g.Name == "C").Box);

            ClashGroups.Merge(document, new[] { a, b }, "gavin", T0);
            Assert.AreEqual(0.0, a.Box.MinX);
            Assert.AreEqual(3.0, a.Box.MaxX, "the box round both");
            Assert.IsTrue(a.Box.FullHeight, "either full height: full height (members stay inside)");
            ClashGroups.Merge(document, new[] { a, none }, "gavin", T0);
            Assert.IsNull(a.Box, "a group without a box: no box");

            // Cleaning: NaN goes, a blank label goes
            none = ClashGroups.Create(document, test.Id, new[] { c[4] }, "D", null, null, "gavin", T0, out _);
            none.Box = new ClashGroupBox { MinX = double.NaN };
            none.AutoLabel = "  ";
            document.Clean();
            Assert.IsNull(none.Box);
            Assert.IsNull(none.AutoLabel);
        }

        #endregion
    }
}
