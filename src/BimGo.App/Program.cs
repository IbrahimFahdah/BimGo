using BimGo.Live;
using BimGo.Native;
using BimGo.Shell;

// The class belongs to the root namespace
namespace BimGo
{
    /// <summary>
    /// BimGo.exe entry point.
    ///
    /// Usage: <c>BimGo.exe [model.bimgo]</c> or <c>BimGo.exe --session &lt;id&gt;</c> (what Go in Revit runs).
    /// A second launch hands its file / session to the running instance and exits.
    /// <c>BimGo.exe --register</c> / <c>--unregister</c> add or remove the .bimgo association and the Start-menu
    /// shortcut for the current user (add <c>--quiet</c> for no message box), then exit.
    /// </summary>
    internal static class Program
    {
        /// <summary>The app version ("3.00.00.01").</summary>
        public static string Version { get; } = GetVersion();

        [STAThread]
        private static int Main(string[] args)
        {
            Utilities.Log_Utils.Initialise("BimGo.App");
            AppDomain.CurrentDomain.UnhandledException += (_, e) => Utilities.Log_Utils.Write($"Unhandled: {e.ExceptionObject}");

            // Crisp UI on high-DPI screens
            try { Win32.SetProcessDpiAwarenessContext(Win32.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
            catch { /* older Windows: stays system-aware */ }

            // --register / --unregister: set up (or remove) the file association, then exit
            if (HasSwitch(args, "--register") || HasSwitch(args, "--unregister")) { return RunRegistration(args); }

            OpenTarget initial = ParseArguments(args);
            Utilities.Log_Utils.Write($"BimGo {Version} starting{(initial?.Path != null ? ": " + initial.Path : initial?.SessionId != null ? ": session " + initial.SessionId : string.Empty)}");

            using AppInstance instance = AppInstance.Claim();
            if (!instance.IsFirst)
            {
                AppInstance.ForwardToRunningInstance(initial);
                return 0;
            }

            // Old session folders (Revit crashed / was killed) are tidied once per app start
            LiveSessions.CleanupStale();

            // The installed copy keeps .bimgo files pointing at itself (quick registry check)
            FileAssociation.EnsureRegistered();

            try
            {
                return new AppShell(instance, initial).Run();
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"BimGo failed: {ex}");
                Win32.MessageBoxW(0, $"BimGo could not continue:\n\n{ex.Message}\n\nDetails were written to:\n{Utilities.Log_Utils.LogPath}",
                    "BimGo", Win32.MB_OK | Win32.MB_ICONERROR);
                return 1;
            }
        }

        /// <summary>
        /// Handles --register / --unregister (with optional --quiet).
        /// </summary>
        /// <returns>The exit code (0 on success).</returns>
        private static int RunRegistration(string[] args)
        {
            bool quiet = HasSwitch(args, "--quiet");
            bool register = HasSwitch(args, "--register");
            string exe = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "BimGo.exe");

            bool ok = register ? FileAssociation.Register(exe, out string error) : FileAssociation.Unregister(out error);
            string message = ok
                ? register
                    ? $".bimgo files now open in BimGo, and BimGo is in the Start menu.\n\n{exe}"
                    : ".bimgo files are no longer associated with BimGo, and the Start-menu shortcut was removed."
                : $"BimGo could not {(register ? "register" : "unregister")}:\n{error}";
            Utilities.Log_Utils.Write(message.Replace("\n\n", " "));

            if (!quiet)
            {
                Win32.MessageBoxW(0, message, "BimGo", Win32.MB_OK | (ok ? Win32.MB_ICONINFORMATION : Win32.MB_ICONERROR));
            }
            return ok ? 0 : 1;
        }

        private static bool HasSwitch(string[] args, string name)
        {
            foreach (string arg in args)
            {
                if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) { return true; }
            }
            return false;
        }

        /// <summary>
        /// <c>--session &lt;id&gt;</c>, else the first argument that is an existing file, else null.
        /// </summary>
        private static OpenTarget ParseArguments(string[] args)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], "--session", StringComparison.OrdinalIgnoreCase) && LiveProtocol.IsValidSessionId(args[i + 1]))
                {
                    return OpenTarget.Live(args[i + 1]);
                }
            }

            string file = FirstFileArgument(args);
            return file == null ? null : OpenTarget.File(file);
        }

        /// <summary>
        /// The first argument that is an existing file (switches and their values are skipped).
        /// </summary>
        private static string FirstFileArgument(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg.StartsWith("--", StringComparison.Ordinal))
                {
                    i++; // skip the switch's value
                    continue;
                }
                try
                {
                    string full = Path.GetFullPath(arg.Trim('"'));
                    if (File.Exists(full)) { return full; }
                }
                catch
                {
                    // Not a path
                }
            }
            return null;
        }

        private static string GetVersion()
        {
            System.Version version = typeof(Program).Assembly.GetName().Version;
            return version == null ? "3" : $"{version.Major}.{version.Minor:D2}.{version.Build:D2}.{version.Revision:D2}";
        }
    }
}
