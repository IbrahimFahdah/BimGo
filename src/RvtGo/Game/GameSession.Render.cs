using System.Numerics;
using RvtGo.Game.Guns;
using RvtGo.Rendering;
using RvtGo.Scene;
using Gl = RvtGo.Native.Gl;

// The class belongs to the Game namespace
namespace RvtGo.Game
{
    /// <summary>
    /// Rendering: 3D passes, minimap and HUD.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private readonly Vector4[] _mapPlanes = new Vector4[6];

        private static readonly (string Key, string Action)[] HELP_ROWS =
        {
            ("WASD", "Move"),
            ("SPACE / CTRL", "Jump / Crouch"),
            ("SHIFT", "Run"),
            ("V", "Fly / no-clip"),
            ("PGUP / PGDN", "Level up / down"),
            ("H / SHIFT+H", "Home / Set home"),
            ("1–4 · WHEEL", "Select gun"),
            ("X", "Clear gun markers"),
            ("TAB · ESC", "Map · Pause"),
            ("F11", "Fullscreen"),
            ("F1", "Hide help")
        };

        #endregion

        /// <summary>
        /// Renders one frame (scene into the off-screen target, then minimap and UI on the window).
        /// </summary>
        private void Render()
        {
            int width = _window.Width, height = _window.Height;

            // ---- 3D scene into the (optionally multisampled) target
            _target.Ensure(width, height, _msaa);
            _target.Bind();
            Vector3 fog = SceneRenderer.FOG_COLOUR;
            Gl.ClearColor(fog.X, fog.Y, fog.Z, 1f);
            Gl.Clear(Gl.COLOR_BUFFER_BIT | Gl.DEPTH_BUFFER_BIT);
            Gl.Enable(Gl.DEPTH_TEST);
            Gl.DepthFunc(Gl.LEQUAL);
            Gl.Disable(Gl.CULL_FACE);
            Gl.Disable(Gl.BLEND);

            _renderer.DrawSky(Camera);

            var p = new SceneDrawParams
            {
                ViewProjection = Camera.ViewProjection,
                Planes = Camera.Planes,
                Eye = Camera.Position,
                Whitecard = _whitecard,
                Plan = false,
                ClipZ = new Vector2(-1e7f, 1e7f),
                FogDensity = 0.0022f
            };

            _renderer.DrawStatic(p, _categoryVisible, transparent: false);
            _renderer.DrawGround(Camera, _groundZ);

            // Scan highlight
            Gun active = _guns[_activeGun];
            int highlight = _paused ? -1 : active.HighlightElement;
            if (highlight >= 0 && _pickMask[highlight])
            {
                Gl.Enable(Gl.BLEND);
                Gl.BlendFunc(Gl.SRC_ALPHA, Gl.ONE_MINUS_SRC_ALPHA);
                Gl.Enable(Gl.POLYGON_OFFSET_FILL);
                Gl.PolygonOffset(-1f, -2f);
                Vector4 colour = Rgba.ToVector(UiTheme.SCAN);
                colour.W = active.HighlightStrength;
                _renderer.DrawElementHighlight(p, highlight, colour);
                Gl.Disable(Gl.POLYGON_OFFSET_FILL);
                Gl.Disable(Gl.BLEND);
            }

            // Transparent pass (glass etc.)
            Gl.Enable(Gl.BLEND);
            Gl.BlendFunc(Gl.SRC_ALPHA, Gl.ONE_MINUS_SRC_ALPHA);
            Gl.DepthMask(false);
            _renderer.DrawStatic(p, _categoryVisible, transparent: true);
            Gl.DepthMask(true);
            Gl.Disable(Gl.BLEND);

            // Markers: depth-tested, then a faint x-ray copy so markers behind walls stay discoverable
            _overlay.Begin(Camera);
            for (int i = 0; i < _guns.Length; i++) { _guns[i].DrawWorld(_overlay, i == _activeGun); }
            _overlay.Draw(Camera, depthTest: true, alpha: 1f, additive: false);
            _overlay.Draw(Camera, depthTest: false, alpha: 0.16f, additive: false);

            _target.BlitToWindow();

            // ---- Window pass: minimap 3D, then all 2D UI in one batch
            Gl.Viewport(0, 0, width, height);
            float mapX = width - S(20) - S(220), mapY = S(20);
            if (_showMap && !_paused) { DrawMinimapPlan(mapX + S(8), mapY + S(30), S(204), S(170)); }

            if (_paused)
            {
                BuildPauseMenu();
            }
            else
            {
                BuildHud(mapX, mapY);
                if (IsEditingComment) { BuildCommentEditor(); }
            }
            _ui.Flush(width, height);
        }

