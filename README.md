# BimGo — First-Person BIM Walkthroughs
[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2FaussieBIMguru%2FBimGo.svg?type=shield)](https://app.fossa.com/projects/git%2Bgithub.com%2FaussieBIMguru%2FBimGo?ref=badge_shield)

> **Try it in your browser:** [ibrahimfahdah.github.io/BimGo](https://ibrahimfahdah.github.io/BimGo/), or [open the sample model directly](https://ibrahimfahdah.github.io/BimGo/?model=/BimGo/samples/BimGo%20Sample%20Pavilion.bimgo). Chrome or Edge recommended; nothing to install.

BimGo (formerly **RvtGo**) turns a Revit model into an FPS-style, first-person walkthrough: collision, gravity, walkable stairs, a room readout and nine tool guns (**Scan**, **Measure**, **Portal**, **Comment**, **Teleport**, **Demolish**, **Gizmo**, **Clone**, **Place**). It renders with its own small OpenGL engine (own renderer, window and input; GL function bindings from Silk.NET). Personal project of Gavin, publisher **Aussie BIM Guru**, **MIT No Attribution (MIT-0)** licence: use it for anything, no credit required, no warranty. Autodesk and Revit are registered trademarks of Autodesk, Inc.; BimGo is an independent project, not affiliated with, sponsored by or endorsed by Autodesk ("for Revit" describes compatibility only).

Two parts (plus the browser viewer of this fork):

- **BimGo for Revit**: a slim add-in (extractor + session bridge, no engine code). **Go** opens the model in the app as a *live session*: Demolish / Gizmo / Clone / Place edits go back into Revit, Scan → R selects in Revit, and changes made in Revit prompt a refresh (F5). **Export .bimgo** writes a standalone file.
- **BimGo** (`BimGo.exe`): joins live sessions, or opens `.bimgo` files without Revit, keeping edits in the file's journal (undo / redo) and later **pushing** them into the Revit model they came from.
- **BimGo Web** (this fork), the same walkthrough in the browser (TypeScript + WebGL2, in `web/`), hosted at **https://ibrahimfahdah.github.io/BimGo/**. It opens `.bimgo` files from your disk (never uploaded), saves them back, and joins live Revit sessions when Go is set to **Open in the browser**. Visitors without a model can press **TRY THE SAMPLE**. See §11.

Edits respect two phases picked in Options: the walkthrough shows the **new** phase, Demolish demolishes **existing** elements in it, new work can only be deleted, and clones / placements are created in the new phase.

## For AI assistants (e.g. Claude)

1. **Read first:** the latest round's handoff and build notes in `ai/<yymmdd>_<round>/` (newest folder last; `0_…` handoff, then numbered build notes), then this README. The README is the source of truth for what is built; §9 lists every round and its folder.
2. **Gavin's working copy is the source of truth.** Ask for a fresh zip (with his compile fixes) before editing. Claude usually can't compile here (no .NET SDK, no Revit API): say so in the build notes and list the APIs to verify.
3. **Keep this README current** (§8: only the open build's *to verify* entry, the standing limitations and the roadmap; once Gavin confirms a build its entry goes, its notes stay in `ai/`; §9 history) and write the round's notes in `ai/`. Zip the repo minus `bin/`, `obj/`, `.vs/`, `artifacts/`.
4. **Code style:** readable and robust over clever; XML doc headers; explicit types where clearer; nullable off. **No per-frame allocations** in the app. **No exceptions reach the user:** log with `Utilities.Log_Utils.Write`, show a toast or dialog; errors use `Toast(…, important: true)` (they show even with the UI hidden).
5. **Dependencies: own what differentiates BimGo, rent commodity plumbing.**
   - Own: renderer, shadows, picking, physics, guns, UI look, `.bimgo` format, journal, Revit bridge, live protocol, window / input (`Platform/`, `Native/Win32.cs`, `Native/Wgl.cs`, `Native/XInput.cs`: Windows' own `xinput1_4.dll`, `Native/Joystick.cs`: its joystick API, no packages), audio, font atlas, the video writer (`Native/MediaFoundation.cs`: Windows' own encoder, no codec package).
   - Rent: OpenGL bindings (Silk.NET behind the `Native/Gl.cs` facade; renderer code calls `Gl.Xxx` with `uint` constants; add new calls as facade wrappers).
   - **BimGo.Revit stays package-free** (it loads inside Revit). Revit API references are HintPaths to the installed Revit.
   - Any new package needs Gavin's explicit yes, a permissive licence, a pinned version and a line in §10. No UI toolkits. Ask before adding folders.
6. **Project boundaries:** **Core** has no Revit, GL or UI code. **App** never references the Revit API. **Revit** is the only project touching the Revit API, only in `Commands/`, `Extraction/`, `Bridge/RevitEditor*.cs` and `Live/LiveDispatcher.cs` (Revit thread); `Live/SessionHost.cs` does file IO only. Nothing changes the Revit model except the user's own edits (and the family library's temporary transaction, which is always rolled back), and, since build C-B2, SHOW IN REVIT's "BimGo clash" 3D view (made once, its section box and camera set; a `BimGo:` transaction).
7. **Edits go through `IModelSource`** (`LiveSessionSource` or `FileEditSource`) via `GameSession.SubmitEdit`; every accepted edit is recorded in the `EditJournal`.
8. **Compatibility:** `.bimgo` `formatVersion` stays 1 and the live protocol stays 1: only additive, optional fields and entries. Settings migrate quietly (`LaunchSettings.Sanitise`).
9. **Tests:** `tests/BimGo.Core.Tests` (MSTest 4: `Assert.ThrowsExactly`, not `ThrowsException`). Run after any Core change.
10. **GLSL check without a GPU:** pull the shader strings out of `Rendering/Shaders.cs`, swap `#version 330 core` for `#version 300 es` + precision lines, compile and link in headless WebGL2 (Playwright + the pre-installed Chromium, SwiftShader); give every sampler its own texture unit in a test.
11. **Revit template conventions:** commands in `Commands/Cmds_<Group>.cs` as `Cmd_<Button>`; extensions in `Extensions/TypeName_Ext.cs`; tooltips and icons resolve from the command's base name (`BimGo_Launch`, `BimGo_Export`).
12. **Name clashes:** WPF, WinForms and Revit `DB` / `UI` are global usings in BimGo.Revit; WinForms + System.Drawing are global in BimGo.App. Avoid unqualified `Color`, `Point`, `Plane`, `View`, `Panel`, `CheckBox`, `TextBox`, `TaskDialog` (use the `DB.`, `UI.`, `SD.`, `Wpf.`, `Win.`, `WinForms` aliases).
13. **Keys are actions** (input round B2): a new key is a new `InputAction` in Core `Scene/InputCatalog.cs` (group, label, kind, default keys; ids are stored in settings, never rename one), read with `input.Pressed / PressedOrRepeated / Down(InputAction.X)`, never `IsPressed('X')` (raw keys are for text boxes only). If it is live somewhere new, update `InputCatalog.Situations` to match `GameSession.UpdateFrame`. Text naming a key comes from `Hotkeys.Label` (toasts) or a cached `KeyHint` (panels drawn every frame). The Core tests then check the defaults for clashes and regenerate README §3.
14. **Big panels use the panel shell** (polish round P-A1, `Game/GameSession.PanelShell.cs`): `BeginPanel` (card, header, right-hand controls) → body with `ScrollRegion`s (`BeginScroll` / `EndScroll`, draw only `VisibleRows`) → `FooterAction`s → `EndPanel` (notice / hint strip, ← BACK · actions · CLOSE, overlays). Spacing comes from the `UiTheme` tokens, not new magic numbers. Esc / B / ← BACK go one level back through `PanelBack`; a sub-view closes in the panel's own `CloseXxx()` before the panel does. Anything drawn inside a scroll region is clipped (`UiBatch.PushClip`) and `Hover` ignores the clipped part.
15. **Docks, HUD columns and gamepad focus** (polish round P-A2): cursor-mode panels are docks in the right-hand column: `BeginDock` (sized to its content, header + `DockHeaderButton`s) → `BeginDockBody` / `EndDockBody` (a `ScrollRegion`; no `return` between them without the clip popping) → `EndDock` (notice, ← BACK / hint / CLOSE, returns `DOCK_*`); set the dock's click-blocking rectangle from `DockFrame.Rect`; dialogs run after `EndDock`. The left HUD column is `BuildInfoColumn` (status, coordinates, legends that collapse, F1). Every `Hover` call is a gamepad focus target: pass `focus: false` for panels, viewports, tracks and canvases; a new slider-like control registers its anchor with `RegisterFocus`; a new tab row calls `TakePadTabStep`.
16. **Default keys and F1 rows** (polish round P-B): changing a default (or adding an action with one) raises `InputCatalog.DEFAULTS_VERSION` and adds rows to `InputCatalog.DefaultsChanges` (`ControlsTests.DefaultsChanges_MatchTheDefaults` checks the table against the frozen version-0 snapshot); users then get the one-time toast and NEW / CHANGED tags. Every `InputSituation` has its F1 rows (`HelpEntry`, most used first, at most 16, only actions live there: tested) and a `SIT_` name; a new situation also goes in `GameSession.CurrentSituation()` (`GameSession.Gamepad.cs`), which mirrors `UpdateFrame`. Gamepad chords: A or B with LB / RB held is a chord (the cursor's click waits), so LB / RB + face buttons are safe in the cursor modes.

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
6. **BimGo Web:** open https://ibrahimfahdah.github.io/BimGo/ in Chrome or Edge and open (or drop) a `.bimgo`, or press **TRY THE SAMPLE**. For a live session, tick **Open in the browser** in Go's Options dialog (used automatically when `BimGo.exe` isn't installed). To build the web viewer yourself: `cd web`, `npm install`, `npm run dev` (§11).

## 3. Controls

Every key, mouse button and wheel notch is an **action** in one catalogue (Core `Scene/InputCatalog.cs`: `InputAction`, its group, label and default keys); code asks for actions, never raw keys (only text boxes read typed characters). **Esc → CONTROLS** rebinds them: up to three keys per action, Shift / Ctrl / Alt combinations, LMB / RMB / MMB / Mouse 4 / Mouse 5 and the wheel; a key already used where the action also works asks before it **swaps**; search, RESET / RESET ALL, EXPORT / IMPORT a keymap file (JSON). Changes are saved at once in `settings.json` (`KeyBindings`: only what differs from the defaults). F1 help and the hints in panels show the keys as bound; **the F1 sheet is generated for what you are doing** (polish round P-B: walking with each gun, holding an element, each editor, clash mode…; the situation's title, about 12–16 rows, a gamepad column while one is connected, then "Esc → CONTROLS"). **Changed defaults** (P-B, settings `ControlsDefaultsVersion`): after an update that changes default keys a one-time toast says how many (and any clash with your own keys), CONTROLS tags those rows NEW / CHANGED for that run (search "new" or "changed"), and RESET ALL lists what it will put back before CONFIRM. **Gamepad** (build B, a secondary input; nothing changes without one): an Xbox-style controller through XInput, its own column in CONTROLS (one binding per action; LB / RB combine with other buttons, e.g. LB + D-pad), move on the left stick and look on the right by default (SWAP STICKS), the right stick's click opens the gun wheel, Start is the menu; in menus and editors the look stick moves the cursor, A clicks and B goes back. **Generic controllers** (build B2-C: pads XInput doesn't see, e.g. "Generic USB Joystick") are read through Windows' joystick API: CONTROLS → **MAP BUTTONS…** asks for each Xbox-style button in turn (SKIP for ones the pad lacks; without Start, LB + RB together open the menu). **F1 help is off by default** (a small "F1: Help" note sits bottom left). **Gun wheel:** hold MMB, move towards a gun, let go (let go in the middle: no change); on the gamepad click, point, A picks. A binding with no modifiers also fires with extra modifiers held (Shift+Space still jumps while running) unless another binding live at the same time uses the same key with those modifiers (Shift+H sets home instead of going home).

The tables below are generated from the defaults by the Core tests (`ControlsTests.Readme_ControlsTablesAreCurrent` rewrites them when the catalogue changes): change `InputCatalog`, not the tables.

<!-- controls:begin (generated from the action map's defaults by tests/BimGo.Core.Tests/ControlsTests.cs: edit InputCatalog, not this table) -->

**General**

| Action | Keys | Gamepad |
|---|---|---|
| Help on / off | `F1` | `LB+Back` |
| Fullscreen | `F11` |  |
| Screenshot | `F12` |  |
| Hide / show the UI | `U` |  |
| Minimap | `Tab` | `Back` |
| Refresh from Revit (live) | `F5` |  |
| Save | `Ctrl+S` |  |
| Save as | `Ctrl+Shift+S` |  |
| Undo (files) | `Ctrl+Z` |  |
| Redo (files) | `Ctrl+Y` · `Ctrl+Shift+Z` |  |

**Movement**

| Action | Keys | Gamepad |
|---|---|---|
| Move forward | `W` · `↑` | `LS ↑` |
| Move back | `S` · `↓` | `LS ↓` |
| Move left | `A` · `←` | `LS ←` |
| Move right | `D` · `→` | `LS →` |
| Jump (flying: up) | `Space` | `A` |
| Run (hold) | `Shift` | `LS click` |
| Crouch (flying: down) | `Ctrl` | `B` |
| Fly / walk (no-clip) | `V` | `Y` |
| Level up | `PgUp` | `D-pad ↑` |
| Level down | `PgDn` | `D-pad ↓` |
| Go home | `H` | `LB+D-pad ←` |
| Set home here | `Shift+H` |  |
| Find room | `Ctrl+F` |  |
| Look up |  | `RS ↑` |
| Look down |  | `RS ↓` |
| Look left |  | `RS ←` |
| Look right |  | `RS →` |

**Guns**

| Action | Keys | Gamepad |
|---|---|---|
| Gun 1: Scan | `1` |  |
| Gun 2: Measure (again: next mode) | `2` |  |
| Gun 3: Portal | `3` |  |
| Gun 4: Comment | `4` |  |
| Gun 5: Teleport | `5` |  |
| Gun 6: Demolish | `6` |  |
| Gun 7: Gizmo | `7` |  |
| Gun 8: Clone | `8` |  |
| Gun 9: Place | `9` |  |
| Previous gun | `Shift+Wheel up` |  |
| Next gun | `Shift+Wheel down` |  |
| Gun mode: previous (Measure, Demolish) | `Wheel up` |  |
| Gun mode: next (Measure, Demolish) | `Wheel down` |  |
| None: no gun (again, or a gun key, arms) | `0` | `RB+B` |
| Gun primary (fire) | `LMB` | `RT` |
| Gun secondary | `RMB` | `LT` |
| Clear this gun's markers | `X` | `RB+X` |
| Gun wheel (mouse: hold, steer, release; gamepad: click, steer, A / click again picks, B cancels) | `MMB` | `RS click` |

**Views and tools**

| Action | Keys | Gamepad |
|---|---|---|
| Bookmark this view | `B` | `LB+A` |
| Go to bookmark 1 | `Shift+1` |  |
| Go to bookmark 2 | `Shift+2` |  |
| Go to bookmark 3 | `Shift+3` |  |
| Go to bookmark 4 | `Shift+4` |  |
| Go to bookmark 5 | `Shift+5` |  |
| Go to bookmark 6 | `Shift+6` |  |
| Go to bookmark 7 | `Shift+7` |  |
| Go to bookmark 8 | `Shift+8` |  |
| Go to bookmark 9 | `Shift+9` |  |
| Coordinate readout | `L` | `LB+D-pad →` |
| Artificial lights | `K` | `LB+D-pad ↓` |
| Shadows on / off | `O` | `LB+D-pad ↑` |
| Sun panel | `Shift+O` | `RB+D-pad →` |
| Sun time −5 min | `[` | `D-pad ←` |
| Sun time −1 min | `Shift+[` |  |
| Sun time +5 min | `]` | `D-pad →` |
| Sun time +1 min | `Shift+]` |  |
| Sun / daylight study | `J` | `RB+D-pad ←` |
| Photo mode | `M` | `RB+D-pad ↑` |
| Section box editor | `P` | `RB+D-pad ↓` |
| Cut at the aimed surface | `Shift+P` |  |
| Clear all cuts | `Ctrl+P` |  |
| Clash mode on / off (docked clash list) | `Y` | `RB+Back` |
| Grids panel (also in clash mode) | `Shift+G` | `LB+B` |
| Grids: off / level underfoot / all levels (also in clash mode) | `C` | `LB+Y` |
| Colour profile on / off (also in clash mode) | `Shift+C` | `RB+Y` |
| Media panel: photo, tour, camera paths, video | `Shift+M` |  |
| Camera path editor in 3D on / off | `Shift+K` |  |

**Scan gun** While the gun is selected (walking keys still work).

| Action | Keys | Gamepad |
|---|---|---|
| Select in Revit (live) | `R` |  |
| Hide the target | `I` | `X` |
| Isolate its category (again: show all) | `Shift+I` | `LB+X` |

**Measure gun** While the gun is selected (walking keys still work).

| Action | Keys | Gamepad |
|---|---|---|
| Normal projection (distance mode) | `N` | `X` |

**Comment gun** While the gun is selected (walking keys still work).

| Action | Keys | Gamepad |
|---|---|---|
| Edit the hovered comment | `E` | `X` |

**Demolish gun** While the gun is selected (walking keys still work).

| Action | Keys | Gamepad |
|---|---|---|
| Demolish / delete mode | `T` | `X` |

**Gizmo, Clone and Place guns** While the gun is selected (walking keys still work).

| Action | Keys | Gamepad |
|---|---|---|
| Snap on / off | `G` | `LB+X` |
| Drop onto the surface below | `F` | `X` |

**Holding an element** While the Gizmo, Clone or Place gun holds an element: the move keys move it (left / right turn it in rotate mode), gun secondary commits, Esc cancels.

| Action | Keys | Gamepad |
|---|---|---|
| Move it up | `E` | `D-pad ↑` |
| Move it down | `Q` | `D-pad ↓` |
| Move ↔ rotate | `R` | `Y` |
| Smaller snap step | `Z` | `D-pad ←` |
| Larger snap step | `X` | `D-pad →` |
| Fine moves (hold) | `Shift` | `RS click` |
| Flip snapping (hold) | `Ctrl` | `LS click` |

**Markup editor** After a comment's picture is taken. Text typing keeps Enter / Backspace / Esc.

| Action | Keys | Gamepad |
|---|---|---|
| Arrow | `A` |  |
| Box | `R` |  |
| Ellipse | `E` |  |
| Pen | `P` |  |
| Text | `T` |  |
| Colour 1 | `1` |  |
| Colour 2 | `2` |  |
| Colour 3 | `3` |  |
| Colour 4 | `4` |  |
| Colour 5 | `5` |  |
| Undo | `Ctrl+Z` |  |
| Redo | `Ctrl+Y` · `Ctrl+Shift+Z` |  |
| Save the markup | `Enter` |  |

**Section box editor** The section box key or Esc closes it; clear all cuts still works.

| Action | Keys | Gamepad |
|---|---|---|
| Drag a handle without snapping (hold) | `Shift` |  |

**Photo mode** The photo mode key or Esc closes it; the sun time keys work.

| Action | Keys | Gamepad |
|---|---|---|
| Take the photo | `Enter` | `RT` |
| Field of view (photo mode) | `Wheel up` · `Wheel down` |  |

**Sun panel** Shadows / sun panel or Esc closes it; the sun time keys work.

| Action | Keys | Gamepad |
|---|---|---|
| Play / pause the day | `Space` | `Y` |

**Bookmark tour and camera paths** While a bookmark tour or a camera path plays (Esc stops it).

| Action | Keys | Gamepad |
|---|---|---|
| Pause / play | `Space` | `A` |
| Next stop | `→` · `PgDn` · `LMB` | `D-pad →` |
| Previous stop (or this stop's start) | `←` · `PgUp` · `RMB` | `D-pad ←` |

**Clash mode** Clash detection's docked list (the clash mode key or Esc leaves): the move keys fly, run speeds up, RMB-drag looks, the wheel scrolls the list.

| Action | Keys | Gamepad |
|---|---|---|
| Next clash | `.` | `D-pad →` |
| Previous clash | `,` | `D-pad ←` |
| Go to the current clash again (re-frame) | `Enter` | `Y` |
| Status: new | `1` |  |
| Status: active | `2` |  |
| Status: reviewed | `3` |  |
| Status: approved | `4` |  |
| Status: resolved | `5` |  |
| Show in Revit: the pair selected in a clash 3D view (live) | `R` | `X` |
| Fly up (hold) | `Space` · `E` | `RT` |
| Fly down (hold) | `Ctrl` · `Q` | `LT` |
| Model view: ghost / wireframe / real / hidden | `G` | `D-pad ↑` |
| Section box on / off (on: around the current clash) | `B` | `D-pad ↓` |
| Select all shown clashes (focus on them all) / clear | `Ctrl+A` | `RB+X` |
| Row pictures on / off | `P` | `Back` |
| Group the selected clashes | `Ctrl+G` | `RB+A` |
| Ungroup the picked group / take the selected clashes out of their groups | `Ctrl+Shift+G` | `RB+B` |
| Pick points: click dots or rows to pick, then group them (again or Esc leaves) | `K` |  |
| Status: next (new → active → reviewed → approved → resolved) |  | `LB+A` |

**Pause menu** While the pause menu shows (not in its panels).

| Action | Keys | Gamepad |
|---|---|---|
| Options preview: the scene with the graphics settings only (again or Esc returns) | `Tab` | `Y` |

**Path editor (Round K)** The 3D camera path editor (the path editor key, or MEDIA → PATHS → EDIT IN 3D; Esc leaves): free cursor, RMB-drag looks, click a key or a handle, drag the handles; the scrubber at the bottom drives the camera.

| Action | Keys | Gamepad |
|---|---|---|
| Add a key at this view (on the path: inserted there) | `K` | `X` |
| Delete the selected key | `Del` | `LB+X` |
| Preview the flythrough (play / pause) | `Space` | `Y` |
| Previous key (the camera snaps into it) | `←` | `D-pad ←` |
| Next key (the camera snaps into it) | `→` | `D-pad →` |
| Set the selected key to this view | `Enter` | `RB+Y` |
| Fly forward | `W` | `LS ↑` |
| Fly back | `S` | `LS ↓` |
| Fly left | `A` | `LS ←` |
| Fly right | `D` | `LS →` |
| Fly up (hold) | `E` | `RT` |
| Fly down (hold) | `Q` | `LT` |
| Fly faster · drag a handle without snapping (hold) | `Shift` | `LS click` |
| Undo the last path change | `Ctrl+Z` |  |

**Fixed (not rebindable)** Text boxes also keep Enter, Tab, Backspace, ↑ / ↓, Ctrl+V and Esc. Gamepad in menus and editors: the look stick moves the cursor, the move stick scrolls (menus) or looks (editors); over menus and docks the D-pad moves the focus ring and LB / RB tapped alone switch tabs; A with LB / RB held is a chord, not a click.

| Action | Keys | Gamepad |
|---|---|---|
| Pause menu · back · cancel · stop | `Esc` | `Start` |
| Close the window | `Alt+F4` |  |
| Menus, panels, handles, markup | `LMB` |  |
| Look around (drag; photo, section box, study) | `RMB` |  |
| Finer slider and stepper changes (hold) | `Shift` |  |
| Open a file (start screen) | `Ctrl+O` |  |
| Gamepad: click where the cursor is (menus, panels, editors) |  | `A` |
| Gamepad: back (menus, panels, editors) |  | `B` |

<!-- controls:end -->

**Notes** (hand-written)

- **Mouse:** move the mouse to look (click the window to capture it); menus, panels and handles use the left button.
- **Measure (2 again):** cycles Distance → Area → Angle → Clearance; RMB removes the last measurement, X clears them all.
- **Moving an element (Gizmo / Clone / Place locked on):** the move keys move it in plan (left / right turn it in rotate mode), snap steps 5 mm–1 m and 1°–90°; drop / lift lands on the first surface below the bottom centre of its box; gun secondary (RMB) commits, Esc cancels. With the Gizmo gun, aiming + the drop key drops and commits at once.
- **Media (Shift+M or Esc → MEDIA; K-A):** tabs PHOTO · TOUR · PATHS · VIDEO. **Bookmark tour:** BOOKMARKS → PLAY TOUR (its settings: MEDIA → TOUR). **Camera paths:** MEDIA → PATHS → NEW PATH, then fly to each place, Shift+M → ADD KEY HERE; PLAY PATH plays it like the tour (Space / ← → / Esc). **Path editor (Shift+K, K-B):** fly with WASD / E / Q, K adds, ← / → snap into keys, Enter sets, drag the handles, scrub at the bottom, Space previews, Ctrl+Z undoes, Esc leaves. **K-C:** MEDIA → TOUR → *Smooth* plays the tour as a spline, CONVERT TO PATH copies it into a path; PHOTO AT THIS KEY / PHOTOS OF ALL KEYS (PATHS, and the editor's dock). **Walkthrough video:** MEDIA → VIDEO (source: the tour or a path) → RECORD VIDEO (the window shows progress; Esc / CANCEL stops and deletes the partial file).
- **Section box (P):** free cursor; drag face handles (Shift = no snap); P / Esc closes, the cut stays. Shift+P cuts just behind the aimed surface; Ctrl+P clears all cuts.
- **Clash detection:** dormant until first used. **Esc → CLASHES** manages it (TESTS: tick for RUN ALL, name, hard / clearance, set A / B or itself, tolerance, RUN, REVIEW, duplicate, delete; SETS: rules with values picked from the model; EXPORT / IMPORT TESTS… or SETS… to files, with link / level reconciliation on import). **Y** toggles **clash mode**: the clash list docks on the right, the cursor is free, the move keys fly (Space / E up, Ctrl / Q down), RMB-drag looks; a row, `.` / `,` or Enter goes to a clash (section box, pair red / green, the rest ghosted); 1–5 set the status; G cycles the rest of the model (ghost / wireframe / real / hidden); B switches the section box off / on (the choice sticks from clash to clash); R shows the clash in Revit (the pair selected in a "BimGo clash" 3D view with the section box); PICTURES switches the row pictures; Ctrl+click / Shift+click select several clashes (shown together; 1–5, R and TO COMMENT act on them all); TO COMMENT / UPDATE COMMENT / N TO COMMENTS turn the selected clashes into comments (and so BCF); MARKUP or a row's pencil marks up a clash's comment picture; TESTS… opens the CLASHES panel; REPORT… exports / imports the clash report; Y or Esc leaves (flying stays, the clash section box goes). Rules use IS, IS ONE OF, IS NOT, IS NOT ANY OF, CONTAINS, DOES NOT CONTAIN ("not" rules always take elements out); re-running tests with results and RESET RESULTS / RESET ALL ask first.
- **Photo mode (M):** free cursor; RMB-drag looks, wheel = field of view, Enter = take; M / Esc closes. **Sun / daylight study (J):** free cursor, the player stands still; RMB-drag looks, clicks pick surfaces.
- **Hide the UI (U):** errors still show and every control keeps working; Esc or U brings it back. **Esc** also cancels a gizmo, closes a panel and shows the UI again.
- **Undo / redo** work in files only (live: undo in Revit, then F5). **Screenshots** go to `Pictures\BimGo`. **L** cycles the coordinate readout off → shared → project → internal.
- The start screen opens files with Ctrl+O (fixed).

### Guns

| # | Gun | LMB | RMB | Live (Revit) | File |
|---|---|---|---|---|---|
| 1 | Scan | Lock target | Clear | Info + extra parameters; R selects in Revit | Same (no R) |
| 2 | Measure (2 again: mode) | Distance: start / end · Area: corners (first corner closes) · Angle: arm, vertex, arm · Clearance: floor to ceiling here | Close the area / cancel / remove last | | Same |
| 3 | Portal | Blue portal | Red portal | | Same |
| 4 | Comment | Place + type (view + picture saved) | Remove marker | Model folder | In the file |
| 5 | Teleport | Blink to marker | Step back | | Same |
| 6 | Demolish | Prime / demolish | Un-prime | Demolish in new phase (T: delete) | Journal `hide` (hosted inserts too) |
| 7 | Gizmo | Lock on (FFE) | Commit | Moves / rotates in Revit | Journal `transform` |
| 8 | Clone | Clone in place | Commit | Copies in Revit | Journal `clone` |
| 9 | Place | Family library | Commit (not holding: place the last type again) | Places the type in Revit | Journal `place` |

**Pause menu** (review tools round: two button stacks and two settings columns when the window is wide enough, so it fits a 720 px high window; narrower windows stack them): **session** stack RESUME, RETURN HOME, SET HOME HERE, SAVE / SAVE AS / PUSH TO REVIT (files) or SAVE AS .BIMGO (live), **CONTROLS** (input round B2: every key, rebindable), END SESSION at the bottom; **review** stack COMMENTS (issues: thumbnail, status, priority, assignee, replies; level and status filters; OPEN for the detail view and thread, **MARKUP…** on its picture; EXPORT BCF (the comments shown), IMPORT BCF, BCF COORDS), BOOKMARKS (thumbnails, GO / RENAME / SET HERE / reorder / DELETE; **TOUR SETTINGS** (→ MEDIA → TOUR) and **PLAY TOUR**), **MEDIA** (K-A: photo, tour, camera paths, video), TEXTURES (Realistic mode with missing images), FIND ROOM, SUN HOURS STUDY, **FAMILY LIBRARY** (when the snapshot has one), **CATEGORIES & LINKS** (the category cards and linked-model toggles, now their own panel; a * on the label when anything is switched off), SHOW ALL (when anything is hidden) (W-A: CLEAR MARKERS removed: the clear key clears the active gun's markers; it never deletes comments). Settings: QUALITY PROFILE, **EYE HEIGHT** (Standing / Seated / Child, − / + for the selected preset's height), **UNITS** (Metric / Imperial, decimal feet), and beside them the tabs **Display** (ground, colour mode, AA, FOV, mouse, VSync, invert Y, FPS, AO) · **Reflections** (Off / Some / All, source Sky / Probes / Probes HQ, strength, probe status, REFRESH) · **Debug** (colours Off / Reflection / Probes).

**Markup editor** (after a comment's picture is taken, or MARKUP… in its detail view): ARROW / BOX / ELLIPSE / PEN / TEXT (A R E P T), five colours (1–5), THIN / MEDIUM / THICK, UNDO / REDO (Ctrl+Z / Ctrl+Y), CLEAR; drag on the picture to draw, TEXT: click, type, Enter; SAVE (Enter) or CANCEL / SKIP (Esc).

**Sun panel (Shift+O):** the location line with **CHANGE…** (location override: search a city or paste lat, long; UTC offset − / +; RESET TO THE REVIT MODEL'S LOCATION), shadows and quality (Low / Medium / High, per machine), time slider with play, month / day, +1 h DST (DST AUTO when an overridden place's time zone decides), sun height / bearing, sunlight / sky / shadow / glass sliders, artificial lights mode with Light / Bloom sliders, RESET LIGHTING. Site from Revit's Location; start time from the launch view's sun settings.

**Coordinate readout (L):** *Shared* = survey E / N / elevation (as Revit spot coordinates); *Project* = relative to the project base point on project-north axes; *Internal* = Revit internal metres.

## 4. Project structure

```
src/
├── BimGo.Core/          # net8.0: no Revit, no GL, no UI
│   ├── Scene/           #   SceneData, CategoryCatalog, LaunchSettings, QualityProfiles, ModelInfo, LinkInfo, SiteCoordinates,
│   │                    #   SolarPosition, SunHours, LightingData, MaterialData, TextureSearch, ProxyCatalog, TextureOverrides, FamilyLibrary,
│   │                    #   Units (metric / imperial text), MeasureMath (area, angle, triangulation),
│   │                    #   InputCatalog (every action + default keys), KeyChord, KeyMap (bindings, clashes, keymap files),
│   │                    #   AppearanceProfiles (colour round A: profiles, palettes, AppearanceProfiler evaluation),
│   │                    #   TourTimeline, CameraPathTimeline (K-A: ITourTimeline, spline, arc length, heading)
│   ├── Clashes/         #   Round C: ClashModels (sets, tests, clashes, runs), SearchSets (rules, starter tests), ClashGeometry,
│   │                    #   ClashEngine (broad / narrow phase, worker), ClashTree, ClashMerge (across runs), ClashFiles (storage, report),
│   │                    #   ClashSetupFiles (tests / sets files), ClashGroups (C-C1: groups, ClashGrouping by element)
│   ├── Edits/           #   EditRequest / EditResult (EditOp), EditJournal + JournalEntry (JournalOps)
│   ├── Sources/         #   IModelSource, FileEditSource
│   ├── Live/            #   protocol, ILiveChannel, FolderChannel, SocketChannel + SocketServer (browser link), LiveSidecars,
│   │                    #   LiveSessions, LiveSessionSource, JournalPush
│   ├── Format/          #   BimGoFormat, BimGoReader / Writer, DTOs, BimGoDocument, sidecars, ModelFolders, CameraPathModels (K-A)
│   └── Utilities/
├── BimGo.App/           # BimGo.exe and the engine
│   ├── Program.cs · Shell/        # entry, single instance, home screen, open / recent, inbox, file association
│   ├── Game/            #   GameSession (+Render, +Menu, +Edits, +Document, +Live, +Push, +Comments, +Bookmarks, +Thumbnails,
│   │                    #   +Coordinates, +Sun, +Lights, +Textures, +Reflections, +Profiles, +Visibility, +Screenshot, +Library,
│   │                    #   +Rooms (Find room), +SunHours, +Tour, +EyeHeight, +Video, +Location, +Markup, +Geometry,
│   │                    #   +Controls (CONTROLS panel, key capture), +Hints (text naming keys), +Gamepad, +GunWheel,
│   │                    #   +Overlays (panel dropdowns and in-panel confirms), +ColourProfiles (state, Shift+C, legend),
│   │                    #   +ColourProfilesPanel (COLOUR PROFILES), +PanelShell (panel shell, scroll regions, docks, window-size check),
│   │                    #   +PadFocus (gamepad focus ring, D-pad navigation, LB / RB tabs), +Media (K-A: MEDIA panel), +Paths
│   │                    #   (K-A: camera paths tab, playback), +PathEditor (K-B: the 3D path editor), +KeyPhotos (K-C: key photos)), SunHoursStudy, CommentStore, BookmarkStore, PathStore, VideoRecorder, UnitFormat
│   ├── Game/Clashes/    #   GameSession.Clashes (dormant switch-on, items as walked, runs, reports), GameSession.ClashPanel (CLASHES)
│   │                    #   ClashMode (GO, view, Revit), ClashDock (docked list), ClashPictures (row pictures, clash → comments),
│   │                    #   ClashSelection (several clashes at once), ClashSetup (tests / sets files), ClashGroups (C-C1:
│   │                    #   group rows, right-click menu, group card, group comments)
│   ├── Game/Guns/       #   Gun base, Scan, Measure, Portal, Comment, Teleport, Hammer (Demolish), Gizmo (+GizmoController,
│   │                    #   GizmoPanel), Clone, Place, GunIcons
│   ├── Rendering/       #   SceneRenderer (+Profile: element stream, profile texture, ghost pass), SceneBatches, ShadowMaps, LightShadows, ScreenEffects (AO + bloom), ArtificialLighting,
│   │                    #   SunLighting, MaterialTextures, ProxyPack, ReflectionProbes, Shaders, UI (UiBatch, fonts), Overlay3D
│   ├── Physics/         #   Bvh (static), DynamicSet (moved / cloned / placed instances), CharacterController
│   └── Platform/ (+Hotkeys: the app's key map, KeyHint, Gamepad) Native/ (+MediaFoundation: MP4 writer, +XInput) Audio/ Resources/ (icon, CC0 proxy textures, places.tsv)
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
                         #   sidecars, model folders, lighting, materials, texture search, profiles, family library, review tools,
                         #   controls (default clashes, modifier rule, swap, keymap files; regenerates README §3)
ai/                      # per-round handoffs and build notes (§9)
web/                     # BimGo Web (fork): TypeScript + WebGL2 port of BimGo.App, deployed to GitHub Pages (§11)
├── src/core/            #   format (reader / writer), edits, scene, live (protocol, WebSocket client), sources
├── src/engine/ src/game/ #  renderer, physics, UI; walkthrough session, guns, menus
├── src/platform/ src/shell/ # input, files, audio, settings; home screen and app shell
├── public/              #   proxy pack, samples/BimGo Sample Pavilion.bimgo (generated by scripts/make-sample.mjs)
└── tests/               #   Vitest
.github/workflows/pages.yml  # lint, test, build and deploy web/ on every push to the web branch
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
- **Grids and levels (grids round A).** The extractor reads the host's grids and the extracted links' grids (`SceneExtractor.Grids.cs`: `Grid.Curve` tessellated, `MultiSegmentGrid` segments chained by `GridLayout.Chain`, `Grid.GetExtents` for the vertical extent) and each level's *Building Story*. The app draws them with `GridOverlay` (one static buffer; the vertex shader faces each segment to the eye at a constant pixel width; the fragment shader cuts a world-metre dash-dot and goes solid where it would shimmer) on the levels `GridLayout.ShownLevels` picks, plus 2D bubbles / level tags; the GRIDS & LEVELS panel (Shift+G) and C drive it, in walking and clash mode; saved in `visibility.json`. Build B adds the intersections (`GridNodes`: ring dots, hover labels, click / Teleport to go there, Measure snaps), solid or dash-dot lines, minimap grids and `GridLocator` (a clash's nearest intersection and storey: clash card, reports, AUTO GROUP by grid, optionally clash comments).
- **Colour profiles** (colour round A; Core `Scene/AppearanceProfiles.cs`, App `GameSession.ColourProfiles` / `.ColourProfilesPanel`, `SceneRenderer.Profile`). Named profiles saved per model (`visibility.json` → `appearance`), like Navisworks' appearance profiler. **By value:** a field (BimGo / Revit category, family, type, level, model, phase) or an **extracted parameter** (Revit Options → Parameters: instance value, else the type's, as display text) → one row per value found (palette colour, editable; elements without the parameter are "(no value)"); F5 / open adds rows for new values and keeps edited ones. **By search set:** a row per clash detection search set, first match wins. Rows can be switched off (their elements fall through). **Others:** ghosted (the clash view's grey glass), normal colours or one flat colour. **Surface detail** (0–100 %, default 35 %) keeps that much of the texture / material shade under the colour; lighting, shadows and reflections stay; works over Whitecard, Material and Realistic. **Rendering:** each vertex carries its element index (attribute 6, a float stream made the first time a profile shows: 4 bytes a vertex); one RGBA8 texel per element (1024 a row, unit 15: rgb colour, a = 0 normal / 1 ghost / 2 hidden (reserved) / 255 coloured) is fetched in the vertex shader, so a new profile rewrites that texture only. Ghosted elements are discarded in the normal passes and the AO pre-pass, and drawn by a ghost pass (opaque + glass ranges, 12 % grey glass) before the glass pass; the minimap draws them pale. Probes capture without the profile; highlights and the clash view's ghost / wireframe views ignore it (the real model view shows it). **Search sets** gained **Phase** and **Parameter** rules (one field entry per extracted parameter: "PARAMETER: Fire Rating"; values picked from the model with counts). **Shift+C** shows / hides the active profile (walking and clash mode); the **legend** (left, under the status / coordinate panels) lists rows with counts and the others' look. **Build B:** by value can colour **number ranges** (equal bins, 2–12, from the lowest to the highest number; the first number in each text, units ignored: "1 200 mm" → 1200, "60/60/60" → 60; ramps Blue → red, Green → red, Cool → warm, Light → dark); rows can be **see-through** (0–90 %: codes 128–254, drawn with the ghosts in the blended pass, left out of AO and caps) or **hidden** (code 2: the session hides them as the Scan gun does: drawing, shadows, picking, collision, only while the profile shows); search set rules gained **AT LEAST / AT MOST / BETWEEN** (typed numbers, same parsing); the legend can go into **photos and screenshots** (*In photos*, screen-sized, bottom left; not in 360s); **EXPORT… / IMPORT…** profile files (`bimgo-colour-profiles` JSON: profiles + the sets by-set ones use; sets matched by name on import, missing ones added). Link values that share a model title read as their instance names. Ghosted elements get no section caps (build A fix). **P-C:** ranges cut by EQUAL WIDTH / EQUAL COUNT (quantiles) / CUSTOM breaks (BREAKS…: "300; 450; 600"; `Binning`, `Breaks`); section caps take the element's profile colour; the legend scales with 2–4× stills; moved / cloned copies of hidden rows hide too (no shadows); imported profile files match links / levels by name and report the misses; a bookmark keeps the profile showing.
- **Sky, water and grass** (sky / grass / water rounds). Procedural **clouds** (cover, drift), sun size and glare in the sun panel's SKY tab (`sun.json`; a look only, reflected by glass and probes). **Water:** keyword or asset water ripples (strength, speed, wave size), colour presets / custom and reflection strength (Appearance → *Water ›*). **Grass blades** (Realistic) on upward surfaces whose material matches a grass keyword: a top-down grass field (Core `GrassField`, built on a worker thread; surfaces 2 cm–300 mm above remove it) drives instanced clumps around the eye (near / far rings, sway, sun-lit, cut by the section). P-C: the field follows hidden / demolished / moved / cloned / placed elements (rebuilt once a change settles) and probes capture blades. Appearance → *Grass blades ›*: density, height, distance, sway, keywords.
- **Reflections (Realistic). `ReflectivityReader` reads each material's reflection strength and roughness from its appearance (schema rules; the only keywords: "mirror" → mirror, see-through "water" → water). Shine rounds to 25 % tiers and reflects at the threshold (Some = 50 %+, All = 25 %+); metals tint their reflection; glass uses Revit's reflectivity (×2.5, 10–50 %); water gets travelling ripples and a sun glint (water round W: ripple strength 0–200 % scales the waves, 0 skips them; ripple speed 0–200 % runs the ripples' own clock, so a speed change doesn't jump them; wave size 25–400 % stretches the wavelengths, strength unchanged; grass sway 0–200 % scales the blades' wind).
- **Reflection probes** (`ReflectionProbes`). One per room holding a reflective surface (a grid every ~8 m in rooms over 12 m), fallback probes for reflective surfaces outside rooms; six 90° faces each in one mipmapped RGBA8 array (128 px, HQ 256 px; ≤ 64 probes / 64 MB); progressive bake (2 faces per frame, nearest first), re-baked a second after the sun, lights, colour mode or the model change. Lookup: a plan grid (0.5 m cells × 0.5 m bands) names up to two probes per cell with a blend weight. Since the probe-leak fixes (§9, next round): every room claims its cells (the room whose floor is nearest below the cell centre wins, so slabs belong to the room above); cells take their own room's probe (a room without a probe shows the sky, never a neighbour's); probes blend only across **open** boundaries (a short ray at the band's height crosses no wall, doors and movable furniture ignored, or the gap is inside a door's box); the shader looks the cell up 0.75 cell (≥ 0.3 m) off the surface along its viewer-facing normal, so walls, glass, floors and ceilings read the room they face. All of it happens once when the grid is built: no per-frame cost. The log reports grid size, cell size and open / closed boundary counts.
- **Family library** (`SceneExtractor.Library`, `GameSession.Library`, `PlaceGun`). With Options → Geometry → *Family library* ticked, Go and F5 also send the loadable family types loaded in the model in the ticked FFE / services categories (in-place families excluded; at most *N*, default 200, types already used first), each with Revit's preview (`GetPreviewImage`, 128 px PNG). **Level-based** and **work-plane / face-based** types also get geometry (`FamilyPlacer`: work-plane types are hosted on the level's plane, else a sketch plane of the level): one temporary instance each on the lowest level in a single transaction that is **always rolled back**, extracted like any element (materials, glow, light), then stored as a hidden **template** element after every model element, 2 km below the model. Wall-hosted and other types are listed greyed with the reason. The app never draws, picks or collides templates; the pause menu's FAMILY LIBRARY panel (search, category chips, family list, preview cards) hands a type to the **Place gun**, which clones its template in front of the player (dropped onto the surface below) in the gizmo's move mode. RMB commits: live → `edit` with op `place` (Revit: `FamilyPlacer` on the level at or below the point, moved exactly onto it, rotated, new phase; registered under the clone key so later moves target it); file → journal `place` (`typeUniqueId`, pivot, angle, `newCloneKey`; replay clones the template again). Push places it the same way. Files saved from a live session keep the library (so placements replay); Export .bimgo never includes it.
- **Drop to surface (F).** One ray straight down from the bottom centre of the held element's box (starting up to 0.3 m above its base, so an element sunk into a floor is lifted), against the visible static scene and the other dynamic instances (never itself), up to 10 m; the first hit wins, so things land on desks and benches. Gizmo / Clone / Place keep it uncommitted (RMB commits as a normal move); the Gizmo gun's aim + F commits at once. Snapping leaves the dropped height alone until E / Q.
- **Comments as issues.** Each comment keeps its text, author, marker and level plus a **status** (Open / In progress / Closed), **priority** (Low / Normal / High), **assignee** (free text), a **reply thread**, the **viewpoint** it was made from (feet, yaw, pitch, fly) and a **thumbnail** of that view (192 × 108 JPEG, taken the frame after, from the 3D view only, sharing the bookmark capture). GO returns to the saved view (older comments: in front of the marker). The detail view (OPEN) edits status / priority / assignee, adds and deletes replies, SET VIEW HERE retakes view and picture, EDIT TEXT. Markers are coloured by status (closed: green, fainter); the hover label shows the issue line. (Comment CSV export was removed in `261010a`: BCF replaces it.) All fields are optional: older comments read as open, normal, unassigned.
- **BCF** (COMMENTS panel; `GameSession.Bcf`, Core `BcfFile`, `BcfMapping`, `IfcGuid`). **Export** (plain BCF 2.1 `.bcf` with `extensions.xsd` and PNG snapshots, laid out like buildingSMART's 2.1 test cases; `.bcfzip` still opens): the comments the panel shows (filters on All = every comment); one topic per comment (GUID = the comment id; title = first line, description = full text; status Open / In Progress / Closed; priority Low / Normal / High; assignee; dates and authors; replies as BCF comments), a perspective viewpoint from the saved view (eye = feet + 1.6 m; vertical field of view of a 16:9 picture from the walkthrough's horizontal one, clamped to BCF 2.1's 45–60°; older comments: a spot looking at the marker), the commented element as a component (IFC GUID + Revit ElementId) and the comment's picture as the snapshot. Viewpoints are written in **shared** (default), project or internal coordinates (the panel's BCF COORDS button; remembered; falls back to internal when the model lacks them). **Import** (2.0 / 2.1 / 3.0): a topic whose GUID matches a comment is **merged** (status, priority, assignee take the file's values; replies it doesn't have are added; text, marker, view and picture stay; nothing is deleted); other topics become comments: the view from the viewpoint (walking when a floor is just under the feet, else flying), the marker where the view's centre ray meets the model (else on the selected element, else 2 m ahead), the element (IFC GUID, else ElementId), the level, and thumbnail + picture from the snapshot. Status and priority words from other tools map generously (resolved / done → closed, active / assigned → in progress, critical / major → high, minor → low). One save at the end; the notice reports new / updated / unchanged / skipped.
- **Comment pictures.** New comments (and SET VIEW HERE) also keep a larger picture (≤ 1280 px wide, JPEG) for BCF snapshots: `comments/<id>.jpg` inside a `.bimgo`, or in the `comments` folder beside `comments.json` in the model folder (only there; unused pictures are removed on save). Older comments export their thumbnail. Comments also record the element's UniqueId.
- **IFC GUIDs.** Extraction records each element's IFC GUID (the stored `IfcGUID` parameter when valid, else `ExportUtils.GetExportId` compressed, as Revit's IFC exporter does). Older files have none (BCF then names elements by ElementId only).
- **Section box and plane** (section box round; `GameSession.Section`, `SceneRenderer.Section`, Core `SectionCut`). A cut is an axis-aligned **box** and / or one free **plane** (normal towards the cut-away side), Revit internal metres. **P** opens the editor: the first time the box fits the level you stand on (model footprint ± 1 m, level − 1 m to the next level − 0.4 m); face handles (cyan dots, the plane's amber) drag along their axis in 0.05 m steps (Shift free), box ≥ 0.2 m; the panel switches BOX / PLANE, fits LEVEL / ROOM / MODEL, sets the **cap colour** (one flat colour: swatch, CHANGE… opens the Windows colour picker, RESET = dark grey #3D4045; remembered in settings as `SectionCapColour`) and CLEAR ALL. **Shift+P**: a plane parallel to the aimed surface, 5 cm behind the aimed element (the view ray is followed through it), removing your side. **Ctrl+P** clears. Rendering: the scene and AO pre-pass fragment shaders discard what the planes remove (`CLIP_GLSL`, ≤ 7 planes); **caps** by stencil per plane whose cut-away side holds the eye: the opaque scene cut by that plane alone into the stencil (INVERT), then the cap polygon (the box face, or a large square on the plane, cut by the other planes) where it is odd, depth-tested, in the flat cap colour. Shadows, light shadows, probes, the minimap and the ground ignore the cut (the whole building still casts); **picking and the guns skip** cut geometry (rays carry on through it), **collision doesn't**. Saved with the model (`visibility.json` `section`), stored in **bookmarks** and **comment views** (GO restores it; an empty cut clears; older ones leave the cut alone), exported as **BCF clipping planes** (location + direction towards the clipped side) and imported back (six axis planes → a box, else the first plane). The scene target now has a depth + stencil buffer.
- **Photo mode** (M; `GameSession.Photo`, `SceneRenderer.Photo`, Core `Panorama`). A clean frame (only the photo panel and an optional thirds grid; markers, highlights and gizmos off), player still. **Still**: the view rendered off-screen at 1–4× the window in **one pass** (AO, bloom, shadows and caps as in the preview; reduced to the GPU's renderbuffer limit), 4× MSAA when pixels × samples ≤ 40 M (else 2× or none), PNG or JPEG (92). **360°**: six 96° views from the eye (front centred on the view heading, left, back, right, up, down; `FpsCamera.SetCustomView`), stitched on a worker (per pixel: equirectangular direction → the view facing it → bilinear read through that view's projection, `Parallel.For`) into a 2:1 JPEG (4096 or 8192 wide) with **Photo Sphere (GPano) XMP** so phones, Facebook and panorama viewers treat it as a 360 photo. **Exposure** −3 to +3 EV (a DST_COLOR blend over the finished scene, preview and photo alike), field of view (stills), sun time (shadows on). Files: `Pictures\BimGo\<model> photo <size | 360 4K/8K> <time>.png/.jpg`; OPEN FOLDER selects the last one. The camera and the window's targets are restored after a shot (the next frame re-sizes the effect buffers). **P-C:** "Grid lines in the photo" (when grids are on; widths scaled on 2–4× stills).
- **Find room** (Ctrl+F / pause menu). Every room (host and linked) with number, name, level and area; search by any of them (an exact number goes first; Enter takes the first match). GO stands the player on a clear floor spot nearest the room's middle (≥ 0.45 m from its walls, capsule checked), facing across it.
- **Study modes** (daylight round; segmented at the top of the J panel): **Sun hours** (below), **Daylight %** and **Lux** (`GameSession.Daylight`, `SunHoursStudy.StepDaylight`, Core `Daylight`). Daylight modes select the room's **floor** at a **0.7 m work plane** (editable 0–2 m; walls can be clicked in). Per cell, 128 / 256 / 512 cosine-weighted rays (Hammersley) over its hemisphere are binned into 192 sky patches (8 × 11.25° bands × 24 × 15°): sky (× 0.7 glass transmittance when glass is in the way), ground below the horizon (reflectance 0.2), outside surfaces (one bounce, 0.2), or the cell's own room (left to the internally reflected component). **Daylight factor:** CIE overcast sky scaled to a unit horizontal illuminance; DF = sky + ground + outside + the room's **BRE split-flux IRC** (0.85 W / (A (1 − R)) · (39 Rfw + 5 Rcw); W = see-through triangles in the room's walls or over it, halved; A from the room boundary and height; reflectances from the colours of its floor, walls and ceiling, or standard 0.2 / 0.5 / 0.7, the panel's Reflectance choice). Legend 0–5 %+. **Illuminance:** per time sample (the sun hours day, range and step), the CIE clear sky scaled to the IES clear-sky diffuse horizontal illuminance (800 + 15 500 √sin α lux) plus, with Direct sun on, the sun (127 500 e^(−0.21 / sin α) lux × cos × glass) by one ray; the room's sky IRC; and the sun bounce (direct sun landing on the room's floor cells, split-flux). Cells show the average lux (legend 0–2000+) and keep the share of samples at or above the lux target. Room figures go in the summary (one room) and the CSV. Results are **early design indicators**, labelled as such (no validated interreflection, no frame / maintenance factors).
- **Sun hours study** (J / pause menu; `GameSession.SunHours`, `SunHoursStudy`, Core `SunHours`). The player stands still, the cursor is free, RMB-drag looks. Surfaces: the walls and floors of the room you stand in (wall / floor categories, grouped by element and plane; cells kept inside the room, walls within 6 cm of its boundary on the side facing in), plus any surface you click (clipped to the room it faces; click again to remove). Grid: square cells (0.1 / 0.25 / 0.5 / 1 m, default 0.25) in each face's plane, at the floor offset (floors, 0–2 m) or wall offset (walls, 0–1 m) + 2 cm; ≤ 80 000 cells. Run: sun positions every 5 / 10 / 15 min (sample mid-step) over the chosen day and time range (default 21 June 9:00–15:00; DST tick) from the site location and true north (`SolarPosition`); per cell one ray per sample in front of the surface against the visible static scene and moved / placed elements, glass passing unless "glass blocks sun" (the BVH's per-triangle transparent flag); 10 ms per frame on the game thread with a progress bar and CANCEL. Cells coloured on Ladybug's legend 0–7+ h; summary: average, min, max, share ≥ 2 h and ≥ 3 h. Results stay until CLEAR (also with the panel closed); EXPORT CSV (settings, target + one row per cell, Revit internal metres, Pass column with a target) and SCREENSHOT (3D view + legend, `Pictures\BimGo\<model> sun hours <time>.png`). **Wall faces** of the room count when they lie up to 0.4 m inside its boundary or 3 cm outside (rooms bounded at wall finishes or wall centres both work; the far face of a partition doesn't), tested on the side that leads deeper into the room. **PASS / FAIL** (a toggle, general: no regional presets): on, cells colour **pass (green) / fail (red)** against the mode's target (sun hours ≥ 2 h by default, 0.5–12 h; daylight factor ≥ 2 %, 0.5–10 %; illuminance ≥ 300 lux for ≥ 50 % of the time samples), the legend shows the passing and failing area shares and the summary the pass share; off, cells show their values on the legend. **Saved studies:** SAVE STUDY… (name; the same name replaces) writes the settings, surfaces (element + plane + room), every cell's point and hours to `sun-studies\<name>.json` in the model folder (live: the session's model folder; files: the folder their provenance points to: cloud ids, else the model path); SAVED STUDIES… lists them (LOAD, DELETE twice). LOAD finds the surfaces again and lays the grid; when every cell lands where it was saved (2 cm) the results show, otherwise the surfaces stay selected and it asks for a new RUN.
- **Bookmark tour** (tour round; `GameSession.Tour`, Core `TourTimeline`). BOOKMARKS → PLAY TOUR plays the ticked bookmarks in list order. **Fade** (default): each stop fades in (0.6 s, 0–2 s), holds (4 s, 1–30 s) and fades out; the stop changes at black. **Glide**: the first stop fades in, the last fades out, and the camera flies between stops (at least the set time, 1–15 s; longer for far stops, ≤ 4 m/s, ≤ 30 s), easing position, eye height, yaw (the short way) and pitch. **Swivel** (default on, 30° left): a slow eased pan over the visible stop (fade) or the hold (glide). Each bookmark can override the hold and swivel (TOUR / OFF / LEFT / RIGHT, ± 15°) or be left out; tour-wide settings (transition, fade / glide, hold, swivel, **Show the UI**, **Loop**) are saved with the bookmarks. Each stop applies what its bookmark kept (sun time, section cut, hidden categories / links / elements, eye height); a part it didn't keep uses the walkthrough's state from the tour's start. Nothing is recorded as a change during the tour, and the player, sun, cut, visibility, eye height and UI state go back when it ends or Esc stops it (also before a save on the way out). UI off (default): a clean view with only important toasts; UI on: status, coordinates, minimap, room banner and a tour bar (stop, name, progress with stop ticks). A key hint shows for the first 4 s and while paused. Losing focus doesn't pause the tour. The player is moved with the camera (minimap and readouts follow); physics, guns and highlights are off while it plays. The timing is pure Core maths so build A2 can record the same tour to video at a fixed frame rate. **P-C:** the sun blends between stops (over a glide; half / half across a fade); a crouched bookmark films from the crouched eye; a stop's colour profile shows during the tour (put back at the end).
- **Walkthrough video** (tour round, build A2; `GameSession.Video`, `VideoRecorder`, `Native/MediaFoundation.cs` `Mp4Writer`). TOUR SETTINGS → RECORD VIDEO (K-A: MEDIA → VIDEO, TOUR or PATHS) plays the tour or a camera path off-screen at a fixed rate (the tour clock steps 1 / fps per frame; as many frames as fit in ~45 ms per window frame), so the video is smooth on any PC. Per frame: `RenderScene(..., photo: true)` at the video size (MSAA as the window, within the photo sample budget), resolved; with **Show the UI** the HUD (status, coordinates, minimap with its plan, tour bar; no toasts, FPS, help or room banner) is drawn at the video's height by a second UI batch at a matching scale; the fade is drawn over it; read back (bottom-up BGRA) into one of three pooled buffers and encoded on a worker. Encoding: Windows Media Foundation's sink writer, H.264 High profile in MP4, ~0.2 bits per pixel (4–80 Mb/s), hardware encoder first, software encoder if refused; RGB32 frames (flipped to top-down) converted by the sink writer. Sizes **Window** (rounded to even) / **1080p** (default) / **4K** (refused above the GPU's renderbuffer limit), **30** (default) / **60 fps** (per-machine settings). Output `Videos\BimGo\<model> tour <date time>.mp4` (K-A: `<model> path <name> <date time>.mp4`); afterwards MEDIA → VIDEO opens with the result and **OPEN FOLDER**. The window shows the frames as they come (letterboxed) with progress, frames, time left and CANCEL (Esc); cancelling or a failure deletes the partial file; closing the window mid-recording cancels it. Missing Media Foundation (Windows N without the Media Feature Pack) is reported.
- **Media panel and camera paths** (Round K-A; `GameSession.Media`, `GameSession.Paths`, `PathStore`, Core `CameraPathModels`, `CameraPathTimeline`). **MEDIA** (pause menu, or Shift+M) on the panel shell, tabs **PHOTO** (photo mode's settings + OPEN PHOTO MODE; M still goes straight there) · **TOUR** (the tour settings and per-stop overrides, moved from BOOKMARKS) · **PATHS** · **VIDEO** (source: the tour or a path; size and rate, moved from the tour settings). **Paths**: a list on the left (NEW PATH, rename, duplicate, reorder, delete); the selected path's strip (speed 0.2–30 m/s, smoothness 0–100 %, heading *follow path* / *key views*, look-ahead 0.5–20 m, fade 0–2 s, level horizon, loop, show UI, then keys · length · time); its keys (ADD KEY HERE: the view you left, after the selected key) and the selected key's fields (SET TO THIS VIEW, GO TO (fly there to adjust it), reorder, duplicate, delete, hold 0–60 s, own speed / smoothness (× back to the path's), ease auto / on / off, heading path / follow / own view / look at (SET TARGET: the aimed surface, else 10 m ahead), sun time (USE THE SUN NOW, ±30 min), colour profile (leave / none / a profile)). **Timeline** (pure Core, so video records it): centripetal Catmull-Rom through the keys as Hermite segments, each key's tangent scaled by its smoothness (0: a sharp corner); constant speed along the curve (per-segment arc-length table by Simpson's rule, two Newton steps); a smoothstep velocity ramp (≈ speed / 1.5 m/s², 0.4–4 s) where a key eases (holds, the ends unless looping, or set on); a short segment reaches a lower top speed; fades at the ends; a loop closes with a last segment and has no fades. **Heading**: following looks at the point the look-ahead ahead on the path (so it turns before a corner; the horizon level unless unticked); a key with its own view or a look-at target takes over near itself (blending over the half segment each side; between two such keys over the whole segment). **Playback**: the tour player (`ITourTimeline`: a tour or a path), with its save / restore, keys (Space, ← / →: keys, Esc), HUD bar ("PATH · KEY n / m", the path's name) and video; the sun animates (a key without a sun takes one between its keyed neighbours by time; segments blend), a key's colour profile shows from it on. Saved in `paths.json` (inside the `.bimgo`, or in the live model folder).
- **3D path editor** (Round K-B; `GameSession.PathEditor`). Shift+K or MEDIA → PATHS → EDIT IN 3D; like clash mode (dock on the right, free cursor, RMB-drag looks) with its own fly keys (WASD, E / Q, Shift faster: ← / → pick keys). Drawn (depth-tested, faint through walls): the path sampled every 0.25 m (≤ 4,000 samples) in cyan, **red** where a sample gap hits visible static geometry (rays when the path rests; the dock counts the segments), chevrons every ~2 m, keys as dots with numbers and short view lines, look-at lines and targets, a green dot where K inserts. **K**: at the scrubber's spot (exactly, with its heading), else within 1 m of the path into that segment, else after the selected key; **Del** deletes; **← / →** snap the camera into the previous / next key; **Enter / SET** writes the view (a banner says when you've moved off it); a click picks a key or a target. **Handles** on the selected key or its target: X / Y / Z arrows (the mouse ray's closest approach to the axis; 5 cm steps, Shift free) and a view handle on the key (where the ray meets a sphere round it; 5° steps); saved when the drag ends. PICK THE TARGET then a click sets a look-at target. **Scrubber** (bottom; keys as ticks): dragging puts the camera on the path (position and heading); **Space** / PLAY previews from there (loops for a looping path); the player waits while it moves the camera. **Undo** (Ctrl+Z): snapshots before each change, 40 per session. The dock also edits hold, speed, smoothness, ease and heading; MEDIA opens the panel over the editor; DONE / Esc / Shift+K leaves (still flying).
- **Smooth tour, convert, key photos, sun polish** (Round K-C; `GameSession.Tour` (`TourAsPath`, `ConvertTourToPath`), `GameSession.KeyPhotos`, `GameSession.PathEditor`, Core `SunBlend`). A tour is a path whose keys are the bookmarks: **Smooth** (`TourSettings.smooth` + `smoothSpeed`: a field, not a third `transition`, so older builds read the file and play it as before) builds a `CameraPath` from the ticked stops (key eye = feet + the bookmark's eye height, crouched lower; own view held for the stop's hold with its swivel; the path follows between them, `followBetween`) and plays it through the tour player with the bookmarks as records (sun, cut, hidden items, eye, profile as before). **CONVERT TO PATH** stores the same path ("<model> tour", unique) with each bookmark's sun, profile, cut and hidden items copied onto its key. **Timeline:** `CameraPathPoint.Swivel` pans an own-view key over its hold (smoothstep; leaves from the panned view; 0 without a hold); `CameraPathSettings.FollowBetween` turns out of one own view into following and into the next (segments ≥ 2 × look-ahead; shorter ones turn straight). **Keys** carry an optional `swivel`, `section` and `visibility` (from that key on, like the profile; before any key sets one, the walkthrough's). **Key photos:** PHOTO AT THIS KEY puts the camera at the key's playback view (the pose at the start of its hold), applies its state quietly and opens photo mode; closing restores the walkthrough (and re-enters the editor). PHOTOS OF ALL KEYS plays the path through the tour player (UI hidden), seeks to each key, waits 3 frames, shoots with the PHOTO settings to `<folder>\NN <key>.png|jpg` (a batch waits while 2 photos are still encoding), then restores the walkthrough. **Editor state:** scrubbing / previewing remembers the walkthrough once and shows the key's state and the sun blend (the tour player's `ApplyTourStop` / `BlendTourSun` over the path's records); leaving the path, closing the editor or starting a tour puts it back. The **sun strip** samples the path 96 times (the playback blend, `SolarPosition` altitude → night / dusk / low / high colours), rebuilt with the timeline. **Sun blend:** `SunBlend.Between` moves the date the short way round the year (Dec → Jan through New Year), the clock time straight, daylight saving at halfway.
- **Night sky** (Round W-A; Core `LunarPosition`, `SunSettings` night fields; `SunLighting`, `SkyLook`, `SKY_FS`, `GameSession.Sun` NIGHT tab). The moon's place from Schlyter's low-precision elements with the main perturbations and topocentric parallax (≈ ¼°), its lit fraction from the elongation; a chosen phase (`moonPhase`) turns the light on the disc to that fraction. The sky shader draws the disc (0.0085 rad) shading a sphere normal by the light direction (the phase draws itself), maria by noise, earthshine, a halo. `SunLighting`: below −1° sun altitude the moon (on, up) is the light (`SunDirection`; the real sun stays in `SkySunDirection` for the sky), 0.10 × the sun at full × phase × the slider, fading in to −6°; ambient and sky lifted a little. Stars: two layers of hashed cells on the celestial sphere (scene direction → equatorial by three rows from `LunarPosition.EquatorialToTrueNorth` (sidereal time, latitude) and the model's true north), the 27 neighbouring cells tested, the point size from `fwidth`; Milky Way: a Gaussian band about the galactic pole, brighter to the centre, noise and lanes. Night factor 0 (sun −2°) → 1 (−14°); probes draw no stars.
- **Location override** (tour round, build A2; `GameSession.Location`, Core `Places` (`PlaceIndex`, `TimeZones`), `SolarPosition.EffectiveSite`, `LocationOverride`). Sun panel → CHANGE… opens a picker in the panel: type a city (the bundled `Resources\places.tsv`: ~7,300 Natural Earth populated places with IANA zones, public domain; ranked exact name → name starts with → contains → region / country match, larger places first; accents ignored) or paste coordinates (Ctrl+V; decimal, hemisphere letters or degrees / minutes), which borrow the zone of the nearest listed place within 300 km (else an offset estimated from the longitude). The choice (latitude, longitude, standard offset, IANA zone, name, DST auto) is saved in `sun.json` (`location`) with the model; the sun, shadows, sun hours, Daylight % and Lux all use the effective site (a copy of the model's site with the override; true north and coordinates stay the model's; Revit is never changed). With a zone Windows knows, daylight saving follows the zone for each date (**DST AUTO**; a click switches to the manual tick, AUTO switches back); the study panel shows "Daylight saving: auto". The UTC offset − / + (half hours) makes the offset manual. RESET returns to the Revit site. Finished study results are marked "settings changed".
- **Eye height** (tour round; `GameSession.EyeHeight`, `CharacterController.SetStandingEye`). Presets Standing 1.62 / Seated 1.20 / Child 1.10 m (eye heights, editable 0.9–2.0 m in the pause menu in 5 cm steps and in Options → Player; saved in settings with the preset in use). The capsule follows: standing height = eye + 0.13 m, crouch eye and height scale with it, step-up unchanged. A taller preset is refused under a low ceiling (walking; flying never). The status panel's MODE shows SEATED / CHILD / CUSTOM EYE. **Bookmarks** now also keep the **eye height** and the **hidden categories / links / elements** (not the ground or the section, which has its own field); GO restores both (older bookmarks leave them alone; a height no preset has reads CUSTOM until a preset is picked). **P-C:** bookmarks keep crouching (GO arrives crouched; crouch / jump stands); comment views keep their eye height, and BCF export / import use it (or the current preset).
- **Measure modes** (review tools round; `MeasureGun`, Core `MeasureMath`). Pressing 2 with the Measure gun selected cycles **Distance** (as before, N = normal projection) → **Area** (LMB corners on the plane of the first point: the aim ray meets that plane, so corners can be picked anywhere on screen; clicking the first corner again (14 px) or RMB with three or more corners closes it; ≤ 64 corners; a translucent fill by ear clipping, area + perimeter, live while drawing) → **Angle** (three clicks, the vertex in the middle; 0–180° with an arc) → **Clearance** (from the aimed point, lifted 1 cm off its surface, one ray straight down to the first surface (or the ground plane outside) and one straight up; a surface within 2 cm counts as the point itself, so aiming at a floor reads floor → ceiling; both segments labelled ↓ / ↑, the total in the panel; a live preview follows the crosshair). RMB removes the last measurement of any mode (or cancels / closes the one being made), X clears them all. Measurements stay temporary markers (never saved). The panel shows mode chips, the live or last value and hints.
- **Display units** (review tools round; Core `Units`, App `UnitFormat`). Metric (default) or **imperial**: feet-inches to the nearest 1/8" (5' 7 1/2"), or **decimal feet** (5.63') when ticked; areas in ft². Covers the Measure gun, level / ground readouts, the coordinate readout (survey coordinates always in decimal feet in imperial), study work plane / offsets and grid labels (≈), eye heights, the gizmo's move readout and drop messages, Teleport distances, room areas, glazing areas, bookmark details. Lux, daylight % and sun hours are unchanged; CSV exports stay in Revit internal metres; snap increments stay metric steps. Per machine (`DisplayUnits`, `DecimalFeet`), set in the pause menu (UNITS) or Options → Player.
- **Snapshot markup** (review tools round; `GameSession.Markup`). Opens straight after a comment's picture is taken (a new comment, SET VIEW HERE; SKIP leaves it clean) and from the detail view (MARKUP… on the picture; MARKED UP shows when it has markup). Shapes are kept in picture pixels; committed shapes are drawn with GDI+ into a preview texture (what SAVE writes), the shape being dragged or typed with the UI batch. **SAVE burns** the markup into the comment's picture (same size, JPEG 82) and thumbnail (192 × 108), so the comment list, BCF snapshots and everything else carry it, and keeps the **unmarked original** as `comments/<id>_original.jpg` (`snapshotOriginal`): MARKUP… always starts from the clean picture (shapes aren't kept after the editor closes). Clearing everything and saving puts the original back. A new picture (SET VIEW HERE) drops the old original. Text is bold with a contrasting outline. Comments without a picture (older ones with only a thumbnail) can't be marked up.
- **Input and key bindings** (input round B2, build A; Core `InputCatalog`, `KeyChord`, `KeyMap`; App `Platform/Hotkeys`, `InputState`, `GameSession.Controls`). Every key is an `InputAction` with a group (General, Movement, Guns, Views and tools, each gun, Holding an element, the editors, Fixed), a kind (press, repeat, hold) and up to three default chords (key, mouse button or wheel notch + Shift / Ctrl / Alt). **Situations** (walking with each gun, holding an element, each editor, the tour, recording, the start screen) list what can fire together, mirroring `GameSession.UpdateFrame`: two actions **clash** only when a situation holds both (X clears markers walking and steps the snap while holding an element). `KeyMap` holds the live chords (defaults + `settings.json` `KeyBindings`, which keeps only the changes), answers `Pressed` / `PressedOrRepeated` / `Down` for a frame without allocating, and applies the **modifier rule**: extra modifiers don't stop a binding unless a live binding on the same key needs more of the held modifiers (precomputed "shadow" lists per slot). Mouse buttons share the key arrays under their virtual-key codes (MMB, Mouse 4 / 5 now captured: `WM_MBUTTON*`, `WM_XBUTTON*`); the wheel is two codes of its own. **CONTROLS** (pause menu, session stack): grouped rows with three slots each; click a slot and press the key (Esc or a click elsewhere cancels; LMB binds by clicking the slot again; a lone modifier binds on release), right-click clears; reserved keys (Esc, Windows keys, Print Screen, lock keys, Alt+F4), fixed actions and the wheel on held actions are refused; a clash asks, and SWAP gives the other action(s) the slot's old key (or none when that would clash for them); search by action, group or key; RESET / RESET ALL; EXPORT / IMPORT a keymap file (`bimgo-keymap` JSON, every action; import = defaults + the file, unknown entries skipped and logged, clashes shown in red). Saved at once. Punctuation keys are named from the keyboard layout (`MapVirtualKeyW`). F1 help, the gun bar's numbers and LMB / RMB tags and every hint or toast that names a key read the map (`KeyHint` caches per-frame text until a binding changes).
- **Gamepad and gun wheel** (input round B2, build B; `Native/XInput.cs`, `Platform/Gamepad.cs`, `GameSession.Gamepad`, `GameSession.GunWheel`). XInput (`xinput1_4.dll`, in Windows: no package) is read once a frame in `GameWindow.PumpMessages` (the first connected controller; the slots are scanned every 2 s when none is; all released while the window isn't active). Its buttons, triggers and each stick's four directions are 24 gamepad codes (from 0x200) on `InputState`, with edges and auto-repeat (0.4 s, then every 0.1 s) like keys; sticks pass a radial dead zone (default 24 %) and triggers a threshold (15 %), and both are analog: `KeyMap.Axis` reads 0–1, so movement (`Player`, the gizmo) is analog while keys still read 0 / 1. The gamepad has its own slot per action (`KeyMap.PAD_SLOT`), stored apart from the keys (settings `PadBindings`, keymap files `"pad"`), and LB / RB are modifiers (`KeyModifiers.PadLB / PadRB`): LB + D-pad ↑ shadows D-pad ↑ as Shift+H shadows H. Look actions (`LookUp/Down/Left/Right`, gamepad only by default) turn at up to 3 rad/s × look speed with a squared response; the stick click toggles sprint until movement stops; triggers fire the guns. **Cursor:** in menus, panels and text boxes (`PadCursorMode.Menu`) and the free-cursor editors (`Editor`) the look stick moves the Windows cursor (`SetCursorPos`, so every widget works unchanged), A presses the left button (held: drags), B sends Esc, and the move stick scrolls (menus) or looks (photo, section box, study); off while walking, during tours, videos and key captures. **Focus ring** (P-A2, `GameSession.PadFocus`): the D-pad moves a ring between the controls drawn last frame and puts the cursor on the focused one (A presses it; a focused slider steps with ← →), LB / RB tapped alone switch tabs; in the editors only while the cursor is over a dock; the stick or mouse hides it. **Gun wheel:** `GunWheel` (MMB, gamepad RS click): the mouse holds it open and steers with its raw movement (let go to pick; the middle does nothing), the gamepad toggles it, points with the look stick and picks with A or another click (B / Start / Esc close). Looking pauses while it is open; walking doesn't; nothing fires. Tuning (look speed, invert Y, dead zone, trigger threshold) and SWAP STICKS are in CONTROLS (settings `PadLookSensitivity`, `PadInvertY`, `PadDeadZone`, `PadTriggerThreshold`). F1 help adds two gamepad rows while one is connected; the gun bar shows RT / LT when the gamepad was used last.
- **Generic controllers** (build B2-C; `Native/Joystick.cs`, `Platform/Gamepad.PollGeneric`, Core `GenericPadMap`, `GameSession.PadMapping`). When no XInput controller answers, the joystick ids (`joyGetNumDevs`, ≤ 16) are scanned every 2 s with `joyGetPosEx`; the first that answers is used (name and axis ranges from `joyGetDevCapsW`). Its six axes (−1–1 over the reported ranges), 32 buttons and hat (continuous, hundredths of a degree) go through a `GenericPadMap` (one source per gamepad code: "B3", "POVU", "Y-"; settings `GenericPadMap`, `GenericPadName`; the Xbox-style guess until mapped) into the same 24 gamepad codes, then the same dead zone, trigger threshold, edges and bindings as XInput. Hat diagonals press both directions. Without a mapped Start, LB + RB held together are Start. **MAP BUTTONS** (CONTROLS, shown for a generic controller): the reading when it starts is "at rest"; 20 steps (A B X Y, LB RB, LT RT, the D-pad, each stick up and left (down / right are the same axes reversed), the stick clicks, Back, Start); each waits for the pad to come back to rest, then takes the first button, hat direction or axis (moved over 60 %) that leaves rest; SKIP, CANCEL / Esc; saved at the end. Nothing reaches the actions while mapping.
- **Clash detection** (Round C; Core `Clashes/`, App `Game/Clashes/`; build history and full detail in the `ai/` notes of builds C-A … C-C3 and P-C).
  - **Dormant** until Y or pause menu → CLASHES (a file's `clashes.json` is carried through saves untouched). Then it loads `clashes.json` (in the `.bimgo`, or the model folder for live sessions) or seeds two starter tests (*Structure × Services*, *Services × Services*, hard, ignore ≤ 5 mm).
  - **Search sets:** rules on BimGo / Revit category, family, type, level, phase, model (host / link) and extracted parameters; operators IS / IS ONE OF / CONTAINS / number at least · at most · between add elements, IS NOT / IS NOT ANY OF / DOES NOT CONTAIN take them out (top level); **rule groups** (ANY OF / ALL OF) are conditions of their own and **nest to any depth** (P-C; "GROUP 2.1"), inside a group "not" rules are ordinary conditions.
  - **Tests:** A × B or A × itself, **hard** (crossing deeper than the tolerance, 5 mm) or **clearance** (closer than the distance, 50 mm), on the geometry as walked (moved / cloned / placed included, demolished left out). Sweep and prune over boxes, then triangles in parallel (Möller tri–tri, closest points); hard depth is an estimate (narrowest crossing width; buried corners count). Capped at 10,000 clashes per test; progress + CANCEL.
  - **Across runs** a clash keeps its id by test + element pair: found again → active, missing from a complete run → resolved; reviewed / approved, assignee, notes and comments stay; runs are recorded; "model changed since the last run" shows (nothing re-runs by itself).
  - **CLASHES panel** (pause menu): TESTS (list with counts and **groups** (P-C: a click reviews that group), editor: kind, sets, tolerance, RUN / REVIEW / RESET / DUPLICATE / DELETE, RUN ALL) and SETS (rule editor, element counts, ADD RULE / ADD GROUP); EXPORT / IMPORT TESTS… / SETS… with link / level reconciliation by name.
  - **Clash mode** (Y / REVIEW): flying, a docked list on the right (test · STATUS / LEVEL / SHOW filters · VIEW / BOX / PICTURES · search · SELECT ALL · REPORT… · GROUP / UNGROUP / TOOLS ▾), rows with picture, pair, depth, level, **nearest grid node** (P-C), status. GO flies to a clash with a section box round it (B toggles, sticks) and a view across the elements; G cycles ghost / wireframe / real / hidden; status 1–5 (pad LB+A next), R shows the pair in Revit (live: the "BimGo clash" 3D view); Ctrl / Shift multi-select and SELECT ALL frame them together; status-coloured dots in the view are clickable.
  - **Comments / BCF:** TO COMMENT / UPDATE COMMENT on a clash, a selection or a group (picture as framed, status follows the clash), MARKUP from the row; clash comments export to BCF with both elements.
  - **Groups** (Navisworks style; `ClashGroup.ClashIds` is the truth): one group per clash, stored status (MIXED when members differ), group card, right-click menus (group / add / remove / merge / rename / ungroup), group comments; AUTO by element / level / category pair / grid (± level); tools: GROUP BY BOX… (the section box, FULL HEIGHT, EDIT BOX / RECOLLECT), PICK POINTS (K), CLUSTER AROUND…
  - **Reports:** REPORT… → self-contained HTML (cover, counts, group sections, a card per clash with picture) and Navisworks-style XML; EXPORT / IMPORT BIMGO REPORT (JSON) merges another copy's statuses, notes and groups.
- **Panel shell, docks and gamepad focus** (polish rounds P-A1 / P-A2; `GameSession.PanelShell`, `GameSession.PadFocus`). The big pause-menu panels share one shell (header, clipped scroll regions, ← BACK · actions · CLOSE footer, Esc one level back); cursor-mode panels (sun, study, section box, grids) are docks in a right-hand column; the HUD's left column stacks status, coordinates, legends (collapsing) and F1. With a gamepad the D-pad moves a focus ring over any control, A presses, B goes back, LB / RB tapped alone switch tabs. P-B: the F1 sheet is generated per situation from the catalogue.
- **App shell.** One window alternates between the home screen (live sessions, Open, recent files, drag-and-drop) and walkthroughs; second launches and Revit's requests go through `%LocalAppData%\BimGo\App\inbox\`. **Start screen** (review tools round): each recent file's card shows the `thumbnail.jpg` saved in it (every save renders the current view off-screen at 640 × 360, photo pass: no HUD or markers, stored at 384 × 216; Revit exports and older files show the BimGo mark), title, details, folder, **SHOW IN FOLDER** and **REMOVE FROM LIST** (right-click still removes). The last model walked live (`LastLive.json`) shows greyed under the live sessions when its session isn't running ("open it in Revit and press Go").

## 6. The `.bimgo` format (version 1)

A ZIP (extension masked); JSON camelCase; writes are atomic (`.tmp` then replace); readers load this version and older, refuse newer, and drop damaged optional parts without failing the load.

| Entry | Content |
|---|---|
| `manifest.json` | `format`, `formatVersion`, generator, `kind` (`revit-export` / `session-save` / `save` / `live-snapshot`), title, created / saved, provenance, extraction options (incl. `activeView`), counts |
| `model.json` | origin offset, bounds, site (incl. shared transform, latitude / longitude / time zone, `sunStart`), phases (`phaseId/Name`, `existingPhaseId/Name`, `phaseNote`), spawn, levels (grids round A: `storey: false` when not a building storey), rooms (`link`), categories (catalog keys), `links[]` |
| `elements.json` | per element: id, uniqueId, optional `ifcGuid`, name, category index, family/type, level, hostId, proxy, movable / reason, pivot, `phase`, `link`, bounds, `[start, count]` opaque / transparent index ranges; `library: true` marks a family library template |
| `geometry.bin` | `BGEO` header (version, vertex size 28, counts), `SceneVertex[]`, `uint[]` indices |
| `parameters.json` | optional extra parameters: pooled names / values, per-element rows |
| `comments.json` · `journal.json` | comments (marker, text, author; optional `status`, `priority`, `assignedTo`, `updated` / `updatedBy`, `replies[]`, `view`, `thumbnail`, `elementUniqueId`, `snapshot`, `clashId` (build C-B2: the clash it was made from); same shape in the live model folder) · ordered edits (`hide` + mode, `transform`, `clone`, `place`) |
| `comments/*.jpg` | optional: comment pictures for BCF snapshots, named in `comments.json` (`snapshot`); since the review tools round a marked-up picture's unmarked original (`snapshotOriginal`, `comments/<id>_original.jpg`) |
| `thumbnail.jpg` | optional (review tools round): the view at the last save, 384 × 216 JPEG, for the start screen |
| `bookmarks.json` · `sun.json` · `visibility.json` | optional: bookmarks + home (thumbnails base64 JPEG; `section`, and since the tour round `visibility`, `eyeHeight`, `tourHold`, `tourSwivel`, `tourSkip` per bookmark; `tour` = tour settings: `transition`, `holdSeconds`, `fadeSeconds`, `glideSeconds`, `swivel`, `swivelDegrees`, `swivelDirection`, `showUi`, `loop`; K-C: `smooth` (left out when off), `smoothSpeed` m/s) · sun state (since build A2 optional `location`: `latitude`, `longitude`, `timeZone`, `zoneId`, `autoDaylightSaving`, `name`) · sun state · hidden categories / links / elements, `groundOffset` (m from the default ground) and `section` (box min / max, plane point / normal, internal metres); since grids round A `grids` (the grid view: `levels` off / underfoot / above / below / adjacent / nearest / all, `storeysOnly`, `respectExtents`, `linkGrids`, `bubbles`, `levelTags`, `levelOutlines`, `depth` faint / depth / xray, `colour`, `opacity`, `width`, `labelDistance`; build B: `line` solid / dashdot, `nodes`, `clashComments`; left out at the defaults); colour round A: `appearance` (`profiles`: id, name, `kind` byValue / bySet, `field`, `parameter`, `palette` bright / soft / deep, `unmatched` ghost / normal / flat, `unmatchedColour`, `detail` 0–1, build B: `ranges`, `bins`, `ramp`; `rules` (`value` + `label`, or `setId`, or build B `from` / `to` + `label`; `colour` #RRGGBB, `on`, build B `transparency` 0–0.9, `hidden`); `active`, `on`, `legend`, build B `legendInShots`; left out with no profiles) |
| `paths.json` | optional (Round K-A): camera paths (`version` 1, `paths`: id, name, author, created, `speed` m/s, `smoothness` 0–1, `heading` follow / key / lookAt, `lookAhead` m, `level`, `fadeSeconds`, `showUi`, `loop`, `keys`: id, name, eye `x y z` (Revit internal metres), `yaw`, `pitch`, optional `heading`, `targetX/Y/Z`, `smoothness`, `speed`, `holdSeconds`, `ease`, `sun`, `colourProfile`; K-C: optional `swivel` degrees, `section`, `visibility` per key, `followBetween` per path); also in the live model folder |
| `lighting.json` | optional: glowing vertex runs and fixture lights |
| `materials.json` · `material.bin` · `textures/*` | optional (Realistic): material table (colour, texture, placement, tint, invert, reflection fields…, QOL round: `seeThrough` when see-through at extraction), per-vertex material index + surface coordinate, embedded images |
| `clashes.json` | optional (Round C): clash detection's `ClashDocument` (compact JSON: `format` `bimgo-clashes`, `version` 1, `sets` (id, name, `matchAll`, `rules`: `field` catalog / category / family / type / level / link (colour round A: also `phase` (existing / new / between / unphased) and `parameter` with `parameter` = its name), `op` (colour round B: also `atLeast` / `atMost` / `between`, values typed numbers; older builds read these as "is"), is / isOneOf / isNot / isNotAnyOf / contains / notContains, `values` (a list; the host model and system families are the empty string), plus `contains`, `value` (the first value) and `exclude` kept in step for older builds; a rule without `op` (C-A / C-B1 files) reads its operator from `contains` / `exclude`), `groups` (C-B4, optional, left out when empty: each `matchAll` + `rules` as above; older builds ignore it and read the set's top-level rules only), `tests` (id, name, `kind` hard / clearance, `setA`, `setB` (empty = itself), `tolerance` m, `enabled`, `lastRunUtc`, `lastRunModel`, `lastRunTruncated`), `clashes` (id, `testId`, `a` / `b` (`uniqueId`, `elementId`, `link` = link instance UniqueId, `cloneKey`, `ifcGuid`, category, family / type, level), point `x y z` internal metres, `distance`, `crossing`, `approximate`, `status` new / active / reviewed / approved / resolved, `assignedTo`, `notes`, `commentId`, found / last seen / resolved / updated times, `updatedBy`), `runs`, `groups` (C-C1, optional, left out when none; not the sets' rule `groups`: id, `testId`, `name` (absent = automatic, from `keyElement` and the count), `status`, `assignedTo`, `notes`, `commentId`, `clashIds`, `auto` (`element`; C-C2: `level`, `category`, `levelCategory`; grids round B: `grid`, `gridLevel`), `keyElement` (as `a` / `b`), C-C2 `autoLabel` (absent name: "<label> × N clashes") and `box` (`minX` … `maxZ` internal metres, `fullHeight`: plan only), `createdUtc`, `updated`, `updatedBy`)); carried unparsed until clash detection is switched on |
| `grids.json` | optional (grids round A): `version` 1, `grids` (name, `link` (absent = host), `points` flat x, y scene metres, `bottom` / `top` 3D extent (absent = unknown: every level), `curved`); written when the model has grids |
| `library.json` · `library/*.png` | optional (live sessions): family library entries (`typeId`, `typeUniqueId`, family, type, category key, `placement`, `placeable`, `reason`, `element` = template index or -1, `preview`, `placed`) and `vertexStart` (first template vertex); previews |

Sun settings (`sun.json`) gained the sky look in the sky round: `cloudCover` (0–1, default 0), `cloudSpeed` (0–2, 1), `sunSize` (0.25–2, 1), `sunGlare` (0–2, 1); Round W-A: `moon` (true), `moonPhase` (left out = the real phase; else 0.05–1 lit), `moonLight`, `stars` (true), `starDensity`, `starBrightness`, `starTwinkle`, `milkyWay` (0–2, 1); older readers ignore them.

Clash setup files (QOL round, EXPORT TESTS… / SETS…): readable JSON, `format` `bimgo-clash-tests` or `bimgo-clash-sets`, `version` 1, `modelTitle`, `generator`, `exportedUtc`, `sets` and `tests` (as in `clashes.json`, no run state), `links` (`uniqueId`, `name` of each link the rules name). Never clashes or history.

Settings (`settings.json`) carry the Options and in-app display choices; notable keys: categories, phases, `ActiveViewOnly`, `SkipHelperGeometry`, `LinkedModels`, `ExtractTextures`, `TextureMaxSize`, `RevitTint`, `ProxyMissingTextures`, `TextureSearchFolders`, `ShadowQuality`, `ArtificialLights`, `BloomIntensity`, `ReflectionThreshold`, `ReflectionProbes`, `ProbeResolution`, `QualityProfile`, `SidecarsBesideModel`, `LastOptionsTab`, `FamilyLibrary`, `FamilyLibraryMax`, `BcfCoordinates`, `SectionCapColour`, `EyePreset`, `EyeHeightStanding` / `EyeHeightSeated` / `EyeHeightChild`, `VideoSize`, `VideoFps`, `DisplayUnits` (`Metric` / `Imperial`), `DecimalFeet`, `ClashInstantFly` (Round C-B1), `ClashRowPictures` (build C-B2, default on), `KeyBindings` (input round B2: action id → its keys, only those changed from the defaults), `PadBindings` (build B: action id → its gamepad binding, changes only), `PadLookSensitivity`, `PadInvertY`, `PadDeadZone`, `PadTriggerThreshold`, `GenericPadMap`, `GenericPadName` (build B2-C), `WaterFromAsset`, `WaterKeywords`, `WaterKeywordsOpaque`, `GlassKeywords` (QOL round), `GrassKeywords` (sky round; default grass, lawn, turf), `GrassBlades` (on), `GrassDensity` (0–2, 1), `GrassHeightMm` (30–400, 120), `GrassDistance` (15–80 m, 40), `WaterColour` (#RRGGBB or empty = the material's), `WaterReflection` (0–1, 1) (grass round), `WaterRipple`, `WaterRippleSpeed`, `GrassSway` (0–2, 1), `WaterWaveScale` (0.25–4, 1) (water round W).

Model folders (`%LocalAppData%\BimGo\Models\<title>_<hash>\`) also hold `paths.json` (K-A: camera paths; mirrored beside the model as `<model>.bimgo-paths.json` when sharing is on), `clashes.json` (Round C: the same document; mirrored beside the model as `<model>.bimgo-clashes.json` when sharing is on), `comments\<id>.jpg` (comment pictures; `<id>_original.jpg` beside a marked-up one) and `sun-studies\<name>.json` (saved sun hours studies). The app also keeps `%LocalAppData%\BimGo\LastLive.json` (the last model walked live, for the start screen).

## 7. The live session protocol (version 1)

| Direction | Type | Payload |
|---|---|---|
| app → Revit | `hello` / `detach` | pid, version / none |
| Revit → app | `hello.ack` | title, Revit version, new and existing phase |
| app → Revit | `edit` | `EditRequest`: ticket, op (`phaseDemolish` / `delete` / `transform` / `copy` / `place`), ElementId or clone key, `newCloneKey`, pivot, translation, angle, label; `place` adds `typeUniqueId`, `typeId` |
| Revit → app | `edit.result` | ticket, success, message, affected ids, new id, clone key |
| app → Revit | `extract.request` | reason |
| Revit → app | `extract.ready` / `extract.failed` | snapshot path, number, counts, seconds / message |
| app → Revit | `select.elements` | ElementIds; optional `linked[]` (link instance + element); optional (C-B2) `hosts[]` (host elements joining a linked selection) and `clashView` (SHOW IN REVIT: `name`, `sectionBox`, min / max, eye, direction; Revit internal metres) |
| Revit → app | `select.result` · `model.changed` · `session.closing` | success / counts / reason |
| app → Revit | `journal.apply` | dry run, tolerance, apply conflicts, model key, phase names, file name, known clones, entries (or `payloadPath`) |
| Revit → app | `journal.result` | per entry: `applied` / `skipped` / `conflict` / `failed` / `alreadyApplied`, message, new id; totals, undo label |

**Browser transport (BimGo Web, additive to protocol 1).** The same envelopes travel over a WebSocket to a loopback server in the add-in (`SocketServer`, one per Revit, `127.0.0.1:47800` or the next free port): `ws://127.0.0.1:<port>/live/<sessionId>?token=…`, and the snapshot is downloaded from `GET /snapshot/<sessionId>/<n>` with the token in `X-BimGo-Token`. Only the viewer's origin (`WebViewerUrl`) and `localhost:5173` may connect; the Host header must be the loopback address; each session has a one-time 32-byte token, passed to the viewer in the launch URL's fragment (`?live=127.0.0.1:<port>&session=<id>#token=…`). Additions: `hello.ack` gains `snapshotNumber`, `snapshotUrl` and `sidecars`; `extract.ready` gains `snapshotUrl`; new `sidecar.read` / `sidecar.data` / `sidecar.write` / `sidecar.result` (`kind` = `comments` / `bookmarks` / `sun` / `visibility` / `clashes`, `document` = the same JSON as inside a `.bimgo`) let the browser keep the sidecars beside the model through the add-in. The add-in sends every message on both channels; whichever client is attached answers.

Envelope: `protocol`, `id`, `seq`, `sessionId`, `type`, `replyTo`, `sentUtc`, `payload`; files `<utc>-<seq>-<type>.json` (`.tmp` then rename), read by a watcher + 1 s poll, validated (session, protocol, 4 MB cap), de-duplicated and deleted. Additive messages / ops: an older add-in ignores `journal.apply` and can't read `place` (the app times out with a hint to update).

## 8. Known limitations / to verify

Every build up to K-C is built and confirmed by Gavin; their notes stay in `ai/` (§9 lists the folders). Only the open build is listed here.

**Round W, build W-A (`261018i_Night_WA`), to verify:** not compiled here (no .NET SDK): build, then the Core tests (+4 in `NightSkyTests`). Sky shader compiled, linked and rendered in headless WebGL2; moon maths checked in a Python port against the 2024 eclipse and quarters. No new keys. *In:* the **moon** (its real place and phase for the date, time and site; a disc lit on the sun side, maria, earthshine, halo; **Phase**: Actual, or Full / Gibbous / Half / Crescent drawn as moon icons); **moonlight** (with the sun 1° down the moon lights the scene and casts the shadows, cool and dim by phase, fading in to −6°; Moonlight 0–200 %); **stars** turning with the sidereal time round the pole at the site's latitude (density, brightness, twinkle) and a **Milky Way** band; moonlit clouds; sun panel tab **NIGHT** (saved in `sun.json`); CLEAR MARKERS left the pause menu and X with the Comment gun no longer deletes every comment. *Not in (W-B):* rain. *Check:* `ai/261018i_Night_WA/1_build notes.md`.

### Standing limitations
- **BimGo Web:** Chrome and Edge are the targets; Firefox and Safari are best effort (no folder search, Save downloads a copy, and Safari may block the live link). Chrome / Edge ask once to allow access to devices on the local network before a live session connects. Not in the browser yet: pushing a saved `.bimgo`'s edits into Revit (use the app), the add-in-served fallback viewer, MSAA, offline use (PWA). The live link was tested against a stand-in for Revit (built on the real server code); check it in Revit 2025–2027. The default `WebViewerUrl` points at this fork's Pages site (change it in `LaunchSettings` for another host).
- Undo / redo are file-only (live: undo in Revit, then F5). Refresh is a full re-extract. Show in Revit needs the session's model to be Revit's active document. One window walks one model.
- Linked models: top-level instances only; phases matched by name; read-only; their levels don't join PgUp / PgDn.
- Demolish removes hosted elements with their host. Project coordinates ignore the base point's own angle to true north; files from before v5.1 derive shared coordinates in float precision ("≈").
- Push: moves / clones need a location point; no duplicate guard beyond the journal flag (if a push times out, check Revit before pushing again).
- Active view only: plans / sections follow their view range; temporary hide / isolate may not be honoured.
- Rendering: one glass layer for shadows; no cascade blending; light shadows 256 px per face, glass doesn't cast them; AO is screen-space; Realistic has no bump maps or cutouts and world-anchored texture origins. Probes are static captures (box-projected; a room without reflective surfaces reflects the sky). Clouds don't light or shade.
- Grass: not in AO or the minimap; no steep banks (> ~70°); under a roof garden over a lawn the top one wins.
- Family library: level-based and work-plane / face-based types only (wall-hosted listed, not placeable; work-plane types go on the level); ticked FFE / services categories only; Export never includes it.
- Photo: no stereo / VR; very large stills drop MSAA; faint seams possible where 360 views meet; grid bubbles / labels (2D) never appear in photos.
- Section: one free plane (BCF keeps the first of several); caps need closed solids; transparent geometry isn't capped; the minimap shows the uncut plan. Profile-coloured caps colour the surface seen through the cut (a solid inside another takes the nearest one's colour).
- Daylight / sun hours: indicators only; one glass transmittance (0.7); IRC one value per room; clear sky only; sun hours are geometric (no diffuse sky or reflections; a cell is lit or not). Saved studies live in the model folder, not the `.bimgo`.
- BCF: plain 2.1 out (no markup, coloured / hidden components or extensions); first viewpoint only on import; FOV clamped to 45–60°. Comment pictures aren't copied beside the model when sharing is on.
- Video: no sound; probes aren't re-baked while recording; synchronous rendering. Location: city reference points; the zone's current standard offset for every date.
- Tour: a glide flies straight through walls (no path finding); the sun blend switches shadows on / off half way when one stop has them off.
- Camera paths: paths fly through walls (the editor marks them red: visible static geometry only, not moved / cloned elements); undo lasts the session; a speed change at a key that doesn't ease is a step; speeds and look-ahead are metric; keys keep no FOV; an own-view or look-at key blends over half of each neighbouring segment (no blend length yet); a smooth tour's single stop plays as a fade; key photos and the batch use the window's aspect (stills) and the PHOTO settings of the moment; the sun blend's clock time doesn't wrap through midnight.
- Review tools: measurements aren't saved; areas are planar; clearance vertical only. Markup is burned in. Units: snaps, eye-height steps and sun-hours grids stay metric; CSV in metres.
- Clash detection: hard depth is an estimate; an element wholly inside another isn't reported; closed solids assumed; no MEP connectivity; a test keeps its first 10,000 clashes; the wireframe view shows triangle edges; clash pictures have no AO or glow; row pictures live for the session; clash comments' text is set when made; SHOW IN REVIT adds one view ("BimGo clash"); the TOOLS ▾ menu doesn't show K beside PICK POINTS.
- Colour profiles: by-set profiles follow clash detection's sets; quantile ranges merge repeated edges (fewer ranges than asked); a value on a break goes in the lower range.
- Key bindings: three keys per action; text boxes keep their own keys; the menu / dock gamepad navigation (D-pad focus, LB / RB tabs, A / B) is fixed; some actions stay keyboard-only on purpose (set home, find room, save / undo, section plane / clear, sun ±1 min, markup tools). Gamepad: XInput or one mapped generic controller per machine; no vibration or on-screen keyboard.
- UI shell leftovers: photo mode's panel, PUSH TO REVIT and the markup editor aren't on the panel shell; an open dropdown doesn't trap the focus ring.
- Silk.NET may bring a newer `System.Text.Json.dll` beside `BimGo.exe` (behaviour identical).

### Roadmap and future goals
- **Round K, keyframed flythrough:** done (K-A, K-B, K-C).
- **Round W, weather and atmosphere:** W-A (night sky: moon, moonlight, stars, Milky Way) built; **W-B next: rain** (handoff `ai/261018j_Handoff/0_handoff.md`: a cover map from the model so rain stops at roofs; intensity, wind slant with the cloud drift; lens drops now and then outdoors, never in photos / videos; wet look; synthesised rain sound; lightning on / off with a rough frequency).
- **Round X:** sun time-lapse + batch stills (X-A); sequence playback ("4D-lite") and two-way Revit camera sync (X-B).
- Later: find element search, accessibility checks, travel-distance tape, kiosk launch, profile schedule CSV, OpenXR VR, IFC import, occlusion culling / LOD, multiplayer.

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
| 2026-10-07 | BimGo Web (fork, `261007_Web`) | Browser viewer (TypeScript + WebGL2) on GitHub Pages, phases 0–5: read / save `.bimgo`, all guns, sun, AO, lights, Realistic materials, journal, live link over a loopback WebSocket (`SocketServer`, `Open in the browser`); later synced to upstream `803c1ff` (probes, water, hide UI, profiles, issues, Find room, sun hours, library + Place gun) |
| 2026-10-09 | Comments, sun hours (`261009m_Comments_SunHours`) | Comments as issues (status, priority, assignee, replies, saved view + thumbnail), direct sun hours study (J), Find room (Ctrl+F) |
| 2026-10-10 | BCF, sun hours 2 (`261010a_BCF_SunHours`) | Build A: BCF 2.1 export / import of comments (merge by GUID, shared / project / internal viewpoints), comment pictures, IFC GUIDs; sun hours pass / fail, saved studies, wall cells for rooms bounded at wall centres. Build B: study modes daylight factor and illuminance (lux), general PASS / FAIL toggle (regional presets removed) |
| 2026-10-10 | Section box (`261010b_SectionBox`) | Section box + quick plane (P / Shift+P / Ctrl+P), stencil caps in a flat, user-chosen colour, cuts saved with the model, in bookmarks and comment views, and as BCF clipping planes; tools skip cut geometry |
| 2026-10-10 | Photo mode (`261010c_PhotoMode`) | M: clean-frame photo mode, hi-res stills (1–4×, PNG / JPEG), 360° equirectangular panoramas (4K / 8K, Photo Sphere metadata), exposure, field of view |
| 2026-10-10 | Licence | BimGo relicensed MIT → **MIT-0** (no attribution required, same disclaimer); notices gained trademarks, acknowledgements and a licence-review / contact statement |
| 2026-10-11 | Tour, build A1 (`261011a_Tour`) | Bookmark tour (fade / glide, swivel, hold, per-bookmark overrides, UI on / off, loop; Space / ← → / Esc), bookmarks keep eye height and visibility, eye-height presets (standing / seated / child) |
| 2026-10-11 | Video + location, build A2 (`261011b_Video_Location`) | Walkthrough video (RECORD VIDEO: the tour to MP4 / H.264 through Windows Media Foundation, window / 1080p / 4K, 30 / 60 fps, UI on / off, progress + cancel), location override (offline Natural Earth place search, pasted coordinates, IANA zones with automatic daylight saving, saved with the model) |
| 2026-10-11 | Handoff (`261011c_Handoff`) | Plan for rounds B1 → B2 → C → hotkeys → polish → installer |
| 2026-10-11 | Review tools, build B1 (`261011d_Review_Tools`) | Measure modes (distance / area / angle / clearance, 2 cycles), snapshot markup burned into comment pictures (original kept), metric / imperial units, pause menu re-laid out for 720 px (two stacks, CATEGORIES & LINKS panel), start screen thumbnails (`thumbnail.jpg`), last live session card, SHOW IN FOLDER / REMOVE FROM LIST |
| 2026-10-11 | Handoff (`261011e_Handoff`) | Plan for rounds B2 → C → hotkeys → polish → installer |
| 2026-10-12 | Input, build B2-A (`261012a_Input_A`) | Action map: every key an `InputAction` in one Core catalogue (groups, defaults, situations), rebinding in Esc → CONTROLS (three keys per action, modifiers, all mouse buttons and the wheel, clash warning with swap, search, reset, keymap export / import), F1 help and key hints from the map, README §3 generated by the Core tests |
| 2026-10-12 | Input, build B2-B (`261012b_Input_B`) | Gamepad (XInput, Xbox-style; its own column in CONTROLS, LB / RB combinations, analog move and look, sprint toggle, cursor in menus and editors, tuning, swap sticks) and the gun wheel (MMB hold / gamepad RS click); bookmarks moved to Shift+1–9 |
| 2026-10-12 | Input, build B2-C (`261012c_Input_C`) | Generic (non-XInput) controllers through Windows' joystick API with CONTROLS → MAP BUTTONS; F1 help off by default with a small "F1: Help" note |
| 2026-10-12 | Clash detection, build C-A (`261012e_Clash_A`) | Clash engine (search sets, hard / clearance tests, sweep and prune, parallel triangle tests, depth estimate, the model as walked), results merged across runs with statuses and history, `clashes.json` in the `.bimgo` and the model folder (dormant until switched on), EXPORT / IMPORT REPORT, the CLASHES panel (Y) with RUN / RUN ALL and the clash list |
| 2026-10-12 | Clash detection, build C-B1 (`261012f_Clash_B1`) | CLASHES panel with TESTS / SETS editors (rules with a model value picker), clash mode (Y): docked list with filters and search, GO with a quick flight, clash section box, red / green pair over ghosted surroundings, status keys, markers, R to select the pair in Revit |
| 2026-10-12 | Handoff (`261012g_Handoff`) | C-B1 fixes (Gavin's list) → C-B2 (thumbnails, clash → comment / BCF, SHOW IN REVIT) → C-C → hotkeys → polish → installer |
| 2026-10-12 | Polish (`261012i_Polish`) | Shorter clash panel button, clash card fits its hint, gun bar off by default with a gun wheel switch, mouse wheel steps gun modes (Shift+wheel steps guns) |
| 2026-10-12 | Clash detection, C-B1 fixes (`261012h_Clash_B1_Fixes`) | Cursor kept free in clash mode, glyph fixes, reusable dropdowns (test, filters, sets, rule field / operator), rule operators (is one of, is not, is not any of, does not contain), set A / B kept as picked, ADD RULE without the picker, re-run and reset confirms, RESET RESULTS / RESET ALL, clash view G (ghost / wireframe / real / hidden) and B (section box on / off) |
| 2026-10-13 | Clash detection, build C-B2 (`261013a_Clash_B2`) | Row pictures in the clash list (PICTURES on / off), TO COMMENT / UPDATE COMMENT and LIST TO COMMENTS… (clash view pictures → comments → BCF "Clash" topics with both elements; status and assignee follow the clash), R = SHOW IN REVIT (the pair selected in a "BimGo clash" 3D view with the clash's section box), the section box choice sticks from clash to clash |
| 2026-10-13 | Clash detection, build C-B3 (`261013b_Clash_B3`) | Several clashes at once (Ctrl / Shift click: every pair tinted, one box over all, status / Revit / comments on all), comments only from the selection (UPDATE THEM / NEW ONLY / CANCEL for existing ones; LIST TO COMMENTS removed), MARKUP and a row pencil for clash comment pictures (back to clash mode after), Comments panel TYPE filter and bulk select / delete |
| 2026-10-13 | Handoff (`261013c_Handoff`) | C-B4 (select all / focus all in the clash list; nested ANY / ALL rule groups for search sets) → C-C groups → hotkeys → polish → installer |
| 2026-10-14 | Clash detection, build C-B4 (`261014a_Clash_B4`) | SELECT ALL SHOWN / Ctrl+A in the clash list (focus on all, amber for elements on both sides, box off above 200, R asks above 500, hash-set selection); search set rule groups (ANY OF / ALL OF, one level, NOT inside groups as ordinary conditions, `groups` in clashes.json) |
| 2026-10-16 | QOL round (`261016a_QOL`) | Options PREVIEW, Appearance tab (was Debug) with water / glass material overrides (also in the Revit Options window), "None" for unarmed, slimmer pause buttons, clash report moved to clash mode (REPORT…), EXPORT / IMPORT TESTS… and SETS… with link / level reconciliation, clash box off on leaving clash mode, sun panel ↔ study shortcuts |
| 2026-10-16 | Sky round, build A (`261016b_Sky_A`) | Procedural clouds (cover, drift) and sun size / glare in the sun panel's SKY tab (a look only, saved per model), clash mode on the gamepad, P row pictures, Tab options preview, grass keywords stored, trademark line |
| 2026-10-16 | Grass round, build B (`261016c_Grass_B`) | Grass blades on grass materials (Realistic; a top-down grass field, instanced clumps around the eye, sun / shadows / lights / wind), Appearance pages for water and grass, water colour presets / custom and reflection strength (also in the Revit Options window) |
| 2026-10-16 | Handoff (`261016d_Handoff`) | Grass cover limit 300 mm; every C-C grouping question answered (stored status + MIXED, one group per clash, gone members stay resolved, per test, auto by element 2+, one comment per group with link / replace / cancel); reports planned: Navisworks-style XML, HTML, PDF (PDFsharp / MigraDoc) |
| 2026-10-16 | Clash grouping, build C-C1 (`261016e_Grouping_C1`) | Clash groups: group rows with MIXED, group card (status sets members, assign, notes), right-click menu (group selected, add to / remove from, group all on an element, merge, rename, ungroup), Ctrl+G / Ctrl+Shift+G, AUTO GROUP by element, groups across runs and in reports, one comment / BCF topic per group (link / replace / cancel) |
| 2026-10-16 | Clash grouping, C-C1 feedback (`261016e_Grouping_C1`) | Group row pencils, groups first, SHOW all / groups / ungrouped, shorter GROUP / UNGROUP labels, rename starts empty on automatic names, collapse from a member, list scroll bar |
| 2026-10-16 | Handoff (`261016f_Handoff`) | C-C2 grouping tools next (group by box, pick points, proximity / level / category-pair auto groups; rethink the dock layout first) → clash reports → hotkeys → polish → installer |
| 2026-10-17 | Clash grouping tools, build C-C2 (`261017a_Grouping_C2`) | Dock re-laid (SHOW with the filters, TOOLS ▾), group by box (section box, orbit, full height; the group keeps its box: edit box, recollect), pick points (dots through walls, marquee), cluster sphere with an edge handle, auto groups by level / category pair / level + category pair |
| 2026-10-17 | Clash reports, build C-C3 (`261017b_Reports_C3`) | Click a clash dot to go to it, G live in the grouping tools, HTML + XML clash reports (scope / format / pictures / groups card, rendered pictures, self-contained HTML with cover and summary, Navisworks-style XML) |
| 2026-10-17 | Handoff (`261017c_Handoff`) | Clash detection done for now; next: water ripple strength / speed (animation off saves no FPS), then grids, levels and grid nodes with their own panel |
| 2026-10-17 | Water and grass controls, build W (`261017d_Water_W`) | Water ripple strength and speed, wave size (25–400 %), grass sway (0–200 %, per machine, also in the Revit Options window); grids round answered (host + links, 3D extents, Revit-like bubbles, level outlines + tags, faint through walls, Shift+G panel / C cycles, hover labels on nodes) |
| 2026-10-17 | Grids and levels, build A (`261017e_Grids_A`) | Revit grids (host + links, lines / arcs / multi-segment, 3D extents) and storeys in `grids.json`; dash-dot lines, bubbles, level tags and outlines on chosen levels (off / underfoot / above / below / ±1 / nearest / all), faint / hidden / x-ray through walls; C cycles, Shift+G panel, walking and clash mode; saved per model |
| 2026-10-17 | Grids and levels, build B (`261017f_Grids_B`) | Grid intersections (rings, hover "A-1 : Level 2" + coordinates, click / Teleport go there, Measure snaps), solid / dash-dot lines (solid default), minimap grids, clash grid location (card, HTML, XML gridlocation), AUTO GROUP by grid / grid + level, optional location in clash comments / BCF |
| 2026-10-17 | Handoff (`261017g_Handoff`) | Grids B fixes (InputState alias in GridNodes, the Water page's sliders two a row so the card fits); next: appearance profiles / colour by parameter (rendering path, rules, legend; questions listed) |
| 2026-10-17 | Colour profiles, build A (`261017h_Colour_A`) | COLOUR PROFILES panel: named profiles per model by value (built-in fields or extracted parameters) or by search set, palette colours with a picker, rows on / off, others ghosted / normal / flat, surface detail; per-element colour texture + element stream (instant recolour), ghost pass; Phase and Parameter search set rules; Shift+C and an on-screen legend |
| 2026-10-17 | Colour profiles, build B (`261017i_Colour_B`) | Caps fix (ghosts not capped); number ranges with ramps and bins; per-row transparency and hide; AT LEAST / AT MOST / BETWEEN set rules; legend in photos / screenshots; profile export / import with their sets; link rows by instance name |
| 2026-10-17 | Briefing (`261017j_Handoff`) | Roadmap agreed: Round P polish (P-A panel shell / HUD / 720p / gamepad reach, P-B hotkey review, P-C leftovers + colour follow-ups), Round K keyframed flythrough, Round X extras (sun time-lapse, batch stills, sequence playback, Revit camera sync) |
| 2026-10-17 | Polish, build P-A1 (`261017k_Polish_PA1`) | UI batch clipping; spacing tokens; panel shell (header, clipped pixel scroll regions, ← BACK · actions · CLOSE footer, Esc one level back); the nine big panels on it; settings card scrolls when short; window-size check (720p / 1080p / 1440p) |
| 2026-10-17 | Handoff (`261017l_Handoff`) | Handoff for P-A2: dock variant, HUD columns, gamepad reach; questions to ask |
| 2026-10-18 | Polish, build P-A2 (`261017m_Polish_PA2`) | Docks in a shared right-hand column (sun, study, section box, grids; shared header / scrolling body / CLOSE footer); clash dock header and its list on `ScrollRegion`; HUD left column (status, coordinates, legends that collapse, F1); gamepad D-pad focus ring, A presses, slider steps, LB / RB tabs |
| 2026-10-18 | Handoff (`261018a_Handoff`) | Handoff for P-B: hotkey review answers (targeted fixes, LB / RB chords, generated F1, toast + CONTROLS marks) |
| 2026-10-18 | Polish, build P-B (`261018b_Polish_PB`) | Hotkey review: K pick points in clash mode; gamepad chords for bookmarks, grids, colour profile, clash mode, group / ungroup, next status; A / B with a shoulder held are chords; path editor keys reserved for Round K; F1 sheet generated per situation with a gamepad column; changed-defaults toast, NEW / CHANGED tags, RESET ALL confirm |
| 2026-10-18 | Polish, build P-C (`261018c_Polish_PC`) | Nested search-set groups (any depth); groups in CLASHES → TESTS; grid node on clash rows; grid lines in photos; grass follows edits / visibility and shows in probes; tour sun blends; bookmarks keep crouch and the colour profile; comment / BCF eye height; colour ranges by equal width / count / custom breaks; profile-coloured caps; legend scaled for big stills; hidden rows' copies hidden; profile import reconciles links / levels. README compacted (§8: open build, limitations, roadmap incl. Round K additions, night sky, rain, Media area) |
| 2026-10-18 | Handoff (`261018d_Handoff`) | Handoff for Round K (keyframed flythrough) in a new chat: brief, Gavin's additions (path in tour mode, spline corners, follow-the-path heading, in-flight node editing, sun animation, Media area), code pointers |
| 2026-10-18 | Flythrough, build K-A (`261018e_Flythrough_KA`) | MEDIA panel (Shift+M; PHOTO · TOUR · PATHS · VIDEO), camera paths (`paths.json`: centripetal Catmull-Rom with smoothness, constant speed, eases and holds, follow-the-path heading with own-view / look-at keys, sun animation, colour profile per key), PLAY PATH and video from a path through the tour player; tour and video settings moved into MEDIA |
| 2026-10-18 | Flythrough, build K-B (`261018f_Flythrough_KB`) | 3D path editor (Shift+K): path drawn with collision in red, keys and targets, K / Del / ← → / Enter, X / Y / Z and view handles, pick target, scrubber driving the camera, Space preview, undo; editor fly keys |
| 2026-10-18 | Handoff (`261018g_Handoff`) | Handoff for K-C in a new chat: K-A / K-B summary, the K-B test fix (no pad default for the path editor), K-C scope and questions, code pointers, Round W / X after |
| 2026-10-18 | Flythrough, build K-C (`261018h_Flythrough_KC`) | SMOOTH tour (a spline through the stops with holds and swivels, following between them); CONVERT TO PATH; key swivel, cut and hidden items, follow between key views; PHOTO AT THIS KEY and PHOTOS OF ALL KEYS; the 3D editor's preview shows the path's sun, profile, cut, hidden items and fades; dock sun row; scrubber sun strip; sun dates blend the short way round the year |
| 2026-10-18 | Night sky, build W-A (`261018i_Night_WA`) | The real moon (place, phase; or a chosen phase), moonlight lighting the scene and casting shadows at night, stars turning with the sky for the site and the Milky Way, moonlit clouds; sun panel NIGHT tab; CLEAR MARKERS removed (X never deletes comments) |
| 2026-10-18 | Handoff (`261018j_Handoff`) | Handoff for W-B (rain) in a new chat: W-A summary and its fixes (moon halo, phase icons), the agreed rain scope (cover map, lens drops, wet look, sound, lightning on / off + frequency), open points, code pointers |

## 10. Dependencies

BimGo itself is MIT-0 (`LICENSE`); the packages below are MIT, whose notices must still ship with the app. BimGo.Revit ships no packages. Licence texts: `THIRD-PARTY-NOTICES.txt` (copied beside `BimGo.exe` with `LICENSE.txt`).

| Package | Version | Licence | Used in | Why |
|---|---|---|---|---|
| Silk.NET.OpenGL | 2.23.0 (pinned) | MIT | BimGo.App (`Native/Gl.cs` only) | OpenGL function bindings |
| Silk.NET.Core, Silk.NET.Maths | 2.23.0 (transitive) | MIT | BimGo.App | Required by Silk.NET.OpenGL |
| Microsoft.DotNet.PlatformAbstractions, Microsoft.Extensions.DependencyModel (+ small System.* packages) | transitive | MIT | BimGo.App | Required by Silk.NET.Core |
| MSTest.Sdk | 4.4.1 (pinned in the Sdk attribute) | MIT | `tests/BimGo.Core.Tests` (dev-only) | Test framework and runner |

BimGo Web (fork) has **no run-time packages**: the built site is the app's own code (ZIP through the browser's `CompressionStream` / `DecompressionStream`; walkthrough video through the browser's WebCodecs H.264 encoder, packaged as MP4 by its own `Mp4Writer`). It serves the same Natural Earth place list as the app (`web/public/places.tsv`, see `THIRD-PARTY-NOTICES.txt`). Dev-only tools, pinned in `web/package.json`:

| Package | Version | Licence | Why |
|---|---|---|---|
| vite | 8.3.3 | MIT | Dev server and build |
| typescript | 6.0.3 | Apache-2.0 | Type checking |
| vitest | 5.0.3 | MIT | Tests |
| eslint, @eslint/js, typescript-eslint, globals | 10.12.0, 10.0.1, 8.71.1, 17.13.0 | MIT | Lint |
| @types/node | 24.19.1 | MIT | Types for the tests |

## 11. BimGo Web

The browser viewer lives in `web/` and deploys to GitHub Pages from the `web` branch (`.github/workflows/pages.yml`: lint, test, build, deploy). Phase notes and the plan: `ai/261007_Web/`. It follows upstream `develop` up to `afda33c` (grids, colour profiles, sky / water / grass, clash groups and reports, the panel shell and docks, the generated F1 sheet, camera paths and the 3D path editor, the night sky): `ai/261007_Web/11_build notes upstream afda33c.md` (earlier: `10_build notes upstream f19fbf2.md`, `9_build notes upstream 24c57c4.md`, `8_build notes upstream eaea8bc.md`, `7_build notes upstream 803c1ff.md`).

```
cd web
npm install
npm run dev      # http://localhost:5173/BimGo/
npm test
npm run lint
npm run build    # static site in web/dist/
node scripts/make-sample.mjs   # regenerates public/samples/BimGo Sample Pavilion.bimgo
```

- Files are opened from disk and never uploaded. Chrome / Edge save back in place; other browsers download a copy.
- Keys that differ from the app: Esc pauses (and releases the mouse; P is the section box, as in the app), **Shift+F12** takes a screenshot (to Downloads), **F5** or **Shift+R** refreshes a live session. Ctrl+F (Find room) is taken from the browser's own find. Every other key is the app's default and can be rebound in CONTROLS, except keys the browser keeps (F12, Ctrl+W / T / N / R / C / V / X, Ctrl+Tab / PgUp / PgDn). Gamepads use the browser's Gamepad API (standard-mapping pads as Xbox ones; others through MAP BUTTONS).
- Clash detection runs on the page's main thread in short slices behind the progress screen; wireframe clash views are drawn from an edge buffer (WebGL2 has no polygon mode). In a live session clash results are kept beside the model through the add-in's new `clashes` sidecar (an older add-in can't store them: save a `.bimgo`).
- Quality profiles set the same values as the app except anti-aliasing (the browser viewer has no MSAA). Shader strings are generated from `Shaders.cs` (`web/scripts/port-shaders.py`); re-run it after upstream shader changes.
- Browser differences: BCF exports, photos, 360° panoramas, tour videos and study CSVs go to Downloads (no OPEN FOLDER / SHOW IN FOLDER); IMPORT BCF picks a file. RECORD VIDEO needs WebCodecs (Chrome, Edge, Safari 16.4+). The location picker fetches `places.tsv` from the site the first time it opens and reads IANA time zones through the browser (`Intl`), so DST AUTO works for every listed zone. Recent files keep their thumbnail in this browser's storage; the last live session card can't join (Go in Revit starts sessions). Saved sun / daylight studies are kept in this browser (IndexedDB, per model) instead of the model's BimGo folder. The section caps' colour uses the browser's colour picker. Comment pictures for BCF travel inside the `.bimgo`; in a live session they stay in memory (the add-in's sidecars are JSON only).
- `?model=<same-site URL>` opens a model by link (e.g. `?model=/BimGo/samples/BimGo%20Sample%20Pavilion.bimgo`).
- The sample (`BimGo Sample Pavilion`, ~35 KB; comment ids are GUIDs so BCF round-trips merge, elements carry IFC GUIDs, the site has shared coordinates, and one bookmark carries a section cut) is generated by `web/scripts/make-sample.mjs`: no Revit or third-party content.
