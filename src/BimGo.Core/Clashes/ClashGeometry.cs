using System.Numerics;

// The class belongs to the Clashes namespace
namespace BimGo.Clashes
{
    /// <summary>
    /// A triangle prepared for clash tests: corners, bounds and unit normal (zero for a degenerate triangle).
    /// The engine stores corners relative to the pair's centre, so the float maths stays well conditioned.
    /// </summary>
    public struct ClashTriangle
    {
        public Vector3 A, B, C;
        public Vector3 Min, Max;
        public Vector3 Normal;

        /// <summary>Builds a triangle from its corners.</summary>
        public static ClashTriangle Make(Vector3 a, Vector3 b, Vector3 c)
        {
            Vector3 n = Vector3.Cross(b - a, c - a);
            float length = n.Length();
            return new ClashTriangle
            {
                A = a,
                B = b,
                C = c,
                Min = Vector3.Min(a, Vector3.Min(b, c)),
                Max = Vector3.Max(a, Vector3.Max(b, c)),
                Normal = length > 1e-12f ? n / length : Vector3.Zero
            };
        }

        /// <summary>True when the triangle has no area.</summary>
        public readonly bool IsDegenerate => Normal == Vector3.Zero;
    }

    /// <summary>
    /// Clash geometry (Round C): triangle–triangle crossing with its segment, triangle–triangle distance, point-in-solid.
    /// Own implementations of published methods: Möller's interval test for triangle–triangle intersection (Möller,
    /// "A Fast Triangle-Triangle Intersection Test", 1997), closest points on a triangle and between segments (the
    /// standard region / clamping formulas, as in Ericson, "Real-Time Collision Detection", 2005, ch. 5), Möller–Trumbore
    /// ray–triangle intersection (1997) and the even–odd ray parity rule for inside tests.
    /// Pure functions, no allocations, thread-safe.
    /// </summary>
    public static class ClashGeometry
    {
        /// <summary>Distances below this (metres) count as zero (on the plane, touching).</summary>
        public const float EPSILON = 1e-6f;

        #region Triangle–triangle crossing

        /// <summary>
        /// True when two triangles meet across their planes (each reaches the other's plane and their spans on the
        /// planes' common line overlap). Coplanar triangles only touch: they never count. <paramref name="p"/>–<paramref name="q"/>
        /// is the shared segment (one point when they meet at a single point).
        /// </summary>
        public static bool Crosses(in ClashTriangle t, in ClashTriangle u, out Vector3 p, out Vector3 q) => Crosses(t, u, out p, out q, out _);

        /// <summary>
        /// As <see cref="Crosses(in ClashTriangle, in ClashTriangle, out Vector3, out Vector3)"/>;
        /// <paramref name="proper"/> is true for a real crossing (each triangle has corners strictly on both sides of
        /// the other's plane) and false when they only touch (an edge or corner lying on the other's face).
        /// </summary>
        public static bool Crosses(in ClashTriangle t, in ClashTriangle u, out Vector3 p, out Vector3 q, out bool proper)
        {
            p = q = Vector3.Zero;
            proper = false;
            if (t.IsDegenerate || u.IsDegenerate) { return false; }

            // t's corners against u's plane
            float a0 = Snap(Vector3.Dot(u.Normal, t.A - u.A));
            float a1 = Snap(Vector3.Dot(u.Normal, t.B - u.A));
            float a2 = Snap(Vector3.Dot(u.Normal, t.C - u.A));
            if (SameSide(a0, a1, a2)) { return false; }
            if (a0 == 0f && a1 == 0f && a2 == 0f) { return false; } // coplanar: touching, not crossing

            // u's corners against t's plane
            float b0 = Snap(Vector3.Dot(t.Normal, u.A - t.A));
            float b1 = Snap(Vector3.Dot(t.Normal, u.B - t.A));
            float b2 = Snap(Vector3.Dot(t.Normal, u.C - t.A));
            if (SameSide(b0, b1, b2)) { return false; }
            if (b0 == 0f && b1 == 0f && b2 == 0f) { return false; }

            // Where each triangle meets the other's plane (a segment or a point), then their overlap on the common line
            if (!PlanePoints(t, a0, a1, a2, out Vector3 t0, out Vector3 t1)) { return false; }
            if (!PlanePoints(u, b0, b1, b2, out Vector3 u0, out Vector3 u1)) { return false; }
            Vector3 d = Vector3.Cross(t.Normal, u.Normal);
            if (d.LengthSquared() < 1e-12f) { return false; }

            float s0 = Vector3.Dot(d, t0), s1 = Vector3.Dot(d, t1);
            if (s1 < s0) { (s0, s1) = (s1, s0); (t0, t1) = (t1, t0); }
            float r0 = Vector3.Dot(d, u0), r1 = Vector3.Dot(d, u1);
            if (r1 < r0) { (r0, r1) = (r1, r0); (u0, u1) = (u1, u0); }

            float slack = EPSILON * MathF.Max(1f, d.Length());
            if (s0 > r1 + slack || r0 > s1 + slack) { return false; }
            p = s0 >= r0 ? t0 : u0;
            q = s1 <= r1 ? t1 : u1;
            proper = BothSides(a0, a1, a2) && BothSides(b0, b1, b2) && s1 - s0 > slack && r1 - r0 > slack && MathF.Min(s1, r1) - MathF.Max(s0, r0) > slack;
            return true;
        }

