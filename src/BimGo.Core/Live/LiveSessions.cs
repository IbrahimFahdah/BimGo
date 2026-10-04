// The class belongs to the Live namespace
namespace BimGo.Live
{
    /// <summary>
    /// Reading, writing, discovering and cleaning up session folders. Never throws.
    /// </summary>
    public static class LiveSessions
    {
        /// <summary>
        /// Reads a session's session.json, or null.
        /// </summary>
        public static SessionInfo ReadInfo(string sessionId)
        {
            if (!LiveProtocol.IsValidSessionId(sessionId)) { return null; }
            return LiveProtocol.ReadJson<SessionInfo>(LiveProtocol.InfoPath(sessionId), LiveProtocol.JSON_INDENTED);
        }

        /// <summary>
        /// Writes a session's session.json (Revit side).
        /// </summary>
        /// <returns>True on success.</returns>
        public static bool WriteInfo(SessionInfo info)
        {
            try
            {
                LiveProtocol.WriteJsonAtomic(LiveProtocol.InfoPath(info.SessionId), info, LiveProtocol.JSON_INDENTED);
                return true;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"session.json could not be written: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Reads the attached app's heartbeat, or null if no app is attached.
        /// </summary>
        public static AppAttachment ReadAttachment(string sessionId)
        {
            if (!LiveProtocol.IsValidSessionId(sessionId)) { return null; }
            return LiveProtocol.ReadJson<AppAttachment>(LiveProtocol.AttachmentPath(sessionId), LiveProtocol.JSON_INDENTED);
        }

        /// <summary>
        /// Writes the app's heartbeat (app side).
        /// </summary>
        public static void WriteAttachment(string sessionId, AppAttachment attachment)
        {
            try
            {
                LiveProtocol.WriteJsonAtomic(LiveProtocol.AttachmentPath(sessionId), attachment, LiveProtocol.JSON_INDENTED);
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"app.json could not be written: {ex.Message}");
            }
        }

        /// <summary>
        /// Removes the app's heartbeat (app side, on detach).
        /// </summary>
        public static void DeleteAttachment(string sessionId)
        {
            try
            {
                string path = LiveProtocol.AttachmentPath(sessionId);
                if (File.Exists(path)) { File.Delete(path); }
            }
            catch
            {
                // Revit treats a stale heartbeat as detached anyway
            }
        }

        /// <summary>
        /// The sessions whose Revit is alive, newest first.
        /// </summary>
        public static List<SessionInfo> ListAlive()
        {
            var sessions = new List<SessionInfo>();
            try
            {
                if (!Directory.Exists(LiveProtocol.SessionsRoot)) { return sessions; }
                foreach (string folder in Directory.EnumerateDirectories(LiveProtocol.SessionsRoot))
                {
                    string id = Path.GetFileName(folder);
                    SessionInfo info = ReadInfo(id);
                    if (info != null && info.Protocol <= LiveProtocol.VERSION && info.IsAlive()) { sessions.Add(info); }
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Session discovery failed: {ex.Message}");
            }
            return sessions.OrderByDescending(s => s.CreatedUtc).ToList();
        }

        /// <summary>
        /// Deletes session folders that are closed or whose heartbeat is older than <see cref="LiveProtocol.STALE_AFTER"/>
        /// (Revit crashed or was killed). Folders of running Revit processes are kept.
        /// </summary>
        public static void CleanupStale()
        {
            try
            {
                if (!Directory.Exists(LiveProtocol.SessionsRoot)) { return; }
                foreach (string folder in Directory.EnumerateDirectories(LiveProtocol.SessionsRoot))
                {
                    string id = Path.GetFileName(folder);
                    if (!LiveProtocol.IsValidSessionId(id)) { continue; }

                    SessionInfo info = ReadInfo(id);
                    DateTime last = info?.HeartbeatUtc ?? Directory.GetLastWriteTimeUtc(folder);
                    bool closed = info?.State == SessionStates.CLOSED && (DateTime.UtcNow - last).TotalMinutes > 5;
                    bool stale = DateTime.UtcNow - last > LiveProtocol.STALE_AFTER && !(info != null && LiveProtocol.IsProcessAlive(info.RevitPid));
                    if (!closed && !stale) { continue; }

                    try
                    {
                        Directory.Delete(folder, recursive: true);
                        Utilities.Log_Utils.Write($"Removed stale session folder {id}.");
                    }
                    catch
                    {
                        // In use (an app still reading a snapshot): next time
                    }
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Session cleanup failed: {ex.Message}");
            }
        }
    }
}
