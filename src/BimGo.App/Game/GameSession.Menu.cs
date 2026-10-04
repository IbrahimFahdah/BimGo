using System.Numerics;
using BimGo.Audio;
using BimGo.Format;
using BimGo.Game.Guns;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// The Esc pause menu (immediate-mode widgets) and the in-game comment editor.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private int _activeSlider = -1;

        private bool _editing;
        private Vector3 _editPoint;
        private long _editElement;
        private string _editLevel;
        private readonly char[] _editChars = new char[280];
        private int _editLength;
        private CommentRecord _editRecord;

        private static readonly string[] COLOUR_OPTIONS = { "Whitecard", "Material" };
        private static readonly string[] MSAA_OPTIONS = { "Off", "2x", "4x" };

        #endregion

        #region Comment editor

        /// <summary>True while the comment text box is open.</summary>
        public bool IsEditingComment => _editing;

        /// <summary>Where the comment being typed will go.</summary>
        public Vector3 EditPoint => _editPoint;

        /// <summary>
        /// Opens the comment text box for a new marker.
        /// </summary>
        public void BeginCommentEdit(Vector3 point, long elementId, string level)
        {
            _editing = true;
            _editRecord = null;
            _editPoint = point;
            _editElement = elementId;
            _editLevel = level;
            _editLength = 0;
            _window.Input.ReleaseAll();
        }

        /// <summary>
        /// Opens the comment text box on an existing comment (its text ready to change).
        /// </summary>
        public void BeginCommentEdit(CommentRecord record)
        {
            if (record == null) { return; }
            _editing = true;
            _editRecord = record;
            _editPoint = record.Local;
            _editElement = record.ElementId;
            _editLevel = string.IsNullOrEmpty(record.Level) ? null : record.Level;
            _editLength = Math.Min(record.Text?.Length ?? 0, _editChars.Length);
            record.Text?.CopyTo(0, _editChars, 0, _editLength);
            _window.Input.ReleaseAll();
        }

        /// <summary>
        /// Consumes typed characters: Enter saves, Esc cancels, Backspace deletes.
        /// </summary>
        private void UpdateCommentEditor(InputState input)
        {
            foreach (char c in input.Chars)
            {
                switch (c)
                {
                    case '\b':
                        if (_editLength > 0) { _editLength--; }
                        break;

                    case '\r':
                        CommitComment();
                        return;

                    case (char)27:
                        _editing = false;
                        Toast(_editRecord != null ? "Edit cancelled" : "Comment cancelled");
                        _editRecord = null;
                        return;

                    default:
                        if (c >= ' ' && _editLength < _editChars.Length) { _editChars[_editLength++] = c; }
                        break;
                }
            }
        }

        private void CommitComment()
        {
            _editing = false;
            string text = new string(_editChars, 0, _editLength).Trim();
            CommentRecord editing = _editRecord;
            _editRecord = null;

            if (editing != null)
            {
                if (text.Length == 0)
                {
                    Toast("Empty text: comment not changed (RMB on the marker removes it)");
                    return;
                }
                Comments.Update(editing, text);
                Sound.Play(SoundId.CommentPlace);
                Toast(Comments.LastError ?? "Comment updated");
                return;
            }

            if (text.Length == 0)
            {
                Toast("Empty comment discarded");
                return;
            }

            Comments.Add(_editPoint, text, _editElement, _editLevel);
            Sound.Play(SoundId.CommentPlace);
            Toast(Comments.LastError ?? $"Comment saved to {Comments.FileName}");
        }

        /// <summary>
        /// Draws the comment text box.
        /// </summary>
        private void BuildCommentEditor()
        {
            FontAtlas f = _ui.Atlas;
            float w = S(460);
            float textHeight = MathF.Max(f.Body.LineHeight * 1.15f, _ui.TextWrapped(f.Body, 0, 0, w - S(48), _editChars.AsSpan(0, _editLength), 0, maxLines: 10, draw: false));
            float h = S(96) + textHeight;
            float x = _window.Width * 0.5f - w * 0.5f, y = _window.Height * 0.5f + S(48);

            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.COMMENT);
            Text.Clear().Append(_editRecord != null ? "EDIT COMMENT · " : "NEW COMMENT · ").Append(_editLevel ?? "—");
            _ui.Text(f.Small, x + S(14), y + S(12), Text.Span, UiTheme.COMMENT_LABEL, S(1f));

            float boxY = y + S(32);
            float boxH = textHeight + S(16);
            _ui.Panel(x + S(14), boxY, w - S(28), boxH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
            _ui.TextWrapped(f.Body, x + S(24), boxY + S(8), w - S(48), _editChars.AsSpan(0, _editLength), UiTheme.TEXT, maxLines: 10);

            // Caret at the end of the last line (blinking)
            if ((_clock % 1f) < 0.55f)
            {
                CaretPosition(f.Body, w - S(48), out float caretX, out float caretLine);
                float lineHeight = f.Body.LineHeight * 1.15f;
                _ui.Rect(x + S(24) + caretX + S(1), boxY + S(8) + caretLine * lineHeight + S(2), S(1.5f), f.Body.LineHeight - S(2), UiTheme.COMMENT_LABEL);
            }

            _ui.Text(f.Body, x + S(14), y + h - S(26), "ENTER save · ESC cancel", UiTheme.TEXT_MUTED);
            Text.Clear().Append(_editLength).Append(" / ").Append(_editChars.Length);
            _ui.TextRight(f.Mono, x + w - S(14), y + h - S(25), Text.Span, UiTheme.TEXT_MUTED);
        }

        /// <summary>
        /// Caret location (x offset and line index) at the end of the typed text.
        /// </summary>
        private void CaretPosition(UiFont font, float maxWidth, out float caretX, out float line)
        {
            UiBatch.WrapEnd(font, maxWidth, _editChars.AsSpan(0, _editLength), 10, out int lines, out float lastWidth);
            line = Math.Max(lines - 1, 0);
            caretX = MathF.Min(lastWidth, maxWidth);
        }

        #endregion

        #region Pause menu

        /// <summary>
        /// Builds and handles the pause menu.
        /// </summary>
        private void BuildPauseMenu()
        {
            // The push report and the comment list take over the whole menu while open
            if (IsPushPanelOpen)
            {
                BuildPushPanel();
                return;
            }
            if (IsCommentsPanelOpen)
            {
                BuildCommentsPanel();
                return;
            }

            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            int width = _window.Width, height = _window.Height;
            if (!input.LeftDown) { _activeSlider = -1; }

            _ui.Rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

            float pad = S(48);
            float leftX = S(56), leftW = S(220);
            float rightW = S(280), rightX = width - S(56) - rightW;
            float midX = leftX + leftW + S(40), midW = rightX - S(40) - midX;

            // ---- Left column
            float y = pad;
            _ui.Text(f.Small, leftX, y, "BIMGO", UiTheme.TEXT_MUTED, S(2.6f));
            y += S(20);
            _ui.Text(f.Title, leftX, y, "PAUSED", UiTheme.TEXT, S(2.4f));
            y += S(64);

            float step = S(54);
            if (MenuButton(f, leftX, y, leftW, "RESUME", primary: true, danger: false)) { SetPaused(false); return; }
            y += step;
            if (MenuButton(f, leftX, y, leftW, "RETURN HOME", false, false)) { _player.GoHome(); SetPaused(false); return; }
            y += step;
            if (MenuButton(f, leftX, y, leftW, "SET HOME HERE", false, false)) { _player.SetHome(); Toast("Home set here"); }
            y += step;

            // Saving: back to the open file, or (Revit) a snapshot + session journal as a new .bimgo
            if (IsFileMode)
            {
                if (MenuButton(f, leftX, y, leftW, IsDirty ? "SAVE *" : "SAVE", false, false)) { Save(saveAs: false); return; }
                y += step;
                if (MenuButton(f, leftX, y, leftW, "SAVE AS…", false, false)) { Save(saveAs: true); return; }
                y += step;

                // Edits made offline go into the Revit model they came from
                if (MenuButton(f, leftX, y, leftW, PushMenuLabel(), false, false)) { OpenPush(); return; }
                y += step;
            }
            else
            {
                if (MenuButton(f, leftX, y, leftW, "SAVE AS .BIMGO…", false, false)) { Save(saveAs: true); return; }
                y += step;
            }

            if (MenuButton(f, leftX, y, leftW, CommentsMenuLabel(), false, false)) { OpenComments(); return; }
            y += step;

            if (MenuButton(f, leftX, y, leftW, "CLEAR MARKERS", false, false))
            {
                // Every gun's markers except comments (persistent: use X with the Comment gun)
                foreach (Gun gun in _guns)
                {
                    if (gun != _commentGun) { gun.ClearMarkers(); }
                }
                Toast("Markers cleared (comments kept)");
            }

            float endY = height - pad - S(48);
            if (MenuButton(f, leftX, endY, leftW, _live != null ? "LEAVE SESSION" : _options.InApp ? "CLOSE MODEL" : "END SESSION", false, danger: true)) { _endRequested = true; return; }

            // ---- Middle: geometry toggles
            if (midW > S(300)) { BuildCategoryCards(f, input, midX, pad, midW); }

            // ---- Right: world and display
            BuildDisplayCard(f, input, rightX, pad, rightW);

            // Version / file footer
            Text.Clear().Append(DocumentName).Append(" · ").AppendGrouped(Scene.Elements.Length).Append(" elements · ").AppendGrouped(Scene.TriangleCount).Append(" tris · ")
                .Append(_journal.Count).Append(_journal.Count == 1 ? " edit" : " edits");
            _ui.TextRight(f.Small, width - S(56), height - S(28), Text.Span, UiTheme.TEXT_FAINT, S(0.5f));
        }

        /// <summary>
        /// The three group cards with per-category toggles.
        /// </summary>
        private void BuildCategoryCards(FontAtlas f, InputState input, float x, float top, float width)
        {
            _ui.Text(f.Small, x, top + S(2), "GEOMETRY", UiTheme.TEXT_MUTED, S(1.8f));
            float cardTop = top + S(26);
            float gap = S(14);
            float cardW = (width - gap * 2f) / 3f;
            float row = S(22);
            bool changed = false;
            float tallest = 0f;

            for (int g = 0; g < 3; g++)
            {
                var group = (CategoryGroup)g;
                float cx = x + g * (cardW + gap);

                int loaded = 0, visible = 0, rows = 0;
                foreach (CategoryDef def in CategoryCatalog.All)
                {
                    if (def.Group != group) { continue; }
                    rows++;
                    if (Scene.CategoryLoaded[def.Index]) { loaded++; if (_categoryVisible[def.Index]) { visible++; } }
                }

                float cardH = S(52) + rows * row;
                tallest = MathF.Max(tallest, cardH);
                _ui.Panel(cx, cardTop, cardW, cardH, UiTheme.CARD, UiTheme.CARD_BORDER);

                // Header: clicking the group name toggles every loaded category in it
                float headerY = cardTop + S(12);
                bool headerHover = loaded > 0 && Hover(input, cx, cardTop, cardW, S(40));
                _ui.Text(f.Bold, cx + S(14), headerY, CategoryCatalog.GROUP_NAMES[g].ToUpperInvariant(), headerHover ? UiTheme.ACCENT : UiTheme.TEXT, S(1.2f));
                string tag = loaded == 0 ? "NOT LOADED" : loaded == rows ? "LOADED" : "PARTIAL";
                _ui.TextRight(f.Small, cx + cardW - S(14), headerY + S(3), tag, loaded == 0 ? UiTheme.TEXT_MUTED : UiTheme.GOOD, S(0.8f));
                _ui.Rect(cx + S(14), cardTop + S(40), cardW - S(28), MathF.Max(1f, UiScale), Rgba.Hex(0xFFFFFF, 0.1f));
                if (headerHover && input.LeftPressed)
                {
                    bool show = visible == 0;
                    foreach (CategoryDef def in CategoryCatalog.All)
                    {
                        if (def.Group == group && Scene.CategoryLoaded[def.Index]) { _categoryVisible[def.Index] = show; }
                    }
                    changed = true;
                }

                float ry = cardTop + S(48);
                foreach (CategoryDef def in CategoryCatalog.All)
                {
                    if (def.Group != group) { continue; }
                    bool enabled = Scene.CategoryLoaded[def.Index];
                    bool on = enabled && _categoryVisible[def.Index];
                    bool hover = enabled && Hover(input, cx + S(8), ry - S(3), cardW - S(16), row);

                    float alpha = enabled ? 1f : 0.4f;
                    float box = S(14);
                    float bx = cx + S(14), by = ry + S(1);
                    _ui.Rect(bx, by, box, box, on ? UiTheme.ACCENT : Rgba.WithAlpha(UiTheme.CONTROL, alpha));
                    _ui.Outline(bx, by, box, box, MathF.Max(1f, UiScale), Rgba.WithAlpha(on ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER, alpha));
                    if (on)
                    {
                        _ui.Line(bx + box * 0.22f, by + box * 0.52f, bx + box * 0.42f, by + box * 0.72f, S(2), UiTheme.SCAN_TAG_TEXT);
                        _ui.Line(bx + box * 0.42f, by + box * 0.72f, bx + box * 0.8f, by + box * 0.28f, S(2), UiTheme.SCAN_TAG_TEXT);
                    }

                    _ui.TextWrapped(f.Body, bx + box + S(10), ry, cardW - S(90), def.Label, Rgba.WithAlpha(hover ? UiTheme.ACCENT : UiTheme.TEXT, alpha), maxLines: 1);
                    if (enabled) { Text.Clear().AppendGrouped(Scene.CategoryElementCounts[def.Index]); }
                    else { Text.Clear().Append("—"); }
                    _ui.TextRight(f.Mono, cx + cardW - S(14), ry + S(1), Text.Span, Rgba.WithAlpha(UiTheme.TEXT_FAINT, alpha));

                    if (hover && input.LeftPressed)
                    {
                        _categoryVisible[def.Index] = !_categoryVisible[def.Index];
                        changed = true;
                    }
                    ry += row;
                }
            }

            _ui.Text(f.Body, x, cardTop + tallest + S(12), IsFileMode
                ? "Groups not in this file are greyed out. Export again from Revit to include them."
                : "Groups not loaded at launch are greyed out. Tick them and press Go in Revit again to include them.", UiTheme.TEXT_MUTED);

            if (changed)
            {
                RefreshMasks();
                Sound.Play(SoundId.UiClick);
            }
        }

        /// <summary>
        /// Ground plane, colour, anti-aliasing, FOV, sensitivity and toggles.
        /// </summary>
        private void BuildDisplayCard(FontAtlas f, InputState input, float x, float top, float width)
        {
            _ui.Text(f.Small, x, top + S(2), "WORLD & DISPLAY", UiTheme.TEXT_MUTED, S(1.8f));
            float cardTop = top + S(26);
            float cardH = S(452);
            _ui.Panel(x, cardTop, width, cardH, UiTheme.CARD, UiTheme.CARD_BORDER);

            float ix = x + S(14), iw = width - S(28);
            float y = cardTop + S(14);

            // Ground plane (relative to the default, shown absolute)
            Text.Clear().Append(_groundZ, 3).Append(" m");
            float ground = Slider(f, input, 0, ix, y, iw, "Ground plane", Text.Span, _groundZ, _groundDefault - 10f, _groundDefault + 10f);
            _groundZ = MathF.Round(ground / 0.05f) * 0.05f;
            y += S(58);

            // Colour mode
            _ui.Text(f.Body, ix, y, "Colour mode", UiTheme.TEXT);
            int colour = Segmented(f, input, ix, y + S(22), iw, COLOUR_OPTIONS, _whitecard ? 0 : 1);
            _whitecard = colour == 0;
            y += S(64);

            // Anti-aliasing
            _ui.Text(f.Body, ix, y, "Anti-aliasing", UiTheme.TEXT);
            int msaaIndex = Segmented(f, input, ix, y + S(22), iw, MSAA_OPTIONS, _msaa >= 4 ? 2 : _msaa >= 2 ? 1 : 0);
            _msaa = msaaIndex == 2 ? 4 : msaaIndex == 1 ? 2 : 0;
            y += S(64);

            // FOV
            Text.Clear().Append(_fov, 0).Append('°');
            _fov = MathF.Round(Slider(f, input, 1, ix, y, iw, "Field of view", Text.Span, _fov, 60f, 120f));
            y += S(58);

            // Sensitivity
            Text.Clear().Append(_sensitivity, 2);
            _sensitivity = MathF.Round(Slider(f, input, 2, ix, y, iw, "Mouse sensitivity", Text.Span, _sensitivity, 0.1f, 3f) / 0.05f) * 0.05f;
            y += S(62);

            // Toggles
            bool vsync = Checkbox(f, input, ix, y, iw, "VSync", _vsync);
            if (vsync != _vsync)
            {
                _vsync = vsync;
                Native.Wgl.SetSwapInterval(_vsync);
            }
            y += S(28);
            _invertY = Checkbox(f, input, ix, y, iw, "Invert Y", _invertY);
            y += S(28);
            _showFps = Checkbox(f, input, ix, y, iw, "Show FPS", _showFps);
        }

        #endregion

        #region Menu labels

        private string _pushMenuLabel;
        private int _pushMenuLabelFor = -1;
        private string _commentsMenuLabel;
        private int _commentsMenuLabelFor = -1;

        /// <summary>"PUSH TO REVIT (n)…" (rebuilt only when the count changes).</summary>
        private string PushMenuLabel()
        {
            int pending = _journal.CountNotInRevit();
            if (pending != _pushMenuLabelFor || _pushMenuLabel == null)
            {
                _pushMenuLabelFor = pending;
                _pushMenuLabel = pending == 0 ? "PUSH TO REVIT…" : $"PUSH TO REVIT ({pending})…";
            }
            return _pushMenuLabel;
        }

        /// <summary>"COMMENTS (n)" (rebuilt only when the count changes).</summary>
        private string CommentsMenuLabel()
        {
            int count = Comments?.Comments.Count ?? 0;
            if (count != _commentsMenuLabelFor || _commentsMenuLabel == null)
            {
                _commentsMenuLabelFor = count;
                _commentsMenuLabel = count == 0 ? "COMMENTS" : $"COMMENTS ({count})";
            }
            return _commentsMenuLabel;
        }

        #endregion

        #region Widgets

        private static bool Hover(InputState input, float x, float y, float w, float h)
        {
            Vector2 m = input.MousePosition;
            return m.X >= x && m.X < x + w && m.Y >= y && m.Y < y + h;
        }

        /// <summary>
        /// A full-width menu button. A disabled button is drawn faded and never reports a click.
        /// </summary>
        private bool MenuButton(FontAtlas f, float x, float y, float w, string label, bool primary, bool danger, bool enabled = true)
        {
            InputState input = _window.Input;
            float h = S(48);
            bool hover = enabled && Hover(input, x, y, w, h);
            float alpha = enabled ? 1f : 0.4f;

            if (primary)
            {
                _ui.Rect(x, y, w, h, Fade(hover ? Rgba.Hex(0x67E8F9) : UiTheme.ACCENT, alpha));
            }
            else
            {
                _ui.Rect(x, y, w, h, hover ? Rgba.Hex(0xFFFFFF, 0.08f) : Rgba.Hex(0xFFFFFF, 0.0f));
                _ui.Outline(x, y, w, h, MathF.Max(1f, UiScale), Fade(danger ? Rgba.Hex(0xFCA5A5, 0.45f) : Rgba.Hex(0xFFFFFF, 0.2f), alpha));
            }

            uint textColour = primary ? Rgba.Hex(0x06232A) : danger ? UiTheme.DANGER : UiTheme.TEXT;
            _ui.Text(f.Bold, x + S(16), y + h * 0.5f - f.Bold.LineHeight * 0.5f, label, primary ? textColour : Fade(textColour, alpha), S(1.3f));

            bool clicked = hover && input.LeftPressed;
            if (clicked)
            {
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
            }
            return clicked;
        }

        /// <summary>
        /// Scales a colour's alpha (1 = unchanged).
        /// </summary>
        private static uint Fade(uint colour, float factor)
        {
            if (factor >= 1f) { return colour; }
            uint alpha = (uint)Math.Clamp((int)((colour >> 24) * factor + 0.5f), 0, 255);
            return (colour & 0x00FFFFFF) | (alpha << 24);
        }

        /// <summary>
        /// A labelled horizontal slider with a value readout.
        /// </summary>
        private float Slider(FontAtlas f, InputState input, int id, float x, float y, float w, string label, ReadOnlySpan<char> valueText, float value, float min, float max)
        {
            _ui.Text(f.Body, x, y, label, UiTheme.TEXT);
            _ui.TextRight(f.Mono, x + w, y + S(1), valueText, Rgba.Hex(0x67E8F9));

            float trackY = y + S(30);
            float knobR = S(7);
            bool hover = Hover(input, x - knobR, trackY - S(12), w + knobR * 2f, S(24));
            if (hover && input.LeftPressed) { _activeSlider = id; }

            if (_activeSlider == id && input.LeftDown)
            {
                float t = Math.Clamp((input.MousePosition.X - x) / w, 0f, 1f);
                value = min + t * (max - min);
            }

            float fraction = Math.Clamp((value - min) / (max - min), 0f, 1f);
            _ui.Rect(x, trackY - S(2), w, S(4), Rgba.Hex(0xFFFFFF, 0.15f));
            _ui.Rect(x, trackY - S(2), w * fraction, S(4), UiTheme.ACCENT);
            _ui.Circle(x + w * fraction, trackY, knobR, hover || _activeSlider == id ? Rgba.Hex(0x67E8F9) : UiTheme.ACCENT, 16);
            return value;
        }

        /// <summary>
        /// A segmented choice control.
        /// </summary>
        private int Segmented(FontAtlas f, InputState input, float x, float y, float w, string[] options, int selected)
        {
            float h = S(32);
            float segment = w / options.Length;
            for (int i = 0; i < options.Length; i++)
            {
                float sx = x + i * segment;
                bool on = i == selected;
                bool hover = Hover(input, sx, y, segment, h);
                _ui.Rect(sx, y, segment, h, on ? UiTheme.ACCENT : hover ? Rgba.Hex(0xFFFFFF, 0.08f) : UiTheme.CONTROL);
                _ui.Outline(sx, y, segment, h, MathF.Max(1f, UiScale), UiTheme.CONTROL_BORDER);
                _ui.TextCentred(f.Body, sx + segment * 0.5f, y + h * 0.5f - f.Body.LineHeight * 0.5f, options[i], on ? Rgba.Hex(0x06232A) : UiTheme.TEXT);
                if (hover && input.LeftPressed && !on)
                {
                    selected = i;
                    Sound.Play(SoundId.UiClick);
                }
            }
            return selected;
        }

        /// <summary>
        /// A checkbox row.
        /// </summary>
        private bool Checkbox(FontAtlas f, InputState input, float x, float y, float w, string label, bool value)
        {
            float box = S(16);
            bool hover = Hover(input, x, y - S(3), w, S(24));
            _ui.Rect(x, y, box, box, value ? UiTheme.ACCENT : UiTheme.CONTROL);
            _ui.Outline(x, y, box, box, MathF.Max(1f, UiScale), value ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
            if (value)
            {
                _ui.Line(x + box * 0.22f, y + box * 0.52f, x + box * 0.42f, y + box * 0.72f, S(2), Rgba.Hex(0x06232A));
                _ui.Line(x + box * 0.42f, y + box * 0.72f, x + box * 0.8f, y + box * 0.28f, S(2), Rgba.Hex(0x06232A));
            }
            _ui.Text(f.Body, x + box + S(10), y - S(1), label, hover ? UiTheme.ACCENT : UiTheme.TEXT);

            if (hover && input.LeftPressed)
            {
                Sound.Play(SoundId.UiClick);
                return !value;
            }
            return value;
        }

        #endregion
    }
}
