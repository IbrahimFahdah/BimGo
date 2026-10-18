using System.Numerics;
using BimGo.Scene;

// The class belongs to the Platform namespace
namespace BimGo.Platform
{
    /// <summary>
    /// Keyboard / mouse state gathered from window messages for one frame.
    /// "Pressed" flags are edges (first press only, auto-repeat ignored) and are cleared by <see cref="EndFrame"/>.
    /// <para>
    /// Input round B2: game code asks for <b>actions</b> (<see cref="Pressed(InputAction)"/>, <see cref="Down(InputAction)"/>),
    /// which the key map (<see cref="Hotkeys.Map"/>) resolves to keys; raw keys (<see cref="IsPressed(int)"/>) are left
    /// for text boxes. Mouse buttons live in the key arrays under their virtual-key codes (LMB 1, RMB 2, MMB 4,
    /// Mouse 4 / 5 = 5 / 6), so they bind like keys; the wheel reads as two codes of its own.
    /// </para>
    /// </summary>
    internal sealed class InputState : IKeyState
    {
        private readonly bool[] _down = new bool[256];
        private readonly bool[] _pressed = new bool[256];
        private readonly bool[] _repeated = new bool[256];
        private readonly char[] _chars = new char[64];
        private bool _leftReleased;

        // Gamepad (build B): digital state, edges, auto-repeat and analog amount per gamepad code (Gamepad.Poll fills them)
        private readonly bool[] _padDown = new bool[KeyCodes.PAD_COUNT];
        private readonly bool[] _padPressed = new bool[KeyCodes.PAD_COUNT];
        private readonly bool[] _padRepeated = new bool[KeyCodes.PAD_COUNT];
        private readonly float[] _padAnalog = new float[KeyCodes.PAD_COUNT];
        private readonly float[] _padRepeatAt = new float[KeyCodes.PAD_COUNT];
        private readonly float[] _padHeld = new float[KeyCodes.PAD_COUNT];

        /// <summary>Gamepad held this long starts auto-repeating (stepping keys: sun time, snapped moves).</summary>
        private const float PAD_REPEAT_DELAY = 0.4f;

        /// <summary>Gamepad auto-repeat interval.</summary>
        private const float PAD_REPEAT_INTERVAL = 0.1f;

        /// <summary>Raw mouse delta X (counts) this frame.</summary>
        public float MouseDeltaX { get; private set; }

        /// <summary>Raw mouse delta Y (counts) this frame.</summary>
        public float MouseDeltaY { get; private set; }

        /// <summary>Wheel notches this frame (positive = away from user).</summary>
        public int Wheel { get; private set; }

        /// <summary>Cursor position in client pixels.</summary>
        public Vector2 MousePosition { get; private set; }

        /// <summary>Left button held.</summary>
        public bool LeftDown => _down[KeyCodes.LEFT_MOUSE];

        /// <summary>Right button held.</summary>
        public bool RightDown => _down[KeyCodes.RIGHT_MOUSE];

        /// <summary>Left button pressed this frame.</summary>
        public bool LeftPressed => _pressed[KeyCodes.LEFT_MOUSE];

        /// <summary>Right button pressed this frame.</summary>
        public bool RightPressed => _pressed[KeyCodes.RIGHT_MOUSE];

        /// <summary>Left button released this frame.</summary>
        public bool LeftReleased => _leftReleased;

        /// <summary>Number of typed characters this frame.</summary>
        public int CharCount { get; private set; }

        /// <summary>Typed characters this frame.</summary>
        public ReadOnlySpan<char> Chars => _chars.AsSpan(0, CharCount);

        /// <summary>A gamepad is connected (build B).</summary>
        public bool PadConnected { get; private set; }

        /// <summary>The gamepad's left stick after the dead zone (x right, y up; length 0–1).</summary>
        public Vector2 PadLeftStick { get; private set; }

        /// <summary>The gamepad's right stick after the dead zone (x right, y up; length 0–1).</summary>
        public Vector2 PadRightStick { get; private set; }

        /// <summary>The last thing used was the gamepad (hints show gamepad buttons then).</summary>
        public bool LastInputWasPad { get; private set; }

        /// <summary>Key held (raw virtual-key code: text boxes and the key capture only).</summary>
        public bool IsDown(int vk) => vk is >= 0 and < 256 && _down[vk];

        /// <summary>Key pressed this frame, no auto-repeat (raw virtual-key code: text boxes and the key capture only).</summary>
        public bool IsPressed(int vk) => vk is >= 0 and < 256 && _pressed[vk];

