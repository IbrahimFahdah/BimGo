# Round C, C-B1 fixes: brief

Follows build C-B1 (`ai/261012f_Clash_B1`), which builds and runs (Gavin, 2026-10-12: "decent"). This build is the
first item of the handoff `ai/261012g_Handoff` §2: Gavin's nine C-B1 fixes, before C-B2. Built on his zip
`BimGo_Handoff_C2.zip` (C-B1 with its two compile fixes).

## Answers (2026-10-12)

| # | Question | Answer |
|---|---|---|
| 4a | Clash view modes | Ghost / wireframe / real / hidden, one key cycles all four (wireframe: GL line mode over the batches in the ghost colour) |
| 4b | Toggle keys | G cycles the view, B toggles the section box (Clashes group only) |
| 4c | Box back on shows | The current clash's box (GO / next also turn it back on) |
| 8a | Old exclude rules | Fold into the NOT operators (old Exclude loads as IS NOT / DOES NOT CONTAIN; `formatVersion` stays 1) |
| 8b | NOT logic | NOT rules always subtract (adding rules combine by ANY / ALL as before) |
| 5/9 | Confirms | In-panel confirm; a first run doesn't ask; "Don't ask again this session" for re-runs; resets always ask |
| 9 | Reset data | Start clean (assignees, notes and comment links go; the confirm says so) |
| 6 | Set A = set B | Allowed, shown as "against itself"; B is stored as picked and never changed for you |

## Decisions in this build (say if you want them changed)

- The dropdown is a general widget (`GameSession.Overlays`), modal for the panel that opened it: an open list takes
  that frame's click and wheel, a click outside closes it without acting on what's under it (like a Windows combo).
- Set B's list starts with "(set A against itself)"; picking set A's own set also reads "· against itself" but keeps
  the pick, so moving A away brings the A × B test back.
- ADD RULE adds "BimGo category · IS · (nothing picked)"; a rule with no value (or empty "contains" text) is left out
  of matching until it has one, so the set's count doesn't jump to "every element" or "nothing".
- Changing a rule's operator keeps its values (a single-value operator keeps the first); changing the field clears them.
- The "not" operators are underlined red on the rule row.
- RESET RESULTS… sits in the test editor's button row (RESET… when the panel is narrow); RESET ALL… sits with the
  bottom buttons (red outline).
- Real model view keeps shadows, AO, section caps and glass, and tints the pair over it like the Scan gun's highlight.
- Wireframe lines are the triangles' edges at 40 % opacity (flat faces show their diagonals): it's a cheap pass over
  the existing batches, no new geometry.
- B turned off stays off while you look around; GO / `.` / `,` / Enter put the box back round the new clash.
- Extra glyphs added to the font atlas while there: ≤ ≥ ‹ › ↔ (used by the clash rows, the sun hours legend and the
  Holding controls row).
