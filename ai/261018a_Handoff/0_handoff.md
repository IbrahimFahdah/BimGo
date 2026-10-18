# BimGo: handoff for build P-B (hotkey review, after P-A2)

**Context:** BimGo is Gavin's personal project:
- publisher **Aussie BIM Guru**, licence **MIT-0**;
- C# / Visual Studio, .NET 8;
- its own OpenGL renderer over Silk.NET;
- a Revit add-in (`BimGo.Revit`), a standalone app (`BimGo.App`) and `BimGo.Core`.

How Gavin works:
- **Rounds:** discuss → AskUserQuestion (recommended option first and marked, at most 4 questions per call) → build → zip.
- **Notes:** each build gets `ai/<yymmdd><letter>_<topic>/` (`0_brief.md`, `1_build notes.md`), README §8 (newest first) and
  §9 rows, and a project doc `claude/BimGo_<Round>_BuildNotes.md`.
- **Each build says what is in, what isn't, and how to check it step by step.**
- Simple build or test errors: he wants **just the fix**. He folds requests in mid-build. "Assume recommended options"
  when he's away.
- **Ask for a fresh zip of his working copy before editing** (it carries his compile fixes).

## 1. Where things are (2026-10-18)

| Build | Folder | State |
|---|---|---|
| Roadmap brief | `261017j_Handoff`, project doc `claude/BimGo_Roadmap_Polish_Flythrough_Brief.md` | Order: Round P (P-A, P-B, P-C), Round K (K-A, K-B), Round X (X-A, X-B) |
| P-A1 panel shell | `261017k_Polish_PA1` | Confirmed |
| P-A2 handoff | `261017l_Handoff` | |
| **P-A2** docks, HUD columns, gamepad focus | `261017m_Polish_PA2`, project doc `claude/BimGo_Polish_PA2_BuildNotes.md` | **Built and confirmed by Gavin ("all works well")** |
| This handoff | put it in `ai/261018a_Handoff/0_handoff.md` | |
| **P-B** hotkey review | next: `261018b_Polish_PB` | To build |

## 2. P-B answers (AskUserQuestion, 2026-10-18; all recommended)

| Question | Answer |
|---|---|
| How far the keyboard defaults move | **Targeted fixes.** Walking letters stay. PICK POINTS → **K** in clash mode. **Reserve the path-editor situation now** (K add key, Delete delete key, Space preview, ← / → previous / next key) so the clash test covers Round K. Move only the odd one-offs the review finds. |
| Gamepad for the actions without one | **LB / RB chords**, the existing pattern. Walking: LB+X / RB+Y style chords for grids, colour profile and bookmarks. Clash mode: LB+D-pad for grids / colour profile, RB+A / RB+B group / ungroup, LB+A cycles the status. `ControlsTests` checks for clashes. |
| F1 sheet per mode | **Generated, short:** built from the catalogue for the current situation; about 12–16 of the most-used actions; a key column and a pad column (pad while one is connected); a last row "Esc → CONTROLS for all". It follows rebinds. |
| How changed defaults show | **Toast + CONTROLS marks:** a one-time toast after the update ("Controls: N defaults changed · Esc → CONTROLS"); a NEW / CHANGED tag on those rows in CONTROLS; RESET ALL lists what it will change before you confirm; user rebinds that now clash with a new default are flagged. |

## 3. What the code looks like today

### The catalogue (`BimGo.Core/Scene/InputCatalog.cs`, 612 lines)
- `Add(InputAction, context, label, kind, keys…)` lines (~L237–L345), then `Pad(action, "PadXxx")` gamepad defaults
  (~L346–L425).
- `Situations` (~L526): Walking (+ one per gun), Holding an element, Markup editor, Section box editor, Photo mode, Sun
  panel, Sun / daylight study, Bookmark tour, Clash mode, Grids panel, Recording a video, Start screen, Pause menu and
  panels. Mirrors `GameSession.UpdateFrame`: change both together. `LiveTogether(a, b)` drives the clash test.
- **Rebinds are overrides** (`KeyMap` with settings `KeyBindings` / `PadBindings` and keymap files): only changed
  slots are stored, so new defaults reach everyone and rebinds survive. A rebind can now collide with a new default:
  that's what the flag in §2 is for.
- **For the "changed" marks:** you need to know which defaults the user last saw. Likely shape: settings
  `ControlsDefaultsVersion` (int, additive) plus a small per-version table of changed actions in the catalogue; the
  toast shows once when the stored version is older. (Decide in the build; keep it additive and quietly migrated.)

### Actions with no gamepad default (from the review script)
- Global: `Fullscreen`, `Screenshot`, `HideUi`, `Refresh`, `Save`, `SaveAs`, `Undo`, `Redo` (keyboard-only is fine for
  most).
- Walking: `SetHome`, `FindRoom`, `PreviousGun` / `NextGun` (the gun wheel covers them), `GunModePrevious / Next`,
  **`AddBookmark`**, `SunEarlierFine / LaterFine`, `SectionPlane`, `SectionClear`, **`ClashMode`**, **`GridsPanel`**,
  **`GridsCycle`**, **`ColourProfile`**.
