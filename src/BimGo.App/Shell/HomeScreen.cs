using System.Diagnostics;
using BimGo.Format;
using BimGo.Game;
using BimGo.Live;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;
using Gl = BimGo.Native.Gl;

// The class belongs to the Shell namespace
namespace BimGo.Shell
{
    /// <summary>
    /// The app's start screen, drawn in the game window with the same immediate-mode UI as the HUD:
    /// join a live Revit session, open a .bimgo, pick a recent file, or drop a file on the window.
    /// </summary>
    internal sealed class HomeScreen
    {
        #region Fields

        private readonly GameWindow _window;
        private readonly UiBatch _ui;
        private readonly RecentFiles _recent;
        private readonly AppInstance _instance;
        private readonly Dictionary<string, RecentInfo> _infos = new(StringComparer.OrdinalIgnoreCase);

        // Recent files' thumbnails as GL textures (0 = none or unreadable); freed when the screen is left
        private readonly Dictionary<string, uint> _thumbnails = new(StringComparer.OrdinalIgnoreCase);
        private LastLiveSession _lastLive;
        private List<SessionInfo> _sessions = new();
        private float _sessionScan;
        private bool _quit;
        private float _clock;

        #endregion

        /// <summary>
        /// Creates the screen.
        /// </summary>
        public HomeScreen(GameWindow window, UiBatch ui, RecentFiles recent, AppInstance instance)
        {
            _window = window;
            _ui = ui;
            _recent = recent;
            _instance = instance;
        }

        /// <summary>A message shown under the buttons (e.g. why a file could not be opened), or null.</summary>
        public string Message { get; set; }

        /// <summary>True when <see cref="Message"/> is an error (shown in red).</summary>
        public bool MessageIsError { get; set; }

        private float S(float value) => value * _ui.Scale;

        #region Loop

        /// <summary>
        /// Runs until the user picks a file or closes the window.
        /// </summary>
        /// <returns>A file or live session to open, or null to quit.</returns>
        public OpenTarget Run()
        {
            _sessionScan = float.MaxValue; // list sessions straight away
            _quit = false;
            _infos.Clear();
            _lastLive = LastLiveSession.Load();
            try
            {
                return RunLoop();
            }
            finally
            {
                ReleaseThumbnails();
            }
        }

        /// <summary>The screen's loop (see <see cref="Run"/>).</summary>
        private OpenTarget RunLoop()
        {
            _window.SetTitle("BimGo");
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            Native.Wgl.SetSwapInterval(true);

            var clock = Stopwatch.StartNew();
            double previous = 0;
            float poll = 0f;

            while (_window.PumpMessages())
            {
                double now = clock.Elapsed.TotalSeconds;
                float dt = (float)Math.Min(now - previous, 0.1);
                previous = now;
                _clock += dt;

                // Files dropped on the window, and requests from other instances / Revit
                if (_window.TryTakeDroppedFile(out string dropped))
                {
                    if (BimGoFormat.HasExtension(dropped)) { return OpenTarget.File(dropped); }
                    SetMessage($"{Path.GetFileName(dropped)} is not a .bimgo file.", error: true);
                }
                poll += dt;
                if (poll >= 1f)
                {
                    poll = 0f;
                    OpenTarget requested = _instance?.TakeRequest();
                    if (requested != null) { return requested; }
                }

                if (_window.IsMinimised)
                {
                    _window.Input.EndFrame();
                    Thread.Sleep(50);
                    continue;
                }

                // Live Revit sessions (session.json heartbeats), every couple of seconds
                _sessionScan += dt;
                if (_sessionScan >= LiveProtocol.HEARTBEAT_SECONDS)
                {
                    _sessionScan = 0f;
                    _sessions = LiveSessions.ListAlive();
                }

                InputState input = _window.Input;
                OpenTarget chosen = null;
                if (input.Pressed(InputAction.OpenFile)) { chosen = FileTarget(BrowseForFile()); }

                chosen ??= Draw(input);
                _window.Swap();
                input.EndFrame();

                if (chosen != null) { return chosen; }
                if (_quit) { return null; }
            }
            return null;
        }

