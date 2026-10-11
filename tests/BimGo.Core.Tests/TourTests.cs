using System;
using System.Collections.Generic;
using System.Numerics;
using System.Text.Json;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Tour round: the tour timeline (fades, holds, swivel, glides, seeking) and the new bookmark fields.
    /// </summary>
    [TestClass]
    public sealed class TourTests
    {
        private static readonly float Deg = MathF.PI / 180f;

        private static List<TourStop> ThreeStops(float swivelDegrees = 0f) => new()
        {
            new TourStop(new Vector3(0, 0, 0), 1.62f, 0f, 0f, 4f, swivelDegrees * Deg),
            new TourStop(new Vector3(10, 0, 0), 1.20f, MathF.PI / 2, 0.1f, 2f, swivelDegrees * Deg),
            new TourStop(new Vector3(10, 10, 3), 1.62f, MathF.PI, 0f, 3f, swivelDegrees * Deg)
        };

        [TestMethod]
        public void Fade_DurationIsHoldsPlusTwoFadesPerStop()
        {
            var timeline = new TourTimeline(ThreeStops(), TourTransition.Fade, 0.5f, 3f);
            Assert.AreEqual(3, timeline.Count);
            Assert.AreEqual(4f + 2f + 3f + 6 * 0.5f, timeline.Duration, 1e-4f);
            Assert.AreEqual(0f, timeline.StartOf(0), 1e-5f);
            Assert.AreEqual(5f, timeline.StartOf(1), 1e-5f, "0.5 in + 4 hold + 0.5 out");
            Assert.AreEqual(8f, timeline.StartOf(2), 1e-5f);
        }

        [TestMethod]
        public void Fade_BlackAtTheEdgesClearInTheHold()
        {
            var timeline = new TourTimeline(ThreeStops(), TourTransition.Fade, 0.5f, 3f);
            Assert.AreEqual(1f, timeline.Evaluate(0f).Black, 1e-4f, "starts black");
            Assert.AreEqual(0.5f, timeline.Evaluate(0.25f).Black, 1e-4f, "half-way through the fade in");
            Assert.AreEqual(0f, timeline.Evaluate(2f).Black, 1e-4f, "holding");
            Assert.AreEqual(0.5f, timeline.Evaluate(4.75f).Black, 1e-4f, "half-way through the fade out");

            TourPose next = timeline.Evaluate(5.01f);
            Assert.AreEqual(1, next.Stop, "the stop changes at black");
            Assert.IsTrue(next.Black > 0.9f);
            Assert.AreEqual(10f, next.Feet.X, 1e-4f);
            Assert.AreEqual(1.20f, next.EyeHeight, 1e-4f, "each stop keeps its own eye height");
        }

        [TestMethod]
        public void Fade_SwivelEasesAcrossTheVisibleStop()
        {
            var timeline = new TourTimeline(ThreeStops(30f), TourTransition.Fade, 0.5f, 3f);
            Assert.AreEqual(0f, timeline.Evaluate(0f).Yaw, 1e-4f, "no pan at the start");
            Assert.AreEqual(15f * Deg, timeline.Evaluate(2.5f).Yaw, 1e-3f, "half the pan half-way (smoothstep is symmetric)");
            Assert.AreEqual(30f * Deg, timeline.Evaluate(4.999f).Yaw, 1e-3f, "the full pan at the end");
            float early = timeline.Evaluate(0.25f).Yaw;
            Assert.IsTrue(early > 0f && early < 30f * Deg * 0.05f, "eased in: slower than a linear pan at first");
        }

        [TestMethod]
        public void Finished_PastTheEnd()
        {
            var timeline = new TourTimeline(ThreeStops(), TourTransition.Fade, 0.5f, 3f);
            TourPose end = timeline.Evaluate(timeline.Duration + 1f);
            Assert.IsTrue(end.Finished);
            Assert.AreEqual(2, end.Stop);
            Assert.AreEqual(1f, end.Black, 1e-4f);
            Assert.IsFalse(timeline.Evaluate(timeline.Duration - 0.01f).Finished);
        }

        [TestMethod]
        public void Glide_FlysBetweenStopsTheShortWayRound()
        {
            var stops = new List<TourStop>
            {
                new TourStop(new Vector3(0, 0, 0), 1.6f, 170f * Deg, 0f, 2f, 0f),
                new TourStop(new Vector3(4, 0, 0), 1.2f, -170f * Deg, 0f, 2f, 0f)
            };
            var timeline = new TourTimeline(stops, TourTransition.Glide, 0.5f, 2f);
            // 0.5 fade in + 2 hold + 2 glide (4 m at 4 m/s is 1 s, so the set 2 s wins) + 2 hold + 0.5 fade out
            Assert.AreEqual(7f, timeline.Duration, 1e-4f);
            Assert.AreEqual(2.5f, timeline.StartOf(1), 1e-4f, "the glide into stop 2 starts after the first hold");

            TourPose middle = timeline.Evaluate(3.5f);
            Assert.IsTrue(middle.Moving);
            Assert.AreEqual(1, middle.Stop, "a glide belongs to the stop it flies to");
            Assert.AreEqual(2f, middle.Feet.X, 1e-3f, "half-way along");
            Assert.AreEqual(1.4f, middle.EyeHeight, 1e-3f, "eye height blends");
            float yaw = MathF.Abs(middle.Yaw);
            Assert.AreEqual(MathF.PI, yaw, 1e-3f, "through 180°, not back through 0°");
            Assert.AreEqual(0f, middle.Black, 1e-5f, "no fade mid-tour");
            Assert.AreEqual(0.5f, timeline.Evaluate(6.75f).Black, 1e-4f, "the last stop fades out");
        }

        [TestMethod]
        public void Glide_FarStopsGlideLonger()
        {
            var stops = new List<TourStop>
            {
                new TourStop(Vector3.Zero, 1.6f, 0f, 0f, 1f, 0f),
                new TourStop(new Vector3(40, 0, 0), 1.6f, 0f, 0f, 1f, 0f)
            };
            var timeline = new TourTimeline(stops, TourTransition.Glide, 0f, 2f);
            Assert.AreEqual(1f + 40f / TourTimeline.GLIDE_SPEED + 1f, timeline.Duration, 1e-4f);
        }

        [TestMethod]
        public void StopAt_AndEmptyTours()
        {
            var timeline = new TourTimeline(ThreeStops(), TourTransition.Fade, 0.5f, 3f);
            Assert.AreEqual(0, timeline.StopAt(0f));
            Assert.AreEqual(1, timeline.StopAt(5f));
            Assert.AreEqual(2, timeline.StopAt(100f));

            var empty = new TourTimeline(new List<TourStop>(), TourTransition.Fade, 0.5f, 3f);
            Assert.AreEqual(0f, empty.Duration);
            Assert.IsTrue(empty.Evaluate(0f).Finished);
            Assert.AreEqual(-1, empty.StopAt(0f));
        }

        [TestMethod]
        public void LerpAngle_WrapsAndSmoothIsClamped()
        {
            Assert.AreEqual(0f, TourTimeline.Smooth(-1f));
            Assert.AreEqual(1f, TourTimeline.Smooth(2f));
            Assert.AreEqual(0.5f, TourTimeline.Smooth(0.5f), 1e-6f);
            // 175° → −165° is 20° the short way: half-way is 185° (= −175°), not 5°
            Assert.AreEqual(185f * Deg, TourTimeline.LerpAngle(175f * Deg, -165f * Deg, 0.5f), 1e-4f);
            Assert.AreEqual(5f * Deg, TourTimeline.LerpAngle(-5f * Deg, 15f * Deg, 0.5f), 1e-4f);
        }

        [TestMethod]
        public void TourSettings_ResolvesOverridesAndCleans()
        {
            var settings = new TourSettings { HoldSeconds = 5f, Swivel = true, SwivelDegrees = 20f, SwivelDirection = TourSwivelDirection.Right };
            var plain = new BookmarkRecord();
            var custom = new BookmarkRecord { TourHold = 9f, TourSwivel = 0f };
            Assert.AreEqual(5f, settings.HoldFor(plain));
            Assert.AreEqual(-20f, settings.SwivelFor(plain), "right is negative");
            Assert.AreEqual(9f, settings.HoldFor(custom));
            Assert.AreEqual(0f, settings.SwivelFor(custom), "a bookmark can switch its swivel off");
            settings.Swivel = false;
            Assert.AreEqual(0f, settings.SwivelFor(plain));

            var bad = new TourSettings { HoldSeconds = 0f, FadeSeconds = float.NaN, GlideSeconds = 99f, SwivelDegrees = 720f, Transition = (TourTransition)9 }.Clean();
            Assert.AreEqual(TourSettings.MIN_HOLD, bad.HoldSeconds);
            Assert.AreEqual(0.6f, bad.FadeSeconds, 1e-6f);
            Assert.AreEqual(TourSettings.MAX_GLIDE, bad.GlideSeconds);
            Assert.AreEqual(TourSettings.MAX_SWIVEL, bad.SwivelDegrees);
            Assert.AreEqual(TourTransition.Fade, bad.Transition);
        }

        [TestMethod]
        public void BookmarkDocument_RoundTripsTheTourFieldsAndReadsOldFiles()
        {
            var options = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                PropertyNameCaseInsensitive = true,
                DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
            };
            options.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase));

            var document = new BookmarkDocument
            {
                Tour = new TourSettings { Transition = TourTransition.Glide, Loop = true },
                Bookmarks =
                {
                    new BookmarkRecord
                    {
                        Name = "Kitchen", EyeHeight = 1.2f, TourHold = 6f, TourSwivel = -45f, TourSkip = true,
                        Visibility = new VisibilitySettings { HiddenCategories = { "furniture" }, GroundOffset = 2f }
                    }
                }
            };
            string json = JsonSerializer.Serialize(document, options);
            StringAssert.Contains(json, "\"transition\":\"glide\"");
            BookmarkDocument back = JsonSerializer.Deserialize<BookmarkDocument>(json, options).Clean();
            BookmarkRecord kitchen = back.Bookmarks[0];
            Assert.AreEqual(1.2f, kitchen.EyeHeight);
            Assert.AreEqual(6f, kitchen.TourHold);
            Assert.AreEqual(-45f, kitchen.TourSwivel);
            Assert.IsTrue(kitchen.TourSkip);
            CollectionAssert.AreEqual(new[] { "furniture" }, kitchen.Visibility.HiddenCategories);
            Assert.IsNull(kitchen.Visibility.GroundOffset, "bookmarks never move the ground");
            Assert.AreEqual(TourTransition.Glide, back.Tour.Transition);
            Assert.IsTrue(back.Tour.Loop);

            // A bookmark file from before the tour round: everything optional stays null
            const string old = "{\"version\":1,\"bookmarks\":[{\"name\":\"Old\",\"x\":1,\"y\":2,\"z\":3,\"yaw\":0.5,\"pitch\":0}]}";
            BookmarkDocument legacy = JsonSerializer.Deserialize<BookmarkDocument>(old, options).Clean();
            Assert.IsNull(legacy.Tour);
            Assert.IsNull(legacy.Bookmarks[0].Visibility);
            Assert.IsNull(legacy.Bookmarks[0].EyeHeight);
            Assert.IsNull(legacy.Bookmarks[0].TourHold);
            Assert.IsFalse(legacy.Bookmarks[0].TourSkip);
        }

        [TestMethod]
        public void EyeHeights_DefaultsClampAndPresets()
        {
            var settings = new LaunchSettings();
            Assert.AreEqual(EyePreset.Standing, settings.EyePreset);
            Assert.AreEqual(1.62f, settings.EyeHeightFor(EyePreset.Standing));
            Assert.AreEqual(1.20f, settings.EyeHeightFor(EyePreset.Seated));
            Assert.AreEqual(1.10f, settings.EyeHeightFor(EyePreset.Child));

            settings.SetEyeHeight(EyePreset.Seated, 1.234f);
            Assert.AreEqual(1.23f, settings.EyeHeightSeated, 1e-5f, "rounded to the centimetre");

            settings.EyeHeightChild = 0.2f;
            settings.EyeHeightStanding = float.NaN;
            settings.EyePreset = (EyePreset)7;
            settings.Sanitise();
            Assert.AreEqual(LaunchSettings.MIN_EYE_HEIGHT, settings.EyeHeightChild, 1e-5f);
            Assert.AreEqual(LaunchSettings.DEFAULT_EYE_STANDING, settings.EyeHeightStanding, 1e-5f);
            Assert.AreEqual(EyePreset.Standing, settings.EyePreset);
        }

        [TestMethod]
        public void VideoSettings_DefaultAndSanitise()
        {
            var settings = new LaunchSettings();
            Assert.AreEqual(VideoSize.FullHd, settings.VideoSize, "1080p by default");
            Assert.AreEqual(30, settings.VideoFps);
            settings.VideoFps = 50;
            settings.VideoSize = (VideoSize)9;
            settings.Sanitise();
            Assert.AreEqual(60, settings.VideoFps, "rounded to 30 or 60");
            Assert.AreEqual(VideoSize.FullHd, settings.VideoSize);
            settings.VideoFps = 12;
            settings.Sanitise();
            Assert.AreEqual(30, settings.VideoFps);
        }

        [TestMethod]
        public void BookmarkDocument_ClampsHandEditedValues()
        {
            var document = new BookmarkDocument
            {
                Bookmarks = { new BookmarkRecord { Name = "A", EyeHeight = 9f, TourHold = 0.1f, TourSwivel = float.NaN } }
            }.Clean();
            Assert.AreEqual(TourSettings.MAX_EYE_HEIGHT, document.Bookmarks[0].EyeHeight);
            Assert.AreEqual(TourSettings.MIN_HOLD, document.Bookmarks[0].TourHold);
            Assert.IsNull(document.Bookmarks[0].TourSwivel);
        }
    }
}