        /// <summary>Key pressed or auto-repeated this frame (raw virtual-key code: text editing).</summary>
        public bool IsPressedOrRepeated(int vk) => vk is >= 0 and < 256 && (_pressed[vk] || _repeated[vk]);

        #region Actions (input round B2)

        /// <summary>The action fired this frame (one of its keys went down; see <see cref="KeyMap"/> for modifiers).</summary>
        public bool Pressed(InputAction action) => Hotkeys.Map.Pressed(action, this);

        /// <summary>The action fired this frame or its key auto-repeated (stepping keys).</summary>
        public bool PressedOrRepeated(InputAction action) => Hotkeys.Map.PressedOrRepeated(action, this);

        /// <summary>One of the action's keys is held (with its modifiers).</summary>
        public bool Down(InputAction action) => Hotkeys.Map.Down(action, this);

        /// <summary>How far the action is held, 0–1 (gamepad sticks and triggers in between; keys 0 or 1).</summary>
        public float Axis(InputAction action) => Hotkeys.Map.Axis(action, this);

        /// <summary>The action fired this frame from its gamepad binding (build B).</summary>
        public bool PressedByPad(InputAction action) => Hotkeys.Map.PressedSlot(action, this) == KeyMap.PAD_SLOT;

        bool IKeyState.IsKeyDown(ushort code) =>
            code < 256 ? _down[code] : KeyCodes.IsPad(code) ? _padDown[code - KeyCodes.GAMEPAD_FIRST] : code == KeyCodes.WHEEL_UP ? Wheel > 0 : code == KeyCodes.WHEEL_DOWN && Wheel < 0;

        bool IKeyState.IsKeyPressed(ushort code) =>
            code < 256 ? _pressed[code] : KeyCodes.IsPad(code) ? _padPressed[code - KeyCodes.GAMEPAD_FIRST] : code == KeyCodes.WHEEL_UP ? Wheel > 0 : code == KeyCodes.WHEEL_DOWN && Wheel < 0;

        bool IKeyState.IsKeyRepeated(ushort code) =>
            code < 256 ? _repeated[code] : KeyCodes.IsPad(code) && _padRepeated[code - KeyCodes.GAMEPAD_FIRST];

        float IKeyState.KeyAnalog(ushort code) =>
            code < 256 ? (_down[code] ? 1f : 0f) : KeyCodes.IsPad(code) ? _padAnalog[code - KeyCodes.GAMEPAD_FIRST] : ((IKeyState)this).IsKeyPressed(code) ? 1f : 0f;

        #endregion

        #region Message handlers (window thread = game thread)

        public void OnKey(int vk, bool down, bool wasDown)
        {
            if (vk is < 0 or >= 256) { return; }
            if (down) { LastInputWasPad = false; }
            if (down)
            {
                if (!wasDown) { _pressed[vk] = true; }
                else { _repeated[vk] = true; }
            }
            _down[vk] = down;
        }

        public void OnChar(char c)
        {
            if (CharCount < _chars.Length) { _chars[CharCount++] = c; }
        }

        public void OnRawMouse(int dx, int dy)
        {
            if (Math.Abs(dx) + Math.Abs(dy) > 2) { LastInputWasPad = false; }
            MouseDeltaX += dx;
            MouseDeltaY += dy;
        }

        public void OnMouseMove(int x, int y) => MousePosition = new Vector2(x, y);

        public void OnWheel(int delta) => Wheel += delta / 120;

        public void OnLeft(bool down)
        {
            if (!down && _down[KeyCodes.LEFT_MOUSE]) { _leftReleased = true; }
            OnButton(KeyCodes.LEFT_MOUSE, down);
        }

        public void OnRight(bool down) => OnButton(KeyCodes.RIGHT_MOUSE, down);

        /// <summary>
        /// A mouse button (LMB, RMB, MMB, Mouse 4, Mouse 5 by virtual-key code) went down or up.
        /// </summary>
        public void OnButton(ushort code, bool down)
        {
            if (code >= 256) { return; }
            if (down && !_injectingClick) { LastInputWasPad = false; }
            if (down && !_down[code]) { _pressed[code] = true; }
            _down[code] = down;
        }

        #endregion

        #region Gamepad (build B)

        private bool _injectingClick;

