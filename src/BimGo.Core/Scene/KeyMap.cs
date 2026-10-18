using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// A binding that already uses a key (a clash).
    /// </summary>
    public readonly record struct BindingClash(InputAction Action, int Slot, KeyChord Chord)
    {
        /// <summary>The clashing action's definition.</summary>
        public ActionDef Def => InputCatalog.Get(Action);
    }

    /// <summary>
    /// What a rebinding did.
    /// </summary>
    public readonly record struct BindResult(bool Done, string Message);

    /// <summary>
    /// What an import read.
    /// </summary>
    public sealed class KeymapImport
    {
        /// <summary>True when the file was a BimGo keymap.</summary>
        public bool Valid { get; init; }

        /// <summary>Actions the file set.</summary>
        public int Applied { get; init; }

        /// <summary>Entries skipped (unknown or fixed actions, unreadable keys).</summary>
        public List<string> Problems { get; init; } = new();

        /// <summary>Clashes left after the import (shown in red in CONTROLS).</summary>
        public int Clashes { get; init; }
    }

    /// <summary>
    /// The live key bindings (input round B2): up to <see cref="MAX_SLOTS"/> chords per action, starting from the
    /// catalogue's defaults with the user's changes on top (settings.json stores only the changes, so a changed
    /// default reaches everyone who didn't rebind that action). Answers "did this action fire" for a frame's key state
    /// without allocating, finds and swaps clashes, and reads / writes keymap files.
    /// <para>
    /// <b>Modifiers.</b> A binding fires when its key goes down while its modifiers are held; extra modifiers don't
    /// stop it (Shift+Space still jumps while running) <i>unless</i> another binding live in the same situation uses
    /// the same key with more of the held modifiers (Shift+H sets home instead of going home; Shift+1 goes to a
    /// bookmark instead of picking gun 1). Held actions (movement, run) ignore that rule.
    /// </para>
    /// </summary>
    public sealed class KeyMap
    {
        /// <summary>Keyboard / mouse bindings per action (e.g. W / ↑, or → / PgDn / LMB for the tour's next stop).</summary>
        public const int MAX_SLOTS = 3;

        /// <summary>The gamepad's slot (build B): one gamepad binding per action, after the keyboard / mouse slots.</summary>
        public const int PAD_SLOT = MAX_SLOTS;

        /// <summary>Every slot: the keyboard / mouse ones and the gamepad's.</summary>
        public const int ALL_SLOTS = MAX_SLOTS + 1;

        /// <summary>The keymap file's format name.</summary>
        public const string FILE_FORMAT = "bimgo-keymap";

        /// <summary>The keymap file version written.</summary>
        public const int FILE_VERSION = 1;

        private readonly KeyChord[][] _slots;

        // Per action and slot: the modifier sets of other live bindings on the same key that need more modifiers
        // (when one of them is held, this binding stands aside). Rebuilt on every change.
        private KeyModifiers[][][] _shadows;

        // Display text, rebuilt lazily after a change
        private string[] _labels, _allLabels, _slotLabels;
        private int _labelsVersion = -1;
        private Func<ushort, string> _keyName;

        /// <summary>
        /// A map with the catalogue's defaults.
        /// </summary>
        public KeyMap()
        {
            _slots = new KeyChord[InputCatalog.ActionCount][];
            for (int i = 0; i < _slots.Length; i++) { _slots[i] = new KeyChord[ALL_SLOTS]; }
            ResetAll();
        }

        /// <summary>Changes with every edit (UI caches of key text compare it).</summary>
        public int Version { get; private set; }

        /// <summary>
        /// Names keys from the keyboard layout (the app's punctuation names), or null for the US glyphs.
        /// </summary>
        public Func<ushort, string> KeyName
        {
            get => _keyName;
            set
            {
                _keyName = value;
                _labelsVersion = -1;
                Version++;
            }
        }

        #region Reading

        /// <summary>The chord in a slot (None when empty or out of range).</summary>
        public KeyChord Get(InputAction action, int slot)
        {
            int index = (int)action;
            return index > 0 && index < _slots.Length && slot >= 0 && slot < ALL_SLOTS ? _slots[index][slot] : KeyChord.None;
        }

        /// <summary>The gamepad binding (None when there is none).</summary>
        public KeyChord PadChord(InputAction action) => Get(action, PAD_SLOT);

        /// <summary>The first bound keyboard / mouse chord (None when unbound).</summary>
        public KeyChord Primary(InputAction action)
        {
            for (int s = 0; s < MAX_SLOTS; s++)
            {
                KeyChord chord = Get(action, s);
                if (!chord.IsEmpty) { return chord; }
            }
            return KeyChord.None;
        }

        /// <summary>True when the action has no keyboard / mouse binding.</summary>
        public bool IsUnbound(InputAction action) => Primary(action).IsEmpty;

        /// <summary>True when the action's bindings are its defaults (in order).</summary>
        public bool IsDefault(InputAction action)
        {
            ActionDef def = InputCatalog.Get(action);
            if (def == null) { return true; }
            return IsKeyDefault(action) && Get(action, PAD_SLOT) == def.PadDefault;
        }

        /// <summary>True when the action's keyboard / mouse bindings are its defaults (in order).</summary>
        public bool IsKeyDefault(InputAction action)
        {
            ActionDef def = InputCatalog.Get(action);
            if (def == null) { return true; }
            for (int s = 0; s < MAX_SLOTS; s++)
            {
                KeyChord expected = s < def.Defaults.Count ? def.Defaults[s] : KeyChord.None;
                if (Get(action, s) != expected) { return false; }
            }
            return true;
        }

        /// <summary>True when every action is at its default.</summary>
        public bool AllDefault()
        {
            IReadOnlyList<ActionDef> all = InputCatalog.All;
            for (int i = 0; i < all.Count; i++) // (indexed: called per frame by the CONTROLS panel)
            {
                if (!IsDefault(all[i].Action)) { return false; }
            }
            return true;
        }

        #endregion

        #region Evaluation (per frame, no allocation)

        /// <summary>True when one of the action's bindings went down this frame (see the modifier rule above).</summary>
        public bool Pressed(InputAction action, IKeyState state) => Triggered(action, state, repeat: false);

        /// <summary>Like <see cref="Pressed"/>, also true on keyboard auto-repeat (stepping keys).</summary>
        public bool PressedOrRepeated(InputAction action, IKeyState state) => Triggered(action, state, repeat: true);

        /// <summary>True while one of the action's bindings is held with its modifiers.</summary>
        public bool Down(InputAction action, IKeyState state)
        {
            int index = (int)action;
            if (index <= 0 || index >= _slots.Length || state == null) { return false; }
            KeyChord[] slots = _slots[index];
            for (int s = 0; s < ALL_SLOTS; s++)
            {
                KeyChord chord = slots[s];
                if (!chord.IsEmpty && state.IsKeyDown(chord.Key) && ModifiersHeld(chord.Modifiers, state)) { return true; }
            }
            return false;
        }

        /// <summary>
        /// How far the action is held, 0–1: keys and buttons 0 or 1, gamepad sticks and triggers in between (build B:
        /// analog movement and look). The largest of its bindings whose modifiers are held.
        /// </summary>
        public float Axis(InputAction action, IKeyState state)
        {
            int index = (int)action;
            if (index <= 0 || index >= _slots.Length || state == null) { return 0f; }
            KeyChord[] slots = _slots[index];
            float value = 0f;
            for (int s = 0; s < ALL_SLOTS; s++)
            {
                KeyChord chord = slots[s];
                if (chord.IsEmpty || !ModifiersHeld(chord.Modifiers, state)) { continue; }
                value = MathF.Max(value, state.KeyAnalog(chord.Key));
            }
            return Math.Clamp(value, 0f, 1f);
        }

        /// <summary>
        /// The slot whose binding fired this frame (<see cref="PAD_SLOT"/> for the gamepad), or -1. Lets an action behave
        /// per device (the gun wheel: hold-and-release on the mouse, click-to-toggle on the gamepad).
        /// </summary>
        public int PressedSlot(InputAction action, IKeyState state)
        {
            int index = (int)action;
            if (index <= 0 || index >= _slots.Length || state == null) { return -1; }
            for (int s = 0; s < ALL_SLOTS; s++)
            {
                if (SlotTriggered(index, s, state, repeat: false)) { return s; }
            }
            return -1;
        }

        private bool Triggered(InputAction action, IKeyState state, bool repeat)
        {
            int index = (int)action;
            if (index <= 0 || index >= _slots.Length || state == null) { return false; }
            for (int s = 0; s < ALL_SLOTS; s++)
            {
                if (SlotTriggered(index, s, state, repeat)) { return true; }
            }
            return false;
        }

        private bool SlotTriggered(int index, int slot, IKeyState state, bool repeat)
        {
            KeyChord chord = _slots[index][slot];
            if (chord.IsEmpty) { return false; }
            if (!state.IsKeyPressed(chord.Key) && !(repeat && state.IsKeyRepeated(chord.Key))) { return false; }
            if (!ModifiersHeld(chord.Modifiers, state)) { return false; }

            KeyModifiers[] stronger = _shadows[index][slot];
            for (int i = 0; i < stronger.Length; i++)
            {
                if (ModifiersHeld(stronger[i], state)) { return false; }
            }
            return true;
        }

        /// <summary>True when every modifier in the set is held.</summary>
        public static bool ModifiersHeld(KeyModifiers modifiers, IKeyState state) =>
            ((modifiers & KeyModifiers.Shift) == 0 || state.IsKeyDown(KeyCodes.SHIFT))
            && ((modifiers & KeyModifiers.Ctrl) == 0 || state.IsKeyDown(KeyCodes.CTRL))
            && ((modifiers & KeyModifiers.Alt) == 0 || state.IsKeyDown(KeyCodes.ALT))
            && ((modifiers & KeyModifiers.PadLB) == 0 || state.IsKeyDown(KeyCodes.PAD_LB))
            && ((modifiers & KeyModifiers.PadRB) == 0 || state.IsKeyDown(KeyCodes.PAD_RB));

        /// <summary>Rebuilds the shadow lists (after any change).</summary>
        private void RebuildShadows()
        {
            int n = _slots.Length;
            var shadows = new KeyModifiers[n][][];
            var found = new List<KeyModifiers>(4);
            for (int a = 0; a < n; a++)
            {
                shadows[a] = new KeyModifiers[ALL_SLOTS][];
                for (int s = 0; s < ALL_SLOTS; s++)
                {
                    found.Clear();
                    KeyChord chord = _slots[a][s];
                    if (!chord.IsEmpty)
                    {
                        for (int b = 1; b < n; b++)
                        {
                            if (!InputCatalog.LiveTogether((InputAction)a, (InputAction)b)) { continue; }
                            for (int t = 0; t < ALL_SLOTS; t++)
                            {
                                KeyChord other = _slots[b][t];
                                if (other.IsEmpty || other.Key != chord.Key || other.Modifiers == chord.Modifiers) { continue; }
                                if ((other.Modifiers & chord.Modifiers) != chord.Modifiers) { continue; } // not a superset
                                if (!found.Contains(other.Modifiers)) { found.Add(other.Modifiers); }
                            }
                        }
                    }
                    shadows[a][s] = found.Count == 0 ? Array.Empty<KeyModifiers>() : found.ToArray();
                }
            }
            _shadows = shadows;
        }

        #endregion

        #region Clashes and changes

        /// <summary>
        /// Bindings of other actions that can fire together with this one and already use the chord.
        /// </summary>
        public List<BindingClash> FindClashes(InputAction action, KeyChord chord)
        {
            var clashes = new List<BindingClash>();
            if (chord.IsEmpty || InputCatalog.Get(action) == null) { return clashes; }
            for (int b = 1; b < _slots.Length; b++)
            {
                if (b == (int)action || !InputCatalog.LiveTogether(action, (InputAction)b)) { continue; }
                for (int t = 0; t < ALL_SLOTS; t++)
                {
                    if (_slots[b][t] == chord) { clashes.Add(new BindingClash((InputAction)b, t, chord)); }
                }
            }
            return clashes;
        }

        /// <summary>
        /// Every clash in the map (each pair once): none with the defaults; hand-edited or imported maps can have some.
        /// </summary>
        public List<(BindingClash First, BindingClash Second)> AllClashes()
        {
            var pairs = new List<(BindingClash, BindingClash)>();
            for (int a = 1; a < _slots.Length; a++)
            {
                for (int s = 0; s < ALL_SLOTS; s++)
                {
                    KeyChord chord = _slots[a][s];
                    if (chord.IsEmpty) { continue; }
                    foreach (BindingClash clash in FindClashes((InputAction)a, chord))
                    {
                        if ((int)clash.Action > a) { pairs.Add((new BindingClash((InputAction)a, s, chord), clash)); }
                    }
                }
            }
            return pairs;
        }

        /// <summary>True when one of the action's bindings clashes with another live action's.</summary>
        public bool HasClash(InputAction action)
        {
            for (int s = 0; s < ALL_SLOTS; s++)
            {
                KeyChord chord = Get(action, s);
                if (!chord.IsEmpty && FindClashes(action, chord).Count > 0) { return true; }
            }
            return false;
        }

        /// <summary>
        /// Why a chord can't be given to an action's slot (reserved keys, the wheel on a held action, fixed actions, a
        /// gamepad button in a keyboard slot or the reverse), or null when it can.
        /// </summary>
        public static string Refusal(InputAction action, KeyChord chord, int slot = 0)
        {
            ActionDef def = InputCatalog.Get(action);
            if (def == null) { return "Unknown action."; }
            if (def.IsFixed) { return $"“{def.Label}” is fixed."; }
            if (chord.IsEmpty) { return null; }
            if (slot == PAD_SLOT)
            {
                if (!chord.IsPad) { return "The gamepad column takes gamepad buttons, triggers and sticks."; }
                if ((chord.Modifiers & ~KeyCodes.PAD_MODIFIERS) != 0) { return "Gamepad bindings combine with LB / RB only."; }
            }
            else
            {
                if (chord.IsPad) { return "Gamepad buttons go in the gamepad column."; }
                if ((chord.Modifiers & ~KeyCodes.KEYBOARD_MODIFIERS) != 0) { return "Keys combine with Shift / Ctrl / Alt only."; }
            }
            if (KeyCodes.IsReserved(chord.Key)) { return $"{chord.ToDisplayString()} is reserved."; }
            if (chord.Key == KeyCodes.F4 && (chord.Modifiers & KeyModifiers.Alt) != 0) { return "Alt+F4 closes the window."; }
            if (def.Kind == ActionKind.Hold && (chord.Key == KeyCodes.WHEEL_UP || chord.Key == KeyCodes.WHEEL_DOWN))
            {
                return $"“{def.Label}” is held, and the wheel can't be held.";
            }
            if (chord.Key >= KeyCodes.GAMEPAD_FIRST && !chord.IsPad) { return $"{chord.ToDisplayString()} isn't a key BimGo knows."; }
            return null;
        }

        /// <summary>
        /// Puts a chord in an action's slot. A clash with a fixed key is refused; another clash is refused unless
        /// <paramref name="swap"/> is set, which gives the clashing actions this slot's old chord (or leaves them unbound
        /// when the old chord would clash for them or there wasn't one). The same chord in another of the action's slots
        /// moves here.
        /// </summary>
        public BindResult Assign(InputAction action, int slot, KeyChord chord, bool swap)
        {
            if (slot < 0 || slot >= ALL_SLOTS) { return new BindResult(false, "No such slot."); }
            string refusal = Refusal(action, chord, slot);
            if (refusal != null) { return new BindResult(false, refusal); }

            ActionDef def = InputCatalog.Get(action);
            KeyChord[] slots = _slots[(int)action];
            KeyChord old = slots[slot];
            if (old == chord) { return new BindResult(true, null); }

            List<BindingClash> clashes = FindClashes(action, chord);
            foreach (BindingClash clash in clashes)
            {
                if (clash.Def.IsFixed) { return new BindResult(false, $"{chord.ToDisplayString(_keyName)} is reserved for “{clash.Def.Label}”."); }
            }
            if (clashes.Count > 0 && !swap)
            {
                return new BindResult(false, $"{chord.ToDisplayString(_keyName)} is already “{clashes[0].Def.Label}” ({InputCatalog.ContextName(clashes[0].Def.Context)}).");
            }

            // The same chord in another of this action's slots moves here
            for (int s = 0; s < ALL_SLOTS; s++)
            {
                if (s != slot && slots[s] == chord) { slots[s] = KeyChord.None; }
            }
            slots[slot] = chord;

            // Swap: the others take the old chord when it's free for them
            var message = new StringBuilder();
            message.Append(def.Label).Append(": ").Append(chord.ToDisplayString(_keyName));
            foreach (BindingClash clash in clashes)
            {
                KeyChord[] theirs = _slots[(int)clash.Action];
                KeyChord give = old;
                if (!give.IsEmpty && (Refusal(clash.Action, give, clash.Slot) != null || Contains(theirs, give) || FindClashes(clash.Action, give).Count > 0)) { give = KeyChord.None; }
                theirs[clash.Slot] = give;
                message.Append(" · ").Append(clash.Def.Label).Append(give.IsEmpty ? ": unbound" : ": " + give.ToDisplayString(_keyName));
            }

            Changed();
            return new BindResult(true, message.ToString());
        }

        private static bool Contains(KeyChord[] slots, KeyChord chord)
        {
            foreach (KeyChord s in slots)
            {
                if (s == chord) { return true; }
            }
            return false;
        }

        /// <summary>Empties a slot (fixed actions can't be changed).</summary>
        public bool Clear(InputAction action, int slot)
        {
            ActionDef def = InputCatalog.Get(action);
            if (def == null || def.IsFixed || slot < 0 || slot >= ALL_SLOTS || _slots[(int)action][slot].IsEmpty) { return false; }
            _slots[(int)action][slot] = KeyChord.None;
            Changed();
            return true;
        }

        /// <summary>Two actions trade their gamepad bindings (SWAP STICKS: look ↔ move).</summary>
        public void SwapPad(InputAction a, InputAction b)
        {
            if (InputCatalog.Get(a) == null || InputCatalog.Get(b) == null) { return; }
            (_slots[(int)a][PAD_SLOT], _slots[(int)b][PAD_SLOT]) = (_slots[(int)b][PAD_SLOT], _slots[(int)a][PAD_SLOT]);
            Changed();
        }

        /// <summary>Puts one action back to its defaults (may leave a clash if another action took one of its keys).</summary>
        public void Reset(InputAction action)
        {
            if (InputCatalog.Get(action) == null) { return; }
            SetDefaults(action);
            Changed();
        }

        /// <summary>Puts every action back to its defaults.</summary>
        public void ResetAll()
        {
            foreach (ActionDef def in InputCatalog.All) { SetDefaults(def.Action); }
            Changed();
        }

        private void SetDefaults(InputAction action)
        {
            ActionDef def = InputCatalog.Get(action);
            KeyChord[] slots = _slots[(int)action];
            for (int s = 0; s < MAX_SLOTS; s++) { slots[s] = s < def.Defaults.Count ? def.Defaults[s] : KeyChord.None; }
            slots[PAD_SLOT] = def.PadDefault;
        }

        private void Changed()
        {
            RebuildShadows();
            Version++;
        }

        #endregion

        #region Settings (only the changes are stored)

        /// <summary>
        /// The actions whose keyboard / mouse keys differ from their defaults, as stored in settings.json: id → slots
        /// ("" = empty slot; trailing empty slots dropped, an unbound action keeps one "").
        /// </summary>
        public Dictionary<string, List<string>> ToOverrides()
        {
            var overrides = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (ActionDef def in InputCatalog.All)
            {
                if (def.IsFixed || IsKeyDefault(def.Action)) { continue; }
                overrides[def.Id] = SlotTexts(def.Action);
            }
            return overrides;
        }

        /// <summary>
        /// The actions whose gamepad binding differs from its default (build B): id → chord ("" = none). Stored apart
        /// from the keys (settings.json <c>PadBindings</c>), so older settings and keymap files read as before.
        /// </summary>
        public Dictionary<string, string> ToPadOverrides()
        {
            var overrides = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (ActionDef def in InputCatalog.All)
            {
                if (def.IsFixed || Get(def.Action, PAD_SLOT) == def.PadDefault) { continue; }
                overrides[def.Id] = Get(def.Action, PAD_SLOT).ToString();
            }
            return overrides;
        }

        private List<string> SlotTexts(InputAction action)
        {
            var texts = new List<string>(MAX_SLOTS);
            int last = -1;
            for (int s = 0; s < MAX_SLOTS; s++)
            {
                if (!Get(action, s).IsEmpty) { last = s; }
            }
            for (int s = 0; s <= Math.Max(last, 0); s++) { texts.Add(Get(action, s).ToString()); }
            return texts;
        }

        /// <summary>
        /// Starts from the defaults and applies stored changes. Unknown or fixed ids, unreadable keys and refused keys are
        /// skipped (listed in <paramref name="problems"/> when given); clashes are kept (CONTROLS shows them).
        /// </summary>
        /// <param name="overrides">Keyboard / mouse changes (settings <c>KeyBindings</c>).</param>
        /// <param name="problems">Collects what was skipped (optional).</param>
        /// <param name="padOverrides">Gamepad changes (settings <c>PadBindings</c>; optional).</param>
        /// <returns>How many actions were set (keys and gamepad counted once each).</returns>
        public int ApplyOverrides(IReadOnlyDictionary<string, List<string>> overrides, List<string> problems = null,
            IReadOnlyDictionary<string, string> padOverrides = null)
        {
            foreach (ActionDef def in InputCatalog.All) { SetDefaults(def.Action); }
            var applied = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (overrides != null)
            {
                foreach (KeyValuePair<string, List<string>> pair in overrides)
                {
                    if (ApplyOne(pair.Key, pair.Value, problems)) { applied.Add(pair.Key.Trim()); }
                }
            }
            if (padOverrides != null)
            {
                foreach (KeyValuePair<string, string> pair in padOverrides)
                {
                    if (ApplyPadOne(pair.Key, pair.Value, problems)) { applied.Add(pair.Key.Trim()); }
                }
            }
            Changed();
            return applied.Count;
        }

        private bool ApplyPadOne(string id, string text, List<string> problems)
        {
            InputAction action = InputCatalog.FromId(id);
            ActionDef def = InputCatalog.Get(action);
            if (def == null)
            {
                problems?.Add($"Unknown action “{id}” (gamepad)");
                return false;
            }
            if (def.IsFixed)
            {
                problems?.Add($"“{def.Label}” is fixed (gamepad)");
                return false;
            }
            if (!KeyChord.TryParse(text, out KeyChord chord))
            {
                problems?.Add($"“{def.Label}”: can't read gamepad “{text}”");
                return false;
            }
            string refusal = Refusal(action, chord, PAD_SLOT);
            if (refusal != null)
            {
                problems?.Add($"“{def.Label}” (gamepad): {refusal}");
                return false;
            }
            _slots[(int)action][PAD_SLOT] = chord;
            return true;
        }

        private bool ApplyOne(string id, IReadOnlyList<string> texts, List<string> problems)
        {
            InputAction action = InputCatalog.FromId(id);
            ActionDef def = InputCatalog.Get(action);
            if (def == null)
            {
                problems?.Add($"Unknown action “{id}”");
                return false;
            }
            if (def.IsFixed)
            {
                problems?.Add($"“{def.Label}” is fixed");
                return false;
            }

            var chords = new KeyChord[MAX_SLOTS];
            int count = Math.Min(texts?.Count ?? 0, MAX_SLOTS);
            for (int s = 0; s < count; s++)
            {
                if (!KeyChord.TryParse(texts[s], out KeyChord chord))
                {
                    problems?.Add($"“{def.Label}”: can't read “{texts[s]}”");
                    return false;
                }
                string refusal = Refusal(action, chord, s);
                if (refusal != null)
                {
                    problems?.Add($"“{def.Label}”: {refusal}");
                    continue;
                }
                if (!Contains(chords, chord) || chord.IsEmpty) { chords[s] = chord; }
            }
            Array.Copy(chords, _slots[(int)action], MAX_SLOTS);
            return true;
        }

        #endregion

        #region Keymap files

        /// <summary>
        /// The whole map as a keymap file (every rebindable action, so the file reads on its own).
        /// </summary>
        public string Export(string generator)
        {
            var bindings = new JsonObject();
            var pad = new JsonObject();
            foreach (ActionDef def in InputCatalog.All)
            {
                if (def.IsFixed) { continue; }
                var slots = new JsonArray();
                foreach (string text in SlotTexts(def.Action)) { slots.Add(text); }
                bindings[def.Id] = slots;
                pad[def.Id] = Get(def.Action, PAD_SLOT).ToString();
            }
            var root = new JsonObject
            {
                ["format"] = FILE_FORMAT,
                ["version"] = FILE_VERSION,
                ["generator"] = generator ?? string.Empty,
                ["bindings"] = bindings,
                ["pad"] = pad
            };
            return root.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        }

        /// <summary>
        /// Reads a keymap file: the defaults, then the file's bindings (actions it doesn't name keep their defaults). A
        /// file that isn't a BimGo keymap, or is from a newer version, changes nothing.
        /// </summary>
        public KeymapImport Import(string json)
        {
            try
            {
                JsonNode root = JsonNode.Parse(json ?? string.Empty);
                if (root is not JsonObject obj || (string)obj["format"] != FILE_FORMAT)
                {
                    return new KeymapImport { Valid = false, Problems = { "Not a BimGo keymap file." } };
                }
                int version = obj["version"] is JsonValue v && v.TryGetValue(out int read) ? read : 0;
                if (version > FILE_VERSION)
                {
                    return new KeymapImport { Valid = false, Problems = { $"Made by a newer BimGo (keymap version {version})." } };
                }
                if (obj["bindings"] is not JsonObject bindings)
                {
                    return new KeymapImport { Valid = false, Problems = { "The file has no bindings." } };
                }

                var overrides = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                var problems = new List<string>();
                foreach (KeyValuePair<string, JsonNode> pair in bindings)
                {
                    if (pair.Value is not JsonArray array)
                    {
                        problems.Add($"“{pair.Key}”: not a list of keys");
                        continue;
                    }
                    var texts = new List<string>(array.Count);
                    foreach (JsonNode node in array) { texts.Add(node == null ? string.Empty : node is JsonValue value && value.TryGetValue(out string text) ? text : "?"); }
                    overrides[pair.Key] = texts;
                }
                // Gamepad bindings (build B; files from build A have none: the gamepad keeps its defaults)
                Dictionary<string, string> padOverrides = null;
                if (obj["pad"] is JsonObject pad)
                {
                    padOverrides = new Dictionary<string, string>(StringComparer.Ordinal);
                    foreach (KeyValuePair<string, JsonNode> pair in pad)
                    {
                        padOverrides[pair.Key] = pair.Value == null ? string.Empty : pair.Value is JsonValue value && value.TryGetValue(out string text) ? text : "?";
                    }
                }
                int applied = ApplyOverrides(overrides, problems, padOverrides);
                return new KeymapImport { Valid = true, Applied = applied, Problems = problems, Clashes = AllClashes().Count };
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
            {
                return new KeymapImport { Valid = false, Problems = { "Not a readable keymap file: " + ex.Message } };
            }
        }

        #endregion

        #region Text

        /// <summary>The primary binding as shown in the UI ("Shift+O"; "unbound" when there is none).</summary>
        public string Label(InputAction action)
        {
            EnsureLabels();
            int index = (int)action;
            return index > 0 && index < _labels.Length ? _labels[index] : string.Empty;
        }

        /// <summary>Every binding of the action ("W / ↑"; "unbound").</summary>
        public string AllLabels(InputAction action)
        {
            EnsureLabels();
            int index = (int)action;
            return index > 0 && index < _allLabels.Length ? _allLabels[index] : string.Empty;
        }

        /// <summary>One slot's chord as the UI shows it (empty when the slot is empty; cached). <see cref="PAD_SLOT"/> is the gamepad's.</summary>
        public string SlotLabel(InputAction action, int slot)
        {
            EnsureLabels();
            int index = (int)action * ALL_SLOTS + slot;
            return (int)action > 0 && slot >= 0 && slot < ALL_SLOTS && index < _slotLabels.Length ? _slotLabels[index] ?? string.Empty : string.Empty;
        }

        /// <summary>The gamepad binding as the UI shows it ("LB+D-pad ↑"; empty when there is none; cached).</summary>
        public string PadLabel(InputAction action) => SlotLabel(action, PAD_SLOT);

        /// <summary>A chord as the UI shows it (with the layout's key names).</summary>
        public string Display(KeyChord chord) => chord.IsEmpty ? string.Empty : chord.ToDisplayString(_keyName);

        private void EnsureLabels()
        {
            if (_labelsVersion == Version && _labels != null) { return; }
            int n = _slots.Length;
            _labels = new string[n];
            _allLabels = new string[n];
            _slotLabels = new string[n * ALL_SLOTS];
            for (int a = 1; a < n; a++)
            {
                if (InputCatalog.Get((InputAction)a) == null) { continue; }
                var all = new StringBuilder();
                string primary = null;
                for (int s = 0; s < MAX_SLOTS; s++)
                {
                    KeyChord chord = _slots[a][s];
                    if (chord.IsEmpty) { continue; }
                    string text = chord.ToDisplayString(_keyName);
                    _slotLabels[a * ALL_SLOTS + s] = text;
                    primary ??= text;
                    if (all.Length > 0) { all.Append(" / "); }
                    all.Append(text);
                }
                if (!_slots[a][PAD_SLOT].IsEmpty) { _slotLabels[a * ALL_SLOTS + PAD_SLOT] = _slots[a][PAD_SLOT].ToDisplayString(_keyName); }
                _labels[a] = primary ?? "unbound";
                _allLabels[a] = all.Length > 0 ? all.ToString() : "unbound";
            }
            _labelsVersion = Version;
        }

        /// <summary>
        /// A run of actions bound to consecutive digit keys with the same modifiers reads as a range ("1–9",
        /// "Shift+1–9"); otherwise their primary keys joined by spaces.
        /// </summary>
        public string DescribeRange(InputAction first, int count)
        {
            KeyChord start = Primary(first);
            bool range = count > 1 && !start.IsEmpty && start.Key >= KeyCodes.D0 && start.Key <= KeyCodes.D0 + 9;
            for (int i = 1; range && i < count; i++)
            {
                KeyChord chord = Primary((InputAction)((int)first + i));
                range = chord.Key == start.Key + i && chord.Modifiers == start.Modifiers;
            }
            if (range)
            {
                KeyChord last = Primary((InputAction)((int)first + count - 1));
                return KeyChord.ModifierPrefix(start.Modifiers) + KeyCodes.DisplayName(start.Key) + "–" + KeyCodes.DisplayName(last.Key);
            }
            var parts = new List<string>(count);
            for (int i = 0; i < count; i++) { parts.Add(Label((InputAction)((int)first + i))); }
            return string.Join(" ", parts);
        }

        /// <summary>
        /// Several actions' primary keys joined by the separator; when they all need the same modifiers the prefix is
        /// written once ("Ctrl+S · Z · Y"). Four single-character keys with no modifiers run together ("WASD") when
        /// <paramref name="compact"/> is set. The wheel pair reads "Wheel".
        /// </summary>
        public string DescribeJoined(string separator, bool compact, params InputAction[] actions)
        {
            if (actions == null || actions.Length == 0) { return string.Empty; }
            var chords = new KeyChord[actions.Length];
            for (int i = 0; i < actions.Length; i++) { chords[i] = Primary(actions[i]); }

            if (chords.Length == 2 && chords[0].Modifiers == KeyModifiers.None && chords[1].Modifiers == KeyModifiers.None
                && ((chords[0].Key == KeyCodes.WHEEL_UP && chords[1].Key == KeyCodes.WHEEL_DOWN) || (chords[0].Key == KeyCodes.WHEEL_DOWN && chords[1].Key == KeyCodes.WHEEL_UP)))
            {
                return "Wheel";
            }

            bool allBound = chords.All(c => !c.IsEmpty);
            if (compact && allBound && chords.All(c => c.Modifiers == KeyModifiers.None && Display(c).Length == 1))
            {
                return string.Concat(chords.Select(Display));
            }

            KeyModifiers common = chords[0].Modifiers;
            bool shared = allBound && chords.Length > 1 && common != KeyModifiers.None && chords.All(c => c.Modifiers == common);
            var text = new StringBuilder();
            for (int i = 0; i < chords.Length; i++)
            {
                if (i > 0) { text.Append(separator); }
                if (chords[i].IsEmpty) { text.Append("unbound"); }
                else if (shared && i > 0) { text.Append(_keyName?.Invoke(chords[i].Key) is string name && name.Length > 0 ? name : KeyCodes.DisplayName(chords[i].Key)); }
                else { text.Append(Display(chords[i])); }
            }
            return text.ToString();
        }

        /// <summary>
        /// When <paramref name="fine"/> is <paramref name="coarse"/> plus modifiers, those modifiers ("Shift"); else the
        /// fine action's key. For hints like "[ ] sun time (Shift: 1 min)".
        /// </summary>
        public string DescribeModifierVariant(InputAction coarse, InputAction fine)
        {
            KeyChord a = Primary(coarse), b = Primary(fine);
            if (!a.IsEmpty && !b.IsEmpty && a.Key == b.Key && (b.Modifiers & a.Modifiers) == a.Modifiers && b.Modifiers != a.Modifiers)
            {
                return KeyChord.ModifierPrefix(b.Modifiers & ~a.Modifiers).TrimEnd('+');
            }
            return Label(fine);
        }

        /// <summary>
        /// Polish round P-B: an F1 row's key column: the row's fixed text, or its actions' primary keys joined by " · "
        /// (unbound ones left out; a run of five or more consecutive actions reads as a range, "SHIFT+1–9"; the four move
        /// keys run together, "WASD"; the wheel pair reads "WHEEL"). Upper case, as the sheet shows it.
        /// </summary>
        public string HelpKeys(HelpEntry entry)
        {
            if (entry == null) { return string.Empty; }
            if (entry.KeyText != null) { return entry.KeyText; }
            IReadOnlyList<InputAction> actions = entry.Actions;
            if (actions.Count == 4 && actions.All(IsMoveAction))
            {
                return DescribeJoined(" ", true, actions.ToArray()).ToUpperInvariant();
            }
            if (actions.Count == 2 && !IsUnbound(actions[0]) && !IsUnbound(actions[1]))
            {
                return DescribeJoined(" · ", false, actions[0], actions[1]).ToUpperInvariant();
            }

            var parts = new List<string>(actions.Count);
            for (int i = 0; i < actions.Count;)
            {
                int run = 1;
                while (i + run < actions.Count && (int)actions[i + run] == (int)actions[i] + run) { run++; }
                if (run >= 5)
                {
                    parts.Add(DescribeRange(actions[i], run));
                    i += run;
                    continue;
                }
                if (!IsUnbound(actions[i])) { parts.Add(Label(actions[i])); }
                i++;
            }
            return string.Join(" · ", parts).ToUpperInvariant();
        }

        /// <summary>
        /// Polish round P-B: an F1 row's gamepad column: its actions' gamepad bindings (none left out) joined by " · ", a
        /// shared prefix written once ("D-pad ← · →"); a stick's four directions read as the stick ("LS"). Empty when the
        /// row has none.
        /// </summary>
        public string HelpPad(HelpEntry entry)
        {
            if (entry == null) { return string.Empty; }
            var labels = new List<string>(entry.Actions.Count);
            foreach (InputAction action in entry.Actions)
            {
                string label = PadLabel(action);
                if (label.Length > 0 && !labels.Contains(label)) { labels.Add(label); }
            }
            if (labels.Count == 0) { return string.Empty; }
            if (labels.Count == 1) { return labels[0]; }

            // The common prefix up to a space ("LS ", "D-pad ", "LB+D-pad ")
            string first = labels[0];
            int common = first.Length;
            foreach (string label in labels)
            {
                int n = 0;
                while (n < common && n < label.Length && label[n] == first[n]) { n++; }
                common = n;
            }
            int space = first.LastIndexOf(' ', Math.Max(0, Math.Min(common, first.Length) - 1));
            if (space <= 0 || labels.Any(l => l.Length <= space + 1)) { return string.Join(" · ", labels); }
            string prefix = first.Substring(0, space);
            var rests = labels.Select(l => l.Substring(space + 1)).ToList();
            if (rests.Count == 4 && rests.Contains("↑") && rests.Contains("↓") && rests.Contains("←") && rests.Contains("→")) { return prefix; }
            return prefix + " " + string.Join(" · ", rests);
        }

        private static bool IsMoveAction(InputAction action) =>
            action is InputAction.MoveForward or InputAction.MoveBack or InputAction.MoveLeft or InputAction.MoveRight;

        #endregion

        #region README

        /// <summary>The marker lines around the generated controls in README §3.</summary>
        public const string README_BEGIN = "<!-- controls:begin (generated from the action map's defaults by tests/BimGo.Core.Tests/ControlsTests.cs: edit InputCatalog, not this table) -->";

        /// <summary>The closing marker.</summary>
        public const string README_END = "<!-- controls:end -->";

        /// <summary>
        /// The default controls as Markdown tables, one per group (README §3).
        /// </summary>
        public static string DefaultsMarkdown()
        {
            var map = new KeyMap();
            var md = new StringBuilder();
            foreach (InputContext context in InputCatalog.CONTEXT_ORDER)
            {
                md.Append("\n**").Append(InputCatalog.ContextName(context)).Append("**");
                string note = InputCatalog.ContextNote(context);
                if (note != null) { md.Append(" ").Append(note); }
                md.Append("\n\n| Action | Keys | Gamepad |\n|---|---|---|\n");
                foreach (ActionDef def in InputCatalog.All)
                {
                    if (def.Context != context) { continue; }
                    md.Append("| ").Append(def.Label).Append(" | ");
                    bool first = true;
                    for (int s = 0; s < MAX_SLOTS; s++)
                    {
                        KeyChord chord = map.Get(def.Action, s);
                        if (chord.IsEmpty) { continue; }
                        if (!first) { md.Append(" · "); }
                        first = false;
                        md.Append(Code(chord.ToDisplayString()));
                    }
                    md.Append(" | ");
                    if (!def.PadDefault.IsEmpty) { md.Append(Code(def.PadDefault.ToDisplayString())); }
                    md.Append(" |\n");
                }
            }
            return md.ToString().Replace("\n", Environment.NewLine);
        }

        private static string Code(string text) => text.Contains('`') ? "`` " + text + " ``" : "`" + text + "`";

        #endregion
    }
}
