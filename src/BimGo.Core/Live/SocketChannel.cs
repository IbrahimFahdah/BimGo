using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

// The class belongs to the Live namespace
namespace BimGo.Live
{
    /// <summary>
    /// A session's message exchange with the browser viewer over a WebSocket: one <see cref="Envelope"/> per text
    /// message. The channel outlives individual connections: when the page reloads (or reconnects after a drop), the
    /// new socket replaces the old one via <see cref="Attach"/>. Messages sent while nobody is connected are dropped;
    /// the viewer says hello again on connect and fails its own waiting edits when the socket closes.
    ///
    /// Received messages are validated like <see cref="FolderChannel"/>'s (session id, protocol version, size) and queue
    /// up for <see cref="TryReceive"/>. Thread-safe; Send / TryReceive never throw.
    /// </summary>
    public sealed class SocketChannel : ILiveChannel
    {
        private readonly string _sessionId;
        private readonly string _name;
        private readonly ConcurrentQueue<Envelope> _received = new();
        private readonly SemaphoreSlim _sendLock = new(1, 1);
        private readonly object _socketLock = new();
        private WebSocket _socket;
        private CancellationTokenSource _cancel;
        private long _seq;
        private volatile bool _disposed;

        /// <summary>
        /// Creates the channel (not connected yet).
        /// </summary>
        /// <param name="sessionId">The session (messages for other sessions are ignored).</param>
        /// <param name="name">A short name for the log.</param>
        public SocketChannel(string sessionId, string name = "socket")
        {
            _sessionId = sessionId;
            _name = name;
        }

        /// <inheritdoc/>
        public event Action MessageArrived;

        /// <summary>Raised (on a background thread) when a socket connects or disconnects.</summary>
        public event Action ConnectionChanged;

        /// <summary>True while a viewer is connected.</summary>
        public bool Connected
        {
            get
            {
                lock (_socketLock) { return _socket?.State == WebSocketState.Open; }
            }
        }

        /// <summary>
        /// Takes over a freshly accepted socket (closing the previous one) and starts reading from it.
        /// </summary>
        /// <returns>A task that completes when this socket closes.</returns>
        public Task Attach(WebSocket socket)
        {
            if (_disposed)
            {
                socket.Abort();
                return Task.CompletedTask;
            }

            WebSocket previous;
            CancellationTokenSource previousCancel;
            var cancel = new CancellationTokenSource();
            lock (_socketLock)
            {
                previous = _socket;
                previousCancel = _cancel;
                _socket = socket;
                _cancel = cancel;
            }
            CloseQuietly(previous, previousCancel, "Replaced by a new connection");
            RaiseConnectionChanged();
            return ReceiveLoop(socket, cancel.Token);
        }

