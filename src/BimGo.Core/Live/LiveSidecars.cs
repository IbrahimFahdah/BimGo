using System.Text.Json;
using BimGo.Format;

// The class belongs to the Live namespace
namespace BimGo.Live
{
    /// <summary>
    /// The sidecar files beside a Revit model (comments, bookmarks, sun, visibility), read and written for a browser
    /// walkthrough, which can't reach the disk itself (sidecar.read / sidecar.write). Same files and shapes as the
    /// desktop app writes, so both can work on the same model.
    /// </summary>
    public static class LiveSidecars
    {
        /// <summary>
        /// Reads one sidecar.
        /// </summary>
        /// <param name="commentsPath">The session's comment sidecar path (<see cref="SessionInfo.CommentsPath"/>).</param>
        /// <param name="kind">One of <see cref="SidecarKinds"/>.</param>
        /// <returns>The answer: the document (null when the file doesn't exist yet), or a failure.</returns>
        public static SidecarPayload Read(string commentsPath, string kind)
        {
            if (string.IsNullOrEmpty(commentsPath)) { return Fail(kind, "This model has no folder for comments (save the Revit model first)."); }

            object document;
            string error;
            switch (kind)
            {
                case SidecarKinds.COMMENTS:
                    CommentFiles.MigrateLegacy(commentsPath);
                    document = CommentFiles.Read(commentsPath, out error);
                    break;
                case SidecarKinds.BOOKMARKS:
                    document = BookmarkFiles.Read(BookmarkFiles.SidecarFor(commentsPath), out error);
                    break;
                case SidecarKinds.SUN:
                    document = SunFiles.Read(SunFiles.SidecarFor(commentsPath), out error);
                    break;
                case SidecarKinds.VISIBILITY:
                    document = VisibilityFiles.Read(VisibilityFiles.SidecarFor(commentsPath), out error);
                    break;
                default:
                    return Fail(kind, $"Unknown sidecar '{kind}'.");
            }

            if (error != null) { return Fail(kind, error); }
            return new SidecarPayload
            {
                Kind = kind,
                Document = document == null ? null : JsonSerializer.SerializeToElement(document, document.GetType(), LiveProtocol.JSON),
                Success = true
            };
        }

        /// <summary>
        /// Replaces one sidecar with the document in a request.
        /// </summary>
        /// <param name="commentsPath">The session's comment sidecar path.</param>
        /// <param name="request">The kind and the new document.</param>
        /// <returns>The outcome (kind, success, message).</returns>
        public static SidecarPayload Write(string commentsPath, SidecarPayload request)
        {
            string kind = request?.Kind ?? string.Empty;
            if (string.IsNullOrEmpty(commentsPath)) { return Fail(kind, "This model has no folder for comments (save the Revit model first)."); }
            if (request?.Document is not JsonElement json || json.ValueKind != JsonValueKind.Object) { return Fail(kind, "No document to write."); }

            try
            {
                bool written;
                string error;
                switch (kind)
                {
                    case SidecarKinds.COMMENTS:
                        written = CommentFiles.Write(commentsPath, Clean(json.Deserialize<CommentDocument>(LiveProtocol.JSON)), out error);
                        break;
                    case SidecarKinds.BOOKMARKS:
                        written = BookmarkFiles.Write(BookmarkFiles.SidecarFor(commentsPath), json.Deserialize<BookmarkDocument>(LiveProtocol.JSON)?.Clean() ?? new BookmarkDocument(), out error);
                        break;
                    case SidecarKinds.SUN:
                        SunSettings sun = json.Deserialize<SunSettings>(LiveProtocol.JSON)?.Clean();
                        if (sun == null) { return Fail(kind, "No sun settings to write."); }
                        written = SunFiles.Write(SunFiles.SidecarFor(commentsPath), sun, out error);
                        break;
                    case SidecarKinds.VISIBILITY:
                        written = VisibilityFiles.Write(VisibilityFiles.SidecarFor(commentsPath), json.Deserialize<VisibilitySettings>(LiveProtocol.JSON)?.Clean() ?? new VisibilitySettings(), out error);
                        break;
                    default:
                        return Fail(kind, $"Unknown sidecar '{kind}'.");
                }
                return written ? new SidecarPayload { Kind = kind, Success = true } : Fail(kind, error);
            }
            catch (JsonException ex)
            {
                return Fail(kind, $"The {kind} could not be read from the viewer: {ex.Message}");
            }
        }

        private static CommentDocument Clean(CommentDocument document)
        {
            document ??= new CommentDocument();
            document.Comments ??= new List<CommentRecord>();
            document.Comments.RemoveAll(c => c == null || string.IsNullOrWhiteSpace(c.Text));
            return document;
        }

        private static SidecarPayload Fail(string kind, string message) => new() { Kind = kind ?? string.Empty, Success = false, Message = message };
    }
}