        #region Minimap

        /// <summary>
        /// Draws the plan view (cut at 1.2 m above the current level) into a scissored viewport.
        /// </summary>
        private void DrawMinimapPlan(float x, float y, float w, float h)
        {
            int height = _window.Height;
            int vx = (int)x, vy = height - (int)(y + h), vw = Math.Max(1, (int)w), vh = Math.Max(1, (int)h);

            Gl.Enable(Gl.SCISSOR_TEST);
            Gl.Scissor(vx, vy, vw, vh);
            Gl.Viewport(vx, vy, vw, vh);
            Vector4 background = Rgba.ToVector(UiTheme.MAP_BACKGROUND);
            Gl.ClearColor(background.X, background.Y, background.Z, 1f);
            Gl.Clear(Gl.COLOR_BUFFER_BIT | Gl.DEPTH_BUFFER_BIT);

            float elevation = Scene.Levels.Length > 0 ? Scene.Levels[LevelIndexAt(_player.Feet.Z)].Elevation : _player.Feet.Z;
            float metresAcross = MapMetresAcross;
            float metresHigh = metresAcross * h / w;

            var eye = new Vector3(_player.Feet.X, _player.Feet.Y, elevation + 60f);
            Matrix4x4 view = Matrix4x4.CreateLookAt(eye, eye - Vector3.UnitZ, Vector3.UnitY);
            Matrix4x4 projection = FpsCamera.Orthographic(metresAcross, metresHigh, 1f, 200f);
            Matrix4x4 viewProjection = view * projection;
            FpsCamera.ExtractPlanes(viewProjection, _mapPlanes);

            var p = new SceneDrawParams
            {
                ViewProjection = viewProjection,
                Planes = _mapPlanes,
                Eye = eye,
                Whitecard = _whitecard,
                Plan = true,
                ClipZ = new Vector2(elevation - 0.3f, elevation + 1.2f),
                FogDensity = 0f
            };
            Gl.Enable(Gl.DEPTH_TEST);
            _renderer.DrawStatic(p, _categoryVisible, transparent: false);

            Gl.Disable(Gl.SCISSOR_TEST);
            Gl.Viewport(0, 0, _window.Width, _window.Height);
        }

        private const float MapMetresAcross = 34f;