- Guns: `ScanSelectInRevit`, `CommentEdit`, `HoldSnapInvert`.
- Editors: the markup tools, `SectionFreeDrag`, `SunPlay`.
- Clash mode: **`ClashStatusNew…Resolved`** (1–5), **`ClashGroup`**, **`ClashUngroup`**.
- Bold = the ones the answers name; pick the rest case by case and list them in the notes.

### Current gamepad pattern (keep it)
- Walking D-pad: Up / Down level, Left / Right sun time. LB+D-pad: Up shadows, Down lights, Right coordinates, Left
  go home. RB+D-pad: Up photo, Down section box, Left study, Right sun panel. X = the gun's secondary tool (LB+X its
  second one); RB+X clear markers; RB+B unarmed; Y fly; Back minimap; LB+Back help.
- Clash mode: D-pad Up view, Down section box, Left / Right previous / next; Y re-frame; X show in Revit; RT / LT fly up
  / down; RB+X select all; Back pictures. **LB+D-pad and RB+A / RB+B / LB+A are free in clash mode** (Shadows / Lights /
  Coordinates / GoHome aren't live there).
- **P-A2's menu navigation is fixed (not catalogued):** in menus and over docks the D-pad moves the focus ring, A
  presses, B goes back; **LB / RB tapped alone** switch tabs; held with another button they're chords, and **the D-pad
  with a shoulder held is left to the chords**. So new LB / RB + D-pad chords keep working over docks. If P-B
  catalogues the menu navigation after all, it's `GameSession.PadFocus.cs` (`UpdatePadFocus`, `UpdatePadShoulders`).

### Keyboard notes
- **K** is walking's *Artificial lights*; it isn't live in clash mode, so PICK POINTS → K there is free. Round K's path
  editor is its own situation, so K = "add key" there is free too (once the situation exists).
- PICK POINTS today is only in TOOLS ▾ (`CLASH_TOOL_ACTIONS` in `Clashes/GameSession.ClashGroups.cs`, `CLASH_TOOL_PICK`).
  The key should toggle the tool like the menu item (and Esc / K again leave it).
- The path-editor situation: add the `InputContext` / actions now, with no app code behind them (K-A wires them). Say so
  in the notes and in CONTROLS ("Path editor (Round K)").

### F1 today
- `GameSession.Render.cs`: `HelpRows()` (a hand-written list, cached on `Hotkeys.Version` and pad-connected) and
  `BuildHelp(f, height, minTop)` (P-A2: part of the left column; drops rows that don't fit; the last row always shows).
- The generated sheet needs "which situation am I in" on the app side: a `CurrentSituation()` beside
  `CurrentPadCursorMode()` in `GameSession.Gamepad.cs`, matching `InputCatalog.Situations` by name or index. A
  "most-used" order per situation is easiest as a short list per situation in the catalogue, falling back to catalogue
  order.

### Tests and README
- `tests/BimGo.Core.Tests/ControlsTests.cs`: no default clash within any situation; `Readme_ControlsTablesAreCurrent`
  regenerates / checks README §3. Changing defaults means README §3 changes: let the test regenerate it, or edit it
  by hand and say so.
- Add tests: the changed-defaults table matches the actual default differences; every situation has a non-empty F1
  list whose actions are live there; the path-editor situation is clash-free.

## 4. Things to watch
- **Compiling:** no .NET SDK in the sandbox (nuget / dotnet hosts blocked): say so. Script-check brackets, strings and
  `'\uXXXX'` char literals (P-A1 / P-A2's Python walker), new member names across the `GameSession` partials, and UI
  strings against the font atlas (Latin-1 + `UiFont.EXTRA`: `Δ − — – … • ↑ ↓ ← → “ ” ’ ≈ ≤ ≥ ‹ › ↔`).
- **Name clashes:** `InputState` (alias, or `using BimGo.Platform;`); `DB.` qualifiers in BimGo.Revit; colour profiles
  are `AppearanceProfile`, not the quality `Profiles`.
- **Encodings:** keep them (some files have a BOM, most don't; `UiBatch.cs`, `UiTheme.cs` ASCII). LF.
- **Compatibility:** additive only (`.bimgo` 1, `clashes.json` 1, live protocol 1; settings migrate quietly in
  `LaunchSettings.Sanitise`). **Never rename an `InputAction` id** (they're stored in settings).
- **README AI notes 13–15:** keys are actions (13); big panels on the shell (14); docks, HUD columns and gamepad focus
  (15: every `Hover` is a focus target, `focus: false` for panels / viewports; tab rows call `TakePadTabStep`).
- No per-frame allocations; labels cached (`KeyHint`).

## 5. After P-B
- **P-C leftovers + colour follow-ups** (roadmap brief): nested search-set groups; groups in the CLASHES list; grid
  location on dock rows; grids in photos; grass on moved / hidden elements; the tour's sun blends between stops;
  bookmarks keep crouch; BCF / comment views use the eye height; custom breaks / quantile bins; caps in the profile
  colour; the legend scaled for big stills; hidden rows' copies cast no shadows; imported sets reconciled; a colour
  profile per bookmark / stop.
- Leftovers noted in P-A2: photo mode's panel isn't on the dock shell (focus area only); PUSH TO REVIT and the markup
  editor aren't on the shell; an open dropdown doesn't trap the focus ring.
- **Then Round K** (keyframed flythrough: K-A Core + playback + video, K-B editing) and **Round X**.
