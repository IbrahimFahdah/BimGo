using System.Diagnostics;
using System.Numerics;
using System.Runtime.InteropServices;
using BimGo.Native;
using BimGo.Scene;

// The class belongs to the Platform namespace
namespace BimGo.Platform
{
    /// <summary>What the gamepad does with the cursor when it is free (build B).</summary>
    internal enum PadCursorMode
    {
        /// <summary>Walking, a tour, a video, a key capture: no cursor, no clicks.</summary>
        Off,

        /// <summary>Menus, panels, the start screen: the look stick moves the cursor, A clicks, B goes back, the move stick scrolls.</summary>
        Menu,

        /// <summary>The free-cursor editors (photo, section box, study, sun panel): as Menu, but the move stick looks (the session reads it).</summary>
        Editor
    }

    /// <summary>
    /// The gamepad (input round B2, build B): an Xbox-style controller through XInput, a secondary input beside the
    /// keyboard and mouse (nothing changes when none is connected). The first connected controller is used; when none
    /// is, the slots are scanned every 2 s. Each frame <see cref="Poll"/> turns its state into gamepad codes on the
    /// <see cref="InputState"/> (the key map binds them like keys: analog sticks and triggers through
    /// <see cref="KeyMap.Axis"/>), and <see cref="DriveCursor"/> drives the cursor in menus and editors. Tuning (look
    /// speed, invert Y, dead zone, trigger threshold) is per machine.
    /// </summary>
    internal static class Gamepad
    {
        #region Tuning (settings.json)

        /// <summary>Look speed multiplier.</summary>
        public static float LookSensitivity { get; set; } = 1f;

        /// <summary>Invert the look stick's up / down.</summary>
        public static bool InvertY { get; set; }

        /// <summary>Stick dead zone (0–1 of full tilt).</summary>
        public static float DeadZone { get; set; } = LaunchSettings.DEFAULT_PAD_DEAD_ZONE;

        /// <summary>Trigger threshold (0–1 of the travel).</summary>
        public static float TriggerThreshold { get; set; } = LaunchSettings.DEFAULT_PAD_TRIGGER;

        /// <summary>Full-tilt look speed at sensitivity 1 (radians a second).</summary>
        public const float LOOK_RADIANS_PER_SECOND = 3f;

        /// <summary>Reads the tuning (the session start).</summary>
        public static void Read(LaunchSettings settings)
        {
            if (settings == null) { return; }
            LookSensitivity = settings.PadLookSensitivity;
            InvertY = settings.PadInvertY;
            DeadZone = settings.PadDeadZone;
            TriggerThreshold = settings.PadTriggerThreshold;
            var problems = new List<string>();
            GenericMap = GenericPadMap.FromSettings(settings.GenericPadMap, problems);
            foreach (string problem in problems) { Utilities.Log_Utils.Write($"Gamepad map: skipped {problem}."); }
        }

        /// <summary>Writes the tuning (saved by the caller).</summary>
        public static void Write(LaunchSettings settings)
        {
            if (settings == null) { return; }
            settings.PadLookSensitivity = LookSensitivity;
            settings.PadInvertY = InvertY;
            settings.PadDeadZone = DeadZone;
            settings.PadTriggerThreshold = TriggerThreshold;
            settings.GenericPadMap = GenericMap.ToSettings();
            if (_genericId >= 0 && !string.IsNullOrEmpty(_genericName)) { settings.GenericPadName = _genericName; }
        }

        #endregion

        #region State

        private static bool _available = true;
        private static int _index = -1;
        private static double _nextScan;
        private static double _last;
        private static float _dt;
        private static readonly Stopwatch CLOCK = Stopwatch.StartNew();
        private static readonly bool[] DOWN = new bool[KeyCodes.PAD_COUNT];
        private static readonly float[] ANALOG = new float[KeyCodes.PAD_COUNT];

