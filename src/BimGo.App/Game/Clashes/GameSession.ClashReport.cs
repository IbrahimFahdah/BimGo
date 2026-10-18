using System.Diagnostics;
using System.Text;
using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Format;
using BimGo.Platform;
using BimGo.Rendering;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Clash reports (Round C, build C-C3; Core <see cref="ClashReports"/>). REPORT… → EXPORT REPORT (HTML / XML)… opens
    /// a card in the dock (in place of the clash card): <b>scope</b> (what the list shows, the selection, this test, all
    /// tests), <b>format</b> (HTML + XML, HTML, XML), <b>pictures</b> on / off and <b>groups</b> (sections with their members,
    /// compact: one item each, or ignored), then EXPORT… asks where to save. With pictures, each group and clash is framed
    /// and rendered at 1280 × 720 and stored at 960 × 540 (a few per frame, progress and CANCEL in the card; the view and
    /// box settings as they are on screen), then the files are written (the XML beside the HTML, same name) and the HTML
    /// opens in the browser. The BimGo JSON report (EXPORT / IMPORT) is unchanged.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private const int REPORT_SCOPE_SHOWN = 0, REPORT_SCOPE_SELECTION = 1, REPORT_SCOPE_TEST = 2, REPORT_SCOPE_ALL = 3;
        private const int REPORT_FORMAT_BOTH = 0, REPORT_FORMAT_HTML = 1, REPORT_FORMAT_XML = 2;
        private const int REPORT_PICTURE_W = 960, REPORT_PICTURE_H = 540;
        private const long REPORT_JPEG_QUALITY = 78L;

        /// <summary>Above this many pictures the export asks first (time and file size).</summary>
        private const int REPORT_PICTURES_WARN = 300;

        private const int DROP_DOCK_REPORT_SCOPE = 21, DROP_DOCK_REPORT_FORMAT = 22, DROP_DOCK_REPORT_GROUPS = 23;

        private static readonly string[] REPORT_FORMAT_LABELS = { "FORMAT: HTML + XML", "FORMAT: HTML", "FORMAT: XML" };
        private static readonly string[] REPORT_GROUP_LABELS = { "GROUPS: SECTIONS (MEMBERS LISTED)", "GROUPS: COMPACT (ONE ITEM EACH)", "GROUPS: IGNORED (EVERY CLASH)" };

        // The card and its choices (kept for the session)
        private bool _clashReportCardOpen;
        private int _clashReportScope = REPORT_SCOPE_SHOWN, _clashReportFormat = REPORT_FORMAT_BOTH, _clashReportGroups = ClashReportGroups.SECTIONS;
        private bool _clashReportPictures = true;
        private string _clashReportScopeLabel;
        private int _clashReportLabelScope = -1, _clashReportLabelCount = -1;

        /// <summary>An export in progress: what it holds, the pictures still to render, where it goes.</summary>
        private sealed class ClashReportJob
        {
            public List<ClashRecord> Clashes;
            public List<ClashReportPicture> Pictures;
            public Dictionary<ClashGroup, List<ClashRecord>> Members;
            public readonly Dictionary<string, byte[]> Jpegs = new(StringComparer.Ordinal);
            public Dictionary<string, string> Comments;
            public ClashReportOptions Options;
            public string HtmlPath, XmlPath;
            public int Next, Failed;
        }

        private ClashReportJob _clashReportJob;

        #endregion

        #region Card

        /// <summary>REPORT… → EXPORT REPORT (HTML / XML)…: the card in the dock.</summary>
        private void OpenClashReportCard()
        {
            if (_clashBatch != null || _clashReportJob != null) { return; }
            _clashReportCardOpen = true;
            _clashReportLabelScope = -1;
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>The card: scope, format, pictures, groups, EXPORT… / CANCEL (in place of the clash details).</summary>
        private void BuildClashReportCard(FontAtlas f, InputState input, float x, float y, float w)
        {
            float cy = y;
            _ui.Text(f.Small, x, cy, "CLASH REPORT", UiTheme.ACCENT, S(1.2f));
            cy += S(22);

            RefreshClashReportScopeLabel();
            if (DropdownButton(f, input, x, cy, w, S(28), _clashReportScopeLabel, IsDropdownOpen(_clashList, DROP_DOCK_REPORT_SCOPE)))
            {
                float sy = cy;
                OpenDropdown(_clashList, DROP_DOCK_REPORT_SCOPE, x, sy, w, S(28), ClashReportScopeChoices(), _clashReportScope, i =>
                {
                    _clashReportScope = i;
                    _clashReportLabelScope = -1;
                });
            }
            cy += S(34);

            float half = (w - S(6)) * 0.5f;
            if (DropdownButton(f, input, x, cy, half, S(28), REPORT_FORMAT_LABELS[_clashReportFormat], IsDropdownOpen(_clashList, DROP_DOCK_REPORT_FORMAT)))
            {
                float fy = cy;
                OpenDropdown(_clashList, DROP_DOCK_REPORT_FORMAT, x, fy, half, S(28), REPORT_FORMAT_LABELS, _clashReportFormat, i => _clashReportFormat = i);
            }
            bool html = _clashReportFormat != REPORT_FORMAT_XML;
            string pictures = !html ? "PICTURES: —" : _clashReportPictures ? "PICTURES: ON" : "PICTURES: OFF";
            if (SmallButton(f, input, x + half + S(6), cy, half, S(28), pictures) && html) { _clashReportPictures = !_clashReportPictures; }
            cy += S(34);

            if (DropdownButton(f, input, x, cy, w, S(28), REPORT_GROUP_LABELS[_clashReportGroups], IsDropdownOpen(_clashList, DROP_DOCK_REPORT_GROUPS)))
            {
                float gy = cy;
                OpenDropdown(_clashList, DROP_DOCK_REPORT_GROUPS, x, gy, w, S(28), REPORT_GROUP_LABELS, _clashReportGroups, i => _clashReportGroups = i);
            }
            cy += S(34);

            if (SmallButton(f, input, x, cy, half, S(28), "EXPORT…")) { _clashReportAction = 4; } // after the overlays (a file dialog)
            if (SmallButton(f, input, x + half + S(6), cy, half, S(28), "CANCEL")) { _clashReportCardOpen = false; }
        }

        /// <summary>The scope button's text with its count (rebuilt when the scope or the count changes).</summary>
        private void RefreshClashReportScopeLabel()
        {
            int count = ClashReportScopeCount(_clashReportScope);
            if (_clashReportLabelScope == _clashReportScope && _clashReportLabelCount == count && _clashReportScopeLabel != null) { return; }
            _clashReportLabelScope = _clashReportScope;
            _clashReportLabelCount = count;
            _clashReportScopeLabel = "SCOPE: " + ClashReportScopeName(_clashReportScope) + $" ({count:N0})";
        }

        private static string ClashReportScopeName(int scope) => scope switch
        {
            REPORT_SCOPE_SELECTION => "THE SELECTION",
            REPORT_SCOPE_TEST => "THIS TEST (EVERY CLASH)",
            REPORT_SCOPE_ALL => "ALL TESTS",
            _ => "WHAT THE LIST SHOWS"
        };

        /// <summary>How many clashes a scope takes (no allocation: called while the card is drawn).</summary>
        private int ClashReportScopeCount(int scope)
        {
            switch (scope)
            {
                case REPORT_SCOPE_SELECTION: return ClashMultiActive ? _clashSelected.Count : _clashCurrent != null ? 1 : 0;
                case REPORT_SCOPE_TEST: return _clashTestCount;
                case REPORT_SCOPE_ALL: return _clashDocument?.Clashes.Count ?? 0;
                default: return _clashList.Count;
            }
        }

        private List<string> ClashReportScopeChoices()
        {
            var labels = new List<string>(4);
            for (int scope = 0; scope < 4; scope++) { labels.Add($"{ClashReportScopeName(scope)} ({ClashReportScopeCount(scope):N0})"); }
            return labels;
        }

        /// <summary>The clashes a scope takes, in report order.</summary>
        private List<ClashRecord> ClashReportClashes(int scope)
        {
            switch (scope)
            {
                case REPORT_SCOPE_SELECTION:
                    if (!ClashMultiActive) { return _clashCurrent == null ? new List<ClashRecord>() : new List<ClashRecord> { _clashCurrent }; }
                    // The list's order (selected clashes the list doesn't show come last)
                    var picked = new HashSet<ClashRecord>(_clashSelected);
                    var ordered = _clashList.Where(picked.Contains).ToList();
                    foreach (ClashRecord clash in _clashSelected)
                    {
                        if (!ordered.Contains(clash)) { ordered.Add(clash); }
                    }
                    return ordered;
                case REPORT_SCOPE_TEST:
                    return SortForReport(_clashDocument.Clashes.Where(c => c.TestId == _clashReviewTest));
                case REPORT_SCOPE_ALL:
                    return SortForReport(_clashDocument.Clashes);
                default:
                    return _clashList.ToList();
            }
        }

        /// <summary>By test (the tests' order), then status (new first), then deepest first.</summary>
        private List<ClashRecord> SortForReport(IEnumerable<ClashRecord> clashes)
        {
            var testOrder = new Dictionary<string, int>(StringComparer.Ordinal);
            for (int i = 0; i < _clashDocument.Tests.Count; i++) { testOrder[_clashDocument.Tests[i].Id] = i; }
            return clashes
                .OrderBy(c => testOrder.TryGetValue(c.TestId ?? string.Empty, out int t) ? t : int.MaxValue)
                .ThenBy(c => ClashStatus.IndexOf(c.Status))
                .ThenByDescending(c => c.Distance)
                .ToList();
        }

        /// <summary>The scope in words, for the report's cover.</summary>
        private string ClashReportScopeText(int scope, int count)
        {
            string test = _clashDocument.FindTest(_clashReviewTest)?.Name ?? "—";
            switch (scope)
            {
                case REPORT_SCOPE_SELECTION: return $"The selection: {count:N0} clash{(count == 1 ? string.Empty : "es")} of test “{test}”";
                case REPORT_SCOPE_TEST: return $"Test “{test}”: every clash";
                case REPORT_SCOPE_ALL: return $"Every test ({_clashDocument.Tests.Count:N0})";
                default:
                    string search = _clashSearchLength == 0 ? null : new string(_clashSearch, 0, _clashSearchLength).Trim();
                    return $"What the list showed: test “{test}”, status {CLASH_STATUS_FILTERS[_clashStatusFilter].ToLowerInvariant()}, " +
                        $"level {(_clashLevelFilter ?? "all")}" + (string.IsNullOrEmpty(search) ? string.Empty : $", search “{search}”") +
                        (_clashGroupFilter == CLASH_SHOW_ALL ? string.Empty : ", " + CLASH_SHOW_LABELS[_clashGroupFilter].ToLowerInvariant());
            }
        }

        #endregion

        #region Export

        /// <summary>
        /// EXPORT… on the card: the clashes, where to save, then the files (straight away without pictures, else after
        /// the pictures render over the next frames; above <see cref="REPORT_PICTURES_WARN"/> pictures it asks first).
        /// </summary>
        private void StartClashReport(bool confirmed = false)
        {
            if (_clashDocument == null || _clashReportJob != null) { return; }
            List<ClashRecord> clashes = ClashReportClashes(_clashReportScope);
            if (clashes.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("Nothing to report in that scope", 2.5f);
                return;
            }
            bool html = _clashReportFormat != REPORT_FORMAT_XML, xml = _clashReportFormat != REPORT_FORMAT_HTML;
            bool pictures = html && _clashReportPictures;
            List<ClashReportPicture> wanted = pictures ? ClashReports.Pictures(_clashDocument, clashes, _clashReportGroups) : new List<ClashReportPicture>();
            if (!confirmed && wanted.Count > REPORT_PICTURES_WARN)
            {
                OpenConfirm("LARGE REPORT", $"{wanted.Count:N0} pictures to render: about {Math.Max(1, wanted.Count / 6):N0} s and roughly {wanted.Count * 0.1:N0} MB of HTML. " +
                    "Turn PICTURES off, narrow the scope, or use GROUPS: COMPACT for a lighter report.", "EXPORT", danger: false, offerSkip: false,
                    ok => { if (ok) { _clashReportAction = 5; } }); // the save dialog opens after the dock's overlays
                return;
            }

            // Where to save
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            string extension = html ? ".html" : ".xml";
            string filter = html ? "HTML clash report (*.html)|*.html|All files (*.*)|*.*" : "XML clash report (*.xml)|*.xml|All files (*.*)|*.*";
            string name = SafeFileName(Scene.ModelTitle) + " clash report " + DateTime.Now.ToString("yyyy-MM-dd HHmm") + extension;
            string path = FileDialogs.ShowSave(_window.Handle, "Export clash report", filter, SuggestedFolder(), name, extension);
            _window.Input.ReleaseAll();
            if (path == null) { return; }

            var job = new ClashReportJob
            {
                Clashes = clashes,
                Pictures = wanted,
                Options = new ClashReportOptions
                {
                    Title = "Clash report",
                    ModelTitle = Scene.ModelTitle,
                    Generator = $"BimGo {Program.Version}",
                    Author = Environment.UserName,
                    Created = DateTime.Now,
                    ScopeLabel = ClashReportScopeText(_clashReportScope, clashes.Count),
                    GroupMode = _clashReportGroups,
                    Length = m => UnitFormat.Length(m, 3),
                    GridLocation = ClashGridFunction() // grids round B: "C-4 : Level 2" (null without grids)
                },
                HtmlPath = html ? path : null,
                XmlPath = xml ? (html ? Path.ChangeExtension(path, ".xml") : path) : null,
                Comments = ClashReportComments(clashes),
                Members = new Dictionary<ClashGroup, List<ClashRecord>>()
            };
            foreach (ClashReportSection section in ClashReports.Sections(_clashDocument, clashes, ClashReportGroups.SECTIONS))
            {
                if (section.Group != null) { job.Members[section.Group] = section.Clashes; }
            }
            _clashReportCardOpen = false;

            if (wanted.Count == 0)
            {
                WriteClashReport(job);
                return;
            }
            if (!EnsureClashShotTargets()) { return; }
            _clashReportJob = job;
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>The comment text of each clash and group in the report that has one.</summary>
        private Dictionary<string, string> ClashReportComments(List<ClashRecord> clashes)
        {
            var comments = new Dictionary<string, string>(StringComparer.Ordinal);
            if (Comments == null) { return comments; }
            foreach (ClashRecord clash in clashes)
            {
                CommentRecord comment = FindClashComment(clash);
                if (comment != null && !string.IsNullOrWhiteSpace(comment.Text)) { comments[clash.Id] = comment.Text; }
                ClashGroup group = ClashGroupOf(clash);
                if (group != null && !comments.ContainsKey(group.Id))
                {
                    CommentRecord own = FindClashGroupComment(group);
                    if (own != null && !string.IsNullOrWhiteSpace(own.Text)) { comments[group.Id] = own.Text; }
                }
            }
            return comments;
        }

        /// <summary>The next report pictures (as many as fit the frame's budget, at least one), then the files.</summary>
        private void StepClashReport()
        {
            ClashReportJob job = _clashReportJob;
            _clashPictureClock.Restart();
            while (job.Next < job.Pictures.Count)
            {
                ClashReportPicture picture = job.Pictures[job.Next++];
                bool rendered;
                if (picture.Group != null)
                {
                    List<ClashRecord> members = job.Members.TryGetValue(picture.Group, out List<ClashRecord> inReport) && inReport.Count > 0
                        ? inReport : AllClashGroupMembers(picture.Group);
                    rendered = members.Count > 0 && RenderClashGroupPicture(members, out _, out _, out _);
                }
                else
                {
                    rendered = RenderClashPicture(picture.Clash, CLASH_SHOT_W, CLASH_SHOT_H, 4, _clashShotTarget, _clashShotResolve, _clashShotPixels,
                        framed: true, out _, out _);
                }
                if (rendered)
                {
                    try { job.Jpegs[picture.Id] = EncodeJpeg(_clashShotPixels, CLASH_SHOT_W, CLASH_SHOT_H, REPORT_PICTURE_W, REPORT_PICTURE_H, REPORT_JPEG_QUALITY); }
                    catch (Exception ex)
                    {
                        Utilities.Log_Utils.Write($"Clash report picture failed: {ex.Message}");
                        job.Failed++;
                    }
                }
                else { job.Failed++; }
                if (_clashPictureClock.Elapsed.TotalMilliseconds > CLASH_PICTURE_BUDGET_MS) { break; }
            }
            if (job.Next >= job.Pictures.Count)
            {
                _clashReportJob = null;
                ReleaseClashShotTargets();
                WriteClashReport(job);
            }
        }

        /// <summary>Stops an export in progress (nothing is written).</summary>
        private void CancelClashReport()
        {
            if (_clashReportJob == null) { return; }
            int done = _clashReportJob.Next, total = _clashReportJob.Pictures.Count;
            _clashReportJob = null;
            ReleaseClashShotTargets();
            Sound.Play(SoundId.UiClick);
            Toast($"Report cancelled at picture {done:N0} of {total:N0} (nothing written)", 3f);
        }

        /// <summary>Writes the HTML and / or XML (each through a temporary file), then opens the HTML.</summary>
        private void WriteClashReport(ClashReportJob job)
        {
            try
            {
                if (job.HtmlPath != null)
                {
                    string html = ClashReports.Html(_clashDocument, job.Clashes, job.Options, job.Jpegs, job.Comments);
                    WriteReportFile(job.HtmlPath, new UTF8Encoding(false).GetBytes(html));
                }
                if (job.XmlPath != null)
                {
                    WriteReportFile(job.XmlPath, ClashReports.Xml(_clashDocument, job.Clashes, job.Options, job.Comments));
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Clash report failed: {ex}");
                Sound.Play(SoundId.Error);
                Toast($"The report couldn't be written: {ex.Message}", 5f, important: true);
                return;
            }

            Sound.Play(SoundId.Commit);
            string files = job.HtmlPath != null && job.XmlPath != null ? $"{Path.GetFileName(job.HtmlPath)} + .xml" : Path.GetFileName(job.HtmlPath ?? job.XmlPath);
            Toast($"Clash report saved: {files} ({job.Clashes.Count:N0} clashes" +
                (job.Jpegs.Count > 0 ? $", {job.Jpegs.Count:N0} pictures" : string.Empty) +
                (job.Failed > 0 ? $", {job.Failed:N0} pictures failed (see the log)" : string.Empty) + ")", 4f, important: job.Failed > 0);
            if (job.HtmlPath != null)
            {
                try { Process.Start(new ProcessStartInfo(job.HtmlPath) { UseShellExecute = true }); }
                catch (Exception ex) { Utilities.Log_Utils.Write($"Opening the report failed: {ex.Message}"); }
            }
        }

        private static void WriteReportFile(string path, byte[] bytes)
        {
            string temp = path + ".tmp";
            File.WriteAllBytes(temp, bytes);
            File.Move(temp, path, overwrite: true);
        }

        /// <summary>The dock's progress while the report's pictures render, with CANCEL (in place of the clash details).</summary>
        private void BuildClashReportProgress(FontAtlas f, InputState input, float x, float y, float w)
        {
            ClashReportJob job = _clashReportJob;
            int total = Math.Max(1, job.Pictures.Count);
            Text.Clear().Append("EXPORTING REPORT · PICTURE ").Append(job.Next).Append(" OF ").AppendGrouped(job.Pictures.Count);
            _ui.Text(f.Small, x, y, Text.Span, UiTheme.ACCENT, S(1.2f));
            float barY = y + S(24);
            _ui.Rect(x, barY, w, S(8), UiTheme.CONTROL);
            _ui.Rect(x, barY, w * Math.Clamp((float)job.Next / total, 0f, 1f), S(8), UiTheme.ACCENT);
            _ui.TextWrapped(f.Small, x, barY + S(16), w, "Each group and clash is framed and pictured as the view and box are set now. The files are written at the end.",
                UiTheme.TEXT_MUTED, maxLines: 2);
            if (SmallButton(f, input, x, barY + S(54), MathF.Min(w, S(140)), S(28), "CANCEL")) { CancelClashReport(); }
        }

        #endregion
    }
}
