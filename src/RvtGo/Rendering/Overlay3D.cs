using System.Numerics;
using System.Runtime.InteropServices;
using RvtGo.Native;

// The class belongs to the Rendering namespace
namespace RvtGo.Rendering
{
    /// <summary>
    /// A vertex of the 3D overlay (lines, rings, markers).
    /// </summary>
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    internal struct OverlayVertex
    {
        /// <summary>Size in bytes.</summary>
        public const int SIZE = 16;

        /// <summary>World position.</summary>
        public Vector3 Position;

        /// <summary>RGBA8 colour.</summary>
        public uint Colour;
    }

    /// <summary>
    /// Immediate-mode 3D overlay: thick screen-facing lines, discs and rings in world space.
    /// Geometry is rebuilt each frame into a reused array (no allocations after warm-up).
    /// </summary>
    internal sealed unsafe class Overlay3D : IDisposable
    {
        private OverlayVertex[] _vertices = new OverlayVertex[16384];
        private int _count;
        private int _capacityOnGpu;
        private uint _vao, _vbo;
        private ShaderProgram _program;
        private int _viewProj, _alpha;

        private Vector3 _eye;
        private float _pixelScale;

        /// <summary>
        /// Creates GL objects.
        /// </summary>
        public void Initialise()
        {
            _program = ShaderProgram.Create("overlay", Shaders.OVERLAY_VS, Shaders.OVERLAY_FS);
            _viewProj = _program.Uniform("uViewProj");
            _alpha = _program.Uniform("uAlpha");

            _vao = Gl.GenVertexArray();
            Gl.BindVertexArray(_vao);
            _vbo = Gl.GenBuffer();
            Gl.BindBuffer(Gl.ARRAY_BUFFER, _vbo);
            _capacityOnGpu = _vertices.Length;
            Gl.BufferData(Gl.ARRAY_BUFFER, (nint)_capacityOnGpu * OverlayVertex.SIZE, null, Gl.STREAM_DRAW);
            Gl.EnableVertexAttribArray(0);
            Gl.VertexAttribPointer(0, 3, Gl.FLOAT, false, OverlayVertex.SIZE, 0);
            Gl.EnableVertexAttribArray(1);
            Gl.VertexAttribPointer(1, 4, Gl.UNSIGNED_BYTE, true, OverlayVertex.SIZE, 12);
            Gl.BindVertexArray(0);
        }

        /// <summary>
        /// Starts a new frame of overlay geometry.
        /// </summary>
        public void Begin(FpsCamera camera)
        {
            _count = 0;
            _eye = camera.Position;
            _pixelScale = camera.PixelScale;
        }

        /// <summary>
        /// A screen-facing line with a constant pixel width.
        /// </summary>
        public void Line(Vector3 a, Vector3 b, float widthPixels, uint colour)
        {
            Vector3 dir = b - a;
            float length = dir.Length();
            if (length < 1e-5f) { return; }
            dir /= length;

            Vector3 mid = (a + b) * 0.5f;
            Vector3 toEye = _eye - mid;
            Vector3 side = Vector3.Cross(dir, toEye);
            float sideLength = side.Length();
            if (sideLength < 1e-6f) { return; }
            side /= sideLength;

            float halfA = 0.5f * widthPixels * _pixelScale * MathF.Max(Vector3.Distance(_eye, a), 0.05f);
            float halfB = 0.5f * widthPixels * _pixelScale * MathF.Max(Vector3.Distance(_eye, b), 0.05f);
            Quad(a - side * halfA, a + side * halfA, b + side * halfB, b - side * halfB, colour);
        }

        /// <summary>
        /// A filled disc in a plane.
        /// </summary>
        public void Disc(Vector3 centre, Vector3 axisU, Vector3 axisV, float radiusU, float radiusV, uint colour, int segments = 32)
        {
            Vector3 previous = centre + axisU * radiusU;
            for (int i = 1; i <= segments; i++)
            {
                float angle = i * MathF.Tau / segments;
                Vector3 next = centre + axisU * (MathF.Cos(angle) * radiusU) + axisV * (MathF.Sin(angle) * radiusV);
                Triangle(centre, previous, next, colour);
                previous = next;
            }
        }

