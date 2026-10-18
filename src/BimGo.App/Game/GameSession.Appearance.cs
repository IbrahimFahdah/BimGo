using BimGo.Audio;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// QOL round: the pause menu's Appearance tab (was Debug): colour-by modes (reflection tier, probe; colour round A:
    /// the Colour profiles row opens the COLOUR PROFILES panel) and the material overrides (water by Revit asset / keywords, glass keywords for the next
    /// Go). Grass round: WATER and GRASS sub-pages (water colour and reflection; grass blades). Also the options
    /// preview: the scene without the backdrop, only the graphics settings showing.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>Colour-by modes: off, reflection tiers, reflection probe cells (not saved).</summary>
        private static readonly string[] COLOUR_BY_OPTIONS = { "Off", "Reflection", "Probes" };

        /// <summary>Grass round: the water colour presets' labels (<see cref="MaterialOverrides.WATER_PRESETS"/> order).</summary>
        private static readonly string[] WATER_COLOUR_OPTIONS = MaterialOverrides.WATER_PRESETS.Select(p => p.Label).ToArray();

        /// <summary>Grass round: blade densities.</summary>
        private static readonly string[] GRASS_DENSITY_OPTIONS = { "Low", "Medium", "High" };

        /// <summary>Longest keyword list typed in the session.</summary>
        private const int MAX_KEYWORD_TEXT = 200;

        /// <summary>Slider ids (unique across the menu's sliders).</summary>
        private const int SLIDER_WATER_REFLECT = 24, SLIDER_GRASS_HEIGHT = 25, SLIDER_GRASS_DISTANCE = 26;

        /// <summary>Water round W: slider ids (ripple strength, ripple speed, grass sway, wave size).</summary>
        private const int SLIDER_WATER_RIPPLE = 27, SLIDER_WATER_SPEED = 28, SLIDER_GRASS_SWAY = 29, SLIDER_WAVE_SCALE = 30;

        /// <summary>How much a picked water colour replaces the material's (a little of a texture's pattern stays).</summary>
        private const float WATER_TINT_AMOUNT = 0.85f;

        // Water / glass overrides (per machine, saved with the settings)
        private bool _waterFromAsset = true;
        private List<string> _waterKeywords = LaunchSettings.DefaultWaterKeywords();
        private bool _waterKeywordsOpaque;
        private List<string> _glassKeywords = new();
        private List<string> _grassKeywords = LaunchSettings.DefaultGrassKeywords();
        private string _waterColour = string.Empty;
        private float _waterReflection = 1f;

        // Water round W: ripple strength and speed (0–2, 1 = as before), and the clock the ripples run on
        private float _waterRipple = 1f;
        private float _waterRippleSpeed = 1f;
        private float _waterWaveScale = 1f;
        private float _waterClock;

        // The glass keywords this snapshot was made with (changes show "next Go")
        private string _glassKeywordsAtLoad = string.Empty;

        // Options preview: the scene shows through, only the graphics settings are drawn (Esc returns)
        private bool _menuPreview;

        // Grass round: the Appearance tab's page: 0 main, 1 water, 2 grass (per session)
        private int _appearancePage;

        #endregion

        #region Settings

        /// <summary>
        /// Reads the overrides from the snapshot's settings (constructor).
        /// </summary>
        private void ReadAppearanceSettings(LaunchSettings settings)
        {
            _waterFromAsset = settings.WaterFromAsset;
            _waterKeywords = MaterialOverrides.CleanKeywords(settings.WaterKeywords ?? LaunchSettings.DefaultWaterKeywords());
            _waterKeywordsOpaque = settings.WaterKeywordsOpaque;
            _glassKeywords = MaterialOverrides.CleanKeywords(settings.GlassKeywords);
            _grassKeywords = MaterialOverrides.CleanKeywords(settings.GrassKeywords ?? LaunchSettings.DefaultGrassKeywords());
            _glassKeywordsAtLoad = MaterialOverrides.FormatKeywords(_glassKeywords);
            _waterColour = LaunchSettings.TryParseColour(settings.WaterColour, out _) ? settings.WaterColour : string.Empty;
            _waterReflection = float.IsFinite(settings.WaterReflection) ? Math.Clamp(settings.WaterReflection, 0f, 1f) : 1f;
            _waterRipple = LaunchSettings.CleanLookScale(settings.WaterRipple);
            _waterRippleSpeed = LaunchSettings.CleanLookScale(settings.WaterRippleSpeed);
            _waterWaveScale = LaunchSettings.CleanWaveScale(settings.WaterWaveScale);
            ReadGrassSettings(settings);
        }

        /// <summary>
        /// Writes the overrides for next time (session end).
        /// </summary>
        private void WriteAppearanceSettings(LaunchSettings settings)
        {
            settings.WaterFromAsset = _waterFromAsset;
            settings.WaterKeywords = new List<string>(_waterKeywords);
            settings.WaterKeywordsOpaque = _waterKeywordsOpaque;
            settings.GlassKeywords = new List<string>(_glassKeywords);
            settings.GrassKeywords = new List<string>(_grassKeywords);
            settings.WaterColour = _waterColour;
            settings.WaterReflection = _waterReflection;
            settings.WaterRipple = _waterRipple;
            settings.WaterRippleSpeed = _waterRippleSpeed;
            settings.WaterWaveScale = _waterWaveScale;
            WriteGrassSettings(settings);
        }

        /// <summary>
        /// Passes the water rule to the renderer (before its Initialise: sets the rule; after: rebuilds the table).
        /// </summary>
        private void ApplyWaterOverride()
        {
            _renderer?.SetWaterOverride(_waterFromAsset, _waterKeywords, _waterKeywordsOpaque);
            ApplyWaterLook();
        }

        /// <summary>
        /// Grass round: water's colour and reflection strength for the renderer (uniforms: no rebuild).
        /// </summary>
        private void ApplyWaterLook()
        {
            if (_renderer == null) { return; }
            if (LaunchSettings.TryParseColour(_waterColour, out uint rgb))
            {
                _renderer.WaterTint = new System.Numerics.Vector4(((rgb >> 16) & 0xFF) / 255f, ((rgb >> 8) & 0xFF) / 255f, (rgb & 0xFF) / 255f, WATER_TINT_AMOUNT);
            }
            else { _renderer.WaterTint = default; }
            _renderer.WaterReflect = _waterReflection;
            _renderer.WaterWaves = _waterRipple;
            _renderer.WaveScale = _waterWaveScale;
        }

        /// <summary>
        /// Water round W: once a frame, moves the ripples' clock on at the ripple speed (0 = they stand still) and
        /// hands it to the renderer. Wrapped every hour of water time so the float keeps its precision (the waves
        /// jump once an hour, at most).
        /// </summary>
        private void AdvanceWater(float dt)
        {
            _waterClock += dt * _waterRippleSpeed;
            if (_waterClock > 3600f) { _waterClock -= 3600f; }
            if (_renderer != null) { _renderer.WaterClock = _waterClock; }
        }

        #endregion

        #region Appearance tab

        /// <summary>
        /// Appearance tab (was Debug): colour by, then the material overrides (water and grass on their own pages).
        /// </summary>
        private void BuildAppearanceTab(FontAtlas f, InputState input, float ix, float y, float iw)
        {
            if (_appearancePage == 1)
            {
                BuildWaterPage(f, input, ix, y, iw);
                return;
            }
            if (_appearancePage == 2)
            {
                BuildGrassPage(f, input, ix, y, iw);
                return;
            }

            // ---- Colour by (debug colours; colour round A: colour profiles by value or search set, their own panel)
            _ui.Text(f.Small, ix, y, "COLOUR BY", UiTheme.TEXT_MUTED, S(1.8f));
            int mode = Segmented(f, input, ix, y + S(20), iw, COLOUR_BY_OPTIONS, _reflectDebug);
            if (mode != _reflectDebug)
            {
                _reflectDebug = mode;
                if (mode != 0 && (!_realistic || _renderer == null || !_renderer.HasMaterials))
                {
                    Toast("Colour by reflection / probe needs the Realistic colour mode and a snapshot with materials.", 4f);
                }
            }
            y += S(60);
            string help = _reflectDebug switch
            {
                1 => "Red 75 %+, orange 50 %, yellow 25 %, grey none, cyan glass, blue water.",
                2 => "One colour per reflection probe, blended at room edges; grey = sky.",
                _ => "Colours surfaces by reflection tier or probe (Realistic mode). Not saved."
            };
            y += _ui.TextWrapped(f.Small, ix, y, iw, help, UiTheme.TEXT_MUTED, maxLines: 3) + S(6);
            if (PageRow(f, input, ix, y, iw, "Colour profiles", ColourProfileSummary()))
            {
                Sound.Play(SoundId.UiClick);
                OpenColourProfiles();
                return;
            }
            y += S(44);

            // ---- Material overrides
            _ui.Text(f.Small, ix, y, "MATERIAL OVERRIDES", UiTheme.TEXT_MUTED, S(1.8f));
            y += S(26);

            // Water (its own page)
            Text.Clear();
            if (_renderer != null && _renderer.HasMaterials) { Text.Append(_renderer.WaterMaterialCount).Append(" · "); }
            int preset = MaterialOverrides.WaterPresetIndex(_waterColour);
            Text.Append(preset >= 0 ? WATER_COLOUR_OPTIONS[preset] : _waterColour).Append(" · ").Append((long)MathF.Round(_waterReflection * 100f)).Append(" %");
            if (_waterRipple <= 0f) { Text.Append(" · still"); }
            if (PageRow(f, input, ix, y, iw, "Water", Text.Span)) { OpenAppearancePage(1); }
            y += S(30);

            // Grass (its own page)
            Text.Clear();
            if (!_grassBlades) { Text.Append("Off"); }
            else
            {
                Text.Append(GRASS_DENSITY_OPTIONS[Math.Clamp(_grassDensity, 0, 2)]).Append(" · ").Append(_grassHeightMm).Append(" mm · ").Append(_grassDistance).Append(" m");
            }
            if (PageRow(f, input, ix, y, iw, "Grass blades", Text.Span)) { OpenAppearancePage(2); }
            y += S(34);

            // Glass (baked at Go)
            if (KeywordRow(f, input, ix, y, iw, "Glass keywords", _glassKeywords))
            {
                BeginTextEdit("GLASS KEYWORDS (TAKE EFFECT AT THE NEXT GO / EXPORT)", MaterialOverrides.FormatKeywords(_glassKeywords), MAX_KEYWORD_TEXT, text =>
                {
                    _glassKeywords = MaterialOverrides.ParseKeywords(text);
                    if (MaterialOverrides.FormatKeywords(_glassKeywords) != _glassKeywordsAtLoad)
                    {
                        Toast("Glass keywords saved: see-through is baked into the snapshot, so they apply at the next Go / Export.", 5f);
                    }
                });
            }
            y += S(22);
            bool glassPending = MaterialOverrides.FormatKeywords(_glassKeywords) != _glassKeywordsAtLoad;
            _ui.Text(f.Small, ix, y, glassPending ? "Changed: applies at the next Go / Export" : "Applies at Go / Export (baked)",
                glassPending ? UiTheme.MEASURE_LABEL : UiTheme.TEXT_FAINT);
            y += S(30);

            // Polish round P-A1: the window-size check (layouts at 720p / 1080p / 1440p)
            BuildWindowCheckRow(f, input, ix, y, iw);
        }

        /// <summary>Grass round: switches the Appearance tab to a page (0 main, 1 water, 2 grass).</summary>
        private void OpenAppearancePage(int page)
        {
            _appearancePage = page;
            _activeSlider = -1;
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>
        /// A page's heading with BACK on the right.
        /// </summary>
        /// <returns>The y below it.</returns>
        private float PageHeader(FontAtlas f, InputState input, float x, float y, float w, string title)
        {
            _ui.Text(f.Small, x, y + S(4), title, UiTheme.ACCENT, S(1.8f));
            if (SmallButton(f, input, x + w - S(70), y, S(70), S(24), "‹ BACK")) { OpenAppearancePage(0); }
            return y + S(36);
        }

        /// <summary>
        /// A label with a summary on the right and a chevron; a click opens its page.
        /// </summary>
        /// <returns>True when clicked.</returns>
        private bool PageRow(FontAtlas f, InputState input, float x, float y, float w, string label, ReadOnlySpan<char> summary)
        {
            bool hover = Hover(input, x, y - S(4), w, S(26));
            if (hover) { _ui.Rect(x - S(4), y - S(4), w + S(8), S(26), Rgba.Hex(0xFFFFFF, 0.06f)); }
            _ui.Text(f.Body, x, y, label, hover ? UiTheme.ACCENT : UiTheme.TEXT);
            _ui.TextRight(f.Small, x + w - S(16), y + S(2), summary, Rgba.Hex(0x67E8F9));
            _ui.Text(f.Body, x + w - S(10), y, "›", hover ? UiTheme.ACCENT : UiTheme.TEXT_MUTED);
            if (hover && input.LeftPressed)
            {
                input.ConsumeClicks();
                return true;
            }
            return false;
        }

        /// <summary>
        /// Grass round: the WATER page: which materials are water, its colour and how much it reflects.
        /// </summary>
        private void BuildWaterPage(FontAtlas f, InputState input, float ix, float y, float iw)
        {
            y = PageHeader(f, input, ix, y, iw, "WATER");

            bool fromAsset = Checkbox(f, input, ix, y, iw, "Water from Revit asset", _waterFromAsset);
            if (fromAsset != _waterFromAsset)
            {
                _waterFromAsset = fromAsset;
                WaterOverrideChanged();
            }
            y += S(28);
            if (KeywordRow(f, input, ix, y, iw, "Water keywords", _waterKeywords))
            {
                BeginTextEdit("WATER KEYWORDS (COMMA SEPARATED)", MaterialOverrides.FormatKeywords(_waterKeywords), MAX_KEYWORD_TEXT, text =>
                {
                    _waterKeywords = MaterialOverrides.ParseKeywords(text);
                    WaterOverrideChanged();
                });
            }
            y += S(28);
            bool opaque = Checkbox(f, input, ix, y, iw, "Keywords match opaque too", _waterKeywordsOpaque);
            if (opaque != _waterKeywordsOpaque)
            {
                _waterKeywordsOpaque = opaque;
                WaterOverrideChanged();
            }
            y += S(36);

            // Colour: Revit's (the material's own) or a preset; CUSTOM… types a hex colour
            _ui.Text(f.Body, ix, y, "Colour", UiTheme.TEXT);
            if (_waterColour.Length > 0 && LaunchSettings.TryParseColour(_waterColour, out uint rgb))
            {
                _ui.Rect(ix + S(62), y + S(1), S(28), S(16), Rgba.Hex(rgb));
                _ui.Outline(ix + S(62), y + S(1), S(28), S(16), MathF.Max(1f, UiScale), UiTheme.CONTROL_BORDER);
            }
            if (SmallButton(f, input, ix + iw - S(84), y - S(4), S(84), S(24), "CUSTOM…"))
            {
                BeginTextEdit("WATER COLOUR (#RRGGBB, EMPTY = THE MATERIAL'S OWN)", _waterColour, 7, text =>
                {
                    string value = (text ?? string.Empty).Trim();
                    if (value.Length == 0) { SetWaterColour(string.Empty); }
                    else if (LaunchSettings.TryParseColour(value, out _)) { SetWaterColour("#" + value.TrimStart('#').ToUpperInvariant()); }
                    else { Toast("Type a colour as #RRGGBB (e.g. #3B9AA6), or leave it empty for the material's own", 4f); }
                });
            }
            int preset = MaterialOverrides.WaterPresetIndex(_waterColour);
            int picked = Segmented(f, input, ix, y + S(24), iw, WATER_COLOUR_OPTIONS, preset);
            if (picked != preset && picked >= 0) { SetWaterColour(MaterialOverrides.WATER_PRESETS[picked].Hex); }
            y += S(68);

            // Two sliders a row (the four would run past the card): reflection | ripples, ripple speed | wave size
            float half = (iw - S(16)) * 0.5f, ix2 = ix + half + S(16);

            // Reflection strength
            Text.Clear().Append((long)MathF.Round(_waterReflection * 100f)).Append(" %");
            float reflect = Slider(f, input, SLIDER_WATER_REFLECT, ix, y, half, "Reflection", Text.Span, _waterReflection, 0f, 1f);
            reflect = MathF.Round(reflect * 20f) / 20f;
            if (MathF.Abs(reflect - _waterReflection) > 1e-4f)
            {
                _waterReflection = reflect;
                ApplyWaterLook();
            }

            // Water round W: ripple strength (0 = still water, the waves are skipped) and speed (0 = frozen ripples)
            Text.Clear();
            if (_waterRipple <= 0f) { Text.Append("Still"); }
            else { Text.Append((long)MathF.Round(_waterRipple * 100f)).Append(" %"); }
            float ripple = Slider(f, input, SLIDER_WATER_RIPPLE, ix2, y, half, "Ripples", Text.Span, _waterRipple, 0f, LaunchSettings.MAX_LOOK_SCALE);
            ripple = LaunchSettings.CleanLookScale(ripple);
            if (MathF.Abs(ripple - _waterRipple) > 1e-4f)
            {
                _waterRipple = ripple;
                ApplyWaterLook();
            }
            y += S(58);

            Text.Clear();
            if (_waterRippleSpeed <= 0f) { Text.Append("Paused"); }
            else { Text.Append((long)MathF.Round(_waterRippleSpeed * 100f)).Append(" %"); }
            float speed = Slider(f, input, SLIDER_WATER_SPEED, ix, y, half, "Ripple speed", Text.Span, _waterRippleSpeed, 0f, LaunchSettings.MAX_LOOK_SCALE);
            _waterRippleSpeed = LaunchSettings.CleanLookScale(speed);

            // Wave size: the wavelengths × it (25 % fine chop … 400 % long swell); strength unchanged
            Text.Clear().Append((long)MathF.Round(_waterWaveScale * 100f)).Append(" %");
            float scale = Slider(f, input, SLIDER_WAVE_SCALE, ix2, y, half, "Wave size", Text.Span, _waterWaveScale, LaunchSettings.MIN_WAVE_SCALE, LaunchSettings.MAX_WAVE_SCALE);
            scale = LaunchSettings.CleanWaveScale(scale);
            if (MathF.Abs(scale - _waterWaveScale) > 1e-4f)
            {
                _waterWaveScale = scale;
                ApplyWaterLook();
            }
            y += S(58);

            Text.Clear();
            if (_renderer == null || !_renderer.HasMaterials) { Text.Append("Needs a snapshot with materials (Realistic)."); }
            else { Text.Append(_renderer.WaterMaterialCount).Append(" water materials. Less reflection shows more of the colour."); }
            _ui.TextWrapped(f.Small, ix, y, iw, Text.Span, UiTheme.TEXT_FAINT, maxLines: 3);
        }

        /// <summary>Grass round: a new water colour (#RRGGBB or empty), shown at once.</summary>
        private void SetWaterColour(string hex)
        {
            _waterColour = hex ?? string.Empty;
            ApplyWaterLook();
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>
        /// Grass round: the GRASS page: blades on / off, density, height, distance, keywords and what was found.
        /// </summary>
        private void BuildGrassPage(FontAtlas f, InputState input, float ix, float y, float iw)
        {
            y = PageHeader(f, input, ix, y, iw, "GRASS BLADES");

            bool on = Checkbox(f, input, ix, y, iw, "Grass blades (Realistic mode)", _grassBlades);
            if (on != _grassBlades)
            {
                _grassBlades = on;
                if (on && (!_realistic || _renderer == null || !_renderer.HasMaterials))
                {
                    Toast("Grass blades show in the Realistic colour mode, on a snapshot with materials.", 4f);
                }
            }
            y += S(32);

            _ui.Text(f.Body, ix, y, "Density", UiTheme.TEXT);
            int density = Segmented(f, input, ix, y + S(22), iw, GRASS_DENSITY_OPTIONS, _grassDensity);
            if (density != _grassDensity) { _grassDensity = density; }
            y += S(64);

            Text.Clear().Append(_grassHeightMm).Append(" mm");
            float height = Slider(f, input, SLIDER_GRASS_HEIGHT, ix, y, iw, "Blade height", Text.Span, _grassHeightMm, LaunchSettings.MIN_GRASS_HEIGHT, LaunchSettings.MAX_GRASS_HEIGHT);
            if (_activeSlider == SLIDER_GRASS_HEIGHT) { _grassHeightMm = (int)(MathF.Round(height / 10f) * 10f); }
            y += S(56);

            Text.Clear().Append(_grassDistance).Append(" m");
            float distance = Slider(f, input, SLIDER_GRASS_DISTANCE, ix, y, iw, "Distance", Text.Span, _grassDistance, LaunchSettings.MIN_GRASS_DISTANCE, LaunchSettings.MAX_GRASS_DISTANCE);
            if (_activeSlider == SLIDER_GRASS_DISTANCE) { _grassDistance = (int)(MathF.Round(distance / 5f) * 5f); }
            y += S(58);

            // Water round W: sway (a look only: the cost is the same at any value)
            Text.Clear();
            if (_grassSway <= 0f) { Text.Append("Off (still)"); }
            else { Text.Append((long)MathF.Round(_grassSway * 100f)).Append(" %"); }
            float sway = Slider(f, input, SLIDER_GRASS_SWAY, ix, y, iw, "Sway", Text.Span, _grassSway, 0f, LaunchSettings.MAX_LOOK_SCALE);
            _grassSway = LaunchSettings.CleanLookScale(sway);
            y += S(58);

            if (KeywordRow(f, input, ix, y, iw, "Grass keywords", _grassKeywords))
            {
                BeginTextEdit("GRASS KEYWORDS (COMMA SEPARATED)", MaterialOverrides.FormatKeywords(_grassKeywords), MAX_KEYWORD_TEXT, text =>
                {
                    _grassKeywords = MaterialOverrides.ParseKeywords(text);
                    Toast("Grass keywords changed: finding the grass again…", 2.5f);
                });
            }
            y += S(28);
            _ui.TextWrapped(f.Small, ix, y, iw, GrassStatus(), UiTheme.TEXT_FAINT, maxLines: 3);
        }

        /// <summary>
        /// A label with its keyword list (shortened to fit) on the right; a click edits it.
        /// </summary>
        /// <returns>True when clicked.</returns>
        private bool KeywordRow(FontAtlas f, InputState input, float x, float y, float w, string label, List<string> keywords)
        {
            bool hover = Hover(input, x, y - S(3), w, S(24));
            float labelW = _ui.Text(f.Body, x, y, label, hover ? UiTheme.ACCENT : UiTheme.TEXT);
            string value = keywords.Count == 0 ? "none" : MaterialOverrides.FormatKeywords(keywords);
            float room = w - labelW - S(12);
            if (UiBatch.Measure(f.Small, value) > room)
            {
                int n = value.Length;
                while (n > 1 && UiBatch.Measure(f.Small, value.AsSpan(0, n)) + UiBatch.Measure(f.Small, "...") > room) { n--; }
                value = value.Substring(0, n) + "...";
            }
            _ui.TextRight(f.Small, x + w, y + S(2), value, keywords.Count == 0 ? UiTheme.TEXT_FAINT : Rgba.Hex(0x67E8F9));
            if (hover && input.LeftPressed)
            {
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
                return true;
            }
            return false;
        }

        /// <summary>
        /// The water rule changed: rebuilds the material table and says how many materials are water now.
        /// </summary>
        private void WaterOverrideChanged()
        {
            ApplyWaterOverride();
            if (_renderer == null || !_renderer.HasMaterials)
            {
                Toast("Saved for next time: water overrides need a snapshot with materials (Extract materials and textures at Go).", 4f);
                return;
            }
            Toast($"Water materials: {_renderer.WaterMaterialCount}", 2f);
        }

        #endregion

        #region Options preview

        /// <summary>
        /// Leaves the options preview (Esc): back to the full pause menu.
        /// </summary>
        /// <returns>True when the preview was open.</returns>
        private bool CloseMenuPreview()
        {
            if (!_menuPreview) { return false; }
            _menuPreview = false;
            _activeSlider = -1;
            return true;
        }

        /// <summary>
        /// The options preview: no backdrop, no buttons, only the quality profile and the Display / Reflections /
        /// Appearance card on a light panel, so the scene behind can be judged while tuning.
        /// </summary>
        private void BuildMenuPreview(FontAtlas f, InputState input, int width, int height)
        {
            // Polish round P-A1: the card's height comes from the window (it scrolls when short), DONE always fits under it
            float columnW = S(280), pad = S(48);
            float x = width - S(56) - columnW;
            float cardTop = pad + S(68) + S(32), doneReserve = S(12) + S(36);
            float cardH = SettingsCardHeight(cardTop, doneReserve);
            float panelTop = pad - S(36), panelBottom = cardTop + cardH + doneReserve + S(12);
            _ui.Rect(x - S(16), panelTop, columnW + S(32), MathF.Min(panelBottom, height - S(8)) - panelTop, Rgba.Hex(0x101318, 0.55f));

            _ui.Text(f.Small, x, panelTop + S(10), "PREVIEW", UiTheme.ACCENT, S(2f));
            _ui.TextRight(f.Small, x + columnW, panelTop + S(10), "ESC RETURNS", UiTheme.TEXT_MUTED, S(1.2f));
            BuildProfileRow(f, input, x, pad, columnW);
            cardH = BuildSettingsTabs(f, input, x, pad + S(68), columnW, doneReserve);

            float doneY = cardTop + cardH + S(12);
            if (MenuButton(f, x, doneY, columnW, "DONE", false, false, height: S(36), compact: true)) { CloseMenuPreview(); }
        }

        #endregion
    }
}
