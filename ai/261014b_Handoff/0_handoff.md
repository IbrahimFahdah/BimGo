# BimGo: Handoff for a new chat (Round C continues: C-C grouping → clash reports XML / PDF → hotkeys → polish → installer)

**Context:** BimGo is Gavin's personal project (publisher **Aussie BIM Guru**, **MIT-0**, C# / Visual Studio, .NET 8,
own OpenGL renderer over Silk.NET). He works in **rounds**: discuss → stage questions with AskUserQuestion
(recommended option first, at most 4 per call) → build → deliver a zip + `ai/<yymmdd><letter>_<topic>/` notes
(`0_brief.md` with the answers, `1_build notes.md`) + README + a project doc (`claude/BimGo_<Round>_BuildNotes.md`).
Each build states **what is in, what isn't, and how to check it step by step** (README §8, newest first). For simple
build / test errors Gavin wants **just the fix** (a snippet), not a new zip. Gavin's weekly usage is tight at the moment:
size rounds sensibly and keep the token spend down (read only the files a build touches).

**Read first:**
1. This handoff.
2. `README.md`: *For AI assistants*, §3 controls (generated), §5 (the clash detection bullet: C-A … C-B4), §6
   (`clashes.json` incl. `groups` on sets, `comments.json` `clashId`), §8 (newest three), §9.
3. `ai/261014a_Clash_B4` (project doc `claude/BimGo_Clash_B4_BuildNotes.md`), `ai/261013b_Clash_B3`; older code map:
   `ai/261013c_Handoff/0_handoff.md` §4, `ai/261012g_Handoff/0_handoff.md` §5–§6.
4. **Ask Gavin for a fresh zip of his working copy before editing.** His copy is the source of truth.

---

## 1. Where BimGo is now (2026-10-14)

