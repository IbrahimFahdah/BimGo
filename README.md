# BimGo — First-Person BIM Walkthroughs

BimGo (formerly **RvtGo**) turns a Revit model into an FPS-style, first-person walkthrough with collision, gravity, walkable stairs, a room readout and eight tool guns: **Scan**, **Measure**, **Portal**, **Comment**, **Teleport**, **Demolish**, **Gizmo** and **Clone**. It renders with a small custom OpenGL engine (hand-written P/Invoke, no NuGet packages).

It comes in two parts:

- **BimGo for Revit**, a slim add-in (extractor + session bridge; no engine code). **Go** opens the model in the app as a *live session*: Demolish / Gizmo / Clone edits go back into Revit, Scan → R selects elements in Revit, and changes made in Revit prompt a refresh. **Export .bimgo** writes a standalone extract. **Live** shows the session status.
- **BimGo**, the app (`BimGo.exe`). It joins live Revit sessions, or opens `.bimgo` files with no Revit, keeping edits in the file's journal (with undo) and saving them again. A file's edits can later be **pushed into the Revit model** they came from (dry-run preview, one undo step in Revit).

Demolition works between two phases picked in the Options dialog: the walkthrough shows the model as it stands in the **new** phase, the hammer demolishes **existing** elements in the new phase, new work can only be deleted, and clones are created in the new phase.

The v3 design brief is `ai/261005_V3/1_BimGo v3_Handoff.md`. Decisions and the changelog are in `ai/261005_V3/2_build notes v3.md` (phase 0 + 1) and `ai/261005_V3/3_build notes v3 phase 2.md`. Phase 4 (push), the existing/new phases and the v4 QoL items are in `ai/261007_V5/1_build notes v5.md`.

## For AI assistants (e.g. Claude)

1. **Read the handoff and build notes first.** This README documents what is built and where it deviates.
2. **Keep this README current**, especially the Changelog and *Known limitations / to verify*.
3. **No dependencies.** The no-NuGet rule is a design goal: GL, WGL, Win32, Raw Input and waveOut are all hand-written P/Invoke. `UseWindowsForms` / `UseWPF` only pull in-box framework parts. Ask before adding any package.
4. **Project boundaries:**
   - **BimGo.Core** has no Revit, GL or UI code.
   - **BimGo.App** never references the Revit API.
   - **BimGo.Revit** is the only project that touches the Revit API, and it holds no engine code. API calls happen in `Commands/`, `Extraction/`, `Bridge/RevitEditor*.cs` (`RevitEditor.cs` live edits, `RevitEditor.Push.cs` journal push) and `Live/LiveDispatcher.cs` (on the Revit thread). `Live/SessionHost.cs` timers and watchers do file IO only.
5. **Edits go through `IModelSource`.** Guns call `GameSession.SubmitEdit`. The source is a live Revit session (`LiveSessionSource`) or the file (`FileEditSource`). Every accepted edit is recorded in the `EditJournal`.
6. **Template conventions still apply** in BimGo.Revit:
   - Commands live in `Commands/Cmds_<Group>.cs` as `Cmd_<Button>`.
   - Extensions live in `Extensions/TypeName_Ext.cs`.
   - Tooltips and icons resolve from the command's base name (`BimGo_Launch`, `BimGo_Export`).
7. **Name clashes:** WPF, WinForms and Revit's `DB`/`UI` namespaces are global usings in BimGo.Revit, and WinForms + System.Drawing are global in BimGo.App. Avoid unqualified `Color`, `Point`, `Plane`, `View`, `Panel`, `CheckBox`, `TextBox`, `TaskDialog`… (use the `DB.`, `UI.`, `SD.`, `Wpf.`, `Win.` and `WinForms` aliases).
8. **Zip handoff:** zip the repo minus `bin/`, `obj/` and `.vs/`.

## 1. Overview

