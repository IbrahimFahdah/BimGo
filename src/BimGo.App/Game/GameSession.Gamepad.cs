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
            if (_photoOpen || _sectionOpen || _sunHoursOpen || _sunPanelOpen || _clashModeOn || _gridsPanelOpen || _pathEditOn) { return PadCursorMode.Editor; }
            return PadCursorMode.Off;
        }

        /// <summary>
        /// Polish round P-B: the <see cref="InputCatalog.Situations"/> entry the app is in (its name), for the generated F1
        /// sheet. Follows <see cref="UpdateFrame"/>'s order (what has the keys first): change the two together.
        /// </summary>
        private string CurrentSituation()
        {
            if (_tourActive) { return InputCatalog.SIT_TOUR; }
            if (_video != null) { return InputCatalog.SIT_VIDEO; }
            if (_paused) { return InputCatalog.SIT_PAUSE; }
            if (_markupOpen) { return InputCatalog.SIT_MARKUP; }
            if (_sunHoursOpen) { return InputCatalog.SIT_STUDY; }
            if (_photoOpen) { return InputCatalog.SIT_PHOTO; }
            if (_sectionOpen) { return InputCatalog.SIT_SECTION; }
            if (_sunPanelOpen) { return InputCatalog.SIT_SUN_PANEL; }
            if (GridsPanelHasKeys) { return InputCatalog.SIT_GRIDS; }
            if (_pathEditOn) { return InputCatalog.SIT_PATH; } // Round K-B
            if (_clashModeOn) { return InputCatalog.SIT_CLASHES; }
            Guns.Gun gun = _guns[_activeGun];
            if (gun.CapturesInput) { return InputCatalog.SIT_HOLDING; }
            if (_unarmed) { return InputCatalog.SIT_WALKING; }
            return gun switch
            {
                Guns.ScanGun => InputCatalog.SIT_SCAN,
                Guns.MeasureGun => InputCatalog.SIT_MEASURE,
                Guns.CommentGun => InputCatalog.SIT_COMMENT,
                Guns.HammerGun => InputCatalog.SIT_DEMOLISH,
                Guns.GizmoGun or Guns.CloneGun or Guns.PlaceGun => InputCatalog.SIT_GIZMO,
                _ => InputCatalog.SIT_WALKING
            };
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
