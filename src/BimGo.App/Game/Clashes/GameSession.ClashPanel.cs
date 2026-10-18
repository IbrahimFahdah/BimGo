using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Native;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// The CLASHES panel (pause menu → CLASHES, or TESTS… in clash mode; in place of the pause menu): managing clash
    /// detection. TESTS: the tests (tick for RUN ALL) and the selected test's editor (name, hard / clearance, set A and
    /// set B dropdowns (B can be "set A against itself"; both stay as picked), tolerance, RUN, REVIEW in clash mode,
    /// RESET RESULTS, duplicate, delete). SETS: the search sets and the selected set's editor (name, any / all, rules:
    /// field and operator dropdowns (is, is one of, is not, is not any of, contains, does not contain), the value
    /// (picked from the model's values, ticks for the list operators; typed for contains), element count, duplicate,
    /// delete). RUN ALL, EXPORT / IMPORT REPORT, RESET ALL, CLOSE. Re-running tests with results and resetting ask
    /// first (in-panel confirm). Reviewing clashes happens in clash mode (Y). Labels are built when the data changes,
    /// never per frame.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>One clash row (labels made when a list is rebuilt).</summary>
        private sealed class ClashRow
        {
            public ClashRecord Clash;
            public string Title;
            public string Detail;
            public string Status;
            public string Search;
        }

        /// <summary>One test row's labels.</summary>
        private sealed class ClashTestRow
        {
            public ClashTest Test;
            public string Title;
            public string Detail;
            public string SetA, SetB, Tolerance, Counts, LastRun;
            public bool Changed;

            // Polish round P-C: the test's groups (name · members · status), shown in the editor
            public readonly List<(ClashGroup Group, string Label, string Status)> Groups = new();
        }

        // P-C: a group row clicked in the test editor: REVIEW opens on it
        private ClashGroup _clashPanelGroupPick;

        /// <summary>One set row's labels.</summary>
        private sealed class ClashSetRow
        {
            public SearchSet Set;
            public string Title;
            public string Detail;
            public int Elements;
            public int UsedBy;
        }

        private static readonly string[] CLASH_TABS = { "TESTS", "SETS" };
        private static readonly string[] CLASH_KINDS = { "HARD", "CLEARANCE" };
        private static readonly string[] CLASH_MATCH = { "ANY RULE", "ALL RULES" };

        // C-B4: a group's own any / all
        private static readonly string[] CLASH_GROUP_MATCH = { "ANY OF", "ALL OF" };

        // C-B4: the set editor's lines (a group header has no rule; top-level rules have no group). Polish round P-C:
        // groups nest to any depth: each line knows its depth, the group holding it and (headers) its number ("2.1");
        // rebuilt only when the set or its structure changes
        private readonly struct ClashRuleLine
        {
            public ClashRuleLine(RuleGroup group, SetRule rule, int depth, RuleGroup parent, string number)
            {
                Group = group;
                Rule = rule;
                Depth = depth;
                Parent = parent;
                Number = number;
            }

            public RuleGroup Group { get; }
            public SetRule Rule { get; }
            public int Depth { get; }
            public RuleGroup Parent { get; }
            public string Number { get; }
        }

        private readonly List<ClashRuleLine> _clashRuleLines = new();
        private SearchSet _clashRuleLinesSet;
        private int _clashRuleLinesVersion = -1, _clashRuleStructure;

        private bool _clashesOpen;
        private int _clashTab;
        private readonly ScrollRegion _clashScroll = new(), _clashRuleScroll = new(), _clashEditorScroll = new(); // polish round P-A1
        private string _clashSelectedTest, _clashSelectedSet;
        private bool _clashRowsDirty = true;
        private int _clashRowsUnits = -1;
        private readonly List<ClashTestRow> _clashTestRows = new();
        private readonly List<ClashSetRow> _clashSetRows = new();
        private string _clashesMenuLabel;
        private int _clashesMenuLabelFor = int.MinValue;
        private object _clashDeleteArmed;

        // Rule rows' button text (built with the labels, not per frame)
        private readonly Dictionary<SetRule, (string Field, string Op, string Value)> _clashRuleLabels = new();
        private static readonly string[] CLASH_FIELD_LABELS = RuleField.All.Select(f => SearchSets.FieldLabel(f).ToUpperInvariant()).ToArray();

        // Dropdown slots (owner + slot tell the open one apart)
        private const int DROP_SET_A = 1, DROP_SET_B = 2, DROP_RULE_FIELD = 3, DROP_RULE_OP = 4;

        // "Don't ask again this session" for re-running tests with results
        private bool _clashSkipRerunConfirm;

        // Colour round A: the "no extracted parameters" hint, once a session
        private bool _clashParameterHintShown;

        // The rule value picker (SETS tab, "is" rules)
        private SetRule _clashPickerRule;
        private List<RuleValue> _clashPickerValues;
        private readonly List<RuleValue> _clashPickerMatches = new();
        private readonly char[] _clashPickerSearch = new char[CLASH_SEARCH_MAX];
        private int _clashPickerSearchLength;
        private readonly ScrollRegion _clashPickerScroll = new();
        private bool _clashPickerDirty;
        private string _clashPickerHeader;

        #endregion

        #region Open / close

        /// <summary>True while the clash panel is showing (it replaces the pause menu).</summary>
        private bool IsClashesPanelOpen => _clashesOpen;

        /// <summary>
        /// Opens the clash panel (pause menu → CLASHES, TESTS… in clash mode), switching clash detection on the first time.
        /// </summary>
        private void OpenClashes()
        {
            EnsureClashes();
            if (!_paused) { SetPaused(true); }
            _clashesOpen = true;
            _clashScroll.Reset();
            _clashRuleScroll.Reset();
            _clashEditorScroll.Reset();
            _clashRowsDirty = true;
            _clashPickerRule = null;
            _clashDeleteArmed = null;
            CloseOverlay();
            if (_clashDocument.FindTest(_clashSelectedTest) == null) { _clashSelectedTest = _clashReviewTest ?? _clashDocument.Tests.FirstOrDefault()?.Id; }
            if (_clashDocument.FindSet(_clashSelectedSet) == null) { _clashSelectedSet = _clashDocument.Sets.FirstOrDefault()?.Id; }
        }

        /// <summary>
        /// Esc / CLOSE: an open dropdown or confirm closes first, then the value picker, then the panel (clash detection
        /// stays on for the session; clash mode, when it was on, carries on with its free cursor).
        /// </summary>
        /// <returns>True if something closed.</returns>
        private bool CloseClashes()
        {
            if (!_clashesOpen) { return false; }
            if (CloseOverlay()) { return true; }
            if (CancelClashImport()) { return true; } // QOL round: Esc leaves the import card first
            if (_clashPickerRule != null)
            {
                _clashPickerRule = null;
                return true;
            }
            _clashesOpen = false;
            _clashListDirty = true;
            if (_profilesReturnFromClashes)
            {
                // Colour round A: EDIT SETS… came from the colour profiles panel: back there
                _profilesReturnFromClashes = false;
                OpenColourProfiles();
                return true;
            }
            if (_clashModeOn) { SetPaused(false); }
            return true;
        }

        /// <summary>
        /// The pause menu button: "CLASHES", with the open count once clash detection is on (counted again only when
        /// the clash data changes).
        /// </summary>
        private string ClashesMenuLabel()
        {
            int stamp = _clashDocument == null ? -1 : _clashRevision;
            if (stamp == _clashesMenuLabelFor && _clashesMenuLabel != null) { return _clashesMenuLabel; }
            _clashesMenuLabelFor = stamp;
            int open = 0;
            if (_clashDocument != null)
            {
                foreach (ClashRecord clash in _clashDocument.Clashes)
                {
                    if (clash.Status != ClashStatus.RESOLVED && clash.Status != ClashStatus.APPROVED) { open++; }
                }
            }
            _clashesMenuLabel = open == 0 ? "CLASHES" : $"CLASHES ({open:N0})";
            return _clashesMenuLabel;
        }

        /// <summary>True when RUN ALL has something to run (no allocation: called every frame).</summary>
        private bool AnyClashTestEnabled()
        {
            foreach (ClashTest test in _clashDocument.Tests)
            {
                if (test.Enabled) { return true; }
            }
            return false;
        }

        /// <summary>Records an edit to tests or sets: stored, labels rebuilt, the clash list too.</summary>
        private void ClashSetupChanged()
        {
            ClashesChanged();
            _clashRowsDirty = true;
            _clashListDirty = true;
            _clashRuleStructure++; // P-C: the set editor's lines are rebuilt
            ProfileSetsChanged(); // colour round A: a by-set profile follows its sets
        }

        #endregion

        #region Panel

        /// <summary>
        /// Draws and handles the clash panel.
        /// </summary>
        private void BuildClashesPanel()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            RefreshClashRows();

            // Header: the TESTS / SETS tabs and RUN ALL on the right (an open dropdown / confirm takes this frame's click)
            bool importing = _clashImport != null;
            float tabsW = S(260);
            const string RUN_ALL = "RUN ALL";
            float runW = importing ? 0f : ShellButtonWidth(f, RUN_ALL);
            Text.Clear().Append(_clashDocument.Tests.Count).Append(_clashDocument.Tests.Count == 1 ? " test · " : " tests · ")
                .Append(_clashDocument.Sets.Count).Append(_clashDocument.Sets.Count == 1 ? " search set · saved with the model" : " search sets · saved with the model");
            PanelFrame frame = BeginPanel(PanelSize.Wide, "CLASHES", UiTheme.ACCENT, Text.Span,
                headerControls: importing ? 0f : tabsW + S(UiTheme.GAP) + runW, overlays: true);
            bool runAll = false;
            if (!importing)
            {
                float tabsX = TakeHeaderSlot(ref frame, tabsW, S(UiTheme.GAP));
                int tab = Segmented(f, input, tabsX, frame.HeaderControlY, tabsW, CLASH_TABS, _clashTab);
                if (tab == _clashTab) { tab = TakePadTabStep(tab, CLASH_TABS.Length); } // P-A2: LB / RB tapped alone
                if (tab != _clashTab)
                {
                    _clashTab = tab;
                    _clashScroll.Reset();
                    _clashRuleScroll.Reset();
                    _clashEditorScroll.Reset();
                    _clashPickerRule = null;
                    _clashDeleteArmed = null;
                    CloseOverlay();
                }
                runAll = HeaderButton(ref frame, RUN_ALL, ShellStyle.Primary, AnyClashTestEnabled(), runW);
            }

            float ix = frame.Ix, iw = frame.Iw;
            float cy = frame.BodyTop;
            float lw = MathF.Min(S(400), iw * 0.42f);
            float rx = ix + lw + S(24), rw = iw - lw - S(24);
            float bottom = frame.BodyBottom;
            string backLabel = _clashModeOn ? "← CLASH MODE" : null;

            // QOL round: an import waiting on decisions takes the body (← BACK cancels it)
            if (importing)
            {
                BuildClashImportCard(f, input, ix, cy, iw, bottom);
                int doImport = FooterAction("IMPORT", ShellStyle.Primary);
                int importPressed = EndPanel(frame, null, "Pick what each missing link or level becomes · ← BACK cancels the import", backLabel);
                if (importPressed == FOOTER_LEFT || !_clashesOpen || _clashImport == null) { return; }
                if (importPressed == doImport) { FinishClashImport(_clashImport); }
                return;
            }

            _ui.Rect(rx - S(12), cy, MathF.Max(1f, UiScale), bottom - cy, UiTheme.CARD_BORDER);

            ClashTest run = null, review = null;
            if (_clashTab == 0)
            {
                BuildClashTestList(f, input, ix, cy, lw, bottom);
                BuildClashTestEditor(f, input, rx, cy, rw, bottom, out run, out review);
            }
            else
            {
                BuildClashSetList(f, input, ix, cy, lw, bottom);
                if (_clashPickerRule != null) { BuildClashValuePicker(f, input, rx, cy, rw, bottom); }
                else { BuildClashSetEditor(f, input, rx, cy, rw, bottom); }
            }

            // QOL round: the tab's own tests / sets go to and from files (the clash report lives in clash mode now)
            int export = FooterAction(_clashTab == 0 ? "EXPORT TESTS…" : "EXPORT SETS…");
            int import = FooterAction(_clashTab == 0 ? "IMPORT TESTS…" : "IMPORT SETS…");
            int resetAll = FooterAction("RESET ALL…", ShellStyle.Danger);

            // The footer, then the open dropdown / confirm on top (a pick or confirm acts there)
            int pressed = EndPanel(frame, null, "Tick the tests RUN ALL runs · REVIEW opens clash mode on a test's results", backLabel);
            if (pressed == FOOTER_LEFT || !_clashesOpen) { return; }

            // Actions after drawing (they open dialogs, the progress screen, a confirm or clash mode)
            if (run != null) { RequestClashRun(new[] { run }); return; }
            if (review != null)
            {
                ClashGroup pick = _clashPanelGroupPick;
                _clashPanelGroupPick = null;
                EnterClashMode(null, review.Id);
                if (pick != null && _clashModeOn) { ClickClashGroupRow(pick, ctrl: false); } // P-C: a group row in the panel
                return;
            }
            if (runAll) { RequestClashRun(_clashDocument.Tests.Where(t => t.Enabled).ToList()); return; }
            if (pressed == export) { ExportClashSetup(_clashTab == 0 ? ClashSetupKind.Tests : ClashSetupKind.Sets); return; }
            if (pressed == import) { ImportClashSetup(_clashTab == 0 ? ClashSetupKind.Tests : ClashSetupKind.Sets); return; }
            if (pressed == resetAll) { RequestClashReset(_clashDocument.Tests); }
        }

        /// <summary>
        /// RUN / RUN ALL: runs at once when none of the tests has results (or "don't ask again" was ticked this
        /// session); otherwise asks first, since a re-run moves new clashes to active and resolves the ones it doesn't find.
        /// </summary>
        private void RequestClashRun(IReadOnlyList<ClashTest> tests)
        {
            int withResults = tests.Count(t => ClashMerge.HasResults(_clashDocument, t));
            if (withResults == 0 || _clashSkipRerunConfirm)
            {
                RunClashTests(tests);
                return;
            }
            string message = withResults == 1 && tests.Count == 1
                ? $"Re-run “{tests[0].Name}”? It has results: new clashes found before become active; ones not found become resolved."
                : $"Re-run {withResults} test{(withResults == 1 ? string.Empty : "s")} with results? New clashes found before become active; ones not found become resolved.";
            OpenConfirm("RE-RUN?", message, "RE-RUN", danger: false, offerSkip: true, skip =>
            {
                if (skip) { _clashSkipRerunConfirm = true; }
                RunClashTests(tests);
            });
        }

        /// <summary>
        /// RESET RESULTS / RESET ALL…: asks first (always), then clears the tests' clashes and run history so the next
        /// RUN starts fresh. Nothing to reset: a toast.
        /// </summary>
        private void RequestClashReset(IReadOnlyList<ClashTest> tests)
        {
            List<ClashTest> withResults = tests.Where(t => ClashMerge.HasResults(_clashDocument, t)).ToList();
            if (withResults.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast(tests.Count == 1 ? $"“{tests[0].Name}” has no results to reset" : "No test has results to reset", 2.5f);
                return;
            }
            int clashes = 0;
            foreach (ClashTest test in withResults) { clashes += ClashMerge.CountByStatus(_clashDocument, test.Id).Sum(); }
            string what = $"{clashes:N0} clash{(clashes == 1 ? string.Empty : "es")}, with their statuses, assignees and notes, and the run history are deleted. The next RUN starts fresh (all new).";
            bool single = tests.Count == 1;
            OpenConfirm(single ? "RESET RESULTS?" : "RESET ALL RESULTS?",
                single ? $"Reset “{withResults[0].Name}”? Its {what}" : $"Reset {withResults.Count} test{(withResults.Count == 1 ? string.Empty : "s")} with results? {what}",
                single ? "RESET" : "RESET ALL", danger: true, offerSkip: false, _ => ResetClashTests(withResults));
        }

        /// <summary>Clears tests' results (Core <see cref="ClashMerge.ResetTest"/>), forgetting the clash on screen if it went.</summary>
        private void ResetClashTests(IReadOnlyList<ClashTest> tests)
        {
            int removed = 0;
            foreach (ClashTest test in tests) { removed += ClashMerge.ResetTest(_clashDocument, test); }
            ForgetCurrentClashIfGone();
            ClashSetupChanged();
            Sound.Play(SoundId.Remove);
            Toast($"Results reset: {removed:N0} clash{(removed == 1 ? string.Empty : "es")} removed; RUN starts fresh", 3f);
        }

        /// <summary>The clash on screen no longer exists (reset, test deleted): clash mode shows none.</summary>
        private void ForgetCurrentClashIfGone()
        {
            if (_clashCurrent == null || _clashDocument.Clashes.Contains(_clashCurrent)) { return; }
            _clashCurrent = null;
            _clashElementA = _clashElementB = -1;
            _clashDynamicA = _clashDynamicB = null;
        }

        #endregion

        #region Tests

        /// <summary>
        /// The tests: tick (RUN ALL), name and kind, counts or "changed"; a click selects; NEW TEST below.
        /// </summary>
        private void BuildClashTestList(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            float rowH = S(56);
            float listBottom = bottom - S(44);
            float top = BeginScroll(_clashScroll, input, x, y, w, listBottom - y, out float cw);
            VisibleRows(_clashScroll, rowH, _clashTestRows.Count, out int first, out int last);
            w = cw;
            for (int i = first; i < last; i++)
            {
                ClashTestRow row = _clashTestRows[i];
                ClashTest test = row.Test;
                float ry = top + i * rowH;
                bool selected = test.Id == _clashSelectedTest;
                _ui.Rect(x, ry, w, rowH - S(6), selected ? Rgba.Hex(0x22D3EE, 0.12f) : Rgba.Hex(0xFFFFFF, 0.03f));

                bool enabled = Checkbox(f, input, x + S(10), ry + S(10), S(20), string.Empty, test.Enabled);
                if (enabled != test.Enabled)
                {
                    test.Enabled = enabled;
                    ClashSetupChanged();
                }
                _ui.TextWrapped(f.Bold, x + S(40), ry + S(6), w - S(50), row.Title, selected ? UiTheme.ACCENT : UiTheme.TEXT, maxLines: 1);
                _ui.TextWrapped(f.Small, x + S(40), ry + S(28), w - S(50), row.Detail, row.Changed ? Rgba.Hex(0xFCD34D) : UiTheme.TEXT_MUTED, maxLines: 1);

                if (Hover(input, x + S(36), ry, w - S(36), rowH - S(6)) && input.LeftPressed)
                {
                    input.ConsumeClicks();
                    Sound.Play(SoundId.UiClick);
                    _clashSelectedTest = test.Id;
                    _clashDeleteArmed = null;
                }
            }
            if (_clashTestRows.Count == 0) { _ui.Text(f.Body, x, y + S(6), "No tests yet: NEW TEST.", UiTheme.TEXT_MUTED); }
            EndScroll(_clashScroll, input, top + _clashTestRows.Count * rowH);

            if (SmallButton(f, input, x, bottom - S(34), S(140), S(32), "NEW TEST")) { AddClashTest(); }
        }

        /// <summary>
        /// The selected test's editor.
        /// </summary>
        private void BuildClashTestEditor(FontAtlas f, InputState input, float x, float y, float w, float bottom, out ClashTest run, out ClashTest review)
        {
            run = review = null;
            ClashTest test = _clashDocument.FindTest(_clashSelectedTest);
            ClashTestRow row = null;
            foreach (ClashTestRow candidate in _clashTestRows)
            {
                if (candidate.Test == test) { row = candidate; break; }
            }
            if (test == null || row == null)
            {
                _ui.Text(f.Body, x, y + S(6), "Select a test, or NEW TEST.", UiTheme.TEXT_MUTED);
                return;
            }

            // Polish round P-A1: the fields scroll (short windows); the buttons stay at the bottom
            float by = bottom - S(34);
            float editorW = w;
            float cy = BeginScroll(_clashEditorScroll, input, x, y, w, by - S(UiTheme.GAP) - y, out w);
            float labelW = S(110);
            float fx = x + labelW, fw = w - labelW;

            // Name
            EditorLabel(f, x, cy, "NAME");
            _ui.TextWrapped(f.Bold, fx, cy + S(7), fw - S(110), test.Name, UiTheme.TEXT, maxLines: 1);
            if (SmallButton(f, input, x + w - S(100), cy, S(100), S(30), "RENAME…"))
            {
                BeginTextEdit("TEST NAME", test.Name, 60, text =>
                {
                    if (text.Length == 0) { return; }
                    test.Name = text;
                    ClashSetupChanged();
                });
            }
            cy += S(44);

            // Kind
            EditorLabel(f, x, cy, "KIND");
            int kind = Segmented(f, input, fx, cy, MathF.Min(fw, S(300)), CLASH_KINDS, test.Kind == ClashKind.CLEARANCE ? 1 : 0);
            string newKind = kind == 1 ? ClashKind.CLEARANCE : ClashKind.HARD;
            if (newKind != test.Kind)
            {
                test.Kind = newKind;
                test.Tolerance = ClashDefaults.ToleranceFor(newKind);
                MarkClashTestEdited(test);
            }
            cy += S(44);

            // Sets (dropdowns; A and B stay as picked: changing one never changes the other)
            EditorLabel(f, x, cy, "SET A");
            if (DropdownButton(f, input, fx, cy, fw, S(30), row.SetA, IsDropdownOpen(test, DROP_SET_A)))
            {
                string[] ids = _clashDocument.Sets.Select(s => s.Id).ToArray();
                OpenDropdown(test, DROP_SET_A, fx, cy, fw, S(30), ClashSetChoices(), Array.IndexOf(ids, test.SetA), i =>
                {
                    if (ids[i] == test.SetA) { return; }
                    test.SetA = ids[i];
                    MarkClashTestEdited(test);
                });
            }
            cy += S(44);
            EditorLabel(f, x, cy, "SET B");
            if (DropdownButton(f, input, fx, cy, fw, S(30), row.SetB, IsDropdownOpen(test, DROP_SET_B)))
            {
                var ids = new List<string> { null };
                ids.AddRange(_clashDocument.Sets.Select(s => s.Id));
                var labels = new List<string> { "(set A against itself)" };
                labels.AddRange(ClashSetChoices());
                OpenDropdown(test, DROP_SET_B, fx, cy, fw, S(30), labels, string.IsNullOrEmpty(test.SetB) ? 0 : ids.IndexOf(test.SetB), i =>
                {
                    if (ids[i] == test.SetB) { return; }
                    test.SetB = ids[i];
                    MarkClashTestEdited(test);
                });
            }
            cy += S(44);

            // Tolerance
            EditorLabel(f, x, cy, test.Kind == ClashKind.CLEARANCE ? "DISTANCE" : "TOLERANCE");
            if (SmallButton(f, input, fx, cy, S(32), S(30), "−")) { StepClashTolerance(test, -1); }
            _ui.TextCentred(f.Bold, fx + S(32) + S(70), cy + S(7), row.Tolerance, UiTheme.TEXT);
            if (SmallButton(f, input, fx + S(32) + S(140), cy, S(32), S(30), "+")) { StepClashTolerance(test, +1); }
            _ui.TextWrapped(f.Small, fx + S(220), cy + S(8), fw - S(220),
                test.Kind == ClashKind.CLEARANCE ? "closer than this is reported" : "crossings up to this deep are ignored", UiTheme.TEXT_MUTED, maxLines: 1);
            cy += S(48);

            // Last run and counts
            _ui.TextWrapped(f.Small, x, cy, w, row.LastRun, row.Changed ? Rgba.Hex(0xFCD34D) : UiTheme.TEXT_MUTED, maxLines: 2);
            cy += S(36);
            cy += _ui.TextWrapped(f.Body, x, cy, w, row.Counts, UiTheme.TEXT_SOFT, maxLines: 2);

            // Polish round P-C: the test's groups; a click reviews the test with that group picked
            if (row.Groups.Count > 0)
            {
                cy += S(12);
                _ui.Text(f.Small, x, cy, "GROUPS · CLICK ONE TO REVIEW IT", UiTheme.TEXT_MUTED, S(1.2f));
                cy += S(22);
                float gh = S(30);
                foreach ((ClashGroup group, string label, string status) in row.Groups)
                {
                    bool hover = Hover(input, x, cy, w, gh - S(4));
                    _ui.Rect(x, cy, w, gh - S(4), hover ? Rgba.Hex(0xFFFFFF, 0.08f) : Rgba.Hex(0xFFFFFF, 0.03f));
                    _ui.Rect(x, cy, S(4), gh - S(4), StatusColour(group.Status));
                    float statusW = UiBatch.Measure(f.Small, status) + S(12);
                    _ui.TextWrapped(f.Body, x + S(12), cy + S(5), w - S(24) - statusW, label, UiTheme.TEXT, maxLines: 1);
                    _ui.Text(f.Small, x + w - statusW, cy + S(8), status, StatusColour(group.Status));
                    if (hover && input.LeftPressed)
                    {
                        input.ConsumeClicks();
                        _clashPanelGroupPick = group;
                        review = test;
                    }
                    cy += gh;
                }
            }
            EndScroll(_clashEditorScroll, input, cy + S(8));
            w = editorW;

            // Buttons
            float bw = (w - S(24)) / 5f;
            if (SmallButton(f, input, x, by, bw, S(32), "RUN")) { run = test; }
            if (SmallButton(f, input, x + (bw + S(6)), by, bw, S(32), "REVIEW")) { review = test; }
            if (SmallButton(f, input, x + (bw + S(6)) * 2f, by, bw, S(32), bw >= S(124) ? "RESET RESULTS…" : "RESET…", danger: true)) { RequestClashReset(new[] { test }); }
            if (SmallButton(f, input, x + (bw + S(6)) * 3f, by, bw, S(32), "DUPLICATE"))
            {
                var copy = new ClashTest { Name = test.Name + " (copy)", Kind = test.Kind, SetA = test.SetA, SetB = test.SetB, Tolerance = test.Tolerance, Enabled = test.Enabled };
                _clashDocument.Tests.Insert(_clashDocument.Tests.IndexOf(test) + 1, copy);
                _clashSelectedTest = copy.Id;
                ClashSetupChanged();
            }
            bool armed = _clashDeleteArmed == test;
            if (SmallButton(f, input, x + (bw + S(6)) * 4f, by, bw, S(32), armed ? "SURE?" : "DELETE", danger: true))
            {
                if (!armed)
                {
                    _clashDeleteArmed = test;
                    Toast("Click DELETE again to delete the test and its clashes", 3f);
                }
                else
                {
                    ClashMerge.RemoveTest(_clashDocument, test.Id);
                    if (_clashReviewTest == test.Id) { _clashReviewTest = null; }
                    ForgetCurrentClashIfGone();
                    _clashSelectedTest = _clashDocument.Tests.FirstOrDefault()?.Id;
                    _clashDeleteArmed = null;
                    ClashSetupChanged();
                    Toast("Test deleted", 2f);
                }
            }
        }

        private void EditorLabel(FontAtlas f, float x, float y, string label) => _ui.Text(f.Small, x, y + S(8), label, UiTheme.TEXT_MUTED, S(1.2f));

        /// <summary>The sets as dropdown choices ("Services (1,234)"), in the document's order (built when a list opens).</summary>
        private List<string> ClashSetChoices()
        {
            var labels = new List<string>(_clashDocument.Sets.Count);
            foreach (SearchSet set in _clashDocument.Sets)
            {
                ClashSetRow row = _clashSetRows.FirstOrDefault(r => r.Set == set);
                labels.Add(row == null ? set.Name : $"{set.Name} ({row.Elements:N0})");
            }
            return labels;
        }

        /// <summary>A test's sets, kind or tolerance changed: its last results no longer match (until RUN).</summary>
        private void MarkClashTestEdited(ClashTest test)
        {
            if (test.LastRunUtc != null) { test.LastRunModel = "edited"; }
            ClashSetupChanged();
        }

        /// <summary>NEW TEST: hard, 5 mm, the first two sets (with fewer than two: the first against itself, stored as such).</summary>
        private void AddClashTest()
        {
            var test = new ClashTest
            {
                Name = $"Test {_clashDocument.Tests.Count + 1}",
                Kind = ClashKind.HARD,
                SetA = _clashDocument.Sets.ElementAtOrDefault(0)?.Id,
                SetB = _clashDocument.Sets.ElementAtOrDefault(1)?.Id,
                Tolerance = ClashDefaults.HARD_TOLERANCE
            };
            _clashDocument.Tests.Add(test);
            _clashSelectedTest = test.Id;
            _clashScroll.ScrollToEnd();
            ClashSetupChanged();
        }

        /// <summary>
        /// − / +: hard tolerance in 1 mm steps (5 mm past 10 mm), clearance distance in 5 mm steps (25 mm past 100 mm).
        /// </summary>
        private void StepClashTolerance(ClashTest test, int direction)
        {
            double mm = test.Tolerance * 1000.0;
            double coarseFrom = test.Kind == ClashKind.CLEARANCE ? 100 : 10;
            bool coarse = direction > 0 ? mm >= coarseFrom - 1e-6 : mm > coarseFrom + 1e-6;
            double step = test.Kind == ClashKind.CLEARANCE ? (coarse ? 25 : 5) : (coarse ? 5 : 1);
            mm = Math.Round((mm + direction * step) / step) * step;
            test.Tolerance = Math.Clamp(mm, 0.0, ClashDefaults.MAX_TOLERANCE * 1000.0) / 1000.0;
            MarkClashTestEdited(test);
        }

        #endregion

        #region Sets

        /// <summary>
        /// The sets: name, elements, how many tests use it; a click selects; NEW SET below.
        /// </summary>
        private void BuildClashSetList(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            float rowH = S(52);
            float listBottom = bottom - S(44);
            float listW = w;
            float top = BeginScroll(_clashScroll, input, x, y, w, listBottom - y, out w);
            VisibleRows(_clashScroll, rowH, _clashSetRows.Count, out int first, out int last);
            for (int i = first; i < last; i++)
            {
                ClashSetRow row = _clashSetRows[i];
                float ry = top + i * rowH;
                bool selected = row.Set.Id == _clashSelectedSet;
                bool hover = Hover(input, x, ry, w, rowH - S(6));
                _ui.Rect(x, ry, w, rowH - S(6), selected ? Rgba.Hex(0x22D3EE, 0.12f) : hover ? Rgba.Hex(0xFFFFFF, 0.06f) : Rgba.Hex(0xFFFFFF, 0.03f));
                _ui.TextWrapped(f.Bold, x + S(12), ry + S(6), w - S(24), row.Title, selected ? UiTheme.ACCENT : UiTheme.TEXT, maxLines: 1);
                _ui.TextWrapped(f.Small, x + S(12), ry + S(27), w - S(24), row.Detail, UiTheme.TEXT_MUTED, maxLines: 1);
                if (hover && input.LeftPressed)
                {
                    input.ConsumeClicks();
                    Sound.Play(SoundId.UiClick);
                    _clashSelectedSet = row.Set.Id;
                    _clashRuleScroll.Reset();
                    _clashDeleteArmed = null;
                }
            }
            if (_clashSetRows.Count == 0) { _ui.Text(f.Body, x, y + S(6), "No sets yet: NEW SET.", UiTheme.TEXT_MUTED); }
            EndScroll(_clashScroll, input, top + _clashSetRows.Count * rowH);
            w = listW;

            if (SmallButton(f, input, x, bottom - S(34), S(140), S(32), "NEW SET"))
            {
                var set = new SearchSet { Name = $"Set {_clashDocument.Sets.Count + 1}" };
                _clashDocument.Sets.Add(set);
                _clashSelectedSet = set.Id;
                _clashScroll.ScrollToEnd();
                ClashSetupChanged();
            }
        }

        /// <summary>
        /// The selected set's editor: name, any / all, the rules (field ▾, operator ▾, value, ×), ADD RULE (a new row:
        /// BimGo category, IS, nothing picked yet), the element count, DUPLICATE, DELETE (refused while a test uses it).
        /// </summary>
        private void BuildClashSetEditor(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            SearchSet set = _clashDocument.FindSet(_clashSelectedSet);
            ClashSetRow row = null;
            foreach (ClashSetRow candidate in _clashSetRows)
            {
                if (candidate.Set == set) { row = candidate; break; }
            }
            if (set == null || row == null)
            {
                _ui.Text(f.Body, x, y + S(6), "Select a set, or NEW SET.", UiTheme.TEXT_MUTED);
                return;
            }

            float labelW = S(110), cy = y;
            float fx = x + labelW, fw = w - labelW;
            EditorLabel(f, x, cy, "NAME");
            _ui.TextWrapped(f.Bold, fx, cy + S(7), fw - S(110), set.Name, UiTheme.TEXT, maxLines: 1);
            if (SmallButton(f, input, x + w - S(100), cy, S(100), S(30), "RENAME…"))
            {
                BeginTextEdit("SET NAME", set.Name, 60, text =>
                {
                    if (text.Length == 0) { return; }
                    set.Name = text;
                    ClashSetupChanged();
                });
            }
            cy += S(44);

            EditorLabel(f, x, cy, "INCLUDE IF");
            int match = Segmented(f, input, fx, cy, MathF.Min(fw, S(300)), CLASH_MATCH, set.MatchAll ? 1 : 0);
            if ((match == 1) != set.MatchAll)
            {
                set.MatchAll = match == 1;
                ClashSetEdited();
            }
            cy += S(44);
            _ui.TextWrapped(f.Small, x, cy, w, "RULES · TOP-LEVEL \"NOT\" RULES TAKE ELEMENTS OUT · IN A GROUP THEY ARE ORDINARY CONDITIONS", UiTheme.TEXT_MUTED, maxLines: 1);
            cy += S(22);

            // C-B4: the lines: the set's own rules, then each group (a header, then its rules and groups indented)
            if (!ReferenceEquals(_clashRuleLinesSet, set) || _clashRuleLinesVersion != _clashRuleStructure) { BuildClashRuleLines(set); }

            float footer = bottom - S(34) - S(52);
            float ruleH = S(38);
            float editorW = w;
            float linesTop = cy;
            float top = BeginScroll(_clashRuleScroll, input, x, cy, w, footer - cy, out w);
            VisibleRows(_clashRuleScroll, ruleH, _clashRuleLines.Count, out int first, out int last);
            SetRule remove = null;
            RuleGroup removeFrom = null, removeGroup = null, removeParent = null, addTo = null, addGroupTo = null;
            float indent = S(20);
            for (int i = first; i < last; i++)
            {
                ClashRuleLine line = _clashRuleLines[i];
                RuleGroup group = line.Group;
                SetRule rule = line.Rule;
                float ry = top + i * ruleH;
                if (rule == null)
                {
                    // Group header: "GROUP 2.1", ANY OF / ALL OF, ADD RULE, ADD GROUP (P-C: a group inside), ×
                    float hx = x + Math.Min(line.Depth, 4) * indent, hw = w - (hx - x);
                    for (int d = 0; d < line.Depth && d < 4; d++) { _ui.Rect(x + S(8) + d * indent, ry, S(3), S(32), Rgba.Hex(0x22D3EE, 0.35f)); }
                    _ui.Rect(hx, ry, hw, S(32), Rgba.Hex(0x22D3EE, 0.07f));
                    _ui.Text(f.Bold, hx + S(8), ry + S(8), line.Number, UiTheme.ACCENT);
                    float gx = hx + S(96);
                    float delW = S(32), addW = S(100);
                    float segW = MathF.Max(S(120), MathF.Min(S(190), hw - S(96) - delW - addW * 2f - S(24)));
                    int gm = Segmented(f, input, gx, ry, segW, CLASH_GROUP_MATCH, group.MatchAll ? 1 : 0);
                    if ((gm == 1) != group.MatchAll)
                    {
                        group.MatchAll = gm == 1;
                        ClashSetEdited();
                    }
                    if (SmallButton(f, input, x + w - delW - (addW + S(6)) * 2f, ry, addW, S(32), "ADD RULE")) { addTo = group; }
                    if (SmallButton(f, input, x + w - delW - addW - S(6), ry, addW, S(32), "ADD GROUP")) { addGroupTo = group; }
                    if (SmallButton(f, input, x + w - delW, ry, delW, S(32), "×", danger: true))
                    {
                        removeGroup = group;
                        removeParent = line.Parent;
                    }
                    continue;
                }

                float rx = x + Math.Min(line.Depth, 4) * indent;
                for (int d = 0; d < line.Depth && d < 4; d++) { _ui.Rect(x + S(8) + d * indent, ry, S(3), S(32), Rgba.Hex(0x22D3EE, 0.35f)); }
                if (BuildClashRuleRow(f, input, rule, rx, ry, w - (rx - x), inGroup: group != null))
                {
                    remove = rule;
                    removeFrom = group;
                }
            }
            if (_clashRuleLines.Count == 0) { _ui.Text(f.Body, x, linesTop + S(6), "No rules: every element is in this set. ADD RULE or ADD GROUP.", UiTheme.TEXT_MUTED); }
            EndScroll(_clashRuleScroll, input, top + _clashRuleLines.Count * ruleH);
            w = editorW;
            if (remove != null)
            {
                (removeFrom?.Rules ?? set.Rules).Remove(remove);
                ClashSetEdited();
            }
            if (addTo != null)
            {
                addTo.Rules.Add(new SetRule { Field = RuleField.CATALOG, Op = RuleOp.IS }.Normalise());
                ClashSetEdited();
            }
            if (addGroupTo != null)
            {
                // P-C: a group inside a group (ALL OF, one rule to fill in): one more condition of the outer group
                addGroupTo.Groups ??= new List<RuleGroup>();
                var inner = new RuleGroup { MatchAll = true };
                inner.Rules.Add(new SetRule { Field = RuleField.CATALOG, Op = RuleOp.IS }.Normalise());
                addGroupTo.Groups.Add(inner);
                ClashSetEdited();
            }
            if (removeGroup != null)
            {
                RuleGroup target = removeGroup, parent = removeParent;
                int rules = target.RuleCount;
                if (rules == 0 && target.Groups == null) { RemoveClashGroup(set, parent, target); }
                else
                {
                    OpenConfirm("DELETE GROUP", $"Delete {ClashGroupNumber(target).ToLowerInvariant()} and its {rules} rule{(rules == 1 ? string.Empty : "s")}?",
                        "DELETE", danger: true, offerSkip: false, ok => { if (ok) { RemoveClashGroup(set, parent, target); } });
                }
            }

            // Count, then buttons
            _ui.TextWrapped(f.Body, x, footer + S(10), w, row.Detail, UiTheme.TEXT_SOFT, maxLines: 1);
            float by = bottom - S(34), bw = (w - S(18)) / 4f;
            if (SmallButton(f, input, x, by, bw, S(32), "ADD RULE"))
            {
                // A row to fill in: BimGo category, IS, nothing picked (left out of matching until it has a value)
                set.Rules.Add(new SetRule { Field = RuleField.CATALOG, Op = RuleOp.IS }.Normalise());
                _clashRuleScroll.Reveal(set.Rules.Count * ruleH - ruleH, set.Rules.Count * ruleH); // the new rule sits before the groups
                ClashSetEdited();
            }
            if (SmallButton(f, input, x + bw + S(6), by, bw, S(32), "ADD GROUP"))
            {
                // C-B4: a group (ALL OF, one rule to fill in) at the end; with the set on ANY, groups read as OR of ANDs
                set.Groups ??= new List<RuleGroup>();
                var group = new RuleGroup { MatchAll = true };
                group.Rules.Add(new SetRule { Field = RuleField.CATALOG, Op = RuleOp.IS }.Normalise());
                set.Groups.Add(group);
                _clashRuleScroll.ScrollToEnd();
                ClashSetEdited();
            }
            if (SmallButton(f, input, x + (bw + S(6)) * 2f, by, bw, S(32), "DUPLICATE"))
            {
                SearchSet copy = set.Copy(newId: true);
                copy.Name = set.Name + " (copy)";
                _clashDocument.Sets.Insert(_clashDocument.Sets.IndexOf(set) + 1, copy);
                _clashSelectedSet = copy.Id;
                ClashSetupChanged();
            }
            bool armed = _clashDeleteArmed == set;
            if (SmallButton(f, input, x + (bw + S(6)) * 3f, by, bw, S(32), armed ? "SURE?" : "DELETE", danger: true))
            {
                if (row.UsedBy > 0)
                {
                    Sound.Play(SoundId.Error);
                    Toast($"“{set.Name}” is used by {row.UsedBy} test{(row.UsedBy == 1 ? string.Empty : "s")}: change {(row.UsedBy == 1 ? "it" : "them")} first", 3.5f);
                }
                else if (!armed)
                {
                    _clashDeleteArmed = set;
                    Toast("Click DELETE again to delete the set", 3f);
                }
                else
                {
                    _clashDocument.Sets.Remove(set);
                    _clashSelectedSet = _clashDocument.Sets.FirstOrDefault()?.Id;
                    _clashDeleteArmed = null;
                    ClashSetupChanged();
                    Toast("Set deleted", 2f);
                }
            }
        }

        /// <summary>
        /// One rule row: field ▾, operator ▾ ("not" ones underlined in the danger colour at the top level, where they take
        /// elements out; muted inside a group, where they are ordinary conditions), value, ×. True when × was clicked.
        /// </summary>
        private bool BuildClashRuleRow(FontAtlas f, InputState input, SetRule rule, float x, float ry, float w, bool inGroup)
        {
            float fieldW = S(150), opW = S(150), delW = S(32), g = S(6);
            float valueW = MathF.Max(S(80), w - fieldW - opW - delW - g * 3);
            float bx = x;
            (string fieldLabel, string opLabel, string valueLabel) = ClashRuleLabels(rule);

            // Field: the built-in fields, then (colour round A) each extracted parameter
            if (DropdownButton(f, input, bx, ry, fieldW, S(32), fieldLabel, IsDropdownOpen(rule, DROP_RULE_FIELD)))
            {
                SetRule target = rule;
                List<string> parameters = (Scene.Parameters ?? ParameterTable.Empty).SortedNames();
                var labels = new List<string>(CLASH_FIELD_LABELS.Length + parameters.Count);
                labels.AddRange(CLASH_FIELD_LABELS);
                foreach (string name in parameters) { labels.Add("PARAMETER: " + name); }
                int selected = RuleField.Normalise(rule.Field) == RuleField.PARAMETER
                    ? CLASH_FIELD_LABELS.Length + parameters.FindIndex(n => string.Equals(n, rule.Parameter, StringComparison.OrdinalIgnoreCase))
                    : Array.IndexOf(RuleField.All, RuleField.Normalise(rule.Field));
                if (selected < 0) { selected = -1; }
                OpenDropdown(rule, DROP_RULE_FIELD, bx, ry, fieldW, S(32), labels, selected, k =>
                {
                    string field = k < RuleField.All.Length ? RuleField.All[k] : RuleField.PARAMETER;
                    string parameter = k < RuleField.All.Length ? null : parameters[k - RuleField.All.Length];
                    if (target.IsField(field, parameter)) { return; }
                    target.SetField(field, parameter);
                    _clashRuleLabels.Remove(target);
                    ClashSetEdited();
                });
                if (parameters.Count == 0 && !_clashParameterHintShown)
                {
                    _clashParameterHintShown = true;
                    Toast("Parameter rules: tick parameters in Revit Options → Parameters, then Go / Export again", 4f);
                }
            }
            bx += fieldW + g;

            // Operator
            if (DropdownButton(f, input, bx, ry, opW, S(32), opLabel, IsDropdownOpen(rule, DROP_RULE_OP)))
            {
                SetRule target = rule;
                OpenDropdown(rule, DROP_RULE_OP, bx, ry, opW, S(32), RuleOp.Labels, RuleOp.IndexOf(rule.Operator), k =>
                {
                    if (RuleOp.All[k] == target.Operator) { return; }
                    target.SetOperator(RuleOp.All[k]);
                    ClashSetEdited();
                });
            }
            if (RuleOp.IsNegative(rule.Operator)) { _ui.Rect(bx, ry + S(32) - S(3), opW, S(3), inGroup ? Rgba.Hex(0xFFFFFF, 0.25f) : Rgba.Hex(0xFCA5A5, 0.7f)); }
            bx += opW + g;

            // Value: typed for contains, else picked from the model (ticks for the list operators)
            if (SmallButton(f, input, bx, ry, valueW, S(32), valueLabel))
            {
                if (RuleOp.IsText(rule.Operator)) { BeginClashRuleText(rule); }
                else if (RuleOp.IsNumeric(rule.Operator)) { BeginClashRuleNumber(rule); } // colour round B
                else { OpenClashValuePicker(rule); }
            }
            bx += valueW + g;
            return SmallButton(f, input, bx, ry, delW, S(32), "×", danger: true);
        }

        /// <summary>
        /// C-B4: removes a group from the set or (P-C) from the group holding it; the list goes back to null when none is
        /// left.
        /// </summary>
        private void RemoveClashGroup(SearchSet set, RuleGroup parent, RuleGroup group)
        {
            if (parent == null)
            {
                if (set.Groups == null || !set.Groups.Remove(group)) { return; }
                if (set.Groups.Count == 0) { set.Groups = null; }
            }
            else
            {
                if (parent.Groups == null || !parent.Groups.Remove(group)) { return; }
                if (parent.Groups.Count == 0) { parent.Groups = null; }
            }
            ClashSetEdited();
        }

        /// <summary>
        /// Polish round P-C: the set editor's lines (top-level rules, then each group depth first: its header, its rules,
        /// its groups), with the headers' numbers ("GROUP 2", "GROUP 2.1").
        /// </summary>
        private void BuildClashRuleLines(SearchSet set)
        {
            _clashRuleLines.Clear();
            _clashRuleLinesSet = set;
            _clashRuleLinesVersion = _clashRuleStructure;
            foreach (SetRule rule in set.Rules) { _clashRuleLines.Add(new ClashRuleLine(null, rule, 0, null, null)); }
            AddClashGroupLines(set.Groups, null, 0, "GROUP ");
        }

        private void AddClashGroupLines(List<RuleGroup> groups, RuleGroup parent, int depth, string prefix)
        {
            if (groups == null || depth >= RuleGroup.MAX_DEPTH) { return; }
            for (int g = 0; g < groups.Count; g++)
            {
                RuleGroup group = groups[g];
                if (group == null) { continue; }
                string number = prefix + (g + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
                _clashRuleLines.Add(new ClashRuleLine(group, null, depth, parent, number));
                foreach (SetRule rule in group.Rules) { _clashRuleLines.Add(new ClashRuleLine(group, rule, depth + 1, parent, null)); }
                AddClashGroupLines(group.Groups, group, depth + 1, number + ".");
            }
        }

        /// <summary>A group's header text ("GROUP 2.1"), from the current lines.</summary>
        private string ClashGroupNumber(RuleGroup group)
        {
            foreach (ClashRuleLine line in _clashRuleLines)
            {
                if (line.Rule == null && ReferenceEquals(line.Group, group)) { return line.Number; }
            }
            return "the group";
        }

        /// <summary>A set's rules changed: the tests using it no longer match their last results.</summary>
        private void ClashSetEdited()
        {
            foreach (ClashTest test in _clashDocument.Tests)
            {
                if ((test.SetA == _clashSelectedSet || test.SetB == _clashSelectedSet) && test.LastRunUtc != null) { test.LastRunModel = "edited"; }
            }
            ClashSetupChanged();
        }

        /// <summary>A rule row's field, operator and value button text, cached until the labels are rebuilt.</summary>
        private (string Field, string Op, string Value) ClashRuleLabels(SetRule rule)
        {
            if (!_clashRuleLabels.TryGetValue(rule, out (string Field, string Op, string Value) labels))
            {
                labels = (SearchSets.FieldLabel(rule).ToUpperInvariant(), RuleOp.Labels[Math.Max(0, RuleOp.IndexOf(rule.Operator))], ClashRuleValueLabel(rule));
                _clashRuleLabels[rule] = labels;
            }
            return labels;
        }

        /// <summary>
        /// The value button's text: the typed text, the picked value (a list: the first and how many more), or a prompt.
        /// </summary>
        private string ClashRuleValueLabel(SetRule rule)
        {
            string op = rule.Operator;
            int count = rule.ValueCount;
            if (RuleOp.IsNumeric(op))
            {
                // Colour round B: typed numbers
                if (op == RuleOp.BETWEEN) { return count < 2 ? "TYPE TWO NUMBERS…" : $"{rule.ValueAt(0)} – {rule.ValueAt(1)}"; }
                return count == 0 ? "TYPE A NUMBER…" : rule.ValueAt(0);
            }
            if (RuleOp.IsText(op)) { return count == 0 || string.IsNullOrEmpty(rule.ValueAt(0)) ? "TYPE…" : $"“{rule.ValueAt(0)}”"; }
            if (count == 0) { return RuleOp.IsList(op) ? "TICK VALUES…" : "PICK…"; }
            string field = RuleField.Normalise(rule.Field);
            string first = field == RuleField.LINK && rule.ValueAt(0).Length == 0 ? "HOST MODEL" : SearchSets.ValueLabel(field, rule.ValueAt(0), false, Scene);
            if (count == 1) { return first; }
            string second = field == RuleField.LINK && rule.ValueAt(1).Length == 0 ? "HOST MODEL" : SearchSets.ValueLabel(field, rule.ValueAt(1), false, Scene);
            return count == 2 ? $"{first}, {second}" : $"{first}, {second} +{count - 2}";
        }

        /// <summary>A contains / does not contain rule's text.</summary>
        private void BeginClashRuleText(SetRule rule)
        {
            BeginTextEdit($"{SearchSets.FieldLabel(rule).ToUpperInvariant()} {RuleOp.Labels[Math.Max(0, RuleOp.IndexOf(rule.Operator))]}",
                rule.ValueCount > 0 ? rule.ValueAt(0) : string.Empty, 80, text =>
            {
                rule.SetValues(new[] { text });
                ClashSetEdited();
            });
        }

        /// <summary>
        /// Colour round B: an at least / at most / between rule's numbers, typed ("600", "300 to 600"; units ignored).
        /// </summary>
        private void BeginClashRuleNumber(SetRule rule)
        {
            bool between = rule.Operator == RuleOp.BETWEEN;
            string current = rule.ValueCount == 0 ? string.Empty : between && rule.ValueCount >= 2 ? $"{rule.ValueAt(0)} to {rule.ValueAt(1)}" : rule.ValueAt(0);
            string title = $"{SearchSets.FieldLabel(rule).ToUpperInvariant()} {RuleOp.Labels[Math.Max(0, RuleOp.IndexOf(rule.Operator))]}" +
                (between ? " (TWO NUMBERS, E.G. 300 TO 600)" : " (A NUMBER, UNITS AS SHOWN)");
            BeginTextEdit(title, current, 40, text =>
            {
                List<double> numbers = RuleNumbers.All(text, between ? 2 : 1);
                if (numbers.Count < (between ? 2 : 1))
                {
                    Toast(between ? "Type two numbers, e.g. 300 to 600" : "Type a number, e.g. 600", 3f);
                    return;
                }
                rule.SetValues(numbers.Select(RuleNumbers.Format));
                ClashSetEdited();
            });
        }

        #endregion

        #region Value picker

        /// <summary>
        /// Opens the value picker for a rule that compares with model values: the field's values in the model, with
        /// counts. Is / is not: a click picks one. Is one of / is not any of: clicks tick and untick, DONE returns.
        /// </summary>
        private void OpenClashValuePicker(SetRule rule)
        {
            _clashPickerRule = rule;
            _clashPickerValues = SearchSets.ValuesOf(Scene, rule.Field, rule.Parameter);
            _clashPickerSearchLength = 0;
            _clashPickerScroll.Reset();
            _clashPickerDirty = true;
            RefreshClashPickerHeader();
        }

        /// <summary>The picker's heading (rebuilt when a tick changes, not per frame).</summary>
        private void RefreshClashPickerHeader()
        {
            SetRule rule = _clashPickerRule;
            if (rule == null) { return; }
            string field = SearchSets.FieldLabel(rule).ToUpperInvariant();
            string op = RuleOp.Labels[Math.Max(0, RuleOp.IndexOf(rule.Operator))];
            _clashPickerHeader = RuleOp.IsList(rule.Operator)
                ? $"TICK: {field} {op} · {rule.ValueCount} PICKED · TYPE TO FILTER"
                : $"PICK: {field} {op} · TYPE TO FILTER";
        }

        /// <summary>
        /// The picker (in place of the set editor): typing filters; a click picks (single) or ticks (list operators);
        /// TYPE A VALUE… for one that isn't in the model; CLEAR and DONE (list) or BACK (single); Esc returns.
        /// </summary>
        private void BuildClashValuePicker(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            SetRule rule = _clashPickerRule;
            bool multi = RuleOp.IsList(rule.Operator);
            foreach (char c in input.Chars)
            {
                if (c == '\b')
                {
                    if (input.IsDown(Win32.VK_CONTROL)) { _clashPickerSearchLength = 0; }
                    else if (_clashPickerSearchLength > 0) { _clashPickerSearchLength--; }
                    _clashPickerDirty = true;
                }
                else if (c >= ' ' && c != 127 && _clashPickerSearchLength < CLASH_SEARCH_MAX)
                {
                    _clashPickerSearch[_clashPickerSearchLength++] = c;
                    _clashPickerDirty = true;
                }
            }
            if (_clashPickerDirty)
            {
                _clashPickerDirty = false;
                _clashPickerScroll.Reset();
                string search = new string(_clashPickerSearch, 0, _clashPickerSearchLength).Trim();
                _clashPickerMatches.Clear();
                foreach (RuleValue value in _clashPickerValues)
                {
                    if (search.Length == 0 || value.Label.Contains(search, StringComparison.CurrentCultureIgnoreCase)) { _clashPickerMatches.Add(value); }
                }
            }

            _ui.Text(f.Small, x, y + S(4), _clashPickerHeader ?? string.Empty, UiTheme.ACCENT, S(1.2f));
            float cy = y + S(26);
            float boxH = S(34);
            _ui.Panel(x, cy, w, boxH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
            if (_clashPickerSearchLength == 0) { _ui.Text(f.Body, x + S(10), cy + S(8), "type part of a name…", UiTheme.TEXT_FAINT); }
            else
            {
                float used = _ui.Text(f.Body, x + S(10), cy + S(8), _clashPickerSearch.AsSpan(0, _clashPickerSearchLength), UiTheme.TEXT);
                if (((int)(_clock * 2f) & 1) == 0) { _ui.Rect(x + S(11) + used, cy + S(7), S(2), boxH - S(14), UiTheme.TEXT_SOFT); }
            }
            cy += boxH + S(10);

            float listBottom = bottom - S(44);
            float rowH = S(34);
            float pickerW = w;
            float top = BeginScroll(_clashPickerScroll, input, x, cy, w, listBottom - cy, out w);
            VisibleRows(_clashPickerScroll, rowH, _clashPickerMatches.Count, out int first, out int last);
            RuleValue? picked = null;
            float tick = multi ? S(28) : 0f;
            for (int i = first; i < last; i++)
            {
                RuleValue value = _clashPickerMatches[i];
                float ry = top + i * rowH;
                bool hover = Hover(input, x, ry, w, rowH - S(4));
                bool current = rule.HasValue(value.Value);
                _ui.Rect(x, ry, w, rowH - S(4), current ? Rgba.Hex(0x22D3EE, 0.14f) : hover ? Rgba.Hex(0xFFFFFF, 0.08f) : ((i & 1) == 0 ? Rgba.Hex(0xFFFFFF, 0.03f) : 0u));
                if (multi)
                {
                    // A tick box (drawn like the checkboxes)
                    float box = S(16), bxx = x + S(8), byy = ry + (rowH - S(4) - box) * 0.5f;
                    _ui.Rect(bxx, byy, box, box, current ? UiTheme.ACCENT : UiTheme.CONTROL);
                    _ui.Outline(bxx, byy, box, box, MathF.Max(1f, UiScale), current ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
                    if (current)
                    {
                        _ui.Line(bxx + box * 0.22f, byy + box * 0.52f, bxx + box * 0.42f, byy + box * 0.72f, S(2), Rgba.Hex(0x06232A));
                        _ui.Line(bxx + box * 0.42f, byy + box * 0.72f, bxx + box * 0.8f, byy + box * 0.28f, S(2), Rgba.Hex(0x06232A));
                    }
                }
                _ui.TextWrapped(f.Body, x + S(10) + tick, ry + S(6), w - S(110) - tick, value.Label, UiTheme.TEXT, maxLines: 1);
                Text.Clear().AppendGrouped(value.Count);
                _ui.TextRight(f.Small, x + w - S(10), ry + S(8), Text.Span, UiTheme.TEXT_MUTED);
                if (hover && input.LeftPressed)
                {
                    input.ConsumeClicks();
                    Sound.Play(SoundId.UiClick);
                    picked = value;
                }
            }
            if (_clashPickerMatches.Count == 0) { _ui.Text(f.Body, x, cy + S(6), "Nothing in the model matches: TYPE A VALUE… instead.", UiTheme.TEXT_MUTED); }
            EndScroll(_clashPickerScroll, input, top + _clashPickerMatches.Count * rowH);
            w = pickerW;

            float by = bottom - S(34);
            bool typeValue, clear = false, back;
            if (multi)
            {
                float bw3 = (w - S(12)) / 3f;
                typeValue = SmallButton(f, input, x, by, bw3, S(32), "TYPE A VALUE…");
                clear = SmallButton(f, input, x + bw3 + S(6), by, bw3, S(32), "CLEAR");
                back = SmallButton(f, input, x + (bw3 + S(6)) * 2f, by, bw3, S(32), "DONE");
            }
            else
            {
                float bw2 = (w - S(6)) / 2f;
                typeValue = SmallButton(f, input, x, by, bw2, S(32), "TYPE A VALUE…");
                back = SmallButton(f, input, x + bw2 + S(6), by, bw2, S(32), "BACK");
            }

            if (picked != null)
            {
                if (multi)
                {
                    rule.ToggleValue(picked.Value.Value);
                    RefreshClashPickerHeader();
                }
                else
                {
                    rule.SetValues(new[] { picked.Value.Value });
                    _clashPickerRule = null;
                }
                ClashSetEdited();
            }
            else if (clear)
            {
                rule.SetValues(Array.Empty<string>());
                RefreshClashPickerHeader();
                ClashSetEdited();
            }
            else if (typeValue)
            {
                _clashPickerRule = null;
                string title = $"{SearchSets.FieldLabel(rule).ToUpperInvariant()} {RuleOp.Labels[Math.Max(0, RuleOp.IndexOf(rule.Operator))]}";
                BeginTextEdit(multi ? title + " (ADDS A VALUE)" : title, multi || rule.ValueCount == 0 ? string.Empty : rule.ValueAt(0), 80, text =>
                {
                    if (multi)
                    {
                        if (!rule.HasValue(text)) { rule.ToggleValue(text); }
                    }
                    else { rule.SetValues(new[] { text }); }
                    ClashSetEdited();
                });
            }
            else if (back) { _clashPickerRule = null; }
        }

        #endregion

        #region Labels

        private static uint StatusColour(string status) => status switch
        {
            ClashStatus.NEW => Rgba.Hex(0xF87171),
            ClashStatus.ACTIVE => Rgba.Hex(0xFB923C),
            ClashStatus.REVIEWED => Rgba.Hex(0xFCD34D),
            ClashStatus.APPROVED => Rgba.Hex(0x60A5FA),
            _ => Rgba.Hex(0x4ADE80)
        };

        /// <summary>
        /// Rebuilds the test and set labels when something changed (data or display units).
        /// </summary>
        private void RefreshClashRows()
        {
            if (_clashRowsUnits != UnitFormat.Revision) { _clashRowsDirty = true; }
            if (!_clashRowsDirty) { return; }
            _clashRowsDirty = false;
            _clashRowsUnits = UnitFormat.Revision;
            _clashRuleLabels.Clear();

            // Sets first (their sizes feed the test rows)
            _clashSetRows.Clear();
            var sizes = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (SearchSet set in _clashDocument.Sets)
            {
                List<int> members = SearchSets.ElementsIn(set, Scene);
                int linked = members.Count(i => Scene.Elements[i].IsLinked);
                int usedBy = _clashDocument.Tests.Count(t => t.SetA == set.Id || t.SetB == set.Id);
                sizes[set.Id] = members.Count;
                _clashSetRows.Add(new ClashSetRow
                {
                    Set = set,
                    Title = set.Name,
                    Elements = members.Count,
                    UsedBy = usedBy,
                    Detail = $"{members.Count:N0} elements{(linked > 0 ? $" ({linked:N0} in links)" : string.Empty)} · {set.AllRules().Count()} rule{(set.AllRules().Count() == 1 ? string.Empty : "s")}" +
                        (set.Groups?.Count > 0 ? $" in {set.Groups.Count} group{(set.Groups.Count == 1 ? string.Empty : "s")}" : string.Empty) +
                        (usedBy > 0 ? $" · used by {usedBy} test{(usedBy == 1 ? string.Empty : "s")}" : string.Empty)
                });
            }

            string state = ClashModelState();
            _clashTestRows.Clear();
            foreach (ClashTest test in _clashDocument.Tests)
            {
                SearchSet a = _clashDocument.FindSet(test.SetA), b = string.IsNullOrEmpty(test.SetB) ? null : _clashDocument.FindSet(test.SetB);
                string SetLabel(SearchSet s) => s == null ? "(missing set)" : $"{s.Name} ({(sizes.TryGetValue(s.Id, out int n) ? n : 0):N0})";
                bool changed = test.LastRunUtc != null && !string.Equals(test.LastRunModel, state, StringComparison.Ordinal);
                string when = test.LastRunUtc == null ? "Not run yet."
                    : changed ? (test.LastRunModel == "edited" ? "The test changed since its last run: RUN again." : "The model changed since the last run: RUN again.")
                    : $"Last run {test.LastRunUtc.Value.ToLocalTime():d MMM HH:mm}{(test.LastRunTruncated ? " (stopped at the limit: narrow the sets)" : string.Empty)}.";

                int[] counts = ClashMerge.CountByStatus(_clashDocument, test.Id);
                string countText = counts.Sum() == 0 ? "No clashes."
                    : string.Join(" · ", Enumerable.Range(0, counts.Length).Where(k => counts[k] > 0).Select(k => $"{counts[k]:N0} {ClashStatus.All[k]}"));
                string tolerance = UnitFormat.Length(test.Tolerance, 3);
                string kind = test.Kind == ClashKind.CLEARANCE ? $"clearance {tolerance}" : $"hard, ignore ≤ {tolerance}";

                // Polish round P-C: its groups (members found, status; "mixed" when members differ)
                var testRow = new ClashTestRow();
                Dictionary<string, ClashRecord> byId = null;
                foreach (ClashGroup group in ClashGroups.OfTest(_clashDocument, test.Id))
                {
                    byId ??= ClashGroups.ClashesById(_clashDocument);
                    ClashGroupSummary summary = ClashGroups.Summarise(group, byId);
                    string status = ClashStatus.Label(group.Status).ToUpperInvariant() + (summary.Mixed ? " · MIXED" : string.Empty);
                    testRow.Groups.Add((group, $"{ClashGroups.DisplayName(group)} · {group.Count:N0} clash{(group.Count == 1 ? string.Empty : "es")}", status));
                }
                string groupText = testRow.Groups.Count == 0 ? string.Empty : $" · {testRow.Groups.Count} group{(testRow.Groups.Count == 1 ? string.Empty : "s")}";

                testRow.Test = test;
                _clashTestRows.Add(testRow);
                testRow.Title = test.Name;
                testRow.Detail = changed ? $"{kind} · changed since the last run" : $"{kind} · {countText}{groupText}";
                testRow.SetA = SetLabel(a);
                testRow.SetB = string.IsNullOrEmpty(test.SetB) ? "(set A against itself)" : test.IsSelfTest ? SetLabel(b) + " · against itself" : SetLabel(b);
                testRow.Tolerance = tolerance;
                testRow.Counts = countText + groupText;
                testRow.LastRun = when;
                testRow.Changed = changed;
            }
        }

        #endregion
    }
}