| Item | Decision |
|---|---|
| Solution | `src/BimGo.sln`: **BimGo.Core** (net8.0), **BimGo.App** (net8.0-windows, `BimGo.exe`), **BimGo.Revit** (Revit 2025/2026 on net8.0-windows, 2027 on net10.0-windows) |
| Renderer | OpenGL 4.1 core (falls back to 3.3), GLSL 330, Win32 window |
| File format | `.bimgo`: a ZIP holding JSON metadata, binary geometry, comments and an edit journal (see §6) |
| Revit link | **Live sessions** over a watched folder per document (`%LocalAppData%\BimGo\Sessions\<id>\`): JSON message files both ways, heartbeats, `.bimgo` snapshots for geometry. One `ExternalEvent` runs all Revit-side work. |
| Comments | Revit: sidecar `<model>.bimgo-comments.json` beside the model (a legacy `.rvtgo.json` is migrated). Files: inside the `.bimgo`. |
| Settings / logs | `%AppData%\BimGo\settings.json` (migrated once from RvtGo) · `%LocalAppData%\BimGo\Logs\BimGo.Revit.log` / `BimGo.App.log` |
| App install | The App build copies itself to `%LocalAppData%\Programs\BimGo\`, where every Revit year's add-in looks for `BimGo.exe`. That copy registers `.bimgo` (HKCU, ">>" icon) and a Start-menu shortcut on start; `BimGo.exe --register` / `--unregister` [`--quiet`] do it on demand |
| Phases | **Existing** and **new** phase picked in Options (saved by name). The walkthrough shows the new phase; demolish = Phase Demolished → new phase, existing elements only; clones are created in the new phase |

## 2. Getting started

1. Open `src/BimGo.sln` in Visual Studio 2022 (.NET desktop workload).
2. Pick a configuration (`Debug R25`, `Debug R26`, `Debug R27`, or Release). Core and App build as Debug/Release under each.
3. Build the solution (the app must be built too: Go launches it). The add-in deploys to `%AppData%\Autodesk\Revit\Addins\<year>\BimGo\` (with `BimGo.addin`). The app installs to `%LocalAppData%\Programs\BimGo\`.
4. **Remove the old `RvtGo.addin`** from the Addins folder. It has a different AddInId, so both tabs would load.
5. In Revit, press **BimGo → Go** for a live walkthrough (the app starts, or the running app asks to switch), or **Export .bimgo**, then open the file in BimGo.
6. To debug the app, set **BimGo.App** as the startup project and pass a `.bimgo` path, or `--session <id>` (the id is the folder name under `%LocalAppData%\BimGo\Sessions`). Running sessions also appear on the home screen.

## 3. Controls

| Input | Action |
|---|---|
| WASD / arrows | Move |
| Mouse | Look (click the window first to capture the mouse) |
| Space | Jump (ascend in fly mode) |
| Shift | Run |
| Ctrl | Crouch (descend in fly mode) |
| V | Toggle fly / no-clip |
| 1–8, mouse wheel | Select gun |
| LMB / RMB | Gun primary / secondary |
| N | Measure gun: toggle normal projection |
| T | Demolish gun: toggle phase demolish (default; existing elements only) / delete |
| **E** | Comment gun: edit the hovered comment |
| WASD · Q / E | Gizmo / Clone while locked on: move (view-relative) · rotate CCW / CW (player frozen) |
| Shift · Ctrl | Gizmo / Clone while locked on: fine control · invert snap mode while held |
| RMB · Esc | Gizmo / Clone while locked on: commit · cancel |
| **G** | Gizmo / Clone: toggle snap mode (moves / turns step by the increment; Ctrl held inverts) |
| **Z / X · C / V** | Gizmo / Clone while locked on: move increment down / up (5 mm … 1 m) · angle increment down / up (1° … 90°) |
| **R** | Scan gun, live session: select and show the target in Revit |
| **F5** | Live session: ask Revit for a fresh snapshot (reloads where you stand) |
| Page Up / Page Down | Teleport up / down one level |
| Tab | Toggle minimap |
| H / Shift+H | Return home / set home |
| X | Clear current gun's markers (Comment gun: press twice to delete all comments) |
| **Ctrl+S / Ctrl+Shift+S** | Save / Save as (file). In Revit: save the walkthrough as a new `.bimgo` |
| **Ctrl+Z** | Undo the last edit (files only; in a live session, undo in Revit, then F5) |
| F1 | Toggle controls help |
| F11 | Borderless fullscreen |
| Esc | Pause menu (save, push to Revit, comments list, category toggles, display settings…); cancels the gizmo when locked on; closes the push / comments panel |

App home screen: running **Live Revit sessions** (click to join), **Open .bimgo…** (Ctrl+O), recent files (right-click removes one), or drop a file on the window. During a walkthrough, dropped / double-clicked files wait until you close the model; a Go from Revit for another model asks before switching.

Pause menu extras:
- **PUSH TO REVIT (n)…** (files): pushes the edits not yet in Revit into the live session of the model the file came from (open it in Revit and press Go; answer No to the switch prompt). A dry run previews every edit (will apply / conflict / skipped / will fail / already in Revit); conflicts (moved in Revit since the file was made, > 5 mm) are skipped unless "apply anyway" is ticked. The real push is one undo step in Revit; pushed entries are marked in the file (Save keeps that) and are never sent again. EXPORT REPORT… writes a CSV.
- **COMMENTS (n)**: every comment, filtered by level (← →), with GO (stand in front of it), EDIT, DELETE (click twice) and EXPORT CSV….

### Guns

| # | Gun | LMB | RMB | In Revit | In a .bimgo file |
|---|---|---|---|---|---|
| 1 | Scan | Lock target | Clear | Info panel + extra parameters; R selects in Revit | Same (no R) |
| 2 | Measure | Start / end point | Remove last | | Same |
| 3 | Portal | Blue portal | Red portal | | Same |
| 4 | Comment | Place + type (E edits) | Remove marker | Sidecar beside the model | Saved in the file |
| 5 | Teleport | Blink to marker | Step back | | Same |
| 6 | Demolish | Prime / demolish primed | Un-prime | Demolish in the new phase (existing elements only; T = delete) in Revit | Journal `hide`; hosted inserts go too |
| 7 | Gizmo | Lock on (FFE) | Commit | Moves the element in Revit (G snap, Z/X C/V increments) | Journal `transform` |
| 8 | Clone | Clone in place (FFE) | Commit | Copies the element in Revit (same snap keys) | Journal `clone` |

## 4. Project structure

```
src/
├── BimGo.sln
├── BimGo.Core/                    # net8.0: no Revit, no GL, no UI
│   ├── Scene/                     #   SceneData, CategoryCatalog, LaunchSettings, ModelInfo (provenance, site, ParameterTable)
│   ├── Edits/                     #   EditRequest/EditResult/EditChannel, EditJournal + JournalEntry
│   ├── Sources/                   #   IModelSource, FileEditSource
│   ├── Live/                      #   protocol (session.json, envelopes, message types), FolderChannel, LiveSessions, LiveSessionSource + ILiveLink, JournalPush (temporary push channel)
│   ├── Format/                    #   .bimgo: BimGoFormat, BimGoReader/Writer, DTOs, BimGoDocument, comment sidecars
│   └── Utilities/Log_Utils.cs
├── BimGo.App/                     # BimGo.exe and the engine (no Revit)
│   ├── Program.cs                 #   entry point, single instance, DPI awareness, --register / --unregister
│   ├── Shell/                     #   AppShell (home ↔ walkthrough loop, switch / reload), HomeScreen, OpenTarget, RecentFiles, AppInstance (mutex + inbox), FileAssociation
│   ├── Game/                      #   GameSession (+Render, +Menu, +Edits, +Document, +Live, +Push, +Comments), SessionOptions, guns
│   ├── Rendering/ Physics/ Platform/ Native/ Audio/
└── BimGo.Revit/                   # the add-in (template configs R25–R27)
    ├── Application.cs             #   ribbon: BimGo tab → Walkthrough → Go, Export .bimgo, Live (status)
    ├── Commands/Cmds_BimGo.cs     #   Cmd_Launch (Go → live session + app), Cmd_Export (.bimgo), Cmd_Status
    ├── Extraction/                #   SceneExtractor, CategoryResolver, ParameterScanner, PhaseResolver (existing / new phases, element roles)
    ├── Live/                      #   SessionHost (folder, heartbeat, snapshots), LiveDispatcher (ExternalEvent, registry, doc events, ribbon status)
    ├── Bridge/RevitEditor.cs      #   applies edits: transactions, failure swallowing, clone key map, phases
    ├── Bridge/RevitEditor.Push.cs #   journal.apply: one TransactionGroup, dry run, staleness check, push-local clone map
    ├── Forms/OptionsWindow        #   WPF options (categories, phases, extra parameters, display, gizmo snap)
    └── Extensions/ General/ Utilities/ Resources/   # template (+ App_Utils: find / start BimGo.exe)
```

## 5. How it works

- **Phases.** `PhaseResolver` resolves the **existing** and **new** phases from the saved names (Options), else new = the launch view's phase (else the last) and existing = the phase before it. Each element gets a role: *existing* (there in the existing phase, still standing in the new one: demolishable), *new* (created in the new phase), *between* (built in between) or *unphased*. Demolition sets Phase Demolished to the new phase and is refused for anything but existing elements (the hammer says so before sending; Revit checks again). Copies get Phase Created = new phase.
- **Extraction (Revit thread).** For each ticked category, elements are filtered (no view-specific elements or secondary design options, and only what stands in the new phase: nothing demolished by it or built after it). They are tessellated, coloured from their materials and converted to metres around a scene origin (the median element centre, rounded). Each element also records:
  - its ElementId, **UniqueId** and **host id**;
  - its movability and pivot;
  - the **extra parameters** picked in Options (instance value, else the type's).

  The extraction also captures:
  - **Provenance:** title, path, `ProjectInformation.UniqueId` as the model key, cloud GUIDs, Revit version, user and time.
  - **Site:** true north, project base point and survey point.
- **Sessions.** One `GameSession` runs both modes. Only the `IModelSource` differs:
  - Live: edits are `edit` messages to Revit; `LiveDispatcher` applies them with `RevitEditor` (one transaction each) and answers `edit.result`. They are optimistic: the walkthrough changes at once and is reverted if Revit refuses or contact is lost.
  - In a file, `FileEditSource` accepts every edit at once. For removals it adds the hosted elements.
- **Live sessions.** Go extracts, writes an uncompressed snapshot `.bimgo` into the session folder, records it in `session.json`, announces `extract.ready` and runs `BimGo.exe --session <id>` (a running app gets an inbox request instead).
  - The app attaches (purges stale messages, writes `app.json`, says `hello`), reads the snapshot, and walks it. The snapshot carries the comment sidecar path, so comments keep living beside the model.
  - Revit's heartbeat (2 s) keeps `session.json` fresh and flushes counted `model.changed` events (anything except BimGo's own committed `BimGo: …` transactions). The app shows **MODEL CHANGED · F5**; F5 sends `extract.request`, Revit re-extracts, and the app reloads the new snapshot where the player stands (pose carried in Revit coordinates). Pressing Go again does the same.
  - Scan → R sends `select.elements`; Revit selects, shows and comes to the front (if that model is the active one).
  - Closing the document / Revit sends `session.closing`; the app goes read-only (save as `.bimgo` still works). A stale heartbeat (> 10 s) pauses edits until it recovers.
- **The journal.** Accepted edits are appended to the `EditJournal` in both modes. Targets are stored by UniqueId (with the ElementId as a fallback), or by clone key for clones made in a walkthrough. Each entry also stores the request's pivot, offset, angle and label, and `appliedToRevit` if the edit already reached Revit.
  - Opening a file **replays** the journal on the untouched geometry, reusing the v2 hide and dynamic-instance machinery.
  - **Undo** removes the last entry, resets all edits and replays the rest.
  - **Saving** writes the snapshot, the comments and the journal.
- **Push (`journal.apply`).** The app finds a live session whose `modelKey` equals the file's, opens a temporary `FolderChannel` on it (no `app.json`, no hello) and sends the entries not yet in Revit, plus the clones already there (`knownClones`). `LiveDispatcher` hands them to `RevitEditor.ApplyJournal`: one `TransactionGroup` ("BimGo: Push N edits from file.bimgo"), each entry in its own transaction; targets by UniqueId (clones by a push-local key map); moves and clones compare the element's location point with the entry's pivot (5 mm); hides honour the recorded mode (delete, or demolish in the file's new phase, matched by name). Dry run → roll back the group; real push → assimilate (one undo). Requests over 3 MB travel as `snapshots/push-<id>.json`. The app times out after 30 s + 0.25 s per entry ("update the add-in / Revit busy").
- **The app.** One window runs a single-threaded loop that alternates between the home screen and walkthroughs. A second launch, or Revit's Go / "Open in BimGo", drops a request in `%LocalAppData%\BimGo\App\inbox\` (`{ "open": path }` or `{ "attach": sessionId }`) and brings the window forward.
- **Engine** (unchanged from v2):
  - Batched and frustum-culled `glMultiDrawElements`.
  - An off-screen MSAA target.
  - Fixed 120 Hz physics.
  - A static BVH shared by picking and collision.
  - Degenerate-index hiding.
  - `DynamicInstance`s for moved and cloned elements.

## 6. The `.bimgo` format (version 1)

A ZIP container with the extension masked:

| Entry | Content |
|---|---|
| `manifest.json` | `format`, `formatVersion`, generator, kind (`revit-export` / `session-save` / `save` / `live-snapshot`, which also records the comment sidecar path), title, created/saved UTC, units, **provenance**, extraction options, counts |
| `model.json` | origin offset, bounds, site, new phase (`phaseId`/`phaseName`), existing phase (`existingPhaseId`/`existingPhaseName`, optional), `phaseNote` (optional), spawn, levels, rooms (flattened loops), categories (by catalog key) |
| `elements.json` | per element: id, uniqueId, name, category index, family/type, level, hostId, proxy, movable/reason, pivot, `phase` (optional: `new` / `between` / `unphased`; absent = existing), bounds, `[start,count]` index ranges |
| `parameters.json` | optional: pooled `names`, pooled `values`, per-element `rows` of name/value index pairs |
| `geometry.bin` | header (`BGEO`, version, vertex size 28, counts), then `SceneVertex[]` and `uint[]` indices, little-endian |
| `comments.json` | comment markers (Revit internal metres; optional `edited` / `editedBy`) |
| `journal.json` | ordered edit entries |

Readers load this version and older ones, and refuse newer ones with a message. Writes are atomic: a `.tmp` file, then a replace. JSON entries are readable (camelCase). The large entries are compact.

## 7. The live session protocol (version 1)

| Direction | Type | Payload |
|---|---|---|
| app → Revit | `hello` | app pid, version |
| Revit → app | `hello.ack` | document title, Revit version, new phase, existing phase |
| app → Revit | `edit` | `EditRequest` (ticket, op, ElementId or clone key, pivot, translation, angle, label) |
| Revit → app | `edit.result` | `EditResult` (ticket, success, message, affected ids, new id, clone key) |
| app → Revit | `extract.request` | reason |
| Revit → app | `extract.ready` / `extract.failed` | snapshot path, number, counts, seconds, reason (`go` / `refresh`) / message |
| app → Revit | `select.elements` | ElementIds |
| Revit → app | `select.result` | success, message |
| Revit → app | `model.changed` | added / modified / deleted counts since the last flush |
| Revit → app | `session.closing` | reason |
| app → Revit | `detach` | none |
| app → Revit | `journal.apply` | `JournalApplyPayload`: requestId, dryRun, toleranceMm (5), applyConflicts, modelKey, phaseName, existingPhaseName, fileName, knownClones, entries (or `payloadPath` for big requests) |
| Revit → app | `journal.result` | `JournalResultPayload`: requestId, dryRun, success, message, phases used, undoLabel, results (seq, status `applied` / `skipped` / `conflict` / `failed` / `alreadyApplied`, message, newElementId, affected), totals |

Additive to protocol 1: an older add-in ignores `journal.apply` and the app times out with a hint to update it. `session.json` also carries `existingPhaseName`.

Envelope: `protocol`, `id`, `seq`, `sessionId`, `type`, `replyTo`, `sentUtc`, `payload`. Files are named `<utc>-<seq>-<type>.json` so name order is send order; written as `.tmp` then renamed; read by a `FileSystemWatcher` plus a 1 s poll; validated (session id, protocol, 4 MB cap), de-duplicated by id and deleted.

## 8. Known limitations / to verify

- **v5 not compiled yet** (written without a .NET SDK or the Revit API assemblies; phase 2 has since been built and fixed). Check `PhaseResolver` (`Element.GetPhaseStatus`, `ElementOnPhaseStatus` names), `RevitEditor.Push.cs` (`TransactionGroup.Assimilate`), `DBEvents.UndoOperation.TransactionGroupRolledBack`, the COM `IShellLinkW` interop in `FileAssociation` and the new XAML rows in `OptionsWindow`.
- Show in Revit works when the session's model is Revit's active document (otherwise the app is told to switch).
- One app window walks one model; other sessions wait on the home screen.
- Revit API calls to verify on 2025–2027:
  - `Mesh.DistributionOfNormals` / `GetNormal`, `Element.DemolishedPhaseId`, `Document.IsModelInCloud`, `Level.ProjectElevation`;
  - `WorksharingUtils.GetCheckoutStatus`, `Element.GetDependentElements`;
  - new in v3: `Document.GetCloudModelPath`, `BasePoint.GetProjectBasePoint/GetSurveyPoint`, `ProjectLocation.GetProjectPosition`.
- Standalone demolish removes hosted elements with their host (from `HostId`). Revit's own rules for face-hosted families may differ.
- Undo is file-only and has no redo. In a live session, undo in Revit, then F5 (undoing BimGo's own edits counts as a model change). In a file, undo stops at edits already in Revit (pushed or made live).
- Refresh is a full re-extract (incremental refresh later).
- Push: the staleness check needs a location point (only point-based families are movable, so moves and clones always have one). A hide whose element is gone counts as already applied for deletes and skipped for demolitions. Clones have no duplicate guard beyond the journal flag: if the app loses the answer to a real push (timeout), check Revit before pushing again.
- Phases are saved by name in the shared settings; a model without those names falls back to the defaults (and the walkthrough says so once). Clones made before v5 kept their source's phase.
- Saving from a Revit session leaves out edits still waiting for Revit (a toast says so).
- Stairs, railings, roof edges, linked models and orthographic spawn behave as in v2 (see the build notes).
- More than 9 guns will need a rethink of the number keys.

## 9. Changelog

### 2026-10-07: v5: push to Revit, existing / new phases, file association, comments QoL, snap defaults

- **Phase 4, `journal.apply`:** pause menu → PUSH TO REVIT (files). Matching live session by model key, temporary channel, dry-run preview with per-edit status, conflicts skipped by default (5 mm, "apply anyway" re-checks), one Revit undo step (`TransactionGroup.Assimilate`), report panel + CSV, pushed entries marked in the journal. Large requests by file. The switch prompt mentions pushing when the arriving model is the file's.
- **Existing / new phases** (Options → PHASES): the walkthrough shows the new phase (elements built later or demolished by it are left out); demolish = new phase, existing elements only (hammer explains and suggests T for others; Revit enforces); clones created in the new phase; Scan shows each element's phase role; home screen shows "Existing → New". Stored in `.bimgo` (`model.existingPhase*`, `elements[].phase`), `session.json` and `hello.ack`.
- **File association / --register:** HKCU `.bimgo` → `BimGo.Model` (icon from the exe), "Open with" entry, Start-menu shortcut; the installed copy self-registers on start (unless `--unregister` opted out).
- **Comments QoL:** E edits the hovered comment (edited / editedBy recorded); pause menu COMMENTS list with level filter, GO (teleport in front), EDIT, DELETE, EXPORT CSV.
- **Gizmo snap defaults** in the Options dialog (checkbox + move / angle increments).
- Undo in files no longer removes edits that are already in Revit.

### 2026-10-06: App icon, build fixes, v4 handoff

- **">>" icon** everywhere the apps show one: `BimGo.exe` (`ApplicationIcon`, `BimGo.App/Resources/BimGo.ico`), the game window's title bar and taskbar, the Revit **Go** button and the Options dialog, and the home-screen title mark.
- Build fixes: `DBEvents.UndoOperation` in `LiveDispatcher`; the sessions panel in `HomeScreen` is always drawn (a `??=` short-circuit left `used` unassigned).
- Remaining work handed over in `ai/261006_V4/0_BimGo v4_Handoff.md` (Phase 4 `journal.apply` first).

### 2026-10-06: v3 phase 2 (+ phase 3 QoL): live sessions

- **Live sessions replace the in-Revit game.** Go → snapshot in the document's session folder → BimGo.exe joins (or the running app asks to switch). The add-in no longer references the engine.
- Core `Live/`: protocol, `FolderChannel` (atomic files, watcher + poll, de-dupe), `LiveSessions` (discovery, cleanup), `LiveSessionSource` (edits, heartbeats, notices, refresh, select).
- Revit `Live/`: `SessionHost` (session.json heartbeat, app attachment, snapshots, change counting), `LiveDispatcher` (one ExternalEvent for all sessions, doc closing / changed events, ribbon status). `RevitBridge` became `RevitEditor`.
- App: home screen lists running sessions; `--session <id>`; inbox `attach` requests; switch prompt; reload on new snapshots keeping the player's pose; LIVE / OFFLINE badge; model-changed banner + F5 refresh; Scan → R shows in Revit.
- Ribbon **Live** button (text shows off / ready / attached): bring the app forward, send a fresh snapshot, end the session.
- **Gizmo snap increments:** G toggles snap mode (persisted), Ctrl inverts while held, Z/X and C/V step the move (5 mm–1 m) and angle (1°–90°) increments; snapped moves step per key press along the nearest world axis.

### 2026-10-05: v3 phase 0 + 1: BimGo (restructure, .bimgo, standalone app)

- **Rename and split:**
  - RvtGo → BimGo in three projects: Core, App (`BimGo.exe`) and Revit.
  - New AddInId; BimGo ribbon tab with **Go** and **Export .bimgo**.
  - Settings and logs move to `BimGo` folders, and the RvtGo settings and comment sidecar migrate automatically.
- **.bimgo format:** a ZIP of JSON and binary geometry, with versioning, validation and atomic writes.
- **Export .bimgo:**
  - Options, then a save location, then extraction.
  - Comments are embedded in the file.
  - Offers to open the file in BimGo.
- **Extra parameters:** a picker in Options (Scan model, filter, up to 24) feeds the Scan gun. Values go into a pooled string table.
- **Extraction:** UniqueId, host id, provenance (model key, cloud ids), true north, base and survey points.
- **Standalone app:**
  - Home screen, Open, recent files and drag-and-drop.
  - Single instance with an open-request inbox.
  - Close model returns to Home; unsaved changes prompt before closing.
- **Edits:**
  - `IModelSource` replaces the direct bridge, and the `EditJournal` records every accepted edit.
  - Journal replay on load; Ctrl+Z undo (files); Ctrl+S / Ctrl+Shift+S save.
  - Save as `.bimgo` from a Revit session.
  - HUD badge shows REVIT or FILE (`*` when unsaved).

### 2026-10-04: QoL: room readout, symbol gun bar, four new guns, Revit write-back

- Room readout, symbol gun bar, Teleport / Demolish / Gizmo / Clone guns, and the `Bridge/` write-back via an `ExternalEvent`.
- Engine: degenerate-index hiding, dynamic instances, dynamic picking and collision, multi-highlight, and input capture for guns.

### 2026-10-01: Doors simplified, global usings

- Door open/close system removed: doors render as modelled and are always no-clip.

### 2026-10-01: v1 (first full pass)

- Template fork, WPF options, extraction, engine (GL, batching, MSAA, sky, minimap, HUD, pause menu), physics, and the Scan / Measure / Portal / Comment guns.
