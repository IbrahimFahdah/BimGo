using System.Globalization;
using System.Net;
using System.Text;
using System.Xml;

// The class belongs to the Clashes namespace
namespace BimGo.Clashes
{
    /// <summary>How groups appear in a report (Round C, build C-C3).</summary>
    public static class ClashReportGroups
    {
        /// <summary>A section per group (its header and picture, then a card per member); ungrouped clashes after.</summary>
        public const int SECTIONS = 0;

        /// <summary>A group is one item (picture, counts by status, category pairs, levels); ungrouped clashes after.</summary>
        public const int COMPACT = 1;

        /// <summary>Groups ignored: one card per clash, in the given order.</summary>
        public const int NONE = 2;
    }

    /// <summary>What a report says about itself and how it reads (Round C, build C-C3).</summary>
    public sealed class ClashReportOptions
    {
        /// <summary>The heading ("Clash report").</summary>
        public string Title { get; set; } = "Clash report";

        /// <summary>The model's title.</summary>
        public string ModelTitle { get; set; }

        /// <summary>"BimGo 1.2.3".</summary>
        public string Generator { get; set; }

        /// <summary>Who made it.</summary>
        public string Author { get; set; }

        /// <summary>When it was made (local time, as shown).</summary>
        public DateTime Created { get; set; } = DateTime.Now;

        /// <summary>What it covers, in words ("What the list showed: status open, Level 2").</summary>
        public string ScopeLabel { get; set; }

        /// <summary><see cref="ClashReportGroups"/>.</summary>
        public int GroupMode { get; set; } = ClashReportGroups.SECTIONS;

        /// <summary>Lengths as shown (the app's display units); null: metres to 3 decimals.</summary>
        public Func<double, string> Length { get; set; }

        /// <summary>
        /// Grids round B: a clash's grid location ("C-4 : Level 2"), or null (no grids). Null function: the XML
        /// gridlocation holds the level, as before, and the HTML has no grid lines.
        /// </summary>
        public Func<ClashRecord, string> GridLocation { get; set; }

        internal string GridOf(ClashRecord clash) => GridLocation?.Invoke(clash);

        /// <summary>The length unit the XML states ("m": XML lengths are always metres).</summary>
        public string XmlUnits => "m";

        internal string L(double metres) => Length != null ? Length(metres) : metres.ToString("0.000", CultureInfo.InvariantCulture) + " m";
    }

    /// <summary>A report section: a group and its members in the report, or (group null) the ungrouped clashes.</summary>
    public sealed class ClashReportSection
    {
        /// <summary>The group, or null for the ungrouped clashes (or every clash when groups are ignored).</summary>
        public ClashGroup Group { get; init; }

        /// <summary>Its clashes in the report, in report order.</summary>
        public List<ClashRecord> Clashes { get; } = new();
    }

    /// <summary>One picture a report wants: a group's (<see cref="Group"/>) or a clash's (<see cref="Clash"/>), by id.</summary>
    public readonly record struct ClashReportPicture(string Id, ClashGroup Group, ClashRecord Clash);

    /// <summary>
    /// Clash reports (Round C, build C-C3): a self-contained <b>HTML</b> page (cover and summary, a section per group or
    /// one item per group, a card per clash; pictures embedded as JPEG data; prints to PDF from a browser) and a
    /// Navisworks-style <b>XML</b> (<c>exchange / batchtest / clashtests / clashtest / clashresults</c>, groups as
    /// <c>clashgroup</c>, the pair's ids and names as <c>smarttags</c>; lengths in metres, a crossing's distance negative).
    /// The app chooses the clashes and renders the pictures; this only writes.
    /// </summary>
    public static class ClashReports
    {
        #region Structure

        /// <summary>
        /// The report's sections: groups in the order their first clash appears (members in the given order), then the
        /// ungrouped clashes; <see cref="ClashReportGroups.NONE"/>: one section with every clash.
        /// </summary>
        public static List<ClashReportSection> Sections(ClashDocument document, IReadOnlyList<ClashRecord> clashes, int groupMode)
        {
            var sections = new List<ClashReportSection>();
            if (clashes == null || clashes.Count == 0) { return sections; }
            if (groupMode == ClashReportGroups.NONE)
            {
                var all = new ClashReportSection();
                all.Clashes.AddRange(clashes);
                sections.Add(all);
                return sections;
            }

            Dictionary<string, ClashGroup> index = ClashGroups.Index(document);
            var byGroup = new Dictionary<ClashGroup, ClashReportSection>();
            var loose = new ClashReportSection();
            foreach (ClashRecord clash in clashes)
            {
                if (clash == null) { continue; }
                if (!index.TryGetValue(clash.Id, out ClashGroup group))
                {
                    loose.Clashes.Add(clash);
                    continue;
                }
                if (!byGroup.TryGetValue(group, out ClashReportSection section))
                {
                    section = new ClashReportSection { Group = group };
                    byGroup[group] = section;
                    sections.Add(section);
                }
                section.Clashes.Add(clash);
            }
            if (loose.Clashes.Count > 0) { sections.Add(loose); }
            return sections;
        }

