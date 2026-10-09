using System.Globalization;
using System.Numerics;
using BimGo.Format;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// The session's comments, persisted one of two ways:
    /// <list type="bullet">
    /// <item><b>Sidecar</b> (Revit sessions): &lt;model&gt;.bimgo-comments.json beside the model, saved on every change.</item>
    /// <item><b>Embedded</b> (.bimgo files): kept in memory and saved with the file; changes raise <see cref="Changed"/>
    /// so the document can be marked dirty.</item>
    /// </list>
    /// All IO failures are caught and reported via <see cref="LastError"/>.
    /// </summary>
    internal sealed class CommentStore
    {
        private readonly string _path;
        private readonly string _model;
        private readonly Vector3 _origin;

        /// <summary>All comments.</summary>
        public List<CommentRecord> Comments { get; } = new();

        /// <summary>The last IO error, or null.</summary>
        public string LastError { get; private set; }

        /// <summary>True when comments live inside a .bimgo file rather than a sidecar.</summary>
        public bool IsEmbedded => _path == null;

        /// <summary>Where comments are kept (for the HUD).</summary>
        public string FileName => IsEmbedded ? "this file"
            : ModelFolders.FolderOf(_path) != null ? "BimGo's folder for this model"
            : Path.GetFileName(_path);

        /// <summary>Incremented on every change (dirty tracking for embedded comments).</summary>
        public int Revision { get; private set; }

        /// <summary>Raised after any change.</summary>
        public event Action Changed;

        /// <summary>
        /// Creates the store.
        /// </summary>
        /// <param name="sidecarPath">Sidecar path, or null to keep comments embedded in the document.</param>
        /// <param name="model">Model title.</param>
        /// <param name="origin">Scene origin offset (metres).</param>
        public CommentStore(string sidecarPath, string model, Vector3 origin)
        {
            _path = sidecarPath;
            _model = model;
            _origin = origin;
        }

        /// <summary>
        /// Loads the sidecar (migrating a legacy RvtGo sidecar first). No-op for embedded stores.
        /// </summary>
        public void Load()
        {
            if (IsEmbedded) { return; }
            CommentFiles.MigrateLegacy(_path);
            CommentDocument document = CommentFiles.Read(_path, out string error);
            LastError = error;
            if (document != null) { LoadFrom(document); }
        }

        /// <summary>
        /// Loads comments from a document (a .bimgo's comments.json). Does not count as a change.
        /// </summary>
        public void LoadFrom(CommentDocument document)
        {
            if (document?.Comments == null) { return; }
            foreach (CommentRecord record in document.Comments)
            {
                if (record == null || string.IsNullOrWhiteSpace(record.Text)) { continue; }
                Prepare(record);
                Comments.Add(record);
            }
        }

        /// <summary>
        /// The comments as a document (for saving into a .bimgo).
        /// </summary>
        public CommentDocument ToDocument() => new() { Model = _model, Comments = Comments.ToList() };

        /// <summary>
        /// Adds a comment at a scene-local position and saves.
        /// </summary>
        public CommentRecord Add(Vector3 local, string text, long elementId, string level)
        {
            var record = new CommentRecord
            {
                Text = text.Trim(),
                X = Math.Round(local.X + (double)_origin.X, 4),
                Y = Math.Round(local.Y + (double)_origin.Y, 4),
                Z = Math.Round(local.Z + (double)_origin.Z, 4),
                ElementId = elementId,
                Level = level ?? string.Empty
            };
            Prepare(record);
            Comments.Add(record);
            Save();
            return record;
        }

        /// <summary>
        /// Changes a comment's text (recording who and when) and saves.
        /// </summary>
        /// <returns>False if the comment is not in this store or the text is empty.</returns>
        public bool Update(CommentRecord record, string text)
        {
            if (record == null || !Comments.Contains(record) || string.IsNullOrWhiteSpace(text)) { return false; }
            text = text.Trim();
            if (text == record.Text) { return true; }

            record.Text = text;
            record.Edited = DateTimeOffset.Now;
            record.EditedBy = Environment.UserName;
            Prepare(record);
            Save();
            return true;
        }

        /// <summary>
        /// Sets a comment's status, priority and / or assignee (null leaves a field alone; an empty assignee clears
        /// it), recording who and when, and saves.
        /// </summary>
        /// <returns>False if the comment is not in this store or nothing changed.</returns>
        public bool SetIssue(CommentRecord record, string status = null, string priority = null, string assignedTo = null)
        {
            if (record == null || !Comments.Contains(record)) { return false; }
            bool changed = false;
            if (status != null && CommentStatus.Normalise(status) != record.Status) { record.Status = CommentStatus.Normalise(status); changed = true; }
            if (priority != null && CommentPriority.Normalise(priority) != record.Priority) { record.Priority = CommentPriority.Normalise(priority); changed = true; }
            if (assignedTo != null)
            {
                string assignee = string.IsNullOrWhiteSpace(assignedTo) ? null : assignedTo.Trim();
                if (assignee != record.AssignedTo) { record.AssignedTo = assignee; changed = true; }
            }
            if (!changed) { return false; }
            record.Updated = DateTimeOffset.Now;
            record.UpdatedBy = Environment.UserName;
            record.UpdatedLabel = null;
            Save();
            return true;
        }

        /// <summary>
        /// Adds a reply to a comment's thread and saves.
        /// </summary>
        /// <returns>The reply, or null (unknown comment or empty text).</returns>
        public CommentReply AddReply(CommentRecord record, string text)
        {
            if (record == null || !Comments.Contains(record) || string.IsNullOrWhiteSpace(text)) { return null; }
            var reply = new CommentReply { Text = text.Trim() };
            (record.Replies ??= new List<CommentReply>()).Add(reply);
            Save();
            return reply;
        }

        /// <summary>
        /// Removes a reply and saves.
        /// </summary>
        public void RemoveReply(CommentRecord record, CommentReply reply)
        {
            if (record?.Replies == null || !record.Replies.Remove(reply)) { return; }
            if (record.Replies.Count == 0) { record.Replies = null; }
            Save();
        }

        /// <summary>
        /// Sets the viewpoint a comment is seen from (scene-local feet; stored in Revit internal metres) and saves.
        /// The thumbnail follows separately (taken the next frame: <see cref="SetThumbnail"/>).
        /// </summary>
        public void SetView(CommentRecord record, Vector3 localFeet, float yaw, float pitch, bool flying, bool save = true)
        {
            if (record == null) { return; }
            record.View = new CommentView
            {
                X = Math.Round(localFeet.X + (double)_origin.X, 4),
                Y = Math.Round(localFeet.Y + (double)_origin.Y, 4),
                Z = Math.Round(localFeet.Z + (double)_origin.Z, 4),
                Yaw = yaw,
                Pitch = pitch,
                Flying = flying
            };
            if (save && Comments.Contains(record)) { Save(); }
        }

        /// <summary>The scene-local feet of a comment's saved view (false when it has none).</summary>
        public bool TryGetView(CommentRecord record, out Vector3 localFeet)
        {
            localFeet = Vector3.Zero;
            if (record?.View == null) { return false; }
            localFeet = new Vector3((float)(record.View.X - _origin.X), (float)(record.View.Y - _origin.Y), (float)(record.View.Z - _origin.Z));
            return true;
        }

        /// <summary>
        /// Stores a comment's thumbnail (base64 JPEG) and saves.
        /// </summary>
        public void SetThumbnail(CommentRecord record, string data)
        {
            if (record == null || string.IsNullOrEmpty(data)) { return; }
            record.Thumbnail = data;
            if (Comments.Contains(record)) { Save(); }
        }

        /// <summary>
        /// Removes a comment and saves.
        /// </summary>
        public void Remove(CommentRecord record)
        {
            if (Comments.Remove(record)) { Save(); }
        }

        /// <summary>
        /// Removes all comments and saves.
        /// </summary>
        public void Clear()
        {
            Comments.Clear();
            Save();
        }

        /// <summary>
        /// Records a change: writes the sidecar, or (embedded) just flags the change for the document.
        /// </summary>
        /// <returns>True on success.</returns>
        public bool Save()
        {
            Revision++;
            bool saved = true;
            if (!IsEmbedded)
            {
                saved = CommentFiles.Write(_path, ToDocument(), out string error);
                LastError = error;
            }

            try { Changed?.Invoke(); }
            catch (Exception ex) { Utilities.Log_Utils.Write($"Comment change handler failed: {ex.Message}"); }
            return saved;
        }

        /// <summary>
        /// Writes every comment to a CSV file (UTF-8 with BOM so Excel reads accents). Coordinates are Revit internal
        /// metres, as stored.
        /// </summary>
        /// <returns>Null on success, else a short reason.</returns>
        public string ExportCsv(string path)
        {
            try
            {
                var lines = new List<string> { "Id,Author,Created,Edited,Edited by,Status,Priority,Assigned to,Replies,Last reply,Level,Element id,X (m),Y (m),Z (m),Text,Thread" };
                foreach (CommentRecord record in Comments)
                {
                    lines.Add(string.Join(",",
                        record.Id,
                        Csv(record.Author),
                        record.Created.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture),
                        record.Edited?.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) ?? string.Empty,
                        Csv(record.EditedBy),
                        CommentStatus.Label(record.Status),
                        CommentPriority.Label(record.Priority),
                        Csv(record.AssignedTo),
                        record.ReplyCount.ToString(CultureInfo.InvariantCulture),
                        record.ReplyCount > 0 ? record.Replies[^1].Created.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) : string.Empty,
                        Csv(record.Level),
                        record.ElementId > 0 ? record.ElementId.ToString(CultureInfo.InvariantCulture) : string.Empty,
                        record.X.ToString("0.###", CultureInfo.InvariantCulture),
                        record.Y.ToString("0.###", CultureInfo.InvariantCulture),
                        record.Z.ToString("0.###", CultureInfo.InvariantCulture),
                        Csv(record.Text),
                        Csv(Thread(record))));
                }
                File.WriteAllLines(path, lines, new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: true));
                return null;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Comment export failed: {ex}");
                return ex.Message;
            }
        }

        /// <summary>
        /// The replies as one text: "author (yyyy-MM-dd HH:mm): text" per line.
        /// </summary>
        private static string Thread(CommentRecord record)
        {
            if (record.ReplyCount == 0) { return string.Empty; }
            return string.Join("\n", record.Replies.Select(r =>
                $"{r.Author} ({r.Created.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)}): {r.Text}"));
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

        private void Prepare(CommentRecord record)
        {
            record.Clean();
            record.Local = new Vector3((float)(record.X - _origin.X), (float)(record.Y - _origin.Y), (float)(record.Z - _origin.Z));
            string edited = record.Edited.HasValue ? " · EDITED" : string.Empty;
            record.Header = $"COMMENT · {record.Author?.ToUpperInvariant()} · {record.Created.ToLocalTime():dd MMM HH:mm}{edited}";
        }
    }
}
