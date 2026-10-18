# Polish round P, build P-B: hotkey review (2026-10-18)

Built on `BimGo_Polish_PA2.zip` (Gavin's working copy). **Not compiled here** (no .NET SDK): build first, then run the
Core tests.

Checked by script:
- The default-clash test, re-run on a Python model of the new catalogue (every `Add` / `Pad` line and all 19
  situations): **0 clashes**, every action live somewhere.
- Brackets, strings (incl. interpolation holes) and char literals in every changed `.cs` file.
- New member names against their uses across the partials (`CurrentSituation`, `StartPickPointsFromKey`,
  `CycleCurrentClashStatus`, `ShowControlsDefaultsNotice`, `AskResetAll`, `Blank`, `_resetAllAsk`, `_clickChord`…).
- UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`; the only other glyph, ▾, is in a comment).
- Encodings kept: BOMs as they were, LF.

## In

### a. Keyboard (targeted)

| Change | Where |
|---|---|
| **K = PICK POINTS** in clash mode (new action `ClashPickPoints`). Starts the tool like TOOLS ▾ → PICK POINTS; **K again** or Esc leaves it. Needs a test under review (else a toast). The tool's toast and hint name the key. | `InputCatalog`, `ClashMode.cs` (`UpdateClashMode`), `ClashTools.cs` (`StartPickPointsFromKey`, `UpdateClashTool`) |
| **Path editor reserved** (new group `InputContext.PathEditor`, situation "Path editor (Round K)"): `PathAddKey` K, `PathDeleteKey` Del, `PathPreview` Space, `PathPreviousKey` ←, `PathNextKey` →. No app code reads them yet; CONTROLS shows the group with a note. | `InputCatalog` |
| Walking letters: unchanged. | |

Reviewed and kept (one-offs considered, not moved): clash mode's section box on B vs walking's P (and P = row
pictures there); Y for clash mode; Tab for the options preview; the keyboard-only actions listed under *Not in*.

### b. Gamepad (LB / RB chords; one binding per action)

| Action | Pad | Live in |
|---|---|---|
| Bookmark this view | LB+A | walking |
| Grids: off / underfoot / all | LB+Y | walking, clash mode, grids panel |
| Colour profile on / off | RB+Y | walking, clash mode |
| Grids panel | LB+B | walking, clash mode, grids panel |
| Clash mode on / off | RB+Back | walking, clash mode |
| Comment gun: edit the hovered comment | X | Comment gun (like the other guns' X) |
| Holding: flip snapping (hold) | LS click | holding an element |
| Sun panel: play / pause the day | Y | sun panel |
| Clash mode: group / ungroup | RB+A / RB+B | clash mode |
| Clash mode: **next status** (new action `ClashStatusCycle`, new → active → reviewed → approved → resolved → new; the picked group, else the current / selected clashes) | LB+A | clash mode |
| Path editor (reserved): add / delete key, preview, previous / next | X / LB+X / Y / D-pad ← → | path editor |

- **A or B with LB / RB held is a chord.** `Gamepad.DriveCursor` now waits for A to come up when it went down with a
  shoulder held (so RB+A in clash mode groups without clicking where the cursor is). B already stood aside through the
  map's modifier rule (`PadMenuBack` is shadowed by RB+B / LB+B where those are live).
- Holding LB / RB + A / B walking still nudges the held actions (jump / crouch are read held, like RB+B unarmed before).
- **Decision (flagged):** grids / colour profile are LB / RB + Y in clash mode too, not LB+D-pad as the answer said —
  they're the same actions as walking, and LB+D-pad is full walking. LB+D-pad is free in clash mode.

### c. The F1 sheet, generated

- Each `InputSituation` carries its F1 rows (`HelpEntry`: a short label and the actions it shows; at most 16, most used
  first). Walking has 16; each gun situation puts its rows after "Select gun" and drops the last ones.
- `GameSession.CurrentSituation()` (in `GameSession.Gamepad.cs`) names the situation the app is in, in `UpdateFrame`'s
  order: tour, video, paused, markup, study, photo, section box, sun panel, grids panel, clash mode, holding, then the
  gun by type (unarmed → plain walking).
- The sheet (`HelpRows` / `BuildHelp` in `GameSession.Render.cs`): the situation's title (accent), rows with the keys as
  bound (`KeyMap.HelpKeys`: WASD, ranges like SHIFT+1–9 and 1–5, the wheel pair) and, **while a gamepad is connected**,
  a green pad column (`KeyMap.HelpPad`: "LS", "D-pad ← · →"); rows with nothing bound are left out; then
  **ESC → CONTROLS** and the F1 row (always shown). Rebuilt when a binding, the situation or the pad's presence changes
  (no per-frame allocation otherwise).
- The sheet shows where it did before (walking HUD with its docks, clash mode); F1 toggles it where F1 is live.

### d. Changed defaults

- `InputCatalog.DEFAULTS_VERSION` = 1 and `InputCatalog.DefaultsChanges` (17 rows: 7 new actions, 10 new gamepad
  bindings).
- Settings `ControlsDefaultsVersion`: a new install starts at the current version; a settings file without the field
  (before P-B) reads as 0 (`LaunchSettings.LoadOrDefault`); `Sanitise` keeps it ≥ 0. Read from the machine's
  settings.json in `Hotkeys.Read`; written back by `Hotkeys.Write` / `Save`.
- **One-time toast** when a walkthrough opens (after any error toast, in place of the "N elements…" welcome):
  "Controls: 17 defaults changed · N clash(es) with your own keys (red) · Esc → CONTROLS". Each clash is logged. Then the
  version is saved as seen.
- **CONTROLS:** a NEW / CHANGED tag at the label's right on those rows for the rest of that run (red when the row
  clashes); typing "new" or "changed" in the search filters to them; on opening, the notice line says what the tags mean.
- **RESET ALL** now asks: a strip lists how many actions it puts back and the first six ("Fly: B → V, gamepad RB+A →
  Y · …"), with CONFIRM / CANCEL (Esc cancels).

### e. Tests (`ControlsTests`, +6)

`DefaultsChanges_MatchTheDefaults` (frozen version-0 snapshot of every rebindable default; every difference is in the
table and nothing else; no id dropped), `Help_EverySituationHasLiveRows`, `Help_KeyAndGamepadText`,
`PathEditor_ReservedAndClashFree`, `Review_PickPointsAndChords`, `Settings_ControlsDefaultsVersion`.
`Gamepad_StoredApartFromKeys` rebinds Fly to RB+A now (LB+Y is grids, so the old rebind would clash).

### README

§3: the rows edited by hand (the new pads, the two clash actions, the path editor table, the Fixed note) and the intro
(generated F1, changed defaults). `Readme_ControlsTablesAreCurrent` will tell (and rewrite) if a detail differs. §8
entry and the key-bindings limitation line; §9 rows; AI note 16.

## Not in

- Grids / colour profile on LB+D-pad in clash mode (see the decision above).
- The TOOLS ▾ menu doesn't show "K" beside PICK POINTS (the hint, toast, F1 and CONTROLS do).
- The menu / dock gamepad navigation (D-pad focus, LB / RB tabs, A / B) stays fixed, not in CONTROLS.
- Still keyboard-only on purpose: set home, find room, save / save as / undo / redo, section plane / clear, sun ±1 min,
  previous / next gun and gun modes (the wheel covers them), scan's select in Revit, the markup tools, the section box's
  free drag, the five clash status keys (LB+A cycles), fullscreen / screenshot / hide UI / refresh.
- The path editor's camera movement: K-B decides (← / → are the key steps there, so the arrow-key moves can't join that
  situation as they are).
- P-A2 leftovers (photo panel and PUSH TO REVIT / markup not on the shell; an open dropdown doesn't trap the ring).

## How to check

1. **Build** the solution; fix anything simple (send me just the error if it's not obvious).
2. **Core tests:** all pass. If `Readme_ControlsTablesAreCurrent` is Inconclusive it has rewritten README §3: look at the
   diff and keep it.
3. **The toast:** with your existing settings.json, open a model → "Controls: 17 defaults changed · Esc → CONTROLS"
   instead of the welcome line. Close and reopen a model → no toast. (To see it again: delete `ControlsDefaultsVersion`
   from `%AppData%\BimGo\settings.json`.)
4. **CONTROLS** (same run): the notice line about NEW / CHANGED; type `new` → the seven new actions (and labels
   that say "new", like Status: new); `changed` → the ten with new pad bindings. A new "PATH EDITOR (ROUND K)" group sits after the pause menu. Rebind something to K in clash
   mode (e.g. Model view → K) → SWAP asks about Pick points.
5. **RESET ALL:** rebind two things, press RESET ALL → the strip lists them with CONFIRM / CANCEL; CANCEL (or Esc) keeps
   them; RESET ALL → CONFIRM resets.
6. **K in clash mode:** Y, pick a test, K → pick points on (toast names K); click dots; K again → "Pick points off".
   Esc also leaves. Walking, K still cycles the lights.
7. **F1 per situation:** F1 walking (title WALKING, 16 rows); take the Scan gun (its rows appear: I / Shift+I, R);
   Measure; open the section box / sun panel / grids panel (titles change); clash mode (title CLASH MODE, 1–5, K…);
   pick up an element with Gizmo (HOLDING AN ELEMENT). Rebind something and see the sheet follow.
8. **Gamepad** (connected): the F1 sheet grows a green column. Walking: LB+A bookmarks, LB+Y cycles grids, RB+Y the
   colour profile, LB+B opens the grids panel (LB+B again closes it), RB+Back clash mode on; Comment gun X edits the
   hovered comment; Gizmo holding LS click flips snapping; sun panel Y plays the day. Clash mode: RB+A groups the
   selection **without clicking under the cursor**, RB+B ungroups (and doesn't leave clash mode), LB+A steps the status,
   RB+Back leaves. Over a dock, LB / RB + D-pad still do their chords and a tap of LB / RB still switches tabs.
