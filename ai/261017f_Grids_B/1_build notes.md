# Build B: grid nodes, clash grid location, line style (2026-10-17)

Built on build A (plus the `GridTests` fix). Not compiled here (no .NET SDK): build first, then run the Core tests.

Checked:
- Brackets / strings on every changed C# file, by script.
- New member names across the partials.
- UI strings in the font.
- Encodings unchanged.
- The grid shader compiles and links in headless WebGL2 with the new `uDashed`.

## In

### Core

- `Scene/GridData.cs`:
  - `GridNode` (two grid indices, point, "C-4" name).
  - `GridLocation` (node, level, plan offset; `Text` "C-4 : Level 2").
  - `GridNodes`:
    - `Build`: every crossing of two grids from the same model; a joint crossing counted once; parallels none.
    - `NodeName`: the letter-led name first, else ordinal.
    - `Intersect`, `ShowsAt`.
  - `GridLocator`:
    - host intersections, the links' only when the host has none;
    - level = the highest building storey at or below the point (any level when there are no storeys; below the lowest: the lowest);
    - prefers intersections whose grids reach that level;
    - works in internal metres via the scene origin.
- `Format/GridModels.cs` (`GridViewSettings`):
  - `Line` "solid" (default) / "dashdot" (`DashDot`);
  - `Nodes` (on);
  - `ClashComments` (off);
  - all part of `IsDefault` and `Clean`.
- `Clashes`:
  - `ClashGroupAuto.GRID` / `GRID_LEVEL`;
  - `ClashGrouping.ByGrid(document, test, locate, perLevel, …)` and `GridLabel` ("Near C-4" / "Near C-4 : Level 2" / "No grid");
  - `ClashReportOptions.GridLocation` (a function): the XML `gridlocation` (else the level, as before), an HTML *Grid* line per clash and a *By grid* table.
- Tests: `GridNodeTests` (7).

### App

- `GridOverlay` / `GRID_FS`: `uDashed` (0 solid).
- Panel (632 px tall):
  - *Nodes* and *In clash comments* checkboxes;
  - a *Line* row: SOLID · DASH-DOT.
- `GameSession.GridNodes.cs`:
  - nodes built once;
  - `_gridNodeOverlay` (ring = outer dot in the grid colour + dark core; hovered: white ring, coloured core) in the lines' see-through mode;
  - hover in `UpdateAim`: crosshair when captured, mouse when free; not over the panels or dock; a clash dot under the mouse wins;
  - hover label: title, coordinates in the readout's system, a hint;
  - `ClickGridNode`:
    - walking with the grids panel open: `FreeFeetNear` (the floor within 0.6 m of the level, rings of 0.6 / 1 / 1.5 m round a column);
    - clash mode: `FlyToClashView`, 7 m back and 4 m up along the heading;
  - `GridNodeTeleportTarget` (the Teleport gun's `Update` checks it first);
  - Measure snap (sets the aim hit to the node on the level);
  - minimap lines (Liang–Barsky clipping) + names;
  - a clash location cache (by id and point);
  - `ClashGridFunction` for reports: the locator only, so it is safe off the main thread.
- Clash mode:
  - the card detail adds " · Near C-4 : Level 2 (offset)";
  - TOOLS ▾ adds AUTO: BY GRID / BY GRID + LEVEL (a model without grids says so);
  - `ClashCommentText` is now an instance method and adds the location when *In clash comments* is on;
  - the group comment lists the members' locations (most common first, up to five).

## Decisions taken (not asked)

- Nodes are on by default (they show only when grids are shown).
- Hover works whenever grids show, including walking with the crosshair; clicking needs a free cursor (the grids panel open, or clash mode), because LMB fires the gun while walking.
- The coordinates follow the L readout; with the readout off: shared, else project, else internal.
- The node / level label uses ":" as Navisworks does ("A-1 : Level 2").
- The clash level for the location is by elevation and storey (not the element's level parameter), so it matches the grid levels.

## Not in

- The location on dock rows.
- Section box / gizmo snapping to nodes.
- A bookmark or picture per node.

## Check

See README §8 (the grids B entry): ten steps covering:
- line style;
- rings;
- the hover label;
- going to a node;
- Teleport / Measure;
- clash mode;
- the minimap;
- the card and reports;
- AUTO by grid;
- comments / BCF.
