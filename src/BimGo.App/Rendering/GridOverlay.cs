using System.Numerics;
using System.Runtime.InteropServices;
using BimGo.Native;
using BimGo.Scene;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// A vertex of the grid overlay: a segment end, the segment's direction, metres along the grid (negative = solid)
    /// and which side of the line the corner is pushed to.
    /// </summary>
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    internal struct GridVertex
    {
        /// <summary>Size in bytes.</summary>
        public const int SIZE = 36;

        public Vector3 Position;
        public Vector3 Direction;
        public float Along;
        public float Side;
        public uint Colour;
    }

    /// <summary>
    /// Grids round A: the grid lines (Revit-like dash-dot) and the level outlines on each shown level, in one static
    /// vertex buffer that is rebuilt only when what is shown changes (levels, settings, the underfoot level), so a frame
    /// costs one or two draws and no uploads. Widths are constant in pixels (the vertex shader faces each segment to the
    /// eye). The bubbles and tags are 2D UI, drawn by the session.
    /// </summary>
    internal sealed unsafe class GridOverlay : IDisposable
    {
        /// <summary>Lines sit this far above the level (m) so they don't fight the floor's top face.</summary>
        public const float LIFT = 0.03f;

        private GridVertex[] _vertices = new GridVertex[4096];
        private int _count;
        private int _capacityOnGpu;
        private uint _vao, _vbo;
        private ShaderProgram _program;
        private int _viewProj, _eye, _halfWidth, _alpha, _dashed;
        private bool _uploaded;

        /// <summary>Segments in the buffer (stats).</summary>
        public int SegmentCount => _count / 6;

        /// <summary>
        /// Creates the GL objects (once, with the renderer's context current).
        /// </summary>
        public void Initialise()
        {
            _program = ShaderProgram.Create("grids", Shaders.GRID_VS, Shaders.GRID_FS);
            _viewProj = _program.Uniform("uViewProj");
            _eye = _program.Uniform("uEye");
            _halfWidth = _program.Uniform("uHalfWidth");
            _alpha = _program.Uniform("uAlpha");
            _dashed = _program.Uniform("uDashed");

            _vao = Gl.GenVertexArray();
            Gl.BindVertexArray(_vao);
            _vbo = Gl.GenBuffer();
            Gl.BindBuffer(Gl.ARRAY_BUFFER, _vbo);
            _capacityOnGpu = _vertices.Length;
            Gl.BufferData(Gl.ARRAY_BUFFER, (nint)_capacityOnGpu * GridVertex.SIZE, null, Gl.STATIC_DRAW);
            Gl.EnableVertexAttribArray(0);
            Gl.VertexAttribPointer(0, 3, Gl.FLOAT, false, GridVertex.SIZE, 0);
            Gl.EnableVertexAttribArray(1);
            Gl.VertexAttribPointer(1, 3, Gl.FLOAT, false, GridVertex.SIZE, 12);
            Gl.EnableVertexAttribArray(2);
            Gl.VertexAttribPointer(2, 1, Gl.FLOAT, false, GridVertex.SIZE, 24);
            Gl.EnableVertexAttribArray(3);
            Gl.VertexAttribPointer(3, 1, Gl.FLOAT, false, GridVertex.SIZE, 28);
            Gl.EnableVertexAttribArray(4);
            Gl.VertexAttribPointer(4, 4, Gl.UNSIGNED_BYTE, true, GridVertex.SIZE, 32);
            Gl.BindVertexArray(0);
        }

        /// <summary>
        /// Rebuilds the buffer: every included grid on every shown level it reaches (its 3D extent when
        /// <paramref name="respectExtents"/>), and an outline around each level's grids when <paramref name="outlines"/>.
        /// </summary>
        /// <param name="grids">The scene's grids.</param>
        /// <param name="levels">The scene's levels.</param>
        /// <param name="shown">Indices of the levels to draw on.</param>
        /// <param name="links">Include link grids.</param>
        /// <param name="respectExtents">Only on levels inside each grid's 3D extent.</param>
        /// <param name="outlines">A rectangle per level around its grids.</param>
        /// <param name="lineColour">Grid line colour (packed RGBA).</param>
        /// <param name="outlineColour">Outline colour (packed RGBA).</param>
        public void Build(IReadOnlyList<GridLine> grids, IReadOnlyList<LevelInfo> levels, List<int> shown, bool links, bool respectExtents,
            bool outlines, uint lineColour, uint outlineColour)
        {
            _count = 0;
            _uploaded = false;
            if (grids == null || levels == null || shown == null) { return; }
            foreach (int index in shown)
            {
                if ((uint)index >= (uint)levels.Count) { continue; }
                float z = levels[index].Elevation + LIFT;
                foreach (GridLine grid in grids)
                {
                    if (!GridLayout.Included(grid, links) || !GridLayout.ShowsAt(grid, levels[index].Elevation, respectExtents)) { continue; }
                    float along = 0f;
                    for (int i = 1; i < grid.Points.Length; i++)
                    {
                        Vector2 a = grid.Points[i - 1], b = grid.Points[i];
                        float length = Vector2.Distance(a, b);
                        Segment(new Vector3(a, z), new Vector3(b, z), along, along + length, lineColour);
                        along += length;
                    }
                }
                if (outlines && GridLayout.PlanBounds(grids, levels[index].Elevation, respectExtents, links, out Vector2 min, out Vector2 max))
                {
                    var c0 = new Vector3(min.X, min.Y, z);
                    var c1 = new Vector3(max.X, min.Y, z);
                    var c2 = new Vector3(max.X, max.Y, z);
                    var c3 = new Vector3(min.X, max.Y, z);
                    Segment(c0, c1, -1f, -1f, outlineColour);
                    Segment(c1, c2, -1f, -1f, outlineColour);
                    Segment(c2, c3, -1f, -1f, outlineColour);
                    Segment(c3, c0, -1f, -1f, outlineColour);
                }
            }
        }

        /// <summary>Empties the buffer (grids off).</summary>
        public void Clear()
        {
            _count = 0;
            _uploaded = false;
        }

        // One segment as two triangles; the corners carry ±1 for the side the shader pushes them to
        private void Segment(Vector3 a, Vector3 b, float alongA, float alongB, uint colour)
        {
            Vector3 d = b - a;
            float length = d.Length();
            if (length < 1e-5f) { return; }
            d /= length;
            if (_count + 6 > _vertices.Length) { Array.Resize(ref _vertices, _vertices.Length * 2); }
            Put(a, d, alongA, -1f, colour);
            Put(a, d, alongA, 1f, colour);
            Put(b, d, alongB, 1f, colour);
            Put(a, d, alongA, -1f, colour);
            Put(b, d, alongB, 1f, colour);
            Put(b, d, alongB, -1f, colour);
        }

        private void Put(Vector3 p, Vector3 d, float along, float side, uint colour) =>
            _vertices[_count++] = new GridVertex { Position = p, Direction = d, Along = along, Side = side, Colour = colour };

        /// <summary>
        /// Draws the lines. <paramref name="depthMode"/>: 0 faint through walls (full where seen, a quarter behind),
        /// 1 depth-tested only, 2 x-ray (always on top). <paramref name="dashed"/>: the Revit-like dash-dot (grids round B;
        /// solid otherwise).
        /// </summary>
        public void Draw(FpsCamera camera, int depthMode, float opacity, float widthPixels, bool dashed)
        {
            if (_count == 0 || _program == null) { return; }
            Gl.BindVertexArray(_vao);
            Gl.BindBuffer(Gl.ARRAY_BUFFER, _vbo);
            if (!_uploaded)
            {
                if (_vertices.Length > _capacityOnGpu)
                {
                    _capacityOnGpu = _vertices.Length;
                    Gl.BufferData(Gl.ARRAY_BUFFER, (nint)_capacityOnGpu * GridVertex.SIZE, null, Gl.STATIC_DRAW);
                }
                fixed (GridVertex* data = _vertices)
                {
                    Gl.BufferSubData(Gl.ARRAY_BUFFER, 0, (nint)_count * GridVertex.SIZE, data);
                }
                _uploaded = true;
            }

            _program.Use();
            Gl.UniformMatrix4(_viewProj, camera.ViewProjection);
            Gl.Uniform3(_eye, camera.Position.X, camera.Position.Y, camera.Position.Z);
            Gl.Uniform1(_halfWidth, 0.5f * widthPixels * camera.PixelScale);
            Gl.Uniform1(_dashed, dashed ? 1 : 0);

            Gl.Enable(Gl.BLEND);
            Gl.BlendFunc(Gl.SRC_ALPHA, Gl.ONE_MINUS_SRC_ALPHA);
            Gl.DepthMask(false);
            Gl.Enable(Gl.POLYGON_OFFSET_FILL);
            Gl.PolygonOffset(-1f, -4f);

            if (depthMode == 2)
            {
                Gl.Disable(Gl.DEPTH_TEST);
                Gl.Uniform1(_alpha, opacity);
                Gl.DrawArrays(Gl.TRIANGLES, 0, _count);
            }
            else
            {
                if (depthMode == 0)
                {
                    // Behind walls first (faint), then the visible parts at full strength over them
                    Gl.Disable(Gl.DEPTH_TEST);
                    Gl.Uniform1(_alpha, opacity * 0.25f);
                    Gl.DrawArrays(Gl.TRIANGLES, 0, _count);
                }
                Gl.Enable(Gl.DEPTH_TEST);
                Gl.Uniform1(_alpha, opacity);
                Gl.DrawArrays(Gl.TRIANGLES, 0, _count);
            }

            Gl.Disable(Gl.POLYGON_OFFSET_FILL);
            Gl.Enable(Gl.DEPTH_TEST);
            Gl.DepthMask(true);
            Gl.Disable(Gl.BLEND);
            Gl.BindVertexArray(0);
        }

        /// <summary>
        /// Releases GL resources.
        /// </summary>
        public void Dispose()
        {
            _program?.Dispose();
            if (_vbo != 0) { Gl.DeleteBuffer(_vbo); }
            if (_vao != 0) { Gl.DeleteVertexArray(_vao); }
        }
    }
}
