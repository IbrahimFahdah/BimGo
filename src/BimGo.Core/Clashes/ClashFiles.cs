using System.Text.Json;
using BimGo.Format;

// The class belongs to the Clashes namespace
namespace BimGo.Clashes
{
    /// <summary>
    /// What importing a report changed.
    /// </summary>
    public readonly record struct ClashImportResult(int SetsAdded, int TestsAdded, int ClashesAdded, int ClashesUpdated, int Unchanged, bool SameModel);

    /// <summary>
    /// Clash storage (Round C): <c>clashes.json</c> inside a .bimgo (kept as raw bytes until clash detection is
    /// switched on, so a file opened without it costs nothing) and in a live model's BimGo folder (shared beside
    /// the model like comments when sharing is on); EXPORT / IMPORT REPORT (the same JSON, readable, with a header).
    /// Never throws: failures come back as an error text (and are logged).
    /// </summary>
    public static class ClashFiles
    {
        /// <summary>The stored document's format name.</summary>
        public const string FORMAT = "bimgo-clashes";

        /// <summary>An exported report's format name.</summary>
        public const string REPORT_FORMAT = "bimgo-clash-report";

        /// <summary>The shape's version.</summary>
        public const int VERSION = 1;

        /// <summary>Report files' extension and dialog filter.</summary>
        public const string REPORT_EXTENSION = ".json";

        /// <inheritdoc cref="REPORT_EXTENSION"/>
        public const string REPORT_FILTER = "BimGo clash report (*.json)|*.json|All files (*.*)|*.*";

        #region Bytes

