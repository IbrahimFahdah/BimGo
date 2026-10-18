# Colour profiles, build B: brief (2026-10-17)

Gavin: build A was "amazing"; it compiled with no changes. He reported one graphical anomaly with boxes (a clash mode screenshot: dark slabs and black plant shapes). "If it's an easy fix, cool." Then build B. After B, a handover to a briefing chat for further ideas and a possible UI cleanup.

The anomaly: section box caps. The stencil pass still counted ghosted elements as solid, so their cut faces were filled in the dark cap colour.

## Answers (AskUserQuestion)

| Question | Answer |
|---|---|
| Base copy | **No changes**: build on the build A zip |
| Gradient | **Equal bins + ramp**: min to max in N equal ranges (default 5, 2–12), ramps Blue → red / Green → red / Cool → warm (plus Light → dark), each bin's colour editable, non-numeric values unmatched |
| Hide per row | **Not drawn, not picked**: like hidden elements (no drawing, no picking, no collision) while the profile shows; never touches saved hidden elements |
| Export | **Selected profile + its sets**: one or all profiles; by-set profiles carry their sets, matched by name on import (missing ones added) |

From build A's answers: numeric operators (≥ / ≤ / between), transparency per rule, legend in photos / screenshots, import / export.
