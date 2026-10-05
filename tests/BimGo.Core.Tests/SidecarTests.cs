using System.Collections.Generic;
using System.IO;
using BimGo.Format;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// The sidecars kept beside a Revit model (comments, bookmarks, sun, visibility): naming, round-trips and the
    /// one-time RvtGo comment migration.
    /// </summary>
    [TestClass]
    public sealed class SidecarTests
    {
        [TestMethod]
        public void SidecarNames_SitBesideTheCommentsFile()
        {
            string comments = Path.Combine("C:", "Models", "Tower.bimgo-comments.json");
            string folder = Path.Combine("C:", "Models");
            Assert.AreEqual(Path.Combine(folder, "Tower.bimgo-bookmarks.json"), BookmarkFiles.SidecarFor(comments));
            Assert.AreEqual(Path.Combine(folder, "Tower.bimgo-sun.json"), SunFiles.SidecarFor(comments));
            Assert.AreEqual(Path.Combine(folder, "Tower.bimgo-visibility.json"), VisibilityFiles.SidecarFor(comments));
            Assert.AreEqual(Path.Combine(folder, "Tower.rvtgo.json"), CommentFiles.LegacyPathFor(comments));
            Assert.IsNull(BookmarkFiles.SidecarFor(null));
        }

        [TestMethod]
        public void Comments_RoundTripAndDropBlanks()
        {
            using var folder = new TempFolder();
            string path = folder.File("Tower.bimgo-comments.json");
            var document = new CommentDocument
            {
                Comments = new List<CommentRecord> { new() { Id = "a", Text = "Fix the handrail", ElementId = 9 }, new() { Text = "" } }
            };
            Assert.IsTrue(CommentFiles.Write(path, document, out string error), error);

            CommentDocument read = CommentFiles.Read(path, out error);
            Assert.IsNotNull(read, error);
            Assert.AreEqual(1, read.Comments.Count);
            Assert.AreEqual("Fix the handrail", read.Comments[0].Text);
            Assert.IsFalse(File.Exists(path + ".tmp"));
        }

        [TestMethod]
        public void Comments_MigrateFromRvtGoOnce()
        {
            using var folder = new TempFolder();
            string sidecar = folder.File("Tower.bimgo-comments.json");
            // RvtGo wrote PascalCase; reads are case-insensitive
            File.WriteAllText(folder.File("Tower.rvtgo.json"), "{\"Version\":1,\"Comments\":[{\"Id\":\"old\",\"Text\":\"From RvtGo\"}]}");

            Assert.IsTrue(CommentFiles.MigrateLegacy(sidecar));
            Assert.IsFalse(CommentFiles.MigrateLegacy(sidecar), "Only once: the new sidecar now exists");
            Assert.AreEqual("From RvtGo", CommentFiles.Read(sidecar, out _).Comments[0].Text);
        }

        [TestMethod]
        public void Bookmarks_RoundTripAndCleanBadEntries()
        {
            using var folder = new TempFolder();
            string path = folder.File("Tower.bimgo-bookmarks.json");
            var document = new BookmarkDocument
            {
                Bookmarks = new List<BookmarkRecord>
                {
                    new() { Id = "b1", Name = "", X = 1, Y = 2, Z = 3, Thumbnail = "AAAA" },
                    new() { Id = "bad", Name = "Broken", X = double.NaN }
                },
                Home = new BookmarkRecord { Id = "home", X = 0, Y = 0, Z = 1.7 }
            };
            Assert.IsTrue(BookmarkFiles.Write(path, document, out string error), error);

            BookmarkDocument read = BookmarkFiles.Read(path, out error);
            Assert.IsNotNull(read, error);
            Assert.AreEqual(1, read.Bookmarks.Count, "Non-finite positions are dropped");
            Assert.AreEqual("Viewpoint", read.Bookmarks[0].Name, "Blank names get a default");
            Assert.AreEqual("AAAA", read.Bookmarks[0].Thumbnail);
            Assert.AreEqual("home", read.Home.Id);
        }

        [TestMethod]
        public void SunAndVisibility_RoundTrip()
        {
            using var folder = new TempFolder();
            string sunPath = folder.File("Tower.bimgo-sun.json");
            string visibilityPath = folder.File("Tower.bimgo-visibility.json");

            Assert.IsTrue(SunFiles.Write(sunPath, new SunSettings { Enabled = true, SunIntensity = 1.5f, Time = new SunTime { Month = 7, Day = 1, Minutes = 480 } }, out string error), error);
            Assert.IsTrue(VisibilityFiles.Write(visibilityPath, new VisibilitySettings { HiddenCategories = new List<string> { "walls", "walls", " " } }, out error), error);

            SunSettings sun = SunFiles.Read(sunPath, out error);
            Assert.IsNotNull(sun, error);
            Assert.IsTrue(sun.Enabled);
            Assert.AreEqual(1.5f, sun.SunIntensity);
            Assert.AreEqual(480, sun.Time.Minutes);

            VisibilitySettings visibility = VisibilityFiles.Read(visibilityPath, out error);
            Assert.IsNotNull(visibility, error);
            CollectionAssert.AreEqual(new[] { "walls" }, visibility.HiddenCategories, "Cleaned: blanks and duplicates removed");
        }

        [TestMethod]
        public void MissingSidecar_IsNullWithoutError()
        {
            using var folder = new TempFolder();
            Assert.IsNull(SunFiles.Read(folder.File("none.json"), out string error));
            Assert.IsNull(error);
        }

        [TestMethod]
        public void DamagedSidecar_IsNullWithReason()
        {
            using var folder = new TempFolder();
            string path = folder.File("Tower.bimgo-bookmarks.json");
            File.WriteAllText(path, "{ damaged");
            Assert.IsNull(BookmarkFiles.Read(path, out string error));
            Assert.IsFalse(string.IsNullOrEmpty(error));
        }
    }
}
