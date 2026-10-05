// The class belongs to the Format namespace
namespace BimGo.Format
{
    /// <summary>
    /// Reads and writes the bookmark sidecar kept beside a Revit model (&lt;model&gt;.bimgo-bookmarks.json, next to the
    /// comments sidecar). Same JSON as bookmarks.json inside a .bimgo. Never throws.
    /// </summary>
    public static class BookmarkFiles
    {
        /// <summary>
        /// The bookmark sidecar that goes with a comments sidecar (same folder and base name), or null.
        /// </summary>
        public static string SidecarFor(string commentsSidecarPath) => SidecarJson.BesideComments(commentsSidecarPath, BimGoFormat.BOOKMARK_SIDECAR_SUFFIX);

        /// <summary>
        /// Reads a sidecar.
        /// </summary>
        /// <param name="path">The sidecar path.</param>
        /// <param name="error">A reason on failure (null when the file simply doesn't exist).</param>
        /// <returns>The bookmarks, or null if the file doesn't exist or can't be read.</returns>
        public static BookmarkDocument Read(string path, out string error) => SidecarJson.Read<BookmarkDocument>(path, "Bookmarks", out error)?.Clean();

        /// <summary>
        /// Writes a sidecar atomically (temp file, then replace).
        /// </summary>
        /// <returns>True on success.</returns>
        public static bool Write(string path, BookmarkDocument document, out string error) => SidecarJson.Write(path, document, "Bookmarks", out error);
    }
}
