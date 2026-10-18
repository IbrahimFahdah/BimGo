# Polish round P, build P-B: brief (2026-10-18)

From the handoff `ai/261018a_Handoff/0_handoff.md` (after P-A2). Baseline: `BimGo_Polish_PA2.zip` (Gavin's working copy
after P-A2, confirmed "all works well").

## Answers (AskUserQuestion, 2026-10-18; all the recommended options)

| Question | Answer |
|---|---|
| How far the keyboard defaults move | **Targeted fixes.** Walking letters stay. PICK POINTS → **K** in clash mode. **Reserve the path-editor situation now** (K add key, Delete delete key, Space preview, ← / → previous / next key) so the clash test covers Round K. Move only the odd one-offs the review finds. |
| Gamepad for the actions without one | **LB / RB chords**, the existing pattern. Walking: LB+X / RB+Y style chords for grids, colour profile and bookmarks. Clash mode: LB+D-pad for grids / colour profile, RB+A / RB+B group / ungroup, LB+A cycles the status. `ControlsTests` checks for clashes. |
| F1 sheet per mode | **Generated, short:** built from the catalogue for the current situation; about 12–16 of the most-used actions; a key column and a pad column (pad while one is connected); a last row "Esc → CONTROLS for all". It follows rebinds. |
| How changed defaults show | **Toast + CONTROLS marks:** a one-time toast after the update ("Controls: N defaults changed · Esc → CONTROLS"); a NEW / CHANGED tag on those rows in CONTROLS; RESET ALL lists what it will change before you confirm; user rebinds that now clash with a new default are flagged. |

## Scope

a. Catalogue: PICK POINTS action (K), a status-cycle action (LB+A), the path editor group and situation (reserved),
   gamepad defaults for the actions named in the answers plus the case-by-case ones.
b. Generated F1 sheet: rows per situation in the catalogue, `CurrentSituation()` in the app, key / pad columns.
c. Changed defaults: `DEFAULTS_VERSION` + `DefaultsChanges` table, settings `ControlsDefaultsVersion`, toast, tags,
   RESET ALL confirmation, clash flags.
d. Tests: the table matches the defaults, F1 rows are live where shown, the path editor is clash-free.

## Decision taken in the build (flagged)

The answer put grids / colour profile on **LB+D-pad in clash mode** but on **LB / RB + face buttons walking**. They are
the same actions (live in both), and an action has one gamepad binding, so one chord has to serve both. LB+D-pad is full
walking (shadows, lights, coordinates, home), so the build uses LB+Y (grids cycle), RB+Y (colour profile) and LB+B (grids
panel) everywhere; LB+D-pad stays free in clash mode for later.
