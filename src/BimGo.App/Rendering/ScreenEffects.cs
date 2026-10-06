using System.Numerics;
using BimGo.Native;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// The half-resolution geometry pre-pass and the two screen-space effects fed by it:
    /// <list type="bullet">
    /// <item><b>Ambient occlusion.</b> The pre-pass writes view-space normal + view depth (RGBA32F); <see cref="Compute"/>
    /// runs the AO pass and a two-pass depth-aware blur, leaving (AO, depth) bound on <see cref="AO_UNIT"/>; the
    /// scene and ground shaders upsample it and darken their ambient (sky) term only.</item>
    /// <item><b>Glow (bloom).</b> The same pre-pass writes each surface's emissive colour to a second target (RGBA16F),
    /// already hidden behind whatever is in front of it. <see cref="Compute"/> takes it to quarter resolution and
    /// blurs it; <see cref="CompositeGlow"/> adds it over the finished scene.</item>
    /// </list>
    /// The pre-pass is separate from the (possibly multisampled) scene target, so MSAA and these effects never
    /// interact; glass is not in the pre-pass (it neither occludes nor glows).
    ///
    /// GL resources are created on first use; until then (and when both effects are off) a 1×1 placeholder keeps the
    /// shaders' AO sampler valid. Never throws: failures set <see cref="LastError"/> and the caller switches off.
    /// </summary>
    internal sealed unsafe class ScreenEffects : IDisposable
    {
        #region Constants

        /// <summary>Texture unit the scene and ground shaders read the AO from (0 = UI atlas, 1–2 = shadow maps).</summary>
        public const int AO_UNIT = 3;

        /// <summary>Texture unit the bloom passes read from (kept off the AO unit, which the scene pass still needs).</summary>
        public const int GLOW_UNIT = 4;

        /// <summary>World-space sampling radius (m): corners, skirting, furniture against walls.</summary>
        public const float RADIUS = 0.6f;

        /// <summary>Strength (each tap adds 0..1). 3.5 takes a 90° inside corner to about 0.6 (tuned on a test room).</summary>
        public const float INTENSITY = 3.5f;

        /// <summary>View depth (m) beyond which AO fades out (it starts fading at 60%).</summary>
        public const float MAX_DEPTH = 120f;

        #endregion

        #region Fields

        private ShaderProgram _aoProgram, _blurProgram, _glowDownProgram, _glowBlurProgram, _glowCompositeProgram;
        private int _aoGeometry, _aoTan, _aoProjScale, _aoRadius, _aoIntensity, _aoMaxDepth;
        private int _blurInput, _blurDir;
        private int _glowDownTexel, _glowBlurStep, _glowStrength;

        private uint _geometryFbo, _geometryTexture, _geometryDepth, _glowTexture;
        private uint _fboA, _textureA, _fboB, _textureB;
        private uint _glowFboA, _glowTextureA, _glowFboB, _glowTextureB;
        private uint _placeholder, _emptyVao;
        private bool _aoComputed;

        #endregion

        #region State

        /// <summary>True once the targets are allocated and complete.</summary>
        public bool Ready { get; private set; }

        /// <summary>The last failure (allocation, incomplete framebuffer), or null.</summary>
        public string LastError { get; private set; }

        /// <summary>Half-resolution width in pixels.</summary>
        public int Width { get; private set; }

        /// <summary>Half-resolution height in pixels.</summary>
        public int Height { get; private set; }

        /// <summary>Quarter-resolution (bloom) width in pixels.</summary>
        public int GlowWidth { get; private set; }

        /// <summary>Quarter-resolution (bloom) height in pixels.</summary>
        public int GlowHeight { get; private set; }

        /// <summary>Full-resolution size the targets were made for (the scene target's).</summary>
        public int FullWidth { get; private set; }

        /// <summary>Full-resolution height the targets were made for.</summary>
        public int FullHeight { get; private set; }

        #endregion

        #region Setup

        /// <summary>
        /// Compiles the programs and creates the 1×1 placeholder (GL context current).
        /// </summary>
        public void Initialise()
        {
            _aoProgram = ShaderProgram.Create("ambient occlusion", Shaders.FULLSCREEN_VS, Shaders.AO_FS);
            _aoGeometry = _aoProgram.Uniform("uGeometry");
            _aoTan = _aoProgram.Uniform("uTan");
            _aoProjScale = _aoProgram.Uniform("uProjScale");
            _aoRadius = _aoProgram.Uniform("uRadius");
            _aoIntensity = _aoProgram.Uniform("uIntensity");
            _aoMaxDepth = _aoProgram.Uniform("uMaxDepth");

            _blurProgram = ShaderProgram.Create("ambient occlusion blur", Shaders.FULLSCREEN_VS, Shaders.AO_BLUR_FS);
            _blurInput = _blurProgram.Uniform("uAoInput");
            _blurDir = _blurProgram.Uniform("uDir");

            _glowDownProgram = ShaderProgram.Create("glow downsample", Shaders.FULLSCREEN_VS, Shaders.GLOW_DOWN_FS);
            _glowDownTexel = _glowDownProgram.Uniform("uTexel");
            _glowBlurProgram = ShaderProgram.Create("glow blur", Shaders.FULLSCREEN_VS, Shaders.GLOW_BLUR_FS);
            _glowBlurStep = _glowBlurProgram.Uniform("uStep");
            _glowCompositeProgram = ShaderProgram.Create("glow composite", Shaders.FULLSCREEN_VS, Shaders.GLOW_COMPOSITE_FS);
            _glowStrength = _glowCompositeProgram.Uniform("uStrength");

            // The AO programs read the AO unit; the glow programs the glow unit (never unit 0: the UI atlas lives there)
            _aoProgram.Use();
            Gl.Uniform1(_aoGeometry, AO_UNIT);
            _blurProgram.Use();
            Gl.Uniform1(_blurInput, AO_UNIT);
            foreach (ShaderProgram glow in new[] { _glowDownProgram, _glowBlurProgram, _glowCompositeProgram })
            {
                glow.Use();
                Gl.Uniform1(glow.Uniform("uGlowInput"), GLOW_UNIT);
            }
            Gl.UseProgram(0);

            // Placeholder: AO = 1 (the shaders don't read it while AO is off, but the sampler must be complete)
            _placeholder = Gl.GenTexture();
            Gl.BindTexture(Gl.TEXTURE_2D, _placeholder);
            uint white = 0xFFFFFFFFu;
            Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA8, 1, 1, Gl.RGBA, Gl.UNSIGNED_BYTE, &white);
            SetFilter(Gl.NEAREST);
            Gl.BindTexture(Gl.TEXTURE_2D, 0);

            _emptyVao = Gl.GenVertexArray();
            Bind();
        }

        /// <summary>
        /// Allocates the targets for a full-resolution size if they aren't already.
        /// </summary>
        /// <param name="fullWidth">Scene target width in pixels.</param>
        /// <param name="fullHeight">Scene target height in pixels.</param>
        /// <returns>False if the GPU refused (the effects should be switched off; see <see cref="LastError"/>).</returns>
        public bool Ensure(int fullWidth, int fullHeight)
        {
            fullWidth = Math.Max(fullWidth, 1);
            fullHeight = Math.Max(fullHeight, 1);
            if (Ready && fullWidth == FullWidth && fullHeight == FullHeight) { return true; }

            LastError = null;
            if (!Allocate(fullWidth, fullHeight))
            {
                FreeTargets();
                Ready = false;
                return false;
            }
            Ready = true;
            _aoComputed = false;
            Utilities.Log_Utils.Write($"Screen effects: {Width} × {Height} px pre-pass, {GlowWidth} × {GlowHeight} px bloom (of {fullWidth} × {fullHeight}).");
            return true;
        }

        /// <summary>
        /// Frees the targets (both effects switched off), keeping the programs and the placeholder.
        /// </summary>
        public void Release()
        {
            if (!Ready) { return; }
            FreeTargets();
            Ready = false;
            _aoComputed = false;
            Bind();
        }

        /// <summary>
        /// (Re)creates the geometry + glow target, the two AO ping-pong targets and the two bloom targets.
        /// </summary>
        private bool Allocate(int fullWidth, int fullHeight)
        {
            while (Gl.GetError() != Gl.NO_ERROR) { /* clear stale errors */ }
            FreeTargets();

            FullWidth = fullWidth;
            FullHeight = fullHeight;
            Width = (fullWidth + 1) / 2;
            Height = (fullHeight + 1) / 2;
            GlowWidth = (Width + 1) / 2;
            GlowHeight = (Height + 1) / 2;

            // Geometry: view normal + view depth (32-bit: depth must stay precise far from the eye), and glow
            _geometryTexture = CreateTexture(Width, Height, Gl.RGBA32F, Gl.RGBA, Gl.FLOAT, Gl.NEAREST);
            _glowTexture = CreateTexture(Width, Height, Gl.RGBA16F, Gl.RGBA, Gl.HALF_FLOAT, Gl.LINEAR);
            _geometryDepth = Gl.GenRenderbuffer();
            Gl.BindRenderbuffer(Gl.RENDERBUFFER, _geometryDepth);
            Gl.RenderbufferStorageMultisample(Gl.RENDERBUFFER, 0, Gl.DEPTH_COMPONENT24, Width, Height);
            Gl.BindRenderbuffer(Gl.RENDERBUFFER, 0);
            _geometryFbo = Gl.GenFramebuffer();
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, _geometryFbo);
            Gl.FramebufferTexture2D(Gl.FRAMEBUFFER, Gl.COLOR_ATTACHMENT0, Gl.TEXTURE_2D, _geometryTexture, 0);
            Gl.FramebufferTexture2D(Gl.FRAMEBUFFER, Gl.COLOR_ATTACHMENT1, Gl.TEXTURE_2D, _glowTexture, 0);
            Gl.FramebufferRenderbuffer(Gl.FRAMEBUFFER, Gl.DEPTH_ATTACHMENT, Gl.RENDERBUFFER, _geometryDepth);
            SetDrawBuffers(glow: true);
            bool complete = Gl.CheckFramebufferStatus(Gl.FRAMEBUFFER) == Gl.FRAMEBUFFER_COMPLETE;

            // AO ping-pong: (AO, view depth)
            _textureA = CreateTexture(Width, Height, Gl.RG16F, Gl.RG, Gl.HALF_FLOAT, Gl.NEAREST);
            _fboA = CreateColourTarget(_textureA, ref complete);
            _textureB = CreateTexture(Width, Height, Gl.RG16F, Gl.RG, Gl.HALF_FLOAT, Gl.NEAREST);
            _fboB = CreateColourTarget(_textureB, ref complete);

            // Bloom ping-pong at quarter resolution (linear filtering: the blur and upsample read between texels)
            _glowTextureA = CreateTexture(GlowWidth, GlowHeight, Gl.RGBA16F, Gl.RGBA, Gl.HALF_FLOAT, Gl.LINEAR);
            _glowFboA = CreateColourTarget(_glowTextureA, ref complete);
            _glowTextureB = CreateTexture(GlowWidth, GlowHeight, Gl.RGBA16F, Gl.RGBA, Gl.HALF_FLOAT, Gl.LINEAR);
            _glowFboB = CreateColourTarget(_glowTextureB, ref complete);
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);

            uint error = Gl.GetError();
            if (error != Gl.NO_ERROR)
            {
                LastError = error == Gl.OUT_OF_MEMORY
                    ? "Not enough graphics memory for ambient occlusion and glow: they have been switched off"
                    : $"Ambient occlusion and glow could not be set up (GL error 0x{error:X}): they have been switched off";
                Utilities.Log_Utils.Write(LastError);
                return false;
            }
            if (!complete)
            {
                LastError = "Ambient occlusion and glow are not supported on this graphics driver: they have been switched off";
                Utilities.Log_Utils.Write(LastError + " (incomplete framebuffer)");
                return false;
            }
            return true;
        }

        /// <summary>
        /// A 2D texture (NEAREST for texelFetch targets, LINEAR for the bloom).
        /// </summary>
        private static uint CreateTexture(int width, int height, uint internalFormat, uint format, uint type, uint filter)
        {
            uint texture = Gl.GenTexture();
            Gl.BindTexture(Gl.TEXTURE_2D, texture);
            Gl.TexImage2D(Gl.TEXTURE_2D, 0, internalFormat, width, height, format, type, null);
            SetFilter(filter);
            Gl.BindTexture(Gl.TEXTURE_2D, 0);
            return texture;
        }

        /// <summary>
        /// A framebuffer with one colour texture and no depth.
        /// </summary>
        private static uint CreateColourTarget(uint texture, ref bool complete)
        {
            uint fbo = Gl.GenFramebuffer();
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, fbo);
            Gl.FramebufferTexture2D(Gl.FRAMEBUFFER, Gl.COLOR_ATTACHMENT0, Gl.TEXTURE_2D, texture, 0);
            complete &= Gl.CheckFramebufferStatus(Gl.FRAMEBUFFER) == Gl.FRAMEBUFFER_COMPLETE;
            return fbo;
        }

        private static void SetFilter(uint filter)
        {
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)filter);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)filter);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
        }

        /// <summary>
        /// Geometry only, or geometry + glow, for the bound geometry framebuffer.
        /// </summary>
        private static void SetDrawBuffers(bool glow)
        {
            uint* buffers = stackalloc uint[2] { Gl.COLOR_ATTACHMENT0, Gl.COLOR_ATTACHMENT1 };
            Gl.DrawBuffers(glow ? 2 : 1, buffers);
        }

        private void FreeTargets()
        {
            foreach (uint fbo in new[] { _geometryFbo, _fboA, _fboB, _glowFboA, _glowFboB }) { Gl.DeleteFramebuffer(fbo); }
            foreach (uint texture in new[] { _geometryTexture, _glowTexture, _textureA, _textureB, _glowTextureA, _glowTextureB }) { Gl.DeleteTexture(texture); }
            Gl.DeleteRenderbuffer(_geometryDepth);
            _geometryFbo = _fboA = _fboB = _glowFboA = _glowFboB = 0;
            _geometryTexture = _glowTexture = _textureA = _textureB = _glowTextureA = _glowTextureB = _geometryDepth = 0;
        }

        #endregion

        #region Frame

        /// <summary>
        /// Binds and clears the pre-pass target (0 = sky, no glow) and sets the depth state for its draws.
        /// </summary>
        /// <param name="glow">True to write the glow target too.</param>
        public void BeginGeometry(bool glow)
        {
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, _geometryFbo);
            SetDrawBuffers(glow);
            Gl.Viewport(0, 0, Width, Height);
            Gl.ColorMask(true, true, true, true);
            Gl.DepthMask(true);
            Gl.ClearColor(0f, 0f, 0f, 0f);
            Gl.ClearDepth(1.0);
            Gl.Clear(Gl.COLOR_BUFFER_BIT | Gl.DEPTH_BUFFER_BIT);
            Gl.Enable(Gl.DEPTH_TEST);
            Gl.DepthFunc(Gl.LEQUAL);
            Gl.Disable(Gl.BLEND);
            Gl.Disable(Gl.CULL_FACE);
        }

        /// <summary>
        /// Runs the effects over the pre-pass: AO and its blur (result bound to <see cref="AO_UNIT"/>), and / or the
        /// bloom downsample and blur. Restores the default framebuffer (the caller binds the scene target next).
        /// </summary>
        /// <param name="camera">The player camera (this frame's FOV and aspect).</param>
        /// <param name="ao">Run ambient occlusion.</param>
        /// <param name="glow">Run the bloom.</param>
        public void Compute(FpsCamera camera, bool ao, bool glow)
        {
            Gl.Disable(Gl.DEPTH_TEST);
            Gl.DepthMask(false);
            Gl.Disable(Gl.BLEND);
            Gl.BindVertexArray(_emptyVao);

            if (ao)
            {
                Gl.Viewport(0, 0, Width, Height);
                Gl.ActiveTexture(Gl.TEXTURE0 + AO_UNIT);

                // AO: geometry → A
                float tanY = MathF.Tan(camera.FovY * 0.5f);
                Gl.BindFramebuffer(Gl.FRAMEBUFFER, _fboA);
                Gl.BindTexture(Gl.TEXTURE_2D, _geometryTexture);
                _aoProgram.Use();
                Gl.Uniform2(_aoTan, tanY * camera.Aspect, tanY);
                Gl.Uniform1(_aoProjScale, 0.5f * Height / MathF.Max(tanY, 1e-4f));
                Gl.Uniform1(_aoRadius, RADIUS);
                Gl.Uniform1(_aoIntensity, INTENSITY);
                Gl.Uniform1(_aoMaxDepth, MAX_DEPTH);
                Gl.DrawArrays(Gl.TRIANGLES, 0, 3);

                // Blur: A → B (horizontal), B → A (vertical)
                _blurProgram.Use();
                Gl.BindFramebuffer(Gl.FRAMEBUFFER, _fboB);
                Gl.BindTexture(Gl.TEXTURE_2D, _textureA);
                Gl.Uniform2(_blurDir, 1f, 0f);
                Gl.DrawArrays(Gl.TRIANGLES, 0, 3);

                Gl.BindFramebuffer(Gl.FRAMEBUFFER, _fboA);
                Gl.BindTexture(Gl.TEXTURE_2D, _textureB);
                Gl.Uniform2(_blurDir, 0f, 1f);
                Gl.DrawArrays(Gl.TRIANGLES, 0, 3);

                // Result on the AO unit for the scene pass
                Gl.BindTexture(Gl.TEXTURE_2D, _textureA);
            }
            _aoComputed = ao;

            if (glow)
            {
                Gl.Viewport(0, 0, GlowWidth, GlowHeight);
                Gl.ActiveTexture(Gl.TEXTURE0 + GLOW_UNIT);

                // Half-res glow → quarter (A)
                Gl.BindFramebuffer(Gl.FRAMEBUFFER, _glowFboA);
                Gl.BindTexture(Gl.TEXTURE_2D, _glowTexture);
                _glowDownProgram.Use();
                Gl.Uniform2(_glowDownTexel, 1f / Width, 1f / Height);
                Gl.DrawArrays(Gl.TRIANGLES, 0, 3);

                // Blur: A → B (horizontal), B → A (vertical)
                _glowBlurProgram.Use();
                Gl.BindFramebuffer(Gl.FRAMEBUFFER, _glowFboB);
                Gl.BindTexture(Gl.TEXTURE_2D, _glowTextureA);
                Gl.Uniform2(_glowBlurStep, 1f / GlowWidth, 0f);
                Gl.DrawArrays(Gl.TRIANGLES, 0, 3);

                Gl.BindFramebuffer(Gl.FRAMEBUFFER, _glowFboA);
                Gl.BindTexture(Gl.TEXTURE_2D, _glowTextureB);
                Gl.Uniform2(_glowBlurStep, 0f, 1f / GlowHeight);
                Gl.DrawArrays(Gl.TRIANGLES, 0, 3);
                Gl.BindTexture(Gl.TEXTURE_2D, _glowTextureA);
            }

            Gl.ActiveTexture(Gl.TEXTURE0);
            Gl.BindVertexArray(0);
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);
            Gl.DepthMask(true);
            Gl.Enable(Gl.DEPTH_TEST);
        }

        /// <summary>
        /// Adds the blurred glow over the bound target (the scene target, full viewport set by the caller).
        /// Leaves depth test on and blending off.
        /// </summary>
        /// <param name="strength">Bloom strength (0 = nothing drawn).</param>
        public void CompositeGlow(float strength)
        {
            if (!Ready || strength <= 0f) { return; }
            Gl.Disable(Gl.DEPTH_TEST);
            Gl.DepthMask(false);
            Gl.Enable(Gl.BLEND);
            Gl.BlendFunc(Gl.ONE, Gl.ONE);
            Gl.ActiveTexture(Gl.TEXTURE0 + GLOW_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D, _glowTextureA);
            Gl.ActiveTexture(Gl.TEXTURE0);
            _glowCompositeProgram.Use();
            Gl.Uniform1(_glowStrength, strength);
            Gl.BindVertexArray(_emptyVao);
            Gl.DrawArrays(Gl.TRIANGLES, 0, 3);
            Gl.BindVertexArray(0);
            Gl.Disable(Gl.BLEND);
            Gl.DepthMask(true);
            Gl.Enable(Gl.DEPTH_TEST);
        }

        /// <summary>
        /// Binds the AO result (or the placeholder when there is none) to <see cref="AO_UNIT"/>; leaves unit 0 active.
        /// </summary>
        public void Bind()
        {
            Gl.ActiveTexture(Gl.TEXTURE0 + AO_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D, Ready && _aoComputed ? _textureA : _placeholder);
            Gl.ActiveTexture(Gl.TEXTURE0);
        }

        /// <summary>
        /// Full-to-half pixel scale for the AO upsample (exact for odd sizes).
        /// </summary>
        public Vector2 Scale => new((float)Width / Math.Max(FullWidth, 1), (float)Height / Math.Max(FullHeight, 1));

        #endregion

        /// <summary>
        /// Releases GL resources.
        /// </summary>
        public void Dispose()
        {
            FreeTargets();
            Gl.DeleteTexture(_placeholder);
            Gl.DeleteVertexArray(_emptyVao);
            _placeholder = _emptyVao = 0;
            _aoProgram?.Dispose();
            _blurProgram?.Dispose();
            _glowDownProgram?.Dispose();
            _glowBlurProgram?.Dispose();
            _glowCompositeProgram?.Dispose();
            Ready = false;
        }
    }
}
