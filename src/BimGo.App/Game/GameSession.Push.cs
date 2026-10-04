using BimGo.Audio;
using BimGo.Edits;
using BimGo.Live;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Pushing a standalone file's edits into the live Revit model it came from (pause menu → PUSH TO REVIT).
    ///
    /// Flow: find a live session whose model key matches the file → dry run (Revit applies everything inside a
    /// transaction group, reports, rolls back) → preview panel → push for real (one undo step in Revit) → report.
    /// Applied entries are marked in the journal (the file becomes dirty; Save keeps it), so they are never sent
    /// again. Conflicts (moved in Revit since the file was made) are skipped unless "apply anyway" is ticked.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Types and fields

        /// <summary>Where the push panel is.</summary>
        private enum PushState
        {
            Closed,
            Error,
            Checking,
            Preview,
            Applying,
            Done
        }

        /// <summary>One report row (strings built once when the answer arrives).</summary>
        private sealed class PushRow
        {
            public int Seq;
            public string Number;
            public string Label;
            public string Status;
            public string StatusText;
            public string Message;
            public uint Colour;
        }

        private PushState _pushState = PushState.Closed;
        private JournalPush _push;
        private JournalResultPayload _pushResult;
        private readonly List<PushRow> _pushRows = new();
        private string _pushTitle;
        private string _pushMessage;
        private string _pushSummary;
        private string _pushButtonLabel;
        private string _pushPhaseLine;
        private bool _pushApplyConflicts;
        private int _pushScroll;
        private int _pushSent;

        #endregion

        #region State

        /// <summary>True while the push panel is showing (it replaces the pause menu).</summary>
        private bool IsPushPanelOpen => _pushState != PushState.Closed;

        /// <summary>
        /// True if this is a file with edits not yet in Revit that came from the given model (the app uses it to
        /// word the "switch model?" prompt when that model's Go arrives).
        /// </summary>
        public bool HasPushableEditsFor(string modelKey)
        {
            if (!IsFileMode || string.IsNullOrWhiteSpace(modelKey)) { return false; }
            string fileKey = Scene.Provenance?.ModelKey;
            return !string.IsNullOrWhiteSpace(fileKey)
                && string.Equals(fileKey, modelKey, StringComparison.OrdinalIgnoreCase)
                && _journal.CountNotInRevit() > 0;
        }

        #endregion

        #region Flow

        /// <summary>
        /// Opens the push panel and starts the dry run (or explains why it can't).
        /// </summary>
        private void OpenPush()
        {
            _pushScroll = 0;
            _pushRows.Clear();
            _pushResult = null;
            _pushTitle = "PUSH TO REVIT";
            _pushPhaseLine = PhaseLine(null);

            int pending = _journal.CountNotInRevit();
            if (pending == 0)
            {
                ShowPushError(_journal.Count == 0 ? "This file has no edits to push." : "Every edit in this file is already in Revit.");
                return;
            }

            string modelKey = Scene.Provenance?.ModelKey;
            if (string.IsNullOrWhiteSpace(modelKey))
            {
                ShowPushError("This file doesn't record which Revit model it came from (it was made by an older add-in). Export it again from Revit to push edits.");
                return;
            }

            List<SessionInfo> sessions = JournalPush.FindSessions(modelKey);
            if (sessions.Count == 0)
            {
                string title = string.IsNullOrWhiteSpace(Scene.Provenance?.ModelTitle) ? Scene.ModelTitle : Scene.Provenance.ModelTitle;
                ShowPushError($"Open {title} in Revit and press Go (answer No when BimGo asks to switch), then push again.\n\n" +
                    "Only the model this file was exported from can take its edits.");
                return;
            }

            // Several sessions of the same model (unlikely: two Revit instances) → the newest
            _push?.Dispose();
            _push = new JournalPush(sessions[0]);
            SendPush(dryRun: true);
        }

        /// <summary>
        /// Sends the dry run or the real push.
        /// </summary>
        private void SendPush(bool dryRun)
        {
            if (_push == null) { return; }

            JournalApplyPayload request = JournalPush.BuildRequest(_journal, dryRun, _pushApplyConflicts, Scene.Provenance?.ModelKey,
                Scene.ExistingPhaseName, Scene.PhaseName, DocumentName);
            _pushSent = request.Entries.Count;

            string error = _push.Send(request);
            if (error != null)
            {
                ShowPushError($"Could not reach Revit: {error}");
                return;
            }

            _pushState = dryRun ? PushState.Checking : PushState.Applying;
            _pushMessage = null;
        }

        /// <summary>
        /// Per frame: takes Revit's answer when it arrives.
        /// </summary>
        private void UpdatePush(float dt)
        {
            if (_push == null || !_push.Waiting) { return; }
            if (!_push.Poll(dt, out JournalResultPayload result, out string error)) { return; }

            if (error != null)
            {
                ShowPushError(_pushState == PushState.Applying
                    ? $"{error}\n\nThe push may still have reached Revit: check the model there (and its undo list) before pushing again."
                    : error);
                return;
            }

            _pushResult = result;
            if (!result.Success)
            {
                ShowPushError($"Revit refused the push: {result.Message}");
                return;
            }

            BuildPushRows(result);
            if (result.DryRun)
            {
                _pushState = PushState.Preview;
                _pushTitle = "PUSH TO REVIT · PREVIEW";
                return;
            }

            MarkPushed(result);
            _pushState = PushState.Done;
            _pushTitle = "PUSH TO REVIT · DONE";
            Sound.Play(result.Applied > 0 ? SoundId.Commit : SoundId.Error);
        }

        /// <summary>
        /// Records a real push in the journal: applied (and already-present) entries are marked, clones get their
        /// Revit ids. The file is now dirty.
        /// </summary>
        private void MarkPushed(JournalResultPayload result)
        {
            int marked = 0;
            foreach (JournalEntryResult entryResult in result.Results)
            {
                if (entryResult.Status != JournalStatus.APPLIED && entryResult.Status != JournalStatus.ALREADY_APPLIED) { continue; }
                if (!_journal.MarkApplied(entryResult.Seq, entryResult.NewElementId)) { continue; }
                marked++;

                // The walkthrough's clone now has a Revit element
                if (entryResult.NewElementId <= 0) { continue; }
                JournalEntry entry = _journal.Entries[entryResult.Seq - 1];
                foreach (DynamicInstance instance in Dynamics.Instances)
                {
                    if (instance.IsClone && instance.CloneKey == entry.NewCloneKey) { instance.RevitId = entryResult.NewElementId; }
                }
            }
            UpdateTitle();
            Utilities.Log_Utils.Write($"Push: {marked} journal entries marked as in Revit.");
        }

        /// <summary>
        /// Shows a message in the panel instead of a report.
        /// </summary>
        private void ShowPushError(string message)
        {
            _push?.Abandon();
            _pushState = PushState.Error;
            _pushMessage = message;
            _pushRows.Clear();
            Sound.Play(SoundId.Error);
        }

        /// <summary>
        /// Closes the panel (not while a real push is in flight: its answer must be recorded).
        /// </summary>
        /// <returns>True if the panel was open.</returns>
        private bool ClosePush()
        {
            if (_pushState == PushState.Closed) { return false; }
            if (_pushState == PushState.Applying) { return true; }

            _push?.Dispose();
            _push = null;
            _pushState = PushState.Closed;
            _pushRows.Clear();
            _pushResult = null;
            return true;
        }

        #endregion

        #region Report

        /// <summary>
        /// Builds the report rows and the summary line from an answer.
        /// </summary>
        private void BuildPushRows(JournalResultPayload result)
        {
            _pushRows.Clear();
            _pushScroll = 0;
            foreach (JournalEntryResult entryResult in result.Results)
            {
                JournalEntry entry = entryResult.Seq >= 1 && entryResult.Seq <= _journal.Count ? _journal.Entries[entryResult.Seq - 1] : null;
                _pushRows.Add(new PushRow
                {
                    Seq = entryResult.Seq,
                    Number = "#" + entryResult.Seq,
                    Label = string.IsNullOrWhiteSpace(entry?.Label) ? entry?.Op ?? "edit" : entry.Label,
                    Status = entryResult.Status,
                    StatusText = PushStatusText(entryResult.Status, result.DryRun),
                    Message = entryResult.Message ?? string.Empty,
                    Colour = PushStatusColour(entryResult.Status)
                });
            }

            string verb = result.DryRun ? "will apply" : "applied";
            var parts = new List<string> { $"{result.Applied} {verb}" };
            if (result.Conflicts > 0) { parts.Add($"{result.Conflicts} conflict{(result.Conflicts == 1 ? string.Empty : "s")}"); }
            if (result.Skipped > 0) { parts.Add($"{result.Skipped} skipped"); }
            if (result.Failed > 0) { parts.Add($"{result.Failed} failed"); }
            if (result.AlreadyApplied > 0) { parts.Add($"{result.AlreadyApplied} already in Revit"); }
            _pushSummary = string.Join(" · ", parts);
            _pushMessage = result.Message;
            _pushButtonLabel = result.Applied == 0 ? "NOTHING TO PUSH" : result.Applied == 1 ? "PUSH 1 EDIT" : $"PUSH {result.Applied} EDITS";
            _pushPhaseLine = PhaseLine(result);
        }

        private static string PushStatusText(string status, bool dryRun) => status switch
        {
            JournalStatus.APPLIED => dryRun ? "WILL APPLY" : "APPLIED",
            JournalStatus.CONFLICT => "CONFLICT",
            JournalStatus.FAILED => dryRun ? "WILL FAIL" : "FAILED",
            JournalStatus.ALREADY_APPLIED => "IN REVIT",
            _ => "SKIPPED"
        };

        private static uint PushStatusColour(string status) => status switch
        {
            JournalStatus.APPLIED => UiTheme.GOOD,
            JournalStatus.CONFLICT => UiTheme.MEASURE,
            JournalStatus.FAILED => UiTheme.DANGER,
            JournalStatus.ALREADY_APPLIED => UiTheme.TEXT_MUTED,
            _ => UiTheme.HAMMER
        };

        /// <summary>
        /// Writes the report as CSV (Excel-friendly, UTF-8 with BOM).
        /// </summary>
        private void ExportPushReport()
        {
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            string name = Path.GetFileNameWithoutExtension(DocumentName) + " push report.csv";
            string path = FileDialogs.ShowSave(_window.Handle, "Save push report", "CSV file (*.csv)|*.csv|All files (*.*)|*.*", SuggestedFolder(), name, ".csv");
            if (path == null) { return; }

            try
            {
                var lines = new List<string> { "Edit,Description,Status,Message,New element id" };
                foreach (PushRow row in _pushRows)
                {
                    long newId = _pushResult?.Results.FirstOrDefault(r => r.Seq == row.Seq)?.NewElementId ?? 0;
                    lines.Add(string.Join(",", row.Seq.ToString(), Csv(row.Label), Csv(row.StatusText), Csv(row.Message), newId > 0 ? newId.ToString() : string.Empty));
                }
                File.WriteAllLines(path, lines, new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: true));
                _pushMessage = $"Report saved: {Path.GetFileName(path)}";
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Push report failed: {ex}");
                _pushMessage = $"The report could not be saved: {ex.Message}";
            }
        }

        /// <summary>
        /// Quotes a CSV field when needed.
        /// </summary>
        private static string Csv(string value)
        {
            value ??= string.Empty;
            bool quote = value.IndexOfAny(new[] { ',', '"', '\n', '\r' }) >= 0;
            return quote ? "\"" + value.Replace("\"", "\"\"") + "\"" : value;
        }

        #endregion

        #region Panel

        /// <summary>
        /// Draws and handles the push panel (in place of the pause menu).
        /// </summary>
        private void BuildPushPanel()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            int width = _window.Width, height = _window.Height;
            _ui.Rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

            float w = MathF.Min(S(920), width - S(80));
            float h = height - S(96);
            float x = (width - w) * 0.5f, y = S(48);
            _ui.Panel(x, y, w, h, UiTheme.CARD, UiTheme.CARD_BORDER);

            float ix = x + S(24), iw = w - S(48);
            float cy = y + S(20);
            _ui.Text(f.Small, ix, cy, _pushTitle ?? "PUSH TO REVIT", UiTheme.TEXT_MUTED, S(2f));
            cy += S(22);

            // Target line: model · Revit version · phases
            if (_push != null)
            {
                SessionInfo session = _push.Session;
                Text.Clear().Append(string.IsNullOrWhiteSpace(session.DocTitle) ? "Revit model" : session.DocTitle)
                    .Append(" · Revit ").Append(session.RevitVersion ?? string.Empty);
                if (_pushPhaseLine != null) { Text.Append(" · ").Append(_pushPhaseLine); }
                _ui.TextWrapped(f.Bold, ix, cy, iw, Text.Span, UiTheme.TEXT, maxLines: 1);
                cy += S(26);
            }

            float buttonsY = y + h - S(24) - S(48);
            switch (_pushState)
            {
                case PushState.Error:
                    _ui.TextWrapped(f.Body, ix, cy + S(8), iw, _pushMessage ?? "Something went wrong.", UiTheme.TEXT_SOFT, maxLines: 10);
                    if (MenuButton(f, ix, buttonsY, S(200), "TRY AGAIN", primary: true, danger: false)) { OpenPush(); }
                    if (MenuButton(f, ix + S(216), buttonsY, S(160), "CLOSE", false, false)) { ClosePush(); }
                    break;

                case PushState.Checking:
                case PushState.Applying:
                    bool applying = _pushState == PushState.Applying;
                    Text.Clear().Append(applying ? "Pushing " : "Checking ").Append(_pushSent).Append(_pushSent == 1 ? " edit" : " edits")
                        .Append(applying ? " into Revit… " : " against the model (nothing changes yet)… ").Append(_push?.Waited ?? 0f, 0).Append(" s");
                    _ui.TextWrapped(f.Body, ix, cy + S(8), iw, Text.Span, UiTheme.TEXT_SOFT, maxLines: 2);
                    _ui.TextWrapped(f.Body, ix, cy + S(36), iw, "If Revit is in the middle of a command, finish or cancel it there.", UiTheme.TEXT_MUTED, maxLines: 2);
                    if (!applying && MenuButton(f, ix, buttonsY, S(160), "CANCEL", false, false)) { ClosePush(); }
                    break;

                case PushState.Preview:
                    BuildPushReport(f, input, ix, cy, iw, buttonsY - S(56));
                    BuildPreviewButtons(f, input, ix, iw, buttonsY);
                    break;

                case PushState.Done:
                    BuildPushReport(f, input, ix, cy, iw, buttonsY - S(16));
                    BuildDoneButtons(f, ix, buttonsY);
                    break;
            }
        }

        /// <summary>
        /// "Existing → New" for the target line (Revit's phases once known, else the file's), or null.
        /// </summary>
        private string PhaseLine(JournalResultPayload result)
        {
            string newPhase = result?.PhaseName ?? Scene.PhaseName;
            string existing = result?.PhaseName != null ? result.ExistingPhaseName : Scene.ExistingPhaseName;
            if (string.IsNullOrEmpty(newPhase)) { return null; }
            return string.IsNullOrEmpty(existing) ? newPhase : existing + " → " + newPhase;
        }

        /// <summary>
        /// Summary, note and the scrolling list of entries.
        /// </summary>
        private void BuildPushReport(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            _ui.Text(f.Bold, x, y, _pushSummary ?? string.Empty, UiTheme.ACCENT, S(0.6f));
            y += S(24);

            if (_pushState == PushState.Done && _pushResult?.UndoLabel != null)
            {
                Text.Clear().Append("One undo in Revit takes the whole push back: “").Append(_pushResult.UndoLabel).Append("”. Save this file to remember what was pushed.");
                _ui.TextWrapped(f.Body, x, y, w, Text.Span, UiTheme.TEXT_SOFT, maxLines: 2);
                y += S(40);
            }
            if (!string.IsNullOrEmpty(_pushMessage))
            {
                _ui.TextWrapped(f.Body, x, y, w, _pushMessage, UiTheme.MEASURE_TEXT, maxLines: 2);
                y += S(40);
            }

            // Rows (only the visible ones are drawn; the wheel scrolls)
            float rowH = S(42);
            int visible = Math.Max(1, (int)((bottom - y) / rowH));
            int maxScroll = Math.Max(0, _pushRows.Count - visible);
            if (input.Wheel != 0) { _pushScroll = Math.Clamp(_pushScroll - input.Wheel * 3, 0, maxScroll); }
            _pushScroll = Math.Clamp(_pushScroll, 0, maxScroll);

            float chipW = S(96);
            for (int i = _pushScroll; i < _pushRows.Count && i < _pushScroll + visible; i++)
            {
                PushRow row = _pushRows[i];
                float ry = y + (i - _pushScroll) * rowH;
                if (((i - _pushScroll) & 1) == 0) { _ui.Rect(x - S(8), ry - S(4), w + S(16), rowH, Rgba.Hex(0xFFFFFF, 0.03f)); }

                _ui.Panel(x, ry + S(2), chipW, S(20), Rgba.WithAlpha(row.Colour, 0.16f), Rgba.WithAlpha(row.Colour, 0.6f));
                _ui.TextCentred(f.Small, x + chipW * 0.5f, ry + S(6), row.StatusText, row.Colour, S(0.8f));

                _ui.Text(f.Mono, x + chipW + S(12), ry + S(3), row.Number, UiTheme.TEXT_FAINT);
                _ui.TextWrapped(f.Body, x + chipW + S(60), ry + S(1), w - chipW - S(60), row.Label, UiTheme.TEXT, maxLines: 1);
                _ui.TextWrapped(f.Small, x + chipW + S(60), ry + S(20), w - chipW - S(60), row.Message, UiTheme.TEXT_MUTED, maxLines: 1);
            }

            if (maxScroll > 0)
            {
                Text.Clear().Append(_pushScroll + 1).Append('–').Append(Math.Min(_pushRows.Count, _pushScroll + visible)).Append(" of ").Append(_pushRows.Count).Append(" · wheel to scroll");
                _ui.TextRight(f.Small, x + w, bottom + S(2), Text.Span, UiTheme.TEXT_FAINT);
            }
        }

        /// <summary>
        /// Preview: apply-conflicts toggle (re-checks), push and cancel.
        /// </summary>
        private void BuildPreviewButtons(FontAtlas f, InputState input, float x, float w, float buttonsY)
        {
            int conflicts = _pushResult?.Conflicts ?? 0;
            if (conflicts > 0 || _pushApplyConflicts)
            {
                bool applyConflicts = Checkbox(f, input, x, buttonsY - S(36), w,
                    "Apply conflicting edits anyway, from where the elements are in Revit now", _pushApplyConflicts);
                if (applyConflicts != _pushApplyConflicts)
                {
                    // The preview must show what the real push will do: check again with the new choice
                    _pushApplyConflicts = applyConflicts;
                    SendPush(dryRun: true);
                    return;
                }
            }

            int toApply = _pushResult?.Applied ?? 0;
            if (MenuButton(f, x, buttonsY, S(240), _pushButtonLabel ?? "PUSH", primary: true, danger: false, enabled: toApply > 0)) { SendPush(dryRun: false); }
            if (MenuButton(f, x + S(256), buttonsY, S(160), "CANCEL", false, false)) { ClosePush(); }
        }

        /// <summary>
        /// Done: save, export the report, close.
        /// </summary>
        private void BuildDoneButtons(FontAtlas f, float x, float buttonsY)
        {
            float bx = x;
            if (IsDirty)
            {
                if (MenuButton(f, bx, buttonsY, S(160), "SAVE", primary: true, danger: false)) { Save(saveAs: false); }
                bx += S(176);
            }
            if (MenuButton(f, bx, buttonsY, S(220), "EXPORT REPORT…", false, false)) { ExportPushReport(); }
            bx += S(236);
            if (MenuButton(f, bx, buttonsY, S(160), "CLOSE", false, false)) { ClosePush(); }
        }

        #endregion
    }
}
