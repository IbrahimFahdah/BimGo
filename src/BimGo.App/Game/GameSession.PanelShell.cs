using System.Numerics;
using BimGo.Audio;
using BimGo.Platform;
using BimGo.Rendering;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Polish round P-A1: one shell for the big panels that replace the pause menu (CLASHES, COLOUR PROFILES, COMMENTS,
    /// BOOKMARKS, TEXTURES, LIBRARY, ROOMS, GEOMETRY, CONTROLS; Round K-A: MEDIA).
    /// <list type="bullet">
    /// <item>A card sized to the window (standard, wide or side width; shorter windows get a shorter card).</item>
    /// <item>A header: the title, a sub-line and optional controls on the right (e.g. ADD, RUN ALL, tabs).</item>
    /// <item>A body between them, with clipped, pixel-scrolled <see cref="ScrollRegion"/>s (wheel, thumb drag, the
    /// gamepad stick through the wheel).</item>
    /// <item>A footer in fixed slots: ← BACK (one level back, as Esc and the gamepad's B) on the left, the panel's
    /// secondary actions centred, CLOSE (straight back to the walkthrough) on the right; a notice / hint strip above.</item>
    /// <item>Overlays: <see cref="BeginOverlays"/> at the start, <see cref="DrawOverlays"/> after the footer, so file
    /// and colour dialogs still run after the panel is drawn.</item>
    /// </list>
    /// Spacing comes from the <see cref="UiTheme"/> tokens. The window-size check (Esc → Appearance) cycles the window
    /// through 1280 × 720, 1920 × 1080 and 2560 × 1440 to check layouts.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Types

        /// <summary>A panel card's width class.</summary>
        private enum PanelSize
        {
            /// <summary>Lists and forms (ROOMS, BOOKMARKS, COMMENTS, TEXTURES, GEOMETRY).</summary>
            Standard,

            /// <summary>Two panes or a grid (CLASHES, LIBRARY, CONTROLS).</summary>
            Wide,

            /// <summary>Docked right with the model showing on the left (COLOUR PROFILES).</summary>
            Side
        }

        /// <summary>How a shell button looks.</summary>
        private enum ShellStyle
        {
            Normal,
            Primary,
            Danger
        }

        /// <summary>The open panel's layout this frame (from <see cref="BeginPanel"/>).</summary>
        private struct PanelFrame
        {
            /// <summary>The card.</summary>
            public float X, Y, W, H;

            /// <summary>The inner left and width (inside the padding).</summary>
            public float Ix, Iw;

            /// <summary>The body: under the header, above the notice strip.</summary>
            public float BodyTop, BodyBottom;

            /// <summary>The notice strip's top, and the footer buttons' top.</summary>
            public float NoticeY, FooterY;

            /// <summary>The header controls' top and height; <see cref="HeaderRight"/> moves left as controls are added.</summary>
            public float HeaderControlY, HeaderControlH, HeaderRight;

            /// <summary>The shell drew the overlays' begin (and draws them after the footer).</summary>
            public bool Overlays;

            /// <summary>The body's height.</summary>
            public readonly float BodyHeight => BodyBottom - BodyTop;
        }

        /// <summary>A queued footer action (drawn centred by <see cref="EndPanel"/>).</summary>
        private struct FooterItem
        {
            public string Label;
            public ShellStyle Style;
            public bool Enabled;
        }

        /// <summary>
        /// One clipped, pixel-scrolled region (a list or a form). The panel keeps one per list; the content height is
        /// measured as it is drawn and used from the next frame.
        /// </summary>
        private sealed class ScrollRegion
        {
            /// <summary>The scroll shown (eased towards <see cref="Target"/>) and the scroll wanted, in pixels.</summary>
            public float Offset, Target;

            /// <summary>The content's height (last frame).</summary>
            public float Content;

            /// <summary>The viewport this frame.</summary>
            public float X, Y, W, H;

            /// <summary>The content's top this frame (scrolled).</summary>
            public float Top;

            /// <summary>Scroll to the end once the content is measured (e.g. after adding a row).</summary>
            public bool PinEnd;

            /// <summary>The largest scroll.</summary>
            public float MaxScroll => MathF.Max(0f, Content - H);

            /// <summary>Back to the top at once.</summary>
            public void Reset()
            {
                Offset = Target = 0f;
                PinEnd = false;
            }

            /// <summary>Scrolls to the end once this frame's content is measured.</summary>
            public void ScrollToEnd() => PinEnd = true;

            /// <summary>
            /// Scrolls the least needed to show a span of the content (content coordinates: 0 = the content's top).
            /// </summary>
            public void Reveal(float top, float bottom)
            {
                if (top < Target) { Target = top; }
                else if (bottom > Target + H) { Target = bottom - H; }
            }
        }

        #endregion

        #region Fields

        /// <summary>Footer return values: nothing pressed, or the panel was left (BACK / CLOSE): return at once.</summary>
        private const int FOOTER_NONE = -1, FOOTER_LEFT = -2;

        private readonly List<FooterItem> _footerItems = new();

        // The scroll bar being dragged (one at a time) and where on the thumb it was grabbed
        private ScrollRegion _scrollDrag;
        private float _scrollDragGrab;

        // Window-size check: the sizes (logical: times the UI scale), the one shown (−1 = the window's own) and the size
        // to go back to
        private static readonly (int W, int H)[] CHECK_SIZES = { (1280, 720), (1920, 1080), (2560, 1440) };
        private static readonly string[] CHECK_SIZE_OPTIONS = { "Own", "720p", "1080p", "1440p" };
        private int _checkSize = -1;
        private int _ownWidth, _ownHeight;

        #endregion

        #region Frame

        /// <summary>
        /// Draws the backdrop, the card and the header, and lays out the body and footer. Call <see cref="EndPanel"/>
        /// after the body.
        /// </summary>
        /// <param name="size">The card's width class.</param>
        /// <param name="title">The title (upper case).</param>
        /// <param name="titleColour">The title's colour (the panel's theme colour).</param>
        /// <param name="subLine">The line under the title (counts, where things are saved), or empty.</param>
        /// <param name="headerControls">Width kept on the right of the header for controls (<see cref="HeaderButton"/>,
        /// tabs); the sub-line stops short of it.</param>
        /// <param name="overlays">The panel opens dropdowns or confirms: the shell begins and draws them.</param>
        private PanelFrame BeginPanel(PanelSize size, string title, uint titleColour, ReadOnlySpan<char> subLine, float headerControls = 0f, bool overlays = false)
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            int width = _window.Width, height = _window.Height;
            if (overlays) { BeginOverlays(input); }
            _footerItems.Clear();

            float margin = height >= S(900) ? S(UiTheme.PANEL_MARGIN_LARGE) : S(UiTheme.PANEL_MARGIN);
            float wanted = S(size switch { PanelSize.Wide => UiTheme.PANEL_WIDTH_WIDE, PanelSize.Side => UiTheme.PANEL_WIDTH_SIDE, _ => UiTheme.PANEL_WIDTH });
            float w = MathF.Min(wanted, width - margin * 2f);
            float h = height - margin * 2f;
            float x = size == PanelSize.Side ? width - w - margin : MathF.Round((width - w) * 0.5f);
            float y = margin;

            if (size == PanelSize.Side)
            {
                // The model shows on the left (lightly dimmed)
                _ui.Rect(0, 0, width, height, Rgba.Hex(0x101318, 0.25f));
                _ui.Panel(x, y, w, h, Rgba.Hex(0x181C22, 0.97f), UiTheme.CARD_BORDER);
            }
            else
            {
                _ui.Rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);
                _ui.Panel(x, y, w, h, UiTheme.CARD, UiTheme.CARD_BORDER);
            }

            var frame = new PanelFrame
            {
                X = x, Y = y, W = w, H = h,
                Ix = x + S(UiTheme.PANEL_PAD), Iw = w - S(UiTheme.PANEL_PAD) * 2f,
                Overlays = overlays
            };
            frame.HeaderControlH = S(UiTheme.CONTROL_HEIGHT);
            frame.HeaderControlY = y + MathF.Round((S(UiTheme.HEADER_HEIGHT) - frame.HeaderControlH) * 0.5f);
            frame.HeaderRight = frame.Ix + frame.Iw;
            frame.FooterY = y + h - S(UiTheme.PANEL_PAD_Y) - S(UiTheme.FOOTER_HEIGHT);
            frame.NoticeY = frame.FooterY - S(UiTheme.GAP_SMALL) - S(UiTheme.NOTICE_HEIGHT);
            frame.BodyTop = y + S(UiTheme.HEADER_HEIGHT) + S(UiTheme.GAP);
            frame.BodyBottom = frame.NoticeY - S(UiTheme.GAP_SMALL);

            // Header: the title, the sub-line beneath it (stopping short of the header controls), a divider
            float textW = frame.Iw - headerControls - (headerControls > 0f ? S(UiTheme.GAP) : 0f);
            _ui.Text(f.Small, frame.Ix, y + S(UiTheme.PANEL_PAD_Y), title, titleColour, S(2f));
            if (!subLine.IsEmpty)
            {
                _ui.TextWrapped(f.Small, frame.Ix, y + S(UiTheme.PANEL_PAD_Y) + S(18), MathF.Max(textW, S(40)), subLine, UiTheme.TEXT_MUTED, maxLines: 1);
            }
            _ui.Rect(x + S(1), y + S(UiTheme.HEADER_HEIGHT), w - S(2), MathF.Max(1f, UiScale), UiTheme.DIVIDER);
            return frame;
        }

        /// <summary>
        /// A header control slot of this width, from the right (controls are added right to left).
        /// </summary>
        /// <returns>The slot's left.</returns>
        private static float TakeHeaderSlot(ref PanelFrame frame, float width, float gap)
        {
            frame.HeaderRight -= width;
            float left = frame.HeaderRight;
            frame.HeaderRight -= gap;
            return left;
        }

        /// <summary>
        /// A button in the header's right-hand controls (right to left): the panel's main action (ADD, RUN ALL…).
        /// </summary>
        /// <returns>True when pressed.</returns>
        private bool HeaderButton(ref PanelFrame frame, string label, ShellStyle style = ShellStyle.Normal, bool enabled = true, float width = 0f)
        {
            FontAtlas f = _ui.Atlas;
            float w = width > 0f ? width : ShellButtonWidth(f, label);
            float x = TakeHeaderSlot(ref frame, w, S(UiTheme.GAP_SMALL));
            return ShellButton(f, _window.Input, x, frame.HeaderControlY, w, frame.HeaderControlH, label, style, enabled);
        }

        /// <summary>
        /// Queues a footer action (drawn centred by <see cref="EndPanel"/>, which returns its index when pressed).
        /// </summary>
        /// <returns>The action's index.</returns>
        private int FooterAction(string label, ShellStyle style = ShellStyle.Normal, bool enabled = true)
        {
            _footerItems.Add(new FooterItem { Label = label ?? string.Empty, Style = style, Enabled = enabled });
            return _footerItems.Count - 1;
        }

        /// <summary>
        /// Draws the notice strip (the notice in amber, else the hint, faint), the footer (← BACK · the queued actions ·
        /// CLOSE) and the overlays, and handles BACK and CLOSE.
        /// </summary>
        /// <param name="frame">The frame from <see cref="BeginPanel"/>.</param>
        /// <param name="notice">The panel's last message (null: none).</param>
        /// <param name="hint">How to use the panel (shown when there's no notice; null: none).</param>
        /// <param name="backLabel">The BACK button's text (null: "← BACK").</param>
        /// <returns>The index of the action pressed, <see cref="FOOTER_NONE"/>, or <see cref="FOOTER_LEFT"/> when BACK or CLOSE
        /// left the panel (the caller returns at once).</returns>
        private int EndPanel(in PanelFrame frame, string notice, string hint, string backLabel = null)
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;

            // Notice / hint strip
            float stripY = frame.NoticeY + (S(UiTheme.NOTICE_HEIGHT) - f.Body.LineHeight) * 0.5f;
            if (!string.IsNullOrEmpty(notice)) { _ui.TextWrapped(f.Body, frame.Ix, stripY, frame.Iw, notice, UiTheme.MEASURE_TEXT, maxLines: 1); }
            else if (!string.IsNullOrEmpty(hint)) { _ui.TextWrapped(f.Small, frame.Ix, stripY + S(2), frame.Iw, hint, UiTheme.TEXT_FAINT, maxLines: 1); }
            _ui.Rect(frame.X + S(1), frame.NoticeY - S(UiTheme.GAP_SMALL) * 0.5f, frame.W - S(2), MathF.Max(1f, UiScale), UiTheme.DIVIDER);

            // BACK (left) and CLOSE (right): fixed slots
            float y = frame.FooterY, h = S(UiTheme.FOOTER_HEIGHT);
            float side = MathF.Min(S(UiTheme.FOOTER_SIDE_WIDTH), frame.Iw * 0.2f);
            bool back = ShellButton(f, input, frame.Ix, y, side, h, backLabel ?? "← BACK", ShellStyle.Normal, true);
            bool close = ShellButton(f, input, frame.Ix + frame.Iw - side, y, side, h, "CLOSE", ShellStyle.Normal, true);

            // The actions, centred between them (narrowed evenly when they don't all fit)
            int pressed = FOOTER_NONE;
            int count = _footerItems.Count;
            if (count > 0)
            {
                float gap = S(UiTheme.GAP);
                float left = frame.Ix + side + gap * 2f, right = frame.Ix + frame.Iw - side - gap * 2f;
                float room = right - left - gap * (count - 1);
                float total = 0f;
                for (int i = 0; i < count; i++) { total += ShellButtonWidth(f, _footerItems[i].Label); }
                float squeeze = total > room && total > 0f ? room / total : 1f;
                float used = total * squeeze + gap * (count - 1);
                float bx = MathF.Round(left + MathF.Max(0f, (right - left - used) * 0.5f));
                for (int i = 0; i < count; i++)
                {
                    FooterItem item = _footerItems[i];
                    float bw = MathF.Floor(ShellButtonWidth(f, item.Label) * squeeze);
                    if (ShellButton(f, input, bx, y, bw, h, item.Label, item.Style, item.Enabled)) { pressed = i; }
                    bx += bw + gap;
                }
            }
            _footerItems.Clear();

            if (frame.Overlays) { DrawOverlays(f, input, frame.X, frame.Y, frame.W, frame.H); }

            if (back)
            {
                PanelBack();
                return FOOTER_LEFT;
            }
            if (close)
            {
                ClosePanelToGame();
                return FOOTER_LEFT;
            }
            return pressed;
        }

        #endregion

        #region Docks (P-A2)

        /// <summary>The open dock's layout this frame (from <see cref="BeginDock"/>).</summary>
        private struct DockFrame
        {
            /// <summary>The dock.</summary>
            public float X, Y, W, H;

            /// <summary>The inner left and width (inside the padding).</summary>
            public float Ix, Iw;

            /// <summary>The body (scrolled): under the header, above the notice strip or the footer.</summary>
            public float BodyTop, BodyBottom;

            /// <summary>The notice strip's top (when asked for), and the footer buttons' top.</summary>
            public float NoticeY, FooterY;

            /// <summary>The header controls' top and height; <see cref="HeaderRight"/> moves left as they are added.</summary>
            public float HeaderControlY, HeaderControlH, HeaderRight;

            /// <summary>The dock keeps a notice strip above the footer.</summary>
            public bool Notice;

            /// <summary>The dock's rectangle (x, y, w, h), for the clicks-over-the-dock checks.</summary>
            public readonly Vector4 Rect => new(X, Y, W, H);
        }

        /// <summary><see cref="EndDock"/>'s results: nothing, CLOSE, ← BACK.</summary>
        private const int DOCK_NONE = 0, DOCK_CLOSE = 1, DOCK_BACK = 2;

        // A dock sat over the minimap (a short window): last frame's (the minimap hides) and this frame's
        private bool _dockOverMap, _dockOverMapNext;

        // The docks' bodies
        private readonly ScrollRegion _sunDockScroll = new(), _studyDockScroll = new(), _sectionDockScroll = new(), _gridsDockScroll = new();

        /// <summary>
        /// The right-hand column for a dock of this width (walkthrough: under the minimap when it shows, down to just
        /// above the sun icon; a window too short for <see cref="UiTheme.DOCK_MIN_HEIGHT"/> there puts the dock at the
        /// top, over the minimap, which hides). Clash mode: left of the clash dock, the full height.
        /// </summary>
        private void DockColumn(float width, out float x, out float top, out float bottom)
        {
            int screenW = _window.Width, screenH = _window.Height;
            if (_clashModeOn)
            {
                x = _clashDockW > 0f ? _clashDockX - S(UiTheme.COLUMN_GAP) - width : screenW - S(16) - width;
                x = MathF.Max(S(10), x);
                top = S(16);
                bottom = screenH - S(16);
                return;
            }

            float margin = S(UiTheme.COLUMN_MARGIN);
            x = screenW - margin - width;
            top = margin;
            bottom = screenH - margin - S(UiTheme.SUN_ICON_SIZE) - S(10);
            if (_showMap)
            {
                float under = margin + S(UiTheme.MINIMAP_HEIGHT) + S(UiTheme.COLUMN_GAP);
                if (bottom - under >= S(UiTheme.DOCK_MIN_HEIGHT)) { top = under; }
                else { _dockOverMapNext = true; }
            }
            bottom = MathF.Max(bottom, top + S(120));
        }

        /// <summary>
        /// Draws a dock (a compact panel in the right-hand column: sun, study, section box, grids) and its header, and
        /// lays out the body and footer. The dock is as tall as its content (last frame's) and the column allows; the
        /// body scrolls when it doesn't fit. Draw the body between <see cref="BeginDockBody"/> and
        /// <see cref="EndDockBody"/>, then call <see cref="EndDock"/>.
        /// </summary>
        /// <param name="title">The title (upper case).</param>
        /// <param name="titleColour">The title's colour.</param>
        /// <param name="border">The dock's border (its theme colour).</param>
        /// <param name="width">The dock's width (scaled: <see cref="UiTheme.DOCK_WIDTH"/> or the wide one).</param>
        /// <param name="body">The body's scroll region (its content height sizes the dock).</param>
        /// <param name="notice">Keep a notice strip above the footer (the dock has a message to show).</param>
        /// <param name="fullHeight">Take the column's whole height (a body laid out against the bottom).</param>
        private DockFrame BeginDock(string title, uint titleColour, uint border, float width, ScrollRegion body, bool notice, bool fullHeight = false)
        {
            FontAtlas f = _ui.Atlas;
            DockColumn(width, out float x, out float top, out float bottom);
            float padY = S(UiTheme.DOCK_PAD_Y), gap = S(UiTheme.GAP_SMALL);
            float header = S(UiTheme.DOCK_HEADER_HEIGHT), footer = S(UiTheme.DOCK_FOOTER_HEIGHT);
            float noticeH = notice ? S(UiTheme.DOCK_NOTICE_HEIGHT) + gap : 0f;
            float chrome = header + gap * 2f + noticeH + footer + padY;
            float room = bottom - top;
            float content = !fullHeight && body != null && body.Content > 0f ? body.Content : room;
            float h = MathF.Round(MathF.Min(room, chrome + content));

            _ui.Panel(x, top, width, h, UiTheme.PANEL_STRONG, border);
            RegisterFocusArea(x, top, width, h);

            var d = new DockFrame
            {
                X = x, Y = top, W = width, H = h,
                Ix = x + S(UiTheme.DOCK_PAD), Iw = width - S(UiTheme.DOCK_PAD) * 2f,
                Notice = notice
            };
            d.HeaderControlH = S(22);
            d.HeaderControlY = top + MathF.Round((header - d.HeaderControlH) * 0.5f);
            d.HeaderRight = d.Ix + d.Iw;
            d.FooterY = top + h - padY - footer;
            d.NoticeY = d.FooterY - gap - S(UiTheme.DOCK_NOTICE_HEIGHT);
            d.BodyTop = top + header + gap;
            d.BodyBottom = MathF.Max(d.BodyTop + S(20), (notice ? d.NoticeY : d.FooterY) - gap);

            _ui.Text(f.Small, d.Ix, top + MathF.Round((header - f.Small.LineHeight) * 0.5f), title, titleColour, S(1.6f));
            _ui.Rect(x + S(1), top + header, width - S(2), MathF.Max(1f, UiScale), UiTheme.DIVIDER);
            return d;
        }

        /// <summary>A small button in the dock's header (right to left).</summary>
        /// <returns>True when pressed.</returns>
        private bool DockHeaderButton(ref DockFrame d, string label, float width)
        {
            d.HeaderRight -= width;
            float x = d.HeaderRight;
            d.HeaderRight -= S(UiTheme.GAP_SMALL);
            return SmallButton(_ui.Atlas, _window.Input, x, d.HeaderControlY, width, d.HeaderControlH, label);
        }

        /// <summary>
        /// Starts the dock's body: a clipped scroll region (the bar sits in the right-hand padding, so the body keeps
        /// <see cref="DockFrame.Iw"/>; the wheel is left to a dragged slider).
        /// </summary>
        /// <returns>The body's first line (scrolled).</returns>
        private float BeginDockBody(in DockFrame d, ScrollRegion body, InputState input)
        {
            float top = BeginScroll(body, input, d.X + S(6), d.BodyTop, d.W - S(8), d.BodyBottom - d.BodyTop, out _, wheel: _activeSlider < 0);
            return top + S(2);
        }

        /// <summary>Ends the dock's body at the content's bottom (measured for the next frame's height).</summary>
        private void EndDockBody(ScrollRegion body, InputState input, float contentBottom) => EndScroll(body, input, contentBottom + S(4));

        /// <summary>
        /// Draws the notice strip (when the dock kept one), a divider and the footer: ← BACK (when given) on the left,
        /// the hint beside it, CLOSE on the right.
        /// </summary>
        /// <returns><see cref="DOCK_CLOSE"/>, <see cref="DOCK_BACK"/> or <see cref="DOCK_NONE"/> (the caller closes / goes back).</returns>
        private int EndDock(in DockFrame d, string notice, string hint, string backLabel = null, string closeLabel = "CLOSE")
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            float gap = S(UiTheme.GAP_SMALL);

            _ui.Rect(d.X + S(1), d.BodyBottom + gap * 0.5f, d.W - S(2), MathF.Max(1f, UiScale), UiTheme.DIVIDER);
            if (d.Notice && !string.IsNullOrEmpty(notice))
            {
                _ui.TextWrapped(f.Small, d.Ix, d.NoticeY + S(2), d.Iw, notice, UiTheme.MEASURE_TEXT, maxLines: 2);
            }

            float y = d.FooterY, h = S(UiTheme.DOCK_FOOTER_HEIGHT);
            float closeW = MathF.Max(S(84), UiBatch.Measure(f.Bold, closeLabel, S(1f)) + S(28));
            float left = d.Ix;
            bool back = false;
            if (backLabel != null)
            {
                float backW = MathF.Max(S(84), UiBatch.Measure(f.Bold, backLabel, S(1f)) + S(28));
                back = ShellButton(f, input, d.Ix, y, backW, h, backLabel, ShellStyle.Normal, true);
                left += backW + gap;
            }
            bool close = ShellButton(f, input, d.Ix + d.Iw - closeW, y, closeW, h, closeLabel, ShellStyle.Normal, true);
            float hintW = d.Ix + d.Iw - closeW - gap - left;
            if (!string.IsNullOrEmpty(hint) && hintW > S(30))
            {
                _ui.TextWrapped(f.Small, left, y + MathF.Round((h - f.Small.LineHeight) * 0.5f), hintW, hint, UiTheme.TEXT_FAINT, maxLines: 1);
            }
            return back ? DOCK_BACK : close ? DOCK_CLOSE : DOCK_NONE;
        }

        #endregion

        #region Back / close

        /// <summary>True while one of the panels that replace the pause menu is open.</summary>
        private bool AnyBigPanelOpen => IsCommentsPanelOpen || IsBookmarksPanelOpen || IsTexturesPanelOpen || IsLibraryPanelOpen || IsRoomsPanelOpen
            || IsClashesPanelOpen || IsColourProfilesPanelOpen || IsGeometryPanelOpen || IsControlsPanelOpen || IsPushPanelOpen || IsMediaPanelOpen;

        /// <summary>
        /// One level back (Esc, the gamepad's B, ← BACK): an open dropdown or confirm, then the panel's sub-view, then
        /// the panel (to the pause menu, or to clash mode for the clash panel opened there).
        /// </summary>
        /// <returns>True when something closed (false: nothing open, so Esc resumes).</returns>
        private bool PanelBack()
        {
            if (!_paused) { return false; }
            if (AnyBigPanelOpen && CloseOverlay()) { return true; }
            return CloseMenuPreview() || ClosePush() || CloseComments() || CloseBookmarks() || CloseTextures() || CloseLibrary() || CloseRooms()
                || CloseClashes() || CloseColourProfiles() || CloseGeometry() || CloseControls() || CloseMedia();
        }

        /// <summary>
        /// CLOSE: every level of the open panel closes and the walkthrough (or clash mode) carries on.
        /// </summary>
        private void ClosePanelToGame()
        {
            _profilesReturnFromClashes = false; // straight out, not back to the colour profiles
            CloseOverlay();
            for (int guard = 0; guard < 12 && AnyBigPanelOpen; guard++)
            {
                if (!PanelBack()) { break; }
            }
            if (_paused && !AnyBigPanelOpen) { SetPaused(false); }
        }

        #endregion

        #region Widgets

        /// <summary>A shell button's natural width (its label plus padding, within the footer bounds).</summary>
        private float ShellButtonWidth(FontAtlas f, string label) =>
            Math.Clamp(UiBatch.Measure(f.Bold, label, S(1f)) + S(36), S(UiTheme.FOOTER_ACTION_MIN), S(UiTheme.FOOTER_ACTION_MAX));

        /// <summary>
        /// The shell's button: a centred label (clipped to the button), outlined, or filled when primary. A disabled
        /// button is faded and never reports a press.
        /// </summary>
        /// <returns>True when pressed.</returns>
        private bool ShellButton(FontAtlas f, InputState input, float x, float y, float w, float h, string label, ShellStyle style, bool enabled)
        {
            bool hover = enabled && Hover(input, x, y, w, h);
            float alpha = enabled ? 1f : 0.4f;
            uint text;
            if (style == ShellStyle.Primary)
            {
                _ui.Rect(x, y, w, h, Fade(hover ? UiTheme.FOCUS : UiTheme.ACCENT, alpha));
                text = Rgba.Hex(0x06232A);
            }
            else
            {
                _ui.Rect(x, y, w, h, hover ? UiTheme.HOVER : UiTheme.CONTROL);
                uint border = style == ShellStyle.Danger ? Rgba.Hex(0xFCA5A5, 0.45f) : hover ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER;
                _ui.Outline(x, y, w, h, MathF.Max(1f, UiScale), Fade(border, alpha));
                text = Fade(style == ShellStyle.Danger ? UiTheme.DANGER : hover ? UiTheme.ACCENT : UiTheme.TEXT, alpha);
            }

            _ui.PushClip(x + S(4), y, w - S(8), h);
            float labelW = UiBatch.Measure(f.Bold, label, S(1f));
            float lx = labelW <= w - S(16) ? x + (w - labelW) * 0.5f : x + S(8);
            _ui.Text(f.Bold, lx, y + h * 0.5f - f.Bold.LineHeight * 0.5f, label, text, S(1f));
            _ui.PopClip();

            bool clicked = hover && input.LeftPressed;
            if (clicked)
            {
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
            }
            return clicked;
        }

        /// <summary>A section heading inside a panel body (small, tracked, muted).</summary>
        /// <returns>The y below it.</returns>
        private float SectionLabel(FontAtlas f, float x, float y, string text)
        {
            _ui.Text(f.Small, x, y, text, UiTheme.TEXT_MUTED, S(1.8f));
            return y + S(24);
        }

        #endregion

        #region Scroll regions

        /// <summary>
        /// Starts a clipped scroll region: the wheel (and the gamepad's scroll stick) scrolls it while the cursor is over
        /// it. Draw the content from the returned top, then call <see cref="EndScroll"/> with the content's bottom.
        /// </summary>
        /// <param name="region">The region's state.</param>
        /// <param name="input">Input.</param>
        /// <param name="x">Viewport left.</param>
        /// <param name="y">Viewport top.</param>
        /// <param name="w">Viewport width (the bar's gutter is kept on the right).</param>
        /// <param name="h">Viewport height.</param>
        /// <param name="contentW">The width left for the content.</param>
        /// <param name="wheel">False: the wheel is left alone (e.g. CONTROLS while a key is being captured).</param>
        /// <returns>The content's top (scrolled).</returns>
        private float BeginScroll(ScrollRegion region, InputState input, float x, float y, float w, float h, out float contentW, bool wheel = true)
        {
            region.X = x;
            region.Y = y;
            region.W = w;
            region.H = MathF.Max(h, 1f);
            contentW = w - S(UiTheme.SCROLL_GUTTER);

            float max = region.MaxScroll;
            if (wheel && input.Wheel != 0 && Hover(input, x, y, w, h, focus: false))
            {
                region.Target -= input.Wheel * S(UiTheme.WHEEL_STEP);
                region.PinEnd = false;
            }
            if (!region.PinEnd) { region.Target = Math.Clamp(region.Target, 0f, max); }

            // Ease towards the target (a dragged thumb follows at once)
            if (_scrollDrag == region) { region.Offset = region.Target; }
            else
            {
                float k = 1f - MathF.Exp(-_frameTime * 18f);
                region.Offset += (region.Target - region.Offset) * k;
                if (MathF.Abs(region.Target - region.Offset) < 0.5f) { region.Offset = region.Target; }
            }
            region.Offset = Math.Clamp(region.Offset, 0f, max);

            _ui.PushClip(x, y, w, h);
            region.Top = MathF.Round(y - region.Offset);
            _focusRegion = region; // P-A2: gamepad focus targets drawn now belong to this list
            return region.Top;
        }

        /// <summary>
        /// Ends a scroll region: records the content's height and draws and handles the scroll bar (drag the thumb, or
        /// click the track to page).
        /// </summary>
        /// <param name="region">The region's state.</param>
        /// <param name="input">Input.</param>
        /// <param name="contentBottom">The content's bottom (in the same scrolled coordinates as the returned top).</param>
        private void EndScroll(ScrollRegion region, InputState input, float contentBottom)
        {
            _ui.PopClip();
            _focusRegion = null;
            region.Content = MathF.Max(0f, contentBottom - region.Top);
            if (region.PinEnd)
            {
                region.PinEnd = false;
                region.Target = region.MaxScroll;
            }

            float max = region.MaxScroll;
            if (!input.LeftDown && _scrollDrag == region) { _scrollDrag = null; }
            if (max <= 0f)
            {
                if (_scrollDrag == region) { _scrollDrag = null; }
                return;
            }

            float barW = S(UiTheme.SCROLLBAR_WIDTH);
            float trackX = region.X + region.W - barW - S(2), trackY = region.Y + S(2), trackH = region.H - S(4);
            float thumbH = MathF.Max(S(28), trackH * region.H / MathF.Max(region.Content, 1f));
            float thumbY = trackY + (trackH - thumbH) * (region.Offset / max);

            // A wider hit area than the bar itself
            bool overTrack = Hover(input, trackX - S(5), trackY, barW + S(9), trackH, focus: false);
            bool overThumb = overTrack && input.MousePosition.Y >= thumbY && input.MousePosition.Y < thumbY + thumbH;
            if (overTrack && input.LeftPressed)
            {
                input.ConsumeClicks();
                if (overThumb)
                {
                    _scrollDrag = region;
                    _scrollDragGrab = input.MousePosition.Y - thumbY;
                }
                else
                {
                    region.Target = Math.Clamp(region.Target + (input.MousePosition.Y < thumbY ? -1f : 1f) * region.H * 0.9f, 0f, max);
                }
            }
            if (_scrollDrag == region && input.LeftDown)
            {
                float t = trackH - thumbH > 0f ? (input.MousePosition.Y - _scrollDragGrab - trackY) / (trackH - thumbH) : 0f;
                region.Target = region.Offset = Math.Clamp(t, 0f, 1f) * max;
                thumbY = trackY + (trackH - thumbH) * (region.Offset / max);
            }

            bool hot = overThumb || _scrollDrag == region;
            _ui.Rect(trackX, trackY, barW, trackH, UiTheme.SCROLL_TRACK);
            _ui.Rect(trackX, thumbY, barW, thumbH, hot ? UiTheme.SCROLL_THUMB_HOT : UiTheme.SCROLL_THUMB);
        }

        /// <summary>True when a span (scrolled coordinates) shows in the region's viewport: draw only those.</summary>
        private static bool InView(ScrollRegion region, float y, float h) => y + h > region.Y && y < region.Y + region.H;

        /// <summary>
        /// The rows of a fixed-height list that show in the viewport (draw only these; the content still ends at
        /// top + count × rowH).
        /// </summary>
        /// <param name="region">The region (after <see cref="BeginScroll"/>).</param>
        /// <param name="rowH">Row pitch.</param>
        /// <param name="count">Row count.</param>
        /// <param name="first">The first row to draw.</param>
        /// <param name="last">One past the last row to draw.</param>
        private static void VisibleRows(ScrollRegion region, float rowH, int count, out int first, out int last)
        {
            if (rowH <= 0f || count <= 0)
            {
                first = last = 0;
                return;
            }
            first = Math.Clamp((int)MathF.Floor((region.Y - region.Top) / rowH), 0, count);
            last = Math.Clamp((int)MathF.Ceiling((region.Y + region.H - region.Top) / rowH), first, count);
        }

        #endregion

        #region Window-size check

        /// <summary>
        /// Esc → Appearance: the window-size check (Own · 720p · 1080p · 1440p). The sizes are logical (times the UI
        /// scale), so 720p at 150 % is a 1920 × 1080 pixel window: the layout a 1280 × 720 window gets at 100 %.
        /// </summary>
        /// <returns>The height used.</returns>
        private float BuildWindowCheckRow(FontAtlas f, InputState input, float x, float y, float w)
        {
            _ui.Text(f.Small, x, y, "WINDOW SIZE (LAYOUT CHECK)", UiTheme.TEXT_MUTED, S(1.8f));
            int current = _checkSize + 1;
            int picked = Segmented(f, input, x, y + S(20), w, CHECK_SIZE_OPTIONS, current);
            if (picked != current) { SetCheckSize(picked - 1); }
            return S(60);
        }

        /// <summary>Resizes the window to a check size (−1: back to its own size).</summary>
        private void SetCheckSize(int index)
        {
            if (_checkSize < 0)
            {
                _ownWidth = _window.Width;
                _ownHeight = _window.Height;
            }
            if (index < 0)
            {
                _checkSize = -1;
                if (_ownWidth > 0) { _window.SetClientSize(_ownWidth, _ownHeight); }
                Toast("Window back to its own size", 2f);
                return;
            }

            _checkSize = Math.Clamp(index, 0, CHECK_SIZES.Length - 1);
            (int w, int h) = CHECK_SIZES[_checkSize];
            int pw = (int)MathF.Round(w * UiScale), ph = (int)MathF.Round(h * UiScale);
            bool exact = _window.SetClientSize(pw, ph);
            Toast(exact
                ? $"Window {w} × {h} at UI scale {UiScale:0.##} ({pw} × {ph} px)"
                : $"{w} × {h} at UI scale {UiScale:0.##} doesn't fit this screen: the window is {_window.Width} × {_window.Height} px", 3.5f, important: !exact);
        }

        #endregion
    }
}
