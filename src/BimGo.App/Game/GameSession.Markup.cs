using System.Numerics;
using BimGo.Audio;
using BimGo.Format;
using BimGo.Platform;
using BimGo.Rendering;
using Gl = BimGo.Native.Gl;
using SD = System.Drawing;
using SD2 = System.Drawing.Drawing2D;
using Vk = BimGo.Native.Win32;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Snapshot markup (review tools round): draw on a comment's picture with arrows, boxes, ellipses, a pen and text,
    /// in five colours and three thicknesses, with undo / redo and clear. Opens straight after a comment's picture is
    /// taken (a new comment, or SET VIEW HERE) and from the comment's detail view (MARKUP…).
    /// <para>
    /// SAVE burns the markup into the comment's picture and thumbnail, so BCF snapshots and every list carry it, and
    /// keeps the unmarked original beside them (<see cref="CommentRecord.SnapshotOriginal"/>): the next MARKUP… starts
    /// from the clean picture. Shapes are kept only while the editor is open (no editable vector layer).
    /// </para>
    /// Shapes are stored in picture pixels; committed shapes are drawn with GDI+ into a preview texture (exactly what
    /// SAVE writes), the shape being dragged or typed is drawn with the UI batch on top. Nothing is drawn per frame
    /// with GDI+ and the shapes allocate only when added.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Types

        private enum MarkupTool
        {
            Arrow = 0,
            Box = 1,
            Ellipse = 2,
            Pen = 3,
            Text = 4
        }

        /// <summary>One markup operation: a shape, or a CLEAR (hides everything before it).</summary>
        private sealed class MarkupShape
        {
            public MarkupTool Tool;
            public int Colour;
            public int Width;
            public List<Vector2> Points;
            public string Text;
            public bool IsClear;
        }

        #endregion

        #region Constants

        private static readonly string[] MARKUP_TOOLS = { "ARROW", "BOX", "ELLIPSE", "PEN", "TEXT" };
        private static readonly string[] MARKUP_WIDTHS = { "THIN", "MEDIUM", "THICK" };

        /// <summary>Red, amber, cyan, white, black (RGB).</summary>
        private static readonly uint[] MARKUP_COLOURS = { 0xEF4444, 0xF59E0B, 0x22D3EE, 0xFFFFFF, 0x111111 };

        /// <summary>Stroke widths as a share of the picture's width.</summary>
        private static readonly float[] MARKUP_STROKE = { 0.0025f, 0.005f, 0.0095f };

        /// <summary>Text heights as a share of the picture's height.</summary>
        private static readonly float[] MARKUP_TEXT = { 0.034f, 0.05f, 0.072f };

        private const int MARKUP_TEXT_MAX = 120;

        #endregion

        #region Fields

        private bool _markupOpen;
        private CommentRecord _markupFor;
        private bool _markupReturnToGame;

        // A picture just taken asks for the editor (opened at the start of the next frame)
        private CommentRecord _markupAfterCapture, _markupPending;

        // The unmarked picture (decoded) and its JPEG bytes, and the preview texture (unmarked + committed shapes)
        private SD.Bitmap _markupBase;
        private byte[] _markupBaseBytes;
        private uint _markupTexture;

        private readonly List<MarkupShape> _markupOps = new();
        private readonly List<MarkupShape> _markupRedo = new();
        private MarkupTool _markupTool = MarkupTool.Arrow;
        private int _markupColour;
        private int _markupWidth = 1;
        private bool _markupDirty;

        // The shape being dragged, and the text being typed (picture pixels)
        private MarkupShape _markupDrawing;
        private bool _markupTyping;
        private Vector2 _markupTextAt;
        private readonly char[] _markupChars = new char[MARKUP_TEXT_MAX];
        private int _markupLength;

        // Where the picture is drawn this frame (screen)
        private float _markupX, _markupY, _markupW, _markupH;

        #endregion

        #region Open / close

        /// <summary>True while the markup editor is open (it replaces the pause menu and takes the keys).</summary>
        private bool IsMarkupOpen => _markupOpen;

        /// <summary>
        /// Opens the editor on a comment's picture (the unmarked original when it has markup).
        /// </summary>
        /// <param name="record">The comment.</param>
        /// <param name="returnToGame">True to resume the walkthrough when the editor closes (opened right after a new comment).</param>
        private void OpenMarkup(CommentRecord record, bool returnToGame)
        {
            if (record == null || !Comments.Comments.Contains(record)) { return; }
            byte[] bytes = record.SnapshotOriginalData ?? record.SnapshotData;
            if (bytes == null || bytes.Length == 0)
            {
                Sound.Play(SoundId.Error);
                _commentsNotice = "This comment has no picture to mark up: SET VIEW HERE takes one";
                Toast(_commentsNotice, 3f);
                return;
            }

            try
            {
                using var stream = new MemoryStream(bytes);
                using var decoded = new SD.Bitmap(stream);
                _markupBase = new SD.Bitmap(decoded.Width, decoded.Height, SD.Imaging.PixelFormat.Format32bppArgb);
                using (var graphics = SD.Graphics.FromImage(_markupBase)) { graphics.DrawImage(decoded, 0, 0, decoded.Width, decoded.Height); }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Markup: picture of {record.Id} unreadable: {ex.Message}");
                ReleaseMarkup();
                Toast("The comment's picture could not be read for markup", 3f, important: true);
                return;
            }

            _markupBaseBytes = bytes;
            _markupFor = record;
            _markupOps.Clear();
            _markupRedo.Clear();
            _markupDrawing = null;
            _markupTyping = false;
            _markupLength = 0;
            _markupDirty = false;
            UploadMarkupTexture(_markupBase);

            _markupReturnToGame = returnToGame && !_paused;
            if (!_paused) { SetPaused(true); }
            _markupOpen = true;
            _window.Input.ReleaseAll();
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>
        /// Closes the editor: SAVE burns the markup in (and keeps the original), otherwise nothing changes.
        /// </summary>
        private void CloseMarkup(bool save)
        {
            if (!_markupOpen) { return; }
            if (_markupTyping) { CommitMarkupText(); }
            CommentRecord record = _markupFor;
            bool returnToGame = _markupReturnToGame;

            if (save && _markupDirty && record != null)
            {
                try
                {
                    SaveMarkup(record);
                    _commentsNotice = Comments.LastError ?? (HasVisibleMarkup() ? "Markup saved (the picture and BCF snapshot carry it)" : "Markup removed: the picture is back to the original");
                    Sound.Play(SoundId.Commit);
                }
                catch (Exception ex)
                {
                    Utilities.Log_Utils.Write($"Markup save failed: {ex.Message}");
                    _commentsNotice = "The markup could not be saved";
                    Toast(_commentsNotice, 4f, important: true);
                }
            }
            else
            {
                _commentsNotice = _markupDirty ? "Markup not saved" : null;
            }

            ReleaseMarkup();
            _markupOpen = false;
            _markupFor = null;
            _window.Input.ReleaseAll();
            if (returnToGame)
            {
                SetPaused(false);
                if (_commentsNotice != null) { Toast(_commentsNotice, 2.6f); }
            }
        }

        /// <summary>Frees the decoded picture and the preview texture.</summary>
        private void ReleaseMarkup()
        {
            _markupBase?.Dispose();
            _markupBase = null;
            _markupBaseBytes = null;
            if (_markupTexture != 0)
            {
                Gl.DeleteTexture(_markupTexture);
                _markupTexture = 0;
            }
            _markupOps.Clear();
            _markupRedo.Clear();
            _markupDrawing = null;
            _markupTyping = false;
        }

        /// <summary>
        /// Start of a frame: opens the editor a picture just taken asked for.
        /// </summary>
        private void OpenPendingMarkup()
        {
            CommentRecord record = _markupPending;
            _markupPending = null;
            if (record != null && !_markupOpen && !_tourActive && _video == null) { OpenMarkup(record, returnToGame: !_paused); }
        }

        #endregion

        #region Operations

        private void AddMarkupOp(MarkupShape shape)
        {
            _markupOps.Add(shape);
            _markupRedo.Clear();
            _markupDirty = true;
            RebuildMarkupPreview();
        }

        private void UndoMarkup()
        {
            if (_markupTyping) { CancelMarkupText(); return; }
            if (_markupOps.Count == 0) { return; }
            _markupRedo.Add(_markupOps[^1]);
            _markupOps.RemoveAt(_markupOps.Count - 1);
            _markupDirty = true;
            RebuildMarkupPreview();
            Sound.Play(SoundId.UiClick);
        }

        private void RedoMarkup()
        {
            if (_markupRedo.Count == 0) { return; }
            _markupOps.Add(_markupRedo[^1]);
            _markupRedo.RemoveAt(_markupRedo.Count - 1);
            _markupDirty = true;
            RebuildMarkupPreview();
            Sound.Play(SoundId.UiClick);
        }

        private void ClearMarkup()
        {
            if (_markupTyping) { CancelMarkupText(); }
            if (!HasVisibleMarkup()) { return; }
            AddMarkupOp(new MarkupShape { IsClear = true });
            Sound.Play(SoundId.Remove);
        }

        /// <summary>Index of the first shape that shows (after the last CLEAR).</summary>
        private int FirstVisibleMarkup()
        {
            for (int i = _markupOps.Count - 1; i >= 0; i--)
            {
                if (_markupOps[i].IsClear) { return i + 1; }
            }
            return 0;
        }

        private bool HasVisibleMarkup() => FirstVisibleMarkup() < _markupOps.Count;

        private void CommitMarkupText()
        {
            _markupTyping = false;
            string text = new string(_markupChars, 0, _markupLength).Trim();
            _markupLength = 0;
            if (text.Length == 0) { return; }
            AddMarkupOp(new MarkupShape
            {
                Tool = MarkupTool.Text,
                Colour = _markupColour,
                Width = _markupWidth,
                Points = new List<Vector2> { _markupTextAt },
                Text = text
            });
        }

        private void CancelMarkupText()
        {
            _markupTyping = false;
            _markupLength = 0;
        }

        #endregion

        #region Input

        /// <summary>
        /// Keys while the editor is open: typing (text tool), Ctrl+Z / Ctrl+Y undo / redo, tool letters, Enter saves,
        /// Esc cancels. Mouse drawing happens with the panel (<see cref="BuildMarkupEditor"/>).
        /// </summary>
        private void UpdateMarkupKeys(InputState input)
        {
            if (input.IsPressed(Vk.VK_F11)) { _window.ToggleFullscreen(); }

            if (_markupTyping)
            {
                foreach (char c in input.Chars)
                {
                    switch (c)
                    {
                        case '\b':
                            if (_markupLength > 0) { _markupLength--; }
                            break;
                        case '\r':
                            CommitMarkupText();
                            return;
                        case (char)27:
                            CancelMarkupText();
                            return;
                        default:
                            if (c >= ' ' && _markupLength < _markupChars.Length) { _markupChars[_markupLength++] = c; }
                            break;
                    }
                }
                return;
            }

            if (input.IsDown(Vk.VK_CONTROL))
            {
                if (input.IsPressed('Z'))
                {
                    if (input.IsDown(Vk.VK_SHIFT)) { RedoMarkup(); } else { UndoMarkup(); }
                }
                else if (input.IsPressed('Y')) { RedoMarkup(); }
                return;
            }

            if (input.IsPressed(Vk.VK_ESCAPE)) { CloseMarkup(save: false); return; }
            if (input.IsPressed(Vk.VK_RETURN)) { CloseMarkup(save: true); return; }
            if (input.IsPressed('A')) { _markupTool = MarkupTool.Arrow; }
            if (input.IsPressed('R')) { _markupTool = MarkupTool.Box; }
            if (input.IsPressed('E')) { _markupTool = MarkupTool.Ellipse; }
            if (input.IsPressed('P')) { _markupTool = MarkupTool.Pen; }
            if (input.IsPressed('T')) { _markupTool = MarkupTool.Text; }
            for (int i = 0; i < MARKUP_COLOURS.Length; i++)
            {
                if (input.IsPressed('1' + i)) { _markupColour = i; }
            }
        }

        /// <summary>Screen → picture pixels.</summary>
        private Vector2 MarkupToImage(Vector2 screen) => _markupBase == null || _markupW <= 0f ? Vector2.Zero : new Vector2(
            Math.Clamp((screen.X - _markupX) / _markupW, 0f, 1f) * _markupBase.Width,
            Math.Clamp((screen.Y - _markupY) / _markupH, 0f, 1f) * _markupBase.Height);

        /// <summary>Picture pixels → screen.</summary>
        private Vector2 MarkupToScreen(Vector2 image) => _markupBase == null ? Vector2.Zero : new Vector2(
            _markupX + image.X / _markupBase.Width * _markupW,
            _markupY + image.Y / _markupBase.Height * _markupH);

        /// <summary>
        /// Mouse on the picture: starts, drags and finishes shapes, or places a text.
        /// </summary>
        private void UpdateMarkupMouse(InputState input)
        {
            Vector2 mouse = input.MousePosition;
            bool over = Hover(input, _markupX, _markupY, _markupW, _markupH);

            if (input.LeftPressed && over)
            {
                if (_markupTyping) { CommitMarkupText(); }
                Vector2 at = MarkupToImage(mouse);
                if (_markupTool == MarkupTool.Text)
                {
                    _markupTyping = true;
                    _markupTextAt = at;
                    _markupLength = 0;
                }
                else
                {
                    _markupDrawing = new MarkupShape
                    {
                        Tool = _markupTool,
                        Colour = _markupColour,
                        Width = _markupWidth,
                        Points = new List<Vector2>(_markupTool == MarkupTool.Pen ? 64 : 2) { at, at }
                    };
                }
                return;
            }

            if (_markupDrawing == null) { return; }
            Vector2 point = MarkupToImage(mouse);
            List<Vector2> points = _markupDrawing.Points;
            if (_markupDrawing.Tool == MarkupTool.Pen)
            {
                // A new pen point every couple of screen pixels
                float minStep = 2f * UiScale * _markupBase.Width / MathF.Max(_markupW, 1f);
                if (Vector2.Distance(points[^1], point) >= minStep) { points.Add(point); }
            }
            else
            {
                points[1] = point;
            }

            if (!input.LeftDown || input.LeftReleased)
            {
                MarkupShape shape = _markupDrawing;
                _markupDrawing = null;
                if (shape.Tool == MarkupTool.Pen && points.Count >= 2) { AddMarkupOp(shape); }
                else if (shape.Tool != MarkupTool.Pen)
                {
                    // A click without a drag draws nothing
                    float minSize = 4f * UiScale * _markupBase.Width / MathF.Max(_markupW, 1f);
                    if (Vector2.Distance(points[0], points[1]) >= minSize) { AddMarkupOp(shape); }
                }
            }
        }

        #endregion

        #region Panel

        /// <summary>
        /// Draws and handles the editor (in place of the pause menu): toolbar, the picture with the markup, hints.
        /// </summary>
        private void BuildMarkupEditor()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            int width = _window.Width, height = _window.Height;
            if (_markupBase == null) { CloseMarkup(save: false); return; }
            _ui.Rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

            float margin = S(40);
            float y = S(22);

            // Title row with CANCEL / SAVE on the right
            _ui.Text(f.Small, margin, y + S(4), "MARKUP", UiTheme.COMMENT_LABEL, S(2f));
            float saveW = S(120), cancelW = S(120);
            float buttonsX = width - margin - saveW - S(10) - cancelW;
            _ui.TextWrapped(f.Body, margin + S(110), y + S(2), MathF.Max(S(60), buttonsX - margin - S(130)), _markupFor?.Text ?? string.Empty, UiTheme.TEXT_SOFT, maxLines: 1);
            if (MenuButton(f, buttonsX, y - S(6), cancelW, _markupReturnToGame && !_markupDirty ? "SKIP" : "CANCEL", false, false, height: S(36)))
            {
                CloseMarkup(save: false);
                return;
            }
            if (MenuButton(f, buttonsX + cancelW + S(10), y - S(6), saveW, "SAVE", true, false, enabled: _markupDirty || _markupTyping, height: S(36)))
            {
                CloseMarkup(save: true);
                return;
            }
            y += S(44);

            // Toolbar: tools · colours · thickness · undo / redo / clear (wraps on narrow windows)
            float x = margin, rowH = S(32), right = width - margin;
            float toolsW = S(380);
            int tool = Segmented(f, input, x, y, toolsW, MARKUP_TOOLS, (int)_markupTool);
            if (tool != (int)_markupTool)
            {
                if (_markupTyping) { CommitMarkupText(); }
                _markupTool = (MarkupTool)tool;
            }
            x += toolsW + S(18);

            float swatch = S(30), swatchGap = S(6);
            float swatchesW = MARKUP_COLOURS.Length * (swatch + swatchGap);
            if (x + swatchesW > right) { x = margin; y += rowH + S(10); }
            for (int i = 0; i < MARKUP_COLOURS.Length; i++)
            {
                float sx = x + i * (swatch + swatchGap);
                bool on = i == _markupColour;
                _ui.Rect(sx, y + S(1), swatch, swatch, Rgba.Hex(MARKUP_COLOURS[i]));
                _ui.Outline(sx, y + S(1), swatch, swatch, on ? S(3) : MathF.Max(1f, UiScale), on ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
                if (Hover(input, sx, y, swatch, swatch) && input.LeftPressed)
                {
                    _markupColour = i;
                    input.ConsumeClicks();
                    Sound.Play(SoundId.UiClick);
                }
            }
            x += swatchesW + S(12);

            float widthsW = S(240);
            if (x + widthsW > right) { x = margin; y += rowH + S(10); }
            _markupWidth = Segmented(f, input, x, y, widthsW, MARKUP_WIDTHS, _markupWidth);
            x += widthsW + S(18);

            float smallW = S(72), smallGap = S(6);
            if (x + smallW * 3f + smallGap * 2f > right) { x = margin; y += rowH + S(10); }
            if (SmallButton(f, input, x, y, smallW, rowH, "UNDO")) { UndoMarkup(); }
            x += smallW + smallGap;
            if (SmallButton(f, input, x, y, smallW, rowH, "REDO")) { RedoMarkup(); }
            x += smallW + smallGap;
            if (SmallButton(f, input, x, y, smallW, rowH, "CLEAR", danger: true)) { ClearMarkup(); }
            y += rowH + S(16);

            // The picture, fitted
            float areaW = width - margin * 2f, areaH = height - y - S(52);
            float aspect = (float)_markupBase.Width / _markupBase.Height;
            _markupW = MathF.Min(areaW, areaH * aspect);
            _markupH = _markupW / aspect;
            _markupX = margin + (areaW - _markupW) * 0.5f;
            _markupY = y + (areaH - _markupH) * 0.5f;
            _ui.Image(_markupTexture, _markupX, _markupY, _markupW, _markupH, width, height);
            _ui.Outline(_markupX, _markupY, _markupW, _markupH, MathF.Max(1f, UiScale), Rgba.Hex(0xFFFFFF, 0.2f));

            UpdateMarkupMouse(input);
            if (_markupDrawing != null) { DrawMarkupShapePreview(_markupDrawing); }
            if (_markupTyping) { DrawMarkupTextPreview(f); }

            // Hints
            string hint = _markupTyping
                ? "Type the text · Enter places it · Esc cancels it"
                : "Drag on the picture to draw · A arrow · R box · E ellipse · P pen · T text · 1–5 colour · Ctrl+Z / Ctrl+Y · Enter save · Esc cancel";
            _ui.TextCentred(f.Body, width * 0.5f, height - S(36), hint, UiTheme.TEXT_MUTED);
        }

        /// <summary>The shape being dragged, drawn with the UI batch (screen space).</summary>
        private void DrawMarkupShapePreview(MarkupShape shape)
        {
            float scale = _markupW / _markupBase.Width;
            float stroke = MathF.Max(1.5f, MARKUP_STROKE[shape.Width] * _markupBase.Width * scale);
            uint colour = Rgba.Hex(MARKUP_COLOURS[shape.Colour]);
            List<Vector2> points = shape.Points;
            Vector2 a = MarkupToScreen(points[0]), b = MarkupToScreen(points[^1]);

            switch (shape.Tool)
            {
                case MarkupTool.Arrow:
                    ArrowGeometry(a, b, stroke, out Vector2 shaftEnd, out Vector2 tip, out Vector2 left, out Vector2 rightWing);
                    _ui.Line(a.X, a.Y, shaftEnd.X, shaftEnd.Y, stroke, colour);
                    _ui.Triangle(tip.X, tip.Y, left.X, left.Y, rightWing.X, rightWing.Y, colour);
                    break;

                case MarkupTool.Box:
                    _ui.Line(a.X, a.Y, b.X, a.Y, stroke, colour);
                    _ui.Line(b.X, a.Y, b.X, b.Y, stroke, colour);
                    _ui.Line(b.X, b.Y, a.X, b.Y, stroke, colour);
                    _ui.Line(a.X, b.Y, a.X, a.Y, stroke, colour);
                    break;

                case MarkupTool.Ellipse:
                    Vector2 centre = (a + b) * 0.5f, radius = Vector2.Abs(b - a) * 0.5f;
                    const int SEGMENTS = 48;
                    Vector2 previous = centre + new Vector2(radius.X, 0f);
                    for (int i = 1; i <= SEGMENTS; i++)
                    {
                        float angle = i * MathF.Tau / SEGMENTS;
                        Vector2 next = centre + new Vector2(MathF.Cos(angle) * radius.X, MathF.Sin(angle) * radius.Y);
                        _ui.Line(previous.X, previous.Y, next.X, next.Y, stroke, colour);
                        previous = next;
                    }
                    break;

                case MarkupTool.Pen:
                    for (int i = 1; i < points.Count; i++)
                    {
                        Vector2 p0 = MarkupToScreen(points[i - 1]), p1 = MarkupToScreen(points[i]);
                        _ui.Line(p0.X, p0.Y, p1.X, p1.Y, stroke, colour);
                    }
                    break;
            }
        }

        /// <summary>The text being typed, with a caret (an approximation of the burned text's size).</summary>
        private void DrawMarkupTextPreview(FontAtlas f)
        {
            Vector2 at = MarkupToScreen(_markupTextAt);
            uint colour = Rgba.Hex(MARKUP_COLOURS[_markupColour]);
            UiFont font = _markupWidth == 2 ? f.Title : f.Bold;
            float top = at.Y - font.LineHeight * 0.5f;
            ReadOnlySpan<char> text = _markupChars.AsSpan(0, _markupLength);
            float used = _ui.Text(font, at.X, top, text, colour);
            if ((_clock % 1f) < 0.55f) { _ui.Rect(at.X + used + S(2), top, S(2), font.LineHeight, colour); }
            if (_markupLength == 0) { _ui.Text(f.Small, at.X + S(8), top + font.LineHeight + S(4), "Type, then Enter", UiTheme.TEXT_MUTED); }
        }

        /// <summary>
        /// An arrow's shaft end and head (a triangle at least 4 strokes long, 1.8 % of the picture's width at least).
        /// </summary>
        private static void ArrowGeometry(Vector2 from, Vector2 to, float stroke, out Vector2 shaftEnd, out Vector2 tip, out Vector2 left, out Vector2 right)
        {
            Vector2 d = to - from;
            float length = d.Length();
            tip = to;
            if (length < 1e-3f)
            {
                shaftEnd = left = right = to;
                return;
            }
            d /= length;
            float head = MathF.Min(MathF.Max(stroke * 4.5f, 6f), length);
            Vector2 side = new(-d.Y, d.X);
            Vector2 headBase = to - d * head;
            left = headBase + side * head * 0.55f;
            right = headBase - side * head * 0.55f;
            shaftEnd = to - d * head * 0.8f;
        }

        #endregion

        #region Burning

        /// <summary>
        /// The picture with the visible shapes drawn in (GDI+, anti-aliased). The caller disposes it.
        /// </summary>
        private SD.Bitmap BurnMarkup()
        {
            var output = new SD.Bitmap(_markupBase);
            using SD.Graphics g = SD.Graphics.FromImage(output);
            g.SmoothingMode = SD2.SmoothingMode.AntiAlias;
            g.PixelOffsetMode = SD2.PixelOffsetMode.HighQuality;
            g.TextRenderingHint = SD.Text.TextRenderingHint.AntiAlias;
            int imageW = _markupBase.Width, imageH = _markupBase.Height;

            for (int i = FirstVisibleMarkup(); i < _markupOps.Count; i++)
            {
                MarkupShape shape = _markupOps[i];
                if (shape.IsClear) { continue; }
                uint rgb = MARKUP_COLOURS[shape.Colour];
                SD.Color colour = SD.Color.FromArgb(255, (int)(rgb >> 16) & 0xFF, (int)(rgb >> 8) & 0xFF, (int)rgb & 0xFF);
                float stroke = MathF.Max(1.5f, MARKUP_STROKE[shape.Width] * imageW);
                using var pen = new SD.Pen(colour, stroke) { LineJoin = SD2.LineJoin.Round, StartCap = SD2.LineCap.Round, EndCap = SD2.LineCap.Round };
                using var brush = new SD.SolidBrush(colour);
                List<Vector2> p = shape.Points;

                switch (shape.Tool)
                {
                    case MarkupTool.Arrow:
                        ArrowGeometry(p[0], p[^1], stroke, out Vector2 shaftEnd, out Vector2 tip, out Vector2 left, out Vector2 right);
                        g.DrawLine(pen, p[0].X, p[0].Y, shaftEnd.X, shaftEnd.Y);
                        g.FillPolygon(brush, new[] { new SD.PointF(tip.X, tip.Y), new SD.PointF(left.X, left.Y), new SD.PointF(right.X, right.Y) });
                        break;

                    case MarkupTool.Box:
                        pen.LineJoin = SD2.LineJoin.Miter;
                        g.DrawRectangle(pen, MathF.Min(p[0].X, p[1].X), MathF.Min(p[0].Y, p[1].Y), MathF.Abs(p[1].X - p[0].X), MathF.Abs(p[1].Y - p[0].Y));
                        break;

                    case MarkupTool.Ellipse:
                        g.DrawEllipse(pen, MathF.Min(p[0].X, p[1].X), MathF.Min(p[0].Y, p[1].Y), MathF.Abs(p[1].X - p[0].X), MathF.Abs(p[1].Y - p[0].Y));
                        break;

                    case MarkupTool.Pen:
                        var line = new SD.PointF[p.Count];
                        for (int k = 0; k < p.Count; k++) { line[k] = new SD.PointF(p[k].X, p[k].Y); }
                        g.DrawLines(pen, line);
                        break;

                    case MarkupTool.Text:
                        DrawMarkupText(g, shape, colour, imageH);
                        break;
                }
            }
            return output;
        }

        /// <summary>
        /// Text in bold with a contrasting outline (dark for light colours, white for black) so it reads on any
        /// background; centred vertically on the click.
        /// </summary>
        private static void DrawMarkupText(SD.Graphics g, MarkupShape shape, SD.Color colour, int imageH)
        {
            float size = MathF.Max(10f, MARKUP_TEXT[shape.Width] * imageH);
            using var family = new SD.FontFamily(SD.Text.GenericFontFamilies.SansSerif);
            SD.FontFamily face = family;
            SD.FontFamily segoe = null;
            try
            {
                segoe = new SD.FontFamily("Segoe UI");
                face = segoe;
            }
            catch (ArgumentException)
            {
                // Not installed: the generic sans-serif face
            }

            try
            {
                using var path = new SD2.GraphicsPath();
                Vector2 at = shape.Points[0];
                path.AddString(shape.Text, face, (int)SD.FontStyle.Bold, size, new SD.PointF(at.X, at.Y - size * 0.62f), SD.StringFormat.GenericTypographic);
                bool dark = colour.GetBrightness() < 0.25f;
                using var outline = new SD.Pen(dark ? SD.Color.FromArgb(230, 255, 255, 255) : SD.Color.FromArgb(220, 0, 0, 0), size * 0.14f) { LineJoin = SD2.LineJoin.Round };
                using var fill = new SD.SolidBrush(colour);
                g.DrawPath(outline, path);
                g.FillPath(fill, path);
            }
            finally
            {
                segoe?.Dispose();
            }
        }

        /// <summary>Redraws the preview texture (the picture with the committed shapes).</summary>
        private void RebuildMarkupPreview()
        {
            if (_markupBase == null) { return; }
            try
            {
                using SD.Bitmap preview = BurnMarkup();
                UploadMarkupTexture(preview);
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Markup preview failed: {ex.Message}");
            }
        }

        /// <summary>Uploads a 32-bit bitmap into the preview texture (made on first use).</summary>
        private unsafe void UploadMarkupTexture(SD.Bitmap bitmap)
        {
            SD.Imaging.BitmapData bits = bitmap.LockBits(new SD.Rectangle(0, 0, bitmap.Width, bitmap.Height), SD.Imaging.ImageLockMode.ReadOnly, SD.Imaging.PixelFormat.Format32bppArgb);
            try
            {
                if (_markupTexture == 0)
                {
                    _markupTexture = Gl.GenTexture();
                    Gl.BindTexture(Gl.TEXTURE_2D, _markupTexture);
                    Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)Gl.LINEAR);
                    Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)Gl.LINEAR);
                    Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
                    Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
                }
                else
                {
                    Gl.BindTexture(Gl.TEXTURE_2D, _markupTexture);
                }
                Gl.PixelStore(Gl.UNPACK_ALIGNMENT, 4);
                Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA8, bitmap.Width, bitmap.Height, Gl.BGRA, Gl.UNSIGNED_BYTE, (void*)bits.Scan0);
                Gl.BindTexture(Gl.TEXTURE_2D, 0);
            }
            finally
            {
                bitmap.UnlockBits(bits);
            }
        }

        /// <summary>
        /// SAVE: the burned picture (same size, JPEG) and thumbnail (192 × 108), with the unmarked original kept; or,
        /// when everything was cleared, the original back as the picture.
        /// </summary>
        private void SaveMarkup(CommentRecord record)
        {
            bool marked = HasVisibleMarkup();
            using SD.Bitmap burned = marked ? BurnMarkup() : new SD.Bitmap(_markupBase);
            string thumbnail = Convert.ToBase64String(EncodeScaled(burned, THUMB_WIDTH, THUMB_HEIGHT, crop: true, THUMB_JPEG_QUALITY));
            byte[] snapshot = marked ? EncodeScaled(burned, burned.Width, burned.Height, crop: false, SNAPSHOT_JPEG_QUALITY) : _markupBaseBytes;
            Comments.SetMarkup(record, thumbnail, snapshot, marked ? _markupBaseBytes : null);
        }

        #endregion
    }
}
