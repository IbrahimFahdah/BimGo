using System.Collections.Generic;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Older files keep reading, newer ones are refused politely, damaged ones fail without throwing.
    /// The "older" files are hand-made with only the entries and fields the early (v3-era) writer produced:
    /// no links, phases, bookmarks, sun, visibility, site location or active view.
    /// </summary>
    [TestClass]
    public sealed class BimGoReaderCompatibilityTests
    {
        private const string OLD_MANIFEST = @"{
  ""format"": ""bimgo"",
  ""formatVersion"": 1,
  ""generator"": ""BimGo for Revit 2025"",
  ""generatorVersion"": ""0.3.0"",
  ""kind"": ""revit-export"",
  ""title"": ""Old Model"",
  ""createdUtc"": ""2026-10-05T00:00:00Z""
}";

        private const string OLD_MODEL = @"{
  ""originOffset"": [1, 2, 3],
  ""boundsMin"": [0, 0, 0],
  ""boundsMax"": [1, 1, 1],
  ""site"": { ""trueNorthAngle"": 0.1 },
  ""levels"": [ { ""name"": ""Ground"", ""elevation"": 0 } ],
  ""rooms"": [],
  ""categories"": [ { ""key"": ""walls"", ""loaded"": true, ""count"": 1 }, { ""key"": ""retired-category"", ""loaded"": true, ""count"": 1 } ]
}";

        private const string OLD_ELEMENTS = @"{""elements"":[
  {""id"":1,""uniqueId"":""u1"",""name"":""Wall"",""category"":0,""movable"":true,""boundsMin"":[0,0,0],""boundsMax"":[1,1,0],""opaque"":[0,3]},
  {""id"":2,""uniqueId"":""u2"",""name"":""Thing"",""category"":1,""boundsMin"":[0,0,0],""boundsMax"":[1,1,0],""opaque"":[0,3]}
]}";

        private static Dictionary<string, string> OldEntries(string manifest = OLD_MANIFEST, string elements = OLD_ELEMENTS) => new()
        {
            ["manifest.json"] = manifest,
            ["model.json"] = OLD_MODEL,
            ["elements.json"] = elements
        };

        [TestMethod]
        public void EarlyFile_WithOnlyTheOriginalEntries_Reads()
        {
            using var folder = new TempFolder();
            string path = folder.File("old.bimgo");
            TestData.WriteRawFile(path, OldEntries(), TestData.Triangle(), new uint[] { 0, 1, 2 });

            BimGoDocument document = BimGoReader.Read(path, null, out string error);

            Assert.IsNotNull(document, error);
            Assert.AreEqual("Old Model", document.Scene.ModelTitle);
            Assert.AreEqual(2, document.Scene.Elements.Length);
            Assert.AreEqual(0, document.Scene.Links.Length);
            Assert.AreEqual(0, document.Scene.Elements[0].Link);
            Assert.AreEqual(PhaseRole.Existing, document.Scene.Elements[0].Phase);
            Assert.AreEqual(-1L, document.Scene.PhaseId);
            Assert.IsNull(document.Scene.SourceView);
            Assert.AreEqual(0, document.Journal.Count);
            Assert.AreEqual(0, document.Comments.Comments.Count);
            Assert.IsTrue(document.Bookmarks.IsEmpty);
            Assert.IsNull(document.Sun);
            Assert.IsNull(document.Visibility);
            Assert.IsFalse(document.Scene.Site.HasLocation);
            Assert.AreEqual(1, document.ReadFormatVersion);
        }

        [TestMethod]
        public void EarlyFile_NonMovableElementGetsDefaultReason()
        {
            using var folder = new TempFolder();
            string path = folder.File("old.bimgo");
            TestData.WriteRawFile(path, OldEntries(), TestData.Triangle(), new uint[] { 0, 1, 2 });

            BimGoDocument document = BimGoReader.Read(path, null, out string error);
            Assert.IsNotNull(document, error);
            Assert.AreEqual("Not movable", document.Scene.Elements[1].MoveBlockReason);
        }

        [TestMethod]
        public void UnknownCategoryKey_ReadsAsGenericModels()
        {
            using var folder = new TempFolder();
            string path = folder.File("old.bimgo");
            TestData.WriteRawFile(path, OldEntries(), TestData.Triangle(), new uint[] { 0, 1, 2 });

            BimGoDocument document = BimGoReader.Read(path, null, out string error);
            Assert.IsNotNull(document, error);
            Assert.AreEqual(CategoryCatalog.Find("walls").Index, document.Scene.Elements[0].CategoryIndex);
            Assert.AreEqual(CategoryCatalog.Find(CategoryCatalog.KEY_GENERIC).Index, document.Scene.Elements[1].CategoryIndex);
        }

        [TestMethod]
        public void EarlyFile_SunFallsBackToAssumedSydney()
        {
            using var folder = new TempFolder();
            string path = folder.File("old.bimgo");
            TestData.WriteRawFile(path, OldEntries(), TestData.Triangle(), new uint[] { 0, 1, 2 });

            BimGoDocument document = BimGoReader.Read(path, null, out string error);
            Assert.IsNotNull(document, error);
            GeoLocation location = SolarPosition.LocationOf(document.Scene.Site, out bool known);
            Assert.IsFalse(known);
            Assert.AreEqual(GeoLocation.Fallback, location);
        }

        [TestMethod]
        public void NewerFormatVersion_IsRefusedWithUpdateMessage()
        {
            using var folder = new TempFolder();
            string path = folder.File("newer.bimgo");
            string manifest = OLD_MANIFEST.Replace("\"formatVersion\": 1", $"\"formatVersion\": {BimGoFormat.FORMAT_VERSION + 1}");
            TestData.WriteRawFile(path, OldEntries(manifest), TestData.Triangle(), new uint[] { 0, 1, 2 });

            Assert.IsNull(BimGoReader.Read(path, null, out string error));
            Assert.IsTrue(error.Contains("newer BimGo"), error);
        }

        [TestMethod]
        public void NewerGeometryLayout_IsRefused()
        {
            using var folder = new TempFolder();
            string path = folder.File("newer-geometry.bimgo");
            TestData.WriteRawFile(path, OldEntries(), TestData.Triangle(), new uint[] { 0, 1, 2 }, geometryVersion: 2);

            Assert.IsNull(BimGoReader.Read(path, null, out string error));
            Assert.IsTrue(error.Contains("newer BimGo"), error);
        }

        [TestMethod]
        public void NotABimGoFile_IsRefused()
        {
            using var folder = new TempFolder();
            string path = folder.File("other.bimgo");
            TestData.WriteRawFile(path, OldEntries(OLD_MANIFEST.Replace("\"bimgo\"", "\"something-else\"")), TestData.Triangle(), new uint[] { 0, 1, 2 });

            Assert.IsNull(BimGoReader.Read(path, null, out string error));
            Assert.AreEqual("This is not a BimGo model.", error);
        }

        [TestMethod]
        public void MissingGeometry_FailsWithReason()
        {
            using var folder = new TempFolder();
            string path = folder.File("no-geometry.bimgo");
            TestData.WriteRawFile(path, OldEntries(), null, null);

            Assert.IsNull(BimGoReader.Read(path, null, out string error));
            Assert.AreEqual("The file has no geometry.", error);
        }

        [TestMethod]
        public void MissingModelEntry_FailsWithReason()
        {
            using var folder = new TempFolder();
            string path = folder.File("incomplete.bimgo");
            var entries = OldEntries();
            entries.Remove("model.json");
            TestData.WriteRawFile(path, entries, TestData.Triangle(), new uint[] { 0, 1, 2 });

            Assert.IsNull(BimGoReader.Read(path, null, out string error));
            Assert.IsTrue(error.Contains("model.json"), error);
        }

        [TestMethod]
        public void IndexOutOfRange_IsReportedAsDamaged()
        {
            using var folder = new TempFolder();
            string path = folder.File("damaged.bimgo");
            TestData.WriteRawFile(path, OldEntries(), TestData.Triangle(), new uint[] { 0, 1, 9 });

            Assert.IsNull(BimGoReader.Read(path, null, out string error));
            Assert.IsTrue(error.Contains("index out of range"), error);
        }

        [TestMethod]
        public void BadElementRanges_AreClampedNotFatal()
        {
            using var folder = new TempFolder();
            string path = folder.File("ranges.bimgo");
            string elements = @"{""elements"":[
  {""id"":1,""category"":0,""opaque"":[0,99],""transparent"":[-3,3]},
  {""id"":2,""category"":0,""opaque"":[0,5]}
]}";
            TestData.WriteRawFile(path, OldEntries(elements: elements), TestData.Triangle(), new uint[] { 0, 1, 2, 2, 1, 0 });

            BimGoDocument document = BimGoReader.Read(path, null, out string error);
            Assert.IsNotNull(document, error);
            Assert.AreEqual(0, document.Scene.Elements[0].OpaqueCount);      // past the end: dropped
            Assert.AreEqual(0, document.Scene.Elements[0].TransparentCount); // negative start: dropped
            Assert.AreEqual(3, document.Scene.Elements[1].OpaqueCount);      // trimmed to whole triangles
            Assert.AreEqual("(unnamed)", document.Scene.Elements[0].Name);
        }

        [TestMethod]
        public void MissingFile_FailsWithReason()
        {
            using var folder = new TempFolder();
            Assert.IsNull(BimGoReader.Read(folder.File("nope.bimgo"), null, out string error));
            Assert.AreEqual("The file does not exist.", error);
        }

        [TestMethod]
        public void GarbageFile_FailsWithoutThrowing()
        {
            using var folder = new TempFolder();
            string path = folder.File("garbage.bimgo");
            System.IO.File.WriteAllText(path, "this is not a zip");

            Assert.IsNull(BimGoReader.Read(path, null, out string error));
            Assert.IsFalse(string.IsNullOrEmpty(error));
            Assert.IsNull(BimGoReader.ReadManifest(path, out error));
            Assert.IsFalse(string.IsNullOrEmpty(error));
        }
    }
}
