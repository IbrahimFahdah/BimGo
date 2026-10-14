using System.Numerics;
using BimGo.Scene;

// The class belongs to the Clashes namespace
namespace BimGo.Clashes
{
    /// <summary>
    /// Where GO puts the camera and the section box for a clash.
    /// </summary>
    /// <param name="Section">The section box (scene-local): the clash region grown by the margin.</param>
    /// <param name="Eye">The eye (scene-local).</param>
    /// <param name="Yaw">Yaw (radians, 0 = +X, CCW).</param>
    /// <param name="Pitch">Pitch (radians, negative looks down).</param>
    public readonly record struct ClashView(Aabb Section, Vector3 Eye, float Yaw, float Pitch);

    /// <summary>
    /// Framing a clash (Round C-B): the section box around the clash region and a camera about 2.5 m back, looking at
    /// the clash point from the side that sees it best. Pure maths; the caller supplies a line-of-sight test.
    /// </summary>
    public static class ClashFraming
    {
        /// <summary>The section box margin around the clash region (metres).</summary>
        public const float MARGIN = 1f;

        /// <summary>The section box's smallest size along any axis (metres).</summary>
        public const float MIN_SIZE = 2f;

        /// <summary>How far back the camera stands (metres).</summary>
        public const float DISTANCE = 2.5f;

        /// <summary>How far the camera looks down at the clash (radians, 20°).</summary>
        public const float DOWN_PITCH = 0.349f;

        /// <summary>
        /// The section box for a clash: where the two elements' boxes meet (a gap for clearance clashes: the space
        /// between them), with the point included, grown by <paramref name="margin"/> and at least
        /// <see cref="MIN_SIZE"/> along every axis.
        /// </summary>
        public static Aabb SectionFor(in Aabb a, in Aabb b, Vector3 point, float margin = MARGIN)
        {
            // The overlap, or (clearance) the gap: the two boxes grown just enough to meet
            Vector3 gap = Vector3.Max(Vector3.Zero, Vector3.Max(a.Min - b.Max, b.Min - a.Max));
            float reach = MathF.Max(gap.X, MathF.Max(gap.Y, gap.Z)) * 0.5f + 0.01f;
            var region = new Aabb(Vector3.Max(a.Min, b.Min) - new Vector3(reach), Vector3.Min(a.Max, b.Max) + new Vector3(reach));
            if (!region.IsValid) { region = new Aabb(point, point); }
            region.Include(point);

            Vector3 min = region.Min - new Vector3(margin), max = region.Max + new Vector3(margin);
            Vector3 centre = (min + max) * 0.5f, half = Vector3.Max((max - min) * 0.5f, new Vector3(MIN_SIZE * 0.5f));
            return new Aabb(centre - half, centre + half);
        }

        /// <summary>
        /// The camera for a clash: eight directions around the point (looking down 20°), scored by: a clear line of
        /// sight to the point (<paramref name="clear"/>), the eye outside both elements' boxes, looking across the
        /// elements' long axes rather than along them, then the smallest turn from <paramref name="currentYaw"/>.
        /// </summary>
        /// <param name="point">The clash point (scene-local).</param>
        /// <param name="a">Element A's box.</param>
        /// <param name="b">Element B's box.</param>
        /// <param name="section">The section box (the camera may stand outside it: the cut opens the view).</param>
        /// <param name="currentYaw">The player's yaw now.</param>
        /// <param name="clear">True when nothing blocks the segment from an eye to the point (may be null).</param>
        /// <param name="distance">How far back.</param>
        public static ClashView Frame(Vector3 point, in Aabb a, in Aabb b, in Aabb section, float currentYaw,
            Func<Vector3, Vector3, bool> clear = null, float distance = DISTANCE)
        {
            Vector3 axisA = LongAxis(a), axisB = LongAxis(b);
            float cp = MathF.Cos(DOWN_PITCH), sp = MathF.Sin(DOWN_PITCH);

            float bestScore = float.MinValue;
            ClashView best = default;
            for (int k = 0; k < 8; k++)
            {
                float yaw = k * MathF.PI / 4f;
                var look = new Vector3(cp * MathF.Cos(yaw), cp * MathF.Sin(yaw), -sp);
                Vector3 eye = point - look * distance;

                float score = 0f;
                if (clear == null || clear(eye, point)) { score += 4f; }
                if (!Contains(a, eye) && !Contains(b, eye)) { score += 2f; }
                var flat = new Vector3(look.X, look.Y, 0f);
                score += 1f - 0.5f * (MathF.Abs(Vector3.Dot(flat, axisA)) + MathF.Abs(Vector3.Dot(flat, axisB)));
                score -= 0.1f * MathF.Abs(AngleBetween(yaw, currentYaw)) / MathF.PI;

                if (score > bestScore)
                {
                    bestScore = score;
                    best = new ClashView(section, eye, NormaliseYaw(yaw), -DOWN_PITCH);
                }
            }
            return best;
        }

        /// <summary>
        /// How far back to stand to see a whole box (Round C-B3: several clashes framed together): far enough that the
        /// box's bounding sphere fits the narrower field of view, never closer than <see cref="DISTANCE"/>.
        /// </summary>
        /// <param name="box">The box to see (the section boxes of every selected clash together).</param>
        /// <param name="horizontalFovDegrees">The camera's horizontal field of view.</param>
        /// <param name="aspect">Width / height of the view.</param>
        public static float DistanceToSee(in Aabb box, float horizontalFovDegrees, float aspect)
        {
            if (!box.IsValid) { return DISTANCE; }
            float radius = box.Size.Length() * 0.5f;
            float halfH = Math.Clamp(horizontalFovDegrees, 20f, 150f) * MathF.PI / 360f;
            float halfV = MathF.Atan(MathF.Tan(halfH) / MathF.Max(aspect, 0.1f));
            float half = MathF.Min(halfH, halfV);
            return MathF.Max(DISTANCE, radius / MathF.Sin(half) * 1.05f);
        }

        /// <summary>The horizontal unit axis a box is longest along (zero for a box longest vertically).</summary>
        public static Vector3 LongAxis(in Aabb box)
        {
            Vector3 size = box.Size;
            if (size.Z >= size.X && size.Z >= size.Y) { return Vector3.Zero; }
            return size.X >= size.Y ? Vector3.UnitX : Vector3.UnitY;
        }

        private static bool Contains(in Aabb box, Vector3 p) =>
            p.X >= box.Min.X && p.X <= box.Max.X && p.Y >= box.Min.Y && p.Y <= box.Max.Y && p.Z >= box.Min.Z && p.Z <= box.Max.Z;

        /// <summary>The signed smallest angle from <paramref name="from"/> to <paramref name="to"/> (radians, −π..π).</summary>
        public static float AngleBetween(float to, float from)
        {
            float d = (to - from) % MathF.Tau;
            if (d > MathF.PI) { d -= MathF.Tau; }
            if (d < -MathF.PI) { d += MathF.Tau; }
            return d;
        }

        /// <summary>A yaw in −π..π.</summary>
        public static float NormaliseYaw(float yaw) => AngleBetween(yaw, 0f);
    }
}