| Build | What it added | State |
|---|---|---|
| C-B2, C-B3 | Row pictures, TO COMMENT / UPDATE, SHOW IN REVIT, multi-select (Ctrl / Shift click), comments for the selection, MARKUP / pencil, Comments TYPE filter + ticks | **Built, README §8 checklists passed** (Gavin, 2026-10-14) |
| C-B4 (`261014a_Clash_B4`) | SELECT ALL SHOWN / Ctrl+A (focus all: amber for elements on both sides, box off above 200, R asks above 500, hash-set selection); search set **rule groups** (`RuleGroup`, ANY OF / ALL OF, one level, NOT inside a group = ordinary condition, top-level NOT still subtracts) | **Builds; tests pass** after one test fix: `ControlsTests.Describe_HelpText` now rebinds Move left to `Ctrl+K` (Ctrl+A is taken by `ClashSelectAll`; already in Gavin's copy and in this handoff zip). C-B4 README §8 checklist **not yet walked**: ask how it went |

## 2. Next: C-C clash grouping (answers taken 2026-10-14)

Gavin's answers (stage the remaining questions below, then build):
- **Model: Navisworks-style group row.** A named group is a row in the clash list that expands to its clashes; it has
  its own status, assignee and notes; setting the group's status sets every member's status.
- **First automatic grouping: by element.** One element hitting many (a duct through ten beams) → one group. Must
  handle elements that are A in some clashes and B in others. Level / proximity come later.
- **Comments / BCF: one per group.** One comment / BCF "Clash" topic per group: picture framed on all members (the
  union framing of `GoToSelectedClashes` / `ResolveSelectedClashes`), every element listed. Ungrouped clashes stay one each.
- **Re-runs: keep groups, no auto-add.** Groups persist across runs; resolved members stay in their group, marked
  resolved; new clashes stay ungrouped until grouped by hand or by running auto grouping again.

Suggested shape (confirm while staging):
- Core: `ClashGroup` { `Id`, `TestId`, `Name`, `Status`, `AssignedTo`, `Notes`, `ClashIds` (list), `Auto` (null / "element"),
  `KeyElement` (the shared element ref, for auto groups) } in `ClashDocument.Groups` (additive, `clashes.json`
  version 1; null when none). `ClashRecord.GroupId` optional (or derive from the groups; pick one source of truth:
  recommended **`ClashGroup.ClashIds` only**, with an index built on load).
- Core `ClashGrouping.ByElement(clashes, minSize: 2)`: count each element's clashes in the test (A and B sides),
  greedily take the element with the most ungrouped clashes, group them, repeat; never put a clash in two groups;
  name "<category / type> (<id>) × N clashes". Unit tests: duct × 3 beams → one group; two ducts sharing a beam (tie
  break deterministic); a clash already grouped is left alone; minSize.
- `ClashMerge` on a re-run: keep `ClashIds` that still exist (matched clashes keep their Id), resolved stay; drop ids
  of clashes that are gone? (question below).
- App: list rows: group row (chevron, name, count, status colour, worst status?) then members indented when
  expanded; click the group = select all its members (the C-B3 / C-B4 selection, union view); GROUP SELECTED (from the
  selection), UNGROUP, RENAME…, AUTO GROUP (by element) for the current test; 1–5 on a group row set the group and
  members; TO COMMENT on a group → one comment (`RenderClashPicture` with the group's members instead of
  `_clashMultiSuspended`), `CommentRecord.ClashId` = the group id (or a new `ClashGroupId`, additive); BCF topic lists all
  elements. Filters (status / level / search) apply to members; a group shows when any member shows.

Open questions to stage (the harder ones):
1. Group status rule: setting the group sets members (agreed); what does the **group show** when members differ
   (its own stored status, or the "worst" / least advanced member)? Recommended: stored status + a "mixed" mark.
2. Can a clash be in **only one group**? Recommended: yes (one group per clash; GROUP SELECTED moves clashes).
3. Members that **disappear** on a re-run (fixed in the model): remove from the group, or keep as resolved (current
   merge marks gone clashes resolved?) Check `ClashMerge` and follow its rule.
4. Empty / single-member groups: dissolve automatically? Recommended: a group with 0 members is deleted; 1 is allowed.
5. Groups across tests: recommended **per test** (`TestId`), as the list shows one test at a time.
6. Hand-picked groups via the Scan gun (pick elements → all their clashes): now or later?
7. Comment for a group that already has member comments: link, replace or leave? (`OpenChoice` pattern from C-B3.)

## 3. After grouping: clash reports (XML / PDF) — Gavin's next ask

"Clash reporting to XML / PDF formats from the platform." Not discussed yet; questions to stage then:
- **XML:** Navisworks-style clash report XML (`exchange` / `batchtest` / `clashtests` / `clashresults` / `clashresult`
  with `clashpoint`, `clashobjects`, status, assignee, grid / level, image href) so existing tooling can read it, or
  BimGo's own schema? Recommended: Navisworks-compatible layout (best effort; document what differs).
- **PDF:** one page per clash / group with the picture, A / B element details (category, family / type, id, level,
  model), status, assignee, notes, distance; a cover with test summary and counts by status / level. Library:
  **PDFsharp / MigraDoc (MIT)** fits MIT-0 better than QuestPDF (community licence terms): confirm; add to
  `THIRD-PARTY-NOTICES.txt`. Alternative: HTML report (self-contained, images embedded) which the user prints to PDF.
- Scope: which clashes (current list after filters / selection / whole test / all tests), grouped output (a section per
  group, from C-C), pictures (reuse cached clash pictures or render fresh at a set size), where it saves (beside the
  model, with the BCF export's folder logic), from the Clashes panel (REPORT… button) and the pause menu.
- Also HTML / CSV? (CSV is cheap and useful for Excel.)

## 4. Later

- **Hotkey review** (`claude/BimGo_RoundC_Handoff.md` §4; taken since: Y, G, B, 0, wheel = gun modes, Ctrl+A select
  all in clash mode; candidates: TO COMMENT, group / ungroup; C still free while walking).
- **Polish:** README §8 "to verify" (newest first), limitation candidates, trademark line (README, About / help,
  installer, `.bundle` description); gamepad buttons for clash G / B / PICTURES / select all and for unarmed; gamepad
  multi-select; more rule fields (parameters) for search sets; nesting groups deeper (`RuleGroup.Groups` reserved).
- **Installer:** `claude/BimGo_Installer_Handoff.md`.

## 5. Code map additions (C-B4)

- `Game/Clashes/GameSession.ClashSelection.cs`: `_clashSelectedLookup` (keep in step with `_clashSelected`:
  `SyncClashLookup`), `ToggleSelectAllShownClashes`, `ClashSelectAllLabel`, `_clashMultiBoth` (+ dynamic, amber),
  `CLASH_FOCUS_BOX_CAP` 200, `CLASH_REVIT_WARN` 500.
- `GameSession.ClashMode.cs`: `ShowClashInRevit(bool confirmed)`; Ctrl+A → `InputAction.ClashSelectAll`.
- `GameSession.ClashPanel.cs`: set editor lines (`_clashRuleLines`: top-level rules, then group header + rules),
  `BuildClashRuleRow`, `RemoveClashGroup`, ADD GROUP; four footer buttons.
- Core: `RuleGroup`, `SearchSet.Groups` / `AllRules()` / `NormaliseRules()` (in place), `SearchSets.GroupMatches`.

## 6. Things to watch

- C# can't be compiled in the sandbox: say so; check brackets / single declarations / `using`s by script; scan UI
  strings against the font atlas (Latin-1 + `UiFont.EXTRA`).
- Work out test expectations numerically before writing them.
- **New default keys can break `ControlsTests` that rebind to that chord** (C-B4: `Describe_HelpText` used Ctrl+A).
  Grep the tests for the chord before taking it. README §3 rows are generated (hand-edit in the exact format).
- Panels with overlays call `BeginOverlays` / `DrawOverlays`; Esc closes overlays first.
- Large selections / groups: no O(n²) (`List.Contains` in loops), no per-frame allocations, no per-element draw calls for thousands.
- `.bimgo` `formatVersion` 1, `clashes.json` version 1 and live protocol 1: additive only. Files written by Gavin's copy must still load.
