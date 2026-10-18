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
    /// Round K-A: the camera path timeline (shape, constant speed, easing, holds, heading, loop, sun blend) and the
    /// path document (cleaning, sidecar and .bimgo round trips). The maths was also checked in a Python port.
    /// </summary>
    [TestClass]
    public sealed class CameraPathTests
    {
        private const float DT = 1f / 120f;

        private static CameraPathPoint Key(float x, float y, float z, float speed = 1.5f, float hold = 0f, bool ease = false, float smoothness = 0.8f,
            CameraHeading heading = CameraHeading.Follow, float yaw = 0f, float pitch = 0f, Vector3 target = default) =>
            new(new Vector3(x, y, z), yaw, pitch, heading, target, smoothness, speed, hold, ease);

        private static CameraPathTimeline Timeline(bool loop, float fade, bool level, params CameraPathPoint[] keys) =>
            new(keys, new CameraPathSettings(loop, fade, 3f, level), eyeHeight: 1.6f);

        private static float AngleBetween(float a, float b) => MathF.Abs(TourTimeline.LerpAngle(a, b, 1f) - a);

        [TestMethod]
        public void Continuity_NoJumpsAndASmoothHeading()
        {
            CameraPathTimeline timeline = Timeline(false, 0.5f, true,
                Key(0, 0, 1.6f, ease: true), Key(10, 0, 1.6f), Key(10, 10, 1.6f), Key(20, 10, 3.6f, ease: true));
            Vector3 previous = timeline.Evaluate(0f).Eye;
            float previousYaw = timeline.Evaluate(0f).Yaw;
            float maxStep = 0f, maxTurn = 0f;
            for (float t = DT; t < timeline.Duration; t += DT)
            {
                CameraPathPose pose = timeline.Evaluate(t);
                maxStep = MathF.Max(maxStep, Vector3.Distance(previous, pose.Eye));
                maxTurn = MathF.Max(maxTurn, AngleBetween(previousYaw, pose.Yaw));
                previous = pose.Eye;
                previousYaw = pose.Yaw;
            }
            Assert.IsTrue(maxStep <= 1.5f * DT * 1.02f, $"largest step {maxStep} (speed 1.5 m/s)");
            Assert.IsTrue(maxTurn < 0.05f, $"largest turn per frame {maxTurn} rad");
        }

        [TestMethod]
        public void ConstantSpeed_AlongTheCurveAndAroundALoop()
        {
            CameraPathTimeline loop = Timeline(true, 0.5f, true, Key(0, 0, 0), Key(10, 0, 0), Key(10, 10, 0), Key(0, 10, 0));
            Assert.IsTrue(loop.Loops);
            Vector3 previous = loop.Evaluate(0f).Eye;
            float slowest = float.MaxValue, fastest = 0f;
            for (float t = DT; t < loop.Duration - DT; t += DT)
            {
                Vector3 eye = loop.Evaluate(t).Eye;
                float speed = Vector3.Distance(previous, eye) / DT;
                slowest = MathF.Min(slowest, speed);
                fastest = MathF.Max(fastest, speed);
                previous = eye;
            }
            Assert.AreEqual(1.5f, slowest, 0.03f, "no ease at a loop's keys: cruise all the way");
            Assert.AreEqual(1.5f, fastest, 0.03f);
            Assert.AreEqual(loop.Length / 1.5f, loop.Duration, 0.01f, "a lap at 1.5 m/s, no fades");
        }

        [TestMethod]
        public void Ease_StartsAndStopsGentlyAndShortSegmentsSlowDown()
        {
            CameraPathTimeline timeline = Timeline(false, 0f, true, Key(0, 0, 0, speed: 5f, ease: true), Key(0.5f, 0, 0, ease: true));
            Vector3 a = timeline.Evaluate(0.01f).Eye, b = timeline.Evaluate(0.02f).Eye;
            Assert.IsTrue(Vector3.Distance(a, b) / 0.01f < 0.05f, "slow at first");
            float fastest = 0f;
            Vector3 previous = timeline.Evaluate(0f).Eye;
            for (float t = DT; t <= timeline.Duration; t += DT)
            {
                Vector3 eye = timeline.Evaluate(t).Eye;
                fastest = MathF.Max(fastest, Vector3.Distance(previous, eye) / DT);
                previous = eye;
            }
            Assert.IsTrue(fastest < 5f, $"too short to reach 5 m/s (top {fastest})");
            Assert.AreEqual(0.25f, timeline.Evaluate(timeline.Duration * 0.5f).Eye.X, 1e-3f, "symmetric ramps: half way at half time");
            Assert.AreEqual(0.5f, timeline.Evaluate(timeline.Duration - 1e-4f).Eye.X, 1e-3f);
        }

        [TestMethod]
        public void Holds_StopAtTheKeyAndSeekToIt()
        {
            CameraPathTimeline timeline = Timeline(false, 0f, true, Key(0, 0, 0), Key(5, 0, 0, hold: 2f), Key(5, 5, 0));
            float arrive = timeline.StartOf(1);
            CameraPathPose held = timeline.Evaluate(arrive + 1f);
            Assert.AreEqual(1, held.Key);
            Assert.IsFalse(held.Moving);
            Assert.AreEqual(new Vector3(5, 0, 0), held.Eye);
            Assert.AreEqual(1, timeline.StopAt(arrive + 0.01f));
            Assert.AreEqual(0, timeline.StopAt(arrive - 0.01f));
            Vector3 a = timeline.Evaluate(arrive - 0.02f).Eye, b = timeline.Evaluate(arrive - 0.01f).Eye;
            Assert.IsTrue(Vector3.Distance(a, b) / 0.01f < 0.05f, "a hold eases the camera to a stop");
        }

        [TestMethod]
        public void Fades_AtTheEndsOnly()
        {
            CameraPathTimeline timeline = Timeline(false, 0.5f, true, Key(0, 0, 0), Key(10, 0, 0));
            Assert.AreEqual(1f, timeline.Evaluate(0f).Black, 1e-5f);
            Assert.AreEqual(0f, timeline.Evaluate(1f).Black, 1e-5f);
            CameraPathPose end = timeline.Evaluate(timeline.Duration);
            Assert.IsTrue(end.Finished);
            Assert.AreEqual(1f, end.Black, 1e-5f);
            Assert.AreEqual(new Vector3(10, 0, 0), end.Eye);

            CameraPathTimeline loop = Timeline(true, 0.5f, true, Key(0, 0, 0), Key(10, 0, 0), Key(5, 5, 0));
            Assert.AreEqual(0f, loop.Evaluate(0f).Black, 1e-5f, "a loop doesn't fade");
            Assert.IsTrue(Vector3.Distance(loop.Evaluate(0f).Eye, loop.Evaluate(loop.Duration - 1e-4f).Eye) < 0.01f, "the lap closes");
        }

        [TestMethod]
        public void Follow_LooksAlongThePathLevelOrNot()
        {
            CameraPathTimeline level = Timeline(false, 0f, true, Key(0, 0, 1.6f), Key(10, 0, 5f));
            CameraPathPose middle = level.Evaluate(level.Duration * 0.5f);
            Assert.AreEqual(0f, middle.Yaw, 1e-3f);
            Assert.AreEqual(0f, middle.Pitch, 1e-6f);
            Assert.AreEqual(0f, level.Evaluate(level.Duration).Yaw, 1e-3f, "past the end: the final direction");

            CameraPathTimeline climbing = Timeline(false, 0f, false, Key(0, 0, 1.6f), Key(10, 0, 5f));
            Assert.AreEqual(MathF.Atan2(3.4f, 10f), climbing.Evaluate(climbing.Duration * 0.5f).Pitch, 0.02f);

            // Round a corner: the heading turns before the corner (it looks ahead)
            CameraPathTimeline corner = Timeline(false, 0f, true, Key(0, 0, 0, smoothness: 0f), Key(10, 0, 0, smoothness: 0f), Key(10, 10, 0, smoothness: 0f));
            float justBefore = corner.StartOf(1) - 0.5f;
            Assert.IsTrue(corner.Evaluate(justBefore).Yaw > 0.3f, "turning towards +Y before reaching the corner");
        }

        [TestMethod]
        public void KeyViews_BlendInAndOut()
        {
            // Look at a target during the hold
            var target = new Vector3(5, 5, 0);
            CameraPathTimeline lookAt = Timeline(false, 0f, true, Key(0, 0, 1.6f),
                Key(5, 0, 1.6f, hold: 1f, heading: CameraHeading.LookAt, target: target), Key(10, 0, 1.6f));
            CameraPathPose held = lookAt.Evaluate(lookAt.StartOf(1) + 0.5f);
            Vector3 to = target - held.Eye;
            Assert.AreEqual(MathF.Atan2(to.Y, to.X), held.Yaw, 1e-4f);
            Assert.AreEqual(MathF.Atan2(to.Z, MathF.Sqrt(to.X * to.X + to.Y * to.Y)), held.Pitch, 1e-4f);
            Assert.AreEqual(0f, lookAt.Evaluate(0.001f).Yaw, 0.05f, "the first half of the way in still follows");

            // Two keys holding their own views: from one to the other over the segment
            CameraPathTimeline views = Timeline(false, 0f, true, Key(0, 0, 0, heading: CameraHeading.Key, yaw: 0f),
                Key(10, 0, 0, heading: CameraHeading.Key, yaw: 3f));
            float middle = views.StartOf(0) + views.SegmentSeconds(0) * 0.5f; // no fade, no hold: the segment starts at 0
            Assert.AreEqual(1.5f, views.Evaluate(middle).Yaw, 1e-3f);

            // Two keys at one place: a turn on the spot
            CameraPathTimeline turn = Timeline(false, 0f, true, Key(0, 0, 0, heading: CameraHeading.Key, yaw: 0f),
                Key(0, 0, 0, heading: CameraHeading.Key, yaw: MathF.PI / 2));
            Assert.AreEqual(CameraPathTimeline.STILL_SEGMENT_SECONDS, turn.Duration, 1e-4f);
            Assert.AreEqual(MathF.PI / 4, turn.Evaluate(turn.Duration * 0.5f).Yaw, 1e-3f);
        }

        [TestMethod]
        public void Shape_SharpIsStraightRoundBulges()
        {
            CameraPathTimeline sharp = Timeline(false, 0f, true, Key(0, 0, 0, smoothness: 0f), Key(10, 0, 0, smoothness: 0f), Key(10, 10, 0, smoothness: 0f));
            Assert.AreEqual(10f, sharp.SegmentLength(0), 1e-3f);
            Assert.AreEqual(0f, sharp.PointAt(3.7f).Y, 1e-5f);

            CameraPathTimeline round = Timeline(false, 0f, true, Key(0, 0, 0, smoothness: 1f), Key(10, 0, 0, smoothness: 1f), Key(10, 10, 0, smoothness: 1f));
            Assert.IsTrue(MathF.Abs(round.PointAt(round.SegmentLength(0) * 0.9f).Y) > 1e-3f, "a round path leaves the straight line before the key");
            Assert.AreEqual(new Vector3(10, 0, 0), round.PointAt(round.SegmentLength(0)), "and still passes through the key");
        }

        [TestMethod]
        public void SunBlend_FollowsTheSegmentAndThePoseStandsOnTheEye()
        {
            CameraPathTimeline timeline = Timeline(false, 0f, true, Key(0, 0, 3f), Key(10, 0, 3f));
            CameraPathPose pose = timeline.Evaluate(timeline.SegmentSeconds(0) * 0.25f);
            Assert.AreEqual(0, pose.BlendFrom);
            Assert.AreEqual(1, pose.BlendTo);
            Assert.AreEqual(0.25f, pose.BlendT, 1e-4f);
            TourPose tour = timeline.Pose(timeline.SegmentSeconds(0) * 0.25f);
            Assert.AreEqual(pose.Eye.Z, tour.Eye.Z, 1e-5f);
            Assert.AreEqual(1.6f, tour.EyeHeight, 1e-6f);
            Assert.AreEqual(0, tour.Stop);
        }

        [TestMethod]
        public void Editing_NearestPointSegmentAndTime()
        {
            // Round K-B: K inserts on the nearest segment; the scrubber maps distance to time
            CameraPathTimeline sharp = Timeline(false, 0f, true, Key(0, 0, 0, smoothness: 0f), Key(10, 0, 0, smoothness: 0f), Key(10, 10, 0, smoothness: 0f));
            Assert.AreEqual(1f, sharp.Nearest(new Vector3(4, 1, 0), out int segment, out float along), 1e-3f);
            Assert.AreEqual(0, segment);
            Assert.AreEqual(4f, along, 1e-2f);
            Assert.AreEqual(1f, sharp.Nearest(new Vector3(11, 6, 0), out segment, out along), 1e-3f);
            Assert.AreEqual(1, segment);
            Assert.AreEqual(16f, along, 1e-2f);
            Assert.AreEqual(1, sharp.SegmentAt(12f));
            Assert.AreEqual(0, sharp.SegmentAt(-3f));
            Assert.AreEqual(5f / 1.5f, sharp.TimeAtDistance(5f), 1e-3f, "no ease: distance / speed");
            Assert.AreEqual(5f, sharp.PointAt(5f).X, 1e-3f);

            CameraPathTimeline loop = Timeline(true, 0f, true, Key(0, 0, 0), Key(10, 0, 0), Key(5, 5, 0));
            Assert.AreEqual(2, loop.SegmentAt(loop.Length - 0.1f), "the closing segment");
            Assert.AreEqual(0, loop.SegmentAt(loop.Length + 0.1f), "wraps");
        }

        [TestMethod]
        public void Snapshot_RestoresInPlaceWithTheSameIds()
        {
            var path = new CameraPath { Name = "A", Speed = 2f, Keys = new List<CameraKey> { new() { Name = "k1", X = 1, Sun = new SunTime { Minutes = 60 } } } };
            CameraPath snapshot = path.Snapshot();
            string keyId = path.Keys[0].Id;
            path.Name = "B";
            path.Speed = 5f;
            path.Keys[0].X = 9;
            path.Keys[0].Sun.Minutes = 120;
            path.Keys.Add(new CameraKey { Name = "k2" });

            path.CopyFrom(snapshot);
            Assert.AreEqual("A", path.Name);
            Assert.AreEqual(2f, path.Speed);
            Assert.AreEqual(1, path.Keys.Count);
            Assert.AreEqual(keyId, path.Keys[0].Id);
            Assert.AreEqual(1.0, path.Keys[0].X);
            Assert.AreEqual(60, path.Keys[0].Sun.Minutes);
            Assert.AreNotSame(snapshot.Keys[0], path.Keys[0], "a second undo to the same snapshot stays possible");
        }

        [TestMethod]
        public void Document_CleansAndRoundTrips()
        {
            var path = new CameraPath
            {
                Name = " ",
                Speed = 999f,
                Smoothness = float.NaN,
                LookAhead = -2f,
                Keys = new List<CameraKey>
                {
                    new() { Name = "A", X = 1, Y = 2, Z = 3, Yaw = 0.5f, Pitch = 3f, HoldSeconds = 500f, Speed = 0.01f, Sun = new SunTime { Month = 3, Minutes = 600 } },
                    new() { Name = "Bad", X = double.NaN },
                    null,
                    new() { Name = "B", X = 4, Y = 5, Z = 6, Heading = CameraHeading.LookAt, TargetX = 1, TargetY = 1, TargetZ = 1, ColourProfile = "" }
                }
            };
            var document = new CameraPathDocument { Model = "Test", Paths = new List<CameraPath> { path, null } }.Clean();
            Assert.AreEqual(1, document.Paths.Count);
            Assert.AreEqual(2, path.Keys.Count, "the unusable and null keys are dropped");
            Assert.AreEqual("Path", path.Name);
            Assert.AreEqual(CameraPath.MAX_SPEED, path.Speed);
            Assert.AreEqual(0.8f, path.Smoothness);
            Assert.AreEqual(CameraPath.MIN_LOOK_AHEAD, path.LookAhead);
            Assert.AreEqual(1.5f, path.Keys[0].Pitch);
            Assert.AreEqual(CameraKey.MAX_HOLD, path.Keys[0].HoldSeconds);
            Assert.AreEqual(CameraPath.MIN_SPEED, path.Keys[0].Speed);
            Assert.IsTrue(path.EasesAt(0) && path.EasesAt(1), "the ends (and a hold) ease");

            string file = Path.Combine(Path.GetTempPath(), "bimgo-paths-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                Assert.IsTrue(CameraPathFiles.Write(file, document, out string error), error);
                CameraPathDocument read = CameraPathFiles.Read(file, out error);
                Assert.IsNotNull(read, error);
                CameraKey a = read.Paths[0].Keys[0], b = read.Paths[0].Keys[1];
                Assert.AreEqual("A", a.Name);
                Assert.AreEqual(600, a.Sun.Minutes);
                Assert.IsNull(a.Heading);
                Assert.IsNull(a.ColourProfile, "null: leave the profile as it is");
                Assert.AreEqual(CameraHeading.LookAt, b.Heading);
                Assert.IsTrue(b.HasTarget);
                Assert.AreEqual("", b.ColourProfile, "\"\": profiles off");
                string json = File.ReadAllText(file);
                StringAssert.Contains(json, "\"lookAt\"");
                Assert.IsFalse(json.Contains("\"local\""), "scene-local positions aren't saved");
            }
            finally
            {
                File.Delete(file);
            }
        }

        [TestMethod]
        public void Swivel_PansOverTheHoldAndLeavesFromThere()
        {
            // Round K-C: a key holding its own view pans over its hold (eased), then leaves from the panned view
            CameraPathPoint a = Key(0, 0, 1.6f, heading: CameraHeading.Key, yaw: 0f);
            var b = new CameraPathPoint(new Vector3(10, 0, 1.6f), 1f, 0f, CameraHeading.Key, default, 0.8f, 1.5f, 2f, false, swivel: 0.5f);
            CameraPathPoint c = Key(20, 0, 1.6f, heading: CameraHeading.Key, yaw: 1f);
            CameraPathTimeline timeline = Timeline(false, 0f, true, a, b, c);
            float hold = timeline.StartOf(1);
            Assert.AreEqual(1f, timeline.Evaluate(hold).Yaw, 1e-3f, "arrives at its own view");
            Assert.AreEqual(1.25f, timeline.Evaluate(hold + 1f).Yaw, 1e-3f, "half way through the hold: half the pan");
            Assert.AreEqual(1.5f, timeline.Evaluate(hold + 2f + 1e-3f).Yaw, 2e-3f, "leaves from the panned view");

            float previousYaw = timeline.Evaluate(0f).Yaw, maxTurn = 0f;
            for (float t = DT; t < timeline.Duration; t += DT)
            {
                float yaw = timeline.Evaluate(t).Yaw;
                maxTurn = MathF.Max(maxTurn, AngleBetween(previousYaw, yaw));
                previousYaw = yaw;
            }
            Assert.IsTrue(maxTurn < 0.05f, $"largest turn per frame {maxTurn} rad");

            // No hold, or not its own view: no swivel
            Assert.AreEqual(0f, new CameraPathPoint(Vector3.Zero, 0f, 0f, CameraHeading.Key, default, 0.8f, 1.5f, 0f, false, swivel: 1f).Swivel);
            Assert.AreEqual(0f, new CameraPathPoint(Vector3.Zero, 0f, 0f, CameraHeading.Follow, default, 0.8f, 1.5f, 2f, false, swivel: 1f).Swivel);
        }

        [TestMethod]
        public void FollowBetween_FollowsInTheMiddleOfLongSegments()
        {
            // Round K-C: between two own views, out into following and back in (a converted or smooth tour)
            CameraPathPoint a = Key(0, 0, 0, heading: CameraHeading.Key, yaw: 1f), b = Key(20, 0, 0, heading: CameraHeading.Key, yaw: 2f);
            var follow = new CameraPathTimeline(new[] { a, b }, new CameraPathSettings(false, 0f, 3f, true, followBetween: true));
            float middle = follow.SegmentSeconds(0) * 0.5f;
            Assert.AreEqual(0f, follow.Evaluate(middle).Yaw, 1e-3f, "follows the path (+X) in the middle");
            Assert.AreEqual(1f, follow.Evaluate(0f).Yaw, 1e-3f, "starts in the first view");
            Assert.AreEqual(2f, follow.Evaluate(follow.SegmentSeconds(0) - 1e-3f).Yaw, 1e-2f, "ends in the second view");
            Assert.AreEqual(1.5f, Timeline(false, 0f, true, a, b).Evaluate(middle).Yaw, 1e-3f, "off: straight from one view to the other");

            // A short segment (under twice the look-ahead) turns straight
            CameraPathPoint near = Key(4, 0, 0, heading: CameraHeading.Key, yaw: 2f);
            var shortPath = new CameraPathTimeline(new[] { a, near }, new CameraPathSettings(false, 0f, 3f, true, followBetween: true));
            Assert.AreEqual(1.5f, shortPath.Evaluate(shortPath.SegmentSeconds(0) * 0.5f).Yaw, 1e-3f);
        }

        [TestMethod]
        public void KeyState_SwivelCutAndHiddenItemsRoundTrip()
        {
            // Round K-C: the key's swivel, cut and hidden items, and the path's follow-between: optional, kept, cleaned
            var key = new CameraKey
            {
                Name = "Stop", X = 1, Swivel = 999f,
                Section = new SectionCut { BoxOn = true, MinX = 0, MinY = 0, MinZ = 0, MaxX = 2, MaxY = 2, MaxZ = 2 },
                Visibility = new VisibilitySettings { HiddenCategories = { "furniture" }, GroundOffset = 1f }
            };
            var path = new CameraPath { FollowBetween = true, Keys = new List<CameraKey> { key, new() { X = 5, Swivel = 0f } } };
            var document = new CameraPathDocument { Model = "Test", Paths = new List<CameraPath> { path } }.Clean();
            Assert.AreEqual(TourSettings.MAX_SWIVEL, key.Swivel);
            Assert.IsNull(path.Keys[1].Swivel, "0 is no swivel");
            Assert.IsNull(key.Visibility.GroundOffset, "keys never move the ground");
            Assert.AreNotSame(key.Visibility, key.Snapshot().Visibility);
            Assert.AreNotSame(key.Section, key.Copy().Section);

            string file = Path.Combine(Path.GetTempPath(), "bimgo-paths-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                Assert.IsTrue(CameraPathFiles.Write(file, document, out string error), error);
                string json = File.ReadAllText(file);
                StringAssert.Contains(json, "\"followBetween\"");
                Assert.AreEqual(1, json.Split("\"swivel\"").Length - 1, "only the key with a swivel writes one");
                CameraPathDocument read = CameraPathFiles.Read(file, out error);
                Assert.IsNotNull(read, error);
                CameraKey back = read.Paths[0].Keys[0];
                Assert.IsTrue(read.Paths[0].FollowBetween);
                Assert.AreEqual(TourSettings.MAX_SWIVEL, back.Swivel);
                Assert.IsTrue(back.Section.BoxOn);
                CollectionAssert.AreEqual(new[] { "furniture" }, back.Visibility.HiddenCategories);
                Assert.IsNull(read.Paths[0].Keys[1].Section);
                Assert.IsNull(read.Paths[0].Keys[1].Visibility);
            }
            finally
            {
                File.Delete(file);
            }

            var copy = new CameraPath();
            copy.CopyFrom(path);
            Assert.IsTrue(copy.FollowBetween, "undo keeps it");
        }

        [TestMethod]
        public void Bimgo_KeepsPathsAndLeavesThemOutWhenNone()
        {
            using var folder = new TempFolder();
            BimGoDocument document = TestData.BuildDocument();
            document.Paths = new CameraPathDocument
            {
                Paths = new List<CameraPath>
                {
                    new() { Name = "Approach", Loop = true, Keys = new List<CameraKey> { new() { X = 1 }, new() { X = 5, HoldSeconds = 2f } } }
                }
            };
            string path = folder.File("paths.bimgo");
            Assert.IsTrue(BimGoWriter.Write(path, document, TestData.Writer, FileKinds.SAVE, out string error), error);
            CollectionAssert.Contains(TestData.EntryNames(path), "paths.json");
            BimGoDocument read = BimGoReader.Read(path, null, out error);
            Assert.IsNotNull(read, error);
            Assert.AreEqual("Approach", read.Paths.Paths.Single().Name);
            Assert.IsTrue(read.Paths.Paths[0].Loop);
            Assert.AreEqual(2f, read.Paths.Paths[0].Keys[1].HoldSeconds);

            document.Paths = new CameraPathDocument();
            string empty = folder.File("none.bimgo");
            Assert.IsTrue(BimGoWriter.Write(empty, document, TestData.Writer, FileKinds.SAVE, out error), error);
            CollectionAssert.DoesNotContain(TestData.EntryNames(empty), "paths.json");
            Assert.IsNull(BimGoReader.Read(empty, null, out error).Paths);
        }
    }
}
