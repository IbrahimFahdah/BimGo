using System.Numerics;
using BimGo.Platform;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// The gamepad in the walkthrough (input round B2, build B): a secondary input beside the keyboard and mouse.
    /// Movement, buttons and triggers go through the action map like keys (<see cref="Player"/> reads the sticks as
    /// analog axes); this file adds what keys don't have: analog look, the sprint toggle, the cursor mode for menus and
    /// editors, and looking in the free-cursor editors.
    /// </summary>
    internal sealed partial class GameSession
    {
        /// <summary>
        /// What the gamepad does with the free cursor this frame: menus, panels and text boxes → Menu; the free-cursor
        /// editors → Editor; walking, a tour, a video and a key capture → Off.
        /// </summary>
        private PadCursorMode CurrentPadCursorMode()
        {
            if (_tourActive || _video != null || IsCapturingKey || IsMappingPad) { return PadCursorMode.Off; }
            if (_paused || IsEditingComment || _markupOpen) { return PadCursorMode.Menu; }
            if (_photoOpen || _sectionOpen || _sunHoursOpen || _sunPanelOpen || _clashModeOn) { return PadCursorMode.Editor; }
            return PadCursorMode.Off;
        }

        /// <summary>
        /// Walking: the look actions turn the camera at a rate (gamepad stick: analog with a squared response; a key
        /// bound to them turns at full rate), scaled by the gamepad look speed and invert Y. Nothing when they rest.
        /// </summary>
        private void PadLook(InputState input)
        {
            var look = new Vector2(input.Axis(InputAction.LookRight) - input.Axis(InputAction.LookLeft),
                input.Axis(InputAction.LookUp) - input.Axis(InputAction.LookDown));
            if (look == Vector2.Zero) { return; }
            if (look.LengthSquared() > 1f) { look = Vector2.Normalize(look); }
            look = Gamepad.Curve(look);
            float rate = Gamepad.LOOK_RADIANS_PER_SECOND * Gamepad.LookSensitivity * _frameTime;
            _player.Turn(-look.X * rate, (Gamepad.InvertY ? -look.Y : look.Y) * rate);
        }

        /// <summary>
        /// The free-cursor editors (photo, section box, study): the look stick drives the cursor there, so the move stick
        /// looks around instead (the player stands still).
        /// </summary>
        private void PadEditorLook(InputState input)
        {
            if (!input.PadConnected) { return; }
            Vector2 look = Gamepad.Curve(Gamepad.MoveStick(input));
            if (look == Vector2.Zero) { return; }
            float rate = Gamepad.LOOK_RADIANS_PER_SECOND * Gamepad.LookSensitivity * _frameTime;
            _player.Turn(-look.X * rate, (Gamepad.InvertY ? -look.Y : look.Y) * rate);
        }

        /// <summary>
        /// Gamepad sprint: the run binding's gamepad button (the stick click) toggles it; it ends when movement stops.
        /// Keyboard Shift is untouched (held, as before).
        /// </summary>
        private void UpdatePadSprint(InputState input)
        {
            if (input.PressedByPad(InputAction.Run)) { _player.PadSprint = !_player.PadSprint; }
            float moving = MathF.Abs(input.Axis(InputAction.MoveForward) - input.Axis(InputAction.MoveBack))
                + MathF.Abs(input.Axis(InputAction.MoveRight) - input.Axis(InputAction.MoveLeft));
            if (moving < 0.2f) { _player.PadSprint = false; }
        }
    }
}
