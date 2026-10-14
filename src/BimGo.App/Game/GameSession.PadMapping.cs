using BimGo.Audio;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// CONTROLS → MAP BUTTONS (input round B2, build B2-C): for a generic controller (not XInput) BimGo asks for each
    /// Xbox-style button in turn and records which of the pad's buttons, hat directions or axes it is. Leave the pad
    /// alone when it starts (that reading is "at rest"); press each input when asked and let go; SKIP leaves one
    /// unmapped (without Start, LB + RB together open the menu); Esc or CANCEL keeps the previous map. Saved at once.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>The step being asked (-1: not mapping).</summary>
        private int _padMapStep = -1;
        private GenericPadMap _padMapWork;
        private readonly float[] _padMapRest = new float[GenericPadMap.AXES];
        private uint _padMapRestButtons;
        private bool _padMapWaitRelease;

        /// <summary>The steps: what to press, and the gamepad code it becomes (stick steps also set the opposite direction).</summary>
        private static readonly (ushort Code, string Prompt)[] PAD_MAP_STEPS =
        {
            (KeyCodes.PAD_A, "A (the bottom face button)"),
            (KeyCodes.PAD_B, "B (the right face button)"),
            (KeyCodes.PAD_X, "X (the left face button)"),
            (KeyCodes.PAD_Y, "Y (the top face button)"),
            (KeyCodes.PAD_LB, "LB (left shoulder)"),
            (KeyCodes.PAD_RB, "RB (right shoulder)"),
            (KeyCodes.PAD_LT, "LT (left trigger)"),
            (KeyCodes.PAD_RT, "RT (right trigger)"),
            (KeyCodes.PAD_UP, "D-pad up"),
            (KeyCodes.PAD_DOWN, "D-pad down"),
            (KeyCodes.PAD_LEFT, "D-pad left"),
            (KeyCodes.PAD_RIGHT, "D-pad right"),
            (KeyCodes.PAD_LS_UP, "the LEFT stick UP (push it, then let go)"),
            (KeyCodes.PAD_LS_LEFT, "the LEFT stick LEFT"),
            (KeyCodes.PAD_RS_UP, "the RIGHT stick UP"),
            (KeyCodes.PAD_RS_LEFT, "the RIGHT stick LEFT"),
            (KeyCodes.PAD_LS, "a click of the LEFT stick"),
            (KeyCodes.PAD_RS, "a click of the RIGHT stick"),
            (KeyCodes.PAD_BACK, "Back / Select (SKIP if there isn't one)"),
            (KeyCodes.PAD_START, "Start (SKIP if there isn't one: LB + RB together will open the menu)")
        };

        #endregion

        /// <summary>True while MAP BUTTONS runs (it has the controller and Esc).</summary>
        private bool IsMappingPad => _padMapStep >= 0;

        /// <summary>MAP BUTTONS: starts with the controller's current reading as "at rest".</summary>
        private void BeginPadMapping()
        {
            if (!Gamepad.IsGeneric) { return; }
            EndKeyCapture();
            _pendingAction = InputAction.None;
            _padMapWork = new GenericPadMap();
            Array.Copy(Gamepad.RawAxes, _padMapRest, GenericPadMap.AXES);
            _padMapRestButtons = Gamepad.RawButtons;
            _padMapStep = 0;
            _padMapWaitRelease = !GenericPadMap.AtRest(_padMapRest, _padMapRestButtons, Gamepad.RawAxes, Gamepad.RawButtons, Gamepad.RawPov);
            Gamepad.Mapping = true;
            SetControlsNotice(null, false);
        }

        /// <summary>Stops mapping; <paramref name="save"/> keeps the new map (saved at once).</summary>
        private void EndPadMapping(bool save)
        {
            if (_padMapStep < 0) { return; }
            _padMapStep = -1;
            Gamepad.Mapping = false;
            if (save && _padMapWork != null)
            {
                Gamepad.GenericMap = _padMapWork;
                Hotkeys.Save();
                Sound.Play(SoundId.Commit);
                SetControlsNotice($"{Gamepad.Description}: {_padMapWork.MappedCount} inputs mapped and saved", error: false);
            }
            else
            {
                SetControlsNotice("Map not changed", error: false);
            }
            _padMapWork = null;
        }

        /// <summary>
        /// Each frame while mapping (from <see cref="UpdateFrame"/>, before anything else reads keys): Esc cancels; after
        /// each capture the pad must come back to rest; then the first input that leaves rest is this step's.
        /// </summary>
        private void UpdatePadMapping(InputState input)
        {
            if (!_controlsOpen || !Gamepad.IsGeneric)
            {
                EndPadMapping(save: false);
                return;
            }
            if (input.IsPressed(KeyCodes.ESCAPE))
            {
                EndPadMapping(save: false);
                return;
            }
            if (_padMapWaitRelease)
            {
                if (GenericPadMap.AtRest(_padMapRest, _padMapRestButtons, Gamepad.RawAxes, Gamepad.RawButtons, Gamepad.RawPov)) { _padMapWaitRelease = false; }
                return;
            }
            PadSource source = GenericPadMap.Detect(_padMapRest, _padMapRestButtons, Gamepad.RawAxes, Gamepad.RawButtons, Gamepad.RawPov);
            if (source.IsNone) { return; }
            RecordPadMapStep(source);
            _padMapWaitRelease = true;
        }

        /// <summary>Records this step's input (None: skipped) and moves on; after the last step the map is saved.</summary>
        private void RecordPadMapStep(PadSource source)
        {
            ushort code = PAD_MAP_STEPS[_padMapStep].Code;
            if (KeyCodes.IsPadStick(code)) { _padMapWork.Set(code, source); _padMapWork.Set(OppositeStickCode(code), source.Opposite); }
            else { _padMapWork.Set(code, source); }
            Sound.Play(source.IsNone ? SoundId.UiClick : SoundId.Commit);
            _padMapStep++;
            if (_padMapStep >= PAD_MAP_STEPS.Length) { EndPadMapping(save: true); }
        }

        /// <summary>A stick direction's opposite (up ↔ down, left ↔ right).</summary>
        private static ushort OppositeStickCode(ushort code)
        {
            int offset = (code - KeyCodes.PAD_LS_UP) % 4; // 0 up, 1 down, 2 left, 3 right
            return (ushort)(code + (offset % 2 == 0 ? 1 : -1));
        }

        /// <summary>The mapping strip in CONTROLS (in place of the notice): the step, what to press, SKIP and CANCEL.</summary>
        private void BuildPadMappingStrip(FontAtlas f, InputState input, float x, float y, float w, float h)
        {
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.ACCENT);
            float buttonsW = S(230);
            Text.Clear().Append("MAP BUTTONS ").Append(_padMapStep + 1).Append(" of ").Append(PAD_MAP_STEPS.Length).Append(": ");
            if (_padMapWaitRelease) { Text.Append("let go of the controller…"); }
            else { Text.Append("press ").Append(PAD_MAP_STEPS[_padMapStep].Prompt); }
            _ui.TextWrapped(f.Body, x + S(12), y + h * 0.5f - f.Body.LineHeight * 0.5f, w - buttonsW - S(36), Text.Span, UiTheme.TEXT, maxLines: 1);
            if (SmallButton(f, input, x + w - buttonsW - S(6), y + S(3), S(100), S(28), "SKIP"))
            {
                _padMapWaitRelease = false;
                RecordPadMapStep(PadSource.None);
            }
            else if (SmallButton(f, input, x + w - S(126), y + S(3), S(120), S(28), "CANCEL"))
            {
                EndPadMapping(save: false);
            }
        }
    }
}
