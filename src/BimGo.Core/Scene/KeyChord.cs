using System.Globalization;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Modifier keys a binding needs held (input round B2). Shift, Ctrl and Alt only: the Windows keys are reserved.
    /// </summary>
    [Flags]
    public enum KeyModifiers : byte
    {
        /// <summary>No modifier.</summary>
        None = 0,

        /// <summary>Shift held.</summary>
        Shift = 1,

        /// <summary>Ctrl held.</summary>
        Ctrl = 2,

        /// <summary>Alt held.</summary>
        Alt = 4,

        /// <summary>Gamepad left shoulder held (build B: LB + D-pad and other gamepad combinations).</summary>
        PadLB = 8,

        /// <summary>Gamepad right shoulder held.</summary>
        PadRB = 16
    }

    /// <summary>
    /// Input codes a binding can use (input round B2). Keyboard keys and mouse buttons are Windows virtual-key codes
    /// (VK_*, 1–255, so the mouse buttons share the keyboard's state arrays); the wheel has two codes of its own above
    /// 255. Gamepad codes (build B) start at <see cref="GAMEPAD_FIRST"/>.
    /// </summary>
    public static class KeyCodes
    {
        public const ushort NONE = 0;
        public const ushort LEFT_MOUSE = 0x01, RIGHT_MOUSE = 0x02, MIDDLE_MOUSE = 0x04, MOUSE4 = 0x05, MOUSE5 = 0x06;
        public const ushort BACKSPACE = 0x08, TAB = 0x09, ENTER = 0x0D, SHIFT = 0x10, CTRL = 0x11, ALT = 0x12;
        public const ushort PAUSE = 0x13, CAPS_LOCK = 0x14, ESCAPE = 0x1B, SPACE = 0x20;
        public const ushort PAGE_UP = 0x21, PAGE_DOWN = 0x22, END = 0x23, HOME = 0x24;
        public const ushort LEFT = 0x25, UP = 0x26, RIGHT = 0x27, DOWN = 0x28;
        public const ushort PRINT_SCREEN = 0x2C, INSERT = 0x2D, DELETE = 0x2E;
        public const ushort D0 = 0x30, A = 0x41;
        public const ushort LEFT_WIN = 0x5B, RIGHT_WIN = 0x5C, APPS = 0x5D;
        public const ushort NUM0 = 0x60, NUM_MULTIPLY = 0x6A, NUM_ADD = 0x6B, NUM_SUBTRACT = 0x6D, NUM_DECIMAL = 0x6E, NUM_DIVIDE = 0x6F;
        public const ushort F1 = 0x70, F4 = 0x73, F24 = 0x87;
        public const ushort NUM_LOCK = 0x90, SCROLL_LOCK = 0x91;

        /// <summary>The punctuation keys (US layout glyphs): ; = , - . / ` [ \ ] ' and the extra key left of Z.</summary>
        public const ushort OEM_1 = 0xBA, OEM_PLUS = 0xBB, OEM_COMMA = 0xBC, OEM_MINUS = 0xBD, OEM_PERIOD = 0xBE, OEM_2 = 0xBF;
        public const ushort OEM_3 = 0xC0, OEM_4 = 0xDB, OEM_5 = 0xDC, OEM_6 = 0xDD, OEM_7 = 0xDE, OEM_102 = 0xE2;

        /// <summary>Mouse wheel notches (one press per frame with a notch).</summary>
        public const ushort WHEEL_UP = 0x100, WHEEL_DOWN = 0x101;

        /// <summary>First gamepad code (build B).</summary>
        public const ushort GAMEPAD_FIRST = 0x200;

        /// <summary>
        /// Gamepad codes (Xbox-style; build B): the face buttons, shoulders, Back / Start, stick clicks, the D-pad, the
        /// triggers and each stick's four directions (analog, "pressed" past half way).
        /// </summary>
        public const ushort PAD_A = 0x200, PAD_B = 0x201, PAD_X = 0x202, PAD_Y = 0x203, PAD_LB = 0x204, PAD_RB = 0x205;
        public const ushort PAD_BACK = 0x206, PAD_START = 0x207, PAD_LS = 0x208, PAD_RS = 0x209;
        public const ushort PAD_UP = 0x20A, PAD_DOWN = 0x20B, PAD_LEFT = 0x20C, PAD_RIGHT = 0x20D, PAD_LT = 0x20E, PAD_RT = 0x20F;
        public const ushort PAD_LS_UP = 0x210, PAD_LS_DOWN = 0x211, PAD_LS_LEFT = 0x212, PAD_LS_RIGHT = 0x213;
        public const ushort PAD_RS_UP = 0x214, PAD_RS_DOWN = 0x215, PAD_RS_LEFT = 0x216, PAD_RS_RIGHT = 0x217;

        /// <summary>Number of gamepad codes (from <see cref="GAMEPAD_FIRST"/>).</summary>
        public const int PAD_COUNT = 24;

        /// <summary>True for gamepad codes.</summary>
        public static bool IsPad(ushort code) => code >= GAMEPAD_FIRST && code < GAMEPAD_FIRST + PAD_COUNT;

        /// <summary>True for a stick direction (analog).</summary>
        public static bool IsPadStick(ushort code) => code >= PAD_LS_UP && code <= PAD_RS_RIGHT;

        /// <summary>The keyboard modifiers.</summary>
        public const KeyModifiers KEYBOARD_MODIFIERS = KeyModifiers.Shift | KeyModifiers.Ctrl | KeyModifiers.Alt;

        /// <summary>The gamepad modifiers (the shoulders).</summary>
        public const KeyModifiers PAD_MODIFIERS = KeyModifiers.PadLB | KeyModifiers.PadRB;

        /// <summary>The digit key '0'–'9' (n = 0–9).</summary>
        public static ushort Digit(int n) => (ushort)(D0 + n);

        /// <summary>The letter key 'A'–'Z'.</summary>
        public static ushort Letter(char c) => (ushort)char.ToUpperInvariant(c);

        /// <summary>True for Shift, Ctrl and Alt (which are also usable as keys on their own: Run, Crouch).</summary>
        public static bool IsModifier(ushort code) => code is SHIFT or CTRL or ALT or PAD_LB or PAD_RB;

        /// <summary>True for mouse buttons and the wheel.</summary>
        public static bool IsMouse(ushort code) => code is LEFT_MOUSE or RIGHT_MOUSE or MIDDLE_MOUSE or MOUSE4 or MOUSE5 or WHEEL_UP or WHEEL_DOWN;

        /// <summary>The modifier flag a modifier key stands for (None for other keys).</summary>
        public static KeyModifiers ModifierOf(ushort code) => code switch
        {
            SHIFT => KeyModifiers.Shift,
            CTRL => KeyModifiers.Ctrl,
            ALT => KeyModifiers.Alt,
            PAD_LB => KeyModifiers.PadLB,
            PAD_RB => KeyModifiers.PadRB,
            _ => KeyModifiers.None
        };

        /// <summary>
        /// Keys that can never be bound: Esc (back / cancel everywhere, and how a key capture is cancelled), the
        /// Windows keys, Print Screen (Windows takes it) and the lock keys (they toggle keyboard state).
        /// </summary>
        public static bool IsReserved(ushort code) => code is ESCAPE or LEFT_WIN or RIGHT_WIN or PRINT_SCREEN or CAPS_LOCK or NUM_LOCK or SCROLL_LOCK;

        #region Names

        // Storage names (settings.json, keymap files): stable, ASCII, parsed case-insensitively
        private static readonly Dictionary<ushort, string> STORAGE = BuildStorageNames();
        private static readonly Dictionary<string, ushort> PARSE = BuildParseTable();

        // Display names (UI, help, README): short, may use arrows
        private static readonly Dictionary<ushort, string> DISPLAY = new()
        {
            [BACKSPACE] = "Backspace", [TAB] = "Tab", [ENTER] = "Enter", [SHIFT] = "Shift", [CTRL] = "Ctrl", [ALT] = "Alt",
            [PAUSE] = "Pause", [CAPS_LOCK] = "Caps Lock", [ESCAPE] = "Esc", [SPACE] = "Space",
            [PAGE_UP] = "PgUp", [PAGE_DOWN] = "PgDn", [END] = "End", [HOME] = "Home",
            [LEFT] = "←", [UP] = "↑", [RIGHT] = "→", [DOWN] = "↓",
            [PRINT_SCREEN] = "PrtSc", [INSERT] = "Ins", [DELETE] = "Del",
            [LEFT_WIN] = "Win", [RIGHT_WIN] = "Win", [APPS] = "Menu",
            [NUM_MULTIPLY] = "Num *", [NUM_ADD] = "Num +", [NUM_SUBTRACT] = "Num -", [NUM_DECIMAL] = "Num .", [NUM_DIVIDE] = "Num /",
            [NUM_LOCK] = "Num Lock", [SCROLL_LOCK] = "Scroll Lock",
            [OEM_1] = ";", [OEM_PLUS] = "=", [OEM_COMMA] = ",", [OEM_MINUS] = "-", [OEM_PERIOD] = ".", [OEM_2] = "/",
            [OEM_3] = "`", [OEM_4] = "[", [OEM_5] = "\\", [OEM_6] = "]", [OEM_7] = "'", [OEM_102] = "\\ (102)",
            [LEFT_MOUSE] = "LMB", [RIGHT_MOUSE] = "RMB", [MIDDLE_MOUSE] = "MMB", [MOUSE4] = "Mouse 4", [MOUSE5] = "Mouse 5",
            [WHEEL_UP] = "Wheel up", [WHEEL_DOWN] = "Wheel down",
            [PAD_A] = "A", [PAD_B] = "B", [PAD_X] = "X", [PAD_Y] = "Y", [PAD_LB] = "LB", [PAD_RB] = "RB",
            [PAD_BACK] = "Back", [PAD_START] = "Start", [PAD_LS] = "LS click", [PAD_RS] = "RS click",
            [PAD_UP] = "D-pad ↑", [PAD_DOWN] = "D-pad ↓", [PAD_LEFT] = "D-pad ←", [PAD_RIGHT] = "D-pad →", [PAD_LT] = "LT", [PAD_RT] = "RT",
            [PAD_LS_UP] = "LS ↑", [PAD_LS_DOWN] = "LS ↓", [PAD_LS_LEFT] = "LS ←", [PAD_LS_RIGHT] = "LS →",
            [PAD_RS_UP] = "RS ↑", [PAD_RS_DOWN] = "RS ↓", [PAD_RS_LEFT] = "RS ←", [PAD_RS_RIGHT] = "RS →"
        };

        private static Dictionary<ushort, string> BuildStorageNames()
        {
            var names = new Dictionary<ushort, string>
            {
                [BACKSPACE] = "Backspace", [TAB] = "Tab", [ENTER] = "Enter", [SHIFT] = "Shift", [CTRL] = "Ctrl", [ALT] = "Alt",
                [PAUSE] = "Pause", [CAPS_LOCK] = "CapsLock", [ESCAPE] = "Esc", [SPACE] = "Space",
                [PAGE_UP] = "PageUp", [PAGE_DOWN] = "PageDown", [END] = "End", [HOME] = "Home",
                [LEFT] = "Left", [UP] = "Up", [RIGHT] = "Right", [DOWN] = "Down",
                [PRINT_SCREEN] = "PrintScreen", [INSERT] = "Insert", [DELETE] = "Delete",
                [LEFT_WIN] = "LeftWin", [RIGHT_WIN] = "RightWin", [APPS] = "Apps",
                [NUM_MULTIPLY] = "NumMultiply", [NUM_ADD] = "NumAdd", [NUM_SUBTRACT] = "NumSubtract", [NUM_DECIMAL] = "NumDecimal", [NUM_DIVIDE] = "NumDivide",
                [NUM_LOCK] = "NumLock", [SCROLL_LOCK] = "ScrollLock",
                [OEM_1] = ";", [OEM_PLUS] = "=", [OEM_COMMA] = ",", [OEM_MINUS] = "-", [OEM_PERIOD] = ".", [OEM_2] = "/",
                [OEM_3] = "`", [OEM_4] = "[", [OEM_5] = "\\", [OEM_6] = "]", [OEM_7] = "'", [OEM_102] = "Oem102",
                [LEFT_MOUSE] = "LMB", [RIGHT_MOUSE] = "RMB", [MIDDLE_MOUSE] = "MMB", [MOUSE4] = "Mouse4", [MOUSE5] = "Mouse5",
                [WHEEL_UP] = "WheelUp", [WHEEL_DOWN] = "WheelDown",
                [PAD_A] = "PadA", [PAD_B] = "PadB", [PAD_X] = "PadX", [PAD_Y] = "PadY", [PAD_LB] = "PadLB", [PAD_RB] = "PadRB",
                [PAD_BACK] = "PadBack", [PAD_START] = "PadStart", [PAD_LS] = "PadLS", [PAD_RS] = "PadRS",
                [PAD_UP] = "PadUp", [PAD_DOWN] = "PadDown", [PAD_LEFT] = "PadLeft", [PAD_RIGHT] = "PadRight", [PAD_LT] = "PadLT", [PAD_RT] = "PadRT",
                [PAD_LS_UP] = "PadLSUp", [PAD_LS_DOWN] = "PadLSDown", [PAD_LS_LEFT] = "PadLSLeft", [PAD_LS_RIGHT] = "PadLSRight",
                [PAD_RS_UP] = "PadRSUp", [PAD_RS_DOWN] = "PadRSDown", [PAD_RS_LEFT] = "PadRSLeft", [PAD_RS_RIGHT] = "PadRSRight"
            };
            for (int i = 0; i < 10; i++)
            {
                names[Digit(i)] = i.ToString(CultureInfo.InvariantCulture);
                names[(ushort)(NUM0 + i)] = "Num" + i.ToString(CultureInfo.InvariantCulture);
            }
            for (char c = 'A'; c <= 'Z'; c++) { names[c] = c.ToString(); }
            for (int i = 0; i < 24; i++) { names[(ushort)(F1 + i)] = "F" + (i + 1).ToString(CultureInfo.InvariantCulture); }
            return names;
        }

        private static Dictionary<string, ushort> BuildParseTable()
        {
            var table = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<ushort, string> pair in STORAGE) { table[pair.Value] = pair.Key; }

            // Friendly spellings people type in hand-edited files
            table["Escape"] = ESCAPE;
            table["Return"] = ENTER;
            table["Control"] = CTRL;
            table["PgUp"] = PAGE_UP;
            table["PgDn"] = PAGE_DOWN;
            table["Ins"] = INSERT;
            table["Del"] = DELETE;
            table["Mouse1"] = LEFT_MOUSE;
            table["Mouse2"] = RIGHT_MOUSE;
            table["Mouse3"] = MIDDLE_MOUSE;
            table["XButton1"] = MOUSE4;
            table["XButton2"] = MOUSE5;
            return table;
        }

        /// <summary>The stable name a code is stored under ("Ctrl", "PageUp", "[", "Mouse4", "Key0xE5" if unnamed).</summary>
        public static string StorageName(ushort code) =>
            STORAGE.TryGetValue(code, out string name) ? name : "Key0x" + code.ToString("X2", CultureInfo.InvariantCulture);

        /// <summary>The short name shown in the UI ("PgUp", "↑", "Wheel up", "Mouse 4"; letters and digits as themselves).</summary>
        public static string DisplayName(ushort code)
        {
            if (DISPLAY.TryGetValue(code, out string name)) { return name; }
            if (code >= NUM0 && code <= NUM0 + 9) { return "Num " + (code - NUM0).ToString(CultureInfo.InvariantCulture); }
            return StorageName(code);
        }

        /// <summary>Reads a stored key name (case-insensitive; "Key0xNN" for unnamed codes).</summary>
        public static bool TryParse(string text, out ushort code)
        {
            code = NONE;
            if (string.IsNullOrWhiteSpace(text)) { return false; }
            text = text.Trim();
            if (PARSE.TryGetValue(text, out code)) { return true; }
            if (text.StartsWith("Key0x", StringComparison.OrdinalIgnoreCase)
                && ushort.TryParse(text.AsSpan(5), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code) && code != NONE)
            {
                return true;
            }
            code = NONE;
            return false;
        }

        #endregion
    }

    /// <summary>
    /// The live state of keys, mouse buttons and the wheel for one frame (the app's <c>InputState</c>; tests use a fake).
    /// Codes are <see cref="KeyCodes"/>.
    /// </summary>
    public interface IKeyState
    {
        /// <summary>How far the key / button / stick direction is in, 0–1 (keys: 0 or 1; build B: sticks and triggers analog).</summary>
        float KeyAnalog(ushort code);

        /// <summary>Held now.</summary>
        bool IsKeyDown(ushort code);

        /// <summary>Went down this frame (auto-repeat excluded; a wheel notch counts as a press).</summary>
        bool IsKeyPressed(ushort code);

        /// <summary>Auto-repeated this frame (held keys only; never mouse buttons).</summary>
        bool IsKeyRepeated(ushort code);
    }

    /// <summary>
    /// One binding (input round B2): a key, mouse button or wheel direction plus the modifiers that must be held with
    /// it. A modifier key can be the key itself (Run = Shift); its own flag is then dropped. Stored as text
    /// ("Ctrl+Shift+S", "Mouse4", "WheelUp", "Shift").
    /// </summary>
    public readonly struct KeyChord : IEquatable<KeyChord>
    {
        /// <summary>The key, button or wheel code (<see cref="KeyCodes"/>); 0 = unbound.</summary>
        public ushort Key { get; }

        /// <summary>Modifiers that must be held.</summary>
        public KeyModifiers Modifiers { get; }

        /// <summary>
        /// Creates a chord. A modifier key's own flag is removed (Shift + Shift = Shift).
        /// </summary>
        public KeyChord(ushort key, KeyModifiers modifiers = KeyModifiers.None)
        {
            Key = key;
            Modifiers = key == KeyCodes.NONE ? KeyModifiers.None : modifiers & ~KeyCodes.ModifierOf(key) & (KeyCodes.KEYBOARD_MODIFIERS | KeyCodes.PAD_MODIFIERS);
        }

        /// <summary>No binding.</summary>
        public static KeyChord None => default;

        /// <summary>True when unbound.</summary>
        public bool IsEmpty => Key == KeyCodes.NONE;

        /// <summary>A letter or digit key with these modifiers.</summary>
        public static KeyChord Of(char c, KeyModifiers modifiers = KeyModifiers.None) => new(KeyCodes.Letter(c), modifiers);

        /// <summary>Number of modifiers it needs.</summary>
        public int ModifierCount => System.Numerics.BitOperations.PopCount((uint)Modifiers);

        /// <summary>True for a gamepad button, trigger or stick direction.</summary>
        public bool IsPad => KeyCodes.IsPad(Key);

        /// <summary>
        /// Stored form: modifiers in the order Ctrl, Alt, Shift, then the key ("Ctrl+Shift+S"); empty when unbound.
        /// </summary>
        public override string ToString() => IsEmpty ? string.Empty : ModifierPrefix(Modifiers, display: false) + KeyCodes.StorageName(Key);

        /// <summary>
        /// Display form ("Ctrl+Shift+S", "Shift+[", "Wheel up"). The app can name keys from the keyboard layout instead
        /// (punctuation differs by layout); null uses the US glyphs.
        /// </summary>
        public string ToDisplayString(Func<ushort, string> keyName = null)
        {
            if (IsEmpty) { return string.Empty; }
            string name = keyName?.Invoke(Key);
            return ModifierPrefix(Modifiers) + (string.IsNullOrEmpty(name) ? KeyCodes.DisplayName(Key) : name);
        }

        /// <summary>
        /// "Ctrl+Alt+Shift+" (then "LB+RB+" for the gamepad shoulders) for the modifiers that are set (empty for none).
        /// Stored text names the shoulders "PadLB+" / "PadRB+".
        /// </summary>
        public static string ModifierPrefix(KeyModifiers modifiers, bool display = true)
        {
            if (modifiers == KeyModifiers.None) { return string.Empty; }
            string prefix = string.Empty;
            if ((modifiers & KeyModifiers.Ctrl) != 0) { prefix += "Ctrl+"; }
            if ((modifiers & KeyModifiers.Alt) != 0) { prefix += "Alt+"; }
            if ((modifiers & KeyModifiers.Shift) != 0) { prefix += "Shift+"; }
            if ((modifiers & KeyModifiers.PadLB) != 0) { prefix += display ? "LB+" : "PadLB+"; }
            if ((modifiers & KeyModifiers.PadRB) != 0) { prefix += display ? "RB+" : "PadRB+"; }
            return prefix;
        }

        /// <summary>
        /// Reads a stored chord ("Ctrl+Shift+S", "shift", "Mouse4"). Empty text reads as unbound (true).
        /// </summary>
        /// <returns>False when the text isn't a chord.</returns>
        public static bool TryParse(string text, out KeyChord chord)
        {
            chord = None;
            if (string.IsNullOrWhiteSpace(text)) { return true; }

            // "Ctrl+-" splits into "Ctrl" and "-": the key is always the last token
            string[] parts = text.Trim().Split('+');
            if (parts.Length == 0) { return false; }
            KeyModifiers modifiers = KeyModifiers.None;
            for (int i = 0; i < parts.Length - 1; i++)
            {
                if (!KeyCodes.TryParse(parts[i], out ushort modifier) || !KeyCodes.IsModifier(modifier)) { return false; }
                modifiers |= KeyCodes.ModifierOf(modifier);
            }
            if (!KeyCodes.TryParse(parts[^1], out ushort key)) { return false; }
            chord = new KeyChord(key, modifiers);
            return true;
        }

        /// <summary>Reads a stored chord, or throws (defaults and tests).</summary>
        public static KeyChord Parse(string text) =>
            TryParse(text, out KeyChord chord) ? chord : throw new FormatException($"Not a key binding: \"{text}\".");

        public bool Equals(KeyChord other) => Key == other.Key && Modifiers == other.Modifiers;

        public override bool Equals(object obj) => obj is KeyChord other && Equals(other);

        public override int GetHashCode() => (Key << 3) | (int)Modifiers;

        public static bool operator ==(KeyChord a, KeyChord b) => a.Equals(b);

        public static bool operator !=(KeyChord a, KeyChord b) => !a.Equals(b);
    }
}
