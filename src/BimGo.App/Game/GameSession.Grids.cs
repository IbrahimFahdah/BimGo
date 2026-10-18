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
    /// Grids round A: Revit grids drawn in the model on the chosen levels (off, underfoot, above, below, underfoot ±1,
    /// nearest the eye, all), Revit-like dash-dot lines with bubbles and level tags, a faint outline per level, and the
    /// GRIDS panel (Shift+G; C cycles off → underfoot → all). Works walking, flying and in clash mode. Saved per model
    /// with the visibility (visibility.json / the live model folder's sidecar).
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>Slider ids (unique across the panels' sliders).</summary>
        private const int SLIDER_GRID_OPACITY = 60, SLIDER_GRID_WIDTH = 61, SLIDER_GRID_LABELS = 62;

        private static readonly string[] GRID_LEVEL_ROW1 = { "OFF", "UNDERFOOT", "±1", "ALL" };
        private static readonly GridLevelMode[] GRID_LEVEL_ROW1_MODES = { GridLevelMode.Off, GridLevelMode.Underfoot, GridLevelMode.Adjacent, GridLevelMode.All };
        private static readonly string[] GRID_LEVEL_ROW2 = { "ABOVE", "BELOW", "NEAREST" };
        private static readonly GridLevelMode[] GRID_LEVEL_ROW2_MODES = { GridLevelMode.Above, GridLevelMode.Below, GridLevelMode.Nearest };
        private static readonly string[] GRID_DEPTH_OPTIONS = { "FAINT", "HIDDEN", "X-RAY" };
        private static readonly string[] GRID_LINE_OPTIONS = { "SOLID", "DASH-DOT" };
        private static readonly string[] GRID_COLOUR_OPTIONS = { "CYAN", "RED", "AMBER", "WHITE", "DARK" };
        private static readonly uint[] GRID_COLOURS = { 0x4FC3F7, 0xEF5350, 0xFFB300, 0xFFFFFF, 0x37474F };

        private static readonly KeyHint HINT_GRIDS_FOOT = new(() => $"{Key(InputAction.GridsPanel)} / Esc closes"); // P-A2: the dock's footer
        private static readonly KeyHint HINT_GRIDS_CYCLE = new(() => $"{KeyUpper(InputAction.GridsCycle)}: OFF / UNDERFOOT / ALL");

        private readonly GridOverlay _gridOverlay = new();
        private GridViewSettings _grids = new();
        private bool _gridsPanelOpen;
        private Vector4 _gridsPanelRect; // x, y, w, h of last frame's panel (0 w = none)

        // What the overlay was built for (rebuilt only when it changes) and this frame's levels
        private readonly List<int> _gridLevels = new();
        private int _gridBuildKey = int.MinValue;
        private int _gridLinkCount = -1, _gridHostCount;
        private string _gridInfoText;
        private int _gridInfoKey = int.MinValue;

        #endregion

        #region Settings

        /// <summary>Restores the saved grid view (or the defaults: grids off).</summary>
        private void RestoreGrids(GridViewSettings saved)
        {
            _grids = saved?.Copy().Clean() ?? new GridViewSettings();
            _gridBuildKey = int.MinValue;
        }

        /// <summary>The grid view for visibility.json (null at the defaults).</summary>
        private GridViewSettings GridsForSave() => _grids.IsDefault ? null : _grids.Copy();

        /// <summary>A grid setting changed: rebuild the lines, save with the model (dirty file / live sidecar).</summary>
        private void GridsChanged()
        {
            _grids.Clean();
            _gridBuildKey = int.MinValue;
            VisibilityChanged();
        }

        /// <summary>Counts host and link grids once (for the panel, the link toggle and the toasts).</summary>
        private void CountGrids()
        {
            if (_gridLinkCount >= 0) { return; }
            _gridHostCount = 0;
            _gridLinkCount = 0;
            foreach (GridLine grid in Scene.Grids)
            {
                if (!grid.IsValid) { continue; }
                if (grid.Link == 0) { _gridHostCount++; } else { _gridLinkCount++; }
            }
        }

        #endregion

        #region Keys and panel

        /// <summary>
        /// C: off → underfoot → all → off, with a toast saying what shows (or why nothing can).
        /// </summary>
        private void CycleGrids()
        {
            CountGrids();
            GridLevelMode next = GridLayout.Next(_grids.Mode);
            _grids.Mode = next;
            GridsChanged();
            Sound.Play(SoundId.UiClick);
            if (next == GridLevelMode.Off)
            {
                Toast("Grids off", 1.6f);
                return;
            }
            if (_gridHostCount + _gridLinkCount == 0)
            {
                Toast("This model has no grids (or the snapshot is older than grids: export again / F5 to pick them up).", 4f);
                return;
            }
            if (_gridHostCount == 0 && !_grids.LinkGrids)
            {
                Toast($"Grids: only the links have grids: tick Link grids in the grids panel ({Key(InputAction.GridsPanel)}).", 4f);
                return;
            }
            Toast($"Grids: {GridLayout.Label(next).ToLowerInvariant()} · {Key(InputAction.GridsPanel)} for options", 2f);
        }

        private void ToggleGridsPanel()
        {
            if (_gridsPanelOpen) { CloseGridsPanel(); }
            else { OpenGridsPanel(); }
        }

        /// <summary>
        /// Opens the panel. Walking: one panel at a time, the cursor is freed and the player stands still (like the sun
        /// panel). Clash mode keeps its cursor, flying and keys; the panel sits beside the dock.
        /// </summary>
        private void OpenGridsPanel()
        {
            if (_gridsPanelOpen) { return; }
            CountGrids();
            if (!_clashModeOn)
            {
                CloseSunPanel();
                CloseSunHours();
                CloseSectionEditor();
                ClosePhotoMode();
                _window.SetCaptured(false);
                _window.Input.ReleaseAll();
            }
            ShowUi();
            _gridsPanelOpen = true;
            Sound.Play(SoundId.UiClick);
        }

        private void CloseGridsPanel()
        {
            if (!_gridsPanelOpen) { return; }
            _gridsPanelOpen = false;
            _gridsPanelRect = default;
            _activeSlider = -1;
            if (_clashModeOn) { return; } // clash mode keeps its free cursor
            _window.Input.ReleaseAll();
            if (!_paused && _window.IsActive) { _window.SetCaptured(true); }
        }

        /// <summary>True while the walking grids panel has the keys (not in clash mode, which keeps its own).</summary>
        private bool GridsPanelHasKeys => _gridsPanelOpen && !_clashModeOn;

        /// <summary>Keys while the walking panel is open: Esc / Shift+G close, C cycles.</summary>
        private void UpdateGridsPanelKeys(InputState input)
        {
            if (input.Pressed(InputAction.Fullscreen)) { _window.ToggleFullscreen(); }
            if (input.Pressed(InputAction.Back) || input.Pressed(InputAction.GridsPanel))
            {
                CloseGridsPanel();
                return;
            }
            if (input.Pressed(InputAction.GridsCycle)) { CycleGrids(); }
            ClickGridNode(input); // grids round B: a click on a node stands you there
        }

        /// <summary>True when the mouse is over last frame's grids panel (clash mode: clicks there aren't for the 3D view).</summary>
        private bool OverGridsPanel(Vector2 mouse) =>
            _gridsPanelOpen && _gridsPanelRect.Z > 0f && mouse.X >= _gridsPanelRect.X && mouse.X < _gridsPanelRect.X + _gridsPanelRect.Z
            && mouse.Y >= _gridsPanelRect.Y && mouse.Y < _gridsPanelRect.Y + _gridsPanelRect.W;

        #endregion

        #region Drawing

        /// <summary>
        /// This frame's levels (they follow the player / eye), and a rebuild of the lines when anything they show changed.
        /// Allocation-free when nothing changed.
        /// </summary>
        private void UpdateGridLevels()
        {
            GridLevelMode mode = _grids.Mode;
            if (mode == GridLevelMode.Off || Scene.Grids.Length == 0 || Scene.Levels.Length == 0)
            {
                _gridLevels.Clear();
                if (_gridBuildKey != 0)
                {
                    _gridOverlay.Clear();
                    _gridBuildKey = 0;
                }
                return;
            }
            GridLayout.ShownLevels(Scene.Levels, mode, LevelIndexAt(_player.Feet.Z), Camera.Position.Z, _grids.StoreysOnly, _gridLevels);

            var hash = new HashCode();
            hash.Add((int)mode);
            hash.Add(_grids.StoreysOnly);
            hash.Add(_grids.RespectExtents);
            hash.Add(_grids.LinkGrids);
            hash.Add(_grids.LevelOutlines);
            hash.Add(_grids.Colour);
            hash.Add(System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(Scene));
            foreach (int level in _gridLevels) { hash.Add(level); }
            int key = hash.ToHashCode();
            if (key == 0) { key = 1; }
            if (key == _gridBuildKey) { return; }
            _gridBuildKey = key;

            uint rgb = LaunchSettings.TryParseColour(_grids.Colour, out uint parsed) ? parsed : 0x4FC3F7;
            _gridOverlay.Build(Scene.Grids, Scene.Levels, _gridLevels, _grids.LinkGrids, _grids.RespectExtents, _grids.LevelOutlines,
                Rgba.Hex(rgb), Rgba.Hex(rgb, 0.4f));
        }

        /// <summary>
        /// The grid lines (main view, with the markers: not with the UI hidden; P-C: in photo mode and photos when "Grid
        /// lines in the photo" is ticked, <paramref name="widthScale"/> keeping their width on 2–4× stills).
        /// </summary>
        private void DrawGrids(float widthScale = 1f)
        {
            UpdateGridLevels();
            if (_gridLevels.Count == 0) { return; }
            _gridOverlay.Draw(Camera, _grids.DepthIndex, _grids.Opacity, _grids.Width * widthScale, _grids.DashDot);
            DrawGridNodes(); // grids round B
        }

        /// <summary>Polish round P-C: true while the grids show (any level).</summary>
        private bool GridsShowing
        {
            get
            {
                UpdateGridLevels();
                return _gridLevels.Count > 0;
            }
        }

        /// <summary>
        /// The bubbles (grid name in a circle just past each end) and level tags, as 2D UI over the view: always on top,
        /// within the label distance and on screen. Allocation-free.
        /// </summary>
        private void DrawGridLabels(FontAtlas f)
        {
            if (_gridLevels.Count == 0 || (!_grids.Bubbles && !_grids.LevelTags)) { return; }
            uint rgb = LaunchSettings.TryParseColour(_grids.Colour, out uint parsed) ? parsed : 0x4FC3F7;
            uint ring = Rgba.Hex(rgb, MathF.Max(0.6f, _grids.Opacity));
            uint fill = Rgba.Hex(0x0C0E12, 0.8f);
            float radius = S(11);
            float limit = _grids.LabelDistance;
            float limit2 = limit * limit;
            int width = _window.Width, height = _window.Height;

            foreach (int index in _gridLevels)
            {
                if ((uint)index >= (uint)Scene.Levels.Length) { continue; }
                LevelInfo level = Scene.Levels[index];
                float z = level.Elevation + GridOverlay.LIFT;
                foreach (GridLine grid in Scene.Grids)
                {
                    if (!GridLayout.Included(grid, _grids.LinkGrids) || !GridLayout.ShowsAt(grid, level.Elevation, _grids.RespectExtents)) { continue; }
                    for (int end = 0; end < 2; end++)
                    {
                        Vector2 tip = end == 0 ? grid.Start : grid.End;
                        Vector2 outward = end == 0 ? grid.StartOutward : grid.EndOutward;
                        var world = new Vector3(tip, z);
                        if (Vector3.DistanceSquared(world, Camera.Position) > limit2) { continue; }
                        if (!Camera.WorldToScreen(world, out Vector2 screen)) { continue; }
                        if (screen.X < -S(60) || screen.Y < -S(60) || screen.X > width + S(60) || screen.Y > height + S(60)) { continue; }

                        // The bubble sits just past the end, along the line's direction on screen
                        Vector2 dir = Vector2.UnitX;
                        if (Camera.WorldToScreen(world + new Vector3(outward, 0f), out Vector2 ahead))
                        {
                            Vector2 d = ahead - screen;
                            if (d.LengthSquared() > 1e-4f) { dir = Vector2.Normalize(d); }
                        }
                        Vector2 centre = screen + dir * radius;

                        if (_grids.Bubbles)
                        {
                            _ui.Circle(centre.X, centre.Y, radius, fill, 24);
                            _ui.Ring(centre.X, centre.Y, radius, S(2), ring, 28);
                            UiFont font = grid.Name.Length > 2 ? f.Small : f.Bold;
                            _ui.TextCentred(font, centre.X, centre.Y - font.LineHeight * 0.5f, grid.Name, UiTheme.TEXT);
                        }
                        if (_grids.LevelTags)
                        {
                            Text.Clear().Append(level.Name).Append(" · ").AppendLength(level.Elevation, 3, plusSign: true);
                            _ui.Text(f.Small, centre.X + radius + S(4), centre.Y - f.Small.LineHeight * 0.5f, Text.Span, Rgba.WithAlpha(UiTheme.TEXT_SOFT, 0.85f));
                        }
                    }
                }
            }
        }

        /// <summary>
        /// The GRIDS panel: levels, what to draw, see-through, colour, opacity, width, label distance. Walking: the right-hand
        /// dock column (under the minimap); clash mode: left of the clash dock.
        /// </summary>
        private void BuildGridsPanel(FontAtlas f, InputState input)
        {
            if (!_gridsPanelOpen) { return; }
            if (!input.LeftDown && _activeSlider >= SLIDER_GRID_OPACITY && _activeSlider <= SLIDER_GRID_LABELS) { _activeSlider = -1; }
            CountGrids();

            // Polish round P-A2: the right-hand dock column (clash mode: left of the clash dock), the shared header,
            // scrolling body and footer
            DockFrame d = BeginDock("GRIDS & LEVELS", UiTheme.SCAN_LABEL, Rgba.WithAlpha(UiTheme.ACCENT, 0.5f), S(UiTheme.DOCK_WIDTH), _gridsDockScroll, notice: false);
            _gridsPanelRect = d.Rect;
            float ix = d.Ix, iw = d.Iw;
            float cy = BeginDockBody(d, _gridsDockScroll, input);
            _ui.Text(f.Small, ix, cy, GridInfo(), _gridHostCount + _gridLinkCount == 0 ? UiTheme.MEASURE_LABEL : UiTheme.TEXT_MUTED);
            cy += S(24);

            // Levels: two rows of choices (one is lit)
            _ui.Text(f.Body, ix, cy, "Levels", UiTheme.TEXT);
            _ui.TextRight(f.Small, ix + iw, cy + S(2), HINT_GRIDS_CYCLE.Text, UiTheme.TEXT_FAINT);
            cy += S(22);
            GridLevelMode mode = _grids.Mode;
            int row1 = Array.IndexOf(GRID_LEVEL_ROW1_MODES, mode);
            int picked1 = Segmented(f, input, ix, cy, iw, GRID_LEVEL_ROW1, row1);
            if (picked1 != row1 && picked1 >= 0) { SetGridMode(GRID_LEVEL_ROW1_MODES[picked1]); }
            cy += S(36);
            int row2 = Array.IndexOf(GRID_LEVEL_ROW2_MODES, mode);
            int picked2 = Segmented(f, input, ix, cy, iw, GRID_LEVEL_ROW2, row2);
            if (picked2 != row2 && picked2 >= 0) { SetGridMode(GRID_LEVEL_ROW2_MODES[picked2]); }
            cy += S(44);

            // What to draw (two columns)
            float col = iw * 0.5f;
            if (GridCheck(f, input, ix, cy, col, "Storeys only", _grids.StoreysOnly, out bool v)) { _grids.StoreysOnly = v; }
            if (GridCheck(f, input, ix + col, cy, col, "3D extents", _grids.RespectExtents, out v)) { _grids.RespectExtents = v; }
            cy += S(28);
            if (GridCheck(f, input, ix, cy, col, "Bubbles", _grids.Bubbles, out v)) { _grids.Bubbles = v; }
            if (GridCheck(f, input, ix + col, cy, col, "Level tags", _grids.LevelTags, out v)) { _grids.LevelTags = v; }
            cy += S(28);
            if (GridCheck(f, input, ix, cy, col, "Level outlines", _grids.LevelOutlines, out v)) { _grids.LevelOutlines = v; }
            if (GridCheck(f, input, ix + col, cy, col, "Nodes", _grids.Nodes, out v)) { _grids.Nodes = v; } // grids round B
            cy += S(28);
            if (_gridLinkCount > 0)
            {
                if (GridCheck(f, input, ix, cy, col, "Link grids", _grids.LinkGrids, out v)) { _grids.LinkGrids = v; }
            }
            else
            {
                _ui.Text(f.Body, ix, cy - S(1), "No link grids", UiTheme.TEXT_FAINT);
            }
            // Grids round B: the clash's grid location in clash comments (and so BCF), off by default
            if (GridCheck(f, input, ix + col, cy, col, "In clash comments", _grids.ClashComments, out v)) { _grids.ClashComments = v; }
            cy += S(36);

            // Grids round B: line style (solid by default)
            _ui.Text(f.Body, ix, cy + S(7), "Line", UiTheme.TEXT);
            int line = _grids.DashDot ? 1 : 0;
            int pickedLine = Segmented(f, input, ix + S(90), cy, iw - S(90), GRID_LINE_OPTIONS, line);
            if (pickedLine != line)
            {
                _grids.DashDot = pickedLine == 1;
                GridsChanged();
            }
            cy += S(42);

            // See-through and colour
            _ui.Text(f.Body, ix, cy, "Through walls", UiTheme.TEXT);
            cy += S(22);
            int depth = Segmented(f, input, ix, cy, iw, GRID_DEPTH_OPTIONS, _grids.DepthIndex);
            if (depth != _grids.DepthIndex)
            {
                _grids.DepthIndex = depth;
                GridsChanged();
            }
            cy += S(42);
            _ui.Text(f.Body, ix, cy, "Colour", UiTheme.TEXT);
            cy += S(22);
            int colour = GridColourIndex();
            int pickedColour = Segmented(f, input, ix, cy, iw, GRID_COLOUR_OPTIONS, colour);
            if (pickedColour != colour && pickedColour >= 0)
            {
                _grids.Colour = "#" + GRID_COLOURS[pickedColour].ToString("X6", System.Globalization.CultureInfo.InvariantCulture);
                GridsChanged();
            }
            cy += S(44);

            // Opacity, width, label distance
            Text.Clear().Append((long)MathF.Round(_grids.Opacity * 100f)).Append(" %");
            float opacity = Slider(f, input, SLIDER_GRID_OPACITY, ix, cy, iw, "Opacity", Text.Span, _grids.Opacity, GridViewSettings.MIN_OPACITY, 1f);
            if (_activeSlider == SLIDER_GRID_OPACITY && MathF.Abs(MathF.Round(opacity * 20f) / 20f - _grids.Opacity) > 1e-4f)
            {
                _grids.Opacity = MathF.Round(opacity * 20f) / 20f;
                GridsChanged();
            }
            cy += S(54);
            Text.Clear().Append(_grids.Width, 1).Append(" px");
            float lineWidth = Slider(f, input, SLIDER_GRID_WIDTH, ix, cy, iw, "Line width", Text.Span, _grids.Width, GridViewSettings.MIN_WIDTH, GridViewSettings.MAX_WIDTH);
            if (_activeSlider == SLIDER_GRID_WIDTH && MathF.Abs(MathF.Round(lineWidth * 2f) / 2f - _grids.Width) > 1e-4f)
            {
                _grids.Width = MathF.Round(lineWidth * 2f) / 2f;
                GridsChanged();
            }
            cy += S(54);
            Text.Clear().AppendLength(_grids.LabelDistance, 0);
            float labels = Slider(f, input, SLIDER_GRID_LABELS, ix, cy, iw, "Bubbles within", Text.Span, _grids.LabelDistance,
                GridViewSettings.MIN_LABEL_DISTANCE, GridViewSettings.MAX_LABEL_DISTANCE);
            if (_activeSlider == SLIDER_GRID_LABELS && MathF.Abs(MathF.Round(labels / 10f) * 10f - _grids.LabelDistance) > 1e-3f)
            {
                _grids.LabelDistance = MathF.Round(labels / 10f) * 10f;
                GridsChanged();
            }
            cy += S(58);

            if (SmallButton(f, input, ix, cy, S(110), S(28), "RESET"))
            {
                GridLevelMode keep = _grids.Mode;
                _grids = new GridViewSettings { Mode = keep };
                GridsChanged();
            }
            _ui.TextRight(f.Small, ix + iw, cy + S(8), "Saved with the model", UiTheme.TEXT_FAINT);
            cy += S(28);
            EndDockBody(_gridsDockScroll, input, cy);
            if (EndDock(d, null, HINT_GRIDS_FOOT.Text) == DOCK_CLOSE) { CloseGridsPanel(); }
        }

        /// <summary>A checkbox that records a change.</summary>
        private bool GridCheck(FontAtlas f, InputState input, float x, float y, float w, string label, bool value, out bool result)
        {
            result = Checkbox(f, input, x, y, w - S(6), label, value);
            if (result == value) { return false; }
            GridsChanged();
            return true;
        }

        private void SetGridMode(GridLevelMode mode)
        {
            _grids.Mode = mode;
            GridsChanged();
        }

        /// <summary>The colour preset in use, or -1 for a colour typed into the file.</summary>
        private int GridColourIndex()
        {
            if (!LaunchSettings.TryParseColour(_grids.Colour, out uint rgb)) { return 0; }
            return Array.IndexOf(GRID_COLOURS, rgb);
        }

        /// <summary>The panel's info line ("12 grids · 4 from links · 3 levels shown"), made again only when it changes.</summary>
        private string GridInfo()
        {
            int key = HashCode.Combine(_gridHostCount, _gridLinkCount, _gridLevels.Count, _grids.LinkGrids);
            if (key == _gridInfoKey && _gridInfoText != null) { return _gridInfoText; }
            _gridInfoKey = key;
            if (_gridHostCount + _gridLinkCount == 0)
            {
                _gridInfoText = "No grids in this snapshot (export again / F5 with this version).";
                return _gridInfoText;
            }
            string links = _gridLinkCount == 0 ? string.Empty : $" · {_gridLinkCount} in links{(_grids.LinkGrids ? string.Empty : " (off)")}";
            string levels = _gridLevels.Count == 0 ? "none shown" : _gridLevels.Count == 1 ? "1 level shown" : $"{_gridLevels.Count} levels shown";
            _gridInfoText = $"{_gridHostCount} grids{links} · {levels}";
            return _gridInfoText;
        }

        #endregion
    }
}