        // Cursor driving
        private static bool _clickHeld;
        private static float _cursorCarryX, _cursorCarryY;
        private static float _scrollWait;

        // A generic controller (build B2-C: Windows' joystick API, for pads XInput doesn't see)
        private static int _genericId = -1;
        private static string _genericName = string.Empty;
        private static Joystick.JOYCAPSW _genericCaps;
        private static double _nextGenericScan;
        private static bool _winmmAvailable = true;
        private static readonly float[] GENERIC_ANALOG = new float[KeyCodes.PAD_COUNT];

        /// <summary>An XInput controller is in use (1–4), or 0.</summary>
        public static int ControllerNumber => _index + 1;

        /// <summary>True when a controller is in use (XInput, or a generic one).</summary>
        public static bool Connected => _index >= 0 || _genericId >= 0;

        /// <summary>True when the controller in use is a generic one (its buttons go through <see cref="GenericMap"/>).</summary>
        public static bool IsGeneric => _index < 0 && _genericId >= 0;

        /// <summary>The CONTROLS status ("controller 1", "Generic USB Joystick", "none connected").</summary>
        public static string Description => _index >= 0 ? "controller " + (_index + 1) : _genericId >= 0 ? _genericName : "none connected";

        /// <summary>How a generic controller's buttons, hat and axes become gamepad codes (CONTROLS → MAP BUTTONS).</summary>
        public static GenericPadMap GenericMap { get; set; } = GenericPadMap.XboxStyleGuess();

        /// <summary>While MAP BUTTONS runs: the generic controller's raw reading is kept, but nothing reaches the actions.</summary>
        public static bool Mapping { get; set; }

        /// <summary>The generic controller's last raw axes (X, Y, Z, R, U, V in −1–1).</summary>
        public static readonly float[] RawAxes = new float[GenericPadMap.AXES];

        /// <summary>The generic controller's last raw buttons (bit 0 = button 1).</summary>
        public static uint RawButtons { get; private set; }

        /// <summary>The generic controller's last hat angle (hundredths of a degree), or <see cref="GenericPadMap.POV_CENTRED"/>.</summary>
        public static int RawPov { get; private set; } = GenericPadMap.POV_CENTRED;

        #endregion

        #region Poll

        /// <summary>
        /// Reads the controller and hands its buttons, triggers and sticks to the input state (all released while the
        /// window isn't active). Never throws: without XInput the gamepad is simply off.
        /// </summary>
        public static void Poll(InputState input, bool active)
        {
            double now = CLOCK.Elapsed.TotalSeconds;
            _dt = (float)Math.Clamp(now - _last, 0.0, 0.1);
            _last = now;
            Array.Clear(DOWN);
            Array.Clear(ANALOG);
            Vector2 left = Vector2.Zero, right = Vector2.Zero;

            if (_available)
            {
                try
                {
                    if (_index < 0 && now >= _nextScan)
                    {
                        _nextScan = now + 2.0;
                        for (uint i = 0; i < XInput.MAX_CONTROLLERS; i++)
                        {
                            if (XInput.GetState(i, out _) == XInput.ERROR_SUCCESS)
                            {
                                _index = (int)i;
                                Utilities.Log_Utils.Write($"Gamepad: controller {i + 1} connected.");
                                break;
                            }
                        }
                    }
                    if (_index >= 0)
                    {
                        _genericId = -1; // an XInput controller wins over a generic one
                        if (XInput.GetState((uint)_index, out XInput.STATE state) != XInput.ERROR_SUCCESS)
                        {
                            Utilities.Log_Utils.Write($"Gamepad: controller {_index + 1} disconnected.");
                            _index = -1;
                            _nextScan = now + 1.0;
                        }
                        else if (active)
                        {
                            ReadPad(state.Gamepad, out left, out right);
                        }
                    }
                }
                catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
                {
                    _available = false;
                    _index = -1;
                    Utilities.Log_Utils.Write($"Gamepad: XInput isn't available ({ex.Message}); the gamepad is off.");
                }
            }

            // No XInput controller: a generic one through Windows' joystick API
            if (_index < 0) { PollGeneric(now, active, ref left, ref right); }

            if (Mapping)
            {
                Array.Clear(DOWN);
                Array.Clear(ANALOG);
                left = right = Vector2.Zero;
            }
            input.SetPad(Connected, DOWN, ANALOG, left, right, _dt);
        }

