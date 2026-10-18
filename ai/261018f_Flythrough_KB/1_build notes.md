# Round K, build K-B: the 3D path editor (2026-10-18)

Built on `BimGo_Flythrough_KA` (confirmed, no changes). **Not compiled here** (no .NET SDK): build first, then the Core tests.

Checked by script: brackets, strings (interpolation holes) and char literals in every changed `.cs` file; new member names
once across the `GameSession` partials; no type-name clash (`Format`, `Scene`, `Physics`, the app); UI strings against the
font atlas; encodings kept (LF; new files without a BOM).

New keys (`InputCatalog.DEFAULTS_VERSION` 3, ten `DefaultsChanges` rows, so the one-time toast and NEW tags show):

| Action | Keys | Gamepad | Where |
|---|---|---|---|
| `PathEditMode` | Shift+K | — (gamepad: MEDIA → PATHS → EDIT IN 3D, DONE) | walking (Tools) and in the editor (leaves) |
| `PathSetKey` | Enter | RB+Y | editor |
| `PathMoveForward / Back / Left / Right` | W / S / A / D | LS | editor |
| `PathFlyUp` / `PathFlyDown` | E / Q | RT / LT | editor |
| `PathFlyFast` | Shift (hold) | LS click | editor: faster, and drag handles without snapping |
| `PathUndo` | Ctrl+Z | — | editor |

K, Del, Space, ← / → (reserved in P-B) now work. `SIT_PATH` is live (`CurrentSituation`, `UpdateFrame`); its F1 sheet has 11
rows; `FineAdjust` left the situation (Shift is the editor's fast / free key). README §3 updated by hand: if
`ControlsTests.Readme_ControlsTablesAreCurrent` reports Inconclusive, commit what it wrote.

## In

| Item | What it does | Where |
|---|---|---|
| **Editor mode** | Shift+K (walking) or MEDIA → PATHS → **EDIT IN 3D** (the selected path; no paths: makes one). Like clash mode: dock right, free cursor, RMB-drag looks, flying on the editor's keys; panels, photo / section / sun / grids and clash mode close (entering clash mode leaves the editor). Esc: shows a hidden UI, cancels target picking or the preview, then leaves; Shift+K or DONE leaves (still flying). **MEDIA** in the dock opens the panel over the editor (its CLOSE comes back). | `GameSession.PathEditor.cs`; `GameSession.cs` (`UpdateFrame`, `FixedUpdate`, `CursorModeOpen`), `Gamepad.cs`, `Render.cs`, `Media.cs`, `ClashMode.cs`; `Player.FixedUpdate(…, moves)` |
| **Drawn in 3D** | The path sampled every 0.25 m (up to 4,000 samples), cyan; **red** where the gap between two samples hits visible static geometry (cuts honoured; checked when the path rests, not mid-drag); chevrons every ~2 m; keys as amber dots with numbers (the selected one white and larger), short view lines; look-at lines and targets (magenta); a green dot where K would insert. Depth-tested, then at 30 % through walls. | `DrawPathEditor`, `UpdatePathCollision` |
| **K** | Adds a key at the view: at the scrubber's spot (exactly, with its heading), else within 1 m of the path into that segment, else after the selected key (or at the end). The new key is selected. | `AddPathKeyHere`, Core `CameraPathTimeline.Nearest`, `SegmentAt` |
| **Del** | Deletes the selected key; the next is selected (Ctrl+Z brings it back). | `DeleteSelectedPathKey` |
| **← / →** | Snap the camera into the previous / next key (none selected: the first / last; a loop wraps); the scrubber jumps to it. | `SnapToPathKey` |
| **Enter / SET** | The selected key takes the view (eye and look). Snapped in: a banner says "At “Key 3”: fly and look, then Enter sets it", and "Moved from …" once you've moved (← / → leaves the key as it was). | `SetSelectedPathKey`, `BuildPathSnapBanner` |
| **Picking** | A click on a key's dot selects it; on a target's dot selects that key with the handles on its target. | `PathKeyUnder`, `PathTargetUnder` |
| **Handles** | On the selected key (or its target): X / Y / Z arrows (the mouse ray's closest approach to the axis; 5 cm steps, Shift free) and a yellow **view handle** on the key (it turns the key's view to where the ray meets a sphere round the key; 5° steps, Shift free). Sized to stay about the same on screen. Saved when the drag ends (no file writes mid-drag); one undo step per drag. | `BeginPathDrag`, `DragPathHandle`, `EndPathDrag`; `PathStore.SetKeyView / SetKeyTarget(…, save: false)` |
| **Target** | Heading "Look at": PICK THE TARGET, then click a surface. Picking from the scene sets the key to look at it. × clears it. | `PickPathTarget` |
| **Scrubber** | Bottom bar (left of the dock): keys as numbered ticks, the playhead, PLAY / PAUSE, the time. Dragging puts the camera on the path (position and heading). Space / PLAY previews from there (from the start at the end; round again on a loop). The player waits while the editor moves the camera. Stopping leaves you on the path: K inserts there. | `BuildPathScrubber`, `PlacePathCamera`, `AdvancePathPreview` |
| **Dock** | The path (‹ › to switch paths), keys · length · time, "N segments pass through the model (red)" or "Clear of the model"; ‹ KEY / SET / KEY ›, ADD HERE / DELETE; the selected key's hold, speed and smoothness (× back to the path's), ease, heading (and the target), notes on handles. Sun, profile and path settings stay in MEDIA → PATHS. | `BuildPathDock` |
| **Undo** | Ctrl+Z: a snapshot of the path before each change (key add / delete / set / drag / dock field / target), 40 kept for the session; restored in place (same instance and ids; the selection follows by id). | `PushPathUndo`, `UndoPathChange`; Core `CameraPath.Snapshot`, `CopyFrom`, `CameraKey.Snapshot`; `PathStore.Restore` |

