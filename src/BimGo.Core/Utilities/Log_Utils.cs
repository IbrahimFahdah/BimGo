// The class belongs to the Utilities namespace
namespace BimGo.Utilities
{
    /// <summary>
    /// A minimal thread-safe file logger (%LocalAppData%\BimGo\Logs\&lt;name&gt;.log).
    /// Each host picks its log name once at startup (<see cref="Initialise"/>): the add-in uses "BimGo.Revit",
    /// the standalone app "BimGo.App". Used from any thread; never throws.
    /// </summary>
    public static class Log_Utils
    {
        private static readonly object LOCK = new();
        private static bool _started;
        private static string _logName = "BimGo";

        /// <summary>
        /// %LocalAppData%\BimGo: logs, session folders, recent files and fallback comment files live under here.
        /// </summary>
        public static string Folder { get; } = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BimGo");

        /// <summary>
        /// The logs folder.
        /// </summary>
        public static string LogFolder => Path.Combine(Folder, "Logs");

        /// <summary>
        /// The log file path.
        /// </summary>
        public static string LogPath => Path.Combine(LogFolder, _logName + ".log");

        /// <summary>
        /// Sets the log file name (without extension). Call once, before the first <see cref="Write"/>.
        /// </summary>
        /// <param name="logName">A short name, e.g. "BimGo.App".</param>
        public static void Initialise(string logName)
        {
            lock (LOCK)
            {
                if (_started || string.IsNullOrWhiteSpace(logName)) { return; }
                _logName = logName.Trim();
            }
        }

        /// <summary>
        /// Appends a timestamped line to the log. The file is reset at the first write of each process.
        /// </summary>
        /// <param name="message">The message to write.</param>
        public static void Write(string message)
        {
            try
            {
                lock (LOCK)
                {
                    Directory.CreateDirectory(LogFolder);
                    string line = $"{DateTime.Now:HH:mm:ss.fff} [{Environment.CurrentManagedThreadId}] {message}{Environment.NewLine}";

                    if (!_started)
                    {
                        File.WriteAllText(LogPath, line);
                        _started = true;
                    }
                    else
                    {
                        File.AppendAllText(LogPath, line);
                    }
                }
                System.Diagnostics.Debug.WriteLine($"BimGo: {message}");
            }
            catch
            {
                // Logging must never take the host down
            }
        }
    }
}
