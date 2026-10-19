using System.Numerics;
using BimGo.Native;
using BimGo.Scene;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>The weather this frame (Round W-B), set by the session.</summary>
    internal struct WeatherLook
    {
        /// <summary>0 = none, 1 = rain, 2 = snow.</summary>
        public int Kind;

        /// <summary>How hard it falls (0–1): how many drops or flakes.</summary>
        public float Intensity;

        /// <summary>How wet open surfaces look (0–1; 0 while it snows).</summary>
        public float Wet;

        /// <summary>How much snow lies on open surfaces (0–1; 0 while it rains).</summary>
        public float Snow;

        /// <summary>The wind (m/s, scene axes): the rain slants and the snow drifts with the clouds.</summary>
        public Vector2 Wind;

        /// <summary>The clock (seconds).</summary>
        public float Time;

        /// <summary>The ground plane's height (nothing falls below it).</summary>
        public float GroundZ;

        /// <summary>True when anything shows.</summary>
        public readonly bool Any => Kind != 0 && (Intensity > 0f || Wet > 0f || Snow > 0f);
    }

    /// <summary>
    /// Round W-B: rain and snow. The cover map (<see cref="CoverMap"/>: the highest surface over each cell of the site)
    /// becomes an R32F texture that the scene, ground and grass shaders read to find surfaces open to the sky (wet, or
    /// under snow) and that the falling drops and flakes stop at. The drops and flakes are one instanced draw in a box
    /// round the eye (see <see cref="Shaders.PRECIP_VS"/>), drawn after the glass, depth-tested and blended.
    /// </summary>
    internal sealed unsafe partial class SceneRenderer
    {
        #region Fields

        /// <summary>Texture unit of the cover map (every unit below is taken).</summary>
        public const int COVER_UNIT = 16;

        /// <summary>The box the drops fill round the eye (m) and how many fill it at full intensity (a floor at none).</summary>
        private static readonly Vector3 RAIN_BOX = new(36f, 36f, 20f), SNOW_BOX = new(30f, 30f, 16f);
        private const int RAIN_MIN = 5000, RAIN_MAX = 35000, SNOW_MIN = 3000, SNOW_MAX = 25000;

        /// <summary>Fall speeds (m/s), the streak's width and length (m), the flake's radius (m).</summary>
        private const float RAIN_SPEED = 9f, SNOW_SPEED = 1.1f, RAIN_WIDTH = 0.012f, RAIN_LENGTH = 0.8f, FLAKE_RADIUS = 0.022f;

        /// <summary>The clock wraps after this long (s): keeps the drops' positions precise (one unseen reshuffle).</summary>
        private const float PRECIP_PERIOD = 1000f;

        /// <summary>The weather this frame (set by the session).</summary>
        public WeatherLook Weather;

        private uint _coverMap;
        private Vector4 _coverArea;
        private Vector2 _coverSize;

        private ShaderProgram _precipProgram;
        private bool _precipFailed;
        private WeatherUniforms _precipWeather;
        private int _pViewProj, _pEye, _pBox, _pFall, _pTime, _pSnow, _pSize, _pRight, _pUp, _pColour, _pAlpha, _pGround;
        private WeatherUniforms _sceneWeather, _groundWeather, _grassWeather;
        private int _gSnowShrink;
        private int _skyLightning, _skyBolt; // Round W-C

        // Round W-C: lens drops: the program, a texture-backed copy of the frame they refract, its size
        private ShaderProgram _lensProgram;
        private bool _lensFailed;
        private int _lDrops, _lShapes, _lAspect;
        private uint _lensFbo, _lensTexture;
        private int _lensWidth, _lensHeight;

        /// <summary>Round W-C: most lens drops at once (keep in step with LENS_VS).</summary>
        public const int MAX_LENS_DROPS = 32;

        /// <summary>True when a cover map is uploaded.</summary>
        public bool HasCoverMap => _coverMap != 0;

        /// <summary>Drops or flakes drawn last frame.</summary>
        public int PrecipInstances { get; private set; }

        #endregion

        /// <summary>
        /// Uniform locations of the weather block (WEATHER_GLSL) in one program.
        /// </summary>
        private struct WeatherUniforms
        {
            public int CoverArea, CoverSize, Weather;

            public static WeatherUniforms From(ShaderProgram p)
            {
                // The sampler reads a fixed texture unit (set once)
                p.Use();
                Gl.Uniform1(p.Uniform("uCoverMap"), COVER_UNIT);
                return new WeatherUniforms
                {
                    CoverArea = p.Uniform("uCoverArea"),
                    CoverSize = p.Uniform("uCoverSize"),
                    Weather = p.Uniform("uWeather")
                };
            }
        }

        #region Setup

        /// <summary>Finds the weather blocks of the scene and ground programs (from <see cref="Initialise"/>).</summary>
        private void InitialiseWeather()
        {
            _sceneWeather = WeatherUniforms.From(_sceneProgram);
            _groundWeather = WeatherUniforms.From(_groundProgram);
            Gl.UseProgram(0);
        }

        /// <summary>
        /// Uploads a cover map (null or empty frees it: then everything counts as open to the sky).
        /// </summary>
        /// <returns>Null, or why it couldn't be uploaded (the weather then shows everywhere).</returns>
        public string SetCoverMap(CoverMap map)
        {
            ReleaseCoverMap();
            if (map == null || map.IsEmpty) { return null; }
            _coverMap = Gl.GenTexture();
            Gl.ActiveTexture(Gl.TEXTURE0 + COVER_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D, _coverMap);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)Gl.NEAREST);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)Gl.NEAREST);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAX_LEVEL, 0);
            fixed (float* p = map.Tops)
            {
                Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.R32F, map.Width, map.Height, Gl.RED, Gl.FLOAT, p);
            }
            Gl.ActiveTexture(Gl.TEXTURE0);
            if (Gl.GetError() == Gl.OUT_OF_MEMORY)
            {
                ReleaseCoverMap();
                return "Not enough graphics memory for the rain's cover map: rain and snow show indoors too.";
            }
            _coverArea = new Vector4(map.Min.X, map.Min.Y, map.Cell, 1f);
            _coverSize = new Vector2(map.Width, map.Height);
            Utilities.Log_Utils.Write($"Weather: cover map {map.Width} × {map.Height} cells of {map.Cell:0.##} m, {map.CoveredCells:N0} covered, {map.Triangles:N0} triangles.");
            return null;
        }

        private void ReleaseCoverMap()
        {
            if (_coverMap != 0) { Gl.DeleteTexture(_coverMap); }
            _coverMap = 0;
            _coverArea = Vector4.Zero;
        }

        private bool EnsurePrecipProgram()
        {
            if (_precipProgram != null) { return true; }
            if (_precipFailed) { return false; }
            try
            {
                _precipProgram = ShaderProgram.Create("rain and snow", Shaders.PRECIP_VS, Shaders.PRECIP_FS);
            }
            catch (Exception ex)
            {
                _precipFailed = true;
                Utilities.Log_Utils.Write($"Rain and snow shader failed: {ex.Message}");
                return false;
            }
            ShaderProgram p = _precipProgram;
            _precipWeather = WeatherUniforms.From(p);
            _pViewProj = p.Uniform("uViewProj");
            _pEye = p.Uniform("uEye");
            _pBox = p.Uniform("uBox");
            _pFall = p.Uniform("uFall");
            _pTime = p.Uniform("uTime");
            _pSnow = p.Uniform("uSnow");
            _pSize = p.Uniform("uSize");
            _pRight = p.Uniform("uRight");
            _pUp = p.Uniform("uUp");
            _pColour = p.Uniform("uColour");
            _pAlpha = p.Uniform("uAlpha");
            _pGround = p.Uniform("uGround");
            return true;
        }

        /// <summary>Frees the weather objects (renderer dispose).</summary>
        private void DisposeWeather()
        {
            ReleaseCoverMap();
            _precipProgram?.Dispose();
            _precipProgram = null;
            _lensProgram?.Dispose();
            _lensProgram = null;
            ReleaseLensCopy();
        }

        private void ReleaseLensCopy()
        {
            if (_lensFbo != 0) { Gl.DeleteFramebuffer(_lensFbo); }
            if (_lensTexture != 0) { Gl.DeleteTexture(_lensTexture); }
            _lensFbo = _lensTexture = 0;
            _lensWidth = _lensHeight = 0;
        }

        private bool EnsureLens(int width, int height)
        {
            if (_lensFailed) { return false; }
            if (_lensProgram == null)
            {
                try
                {
                    _lensProgram = ShaderProgram.Create("lens drops", Shaders.LENS_VS, Shaders.LENS_FS);
                }
                catch (Exception ex)
                {
                    _lensFailed = true;
                    Utilities.Log_Utils.Write($"Lens drop shader failed: {ex.Message}");
                    return false;
                }
                _lensProgram.Use();
                Gl.Uniform1(_lensProgram.Uniform("uScene"), 0);
                _lDrops = _lensProgram.Uniform("uDrops");
                _lShapes = _lensProgram.Uniform("uDropShapes");
                _lAspect = _lensProgram.Uniform("uAspect");
            }
            if (_lensFbo != 0 && _lensWidth == width && _lensHeight == height) { return true; }

            ReleaseLensCopy();
            _lensTexture = Gl.GenTexture();
            Gl.ActiveTexture(Gl.TEXTURE0);
            Gl.BindTexture(Gl.TEXTURE_2D, _lensTexture);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)Gl.LINEAR);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)Gl.LINEAR);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAX_LEVEL, 0);
            Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA8, width, height, Gl.RGBA, Gl.UNSIGNED_BYTE, null);
            _lensFbo = Gl.GenFramebuffer();
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, _lensFbo);
            Gl.FramebufferTexture2D(Gl.FRAMEBUFFER, Gl.COLOR_ATTACHMENT0, Gl.TEXTURE_2D, _lensTexture, 0);
            bool complete = Gl.CheckFramebufferStatus(Gl.FRAMEBUFFER) == Gl.FRAMEBUFFER_COMPLETE;
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);
            if (!complete)
            {
                ReleaseLensCopy();
                _lensFailed = true;
                Utilities.Log_Utils.Write("Lens drops: the frame copy could not be made (lens drops off).");
                return false;
            }
            _lensWidth = width;
            _lensHeight = height;
            return true;
        }

        #endregion

        #region Draw

        /// <summary>
        /// Round W-C: a lightning flash in the classic light (with sun lighting the flash lifts the sky light instead):
        /// brightens the whole frame by <paramref name="amount"/> (0–0.35, capped), multiplying what is there.
        /// </summary>
        public void ApplyFlash(float amount)
        {
            amount = float.IsFinite(amount) ? Math.Clamp(amount, 0f, 0.35f) : 0f;
            if (amount < 0.002f || _exposureProgram == null) { return; }
            Gl.Disable(Gl.DEPTH_TEST);
            Gl.DepthMask(false);
            Gl.Enable(Gl.BLEND);
            Gl.BlendFunc(Gl.DST_COLOR, Gl.ONE);
            _exposureProgram.Use();
            Gl.Uniform3(_exposureColour, amount * 0.9f, amount * 0.94f, amount);
            Gl.BindVertexArray(_emptyVao);
            Gl.DrawArrays(Gl.TRIANGLES, 0, 3);
            Gl.BindVertexArray(0);
            Gl.Disable(Gl.BLEND);
            Gl.DepthMask(true);
            Gl.Enable(Gl.DEPTH_TEST);
        }

        /// <summary>
        /// Round W-C: draws drops (and melting flakes) on the lens over a finished frame: copies the frame (resolving
        /// MSAA) into a texture, then draws each drop refracting it. Leaves <paramref name="target"/> bound.
        /// </summary>
        /// <param name="target">The frame (bound afterwards).</param>
        /// <param name="drops">Per drop: centre u, v (0–1), radius (fraction of the height), opacity.</param>
        /// <param name="shapes">Per drop: seed, 1 = snowflake, melted 0–1, trail (radii).</param>
        /// <param name="count">How many (at most <see cref="MAX_LENS_DROPS"/>).</param>
        public void DrawLensDrops(RenderTarget target, Vector4[] drops, Vector4[] shapes, int count)
        {
            count = Math.Min(count, MAX_LENS_DROPS);
            if (count <= 0 || target == null || !target.IsValid || !EnsureLens(target.Width, target.Height)) { return; }

            Gl.BindFramebuffer(Gl.READ_FRAMEBUFFER, target.Framebuffer);
            Gl.BindFramebuffer(Gl.DRAW_FRAMEBUFFER, _lensFbo);
            Gl.BlitFramebuffer(0, 0, target.Width, target.Height, 0, 0, target.Width, target.Height, Gl.COLOR_BUFFER_BIT, Gl.NEAREST);
            target.Bind();

            Gl.Disable(Gl.DEPTH_TEST);
            Gl.DepthMask(false);
            Gl.Enable(Gl.BLEND);
            Gl.BlendFunc(Gl.SRC_ALPHA, Gl.ONE_MINUS_SRC_ALPHA);
            _lensProgram.Use();
            Gl.Uniform4(_lDrops, count, drops);
            Gl.Uniform4(_lShapes, count, shapes);
            Gl.Uniform1(_lAspect, target.Width / (float)Math.Max(target.Height, 1));
            Gl.ActiveTexture(Gl.TEXTURE0);
            Gl.BindTexture(Gl.TEXTURE_2D, _lensTexture);
            Gl.BindVertexArray(_emptyVao);
            Gl.DrawArraysInstanced(Gl.TRIANGLE_STRIP, 0, 4, count);
            Gl.BindVertexArray(0);
            Gl.BindTexture(Gl.TEXTURE_2D, 0);
            Gl.Disable(Gl.BLEND);
            Gl.DepthMask(true);
            Gl.Enable(Gl.DEPTH_TEST);
        }

        /// <summary>
        /// Sets a program's weather block for one draw (and binds the cover map).
        /// </summary>
        /// <param name="u">The program's locations.</param>
        /// <param name="on">False for passes without weather (the plan minimap).</param>
        private void ApplyWeather(in WeatherUniforms u, bool on)
        {
            WeatherLook w = Weather;
            if (!on || !w.Any)
            {
                Gl.Uniform4(u.Weather, 0f, 0f, 0f, 0f);
                return;
            }
            Gl.Uniform4(u.Weather, Math.Clamp(w.Wet, 0f, 1f), Math.Clamp(w.Snow, 0f, 1f), w.Time % PRECIP_PERIOD, 0f);
            Gl.Uniform4(u.CoverArea, _coverArea.X, _coverArea.Y, _coverArea.Z, _coverMap != 0 ? 1f : 0f);
            Gl.Uniform2(u.CoverSize, _coverSize.X, _coverSize.Y);
            if (_coverMap != 0)
            {
                Gl.ActiveTexture(Gl.TEXTURE0 + COVER_UNIT);
                Gl.BindTexture(Gl.TEXTURE_2D, _coverMap);
                Gl.ActiveTexture(Gl.TEXTURE0);
            }
        }

        /// <summary>
        /// Draws the falling rain or snow (call after the glass, with depth test on). Nothing without weather.
        /// </summary>
        /// <param name="p">The pass (its eye and view-projection).</param>
        /// <param name="right">The camera's right (flakes face the eye).</param>
        /// <param name="up">The camera's up.</param>
        public void DrawPrecipitation(in SceneDrawParams p, Vector3 right, Vector3 up)
        {
            PrecipInstances = 0;
            WeatherLook w = Weather;
            if (w.Kind == 0 || w.Intensity <= 0f || !EnsurePrecipProgram()) { return; }
            bool snow = w.Kind == 2;
            float intensity = Math.Clamp(w.Intensity, 0f, 1f);
            Vector3 box = snow ? SNOW_BOX : RAIN_BOX;
            int count = snow ? SNOW_MIN + (int)((SNOW_MAX - SNOW_MIN) * intensity) : RAIN_MIN + (int)((RAIN_MAX - RAIN_MIN) * intensity);
            Vector3 fall = snow ? new Vector3(w.Wind * 0.45f, -SNOW_SPEED) : new Vector3(w.Wind, -RAIN_SPEED);

            // Colour: the sky's light (dim at night), else the classic light's grey
            SunLighting l = Lighting;
            Vector3 colour;
            float alpha;
            if (l.Enabled)
            {
                Vector3 light = l.SkyColour + l.SunColour * 0.5f;
                colour = snow ? Vector3.Clamp(light * 1.7f, new Vector3(0.04f), new Vector3(0.95f))
                              : Vector3.Clamp(Vector3.Lerp(l.Horizon, light * 1.4f, 0.5f), new Vector3(0.03f), new Vector3(0.9f));
            }
            else
            {
                colour = snow ? new Vector3(0.92f, 0.93f, 0.95f) : new Vector3(0.74f, 0.78f, 0.84f);
            }
            alpha = snow ? 0.9f : 0.16f + 0.12f * intensity;

            _precipProgram.Use();
            Gl.UniformMatrix4(_pViewProj, p.ViewProjection);
            Gl.Uniform3(_pEye, p.Eye.X, p.Eye.Y, p.Eye.Z);
            Gl.Uniform3(_pBox, box.X, box.Y, box.Z);
            Gl.Uniform3(_pFall, fall.X, fall.Y, fall.Z);
            Gl.Uniform1(_pTime, w.Time % PRECIP_PERIOD);
            Gl.Uniform1(_pSnow, snow ? 1 : 0);
            Gl.Uniform2(_pSize, snow ? FLAKE_RADIUS : RAIN_WIDTH, RAIN_LENGTH);
            Gl.Uniform3(_pRight, right.X, right.Y, right.Z);
            Gl.Uniform3(_pUp, up.X, up.Y, up.Z);
            Gl.Uniform3(_pColour, colour.X, colour.Y, colour.Z);
            Gl.Uniform1(_pAlpha, alpha);
            Gl.Uniform1(_pGround, w.GroundZ);
            ApplyWeather(_precipWeather, on: true);

            Gl.Enable(Gl.BLEND);
            Gl.BlendFunc(Gl.SRC_ALPHA, Gl.ONE_MINUS_SRC_ALPHA);
            Gl.DepthMask(false);
            Gl.BindVertexArray(_emptyVao);
            Gl.DrawArraysInstanced(Gl.TRIANGLE_STRIP, 0, 4, count);
            Gl.BindVertexArray(0);
            Gl.DepthMask(true);
            Gl.Disable(Gl.BLEND);
            PrecipInstances = count;
        }

        #endregion
    }
}
