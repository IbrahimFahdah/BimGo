using System.IO.Compression;
using BimGo.Format;
using BimGo.Scene;

// The class belongs to the Live namespace
namespace BimGo.Live
{
    /// <summary>
    /// The Revit side of one live session (one per open document that has pressed Go): the session folder and
    /// session.json, the message channel, the heartbeat, snapshots, and the edit applier.
    ///
    /// Two channels carry the same messages: the session folders (the desktop app) and, once a browser walkthrough is
    /// requested, a WebSocket served by <see cref="LiveDispatcher.Server"/> (the browser viewer). Messages go out on
    /// both; whichever client is attached answers.
    ///
    /// Threads: the heartbeat timer and the channel's watcher run on thread-pool threads and only do file IO;
    /// everything touching the Revit API (snapshots, edits, selection) runs on the Revit thread via
    /// <see cref="LiveDispatcher"/>.
    /// </summary>
    internal sealed class SessionHost : IDisposable
    {
        #region Fields

        private const int SNAPSHOTS_KEPT = 2;

        private readonly object _lock = new();
        private readonly FolderChannel _channel;
        private readonly SocketChannel _socket;
        private SocketServer _server;
        private string _token;
        private System.Threading.Timer _heartbeat;
        private int _added, _modified, _deleted;
        private volatile bool _appAttached;
        private volatile bool _closed;

        #endregion

        /// <summary>
        /// Creates the session folder and starts the heartbeat (Revit thread).
        /// </summary>
        public SessionHost(Document doc, int revitPid)
        {
            Document = doc;
            string id = LiveProtocol.NewSessionId();
            Info = new SessionInfo
            {
                SessionId = id,
                State = SessionStates.STARTING,
                RevitVersion = doc.Application?.VersionNumber ?? string.Empty,
                RevitPid = revitPid,
                AddinVersion = Globals.ADDIN_VERSION,
                DocTitle = doc.Title ?? string.Empty,
                DocPath = SafePath(doc),
                ModelKey = SafeModelKey(doc),
                CreatedUtc = DateTime.UtcNow,
                HeartbeatUtc = DateTime.UtcNow
            };

            Directory.CreateDirectory(LiveProtocol.SnapshotsFolder(id));
            _channel = new FolderChannel(id, LiveProtocol.ToAppFolder(id), LiveProtocol.ToRevitFolder(id), "revit");
            _channel.MessageArrived += LiveDispatcher.Raise;
            _socket = new SocketChannel(id, "browser");
            _socket.MessageArrived += LiveDispatcher.Raise;
            _socket.ConnectionChanged += OnBrowserConnectionChanged;
            LiveSessions.WriteInfo(Info);

            _heartbeat = new System.Threading.Timer(_ => Heartbeat(), null, LiveProtocol.HEARTBEAT_SECONDS * 1000, LiveProtocol.HEARTBEAT_SECONDS * 1000);
            Utilities.Log_Utils.Write($"Live session {id} started for {Info.DocTitle}.");
        }

        #region Properties

        /// <summary>The document.</summary>
        public Document Document { get; }

        /// <summary>session.json contents (lock before changing).</summary>
        public SessionInfo Info { get; }

        /// <summary>The session id.</summary>
        public string SessionId => Info.SessionId;

        /// <summary>Applies the app's edits.</summary>
        public Bridge.RevitEditor Editor { get; } = new();

        /// <summary>True if an app's heartbeat is fresh, or a browser viewer is connected.</summary>
        public bool AppAttached => _appAttached || _socket.Connected;

        /// <summary>True while a browser viewer is connected.</summary>
        public bool BrowserConnected => _socket.Connected;

        /// <summary>True once the session is served to browsers (<see cref="EnableBrowser"/>).</summary>
        public bool BrowserEnabled => _server != null;

        /// <summary>True once closed.</summary>
        public bool IsClosed => _closed;

        #endregion

        #region Messages

        /// <summary>Takes the next message from the app or the browser, if any.</summary>
        public bool TryReceive(out Envelope envelope) => _channel.TryReceive(out envelope) || _socket.TryReceive(out envelope);

        /// <summary>Sends a message to the app and the browser (each ignores answers to requests it didn't make).</summary>
        public void Send(string type, object payload, string replyTo = null)
        {
            _channel.Send(type, payload, replyTo);
            _socket.Send(type, payload, replyTo);
        }

