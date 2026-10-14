# Round C, build C-A: clash engine, storage, report, CLASHES panel

Written without a .NET SDK (none reachable from the sandbox): **not compiled here**. Brackets and partial-member
names were checked by script; the geometry, the depth estimate and both sweeps were checked in a Python port
(see *Checks*). Expect a few compile fixes: send just the errors.

## What it does

- **Dormant until switched on.** Y (new action `ClashMode`, Views and tools) or pause menu → CLASHES. Before that
  nothing is parsed, built or run and nothing runs per frame: a file's `clashes.json` is read as raw bytes and written
  back unchanged (`BimGoDocument.Clashes`, `ClashBytesForSave`). After switching on, the panel's rows are rebuilt only
  when the data or the display units change; the pause-menu label recounts only when the clash data changes.
- **Starter tests** when a model has no clash data: sets *Structure* (BimGo categories structural columns, framing,
  foundations, floors) and *Services* (ducts, pipes, cable trays, conduits, mechanical equipment, sprinklers, air
  terminals) as catalogue rules (the same in every Revit language), tests *Structure × Services* and *Services ×
  Services* (hard, 5 mm).
- **Search sets** (stage 1): include rules (any / all) + exclude rules on catalogue category, Revit category, family,
  type, level, model (host = empty value, or the link's UniqueId / name), equals or contains, ignoring case.
- **Engine** (`ClashEngine`, `ClashGeometry`, `ClashTree`): sweep and prune on element boxes (clearance grows each box
  by half the distance), set membership and skips (itself, host ↔ own inserts in the same model); per pair, triangles
  inside the overlap box (relative to the pair's centre for float precision; elements with 384+ triangles get a
  median-split tree built once per run, ≤ 3 M triangles total), a sweep over triangle boxes, exact tests. All cores but
  one (`Parallel.For`, per-thread scratch buffers). A broken pair is logged and skipped, never fatal.
- **Hard depth (own method):** the narrowest width of the crossing outline (min over X / Y / Z and the crossing faces'
  normals of max − min of the crossing points); when that is within the tolerance, corners buried deeper than the
  tolerance inside the other element (no face within the tolerance, and inside by the even–odd rule along three skewed
  rays, two of three agreeing) still count. So: duct through a beam = its smaller cross dimension; walls overlapping
  3 mm = 3 mm (ignored at 5 mm); pipe sunk 40 mm into a slab = 40 mm; faces that only touch = never. Containment
  (an element wholly inside another, no crossing) is not reported: it was left out of scope.
- **Clearance:** a proper crossing (each triangle has corners strictly on both sides of the other's plane) → crossing
  tag, distance 0; touching → distance 0, no tag; else the smallest triangle distance under the distance.
- **Merge across runs** (`ClashMerge`): key = test id + both element keys sorted (link + UniqueId, clone key, or
  ElementId as a last resort). New → active on the next run, resolved → active when back (counted as reopened),
  reviewed / approved stay; missing from a complete run → resolved; a run stopped at the limit resolves nothing.
  Run history (≤ 200): found, new, newly resolved, counts per status, set sizes, seconds, truncated.
- **Model changed:** each test stores a model-state stamp (extraction time, element / triangle counts, journal count +
  last entry time); the panel compares it.
- **Storage:** files: `clashes.json` in the `.bimgo` (compact JSON, optional, no format bump), marked unsaved after a
  change; live: `clashes.json` in the model folder, written at once, mirrored beside the model as
  `<model>.bimgo-clashes.json` with sharing on (added to `ModelFolders.SIDECARS`). Points in Revit internal metres.
- **Report:** EXPORT REPORT… writes the whole document as readable JSON (`bimgo-clash-report`, model title / key,
  generator, time). IMPORT REPORT… merges: missing sets / tests / clashes added, a matched clash takes the report's
  status / assignee / notes when its `updated` is newer, history merged, a different model key flagged.
- **CLASHES panel** (in place of the pause menu, like FIND ROOM): up to five test rows (tick for RUN ALL, name + kind,
  sets with element counts, last run / "model changed", counts per status, − / + tolerance: hard 1 mm steps then 5 mm
  past 10 mm, clearance 5 mm then 25 mm past 100 mm), the selected test's clashes (open first, deepest first), RUN ALL,
  EXPORT / IMPORT REPORT…, CLOSE. Runs go through the existing progress screen (CANCEL / Esc; a cancelled test is
  unchanged and later tests are skipped).

## Ready for C-B (BCF)

`ClashRecord.CommentId` is in the format already: C-B's "to comment" will create a comment with the clash view
(section box, red / green, ghosted) and its picture, store the comment id on the clash, and the existing EXPORT BCF
carries it. Grouping (C-C) can add a `group` field later without a version change.

## Files

- New: `src/BimGo.Core/Clashes/` `ClashModels.cs`, `SearchSets.cs`, `ClashGeometry.cs`, `ClashEngine.cs`,
  `ClashTree.cs`, `ClashMerge.cs`, `ClashFiles.cs`; `src/BimGo.App/Game/Clashes/` `GameSession.Clashes.cs`,
  `GameSession.ClashPanel.cs`; `tests/BimGo.Core.Tests/ClashTests.cs` (16 tests).
- Changed: `InputCatalog.cs` (`ClashMode` = Y, after `SectionClear`), `BimGoFormat.cs` (`ENTRY_CLASHES`,
  `CLASH_SIDECAR_SUFFIX`), `ModelFolders.cs` (`CLASHES_FILE`, sidecar list), `BimGoDocument.cs` (`Clashes` bytes),
  `BimGoReader.cs` / `BimGoWriter.cs` (the entry), `GameSession.cs` (Y, Esc chain), `GameSession.Menu.cs` (panel
  dispatch, CLASHES button in the review stack), `GameSession.Document.cs` (dirty, save), `GameSession.Render.cs`
  (F1 row), README (§3 row + note, §4, §5, §6, §8, §9), `THIRD-PARTY-NOTICES.txt` (clash methods acknowledged).
- No new packages; nothing copied; no other clash tool's code, UI or wording used (statuses are plain workflow words).

## Checks

- Python port (`port.py` / `cases.py` / `sap.py`, not shipped): duct through beam (depth 0.200), diagonal duct
  (0.200), touching faces (none), 3 mm overlap at 5 mm (none) and at 1 mm (0.003), pipe sunk 40 mm in a plain and a
  768-triangle slab (0.040), sunk 3 mm (none), contained box (none), clearance gap 30 mm at 50 / 20 mm (hit / none),
  crossing in clearance (tagged), touching in clearance (0, untagged); inside test; 3,000 random triangle pairs:
  the distance never exceeds a sampled minimum; broad phase and triangle sweep equal brute force on 300 random cases
  each.
- Brackets balanced in every new / changed file; no duplicate member names across the 38 `GameSession` partials.
- README §3's new row was written by hand in the generator's format: `Readme_ControlsTablesAreCurrent` will say if
  it differs (it then rewrites the table: copy it back).

## To verify on Gavin's machine

See README §8 "Clash detection, build C-A". APIs worth a look: `Parallel.For` with thread-local state
(`ClashEngine.Run`), `ProgressScreen.Run<ClashRunResult>`, `new ElementRecord { … }` from the App
(`MatchesIgnoringTemplate`: init-only setters), `DynamicInstance.Model` / `WorldBounds` / `Committed` as the
as-walked transform.
