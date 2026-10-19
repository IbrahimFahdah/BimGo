using System;
using System.Collections.Generic;
using System.Text.Json;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Round W-C: the lightning storm (when strikes come, how bright, the photosensitive-safety limits) and its settings.
    /// </summary>
    [TestClass]
    public sealed class LightningTests
    {
        /// <summary>The times flashes start: brightness rising through 0.3 after it fell below 0.15 (1 ms steps).</summary>
        private static List<double> FlashStarts(double from, double to, int frequency, bool reduce)
        {
            var starts = new List<double>();
            bool armed = true;
            for (double t = from; t < to; t += 0.001)
            {
                LightningStorm.Evaluate(t, frequency, reduce, out _, out float b);
                if (armed && b >= 0.3f) { starts.Add(t); armed = false; }
                else if (!armed && b < 0.15f) { armed = true; }
            }
            return starts;
        }

        [TestMethod]
        public void NeverMoreThanThreeFlashesInAnySecond()
        {
            for (int frequency = LightningStorm.RARE; frequency <= LightningStorm.OFTEN; frequency++)
            {
                List<double> starts = FlashStarts(0.0, 600.0, frequency, reduce: false);
                Assert.IsTrue(starts.Count > 3, $"frequency {frequency}: {starts.Count} flashes in 10 minutes");
                for (int i = 3; i < starts.Count; i++)
                {
                    Assert.IsTrue(starts[i] - starts[i - 3] > 1.0, $"four flashes within a second at {starts[i - 3]:0.000} s");
                }
            }
        }

        [TestMethod]
        public void ReduceFlashing_OneSlowGlowPerStrike()
        {
            List<double> starts = FlashStarts(0.0, 600.0, LightningStorm.OFTEN, reduce: true);
            Assert.IsTrue(starts.Count > 20);
            for (int i = 1; i < starts.Count; i++) { Assert.IsTrue(starts[i] - starts[i - 1] >= LightningStorm.MIN_STRIKE_GAP - 0.01); }

            // No fast change: under 2 per second (full scale) anywhere
            float previous = 0f;
            for (double t = 0.0; t < 300.0; t += 0.01)
            {
                LightningStorm.Evaluate(t, LightningStorm.OFTEN, true, out _, out float b);
                Assert.IsTrue(MathF.Abs(b - previous) < 0.02f, $"jump at {t:0.00} s");
                Assert.IsTrue(b <= 0.6f + 1e-4f);
                previous = b;
            }
        }

        [TestMethod]
        public void SameClock_SameStorm_OftenMeansMore()
        {
            LightningStorm.Evaluate(1234.567, LightningStorm.SOMETIMES, false, out LightningStrike a, out float ba);
            LightningStorm.Evaluate(1234.567, LightningStorm.SOMETIMES, false, out LightningStrike b, out float bb);
            Assert.AreEqual(a.Index, b.Index);
            Assert.AreEqual(ba, bb);

            int Count(int frequency)
            {
                int n = 0;
                for (long w = 0; w < 100000; w++)
                {
                    if (LightningStorm.TryGetStrike(w, frequency, out LightningStrike s) && s.Start < 3600.0) { n++; }
                }
                return n;
            }
            int rare = Count(LightningStorm.RARE), sometimes = Count(LightningStorm.SOMETIMES), often = Count(LightningStorm.OFTEN);
            Assert.IsTrue(rare < sometimes && sometimes < often, $"{rare} / {sometimes} / {often} an hour");
            Assert.IsTrue(rare >= 40 && often <= 450, $"{rare} / {often} an hour");

            Assert.IsTrue(LightningStorm.TryGetStrike(7, LightningStorm.OFTEN, out LightningStrike s) || LightningStorm.TryGetStrike(8, LightningStorm.OFTEN, out s));
            Assert.IsTrue(s.Pulses is >= 1 and <= 3);
            Assert.IsTrue(s.PulseGap >= LightningStorm.MIN_PULSE_GAP);
            Assert.IsTrue(s.Elevation > 0.1f && s.Elevation < 0.7f);
            Assert.IsTrue(s.ThunderDelay >= 0.8f && s.ThunderGain > 0f);
            Assert.AreEqual(0f, LightningStorm.Brightness(s, (float)LightningStorm.FLASH_LENGTH, false));
        }

        [TestMethod]
        public void LightningSettings_DefaultCleanCopyAndOlderFiles()
        {
            var sun = new SunSettings();
            Assert.IsFalse(sun.Lightning || sun.ReduceFlashing);
            Assert.IsTrue(sun.LensDrops && sun.WeatherSound);
            Assert.AreEqual(1, sun.LightningFrequency);

            var bad = new SunSettings { LightningFrequency = 9, LightningFlash = float.NaN }.Clean();
            Assert.AreEqual(2, bad.LightningFrequency);
            Assert.AreEqual(0.35f, bad.LightningFlash);

            SunSettings copy = new SunSettings { Lightning = true, LightningFrequency = 0, LightningFlash = 0.8f, ReduceFlashing = true, LensDrops = false, WeatherSound = false }.Copy();
            Assert.IsTrue(copy.Lightning && copy.ReduceFlashing);
            Assert.IsFalse(copy.LensDrops || copy.WeatherSound);
            Assert.AreEqual(0, copy.LightningFrequency);
            Assert.AreEqual(0.8f, copy.LightningFlash);

            SunSettings old = JsonSerializer.Deserialize<SunSettings>("{\"Weather\":\"rain\"}").Clean();
            Assert.IsFalse(old.Lightning, "files from W-B get no lightning");
            Assert.IsTrue(old.LensDrops && old.WeatherSound);
        }
    }
}
