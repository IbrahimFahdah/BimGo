# Round B2, build B (gamepad, gun wheel): build notes

**Baseline:** build A2 (Gavin's working copy). **Not compiled here** (no .NET SDK). Checked instead: brackets in every
changed file, GameSession partials for duplicate members (none), the catalogue in the Python port (108 actions, 49
gamepad defaults, **no clash, keyboard or gamepad, in any of the 16 situations**; README §3 regenerated with a Gamepad
column). Please build and run the Core tests (`ControlsTests`: 21, two new for the gamepad).

## Keyboard and mouse stay as they were

Nothing changes without a controller: the gamepad codes never fire, the cursor is never moved, no clicks are injected.
With one connected but untouched, the same. The only new mouse binding is **MMB** (gun wheel), which was unused.
Movement reads keys as 0 / 1 through `Axis` (same values as before; holding A and ← together in the gizmo's rotate
mode no longer turns twice as fast). Guns fire from the mouse only while it is captured (as before); the triggers can
also fire while it isn't (walking, no menu or editor open).

## Core

- `KeyChord.cs`: 24 gamepad codes (`PAD_A` … `PAD_RS_RIGHT`, from 0x200; storage "PadA", "PadLSUp"…; display "A",
  "D-pad ↑", "LS ↑", "RS click"…), `KeyModifiers.PadLB / PadRB` (the shoulders as modifiers: "PadLB+PadUp", shown
  "LB+D-pad ↑"), `IKeyState.KeyAnalog`.
- `InputCatalog.cs`: new actions `LookUp/Down/Left/Right` (Movement; gamepad only by default), `GunWheel` (Guns; MMB,
  RS click), fixed `PadClick` (A) and `PadMenuBack` (B) for menus and editors; `ActionDef.PadDefault`; the gamepad
  defaults (below); a 16th situation "Pause menu and panels"; the editors and the start screen include A / B.
- `KeyMap.cs`: a 4th slot per action for the gamepad (`PAD_SLOT`; `MAX_SLOTS` stays 3 for keys), `Axis` (0–1,
  analog), `PressedSlot` (which slot fired), `PadChord`, `PadLabel`, `SwapPad`, `IsKeyDefault`; `Refusal` takes the
  slot (gamepad inputs only in the gamepad column, keys only in key columns, LB / RB only with gamepad inputs);
  `ToPadOverrides` / `ApplyOverrides(keys, problems, pad)`; keymap files gain `"pad"` (older files read as before).
- `LaunchSettings`: `PadBindings`, `PadLookSensitivity`, `PadInvertY`, `PadDeadZone`, `PadTriggerThreshold` (sanitised).

## Gamepad defaults (Xbox-style; rebindable in CONTROLS)

| Input | Walking | Holding an element | Menus / editors |
|---|---|---|---|
| Left stick | move (LS click: sprint toggle) | move it | scroll (menus) / look (editors) |
| Right stick | look (RS click: gun wheel) | look (RS click: fine) | cursor |
| A · B · X · Y | jump · crouch · the gun's key · fly | — · — · drop · move ↔ rotate | click · back |
| D-pad ↑ ↓ | level up / down | move it up / down | |
| D-pad ← → | sun time −/+ (shadows on; repeats) | smaller / larger snap step | |
| LB + D-pad ↑ ↓ ← → | shadows · lights · go home · coordinates | | |
| RB + D-pad ↑ ↓ ← → | photo · section box · study · sun panel | | |
| LB + X · RB + X | Scan isolate, Gizmo snap · clear markers | Gizmo snap | |
| RT · LT | gun primary · secondary | commit | photo mode: RT takes the photo |
| Back · LB + Back · Start | minimap · help · pause | minimap · help · cancel (Esc) | Start: resume |

Tour: A pause, D-pad ← / → stops. Gun wheel open: point with the look stick, A or RS click picks, B / Start closes.

## App

- `Native/XInput.cs` (new): `XInputGetState` from `xinput1_4.dll` (in Windows 8+; no package, nothing to ship).
- `Platform/Gamepad.cs` (new): polled from `GameWindow.PumpMessages` (every loop: walkthrough, start screen, progress
  screens); first connected controller, rescans every 2 s; radial dead zone and trigger threshold; sticks to four
  analog directions each; `DriveCursor` (`PadCursorMode` Off / Menu / Editor, set by the session each frame): the look
  stick moves the Windows cursor (so every widget works unchanged), A is the left button (held: drags), B is Esc
  (and char 27 for text boxes), the move stick scrolls in menus; tuning (static, settings). Missing XInput: logged, off.
- `InputState`: gamepad state with edges and auto-repeat (0.4 s, then 0.1 s), sticks, `PadConnected`,
  `LastInputWasPad`, `Axis`, `PressedByPad`, `InjectLeft`, `InjectEscape`. Pausing doesn't clear the gamepad's held
  state (Start would repeat).
- `Player`: analog movement through `Axis`; `PadSprint`; `Turn`. `GizmoController`: analog moves.
- `GameSession.Gamepad.cs` (new): cursor mode, `PadLook` (walking and holding; 3 rad/s × look speed, squared
  response, invert Y), `PadEditorLook` (photo, section box, study: the move stick looks), sprint toggle.
- `GameSession.GunWheel.cs` (new): the wheel (see README §5); drawn over the HUD (also with the UI hidden); nothing
  fires and looking pauses while it is open; Esc / Start close it.
- CONTROLS: a GAMEPAD column (capture: a button, trigger, stick direction, LB / RB + one, or LB / RB alone on release;
  keys ignored there except Esc), a tuning row (look speed, dead zone, trigger threshold, invert Y, **SWAP STICKS**),
  search finds gamepad labels. F1 help adds two gamepad rows while a controller is connected; the gun bar shows
  RT / LT when the gamepad was used last.

## Judgement calls (say if you want them changed)

- LB and RB have no bindings of their own (they are the combination buttons); guns are picked with the wheel.
- No gamepad binding for bookmarks 1–9, adding a bookmark, comment editing or the editors' tools (they need typing or
  have buttons A can click).
- Sprint is a toggle on the stick click (ends when you stop), keyboard Shift is still held.
- The gun wheel on the gamepad is click-to-open (as asked), on the mouse hold-and-release (as agreed).
- The menu cursor follows the look stick (right by default), so SWAP STICKS swaps it too.

## Change after build B (2026-10-12)

- Gavin: "look right move left" — the defaults are now **move on the left stick, look on the right** (the usual
  layout). The cursor in menus and the gun wheel follow the look stick (right); the left stick scrolls menus and looks
  in the editors. RS click still opens the gun wheel, LS click sprints. SWAP STICKS still flips them.