        /// <inheritdoc/>
        public Envelope Send(string type, object payload, string replyTo = null)
        {
            WebSocket socket;
            CancellationToken token;
            lock (_socketLock)
            {
                socket = _socket;
                token = _cancel?.Token ?? CancellationToken.None;
            }
            if (_disposed || socket == null || socket.State != WebSocketState.Open) { return null; }

            try
            {
                var envelope = new Envelope
                {
                    Seq = Interlocked.Increment(ref _seq),
                    SessionId = _sessionId,
                    Type = type,
                    ReplyTo = replyTo,
                    SentUtc = DateTime.UtcNow,
                    Payload = JsonSerializer.SerializeToElement(payload ?? new object(), payload?.GetType() ?? typeof(object), LiveProtocol.JSON)
                };
                byte[] bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(envelope, LiveProtocol.JSON));

                // One send at a time (a WebSocket rule); callers are on the Revit thread and timers, so wait briefly
                if (!_sendLock.Wait(TimeSpan.FromSeconds(10))) { throw new TimeoutException("send queue stuck"); }
                try
                {
                    socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, token).GetAwaiter().GetResult();
                }
                finally
                {
                    _sendLock.Release();
                }
                return envelope;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Channel {_name}: could not send {type}: {ex.Message}");
                return null;
            }
        }

        /// <inheritdoc/>
        public bool TryReceive(out Envelope envelope) => _received.TryDequeue(out envelope);

        /// <summary>
        /// Reads messages until the socket closes (oversized messages close it: the viewer then reconnects).
        /// </summary>
        private async Task ReceiveLoop(WebSocket socket, CancellationToken token)
        {
            var buffer = new byte[64 * 1024];
            using var message = new MemoryStream();
            try
            {
                while (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult result = await socket.ReceiveAsync(buffer, token).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Bye", CancellationToken.None).ConfigureAwait(false);
                        break;
                    }

                    message.Write(buffer, 0, result.Count);
                    if (message.Length > LiveProtocol.MAX_MESSAGE_BYTES)
                    {
                        Utilities.Log_Utils.Write($"Channel {_name}: oversized message ({message.Length} bytes), closing.");
                        await socket.CloseAsync(WebSocketCloseStatus.MessageTooBig, "Message too big", CancellationToken.None).ConfigureAwait(false);
                        break;
                    }
                    if (!result.EndOfMessage) { continue; }

                    if (result.MessageType == WebSocketMessageType.Text && Accept(message.ToArray()) is Envelope envelope)
                    {
                        _received.Enqueue(envelope);
                        try { MessageArrived?.Invoke(); }
                        catch (Exception ex) { Utilities.Log_Utils.Write($"Channel {_name}: arrival handler failed: {ex.Message}"); }
                    }
                    message.SetLength(0);
                }
            }
            catch (OperationCanceledException)
            {
                // Replaced or closing
            }
            catch (Exception ex) when (ex is WebSocketException or IOException or ObjectDisposedException)
            {
                Utilities.Log_Utils.Write($"Channel {_name}: connection lost: {ex.Message}");
            }
            finally
            {
                bool current;
                lock (_socketLock)
                {
                    current = ReferenceEquals(_socket, socket);
                    if (current) { _socket = null; }
                }
                socket.Dispose();
                if (current) { RaiseConnectionChanged(); }
            }
        }

        /// <summary>
        /// Parses and validates one message; null if it is not for this session or unreadable.
        /// </summary>
        private Envelope Accept(byte[] bytes)
        {
            try
            {
                Envelope envelope = JsonSerializer.Deserialize<Envelope>(bytes, LiveProtocol.JSON);
                if (envelope == null || string.IsNullOrEmpty(envelope.Type)) { return null; }
                if (!string.Equals(envelope.SessionId, _sessionId, StringComparison.OrdinalIgnoreCase))
                {
                    Utilities.Log_Utils.Write($"Channel {_name}: message for another session discarded.");
                    return null;
                }
                if (envelope.Protocol > LiveProtocol.VERSION)
                {
                    Utilities.Log_Utils.Write($"Channel {_name}: message from a newer protocol ({envelope.Protocol}) discarded.");
                    return null;
                }
                return envelope;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Channel {_name}: unreadable message discarded: {ex.Message}");
                return null;
            }
        }

        private void RaiseConnectionChanged()
        {
            try { ConnectionChanged?.Invoke(); }
            catch (Exception ex) { Utilities.Log_Utils.Write($"Channel {_name}: connection handler failed: {ex.Message}"); }
        }

        private static void CloseQuietly(WebSocket socket, CancellationTokenSource cancel, string reason)
        {
            if (socket == null) { return; }
            try
            {
                if (socket.State == WebSocketState.Open)
                {
                    socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, reason, CancellationToken.None).Wait(500);
                }
            }
            catch
            {
                // Closing anyway
            }
            try { cancel?.Cancel(); } catch { /* closing */ }
            try { socket.Abort(); } catch { /* closing */ }
        }

        /// <summary>
        /// Closes the connection and stops accepting new ones.
        /// </summary>
        public void Dispose()
        {
            if (_disposed) { return; }
            _disposed = true;
            WebSocket socket;
            CancellationTokenSource cancel;
            lock (_socketLock)
            {
                socket = _socket;
                cancel = _cancel;
                _socket = null;
                _cancel = null;
            }
            CloseQuietly(socket, cancel, "Session closed");
        }
    }
}
