# BimGo — Handoff Brief (for a new chat)

**Purpose of the next chat:** turn **RvtGo** (a Revit add-in that runs a first-person walkthrough inside Revit's process) into **BimGo**, which has two parts:

- **BimGo**, a standalone Windows app. It either:
  - connects to live Revit sessions, receives geometry from them and sends edits back; or
  - opens **`.bimgo`** files and works on them with no Revit at all, then saves them again as new `.bimgo` files.
- **BimGo for Revit**, a slim add-in. It is mainly an **extractor and session bridge**. It either:
  - serves a live session to the app; or
  - writes standalone `.bimgo` extracts.

This is a large restructure. **Section 6 lists the decisions to confirm with Gavin before writing code.** The rest of this brief is the proposal plus the context needed to carry it out.

**Read first:**
1. This brief.
2. `RvtGo_Handoff.md` (project doc). It describes the current engine, architecture, how to add a gun, and Gavin's conventions. **All conventions there still apply.**
3. `RvtGo_BuildNotes.md` (project doc). It holds the v1/v2 decisions and the changelog.
4. `RvtGo_Spec.md` (project doc). This is the original brief.
5. The current code. **Ask Gavin for a fresh zip of his working copy.** He is fixing v2's build errors in Visual Studio, so his copy is the source of truth.

---

## 1. Where RvtGo is now (start of the BimGo work)

- **v1 (2026-10-01):** working in Revit 2025–2027.
  - The engine is a custom OpenGL renderer written with hand-written P/Invoke, with no NuGet packages.
  - Physics, the HUD, the minimap and the pause menu are in place.
  - Guns: Scan, Measure, Portal and Comment.
- **v2 (2026-10-04):** delivered but **not yet compiled** when this brief was written. Gavin is working through the build errors. The first one, a duplicate `Win32.PostMessageW`, is already fixed. v2 added:
  - a room readout (ROOM row in the status panel plus a banner when the room changes);
  - a gun bar with symbols drawn in code (`GunIcons.cs`);
  - four new guns:
    - **5 Teleport.**
    - **6 Demolish:** prime, then demolish. It sets Phase Demolished by default; T switches to real delete.
    - **7 Gizmo:** WASD moves, Q/E rotate, RMB commits, Esc cancels.
    - **8 Clone:** copies in place, then drops straight into the gizmo.
  - **Revit write-back** through `Bridge/`:
    - The pieces are `BridgeChannel`, `RevitBridge`, an `ExternalEvent` and a failure preprocessor.
    - Edits are optimistic in the game and reverted if Revit refuses.
    - Clones are tracked by a session key until Revit returns their new ElementId.
  - **Runtime geometry edits:**
    - Hidden elements have their index ranges overwritten with degenerate triangles.
    - Moved and cloned elements are `DynamicInstance`s, drawn with a `uModel` matrix.
    - Picking and collision for those instances reuse the static BVH with a one-element mask.
- **Threading today:**
  - Revit thread: `Cmd_Launch` → `SceneExtractor` → immutable `SceneData` → game thread inside Revit's process.
  - Only `Commands/`, `Extraction/` and `Bridge/RevitBridge.cs` touch the Revit API.

**Folder map today (single project `src/RvtGo`):**

| Folder | Touches Revit? | Destination in BimGo (proposal) |
|---|---|---|
| `Commands/`, `Extraction/`, `Forms/OptionsWindow`, `Bridge/RevitBridge.cs`, `Application.cs`, template `Extensions/ General/ Utilities/ Resources/` | Yes | **BimGo.Revit** (add-in) |
| `Scene/` (`SceneData`, `CategoryCatalog`, `LaunchSettings`), `Bridge/BridgeMessages.cs` (DTOs) | No | **BimGo.Core** (shared library) |
| `Game/`, `Rendering/`, `Physics/`, `Platform/`, `Native/`, `Audio/` | No | **BimGo.App** (standalone exe) |

The split is clean because of the existing threading rule: everything on the game thread is already free of Revit references.

---

## 2. Target architecture

```
┌────────────────────────── Revit process (2025/26/27) ──────────────────────────┐
│ BimGo.Revit add-in                                                             │
│   Ribbon: Go (live) · Export .bimgo · (Session status)                          │
│   SceneExtractor ──► BimGoWriter (Core) ──► snapshot.bimgo                       │
│   SessionHost: heartbeat, watches to-revit/, writes to-app/                      │
│   RevitBridge: ExternalEvent → transactions (demolish/delete/move/copy/select)   │
└───────────────▲────────────────────────────────────────────────┬───────────────┘
                │  %LocalAppData%\BimGo\Sessions\<id>\  (watched folder)  │
                │  session.json · to-revit\*.json · to-app\*.json · *.bimgo │
┌───────────────┴────────────────────────────────────────────────▼───────────────┐
│ BimGo.App (BimGo.exe, own process, single instance)                             │
│   Home screen: Open .bimgo · Live sessions · Recent                             │
│   ModelSource: LiveSession (protocol) | StandaloneDocument (.bimgo + journal)   │
│   Engine: GameWindow, renderer, physics, guns (unchanged core)                  │
└────────────────────────────────────────────────────────────────────────────────┘
            BimGo.Core (net8.0, no Revit, no GL): .bimgo format, protocol DTOs,
            SceneData model, edit journal, shared constants
```

**Why a separate process is better than today's in-Revit game thread:**
- A crash in the engine or GL can no longer take Revit down.
- The app runs with no Revit open, or alongside several Revit sessions.
- The Revit add-in becomes much smaller.

**Solution layout (proposal, needs Gavin's OK; he asks to approve folder reorganisations):**

```
src/
  BimGo.sln
  BimGo.Core/      net8.0            .bimgo reader/writer, protocol, journal, SceneData
  BimGo.App/       net8.0-windows    exe: engine + home screen (+ WinForms only for file dialogs, or comdlg32 P/Invoke)
  BimGo.Revit/     template configs  Debug/Release R25 R26 (net8) · R27 (net10) → references BimGo.Core
```

- Revit 2027 on net10 can reference a net8 `BimGo.Core`.
- `System.Text.Json` and `System.IO.Compression` are in-box, so there are **still no NuGet packages**.
- The Core DLL must have a unique name (`BimGo.Core.dll`) to avoid clashes with other add-ins.

---

## 3. The `.bimgo` format (proposal)

Gavin suggested **"masked JSON with a `.bimgo` extension"**. I recommend a **zip container with JSON for metadata and binary for geometry**:

- Pure JSON for millions of vertices is roughly 5–10× bigger and much slower to parse.
- The zip keeps the JSON parts human-readable and diffable.
- An option to dump a full JSON debug file can be kept for inspection.

**Decision 6.1.**

```
model.bimgo  (ZIP, extension masked)
├── manifest.json        format version, app/add-in versions, created UTC, provenance, units = metres
├── model.json           origin offset, true north angle, project base / survey point, phases (+ working phase),
│                        levels, rooms, categories (catalog keys + loaded flags + counts)
├── elements.json        per element: ElementId, UniqueId, name, category, family/type, level, group, flags
│                        (IsProxy, Movable, MoveBlockReason, Pivot), bounds, opaque/transparent index ranges,
│                        optional parameters (decision 6.6)
├── geometry.bin         header + SceneVertex[] (28 B: pos, normal, RGBA8) + uint[] indices, little-endian
├── comments.json        comment markers (replaces the <model>.rvtgo.json sidecar for standalone files)
├── journal.json         standalone edits (see below); empty in a fresh extract
└── thumbnail.png        optional, for the home screen / recent list
```

- **Provenance:** source model path, cloud project/model GUIDs if present, `ProjectInformation.UniqueId` as the model identity key, Revit version, extraction settings, user and machine. This lets a `.bimgo` be matched back to its model later.
- **Element identity:** store **both** `ElementId` (fast, used by live sessions) and `UniqueId`, which is the stable key for replaying standalone edits into Revit later.
- **Compression:** `geometry.bin` uses `CompressionLevel.Fastest` for saved files and `NoCompression` for live-session snapshots, where speed matters more than size.
- **Versioning:** a `formatVersion` integer. The reader must load older versions; a newer version is refused with a clear toast.
- **Atomic writes:** write `*.tmp`, then `File.Move(overwrite)`, following the existing `CommentStore` pattern.
- **Edits in standalone mode are a journal, not baked geometry.** The base extract stays untouched, and `journal.json` lists ordered entries: `hide {uniqueId, mode: demolish|delete}`, `transform {uniqueId|cloneKey, offset, angle}`, `clone {sourceUniqueId|cloneKey, cloneKey, offset, angle}`. On load the journal is replayed with the same v2 machinery (`SetStaticHidden`, `DynamicSet`). This gives:
  - non-destructive edits with undo;
  - small saves;
  - a later **"Push edits to Revit"** feature, which replays the journal through a live session by UniqueId (phase 4).
  - "Save as flattened" (bake the edits into new geometry) can be an option later. **Decision 6.8.**
- **Coordinates:** keep scene-local metres around `OriginOffset`, as today. Also capture true north, the project base point and the survey point. These enable the coordinate readout and sun/shadow ideas from the backlog (Gavin has a `GetRevitSunVector` method).

---

## 4. Session protocol: app ↔ Revit (proposal)

**Transport:** a watched folder, as Gavin suggested. It is simple, easy to debug (you can see the messages), survives restarts, and works across processes. Keep the message layer **transport-agnostic** so named pipes (in-box `System.IO.Pipes`) can replace it later without touching the guns. **Decision 6.2.**

**Locations:**

```
%LocalAppData%\BimGo\
  Sessions\<sessionId>\
    session.json        protocol version, sessionId, revitVersion, revitPid, docTitle, docPath, modelKey,
                        phase info, createdUtc, heartbeatUtc, state (starting|ready|busy|closing|closed)
    to-revit\           app → Revit messages   (000001.json, 000002.json …)
    to-app\             Revit → app messages
    snapshots\          <timestamp>.bimgo written by the add-in on extract/refresh
  App\app.json          running app PID + its inbox path (single-instance discovery)
  App\inbox\            "attach to session X" / "open file Y" requests from add-ins or shell
  Logs\  Recent.json
%AppData%\BimGo\settings.json        (was %AppData%\RvtGo\settings.json — migrate once)
```

**Envelope (every message):**

```json
{ "protocol": 1, "id": "guid", "seq": 42, "sessionId": "…", "type": "edit.transform",
  "replyTo": null, "sentUtc": "…", "payload": { … } }
```

**Message types (v1 of the protocol):**

| Direction | Type | Payload / purpose |
|---|---|---|
| app → Revit | `hello` | App version; asks for session info |
| app → Revit | `extract.request` | Extraction settings (categories, threshold, proxy mode); Revit replies `extract.ready` |
| app → Revit | `edit.demolish` / `edit.delete` / `edit.transform` / `edit.copy` | The existing `BridgeRequest` fields (ElementId or cloneKey, pivot, translation, angle, label) |
| app → Revit | `select.elements` | Select / zoom to elements in Revit (the "Return to Revit" backlog item) |
| app → Revit | `journal.apply` | Replay a standalone journal by UniqueId (phase 4) |
| app → Revit | `detach` | App is leaving the session |
| Revit → app | `hello.ack` | Revit version, document info, modelKey, phases |
| Revit → app | `extract.ready` | Path to the snapshot `.bimgo`, element and triangle counts, duration |
| Revit → app | `edit.result` | The existing `BridgeResult` fields (success, message, affected ids, new id, cloneKey) |
| Revit → app | `model.changed` | From `DocumentChanged`: added / modified / deleted counts and ids, so the app can offer "Model changed, refresh?" (incremental refresh later) |
| Revit → app | `session.closing` | Document closing / Revit exiting |

**Mechanics and robustness:**
- **Writing a message:** atomic `.tmp` then rename. Readers retry on sharing violations. A message is deleted (or moved to `processed\` in debug builds) after it's handled. Sequence numbers detect gaps and replays.
- **Watching for messages:** `FileSystemWatcher`, plus a slow polling fallback (every 1 s) because the watcher can miss events.
- **Revit side:**
  - The watcher fires on a thread-pool thread.
  - It enqueues the message and raises the **existing `ExternalEvent`** (the `RevitBridge` pattern stays), posting WM_NULL to Revit's main window to wake its message loop.
  - Results go to `to-app\`.
  - Heartbeat: update `session.json` every ~2 s from a timer. Writes to the file need no API context.
  - On `DocumentClosing` / `ApplicationClosing`, set `state = closed`.
- **Discovery:** the app lists sessions whose heartbeat is newer than ~10 s and whose Revit PID is still alive. Folders older than a day are cleaned up.
- **One session per open document** (keyed by Revit PID plus document). Multiple Revit instances and documents work naturally.
- **Large geometry never travels inside messages.** The add-in writes a `.bimgo` snapshot and sends its path.
- **The Go button in Revit:**
  - It shows the Options dialog (extraction settings stay Revit-side).
  - It creates or reuses the session, extracts a snapshot, then either starts `BimGo.exe --session <id>` or drops an attach request into `App\inbox\` if the app is already running.
  - The app is single-instance via a named mutex.

---

## 5. App design: modes and tool behaviour

**Model source abstraction.** Replace the direct `BridgeChannel` dependency in `GameSession` with one interface that guns submit edits to (the v2 guns already go through `Session.SubmitToRevit`, so the change is contained). For example:

```csharp
internal interface IModelSource
{
    string DisplayName { get; }
    bool IsLive { get; }                                  // HUD badge: LIVE · <doc> / FILE · <name>
    bool Submit(EditRequest request, Action<EditResult> onResult);   // live: protocol; standalone: journal (immediate success)
    void Pump(float dt);                                  // drain results / heartbeat checks on the game thread
}
```

- **LiveSession:** sends protocol messages and gets results asynchronously. It shows "REVIT · n pending" as v2 does, and drops to read-only with a toast if the heartbeat stops.
- **StandaloneDocument:** appends to the journal, succeeds immediately and marks the document dirty, so a `*` appears in the title and the app asks to save on exit.

**Tool behaviour by mode:**

| Tool | Live session | Standalone `.bimgo` |
|---|---|---|
| Scan | Same, plus "select in Revit" (new key, e.g. R) | Same (data from file; parameters if extracted) |
| Measure, Portal, Teleport | Same | Same |
| Comment | Sidecar beside the model, as today (migrate `.rvtgo.json`) | Stored in `comments.json` inside the file |
| Room readout | Same | Same (rooms are in the file) |
| Demolish | Revit: phase demolish / delete (as v2) | Journal `hide` (mode recorded for later push) |
| Gizmo | Revit: move / rotate (as v2) | Journal `transform` |
| Clone | Revit: copy (as v2) | Journal `clone` |
| Refresh | Re-extract from Revit (full, later incremental) | n/a (reload file) |

**App shell (new):**
- A home screen drawn with the existing immediate-mode menu widgets, so it stays a single window with no new dependencies. It offers **Open .bimgo**, **Live sessions** (each with document, Revit version and heartbeat), and **Recent**.
- File dialogs use WinForms `OpenFileDialog` / `SaveFileDialog` (in-box) or comdlg32 P/Invoke.
- Pause menu additions: **Save**, **Save As .bimgo**, **Export comments CSV** (backlog), **Detach / Close model**.
- **Threading inside the exe:** the main thread can now own the game loop, with a background I/O thread for watchers and file reads. The `GameHost` thread wrapper is only needed while the in-Revit mode exists (decision 6.4).
- Settings and logs move to `%AppData%\BimGo` and `%LocalAppData%\BimGo`.

**Add-in after the split:**
- `Cmd_Go` (live): options → extract → session → launch or attach the app.
- `Cmd_ExportBimgo`: options → extract → save dialog → write the `.bimgo`.
- `SessionHost`: watcher, heartbeat, event hooks.
- `RevitBridge`: unchanged logic, plus `select.elements` and later `journal.apply`.
- No GL or game code is left in Revit's process.

---

## 6. Decisions to confirm with Gavin first (with recommendations)

1. **`.bimgo` container:** zip with JSON metadata plus binary geometry (**recommended**), or pure "masked" JSON? Keep a JSON debug dump either way.
2. **Transport:** watched folder (**recommended, as suggested**) with a transport-agnostic message layer. Named pipes are an optional later swap.
3. **App target and deployment:** `net8.0-windows` framework-dependent, or self-contained single-file (about 70 MB, independent of the installed runtime)? Install location: `%LocalAppData%\Programs\BimGo\` shared by the R25/26/27 add-ins (**recommended**), or beside each add-in?
4. **Keep the in-Revit game mode?** Recommendation: keep it only until the live session works (phase 2), then remove it so Revit hosts no GL.
5. **One model per app window or several?** Recommendation: one active model in v1, switchable from the home screen.
6. **Parameters in extracts:** none (as today), a curated set (Mark, Comments, Type Mark, phase info…), or all instance and type parameters as strings behind an Options tick? This affects file size and Scan in standalone mode.
7. **Repo and rename scope:** new solution with the three projects (section 2)? Rename namespaces `RvtGo.*` → `BimGo.*`, the ribbon tab, settings paths and the `.addin`? New AddInId GUID? Rename the repo?
8. **Standalone saves:** journal (**recommended**) vs baked geometry, and whether "Save flattened" is needed in v1.
9. **Sessions and offline editing:** may a live session be saved as `.bimgo` mid-session (it becomes a standalone file with provenance)? Later, should edits made offline be pushable back to a live session of the same model (matched by `ProjectInformation.UniqueId`)? Recommendation: yes to both, with the push in phase 4.

---

## 7. Phased plan

**Phase 0: restructure, behaviour unchanged.**
- Create `BimGo.Core`, `BimGo.App` and `BimGo.Revit`, and move code per the folder map.
- Rename to BimGo.
- Keep the in-Revit launch working temporarily: the add-in references the App assembly, or the engine is a class library at this stage.
- Exit criterion: builds green for R25/26/27, and v2 behaves identically.

**Phase 1: the `.bimgo` format and standalone viewing.**
- `BimGoWriter` / `BimGoReader` in Core.
- An add-in **Export .bimgo** command.
- `BimGo.exe` opens `.bimgo` files: home screen, file dialog, recent list.
- The `StandaloneDocument` source with journal and dirty state; Save / Save As.
- Comments stored inside the file; migrate a legacy sidecar on export.

**Phase 2: live sessions.**
- `SessionHost` in the add-in (session folder, heartbeat, watcher, `ExternalEvent` dispatch).
- `LiveSession` source in the app (discovery, attach, snapshot load, edits through the protocol).
- **Go** launches or attaches the app.
- Port the v2 write-back to the protocol, then remove the in-Revit game.

**Phase 3: session quality of life.**
- `select.elements` ("show in Revit").
- `model.changed`, a refresh prompt and full refresh (incremental later).
- Session status in the ribbon; recovery when the heartbeat drops.

**Phase 4: round-trip.**
- `journal.apply`: push standalone edits into a matching live model by UniqueId, with a report of what applied or failed.
- Optional flattened saves.
- Optional linked models (extract each link as a sub-model inside the `.bimgo`).

---

## 8. Risks and gotchas to keep in mind

- **Snapshot size and speed:** a large model can be hundreds of MB of vertices. Use binary, `NoCompression` for live snapshots, and stream the reads. Show progress on the app's loading frame (`DrawLoadingFrame` already exists).
- **`FileSystemWatcher` reliability:** buffer overflows and missed events happen, so always keep the polling fallback and process messages in `seq` order.
- **Revit busy:** `ExternalEvent`s only run when Revit is idle. Keep the v2 "pending" HUD and re-raise behaviour. Revit modal dialogs block processing.
- **Staleness:** live edits can fail if the model changed meanwhile; v2 already reverts in the game. Journal replay must report per-entry results.
- **Identity:** ElementIds can differ between a local copy and the central model. Always key cross-session data by UniqueId and model identity by `ProjectInformation.UniqueId`.
- **Multiple Revit years:** every add-in build references the same Core, so protocol and format must stay backward-compatible. Version fields are mandatory.
- **Security and hygiene:** only read messages from the session's own folder, validate `sessionId` and protocol version, cap message size, and never execute anything from message content.
- **Conventions still apply:**
  - no NuGet packages without asking;
  - no exceptions surfacing (log + toast);
  - no per-frame allocations;
  - XML docs;
  - keep the README and `BimGo_BuildNotes.md` current;
  - zip the repo minus `bin/`, `obj/` and `.vs/` for handoff.
