# RvtGo — Handoff Brief (for a new chat)

**Purpose of the next chat:** add more **tool guns** and **quality-of-life features** to RvtGo, which is working in Revit.

**Read first:**
1. This brief.
2. `RvtGo_Spec.md` (project doc). This is the original design brief.
3. `RvtGo_BuildNotes.md` (project doc). These are the decisions made during the build and the changelog.
4. The current code. **Ask Gavin for a fresh zip of his working copy before editing.** He fixed things locally in Visual Studio, so his copy is the source of truth, not the zip produced in the earlier chat.

---

## 1. What RvtGo is

RvtGo is a Revit add-in. It turns the active model into an FPS-style first-person walkthrough that runs in its own Win32 window on its own thread. Geometry is snapshotted once at launch, and the user relaunches to refresh. Rendering uses a small custom OpenGL engine written with hand-written P/Invoke, with **no NuGet dependencies**.

- **Targets:** Revit 2025 and 2026 on `net8.0-windows`, Revit 2027 on `net10.0-windows`.
- **Template:** built from Gavin's Scaffold `RevitAddin` template, with Debug/Release R25/R26/R27 configs.
- **Entry point:** the RvtGo tab, Walkthrough panel, **Go** button. This runs `Cmd_Launch`, which opens the WPF Options dialog, runs the extraction, then starts the game thread.
- **Session:** closing the window ends the session. Pressing Go while a session is running brings its window to the front.

## 2. Current feature set (working)

- **Options dialog (WPF).** It covers:
  - category groups (System / FFE / Services) with per-category ticks, plus an optional "heavy" services set (ducts, pipes, cable trays, conduits);
  - a triangle limit with bounding-box proxy or skip for elements over it (FFE and Services only);
  - Whitecard or Material colour;
  - max step height;
  - MSAA (off, 2x, 4x), FOV, sensitivity, invert Y, VSync and load comments.

  Settings persist to `%AppData%\RvtGo\settings.json`.
- **Player:**
  - capsule physics with gravity, jump, run and crouch;
  - 200 mm step-up and stair smoothing;
  - fly / no-clip on V;
  - an adjustable ground plane that catches falls;
  - Page Up / Page Down to move between levels;
  - Home on H and set Home on Shift+H.
- **Doors:** rendered exactly as modelled and always no-clip. They are excluded from collision. There is **no open/close system**; Gavin removed it on purpose because it felt janky. Don't reintroduce it.
- **Guns (1–4, mouse wheel cycles):**
  1. **Scan:** highlights the element under the crosshair. LMB locks it and shows an info panel (name, category, family/type, ElementId, level, group). RMB clears.
  2. **Measure:** LMB places the start point, then commits the end point, with a live rubber-band line between clicks. RMB removes the last line. N toggles normal projection. The panel shows the distance and ΔX/ΔY/ΔZ.
  3. **Portal:** LMB places the blue portal, RMB the red one. Walking through teleports the player and keeps relative orientation. Includes FX and a sound.
  4. **Comment:** LMB places a marker and opens a text box. RMB removes the marker under the crosshair. Hovering shows the comment. Comments save to the JSON sidecar `<model>.rvtgo.json`; pressing X twice deletes all.
- **HUD:**
  - status panel (FPS, mode, level, ground, view);
  - minimap on Tab, drawn as a real plan render cut at 1.2 m with poché;
  - a context panel for the selected gun;
  - gun bar with LMB/RMB hints;
  - help panel on F1, toasts, and borderless fullscreen on F11.
- **Esc pause menu:**
  - Resume, Return Home, Set Home Here, Clear Markers and End Session;
  - per-category visibility toggles (categories not loaded at launch are greyed out);
  - display settings: ground plane, colour mode, MSAA, FOV, sensitivity, VSync, invert Y and show FPS.
- **Audio:** sounds are synthesised in code and played via `waveOut` (`Audio/SoundSystem.cs`, `SoundId` enum).

## 3. Architecture and threading (keep this rule)

