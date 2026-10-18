using System.Collections.Generic;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// QOL round: the water / glass material overrides (keywords, the Water asset toggle, the see-through rule).
    /// </summary>
    [TestClass]
    public sealed class MaterialOverrideTests
    {
        private static SceneMaterial[] Sample() => new[]
        {
            new SceneMaterial { Name = "Pool Water", Schema = "WaterSchema", Water = true, WaterBump = 0.3f, Shine = 0.6f },  // 0: Water asset
            new SceneMaterial { Name = "Pond water", Schema = "PrismTransparentSchema", Water = true, SeeThrough = true, Shine = 0.6f }, // 1: see-through, by name
            new SceneMaterial { Name = "Water Heater", Schema = "PrismMetalSchema", Shine = 0.5f },                         // 2: opaque, named water
            new SceneMaterial { Name = "Spa", Schema = "GlazingSchema", Reflectivity = 0.08f },                               // 3: old-file glass (no flag)
            new SceneMaterial { Name = "Concrete", Schema = "ConcreteSchema" }                                                // 4
        };

        private static SceneMaterial[] Copy(SceneMaterial[] source)
        {
            var copy = new SceneMaterial[source.Length];
            for (int i = 0; i < source.Length; i++) { copy[i] = source[i].Clean(); }
            return copy;
        }

        [TestMethod]
        public void ParseKeywords_TrimsSplitsAndDeduplicates()
        {
            List<string> keys = MaterialOverrides.ParseKeywords(" water, Pool ;; WATER ,  ");
            CollectionAssert.AreEqual(new[] { "water", "Pool" }, keys);
            Assert.AreEqual("water, Pool", MaterialOverrides.FormatKeywords(keys));
        }

        [TestMethod]
        public void Defaults_MatchTheExtractionRule()
        {
            SceneMaterial[] original = Sample(), target = Copy(original);
            int water = MaterialOverrides.ApplyWater(original, target, fromAsset: true, LaunchSettings.DefaultWaterKeywords(), keywordsOpaque: false);
            Assert.AreEqual(2, water);
            Assert.IsTrue(target[0].Water);
            Assert.AreEqual(0.3f, target[0].WaterBump, 1e-6f); // the asset's own ripples are kept
            Assert.IsTrue(target[1].Water);
            Assert.IsFalse(target[2].Water, "an opaque material named water stays opaque by default");
            Assert.IsFalse(target[3].Water);
        }

        [TestMethod]
        public void AssetOff_OnlyKeywordsMakeWater()
        {
            SceneMaterial[] original = Sample(), target = Copy(original);
            int water = MaterialOverrides.ApplyWater(original, target, fromAsset: false, new[] { "water" }, keywordsOpaque: false);
            Assert.AreEqual(1, water);
            Assert.IsFalse(target[0].Water, "the Water asset is see-through only by schema: \"Pool Water\" isn't flagged see-through");
            Assert.AreEqual(0f, target[0].WaterBump);
            Assert.AreEqual(0.6f, target[0].Shine, 1e-6f, "its sheen is kept");
            Assert.IsTrue(target[1].Water);
        }

        [TestMethod]
        public void Keywords_OldGlassAndOpaqueOption()
        {
            SceneMaterial[] original = Sample(), target = Copy(original);
            MaterialOverrides.ApplyWater(original, target, fromAsset: true, new[] { "spa" }, keywordsOpaque: false);
            Assert.IsTrue(target[3].Water, "old-file glass (reflectivity, no flag) counts as see-through");
            Assert.AreEqual(MaterialOverrides.KEYWORD_WATER_BUMP, target[3].WaterBump, 1e-6f);
            Assert.AreEqual(MaterialOverrides.KEYWORD_WATER_SHINE, target[3].Shine, 1e-6f);
            Assert.IsFalse(target[1].Water, "\"pond water\" no longer matches once the keyword list drops \"water\"");

            MaterialOverrides.ApplyWater(original, target, fromAsset: true, new[] { "heater" }, keywordsOpaque: true);
            Assert.IsTrue(target[2].Water);
            Assert.AreEqual(0.6f, target[2].Shine, 1e-6f); // max(0.5, 0.6)
            Assert.IsFalse(target[3].Water, "applying again starts from the originals");
            Assert.AreEqual(0f, target[3].Shine);
        }

        [TestMethod]
        public void Settings_SanitiseCleansKeywordLists()
        {
            var settings = new LaunchSettings { WaterKeywords = null, GlassKeywords = new List<string> { " glazing ", "", "GLAZING" } };
            settings.Sanitise();
            CollectionAssert.AreEqual(new[] { "water" }, settings.WaterKeywords);
            CollectionAssert.AreEqual(new[] { "glazing" }, settings.GlassKeywords);
            Assert.IsTrue(settings.WaterFromAsset);
        }
    }
}
