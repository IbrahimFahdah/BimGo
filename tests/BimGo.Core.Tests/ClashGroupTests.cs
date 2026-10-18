using System;
using System.Collections.Generic;
using System.Linq;
using BimGo.Clashes;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Clash groups (Round C, build C-C1): by-element grouping (greedy, deterministic, ungrouped and unresolved only),
    /// one group per clash when making / adding / merging, cleaning damaged files, groups across runs (members kept,
    /// all resolved → resolved) and report merges (members matched by clash). Expectations worked out by hand first.
    /// </summary>
    [TestClass]
    public sealed class ClashGroupTests
    {
        private static readonly DateTime T0 = new(2026, 10, 16, 0, 0, 0, DateTimeKind.Utc);

        private static ClashElementRef El(string uid, long id = 0, string type = null) =>
            new() { UniqueId = uid, ElementId = id, Category = "Ducts", FamilyType = type ?? string.Empty };

        private static ClashRecord Clash(ClashTest test, string a, string b, string status = ClashStatus.ACTIVE, string id = null)
        {
            var clash = new ClashRecord { TestId = test.Id, A = El(a), B = El(b), Status = status };
            if (id != null) { clash.Id = id; }
            return clash;
        }

        private static (ClashDocument Document, ClashTest Test) NewDocument()
        {
            var document = new ClashDocument();
            var test = new ClashTest { Name = "T" };
            document.Tests.Add(test);
            return (document, test);
        }

        #region By element

        [TestMethod]
        public void ByElement_DuctThroughThreeBeams_OneGroupNamedAfterTheDuct()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            var duct = El("duct", 101, "Rectangular Duct: 600x300");
            foreach (string beam in new[] { "b1", "b2", "b3" }) { document.Clashes.Add(new ClashRecord { TestId = test.Id, A = duct, B = El(beam) }); }
            document.Clashes.Add(new ClashRecord { TestId = test.Id, A = duct, B = El("b4"), Status = ClashStatus.RESOLVED }); // gone: left out

            List<ClashGroup> groups = ClashGrouping.ByElement(document, test.Id, ClashGrouping.MIN_SIZE, "gavin", T0);
            Assert.AreEqual(1, groups.Count);
            ClashGroup group = groups[0];
            Assert.AreEqual(3, group.Count);
            Assert.AreEqual(ClashGroupAuto.ELEMENT, group.Auto);
            Assert.AreEqual(duct.Key, group.KeyElement.Key);
            Assert.IsNull(group.Name, "the name reads from the element and the count");
            Assert.AreEqual("Rectangular Duct: 600x300 (101) × 3 clashes", ClashGroups.DisplayName(group));
            Assert.AreEqual(ClashStatus.NEW, group.Status, "the members' (all new)");
            Assert.IsNull(group.Updated, "automatic groups aren't a person's change");
        }

        [TestMethod]
        public void ByElement_TiesGoToTheSmallerKey_WhateverTheOrder()
        {
            // d1 × b1, d1 × b2, d2 × b2, d2 × b3: d1, d2 and b2 each have 2; "/b2" is the smallest key → its two clashes;
            // d1 and d2 are left with one each (below the minimum)
            foreach (bool reversed in new[] { false, true })
            {
                (ClashDocument document, ClashTest test) = NewDocument();
                var clashes = new List<ClashRecord> { Clash(test, "d1", "b1"), Clash(test, "d1", "b2"), Clash(test, "d2", "b2"), Clash(test, "d2", "b3") };
                if (reversed) { clashes.Reverse(); }
                document.Clashes.AddRange(clashes);

                List<ClashGroup> groups = ClashGrouping.ByElement(document, test.Id, 2, "gavin", T0);
                Assert.AreEqual(1, groups.Count, reversed ? "reversed" : "in order");
                Assert.AreEqual("b2", groups[0].KeyElement.UniqueId);
                CollectionAssert.AreEquivalent(
                    document.Clashes.Where(c => c.B.UniqueId == "b2").Select(c => c.Id).ToList(), groups[0].ClashIds);
            }
        }

        [TestMethod]
        public void ByElement_LeavesGroupedClashesAlone_AndFollowsTheMinimum()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            ClashRecord first = Clash(test, "d", "b1");
            document.Clashes.AddRange(new[] { first, Clash(test, "d", "b2"), Clash(test, "d", "b3") });
            ClashGroup manual = ClashGroups.Create(document, test.Id, new[] { first }, "Mine", null, null, "gavin", T0, out _);

            Assert.AreEqual(0, ClashGrouping.ByElement(document, test.Id, 3, "gavin", T0).Count, "only 2 ungrouped: below 3");
            List<ClashGroup> groups = ClashGrouping.ByElement(document, test.Id, 2, "gavin", T0);
            Assert.AreEqual(1, groups.Count);
            Assert.AreEqual(2, groups[0].Count);
            CollectionAssert.AreEqual(new[] { first.Id }, manual.ClashIds, "the hand-made group keeps its clash");
            Assert.AreEqual(2, document.Groups.Count);
        }

        [TestMethod]
        public void ByElement_AnElementOnBothSides_CountsOnce()
        {
            // X is A in two clashes and B in one: one group of three
            (ClashDocument document, ClashTest test) = NewDocument();
            document.Clashes.AddRange(new[] { Clash(test, "x", "p"), Clash(test, "q", "x"), Clash(test, "x", "r") });
            List<ClashGroup> groups = ClashGrouping.ByElement(document, test.Id, 2, "gavin", T0);
            Assert.AreEqual(1, groups.Count);
            Assert.AreEqual(3, groups[0].Count);
            Assert.AreEqual("x", groups[0].KeyElement.UniqueId);

            // GROUP ALL ON finds the same three (resolved ones only when asked)
            document.Clashes[1].Status = ClashStatus.RESOLVED;
            Assert.AreEqual(2, ClashGrouping.ForElement(document, test.Id, El("x").Key).Count);
            Assert.AreEqual(3, ClashGrouping.ForElement(document, test.Id, El("x").Key, includeResolved: true).Count);
        }

        #endregion

        #region Hand-made groups

        [TestMethod]
        public void Groups_OnePerClash_MoveMergeStatusAndRemove()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            ClashRecord c1 = Clash(test, "a", "b"), c2 = Clash(test, "c", "d"), c3 = Clash(test, "e", "f", ClashStatus.REVIEWED), c4 = Clash(test, "g", "h");
            document.Clashes.AddRange(new[] { c1, c2, c3, c4 });

            ClashGroup g1 = ClashGroups.Create(document, test.Id, new[] { c1, c2 }, null, null, null, "gavin", T0, out int moved);
            Assert.AreEqual("Group 1", g1.Name);
            Assert.AreEqual(0, moved);

            // c2 moves to the new group (active + reviewed: starts active, the least advanced)
            ClashGroup g2 = ClashGroups.Create(document, test.Id, new[] { c2, c3 }, null, null, null, "gavin", T0, out moved);
            Assert.AreEqual(1, moved);
            Assert.AreEqual("Group 2", g2.Name);
            Assert.AreEqual(ClashStatus.ACTIVE, g2.Status);
            CollectionAssert.AreEqual(new[] { c1.Id }, g1.ClashIds);

            // g1's last clash leaves: g1 goes
            ClashGroup g3 = ClashGroups.Create(document, test.Id, new[] { c1 }, null, null, null, "gavin", T0, out moved);
            Assert.AreEqual(1, moved);
            Assert.IsFalse(document.Groups.Contains(g1));
            Assert.AreEqual("Group 3", g3.Name);
            Assert.AreEqual(1, ClashGroups.Index(document).Values.Distinct().Count(g => g == g3));

            // Merge: the first picked keeps its name; the other's notes come along under its name
            ClashGroups.SetNotes(g2, "Check the drop", "gavin", T0);
            ClashGroup merged = ClashGroups.Merge(document, new[] { g3, g2 }, "gavin", T0.AddHours(1));
            Assert.AreSame(g3, merged);
            Assert.AreEqual("Group 3", merged.Name);
            CollectionAssert.AreEqual(new[] { c1.Id, c2.Id, c3.Id }, merged.ClashIds);
            Assert.AreEqual("Group 2: Check the drop", merged.Notes);
            Assert.AreEqual(1, document.Groups.Count);
            Assert.AreEqual(T0.AddHours(1), merged.Updated);

            // The group's status sets every member's; a member changed alone makes it mixed
            Dictionary<string, ClashRecord> byId = ClashGroups.ClashesById(document);
            Assert.AreEqual(3, ClashGroups.SetStatus(merged, ClashStatus.APPROVED, byId, "gavin", T0).Count);
            Assert.IsFalse(ClashGroups.Summarise(merged, byId).Mixed);
            ClashMerge.SetStatus(c1, ClashStatus.NEW, "gavin", T0);
            ClashGroupSummary summary = ClashGroups.Summarise(merged, byId);
            Assert.IsTrue(summary.Mixed);
            CollectionAssert.AreEqual(new[] { 1, 0, 0, 2, 0 }, summary.ByStatus);

            // ADD TO / REMOVE FROM; the last member out removes the group
            Assert.AreEqual(1, ClashGroups.AddTo(document, merged, new[] { c4, c1 }, "gavin", T0, out moved));
            Assert.AreEqual(0, moved);
            Assert.AreEqual(4, ClashGroups.Remove(document, new[] { c1, c2, c3, c4 }));
            Assert.IsNull(document.Groups);
        }

        [TestMethod]
        public void Groups_AutoNameFrozenWhenMergedWithAnotherElement_RenameBack()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            var duct = El("duct", 7, "Duct");
            document.Clashes.AddRange(new[]
            {
                new ClashRecord { TestId = test.Id, A = duct, B = El("b1") }, new ClashRecord { TestId = test.Id, A = duct, B = El("b2") },
                Clash(test, "p", "q"), Clash(test, "p", "r")
            });
            List<ClashGroup> groups = ClashGrouping.ByElement(document, test.Id, 2, "gavin", T0);
            Assert.AreEqual(2, groups.Count);
            ClashGroup ductGroup = groups.Single(g => g.KeyElement.UniqueId == "duct");
            ClashGroup other = groups.Single(g => g != ductGroup);

            ClashGroups.Merge(document, new[] { ductGroup, other }, "gavin", T0);
            Assert.AreEqual("Duct (7) × 4 clashes", ductGroup.Name, "frozen as it read after the merge");
            Assert.IsNull(ductGroup.KeyElement);
            Assert.IsNull(ductGroup.Auto);

            ClashGroups.Rename(document, ductGroup, "  Level 2 ducts ", "gavin", T0);
            Assert.AreEqual("Level 2 ducts", ductGroup.Name);
            ClashGroups.Rename(document, ductGroup, string.Empty, "gavin", T0);
            Assert.AreEqual("Group 1", ductGroup.Name, "no key element left: a numbered name");
        }

        [TestMethod]
        public void Clean_DropsUnknownDuplicateAndEmpty()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            var other = new ClashTest { Name = "U" };
            document.Tests.Add(other);
            ClashRecord c1 = Clash(test, "a", "b", id: "c1"), c4 = Clash(test, "g", "h", id: "c4"), u1 = Clash(other, "a", "b", id: "u1");
            document.Clashes.AddRange(new[] { c1, c4, u1 });
            document.Groups = new List<ClashGroup>
            {
                new() { Id = "g", TestId = test.Id, ClashIds = new List<string> { "c1", "missing", "c1", "u1" }, Status = "weird" },
                new() { Id = "g", TestId = test.Id, ClashIds = new List<string> { "c1", "c4" } },
                new() { Id = "empty", TestId = test.Id, ClashIds = new List<string>() },
                null
            };
            document.Clean();
            Assert.AreEqual(2, document.Groups.Count);
            CollectionAssert.AreEqual(new[] { "c1" }, document.Groups[0].ClashIds);
            Assert.AreEqual(ClashStatus.NEW, document.Groups[0].Status);
            CollectionAssert.AreEqual(new[] { "c4" }, document.Groups[1].ClashIds, "c1 stays with the first group");
            Assert.AreNotEqual("g", document.Groups[1].Id, "duplicate id replaced");

            document.Groups[0].ClashIds.Clear();
            document.Groups[1].ClashIds.Clear();
            document.Clean();
            Assert.IsNull(document.Groups);
        }

        [TestMethod]
        public void Files_GroupsRoundTrip_AndAbsentWhenNone()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            ClashRecord c1 = Clash(test, "a", "b"), c2 = Clash(test, "c", "d");
            document.Clashes.AddRange(new[] { c1, c2 });
            string plain = System.Text.Encoding.UTF8.GetString(ClashFiles.Serialize(document));
            Assert.IsFalse(plain.Contains("\"groups\"", StringComparison.Ordinal), "no groups: the file is as before");

            ClashGroup group = ClashGroups.Create(document, test.Id, new[] { c1, c2 }, "Riser", null, null, "gavin", T0, out _);
            ClashGroups.SetNotes(group, "Coordinate with structure", "gavin", T0);
            ClashDocument back = ClashFiles.Parse(ClashFiles.Serialize(document), out string error);
            Assert.IsNull(error);
            ClashGroup read = back.Groups.Single();
            Assert.AreEqual(group.Id, read.Id);
            Assert.AreEqual("Riser", read.Name);
            Assert.AreEqual("Coordinate with structure", read.Notes);
            CollectionAssert.AreEqual(group.ClashIds, read.ClashIds);
        }

        #endregion

        #region Runs and reports

        [TestMethod]
        public void Runs_MembersStayResolved_GroupFollowsWhenAllAreResolved_ResetRemoves()
        {
            (ClashDocument document, ClashTest test) = NewDocument();
            ClashRecord New(string a, string b) => new() { A = new ClashElementRef { UniqueId = a }, B = new ClashElementRef { UniqueId = b } };

            ClashMerge.Apply(document, test, new[] { New("a", "b"), New("c", "d") }, true, T0, "m1", 2, 2, 1);
            ClashMerge.Apply(document, test, new[] { New("a", "b"), New("c", "d") }, true, T0.AddHours(1), "m1", 2, 2, 1);
            ClashGroup group = ClashGroups.Create(document, test.Id, document.Clashes, "Both", null, null, "gavin", T0.AddHours(2), out _);
            Assert.AreEqual(ClashStatus.ACTIVE, group.Status);
            ClashRecord cd = document.Clashes.Single(c => c.A.UniqueId == "c");

            // c × d gone: resolved, still a member; the group stays active (a × b is still there); a new clash stays ungrouped
            ClashMerge.Apply(document, test, new[] { New("a", "b"), New("e", "f") }, true, T0.AddHours(3), "m2", 3, 3, 1);
            Assert.AreEqual(ClashStatus.RESOLVED, cd.Status);
            Assert.AreEqual(2, group.Count);
            Assert.AreEqual(ClashStatus.ACTIVE, group.Status);
            Assert.IsFalse(ClashGroups.Index(document).ContainsKey(document.Clashes.Single(c => c.A.UniqueId == "e").Id));

            // Both gone: the group is resolved; one back: active again (same ids, so membership holds)
            ClashMerge.Apply(document, test, Array.Empty<ClashRecord>(), true, T0.AddHours(4), "m3", 3, 3, 1);
            Assert.AreEqual(ClashStatus.RESOLVED, group.Status);
            ClashMerge.Apply(document, test, new[] { New("c", "d") }, true, T0.AddHours(5), "m4", 3, 3, 1);
            Assert.AreEqual(ClashStatus.ACTIVE, group.Status);
            Assert.AreEqual(ClashGroups.Index(document)[cd.Id], group);

            ClashMerge.ResetTest(document, test);
            Assert.IsNull(document.Groups);
        }

        [TestMethod]
        public void Report_GroupsMergeByClash_NewerWins_OurMembershipStays()
        {
            // Theirs: two clashes in a group. Ours: the first pair (reversed, its own id), no group
            var test = new ClashTest { Id = "t1", Name = "T" };
            ClashDocument theirs = new() { Tests = { test } };
            theirs.Clashes.Add(new ClashRecord { Id = "tx", TestId = "t1", A = El("a"), B = El("b") });
            theirs.Clashes.Add(new ClashRecord { Id = "ty", TestId = "t1", A = El("c"), B = El("d") });
            theirs.Groups = new List<ClashGroup> { new() { Id = "G", TestId = "t1", Name = "Theirs", ClashIds = new List<string> { "tx", "ty" }, Updated = T0.AddHours(2) } };

            ClashDocument ours = new() { Tests = { new ClashTest { Id = "t1", Name = "T" } } };
            ours.Clashes.Add(new ClashRecord { Id = "ox", TestId = "t1", A = El("b"), B = El("a") });
            ClashImportResult result = ClashFiles.Merge(Copy(theirs), ours, null);
            Assert.AreEqual(1, result.GroupsAdded);
            ClashGroup added = ours.Groups.Single();
            Assert.AreEqual("Theirs", added.Name);
            CollectionAssert.AreEquivalent(new[] { "ox", "ty" }, added.ClashIds);

            // Ours: the same group renamed later, and our own group holding the first pair: ours win both ways
            ClashDocument ours2 = new() { Tests = { new ClashTest { Id = "t1", Name = "T" } } };
            ours2.Clashes.Add(new ClashRecord { Id = "ox", TestId = "t1", A = El("b"), B = El("a") });
            ours2.Groups = new List<ClashGroup>
            {
                new() { Id = "H", TestId = "t1", Name = "Ours", ClashIds = new List<string> { "ox" } },
                new() { Id = "G", TestId = "t1", Name = "Mine", ClashIds = new List<string>(), Updated = T0.AddHours(3) }
            };
            // (G with no members would be cleaned away on load: give it one by merging, then check)
            ClashImportResult second = ClashFiles.Merge(Copy(theirs), ours2, null);
            Assert.AreEqual(0, second.GroupsAdded);
            ClashGroup g = ClashGroups.Find(ours2, "G");
            Assert.AreEqual("Mine", g.Name, "our change is newer");
            CollectionAssert.AreEqual(new[] { "ty" }, g.ClashIds, "ox stays in our group H");
            CollectionAssert.AreEqual(new[] { "ox" }, ClashGroups.Find(ours2, "H").ClashIds);
        }

        private static ClashDocument Copy(ClashDocument document) => ClashFiles.Parse(ClashFiles.Serialize(document), out _);

        #endregion
    }
}
