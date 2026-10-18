# BimGo: Handoff for a new chat (Round C continues: C-C grouping → clash reports → hotkeys → polish → installer)

**Context:** BimGo is Gavin's personal project (publisher **Aussie BIM Guru**, **MIT-0**, C# / Visual Studio, .NET 8,
own OpenGL renderer over Silk.NET). He works in **rounds**: discuss → stage questions with AskUserQuestion
(recommended option first, at most 4 per call) → build → deliver a zip + `ai/<yymmdd><letter>_<topic>/` notes
(`0_brief.md` with the answers, `1_build notes.md`) + README + a project doc (`claude/BimGo_<Round>_BuildNotes.md`).
Each build states **what is in, what isn't, and how to check it step by step** (README §8, newest first). For simple
build / test errors or small tweaks Gavin wants **just the fix** (a snippet), not a new zip.

**Read first:**
1. This handoff (all grouping questions are answered below: build straight away unless something in the code
   contradicts them).
2. `README.md`: *For AI assistants*, §3 controls (generated), §5 (the clash detection bullet: C-A … C-B4), §6
   (`clashes.json`, clash setup files, settings keys), §8 (newest four), §9.
3. `ai/261014a_Clash_B4` (C-B4), `ai/261016a_QOL` (clash report moved to clash mode, tests / sets files),
   `ai/261014b_Handoff/0_handoff.md` (the earlier grouping plan this one supersedes).
4. **Ask Gavin for a fresh zip of his working copy before editing** if he made compile fixes after the grass build.

---

## 1. Where BimGo is now (2026-10-16)

| Build | What it added | State |
|---|---|---|
| C-B4 (`261014a_Clash_B4`) | SELECT ALL SHOWN / Ctrl+A, search set rule groups | Built, tests pass |
| QOL (`261016a_QOL`) | Options PREVIEW, Appearance tab (was Debug), water / glass overrides, "None" for unarmed, slimmer pause buttons, **clash report moved to clash mode (REPORT…)**, **EXPORT / IMPORT TESTS… and SETS…** with link / level reconciliation, clash box off on leaving clash mode, sun ↔ study shortcuts | Gavin: "all perfect" |
| Sky A (`261016b_Sky_A`) | Procedural clouds, sun size / glare (sun panel SKY tab), clash mode on the gamepad, P row pictures, Tab preview, grass keywords, trademark line | Gavin: no frame-rate issues |
| Grass B (`261016c_Grass_B`) | Grass blades (Core `GrassField`, `SceneRenderer.Grass.cs`, `GameSession.Grass.cs`), Appearance pages (Water ›, Grass blades ›), water colour presets / custom and reflection | Gavin: "almost perfect" → one tweak applied: `GrassField.COVER_ABOVE` 2 m → **0.3 m** (grass stays under raised floors / decks; only surfaces within 300 mm above remove it); test `Covers_…` gained a deck case. **In this handoff zip.** |

## 2. Next: C-C clash grouping (all answers taken: 2026-10-14 and 2026-10-16)

