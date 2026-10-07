using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;

// The class belongs to the Live namespace
namespace BimGo.Live
{
    /// <summary>
    /// The loopback server the browser viewer talks to (one per Revit process, shared by its live sessions):
    /// <code>
    /// GET  ws://127.0.0.1:&lt;port&gt;/live/&lt;sessionId&gt;?token=…      the session's WebSocket (<see cref="SocketChannel"/>)
    /// GET  http://127.0.0.1:&lt;port&gt;/snapshot/&lt;sessionId&gt;/&lt;n&gt;     snapshot n (.bimgo), token in X-BimGo-Token
    /// OPTIONS …                                                 CORS / Private Network Access preflight
    /// </code>
    /// A plain <see cref="TcpListener"/> on 127.0.0.1 (no HttpListener: no URL ACL, no admin rights, and the browser
    /// can use the IP address, which every browser treats as a secure origin) with just enough HTTP/1.1 for these
    /// requests, and the framework's <see cref="WebSocket"/> once upgraded.
    ///
    /// Security: bound to loopback only; the Host header must name the loopback address (DNS rebinding); the Origin
    /// must be on the allow-list (the Pages viewer and the dev server); every session needs its one-time token, which
    /// the add-in passes to the viewer in the launch URL's fragment (never sent to a web server). Messages keep the
    /// protocol's 4 MB cap and session-id check.
    /// </summary>
    public sealed class SocketServer : IDisposable
    {
        #region Fields

        /// <summary>The first port tried.</summary>
        public const int DEFAULT_PORT = 47800;

        /// <summary>The token header for HTTP requests (WebSockets can't send headers: they use ?token=).</summary>
        public const string TOKEN_HEADER = "X-BimGo-Token";

        private const int MAX_HEAD_BYTES = 16 * 1024;
        private const string WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

        private readonly TcpListener _listener;
        private readonly HashSet<string> _origins;
        private readonly ConcurrentDictionary<string, Registration> _sessions = new(StringComparer.OrdinalIgnoreCase);
        private readonly CancellationTokenSource _stop = new();

        #endregion

        /// <summary>
        /// A session served by this server.
        /// </summary>
        private sealed class Registration
        {
            public byte[] Token;
            public SocketChannel Channel;
            public Func<int, string> SnapshotPath;
        }

        private SocketServer(TcpListener listener, IEnumerable<string> origins)
        {
            _listener = listener;
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            _origins = new HashSet<string>(origins.Select(NormaliseOrigin).Where(o => o.Length > 0), StringComparer.OrdinalIgnoreCase);
            _ = AcceptLoop();
        }

        /// <summary>The port in use.</summary>
        public int Port { get; }

        /// <summary>The allowed browser origins.</summary>
        public IReadOnlyCollection<string> AllowedOrigins => _origins;

        #region Start / register

        /// <summary>
        /// Starts listening on 127.0.0.1, on the preferred port or the next free one.
        /// </summary>
        /// <param name="origins">Allowed browser origins (e.g. https://user.github.io, http://localhost:5173).</param>
        /// <param name="preferredPort">The first port to try (0 = any free port).</param>
        /// <param name="attempts">How many consecutive ports to try.</param>
        /// <exception cref="SocketException">No port could be opened.</exception>
        public static SocketServer Start(IEnumerable<string> origins, int preferredPort = DEFAULT_PORT, int attempts = 20)
        {
            SocketException last = null;
            for (int i = 0; i < Math.Max(1, attempts); i++)
            {
                int port = preferredPort == 0 ? 0 : preferredPort + i;
                var listener = new TcpListener(IPAddress.Loopback, port);
                try
                {
                    listener.Server.ExclusiveAddressUse = true;
                    listener.Start();
                    var server = new SocketServer(listener, origins);
                    Utilities.Log_Utils.Write($"Live socket server on 127.0.0.1:{server.Port} (origins: {string.Join(", ", server._origins)}).");
                    return server;
                }
                catch (SocketException ex)
                {
                    last = ex;
                    listener.Stop();
                }
            }
            throw last ?? new SocketException((int)SocketError.AddressAlreadyInUse);
        }

