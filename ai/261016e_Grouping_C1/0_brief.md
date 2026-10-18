# C-C clash grouping: brief (2026-10-16; build C-C1 in this folder)

Adds to `claude/BimGo_RoundC_C3_Handoff.md` §2 (model and behaviour unchanged: Navisworks-style group rows, one group
per clash, stored status + MIXED, groups persist across re-runs, per test, one comment / BCF topic per group with
LINK / REPLACE / CANCEL). This brief adds the ways of **making** groups.

## Answers

| Question | Answer |
|---|---|
| Right-click menu | **New context menu on the clash list (clash rows and group rows), keep dock buttons.** Menu: GROUP SELECTED, ADD TO GROUP ›, REMOVE FROM GROUP, MERGE GROUPS, RENAME…, UNGROUP, GROUP ALL ON <A> / <B>. Dock keeps GROUP / UNGROUP / AUTO GROUP ▾. Opens over the list only: right-drag in the view still looks around. |
| All clashes on one element | **From a clash row:** right-click > GROUP ALL ON <A name> / <B name>, which takes every clash in the test touching that element (A or B side). No 3D pick for this. |
| Box grouping: setup | **Section-box handles:** GROUP BY BOX… starts a box around the selected clashes (or in front of the player), resized with the existing face handles; a **GROUP IN BOX (n)** bar confirms, with a live count. |
| Box grouping: rule | **Clash point inside the box.** |
| Point pick mode: display | **Dots seen through walls** for every clash the list shows: status colour, dimmer when hidden behind something, bigger with a label on hover, amber with a ring when picked; nearest 2,000 drawn. |
| Point pick mode: pick and commit | **Pending set + COMMIT.** Click toggles, Ctrl+drag marquee adds; the bar shows "n picked: NEW GROUP / ADD TO <group> › / CLEAR"; Enter commits to a new group, Esc leaves; the list selection mirrors the picks. |
| Manual methods catching grouped clashes | **Move them and say so** ("n moved from other groups"), as GROUP SELECTED does. Auto grouping still never touches grouped clashes. |
| Extra auto groupings | **Proximity clusters** (default 1 m, adjustable), **by level**, **by category pair** (plus level + category pair) alongside by element. |
| Auto UI | **AUTO GROUP ▾ dropdown**, one method per run, ungrouped clashes only, so runs can be chained. |
| Merge | **First picked wins** for name / status / assignee / notes; other groups' notes are appended under their names; MIXED shows if members differ. |
| Pick mode key | **PICK POINTS button**; check `ControlsTests` for a free key and suggest one in the notes, without binding it. |
| Split | **C-C1 core, C-C2 tools.** |

## C-C1 (core)
`ClashGroup` model in `ClashDocument.Groups` + index, `Clean()`; `ClashMerge` (re-runs, `ResetTest`), report import /
merge; `ClashGrouping.ByElement` + `ForElement(key)`; list group rows (chevron, count, status, MIXED, visible count
under filters), expand per session; **context menu widget** (`BeginOverlays` / `DrawOverlays`, Esc closes); GROUP
SELECTED / ADD TO / REMOVE FROM / MERGE / RENAME / UNGROUP / GROUP ALL ON A·B; AUTO GROUP ▾ (By element only in
C-C1); 1–5 / ASSIGN / NOTES on groups; group comments / BCF (LINK / REPLACE / CANCEL); Ctrl+G / Ctrl+Shift+G if the chords are free.

## C-C2 (tools)
GROUP BY BOX… (section handles, point-inside, live count); PICK POINTS mode (dots through walls, pending set,
marquee, commit bar); AUTO GROUP ▾ adds Proximity (distance), By level, By category pair, Level + category pair
(Core, unit tested: deterministic, ungrouped only, minimum 2).
