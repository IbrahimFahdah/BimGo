using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using BimGo.Clashes;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Clash detection (Round C, build C-A) on known geometry: closed boxes (optionally with subdivided faces, so large
    /// elements take the triangle-tree path), hard and clearance tests, skipped pairs, the model as walked, search sets,
    /// merging across runs, storage in a .bimgo and reports. The geometry cases were also checked in a Python port.
    /// </summary>
    [TestClass]
    public sealed class ClashTests
    {
        private const float HARD = 0.005f;

        #region Scene building

        /// <summary>One element for <see cref="Scene"/>: a box, its category key and identity.</summary>
        private sealed record BoxSpec(Vector3 Min, Vector3 Max, string Catalog = "ducts", long Id = 0, long HostId = 0, int Link = 0, int Subdivide = 1, string FamilyType = "Family: Type", string Level = "Level 1");

        /// <summary>
        /// A scene of closed boxes (outward normals; each face split n × n into two triangles per cell).
        /// </summary>
        private static SceneData Scene(params BoxSpec[] boxes)
        {
            var vertices = new List<SceneVertex>();
            var indices = new List<uint>();
            var elements = new List<ElementRecord>();
            for (int e = 0; e < boxes.Length; e++)
            {
                BoxSpec b = boxes[e];
                int start = indices.Count;
                AddBox(vertices, indices, b.Min, b.Max, b.Subdivide);
                CategoryDef def = CategoryCatalog.Find(b.Catalog);
                elements.Add(new ElementRecord
                {
                    ElementId = b.Id != 0 ? b.Id : 1000 + e,
                    UniqueId = $"uid-{e}",
                    HostId = b.HostId,
                    Name = b.Catalog,
                    CategoryName = def.Label,
                    FamilyType = b.FamilyType,
                    LevelName = b.Level,
                    CategoryIndex = def.Index,
                    OpaqueStart = start,
                    OpaqueCount = indices.Count - start,
                    Bounds = new Aabb(b.Min, b.Max),
                    Link = b.Link
                });
            }
            return new SceneData
            {
                Vertices = vertices.ToArray(),
                Indices = indices.ToArray(),
                Elements = elements.ToArray(),
                Levels = new[] { new LevelInfo("Level 1", 0f) },
                Links = new[] { new LinkInfo { Index = 1, Name = "Structure.rvt : 1", Title = "Structure", InstanceUniqueId = "link-uid" } },
                Bounds = new Aabb(new Vector3(-10), new Vector3(10)),
                OriginOffset = new Vector3(100, 200, 300),
                ModelTitle = "Clash Model",
                Settings = new LaunchSettings()
            };
        }

        private static void AddBox(List<SceneVertex> vertices, List<uint> indices, Vector3 min, Vector3 max, int n)
        {
            Vector3 d = max - min;
            void Face(Vector3 origin, Vector3 u, Vector3 v)
            {
                for (int i = 0; i < n; i++)
                {
                    for (int j = 0; j < n; j++)
                    {
                        Vector3 p = origin + u * (i / (float)n) + v * (j / (float)n);
                        Vector3 a = p + u / n, c = p + v / n, bb = a + v / n;
                        uint k = (uint)vertices.Count;
                        Vector3 normal = Vector3.Normalize(Vector3.Cross(u, v));
                        vertices.Add(new SceneVertex(p, normal, 0xFFFFFFFF));
                        vertices.Add(new SceneVertex(a, normal, 0xFFFFFFFF));
                        vertices.Add(new SceneVertex(bb, normal, 0xFFFFFFFF));
                        vertices.Add(new SceneVertex(c, normal, 0xFFFFFFFF));
                        indices.AddRange(new[] { k, k + 1, k + 2, k, k + 2, k + 3 });
                    }
                }
            }
            Face(min, new Vector3(0, d.Y, 0), new Vector3(d.X, 0, 0));                         // bottom
            Face(new Vector3(min.X, min.Y, max.Z), new Vector3(d.X, 0, 0), new Vector3(0, d.Y, 0)); // top
            Face(min, new Vector3(d.X, 0, 0), new Vector3(0, 0, d.Z));                         // −Y
            Face(new Vector3(min.X, max.Y, min.Z), new Vector3(0, 0, d.Z), new Vector3(d.X, 0, 0)); // +Y
            Face(min, new Vector3(0, 0, d.Z), new Vector3(0, d.Y, 0));                         // −X
            Face(new Vector3(max.X, min.Y, min.Z), new Vector3(0, d.Y, 0), new Vector3(0, 0, d.Z)); // +X
        }

        private static ClashItem[] Items(SceneData scene) => Enumerable.Range(0, scene.Elements.Length).Select(i => ClashItem.Static(scene, i)).ToArray();

        private static ClashRunResult Run(SceneData scene, int[] a, int[] b, string kind = ClashKind.HARD, float tolerance = HARD, ClashItem[] items = null) =>
            ClashEngine.Run(new ClashJob { Scene = scene, Items = items ?? Items(scene), SetA = a, SetB = b, Kind = kind, Tolerance = tolerance, Threads = 2 });

        private static readonly BoxSpec BEAM = new(new Vector3(0, 0, 2.6f), new Vector3(4, 0.3f, 3.0f), "framing");
        private static readonly BoxSpec DUCT = new(new Vector3(1.8f, -2, 2.7f), new Vector3(2.2f, 2, 2.9f), "ducts");

        #endregion

        #region Geometry

        [TestMethod]
        public void Geometry_CrossingTouchingAndDistance()
        {
            ClashTriangle t = ClashTriangle.Make(new Vector3(0, 0, 0), new Vector3(2, 0, 0), new Vector3(0, 2, 0));
            ClashTriangle crossing = ClashTriangle.Make(new Vector3(0.5f, 0.5f, -1), new Vector3(0.5f, 0.5f, 1), new Vector3(1.5f, 0.5f, 0));
            Assert.IsTrue(ClashGeometry.Crosses(t, crossing, out _, out _, out bool proper));
            Assert.IsTrue(proper);

            // Standing on the face: touches, never a proper crossing
            ClashTriangle standing = ClashTriangle.Make(new Vector3(0.5f, 0.5f, 0), new Vector3(0.6f, 0.5f, 1), new Vector3(0.5f, 0.6f, 1));
            if (ClashGeometry.Crosses(t, standing, out _, out _, out proper)) { Assert.IsFalse(proper); }

            // Coplanar: never crossing
            ClashTriangle coplanar = ClashTriangle.Make(new Vector3(0.2f, 0.2f, 0), new Vector3(1, 0.2f, 0), new Vector3(0.2f, 1, 0));
            Assert.IsFalse(ClashGeometry.Crosses(t, coplanar, out _, out _));

            // Parallel, 0.3 apart
            ClashTriangle above = ClashTriangle.Make(new Vector3(0, 0, 0.3f), new Vector3(2, 0, 0.3f), new Vector3(0, 2, 0.3f));
            Assert.AreEqual(0.3f, ClashGeometry.Distance(t, above, out _, out _), 1e-5f);
        }

        [TestMethod]
        public void Geometry_InsideClosedBox()
        {
            var vertices = new List<SceneVertex>();
            var indices = new List<uint>();
            AddBox(vertices, indices, Vector3.Zero, Vector3.One, 3);
            ClashTriangle[] mesh = Enumerable.Range(0, indices.Count / 3)
                .Select(k => ClashTriangle.Make(vertices[(int)indices[k * 3]].Position, vertices[(int)indices[k * 3 + 1]].Position, vertices[(int)indices[k * 3 + 2]].Position)).ToArray();
            Assert.IsTrue(ClashGeometry.Inside(new Vector3(0.5f), mesh));
            Assert.IsTrue(ClashGeometry.Inside(new Vector3(0.999f), mesh));
            Assert.IsFalse(ClashGeometry.Inside(new Vector3(1.5f, 0.5f, 0.5f), mesh));
        }

        #endregion

        #region Hard tests

        [TestMethod]
        public void Hard_DuctThroughBeam_DepthAndPoint()
        {
            SceneData scene = Scene(BEAM, DUCT);
            ClashRunResult result = Run(scene, new[] { 0 }, new[] { 1 });
            Assert.AreEqual(1, result.Hits.Count);
            ClashHit hit = result.Hits[0];
            Assert.AreEqual(0, hit.ItemA);
            Assert.IsTrue(hit.Crossing);
            Assert.AreEqual(0.2f, hit.Distance, 0.002f); // the duct's height is the narrowest width
            Assert.AreEqual(2f, hit.Point.X, 0.05f);
            Assert.AreEqual(0.15f, hit.Point.Y, 0.05f);
            Assert.AreEqual(2.8f, hit.Point.Z, 0.05f);
        }

        [TestMethod]
        public void Hard_TouchingAndShallow_FollowTheTolerance()
        {
            BoxSpec a = new(Vector3.Zero, Vector3.One, "framing");
            Assert.AreEqual(0, Run(Scene(a, new BoxSpec(new Vector3(1, 0, 0), new Vector3(2, 1, 1))), new[] { 0 }, new[] { 1 }).Hits.Count, "touching faces");

            SceneData overlap3mm = Scene(a, new BoxSpec(new Vector3(0.997f, 0, 0), new Vector3(2, 1, 1)));
            Assert.AreEqual(0, Run(overlap3mm, new[] { 0 }, new[] { 1 }).Hits.Count, "3 mm at 5 mm");
            ClashRunResult tight = Run(overlap3mm, new[] { 0 }, new[] { 1 }, tolerance: 0.001f);
            Assert.AreEqual(1, tight.Hits.Count, "3 mm at 1 mm");
            Assert.AreEqual(0.003f, tight.Hits[0].Distance, 0.0005f);
        }

        [TestMethod]
        public void Hard_PipeSunkIntoSlab_CountsByBuriedCorners()
        {
            BoxSpec pipe = new(new Vector3(0.5f, 1, 0.16f), new Vector3(3.5f, 1.1f, 0.26f), "pipes");
            foreach (int subdivide in new[] { 1, 8 }) // 8: 768 triangles, the triangle-tree path
            {
                BoxSpec slab = new(Vector3.Zero, new Vector3(4, 4, 0.2f), "floors", Subdivide: subdivide);
                ClashRunResult result = Run(Scene(slab, pipe), new[] { 0 }, new[] { 1 });
                Assert.AreEqual(1, result.Hits.Count, $"subdivide {subdivide}");
                Assert.AreEqual(0.04f, result.Hits[0].Distance, 0.002f);
            }

            BoxSpec shallow = new(new Vector3(0.5f, 1, 0.197f), new Vector3(3.5f, 1.1f, 0.3f), "pipes");
            Assert.AreEqual(0, Run(Scene(new BoxSpec(Vector3.Zero, new Vector3(4, 4, 0.2f), "floors"), shallow), new[] { 0 }, new[] { 1 }).Hits.Count);
        }

        [TestMethod]
        public void Hard_ContainedElementIsLeftOut()
        {
            SceneData scene = Scene(new BoxSpec(Vector3.Zero, new Vector3(4), "floors"), new BoxSpec(Vector3.One, new Vector3(2), "pipes"));
            Assert.AreEqual(0, Run(scene, new[] { 0 }, new[] { 1 }).Hits.Count);
        }

        #endregion

        #region Clearance

        [TestMethod]
        public void Clearance_GapsCrossingsAndTouching()
        {
            SceneData gap = Scene(new BoxSpec(Vector3.Zero, Vector3.One), new BoxSpec(new Vector3(1.03f, 0, 0), new Vector3(2, 1, 1)));
            ClashRunResult near = Run(gap, new[] { 0 }, new[] { 1 }, ClashKind.CLEARANCE, 0.05f);
            Assert.AreEqual(1, near.Hits.Count);
            Assert.IsFalse(near.Hits[0].Crossing);
            Assert.AreEqual(0.03f, near.Hits[0].Distance, 0.001f);
            Assert.AreEqual(0, Run(gap, new[] { 0 }, new[] { 1 }, ClashKind.CLEARANCE, 0.02f).Hits.Count);

            ClashRunResult crossing = Run(Scene(BEAM, DUCT), new[] { 0 }, new[] { 1 }, ClashKind.CLEARANCE, 0.05f);
            Assert.AreEqual(1, crossing.Hits.Count);
            Assert.IsTrue(crossing.Hits[0].Crossing);

            ClashRunResult touching = Run(Scene(new BoxSpec(Vector3.Zero, Vector3.One), new BoxSpec(new Vector3(1, 0, 0), new Vector3(2, 1, 1))),
                new[] { 0 }, new[] { 1 }, ClashKind.CLEARANCE, 0.05f);
            Assert.AreEqual(1, touching.Hits.Count);
            Assert.IsFalse(touching.Hits[0].Crossing);
            Assert.AreEqual(0f, touching.Hits[0].Distance, 1e-5f);
        }

        #endregion

        #region Pairs

        [TestMethod]
        public void Pairs_HostAndInsertSkipped_SameModelOnly()
        {
            BoxSpec wall = new(new Vector3(0, 0, 0), new Vector3(4, 0.2f, 3), "walls", Id: 500);
            BoxSpec door = new(new Vector3(1, -0.1f, 0), new Vector3(2, 0.3f, 2.1f), "doors", Id: 600, HostId: 500);
            Assert.AreEqual(0, Run(Scene(wall, door), new[] { 0 }, new[] { 1 }).Hits.Count);
            Assert.AreEqual(1, Run(Scene(wall, door with { HostId = 0 }), new[] { 0 }, new[] { 1 }).Hits.Count);
            Assert.AreEqual(1, Run(Scene(wall, door with { Link = 1 }), new[] { 0 }, new[] { 1 }).Hits.Count, "a linked door with the same host id is another model's");
        }

        [TestMethod]
        public void Pairs_SelfTestAndSharedMembers_CountOnce()
        {
            BoxSpec d1 = new(new Vector3(0, 0, 0), new Vector3(4, 0.4f, 0.4f));
            BoxSpec d2 = new(new Vector3(1, -1, 0.1f), new Vector3(1.4f, 1, 0.3f));
            BoxSpec d3 = new(new Vector3(8, 8, 8), new Vector3(9, 9, 9));
            SceneData scene = Scene(d1, d2, d3);
            Assert.AreEqual(1, Run(scene, new[] { 0, 1, 2 }, null).Hits.Count);
            Assert.AreEqual(1, Run(scene, new[] { 0, 1 }, new[] { 0, 1, 2 }).Hits.Count, "an element in both sets is paired once");
        }

        [TestMethod]
        public void Items_AsWalked_MovedElementsAndClones()
        {
            SceneData scene = Scene(BEAM, DUCT);
            ClashItem[] items = Items(scene);

            // The duct moved 3 m along X: clear of the beam
            Matrix4x4 away = Matrix4x4.CreateTranslation(3f, 0, 0);
            items[1] = ClashItem.Moved(1, away, Transform(scene.Elements[1].Bounds, away), 0);
            Assert.AreEqual(0, Run(scene, new[] { 0 }, new[] { 1 }, items: items).Hits.Count);

            // A clone of the duct back where the original was (its own clone key)
            ClashItem[] withClone = items.Append(ClashItem.Moved(1, Matrix4x4.Identity, scene.Elements[1].Bounds, 7)).ToArray();
            ClashRunResult result = Run(scene, new[] { 0 }, new[] { 1, 2 }, items: withClone);
            Assert.AreEqual(1, result.Hits.Count);
            ClashRecord record = ClashMerge.ToRecords(new ClashJob { Scene = scene, Items = withClone, SetA = new[] { 0 }, SetB = new[] { 1, 2 } }, result, "t")[0];
            Assert.AreEqual(7, record.B.CloneKey);
            Assert.AreEqual("/clone:7", record.B.Key);
        }

        private static Aabb Transform(Aabb box, Matrix4x4 m) => new(Vector3.Transform(box.Min, m), Vector3.Transform(box.Max, m));

        [TestMethod]
        public void Run_StopsAtTheLimit()
        {
            var specs = new List<BoxSpec> { new(new Vector3(0, 0, 0), new Vector3(10, 10, 0.2f), "floors") };
            for (int i = 0; i < 6; i++) { specs.Add(new BoxSpec(new Vector3(i + 0.2f, 1, 0.1f), new Vector3(i + 0.5f, 2, 0.5f), "pipes")); }
            SceneData scene = Scene(specs.ToArray());
            ClashRunResult result = ClashEngine.Run(new ClashJob { Scene = scene, Items = Items(scene), SetA = new[] { 0 }, SetB = Enumerable.Range(1, 6).ToArray(), MaxClashes = 3, Threads = 1 });
            Assert.IsTrue(result.Truncated);
            Assert.AreEqual(3, result.Hits.Count);
        }

        #endregion

        #region Sets

        [TestMethod]
        public void Sets_RulesIncludeExcludeAndFields()
        {
            SceneData scene = Scene(
                new BoxSpec(Vector3.Zero, Vector3.One, "ducts", FamilyType: "Rectangular Duct: 600x300", Level: "Level 1"),
                new BoxSpec(Vector3.Zero, Vector3.One, "pipes", FamilyType: "Pipe Types: Copper", Level: "Level 2"),
                new BoxSpec(Vector3.Zero, Vector3.One, "framing", FamilyType: "310UB40", Level: "Level 2", Link: 1));

            SearchSet services = SearchSets.SetOfCatalog("Services", new[] { "ducts", "pipes" });
            CollectionAssert.AreEqual(new[] { 0, 1 }, SearchSets.ElementsIn(services, scene));

            services.Rules.Add(new SetRule { Field = RuleField.LEVEL, Value = "Level 2", Exclude = true });
            CollectionAssert.AreEqual(new[] { 0 }, SearchSets.ElementsIn(services, scene));

            var all = new SearchSet { MatchAll = true, Rules = { new SetRule { Field = RuleField.LEVEL, Value = "level 2" }, new SetRule { Field = RuleField.LINK, Value = "Structure" } } };
            CollectionAssert.AreEqual(new[] { 2 }, SearchSets.ElementsIn(all, scene));

            var family = new SearchSet { Rules = { new SetRule { Field = RuleField.FAMILY, Value = "Rectangular Duct" }, new SetRule { Field = RuleField.TYPE, Value = "310UB", Contains = true } } };
            CollectionAssert.AreEqual(new[] { 0, 2 }, SearchSets.ElementsIn(family, scene));

            var host = new SearchSet { Rules = { new SetRule { Field = RuleField.LINK, Value = string.Empty } } };
            CollectionAssert.AreEqual(new[] { 0, 1 }, SearchSets.ElementsIn(host, scene));

            Assert.AreEqual(3, SearchSets.ElementsIn(new SearchSet(), scene).Count, "no include rules: everything");

            SearchSets.SplitFamilyType("Basic Wall", out string f, out string t);
            Assert.AreEqual(string.Empty, f);
            Assert.AreEqual("Basic Wall", t);
        }

        [TestMethod]
        public void Sets_SeededStarterTests()
        {
            ClashDocument document = SearchSets.Seeded();
            Assert.AreEqual(2, document.Sets.Count);
            Assert.AreEqual(2, document.Tests.Count);
            Assert.IsFalse(document.Tests[0].IsSelfTest);
            Assert.IsTrue(document.Tests[1].IsSelfTest);
            Assert.IsTrue(document.Tests.All(t => t.Kind == ClashKind.HARD && Math.Abs(t.Tolerance - 0.005) < 1e-9));
            foreach (string key in SearchSets.STRUCTURE_KEYS.Concat(SearchSets.SERVICES_KEYS)) { Assert.IsNotNull(CategoryCatalog.Find(key), key); }
        }

        #endregion

        #region Merge

        [TestMethod]
        public void Sets_Operators_NotRulesAlwaysSubtract()
        {
            SceneData scene = Scene(
                new BoxSpec(Vector3.Zero, Vector3.One, "ducts", FamilyType: "Rectangular Duct: 600x300", Level: "Level 1"),
                new BoxSpec(Vector3.Zero, Vector3.One, "pipes", FamilyType: "Pipe Types: Copper", Level: "Level 2"),
                new BoxSpec(Vector3.Zero, Vector3.One, "framing", FamilyType: "310UB40", Level: "Level 3"),
                new BoxSpec(Vector3.Zero, Vector3.One, "walls", FamilyType: "Generic - 200mm", Level: "Level 2"));
            SetRule Rule(string field, string op, params string[] values) => new SetRule { Field = field, Op = op, Values = values.ToList() };

            // Is one of / is not any of
            var services = new SearchSet { Rules = { Rule(RuleField.CATALOG, RuleOp.IS_ONE_OF, "ducts", "pipes") } };
            CollectionAssert.AreEqual(new[] { 0, 1 }, SearchSets.ElementsIn(services, scene));
            var notServices = new SearchSet { Rules = { Rule(RuleField.CATALOG, RuleOp.IS_NOT_ANY_OF, "ducts", "pipes") } };
            CollectionAssert.AreEqual(new[] { 2, 3 }, SearchSets.ElementsIn(notServices, scene), "only not rules: everything else");

            // A not rule subtracts even in an any-rule set (it never adds everything that isn't the value)
            var anyWithNot = new SearchSet { MatchAll = false, Rules = { Rule(RuleField.CATALOG, RuleOp.IS, "ducts"), Rule(RuleField.CATALOG, RuleOp.IS_NOT, "walls") } };
            CollectionAssert.AreEqual(new[] { 0 }, SearchSets.ElementsIn(anyWithNot, scene));
            var levelTwoNotWalls = new SearchSet { Rules = { Rule(RuleField.LEVEL, RuleOp.IS, "level 2"), Rule(RuleField.CATALOG, RuleOp.IS_NOT, "walls") } };
            CollectionAssert.AreEqual(new[] { 1 }, SearchSets.ElementsIn(levelTwoNotWalls, scene));

            // Contains / does not contain
            var types = new SearchSet { Rules = { Rule(RuleField.TYPE, RuleOp.CONTAINS, "600"), Rule(RuleField.TYPE, RuleOp.CONTAINS, "UB") } };
            CollectionAssert.AreEqual(new[] { 0, 2 }, SearchSets.ElementsIn(types, scene));
            types.Rules.Add(Rule(RuleField.TYPE, RuleOp.NOT_CONTAINS, "310"));
            CollectionAssert.AreEqual(new[] { 0 }, SearchSets.ElementsIn(types, scene));

            // Rules with no value yet (just added; empty text) are left out
            var unfinished = new SearchSet { Rules = { Rule(RuleField.CATALOG, RuleOp.IS), Rule(RuleField.TYPE, RuleOp.CONTAINS, " ") } };
            Assert.IsFalse(unfinished.Rules.Any(r => r.IsComplete));
            Assert.AreEqual(4, SearchSets.ElementsIn(unfinished, scene).Count);
            unfinished.Rules.Add(Rule(RuleField.LEVEL, RuleOp.IS_NOT, "Level 2"));
            CollectionAssert.AreEqual(new[] { 0, 2 }, SearchSets.ElementsIn(unfinished, scene));

            // Changing the operator: a single-value operator keeps the first value; a list keeps them all
            SetRule list = Rule(RuleField.CATALOG, RuleOp.IS_ONE_OF, "ducts", "pipes");
            list.SetOperator(RuleOp.IS_NOT_ANY_OF);
            Assert.AreEqual(2, list.Values.Count);
            Assert.IsTrue(list.Exclude && !list.Contains && list.Value == "ducts", "earlier fields kept in step");
            list.SetOperator(RuleOp.IS);
            CollectionAssert.AreEqual(new[] { "ducts" }, list.Values);
            list.SetOperator(RuleOp.IS_ONE_OF);
            list.ToggleValue("Pipes");
            list.ToggleValue("DUCTS");
            CollectionAssert.AreEqual(new[] { "Pipes" }, list.Values, "toggling ignores case");
            list.SetField(RuleField.LEVEL);
            Assert.AreEqual(0, list.Values.Count, "a new field drops the old field's values");
        }

        [TestMethod]
        public void Sets_Groups_AnyAllAndNotInside()
        {
            // C-B4: rule groups, one level deep (0 ducts L1 "600x300", 1 pipes L2, 2 framing L3 "310UB40", 3 walls L2)
            SceneData scene = Scene(
                new BoxSpec(Vector3.Zero, Vector3.One, "ducts", FamilyType: "Rectangular Duct: 600x300", Level: "Level 1"),
                new BoxSpec(Vector3.Zero, Vector3.One, "pipes", FamilyType: "Pipe Types: Copper", Level: "Level 2"),
                new BoxSpec(Vector3.Zero, Vector3.One, "framing", FamilyType: "310UB40", Level: "Level 3"),
                new BoxSpec(Vector3.Zero, Vector3.One, "walls", FamilyType: "Generic - 200mm", Level: "Level 2"));
            SetRule Rule(string field, string op, params string[] values) => new SetRule { Field = field, Op = op, Values = values.ToList() };
            RuleGroup Group(bool all, params SetRule[] rules) => new RuleGroup { MatchAll = all, Rules = rules.ToList() };

            // (ducts AND Level 1) OR (walls AND Level 2)
            var orOfAnds = new SearchSet
            {
                MatchAll = false,
                Groups = new List<RuleGroup>
                {
                    Group(true, Rule(RuleField.CATALOG, RuleOp.IS, "ducts"), Rule(RuleField.LEVEL, RuleOp.IS, "Level 1")),
                    Group(true, Rule(RuleField.CATALOG, RuleOp.IS, "walls"), Rule(RuleField.LEVEL, RuleOp.IS, "Level 2"))
                }
            };
            CollectionAssert.AreEqual(new[] { 0, 3 }, SearchSets.ElementsIn(orOfAnds, scene));

            // ALL of (ANY of ducts, pipes) and (ANY of Level 2, Level 3)
            var andOfOrs = new SearchSet
            {
                MatchAll = true,
                Groups = new List<RuleGroup>
                {
                    Group(false, Rule(RuleField.CATALOG, RuleOp.IS, "ducts"), Rule(RuleField.CATALOG, RuleOp.IS, "pipes")),
                    Group(false, Rule(RuleField.LEVEL, RuleOp.IS, "Level 2"), Rule(RuleField.LEVEL, RuleOp.IS, "Level 3"))
                }
            };
            CollectionAssert.AreEqual(new[] { 1 }, SearchSets.ElementsIn(andOfOrs, scene));

            // Inside a group a "not" rule is an ordinary condition: framing OR (not Level 2 AND not framing)
            var notInside = new SearchSet
            {
                MatchAll = false,
                Rules = { Rule(RuleField.CATALOG, RuleOp.IS, "framing") },
                Groups = new List<RuleGroup> { Group(true, Rule(RuleField.LEVEL, RuleOp.IS_NOT, "Level 2"), Rule(RuleField.CATALOG, RuleOp.IS_NOT, "framing")) }
            };
            CollectionAssert.AreEqual(new[] { 0, 2 }, SearchSets.ElementsIn(notInside, scene));
            var onlyNot = new SearchSet { Groups = new List<RuleGroup> { Group(false, Rule(RuleField.LEVEL, RuleOp.IS_NOT, "Level 2")) } };
            CollectionAssert.AreEqual(new[] { 0, 2 }, SearchSets.ElementsIn(onlyNot, scene));

            // A top-level "not" rule still takes elements out of the whole set (groups included)
            var topNot = new SearchSet
            {
                Rules = { Rule(RuleField.LEVEL, RuleOp.IS_NOT, "Level 1") },
                Groups = new List<RuleGroup> { Group(false, Rule(RuleField.CATALOG, RuleOp.IS_ONE_OF, "ducts", "pipes")) }
            };
            CollectionAssert.AreEqual(new[] { 1 }, SearchSets.ElementsIn(topNot, scene));

            // A group with no value yet is left out (the set holds every element, as with no rules)
            var unfinished = new SearchSet { MatchAll = true, Groups = new List<RuleGroup> { Group(true, Rule(RuleField.CATALOG, RuleOp.IS)) } };
            Assert.AreEqual(4, SearchSets.ElementsIn(unfinished, scene).Count);

            // A copy is deep
            SearchSet copy = orOfAnds.Copy(newId: true);
            copy.Groups[0].Rules[0].SetOperator(RuleOp.IS_NOT);
            Assert.AreEqual(RuleOp.IS, orOfAnds.Groups[0].Rules[0].Op);
            Assert.AreEqual(4, copy.AllRules().Count(), "four rules in two groups");
        }

        [TestMethod]
        public void Sets_Groups_FileRoundTrip()
        {
            // A flat document writes no groups (older builds read it as before)
            ClashDocument document = SearchSets.Seeded();
            string flat = System.Text.Encoding.UTF8.GetString(ClashFiles.Serialize(document));
            Assert.IsFalse(flat.Contains("\"groups\"", StringComparison.Ordinal));

            // Groups written and read back; an emptied groups list is left out again
            document.Sets[0].Groups = new List<RuleGroup>
            {
                new RuleGroup { MatchAll = true, Rules = { new SetRule { Field = RuleField.LEVEL, Op = RuleOp.IS_NOT, Values = { "Level 2" } } } },
                new RuleGroup { MatchAll = false }
            };
            ClashDocument again = ClashFiles.Parse(ClashFiles.Serialize(document), out string error);
            Assert.IsNotNull(again, error);
            Assert.AreEqual(2, again.Sets[0].Groups.Count);
            Assert.IsTrue(again.Sets[0].Groups[0].MatchAll);
            Assert.AreEqual(RuleOp.IS_NOT, again.Sets[0].Groups[0].Rules[0].Op);
            CollectionAssert.AreEqual(new[] { "Level 2" }, again.Sets[0].Groups[0].Rules[0].Values);
            Assert.AreEqual(0, again.Sets[0].Groups[1].Rules.Count);
            Assert.IsNull(again.Sets[1].Groups);

            again.Sets[0].Groups.Clear();
            string cleared = System.Text.Encoding.UTF8.GetString(ClashFiles.Serialize(again));
            Assert.IsFalse(cleared.Contains("\"groups\"", StringComparison.Ordinal));
        }

        [TestMethod]
        public void Sets_OlderRulesReadAsOperators()
        {
            // A C-B1 file: include / exclude switches, one value each
            string json = "{\"format\":\"bimgo-clashes\",\"version\":1,\"sets\":[{\"id\":\"s1\",\"name\":\"Old\",\"rules\":[" +
                "{\"field\":\"catalog\",\"value\":\"ducts\"}," +
                "{\"field\":\"level\",\"value\":\"Level 2\",\"exclude\":true}," +
                "{\"field\":\"type\",\"value\":\"600\",\"contains\":true}," +
                "{\"field\":\"type\",\"value\":\"x\",\"contains\":true,\"exclude\":true}," +
                "{\"field\":\"link\",\"value\":\"\"}]}],\"tests\":[],\"clashes\":[],\"runs\":[]}";
            ClashDocument document = ClashFiles.Parse(System.Text.Encoding.UTF8.GetBytes(json), out string error);
            Assert.IsNotNull(document, error);
            List<SetRule> rules = document.Sets[0].Rules;
            CollectionAssert.AreEqual(new[] { RuleOp.IS, RuleOp.IS_NOT, RuleOp.CONTAINS, RuleOp.NOT_CONTAINS, RuleOp.IS }, rules.Select(r => r.Op).ToArray());
            CollectionAssert.AreEqual(new[] { "ducts" }, rules[0].Values);
            CollectionAssert.AreEqual(new[] { string.Empty }, rules[4].Values, "the host model is the empty value, not 'none'");
            Assert.IsTrue(rules[4].IsComplete);

            // Written back: the operator and values, plus the earlier fields for older builds; read again unchanged
            rules[0].SetOperator(RuleOp.IS_ONE_OF);
            rules[0].ToggleValue("pipes");
            ClashDocument again = ClashFiles.Parse(ClashFiles.Serialize(document), out error);
            Assert.IsNotNull(again, error);
            CollectionAssert.AreEqual(new[] { "ducts", "pipes" }, again.Sets[0].Rules[0].Values);
            Assert.AreEqual(RuleOp.IS_ONE_OF, again.Sets[0].Rules[0].Op);
            Assert.AreEqual("ducts", again.Sets[0].Rules[0].Value);
            Assert.IsTrue(again.Sets[0].Rules[1].Exclude);
        }

        [TestMethod]
        public void Tests_SetsAAndBStayAsPicked()
        {
            ClashDocument document = SearchSets.Seeded();
            string structure = document.Sets[0].Id, services = document.Sets[1].Id;
            ClashTest test = document.Tests[0];

            // Set A moved onto set B's set: a self test for now, but B is still stored
            test.SetA = services;
            Assert.IsTrue(test.IsSelfTest);
            Assert.AreEqual(services, test.SetB);
            test.SetA = structure;
            Assert.IsFalse(test.IsSelfTest, "moving A away brings the A × B test back");
            Assert.AreEqual(services, test.SetB);

            // Both kinds of self test survive a save and a load, as do A and B
            test.SetB = structure;
            ClashDocument again = ClashFiles.Parse(ClashFiles.Serialize(document), out string error);
            Assert.IsNotNull(again, error);
            Assert.AreEqual(structure, again.Tests[0].SetA);
            Assert.AreEqual(structure, again.Tests[0].SetB);
            Assert.IsTrue(again.Tests[0].IsSelfTest);
            Assert.IsNull(again.Tests[1].SetB, "the seeded Services × Services test is 'itself'");
            Assert.IsTrue(again.Tests[1].IsSelfTest);
        }

        [TestMethod]
        public void Merge_ResetTest_NextRunStartsFresh()
        {
            var document = new ClashDocument();
            var test = new ClashTest { Name = "T" };
            var other = new ClashTest { Name = "U" };
            document.Tests.Add(test);
            document.Tests.Add(other);
            ClashRecord Clash(string a, string b) => new() { A = new ClashElementRef { UniqueId = a }, B = new ClashElementRef { UniqueId = b } };
            DateTime t0 = new(2026, 10, 12, 0, 0, 0, DateTimeKind.Utc);

            ClashMerge.Apply(document, test, new[] { Clash("a", "b") }, true, t0, "m1", 1, 1, 1);
            ClashMerge.Apply(document, test, new[] { Clash("a", "b") }, true, t0.AddHours(1), "m1", 1, 1, 1);
            ClashMerge.Apply(document, other, new[] { Clash("c", "d") }, true, t0, "m1", 1, 1, 1);
            ClashRecord ab = document.Clashes.Single(c => c.TestId == test.Id);
            ClashMerge.SetDetails(ab, "Services", "Drop it", "gavin", t0.AddHours(2));
            Assert.AreEqual(ClashStatus.ACTIVE, ab.Status);
            Assert.IsTrue(ClashMerge.HasResults(document, test));

            Assert.AreEqual(1, ClashMerge.ResetTest(document, test));
            Assert.IsFalse(ClashMerge.HasResults(document, test));
            Assert.IsNull(test.LastRunUtc);
            Assert.IsNull(test.LastRunModel);
            Assert.AreEqual(0, document.Runs.Count(r => r.TestId == test.Id));
            Assert.AreEqual(1, document.Clashes.Count(c => c.TestId == other.Id), "other tests keep theirs");
            Assert.AreEqual(1, document.Runs.Count(r => r.TestId == other.Id));

            // The same pair again: new, with no assignee or notes (reset starts clean)
            ClashMergeResult again = ClashMerge.Apply(document, test, new[] { Clash("a", "b") }, true, t0.AddHours(3), "m1", 1, 1, 1);
            Assert.AreEqual(1, again.New);
            ClashRecord back = document.Clashes.Single(c => c.TestId == test.Id);
            Assert.AreEqual(ClashStatus.NEW, back.Status);
            Assert.IsNull(back.AssignedTo);
            Assert.IsNull(back.Notes);
        }

        [TestMethod]
        public void Merge_StatusesAcrossRuns()
        {
            var document = new ClashDocument();
            var test = new ClashTest { Name = "T" };
            document.Tests.Add(test);
            ClashRecord Clash(string a, string b) => new() { A = new ClashElementRef { UniqueId = a }, B = new ClashElementRef { UniqueId = b } };
            DateTime t0 = new(2026, 10, 12, 0, 0, 0, DateTimeKind.Utc);

            ClashMergeResult first = ClashMerge.Apply(document, test, new[] { Clash("a", "b"), Clash("c", "d") }, true, t0, "m1", 2, 2, 1);
            Assert.AreEqual(2, first.New);
            Assert.IsTrue(document.Clashes.All(c => c.Status == ClashStatus.NEW));

            // Same pair (reversed order in a self test still matches), found again: active; one reviewed by a person
            ClashMerge.Apply(document, test, new[] { Clash("b", "a"), Clash("c", "d") }, true, t0.AddHours(1), "m1", 2, 2, 1);
            Assert.IsTrue(document.Clashes.All(c => c.Status == ClashStatus.ACTIVE));
            ClashRecord cd = document.Clashes.Single(c => c.A.UniqueId == "c");
            ClashMerge.SetStatus(cd, ClashStatus.REVIEWED, "gavin", t0.AddHours(2));
            ClashMerge.SetDetails(cd, "Services", "Drop the duct", "gavin", t0.AddHours(2));

            // A truncated run resolves nothing
            ClashMerge.Apply(document, test, Array.Empty<ClashRecord>(), false, t0.AddHours(3), "m2", 2, 2, 1);
            Assert.IsFalse(document.Clashes.Any(c => c.Status == ClashStatus.RESOLVED));

            // A complete run without them resolves both; the reviewed one keeps its assignee and notes
            ClashMergeResult gone = ClashMerge.Apply(document, test, Array.Empty<ClashRecord>(), true, t0.AddHours(4), "m2", 2, 2, 1);
            Assert.AreEqual(2, gone.NewlyResolved);
            Assert.AreEqual("Services", cd.AssignedTo);
            Assert.AreEqual(ClashStatus.RESOLVED, cd.Status);

            // It comes back: active again
            ClashMergeResult back = ClashMerge.Apply(document, test, new[] { Clash("c", "d") }, true, t0.AddHours(5), "m3", 2, 2, 1);
            Assert.AreEqual(1, back.Reopened);
            Assert.AreEqual(ClashStatus.ACTIVE, cd.Status);
            Assert.IsNull(cd.ResolvedUtc);
            Assert.AreEqual(2, document.Clashes.Count);
            Assert.AreEqual(5, document.Runs.Count);
            Assert.AreEqual("m3", test.LastRunModel);
            CollectionAssert.AreEqual(new[] { 0, 1, 0, 0, 1 }, document.Runs[^1].ByStatus);
        }

        #endregion

        #region Build C-B: framing, values, keys

        [TestMethod]
        public void Framing_SectionAroundTheRegion()
        {
            // A beam and a duct crossing: the overlap grown by 1 m, at least 2 m along every axis
            Aabb beam = new(new Vector3(0, 0, 2.6f), new Vector3(4, 0.3f, 3.0f));
            Aabb duct = new(new Vector3(1.8f, -2, 2.7f), new Vector3(2.2f, 2, 2.9f));
            Aabb section = ClashFraming.SectionFor(beam, duct, new Vector3(2, 0.15f, 2.8f));
            Assert.AreEqual(1.8f - 1.01f, section.Min.X, 0.02f);
            Assert.AreEqual(2.2f + 1.01f, section.Max.X, 0.02f);
            Assert.IsTrue(section.Size.Y >= 2f - 1e-4f && section.Size.Z >= 2f - 1e-4f);

            // A clearance gap: the box still holds both near faces and the point
            Aabb a = new(Vector3.Zero, Vector3.One), b = new(new Vector3(1.4f, 0, 0), new Vector3(2, 1, 1));
            Aabb gap = ClashFraming.SectionFor(a, b, new Vector3(1.2f, 0.5f, 0.5f));
            Assert.IsTrue(gap.Min.X <= 1f && gap.Max.X >= 1.4f && gap.Min.X <= 1.2f && gap.Max.X >= 1.2f);
        }

        [TestMethod]
        public void Framing_CameraLooksAcrossTheLongElement()
        {
            Vector3 point = new(2, 0, 2.8f);
            Aabb duct = new(new Vector3(1.8f, -5, 2.7f), new Vector3(2.2f, 5, 2.9f)); // long along Y
            Aabb box = new(new Vector3(1.5f, -0.5f, 2.5f), new Vector3(2.5f, 0.5f, 3.5f));  // a cube (no long axis)
            ClashView view = ClashFraming.Frame(point, duct, box, ClashFraming.SectionFor(duct, box, point), currentYaw: 0.2f);

            Assert.AreEqual(ClashFraming.DISTANCE, Vector3.Distance(view.Eye, point), 1e-3f);
            Assert.AreEqual(-ClashFraming.DOWN_PITCH, view.Pitch, 1e-5f);
            Assert.AreEqual(1f, MathF.Abs(MathF.Cos(view.Yaw)), 1e-3f, "looks along X, across the duct");
            Assert.IsTrue(view.Eye.Z > point.Z, "looks down at it");

            // A line-of-sight test that blocks every view from +X wins the other side
            ClashView blocked = ClashFraming.Frame(point, duct, box, default, 0f, clear: (eye, target) => eye.X < target.X);
            Assert.IsTrue(blocked.Eye.X < point.X);
            Assert.AreEqual(MathF.PI / 2f, MathF.Abs(ClashFraming.AngleBetween(MathF.PI / 2f, -MathF.PI)) , 1e-5f);
        }

        [TestMethod]
        public void Values_AndKeys_FromTheModel()
        {
            SceneData scene = Scene(
                new BoxSpec(Vector3.Zero, Vector3.One, "ducts", FamilyType: "Rectangular Duct: 600x300", Level: "Level 1"),
                new BoxSpec(Vector3.Zero, Vector3.One, "ducts", FamilyType: "Rectangular Duct: 400x200", Level: "Level 2"),
                new BoxSpec(Vector3.Zero, Vector3.One, "walls", FamilyType: "Generic - 200mm", Level: "Level 2", Link: 1));

            List<RuleValue> catalog = SearchSets.ValuesOf(scene, RuleField.CATALOG);
            Assert.AreEqual(2, catalog.Count);
            Assert.AreEqual(2, catalog.Single(v => v.Value == "ducts").Count);
            Assert.AreEqual(CategoryCatalog.Find("ducts").Label, catalog.Single(v => v.Value == "ducts").Label);

            List<RuleValue> families = SearchSets.ValuesOf(scene, RuleField.FAMILY);
            Assert.AreEqual(2, families.Single(v => v.Value == "Rectangular Duct").Count);
            Assert.AreEqual(1, families.Single(v => v.Value.Length == 0).Count, "system families have no family name");

            List<RuleValue> links = SearchSets.ValuesOf(scene, RuleField.LINK);
            Assert.AreEqual(2, links.Single(v => v.Value.Length == 0).Count);
            Assert.AreEqual("Structure", links.Single(v => v.Value == "link-uid").Label);

            Assert.AreEqual("Level is not Level 2", SearchSets.Describe(new SetRule { Field = RuleField.LEVEL, Value = "Level 2", Exclude = true }, scene));
            Assert.AreEqual("BimGo category is one of " + CategoryCatalog.Find("ducts").Label + ", " + CategoryCatalog.Find("pipes").Label,
                SearchSets.Describe(new SetRule { Field = RuleField.CATALOG, Op = RuleOp.IS_ONE_OF, Values = { "ducts", "pipes" } }, scene));
            Assert.AreEqual("Type does not contain 600", SearchSets.Describe(new SetRule { Field = RuleField.TYPE, Op = RuleOp.NOT_CONTAINS, Values = { "600" } }, scene));
            Assert.AreEqual("Model is Structure", SearchSets.Describe(new SetRule { Field = RuleField.LINK, Value = "link-uid" }, scene));

            // The app finds clash elements again by the same key the records store
            ClashItem[] items = Items(scene);
            for (int i = 0; i < scene.Elements.Length; i++) { Assert.AreEqual(ClashMerge.RefOf(scene, items[i]).Key, ClashMerge.ElementKey(scene, i)); }
            StringAssert.StartsWith(ClashMerge.ElementKey(scene, 2), "link-uid/");
        }

        [TestMethod]
        public void Controls_ClashModeKeysHaveNoDefaultClash()
        {
            Assert.IsTrue(InputCatalog.LiveTogether(InputAction.ClashNext, InputAction.MoveForward));
            Assert.IsFalse(InputCatalog.LiveTogether(InputAction.ClashStatusNew, InputAction.Gun1), "1–5 are statuses only in clash mode");
            Assert.IsFalse(InputCatalog.LiveTogether(InputAction.ClashFlyUp, InputAction.Jump));
            Assert.IsTrue(InputCatalog.LiveTogether(InputAction.ClashView, InputAction.ClashSectionToggle));
            Assert.IsFalse(InputCatalog.LiveTogether(InputAction.ClashSectionToggle, InputAction.AddBookmark), "B is the clash box only in clash mode");
            Assert.AreEqual(0, new KeyMap().AllClashes().Count);
        }

        #endregion

        #region Storage and reports

        [TestMethod]
        public void Files_RoundTripInsideABimgo_AndUntouchedWhenDormant()
        {
            string folder = Path.Combine(Path.GetTempPath(), "BimGoClashTests_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
            try
            {
                ClashDocument clashes = SearchSets.Seeded();
                clashes.Clashes.Add(new ClashRecord { TestId = clashes.Tests[0].Id, A = new ClashElementRef { UniqueId = "x" }, B = new ClashElementRef { UniqueId = "y" }, X = 1.5, Notes = "n" });
                byte[] bytes = ClashFiles.Serialize(clashes);

                BimGoDocument document = TestData.BuildDocument();
                document.Clashes = bytes;
                string path = Path.Combine(folder, "a.bimgo");
                Assert.IsTrue(BimGoWriter.Write(path, document, TestData.Writer, FileKinds.SAVE, out string error), error);
                BimGoDocument read = BimGoReader.Read(path, new LaunchSettings(), out error);
                Assert.IsNotNull(read, error);
                CollectionAssert.AreEqual(bytes, read.Clashes, "kept byte for byte (dormant files never parse it)");

                ClashDocument parsed = ClashFiles.Parse(read.Clashes, out error);
                Assert.IsNotNull(parsed, error);
                Assert.AreEqual(2, parsed.Tests.Count);
                Assert.AreEqual("n", parsed.Clashes[0].Notes);
                Assert.AreEqual(clashes.Clashes[0].Key, parsed.Clashes[0].Key);

                // No clash data: no entry
                document.Clashes = null;
                Assert.IsTrue(BimGoWriter.Write(path, document, TestData.Writer, FileKinds.SAVE, out error), error);
                Assert.IsFalse(TestData.EntryNames(path).Contains("clashes.json"));
                Assert.IsNull(BimGoReader.Read(path, new LaunchSettings(), out _).Clashes);

                // Damaged or foreign data: an error, never an exception
                Assert.IsNull(ClashFiles.Parse(System.Text.Encoding.UTF8.GetBytes("{\"format\":\"other\"}"), out error));
                Assert.IsNotNull(error);
                Assert.IsNull(ClashFiles.Parse(System.Text.Encoding.UTF8.GetBytes("{ not json"), out error));
                Assert.IsNotNull(error);
            }
            finally
            {
                try { Directory.Delete(folder, true); } catch (IOException) { }
            }
        }

        [TestMethod]
        public void Report_ExportImport_NewerChangesWin()
        {
            string folder = Path.Combine(Path.GetTempPath(), "BimGoClashTests_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
            try
            {
                DateTime t0 = new(2026, 10, 12, 0, 0, 0, DateTimeKind.Utc);
                ClashDocument theirs = SearchSets.Seeded();
                string testId = theirs.Tests[0].Id;
                theirs.Clashes.Add(new ClashRecord { TestId = testId, A = new ClashElementRef { UniqueId = "a" }, B = new ClashElementRef { UniqueId = "b" }, Status = ClashStatus.APPROVED, Updated = t0.AddHours(2), UpdatedBy = "them" });
                theirs.Clashes.Add(new ClashRecord { TestId = testId, A = new ClashElementRef { UniqueId = "c" }, B = new ClashElementRef { UniqueId = "d" }, Status = ClashStatus.REVIEWED, Updated = t0 });
                theirs.Clashes.Add(new ClashRecord { TestId = testId, A = new ClashElementRef { UniqueId = "e" }, B = new ClashElementRef { UniqueId = "f" } });
                string path = Path.Combine(folder, "report.json");
                Assert.IsTrue(ClashFiles.ExportReport(path, theirs, "Clash Model", "key-1", "BimGo test", out string error), error);
                StringAssert.Contains(File.ReadAllText(path), ClashFiles.REPORT_FORMAT);

                // Ours: the same tests (as after an earlier import), one clash changed later than theirs, one earlier
                ClashDocument ours = ClashFiles.Parse(ClashFiles.Serialize(SearchSets.Seeded()), out _);
                ours.Sets = theirs.Sets.Select(s => s.Copy()).ToList();
                ours.Tests = new List<ClashTest> { new() { Id = testId, Name = "Mine", SetA = theirs.Sets[0].Id, SetB = theirs.Sets[1].Id } };
                ours.Clashes.Add(new ClashRecord { TestId = testId, A = new ClashElementRef { UniqueId = "b" }, B = new ClashElementRef { UniqueId = "a" }, Status = ClashStatus.ACTIVE, Updated = t0.AddHours(1) });
                ours.Clashes.Add(new ClashRecord { TestId = testId, A = new ClashElementRef { UniqueId = "c" }, B = new ClashElementRef { UniqueId = "d" }, Status = ClashStatus.ACTIVE, Updated = t0.AddHours(3) });

                ClashImportResult? result = ClashFiles.ImportReport(path, ours, "key-1", out error);
                Assert.IsNotNull(result, error);
                Assert.AreEqual(1, result.Value.ClashesAdded);
                Assert.AreEqual(1, result.Value.ClashesUpdated);
                Assert.AreEqual(1, result.Value.Unchanged);
                Assert.AreEqual(1, result.Value.TestsAdded); // the second seeded test
                Assert.IsTrue(result.Value.SameModel);
                Assert.AreEqual(ClashStatus.APPROVED, ours.Clashes.Single(c => c.A.UniqueId == "b").Status);
                Assert.AreEqual(ClashStatus.ACTIVE, ours.Clashes.Single(c => c.A.UniqueId == "c").Status);
                Assert.AreEqual("Mine", ours.FindTest(testId).Name);

                Assert.IsFalse(ClashFiles.ImportReport(path, ours, "other-key", out _).Value.SameModel);
            }
            finally
            {
                try { Directory.Delete(folder, true); } catch (IOException) { }
            }
        }

        #endregion

        #region C-B2: clash comments

        [TestMethod]
        public void Comments_StatusFollowsTheClash_PriorityByDepth()
        {
            // new / active → open, reviewed → in progress, approved / resolved → closed (unknown reads as new → open)
            Assert.AreEqual(CommentStatus.OPEN, ClashCommentRules.CommentStatusFor(ClashStatus.NEW));
            Assert.AreEqual(CommentStatus.OPEN, ClashCommentRules.CommentStatusFor(ClashStatus.ACTIVE));
            Assert.AreEqual(CommentStatus.IN_PROGRESS, ClashCommentRules.CommentStatusFor(ClashStatus.REVIEWED));
            Assert.AreEqual(CommentStatus.CLOSED, ClashCommentRules.CommentStatusFor(ClashStatus.APPROVED));
            Assert.AreEqual(CommentStatus.CLOSED, ClashCommentRules.CommentStatusFor(ClashStatus.RESOLVED));
            Assert.AreEqual(CommentStatus.OPEN, ClashCommentRules.CommentStatusFor("whatever"));

            // High only for a hard clash crossing deeper than 50 mm
            Assert.AreEqual(CommentPriority.HIGH, ClashCommentRules.PriorityFor(new ClashRecord { Crossing = true, Distance = 0.08 }, ClashKind.HARD));
            Assert.AreEqual(CommentPriority.NORMAL, ClashCommentRules.PriorityFor(new ClashRecord { Crossing = true, Distance = 0.05 }, ClashKind.HARD));
            Assert.AreEqual(CommentPriority.NORMAL, ClashCommentRules.PriorityFor(new ClashRecord { Crossing = true, Distance = 0.08 }, ClashKind.CLEARANCE));
            Assert.AreEqual(CommentPriority.NORMAL, ClashCommentRules.PriorityFor(new ClashRecord { Crossing = false, Distance = 0.08 }, ClashKind.HARD));
            Assert.AreEqual(CommentPriority.NORMAL, ClashCommentRules.PriorityFor(null, ClashKind.HARD));
        }

        [TestMethod]
        public void Comments_ClashLinkReadsAndExportsAsAClashTopic()
        {
            // The link is optional: older comments have none (an "Issue"), blank reads as none
            var plain = new CommentRecord { Text = "Door swing", ClashId = "  " }.Clean();
            Assert.IsNull(plain.ClashId);
            Assert.AreEqual("Issue", BcfMapping.ToTopic(plain).TopicType);

            var fromClash = new CommentRecord { Text = "Clash: Structure × Services", ClashId = "abc" }.Clean();
            Assert.AreEqual("Clash", BcfMapping.ToTopic(fromClash).TopicType);

            // It survives the comment document's JSON
            string json = System.Text.Json.JsonSerializer.Serialize(new CommentDocument { Comments = { fromClash } });
            CommentDocument back = System.Text.Json.JsonSerializer.Deserialize<CommentDocument>(json);
            Assert.AreEqual("abc", back.Comments.Single().ClashId);
        }

        [TestMethod]
        public void Framing_SeveralClashes_StandsBackToSeeThemAll()
        {
            // C-B3: a 1 m region keeps the usual 2.5 m; a 20 m one is seen whole (its sphere inside the narrower FOV)
            var small = new Aabb(new Vector3(-0.5f), new Vector3(0.5f));
            Assert.AreEqual(ClashFraming.DISTANCE, ClashFraming.DistanceToSee(small, 90f, 16f / 9f), 1e-4f);

            var large = new Aabb(new Vector3(-10f, -10f, -2f), new Vector3(10f, 10f, 2f));
            float distance = ClashFraming.DistanceToSee(large, 90f, 16f / 9f);
            float radius = large.Size.Length() * 0.5f;
            float halfV = MathF.Atan(MathF.Tan(MathF.PI / 4f) / (16f / 9f));
            Assert.IsTrue(distance * MathF.Sin(halfV) >= radius, "the box fits the vertical field of view");
            Assert.IsTrue(distance < radius / MathF.Sin(halfV) * 1.1f, "not much further than needed");

            // Wider views stand closer; an empty box falls back to the usual distance
            Assert.IsTrue(ClashFraming.DistanceToSee(large, 110f, 16f / 9f) < distance);
            Assert.AreEqual(ClashFraming.DISTANCE, ClashFraming.DistanceToSee(Aabb.Empty, 90f, 1.6f), 1e-4f);
        }

        #endregion
    }
}
