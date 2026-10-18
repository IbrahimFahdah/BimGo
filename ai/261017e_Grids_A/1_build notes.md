# Build A: grids and levels (2026-10-17)

Built on build W (Gavin confirmed W and the wave size). Not compiled here (no .NET SDK, no Revit API): build first, then run
the Core tests.

Checked:
- Brackets / strings on every changed C# file, by script.
- New member names against all `GameSession` partials (no duplicates).
- UI strings against the font (Latin-1 + `UiFont.EXTRA`).
- Encodings unchanged (new files UTF-8 with BOM, LF).
- The grid shaders compile and link in headless WebGL2 and were rendered (`grid_preview.png`: two levels, the dash-dot, constant width, a solid outline).

## In

### Revit (`Extraction/SceneExtractor.Grids.cs`)

- Grids of the host and of each **extracted** link, through the link's total transform.
- `DB.Grid.Curve`: a line's two ends, other curves `Tessellate()`d.
- `DB.MultiSegmentGrid.GetGridIds()`: the segments are chained into one line (`GridLayout.Chain`: any order or direction), named after the multi-segment grid; its segments are then skipped as single grids.
- `DB.Grid.GetExtents()`: the Outline's Z range gives the vertical 3D extent (unknown or flat: every level).
- Levels: `LEVEL_IS_BUILDING_STORY` (`LevelInfo.IsStorey`; old files read as storeys).
- A grid that fails is logged and skipped. The log adds "Host: N grids." per model.

### Core

- `Scene/GridData.cs`:
  - `GridLine`: name, link, plan points, bottom / top, curved, bubble ends and outward directions.
  - `GridLevelMode`: off / underfoot / all / above / below / nearest / adjacent.
  - `GridLayout`: `ShowsAt` (± 50 mm), `ShownLevels`, `PlanBounds` (+2 m), `Included`, `Next`, `Chain`, `AppendSegment`, `Label`, `PANEL_ORDER`.
- `Format/GridModels.cs`:
  - `grids.json` (`GridsDto` / `GridDto`, `GridFiles.ToDto / FromDto`: damaged grids dropped, unknown links read as host).
  - `GridViewSettings`: the panel's state, saved as `visibility.json` → `grids`, left out at the defaults, `Clean()`.
- Reader / writer: optional `grids.json`; `LevelDto.storey` (written only when false).
- `InputCatalog`:
  - `GridsPanel` (Shift+G) and `GridsCycle` (C), in *Views and tools*;
  - also live in the *Clash mode* situation;
  - a new *Grids panel* situation.

### App

- `Rendering/GridOverlay.cs` + `Shaders.GRID_VS / GRID_FS`:
  - one static buffer, rebuilt only when the shown levels or the settings change;
  - constant pixel width;
  - world-metre dash-dot (2.4 dash, 0.5 gap, 0.3 dot, 0.5 gap), solid once `fwidth(along)` > 0.1 m / px;
  - lines 30 mm above the level;
  - depth modes: faint (25 % pass without depth, then full with depth), hidden, x-ray.
- `Game/GameSession.Grids.cs`:
  - C cycle with toasts (no grids / links only / mode);
  - the **GRIDS & LEVELS** panel:
    - levels in two rows: OFF · UNDERFOOT · ±1 · ALL and ABOVE · BELOW · NEAREST;
    - storeys only, 3D extents, bubbles, level tags, level outlines, link grids (only when links have grids);
    - through walls: FAINT · HIDDEN · X-RAY;
    - colour: CYAN · RED · AMBER · WHITE · DARK;
    - opacity, line width, bubble distance, RESET (keeps the level choice);
  - 2D bubbles / tags within the distance.
- Wiring:
  - `UpdateFrame` (panel branch; C / Shift+G walking);
  - frozen player, cursor mode and gamepad editor cursor while the walking panel is open;
  - one panel at a time (sun panel, study, section box, photo mode, tour close it);
  - clash mode: the keys at the top of `UpdateClashMode`; Esc closes the panel first; `OverClashDock` includes the panel; panel and labels in `BuildClashHud`; leaving clash mode closes it;
  - render: lines with the markers (not in photo mode or with the UI hidden);
  - labels before the gun labels; the gun's context panel and the "Click to look around" hint are hidden while the panel is open;
  - F1 help row;
  - visibility load / save (`RestoreGrids`, `GridsForSave`).
- Settings changes go through `VisibilityChanged`, so a file shows FILE* (as hiding a category does) and the live sidecar is written a moment later.

## Decisions taken (not asked)

- Grids are **off by default** (C turns them on): no change for existing models.
- Bubbles / tags are 2D UI: always on top, a constant size, no occlusion test.
- The cycle from a panel-picked mode (above, nearest…) goes to all, then off.
- Wave size, ripples and speed (build W) are untouched.

## Not in (build B and later)

- Build B:
  - grid nodes;
  - node hover labels;
  - "near C4 · L2" on clash cards and reports;
  - clash auto group by grid and by grid + level;
  - minimap grids;
  - measure snapping to nodes.
- Grids in photos and in screenshots with the UI hidden.
- A hand-picked set of levels.
- Custom colours (the file takes any #RRGGBB).
- Scope boxes / per-view 2D extents.
- A gamepad binding for the two keys.

## APIs to verify on compile

- `DB.MultiSegmentGrid`, `.GetGridIds()`.
- `DB.Grid.GetExtents()` → `Outline` (`MinimumPoint` / `MaximumPoint`).
- `DB.Grid.Curve`, `Curve.Tessellate()`.
- `BuiltInParameter.LEVEL_IS_BUILDING_STORY`.
- C#: `IList<XYZ> raw = curve is DB.Line ? new[] { … } : curve.Tessellate();` (a target-typed conditional).

## Check

See README §8 (the grids entry): ten steps covering:
- extraction;
- C and the panel;
- extents;
- the see-through modes;
- link grids;
- clash mode;
- save / F5;
- photo mode;
- storeys;
- FPS.
