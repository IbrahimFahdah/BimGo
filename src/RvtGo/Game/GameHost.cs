using RvtGo.Native;
using RvtGo.Platform;
using RvtGo.Scene;

// The class belongs to the Game namespace
namespace RvtGo.Game
{
    /// <summary>
    /// Starts and tracks the single walkthrough session thread.
    /// The Revit thread hands over an immutable <see cref="SceneData"/> and returns immediately;
    /// everything else (window, GL, physics, audio) lives on the game thread.
    /// </summary>
    internal static class GameHost
    {
        private static readonly object LOCK = new();
        private static Thread _thread;
        private static volatile GameWindow _window;
        private static volatile bool _running;

        /// <summary>True while a session is running.</summary>
        public static bool IsRunning => _running;

        /// <summary>
        /// Starts a session on a new thread.
        /// </summary>
        /// <param name="scene">The snapshot.</param>
        /// <returns>False if a session is already running or the thread could not start.</returns>
        public static bool Launch(SceneData scene)
        {
            lock (LOCK)
            {
                if (_running) { return false; }
                _running = true;

                try
                {
                    _thread = new Thread(() => RunSession(scene))
                    {
                        Name = "RvtGo game thread",
                        IsBackground = true
                    };
                    _thread.SetApartmentState(ApartmentState.STA);
                    _thread.Start();
                    return true;
                }
                catch (Exception ex)
                {
                    Utilities.Log_Utils.Write($"Game thread failed to start: {ex}");
                    _running = false;
                    return false;
                }
            }
        }

        /// <summary>
        /// Brings the running session's window to the front.
        /// </summary>
        public static void BringToFront() => _window?.RequestFocus();

        /// <summary>
        /// Asks the session to close and waits briefly (Revit shutdown).
        /// </summary>
        public static void RequestShutdown(int waitMilliseconds)
        {
            Thread thread = _thread;
            if (!_running || thread == null) { return; }
            _window?.RequestClose();
            try { thread.Join(waitMilliseconds); }
            catch { /* shutting down regardless */ }
        }

        /// <summary>
        /// The game thread body. Every exception is caught here: an unhandled exception on a
        /// background thread would take Revit down with it.
        /// </summary>
        private static void RunSession(SceneData scene)
        {
            GameWindow window = null;
            GameSession session = null;
            try
            {
                Utilities.Log_Utils.Write($"Session starting: {scene.ModelTitle}");
                window = new GameWindow($"RvtGo — {scene.ModelTitle} (loading)");
                _window = window;

                session = new GameSession(window, scene);
                session.Run();
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Session crashed: {ex}");
                Win32.MessageBoxW(window?.Handle ?? 0,
                    $"RvtGo stopped unexpectedly:\n\n{ex.Message}\n\nDetails were written to:\n{Utilities.Log_Utils.LogPath}",
                    "RvtGo", Win32.MB_OK | Win32.MB_ICONERROR);
            }
            finally
            {
                try { session?.Dispose(); }
                catch (Exception ex) { Utilities.Log_Utils.Write($"Session cleanup failed: {ex.Message}"); }

                try { window?.Dispose(); }
                catch (Exception ex) { Utilities.Log_Utils.Write($"Window cleanup failed: {ex.Message}"); }

                _window = null;
                _running = false;
                Utilities.Log_Utils.Write("Session ended.");
            }
        }
    }
}
