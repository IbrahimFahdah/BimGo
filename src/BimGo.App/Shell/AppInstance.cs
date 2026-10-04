using System.Text.Json;
using BimGo.Format;
using BimGo.Live;
using BimGo.Native;
using BimGo.Platform;

// The class belongs to the Shell namespace
namespace BimGo.Shell
{
    /// <summary>
    /// Keeps BimGo.exe single-instance. The first instance owns a named mutex and an inbox folder
    /// (%LocalAppData%\BimGo\App\inbox); a second instance (e.g. double-clicking another .bimgo, or Revit's
    /// "open in BimGo") drops an open request there, brings the first window forward and exits.
    ///
    /// Requests are plain JSON files: <c>{ "open": "C:\\path\\model.bimgo" }</c> or <c>{ "attach": "&lt;sessionId&gt;" }</c>
    /// (Go in Revit). Only existing .bimgo paths and well-formed session ids with a session folder are accepted,
    /// and nothing in a request is ever executed.
    /// </summary>
    internal sealed class AppInstance : IDisposable
    {
        private const string MUTEX_NAME = @"Local\BimGo.App.SingleInstance";
        private const long MAX_REQUEST_BYTES = 16 * 1024;

        private Mutex _mutex;

        /// <summary>The app's folder (%LocalAppData%\BimGo\App).</summary>
        public static string AppFolder => Path.Combine(Utilities.Log_Utils.Folder, "App");

        /// <summary>The inbox folder.</summary>
        public static string InboxFolder => Path.Combine(AppFolder, "inbox");

        /// <summary>True if this process is the first (owning) instance.</summary>
        public bool IsFirst { get; private set; }

        /// <summary>
        /// Claims the single-instance mutex.
        /// </summary>
        public static AppInstance Claim()
        {
            var instance = new AppInstance();
            try
            {
                instance._mutex = new Mutex(initiallyOwned: true, MUTEX_NAME, out bool created);
                instance.IsFirst = created;
                if (created) { instance.WriteAppInfo(); }
            }
            catch (Exception ex)
            {
                // Can't tell: behave as the first instance rather than refusing to start
                Utilities.Log_Utils.Write($"Single-instance check failed: {ex.Message}");
                instance.IsFirst = true;
            }
            return instance;
        }

        /// <summary>
        /// Second instance: hands a file or session to the running instance and brings its window forward.
        /// </summary>
        public static void ForwardToRunningInstance(OpenTarget target)
        {
            try
            {
                if (target != null)
                {
                    var request = new OpenRequest
                    {
                        Open = target.Path == null ? null : Path.GetFullPath(target.Path),
                        Attach = target.SessionId
                    };
                    Directory.CreateDirectory(InboxFolder);
                    string name = $"{DateTime.UtcNow:yyyyMMddHHmmssfff}-{Guid.NewGuid():N}";
                    string temp = Path.Combine(InboxFolder, name + ".tmp");
                    File.WriteAllText(temp, JsonSerializer.Serialize(request));
                    File.Move(temp, Path.Combine(InboxFolder, name + ".json"));
                }

                nint window = Win32.FindWindowW(GameWindow.CLASS_NAME, null);
                if (window != 0)
                {
                    Win32.AllowSetForegroundWindow(Win32.ASFW_ANY);
                    Win32.PostMessageW(window, GameWindow.WM_APP_FOCUS, 0, 0);
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Could not forward to the running BimGo: {ex.Message}");
            }
        }

        /// <summary>
        /// First instance: takes the next valid request from the inbox, if any. Invalid requests are discarded.
        /// </summary>
        /// <returns>A file or session to open, or null.</returns>
        public OpenTarget TakeRequest()
        {
            try
            {
                if (!Directory.Exists(InboxFolder)) { return null; }
                foreach (string file in Directory.EnumerateFiles(InboxFolder, "*.json").OrderBy(f => f, StringComparer.Ordinal))
                {
                    OpenTarget target = null;
                    try
                    {
                        var info = new FileInfo(file);
                        if (info.Length <= MAX_REQUEST_BYTES)
                        {
                            OpenRequest request = JsonSerializer.Deserialize<OpenRequest>(File.ReadAllText(file), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                            if (request?.Attach != null && LiveProtocol.IsValidSessionId(request.Attach) && Directory.Exists(LiveProtocol.FolderFor(request.Attach)))
                            {
                                target = OpenTarget.Live(request.Attach);
                            }
                            else if (request?.Open != null && BimGoFormat.HasExtension(request.Open) && File.Exists(request.Open))
                            {
                                target = OpenTarget.File(request.Open);
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        Utilities.Log_Utils.Write($"Inbox request {Path.GetFileName(file)} ignored: {ex.Message}");
                    }

                    try { File.Delete(file); }
                    catch { /* retried next poll */ }

                    if (target != null) { return target; }
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Inbox poll failed: {ex.Message}");
            }
            return null;
        }

        /// <summary>
        /// Records the running app (PID and inbox) for other tools.
        /// </summary>
        private void WriteAppInfo()
        {
            try
            {
                Directory.CreateDirectory(AppFolder);
                var info = new { pid = Environment.ProcessId, inbox = InboxFolder, startedUtc = DateTime.UtcNow, version = Program.Version };
                File.WriteAllText(Path.Combine(AppFolder, "app.json"), JsonSerializer.Serialize(info, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"app.json could not be written: {ex.Message}");
            }
        }

        /// <summary>
        /// Releases the mutex and removes app.json.
        /// </summary>
        public void Dispose()
        {
            try
            {
                if (IsFirst)
                {
                    string appJson = Path.Combine(AppFolder, "app.json");
                    if (File.Exists(appJson)) { File.Delete(appJson); }
                    _mutex?.ReleaseMutex();
                }
            }
            catch
            {
                // Exiting regardless
            }
            _mutex?.Dispose();
            _mutex = null;
        }
    }

    /// <summary>
    /// An inbox request.
    /// </summary>
    internal sealed class OpenRequest
    {
        /// <summary>The .bimgo file to open, or null.</summary>
        public string Open { get; set; }

        /// <summary>The live session to attach to, or null.</summary>
        public string Attach { get; set; }
    }
}
