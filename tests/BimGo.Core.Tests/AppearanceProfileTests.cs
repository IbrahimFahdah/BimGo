using System;
using System.Collections.Generic;
using System.Linq;
using BimGo.Clashes;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Colour round A: parameter and phase rules in search sets, the extracted parameters' lookup, colour profiles by
    /// value and by set (codes, counts, unmatched looks, palettes, refreshed values) and their storage in visibility.json.
    /// </summary>
    [TestClass]
    public sealed class AppearanceProfileTests
    {
        #region Scene

        /// <summary>
        /// Four elements: two walls (Level 1, fire rating "60/60/60" and "-/120/120"), a door (Level 2, "60/60/60", a
        /// blank mark, new phase) and a linked column with no parameters; plus a library template (never coloured).
        /// </summary>
        private static SceneData Scene()
        {
            ElementRecord Element(string catalog, string familyType, string level, PhaseRole phase = PhaseRole.Existing, int link = 0, bool template = false)
            {
                CategoryDef def = CategoryCatalog.Find(catalog);
                return new ElementRecord
                {
                    CategoryIndex = def.Index,
                    CategoryName = def.Label,
                    FamilyType = familyType,
                    LevelName = level,
                    Phase = phase,
                    Link = link,
                    IsLibraryTemplate = template
                };
            }

            var builder = new ParameterTableBuilder();
            builder.Add("Fire Rating", "60/60/60");
            builder.Add("Mark", "W1");
            builder.Add("Width", "600 mm");
            builder.EndElement();
            builder.Add("Fire Rating", "-/120/120");
            builder.Add("Width", "1 200 mm");
            builder.EndElement();
            builder.Add("Fire Rating", "60/60/60");
            builder.Add("Mark", "  ");
            builder.Add("Width", "900 mm");
            builder.EndElement();
            builder.EndElement(); // the linked column has none
            builder.EndElement(); // the template

            return new SceneData
            {
                Vertices = Array.Empty<SceneVertex>(),
                Indices = Array.Empty<uint>(),
                Elements = new[]
                {
                    Element("walls", "Basic Wall: Fire 60", "Level 1"),
                    Element("walls", "Basic Wall: Fire 120", "Level 1"),
                    Element(CategoryCatalog.KEY_DOORS, "Single: 820", "Level 2", PhaseRole.New),
                    Element("structcolumns", "UC: 150", "Level 2", PhaseRole.Unphased, link: 1),
                    Element("walls", "Basic Wall: Fire 60", "Level 1", template: true)
                },
                Levels = new[] { new LevelInfo("Level 1", 0f), new LevelInfo("Level 2", 3f) },
                Links = new[] { new LinkInfo { Index = 1, Name = "Structure.rvt : 1", Title = "Structure", InstanceUniqueId = "link-uid" } },
                Parameters = builder.Build(),
                Settings = new LaunchSettings()
            };
        }

        private static SetRule Rule(string field, string op, string parameter, params string[] values) =>
            new SetRule { Field = field, Parameter = parameter, Op = op, Values = values.ToList() }.Normalise();

        #endregion

        #region Parameters and rules

        [TestMethod]
        public void ParameterTable_FindsNamesIgnoringCase()
        {
            ParameterTable table = Scene().Parameters;
            int fire = table.IndexOfName("fire rating");
            Assert.IsTrue(fire >= 0);
            Assert.AreEqual("60/60/60", table.ValueOf(0, fire));
            Assert.AreEqual("-/120/120", table.ValueOf(1, fire));
            Assert.IsNull(table.ValueOf(3, fire), "no row");
            Assert.AreEqual(-1, table.IndexOfName("Nope"));
            Assert.IsNull(table.ValueOf(0, -1));
            CollectionAssert.AreEqual(new[] { "Fire Rating", "Mark", "Width" }, table.SortedNames());
        }

        [TestMethod]
        public void SearchSets_ParameterAndPhaseRules()
        {
            SceneData scene = Scene();

            var is60 = new SearchSet { Rules = { Rule(RuleField.PARAMETER, RuleOp.IS, "Fire Rating", "60/60/60") } };
            CollectionAssert.AreEqual(new[] { 0, 2 }, SearchSets.ElementsIn(is60, scene));

            var contains120 = new SearchSet { Rules = { Rule(RuleField.PARAMETER, RuleOp.CONTAINS, "fire rating", "120") } };
            CollectionAssert.AreEqual(new[] { 1 }, SearchSets.ElementsIn(contains120, scene));

            var noMark = new SearchSet { Rules = { Rule(RuleField.PARAMETER, RuleOp.IS, "Mark", string.Empty) } };
            CollectionAssert.AreEqual(new[] { 1, 2, 3 }, SearchSets.ElementsIn(noMark, scene), "missing or blank = the empty value");

            var notNew = new SearchSet { Rules = { Rule(RuleField.PHASE, RuleOp.IS_NOT, null, "new") } };
            CollectionAssert.AreEqual(new[] { 0, 1, 3 }, SearchSets.ElementsIn(notNew, scene));

            var unphased = new SearchSet { Rules = { Rule(RuleField.PHASE, RuleOp.CONTAINS, null, "not phased") } };
            CollectionAssert.AreEqual(new[] { 3 }, SearchSets.ElementsIn(unphased, scene), "typed text matches the label too");

            // A stand-in (no index) sees no parameter value
            Assert.IsFalse(SearchSets.Matches(is60, scene, scene.Elements[0]));
            Assert.IsTrue(SearchSets.Matches(is60, scene, scene.Elements[0], 0));
        }

        [TestMethod]
        public void SetRule_ParameterIsKeptOnlyForParameterRules()
        {
            SetRule rule = Rule(RuleField.PARAMETER, RuleOp.IS, " Fire Rating ", "60/60/60");
            Assert.AreEqual(RuleField.PARAMETER, rule.Field);
            Assert.AreEqual("Fire Rating", rule.Parameter);
            Assert.AreEqual("Fire Rating", SearchSets.FieldLabel(rule));
            Assert.IsTrue(rule.IsField(RuleField.PARAMETER, "fire rating"));
            Assert.IsFalse(rule.IsField(RuleField.PARAMETER, "Mark"));
            Assert.AreEqual("Fire Rating", rule.Copy().Parameter);

            rule.SetField(RuleField.LEVEL);
            Assert.IsNull(rule.Parameter);
            Assert.AreEqual(0, rule.ValueCount);
            Assert.AreEqual("Level", SearchSets.FieldLabel(rule));
            Assert.AreEqual(RuleField.PARAMETER, RuleField.Normalise("Parameter"));
            Assert.AreEqual(RuleField.PHASE, RuleField.Normalise("phase"));
        }

        [TestMethod]
        public void SearchSets_ValuesOfParametersAndPhases()
        {
            SceneData scene = Scene();
            List<RuleValue> fire = SearchSets.ValuesOf(scene, RuleField.PARAMETER, "Fire Rating");
            CollectionAssert.AreEquivalent(new[] { "(no value)", "-/120/120", "60/60/60" }, fire.Select(v => v.Label).ToArray());
            Assert.AreEqual(2, fire.Single(v => v.Value == "60/60/60").Count);
            Assert.AreEqual(1, fire.Single(v => v.Value.Length == 0).Count, "the linked column has none");

            List<RuleValue> phases = SearchSets.ValuesOf(scene, RuleField.PHASE);
            CollectionAssert.AreEqual(new[] { "Existing", "New", "Not phased" }, phases.Select(v => v.Label).ToArray());
            Assert.AreEqual(2, phases[0].Count, "the template is left out");
            Assert.AreEqual("New", SearchSets.ValueLabel(RuleField.PHASE, "new", false, scene));
            Assert.AreEqual("(no value)", SearchSets.ValueLabel(RuleField.PARAMETER, string.Empty, false, scene));
        }

        [TestMethod]
        public void ClashFiles_KeepTheParameterRule()
        {
            var document = new ClashDocument();
            document.Sets.Add(new SearchSet { Name = "Rated", Rules = { Rule(RuleField.PARAMETER, RuleOp.IS_ONE_OF, "Fire Rating", "60/60/60", "-/120/120") } });
            ClashDocument read = ClashFiles.Parse(ClashFiles.Serialize(document), out string error);
            Assert.IsNull(error);
            SetRule rule = read.Sets.Single().Rules.Single();
            Assert.AreEqual(RuleField.PARAMETER, rule.Field);
            Assert.AreEqual("Fire Rating", rule.Parameter);
            Assert.AreEqual(2, rule.ValueCount);
        }

        #endregion

        #region Profiles

        [TestMethod]
        public void ByValue_RowsCodesAndCounts()
        {
            SceneData scene = Scene();
            AppearanceProfile profile = AppearanceProfiler.NewByValue("Levels", RuleField.LEVEL, null, scene);
            CollectionAssert.AreEqual(new[] { "Level 1", "Level 2" }, profile.Rules.Select(r => r.Value).ToArray());
            Assert.AreEqual(AppearanceProfiler.PaletteColour(AppearanceProfiler.PALETTE_BRIGHT, 0), profile.Rules[0].Colour);

            profile.Rules[0].Colour = "#FF0000";
            profile.Rules[1].On = false;
            ProfileResult result = AppearanceProfiler.Evaluate(profile, scene, null);
            Assert.AreEqual(AppearanceProfiler.Pack(0xFF0000, AppearanceProfiler.CODE_COLOUR), result.Codes[0]);
            Assert.AreEqual(0xFF0000FFu, result.Codes[0], "R in the low byte, the code in the high byte");
            Assert.AreEqual((uint)AppearanceProfiler.CODE_GHOST << 24, result.Codes[2], "an off row leaves its elements unmatched");
            Assert.AreEqual(0u, result.Codes[4], "templates keep their look");
            CollectionAssert.AreEqual(new[] { 2, 2 }, result.RuleCounts, "counts include off rows (the legend shows them)");
            Assert.AreEqual(2, result.Unmatched);
            Assert.IsTrue(result.AnyGhost);

            profile.Unmatched = UnmatchedLook.NORMAL;
            result = AppearanceProfiler.Evaluate(profile, scene, null);
            Assert.AreEqual(0u, result.Codes[2]);
            Assert.IsFalse(result.AnyGhost);

            profile.Unmatched = UnmatchedLook.FLAT;
            profile.UnmatchedColour = "#102030";
            result = AppearanceProfiler.Evaluate(profile, scene, null);
            Assert.AreEqual(AppearanceProfiler.Pack(0x102030, AppearanceProfiler.CODE_COLOUR), result.Codes[2]);
        }

        [TestMethod]
        public void ByValue_ParameterAndRefresh()
        {
            SceneData scene = Scene();
            AppearanceProfile profile = AppearanceProfiler.NewByValue("Fire", RuleField.PARAMETER, "Fire Rating", scene);
            Assert.AreEqual(3, profile.Rules.Count);
            Assert.AreEqual("(no value)", profile.Rules.Single(r => r.Value.Length == 0).Label);
            Assert.AreEqual("By Fire Rating · 3 values", AppearanceProfiler.Describe(profile));

            ProfileResult result = AppearanceProfiler.Evaluate(profile, scene, null);
            Assert.AreEqual(0, result.Unmatched, "every element has a value, empty included");
            Assert.AreEqual(2, result.RuleCounts[profile.Rules.FindIndex(r => r.Value == "60/60/60")]);
            Assert.AreEqual(1, result.RuleCounts[profile.Rules.FindIndex(r => r.Value.Length == 0)]);

            // A refresh keeps edited rows, adds new values only, and keeps rows for values that are gone
            profile.Rules.Single(r => r.Value == "60/60/60").Colour = "#00FF00";
            profile.Rules.Add(new ProfileRule { Value = "Gone", Label = "Gone", Colour = "#123456" });
            profile.Rules.RemoveAll(r => r.Value == "-/120/120");
            Assert.AreEqual(1, AppearanceProfiler.SyncValues(profile, scene));
            Assert.AreEqual("#00FF00", profile.Rules.Single(r => r.Value == "60/60/60").Colour);
            Assert.IsTrue(profile.Rules.Any(r => r.Value == "Gone"));
            Assert.AreEqual(4, profile.Rules.Count);

            // A new field replaces the rows
            AppearanceProfiler.SetField(profile, RuleField.PHASE, null, scene);
            CollectionAssert.AreEqual(new[] { "existing", "new", "unphased" }, profile.Rules.Select(r => r.Value).ToArray());
            Assert.IsNull(profile.Parameter);
        }

        [TestMethod]
        public void BySet_FirstMatchWinsAndMissingSets()
        {
            SceneData scene = Scene();
            SearchSet walls = SearchSets.SetOfCatalog("Walls", new[] { "walls" });
            SearchSet levelOne = new SearchSet { Name = "Level 1", Rules = { Rule(RuleField.LEVEL, RuleOp.IS, null, "Level 1") } };
            var sets = new Dictionary<string, SearchSet> { [walls.Id] = walls, [levelOne.Id] = levelOne };

            AppearanceProfile profile = AppearanceProfiler.NewBySet("Sets", new[] { walls, levelOne });
            profile.Rules.Add(new ProfileRule { SetId = "missing", Colour = "#000000" });
            ProfileResult result = AppearanceProfiler.Evaluate(profile, scene, id => sets.TryGetValue(id ?? string.Empty, out SearchSet s) ? s : null);
            CollectionAssert.AreEqual(new[] { 2, 0, 0 }, result.RuleCounts, "the walls are on Level 1 too: the first row wins");
            Assert.AreEqual(1, result.MissingSets);
            Assert.AreEqual(2, result.Unmatched);

            profile.Rules[0].On = false;
            result = AppearanceProfiler.Evaluate(profile, scene, id => sets.TryGetValue(id ?? string.Empty, out SearchSet s) ? s : null);
            CollectionAssert.AreEqual(new[] { 0, 2, 0 }, result.RuleCounts, "off: its elements fall through to the next row");
        }

        [TestMethod]
        public void Palettes_AreDistinctAndExtend()
        {
            foreach (string palette in AppearanceProfiler.PALETTES)
            {
                var colours = Enumerable.Range(0, 40).Select(i => AppearanceProfiler.PaletteColour(palette, i)).ToList();
                Assert.IsTrue(colours.All(c => LaunchSettings.TryParseColour(c, out _)), palette);
                Assert.AreEqual(12, colours.Take(12).Distinct().Count(), palette);
                Assert.IsTrue(colours.Distinct().Count() >= 36, palette + ": golden-angle hues beyond the twelve");
            }
            Assert.AreEqual(AppearanceProfiler.PALETTE_BRIGHT, AppearanceProfiler.NormalisePalette("nonsense"));

            AppearanceProfile profile = AppearanceProfiler.NewByValue("Levels", RuleField.LEVEL, null, Scene());
            AppearanceProfiler.ApplyPalette(profile, AppearanceProfiler.PALETTE_SOFT);
            Assert.AreEqual(AppearanceProfiler.PaletteColour(AppearanceProfiler.PALETTE_SOFT, 1), profile.Rules[1].Colour);
        }

        [TestMethod]
        public void Settings_CleanAndSaveInVisibility()
        {
            SceneData scene = Scene();
            var settings = new AppearanceSettings
            {
                Profiles =
                {
                    AppearanceProfiler.NewByValue("Levels", RuleField.LEVEL, null, scene),
                    null,
                    new AppearanceProfile { Name = "  ", Kind = "bySet", Unmatched = "odd", UnmatchedColour = "x", Detail = 5f, Rules = { new ProfileRule { Value = "v" }, new ProfileRule { SetId = "s", Colour = "#abcdef" } } }
                },
                Active = "unknown",
                On = true
            };
            settings.Clean();
            Assert.AreEqual(2, settings.Profiles.Count);
            Assert.AreEqual(settings.Profiles[0].Id, settings.Active, "an unknown active profile falls back to the first");
            AppearanceProfile odd = settings.Profiles[1];
            Assert.AreEqual("Profile", odd.Name);
            Assert.AreEqual(UnmatchedLook.GHOST, odd.Unmatched);
            Assert.AreEqual("#D6DADF", odd.UnmatchedColour);
            Assert.AreEqual(1f, odd.Detail);
            Assert.AreEqual(1, odd.Rules.Count, "a value row in a by-set profile goes");
            Assert.AreEqual("#ABCDEF", odd.Rules[0].Colour);

            using var folder = new TempFolder();
            string path = folder.File("visibility.json");
            var visibility = new VisibilitySettings { Appearance = settings };
            Assert.IsFalse(visibility.IsEmpty);
            Assert.IsTrue(VisibilityFiles.Write(path, visibility, out string error), error);
            VisibilitySettings read = VisibilityFiles.Read(path, out error);
            Assert.IsNull(error);
            Assert.AreEqual(2, read.Appearance.Profiles.Count);
            Assert.IsTrue(read.Appearance.On);
            Assert.AreEqual("Level 2", read.Appearance.Profiles[0].Rules[1].Value);

            Assert.IsTrue(new VisibilitySettings { Appearance = new AppearanceSettings() }.Clean().IsEmpty, "no profiles: nothing to save");
        }

        #endregion

        #region Build B: numbers, ranges, see-through, hide, files

        [TestMethod]
        public void RuleNumbers_ReadTheFirstNumber()
        {
            (string Text, double? Value)[] cases =
            {
                ("600 mm", 600), ("1 200 mm", 1200), ("1,200", 1200), ("2,5 m", 2.5), ("12.75", 12.75), ("60/60/60", 60),
                ("-/120/120", 120), ("-40 °C", -40), ("Level 2", 2), (".5", 0.5), ("Type A", null), ("", null), (null, null)
            };
            foreach ((string text, double? expected) in cases)
            {
                bool ok = RuleNumbers.TryParse(text, out double value);
                Assert.AreEqual(expected.HasValue, ok, text ?? "(null)");
                if (expected.HasValue) { Assert.AreEqual(expected.Value, value, 1e-9, text); }
            }
            CollectionAssert.AreEqual(new[] { 300d, 600d }, RuleNumbers.All("300 to 600"));
            CollectionAssert.AreEqual(new[] { 300d, 600d }, RuleNumbers.All("300-600"));
            CollectionAssert.AreEqual(new[] { 300d, -50d }, RuleNumbers.All("300 and -50"));
            Assert.AreEqual("1200.5", RuleNumbers.Format(1200.5));
        }

        [TestMethod]
        public void SearchSets_NumberOperators()
        {
            SceneData scene = Scene();
            var wide = new SearchSet { Rules = { Rule(RuleField.PARAMETER, RuleOp.AT_LEAST, "Width", "900") } };
            CollectionAssert.AreEqual(new[] { 1, 2 }, SearchSets.ElementsIn(wide, scene));
            var narrow = new SearchSet { Rules = { Rule(RuleField.PARAMETER, RuleOp.AT_MOST, "Width", "900") } };
            CollectionAssert.AreEqual(new[] { 0, 2 }, SearchSets.ElementsIn(narrow, scene), "no number: no match");
            var between = new SearchSet { Rules = { Rule(RuleField.PARAMETER, RuleOp.BETWEEN, "Width", "1000", "700") } };
            CollectionAssert.AreEqual(new[] { 2 }, SearchSets.ElementsIn(between, scene), "either order");
            var levels = new SearchSet { Rules = { Rule(RuleField.LEVEL, RuleOp.AT_LEAST, null, "2") } };
            CollectionAssert.AreEqual(new[] { 2, 3 }, SearchSets.ElementsIn(levels, scene), "built-in fields: their first number");

            SetRule rule = Rule(RuleField.PARAMETER, RuleOp.BETWEEN, "Width", "1", "2", "3");
            Assert.AreEqual(2, rule.ValueCount, "between keeps two values");
            Assert.IsFalse(Rule(RuleField.PARAMETER, RuleOp.AT_LEAST, "Width", "wide").IsComplete, "not a number");
            Assert.IsFalse(Rule(RuleField.PARAMETER, RuleOp.BETWEEN, "Width", "1").IsComplete);
            rule.SetOperator(RuleOp.IS);
            Assert.AreEqual(0, rule.ValueCount, "numbers and names don't carry over");
            Assert.AreEqual("Width is between 1 and 2", SearchSets.Describe(Rule(RuleField.PARAMETER, RuleOp.BETWEEN, "Width", "1", "2"), scene));
        }

        [TestMethod]
        public void Ranges_BinsColoursAndEvaluation()
        {
            SceneData scene = Scene();
            AppearanceProfile profile = AppearanceProfiler.NewByValue("Width", RuleField.PARAMETER, "Width", scene);
            profile.Bins = 3;
            Assert.AreEqual(3, AppearanceProfiler.BuildRanges(profile, scene), "three elements have a number");
            Assert.IsTrue(profile.Ranges);
            Assert.AreEqual(3, profile.Rules.Count);
            Assert.AreEqual(600, profile.Rules[0].From.Value, 1e-9);
            Assert.AreEqual(800, profile.Rules[0].To.Value, 1e-9);
            Assert.AreEqual(1200, profile.Rules[2].To.Value, 1e-9);
            Assert.AreEqual("600 – 800 mm", profile.Rules[0].Label);
            Assert.AreEqual(AppearanceProfiler.RampColour(AppearanceProfiler.RAMP_BLUE_RED, 0f), profile.Rules[0].Colour);
            Assert.AreEqual("#D7191C", profile.Rules[2].Colour, "the ramp's last stop");
            Assert.AreEqual("By Width · 3 ranges", AppearanceProfiler.Describe(profile));

            ProfileResult result = AppearanceProfiler.Evaluate(profile, scene, null);
            CollectionAssert.AreEqual(new[] { 1, 1, 1 }, result.RuleCounts, "600 | 900 | 1200");
            Assert.AreEqual(1, result.NoNumber);
            Assert.AreEqual(1, result.Unmatched);

            Assert.AreEqual(0, AppearanceProfiler.SyncValues(profile, scene), "ranges don't take value rows");
            AppearanceProfiler.ApplyRamp(profile, AppearanceProfiler.RAMP_LIGHT_DARK);
            Assert.AreEqual("#08306B", profile.Rules[2].Colour);

            // Saved and cleaned: range rows stay; turned back to values, they go
            AppearanceProfile copy = profile.Copy().Clean();
            Assert.AreEqual(3, copy.Rules.Count);
            copy.Ranges = false;
            copy.Clean();
            Assert.AreEqual(0, copy.Rules.Count);

            Assert.AreEqual(1, AppearanceProfiler.BuildRanges(new AppearanceProfile { Field = RuleField.PARAMETER, Parameter = "Mark" }, scene), "W1 reads as 1");
            var names = new AppearanceProfile { Field = RuleField.CATEGORY };
            Assert.AreEqual(0, AppearanceProfiler.BuildRanges(names, scene), "no numbers: no rows");
            Assert.AreEqual(0, names.Rules.Count);
        }

        [TestMethod]
        public void Rows_SeeThroughAndHiddenCodes()
        {
            SceneData scene = Scene();
            AppearanceProfile profile = AppearanceProfiler.NewByValue("Levels", RuleField.LEVEL, null, scene);
            profile.Unmatched = UnmatchedLook.NORMAL;
            profile.Rules[0].Transparency = 0.5f;
            profile.Rules[1].Hidden = true;
            ProfileResult result = AppearanceProfiler.Evaluate(profile, scene, null);
            uint seeThrough = result.Codes[0] >> 24;
            Assert.IsTrue(seeThrough >= AppearanceProfiler.CODE_SEE_THROUGH && seeThrough < AppearanceProfiler.CODE_COLOUR);
            Assert.AreEqual(0.5, (seeThrough - 128) / 126.0, 0.01, "opacity");
            Assert.AreEqual((uint)AppearanceProfiler.CODE_HIDDEN, result.Codes[2] >> 24);
            Assert.IsTrue(result.AnyBlended);
            Assert.IsTrue(result.AnyHidden);
            Assert.IsFalse(result.AnyGhost);

            profile.Rules[0].Transparency = 0f;
            profile.Rules[1].On = false;
            result = AppearanceProfiler.Evaluate(profile, scene, null);
            Assert.AreEqual((uint)AppearanceProfiler.CODE_COLOUR, result.Codes[0] >> 24);
            Assert.IsFalse(result.AnyBlended);
            Assert.IsFalse(result.AnyHidden, "an off row hides nothing");

            profile.Rules[0].Transparency = 5f;
            profile.Clean();
            Assert.AreEqual(AppearanceProfiler.MAX_TRANSPARENCY, profile.Rules[0].Transparency);
        }

        [TestMethod]
        public void ProfileFiles_ExportImportAndMergeSets()
        {
            SceneData scene = Scene();
            SearchSet walls = SearchSets.SetOfCatalog("Walls", new[] { "walls" });
            SearchSet doors = SearchSets.SetOfCatalog("Doors", new[] { CategoryCatalog.KEY_DOORS });
            var sets = new Dictionary<string, SearchSet> { [walls.Id] = walls, [doors.Id] = doors };
            AppearanceProfile bySet = AppearanceProfiler.NewBySet("Sets", new[] { walls, doors });
            bySet.Rules[1].Hidden = true;
            AppearanceProfile byValue = AppearanceProfiler.NewByValue("Levels", RuleField.LEVEL, null, scene);

            ProfileFile file = ProfileFiles.Build(new[] { bySet, byValue }, id => sets.TryGetValue(id ?? string.Empty, out SearchSet s) ? s : null, "Model", "BimGo test");
            Assert.AreEqual(2, file.Sets.Count);

            using var folder = new TempFolder();
            string path = folder.File("profiles.json");
            Assert.IsTrue(ProfileFiles.Export(path, file, out string error), error);
            ProfileFile read = ProfileFiles.Read(path, out error);
            Assert.IsNull(error);
            Assert.AreEqual(2, read.Profiles.Count);
            Assert.IsTrue(read.Profiles[0].Rules[1].Hidden);

            // Another model: it has "walls" (another id), not "Doors"; it already has a "Levels" profile
            var into = new AppearanceSettings { Profiles = { new AppearanceProfile { Name = "Levels" } } };
            var modelSets = new List<SearchSet> { SearchSets.SetOfCatalog("WALLS", new[] { "walls" }) };
            List<AppearanceProfile> added = ProfileFiles.Merge(read, into, modelSets, out int matched, out int setsAdded);
            Assert.AreEqual(2, added.Count);
            Assert.AreEqual(1, matched);
            Assert.AreEqual(1, setsAdded);
            Assert.AreEqual(2, modelSets.Count);
            Assert.AreEqual(modelSets[0].Id, added[0].Rules[0].SetId, "matched by name");
            Assert.AreEqual(modelSets[1].Id, added[0].Rules[1].SetId, "added with a new id");
            Assert.AreNotEqual(doors.Id, modelSets[1].Id);
            Assert.AreEqual("Levels (imported)", added[1].Name);
            Assert.AreNotEqual(byValue.Id, added[1].Id);

            Assert.IsNull(ProfileFiles.Parse(System.Text.Encoding.UTF8.GetBytes("{\"format\":\"bimgo-clash-sets\"}"), out error));
            Assert.IsNotNull(error);
        }

        [TestMethod]
        public void LinkValues_SameTitleReadAsInstanceNames()
        {
            SceneData scene = Scene();
            var two = new SceneData
            {
                Vertices = scene.Vertices,
                Indices = scene.Indices,
                Elements = new[]
                {
                    new ElementRecord { CategoryIndex = 0, CategoryName = "Walls", Link = 1 },
                    new ElementRecord { CategoryIndex = 0, CategoryName = "Walls", Link = 2 }
                },
                Levels = scene.Levels,
                Links = new[]
                {
                    new LinkInfo { Index = 1, Name = "Tower.rvt : 1", Title = "Tower", InstanceUniqueId = "a" },
                    new LinkInfo { Index = 2, Name = "Tower.rvt : 2", Title = "Tower", InstanceUniqueId = "b" }
                },
                Settings = new LaunchSettings()
            };
            CollectionAssert.AreEqual(new[] { "Tower.rvt : 1", "Tower.rvt : 2" }, SearchSets.ValuesOf(two, RuleField.LINK).Select(v => v.Label).ToArray());
        }

        #endregion

        [TestMethod]
        public void Ranges_EqualQuantileAndCustomEdges()
        {
            // Polish round P-C: 1 2 3 4 5 6 7 8 9 100 (one outlier)
            double[] numbers = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 100 };
            List<double> equal = AppearanceProfiler.RangeEdges(numbers, BinMethod.EQUAL, 4, null);
            CollectionAssert.AreEqual(new[] { 1, 25.75, 50.5, 75.25, 100 }, equal);

            // Equal count: the outlier no longer squeezes nine values into one range
            List<double> quantile = AppearanceProfiler.RangeEdges(numbers, BinMethod.QUANTILE, 4, null);
            Assert.AreEqual(1, quantile[0]);
            Assert.AreEqual(100, quantile[^1]);
            Assert.IsTrue(quantile.Count >= 4, string.Join(" ", quantile));
            for (int i = 1; i < quantile.Count; i++) { Assert.IsTrue(quantile[i] > quantile[i - 1], "ascending, no repeats"); }
            Assert.IsTrue(quantile[1] < 10 && quantile[^2] < 10, "the inner edges sit among the nine small values");

            // Many equal values: repeated edges merge (fewer ranges)
            List<double> ties = AppearanceProfiler.RangeEdges(new double[] { 5, 5, 5, 5, 5, 5, 9 }, BinMethod.QUANTILE, 4, null);
            CollectionAssert.AreEqual(new double[] { 5, 9 }, ties);

            // Custom: breaks inside the numbers' span only
            List<double> custom = AppearanceProfiler.RangeEdges(numbers, BinMethod.CUSTOM, 4, new[] { -5.0, 5.0, 50.0, 500.0 });
            CollectionAssert.AreEqual(new double[] { 1, 5, 50, 100 }, custom);
            CollectionAssert.AreEqual(new double[] { 1, 100 }, AppearanceProfiler.RangeEdges(numbers, BinMethod.CUSTOM, 4, null), "no breaks: one range");

            // All the same: one range
            CollectionAssert.AreEqual(new double[] { 7, 7 }, AppearanceProfiler.RangeEdges(new double[] { 7, 7 }, BinMethod.EQUAL, 5, null));
        }

        [TestMethod]
        public void Ranges_BreaksParseCleanAndRoundTrip()
        {
            CollectionAssert.AreEqual(new double[] { 300, 450, 600 }, AppearanceProfiler.ParseBreaks("600; 300 mm; 450"));
            CollectionAssert.AreEqual(new double[] { 1200, 1500 }, AppearanceProfiler.ParseBreaks("1,200, 1,500"));
            CollectionAssert.AreEqual(new double[] { 2.5, 7 }, AppearanceProfiler.ParseBreaks("7 2.5 7"));
            Assert.IsNull(AppearanceProfiler.ParseBreaks("none here"));
            Assert.AreEqual("300; 450.5", AppearanceProfiler.FormatBreaks(new[] { 300, 450.5 }));

            var profile = new AppearanceProfile { Ranges = true, Binning = "QUANTILE", Breaks = new List<double> { 3, double.NaN, 1, 3 } }.Clean();
            Assert.AreEqual(BinMethod.QUANTILE, profile.Binning);
            CollectionAssert.AreEqual(new double[] { 1, 3 }, profile.Breaks);
            Assert.AreEqual(BinMethod.EQUAL, new AppearanceProfile { Binning = "odd" }.Clean().Binning);
            AppearanceProfile copy = profile.Copy();
            copy.Breaks.Add(9);
            Assert.AreEqual(2, profile.Breaks.Count, "the copy's breaks are its own");
        }

        [TestMethod]
        public void Import_LinksAndLevelsMatchedByName()
        {
            // Polish round P-C: a set naming another model's link (by UniqueId) and a level spelt differently
            var file = new ProfileFile
            {
                Sets =
                {
                    new SearchSet
                    {
                        Name = "Linked services",
                        Rules =
                        {
                            new SetRule { Field = RuleField.LINK, Op = RuleOp.IS_ONE_OF, Values = { "uid-there", "uid-gone" } },
                            new SetRule { Field = RuleField.LEVEL, Op = RuleOp.IS_ONE_OF, Values = { "level 2", "Mezzanine" } }
                        }
                    }
                },
                Links =
                {
                    new ClashSetupLink { UniqueId = "uid-there", Name = "Services.rvt" },
                    new ClashSetupLink { UniqueId = "uid-gone", Name = "Old.rvt" }
                }
            };
            var links = new[] { new LinkInfo { Index = 1, Name = "Services.rvt", Title = "Services.rvt", InstanceUniqueId = "uid-here" } };
            ProfileReconcile result = ProfileFiles.Reconcile(file, links, new[] { "Level 1", "Level 2" });
            Assert.AreEqual(2, result.Matched, "the link by name, the level by its spelling here");
            CollectionAssert.AreEqual(new[] { "uid-here", "uid-gone" }, file.Sets[0].Rules[0].Values);
            CollectionAssert.AreEqual(new[] { "Level 2", "Mezzanine" }, file.Sets[0].Rules[1].Values);
            CollectionAssert.AreEquivalent(new[] { "Link: Old.rvt", "Level: Mezzanine" }, result.Missing);
        }
    }
}
