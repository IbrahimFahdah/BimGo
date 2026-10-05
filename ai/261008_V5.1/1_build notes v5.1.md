# BimGo v5.1 build notes: redo, bookmarks, coordinate readout (+ v5 fix)

Follows `ai/261007_V5/0_BimGo v5_Handoff.md`. Like v5, written without a .NET SDK or the Revit API assemblies (the cloud workspace can't download them), so **not compiled yet**. v5 itself was also not yet built when this round started: build v5 + v5.1 together.

## Backlog order (Gavin, 2026-10-05)

1. **v5.1 (this round):** build fixes, Redo, viewpoint bookmarks, coordinate readout.
2. **Next round, on its own:** sun + shadows + time-of-day slider (UI/UX and performance need their own pass). Gavin's `GetRevitSunVector`.
3. **Then linked models**, before any more guns.
4. **Guns:** still undecided whether more guns / a gun-bar rethink are needed; revisit after links.
5. Later: incremental refresh, flattened save, named pipes, tests, push follow-ups, signing / installer.

Bookmarks: stored **inside the .bimgo** (Gavin's choice); live sessions use a sidecar beside the comments sidecar.

## v5 fix

- `Extraction/PhaseResolver.cs`: `ElementOnPhaseStatus.NotApplicable` does not exist in the Revit API. Removed from `StandsIn`, `RoleOf`, `DemolishBlockReason`; `StatusIn` returns `None` when `GetPhaseStatus` throws. `None` = unphased (walkthrough shows it, delete-only).

## Redo (file mode)

- `Core/Edits/EditJournal.cs`: in-memory redo list. `RemoveLast` (undo) pushes onto it; `Redo()` pops and re-appends (new `Seq`, content unchanged); `Add` (any new edit) clears it; `RedoCount`, `PeekRedo()`. `MaxCloneKey()` also counts redo entries so a clone made after an undo never reuses an undone clone's key. Not saved (journal.json unchanged).
- `App/Game/GameSession.Document.cs` `Redo()`: file mode only (live: toast "redo in Revit"); blocked while a gun captures input or the push panel is open; applies just that entry with `ApplyEntry` (undo already rebuilt the state from the earlier entries, so this equals a full replay). Toast "Redone: label (n more)"; error toast if the target is missing.
- Keys: **Ctrl+Y** and **Ctrl+Shift+Z** (`GameSession.cs`). Undo's toast now says "(Ctrl+Y redoes)". Help row "CTRL+S / Z / Y".
- Redo entries are never `AppliedToRevit` (undo refuses those), so the "already in Revit" stop is untouched and redone entries push normally.

## Viewpoint bookmarks

- Core: `Format/BookmarkModels.cs` (`BookmarkRecord`: id, name, author, created, x/y/z feet in Revit internal metres (double), yaw/pitch (radians), flying, level; `[JsonIgnore]` Local + Detail. `BookmarkDocument` + `Clean()`), `Format/BookmarkFiles.cs` (sidecar read / atomic write, `SidecarFor(commentsSidecar)` → `<model>.bimgo-bookmarks.json`).
- Format (additive, `formatVersion` 1): `bookmarks.json` entry, written only when non-empty (camelCase JSON like the other entries); `BimGoDocument.Bookmarks`; manifest `counts.bookmarks`; reader logs the count.
- App: `Game/BookmarkStore.cs` (embedded / sidecar like `CommentStore`; Add / Rename / Update / Move / Remove; `MAX_NAME` 60; `NextDefaultName` "View n"). `Game/GameSession.Bookmarks.cs`: store setup, B (add + name box), Ctrl+1–9 (`GoToBookmarkAt`), `GoToBookmark` (fly state, teleport sound, light flash), BOOKMARKS panel (GO, RENAME, SET HERE, ↑ ↓, DELETE twice, ADD THIS VIEW, CLOSE; Esc returns to the menu).
- The comment text box doubles as the name box (`BeginBookmarkRename`, `_editMax`, blue frame, "ESC keep this name" for new ones).
- Dirty tracking / Save / Save-or-discard prompt include bookmarks. Minimap shows bookmarks on the current level as blue dots.
- Pause menu: BOOKMARKS (n) under COMMENTS; the left column's pitch now shrinks (54 → min 40 px) when it would hit END SESSION.
- Ctrl+digit is checked before gun selection (Ctrl is crouch, so the player dips briefly, like Ctrl+S).

## Coordinate readout

- Core `Scene/ModelInfo.cs` `SiteInfo` (additive): `HasSharedTransform`, `SharedEast/North/Elevation` (double), `SharedAngle`. `Scene/SiteCoordinates.cs`: `CoordinateReadout` enum (Off / Shared / Project / Internal); `TryGetShared` (captured transform, else derived from the survey point (or base point) + `TrueNorthAngle`, flagged `Approximate`); `TryGetProjectBase`; `ChooseAngleSign` / `VerifySharedAngle` (pick ±angle by fitting the survey / base point; skipped when the two candidates are < 1 m apart, to stay clear of float noise).
- Revit `SceneExtractor.BuildSite`: `ActiveProjectLocation.GetProjectPosition(XYZ.Zero)` → East/North/Elevation (×0.3048) and Angle; `VerifySharedAngle` flips the sign if the survey point disagrees (logged).
- App `Game/GameSession.Coordinates.cs`: **L** cycles Off → Shared → Project → Internal, skipping what the model lacks; panel under the status panel; value = crosshair hit, else feet ("AIM" / "FEET"); double maths; `TextBuffer.Append(double, decimals)`. Mode saved in `LaunchSettings.CoordinateReadout`.
- Font atlas gained `≈` (approximate shared coordinates on pre-v5.1 files).

## To verify when building

- Everything in the v5 list, minus `NotApplicable`.
- `ProjectPosition` property names (`EastWest`, `NorthSouth`, `Elevation`, `Angle`).
- `Enum.IsDefined(CoordinateReadout)` (generic overload) in `LaunchSettings.Sanitise`; the property shares its type's name (fine in C#, watch for ambiguity warnings).
- `TextBuffer.Append(float, int)` vs new `Append(double, int)`: float arguments bind to the float overload; int arguments too (float is the better conversion).
- `MenuButton(..., height: buttonH)` named argument after positional ones.

## Test checklist (v5.1)

- **Redo:** in a file, make 3 edits (demolish, move, clone), Ctrl+Z ×3, Ctrl+Y ×3 → same state as before; Ctrl+Z, then a new edit → Ctrl+Y says nothing to redo. Clone, undo, clone again, Ctrl+Y does nothing (history cleared) and keys don't collide after Save/reload. Ctrl+Shift+Z = redo. In a live session: Ctrl+Y toasts "redo in Revit".
- **Bookmarks (file):** B → name box (prefilled "View 1"), type, Enter → toast "Bookmarked … (Ctrl+1)"; B, Esc keeps "View 2". Ctrl+1/2 jump (fly state restored). Pause → BOOKMARKS: GO, RENAME, SET HERE, ↑ ↓ (Ctrl numbers follow), DELETE twice. File shows `FILE*`; Save, reopen → bookmarks back; older BimGo opens the file fine (ignores bookmarks.json).
- **Bookmarks (live):** B in a live session writes `<model>.bimgo-bookmarks.json` beside the comments sidecar; F5 refresh keeps them; Save as .bimgo includes them.
- **Minimap:** blue dots on the current level only.
- **Pause menu** at 1280×720 and at 150 % DPI: all left buttons clear END SESSION.
- **Coordinates:** L cycles; compare SHARED at a wall corner with a Revit spot coordinate (relative to Survey Point) on a georeferenced, rotated model (true north ≠ project north); PROJECT vs a spot coordinate relative to the Project Base Point; INTERNAL vs Revit's internal origin. Open a pre-v5.1 file → title shows "≈". Aim at the sky → "FEET".
