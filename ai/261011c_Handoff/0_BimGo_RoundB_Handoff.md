# BimGo: Handoff for a new chat (Rounds B1 → B2 → C → hotkeys → polish → installer)

**Context:** BimGo is Gavin's personal project (publisher **Aussie BIM Guru**, **MIT-0**, C# / Visual Studio, .NET 8,
own OpenGL renderer over Silk.NET). He works in **rounds**: discuss → stage questions with AskUserQuestion
(recommended option first) → build → deliver a zip + `ai/<yymmdd><letter>_<topic>/` notes + README + a project doc
(`claude/BimGo_<Round>_BuildNotes.md`).

**Read first:**
1. This handoff.
2. `README.md`: *For AI assistants*, §3 controls, §5 how it works, §8 limitations / to verify, §9 history.
3. The last two builds' notes: `ai/261011a_Tour`, `ai/261011b_Video_Location`.
4. `claude/BimGo_Installer_Handoff.md` (installer plan, open questions §4; MIT-0 replaces MIT there).
5. **Ask Gavin for a fresh zip of his working copy before editing** (with any compile fixes). His copy is the
   source of truth. Builds A1 and A2 were written without a .NET SDK: confirm they built and ask what failed in
   testing before starting B1 (README §8 lists what to check).

---

## 1. Where BimGo is now

| Build | What it added | State |
|---|---|---|
| Photo mode (`261010c`) and earlier | See README §9 | Confirmed working by Gavin |
| Tour A1 (`261011a_Tour`) | Bookmark tour (fade / glide, swivel, hold, per-bookmark overrides, UI on / off, loop; Space / ← → / Page Up / Down / LMB / RMB / Esc); bookmarks keep visibility + eye height; eye-height presets Standing 1.62 / Seated 1.20 / Child 1.10 m | Handed over; Gavin made no changes before A2 |
| Video + location A2 (`261011b_Video_Location`) | RECORD VIDEO (MP4 / H.264 via Windows Media Foundation, window / 1080p / 4K, 30 / 60 fps, preview + cancel, `Videos\BimGo`); location override (offline Natural Earth place search, pasted coordinates, IANA zones with automatic DST, saved in sun.json) | Handed over, **to build and test** |

Decisions that stand: tour and eye height live in the pause menu with **no new keys** (keys come in the hotkey
review); `make_places.py` stays in `ai/261011b_Video_Location/` (Gavin: no `tools/` folder needed); Natural Earth
credited in THIRD-PARTY-NOTICES with how the list was made.

## 2. Plan (agreed 2026-10-11)

**B1** (review tools) → **B2** (input: action map, rebinding, gamepad) → **C** (clash detection) → **hotkey review**
→ **polish** → **installer**. Each round: stage the questions below (recommendation first; adjust to what the code
shows), then build. Rounds may split into builds A / B as A1 / A2 did.

---

## 3. Round B1: measure extras, snapshot markup, units, start screen

Code facts: `MeasureGun` (gun 2) has distance + N (normal projection), RMB removes the last line, X clears;
comment pictures are captured the frame after placing a comment / SET VIEW HERE (`GameSession.Thumbnails`:
192 × 108 thumbnail + ≤ 1280 px picture for BCF); ~17 places format metres / mm / m²; the start screen already
exists (`Shell/HomeScreen.cs`: running live sessions, OPEN…, recent files from `Recent.json` with a manifest
summary, drag-and-drop) but has **no thumbnails**.

**Staged questions (B1):**
1. *Measure modes: how to switch?* — **Press 2 again to cycle Distance → Area → Angle → Clearance (Recommended)**
   · mode buttons in the gun panel only · a gun-context key (e.g. Q).
2. *Area: how to define it?* — **Click points on the plane of the first point; close on the first point or RMB;
   shows area + perimeter (Recommended)** · Shift-click a surface for that face's area too · both.
3. *Floor-to-ceiling clearance: what to measure?* — **From the aimed point straight down to the floor and up to
   the next surface, both labelled (Recommended)** · only upwards from the aimed floor.
4. *Angle* — **Three points (vertex in the middle) (Recommended)** · between two existing distance lines.
5. *Measurements kept?* — **Temporary markers as now (X clears) (Recommended)** · saved with the model.
6. *Markup: when does it open?* — **Straight after the comment picture is taken, plus EDIT MARKUP in the comment's
   detail view (Recommended)** · only from the detail view.
7. *Markup tools* — **Arrow, rectangle, ellipse, freehand, text; 5 colours (red, amber, cyan, white, black);
   3 thicknesses; undo / redo; clear (Recommended)** · fewer (arrow, circle, text).