### Tests (+2)
`CameraPathTests.Editing_NearestPointSegmentAndTime` (nearest point / segment / distance, `SegmentAt` incl. a loop's
closing segment and wrap, `TimeAtDistance`), `CameraPathTests.Snapshot_RestoresInPlaceWithTheSameIds`.

### README
§3 tables (Tools row, the path editor group) and notes; §4 (+PathEditor); §5 new **3D path editor** bullet; §8 (K-A's entry
dropped as confirmed; K-B's to-verify; the camera paths limitation updated; roadmap: K-C next); §9 row.

## Not in (K-C)
- The tour as a path type (SMOOTH, CONVERT TO PATH), a key as a photo, sun animation polish.
- The editor's preview shows the camera only (no sun, colour profile or fades: PLAY PATH has them).
- Collision ignores moved / cloned / placed elements (static scene only) and hidden geometry.

## Things to look at when building
- `Player.FixedUpdate` gained an optional `InputAction[] moves` (forward, back, left, right, run).
- `PathStore.SetKeyView` / `SetKeyTarget` gained `save` (false: counts the change, writes nothing); `PathStore.Restore`.
- New partial `GameSession.PathEditor.cs` uses `RayHit` (`using BimGo.Physics`), `PickStaticVisible`, `ScreenRay`,
  `ClosestOnAxis` (Section / SunHours partials).
- `bool set`, `bool add` are used as local names (contextual keywords, fine).

## How to check
1. **Build**, then the **Core tests** (all pass).
2. **Enter:** walking, Shift+K → the editor on the selected path (or "Path 1" made). The cursor is free, the dock is on
   the right, the scrubber at the bottom; WASD flies, E / Q up / down, Shift faster, RMB-drag looks; F1 shows the editor's
   sheet. MEDIA → PATHS → EDIT IN 3D does the same.
3. **Add:** fly to a start point, K; fly on, K (×4, round a corner). The line appears with chevrons; keys numbered.
4. **Insert:** fly near the middle of a segment (within 1 m: a green dot shows on the line), K → the key goes between
   the two (numbers shift). Drag the scrubber to the middle of a segment, K → a key exactly there.
5. **Snap and set:** → snaps into key 1, → key 2; look elsewhere → banner "Moved from …"; Enter → the key takes it
   (its view line turns). → without Enter: the key is unchanged.
6. **Handles:** click key 3 → arrows; drag the blue arrow up → the key rises in 5 cm steps (Shift: smoothly), the
   line follows; the yellow handle turns its view. Ctrl+Z puts it back.
7. **Target:** key 2 heading "Look at", PICK THE TARGET, click a column → a magenta line; click the target's dot →
   arrows on the target; drag it.
8. **Collision:** drag a key so the path goes through a wall → that part turns red after the drag, the dock counts it.
9. **Scrubber / preview:** drag the playhead → the camera flies the path with its heading; Space plays, Space pauses;
   PLAY at the end starts over; a looping path goes round.
10. **Delete / undo:** Del deletes the selected key; Ctrl+Z restores it (and earlier changes, one by one).
11. **Leave:** Esc (or DONE, Shift+K) → walking keys back, still flying. The path is saved (`.bimgo`: unsaved marker
    until SAVE; live: `paths.json`). PLAY PATH in MEDIA still plays the edited path with sun and fades.
