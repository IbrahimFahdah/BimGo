# RvtGo — First-Person Revit Walkthrough

RvtGo turns the active Revit model into an FPS-style, first-person walkthrough in its own window. Geometry is snapshotted once at launch and rendered by a small custom OpenGL engine (hand-written P/Invoke, no NuGet packages), with collision, gravity, walk-through doors, walkable stairs and four tool guns: **Scan**, **Measure**, **Portal** and **Comment**.

Built from the **Scaffold** `RevitAddin` template (multi-version configurations, ribbon/tooltip/icon conventions). The design brief is `RvtGo_Spec.md` (kept in the RvtGo project); the HUD mockup is the visual reference.

## For AI assistants (e.g. Claude)

1. **Spec first.** `RvtGo_Spec.md` is the brief; this README documents what was built and where it deviates.
2. **Keep this README current**, especially the Changelog and *Known limitations / to verify*.
3. **No dependencies.** The no-NuGet rule is a design goal: GL, WGL, Win32, Raw Input and waveOut are all hand-written P/Invoke. Ask before adding any package.
4. **Threading rule:** only `Commands/` and `Extraction/` touch the Revit API (Revit thread). Everything under `Game/`, `Rendering/`, `Physics/`, `Platform/`, `Audio/`, `Native/` runs on the game thread and must never call the Revit API.
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
| 1–4, mouse wheel | Select gun |
| LMB / RMB | Gun primary / secondary |
| N | Measure gun: toggle normal projection |
| Page Up / Page Down | Teleport up / down one level |
| Tab | Toggle minimap |
| H / Shift+H | Return home / set home |
| X | Clear current gun's markers (Comment gun: press twice to delete all comments) |
| F1 | Toggle controls help |
| F11 | Borderless fullscreen |
| Esc | Pause menu (category toggles, ground plane, colour, MSAA, FOV, sensitivity, VSync…) |

## 4. Project Structure

```
RvtGo/
├── RvtGo.addin / RvtGo.csproj / Application.cs   # Template: manifest, multi-version build, ribbon
├── Commands/Cmds_RvtGo.cs        # Cmd_Launch: options → extraction → start game thread   [Revit thread]
├── Extraction/                    # Revit API → snapshot                                       [Revit thread]
│   ├── CategoryResolver.cs        #   catalog → BuiltInCategory (TryParse, version-safe)
│   └── SceneExtractor.cs          #   tessellation, colours, metadata, levels, spawn
├── Scene/                         # Revit-free shared model
│   ├── CategoryCatalog.cs         #   System / FFE / Services definitions
│   ├── LaunchSettings.cs          #   options + JSON persistence
│   └── SceneData.cs               #   immutable snapshot (vertices, indices, elements, levels)
├── Forms/OptionsWindow.xaml(.cs)  # WPF launch dialog (matches the mockup)
├── Platform/                      # Win32 window, WGL context, message pump, Raw Input      [game thread]
├── Native/                        # Hand-written P/Invoke: Win32, WGL, GL loader, winmm
├── Rendering/                     # Batching/chunks, scene renderer, overlay, UI batch, font atlas, camera
├── Physics/                       # BVH (shared by collision + picking), capsule controller, geometry math
├── Audio/SoundSystem.cs           # Synthesised sounds via waveOut (no assets)
├── Game/                          # GameHost (thread), GameSession (+Render, +Menu), Player, Comments
│   └── Guns/                      #   Scan, Measure, Portal, Comment
├── Extensions/ General/ Utilities/ Resources/   # Template (+ Log_Utils)
```

New top-level folders compared with the template: `Extraction`, `Scene`, `Platform`, `Native`, `Rendering`, `Physics`, `Audio`, `Game`.

## 5. How it works

- **Extraction (Revit thread).** For each ticked category, elements are filtered (no view-specific, secondary design options or demolished elements), tessellated (`Face.Triangulate`, Medium detail), coloured from face materials (category material fallback, transparency → alpha) and converted to metres around a scene origin (median element centre, rounded to whole metres). Winding is matched to Revit's outward normals so back faces can be detected in shaders. FFE/Services elements over the triangle limit become bounding-box proxies (or are skipped).
- **Doors.** Rendered exactly as modelled (no open/close animation) and always no-clip: door elements are excluded from collision so openings stay walkable. They can still be scanned and hidden from the pause menu.
- **Game thread.** Indices are re-ordered into per-category, per-pass (opaque/transparent) batches of spatial chunks; each batch is one `glMultiDrawElements` call over frustum-visible chunks. The scene renders into an off-screen (optionally MSAA) framebuffer, then the minimap and HUD draw on top. Physics runs at a fixed 120 Hz with render interpolation.
- **Physics.** Capsule (r 0.3 m, 1.75 m / 1.2 m crouched) against the static BVH by iterative depenetration; walkable contacts push straight up (no ramp sliding); step-up (default 200 mm), snap-down on stairs, camera smoothing; the ground plane catches falls.
- **Minimap.** A real plan: the scene rendered top-down, clipped 0.3 m below to 1.2 m above the current level; back faces seen from above are drawn as the cut (poché).

## 6. Known limitations / to verify

- **Not compiled yet.** This version was written without access to a .NET SDK or the Revit API assemblies — expect a first round of small build fixes.
- Revit API calls to verify on 2025–2027: `Mesh.DistributionOfNormals` / `GetNormal`, `Element.DemolishedPhaseId`, `Document.IsModelInCloud`, `Level.ProjectElevation` as the geometry-space elevation.
- Stairs: component stairs with runs are skipped in favour of their runs/landings/supports to avoid duplicate geometry — verify on legacy/sketch stairs.
- Railings: top/hand rails are collected as separate categories; check for doubled geometry on some railing types.
- Roof edges / flashings have no dedicated built-in category; gutters, fascias and soffits are included.
- Linked models are excluded (v1). Units display in metres.
- Orthographic 3D views start at a random point (only a perspective view's eye is used).

## 7. Extending

- New guns: derive from `Game/Guns/Gun.cs`, add to `_guns` in `GameSession.Initialise`, and the key `1..n` and the gun bar follow automatically.
- New categories: add a line to `Scene/CategoryCatalog.cs` (built-in category names are strings; missing names are skipped per Revit version).
- Keep per-frame code allocation-free: use `GameSession.Text` (`TextBuffer`) for formatted HUD strings.

## 8. Changelog

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