8. *Editable afterwards?* — **Burned into the picture and thumbnail (so BCF snapshots carry it), with the unmarked
   original kept so EDIT MARKUP starts clean (Recommended)** · burn only · an editable vector layer (JSON).
9. *Imperial format* — **Feet-inches to 1/8" (5' 7 1/2") for lengths, ft² for areas, a setting for decimal feet
   (Recommended)** · decimal feet only · both shown.
10. *Units scope* — **Lengths, areas, coordinates, study heights / work plane, section panel, eye heights, readouts;
    lux and daylight % unchanged (Recommended)** · also lux → footcandles in imperial.
11. *Where is the setting?* — **Pause menu (Display tab) and Options → Player, per machine (Recommended)** · per model.
12. *Start screen thumbnails* — **Save a `thumbnail.jpg` into the .bimgo on every save, from the current view
    (Recommended)** · use the home bookmark's thumbnail · both (home if set, else last view).
13. *"Last live session" on the start screen* — **Show the last Revit model opened live as a greyed card ("open it in
    Revit and press Go") (Recommended)** · leave it out (running sessions are already listed).
14. *Recent list extras* — **REMOVE FROM LIST and SHOW IN FOLDER per entry (Recommended)** · none.

Format note: `thumbnail.jpg` is a new optional .bimgo entry (format version stays 1; older readers ignore it).

## 4. Round B2: action map, key rebinding, gamepad

Code facts: ~114 `IsPressed` / `IsDown` checks across 17+ files, plus `LeftPressed` / `RightPressed` in the guns;
keys are hard-coded `Vk.*` / chars; help rows (`HELP_ROWS`) and README §3 are hand-written. XInput
(`xinput1_4.dll`) is in-box: no package. B2 builds the *system*; the hotkey review later picks the *defaults*.

**Staged questions (B2):**
1. *Rebinding scope* — **Global actions and gun / panel actions; the same key may mean different things in different
   contexts (Recommended)** · global actions only.
2. *Where to rebind* — **A CONTROLS view in the pause menu (in-app), with search, conflicts and RESET TO DEFAULTS
   (Recommended)** · also in the Revit Options window.
3. *Conflicts* — **Warn and offer to swap (Recommended)** · warn and block · allow.
4. *Modifiers* — **Shift / Ctrl / Alt combinations and mouse buttons (LMB / RMB / middle / X1 / X2) (Recommended)**
   · keys only.
5. *Help and README from the map* — **F1 help generated from the action map; a README §3 table generated by a small
   script / test (Recommended)** · F1 only.
6. *Gamepad rebindable?* — **Yes, same action map, its own column (Recommended)** · fixed layout.
7. *Gamepad in menus* — **Right stick drives a cursor, A clicks, B back, Start pause (works with the immediate-mode
   UI) (Recommended)** · full focus navigation (larger) · walking only, menus need the mouse.
8. *Gamepad tuning* — **Look sensitivity, invert Y, dead zone, trigger threshold in settings (Recommended)** ·
   sensitivity only.
9. *Several controllers* — **The first connected one (Recommended)** · any of them.
10. *Storage* — **settings.json per machine, plus EXPORT / IMPORT a keymap file (Recommended)** · settings only.

## 5. Round C: clash detection (stretch; agreed 2026-10-10, details in `claude/BimGo_Final_Rounds_Handoff.md` §2)

Runs in the app on the snapshot's triangles (files and live), on a worker with progress and cancel. Hard and
clearance tests (A × B or A × itself, tolerance / distance), broad phase on bounds, triangle–triangle narrow phase;
skip self and host ↔ hosted; proxies flagged approximate. Search sets in stages (C1 category / family / type rules +
level + link; later extra parameters and hand-picked sets). Stored in the .bimgo (`clashes.json`) and the model
folder; EXPORT / IMPORT REPORT (BimGo JSON). Clashes matched across runs by element pair + test; statuses New /
Active / Reviewed / Approved / Resolved; assignee, notes, run history. Clash panel with GO (fly, auto section box,
red / green pair, rest ghosted), to comments / BCF, grouping to prototype with Gavin.

**Staged questions (C):**
1. *Default tolerances* — **Hard: ignore ≤ 5 mm; clearance: 50 mm (Recommended)** · hard 1 mm / clearance 25 mm ·
   ask per test only.
2. *Starter tests* — **Seed Structure × Services and Services × Services, editable (Recommended)** · start empty.
3. *Panel key* — **Decided in the hotkey review; pause menu CLASHES until then (Recommended)** · C now.
4. *Run size limit* — **Stop a test at 10,000 clashes with a notice; worker time unlimited with cancel
   (Recommended)** · 2,000 · no limit.
5. *Ghosting on GO* — **Everything else 15 % grey, transparent, no shadows (Recommended)** · wireframe · hide the rest.
6. *GO's section box after leaving the panel* — **Kept until Ctrl+P / the next GO (Recommended)** · removed on close.
7. *Grouping to prototype first* — **By element (one duct hitting many beams) (Recommended)** · by level · by proximity.
8. *Re-run on open* — **No, RUN when asked; show "model changed since the last run" (Recommended)** · automatic.

## 6. Hotkey review (after B2 builds the system)

Current map: README §3 and `claude/BimGo_Final_Rounds_Handoff.md` §3. Free plain letters: **C** and **Y** (Y only
as Ctrl+Y); F2–F4, F6–F10, Home / End / Insert / Delete, backtick, most Alt combinations.

**Staged questions (hotkeys):**
1. *Principle* — **Keep muscle-memory keys (WASD, Space, Shift, Ctrl, 1–9, Esc, F-keys), regroup the rest by family
   (sun / study / photo / section / tour) (Recommended)** · a clean-slate map.
2. *Sun family* — **O shadows, Shift+O sun panel, J study as now (Recommended)** · move the study to Shift+J / Ctrl+O.
3. *F12 vs M* — **F12 quick screenshot, M photo mode as now (Recommended)** · merge (F12 opens photo mode).
4. *New keys* — **Tour on T? (T is Demolish's toggle: move that to the gun panel), eye height on C,
   clash panel on Y (Recommended)** · keep them in the pause menu only.
5. *Gun-context letters (E, F, R, X, Z, Q, G, T, N, I)* — **Keep as context keys, listed in each gun's panel
   (Recommended)** · give each a global meaning.
6. *More than nine guns later?* — **Wheel + a gun wheel on Tab-hold; minimap moves to M-hold or F-key
   (Recommended)** · number keys only.
7. *Gamepad defaults* — **Left stick move, right stick look, A jump, B crouch, LB / RB previous / next gun,
   RT fire, LT secondary, X use / context, Y fly, Start pause, Back map (Recommended)** · Gavin's own layout.

## 7. Final polish

Walk README §8 "to verify" with Gavin (newest first: A2, A1, photo, section, daylight, BCF), fix what he raises.
Candidates from the known limitations: eye height in BCF viewpoints / comment views (they assume 1.62 m), the
Teleport gun and Find room using the standing capsule, the 720 px pause-menu height, saved sun studies not
recording the location override. Trademark line still to add to README, About / help, installer and the `.bundle`
description (see `claude/BimGo_Final_Rounds_Handoff.md` §2a).

**Staged question (polish):** *Which first?* — **Bugs from Gavin's testing, then the §8 items he can't easily test,
then the limitation candidates (Recommended)** · limitation candidates first.

## 8. Installer

Follow `claude/BimGo_Installer_Handoff.md` (Inno Setup, per-user, self-contained app, Revit 2025 / 2026 / 2027
`.bundle`, no auto-update, no signing for 1.0); its §4 questions are still open. New since it was written: ship
`Resources\places.tsv` and `Resources\Proxies` with the app; MIT-0 `LICENSE` on the licence page; THIRD-PARTY-NOTICES
beside `BimGo.exe` (includes the .NET runtime's notices when self-contained); Windows N needs the Media Feature
Pack for video (say so in the installer's readme or on first RECORD VIDEO failure — already reported in-app).

**Extra staged question (installer):** *Media Feature Pack on Windows N* — **Mention it in the readme and the
in-app error only (Recommended)** · check at install time and warn.

## 9. Things to watch (unchanged)

- `GameSession` and `SceneRenderer` are split across partials: scan all partials for duplicate member names.
- `UpdateFrame` order matters: tour (recording first) → comment editor → study → photo → section → sun panel → guns.
- Shaders: check new / changed GLSL in headless WebGL2 (Playwright + Chromium). C# can't be compiled in the sandbox:
  say so. No .NET SDK download is possible from the sandbox (blocked); GitHub is reachable via `git`.
- For simple build errors Gavin wants **just the fix**, not a new zip.
- No regional terminology. No per-frame allocations. No exceptions to the user (log + toast).
- Licensing: anything bundled or used that is licensed or asks for attribution goes into THIRD-PARTY-NOTICES with
  where it came from and how it was used (Gavin, 2026-10-11). No GPL / copyleft; ask before any new package.
- `.bimgo` `formatVersion` 1 and live protocol 1 stay backward compatible; run the Core tests after Core changes.
