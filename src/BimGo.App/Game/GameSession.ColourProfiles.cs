using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Colour round A: colour profiles (as Navisworks' appearance profiler). A profile colours elements by search set
    /// (the first set an element is in wins) or by the values of a field or extracted parameter; the rest are ghosted,
    /// keep their colours or take one flat colour. Profiles are saved per model (visibility.json → appearance); one is
    /// active and the colour profile key (Shift+C) shows or hides it, walking and in clash mode (where it shows in the
    /// real model view). The on-screen legend lists the rows with their counts. Evaluating runs when something changes,
    /// never per frame; the renderer recolours from one small texture (<see cref="SceneRenderer.SetProfile"/>).
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>One legend row: swatch, label and count (made when the profile is evaluated).</summary>
        private readonly struct ProfileLegendRow
        {
            public ProfileLegendRow(uint colour, string label, string count, bool off)
            {
                Colour = colour;
                Label = label;
                Count = count;
                Off = off;
            }

            public uint Colour { get; }
            public string Label { get; }
            public string Count { get; }
            public bool Off { get; }
        }

        // The model's profiles (saved with the visibility)
        private AppearanceSettings _appearance = new();

        // Evaluation: wanted again when a profile, the sets or the model change; the result feeds the legend and panel
        private bool _profileDirty = true;
        private ProfileResult _profileResult;
        private string _profileResultFor;
        private string _profileFailure;
        private readonly List<ProfileLegendRow> _profileLegend = new();
        private string _profileLegendTitle, _profileLegendFooter;

        /// <summary>Most legend rows shown before "+ n more".</summary>
        private const int PROFILE_LEGEND_ROWS = 14;

        // Colour round B: elements hidden by their row (drawing, picking, collision, shadows) and the result applied
        private bool[] _profileHidden;
        private ProfileResult _profileHiddenFrom;

        #endregion

        #region State

        /// <summary>The active profile, or null.</summary>
        private AppearanceProfile ActiveProfile => _appearance.Find(_appearance.Active);

        /// <summary>True when the active profile colours the model.</summary>
        private bool ProfileShowing => _appearance.On && ActiveProfile != null && _profileFailure == null;

        /// <summary>Restores the saved profiles (with the visibility, at load).</summary>
        private void RestoreAppearance(AppearanceSettings saved)
        {
            _appearance = saved?.Copy().Clean() ?? new AppearanceSettings();
            _profileDirty = true;
        }

        /// <summary>The profiles for visibility.json (null when there are none).</summary>
        private AppearanceSettings AppearanceForSave() => _appearance.IsDefault ? null : _appearance.Copy();

        /// <summary>
        /// A profile (or which one is active, or on / off) changed: evaluated again before the next frame, saved with the
        /// model (dirty file / live sidecar).
        /// </summary>
        private void ProfilesChanged()
        {
            _appearance.Clean();
            _profileDirty = true;
            VisibilityChanged();
        }

        /// <summary>
        /// Something that needs no new evaluation changed (shown / hidden, the legend, the surface detail): saved with the
        /// model, the renderer told at once.
        /// </summary>
        private void ProfileLookChanged()
        {
            _appearance.Clean();
            AppearanceProfile profile = ActiveProfile;
            if (profile != null) { _renderer?.SetProfileDetail(profile.Detail); }
            VisibilityChanged();
        }

        /// <summary>
        /// The search sets changed (CLASHES panel, import): a by-set profile is evaluated again. Nothing is saved here.
        /// </summary>
        private void ProfileSetsChanged()
        {
            if (ActiveProfile?.IsBySet == true) { _profileDirty = true; }
        }

        #endregion

        #region Evaluation

        /// <summary>
        /// Once a frame before drawing: evaluates the active profile when something changed and hands the codes to the
        /// renderer; tells the renderer whether to show it (not in reflection probes, see the renderer).
        /// </summary>
        private void UpdateProfile()
        {
            if (_renderer == null) { return; }
            AppearanceProfile profile = ActiveProfile;
            if (_profileDirty && profile != null && (_appearance.On || IsColourProfilesPanelOpen))
            {
                _profileDirty = false;
                EvaluateProfile(profile);
            }
            else if (profile == null && _profileResult != null)
            {
                _profileResult = null;
                _profileResultFor = null;
                _profileLegend.Clear();
                _renderer.ClearProfile();
            }
            _renderer.ProfileOn = ProfileShowing && _renderer.HasProfile;
            ApplyProfileHidden();
        }

        /// <summary>True when the shown profile hides an element (its row is hidden).</summary>
        private bool ProfileHides(int element) => _profileHidden != null && (uint)element < (uint)_profileHidden.Length && _profileHidden[element];

        /// <summary>
        /// Colour round B: hides the elements of hidden rows while the profile shows (as the Scan gun's hiding: drawing,
        /// shadows, picking and collision), and brings them back when it doesn't. Only elements that change are touched.
        /// </summary>
        private void ApplyProfileHidden()
        {
            ProfileResult want = ProfileShowing && _profileResult != null && _profileResult.AnyHidden && _profileResultFor == _appearance.Active ? _profileResult : null;
            if (ReferenceEquals(want, _profileHiddenFrom)) { return; }
            _profileHiddenFrom = want;
            if (want == null && _profileHidden == null) { return; }
            _profileHidden ??= new bool[Scene.Elements.Length];
            Dynamics.SourceHidden = _profileHidden; // P-C: moved / cloned copies of hidden rows hide too (no shadows)

            bool changed = false;
            for (int e = 0; e < _profileHidden.Length; e++)
            {
                bool hide = want != null && e < want.Codes.Length && (want.Codes[e] >> 24) == AppearanceProfiler.CODE_HIDDEN;
                if (hide == _profileHidden[e]) { continue; }
                _profileHidden[e] = hide;
                changed = true;
                _renderer.SetElementHidden(e, hide || _hidden[e] || _userHidden[e]);
                bool visible = !hide && !_hidden[e] && !_userHidden[e] && _groupVisible[Rendering.SceneBatches.GroupOf(Scene.Elements[e])];
                _pickMask[e] = visible;
                _collisionMask[e] = visible && Scene.Elements[e].CategoryIndex != _doorCategory;
            }
            if (changed) { _sceneRevision++; }
        }

        /// <summary>
        /// Evaluates a profile (by set: switches clash detection's sets on; by value: adds rows for values new to the
        /// model, as after F5) and uploads it. Allocates: only when something changed.
        /// </summary>
        private void EvaluateProfile(AppearanceProfile profile)
        {
            try
            {
                if (profile.IsBySet) { EnsureClashes(); }
                else if (AppearanceProfiler.SyncValues(profile, Scene) > 0 && _profileResultFor == profile.Id)
                {
                    VisibilityChanged(); // new values found (a refreshed model): their rows are saved too
                }

                ProfileResult result = AppearanceProfiler.Evaluate(profile, Scene, id => _clashDocument?.FindSet(id));
                _profileResult = result;
                _profileResultFor = profile.Id;
                _profileFailure = _renderer.SetProfile(result.Codes, profile.Detail, result.AnyBlended);
                if (_profileFailure != null)
                {
                    _appearance.On = false;
                    Toast(_profileFailure, 5f, important: true);
                }
                BuildProfileLegend(profile, result);
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Colour profile “{profile.Name}” failed: {ex}");
                _profileFailure = "The colour profile couldn't be shown (see the log).";
                Toast(_profileFailure, 5f, important: true);
            }
        }

        /// <summary>The legend's rows and texts for a profile's result.</summary>
        private void BuildProfileLegend(AppearanceProfile profile, ProfileResult result)
        {
            _profileLegend.Clear();
            _profileLegendTitle = profile.Name.ToUpperInvariant();
            for (int r = 0; r < profile.Rules.Count; r++)
            {
                ProfileRule rule = profile.Rules[r];
                int count = r < result.RuleCounts.Length ? result.RuleCounts[r] : 0;
                if (!profile.IsBySet && count == 0) { continue; } // values the model no longer has stay in the panel only
                string countText = !rule.On ? "off" : rule.Hidden ? $"{count:N0} hidden" : rule.Transparency > 0f ? $"{count:N0} · {MathF.Round(rule.Transparency * 100f):0} %" : count.ToString("N0");
                _profileLegend.Add(new ProfileLegendRow(Rgba.Hex(rule.Rgb), ProfileRuleLabel(profile, rule), countText, !rule.On || rule.Hidden));
            }

            string look = UnmatchedLook.Normalise(profile.Unmatched);
            string rest = look == UnmatchedLook.GHOST ? "ghosted" : look == UnmatchedLook.FLAT ? "flat colour" : "normal colours";
            _profileLegendFooter = result.Unmatched > 0 ? $"Others ({result.Unmatched:N0}): {rest}" : null;
            if (result.NoNumber > 0) { _profileLegendFooter = (_profileLegendFooter == null ? string.Empty : _profileLegendFooter + " · ") + $"{result.NoNumber:N0} without a number"; }
            if (result.MissingSets > 0) { _profileLegendFooter = (_profileLegendFooter == null ? string.Empty : _profileLegendFooter + " · ") + $"{result.MissingSets} set{(result.MissingSets == 1 ? string.Empty : "s")} missing"; }
        }

        /// <summary>A row's label: the set's name (or "(missing set)"), or the value's label.</summary>
        private string ProfileRuleLabel(AppearanceProfile profile, ProfileRule rule)
        {
            if (profile.IsBySet) { return _clashDocument?.FindSet(rule.SetId)?.Name ?? "(missing set)"; }
            if (!string.IsNullOrEmpty(rule.Label)) { return rule.Label; }
            return SearchSets.ValueLabel(profile.Field, rule.Value, false, Scene);
        }

        #endregion

        #region Hotkey

        /// <summary>
        /// The colour profile key (Shift+C): shows or hides the active profile; with none yet, says where to make one.
        /// </summary>
        private void ToggleProfile()
        {
            AppearanceProfile profile = ActiveProfile;
            if (profile == null)
            {
                Sound.Play(SoundId.Error);
                Toast("No colour profile yet: Esc → Appearance → Colour profiles", 3.5f);
                return;
            }
            _appearance.On = !_appearance.On;
            _profileFailure = null;
            ProfileLookChanged();
            Sound.Play(SoundId.UiClick);
            string where = _clashModeOn && _clashView != CLASH_VIEW_REAL ? " (shows in the real model view: G)" : string.Empty;
            Toast(_appearance.On ? $"Colour profile: {profile.Name}{where}" : "Colour profile off", 2.5f);
        }

        #endregion

        #region Legend

        /// <summary>The on-screen legend is wanted (a profile shows with its legend ticked; clash mode: the real view).</summary>
        private bool ProfileLegendWanted => ProfileShowing && _appearance.Legend && _profileResult != null && _profileResultFor == _appearance.Active
            && (!_clashModeOn || _clashView == CLASH_VIEW_REAL);

        /// <summary>
        /// The on-screen legend while a profile shows (the left-hand column, between the panels above and the sun legend
        /// or F1 sheet below; P-A2): the profile's name, a swatch, label and count per row (the first
        /// <see cref="PROFILE_LEGEND_ROWS"/>), and the others' look. Collapsed (the F1 sheet is open, or not one row
        /// fits): the title row only.
        /// </summary>
        private void BuildProfileLegend(FontAtlas f, float top, float bottom, bool collapsed)
        {
            if (!ProfileLegendWanted) { return; }
            DrawProfileLegend(f, S(20), top, bottom, anchorBottom: false, collapsed);
        }

        /// <summary>Colour round B: the legend is wanted in photos and screenshots (the panel's tick, the profile showing).</summary>
        private bool ProfileLegendInShots => _appearance.LegendInShots && ProfileShowing && _profileResult != null && _profileResultFor == _appearance.Active;

        /// <summary>
        /// Colour round B: queues the legend for a photo or screenshot, bottom left of a target of this size (the caller
        /// flushes the UI into the bound target). Screen-sized (a 4× photo shows it smaller).
        /// </summary>
        private void QueueProfileLegendForShot(int width, int height)
        {
            if (!ProfileLegendInShots) { return; }
            DrawProfileLegend(_ui.Atlas, S(20), S(20), height - S(20), anchorBottom: true);
        }

        /// <summary>The legend panel between two heights (top-anchored for the HUD, bottom-anchored for shots).</summary>
        private void DrawProfileLegend(FontAtlas f, float x, float top, float bottom, bool anchorBottom, bool collapsed = false)
        {
            float w = S(250);
            float rowH = S(20);
            int shown = Math.Min(_profileLegend.Count, PROFILE_LEGEND_ROWS);
            int fit = Math.Max(1, (int)((bottom - top - S(54)) / rowH));
            shown = Math.Min(shown, fit);
            int more = _profileLegend.Count - shown;
            float h = S(34) + shown * rowH + (more > 0 ? rowH : 0f) + (_profileLegendFooter != null ? rowH : 0f) + S(8);
            if (collapsed || top + h > bottom)
            {
                // P-A2: the title row only (too small a window for even one row, or the F1 sheet is open)
                float ch = S(UiTheme.LEGEND_COLLAPSED_HEIGHT);
                if (top + ch > bottom) { return; }
                if (anchorBottom) { top = bottom - ch; }
                _ui.Panel(x, top, w, ch, UiTheme.PANEL, UiTheme.PANEL_BORDER);
                _ui.TextWrapped(f.Small, x + S(12), top + MathF.Round((ch - f.Small.LineHeight) * 0.5f), w - S(24), _profileLegendTitle, UiTheme.ACCENT, maxLines: 1);
                return;
            }
            if (anchorBottom) { top = bottom - h; }

            _ui.Panel(x, top, w, h, UiTheme.PANEL, UiTheme.PANEL_BORDER);
            _ui.TextWrapped(f.Small, x + S(12), top + S(10), w - S(24), _profileLegendTitle, UiTheme.ACCENT, maxLines: 1);
            float y = top + S(32);
            for (int i = 0; i < shown; i++)
            {
                ProfileLegendRow row = _profileLegend[i];
                _ui.Rect(x + S(12), y + S(3), S(14), S(12), row.Off ? Rgba.WithAlpha(row.Colour, 0.3f) : row.Colour);
                _ui.TextWrapped(f.Small, x + S(34), y + S(1), w - S(34) - S(64), row.Label, row.Off ? UiTheme.TEXT_FAINT : UiTheme.TEXT, maxLines: 1);
                _ui.TextRight(f.Small, x + w - S(12), y + S(1), row.Count, UiTheme.TEXT_MUTED);
                y += rowH;
            }
            if (more > 0)
            {
                Text.Clear().Append("+ ").Append(more).Append(" more (Esc → Appearance)");
                _ui.Text(f.Small, x + S(12), y + S(1), Text.Span, UiTheme.TEXT_FAINT);
                y += rowH;
            }
            if (_profileLegendFooter != null) { _ui.TextWrapped(f.Small, x + S(12), y + S(1), w - S(24), _profileLegendFooter, UiTheme.TEXT_MUTED, maxLines: 1); }
        }

        #endregion
    }
}
