# Round B2, build A (action map, rebinding): build notes

**Baseline:** B1 (Gavin's working copy, `BimGo_Handoff_B2.zip`). **Not compiled here** (no .NET SDK in the sandbox).
Checked instead: brackets / parentheses balanced in every changed file; GameSession partials scanned for duplicate
member names (none new); new Core type names checked against the App's, the other Core namespaces and the
WinForms / System.Drawing names in use (no clash); the whole catalogue ported to Python (parsed from the C# source):
every enum value defined once, every action live somewhere, **no default clash in any of the 15 situations**, and the
README §3 tables generated from it. No shaders changed. Please build and run the Core tests (new `ControlsTests`: 19).

## How it fits together

- **Core `Scene/InputCatalog.cs`** (new): `InputAction` (101 actions; the enum names are the stored ids: never rename
  one), `InputContext` (16 groups), `ActionKind` (press / repeat / hold), `ActionDef` (group, label, kind, default
  chords, fixed), `InputSituation` (what can fire together: walking with each gun, holding an element, each editor,
  the tour, recording, the start screen; mirrors `GameSession.UpdateFrame`), `LiveTogether(a, b)`.
- **Core `Scene/KeyChord.cs`** (new): `KeyModifiers`, `KeyCodes` (virtual-key codes; mouse buttons 1 / 2 / 4 / 5 / 6;
  wheel 0x100 / 0x101; gamepad from 0x200 in build B; storage and display names; reserved keys), `IKeyState`,
  `KeyChord` (parse / store "Ctrl+Shift+S", display with an optional layout-name callback).
- **Core `Scene/KeyMap.cs`** (new): the live bindings (3 slots per action), `Pressed` / `PressedOrRepeated` / `Down`
  (no allocation; the modifier rule via per-slot "shadow" lists), `FindClashes`, `AllClashes`, `Refusal`, `Assign`
  (swap), `Clear`, `Reset`, `ResetAll`, `ToOverrides` / `ApplyOverrides` (settings), `Export` / `Import` (keymap
  JSON), cached labels, `DescribeJoined` / `DescribeRange` / `DescribeModifierVariant` (help text),
  `DefaultsMarkdown` (README).
- **Core `LaunchSettings`**: `KeyBindings` (only the changes), sanitised (trimmed ids, first of duplicates, ≤ 3 keys).
- **App `Platform/InputState.cs`**: implements `IKeyState`; mouse buttons now live in the key arrays (LeftPressed etc.
  read them); `OnButton` for MMB / Mouse 4 / 5; `Pressed(InputAction)` / `PressedOrRepeated` / `Down`;
  `ConsumeFrame` (the key capture). `GameWindow` handles `WM_MBUTTON*` / `WM_XBUTTON*`.
- **App `Platform/Hotkeys.cs`** (new): the app's map (read per walkthrough, saved at once by CONTROLS), punctuation
  named from the keyboard layout (`MapVirtualKeyW`). **`Platform/KeyHint.cs`** (new): text naming keys, cached until a
  binding changes.
- **Every key check moved onto actions:** `GameSession.UpdateFrame` (global, document, walking, tools, guns, wheel),
  `UpdateGuns` (gun primary / secondary), `Player` (movement), `GizmoController` / `GizmoPanel` (holding an element),
  Scan / Measure / Comment / Demolish / Gizmo / Clone / Place guns, sun panel (`StepSunTimeKeys` shared by walking,
  photo and the panel), photo mode, section editor, sun study, markup editor, tour, video, progress screen, start
  screen. Left raw on purpose: text boxes (comment / bookmark names, room / library / CONTROLS search, the sun panel's
  month / day, the location picker, markup text), UI clicks and drags, the photo wheel (listed as fixed).
- **Text naming keys:** F1 help is built from the map (`GameSession.Render.HelpRows`, "ESC → CONTROLS" row added);
  the gun bar's corner numbers and LMB / RMB tags follow the bindings; panel hints use `KeyHint`
  (`GameSession.Hints.cs` for the session, beside the code for the guns); toasts read `Hotkeys.Label`.
- **CONTROLS** (`GameSession.Controls.cs`, new): see README §5 *Input and key bindings*. Key capture runs first in
  `UpdateFrame` (before the markup editor) and consumes the frame, so nothing else reacts to the captured key; the
  search ignores typing for 3 frames after a capture (the key's character can arrive a frame later). LMB binds only
  when the waiting slot is clicked again; a click elsewhere cancels (so a stray click never binds LMB).
- **Tests** (`ControlsTests`, 19): catalogue integrity, every action live somewhere, defaults valid and clash-free per
  situation, separation between contexts that never meet, chord parse / format round trips (every code), display
  names, the modifier rule (H / Shift+H, 1 / Ctrl+1 / Shift+1, running jump, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Z while
  holding with Ctrl, [ / Shift+[ on repeat, wheel, LMB), refusals, clash + swap, swap leaving unbound, reset / clear,
  overrides through settings.json, unreadable overrides, settings sanitising, keymap round trip and refusal, help
  text, and **`Readme_ControlsTablesAreCurrent`**: when the README's tables differ from the defaults it rewrites the
  block between the markers and reports Inconclusive (review and commit README.md).

## Behaviour changes (small, with the defaults)

- Markup editor: holding Ctrl used to block every other key; now Ctrl+letter picks that tool and Ctrl+Esc /
  Ctrl+Enter cancel / save (the general rule: extra modifiers don't stop a key).
- The wheel's gun cycling is two actions (previous = wheel up, next = wheel down), same direction as before.
- Everything else should be identical (README §8 lists what to try).

## For build B

- Gamepad codes from `KeyCodes.GAMEPAD_FIRST` (refused by `KeyMap.Refusal` until then); a gamepad column means either
  a 4th slot or a separate gamepad slot per action (the file format can add it: version stays 1 with an extra key).
- Gun wheel: a new `GunWheel` action (hold, MMB default, keyboard unbound) in the Guns group; `InputSituation`
  "Walking" covers it. Hold actions can't use the wheel (already enforced).

## Judgement calls (say if you want them changed)

- CONTROLS in the session stack (keeps the review stack ≤ 9 rows for CLASHES).
- WASD / arrows and the gizmo's keys are rebindable; the gizmo's moves follow the walking move keys (A / D also turn in
  rotate mode).
- Fixed (listed in CONTROLS, not rebindable): Esc, Alt+F4, LMB for menus / panels / handles, RMB-drag look in the
  editors, Shift for finer slider steps, the photo wheel, Ctrl+O on the start screen. Refused as bindings: Esc, the
  Windows keys, Print Screen, the lock keys, Alt+F4.
- README §3: the generated tables replace the old controls table; the menu-only flows and details moved to a short
  hand-written notes list under them.

## Change after build A (2026-10-12, Gavin: build A confirmed working)

- Go to bookmark 1–9 defaults moved from **Ctrl+1–9 to Shift+1–9** (Ctrl is crouch, so Ctrl+number ducked first).
  Only the catalogue default changed (`InputCatalog`), so settings without a bookmark override pick it up. Trade-off:
  while running (Shift held) a number key goes to a bookmark instead of picking a gun; Ctrl+number now picks the gun
  (extra modifiers don't stop a key). Tests, README tables (regenerated) and comments updated; no clash (Python port).
