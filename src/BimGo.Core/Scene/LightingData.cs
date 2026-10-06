using System.Numerics;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Artificial lighting captured at extraction: which vertices glow (emissive runs) and where the light fixtures'
    /// lights are. Optional: older files and models without lighting fixtures have none (<see cref="Empty"/>).
    /// </summary>
    public sealed class LightingData
    {
        /// <summary>No emissive surfaces and no lights.</summary>
        public static readonly LightingData Empty = new();

        /// <summary>Contiguous vertex ranges that glow, in vertex order (non-overlapping).</summary>
        public EmissiveRun[] Emissive { get; init; } = Array.Empty<EmissiveRun>();

        /// <summary>One light per lighting fixture element (at most).</summary>
        public LightSource[] Lights { get; init; } = Array.Empty<LightSource>();

        /// <summary>True if there is nothing to draw.</summary>
        public bool IsEmpty => Emissive.Length == 0 && Lights.Length == 0;

        /// <summary>
        /// Packs an emissive colour and strength into the per-vertex RGBA8 the renderer uploads:
        /// RGB = colour (scaled so its brightest channel is 255), A = strength / <see cref="MAX_STRENGTH"/>.
        /// </summary>
        /// <param name="colour">Linear-ish RGB 0–1 (any scale; normalised here).</param>
        /// <param name="strength">Glow strength, 0–<see cref="MAX_STRENGTH"/> (1 ≈ a softly glowing lens).</param>
        public static uint PackEmissive(Vector3 colour, float strength)
        {
            float peak = MathF.Max(colour.X, MathF.Max(colour.Y, colour.Z));
            Vector3 c = peak > 1e-4f ? colour / peak : Vector3.One;
            byte r = (byte)Math.Clamp((int)MathF.Round(c.X * 255f), 0, 255);
            byte g = (byte)Math.Clamp((int)MathF.Round(c.Y * 255f), 0, 255);
            byte b = (byte)Math.Clamp((int)MathF.Round(c.Z * 255f), 0, 255);
            byte a = (byte)Math.Clamp((int)MathF.Round(strength / MAX_STRENGTH * 255f), 1, 255);
            return r | ((uint)g << 8) | ((uint)b << 16) | ((uint)a << 24);
        }

        /// <summary>The strength an emissive alpha of 255 stands for.</summary>
        public const float MAX_STRENGTH = 4f;

        /// <summary>
        /// Glow strength from a Revit self-illumination luminance (cd/m²): logarithmic, so a dim 10 cd/m² sign and a
        /// 10 000 cd/m² lamp both read sensibly (≈ 0.5 and 3).
        /// </summary>
        public static float StrengthFromLuminance(float luminance) =>
            Math.Clamp(MathF.Log10(MathF.Max(luminance, 1f)) - 1f, 0.5f, MAX_STRENGTH);

        /// <summary>
        /// An approximate RGB (brightest channel 1) for a colour temperature in kelvin (1000–15000 K).
        /// </summary>
        public static Vector3 KelvinToRgb(float kelvin)
        {
            // Tanner Helland's fit of the blackbody locus, in 0–255 then normalised
            float t = Math.Clamp(kelvin, 1000f, 15000f) / 100f;
            float r, g, b;
            if (t <= 66f)
            {
                r = 255f;
                g = 99.4708025861f * MathF.Log(t) - 161.1195681661f;
                b = t <= 19f ? 0f : 138.5177312231f * MathF.Log(t - 10f) - 305.0447927307f;
            }
            else
            {
                r = 329.698727446f * MathF.Pow(t - 60f, -0.1332047592f);
                g = 288.1221695283f * MathF.Pow(t - 60f, -0.0755148492f);
                b = 255f;
            }
            var rgb = new Vector3(Math.Clamp(r, 0f, 255f), Math.Clamp(g, 0f, 255f), Math.Clamp(b, 0f, 255f)) / 255f;
            float peak = MathF.Max(rgb.X, MathF.Max(rgb.Y, rgb.Z));
            return peak > 0f ? rgb / peak : Vector3.One;
        }
    }

    /// <summary>
    /// A contiguous range of vertices that glow with one colour and strength.
    /// </summary>
    /// <param name="Start">First vertex (index into <see cref="SceneData.Vertices"/>).</param>
    /// <param name="Count">Number of vertices.</param>
    /// <param name="Emissive">Packed colour and strength (<see cref="LightingData.PackEmissive"/>).</param>
    public readonly record struct EmissiveRun(int Start, int Count, uint Emissive);

    /// <summary>
    /// A light emitted by a lighting fixture: a point light with an optional downward lobe.
    /// </summary>
    public sealed class LightSource
    {
        /// <summary>The fixture element (index into <see cref="SceneData.Elements"/>): hiding / moving it affects the light.</summary>
        public int Element { get; init; }

        /// <summary>Where the light emits from (scene-local metres).</summary>
        public Vector3 Position { get; init; }

        /// <summary>Luminous flux (lumens): from the fixture's parameters when readable, else an estimate.</summary>
        public float Lumens { get; init; } = 1000f;

        /// <summary>Colour temperature (kelvin).</summary>
        public float Kelvin { get; init; } = 3500f;

        /// <summary>
        /// 0 = emits equally in every direction, 1 = all downwards (a cosine lobe, like a downlight or panel).
        /// </summary>
        public float Downward { get; init; } = 0.7f;

        /// <summary>True when the position / output were guessed (no emissive material, no readable parameters).</summary>
        public bool Estimated { get; init; }
    }
}
