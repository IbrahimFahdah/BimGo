using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using BimGo.Format;

// The class belongs to the Live namespace
namespace BimGo.Live
{
    /// <summary>
    /// The app ↔ Revit session protocol (version 1): a watched folder per Revit document.
    /// <code>
    /// %LocalAppData%\BimGo\Sessions\&lt;sessionId&gt;\
    ///   session.json     written by Revit: identity, state, heartbeat, latest snapshot
    ///   app.json         written by the attached app: pid, heartbeat
    ///   to-revit\        app → Revit messages
    ///   to-app\          Revit → app messages
    ///   snapshots\       .bimgo snapshots written by Revit (large geometry never travels in messages)
    /// </code>
    /// Every message is one JSON <see cref="Envelope"/> file, written atomically (temp file, then rename) and deleted
    /// by the reader once handled. Nothing in a message is ever executed; readers validate the session id, the
    /// protocol version and the size.
    /// </summary>
    public static class LiveProtocol
    {
        /// <summary>The protocol version written in every envelope and session.json.</summary>
        public const int VERSION = 1;

        /// <summary>Seconds between heartbeats (Revit's session.json and the app's app.json).</summary>
        public const int HEARTBEAT_SECONDS = 2;

        /// <summary>A heartbeat older than this means the other side is gone (or hung).</summary>
        public const int HEARTBEAT_TIMEOUT_SECONDS = 10;

        /// <summary>Largest message accepted (bytes).</summary>
        public const long MAX_MESSAGE_BYTES = 4L * 1024 * 1024;

        /// <summary>Session folders older than this (by heartbeat) are deleted on startup.</summary>
        public static readonly TimeSpan STALE_AFTER = TimeSpan.FromDays(1);

        /// <summary>JSON options for protocol files (camelCase, Vector3 as arrays, enums as strings).</summary>
        internal static readonly JsonSerializerOptions JSON = BimGoFormat.JSON_COMPACT;

        /// <summary>Readable JSON for session.json / app.json.</summary>
        internal static readonly JsonSerializerOptions JSON_INDENTED = BimGoFormat.JSON_INDENTED;

        #region Paths

        /// <summary>%LocalAppData%\BimGo\Sessions.</summary>
        public static string SessionsRoot => Path.Combine(Utilities.Log_Utils.Folder, "Sessions");

        /// <summary>A session's folder.</summary>
        public static string FolderFor(string sessionId) => Path.Combine(SessionsRoot, sessionId);

        /// <summary>A session's session.json.</summary>
        public static string InfoPath(string sessionId) => Path.Combine(FolderFor(sessionId), "session.json");

        /// <summary>A session's app.json (the attached app's heartbeat).</summary>
        public static string AttachmentPath(string sessionId) => Path.Combine(FolderFor(sessionId), "app.json");

        /// <summary>App → Revit messages.</summary>
        public static string ToRevitFolder(string sessionId) => Path.Combine(FolderFor(sessionId), "to-revit");

        /// <summary>Revit → app messages.</summary>
        public static string ToAppFolder(string sessionId) => Path.Combine(FolderFor(sessionId), "to-app");

        /// <summary>Snapshot .bimgo files.</summary>
        public static string SnapshotsFolder(string sessionId) => Path.Combine(FolderFor(sessionId), "snapshots");

        #endregion

        #region Helpers

        /// <summary>
        /// A new session id (32 lower-case hex characters).
        /// </summary>
        public static string NewSessionId() => Guid.NewGuid().ToString("N");

        /// <summary>
        /// True for a well-formed session id (guards every path built from one).
        /// </summary>
        public static bool IsValidSessionId(string sessionId)
        {
            if (string.IsNullOrEmpty(sessionId) || sessionId.Length != 32) { return false; }
            foreach (char c in sessionId)
            {
                bool hex = c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F';
                if (!hex) { return false; }
            }
            return true;
        }

        /// <summary>
        /// True if a process with this id is running.
        /// </summary>
        public static bool IsProcessAlive(int processId)
        {
            if (processId <= 0) { return false; }
            try
            {
                using Process process = Process.GetProcessById(processId);
                return !process.HasExited;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Writes JSON atomically (temp file in the same folder, then replace).
        /// </summary>
        internal static void WriteJsonAtomic<T>(string path, T value, JsonSerializerOptions options)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temp = path + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(value, options));
            File.Move(temp, path, overwrite: true);
        }

