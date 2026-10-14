# BimGo: Handoff for a new chat (Round C clash detection → hotkey review → polish → installer)

**Context:** BimGo is Gavin's personal project (publisher **Aussie BIM Guru**, **MIT-0**, C# / Visual Studio, .NET 8,
own OpenGL renderer over Silk.NET). He works in **rounds**: discuss → stage questions with AskUserQuestion
(recommended option first, at most 4 per call) → build → deliver a zip + `ai/<yymmdd><letter>_<topic>/` notes
(`0_brief.md` with the answers, `1_build notes.md`) + README + a project doc (`claude/BimGo_<Round>_BuildNotes.md`).

**Read first:**
1. This handoff.
2. `README.md`: *For AI assistants*, §3 controls (generated), §5 how it works (input / gamepad bullets), §8
   limitations / to verify, §9 history.
3. The input round's notes: `ai/261012a_Input_A`, `ai/261012b_Input_B`, `ai/261012c_Input_C` (project docs
   `claude/BimGo_Input_BuildA/B/C_BuildNotes.md`).
4. `claude/BimGo_Final_Rounds_Handoff.md` §2 (Round C's agreed scope, in full) and `claude/BimGo_Installer_Handoff.md`.
5. **Ask Gavin for a fresh zip of his working copy before editing** (with any compile fixes). His copy is the
   source of truth.

---

## 1. Where BimGo is now

| Build | What it added | State |
|---|---|---|
| Review tools B1 (`261011d`) and earlier | See README §9 | Confirmed working |
| Input B2-A (`261012a_Input_A`) | Action map: every key an `InputAction` in one Core catalogue; Esc → CONTROLS rebinding (3 keys per action, Shift / Ctrl / Alt, all mouse buttons, wheel, clash → SWAP, search, RESET, EXPORT / IMPORT); F1 help, hints and README §3 generated from the map | **Confirmed working** ("worked perfectly") |
| Input B2-B (`261012b_Input_B`) | XInput gamepad (own CONTROLS column, LB / RB combos, analog move / look, sprint toggle, cursor in menus / editors, tuning, SWAP STICKS), MMB gun wheel (pad: RS click), bookmarks Shift+1–9 | Builds; Xbox pad not tested (Gavin has a generic pad) |
| Input B2-C / C2 (`261012c_Input_C`) | Generic (non-XInput) controllers via winmm `joyGetPosEx` + CONTROLS → MAP BUTTONS… (20 steps); F1 help off by default with "F1: Help" bottom left; pause menu CATEGORIES & LINKS shows `*` when anything is off; C2 fixed `WinMm.cs` being overwritten (joystick interop is now `Native/Joystick.cs`) | **Builds and runs** (2026-10-12: CONTROLS shows "Microsoft PC-joystick"). MAP BUTTONS and pad play not yet confirmed |
| C3 fix (zip `BimGo_B2_BuildC3_fix.zip`, `GameSession.Controls.cs` only) | CONTROLS gamepad row: sliders no longer run under Invert Y / MAP BUTTONS / SWAP STICKS; buttons drop to their own line on narrow windows | Sent 2026-10-12, **not yet confirmed** |

**First thing tomorrow:** ask whether C3 builds and looks right, and how MAP BUTTONS went with his pad (README §8
"Input, build B2-C … to verify" lists what to try). Fix what he reports (just the fix for simple build errors), then
start Round C.

### Input decisions that stand (B2)
- Keys live in one place: Core `Scene/InputCatalog.cs` (`InputAction` names are stored ids: **never rename**;
  add new actions at the end of a group). Code asks for actions, never raw keys (text boxes excepted).
- 16 `InputSituation`s mirror `GameSession.UpdateFrame`; a clash = same chord in a situation holding both actions.
  `ControlsTests` checks the defaults have no clash and regenerates README §3 (`Readme_ControlsTablesAreCurrent`).
- **Any new feature's keys go into the catalogue** (with a pad default only where it fits; the controller is
  secondary support: never make keyboard / mouse worse for it).
- Gamepad: move **left** stick, look **right** stick; Start menu (LB + RB when there is no Start); RS click gun
  wheel; LB / RB + D-pad for tools. Xbox-style assumed; generic pads via MAP BUTTONS.
- Bookmarks Shift+1–9 (Ctrl is crouch). F1 help off by default.
- Free plain letters on the keyboard: still only **C** and **Y** (Y used only as Ctrl+Y). Also F2–F4, F6–F10,
  Home / End / Insert / Delete, backtick, most Alt combinations.

## 2. Plan

~~B1~~ → ~~B2 input~~ → **C clash detection (next)** → **hotkey review** → **polish** → **installer**.

## 3. Round C: clash detection (next)

Scope as agreed (full detail: `claude/BimGo_Final_Rounds_Handoff.md` §2 Round C). Runs in the app on the snapshot's
triangles (files and live), on a worker with progress and cancel. Hard and clearance tests (A × B or A × itself,
tolerance / distance), broad phase on bounds, triangle–triangle narrow phase; skip self and host ↔ hosted
(`HostId`); proxies flagged approximate. Search sets in stages (C1: category / family / type rules + level + link;
later extra parameters and hand-picked sets via the Scan gun). Stored in the .bimgo (optional `clashes.json`, no
format bump) and the model folder; EXPORT / IMPORT REPORT (BimGo JSON). Clashes matched across runs by element pair
(UniqueIds + link key) + test; statuses New / Active / Reviewed / Approved / Resolved; assignee, notes, run history.
Clash panel with GO (fly, auto section box, red / green pair, rest ghosted), to comments / BCF (a clash picture can
reuse the B1 markup editor). Grouping to prototype with Gavin. Pause menu review stack has room for CLASHES.

