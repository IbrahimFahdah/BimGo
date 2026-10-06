using System.Collections.Generic;
using System.Linq;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Settings sanitising and the per-model link choices. Never touches the real settings.json
    /// (<see cref="LaunchSettings.LoadOrDefault"/> / <see cref="LaunchSettings.Save"/> are not called).
    /// </summary>
    [TestClass]
    public sealed class LaunchSettingsTests
    {
        [TestMethod]
        public void Sanitise_ClampsNumbersToTheirRanges()
        {
            var settings = new LaunchSettings
            {
                TriangleThreshold = 5, Msaa = 3, MouseSensitivity = 10f, FieldOfView = 10f, MaxStepHeightMm = 1000f,
                SnapMoveMm = 60f, SnapAngleDeg = 40f
            };
            settings.Sanitise();

            Assert.AreEqual(100, settings.TriangleThreshold);
            Assert.AreEqual(2, settings.Msaa);
            Assert.AreEqual(3f, settings.MouseSensitivity);
            Assert.AreEqual(60f, settings.FieldOfView);
            Assert.AreEqual(450f, settings.MaxStepHeightMm);
            Assert.AreEqual(50f, settings.SnapMoveMm);
            Assert.AreEqual(45f, settings.SnapAngleDeg);
        }

        [TestMethod]
        public void Sanitise_MsaaSnapsToOffTwoOrFour()
        {
            foreach ((int input, int expected) in new[] { (-1, 0), (0, 0), (1, 0), (2, 2), (3, 2), (4, 4), (16, 4) })
            {
                var settings = new LaunchSettings { Msaa = input };
                settings.Sanitise();
                Assert.AreEqual(expected, settings.Msaa, $"MSAA {input}");
            }
        }

        [TestMethod]
        public void AmbientOcclusion_OnByDefaultAndForOlderSettingsFiles()
        {
            Assert.IsTrue(new LaunchSettings().AmbientOcclusion);

            // A settings.json written before the setting existed has no AmbientOcclusion key: it stays on
            LaunchSettings older = System.Text.Json.JsonSerializer.Deserialize<LaunchSettings>("{\"Msaa\":2}");
            Assert.IsTrue(older.AmbientOcclusion);

            LaunchSettings off = System.Text.Json.JsonSerializer.Deserialize<LaunchSettings>("{\"AmbientOcclusion\":false}");
            Assert.IsFalse(off.AmbientOcclusion);
        }

        [TestMethod]
        public void Sanitise_RepairsNullsAndUndefinedEnums()
        {
            var settings = new LaunchSettings
            {
                EnabledCategories = null, ExtraParameters = null, LinkedModels = null, HelperSubcategoryKeywords = null,
                ExistingPhase = null, NewPhase = "  New Construction ",
                ShadowQuality = (ShadowQuality)99, CoordinateReadout = (CoordinateReadout)99
            };
            settings.Sanitise();

            CollectionAssert.AreEqual(CategoryCatalog.DefaultEnabledKeys(), settings.EnabledCategories);
            Assert.AreEqual(0, settings.ExtraParameters.Count);
            Assert.IsNotNull(settings.LinkedModels);
            CollectionAssert.AreEqual(LaunchSettings.DefaultHelperKeywords(), settings.HelperSubcategoryKeywords);
            Assert.AreEqual(string.Empty, settings.ExistingPhase);
            Assert.AreEqual("New Construction", settings.NewPhase);
            Assert.AreEqual(ShadowQuality.Medium, settings.ShadowQuality);
            Assert.AreEqual(CoordinateReadout.Off, settings.CoordinateReadout);
        }

        [TestMethod]
        public void Sanitise_TrimsDeduplicatesAndCapsExtraParameters()
        {
            var names = new List<string> { " Mark ", "Mark", "", "  ", "Comments" };
            names.AddRange(Enumerable.Range(0, 40).Select(i => $"P{i}"));
            var settings = new LaunchSettings { ExtraParameters = names };
            settings.Sanitise();

            Assert.AreEqual(LaunchSettings.MAX_EXTRA_PARAMETERS, settings.ExtraParameters.Count);
            Assert.AreEqual("Mark", settings.ExtraParameters[0]);
            Assert.AreEqual("Comments", settings.ExtraParameters[1]);
        }

        [TestMethod]
        public void Sanitise_HelperKeywordsAreCaseInsensitiveUnique()
        {
            var settings = new LaunchSettings { HelperSubcategoryKeywords = new List<string> { "Zone", "zone", " cone ", "" } };
            settings.Sanitise();
            CollectionAssert.AreEqual(new[] { "Zone", "cone" }, settings.HelperSubcategoryKeywords);
        }

        [TestMethod]
        public void Sanitise_DropsEmptyLinkChoices()
        {
            var settings = new LaunchSettings
            {
                LinkedModels = new Dictionary<string, List<string>>
                {
                    ["host-a"] = new() { "link-1", "link-1", " " },
                    ["host-b"] = new(),
                    ["host-c"] = null
                }
            };
            settings.Sanitise();

            Assert.AreEqual(1, settings.LinkedModels.Count);
            CollectionAssert.AreEqual(new[] { "link-1" }, settings.LinkedModels["host-a"]);
        }

        [TestMethod]
        public void Links_DefaultIsNone()
        {
            var settings = new LaunchSettings();
            Assert.AreEqual(0, settings.LinksFor("unknown-model").Count);
            Assert.AreEqual(0, settings.LinksFor(null).Count);
        }

        [TestMethod]
        public void SetLinksFor_StoresPerModelAndClearsWhenEmpty()
        {
            var settings = new LaunchSettings();
            settings.SetLinksFor("host-a", new[] { "l1", "l2", "l1", "" });
            settings.SetLinksFor("host-b", new[] { "l9" });

            CollectionAssert.AreEqual(new[] { "l1", "l2" }, settings.LinksFor("host-a").ToArray());
            CollectionAssert.AreEqual(new[] { "l9" }, settings.LinksFor("host-b").ToArray());

            settings.SetLinksFor("host-a", new string[0]);
            Assert.AreEqual(0, settings.LinksFor("host-a").Count);
            Assert.IsFalse(settings.LinkedModels.ContainsKey("host-a"));
        }

        [TestMethod]
        public void SetLinksFor_StaysBounded()
        {
            var settings = new LaunchSettings();
            for (int i = 0; i < LaunchSettings.MAX_LINKED_MODEL_ENTRIES + 20; i++)
            {
                settings.SetLinksFor($"host-{i}", new[] { "link" });
            }
            Assert.AreEqual(LaunchSettings.MAX_LINKED_MODEL_ENTRIES, settings.LinkedModels.Count);
            Assert.AreEqual(1, settings.LinksFor($"host-{LaunchSettings.MAX_LINKED_MODEL_ENTRIES + 19}").Count, "The newest choice is kept");
            Assert.AreEqual(0, settings.LinksFor("host-0").Count, "The oldest choice is dropped");
            Assert.AreEqual(0, settings.LinksFor("host-19").Count, "The oldest choices are dropped");
            Assert.AreEqual(1, settings.LinksFor("host-20").Count);
        }

        [TestMethod]
        public void SetLinksFor_ReSettingAModelMakesItTheNewest()
        {
            var settings = new LaunchSettings();
            for (int i = 0; i < LaunchSettings.MAX_LINKED_MODEL_ENTRIES; i++)
            {
                settings.SetLinksFor($"host-{i}", new[] { "link" });
            }
            settings.SetLinksFor("host-0", new[] { "link" }); // used again: now the most recent
            settings.SetLinksFor("host-new", new[] { "link" });

            Assert.AreEqual(1, settings.LinksFor("host-0").Count);
            Assert.AreEqual(0, settings.LinksFor("host-1").Count, "host-1 is now the oldest");
            Assert.AreEqual(1, settings.LinksFor("host-new").Count);
        }

        [TestMethod]
        public void NearestStep_PicksTheClosest()
        {
            Assert.AreEqual(25f, LaunchSettings.NearestStep(LaunchSettings.SNAP_MOVE_STEPS_MM, 30f));
            Assert.AreEqual(1000f, LaunchSettings.NearestStep(LaunchSettings.SNAP_MOVE_STEPS_MM, 99999f));
            Assert.AreEqual(1f, LaunchSettings.NearestStep(LaunchSettings.SNAP_ANGLE_STEPS_DEG, -5f));
        }
    }
}