        /// <summary>
        /// Reads JSON, retrying briefly while another process is replacing the file. Null if missing or unreadable.
        /// </summary>
        internal static T ReadJson<T>(string path, JsonSerializerOptions options) where T : class
        {
            for (int attempt = 0; attempt < 4; attempt++)
            {
                try
                {
                    if (!File.Exists(path)) { return null; }
                    if (new FileInfo(path).Length > MAX_MESSAGE_BYTES) { return null; }
                    return JsonSerializer.Deserialize<T>(File.ReadAllText(path), options);
                }
                catch (IOException)
                {
                    Thread.Sleep(15); // being replaced: try again
                }
                catch (UnauthorizedAccessException)
                {
                    Thread.Sleep(15);
                }
                catch (JsonException)
                {
                    return null;
                }
            }
            return null;
        }

        #endregion
    }

    /// <summary>
    /// Message types (<see cref="Envelope.Type"/>).
    /// </summary>
    public static class MessageTypes
    {
        /// <summary>app → Revit: the app attached (<see cref="HelloPayload"/>).</summary>
        public const string HELLO = "hello";

        /// <summary>Revit → app: reply to hello (<see cref="HelloAckPayload"/>).</summary>
        public const string HELLO_ACK = "hello.ack";

        /// <summary>app → Revit: re-extract and write a new snapshot (<see cref="RefreshRequestPayload"/>).</summary>
        public const string EXTRACT_REQUEST = "extract.request";

        /// <summary>Revit → app: a new snapshot is ready (<see cref="SnapshotReadyPayload"/>).</summary>
        public const string EXTRACT_READY = "extract.ready";

        /// <summary>Revit → app: the extraction failed (<see cref="MessagePayload"/>).</summary>
        public const string EXTRACT_FAILED = "extract.failed";

        /// <summary>app → Revit: an edit (<see cref="Edits.EditRequest"/>).</summary>
        public const string EDIT = "edit";

        /// <summary>Revit → app: the edit's outcome (<see cref="Edits.EditResult"/>).</summary>
        public const string EDIT_RESULT = "edit.result";

        /// <summary>app → Revit: select and show elements (<see cref="SelectPayload"/>).</summary>
        public const string SELECT = "select.elements";

        /// <summary>Revit → app: the selection outcome (<see cref="MessagePayload"/>).</summary>
        public const string SELECT_RESULT = "select.result";

        /// <summary>Revit → app: the model changed outside BimGo (<see cref="ModelChangedPayload"/>).</summary>
        public const string MODEL_CHANGED = "model.changed";

        /// <summary>Revit → app: the document is closing or Revit is exiting (<see cref="MessagePayload"/>).</summary>
        public const string SESSION_CLOSING = "session.closing";

        /// <summary>app → Revit: the app is leaving the session.</summary>
        public const string DETACH = "detach";

        /// <summary>
        /// app → Revit: push a standalone file's journal into the model (<see cref="JournalApplyPayload"/>). Sent over a
        /// temporary channel (<see cref="JournalPush"/>) by an app that is not attached as the session's walkthrough.
        /// </summary>
        public const string JOURNAL_APPLY = "journal.apply";

        /// <summary>Revit → app: the per-entry outcome of a push or dry run (<see cref="JournalResultPayload"/>).</summary>
        public const string JOURNAL_RESULT = "journal.result";
    }

    /// <summary>
    /// Values of <see cref="SessionInfo.State"/>.
    /// </summary>
    public static class SessionStates
    {
        public const string STARTING = "starting";
        public const string READY = "ready";
        public const string BUSY = "busy";
        public const string CLOSED = "closed";
    }

    #region Files

    /// <summary>
    /// session.json: written by the Revit add-in, read by the app.
    /// </summary>
    public sealed class SessionInfo
    {
        public int Protocol { get; set; } = LiveProtocol.VERSION;
        public string SessionId { get; set; } = string.Empty;
        public string State { get; set; } = SessionStates.STARTING;

        public string RevitVersion { get; set; } = string.Empty;
        public int RevitPid { get; set; }
        public string AddinVersion { get; set; } = string.Empty;

        public string DocTitle { get; set; } = string.Empty;
        public string DocPath { get; set; } = string.Empty;

        /// <summary>ProjectInformation.UniqueId (model identity).</summary>
        public string ModelKey { get; set; } = string.Empty;

        /// <summary>The "new" phase (the walkthrough's phase).</summary>
        public string PhaseName { get; set; }

        /// <summary>The "existing" phase, or null.</summary>
        public string ExistingPhaseName { get; set; }

        /// <summary>The comment sidecar beside the model (the app reads and writes it directly).</summary>
        public string CommentsPath { get; set; }

        /// <summary>The newest snapshot (.bimgo), or null before the first extraction.</summary>
        public string LatestSnapshot { get; set; }

        /// <summary>Increments with every snapshot.</summary>
        public int SnapshotNumber { get; set; }

        public DateTime SnapshotUtc { get; set; }
        public DateTime CreatedUtc { get; set; }
        public DateTime HeartbeatUtc { get; set; }