        /// <summary>
        /// The pictures an HTML report shows, in report order: each group's (sections and compact) and each clash's that
        /// gets a card (compact: the ungrouped ones only).
        /// </summary>
        public static List<ClashReportPicture> Pictures(ClashDocument document, IReadOnlyList<ClashRecord> clashes, int groupMode)
        {
            var pictures = new List<ClashReportPicture>();
            foreach (ClashReportSection section in Sections(document, clashes, groupMode))
            {
                if (section.Group != null)
                {
                    pictures.Add(new ClashReportPicture(section.Group.Id, section.Group, null));
                    if (groupMode == ClashReportGroups.COMPACT) { continue; }
                }
                foreach (ClashRecord clash in section.Clashes) { pictures.Add(new ClashReportPicture(clash.Id, null, clash)); }
            }
            return pictures;
        }

        /// <summary>Counts per status (<see cref="ClashStatus.All"/> order).</summary>
        public static int[] CountByStatus(IEnumerable<ClashRecord> clashes)
        {
            int[] counts = new int[ClashStatus.All.Length];
            foreach (ClashRecord clash in clashes) { counts[ClashStatus.IndexOf(clash.Status)]++; }
            return counts;
        }

        /// <summary>Counts per key, most first (ties by key, ordinal).</summary>
        public static List<(string Key, int Count)> CountBy(IEnumerable<ClashRecord> clashes, Func<ClashRecord, string> keyOf)
        {
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (ClashRecord clash in clashes)
            {
                string key = keyOf(clash);
                counts[key] = counts.TryGetValue(key, out int c) ? c + 1 : 1;
            }
            return counts.OrderByDescending(p => p.Value).ThenBy(p => p.Key, StringComparer.Ordinal).Select(p => (p.Key, p.Value)).ToList();
        }

        #endregion

        #region HTML

        /// <summary>
        /// The HTML report (one self-contained page: inline styles, pictures as data URIs).
        /// </summary>
        /// <param name="document">The clash document (tests, sets, groups).</param>
        /// <param name="clashes">The clashes in the report, in report order.</param>
        /// <param name="options">Title, model, author, scope, group mode, length format.</param>
        /// <param name="pictures">JPEG bytes by clash or group id (missing: no picture).</param>
        /// <param name="comments">Comment text by clash or group id (missing: none).</param>
        public static string Html(ClashDocument document, IReadOnlyList<ClashRecord> clashes, ClashReportOptions options,
            IReadOnlyDictionary<string, byte[]> pictures = null, IReadOnlyDictionary<string, string> comments = null)
        {
            options ??= new ClashReportOptions();
            clashes ??= Array.Empty<ClashRecord>();
            var html = new StringBuilder(64 * 1024);
            string title = $"{options.Title} · {options.ModelTitle}";
            html.Append("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
                .Append("<title>").Append(H(title)).Append("</title>\n<style>\n").Append(CSS).Append("</style>\n</head>\n<body>\n");

            WriteCover(html, document, clashes, options);

            int number = 0;
            List<ClashReportSection> sections = Sections(document, clashes, options.GroupMode);
            foreach (ClashReportSection section in sections)
            {
                if (section.Group != null)
                {
                    html.Append("<section class=\"group\">\n");
                    WriteGroupHeader(html, document, section, options, pictures, comments, compact: options.GroupMode == ClashReportGroups.COMPACT);
                    if (options.GroupMode != ClashReportGroups.COMPACT)
                    {
                        foreach (ClashRecord clash in section.Clashes) { WriteClashCard(html, document, clash, ++number, options, pictures, comments, inGroup: true); }
                    }
                    else { number += section.Clashes.Count; }
                    html.Append("</section>\n");
                    continue;
                }
                html.Append("<section class=\"loose\">\n");
                if (options.GroupMode != ClashReportGroups.NONE)
                {
                    html.Append("<h2>Ungrouped clashes <span class=\"muted\">(").Append(section.Clashes.Count.ToString("N0", CultureInfo.InvariantCulture)).Append(")</span></h2>\n");
                }
                foreach (ClashRecord clash in section.Clashes) { WriteClashCard(html, document, clash, ++number, options, pictures, comments, inGroup: false); }
                html.Append("</section>\n");
            }
            if (clashes.Count == 0) { html.Append("<p class=\"muted\">No clashes in this report.</p>\n"); }

            html.Append("<footer>").Append(H(options.Generator ?? "BimGo")).Append(" · ").Append(H(options.Created.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)))
                .Append("</footer>\n</body>\n</html>\n");
            return html.ToString();
        }

