# BimGo: Handoff for a new chat (Round C: C-B1 fixes → C-B2 → C-C → hotkey review → polish → installer)

**Context:** BimGo is Gavin's personal project (publisher **Aussie BIM Guru**, **MIT-0**, C# / Visual Studio, .NET 8,
own OpenGL renderer over Silk.NET). He works in **rounds**: discuss → stage questions with AskUserQuestion
(recommended option first, at most 4 per call) → build → deliver a zip + `ai/<yymmdd><letter>_<topic>/` notes
(`0_brief.md` with the answers, `1_build notes.md`) + README + a project doc (`claude/BimGo_<Round>_BuildNotes.md`).
He wants each build to state clearly **what is in, what isn't, and how to check it step by step** (README §8).

**Read first:**
1. This handoff.
2. `README.md`: *For AI assistants*, §3 controls (generated), §5 (the clash detection bullet: C-A then C-B1), §6
   (`clashes.json`), §8 (C-B1 checklist, limitations), §9.
3. Round C notes: `ai/261012e_Clash_A`, `ai/261012f_Clash_B1` (project docs `claude/BimGo_Clash_BuildA_BuildNotes.md`,
   `claude/BimGo_Clash_BuildB1_BuildNotes.md`) and the agreed scope in `claude/BimGo_Final_Rounds_Handoff.md` §2.
4. **Ask Gavin for a fresh zip of his working copy before editing.** His copy is the source of truth.

---

## 1. Where BimGo is now (2026-10-12)

| Build | What it added | State |
|---|---|---|
| Input B2-A / B / C, C3 fix | Action map, CONTROLS, gamepad, generic pads + MAP BUTTONS | Confirmed (C3 looks right; revisit with a better controller later) |
| Clash C-A (`261012e_Clash_A`) | Engine (search sets, hard / clearance, sweep and prune, parallel triangle tests, depth estimate, model as walked), merge across runs, `clashes.json` (dormant until used), EXPORT / IMPORT REPORT, simple CLASHES panel | **Confirmed** ("run / register clashes worked … we are getting clashes"); A2 fixed `ClashMerge.Apply` setting the test id before keying |
| Clash C-B1 (`261012f_Clash_B1`) | CLASHES manager (TESTS / SETS editors, model value picker), clash mode on Y (docked list, filters, search, GO flight, clash section box, red / green pair over ghosted model, statuses 1–5, assignee / notes, markers, R selects in Revit) | **Builds and runs** ("decent"). Two compile fixes were needed (both already in the zip): `using BimGo.Scene;` in `GameSession.ClashDock.cs`, and `ShowLinkedElements` declared on the `ILiveLink` interface (`LiveSessionSource.cs`). Issues below |

## 2. First: C-B1 fixes (Gavin's list, 2026-10-12), before C-B2

Do these as the first build of the next chat (stage questions only where marked).

1. **Cursor sometimes invisible when coming back to clash mode.** Cause found: `GameSession.SetPaused(false)` captures
   (hides) the mouse unless the sun panel / study is open; clash mode isn't excluded, so TESTS… → BACK TO CLASH MODE,
   Esc chain closes, or resuming after focus loss captures it. Fix: add `&& !_clashModeOn` there (check the photo /
   section editors too, and every other `SetCaptured(true)` path while clash mode is on).
2. **◀ / ▶ show as "?" in the UI and pickers.** Cause found: the UI font atlas only has Latin-1 plus
   `Rendering/UiFont.cs` `EXTRA` (`Δ − — – … • ↑ ↓ ← → “ ” ’ ≈`). Either add `◀ ▶` (and anything else new, e.g. `×` is
   Latin-1 and fine) to `EXTRA`, or use `←` / `→`. Grep the clash files for other non-Latin-1 characters.
3. **Test selector: a combo box instead of ◀ ▶** (clash mode's docked panel, and probably SET A / SET B in the test
   editor). There is no combo widget yet: build a small dropdown (click → list overlay with the choices, wheel scroll,
   click picks, Esc / click outside closes), reusable for sets, filters and rule fields.
4. **Clash view toggles:** section box on / off, and **wireframe vs real model** (the ghost) while in clash mode.
   Needs a line pass for wireframe (there is no wireframe renderer yet; options: `glPolygonMode(GL_LINE)` over the
   static batches with the ghost colour (GL 4.1 core supports it), or the AO pre-pass edges). Ask: which modes (ghost /
   wireframe / real model / hidden), keys (they go in the `Clashes` group), whether the section toggle restores the
   clash box or the user's previous cut.