        /// <summary>
        /// A generic controller (build B2-C): found by scanning the joystick ids every 2 s; read with its axis ranges; its
        /// buttons, hat and axes go through <see cref="GenericMap"/> into the same gamepad codes, then the dead zone and
        /// trigger threshold as for XInput. Without a Start button, LB and RB held together are Start (the menu).
        /// </summary>
        private static void PollGeneric(double now, bool active, ref Vector2 left, ref Vector2 right)
        {
            if (!_winmmAvailable) { return; }
            try
            {
                if (_genericId < 0)
                {
                    if (now < _nextGenericScan) { return; }
                    _nextGenericScan = now + 2.0;
                    uint ids = Math.Min(Joystick.joyGetNumDevs(), 16u);
                    for (uint id = 0; id < ids; id++)
                    {
                        var probe = new Joystick.JOYINFOEX { dwSize = (uint)Marshal.SizeOf<Joystick.JOYINFOEX>(), dwFlags = Joystick.JOY_RETURNALL_CONTINUOUS_POV };
                        if (Joystick.joyGetPosEx(id, ref probe) != Joystick.JOYERR_NOERROR) { continue; }
                        var caps = new Joystick.JOYCAPSW();
                        if (Joystick.joyGetDevCaps(id, ref caps, (uint)Marshal.SizeOf<Joystick.JOYCAPSW>()) != Joystick.JOYERR_NOERROR) { continue; }
                        _genericId = (int)id;
                        _genericCaps = caps;
                        _genericName = string.IsNullOrWhiteSpace(caps.szPname) ? "Generic controller" : caps.szPname.Trim();
                        Utilities.Log_Utils.Write($"Gamepad: generic controller “{_genericName}” (joystick {id + 1}: {caps.wNumAxes} axes, {caps.wNumButtons} buttons{((caps.wCaps & Joystick.JOYCAPS_HASPOV) != 0 ? ", hat" : string.Empty)}).");
                        break;
                    }
                    if (_genericId < 0) { return; }
                }

                var info = new Joystick.JOYINFOEX { dwSize = (uint)Marshal.SizeOf<Joystick.JOYINFOEX>(), dwFlags = Joystick.JOY_RETURNALL_CONTINUOUS_POV };
                if (Joystick.joyGetPosEx((uint)_genericId, ref info) != Joystick.JOYERR_NOERROR)
                {
                    Utilities.Log_Utils.Write($"Gamepad: generic controller “{_genericName}” disconnected.");
                    _genericId = -1;
                    _nextGenericScan = now + 1.0;
                    Array.Clear(RawAxes);
                    RawButtons = 0;
                    RawPov = GenericPadMap.POV_CENTRED;
                    return;
                }

                Joystick.JOYCAPSW c = _genericCaps;
                RawAxes[0] = Normalise(info.dwXpos, c.wXmin, c.wXmax);
                RawAxes[1] = Normalise(info.dwYpos, c.wYmin, c.wYmax);
                RawAxes[2] = (c.wCaps & Joystick.JOYCAPS_HASZ) != 0 ? Normalise(info.dwZpos, c.wZmin, c.wZmax) : 0f;
                RawAxes[3] = (c.wCaps & Joystick.JOYCAPS_HASR) != 0 ? Normalise(info.dwRpos, c.wRmin, c.wRmax) : 0f;
                RawAxes[4] = (c.wCaps & Joystick.JOYCAPS_HASU) != 0 ? Normalise(info.dwUpos, c.wUmin, c.wUmax) : 0f;
                RawAxes[5] = (c.wCaps & Joystick.JOYCAPS_HASV) != 0 ? Normalise(info.dwVpos, c.wVmin, c.wVmax) : 0f;
                RawButtons = info.dwButtons;
                RawPov = (c.wCaps & Joystick.JOYCAPS_HASPOV) != 0 && info.dwPOV < 36000 ? (int)info.dwPOV : GenericPadMap.POV_CENTRED;
                if (!active) { return; }

                GenericMap.Evaluate(RawAxes, RawButtons, RawPov, GENERIC_ANALOG);
                for (int i = 0; i < KeyCodes.PAD_COUNT; i++)
                {
                    ushort code = (ushort)(KeyCodes.GAMEPAD_FIRST + i);
                    if (KeyCodes.IsPadStick(code)) { continue; }
                    float amount = GENERIC_ANALOG[i];
                    if (code == KeyCodes.PAD_LT || code == KeyCodes.PAD_RT)
                    {
                        float threshold = Math.Clamp(TriggerThreshold, 0.01f, 0.95f);
                        DOWN[i] = amount >= threshold;
                        ANALOG[i] = DOWN[i] ? Math.Clamp((amount - threshold) / (1f - threshold), 0f, 1f) : 0f;
                    }
                    else
                    {
                        DOWN[i] = amount >= 0.5f;
                        ANALOG[i] = DOWN[i] ? 1f : 0f;
                    }
                }

                // Sticks: the four directions back into a vector, then the same radial dead zone as XInput
                left = DeadZoned(StickFrom(KeyCodes.PAD_LS_UP));
                right = DeadZoned(StickFrom(KeyCodes.PAD_RS_UP));
                Directions(KeyCodes.PAD_LS_UP, left);
                Directions(KeyCodes.PAD_RS_UP, right);

                // No Start button: LB + RB together open the menu
                if (GenericMap.Get(KeyCodes.PAD_START).IsNone && DOWN[KeyCodes.PAD_LB - KeyCodes.GAMEPAD_FIRST] && DOWN[KeyCodes.PAD_RB - KeyCodes.GAMEPAD_FIRST])
                {
                    DOWN[KeyCodes.PAD_START - KeyCodes.GAMEPAD_FIRST] = true;
                    ANALOG[KeyCodes.PAD_START - KeyCodes.GAMEPAD_FIRST] = 1f;
                }
            }
            catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException or MarshalDirectiveException)
            {
                _winmmAvailable = false;
                _genericId = -1;
                Utilities.Log_Utils.Write($"Gamepad: Windows' joystick API isn't available ({ex.Message}); generic controllers are off.");
            }
        }

