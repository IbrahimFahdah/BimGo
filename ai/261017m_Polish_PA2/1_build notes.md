# Polish round P, build P-A2: docks, HUD columns, gamepad reach (2026-10-18)

Built on `BimGo_Polish_PA1.zip` (Gavin's working copy). Not compiled here (no .NET SDK): build first. No Core changes, no
new keys (the D-pad navigation is fixed, not in the catalogue), no new tests: README §3 is unchanged and the Core tests
should pass as before.

Checked by script:
- Brackets, strings and char literals in every changed `.cs` file.
- New member names against their uses across the `GameSession` partials (and that the removed ones are gone:
  `_clashDockScroll`, `_clashScrollDragging`, `_clashScrollGrab`, `BuildClashScrollBar`, `_sunStudyScroll`,
  `HINT_SUN_CLOSE`, `HINT_STUDY_CLOSE`, `HINT_SECTION_CLOSE`, `HINT_GRIDS_CLOSE`).
- UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`).
- Encodings kept: BOMs as they were, LF, `UiBatch.cs` and `UiTheme.cs` still ASCII.

## In

### a. The dock shell (`GameSession.PanelShell.cs`, region *Docks*)

- `DockColumn(width)`: the shared right-hand column.
  - Walking: under the minimap (when it shows), down to just above the sun icon.
  - A window whose column under the minimap is shorter than `DOCK_MIN_HEIGHT` (320) puts the dock at the top instead,
    and the minimap hides while it's open (`_dockOverMap`, used from the next frame).
  - Clash mode: left of the clash dock, the full height (the grids dock, as before).
- `BeginDock(title, colour, border, width, body, notice, fullHeight)` → `DockFrame`:
  - the dock is as tall as its content (last frame's) and the column allows; the body scrolls when it doesn't fit;
  - header (`DOCK_HEADER_HEIGHT` 34): the title on the left, `DockHeaderButton`s on the right, a divider;
  - registers the dock as a gamepad focus area.
- `BeginDockBody` / `EndDockBody`: the body is a `ScrollRegion`. The bar sits in the right-hand padding, so the body keeps
  the old inner width (the panels' layouts are unchanged). The wheel is left alone while a slider is dragged.
- `EndDock(frame, notice, hint, backLabel, closeLabel)`: a divider, the notice strip (amber, two lines; only when the
  dock asked for one), then the footer: ← BACK (when given) · the hint, faint · **CLOSE** on the right. It returns
  `DOCK_CLOSE` / `DOCK_BACK` / `DOCK_NONE`.
- New tokens in `UiTheme`: `DOCK_WIDTH_WIDE` 380, `DOCK_PAD` 16 / `DOCK_PAD_Y` 10, `DOCK_FOOTER_HEIGHT` 30,
  `DOCK_NOTICE_HEIGHT` 32, `COLUMN_MARGIN` 20, `COLUMN_GAP` 12, `DOCK_MIN_HEIGHT` 320, `MINIMAP_WIDTH / HEIGHT`
  220 / 208, `SUN_ICON_SIZE` 52, `STATUS_HEIGHT` 146, `COORDS_HEIGHT` 100, `INFO_WIDTH` 250, `LEGEND_COLLAPSED_HEIGHT` 30.

### The docks on it

| Dock | Width | Header | Body (scrolls) | Footer |
|---|---|---|---|---|
| SUN, SHADOWS & LIGHTS | 340 | title | place + CHANGE… / STUDY…, shadows, quality, time, date, DST, sun info, LIGHTING / SKY tabs and their sliders | "O / Esc closes" · CLOSE |
| SUN AND DAYLIGHT STUDY | 380 | SUN SETTINGS… | every setting, surfaces, RUN, results, exports, SAVE / SAVED STUDIES… | notice · "(study key) / Esc · results stay" · CLOSE |
| SAVED STUDIES (the study's list view) | 380 | SUN SETTINGS… | the note, then every saved study (LOAD / DELETE) | notice · ← BACK · CLOSE |
| SECTION BOX | 340 (was 300) | title | drag hint, BOX / PLANE, FIT TO, caps, CLEAR ALL CUTS | notice · "P / Esc · the cut stays" · CLOSE |
| GRIDS & LEVELS | 340 | title | info line, levels, what to draw, line, through walls, colour, sliders, RESET | "Shift+G / Esc closes" · CLOSE |

- The **location picker** (CHANGE…) keeps its own layout in the dock's place: the column's height up to 624. A window too
  short for 560 under the minimap puts it at the top (the minimap hides).
- The study's **EXPORT CSV** and the section's **CHANGE…** (cap colour) run after the dock is drawn (they open dialogs).
- The study's saved list now scrolls with the dock; its BACK and notice moved to the footer.
- **Sun dock:** it now sits under the minimap like the others (it used to hang above the sun icon). The icon still
  toggles it.

### The clash dock (`Clashes/GameSession.ClashDock.cs`)

- The docks' header: CLASH MODE on the left, the counts on the right, a divider.
- **The list is a `ScrollRegion`** (`_clashListScroll` in ClashGroups.cs): pixel scroll, the wheel over the list (it used
  to be anywhere over the dock), thumb drag and track paging. Only the visible rows are drawn. Rows cut at the edge are
  clipped (pictures too) and their hidden part can't be clicked.
- A step to another clash (next / previous, a pick in the view, a group collapse) brings its row into view, centred,
  as before. Changing the filters, the search or the test goes back to the top.
- The "1–20 of 140" line stays, under the list.
- The old scroll bar code (`BuildClashScrollBar`, `_clashDockScroll`, `_clashScrollDragging / Grab`) is gone.

### b. HUD columns (`GameSession.Render.cs`)

- **Left = information:** `BuildInfoColumn(f, height, sunLegend, profileLegend, help)`.
  - From the top: status (146), coordinates (100, when on).
  - From the bottom: the F1 note or sheet, then the sun study legend.
  - The colour legend fills what's left.
  - **While the F1 sheet is open the legends collapse to their title rows**, and they also collapse when the column runs
    out of room. The colour legend still drops rows first, then collapses.
  - The F1 sheet never rises above the coordinates: rows that don't fit are left out (the last "F1 hides" row stays),
    and with no room for two rows it shows the one-line note.
  - Used by the walkthrough HUD, clash mode (colour legend + F1, no sun legend), the tour and the video HUD (status and
    coordinates only). The four copies of the status / coordinate calls are gone.
- **Right = tools:** minimap (hidden while a dock sits over it), then the gun panel or the open dock (`AnyDockOpen`), the
  sun icon at the foot; the clash dock in clash mode.
- `BuildHelp` now returns its top; `BuildSunLegend(…, collapsed)`; `DrawProfileLegend(…, collapsed)`.
  `BuildProfileLegend(f, top, bottom, collapsed)` and `ProfileLegendWanted` replace the old height maths.

### c. Gamepad reach (`GameSession.PadFocus.cs`, new)

- **Registration:** every control that tests the mouse with `Hover` registers its rectangle as it's drawn: shell buttons,
  menu / small buttons, checkboxes, segments, tabs, dropdowns and their rows, number boxes, list rows and so on. It keeps
  the part the clip shows, and which scroll region the control is in.
  - Sliders register their knob as the cursor's spot.
  - Panels, list viewports, scroll tracks and the markup canvas pass `Hover(…, focus: false)`.
  - Too small or too tall rectangles are skipped, and the same rectangle twice in a row is kept once. Fixed arrays, no
    per-frame allocation.
  - Registration only runs while a controller is connected.
- **The D-pad** moves the focus ring (`UiTheme.FOCUS`, drawn last, over everything) to the nearest control in the pressed
  direction, using last frame's list. It puts the cursor on the control, so **A** (the cursor's click) presses it.
  - First press: the control under the cursor, or the nearest one.
  - A row in a scroll region is scrolled into view (`ScrollRegion.Reveal`), and the focus follows it as the list scrolls.
  - Up / down with nothing further that way scrolls the list under the cursor a notch.
  - Holding a direction repeats.
  - **A focused slider steps 5 % with left / right** (an injected click beside the knob, released the next frame).
- **The ring hides** when the cursor stick or the mouse moves the cursor; the cursor is the stick's again.
- **B** goes back as before (Esc).
- **LB / RB tapped alone** (down and up with no other button meanwhile) step the first tab row drawn:
  - the pause menu's DISPLAY / REFLECTIONS / APPEARANCE tabs;
  - the sun dock's LIGHTING / SKY;
  - the CLASHES panel's TESTS / SETS.
  
  Held with another button they stay chord modifiers, and the D-pad with a shoulder held is left to its chords
  (`PadRB+PadUp` photo mode and the rest).
- **Where:**
  - **Menus** (paused, text boxes, markup): the D-pad always navigates.
  - **Free-cursor editors** (the docks, photo mode's panel, clash mode): the D-pad navigates while the cursor is over a
    dock (or the ring shows). Elsewhere it keeps its walkthrough / clash bindings: level up / down, sun earlier / later,
    clash view / box / next / previous.
  - Walking, tours, videos and key capture: off.
- Plumbing:
  - `InputState`: `PadDown`, `PadPressedOrRepeated`, `AnyPadPressedExcept`, `ConsumePad`.
  - `Gamepad`: `StickMovedCursor`, `WarpCursor`.
  - `UiBatch`: `GetClip`.
  - `GameSession.cs` calls `UpdatePadFocus` right after the cursor mode is set. `Render` brackets the UI build with
    `BeginFocusFrame` / `EndFocusFrame`, and `BeginScroll` / `EndScroll` set the region the targets belong to.

## Not in

- **Photo mode's panel** stays as it was (its own layout). It is only registered as a focus area, so the D-pad
  reaches it.
- The PUSH TO REVIT report and the markup editor are still not on the shell (the D-pad works in both).
- D-pad / LB / RB navigation isn't rebindable and isn't in CONTROLS or README §3 (P-B's hotkey review).
- LB / RB don't step tab-like segmented controls other than CLASHES' TESTS / SETS.
- A dropdown that's open doesn't trap the focus: the D-pad can move to controls behind it. A, or a click elsewhere,
  closes it as usual.

## Decisions taken while building

- **Footer CLOSE buttons replace the "CLOSE (P / ESC) · cut stays" style buttons and header hints.** The key hint moved
  to the footer, faint.
- **The section dock is 340 wide** (it was 300), to match the column.
- **The docks size to their content** rather than filling the column, so a short dock (section box) stays short.
- **In the free-cursor editors the D-pad only navigates over a dock.** Otherwise clash mode's D-pad next / previous and
  walking's sun / level keys would be lost.
- **The clash list's wheel works only over the list** (shared `ScrollRegion` behaviour). It used to work anywhere over
  the dock.

## How to check

1. Build; run the Core tests (unchanged).
2. **Docks at 1080p** (Esc → Appearance → Window size: 1080p):
   - Shift+O: the sun dock sits under the minimap, its header, its body, and the footer with CLOSE on the right. SKY tab:
     the dock shortens. CLOSE closes it.
   - Sun hours study: the wider dock with SUN SETTINGS… in the header; a notice shows above the footer. SAVED STUDIES…:
     the list with ← BACK in the footer.
   - P: SECTION BOX dock; PLANE: OFF shows the notice strip.
   - Shift+G: GRIDS & LEVELS dock.
   - Only one dock at a time; the gun panel is hidden while one is open.
3. **720p:** the same docks under the minimap scroll (wheel over the body, drag the thumb); sliders still drag (the wheel
   doesn't scroll while one is held). CHANGE… in the sun dock: the location picker sits at the top and the minimap
   hides; back with Esc, the minimap returns.
4. **Clash mode:** the CLASH MODE header with the counts; wheel over the list scrolls smoothly; thumb drag and track
   paging; next / previous keys keep the current row in view; filters, search and the test dropdown go back to the
   top; rows half out of view are clipped (pictures too). Shift+G: the grids dock sits left of the clash dock.
5. **Left column:**
   - with coordinates on (L), a colour profile with its legend and a sun study result, the legends stack under the
     coordinates without overlapping;
   - F1: the sheet opens bottom-left and both legends collapse to their title rows; F1 again: they open;
   - at 720p with everything on, the sheet drops rows rather than covering the coordinates;
   - clash mode, real view: colour legend and F1 the same.
6. **Gamepad:**
   - Esc (Start) → D-pad: a cyan ring appears on the control under the cursor and moves between controls; A presses;
     B goes back; LB / RB tapped switch DISPLAY / REFLECTIONS / APPEARANCE; move the stick: the ring hides.
   - In a big panel's list: D-pad down walks the rows and the list scrolls to keep the ring in view; at the end, down
     scrolls a notch.
   - On a slider (Appearance): D-pad left / right steps it.
   - CLASHES: LB / RB switch TESTS / SETS.
   - Sun dock (Shift+O, cursor over the dock): D-pad navigates, LB / RB switch LIGHTING / SKY, RB+D-pad → still closes
     / opens the panels (chords).
   - Clash mode: cursor over the dock → D-pad walks the controls and rows; cursor off the dock → D-pad ← → is previous /
     next clash again.
   - Walking: D-pad is level up / down and sun earlier / later as before.

## To verify (can't be checked here)

- `Gamepad.WarpCursor` (`ClientToScreen` + `SetCursorPos`, the same calls the stick uses) lands on the control's centre
  at every DPI.
- An injected left click from the slider step goes through `InputState.InjectLeft` like A's. Check it doesn't count as
  mouse use (hints stay on gamepad labels).
- That nothing else in the session's free-cursor modes relied on D-pad presses while the cursor is over a dock.