        /// <summary>
        /// Reads a stored document or a report from JSON bytes (cleaned), or null with a reason.
        /// </summary>
        public static ClashDocument Parse(byte[] json, out string error)
        {
            error = null;
            if (json == null || json.Length == 0) { return null; }
            try
            {
                ClashDocument document = JsonSerializer.Deserialize<ClashDocument>(json, BimGoFormat.JSON_INDENTED);
                if (document == null) { error = "The clash data is empty."; return null; }
                if (!string.Equals(document.Format, FORMAT, StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(document.Format, REPORT_FORMAT, StringComparison.OrdinalIgnoreCase))
                {
                    error = "This is not BimGo clash data.";
                    return null;
                }
                if (document.Version > VERSION)
                {
                    error = $"This clash data was made by a newer BimGo (version {document.Version}). Please update BimGo.";
                    return null;
                }
                return document.Clean();
            }
            catch (Exception ex) when (ex is JsonException or NotSupportedException or InvalidOperationException)
            {
                error = $"The clash data could not be read: {ex.Message}";
                Utilities.Log_Utils.Write(error);
                return null;
            }
        }

        /// <summary>
        /// The stored form (compact JSON; header fields left out).
        /// </summary>
        public static byte[] Serialize(ClashDocument document)
        {
            document.Format = FORMAT;
            document.Version = VERSION;
            document.ModelTitle = null;
            document.ModelKey = null;
            document.Generator = null;
            document.ExportedUtc = null;

            // Rules carry their operator and values, with the earlier fields in step for older builds
            foreach (SearchSet set in document.Sets ?? Enumerable.Empty<SearchSet>())
            {
                set?.NormaliseRules(); // C-B4: groups too (empty groups list → left out of the file)
            }
            return JsonSerializer.SerializeToUtf8Bytes(document, BimGoFormat.JSON_COMPACT);
        }

        #endregion

        #region Model folder

        /// <summary>
        /// The clash file that goes with a live session's comments file (<c>clashes.json</c> in the model folder, or
        /// <c>&lt;model&gt;.bimgo-clashes.json</c> beside an older sidecar), or null.
        /// </summary>
        public static string SidecarFor(string commentsSidecarPath) => SidecarJson.BesideComments(commentsSidecarPath, BimGoFormat.CLASH_SIDECAR_SUFFIX);

        /// <summary>
        /// Reads a clash file (null when it doesn't exist; null with an error when it can't be read).
        /// </summary>
        public static ClashDocument Read(string path, out string error)
        {
            error = null;
            try
            {
                if (string.IsNullOrEmpty(path) || !File.Exists(path)) { return null; }
                return Parse(File.ReadAllBytes(path), out error);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                error = $"Clashes could not be read: {ex.Message}";
                Utilities.Log_Utils.Write(error);
                return null;
            }
        }

        /// <summary>
        /// Writes a clash file atomically (temp file, then replace); mirrors it beside the model when sharing is on.
        /// </summary>
        public static bool Write(string path, ClashDocument document, out string error) => WriteBytes(path, Serialize(document), "Clashes", out error);

        #endregion

        #region Report

        /// <summary>
        /// Writes a report: the whole document (sets, tests, clashes, history) as readable JSON with a header.
        /// </summary>
        public static bool ExportReport(string path, ClashDocument document, string modelTitle, string modelKey, string generator, out string error)
        {
            byte[] json;
            try
            {
                // A copy with the header filled (the stored document keeps no header)
                ClashDocument copy = JsonSerializer.Deserialize<ClashDocument>(Serialize(document), BimGoFormat.JSON_INDENTED);
                copy.Format = REPORT_FORMAT;
                copy.ModelTitle = modelTitle;
                copy.ModelKey = modelKey;
                copy.Generator = generator;
                copy.ExportedUtc = DateTime.UtcNow;
                json = JsonSerializer.SerializeToUtf8Bytes(copy, BimGoFormat.JSON_INDENTED);
            }
            catch (Exception ex) when (ex is JsonException or NotSupportedException)
            {
                error = $"The report could not be written: {ex.Message}";
                Utilities.Log_Utils.Write(error);
                return false;
            }
            return WriteBytes(path, json, "The report", out error);
        }

        /// <summary>
        /// Reads a report (or a stored clash file) and merges it into <paramref name="into"/>: sets and tests it has
        /// that are missing are added; clashes matched by test + element pair take the report's status, assignee and
        /// notes when the report's change is newer; other clashes are added; history entries not already there are added.
        /// </summary>
        /// <returns>What changed, or null with an error.</returns>
        public static ClashImportResult? ImportReport(string path, ClashDocument into, string modelKey, out string error)
        {
            ClashDocument report = Read(path, out error);
            if (report == null)
            {
                error ??= "The report file does not exist.";
                return null;
            }
            return Merge(report, into, modelKey);
        }

        /// <summary>
        /// Merges one clash document into another (see <see cref="ImportReport"/>).
        /// </summary>
        public static ClashImportResult Merge(ClashDocument from, ClashDocument into, string modelKey)
        {
            int setsAdded = 0, testsAdded = 0, added = 0, updated = 0, unchanged = 0;
            foreach (SearchSet set in from.Sets)
            {
                if (into.FindSet(set.Id) != null) { continue; }
                into.Sets.Add(set);
                setsAdded++;
            }
            foreach (ClashTest test in from.Tests)
            {
                if (into.FindTest(test.Id) != null) { continue; }
                into.Tests.Add(test);
                testsAdded++;
            }

            var ours = new Dictionary<string, ClashRecord>(StringComparer.Ordinal);
            foreach (ClashRecord clash in into.Clashes) { ours.TryAdd(clash.Key, clash); }
            foreach (ClashRecord theirs in from.Clashes)
            {
                if (!ours.TryGetValue(theirs.Key, out ClashRecord mine))
                {
                    into.Clashes.Add(theirs);
                    ours[theirs.Key] = theirs;
                    added++;
                    continue;
                }
                bool newer = theirs.Updated.HasValue && (!mine.Updated.HasValue || theirs.Updated.Value > mine.Updated.Value);
                if (!newer && (mine.CommentId != null || theirs.CommentId == null))
                {
                    unchanged++;
                    continue;
                }
                if (newer)
                {
                    mine.Status = theirs.Status;
                    mine.AssignedTo = theirs.AssignedTo;
                    mine.Notes = theirs.Notes;
                    mine.Updated = theirs.Updated;
                    mine.UpdatedBy = theirs.UpdatedBy;
                    mine.ResolvedUtc = theirs.ResolvedUtc;
                }
                mine.CommentId ??= theirs.CommentId;
                updated++;
            }

            var runs = new HashSet<(DateTime, string)>(into.Runs.Select(r => (r.Utc, r.TestId)));
            foreach (ClashRunRecord run in from.Runs)
            {
                if (runs.Add((run.Utc, run.TestId))) { into.Runs.Add(run); }
            }
            into.Runs.Sort((a, b) => a.Utc.CompareTo(b.Utc));
            into.Clean();

            bool sameModel = string.IsNullOrEmpty(from.ModelKey) || string.IsNullOrEmpty(modelKey)
                || string.Equals(from.ModelKey, modelKey, StringComparison.OrdinalIgnoreCase);
            return new ClashImportResult(setsAdded, testsAdded, added, updated, unchanged, sameModel);
        }

        #endregion

        private static bool WriteBytes(string path, byte[] bytes, string what, out string error)
        {
            error = null;
            try
            {
                string folder = Path.GetDirectoryName(Path.GetFullPath(path));
                if (!string.IsNullOrEmpty(folder)) { Directory.CreateDirectory(folder); }
                string temp = path + ".tmp";
                File.WriteAllBytes(temp, bytes);
                File.Move(temp, path, overwrite: true);
                ModelFolders.MirrorAfterWrite(path);
                return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                error = $"{what} could not be saved: {ex.Message}";
                Utilities.Log_Utils.Write(error);
                return false;
            }
        }
    }
}
