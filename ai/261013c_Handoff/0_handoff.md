# BimGo: Handoff for a new chat (Round C continues: C-B4 → C-C groups → hotkey review → polish → installer)

**Context:** BimGo is Gavin's personal project (publisher **Aussie BIM Guru**, **MIT-0**, C# / Visual Studio, .NET 8,
own OpenGL renderer over Silk.NET). He works in **rounds**: discuss → stage questions with AskUserQuestion
(recommended option first, at most 4 per call) → build → deliver a zip + `ai/<yymmdd><letter>_<topic>/` notes
(`0_brief.md` with the answers, `1_build notes.md`) + README + a project doc (`claude/BimGo_<Round>_BuildNotes.md`).
Each build states **what is in, what isn't, and how to check it step by step** (README §8, newest first). For simple
build / test errors Gavin wants **just the fix** (a snippet), not a new zip.

**Read first:**
1. This handoff.
2. `README.md`: *For AI assistants*, §3 controls (generated), §5 (the clash detection bullet: C-A … C-B3), §6
   (`clashes.json`, `comments.json` `clashId`), §7 (`select.elements` `hosts[]` / `clashView`), §8 (newest three), §9.
3. `ai/261013a_Clash_B2`, `ai/261013b_Clash_B3` (project docs `claude/BimGo_Clash_B2_BuildNotes.md`,
   `claude/BimGo_Clash_B3_BuildNotes.md`); older code map: `ai/261012g_Handoff/0_handoff.md` §5–§6.
4. **Ask Gavin for a fresh zip of his working copy before editing.** His copy is the source of truth.

---

## 1. Where BimGo is now (2026-10-13)

| Build | What it added | State |
|---|---|---|
| C-B2 (`261013a_Clash_B2`) | Row pictures (PICTURES on / off), TO COMMENT / UPDATE COMMENT (clash → comment, status / assignee follow one way, BCF "Clash" topics with both elements), R = SHOW IN REVIT ("BimGo clash" 3D view with the section box; additive `select.elements` fields), box on / off sticks between clashes | Built with C-B3 |
| C-B3 (`261013b_Clash_B3`) | Ctrl / Shift click multi-select in the clash list (every pair tinted, one box over all, camera from `ClashFraming.DistanceToSee`; 1–5, R, Enter, TO COMMENT act on all), comments only for the selection (UPDATE THEM / NEW ONLY / CANCEL, `OpenChoice`), MARKUP + row pencil (back to clash mode), Comments panel TYPE filter + ticks + DELETE SELECTED; LIST TO COMMENTS removed | **Builds**, two fixes Gavin applied (both also in the handoff state): `using BimGo.Rendering;` in `GameSession.ClashSelection.cs` (`SceneDrawParams`); the test `Framing_SeveralClashes_StandsBackToSeeThemAll` uses a ±0.5 m box (a 2 m box legitimately needs ~3.7 m). README §8 C-B3 / C-B2 checklists **not yet walked**: ask how they went first |

## 2. Next: C-B4 (two parts, agreed 2026-10-13, not built)

### 2a. Check all / focus all in the clash list

Gavin: "check all / uncheck all clashes in the list, which lets us isolate / review them all together if we want, or
if you think it's better add a focus on all which highlights all clashing elements in either set so we can isolate /
ghost / view them together, whatever works best."

Recommended shape (stage as a question): **SELECT ALL SHOWN / CLEAR** on the dock (the C-B3 selection, so 1–5, R,
TO COMMENT and the union view all work on it) **plus a FOCUS ALL view**: every element that clashes in the list's
clashes (A red, B green, an element in both sets amber), the rest by the G view (ghost / wireframe / real / hidden),
box over all when on, the camera to see them all. Things to decide / watch:
- Scale: the union of hundreds of clashes is the whole building. Cap the multi lists (e.g. draw every pair but frame /
  box only up to N, or offer "box: off for focus all"); `ResolveSelectedClashes` is O(n) with `List.Contains`
  de-duplication: switch to a `HashSet<int>` / bool mask over elements for large selections, and draw highlights per
  batch if `DrawElementHighlight` per element is too slow for thousands (measure; maybe a per-element tint mask in the
  shader instead).
- `ClashTargets()` returns the live `_clashSelected`; TO COMMENT already caps at 500 and asks (`OpenChoice`).
- R with hundreds: Revit selection of thousands of references is slow: cap or warn.
- Ctrl+A in the list (keys go through `InputCatalog`: new action in the `Clashes` group, check `ControlsTests`).
- Selected markers are ringed (`DrawClashMarkers`); with "all" that is every marker: fine.

### 2b. Nested rules for search sets (Revit-filter style AND / OR)

Gavin: "revisit rule creation for sets so we can do and/or conditions and add them together or nest them, like Revit's
or/and filtering. Even if it's just one level deep, or ALL / ANY nested in an overarching ALL / ANY."

