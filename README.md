# BimGo — First-Person BIM Walkthroughs

BimGo (formerly **RvtGo**) turns a Revit model into an FPS-style, first-person walkthrough with collision, gravity, walkable stairs, a room readout and eight tool guns: **Scan**, **Measure**, **Portal**, **Comment**, **Teleport**, **Demolish**, **Gizmo** and **Clone**. It renders with a small custom OpenGL engine (own renderer, window and input; GL function bindings from Silk.NET, see §10).

It comes in two parts:

- **BimGo for Revit**, a slim add-in (extractor + session bridge; no engine code). **Go** opens the model in the app as a *live session*: Demolish / Gizmo / Clone edits go back into Revit, Scan → R selects elements in Revit, and changes made in Revit prompt a refresh. **Export .bimgo** writes a standalone extract. **Live** shows the session status.
- **BimGo**, the app (`BimGo.exe`). It joins live Revit sessions, or opens `.bimgo` files with no Revit, keeping edits in the file's journal (with undo) and saving them again. A file's edits can later be **pushed into the Revit model** they came from (dry-run preview, one undo step in Revit).

Demolition works between two phases picked in the Options dialog: the walkthrough shows the model as it stands in the **new** phase, the hammer demolishes **existing** elements in the new phase, new work can only be deleted, and clones are created in the new phase.

The v3 design brief is `ai/261005_V3/1_BimGo v3_Handoff.md`. Decisions and the changelog are in `ai/261005_V3/2_build notes v3.md` (phase 0 + 1) and `ai/261005_V3/3_build notes v3 phase 2.md`. Phase 4 (push), the existing/new phases and the v4 QoL items are in `ai/261007_V5/1_build notes v5.md`.

## For AI assistants (e.g. Claude)

1. **Read the handoff and build notes first.** This README documents what is built and where it deviates.
2. **Keep this README current**, especially the Changelog and *Known limitations / to verify*.
3. **Dependencies: own what differentiates BimGo, rent the commodity plumbing.**
   - Own: renderer architecture, shadows, picking, physics, the gun / tool system, the UI look, the `.bimgo` format, the journal, the Revit bridge and live protocol. The window / input stack (`Platform/GameWindow.cs`, `Native/Win32.cs`, `Platform/InputState.cs`, `Native/Wgl.cs`), waveOut audio and the font atlas also stay hand-written until they cause real pain.
   - Rent: OpenGL function bindings (Silk.NET.OpenGL behind the `Native/Gl.cs` facade: renderer code calls `Gl.Xxx` with `uint` constants; add new GL calls as facade wrappers, not new P/Invoke).
   - **BimGo.Revit stays dependency-free at run time** (it loads inside Revit beside other add-ins). Packages go in BimGo.App, in dev / build tooling, or nowhere. Revit API references stay HintPaths to the installed Revit.
   - Every package needs Gavin's explicit yes, a permissive licence (MIT / Apache / BSD / zlib), a pinned version and a line in the dependency table (§10). No UI toolkits (they would change the look). Ask before adding folders.
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
8. **Zip handoff:** zip the repo minus `bin/`, `obj/`, `.vs/` and `artifacts/`.
9. **Tests:** `tests/BimGo.Core.Tests` (MSTest) covers BimGo.Core. Run it after Core changes (Test Explorer or `dotnet test`).

## 1. Overview

