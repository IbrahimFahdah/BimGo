using System.Numerics;
using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Game.Guns;
using BimGo.Physics;
using BimGo.Rendering;
using BimGo.Scene;
using InputState = BimGo.Platform.InputState; // the Platform type (another InputState is in scope)

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Grids round B: grid intersections ("nodes") on the shown levels: ring dots, a hover label ("A-1 : Level 2" and its
    /// coordinates in the readout's system), a click to go there (walking with the grids panel's free cursor: stand
    /// there; clash mode: fly to look at it), the Teleport gun blinking to an aimed node and the Measure gun snapping to
    /// one; grids on the minimap; and the clash grid location ("Near C-4 : Level 2") for the clash card, reports, AUTO
    /// GROUP by grid and (optionally) clash comments.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>Hover reach around a node (pixels, before UI scale).</summary>
        private const float GRID_HOVER_PIXELS = 12f;

        private GridNode[] _gridNodes;
        private GridLocator _gridLocator = GridLocator.Empty;
        private readonly Overlay3D _gridNodeOverlay = new();

        // The hovered node this frame: node index, level index and where it is drawn (scene-local, lifted)
        private bool _gridHoverValid;
        private int _gridHoverNode = -1, _gridHoverLevel = -1;
        private Vector3 _gridHoverWorld;

        // The hover label's text, made again only when the node, level or readout changes
        private int _gridHoverKey = int.MinValue;
        private string _gridHoverTitle, _gridHoverCoords;

        // Clash locations (the scene's grids never change in a session; a re-run may move a clash's point)
        private readonly Dictionary<string, (double X, double Y, double Z, GridLocation? Location)> _clashGridCache = new(StringComparer.Ordinal);

        #endregion

        #region Nodes and locations

        /// <summary>Finds the intersections and builds the clash locator (once, on first use).</summary>
        private void EnsureGridNodes()
        {
            if (_gridNodes != null) { return; }
            _gridNodes = GridNodes.Build(Scene.Grids);
            _gridLocator = GridLocator.Create(Scene.Grids, _gridNodes, Scene.Levels, Scene.OriginOffset);
            if (_gridNodes.Length > 0) { Utilities.Log_Utils.Write($"Grid intersections: {_gridNodes.Length}."); }
        }

        /// <summary>A clash's grid location (cached per clash and point), or null when the model has no intersections.</summary>
        private GridLocation? ClashGridLocation(ClashRecord clash)
        {
            if (clash == null) { return null; }
            EnsureGridNodes();
            if (_gridLocator.IsEmpty) { return null; }
            if (_clashGridCache.TryGetValue(clash.Id, out var cached) && cached.X == clash.X && cached.Y == clash.Y && cached.Z == clash.Z)
            {
                return cached.Location;
            }
            GridLocation? location = _gridLocator.Locate(clash.X, clash.Y, clash.Z, out GridLocation found) ? found : null;
            _clashGridCache[clash.Id] = (clash.X, clash.Y, clash.Z, location);
            return location;
        }

        /// <summary>" · Near C-4 : Level 2 (1.2 m)" for the clash card, or empty without grids.</summary>
        private string ClashGridSuffix(ClashRecord clash, bool offset)
        {
            if (ClashGridLocation(clash) is not GridLocation location) { return string.Empty; }
            string text = " · Near " + location.Text;
            return offset ? text + " (" + UnitFormat.Length(location.Offset, 1) + ")" : text;
        }

        /// <summary>A report's grid location function (thread-safe: the locator only), or null without grids.</summary>
        private Func<ClashRecord, string> ClashGridFunction()
        {
            EnsureGridNodes();
            GridLocator locator = _gridLocator;
            if (locator.IsEmpty) { return null; }
            return clash => clash == null ? null : locator.Text(clash.X, clash.Y, clash.Z);
        }

        /// <summary>AUTO GROUP by grid's lookup.</summary>
        private GridLocation? ClashGridLookup(ClashRecord clash) => ClashGridLocation(clash);

        /// <summary>True when the node is drawn on this level (link grids, extents).</summary>
        private bool GridNodeShows(in GridNode node, float elevation) =>
            GridLayout.Included(Scene.Grids[node.A], _grids.LinkGrids) && GridNodes.ShowsAt(node, Scene.Grids, elevation, _grids.RespectExtents);

        #endregion

        #region Drawing

        /// <summary>
        /// The ring dots on the shown levels within the bubble distance (with the grid lines; their see-through mode).
        /// </summary>
        private void DrawGridNodes()
        {
            if (!_grids.Nodes || _gridLevels.Count == 0) { return; }
            EnsureGridNodes();
            if (_gridNodes.Length == 0) { return; }

            uint rgb = LaunchSettings.TryParseColour(_grids.Colour, out uint parsed) ? parsed : 0x4FC3F7;
            uint ring = Rgba.Hex(rgb), core = Rgba.Hex(0x0C0E12, 0.85f);
            float limit2 = _grids.LabelDistance * _grids.LabelDistance;
            _gridNodeOverlay.Begin(Camera);
            foreach (int level in _gridLevels)
            {
                if ((uint)level >= (uint)Scene.Levels.Length) { continue; }
                float elevation = Scene.Levels[level].Elevation;
                for (int i = 0; i < _gridNodes.Length; i++)
                {
                    if (!GridNodeShows(_gridNodes[i], elevation)) { continue; }
                    var world = new Vector3(_gridNodes[i].Point, elevation + GridOverlay.LIFT);
                    if (Vector3.DistanceSquared(world, Camera.Position) > limit2) { continue; }
                    bool hovered = _gridHoverValid && i == _gridHoverNode && level == _gridHoverLevel;
                    _gridNodeOverlay.Dot(world, hovered ? 8f : 5.5f, hovered ? UiTheme.TEXT : ring, 14);
                    _gridNodeOverlay.Dot(world, hovered ? 5f : 3f, hovered ? ring : core, 12);
                }
            }

            int mode = _grids.DepthIndex;
            float opacity = MathF.Max(0.5f, _grids.Opacity);
            if (mode == 2) { _gridNodeOverlay.Draw(Camera, depthTest: false, alpha: opacity, additive: false); }
            else
            {
                if (mode == 0) { _gridNodeOverlay.Draw(Camera, depthTest: false, alpha: opacity * 0.25f, additive: false); }
                _gridNodeOverlay.Draw(Camera, depthTest: true, alpha: opacity, additive: false);
            }
        }

        /// <summary>
        /// The hovered node's label beside it: "A-1 : Level 2", its coordinates (the readout's system) and what a click
        /// or the gun does there. Always on top (UI).
        /// </summary>
        private void DrawGridHoverLabel(FontAtlas f)
        {
            if (!_gridHoverValid || !Camera.WorldToScreen(_gridHoverWorld, out Vector2 screen)) { return; }
            RefreshGridHoverText();
            string hint = GridHoverHint();
            float w = MathF.Max(UiBatch.Measure(f.Bold, _gridHoverTitle), UiBatch.Measure(f.Small, _gridHoverCoords));
            if (hint != null) { w = MathF.Max(w, UiBatch.Measure(f.Small, hint)); }
            w += S(20);
            float h = hint != null ? S(62) : S(44);
            float x = MathF.Min(screen.X + S(16), _window.Width - w - S(10));
            float y = Math.Clamp(screen.Y - h - S(10), S(10), _window.Height - h - S(10));
            uint rgb = LaunchSettings.TryParseColour(_grids.Colour, out uint parsed) ? parsed : 0x4FC3F7;
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, Rgba.Hex(rgb, 0.8f));
            _ui.Text(f.Bold, x + S(10), y + S(6), _gridHoverTitle, UiTheme.TEXT);
            _ui.Text(f.Small, x + S(10), y + S(26), _gridHoverCoords, UiTheme.COORDS);
            if (hint != null) { _ui.Text(f.Small, x + S(10), y + S(43), hint, UiTheme.TEXT_FAINT); }
        }

        /// <summary>What acting on the hovered node does now (or null).</summary>
        private string GridHoverHint()
        {
            if (_clashModeOn) { return "Click: fly there"; }
            if (_gridsPanelOpen) { return "Click: go there"; }
            if (_unarmed) { return null; }
            return _guns[_activeGun] switch
            {
                TeleportGun => "Teleport: blink here",
                MeasureGun => "Measure snaps here",
                _ => null
            };
        }

        /// <summary>The label's title and coordinate line, made again only when the node, level or readout changes.</summary>
        private void RefreshGridHoverText()
        {
            int key = HashCode.Combine(_gridHoverNode, _gridHoverLevel, (int)_coordinateReadout, UnitFormat.Current, UnitFormat.DecimalFeet);
            if (key == _gridHoverKey && _gridHoverTitle != null) { return; }
            _gridHoverKey = key;
            GridNode node = _gridNodes[_gridHoverNode];
            LevelInfo level = Scene.Levels[_gridHoverLevel];
            _gridHoverTitle = node.Name + " : " + level.Name;

            // The readout's system (off: shared when known, else project, else internal)
            CoordinateReadout readout = _coordinateReadout;
            if (readout == CoordinateReadout.Off || !IsReadoutAvailable(readout))
            {
                readout = _hasShared ? CoordinateReadout.Shared : _hasProjectBase ? CoordinateReadout.Project : CoordinateReadout.Internal;
            }
            Vector3 origin = Scene.OriginOffset;
            double ix = (double)node.Point.X + origin.X, iy = (double)node.Point.Y + origin.Y, iz = (double)level.Elevation + origin.Z;
            double a, b, c;
            switch (readout)
            {
                case CoordinateReadout.Shared:
                    _shared.Apply(ix, iy, iz, out a, out b, out c);
                    break;
                case CoordinateReadout.Project:
                    a = ix - _baseX;
                    b = iy - _baseY;
                    c = iz - _baseZ;
                    break;
                default:
                    a = ix;
                    b = iy;
                    c = iz;
                    break;
            }
            bool shared = readout == CoordinateReadout.Shared;
            TextBuffer t = Text.Clear().Append(shared ? "E " : "X ").AppendCoordinate(a).Append(shared ? " · N " : " · Y ").AppendCoordinate(b)
                .Append(shared ? " · ELEV " : " · Z ").AppendCoordinate(c);
            _gridHoverCoords = new string(t.Span);
        }

        #endregion

        #region Hover and acting

        /// <summary>
        /// Once a frame (with the aim): the node nearest the crosshair (cursor captured) or the mouse (cursor free),
        /// within a few pixels, on the shown levels and within the bubble distance. Then the Measure gun's snap. Nothing
        /// while the UI is hidden, paused or in photo mode, or over a panel.
        /// </summary>
        private void UpdateGridHover()
        {
            _gridHoverValid = false;
            if (!_grids.Nodes || _gridLevels.Count == 0 || _uiHidden || _paused || _photoOpen || _tourActive) { return; }
            EnsureGridNodes();
            if (_gridNodes.Length == 0) { return; }

            InputState input = _window.Input;
            Vector2 target = _window.IsCaptured ? new Vector2(Camera.ViewportWidth * 0.5f, Camera.ViewportHeight * 0.5f) : input.MousePosition;
            if (!_window.IsCaptured && (OverGridsPanel(target) || (_clashModeOn && OverClashDock(target)))) { return; }
            if (_clashModeOn && _clashToolHover != null) { return; } // a clash dot wins

            float reach = S(GRID_HOVER_PIXELS), best = reach * reach;
            float limit2 = _grids.LabelDistance * _grids.LabelDistance;
            foreach (int level in _gridLevels)
            {
                if ((uint)level >= (uint)Scene.Levels.Length) { continue; }
                float elevation = Scene.Levels[level].Elevation;
                for (int i = 0; i < _gridNodes.Length; i++)
                {
                    var world = new Vector3(_gridNodes[i].Point, elevation + GridOverlay.LIFT);
                    if (Vector3.DistanceSquared(world, Camera.Position) > limit2) { continue; }
                    if (!GridNodeShows(_gridNodes[i], elevation) || !Camera.WorldToScreen(world, out Vector2 screen)) { continue; }
                    float d = Vector2.DistanceSquared(screen, target);
                    if (d < best)
                    {
                        best = d;
                        _gridHoverValid = true;
                        _gridHoverNode = i;
                        _gridHoverLevel = level;
                        _gridHoverWorld = world;
                    }
                }
            }

            // The Measure gun snaps to an aimed node (distance and angle ends, area corners)
            if (_gridHoverValid && _window.IsCaptured && !_unarmed && _guns[_activeGun] is MeasureGun)
            {
                Vector3 point = _gridHoverWorld - new Vector3(0f, 0f, GridOverlay.LIFT);
                _aim.HasHit = true;
                _aim.Hit.Point = point;
                _aim.Hit.Normal = Vector3.UnitZ;
                _aim.Hit.Distance = Vector3.Distance(Camera.Position, point);
                _aim.Hit.Element = -1;
                _aim.Hit.DynamicId = 0;
            }
        }

        /// <summary>
        /// The Teleport gun's target when it aims at a node: a free standing spot at (or just beside) the node on its
        /// level. False when no node is aimed at or nowhere near it has room.
        /// </summary>
        public bool GridNodeTeleportTarget(out Vector3 feet, out float distance)
        {
            feet = default;
            distance = 0f;
            if (!_gridHoverValid || !_window.IsCaptured) { return false; }
            distance = Vector3.Distance(Camera.Position, _gridHoverWorld);
            return FreeFeetNear(_gridNodes[_gridHoverNode].Point, Scene.Levels[_gridHoverLevel].Elevation, out feet);
        }

        /// <summary>
        /// A spot to stand at or near a plan point on a level: the floor found under it (within 0.6 m of the level), else
        /// the level itself; the point first, then rings 0.6 / 1.0 / 1.5 m round it (a column often stands on the node).
        /// </summary>
        private bool FreeFeetNear(Vector2 point, float elevation, out Vector3 feet)
        {
            feet = default;
            ReadOnlySpan<float> rings = stackalloc float[] { 0f, 0.6f, 1.0f, 1.5f };
            foreach (float r in rings)
            {
                int steps = r == 0f ? 1 : 8;
                for (int k = 0; k < steps; k++)
                {
                    float angle = k * MathF.Tau / steps;
                    var p = point + new Vector2(MathF.Cos(angle), MathF.Sin(angle)) * r;
                    float z = elevation;
                    if (Pick(new Vector3(p, elevation + 1.0f), -Vector3.UnitZ, 1.6f, out RayHit floor) && floor.Normal.Z > 0.7f
                        && MathF.Abs(floor.Point.Z - elevation) < 0.6f)
                    {
                        z = floor.Point.Z;
                    }
                    var candidate = new Vector3(p, z + 0.02f);
                    if (!_player.Controller.Overlaps(candidate + new Vector3(0f, 0f, 0.01f), CharacterController.STAND_HEIGHT))
                    {
                        feet = candidate;
                        return true;
                    }
                }
            }
            return false;
        }

        /// <summary>
        /// A click on the hovered node: walking (grids panel open), stand there; clash mode, fly to look at it.
        /// </summary>
        /// <returns>True when a node took the click.</returns>
        private bool ClickGridNode(InputState input)
        {
            if (!_gridHoverValid || !input.LeftPressed || OverlayOpen) { return false; }
            input.ConsumeClicks();
            RefreshGridHoverText();
            GridNode node = _gridNodes[_gridHoverNode];
            float elevation = Scene.Levels[_gridHoverLevel].Elevation;
            if (_clashModeOn)
            {
                // Look at the node from 7 m back along the current heading and 4 m up
                var look = new Vector3(node.Point, elevation + 0.5f);
                var heading = new Vector3(MathF.Cos(_player.Yaw), MathF.Sin(_player.Yaw), 0f);
                Vector3 eye = look - heading * 7f + new Vector3(0f, 0f, 4f);
                Vector3 d = look - eye;
                float pitch = MathF.Atan2(d.Z, new Vector2(d.X, d.Y).Length());
                FlyToClashView(new ClashView(default, eye, _player.Yaw, pitch), animate: !_clashInstant);
                Sound.Play(SoundId.UiClick);
                Toast(_gridHoverTitle, 1.6f);
                return true;
            }
            if (!FreeFeetNear(node.Point, elevation, out Vector3 feet))
            {
                Sound.Play(SoundId.Error);
                Toast($"No room to stand at {_gridHoverTitle}", 2.5f, important: true);
                return true;
            }
            _player.TeleportTo(feet);
            Sound.Play(SoundId.Blink);
            Flash(UiTheme.TELEPORT, 0.1f);
            Toast(_gridHoverTitle, 1.6f);
            return true;
        }

        #endregion

        #region Minimap

        /// <summary>
        /// The grids of the level underfoot on the minimap (when grids are on): thin lines clipped to the map, the grid's
        /// name where it leaves the map (or at its end inside it).
        /// </summary>
        private void DrawMinimapGrids(FontAtlas f, float mapX, float mapY, float mapW, float mapH, float cx, float cy, float metresPerPixel)
        {
            if (_grids.Mode == GridLevelMode.Off || Scene.Grids.Length == 0 || Scene.Levels.Length == 0) { return; }
            float elevation = Scene.Levels[LevelIndexAt(_player.Feet.Z)].Elevation;
            uint rgb = LaunchSettings.TryParseColour(_grids.Colour, out uint parsed) ? parsed : 0x4FC3F7;
            uint line = Rgba.Hex(rgb, 0.7f), label = Rgba.Hex(rgb);
            var min = new Vector2(mapX, mapY);
            var max = new Vector2(mapX + mapW, mapY + mapH);
            Vector2 ToMap(Vector2 p) => new(cx + (p.X - _player.Feet.X) / metresPerPixel, cy - (p.Y - _player.Feet.Y) / metresPerPixel);

            foreach (GridLine grid in Scene.Grids)
            {
                if (!GridLayout.Included(grid, _grids.LinkGrids) || !GridLayout.ShowsAt(grid, elevation, _grids.RespectExtents)) { continue; }
                for (int i = 1; i < grid.Points.Length; i++)
                {
                    Vector2 a = ToMap(grid.Points[i - 1]), b = ToMap(grid.Points[i]);
                    if (ClipToRect(ref a, ref b, min, max)) { _ui.Line(a.X, a.Y, b.X, b.Y, S(1), line); }
                }

                // The name at each end: where the line enters the map from that end (or the end itself inside it)
                for (int end = 0; end < 2; end++)
                {
                    int i0 = end == 0 ? 0 : grid.Points.Length - 1;
                    int step = end == 0 ? 1 : -1;
                    for (int i = i0; i + step >= 0 && i + step < grid.Points.Length; i += step)
                    {
                        Vector2 a = ToMap(grid.Points[i]), b = ToMap(grid.Points[i + step]);
                        if (!ClipToRect(ref a, ref b, min, max)) { continue; }
                        float lw = UiBatch.Measure(f.Small, grid.Name) + S(6);
                        float lx = Math.Clamp(a.X - lw * 0.5f, mapX, mapX + mapW - lw);
                        float ly = Math.Clamp(a.Y - S(7), mapY, mapY + mapH - S(14));
                        _ui.Rect(lx, ly, lw, S(14), Rgba.Hex(0x0C0E12, 0.8f));
                        _ui.TextCentred(f.Small, lx + lw * 0.5f, ly, grid.Name, label);
                        break;
                    }
                }
            }
        }

        /// <summary>Clips a segment to a rectangle (Liang–Barsky); false when it misses.</summary>
        private static bool ClipToRect(ref Vector2 a, ref Vector2 b, Vector2 min, Vector2 max)
        {
            float t0 = 0f, t1 = 1f;
            Vector2 d = b - a;
            ReadOnlySpan<float> p = stackalloc float[] { -d.X, d.X, -d.Y, d.Y };
            ReadOnlySpan<float> q = stackalloc float[] { a.X - min.X, max.X - a.X, a.Y - min.Y, max.Y - a.Y };
            for (int i = 0; i < 4; i++)
            {
                if (MathF.Abs(p[i]) < 1e-9f)
                {
                    if (q[i] < 0f) { return false; }
                    continue;
                }
                float t = q[i] / p[i];
                if (p[i] < 0f) { if (t > t1) { return false; } if (t > t0) { t0 = t; } }
                else { if (t < t0) { return false; } if (t < t1) { t1 = t; } }
            }
            Vector2 start = a;
            a = start + d * t0;
            b = start + d * t1;
            return true;
        }

        #endregion
    }
}
