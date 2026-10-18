# BimGo: handoff for build P-A2 (after the panel shell, P-A1)

**Context:** BimGo is Gavin's personal project:
- publisher **Aussie BIM Guru**, licence **MIT-0**;
- C# / Visual Studio, .NET 8;
- its own OpenGL renderer over Silk.NET;
- a Revit add-in (`BimGo.Revit`), a standalone app (`BimGo.App`) and `BimGo.Core`.

How Gavin works:
- **Rounds:** discuss → AskUserQuestion (recommended option first and marked, at most 4 questions per call) → build → zip.
- **Notes:** each build gets `ai/<yymmdd><letter>_<topic>/` (`0_brief.md`, `1_build notes.md`), README §8 (newest first) and
  §9 rows, and a project doc `claude/BimGo_<Round>_BuildNotes.md`.
- **Each build says what is in, what isn't, and how to check it step by step.**
- Simple build or test errors: he wants **just the fix**. He folds requests in mid-build. "Assume recommended options"
  when he's away.
- **Ask for a fresh zip of his working copy before editing** (it carries his compile fixes).

## 1. Where things are (2026-10-17)

| Build | Folder | State |
|---|---|---|
| Roadmap brief | `261017j_Handoff`, project doc `claude/BimGo_Roadmap_Polish_Flythrough_Brief.md` | Order: Round P (P-A, P-B, P-C), Round K (K-A, K-B), Round X (X-A, X-B) |
| **P-A1** panel shell | `261017k_Polish_PA1`, project doc `claude/BimGo_Polish_PA1_BuildNotes.md` | Built and confirmed by Gavin ("perfect") |
| **P-A2** | (next: `261017l…` is this handoff, so use the next free letter) | To build |

**P-A answers (already given, apply to A2):**
- Split A1 / A2.
- Placement: centred cards (standard 1000 / wide 1180) plus the side card (780) for COLOUR PROFILES.
- Pixel scroll, clipped.
- **Gamepad: both.** The D-pad shows a focus ring and moves between controls, A presses the focused control. Moving the
  stick hides the ring and the cursor takes over again. LB / RB switch tabs.

## 2. What P-A1 built (read `ai/261017k_Polish_PA1/1_build notes.md` for the full list)

- **`Rendering/UiBatch.cs`:** CPU clipping: `PushClip` / `PopClip` / `ResetClip` / `ClipContains`. Rectangles, glyphs and
  images go through `Quad` (cut with UVs); triangles go through `ClippedTriangle` (Sutherland-Hodgman). The frame resets
  the clip stack before the UI flush (`GameSession.Render.cs`).
