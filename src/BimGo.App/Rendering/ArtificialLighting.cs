using System.Numerics;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// This frame's artificial lighting as the shaders take it: up to <see cref="MAX_LIGHTS"/> point lights (picked
    /// and packed by the session each frame, shadow maps assigned by the renderer), the glow multiplier for emissive
    /// surfaces and the bloom strength.
    /// Reused every frame (no allocations).
    /// </summary>
    internal sealed class ArtificialLighting
    {
        /// <summary>Most lights the shaders take (the GLSL arrays in <see cref="Shaders.LIGHTS_GLSL"/> are this size).</summary>
        public const int MAX_LIGHTS = 32;

        /// <summary>xyz position (scene-local), w radius (m).</summary>
        public readonly Vector4[] Position = new Vector4[MAX_LIGHTS];

        /// <summary>rgb colour × intensity, w downward share (0 omni – 1 downlight).</summary>
        public readonly Vector4[] Colour = new Vector4[MAX_LIGHTS];

        /// <summary>x first shadow layer (-1 = unshadowed), y fade (0–1); set by the renderer from <see cref="Key"/>.</summary>
        public readonly Vector4[] Shadow = new Vector4[MAX_LIGHTS];

        /// <summary>Identity of each light across frames (its shadow map is cached under it).</summary>
        public readonly long[] Key = new long[MAX_LIGHTS];

        /// <summary>
        /// Removes light k, keeping the order of the rest.
        /// </summary>
        public void RemoveAt(int k)
        {
            for (int i = k; i < Count - 1; i++)
            {
                Position[i] = Position[i + 1];
                Colour[i] = Colour[i + 1];
                Shadow[i] = Shadow[i + 1];
                Key[i] = Key[i + 1];
            }
            Count--;
        }

        /// <summary>Lights in use this frame (0 = none).</summary>
        public int Count;

        /// <summary>Emissive surface multiplier (0 = glowing surfaces look like any other).</summary>
        public float Emissive;

        /// <summary>Bloom strength (0 = no bloom).</summary>
        public float Bloom;

        /// <summary>
        /// Clears the frame (no lights, no glow).
        /// </summary>
        public void Clear()
        {
            Count = 0;
            Emissive = 0f;
            Bloom = 0f;
        }
    }
}