New since B2: the clash panel's keys (open, next / previous clash, GO, status) **go in the input catalogue** as a
"Clashes" group with its own situation, so CONTROLS, F1 and README §3 pick them up; check with `ControlsTests` and
the Python port (`scratchpad/b2/catalog.py` from the last chat is gone: rebuild from the catalogue if needed, or
rely on the tests on Gavin's machine). Gamepad: the panel works with the menu cursor (A / B); a pad default for
next / previous clash (e.g. RB + D-pad isn't free; LB + RB + …? or D-pad ← / → inside the panel) is a question.

**Staged questions (C)** (adjust to what the code shows; recommendation first):
1. *Default tolerances* — **Hard: ignore ≤ 5 mm; clearance: 50 mm (Recommended)** · hard 1 mm / clearance 25 mm ·
   ask per test only.
2. *Starter tests* — **Seed Structure × Services and Services × Services, editable (Recommended)** · start empty.
3. *Panel key* — **Y opens the clash panel now (one of two free letters; settled again in the hotkey review)
   (Recommended)** · pause menu CLASHES only until the hotkey review · C.
4. *Run size limit* — **Stop a test at 10,000 clashes with a notice; worker time unlimited with cancel
   (Recommended)** · 2,000 · no limit.
5. *Ghosting on GO* — **Everything else 15 % grey, transparent, no shadows (Recommended)** · wireframe · hide the rest.
6. *GO's section box after leaving the panel* — **Kept until Ctrl+P / the next GO (Recommended)** · removed on close.
7. *Grouping to prototype first* — **By element (one duct hitting many beams) (Recommended)** · by level · by proximity.
8. *Re-run on open* — **No, RUN when asked; show "model changed since the last run" (Recommended)** · automatic.
9. *Tolerances in imperial* — **Shown in the display units, stored in metres (Recommended)** · metric only.
10. *Panel keys in the panel* — **D-pad / [ ] or ← → next / previous, Enter GO, 1–5 status, rebindable as a
    "Clashes" context (Recommended)** · mouse only.

Likely split: **C-A** engine (sets, tests, worker, storage, report, Core tests on known geometry) → **C-B** panel,
GO, ghosting, statuses, comments / BCF → **C-C** grouping + extra-parameter / hand-picked sets.

## 4. Hotkey review (after C)

Much of it was settled during B2: gun wheel on MMB (pad RS click), bookmarks Shift+1–9, the gamepad defaults (README
§3 Gamepad column). Remaining questions:
1. *Principle* — **Keep muscle-memory keys, regroup the rest by family (sun / study / photo / section / tour /
   measure / clashes) (Recommended)** · clean slate.
2. *Sun family* — **O shadows, Shift+O sun panel, J study as now (Recommended)** · study to Shift+J.
3. *F12 vs M* — **F12 quick screenshot, M photo mode as now (Recommended)** · F12 opens photo mode.
4. *New keys* — **Tour on T (Demolish's T moves to its panel / X), eye height on C (Recommended)** · pause menu only.
5. *Gun-context letters* — **Keep as context keys, listed in each gun's panel (Recommended)** · global meanings.
6. *Measure modes* — **Keep "2 again", add Q for previous mode (Recommended)** · 2 only.
7. *Gamepad gaps* — anything Gavin finds missing after using the generic pad.

## 5. Polish, then installer

Polish: walk README §8 "to verify" with Gavin (newest first: B2-C, B2-B, B2-A, B1, …), then limitation candidates
(eye height in BCF viewpoints / comment views assume 1.62 m; Teleport / Find room use the standing capsule; saved sun
studies don't record the location override; imperial snap steps; pause menu under ~960 px wide). Trademark line
still to add to README, About / help, installer, `.bundle` description.

Installer: `claude/BimGo_Installer_Handoff.md` (Inno Setup, per-user, self-contained, Revit 2025 / 2026 / 2027
`.bundle`, no auto-update, no signing for 1.0; its §4 questions still open). MIT-0 `LICENSE`; THIRD-PARTY-NOTICES
beside `BimGo.exe` (plus the .NET runtime's); `Resources\places.tsv`, `Resources\Proxies`; Windows N needs the Media
Feature Pack for video. Input added nothing to ship (XInput, winmm are in-box).

## 6. Things to watch

- **Windows file names are case-insensitive:** never add a file whose name differs from an existing one only by
  case (B2-C's `WinMM.cs` overwrote `WinMm.cs`). Check `find -iname` before adding files.
- `GameSession` (now ~30 partials incl. `+Controls`, `+Hints`, `+Gamepad`, `+GunWheel`, `+PadMapping`) and
  `SceneRenderer` are split across partials: scan all for duplicate member names.
- `UpdateFrame` order matters: pad mapping / key capture first → tour → markup → comment editor → study → photo →
  section → sun panel → guns. Situations in `InputCatalog` must follow it.
- Slider ids in use: tour 41–43, gamepad tuning 51–53 (pick new ones above).
- Panel hint text goes through `KeyHint` (cached by `Hotkeys.Version`): no per-frame string building.
- Lengths / areas on screen via `UnitFormat`; qualify `BimGo.Scene.UnitSystem` in BimGo.Revit.
- C# can't be compiled in the sandbox: say so; check brackets / duplicates by script. Shaders: headless WebGL2 check.
- Files written by script: keep the repo's encoding (no BOM added).
- For simple build errors Gavin wants **just the fix**, not a new zip (unless he asks for the full zip).
- No regional terminology. No per-frame allocations. No exceptions to the user (log + toast). No new packages
  without asking; nothing GPL. `.bimgo` `formatVersion` 1 and live protocol 1 stay compatible; run the Core tests
  after Core changes.
