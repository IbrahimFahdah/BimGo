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
        }

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

        // C-B4: the set editor's lines (a group header has no rule; top-level rules have no group), reused per frame
        private readonly List<(RuleGroup Group, SetRule Rule)> _clashRuleLines = new();

        private bool _clashesOpen;
        private int _clashTab;
        private int _clashScroll, _clashRuleScroll;
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

        // The rule value picker (SETS tab, "is" rules)
        private SetRule _clashPickerRule;
        private List<RuleValue> _clashPickerValues;
        private readonly List<RuleValue> _clashPickerMatches = new();
        private readonly char[] _clashPickerSearch = new char[CLASH_SEARCH_MAX];
        private int _clashPickerSearchLength, _clashPickerScroll;
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
            _clashScroll = _clashRuleScroll = 0;
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
            if (_clashPickerRule != null)
            {
                _clashPickerRule = null;
                return true;
            }
            _clashesOpen = false;
            _clashListDirty = true;
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
            int width = _window.Width, height = _window.Height;
            BeginOverlays(input); // an open dropdown / confirm takes this frame's click
            _ui.Rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

            float w = MathF.Min(S(1100), width - S(48));
            float h = height - S(72);
            float x = (width - w) * 0.5f, y = S(36);
            _ui.Panel(x, y, w, h, UiTheme.CARD, UiTheme.CARD_BORDER);

            RefreshClashRows();
            float ix = x + S(24), iw = w - S(48);
            float cy = y + S(18);
            _ui.Text(f.Small, ix, cy + S(8), "CLASHES", UiTheme.ACCENT, S(2f));
            int tab = Segmented(f, input, ix + iw - S(260), cy, S(260), CLASH_TABS, _clashTab);
            if (tab != _clashTab)
            {
                _clashTab = tab;
                _clashScroll = _clashRuleScroll = 0;
                _clashPickerRule = null;
                _clashDeleteArmed = null;
                CloseOverlay();
            }
            cy += S(48);

            float buttonsY = y + h - S(24) - S(44);
            float lw = MathF.Min(S(400), iw * 0.42f);
            float rx = ix + lw + S(24), rw = iw - lw - S(24);
            float bottom = buttonsY - S(16);
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

            // Buttons (narrower in a small window so RESET ALL still fits before CLOSE)
            float gap = S(12), closeW = S(200);
            float bw = MathF.Min(S(170), (iw - closeW - gap * 5f) / 4f);
            float bx = ix;
            bool runAll = MenuButton(f, bx, buttonsY, bw, "RUN ALL", primary: true, danger: false, enabled: AnyClashTestEnabled(), height: S(44));
            bx += bw + gap;
            bool export = MenuButton(f, bx, buttonsY, bw, "EXPORT REPORT…", false, false, height: S(44));
            bx += bw + gap;
            bool import = MenuButton(f, bx, buttonsY, bw, "IMPORT REPORT…", false, false, height: S(44));
            bx += bw + gap;
            bool resetAll = MenuButton(f, bx, buttonsY, bw, "RESET ALL…", false, danger: true, height: S(44));
            bool close = MenuButton(f, ix + iw - closeW, buttonsY, closeW, _clashModeOn ? "← CLASH MODE" : "CLOSE", false, false, height: S(44));

            // The open dropdown / confirm, on top (a pick or confirm acts here)
            DrawOverlays(f, input, x, y, w, h);
            if (!_clashesOpen) { return; }

            // Actions after drawing (they open dialogs, the progress screen, a confirm or clash mode)
            if (close)
            {
                _clashPickerRule = null;
                CloseClashes();
                return;
            }
            if (run != null) { RequestClashRun(new[] { run }); return; }
            if (review != null) { EnterClashMode(null, review.Id); return; }
            if (runAll) { RequestClashRun(_clashDocument.Tests.Where(t => t.Enabled).ToList()); return; }
            if (export) { ExportClashReport(); return; }
            if (import) { ImportClashReport(); return; }
            if (resetAll) { RequestClashReset(_clashDocument.Tests); }
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
            int visible = Math.Max(1, (int)((listBottom - y) / rowH));
            int maxScroll = Math.Max(0, _clashTestRows.Count - visible);
            if (input.Wheel != 0 && Hover(input, x, y, w, listBottom - y)) { _clashScroll -= input.Wheel; }
            _clashScroll = Math.Clamp(_clashScroll, 0, maxScroll);

            int last = Math.Min(_clashTestRows.Count, _clashScroll + visible);
            for (int i = _clashScroll; i < last; i++)
            {
                ClashTestRow row = _clashTestRows[i];
                ClashTest test = row.Test;
                float ry = y + (i - _clashScroll) * rowH;
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
            if (maxScroll > 0)
            {
                Text.Clear().Append(_clashScroll + 1).Append('–').Append(last).Append(" of ").Append(_clashTestRows.Count);
                _ui.TextRight(f.Small, x + w, listBottom - S(16), Text.Span, UiTheme.TEXT_FAINT);
            }

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

            float labelW = S(110), cy = y;
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
            _ui.TextWrapped(f.Body, x, cy, w, row.Counts, UiTheme.TEXT_SOFT, maxLines: 2);

            // Buttons
            float by = bottom - S(34), bw = (w - S(24)) / 5f;
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
            _clashScroll = int.MaxValue;
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
            int visible = Math.Max(1, (int)((listBottom - y) / rowH));
            int maxScroll = Math.Max(0, _clashSetRows.Count - visible);
            if (input.Wheel != 0 && Hover(input, x, y, w, listBottom - y)) { _clashScroll -= input.Wheel; }
            _clashScroll = Math.Clamp(_clashScroll, 0, maxScroll);

            int last = Math.Min(_clashSetRows.Count, _clashScroll + visible);
            for (int i = _clashScroll; i < last; i++)
            {
                ClashSetRow row = _clashSetRows[i];
                float ry = y + (i - _clashScroll) * rowH;
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
                    _clashRuleScroll = 0;
                    _clashDeleteArmed = null;
                }
            }
            if (_clashSetRows.Count == 0) { _ui.Text(f.Body, x, y + S(6), "No sets yet: NEW SET.", UiTheme.TEXT_MUTED); }

            if (SmallButton(f, input, x, bottom - S(34), S(140), S(32), "NEW SET"))
            {
                var set = new SearchSet { Name = $"Set {_clashDocument.Sets.Count + 1}" };
                _clashDocument.Sets.Add(set);
                _clashSelectedSet = set.Id;
                _clashScroll = int.MaxValue;
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

            // C-B4: the lines: the set's own rules, then each group (a header, then its rules indented)
            _clashRuleLines.Clear();
            foreach (SetRule rule in set.Rules) { _clashRuleLines.Add((null, rule)); }
            foreach (RuleGroup group in set.Groups ?? Enumerable.Empty<RuleGroup>())
            {
                _clashRuleLines.Add((group, null));
                foreach (SetRule rule in group.Rules) { _clashRuleLines.Add((group, rule)); }
            }

            float footer = bottom - S(34) - S(52);
            float ruleH = S(38);
            int visible = Math.Max(1, (int)((footer - cy) / ruleH));
            int maxScroll = Math.Max(0, _clashRuleLines.Count - visible);
            if (input.Wheel != 0 && Hover(input, x, cy, w, footer - cy)) { _clashRuleScroll -= input.Wheel; }
            _clashRuleScroll = Math.Clamp(_clashRuleScroll, 0, maxScroll);
            SetRule remove = null;
            RuleGroup removeFrom = null, removeGroup = null, addTo = null;
            int last = Math.Min(_clashRuleLines.Count, _clashRuleScroll + visible);
            float indent = S(24);
            for (int i = _clashRuleScroll; i < last; i++)
            {
                (RuleGroup group, SetRule rule) = _clashRuleLines[i];
                float ry = cy + (i - _clashRuleScroll) * ruleH;
                if (rule == null)
                {
                    // Group header: "GROUP n", ANY OF / ALL OF, ADD RULE, ×
                    int number = set.Groups.IndexOf(group) + 1;
                    _ui.Rect(x, ry, w, S(32), Rgba.Hex(0x22D3EE, 0.07f));
                    _ui.Text(f.Bold, x + S(8), ry + S(8), number == 1 ? "GROUP 1" : "GROUP " + number, UiTheme.ACCENT);
                    float gx = x + S(90);
                    int gm = Segmented(f, input, gx, ry, S(190), CLASH_GROUP_MATCH, group.MatchAll ? 1 : 0);
                    if ((gm == 1) != group.MatchAll)
                    {
                        group.MatchAll = gm == 1;
                        ClashSetEdited();
                    }
                    float delW = S(32);
                    if (SmallButton(f, input, x + w - delW - S(6) - S(110), ry, S(110), S(32), "ADD RULE")) { addTo = group; }
                    if (SmallButton(f, input, x + w - delW, ry, delW, S(32), "×", danger: true)) { removeGroup = group; }
                    continue;
                }

                float rx = group == null ? x : x + indent;
                if (group != null) { _ui.Rect(x + S(8), ry, S(3), S(32), Rgba.Hex(0x22D3EE, 0.35f)); }
                if (BuildClashRuleRow(f, input, rule, rx, ry, group == null ? w : w - indent, inGroup: group != null))
                {
                    remove = rule;
                    removeFrom = group;
                }
            }
            if (_clashRuleLines.Count == 0) { _ui.Text(f.Body, x, cy + S(6), "No rules: every element is in this set. ADD RULE or ADD GROUP.", UiTheme.TEXT_MUTED); }
            else if (maxScroll > 0)
            {
                Text.Clear().Append(_clashRuleScroll + 1).Append('–').Append(last).Append(" of ").Append(_clashRuleLines.Count).Append(" lines (wheel scrolls)");
                _ui.TextRight(f.Small, x + w, footer - S(4), Text.Span, UiTheme.TEXT_FAINT);
            }
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
            if (removeGroup != null)
            {
                RuleGroup target = removeGroup;
                if (target.Rules.Count == 0) { RemoveClashGroup(set, target); }
                else
                {
                    OpenConfirm("DELETE GROUP", $"Delete group {set.Groups.IndexOf(target) + 1} and its {target.Rules.Count} rule{(target.Rules.Count == 1 ? string.Empty : "s")}?",
                        "DELETE", danger: true, offerSkip: false, ok => { if (ok) { RemoveClashGroup(set, target); } });
                }
            }

            // Count, then buttons
            _ui.TextWrapped(f.Body, x, footer + S(10), w, row.Detail, UiTheme.TEXT_SOFT, maxLines: 1);
            float by = bottom - S(34), bw = (w - S(18)) / 4f;
            if (SmallButton(f, input, x, by, bw, S(32), "ADD RULE"))
            {
                // A row to fill in: BimGo category, IS, nothing picked (left out of matching until it has a value)
                set.Rules.Add(new SetRule { Field = RuleField.CATALOG, Op = RuleOp.IS }.Normalise());
                _clashRuleScroll = set.Rules.Count; // the new rule sits before the groups
                ClashSetEdited();
            }
            if (SmallButton(f, input, x + bw + S(6), by, bw, S(32), "ADD GROUP"))
            {
                // C-B4: a group (ALL OF, one rule to fill in) at the end; with the set on ANY, groups read as OR of ANDs
                set.Groups ??= new List<RuleGroup>();
                var group = new RuleGroup { MatchAll = true };
                group.Rules.Add(new SetRule { Field = RuleField.CATALOG, Op = RuleOp.IS }.Normalise());
                set.Groups.Add(group);
                _clashRuleScroll = int.MaxValue;
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

            // Field
            if (DropdownButton(f, input, bx, ry, fieldW, S(32), fieldLabel, IsDropdownOpen(rule, DROP_RULE_FIELD)))
            {
                SetRule target = rule;
                OpenDropdown(rule, DROP_RULE_FIELD, bx, ry, fieldW, S(32), CLASH_FIELD_LABELS, Array.IndexOf(RuleField.All, RuleField.Normalise(rule.Field)), k =>
                {
                    if (RuleField.All[k] == RuleField.Normalise(target.Field)) { return; }
                    target.SetField(RuleField.All[k]);
                    ClashSetEdited();
                });
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
                else { OpenClashValuePicker(rule); }
            }
            bx += valueW + g;
            return SmallButton(f, input, bx, ry, delW, S(32), "×", danger: true);
        }

        /// <summary>C-B4: removes a group (the set's groups go back to null when none is left).</summary>
        private void RemoveClashGroup(SearchSet set, RuleGroup group)
        {
            if (set.Groups == null || !set.Groups.Remove(group)) { return; }
            if (set.Groups.Count == 0) { set.Groups = null; }
            ClashSetEdited();
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
                labels = (SearchSets.FieldLabel(rule.Field).ToUpperInvariant(), RuleOp.Labels[Math.Max(0, RuleOp.IndexOf(rule.Operator))], ClashRuleValueLabel(rule));
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
            BeginTextEdit($"{SearchSets.FieldLabel(rule.Field).ToUpperInvariant()} {RuleOp.Labels[Math.Max(0, RuleOp.IndexOf(rule.Operator))]}",
                rule.ValueCount > 0 ? rule.ValueAt(0) : string.Empty, 80, text =>
            {
                rule.SetValues(new[] { text });
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
            _clashPickerValues = SearchSets.ValuesOf(Scene, rule.Field);
            _clashPickerSearchLength = 0;
            _clashPickerScroll = 0;
            _clashPickerDirty = true;
            RefreshClashPickerHeader();
        }

        /// <summary>The picker's heading (rebuilt when a tick changes, not per frame).</summary>
        private void RefreshClashPickerHeader()
        {
            SetRule rule = _clashPickerRule;
            if (rule == null) { return; }
            string field = SearchSets.FieldLabel(rule.Field).ToUpperInvariant();
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
                _clashPickerScroll = 0;
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
            int visible = Math.Max(1, (int)((listBottom - cy) / rowH));
            int maxScroll = Math.Max(0, _clashPickerMatches.Count - visible);
            if (input.Wheel != 0) { _clashPickerScroll -= input.Wheel * 3; }
            _clashPickerScroll = Math.Clamp(_clashPickerScroll, 0, maxScroll);
            RuleValue? picked = null;
            int last = Math.Min(_clashPickerMatches.Count, _clashPickerScroll + visible);
            float tick = multi ? S(28) : 0f;
            for (int i = _clashPickerScroll; i < last; i++)
            {
                RuleValue value = _clashPickerMatches[i];
                float ry = cy + (i - _clashPickerScroll) * rowH;
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
                string title = $"{SearchSets.FieldLabel(rule.Field).ToUpperInvariant()} {RuleOp.Labels[Math.Max(0, RuleOp.IndexOf(rule.Operator))]}";
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

                _clashTestRows.Add(new ClashTestRow
                {
                    Test = test,
                    Title = test.Name,
                    Detail = changed ? $"{kind} · changed since the last run" : $"{kind} · {countText}",
                    SetA = SetLabel(a),
                    SetB = string.IsNullOrEmpty(test.SetB) ? "(set A against itself)" : test.IsSelfTest ? SetLabel(b) + " · against itself" : SetLabel(b),
                    Tolerance = tolerance,
                    Counts = countText,
                    LastRun = when,
                    Changed = changed
                });
            }
        }

        #endregion
    }
}
