# C-C2 clash grouping tools: build notes (2026-10-17)

Brief: `0_brief.md`. Built on Gavin's working copy (the zip with `261016f_Handoff`).

**Not compiled here** (no .NET SDK in the sandbox). Checked by script:
- bracket, string and interpolation balance of every edited file;
- new member names declared once across the `GameSession` partials;
- UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`).

Test expectations were worked out by hand first. No new `InputAction`, so README §3 and `ControlsTests` are unchanged.

## In

- **Dock layout:**
  - test;
  - STATUS ▾ · LEVEL ▾ · **SHOW ▾**;
  - VIEW ▾ · BOX · PICTURES;
  - **search** · SELECT ALL · REPORT…;
  - GROUP · UNGROUP · **TOOLS ▾**.

  SELECT ALL's label is shorter: "SELECT ALL", "SELECT ALL n" or "CLEAR ALL n", with no key; the key hint still names Ctrl+A. TOOLS ▾ holds GROUP BY BOX…, PICK POINTS, CLUSTER AROUND THE CURRENT CLASH…, AUTO: BY ELEMENT / BY LEVEL / BY CATEGORY PAIR / BY LEVEL + CATEGORY PAIR, and REMOVE AUTOMATIC GROUPS.
- **A bar for each tool** at the bottom of the view, left of the dock, or full width when the dock is folded:
  - title, live status, buttons and the key hint;
  - Enter (the "go to the clash" key) commits, Esc closes a list or leaves the tool.

  Each tool draws the shown clashes as dots: the nearest 2,000, at 40 % through walls (the old markers were 16 %). The dot under the mouse grows and gets a label: pair · status · level · its group.
- **GROUP BY BOX…** uses the real section box.
  - It starts round the selection or the current clash with a 1 m margin; otherwise it's 4 × 4 m and 3.3 m high in front of you.
  - The dock folds away, and the view frames the box looking down a little.
  - Drag the section editor's cyan face handles (0.05 m steps; Shift drags freely).
  - RMB-drag orbits the box centre and the wheel zooms. The move keys still fly, and the orbit centre moves with them, so they pan.
  - FIT VIEW frames the box again.
  - **FULL HEIGHT** stretches the box to the model's height, hides the top and bottom handles, and counts by plan only. Switching it off puts back the heights it had.
  - Shown clashes inside turn amber, with a live count.
  - **GROUP IN BOX (n)** groups the shown clashes inside, moving any from other groups (the toast says so). The group keeps the box, and the cut you had comes back.
- **EDIT BOX…** (a group row's right-click menu) reopens the box on that group. A group without a box starts with one round its members. UPDATE + RECOLLECT stores the new box, then recollects.
- **RECOLLECT FROM ITS BOX** (a group row's menu, shown when the group has a box):
  - The test's unresolved clashes inside the box join the group, whatever the filters, moving out of other groups (said in the toast).
  - If members now lie outside the box, a prompt offers **REMOVE n** (they leave the group and stay as ungrouped clashes) or **KEEP**.
- **PICK POINTS:**
  - Click a dot to pick or unpick it. Rows work too, and a group row toggles its shown members.
  - **Ctrl+drag** draws a marquee that adds every dot inside. Ctrl+click without moving toggles one dot.
  - The picks *are* the list selection: rows highlight, the pairs are tinted, and the card follows. The camera and section box stay put.
  - Holding Ctrl doesn't fly down while picking.
  - **NEW GROUP (n)** (Enter) groups the picks and ends the tool. **ADD TO GROUP ›** lists the test's groups (largest first) and adds the picks. **CLEAR** empties the picks, and **DONE** / Esc leaves with the picks still selected.
- **CLUSTER AROUND…** (TOOLS ▾ on the current clash, or a clash row's menu):
  - A wire sphere is centred on the clash: XY, XZ and YZ rings plus an outline ring.
  - A **white handle** sits on its edge in the XY plane, on the side across the view so it stays on the outline. Drag it to size the sphere: 0.05 m steps, Shift drags freely, from 0.05 m to 500 m. The radius is kept for the session (1 m at first).
  - Shown clashes inside turn amber, with lines to the centre.
  - Click another dot or row to move the centre there.
  - The status reads "radius 1.00 m · n clashes (k in other groups: they move)".
  - **GROUP (n)** (Enter) makes "Cluster N · <most common level> × n clashes".
- **AUTO by level / category pair / level + category pair** (Core): they take the test's ungrouped, unresolved clashes.
  - Buckets come from A's level (else B's, else "No level"), "Ducts × Structural Framing" (A / B order aside), or "Level 2 · Ducts × Structural Framing".
  - Buckets of 2 or more become groups named "<label> × N clashes", largest first, ties by label.
  - Runs chain, and grouped clashes are never touched.

## Files

**Core**
- `Clashes/ClashGroups.cs`:
  - `ClashGroupAuto.LEVEL` / `CATEGORY` / `LEVEL_CATEGORY`.
  - **`ClashGroupBox`** (min / max internal metres, `FullHeight`, `Contains`, `Normalise`, `Copy`, `Union`).
  - `ClashGroup.AutoLabel`, `Box`, `HasAutoName`, `Basis`.
  - `DisplayName` reads the label.
  - A `Create` overload with `autoLabel`.
  - `Merge` keeps an automatic name only on the same basis (element or label); the box becomes the union when every group has one (full height if either is), else null.
  - `Rename` (empty: back to the label).
  - `SetBox`, and **`BoxSplit`** (the joining and outside lists for RECOLLECT).
  - `Clean` drops blank labels and bad boxes, and normalises corners.
  - `MergeFrom` takes the label and box when newer.
  - `ClashGrouping.LevelOf`, `CategoryPairOf`, `ByLevel`, `ByCategoryPair(perLevel)`, `InSphere` (nearest first), `ClusterLabel` and `InBox`.

**App**
- `Game/Clashes/GameSession.ClashTools.cs` (new): the three tools, the bar, the dots, the orbit, RECOLLECT and the 3D overlay.
- `GameSession.ClashDock.cs`:
  - layout;
  - the dock folds for the box tool;
  - the bar is drawn after `BeginOverlays`, and its buttons run after `DrawOverlays`;
  - row and group clicks route to the tools;
  - `ClashLevel` now calls `ClashGrouping.LevelOf`;
  - leaving a test leaves the tool.
- `GameSession.ClashGroups.cs`:
  - `CLASH_TOOL_ACTIONS` and `RunClashToolAction` (replacing `CLASH_AUTO_ACTIONS` / `RunClashAutoGroup`), plus `RemoveAutomaticClashGroups`;
  - menu items EDIT BOX…, RECOLLECT FROM ITS BOX and CLUSTER AROUND THIS…;
  - `GroupClashes` takes an `autoLabel` and returns the group;
  - the dots and sphere go dirty when the list is rebuilt.
- `GameSession.ClashMode.cs`: a tool takes the update; `ExitClashMode` leaves it first; markers are hidden while a tool draws its own; `ClashFreezesPlayer` covers Ctrl while picking.
- `GameSession.ClashSelection.cs`: the shorter SELECT ALL label.
- `GameSession.Section.cs`: the gizmo draws for the box tool, and hides the plane handle (plus top and bottom at full height).
- `GameSession.Render.cs`: `DrawClashToolOverlay()` after the markers.

**Tests:** `tests/BimGo.Core.Tests/ClashGroupToolTests.cs` (9 tests):
- level / category pair reading;
- by level (open, ungrouped, min 2, ties);
- category pair, per level, then chained;
- auto label rename and merge basis;
- sphere (edge, order, ties, radius 0 / −1);
- cluster label numbering and level;
- box inside, full height and `BoxSplit`;
- box round trip, merge union and Clean.

## Decisions taken (Gavin's answers didn't cover these)

- **What the tools take:**
  - GROUP IN BOX, PICK POINTS and CLUSTER take the clashes **the list shows** (what you see as dots).
  - RECOLLECT takes the test's **unresolved** clashes, **whatever the filters**, like AUTO and GROUP ALL ON: it's run later, when the filters may differ.
- **Committing ends the tool** (PICK POINTS too): the group card shows. Start the tool again for the next group.
- **Box tool pan:** the move keys pan rather than MMB, because MMB is the gun wheel's default. A new MMB action would collide with it under `KeyMap.Refusal`, and the other mouse keys are taken.
- **Free drag** reads `SectionFreeDrag` (Shift) in clash mode, as in the section editor. `InputCatalog.Situations` is left unchanged on purpose: Shift is also Run in clash mode, and listing both would read as a conflict. Holding it while dragging is harmless.
- **The box tool's cut** goes through `SectionChanged()` like the section editor's (recorded with the visibility), and the earlier cut is put back the same way.
- **New box-made groups** are named like GROUP SELECTED: after a shared element, else "Group N". The box is stored, not shown in the name.
- **Cluster groups** have `Auto` null (made by hand), so REMOVE AUTOMATIC GROUPS keeps them. Their `AutoLabel` drives the name.
- **PICK POINTS key suggestion:** **K** in the Clashes context. It's Lights in the walking Tools context, which isn't live in clash mode. Not bound.

## To verify

- It builds. Watch for:
  - the target-typed `?:` in `BeginClashBoxTool` (`IReadOnlyList<ClashRecord> around = group != null ? AllClashGroupMembers(group) : ClashTargets();`);
  - `Aabb.Include` on a local;
  - `box.Min.Z = …` on a local `Aabb`;
  - `ClashGroups.Create` overloads (9 vs 10 arguments);
  - lambdas returning `ClashGroup` used as `Action` in the menu;
  - `char.IsAsciiDigit` (.NET 7+).
- The bar's ADD TO GROUP › list opens above the bar, inside the dock's vertical bounds.
- Orbit feel: `LOOK_SCALE` × sensitivity per count; zoom 15 % per notch; the pitch for FIT VIEW is −0.45 rad.
- Dot cost at 2,000 dots × 2 passes on integrated GPUs.

## Check

1. **Dock:** STATUS · LEVEL · SHOW on one row; search · SELECT ALL · REPORT… on another; GROUP · UNGROUP · TOOLS. At the narrowest dock nothing overlaps, and search still types / clears with Ctrl+Backspace.
2. **TOOLS → AUTO: BY LEVEL** on a test with ungrouped clashes: groups such as "Level 1 × 12 clashes", and the toast counts what's left. Then **BY CATEGORY PAIR**: only the remaining ungrouped clashes are grouped. **REMOVE AUTOMATIC GROUPS** removes both kinds. Try **BY LEVEL + CATEGORY PAIR** on a fresh test.
3. **GROUP BY BOX…** with two clashes selected:
   - The dock disappears, the box sits round them, the bar reads "n of N shown clashes inside" and the dots inside are amber.
   - RMB-drag orbits the box, the wheel zooms, and W/A/S/D slides the view (the orbit follows).
   - Drag a cyan handle: the count updates live.
   - FULL HEIGHT: only the four side handles remain, and dots on other levels above or below turn amber. Switch it off: the heights come back.
   - FIT VIEW frames the box.
   - GROUP IN BOX: a new group and the dock returns. The section cut is what it was before (Ctrl+P state or the clash box).
4. **Esc** in the box tool: cancelled, with the cut restored.
5. **RECOLLECT FROM ITS BOX** on that group: "no new clash" the first time. Run the test after adding a clash in the box area in Revit, or ungroup one member first: it rejoins.
6. **EDIT BOX…** on the group: shrink the box so one member is outside, then UPDATE + RECOLLECT. The prompt reads "1 of the group's clashes now lie outside its box": REMOVE takes it out, KEEP leaves it.
7. **EDIT BOX…** on a group with no box (made with GROUP): the box starts round its members.
8. **PICK POINTS:**
   - Dots show through walls and are dimmer when hidden. Hover one: it grows and shows a label.
   - Click three dots: amber with a ring, the rows highlight, and the bar reads 3 picked.
   - Ctrl+drag a rectangle: the dots inside are added, and the camera doesn't sink.
   - Click a row: it toggles. Click a group row: all its shown members toggle.
   - Enter: NEW GROUP, and the tool ends.
   - Again with ADD TO GROUP › → a group: they join it.
   - CLEAR, then DONE.
9. **CLUSTER AROUND…:**
   - Right-click a clash row → CLUSTER AROUND THIS…: a sphere with a white handle on the left or right of the outline.
   - Drag it out: the radius steps by 0.05 m (Shift: smooth), the amber dots and lines grow, and the bar shows the radius in display units (switch to imperial: feet and inches).
   - Click a dot elsewhere: the centre moves there.
   - Enter: "Cluster 1 · Level 2 × 5 clashes". A second cluster becomes "Cluster 2 · …". REMOVE AUTOMATIC GROUPS keeps them.
10. **Merge** two "Level 1"-style groups (only possible from report imports or two auto runs): the name stays automatic. Merge with a box-less group: the box is gone (RECOLLECT no longer offered).
11. **Save and reopen:** boxes and full height survive (RECOLLECT still offered). REPORT… → EXPORT, then IMPORT elsewhere: boxes arrive.
12. **Y (leave clash mode)** while a tool is open: the tool closes first and the cut is restored.
