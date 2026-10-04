# RvtGo — First-Person Revit Walkthrough

RvtGo turns the active Revit model into an FPS-style, first-person walkthrough in its own window. Geometry is snapshotted once at launch and rendered by a small custom OpenGL engine (hand-written P/Invoke, no NuGet packages), with collision, gravity, walk-through doors, walkable stairs, a room readout and eight tool guns: **Scan**, **Measure**, **Portal**, **Comment**, **Teleport**, **Demolish**, **Gizmo** and **Clone**. The last three write their changes back to Revit.

Built from the **Scaffold** `RevitAddin` template (multi-version configurations, ribbon/tooltip/icon conventions). The design brief is `RvtGo_Spec.md` (kept in the RvtGo project); the HUD mockup is the visual reference.

## For AI assistants (e.g. Claude)

1. **Spec first.** `RvtGo_Spec.md` is the brief; this README documents what was built and where it deviates.
2. **Keep this README current**, especially the Changelog and *Known limitations / to verify*.
3. **No dependencies.** The no-NuGet rule is a design goal: GL, WGL, Win32, Raw Input and waveOut are all hand-written P/Invoke. Ask before adding any package.
4. **Threading rule:** only `Commands/`, `Extraction/` and `Bridge/RevitBridge.cs` touch the Revit API (Revit thread). Everything under `Game/`, `Rendering/`, `Physics/`, `Platform/`, `Audio/`, `Native/` runs on the game thread and must never call the Revit API. The game reaches Revit **only** by queuing a `BridgeRequest` on the session's `BridgeChannel` (`GameSession.SubmitToRevit`); `RevitBridge` runs it from an `ExternalEvent` and posts a `BridgeResult` back.
5. **Template conventions still apply:** `Commands/Cmds_<Group>.cs` → `Cmd_<Button>`, extensions in `Extensions/TypeName_Ext.cs`, tooltips/icons resolved from the command's base name (`RvtGo_Launch`).
6. **Name clashes:** the project enables both WPF and WinForms, and Revit's `DB`/`UI` namespaces are global usings. Avoid unqualified `Color`, `Point`, `Plane`, `View`, `Panel`, `CheckBox`, `TextBox`, `Orientation`… (use `DB.`, `SD.`, `Wpf.`, `Win.` aliases as the existing code does).
7. **Zip handoff** — zip the repo minus `bin/`, `obj/`, `.vs/`.

## 1. Overview

