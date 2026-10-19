// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>One lightning strike (Round W-C).</summary>
    public readonly struct LightningStrike
    {
        /// <summary>The strike's number (its time window); unique and increasing.</summary>
        public readonly long Index;

        /// <summary>When it starts (s on the weather clock).</summary>
        public readonly double Start;

        /// <summary>Where in the sky (radians: azimuth from the scene's X axis towards Y; elevation above the horizon).</summary>
        public readonly float Azimuth, Elevation;

        /// <summary>0 = close (bright, big, thunder soon and loud) – 1 = far.</summary>
        public readonly float Distance;

        /// <summary>Flickers in the strike (1–3) and the time between them (s, never under <see cref="LightningStorm.MIN_PULSE_GAP"/>).</summary>
        public readonly int Pulses;

        /// <inheritdoc cref="Pulses"/>
        public readonly float PulseGap;

        /// <summary>A visible bolt (else lightning inside the cloud only).</summary>
        public readonly bool Bolt;

        /// <summary>The bolt's shape (0–1).</summary>
        public readonly float Seed;

        /// <summary>Thunder: seconds after <see cref="Start"/>, and how loud (0–1).</summary>
        public float ThunderDelay => 0.8f + Distance * 5.5f;

        /// <inheritdoc cref="ThunderDelay"/>
        public float ThunderGain => 1f - 0.7f * Distance;

        /// <summary>Creates a strike.</summary>
        public LightningStrike(long index, double start, float azimuth, float elevation, float distance, int pulses, float pulseGap, bool bolt, float seed)
        {
            Index = index;
            Start = start;
            Azimuth = azimuth;
            Elevation = elevation;
            Distance = distance;
            Pulses = pulses;
            PulseGap = pulseGap;
            Bolt = bolt;
            Seed = seed;
        }
    }

    /// <summary>
    /// Round W-C: when and where lightning strikes, worked out from the weather clock alone (so a video frame or a photo
    /// gets the same storm as the walk), and how bright it is at any moment.
    /// <para>Photosensitive-safety limits, always on: at most three flashes in any second (WCAG 2.3.1): a strike flickers
    /// at most three times, at least a third of a second apart, and strikes are at least <see cref="MIN_STRIKE_GAP"/>
    /// apart; every flicker rises and falls smoothly (no hard on / off). With <c>reduceFlashing</c> a strike is one slow
    /// glow instead (over half a second up, a second and a half down).</para>
    /// </summary>
    public static class LightningStorm
    {
        #region Constants

        /// <summary>Frequencies: rare, sometimes, often.</summary>
        public const int RARE = 0, SOMETIMES = 1, OFTEN = 2;

        /// <summary>The time window per frequency (s): at most one strike in each.</summary>
        private static readonly double[] WINDOW = { 40.0, 18.0, 8.0 };

        /// <summary>The chance of a strike in a window, per frequency.</summary>
        private static readonly double[] CHANCE = { 0.7, 0.8, 0.85 };

        /// <summary>Shortest time between a strike's flickers (s): three flashes a second at most.</summary>
        public const float MIN_PULSE_GAP = 0.36f;

        /// <summary>Shortest time between strikes (s).</summary>
        public const double MIN_STRIKE_GAP = 4.0;

        /// <summary>How long a strike's light lasts at most (s): normal, and as a slow glow.</summary>
        public const double FLASH_LENGTH = 2.2, GLOW_LENGTH = 3.0;

        /// <summary>A flicker's rise and fall (s).</summary>
        private const float RISE = 0.06f, FALL = 0.16f;

        /// <summary>The slow glow's rise and fall (s).</summary>
        private const float GLOW_RISE = 0.6f, GLOW_FALL = 1.6f;

        #endregion

        #region Strikes

        /// <summary>The strike in a time window, if any.</summary>
        public static bool TryGetStrike(long window, int frequency, out LightningStrike strike)
        {
            frequency = Math.Clamp(frequency, RARE, OFTEN);
            ulong h = Hash((ulong)window * 3UL + (ulong)frequency);
            strike = default;
            if (Unit(ref h) >= CHANCE[frequency]) { return false; }
            double length = WINDOW[frequency];
            // Starts early enough in its window that the next window's strike is at least MIN_STRIKE_GAP later
            double start = window * length + Unit(ref h) * (length - MIN_STRIKE_GAP - FLASH_LENGTH);
            float distance = (float)Unit(ref h);
            int pulses = 1 + (int)(Unit(ref h) * 3.0);
            float gap = MIN_PULSE_GAP + (float)Unit(ref h) * 0.25f;
            float azimuth = (float)(Unit(ref h) * Math.PI * 2.0);
            float elevation = (float)((8.0 + Unit(ref h) * 26.0) * Math.PI / 180.0);
            bool bolt = Unit(ref h) < 0.75 - 0.4 * distance;
            float seed = (float)Unit(ref h);
            strike = new LightningStrike(window, start, azimuth, elevation, distance, Math.Clamp(pulses, 1, 3), gap, bolt, seed);
            return true;
        }

        /// <summary>
        /// The strike lighting the sky at <paramref name="time"/> (the latest one still glowing), and how bright it is.
        /// </summary>
        /// <param name="time">The weather clock (s).</param>
        /// <param name="frequency">Rare / sometimes / often.</param>
        /// <param name="reduceFlashing">One slow glow per strike instead of flickers.</param>
        /// <param name="strike">The strike (default when none).</param>
        /// <param name="brightness">0–1 (0 when none).</param>
        public static bool Evaluate(double time, int frequency, bool reduceFlashing, out LightningStrike strike, out float brightness)
        {
            frequency = Math.Clamp(frequency, RARE, OFTEN);
            long window = (long)Math.Floor(time / WINDOW[frequency]);
            for (long w = window; w >= window - 1; w--)
            {
                if (!TryGetStrike(w, frequency, out LightningStrike s) || time < s.Start) { continue; }
                float b = Brightness(s, (float)(time - s.Start), reduceFlashing);
                if (b > 0f)
                {
                    strike = s;
                    brightness = b;
                    return true;
                }
            }
            strike = default;
            brightness = 0f;
            return false;
        }

        /// <summary>
        /// A strike's brightness <paramref name="t"/> seconds after it starts (0–1): its flickers, each a smooth rise
        /// and fall, the first the strongest; or one slow glow.
        /// </summary>
        public static float Brightness(in LightningStrike strike, float t, bool reduceFlashing)
        {
            if (t < 0f) { return 0f; }
            if (reduceFlashing)
            {
                if (t >= GLOW_LENGTH) { return 0f; }
                float up = SmoothStep(0f, GLOW_RISE, t);
                float down = t <= GLOW_RISE ? 1f : 1f - SmoothStep(GLOW_RISE, GLOW_RISE + GLOW_FALL, t);
                return 0.6f * up * down;
            }
            if (t >= FLASH_LENGTH) { return 0f; }
            float sum = 0f;
            for (int i = 0; i < strike.Pulses; i++)
            {
                float local = t - i * strike.PulseGap;
                if (local < 0f) { break; }
                float amplitude = i == 0 ? 1f : 0.55f + 0.3f * Frac(strike.Seed * (7.3f + i * 3.1f));
                float rise = SmoothStep(0f, RISE, local);
                float fall = local <= RISE ? 1f : MathF.Exp(-(local - RISE) / FALL);
                sum = MathF.Max(sum, amplitude * rise * fall);
            }
            // The tail fades to nothing by the end (no step)
            float tail = 1f - SmoothStep((float)FLASH_LENGTH - 0.4f, (float)FLASH_LENGTH, t);
            return Math.Clamp(sum * tail, 0f, 1f);
        }

        #endregion

        #region Helpers

        private static ulong Hash(ulong x)
        {
            x += 0x9E3779B97F4A7C15UL;
            x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9UL;
            x = (x ^ (x >> 27)) * 0x94D049BB133111EBUL;
            return x ^ (x >> 31);
        }

        /// <summary>The next 0–1 value from a hash chain.</summary>
        private static double Unit(ref ulong h)
        {
            h = Hash(h);
            return (h >> 11) * (1.0 / (1UL << 53));
        }

        private static float Frac(float x) => x - MathF.Floor(x);

        private static float SmoothStep(float edge0, float edge1, float x)
        {
            float t = Math.Clamp((x - edge0) / (edge1 - edge0), 0f, 1f);
            return t * t * (3f - 2f * t);
        }

        #endregion
    }
}
