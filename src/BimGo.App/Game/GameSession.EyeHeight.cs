using BimGo.Audio;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Eye-height presets (tour round): standing, seated / wheelchair and child, picked in the pause menu (right column)
    /// and remembered in settings with each preset's height. The capsule follows the eye (collision, headroom, crouch);
    /// the step-up height stays the same. Bookmarks keep the eye height they were saved at: GO and the tour use it.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private static readonly string[] EYE_OPTIONS = { "Standing", "Seated", "Child" };

        /// <summary>Height step of the pause menu's − / + buttons (m).</summary>
        private const float EYE_STEP = 0.05f;

        // Each preset's eye height (m) and the preset in use; _eyeCustom when a bookmark set a height no preset has
        private readonly float[] _eyeHeights = { LaunchSettings.DEFAULT_EYE_STANDING, LaunchSettings.DEFAULT_EYE_SEATED, LaunchSettings.DEFAULT_EYE_CHILD };
        private EyePreset _eyePreset = EyePreset.Standing;
        private bool _eyeCustom;

        #endregion

        #region Setup

        /// <summary>
        /// Reads the presets from settings (constructor).
        /// </summary>
        private void ReadEyeSettings(LaunchSettings settings)
        {
            _eyeHeights[0] = settings.EyeHeightStanding;
            _eyeHeights[1] = settings.EyeHeightSeated;
            _eyeHeights[2] = settings.EyeHeightChild;
            _eyePreset = Enum.IsDefined(settings.EyePreset) ? settings.EyePreset : EyePreset.Standing;
        }

        /// <summary>
        /// Gives the new player the preset's height (Initialise, before spawning: no headroom check).
        /// </summary>
        private void InitialiseEyeHeight() => _player.Controller.SetStandingEye(_eyeHeights[(int)_eyePreset], force: true);

        /// <summary>
        /// Writes the presets into settings (shutdown).
        /// </summary>
        private void WriteEyeSettings(LaunchSettings settings)
        {
            settings.EyePreset = _eyePreset;
            settings.SetEyeHeight(EyePreset.Standing, _eyeHeights[0]);
            settings.SetEyeHeight(EyePreset.Seated, _eyeHeights[1]);
            settings.SetEyeHeight(EyePreset.Child, _eyeHeights[2]);
        }

        #endregion

        #region Actions

        /// <summary>The player's standing eye height now (m): what a new bookmark keeps.</summary>
        private float CurrentStandingEye => _player?.Controller.StandEye ?? LaunchSettings.DEFAULT_EYE_STANDING;

        /// <summary>
        /// Switches to a preset. Growing taller under a low ceiling is refused (walking); flying never is.
        /// </summary>
        private void SelectEyePreset(EyePreset preset)
        {
            if (_player == null) { return; }
            float eye = _eyeHeights[(int)preset];
            if (!_player.Controller.SetStandingEye(eye, force: _player.Flying))
            {
                Sound.Play(SoundId.Error);
                Toast($"No headroom for a {UnitFormat.Length(eye, 2)} eye height here: move somewhere taller first", 3f);
                return;
            }
            _eyePreset = preset;
            _eyeCustom = false;
        }

        /// <summary>
        /// Sets an exact eye height (bookmark GO): no headroom check (the view was saved there). The preset whose height
        /// matches becomes current, else the height reads CUSTOM until a preset is picked.
        /// </summary>
        private void ApplyEyeHeight(float eye)
        {
            if (_player == null) { return; }
            _player.Controller.SetStandingEye(eye, force: true);
            _eyeCustom = true;
            for (int i = 0; i < _eyeHeights.Length; i++)
            {
                if (MathF.Abs(_eyeHeights[i] - _player.Controller.StandEye) < 0.005f)
                {
                    _eyePreset = (EyePreset)i;
                    _eyeCustom = false;
                    break;
                }
            }
        }

        /// <summary>
        /// Pause menu − / +: changes the current preset's height (5 cm steps) and applies it.
        /// </summary>
        private void AdjustEyePreset(int direction)
        {
            int index = (int)_eyePreset;
            float before = _eyeHeights[index];
            float value = MathF.Round(Math.Clamp(before + direction * EYE_STEP, LaunchSettings.MIN_EYE_HEIGHT, LaunchSettings.MAX_EYE_HEIGHT) * 100f) / 100f;
            if (value == before) { return; }
            _eyeHeights[index] = value;
            if (!_player.Controller.SetStandingEye(value, force: _player.Flying || value < before))
            {
                _eyeHeights[index] = before;
                Sound.Play(SoundId.Error);
                Toast("No headroom to raise the eye here: move somewhere taller first", 3f);
                return;
            }
            _eyeCustom = false;
        }

        /// <summary>
        /// The status panel's MODE value: walk / crouch / fly, with the preset when it isn't standing (no allocation).
        /// </summary>
        private string ModeLabel()
        {
            if (_player.Flying) { return "FLY"; }
            bool crouch = _player.Controller.Crouching;
            if (_eyeCustom) { return crouch ? "CROUCH · CUSTOM EYE" : "WALK · CUSTOM EYE"; }
            return _eyePreset switch
            {
                EyePreset.Seated => crouch ? "CROUCH · SEATED" : "WALK · SEATED",
                EyePreset.Child => crouch ? "CROUCH · CHILD" : "WALK · CHILD",
                _ => crouch ? "CROUCH" : "WALK"
            };
        }

        #endregion

        #region Pause menu

        /// <summary>
        /// The pause menu's eye-height row: preset buttons, then − / + for the current preset's height.
        /// </summary>
        /// <returns>The height used (unscaled pixels are scaled inside).</returns>
        private float BuildEyeHeightRow(FontAtlas f, InputState input, float x, float y, float width)
        {
            _ui.Text(f.Small, x, y + S(2), "EYE HEIGHT", UiTheme.TEXT_MUTED, S(1.8f));
            Text.Clear();
            if (_eyeCustom) { Text.Append("CUSTOM ").AppendLength(_player.Controller.StandEye, 2); }
            else { Text.AppendLength(_eyeHeights[(int)_eyePreset], 2); }
            _ui.TextRight(f.Mono, x + width, y + S(1), Text.Span, _eyeCustom ? UiTheme.MEASURE_LABEL : Rgba.Hex(0x67E8F9));

            float buttonW = S(34), gap = S(6);
            float segmentsW = width - buttonW * 2f - gap * 2f;
            int shown = _eyeCustom ? -1 : (int)_eyePreset;
            int picked = Segmented(f, input, x, y + S(22), segmentsW, EYE_OPTIONS, shown);
            if (picked != shown && picked >= 0) { SelectEyePreset((EyePreset)picked); }

            float bx = x + segmentsW + gap, by = y + S(22), bh = S(32);
            if (SmallButton(f, input, bx, by, buttonW, bh, "−")) { AdjustEyePreset(-1); }
            if (SmallButton(f, input, bx + buttonW + gap, by, buttonW, bh, "+")) { AdjustEyePreset(+1); }
            return S(66);
        }

        #endregion
    }
}
