# BimGo Web — build notes, Phase 5 (live link with Revit)

**Ported from:** upstream `develop` @ `82d901e`.

## How it works

1. In Revit, the Go dialog has a new footer checkbox, **Open in the browser**.
   - It is saved as `LaunchSettings.OpenInBrowser`.
   - It is forced on, and greyed out, when BimGo.exe is not installed.
2. Go extracts the snapshot as before. It then starts a loopback server (once per Revit process) and registers the session there under a fresh one-time token.
3. Go opens `<WebViewerUrl>?live=127.0.0.1:<port>&session=<id>#token=<token>` in the default browser.
   - The default `WebViewerUrl` is `https://ibrahimfahdah.github.io/BimGo/`.
   - The token is in the fragment, so it is never sent to GitHub.
   - The viewer moves the token into `sessionStorage` and removes it from the address bar.
4. The viewer connects to `ws://127.0.0.1:<port>/live/<id>?token=…`, sends `hello`, and gets `hello.ack`.
5. It downloads the snapshot from `http://127.0.0.1:<port>/snapshot/<id>/<n>`, with the token in the `X-BimGo-Token` header.
6. It reads the sidecars (comments, bookmarks, sun, visibility) through the add-in, then starts the walkthrough.
7. Pressing Go again, or **F5 / Shift+R** in the viewer:
   - Revit sends `extract.ready` with a `snapshotUrl`.
   - The viewer reloads on the same connection, where the player stands.
   - An already-connected viewer doesn't open a second tab.

## What was built

| Where | File | Notes |
|---|---|---|
| Core | `Live/ILiveChannel.cs` | Extracted from `FolderChannel`, which now implements it (unchanged otherwise). |
| Core | `Live/SocketChannel.cs` | Envelopes over a `System.Net.WebSockets.WebSocket`; no new packages. The channel outlives connections: a page reload replaces the socket. Same checks as `FolderChannel`: session id, protocol version, 4 MB cap. |
| Core | `Live/SocketServer.cs` | `TcpListener` on 127.0.0.1 with just enough HTTP/1.1, then `WebSocket.CreateFromStream`. Port 47800, then the next free one (up to 20 tried). |
| Core | `Live/LiveSidecars.cs` | Reads and writes the four sidecars beside the model (the same files the desktop app uses). |
| Core | `LiveProtocol.cs` | Additive only: `sidecar.read` / `.data` / `.write` / `.result`; `HelloAckPayload.SnapshotNumber`, `.SnapshotUrl` and `.Sidecars`; `SnapshotReadyPayload.SnapshotUrl`. |
| Core | `Scene/LaunchSettings.cs` | `OpenInBrowser` and `WebViewerUrl` (sanitised to an http(s) URL). |
| Add-in | `Live/SessionHost.cs` | Sends on both channels (folders and socket) and receives from both. `EnableBrowser`, `BrowserUrl` and `LatestSnapshotUrl`; "attached" also counts a connected browser. |
| Add-in | `Live/LiveDispatcher.cs` | `EnsureServer`, `OpenInBrowser`; the hello ack carries the snapshot URL; sidecar messages. |
| Add-in | `Commands/Cmds_BimGo.cs`, `Forms/OptionsWindow.*`, `Utilities/App_Utils.cs` | The browser branch of Go and Status; the checkbox; `OpenUrl`. |
| Web | `core/live/LiveProtocol.ts`, `LiveClient.ts` | Envelopes, the WebSocket client, request / answer handling, and the snapshot download with progress. |
| Web | `core/sources/LiveSessionSource.ts` | `ModelSource` for Revit: edits, results, refresh, select, model changes, sidecars. Reconnects with backoff, and fails waiting edits when the link drops. |
| Web | `game/GameSession.ts`, `shell/AppShell.ts`, `guns/ScanGun.ts` | Live HUD badge, "N CHANGES · F5", refresh, R on the Scan tool for Show in Revit, sidecar sync, reload with pose, Save As in live mode (`session-save`), undo / redo refused in live mode (as on the desktop). |