        /// <summary>
        /// Shows a status line on an otherwise empty frame (used while loading a file).
        /// </summary>
        public void DrawStatus(string title, string message)
        {
            BeginFrame();
            FontAtlas f = _ui.Atlas;
            float cx = _window.Width * 0.5f, cy = _window.Height * 0.5f;
            _ui.TextCentred(f.Title, cx, cy - S(40), "BIMGO", UiTheme.TEXT, S(4));
            _ui.TextCentred(f.Bold, cx, cy + S(14), title, UiTheme.TEXT, S(0.5f));
            _ui.TextCentred(f.Body, cx, cy + S(42), message, UiTheme.TEXT_MUTED);
            _ui.Flush(_window.Width, _window.Height);
            _window.Swap();
            _window.PumpMessages();
        }

        /// <summary>
        /// Sets the message line.
        /// </summary>
        public void SetMessage(string message, bool error)
        {
            Message = message;
            MessageIsError = error;
        }

        #endregion

        #region Drawing

        private void BeginFrame()
        {
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);
            Gl.Viewport(0, 0, _window.Width, _window.Height);
            Gl.ClearColor(0.063f, 0.075f, 0.094f, 1f);
            Gl.Clear(Gl.COLOR_BUFFER_BIT | Gl.DEPTH_BUFFER_BIT);
        }

        /// <summary>
        /// Draws the screen and handles clicks.
        /// </summary>
        /// <returns>What to open, or null.</returns>
        private OpenTarget Draw(InputState input)
        {
            BeginFrame();
            FontAtlas f = _ui.Atlas;
            int width = _window.Width, height = _window.Height;
            OpenTarget chosen = null;

            float pad = S(56);
            float leftX = pad, leftW = S(300);
            float rightX = leftX + leftW + S(56), rightW = MathF.Max(S(320), width - rightX - pad);

            // ---- Left: title, actions, hints
            float y = pad;
            float titleWidth = _ui.Text(f.Title, leftX, y, "BIMGO", UiTheme.TEXT, S(4));
            DrawLogo(leftX + titleWidth + S(14), y + f.Title.LineHeight * 0.5f, f.Title.LineHeight * 0.62f);
            y += S(56);
            _ui.Text(f.Body, leftX, y, "First-person BIM walkthroughs", UiTheme.TEXT_MUTED);
            y += S(44);

            if (Button(f, input, leftX, y, leftW, "OPEN .BIMGO…", primary: true)) { chosen = FileTarget(BrowseForFile()); }
            y += S(58);
            if (Button(f, input, leftX, y, leftW, "QUIT", primary: false)) { _quit = true; }
            y += S(72);

            if (!string.IsNullOrEmpty(Message))
            {
                float used = _ui.TextWrapped(f.Body, leftX, y, leftW, Message, MessageIsError ? UiTheme.DANGER : UiTheme.GOOD, maxLines: 5);
                y += used + S(20);
            }

            _ui.Text(f.Small, leftX, y, "GET A MODEL", UiTheme.TEXT_MUTED, S(1.6f));
            y += S(22);
            y += _ui.TextWrapped(f.Body, leftX, y, leftW, "In Revit: BimGo tab → Export .bimgo. Then open it here, double-click it, or drop it on this window.", UiTheme.TEXT_SOFT, maxLines: 6);
            y += S(18);
            _ui.Text(f.Small, leftX, y, "WALK A MODEL LIVE", UiTheme.TEXT_MUTED, S(1.6f));
            y += S(22);
            _ui.TextWrapped(f.Body, leftX, y, leftW, "In Revit: BimGo tab → Go. The model opens here and your edits go back to Revit. Running sessions are listed on the right.", UiTheme.TEXT_SOFT, maxLines: 6);

            // ---- Right: live sessions (and the last one, greyed, when it isn't running), then recent files
            float top = pad;
            bool lastLive = _lastLive != null && !_lastLive.IsRunningIn(_sessions);
            if (_sessions.Count > 0 || lastLive)
            {
                // Always drawn (not "??="): a short-circuit would skip the panel and leave 'used' unassigned
                OpenTarget session = DrawSessions(f, input, rightX, top, rightW, lastLive, out float used);
                chosen ??= session;
                top += used + S(18);
            }
            chosen ??= DrawRecent(f, input, rightX, top, rightW, height - pad - top);

            // Footer
            _ui.TextRight(f.Small, width - pad, height - S(30), "BimGo " + Program.Version + " · Ctrl+O open · drop a .bimgo here · Go in Revit to walk live", UiTheme.TEXT_FAINT, S(0.5f));
            _ui.Flush(width, height);
            return chosen;
        }