5. **Confirm before re-running** a test that already has results (a re-run moves new → active and resolves missing
   ones): a confirm dialog / in-panel question for RUN and RUN ALL ("Re-run 2 tests with results? New clashes found
   before become active; ones not found become resolved."), maybe with "don't ask again this session". Ask the wording
   and whether a first run asks too (recommended: no).
6. **Tests sometimes revert to "set A against itself" instead of keeping the A / B sets.** Not reproduced yet.
   Suspects: `ClashTest.IsSelfTest` is true when `SetB == SetA` (stepping SET A onto SET B's set turns it into a self
   test, and stepping B then starts from "itself"); `StepSetId(test.IsSelfTest ? null : test.SetB, …)` in
   `GameSession.ClashPanel.cs`; NEW TEST when fewer than two sets exist. Fix: keep A and B independent (store B
   explicitly; "itself" only when the user picks it; maybe refuse / warn A == B), and add a Core test for the round
   trip of a test's sets.
7. **ADD RULE shouldn't open the category picker:** add the rule row (default field, empty value) and let the user
   change the field / operator / value; the picker opens only from the value button.
8. **Rule operators:** IS, **IS ONE OF**, **IS NOT**, **IS NOT ANY OF** (plus CONTAINS, and probably DOES NOT CONTAIN).
   Model change (additive, no format bump): `SetRule` gains `Op` (`is`, `isOneOf`, `isNot`, `isNotAnyOf`, `contains`,
   `notContains`) and `Values` (list); old files map `Contains` → contains, `Exclude` → keep as is (exclude rules stay
   a separate idea, or fold into the NOT operators: ask). The value picker becomes multi-select (ticks) for the
   *one of / any of* operators. Update `SearchSets.Matches`, `Describe`, the rule row UI, Core tests and README §5 / §6.

9. **Reset clash runs** (Gavin, added at handover): clear a test's results so the next RUN starts fresh (all New).
   `ClashMerge.RemoveTest` already removes a test with its clashes and runs; add `ResetTest` (keep the test, drop its
   clashes, run history, `LastRunUtc` / `LastRunModel`), a RESET RESULTS button in the test editor and RESET ALL
   (with the same confirm style as item 5), a Core test, README. Ask: keep assignee / notes / comment links of clashes
   that come back (by key) or start clean (recommended: clean, with the confirm saying so); per test and all.

## 3. Then C-B2 (agreed in the C-B round, not built)

- Row thumbnails in the docked list: rendered lazily for visible rows (160 × 90, a few per frame, cached for the
  session; the visited one refreshes), using the clash view.
- **TO COMMENT** (current clash → a comment with the clash view, section and picture; `ClashRecord.CommentId` links
  them) and **TO COMMENTS** (every clash the filters show, with a confirm; pictures rendered over frames), so EXPORT BCF
  carries clashes with images (Gavin: the clash visual mode may persist in BCF images; later BCF report output by group).
- **SHOW IN REVIT** (live): one optional live message; Revit makes / reuses a 3D view named "BimGo clash", sets its
  section box to the clash region and shows the pair; also select a host + linked pair together (`SelectLinked` taking
  host references too). Add-in change in `Live/LiveDispatcher.cs`; protocol stays version 1 (additive message; older
  add-ins time out with a hint).

## 4. After that

- **C-C:** grouping (by element first: one duct hitting many beams; then level / proximity; prototype with Gavin),
  extra-parameter rules, hand-picked sets via the Scan gun, BCF report output by group with images.
- **Hotkey review** (questions in `claude/BimGo_RoundC_Handoff.md` §4; Y is clash mode now, C is still free).
- **Polish:** README §8 "to verify" (newest first), the limitation candidates, the trademark line (README, About /
  help, installer, `.bundle` description).
- **Installer:** `claude/BimGo_Installer_Handoff.md`.

## 5. Clash code map (for orientation)

- Core `src/BimGo.Core/Clashes/`: `ClashModels` (document, sets, rules, tests, records, runs, defaults, keys),
  `SearchSets` (matching, values in the model, descriptions, starter sets), `ClashGeometry`, `ClashEngine` (+
  `ClashTree`), `ClashMerge` (records, merge, statuses, `ElementKey`), `ClashFiles` (storage, report), `ClashFraming`
  (section box + camera).
- App `src/BimGo.App/Game/Clashes/`: `GameSession.Clashes` (dormant switch-on, items as walked, runs, reports),
  `GameSession.ClashPanel` (CLASHES manager), `GameSession.ClashMode` (enter / leave, GO, flight, statuses, Revit,
  clash view draw, markers), `GameSession.ClashDock` (docked panel, list, filters, search, card).
- Elsewhere: `InputCatalog` (`Clashes` group + "Clash mode" situation, `ClashMode` = Y), `Shaders.cs` (`uGhost`),
  `SceneRenderer.GhostAlpha`, `GameSession.Render` (clash view branch, clash HUD, markers), `GameSession.Menu`
  (`BeginTextEdit`), `Player.FixedUpdate` (fly up / down actions), `LaunchSettings.ClashInstantFly`,
  `ILiveLink.ShowLinkedElements`. Tests: `tests/BimGo.Core.Tests/ClashTests.cs` (20).

## 6. Things to watch

- **Windows file names are case-insensitive:** check `find -iname` before adding files.
- `GameSession` (~40 partials, now incl. `Game/Clashes/`) and `SceneRenderer` are split across partials: scan all for
  duplicate member names.
- `UpdateFrame` order: pad mapping / key capture → tour → markup → comment editor → study → photo → section → sun panel
  → **clash mode** → guns. `InputCatalog.Situations` must follow it.
- New keys go into `InputCatalog` (README §3 is generated by `ControlsTests`; hand-written rows must match its format).
- New interface members: declare them on the interface too (`ILiveLink`), not just the class.
- UI text: only characters in the font atlas (Latin-1 + `UiFont.EXTRA`).
- No per-frame allocations (panels cache their labels; `FindSet` / `FindTest` are loops).
- C# can't be compiled in the sandbox (no SDK reachable): say so; check brackets / duplicates by script; shaders in
  headless WebGL2 (Playwright + `/opt/pw-browsers`, add precision lines incl. `sampler2DArrayShadow`).
- For simple build errors Gavin wants **just the fix**; a full zip only when he asks (he did once when tests had
  access issues).
- Third-party: own code from published methods only, credited in `THIRD-PARTY-NOTICES.txt`; nothing GPL; no new
  packages without asking; don't copy other clash tools' code, UI or wording.
- `.bimgo` `formatVersion` 1 and live protocol 1 stay compatible (additive only); run the Core tests after Core changes.