- **`Hover` (Menu.cs) is an instance method** and ignores the clipped-away part.
- **`UiTheme` tokens:** panel widths, margins, padding, `HEADER_HEIGHT`, `FOOTER_HEIGHT`, `NOTICE_HEIGHT`, gaps, rows,
  controls, scroll bar / gutter / wheel step, and **`DOCK_WIDTH` (340) and `DOCK_HEADER_HEIGHT` (34), reserved for A2**.
  Colours `FOCUS` (#67E8F9, for the ring), `HOVER`, `ROW_STRIPE`, `SCROLL_*`, `DIVIDER`.
- **`Game/GameSession.PanelShell.cs`:**
  - `BeginPanel(size, title, colour, subLine, headerControls, overlays)` → `PanelFrame` (card, `Ix / Iw`,
    `BodyTop / BodyBottom`, `NoticeY`, `FooterY`, `HeaderControlY / H`, `HeaderRight`);
  - `TakeHeaderSlot`, `HeaderButton`;
  - `FooterAction` + `EndPanel(frame, notice, hint, backLabel)` → index, `FOOTER_NONE` or `FOOTER_LEFT`. Fixed slots:
    ← BACK (left) · actions centred · CLOSE (right). Overlays are drawn there when the panel asked for them;
  - `ScrollRegion` + `BeginScroll(..., out contentW, wheel)` / `EndScroll(region, input, contentBottom)`, plus
    `VisibleRows` and `InView`;
  - `PanelBack()` (Esc, the gamepad's B and ← BACK: overlay → sub-view → panel) and `ClosePanelToGame()` (CLOSE);
  - `ShellButton(f, input, x, y, w, h, label, ShellStyle, enabled)`;
  - the window-size check (Esc → Appearance: Own · 720p · 1080p · 1440p; `GameWindow.SetClientSize`).
- **Panels on the shell:** ROOMS, CATEGORIES & LINKS, BOOKMARKS (+ tour settings), TEXTURES (+ proxy grid, folder search),
  COMMENTS (+ detail), LIBRARY, CONTROLS, CLASHES (+ editors, value picker, import card), COLOUR PROFILES.
- **Pause menu:** the settings card shortens and scrolls (`SettingsCardHeight`).
- **Not on the shell:** PUSH TO REVIT, the markup editor.

## 3. P-A2 scope

### a. Compact dock variant for the cursor-mode panels
Same header / footer pieces as the big panels, as a "dock" (`DOCK_WIDTH`, `DOCK_HEADER_HEIGHT`). The dock panels and where
they are drawn today:

| Panel | Builder | Notes |
|---|---|---|
| Sun | `GameSession.Sun.cs` `BuildSunPanel(f, input)` | bottom-right sun icon expands into it (`BuildSunIcon`); Shift+O opens it with a free cursor |
| Sun hours study | `GameSession.SunHours.cs` `BuildSunHoursPanel(f, input)` (~L1002) | `BuildSunLegend` ~L958 |
| Section box | `GameSession.Section.cs` `BuildSectionPanel(f, input)` (~L444) | |
| Grids | `GameSession.Grids.cs` `BuildGridsPanel(f, input)` (~L288) | Shift+G |
| Clash dock | `Clashes/GameSession.ClashDock.cs` `BuildClashDock(f, input, width, height)` (~L260) | has its **own scroll bar** (`BuildClashScrollBar` ~L550, `_clashScrollDragging` / `_clashScrollGrab` in ClashGroups.cs, `_clashScrollToCurrent`): a candidate to move onto `ScrollRegion` |

Also the location panel (`GameSession.Location.cs` `BuildLocationPanel`) and the photo panel (`BuildPhotoOverlay`) are
cursor-mode UIs to look at.

### b. HUD columns (`GameSession.Render.cs` `BuildHud(mapX, mapY)` ~L493)
Today the positions are hard-coded:
- **Left:**
  - `BuildStatusPanel` at (20, 20), 250 × 146;
  - `BuildCoordinatePanel` at y = 20 + 146 + 10 (about 110 tall when on);
  - `BuildProfileLegend` (ColourProfiles.cs ~L259) under them down to `height − 52` (less 78 + 12 when the sun legend
    shows);
  - `BuildSunLegend` at `height − 52 − 78`;
  - `BuildHelp` (F1) bottom-left, which can overlap the legends.
- **Right:**
  - minimap at `width − 20 − 220`, 20;
  - the gun panel under it (260 wide), hidden while the sun / study / section / grids panels are open;
  - the clash dock (clash mode).
- The same status / coordinate calls are repeated in `Tour.cs` ~L345, `Video.cs` ~L344 and `ClashDock.cs` ~L244.

**Goal:**
- Left column = information (status, coordinates, colour legend, sun legend). Legends stack and never overlap; they
  collapse to a title row when the column runs out of room.
- Right column = tools (minimap, gun panel, clash dock).
- The F1 help sheet needs a place that doesn't fight the legends.
- A small column layout helper (stack from the top, measure, collapse) is the likely shape.

### c. Gamepad reach (answer: both, ring on the D-pad)
Every shell button is focusable with the D-pad (focus ring, `UiTheme.FOCUS`), A presses it, B goes back, LB / RB switch
tabs.

The code today:
- **`Platform/Gamepad.cs` `DriveCursor`:** in `PadCursorMode.Menu` / `Editor` the look stick moves the OS cursor, A
  (`PadClick`) injects a left click (held = drag), B (`PadMenuBack`) injects Esc, and the move stick injects wheel notches
  (Menu mode only).
- **`GameSession.Gamepad.cs` `CurrentPadCursorMode()`:** Menu while paused or in a text box or markup; Editor in photo,
  section, sun hours, sun panel, clash mode and grids.

A likely approach:
- Widgets register their rectangles each frame. `ShellButton`, `MenuButton`, `SmallButton`, `Checkbox`, `Segmented`,
  `Tabs`, `DropdownButton`, list rows and `Slider` (left / right to step) all go through `Hover`, so the registration can
  live beside it.
- The D-pad does spatial navigation on last frame's list. A presses the focused rectangle (inject the click at its
  centre, or have the widgets test `focused && pressed`).
- The ring hides when the stick moves the cursor. Scroll the focused row into view with `ScrollRegion.Reveal`.

Watch the D-pad and shoulder bindings:
- **D-pad:** walking uses `PadUp` / `PadDown` for level up / down and `PadLeft` / `PadRight` for sun earlier / later; in
  clash mode they are ClashView / ClashSectionToggle / next / previous.
- **Shoulders:** `PadLB` / `PadRB` are **chord modifiers** (`KeyModifiers.PadLB / PadRB`, e.g. `PadRB+PadUp` = photo
  mode). Using LB / RB alone for tabs in menus must not break the chords. Decide whether menu navigation becomes new
  `InputAction`s in `InputCatalog` (then `ControlsTests` and README §3 change, and P-B's hotkey review may reshuffle
  them) or stays fixed. Ask Gavin.

**Questions likely worth asking before A2 (recommended first):**
- Should the docks share one right-hand dock column, or stay where they are with only the shared header / footer?
- How should the F1 sheet sit in the left column?
- Should D-pad navigation be catalogued (rebindable) or fixed?
- Should the clash dock's own scroll bar move to `ScrollRegion` now?

## 4. Things to watch

- **Compiling:** no compiler in the sandbox (no .NET SDK; nuget and dotnet hosts are blocked): say so.
  - Check brackets, strings and `'\uXXXX'` char literals by script (P-A1's checker: a small Python brace / string / char
    walker).
  - Check new member names across the `GameSession` partials.
  - Scan UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`: `Δ − — – … • ↑ ↓ ← → “ ” ’ ≈ ≤ ≥ ‹ › ↔`).
- **Name clashes:**
  - `InputState` (alias it, or `using BimGo.Platform;`);
  - `DB.` qualifiers in BimGo.Revit;
  - colour profiles are `AppearanceProfile` / `GameSession.ColourProfiles*`, not the quality `Profiles`.
- **Encodings:** keep them as they were (some files have a BOM, most don't; `UiBatch.cs` and `UiTheme.cs` are ASCII). LF.
- **Shaders:** check them in headless WebGL2 if touched.
- **Compatibility:** additive formats only (`.bimgo` 1, `clashes.json` 1, live protocol 1).
- **Shell rules (README AI note 14):**
  - a `return` inside a scroll region must `PopClip` first (the frame reset is a safety net);
  - don't call `input.Wheel` directly inside shell panels;
  - early returns after a panel leaves must skip `EndPanel` work.
- **`CloseBookmarks()` is now one level** (tour settings first); `CloseBookmarksPanel()` closes everything (used by
  `StartTour`).
- **No per-frame allocations;** labels are cached.

## 5. After P-A2
- **P-B hotkey review:**
  - new defaults in `InputCatalog`, `ControlsTests`, README §3;
  - gamepad bindings for the clash view toggles, grids, colour profiles and grouping;
  - PICK POINTS → K in clash mode;
  - a path-editor situation;
  - F1 sheets per mode;
  - user rebinds survive.
- **P-C leftovers + colour follow-ups:** see the roadmap brief.
- **Then Round K** (keyframed flythrough) and **Round X** (extras).
