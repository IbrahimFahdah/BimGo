# Polish round P, build P-A2: brief (2026-10-18)

From the handoff `ai/261017l_Handoff/0_handoff.md` (after P-A1). Baseline: `BimGo_Polish_PA1.zip` (Gavin's working copy
after P-A1, confirmed "perfect").

## Answers already given (P-A)

- Split A1 / A2; pixel scroll, clipped; centred cards + side card (A1).
- **Gamepad: both.** The D-pad shows a focus ring and moves between controls, A presses the focused control; moving the
  stick hides the ring and the cursor takes over again; LB / RB switch tabs.

## Answers (AskUserQuestion, 2026-10-18)

| Question | Answer |
|---|---|
| Where the docks sit | **Shared right column:** one dock slot under the minimap, 340 wide (the study a bit wider), filling down to the sun icon; the body scrolls on short windows; one dock at a time; the gun panel hides as before |
| The F1 sheet | **Bottom of the left column:** it stays bottom-left as part of the column stack; while it's open the legends above it collapse to their title rows |
| D-pad navigation in the catalogue | **Fixed for now:** menus / cursor modes only; LB / RB switch tabs only when tapped alone (chords keep working); P-B can make them rebindable |
| The clash dock's scroll bar | **Move it now** onto `ScrollRegion` (wheel, drag, scroll-into-view; jump-to-current kept) |

## Scope

a. Compact dock variant (`DOCK_WIDTH`, `DOCK_HEADER_HEIGHT`) for Sun, Sun hours study, Section box, Grids; the clash
   dock gets the dock header and `ScrollRegion`.
b. HUD columns: left = information (status, coordinates, colour legend, sun legend, F1), legends stack and collapse;
   right = tools (minimap, gun panel, docks, clash dock).
c. Gamepad reach: D-pad focus ring, A presses, B back, LB / RB tabs.
