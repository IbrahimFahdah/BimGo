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
        private bool _clashScrollToCurrent;
        private int _clashTestCount;
        private string _clashDockCounts, _clashDockTestName, _clashStatusLabel, _clashLevelLabel;
        private string _clashCardDetail, _clashCardAssign, _clashCardNotes;

        // Dropdown slots on the dock (owner: the dock's list)
        private const int DROP_DOCK_TEST = 11, DROP_DOCK_STATUS = 12, DROP_DOCK_LEVEL = 13, DROP_DOCK_VIEW = 14, DROP_DOCK_REPORT = 15;

        /// <summary>QOL round: the clash report's choices (moved here from the Clashes panel).</summary>
        /// <summary>REPORT… (C-C3: the HTML / XML report's card first; the BimGo JSON exchange as before).</summary>
        private static readonly string[] CLASH_REPORT_ACTIONS = { "EXPORT REPORT (HTML / XML)…", "EXPORT BIMGO REPORT (JSON)…", "IMPORT BIMGO REPORT (JSON)…" };

        // A REPORT… pick or the report card's EXPORT…, run after the dock is drawn (they open file dialogs): 0 none,
        // 1 the report card, 2 export JSON, 3 import JSON, 4 the card's EXPORT…, 5 the same after its large-report confirm
        private int _clashReportAction;

        private static readonly KeyHint CLASH_HINT = new(() =>
            $"{Hotkeys.Label(InputAction.ClashPrevious)} {Hotkeys.Label(InputAction.ClashNext)} previous / next · {Hotkeys.Label(InputAction.ClashFrame)} re-frame · " +
            $"1–5 status · {Hotkeys.Label(InputAction.ClashView)} view · {Hotkeys.Label(InputAction.ClashSectionToggle)} box · " +
            $"{Hotkeys.Label(InputAction.ClashSelectAll)} all · {Hotkeys.Label(InputAction.ClashGroup)} group · right-click rows · " +
            $"{Hotkeys.Label(InputAction.ClashSelectInRevit)} Revit · RMB-drag looks · {Hotkeys.Label(InputAction.ClashMode)} / Esc leaves");

        #endregion

        #region List

        /// <summary>Shows a test in clash mode (filters kept, list rebuilt).</summary>
        private void SetClashReviewTest(string testId)
        {
            if (testId == _clashReviewTest) { return; }
            LeaveClashTool(); // C-C2: a tool works on one test's list
            ClearClashSelection(); // C-B3: a selection belongs to one test
            _clashReviewTest = testId;
            _clashLevelFilter = null;
            _clashListScroll.Reset();
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
            EnsureClashGroupIndex(); // C-C1: rows know their group (search matches group names too)

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
                string groupName = words.Length == 0 ? null : ClashGroupSearchText(clash);
                foreach (string word in words)
                {
                    if (!row.Search.Contains(word, StringComparison.CurrentCultureIgnoreCase)
                        && !groupName.Contains(word, StringComparison.CurrentCultureIgnoreCase)) { all = false; break; }
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
            BuildClashDisplay(); // C-C1: group rows among the clashes; _clashList in display order (every member)
            PruneClashSelection(); // C-B3: selected clashes the filters now hide drop out

            // Levels in elevation order, unknown ones last
            _clashLevels.Sort((a, b) => LevelOrder(a).CompareTo(LevelOrder(b)));

            ClashTest test = _clashDocument.FindTest(_clashReviewTest);
            _clashDockTestName = test == null ? "No test" : test.Name;
            _clashDockCounts = $"{_clashList.Count:N0} shown · {_clashTestCount:N0} in the test" +
                (_clashGroupsInTest > 0 ? $" · {_clashGroupsInTest:N0} group{(_clashGroupsInTest == 1 ? string.Empty : "s")}" : string.Empty);
            _clashStatusLabel = "STATUS: " + CLASH_STATUS_FILTERS[_clashStatusFilter];
            _clashLevelLabel = "LEVEL: " + (_clashLevelFilter ?? "ALL");
            RefreshClashViewLabels();
            if (_clashCurrent != null) { _clashScrollToCurrent = true; }
            RefreshClashCard();
        }

        /// <summary>The current clash card's text (built when the clash or its details change, not per frame).</summary>
        private void RefreshClashCard()
        {
            RefreshClashGroupCard(); // C-C1
            ClashRecord clash = _clashCurrent;
            if (clash == null)
            {
                _clashCardDetail = _clashCardAssign = _clashCardNotes = null;
                return;
            }
            ClashRow row = MakeClashRow(clash);
            _clashCardDetail = row.Detail + (_clashCurrentRoom == null ? string.Empty : " · " + _clashCurrentRoom) + ClashGridSuffix(clash, offset: true); // grids round B
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

        private static string ClashLevel(ClashRecord clash) => ClashGrouping.LevelOf(clash); // C-C2: one rule, in Core

        private int LevelOrder(string name)
        {
            for (int i = 0; i < Scene.Levels.Length; i++)
            {
                if (Scene.Levels[i].Name == name) { return i; }
            }
            return int.MaxValue;
        }

        /// <summary>
        /// One clash's row text: the pair, crossing depth or gap, level, (polish round P-C) the nearest grid intersection,
        /// flags, assignee; status; and what search reads (so "C-4" finds the clashes there).
        /// </summary>
        private ClashRow MakeClashRow(ClashRecord clash)
        {
            string amount = ClashAmount(clash);
            string level = ClashLevel(clash);
            string grid = ClashGridLocation(clash) is GridLocation location && !string.IsNullOrEmpty(location.Node) ? " · " + location.Node : string.Empty;
            string detail = $"{amount} · {level}{grid}{(clash.Approximate ? " · approximate (stand-in box)" : string.Empty)}" +
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
                    _clashListScroll.Reset();
                }
                else if (c >= ' ' && c != 127 && _clashSearchLength < CLASH_SEARCH_MAX)
                {
                    _clashSearch[_clashSearchLength++] = c;
                    _clashListDirty = true;
                    _clashListScroll.Reset();
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
            DrawGridLabels(f); // grids round A: bubbles and tags under the dock
            BuildClashDock(f, _window.Input, width, height);
            DrawGridHoverLabel(f); // grids round B
            BuildGridsPanel(f, _window.Input);
            // P-A2: the left column: status, coordinates, the colour legend (real model view) and the F1 sheet
            BuildInfoColumn(f, height, sunLegend: false, profileLegend: true, help: true);
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

            // C-C2: GROUP BY BOX… folds the dock away (its bar only); PICK POINTS and CLUSTER keep it beside their bar
            if (_clashTool == CLASH_TOOL_BOX)
            {
                _clashDockW = 0f;
                BuildClashToolBar(f, input, width, height, width);
                DrawOverlays(f, input, 0f, 0f, width, height);
                RunClashToolBarAction();
                return;
            }
            if (_clashTool != CLASH_TOOL_NONE) { BuildClashToolBar(f, input, width, height, width - w - S(16)); }
            float x = width - w - S(16), y = S(16), h = height - S(32);
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.PANEL_BORDER);
            bool overDock = Hover(input, x, y, w, h, focus: false);
            RegisterFocusArea(x, y, w, h); // P-A2: the D-pad navigates the dock while the cursor is over it
            (_clashDockX, _clashDockY, _clashDockW, _clashDockH) = (x, y, w, h);
            if (overDock && input.RightPressed) { _clashMenuLook = true; } // C-C1: a right-click on the dock is a menu, not a look

            // P-A2: the docks' header (title, the counts on the right, a divider)
            float ix = x + S(14), iw = w - S(28);
            float header = S(UiTheme.DOCK_HEADER_HEIGHT);
            float titleY = y + MathF.Round((header - f.Small.LineHeight) * 0.5f);
            _ui.Text(f.Small, ix, titleY, "CLASH MODE", UiTheme.ACCENT, S(1.6f));
            _ui.TextRight(f.Small, ix + iw, titleY, _clashDockCounts ?? string.Empty, UiTheme.TEXT_MUTED);
            _ui.Rect(x + S(1), y + header, w - S(2), MathF.Max(1f, UiScale), UiTheme.DIVIDER);
            float cy = y + header + S(UiTheme.GAP_SMALL);

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

            // Filters: status, level, show (C-C2: SHOW joins them; search moved down beside SELECT ALL)
            float third = (iw - S(12)) / 3f;
            if (DropdownButton(f, input, ix, cy, third, S(30), _clashStatusLabel ?? "STATUS", IsDropdownOpen(_clashList, DROP_DOCK_STATUS)))
            {
                OpenDropdown(_clashList, DROP_DOCK_STATUS, ix, cy, third, S(30), CLASH_STATUS_FILTERS, _clashStatusFilter, i =>
                {
                    _clashStatusFilter = i;
                    _clashListDirty = true;
                    _clashListScroll.Reset();
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
                    _clashListScroll.Reset();
                });
            }
            float showX = ix + (third + S(6)) * 2f;
            if (DropdownButton(f, input, showX, cy, third, S(30), CLASH_SHOW_LABELS[_clashGroupFilter], IsDropdownOpen(_clashList, DROP_DOCK_SHOW)))
            {
                OpenDropdown(_clashList, DROP_DOCK_SHOW, showX, cy, third, S(30), CLASH_SHOW_CHOICES, _clashGroupFilter, SetClashGroupFilter);
            }
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

            // Search · C-B4: select every clash the list shows / clear · QOL round: the clash report (C-C2: one row)
            float reportW = MathF.Min(S(100), iw * 0.24f), selectW = MathF.Min(S(140), iw * 0.32f);
            float searchW = iw - reportW - selectW - S(12);
            float sx = ix;
            bool searchHover = Hover(input, sx, cy, searchW, S(28));
            _ui.Panel(sx, cy, searchW, S(28), UiTheme.CONTROL, _clashSearchFocused ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
            if (_clashSearchLength == 0 && !_clashSearchFocused)
            {
                _ui.Text(f.Small, sx + S(8), cy + S(7), "search…", UiTheme.TEXT_FAINT);
            }
            else
            {
                float used = _ui.Text(f.Small, sx + S(8), cy + S(7), _clashSearch.AsSpan(0, _clashSearchLength), UiTheme.TEXT);
                if (_clashSearchFocused && ((int)(_clock * 2f) & 1) == 0) { _ui.Rect(sx + S(9) + used, cy + S(6), S(1.5f), S(16), UiTheme.TEXT_SOFT); }
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
            float selectX = sx + searchW + S(6);
            if (SmallButton(f, input, selectX, cy, selectW, S(28), ClashSelectAllLabel())) { ToggleSelectAllShownClashes(); }
            float reportX = selectX + selectW + S(6);
            if (DropdownButton(f, input, reportX, cy, reportW, S(28), "REPORT…", IsDropdownOpen(_clashList, DROP_DOCK_REPORT)))
            {
                float menuW = MathF.Max(reportW, S(260));
                OpenDropdown(_clashList, DROP_DOCK_REPORT, reportX + reportW - menuW, cy, menuW, S(28), CLASH_REPORT_ACTIONS, -1, i => _clashReportAction = i + 1);
            }
            cy += S(36);

            // C-C1 / C-C2: GROUP and UNGROUP act on the selection or the group on the card; TOOLS ▾ holds the grouping
            // tools (box, pick points, cluster) and the automatic methods
            float toolsW = MathF.Min(S(150), iw * 0.36f), groupW = (iw - toolsW - S(12)) * 0.5f;
            if (SmallButton(f, input, ix, cy, groupW, S(28), _clashGroupButtonLabel ?? "GROUP")) { GroupClashes(ClashTargets(), null); }
            if (SmallButton(f, input, ix + groupW + S(6), cy, groupW, S(28), _clashUngroupButtonLabel ?? "UNGROUP")) { UngroupFromKeys(); }
            float toolsX = ix + groupW * 2f + S(12);
            if (DropdownButton(f, input, toolsX, cy, toolsW, S(28), "TOOLS", IsDropdownOpen(_clashList, DROP_DOCK_AUTO)))
            {
                float menuW = MathF.Min(S(300), iw);
                OpenDropdown(_clashList, DROP_DOCK_AUTO, ix + iw - menuW, cy, menuW, S(28), CLASH_TOOL_ACTIONS, -1, RunClashToolAction);
            }
            cy += S(36);

            // The current clash's card (bottom, tall enough for its key hint) and the list above it
            float cardH = ClashCardHeight(f, iw);
            float cardY = y + h - cardH;
            ClashRecord go = BuildClashDockRows(f, input, ix, cy, iw, cardY - S(10));
            BuildClashCard(f, input, ix, cardY, iw);

            // C-C3: the label of the dot under the mouse (in the view), then the open dropdown on top (a pick acts here)
            if (_clashTool == CLASH_TOOL_NONE) { DrawClashHoverLabel(f, input, width); }
            DrawOverlays(f, input, x, y, w, h);
            if (RunClashToolBarAction()) { return; } // C-C2: the tool bar's buttons (they may leave the tool or open a menu)

            // Actions after drawing
            if (_clashReportAction != 0)
            {
                int action = _clashReportAction;
                _clashReportAction = 0;
                switch (action)
                {
                    case 1: OpenClashReportCard(); break; // C-C3
                    case 2: ExportClashReport(); return;
                    case 3: ImportClashReport(); return;
                    case 4: StartClashReport(); return;
                    case 5: StartClashReport(confirmed: true); return;
                }
            }
            if (_clashMarkupClick != null && _clashModeOn)
            {
                // C-B3: the pencil on a row: mark up that clash's comment picture (back to clash mode after)
                ClashRecord markup = _clashMarkupClick;
                _clashMarkupClick = null;
                OpenClashMarkup(markup);
                return;
            }
            if (go != null && _clashModeOn)
            {
                // C-C2: while picking points a row click toggles its pick; with the cluster sphere it moves the centre
                if (_clashTool == CLASH_TOOL_PICK) { ToggleClashPick(go); }
                else if (_clashTool == CLASH_TOOL_SPHERE) { MoveClashSphere(go); }
                else { ClickClashRow(go, input.IsDown(Win32.VK_CONTROL), input.IsDown(Win32.VK_SHIFT)); }
            }

            if (_clashGroupMarkupClick != null && _clashModeOn)
            {
                // Feedback: the pencil on a group row: mark up the group comment's picture
                ClashGroup markupGroup = _clashGroupMarkupClick;
                _clashGroupMarkupClick = null;
                OpenClashGroupMarkup(markupGroup);
                return;
            }

            // C-C1: a chevron, a group row, a right-click (the menu opens now, drawn from the next frame)
            ClashGroup chevron = _clashGroupChevron, groupClick = _clashGroupClick;
            ClashDisplayRow menuRow = _clashMenuRow;
            _clashGroupChevron = _clashGroupClick = null;
            _clashMenuRow = null;
            if (_clashModeOn)
            {
                if (chevron != null) { ToggleClashGroupExpanded(chevron); }
                else if (groupClick != null && _clashTool == CLASH_TOOL_PICK) { ToggleClashPicks(ShownClashGroupMembers(groupClick)); } // C-C2
                else if (groupClick != null && _clashTool == CLASH_TOOL_NONE) { ClickClashGroupRow(groupClick, input.IsDown(Win32.VK_CONTROL)); }
                if (menuRow != null) { OpenClashRowMenu(menuRow, _clashMenuAt); }
            }
            if (overDock && (input.LeftPressed || input.RightPressed)) { input.ConsumeClicks(); }
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
        /// The list rows (polish round P-A2: a clipped, pixel-scrolled <see cref="ScrollRegion"/>: the wheel over the
        /// list, the thumb, the track; a step to another clash brings its row into view, centred). C-C1: group rows
        /// (chevron, name, count, status, MIXED; a click selects the members, the chevron expands) with their members
        /// indented when expanded; a right-click on any row opens its menu (after the dock is drawn).
        /// </summary>
        /// <returns>The clash row clicked this frame, or null.</returns>
        private ClashRecord BuildClashDockRows(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            if (_clashDisplay.Count == 0)
            {
                string why = _clashTestCount == 0 ? "This test has no clashes yet: TESTS… runs it." : "No clash matches the filters.";
                _ui.TextWrapped(f.Body, x, y + S(6), w, why, UiTheme.TEXT_MUTED, maxLines: 3);
                return null;
            }

            // C-B2: with pictures on, each row is tall enough for a 160 × 90 picture (narrower docks shrink it)
            bool pictures = _clashThumbsOn;
            ScrollRegion region = _clashListScroll;
            float viewH = MathF.Max(S(40), bottom - y - S(16)); // the "1–20 of 140" line sits under it
            float listW = w - S(UiTheme.SCROLL_GUTTER) + S(8); // the bar sits in the dock's padding
            float thumbW = pictures ? MathF.Min(S(CLASH_THUMB_W), listW * 0.42f) : 0f;
            float thumbH = thumbW * CLASH_THUMB_H / CLASH_THUMB_W;
            float rowH = pictures ? MathF.Max(S(50), thumbH + S(10)) : S(50);
            int count = _clashDisplay.Count;
            if (_clashScrollToCurrent)
            {
                _clashScrollToCurrent = false;
                int current = ClashDisplayIndexOf(_clashCurrent);
                float rowTop = current * rowH;
                if (current >= 0 && (rowTop < region.Target || rowTop + rowH > region.Target + viewH))
                {
                    region.Target = MathF.Max(0f, rowTop - (viewH - rowH) * 0.5f);
                }
            }

            float top = BeginScroll(region, input, x, y, w + S(8), viewH, out _);
            VisibleRows(region, rowH, count, out int first, out int last);
            ClashRecord picked = null;
            for (int i = first; i < last; i++)
            {
                ClashDisplayRow line = _clashDisplay[i];
                float ry = top + i * rowH;
                bool hover = Hover(input, x, ry, listW, rowH - S(4));
                if (line.Row == null)
                {
                    BuildClashGroupRow(f, input, line, x, ry, listW, rowH, pictures, thumbW, thumbH, hover);
                }
                else
                {
                    // Members sit indented under their group (a faint rule down the left)
                    float indent = line.Member ? S(14) : 0f;
                    if (line.Member) { _ui.Rect(x + S(5), ry, S(2), rowH, Rgba.Hex(0xFFFFFF, 0.12f)); }
                    BuildClashRowBody(f, input, line.Row, x + indent, ry, listW - indent, rowH, pictures, thumbW, thumbH, hover, (i & 1) == 0);
                    if (hover && input.LeftPressed)
                    {
                        input.ConsumeClicks();
                        Sound.Play(SoundId.UiClick);
                        picked = line.Row.Clash;
                    }
                }
                if (hover && input.RightPressed)
                {
                    _clashMenuRow = line;
                    _clashMenuAt = input.MousePosition;
                }
            }
            EndScroll(region, input, top + count * rowH);

            if (region.MaxScroll > 0f)
            {
                int from = Math.Clamp((int)(region.Offset / rowH) + 1, 1, count);
                int to = Math.Clamp((int)((region.Offset + viewH) / rowH), from, count);
                Text.Clear().Append(from).Append('–').Append(to).Append(" of ").AppendGrouped(count);
                _ui.TextRight(f.Small, x + w, y + viewH + S(2), Text.Span, UiTheme.TEXT_FAINT);
            }
            return picked;
        }

        /// <summary>The display row showing a clash: its own row, or its group's row when the group is collapsed (−1: none).</summary>
        private int ClashDisplayIndexOf(ClashRecord clash)
        {
            if (clash == null) { return -1; }
            int groupRow = -1;
            ClashGroup group = ClashGroupOf(clash);
            for (int i = 0; i < _clashDisplay.Count; i++)
            {
                ClashDisplayRow line = _clashDisplay[i];
                if (line.Row != null && line.Row.Clash == clash) { return i; }
                if (line.Row == null && group != null && line.Group == group) { groupRow = i; }
            }
            return groupRow;
        }

        /// <summary>One clash row (as before C-C1): status bar, picture or text layout, status, the comment pencil.</summary>
        private void BuildClashRowBody(FontAtlas f, InputState input, ClashRow row, float x, float ry, float w, float rowH, bool pictures,
            float thumbW, float thumbH, bool hover, bool even)
        {
            bool current = row.Clash == _clashCurrent || IsClashSelected(row.Clash);
            _ui.Rect(x, ry, w, rowH - S(4), current ? Rgba.Hex(0x22D3EE, 0.14f) : hover ? Rgba.Hex(0xFFFFFF, 0.08f) : (even ? Rgba.Hex(0xFFFFFF, 0.03f) : 0u));
            _ui.Rect(x, ry, S(4), rowH - S(4), StatusColour(row.Clash.Status));
            uint titleColour = row.Clash.Status == ClashStatus.RESOLVED ? UiTheme.TEXT_FAINT : UiTheme.TEXT;
            if (pictures)
            {
                // The picture on the left (asked for when missing or stale), the text beside it
                float px = x + S(10), py = ry + S(3);
                DrawClashRowPicture(f, row.Clash, px, py, thumbW, thumbH);
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
        }

        /// <summary>A row picture (asked for when missing or stale) or its placeholder.</summary>
        private void DrawClashRowPicture(FontAtlas f, ClashRecord clash, float px, float py, float thumbW, float thumbH)
        {
            uint texture = clash == null ? 0u : ClashThumbnailTexture(clash);
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
        }

        /// <summary>
        /// A group row (C-C1): a chevron (expand / collapse), the first shown member's picture stacked (pictures on), the
        /// group's status and MIXED, its name and "n clashes · counts · assignee". Picked when it is the card's group or
        /// all its shown members are selected.
        /// </summary>
        private void BuildClashGroupRow(FontAtlas f, InputState input, ClashDisplayRow line, float x, float ry, float w, float rowH, bool pictures,
            float thumbW, float thumbH, bool hover)
        {
            ClashGroup group = line.Group;
            bool current = group == _clashGroupCurrent || (_clashGroupPicks.Contains(group) && ClashMultiActive);
            float h = rowH - S(4);
            _ui.Rect(x, ry, w, h, current ? Rgba.Hex(0x22D3EE, 0.18f) : hover ? Rgba.Hex(0xFFFFFF, 0.1f) : Rgba.Hex(0xFFFFFF, 0.06f));
            _ui.Rect(x, ry, S(4), h, StatusColour(group.Status));
            _ui.Outline(x, ry, w, h, MathF.Max(1f, UiScale), current ? UiTheme.ACCENT : Rgba.Hex(0xFFFFFF, 0.14f));

            // The chevron: right when collapsed, down when expanded
            bool expanded = _clashGroupExpanded.Contains(group.Id);
            float cw = S(26), ccx = x + S(4) + cw * 0.5f, ccy = ry + h * 0.5f, r = S(5);
            bool chevronHover = Hover(input, x + S(4), ry, cw, h);
            uint chevronColour = chevronHover ? UiTheme.ACCENT : UiTheme.TEXT_SOFT;
            if (expanded) { _ui.Triangle(ccx - r, ccy - r * 0.5f, ccx + r, ccy - r * 0.5f, ccx, ccy + r * 0.6f, chevronColour); }
            else { _ui.Triangle(ccx - r * 0.5f, ccy - r, ccx - r * 0.5f, ccy + r, ccx + r * 0.6f, ccy, chevronColour); }

            float tx = x + S(4) + cw;
            if (pictures)
            {
                // Two offset frames behind the first member's picture read as "several"
                float px = tx, py = ry + S(3);
                float pw = thumbW - S(8), ph = thumbH - S(6);
                _ui.Outline(px + S(8), py, pw, ph, MathF.Max(1f, UiScale), Rgba.Hex(0xFFFFFF, 0.2f));
                _ui.Outline(px + S(4), py + S(3), pw, ph, MathF.Max(1f, UiScale), Rgba.Hex(0xFFFFFF, 0.3f));
                DrawClashRowPicture(f, line.First, px, py + S(6), pw, ph);
                if (CommentPencil(input, px + pw - S(14), py + S(6) + S(14), FindClashGroupComment(group))) { _clashGroupMarkupClick = group; }
                tx = px + thumbW + S(6);
            }
            float tw = x + w - S(8) - tx;
            float after = tx + _ui.Text(f.Small, tx, ry + S(5), line.Status, StatusColour(group.Status)) + S(8);
            if (line.Mixed) { after += _ui.Text(f.Small, after, ry + S(5), "MIXED", Rgba.Hex(0xF59E0B)) + S(8); }
            float tagW = _ui.TextRight(f.Small, x + w - S(8), ry + S(5), "GROUP", UiTheme.TEXT_FAINT);
            if (pictures)
            {
                _ui.TextWrapped(f.Body, tx, ry + S(22), tw, line.Title, UiTheme.TEXT, maxLines: 2);
                _ui.TextWrapped(f.Small, tx, ry + S(62), tw, line.Detail, UiTheme.TEXT_MUTED, maxLines: 2);
            }
            else
            {
                // Text rows: status, MIXED and the counts on the first line, the name under them
                float detailW = x + w - S(16) - tagW - after;
                if (detailW > S(40)) { _ui.TextWrapped(f.Small, after, ry + S(5), detailW, line.Detail, UiTheme.TEXT_MUTED, maxLines: 1); }
                bool pencil = CommentPencil(input, x + w - S(20), ry + S(32), FindClashGroupComment(group));
                if (pencil) { _clashGroupMarkupClick = group; }
                _ui.TextWrapped(f.Body, tx, ry + S(23), tw - (FindClashGroupComment(group) != null ? S(30) : 0f), line.Title, UiTheme.TEXT, maxLines: 1);
            }

            if (hover && input.LeftPressed)
            {
                input.ConsumeClicks();
                if (chevronHover) { _clashGroupChevron = group; }
                else { _clashGroupClick = group; }
            }
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
            else if (_clashReportJob != null)
            {
                BuildClashReportProgress(f, input, x, cy, w); // C-C3: the report's pictures
            }
            else if (_clashReportCardOpen)
            {
                BuildClashReportCard(f, input, x, cy, w); // C-C3: REPORT… → EXPORT REPORT (HTML / XML)…
            }
            else if (_clashGroupCurrent != null)
            {
                BuildClashGroupCard(f, input, x, cy, w); // C-C1: a group row was clicked
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
            if (_clashBatch == null && _clashReportJob == null && !_clashReportCardOpen)
            {
                float halfW = (w - S(6)) * 0.5f, ty = y + ClashCardButtonsY - S(34);
                ClashGroup group = _clashGroupCurrent;
                if (group != null)
                {
                    // C-C1: one comment for the whole group
                    string makeGroup = FindClashGroupComment(group) != null ? "UPDATE GROUP COMMENT" : "GROUP TO COMMENT";
                    if (SmallButton(f, input, x, ty, halfW, S(28), makeGroup)) { ClashGroupToComment(group); }
                    if (SmallButton(f, input, x + halfW + S(6), ty, halfW, S(28), "MARKUP")) { OpenClashGroupMarkup(group); }
                }
                else
                {
                    string make = ClashMultiActive ? ClashCommentsLabel()
                        : clash != null && FindClashComment(clash) != null ? "UPDATE COMMENT" : "TO COMMENT";
                    if (SmallButton(f, input, x, ty, halfW, S(28), make)) { ClashToComment(); }
                    if (SmallButton(f, input, x + halfW + S(6), ty, halfW, S(28), "MARKUP")) { OpenClashMarkup(clash); }
                }
            }

            // Bottom buttons
            float quarter = (w - S(18)) / 4f;
            float by = y + ClashCardButtonsY;
            if (SmallButton(f, input, x, by, quarter, S(28), "REVIT")) { ShowClashInRevit(); }
            if (SmallButton(f, input, x + (quarter + S(6)), by, quarter, S(28), "TESTS…"))
            {
                if (_clashBatch != null) { FinishClashBatch(cancelled: true); } // runs and resets wait for the comments
                CancelClashReport(); // C-C3: and for the report's pictures
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