        private static bool BothSides(float a, float b, float c) => MathF.Max(a, MathF.Max(b, c)) > 0f && MathF.Min(a, MathF.Min(b, c)) < 0f;

        private static float Snap(float distance) => MathF.Abs(distance) < EPSILON ? 0f : distance;

        private static bool SameSide(float a, float b, float c) => (a > 0f && b > 0f && c > 0f) || (a < 0f && b < 0f && c < 0f);

        /// <summary>
        /// The (up to two) points where a triangle meets a plane, from its corners' signed distances.
        /// </summary>
        private static bool PlanePoints(in ClashTriangle t, float d0, float d1, float d2, out Vector3 first, out Vector3 second)
        {
            first = second = Vector3.Zero;
            int count = 0;
            Add(ref count, ref first, ref second, d0 == 0f, t.A);
            Add(ref count, ref first, ref second, d1 == 0f, t.B);
            Add(ref count, ref first, ref second, d2 == 0f, t.C);
            if (d0 * d1 < 0f) { Add(ref count, ref first, ref second, true, t.A + (t.B - t.A) * (d0 / (d0 - d1))); }
            if (d1 * d2 < 0f) { Add(ref count, ref first, ref second, true, t.B + (t.C - t.B) * (d1 / (d1 - d2))); }
            if (d2 * d0 < 0f) { Add(ref count, ref first, ref second, true, t.C + (t.A - t.C) * (d2 / (d2 - d0))); }
            if (count == 1) { second = first; }
            return count > 0;
        }

        private static void Add(ref int count, ref Vector3 first, ref Vector3 second, bool condition, Vector3 point)
        {
            if (!condition) { return; }
            if (count == 0) { first = point; }
            else if (count == 1) { second = point; }
            count++;
        }

        #endregion

        #region Distances

        /// <summary>
        /// The shortest distance between two triangles (0 when they cross or touch), with the closest points.
        /// </summary>
        public static float Distance(in ClashTriangle t, in ClashTriangle u, out Vector3 onT, out Vector3 onU)
        {
            if (Crosses(t, u, out Vector3 p, out Vector3 q))
            {
                onT = onU = (p + q) * 0.5f;
                return 0f;
            }

            float best = float.MaxValue;
            onT = onU = Vector3.Zero;

            // Corners against the other triangle
            Consider(ref best, ref onT, ref onU, t.A, ClosestOnTriangle(t.A, u), false);
            Consider(ref best, ref onT, ref onU, t.B, ClosestOnTriangle(t.B, u), false);
            Consider(ref best, ref onT, ref onU, t.C, ClosestOnTriangle(t.C, u), false);
            Consider(ref best, ref onT, ref onU, u.A, ClosestOnTriangle(u.A, t), true);
            Consider(ref best, ref onT, ref onU, u.B, ClosestOnTriangle(u.B, t), true);
            Consider(ref best, ref onT, ref onU, u.C, ClosestOnTriangle(u.C, t), true);

            // Edges against edges
            EdgePair(ref best, ref onT, ref onU, t.A, t.B, u);
            EdgePair(ref best, ref onT, ref onU, t.B, t.C, u);
            EdgePair(ref best, ref onT, ref onU, t.C, t.A, u);
            return MathF.Sqrt(best);
        }