```
Revit thread:  Cmd_Launch → OptionsWindow → SceneExtractor ──(immutable SceneData)──►
Game thread:   GameHost → GameWindow (Win32 + WGL) → GameSession loop
               (variable render, fixed 120 Hz physics, interpolated camera)
```

- **Only `Commands/` and `Extraction/` may touch the Revit API.** Nothing on the game thread calls Revit. Anything a new feature needs from the model has to be captured during extraction into `SceneData` (`Scene/SceneData.cs`).
- **Units and coordinates:** metres, Z up. Coordinates are scene-local around `SceneData.OriginOffset` (a rounded median of element centres). To get Revit internal coordinates, add the offset and stay in metres.
- **`GameSession`** is split across three partial files:
  - `GameSession.cs`: setup, loop, input, actions, `Pick()`, `Toast()`, `Flash()`;
  - `GameSession.Render.cs`: 3D passes, minimap and HUD;
  - `GameSession.Menu.cs`: pause menu with immediate-mode widgets, plus the comment editor.
- **Renderer:**
  - Indices are batched per category and per pass (opaque or transparent) into spatial chunks. Each batch is drawn with one `glMultiDrawElements` call over the chunks that pass frustum culling.
  - The scene renders into an off-screen FBO (optionally MSAA), which is then blitted to the window. The minimap and UI draw on the window afterwards.
  - Shaders are GLSL 330 (`Rendering/Shaders.cs`). Matrices go up raw from System.Numerics, so "M * v" in GLSL matches "v * M" in C#.
- **Physics:** one static BVH (`Physics/Bvh.cs`) is shared by collision and picking. Per-element masks are `_pickMask` (visible elements) and `_collisionMask` (visible elements minus doors).

## 4. How to add a gun

1. Create `Game/Guns/XxxGun.cs`, deriving from `Gun` (`Game/Guns/Gun.cs`). The members to override are:
   - **Identity and HUD:** `Name`, `Key`, `HintPrimary`, `HintSecondary`, `Colour`, `PanelHeight`.
   - **Input:** `OnPrimary(in AimInfo)`, `OnSecondary(in AimInfo)`, `OnKeys(InputState)`.
   - **Updates:** `Update(dt, in AimInfo)` runs only when the gun is selected. `Tick(dt)` runs every frame.
   - **Drawing:** `DrawWorld(Overlay3D, selected)` draws 3D markers and is called for every gun every frame. `DrawLabels(UiBatch, selected)` draws screen labels anchored to world points. `DrawPanel(UiBatch, x, y, width)` draws the gun's HUD panel.
   - **Housekeeping:** `ClearMarkers()` runs on the X key. `OnDeselect()` runs when the player switches guns. `HighlightElement` and `HighlightStrength` give the element to tint, if any.
2. Register the gun in `_guns` in `GameSession.Initialise()`. Number keys 1..n and the gun bar follow automatically.
   - Keys 1–9 only, so with more than 9 guns, revisit the number keys.
   - Check that the gun bar still fits at around 1280 px width: buttons are 132 px, so it may need to shrink.
3. Shared helpers available through `Session`:
   - `Pick(origin, dir, maxDist, out RayHit)`;
   - `Camera` (`WorldToScreen`, `Forward`, `Right`);
   - `Scene` (elements, levels);
   - `Toast`, `Flash` and `Sound.Play(SoundId)`;
   - `LevelNameAt(z)` and `CurrentLevelName`;
   - `Text` (a `TextBuffer` for formatting without allocations);
   - `UiScale` (use `S(px)` in guns).
4. To add a sound, add a `SoundId` value and a synthesis case in `SoundSystem.Synthesise`.
5. Use colours from `Game/UiTheme.cs`; add a new pair for each new gun.

**Notes on `AimInfo`:**
- `Hit.Element` indexes `SceneData.Elements`.
- `Hit.Normal` faces the viewer.

**Persistence:** follow `CommentStore` (System.Text.Json sidecar, atomic write via a temp file, errors surfaced through `LastError` plus a toast, never thrown).

## 5. Gavin's conventions (apply throughout)

