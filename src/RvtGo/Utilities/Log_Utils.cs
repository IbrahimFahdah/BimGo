// The class belongs to the Utilities namespace
namespace RvtGo.Utilities
{
    /// <summary>
    /// A minimal thread-safe file logger (%LocalAppData%\RvtGo\RvtGo.log).
    /// Used by both the Revit thread and the game thread; never throws.
    /// </summary>
    public static class Log_Utils
    {
        private static readonly object LOCK = new();
        private static bool _started;

        /// <summary>
        /// The folder used for logs and fallback files.
        /// </summary>
        public static string Folder { get; } = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RvtGo");

        /// <summary>
        /// The log file path.
        /// </summary>
        public static string LogPath { get; } = Path.Combine(Folder, "RvtGo.log");

        /// <summary>
        /// Appends a timestamped line to the log. The file is reset at the first write of each Revit session.
        /// </summary>
        /// <param name="message">The message to write.</param>
        public static void Write(string message)
        {
            try
            {
                lock (LOCK)
                {
                    Directory.CreateDirectory(Folder);
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
                System.Diagnostics.Debug.WriteLine($"RvtGo: {message}");
            }
            catch
            {
                // Logging must never take the add-in down
            }
        }
    }
}