**Model and behaviour (Gavin's answers):**
- **Navisworks-style group row** in the clash list; expands to its clashes; own status, assignee, notes; **setting the
  group's status sets every member's**.
- **Group status shown:** its **stored status + a MIXED mark** when members differ (counts on hover / in the card).
- **One group per clash.** GROUP SELECTED moves clashes out of their old group; auto grouping never touches grouped clashes.
- **Re-runs:** groups persist; **members that disappear stay in the group, marked resolved** (follow `ClashMerge`'s
  rule for gone clashes); **a group is deleted only when it has 0 members** (1 member allowed); **new clashes stay
  ungrouped** until grouped by hand or by running auto grouping again.
- **Per test** (`TestId`), as the list shows one test at a time. **Scan gun hand-picking: later** (not C-C).
- **First automatic grouping: by element** (one element hitting many → one group; handle elements that are A in some
  clashes and B in others). **Minimum 2 clashes.** Name: **"<category / type> (<id>) × N clashes"** (e.g.
  "Duct: Rect 600×300 (123456) × 7 clashes"); RENAME… changes it. Level / proximity grouping later.
- **Comments / BCF: one per group** (picture framed on all members: the union framing of `GoToSelectedClashes` /
  `ResolveSelectedClashes`; every element listed; BCF "Clash" topic lists all components). Ungrouped clashes stay one each.
- **TO COMMENT on a group whose members already have comments: ask** (the C-B3 `OpenChoice` pattern): **LINK**
  (members' comments stay; the group comment lists them), **REPLACE** (members' comments closed, pointing to the
  group's), **CANCEL**.

**Suggested shape (confirm against the code, then build):**
- Core: `ClashGroup` { `Id`, `TestId`, `Name`, `Status`, `AssignedTo`, `Notes`, `ClashIds` (list), `Auto` (null /
  "element"), `KeyElement` (`ClashElementRef`, auto groups), stamps like `ClashRecord` } in `ClashDocument.Groups`
  (additive; `clashes.json` stays version 1; null when none). **Single source of truth: `ClashGroup.ClashIds`**, with
  an index (clash id → group) built on load / change; `Clean()` drops unknown ids, duplicates across groups (first
  wins) and empty groups.
- Core `ClashGrouping.ByElement(clashes, minSize: 2)`: count each element's ungrouped clashes in the test (A and B
  sides, keyed by link + UniqueId / clone key), greedily take the element with most, group them, repeat; never a clash
  in two groups; deterministic tie-break (element key ordinal). Unit tests: duct × 3 beams → one group; two ducts
  sharing a beam (tie-break); already-grouped clash left alone; minSize; an element A in one clash and B in another.
- `ClashMerge` on a re-run: matched clashes keep their ids (so membership survives); gone clashes → resolved, stay
  in their group; group with 0 members deleted. `ClashMerge.ResetTest` also removes the test's groups.
- `ClashSetupFiles` (tests / sets files): **no groups** (they are results, like clashes). The clash report
  (`bimgo-clash-report`, REPORT… in clash mode) **does** carry groups (they live in `ClashDocument`); `ImportReport` /
  `Merge`: add missing groups, newer stamps win for status / assignee / notes, membership merged by clash id.
- App (`Game/Clashes/`): list rows: group row (chevron, name, member count, status colour, MIXED mark) then members
  indented when expanded; click the group = select all its members (C-B3 / C-B4 selection and union view); buttons:
  **GROUP SELECTED**, **UNGROUP**, **RENAME…**, **AUTO GROUP** (by element, current test; toast with counts);
  1–5 on a group row set the group and members; ASSIGN… / NOTES… on the group card; TO COMMENT on a group → one
  comment (`RenderClashPicture` with the members instead of `_clashMultiSuspended`), `CommentRecord.ClashGroupId`
  (new, additive) or `ClashId` = the group id (pick one and document it); BCF topic lists all elements.
  Filters (status / level / search) apply to members; a group shows when any member shows (and shows the visible count).
  Expanded state per session. Hotkeys: candidates **Ctrl+G** group selected / **Ctrl+Shift+G** ungroup (check
  `ControlsTests` for chords first; G is the clash view key); gamepad later.
- Performance: thousands of clashes: index lookups (no `List.Contains` in loops), rows rebuilt only when dirty, no
  per-frame allocations.

## 3. After grouping: clash reports (answers taken 2026-10-16)

Outputs wanted: **Navisworks-style XML**, **HTML** (self-contained, images embedded, print to PDF) and **PDF via
PDFsharp / MigraDoc (MIT)**: Gavin ticked PDF, so the package is wanted; confirm the exact pinned version with him
and add it to README §10 and `THIRD-PARTY-NOTICES.txt` (rule 5: new packages need an explicit yes, a permissive licence,
a pinned version). CSV not asked for. Reporting gets **its own menu area** (customisable), launched from clash mode's
REPORT… dropdown (beside EXPORT / IMPORT REPORT…). Questions still to stage then: scope (current list after filters /
selection / whole test / all tests), grouped output (a section per group), pictures (cached row pictures or fresh at a
set size), what fields / columns, cover page contents, where it saves.

## 4. Later

- **Hotkey review** (`claude/BimGo_RoundC_Handoff.md` §4). Taken since then: Y, G, B, 0, P (clash pictures),
  Ctrl+A (clash select all), Tab (pause-menu preview; new `InputContext.PauseMenu`), wheel = gun modes; gamepad clash
  bindings D-pad ↑ / ↓, RB+X, Back, RB+B (None), Y (preview).
- **Polish:** README §8 "to verify"; more search set rule fields (parameters); deeper rule groups
  (`RuleGroup.Groups` reserved); Appearance → colour by parameter value / by search set (placeholders in place);
  grass on moved / hidden elements, grass in probes; per-frame cost check of grass on integrated GPUs.
- **Installer:** `claude/BimGo_Installer_Handoff.md` (add the trademark line to the `.bundle` description; the
  `.addin` vendor is now AussieBIMGuru).

## 5. Code map additions (2026-10-16)

- Clash: `Core/Clashes/ClashSetupFiles.cs` (tests / sets files: Build, Parse, Plan, Apply, Reconcile);
  `Game/Clashes/GameSession.ClashSetup.cs` (export / import, the reconcile card); `ClashDock.cs` REPORT… dropdown
  (`DROP_DOCK_REPORT` 15, `_clashReportAction`); `ClashPanel.cs` footer per tab; `ClashMode.cs` `ExitClashMode`
  clears the box; P → `ToggleClashThumbnails`.
- Materials: `Core/Scene/MaterialOverrides.cs` (keywords, water rule `Look`, `WATER_PRESETS`); `SceneMaterial.SeeThrough`;
  Revit `ReflectivityReader.Configure`; `MaterialTextures.RefreshTable`.
- Sky: `Shaders.CLOUD_GLSL`, `SkyLook`, `GameSession.Sun.cs` SKY tab / `AdvanceSky`.
- Grass: `Core/Scene/GrassField.cs`, `Rendering/SceneRenderer.Grass.cs` (texture unit 14), `Game/GameSession.Grass.cs`.
- UI: `Game/GameSession.Appearance.cs` (tab pages, `PageRow`, `KeywordRow`, preview); `MenuButton(compact:)`.
- Slider ids in use: 0–2, 10–17, 20–26, 40–43, 51–53. Dropdown slots: dock 11–15, import card 100+.

## 6. Things to watch

- C# can't be compiled in the sandbox: say so; check brackets / single declarations / `using`s by script; scan UI
  strings against the font atlas (Latin-1 + `UiFont.EXTRA`).
- **Shaders can be checked:** pull them out of `Shaders.cs` (a small Python evaluator of the const string
  concatenations), swap `#version 330 core` for `#version 300 es` + precision lines, compile / link in headless WebGL2
  (Playwright + `/opt/pw-browsers/chromium`, `--use-angle=swiftshader`), and render a test frame to look at.
- Work out test expectations numerically before writing them.
- New default keys can break `ControlsTests` that rebind to that chord: grep the tests first. README §3 rows are
  generated (hand-edit in the exact format; the test regenerates and reports Inconclusive when they differ).
- Panels with overlays call `BeginOverlays` / `DrawOverlays`; Esc closes overlays (and the import card) first; dialog-
  opening actions run after `DrawOverlays`.
- `.bimgo` `formatVersion` 1, `clashes.json` version 1 and live protocol 1: additive only.
