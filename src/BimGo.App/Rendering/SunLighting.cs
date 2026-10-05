using System.Numerics;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// The sun and sky for one frame, derived from the sun direction and the user's intensities: the colours the
    /// scene, ground and sky shaders use when sun lighting is on. Values are tuned so a clear midday with every
    /// slider at 100 % reads close to the classic fixed light (ambient ≈ 0.5, direct ≈ 0.6).
    /// </summary>
    internal struct SunLighting
    {
        /// <summary>True when sun lighting (and shadows) are on; false = the classic fixed light.</summary>
        public bool Enabled;

        /// <summary>Unit vector towards the sun, scene axes.</summary>
        public Vector3 SunDirection;

        /// <summary>Direct light colour × intensity (zero below the horizon).</summary>
        public Vector3 SunColour;

        /// <summary>Ambient (sky / diffuse) colour × intensity.</summary>
        public Vector3 SkyColour;

        /// <summary>Sky gradient: overhead and at the horizon (also the fog colour).</summary>
        public Vector3 Zenith, Horizon;

        /// <summary>The sun disc's added colour in the sky (zero when below the horizon).</summary>
        public Vector3 SunDisc;

        /// <summary>How much direct light shadows remove (0–1).</summary>
        public float ShadowStrength;

        /// <summary>Glass transmission multiplier (0–2).</summary>
        public float Glass;

        /// <summary>The sun's altitude in degrees (negative below the horizon).</summary>
        public float AltitudeDegrees;

        /// <summary>
        /// Builds the frame's lighting.
        /// </summary>
        /// <param name="sunDirection">Unit vector towards the sun (scene axes).</param>
        /// <param name="sunIntensity">Direct light multiplier (1 = default).</param>
        /// <param name="skyIntensity">Ambient multiplier (1 = default).</param>
        /// <param name="shadowStrength">0–1.</param>
        /// <param name="glass">0–2.</param>
        public static SunLighting Create(Vector3 sunDirection, float sunIntensity, float skyIntensity, float shadowStrength, float glass)
        {
            float altitude = MathF.Asin(Math.Clamp(sunDirection.Z, -1f, 1f)) * 180f / MathF.PI;

            // Day factor: direct sun fades in over the first few degrees above the horizon
            float day = SmoothStep(-1f, 4f, altitude);
            float high = SmoothStep(4f, 30f, altitude);   // 0 at sunrise colours, 1 at full daylight
            float twilight = SmoothStep(-10f, 2f, altitude);

            // Direct light: warm and weak near the horizon, near-white high up
            Vector3 lowSun = new(1.00f, 0.62f, 0.36f);
            Vector3 highSun = new(1.00f, 0.97f, 0.92f);
            Vector3 sun = Vector3.Lerp(lowSun, highSun, high) * (0.62f * day * Math.Max(sunIntensity, 0f));

            // Sky: night → twilight → day gradients
            Vector3 nightZenith = new(0.025f, 0.035f, 0.07f), nightHorizon = new(0.08f, 0.10f, 0.15f);
            Vector3 duskZenith = new(0.16f, 0.22f, 0.38f), duskHorizon = new(0.93f, 0.66f, 0.48f);
            Vector3 dayZenith = new(0.34f, 0.50f, 0.70f), dayHorizon = new(0.80f, 0.85f, 0.89f);
            Vector3 zenith = Vector3.Lerp(Vector3.Lerp(nightZenith, duskZenith, twilight), dayZenith, high);
            Vector3 horizon = Vector3.Lerp(Vector3.Lerp(nightHorizon, duskHorizon, twilight), dayHorizon, high);

            // Ambient follows the sky's brightness (never fully black, so night scenes stay navigable)
            float ambientLevel = 0.12f + 0.38f * SmoothStep(-10f, 20f, altitude);
            Vector3 skyTint = Vector3.Lerp(new Vector3(0.70f, 0.78f, 1.00f), new Vector3(0.94f, 0.97f, 1.00f), high);
            Vector3 sky = skyTint * (ambientLevel * Math.Max(skyIntensity, 0f));

            return new SunLighting
            {
                Enabled = true,
                SunDirection = sunDirection,
                SunColour = sun,
                SkyColour = sky,
                Zenith = zenith,
                Horizon = horizon,
                SunDisc = Vector3.Lerp(lowSun, highSun, high) * (1.6f * day),
                ShadowStrength = Math.Clamp(shadowStrength, 0f, 1f),
                Glass = Math.Clamp(glass, 0f, 2f),
                AltitudeDegrees = altitude
            };
        }

        private static float SmoothStep(float edge0, float edge1, float x)
        {
            float t = Math.Clamp((x - edge0) / (edge1 - edge0), 0f, 1f);
            return t * t * (3f - 2f * t);
        }
    }
}
