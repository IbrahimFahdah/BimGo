# BimGo Web — Implementation Plan (draft)

**Goal:** port the BimGo walkthrough app (`BimGo.App`) to a browser app hosted on GitHub Pages, with full feature parity, while keeping the Revit add-in as the bridge for live sessions and push-to-Revit.

**Source:** [aussieBIMguru/BimGo](https://github.com/aussieBIMguru/BimGo/tree/develop) (MIT), branch `develop`, reviewed at `82d901e` ("Textures"). Size at that commit: App ≈ 20.8k lines C#, Core ≈ 7.1k, Revit add-in ≈ 10.1k (≈ 38k total). Renderer ≈ 17 files in `BimGo.App/Rendering`.

**Work location:** a fork of BimGo, branch `web` off `develop`, viewer in a `web/` folder (see §10 for the open points).

---

## 1. Summary

| Part | Today | Web version |
|---|---|---|
| Viewer / engine | `BimGo.exe`: C# (.NET 8), OpenGL 4.1 / GLSL 330 via Silk.NET, Win32 window | Static site: TypeScript + WebGL2, hosted on GitHub Pages |
| File format | `.bimgo` (ZIP: JSON + `geometry.bin`, optional `materials.json` + `textures/`) | Unchanged; read and written in the browser |
| Revit add-in | Extractor + session bridge over a watched folder (Revit 2025 / 2026 on .NET 8, 2027 on .NET 10) | Same, plus a localhost WebSocket channel |
| Live protocol | JSON envelopes as files (`FolderChannel`) | Same JSON envelopes as WebSocket frames |
| Install | Installer copies exe to `%LocalAppData%\Programs\BimGo` | Nothing to install for the viewer (optional PWA install) |

The desktop app keeps working throughout. The web viewer is a second client of the same format and protocol.

---

## 2. Architecture

```
 GitHub Pages (static)                     User's PC
 ┌──────────────────────────┐   HTTPS    ┌──────────────────────────────┐
 │ index.html + JS bundle   │ ─────────► │ Browser                      │
 │ (viewer, no server code) │            │  ├─ WebGL2 renderer           │
 └──────────────────────────┘            │  ├─ physics / guns / UI       │
                                         │  ├─ .bimgo reader / writer    │
                                         │  └─ LiveClient (WebSocket)    │
                                         │          │ ws://127.0.0.1:port│
                                         │          ▼                    │
                                         │ Revit + BimGo add-in          │
                                         │  ├─ SessionHost               │
                                         │  ├─ FolderChannel (desktop)   │
                                         │  ├─ SocketChannel (new, web)  │
                                         │  └─ LiveDispatcher → Revit API│
                                         └──────────────────────────────┘
```

- The site is fully static. All logic runs in the browser.
- `.bimgo` files are opened from the user's disk and never uploaded.
- The only server is the WebSocket listener inside the Revit add-in, on `127.0.0.1`.

---

## 3. Technology choices

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript (strict) | Typed port of the C# code; shared DTO types with the format |
| Build | Vite | Fast dev server, static output for Pages |
| Rendering | **Own WebGL2 renderer** (port of `Rendering/`) | Matches the repo principle "own the renderer". The README notes the lighting, AO and materials GLSL was already compiled, linked and run in WebGL2 (ANGLE / SwiftShader). |
| Maths | gl-matrix (MIT) | Replaces `System.Numerics` |
| ZIP | fflate (MIT) | Fast, small, streaming unzip / zip |
| UI | Own canvas / DOM UI using the existing `UiTheme` look | The repo rules out UI toolkits that change the look |
| Tests | Vitest | Port of `BimGo.Core.Tests` cases |
| Hosting | GitHub Pages via GitHub Actions | Free for public repos, HTTPS, custom domain possible |

**Dependency policy (README AI item 3, §10):** every package needs Gavin's explicit yes, a permissive licence, a pinned version and a row in the README dependency table. The web packages (gl-matrix, fflate, Vite, Vitest, TypeScript, ESLint) go to him as one list in the handoff doc. `BimGo.Revit` stays dependency-free at run time: the socket work uses only built-in .NET.

Alternative considered: Three.js. It is faster to start with but would replace BimGo's own shadow, AO and lighting pipeline. Rejected to keep the look identical and the code ownership model intact.

Alternative considered: compile `BimGo.Core` to WebAssembly (Blazor). Rejected for the core path: adds ~2 MB+ runtime, and the reader / journal logic is small enough to port to TypeScript. Can be revisited if Core grows.

---

## 4. Repository layout

In the fork, following the repo's conventions:

```
BimGo/  (fork, branch web)
├─ ai/
│  └─ 2610xx_Web/
│     └─ 0_BimGo Web_Handoff.md   ← this plan, in the repo's handoff style
├─ src/                           ← unchanged desktop + add-in (+ socket work in Phase 5)
├─ tests/                         ← unchanged; shared fixtures added
└─ web/
   ├─ index.html
   ├─ src/
   │  ├─ main.ts
   │  ├─ core/            ← port of BimGo.Core
   │  │  ├─ format/       BimGoReader, BimGoWriter, models, sidecar JSON, materials.json + textures/
   │  │  ├─ edits/        EditJournal, EditMessages
   │  │  ├─ scene/        SceneData, SiteCoordinates, SolarPosition, LightingData, CategoryCatalog,
   │  │  │                MaterialData, ProxyCatalog, TextureOverrides, TextureSearch
   │  │  ├─ live/         LiveProtocol (envelopes, payload types), LiveClient (WebSocket), JournalPush
   │  │  └─ sources/      IModelSource, FileEditSource, LiveSessionSource
   │  ├─ engine/          ← port of BimGo.App/Rendering + Physics
   │  │  ├─ gl/           GL facade (WebGL2), ShaderProgram, RenderTarget
   │  │  ├─ render/       SceneRenderer, SceneBatches, ShadowMaps, SunLighting, ArtificialLighting,
   │  │  │                LightShadows, ScreenEffects, Overlay3D, MaterialTextures, ProxyPack
   │  │  ├─ ui/           UiBatch, UiFont (canvas-2D atlas), TextBuffer, UiTheme
   │  │  └─ physics/      Bvh, CharacterController, DynamicSet, GeoMath
   │  ├─ game/            ← port of BimGo.App/Game
   │  │  ├─ GameSession.*.ts, Player, BookmarkStore, CommentStore, ProgressScreen
   │  │  └─ guns/         Scan, Measure, Portal, Comment, Teleport, Hammer, Gizmo, Clone
   │  └─ platform/        ← replaces Platform/ + Native/ + Audio/
   │     ├─ input.ts      keyboard, Pointer Lock, Keyboard Lock
   │     ├─ files.ts      file picker, drag & drop, File System Access, folder picker, downloads
   │     ├─ audio.ts      Web Audio (port of the synthesised SoundSystem)
   │     └─ settings.ts   localStorage (replaces %AppData%\BimGo\settings.json)
   ├─ public/
   │  ├─ proxies/         CC0 proxy pack (21 × 512 px JPEG + proxies.json, ≈ 1 MB) copied from src/BimGo.App/Resources/Proxies
   │  ├─ fonts/           open-licence fallback fonts (see §5)
   │  └─ samples/         small demo .bimgo files (< 100 MB each)
   └─ tests/
.github/workflows/pages.yml       builds web/ and deploys to Pages
```

Shared test fixtures (`.bimgo` files and JSON envelopes) live in one folder read by both `tests/BimGo.Core.Tests` and `web/tests`.

---

## 5. Platform mapping

| Desktop (Windows) | Web replacement | Notes |
|---|---|---|
| `Native/Gl.cs` (Silk.NET) | `engine/gl` facade over `WebGL2RenderingContext` | Keep the same `Gl.Xxx` call shape to ease porting |
| GLSL 330 (strings in `Shaders.cs`) | GLSL ES 300 | Swap `#version`, add `precision` lines. `sampler2DArray`, `sampler2DArrayShadow` and `texelFetch` all exist in ES 300. No geometry shaders, `gl_Layer` or border clamp are used, so no structural changes. |
| RGBA32F AO geometry target | `EXT_color_buffer_float` | Required to render to it; fall back to AO off with a toast (same as the desktop GPU-refusal path) |
| RGBA16F glow targets, linear filtered | Core WebGL2 for sampling; render needs `EXT_color_buffer_float` / `EXT_color_buffer_half_float` | Same fallback as AO |
| RGBA32F material table (`texelFetch`) | Core WebGL2 | Sampling only, no extension needed |
| Material texture arrays uploaded as **BGRA** | Decode with `createImageBitmap` / canvas, upload **RGBA** | WebGL2 has no BGRA upload format |
| `TEXTURE_MAX_ANISOTROPY` | `EXT_texture_filter_anisotropic` | Optional; skip when missing |
| `glReadPixels` screenshot | `canvas.toBlob()` → download | Same "no HUD" render pass |
| Win32 window / `GameWindow` | `<canvas>` + `requestAnimationFrame` | Handle resize and device pixel ratio |
| Mouse capture | Pointer Lock API | Esc always releases the lock. Chrome blocks re-locking for ~1 s and needs a click, so resume is "click to continue". |
| F11 borderless | Fullscreen API | |
| `WinMm` waveOut, sounds synthesised at startup | Web Audio API, same synthesis into `AudioBuffer`s | No audio assets. Needs a user gesture before first sound. |
| `UiFont`: GDI+ atlas from Bahnschrift / Segoe UI / Consolas | Canvas-2D atlas, same families via `local()` | Present on Windows only and not redistributable. Ship OFL fallbacks for macOS / Linux (e.g. a DIN-style sans + a monospace) and check the look. |
| `FileDialogs` | `<input type=file>`, drag & drop, File System Access API | Save-in-place on Chrome / Edge; download elsewhere |
| Texture deep scan (`FolderBrowserDialog` + `TextureSearch`) | `showDirectoryPicker()` + same matcher over the handle tree | Chrome / Edge only. Elsewhere: pick image files manually, or skip. Keep the 8-level / 50 000-image caps. |
| Proxy pack beside the exe | `public/proxies/`, fetched on first use | Cached by the PWA |
| File association | PWA `file_handlers` | Chrome / Edge, installed PWA only |
| `%AppData%` settings | `localStorage` | Per browser and per origin |
| Recent files | IndexedDB file handles | Chrome / Edge; name list only elsewhere |
| `Pictures\BimGo\` screenshots | Browser download | |
| CSV exports (comments, push report) | Blob download | |

### Keyboard conflicts

Browsers reserve some keys. Proposed rebinding (desktop keys unchanged):

| Desktop key | Problem in browser | Web binding |
|---|---|---|
| Esc (pause / cancel gizmo / close panel) | Releases Pointer Lock, can't be intercepted | Esc still works: lock loss opens the pause menu, cancels the gizmo or closes the panel. **P** also opens pause. |
| Ctrl+1–9 (bookmarks) | Switches browser tabs | Captured in fullscreen via Keyboard Lock (Chrome / Edge); otherwise **Alt+1–9** (note: Alt+1–9 switches tabs on Linux; there, fullscreen only) |
| F5 (refresh from Revit) | Reloads the page | `preventDefault`; also **Shift+R** |
| F12 (screenshot) | Opens DevTools | **Shift+F12**; F12 left alone. (Print Screen is not used: Windows usually takes it and the page only sees the key-up.) |
| F1 (help) | Browser help | `preventDefault` (works) |
| Ctrl+S / Ctrl+O | Browser save / open | `preventDefault` (works) |
| Tab (minimap) | Focus change | `preventDefault` (works) |
| Ctrl+W (none in BimGo) | Closes tab | Can't be blocked; warn on unsaved changes via `beforeunload` |

---

## 6. Live link over WebSocket (Revit add-in changes)

The protocol (README §7) is already JSON envelopes: `protocol`, `id`, `seq`, `sessionId`, `type`, `replyTo`, `sentUtc`, `payload`. Only the transport changes.

### 6.1 New in `BimGo.Core/Live`

- `ILiveChannel` interface extracted from `FolderChannel` (send envelope, receive event, close).
- `FolderChannel` implements it unchanged (desktop app).
- `SocketChannel` implements it over `System.Net.WebSockets` (built into .NET 8 and .NET 10, so **no new package**; the add-in stays dependency-free).

### 6.2 New in `BimGo.Revit/Live`

- `SocketHost`: an `HttpListener` that upgrades to WebSocket.
  - Prefix: test `http://localhost:<port>/` vs `http://127.0.0.1:<port>/` on a standard (non-admin) account. Only the one that works without a URL ACL is used; if neither, fall back to `TcpListener` on `127.0.0.1` with a manual WebSocket handshake.
  - Port: fixed default (e.g. 47800) with fallback to the next free one; the chosen port goes in the launch URL.
  - Runs on a background thread; does network IO only (same rule as `SessionHost` timers).
  - Hands messages to the existing `LiveDispatcher` → `ExternalEvent` → Revit thread. No change to Revit-side edit logic.
- Optional: serve `GET /snapshot/<n>.bimgo` and `GET /payload/<id>` from the same listener (see 6.4).
- Built for all three add-in targets (2025 / 2026 on net8.0-windows, 2027 on net10.0-windows).

### 6.3 Security

- **Origin check:** accept only the Pages origin (e.g. `https://<user>.github.io`) and `http://localhost:5173` for dev. Configurable in add-in settings. Note: a `github.io` origin covers every Pages site of that account, not just this one. A custom domain narrows it.
- **Session token:** one-time random token per Go, passed in the launch URL fragment (`#token=…`, never sent to GitHub's servers) and required in the first `hello`.
- **HTTP endpoints:** `GET /snapshot` and `/payload` also require the token (as a header), answer CORS for the allowed origins only, and answer the Private / Local Network Access preflight (`Access-Control-Allow-Private-Network: true`).
- Bind to loopback only, never `0.0.0.0`.
- Keep the existing 4 MB message cap and session-id validation.

### 6.4 Messages that pass file paths

| Message | Today | Web |
|---|---|---|
| `extract.ready` | `snapshot path` on disk | Add `snapshotUrl` (served by `SocketHost`) **or** stream the `.bimgo` as binary frames. Prefer the URL: simpler, supports progress, avoids the 4 MB cap. |
| `journal.apply` (large) | `payloadPath` | Browser always sends `entries` inline; raise the cap for this type or chunk it. |
| Sidecar files (comments, bookmarks, sun, visibility beside the `.rvt`) | App writes `<model>.bimgo-*.json` beside the Revit model | New messages `sidecar.read` / `sidecar.write`; the add-in reads and writes the files. Additive to protocol 1. **Live sessions only:** in file mode these are stored inside the `.bimgo`, as on desktop. |

All additions are additive: older apps ignore them, and the browser times out with "update the add-in" when they are missing (same pattern as `journal.apply`).

### 6.5 Launch from Revit

`App_Utils` today starts `BimGo.exe --session <id>`. Add a setting **Open walkthroughs in: Desktop app / Browser**. Browser mode:

1. Start `SocketHost` for the session.
2. Open `https://<user>.github.io/BimGo/?session=<id>&port=<port>#token=<token>` with the default browser.
3. The viewer connects, sends `hello`, gets `hello.ack`, requests the snapshot, loads it.

### 6.6 Browser behaviour to handle

- Chrome's Local Network Access prompt the first time a public site reaches `127.0.0.1`: show a one-line explanation before connecting.
- Safari may block `ws://127.0.0.1` from an `https://` page: detect and suggest Chrome / Edge, or the add-in-served fallback (6.7).
- Reconnect with backoff if the socket drops; the existing heartbeat logic decides when the session is lost.

### 6.7 Fallback: add-in serves the viewer

Bundle the built viewer into the add-in and serve it from `http://127.0.0.1:<port>/`. Same origin as the socket, so no permission prompts or mixed-content issues. Works offline. Used automatically when the Pages connection fails, or by a setting.

The origin includes the port, so settings and recent files in `localStorage` / IndexedDB are kept only while the port stays the same. Serve the fallback viewer on a fixed port (separate from the per-session socket port if needed), or accept the loss.

---

## 7. Phases

Each phase ends with a deployable Pages build.

### Phase 0 — Scaffold (≈ 1 week)

- Fork, `web` branch, `ai/…_Web` handoff doc, dependency list to Gavin.
- Vite + TypeScript, ESLint, Vitest, GitHub Actions → Pages.
- WebGL2 GL facade, canvas, resize, frame loop, input, Pointer Lock.
- Port `UiTheme`, `UiFont` (canvas-2D atlas + fallback fonts), `UiBatch`, `TextBuffer`: home screen with **Open .bimgo…** and drag & drop.

**Done when:** an empty home screen in the BimGo look is live on Pages.

### Phase 1 — Read and walk (≈ 2–3 weeks)

- Port `BimGoReader` (all format versions incl. links, visibility, lighting, bookmarks, materials), `SceneData`, `CategoryCatalog`, `SiteCoordinates`, `MaterialData`. Materials are read and kept (so a save round-trips them) but drawn as plain colours until Phase 3b.
- Load `geometry.bin` straight into vertex / index buffers (28-byte `SceneVertex`: position, normal, packed RGBA; the reader rejects other sizes).
- Port `SceneBatches`, basic `SceneRenderer` (classic light), `FpsCamera`.
- Port `Bvh`, `CharacterController`, `GeoMath`: collision, gravity, stairs, fly mode.
- HUD: crosshair, room readout, level, minimap (Tab), F1 help, Page Up / Down.
- Progress screen while loading (port of `ProgressScreen`).

**Done when:** a real Revit export opens in the browser and walks like the desktop app at ≥ 60 fps on a mid-range laptop.

### Phase 2 — Read-only guns and info (≈ 2 weeks)

- Guns 1–5: Scan (info panel, parameters), Measure, Portal, Comment, Teleport.
- Coordinate readout (L), hide / isolate (I / Shift+I), category and link toggles, SHOW ALL.
- Bookmarks (B, Alt / Ctrl+1–9, list, thumbnails), home (H / Shift+H).
- Screenshot to download.

**Done when:** every non-editing feature of the file mode matches the desktop app.

### Phase 3 — Rendering parity (≈ 2–3 weeks)

- Port `ShadowMaps`, `SunLighting`, `SolarPosition`: cascaded sun shadows, glass transmittance, sun panel.
- Port `ScreenEffects` (AO), `ArtificialLighting`, `LightShadows`, glow / bloom.
- Quality presets tuned for WebGL; auto-downgrade when frame time is high.

**Done when:** side-by-side screenshots with the desktop app match on the test models; Medium shadows hold 60 fps on the reference laptop.

### Phase 3b — Materials / Realistic mode (≈ 2 weeks)

Upstream marks the materials round as experimental (build B not yet compiled at review time; may be rolled back). Start this phase only once upstream confirms it is kept.

- Port `MaterialTextures` (texture arrays, RGBA32F material table, RGBA upload, mipmaps, anisotropy), `ProxyPack` + `ProxyCatalog`, `TextureOverrides`, tint / invert / fade shading.
- Textures panel; texture deep scan via the folder picker (Chrome / Edge).

**Done when:** the upstream tint test model and a textured project render like the desktop app in Realistic mode.

### Phase 4 — Editing and saving files (≈ 2 weeks)

- Port `EditJournal`, `EditMessages`, `FileEditSource`, journal replay.
- Guns 6–8: Demolish, Gizmo (move / rotate, modes, snap, increments), Clone.
- Undo / redo, unsaved-changes guard.
- Port `BimGoWriter` (incl. changed materials set): Save (File System Access) / Save as (download), atomic write semantics in memory.
- Comments list and CSV export.

**Done when:** a file edited in the browser opens in the desktop app with the same journal, and vice versa (round-trip test).

### Phase 5 — Live link (≈ 3 weeks, C# + TS)

- Core: `ILiveChannel`, `SocketChannel`.
- Add-in: `SocketHost`, origin + token checks, snapshot URL, sidecar messages, launch-in-browser setting.
- Web: `LiveClient`, `LiveSessionSource`, Scan → R select in Revit, `model.changed` prompt, refresh.
- Push to Revit from a file (`JournalPush`): dry run, conflicts, report CSV.

**Done when:** Go from Revit opens the Pages viewer, and Demolish / Gizmo / Clone / select / refresh / push all work against Revit 2025, 2026 and 2027.

### Phase 6 — Polish and release (≈ 1–2 weeks)

- PWA: manifest, offline cache (incl. proxy pack and fonts), `.bimgo` file handler.
- Add-in-served fallback viewer (6.7).
- Large-model handling: streamed unzip, chunked buffer upload, memory warnings.
- Browser matrix testing, docs, README section, changelog.

**Total:** roughly 15–20 weeks for one developer, plus time to follow upstream `develop` (§9).

---

## 8. Testing

Port the existing `tests/BimGo.Core.Tests` suite to Vitest; shared fixture files are read by both the C# and TS tests.

| Area | Upstream tests to port | Additions |
|---|---|---|
| Format | `BimGoRoundTripTests`, `BimGoReaderCompatibilityTests`, `SidecarTests` | Cross-runtime round-trip: TS writes → C# reads, and back |
| Materials | `MaterialTests`, `TextureSearchTests` (incl. proxy catalog and override cases) | Directory-handle version of the deep scan |
| Journal | `EditJournalTests` | Replay tests (not covered on desktop today) |
| Sun / lighting | `SolarPositionTests`, `LightingTests` | Same expected values |
| Settings / progress | `LaunchSettingsTests`, `OperationProgressTests` | localStorage sanitising |
| Protocol | `LiveProtocolTests` | C# test that round-trips envelopes through `SocketChannel`; origin / token rejection tests |
| Rendering | — | Screenshot comparison against desktop renders of reference models |
| Performance | — | FPS and load time on small / medium / large reference exports |
| Browsers | — | Chrome, Edge (primary); Firefox; Safari (best effort, no live link guaranteed) |

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Large models exceed browser memory | Can't open big exports | Streamed unzip, upload and free CPU copies, warn above a size threshold, suggest "active view only" export |
| WebGL2 performance lower than native | Low FPS with shadows / AO | Quality presets, auto-downgrade, cached light shadow maps (already the design) |
| Upstream `develop` moves fast (materials round landed during review) | Port chases a moving target | Work on a `web` branch, rebase on `develop` regularly, record the upstream commit each phase ported from |
| Materials round is experimental | Wasted porting effort if rolled back | Phase 3b gated on upstream confirming it; Phase 1 reader only preserves the data |
| UI fonts are Windows system fonts | Different look on macOS / Linux; fonts can't be shipped | `local()` on Windows, OFL fallbacks elsewhere, check the look |
| Local Network Access prompts / Safari blocking | Live link fails to connect | Clear prompt text; add-in-served fallback viewer |
| Security of the localhost socket | Other sites could talk to Revit | Origin allow-list, per-session token in URL fragment (also on HTTP endpoints), loopback bind |
| Desktop and web drift apart | Format or protocol mismatch | Shared fixtures in both test suites; format and protocol changes stay additive |
| Repo dependency policy (Gavin's approval per package) | Upstream merge blocked | One dependency list in the handoff doc up front; add-in changes use only built-in .NET; propose upstream as a PR |
| `HttpListener` URL reservation | May need admin on some setups | Test both loopback prefixes on a standard account; fall back to raw `TcpListener` with a manual WebSocket handshake |

---

## 10. Open decisions

1. ~~Separate repo or fork?~~ **Fork** of aussieBIMguru/BimGo. Still open: `web/` folder in the fork (proposed) vs a separate repo.
2. Branch: `web` off `develop`, rebased regularly (proposed).
3. Pages URL / custom domain (needed for the add-in's origin allow-list). Default with a fork: `https://<user>.github.io/BimGo/`.
4. Public fork (free Pages) or private (paid plan)?
5. Is Safari support required for the live link?
6. Should the add-in default to the browser or the desktop app for Go? (Proposed: desktop until Phase 5 is proven.)
7. Realistic mode (materials) in scope for parity, or after upstream stabilises it? (Proposed: Phase 3b, gated.)
8. Fallback fonts for non-Windows platforms.
9. Upstream: offer the add-in socket changes (and maybe `web/`) back to aussieBIMguru/BimGo?
