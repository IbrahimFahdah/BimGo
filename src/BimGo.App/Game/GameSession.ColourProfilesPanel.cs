using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Colour round A: the COLOUR PROFILES panel (pause menu → Appearance → Colour profiles; in place of the pause menu,
    /// on the right so the model shows beside it). Left: the profiles (the selected one is the active one), NEW BY VALUE,
    /// NEW BY SET, DUPLICATE, DELETE. Right: the active profile: its name, the field (by value: built-ins, then the
    /// extracted parameters) or EDIT SETS… (by set), how the others look (ghosted / normal / flat colour), how much
    /// surface detail shows under the colour, the palette, and its rows: on / off, colour (the Windows colour picker),
    /// label and count; by set, each row's set is a dropdown and rows can be added and removed; by value, REFRESH VALUES
    /// adds values new to the model. SHOW and LEGEND switch the profile and its legend on and off.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private static readonly string[] PROFILE_KIND_LABELS = { "BY VALUE", "BY SEARCH SET" };

        // Texts naming the colour profile key (rebuilt only when a binding changes)
        private static readonly KeyHint HINT_PROFILE_FOOTER = new(() =>
            $"{Hotkeys.Label(InputAction.ColourProfile)}: show / hide while walking and in clash mode · extra parameters: Revit Options → Parameters");
        private static readonly KeyHint HINT_PROFILE_EMPTY = new(() =>
            "No colour profiles yet. NEW BY VALUE colours elements by a field or an extracted parameter (one colour per value); " +
            "NEW BY SET colours clash detection's search sets (the first set an element is in wins). " +
            $"{Hotkeys.Label(InputAction.ColourProfile)} shows or hides the active profile while walking and in clash mode.");

        // Dropdown slots
        private const int DROP_PROFILE_FIELD = 40, DROP_PROFILE_PALETTE = 41, DROP_PROFILE_SET = 42, DROP_PROFILE_ADD_SET = 43;
        private const int DROP_PROFILE_TRANSPARENCY = 44, DROP_PROFILE_RAMP = 45;

        // Colour round B: each value or number ranges; a row's transparency choices (0–90 %)
        private static readonly string[] PROFILE_VALUE_MODES = { "Each value", "Ranges" };
        private static readonly string[] PROFILE_TRANSPARENCY_LABELS = { "0 %", "10 %", "20 %", "30 %", "40 %", "50 %", "60 %", "70 %", "80 %", "90 %" };

        // Colour round B: export (1 this profile, 2 all) and import, run after the overlays draw (file dialogs)
        private int _profilePendingExport;
        private bool _profilePendingImport;

        // Slider id (unique across the menu's sliders)
        private const int SLIDER_PROFILE_DETAIL = 70;

        private bool _profilesOpen;
        private readonly ScrollRegion _profileListScroll = new(), _profileRowScroll = new(); // polish round P-A1

        // EDIT SETS… came from here: the CLASHES panel returns here when it closes
        private bool _profilesReturnFromClashes;

        // A colour pick waiting for the overlays to finish drawing (the picker is a modal dialog): a row, or the others
        private ProfileRule _profilePickRule;
        private bool _profilePickOthers;

        // The field dropdown's choices (field, parameter), filled when it opens
        private readonly List<(string Field, string Parameter)> _profileFieldChoices = new();

        #endregion

        #region Open / close

        /// <summary>True while the colour profiles panel is showing (it replaces the pause menu).</summary>
        private bool IsColourProfilesPanelOpen => _profilesOpen;

        /// <summary>Opens the panel (the counts are worked out again).</summary>
        private void OpenColourProfiles()
        {
            if (!_paused) { SetPaused(true); }
            _profilesOpen = true;
            _profileRowScroll.Reset();
            _profileDirty = true;
            _activeSlider = -1;
            CloseOverlay();
        }

        /// <summary>Esc / CLOSE: an open dropdown or confirm closes first, then the panel.</summary>
        /// <returns>True if something closed.</returns>
        private bool CloseColourProfiles()
        {
            if (!_profilesOpen) { return false; }
            if (CloseOverlay()) { return true; }
            _profilesOpen = false;
            _activeSlider = -1;
            return true;
        }

        /// <summary>The Appearance tab's row text: the active profile and whether it shows (in <see cref="Text"/>: no allocation).</summary>
        private ReadOnlySpan<char> ColourProfileSummary()
        {
            Text.Clear();
            AppearanceProfile profile = ActiveProfile;
            if (profile == null) { return Text.Append("none").Span; }
            return Text.Append(profile.Name).Append(_appearance.On ? " · on" : " · off").Span;
        }

        #endregion

        #region Panel

        /// <summary>Draws and handles the panel.</summary>
        private void BuildColourProfilesPanel()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            if (!input.LeftDown) { _activeSlider = -1; }

            // The side card: the model shows on the left (lightly dimmed). SHOW (the active profile colours the model),
            // LEGEND and (round B) the legend IN PHOTOS sit in the header, right to left.
            float checkW = S(100);
            AppearanceProfile shown = ActiveProfile;
            PanelFrame frame = BeginPanel(PanelSize.Side, "COLOUR PROFILES", UiTheme.ACCENT, shown != null ? shown.Name : "No profile yet",
                headerControls: checkW * 3f + S(20) + S(UiTheme.GAP_SMALL) * 2f, overlays: true);
            float checkY = frame.HeaderControlY + (frame.HeaderControlH - S(16)) * 0.5f;
            float legendX = TakeHeaderSlot(ref frame, checkW, S(UiTheme.GAP_SMALL));
            float showX = TakeHeaderSlot(ref frame, checkW, S(UiTheme.GAP_SMALL));
            float shotsX = TakeHeaderSlot(ref frame, checkW + S(20), 0f);
            float ix = frame.Ix, iw = frame.Iw;
            float cy = frame.BodyTop;
            bool shots = Checkbox(f, input, shotsX, checkY, checkW + S(20), "In photos", _appearance.LegendInShots);
            if (shots != _appearance.LegendInShots)
            {
                _appearance.LegendInShots = shots;
                ProfileLookChanged();
                if (shots) { Toast("The legend goes into photos (stills) and screenshots (F12) while the profile shows", 3.5f); }
            }
            bool show = Checkbox(f, input, showX, checkY, checkW - S(10), "Show", _appearance.On);
            if (show != _appearance.On)
            {
                if (show && ActiveProfile == null) { Toast("Make a profile first: NEW BY VALUE or NEW BY SET", 3f); }
                else
                {
                    _appearance.On = show;
                    _profileFailure = null;
                    ProfileLookChanged();
                }
            }
            bool legend = Checkbox(f, input, legendX, checkY, checkW, "Legend", _appearance.Legend);
            if (legend != _appearance.Legend)
            {
                _appearance.Legend = legend;
                ProfileLookChanged();
            }
            float bottom = frame.BodyBottom;
            float lw = MathF.Min(S(240), iw * 0.34f);
            float rx = ix + lw + S(20), rw = iw - lw - S(20);
            _ui.Rect(rx - S(10), cy, MathF.Max(1f, UiScale), bottom - cy, UiTheme.CARD_BORDER);

            BuildProfileList(f, input, ix, cy, lw, bottom);
            AppearanceProfile profile = ActiveProfile;
            if (profile != null) { BuildProfileEditor(f, input, profile, rx, cy, rw, bottom); }
            else
            {
                _ui.TextWrapped(f.Body, rx, cy + S(4), rw, HINT_PROFILE_EMPTY.Text, UiTheme.TEXT_SOFT, maxLines: 8);
            }

            // Footer (← BACK · CLOSE), then the open dropdown / confirm on top
            if (EndPanel(frame, null, HINT_PROFILE_FOOTER.Text) == FOOTER_LEFT || !_profilesOpen) { return; }

            // After drawing: the colour picker, export and import (modal dialogs) and closing
            if (_profilePickRule != null || _profilePickOthers) { RunProfileColourPick(); }
            if (_profilePendingExport != 0)
            {
                bool all = _profilePendingExport == 2;
                _profilePendingExport = 0;
                ExportProfiles(all);
            }
            if (_profilePendingImport)
            {
                _profilePendingImport = false;
                ImportProfiles();
            }
        }

        /// <summary>The profiles (a click makes one active) and the buttons under them.</summary>
        private void BuildProfileList(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            float buttonsH = S(32) * 5 + S(6) * 4;
            float listBottom = bottom - buttonsH - S(10);
            float rowH = S(48);
            List<AppearanceProfile> profiles = _appearance.Profiles;
            float listW = w;
            float top = BeginScroll(_profileListScroll, input, x, y, w, listBottom - y, out w);
            VisibleRows(_profileListScroll, rowH, profiles.Count, out int first, out int last);
            AppearanceProfile pick = null;
            for (int i = first; i < last; i++)
            {
                AppearanceProfile p = profiles[i];
                float ry = top + i * rowH;
                bool current = p.Id == _appearance.Active;
                bool hover = Hover(input, x, ry, w, rowH - S(4));
                _ui.Rect(x, ry, w, rowH - S(4), current ? Rgba.Hex(0x22D3EE, 0.14f) : hover ? Rgba.Hex(0xFFFFFF, 0.07f) : Rgba.Hex(0xFFFFFF, 0.03f));
                if (current) { _ui.Rect(x, ry, S(3), rowH - S(4), UiTheme.ACCENT); }
                _ui.TextWrapped(f.Body, x + S(12), ry + S(5), w - S(20), p.Name, current ? UiTheme.ACCENT : UiTheme.TEXT, maxLines: 1);
                if (p.IsBySet) { _ui.Text(f.Small, x + S(12), ry + S(25), "By search set", UiTheme.TEXT_MUTED); }
                else
                {
                    float byW = _ui.Text(f.Small, x + S(12), ry + S(25), "By ", UiTheme.TEXT_MUTED);
                    _ui.TextWrapped(f.Small, x + S(12) + byW, ry + S(25), w - S(20) - byW, AppearanceProfiler.FieldLabel(p), UiTheme.TEXT_MUTED, maxLines: 1);
                }
                if (hover && input.LeftPressed && !current)
                {
                    input.ConsumeClicks();
                    Sound.Play(SoundId.UiClick);
                    pick = p;
                }
            }
            if (profiles.Count == 0) { _ui.Text(f.Small, x, y + S(4), "(none yet)", UiTheme.TEXT_FAINT); }
            EndScroll(_profileListScroll, input, top + profiles.Count * rowH);
            w = listW;
            if (pick != null)
            {
                _appearance.Active = pick.Id;
                _profileRowScroll.Reset();
                ProfilesChanged();
            }

            // Buttons
            float by = bottom - buttonsH;
            if (SmallButton(f, input, x, by, w, S(32), "NEW BY VALUE")) { NewValueProfile(); }
            by += S(38);
            if (SmallButton(f, input, x, by, w, S(32), "NEW BY SET")) { NewSetProfile(); }
            by += S(38);
            AppearanceProfile active = ActiveProfile;
            float half = (w - S(6)) * 0.5f;
            if (SmallButton(f, input, x, by, half, S(32), "DUPLICATE") && active != null)
            {
                AppearanceProfile copy = active.Copy(newId: true);
                copy.Name = active.Name + " (copy)";
                _appearance.Profiles.Insert(_appearance.Profiles.IndexOf(active) + 1, copy);
                _appearance.Active = copy.Id;
                ProfilesChanged();
            }
            if (SmallButton(f, input, x + half + S(6), by, half, S(32), "RENAME") && active != null)
            {
                AppearanceProfile target = active;
                BeginTextEdit("PROFILE NAME", target.Name, 60, text =>
                {
                    if (text.Length == 0) { return; }
                    target.Name = text;
                    ProfilesChanged();
                });
            }
            by += S(38);

            // Colour round B: files (the choice and the dialogs run after the overlays)
            if (SmallButton(f, input, x, by, half, S(32), "EXPORT…") && active != null)
            {
                if (_appearance.Profiles.Count == 1) { _profilePendingExport = 1; }
                else
                {
                    OpenChoice("EXPORT PROFILES", $"Export “{active.Name}” or all {_appearance.Profiles.Count} profiles? By-set profiles take their search sets with them.",
                        "THIS ONE", danger: false, tickLabel: null, altAction: "ALL", confirmed: _ => _profilePendingExport = 1, altConfirmed: _ => _profilePendingExport = 2);
                }
            }
            if (SmallButton(f, input, x + half + S(6), by, half, S(32), "IMPORT…")) { _profilePendingImport = true; }
            by += S(38);
            if (SmallButton(f, input, x, by, w, S(32), "DELETE", danger: true) && active != null)
            {
                AppearanceProfile target = active;
                OpenConfirm("DELETE PROFILE", $"Delete the colour profile “{target.Name}”?", "DELETE", danger: true, offerSkip: false, ok =>
                {
                    if (!ok) { return; }
                    int index = _appearance.Profiles.IndexOf(target);
                    _appearance.Profiles.Remove(target);
                    _appearance.Active = _appearance.Profiles.Count == 0 ? null : _appearance.Profiles[Math.Clamp(index, 0, _appearance.Profiles.Count - 1)].Id;
                    ProfilesChanged();
                    Toast("Profile deleted", 2f);
                });
            }
        }

        /// <summary>NEW BY VALUE: a profile by level (the field can be changed at once), made active and shown.</summary>
        private void NewValueProfile()
        {
            AppearanceProfile profile = AppearanceProfiler.NewByValue("By level", RuleField.LEVEL, null, Scene);
            AddProfile(profile);
        }

        /// <summary>NEW BY SET: a row per search set (clash detection's sets: the starter ones the first time).</summary>
        private void NewSetProfile()
        {
            EnsureClashes();
            AppearanceProfile profile = AppearanceProfiler.NewBySet("By search set", _clashDocument.Sets);
            AddProfile(profile);
        }

        private void AddProfile(AppearanceProfile profile)
        {
            _appearance.Profiles.Add(profile);
            _appearance.Active = profile.Id;
            _appearance.On = true;
            _profileFailure = null;
            _profileRowScroll.Reset();
            _profileListScroll.ScrollToEnd();
            ProfilesChanged();
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>The active profile's settings and rows.</summary>
        private void BuildProfileEditor(FontAtlas f, InputState input, AppearanceProfile profile, float x, float y, float w, float bottom)
        {
            float cy = y;

            // Name (click renames) and kind
            _ui.TextWrapped(f.Bold, x, cy + S(2), w - S(150), profile.Name, UiTheme.TEXT, maxLines: 1);
            _ui.TextRight(f.Small, x + w, cy + S(6), PROFILE_KIND_LABELS[profile.IsBySet ? 1 : 0], UiTheme.TEXT_MUTED, S(1.2f));
            cy += S(30);

            // Field (by value) or the sets (by set)
            float labelW = S(90);
            if (profile.IsBySet)
            {
                _ui.Text(f.Small, x, cy + S(9), "SETS", UiTheme.TEXT_MUTED, S(1.2f));
                if (SmallButton(f, input, x + labelW, cy, S(160), S(30), "EDIT SETS…"))
                {
                    _profilesReturnFromClashes = true;
                    _profilesOpen = false;
                    OpenClashes();
                    _clashTab = 1;
                    return;
                }
                _ui.TextWrapped(f.Small, x + labelW + S(170), cy + S(2), w - labelW - S(170), "Search sets live in clash detection (CLASHES → SETS).", UiTheme.TEXT_FAINT, maxLines: 2);
            }
            else
            {
                _ui.Text(f.Small, x, cy + S(9), "COLOUR BY", UiTheme.TEXT_MUTED, S(1.2f));
                float fieldW = w - labelW - S(140);
                if (DropdownButton(f, input, x + labelW, cy, fieldW, S(30), AppearanceProfiler.FieldLabel(profile), IsDropdownOpen(profile, DROP_PROFILE_FIELD)))
                {
                    OpenProfileFieldDropdown(profile, x + labelW, cy, fieldW);
                }
                if (SmallButton(f, input, x + w - S(130), cy, S(130), S(30), profile.Ranges ? "REBUILD RANGES" : "REFRESH VALUES"))
                {
                    if (profile.Ranges)
                    {
                        RebuildProfileRanges(profile);
                    }
                    else
                    {
                        int added = AppearanceProfiler.SyncValues(profile, Scene);
                        ProfilesChanged();
                        Toast(added == 0 ? "No new values" : $"{added} new value{(added == 1 ? string.Empty : "s")} added", 2.5f);
                    }
                }
                cy += S(40);

                // Colour round B: each value, or number ranges (bins − / +)
                _ui.Text(f.Small, x, cy + S(9), "VALUES", UiTheme.TEXT_MUTED, S(1.2f));
                int mode = Segmented(f, input, x + labelW, cy, S(220), PROFILE_VALUE_MODES, profile.Ranges ? 1 : 0);
                if (mode != (profile.Ranges ? 1 : 0)) { SetProfileRanges(profile, mode == 1); }
                if (profile.Ranges)
                {
                    // Polish round P-C: how the ranges are cut (equal width / equal count / custom breaks), then the bins
                    // (− n +) or the break values (BREAKS…)
                    cy += S(40);
                    _ui.Text(f.Small, x, cy + S(9), "CUT BY", UiTheme.TEXT_MUTED, S(1.2f));
                    string binning = BinMethod.Normalise(profile.Binning);
                    float methodW = MathF.Min(S(330), w - labelW - S(150));
                    int method = Segmented(f, input, x + labelW, cy, methodW, BinMethod.Labels, Array.IndexOf(BinMethod.All, binning));
                    if (method >= 0 && BinMethod.All[method] != binning)
                    {
                        profile.Binning = BinMethod.All[method];
                        if (profile.Binning == BinMethod.CUSTOM && profile.Breaks == null) { BeginProfileBreaks(profile); }
                        else { RebuildProfileRanges(profile); }
                    }
                    float bx = x + labelW + methodW + S(14);
                    if (profile.Binning == BinMethod.CUSTOM)
                    {
                        if (SmallButton(f, input, bx, cy, x + w - bx, S(30), "BREAKS…")) { BeginProfileBreaks(profile); }
                    }
                    else
                    {
                        if (SmallButton(f, input, bx, cy, S(30), S(30), "−") && profile.Bins > AppearanceProfiler.MIN_BINS)
                        {
                            profile.Bins--;
                            RebuildProfileRanges(profile);
                        }
                        Text.Clear().Append(profile.Bins);
                        _ui.TextCentred(f.Bold, bx + S(50), cy + S(6), Text.Span, UiTheme.TEXT);
                        if (SmallButton(f, input, bx + S(70), cy, S(30), S(30), "+") && profile.Bins < AppearanceProfiler.MAX_BINS)
                        {
                            profile.Bins++;
                            RebuildProfileRanges(profile);
                        }
                    }
                }
            }
            cy += S(40);

            // Others: ghosted / normal / flat colour (+ its swatch)
            _ui.Text(f.Small, x, cy + S(9), "OTHERS", UiTheme.TEXT_MUTED, S(1.2f));
            bool flat = UnmatchedLook.Normalise(profile.Unmatched) == UnmatchedLook.FLAT;
            float segW = w - labelW - (flat ? S(46) : 0f);
            int look = Array.IndexOf(UnmatchedLook.All, UnmatchedLook.Normalise(profile.Unmatched));
            int picked = Segmented(f, input, x + labelW, cy, segW, UnmatchedLook.Labels, look);
            if (picked != look && picked >= 0)
            {
                profile.Unmatched = UnmatchedLook.All[picked];
                ProfilesChanged();
            }
            if (flat && ProfileSwatch(input, x + w - S(38), cy + S(2), S(38), S(28), LaunchSettings.TryParseColour(profile.UnmatchedColour, out uint rgb) ? rgb : 0xD6DADF, true))
            {
                _profilePickOthers = true;
            }
            cy += S(44);

            // Surface detail (texture / material shade under the colour) and the palette
            float sliderW = (w - S(20)) * 0.55f;
            Text.Clear().Append((long)MathF.Round(profile.Detail * 100f)).Append(" %");
            float detail = Slider(f, input, SLIDER_PROFILE_DETAIL, x, cy, sliderW, "Surface detail", Text.Span, profile.Detail, 0f, 1f);
            detail = MathF.Round(detail * 20f) / 20f;
            if (MathF.Abs(detail - profile.Detail) > 1e-4f)
            {
                profile.Detail = detail;
                ProfileLookChanged(); // a uniform: no new evaluation while dragging
            }
            float px = x + sliderW + S(20), pw = w - sliderW - S(20);
            if (profile.Ranges)
            {
                // Colour round B: the ranges' ramp (recolours the rows at once)
                _ui.Text(f.Body, px, cy, "Ramp", UiTheme.TEXT);
                int ramp = Array.IndexOf(AppearanceProfiler.RAMPS, AppearanceProfiler.NormaliseRamp(profile.Ramp));
                if (DropdownButton(f, input, px, cy + S(20), pw, S(28), AppearanceProfiler.RAMP_LABELS[Math.Max(0, ramp)], IsDropdownOpen(profile, DROP_PROFILE_RAMP)))
                {
                    AppearanceProfile target = profile;
                    OpenDropdown(profile, DROP_PROFILE_RAMP, px, cy + S(20), pw, S(28), AppearanceProfiler.RAMP_LABELS, ramp, k =>
                    {
                        AppearanceProfiler.ApplyRamp(target, AppearanceProfiler.RAMPS[k]);
                        ProfilesChanged();
                    });
                }
            }
            else
            {
                _ui.Text(f.Body, px, cy, "Palette", UiTheme.TEXT);
                int palette = Array.IndexOf(AppearanceProfiler.PALETTES, AppearanceProfiler.NormalisePalette(profile.Palette));
                if (DropdownButton(f, input, px, cy + S(20), pw, S(28), AppearanceProfiler.PALETTE_LABELS[Math.Max(0, palette)], IsDropdownOpen(profile, DROP_PROFILE_PALETTE)))
                {
                    AppearanceProfile target = profile;
                    OpenDropdown(profile, DROP_PROFILE_PALETTE, px, cy + S(20), pw, S(28), AppearanceProfiler.PALETTE_LABELS, palette, k =>
                    {
                        // Recolours every row (the palette is also where new rows take their colours from)
                        OpenConfirm("RECOLOUR?", $"Recolour all {target.Rules.Count} rows from the {AppearanceProfiler.PALETTE_LABELS[k]} palette? Colours picked by hand are replaced.",
                            "RECOLOUR", danger: false, offerSkip: false, ok =>
                            {
                                if (!ok) { return; }
                                AppearanceProfiler.ApplyPalette(target, AppearanceProfiler.PALETTES[k]);
                                ProfilesChanged();
                            });
                    });
                }
            }
            cy += S(62);

            // Rows header
            _ui.Rect(x, cy, w, MathF.Max(1f, UiScale), UiTheme.CARD_BORDER);
            cy += S(8);
            float footerH = S(40);
            BuildProfileRows(f, input, profile, x, cy, w, bottom - footerH);

            // Under the rows: by set ADD SET / ALL ON / ALL OFF; by value ALL ON / ALL OFF
            float by = bottom - S(32);
            float bw = (w - S(12)) / 3f;
            if (profile.IsBySet)
            {
                if (DropdownButton(f, input, x, by, bw, S(32), "ADD SET", IsDropdownOpen(profile, DROP_PROFILE_ADD_SET)))
                {
                    OpenProfileSetDropdown(profile, null, DROP_PROFILE_ADD_SET, x, by, bw);
                }
            }
            else
            {
                Text.Clear().AppendGrouped(profile.Rules.Count).Append(profile.Ranges ? (profile.Rules.Count == 1 ? " range" : " ranges") : profile.Rules.Count == 1 ? " value" : " values");
                _ui.Text(f.Small, x, by + S(9), Text.Span, UiTheme.TEXT_MUTED);
            }
            if (SmallButton(f, input, x + bw + S(6), by, bw, S(32), "ALL ON")) { SetAllProfileRows(profile, true); }
            if (SmallButton(f, input, x + (bw + S(6)) * 2f, by, bw, S(32), "ALL OFF")) { SetAllProfileRows(profile, false); }
        }

        /// <summary>
        /// The rows: tick (on / off), swatch (click: colour picker), label (by set: the set dropdown), count, and × (by
        /// set). A clipped scroll region (polish round P-A1).
        /// </summary>
        private void BuildProfileRows(FontAtlas f, InputState input, AppearanceProfile profile, float x, float y, float w, float bottom)
        {
            float rowH = S(34);
            List<ProfileRule> rules = profile.Rules;
            float top = BeginScroll(_profileRowScroll, input, x, y, w, bottom - y, out w);
            VisibleRows(_profileRowScroll, rowH, rules.Count, out int first, out int last);

            bool counted = _profileResult != null && _profileResultFor == profile.Id && _profileResult.RuleCounts.Length == rules.Count;
            ProfileRule remove = null;
            bool changed = false;
            for (int i = first; i < last; i++)
            {
                ProfileRule rule = rules[i];
                float ry = top + i * rowH;
                _ui.Rect(x, ry, w, rowH - S(4), (i & 1) == 0 ? Rgba.Hex(0xFFFFFF, 0.03f) : 0u);

                // On / off
                bool on = Checkbox(f, input, x + S(8), ry + S(7), S(20), string.Empty, rule.On);
                if (on != rule.On)
                {
                    rule.On = on;
                    changed = true;
                }

                // Colour
                if (ProfileSwatch(input, x + S(34), ry + S(4), S(38), rowH - S(12), rule.Rgb, rule.On)) { _profilePickRule = rule; }

                // Label (by set: the set, a dropdown), count, (round B) transparency and hide, ×
                float lx = x + S(82), countW = S(64), transW = S(56), hideW = S(62), delW = profile.IsBySet ? S(32) : 0f;
                float labelW = w - (lx - x) - countW - transW - hideW - delW - S(16);
                string label = ProfileRuleLabel(profile, rule);
                if (profile.IsBySet)
                {
                    if (DropdownButton(f, input, lx, ry + S(1), labelW, rowH - S(8), label, IsDropdownOpen(rule, DROP_PROFILE_SET)))
                    {
                        OpenProfileSetDropdown(profile, rule, DROP_PROFILE_SET, lx, ry + S(1), labelW);
                    }
                }
                else
                {
                    _ui.TextWrapped(f.Body, lx, ry + S(7), labelW, label, rule.On ? UiTheme.TEXT : UiTheme.TEXT_FAINT, maxLines: 1);
                }
                Text.Clear();
                if (counted) { Text.AppendGrouped(_profileResult.RuleCounts[i]); }
                else { Text.Append('…'); }
                _ui.TextRight(f.Small, lx + labelW + countW, ry + S(9), Text.Span, counted && _profileResult.RuleCounts[i] == 0 ? UiTheme.TEXT_FAINT : UiTheme.TEXT_MUTED);

                // Colour round B: see-through (0–90 %) and hide
                float tx = lx + labelW + countW + S(6);
                int tIndex = Math.Clamp((int)MathF.Round(rule.Transparency * 10f), 0, PROFILE_TRANSPARENCY_LABELS.Length - 1);
                if (DropdownButton(f, input, tx, ry + S(1), transW, rowH - S(8), PROFILE_TRANSPARENCY_LABELS[tIndex], IsDropdownOpen(rule, DROP_PROFILE_TRANSPARENCY)))
                {
                    ProfileRule target = rule;
                    OpenDropdown(rule, DROP_PROFILE_TRANSPARENCY, tx, ry + S(1), transW, rowH - S(8), PROFILE_TRANSPARENCY_LABELS, tIndex, k =>
                    {
                        target.Transparency = k / 10f;
                        ProfilesChanged();
                    });
                }
                float hx = tx + transW + S(6);
                if (SmallButton(f, input, hx, ry + S(1), hideW, rowH - S(8), rule.Hidden ? "HIDDEN" : "HIDE", danger: rule.Hidden))
                {
                    rule.Hidden = !rule.Hidden;
                    changed = true;
                }
                if (profile.IsBySet && SmallButton(f, input, x + w - delW, ry + S(1), delW, rowH - S(8), "×", danger: true)) { remove = rule; }
            }
            if (rules.Count == 0)
            {
                _ui.TextWrapped(f.Small, x, y + S(4), w, profile.IsBySet ? "No sets: ADD SET." : profile.Ranges ? "This field has no numbers in the model." : "This field has no values in the model.", UiTheme.TEXT_FAINT, maxLines: 2);
            }
            EndScroll(_profileRowScroll, input, top + rules.Count * rowH);

            if (remove != null)
            {
                rules.Remove(remove);
                changed = true;
            }
            if (changed) { ProfilesChanged(); }
        }

        /// <summary>
        /// Colour round B: switches a by-value profile between each value and number ranges (rows rebuilt; a field without
        /// numbers stays on each value).
        /// </summary>
        private void SetProfileRanges(AppearanceProfile profile, bool ranges)
        {
            _profileRowScroll.Reset();
            if (ranges)
            {
                if (AppearanceProfiler.BuildRanges(profile, Scene) == 0)
                {
                    profile.Ranges = false;
                    AppearanceProfiler.SyncValues(profile, Scene);
                    Sound.Play(SoundId.Error);
                    Toast($"{AppearanceProfiler.FieldLabel(profile)} has no numbers in this model", 3f);
                }
            }
            else
            {
                profile.Ranges = false;
                profile.Rules.Clear();
                AppearanceProfiler.SyncValues(profile, Scene);
            }
            ProfilesChanged();
        }

        /// <summary>
        /// Polish round P-C: BREAKS…: the custom break values as typed text ("300; 450; 600"); Enter rebuilds the ranges.
        /// </summary>
        private void BeginProfileBreaks(AppearanceProfile profile)
        {
            AppearanceProfile target = profile;
            BeginTextEdit("BREAK VALUES (e.g. 300; 450; 600)", AppearanceProfiler.FormatBreaks(profile.Breaks), 200, text =>
            {
                List<double> breaks = AppearanceProfiler.ParseBreaks(text);
                if (breaks == null)
                {
                    Sound.Play(SoundId.Error);
                    Toast("No numbers there: type the values where one range ends and the next starts", 3f);
                    if (target.Breaks == null) { target.Binning = BinMethod.EQUAL; }
                    RebuildProfileRanges(target);
                    return;
                }
                target.Breaks = breaks;
                target.Binning = BinMethod.CUSTOM;
                RebuildProfileRanges(target);
            });
        }

        /// <summary>Colour round B: the ranges again (min / max from the model now, the bins, the ramp's colours).</summary>
        private void RebuildProfileRanges(AppearanceProfile profile)
        {
            _profileRowScroll.Reset();
            if (AppearanceProfiler.BuildRanges(profile, Scene) == 0) { Toast("No numbers in this model for that field", 3f); }
            ProfilesChanged();
        }

        /// <summary>Colour round B: EXPORT…: the active profile (or all of them) and the search sets they use, to a file.</summary>
        private void ExportProfiles(bool all)
        {
            AppearanceProfile active = ActiveProfile;
            if (active == null) { return; }
            List<AppearanceProfile> profiles = all ? _appearance.Profiles : new List<AppearanceProfile> { active };
            if (profiles.Any(p => p.IsBySet)) { EnsureClashes(); }

            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            string name = SafeFileName(all ? Scene.ModelTitle + " colour profiles" : active.Name) + ProfileFiles.EXTENSION;
            string path = FileDialogs.ShowSave(_window.Handle, "Export colour profiles", ProfileFiles.FILTER, SuggestedFolder(), name, ProfileFiles.EXTENSION);
            _window.Input.ReleaseAll();
            if (path == null) { return; }

            ProfileFile file = ProfileFiles.Build(profiles, id => _clashDocument?.FindSet(id), Scene.ModelTitle, $"BimGo {Program.Version}", Scene.Links); // P-C: link names
            if (ProfileFiles.Export(path, file, out string error))
            {
                Sound.Play(SoundId.Commit);
                Toast($"{file.Profiles.Count} profile{(file.Profiles.Count == 1 ? string.Empty : "s")}" +
                    (file.Sets.Count > 0 ? $" and {file.Sets.Count} search set{(file.Sets.Count == 1 ? string.Empty : "s")}" : string.Empty) +
                    $" saved: {System.IO.Path.GetFileName(path)}", 3.5f);
            }
            else
            {
                Sound.Play(SoundId.Error);
                Toast(error, 5f, important: true);
            }
        }

        /// <summary>
        /// Colour round B: IMPORT…: adds a file's profiles (the first becomes active); their search sets are matched by
        /// name, missing ones are added to clash detection's sets.
        /// </summary>
        private void ImportProfiles()
        {
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            string path = FileDialogs.ShowOpen(_window.Handle, "Import colour profiles", ProfileFiles.FILTER, SuggestedFolder());
            _window.Input.ReleaseAll();
            if (path == null) { return; }

            ProfileFile file = ProfileFiles.Read(path, out string error);
            if (file == null)
            {
                Sound.Play(SoundId.Error);
                Toast(error, 5f, important: true);
                return;
            }
            if (file.Profiles.Count == 0)
            {
                Toast("The file holds no profiles", 3f);
                return;
            }

            // P-C: links and levels matched to this model by name; the misses are reported (and logged)
            ProfileReconcile reconciled = ProfileFiles.Reconcile(file, Scene.Links, Scene.Levels.Select(l => l.Name));
            foreach (string miss in reconciled.Missing) { Utilities.Log_Utils.Write($"Colour profile import ({System.IO.Path.GetFileName(path)}): not in this model: {miss}."); }

            bool needsSets = file.Sets.Count > 0 || file.Profiles.Any(p => p.IsBySet);
            if (needsSets) { EnsureClashes(); }
            List<AppearanceProfile> added = ProfileFiles.Merge(file, _appearance, needsSets ? _clashDocument.Sets : null, out int matched, out int setsAdded);
            if (setsAdded > 0) { ClashSetupChanged(); }
            _appearance.Active = added[0].Id;
            _profileRowScroll.Reset();
            _profileListScroll.ScrollToEnd();
            ProfilesChanged();
            Sound.Play(SoundId.Commit);
            Toast($"{added.Count} profile{(added.Count == 1 ? string.Empty : "s")} imported" +
                (matched > 0 ? $" · {matched} set{(matched == 1 ? string.Empty : "s")} matched by name" : string.Empty) +
                (setsAdded > 0 ? $" · {setsAdded} set{(setsAdded == 1 ? string.Empty : "s")} added" : string.Empty) +
                (reconciled.Matched > 0 ? $" · {reconciled.Matched} link / level value{(reconciled.Matched == 1 ? string.Empty : "s")} matched by name" : string.Empty) +
                (reconciled.Missing.Count > 0 ? $" · not in this model: {string.Join(", ", reconciled.Missing.Take(3))}{(reconciled.Missing.Count > 3 ? $" +{reconciled.Missing.Count - 3} (see the log)" : string.Empty)}" : string.Empty),
                reconciled.Missing.Count > 0 ? 7f : 4f);
        }

        /// <summary>A colour swatch button (faded when its row is off).</summary>
        /// <returns>True when clicked.</returns>
        private bool ProfileSwatch(InputState input, float x, float y, float w, float h, uint rgb, bool on)
        {
            bool hover = Hover(input, x, y, w, h);
            _ui.Rect(x, y, w, h, Rgba.Hex(rgb, on ? 1f : 0.3f));
            _ui.Outline(x, y, w, h, MathF.Max(1f, UiScale), hover ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
            bool clicked = hover && input.LeftPressed;
            if (clicked)
            {
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
            }
            return clicked;
        }

        /// <summary>Every row on or off.</summary>
        private void SetAllProfileRows(AppearanceProfile profile, bool on)
        {
            foreach (ProfileRule rule in profile.Rules) { rule.On = on; }
            ProfilesChanged();
        }

        /// <summary>
        /// The field dropdown: the built-in fields, then each extracted parameter ("Parameter: Fire Rating"). A pick
        /// replaces the rows with the new field's values (a name still "By …" follows the field).
        /// </summary>
        private void OpenProfileFieldDropdown(AppearanceProfile profile, float x, float y, float w)
        {
            _profileFieldChoices.Clear();
            var labels = new List<string>();
            foreach (string field in RuleField.All)
            {
                _profileFieldChoices.Add((field, null));
                labels.Add(SearchSets.FieldLabel(field));
            }
            foreach (string name in (Scene.Parameters ?? ParameterTable.Empty).SortedNames())
            {
                _profileFieldChoices.Add((RuleField.PARAMETER, name));
                labels.Add("Parameter: " + name);
            }
            int selected = _profileFieldChoices.FindIndex(c => c.Field == RuleField.Normalise(profile.Field)
                && (c.Field != RuleField.PARAMETER || string.Equals(c.Parameter, profile.Parameter, StringComparison.OrdinalIgnoreCase)));

            AppearanceProfile target = profile;
            OpenDropdown(profile, DROP_PROFILE_FIELD, x, y, w, S(30), labels, selected, k =>
            {
                if (k < 0 || k >= _profileFieldChoices.Count || k == selected) { return; }
                (string field, string parameter) = _profileFieldChoices[k];
                bool autoName = string.Equals(target.Name, "By " + AppearanceProfiler.FieldLabel(target), StringComparison.OrdinalIgnoreCase);
                AppearanceProfiler.SetField(target, field, parameter, Scene);
                if (autoName)
                {
                    // Built-in fields read in lower case ("By level"); parameters keep their names ("By Fire Rating")
                    string label = AppearanceProfiler.FieldLabel(target);
                    target.Name = "By " + (target.Field == RuleField.PARAMETER ? label : label.ToLowerInvariant());
                }
                _profileRowScroll.Reset();
                ProfilesChanged();
                if (target.Rules.Count == 0) { Toast("No element in the model has a value for that", 3f); }
            });
            if (labels.Count == RuleField.All.Length && (Scene.Parameters == null || Scene.Parameters.IsEmpty))
            {
                Toast("Tick parameters in Revit Options → Parameters (then Go / Export again) to colour by them", 4f);
            }
        }

        /// <summary>
        /// A set dropdown: every search set (a row's set, or a new row with ADD SET). Clash detection's sets are
        /// switched on first.
        /// </summary>
        private void OpenProfileSetDropdown(AppearanceProfile profile, ProfileRule rule, int slot, float x, float y, float w)
        {
            EnsureClashes();
            List<SearchSet> sets = _clashDocument.Sets;
            if (sets.Count == 0)
            {
                Toast("No search sets: make some in CLASHES → SETS (EDIT SETS…)", 3f);
                return;
            }
            var labels = sets.Select(s => s.Name).ToList();
            int selected = rule == null ? -1 : sets.FindIndex(s => s.Id == rule.SetId);
            string[] ids = sets.Select(s => s.Id).ToArray();
            AppearanceProfile target = profile;
            OpenDropdown((object)rule ?? profile, slot, x, y, w, S(30), labels, selected, k =>
            {
                if (k < 0 || k >= ids.Length) { return; }
                if (rule == null)
                {
                    target.Rules.Add(new ProfileRule { SetId = ids[k], Colour = AppearanceProfiler.PaletteColour(target.Palette, target.Rules.Count) });
                    _profileRowScroll.ScrollToEnd();
                }
                else { rule.SetId = ids[k]; }
                ProfilesChanged();
            });
        }

        /// <summary>The pending colour pick (the Windows colour picker), after the overlays have drawn.</summary>
        private void RunProfileColourPick()
        {
            ProfileRule rule = _profilePickRule;
            bool others = _profilePickOthers;
            _profilePickRule = null;
            _profilePickOthers = false;
            AppearanceProfile profile = ActiveProfile;
            if (profile == null) { return; }

            uint start = others ? (LaunchSettings.TryParseColour(profile.UnmatchedColour, out uint flat) ? flat : 0xD6DADF) : rule.Rgb;
            _window.Input.ReleaseAll();
            uint? picked = FileDialogs.PickColour(_window.Handle, start);
            _window.Input.ReleaseAll();
            if (!picked.HasValue) { return; }
            if (others) { profile.UnmatchedColour = AppearanceProfiler.Hex(picked.Value); }
            else { rule.Colour = AppearanceProfiler.Hex(picked.Value); }
            ProfilesChanged();
        }

        #endregion
    }
}
