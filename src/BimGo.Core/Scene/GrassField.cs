using System.Numerics;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Grass round (build B): where grass grows, seen from above. Grass materials (by keyword) are rasterised into a
    /// grid of cells holding the highest grass surface's height and its colour (a small palette), on the CPU, once.
    /// Any other upward surface just above the grass (a floor slab on a toposolid, a path, a kerb) takes the cell
    /// away, so blades never poke through floors; surfaces well above (roofs, canopies) don't.
    /// The app uploads the grid as a texture and places blades around the camera from it.
    /// </summary>
    public sealed class GrassField
    {
        #region Constants

        /// <summary>Most cells along one side.</summary>
        public const int MAX_SIDE = 2048;

        /// <summary>Smallest cell (m): blades are placed at their own spacing, so finer cells add nothing.</summary>
        public const float MIN_CELL = 0.1f;

        /// <summary>Upward faces only: the face normal's Z must reach this (≈ 70° slopes and flatter).</summary>
        public const float MIN_UP = 0.34f;

        /// <summary>
        /// A non-grass surface between this far above the grass and <see cref="COVER_ABOVE"/> covers it (no blades).
        /// The small allowance keeps grass whose own material shares a surface with edging.
        /// </summary>
        public const float COVER_BELOW = 0.02f, COVER_ABOVE = 0.3f;

        /// <summary>Most grass colours (one per grass material, first come).</summary>
        public const int MAX_PALETTE = 16;

        /// <summary>A natural grass green (display space), for grass materials whose colour isn't green.</summary>
        public static readonly Vector3 DEFAULT_GREEN = new(0.24f, 0.38f, 0.12f);

        #endregion

        #region Grid

        /// <summary>The grid's lower-left corner (scene-local metres).</summary>
        public Vector2 Min { get; private set; }

        /// <summary>Cell size (m).</summary>
        public float Cell { get; private set; }

        /// <summary>Cells across (X) and up (Y).</summary>
        public int Width { get; private set; }

        /// <inheritdoc cref="Width"/>
        public int Height { get; private set; }

        /// <summary>Per cell (row-major, Y rows): the grass height, valid where <see cref="Palette"/> is not 0.</summary>
        public float[] Heights { get; private set; } = Array.Empty<float>();

        /// <summary>Per cell: 0 = no grass, else the palette index + 1.</summary>
        public byte[] Palette { get; private set; } = Array.Empty<byte>();

        /// <summary>The grass colours (display space).</summary>
        public Vector3[] Colours { get; private set; } = Array.Empty<Vector3>();

        /// <summary>Cells with grass.</summary>
        public int GrassCells { get; private set; }

        /// <summary>Grass triangles rasterised.</summary>
        public int GrassTriangles { get; private set; }

        /// <summary>True when there is no grass.</summary>
        public bool IsEmpty => GrassCells == 0;

        /// <summary>An empty field.</summary>
        public static readonly GrassField Empty = new();

        #endregion

        #region Build

        /// <summary>
        /// Builds the field from the scene's static triangles (library templates left out) and the grass materials.
        /// </summary>
        /// <param name="scene">The scene (needs per-vertex materials).</param>
        /// <param name="keywords">Grass keywords (material name fragments, case ignored).</param>
        /// <param name="cancel">Stops the build (returns <see cref="Empty"/>).</param>
        /// <param name="visible">
        /// Polish round P-C: per element, false to leave it out (hidden, demolished, moved: its moved copy comes in
        /// <paramref name="instances"/>); null = every element.
        /// </param>
        /// <param name="instances">
        /// Polish round P-C: moved, cloned and placed copies: the source element and its transform (scene-local).
        /// </param>
        public static GrassField Build(SceneData scene, IReadOnlyList<string> keywords, CancellationToken cancel = default,
            IReadOnlyList<bool> visible = null, IReadOnlyList<(int Element, Matrix4x4 Model)> instances = null)
        {
            MaterialData materials = scene?.Materials;
            if (materials == null || materials.IsEmpty || keywords == null || keywords.Count == 0) { return Empty; }
            if (materials.VertexMaterial.Length != scene.Vertices.Length) { return Empty; }

            // Grass materials and their palette slots
            var colours = new List<Vector3>();
            var slot = new int[materials.Materials.Length]; // 0 = not grass, else palette index + 1
            for (int m = 0; m < materials.Materials.Length; m++)
            {
                SceneMaterial material = materials.Materials[m];
                if (material == null || !MaterialOverrides.Matches(material.Name, keywords)) { continue; }
                if (colours.Count >= MAX_PALETTE) { slot[m] = colours.Count; continue; } // share the last colour
                colours.Add(GrassColour(material.RenderColour ?? material.Colour));
                slot[m] = colours.Count;
            }
            if (colours.Count == 0) { return Empty; }

            var triangles = new List<Triangle>();
            var covers = new List<Triangle>();
            SceneVertex[] vertices = scene.Vertices;
            uint[] indices = scene.Indices;
            Matrix4x4 model = Matrix4x4.Identity;
            bool transformed = false;
            for (int e = 0; e < scene.Elements.Length; e++)
            {
                ElementRecord element = scene.Elements[e];
                if (element == null || element.IsLibraryTemplate) { continue; }
                if (visible != null && e < visible.Count && !visible[e]) { continue; }
                Collect(element.OpaqueStart, element.OpaqueCount);
                Collect(element.TransparentStart, element.TransparentCount);
            }

            // P-C: moved / cloned / placed copies, their triangles transformed (library templates are placed this way)
            transformed = true;
            foreach ((int index, Matrix4x4 matrix) in instances ?? Array.Empty<(int, Matrix4x4)>())
            {
                if (index < 0 || index >= scene.Elements.Length || scene.Elements[index] == null) { continue; }
                model = matrix;
                ElementRecord element = scene.Elements[index];
                Collect(element.OpaqueStart, element.OpaqueCount);
                Collect(element.TransparentStart, element.TransparentCount);
            }
            cancel.ThrowIfCancellationRequested();
            return Rasterise(triangles, covers, colours.ToArray(), cancel);

            void Collect(int start, int count)
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
                    Vector3 normal = Vector3.Cross(pb - pa, pc - pa);
                    float length = normal.Length();
                    if (length < 1e-9f || normal.Z / length < MIN_UP) { continue; }
                    ushort material = materials.VertexMaterial[a];
                    int palette = material < slot.Length ? slot[material] : 0;
                    var triangle = new Triangle(pa, pb, pc, (byte)palette);
                    if (palette > 0) { triangles.Add(triangle); }
                    else { covers.Add(triangle); }
                }
            }
        }

        /// <summary>
        /// Rasterises grass triangles (palette slot 1..n) and cover triangles into a field (testable without a scene).
        /// </summary>
        public static GrassField Rasterise(IReadOnlyList<Triangle> grass, IReadOnlyList<Triangle> covers, Vector3[] colours, CancellationToken cancel = default)
        {
            if (grass == null || grass.Count == 0) { return Empty; }

            // Bounds of the grass, a cell of padding
            Vector2 min = new(float.MaxValue), max = new(float.MinValue);
            foreach (Triangle t in grass)
            {
                min = Vector2.Min(min, t.MinXY);
                max = Vector2.Max(max, t.MaxXY);
            }
            Vector2 size = max - min;
            float cell = MathF.Max(MIN_CELL, MathF.Max(size.X, size.Y) / (MAX_SIDE - 2));
            min -= new Vector2(cell);
            int width = Math.Clamp((int)MathF.Ceiling(size.X / cell) + 2, 1, MAX_SIDE);
            int height = Math.Clamp((int)MathF.Ceiling(size.Y / cell) + 2, 1, MAX_SIDE);

            var field = new GrassField
            {
                Min = min,
                Cell = cell,
                Width = width,
                Height = height,
                Heights = new float[width * height],
                Palette = new byte[width * height],
                Colours = colours ?? Array.Empty<Vector3>(),
                GrassTriangles = grass.Count
            };
            Array.Fill(field.Heights, float.MinValue);

            // Grass: the highest grass surface per cell
            int n = 0;
            foreach (Triangle t in grass)
            {
                if ((++n & 4095) == 0) { cancel.ThrowIfCancellationRequested(); }
                field.Scan(t, (index, z) =>
                {
                    if (z > field.Heights[index])
                    {
                        field.Heights[index] = z;
                        field.Palette[index] = t.Palette;
                    }
                });
            }

            // Covers: any other upward surface just above the grass takes the cell
            if (covers != null)
            {
                foreach (Triangle t in covers)
                {
                    if ((++n & 4095) == 0) { cancel.ThrowIfCancellationRequested(); }
                    if (t.MaxXY.X < min.X || t.MaxXY.Y < min.Y || t.MinXY.X > min.X + width * cell || t.MinXY.Y > min.Y + height * cell) { continue; }
                    field.Scan(t, (index, z) =>
                    {
                        if (field.Palette[index] == 0) { return; }
                        float above = z - field.Heights[index];
                        if (above > COVER_BELOW && above < COVER_ABOVE) { field.Palette[index] = 0; }
                    });
                }
            }

            int cells = 0;
            for (int i = 0; i < field.Palette.Length; i++)
            {
                if (field.Palette[i] != 0) { cells++; }
                else { field.Heights[i] = 0f; }
            }
            field.GrassCells = cells;
            return cells == 0 ? Empty : field;
        }

        /// <summary>
        /// Visits every cell whose centre lies inside the triangle (seen from above), with the height there.
        /// </summary>
        private void Scan(in Triangle t, Action<int, float> visit)
        {
            int x0 = Math.Max(0, (int)MathF.Floor((t.MinXY.X - Min.X) / Cell));
            int y0 = Math.Max(0, (int)MathF.Floor((t.MinXY.Y - Min.Y) / Cell));
            int x1 = Math.Min(Width - 1, (int)MathF.Floor((t.MaxXY.X - Min.X) / Cell));
            int y1 = Math.Min(Height - 1, (int)MathF.Floor((t.MaxXY.Y - Min.Y) / Cell));
            Vector2 a = new(t.A.X, t.A.Y), b = new(t.B.X, t.B.Y), c = new(t.C.X, t.C.Y);
            float area = Cross(b - a, c - a);
            if (MathF.Abs(area) < 1e-10f) { return; }
            float inverse = 1f / area;
            const float EDGE = -1e-4f; // shared edges: both sides take the cell (the higher wins, covers re-check)

            for (int y = y0; y <= y1; y++)
            {
                float py = Min.Y + (y + 0.5f) * Cell;
                for (int x = x0; x <= x1; x++)
                {
                    Vector2 p = new(Min.X + (x + 0.5f) * Cell, py);
                    float w0 = Cross(b - p, c - p) * inverse;
                    float w1 = Cross(c - p, a - p) * inverse;
                    float w2 = 1f - w0 - w1;
                    if (w0 < EDGE || w1 < EDGE || w2 < EDGE) { continue; }
                    visit(y * Width + x, w0 * t.A.Z + w1 * t.B.Z + w2 * t.C.Z);
                }
            }
        }

        private static float Cross(Vector2 u, Vector2 v) => u.X * v.Y - u.Y * v.X;

        /// <summary>
        /// The colour blades take from a grass material: its own colour when it reads green, nudged towards a natural
        /// green; else the default green (a texture-only material's shading colour is often grey).
        /// </summary>
        public static Vector3 GrassColour(Vector3 colour)
        {
            bool green = colour.Y > colour.X * 1.05f && colour.Y > colour.Z && colour.Y > 0.08f;
            return green ? Vector3.Lerp(colour, DEFAULT_GREEN, 0.3f) : DEFAULT_GREEN;
        }

        #endregion

        #region Lookup

        /// <summary>
        /// The grass at a point (CPU lookup for tests and picking): false when none.
        /// </summary>
        public bool TryGet(float x, float y, out float z, out int palette)
        {
            z = 0f;
            palette = -1;
            if (IsEmpty) { return false; }
            int cx = (int)MathF.Floor((x - Min.X) / Cell), cy = (int)MathF.Floor((y - Min.Y) / Cell);
            if (cx < 0 || cy < 0 || cx >= Width || cy >= Height) { return false; }
            int index = cy * Width + cx;
            if (Palette[index] == 0) { return false; }
            z = Heights[index];
            palette = Palette[index] - 1;
            return true;
        }

        #endregion

        /// <summary>One triangle for the field: corners and palette slot (0 = a cover, else palette index + 1).</summary>
        public readonly struct Triangle
        {
            /// <summary>Corners (scene-local metres).</summary>
            public readonly Vector3 A, B, C;

            /// <summary>Palette slot.</summary>
            public readonly byte Palette;

            /// <summary>Bounds seen from above.</summary>
            public readonly Vector2 MinXY, MaxXY;

            /// <summary>Creates a triangle.</summary>
            public Triangle(Vector3 a, Vector3 b, Vector3 c, byte palette)
            {
                A = a;
                B = b;
                C = c;
                Palette = palette;
                MinXY = new Vector2(MathF.Min(a.X, MathF.Min(b.X, c.X)), MathF.Min(a.Y, MathF.Min(b.Y, c.Y)));
                MaxXY = new Vector2(MathF.Max(a.X, MathF.Max(b.X, c.X)), MathF.Max(a.Y, MathF.Max(b.Y, c.Y)));
            }
        }
    }
}