        /// <summary>
        /// Counts model changes made outside BimGo (Revit thread; flushed to the app with the heartbeat).
        /// </summary>
        public void NoteChanges(int added, int modified, int deleted)
        {
            lock (_lock)
            {
                _added += added;
                _modified += modified;
                _deleted += deleted;
            }
        }

        #endregion

        #region Browser

        /// <summary>
        /// Serves this session to the browser viewer (Revit thread): registers it with the loopback server under a
        /// fresh one-time token. Calling it again keeps the token (an open page stays connected).
        /// </summary>
        public void EnableBrowser(SocketServer server)
        {
            if (_server == server) { return; }
            _server?.Unregister(SessionId);
            _server = server;
            _token = SocketServer.NewToken();
            server.Register(SessionId, _token, _socket, SnapshotPath);
        }

        /// <summary>
        /// The address that opens this session in the browser viewer. The token travels in the fragment, which the
        /// browser never sends to the viewer's web server.
        /// </summary>
        public string BrowserUrl(string viewerUrl)
        {
            if (_server == null) { return null; }
            string separator = viewerUrl.Contains('?') ? "&" : "?";
            return $"{viewerUrl}{separator}live=127.0.0.1:{_server.Port}&session={SessionId}#token={_token}";
        }

        /// <summary>The newest snapshot's download address, or null.</summary>
        public string LatestSnapshotUrl
        {
            get
            {
                int number;
                lock (_lock) { number = Info.SnapshotNumber; }
                return _server != null && number > 0 ? _server.SnapshotUrl(SessionId, number) : null;
            }
        }

        /// <summary>
        /// A snapshot's file by number (the server streams it), or null when it has been cleaned up.
        /// </summary>
        private string SnapshotPath(int number)
        {
            try
            {
                return Directory.GetFiles(LiveProtocol.SnapshotsFolder(SessionId), $"{number:D4}-*{BimGoFormat.EXTENSION}").FirstOrDefault();
            }
            catch (IOException)
            {
                return null;
            }
        }

        private void OnBrowserConnectionChanged()
        {
            LiveDispatcher.MarkStatusDirty();
            Utilities.Log_Utils.Write($"Session {SessionId}: browser {(_socket.Connected ? "connected" : "disconnected")}.");
        }

        #endregion

        #region Snapshots

        /// <summary>
        /// Writes a scene as the session's newest snapshot (uncompressed, for speed) and records it in session.json
        /// (Revit thread).
        /// </summary>
        /// <param name="scene">The extracted scene.</param>
        /// <param name="writer">Who writes it.</param>
        /// <param name="error">A reason on failure.</param>
        /// <returns>The snapshot payload to announce, or null on failure.</returns>
        public SnapshotReadyPayload WriteSnapshot(SceneData scene, WriterInfo writer, string reason, out string error, Utilities.OperationProgress progress = null)
        {
            int number;
            lock (_lock) { number = Info.SnapshotNumber + 1; }

            string path = Path.Combine(LiveProtocol.SnapshotsFolder(SessionId), $"{number:D4}-{DateTime.Now:yyyyMMdd-HHmmss}{BimGoFormat.EXTENSION}");
            var document = new BimGoDocument
            {
                Scene = scene,
                Comments = new CommentDocument { Model = scene.ModelTitle },
                Journal = new Edits.EditJournal(),
                CreatedUtc = scene.Provenance.ExtractedUtc,
                Kind = FileKinds.SNAPSHOT,
                Path = path
            };

            if (!BimGoWriter.Write(path, document, writer, FileKinds.SNAPSHOT, out error, CompressionLevel.NoCompression, progress)) { return null; }

            Editor.SetPhases(scene.ExistingPhaseId, scene.PhaseId);
            lock (_lock)
            {
                Info.SnapshotNumber = number;
                Info.LatestSnapshot = path;
                Info.SnapshotUtc = DateTime.UtcNow;
                Info.PhaseName = scene.PhaseName;
                Info.ExistingPhaseName = scene.ExistingPhaseName;
                Info.CommentsPath = scene.CommentsPath;
                Info.DocTitle = Document.Title ?? Info.DocTitle;
                Info.State = SessionStates.READY;
                Info.HeartbeatUtc = DateTime.UtcNow;
                LiveSessions.WriteInfo(Info);

                // Changes made before this snapshot are in it
                _added = _modified = _deleted = 0;
            }
            DeleteOldSnapshots(path);

            return new SnapshotReadyPayload
            {
                Path = path,
                SnapshotNumber = number,
                Elements = scene.Elements.Length,
                Triangles = scene.TriangleCount,
                Seconds = Math.Round(scene.ExtractionTime.TotalSeconds, 2),
                Reason = reason,
                SnapshotUrl = _server?.SnapshotUrl(SessionId, number)
            };
        }

