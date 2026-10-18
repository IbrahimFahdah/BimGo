using System;
using System.Collections.Generic;
using System.Linq;
using System.Xml.Linq;
using BimGo.Clashes;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Clash reports (Round C, build C-C3): sections (groups in order of first appearance, ungrouped last), the pictures
    /// wanted per group mode, the HTML (escaping, embedded pictures, compact groups, numbering) and the Navisworks-style
    /// XML (structure, groups, negative crossing distance, control characters dropped). Expectations worked out by hand.
    /// </summary>
    [TestClass]
    public sealed class ClashReportTests
    {
        private static readonly DateTime T0 = new(2026, 10, 17, 0, 0, 0, DateTimeKind.Utc);

        private static (ClashDocument Document, ClashTest Test, ClashRecord C1, ClashRecord C2, ClashRecord C3, ClashGroup Group) Sample()
        {
            var document = new ClashDocument();
            var set = new SearchSet { Name = "MEP" };
            document.Sets.Add(set);
            var test = new ClashTest { Name = "MEP vs MEP", SetA = set.Id };
            document.Tests.Add(test);
            ClashRecord Make(string a, string b, double depth, string level) => new()
            {
                TestId = test.Id,
                A = new ClashElementRef { UniqueId = a, ElementId = 100, Category = "Ducts", FamilyType = "<Duct & Co>", Level = level },
                B = new ClashElementRef { UniqueId = b, ElementId = 200, Category = "Pipes", FamilyType = "Pipe", Level = level },
                Crossing = true, Distance = depth, X = 1, Y = 2, Z = 3
            };
            ClashRecord c1 = Make("a1", "b1", 0.032, "Level 1"), c2 = Make("a2", "b2", 0.01, "Level 1"), c3 = Make("a3", "b3", 0.02, "Level 2");
            document.Clashes.AddRange(new[] { c1, c2, c3 });
            ClashGroup group = ClashGroups.Create(document, test.Id, new[] { c2, c1 }, "Riser", null, null, "gavin", T0, out _);
            return (document, test, c1, c2, c3, group);
        }

        [TestMethod]
        public void Sections_GroupsByFirstAppearance_LooseLast_NoneIsOne()
        {
            (ClashDocument document, _, ClashRecord c1, ClashRecord c2, ClashRecord c3, ClashGroup group) = Sample();
            var order = new[] { c3, c1, c2 };

            List<ClashReportSection> sections = ClashReports.Sections(document, order, ClashReportGroups.SECTIONS);
            Assert.AreEqual(2, sections.Count);
            Assert.AreSame(group, sections[0].Group, "the group first, though c3 came first");
            CollectionAssert.AreEqual(new[] { c1, c2 }, sections[0].Clashes, "members in the given order");
            Assert.IsNull(sections[1].Group);
            CollectionAssert.AreEqual(new[] { c3 }, sections[1].Clashes);

            List<ClashReportSection> none = ClashReports.Sections(document, order, ClashReportGroups.NONE);
            Assert.AreEqual(1, none.Count);
            CollectionAssert.AreEqual(order, none[0].Clashes);
        }

        [TestMethod]
        public void Pictures_PerGroupMode()
        {
            (ClashDocument document, _, ClashRecord c1, ClashRecord c2, ClashRecord c3, ClashGroup group) = Sample();
            var order = new[] { c1, c2, c3 };
            CollectionAssert.AreEqual(new[] { group.Id, c1.Id, c2.Id, c3.Id },
                ClashReports.Pictures(document, order, ClashReportGroups.SECTIONS).Select(p => p.Id).ToList());
            CollectionAssert.AreEqual(new[] { group.Id, c3.Id },
                ClashReports.Pictures(document, order, ClashReportGroups.COMPACT).Select(p => p.Id).ToList(), "compact: the group is one item");
            CollectionAssert.AreEqual(new[] { c1.Id, c2.Id, c3.Id },
                ClashReports.Pictures(document, order, ClashReportGroups.NONE).Select(p => p.Id).ToList());
        }

        [TestMethod]
        public void Html_Escapes_EmbedsPictures_CompactGroups()
        {
            (ClashDocument document, _, ClashRecord c1, ClashRecord c2, ClashRecord c3, ClashGroup group) = Sample();
            var order = new[] { c1, c2, c3 };
            var options = new ClashReportOptions { ModelTitle = "Tower", Author = "gavin", Generator = "BimGo test", ScopeLabel = "This test", Created = new DateTime(2026, 10, 17, 9, 30, 0) };
            var pictures = new Dictionary<string, byte[]> { [c3.Id] = new byte[] { 0xFF, 0xD8, 0xFF } };

            string html = ClashReports.Html(document, order, options, pictures);
            StringAssert.StartsWith(html, "<!doctype html>");
            Assert.IsTrue(html.Contains("&lt;Duct &amp; Co&gt;"), "names escaped");
            Assert.IsFalse(html.Contains("<Duct & Co>"));
            Assert.IsTrue(html.Contains("data:image/jpeg;base64,/9j/"), "the picture embedded");
            Assert.IsTrue(html.Contains("CLASH 1") && html.Contains("CLASH 2") && html.Contains("CLASH 3"));
            Assert.IsTrue(html.Contains("Riser"));
            Assert.IsTrue(html.Contains("Ungrouped clashes"));
            Assert.IsTrue(html.Contains("2026-10-17 09:30"));

            options.GroupMode = ClashReportGroups.COMPACT;
            string compact = ClashReports.Html(document, order, options, pictures);
            Assert.IsFalse(compact.Contains("CLASH 1<"), "members aren't listed");
            Assert.IsTrue(compact.Contains("CLASH 3<"), "numbering counts the group's members");
            Assert.IsTrue(compact.Contains("Category pairs"));
            Assert.IsTrue(compact.Contains("Ducts × Pipes (2)") || compact.Contains("Ducts &#215; Pipes (2)"), "HtmlEncode may write × as an entity");
            Assert.IsTrue(compact.Contains("Deepest"));
            Assert.AreEqual(group.Count, 2);
        }

        [TestMethod]
        public void Xml_NavisworksShape_GroupsAndDistances()
        {
            (ClashDocument document, ClashTest test, ClashRecord c1, ClashRecord c2, ClashRecord c3, ClashGroup group) = Sample();
            group.Notes = "Check\u0001 with structure";
            byte[] bytes = ClashReports.Xml(document, new[] { c1, c2, c3 }, new ClashReportOptions { ModelTitle = "Tower" },
                new Dictionary<string, string> { [c3.Id] = "Move the pipe" });
            XDocument xml = XDocument.Parse(System.Text.Encoding.UTF8.GetString(bytes));

            XElement clashtest = xml.Root.Element("batchtest").Element("clashtests").Elements("clashtest").Single();
            Assert.AreEqual("MEP vs MEP", (string)clashtest.Attribute("name"));
            Assert.AreEqual("3", (string)clashtest.Element("summary").Attribute("total"));
            Assert.AreEqual("lcop_selection_set_tree/MEP", (string)clashtest.Element("right").Element("clashselection").Element("locator"), "a self test: A on both sides");

            XElement results = clashtest.Element("clashresults");
            XElement clashgroup = results.Elements("clashgroup").Single();
            Assert.AreEqual("Riser", (string)clashgroup.Attribute("name"));
            Assert.AreEqual(2, clashgroup.Element("clashresults").Elements("clashresult").Count());
            Assert.AreEqual("Check with structure", (string)clashgroup.Element("comments").Element("comment").Element("body"), "control character dropped");

            XElement loose = results.Elements("clashresult").Single();
            Assert.AreEqual("Clash3", (string)loose.Attribute("name"));
            Assert.AreEqual("-0.02", (string)loose.Attribute("distance"), "a crossing's depth is negative");
            Assert.AreEqual("Move the pipe", (string)loose.Element("comments").Element("comment").Element("body"));
            Assert.AreEqual("Level 2", (string)loose.Element("gridlocation"));
            Assert.AreEqual(2, loose.Element("clashobjects").Elements("clashobject").Count());
            Assert.AreEqual("200", (string)loose.Element("clashobjects").Elements("clashobject").Last().Element("objectattribute").Element("value"));
        }

        [TestMethod]
        public void CountBy_MostFirst_TiesByKey()
        {
            (_, _, ClashRecord c1, ClashRecord c2, ClashRecord c3, _) = Sample();
            List<(string Key, int Count)> levels = ClashReports.CountBy(new[] { c3, c1, c2 }, ClashGrouping.LevelOf);
            Assert.AreEqual(("Level 1", 2), levels[0]);
            Assert.AreEqual(("Level 2", 1), levels[1]);
            Assert.AreEqual("2 new, 1 active", ClashReports.StatusCounts(new[] { 2, 1, 0, 0, 0 }));
        }
    }
}
