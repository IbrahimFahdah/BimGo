using System.Numerics;

// The class belongs to the Physics namespace
namespace RvtGo.Physics
{
    /// <summary>
    /// Closest-point and intersection routines (after Ericson, Real-Time Collision Detection).
    /// All allocation-free.
    /// </summary>
    internal static class GeoMath
    {
        private const float EPSILON = 1e-9f;

        /// <summary>
        /// Closest point on triangle ABC to point P.
        /// </summary>
        public static Vector3 ClosestPointOnTriangle(Vector3 p, Vector3 a, Vector3 b, Vector3 c)
        {
            Vector3 ab = b - a, ac = c - a, ap = p - a;
            float d1 = Vector3.Dot(ab, ap), d2 = Vector3.Dot(ac, ap);
            if (d1 <= 0f && d2 <= 0f) { return a; }

            Vector3 bp = p - b;
            float d3 = Vector3.Dot(ab, bp), d4 = Vector3.Dot(ac, bp);
            if (d3 >= 0f && d4 <= d3) { return b; }

            float vc = d1 * d4 - d3 * d2;
            if (vc <= 0f && d1 >= 0f && d3 <= 0f)
            {
                float v = d1 / (d1 - d3);
                return a + v * ab;
            }

            Vector3 cp = p - c;
            float d5 = Vector3.Dot(ab, cp), d6 = Vector3.Dot(ac, cp);
            if (d6 >= 0f && d5 <= d6) { return c; }

            float vb = d5 * d2 - d1 * d6;
            if (vb <= 0f && d2 >= 0f && d6 <= 0f)
            {
                float w = d2 / (d2 - d6);
                return a + w * ac;
            }

            float va = d3 * d6 - d5 * d4;
            if (va <= 0f && (d4 - d3) >= 0f && (d5 - d6) >= 0f)
            {
                float w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                return b + w * (c - b);
            }

            float denom = 1f / (va + vb + vc);
            float vv = vb * denom, ww = vc * denom;
            return a + ab * vv + ac * ww;
        }

