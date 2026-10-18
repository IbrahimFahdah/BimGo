# Polish round P, build P-A1: brief (2026-10-17)

From the roadmap brief (`claude/BimGo_Roadmap_Polish_Flythrough_Brief.md`, agreed 2026-10-17): Round P (polish) first, then
Round K (keyframed flythrough), then Round X (extras). P-A is the UI panel shell, HUD columns, 720p fit and gamepad reach.
Baseline: `BimGo_Colour_B.zip` (Gavin's working copy after colour profiles B).

## Answers (AskUserQuestion)

| Question | Answer |
|---|---|
| Split | **P-A1 then P-A2.** A1: shell + spacing tokens + clipped scroll + the nine big panels + the 720p check toggle. A2: the compact dock variant (sun, sun hours, section, grids, clash dock), HUD columns, D-pad focus ring and LB / RB tabs |
| Placement | **Centred, two widths + side:** standard (~1000 px) and wide (~1180 px: CLASHES, LIBRARY, CONTROLS) centred cards; COLOUR PROFILES keeps the right-side card so the model shows |
| Scrolling | **Pixel scroll, clipped:** smooth scroll with a draggable thumb; rows cut at the edge are clipped and can't be clicked (clipping added to the UI batch) |
| Gamepad (P-A2) | **Both, ring on the D-pad:** the D-pad shows a focus ring and moves between controls, A presses it; moving the stick hides the ring and the cursor takes over; LB / RB switch tabs |

## Scope of P-A1

- `UiBatch` clipping (CPU, as shapes are queued: rectangles, glyphs and images cut with their UVs, triangles cut to polygons).
- `UiTheme` spacing tokens (panel widths, margins, padding, header / footer / notice heights, gaps, row and control heights,
  scroll bar, wheel step, dock sizes for A2).
- `GameSession.PanelShell.cs`: `BeginPanel` (card, header: title, sub-line, right-hand controls) · `ScrollRegion`
  (`BeginScroll` / `EndScroll`, `VisibleRows`, `InView`) · `FooterAction` + `EndPanel` (notice / hint strip; ← BACK ·
  actions · CLOSE; overlays) · `PanelBack` (Esc, B, ← BACK: one level back) · `ClosePanelToGame` (CLOSE) · `ShellButton`
  · the window-size check.
- The nine panels on the shell; the pause menu's settings card scrolls when short (RIGHT_CARD_HEIGHT and the options
  preview maths go through `SettingsCardHeight`).