        /// <summary>
        /// Draws the minimap frame, header and markers (UI layer).
        /// </summary>
        private void DrawMinimapOverlay(float x, float y)
        {
            FontAtlas f = _ui.Atlas;
            float w = S(220), h = S(208);
            float mapX = x + S(8), mapY = y + S(30), mapW = S(204), mapH = S(170);

            // Frame: header strip and border only (the plan itself was drawn in 3D)
            _ui.Rect(x, y, w, S(30), UiTheme.PANEL);
            _ui.Rect(x, y + S(30), S(8), h - S(30), UiTheme.PANEL);
            _ui.Rect(x + w - S(8), y + S(30), S(8), h - S(30), UiTheme.PANEL);
            _ui.Rect(x + S(8), y + h - S(8), w - S(16), S(8), UiTheme.PANEL);
            _ui.Outline(x, y, w, h, MathF.Max(1f, MathF.Round(UiScale)), UiTheme.PANEL_BORDER);

            Text.Clear().Append("MAP · ").Append(_levelNamesUpper.Length > 0 ? _levelNamesUpper[LevelIndexAt(_player.Feet.Z)] : "\u2014");
            _ui.Text(f.Small, x + S(8), y + S(9), Text.Span, UiTheme.TEXT_MUTED, S(1f));
            _ui.TextRight(f.Small, x + w - S(8), y + S(9), "TAB", UiTheme.TEXT_MUTED, S(1f));

            float metresPerPixel = MapMetresAcross / mapW;
            float cx = mapX + mapW * 0.5f, cy = mapY + mapH * 0.5f;
            float levelZ = _player.Feet.Z;
            int levelIndex = LevelIndexAt(levelZ);

            // Portals and comments on this level
            for (int i = 0; i < 2; i++)
            {
                if (!_portalGun.IsActive(i)) { continue; }
                Vector3 c = _portalGun.CentreOf(i);
                if (LevelIndexAt(c.Z - 1f) != levelIndex) { continue; }
                MapDot(c, PortalGun.ColourOf(i), S(4));
            }
            foreach (CommentRecord record in Comments.Comments)
            {
                if (LevelIndexAt(record.Local.Z - 0.5f) != levelIndex) { continue; }
                MapDot(record.Local, UiTheme.COMMENT, S(3.5f));
            }

            // View cone and player arrow (north up, screen Y down)
            float angle = -_player.Yaw;
            float halfFov = _fov * MathF.PI / 360f;
            _ui.Wedge(cx, cy, S(56), angle - halfFov, angle + halfFov, Rgba.WithAlpha(UiTheme.ACCENT, 0.13f));
            var forward = new Vector2(MathF.Cos(angle), MathF.Sin(angle));
            var side = new Vector2(-forward.Y, forward.X);
            Vector2 tip = new Vector2(cx, cy) + forward * S(10);
            Vector2 left = new Vector2(cx, cy) - forward * S(6) + side * S(7);
            Vector2 right = new Vector2(cx, cy) - forward * S(6) - side * S(7);
            Vector2 notch = new Vector2(cx, cy) - forward * S(2);
            _ui.Triangle(tip.X, tip.Y, left.X, left.Y, notch.X, notch.Y, UiTheme.ACCENT);
            _ui.Triangle(tip.X, tip.Y, notch.X, notch.Y, right.X, right.Y, UiTheme.ACCENT);

            void MapDot(Vector3 world, uint colour, float radius)
            {
                float mx = cx + (world.X - _player.Feet.X) / metresPerPixel;
                float my = cy - (world.Y - _player.Feet.Y) / metresPerPixel;
                if (mx < mapX + radius || mx > mapX + mapW - radius || my < mapY + radius || my > mapY + mapH - radius) { return; }
                _ui.Circle(mx, my, radius, colour, 12);
            }
        }

        #endregion

        #region HUD

        /// <summary>
        /// Builds the in-game HUD.
        /// </summary>
        private void BuildHud(float mapX, float mapY)
        {
            FontAtlas f = _ui.Atlas;
            int width = _window.Width, height = _window.Height;
            Gun active = _guns[_activeGun];

            // Screen flash (portals)
            if (_clock < _flashUntil)
            {
                float t = (_flashUntil - _clock) / MathF.Max(_flashLength, 0.01f);
                _ui.Rect(0, 0, width, height, Rgba.WithAlpha(_flashColour, 0.35f * t));
            }

            // World-anchored labels
            for (int i = 0; i < _guns.Length; i++) { _guns[i].DrawLabels(_ui, i == _activeGun); }

            // Crosshair
            float cx = MathF.Round(width * 0.5f), cy = MathF.Round(height * 0.5f);
            float t1 = S(2f), gap = S(5), arm = S(9);
            _ui.Rect(cx - t1 * 0.5f, cy - gap - arm, t1, arm, UiTheme.TEXT);
            _ui.Rect(cx - t1 * 0.5f, cy + gap, t1, arm, UiTheme.TEXT);
            _ui.Rect(cx - gap - arm, cy - t1 * 0.5f, arm, t1, UiTheme.TEXT);
            _ui.Rect(cx + gap, cy - t1 * 0.5f, arm, t1, UiTheme.TEXT);
            _ui.Circle(cx, cy, S(1.8f), active.Colour, 10);

            if (!_window.IsCaptured && !IsEditingComment)
            {
                const string hint = "Click to look around";
                float hintWidth = UiBatch.Measure(f.Body, hint) + S(24);
                _ui.Panel(cx - hintWidth * 0.5f, cy + S(28), hintWidth, S(28), UiTheme.PANEL, UiTheme.PANEL_BORDER);
                _ui.TextCentred(f.Body, cx, cy + S(34), hint, UiTheme.TEXT);
            }

            BuildStatusPanel(f);

            // Minimap and the gun's context panel beneath it
            if (_showMap) { DrawMinimapOverlay(mapX, mapY); }
            float panelTop = _showMap ? mapY + S(208) + S(12) : S(20);
            float panelWidth = S(260), panelX = width - S(20) - panelWidth;
            float panelHeight = S(active.PanelHeight) + S(24);
            _ui.Panel(panelX, panelTop, panelWidth, panelHeight, UiTheme.PANEL, UiTheme.PANEL_BORDER);
            active.DrawPanel(_ui, panelX + S(14), panelTop + S(12), panelWidth - S(28));

            BuildHelp(f, height);
            BuildGunBar(f, width, height, active);
            BuildToast(f, width);
        }

