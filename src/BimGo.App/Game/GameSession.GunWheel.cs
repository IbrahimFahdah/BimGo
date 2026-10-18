using System.Numerics;
using BimGo.Audio;
using BimGo.Game.Guns;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// The gun wheel (input round B2, build B): the guns on a ring around the crosshair. Mouse (MMB by default): hold,
    /// move the mouse towards a gun, release to pick it (released near the centre: nothing changes). Gamepad (the move
    /// stick's click by default): click, point the look stick at a gun, then A or the click again picks it; B, Start or
    /// Esc closes it. The number keys still pick guns directly. Looking pauses while it is open; walking doesn't.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private bool _wheelOpen;
        private bool _wheelByPad;
        private Vector2 _wheelPointer;
        private int _wheelHover = -1;

        /// <summary>The wheel's radius (unscaled px): the mouse pointer stops at its edge.</summary>
        private const float WHEEL_RADIUS = 150f;

        /// <summary>Within this share of the radius the mouse pointer picks nothing.</summary>
        private const float WHEEL_DEAD = 0.3f;

        /// <summary>The hover value of the wheel's "gun bar" slot (at the bottom): letting go there shows / hides the bar.</summary>
        private const int WHEEL_BAR = -2;

        /// <summary>The hover value of the wheel's UNARMED slot (beside the bar switch): letting go there puts the gun away.</summary>
        private const int WHEEL_UNARMED = -3;

        /// <summary>The gun bar at the bottom of the screen (off by default since the polish round; remembered).</summary>
        private bool _showGunBar;

        /// <summary>Slots on the wheel: every gun plus the gun bar switch.</summary>
        private int WheelSlotCount => _guns.Length + 2;

        /// <summary>The bar switch's slot (half way round from gun 1: the bottom).</summary>
        private int WheelBarSlot => WheelSlotCount / 2;

        #endregion

        /// <summary>
        /// Walking (no gun holding the keys): opens, steers and closes the wheel.
        /// </summary>
        /// <returns>True while it is open (the walking keys wait).</returns>
        private bool UpdateGunWheel(InputState input)
        {
            if (!_wheelOpen)
            {
                if (!input.Pressed(InputAction.GunWheel)) { return false; }
                _wheelOpen = true;
                _wheelByPad = input.PressedByPad(InputAction.GunWheel);
                _wheelPointer = Vector2.Zero;
                _wheelHover = -1;
                Sound.Play(SoundId.UiClick);
                return true;
            }

            if (_wheelByPad)
            {
                // The look stick points at a gun; the gun stays highlighted when the stick springs back
                Vector2 stick = Gamepad.LookStick(input);
                if (stick.LengthSquared() >= 0.25f) { _wheelHover = WheelSlot(new Vector2(stick.X, -stick.Y)); }
                if (input.Pressed(InputAction.GunWheel) || input.Pressed(InputAction.PadClick)) { CloseGunWheel(pick: true); }
                else if (input.Pressed(InputAction.PadMenuBack)) { CloseGunWheel(pick: false); }
                return true;
            }

            // Mouse: the pointer follows the raw movement (the cursor stays captured), clamped to the ring
            float radius = S(WHEEL_RADIUS);
            _wheelPointer += new Vector2(input.MouseDeltaX, input.MouseDeltaY) * 0.8f;
            if (_wheelPointer.Length() > radius) { _wheelPointer = Vector2.Normalize(_wheelPointer) * radius; }
            _wheelHover = _wheelPointer.Length() >= radius * WHEEL_DEAD ? WheelSlot(_wheelPointer) : -1;
            if (!input.Down(InputAction.GunWheel)) { CloseGunWheel(pick: true); }
            return true;
        }

        /// <summary>Closes the wheel, picking the highlighted gun (the same gun: nothing changes).</summary>
        private void CloseGunWheel(bool pick)
        {
            if (!_wheelOpen) { return; }
            _wheelOpen = false;
            if (pick && _wheelHover == WHEEL_BAR)
            {
                _showGunBar = !_showGunBar;
                Sound.Play(SoundId.UiClick);
                Toast(_showGunBar ? "Gun bar shown (the gun wheel's bottom slot hides it)" : $"Gun bar hidden: {Hotkeys.Label(InputAction.GunWheel)} opens the gun wheel", 2.5f);
            }
            else if (pick && _wheelHover == WHEEL_UNARMED) { SetUnarmed(true); }
            else if (pick && _wheelHover >= 0 && _wheelHover < _guns.Length && (_wheelHover != _activeGun || _unarmed)) { SelectGun(_wheelHover); }
            else if (!pick) { Sound.Play(SoundId.UiClick); }
            _wheelHover = -1;
        }

        /// <summary>
        /// What a direction points at (screen space, y down): a gun index (gun 1 at the top, then clockwise, skipping the
        /// bottom slot) or <see cref="WHEEL_BAR"/>.
        /// </summary>
        private int WheelSlot(Vector2 direction)
        {
            int count = WheelSlotCount;
            float angle = MathF.Atan2(direction.Y, direction.X) + MathF.PI * 0.5f; // 0 = up
            float step = MathF.Tau / count;
            int slot = (int)MathF.Round(angle / step);
            return WheelSlotTarget(((slot % count) + count) % count);
        }

        /// <summary>A slot's gun index, <see cref="WHEEL_BAR"/> for the bar switch, or <see cref="WHEEL_UNARMED"/> (the slot after it).</summary>
        private int WheelSlotTarget(int slot) => slot == WheelBarSlot ? WHEEL_BAR : slot == WheelBarSlot + 1 ? WHEEL_UNARMED : slot < WheelBarSlot ? slot : slot - 2;

        /// <summary>
        /// Draws the wheel: a dark disc, a wedge per gun (the highlighted one in its colour) with its icon and key, the
        /// highlighted (or current) gun's name in the middle, and how to pick.
        /// </summary>
        private void BuildGunWheel(FontAtlas f, int width, int height)
        {
            if (!_wheelOpen) { return; }
            float cx = MathF.Round(width * 0.5f), cy = MathF.Round(height * 0.5f);
            float radius = S(WHEEL_RADIUS), inner = radius * 0.34f;
            int count = WheelSlotCount;
            float step = MathF.Tau / count;

            _ui.Circle(cx, cy, radius + S(10), Rgba.Hex(0x0C0E12, 0.78f), 48);
            for (int slot = 0; slot < count; slot++)
            {
                int target = WheelSlotTarget(slot);
                float mid = -MathF.PI * 0.5f + slot * step;
                bool hover = target == _wheelHover;
                float ix = cx + MathF.Cos(mid) * radius * 0.68f, iy = cy + MathF.Sin(mid) * radius * 0.68f;

                // Separator
                float edge = mid - step * 0.5f;
                _ui.Line(cx + MathF.Cos(edge) * inner, cy + MathF.Sin(edge) * inner, cx + MathF.Cos(edge) * radius, cy + MathF.Sin(edge) * radius,
                    MathF.Max(1f, UiScale), Rgba.Hex(0xFFFFFF, 0.12f));

                if (target == WHEEL_BAR)
                {
                    // The gun bar switch: three little slots, lit when the bar is shown
                    if (hover) { _ui.Wedge(cx, cy, radius, mid - step * 0.5f, mid + step * 0.5f, Rgba.Hex(0xFFFFFF, 0.16f), 10); }
                    uint barColour = hover ? UiTheme.TEXT : _showGunBar ? UiTheme.ACCENT : UiTheme.TEXT_FAINT;
                    float cell = S(hover ? 9 : 8);
                    for (int k = -1; k <= 1; k++) { _ui.Outline(ix + k * (cell + S(2)) - cell * 0.5f, iy - cell * 0.5f - S(4), cell, cell, MathF.Max(1f, S(1.5f)), barColour); }
                    _ui.TextCentred(f.Small, ix, iy + S(10), _showGunBar ? "BAR ON" : "BAR OFF", barColour);
                    continue;
                }
                if (target == WHEEL_UNARMED)
                {
                    // Unarmed: an empty hand (a ring with a slash), lit while no gun is out
                    if (hover) { _ui.Wedge(cx, cy, radius, mid - step * 0.5f, mid + step * 0.5f, Rgba.Hex(0xFFFFFF, 0.16f), 10); }
                    uint handColour = hover ? UiTheme.TEXT : _unarmed ? UiTheme.ACCENT : UiTheme.TEXT_FAINT;
                    float r = S(hover ? 10 : 9);
                    _ui.Ring(ix, iy - S(4), r, MathF.Max(1f, S(1.5f)), handColour, 20);
                    _ui.Line(ix - r * 0.7f, iy - S(4) + r * 0.7f, ix + r * 0.7f, iy - S(4) - r * 0.7f, MathF.Max(1f, S(1.5f)), handColour);
                    _ui.TextCentred(f.Small, ix, iy + S(10), "NONE", handColour);
                    continue;
                }

                Gun gun = _guns[target];
                bool current = target == _activeGun && !_unarmed;
                if (hover) { _ui.Wedge(cx, cy, radius, mid - step * 0.5f, mid + step * 0.5f, Rgba.WithAlpha(gun.Colour, 0.35f), 10); }
                gun.DrawIcon(_ui, ix, iy, S(hover ? 34 : 28), hover || current ? gun.Colour : UiTheme.TEXT_MUTED);
                _ui.TextCentred(f.Small, ix, iy + S(18), gun.Key, hover ? gun.Colour : UiTheme.TEXT_FAINT);
            }
            _ui.Ring(cx, cy, radius, MathF.Max(1f, UiScale), Rgba.Hex(0xFFFFFF, 0.18f), 48);
            _ui.Circle(cx, cy, inner, Rgba.Hex(0x0C0E12, 0.9f), 32);

            if (_wheelHover == WHEEL_UNARMED)
            {
                _ui.TextCentred(f.Bold, cx, cy - f.Bold.LineHeight * 0.5f, "None", UiTheme.TEXT, S(1f));
            }
            else if (_wheelHover == WHEEL_BAR)
            {
                _ui.TextCentred(f.Bold, cx, cy - f.Bold.LineHeight * 0.5f, _showGunBar ? "Hide gun bar" : "Show gun bar", UiTheme.TEXT, S(1f));
            }
            else
            {
                Gun shown = _wheelHover >= 0 ? _guns[_wheelHover] : _guns[_activeGun];
                string name = _wheelHover < 0 && _unarmed ? "None" : shown.Name;
                _ui.TextCentred(f.Bold, cx, cy - f.Bold.LineHeight * 0.5f, name, _wheelHover >= 0 ? shown.Colour : UiTheme.TEXT_MUTED, S(1f));
            }
            _ui.TextCentred(f.Small, cx, cy + radius + S(18), _wheelByPad ? HINT_WHEEL_PAD.Text : HINT_WHEEL_MOUSE.Text, UiTheme.TEXT_SOFT);

            // The mouse pointer
            if (!_wheelByPad) { _ui.Circle(cx + _wheelPointer.X, cy + _wheelPointer.Y, S(4), UiTheme.TEXT, 12); }
        }

        private static readonly KeyHint HINT_WHEEL_MOUSE = new(() => "Move towards a gun and let go · let go in the middle to keep this one");
        private static readonly KeyHint HINT_WHEEL_PAD = new(() =>
            $"Point at a gun · {Hotkeys.Map.PadLabel(InputAction.PadClick)} or {Hotkeys.Map.PadLabel(InputAction.GunWheel)} picks · {Hotkeys.Map.PadLabel(InputAction.PadMenuBack)} closes");
    }
}
