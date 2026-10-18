using System.Numerics;
using BimGo.Native;
using BimGo.Scene;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>How the grass blades look this frame (grass round, build B).</summary>
    internal struct GrassLook
    {
        /// <summary>0 low, 1 medium, 2 high.</summary>
        public int Density;

        /// <summary>Blade height (m, average).</summary>
        public float Height;

        /// <summary>How far blades reach (m).</summary>
        public float Distance;

        /// <summary>Water round W: how far blades sway (0–2, 1 = as before; 0 = still).</summary>
        public float Sway;
    }

    /// <summary>
    /// Grass round (build B): grass blades over the grass materials, in the Realistic mode. The grass field (a CPU
    /// raster of where grass grows, <see cref="GrassField"/>) becomes an RG32F texture; each frame two instanced draws
    /// (a dense near grid and a sparser far ring with wider blades) place blades from it in the vertex shader. Blades
    /// take the sun, its shadows and the artificial lights, but cast no shadows and stay out of AO, probes and
    /// pictures of other views (minimap, clash view).
    /// </summary>
    internal sealed unsafe partial class SceneRenderer
    {
        #region Fields

        /// <summary>Texture unit of the grass map (vertex shader).</summary>
        public const int GRASS_UNIT = 14;

        /// <summary>Near-grid blade spacing (m) per density, the near grid's radius (m) and the far ring's spacing factor.</summary>
        private static readonly float[] GRASS_SPACING = { 0.13f, 0.1f, 0.075f };
        private const float GRASS_NEAR = 12f, GRASS_FAR_SPACING = 2.4f;

        /// <summary>The band (m) over which the near grid fades out and the far ring fades in (no seam).</summary>
        private const float GRASS_BAND = 4f;

        /// <summary>Blades per clump (one instance): near, far.</summary>
        private const int GRASS_NEAR_BLADES = 3, GRASS_FAR_BLADES = 2;

        /// <summary>Blade width (m) near; the far ring's blades are this × <see cref="GRASS_FAR_WIDTH"/>.</summary>
        private const float GRASS_WIDTH = 0.02f, GRASS_FAR_WIDTH = 2.0f;

        private ShaderProgram _grassProgram;
        private bool _grassFailed;
        private LightUniforms _grassLight;
        private AoUniforms _grassAo;
        private ArtificialUniforms _grassLights;
        private int _gViewProj, _gEye, _gArea, _gSize, _gSpacing, _gSide, _gInner, _gFadeIn, _gFadeOut, _gRadius, _gHeight, _gWidth, _gSway, _gTime, _gFogColor, _gFogDensity, _gClipCount, _gClipPlanes;
        private readonly int[] _gPalette = new int[GrassField.MAX_PALETTE];

        private uint _grassMap;
        private Vector2 _grassMin;
        private float _grassCell;
        private int _grassWidth, _grassHeight;
        private Vector3[] _grassColours = Array.Empty<Vector3>();

        /// <summary>The blades' look (set by the session).</summary>
        public GrassLook Grass = new() { Density = 1, Height = 0.12f, Distance = 40f, Sway = 1f };

        /// <summary>True when a grass field is uploaded (there is grass to draw).</summary>
        public bool HasGrass => _grassMap != 0;

        /// <summary>Blades drawn last frame (instances that weren't collapsed are not counted: this is the budget).</summary>
        public int GrassInstances { get; private set; }

        #endregion

        #region Setup

        /// <summary>
        /// Uploads a grass field (null or empty frees it). Builds the program the first time.
        /// </summary>
        /// <returns>Null, or why grass can't be shown (logged; the caller switches the blades off).</returns>
        public string SetGrassField(GrassField field)
        {
            ReleaseGrassMap();
            if (field == null || field.IsEmpty) { return null; }
            if (!EnsureGrassProgram()) { return "Grass blades could not be set up on this graphics card (see the log)."; }

            int count = field.Width * field.Height;
            float[] data = new float[count * 2];
            for (int i = 0; i < count; i++)
            {
                data[i * 2] = field.Heights[i];
                data[i * 2 + 1] = field.Palette[i];
            }
            _grassMap = Gl.GenTexture();
            Gl.ActiveTexture(Gl.TEXTURE0 + GRASS_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D, _grassMap);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)Gl.NEAREST);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)Gl.NEAREST);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAX_LEVEL, 0);
            fixed (float* p = data)
            {
                Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.RG32F, field.Width, field.Height, Gl.RG, Gl.FLOAT, p);
            }
            Gl.ActiveTexture(Gl.TEXTURE0);
            if (Gl.GetError() == Gl.OUT_OF_MEMORY)
            {
                ReleaseGrassMap();
                return "Not enough graphics memory for the grass map: grass blades are off.";
            }

            _grassMin = field.Min;
            _grassCell = field.Cell;
            _grassWidth = field.Width;
            _grassHeight = field.Height;
            _grassColours = field.Colours;
            Utilities.Log_Utils.Write($"Grass: {field.GrassCells:N0} cells of {field.Cell:0.###} m ({field.Width} × {field.Height}), {field.GrassTriangles:N0} triangles, {field.Colours.Length} colours.");
            return null;
        }

        private bool EnsureGrassProgram()
        {
            if (_grassProgram != null) { return true; }
            if (_grassFailed) { return false; }
            try
            {
                _grassProgram = ShaderProgram.Create("grass", Shaders.GRASS_VS, Shaders.GRASS_FS);
            }
            catch (Exception ex)
            {
                _grassFailed = true;
                Utilities.Log_Utils.Write($"Grass shader failed: {ex.Message}");
                return false;
            }
            ShaderProgram p = _grassProgram;
            _grassLight = LightUniforms.From(p);
            _grassAo = AoUniforms.From(p);
            _grassLights = ArtificialUniforms.From(p);
            p.Use();
            Gl.Uniform1(p.Uniform("uGrassMap"), GRASS_UNIT);
            _gViewProj = p.Uniform("uViewProj");
            _gEye = p.Uniform("uEye");
            _gArea = p.Uniform("uGrassArea");
            _gSize = p.Uniform("uGrassSize");
            _gSpacing = p.Uniform("uSpacing");
            _gSide = p.Uniform("uSide");
            _gInner = p.Uniform("uInner");
            _gFadeIn = p.Uniform("uFadeIn");
            _gFadeOut = p.Uniform("uFadeOut");
            _gRadius = p.Uniform("uRadius");
            _gHeight = p.Uniform("uBladeHeight");
            _gWidth = p.Uniform("uBladeWidth");
            _gTime = p.Uniform("uTime");
            _gSway = p.Uniform("uSway");
            _gFogColor = p.Uniform("uFogColor");
            _gFogDensity = p.Uniform("uFogDensity");
            _gClipCount = p.Uniform("uClipCount");
            _gClipPlanes = p.Uniform("uClipPlanes");
            for (int i = 0; i < _gPalette.Length; i++) { _gPalette[i] = p.Uniform($"uGrassPalette[{i}]"); }
            return true;
        }

        private void ReleaseGrassMap()
        {
            if (_grassMap != 0) { Gl.DeleteTexture(_grassMap); }
            _grassMap = 0;
            GrassInstances = 0;
        }

        /// <summary>Frees the grass objects (renderer dispose).</summary>
        private void DisposeGrass()
        {
            ReleaseGrassMap();
            _grassProgram?.Dispose();
            _grassProgram = null;
        }

        #endregion

        #region Draw

        /// <summary>
        /// Polish round P-C: reflection probes capture the blades (set by the session while blades show).
        /// </summary>
        public bool ProbeGrass { get; set; }

        /// <summary>Probe faces draw blades this far at most (m), at the low density.</summary>
        private const float PROBE_GRASS_RADIUS = 20f;

        /// <summary>
        /// Draws the blades (call after the opaque scene and the ground, with depth test and writes on). Does nothing
        /// without a grass field.
        /// </summary>
        /// <param name="p">The pass.</param>
        /// <param name="probe">P-C: a reflection probe's face: sparser blades, nearer, one grid (no count kept).</param>
        public void DrawGrass(in SceneDrawParams p, bool probe = false)
        {
            if (!probe) { GrassInstances = 0; }
            if (_grassMap == 0 || _grassProgram == null) { return; }
            GrassLook look = Grass;
            float radius = Math.Clamp(look.Distance, 5f, 200f);
            float height = Math.Clamp(look.Height, 0.01f, 1f);
            float spacing = GRASS_SPACING[Math.Clamp(look.Density, 0, GRASS_SPACING.Length - 1)];
            if (probe)
            {
                radius = MathF.Min(radius, PROBE_GRASS_RADIUS);
                spacing = GRASS_SPACING[0] * GRASS_FAR_SPACING;
            }

            _grassProgram.Use();
            Gl.UniformMatrix4(_gViewProj, p.ViewProjection);
            Gl.Uniform3(_gEye, p.Eye.X, p.Eye.Y, p.Eye.Z);
            Gl.Uniform3(_gArea, _grassMin.X, _grassMin.Y, _grassCell);
            Gl.Uniform2(_gSize, _grassWidth, _grassHeight);
            Gl.Uniform1(_gHeight, height);
            Gl.Uniform1(_gTime, p.Time);
            Gl.Uniform1(_gSway, Math.Clamp(look.Sway, 0f, 2f));
            Vector3 fog = p.Sun ? FogColour : FOG_COLOUR;
            Gl.Uniform3(_gFogColor, fog.X, fog.Y, fog.Z);
            Gl.Uniform1(_gFogDensity, p.FogDensity);
            for (int i = 0; i < _gPalette.Length; i++)
            {
                Vector3 c = _grassColours.Length == 0 ? GrassField.DEFAULT_GREEN : _grassColours[Math.Min(i, _grassColours.Length - 1)];
                Gl.Uniform3(_gPalette[i], c.X, c.Y, c.Z);
            }
            ApplyLight(_grassLight, p.Sun, transmit: false);
            ApplyAo(_grassAo, on: false);
            ApplyArtificial(_grassLights, on: true);
            ApplyClip(_gClipCount, _gClipPlanes, p.Section);
            Gl.ActiveTexture(Gl.TEXTURE0 + GRASS_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D, _grassMap);
            Gl.ActiveTexture(Gl.TEXTURE0);
            Gl.BindVertexArray(_emptyVao);

            // Near: dense clumps of thin blades, fading out over the band past the near radius
            float near = MathF.Min(GRASS_NEAR, radius);
            if (probe)
            {
                int counted = GrassInstances;
                DrawGrassGrid(spacing, GRASS_WIDTH * GRASS_FAR_WIDTH, GRASS_FAR_BLADES, 0f, 0f, radius * 0.7f, radius);
                GrassInstances = counted; // the HUD's count is the main view's
            }
            else if (radius <= near + GRASS_BAND)
            {
                DrawGrassGrid(spacing, GRASS_WIDTH, GRASS_NEAR_BLADES, 0f, 0f, radius * 0.7f, radius);
            }
            else
            {
                DrawGrassGrid(spacing, GRASS_WIDTH, GRASS_NEAR_BLADES, 0f, 0f, near, near + GRASS_BAND);

                // Far ring: sparser, wider blades, fading in over the same band (they cross-fade: no seam)
                DrawGrassGrid(spacing * GRASS_FAR_SPACING, GRASS_WIDTH * GRASS_FAR_WIDTH, GRASS_FAR_BLADES, near, near + GRASS_BAND,
                    MathF.Max(near + GRASS_BAND, radius * 0.7f), radius);
            }
            Gl.BindVertexArray(0);
        }

        /// <summary>
        /// One grid of clumps: every cell of a square around the eye; the shader drops those outside the ring and
        /// scales blades by the fades (in: <paramref name="inner"/> → <paramref name="fadeIn"/>; out:
        /// <paramref name="fadeOut"/> → <paramref name="radius"/>).
        /// </summary>
        private void DrawGrassGrid(float spacing, float width, int blades, float inner, float fadeIn, float fadeOut, float radius)
        {
            int side = (int)MathF.Ceiling(radius * 2f / spacing) + 2;
            Gl.Uniform1(_gSpacing, spacing);
            Gl.Uniform1(_gSide, side);
            Gl.Uniform1(_gInner, inner);
            Gl.Uniform1(_gFadeIn, fadeIn);
            Gl.Uniform1(_gFadeOut, fadeOut);
            Gl.Uniform1(_gRadius, radius);
            Gl.Uniform1(_gWidth, width);
            int instances = side * side;
            Gl.DrawArraysInstanced(Gl.TRIANGLE_STRIP, 0, 9 * blades, instances);
            GrassInstances += instances * blades;
        }

        #endregion
    }
}
