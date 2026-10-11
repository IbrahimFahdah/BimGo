using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Review tools round (B1): display units, the Measure gun's maths (area, perimeter, angle, triangulation) and the
    /// unmarked original kept beside a marked-up comment picture.
    /// </summary>
    [TestClass]
    public sealed class ReviewToolsTests
    {
        private static readonly byte[] MARKED = { 0xFF, 0xD8, 0xFF, 0xE0, 9, 9, 9, 0xFF, 0xD9 };
        private static readonly byte[] ORIGINAL = { 0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9 };

        #region Units

        [TestMethod]
        public void FeetInches_RoundsToEighthsAndReduces()
        {
            // 1.715 m = 67.52" → 5' 7 1/2"
            Assert.IsTrue(Units.FeetInches(1.715, out bool negative, out long feet, out int inches, out int numerator, out int denominator));
            Assert.IsFalse(negative);
            Assert.AreEqual(5, feet);
            Assert.AreEqual(7, inches);
            Assert.AreEqual(1, numerator);
            Assert.AreEqual(2, denominator);

            // 11 15/16" rounds up into the next foot
            Units.FeetInches((12 - 1.0 / 16 + 0.0001) * Units.METRES_PER_INCH, out _, out feet, out inches, out numerator, out denominator);
            Assert.AreEqual(1, feet);
            Assert.AreEqual(0, inches);
            Assert.AreEqual(0, numerator);
            Assert.AreEqual(1, denominator);

            // 3/8"
            Units.FeetInches(3.0 / 8 * Units.METRES_PER_INCH, out _, out feet, out inches, out numerator, out denominator);
            Assert.AreEqual(0, feet);
            Assert.AreEqual(0, inches);
            Assert.AreEqual(3, numerator);
            Assert.AreEqual(8, denominator);

            Assert.IsFalse(Units.FeetInches(double.NaN, out _, out _, out _, out _, out _));
        }

        [TestMethod]
        public void Length_FormatsEachSystem()
        {
            Assert.AreEqual("1.715 m", Units.Length(1.715, UnitSystem.Metric));
            Assert.AreEqual("1.72 m", Units.Length(1.716, UnitSystem.Metric, metricDecimals: 2));
            Assert.AreEqual("5' 7 1/2\"", Units.Length(1.715, UnitSystem.Imperial));
            Assert.AreEqual("5.627'", Units.Length(1.715, UnitSystem.Imperial, decimalFeet: true));
            Assert.AreEqual("5.63'", Units.Length(1.715, UnitSystem.Imperial, decimalFeet: true, metricDecimals: 2));
            Assert.AreEqual("−1' 0\"", Units.Length(-0.3048, UnitSystem.Imperial));
            Assert.AreEqual("0' 0\"", Units.Length(-0.0001, UnitSystem.Imperial), "a value that rounds to zero has no sign");
            Assert.AreEqual("−0.250 m", Units.Length(-0.25, UnitSystem.Metric));
            Assert.AreEqual("—", Units.Length(double.PositiveInfinity, UnitSystem.Metric));
        }

        [TestMethod]
        public void AreaAndCoordinates_Convert()
        {
            Assert.AreEqual("10.0 m²", Units.Area(10, UnitSystem.Metric));
            Assert.AreEqual("107.6 ft²", Units.Area(10, UnitSystem.Imperial));
            Assert.AreEqual("1000.000'", Units.Coordinate(304.8, UnitSystem.Imperial), "coordinates use decimal feet");
            Assert.AreEqual("304.800 m", Units.Coordinate(304.8, UnitSystem.Metric));
            Assert.AreEqual(1.0, Units.ToSquareFeet(1.0 / Units.SQFT_PER_SQM), 1e-12);
        }

        [TestMethod]
        public void Settings_KeepUnitsAndSanitiseUnknownOnes()
        {
            var settings = new LaunchSettings { DisplayUnits = UnitSystem.Imperial, DecimalFeet = true };
            LaunchSettings copy = settings.Clone();
            Assert.AreEqual(UnitSystem.Imperial, copy.DisplayUnits);
            Assert.IsTrue(copy.DecimalFeet);

            var odd = new LaunchSettings { DisplayUnits = (UnitSystem)42 };
            odd.Sanitise();
            Assert.AreEqual(UnitSystem.Metric, odd.DisplayUnits);
        }

        #endregion

        #region Measure maths

        [TestMethod]
        public void PolygonArea_SquareOnAnyPlane()
        {
            var floor = new List<Vector3> { new(0, 0, 3), new(2, 0, 3), new(2, 2, 3), new(0, 2, 3) };
            Assert.AreEqual(4.0, MeasureMath.PolygonArea(floor, Vector3.UnitZ), 1e-5);
            Assert.AreEqual(8.0, MeasureMath.Perimeter(floor), 1e-5);
            Assert.AreEqual(6.0, MeasureMath.Perimeter(floor, closed: false), 1e-5);

            // The same square on a wall (normal along -Y), clockwise from the wall's side
            var wall = new List<Vector3> { new(0, 5, 0), new(0, 5, 2), new(2, 5, 2), new(2, 5, 0) };
            Assert.AreEqual(4.0, MeasureMath.PolygonArea(wall, -Vector3.UnitY), 1e-5);

            // L shape (concave): 3 × 3 minus 2 × 2 = 5
            var l = new List<Vector3> { new(0, 0, 0), new(3, 0, 0), new(3, 1, 0), new(1, 1, 0), new(1, 3, 0), new(0, 3, 0) };
            Assert.AreEqual(5.0, MeasureMath.PolygonArea(l, Vector3.UnitZ), 1e-5);
        }

        [TestMethod]
        public void Triangulate_ConcaveOutlineCoversItsArea()
        {
            var l = new List<Vector3> { new(0, 0, 0), new(3, 0, 0), new(3, 1, 0), new(1, 1, 0), new(1, 3, 0), new(0, 3, 0) };
            var triangles = new List<int>();
            Assert.IsTrue(MeasureMath.Triangulate(l, Vector3.UnitZ, triangles));
            Assert.AreEqual((l.Count - 2) * 3, triangles.Count);
            double sum = 0;
            for (int i = 0; i < triangles.Count; i += 3)
            {
                Vector3 a = l[triangles[i]], b = l[triangles[i + 1]], c = l[triangles[i + 2]];
                sum += Vector3.Cross(b - a, c - a).Length() * 0.5;
            }
            Assert.AreEqual(5.0, sum, 1e-5, "the triangles add up to the outline's area (no triangle outside it)");

            // Clockwise input works too
            l.Reverse();
            Assert.IsTrue(MeasureMath.Triangulate(l, Vector3.UnitZ, triangles));
        }

        [TestMethod]
        public void Angle_AndRayPlane()
        {
            Assert.AreEqual(90.0, MeasureMath.AngleDegrees(new Vector3(1, 0, 0), Vector3.Zero, new Vector3(0, 0, 2)), 1e-4);
            Assert.AreEqual(180.0, MeasureMath.AngleDegrees(new Vector3(-1, 0, 0), Vector3.Zero, new Vector3(3, 0, 0)), 1e-4);
            Assert.AreEqual(45.0, MeasureMath.AngleDegrees(new Vector3(1, 1, 0), Vector3.Zero, new Vector3(1, 0, 0)), 1e-4);
            Assert.IsTrue(double.IsNaN(MeasureMath.AngleDegrees(Vector3.Zero, Vector3.Zero, Vector3.UnitX)));

            Assert.IsTrue(MeasureMath.RayPlane(new Vector3(0, 0, 5), -Vector3.UnitZ, new Vector3(9, 9, 1), Vector3.UnitZ, out Vector3 hit));
            Assert.AreEqual(1f, hit.Z, 1e-5f);
            Assert.IsFalse(MeasureMath.RayPlane(new Vector3(0, 0, 5), Vector3.UnitZ, Vector3.Zero, Vector3.UnitZ, out _), "plane behind the ray");
            Assert.IsFalse(MeasureMath.RayPlane(Vector3.Zero, Vector3.UnitX, Vector3.UnitZ, Vector3.UnitZ, out _), "parallel");
        }

        #endregion

        #region Markup originals

        [TestMethod]
        public void OriginalNames_AreValidAndDistinct()
        {
            string original = CommentSnapshots.OriginalNameFor("abc123");
            Assert.AreEqual("comments/abc123_original.jpg", original);
            Assert.IsTrue(CommentSnapshots.IsValidName(original));
            Assert.AreNotEqual(CommentSnapshots.NameFor("abc123"), original);
        }

        [TestMethod]
        public void Bimgo_KeepsTheUnmarkedOriginal()
        {
            using var folder = new TempFolder();
            BimGoDocument document = TestData.BuildDocument();
            CommentRecord comment = document.Comments.Comments[0];
            comment.Snapshot = CommentSnapshots.NameFor(comment.Id);
            comment.SnapshotData = MARKED;
            comment.SnapshotOriginal = CommentSnapshots.OriginalNameFor(comment.Id);
            comment.SnapshotOriginalData = ORIGINAL;

            string path = folder.File("markup.bimgo");
            Assert.IsTrue(BimGoWriter.Write(path, document, TestData.Writer, FileKinds.SAVE, out string error), error);
            CollectionAssert.Contains(TestData.EntryNames(path), comment.SnapshotOriginal);

            BimGoDocument read = BimGoReader.Read(path, new LaunchSettings(), out error);
            Assert.IsNotNull(read, error);
            CommentRecord back = read.Comments.Comments.Single();
            Assert.IsTrue(back.HasMarkup);
            CollectionAssert.AreEqual(MARKED, back.SnapshotData);
            CollectionAssert.AreEqual(ORIGINAL, back.SnapshotOriginalData);
        }

        [TestMethod]
        public void Clean_DropsAnOriginalWithoutAPicture()
        {
            var record = new CommentRecord { Text = "x", SnapshotOriginal = CommentSnapshots.OriginalNameFor("x") };
            record.Clean();
            Assert.IsNull(record.SnapshotOriginal, "an original only makes sense beside a picture");
            Assert.IsFalse(record.HasMarkup);
        }

        [TestMethod]
        public void ModelFolder_WritesAndReadsTheOriginalBesideThePicture()
        {
            using var folder = new TempFolder();
            string sidecar = folder.File(ModelFolders.COMMENTS_FILE);
            var record = new CommentRecord { Text = "marked", SnapshotData = MARKED, SnapshotDirty = true, SnapshotOriginalData = ORIGINAL, SnapshotOriginalDirty = true };
            record.Snapshot = CommentSnapshots.NameFor(record.Id);
            record.SnapshotOriginal = CommentSnapshots.OriginalNameFor(record.Id);
            var document = new CommentDocument { Comments = new List<CommentRecord> { record } };

            Assert.IsTrue(CommentFiles.Write(sidecar, document, out string error), error);
            Assert.IsTrue(File.Exists(Path.Combine(folder.Path, "comments", record.Id + "_original.jpg")), "the original is not removed as unused");
            Assert.IsFalse(record.SnapshotOriginalDirty);

            CommentDocument read = CommentFiles.Read(sidecar, out error);
            Assert.IsNotNull(read, error);
            CommentRecord back = read.Comments.Single();
            CollectionAssert.AreEqual(ORIGINAL, back.SnapshotOriginalData);
            CollectionAssert.AreEqual(MARKED, back.SnapshotData);
        }

        #endregion
    }
}
