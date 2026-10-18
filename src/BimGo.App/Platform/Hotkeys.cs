using BimGo.Native;
using BimGo.Scene;

// The class belongs to the Platform namespace
namespace BimGo.Platform
{
    /// <summary>
    /// The app's key map (input round B2): one per machine (settings.json, only the changes from the defaults), shared
    /// by every walkthrough the window runs. Read at the start of each walkthrough; the CONTROLS panel saves it at once
    /// after each change. Code asks for actions through <see cref="InputState.Pressed(InputAction)"/>; hints and help
    /// read the bound keys from <see cref="Label"/> and rebuild their cached text when <see cref="Version"/> changes.
    /// </summary>
    internal static class Hotkeys
    {
        /// <summary>The live map (defaults until a walkthrough reads the settings).</summary>
        public static KeyMap Map { get; } = new() { KeyName = LayoutKeyName };

        /// <summary>Changes with every rebinding (cached hint text compares it).</summary>
        public static int Version => Map.Version;

        /// <summary>The action's primary key as the UI shows it ("Shift+O"; "unbound").</summary>
        public static string Label(InputAction action) => Map.Label(action);

        /// <summary>The action's keys as the UI shows them ("W / ↑").</summary>
        public static string AllLabels(InputAction action) => Map.AllLabels(action);

        /// <summary>
        /// Applies the settings' changed bindings over the defaults; anything unreadable is skipped and logged.
        /// </summary>
        public static void Read(LaunchSettings settings)
        {
            var problems = new List<string>();
            int applied = Map.ApplyOverrides(settings?.KeyBindings, problems, settings?.PadBindings);
            if (applied > 0) { Utilities.Log_Utils.Write($"Key bindings: {applied} action{(applied == 1 ? string.Empty : "s")} changed from the defaults."); }
            foreach (string problem in problems) { Utilities.Log_Utils.Write($"Key bindings: skipped {problem}."); }
            int clashes = Map.AllClashes().Count;
            if (clashes > 0) { Utilities.Log_Utils.Write($"Key bindings: {clashes} clash{(clashes == 1 ? string.Empty : "es")} (shown in red in CONTROLS)."); }

            // Polish round P-B: which controls defaults the user has seen (the machine's settings.json, not a copy)
            _seenVersion = Math.Max(0, LaunchSettings.LoadOrDefault().ControlsDefaultsVersion);
            if (_tagsSince == int.MaxValue) { _tagsSince = _seenVersion; } // the tags last for this run of BimGo
            RefreshFresh();
        }

        #region Changed defaults (polish round P-B)

        // The version settings.json holds (-1: not read yet, leave the file's value alone) and the one the tags compare
        private static int _seenVersion = -1;
        private static int _tagsSince = int.MaxValue;

        // Per action: changed in a version newer than the one seen when this run started (NEW / CHANGED tags)
        private static readonly bool[] FRESH = new bool[InputCatalog.ActionCount];
        private static readonly bool[] FRESH_ADDED = new bool[InputCatalog.ActionCount];

        /// <summary>The defaults this run's tags mark (changed after the version seen when BimGo started).</summary>
        public static List<DefaultsChange> FreshChanges { get; private set; } = new();

        private static void RefreshFresh()
        {
            Array.Clear(FRESH);
            Array.Clear(FRESH_ADDED);
            FreshChanges = InputCatalog.ChangesSince(_tagsSince);
            foreach (DefaultsChange change in FreshChanges)
            {
                FRESH[(int)change.Action] = true;
                FRESH_ADDED[(int)change.Action] |= change.Added;
            }
        }

        /// <summary>The tag for a row in CONTROLS: "NEW", "CHANGED" or null.</summary>
        public static string FreshTag(InputAction action)
        {
            int index = (int)action;
            if (index <= 0 || index >= FRESH.Length || !FRESH[index]) { return null; }
            return FRESH_ADDED[index] ? "NEW" : "CHANGED";
        }

        /// <summary>
        /// The one-time notice after an update that changed defaults ("Controls: N defaults changed · …"), or null when
        /// the user has seen the current defaults. Clashes between a new default and a rebind of theirs are counted.
        /// </summary>
        public static string PendingDefaultsNotice()
        {
            if (_seenVersion < 0 || _seenVersion >= InputCatalog.DEFAULTS_VERSION) { return null; }
            List<DefaultsChange> changes = InputCatalog.ChangesSince(_seenVersion);
            if (changes.Count == 0) { return null; }
            int clashes = NewDefaultClashes(changes).Count;
            string clash = clashes == 0 ? string.Empty : $" · {clashes} clash{(clashes == 1 ? string.Empty : "es")} with your own keys (red)";
            return $"Controls: {changes.Count} default{(changes.Count == 1 ? string.Empty : "s")} changed{clash} · Esc → CONTROLS";
        }

        /// <summary>
        /// The clashes left in the map that involve a changed default (a rebind of the user's now meets a new default),
        /// each once; logged by the caller.
        /// </summary>
        public static List<(BindingClash First, BindingClash Second)> NewDefaultClashes(List<DefaultsChange> changes)
        {
            var found = new List<(BindingClash, BindingClash)>();
            var changed = new HashSet<InputAction>();
            foreach (DefaultsChange change in changes) { changed.Add(change.Action); }
            foreach ((BindingClash first, BindingClash second) in Map.AllClashes())
            {
                if (changed.Contains(first.Action) || changed.Contains(second.Action)) { found.Add((first, second)); }
            }
            return found;
        }

        /// <summary>The notice was shown: settings.json records the current defaults version (the tags stay for this run).</summary>
        public static void MarkDefaultsSeen()
        {
            if (_seenVersion >= InputCatalog.DEFAULTS_VERSION) { return; }
            _seenVersion = InputCatalog.DEFAULTS_VERSION;
            Save();
        }

        #endregion

        /// <summary>Puts the changed bindings into settings (saved by the caller).</summary>
        public static void Write(LaunchSettings settings)
        {
            if (settings == null) { return; }
            settings.KeyBindings = Map.ToOverrides();
            settings.PadBindings = Map.ToPadOverrides();
            if (_seenVersion >= 0) { settings.ControlsDefaultsVersion = _seenVersion; } // P-B
            Gamepad.Write(settings);
        }

        /// <summary>
        /// Saves the bindings now (the rest of settings.json as it is on disk). Failures are logged, never thrown.
        /// </summary>
        public static void Save()
        {
            try
            {
                LaunchSettings settings = LaunchSettings.LoadOrDefault();
                Write(settings);
                settings.Save();
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Key bindings could not be saved: {ex.Message}");
            }
        }

        /// <summary>
        /// Punctuation keys named from the keyboard layout (a German keyboard's VK_OEM_1 is Ü, not ;). Letters, digits
        /// and named keys keep the map's names.
        /// </summary>
        private static string LayoutKeyName(ushort code)
        {
            if (code < KeyCodes.OEM_1 || code > KeyCodes.OEM_102) { return null; }
            try
            {
                uint mapped = Win32.MapVirtualKeyW(code, Win32.MAPVK_VK_TO_CHAR) & 0x7FFF; // the top bit marks a dead key
                if (mapped <= ' ' || mapped >= 0xD800) { return null; }
                return char.ToUpperInvariant((char)mapped).ToString();
            }
            catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
            {
                return null;
            }
        }
    }
}
