using System.Diagnostics;

// The class belongs to the Utilities namespace
namespace BimGo.Utilities
{
    /// <summary>
    /// Finds and starts the standalone BimGo app (BimGo.exe).
    /// </summary>
    public static class App_Utils
    {
        /// <summary>
        /// The shared install location (written by the BimGo.App build / installer), used by every Revit year.
        /// </summary>
        public static string InstalledExePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "BimGo", "BimGo.exe");

        /// <summary>
        /// The BimGo.exe to use: the shared install, else one beside the add-in, else null.
        /// </summary>
        public static string FindExe()
        {
            try
            {
                if (File.Exists(InstalledExePath)) { return InstalledExePath; }
                string besideAddin = Path.Combine(Globals.ADDIN_ASSEMBLY_DLLPATH ?? string.Empty, "BimGo.exe");
                if (File.Exists(besideAddin)) { return besideAddin; }
            }
            catch (Exception ex)
            {
                Log_Utils.Write($"BimGo.exe lookup failed: {ex.Message}");
            }
            return null;
        }

        /// <summary>
        /// Opens a .bimgo in the app (a running app receives it through its inbox and comes to the front).
        /// </summary>
        /// <returns>Null on success, else a reason.</returns>
        public static string OpenInApp(string bimgoPath) => Start(bimgoPath);

        /// <summary>
        /// Opens a live session in the app (<c>BimGo.exe --session &lt;id&gt;</c>; a running app receives it through its
        /// inbox, asks before switching away from another model, and comes to the front).
        /// </summary>
        /// <returns>Null on success, else a reason.</returns>
        public static string AttachInApp(string sessionId) => Start("--session", sessionId);

        /// <summary>
        /// Opens an address in the default browser.
        /// </summary>
        /// <returns>Null on success, else a reason.</returns>
        public static string OpenUrl(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();
                return null;
            }
            catch (Exception ex)
            {
                Log_Utils.Write($"Could not open the browser: {ex}");
                return ex.Message;
            }
        }

        /// <summary>
        /// Starts BimGo.exe with arguments.
        /// </summary>
        private static string Start(params string[] arguments)
        {
            string exe = FindExe();
            if (exe == null) { return $"BimGo.exe was not found (expected at {InstalledExePath})."; }
            try
            {
                var start = new ProcessStartInfo(exe)
                {
                    UseShellExecute = false,
                    WorkingDirectory = Path.GetDirectoryName(exe)
                };
                foreach (string argument in arguments) { start.ArgumentList.Add(argument); }
                Process.Start(start)?.Dispose();
                return null;
            }
            catch (Exception ex)
            {
                Log_Utils.Write($"Could not start BimGo.exe: {ex}");
                return ex.Message;
            }
        }
    }
}
