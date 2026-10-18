using BimGo.Native;
using BimGo.Physics;
using BimGo.Scene;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// Colour round A: colour profiles. Each vertex carries its element's index (attribute 6, made the first time a
    /// profile shows); one RGBA8 texel per element (<see cref="Shaders.PROFILE_WIDTH"/> a row, unit
    /// <see cref="PROFILE_UNIT"/>) holds the element's colour and code, fetched in the vertex shader. A new profile, or
    /// a change to one, rewrites that small texture only: no geometry is touched, so thousands of elements recolour at
    /// once. Ghosted elements are left out of the normal passes and drawn by <see cref="DrawProfileGhosts"/>.
    /// </summary>
    internal sealed unsafe partial class SceneRenderer
    {
        #region Fields

        /// <summary>Texture unit of the profile texture (free: shadows 1–2, AO / glow 3–4, light shadows 5, materials 6–10, probes 11–13, grass 14).</summary>
        public const int PROFILE_UNIT = 15;

        /// <summary>Opacity of ghosted elements (as the clash view's ghost).</summary>
        private const float PROFILE_GHOST_ALPHA = 0.12f;

        private uint _elementVbo, _profileTexture;
        private bool _profileReady, _profileGhosts, _profileGhostPass;
        private float _profileDetail = AppearanceProfiler.DEFAULT_DETAIL;
        private bool _profileFailed;

        /// <summary>
        /// Shows the uploaded profile in the scene passes (the session sets it each frame: the profile is on, and the
        /// view is one that shows it). Reflection probe captures always draw without it.
        /// </summary>
        public bool ProfileOn { get; set; }

        /// <summary>True once a profile has been uploaded (<see cref="SetProfile"/>).</summary>
        public bool HasProfile => _profileReady;

        /// <summary>True when the shown profile ghosts some elements (draw <see cref="DrawProfileGhosts"/> after the opaque passes).</summary>
        public bool ProfileGhostsWanted => ProfileOn && _profileReady && _profileGhosts && GhostAlpha <= 0f;

        #endregion

        #region Upload

        /// <summary>
        /// Uploads a profile's per-element codes (<see cref="ProfileResult.Codes"/>). The element stream is made the
        /// first time. GL thread.
        /// </summary>
        /// <param name="codes">One packed RGBA8 per element (scene order).</param>
        /// <param name="detail">How much of the surface's own shade shows through (0–1).</param>
        /// <param name="anyGhost">Some elements are ghosted or (round B) see-through: the blended pass is drawn.</param>
        /// <returns>Null, or why the profile can't be shown (graphics memory).</returns>
        public string SetProfile(uint[] codes, float detail, bool anyGhost)
        {
            if (_scene == null || codes == null) { return null; }
            if (_profileFailed) { return "Colour profiles couldn't be set up on this graphics card (see the log)."; }
            if (!EnsureElementStream()) { return "Not enough graphics memory for colour profiles."; }

            int width = Shaders.PROFILE_WIDTH;
            int rows = Math.Max(1, (codes.Length + width - 1) / width);
            var texels = new uint[width * rows];
            Array.Copy(codes, texels, Math.Min(codes.Length, texels.Length));

            if (_profileTexture == 0)
            {
                _profileTexture = Gl.GenTexture();
                Gl.ActiveTexture(Gl.TEXTURE0 + PROFILE_UNIT);
                Gl.BindTexture(Gl.TEXTURE_2D, _profileTexture);
                Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)Gl.NEAREST);
                Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)Gl.NEAREST);
                Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
                Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
                Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAX_LEVEL, 0);
            }
            Gl.ActiveTexture(Gl.TEXTURE0 + PROFILE_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D, _profileTexture);
            Gl.PixelStore(Gl.UNPACK_ALIGNMENT, 4);
            fixed (uint* data = texels)
            {
                // R in the low byte (little-endian), as SceneVertex colours
                Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA8, width, rows, Gl.RGBA, Gl.UNSIGNED_BYTE, data);
            }
            Gl.ActiveTexture(Gl.TEXTURE0);

            uint error = Gl.GetError();
            if (error == Gl.OUT_OF_MEMORY)
            {
                Utilities.Log_Utils.Write("Colour profile: out of graphics memory for the profile texture.");
                _profileReady = false;
                return "Not enough graphics memory for colour profiles.";
            }

            _profileDetail = Math.Clamp(detail, 0f, 1f);
            _profileGhosts = anyGhost;
            _profileReady = true;
            return null;
        }

        /// <summary>How much of the surface's own shade shows under the colour (0–1); a uniform, nothing re-uploaded.</summary>
        public void SetProfileDetail(float detail) => _profileDetail = Math.Clamp(float.IsFinite(detail) ? detail : AppearanceProfiler.DEFAULT_DETAIL, 0f, 1f);

        /// <summary>Forgets the uploaded profile (nothing is coloured until the next <see cref="SetProfile"/>).</summary>
        public void ClearProfile()
        {
            _profileReady = false;
            _profileGhosts = false;
        }

        /// <summary>
        /// The per-vertex element index (attribute 6) on both VAOs, made once: every vertex an element's triangles use
        /// takes its index (vertices no element uses read 0, and are never drawn).
        /// </summary>
        private bool EnsureElementStream()
        {
            if (_elementVbo != 0) { return true; }
            try
            {
                var perVertex = new float[_scene.Vertices.Length];
                uint[] indices = _scene.Indices;
                ElementRecord[] elements = _scene.Elements;
                for (int e = 0; e < elements.Length; e++)
                {
                    ElementRecord record = elements[e];
                    Fill(record.OpaqueStart, record.OpaqueCount, e);
                    Fill(record.TransparentStart, record.TransparentCount, e);
                }

                _elementVbo = Gl.GenBuffer();
                Gl.BindBuffer(Gl.ARRAY_BUFFER, _elementVbo);
                fixed (float* data = perVertex)
                {
                    Gl.BufferData(Gl.ARRAY_BUFFER, (nint)perVertex.Length * sizeof(float), data, Gl.STATIC_DRAW);
                }
                foreach (uint vao in new[] { _vao, _dynamicVao })
                {
                    Gl.BindVertexArray(vao);
                    Gl.BindBuffer(Gl.ARRAY_BUFFER, _elementVbo);
                    Gl.EnableVertexAttribArray(6);
                    Gl.VertexAttribPointer(6, 1, Gl.FLOAT, false, sizeof(float), 0);
                }
                Gl.BindVertexArray(0);
                Gl.BindBuffer(Gl.ARRAY_BUFFER, 0);

                if (Gl.GetError() == Gl.OUT_OF_MEMORY)
                {
                    Utilities.Log_Utils.Write("Colour profile: out of graphics memory for the element stream.");
                    return false;
                }
                Utilities.Log_Utils.Write($"Colour profile: element stream for {perVertex.Length:N0} vertices ({perVertex.Length * 4L / 1024:N0} KB).");
                return true;

                void Fill(int start, int count, int element)
                {
                    if (count <= 0 || start < 0) { return; }
                    int end = Math.Min(indices.Length, start + count);
                    for (int i = start; i < end; i++)
                    {
                        uint v = indices[i];
                        if (v < (uint)perVertex.Length) { perVertex[v] = element; }
                    }
                }
            }
            catch (Exception ex)
            {
                _profileFailed = true;
                Utilities.Log_Utils.Write($"Colour profile: element stream failed: {ex}");
                return false;
            }
        }

        /// <summary>
        /// Binds the profile texture when the profile shows (and <paramref name="allowed"/>). Called while applying a
        /// pass's uniforms.
        /// </summary>
        /// <returns>True when the pass should use the profile.</returns>
        private bool BindProfile(bool allowed)
        {
            if (!allowed || !ProfileOn || !_profileReady || _profileTexture == 0) { return false; }
            Gl.ActiveTexture(Gl.TEXTURE0 + PROFILE_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D, _profileTexture);
            Gl.ActiveTexture(Gl.TEXTURE0);
            return true;
        }

        #endregion

        #region Drawing

        /// <summary>
        /// The ghost pass: the ghosted elements' opaque and glass triangles (and moved ones') as faint grey glass, after
        /// the opaque passes. The caller sets blending on and depth writes off (as for the glass pass).
        /// </summary>
        public void DrawProfileGhosts(in SceneDrawParams p, bool[] groupVisible, DynamicSet dynamics)
        {
            if (!ProfileGhostsWanted) { return; }
            _profileGhostPass = true;
            try
            {
                _sceneProgram.Use();
                ApplyUniforms(_sceneUniforms, p, System.Numerics.Vector4.Zero, transmit: false);
                DrawBatches(p.Planes, groupVisible, transparent: false, countStats: false);
                DrawBatches(p.Planes, groupVisible, transparent: true, countStats: false);
                if (dynamics != null && dynamics.Instances.Count > 0)
                {
                    FlushDynamic();
                    DrawDynamicInstances(dynamics, p.Planes, transparent: false, _sceneUniforms.Model);
                    DrawDynamicInstances(dynamics, p.Planes, transparent: true, _sceneUniforms.Model);
                }
            }
            finally
            {
                _profileGhostPass = false;
            }
        }

        #endregion

        /// <summary>Releases the profile's GL resources.</summary>
        private void DisposeProfile()
        {
            Gl.DeleteBuffer(_elementVbo);
            Gl.DeleteTexture(_profileTexture);
            _elementVbo = _profileTexture = 0;
            _profileReady = false;
        }
    }
}