| Item | Decision |
|---|---|
| Solution | `src/BimGo.sln`: **BimGo.Core** (net8.0), **BimGo.App** (net8.0-windows, `BimGo.exe`), **BimGo.Revit** (Revit 2025/2026 on net8.0-windows, 2027 on net10.0-windows) |
| Renderer | OpenGL 4.1 core (falls back to 3.3), GLSL 330, Win32 window |
| File format | `.bimgo`: a ZIP holding JSON metadata, binary geometry, comments and an edit journal (see §6) |
| Revit link | **Live sessions** over a watched folder per document (`%LocalAppData%\BimGo\Sessions\<id>\`): JSON message files both ways, heartbeats, `.bimgo` snapshots for geometry. One `ExternalEvent` runs all Revit-side work. |
| Comments | Revit: sidecar `<model>.bimgo-comments.json` beside the model (a legacy `.rvtgo.json` is migrated). Files: inside the `.bimgo`. |
| Bookmarks | Revit: sidecar `<model>.bimgo-bookmarks.json` next to the comments sidecar. Files: inside the `.bimgo` (`bookmarks.json`). |
| Sun & shadows | Off by default. Cascaded shadow maps with glass transmittance; sun from the Revit site location (captured at export) and a date / time the user scrubs. State saved with the model (`sun.json` / `<model>.bimgo-sun.json`); quality is per machine |
| Settings / logs | `%AppData%\BimGo\settings.json` (migrated once from RvtGo) · `%LocalAppData%\BimGo\Logs\BimGo.Revit.log` / `BimGo.App.log` |
| App install | The App build copies itself to `%LocalAppData%\Programs\BimGo\`, where every Revit year's add-in looks for `BimGo.exe`. That copy registers `.bimgo` (HKCU, ">>" icon) and a Start-menu shortcut on start; `BimGo.exe --register` / `--unregister` [`--quiet`] do it on demand |
| Phases | **Existing** and **new** phase picked in Options (saved by name). The walkthrough shows the new phase; demolish = Phase Demolished → new phase, existing elements only; clones are created in the new phase |
| Version | **1.0.0** (all three assemblies; shown on the home screen, F1 help, the Options title and in the logs) |
| Active view only | Options → WHAT TO LOAD: **off by default**. When ticked, every model element the active view shows comes in (its V/G, filters, section box, hidden elements, design options and phase filter decide; category ticks, phases and design-option rules don't); ticked links contribute what the view shows of them (Revit 2024+ view + link collector). A 3D view's subcategory visibility and detail level apply to host geometry. Unlisted categories land in **Other (active view)**. F5 reuses the active view, else the last one used for that model |
| Helper geometry | Options → GEOMETRY: **on by default**. Leaves out the Light Source subcategory (IES / photometric cones) and any *subcategory* whose name contains a keyword (default: light source, clearance, zone, cone, photometric; editable) |
| Ground plane | 100 mm below the lowest level by default (clear of slab faces on that level); the pause menu slider still moves it |
| Linked models | **None by default.** Options → LINKED MODELS lists every Revit link instance; ticked (loaded) instances are extracted with the host's categories, baked into scene coordinates with the instance's total transform, in the link phase named like the host's (else the link's last). The choice is remembered per host model (`LinkedModels` in settings) and reused by F5. Linked elements are **read-only** (Scan / Measure / Comment / Teleport / Portal only) and can be shown / hidden per link in the pause menu |

## 2. Getting started

1. Open `src/BimGo.sln` in Visual Studio 2022 (.NET desktop workload).
2. Pick a configuration (`Debug R25`, `Debug R26`, `Debug R27`, or Release). Core and App build as Debug/Release under each.
3. Build the solution (the app must be built too: Go launches it). The add-in deploys to `%AppData%\Autodesk\Revit\Addins\<year>\BimGo\` (with `BimGo.addin`). The app installs to `%LocalAppData%\Programs\BimGo\`.
   The first build restores the NuGet packages (§10), so it needs internet access once.
4. **Tests:** Test → Test Explorer → Run All (or `dotnet test tests/BimGo.Core.Tests`). They use temp folders only and log to `%LocalAppData%\BimGo\Logs\BimGo.Tests.log`.
5. **Remove the old `RvtGo.addin`** from the Addins folder. It has a different AddInId, so both tabs would load.
6. In Revit, press **BimGo → Go** for a live walkthrough (the app starts, or the running app asks to switch), or **Export .bimgo**, then open the file in BimGo.
7. To debug the app, set **BimGo.App** as the startup project and pass a `.bimgo` path, or `--session <id>` (the id is the folder name under `%LocalAppData%\BimGo\Sessions`). Running sessions also appear on the home screen.

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
| **R** | Scan gun, live session: select and show the target in Revit (a linked element is selected inside its link) |
| **F5** | Live session: ask Revit for a fresh snapshot (reloads where you stand) |
| Page Up / Page Down | Teleport up / down one level |
| Tab | Toggle minimap |
| H / Shift+H | Return home / set home (saved with the model: walkthroughs start there) |
| X | Clear current gun's markers (Comment gun: press twice to delete all comments) |
| **Ctrl+S / Ctrl+Shift+S** | Save / Save as (file). In Revit: save the walkthrough as a new `.bimgo` |
| **Ctrl+Z** | Undo the last edit (files only; in a live session, undo in Revit, then F5) |
| **Ctrl+Y / Ctrl+Shift+Z** | Redo the last undone edit (files only; a new edit ends the redo history) |
| **B** | Bookmark this viewpoint (type a name, Enter; Esc keeps "View n") |
| **Ctrl+1–9** | Jump to bookmark 1–9 |
| **L** | Coordinate readout: off → shared → project → internal (crosshair point, or your feet when aiming at nothing) |
| **O** | Shadows on / off (sun lighting; off restores the classic light and frees the shadow maps) |
| **Shift+O** · click the sun icon | Open the sun panel (bottom right; frees the cursor, the player stands still, the scene keeps rendering). Esc / O close it |
| **[ / ]** | Sun time −/+ 5 min (Shift: 1 min) while shadows are on; a short note shows the date, time and sun position at each step. Space plays / pauses the day in the sun panel |
| **I · Shift+I** | Scan gun: hide the target in the walkthrough only · isolate its category (again: restore). Pause menu SHOW ALL brings everything back |
| F1 | Toggle controls help (shows the version) |
| F11 | Borderless fullscreen |
| **F12** | Screenshot of the 3D view (no HUD) to `Pictures\BimGo\<model> <date time>.png` |
| Esc | Pause menu (save, push to Revit, comments list, category toggles, display settings…); cancels the gizmo when locked on; closes the push / comments panel |

App home screen: running **Live Revit sessions** (click to join), **Open .bimgo…** (Ctrl+O), recent files (right-click removes one), or drop a file on the window. During a walkthrough, dropped / double-clicked files wait until you close the model; a Go from Revit for another model asks before switching.

Pause menu extras:
- **SHOW ALL (n HIDDEN)** (when anything is hidden): elements hidden with I, categories and links switched off, and a Shift+I isolation all come back. Hidden things are saved with the model (`visibility.json`, or the `<model>.bimgo-visibility.json` sidecar in live sessions) and count as unsaved changes in files.
- **PUSH TO REVIT (n)…** (files): pushes the edits not yet in Revit into the live session of the model the file came from (open it in Revit and press Go; answer No to the switch prompt). A dry run previews every edit (will apply / conflict / skipped / will fail / already in Revit); conflicts (moved in Revit since the file was made, > 5 mm) are skipped unless "apply anyway" is ticked. The real push is one undo step in Revit; pushed entries are marked in the file (Save keeps that) and are never sent again. EXPORT REPORT… writes a CSV.
- **COMMENTS (n)**: every comment, filtered by level (← →), with GO (stand in front of it), EDIT, DELETE (click twice) and EXPORT CSV….
- **LINKED MODELS** (under the category cards, when the model has links): one toggle per extracted link instance (drawing, picking, collision, shadows) with its element count.
- **BOOKMARKS (n)**: saved viewpoints in Ctrl+number order, with GO, RENAME, SET HERE (move it to where you are), ↑ ↓ (reorder), DELETE (click twice) and ADD THIS VIEW. Shown as blue dots on the minimap.

Sun panel (Shift+O): **Shadows** on/off and **quality** (Low 1 × 2048 px / 60 m, Medium 3 × 2048 px / 120 m, High 4 × 3072 px / 200 m; per machine), **time of day** slider (5-minute steps, Shift = 1 minute) with play (one hour per second), **month** and **day** boxes (type digits, Enter / Tab, ↑ ↓ step; clamped to the month), **+1 h DST**, the sun's height and bearing, and sliders for **sunlight**, **sky / diffuse light**, **shadow intensity** and **light through glass**, plus RESET LIGHTING. The site comes from Revit's Location (latitude, longitude, time zone); the start date / time from the launch view's sun settings (else today 12:00). Glass lets light through by its Revit transparency, tinted by its colour. Bookmarks saved with shadows on remember the date / time and GO restores it.

Coordinate readout (L, remembered in settings): **Shared** = survey coordinates (E / N / elevation) from the model's shared site, as Revit's spot coordinates relative to the survey point; **Project** = relative to the project base point on project-north axes; **Internal** = Revit internal metres. Files exported before v5.1 derive shared coordinates from the survey point stored in float precision (marked "≈", can be ~0.5 m out on large grid coordinates): export again for millimetres.

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
│   ├── Scene/                     #   SceneData, CategoryCatalog, LaunchSettings, ModelInfo (provenance, site, ParameterTable), LinkInfo, SiteCoordinates, SolarPosition
│   ├── Edits/                     #   EditRequest/EditResult/EditChannel, EditJournal + JournalEntry
│   ├── Sources/                   #   IModelSource, FileEditSource
│   ├── Live/                      #   protocol (session.json, envelopes, message types), FolderChannel, LiveSessions, LiveSessionSource + ILiveLink, JournalPush (temporary push channel)
│   ├── Format/                    #   .bimgo: BimGoFormat, BimGoReader/Writer, DTOs, BimGoDocument, SunModels, comment / bookmark / sun sidecars
│   └── Utilities/Log_Utils.cs
├── BimGo.App/                     # BimGo.exe and the engine (no Revit)
│   ├── Program.cs                 #   entry point, single instance, DPI awareness, --register / --unregister
│   ├── Shell/                     #   AppShell (home ↔ walkthrough loop, switch / reload), HomeScreen, OpenTarget, RecentFiles, AppInstance (mutex + inbox), FileAssociation
│   ├── Game/                      #   GameSession (+Render, +Menu, +Edits, +Document, +Live, +Push, +Comments, +Bookmarks, +Coordinates, +Sun), CommentStore, BookmarkStore, SessionOptions, guns
│   ├── Rendering/                 #   SceneRenderer (+ shadow passes), ShadowMaps (cascades), SunLighting, Shaders, UI
│   ├── Physics/ Platform/ Native/ Audio/
└── BimGo.Revit/                   # the add-in (template configs R25–R27)
    ├── Application.cs             #   ribbon: BimGo tab → Walkthrough → Go, Export .bimgo, Live (status)
    ├── Commands/Cmds_BimGo.cs     #   Cmd_Launch (Go → live session + app), Cmd_Export (.bimgo), Cmd_Status
    ├── Extraction/                #   SceneExtractor (host + ticked links), LinkResolver (link instances, saved choice), CategoryResolver, ParameterScanner, PhaseResolver
    ├── Live/                      #   SessionHost (folder, heartbeat, snapshots), LiveDispatcher (ExternalEvent, registry, doc events, ribbon status)
    ├── Bridge/RevitEditor.cs      #   applies edits: transactions, failure swallowing, clone key map, phases
    ├── Bridge/RevitEditor.Push.cs #   journal.apply: one TransactionGroup, dry run, staleness check, push-local clone map
    ├── Forms/OptionsWindow        #   WPF options (categories, phases, extra parameters, display, gizmo snap)
    └── Extensions/ General/ Utilities/ Resources/   # template (+ App_Utils: find / start BimGo.exe)
tests/
└── BimGo.Core.Tests/              # MSTest (dev-only, references BimGo.Core only): format round-trips, older / damaged files,
                                   #   journal, sun position, settings, progress, live channel, sidecars
```

## 5. How it works

- **Phases.** `PhaseResolver` resolves the **existing** and **new** phases from the saved names (Options), else new = the launch view's phase (else the last) and existing = the phase before it. Each element gets a role: *existing* (there in the existing phase, still standing in the new one: demolishable), *new* (created in the new phase), *between* (built in between) or *unphased*. Demolition sets Phase Demolished to the new phase and is refused for anything but existing elements (the hammer says so before sending; Revit checks again). Copies get Phase Created = new phase.
- **Extraction (Revit thread).** For each ticked category, elements are filtered (no view-specific elements or secondary design options, and only what stands in the new phase: nothing demolished by it or built after it). They are tessellated, coloured from their materials and converted to metres around a scene origin (the median element centre, rounded). Each element also records:
  - its ElementId, **UniqueId** and **host id**;
  - its movability and pivot;
  - the **extra parameters** picked in Options (instance value, else the type's).

  The extraction also captures:
  - **Linked models** ticked in Options (`LinkResolver`): each loaded instance is a *source* with its own document, total transform, phases (matched by name to the host's) and caches (materials, categories, levels). Its elements follow the host's (so host elements keep the lowest indices) with `link` = n, are never movable (`MoveBlockReason` "In linked model … (read-only)") and record no host id. Its rooms are added with `link` = n (host rooms win in the readout). Levels and the level list stay the host's.
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
| `elements.json` | per element: id, uniqueId, name, category index, family/type, level, hostId, proxy, movable/reason, pivot, `phase` (optional: `new` / `between` / `unphased`; absent = existing), `link` (optional: n = `model.links[n-1]`; absent = host), bounds, `[start,count]` index ranges |
| `parameters.json` | optional: pooled `names`, pooled `values`, per-element `rows` of name/value index pairs |
| `geometry.bin` | header (`BGEO`, version, vertex size 28, counts), then `SceneVertex[]` and `uint[]` indices, little-endian |
| `comments.json` | comment markers (Revit internal metres; optional `edited` / `editedBy`) |
| `journal.json` | ordered edit entries |
| `visibility.json` | optional (only when something is hidden): `hiddenCategories` (catalog keys), `hiddenLinks` (link instance UniqueIds), `hiddenElements[]` (`link` instance UniqueId or absent, `uniqueId`, `id`) |
| `sun.json` | optional: `enabled`, `time` (`month`, `day`, `minutes`, `daylightSaving`), `sunIntensity`, `skyIntensity`, `shadowIntensity`, `glassTransmission`. Bookmarks may carry `sun` (same `time` shape) |
| `bookmarks.json` | optional (written when there are bookmarks or a home): `bookmarks[]` with id, name, author, created, `x`/`y`/`z` (feet, Revit internal metres), `yaw`/`pitch` (radians), `flying`, `level`, optional `sun` and `thumbnail` (base64 JPEG); optional `home` (same shape: where walkthroughs start). List order = Ctrl+1–9 order |

`model.site` also carries (v5.1, additive) `hasSharedTransform`, `sharedEast`, `sharedNorth`, `sharedElevation` (shared position of the internal origin, double precision) and `sharedAngle` (internal → shared rotation): shared = Rz(sharedAngle) · internal + (east, north, elevation). The manifest's `counts` gained `bookmarks`. v6 adds `model.site.hasLocation`, `latitude`, `longitude` (degrees, east / north positive), `timeZone` (hours), `placeName` and `sunStart` (`yyyy-MM-ddTHH:mm`, the launch view's sun-study start). Settings gained `ShadowQuality` (Low / Medium / High).

v8 (1.0) adds `visibility.json`, `manifest.extraction.activeView` (the view name when extracted with "active view only") and the catalog key `other`. Settings gained `ActiveViewOnly`, `SkipHelperGeometry` and `HelperSubcategoryKeywords`.

v7 adds `model.links[]` (optional; one per extracted link instance: `index`, `name`, `title`, `instanceId`, `instanceUniqueId`, `modelKey`, `modelPath`, `originX/Y/Z` (host internal metres, double), `basisX/Y/Z`, `phaseName`, `existingPhaseName`, `elementCount`, `roomCount`), `elements[].link`, `model.rooms[].link` and `manifest.counts.links`. Ids and unique ids are only unique within one model: readers must key elements by (link, id). Older readers ignore the fields and show linked elements as ordinary (non-movable) elements. Settings gained `LinkedModels` (host model key → ticked link instance UniqueIds).

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
| app → Revit | `select.elements` | ElementIds; optional `linked[]` (`linkInstanceId`, `elementId`): a new add-in selects those by link reference (`Selection.SetReferences`) and zooms to them, an older one selects the link instances in ElementIds |
| Revit → app | `select.result` | success, message |
| Revit → app | `model.changed` | added / modified / deleted counts since the last flush |
| Revit → app | `session.closing` | reason |
| app → Revit | `detach` | none |
| app → Revit | `journal.apply` | `JournalApplyPayload`: requestId, dryRun, toleranceMm (5), applyConflicts, modelKey, phaseName, existingPhaseName, fileName, knownClones, entries (or `payloadPath` for big requests) |
| Revit → app | `journal.result` | `JournalResultPayload`: requestId, dryRun, success, message, phases used, undoLabel, results (seq, status `applied` / `skipped` / `conflict` / `failed` / `alreadyApplied`, message, newElementId, affected), totals |

Additive to protocol 1: an older add-in ignores `journal.apply` and the app times out with a hint to update it. `session.json` also carries `existingPhaseName`.

Envelope: `protocol`, `id`, `seq`, `sessionId`, `type`, `replyTo`, `sentUtc`, `payload`. Files are named `<utc>-<seq>-<type>.json` so name order is send order; written as `.tmp` then renamed; read by a `FileSystemWatcher` plus a 1 s poll; validated (session id, protocol, 4 MB cap), de-duplicated by id and deleted.

## 8. Known limitations / to verify

- **v5 not compiled yet** (`ElementOnPhaseStatus.NotApplicable` does not exist and was removed in v5.1; written without a .NET SDK or the Revit API assemblies; phase 2 has since been built and fixed). Check `PhaseResolver` (`Element.GetPhaseStatus`, `ElementOnPhaseStatus` names), `RevitEditor.Push.cs` (`TransactionGroup.Assimilate`), `DBEvents.UndoOperation.TransactionGroupRolledBack`, the COM `IShellLinkW` interop in `FileAssociation` and the new XAML rows in `OptionsWindow`.
- Show in Revit works when the session's model is Revit's active document (otherwise the app is told to switch).
- One app window walks one model; other sessions wait on the home screen.
- Revit API calls to verify on 2025–2027:
  - `Mesh.DistributionOfNormals` / `GetNormal`, `Element.DemolishedPhaseId`, `Document.IsModelInCloud`, `Level.ProjectElevation`;
  - `WorksharingUtils.GetCheckoutStatus`, `Element.GetDependentElements`;
  - new in v3: `Document.GetCloudModelPath`, `BasePoint.GetProjectBasePoint/GetSurveyPoint`, `ProjectLocation.GetProjectPosition`.
- Standalone demolish removes hosted elements with their host (from `HostId`). Revit's own rules for face-hosted families may differ.
- Undo / redo are file-only. In a live session, undo in Revit, then F5 (undoing BimGo's own edits counts as a model change). In a file, undo stops at edits already in Revit (pushed or made live). The redo history lives in memory only (not saved) and ends with any new edit.
- **v5.1 not compiled yet** either (redo, bookmarks, coordinate readout). Revit side: `ProjectPosition` (`EastWest`, `NorthSouth`, `Elevation`, `Angle`) in `SceneExtractor.BuildSite`. The internal → shared rotation sign is checked against the survey / base point at extraction (logged when flipped); verify the shared readout against a Revit spot coordinate on a rotated, georeferenced model.
- **v6 not compiled yet** (sun / shadows). Verify: `Document.SiteLocation` (`Latitude` / `Longitude` in radians, `TimeZone`, `PlaceName`), `View.SunAndShadowSettings.StartDateAndTime` (UTC or local? the code converts when `Kind` is UTC; compare the start time in the log with Revit's Sun Settings); GL `glTexImage3D` / `glFramebufferTextureLayer` (wglGetProcAddress) and `glColorMask` / `glDrawBuffer` / `glReadBuffer` (opengl32 exports); the GLSL (`sampler2DArrayShadow`, dynamic uniform-array indexing) on the target drivers. Compare the sun direction with a Revit sun study on a rotated model.
- Shadows: one glass layer model (all glass in front of the first opaque surface multiplies; glass beyond it is ignored). No cascade blending (a faint seam can show where cascades meet). Shadow acne / peter-panning tuned by a fixed polygon offset and a 1.5-texel normal offset. DST is a manual +1 h checkbox (no regional rules). Video memory: Low ~16 MB, Medium ~50 MB, High ~150 MB (doubled for models with glass).
- Project coordinates are relative to the project base point on project-north axes (the base point's own "angle to true north" is not applied).
- Refresh is a full re-extract (incremental refresh later).
- Push: the staleness check needs a location point (only point-based families are movable, so moves and clones always have one). A hide whose element is gone counts as already applied for deletes and skipped for demolitions. Clones have no duplicate guard beyond the journal flag: if the app loses the answer to a real push (timeout), check Revit before pushing again.
- Phases are saved by name in the shared settings; a model without those names falls back to the defaults (and the walkthrough says so once). Clones made before v5 kept their source's phase.
- Saving from a Revit session leaves out edits still waiting for Revit (a toast says so).
- Stairs, railings, roof edges and orthographic spawn behave as in v2 (see the build notes).
- **1.0 not compiled yet** (active view only, helper geometry, hide / isolate, visibility file, screenshots). Verify: `FilteredElementCollector(doc, viewId, linkId)` (2024+), `Options.View` with a 3D view, `GraphicsStyle.GraphicsStyleCategory` / `Category.Parent`, `View.GetCategoryHidden`, `Element.IsHidden(View)`, `glReadPixels` (opengl32 export), `System.Drawing.Bitmap` PNG save.
- Active view only: what a plan or section shows depends on its view range / far clip (a 3D view is the reliable choice); temporary hide / isolate in Revit may or may not be honoured by the view collector; elements Revit draws only in plan (symbolic lines) have no 3D geometry.
- **v7** (linked models) built and works (Gavin, 2026-10-11).
- Linked models: only top-level link instances are offered (nested links are not extracted); unloaded links are listed but can't be ticked; link phases are matched by name (Revit's per-link phase mapping isn't exposed in the API); a link's levels name its elements but don't join the level list (PgUp / PgDn); linked elements are read-only and never enter the journal or push; comments on them record no element id. A link reloaded in Revit shows as MODEL CHANGED (F5 re-extracts it).
- More than 9 guns will need a rethink of the number keys.
- **Dependencies round (Silk.NET GL bindings + Core tests) not compiled yet** (written without a .NET SDK or NuGet access). Verify: restore of `Silk.NET.OpenGL` 2.23.0 and `MSTest.Sdk` 4.4.1; the `Gl` facade overloads against Silk.NET (GLEnum casts, `uint` sizes); every test passes; the §6 UX parity checklist in `ai/261013_Dependencies/0_BimGo Dependencies_Handoff.md` (rendering paths, 3.3 fallback, startup error text, frame times).
- Silk.NET.Core brings Microsoft.Extensions.DependencyModel 9.x, which may in turn copy a newer `System.Text.Json.dll` (9.x) beside `BimGo.exe`; the app (and BimGo.Core inside it) would then use it instead of the 8.0 framework copy. Check the build output; JSON behaviour should be identical for BimGo's DTOs, and the Revit add-in is unaffected.
- Journal replay onto the scene lives in BimGo.App (`GameSession`), so the Core tests cover the journal's own rules (numbering, undo / redo, clone keys, push request) but not replay.

## 9. Changelog

### 2026-10-13: Dependencies round: Silk.NET GL bindings, Core tests, MIT licence

- **OpenGL bindings:** `Native/Gl.cs` is now a thin facade over **Silk.NET.OpenGL 2.23.0** (BimGo.App only). Same `Gl.Xxx` names, signatures and `uint` constants, so no renderer or UI code changed; the ~75 hand-written function pointers and their load table are gone. Every entry point BimGo uses is still checked at startup with the same "Update the graphics driver" message; Silk.NET then resolves each one lazily through the same `wglGetProcAddress` / opengl32 lookup (`Gl.GetProc`, still used by `Wgl`). Forwarding allocates nothing. `Native/Wgl.cs` (context creation, 4.1 → 3.3 fallback, swap interval) is unchanged.
- **Tests:** new `tests/BimGo.Core.Tests` (MSTest.Sdk 4.4.1, net8.0, BimGo.Core only, in the solution's `tests` folder): `.bimgo` round-trips (geometry, elements, links, site, journal, bookmarks with home and thumbnail, sun, visibility, comments, parameters), optional entries, atomic replace and cancelled save / read, early-layout files, newer / foreign / damaged files, journal rules and the push request, sun position against an independent reference (Sydney, London, Adelaide), settings sanitising and link choices, progress maths and cancellation, the live folder channel (round-trip, order, wrong session, newer protocol, 4 MB cap, duplicates) and the sidecars. Tests log to `BimGo.Tests.log` and use temp folders only.
- **Fix (found by the tests):** `LaunchSettings.SetLinksFor` kept at most 200 models' link choices by removing `Keys.First()`, but a `Dictionary` reuses freed slots, so once full it dropped the choice just made instead of the oldest. It now rebuilds the dictionary in recency order.
- **Licence:** MIT (© Aussie BIM Guru) replaces the Unlicense. `THIRD-PARTY-NOTICES.txt` lists Silk.NET and its MIT dependencies; both files are copied beside `BimGo.exe` on build (`LICENSE.txt`, `THIRD-PARTY-NOTICES.txt`).
- README: the dependency policy replaces the old "No dependencies" rule (AI item 3), dependency table (§10).

### 2026-10-12: 1.0.0: saved home, bookmark thumbnails, bookmark cancel

- **Saved home:** Shift+H / SET HOME HERE now saves home with the model (`bookmarks.json` → `home` in a .bimgo, or the bookmarks sidecar beside the Revit model), and walkthroughs of that model start there (before the active 3D view or a random spot; a reload still keeps where you stood). Setting home is acknowledged with a sound, a flash, a note and, in the pause menu, the button reading HOME SAVED HERE for two seconds. Export .bimgo now carries the model's bookmarks and home too (like its comments).
- **Bookmark thumbnails:** a 192 × 108 JPEG (base64 `thumbnail`, a few kB) of the 3D view (no HUD) is taken the frame after B, ADD THIS VIEW or SET HERE, and shown in the BOOKMARKS list (older bookmarks show NO PICTURE until SET HERE). `UiBatch.Image` draws textures in order with the batch.
- **Esc cancels a new bookmark:** B now prepares the bookmark and only adds it when the name is confirmed with Enter; Esc throws it away (nothing saved, the file isn't marked changed).

### 2026-10-12: 1.0.0: stair climbing

- **Stairs climb reliably.** The capsule's rounded bottom used to hang on the nosing: the old step-up probed only one tick (~3 cm) ahead, its landing contact read as a wall, and the climb was refused, so the step height setting seemed to do nothing. Now a contact on the rounded bottom that is no higher than the **max step height** above the feet (and whose triangle doesn't reach higher, so steep slopes and walls stay walls) lifts the player straight up, rolling over nosings, riser tops, kerbs and stringer edges like a short ramp, for square, sloped, open or rounded risers and at any angle of approach. Risers taller than the rounded bottom can ride (step height above ~0.27 m) use a step-up that probes a capsule radius ahead. The max step height (Options, default 200 mm) now means exactly that.

### 2026-10-12: 1.0.0 polish: progress bars, sun time readout, help panel, wording

- **Progress with Cancel** for the long tasks. Revit: Go, Export and refreshes (F5 / Send a fresh snapshot) show a progress window (stage, element count, bar, Cancel; it appears after half a second, on its own thread so it stays responsive while Revit works). Cancelling stops the extraction or the file write; nothing in the model changes, an export or snapshot is not written, and a cancelled refresh tells the walkthrough. App: opening a file, joining / reloading a live session, preparing the scene and saving show a progress screen (CANCEL or Esc; a cancelled save leaves the file on disk untouched).
- **[ ]** now shows the date and time reached on each step, with the sun's height and direction (e.g. "21 Jun 14:35 · sun 32° high in the NW").
- **F1 help panel** sizes itself to its text.
- **Wording review** across the app, the Options dialog and the Revit messages: one name per thing (Demolish gun, not hammer; "not connected to Revit" instead of "no Revit link", so it can't be confused with linked models; portals "connect"), full sentences in dialogs, the same Esc → BUTTON pattern for menu hints.
- Smoke tested on Revit 2025, 2026 and 2027 (Gavin, 2026-10-11).

### 2026-10-11: 1.0.0: active view only, helper geometry, hide / isolate, screenshots

- **Build fix:** `Gl.SRC_COLOR` (used by the glass shadow pass) was missing.
- **Active view only** (Options, off by default): the view decides what comes in, for the host and ticked links (`ViewScope`, Revit 2024+ link view collector); unlisted model categories go to the new catalog entry **Other (active view)**; 3D views read host geometry through the view. Rooms, spaces, areas, link instances, model groups, assemblies, cameras and model lines are never geometry.
- **Helper geometry** (Options, on by default): Light Source subcategory (IES cones) always left out, plus subcategories matching editable keywords; logged once per subcategory.
- **Ground plane** defaults to 100 mm below the lowest level.
- **Hide / isolate** (Scan gun): I hides the target in the walkthrough only, Shift+I isolates its category; pause menu SHOW ALL. Category / link toggles and hidden elements are **saved with the model** (`visibility.json` / live sidecar) and restored on open.
- **F12 screenshot** to Pictures\BimGo (scene only, PNG encoded on a worker thread).
- **Version 1.0.0** on all assemblies (`Version`, `AssemblyVersion`, `FileVersion`); version strings are now `1.0.0`; Options title and F1 help show it.

### 2026-10-10: v7: linked models

- **Options → LINKED MODELS:** every link instance, grouped by file (a file tick box sets all its instances); none ticked by default; unloaded links greyed out; the choice is saved per host model and reused by F5 / Send a fresh snapshot. The footer estimate counts the ticked links.
- **Extraction:** ticked instances are extracted with the host's categories and triangle limit, through their total transform, in the link's phase named like the host's new phase (else its last). Per-source material, category and level caches (ids are per document). Link rooms feed the room readout where the host has none. The scene origin takes linked elements into account.
- **Format (additive):** `model.links[]`, `elements[].link`, `rooms[].link`, `counts.links`.
- **App:** linked elements are read-only (Demolish refuses with the link's name; Gizmo / Clone show it as the reason), skipped by the id / unique-id / host lookups (no clashes with host ids), and comments on them record no element id. Scan shows a **Model** row; R selects the element inside its link in Revit (older add-ins select the link). Pause menu **LINKED MODELS** toggles per link (render batches are now per model and category, so a hidden link costs nothing). The load toast counts the links.

### 2026-10-09: v6: sun, shadows and time of day

- **Shadows** (O, off by default): cascaded shadow maps (depth texture array, hardware PCF, texel-snapped bounding-sphere cascades, normal-offset bias), cast and received by the static scene, moved / cloned elements and the ground. Only cascades whose fit, the sun or the casters changed re-render; far cascades refresh every 2nd–4th frame while walking. Off frees the maps.
- **Glass:** a transmittance layer per cascade (glass multiplied in front of the first opaque surface), from each material's transparency and tint, scaled by the glass slider.
- **Sun panel** (Shift+O or the bottom-right sun icon): shadows and quality, time slider with play, month / day boxes, DST, sun height / bearing, sunlight / sky / shadow / glass intensities. Sky colours, the sun disc, fog and ambient follow the sun's height (night keeps a little sky light).
- **Solar maths** in Core (`SolarPosition`): Gavin's `SunPosition` with the NOAA declination / equation-of-time series; true north from the extraction-verified shared angle.
- **Revit:** extraction captures `SiteLocation` and the launch view's sun-study start; Options dialog has **Shadow quality**.
- Saved with the model (`sun.json`, live sidecar written ~1.5 s after the last change); bookmarks keep the sun time.

### 2026-10-08: v5.1: redo, viewpoint bookmarks, coordinate readout

- **Fix:** `PhaseResolver` no longer uses `ElementOnPhaseStatus.NotApplicable` (not in the Revit API); `None` covers unphased elements and failed lookups.
- **Redo** (files): Ctrl+Y or Ctrl+Shift+Z puts the last undone edit back (replays that one entry); any new edit ends the redo history; undone clone keys stay reserved so a redo never collides.
- **Viewpoint bookmarks:** B saves the viewpoint and asks for a name; Ctrl+1–9 jump; pause menu BOOKMARKS list (GO, RENAME, SET HERE, reorder, DELETE, ADD THIS VIEW); blue minimap dots. Saved in `.bimgo` (`bookmarks.json`) or the `<model>.bimgo-bookmarks.json` sidecar in live sessions; count towards unsaved changes in files.
- **Coordinate readout** (L): shared / project / internal coordinates of the crosshair point (double precision). Extraction now captures the internal → shared transform (`model.site.shared*`); older files fall back to the survey point ("≈").
- Pause menu buttons tighten on short screens so the extra entry fits above END SESSION.

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

## 10. Dependencies

The policy is in *For AI assistants* item 3. BimGo.Revit ships no packages. Licence texts are in `THIRD-PARTY-NOTICES.txt`.

| Package | Version | Licence | Used in | Why |
|---|---|---|---|---|
| Silk.NET.OpenGL | 2.23.0 (pinned) | MIT | BimGo.App (`Native/Gl.cs` only) | OpenGL function bindings: no hand-written unmanaged signatures for new GL calls |
| Silk.NET.Core, Silk.NET.Maths | 2.23.0 (transitive) | MIT | BimGo.App | Required by Silk.NET.OpenGL (loader / vtable; maths types unused by BimGo) |
| Microsoft.DotNet.PlatformAbstractions, Microsoft.Extensions.DependencyModel (+ small System.* packages) | transitive | MIT | BimGo.App | Required by Silk.NET.Core |
| MSTest.Sdk | 4.4.1 (pinned in the Sdk attribute) | MIT | `tests/BimGo.Core.Tests` (dev-only) | Test framework and runner; ships nothing |
