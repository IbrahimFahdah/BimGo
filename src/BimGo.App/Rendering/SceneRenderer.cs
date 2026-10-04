using System.Numerics;
using System.Runtime.InteropServices;
using BimGo.Native;
using BimGo.Physics;
using BimGo.Scene;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// Per-pass parameters for the scene shader.
    /// </summary>
    internal struct SceneDrawParams
    {
        /// <summary>View-projection matrix.</summary>
        public Matrix4x4 ViewProjection;

        /// <summary>Frustum planes for chunk culling.</summary>
        public Vector4[] Planes;

        /// <summary>Eye position (fog, lighting).</summary>
        public Vector3 Eye;

        /// <summary>Greyscale colours.</summary>
        public bool Whitecard;

        /// <summary>Top-down plan shading (minimap).</summary>
        public bool Plan;

        /// <summary>Visible Z range (minimap cut); use a huge range otherwise.</summary>
        public Vector2 ClipZ;

        /// <summary>Fog density (0 = none).</summary>
        public float FogDensity;
    }

    /// <summary>
    /// Owns the static scene buffers and draws sky, batches, ground and highlights.
    /// </summary>
    internal sealed unsafe class SceneRenderer : IDisposable
    {
        #region Fields

        /// <summary>Sky / fog colour.</summary>
        public static readonly Vector3 FOG_COLOUR = new(0.80f, 0.85f, 0.89f);

        private static readonly Vector3 LIGHT_DIR = Vector3.Normalize(new Vector3(0.35f, 0.22f, 0.91f));

        private ShaderProgram _sceneProgram, _skyProgram, _groundProgram;
        private SceneUniforms _sceneUniforms;
        private int _skyInvViewProj, _skyEye, _groundViewProj, _groundCenter, _groundHalf, _groundEye, _groundFog;

        private uint _vao, _vbo, _ibo, _emptyVao;

        private SceneBatches _batches;
        private int[] _drawCounts = Array.Empty<int>();
        private nint[] _drawOffsets = Array.Empty<nint>();

        // Hidden elements: their index ranges are overwritten with degenerate triangles (scratch reused)
        private uint[] _degenerate = Array.Empty<uint>();

        // Dynamic (moved / cloned) geometry: copies of source index ranges drawn with a model matrix
        private uint _dynamicVao, _dynamicIbo;
        private readonly List<uint> _dynamicIndices = new();
        private ElementRange[] _dynamicRanges = Array.Empty<ElementRange>();
        private bool[] _hasDynamicRange = Array.Empty<bool>();
        private bool _dynamicDirty;

        /// <summary>Chunks drawn last frame (stats).</summary>
        public int ChunksDrawn { get; private set; }

        #endregion

        /// <summary>
        /// Uniform locations of a scene-shaded program.
        /// </summary>
        private struct SceneUniforms
        {
            public int ViewProj, Model, Eye, LightDir, FogColor, FogDensity, Whitecard, Plan, ClipZ, Override;

            public static SceneUniforms From(ShaderProgram p) => new()
            {
                ViewProj = p.Uniform("uViewProj"),
                Model = p.Uniform("uModel"),
                Eye = p.Uniform("uEye"),
                LightDir = p.Uniform("uLightDir"),
                FogColor = p.Uniform("uFogColor"),
                FogDensity = p.Uniform("uFogDensity"),
                Whitecard = p.Uniform("uWhitecard"),
                Plan = p.Uniform("uPlan"),
                ClipZ = p.Uniform("uClipZ"),
                Override = p.Uniform("uOverride")
            };
        }

        #region Setup

        /// <summary>
        /// Creates programs and uploads the static scene.
        /// </summary>
        /// <param name="scene">The snapshot.</param>
        /// <param name="batches">The re-ordered batches.</param>
        public void Initialise(SceneData scene, SceneBatches batches)
        {
            _batches = batches;

            _sceneProgram = ShaderProgram.Create("scene", Shaders.SCENE_VS, Shaders.SCENE_FS);
            _skyProgram = ShaderProgram.Create("sky", Shaders.FULLSCREEN_VS, Shaders.SKY_FS);
            _groundProgram = ShaderProgram.Create("ground", Shaders.GROUND_VS, Shaders.GROUND_FS);

            _sceneUniforms = SceneUniforms.From(_sceneProgram);
            _skyInvViewProj = _skyProgram.Uniform("uInvViewProj");
            _skyEye = _skyProgram.Uniform("uEye");
            _groundViewProj = _groundProgram.Uniform("uViewProj");
            _groundCenter = _groundProgram.Uniform("uCenter");
            _groundHalf = _groundProgram.Uniform("uHalf");
            _groundEye = _groundProgram.Uniform("uEye");
            _groundFog = _groundProgram.Uniform("uFogColor");

            // Static geometry
            _vao = Gl.GenVertexArray();
            Gl.BindVertexArray(_vao);

            _vbo = Gl.GenBuffer();
            Gl.BindBuffer(Gl.ARRAY_BUFFER, _vbo);
            fixed (SceneVertex* v = scene.Vertices)
            {
                Gl.BufferData(Gl.ARRAY_BUFFER, (nint)scene.Vertices.Length * SceneVertex.SIZE, v, Gl.STATIC_DRAW);
            }

            _ibo = Gl.GenBuffer();
            Gl.BindBuffer(Gl.ELEMENT_ARRAY_BUFFER, _ibo);
            fixed (uint* i = batches.Indices)
            {
                Gl.BufferData(Gl.ELEMENT_ARRAY_BUFFER, (nint)batches.Indices.Length * sizeof(uint), i, Gl.STATIC_DRAW);
            }

            SetVertexLayout();
            Gl.BindVertexArray(0);

            // Dynamic geometry shares the vertex buffer, with its own (small) index buffer
            _dynamicVao = Gl.GenVertexArray();
            Gl.BindVertexArray(_dynamicVao);
            Gl.BindBuffer(Gl.ARRAY_BUFFER, _vbo);
            _dynamicIbo = Gl.GenBuffer();
            Gl.BindBuffer(Gl.ELEMENT_ARRAY_BUFFER, _dynamicIbo);
            SetVertexLayout();
            Gl.BindVertexArray(0);
            _dynamicRanges = new ElementRange[scene.Elements.Length];
            _hasDynamicRange = new bool[scene.Elements.Length];

            int maxChunks = 1;
            foreach (RenderBatch batch in batches.Batches) { maxChunks = Math.Max(maxChunks, batch.ChunkCount); }
            _drawCounts = new int[maxChunks];
            _drawOffsets = new nint[maxChunks];

            _emptyVao = Gl.GenVertexArray();
        }

        /// <summary>
        /// Vertex attributes of <see cref="SceneVertex"/> for the bound VAO / VBO.
        /// </summary>
        private static void SetVertexLayout()
        {
            Gl.EnableVertexAttribArray(0);
            Gl.VertexAttribPointer(0, 3, Gl.FLOAT, false, SceneVertex.SIZE, 0);
            Gl.EnableVertexAttribArray(1);
            Gl.VertexAttribPointer(1, 3, Gl.FLOAT, false, SceneVertex.SIZE, 12);
            Gl.EnableVertexAttribArray(2);
            Gl.VertexAttribPointer(2, 4, Gl.UNSIGNED_BYTE, true, SceneVertex.SIZE, 24);
        }

        #endregion

        #region Element visibility and dynamic geometry

        /// <summary>
        /// Hides or restores an element in the static batches. Hiding overwrites its index ranges with
        /// degenerate triangles (zero raster cost) so the batch / chunk draw lists never change.
        /// </summary>
        /// <param name="element">Element index.</param>
        /// <param name="hidden">True to hide, false to restore.</param>
        public void SetElementHidden(int element, bool hidden)
        {
            ElementRange range = _batches.Ranges[element];
            // The element buffer binding is VAO state (core profile): bind the VAO, never unbind the buffer from it
            Gl.BindVertexArray(_vao);
            Upload(range.OpaqueStart, range.OpaqueCount);
            Upload(range.TransparentStart, range.TransparentCount);
            Gl.BindVertexArray(0);

            void Upload(int start, int count)
            {
                if (count <= 0) { return; }
                if (hidden)
                {
                    if (_degenerate.Length < count) { _degenerate = new uint[Math.Max(count, _degenerate.Length * 2)]; }
                    Array.Fill(_degenerate, _batches.Indices[start], 0, count);
                    fixed (uint* data = _degenerate)
                    {
                        Gl.BufferSubData(Gl.ELEMENT_ARRAY_BUFFER, (nint)start * sizeof(uint), (nint)count * sizeof(uint), data);
                    }
                }
                else
                {
                    fixed (uint* data = &_batches.Indices[start])
                    {
                        Gl.BufferSubData(Gl.ELEMENT_ARRAY_BUFFER, (nint)start * sizeof(uint), (nint)count * sizeof(uint), data);
                    }
                }
            }
        }

        /// <summary>
        /// Makes sure an element's triangles are available to the dynamic pass (copied once per source element;
        /// clones of the same element share them).
        /// </summary>
        public void EnsureDynamicGeometry(int element)
        {
            if (_hasDynamicRange[element]) { return; }

            ElementRange source = _batches.Ranges[element];
            var range = new ElementRange
            {
                OpaqueStart = _dynamicIndices.Count,
                OpaqueCount = source.OpaqueCount
            };
            for (int i = 0; i < source.OpaqueCount; i++) { _dynamicIndices.Add(_batches.Indices[source.OpaqueStart + i]); }
            range.TransparentStart = _dynamicIndices.Count;
            range.TransparentCount = source.TransparentCount;
            for (int i = 0; i < source.TransparentCount; i++) { _dynamicIndices.Add(_batches.Indices[source.TransparentStart + i]); }

            _dynamicRanges[element] = range;
            _hasDynamicRange[element] = true;
            _dynamicDirty = true;
        }

        /// <summary>
        /// Uploads the dynamic index buffer if it changed.
        /// </summary>
        private void FlushDynamic()
        {
            if (!_dynamicDirty) { return; }
            _dynamicDirty = false;
            uint[] data = _dynamicIndices.ToArray();
            Gl.BindVertexArray(_dynamicVao);
            fixed (uint* pointer = data)
            {
                Gl.BufferData(Gl.ELEMENT_ARRAY_BUFFER, (nint)data.Length * sizeof(uint), pointer, Gl.DYNAMIC_DRAW);
            }
            Gl.BindVertexArray(0);
        }

        /// <summary>
        /// Draws the active dynamic instances of one pass.
        /// </summary>
        public void DrawDynamic(in SceneDrawParams p, DynamicSet set, bool transparent)
        {
            if (set.Instances.Count == 0) { return; }
            FlushDynamic();

            _sceneProgram.Use();
            ApplyUniforms(_sceneUniforms, p, Vector4.Zero);
            Gl.BindVertexArray(_dynamicVao);
            foreach (DynamicInstance instance in set.Instances)
            {
                if (!set.IsActive(instance) || !_hasDynamicRange[instance.Element]) { continue; }
                if (!FpsCamera.IsVisible(p.Planes, instance.WorldBounds)) { continue; }
                DrawDynamicRange(instance, transparent);
            }
            Gl.UniformMatrix4(_sceneUniforms.Model, Matrix4x4.Identity);
            Gl.BindVertexArray(0);
        }

        /// <summary>
        /// Draws one dynamic instance with a colour override (highlights).
        /// </summary>
        public void DrawDynamicHighlight(in SceneDrawParams p, DynamicInstance instance, Vector4 colour)
        {
            if (!_hasDynamicRange[instance.Element]) { return; }
            FlushDynamic();

            _sceneProgram.Use();
            ApplyUniforms(_sceneUniforms, p, colour);
            Gl.BindVertexArray(_dynamicVao);
            DrawDynamicRange(instance, transparent: false);
            DrawDynamicRange(instance, transparent: true);
            Gl.UniformMatrix4(_sceneUniforms.Model, Matrix4x4.Identity);
            Gl.BindVertexArray(0);
        }

        private void DrawDynamicRange(DynamicInstance instance, bool transparent)
        {
            ElementRange range = _dynamicRanges[instance.Element];
            int start = transparent ? range.TransparentStart : range.OpaqueStart;
            int count = transparent ? range.TransparentCount : range.OpaqueCount;
            if (count <= 0) { return; }
            Gl.UniformMatrix4(_sceneUniforms.Model, instance.Model);
            Gl.DrawElements(Gl.TRIANGLES, count, Gl.UNSIGNED_INT, (nint)start * sizeof(uint));
        }

        #endregion

        #region Drawing

        /// <summary>
        /// Draws the gradient sky (no depth).
        /// </summary>
        public void DrawSky(FpsCamera camera)
        {
            Gl.Disable(Gl.DEPTH_TEST);
            Gl.DepthMask(false);
            _skyProgram.Use();
            Gl.UniformMatrix4(_skyInvViewProj, camera.InverseViewProjection);
            Gl.Uniform3(_skyEye, camera.Position.X, camera.Position.Y, camera.Position.Z);
            Gl.BindVertexArray(_emptyVao);
            Gl.DrawArrays(Gl.TRIANGLES, 0, 3);
            Gl.DepthMask(true);
            Gl.Enable(Gl.DEPTH_TEST);
        }

        /// <summary>
        /// Draws the infinite-looking ground plane.
        /// </summary>
        public void DrawGround(FpsCamera camera, float groundZ)
        {
            _groundProgram.Use();
            Gl.UniformMatrix4(_groundViewProj, camera.ViewProjection);
            Gl.Uniform3(_groundCenter, camera.Position.X, camera.Position.Y, groundZ);
            Gl.Uniform1(_groundHalf, 2500f);
            Gl.Uniform3(_groundEye, camera.Position.X, camera.Position.Y, camera.Position.Z);
            Gl.Uniform3(_groundFog, FOG_COLOUR.X, FOG_COLOUR.Y, FOG_COLOUR.Z);
            Gl.BindVertexArray(_emptyVao);
            Gl.DrawArrays(Gl.TRIANGLES, 0, 6);
        }

        /// <summary>
        /// Draws all visible batches of one pass with frustum-culled chunks (one multi-draw per batch).
        /// </summary>
        /// <param name="p">Draw parameters.</param>
        /// <param name="categoryVisible">Per catalog index visibility.</param>
        /// <param name="transparent">Which pass.</param>
        public void DrawStatic(in SceneDrawParams p, bool[] categoryVisible, bool transparent)
        {
            if (!transparent) { ChunksDrawn = 0; }

            _sceneProgram.Use();
            ApplyUniforms(_sceneUniforms, p, Vector4.Zero);
            Gl.BindVertexArray(_vao);

            RenderBatch[] batches = _batches.Batches;
            RenderChunk[] chunks = _batches.Chunks;

            fixed (int* counts = _drawCounts)
            fixed (nint* offsets = _drawOffsets)
            {
                for (int b = 0; b < batches.Length; b++)
                {
                    RenderBatch batch = batches[b];
                    if (batch.Transparent != transparent || !categoryVisible[batch.CategoryIndex]) { continue; }

                    int drawCount = 0;
                    int end = batch.ChunkStart + batch.ChunkCount;
                    for (int c = batch.ChunkStart; c < end; c++)
                    {
                        if (!FpsCamera.IsVisible(p.Planes, chunks[c].Bounds)) { continue; }
                        counts[drawCount] = chunks[c].IndexCount;
                        offsets[drawCount] = (nint)chunks[c].IndexStart * sizeof(uint);
                        drawCount++;
                    }

                    if (drawCount > 0)
                    {
                        Gl.MultiDrawElements(Gl.TRIANGLES, counts, Gl.UNSIGNED_INT, (void**)offsets, drawCount);
                        ChunksDrawn += drawCount;
                    }
                }
            }
            Gl.BindVertexArray(0);
        }

        /// <summary>
        /// Draws an element again with a colour override (scan highlight).
        /// </summary>
        public void DrawElementHighlight(in SceneDrawParams p, int elementIndex, Vector4 colour)
        {
            ElementRange range = _batches.Ranges[elementIndex];
            _sceneProgram.Use();
            ApplyUniforms(_sceneUniforms, p, colour);
            Gl.BindVertexArray(_vao);
            if (range.OpaqueCount > 0) { Gl.DrawElements(Gl.TRIANGLES, range.OpaqueCount, Gl.UNSIGNED_INT, (nint)range.OpaqueStart * sizeof(uint)); }
            if (range.TransparentCount > 0) { Gl.DrawElements(Gl.TRIANGLES, range.TransparentCount, Gl.UNSIGNED_INT, (nint)range.TransparentStart * sizeof(uint)); }
            Gl.BindVertexArray(0);
        }

        private static void ApplyUniforms(in SceneUniforms u, in SceneDrawParams p, Vector4 overrideColour)
        {
            Gl.UniformMatrix4(u.ViewProj, p.ViewProjection);
            Gl.UniformMatrix4(u.Model, Matrix4x4.Identity);
            Gl.Uniform3(u.Eye, p.Eye.X, p.Eye.Y, p.Eye.Z);
            Gl.Uniform3(u.LightDir, LIGHT_DIR.X, LIGHT_DIR.Y, LIGHT_DIR.Z);
            Gl.Uniform3(u.FogColor, FOG_COLOUR.X, FOG_COLOUR.Y, FOG_COLOUR.Z);
            Gl.Uniform1(u.FogDensity, p.FogDensity);
            Gl.Uniform1(u.Whitecard, p.Whitecard ? 1 : 0);
            Gl.Uniform1(u.Plan, p.Plan ? 1 : 0);
            Gl.Uniform2(u.ClipZ, p.ClipZ.X, p.ClipZ.Y);
            Gl.Uniform4(u.Override, overrideColour.X, overrideColour.Y, overrideColour.Z, overrideColour.W);
        }

        #endregion

        /// <summary>
        /// Releases GL resources.
        /// </summary>
        public void Dispose()
        {
            _sceneProgram?.Dispose();
            _skyProgram?.Dispose();
            _groundProgram?.Dispose();
            Gl.DeleteBuffer(_vbo);
            Gl.DeleteBuffer(_ibo);
            Gl.DeleteBuffer(_dynamicIbo);
            Gl.DeleteVertexArray(_vao);
            Gl.DeleteVertexArray(_dynamicVao);
            Gl.DeleteVertexArray(_emptyVao);
        }
    }
}
