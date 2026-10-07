using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using BimGo.Edits;
using BimGo.Live;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// The browser live link: envelopes round-trip through <see cref="SocketServer"/> and <see cref="SocketChannel"/>
    /// over a real loopback WebSocket, and the server refuses wrong origins, tokens, sessions and Host headers.
    /// Any free port is used, never the add-in's default.
    /// </summary>
    [TestClass]
    public sealed class SocketServerTests
    {
        private const string SESSION = "0123456789abcdef0123456789abcdef";
        private const string ORIGIN = "https://example.github.io";

        /// <summary>A server with one registered session.</summary>
        private sealed class Fixture : IDisposable
        {
            public readonly SocketServer Server = SocketServer.Start(new[] { ORIGIN + "/BimGo/", "http://localhost:5173" }, preferredPort: 0);
            public readonly SocketChannel Channel = new(SESSION, "test-revit");
            public readonly string Token = SocketServer.NewToken();
            public readonly TempFolder Folder = new();

            public Fixture()
            {
                Server.Register(SESSION, Token, Channel, n => n == 1 ? Path.Combine(Folder.Path, "0001.bimgo") : null);
            }

            public Uri SocketUri(string token = null, string session = SESSION) =>
                new($"ws://127.0.0.1:{Server.Port}/live/{session}?token={token ?? Token}");

            public async Task<ClientWebSocket> Connect(string origin = ORIGIN, string token = null, string session = SESSION)
            {
                var client = new ClientWebSocket();
                if (origin != null) { client.Options.SetRequestHeader("Origin", origin); }
                using var timeout = new CancellationTokenSource(5000);
                await client.ConnectAsync(SocketUri(token, session), timeout.Token);
                return client;
            }

            public void Dispose()
            {
                Channel.Dispose();
                Server.Dispose();
                Folder.Dispose();
            }
        }

        private static async Task<Envelope> ReceiveEnvelope(ClientWebSocket client)
        {
            var buffer = new byte[1 << 16];
            using var timeout = new CancellationTokenSource(5000);
            using var message = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await client.ReceiveAsync(buffer, timeout.Token);
                message.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);
            return JsonSerializer.Deserialize<Envelope>(message.ToArray(), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        }

        private static Task SendRaw(ClientWebSocket client, string json) =>
            client.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, CancellationToken.None);

        private static Envelope WaitForMessage(SocketChannel channel)
        {
            for (int i = 0; i < 100; i++)
            {
                if (channel.TryReceive(out Envelope envelope)) { return envelope; }
                Thread.Sleep(20);
            }
            return null;
        }

        private static void WaitUntil(Func<bool> condition)
        {
            for (int i = 0; i < 100 && !condition(); i++) { Thread.Sleep(20); }
        }

        [TestMethod]
        public async Task Envelopes_RoundTrip_BothWays()
        {
            using var fixture = new Fixture();
            using ClientWebSocket client = await fixture.Connect();
            WaitUntil(() => fixture.Channel.Connected);
            Assert.IsTrue(fixture.Channel.Connected);

            // Browser → Revit: an edit as the web viewer writes it (camelCase, enums as strings, Vector3 as arrays)
            await SendRaw(client, "{\"protocol\":1,\"id\":\"a1\",\"seq\":1,\"sessionId\":\"" + SESSION + "\",\"type\":\"edit\",\"sentUtc\":\"2026-10-07T00:00:00Z\"," +
                "\"payload\":{\"ticket\":3,\"op\":\"transform\",\"elementId\":42,\"pivot\":[1,2,3],\"translation\":[0.5,0,0],\"angle\":0.25,\"label\":\"Move Chair\"}}");
            Envelope received = WaitForMessage(fixture.Channel);
            Assert.IsNotNull(received);
            Assert.AreEqual(MessageTypes.EDIT, received.Type);
            EditRequest request = received.Read<EditRequest>();
            Assert.AreEqual(EditOp.Transform, request.Op);
            Assert.AreEqual(42L, request.ElementId);
            Assert.AreEqual(0.5f, request.Translation.X);
            Assert.AreEqual("Move Chair", request.Label);

            // Revit → browser: the result, answering it
            Envelope sent = fixture.Channel.Send(MessageTypes.EDIT_RESULT, new EditResult { Ticket = 3, Op = EditOp.Transform, Success = true, AffectedIds = new long[] { 42 } }, received.Id);
            Assert.IsNotNull(sent);
            Envelope back = await ReceiveEnvelope(client);
            Assert.AreEqual(MessageTypes.EDIT_RESULT, back.Type);
            Assert.AreEqual("a1", back.ReplyTo);
            Assert.AreEqual(SESSION, back.SessionId);
            Assert.AreEqual("transform", back.Payload.GetProperty("op").GetString());
            Assert.AreEqual(3, back.Payload.GetProperty("ticket").GetInt32());
        }

        [TestMethod]
        public async Task Messages_ForAnotherSession_AreDiscarded()
        {
            using var fixture = new Fixture();
            using ClientWebSocket client = await fixture.Connect();
            await SendRaw(client, "{\"protocol\":1,\"id\":\"x\",\"sessionId\":\"ffffffffffffffffffffffffffffffff\",\"type\":\"hello\",\"payload\":{}}");
            await SendRaw(client, "{\"protocol\":99,\"id\":\"y\",\"sessionId\":\"" + SESSION + "\",\"type\":\"hello\",\"payload\":{}}");
            await SendRaw(client, "not json");
            await SendRaw(client, "{\"protocol\":1,\"id\":\"z\",\"sessionId\":\"" + SESSION + "\",\"type\":\"hello\",\"payload\":{}}");
            Envelope received = WaitForMessage(fixture.Channel);
            Assert.AreEqual("z", received?.Id);
            Assert.IsFalse(fixture.Channel.TryReceive(out _));
        }

        [TestMethod]
        public async Task WrongOrigin_TokenOrSession_IsRefused()
        {
            using var fixture = new Fixture();
            await Assert.ThrowsExactlyAsync<WebSocketException>(() => fixture.Connect(origin: "https://evil.example"));
            await Assert.ThrowsExactlyAsync<WebSocketException>(() => fixture.Connect(origin: null));
            await Assert.ThrowsExactlyAsync<WebSocketException>(() => fixture.Connect(token: SocketServer.NewToken()));
            await Assert.ThrowsExactlyAsync<WebSocketException>(() => fixture.Connect(token: ""));
            await Assert.ThrowsExactlyAsync<WebSocketException>(() => fixture.Connect(session: "fedcba9876543210fedcba9876543210"));
            Assert.IsFalse(fixture.Channel.Connected);

            // The dev server origin is allowed
            using ClientWebSocket dev = await fixture.Connect(origin: "http://localhost:5173");
            Assert.AreEqual(WebSocketState.Open, dev.State);
        }

        [TestMethod]
        public async Task ANewConnection_ReplacesTheOld()
        {
            using var fixture = new Fixture();
            using ClientWebSocket first = await fixture.Connect();
            using ClientWebSocket second = await fixture.Connect();
            WaitUntil(() => fixture.Channel.Connected);

            fixture.Channel.Send(MessageTypes.MODEL_CHANGED, new ModelChangedPayload { Modified = 2 });
            Envelope changed = await ReceiveEnvelope(second);
            Assert.AreEqual(MessageTypes.MODEL_CHANGED, changed.Type);

            // The first was closed by the server
            var buffer = new byte[256];
            using var timeout = new CancellationTokenSource(5000);
            try
            {
                WebSocketReceiveResult result = await first.ReceiveAsync(buffer, timeout.Token);
                Assert.AreEqual(WebSocketMessageType.Close, result.MessageType);
            }
            catch (WebSocketException)
            {
                // Aborted: also closed
            }
        }

        [TestMethod]
        public async Task Snapshot_NeedsTheToken_AndAllowsTheOrigin()
        {
            using var fixture = new Fixture();
            File.WriteAllBytes(Path.Combine(fixture.Folder.Path, "0001.bimgo"), new byte[] { 1, 2, 3, 4, 5 });
            using var http = new HttpClient();

            var request = new HttpRequestMessage(HttpMethod.Get, fixture.Server.SnapshotUrl(SESSION, 1));
            request.Headers.Add("Origin", ORIGIN);
            request.Headers.Add(SocketServer.TOKEN_HEADER, fixture.Token);
            using HttpResponseMessage ok = await http.SendAsync(request);
            Assert.AreEqual(HttpStatusCode.OK, ok.StatusCode);
            CollectionAssert.AreEqual(new byte[] { 1, 2, 3, 4, 5 }, await ok.Content.ReadAsByteArrayAsync());
            Assert.AreEqual(ORIGIN, string.Join(",", ok.Headers.GetValues("Access-Control-Allow-Origin")));

            var noToken = new HttpRequestMessage(HttpMethod.Get, fixture.Server.SnapshotUrl(SESSION, 1));
            noToken.Headers.Add("Origin", ORIGIN);
            using HttpResponseMessage refused = await http.SendAsync(noToken);
            Assert.AreEqual(HttpStatusCode.Forbidden, refused.StatusCode);

            var missing = new HttpRequestMessage(HttpMethod.Get, fixture.Server.SnapshotUrl(SESSION, 2));
            missing.Headers.Add("Origin", ORIGIN);
            missing.Headers.Add(SocketServer.TOKEN_HEADER, fixture.Token);
            using HttpResponseMessage gone = await http.SendAsync(missing);
            Assert.AreEqual(HttpStatusCode.NotFound, gone.StatusCode);

            // Preflight (custom header + Private Network Access)
            var preflight = new HttpRequestMessage(HttpMethod.Options, fixture.Server.SnapshotUrl(SESSION, 1));
            preflight.Headers.Add("Origin", ORIGIN);
            preflight.Headers.Add("Access-Control-Request-Private-Network", "true");
            using HttpResponseMessage allowed = await http.SendAsync(preflight);
            Assert.AreEqual(HttpStatusCode.NoContent, allowed.StatusCode);
            Assert.AreEqual("true", string.Join(",", allowed.Headers.GetValues("Access-Control-Allow-Private-Network")));
        }

        [TestMethod]
        public async Task ForeignHostHeader_IsRefused()
        {
            using var fixture = new Fixture();
            using var tcp = new TcpClient();
            await tcp.ConnectAsync(IPAddress.Loopback, fixture.Server.Port);
            NetworkStream stream = tcp.GetStream();
            byte[] request = Encoding.ASCII.GetBytes($"GET /snapshot/{SESSION}/1 HTTP/1.1\r\nHost: evil.example:{fixture.Server.Port}\r\nOrigin: {ORIGIN}\r\n" +
                $"{SocketServer.TOKEN_HEADER}: {fixture.Token}\r\n\r\n");
            await stream.WriteAsync(request);
            var buffer = new byte[256];
            int read = await stream.ReadAsync(buffer);
            StringAssert.StartsWith(Encoding.ASCII.GetString(buffer, 0, read), "HTTP/1.1 421");
        }

        [TestMethod]
        public void Origins_AreNormalised()
        {
            Assert.AreEqual("https://user.github.io", SocketServer.NormaliseOrigin("https://user.github.io/BimGo/?x=1"));
            Assert.AreEqual("http://localhost:5173", SocketServer.NormaliseOrigin(" http://localhost:5173/ "));
            Assert.AreEqual(string.Empty, SocketServer.NormaliseOrigin("file:///C:/x"));
            Assert.AreEqual(64, SocketServer.NewToken().Length);
        }
    }
}
