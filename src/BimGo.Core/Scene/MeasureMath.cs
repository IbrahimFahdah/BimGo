using System.Numerics;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Geometry behind the Measure gun's modes (review tools round): planar polygon area and perimeter, the angle at
    /// a vertex, and a triangulation of a (possibly concave) polygon for drawing its fill. Pure maths, no allocation
    /// beyond the caller's lists.
    /// </summary>
    public static class MeasureMath
    {
        /// <summary>
        /// Two unit axes spanning the plane with this normal (u × v = normal).
        /// </summary>
        public static void PlaneAxes(Vector3 normal, out Vector3 u, out Vector3 v)
        {
            Vector3 n = normal.LengthSquared() > 1e-12f ? Vector3.Normalize(normal) : Vector3.UnitZ;
            Vector3 helper = MathF.Abs(n.Z) < 0.9f ? Vector3.UnitZ : Vector3.UnitX;
            u = Vector3.Normalize(Vector3.Cross(helper, n));
            v = Vector3.Cross(n, u);
        }

        /// <summary>
        /// Where a ray meets a plane (only in front of the origin).
        /// </summary>
        /// <returns>False when the ray is parallel to the plane or the plane is behind it.</returns>
        public static bool RayPlane(Vector3 origin, Vector3 direction, Vector3 planePoint, Vector3 planeNormal, out Vector3 point)
        {
            point = default;
            float denominator = Vector3.Dot(direction, planeNormal);
            if (MathF.Abs(denominator) < 1e-6f) { return false; }
            float t = Vector3.Dot(planePoint - origin, planeNormal) / denominator;
            if (t < 0f || !float.IsFinite(t)) { return false; }
            point = origin + direction * t;
            return true;
        }

        /// <summary>
        /// Projects a point onto a plane.
        /// </summary>
        public static Vector3 ProjectToPlane(Vector3 point, Vector3 planePoint, Vector3 planeNormal)
        {
            Vector3 n = Vector3.Normalize(planeNormal);
            return point - n * Vector3.Dot(point - planePoint, n);
        }

        /// <summary>
        /// The area of a closed planar polygon (points in order, the closing edge implied), measured in the plane with
        /// the given normal. Self-intersecting outlines give the net (signed parts cancel) area.
        /// </summary>
        public static double PolygonArea(IReadOnlyList<Vector3> points, Vector3 normal)
        {
            if (points == null || points.Count < 3) { return 0.0; }
            PlaneAxes(normal, out Vector3 u, out Vector3 v);
            Vector3 origin = points[0];
            double twice = 0.0;
            for (int i = 0, j = points.Count - 1; i < points.Count; j = i++)
            {
                Vector3 a = points[j] - origin, b = points[i] - origin;
                double ax = Vector3.Dot(a, u), ay = Vector3.Dot(a, v);
                double bx = Vector3.Dot(b, u), by = Vector3.Dot(b, v);
                twice += ax * by - bx * ay;
            }
            return Math.Abs(twice) * 0.5;
        }

        /// <summary>
        /// The length of a polygon's outline (closed: the last point joins the first) or of a polyline.
        /// </summary>
        public static double Perimeter(IReadOnlyList<Vector3> points, bool closed = true)
        {
            if (points == null || points.Count < 2) { return 0.0; }
            double length = 0.0;
            for (int i = 1; i < points.Count; i++) { length += Vector3.Distance(points[i - 1], points[i]); }
            if (closed && points.Count > 2) { length += Vector3.Distance(points[^1], points[0]); }
            return length;
        }

        /// <summary>
        /// The angle A–vertex–B in degrees (0–180), or NaN when either arm has no length.
        /// </summary>
        public static double AngleDegrees(Vector3 a, Vector3 vertex, Vector3 b)
        {
            Vector3 p = a - vertex, q = b - vertex;
            double lp = p.Length(), lq = q.Length();
            if (lp < 1e-6 || lq < 1e-6) { return double.NaN; }
            double cos = Math.Clamp(Vector3.Dot(p, q) / (lp * lq), -1.0, 1.0);
            return Math.Acos(cos) * 180.0 / Math.PI;
        }

        /// <summary>
        /// Triangulates a simple planar polygon (convex or concave, either winding) by ear clipping in the plane with
        /// the given normal. Writes index triples into <paramref name="triangles"/> (cleared first).
        /// </summary>
        /// <returns>False when the outline is degenerate or self-intersecting (a fan is written instead, so there is
        /// always something to draw).</returns>
        public static bool Triangulate(IReadOnlyList<Vector3> points, Vector3 normal, List<int> triangles)
        {
            triangles.Clear();
            int n = points?.Count ?? 0;
            if (n < 3) { return false; }

            PlaneAxes(normal, out Vector3 u, out Vector3 v);
            var xy = new Vector2[n];
            for (int i = 0; i < n; i++)
            {
                Vector3 d = points[i] - points[0];
                xy[i] = new Vector2(Vector3.Dot(d, u), Vector3.Dot(d, v));
            }

            // Work counter-clockwise
            double signed = 0.0;
            for (int i = 0, j = n - 1; i < n; j = i++) { signed += (double)xy[j].X * xy[i].Y - (double)xy[i].X * xy[j].Y; }
            var remaining = new List<int>(n);
            if (signed >= 0) { for (int i = 0; i < n; i++) { remaining.Add(i); } }
            else { for (int i = n - 1; i >= 0; i--) { remaining.Add(i); } }

            int guard = n * n + 8;
            while (remaining.Count > 3 && guard-- > 0)
            {
                bool clipped = false;
                for (int k = 0; k < remaining.Count; k++)
                {
                    int ia = remaining[(k + remaining.Count - 1) % remaining.Count];
                    int ib = remaining[k];
                    int ic = remaining[(k + 1) % remaining.Count];
                    if (Cross(xy[ia], xy[ib], xy[ic]) <= 1e-12f) { continue; } // reflex or flat

                    bool inside = false;
                    foreach (int ip in remaining)
                    {
                        if (ip == ia || ip == ib || ip == ic) { continue; }
                        if (InTriangle(xy[ip], xy[ia], xy[ib], xy[ic])) { inside = true; break; }
                    }
                    if (inside) { continue; }

                    triangles.Add(ia);
                    triangles.Add(ib);
                    triangles.Add(ic);
                    remaining.RemoveAt(k);
                    clipped = true;
                    break;
                }
                if (!clipped) { break; }
            }

            if (remaining.Count == 3)
            {
                triangles.Add(remaining[0]);
                triangles.Add(remaining[1]);
                triangles.Add(remaining[2]);
                return true;
            }

            // Self-intersecting or degenerate: a fan still shows roughly where the area is
            triangles.Clear();
            for (int i = 1; i < n - 1; i++)
            {
                triangles.Add(0);
                triangles.Add(i);
                triangles.Add(i + 1);
            }
            return false;
        }

        private static float Cross(Vector2 a, Vector2 b, Vector2 c) => (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);

        private static bool InTriangle(Vector2 p, Vector2 a, Vector2 b, Vector2 c) =>
            Cross(a, b, p) >= 0f && Cross(b, c, p) >= 0f && Cross(c, a, p) >= 0f;
    }
}