        private static void WriteCover(StringBuilder html, ClashDocument document, IReadOnlyList<ClashRecord> clashes, ClashReportOptions options)
        {
            html.Append("<header class=\"cover\">\n<h1>").Append(H(options.Title)).Append("</h1>\n<p class=\"model\">").Append(H(options.ModelTitle ?? "Model")).Append("</p>\n<dl>\n");
            Meta(html, "Scope", options.ScopeLabel);
            Meta(html, "Created", options.Created.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture));
            Meta(html, "By", options.Author);
            Meta(html, "Clashes", clashes.Count.ToString("N0", CultureInfo.InvariantCulture));
            int groups = Sections(document, clashes, ClashReportGroups.SECTIONS).Count(s => s.Group != null);
            if (groups > 0) { Meta(html, "Groups", groups.ToString("N0", CultureInfo.InvariantCulture)); }
            Meta(html, "Generator", options.Generator);
            html.Append("</dl>\n");

            // By status
            int[] byStatus = CountByStatus(clashes);
            html.Append("<div class=\"chips\">");
            for (int k = 0; k < byStatus.Length; k++)
            {
                html.Append("<span class=\"chip s-").Append(ClashStatus.All[k]).Append("\"><b>").Append(byStatus[k].ToString("N0", CultureInfo.InvariantCulture))
                    .Append("</b> ").Append(H(ClashStatus.Label(ClashStatus.All[k]))).Append("</span>");
            }
            html.Append("</div>\n<div class=\"tables\">\n");

            // By level, by category pair
            WriteCountTable(html, "By level", "Level", CountBy(clashes, c => { string l = ClashGrouping.LevelOf(c); return l == "—" ? "No level" : l; }));
            WriteCountTable(html, "By category pair", "Pair", CountBy(clashes, ClashGrouping.CategoryPairOf).Take(12).ToList());
            if (options.GridLocation != null)
            {
                // Grids round B: the busiest grid intersections (every level)
                WriteCountTable(html, "By grid", "Near", CountBy(clashes, c =>
                {
                    string grid = options.GridOf(c);
                    if (string.IsNullOrEmpty(grid)) { return "No grid"; }
                    int colon = grid.IndexOf(" : ", StringComparison.Ordinal);
                    return colon > 0 ? grid.Substring(0, colon) : grid;
                }).Take(12).ToList());
            }
            html.Append("</div>\n");

