# Round C, build C-B (clash review): brief

Follows build C-A (`ai/261012e_Clash_A`), confirmed by Gavin 2026-10-12: "the run / register clashes worked … we are
getting clashes. We will now need custom tests etc. so let's keep going." No compile fixes were needed on his side, so
C-B was built on the A2 copy.

## Answers (2026-10-12)

| # | Question | Answer |
|---|---|---|
| 1 | Set rule values | Pick from the model's values (searchable, with counts); typing still allowed for "contains" |
| 2 | GO camera | ~2.5 m back. Gavin: "ideally we have light thumbnail and the viewer is side docked whilst we fly around so we can look at it but work through them, maybe even fly between clashes or flick to them … want to understand where we are. I guess grouping will help with that" |
| 3 | GO section box | Clash region + 1 m all round |
| 4 | Docked mouse | Free cursor, RMB-drag looks (like photo mode / the study) |
| 5 | Moving between clashes | Quick fly (~0.8 s, longer for far ones, capped ~2 s), setting for instant |
| 6 | Thumbnails | Rendered lazily for visible rows, cached (C-B2) |
| 7 | Orientation | Clash markers in the model, "ideally not baked in, preview-ish"; "maybe ability to cast section box in Revit to match scope of clash and we can use R for switchback already anyway on element scan" |
| 8 | Revit | R selects the pair; SHOW IN REVIT also sets a 3D view's section box (C-B2) |
| 9 | Mode keys | `,` / `.` next, Enter re-frame, 1–5 status, R Revit; gamepad D-pad ← / →, A clicks; rebindable |
| 10 | To comments | One at a time + all shown in the list (C-B2) |
| 11 | Filters | Status, level, search text |
| + | Split | Two zips: C-B1 then C-B2. Gavin: "2 rounds is fine … just make it clear to me what is in and what isn't at end of first round and what to check for to verify it is progressively successful" |

## Decisions in this build (say if you want them changed)

- The docked clash mode replaces the planned walking "clash bar" (Gavin's docked-viewer idea).
- Y toggles clash mode; Esc → CLASHES is the manager (tests, sets, run, reports). REVIEW in the manager and clicking
  TESTS… in clash mode move between the two.
- Clash mode flies with its own up / down keys (Space / E, Ctrl / Q) so the gamepad's A / B keep clicking / going back.
- The camera direction ignores line of sight: with everything else ghosted, nothing can hide the pair.
- The pair is drawn even when its category is hidden; demolished elements aren't drawn.
- Leaving clash mode keeps flying (no drop) and the section box.
- A host + linked pair selects only the linked element in Revit (selecting both needs an add-in change: C-B2).
