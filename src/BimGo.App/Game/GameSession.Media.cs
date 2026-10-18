using BimGo.Audio;
using BimGo.Format;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Round K-A: the MEDIA panel (pause menu → MEDIA, or Shift+M by default), one place for what BimGo makes for
    /// others to watch, on the panel shell with four tabs:
    /// <list type="bullet">
    /// <item><b>PHOTO</b>: photo mode's settings (still / 360°, size, format, exposure, grids) and OPEN PHOTO MODE (M
    /// still goes straight there).</item>
    /// <item><b>TOUR</b>: the bookmark tour's settings and each stop's overrides (moved from BOOKMARKS); PLAY TOUR,
    /// RECORD VIDEO.</item>
    /// <item><b>PATHS</b>: keyframed camera paths (<see cref="BuildPathsTab"/>): the list on the left, the selected
    /// path's settings and keys on the right.</item>
    /// <item><b>VIDEO</b>: the video's source (the tour or a path), size and frame rate (moved from the tour
    /// settings); RECORD VIDEO, OPEN FOLDER.</item>
    /// </list>
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private const int MEDIA_PHOTO = 0, MEDIA_TOUR = 1, MEDIA_PATHS = 2, MEDIA_VIDEO = 3;
        private static readonly string[] MEDIA_TABS = { "PHOTO", "TOUR", "PATHS", "VIDEO" };

        private bool _mediaOpen;
        private int _mediaTab = MEDIA_PATHS;
        private string _mediaNotice;

        // VIDEO: the source (null = the bookmark tour) and the source list's scroll
        private CameraPath _videoPath;
        private readonly ScrollRegion _videoSourceScroll = new();
        private readonly ScrollRegion _photoTabScroll = new();

        #endregion

        #region Open / close

        /// <summary>True while the MEDIA panel shows (it replaces the pause menu).</summary>
        private bool IsMediaPanelOpen => _mediaOpen;

        /// <summary>
        /// Opens the MEDIA panel on a tab (pausing first when walking).
        /// </summary>
        private void OpenMedia(int tab)
        {
            if (!_paused) { SetPaused(true); }
            CloseBookmarksPanel();
            _mediaOpen = true;
            _mediaNotice = null;
            SwitchMediaTab(Math.Clamp(tab, MEDIA_PHOTO, MEDIA_VIDEO), force: true);
        }

        /// <summary>Shift+M (walking): the MEDIA panel on the tab it showed last.</summary>
        private void OpenMediaPanel() => OpenMedia(_mediaTab);

        /// <summary>Changes tab: the tour draft is saved; the TOUR tab starts from the saved settings.</summary>
        private void SwitchMediaTab(int tab, bool force = false)
        {
            if (tab == _mediaTab && !force) { return; }
            FlushTourDraft();
            _mediaTab = tab;
            _activeSlider = -1;
            _pathDeleteArmed = null;
            _keyDeleteArmed = null;
            if (tab == MEDIA_TOUR) { ResetTourSettingsView(); }
            if (tab == MEDIA_PATHS) { _pathListScroll.Reset(); _keyListScroll.Reset(); _keyEditorScroll.Reset(); }
            if (tab == MEDIA_VIDEO) { _videoSourceScroll.Reset(); }
        }

        /// <summary>One level back: the panel closes (to the pause menu).</summary>
        /// <returns>True if it was open.</returns>
        private bool CloseMedia()
        {
            if (!_mediaOpen) { return false; }
            CloseMediaPanel();
            return true;
        }

        /// <summary>Closes the panel (CLOSE, a tour or path starting): the tour draft is saved first.</summary>
        private void CloseMediaPanel()
        {
            if (!_mediaOpen) { return; }
            FlushTourDraft();
            _tourDraft = null;
            _mediaOpen = false;
            _pathDeleteArmed = null;
            _keyDeleteArmed = null;
        }

        #endregion

        #region Panel

        /// <summary>
        /// Draws and handles the MEDIA panel (in place of the pause menu): tabs in the header, the tab's body, its
        /// footer actions.
        /// </summary>
        private void BuildMediaPanel()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            if (!input.LeftDown) { _activeSlider = -1; }

            Text.Clear();
            switch (_mediaTab)
            {
                case MEDIA_PHOTO: Text.Append("Stills and 360° panoramas · saved to Pictures\\BimGo"); break;
                case MEDIA_TOUR: Text.Append("The bookmark tour · ").AppendGrouped(Bookmarks.Bookmarks.Count).Append(" bookmarks · saved to ").Append(Bookmarks.FileName); break;
                case MEDIA_PATHS: Text.Append("Keyframed camera paths · ").AppendGrouped(CameraPaths.Paths.Count).Append(" · saved to ").Append(CameraPaths.FileName); break;
                default: Text.Append("Walkthrough videos (MP4) · saved to Videos\\BimGo"); break;
            }
            float tabsW = MathF.Min(S(440), _window.Width * 0.4f);
            PanelFrame frame = BeginPanel(PanelSize.Wide, "MEDIA", UiTheme.BOOKMARK_LABEL, Text.Span, headerControls: tabsW);
            float tabsX = TakeHeaderSlot(ref frame, tabsW, S(UiTheme.GAP_SMALL));
            int tab = Tabs(f, input, tabsX, frame.HeaderControlY + S(2), tabsW, MEDIA_TABS, _mediaTab);
            if (tab != _mediaTab)
            {
                SwitchMediaTab(tab);
                _mediaNotice = null;
            }

            float x = frame.Ix, y = frame.BodyTop, w = frame.Iw, bottom = frame.BodyBottom;
            int action1 = FOOTER_NONE, action2 = FOOTER_NONE, action3 = FOOTER_NONE;
            string hint;
            switch (_mediaTab)
            {
                case MEDIA_PHOTO:
                    BuildPhotoTab(f, input, x, y, w, bottom);
                    action1 = FooterAction("OPEN FOLDER");
                    action2 = FooterAction(HINT_MEDIA_PHOTO_OPEN.Text, ShellStyle.Primary);
                    hint = HINT_MEDIA_PHOTO.Text;
                    break;
                case MEDIA_TOUR:
                    BuildTourSettings(f, input, x, y, w, bottom);
                    action1 = FooterAction("RECORD VIDEO");
                    action2 = FooterAction("PLAY TOUR", ShellStyle.Primary);
                    hint = HINT_BOOKMARKS_TOUR.Text;
                    break;
                case MEDIA_PATHS:
                    BuildPathsTab(f, input, x, y, w, bottom);
                    if (!_mediaOpen) { return; } // GO TO left the panel
                    bool playable = _mediaPath != null && _mediaPath.Keys.Count >= 2;
                    action1 = FooterAction("RECORD VIDEO", ShellStyle.Normal, playable);
                    action3 = FooterAction(_pathEditOn ? "BACK TO THE 3D EDITOR" : "EDIT IN 3D", ShellStyle.Normal, _mediaPath != null); // Round K-B
                    action2 = FooterAction("PLAY PATH", ShellStyle.Primary, playable);
                    hint = HINT_MEDIA_PATHS.Text;
                    break;
                default:
                    BuildVideoTab(f, input, x, y, w, bottom);
                    action1 = FooterAction("OPEN FOLDER");
                    action2 = FooterAction("RECORD VIDEO", ShellStyle.Primary);
                    hint = "Rendered off-screen at a fixed frame rate (smooth on any PC) · Esc cancels a recording and deletes the partial file";
                    break;
            }

            int pressed = EndPanel(frame, _mediaNotice, hint);
            if (pressed == FOOTER_NONE || pressed == FOOTER_LEFT) { return; }
            switch (_mediaTab)
            {
                case MEDIA_PHOTO:
                    if (pressed == action1) { OpenPhotoFolder(); }
                    else if (pressed == action2)
                    {
                        CloseMediaPanel();
                        OpenPhotoMode();
                    }
                    break;
                case MEDIA_TOUR:
                    if (pressed == action1) { StartVideo(); }
                    else if (pressed == action2) { StartTour(); }
                    break;
                case MEDIA_PATHS:
                    if (pressed == action1) { StartVideo(_mediaPath); }
                    else if (pressed == action2) { StartPath(_mediaPath); }
                    else if (pressed == action3) { EnterPathEditor(_mediaPath); }
                    break;
                default:
                    if (pressed == action1) { OpenVideoFolder(); }
                    else if (pressed == action2) { StartVideo(_videoPath); }
                    break;
            }
        }

        #endregion

        #region PHOTO

        /// <summary>
        /// PHOTO: photo mode's settings on the left (shared with photo mode's own panel), what photo mode does on the
        /// right.
        /// </summary>
        private void BuildPhotoTab(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            float lw = MathF.Min(S(380), w * 0.45f);
            float cy = BeginScroll(_photoTabScroll, input, x, y, lw + S(UiTheme.SCROLL_GUTTER), bottom - y, out _);
            float label = S(96);

            cy = SectionLabel(f, x, cy, "PHOTO SETTINGS");
            int kind = Segmented(f, input, x, cy, lw, PHOTO_KINDS, _photoKind);
            if (kind != _photoKind) { _photoKind = kind; }
            cy += S(44);
            if (_photoKind == 0)
            {
                _ui.Text(f.Body, x, cy + S(7), "Size", UiTheme.TEXT_SOFT);
                int scale = Segmented(f, input, x + label, cy, lw - label, PHOTO_SCALES, _photoScale - 1) + 1;
                if (scale != _photoScale) { _photoScale = scale; }
                cy += S(36);
                Text.Clear().Append(_window.Width * (long)_photoScale).Append(" × ").Append(_window.Height * (long)_photoScale).Append(" px (this window × ").Append(_photoScale).Append(')');
                _ui.Text(f.Small, x + label, cy, Text.Span, UiTheme.TEXT_FAINT);
                cy += S(24);
                _ui.Text(f.Body, x, cy + S(7), "Format", UiTheme.TEXT_SOFT);
                int format = Segmented(f, input, x + label, cy, lw - label, PHOTO_FORMATS, _photoJpeg ? 1 : 0);
                _photoJpeg = format == 1;
                cy += S(42);
                _ui.Text(f.Body, x, cy + S(7), "View", UiTheme.TEXT_SOFT);
                float fov = StepperValue(f, input, x + label, cy, _fov, 5f, 30f, 120f, 0, "° wide");
                if (fov != _fov) { _fov = fov; }
                cy += S(40);
            }
            else
            {
                _ui.Text(f.Body, x, cy + S(7), "Size", UiTheme.TEXT_SOFT);
                int size = Segmented(f, input, x + label, cy, lw - label, PANO_SIZES, _photo8K ? 1 : 0);
                _photo8K = size == 1;
                cy += S(36);
                _ui.Text(f.Small, x + label, cy, _photo8K ? "8192 × 4096 px JPEG" : "4096 × 2048 px JPEG", UiTheme.TEXT_FAINT);
                cy += S(28);
            }

            _ui.Text(f.Body, x, cy + S(7), "Exposure", UiTheme.TEXT_SOFT);
            float ev = StepperValue(f, input, x + label, cy, _photoExposure, 0.5f, -3f, 3f, 1, " EV");
            if (ev != _photoExposure) { _photoExposure = ev; }
            cy += S(42);
            _photoGrid = Checkbox(f, input, x, cy + S(4), lw, "Thirds grid (not in the photo)", _photoGrid);
            cy += S(32);
            _photoGridLines = Checkbox(f, input, x, cy + S(4), lw, GridsShowing ? "Grid lines in the photo" : "Grid lines in the photo (grids are off)", _photoGridLines);
            cy += S(40);
            EndScroll(_photoTabScroll, input, cy);

            // What photo mode does (right)
            float rx = x + lw + S(40), rw = w - lw - S(40);
            float ry = SectionLabel(f, rx, y, "PHOTO MODE");
            ry += _ui.TextWrapped(f.Body, rx, ry, rw, HINT_MEDIA_PHOTO_ABOUT.Text, UiTheme.TEXT_SOFT, maxLines: 6) + S(16);
            if (!ShadowsOn)
            {
                ry += _ui.TextWrapped(f.Small, rx, ry, rw, HINT_PHOTO_SHADOWS.Text, UiTheme.TEXT_FAINT, maxLines: 2) + S(12);
            }
            string last = _photoLastPath;
            if (last != null)
            {
                ry = SectionLabel(f, rx, ry, "LAST PHOTO");
                _ui.TextWrapped(f.Small, rx, ry, rw, Path.GetFileName(last), UiTheme.TEXT_MUTED, maxLines: 2);
            }
        }

        #endregion

        #region VIDEO

        /// <summary>
        /// VIDEO: the source (the bookmark tour or a camera path) on the left; size, frame rate and what will be
        /// recorded on the right.
        /// </summary>
        private void BuildVideoTab(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            RefreshPathStats();
            if (_videoPath != null && !CameraPaths.Paths.Contains(_videoPath)) { _videoPath = null; }

            // Sources (left)
            float lw = MathF.Min(S(420), w * 0.45f);
            float ly = SectionLabel(f, x, y, "RECORD");
            float rowH = S(48);
            int count = 1 + CameraPaths.Paths.Count;
            float top = BeginScroll(_videoSourceScroll, input, x, ly, lw, bottom - ly, out float cw);
            VisibleRows(_videoSourceScroll, rowH, count, out int first, out int lastRow);
            CameraPath picked = _videoPath;
            bool pickedTour = false;
            for (int i = first; i < lastRow; i++)
            {
                float ry = top + i * rowH;
                CameraPath path = i == 0 ? null : CameraPaths.Paths[i - 1];
                bool on = ReferenceEquals(path, _videoPath);
                if (on) { _ui.Rect(x, ry, cw, rowH - S(4), Rgba.WithAlpha(UiTheme.ACCENT, 0.16f)); }
                else if ((i & 1) == 0) { _ui.Rect(x, ry, cw, rowH - S(4), UiTheme.ROW_STRIPE); }
                if (Hover(input, x, ry, cw, rowH - S(4)) && input.LeftPressed)
                {
                    input.ConsumeClicks();
                    Sound.Play(SoundId.UiClick);
                    if (path == null) { pickedTour = true; }
                    else { picked = path; }
                }
                _ui.Circle(x + S(14), ry + rowH * 0.5f - S(2), S(5), on ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER, 12);
                if (path == null)
                {
                    float length = TourLength(Bookmarks.Tour, out int stops);
                    _ui.TextWrapped(f.Bold, x + S(30), ry + S(5), cw - S(40), "Bookmark tour", UiTheme.TEXT, maxLines: 1);
                    Text.Clear().Append(stops).Append(stops == 1 ? " stop · " : " stops · ");
                    AppendClock(length);
                    _ui.Text(f.Small, x + S(30), ry + S(26), Text.Span, UiTheme.TEXT_MUTED);
                }
                else
                {
                    _ui.TextWrapped(f.Bold, x + S(30), ry + S(5), cw - S(40), path.Name, UiTheme.TEXT, maxLines: 1);
                    _ui.TextWrapped(f.Small, x + S(30), ry + S(26), cw - S(40), PathStatsLabel(path), UiTheme.TEXT_MUTED, maxLines: 1);
                }
            }
            EndScroll(_videoSourceScroll, input, top + count * rowH);
            if (pickedTour) { _videoPath = null; }
            else if (!ReferenceEquals(picked, _videoPath)) { _videoPath = picked; }

            // Size, rate and the summary (right)
            float rx = x + lw + S(40), rw = MathF.Min(w - lw - S(40), S(460));
            float cy = SectionLabel(f, rx, y, "SIZE AND FRAME RATE (THIS PC)");
            int size = Segmented(f, input, rx, cy, rw, VIDEO_SIZE_OPTIONS, (int)_videoSize);
            if (size != (int)_videoSize) { _videoSize = (VideoSize)size; }
            cy += S(42);
            int rate = _videoFps >= 60 ? 1 : 0;
            int pickedRate = Segmented(f, input, rx, cy, rw, VIDEO_FPS_OPTIONS, rate);
            if (pickedRate != rate) { _videoFps = pickedRate == 1 ? 60 : 30; }
            cy += S(52);

            cy = SectionLabel(f, rx, cy, "THE VIDEO");
            VideoFrameSize(out int vw, out int vh);
            float seconds = _videoPath != null ? PathDuration(_videoPath) : TourLength(Bookmarks.Tour, out _);
            Text.Clear().Append(vw).Append(" × ").Append(vh).Append(" · ").Append(_videoFps).Append(" fps · ");
            AppendClock(seconds).Append(" · ").AppendGrouped((long)Math.Ceiling(seconds * _videoFps)).Append(" frames");
            _ui.Text(f.Mono, rx, cy, Text.Span, UiTheme.TEXT_SOFT);
            cy += S(26);
            bool ui = _videoPath != null ? _videoPath.ShowUi : Bookmarks.Tour.ShowUi;
            bool loop = _videoPath != null ? _videoPath.Loop : Bookmarks.Tour.Loop;
            _ui.TextWrapped(f.Small, rx, cy, rw, ui
                ? (loop ? "With the HUD (the source's setting) · a looping source records one lap" : "With the HUD (the source's setting)")
                : (loop ? "A clean view, no HUD (the source's setting) · a looping source records one lap" : "A clean view, no HUD (the source's setting)"),
                UiTheme.TEXT_MUTED, maxLines: 2);
            cy += S(44);
            if (_videoLastPath != null)
            {
                cy = SectionLabel(f, rx, cy, "LAST VIDEO");
                _ui.TextWrapped(f.Small, rx, cy, rw, Path.GetFileName(_videoLastPath), UiTheme.TEXT_MUTED, maxLines: 2);
            }
        }

        #endregion
    }
}
