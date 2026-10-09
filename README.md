# BimGo — First-Person BIM Walkthroughs

BimGo (formerly **RvtGo**) turns a Revit model into an FPS-style, first-person walkthrough: collision, gravity, walkable stairs, a room readout and nine tool guns (**Scan**, **Measure**, **Portal**, **Comment**, **Teleport**, **Demolish**, **Gizmo**, **Clone**, **Place**). It renders with its own small OpenGL engine (own renderer, window and input; GL function bindings from Silk.NET). Personal project of Gavin, publisher **Aussie BIM Guru**, MIT licence.

Two parts:

- **BimGo for Revit**: a slim add-in (extractor + session bridge, no engine code). **Go** opens the model in the app as a *live session*: Demolish / Gizmo / Clone / Place edits go back into Revit, Scan → R selects in Revit, and changes made in Revit prompt a refresh (F5). **Export .bimgo** writes a standalone file.
- **BimGo** (`BimGo.exe`): joins live sessions, or opens `.bimgo` files without Revit, keeping edits in the file's journal (undo / redo) and later **pushing** them into the Revit model they came from.

Edits respect two phases picked in Options: the walkthrough shows the **new** phase, Demolish demolishes **existing** elements in it, new work can only be deleted, and clones / placements are created in the new phase.

## For AI assistants (e.g. Claude)

1. **Read first:** the latest round's handoff and build notes in `ai/<yymmdd>_<round>/` (newest folder last; `0_…` handoff, then numbered build notes), then this README. The README is the source of truth for what is built; §9 lists every round and its folder.
2. **Gavin's working copy is the source of truth.** Ask for a fresh zip (with his compile fixes) before editing. Claude usually can't compile here (no .NET SDK, no Revit API): say so in the build notes and list the APIs to verify.
3. **Keep this README current** (§8 *to verify*, §9 history) and write the round's notes in `ai/`. Zip the repo minus `bin/`, `obj/`, `.vs/`, `artifacts/`.
4. **Code style:** readable and robust over clever; XML doc headers; explicit types where clearer; nullable off. **No per-frame allocations** in the app. **No exceptions reach the user:** log with `Utilities.Log_Utils.Write`, show a toast or dialog; errors use `Toast(…, important: true)` (they show even with the UI hidden).
5. **Dependencies: own what differentiates BimGo, rent commodity plumbing.**
   - Own: renderer, shadows, picking, physics, guns, UI look, `.bimgo` format, journal, Revit bridge, live protocol, window / input (`Platform/`, `Native/Win32.cs`, `Native/Wgl.cs`), audio, font atlas.
   - Rent: OpenGL bindings (Silk.NET behind the `Native/Gl.cs` facade; renderer code calls `Gl.Xxx` with `uint` constants; add new calls as facade wrappers).
   - **BimGo.Revit stays package-free** (it loads inside Revit). Revit API references are HintPaths to the installed Revit.
   - Any new package needs Gavin's explicit yes, a permissive licence, a pinned version and a line in §10. No UI toolkits. Ask before adding folders.
6. **Project boundaries:** **Core** has no Revit, GL or UI code. **App** never references the Revit API. **Revit** is the only project touching the Revit API, only in `Commands/`, `Extraction/`, `Bridge/RevitEditor*.cs` and `Live/LiveDispatcher.cs` (Revit thread); `Live/SessionHost.cs` does file IO only. Nothing changes the Revit model except the user's own edits (and the family library's temporary transaction, which is always rolled back).
7. **Edits go through `IModelSource`** (`LiveSessionSource` or `FileEditSource`) via `GameSession.SubmitEdit`; every accepted edit is recorded in the `EditJournal`.
8. **Compatibility:** `.bimgo` `formatVersion` stays 1 and the live protocol stays 1: only additive, optional fields and entries. Settings migrate quietly (`LaunchSettings.Sanitise`).
9. **Tests:** `tests/BimGo.Core.Tests` (MSTest 4: `Assert.ThrowsExactly`, not `ThrowsException`). Run after any Core change.
10. **GLSL check without a GPU:** pull the shader strings out of `Rendering/Shaders.cs`, swap `#version 330 core` for `#version 300 es` + precision lines, compile and link in headless WebGL2 (Playwright + the pre-installed Chromium, SwiftShader); give every sampler its own texture unit in a test.
11. **Revit template conventions:** commands in `Commands/Cmds_<Group>.cs` as `Cmd_<Button>`; extensions in `Extensions/TypeName_Ext.cs`; tooltips and icons resolve from the command's base name (`BimGo_Launch`, `BimGo_Export`).
12. **Name clashes:** WPF, WinForms and Revit `DB` / `UI` are global usings in BimGo.Revit; WinForms + System.Drawing are global in BimGo.App. Avoid unqualified `Color`, `Point`, `Plane`, `View`, `Panel`, `CheckBox`, `TextBox`, `TaskDialog` (use the `DB.`, `UI.`, `SD.`, `Wpf.`, `Win.`, `WinForms` aliases).

