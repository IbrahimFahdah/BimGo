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

        /// <summary>Use the renderer's sun lighting (when it is on); false for the plan minimap.</summary>
        public bool Sun;
    }

    /// <summary>
    /// Owns the static scene buffers and draws sky, batches, ground and highlights, and (when the sun is on) the
    /// cascaded shadow maps. Lighting comes from <see cref="Lighting"/>: off = the classic fixed light.
    /// </summary>
    internal sealed unsafe class SceneRenderer : IDisposable
    {
        #region Fields

        /// <summary>Sky / fog colour.</summary>
        public static readonly Vector3 FOG_COLOUR = new(0.80f, 0.85f, 0.89f);

        private static readonly Vector3 LIGHT_DIR = Vector3.Normalize(new Vector3(0.35f, 0.22f, 0.91f));

        private ShaderProgram _sceneProgram, _skyProgram, _groundProgram, _shadowDepthProgram, _shadowTransmitProgram;
        private SceneUniforms _sceneUniforms;
        private LightUniforms _sceneLight, _groundLight;
        private int _skyInvViewProj, _skyEye, _groundViewProj, _groundCenter, _groundHalf, _groundEye, _groundFog;
        private int _skySun, _skySunDir, _skyZenith, _skyHorizon, _skyDisc;
        private int _depthViewProj, _depthModel, _transmitViewProj, _transmitModel, _transmitGlass, _transmitWhitecard;

        // Sun and shadows
        private readonly ShadowMaps _shadows = new();
        private readonly bool[] _cascadeDirty = new bool[ShadowMaps.MAX_CASCADES];
        private Vector3 _cameraForward = Vector3.UnitX;
        private bool _shadowsActive;
        private bool _hasTransparent;

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

        /// <summary>This frame's sun and sky (Enabled = false: the classic fixed light, no shadows).</summary>
        public SunLighting Lighting;

        /// <summary>The fog / clear colour: the sky's horizon when the sun is on.</summary>
        public Vector3 FogColour => Lighting.Enabled ? Lighting.Horizon : FOG_COLOUR;

        /// <summary>The shadow maps (state, presets, last error).</summary>
        public ShadowMaps Shadows => _shadows;

        #endregion

        /// <summary>
        /// Uniform locations of the sun / shadow block shared by the scene and ground shaders.
        /// </summary>
        private struct LightUniforms
        {
            public int Sun, SunDir, SunColor, SkyColor, ShadowStrength, ShadowsOn, TransmitOn, CamForward;
            public int CascadeCount, CascadeFar, NormalOffset, ShadowTexel, Pcf, ShadowFar;
            public int ShadowMat0, ShadowMat1, ShadowMat2, ShadowMat3;

            public static LightUniforms From(ShaderProgram p)
            {
                // The samplers read fixed texture units (set once)
                p.Use();
                Gl.Uniform1(p.Uniform("uShadowMap"), ShadowMaps.DEPTH_UNIT);
                Gl.Uniform1(p.Uniform("uTransmit"), ShadowMaps.TRANSMIT_UNIT);
                return new LightUniforms
                {
                    Sun = p.Uniform("uSun"),
                    SunDir = p.Uniform("uSunDir"),
                    SunColor = p.Uniform("uSunColor"),
                    SkyColor = p.Uniform("uSkyColor"),
                    ShadowStrength = p.Uniform("uShadowStrength"),
                    ShadowsOn = p.Uniform("uShadowsOn"),
                    TransmitOn = p.Uniform("uTransmitOn"),
                    CamForward = p.Uniform("uCamForward"),
                    CascadeCount = p.Uniform("uCascadeCount"),
                    CascadeFar = p.Uniform("uCascadeFar"),
                    NormalOffset = p.Uniform("uNormalOffset"),
                    ShadowTexel = p.Uniform("uShadowTexel"),
                    Pcf = p.Uniform("uPcf"),
                    ShadowFar = p.Uniform("uShadowFar"),
                    ShadowMat0 = p.Uniform("uShadowMat[0]"),
                    ShadowMat1 = p.Uniform("uShadowMat[1]"),
                    ShadowMat2 = p.Uniform("uShadowMat[2]"),
                    ShadowMat3 = p.Uniform("uShadowMat[3]")
                };
            }
        }

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
            _shadowDepthProgram = ShaderProgram.Create("shadow depth", Shaders.SHADOW_VS, Shaders.SHADOW_DEPTH_FS);
            _shadowTransmitProgram = ShaderProgram.Create("shadow glass", Shaders.SHADOW_VS, Shaders.SHADOW_TRANSMIT_FS);

            _sceneUniforms = SceneUniforms.From(_sceneProgram);
            _sceneLight = LightUniforms.From(_sceneProgram);
            _groundLight = LightUniforms.From(_groundProgram);
            _skyInvViewProj = _skyProgram.Uniform("uInvViewProj");
            _skyEye = _skyProgram.Uniform("uEye");
            _skySun = _skyProgram.Uniform("uSun");
            _skySunDir = _skyProgram.Uniform("uSunDir");
            _skyZenith = _skyProgram.Uniform("uZenith");
            _skyHorizon = _skyProgram.Uniform("uHorizon");
            _skyDisc = _skyProgram.Uniform("uSunDisc");
            _depthViewProj = _shadowDepthProgram.Uniform("uViewProj");
            _depthModel = _shadowDepthProgram.Uniform("uModel");
            _transmitViewProj = _shadowTransmitProgram.Uniform("uViewProj");
            _transmitModel = _shadowTransmitProgram.Uniform("uModel");
            _transmitGlass = _shadowTransmitProgram.Uniform("uGlass");
            _transmitWhitecard = _shadowTransmitProgram.Uniform("uWhitecard");
            Gl.UseProgram(0);
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
            foreach (RenderBatch batch in batches.Batches)
            {
                maxChunks = Math.Max(maxChunks, batch.ChunkCount);
                if (batch.Transparent) { _hasTransparent = true; }
            }
            _drawCounts = new int[maxChunks];
            _drawOffsets = new nint[maxChunks];

            _emptyVao = Gl.GenVertexArray();
            _shadows.Initialise();
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
            ApplyUniforms(_sceneUniforms, p, Vector4.Zero, transmit: !transparent);
            DrawDynamicInstances(set, p.Planes, transparent, _sceneUniforms.Model);
        }

        /// <summary>
        /// Draws one dynamic instance with a colour override (highlights).
        /// </summary>
        public void DrawDynamicHighlight(in SceneDrawParams p, DynamicInstance instance, Vector4 colour)
        {
            if (!_hasDynamicRange[instance.Element]) { return; }
            FlushDynamic();

            _sceneProgram.Use();
            ApplyUniforms(_sceneUniforms, p, colour, transmit: true);
            Gl.BindVertexArray(_dynamicVao);
            DrawDynamicRange(instance, transparent: false, _sceneUniforms.Model);
            DrawDynamicRange(instance, transparent: true, _sceneUniforms.Model);
            Gl.UniformMatrix4(_sceneUniforms.Model, Matrix4x4.Identity);
            Gl.BindVertexArray(0);
        }

        /// <summary>
        /// Draws the active, visible dynamic instances of one pass with the current program.
        /// </summary>
        /// <param name="set">The instances.</param>
        /// <param name="planes">Culling planes.</param>
        /// <param name="transparent">Which ranges.</param>
        /// <param name="modelUniform">The current program's uModel location.</param>
        private void DrawDynamicInstances(DynamicSet set, Vector4[] planes, bool transparent, int modelUniform)
        {
            Gl.BindVertexArray(_dynamicVao);
            foreach (DynamicInstance instance in set.Instances)
            {
                if (!set.IsActive(instance) || !_hasDynamicRange[instance.Element]) { continue; }
                if (!FpsCamera.IsVisible(planes, instance.WorldBounds)) { continue; }
                DrawDynamicRange(instance, transparent, modelUniform);
            }
            Gl.UniformMatrix4(modelUniform, Matrix4x4.Identity);
            Gl.BindVertexArray(0);
        }

        private void DrawDynamicRange(DynamicInstance instance, bool transparent, int modelUniform)
        {
            ElementRange range = _dynamicRanges[instance.Element];
            int start = transparent ? range.TransparentStart : range.OpaqueStart;
            int count = transparent ? range.TransparentCount : range.OpaqueCount;
            if (count <= 0) { return; }
            Gl.UniformMatrix4(modelUniform, instance.Model);
            Gl.DrawElements(Gl.TRIANGLES, count, Gl.UNSIGNED_INT, (nint)start * sizeof(uint));
        }

        #endregion

        #region Sun and shadows

        /// <summary>
        /// Brings the shadow maps up to date for this frame (call before binding the scene target; <see cref="Lighting"/>
        /// must already be set). Only cascades whose fit, the sun or the scene changed are re-rendered. With the sun off
        /// the maps are freed and nothing is drawn.
        /// </summary>
        /// <param name="camera">The player camera (updated).</param>
        /// <param name="sceneBounds">The scene bounds (casters).</param>
        /// <param name="sceneKey">Changes whenever casters change (hidden / moved elements, category and link toggles).</param>
        /// <param name="groupVisible">Per visibility group (category × model, <see cref="SceneBatches.GroupOf"/>).</param>
        /// <param name="dynamics">Moved and cloned elements.</param>
        /// <param name="whitecard">Whitecard colours (glass casts untinted light).</param>
        /// <param name="preset">The quality preset.</param>
        /// <returns>Null, or a reason shadows could not be shown (the caller switches them off).</returns>
        public string UpdateShadows(FpsCamera camera, in Aabb sceneBounds, long sceneKey, bool[] groupVisible, DynamicSet dynamics,
            bool whitecard, ShadowMaps.Preset preset)
        {
            _cameraForward = camera.Forward;
            _shadowsActive = false;

            if (!Lighting.Enabled)
            {
                _shadows.Release();
                return null;
            }

            // Sun below the horizon: no direct light, so nothing to shadow (keep the maps for when it rises)
            if (Lighting.AltitudeDegrees < -1f) { return null; }

            if (!_shadows.Ensure(preset, _hasTransparent)) { return _shadows.LastError; }

            FlushDynamic();
            _shadows.Fit(camera, Lighting.SunDirection, sceneBounds, sceneKey, Lighting.Glass, _cascadeDirty);

            int rendered = 0;
            for (int c = 0; c < preset.Cascades; c++)
            {
                if (!_cascadeDirty[c]) { continue; }
                RenderCascade(c, groupVisible, dynamics, whitecard);
                rendered++;
            }
            _shadows.EndRender(rendered);

            _shadowsActive = true;
            _shadows.Bind();
            return null;
        }

        /// <summary>
        /// Renders one cascade: opaque casters into depth, then glass multiplied into the transmittance layer (only glass
        /// in front of the nearest opaque surface counts, so it never tints what lies behind a lit receiver).
        /// </summary>
        private void RenderCascade(int cascade, bool[] groupVisible, DynamicSet dynamics, bool whitecard)
        {
            _shadows.BeginCascade(cascade);
            Matrix4x4 matrix = _shadows.Matrices[cascade];
            Vector4[] planes = _shadows.PlanesFor(cascade);

            Gl.Enable(Gl.DEPTH_TEST);
            Gl.DepthFunc(Gl.LEQUAL);
            Gl.Disable(Gl.BLEND);
            Gl.Disable(Gl.CULL_FACE);

            // Opaque casters: depth only, pushed back a little against acne
            Gl.ColorMask(false, false, false, false);
            Gl.Enable(Gl.POLYGON_OFFSET_FILL);
            Gl.PolygonOffset(1.5f, 3f);
            _shadowDepthProgram.Use();
            Gl.UniformMatrix4(_depthViewProj, matrix);
            Gl.UniformMatrix4(_depthModel, Matrix4x4.Identity);
            DrawBatches(planes, groupVisible, transparent: false, countStats: false);
            if (dynamics != null && dynamics.Instances.Count > 0) { DrawDynamicInstances(dynamics, planes, transparent: false, _depthModel); }
            Gl.Disable(Gl.POLYGON_OFFSET_FILL);
            Gl.ColorMask(true, true, true, true);

            // Glass: multiply the light that gets through (dst = dst × src)
            if (_shadows.HasTransmit)
            {
                Gl.DepthMask(false);
                Gl.DepthFunc(Gl.LESS);
                Gl.Enable(Gl.BLEND);
                Gl.BlendFunc(Gl.ZERO, Gl.SRC_COLOR);
                _shadowTransmitProgram.Use();
                Gl.UniformMatrix4(_transmitViewProj, matrix);
                Gl.UniformMatrix4(_transmitModel, Matrix4x4.Identity);
                Gl.Uniform1(_transmitGlass, Lighting.Glass);
                Gl.Uniform1(_transmitWhitecard, whitecard ? 1 : 0);
                DrawBatches(planes, groupVisible, transparent: true, countStats: false);
                if (dynamics != null && dynamics.Instances.Count > 0) { DrawDynamicInstances(dynamics, planes, transparent: true, _transmitModel); }
                Gl.Disable(Gl.BLEND);
                Gl.DepthFunc(Gl.LEQUAL);
                Gl.DepthMask(true);
            }

            _shadows.MarkRendered(cascade);
        }

        /// <summary>
        /// Sets the sun / shadow block of the scene or ground program for one draw.
        /// </summary>
        /// <param name="u">The program's locations.</param>
        /// <param name="sun">False for passes that keep the classic light (plan minimap).</param>
        /// <param name="transmit">False for the transparent pass (glass shouldn't tint itself).</param>
        private void ApplyLight(in LightUniforms u, bool sun, bool transmit)
        {
            SunLighting l = Lighting;
            bool on = sun && l.Enabled;
            Gl.Uniform1(u.Sun, on ? 1 : 0);
            if (!on) { return; }

            Gl.Uniform3(u.SunDir, l.SunDirection.X, l.SunDirection.Y, l.SunDirection.Z);
            Gl.Uniform3(u.SunColor, l.SunColour.X, l.SunColour.Y, l.SunColour.Z);
            Gl.Uniform3(u.SkyColor, l.SkyColour.X, l.SkyColour.Y, l.SkyColour.Z);
            Gl.Uniform1(u.ShadowStrength, l.ShadowStrength);
            Gl.Uniform1(u.ShadowsOn, _shadowsActive ? 1 : 0);
            if (!_shadowsActive) { return; }

            ShadowMaps.Preset preset = _shadows.Current;
            float[] far = _shadows.CascadeFar, offset = _shadows.NormalOffset;
            Matrix4x4[] matrices = _shadows.RenderedMatrices;
            Gl.Uniform1(u.TransmitOn, transmit && _shadows.HasTransmit ? 1 : 0);
            Gl.Uniform3(u.CamForward, _cameraForward.X, _cameraForward.Y, _cameraForward.Z);
            Gl.Uniform1(u.CascadeCount, preset.Cascades);
            Gl.Uniform4(u.CascadeFar, far[0], far[1], far[2], far[3]);
            Gl.Uniform4(u.NormalOffset, offset[0], offset[1], offset[2], offset[3]);
            Gl.Uniform1(u.ShadowTexel, _shadows.Texel);
            Gl.Uniform1(u.Pcf, preset.PcfRadius);
            Gl.Uniform1(u.ShadowFar, preset.Distance);
            Gl.UniformMatrix4(u.ShadowMat0, matrices[0]);
            Gl.UniformMatrix4(u.ShadowMat1, matrices[1]);
            Gl.UniformMatrix4(u.ShadowMat2, matrices[2]);
            Gl.UniformMatrix4(u.ShadowMat3, matrices[3]);
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
            SunLighting l = Lighting;
            Gl.Uniform1(_skySun, l.Enabled ? 1 : 0);
            Gl.Uniform3(_skySunDir, l.SunDirection.X, l.SunDirection.Y, l.SunDirection.Z);
            Gl.Uniform3(_skyZenith, l.Zenith.X, l.Zenith.Y, l.Zenith.Z);
            Gl.Uniform3(_skyHorizon, l.Horizon.X, l.Horizon.Y, l.Horizon.Z);
            Gl.Uniform3(_skyDisc, l.SunDisc.X, l.SunDisc.Y, l.SunDisc.Z);
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
            Vector3 fog = FogColour;
            Gl.Uniform3(_groundFog, fog.X, fog.Y, fog.Z);
            ApplyLight(_groundLight, sun: true, transmit: true);
            Gl.BindVertexArray(_emptyVao);
            Gl.DrawArrays(Gl.TRIANGLES, 0, 6);
        }

        /// <summary>
        /// Draws all visible batches of one pass with frustum-culled chunks (one multi-draw per batch).
        /// </summary>
        /// <param name="p">Draw parameters.</param>
        /// <param name="groupVisible">Per visibility group (category × model, <see cref="SceneBatches.GroupOf"/>).</param>
        /// <param name="transparent">Which pass.</param>
        public void DrawStatic(in SceneDrawParams p, bool[] groupVisible, bool transparent)
        {
            if (!transparent) { ChunksDrawn = 0; }

            _sceneProgram.Use();
            ApplyUniforms(_sceneUniforms, p, Vector4.Zero, transmit: !transparent);
            DrawBatches(p.Planes, groupVisible, transparent, countStats: true);
        }

        /// <summary>
        /// Multi-draws the visible chunks of every batch of one pass with the current program.
        /// </summary>
        private void DrawBatches(Vector4[] planes, bool[] groupVisible, bool transparent, bool countStats)
        {
            Gl.BindVertexArray(_vao);

            RenderBatch[] batches = _batches.Batches;
            RenderChunk[] chunks = _batches.Chunks;

            fixed (int* counts = _drawCounts)
            fixed (nint* offsets = _drawOffsets)
            {
                for (int b = 0; b < batches.Length; b++)
                {
                    RenderBatch batch = batches[b];
                    if (batch.Transparent != transparent || !groupVisible[batch.Group]) { continue; }

                    int drawCount = 0;
                    int end = batch.ChunkStart + batch.ChunkCount;
                    for (int c = batch.ChunkStart; c < end; c++)
                    {
                        if (!FpsCamera.IsVisible(planes, chunks[c].Bounds)) { continue; }
                        counts[drawCount] = chunks[c].IndexCount;
                        offsets[drawCount] = (nint)chunks[c].IndexStart * sizeof(uint);
                        drawCount++;
                    }

                    if (drawCount > 0)
                    {
                        Gl.MultiDrawElements(Gl.TRIANGLES, counts, Gl.UNSIGNED_INT, (void**)offsets, drawCount);
                        if (countStats) { ChunksDrawn += drawCount; }
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
            ApplyUniforms(_sceneUniforms, p, colour, transmit: true);
            Gl.BindVertexArray(_vao);
            if (range.OpaqueCount > 0) { Gl.DrawElements(Gl.TRIANGLES, range.OpaqueCount, Gl.UNSIGNED_INT, (nint)range.OpaqueStart * sizeof(uint)); }
            if (range.TransparentCount > 0) { Gl.DrawElements(Gl.TRIANGLES, range.TransparentCount, Gl.UNSIGNED_INT, (nint)range.TransparentStart * sizeof(uint)); }
            Gl.BindVertexArray(0);
        }

        private void ApplyUniforms(in SceneUniforms u, in SceneDrawParams p, Vector4 overrideColour, bool transmit)
        {
            Gl.UniformMatrix4(u.ViewProj, p.ViewProjection);
            Gl.UniformMatrix4(u.Model, Matrix4x4.Identity);
            Gl.Uniform3(u.Eye, p.Eye.X, p.Eye.Y, p.Eye.Z);
            Gl.Uniform3(u.LightDir, LIGHT_DIR.X, LIGHT_DIR.Y, LIGHT_DIR.Z);
            Vector3 fog = p.Sun ? FogColour : FOG_COLOUR;
            Gl.Uniform3(u.FogColor, fog.X, fog.Y, fog.Z);
            ApplyLight(_sceneLight, p.Sun, transmit);
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
            _shadowDepthProgram?.Dispose();
            _shadowTransmitProgram?.Dispose();
            _shadows.Dispose();
            Gl.DeleteBuffer(_vbo);
            Gl.DeleteBuffer(_ibo);
            Gl.DeleteBuffer(_dynamicIbo);
            Gl.DeleteVertexArray(_vao);
            Gl.DeleteVertexArray(_dynamicVao);
            Gl.DeleteVertexArray(_emptyVao);
        }
    }
}