        /// <summary>
        /// Keeps the newest snapshots (an app may still be reading the previous one).
        /// </summary>
        private void DeleteOldSnapshots(string keep)
        {
            try
            {
                string[] files = Directory.GetFiles(LiveProtocol.SnapshotsFolder(SessionId), "*" + BimGoFormat.EXTENSION);
                Array.Sort(files, StringComparer.Ordinal);
                for (int i = 0; i < files.Length - SNAPSHOTS_KEPT; i++)
                {
                    if (string.Equals(files[i], keep, StringComparison.OrdinalIgnoreCase)) { continue; }
                    try { File.Delete(files[i]); }
                    catch { /* in use: next time */ }
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Snapshot cleanup failed: {ex.Message}");
            }
        }

        #endregion

        #region Heartbeat

        /// <summary>
        /// Thread pool: refreshes session.json, flushes counted model changes, and checks the app's heartbeat.
        /// </summary>
        private void Heartbeat()
        {
            if (_closed) { return; }
            try
            {
                ModelChangedPayload changes = null;
                lock (_lock)
                {
                    Info.HeartbeatUtc = DateTime.UtcNow;
                    LiveSessions.WriteInfo(Info);
                    if (_added + _modified + _deleted > 0)
                    {
                        changes = new ModelChangedPayload { Added = _added, Modified = _modified, Deleted = _deleted };
                        _added = _modified = _deleted = 0;
                    }
                }
                if (changes != null) { Send(MessageTypes.MODEL_CHANGED, changes); }

                bool attached = LiveSessions.ReadAttachment(SessionId)?.IsAlive() == true;
                if (attached != _appAttached)
                {
                    _appAttached = attached;
                    LiveDispatcher.MarkStatusDirty();
                    Utilities.Log_Utils.Write($"Session {SessionId}: app {(attached ? "attached" : "detached")}.");
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Heartbeat failed: {ex.Message}");
            }
        }

        #endregion

        #region Lifetime

        /// <summary>
        /// Ends the session: tells the app, marks session.json closed and stops the timers.
        /// </summary>
        public void Close(string reason)
        {
            if (_closed) { return; }
            _closed = true;
            try
            {
                Send(MessageTypes.SESSION_CLOSING, new MessagePayload { Success = true, Message = reason });
                lock (_lock)
                {
                    Info.State = SessionStates.CLOSED;
                    Info.HeartbeatUtc = DateTime.UtcNow;
                    LiveSessions.WriteInfo(Info);
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Session close failed: {ex.Message}");
            }
            Dispose();
            Utilities.Log_Utils.Write($"Live session {SessionId} closed: {reason}.");
        }

        /// <summary>
        /// Stops the heartbeat and the channel.
        /// </summary>
        public void Dispose()
        {
            _closed = true;
            try { _heartbeat?.Dispose(); } catch { /* closing */ }
            _heartbeat = null;
            _channel.MessageArrived -= LiveDispatcher.Raise;
            _channel.Dispose();
            _server?.Unregister(SessionId);
            _socket.MessageArrived -= LiveDispatcher.Raise;
            _socket.ConnectionChanged -= OnBrowserConnectionChanged;
            _socket.Dispose();
        }

        private static string SafePath(Document doc)
        {
            try { return doc.IsModelInCloud ? string.Empty : doc.PathName ?? string.Empty; }
            catch { return string.Empty; }
        }

        private static string SafeModelKey(Document doc)
        {
            try { return doc.ProjectInformation?.UniqueId ?? string.Empty; }
            catch { return string.Empty; }
        }

        #endregion
    }
}
