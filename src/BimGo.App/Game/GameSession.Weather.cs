using System.Numerics;
using BimGo.Audio;
using BimGo.Format;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Round W-B: rain and snow (the sun panel's WEATHER tab, saved with the model in sun.json). The cover map (what
    /// keeps the weather off, seen from above) is built on a worker the first time rain or snow is turned on, and again
    /// a moment after the shown model changes; until it is ready the weather shows everywhere. Rain and snow show in the
    /// classic light too; with shadows on the clouds thicken and the light dims while it rains or snows.
    /// <para>Round W-C: lightning while it rains (zones of the sky lit from inside, faint bolts, a soft scene flash, a
    /// delayed thunder rumble; photosensitive limits in <see cref="LightningStorm"/>), drops and melting flakes on the
    /// lens outdoors (main view only), and the rain's sound (<see cref="WeatherSound"/>).</para>
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>The WEATHER tab's sliders.</summary>
        private const int SLIDER_WEATHER = 37, SLIDER_WETNESS = 38, SLIDER_SNOW_COVER = 39;

        /// <summary>Round W-C: the lightning flash slider.</summary>
        private const int SLIDER_FLASH = 31;

        private static readonly string[] LIGHTNING_OPTIONS = { "Rare", "Sometimes", "Often" };

        private static readonly string[] WEATHER_OPTIONS = { "Off", "Rain", "Snow" };

        /// <summary>The wind (m/s) at cloud drift 100 %: the rain slants with it, the snow drifts at under half.</summary>
        private const float WEATHER_WIND = 2.5f;

        // The cover map: built (null = never), the build under way, the scene key each was for
        private CoverMap _coverMap;
        private Task<CoverMap> _coverTask;
        private CancellationTokenSource _coverCancel;
        private long _coverBuiltScene, _coverTaskScene, _coverSeenScene;
        private float _coverSceneChangedAt = -1f;
        private string _coverError;

        // The weather's own clock (s): video frames take theirs from the frame number
        private float _weatherClock;

        // Round W-C: the sound, the eye under a roof, this frame's strike and flash, the last strike whose thunder was queued
        private readonly WeatherSound _weatherSound = new();
        private bool _eyeCovered;
        private float _flashAmount;
        private long _heardStrike = long.MinValue;
        private SunLighting _probeLighting;

        // Round W-C: drops on the lens (fixed pool, no allocations), what the shader gets, the spawn accumulator
        private struct LensDrop
        {
            public Vector2 Position;
            public float Radius, Age, Life, Slide, SlideAfter, Seed, Trail;
            public bool Flake;
        }
        private readonly LensDrop[] _lensDrops = new LensDrop[SceneRenderer.MAX_LENS_DROPS];
        private readonly Vector4[] _lensData = new Vector4[SceneRenderer.MAX_LENS_DROPS], _lensShapes = new Vector4[SceneRenderer.MAX_LENS_DROPS];
        private int _lensDropCount;
        private float _lensSpawn;
        private readonly Random _lensRandom = new(97);

        #endregion

        #region State

        /// <summary>True when it rains or snows.</summary>
        private bool WeatherOn => _sun != null && (_sun.Raining || _sun.Snowing);

        /// <summary>Round W-C: lightning shows (it's raining and lightning is ticked).</summary>
        private bool LightningOn => _sun != null && _sun.Raining && _sun.Lightning;

        /// <summary>How overcast the weather makes the sky (0 = none, up to 1 in a heavy storm).</summary>
        private float WeatherOvercast => WeatherOn ? 0.55f + 0.45f * _sun.WeatherIntensity : 0f;

        #endregion

        #region Per frame

        /// <summary>Advances the weather clock (every frame).</summary>
        private void AdvanceWeather(float dt)
        {
            _weatherClock += dt;
            if (_weatherClock > 3600f) { _weatherClock -= 3600f; }

            // W-C: the rain's sound (it fades out when the rain stops), and the drops on the lens
            float rain = _sun != null && _sun.Raining && _sun.WeatherSound ? 0.35f + 0.65f * _sun.WeatherIntensity : 0f;
            _weatherSound.Volume = Sound.Volume;
            _weatherSound.Update(rain, _eyeCovered);
            SimulateLensDrops(dt);
        }

        /// <summary>
        /// Before the 3D passes: builds / uploads the cover map when needed and hands the renderer this frame's weather.
        /// Allocation-free while nothing changes.
        /// </summary>
        private void UpdateWeather()
        {
            if (_renderer == null || _sun == null) { return; }
            UpdateCoverMap();

            _flashAmount = 0f;
            _renderer.Sky.Lightning = Vector4.Zero;
            _renderer.Sky.Bolt = Vector4.Zero;
            if (!WeatherOn)
            {
                _renderer.Weather = default;
                _eyeCovered = false;
                return;
            }
            bool snow = _sun.Snowing;
            float time = _video != null ? _videoFrame / (float)_videoFps : _weatherClock;
            _eyeCovered = _coverMap != null && _coverMap.IsCovered(Camera.Position, 0.3f);
            EvaluateLightning(time);
            _renderer.Weather = new WeatherLook
            {
                Kind = snow ? 2 : 1,
                Intensity = _sun.WeatherIntensity,
                Wet = snow ? 0f : _sun.Wetness,
                Snow = snow ? _sun.SnowCover : 0f,
                Wind = -CLOUD_WIND * (WEATHER_WIND * _sun.CloudSpeed), // with the clouds' drift
                Time = time,
                GroundZ = _groundZ
            };
        }

        /// <summary>
        /// The cover map: a finished build is uploaded; a new one starts when the weather is on and the map is missing
        /// or the shown model changed (once it has settled: a drag is one change).
        /// </summary>
        private void UpdateCoverMap()
        {
            if (_coverTask != null && _coverTask.IsCompleted)
            {
                Task<CoverMap> done = _coverTask;
                long doneScene = _coverTaskScene;
                _coverTask = null;
                _coverCancel?.Dispose();
                _coverCancel = null;
                if (done.Status == TaskStatus.RanToCompletion)
                {
                    _coverMap = done.Result ?? CoverMap.Empty;
                    _coverBuiltScene = doneScene;
                    _coverError = _renderer.SetCoverMap(_coverMap);
                    if (_coverError != null) { Toast(_coverError, 6f, important: true); }
                }
                else if (done.IsFaulted)
                {
                    _coverError = "The roofs could not be mapped: rain and snow show indoors too (see the log).";
                    Utilities.Log_Utils.Write($"Cover map failed: {done.Exception?.GetBaseException()}");
                    Toast(_coverError, 5f, important: true);
                }
            }

            if (!WeatherOn || _coverError != null) { return; }
            long sceneKey = ShadowSceneKey();
            if (sceneKey != _coverSeenScene)
            {
                _coverSeenScene = sceneKey;
                _coverSceneChangedAt = _clock;
            }
            bool settled = _coverSceneChangedAt < 0f || (_clock - _coverSceneChangedAt > GRASS_SETTLE && !_guns[_activeGun].CapturesInput);
            if (_coverMap != null && (sceneKey == _coverBuiltScene || !settled)) { return; }
            if (_coverTask != null)
            {
                if (settled && _coverTaskScene != sceneKey) { _coverCancel?.Cancel(); }
                return;
            }

            // Start a build (the scene is read-only: safe on a worker; visibility and copies are snapshots)
            SceneData scene = Scene;
            bool[] visible = GrassVisibility();
            List<(int Element, Matrix4x4 Model)> instances = GrassInstances();
            _coverCancel = new CancellationTokenSource();
            CancellationToken token = _coverCancel.Token;
            _coverTaskScene = sceneKey;
            _coverSceneChangedAt = -1f;
            _coverTask = Task.Run(() => CoverMap.Build(scene, token, visible, instances), token);
        }

        /// <summary>
        /// Round W-C: the strike lighting the sky now (zone, bolt), the scene flash, and (live frames) the thunder queued
        /// the first time a strike shows. The storm is worked out from the clock, so videos get the same lightning.
        /// </summary>
        private void EvaluateLightning(float time)
        {
            if (!LightningOn) { return; }
            if (!LightningStorm.Evaluate(time, _sun.LightningFrequency, _sun.ReduceFlashing, out LightningStrike strike, out float brightness)) { return; }
            float near = 1f - strike.Distance;
            float cosElevation = MathF.Cos(strike.Elevation);
            var towards = new Vector3(cosElevation * MathF.Cos(strike.Azimuth), cosElevation * MathF.Sin(strike.Azimuth), MathF.Sin(strike.Elevation));
            _renderer.Sky.Lightning = new Vector4(towards, brightness * (0.55f + 0.45f * near));
            _renderer.Sky.Bolt = new Vector4(strike.Seed, strike.Bolt ? 1f : 0f, 0.16f + 0.16f * near, 0f);
            _flashAmount = brightness * _sun.LightningFlash * (0.4f + 0.6f * near);

            if (_video == null && strike.Index != _heardStrike)
            {
                _heardStrike = strike.Index;
                if (_sun.WeatherSound) { _weatherSound.Thunder(strike.ThunderDelay, strike.ThunderGain, _eyeCovered); }
            }
        }

        /// <summary>
        /// The frame's lighting: the sun's (with the weather), and a lightning flash lifting the sky light. The probes
        /// are keyed on the lighting without the flash.
        /// </summary>
        private SunLighting FrameLighting()
        {
            SunLighting lighting = CurrentLighting();
            _probeLighting = lighting;
            return SunLighting.WithLightning(lighting, _flashAmount);
        }

        /// <summary>Round W-C: a flash in the classic light (a capped brightening of the frame).</summary>
        private void DrawLightningFlash()
        {
            if (_flashAmount > 0f && !_sun.Enabled) { _renderer.ApplyFlash(_flashAmount * 0.3f); }
        }

        /// <summary>
        /// Round W-C: ages, slides and melts the drops on the lens, and lets new ones land: outdoors only, more when
        /// looking up, none in photo mode. Allocation-free.
        /// </summary>
        private void SimulateLensDrops(float dt)
        {
            for (int i = 0; i < _lensDropCount; i++)
            {
                ref LensDrop d = ref _lensDrops[i];
                d.Age += dt;
                if (d.Age >= d.Life || d.Position.Y < -0.1f)
                {
                    _lensDrops[i] = _lensDrops[--_lensDropCount];
                    i--;
                    continue;
                }
                bool melted = !d.Flake || d.Age > d.Life * 0.55f;
                if (melted && d.Slide > 0f && d.Age > d.SlideAfter)
                {
                    d.Position.Y -= d.Slide * dt;
                    d.Trail = MathF.Min(d.Trail + d.Slide * dt / MathF.Max(d.Radius, 1e-3f) * 0.6f, 2.5f);
                }
            }

            if (_sun == null || !WeatherOn || !_sun.LensDrops || _eyeCovered || _photoOpen || _paused)
            {
                _lensSpawn = 0f;
                return;
            }
            float look = Math.Clamp(0.15f + 1.8f * (Camera.Forward.Z + 0.1f), 0.03f, 2.5f);
            float rate = (_sun.Snowing ? 0.12f + 0.6f * _sun.WeatherIntensity : 0.2f + 1.3f * _sun.WeatherIntensity) * look;
            _lensSpawn += rate * dt;
            while (_lensSpawn >= 1f)
            {
                _lensSpawn -= 1f;
                if (_lensDropCount >= _lensDrops.Length) { break; }
                bool flake = _sun.Snowing;
                float r() => (float)_lensRandom.NextDouble();
                _lensDrops[_lensDropCount++] = new LensDrop
                {
                    Position = new Vector2(0.04f + 0.92f * r(), 0.1f + 0.86f * r()),
                    Radius = flake ? 0.012f + 0.01f * r() : 0.01f + 0.02f * r(),
                    Age = 0f,
                    Life = flake ? 3f + 2f * r() : 2.5f + 3.5f * r(),
                    Slide = r() < (flake ? 0.25f : 0.45f) ? 0.02f + 0.06f * r() : 0f,
                    SlideAfter = 0.4f + 1.6f * r(),
                    Seed = r(),
                    Trail = 0f,
                    Flake = flake
                };
            }
        }

        /// <summary>
        /// Round W-C: draws the drops on the lens over the main view (never photos, videos, thumbnails or screenshots).
        /// </summary>
        private void DrawLensDrops(RenderTarget target)
        {
            if (_lensDropCount == 0 || _photoOpen || _video != null || ThumbnailDue || _screenshotRequested || _sunShotRequested) { return; }
            for (int i = 0; i < _lensDropCount; i++)
            {
                LensDrop d = _lensDrops[i];
                float alpha = 0.85f * MathF.Min(1f, d.Age / 0.12f) * Math.Clamp((d.Life - d.Age) / 0.8f, 0f, 1f);
                float melt = d.Flake ? Math.Clamp(d.Age / (d.Life * 0.55f), 0f, 1f) : 1f;
                _lensData[i] = new Vector4(d.Position.X, d.Position.Y, d.Radius, alpha);
                _lensShapes[i] = new Vector4(d.Seed, d.Flake ? 1f : 0f, melt, d.Trail);
            }
            _renderer.DrawLensDrops(target, _lensData, _lensShapes, _lensDropCount);
        }

        /// <summary>
        /// Draws the falling rain or snow (main view, photos and video frames: after the glass).
        /// </summary>
        private void DrawWeather(in SceneDrawParams p)
        {
            if (!WeatherOn) { return; }
            Vector3 right = Camera.Right;
            Vector3 up = Vector3.Cross(right, Camera.Forward);
            up = up.LengthSquared() > 1e-6f ? Vector3.Normalize(up) : Vector3.UnitZ;
            _renderer.DrawPrecipitation(p, right, up);
        }

        /// <summary>Fog thickens in the rain or snow (the main pass's density × this).</summary>
        private float WeatherFog => WeatherOn ? 1f + (_sun.Snowing ? 3f : 2f) * _sun.WeatherIntensity : 1f;

        #endregion

        #region Panel

        // The status line, made again only when what it says changes (no per-frame strings)
        private string _weatherStatusText;
        private int _weatherStatusKey = int.MinValue;

        /// <summary>
        /// The WEATHER tab: off / rain / snow, how hard, the wet look or the settled snow, where the cover map is up to,
        /// RESET WEATHER.
        /// </summary>
        /// <returns>The tab's bottom.</returns>
        private float BuildWeatherTab(FontAtlas f, InputState input, float ix, float cy, float iw)
        {
            int kind = _sun.Snowing ? 2 : _sun.Raining ? 1 : 0;
            int chosen = Segmented(f, input, ix, cy, iw, WEATHER_OPTIONS, kind);
            if (chosen != kind)
            {
                _sun.Weather = chosen == 2 ? SunSettings.WEATHER_SNOW : chosen == 1 ? SunSettings.WEATHER_RAIN : SunSettings.WEATHER_OFF;
                _activeSlider = -1;
                SunChanged();
            }
            cy += S(42);

            if (WeatherOn)
            {
                IntensitySlider(f, input, SLIDER_WEATHER, ix, cy, iw, _sun.Snowing ? "Snowfall" : "Rainfall", _sun.WeatherIntensity, 1f);
                cy += S(54);
                if (_sun.Raining) { IntensitySlider(f, input, SLIDER_WETNESS, ix, cy, iw, "Wet look", _sun.Wetness, 1f); }
                else { IntensitySlider(f, input, SLIDER_SNOW_COVER, ix, cy, iw, "Settled snow", _sun.SnowCover, 1f); }
                cy += S(54);
                _ui.TextWrapped(f.Small, ix, cy, iw, WeatherStatus(), _coverError != null ? UiTheme.MEASURE_LABEL : UiTheme.TEXT_MUTED, maxLines: 2);
                cy += S(40);

                // W-C: the lens, the sound, lightning (rain only)
                bool drops = Checkbox(f, input, ix, cy, iw, _sun.Snowing ? "Flakes on the lens (outdoors)" : "Drops on the lens (outdoors)", _sun.LensDrops);
                if (drops != _sun.LensDrops) { _sun.LensDrops = drops; SunChanged(); }
                cy += S(30);
                if (_sun.Raining)
                {
                    bool sound = Checkbox(f, input, ix, cy, iw, "Rain sound and thunder", _sun.WeatherSound);
                    if (sound != _sun.WeatherSound) { _sun.WeatherSound = sound; SunChanged(); }
                    cy += S(30);
                    bool lightning = Checkbox(f, input, ix, cy, iw, "Lightning", _sun.Lightning);
                    if (lightning != _sun.Lightning)
                    {
                        _sun.Lightning = lightning;
                        SunChanged();
                        if (lightning) { Toast("Lightning on · at most three flashes a second; Reduce flashing turns them into slow glows", 5f); }
                    }
                    cy += S(32);
                    if (_sun.Lightning)
                    {
                        int frequency = Segmented(f, input, ix, cy, iw, LIGHTNING_OPTIONS, Math.Clamp(_sun.LightningFrequency, 0, 2));
                        if (frequency != _sun.LightningFrequency) { _sun.LightningFrequency = frequency; SunChanged(); }
                        cy += S(42);
                        IntensitySlider(f, input, SLIDER_FLASH, ix, cy, iw, "Flash on the scene", _sun.LightningFlash, 1f);
                        cy += S(54);
                        bool reduce = Checkbox(f, input, ix, cy, iw, "Reduce flashing (slow glows only)", _sun.ReduceFlashing);
                        if (reduce != _sun.ReduceFlashing) { _sun.ReduceFlashing = reduce; SunChanged(); }
                        cy += S(30);
                        _ui.TextWrapped(f.Small, ix, cy, iw,
                            "Flickers are kept to three a second at most and fade in and out. If flashing lights bother you, tick Reduce flashing.",
                            UiTheme.TEXT_FAINT, maxLines: 3);
                        cy += S(52);
                    }
                }
            }
            _ui.TextWrapped(f.Small, ix, cy, iw,
                "Shows in the classic light too; with shadows on the clouds thicken and the light dims. The wind follows the cloud drift (SKY). Saved with the model.",
                UiTheme.TEXT_FAINT, maxLines: 4);
            cy += S(66);
            if (SmallButton(f, input, ix, cy, S(150), S(28), "RESET WEATHER"))
            {
                _sun.Weather = SunSettings.WEATHER_OFF;
                _sun.WeatherIntensity = 0.5f;
                _sun.Wetness = 1f;
                _sun.SnowCover = 0.6f;
                _sun.Lightning = _sun.ReduceFlashing = false; // W-C
                _sun.LightningFrequency = 1;
                _sun.LightningFlash = 0.35f;
                _sun.LensDrops = _sun.WeatherSound = true;
                SunChanged();
            }
            return cy + S(28);
        }

        /// <summary>The WEATHER tab's status line (where the cover map is up to).</summary>
        private string WeatherStatus()
        {
            int key = HashCode.Combine(_coverError, _coverTask != null, _coverMap?.CoveredCells ?? -1, _sun.Snowing);
            if (key == _weatherStatusKey && _weatherStatusText != null) { return _weatherStatusText; }
            _weatherStatusKey = key;
            return _weatherStatusText = MakeWeatherStatus();
        }

        private string MakeWeatherStatus()
        {
            if (_coverError != null) { return _coverError; }
            string what = _sun.Snowing ? "Snow" : "Rain";
            if (_coverMap == null || _coverTask != null) { return "Mapping the roofs and canopies…"; }
            if (_coverMap.IsEmpty) { return $"{what} falls everywhere (nothing in the model covers anything)."; }
            float area = _coverMap.CoveredCells * _coverMap.Cell * _coverMap.Cell;
            return $"{what} stops at roofs and canopies ({area:N0} m² mapped, {UnitFormat.Length(_coverMap.Cell, 1)} cells).";
        }

        #endregion
    }
}
