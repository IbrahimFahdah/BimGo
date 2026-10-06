using System.Collections.Generic;
using System.Numerics;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// lighting.json (emissive runs and fixture lights), its validation, and the colour / strength helpers.
    /// </summary>
    [TestClass]
    public sealed class LightingTests
    {
        private static LightingData Sample() => new()
        {
            Emissive = new[]
            {
                new EmissiveRun(0, 3, LightingData.PackEmissive(new Vector3(1f, 0.9f, 0.8f), 2f)),
                new EmissiveRun(6, 3, LightingData.PackEmissive(Vector3.One, 1f))
            },
            Lights = new[]
            {
                new LightSource { Element = 1, Position = new Vector3(1, 2, 2.6f), Lumens = 1500f, Kelvin = 3000f, Downward = 0.8f },
                new LightSource { Element = 0, Position = new Vector3(4, 5, 2.4f), Lumens = 800f, Kelvin = 4000f, Downward = 0.2f, Estimated = true }
            }
        };

        private static BimGoDocument WriteAndRead(BimGoDocument document, TempFolder folder)
        {
            string path = folder.File("lit.bimgo");
            Assert.IsTrue(BimGoWriter.Write(path, document, TestData.Writer, FileKinds.SAVE, out string error), error);
            BimGoDocument read = BimGoReader.Read(path, new LaunchSettings(), out error);
            Assert.IsNotNull(read, error);
            return read;
        }

        [TestMethod]
        public void Lighting_RoundTrips()
        {
            using var folder = new TempFolder();
            LightingData lighting = Sample();
            BimGoDocument read = WriteAndRead(TestData.BuildDocument(lighting), folder);

            LightingData got = read.Scene.Lighting;
            CollectionAssert.AreEqual(lighting.Emissive, got.Emissive);
            Assert.AreEqual(2, got.Lights.Length);
            for (int i = 0; i < 2; i++)
            {
                Assert.AreEqual(lighting.Lights[i].Element, got.Lights[i].Element);
                Assert.AreEqual(lighting.Lights[i].Position, got.Lights[i].Position);
                Assert.AreEqual(lighting.Lights[i].Lumens, got.Lights[i].Lumens);
                Assert.AreEqual(lighting.Lights[i].Kelvin, got.Lights[i].Kelvin);
                Assert.AreEqual(lighting.Lights[i].Downward, got.Lights[i].Downward);
                Assert.AreEqual(lighting.Lights[i].Estimated, got.Lights[i].Estimated);
            }
        }

        [TestMethod]
        public void Lighting_AbsentIsEmptyAndNotWritten()
        {
            using var folder = new TempFolder();
            BimGoDocument read = WriteAndRead(TestData.BuildDocument(), folder);
            Assert.IsTrue(read.Scene.Lighting.IsEmpty);

            using var zip = System.IO.Compression.ZipFile.OpenRead(folder.File("lit.bimgo"));
            Assert.IsNull(zip.GetEntry("lighting.json"));
        }

        [TestMethod]
        public void Lighting_DamagedEntriesAreDropped()
        {
            using var folder = new TempFolder();
            string path = folder.File("damaged.bimgo");
            Assert.IsTrue(BimGoWriter.Write(path, TestData.BuildDocument(), TestData.Writer, FileKinds.SAVE, out string error), error);

            // Overlapping / out-of-range runs, lights on missing elements, out-of-range lumens
            string json = "{\"version\":1,\"emissive\":[[0,3,4294967295],[1,3,1],[8,5,1],[-1,2,1],[6,1,1]]," +
                "\"lights\":[{\"element\":7,\"position\":[0,0,0]},{\"element\":-1,\"position\":[0,0,0]},{\"element\":1,\"position\":[1,1,1],\"lumens\":1e9}]}";
            using (var zip = System.IO.Compression.ZipFile.Open(path, System.IO.Compression.ZipArchiveMode.Update))
            {
                using var writer = new System.IO.StreamWriter(zip.CreateEntry("lighting.json").Open());
                writer.Write(json);
            }

            BimGoDocument read = BimGoReader.Read(path, null, out error);
            Assert.IsNotNull(read, error);
            CollectionAssert.AreEqual(new[] { new EmissiveRun(0, 3, uint.MaxValue), new EmissiveRun(6, 1, 1) }, read.Scene.Lighting.Emissive);
            Assert.AreEqual(1, read.Scene.Lighting.Lights.Length);
            Assert.AreEqual(100000f, read.Scene.Lighting.Lights[0].Lumens);
        }

        [TestMethod]
        public void PackEmissive_NormalisesColourAndScalesStrength()
        {
            uint packed = LightingData.PackEmissive(new Vector3(0.5f, 0.25f, 0f), LightingData.MAX_STRENGTH);
            Assert.AreEqual(255u, packed & 0xFF);
            Assert.AreEqual(128u, (packed >> 8) & 0xFF);
            Assert.AreEqual(0u, (packed >> 16) & 0xFF);
            Assert.AreEqual(255u, packed >> 24);
            Assert.AreEqual(1u, LightingData.PackEmissive(Vector3.One, 0f) >> 24, "strength never packs to zero");
        }

        [TestMethod]
        public void StrengthFromLuminance_IsLogarithmicAndClamped()
        {
            Assert.AreEqual(0.5f, LightingData.StrengthFromLuminance(0f));
            Assert.AreEqual(2f, LightingData.StrengthFromLuminance(1000f), 1e-4f);
            Assert.AreEqual(LightingData.MAX_STRENGTH, LightingData.StrengthFromLuminance(1e9f));
        }

        [TestMethod]
        public void KelvinToRgb_WarmIsRedderThanCool()
        {
            Vector3 warm = LightingData.KelvinToRgb(2700f), cool = LightingData.KelvinToRgb(6500f);
            Assert.AreEqual(1f, warm.X, 1e-4f);
            Assert.IsTrue(warm.Z < 0.6f, $"2700 K blue {warm.Z}");
            Assert.IsTrue(cool.Z > 0.9f, $"6500 K blue {cool.Z}");
        }

        [TestMethod]
        public void Settings_LightingDefaultsAndSanitise()
        {
            var settings = new LaunchSettings();
            Assert.AreEqual(ArtificialLightMode.Lights, settings.ArtificialLights);
            Assert.AreEqual(1f, settings.ArtificialLightIntensity);
            Assert.AreEqual(1f, settings.BloomIntensity);
            CollectionAssert.Contains(settings.EmissiveKeywords, "lamp");

            settings.ArtificialLights = (ArtificialLightMode)9;
            settings.ArtificialLightIntensity = 7f;
            settings.BloomIntensity = -3f;
            settings.EmissiveKeywords = new List<string> { " LED ", "led", "", null };
            settings.Sanitise();
            Assert.AreEqual(ArtificialLightMode.Lights, settings.ArtificialLights);
            Assert.AreEqual(2f, settings.ArtificialLightIntensity);
            Assert.AreEqual(0f, settings.BloomIntensity);
            CollectionAssert.AreEqual(new List<string> { "LED" }, settings.EmissiveKeywords);
        }
    }
}
