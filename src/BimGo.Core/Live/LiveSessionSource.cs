using BimGo.Edits;
using BimGo.Sources;

// The class belongs to the Live namespace
namespace BimGo.Live
{
    /// <summary>
    /// What a walkthrough can do with a live Revit session beyond submitting edits.
    /// </summary>
    public interface ILiveLink
    {
        /// <summary>The session id.</summary>
        string SessionId { get; }

        /// <summary>Revit's process id (to let it take the foreground).</summary>
        int RevitPid { get; }

        /// <summary>True while Revit's heartbeat is fresh and the session is open.</summary>
        bool Connected { get; }

        /// <summary>True once the session has ended (document closed / Revit exited).</summary>
        bool Closed { get; }

        /// <summary>Model changes reported by Revit since the walkthrough's snapshot (made outside BimGo).</summary>
        int ModelChanges { get; }

        /// <summary>True while a refresh is being extracted.</summary>
        bool Refreshing { get; }

        /// <summary>A newer snapshot than the one being walked is ready (set by extract.ready).</summary>
        bool SnapshotReady { get; }

        /// <summary>Takes the next message for the HUD, if any.</summary>
        bool TryTakeNotice(out string message);

        /// <summary>Asks Revit for a fresh snapshot.</summary>
        /// <returns>False if not connected.</returns>
        bool RequestRefresh();

        /// <summary>Asks Revit to select and show elements.</summary>
        /// <returns>False if not connected.</returns>
        bool ShowElements(IReadOnlyList<long> elementIds);
    }

    /// <summary>
    /// The app side of a live Revit session: an <see cref="IModelSource"/> whose edits travel to Revit over the
    /// session's folders, plus the session extras (<see cref="ILiveLink"/>). Game thread only, except the channel's
    /// own watcher.
    ///
    /// Connection health comes from Revit's session.json heartbeat, checked every couple of seconds; the app's own
    /// heartbeat (app.json) tells Revit someone is attached. If Revit goes away, waiting edits are answered as
    /// failed so the guns put things back, and further edits are refused.
    /// </summary>
    public sealed class LiveSessionSource : IModelSource, ILiveLink, IDisposable
    {
        private readonly FolderChannel _channel;
        private readonly Queue<EditResult> _results = new();
        private readonly Queue<string> _notices = new();
        private readonly Dictionary<int, EditRequest> _pending = new();
        private readonly AppAttachment _attachment;
        private int _nextTicket;
        private float _heartbeatTimer;
        private bool _connected = true;
        private bool _closed;
        private bool _disposed;

        /// <summary>
        /// Attaches to a session: clears stale messages, starts the app heartbeat and says hello.
        /// </summary>
        /// <param name="info">The session (from session.json).</param>
        /// <param name="appVersion">The app's version.</param>
        public LiveSessionSource(SessionInfo info, string appVersion)
        {
            Info = info ?? throw new ArgumentNullException(nameof(info));
            SessionId = info.SessionId;
            RevitPid = info.RevitPid;
            DisplayName = string.IsNullOrWhiteSpace(info.DocTitle) ? "Revit model" : info.DocTitle;
            SnapshotNumber = info.SnapshotNumber;

            _channel = new FolderChannel(SessionId, LiveProtocol.ToRevitFolder(SessionId), LiveProtocol.ToAppFolder(SessionId), "app");
            _channel.PurgeInbox();

            _attachment = new AppAttachment
            {
                AppPid = Environment.ProcessId,
                AppVersion = appVersion ?? string.Empty,
                AttachedUtc = DateTime.UtcNow,
                HeartbeatUtc = DateTime.UtcNow
            };
            LiveSessions.WriteAttachment(SessionId, _attachment);
            _channel.Send(MessageTypes.HELLO, new HelloPayload { AppPid = Environment.ProcessId, AppVersion = appVersion ?? string.Empty });
            Utilities.Log_Utils.Write($"Attached to session {SessionId} ({DisplayName}, Revit {info.RevitVersion}, pid {info.RevitPid}).");
        }

        #region Properties

        /// <summary>The session.json read at attach (or at the last heartbeat check).</summary>
        public SessionInfo Info { get; private set; }

        /// <summary>The snapshot number the walkthrough was loaded from.</summary>
        public int SnapshotNumber { get; }

        /// <inheritdoc/>
        public string SessionId { get; }

        /// <inheritdoc/>
        public int RevitPid { get; }

        /// <inheritdoc/>
        public string DisplayName { get; }

        /// <inheritdoc/>
        public bool IsRevit => true;

        /// <inheritdoc/>
        public bool CanEdit => _connected && !_closed;

        /// <inheritdoc/>
        public int Pending => _pending.Count;

        /// <inheritdoc/>
        public bool Connected => _connected && !_closed;

        /// <inheritdoc/>
        public bool Closed => _closed;

        /// <inheritdoc/>
        public int ModelChanges { get; private set; }

        /// <inheritdoc/>
        public bool Refreshing { get; private set; }

        /// <inheritdoc/>
        public bool SnapshotReady { get; private set; }

        #endregion

        #region IModelSource

        /// <inheritdoc/>
        public int Submit(EditRequest request)
        {
            if (!CanEdit) { return -1; }
            request.Ticket = ++_nextTicket;
            if (_channel.Send(MessageTypes.EDIT, request) == null) { return -1; }
            _pending[request.Ticket] = request;
            return request.Ticket;
        }

        /// <inheritdoc/>
        public bool TryGetResult(out EditResult result) => _results.TryDequeue(out result);

