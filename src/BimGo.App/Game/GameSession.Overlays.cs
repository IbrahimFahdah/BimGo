using BimGo.Audio;
using BimGo.Platform;
using BimGo.Rendering;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Small reusable overlays for the panels (Round C, C-B1 fixes): a <b>dropdown</b> (click → a list over the panel,
    /// the wheel scrolls it, a click picks, Esc or a click outside closes) and an in-panel <b>confirm</b> (a question
    /// with its action button, CANCEL and an optional "don't ask again this session" tick). While one is open it is
    /// modal for the panel that opened it: the panel calls <see cref="BeginOverlays"/> before drawing (the overlay takes
    /// that frame's click and wheel, so nothing under it reacts) and <see cref="DrawOverlays"/> after (drawn on top,
    /// handling the click). A dropdown's labels are copied when it opens, never built per frame.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>An open dropdown: who opened it, where, its choices and what a pick does.</summary>
        private sealed class DropdownState
        {
            public object Owner;
            public int Slot;
            public float X, Y, W, H;
            public readonly List<string> Labels = new();
            public int Selected;
            public int Scroll;
            public bool Fresh;
            public Action<int> Pick;
        }

        /// <summary>An open confirm: the question, the action's label and what it does (true: "don't ask again" ticked).</summary>
        private sealed class ConfirmState
        {
            public string Title, Message, Action;
            public bool Danger, OfferSkip, Skip;
            public Action<bool> Confirmed;

            // C-B3: the tick's own label (null: "Don't ask again this session"), and an optional second action
            public string SkipLabel;
            public string AltAction;
            public Action<bool> AltConfirmed;
        }

        private const int DROPDOWN_MAX_ROWS = 12;

        private DropdownState _dropdown;
        private ConfirmState _confirm;
        private bool _overlayClick;
        private int _overlayWheel;

        #endregion

        #region Open / close

        /// <summary>True while a dropdown or a confirm is open.</summary>
        private bool OverlayOpen => _dropdown != null || _confirm != null;

        /// <summary>True when this owner's dropdown (one owner can have several: <paramref name="slot"/>) is open.</summary>
        private bool IsDropdownOpen(object owner, int slot) => _dropdown != null && ReferenceEquals(_dropdown.Owner, owner) && _dropdown.Slot == slot;

        /// <summary>
        /// Opens a dropdown under (or above, when there's no room) its button.
        /// </summary>
        /// <param name="owner">Whose it is (with <paramref name="slot"/>: tells the open one apart).</param>
        /// <param name="slot">Which of the owner's dropdowns.</param>
        /// <param name="x">The button's left.</param>
        /// <param name="y">The button's top.</param>
        /// <param name="w">The button's width (the list is at least this wide).</param>
        /// <param name="h">The button's height.</param>
        /// <param name="labels">The choices (copied).</param>
        /// <param name="selected">The current choice, or −1.</param>
        /// <param name="pick">What picking choice i does (called after the list closes).</param>
        private void OpenDropdown(object owner, int slot, float x, float y, float w, float h, IReadOnlyList<string> labels, int selected, Action<int> pick)
        {
            var state = new DropdownState { Owner = owner, Slot = slot, X = x, Y = y, W = w, H = h, Selected = selected, Fresh = true, Pick = pick };
            for (int i = 0; i < labels.Count; i++) { state.Labels.Add(labels[i] ?? string.Empty); }
            _dropdown = state;
            _confirm = null;
        }

        /// <summary>
        /// Opens a confirm over the panel.
        /// </summary>
        /// <param name="title">The heading ("RE-RUN TESTS?").</param>
        /// <param name="message">The question in full.</param>
        /// <param name="action">The action button's label ("RE-RUN").</param>
        /// <param name="danger">Draw the action as destructive.</param>
        /// <param name="offerSkip">Show "Don't ask again this session".</param>
        /// <param name="confirmed">What the action does (true when the tick was on).</param>
        private void OpenConfirm(string title, string message, string action, bool danger, bool offerSkip, Action<bool> confirmed)
        {
            _confirm = new ConfirmState { Title = title, Message = message, Action = action, Danger = danger, OfferSkip = offerSkip, Confirmed = confirmed };
            _dropdown = null;
        }

        /// <summary>
        /// Opens a confirm with a second action and / or a tick of its own (Round C-B3: "update them" / "new only", with
        /// "replace marked-up pictures too").
        /// </summary>
        /// <param name="tickLabel">The tick's text (null: no tick).</param>
        /// <param name="altAction">The second action's label (null: none).</param>
        /// <param name="altConfirmed">What the second action does (true when the tick was on).</param>
        private void OpenChoice(string title, string message, string action, bool danger, string tickLabel, string altAction,
            Action<bool> confirmed, Action<bool> altConfirmed)
        {
            _confirm = new ConfirmState
            {
                Title = title, Message = message, Action = action, Danger = danger, Confirmed = confirmed,
                OfferSkip = tickLabel != null, SkipLabel = tickLabel, AltAction = altAction, AltConfirmed = altConfirmed
            };
            _dropdown = null;
        }

        /// <summary>Esc: closes an open dropdown or confirm.</summary>
        /// <returns>True if something closed.</returns>
        private bool CloseOverlay()
        {
            if (!OverlayOpen) { return false; }
            _dropdown = null;
            _confirm = null;
            return true;
        }

        #endregion

        #region Frame

        /// <summary>
        /// Call before drawing a panel that can open overlays: an open overlay takes this frame's click and wheel.
        /// </summary>
        private void BeginOverlays(InputState input)
        {
            _overlayClick = false;
            _overlayWheel = 0;

            // C-C1: a right-click closes an open list and goes through (a right-click menu may open on another row)
            if (_dropdown != null && input.RightPressed) { _dropdown = null; }
            if (!OverlayOpen) { return; }
            _overlayClick = input.LeftPressed;
            _overlayWheel = input.Wheel;
            input.ConsumeClicks();
            input.ConsumeWheel();
        }

        /// <summary>
        /// Call after drawing the panel: draws the open overlay on top and handles the click it took.
        /// </summary>
        /// <param name="f">Fonts.</param>
        /// <param name="input">Input (for the mouse position).</param>
        /// <param name="bx">The panel's left (overlays stay inside it).</param>
        /// <param name="by">The panel's top.</param>
        /// <param name="bw">The panel's width.</param>
        /// <param name="bh">The panel's height.</param>
        private void DrawOverlays(FontAtlas f, InputState input, float bx, float by, float bw, float bh)
        {
            if (_confirm != null) { DrawConfirm(f, input, bx, by, bw, bh); }
            else if (_dropdown != null) { DrawDropdown(f, input, by, bh); }
            _overlayClick = false;
            _overlayWheel = 0;
        }

        #endregion

        #region Widgets

        /// <summary>
        /// A dropdown's button: the current choice, left-aligned, and a chevron (drawn, so it needs no glyph).
        /// </summary>
        /// <returns>True when clicked (open the list then; a click while it is open closes it instead).</returns>
        private bool DropdownButton(FontAtlas f, InputState input, float x, float y, float w, float h, string label, bool open)
        {
            bool hover = Hover(input, x, y, w, h);
            _ui.Rect(x, y, w, h, open ? Rgba.Hex(0x22D3EE, 0.14f) : hover ? Rgba.Hex(0xFFFFFF, 0.1f) : UiTheme.CONTROL);
            _ui.Outline(x, y, w, h, MathF.Max(1f, UiScale), open ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
            float chevron = S(20);
            _ui.TextWrapped(f.Small, x + S(8), y + h * 0.5f - f.Small.LineHeight * 0.5f, w - chevron - S(12), label ?? string.Empty,
                hover || open ? UiTheme.ACCENT : UiTheme.TEXT, maxLines: 1);
            DrawChevron(x + w - chevron * 0.5f - S(4), y + h * 0.5f, S(4.5f), open, hover || open ? UiTheme.ACCENT : UiTheme.TEXT_SOFT);

            bool clicked = hover && input.LeftPressed;
            if (clicked)
            {
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
            }
            return clicked;
        }

        /// <summary>A small down (or up) triangle centred on a point.</summary>
        private void DrawChevron(float cx, float cy, float r, bool up, uint colour)
        {
            if (up) { _ui.Triangle(cx - r, cy + r * 0.5f, cx + r, cy + r * 0.5f, cx, cy - r * 0.6f, colour); }
            else { _ui.Triangle(cx - r, cy - r * 0.5f, cx + r, cy - r * 0.5f, cx, cy + r * 0.6f, colour); }
        }

        /// <summary>The open dropdown's list.</summary>
        private void DrawDropdown(FontAtlas f, InputState input, float boundsY, float boundsH)
        {
            DropdownState d = _dropdown;
            int count = d.Labels.Count;
            float rowH = MathF.Max(d.H, S(30));
            float pad = S(4);

            // Below the button when there's room for a few rows, else above (whichever has more room)
            float below = boundsY + boundsH - (d.Y + d.H) - pad * 2f;
            float above = d.Y - boundsY - pad * 2f;
            int wanted = Math.Min(Math.Max(count, 1), DROPDOWN_MAX_ROWS);
            bool down = below >= rowH * Math.Min(wanted, 4) || below >= above;
            int visible = Math.Clamp((int)((down ? below : above) / rowH), 1, wanted);
            float listH = visible * rowH + pad * 2f;
            float listW = MathF.Max(d.W, S(160));
            float lx = d.X;
            float ly = down ? d.Y + d.H + S(2) : d.Y - S(2) - listH;

            int maxScroll = Math.Max(0, count - visible);
            if (d.Fresh)
            {
                d.Fresh = false;
                d.Scroll = d.Selected >= 0 ? d.Selected - visible / 2 : 0;
            }
            bool overList = Hover(input, lx, ly, listW, listH, focus: false);
            if (_overlayWheel != 0 && overList) { d.Scroll -= _overlayWheel * (count > 30 ? 3 : 1); }
            d.Scroll = Math.Clamp(d.Scroll, 0, maxScroll);

            _ui.Rect(lx + S(3), ly + S(4), listW, listH, Rgba.Hex(0x000000, 0.35f)); // shadow
            _ui.Panel(lx, ly, listW, listH, Rgba.Hex(0x111418, 0.98f), UiTheme.ACCENT);

            int picked = -1;
            int last = Math.Min(count, d.Scroll + visible);
            float scrollW = maxScroll > 0 ? S(6) : 0f;
            for (int i = d.Scroll; i < last; i++)
            {
                float ry = ly + pad + (i - d.Scroll) * rowH;
                bool hover = Hover(input, lx + pad, ry, listW - pad * 2f, rowH);
                bool current = i == d.Selected;
                if (hover || current) { _ui.Rect(lx + pad, ry, listW - pad * 2f - scrollW, rowH, hover ? Rgba.Hex(0xFFFFFF, 0.1f) : Rgba.Hex(0x22D3EE, 0.12f)); }
                if (current) { _ui.Rect(lx + pad, ry, S(3), rowH, UiTheme.ACCENT); }
                _ui.TextWrapped(f.Body, lx + pad + S(10), ry + rowH * 0.5f - f.Body.LineHeight * 0.5f, listW - pad * 2f - S(20) - scrollW, d.Labels[i],
                    current ? UiTheme.ACCENT : UiTheme.TEXT, maxLines: 1);
                if (hover && _overlayClick) { picked = i; }
            }
            if (count == 0) { _ui.Text(f.Body, lx + pad + S(10), ly + pad + rowH * 0.5f - f.Body.LineHeight * 0.5f, "(nothing to pick)", UiTheme.TEXT_MUTED); }

            // Scroll bar
            if (maxScroll > 0)
            {
                float trackH = listH - pad * 2f;
                float thumbH = MathF.Max(S(16), trackH * visible / count);
                float thumbY = ly + pad + (trackH - thumbH) * d.Scroll / maxScroll;
                _ui.Rect(lx + listW - pad - scrollW, ly + pad, scrollW, trackH, Rgba.Hex(0xFFFFFF, 0.05f));
                _ui.Rect(lx + listW - pad - scrollW, thumbY, scrollW, thumbH, Rgba.Hex(0xFFFFFF, 0.3f));
            }

            if (!_overlayClick) { return; }
            if (picked >= 0)
            {
                Action<int> pick = d.Pick;
                _dropdown = null;
                Sound.Play(SoundId.UiClick);
                pick?.Invoke(picked);
            }
            else if (!overList)
            {
                _dropdown = null; // a click outside (the button included) closes it
            }
        }

        /// <summary>The open confirm, centred over the panel (the panel dims behind it).</summary>
        private void DrawConfirm(FontAtlas f, InputState input, float bx, float by, float bw, float bh)
        {
            ConfirmState c = _confirm;
            _ui.Rect(bx, by, bw, bh, Rgba.Hex(0x000000, 0.45f));

            float w = MathF.Min(S(560), bw - S(40));
            float messageH = _ui.TextWrapped(f.Body, 0f, 0f, w - S(48), c.Message, UiTheme.TEXT, maxLines: 6, draw: false);
            float h = S(24) + S(26) + messageH + S(16) + (c.OfferSkip ? S(34) : 0f) + S(40) + S(24);
            float x = bx + (bw - w) * 0.5f, y = by + (bh - h) * 0.5f;
            _ui.Panel(x, y, w, h, UiTheme.CARD, c.Danger ? UiTheme.DANGER : UiTheme.ACCENT);

            float ix = x + S(24), iw = w - S(48);
            float cy = y + S(24);
            _ui.Text(f.Small, ix, cy, c.Title, c.Danger ? UiTheme.DANGER : UiTheme.ACCENT, S(1.6f));
            cy += S(26);
            _ui.TextWrapped(f.Body, ix, cy, iw, c.Message, UiTheme.TEXT, maxLines: 6);
            cy += messageH + S(16);

            if (c.OfferSkip)
            {
                float box = S(16);
                bool hoverSkip = Hover(input, ix, cy - S(3), iw, S(24));
                _ui.Rect(ix, cy, box, box, c.Skip ? UiTheme.ACCENT : UiTheme.CONTROL);
                _ui.Outline(ix, cy, box, box, MathF.Max(1f, UiScale), c.Skip ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
                if (c.Skip)
                {
                    _ui.Line(ix + box * 0.22f, cy + box * 0.52f, ix + box * 0.42f, cy + box * 0.72f, S(2), Rgba.Hex(0x06232A));
                    _ui.Line(ix + box * 0.42f, cy + box * 0.72f, ix + box * 0.8f, cy + box * 0.28f, S(2), Rgba.Hex(0x06232A));
                }
                _ui.Text(f.Body, ix + box + S(10), cy - S(1), c.SkipLabel ?? "Don't ask again this session", hoverSkip ? UiTheme.ACCENT : UiTheme.TEXT_SOFT);
                if (hoverSkip && _overlayClick)
                {
                    c.Skip = !c.Skip;
                    Sound.Play(SoundId.UiClick);
                    return;
                }
                cy += S(34);
            }

            float bwButton = c.AltAction != null ? MathF.Min(S(150), (iw - S(20)) / 3f) : S(150);
            bool cancel = OverlayButton(f, input, ix + iw - bwButton, cy, bwButton, S(36), "CANCEL", danger: false);
            bool act = OverlayButton(f, input, ix + iw - bwButton * 2f - S(10), cy, bwButton, S(36), c.Action, c.Danger);
            bool alt = c.AltAction != null && OverlayButton(f, input, ix + iw - bwButton * 3f - S(20), cy, bwButton, S(36), c.AltAction, danger: false);

            if (act)
            {
                _confirm = null;
                c.Confirmed?.Invoke(c.Skip);
            }
            else if (alt)
            {
                _confirm = null;
                c.AltConfirmed?.Invoke(c.Skip);
            }
            else if (cancel || (_overlayClick && !Hover(input, x, y, w, h, focus: false)))
            {
                _confirm = null;
            }
        }

        /// <summary>A button inside an overlay (it reads the click the overlay took).</summary>
        private bool OverlayButton(FontAtlas f, InputState input, float x, float y, float w, float h, string label, bool danger)
        {
            bool hover = Hover(input, x, y, w, h);
            _ui.Rect(x, y, w, h, hover ? Rgba.Hex(0xFFFFFF, 0.12f) : UiTheme.CONTROL);
            _ui.Outline(x, y, w, h, MathF.Max(1f, UiScale), danger ? Rgba.Hex(0xFCA5A5, 0.6f) : hover ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
            _ui.TextCentred(f.Small, x + w * 0.5f, y + h * 0.5f - f.Small.LineHeight * 0.5f, label, danger ? UiTheme.DANGER : hover ? UiTheme.ACCENT : UiTheme.TEXT, S(0.8f));
            bool clicked = hover && _overlayClick;
            if (clicked) { Sound.Play(SoundId.UiClick); }
            return clicked;
        }

        #endregion
    }
}
