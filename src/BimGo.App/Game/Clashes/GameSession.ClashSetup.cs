using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Platform;
using BimGo.Rendering;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// QOL round: EXPORT / IMPORT TESTS… and SETS… in the Clashes panel (the clash report moved to clash mode's
    /// REPORT… dropdown). An import that meets taken names or links / levels this model doesn't have opens a
    /// reconcile card in the panel first: one choice for the taken names, and a replacement per missing value.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>The import waiting on the reconcile card, or null.</summary>
        private ClashSetupPlan _clashImport;

        // The card's file name, choices for each missing value (values here, labels) and scroll
        private string _clashImportName;
        private List<string> _clashImportLinkValues, _clashImportLinkLabels, _clashImportLevelValues;
        private readonly ScrollRegion _clashImportScroll = new();

        /// <summary>The taken-name choice (ClashNameClash order).</summary>
        private static readonly string[] CLASH_NAME_OPTIONS = { "REPLACE", "KEEP BOTH", "SKIP" };

        /// <summary>The first two choices of every missing value's dropdown.</summary>
        private const string KEEP_VALUE = "(leave as it is)", DROP_VALUE = "(remove from the rules)";

        /// <summary>Dropdown slot base for the card's rows (one per missing value).</summary>
        private const int DROP_IMPORT_ROW = 100;

        #endregion

        #region Export / import

        /// <summary>
        /// EXPORT TESTS… / EXPORT SETS…: every test (with the sets it uses) or every set, to a file.
        /// </summary>
        private void ExportClashSetup(ClashSetupKind kind)
        {
            EnsureClashes();
            bool tests = kind == ClashSetupKind.Tests;
            if (tests ? _clashDocument.Tests.Count == 0 : _clashDocument.Sets.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast(tests ? "No tests to export yet" : "No sets to export yet", 2.5f);
                return;
            }
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            string name = SafeFileName(Scene.ModelTitle) + (tests ? " clash tests" : " search sets") + ClashSetupFiles.EXTENSION;
            string path = FileDialogs.ShowSave(_window.Handle, tests ? "Export clash tests" : "Export search sets",
                tests ? ClashSetupFiles.TESTS_FILTER : ClashSetupFiles.SETS_FILTER, SuggestedFolder(), name, ClashSetupFiles.EXTENSION);
            _window.Input.ReleaseAll();
            if (path == null) { return; }

            ClashSetupFile file = ClashSetupFiles.Build(_clashDocument, kind, Scene.Links, Scene.ModelTitle, $"BimGo {Program.Version}");
            if (ClashSetupFiles.Export(path, file, out string error))
            {
                Sound.Play(SoundId.Commit);
                Toast(tests ? $"{file.Tests.Count} tests and the {file.Sets.Count} sets they use saved: {Path.GetFileName(path)}"
                    : $"{file.Sets.Count} sets saved: {Path.GetFileName(path)}", 3.5f);
            }
            else
            {
                Sound.Play(SoundId.Error);
                Toast(error, 5f, important: true);
            }
        }

        /// <summary>
        /// IMPORT TESTS… / IMPORT SETS…: reads the file; straight in when nothing needs a decision, else the card.
        /// </summary>
        private void ImportClashSetup(ClashSetupKind kind)
        {
            EnsureClashes();
            bool tests = kind == ClashSetupKind.Tests;
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            string path = FileDialogs.ShowOpen(_window.Handle, tests ? "Import clash tests" : "Import search sets",
                tests ? ClashSetupFiles.TESTS_FILTER : ClashSetupFiles.SETS_FILTER, SuggestedFolder());
            _window.Input.ReleaseAll();
            if (path == null) { return; }

            ClashSetupFile file = ClashSetupFiles.Read(path, kind, out string error);
            if (file == null)
            {
                Sound.Play(SoundId.Error);
                Toast(error, 5f, important: true);
                return;
            }
            if (file.Sets.Count == 0 && file.Tests.Count == 0)
            {
                Toast("The file holds no tests or sets", 3f);
                return;
            }

            List<RuleValue> levels = SearchSets.ValuesOf(Scene, RuleField.LEVEL);
            ClashSetupPlan plan = ClashSetupFiles.Plan(file, _clashDocument, Scene.Links, levels.Select(l => l.Value));
            if (plan.NameClashes.Count == 0 && plan.Missing.Count == 0)
            {
                FinishClashImport(plan);
                return;
            }

            // Something to decide: the card (choices: leave, remove, then what this model has)
            _clashImport = plan;
            _clashImportName = Path.GetFileName(path);
            _clashImportScroll.Reset();
            List<RuleValue> links = SearchSets.ValuesOf(Scene, RuleField.LINK);
            _clashImportLinkValues = links.Select(l => l.Value).ToList();
            _clashImportLinkLabels = links.Select(l => l.Label).ToList();
            _clashImportLevelValues = levels.Where(l => l.Value.Length > 0).Select(l => l.Value).ToList();
            _clashPickerRule = null;
            CloseOverlay();
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>
        /// Applies the import and says what it did.
        /// </summary>
        private void FinishClashImport(ClashSetupPlan plan)
        {
            _clashImport = null;
            ClashSetupResult r = ClashSetupFiles.Apply(plan, _clashDocument);
            ClashSetupChanged();
            Sound.Play(SoundId.Commit);
            var parts = new List<string>();
            if (r.TestsAdded > 0) { parts.Add($"{r.TestsAdded} tests added"); }
            if (r.TestsReplaced > 0) { parts.Add($"{r.TestsReplaced} tests replaced"); }
            if (r.SetsAdded > 0) { parts.Add($"{r.SetsAdded} sets added"); }
            if (r.SetsReplaced > 0) { parts.Add($"{r.SetsReplaced} sets replaced"); }
            if (r.Skipped > 0) { parts.Add($"{r.Skipped} skipped"); }
            if (r.ValuesChanged > 0) { parts.Add($"{r.ValuesChanged} link / level values changed"); }
            string from = string.IsNullOrEmpty(plan.File.ModelTitle) ? string.Empty : $" from {plan.File.ModelTitle}";
            Toast(parts.Count == 0 ? "Nothing new to import" : $"Imported{from}: {string.Join(", ", parts)}. Run the tests to see their clashes.", 5f);
        }

        /// <summary>Esc / CANCEL on the card.</summary>
        private bool CancelClashImport()
        {
            if (_clashImport == null) { return false; }
            _clashImport = null;
            CloseOverlay();
            Toast("Import cancelled", 1.5f);
            return true;
        }

        #endregion

        #region Card

        /// <summary>
        /// The reconcile card (in the panel's body): the taken-name choice and one row per missing link / level.
        /// </summary>
        private void BuildClashImportCard(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            ClashSetupPlan plan = _clashImport;
            bool tests = plan.File.Kind == ClashSetupKind.Tests;
            float cy = y;
            _ui.Text(f.Bold, x, cy, tests ? "IMPORT TESTS" : "IMPORT SETS", UiTheme.TEXT, S(1.2f));
            Text.Clear().Append(_clashImportName);
            if (!string.IsNullOrEmpty(plan.File.ModelTitle)) { Text.Append(" · from ").Append(plan.File.ModelTitle); }
            Text.Append(" · ").Append(plan.File.Tests.Count).Append(" tests, ").Append(plan.File.Sets.Count).Append(" sets");
            _ui.TextRight(f.Small, x + w, cy + S(3), Text.Span, UiTheme.TEXT_MUTED);
            cy += S(34);

            if (plan.NameClashes.Count > 0)
            {
                string names = string.Join(", ", plan.NameClashes.Take(4)) + (plan.NameClashes.Count > 4 ? $" and {plan.NameClashes.Count - 4} more" : string.Empty);
                cy += _ui.TextWrapped(f.Body, x, cy, w, $"Already here: {names}.", UiTheme.TEXT_SOFT, maxLines: 2) + S(6);
                int choice = Segmented(f, input, x, cy, MathF.Min(w, S(420)), CLASH_NAME_OPTIONS, (int)plan.OnNameClash);
                plan.OnNameClash = (ClashNameClash)choice;
                string help = plan.OnNameClash switch
                {
                    ClashNameClash.Replace => tests ? "Their definitions are overwritten; their clashes stay (re-run them)." : "Their rules are overwritten.",
                    ClashNameClash.KeepBoth => "The imported ones are added as “Name (2)”.",
                    _ => "The imported ones with these names are left out."
                };
                _ui.Text(f.Small, x + MathF.Min(w, S(420)) + S(12), cy + S(9), help, UiTheme.TEXT_MUTED);
                cy += S(46);
            }

            if (plan.Missing.Count == 0)
            {
                _ui.Text(f.Body, x, cy, "Every link and level the rules name is in this model.", UiTheme.TEXT_MUTED);
                return;
            }

            _ui.Text(f.Small, x, cy, "NOT IN THIS MODEL: PICK WHAT EACH BECOMES", UiTheme.TEXT_MUTED, S(1.6f));
            cy += S(24);
            float rowH = S(38);
            float top = BeginScroll(_clashImportScroll, input, x, cy, w, bottom - cy, out w);
            float labelW = w * 0.45f;
            VisibleRows(_clashImportScroll, rowH, plan.Missing.Count, out int first, out int last);
            for (int index = first; index < last; index++)
            {
                cy = top + index * rowH;
                ClashSetupMissing m = plan.Missing[index];
                bool link = m.Field == RuleField.LINK;
                Text.Clear().Append(link ? "Link  " : "Level  ").Append(m.Label);
                if (m.Uses > 1) { Text.Append("  (").Append(m.Uses).Append(" rules)"); }
                _ui.TextWrapped(f.Body, x, cy + S(7), labelW - S(10), Text.Span, UiTheme.TEXT, maxLines: 1);

                List<string> values = link ? _clashImportLinkValues : _clashImportLevelValues;
                List<string> labels = link ? _clashImportLinkLabels : _clashImportLevelValues;
                string current = m.Replacement == null ? KEEP_VALUE
                    : m.Replacement == ClashSetupFiles.DROP ? DROP_VALUE
                    : LabelOf(values, labels, m.Replacement) + (m.AutoMatched ? "  (matched by name)" : string.Empty);
                float dx = x + labelW, dw = w - labelW;
                if (DropdownButton(f, input, dx, cy, dw, S(30), current, IsDropdownOpen(_clashImport, DROP_IMPORT_ROW + index)))
                {
                    var choices = new List<string>(labels.Count + 2) { KEEP_VALUE, DROP_VALUE };
                    choices.AddRange(labels);
                    int selected = m.Replacement == null ? 0 : m.Replacement == ClashSetupFiles.DROP ? 1 : 2 + values.FindIndex(v => string.Equals(v, m.Replacement, StringComparison.OrdinalIgnoreCase));
                    ClashSetupMissing target = m;
                    OpenDropdown(_clashImport, DROP_IMPORT_ROW + index, dx, cy, dw, S(30), choices, selected, i =>
                    {
                        target.AutoMatched = false;
                        target.Replacement = i == 0 ? null : i == 1 ? ClashSetupFiles.DROP : values[i - 2];
                    });
                }
            }
            EndScroll(_clashImportScroll, input, top + plan.Missing.Count * rowH);

            static string LabelOf(List<string> values, List<string> labels, string value)
            {
                int i = values.FindIndex(v => string.Equals(v, value, StringComparison.OrdinalIgnoreCase));
                return i >= 0 ? labels[i] : value;
            }
        }

        #endregion
    }
}