        /// <summary>A raw axis reading to −1–1 over the axis's reported range (0 when the range is empty).</summary>
        private static float Normalise(uint value, uint min, uint max) =>
            max <= min ? 0f : (float)Math.Clamp(((double)value - min) / ((double)max - min) * 2.0 - 1.0, -1.0, 1.0);

        /// <summary>A generic stick from its four mapped directions (x right, y up).</summary>
        private static Vector2 StickFrom(ushort up)
        {
            int i = up - KeyCodes.GAMEPAD_FIRST;
            return new Vector2(GENERIC_ANALOG[i + 3] - GENERIC_ANALOG[i + 2], GENERIC_ANALOG[i] - GENERIC_ANALOG[i + 1]);
        }

        /// <summary>Fills the gamepad codes from one XInput reading.</summary>
        private static void ReadPad(in XInput.GAMEPAD pad, out Vector2 left, out Vector2 right)
        {
            Button(KeyCodes.PAD_A, pad.wButtons, XInput.A);
            Button(KeyCodes.PAD_B, pad.wButtons, XInput.B);
            Button(KeyCodes.PAD_X, pad.wButtons, XInput.X);
            Button(KeyCodes.PAD_Y, pad.wButtons, XInput.Y);
            Button(KeyCodes.PAD_LB, pad.wButtons, XInput.LEFT_SHOULDER);
            Button(KeyCodes.PAD_RB, pad.wButtons, XInput.RIGHT_SHOULDER);
            Button(KeyCodes.PAD_BACK, pad.wButtons, XInput.BACK);
            Button(KeyCodes.PAD_START, pad.wButtons, XInput.START);
            Button(KeyCodes.PAD_LS, pad.wButtons, XInput.LEFT_THUMB);
            Button(KeyCodes.PAD_RS, pad.wButtons, XInput.RIGHT_THUMB);
            Button(KeyCodes.PAD_UP, pad.wButtons, XInput.DPAD_UP);
            Button(KeyCodes.PAD_DOWN, pad.wButtons, XInput.DPAD_DOWN);
            Button(KeyCodes.PAD_LEFT, pad.wButtons, XInput.DPAD_LEFT);
            Button(KeyCodes.PAD_RIGHT, pad.wButtons, XInput.DPAD_RIGHT);
            Trigger(KeyCodes.PAD_LT, pad.bLeftTrigger);
            Trigger(KeyCodes.PAD_RT, pad.bRightTrigger);

            left = Stick(pad.sThumbLX, pad.sThumbLY);
            right = Stick(pad.sThumbRX, pad.sThumbRY);
            Directions(KeyCodes.PAD_LS_UP, left);
            Directions(KeyCodes.PAD_RS_UP, right);
        }

