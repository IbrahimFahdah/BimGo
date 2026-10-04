using System.Text.Json;
using BimGo.Format;

// The class belongs to the Shell namespace
namespace BimGo.Shell
{
    /// <summary>
    /// One recently opened or saved file.
    /// </summary>
    internal sealed class RecentFile
    {
        public string Path { get; set; } = string.Empty;
        public DateTime LastUsedUtc { get; set; }
    }

    /// <summary>
    /// The app's recent files list (%LocalAppData%\BimGo\Recent.json), most recent first. Never throws.
    /// </summary>
    internal sealed class RecentFiles
    {
        private const int MAX_ENTRIES = 12;
        private static readonly JsonSerializerOptions OPTIONS = new() { WriteIndented = true, PropertyNameCaseInsensitive = true };

        /// <summary>The entries, most recent first.</summary>
        public List<RecentFile> Entries { get; private set; } = new();

        /// <summary>The file path.</summary>
        public static string FilePath => System.IO.Path.Combine(Utilities.Log_Utils.Folder, "Recent.json");

        /// <summary>
        /// Loads the list (empty if missing or unreadable).
        /// </summary>
        public static RecentFiles Load()
        {
            var recent = new RecentFiles();
            try
            {
                if (File.Exists(FilePath))
                {
                    List<RecentFile> entries = JsonSerializer.Deserialize<List<RecentFile>>(File.ReadAllText(FilePath), OPTIONS);
                    if (entries != null)
                    {
                        recent.Entries = entries
                            .Where(e => e != null && !string.IsNullOrWhiteSpace(e.Path))
                            .GroupBy(e => e.Path, StringComparer.OrdinalIgnoreCase)
                            .Select(g => g.OrderByDescending(e => e.LastUsedUtc).First())
                            .OrderByDescending(e => e.LastUsedUtc)
                            .Take(MAX_ENTRIES)
                            .ToList();
                    }
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Recent files could not be read: {ex.Message}");
            }
            return recent;
        }

        /// <summary>
        /// Moves a path to the top of the list and saves.
        /// </summary>
        public void Touch(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) { return; }
            string full = SafeFullPath(path);
            Entries.RemoveAll(e => string.Equals(e.Path, full, StringComparison.OrdinalIgnoreCase));
            Entries.Insert(0, new RecentFile { Path = full, LastUsedUtc = DateTime.UtcNow });
            if (Entries.Count > MAX_ENTRIES) { Entries.RemoveRange(MAX_ENTRIES, Entries.Count - MAX_ENTRIES); }
            Save();
        }

        /// <summary>
        /// Removes a path and saves.
        /// </summary>
        public void Remove(string path)
        {
            if (Entries.RemoveAll(e => string.Equals(e.Path, path, StringComparison.OrdinalIgnoreCase)) > 0) { Save(); }
        }

        private void Save()
        {
            try
            {
                Directory.CreateDirectory(Utilities.Log_Utils.Folder);
                string temp = FilePath + ".tmp";
                File.WriteAllText(temp, JsonSerializer.Serialize(Entries, OPTIONS));
                File.Move(temp, FilePath, overwrite: true);
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Recent files could not be saved: {ex.Message}");
            }
        }

        private static string SafeFullPath(string path)
        {
            try { return System.IO.Path.GetFullPath(path); }
            catch { return path; }
        }
    }

    /// <summary>
    /// Summary of a recent file for the home screen (read once from its manifest).
    /// </summary>
    internal sealed class RecentInfo
    {
        public bool Exists { get; init; }
        public string Title { get; init; }
        public string Detail { get; init; }

        /// <summary>
        /// Reads a file's manifest (cheap: only manifest.json is decompressed).
        /// </summary>
        public static RecentInfo For(string path)
        {
            if (!File.Exists(path)) { return new RecentInfo { Exists = false, Title = System.IO.Path.GetFileName(path), Detail = "File not found" }; }

            ManifestDto manifest = BimGoReader.ReadManifest(path, out string error);
            if (manifest == null) { return new RecentInfo { Exists = true, Title = System.IO.Path.GetFileName(path), Detail = error ?? "Unreadable" }; }

            CountsDto counts = manifest.Counts ?? new CountsDto();
            string edits = counts.JournalEntries > 0 ? $" · {counts.JournalEntries} edits" : string.Empty;
            string revit = string.IsNullOrEmpty(manifest.Provenance?.RevitVersion) ? string.Empty : $" · Revit {manifest.Provenance.RevitVersion}";
            return new RecentInfo
            {
                Exists = true,
                Title = string.IsNullOrWhiteSpace(manifest.Title) ? System.IO.Path.GetFileNameWithoutExtension(path) : manifest.Title,
                Detail = $"{counts.Elements:N0} elements{edits}{revit}"
            };
        }
    }
}