- **Code style:** readable, best-practice, robust over hacks, well organised. XML doc headers on members and comments where useful.
- **Typing:** explicit types where clearer; `var` when `new()` makes the type obvious. LINQ where performance allows, but **not in per-frame paths**.
- **No exceptions surfacing in user-facing tools.** Catch, log via `Utilities.Log_Utils.Write` (writes to `%LocalAppData%\RvtGo\RvtGo.log`), and toast instead.
- **Ask before adding any NuGet package or new dependency.** Ask before reorganising folders.
- **Template conventions:**
  - commands go in `Commands/Cmds_<Group>.cs` as `Cmd_<Button>`;
  - extensions go in `Extensions/TypeName_Ext.cs`;
  - tooltips and icons are resolved by base name (`RvtGo_Launch`).
- **Performance rules:**
  - no per-frame allocations (use `TextBuffer`, pooled arrays, structs on hot paths);
  - `MathF` and `System.Numerics`;
  - `unsafe`/`fixed` for GL uploads.
- **Name clashes:** WPF, WinForms and the Revit `DB`/`UI` namespaces are all global usings. Avoid unqualified `Color`, `Point`, `Plane`, `View`, `Panel`, `CheckBox`, `TextBox`, `Orientation` and similar. Use the existing aliases:
  - `DB.` for the Revit API;
  - `SD` for System.Drawing;
  - `Wpf` / `Win` / `Media` in `OptionsWindow`;
  - `Vk` for virtual-key constants.

  `GlobalUsings.cs` has `global using System.IO;` and `global using ElementRecord = RvtGo.Scene.ElementRecord;`.
- **Docs:** keep `README.md` current (structure, controls, changelog). Update the project doc `RvtGo_BuildNotes.md` with decisions.
- **Handoff:** zip the repo minus `bin/`, `obj/` and `.vs/`.

## 6. Ideas backlog (to agree with Gavin, not committed)

**More guns:**
- **Section/Clip gun:** place a clipping plane on a face, with RMB to clear. It would need a clip-plane uniform in `SCENE_FS`.
- **Hide gun:** LMB hides the element under the crosshair, RMB undoes, X restores all. Per-element visibility would need either a mask uniform with draw-range skipping or a rebuild of chunk draw lists.
- **Area/Path gun:** a polyline on the floor with a running length and area.
- **Level/Height gun:** shows the height above the floor below, clear headroom to the ceiling above, and the RL relative to a project level.
- **Clearance gun:** a vertical cylinder of configurable radius and height (an accessibility turning circle or door swing check) that turns red when it intersects geometry. It could reuse the capsule overlap test in `CharacterController.Overlaps`.
- **Sun/Shadow gun:** would need the sun direction captured at extraction (Gavin has a `GetRevitSunVector` method elsewhere).
- **Photo gun:** saves a screenshot of the current frame with the HUD hidden, read back from the FBO and written as PNG via System.Drawing, next to the model.

**QoL:**
- Save and restore multiple named viewpoints (bookmarks), persisted in the sidecar.
- Export measurements and comments to CSV.
- Configurable keybinds.
- Walk-speed slider and a smooth noclip speed on the scroll wheel while flying.
- Minimap zoom (+/−) and click-to-teleport on the minimap.
- Crosshair coordinate readout, with a toggle for project units.
- "Return to Revit": select the scanned element in Revit. This needs a thread-safe queue plus an `ExternalEvent` raised on the Revit thread. Note this is the only sanctioned way back into the Revit API.
- Linked models (excluded in v1).
- Comment authoring improvements: edit an existing comment, filter by level, list comments in the pause menu with teleport-to.

## 7. Known items still to verify

- These Revit API calls haven't been checked on 2025–2027: `Mesh.DistributionOfNormals` / `GetNormal`, `Element.DemolishedPhaseId`, `Document.IsModelInCloud`, `Level.ProjectElevation`.
- Railing top rails and handrails may show up twice. Component stairs are extracted as runs, landings and supports.
- Feel tuning constants:
  - walk 3.2 m/s and run 6.5 m/s (`Player.cs`);
  - jump and gravity (`CharacterController.cs`);
  - look scale 0.0022 (`Player.cs`).
