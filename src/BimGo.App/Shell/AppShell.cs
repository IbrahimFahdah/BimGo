using BimGo.Format;
using BimGo.Game;
using BimGo.Live;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;
using BimGo.Sources;

// The class belongs to the Shell namespace
namespace BimGo.Shell
{
    /// <summary>
    /// The app: one window that alternates between the home screen and walkthroughs, all on the main thread.
    /// A walkthrough runs on a .bimgo file (edits go to its journal) or on a live Revit session (edits go to Revit).
    ///
    /// Closing the window quits (after any unsaved-changes prompt); Close model returns to the home screen.
    /// While walking: dropped / double-clicked files are queued until the model is closed; a Go from Revit asks
    /// before switching; a new snapshot of the current live session reloads where the player stands.
    /// </summary>
    internal sealed class AppShell
    {
        #region Fields

        private readonly Queue<OpenTarget> _openQueue = new();
        private readonly RecentFiles _recent = RecentFiles.Load();
        private readonly AppInstance _instance;
        private GameWindow _window;
        private UiBatch _ui;
        private HomeScreen _home;

        // The walkthrough in progress
        private GameSession _current;
        private string _currentSessionId;
        private OpenTarget _next;

        #endregion

        /// <summary>
        /// Creates the shell.
        /// </summary>
        /// <param name="instance">The single-instance owner (inbox).</param>
        /// <param name="initial">A file or session to open straight away (command line), or null.</param>
        public AppShell(AppInstance instance, OpenTarget initial)
        {
            _instance = instance;
            if (initial != null) { _openQueue.Enqueue(initial); }
        }

        /// <summary>Who writes files saved by the app.</summary>
        public static WriterInfo Writer => new("BimGo", Program.Version);

        #region Loop

        /// <summary>
        /// Runs the app until the window closes.
        /// </summary>
        /// <returns>The process exit code.</returns>
        public int Run()
        {
            try
            {
                _window = new GameWindow("BimGo");
                _ui = new UiBatch();
                _ui.Initialise(_window.DpiScale);
                _home = new HomeScreen(_window, _ui, _recent, _instance);

                while (true)
                {
                    OpenTarget target = TakeNext() ?? _home.Run();
                    if (target == null) { return 0; }

                    SessionEndReason reason = target.IsLive ? RunLive(target) : RunFile(target.Path);
                    if (reason == SessionEndReason.WindowClosed) { return 0; }

                    // A switch whose save prompt was cancelled must not fire later
                    if (reason == SessionEndReason.EndedByUser) { _next = null; }
                }
            }
            finally
            {
                try { _ui?.Dispose(); }
                catch (Exception ex) { Utilities.Log_Utils.Write($"UI cleanup failed: {ex.Message}"); }
                try { _window?.Dispose(); }
                catch (Exception ex) { Utilities.Log_Utils.Write($"Window cleanup failed: {ex.Message}"); }
            }
        }

        /// <summary>
        /// The next thing to open without visiting the home screen: a switch / reload first, then queued files.
        /// </summary>
        private OpenTarget TakeNext()
        {
            if (_next != null)
            {
                OpenTarget next = _next;
                _next = null;
                return next;
            }
            return _openQueue.Count > 0 ? _openQueue.Dequeue() : null;
        }

        #endregion

        #region Files

        /// <summary>
        /// Opens and walks a .bimgo file.
        /// </summary>
        private SessionEndReason RunFile(string path)
        {
            BimGoDocument document = LoadFile(path);
            if (document == null) { return SessionEndReason.EndedByUser; }

            var options = new SessionOptions
            {
                Source = new FileEditSource(document.Scene, Path.GetFileName(document.Path)),
                Document = document,
                InApp = true,
                Writer = Writer,
                OnOpenRequest = QueueFile,
                OnSaved = saved => _recent.Touch(saved),
                PollNotices = PollInbox
            };
            return RunSession(document.Scene, options, out _);
        }

        /// <summary>
        /// Reads a file, showing a loading frame; on failure the reason goes to the home screen.
        /// </summary>
        private BimGoDocument LoadFile(string path)
        {
            string name = Path.GetFileName(path);
            if (!BimGoFormat.HasExtension(path))
            {
                _home.SetMessage($"{name} is not a .bimgo file.", error: true);
                return null;
            }

            _home.DrawStatus($"Opening {name}", "Reading geometry…");
            BimGoDocument document = BimGoReader.Read(path, LaunchSettings.LoadOrDefault(), out string error);
            if (document == null)
            {
                _home.SetMessage($"Could not open {name}: {error}", error: true);
                return null;
            }

            _recent.Touch(path);
            _home.SetMessage(null, error: false);
            return document;
        }

        #endregion

        #region Live sessions