| Item | Decision |
|---|---|
| Runtime | Revit 2025 / 2026 on `net8.0-windows`, Revit 2027 on `net10.0-windows` (template configurations kept) |
| Renderer | OpenGL 4.1 core (falls back to 3.3), GLSL 330, Win32 window on its own thread |
| Model sync | Snapshot at launch; relaunch to refresh |
| Comments | JSON sidecar `<model>.rvtgo.json` beside the model (fallback `%LocalAppData%\RvtGo\Comments\`) |
| Entry point | **RvtGo** tab → **Walkthrough** panel → **Go** |
| Lifecycle | Closing the window ends the session; pressing Go while running brings the window to the front |

## 2. Getting Started

1. Open `src/RvtGo.sln` in Visual Studio 2022 (.NET desktop workload).
2. Pick a configuration (`Debug R25`, `Debug R26`, `Debug R27`, or Release).
3. F5 — the post-build step deploys to `%AppData%\Autodesk\Revit\Addins\<year>\` and launches Revit.
4. Open a project, set a perspective 3D view if you want to start from it, press **RvtGo → Go**.

Logs: `%LocalAppData%\RvtGo\RvtGo.log` (reset each Revit session). Launch options persist in `%AppData%\RvtGo\settings.json`.

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
| T | Demolish gun: toggle phase demolish (default) / delete |
| WASD · Q / E | Gizmo / Clone while locked on: move (view-relative) · rotate CCW / CW (player frozen) |
| Shift · Ctrl | Gizmo / Clone while locked on: fine control · snap the change to 50 mm / 15° |
| RMB · Esc | Gizmo / Clone while locked on: commit to Revit · cancel |
| Page Up / Page Down | Teleport up / down one level |
| Tab | Toggle minimap |
| H / Shift+H | Return home / set home |
| X | Clear current gun's markers (Comment gun: press twice to delete all comments) |
| F1 | Toggle controls help |
| F11 | Borderless fullscreen |
| Esc | Pause menu (category toggles, ground plane, colour, MSAA, FOV, sensitivity, VSync…); cancels the gizmo when locked on |

### Guns

| # | Gun | LMB | RMB | Notes |
|---|---|---|---|---|
| 1 | Scan | Lock target | Clear | Info panel; shows Revit id of moved / cloned elements |
| 2 | Measure | Start / end point | Remove last | N = normal projection |
| 3 | Portal | Blue portal | Red portal | Walk through to teleport |
| 4 | Comment | Place + type | Remove marker | JSON sidecar; X twice deletes all |
| 5 | Teleport | Blink to marker | Step back | Green marker = room to stand, red = blocked; wall hits drop to the floor below; 80 m range |
| 6 | Demolish | Prime / demolish primed | Un-prime | Phase demolish (session phase) by default, T = delete; dependants Revit removes (e.g. doors in a wall) vanish too |
| 7 | Gizmo | Lock on (FFE) | Commit | Loadable, point-based, not pinned / grouped / nested / in-place / wall-hosted |
| 8 | Clone | Clone in place (FFE) | Commit | Goes straight into the gizmo on the copy; Esc discards |

## 4. Project Structure

```
RvtGo/
├── RvtGo.addin / RvtGo.csproj / Application.cs   # Template: manifest, multi-version build, ribbon
├── Commands/Cmds_RvtGo.cs        # Cmd_Launch: options → extraction → bridge → game thread  [Revit thread]
├── Bridge/                        # The only route back into Revit
│   ├── BridgeMessages.cs          #   requests / results / thread-safe channel (no Revit types)  [both]
│   └── RevitBridge.cs             #   ExternalEvent handler, transactions, failure swallowing    [Revit thread]
├── Extraction/                    # Revit API → snapshot                                       [Revit thread]
│   ├── CategoryResolver.cs        #   catalog → BuiltInCategory (TryParse, version-safe)
│   └── SceneExtractor.cs          #   tessellation, colours, metadata, levels, rooms, phase, movability, spawn
├── Scene/                         # Revit-free shared model
│   ├── CategoryCatalog.cs         #   System / FFE / Services definitions
│   ├── LaunchSettings.cs          #   options + JSON persistence
│   └── SceneData.cs               #   immutable snapshot (vertices, indices, elements, levels, rooms)
├── Forms/OptionsWindow.xaml(.cs)  # WPF launch dialog (matches the mockup)
├── Platform/                      # Win32 window, WGL context, message pump, Raw Input      [game thread]
├── Native/                        # Hand-written P/Invoke: Win32, WGL, GL loader, winmm
├── Rendering/                     # Batching/chunks, scene renderer, overlay, UI batch, font atlas, camera
├── Physics/                       # BVH (shared by collision + picking), capsule controller, geometry math,
│                                  #   DynamicSet (moved / cloned elements: picking + collision via the static BVH)
├── Audio/SoundSystem.cs           # Synthesised sounds via waveOut (no assets)
├── Game/                          # GameHost (thread), GameSession (+Render, +Menu, +Edits), Player, Comments
│   └── Guns/                      #   Scan, Measure, Portal, Comment, Teleport, Hammer, Gizmo, Clone,
│                                  #   GizmoController (shared move/rotate), GunIcons (gun bar symbols)
├── Extensions/ General/ Utilities/ Resources/   # Template (+ Log_Utils)
```

New top-level folders compared with the template: `Extraction`, `Scene`, `Platform`, `Native`, `Rendering`, `Physics`, `Audio`, `Game`, `Bridge`.

## 5. How it works

- **Extraction (Revit thread).** For each ticked category, elements are filtered (no view-specific, secondary design options or demolished elements), tessellated (`Face.Triangulate`, Medium detail), coloured from face materials (category material fallback, transparency → alpha) and converted to metres around a scene origin (median element centre, rounded to whole metres). Winding is matched to Revit's outward normals so back faces can be detected in shaders. FFE/Services elements over the triangle limit become bounding-box proxies (or are skipped).
- **Doors.** Rendered exactly as modelled (no open/close animation) and always no-clip: door elements are excluded from collision so openings stay walkable. They can still be scanned and hidden from the pause menu.
- **Game thread.** Indices are re-ordered into per-category, per-pass (opaque/transparent) batches of spatial chunks; each batch is one `glMultiDrawElements` call over frustum-visible chunks. The scene renders into an off-screen (optionally MSAA) framebuffer, then the minimap and HUD draw on top. Physics runs at a fixed 120 Hz with render interpolation.
- **Physics.** Capsule (r 0.3 m, 1.75 m / 1.2 m crouched) against the static BVH by iterative depenetration; walkable contacts push straight up (no ramp sliding); step-up (default 200 mm), snap-down on stairs, camera smoothing; the ground plane catches falls.
- **Rooms.** Placed, bounded rooms of the working phase (the launch view's phase, else the last phase) are captured as finish-boundary loops (arcs tessellated) with a vertical extent from the room's bounding box. The game runs an even-odd point-in-polygon test at feet + 0.3 m whenever the player moves 50 mm; the smallest containing room wins. Shown as a ROOM row in the status panel plus a banner on change.
- **Runtime edits.** Hidden elements (demolished / deleted / moved originals) have their static index ranges overwritten with degenerate triangles via `glBufferSubData`, so batch and chunk draw lists never change; pick and collision masks are cleared too. Moved and cloned elements are `DynamicInstance`s: they reuse the static vertex buffer with a copy of the source element's indices in a small dynamic index buffer, drawn with a `uModel` matrix (rotation about +Z through the Revit location point, then translation). Picking and collision move the ray / box into the source's space and query the static BVH with a one-element mask.
- **Revit write-back.** `Cmd_Launch` starts a `BridgeChannel` (one `ExternalEvent`, created once and reused). Each request runs in its own transaction named `RvtGo: …` (one Revit undo step each) with a failures preprocessor that deletes warnings and rolls back on errors. Edits are optimistic in the game and reverted if Revit refuses (toast with Revit's reason). Clones are tracked by a session key so a clone can be moved or demolished before Revit has answered with its new id. The HUD shows "REVIT · n pending" while requests wait (e.g. a Revit dialog is open); the game re-raises the event if requests wait more than 1.5 s.
- **Minimap.** A real plan: the scene rendered top-down, clipped 0.3 m below to 1.2 m above the current level; back faces seen from above are drawn as the cut (poché).

## 6. Known limitations / to verify

- **Not compiled yet.** This version was written without access to a .NET SDK or the Revit API assemblies — expect a first round of small build fixes.
- Revit API calls to verify on 2025–2027: `Mesh.DistributionOfNormals` / `GetNormal`, `Element.DemolishedPhaseId`, `Document.IsModelInCloud`, `Level.ProjectElevation` as the geometry-space elevation.
- Stairs: component stairs with runs are skipped in favour of their runs/landings/supports to avoid duplicate geometry — verify on legacy/sketch stairs.
- Railings: top/hand rails are collected as separate categories; check for doubled geometry on some railing types.
- Roof edges / flashings have no dedicated built-in category; gutters, fascias and soffits are included.
- Linked models are excluded (v1). Units display in metres.
- Orthographic 3D views start at a random point (only a perspective view's eye is used).
- **Write-back (2026-10-04, not compiled yet):** verify `ExternalEvent.Raise` from the game thread, `WorksharingUtils.GetCheckoutStatus`, `Element.GetDependentElements`, `Room.Level`, and that `PHASE_DEMOLISHED` set on hosts demolishes their inserts.
- Revit stays live during a session: edits made in Revit meanwhile can make requests fail (they are reverted in the game). Undoing an RvtGo edit in Revit is not reflected in the game until relaunch.
- Rooms in linked models are not shown (links are excluded). Unplaced, unbounded and redundant rooms are skipped.
- Gizmo moves are plan-only (no Z). Wall-hosted families (doors, windows, wall-based fittings) are excluded from Gizmo / Clone.
- Clone in place without moving creates an overlapping copy in Revit (the duplicate-instance warning is swallowed).
- More than 9 guns will need a rethink of the number keys (wheel still cycles all).

## 7. Extending

- New guns: derive from `Game/Guns/Gun.cs` (including `DrawIcon`, add a symbol to `GunIcons`), add to `_guns` in `GameSession.Initialise`; the key label `1..n` and the gun bar follow automatically. Guns that need the movement keys override `CapturesInput` / `OnCancel`. Guns that change the model use `Session.SubmitToRevit` with a result callback that reverts on failure.
- New categories: add a line to `Scene/CategoryCatalog.cs` (built-in category names are strings; missing names are skipped per Revit version).
- Keep per-frame code allocation-free: use `GameSession.Text` (`TextBuffer`) for formatted HUD strings.

## 8. Changelog

### 2026-10-04 — QoL: room readout, symbol gun bar, four new guns, Revit write-back

- **Room readout:** rooms captured at extraction; ROOM row in the status panel and a top-centre banner when the room changes.
- **Gun bar:** square symbol slots (procedural icons, `GunIcons.cs`) with key numbers; the selected gun's name sits beside the LMB/RMB hints. `Gun.Key` is now assigned from the slot.
- **Teleport gun (5):** VR-style blink with landing preview, wall-to-floor drop, capsule room check, step-back history.
- **Demolish gun (6):** prime then demolish; phase demolish by default (session phase), T toggles delete; dependants hidden; reverted if Revit refuses.
- **Gizmo gun (7):** lock on to eligible FFE, view-relative WASD move, Q/E rotate, Shift fine, Ctrl snap; RMB commits to Revit, Esc cancels.
- **Clone gun (8):** copy in place straight into the gizmo; RMB creates the copy in Revit, Esc discards.
- **Bridge:** new `Bridge/` folder (`ExternalEvent` + thread-safe queues + failure preprocessor). Third place allowed to touch the Revit API.
- **Engine:** element hiding via degenerate indices, dynamic instances (`uModel` in the scene shader), dynamic picking and collision, generic multi-highlight (`Gun.CollectHighlights`), input capture for guns.
- **Extraction:** `ElementRecord.Movable / MoveBlockReason / Pivot`, `SceneData.Rooms / PhaseId / PhaseName`.
- New sounds (Blink, Prime, Demolish, Grab, Commit) and theme colours for the new guns.

### 2026-10-01 — Doors simplified, global usings

- Removed the door open/close system (`DoorSystem`, leaf extraction heuristic, instanced leaf rendering, door shader, door sound). Doors now render as modelled and are always no-clip.
- `GlobalUsings.cs`: added `global using System.IO;` (local duplicates removed) and the alias `global using ElementRecord = RvtGo.Scene.ElementRecord;` for disambiguation.

### 2026-10-01 — v1 (first full pass)

- Forked the RevitAddin template as **RvtGo** (renamed, fresh GUIDs, example commands/icons removed, unsafe code enabled).
- Ribbon: RvtGo tab → Walkthrough panel → **Go** (`Cmd_Launch`, icon + tooltip by naming convention).
- WPF launch options dialog per the mockup (category groups with per-category ticks, heavy services, triangle limit + proxy/skip, colour, step height, MSAA, FOV, sensitivity, invert Y, VSync, load comments) with persisted settings.
- Geometry extraction to an immutable snapshot (colours, metadata, levels, doors, spawn).
- Engine: Win32/WGL window on its own thread, GL loader, batched/culled renderer, MSAA FBO, sky, ground plane, fog, instanced doors, highlight, overlay, font atlas UI.
- Physics: BVH, capsule controller, gravity, jump, crouch, step-up, stair smoothing, fly/no-clip.
- Guns: Scan, Measure (live rubber band, ΔX/ΔY/ΔZ, normal projection), Portal (teleport keeping orientation, FX, sounds), Comment (JSON sidecar, hover, delete).
- HUD (status, minimap plan, context panel, gun bar, help, toasts), Esc pause menu with category toggles and display settings, synthesised waveOut audio.