        /// <summary>
        /// Top-left status: title, FPS, mode, level, ground, view.
        /// </summary>
        private void BuildStatusPanel(FontAtlas f)
        {
            float x = S(20), y = S(20), w = S(230), h = S(126);
            _ui.Panel(x, y, w, h, UiTheme.PANEL, UiTheme.PANEL_BORDER);
            _ui.Text(f.Bold, x + S(14), y + S(11), "RVTGO", UiTheme.TEXT, S(2f));

            if (_showFps)
            {
                Text.Clear().Append(_fps, 0).Append(" fps · ").Append(_frameMs, 1).Append(" ms");
                _ui.TextRight(f.Mono, x + w - S(14), y + S(14), Text.Span, UiTheme.GOOD);
            }

            float labelX = x + S(14), valueX = x + S(14) + S(70);
            float rowY = y + S(40);
            float row = S(20);

            _ui.Text(f.Body, labelX, rowY, "MODE", UiTheme.TEXT_MUTED);
            _ui.Text(f.Body, valueX, rowY, _player.Flying ? "FLY" : _player.Controller.Crouching ? "CROUCH" : "WALK", UiTheme.TEXT);
            rowY += row;

            _ui.Text(f.Body, labelX, rowY, "LEVEL", UiTheme.TEXT_MUTED);
            if (Scene.Levels.Length > 0)
            {
                LevelInfo level = Scene.Levels[LevelIndexAt(_player.Feet.Z)];
                float used = _ui.Text(f.Body, valueX, rowY, level.Name, UiTheme.TEXT);
                Text.Clear().Append(level.Elevation, 3, plusSign: true);
                _ui.Text(f.Mono, valueX + used + S(6), rowY + S(1), Text.Span, UiTheme.TEXT_SOFT);
            }
            else
            {
                _ui.Text(f.Body, valueX, rowY, "—", UiTheme.TEXT);
            }
            rowY += row;

            _ui.Text(f.Body, labelX, rowY, "GROUND", UiTheme.TEXT_MUTED);
            Text.Clear().Append(_groundZ, 3).Append(" m");
            _ui.Text(f.Mono, valueX, rowY + S(1), Text.Span, UiTheme.TEXT);
            rowY += row;

            _ui.Text(f.Body, labelX, rowY, "VIEW", UiTheme.TEXT_MUTED);
            _ui.Text(f.Body, valueX, rowY, _whitecard ? "Whitecard" : "Material colour", UiTheme.TEXT);
        }

