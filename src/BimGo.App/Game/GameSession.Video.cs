using System.Diagnostics;
using BimGo.Audio;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;
using Gl = BimGo.Native.Gl;
using Vk = BimGo.Native.Win32;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Walkthrough video (tour round, build A2): BOOKMARKS → TOUR SETTINGS → RECORD VIDEO renders the bookmark tour to
    /// an MP4 (H.264, Windows Media Foundation) with its fades, holds, swivels and glides, and its UI setting.
    /// <list type="bullet">
    /// <item>Frames are rendered off-screen at a fixed rate (the tour clock steps 1 / fps per frame), not in real
    /// time, so the video is smooth on any PC; as many frames as fit in ~45 ms are rendered per window frame.</item>
    /// <item>Each frame: the scene (photo path: no markers, highlights or gizmos), then with the UI on the HUD drawn at
    /// the video's height (a second UI batch at a matching scale), then the fade; read back and encoded on a worker
    /// (<see cref="VideoRecorder"/>).</item>
    /// <item>The window shows the frames as they come (letterboxed) with progress, time left and CANCEL (Esc).
    /// Cancelling deletes the file. The result goes to Videos\BimGo; the tour settings show OPEN FOLDER.</item>
    /// </list>
    /// Size (window / 1080p / 4K) and rate (30 / 60) are per-machine settings.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private static readonly string[] VIDEO_SIZE_OPTIONS = { "Window", "1080p", "4K" };
        private static readonly string[] VIDEO_FPS_OPTIONS = { "30 fps", "60 fps" };

        /// <summary>Milliseconds of video rendering per window frame (the window stays responsive).</summary>
        private const int VIDEO_BUDGET_MS = 45;

        private VideoSize _videoSize = VideoSize.FullHd;
        private int _videoFps = 30;

        // A recording in progress (null otherwise)
        private VideoRecorder _video;
        private int _videoWidth, _videoHeight, _videoSamples;
        private int _videoFrame, _videoFrames;
        private bool _videoFinishing;
        private RenderTarget _videoTarget, _videoResolve;
        private UiBatch _videoUi;
        private float _videoUiScale;
        private Stopwatch _videoClock;
        private string _videoHeader;
        private string _videoLastPath;

        #endregion

        /// <summary>True while a video is being recorded (or its file finished).</summary>
        private bool IsRecordingVideo => _video != null;

        /// <summary>Videos\BimGo.</summary>
        private static string VideoFolder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "BimGo");

        #region Settings

        private void ReadVideoSettings(LaunchSettings settings)
        {
            _videoSize = Enum.IsDefined(settings.VideoSize) ? settings.VideoSize : VideoSize.FullHd;
            _videoFps = settings.VideoFps >= 45 ? 60 : 30;
        }

        private void WriteVideoSettings(LaunchSettings settings)
        {
            settings.VideoSize = _videoSize;
            settings.VideoFps = _videoFps;
        }

        /// <summary>The frame size for the current setting (even numbers).</summary>
        private void VideoFrameSize(out int width, out int height)
        {
            switch (_videoSize)
            {
                case VideoSize.Uhd4K: width = 3840; height = 2160; break;
                case VideoSize.Window: width = Math.Max(2, _window.Width & ~1); height = Math.Max(2, _window.Height & ~1); break;
                default: width = 1920; height = 1080; break;
            }
        }

        #endregion

        #region Start / finish

        /// <summary>
        /// RECORD VIDEO: starts the tour and a recording of it.
        /// </summary>
        private void StartVideo()
        {
            if (_video != null || _tourActive) { return; }
            VideoFrameSize(out int width, out int height);
            int max = Gl.GetInteger(Gl.MAX_RENDERBUFFER_SIZE);
            if (max > 0 && (width > max || height > max))
            {
                _bookmarksNotice = $"This graphics card can't render {width} × {height} frames (its limit is {max} px): pick a smaller size";
                Sound.Play(SoundId.Error);
                return;
            }
            if (!StartTour()) { return; }

            _videoWidth = width;
            _videoHeight = height;
            _videoFrame = 0;
            _videoFrames = Math.Max(1, (int)Math.Ceiling(_tour.Duration * _videoFps));
            _videoFinishing = false;
            long pixels = (long)width * height;
            _videoSamples = _msaa > 0 && pixels * _msaa <= PHOTO_SAMPLE_BUDGET ? _msaa : pixels * 2 <= PHOTO_SAMPLE_BUDGET && _msaa > 0 ? 2 : 0;

            if (_tourRun.ShowUi)
            {
                // The HUD at the video's height: its own UI batch (fonts rasterised at that scale)
                _videoUiScale = UiScale * height / Math.Max(1f, _window.Height);
                _videoUi = new UiBatch();
                _videoUi.Initialise(_videoUiScale);
            }

            string name = SafeFileName(Path.GetFileNameWithoutExtension(DocumentName)) + " tour " +
                DateTime.Now.ToString("yyyy-MM-dd HHmmss", System.Globalization.CultureInfo.InvariantCulture) + ".mp4";
            string path = Path.Combine(VideoFolder, name);
            int bitrate = (int)Math.Clamp(pixels * _videoFps / 5, 4_000_000L, 80_000_000L); // ~0.2 bits per pixel
            _video = new VideoRecorder(path, width, height, _videoFps, bitrate);
            _videoClock = Stopwatch.StartNew();
            _videoHeader = $"RECORDING VIDEO · {width} × {height} · {_videoFps} FPS · {FormatClock(_tour.Duration)}";
            _window.SetCaptured(false); // CANCEL is clickable
            Utilities.Log_Utils.Write($"Video: {path}, {width}x{height} @ {_videoFps} fps, {_videoFrames} frames, {bitrate / 1_000_000.0:0.0} Mb/s, MSAA {_videoSamples}, UI {_tourRun.ShowUi}.");
        }

        /// <summary>
        /// Per window frame while recording (instead of the tour's keys): Esc cancels; a finished or failed recording
        /// ends here.
        /// </summary>
        private void UpdateVideo(InputState input)
        {
            if (input.IsPressed(Vk.VK_ESCAPE))
            {
                CancelVideo();
                return;
            }
            if (input.IsPressed(Vk.VK_F11)) { _window.ToggleFullscreen(); }
            if (_video.Error != null && !_videoFinishing)
            {
                _video.Cancel();
                _videoFinishing = true;
            }
            if (_videoFinishing && _video.IsFinished) { FinishVideo(); }
        }

        /// <summary>Esc / CANCEL: stops the recording; the partial file is deleted.</summary>
        private void CancelVideo()
        {
            if (_video == null) { return; }
            _video.Cancel();
            EndVideo("Recording cancelled (the partial file was deleted)");
        }

        /// <summary>The worker is done: report the file (or the error) and go back to the tour settings.</summary>
        private void FinishVideo()
        {
            string error = _video.Error;
            string path = _video.Path;
            if (error == null && File.Exists(path))
            {
                _videoLastPath = path;
                double seconds = _videoClock.Elapsed.TotalSeconds;
                Utilities.Log_Utils.Write($"Video saved: {path} ({_video.Written} frames in {seconds:0.0} s).");
                EndVideo($"Saved {Path.GetFileName(path)} ({_videoWidth} × {_videoHeight}, {_videoFps} fps, {FormatClock(_videoFrames / (float)_videoFps)}) · OPEN FOLDER shows it");
                Sound.Play(SoundId.Commit);
            }
            else
            {
                EndVideo("The video couldn't be made: " + (error ?? "the file is missing"));
                Sound.Play(SoundId.Error);
            }
        }

        /// <summary>
        /// Releases the recorder and the video's targets, ends the tour (the walkthrough comes back as it was) and
        /// opens the tour settings with a notice.
        /// </summary>
        private void EndVideo(string notice)
        {
            try { _video?.Dispose(); }
            catch (Exception ex) { Utilities.Log_Utils.Write($"Video recorder cleanup failed: {ex.Message}"); }
            _video = null;
            _videoFinishing = false;
            _videoTarget?.Dispose();
            _videoResolve?.Dispose();
            _videoTarget = _videoResolve = null;
            _videoUi?.Dispose();
            _videoUi = null;

            StopTour(finished: true);
            _toast = null;
            SetPaused(true);
            OpenBookmarks();
            _tourSettingsOpen = true;
            _tourDraft = Bookmarks.Tour.Copy();
            _bookmarksNotice = notice;
        }

        /// <summary>
        /// Stops a recording without the menu (the window is closing): the partial file is deleted.
        /// </summary>
        private void AbortVideo()
        {
            if (_video == null) { return; }
            try
            {
                _video.Cancel();
                _video.Dispose();
            }
            catch (Exception ex) { Utilities.Log_Utils.Write($"Video abort failed: {ex.Message}"); }
            _video = null;
            _videoFinishing = false;
            _videoTarget?.Dispose();
            _videoResolve?.Dispose();
            _videoTarget = _videoResolve = null;
            _videoUi?.Dispose();
            _videoUi = null;
        }

        /// <summary>OPEN FOLDER: Explorer with the last video selected (or the folder).</summary>
        private void OpenVideoFolder()
        {
            try
            {
                Directory.CreateDirectory(VideoFolder);
                string last = _videoLastPath;
                var start = new ProcessStartInfo("explorer.exe",
                    last != null && File.Exists(last) ? $"/select,\"{last}\"" : $"\"{VideoFolder}\"") { UseShellExecute = true };
                Process.Start(start);
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Video folder not opened: {ex.Message}");
                _bookmarksNotice = "The folder could not be opened";
            }
        }

        #endregion

        #region Rendering

        /// <summary>
        /// The window frame while recording: render video frames for up to <see cref="VIDEO_BUDGET_MS"/>, then show
        /// the last one with the progress panel.
        /// </summary>
        private void RenderVideo()
        {
            int width = _window.Width, height = _window.Height;
            if (!_videoFinishing && _video.Error == null)
            {
                long start = Stopwatch.GetTimestamp();
                while (!_videoFinishing && RenderVideoFrame())
                {
                    if (Stopwatch.GetElapsedTime(start).TotalMilliseconds >= VIDEO_BUDGET_MS) { break; }
                }
            }

            if (_videoResolve != null && _videoResolve.IsValid) { _videoResolve.BlitToWindowFit(width, height); }
            else
            {
                Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);
                Gl.Viewport(0, 0, width, height);
                Gl.ClearColor(0f, 0f, 0f, 1f);
                Gl.Clear(Gl.COLOR_BUFFER_BIT | Gl.DEPTH_BUFFER_BIT);
            }
            Gl.Viewport(0, 0, width, height);
            BuildVideoProgress(_ui.Atlas, _window.Input, width, height);
            _ui.Flush(width, height);
        }

        /// <summary>
        /// Renders, reads back and submits one video frame at the tour clock for frame <see cref="_videoFrame"/>.
        /// </summary>
        /// <returns>False when there is nothing more to render now (the last frame was sent, or recording failed).</returns>
        private bool RenderVideoFrame()
        {
            if (_videoFrame >= _videoFrames)
            {
                _video.Complete();
                _videoFinishing = true;
                return false;
            }
            byte[] buffer = _video.Rent();
            if (buffer == null) { return false; }

            // The tour at this frame's time (fixed step: smooth whatever the PC's speed)
            _tourTime = _videoFrame / (float)_videoFps;
            EvaluateTour();
            UpdateRoom();

            int w = _videoWidth, h = _videoHeight;
            Camera.ClearCustomView();
            Camera.Position = _tourPose.Eye;
            Camera.Yaw = _tourPose.Yaw;
            Camera.Pitch = _tourPose.Pitch;
            Camera.HorizontalFovDegrees = _fov;
            Camera.ViewportWidth = w;
            Camera.ViewportHeight = h;
            Camera.Aspect = (float)w / h;
            Camera.Update();

            _videoTarget ??= new RenderTarget();
            _videoResolve ??= new RenderTarget();
            RenderScene(w, h, _videoTarget, _videoSamples, photo: true);
            _videoResolve.Ensure(w, h, 0);
            _videoTarget.ResolveTo(_videoResolve);

            // 2D into the frame: the HUD (UI on) and the fade
            _videoResolve.Bind();
            if (_videoUi != null) { BuildVideoHud(w, h); }
            if (_tourPose.Black > 0.002f)
            {
                _ui.Rect(0, 0, w, h, Rgba.Hex(0x000000, Math.Clamp(_tourPose.Black, 0f, 1f)));
                _ui.Flush(w, h);
            }

            _videoResolve.ReadPixels(buffer);
            _video.Submit(buffer);
            _videoFrame++;
            return true;
        }

        /// <summary>
        /// The tour's HUD drawn into the video frame at the video's scale: status, coordinates, minimap (plan drawn
        /// into the frame) and the tour bar. No toasts, help or live readouts like FPS.
        /// </summary>
        private void BuildVideoHud(int w, int h)
        {
            UiBatch windowUi = _ui;
            float windowScale = UiScale;
            bool showFps = _showFps;
            _ui = _videoUi;
            UiScale = _videoUiScale;
            _showFps = false;
            try
            {
                FontAtlas f = _ui.Atlas;
                float mapX = w - S(20) - S(220), mapY = S(20);
                if (_showMap) { DrawMinimapPlan(mapX + S(8), mapY + S(30), S(204), S(170), w, h); }
                BuildStatusPanel(f);
                BuildCoordinatePanel(f, S(20), S(20) + S(146) + S(10));
                if (_showMap) { DrawMinimapOverlay(mapX, mapY); }
                BuildTourBar(f, w, h);
                _ui.Flush(w, h);
            }
            finally
            {
                _ui = windowUi;
                UiScale = windowScale;
                _showFps = showFps;
            }
        }

        /// <summary>
        /// The window's progress panel while recording: what is being made, a progress bar, frames and time left,
        /// CANCEL.
        /// </summary>
        private void BuildVideoProgress(FontAtlas f, InputState input, int width, int height)
        {
            float w = MathF.Min(S(620), width - S(40)), h = S(104);
            float x = MathF.Round((width - w) * 0.5f), y = height - S(24) - h;
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, Rgba.WithAlpha(UiTheme.BOOKMARK, 0.6f));
            float ix = x + S(16), iw = w - S(32);

            _ui.Text(f.Small, ix, y + S(14), _videoHeader ?? string.Empty, UiTheme.BOOKMARK_LABEL, S(1.2f));
            if ((_clock % 1f) < 0.6f && !_videoFinishing) { _ui.Circle(ix + iw - S(6), y + S(20), S(5), UiTheme.DANGER, 12); }

            float fraction = _videoFrames > 0 ? Math.Clamp(_videoFrame / (float)_videoFrames, 0f, 1f) : 1f;
            float barY = y + S(42);
            _ui.Rect(ix, barY, iw, S(6), Rgba.Hex(0xFFFFFF, 0.15f));
            _ui.Rect(ix, barY, iw * fraction, S(6), UiTheme.BOOKMARK);

            Text.Clear();
            if (_videoFinishing) { Text.Append("Finishing the file…"); }
            else
            {
                Text.Append("Frame ").AppendGrouped(_videoFrame).Append(" of ").AppendGrouped(_videoFrames).Append(" · ");
                AppendClock(_videoFrame / (float)_videoFps).Append(" of ");
                AppendClock(_videoFrames / (float)_videoFps);
                double elapsed = _videoClock?.Elapsed.TotalSeconds ?? 0.0;
                if (_videoFrame > 10 && elapsed > 1.0)
                {
                    double left = elapsed / _videoFrame * (_videoFrames - _videoFrame);
                    Text.Append(" · about ");
                    AppendClock((float)left).Append(" left");
                }
            }
            _ui.Text(f.Body, ix, barY + S(16), Text.Span, UiTheme.TEXT_SOFT);

            if (SmallButton(f, input, ix + iw - S(120), y + h - S(40), S(120), S(28), "CANCEL (ESC)")) { CancelVideo(); }
            _ui.Text(f.Small, ix, y + h - S(32), "Rendered off-screen at a fixed frame rate: smooth on any PC", UiTheme.TEXT_FAINT);
        }

        /// <summary>m:ss into <see cref="Text"/> (no allocation).</summary>
        private TextBuffer AppendClock(float seconds)
        {
            int total = Math.Max(0, (int)MathF.Round(seconds));
            Text.Append(total / 60).Append(':');
            return AppendTwoDigits(total % 60);
        }

        /// <summary>"m:ss" (allocates: labels built once).</summary>
        private static string FormatClock(float seconds)
        {
            int total = Math.Max(0, (int)MathF.Round(seconds));
            return $"{total / 60}:{total % 60:00}";
        }

        #endregion
    }
}