        /// <summary>
        /// Serves a session: its channel takes the session's WebSocket, and its snapshots are downloadable.
        /// </summary>
        /// <param name="sessionId">The session id.</param>
        /// <param name="token">The session's secret (see <see cref="NewToken"/>).</param>
        /// <param name="channel">Receives the viewer's socket.</param>
        /// <param name="snapshotPath">Snapshot number → file path (null when it is gone).</param>
        public void Register(string sessionId, string token, SocketChannel channel, Func<int, string> snapshotPath)
        {
            _sessions[sessionId] = new Registration { Token = Encoding.UTF8.GetBytes(token ?? string.Empty), Channel = channel, SnapshotPath = snapshotPath };
        }

        /// <summary>Stops serving a session.</summary>
        public void Unregister(string sessionId) => _sessions.TryRemove(sessionId, out _);

        /// <summary>A one-time session secret (32 random bytes, hex).</summary>
        public static string NewToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

        /// <summary>The download URL of a snapshot.</summary>
        public string SnapshotUrl(string sessionId, int number) => $"http://127.0.0.1:{Port}/snapshot/{sessionId}/{number}";

        /// <summary>
        /// "https://user.github.io/BimGo/" → "https://user.github.io" (an origin is scheme, host and port only).
        /// </summary>
        public static string NormaliseOrigin(string urlOrOrigin)
        {
            if (string.IsNullOrWhiteSpace(urlOrOrigin)) { return string.Empty; }
            return Uri.TryCreate(urlOrOrigin.Trim(), UriKind.Absolute, out Uri uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
                ? uri.GetLeftPart(UriPartial.Authority).TrimEnd('/')
                : string.Empty;
        }

        #endregion

        #region Connections

        private async Task AcceptLoop()
        {
            while (!_stop.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync(_stop.Token).ConfigureAwait(false);
                }
                catch (Exception) when (_stop.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    Utilities.Log_Utils.Write($"Live socket server: accept failed: {ex.Message}");
                    await Task.Delay(200).ConfigureAwait(false);
                    continue;
                }
                _ = Task.Run(() => Serve(client));
            }
        }

        /// <summary>
        /// One connection: reads the request head and answers it (a WebSocket stays open until it closes).
        /// </summary>
        private async Task Serve(TcpClient client)
        {
            NetworkStream stream = null;
            try
            {
                client.NoDelay = true;
                stream = client.GetStream();
                Request request;
                using (var headTimeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
                {
                    headTimeout.CancelAfter(TimeSpan.FromSeconds(10));
                    request = await ReadRequest(stream, headTimeout.Token).ConfigureAwait(false);
                }
                if (request == null) { return; }

                // DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends Host: evil.example
                if (!IsLoopbackHost(request.Header("Host")))
                {
                    await Respond(stream, 421, "Misdirected Request", null).ConfigureAwait(false);
                    return;
                }

                string origin = request.Header("Origin");
                bool originAllowed = !string.IsNullOrEmpty(origin) && _origins.Contains(origin);
                string[] parts = request.Path.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);

                if (request.Method == "OPTIONS")
                {
                    await Respond(stream, originAllowed ? 204 : 403, originAllowed ? "No Content" : "Forbidden", originAllowed ? origin : null, preflight: true).ConfigureAwait(false);
                    return;
                }
                if (request.Method != "GET")
                {
                    await Respond(stream, 405, "Method Not Allowed", originAllowed ? origin : null).ConfigureAwait(false);
                    return;
                }
                if (parts.Length == 0)
                {
                    await Respond(stream, 200, "OK", originAllowed ? origin : null, body: "BimGo live link").ConfigureAwait(false);
                    return;
                }
                if (!originAllowed)
                {
                    Utilities.Log_Utils.Write($"Live socket server: refused origin '{origin}'.");
                    await Respond(stream, 403, "Forbidden", null, body: "Origin not allowed").ConfigureAwait(false);
                    return;
                }

                if (parts.Length == 2 && parts[0] == "live")
                {
                    await Upgrade(stream, request, parts[1], origin).ConfigureAwait(false);
                    return;
                }
                if (parts.Length == 3 && parts[0] == "snapshot" && int.TryParse(parts[2], out int number))
                {
                    await SendSnapshot(stream, request, parts[1], number, origin).ConfigureAwait(false);
                    return;
                }
                await Respond(stream, 404, "Not Found", origin).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or SocketException or OperationCanceledException or ObjectDisposedException)
            {
                // Client went away
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Live socket server: request failed: {ex.Message}");
            }
            finally
            {
                // (an upgraded socket is closed by now: Upgrade returns when it ends)
                try { stream?.Dispose(); } catch { /* closing */ }
                client.Dispose();
            }
        }