        private static void EdgePair(ref float best, ref Vector3 onT, ref Vector3 onU, Vector3 p, Vector3 q, in ClashTriangle u)
        {
            Segments(ref best, ref onT, ref onU, p, q, u.A, u.B);
            Segments(ref best, ref onT, ref onU, p, q, u.B, u.C);
            Segments(ref best, ref onT, ref onU, p, q, u.C, u.A);
        }

        private static void Segments(ref float best, ref Vector3 onT, ref Vector3 onU, Vector3 p1, Vector3 q1, Vector3 p2, Vector3 q2)
        {
            float d = ClosestBetweenSegments(p1, q1, p2, q2, out Vector3 c1, out Vector3 c2);
            if (d < best) { best = d; onT = c1; onU = c2; }
        }

        private static void Consider(ref float best, ref Vector3 onT, ref Vector3 onU, Vector3 corner, Vector3 closest, bool cornerOnU)
        {
            float d = Vector3.DistanceSquared(corner, closest);
            if (d >= best) { return; }
            best = d;
            if (cornerOnU) { onU = corner; onT = closest; }
            else { onT = corner; onU = closest; }
        }

        /// <summary>
        /// The closest point of a triangle to a point (by the region of the triangle the point projects into).
        /// </summary>
        public static Vector3 ClosestOnTriangle(Vector3 p, in ClashTriangle t)
        {
            Vector3 a = t.A, b = t.B, c = t.C;
            Vector3 ab = b - a, ac = c - a, ap = p - a;
            float d1 = Vector3.Dot(ab, ap), d2 = Vector3.Dot(ac, ap);
            if (d1 <= 0f && d2 <= 0f) { return a; }

            Vector3 bp = p - b;
            float d3 = Vector3.Dot(ab, bp), d4 = Vector3.Dot(ac, bp);
            if (d3 >= 0f && d4 <= d3) { return b; }

            float vc = d1 * d4 - d3 * d2;
            if (vc <= 0f && d1 >= 0f && d3 <= 0f) { return a + ab * (d1 / (d1 - d3)); }

            Vector3 cp = p - c;
            float d5 = Vector3.Dot(ab, cp), d6 = Vector3.Dot(ac, cp);
            if (d6 >= 0f && d5 <= d6) { return c; }

            float vb = d5 * d2 - d1 * d6;
            if (vb <= 0f && d2 >= 0f && d6 <= 0f) { return a + ac * (d2 / (d2 - d6)); }

            float va = d3 * d6 - d5 * d4;
            if (va <= 0f && d4 - d3 >= 0f && d5 - d6 >= 0f) { return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6))); }

            float sum = va + vb + vc;
            if (MathF.Abs(sum) < 1e-20f) { return a; } // degenerate triangle
            float v = vb / sum, w = vc / sum;
            return a + ab * v + ac * w;
        }

        /// <summary>
        /// The squared distance between two segments, with the closest points (parameters clamped to the segments).
        /// </summary>
        public static float ClosestBetweenSegments(Vector3 p1, Vector3 q1, Vector3 p2, Vector3 q2, out Vector3 c1, out Vector3 c2)
        {
            Vector3 d1 = q1 - p1, d2 = q2 - p2, r = p1 - p2;
            float a = Vector3.Dot(d1, d1), e = Vector3.Dot(d2, d2), f = Vector3.Dot(d2, r);
            float s, t;
            const float TINY = 1e-14f;
            if (a <= TINY && e <= TINY)
            {
                c1 = p1;
                c2 = p2;
                return Vector3.DistanceSquared(c1, c2);
            }
            if (a <= TINY)
            {
                s = 0f;
                t = Math.Clamp(f / e, 0f, 1f);
            }
            else
            {
                float c = Vector3.Dot(d1, r);
                if (e <= TINY)
                {
                    t = 0f;
                    s = Math.Clamp(-c / a, 0f, 1f);
                }
                else
                {
                    float b = Vector3.Dot(d1, d2);
                    float denom = a * e - b * b;
                    s = denom > TINY ? Math.Clamp((b * f - c * e) / denom, 0f, 1f) : 0f;
                    t = (b * s + f) / e;
                    if (t < 0f)
                    {
                        t = 0f;
                        s = Math.Clamp(-c / a, 0f, 1f);
                    }
                    else if (t > 1f)
                    {
                        t = 1f;
                        s = Math.Clamp((b - c) / a, 0f, 1f);
                    }
                }
            }
            c1 = p1 + d1 * s;
            c2 = p2 + d2 * t;
            return Vector3.DistanceSquared(c1, c2);
        }

        #endregion

        #region Inside tests

        // Three slightly skewed directions, so a ray rarely runs exactly along an edge or a face of axis-aligned geometry
        private static readonly Vector3 RAY_1 = Vector3.Normalize(new Vector3(0.0131f, 0.0217f, 1f));
        private static readonly Vector3 RAY_2 = Vector3.Normalize(new Vector3(1f, 0.0173f, 0.0291f));
        private static readonly Vector3 RAY_3 = Vector3.Normalize(new Vector3(0.0237f, 1f, 0.0119f));

        /// <summary>
        /// True when a point is inside a closed mesh: by the even–odd rule along three skewed rays, two of three agreeing
        /// (so one ray grazing an edge doesn't decide). Open meshes give unreliable answers (as with any parity test).
        /// </summary>
        public static bool Inside(Vector3 point, ReadOnlySpan<ClashTriangle> mesh)
        {
            int votes = 0;
            if ((RayCrossings(point, RAY_1, mesh) & 1) == 1) { votes++; }
            if ((RayCrossings(point, RAY_2, mesh) & 1) == 1) { votes++; }
            if (votes == 1 && (RayCrossings(point, RAY_3, mesh) & 1) == 1) { votes++; }
            return votes >= 2;
        }

        /// <summary>The skewed ray directions <see cref="Inside"/> uses (for meshes with their own ray queries).</summary>
        public static Vector3 InsideRay(int index) => index switch { 0 => RAY_1, 1 => RAY_2, _ => RAY_3 };

        /// <summary>How many triangles a ray from a point crosses (in front of the point).</summary>
        public static int RayCrossings(Vector3 origin, Vector3 direction, ReadOnlySpan<ClashTriangle> mesh)
        {
            int count = 0;
            for (int i = 0; i < mesh.Length; i++)
            {
                if (RayHits(origin, direction, mesh[i])) { count++; }
            }
            return count;
        }

        /// <summary>
        /// True when a ray from <paramref name="origin"/> along <paramref name="direction"/> crosses a triangle in front
        /// of the origin (Möller–Trumbore).
        /// </summary>
        public static bool RayHits(Vector3 origin, Vector3 direction, in ClashTriangle t)
        {
            Vector3 e1 = t.B - t.A, e2 = t.C - t.A;
            Vector3 h = Vector3.Cross(direction, e2);
            float det = Vector3.Dot(e1, h);
            if (MathF.Abs(det) < 1e-14f) { return false; }
            float inv = 1f / det;
            Vector3 s = origin - t.A;
            float u = Vector3.Dot(s, h) * inv;
            if (u < 0f || u > 1f) { return false; }
            Vector3 q = Vector3.Cross(s, e1);
            float v = Vector3.Dot(direction, q) * inv;
            if (v < 0f || u + v > 1f) { return false; }
            return Vector3.Dot(e2, q) * inv > EPSILON;
        }

        #endregion
    }
}