        /// <inheritdoc/>
        public void Pump(float dt)
        {
            while (_channel.TryReceive(out Envelope envelope))
            {
                try
                {
                    Handle(envelope);
                }
                catch (Exception ex)
                {
                    Utilities.Log_Utils.Write($"Live message {envelope.Type} failed: {ex.Message}");
                }
            }

            _heartbeatTimer += dt;
            if (_heartbeatTimer >= LiveProtocol.HEARTBEAT_SECONDS)
            {
                _heartbeatTimer = 0f;
                Heartbeat();
            }
        }

        #endregion

        #region ILiveLink

        /// <inheritdoc/>
        public bool TryTakeNotice(out string message) => _notices.TryDequeue(out message);

        /// <inheritdoc/>
        public bool RequestRefresh()
        {
            if (!Connected) { return false; }
            if (Refreshing) { return true; }
            if (_channel.Send(MessageTypes.EXTRACT_REQUEST, new RefreshRequestPayload { Reason = "refresh" }) == null) { return false; }
            Refreshing = true;
            return true;
        }

        /// <inheritdoc/>
        public bool ShowElements(IReadOnlyList<long> elementIds)
        {
            if (!Connected || elementIds == null || elementIds.Count == 0) { return false; }
            return _channel.Send(MessageTypes.SELECT, new SelectPayload { ElementIds = elementIds.ToArray() }) != null;
        }

        #endregion

        #region Messages

        private void Handle(Envelope envelope)
        {
            switch (envelope.Type)
            {
                case MessageTypes.HELLO_ACK:
                    HelloAckPayload ack = envelope.Read<HelloAckPayload>();
                    Utilities.Log_Utils.Write($"Revit acknowledged: {ack?.DocTitle} (Revit {ack?.RevitVersion}).");
                    break;

                case MessageTypes.EDIT_RESULT:
                    EditResult result = envelope.Read<EditResult>();
                    if (result != null && _pending.Remove(result.Ticket)) { _results.Enqueue(result); }
                    break;

                case MessageTypes.MODEL_CHANGED:
                    ModelChangedPayload changed = envelope.Read<ModelChangedPayload>();
                    if (changed != null) { ModelChanges += changed.Total; }
                    break;

                case MessageTypes.EXTRACT_READY:
                    SnapshotReadyPayload ready = envelope.Read<SnapshotReadyPayload>();
                    if (ready != null && ready.SnapshotNumber > SnapshotNumber)
                    {
                        SnapshotReady = true;
                        Refreshing = false;
                    }
                    break;

                case MessageTypes.EXTRACT_FAILED:
                    Refreshing = false;
                    _notices.Enqueue($"Revit could not refresh: {envelope.Read<MessagePayload>()?.Message}");
                    break;

                case MessageTypes.SELECT_RESULT:
                    MessagePayload selected = envelope.Read<MessagePayload>();
                    if (selected != null) { _notices.Enqueue(selected.Message); }
                    break;

                case MessageTypes.SESSION_CLOSING:
                    MarkClosed(envelope.Read<MessagePayload>()?.Message ?? "The Revit session ended");
                    break;
            }
        }

        /// <summary>
        /// Checks Revit's heartbeat and refreshes the app's own.
        /// </summary>
        private void Heartbeat()
        {
            _attachment.HeartbeatUtc = DateTime.UtcNow;
            LiveSessions.WriteAttachment(SessionId, _attachment);
            if (_closed) { return; }

            SessionInfo info = LiveSessions.ReadInfo(SessionId);
            if (info != null)
            {
                Info = info;

                // A newer snapshot whose announcement was missed (e.g. written while attaching)
                if (info.SnapshotNumber > SnapshotNumber && !string.IsNullOrEmpty(info.LatestSnapshot)) { SnapshotReady = true; }
            }
            if (info?.State == SessionStates.CLOSED)
            {
                MarkClosed("The model was closed in Revit");
                return;
            }

            bool alive = info != null && info.IsAlive();
            if (alive == _connected) { return; }

            _connected = alive;
            if (alive)
            {
                _notices.Enqueue("Reconnected to Revit");
            }
            else
            {
                FailPending("Lost contact with Revit");
                _notices.Enqueue("Lost contact with Revit: edits are paused (Revit may be busy or closed)");
            }
        }

        private void MarkClosed(string reason)
        {
            if (_closed) { return; }
            _closed = true;
            Refreshing = false;
            FailPending(reason);
            _notices.Enqueue($"{reason}. The walkthrough is now read-only; save it as a .bimgo to keep working.");
        }

        /// <summary>
        /// Answers every waiting edit as failed (the guns then put things back).
        /// </summary>
        private void FailPending(string message)
        {
            foreach (EditRequest request in _pending.Values)
            {
                _results.Enqueue(new EditResult { Ticket = request.Ticket, Op = request.Op, Success = false, Message = message, CloneKey = request.NewCloneKey });
            }
            _pending.Clear();
        }

        #endregion

        /// <summary>
        /// Leaves the session.
        /// </summary>
        /// <param name="sayGoodbye">Send detach (false when re-attaching straight away, e.g. a reload).</param>
        public void Close(bool sayGoodbye)
        {
            if (_disposed) { return; }
            _disposed = true;
            if (sayGoodbye && !_closed) { _channel.Send(MessageTypes.DETACH, null); }
            if (sayGoodbye) { LiveSessions.DeleteAttachment(SessionId); }
            _channel.Dispose();
        }

        /// <summary>
        /// Leaves the session (with detach).
        /// </summary>
        public void Dispose() => Close(sayGoodbye: true);
    }
}