        /// <summary>
        /// An elliptical ring in a plane (world thickness).
        /// </summary>
        public void Ring(Vector3 centre, Vector3 axisU, Vector3 axisV, float radiusU, float radiusV, float thickness, uint colour, int segments = 40)
        {
            for (int i = 0; i < segments; i++)
            {
                float a0 = i * MathF.Tau / segments, a1 = (i + 1) * MathF.Tau / segments;
                Vector3 o0 = centre + axisU * (MathF.Cos(a0) * (radiusU + thickness)) + axisV * (MathF.Sin(a0) * (radiusV + thickness));
                Vector3 i0 = centre + axisU * (MathF.Cos(a0) * radiusU) + axisV * (MathF.Sin(a0) * radiusV);
                Vector3 o1 = centre + axisU * (MathF.Cos(a1) * (radiusU + thickness)) + axisV * (MathF.Sin(a1) * (radiusV + thickness));
                Vector3 i1 = centre + axisU * (MathF.Cos(a1) * radiusU) + axisV * (MathF.Sin(a1) * radiusV);
                Quad(i0, o0, o1, i1, colour);
            }
        }

        /// <summary>
        /// A camera-facing marker dot with a constant pixel radius.
        /// </summary>
        public void Dot(Vector3 centre, float radiusPixels, uint colour, int segments = 16)
        {
            Vector3 toEye = _eye - centre;
            float distance = toEye.Length();
            if (distance < 1e-4f) { return; }
            Vector3 forward = toEye / distance;
            Vector3 up = MathF.Abs(forward.Z) > 0.95f ? Vector3.UnitX : Vector3.UnitZ;
            Vector3 u = Vector3.Normalize(Vector3.Cross(up, forward));
            Vector3 v = Vector3.Cross(forward, u);
            float r = radiusPixels * _pixelScale * distance;
            Disc(centre, u, v, r, r, colour, segments);
        }

        /// <summary>
        /// Adds a quad (two triangles).
        /// </summary>
        public void Quad(Vector3 a, Vector3 b, Vector3 c, Vector3 d, uint colour)
        {
            Triangle(a, b, c, colour);
            Triangle(a, c, d, colour);
        }

        /// <summary>
        /// Adds a triangle.
        /// </summary>
        public void Triangle(Vector3 a, Vector3 b, Vector3 c, uint colour)
        {
            if (_count + 3 > _vertices.Length) { Array.Resize(ref _vertices, _vertices.Length * 2); }
            _vertices[_count++] = new OverlayVertex { Position = a, Colour = colour };
            _vertices[_count++] = new OverlayVertex { Position = b, Colour = colour };
            _vertices[_count++] = new OverlayVertex { Position = c, Colour = colour };
        }

        /// <summary>
        /// Draws everything added since <see cref="Begin"/>.
        /// </summary>
        /// <param name="camera">The camera.</param>
        /// <param name="depthTest">Respect the depth buffer.</param>
        /// <param name="alpha">Global alpha multiplier.</param>
        /// <param name="additive">Additive blending (glow).</param>
        public void Draw(FpsCamera camera, bool depthTest, float alpha, bool additive)
        {
            if (_count == 0) { return; }

            Gl.BindVertexArray(_vao);
            Gl.BindBuffer(Gl.ARRAY_BUFFER, _vbo);
            if (_vertices.Length > _capacityOnGpu)
            {
                _capacityOnGpu = _vertices.Length;
                Gl.BufferData(Gl.ARRAY_BUFFER, (nint)_capacityOnGpu * OverlayVertex.SIZE, null, Gl.STREAM_DRAW);
            }
            fixed (OverlayVertex* data = _vertices)
            {
                Gl.BufferSubData(Gl.ARRAY_BUFFER, 0, (nint)_count * OverlayVertex.SIZE, data);
            }

            _program.Use();
            Gl.UniformMatrix4(_viewProj, camera.ViewProjection);
            Gl.Uniform1(_alpha, alpha);

            Gl.Enable(Gl.BLEND);
            Gl.BlendFunc(Gl.SRC_ALPHA, additive ? Gl.ONE : Gl.ONE_MINUS_SRC_ALPHA);
            Gl.DepthMask(false);
            if (depthTest) { Gl.Enable(Gl.DEPTH_TEST); } else { Gl.Disable(Gl.DEPTH_TEST); }
            Gl.Enable(Gl.POLYGON_OFFSET_FILL);
            Gl.PolygonOffset(-1f, -4f);

            Gl.DrawArrays(Gl.TRIANGLES, 0, _count);

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
            Gl.DeleteBuffer(_vbo);
            Gl.DeleteVertexArray(_vao);
        }
    }
}