        /// <summary>
        /// Bottom-left controls hint (F1 toggles).
        /// </summary>
        private void BuildHelp(FontAtlas f, int height)
        {
            float x = S(20);
            if (!_showHelp)
            {
                _ui.Text(f.Mono, x, height - S(36), "F1  Help", UiTheme.TEXT_MUTED);
                return;
            }

            float row = S(17);
            float h = HELP_ROWS.Length * row + S(20);
            float y = height - S(20) - h;
            float keyWidth = S(118);
            _ui.Panel(x, y, keyWidth + S(140), h, Rgba.Hex(0x0C0E12, 0.66f), Rgba.Hex(0xFFFFFF, 0.1f));

            float rowY = y + S(10);
            for (int i = 0; i < HELP_ROWS.Length; i++)
            {
                bool last = i == HELP_ROWS.Length - 1;
                _ui.Text(f.Mono, x + S(12), rowY, HELP_ROWS[i].Key, last ? UiTheme.TEXT_MUTED : UiTheme.TEXT);
                _ui.Text(f.Body, x + S(12) + keyWidth, rowY - S(1), HELP_ROWS[i].Action, last ? UiTheme.TEXT_MUTED : UiTheme.TEXT_SOFT);
                rowY += row;
            }
        }

        /// <summary>
        /// Bottom-centre gun bar with LMB / RMB hints.
        /// </summary>
        private void BuildGunBar(FontAtlas f, int width, int height, Gun active)
        {
            float buttonW = S(132), buttonH = S(56), gap = S(6);
            float total = _guns.Length * buttonW + (_guns.Length - 1) * gap;
            float x = MathF.Round(width * 0.5f - total * 0.5f);
            float y = height - S(20) - buttonH;

            for (int i = 0; i < _guns.Length; i++)
            {
                Gun gun = _guns[i];
                bool selected = i == _activeGun;
                float bx = x + i * (buttonW + gap);
                _ui.Rect(bx, y, buttonW, buttonH, Rgba.Hex(0x0C0E12, selected ? 0.9f : 0.6f));
                _ui.Outline(bx, y, buttonW, buttonH, S(2), selected ? gun.Colour : Rgba.Hex(0xFFFFFF, 0.14f));
                float textY = y + buttonH * 0.5f - f.Bold.LineHeight * 0.5f;
                float keyWidth = _ui.Text(f.Mono, bx + S(12), textY + S(2), gun.Key, selected ? gun.Colour : UiTheme.TEXT_MUTED);
                _ui.Text(f.Bold, bx + S(12) + keyWidth + S(10), textY, gun.Name, UiTheme.TEXT, S(1f));
            }

            // Hints
            float hintY = y - S(8) - S(24);
            float lmbWidth = HintWidth(f, active.HintPrimary);
            float rmbWidth = HintWidth(f, active.HintSecondary);
            float hintX = width * 0.5f - (lmbWidth + rmbWidth + S(14)) * 0.5f;
            Hint(f, hintX, hintY, "LMB", active.HintPrimary, active.Colour);
            Hint(f, hintX + lmbWidth + S(14), hintY, "RMB", active.HintSecondary, active.Colour);
        }

        private float HintWidth(FontAtlas f, string text) =>
            UiBatch.Measure(f.Mono, "LMB") + S(6) + UiBatch.Measure(f.Body, text) + S(16);

        private void Hint(FontAtlas f, float x, float y, string button, string text, uint colour)
        {
            _ui.Rect(x, y, HintWidth(f, text), S(24), Rgba.Hex(0x0C0E12, 0.7f));
            float used = _ui.Text(f.Mono, x + S(8), y + S(5), button, colour);
            _ui.Text(f.Body, x + S(8) + used + S(6), y + S(4), text, Rgba.Hex(0xE5E7EB));
        }

        /// <summary>
        /// Top-centre transient message.
        /// </summary>
        private void BuildToast(FontAtlas f, int width)
        {
            if (_toast == null || _clock >= _toastUntil) { return; }
            float remaining = _toastUntil - _clock;
            float alpha = Math.Clamp(remaining / 0.4f, 0f, 1f);
            float textWidth = UiBatch.Measure(f.Body, _toast);
            float w = textWidth + S(32), h = S(32);
            float x = width * 0.5f - w * 0.5f, y = S(20);
            _ui.Panel(x, y, w, h, Rgba.WithAlpha(UiTheme.PANEL_STRONG, 0.88f * alpha), Rgba.WithAlpha(UiTheme.ACCENT, 0.6f * alpha));
            _ui.Text(f.Body, x + S(16), y + S(7), _toast, Rgba.WithAlpha(UiTheme.TEXT, alpha));
        }

        #endregion
    }
}
