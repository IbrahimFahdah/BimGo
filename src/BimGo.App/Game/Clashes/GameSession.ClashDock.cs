using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Format;
using BimGo.Native;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Clash mode's docked panel (Round C, build C-B1; dropdowns in the C-B1 fixes), on the right while you fly: the
    /// test (dropdown), filters (status and level dropdowns, search), the view (ghost / wireframe / real / hidden) and
    /// the section box toggle, the clash list (a click goes there), the current clash (pair, depth or gap, level, room,
    /// status 1–5, assignee, notes), SELECT IN REVIT, TESTS… (the CLASHES panel), FLY / INSTANT and EXIT. Row text is
    /// built when the list changes, never per frame. C-B2: a picture on each row (PICTURES on / off), TO COMMENT and
    /// TO COMMENTS… on the card (<see cref="GameSession"/>.ClashPictures), REVIT shows the clash in Revit.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private const int CLASH_SEARCH_MAX = 40;
        private static readonly string[] CLASH_STATUS_FILTERS = { "ALL", "OPEN", "NEW", "ACTIVE", "REVIEWED", "APPROVED", "RESOLVED" };

        private string _clashReviewTest;
        private readonly List<ClashRecord> _clashList = new();
        private readonly List<ClashRow> _clashDockRows = new();
        private readonly List<string> _clashLevels = new();
        private bool _clashListDirty = true;
        private int _clashListUnits = -1;
        private int _clashStatusFilter = 1; // open
        private string _clashLevelFilter;   // null = every level
        private readonly char[] _clashSearch = new char[CLASH_SEARCH_MAX];
        private int _clashSearchLength;
        private bool _clashSearchFocused;
        private int _clashDockScroll;
        private bool _clashScrollToCurrent;
        private int _clashTestCount;
        private string _clashDockCounts, _clashDockTestName, _clashStatusLabel, _clashLevelLabel;
        private string _clashCardDetail, _clashCardAssign, _clashCardNotes;

        // Dropdown slots on the dock (owner: the dock's list)
        private const int DROP_DOCK_TEST = 11, DROP_DOCK_STATUS = 12, DROP_DOCK_LEVEL = 13, DROP_DOCK_VIEW = 14;

        private static readonly KeyHint CLASH_HINT = new(() =>
            $"{Hotkeys.Label(InputAction.ClashPrevious)} {Hotkeys.Label(InputAction.ClashNext)} previous / next · {Hotkeys.Label(InputAction.ClashFrame)} re-frame · " +
            $"1–5 status · {Hotkeys.Label(InputAction.ClashView)} view · {Hotkeys.Label(InputAction.ClashSectionToggle)} box · " +
            $"{Hotkeys.Label(InputAction.ClashSelectAll)} all · " +
            $"{Hotkeys.Label(InputAction.ClashSelectInRevit)} Revit · RMB-drag looks · {Hotkeys.Label(InputAction.ClashMode)} / Esc leaves");

        #endregion

        #region List

        /// <summary>Shows a test in clash mode (filters kept, list rebuilt).</summary>
        private void SetClashReviewTest(string testId)
        {
            if (testId == _clashReviewTest) { return; }
            ClearClashSelection(); // C-B3: a selection belongs to one test
            _clashReviewTest = testId;
            _clashLevelFilter = null;
            _clashDockScroll = 0;
            _clashListDirty = true;
        }

        /// <summary>
        /// Rebuilds the filtered list and its rows when the data, the filters or the display units changed.
        /// </summary>
        private void RefreshClashList()
        {
            if (_clashDocument == null) { return; }
            if (_clashListUnits != UnitFormat.Revision) { _clashListDirty = true; }
            if (!_clashListDirty) { return; }
            _clashListDirty = false;
            _clashListUnits = UnitFormat.Revision;

            string search = _clashSearchLength == 0 ? null : new string(_clashSearch, 0, _clashSearchLength).Trim();
            string[] words = string.IsNullOrEmpty(search) ? Array.Empty<string>() : search.Split(' ', StringSplitOptions.RemoveEmptyEntries);

            _clashList.Clear();
            _clashDockRows.Clear();
            _clashLevels.Clear();
            var levels = new HashSet<string>(StringComparer.Ordinal);
            _clashTestCount = 0;
            foreach (ClashRecord clash in _clashDocument.Clashes)
            {
                if (clash.TestId != _clashReviewTest) { continue; }
                _clashTestCount++;
                string level = ClashLevel(clash);
                if (levels.Add(level)) { _clashLevels.Add(level); }

                if (!MatchesClashStatusFilter(clash.Status)) { continue; }
                if (_clashLevelFilter != null && level != _clashLevelFilter) { continue; }
                ClashRow row = MakeClashRow(clash);
                bool all = true;
                foreach (string word in words)
                {
                    if (!row.Search.Contains(word, StringComparison.CurrentCultureIgnoreCase)) { all = false; break; }
                }
                if (!all) { continue; }
                _clashDockRows.Add(row);
            }

            // Open first (new, active, reviewed, approved, resolved), deepest first
            _clashDockRows.Sort((p, q) =>
            {
                int byStatus = ClashStatus.IndexOf(p.Clash.Status).CompareTo(ClashStatus.IndexOf(q.Clash.Status));
                return byStatus != 0 ? byStatus : q.Clash.Distance.CompareTo(p.Clash.Distance);
            });
            foreach (ClashRow row in _clashDockRows) { _clashList.Add(row.Clash); }
            PruneClashSelection(); // C-B3: selected clashes the filters now hide drop out

            // Levels in elevation order, unknown ones last
            _clashLevels.Sort((a, b) => LevelOrder(a).CompareTo(LevelOrder(b)));

            ClashTest test = _clashDocument.FindTest(_clashReviewTest);
            _clashDockTestName = test == null ? "No test" : test.Name;
            _clashDockCounts = $"{_clashList.Count:N0} shown · {_clashTestCount:N0} in the test";
            _clashStatusLabel = "STATUS: " + CLASH_STATUS_FILTERS[_clashStatusFilter];
            _clashLevelLabel = "LEVEL: " + (_clashLevelFilter ?? "ALL");
            RefreshClashViewLabels();
            if (_clashCurrent != null) { _clashScrollToCurrent = true; }
            RefreshClashCard();
        }

        /// <summary>The current clash card's text (built when the clash or its details change, not per frame).</summary>
        private void RefreshClashCard()
        {
            ClashRecord clash = _clashCurrent;
            if (clash == null)
            {
                _clashCardDetail = _clashCardAssign = _clashCardNotes = null;
                return;
            }
            ClashRow row = MakeClashRow(clash);
            _clashCardDetail = row.Detail + (_clashCurrentRoom == null ? string.Empty : " · " + _clashCurrentRoom);
            _clashCardAssign = string.IsNullOrEmpty(clash.AssignedTo) ? "ASSIGN…" : "ASSIGNED: " + clash.AssignedTo;
            _clashCardNotes = string.IsNullOrEmpty(clash.Notes) ? "NOTES…" : "NOTES (EDIT)…";
        }

        private bool MatchesClashStatusFilter(string status) => _clashStatusFilter switch
        {
            0 => true,
            1 => status != ClashStatus.RESOLVED && status != ClashStatus.APPROVED,
            _ => status == ClashStatus.All[_clashStatusFilter - 2]
        };

        /// <summary>"crossing 32 mm", "crossing", "touching" or "gap 12 mm" (display units).</summary>
        private static string ClashAmount(ClashRecord clash) => clash.Crossing
            ? (clash.Distance > 0 ? $"crossing {UnitFormat.Length(clash.Distance, 3)}" : "crossing")
            : clash.Distance <= 0 ? "touching" : $"gap {UnitFormat.Length(clash.Distance, 3)}";

        private static string ClashLevel(ClashRecord clash) =>
            !string.IsNullOrWhiteSpace(clash.A.Level) && clash.A.Level != "—" ? clash.A.Level
            : !string.IsNullOrWhiteSpace(clash.B.Level) && clash.B.Level != "—" ? clash.B.Level : "—";

        private int LevelOrder(string name)
        {
            for (int i = 0; i < Scene.Levels.Length; i++)
            {
                if (Scene.Levels[i].Name == name) { return i; }
            }
            return int.MaxValue;
        }

        /// <summary>
        /// One clash's row text: the pair, crossing depth or gap, level, flags, assignee; status; and what search reads.
        /// </summary>
        private static ClashRow MakeClashRow(ClashRecord clash)
        {
            string amount = ClashAmount(clash);
            string level = ClashLevel(clash);
            string detail = $"{amount} · {level}{(clash.Approximate ? " · approximate (stand-in box)" : string.Empty)}" +
                (string.IsNullOrEmpty(clash.AssignedTo) ? string.Empty : $" · {clash.AssignedTo}") +
                (string.IsNullOrEmpty(clash.Notes) ? string.Empty : " · notes");
            string title = $"{clash.A.Label}  ×  {clash.B.Label}";
            return new ClashRow
            {
                Clash = clash,
                Title = title,
                Detail = detail,
                Status = ClashStatus.Label(clash.Status).ToUpperInvariant(),
                Search = $"{title} {detail} {clash.Notes} {clash.Status}"
            };
        }

        #endregion

        #region Search box

        /// <summary>
        /// Typing into the search box: Backspace deletes (Ctrl+Backspace clears), Enter or Esc stop typing.
        /// </summary>
        private void TypeIntoClashSearch(InputState input)
        {
            foreach (char c in input.Chars)
            {
                if (c == '\r' || c == (char)27)
                {
                    _clashSearchFocused = false;
                    input.ReleaseAll();
                    return;
                }
                if (c == '\b')
                {
                    if (input.IsDown(Win32.VK_CONTROL)) { _clashSearchLength = 0; }
                    else if (_clashSearchLength > 0) { _clashSearchLength--; }
                    _clashListDirty = true;
                    _clashDockScroll = 0;
                }
                else if (c >= ' ' && c != 127 && _clashSearchLength < CLASH_SEARCH_MAX)
                {
                    _clashSearch[_clashSearchLength++] = c;
                    _clashListDirty = true;
                    _clashDockScroll = 0;
                }
            }
        }

        #endregion

        #region Panel

        /// <summary>
        /// Clash mode's HUD: the status and coordinate panels on the left, the docked clash panel on the right, help,
        /// banners and toasts. No crosshair, gun bar or gun panel (the guns are off in clash mode).
        /// </summary>
        private void BuildClashHud(FontAtlas f, int width, int height)
        {
            BuildStatusPanel(f);
            BuildCoordinatePanel(f, S(20), S(20) + S(146) + S(10));
            BuildClashDock(f, _window.Input, width, height);
            BuildHelp(f, height);
            BuildRoomBanner(f, width);
            BuildLiveBanner(f, width, height);
            BuildToast(f, width);
        }

        /// <summary>
        /// The docked clash panel.
        /// </summary>
        private void BuildClashDock(FontAtlas f, InputState input, int width, int height)
        {
            RefreshClashList();
            BeginOverlays(input); // an open dropdown takes this frame's click and wheel
            float w = MathF.Min(S(420), width * 0.42f);
            float x = width - w - S(16), y = S(16), h = height - S(32);
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.PANEL_BORDER);
            bool overDock = Hover(input, x, y, w, h);

            float ix = x + S(14), iw = w - S(28);
            float cy = y + S(12);
            _ui.Text(f.Small, ix, cy, "CLASH MODE", UiTheme.ACCENT, S(2f));
            _ui.TextRight(f.Small, ix + iw, cy, _clashDockCounts ?? string.Empty, UiTheme.TEXT_MUTED);
            cy += S(22);

            // The test (dropdown: every test, with its clash count)
            if (DropdownButton(f, input, ix, cy, iw, S(30), _clashDockTestName ?? string.Empty, IsDropdownOpen(_clashList, DROP_DOCK_TEST)))
            {
                string[] ids = _clashDocument.Tests.Select(t => t.Id).ToArray();
                var labels = new List<string>(ids.Length);
                foreach (ClashTest test in _clashDocument.Tests)
                {
                    int count = ClashMerge.CountByStatus(_clashDocument, test.Id).Sum();
                    labels.Add(count == 0 ? $"{test.Name} (no clashes)" : $"{test.Name} ({count:N0})");
                }
                float tx = ix, ty = cy;
                OpenDropdown(_clashList, DROP_DOCK_TEST, tx, ty, iw, S(30), labels, Array.IndexOf(ids, _clashReviewTest), i => PickClashReviewTest(ids[i]));
            }
            cy += S(38);

            // Filters: status, level (dropdowns), search
            float third = (iw - S(12)) / 3f;
            if (DropdownButton(f, input, ix, cy, third, S(30), _clashStatusLabel ?? "STATUS", IsDropdownOpen(_clashList, DROP_DOCK_STATUS)))
            {
                OpenDropdown(_clashList, DROP_DOCK_STATUS, ix, cy, third, S(30), CLASH_STATUS_FILTERS, _clashStatusFilter, i =>
                {
                    _clashStatusFilter = i;
                    _clashListDirty = true;
                    _clashDockScroll = 0;
                });
            }
            float lx = ix + third + S(6);
            if (DropdownButton(f, input, lx, cy, third, S(30), _clashLevelLabel ?? "LEVEL", IsDropdownOpen(_clashList, DROP_DOCK_LEVEL)))
            {
                var levels = new List<string>(_clashLevels.Count + 1) { "ALL" };
                levels.AddRange(_clashLevels);
                string[] values = levels.ToArray();
                OpenDropdown(_clashList, DROP_DOCK_LEVEL, lx, cy, third, S(30), levels, _clashLevelFilter == null ? 0 : levels.IndexOf(_clashLevelFilter), i =>
                {
                    _clashLevelFilter = i == 0 ? null : values[i];
                    _clashListDirty = true;
                    _clashDockScroll = 0;
                });
            }
            float sx = ix + (third + S(6)) * 2f;
            bool searchHover = Hover(input, sx, cy, third, S(30));
            _ui.Panel(sx, cy, third, S(30), UiTheme.CONTROL, _clashSearchFocused ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
            if (_clashSearchLength == 0 && !_clashSearchFocused)
            {
                _ui.Text(f.Small, sx + S(8), cy + S(8), "search…", UiTheme.TEXT_FAINT);
            }
            else
            {
                float used = _ui.Text(f.Small, sx + S(8), cy + S(8), _clashSearch.AsSpan(0, _clashSearchLength), UiTheme.TEXT);
                if (_clashSearchFocused && ((int)(_clock * 2f) & 1) == 0) { _ui.Rect(sx + S(9) + used, cy + S(7), S(1.5f), S(16), UiTheme.TEXT_SOFT); }
            }
            if (input.LeftPressed && overDock)
            {
                bool focus = searchHover;
                if (focus != _clashSearchFocused)
                {
                    _clashSearchFocused = focus;
                    if (focus) { input.ReleaseAll(); }
                }
            }
            else if (input.LeftPressed && _clashSearchFocused) { _clashSearchFocused = false; }
            cy += S(38);

            // The view (dropdown), the section box toggle and the row pictures toggle (C-B2)
            float viewW = (iw - S(12)) * 0.42f, toggleW = (iw - S(12) - viewW) * 0.5f;
            if (DropdownButton(f, input, ix, cy, viewW, S(30), _clashViewLabel ?? "VIEW", IsDropdownOpen(_clashList, DROP_DOCK_VIEW)))
            {
                OpenDropdown(_clashList, DROP_DOCK_VIEW, ix, cy, viewW, S(30), CLASH_VIEW_NAMES, _clashView, SetClashView);
            }
            if (SmallButton(f, input, ix + viewW + S(6), cy, toggleW, S(30), _clashBoxLabel ?? "BOX")) { ToggleClashBox(); }
            if (SmallButton(f, input, ix + viewW + toggleW + S(12), cy, toggleW, S(30), _clashThumbLabel ?? "PICTURES")) { ToggleClashThumbnails(); }
            cy += S(38);

            // C-B4: select every clash the list shows (a focus on them all) / clear
            if (SmallButton(f, input, ix, cy, iw, S(28), ClashSelectAllLabel())) { ToggleSelectAllShownClashes(); }
            cy += S(36);

            // The current clash's card (bottom, tall enough for its key hint) and the list above it
            float cardH = ClashCardHeight(f, iw);
            float cardY = y + h - cardH;
            ClashRecord go = BuildClashDockRows(f, input, ix, cy, iw, cardY - S(10), overDock);
            BuildClashCard(f, input, ix, cardY, iw);

            // The open dropdown, on top (a pick acts here)
            DrawOverlays(f, input, x, y, w, h);

            // Actions after drawing
            if (_clashMarkupClick != null && _clashModeOn)
            {
                // C-B3: the pencil on a row: mark up that clash's comment picture (back to clash mode after)
                ClashRecord markup = _clashMarkupClick;
                _clashMarkupClick = null;
                OpenClashMarkup(markup);
                return;
            }
            if (go != null && _clashModeOn) { ClickClashRow(go, input.IsDown(Win32.VK_CONTROL), input.IsDown(Win32.VK_SHIFT)); }
            if (overDock && input.LeftPressed) { input.ConsumeClicks(); }
        }

        /// <summary>The test dropdown's pick: show that test's clashes and go to the first.</summary>
        private void PickClashReviewTest(string testId)
        {
            if (testId == _clashReviewTest) { return; }
            SetClashReviewTest(testId);
            RefreshClashList();
            if (_clashList.Count > 0) { GoToClash(_clashList[0], animate: !_clashInstant); }
            else { Toast(_clashDocument.Clashes.Any(c => c.TestId == testId) ? "No clash of this test matches the filters" : "This test has no clashes yet (TESTS… runs it)", 2.5f); }
        }

        /// <summary>
        /// The list rows (wheel scrolls while the mouse is over the panel; the current row stays in view after a step).
        /// </summary>
        /// <returns>The row clicked this frame, or null.</returns>
        private ClashRecord BuildClashDockRows(FontAtlas f, InputState input, float x, float y, float w, float bottom, bool overDock)
        {
            if (_clashDockRows.Count == 0)
            {
                string why = _clashTestCount == 0 ? "This test has no clashes yet: TESTS… runs it." : "No clash matches the filters.";
                _ui.TextWrapped(f.Body, x, y + S(6), w, why, UiTheme.TEXT_MUTED, maxLines: 3);
                return null;
            }

            // C-B2: with pictures on, each row is tall enough for a 160 × 90 picture (narrower docks shrink it)
            bool pictures = _clashThumbsOn;
            float thumbW = pictures ? MathF.Min(S(CLASH_THUMB_W), w * 0.42f) : 0f;
            float thumbH = thumbW * CLASH_THUMB_H / CLASH_THUMB_W;
            float rowH = pictures ? MathF.Max(S(50), thumbH + S(10)) : S(50);
            int visible = Math.Max(1, (int)((bottom - y) / rowH));
            int maxScroll = Math.Max(0, _clashDockRows.Count - visible);
            if (_clashScrollToCurrent)
            {
                _clashScrollToCurrent = false;
                int current = _clashCurrent == null ? -1 : _clashList.IndexOf(_clashCurrent);
                if (current >= 0 && (current < _clashDockScroll || current >= _clashDockScroll + visible)) { _clashDockScroll = current - visible / 2; }
            }
            if (overDock && input.Wheel != 0) { _clashDockScroll -= input.Wheel * 3; }
            _clashDockScroll = Math.Clamp(_clashDockScroll, 0, maxScroll);

            ClashRecord picked = null;
            int last = Math.Min(_clashDockRows.Count, _clashDockScroll + visible);
            for (int i = _clashDockScroll; i < last; i++)
            {
                ClashRow row = _clashDockRows[i];
                float ry = y + (i - _clashDockScroll) * rowH;
                bool current = row.Clash == _clashCurrent || IsClashSelected(row.Clash);
                bool hover = Hover(input, x, ry, w, rowH - S(4));
                _ui.Rect(x, ry, w, rowH - S(4), current ? Rgba.Hex(0x22D3EE, 0.14f) : hover ? Rgba.Hex(0xFFFFFF, 0.08f) : ((i & 1) == 0 ? Rgba.Hex(0xFFFFFF, 0.03f) : 0u));
                _ui.Rect(x, ry, S(4), rowH - S(4), StatusColour(row.Clash.Status));
                uint titleColour = row.Clash.Status == ClashStatus.RESOLVED ? UiTheme.TEXT_FAINT : UiTheme.TEXT;
                if (pictures)
                {
                    // The picture on the left (asked for when missing or stale), the text beside it
                    float px = x + S(10), py = ry + S(3);
                    uint texture = ClashThumbnailTexture(row.Clash);
                    if (texture != 0)
                    {
                        _ui.Image(texture, px, py, thumbW, thumbH, _window.Width, _window.Height);
                        _ui.Outline(px, py, thumbW, thumbH, MathF.Max(1f, UiScale), Rgba.Hex(0xFFFFFF, 0.15f));
                    }
                    else
                    {
                        _ui.Panel(px, py, thumbW, thumbH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
                        _ui.TextCentred(f.Small, px + thumbW * 0.5f, py + thumbH * 0.5f - S(7), "…", UiTheme.TEXT_FAINT);
                    }
                    if (ClashCommentPencil(f, input, px + thumbW - S(14), py + S(14), row.Clash)) { _clashMarkupClick = row.Clash; }
                    float tx = px + thumbW + S(10), tw = x + w - S(8) - tx;
                    _ui.Text(f.Small, tx, ry + S(5), row.Status, StatusColour(row.Clash.Status));
                    _ui.TextWrapped(f.Body, tx, ry + S(22), tw, row.Title, titleColour, maxLines: 2);
                    _ui.TextWrapped(f.Small, tx, ry + S(62), tw, row.Detail, UiTheme.TEXT_MUTED, maxLines: 2);
                }
                else
                {
                    _ui.TextWrapped(f.Body, x + S(12), ry + S(5), w - S(110), row.Title, titleColour, maxLines: 1);
                    _ui.TextWrapped(f.Small, x + S(12), ry + S(26), w - S(24), row.Detail, UiTheme.TEXT_MUTED, maxLines: 1);
                    _ui.TextRight(f.Small, x + w - S(8), ry + S(7), row.Status, StatusColour(row.Clash.Status));
                    if (ClashCommentPencil(f, input, x + w - S(20), ry + S(32), row.Clash)) { _clashMarkupClick = row.Clash; }
                }
                if (hover && input.LeftPressed)
                {
                    input.ConsumeClicks();
                    Sound.Play(SoundId.UiClick);
                    picked = row.Clash;
                }
            }
            if (maxScroll > 0)
            {
                Text.Clear().Append(_clashDockScroll + 1).Append('–').Append(last).Append(" of ").AppendGrouped(_clashDockRows.Count);
                _ui.TextRight(f.Small, x + w, bottom - S(2), Text.Span, UiTheme.TEXT_FAINT);
            }
            return picked;
        }

        /// <summary>
        /// The current clash: position in the list, the pair (red A, green B), depth or gap, level and room, status
        /// buttons 1–5, assignee and notes, then SELECT IN REVIT, TESTS…, FLY / INSTANT, EXIT and the key hint.
        /// </summary>
        private void BuildClashCard(FontAtlas f, InputState input, float x, float y, float w)
        {
            _ui.Rect(x, y - S(6), w, MathF.Max(1f, UiScale), UiTheme.PANEL_BORDER);
            float cy = y + S(4);
            ClashRecord clash = _clashCurrent;
            if (_clashBatch != null)
            {
                // TO COMMENTS in progress (C-B2): its progress and CANCEL in place of the details
                BuildClashBatchProgress(f, input, x, cy, w);
            }
            else if (clash == null)
            {
                _ui.Text(f.Body, x, cy, "Pick a clash in the list.", UiTheme.TEXT_MUTED);
            }
            else
            {
                int index = _clashList.IndexOf(clash);
                Text.Clear();
                if (ClashMultiActive) { Text.Append(_clashSelected.Count).Append(" SELECTED · "); } // C-B3
                Text.Append(index >= 0 ? "CLASH " : "CLASH (FILTERED OUT) ");
                if (index >= 0) { Text.Append(index + 1).Append(" OF ").AppendGrouped(_clashList.Count); }
                _ui.Text(f.Small, x, cy, Text.Span, UiTheme.TEXT_MUTED, S(1.2f));
                cy += S(20);

                _ui.Rect(x, cy + S(4), S(10), S(10), Rgba.Hex(0xEF4444));
                _ui.TextWrapped(f.Body, x + S(18), cy, w - S(18), clash.A.Label, UiTheme.TEXT, maxLines: 1);
                cy += S(20);
                _ui.Rect(x, cy + S(4), S(10), S(10), Rgba.Hex(0x22C55E));
                _ui.TextWrapped(f.Body, x + S(18), cy, w - S(18), clash.B.Label, UiTheme.TEXT, maxLines: 1);
                cy += S(22);

                _ui.TextWrapped(f.Small, x, cy, w, _clashCardDetail ?? string.Empty, UiTheme.TEXT_MUTED, maxLines: 2);
                cy += S(34);

                // Status 1–5
                float chip = (w - S(4) * 4) / 5f;
                for (int k = 0; k < ClashStatus.All.Length; k++)
                {
                    string status = ClashStatus.All[k];
                    float bx = x + k * (chip + S(4));
                    bool on = clash.Status == status;
                    bool hover = Hover(input, bx, cy, chip, S(28));
                    _ui.Rect(bx, cy, chip, S(28), on ? StatusColour(status) : hover ? Rgba.Hex(0xFFFFFF, 0.1f) : UiTheme.CONTROL);
                    _ui.Outline(bx, cy, chip, S(28), MathF.Max(1f, UiScale), on ? StatusColour(status) : UiTheme.CONTROL_BORDER);
                    _ui.TextCentred(f.Small, bx + chip * 0.5f, cy + S(7), CLASH_STATUS_SHORT[k], on ? Rgba.Hex(0x111827) : UiTheme.TEXT);
                    if (hover && input.LeftPressed && !on)
                    {
                        input.ConsumeClicks();
                        SetCurrentClashStatus(status);
                    }
                }
                cy += S(34);

                float half = (w - S(6)) * 0.5f;
                if (SmallButton(f, input, x, cy, half, S(28), _clashCardAssign ?? "ASSIGN…")) { BeginClashAssign(clash); }
                if (SmallButton(f, input, x + half + S(6), cy, half, S(28), _clashCardNotes ?? "NOTES…")) { BeginClashNotes(clash); }
                cy += S(34);
            }

            // Comments (C-B3): the selected clashes (or this one) → comments; MARKUP this clash's comment picture
            if (_clashBatch == null)
            {
                float halfW = (w - S(6)) * 0.5f, ty = y + ClashCardButtonsY - S(34);
                string make = ClashMultiActive ? ClashCommentsLabel()
                    : clash != null && FindClashComment(clash) != null ? "UPDATE COMMENT" : "TO COMMENT";
                if (SmallButton(f, input, x, ty, halfW, S(28), make)) { ClashToComment(); }
                if (SmallButton(f, input, x + halfW + S(6), ty, halfW, S(28), "MARKUP")) { OpenClashMarkup(clash); }
            }

            // Bottom buttons
            float quarter = (w - S(18)) / 4f;
            float by = y + ClashCardButtonsY;
            if (SmallButton(f, input, x, by, quarter, S(28), "REVIT")) { ShowClashInRevit(); }
            if (SmallButton(f, input, x + (quarter + S(6)), by, quarter, S(28), "TESTS…"))
            {
                if (_clashBatch != null) { FinishClashBatch(cancelled: true); } // runs and resets wait for the comments
                OpenClashes();
                return;
            }
            if (SmallButton(f, input, x + (quarter + S(6)) * 2f, by, quarter, S(28), _clashInstant ? "INSTANT" : "FLY"))
            {
                _clashInstant = !_clashInstant;
                Toast(_clashInstant ? "Clash mode jumps straight to each clash" : "Clash mode flies to each clash", 2f);
            }
            if (SmallButton(f, input, x + (quarter + S(6)) * 3f, by, quarter, S(28), "EXIT"))
            {
                ExitClashMode();
                return;
            }
            _ui.TextWrapped(f.Small, x, by + S(34), w, CLASH_HINT.Text, UiTheme.TEXT_FAINT, maxLines: 3);
        }

        /// <summary>Where the card's bottom buttons sit below its top (the comment buttons are one row above, C-B2).</summary>
        private float ClashCardButtonsY => S(210);

        /// <summary>
        /// The card's height: the details and buttons, then the key hint wrapped to the panel (measured, so the last
        /// line never runs off the bottom of the dock).
        /// </summary>
        private float ClashCardHeight(FontAtlas f, float width) =>
            ClashCardButtonsY + S(34) + _ui.TextWrapped(f.Small, 0f, 0f, width, CLASH_HINT.Text, UiTheme.TEXT_FAINT, maxLines: 3, draw: false) + S(10);

        private static readonly string[] CLASH_STATUS_SHORT = { "1 NEW", "2 ACTIVE", "3 REVIEW", "4 APPROVE", "5 RESOLVE" };

        /// <summary>ASSIGN…: the clash's assignee (empty = unassigned).</summary>
        private void BeginClashAssign(ClashRecord clash)
        {
            BeginTextEdit("ASSIGN CLASH TO (empty = unassigned)", clash.AssignedTo, 60, text =>
            {
                ClashMerge.SetDetails(clash, text, null, Environment.UserName, DateTime.UtcNow);
                ClashesChanged();
                CommentRecord comment = FindClashComment(clash); // C-B2: its comment follows (an empty text clears)
                if (comment != null) { Comments.SetIssue(comment, assignedTo: text); }
                _clashListDirty = true;
                _clashRowsDirty = true;
                Toast(text.Length == 0 ? "Unassigned" : $"Assigned to {text}", 2f);
            }, clash.A.Level);
        }

        /// <summary>NOTES…: the clash's notes (empty clears them).</summary>
        private void BeginClashNotes(ClashRecord clash)
        {
            BeginTextEdit("CLASH NOTES (empty clears)", clash.Notes, 280, text =>
            {
                ClashMerge.SetDetails(clash, null, text, Environment.UserName, DateTime.UtcNow);
                ClashesChanged();
                _clashListDirty = true;
                _clashRowsDirty = true;
                Toast(text.Length == 0 ? "Notes cleared" : "Notes saved", 2f);
            }, clash.A.Level);
        }

        #endregion
    }
}
