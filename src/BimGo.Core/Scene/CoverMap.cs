using System.Numerics;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Round W-B (weather): what covers each spot of the site, seen from above. A grid of cells (about 0.5 m) over the
    /// model holding the highest surface's height in each cell, built on the CPU once when rain or snow is first turned
    /// on (and again a moment after the shown model changes). Rain and snow stop at it (they fall past windows but never
    /// under a roof or a canopy), and the wet and snow looks only reach surfaces that are open to the sky.
    /// <para>Every triangle counts, whatever way it faces: up and down faces by the cells their area covers, and each
    /// triangle's edges mark the cells they pass over too (walls, thin members and slivers narrower than a cell).</para>
    /// </summary>
    public sealed class CoverMap
    {
        #region Constants

        /// <summary>Most cells along one side.</summary>
        public const int MAX_SIDE = 1024;

        /// <summary>The cell size (m) when the model is small enough (bigger models get bigger cells).</summary>
        public const float CELL = 0.5f;

        /// <summary>A cell nothing covers.</summary>
        public const float NONE = -1e9f;

        #endregion

        #region Grid

        /// <summary>The grid's lower-left corner (scene-local metres).</summary>
        public Vector2 Min { get; private set; }

        /// <summary>Cell size (m).</summary>
        public float Cell { get; private set; } = CELL;

        /// <summary>Cells across (X) and up (Y).</summary>
        public int Width { get; private set; }

        /// <inheritdoc cref="Width"/>
        public int Height { get; private set; }

        /// <summary>Per cell (row-major, Y rows): the highest surface's height, or <see cref="NONE"/>.</summary>
        public float[] Tops { get; private set; } = Array.Empty<float>();

        /// <summary>Cells with something in them.</summary>
        public int CoveredCells { get; private set; }

        /// <summary>Triangles rasterised.</summary>
        public int Triangles { get; private set; }

        /// <summary>True when nothing covers anything (no model).</summary>
        public bool IsEmpty => CoveredCells == 0;

        /// <summary>An empty map (everything is open to the sky).</summary>
        public static readonly CoverMap Empty = new();

        #endregion

        #region Build

        /// <summary>
        /// Builds the map from the scene's static triangles (library templates left out), opaque and transparent alike
        /// (a glass canopy keeps the rain off).
        /// </summary>
        /// <param name="scene">The scene.</param>
        /// <param name="cancel">Stops the build (throws).</param>
        /// <param name="visible">Per element, false to leave it out (hidden, demolished, moved); null = every element.</param>
        /// <param name="instances">Moved, cloned and placed copies: the source element and its transform (scene-local).</param>
        public static CoverMap Build(SceneData scene, CancellationToken cancel = default, IReadOnlyList<bool> visible = null,
            IReadOnlyList<(int Element, Matrix4x4 Model)> instances = null)
        {
            if (scene?.Vertices == null || scene.Indices == null || scene.Elements == null) { return Empty; }
            SceneVertex[] vertices = scene.Vertices;
            uint[] indices = scene.Indices;

            // Pass 1: the bounds of what will be rasterised; pass 2: the triangles
            var builder = new Builder();
            for (int pass = 0; pass < 2; pass++)
            {
                for (int e = 0; e < scene.Elements.Length; e++)
                {
                    ElementRecord element = scene.Elements[e];
                    if (element == null || element.IsLibraryTemplate) { continue; }
                    if (visible != null && e < visible.Count && !visible[e]) { continue; }
                    Visit(element.OpaqueStart, element.OpaqueCount, Matrix4x4.Identity, false);
                    Visit(element.TransparentStart, element.TransparentCount, Matrix4x4.Identity, false);
                    if ((e & 255) == 0) { cancel.ThrowIfCancellationRequested(); }
                }
                foreach ((int index, Matrix4x4 matrix) in instances ?? Array.Empty<(int, Matrix4x4)>())
                {
                    if (index < 0 || index >= scene.Elements.Length || scene.Elements[index] == null) { continue; }
                    ElementRecord element = scene.Elements[index];
                    Visit(element.OpaqueStart, element.OpaqueCount, matrix, true);
                    Visit(element.TransparentStart, element.TransparentCount, matrix, true);
                }
                if (pass == 0 && !builder.Allocate()) { return Empty; }
            }
            cancel.ThrowIfCancellationRequested();
            return builder.Finish();

            void Visit(int start, int count, Matrix4x4 model, bool transformed)
            {
                for (int i = start; i + 2 < start + count && i + 2 < indices.Length; i += 3)
                {
                    uint a = indices[i], b = indices[i + 1], c = indices[i + 2];
                    if (a >= vertices.Length || b >= vertices.Length || c >= vertices.Length) { continue; }
                    Vector3 pa = vertices[a].Position, pb = vertices[b].Position, pc = vertices[c].Position;
                    if (transformed)
                    {
                        pa = Vector3.Transform(pa, model);
                        pb = Vector3.Transform(pb, model);
                        pc = Vector3.Transform(pc, model);
                    }
                    if (builder.Allocated) { builder.Add(pa, pb, pc); }
                    else { builder.Grow(pa, pb, pc); }
                    if ((i & 65535) == 0) { cancel.ThrowIfCancellationRequested(); }
                }
            }
        }

        /// <summary>
        /// A map from loose triangles (three corners each; testable without a scene).
        /// </summary>
        /// <param name="corners">Corners, three per triangle.</param>
        public static CoverMap FromTriangles(IReadOnlyList<Vector3> corners)
        {
            if (corners == null || corners.Count < 3) { return Empty; }
            var builder = new Builder();
            for (int i = 0; i + 2 < corners.Count; i += 3) { builder.Grow(corners[i], corners[i + 1], corners[i + 2]); }
            if (!builder.Allocate()) { return Empty; }
            for (int i = 0; i + 2 < corners.Count; i += 3) { builder.Add(corners[i], corners[i + 1], corners[i + 2]); }
            return builder.Finish();
        }

        /// <summary>Grows the bounds, then sizes the grid and rasterises triangles into it (no per-triangle allocation).</summary>
        private sealed class Builder
        {
            private Vector2 _min = new(float.MaxValue), _max = new(float.MinValue);
            private CoverMap _map;
            private int _triangles;

            public bool Allocated => _map != null;

            public void Grow(Vector3 a, Vector3 b, Vector3 c)
            {
                if (!Finite(a) || !Finite(b) || !Finite(c)) { return; }
                _min = Vector2.Min(_min, Vector2.Min(new Vector2(a.X, a.Y), Vector2.Min(new Vector2(b.X, b.Y), new Vector2(c.X, c.Y))));
                _max = Vector2.Max(_max, Vector2.Max(new Vector2(a.X, a.Y), Vector2.Max(new Vector2(b.X, b.Y), new Vector2(c.X, c.Y))));
            }

            public bool Allocate()
            {
                if (_min.X > _max.X || _min.Y > _max.Y) { return false; }
                Vector2 size = _max - _min;
                float cell = MathF.Max(CELL, MathF.Max(size.X, size.Y) / (MAX_SIDE - 2));
                Vector2 min = _min - new Vector2(cell);
                int width = Math.Clamp((int)MathF.Ceiling(size.X / cell) + 2, 1, MAX_SIDE);
                int height = Math.Clamp((int)MathF.Ceiling(size.Y / cell) + 2, 1, MAX_SIDE);
                _map = new CoverMap { Min = min, Cell = cell, Width = width, Height = height, Tops = new float[width * height] };
                Array.Fill(_map.Tops, NONE);
                return true;
            }

            public void Add(Vector3 a, Vector3 b, Vector3 c)
            {
                if (!Finite(a) || !Finite(b) || !Finite(c)) { return; }
                CoverMap m = _map;
                _triangles++;

                // The edges mark the cells they pass over (walls, slivers, thin members narrower than a cell)
                m.Edge(a, b);
                m.Edge(b, c);
                m.Edge(c, a);

                // The area: every cell whose centre lies inside, at the height there
                Vector2 pa = new(a.X, a.Y), pb = new(b.X, b.Y), pc = new(c.X, c.Y);
                float area = Cross(pb - pa, pc - pa);
                if (MathF.Abs(area) < 1e-8f) { return; }
                float inverse = 1f / area;
                int x0 = Math.Max(0, (int)MathF.Floor((MathF.Min(a.X, MathF.Min(b.X, c.X)) - m.Min.X) / m.Cell));
                int y0 = Math.Max(0, (int)MathF.Floor((MathF.Min(a.Y, MathF.Min(b.Y, c.Y)) - m.Min.Y) / m.Cell));
                int x1 = Math.Min(m.Width - 1, (int)MathF.Floor((MathF.Max(a.X, MathF.Max(b.X, c.X)) - m.Min.X) / m.Cell));
                int y1 = Math.Min(m.Height - 1, (int)MathF.Floor((MathF.Max(a.Y, MathF.Max(b.Y, c.Y)) - m.Min.Y) / m.Cell));
                const float EDGE = -1e-4f;
                for (int y = y0; y <= y1; y++)
                {
                    float py = m.Min.Y + (y + 0.5f) * m.Cell;
                    int row = y * m.Width;
                    for (int x = x0; x <= x1; x++)
                    {
                        Vector2 p = new(m.Min.X + (x + 0.5f) * m.Cell, py);
                        float w0 = Cross(pb - p, pc - p) * inverse;
                        float w1 = Cross(pc - p, pa - p) * inverse;
                        float w2 = 1f - w0 - w1;
                        if (w0 < EDGE || w1 < EDGE || w2 < EDGE) { continue; }
                        float z = w0 * a.Z + w1 * b.Z + w2 * c.Z;
                        if (z > m.Tops[row + x]) { m.Tops[row + x] = z; }
                    }
                }
            }

            public CoverMap Finish()
            {
                CoverMap m = _map;
                if (m == null) { return Empty; }
                int covered = 0;
                for (int i = 0; i < m.Tops.Length; i++)
                {
                    if (m.Tops[i] > NONE) { covered++; }
                }
                m.CoveredCells = covered;
                m.Triangles = _triangles;
                return covered == 0 ? Empty : m;
            }

            private static bool Finite(Vector3 v) => float.IsFinite(v.X) && float.IsFinite(v.Y) && float.IsFinite(v.Z);
        }

        /// <summary>Raises the cells along an edge (seen from above), sampled at half a cell, to the edge's height there.</summary>
        private void Edge(Vector3 from, Vector3 to)
        {
            float length = MathF.Sqrt((to.X - from.X) * (to.X - from.X) + (to.Y - from.Y) * (to.Y - from.Y));
            int steps = Math.Min((int)MathF.Ceiling(length / (Cell * 0.5f)), MAX_SIDE * 4);
            for (int s = 0; s <= steps; s++)
            {
                float t = steps == 0 ? 0f : (float)s / steps;
                Raise(from.X + (to.X - from.X) * t, from.Y + (to.Y - from.Y) * t, from.Z + (to.Z - from.Z) * t);
            }
        }

        private void Raise(float x, float y, float z)
        {
            int cx = (int)MathF.Floor((x - Min.X) / Cell), cy = (int)MathF.Floor((y - Min.Y) / Cell);
            if (cx < 0 || cy < 0 || cx >= Width || cy >= Height) { return; }
            int index = cy * Width + cx;
            if (z > Tops[index]) { Tops[index] = z; }
        }

        private static float Cross(Vector2 u, Vector2 v) => u.X * v.Y - u.Y * v.X;

        #endregion

        #region Lookup

        /// <summary>The highest surface over a point (scene-local), or <see cref="NONE"/> where nothing covers it.</summary>
        public float TopAt(float x, float y)
        {
            if (IsEmpty) { return NONE; }
            int cx = (int)MathF.Floor((x - Min.X) / Cell), cy = (int)MathF.Floor((y - Min.Y) / Cell);
            if (cx < 0 || cy < 0 || cx >= Width || cy >= Height) { return NONE; }
            return Tops[cy * Width + cx];
        }

        /// <summary>
        /// True when something is over a point by more than <paramref name="clearance"/> (a roof over the eye, say); the
        /// point's own surface (the top of the cell it stands in) never counts.
        /// </summary>
        public bool IsCovered(Vector3 point, float clearance = 0.3f) => TopAt(point.X, point.Y) > point.Z + clearance;

        #endregion
    }
}