Today (`Clashes/ClashModels.cs` `SearchSet`: `MatchAll` + flat `Rules`; `SearchSets.Matches`): adding rules combine by
ANY / ALL; "not" operators (IS NOT, IS NOT ANY OF, DOES NOT CONTAIN) always **subtract** at set level.
Recommended model (additive, `clashes.json` stays version 1): `SearchSet.Groups` (optional list of `RuleGroup`
{ `MatchAll`, `Rules` }) combined by the set's own `MatchAll`; a set with groups ignores nothing: its top-level `Rules`
act as one more group (or are migrated into a first group on edit). One level deep is enough for Revit-style
"(A AND B) OR (C AND D)" and "ALL of: (ANY of …), (ANY of …)". Questions to stage:
- Inside groups, should NOT rules be ordinary conditions (Revit-like: "Level is not L2" is just false for L2 elements)
  or keep the current "always subtract from the whole set"? Recommended: ordinary conditions inside groups; legacy flat
  sets keep subtract semantics (read older files unchanged; `Sets_Operators_NotRulesAlwaysSubtract` must still pass).
- One level vs fully recursive (recommended: one level now, the model recursive-ready: `RuleGroup.Groups` reserved).
- UI: the SETS editor (`GameSession.ClashPanel.cs` `BuildClashSetEditor`, ~line 600) shows groups as indented boxes
  with their own ANY / ALL dropdown, ADD RULE inside each, ADD GROUP at the bottom, × on a group (confirm if it has
  rules). Reuse `DropdownButton` / `OpenDropdown` / `OpenConfirm` (`GameSession.Overlays.cs`); the value picker
  (`_clashPickerRule`) works per rule already. Scrolling: the editor may outgrow the panel: add a scroll.
- Extra parameter rules (fields beyond category / family / type / level / model) were planned for C-C: consider
  doing the field list here while the editor is open (ask).
- Core work: `RuleGroup`, `SearchSet.Groups`, `Copy`, `Normalise`, `SearchSets.Matches` / `Describe`, `ValueLabel`;
  `ClashFiles` round trip; tests: grouped ANY / ALL truth table, NOT inside a group, legacy flat sets unchanged, file
  round trip, "changed since the last run" marking when a group changes (the panel already marks tests whose sets
  change).

## 3. After that

- **C-C (grouping, "later this week"):** group the selected clashes / add to a group (the selection is the input);
  one comment / picture per group (`RenderClashPicture` with the selection instead of `_clashMultiSuspended`, union
  framing is `GoToSelectedClashes`); grouping by element first (one duct hitting many beams), then level / proximity
  (prototype with Gavin); hand-picked sets via the Scan gun; BCF report output by group with images.
- **Hotkey review** (questions in `claude/BimGo_RoundC_Handoff.md` §4; taken since: Y, G, B, 0, wheel = gun modes;
  candidates now: TO COMMENT, select all, focus all; C is still free while walking).
- **Polish:** README §8 "to verify" (newest first), limitation candidates, the trademark line (README, About / help,
  installer, `.bundle` description); gamepad buttons for clash G / B / PICTURES and for unarmed; gamepad multi-select.
- **Installer:** `claude/BimGo_Installer_Handoff.md`.

## 4. Code map additions (C-B2, C-B3)

- `Game/Clashes/GameSession.ClashPictures.cs`: `RenderClashPictures` (start of `Render`), `RenderClashPicture`
  (off-screen through `RenderScene(photo: true)` with `_clashShot`; restores camera, cut, current clash, multi flag),
  row pictures (`ClashThumbnailTexture`, `_clashThumbVersion`), TO COMMENT (`ClashToComment` → `MakeClashComments` →
  pending single / `StartClashBatch`), `MakeClashComment`, `SyncClashComment(s)`, `OpenClashMarkup`, `ClashCommentPencil`.
- `Game/Clashes/GameSession.ClashSelection.cs`: `_clashSelected`, `ClickClashRow`, `GoToSelectedClashes`,
  `ResolveSelectedClashes` (multi lists), `DrawSelectedClashPairs`, `PruneClashSelection`, `ClashTargets`.
- `GameSession.ClashMode.cs`: `FrameClash`, `FlyToClashView`, `ShowClashInRevit`, `_clashFrame`; `GoToClash` clears
  the selection.
- `GameSession.Overlays.cs`: `OpenChoice` (second action + tick label).
- Core: `ClashCommentRules`, `ClashFraming.DistanceToSee`, `CommentRecord.ClashId`, `ClashViewRequest`,
  `SelectPayload.Hosts / ClashView`, `ILiveLink.ShowClash`, `LaunchSettings.ClashRowPictures`; Revit
  `LiveDispatcher.ShowClash`, `SelectLinked(…, hosts)`.
- `RenderScene`: clash shots skip AO / glow (`SceneRenderer.SkipScreenEffects`) and, outside the real view, the sun
  cascades and light picking.

## 5. Things to watch (in addition to `261012g_Handoff` §6)

- C# can't be compiled in the sandbox: say so; check brackets / single declarations / `using`s by script (C-B3 missed
  `using BimGo.Rendering;` for `SceneDrawParams`: grep each new file's types against their namespaces); scan UI
  strings against the font atlas (Latin-1 + `UiFont.EXTRA`).
- Work out test expectations numerically before writing them (the C-B3 framing test assumed a 2 m box fits 2.5 m).
- Changing a default key breaks `ControlsTests` assertions that name it; every action needs a default key or pad
  binding; README §3 rows are generated (hand-edit in the exact format).
- Panels with overlays call `BeginOverlays` / `DrawOverlays` (the Comments list does since C-B3); Esc closes overlays
  first; `SetPaused` closes any overlay.
- Large selections: avoid O(n²) (`List.Contains`), per-frame allocations, and per-element draw calls for thousands.
- `.bimgo` `formatVersion` 1 and live protocol 1: additive only. Files written by Gavin's copy must still load.