        /// <summary>
        /// This frame's gamepad (from <see cref="Gamepad.Poll"/>): per gamepad code whether it is down and how far
        /// (0–1), and the dead-zoned sticks. Works out the edges and the auto-repeat.
        /// </summary>
        public void SetPad(bool connected, bool[] down, float[] analog, Vector2 left, Vector2 right, float dt)
        {
            PadConnected = connected;
            PadLeftStick = left;
            PadRightStick = right;
            bool any = false;
            for (int i = 0; i < KeyCodes.PAD_COUNT; i++)
            {
                bool now = down[i];
                _padAnalog[i] = analog[i];
                if (now && !_padDown[i])
                {
                    _padPressed[i] = true;
                    _padHeld[i] = 0f;
                    _padRepeatAt[i] = PAD_REPEAT_DELAY;
                    any = true;
                }
                else if (now)
                {
                    _padHeld[i] += dt;
                    if (_padHeld[i] >= _padRepeatAt[i])
                    {
                        _padRepeated[i] = true;
                        _padRepeatAt[i] += PAD_REPEAT_INTERVAL;
                    }
                }
                _padDown[i] = now;
            }
            if (any || left.LengthSquared() > 0.25f || right.LengthSquared() > 0.25f) { LastInputWasPad = true; }
        }

        /// <summary>A gamepad code is held (polish round P-A2: menu navigation reads the D-pad and shoulders raw).</summary>
        public bool PadDown(ushort code) => KeyCodes.IsPad(code) && _padDown[code - KeyCodes.GAMEPAD_FIRST];

        /// <summary>A gamepad code went down this frame or auto-repeated.</summary>
        public bool PadPressedOrRepeated(ushort code) =>
            KeyCodes.IsPad(code) && (_padPressed[code - KeyCodes.GAMEPAD_FIRST] || _padRepeated[code - KeyCodes.GAMEPAD_FIRST]);

        /// <summary>Any gamepad code other than these two went down this frame (a shoulder used as a chord modifier).</summary>
        public bool AnyPadPressedExcept(ushort a, ushort b)
        {
            for (int i = 0; i < KeyCodes.PAD_COUNT; i++)
            {
                if (!_padPressed[i]) { continue; }
                int code = i + KeyCodes.GAMEPAD_FIRST;
                if (code != a && code != b) { return true; }
            }
            return false;
        }

        /// <summary>
        /// Consumes a gamepad code's press and repeat this frame (menu navigation took the D-pad, so the actions
        /// bound to it don't also fire). Held state is kept.
        /// </summary>
        public void ConsumePad(ushort code)
        {
            if (!KeyCodes.IsPad(code)) { return; }
            _padPressed[code - KeyCodes.GAMEPAD_FIRST] = false;
            _padRepeated[code - KeyCodes.GAMEPAD_FIRST] = false;
        }

        /// <summary>The gamepad's click (A in menus) as the left button, without counting as mouse use.</summary>
        public void InjectLeft(bool down)
        {
            _injectingClick = true;
            OnLeft(down);
            _injectingClick = false;
        }

        /// <summary>The gamepad's back (B in menus): an Esc press and the Esc character text boxes read.</summary>
        public void InjectEscape()
        {
            _pressed[KeyCodes.ESCAPE] = true;
            OnChar((char)27);
        }

        #endregion

        /// <summary>
        /// Clears per-frame edges and deltas.
        /// </summary>
        public void EndFrame()
        {
            Array.Clear(_pressed);
            Array.Clear(_repeated);
            Array.Clear(_padPressed);
            Array.Clear(_padRepeated);
            MouseDeltaX = MouseDeltaY = 0f;
            Wheel = 0;
            _leftReleased = false;
            CharCount = 0;
        }

        /// <summary>
        /// Releases everything (focus lost).
        /// </summary>
        public void ReleaseAll()
        {
            Array.Clear(_down); // (the gamepad is polled, not sent: its held state stays, or pausing with Start would repeat)
            EndFrame();
        }

        /// <summary>
        /// Consumes everything this frame's keys, buttons, wheel and typing did (after the CONTROLS key capture took
        /// one, so the panel doesn't also react to it). Held state is kept.
        /// </summary>
        public void ConsumeFrame()
        {
            Array.Clear(_pressed);
            Array.Clear(_repeated);
            Array.Clear(_padPressed);
            Array.Clear(_padRepeated);
            Wheel = 0;
            _leftReleased = false;
            CharCount = 0;
        }

        /// <summary>
        /// Consumes the wheel so nothing else scrolls this frame (an open dropdown took it).
        /// </summary>
        public void ConsumeWheel() => Wheel = 0;

        /// <summary>
        /// Consumes the mouse clicks so nothing else reacts to them this frame.
        /// </summary>
        public void ConsumeClicks()
        {
            _pressed[KeyCodes.LEFT_MOUSE] = _pressed[KeyCodes.RIGHT_MOUSE] = _pressed[KeyCodes.MIDDLE_MOUSE] = false;
            _pressed[KeyCodes.MOUSE4] = _pressed[KeyCodes.MOUSE5] = false;
            _leftReleased = false;
        }
    }
}