            // The tests
            var testIds = new List<string>();
            foreach (ClashRecord clash in clashes)
            {
                if (!testIds.Contains(clash.TestId)) { testIds.Add(clash.TestId); }
            }
            if (testIds.Count > 0)
            {
                html.Append("<h2>Tests</h2>\n<table class=\"tests\"><thead><tr><th>Test</th><th>Kind</th><th>Tolerance</th><th>A</th><th>B</th><th>Last run</th><th>In report</th></tr></thead><tbody>\n");
                foreach (string id in testIds)
                {
                    ClashTest test = document?.FindTest(id);
                    string a = SetName(document, test?.SetA), b = test == null || test.IsSelfTest ? a + " (itself)" : SetName(document, test.SetB);
                    html.Append("<tr><td>").Append(H(test?.Name ?? "(removed test)")).Append("</td><td>").Append(H(test == null ? "" : KindLabel(test.Kind)))
                        .Append("</td><td>").Append(H(test == null ? "" : options.L(test.Tolerance))).Append("</td><td>").Append(H(a)).Append("</td><td>").Append(H(b))
                        .Append("</td><td>").Append(H(test?.LastRunUtc?.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) ?? "—"))
                        .Append("</td><td>").Append(clashes.Count(c => c.TestId == id).ToString("N0", CultureInfo.InvariantCulture)).Append("</td></tr>\n");
                }
                html.Append("</tbody></table>\n");
            }
            html.Append("</header>\n");
        }

        private static void WriteCountTable(StringBuilder html, string caption, string column, List<(string Key, int Count)> rows)
        {
            if (rows.Count == 0) { return; }
            html.Append("<table class=\"counts\"><caption>").Append(H(caption)).Append("</caption><thead><tr><th>").Append(H(column)).Append("</th><th>Clashes</th></tr></thead><tbody>");
            foreach ((string key, int count) in rows)
            {
                html.Append("<tr><td>").Append(H(key)).Append("</td><td>").Append(count.ToString("N0", CultureInfo.InvariantCulture)).Append("</td></tr>");
            }
            html.Append("</tbody></table>\n");
        }

        private static void WriteGroupHeader(StringBuilder html, ClashDocument document, ClashReportSection section, ClashReportOptions options,
            IReadOnlyDictionary<string, byte[]> pictures, IReadOnlyDictionary<string, string> comments, bool compact)
        {
            ClashGroup group = section.Group;
            int[] byStatus = CountByStatus(section.Clashes);
            bool mixed = section.Clashes.Any(c => ClashStatus.Normalise(c.Status) != ClashStatus.Normalise(group.Status));
            html.Append("<div class=\"card grouphead\">\n");
            Picture(html, pictures, group.Id, ClashGroups.DisplayName(group));
            html.Append("<div class=\"body\">\n<div class=\"line\"><span class=\"tag\">GROUP</span>");
            StatusPill(html, group.Status);
            if (mixed) { html.Append("<span class=\"pill mixed\">Mixed</span>"); }
            html.Append("</div>\n<h2>").Append(H(ClashGroups.DisplayName(group))).Append("</h2>\n<dl>\n");
            Meta(html, "Clashes", section.Clashes.Count == group.Count
                ? group.Count.ToString("N0", CultureInfo.InvariantCulture)
                : $"{section.Clashes.Count:N0} in this report of {group.Count:N0}");
            Meta(html, "Statuses", StatusCounts(byStatus));
            Meta(html, "Test", document?.FindTest(group.TestId)?.Name);
            Meta(html, "Assigned to", group.AssignedTo);
            Meta(html, "Notes", group.Notes);
            if (group.KeyElement != null) { Meta(html, "All on", ClashGroups.ElementName(group.KeyElement)); }
            if (group.Box != null) { Meta(html, "Box", group.Box.FullHeight ? "plan area, full height" : "yes"); }
            if (compact)
            {
                // One item: what is involved
                Meta(html, "Levels", string.Join(", ", CountBy(section.Clashes, c => { string l = ClashGrouping.LevelOf(c); return l == "—" ? "No level" : l; })
                    .Select(p => $"{p.Key} ({p.Count})")));
                Meta(html, "Category pairs", string.Join(", ", CountBy(section.Clashes, ClashGrouping.CategoryPairOf).Take(8).Select(p => $"{p.Key} ({p.Count})")));
                int elements = section.Clashes.SelectMany(c => new[] { c.A.Key, c.B.Key }).Distinct(StringComparer.Ordinal).Count();
                Meta(html, "Elements", elements.ToString("N0", CultureInfo.InvariantCulture));
                ClashRecord deepest = section.Clashes.Where(c => c.Crossing).OrderByDescending(c => c.Distance).FirstOrDefault();
                if (deepest != null && deepest.Distance > 0) { Meta(html, "Deepest", options.L(deepest.Distance)); }
            }
            if (comments != null && comments.TryGetValue(group.Id, out string comment)) { Meta(html, "Comment", comment); }
            html.Append("</dl>\n</div>\n</div>\n");
        }

        private static void WriteClashCard(StringBuilder html, ClashDocument document, ClashRecord clash, int number, ClashReportOptions options,
            IReadOnlyDictionary<string, byte[]> pictures, IReadOnlyDictionary<string, string> comments, bool inGroup)
        {
            html.Append("<div class=\"card").Append(inGroup ? " member" : string.Empty).Append("\">\n");
            Picture(html, pictures, clash.Id, $"Clash {number}");
            html.Append("<div class=\"body\">\n<div class=\"line\"><span class=\"tag\">CLASH ").Append(number.ToString(CultureInfo.InvariantCulture)).Append("</span>");
            StatusPill(html, clash.Status);
            if (clash.Approximate) { html.Append("<span class=\"pill mixed\">Approximate</span>"); }
            html.Append("</div>\n<h3>").Append(H(clash.A.Label)).Append(" <span class=\"x\">×</span> ").Append(H(clash.B.Label)).Append("</h3>\n");
            html.Append("<table class=\"pair\"><tbody>\n");
            PairRow(html, "A", clash.A);
            PairRow(html, "B", clash.B);
            html.Append("</tbody></table>\n<dl>\n");
            Meta(html, clash.Crossing ? "Crossing" : "Gap", clash.Crossing
                ? (clash.Distance > 0 ? options.L(clash.Distance) : "yes")
                : clash.Distance <= 0 ? "touching" : options.L(clash.Distance));
            Meta(html, "Level", ClashGrouping.LevelOf(clash));
            Meta(html, "Grid", options.GridOf(clash)); // grids round B
            Meta(html, "Point (x, y, z)", $"{clash.X.ToString("0.000", CultureInfo.InvariantCulture)}, {clash.Y.ToString("0.000", CultureInfo.InvariantCulture)}, {clash.Z.ToString("0.000", CultureInfo.InvariantCulture)} m");
            if (!inGroup || options.GroupMode == ClashReportGroups.NONE) { Meta(html, "Test", document?.FindTest(clash.TestId)?.Name); }
            Meta(html, "Assigned to", clash.AssignedTo);
            Meta(html, "Notes", clash.Notes);
            Meta(html, "Found", clash.FoundUtc.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) +
                " · last seen " + clash.LastSeenUtc.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) +
                (clash.ResolvedUtc.HasValue ? " · resolved " + clash.ResolvedUtc.Value.ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : string.Empty));
            if (comments != null && comments.TryGetValue(clash.Id, out string comment)) { Meta(html, "Comment", comment); }
            html.Append("</dl>\n</div>\n</div>\n");
        }

        private static void PairRow(StringBuilder html, string side, ClashElementRef element)
        {
            string id = element.CloneKey > 0 ? "clone " + element.CloneKey.ToString(CultureInfo.InvariantCulture)
                : element.ElementId > 0 ? element.ElementId.ToString(CultureInfo.InvariantCulture) : "—";
            html.Append("<tr><td class=\"side s").Append(side).Append("\">").Append(side).Append("</td><td>").Append(H(element.Category)).Append("</td><td>")
                .Append(H(element.FamilyType)).Append("</td><td>").Append(H(id)).Append("</td><td>").Append(H(string.IsNullOrWhiteSpace(element.Level) ? "—" : element.Level))
                .Append("</td><td>").Append(string.IsNullOrEmpty(element.Link) ? "host" : "linked").Append("</td></tr>\n");
        }

        private static void Picture(StringBuilder html, IReadOnlyDictionary<string, byte[]> pictures, string id, string alt)
        {
            if (pictures == null || !pictures.TryGetValue(id, out byte[] jpeg) || jpeg == null || jpeg.Length == 0)
            {
                html.Append("<div class=\"pic none\"></div>\n");
                return;
            }
            html.Append("<img class=\"pic\" alt=\"").Append(H(alt)).Append("\" src=\"data:image/jpeg;base64,").Append(Convert.ToBase64String(jpeg)).Append("\">\n");
        }

        private static void StatusPill(StringBuilder html, string status)
        {
            string s = ClashStatus.Normalise(status);
            html.Append("<span class=\"pill s-").Append(s).Append("\">").Append(H(ClashStatus.Label(s))).Append("</span>");
        }

        private static void Meta(StringBuilder html, string name, string value)
        {
            if (string.IsNullOrWhiteSpace(value)) { return; }
            html.Append("<dt>").Append(H(name)).Append("</dt><dd>").Append(H(value).Replace("\n", "<br>")).Append("</dd>\n");
        }

        /// <summary>"3 new, 2 active" (statuses with clashes only).</summary>
        public static string StatusCounts(int[] byStatus)
        {
            var parts = new List<string>(ClashStatus.All.Length);
            for (int k = 0; k < byStatus.Length; k++)
            {
                if (byStatus[k] > 0) { parts.Add($"{byStatus[k].ToString("N0", CultureInfo.InvariantCulture)} {ClashStatus.All[k]}"); }
            }
            return string.Join(", ", parts);
        }

        private static string SetName(ClashDocument document, string setId) => document?.FindSet(setId)?.Name ?? "—";

        private static string KindLabel(string kind) => ClashKind.Normalise(kind) == ClashKind.CLEARANCE ? "Clearance" : "Hard";

        private static string H(string text) => WebUtility.HtmlEncode(text ?? string.Empty);

        private const string CSS = @":root{--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--bg:#ffffff;--soft:#f9fafb;--accent:#0891b2}
