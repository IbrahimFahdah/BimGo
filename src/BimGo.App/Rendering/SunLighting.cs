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

        /// <summary>
        /// Unit vector towards the light that shades the scene and casts the shadows, scene axes: the sun, or (Round
        /// W-A) the moon once the sun is a degree below the horizon.
        /// </summary>
        public Vector3 SunDirection;

        /// <summary>Round W-A: the real sun's direction (the sky's sun disc, glare and the moon's lit side).</summary>
        public Vector3 SkySunDirection;

        /// <summary>Round W-A: towards the moon (scene axes).</summary>
        public Vector3 MoonDirection;

        /// <summary>Round W-A: towards the light on the moon's face (the sun, or a chosen phase's direction).</summary>
        public Vector3 MoonSunDirection;

        /// <summary>Round W-A: the moon disc's colour in the sky (zero when the moon is off).</summary>
        public Vector3 MoonDisc;

        /// <summary>Round W-A: moonlight on the clouds (zero by day or with the moon off or down).</summary>
        public Vector3 MoonGlow;

        /// <summary>Round W-A: true while the moon is the scene's light (shadows from it).</summary>
        public bool MoonLights;

        /// <summary>Round W-A: how dark the sky is for the stars (0 day – 1 night).</summary>
        public float Night;

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
        public static SunLighting Create(Vector3 sunDirection, float sunIntensity, float skyIntensity, float shadowStrength, float glass) =>
            Create(sunDirection, sunIntensity, skyIntensity, shadowStrength, glass, Vector3.UnitZ, 0f, moonOn: false, moonLight: 0f);

        /// <summary>
        /// Round W-A: the frame's lighting with the moon: once the sun is below −1° the moon (when on and up) is the
        /// light, cool and dim by its phase, fading in to −6° (so the light's direction never jumps while lit); a
        /// moonlit night also lifts the ambient and the sky a little.
        /// </summary>
        /// <param name="moonDirection">Towards the moon (scene axes).</param>
        /// <param name="moonLit">The moon's lit fraction (0 new – 1 full).</param>
        /// <param name="moonOn">The moon shows (and lights).</param>
        /// <param name="moonLight">Moonlight multiplier (0–2).</param>
        public static SunLighting Create(Vector3 sunDirection, float sunIntensity, float skyIntensity, float shadowStrength, float glass,
            Vector3 moonDirection, float moonLit, bool moonOn, float moonLight)
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

            // W-A: the moon (its light by phase: a thin crescent still gives a little)
            float night = 1f - SmoothStep(-14f, -2f, altitude);
            float moonAltitude = MathF.Asin(Math.Clamp(moonDirection.Z, -1f, 1f)) * 180f / MathF.PI;
            float moonUp = moonOn ? SmoothStep(-1f, 4f, moonAltitude) : 0f;
            float phase = 0.12f + 0.88f * Math.Clamp(moonLit, 0f, 1f);
            float moonNight = 1f - SmoothStep(-6f, -1f, altitude);
            float moonStrength = moonUp * moonNight * phase * Math.Max(moonLight, 0f);
            Vector3 moonTint = new(0.62f, 0.72f, 0.95f);
            Vector3 lightDirection = sunDirection;
            bool moonLights = altitude < -1f && moonStrength > 0.001f;
            if (moonLights)
            {
                lightDirection = moonDirection;
                sun = moonTint * (MOONLIGHT * moonStrength * Math.Max(sunIntensity, 0f));
            }
            sky += moonTint * (0.06f * moonStrength * Math.Max(skyIntensity, 0f));
            zenith += new Vector3(0.020f, 0.030f, 0.060f) * (moonStrength * night * 0.6f);
            horizon += new Vector3(0.020f, 0.028f, 0.045f) * (moonStrength * night * 0.6f);

            return new SunLighting
            {
                Enabled = true,
                SunDirection = lightDirection,
                SkySunDirection = sunDirection,
                MoonDirection = moonDirection,
                MoonSunDirection = sunDirection,
                MoonDisc = moonOn ? new Vector3(0.96f, 0.94f, 0.88f) * (0.30f + 0.55f * night) : Vector3.Zero,
                MoonGlow = moonTint * (0.35f * moonStrength),
                MoonLights = moonLights,
                Night = night,
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

        /// <summary>
        /// Round W-B: the light under rain or snow clouds: the direct light (sun or moon) dims and its shadows soften,
        /// the sky greys over (lighter for snow), the sun and moon discs fade behind the cloud. Unchanged when off.
        /// </summary>
        /// <param name="lighting">The clear-sky lighting.</param>
        /// <param name="overcast">0 = none, 1 = a heavy storm.</param>
        /// <param name="snow">Snow clouds: a lighter, whiter grey.</param>
        public static SunLighting WithWeather(SunLighting lighting, float overcast, bool snow)
        {
            float o = float.IsFinite(overcast) ? Math.Clamp(overcast, 0f, 1f) : 0f;
            if (!lighting.Enabled || o <= 0f) { return lighting; }
            SunLighting l = lighting;
            l.SunColour *= 1f - 0.6f * o;
            l.ShadowStrength *= 1f - 0.5f * o;
            l.SkyColour *= 1f - (snow ? 0.02f : 0.12f) * o;
            l.Zenith = Vector3.Lerp(l.Zenith, Grey(l.Zenith) * (snow ? 1.25f : 0.95f), 0.75f * o);
            l.Horizon = Vector3.Lerp(l.Horizon, Grey(l.Horizon) * (snow ? 1.08f : 0.9f), 0.7f * o);
            l.SunDisc *= 1f - 0.95f * o;
            l.MoonDisc *= 1f - 0.9f * o;
            l.MoonGlow *= 1f - 0.6f * o;
            return l;

            static Vector3 Grey(Vector3 c)
            {
                float y = Math.Clamp(c.X * 0.30f + c.Y * 0.59f + c.Z * 0.11f, 0f, 1f);
                return new Vector3(y * 0.97f, y, y * 1.03f);
            }
        }

        /// <summary>
        /// Round W-C: a lightning flash: the sky light (ambient) and the sky's colours lifted by a cool white, up to a
        /// capped amount (so the scene brightens softly, never to white). Unchanged when off.
        /// </summary>
        /// <param name="lighting">The frame's lighting.</param>
        /// <param name="amount">0 = none, 1 = the strongest flash allowed.</param>
        public static SunLighting WithLightning(SunLighting lighting, float amount)
        {
            float a = float.IsFinite(amount) ? Math.Clamp(amount, 0f, 1f) : 0f;
            if (!lighting.Enabled || a <= 0.001f) { return lighting; }
            SunLighting l = lighting;
            Vector3 flash = new(0.72f, 0.77f, 0.95f);
            l.SkyColour += flash * (0.5f * a);
            l.Zenith += flash * (0.22f * a);
            l.Horizon += flash * (0.18f * a);
            return l;
        }

        /// <summary>W-A: a full moon's direct light against the sun's (tuned bright enough to walk by, about 1 / 6).</summary>
        private const float MOONLIGHT = 0.10f;

        private static float SmoothStep(float edge0, float edge1, float x)
        {
            float t = Math.Clamp((x - edge0) / (edge1 - edge0), 0f, 1f);
            return t * t * (3f - 2f * t);
        }
    }
}