        /// <summary>
        /// True if Revit is alive and the session open: state not closed, a recent heartbeat and the process running.
        /// </summary>
        public bool IsAlive()
        {
            if (State == SessionStates.CLOSED) { return false; }
            if ((DateTime.UtcNow - HeartbeatUtc).TotalSeconds > LiveProtocol.HEARTBEAT_TIMEOUT_SECONDS) { return false; }
            return LiveProtocol.IsProcessAlive(RevitPid);
        }
    }

    /// <summary>
    /// app.json: written by the attached app (deleted when it detaches).
    /// </summary>
    public sealed class AppAttachment
    {
        public int AppPid { get; set; }
        public string AppVersion { get; set; } = string.Empty;
        public DateTime AttachedUtc { get; set; }
        public DateTime HeartbeatUtc { get; set; }

        /// <summary>True if the app's heartbeat is recent and its process runs.</summary>
        public bool IsAlive() =>
            (DateTime.UtcNow - HeartbeatUtc).TotalSeconds <= LiveProtocol.HEARTBEAT_TIMEOUT_SECONDS && LiveProtocol.IsProcessAlive(AppPid);
    }

    #endregion

    #region Messages

    /// <summary>
    /// One protocol message.
    /// </summary>
    public sealed class Envelope
    {
        public int Protocol { get; set; } = LiveProtocol.VERSION;
        public string Id { get; set; } = Guid.NewGuid().ToString("N");
        public long Seq { get; set; }
        public string SessionId { get; set; } = string.Empty;
        public string Type { get; set; } = string.Empty;

        /// <summary>The <see cref="Id"/> of the message this answers, or null.</summary>
        public string ReplyTo { get; set; }

        public DateTime SentUtc { get; set; }

        /// <summary>The type-specific payload.</summary>
        public JsonElement Payload { get; set; }

