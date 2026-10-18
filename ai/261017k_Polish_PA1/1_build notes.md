# Polish round P, build P-A1: panel shell, clipped scrolling, 720p (2026-10-17)

Built on `BimGo_Colour_B.zip`. Not compiled here (no .NET SDK): build first. No Core changes, no new keys, no new tests
(README §3 unchanged; the Core tests should pass as before).

Checked by script:
- Brackets, strings and char literals in every `.cs` file.
- Leftover layout names (`buttonsY`, `width`, `height`, the old `x / y / w / h` of each rewritten panel) and returns
  inside scroll regions (only the MARKUP… one, which pops the clip itself; the frame resets the clip stack anyway).
- UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`).

## In

### UI batch clipping (`Rendering/UiBatch.cs`)

- `PushClip(x, y, w, h)` / `PopClip()` (nested clips intersect, 16 deep), `ResetClip()`, `ClipActive`, `ClipContains`.
- Done on the CPU as shapes are queued, so the single batch (and `Image`'s in-order flushes) is kept:
  - rectangles, glyphs and images go through one `Quad` that cuts them with their texture coordinates;
  - triangles (lines, circles, rings, wedges, chevrons) are cut to polygons (Sutherland-Hodgman) and fanned.
- Nothing changes while no clip is pushed (one branch per shape).
- `GameSession.Render.cs`: the clip stack is reset before the frame's UI flush.

### Hover respects the clip (`GameSession.Menu.cs`)

`Hover` is now an instance method: inside a scroll region the part clipped away never counts, so rows scrolled out of
view can't be clicked (every widget uses `Hover`).

### Spacing tokens (`UiTheme.cs`)

Panel widths (1000 / 1180 / 780), margins (16, 40 from a 900 px high window), padding (24 / 16), header 56, footer 40,
notice strip 24, footer slot widths, gaps (8 / 12 / 20), rows (44 / 28), controls (40 / 30 / 32), label column 140,
scroll bar 6 + gutter 14, wheel step 72, and the dock sizes for P-A2. New colours: `FOCUS`, `HOVER`, `ROW_STRIPE`,
`SCROLL_TRACK`, `SCROLL_THUMB(_HOT)`, `DIVIDER`.

### The panel shell (`Game/GameSession.PanelShell.cs`, new)

- `BeginPanel(size, title, colour, subLine, headerControls, overlays)`:
  - backdrop and card (standard / wide centred, side on the right with the model lightly dimmed);
  - the card is the window's height less the margins, so every panel shortens to the window;
  - header: title, sub-line (stops short of the header controls), divider.
- Header controls, right to left: `HeaderButton` (ADD THIS VIEW, REPLY…, RUN ALL, IMPORT… / EXPORT… / RESET ALL) and
  `TakeHeaderSlot` for anything else (the clash tabs, the colour profile ticks).
- `ScrollRegion` + `BeginScroll` / `EndScroll`:
  - pixel offset eased towards a target, wheel only while the cursor is over the region (so two panes scroll on their
    own), the gamepad's scroll stick through the wheel;
  - a thumb in a 14 px gutter: drag it, or click the track to page;
  - `VisibleRows` / `InView` so only the rows in view are drawn (thumbnails and previews too);
  - `Reset`, `ScrollToEnd` (applied once the content is measured), `Reveal`;
  - `wheel: false` leaves the wheel alone (CONTROLS while a key is captured, a slider being dragged in the settings card).
- Footer, `FooterAction(label, style, enabled)` then `EndPanel(frame, notice, hint, backLabel)`:
  - a notice strip (the panel's last message in amber, else the hint, faint);
  - ← BACK (left, fixed) · the actions centred (narrowed evenly when they don't fit; labels clipped) · CLOSE (right);
  - draws the overlays when the panel opened them; returns the action pressed, or `FOOTER_LEFT` when BACK / CLOSE left.
- `PanelBack()`: one level back for Esc, the gamepad's B and ← BACK: an open dropdown / confirm, then the sub-view, then
  the panel (to the pause menu; the clash panel opened in clash mode back to clash mode). Esc in `GameSession.cs` now
  calls it.
- `ClosePanelToGame()`: CLOSE: every level of the panel closes and the walkthrough (or clash mode) carries on.
- `ShellButton`: the shell's button (centred, clipped label; normal / primary / danger; disabled faded).
- Window-size check: Esc → Appearance → *Window size (layout check)*: Own · 720p · 1080p · 1440p. Logical sizes (times
  the UI scale: 720p at 150 % is 1920 × 1080 px), centred on the screen; leaves fullscreen / maximised first; says when
  the screen is too small. Own puts the window back. Session only. `GameWindow.SetClientSize` is new.

### The nine panels on the shell

| Panel | Width | Header | Body | Footer |
|---|---|---|---|---|
| ROOMS | standard | count | search, rows (scroll) | hint |
| GEOMETRY (Categories & links) | standard | "Walkthrough only" | cards + every link (one scroll; the "+n more" summary is gone) | hint |
| BOOKMARKS | standard | ADD THIS VIEW | rows (scroll) · tour settings: settings column (scroll) + stop rows (scroll) | TOUR SETTINGS / RECORD VIDEO, PLAY TOUR (primary) |
| TEXTURES | standard | counts | options, filter, rows (scroll) · proxy grid (scroll) · folder search rows (scroll; *Remember this folder* moved above the rows) | FIND IN FOLDER… · search: ACCEPT TICKED, NEXT STAGE / DONE |
| COMMENTS | standard | count | filters, rows (scroll), select row | EXPORT BCF…, IMPORT BCF…, BCF coordinates |
| COMMENT (detail) | standard | REPLY… (primary) | picture, fields and the whole thread (one scroll) | GO TO VIEW, SET VIEW HERE, EDIT TEXT, DELETE; ← LIST |
| LIBRARY | wide | counts | search, chips, family list (scroll), cards (scroll) | hint |
| CONTROLS | wide | IMPORT…, EXPORT…, RESET ALL | search, gamepad tuning, notice / question, rows (scroll) | clash count in the notice |
| CLASHES | wide | TESTS / SETS tabs, RUN ALL (primary) | list (scroll) + editor: test fields (scroll), set rules (scroll), value picker (scroll), import card rows (scroll) | EXPORT…, IMPORT…, RESET ALL…; ← CLASH MODE in clash mode · import: IMPORT |
| COLOUR PROFILES | side | In photos / Show / Legend | list (scroll) + editor, rows (scroll) | hint |

### Pause menu

- The settings card (Display / Reflections / Appearance) is the full 440 px when it fits, else shorter with its content
  scrolling (`SettingsCardHeight`; the file footer stays clear). The options preview uses the same height, and DONE always
  fits under it (the `RIGHT_CARD_HEIGHT` maths in `GameSession.Appearance.cs` now go through it).

## Not in (P-A2)

- The compact dock variant for the cursor-mode panels (sun, sun hours, section, grids, clash dock).
- HUD columns (left information, right tools; legends stacking).
- Gamepad: D-pad focus ring, A presses, LB / RB tabs. The stick cursor, A = click, B = back and the scroll stick work as
  before in every panel.
- The PUSH TO REVIT report and the markup editor stay as they were (not among the nine).

## Decisions taken while building

- **CLOSE goes straight back to the walkthrough** (it used to return to the pause menu): ← BACK (and Esc) now does that.
- **Esc leaves BOOKMARKS → TOUR first** (back to the list), like the other sub-views; BACK TO LIST and CANCEL / STOP
  buttons are gone (← BACK does it).
- **Primary actions moved to the header** where the brief suggested (ADD THIS VIEW, RUN ALL, REPLY…); PLAY TOUR stays in
  the footer as the primary action (it leaves the panel).
- **The "1–12 of 40 · wheel to scroll" counters are gone:** the scroll bar shows it.
- **Two-pane panels keep a scroll region per pane** (the brief's "one scroll region" is per list).

## How to check

1. Build; run the Core tests (unchanged).
2. Esc → each of the nine panels: header, footer (← BACK left, CLOSE right, actions centred), the hint or last message
   above the footer.
3. In each list: wheel scrolls smoothly; the bar's thumb drags; a click on the track pages; rows half out of view are cut
   cleanly (text, thumbnails, buttons) and a click on their hidden part does nothing.
4. Two panes (CLASHES, LIBRARY, COLOUR PROFILES): the wheel scrolls only the pane under the cursor.
5. Esc / ← BACK steps back one level: comment detail → list → menu; tour settings → list → menu; proxy grid / folder
   search → textures → menu; value picker / import card → clashes → menu (→ clash mode when opened there). CLOSE from
   any level resumes the walkthrough.
6. Esc → Appearance → *Window size*: 720p. Open every panel and the pause menu (each settings tab, the water and grass
   pages, PREVIEW): nothing runs off the card; long content scrolls. Then 1080p, 1440p, Own.
7. Dropdowns and confirms in CLASHES, COMMENTS and COLOUR PROFILES still open over the panel and take the click.
8. CONTROLS: capture a key (the list doesn't scroll while waiting; the wheel can be bound), IMPORT / EXPORT / RESET ALL in
   the header.
9. Gamepad (as before): the stick moves the cursor, A clicks, B goes back, the other stick scrolls the region under the
   cursor.

## To verify (can't be checked here)

- `GameWindow.SetClientSize`: `ShowWindow(SW_RESTORE)`, `GetWindowRect` / `GetClientRect` frame maths, `SetWindowPos`.
- That nothing else called `Hover` from a static context (it is an instance method now).
