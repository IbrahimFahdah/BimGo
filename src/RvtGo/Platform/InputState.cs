using System.Numerics;

// The class belongs to the Platform namespace
namespace RvtGo.Platform
{
    /// <summary>
    /// Keyboard / mouse state gathered from window messages for one frame.
    /// "Pressed" flags are edges (first press only, auto-repeat ignored) and are cleared by <see cref="EndFrame"/>.
    /// </summary>
    internal sealed class InputState
    {
        private readonly bool[] _down = new bool[256];
        private readonly bool[] _pressed = new bool[256];
        private readonly bool[] _repeated = new bool[256];
        private readonly char[] _chars = new char[64];

        /// <summary>Raw mouse delta X (counts) this frame.</summary>
        public float MouseDeltaX { get; private set; }

        /// <summary>Raw mouse delta Y (counts) this frame.</summary>
        public float MouseDeltaY { get; private set; }

        /// <summary>Wheel notches this frame (positive = away from user).</summary>
        public int Wheel { get; private set; }

        /// <summary>Cursor position in client pixels.</summary>
        public Vector2 MousePosition { get; private set; }

        /// <summary>Left button held.</summary>
        public bool LeftDown { get; private set; }

        /// <summary>Right button held.</summary>
        public bool RightDown { get; private set; }

        /// <summary>Left button pressed this frame.</summary>
        public bool LeftPressed { get; private set; }

        /// <summary>Right button pressed this frame.</summary>
        public bool RightPressed { get; private set; }

        /// <summary>Left button released this frame.</summary>
        public bool LeftReleased { get; private set; }

        /// <summary>Number of typed characters this frame.</summary>
        public int CharCount { get; private set; }

        /// <summary>Typed characters this frame.</summary>
        public ReadOnlySpan<char> Chars => _chars.AsSpan(0, CharCount);

        /// <summary>Key held.</summary>
        public bool IsDown(int vk) => vk is >= 0 and < 256 && _down[vk];

        /// <summary>Key pressed this frame (no auto-repeat).</summary>
        public bool IsPressed(int vk) => vk is >= 0 and < 256 && _pressed[vk];

        /// <summary>Key pressed or auto-repeated this frame (text editing).</summary>
        public bool IsPressedOrRepeated(int vk) => vk is >= 0 and < 256 && (_pressed[vk] || _repeated[vk]);

        #region Message handlers (window thread = game thread)

        public void OnKey(int vk, bool down, bool wasDown)
        {
            if (vk is < 0 or >= 256) { return; }
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
            MouseDeltaX += dx;
            MouseDeltaY += dy;
        }

        public void OnMouseMove(int x, int y) => MousePosition = new Vector2(x, y);

        public void OnWheel(int delta) => Wheel += delta / 120;

        public void OnLeft(bool down)
        {
            if (down && !LeftDown) { LeftPressed = true; }
            if (!down && LeftDown) { LeftReleased = true; }
            LeftDown = down;
        }

        public void OnRight(bool down)
        {
            if (down && !RightDown) { RightPressed = true; }
            RightDown = down;
        }

        #endregion

        /// <summary>
        /// Clears per-frame edges and deltas.
        /// </summary>
        public void EndFrame()
        {
            Array.Clear(_pressed);
            Array.Clear(_repeated);
            MouseDeltaX = MouseDeltaY = 0f;
            Wheel = 0;
            LeftPressed = RightPressed = LeftReleased = false;
            CharCount = 0;
        }

        /// <summary>
        /// Releases everything (focus lost).
        /// </summary>
        public void ReleaseAll()
        {
            Array.Clear(_down);
            LeftDown = RightDown = false;
            EndFrame();
        }

        /// <summary>
        /// Consumes the mouse clicks so nothing else reacts to them this frame.
        /// </summary>
        public void ConsumeClicks()
        {
            LeftPressed = RightPressed = LeftReleased = false;
        }
    }
}