        /// <summary>
        /// Running Revit sessions (Go pressed): click joins.
        /// </summary>
        /// <param name="used">Height drawn.</param>
        private OpenTarget DrawSessions(FontAtlas f, InputState input, float x, float top, float width, bool lastLive, out float used)
        {
            _ui.Text(f.Small, x, top + S(6), _sessions.Count > 0 ? "LIVE REVIT SESSIONS" : "LAST LIVE SESSION", _sessions.Count > 0 ? UiTheme.ACCENT : UiTheme.TEXT_MUTED, S(1.8f));
            float y = top + S(32);
            float row = S(58);
            OpenTarget chosen = null;

            foreach (SessionInfo session in _sessions.Take(4))
            {
                bool hover = Hover(input, x, y, width, row);
                _ui.Panel(x, y, width, row, hover ? Rgba.Hex(0x22D3EE, 0.10f) : UiTheme.CARD, hover ? UiTheme.ACCENT : Rgba.WithAlpha(UiTheme.ACCENT, 0.35f));
                _ui.Circle(x + S(18), y + S(18), S(4), UiTheme.GOOD);
                _ui.TextWrapped(f.Bold, x + S(30), y + S(9), width - S(200), string.IsNullOrWhiteSpace(session.DocTitle) ? "Revit model" : session.DocTitle, UiTheme.TEXT, maxLines: 1);
                _ui.TextRight(f.Small, x + width - S(16), y + S(12), "REVIT " + session.RevitVersion, UiTheme.TEXT_MUTED, S(0.5f));

                string snapshot = session.SnapshotNumber > 0
                    ? $"Snapshot {session.SnapshotNumber} · {session.SnapshotUtc.ToLocalTime():HH:mm}"
                    : "Waiting for a snapshot";
                string phase = string.IsNullOrEmpty(session.PhaseName) ? string.Empty
                    : string.IsNullOrEmpty(session.ExistingPhaseName) ? $" · {session.PhaseName}" : $" · {session.ExistingPhaseName} → {session.PhaseName}";
                _ui.TextWrapped(f.Body, x + S(16), y + S(32), width - S(32), $"{snapshot}{phase} · click to join", UiTheme.TEXT_MUTED, maxLines: 1);

                if (hover && input.LeftPressed)
                {
                    input.ConsumeClicks();
                    chosen = OpenTarget.Live(session.SessionId);
                }
                y += row + S(8);
            }

            // The last model walked live, greyed: it can't be joined from here (Revit starts sessions)
            if (lastLive)
            {
                bool hover = Hover(input, x, y, width, row);
                _ui.Panel(x, y, width, row, UiTheme.CARD, Rgba.Hex(0xFFFFFF, hover ? 0.18f : 0.08f));
                _ui.Ring(x + S(18), y + S(18), S(4), S(1.5f), UiTheme.TEXT_FAINT);
                _ui.TextWrapped(f.Bold, x + S(30), y + S(9), width - S(200), string.IsNullOrWhiteSpace(_lastLive.DocTitle) ? Path.GetFileName(_lastLive.DocPath) : _lastLive.DocTitle, UiTheme.TEXT_FAINT, maxLines: 1);
                if (!string.IsNullOrEmpty(_lastLive.RevitVersion)) { _ui.TextRight(f.Small, x + width - S(16), y + S(12), "REVIT " + _lastLive.RevitVersion, UiTheme.TEXT_FAINT, S(0.5f)); }
                string when = _lastLive.LastUsedUtc == default ? string.Empty : $"Last walked {_lastLive.LastUsedUtc.ToLocalTime():dd MMM HH:mm} · ";
                _ui.TextWrapped(f.Body, x + S(16), y + S(32), width - S(32), when + "open it in Revit and press Go", UiTheme.TEXT_FAINT, maxLines: 1);
                if (hover && input.LeftPressed)
                {
                    input.ConsumeClicks();
                    SetMessage($"{_lastLive.DocTitle} isn't running in Revit: open it there and press Go (BimGo tab).", error: false);
                }
                y += row + S(8);
            }

            used = y - top;
            return chosen;
        }