        /// <summary>
        /// Closest points between segments P1Q1 and P2Q2.
        /// </summary>
        /// <returns>The squared distance.</returns>
        public static float ClosestSegmentSegment(Vector3 p1, Vector3 q1, Vector3 p2, Vector3 q2, out Vector3 c1, out Vector3 c2)
        {
            Vector3 d1 = q1 - p1, d2 = q2 - p2, r = p1 - p2;
            float a = Vector3.Dot(d1, d1), e = Vector3.Dot(d2, d2), f = Vector3.Dot(d2, r);
            float s, t;

            if (a <= EPSILON && e <= EPSILON)
            {
                c1 = p1;
                c2 = p2;
                return Vector3.DistanceSquared(c1, c2);
            }

            if (a <= EPSILON)
            {
                s = 0f;
                t = Math.Clamp(f / e, 0f, 1f);
            }
            else
            {
                float c = Vector3.Dot(d1, r);
                if (e <= EPSILON)
                {
                    t = 0f;
                    s = Math.Clamp(-c / a, 0f, 1f);
                }
                else
                {
                    float b = Vector3.Dot(d1, d2);
                    float denom = a * e - b * b;
                    s = denom != 0f ? Math.Clamp((b * f - c * e) / denom, 0f, 1f) : 0f;
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

        /// <summary>
        /// Closest points between segment PQ and triangle ABC.
        /// </summary>
        /// <returns>The squared distance (0 if the segment pierces the triangle).</returns>
        public static float ClosestSegmentTriangle(Vector3 p, Vector3 q, Vector3 a, Vector3 b, Vector3 c, out Vector3 onSegment, out Vector3 onTriangle)
        {
            // Piercing
            Vector3 dir = q - p;
            if (SegmentTriangle(p, dir, a, b, c, out float hitT))
            {
                onSegment = onTriangle = p + dir * hitT;
                return 0f;
            }

            // Segment end points against the face
            Vector3 tp = ClosestPointOnTriangle(p, a, b, c);
            float best = Vector3.DistanceSquared(p, tp);
            onSegment = p;
            onTriangle = tp;

            Vector3 tq = ClosestPointOnTriangle(q, a, b, c);
            float dq = Vector3.DistanceSquared(q, tq);
            if (dq < best) { best = dq; onSegment = q; onTriangle = tq; }

            // Segment against each edge
            float d = ClosestSegmentSegment(p, q, a, b, out Vector3 s1, out Vector3 e1);
            if (d < best) { best = d; onSegment = s1; onTriangle = e1; }
            d = ClosestSegmentSegment(p, q, b, c, out s1, out e1);
            if (d < best) { best = d; onSegment = s1; onTriangle = e1; }
            d = ClosestSegmentSegment(p, q, c, a, out s1, out e1);
            if (d < best) { best = d; onSegment = s1; onTriangle = e1; }

            return best;
        }

        /// <summary>
        /// Two-sided segment/triangle intersection (parameter along dir in 0..1).
        /// </summary>
        public static bool SegmentTriangle(Vector3 origin, Vector3 dir, Vector3 a, Vector3 b, Vector3 c, out float t)
        {
            return RayTriangle(origin, dir, a, b, c, 1f, out t);
        }

        /// <summary>
        /// Two-sided Möller–Trumbore ray/triangle test.
        /// </summary>
        /// <param name="origin">Ray origin.</param>
        /// <param name="dir">Ray direction (not necessarily unit).</param>
        /// <param name="a">Vertex A.</param>
        /// <param name="b">Vertex B.</param>
        /// <param name="c">Vertex C.</param>
        /// <param name="tMax">Maximum parameter.</param>
        /// <param name="t">Hit parameter.</param>
        /// <returns>True on a hit in [0, tMax].</returns>
        public static bool RayTriangle(Vector3 origin, Vector3 dir, Vector3 a, Vector3 b, Vector3 c, float tMax, out float t)
        {
            t = 0f;
            Vector3 e1 = b - a, e2 = c - a;
            Vector3 pv = Vector3.Cross(dir, e2);
            float det = Vector3.Dot(e1, pv);
            if (MathF.Abs(det) < 1e-12f) { return false; }

            float inv = 1f / det;
            Vector3 tv = origin - a;
            float u = Vector3.Dot(tv, pv) * inv;
            if (u < 0f || u > 1f) { return false; }

            Vector3 qv = Vector3.Cross(tv, e1);
            float v = Vector3.Dot(dir, qv) * inv;
            if (v < 0f || u + v > 1f) { return false; }

            t = Vector3.Dot(e2, qv) * inv;
            return t >= 0f && t <= tMax;
        }

        /// <summary>
        /// Ray/AABB slab test.
        /// </summary>
        /// <param name="origin">Ray origin.</param>
        /// <param name="invDir">Component-wise reciprocal of the ray direction.</param>
        /// <param name="min">Box minimum.</param>
        /// <param name="max">Box maximum.</param>
        /// <param name="tMax">Maximum parameter.</param>
        /// <param name="tNear">Entry parameter.</param>
        /// <returns>True if the ray hits the box before tMax.</returns>
        public static bool RayAabb(Vector3 origin, Vector3 invDir, Vector3 min, Vector3 max, float tMax, out float tNear)
        {
            Vector3 t0 = (min - origin) * invDir;
            Vector3 t1 = (max - origin) * invDir;
            Vector3 tSmall = Vector3.Min(t0, t1);
            Vector3 tBig = Vector3.Max(t0, t1);
            tNear = MathF.Max(MathF.Max(tSmall.X, tSmall.Y), MathF.Max(tSmall.Z, 0f));
            float tFar = MathF.Min(MathF.Min(tBig.X, tBig.Y), MathF.Min(tBig.Z, tMax));
            return tNear <= tFar;
        }

        /// <summary>
        /// Safe reciprocal of a direction for slab tests.
        /// </summary>
        public static Vector3 Reciprocal(Vector3 d)
        {
            return new Vector3(
                MathF.Abs(d.X) > 1e-12f ? 1f / d.X : 1e12f * MathF.Sign(d.X == 0f ? 1f : d.X),
                MathF.Abs(d.Y) > 1e-12f ? 1f / d.Y : 1e12f * MathF.Sign(d.Y == 0f ? 1f : d.Y),
                MathF.Abs(d.Z) > 1e-12f ? 1f / d.Z : 1e12f * MathF.Sign(d.Z == 0f ? 1f : d.Z));
        }
    }
}
