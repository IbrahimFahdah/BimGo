using System.Globalization;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>What a generic controller's input is (input round B2, build B2-C).</summary>
    public enum PadSourceKind : byte
    {
        /// <summary>Not mapped.</summary>
        None,

        /// <summary>A button (index 0–31).</summary>
        Button,

        /// <summary>A D-pad (POV hat) direction (index 0 up, 1 right, 2 down, 3 left).</summary>
        Pov,

        /// <summary>One direction of an axis (index 0–5: X, Y, Z, R, U, V; sign +1 or -1).</summary>
        Axis
    }

    /// <summary>
    /// One input of a generic controller: a button, a D-pad direction or an axis direction. Stored as text: "B1"–"B32"
    /// (1-based like Windows' game controller panel), "POVU" / "POVR" / "POVD" / "POVL", "X+" / "Y-" / "Z+" / "R-" / "U+" /
    /// "V-".
    /// </summary>
    public readonly record struct PadSource(PadSourceKind Kind, int Index, int Sign)
    {
        /// <summary>Not mapped.</summary>
        public static PadSource None => default;

        /// <summary>True when not mapped.</summary>
        public bool IsNone => Kind == PadSourceKind.None;

        private static readonly string[] AXES = { "X", "Y", "Z", "R", "U", "V" };
        private static readonly string[] POVS = { "POVU", "POVR", "POVD", "POVL" };

        /// <summary>A button (0-based).</summary>
        public static PadSource Button(int index) => new(PadSourceKind.Button, index, 0);

        /// <summary>A D-pad direction (0 up, 1 right, 2 down, 3 left).</summary>
        public static PadSource Pov(int direction) => new(PadSourceKind.Pov, direction, 0);

        /// <summary>An axis direction (0–5 = X, Y, Z, R, U, V; sign ±1).</summary>
        public static PadSource Axis(int axis, int sign) => new(PadSourceKind.Axis, axis, sign < 0 ? -1 : 1);

        /// <summary>The same axis the other way (a stick's opposite direction); other kinds: None.</summary>
        public PadSource Opposite => Kind == PadSourceKind.Axis ? Axis(Index, -Sign) : None;

        /// <summary>Stored text ("B3", "POVU", "Y-"; empty when not mapped).</summary>
        public override string ToString() => Kind switch
        {
            PadSourceKind.Button => "B" + (Index + 1).ToString(CultureInfo.InvariantCulture),
            PadSourceKind.Pov => POVS[Math.Clamp(Index, 0, 3)],
            PadSourceKind.Axis => AXES[Math.Clamp(Index, 0, 5)] + (Sign < 0 ? "-" : "+"),
            _ => string.Empty
        };

        /// <summary>Shown in CONTROLS ("button 3", "D-pad ↑", "axis Y −").</summary>
        public string Describe() => Kind switch
        {
            PadSourceKind.Button => "button " + (Index + 1).ToString(CultureInfo.InvariantCulture),
            PadSourceKind.Pov => "D-pad " + "↑→↓←"[Math.Clamp(Index, 0, 3)],
            PadSourceKind.Axis => "axis " + AXES[Math.Clamp(Index, 0, 5)] + (Sign < 0 ? " −" : " +"),
            _ => "—"
        };

        /// <summary>Reads stored text (empty = not mapped, true).</summary>
        public static bool TryParse(string text, out PadSource source)
        {
            source = None;
            if (string.IsNullOrWhiteSpace(text)) { return true; }
            text = text.Trim().ToUpperInvariant();
            int pov = Array.IndexOf(POVS, text);
            if (pov >= 0)
            {
                source = Pov(pov);
                return true;
            }
            if (text.Length >= 2 && text[0] == 'B' && int.TryParse(text.AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture, out int button) && button is >= 1 and <= GenericPadMap.BUTTONS)
            {
                source = Button(button - 1);
                return true;
            }
            if (text.Length == 2 && (text[1] == '+' || text[1] == '-'))
            {
                int axis = Array.IndexOf(AXES, text[..1]);
                if (axis >= 0)
                {
                    source = Axis(axis, text[1] == '-' ? -1 : 1);
                    return true;
                }
            }
            return false;
        }
    }

    /// <summary>
    /// How a generic (non-XInput) controller's buttons, D-pad and axes become BimGo's gamepad codes (input round B2,
    /// build B2-C): one <see cref="PadSource"/> per gamepad code, recorded by CONTROLS → MAP BUTTONS and saved per
    /// machine. <see cref="Evaluate"/> turns a reading (axes −1–1, a button mask, the D-pad angle) into each code's
    /// 0–1 amount; the app then applies the dead zone and thresholds as it does for XInput. Pure maths, tested in Core.
    /// </summary>
    public sealed class GenericPadMap
    {
        /// <summary>Axes a generic controller can report (X, Y, Z, R, U, V).</summary>
        public const int AXES = 6;

        /// <summary>Buttons a generic controller can report.</summary>
        public const int BUTTONS = 32;

        /// <summary>The D-pad reading when it rests (no direction).</summary>
        public const int POV_CENTRED = -1;

        /// <summary>An axis must move this far from rest to count while mapping (of −1–1).</summary>
        public const float DETECT_AXIS = 0.6f;

        private readonly PadSource[] _sources = new PadSource[KeyCodes.PAD_COUNT];

        /// <summary>The source of a gamepad code (None when unmapped or not a gamepad code).</summary>
        public PadSource Get(ushort code) => KeyCodes.IsPad(code) ? _sources[code - KeyCodes.GAMEPAD_FIRST] : PadSource.None;

        /// <summary>Sets the source of a gamepad code.</summary>
        public void Set(ushort code, PadSource source)
        {
            if (KeyCodes.IsPad(code)) { _sources[code - KeyCodes.GAMEPAD_FIRST] = source; }
        }

        /// <summary>True when nothing is mapped.</summary>
        public bool IsEmpty => _sources.All(s => s.IsNone);

        /// <summary>How many codes are mapped.</summary>
        public int MappedCount => _sources.Count(s => !s.IsNone);

        /// <summary>
        /// A first guess for an unmapped Xbox-style pad in Windows' joystick mode: buttons 1–10 = A B X Y LB RB Back
        /// Start LS RS, the D-pad on the hat, the left stick on X / Y, the right stick on U / R, the triggers on Z.
        /// MAP BUTTONS replaces it with what the pad really does.
        /// </summary>
        public static GenericPadMap XboxStyleGuess()
        {
            var map = new GenericPadMap();
            ushort[] buttons = { KeyCodes.PAD_A, KeyCodes.PAD_B, KeyCodes.PAD_X, KeyCodes.PAD_Y, KeyCodes.PAD_LB, KeyCodes.PAD_RB,
                KeyCodes.PAD_BACK, KeyCodes.PAD_START, KeyCodes.PAD_LS, KeyCodes.PAD_RS };
            for (int i = 0; i < buttons.Length; i++) { map.Set(buttons[i], PadSource.Button(i)); }
            map.Set(KeyCodes.PAD_UP, PadSource.Pov(0));
            map.Set(KeyCodes.PAD_RIGHT, PadSource.Pov(1));
            map.Set(KeyCodes.PAD_DOWN, PadSource.Pov(2));
            map.Set(KeyCodes.PAD_LEFT, PadSource.Pov(3));
            map.SetStick(KeyCodes.PAD_LS_UP, PadSource.Axis(1, -1), PadSource.Axis(0, -1)); // Y up is negative
            map.SetStick(KeyCodes.PAD_RS_UP, PadSource.Axis(3, -1), PadSource.Axis(4, -1));
            map.Set(KeyCodes.PAD_LT, PadSource.Axis(2, +1));
            map.Set(KeyCodes.PAD_RT, PadSource.Axis(2, -1));
            return map;
        }

        /// <summary>
        /// Sets a stick's four directions from its up and left sources (down and right are the same axes the other way).
        /// </summary>
        /// <param name="up">The stick's up code (<see cref="KeyCodes.PAD_LS_UP"/> or <see cref="KeyCodes.PAD_RS_UP"/>).</param>
        public void SetStick(ushort up, PadSource upSource, PadSource leftSource)
        {
            Set(up, upSource);
            Set((ushort)(up + 1), upSource.Opposite);
            Set((ushort)(up + 2), leftSource);
            Set((ushort)(up + 3), leftSource.Opposite);
        }

        #region Reading

        /// <summary>
        /// Each gamepad code's amount (0–1) for one reading: a button 0 or 1, a D-pad direction 1 when the hat points within
        /// 67.5° of it (diagonals count for both), an axis direction its value that way (−1–1 → 0–1).
        /// </summary>
        /// <param name="axes">X, Y, Z, R, U, V in −1–1 (missing axes 0).</param>
        /// <param name="buttons">Pressed buttons (bit 0 = button 1).</param>
        /// <param name="povHundredths">The hat in hundredths of a degree clockwise from up, or <see cref="POV_CENTRED"/>.</param>
        /// <param name="analog">Out: one amount per gamepad code (<see cref="KeyCodes.PAD_COUNT"/>).</param>
        public void Evaluate(ReadOnlySpan<float> axes, uint buttons, int povHundredths, Span<float> analog)
        {
            for (int i = 0; i < KeyCodes.PAD_COUNT && i < analog.Length; i++)
            {
                PadSource source = _sources[i];
                analog[i] = source.Kind switch
                {
                    PadSourceKind.Button => (buttons & (1u << Math.Clamp(source.Index, 0, 31))) != 0 ? 1f : 0f,
                    PadSourceKind.Pov => PovPoints(povHundredths, source.Index) ? 1f : 0f,
                    PadSourceKind.Axis => source.Index < axes.Length ? Math.Clamp(axes[source.Index] * source.Sign, 0f, 1f) : 0f,
                    _ => 0f
                };
            }
        }

        /// <summary>True when the hat points within 67.5° of a direction (0 up, 1 right, 2 down, 3 left).</summary>
        public static bool PovPoints(int povHundredths, int direction)
        {
            if (povHundredths < 0 || povHundredths >= 36000) { return false; }
            int target = direction * 9000;
            int difference = Math.Abs(povHundredths - target) % 36000;
            if (difference > 18000) { difference = 36000 - difference; }
            return difference < 6750;
        }

        #endregion

        #region Mapping (CONTROLS → MAP BUTTONS)

        /// <summary>
        /// The first input that differs from the resting reading: a newly pressed button, the hat pointing somewhere, or an
        /// axis moved more than <see cref="DETECT_AXIS"/> (its direction is the sign of the change). None while at rest.
        /// </summary>
        public static PadSource Detect(ReadOnlySpan<float> restAxes, uint restButtons, ReadOnlySpan<float> axes, uint buttons, int povHundredths)
        {
            uint pressed = buttons & ~restButtons;
            if (pressed != 0) { return PadSource.Button(System.Numerics.BitOperations.TrailingZeroCount(pressed)); }
            if (povHundredths >= 0 && povHundredths < 36000)
            {
                int direction = (int)MathF.Round(povHundredths / 9000f) % 4;
                return PadSource.Pov(direction);
            }
            int best = -1;
            float bestChange = DETECT_AXIS;
            for (int a = 0; a < AXES && a < axes.Length && a < restAxes.Length; a++)
            {
                float change = axes[a] - restAxes[a];
                if (MathF.Abs(change) > bestChange)
                {
                    bestChange = MathF.Abs(change);
                    best = a;
                }
            }
            return best >= 0 ? PadSource.Axis(best, axes[best] - restAxes[best] < 0f ? -1 : 1) : PadSource.None;
        }

        /// <summary>True when the reading is back at rest (no extra buttons, hat centred, axes within 0.3 of rest).</summary>
        public static bool AtRest(ReadOnlySpan<float> restAxes, uint restButtons, ReadOnlySpan<float> axes, uint buttons, int povHundredths)
        {
            if ((buttons & ~restButtons) != 0 || (povHundredths >= 0 && povHundredths < 36000)) { return false; }
            for (int a = 0; a < AXES && a < axes.Length && a < restAxes.Length; a++)
            {
                if (MathF.Abs(axes[a] - restAxes[a]) > 0.3f) { return false; }
            }
            return true;
        }

        #endregion

        #region Settings

        /// <summary>The map as stored in settings.json: gamepad code name ("PadA") → source ("B1"); unmapped codes left out.</summary>
        public Dictionary<string, string> ToSettings()
        {
            var stored = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int i = 0; i < KeyCodes.PAD_COUNT; i++)
            {
                if (!_sources[i].IsNone) { stored[KeyCodes.StorageName((ushort)(KeyCodes.GAMEPAD_FIRST + i))] = _sources[i].ToString(); }
            }
            return stored;
        }

        /// <summary>
        /// Reads a stored map (unknown codes and unreadable sources are skipped). An empty or missing map gives the
        /// Xbox-style guess.
        /// </summary>
        public static GenericPadMap FromSettings(IReadOnlyDictionary<string, string> stored, List<string> problems = null)
        {
            if (stored == null || stored.Count == 0) { return XboxStyleGuess(); }
            var map = new GenericPadMap();
            foreach (KeyValuePair<string, string> pair in stored)
            {
                if (!KeyCodes.TryParse(pair.Key, out ushort code) || !KeyCodes.IsPad(code))
                {
                    problems?.Add($"not a gamepad input: “{pair.Key}”");
                    continue;
                }
                if (!PadSource.TryParse(pair.Value, out PadSource source))
                {
                    problems?.Add($"{pair.Key}: can't read “{pair.Value}”");
                    continue;
                }
                map.Set(code, source);
            }
            return map;
        }

        #endregion
    }
}
