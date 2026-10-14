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
        }

        /// <summary>Puts the changed bindings into settings (saved by the caller).</summary>
        public static void Write(LaunchSettings settings)
        {
            if (settings == null) { return; }
            settings.KeyBindings = Map.ToOverrides();
            settings.PadBindings = Map.ToPadOverrides();
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
