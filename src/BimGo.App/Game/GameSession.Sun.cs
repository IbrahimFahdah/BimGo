using System.Numerics;
using BimGo.Audio;
using BimGo.Format;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;
using Vk = BimGo.Native.Win32;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Sun, shadows and time of day.
    /// <list type="bullet">
    /// <item><b>O</b> toggles shadows (off by default; off frees the maps and restores the classic light).</item>
    /// <item><b>Shift+O</b>, or clicking the sun icon (bottom right) while the cursor is free, opens the sun panel:
    /// the cursor is released and the player stands still while the scene keeps rendering live. Esc or O closes it.</item>
    /// <item>Panel: shadows on/off and quality, time slider (5 min steps, Shift = 1 min, play), month / day boxes
    /// (clamped), daylight saving, and sun / sky / shadow / glass intensities. <b>[ ]</b> step the time.</item>
    /// </list>
    /// The state is saved with the model (sun.json in a .bimgo, or a sidecar beside the Revit model, written a moment
    /// after the last change); quality is a per-machine setting.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Constants

        private const int TIME_STEP = 5;          // minutes per slider / [ ] step
        private const float PLAY_SPEED = 60f;      // clock minutes per real second while playing
        private const float SIDECAR_DELAY = 1.5f;  // seconds after the last change before the live sidecar is written

        // Slider ids (the pause menu uses 0–2)
        private const int SLIDER_TIME = 10, SLIDER_SUN = 11, SLIDER_SKY = 12, SLIDER_SHADOW = 13, SLIDER_GLASS = 14;

        /// <summary>Sky round: the SKY tab's sliders (unique across the menu's sliders).</summary>
        private const int SLIDER_CLOUDS = 20, SLIDER_CLOUD_SPEED = 21, SLIDER_SUN_SIZE = 22, SLIDER_SUN_GLARE = 23;

        /// <summary>Sky round: the sun panel's lower tabs.</summary>
        private static readonly string[] SUN_TABS = { "LIGHTING", "SKY", "NIGHT" }; // W-A: NIGHT (moon, stars)

        /// <summary>Round W-A: the NIGHT tab's sliders.</summary>
        private const int SLIDER_MOONLIGHT = 32, SLIDER_STAR_DENSITY = 33, SLIDER_STAR_BRIGHTNESS = 34, SLIDER_STAR_TWINKLE = 35, SLIDER_MILKY_WAY = 36;

        /// <summary>Round W-A: the moon's phase: real, or a chosen lit fraction.</summary>
        private static readonly string[] MOON_PHASE_OPTIONS = { "Actual", "", "", "", "" }; // the four chosen phases are drawn as moons
        private static readonly string[] MOON_PHASE_NAMES = { "Actual phase for the date", "Full", "Gibbous", "Half", "Crescent" };
        private static readonly float[] MOON_PHASE_VALUES = { 0f, 1f, 0.8f, 0.5f, 0.2f };

        /// <summary>Cloud drift at speed 1 (noise units per second) and its direction (from the west-south-west).</summary>
        private const float CLOUD_DRIFT = 0.012f;
        private static readonly Vector2 CLOUD_WIND = Vector2.Normalize(new Vector2(0.92f, 0.38f));

        // Open lower tab (0 lighting, 1 sky; per session) and where the clouds have drifted to
        private int _sunTab;
        private Vector2 _cloudOffset;

        private static readonly string[] QUALITY_OPTIONS = { "Low", "Medium", "High" };
        private static readonly string[] COMPASS = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" };
        private static readonly string[] MONTHS = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
        private static readonly string[] MONTHS_UPPER = { "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC" };

        #endregion

        #region Fields

        private SunSettings _sun;
        private GeoLocation _location;
        private bool _locationKnown;
        private double _northAngle;
        private Vector3 _sunDirection = Vector3.UnitZ;

        // Round W-A: the moon (scene axes, degrees, lit fraction) and the equatorial axes the stars turn in
        private Vector3 _moonDirection = -Vector3.UnitZ;
        private double _moonAltitude, _moonAzimuth;
        private float _moonLit;
        private bool _moonWaxing;
        private Vector3 _celestialX = Vector3.UnitX, _celestialY = Vector3.UnitY, _celestialZ = Vector3.UnitZ;
        private double _sunAltitude, _sunAzimuth;   // degrees
        private ShadowQuality _shadowQuality = ShadowQuality.Medium;

        private bool _sunPanelOpen;
        private bool _sunPlaying;
        private float _playMinutes;

        private int _sunRevision, _savedSunRevision, _sidecarSunRevision;
        private float _sunSidecarTimer;
        private string _sunSidecarPath;

        // Month / day text boxes: 0 = none focused, 1 = month, 2 = day
        private int _sunField;
        private readonly char[] _sunFieldChars = new char[2];
        private int _sunFieldLength;

        // Shadow invalidation: bumped when static elements hide / show or categories toggle
        private long _sceneRevision;

        // Polish round P-C: the tour's sun blend sets fractional minutes here (NaN: none)
        private double _sunBlendMinutes = double.NaN;

        // Cached label
        private string _sunPlaceLabel;

        #endregion

        #region State

        /// <summary>True when shadows (sun lighting) are on.</summary>
        public bool ShadowsOn => _sun?.Enabled == true;

        /// <summary>True if the sun state changed since the file was saved (file mode).</summary>
        private bool SunDirty => _sunRevision != _savedSunRevision;

        #endregion

        #region Setup

        /// <summary>
        /// Loads the sun state (file, else live sidecar, else defaults from the model's site) and the location.
        /// </summary>
        private void InitialiseSun()
        {
            _shadowQuality = Scene.Settings?.ShadowQuality ?? ShadowQuality.Medium;
            _northAngle = SolarPosition.NorthAngle(Scene.Site);

            if (IsFileMode)
            {
                _sun = _options.Document?.Sun?.Copy().Clean();
            }
            else
            {
                _sunSidecarPath = SunFiles.SidecarFor(Scene.CommentsPath);
                _sun = SunFiles.Read(_sunSidecarPath, out string error);
                if (error != null) { Utilities.Log_Utils.Write(error); }
            }
            _sun ??= SunSettings.DefaultsFor(Scene.Site).Clean();
            RefreshSunLocation();
        }

        private static string FormatZone(double hours)
        {
            string sign = hours < 0 ? "−" : "+";
            double abs = Math.Abs(hours);
            int h = (int)abs, m = (int)Math.Round((abs - h) * 60.0);
            return m == 0 ? $"{sign}{h}" : $"{sign}{h}:{m:00}";
        }

        #endregion

        #region Sun state

        /// <summary>
        /// Recomputes the sun direction from the date, time and location.
        /// </summary>
        private void RecomputeSun()
        {
            SunTime time = _sun.Time;
            double minutes = !double.IsNaN(_sunBlendMinutes) ? _sunBlendMinutes : _sunPlaying ? _playMinutes : time.Minutes;
            SolarPosition.Compute(_location, DateTime.Today.Year, time.Month, time.Day, minutes, time.DaylightSaving,
                out double altitude, out double azimuth);
            _sunAltitude = altitude * 180.0 / Math.PI;
            _sunAzimuth = azimuth * 180.0 / Math.PI;
            _sunDirection = SolarPosition.ToModel(SolarPosition.Direction(altitude, azimuth), _northAngle);

            // W-A: the moon and the turning sky (same date, time and place)
            int year = DateTime.Today.Year;
            LunarPosition.Compute(_location, year, time.Month, time.Day, minutes, time.DaylightSaving, out double moonAltitude, out double moonAzimuth,
                out double lit, out _moonWaxing);
            _moonAltitude = moonAltitude * 180.0 / Math.PI;
            _moonAzimuth = moonAzimuth * 180.0 / Math.PI;
            _moonLit = (float)lit;
            _moonDirection = SolarPosition.ToModel(SolarPosition.Direction(moonAltitude, moonAzimuth), _northAngle);
            Matrix4x4 sky = LunarPosition.EquatorialToTrueNorth(LunarPosition.LocalSiderealTime(_location, year, time.Month, time.Day, minutes, time.DaylightSaving),
                _location.Latitude);
            _celestialX = SolarPosition.ToModel(new Vector3(sky.M11, sky.M12, sky.M13), _northAngle);
            _celestialY = SolarPosition.ToModel(new Vector3(sky.M21, sky.M22, sky.M23), _northAngle);
            _celestialZ = SolarPosition.ToModel(new Vector3(sky.M31, sky.M32, sky.M33), _northAngle);
        }

        /// <summary>
        /// Records a change to the sun state (dirty file / delayed sidecar write) and recomputes the direction.
        /// </summary>
        private void SunChanged()
        {
            _sun.Clean();
            _sunRevision++;
            _sunSidecarTimer = SIDECAR_DELAY;
            RecomputeSun();
            UpdateTitle();
        }

        /// <summary>
        /// O: shadows on / off.
        /// </summary>
        private void ToggleShadows()
        {
            _sun.Enabled = !_sun.Enabled;
            if (!_sun.Enabled) { _sunPlaying = false; }
            SunChanged();
            Sound.Play(SoundId.UiClick);
            Toast(_sun.Enabled ? $"Shadows on · {DescribeSunTime()} ({Key(InputAction.SunPanel)} opens the sun panel)" : "Shadows off");
        }

        /// <summary>
        /// Moves the clock by a number of minutes (wrapping within the day).
        /// </summary>
        private void StepSunTime(int minutes)
        {
            if (_sunPlaying)
            {
                _sunPlaying = false;
                _sun.Time.Minutes = Math.Clamp((int)MathF.Round(_playMinutes), 0, 1439);
            }
            int value = ((_sun.Time.Minutes + minutes) % 1440 + 1440) % 1440;
            _sun.Time.Minutes = value;
            SunChanged();

            // Say which time is now shown (short, so holding the key reads as a ticking clock)
            if (!_sunPanelOpen) { Toast($"{DescribeSunTime()} · sun {SunHeightText()}", 1.4f); }
        }

        /// <summary>
        /// "32° high, NW" or "below the horizon" (allocates: toasts only).
        /// </summary>
        private string SunHeightText()
        {
            if (_sunAltitude <= 0.0) { return "below the horizon"; }
            int sector = (int)Math.Round(((_sunAzimuth % 360.0) + 360.0) % 360.0 / 45.0) % 8;
            return $"{_sunAltitude:0}° high in the {COMPASS[sector]}";
        }

        /// <summary>
        /// Sets the date and time (bookmarks), turning shadows on.
        /// </summary>
        private void ApplySunTime(SunTime time)
        {
            if (time == null) { return; }
            _sunPlaying = false;
            _sun.Time = time.Copy();
            _sun.Enabled = true;
            SunChanged();
        }

        /// <summary>
        /// "21 Jun 14:35" (allocates: toasts only).
        /// </summary>
        private string DescribeSunTime()
        {
            SunTime t = _sun.Time;
            bool dst = SolarPosition.IsDaylightSaving(_location, DateTime.Today.Year, t.Month, t.Day, t.DaylightSaving);
            return $"{t.Day} {MONTHS[Math.Clamp(t.Month, 1, 12) - 1]} {t.Minutes / 60:00}:{t.Minutes % 60:00}{(dst ? " DST" : string.Empty)}";
        }

        /// <summary>
        /// Per frame: animation, the delayed sidecar write, and this frame's lighting for the renderer.
        /// </summary>
        private void UpdateSun(float dt)
        {
            if (_sunPlaying && _sun.Enabled)
            {
                _playMinutes += dt * PLAY_SPEED;
                if (_playMinutes >= 1440f) { _playMinutes -= 1440f; }
                RecomputeSun();
            }

            // Live sessions: write the sidecar once changes settle
            if (_sunSidecarPath != null && _sidecarSunRevision != _sunRevision && !_sunPlaying)
            {
                _sunSidecarTimer -= dt;
                if (_sunSidecarTimer <= 0f) { FlushSunSidecar(); }
            }
        }

        /// <summary>
        /// Writes the live sidecar if it is behind (also on shutdown).
        /// </summary>
        private void FlushSunSidecar()
        {
            if (_sunSidecarPath == null || _sidecarSunRevision == _sunRevision) { return; }
            _sidecarSunRevision = _sunRevision;
            if (!SunFiles.Write(_sunSidecarPath, _sun, out string error)) { Toast(error, 4f, important: true); }
        }

        /// <summary>
        /// Sky round: drifts the clouds and hands the sky look to the renderer (every frame; allocation-free).
        /// </summary>
        private void AdvanceSky(float dt)
        {
            if (_renderer == null || _sun == null) { return; }
            _cloudOffset += CLOUD_WIND * (CLOUD_DRIFT * _sun.CloudSpeed * dt);
            if (_cloudOffset.LengthSquared() > 1e8f) { _cloudOffset = Vector2.Zero; } // days of drift: keep the noise precise
            _renderer.Sky = new SkyLook
            {
                CloudCover = _sun.CloudCover,
                CloudOffset = _cloudOffset,
                SunSize = _sun.SunSize,
                SunGlare = _sun.SunGlare,
                Stars = _sun.Stars ? new Vector4(_sun.StarDensity, _sun.StarBrightness, _sun.StarTwinkle, _sun.MilkyWay) : Vector4.Zero, // W-A
                Time = _clock % 3600f,
                CelestialX = _celestialX,
                CelestialY = _celestialY,
                CelestialZ = _celestialZ
            };
        }

        /// <summary>
        /// The renderer's lighting for this frame.
        /// </summary>
        private SunLighting CurrentLighting()
        {
            if (!_sun.Enabled) { return default; }

            // W-A: the moon's phase (real, or chosen: the light on its face turned to give that lit fraction)
            float lit = _sun.MoonPhase ?? _moonLit;
            SunLighting lighting = SunLighting.Create(_sunDirection, _sun.SunIntensity, _sun.SkyIntensity, _sun.ShadowIntensity, _sun.GlassTransmission,
                _moonDirection, lit, _sun.Moon, _sun.MoonLight);
            if (_sun.MoonPhase is float chosen)
            {
                Vector3 side = _sunDirection - _moonDirection * Vector3.Dot(_sunDirection, _moonDirection);
                if (side.LengthSquared() < 1e-6f) { side = Vector3.Cross(_moonDirection, Vector3.UnitZ); }
                if (side.LengthSquared() < 1e-6f) { side = Vector3.UnitX; }
                side = Vector3.Normalize(side);
                float cosElongation = Math.Clamp(1f - 2f * chosen, -1f, 1f);
                lighting.MoonSunDirection = _moonDirection * cosElongation + side * MathF.Sqrt(1f - cosElongation * cosElongation);
            }
            return lighting;
        }

        /// <summary>
        /// Changes whenever shadow casters change: hidden elements, category toggles, whitecard, moved / cloned elements.
        /// Allocation-free (a struct hash over the active dynamic instances).
        /// </summary>
        private long ShadowSceneKey()
        {
            var hash = new HashCode();
            hash.Add(_whitecard);
            foreach (Physics.DynamicInstance instance in Dynamics.Instances)
            {
                if (!Dynamics.IsActive(instance)) { continue; }
                hash.Add(instance.Id);
                hash.Add(instance.Offset);
                hash.Add(instance.Angle);
            }
            return (_sceneRevision << 32) ^ (uint)hash.ToHashCode();
        }

        /// <summary>
        /// Shows a shadow failure and switches shadows off (called by the render loop).
        /// </summary>
        private void OnShadowFailure(string reason)
        {
            _sun.Enabled = false;
            _sunPlaying = false;
            SunChanged();
            Sound.Play(SoundId.Error);
            Toast(reason, 6f, important: true);
        }

        #endregion

        #region Panel: open, close, keys

        /// <summary>True while the sun panel is open (cursor free, player still).</summary>
        private bool IsSunPanelOpen => _sunPanelOpen;

        private void OpenSunPanel()
        {
            if (_sunPanelOpen) { return; }
            CloseSunHours(); // one panel at a time
            CloseGridsPanel();
            CloseSectionEditor();
            ClosePhotoMode();
            ShowUi(); // the panel is UI: Shift+O while hidden brings everything back
            _sunPanelOpen = true;
            _sunField = 0;
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            Sound.Play(SoundId.UiClick);
        }

        private void CloseSunPanel()
        {
            if (!_sunPanelOpen) { return; }
            CommitSunField();
            _locationOpen = false;
            _sunPanelOpen = false;
            _activeSlider = -1;
            _window.Input.ReleaseAll();
            if (!_paused && _window.IsActive && !_clashModeOn) { _window.SetCaptured(true); } // clash mode keeps its cursor
        }

        /// <summary>
        /// Keys while the panel is open: Esc / O close (Esc first leaves a text box), [ ] step the time, typing goes
        /// to a focused month / day box.
        /// </summary>
        private void UpdateSunPanelKeys(InputState input)
        {
            if (_locationOpen)
            {
                UpdateLocationKeys(input);
                return;
            }
            if (_sunField != 0)
            {
                // A text box (month / day): its keys stay outside the action map (input round B2)
                foreach (char c in input.Chars)
                {
                    if (c >= '0' && c <= '9')
                    {
                        if (_sunFieldLength >= _sunFieldChars.Length) { _sunFieldLength = 0; }
                        _sunFieldChars[_sunFieldLength++] = c;
                    }
                    else if (c == '\b' && _sunFieldLength > 0) { _sunFieldLength--; }
                }
                if (input.IsPressed(Vk.VK_RETURN) || input.IsPressed(Vk.VK_TAB))
                {
                    int next = input.IsPressed(Vk.VK_TAB) && _sunField == 1 ? 2 : 0;
                    CommitSunField();
                    if (next != 0) { FocusSunField(next); }
                    return;
                }
                if (input.IsPressed(Vk.VK_ESCAPE))
                {
                    _sunField = 0;
                    return;
                }
                if (input.IsPressedOrRepeated(Vk.VK_UP) || input.IsPressedOrRepeated(Vk.VK_DOWN))
                {
                    int delta = input.IsPressedOrRepeated(Vk.VK_UP) ? 1 : -1;
                    int field = _sunField;
                    CommitSunField();
                    if (field == 1) { _sun.Time.Month = (_sun.Time.Month - 1 + delta + 12) % 12 + 1; }
                    else { _sun.Time.Day += delta; }
                    SunChanged();
                    FocusSunField(field);
                }
                return;
            }

            if (input.Pressed(InputAction.Back) || input.Pressed(InputAction.Shadows) || input.Pressed(InputAction.SunPanel))
            {
                CloseSunPanel();
                return;
            }
            StepSunTimeKeys(input);
            if (input.Pressed(InputAction.SunPlay)) { TogglePlay(); }
        }

        /// <summary>
        /// The sun time keys (walking with shadows on, photo mode, the sun panel): −/+ 5 min, and −/+ 1 min (Shift by
        /// default), on key repeat too.
        /// </summary>
        private void StepSunTimeKeys(InputState input)
        {
            if (input.PressedOrRepeated(InputAction.SunEarlier)) { StepSunTime(-TIME_STEP); }
            if (input.PressedOrRepeated(InputAction.SunEarlierFine)) { StepSunTime(-1); }
            if (input.PressedOrRepeated(InputAction.SunLater)) { StepSunTime(TIME_STEP); }
            if (input.PressedOrRepeated(InputAction.SunLaterFine)) { StepSunTime(1); }
        }

        private void TogglePlay()
        {
            if (!_sun.Enabled) { return; }
            if (_sunPlaying)
            {
                // Stop on the nearest minute and keep it
                _sunPlaying = false;
                _sun.Time.Minutes = Math.Clamp((int)MathF.Round(_playMinutes), 0, 1439);
                SunChanged();
            }
            else
            {
                _sunPlaying = true;
                _playMinutes = _sun.Time.Minutes;
            }
            Sound.Play(SoundId.UiClick);
        }

        private void FocusSunField(int field)
        {
            _sunField = field;
            int value = field == 1 ? _sun.Time.Month : _sun.Time.Day;
            _sunFieldLength = 0;
            if (value >= 10) { _sunFieldChars[_sunFieldLength++] = (char)('0' + value / 10); }
            _sunFieldChars[_sunFieldLength++] = (char)('0' + value % 10);
        }

        /// <summary>
        /// Applies a focused month / day box (clamped: month 1–12, day to the month's length; empty keeps the value).
        /// </summary>
        private void CommitSunField()
        {
            if (_sunField == 0) { return; }
            int field = _sunField;
            _sunField = 0;
            if (_sunFieldLength == 0) { return; }

            int value = 0;
            for (int i = 0; i < _sunFieldLength; i++) { value = value * 10 + (_sunFieldChars[i] - '0'); }
            if (field == 1) { _sun.Time.Month = Math.Clamp(value, 1, 12); }
            else { _sun.Time.Day = Math.Max(value, 1); }
            SunChanged(); // Clean() clamps the day to the month
        }

        #endregion

        #region HUD: icon and panel

        /// <summary>
        /// The sun icon's square (bottom right, the size of a gun slot).
        /// </summary>
        private void SunIconRect(out float x, out float y, out float size)
        {
            size = S(52);
            x = _window.Width - S(20) - size;
            y = _window.Height - S(20) - size;
        }

        /// <summary>True if the mouse is over the sun icon.</summary>
        private bool HoverSunIcon(InputState input)
        {
            SunIconRect(out float x, out float y, out float size);
            return Hover(input, x, y, size, size);
        }

        /// <summary>
        /// Draws the sun icon: grey when shadows are off, amber when on; a click (cursor free) opens / closes the panel.
        /// </summary>
        private void BuildSunIcon(FontAtlas f, InputState input)
        {
            SunIconRect(out float x, out float y, out float size);
            bool on = ShadowsOn;
            bool hover = !_window.IsCaptured && Hover(input, x, y, size, size);
            uint colour = on ? UiTheme.SUN : hover ? UiTheme.TEXT : UiTheme.TEXT_MUTED;

            _ui.Rect(x, y, size, size, Rgba.Hex(0x0C0E12, _sunPanelOpen || hover ? 0.9f : 0.6f));
            _ui.Outline(x, y, size, size, S(2), _sunPanelOpen ? UiTheme.SUN : Rgba.Hex(0xFFFFFF, 0.14f));

            float cx = x + size * 0.5f, cy = y + size * 0.5f + S(2);
            _ui.Circle(cx, cy, S(7), colour, 16);
            for (int i = 0; i < 8; i++)
            {
                float a = i * MathF.PI / 4f;
                float c = MathF.Cos(a), s = MathF.Sin(a);
                _ui.Line(cx + c * S(10), cy + s * S(10), cx + c * S(14), cy + s * S(14), S(2), colour);
            }
            _ui.Text(f.Small, x + S(5), y + S(3), "O", on ? UiTheme.SUN : UiTheme.TEXT_FAINT);

            // Clicks only reach here while the cursor is free (panel open): the icon closes the panel
            if (_sunPanelOpen && hover && input.LeftPressed)
            {
                input.ConsumeClicks();
                CloseSunPanel();
            }
        }

        /// <summary>
        /// The sun dock (polish round P-A2: the right-hand dock column, the shared header, scrolling body and footer):
        /// place, shadows, quality, time, date, daylight saving, then the LIGHTING / SKY tabs. The location picker
        /// (CHANGE…) takes the dock's place while open.
        /// </summary>
        private void BuildSunPanel(FontAtlas f, InputState input)
        {
            if (!input.LeftDown) { _activeSlider = -1; }
            float w = S(UiTheme.DOCK_WIDTH);

            if (_locationOpen)
            {
                // Its own layout (laid out against its bottom): the column's height up to the old panel's
                DockColumn(w, out float lx, out float top, out float bottom);
                float lh = MathF.Min(S(624), bottom - top);
                if (lh < S(560) && _showMap)
                {
                    top = S(UiTheme.COLUMN_MARGIN); // too short under the minimap: over it (it hides)
                    _dockOverMapNext = true;
                    lh = MathF.Min(S(624), bottom - top);
                }
                _ui.Panel(lx, top, w, lh, UiTheme.PANEL_STRONG, Rgba.WithAlpha(UiTheme.SUN, 0.5f));
                RegisterFocusArea(lx, top, w, lh);
                BuildLocationPanel(f, input, lx, top, w, lh);
                return;
            }

            // A click anywhere outside a month / day box leaves it
            if (input.LeftPressed && _sunField != 0) { CommitSunField(); }

            DockFrame d = BeginDock("SUN, SHADOWS & LIGHTS", UiTheme.SUN_LABEL, Rgba.WithAlpha(UiTheme.SUN, 0.5f), w, _sunDockScroll, notice: false);
            float cy = BeginDockBody(d, _sunDockScroll, input);
            bool stay = BuildSunPanelBody(f, input, d.Ix, ref cy, d.Iw);
            EndDockBody(_sunDockScroll, input, cy);
            if (!stay) { return; } // CHANGE… or STUDY… left the dock
            if (EndDock(d, null, HINT_SUN_FOOT.Text) == DOCK_CLOSE) { CloseSunPanel(); }
        }

        /// <summary>The sun dock's body (from its first line; <paramref name="cy"/> ends at its bottom).</summary>
        /// <returns>False when a button left the dock (the location picker, the study).</returns>
        private bool BuildSunPanelBody(FontAtlas f, InputState input, float ix, ref float cy, float iw)
        {
            // Place: the location label, CHANGE… and STUDY…
            float changeW = S(78), studyW = S(70);
            uint placeColour = HasLocationOverride ? UiTheme.SUN : _locationKnown ? UiTheme.TEXT_MUTED : UiTheme.MEASURE_LABEL;
            _ui.TextWrapped(f.Small, ix, cy + S(3), iw - changeW - studyW - S(14), _sunPlaceLabel, placeColour, maxLines: 1);
            if (SmallButton(f, input, ix + iw - changeW, cy - S(2), changeW, S(22), "CHANGE…"))
            {
                OpenLocationPicker();
                return false;
            }
            // QOL round: hop to the sun / daylight study (it closes this panel)
            if (SmallButton(f, input, ix + iw - changeW - S(6) - studyW, cy - S(2), studyW, S(22), "STUDY…"))
            {
                OpenSunHours();
                return false;
            }
            cy += S(26);

            // Shadows on / off + quality
            bool enabled = Checkbox(f, input, ix, cy + S(6), S(110), "Shadows", _sun.Enabled);
            if (enabled != _sun.Enabled) { ToggleShadows(); }
            int quality = Segmented(f, input, ix + S(120), cy, iw - S(120), QUALITY_OPTIONS, (int)_shadowQuality);
            if (quality != (int)_shadowQuality)
            {
                _shadowQuality = (ShadowQuality)quality;
                ShadowMaps.Preset preset = ShadowMaps.PresetFor(_shadowQuality);
                Toast($"Shadow quality: {QUALITY_OPTIONS[quality]} ({preset.Cascades} × {preset.Size} px, {UnitFormat.Length(preset.Distance, 0)})");
            }
            cy += S(46);

            // Time of day: slider (5 min steps, Shift = 1 min) and play / pause
            int shownMinutes = _sunPlaying ? (int)_playMinutes : _sun.Time.Minutes;
            Text.Clear();
            AppendTwoDigits(shownMinutes / 60).Append(':');
            AppendTwoDigits(shownMinutes % 60);
            float playSize = S(28);
            float sliderW = iw - playSize - S(10);
            float value = Slider(f, input, SLIDER_TIME, ix, cy, sliderW, "Time of day", Text.Span, shownMinutes, 0f, 1439f);
            if (_activeSlider == SLIDER_TIME && input.LeftDown)
            {
                int step = input.Down(InputAction.FineAdjust) ? 1 : TIME_STEP;
                int minutes = Math.Clamp((int)MathF.Round(value / step) * step, 0, 1439);
                if (_sunPlaying) { _sunPlaying = false; }
                if (minutes != _sun.Time.Minutes)
                {
                    _sun.Time.Minutes = minutes;
                    SunChanged();
                }
            }
            if (PlayButton(input, ix + iw - playSize, cy + S(16), playSize)) { TogglePlay(); }
            cy += S(56);

            // Date: month / day boxes (type, Enter / Tab; ↑ ↓ step) and daylight saving
            _ui.Text(f.Body, ix, cy + S(6), "Date", UiTheme.TEXT);
            if (NumberBox(f, input, ix + S(52), cy, S(48), 1, _sun.Time.Month)) { FocusSunField(1); }
            _ui.Text(f.Small, ix + S(106), cy + S(8), MONTHS_UPPER[Math.Clamp(_sun.Time.Month, 1, 12) - 1], UiTheme.TEXT_MUTED);
            if (NumberBox(f, input, ix + S(142), cy, S(48), 2, _sun.Time.Day)) { FocusSunField(2); }
            if (_location.AutoDaylightSaving)
            {
                // The chosen place's time zone decides (per date); a click switches to the manual tick
                if (SmallButton(f, input, ix + S(204), cy, iw - S(204), S(30), SunDaylightSaving ? "DST AUTO: ON" : "DST AUTO: OFF"))
                {
                    SetLocationDaylightSavingAuto(false);
                }
            }
            else
            {
                bool zoned = _sun.Location?.ZoneId != null && TimeZones.TryFind(_sun.Location.ZoneId, out _);
                float tickW = iw - S(204) - (zoned ? S(50) : 0f);
                bool dst = Checkbox(f, input, ix + S(204), cy + S(6), tickW, "+1 h DST", _sun.Time.DaylightSaving);
                if (dst != _sun.Time.DaylightSaving)
                {
                    _sun.Time.DaylightSaving = dst;
                    SunChanged();
                }
                if (zoned && SmallButton(f, input, ix + iw - S(46), cy, S(46), S(30), "AUTO")) { SetLocationDaylightSavingAuto(true); }
            }
            cy += S(40);

            // Where the sun is
            BuildSunInfo();
            _ui.Text(f.Small, ix, cy, Text.Span, _sunAltitude > 0 ? UiTheme.TEXT_MUTED : UiTheme.MEASURE_LABEL, S(0.4f));
            cy += S(24);

            // Sky round (the tabs' line is the divider now): LIGHTING (intensities, lights) · SKY (clouds, the sun disc)
            int sunTab = Tabs(f, input, ix, cy, iw, SUN_TABS, _sunTab);
            if (sunTab != _sunTab)
            {
                _sunTab = sunTab;
                _activeSlider = -1;
            }
            cy += S(34);
            if (_sunTab == 1)
            {
                cy = BuildSkyTab(f, input, ix, cy, iw);
                return true;
            }
            if (_sunTab == 2)
            {
                cy = BuildNightTab(f, input, ix, cy, iw); // W-A
                return true;
            }

            // Intensities
            IntensitySlider(f, input, SLIDER_SUN, ix, cy, iw, "Sunlight", _sun.SunIntensity, 2f);
            cy += S(54);
            IntensitySlider(f, input, SLIDER_SKY, ix, cy, iw, "Sky / diffuse light", _sun.SkyIntensity, 2f);
            cy += S(54);
            IntensitySlider(f, input, SLIDER_SHADOW, ix, cy, iw, "Shadow intensity", _sun.ShadowIntensity, 1f);
            cy += S(54);
            IntensitySlider(f, input, SLIDER_GLASS, ix, cy, iw, "Light through glass", _sun.GlassTransmission, 2f);
            cy += S(54);

            // Artificial lights (saved with the settings, not the model). Reflections live in the pause menu.
            cy += BuildLightControls(f, input, ix, cy, iw);

            if (SmallButton(f, input, ix, cy, S(150), S(28), "RESET LIGHTING"))
            {
                _sun.SunIntensity = _sun.SkyIntensity = _sun.ShadowIntensity = _sun.GlassTransmission = 1f;
                _lightIntensity = _bloomIntensity = 1f;
                SunChanged();
            }
            _ui.TextRight(f.Small, ix + iw, cy + S(8), HINT_SUN_KEYS.Text, UiTheme.TEXT_FAINT, S(0.4f));
            cy += S(28);
            return true;
        }

        /// <summary>
        /// Sky round: the SKY tab: cloud cover and drift, the sun disc's size and glare (a look only), RESET SKY.
        /// </summary>
        /// <returns>The tab's bottom.</returns>
        private float BuildSkyTab(FontAtlas f, InputState input, float ix, float cy, float iw)
        {
            IntensitySlider(f, input, SLIDER_CLOUDS, ix, cy, iw, "Cloud cover", _sun.CloudCover, 1f);
            cy += S(54);
            IntensitySlider(f, input, SLIDER_CLOUD_SPEED, ix, cy, iw, "Cloud drift", _sun.CloudSpeed, 2f);
            cy += S(54);
            IntensitySlider(f, input, SLIDER_SUN_SIZE, ix, cy, iw, "Sun size", _sun.SunSize, 2f);
            cy += S(54);
            IntensitySlider(f, input, SLIDER_SUN_GLARE, ix, cy, iw, "Sun glare", _sun.SunGlare, 2f);
            cy += S(54);
            _ui.TextWrapped(f.Small, ix, cy, iw, "A look only: clouds and the sun disc don't change the lighting, shadows or studies. Saved with the model.",
                UiTheme.TEXT_FAINT, maxLines: 3);
            cy += S(52);
            if (SmallButton(f, input, ix, cy, S(150), S(28), "RESET SKY"))
            {
                _sun.CloudCover = 0f;
                _sun.CloudSpeed = _sun.SunSize = _sun.SunGlare = 1f;
                SunChanged();
            }
            return cy + S(28);
        }

        /// <summary>
        /// Round W-A: the NIGHT tab: the moon (on / off, phase real or chosen, moonlight; where it is and how lit) and the
        /// stars (on / off, density, brightness, twinkle, the Milky Way), RESET NIGHT.
        /// </summary>
        /// <returns>The tab's bottom.</returns>
        private float BuildNightTab(FontAtlas f, InputState input, float ix, float cy, float iw)
        {
            bool moon = Checkbox(f, input, ix, cy, iw, "Moon (its real place in the sky)", _sun.Moon);
            if (moon != _sun.Moon) { _sun.Moon = moon; SunChanged(); }
            cy += S(30);

            // Where it is and how lit (the real phase, or the chosen one)
            float lit = _sun.MoonPhase ?? _moonLit;
            Text.Clear().Append((long)MathF.Round(lit * 100f)).Append(" % lit");
            if (_sun.MoonPhase == null) { Text.Append(_moonWaxing ? ", waxing" : ", waning"); }
            if (_moonAltitude > 0.0)
            {
                Text.Append(" · ").Append((long)Math.Round(_moonAltitude)).Append("° up, ").Append(COMPASS[(int)Math.Round(_moonAzimuth / 45.0) & 7]);
            }
            else { Text.Append(" · below the horizon"); }
            _ui.Text(f.Small, ix, cy, Text.Span, _moonAltitude > 0.0 ? UiTheme.TEXT_MUTED : UiTheme.TEXT_FAINT, S(0.4f));
            cy += S(24);

            int shown = 0;
            if (_sun.MoonPhase is float chosen)
            {
                shown = 1;
                for (int i = 2; i < MOON_PHASE_VALUES.Length; i++)
                {
                    if (MathF.Abs(MOON_PHASE_VALUES[i] - chosen) < MathF.Abs(MOON_PHASE_VALUES[shown] - chosen)) { shown = i; }
                }
            }
            // Phase: Actual, then the four chosen phases as little moons (the full row width, so "Actual" fits)
            _ui.Text(f.Body, ix, cy, "Phase", UiTheme.TEXT_SOFT);
            Text.Clear().Append(MOON_PHASE_NAMES[shown]);
            if (shown > 0) { Text.Append(" · ").Append((long)MathF.Round(MOON_PHASE_VALUES[shown] * 100f)).Append(" % lit"); }
            _ui.TextRight(f.Small, ix + iw, cy + S(2), Text.Span, UiTheme.TEXT_MUTED);
            cy += S(22);
            int phase = Segmented(f, input, ix, cy, iw, MOON_PHASE_OPTIONS, shown);
            float segment = iw / MOON_PHASE_OPTIONS.Length;
            for (int i = 1; i < MOON_PHASE_OPTIONS.Length; i++)
            {
                DrawMoonIcon(ix + segment * (i + 0.5f), cy + S(16), S(8), MOON_PHASE_VALUES[i]);
            }
            if (phase != shown)
            {
                _sun.MoonPhase = phase == 0 ? null : MOON_PHASE_VALUES[phase];
                SunChanged();
            }
            cy += S(42);
            IntensitySlider(f, input, SLIDER_MOONLIGHT, ix, cy, iw, "Moonlight", _sun.MoonLight, 2f);
            cy += S(54);

            bool stars = Checkbox(f, input, ix, cy, iw, "Stars (turning with the sky)", _sun.Stars);
            if (stars != _sun.Stars) { _sun.Stars = stars; SunChanged(); }
            cy += S(32);
            if (_sun.Stars)
            {
                IntensitySlider(f, input, SLIDER_STAR_DENSITY, ix, cy, iw, "Star density", _sun.StarDensity, 2f);
                cy += S(54);
                IntensitySlider(f, input, SLIDER_STAR_BRIGHTNESS, ix, cy, iw, "Star brightness", _sun.StarBrightness, 2f);
                cy += S(54);
                IntensitySlider(f, input, SLIDER_STAR_TWINKLE, ix, cy, iw, "Twinkle", _sun.StarTwinkle, 2f);
                cy += S(54);
                IntensitySlider(f, input, SLIDER_MILKY_WAY, ix, cy, iw, "Milky Way", _sun.MilkyWay, 2f);
                cy += S(54);
            }
            _ui.TextWrapped(f.Small, ix, cy, iw, "Shows with shadows on once the sun is down. With the sun below the horizon the moon lights the scene and casts the shadows. Saved with the model.",
                UiTheme.TEXT_FAINT, maxLines: 3);
            cy += S(52);
            if (SmallButton(f, input, ix, cy, S(150), S(28), "RESET NIGHT"))
            {
                _sun.Moon = _sun.Stars = true;
                _sun.MoonPhase = null;
                _sun.MoonLight = _sun.StarDensity = _sun.StarBrightness = _sun.StarTwinkle = _sun.MilkyWay = 1f;
                SunChanged();
            }
            return cy + S(28);
        }

        /// <summary>
        /// Round W-A: a small moon at a lit fraction (lit on the right, as a waxing moon in the north): the dark disc,
        /// then the lit part row by row (each row lit from the terminator, an ellipse, to the edge). No font glyphs.
        /// </summary>
        private void DrawMoonIcon(float cx, float cy, float r, float lit)
        {
            _ui.Circle(cx, cy, r, Rgba.Hex(0x000000, 0.45f), 24);
            uint light = Rgba.Hex(0xF3F0E4);
            float step = MathF.Max(1f, UiScale);
            float k = Math.Clamp(lit, 0f, 1f);
            for (float y = -r + step * 0.5f; y < r; y += step)
            {
                float half = MathF.Sqrt(MathF.Max(r * r - y * y, 0f));
                float from = half * (1f - 2f * k);
                if (half - from > 0.25f) { _ui.Rect(cx + from, cy + y - step * 0.5f, half - from, step, light); }
            }
        }

        /// <summary>
        /// A 0–max percentage slider (5 % steps) for one of the sun settings; records a change when the value moves.
        /// </summary>
        private void IntensitySlider(FontAtlas f, InputState input, int id, float x, float y, float w, string label, float value, float max)
        {
            Text.Clear().Append((long)MathF.Round(value * 100f)).Append(" %");
            float result = Slider(f, input, id, x, y, w, label, Text.Span, value, 0f, max);
            result = MathF.Round(result * 20f) / 20f; // 5 % steps
            if (MathF.Abs(result - value) > 1e-4f)
            {
                // Assign before SunChanged so Clean() sees the new value
                switch (id)
                {
                    case SLIDER_SUN: _sun.SunIntensity = result; break;
                    case SLIDER_SKY: _sun.SkyIntensity = result; break;
                    case SLIDER_SHADOW: _sun.ShadowIntensity = result; break;
                    case SLIDER_GLASS: _sun.GlassTransmission = result; break;
                    case SLIDER_CLOUDS: _sun.CloudCover = result; break;
                    case SLIDER_CLOUD_SPEED: _sun.CloudSpeed = result; break;
                    case SLIDER_SUN_SIZE: _sun.SunSize = result; break;
                    case SLIDER_SUN_GLARE: _sun.SunGlare = result; break;
                    case SLIDER_MOONLIGHT: _sun.MoonLight = result; break; // W-A
                    case SLIDER_STAR_DENSITY: _sun.StarDensity = result; break;
                    case SLIDER_STAR_BRIGHTNESS: _sun.StarBrightness = result; break;
                    case SLIDER_STAR_TWINKLE: _sun.StarTwinkle = result; break;
                    case SLIDER_MILKY_WAY: _sun.MilkyWay = result; break;
                }
                SunChanged();
            }
        }

        /// <summary>
        /// A small numeric text box (month or day). Shows the typed digits and a caret while focused.
        /// </summary>
        /// <returns>True when clicked (to focus it).</returns>
        private bool NumberBox(FontAtlas f, InputState input, float x, float y, float w, int field, int value)
        {
            float h = S(30);
            bool focused = _sunField == field;
            bool hover = Hover(input, x, y, w, h);
            _ui.Rect(x, y, w, h, focused ? Rgba.Hex(0xFFFFFF, 0.08f) : UiTheme.CONTROL);
            _ui.Outline(x, y, w, h, MathF.Max(1f, UiScale), focused ? UiTheme.SUN : hover ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);

            float textY = y + h * 0.5f - f.Mono.LineHeight * 0.5f;
            if (focused)
            {
                float used = _ui.Text(f.Mono, x + S(10), textY, _sunFieldChars.AsSpan(0, _sunFieldLength), UiTheme.TEXT);
                if ((_clock % 1f) < 0.55f) { _ui.Rect(x + S(11) + used, y + S(7), S(1.5f), h - S(14), UiTheme.SUN); }
            }
            else
            {
                Text.Clear();
                AppendTwoDigits(value);
                _ui.Text(f.Mono, x + S(10), textY, Text.Span, UiTheme.TEXT);
            }

            bool clicked = hover && input.LeftPressed;
            if (clicked)
            {
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
            }
            return clicked;
        }

        /// <summary>
        /// Play / pause toggle (triangle or two bars).
        /// </summary>
        private bool PlayButton(InputState input, float x, float y, float size)
        {
            bool hover = Hover(input, x, y, size, size);
            bool enabled = _sun.Enabled;
            uint colour = !enabled ? UiTheme.TEXT_FAINT : hover || _sunPlaying ? UiTheme.SUN : UiTheme.TEXT;
            _ui.Rect(x, y, size, size, hover && enabled ? Rgba.Hex(0xFFFFFF, 0.1f) : UiTheme.CONTROL);
            _ui.Outline(x, y, size, size, MathF.Max(1f, UiScale), UiTheme.CONTROL_BORDER);

            float cx = x + size * 0.5f, cy = y + size * 0.5f, r = size * 0.26f;
            if (_sunPlaying)
            {
                _ui.Rect(cx - r, cy - r, r * 0.7f, r * 2f, colour);
                _ui.Rect(cx + r * 0.3f, cy - r, r * 0.7f, r * 2f, colour);
            }
            else
            {
                _ui.Triangle(cx - r * 0.8f, cy - r, cx - r * 0.8f, cy + r, cx + r, cy, colour);
            }

            bool clicked = enabled && hover && input.LeftPressed;
            if (clicked)
            {
                input.ConsumeClicks();
            }
            return clicked;
        }

        /// <summary>
        /// Writes "SUN 42° HIGH · BEARING 310° (NW, TRUE NORTH)" or "SUN BELOW THE HORIZON" into <see cref="Text"/>
        /// (no allocation: it changes every frame while playing).
        /// </summary>
        private void BuildSunInfo()
        {
            int alt = (int)Math.Round(_sunAltitude), az = (int)Math.Round(_sunAzimuth) % 360;
            if (alt <= 0)
            {
                Text.Clear().Append("SUN BELOW THE HORIZON (").Append((float)alt, 0).Append("°) · SKY LIGHT ONLY");
                return;
            }
            Text.Clear().Append("SUN ").Append(alt).Append("° HIGH · BEARING ").Append(az).Append("° (")
                .Append(COMPASS[(int)Math.Round(az / 45.0) % 8]).Append(", TRUE NORTH)");
        }

        private TextBuffer AppendTwoDigits(int value)
        {
            value = Math.Clamp(value, 0, 99);
            return Text.Append((char)('0' + value / 10)).Append((char)('0' + value % 10));
        }

        #endregion
    }
}
