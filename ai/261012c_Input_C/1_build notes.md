# Round B2, build B2-C (generic controllers, F1 off): build notes

**Why:** Gavin's controller is a "Generic USB Joystick" (an Xbox-style pad without the centre buttons) that XInput
doesn't see, so build B said "none connected". He chose direct support (option 2) over Steam Input / x360ce. Also
asked: F1 help off by default, with a small "F1: Help" note bottom left.

**Baseline:** B2-B2 (sticks: move left, look right). **Not compiled here.** Brackets checked, GameSession partials
scanned (no duplicates). Core tests: `ControlsTests` 22 (new `GenericPad_SourcesAndMapping`).

## Core
- `Scene/GenericPadMap.cs` (new): `PadSourceKind`, `PadSource` (a button "B1"–"B32", a hat direction "POVU/R/D/L",
  an axis direction "X+" … "V-"; `Opposite`), `GenericPadMap` (one source per gamepad code; `Evaluate` → 0–1 per code,
  hat diagonals press both directions; `Detect` / `AtRest` for mapping; `ToSettings` / `FromSettings`;
  `XboxStyleGuess`: buttons 1–10 = A B X Y LB RB Back Start LS RS, hat = D-pad, X/Y left stick, U/R right stick, Z
  triggers).
- `LaunchSettings`: `GenericPadMap`, `GenericPadName`.

## App
- `Native/Joystick.cs` (new): `joyGetNumDevs`, `joyGetPosEx` (all axes, buttons, continuous hat), `joyGetDevCapsW`.
- `Platform/Gamepad.cs`: when no XInput controller answers, scans the joystick ids every 2 s; reads axes over their
  reported ranges, buttons and hat; the map gives the same 24 gamepad codes; triggers → threshold, sticks → the same
  radial dead zone; **LB + RB together are Start when nothing is mapped to Start**; `Mapping` holds everything back
  while MAP BUTTONS runs; raw reading exposed for it; an XInput pad still wins when both are present. The map and the
  pad's name are saved with the other gamepad settings.
- `Game/GameSession.PadMapping.cs` (new): MAP BUTTONS (20 steps; "let go" between steps; SKIP; CANCEL / Esc;
  saved at the end). CONTROLS shows the controller's name and a MAP BUTTONS… button for a generic controller; the
  mapping strip replaces the notice line; nothing else in the panel reacts while mapping; the gamepad cursor is off.
- F1: `_showHelp` starts false; the hidden-help note is "F1: Help" (the bound key) in the small font, bottom left.

## To try (Gavin's pad)
1. CONTROLS: the GAMEPAD row shows "Generic USB Joystick" (log: axes / buttons / hat counts).
2. MAP BUTTONS…: leave the pad alone, then press each input when asked (let go between). SKIP Back and Start (no
   centre buttons): LB + RB together will open the menu.
3. Walk: left stick moves, right stick looks (check the dead zone; if a stick drifts, raise it), triggers fire, RS
   click → gun wheel, LB + RB → pause menu, A clicks / B backs out there.

## Judgement calls
- One generic map per machine (not per device); an Xbox pad over XInput doesn't use it.
- Triggers that are axes resting at −1 read from their mid-travel onwards ("Z+"); triggers that are buttons are on/off.

## Fixes after build C (2026-10-12)
- **CS0246 `WinMm` not found:** the new `Native/WinMM.cs` had the same name as the existing `Native/WinMm.cs` (the
  sound player) except for case, so unzipping on Windows replaced it. Renamed the joystick interop to
  `Native/Joystick.cs` (class `Joystick`); `Platform/Gamepad.cs` uses it. Restore `Native/WinMm.cs` from this zip.
- Pause menu: CATEGORIES & LINKS shows a `*` when anything is switched off, instead of "(n OFF)".
- CONTROLS gamepad row (C3): the sliders no longer run under Invert Y / MAP BUTTONS / SWAP STICKS. The row reserves
  room for Invert Y and the buttons (one or two, 150 px each) and the sliders share what's left; when that leaves a
  slider under 150 px (narrow window) the buttons drop to their own line under the sliders. Gamepad name column 160 px.