*{box-sizing:border-box}
body{margin:0 auto;max-width:1100px;padding:24px;font:14px/1.45 'Segoe UI',system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg)}
h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:20px 0 8px}h3{font-size:15px;margin:2px 0 8px}
.model{font-size:17px;color:var(--muted);margin:0 0 14px}
.muted{color:var(--muted);font-weight:normal}
.cover{border-bottom:3px solid var(--accent);padding-bottom:16px;margin-bottom:20px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:6px 0}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.chip{border-radius:999px;padding:4px 12px;background:var(--soft);border:1px solid var(--line)}
.tables{display:flex;flex-wrap:wrap;gap:24px}
table{border-collapse:collapse}
th,td{text-align:left;padding:4px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
caption{text-align:left;font-weight:600;padding:4px 0}
.tests{width:100%}
.card{display:grid;grid-template-columns:minmax(220px,42%) 1fr;gap:16px;border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0;break-inside:avoid;page-break-inside:avoid;background:var(--bg)}
.card.member{margin-left:22px;border-left:4px solid var(--line)}
.grouphead{background:var(--soft);border-left:6px solid var(--accent);break-after:avoid;page-break-after:avoid}
.pic{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;background:#e5e7eb}
.pic.none{min-height:60px}
.line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tag{font-size:11px;letter-spacing:.08em;color:var(--muted);font-weight:700}
.pill{border-radius:999px;padding:1px 10px;font-size:12px;font-weight:600;color:#111827}
.x{color:var(--muted)}
.pair td{padding:2px 8px;font-size:13px}
.side{font-weight:700;color:#fff;text-align:center;border-radius:4px}.sA{background:#ef4444}.sB{background:#22c55e}
.s-new{background:#fca5a5}.s-active{background:#fdba74}.s-reviewed{background:#fde68a}.s-approved{background:#93c5fd}.s-resolved{background:#86efac}
.mixed{background:#fbbf24}
footer{margin-top:28px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:8px}
@media (max-width:700px){.card{grid-template-columns:1fr}.card.member{margin-left:8px}}
@media print{body{max-width:none;padding:0}.card{margin:8px 0}@page{size:A4;margin:12mm}}
";

        #endregion

        #region XML

        /// <summary>
        /// The Navisworks-style XML report (UTF-8): <c>exchange</c> → <c>batchtest</c> → <c>clashtests</c> → one
        /// <c>clashtest</c> per test in the report (settings, <c>summary</c> counts) → <c>clashresults</c>: a
        /// <c>clashgroup</c> per group holding its members' <c>clashresult</c>s (unless groups are ignored), then the
        /// ungrouped <c>clashresult</c>s. Lengths in metres; a crossing's <c>distance</c> is negative (its depth).
        /// </summary>
        public static byte[] Xml(ClashDocument document, IReadOnlyList<ClashRecord> clashes, ClashReportOptions options,
            IReadOnlyDictionary<string, string> comments = null)
        {
            options ??= new ClashReportOptions();
            clashes ??= Array.Empty<ClashRecord>();
            var settings = new XmlWriterSettings { Indent = true, Encoding = new UTF8Encoding(false) };
            using var stream = new MemoryStream();
            using (XmlWriter x = XmlWriter.Create(stream, settings))
            {
                x.WriteStartDocument();
                x.WriteStartElement("exchange");
                At(x, "units", options.XmlUnits);
                At(x, "filename", options.ModelTitle ?? string.Empty);
                At(x, "generator", options.Generator ?? "BimGo");
                At(x, "author", options.Author ?? string.Empty);
                At(x, "created", options.Created.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture));
                At(x, "scope", options.ScopeLabel ?? string.Empty);
                x.WriteStartElement("batchtest");
                At(x, "name", options.Title ?? "Clash report");
                At(x, "units", options.XmlUnits);
                x.WriteStartElement("clashtests");

                var testIds = new List<string>();
                foreach (ClashRecord clash in clashes)
                {
                    if (!testIds.Contains(clash.TestId)) { testIds.Add(clash.TestId); }
                }
                int number = 0;
                foreach (string testId in testIds)
                {
                    ClashTest test = document?.FindTest(testId);
                    List<ClashRecord> ofTest = clashes.Where(c => c.TestId == testId).ToList();
                    x.WriteStartElement("clashtest");
                    At(x, "name", test?.Name ?? "(removed test)");
                    At(x, "guid", testId ?? string.Empty);
                    At(x, "test_type", test == null ? "hard" : ClashKind.Normalise(test.Kind));
                    At(x, "status", "ok");
                    At(x, "tolerance", Num(test?.Tolerance ?? 0));
                    x.WriteStartElement("left");
                    WriteSelection(x, document, test?.SetA);
                    x.WriteEndElement();
                    x.WriteStartElement("right");
                    WriteSelection(x, document, test == null || test.IsSelfTest ? test?.SetA : test.SetB);
                    x.WriteEndElement();

                    int[] byStatus = CountByStatus(ofTest);
                    x.WriteStartElement("summary");
                    At(x, "total", ofTest.Count.ToString(CultureInfo.InvariantCulture));
                    for (int k = 0; k < byStatus.Length; k++) { At(x, ClashStatus.All[k], byStatus[k].ToString(CultureInfo.InvariantCulture)); }
                    El(x, "testtype", test == null ? "Hard" : KindLabel(test.Kind));
                    El(x, "teststatus", "OK");
                    x.WriteEndElement();

                    x.WriteStartElement("clashresults");
                    foreach (ClashReportSection section in Sections(document, ofTest, options.GroupMode == ClashReportGroups.NONE ? ClashReportGroups.NONE : ClashReportGroups.SECTIONS))
                    {
                        if (section.Group == null)
                        {
                            foreach (ClashRecord clash in section.Clashes) { WriteResult(x, clash, ++number, comments, options); }
                            continue;
                        }
                        ClashGroup group = section.Group;
                        x.WriteStartElement("clashgroup");
                        At(x, "name", ClashGroups.DisplayName(group));
                        At(x, "guid", group.Id);
                        At(x, "status", ClashStatus.Normalise(group.Status));
                        At(x, "count", section.Clashes.Count.ToString(CultureInfo.InvariantCulture));
                        if (!string.IsNullOrEmpty(group.Auto)) { At(x, "auto", group.Auto); }
                        El(x, "resultstatus", ClashStatus.Label(group.Status));
                        if (!string.IsNullOrWhiteSpace(group.AssignedTo)) { El(x, "assignedto", group.AssignedTo); }
                        WriteComments(x, group.Notes, comments, group.Id);
                        if (group.Box != null)
                        {
                            x.WriteStartElement("box");
                            At(x, "fullheight", group.Box.FullHeight ? "true" : "false");
                            Pos(x, "min", group.Box.MinX, group.Box.MinY, group.Box.MinZ);
                            Pos(x, "max", group.Box.MaxX, group.Box.MaxY, group.Box.MaxZ);
                            x.WriteEndElement();
                        }
                        x.WriteStartElement("clashresults");
                        foreach (ClashRecord clash in section.Clashes) { WriteResult(x, clash, ++number, comments, options); }
                        x.WriteEndElement(); // clashresults
                        x.WriteEndElement(); // clashgroup
                    }
                    x.WriteEndElement(); // clashresults
                    x.WriteEndElement(); // clashtest
                }

                x.WriteEndElement(); // clashtests
                x.WriteEndElement(); // batchtest
                x.WriteEndElement(); // exchange
                x.WriteEndDocument();
            }
            return stream.ToArray();
        }

        private static void WriteSelection(XmlWriter x, ClashDocument document, string setId)
        {
            x.WriteStartElement("clashselection");
            At(x, "selfintersect", "0");
            At(x, "primtypes", "1");
            El(x, "locator", "lcop_selection_set_tree/" + SetName(document, setId));
            x.WriteEndElement();
        }

        private static void WriteResult(XmlWriter x, ClashRecord clash, int number, IReadOnlyDictionary<string, string> comments, ClashReportOptions options)
        {
            x.WriteStartElement("clashresult");
            At(x, "name", "Clash" + number.ToString(CultureInfo.InvariantCulture));
            At(x, "guid", clash.Id);
            At(x, "status", ClashStatus.Normalise(clash.Status));
            At(x, "distance", Num(clash.Crossing ? -Math.Abs(clash.Distance) : clash.Distance));
            if (clash.Approximate) { At(x, "approximate", "true"); }
            El(x, "description", clash.Crossing ? "Hard" : "Clearance");
            El(x, "resultstatus", ClashStatus.Label(clash.Status));
            x.WriteStartElement("clashpoint");
            Pos(x, "pos3f", clash.X, clash.Y, clash.Z);
            x.WriteEndElement();
            El(x, "gridlocation", options.GridOf(clash) ?? ClashGrouping.LevelOf(clash)); // grids round B
            Date(x, "createddate", clash.FoundUtc);
            Date(x, "lastseendate", clash.LastSeenUtc);
            if (clash.ResolvedUtc.HasValue) { Date(x, "resolveddate", clash.ResolvedUtc.Value); }
            if (!string.IsNullOrWhiteSpace(clash.AssignedTo)) { El(x, "assignedto", clash.AssignedTo); }
            WriteComments(x, clash.Notes, comments, clash.Id);
            x.WriteStartElement("clashobjects");
            WriteObject(x, clash.A);
            WriteObject(x, clash.B);
            x.WriteEndElement();
            x.WriteEndElement();
        }

        private static void WriteComments(XmlWriter x, string notes, IReadOnlyDictionary<string, string> comments, string id)
        {
            string comment = comments != null && comments.TryGetValue(id, out string c) ? c : null;
            if (string.IsNullOrWhiteSpace(notes) && string.IsNullOrWhiteSpace(comment)) { return; }
            x.WriteStartElement("comments");
            if (!string.IsNullOrWhiteSpace(notes))
            {
                x.WriteStartElement("comment");
                At(x, "kind", "notes");
                El(x, "body", notes);
                x.WriteEndElement();
            }
            if (!string.IsNullOrWhiteSpace(comment))
            {
                x.WriteStartElement("comment");
                At(x, "kind", "comment");
                El(x, "body", comment);
                x.WriteEndElement();
            }
            x.WriteEndElement();
        }

        private static void WriteObject(XmlWriter x, ClashElementRef element)
        {
            x.WriteStartElement("clashobject");
            x.WriteStartElement("objectattribute");
            El(x, "name", "Element ID");
            El(x, "value", element.ElementId.ToString(CultureInfo.InvariantCulture));
            x.WriteEndElement();
            El(x, "layer", string.IsNullOrWhiteSpace(element.Level) ? string.Empty : element.Level);
            x.WriteStartElement("smarttags");
            Tag(x, "Item Name", element.FamilyType);
            Tag(x, "Category", element.Category);
            Tag(x, "UniqueId", element.UniqueId);
            if (!string.IsNullOrEmpty(element.IfcGuid)) { Tag(x, "IfcGUID", element.IfcGuid); }
            if (!string.IsNullOrEmpty(element.Link)) { Tag(x, "Link Instance UniqueId", element.Link); }
            if (element.CloneKey > 0) { Tag(x, "BimGo Clone", element.CloneKey.ToString(CultureInfo.InvariantCulture)); }
            x.WriteEndElement();
            x.WriteEndElement();
        }

        private static void Tag(XmlWriter x, string name, string value)
        {
            x.WriteStartElement("smarttag");
            El(x, "name", name);
            El(x, "value", value ?? string.Empty);
            x.WriteEndElement();
        }

        private static void Pos(XmlWriter x, string name, double px, double py, double pz)
        {
            x.WriteStartElement(name);
            At(x, "x", Num(px));
            At(x, "y", Num(py));
            At(x, "z", Num(pz));
            x.WriteEndElement();
        }

        private static void Date(XmlWriter x, string name, DateTime utc)
        {
            DateTime t = utc.Kind == DateTimeKind.Local ? utc.ToUniversalTime() : utc;
            x.WriteStartElement(name);
            x.WriteStartElement("date");
            At(x, "year", t.Year.ToString(CultureInfo.InvariantCulture));
            At(x, "month", t.Month.ToString(CultureInfo.InvariantCulture));
            At(x, "day", t.Day.ToString(CultureInfo.InvariantCulture));
            At(x, "hour", t.Hour.ToString(CultureInfo.InvariantCulture));
            At(x, "minute", t.Minute.ToString(CultureInfo.InvariantCulture));
            At(x, "second", t.Second.ToString(CultureInfo.InvariantCulture));
            At(x, "utc", "true");
            x.WriteEndElement();
            x.WriteEndElement();
        }

        // Element / attribute text without the control characters XML can't hold (notes typed with odd keys, names)
        private static void El(XmlWriter x, string name, string value) => x.WriteElementString(name, XmlSafe(value));

        private static void At(XmlWriter x, string name, string value) => x.WriteAttributeString(name, XmlSafe(value));

        private static string XmlSafe(string text)
        {
            if (string.IsNullOrEmpty(text)) { return string.Empty; }
            StringBuilder clean = null;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                bool ok = c == '\t' || c == '\n' || c == '\r' || (c >= 0x20 && c != 0xFFFE && c != 0xFFFF && !char.IsSurrogate(c))
                    || (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
                    || (char.IsLowSurrogate(c) && i > 0 && char.IsHighSurrogate(text[i - 1]));
                if (ok) { clean?.Append(c); continue; }
                clean ??= new StringBuilder(text, 0, i, text.Length);
            }
            return clean?.ToString() ?? text;
        }

        private static string Num(double value) => double.IsFinite(value) ? value.ToString("0.######", CultureInfo.InvariantCulture) : "0";

        #endregion
    }
}