        private static void Button(ushort code, ushort buttons, ushort bit)
        {
            bool down = (buttons & bit) != 0;
            DOWN[code - KeyCodes.GAMEPAD_FIRST] = down;
            ANALOG[code - KeyCodes.GAMEPAD_FIRST] = down ? 1f : 0f;
        }

        private static void Trigger(ushort code, byte value)
        {
            float t = value / 255f, threshold = Math.Clamp(TriggerThreshold, 0.01f, 0.95f);
            bool down = t >= threshold;
            DOWN[code - KeyCodes.GAMEPAD_FIRST] = down;
            ANALOG[code - KeyCodes.GAMEPAD_FIRST] = down ? Math.Clamp((t - threshold) / (1f - threshold), 0f, 1f) : 0f;
        }

        /// <summary>A stick after a radial dead zone, rescaled so the edge of the dead zone reads 0 (x right, y up).</summary>
        private static Vector2 Stick(short x, short y) =>
            DeadZoned(new Vector2(Math.Max(x, (short)-32767) / 32767f, Math.Max(y, (short)-32767) / 32767f));

        /// <summary>A radial dead zone, rescaled so its edge reads 0 (length ≤ 1).</summary>
        private static Vector2 DeadZoned(Vector2 v)
        {
            float length = v.Length();
            float dead = Math.Clamp(DeadZone, 0f, 0.9f);
            if (length <= dead) { return Vector2.Zero; }
            float scaled = Math.Clamp((Math.Min(length, 1f) - dead) / (1f - dead), 0f, 1f);
            return v * (scaled / length);
        }

        /// <summary>A stick's four directions (up, down, left, right from <paramref name="first"/>): analog amounts, down past half way.</summary>
        private static void Directions(ushort first, Vector2 stick)
        {
            int i = first - KeyCodes.GAMEPAD_FIRST;
            ANALOG[i] = Math.Max(stick.Y, 0f);
            ANALOG[i + 1] = Math.Max(-stick.Y, 0f);
            ANALOG[i + 2] = Math.Max(-stick.X, 0f);
            ANALOG[i + 3] = Math.Max(stick.X, 0f);
            for (int d = 0; d < 4; d++) { DOWN[i + d] = ANALOG[i + d] >= 0.5f; }
        }

        #endregion

        #region Sticks by role