## Security

- **Loopback only:** the server listens on 127.0.0.1 only.
- **Host header:** must be `127.0.0.1:<port>` or `localhost:<port>`. Anything else gets 421, which defends against DNS rebinding.
- **Origin allow-list:** only the viewer URL's origin, plus `http://localhost:5173` and `http://127.0.0.1:5173` for development.
  - A `github.io` origin covers every Pages site of that account; a custom domain would narrow it.
- **Token:** 32 random bytes per session, compared in constant time. It is required for both the socket and snapshot downloads.
- **Preflight:** answers CORS and Private / Local Network Access preflights for allowed origins only.
- **Viewer checks:** the viewer accepts only loopback `live=` hosts, and downloads snapshots only from the session's own host.

## Deviations from the plan

- **Raw TCP, not HttpListener:**
  - HttpListener needs a URL ACL or admin rights for 127.0.0.1.
  - With `localhost` instead, HTTP.sys rejects requests to `127.0.0.1`.
  - A raw `TcpListener` avoids both, and lets the browser use the IP address, which every browser treats as a secure origin from an https page.
- **Token on the socket URL:** the WebSocket gets the token as `?token=` on its URL (browsers can't set WebSocket headers), not in the first `hello`. A wrong token is refused before the upgrade.
- **The server lives in BimGo.Core** (not `BimGo.Revit/Live`), so it is unit-tested without Revit. The add-in only wires it up.
- **Not done yet:**
  - **Push from a file** (`journal.apply` from a standalone file into a running session): a file-mode browser tab doesn't know a session's port and token. This needs a design choice, e.g. "Push to Revit" from the Status dialog opening the file in a session tab.
  - **Add-in-served fallback viewer** (plan 6.7): Phase 6.

## Verified

- **C# (`dotnet run` in `tests/BimGo.Core.Tests`):** 155 tests pass, the same across 4 runs. The 7 new `SocketServerTests` cover:
  - a round trip both ways over a real loopback WebSocket
  - other-session, newer-protocol and unreadable messages being dropped
  - refusal of a wrong or missing Origin, a wrong or empty token, and an unknown session
  - a reconnect replacing the old socket
  - snapshot download with token and CORS, 404, and the preflight
  - a foreign Host header getting 421
- **Upstream test fix:** two upstream tests used `Assert.ThrowsException`, which was removed in MSTest 4. They now use `ThrowsExactly`; without this the test project didn't compile.
  - Note: `dotnet test` is refused on the .NET 10 SDK for this runner; use `dotnet run`.
- **Add-in build:** builds for Revit 2026 (Release) with `-p:RevitAddinsRoot=<scratch folder>`, so nothing was copied into `%AppData%\Autodesk\Revit\Addins`.
  - R25 and R27 can't build on this machine (those Revit versions aren't installed).
- **Web:** lint, type-check and 82 tests pass. The build is 336 kB (111 kB gzip).
- **End to end without Revit:** a console stand-in using the real `SocketServer`, `SocketChannel` and `LiveSidecars`, with headless Chrome on the dev server:
  - hello, then the snapshot download (Snowdon, 10 MB), then the four sidecar reads, then the walkthrough.
  - Move: "Moved in Revit", with the journal entry marked as applied to Revit.
  - Clone: got Revit id 999001.
  - Show in Revit: "Selected in (fake) Revit". Undo was refused.
  - A new bookmark was written to `Model.bimgo-bookmarks.json` by the add-in code.
  - Refresh: snapshot 2 reloaded on the same connection, with the player in the same spot and the bookmark read back.
- **Not tested:**
  - inside Revit itself
  - from the Pages origin (Chrome's Local Network Access prompt)
  - Firefox and Safari

## Before using it in Revit

The add-in must be rebuilt and installed into the Addins folder (Debug or Release R26). That overwrites the installed BimGo add-in, so it was not done; it is the user's decision.

Then, in Revit:

1. Press Go.
2. Tick **Open in the browser**.
3. Launch.
4. Allow local network access if Chrome or Edge asks.