## 1. Overview

| Item | Decision |
|---|---|
| Solution | `src/BimGo.sln`: **BimGo.Core** (net8.0), **BimGo.App** (net8.0-windows, `BimGo.exe`), **BimGo.Revit** (Revit 2025 / 2026 on net8.0-windows, 2027 on net10.0-windows). Version **1.0.0** on all three |
| Renderer | OpenGL 4.1 core (falls back to 3.3), GLSL 330, Win32 window |
| File format | `.bimgo`: ZIP of JSON metadata, binary geometry, comments, journal and optional parts (§6) |
| Live link | One watched folder per document (`%LocalAppData%\BimGo\Sessions\<id>\`): JSON message files both ways, heartbeats, `.bimgo` snapshots for geometry; one `ExternalEvent` runs all Revit-side work (§7) |
| Model folder | Live sessions keep comments, bookmarks, sun, visibility and texture overrides in `%LocalAppData%\BimGo\Models\<title>_<hash>\` (key: cloud GUID → central path → local path). Older sidecars beside the model are copied in once. Options → Player can mirror them beside the model to share (off by default). Files keep all of this inside the `.bimgo` |
| Settings / logs | `%AppData%\BimGo\settings.json` · `%LocalAppData%\BimGo\Logs\BimGo.Revit.log` / `BimGo.App.log` |
| App install | The App build copies itself to `%LocalAppData%\Programs\BimGo\` (where every Revit year's add-in looks for `BimGo.exe`) and registers `.bimgo` (HKCU) and a Start-menu shortcut; `--register` / `--unregister [--quiet]`. Installers (Inno Setup, per user, no admin) are planned: handoff in `ai/261009e_Installer` |
| Phases | **Existing** and **new** phase picked in Options (saved by name); defaults: new = launch view's phase, existing = the one before |
| What loads | Category ticks (Options → Categories), or **active view only** (off by default: the view decides everything). Helper geometry (IES cones, clearance zones by subcategory keyword) left out by default. **Linked models** none by default, ticked per instance, read-only. Ground plane 100 mm below the lowest level; moving it in the pause menu is saved with the model |
| Quality profiles | Basic / Medium / Realistic (pause menu and Options → Player); any manual change reads CUSTOM |
| Family library | Options → Geometry → *Family library* (**off by default**, Go only): loaded family types to place with the Place gun (§5) |

## 2. Getting started

1. Open `src/BimGo.sln` in Visual Studio 2022 (.NET desktop workload). Configurations `Debug R25` / `R26` / `R27` or Release.
2. Build the solution (the app too: Go launches it). The add-in deploys to `%AppData%\Autodesk\Revit\Addins\<year>\BimGo\`; the app to `%LocalAppData%\Programs\BimGo\`. The first build restores NuGet packages (§10).
3. Tests: Test Explorer → Run All (or `dotnet test tests/BimGo.Core.Tests`); temp folders only, log `BimGo.Tests.log`.
4. Remove any old `RvtGo.addin` (different AddInId: both tabs would load).
5. In Revit: **BimGo → Go** (live) or **Export .bimgo**. To debug the app, start **BimGo.App** with a `.bimgo` path or `--session <id>` (folder name under `Sessions`).

## 3. Controls

| Input | Action |
|---|---|
| WASD / arrows · Mouse | Move · Look (click the window to capture the mouse) |
| Space · Shift · Ctrl | Jump · Run · Crouch (fly mode: ascend / descend) |
| V | Fly / no-clip |
| 1–9, wheel · LMB / RMB | Select gun · gun primary / secondary |
| Page Up / Down | Teleport up / down a level |
| H / Shift+H | Go home / set home (saved with the model; walkthroughs start there) |
| B · Ctrl+1–9 | Bookmark this view (type a name, Enter; Esc cancels) · jump to bookmark |
| L | Coordinate readout: off → shared → project → internal |
| K | Artificial lights: off / glow / glow + light |
| O · Shift+O | Shadows on / off · sun panel (free cursor) |
| J | Sun hours study (free cursor, player still; RMB-drag looks, clicks pick surfaces) |
| [ / ] | Sun time −/+ 5 min (Shift: 1 min) while shadows are on |
| Tab | Minimap |
| U | Hide the UI (errors still show; every control keeps working). Esc or U brings it back |
| X | Clear this gun's markers (Comment gun: twice deletes all comments) |
| Ctrl+F | Find room: search by number, name or level and go there |
| Ctrl+S · Ctrl+Shift+S | Save · Save as (in a live session: save the walkthrough as a new `.bimgo`) |
| Ctrl+Z · Ctrl+Y / Ctrl+Shift+Z | Undo · redo (files only; live: undo in Revit, then F5) |
| F5 | Live: fresh snapshot from Revit (reloads where you stand) |
| F1 · F11 · F12 | Help · borderless fullscreen · screenshot (`Pictures\BimGo`) |
| Esc | Pause menu; cancels a gizmo; closes a panel; shows the UI again |
| **Gun keys** | |
| N (Measure) | Toggle normal projection |
| T (Demolish) | Toggle phase demolish (default) / delete |
| E (Comment) | Edit the hovered comment |
| R (Scan) · I · Shift+I | Select in Revit · hide target · isolate its category (pause menu SHOW ALL restores) |
| Gizmo / Clone / Place, locked on | Move mode: WASD in plan, E up / Q down. **R** move ↔ rotate (A / D turn). Shift fine, **G** snap on/off (Ctrl inverts while held), **Z / X** step the increment (5 mm–1 m, 1°–90°), **F drop / lift onto the first surface below the bottom centre of its box**, RMB commit, Esc cancel |
| F (Gizmo, aiming) | Drop / lift the aimed element onto the surface below and commit at once |

### Guns

| # | Gun | LMB | RMB | Live (Revit) | File |
|---|---|---|---|---|---|
| 1 | Scan | Lock target | Clear | Info + extra parameters; R selects in Revit | Same (no R) |
| 2 | Measure | Start / end point | Remove last | | Same |
| 3 | Portal | Blue portal | Red portal | | Same |
| 4 | Comment | Place + type (view + picture saved) | Remove marker | Model folder | In the file |
| 5 | Teleport | Blink to marker | Step back | | Same |
| 6 | Demolish | Prime / demolish | Un-prime | Demolish in new phase (T: delete) | Journal `hide` (hosted inserts too) |
| 7 | Gizmo | Lock on (FFE) | Commit | Moves / rotates in Revit | Journal `transform` |
| 8 | Clone | Clone in place | Commit | Copies in Revit | Journal `clone` |
| 9 | Place | Family library | Commit (not holding: place the last type again) | Places the type in Revit | Journal `place` |

**Pause menu:** RESUME, RETURN HOME, SET HOME HERE, SAVE / SAVE AS / PUSH TO REVIT (files) or SAVE AS .BIMGO (live), COMMENTS (issues: thumbnail, status, priority, assignee, replies; level and status filters; OPEN for the detail view and thread), BOOKMARKS (thumbnails, GO / RENAME / SET HERE / reorder / DELETE), TEXTURES (Realistic mode with missing images), FIND ROOM, SUN HOURS STUDY, **FAMILY LIBRARY** (when the snapshot has one), SHOW ALL (when anything is hidden), CLEAR MARKERS. Middle: category cards and LINKED MODELS toggles. Right: QUALITY PROFILE, then tabs **Display** (ground, colour mode, AA, FOV, mouse, VSync, invert Y, FPS, AO) · **Reflections** (Off / Some / All, source Sky / Probes / Probes HQ, strength, probe status, REFRESH) · **Debug** (colours Off / Reflection / Probes).

**Sun panel (Shift+O):** shadows and quality (Low / Medium / High, per machine), time slider with play, month / day, +1 h DST, sun height / bearing, sunlight / sky / shadow / glass sliders, artificial lights mode with Light / Bloom sliders, RESET LIGHTING. Site from Revit's Location; start time from the launch view's sun settings.

**Coordinate readout (L):** *Shared* = survey E / N / elevation (as Revit spot coordinates); *Project* = relative to the project base point on project-north axes; *Internal* = Revit internal metres.

## 4. Project structure

```
src/
├── BimGo.Core/          # net8.0: no Revit, no GL, no UI
│   ├── Scene/           #   SceneData, CategoryCatalog, LaunchSettings, QualityProfiles, ModelInfo, LinkInfo, SiteCoordinates,
│   │                    #   SolarPosition, SunHours, LightingData, MaterialData, TextureSearch, ProxyCatalog, TextureOverrides, FamilyLibrary
│   ├── Edits/           #   EditRequest / EditResult (EditOp), EditJournal + JournalEntry (JournalOps)
│   ├── Sources/         #   IModelSource, FileEditSource
│   ├── Live/            #   protocol, FolderChannel, LiveSessions, LiveSessionSource, JournalPush
│   ├── Format/          #   BimGoFormat, BimGoReader / Writer, DTOs, BimGoDocument, sidecars, ModelFolders
│   └── Utilities/
├── BimGo.App/           # BimGo.exe and the engine
│   ├── Program.cs · Shell/        # entry, single instance, home screen, open / recent, inbox, file association
│   ├── Game/            #   GameSession (+Render, +Menu, +Edits, +Document, +Live, +Push, +Comments, +Bookmarks, +Thumbnails,
│   │                    #   +Coordinates, +Sun, +Lights, +Textures, +Reflections, +Profiles, +Visibility, +Screenshot, +Library,
│   │                    #   +Rooms (Find room), +SunHours), SunHoursStudy, CommentStore, BookmarkStore
│   ├── Game/Guns/       #   Gun base, Scan, Measure, Portal, Comment, Teleport, Hammer (Demolish), Gizmo (+GizmoController,
│   │                    #   GizmoPanel), Clone, Place, GunIcons
│   ├── Rendering/       #   SceneRenderer, SceneBatches, ShadowMaps, LightShadows, ScreenEffects (AO + bloom), ArtificialLighting,
│   │                    #   SunLighting, MaterialTextures, ProxyPack, ReflectionProbes, Shaders, UI (UiBatch, fonts), Overlay3D
│   ├── Physics/         #   Bvh (static), DynamicSet (moved / cloned / placed instances), CharacterController
│   └── Platform/ Native/ Audio/ Resources/ (icon, CC0 proxy textures)
└── BimGo.Revit/         # the add-in
    ├── Application.cs · Commands/Cmds_BimGo.cs   # ribbon: Go, Export .bimgo, Live (status)
    ├── Extraction/      #   SceneExtractor (+Materials, +Lighting, +Review, +Library), TextureLocator, MaterialScan,
    │                    #   ReflectivityReader, LinkResolver, CategoryResolver, ParameterScanner, PhaseResolver, ViewScope,
    │                    #   ModelFolderResolver
    ├── Live/            #   SessionHost (folder, heartbeat, snapshots), LiveDispatcher (ExternalEvent, doc events, ribbon)
    ├── Bridge/          #   RevitEditor (live edits, clone key map, Place), RevitEditor.Push (journal.apply)
    ├── Forms/           #   OptionsWindow (7 tabs: Load, Categories, Geometry, Materials, Links, Parameters, Player),
    │                    #   TextureReviewWindow, ProgressWindow
    └── Extensions/ General/ Utilities/ Resources/
tests/BimGo.Core.Tests/  # MSTest (Core only): format round-trips, compatibility, journal, push, sun, settings, live channel,
                         #   sidecars, model folders, lighting, materials, texture search, profiles, family library
ai/                      # per-round handoffs and build notes (§9)
```

## 5. How it works

- **Extraction (Revit thread, `SceneExtractor`).** Ticked categories (or the active view), filtered to what stands in the new phase (no view-specific elements, no secondary design options), tessellated, coloured from materials and converted to metres around a scene origin (median element centre, rounded). Each element records ElementId, UniqueId, host id, movability + pivot (point-based loadable families that aren't pinned, grouped, nested, in-place or wall-hosted), phase role, extra parameters (Options) and its link. Also captured: levels, rooms (host and links), provenance (model key = `ProjectInformation.UniqueId`, cloud ids), site (true north, base / survey points, internal → shared transform, latitude / longitude / time zone, launch view sun time). Progress window with Cancel; nothing in the model changes.
- **Linked models.** Ticked loaded instances are extracted with the host's categories through their total transform, in the link phase named like the host's; their elements come after the host's (`link` = n), are read-only, and their rooms feed the readout where the host has none.
- **Sessions.** One `GameSession` runs both modes; only the `IModelSource` differs. Live edits are optimistic (applied at once, reverted if Revit refuses). Live: `edit` messages → `LiveDispatcher` → `RevitEditor` (one transaction each, warnings swallowed, named `BimGo: …`). File: `FileEditSource` accepts at once (removals include hosted inserts).
- **Live sessions.** Go extracts, writes an uncompressed snapshot `.bimgo` into the session folder and starts `BimGo.exe --session <id>` (a running app gets an inbox request and asks before switching models). Revit's 2 s heartbeat keeps `session.json` fresh and flushes `model.changed` counts (BimGo's own `BimGo: …` transactions excluded) → MODEL CHANGED · F5 → re-extract, reload where the player stands. Closing the document sends `session.closing` (the app goes read-only); a stale heartbeat (> 10 s) pauses edits.
- **Journal.** Every accepted edit is appended (both modes): targets by UniqueId (ElementId fallback) or by clone key for clones / placements made in a walkthrough, with pivot, offset, angle, label, author, time and `appliedToRevit`. Opening a file replays it on the untouched geometry; undo removes the last entry and replays the rest; redo is in memory only.
- **Push (`journal.apply`).** The app finds the live session with the file's model key and sends the entries not yet in Revit (plus `knownClones`). Revit applies them in one `TransactionGroup` (one undo), each in its own transaction; moves and clones check the element is still within 5 mm of the recorded pivot (else *conflict*, skipped unless "apply anyway"). Dry run = same work, rolled back. Requests over 3 MB travel as files.
- **Engine.** Batched, frustum-culled `glMultiDrawElements` per category × model; off-screen MSAA; fixed 120 Hz physics; one static BVH for picking and collision; hidden elements by degenerate indices; `DynamicInstance`s (moved originals, clones, placements: the source element's static triangles under a rigid transform, picked and collided through the static BVH with a one-element mask).
- **Shadows (O).** Cascaded shadow maps with glass transmittance (one glass layer); cascades re-render only when they change.
- **Ambient occlusion.** Half-resolution geometry pre-pass, 12-tap SSAO + depth-aware blur, applied to the ambient term only (on by default).
- **Artificial lights (K).** Glow from Revit self-illumination anywhere, plus lamp / LED / lens / diffuser… keyword materials (or a guessed lens) inside Lighting Fixtures; bloom over the scene. One light per fixture (lumens / kelvin from its parameters when readable, else 1000 lm / 3500 K); the nearest 32 lights in view each frame, each with a cached omnidirectional 6 × 256 px shadow map. Moved / cloned / placed fixtures carry their light; hidden ones go dark.
- **Materials, Realistic mode (opt-in at Go / Export).** Per material: render colour and colour texture by appearance schema (images found via Revit.ini / registry paths, the Autodesk library if present, the model folder and remembered search folders; downscaled, JPEG, embedded once), placement (real-world size, offset, angle, tint, fade, invert) and per-vertex surface coordinates (world-anchored on planar faces). Missing images fall back to the shading colour, or a CC0 keyword proxy (on by default). Overrides per model (Revit: Review textures…; app: TEXTURES panel). Tint, fade and invert are blended in linear light like Revit.
- **Reflections (Realistic).** `ReflectivityReader` reads each material's reflection strength and roughness from its appearance (schema rules; the only keywords: "mirror" → mirror, see-through "water" → water). Shine rounds to 25 % tiers and reflects at the threshold (Some = 50 %+, All = 25 %+); metals tint their reflection; glass uses Revit's reflectivity (×2.5, 10–50 %); water gets travelling ripples and a sun glint.
- **Reflection probes** (`ReflectionProbes`). One per room holding a reflective surface (a grid every ~8 m in rooms over 12 m), fallback probes for reflective surfaces outside rooms; six 90° faces each in one mipmapped RGBA8 array (128 px, HQ 256 px; ≤ 64 probes / 64 MB); progressive bake (2 faces per frame, nearest first), re-baked a second after the sun, lights, colour mode or the model change. Lookup: a plan grid (0.5 m cells × 0.5 m bands) names up to two probes per cell with a blend weight. Since the probe-leak fixes (§9, next round): every room claims its cells (the room whose floor is nearest below the cell centre wins, so slabs belong to the room above); cells take their own room's probe (a room without a probe shows the sky, never a neighbour's); probes blend only across **open** boundaries (a short ray at the band's height crosses no wall, doors and movable furniture ignored, or the gap is inside a door's box); the shader looks the cell up 0.75 cell (≥ 0.3 m) off the surface along its viewer-facing normal, so walls, glass, floors and ceilings read the room they face. All of it happens once when the grid is built: no per-frame cost. The log reports grid size, cell size and open / closed boundary counts.
- **Family library** (`SceneExtractor.Library`, `GameSession.Library`, `PlaceGun`). With Options → Geometry → *Family library* ticked, Go and F5 also send the loadable family types loaded in the model in the ticked FFE / services categories (in-place families excluded; at most *N*, default 200, types already used first), each with Revit's preview (`GetPreviewImage`, 128 px PNG). **Level-based** and **work-plane / face-based** types also get geometry (`FamilyPlacer`: work-plane types are hosted on the level's plane, else a sketch plane of the level): one temporary instance each on the lowest level in a single transaction that is **always rolled back**, extracted like any element (materials, glow, light), then stored as a hidden **template** element after every model element, 2 km below the model. Wall-hosted and other types are listed greyed with the reason. The app never draws, picks or collides templates; the pause menu's FAMILY LIBRARY panel (search, category chips, family list, preview cards) hands a type to the **Place gun**, which clones its template in front of the player (dropped onto the surface below) in the gizmo's move mode. RMB commits: live → `edit` with op `place` (Revit: `FamilyPlacer` on the level at or below the point, moved exactly onto it, rotated, new phase; registered under the clone key so later moves target it); file → journal `place` (`typeUniqueId`, pivot, angle, `newCloneKey`; replay clones the template again). Push places it the same way. Files saved from a live session keep the library (so placements replay); Export .bimgo never includes it.
- **Drop to surface (F).** One ray straight down from the bottom centre of the held element's box (starting up to 0.3 m above its base, so an element sunk into a floor is lifted), against the visible static scene and the other dynamic instances (never itself), up to 10 m; the first hit wins, so things land on desks and benches. Gizmo / Clone / Place keep it uncommitted (RMB commits as a normal move); the Gizmo gun's aim + F commits at once. Snapping leaves the dropped height alone until E / Q.
- **Comments as issues.** Each comment keeps its text, author, marker and level plus a **status** (Open / In progress / Closed), **priority** (Low / Normal / High), **assignee** (free text), a **reply thread**, the **viewpoint** it was made from (feet, yaw, pitch, fly) and a **thumbnail** of that view (192 × 108 JPEG, taken the frame after, from the 3D view only, sharing the bookmark capture). GO returns to the saved view (older comments: in front of the marker). The detail view (OPEN) edits status / priority / assignee, adds and deletes replies, SET VIEW HERE retakes view and picture, EDIT TEXT. Markers are coloured by status (closed: green, fainter); the hover label shows the issue line. CSV export adds status, priority, assignee, replies and the thread. All fields are optional: older comments read as open, normal, unassigned.
- **Find room** (Ctrl+F / pause menu). Every room (host and linked) with number, name, level and area; search by any of them (an exact number goes first; Enter takes the first match). GO stands the player on a clear floor spot nearest the room's middle (≥ 0.45 m from its walls, capsule checked), facing across it.
- **Sun hours study** (J / pause menu; `GameSession.SunHours`, `SunHoursStudy`, Core `SunHours`). The player stands still, the cursor is free, RMB-drag looks. Surfaces: the walls and floors of the room you stand in (wall / floor categories, grouped by element and plane; cells kept inside the room, walls within 6 cm of its boundary on the side facing in), plus any surface you click (clipped to the room it faces; click again to remove). Grid: square cells (0.1 / 0.25 / 0.5 / 1 m, default 0.25) in each face's plane, at the floor offset (floors, 0–2 m) or wall offset (walls, 0–1 m) + 2 cm; ≤ 80 000 cells. Run: sun positions every 5 / 10 / 15 min (sample mid-step) over the chosen day and time range (default 21 June 9:00–15:00; DST tick) from the site location and true north (`SolarPosition`); per cell one ray per sample in front of the surface against the visible static scene and moved / placed elements, glass passing unless "glass blocks sun" (the BVH's per-triangle transparent flag); 10 ms per frame on the game thread with a progress bar and CANCEL. Cells coloured on Ladybug's legend 0–7+ h; summary: average, min, max, share ≥ 2 h and ≥ 3 h. Results stay until CLEAR (also with the panel closed), never saved; EXPORT CSV (settings + one row per cell, Revit internal metres) and SCREENSHOT (3D view + legend, `Pictures\BimGo\<model> sun hours <time>.png`).
- **App shell.** One window alternates between the home screen (live sessions, Open, recent files, drag-and-drop) and walkthroughs; second launches and Revit's requests go through `%LocalAppData%\BimGo\App\inbox\`.

## 6. The `.bimgo` format (version 1)

A ZIP (extension masked); JSON camelCase; writes are atomic (`.tmp` then replace); readers load this version and older, refuse newer, and drop damaged optional parts without failing the load.

| Entry | Content |
|---|---|
| `manifest.json` | `format`, `formatVersion`, generator, `kind` (`revit-export` / `session-save` / `save` / `live-snapshot`), title, created / saved, provenance, extraction options (incl. `activeView`), counts |
| `model.json` | origin offset, bounds, site (incl. shared transform, latitude / longitude / time zone, `sunStart`), phases (`phaseId/Name`, `existingPhaseId/Name`, `phaseNote`), spawn, levels, rooms (`link`), categories (catalog keys), `links[]` |
| `elements.json` | per element: id, uniqueId, name, category index, family/type, level, hostId, proxy, movable / reason, pivot, `phase`, `link`, bounds, `[start, count]` opaque / transparent index ranges; `library: true` marks a family library template |
| `geometry.bin` | `BGEO` header (version, vertex size 28, counts), `SceneVertex[]`, `uint[]` indices |
| `parameters.json` | optional extra parameters: pooled names / values, per-element rows |
| `comments.json` · `journal.json` | comments (marker, text, author; optional `status`, `priority`, `assignedTo`, `updated` / `updatedBy`, `replies[]`, `view`, `thumbnail`; same shape in the live model folder) · ordered edits (`hide` + mode, `transform`, `clone`, `place`) |
| `bookmarks.json` · `sun.json` · `visibility.json` | optional: bookmarks + home (thumbnails base64 JPEG) · sun state · hidden categories / links / elements and `groundOffset` (m from the default ground) |
| `lighting.json` | optional: glowing vertex runs and fixture lights |
| `materials.json` · `material.bin` · `textures/*` | optional (Realistic): material table (colour, texture, placement, tint, invert, reflection fields…), per-vertex material index + surface coordinate, embedded images |
| `library.json` · `library/*.png` | optional (live sessions): family library entries (`typeId`, `typeUniqueId`, family, type, category key, `placement`, `placeable`, `reason`, `element` = template index or -1, `preview`, `placed`) and `vertexStart` (first template vertex); previews |

Settings (`settings.json`) carry the Options and in-app display choices; notable keys: categories, phases, `ActiveViewOnly`, `SkipHelperGeometry`, `LinkedModels`, `ExtractTextures`, `TextureMaxSize`, `RevitTint`, `ProxyMissingTextures`, `TextureSearchFolders`, `ShadowQuality`, `ArtificialLights`, `BloomIntensity`, `ReflectionThreshold`, `ReflectionProbes`, `ProbeResolution`, `QualityProfile`, `SidecarsBesideModel`, `LastOptionsTab`, `FamilyLibrary`, `FamilyLibraryMax`.

## 7. The live session protocol (version 1)

| Direction | Type | Payload |
|---|---|---|
| app → Revit | `hello` / `detach` | pid, version / none |
| Revit → app | `hello.ack` | title, Revit version, new and existing phase |
| app → Revit | `edit` | `EditRequest`: ticket, op (`phaseDemolish` / `delete` / `transform` / `copy` / `place`), ElementId or clone key, `newCloneKey`, pivot, translation, angle, label; `place` adds `typeUniqueId`, `typeId` |
| Revit → app | `edit.result` | ticket, success, message, affected ids, new id, clone key |
| app → Revit | `extract.request` | reason |
| Revit → app | `extract.ready` / `extract.failed` | snapshot path, number, counts, seconds / message |
| app → Revit | `select.elements` | ElementIds; optional `linked[]` (link instance + element) |
| Revit → app | `select.result` · `model.changed` · `session.closing` | success / counts / reason |
| app → Revit | `journal.apply` | dry run, tolerance, apply conflicts, model key, phase names, file name, known clones, entries (or `payloadPath`) |
| Revit → app | `journal.result` | per entry: `applied` / `skipped` / `conflict` / `failed` / `alreadyApplied`, message, new id; totals, undo label |

Envelope: `protocol`, `id`, `seq`, `sessionId`, `type`, `replyTo`, `sentUtc`, `payload`; files `<utc>-<seq>-<type>.json` (`.tmp` then rename), read by a watcher + 1 s poll, validated (session, protocol, 4 MB cap), de-duplicated and deleted. Additive messages / ops: an older add-in ignores `journal.apply` and can't read `place` (the app times out with a hint to update).

## 8. Known limitations / to verify

**Comments / sun hours / find room round:** built and confirmed working by Gavin (2026-10-09, after the `MONTHS` fix). Still worth a look when convenient:
- Comments: the thumbnail is taken after a new comment and after SET VIEW HERE (it reads the 3D view behind the menu); the text box over the paused panel (reply, assign, edit); GO to a saved view (fly state); older comment files.
- Sun hours: wall cells on rooms bounded at wall finish (rooms bounded at wall centres lose their wall cells: click those walls instead), RMB-drag look with the cursor free, time per study (log line), the legend screenshot, CSV in Excel; compare a simple case with Ladybug.
- Find room: spot choice in L-shaped and furnished rooms; linked rooms.

**To verify, next round (written without a .NET SDK or the Revit API; GLSL checked in WebGL2):**
- Probes: the leak fixes on Gavin's test model (Debug → Probes colours); the grid build time and open / closed counts in the log; that doorways blend and walls don't.
- Family library, Revit: `FamilySymbol.GetPreviewImage(Size)`, `Family.FamilyPlacementType`, `Document.Create.NewFamilyInstance(XYZ, FamilySymbol, Level, StructuralType)` (how it reads the point's height: the code moves the instance onto the point afterwards), work-plane types via `Level.GetPlaneReference()` / `SketchPlane.Create(doc, levelId)` + `NewFamilyInstance(Reference, XYZ, XYZ, FamilySymbol)` (orientation matches the template; moving it off the level sets its offset), `FamilySymbol.Activate` inside the rolled-back transaction, that the rollback raises no MODEL CHANGED, worksharing (new elements on a non-editable active workset), the Go time with 200 types.
- Family library, app: the panel on small screens; preview decoding (System.Drawing PNG); placing, moving, cloning and deleting placements live and in files; undo / redo / save / reopen; push of `place` entries.
- Drop to surface on desks, benches and sunk elements.
- The ground plane height comes back after reopening a file, after F5 and on the next Go.

**Standing limitations:**
- Undo / redo are file-only (live: undo in Revit, then F5). Refresh is a full re-extract.
- Show in Revit needs the session's model to be Revit's active document. One app window walks one model.
- Linked models: top-level instances only; phases matched by name; read-only; their levels don't join PgUp / PgDn.
- Demolish removes hosted elements with their host (face-hosted rules may differ from Revit's).
- Project coordinates ignore the base point's own angle to true north. Files from before v5.1 derive shared coordinates in float precision ("≈").
- Push: moves / clones need a location point; clones and placements have no duplicate guard beyond the journal flag (if a real push times out, check Revit before pushing again).
- Active view only: plans / sections depend on their view range; temporary hide / isolate may not be honoured.
- Shadows: one glass layer, no cascade blending, manual DST. Light shadows 256 px per face; glass doesn't cast them.
- AO is screen-space (fades at screen edges). Realistic mode: no bump / normal maps or cutouts; texture pattern origins are world-anchored, not Revit's per-face origin.
- Probes: static captures (moved furniture shows after the next re-bake); box projection approximates rooms as boxes; very large models grow the grid cells (logged); a room without reflective surfaces has no probe, so glass in it reflects the sky.
- Family library: level-based and work-plane / face-based types only (wall-hosted listed, not placeable; work-plane types always go on the level's plane, never onto a face); only the ticked FFE / services categories; templates make live snapshots (and files saved from them) bigger; Export never includes the library.
- Silk.NET may bring a newer `System.Text.Json.dll` beside `BimGo.exe` (behaviour identical for BimGo's DTOs).
- Sun hours: geometric only (no diffuse sky, no reflections); a cell is lit or not per sample (no partial shade); the ground plane doesn't shade; results aren't saved with the model.
- Key bindings grew one round at a time: a full review is planned before v1 (more than 9 guns would need a rethink of the number keys).

## 9. History

Every round's handoff and build notes live in `ai/<yymmdd>_<round>/`. Same-day folders carry a letter (a, b, c…) so they sort in order.

| Date | Round (folder) | What it added |
|---|---|---|
| 2026-10-01 | v1 (`261001_V1`) | Template fork, WPF options, extraction, engine (GL, batching, MSAA, sky, minimap, HUD, pause menu), physics, Scan / Measure / Portal / Comment guns; doors always no-clip |
| 2026-10-04 | v2 (`261004_V2`) | Room readout, gun bar, Teleport / Demolish / Gizmo / Clone, Revit write-back via `ExternalEvent`, dynamic instances |
| 2026-10-05 | v3 (`261005_V3`) | Rename to BimGo; Core / App / Revit split; `.bimgo`; standalone app; journal; live sessions replace the in-Revit game; F5 refresh; Show in Revit; gizmo snapping |
| 2026-10-06 | v4 (`261006_V4`) | App icon, build fixes, handoff for push |
| 2026-10-07 | v5 (`261007_V5`) | Push to Revit (`journal.apply`), existing / new phases, file association, comment editing and list, snap defaults |
| 2026-10-08 | v5.1 (`261008_V5.1`) | Redo, viewpoint bookmarks, coordinate readout |
| 2026-10-09 | v6 (`261009a_V6`) | Sun, cascaded shadows, time of day, sun panel |
| 2026-10-09 | v7 (`261009b_V7`) | Linked models |
| 2026-10-09 | 1.0 (`261009c_V8_1.0`) | Active view only, helper geometry, hide / isolate, screenshots, saved home, bookmark thumbnails, stair climbing, progress with Cancel, wording review; smoke tested on Revit 2025–2027 |
| 2026-10-09 | Dependencies (`261009d_Dependencies`) | Silk.NET GL bindings, Core tests (MSTest), MIT licence |
| 2026-10-09 | Installer (`261009e_Installer`) | Handoff only: Inno Setup installers (not built yet) |
| 2026-10-09 | AO (`261009f_Rendering_AO`) | Screen-space ambient occlusion |
| 2026-10-09 | Lights (`261009g_Rendering_Lights`) | Glow, bloom, fixture lights with cached shadow maps |
| 2026-10-09 | Gizmo modes (`261009h_Gizmo_Modes`) | Separate move / rotate modes, vertical moves |
| 2026-10-09 | Materials (`261009i_Materials`) | Material scan, Realistic mode with textures, glass reflections, texture reconciliation, CC0 proxies, tint / invert |
| 2026-10-09 | Reflection probes (`261009j_ReflectionProbes`) | Reflectivity reading, tiered reflections, water, probes |
| 2026-10-09 | UX cleanup (`261009k_UX_Cleanup`) | Hide UI (U), quality profiles, tabbed pause menu, 7-tab Options window, per-model folders |
| 2026-10-09 | Next round (`261009l_NextRound`) | Probe leak fixes (no per-frame cost), family library + Place gun (9) incl. work-plane families, drop / lift to surface (F), ground plane saved with the model; README slimmed, dates fixed |
| 2026-10-09 | Comments, sun hours (`261009m_Comments_SunHours`) | Comments as issues (status, priority, assignee, replies, saved view + thumbnail), direct sun hours study (J), Find room (Ctrl+F) |

## 10. Dependencies

BimGo.Revit ships no packages. Licence texts: `THIRD-PARTY-NOTICES.txt` (copied beside `BimGo.exe` with `LICENSE.txt`).

| Package | Version | Licence | Used in | Why |
|---|---|---|---|---|
| Silk.NET.OpenGL | 2.23.0 (pinned) | MIT | BimGo.App (`Native/Gl.cs` only) | OpenGL function bindings |
| Silk.NET.Core, Silk.NET.Maths | 2.23.0 (transitive) | MIT | BimGo.App | Required by Silk.NET.OpenGL |
| Microsoft.DotNet.PlatformAbstractions, Microsoft.Extensions.DependencyModel (+ small System.* packages) | transitive | MIT | BimGo.App | Required by Silk.NET.Core |
| MSTest.Sdk | 4.4.1 (pinned in the Sdk attribute) | MIT | `tests/BimGo.Core.Tests` (dev-only) | Test framework and runner |