        /// <summary>
        /// True when looking is on the right stick (the look actions' gamepad bindings decide; the default is the right).
        /// The menu cursor and the gun wheel follow the look stick; scrolling and editor look use the other one.
        /// </summary>
        public static bool LookOnRightStick
        {
            get
            {
                ushort key = Hotkeys.Map.PadChord(InputAction.LookRight).Key;
                return key >= KeyCodes.PAD_RS_UP && key <= KeyCodes.PAD_RS_RIGHT;
            }
        }

        /// <summary>The look stick (x right, y up).</summary>
        public static Vector2 LookStick(InputState input) => LookOnRightStick ? input.PadRightStick : input.PadLeftStick;

        /// <summary>The move stick (x right, y up).</summary>
        public static Vector2 MoveStick(InputState input) => LookOnRightStick ? input.PadLeftStick : input.PadRightStick;

        /// <summary>A stick with a squared response (fine control near the centre), same direction.</summary>
        public static Vector2 Curve(Vector2 stick) => stick * stick.Length();

        #endregion

        #region Cursor

        /// <summary>
        /// Menus and editors (the cursor is free): the look stick moves the cursor, A (<see cref="InputAction.PadClick"/>)
        /// is the left button, B (<see cref="InputAction.PadMenuBack"/>) is Esc, and in menus the move stick scrolls.
        /// Off: a held click is let go.
        /// </summary>
        public static void DriveCursor(GameWindow window, InputState input)
        {
            if (!Connected || window.PadCursor == PadCursorMode.Off || !window.IsActive || window.IsCaptured)
            {
                ReleaseClick(input);
                _scrollWait = 0f;
                return;
            }

            // Cursor: up to ~1200 px a second (DPI-scaled) at full tilt, squared response
            Vector2 move = Curve(LookStick(input)) * (1200f * window.DpiScale * _dt);
            if (move != Vector2.Zero)
            {
                _cursorCarryX += move.X;
                _cursorCarryY -= move.Y; // stick up = screen up
                int dx = (int)_cursorCarryX, dy = (int)_cursorCarryY;
                _cursorCarryX -= dx;
                _cursorCarryY -= dy;
                if ((dx != 0 || dy != 0) && Win32.GetCursorPos(out Win32.POINT point))
                {
                    var client = new Win32.POINT { X = point.X + dx, Y = point.Y + dy };
                    Win32.ScreenToClient(window.Handle, ref client);
                    client.X = Math.Clamp(client.X, 0, Math.Max(window.Width - 1, 0));
                    client.Y = Math.Clamp(client.Y, 0, Math.Max(window.Height - 1, 0));
                    input.OnMouseMove(client.X, client.Y);
                    Win32.ClientToScreen(window.Handle, ref client);
                    Win32.SetCursorPos(client.X, client.Y);
                }
            }

            // A clicks (held: drags), B goes back
            bool click = Hotkeys.Map.Down(InputAction.PadClick, input);
            if (click && !_clickHeld)
            {
                _clickHeld = true;
                input.InjectLeft(true);
            }
            else if (!click) { ReleaseClick(input); }
            if (Hotkeys.Map.Pressed(InputAction.PadMenuBack, input)) { input.InjectEscape(); }

            // Menus: the move stick scrolls (a notch at a rate that grows with the tilt)
            float scroll = window.PadCursor == PadCursorMode.Menu ? MoveStick(input).Y : 0f;
            if (MathF.Abs(scroll) >= 0.5f)
            {
                _scrollWait -= _dt;
                if (_scrollWait <= 0f)
                {
                    input.OnWheel(scroll > 0f ? 120 : -120);
                    _scrollWait = 0.18f / MathF.Abs(scroll);
                }
            }
            else { _scrollWait = 0f; }
        }

        private static void ReleaseClick(InputState input)
        {
            if (!_clickHeld) { return; }
            _clickHeld = false;
            input.InjectLeft(false);
        }

        #endregion
    }
}