        /// <summary>
        /// Upgrades to a WebSocket for a session (token in the query) and hands it to the session's channel.
        /// </summary>
        private async Task Upgrade(NetworkStream stream, Request request, string sessionId, string origin)
        {
            string key = request.Header("Sec-WebSocket-Key");
            bool isUpgrade = request.Header("Upgrade").Equals("websocket", StringComparison.OrdinalIgnoreCase)
                && request.Header("Connection").Contains("upgrade", StringComparison.OrdinalIgnoreCase)
                && request.Header("Sec-WebSocket-Version") == "13" && key.Length > 0;
            if (!isUpgrade)
            {
                await Respond(stream, 426, "Upgrade Required", origin).ConfigureAwait(false);
                return;
            }
            if (!Authorise(sessionId, request.Query("token"), out Registration session))
            {
                await Respond(stream, 403, "Forbidden", origin, body: "Unknown session or wrong token").ConfigureAwait(false);
                return;
            }

            // The channel switches to the new socket before the browser hears 101, so anything sent once it is
            // connected goes to this socket (the client sends nothing until then, so the pending read is harmless)
            WebSocket socket = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions { IsServer = true, KeepAliveInterval = TimeSpan.FromSeconds(15) });
            Task served = session.Channel.Attach(socket);

            string accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + WEBSOCKET_GUID)));
            string head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                $"Sec-WebSocket-Accept: {accept}\r\n\r\n";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(head)).ConfigureAwait(false);
            Utilities.Log_Utils.Write($"Live socket server: viewer connected to session {sessionId[..8]} from {origin}.");
            await served.ConfigureAwait(false);
            Utilities.Log_Utils.Write($"Live socket server: viewer left session {sessionId[..8]}.");
        }

        /// <summary>
        /// Streams a snapshot file (token in the header).
        /// </summary>
        private async Task SendSnapshot(NetworkStream stream, Request request, string sessionId, int number, string origin)
        {
            if (!Authorise(sessionId, request.Header(TOKEN_HEADER), out Registration session))
            {
                await Respond(stream, 403, "Forbidden", origin, body: "Unknown session or wrong token").ConfigureAwait(false);
                return;
            }

            string path = session.SnapshotPath?.Invoke(number);
            FileStream file = null;
            try
            {
                if (!string.IsNullOrEmpty(path)) { file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, useAsync: true); }
            }
            catch (IOException)
            {
                file = null;
            }
            if (file == null)
            {
                await Respond(stream, 404, "Not Found", origin, body: "That snapshot is no longer available").ConfigureAwait(false);
                return;
            }

            await using (file)
            {
                string head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n" +
                    $"Content-Length: {file.Length}\r\nCache-Control: no-store\r\nConnection: close\r\n" + CorsHeaders(origin, preflight: false) + "\r\n";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(head)).ConfigureAwait(false);
                await file.CopyToAsync(stream, 1 << 16, _stop.Token).ConfigureAwait(false);
            }
        }

        private bool Authorise(string sessionId, string token, out Registration session)
        {
            if (!LiveProtocol.IsValidSessionId(sessionId) || !_sessions.TryGetValue(sessionId, out session))
            {
                session = null;
                return false;
            }
            byte[] given = Encoding.UTF8.GetBytes(token ?? string.Empty);
            return given.Length == session.Token.Length && session.Token.Length > 0 && CryptographicOperations.FixedTimeEquals(given, session.Token);
        }

        private bool IsLoopbackHost(string host)
        {
            if (string.IsNullOrEmpty(host)) { return false; }
            return host.Equals($"127.0.0.1:{Port}", StringComparison.OrdinalIgnoreCase) || host.Equals($"localhost:{Port}", StringComparison.OrdinalIgnoreCase);
        }

        #endregion

        #region HTTP

        /// <summary>
        /// The parts of a request this server uses.
        /// </summary>
        private sealed class Request
        {
            public string Method = string.Empty;
            public string Path = string.Empty;
            public string QueryString = string.Empty;
            public readonly Dictionary<string, string> Headers = new(StringComparer.OrdinalIgnoreCase);

            public string Header(string name) => Headers.TryGetValue(name, out string value) ? value : string.Empty;

            public string Query(string name)
            {
                foreach (string pair in QueryString.Split('&', StringSplitOptions.RemoveEmptyEntries))
                {
                    int eq = pair.IndexOf('=');
                    string key = eq < 0 ? pair : pair[..eq];
                    if (Uri.UnescapeDataString(key) == name) { return eq < 0 ? string.Empty : Uri.UnescapeDataString(pair[(eq + 1)..]); }
                }
                return null;
            }
        }

        /// <summary>
        /// Reads the request line and headers (byte by byte up to the blank line, so nothing after it is consumed).
        /// </summary>
        private static async Task<Request> ReadRequest(NetworkStream stream, CancellationToken token)
        {
            var head = new List<byte>(1024);
            var one = new byte[1];
            while (head.Count < MAX_HEAD_BYTES)
            {
                int read = await stream.ReadAsync(one, token).ConfigureAwait(false);
                if (read == 0) { return null; }
                head.Add(one[0]);
                int n = head.Count;
                if (n >= 4 && head[n - 4] == '\r' && head[n - 3] == '\n' && head[n - 2] == '\r' && head[n - 1] == '\n') { break; }
            }
            if (head.Count >= MAX_HEAD_BYTES) { return null; }

            string[] lines = Encoding.ASCII.GetString(head.ToArray()).Split("\r\n");
            string[] first = lines[0].Split(' ');
            if (first.Length != 3 || !first[2].StartsWith("HTTP/1.", StringComparison.Ordinal)) { return null; }

            var request = new Request { Method = first[0].ToUpperInvariant() };
            string target = first[1];
            int question = target.IndexOf('?');
            request.Path = Uri.UnescapeDataString(question < 0 ? target : target[..question]);
            request.QueryString = question < 0 ? string.Empty : target[(question + 1)..];
            for (int i = 1; i < lines.Length; i++)
            {
                int colon = lines[i].IndexOf(':');
                if (colon <= 0) { continue; }
                request.Headers[lines[i][..colon].Trim()] = lines[i][(colon + 1)..].Trim();
            }
            return request;
        }

        private static string CorsHeaders(string origin, bool preflight)
        {
            if (origin == null) { return string.Empty; }
            string headers = $"Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n";
            if (preflight)
            {
                headers += $"Access-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: {TOKEN_HEADER}\r\n" +
                    "Access-Control-Allow-Private-Network: true\r\nAccess-Control-Allow-Local-Network: true\r\nAccess-Control-Max-Age: 600\r\n";
            }
            return headers;
        }

        private static async Task Respond(NetworkStream stream, int status, string reason, string origin, bool preflight = false, string body = null)
        {
            byte[] content = Encoding.UTF8.GetBytes(body ?? string.Empty);
            string head = $"HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {content.Length}\r\n" +
                "Cache-Control: no-store\r\nConnection: close\r\n" + CorsHeaders(origin, preflight) + "\r\n";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(head)).ConfigureAwait(false);
            if (content.Length > 0) { await stream.WriteAsync(content).ConfigureAwait(false); }
        }

        #endregion

        /// <summary>
        /// Stops listening (open sockets belong to their channels, which their sessions close).
        /// </summary>
        public void Dispose()
        {
            if (_stop.IsCancellationRequested) { return; }
            _stop.Cancel();
            try { _listener.Stop(); } catch { /* closing */ }
            _sessions.Clear();
        }
    }
}
