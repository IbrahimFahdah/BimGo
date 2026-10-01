# RvtGo — Revit First-Person Walkthrough Add-in

## 1. Overview

RvtGo turns the active Revit model into a first-person, FPS-style walkthrough running in its own window. Geometry is extracted once at launch, rendered with a lightweight custom OpenGL engine, and explored with collision, gravity, doors that swing, walkable stairs and a set of "tool guns" for inspecting, measuring, commenting and moving around.

| Item | Decision |
|---|---|
| Base | Customise the existing Revit add-in template (follow its multi-version targeting, ribbon and project conventions) |
| Runtime | .NET 8 (`net8.0-windows`), Revit 2025, 2026 and 2027 |
| Renderer | OpenGL 4.x via hand-written P/Invoke (WGL + GL) in a Win32 window, **no NuGet dependencies** |
| Model sync | Snapshot at launch. Relaunch to refresh. |
| Comments | Persisted to a JSON sidecar beside the model |
| Entry point | One ribbon button on an RvtGo tab |
| Lifecycle | Closing the window ends the session. The button starts a fresh session. |

**UI mockup:** [RvtGo HUD Mockup](https://claude.ai/artifact/6wtj2qsqbUQtPppzEW7xkX) is the reference for the in-game HUD (gun bar, status panel, minimap, per-gun context panel), the Esc pause menu and the Revit launch-options dialog.

---

## 2. Launch Flow

1. **Ribbon button**: opens the **Options dialog** (WPF, modal).
2. **Options**:
   - Category groups to load (System / FFE / Services), with per-category tick boxes
   - Triangle threshold per element (default **20,000**)
   - Colour mode: **Material colours** (cached from Revit) or **Whitecard** (greyscale)
   - Anti-aliasing (MSAA off / 2x / 4x, **off by default**)
   - Mouse sensitivity, field of view (FOV), invert Y
3. **Extraction** (Revit API thread): tessellate geometry, cache colour and metadata, build the level list and the spawn point.
4. **Game window** opens on its own thread. Revit stays responsive.
5. **Spawn / Home**: the active 3D view's eye position and direction, or a random valid point on the ground plane if no 3D view is active.

---

## 3. Geometry & Categories

Each category group loads at launch if ticked. In-session, groups and categories can be toggled from the **Escape pause menu**. Anything not loaded at launch appears **greyed out** and can't be toggled.

### 3.1 System (collidable)
Walls, Floors, Ceilings, Roofs (incl. Gutters, Fascias, Roof Edges/Flashings), Curtain Panels, Curtain Wall Mullions, Doors, Windows, Stairs (incl. Runs/Landings), Ramps, Columns, Structural Columns, Structural Framing, Structural Foundations, Toposolid/Topography.

### 3.2 FFE (collidable, threshold applies)
Casework, Furniture, Furniture Systems, Generic Models, Parking, Specialty Equipment, Plumbing Fixtures, Railings, Food Service Equipment, Planting, Entourage, Signage.

### 3.3 Services (collidable, threshold applies)
Electrical Fixtures, Electrical Equipment, Mechanical Equipment, Lighting Fixtures, Lighting Devices, Security Devices, Fire Alarm Devices, Communication Devices, Data Devices, Nurse Call Devices, Sprinklers, Air Terminals.
*Optional, off by default because of their volume:* Ducts, Pipes, Cable Trays, Conduits, and their fittings.

### 3.4 Triangle Threshold
- Elements over the threshold are replaced with a **bounding-box proxy**. The fallback is selectable in Options: proxy or skip.
- The threshold is set only in Options at launch.

### 3.5 Special Handling
- **Doors**: approximated as one or two box **leaves**, hinged from the family's hand and facing orientation. A leaf swings open automatically when the player comes within ~1.5 m and closes once the player is clear. While open, the leaf is non-collidable.
- **Stairs**: walkable with a **step-up tolerance** (default 200 mm max riser, configurable), and smoothed so the camera doesn't bob on each tread.
- **Ground plane**: an abstract infinite plane at the lowest level (or below the model). The player can raise or lower it in session. It catches falls.
- **Sky**: a simple gradient skybox with a horizon line.

---

## 4. Player & Controls

| Input | Action |
|---|---|
| WASD / Arrow keys | Move |
| Mouse | Look |
| Space | Jump (ascend in fly mode) |
| Shift | Run |
| Ctrl | Crouch (descend in fly mode) |
| V | Toggle **no-clip / fly** mode (disables collision and gravity) |
| 1–4 | Select gun. Mouse wheel cycles guns. |
| LMB / RMB | Gun primary / secondary |
| Page Up / Page Down | Teleport up or down one Revit level |
| Tab | Toggle minimap |
| H | Return to Home |
| Shift+H | Set Home to current position |
| X | Clear current gun's markers (e.g. remove portals) |
| Esc | Pause menu (resume, category toggles, ground plane, settings, quit) |

**Physics**: capsule collider against a static BVH of collidable triangles, plus gravity, jump and step-up. Kept simple and deterministic.

---

## 5. Tool Guns

| # | Gun | LMB | RMB | Notes |
|---|---|---|---|---|
| 1 | **Scan** | Lock target and show info panel | Clear | Highlights the element under the crosshair. Shows Name, Category, Family/Type, ElementId and Level. |
| 2 | **Measure** | Start point, then commit the end point | Remove last line | Live rubber-band line between clicks. Reports distance plus ΔX/ΔY/ΔZ. Toggle: snap the second point along the face normal. |
| 3 | **Portal** | Place blue portal | Place red portal | Re-firing moves that portal. Walking through teleports the player and keeps relative orientation. Includes basic FX (ring glow, flash) and a sound. |
| 4 | **Comment** | Place marker, then type a comment | Remove marker | Hovering shows the comment. Saved to a JSON sidecar (`<model>.rvtgo.json`) and reloaded on the next launch. |

Sounds are synthesised in code (simple tones and noise via `winmm`/`waveOut`), so no audio assets ship.

---

## 6. HUD
Minimal overlay:
- Crosshair
- Current gun
- Mode (Walk / Fly)
- Current level
- FPS and frame time
- Short controls hint (toggle with F1)
- Scan/measure readouts
- Minimap: top-down, current level, with player arrow and portal/comment markers

---

## 7. Architecture

```
Revit thread                         Game thread
────────────                         ───────────
Ribbon cmd → Options dialog
GeometryExtractor ──(snapshot)──►    SceneData (immutable)
  - tessellate, colour, metadata       ├─ Renderer (GL 4.x, batched VBOs per category)
  - levels, doors, spawn               ├─ Physics (static BVH + door dynamics)
                                       ├─ Player / Input (Raw Input, mouse capture)
                                       ├─ Guns, HUD, Minimap
                                       └─ Audio (waveOut)
```

- **One-way data flow**: the render thread never calls the Revit API.
- **Batching**: meshes merged per category into large vertex/index buffers, one draw call per batch, with per-element ID ranges kept for picking and toggling. Doors are drawn as instanced transforms.
- **Culling**: frustum culling on per-chunk AABBs, with the BVH shared between picking and collision.
- **Picking**: CPU ray cast against the BVH. No GPU readback.

---

## 8. Performance Rules
- Use `MathF`, `System.Numerics` (`Vector3`, `Matrix4x4`) and SIMD-friendly structs.
- No per-frame allocations: pooled buffers, `Span<T>`, and structs over classes on hot paths.
- Avoid boxing and casts. Use typed arrays and `unsafe`/`fixed` for GL uploads.
- Fixed physics timestep with a variable render rate. VSync toggle in settings.
- MSAA off by default.
- Target: 60+ FPS on mid-range GPUs for typical building models.

---

## 9. Assumptions (flag if wrong)
1. "NET Framework 8.0" means **.NET 8**, which Revit 2025+ requires.
2. Units display in metres/millimetres. They could follow the project units instead.
3. Toggling Fly mode with V is acceptable (no key was specified).
4. Linked models are **excluded** in v1.
5. Doors are proximity-only, with no manual interact key.

---

## 10. Suggested Build Order
1. Template rename, ribbon button, Options dialog
2. Geometry extraction and snapshot data model
3. Win32 window, GL context and bindings, basic renderer (whitecard)
4. Camera, input, fly mode, HUD/FPS
5. BVH, collision, gravity, stairs, ground plane
6. Doors
7. Pause menu and category toggles, material colours, MSAA
8. Guns: Scan, then Measure, Comment and Portal
9. Minimap, audio, polish