        /// <summary>
        /// Joins a live Revit session and walks its latest snapshot. A reload (newer snapshot) comes straight back
        /// here with the player's pose.
        /// </summary>
        private SessionEndReason RunLive(OpenTarget target)
        {
            string sessionId = target.SessionId;
            SessionInfo info = LiveSessions.ReadInfo(sessionId);
            if (info == null || !info.IsAlive())
            {
                _home.SetMessage("That Revit session is no longer running. Press Go in Revit to start a new one.", error: true);
                return SessionEndReason.EndedByUser;
            }
            if (string.IsNullOrEmpty(info.LatestSnapshot) || !File.Exists(info.LatestSnapshot))
            {
                _home.SetMessage($"{info.DocTitle} has no snapshot yet. Press Go in Revit.", error: true);
                return SessionEndReason.EndedByUser;
            }

            string title = string.IsNullOrWhiteSpace(info.DocTitle) ? "Revit model" : info.DocTitle;
            _home.DrawStatus($"Joining {title}", target.Pose == null ? "Reading the Revit snapshot…" : "Reloading the new snapshot…");

            // Attach first so nothing Revit sends from now on is missed, then read the snapshot
            var source = new LiveSessionSource(info, Program.Version);
            BimGoDocument document = BimGoReader.Read(info.LatestSnapshot, LaunchSettings.LoadOrDefault(), out string error);
            if (document == null)
            {
                source.Close(sayGoodbye: true);
                _home.SetMessage($"Could not read the snapshot of {title}: {error}", error: true);
                return SessionEndReason.EndedByUser;
            }
            _home.SetMessage(null, error: false);

            var options = new SessionOptions
            {
                Source = source,
                Document = null,
                InApp = true,
                Writer = Writer,
                Pose = target.Pose,
                OnOpenRequest = QueueFile,
                OnSaved = saved => _recent.Touch(saved),
                PollNotices = PollInbox
            };

            _currentSessionId = sessionId;
            SessionEndReason reason = RunSession(document.Scene, options, out SessionPose pose);
            _currentSessionId = null;

            source.Close(sayGoodbye: reason != SessionEndReason.Reload);
            if (reason == SessionEndReason.Reload) { _next = OpenTarget.Live(sessionId, pose); }
            return reason;
        }

        #endregion

        #region Sessions

        /// <summary>
        /// Runs a walkthrough. A crash ends the walkthrough (logged and reported) but not the app.
        /// </summary>
        /// <param name="scene">The scene.</param>
        /// <param name="options">The session options.</param>
        /// <param name="pose">Where the player stood at the end (for reloads), or null.</param>
        private SessionEndReason RunSession(SceneData scene, SessionOptions options, out SessionPose pose)
        {
            pose = null;
            GameSession session = null;
            try
            {
                Utilities.Log_Utils.Write($"Session starting: {options.Source.DisplayName}");
                session = new GameSession(_window, scene, options);
                _current = session;
                SessionEndReason reason = session.Run();
                pose = session.CapturePose();
                return reason;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Session crashed: {ex}");
                _window.SetCaptured(false);
                FileDialogs.ShowError(_window.Handle, $"The walkthrough stopped unexpectedly:\n\n{ex.Message}\n\nDetails were written to:\n{Utilities.Log_Utils.LogPath}");
                _home.SetMessage("The last walkthrough stopped unexpectedly. Unsaved changes were lost.", error: true);
                return _window.Handle == 0 ? SessionEndReason.WindowClosed : SessionEndReason.EndedByUser;
            }
            finally
            {
                _current = null;
                try { session?.Dispose(); }
                catch (Exception ex) { Utilities.Log_Utils.Write($"Session cleanup failed: {ex.Message}"); }
                Utilities.Log_Utils.Write("Session ended.");
            }
        }

        /// <summary>
        /// A file dropped on the window during a walkthrough: queued until the current model is closed.
        /// </summary>
        private string QueueFile(string path)
        {
            if (!BimGoFormat.HasExtension(path)) { return $"{Path.GetFileName(path)} is not a .bimgo file"; }
            _openQueue.Enqueue(OpenTarget.File(path));
            return $"{Path.GetFileName(path)} will open when you close this model (Esc → Close model)";
        }

        /// <summary>
        /// Requests from other instances / Revit during a walkthrough. Files are queued; a Go from Revit for another
        /// model asks before switching (a Go for the current session needs nothing: its new snapshot reloads).
        /// </summary>
        private string PollInbox()
        {
            OpenTarget request = _instance?.TakeRequest();
            if (request == null) { return null; }
            if (!request.IsLive) { return QueueFile(request.Path); }
            if (request.SessionId == _currentSessionId) { return null; }

            SessionInfo info = LiveSessions.ReadInfo(request.SessionId);
            string title = string.IsNullOrWhiteSpace(info?.DocTitle) ? "another Revit model" : info.DocTitle;

            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            // The model this file came from: staying lets the file's edits be pushed into it
            string pushHint = _current?.HasPushableEditsFor(info?.ModelKey) == true
                ? "\n\nChoose No to stay in this file and push its edits into that model (Esc → PUSH TO REVIT)."
                : string.Empty;
            bool switchNow = FileDialogs.AskYesNo(_window.Handle,
                $"Revit wants to open {title} in BimGo.\n\nSwitch now? (You'll be asked to save first if this model has unsaved changes.){pushHint}",
                "BimGo");
            if (!switchNow) { return $"{title} was not opened. Join it later from the home screen."; }

            _next = request;
            _current?.RequestEnd(SessionEndReason.Switch);
            return $"Switching to {title}…";
        }

        #endregion
    }
}
