# RvtGo — Build Notes (v2, 2026-10-04)

QoL pass on top of Gavin's working v1: room readout, symbol gun bar, and four new guns (Teleport, Demolish, Gizmo, Clone), three of which write back to Revit. Written without a compiler (no .NET SDK / Revit API in the sandbox), so expect a small round of build fixes.

## Decisions agreed with Gavin
- **Gizmo / Clone keys:** RMB commits to Revit, Esc cancels (Esc doesn't open the pause menu while locked on). LMB does nothing while locked on.
- **Gizmo feel:** camera-relative, smooth. WASD 1 m/s, Q/E 90°/s (Q = CCW, E = CW). Shift = ¼ speed. Holding Ctrl snaps the change since lock-on to 50 mm / 15°. Plan only (no Z).
- **Demolish:** default sets Phase Demolished to the session phase (the launch view's phase, else the last project phase). T toggles to real delete. Prime → click again to demolish. RMB un-primes, X clears primes.
- **Bridge folder:** new `Bridge/`. `RevitBridge.cs` is the third place allowed to touch the Revit API (with `Commands/`, `Extraction/`).

## Other decisions taken during the build
- **Write-back route:** one `ExternalEvent` is created on the first launch and reused. Each session gets a `BridgeChannel` (ConcurrentQueues). Every request runs in its own `RvtGo: …` transaction (one undo step each). A failures preprocessor deletes warnings; any error rolls back and Revit's first error text is shown as a toast. After `Raise()` a WM_NULL is posted to Revit's main window to wake its message loop. The game also re-raises if requests wait more than 1.5 s.
- **Optimistic edits:** the game changes immediately and reverts on a refused result. If the bridge couldn't start, the edits stay in-game only (with a toast).
- **Clones before Revit answers:** each clone gets a session key. The Revit side maps key → new ElementId, so a clone can be moved or demolished before its id comes back (requests run in order).
- **Gizmo / Clone eligibility** (captured at extraction as `Movable` / `MoveBlockReason` / `Pivot`): the element must be a `FamilyInstance` with a `LocationPoint`. It must not be in-place, nested (`SuperComponent`), grouped, pinned or wall-hosted. The pivot is the location point. Revit rotates about the element's current location point, then moves.
- **Hiding:** the element's static index ranges are overwritten with degenerate triangles (`glBufferSubData`). No chunk rebuilds are needed.
- **Moved / cloned rendering:** `DynamicInstance` reuses the static VBO, with a copy of the source indices in a small dynamic IBO, drawn with a new `uModel` uniform (identity for static draws).
- **Moved / cloned picking and collision:** the ray or box is moved into source space and the static BVH is queried with a one-element mask.
- **Rooms:** finish boundaries, arcs tessellated, Z range from the room bounding box. Rooms of the session phase are preferred (all placed rooms if none match). Even-odd point-in-polygon at feet + 0.3 m, re-checked after every 50 mm of movement; the smallest containing room wins.
- **Gun bar:** 52 px square slots with procedural icons (`GunIcons.cs`). `Gun.Key` is now assigned from the slot index. The selected gun's name sits in a pill beside the LMB/RMB hints.
- **Highlights:** generalised to `Gun.CollectHighlights(List<Highlight>)`, which allows several highlights at once and dynamic instances (the old `HighlightElement` path still works).

## To verify first in Revit
1. Build errors (new files: `Bridge/*`, `Physics/DynamicSet.cs`, `Game/GameSession.Edits.cs`, `Game/Guns/{Teleport,Hammer,Gizmo,Clone}Gun.cs`, `GizmoController.cs`, `GunIcons.cs`).
2. `ExternalEvent.Raise()` called from the game thread, and that requests run promptly while the game window has focus.
3. `WorksharingUtils.GetCheckoutStatus`, `Element.GetDependentElements`, `Room.Level`, `SpatialElement.GetBoundarySegments`.
4. Phase demolish on a wall: do its doors and windows get demolished too (and hidden in-game)?
5. A Gizmo move that round-trips: the in-game position should match Revit after a relaunch (rotation about the location point).

## Changelog
- 2026-10-01: v1 delivered. Door open/close removed.
- 2026-10-04: v2: room readout, symbol gun bar, Teleport / Demolish / Gizmo / Clone guns, Revit bridge.
