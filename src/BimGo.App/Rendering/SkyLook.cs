using System.Numerics;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// Sky round: how the sky looks this frame: cloud cover and drift, the sun disc's size and glare. A look only:
    /// the scene's lighting doesn't change with it.
    /// </summary>
    internal struct SkyLook
    {
        /// <summary>The disc's outer and inner edge at size 1 (radians): fades from 0 at the outer edge to full at the inner.</summary>
        public const float DISC_OUTER = 0.0300f, DISC_INNER = 0.0224f;

        /// <summary>0 = clear, 1 = overcast.</summary>
        public float CloudCover;

        /// <summary>Where the cloud pattern has drifted to (noise units).</summary>
        public Vector2 CloudOffset;

        /// <summary>Sun disc size multiplier (1 = default).</summary>
        public float SunSize;

        /// <summary>Glare (halo) multiplier (1 = default, 0 = none).</summary>
        public float SunGlare;

        /// <summary>Round W-A: stars (density, brightness, twinkle, Milky Way; density 0 = none).</summary>
        public Vector4 Stars;

        /// <summary>Round W-A: the clock for the twinkle (seconds, wrapped).</summary>
        public float Time;

        /// <summary>Round W-A: the equatorial axes in scene axes (a sky direction's dot with each = its equatorial coordinates).</summary>
        public Vector3 CelestialX, CelestialY, CelestialZ;

        /// <summary>Round W-C: lightning: towards the strike (xyz, scene axes) and its brightness (w, 0 = none).</summary>
        public Vector4 Lightning;

        /// <summary>Round W-C: the bolt: shape seed, 1 = visible, the lit zone's radius (rad), unused.</summary>
        public Vector4 Bolt;

        /// <summary>No clouds, the default disc.</summary>
        public static readonly SkyLook Default = new() { SunSize = 1f, SunGlare = 1f };
    }
}
