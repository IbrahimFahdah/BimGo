using System.Collections.Generic;
using System.Linq;
using BimGo.Clashes;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// QOL round: tests / sets files (EXPORT / IMPORT TESTS…, SETS…): round trip, wrong kind, name clashes, link and
    /// level reconciliation.
    /// </summary>
    [TestClass]
    public sealed class ClashSetupTests
    {
        private static readonly LinkInfo[] SOURCE_LINKS = { new() { Index = 1, Name = "STR.rvt", InstanceUniqueId = "link-str-A" } };
        private static readonly LinkInfo[] TARGET_LINKS =
        {
            new() { Index = 1, Name = "STR.rvt", InstanceUniqueId = "link-str-B" },
            new() { Index = 2, Name = "MEP.rvt", InstanceUniqueId = "link-mep-B" }
        };

        private static SetRule Rule(string field, params string[] values)
        {
            var rule = new SetRule { Field = field, Op = values.Length > 1 ? RuleOp.IS_ONE_OF : RuleOp.IS, Values = values.ToList() };
            return rule.Normalise();
        }

        /// <summary>Two sets (structure in a link on Level 1 / Roof; ducts in the host) and a test between them.</summary>
        private static ClashDocument Source()
        {
            var structure = new SearchSet { Id = "s1", Name = "Structure", MatchAll = true, Rules = { Rule(RuleField.LINK, "link-str-A"), Rule(RuleField.LEVEL, "Level 1", "Roof") } };
            var ducts = new SearchSet { Id = "s2", Name = "Ducts", Rules = { Rule(RuleField.CATEGORY, "Ducts") } };
            var unused = new SearchSet { Id = "s3", Name = "Unused", Rules = { Rule(RuleField.CATEGORY, "Doors") } };
            var doc = new ClashDocument();
            doc.Sets.AddRange(new[] { structure, ducts, unused });
            doc.Tests.Add(new ClashTest { Id = "t1", Name = "Ducts v Structure", SetA = "s2", SetB = "s1", Tolerance = 0.01, LastRunModel = "x" });
            return doc;
        }

        private static ClashSetupFile RoundTrip(ClashSetupKind kind)
        {
            ClashSetupFile built = ClashSetupFiles.Build(Source(), kind, SOURCE_LINKS, "Source", "BimGo test");
            ClashSetupFile read = ClashSetupFiles.Parse(ClashSetupFiles.Serialize(built), kind, out string error);
            Assert.IsNull(error);
            return read;
        }

        [TestMethod]
        public void Tests_ExportCarriesUsedSetsAndLinkNames()
        {
            ClashSetupFile file = RoundTrip(ClashSetupKind.Tests);
            Assert.AreEqual(1, file.Tests.Count);
            CollectionAssert.AreEquivalent(new[] { "s1", "s2" }, file.Sets.Select(s => s.Id).ToArray());
            Assert.IsNull(file.Tests[0].LastRunModel, "no run state in a setup file");
            Assert.AreEqual(1, file.Links.Count);
            Assert.AreEqual("STR.rvt", file.Links[0].Name);
        }

        [TestMethod]
        public void Parse_RefusesTheOtherKindAndReports()
        {
            byte[] sets = ClashSetupFiles.Serialize(ClashSetupFiles.Build(Source(), ClashSetupKind.Sets, SOURCE_LINKS, null, null));
            Assert.IsNull(ClashSetupFiles.Parse(sets, ClashSetupKind.Tests, out string error));
            StringAssert.Contains(error, "SETS tab");

            byte[] report = System.Text.Encoding.UTF8.GetBytes("{\"format\":\"bimgo-clash-report\",\"version\":1}");
            Assert.IsNull(ClashSetupFiles.Parse(report, ClashSetupKind.Sets, out error));
            StringAssert.Contains(error, "clash report");
        }

        [TestMethod]
        public void Plan_FindsMissingLinkByNameAndMissingLevel()
        {
            ClashSetupFile file = RoundTrip(ClashSetupKind.Sets);
            ClashSetupPlan plan = ClashSetupFiles.Plan(file, new ClashDocument(), TARGET_LINKS, new[] { "Level 1", "Level 2" });
            Assert.AreEqual(2, plan.Missing.Count);
            ClashSetupMissing link = plan.Missing[0];
            Assert.AreEqual(RuleField.LINK, link.Field, "links are listed first");
            Assert.AreEqual("STR.rvt", link.Label);
            Assert.AreEqual("link-str-B", link.Replacement);
            Assert.IsTrue(link.AutoMatched);
            ClashSetupMissing level = plan.Missing[1];
            Assert.AreEqual("Roof", level.Value);
            Assert.IsNull(level.Replacement, "left as it is until picked");
            Assert.AreEqual(0, plan.NameClashes.Count);
        }

        [TestMethod]
        public void Apply_ReconcilesValues()
        {
            ClashSetupFile file = RoundTrip(ClashSetupKind.Sets);
            var into = new ClashDocument();
            ClashSetupPlan plan = ClashSetupFiles.Plan(file, into, TARGET_LINKS, new[] { "Level 1", "Level 2" });
            plan.Missing.Single(m => m.Value == "Roof").Replacement = ClashSetupFiles.DROP;
            ClashSetupResult result = ClashSetupFiles.Apply(plan, into);

            Assert.AreEqual(3, result.SetsAdded);
            Assert.AreEqual(2, result.ValuesChanged); // link replaced, Roof dropped
            SearchSet structure = into.Sets.Single(s => s.Name == "Structure");
            CollectionAssert.AreEqual(new[] { "link-str-B" }, structure.Rules[0].Values);
            CollectionAssert.AreEqual(new[] { "Level 1" }, structure.Rules[1].Values);
        }

        [TestMethod]
        public void Apply_SetNameClashes()
        {
            ClashSetupFile Fresh() => RoundTrip(ClashSetupKind.Sets);

            ClashDocument KeepBoth()
            {
                var into = new ClashDocument();
                into.Sets.Add(new SearchSet { Id = "s2", Name = "ducts", Rules = { Rule(RuleField.CATEGORY, "Pipes") } });
                ClashSetupPlan plan = ClashSetupFiles.Plan(Fresh(), into, TARGET_LINKS, null);
                CollectionAssert.AreEqual(new[] { "Ducts" }, plan.NameClashes);
                plan.OnNameClash = ClashNameClash.KeepBoth;
                ClashSetupResult r = ClashSetupFiles.Apply(plan, into);
                Assert.AreEqual(3, r.SetsAdded);
                return into;
            }
            ClashDocument both = KeepBoth();
            Assert.AreEqual(4, both.Sets.Count);
            Assert.IsTrue(both.Sets.Any(s => s.Name == "Ducts (2)"));
            Assert.AreEqual(4, both.Sets.Select(s => s.Id).Distinct().Count(), "a taken id gets a new one");

            var replace = new ClashDocument();
            replace.Sets.Add(new SearchSet { Id = "mine", Name = "Ducts", Rules = { Rule(RuleField.CATEGORY, "Pipes") } });
            ClashSetupPlan p = ClashSetupFiles.Plan(Fresh(), replace, TARGET_LINKS, null);
            p.OnNameClash = ClashNameClash.Replace;
            ClashSetupResult rr = ClashSetupFiles.Apply(p, replace);
            Assert.AreEqual(1, rr.SetsReplaced);
            Assert.AreEqual(2, rr.SetsAdded);
            SearchSet ducts = replace.Sets.Single(s => s.Name == "Ducts");
            Assert.AreEqual("mine", ducts.Id, "the id stays");
            CollectionAssert.AreEqual(new[] { "Ducts" }, ducts.Rules[0].Values);

            var skip = new ClashDocument();
            skip.Sets.Add(new SearchSet { Id = "mine", Name = "Ducts" });
            ClashSetupPlan ps = ClashSetupFiles.Plan(Fresh(), skip, TARGET_LINKS, null);
            ps.OnNameClash = ClashNameClash.Skip;
            Assert.AreEqual(1, ClashSetupFiles.Apply(ps, skip).Skipped);
            Assert.AreEqual(3, skip.Sets.Count);
        }

        [TestMethod]
        public void Apply_TestsReuseSetsByNameAndReplaceKeepsId()
        {
            var into = new ClashDocument();
            into.Sets.Add(new SearchSet { Id = "here-ducts", Name = "Ducts" });
            into.Tests.Add(new ClashTest { Id = "here-t", Name = "Ducts v Structure", SetA = "x", Tolerance = 0.5, LastRunModel = "m" });

            ClashSetupPlan plan = ClashSetupFiles.Plan(RoundTrip(ClashSetupKind.Tests), into, TARGET_LINKS, new[] { "Level 1", "Roof" });
            CollectionAssert.AreEqual(new[] { "Ducts v Structure" }, plan.NameClashes);
            plan.OnNameClash = ClashNameClash.Replace;
            ClashSetupResult r = ClashSetupFiles.Apply(plan, into);

            Assert.AreEqual(1, r.TestsReplaced);
            Assert.AreEqual(1, r.SetsAdded, "Structure is added; Ducts is found by name");
            ClashTest test = into.Tests.Single();
            Assert.AreEqual("here-t", test.Id);
            Assert.AreEqual("here-ducts", test.SetA);
            Assert.AreEqual(into.Sets.Single(s => s.Name == "Structure").Id, test.SetB);
            Assert.AreEqual(0.01, test.Tolerance, 1e-9);
            Assert.IsNull(test.LastRunModel);
        }

        [TestMethod]
        public void UniqueName_CountsUp()
        {
            Assert.AreEqual("A", ClashSetupFiles.UniqueName("A", new[] { "B" }));
            Assert.AreEqual("A (3)", ClashSetupFiles.UniqueName("A", new[] { "a", "A (2)" }));
        }
    }
}
