# Round C (clash detection): brief

Plan and staged questions: `claude/BimGo_RoundC_Handoff.md` §3 (project doc; `ai/261012d_Handoff`), full scope in
`claude/BimGo_Final_Rounds_Handoff.md` §2 Round C. Gavin supplied the B2-C working copy (`BimGo_Handoff_C.zip`).

## Status before the round (2026-10-12)

- C3 fix (CONTROLS gamepad row): "looks right, we will revisit as I need to get a better controller, leave until later".
- MAP BUTTONS with the generic pad: worked.

## Answers (2026-10-12)

| # | Question | Answer |
|---|---|---|
| 1 | Default tolerances | Hard: ignore ≤ 5 mm; clearance: 50 mm (shown in display units, stored in metres) |
| 2 | Starter tests | Seed Structure × Services and Services × Services, editable |
| 3 | Activation | Y toggles clash mode, plus pause menu CLASHES (Y settled again in the hotkey review) |
| 4 | Review UI | Pause-menu list panel + a slim clash bar while walking after GO (bar in C-B) |
| 5 | Bar keys | `,` / `.` next / previous, Enter GO, Alt+1–5 status; gamepad LB+RB with D-pad ← / →, A clicks; all rebindable (C-B) |
| 6 | Ghosting on GO | Everything else 15 % grey, see-through, no shadows; the pair red / green (C-B) |
| 7 | GO's section box | Kept until Ctrl+P / the next GO (C-B) |
| 8 | Run limit | Stop a test at 10,000 clashes with a notice; no time limit, CANCEL any time |
| 9 | First grouping | By element (one duct hitting many beams) (C-C) |
| 10 | Geometry tested | The model as walked: moved elements where they are, clones / placements in, demolished / deleted out; hidden elements still tested (sets decide) |
| 11 | Folders | New `src/BimGo.Core/Clashes/` and `src/BimGo.App/Game/Clashes/` |
| 12 | Clearance and crossings | Clearance tests also report crossings, tagged |
| 13 | Re-run | RUN when asked; show "model changed since the last run" |
| 14 | Split | C-A engine (sets, tests, worker, storage, report, Core tests) → C-B review (panel editing, GO, ghosting, statuses, clash bar, comments / BCF) → C-C grouping + parameter / hand-picked sets |

Gavin also said, during the round:
- "Need to find ways to keep this efficiently scalable, but clash detection mode can be dormant until activated."
- "If you draw on any third party sources, check licenses and permissions, same as usual, add to third party notices
  if needed. Try not to blatantly rip off other similar clash platforms if possible, and we want BCF handling
  maintained and potentially integrated to the process later for report output by group / image for issues, e.g.
  clash visual mode may persist in BCF exports for the image."