        /// <summary>
        /// Reads the payload as a type (null if absent or unreadable).
        /// </summary>
        public T Read<T>() where T : class
        {
            try
            {
                if (Payload.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null) { return null; }
                return Payload.Deserialize<T>(LiveProtocol.JSON);
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }

    public sealed class HelloPayload
    {
        public int AppPid { get; set; }
        public string AppVersion { get; set; } = string.Empty;
    }

    public sealed class HelloAckPayload
    {
        public string DocTitle { get; set; } = string.Empty;
        public string RevitVersion { get; set; } = string.Empty;
        public string PhaseName { get; set; }
        public string ExistingPhaseName { get; set; }
    }

    public sealed class RefreshRequestPayload
    {
        /// <summary>Why ("refresh" from F5, ...).</summary>
        public string Reason { get; set; } = "refresh";
    }

    public sealed class SnapshotReadyPayload
    {
        public string Path { get; set; } = string.Empty;
        public int SnapshotNumber { get; set; }
        public int Elements { get; set; }
        public int Triangles { get; set; }
        public double Seconds { get; set; }

        /// <summary>"go" (Go pressed in Revit) or "refresh" (requested by the app).</summary>
        public string Reason { get; set; } = "refresh";
    }

    public sealed class SelectPayload
    {
        public long[] ElementIds { get; set; } = Array.Empty<long>();

        /// <summary>
        /// Optional (v7, additive): elements inside linked models to select by link reference. <see cref="ElementIds"/>
        /// then holds their link instances, which is what an older add-in selects instead.
        /// </summary>
        public LinkedElementRef[] Linked { get; set; }
    }

    /// <summary>
    /// An element inside a Revit link: the host's RevitLinkInstance id and the element's id in the linked model.
    /// </summary>
    public sealed class LinkedElementRef
    {
        public long LinkInstanceId { get; set; }
        public long ElementId { get; set; }
    }

    public sealed class ModelChangedPayload
    {
        public int Added { get; set; }
        public int Modified { get; set; }
        public int Deleted { get; set; }

        [JsonIgnore]
        public int Total => Added + Modified + Deleted;
    }

    #region Journal push

    /// <summary>
    /// Values of <see cref="JournalEntryResult.Status"/>.
    /// </summary>
    public static class JournalStatus
    {
        /// <summary>Applied (or, in a dry run, would be applied).</summary>
        public const string APPLIED = "applied";

        /// <summary>Not applied: the target is missing or depends on an entry that wasn't applied.</summary>
        public const string SKIPPED = "skipped";

        /// <summary>The element moved in Revit since the file was made; skipped unless conflicts are applied.</summary>
        public const string CONFLICT = "conflict";

        /// <summary>Revit refused the change.</summary>
        public const string FAILED = "failed";

        /// <summary>The model already has this change (e.g. already demolished or deleted).</summary>
        public const string ALREADY_APPLIED = "alreadyApplied";
    }

    /// <summary>
    /// A clone made by an earlier push or a live session: its key in the file and its element in Revit. Lets a
    /// pushed entry target a clone that is already in the model.
    /// </summary>
    public sealed class CloneRef
    {
        public int CloneKey { get; set; }
        public long ElementId { get; set; }
    }

    /// <summary>
    /// journal.apply: the file's entries not yet in Revit, in journal order.
    /// </summary>
    public sealed class JournalApplyPayload
    {
        /// <summary>Echoed in the result.</summary>
        public string RequestId { get; set; } = Guid.NewGuid().ToString("N");

        /// <summary>Apply everything, report, then roll it all back (a preview).</summary>
        public bool DryRun { get; set; } = true;

        /// <summary>How far an element may have moved since the file was made before it counts as a conflict.</summary>
        public double ToleranceMm { get; set; } = 5.0;

        /// <summary>Apply conflicting moves / clones anyway, relative to where the element is now.</summary>
        public bool ApplyConflicts { get; set; }

        /// <summary>The file's model key (ProjectInformation.UniqueId); Revit refuses a push for another model.</summary>
        public string ModelKey { get; set; } = string.Empty;

        /// <summary>The file's "new" phase name (demolitions and clones go to the model's phase of that name).</summary>
        public string PhaseName { get; set; }

        /// <summary>The file's "existing" phase name.</summary>
        public string ExistingPhaseName { get; set; }

        /// <summary>The file's name, for the undo label and the log.</summary>
        public string FileName { get; set; } = string.Empty;

        /// <summary>Clones already in Revit that entries may target.</summary>
        public List<CloneRef> KnownClones { get; set; } = new();

        /// <summary>The entries to apply, in order.</summary>
        public List<Edits.JournalEntry> Entries { get; set; } = new();

        /// <summary>
        /// Set instead of inline entries when the request is too big for a message: the full request as JSON in the
        /// session's snapshots folder (Revit only reads it from there).
        /// </summary>
        public string PayloadPath { get; set; }
    }

    /// <summary>
    /// The outcome of one pushed entry.
    /// </summary>
    public sealed class JournalEntryResult
    {
        /// <summary>The entry's <see cref="Edits.JournalEntry.Seq"/>.</summary>
        public int Seq { get; set; }

        /// <summary>One of <see cref="JournalStatus"/>.</summary>
        public string Status { get; set; } = JournalStatus.SKIPPED;

        /// <summary>A short, user-facing reason or note.</summary>
        public string Message { get; set; } = string.Empty;

        /// <summary>For clones: the new element's id (0 otherwise, and 0 in a dry run).</summary>
        public long NewElementId { get; set; }

        /// <summary>Elements Revit removed with a demolish / delete (the target included).</summary>
        public int Affected { get; set; }
    }

    /// <summary>
    /// journal.result: what happened to each entry, with totals.
    /// </summary>
    public sealed class JournalResultPayload
    {
        public string RequestId { get; set; } = string.Empty;
        public bool DryRun { get; set; }

        /// <summary>False if the push could not run at all (see <see cref="Message"/>); no entry was applied.</summary>
        public bool Success { get; set; } = true;

        /// <summary>A note for the whole push (phase fallback, or why it could not run).</summary>
        public string Message { get; set; }

        /// <summary>The phases Revit used.</summary>
        public string PhaseName { get; set; }
        public string ExistingPhaseName { get; set; }

        /// <summary>The Revit undo label (when applied).</summary>
        public string UndoLabel { get; set; }

        public List<JournalEntryResult> Results { get; set; } = new();
        public int Applied { get; set; }
        public int Skipped { get; set; }
        public int Conflicts { get; set; }
        public int Failed { get; set; }
        public int AlreadyApplied { get; set; }

        /// <summary>
        /// Recounts the totals from <see cref="Results"/>.
        /// </summary>
        public void Count()
        {
            Applied = Skipped = Conflicts = Failed = AlreadyApplied = 0;
            foreach (JournalEntryResult result in Results)
            {
                switch (result.Status)
                {
                    case JournalStatus.APPLIED: Applied++; break;
                    case JournalStatus.CONFLICT: Conflicts++; break;
                    case JournalStatus.FAILED: Failed++; break;
                    case JournalStatus.ALREADY_APPLIED: AlreadyApplied++; break;
                    default: Skipped++; break;
                }
            }
        }
    }

    #endregion

    /// <summary>
    /// A success flag and a short message (select.result, extract.failed, session.closing).
    /// </summary>
    public sealed class MessagePayload
    {
        public bool Success { get; set; }
        public string Message { get; set; } = string.Empty;
    }

    #endregion
}