        /// <summary>
        /// The recent files list: a card per file with its thumbnail (saved since the review tools round), title,
        /// details, and SHOW IN FOLDER / REMOVE; click opens, right-click removes from the list too.
        /// </summary>
        private OpenTarget DrawRecent(FontAtlas f, InputState input, float x, float top, float width, float height)
        {
            _ui.Text(f.Small, x, top + S(6), "RECENT", UiTheme.TEXT_MUTED, S(1.8f));
            float y = top + S(32);
            float row = S(84);

            if (_recent.Entries.Count == 0)
            {
                _ui.Panel(x, y, width, S(70), UiTheme.CARD, UiTheme.CARD_BORDER);
                _ui.Text(f.Body, x + S(16), y + S(25), "No recent files yet.", UiTheme.TEXT_MUTED);
                return null;
            }

            OpenTarget chosen = null;
            string remove = null;
            int visible = Math.Max(1, (int)((height - S(32)) / (row + S(8))));
            foreach (RecentFile entry in _recent.Entries.Take(visible))
            {
                if (!_infos.TryGetValue(entry.Path, out RecentInfo info))
                {
                    info = RecentInfo.For(entry.Path);
                    _infos[entry.Path] = info;
                }

                bool hover = Hover(input, x, y, width, row);
                _ui.Panel(x, y, width, row, hover && info.Exists ? Rgba.Hex(0xFFFFFF, 0.06f) : UiTheme.CARD, hover ? UiTheme.ACCENT : UiTheme.CARD_BORDER);

                // Thumbnail (16:9), or a placeholder with the BimGo mark
                float thumbH = row - S(16), thumbW = thumbH * 16f / 9f;
                float tx = x + S(8), ty = y + S(8);
                uint texture = ThumbnailTexture(entry.Path, info.Thumbnail);
                if (texture != 0)
                {
                    _ui.Image(texture, tx, ty, thumbW, thumbH, _window.Width, _window.Height, info.Exists ? 0xFFFFFFFF : Rgba.Hex(0xFFFFFF, 0.4f));
                    _ui.Outline(tx, ty, thumbW, thumbH, MathF.Max(1f, _ui.Scale), Rgba.Hex(0xFFFFFF, 0.12f));
                }
                else
                {
                    _ui.Panel(tx, ty, thumbW, thumbH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
                    DrawLogo(tx + thumbW * 0.5f - thumbH * 0.27f, ty + thumbH * 0.5f, thumbH * 0.38f, Rgba.WithAlpha(UiTheme.ACCENT, 0.35f));
                }

                float textX = tx + thumbW + S(14), textW = x + width - textX - S(16);
                uint titleColour = info.Exists ? UiTheme.TEXT : UiTheme.TEXT_FAINT;
                _ui.TextWrapped(f.Bold, textX, y + S(10), textW - S(150), info.Title, titleColour, maxLines: 1);
                _ui.TextRight(f.Small, x + width - S(16), y + S(13), entry.LastUsedUtc.ToLocalTime().ToString("dd MMM yyyy HH:mm"), UiTheme.TEXT_MUTED, S(0.5f));

                string folder = Path.GetDirectoryName(entry.Path) ?? string.Empty;
                string detail = $"{Path.GetFileName(entry.Path)} · {info.Detail}";
                _ui.TextWrapped(f.Body, textX, y + S(33), textW, detail, info.Exists ? UiTheme.TEXT_MUTED : UiTheme.DANGER, maxLines: 1);

                // Bottom line: the folder, then SHOW IN FOLDER and REMOVE (shown brighter on hover)
                float linkY = y + row - S(24);
                float removeW = UiBatch.Measure(f.Small, "REMOVE FROM LIST", S(0.6f)) + S(8);
                float showW = UiBatch.Measure(f.Small, "SHOW IN FOLDER", S(0.6f)) + S(8);
                float removeX = x + width - S(16) - removeW, showX = removeX - S(14) - showW;
                _ui.TextWrapped(f.Small, textX, linkY + S(2), MathF.Max(S(40), showX - textX - S(12)), folder, UiTheme.TEXT_FAINT, maxLines: 1);
                bool showHover = info.Exists && Hover(input, showX, linkY - S(2), showW, S(20));
                bool removeHover = Hover(input, removeX, linkY - S(2), removeW, S(20));
                if (info.Exists)
                {
                    _ui.Text(f.Small, showX + S(4), linkY + S(2), "SHOW IN FOLDER", showHover ? UiTheme.ACCENT : hover ? UiTheme.TEXT_SOFT : UiTheme.TEXT_FAINT, S(0.6f));
                }
                _ui.Text(f.Small, removeX + S(4), linkY + S(2), "REMOVE FROM LIST", removeHover ? UiTheme.DANGER : hover ? UiTheme.TEXT_SOFT : UiTheme.TEXT_FAINT, S(0.6f));

                if (hover && input.LeftPressed)
                {
                    input.ConsumeClicks();
                    if (removeHover) { remove = entry.Path; }
                    else if (showHover) { ShowInFolder(entry.Path); }
                    else if (info.Exists) { chosen = OpenTarget.File(entry.Path); }
                    else { SetMessage($"{Path.GetFileName(entry.Path)} was not found. REMOVE FROM LIST takes it off.", error: true); }
                }
                else if (hover && input.RightPressed)
                {
                    remove = entry.Path;
                }
                y += row + S(8);
            }

            if (remove != null)
            {
                _recent.Remove(remove);
                _infos.Remove(remove);
                if (_thumbnails.Remove(remove, out uint texture) && texture != 0) { Gl.DeleteTexture(texture); }
            }
            return chosen;
        }

        /// <summary>
        /// Opens Explorer with the file selected (failures go to the message line).
        /// </summary>
        private void ShowInFolder(string path)
        {
            try
            {
                Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Show in folder failed: {ex.Message}");
                SetMessage($"The folder could not be opened: {ex.Message}", error: true);
            }
        }

        /// <summary>
        /// A recent file's thumbnail as a GL texture (decoded once; 0 when it has none or it is unreadable).
        /// </summary>
        private unsafe uint ThumbnailTexture(string path, byte[] data)
        {
            if (_thumbnails.TryGetValue(path, out uint cached)) { return cached; }
            uint texture = 0;
            if (data != null && data.Length > 0)
            {
                try
                {
                    using var stream = new MemoryStream(data);
                    using var decoded = new System.Drawing.Bitmap(stream);
                    using var bitmap = new System.Drawing.Bitmap(decoded.Width, decoded.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                    using (var graphics = System.Drawing.Graphics.FromImage(bitmap)) { graphics.DrawImage(decoded, 0, 0, decoded.Width, decoded.Height); }
                    System.Drawing.Imaging.BitmapData bits = bitmap.LockBits(new System.Drawing.Rectangle(0, 0, bitmap.Width, bitmap.Height),
                        System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                    try
                    {
                        texture = Gl.GenTexture();
                        Gl.BindTexture(Gl.TEXTURE_2D, texture);
                        Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)Gl.LINEAR);
                        Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)Gl.LINEAR);
                        Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
                        Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
                        Gl.PixelStore(Gl.UNPACK_ALIGNMENT, 4);
                        Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA8, bitmap.Width, bitmap.Height, Gl.BGRA, Gl.UNSIGNED_BYTE, (void*)bits.Scan0);
                        Gl.BindTexture(Gl.TEXTURE_2D, 0);
                    }
                    finally
                    {
                        bitmap.UnlockBits(bits);
                    }
                }
                catch (Exception ex)
                {
                    Utilities.Log_Utils.Write($"Recent thumbnail unreadable ({Path.GetFileName(path)}): {ex.Message}");
                    if (texture != 0) { Gl.DeleteTexture(texture); }
                    texture = 0;
                }
            }
            _thumbnails[path] = texture;
            return texture;
        }

        /// <summary>Frees the thumbnail textures (leaving the screen: the walkthrough gets the memory).</summary>
        private void ReleaseThumbnails()
        {
            foreach (uint texture in _thumbnails.Values)
            {
                if (texture != 0) { Gl.DeleteTexture(texture); }
            }
            _thumbnails.Clear();
        }

        /// <summary>
        /// The BimGo ">>" mark (the app icon's chevrons), centred vertically on <paramref name="cy"/>.
        /// </summary>
        private void DrawLogo(float x, float cy, float height) => DrawLogo(x, cy, height, UiTheme.ACCENT);

        /// <summary>The ">>" mark in a given colour.</summary>
        private void DrawLogo(float x, float cy, float height, uint colour)
        {
            float half = height * 0.5f, width = height * 0.5f, thickness = MathF.Max(2f, height * 0.16f);
            for (int i = 0; i < 2; i++)
            {
                float x0 = x + i * width * 1.05f;
                _ui.Line(x0, cy - half, x0 + width, cy, thickness, colour);
                _ui.Line(x0 + width, cy, x0, cy + half, thickness, colour);
            }
        }

        /// <summary>
        /// A full-width button.
        /// </summary>
        private bool Button(FontAtlas f, InputState input, float x, float y, float w, string label, bool primary)
        {
            float h = S(48);
            bool hover = Hover(input, x, y, w, h);
            if (primary)
            {
                _ui.Rect(x, y, w, h, hover ? Rgba.Hex(0x67E8F9) : UiTheme.ACCENT);
            }
            else
            {
                _ui.Rect(x, y, w, h, hover ? Rgba.Hex(0xFFFFFF, 0.08f) : Rgba.Hex(0xFFFFFF, 0f));
                _ui.Outline(x, y, w, h, MathF.Max(1f, _ui.Scale), Rgba.Hex(0xFFFFFF, 0.2f));
            }
            _ui.Text(f.Bold, x + S(16), y + h * 0.5f - f.Bold.LineHeight * 0.5f, label, primary ? Rgba.Hex(0x06232A) : UiTheme.TEXT, S(1.3f));

            bool clicked = hover && input.LeftPressed;
            if (clicked) { input.ConsumeClicks(); }
            return clicked;
        }

        private static bool Hover(InputState input, float x, float y, float w, float h)
        {
            System.Numerics.Vector2 m = input.MousePosition;
            return m.X >= x && m.X < x + w && m.Y >= y && m.Y < y + h;
        }

        #endregion

        private static OpenTarget FileTarget(string path) => path == null ? null : OpenTarget.File(path);

        /// <summary>
        /// The Open dialog, starting in the most recent file's folder.
        /// </summary>
        private string BrowseForFile()
        {
            string folder = null;
            try
            {
                string last = _recent.Entries.FirstOrDefault()?.Path;
                if (!string.IsNullOrEmpty(last)) { folder = Path.GetDirectoryName(last); }
            }
            catch
            {
                // No starting folder
            }
            _window.Input.ReleaseAll();
            return FileDialogs.ShowOpen(_window.Handle, "Open BimGo model", BimGoFormat.DIALOG_FILTER, folder);
        }
    }
}
