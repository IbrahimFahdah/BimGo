using System.Numerics;
using BimGo.Audio;
using BimGo.Format;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;
using Vk = BimGo.Native.Win32;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Bookmark tour (tour round): plays the bookmarks in list order, hands-free. Each stop fades in, holds (with an
    /// optional slow swivel) and fades out, or the camera glides from stop to stop. Every stop applies what its bookmark
    /// kept (sun time, section cut, hidden categories / links / elements, eye height); a bookmark without one of those
    /// uses the walkthrough's own state from when the tour started. When the tour ends (or Esc stops it) the player, the
    /// sun, the cut, the visibility and the eye height go back to what they were, and nothing is marked changed.
    /// <para>Keys while playing: Space pause, → / Page Down / LMB next stop, ← / Page Up / RMB previous (or the start of
    /// this stop), Esc stop, F11 fullscreen. Started from the pause menu (BOOKMARKS → PLAY TOUR).</para>
    /// <para>The timing lives in Core (<see cref="TourTimeline"/>) so that build A2 can record the same tour to video
    /// at a fixed frame rate.</para>
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private const float DEGREES = MathF.PI / 180f;

        /// <summary>Within this many seconds of a stop's start, "previous" goes to the stop before; later, to this stop's start.</summary>
        private const float TOUR_PREVIOUS_GRACE = 1.5f;

        // Playback
        private bool _tourActive;
        private bool _tourPaused;
        private TourTimeline _tour;
        private BookmarkRecord[] _tourRecords;
        private TourSettings _tourRun;
        private float _tourTime;
        private TourPose _tourPose;
        private int _tourAppliedStop = -1;
        private float _tourHintUntil;

        // The walkthrough's state when the tour started (put back at the end; also used by stops that kept nothing)
        private Vector3 _tourSavedFeet;
        private float _tourSavedYaw, _tourSavedPitch;
        private SunTime _tourSavedSun;
        private bool _tourSavedShadows, _tourSavedSunPlaying;
        private SectionCut _tourSavedSection;
        private VisibilitySettings _tourSavedVisibility;
        private bool[] _tourSavedIsolate;
        private float _tourSavedEye;
        private EyePreset _tourSavedPreset;
        private bool _tourSavedEyeCustom;
        private bool _tourSavedUiHidden;

        // What the current stop applied (reference checks skip re-applying the same state)
        private SunTime _tourAppliedSun;
        private SectionCut _tourAppliedSection;
        private VisibilitySettings _tourAppliedVisibility;

        // The tour settings view in the bookmark list: a draft saved when a change is finished (not mid-drag)
        private bool _tourSettingsOpen;
        private TourSettings _tourDraft;
        private bool _tourDraftDirty;
        private int _tourStopScroll;

        private static readonly string[] TRANSITION_OPTIONS = { "Fade", "Glide" };
        private static readonly string[] SWIVEL_DIRECTION_OPTIONS = { "Left", "Right" };
        private const int SLIDER_TOUR_FADE = 40, SLIDER_TOUR_GLIDE = 41, SLIDER_TOUR_HOLD = 42, SLIDER_TOUR_SWIVEL = 43;

        #endregion

        /// <summary>True while a bookmark tour is playing (or paused mid-tour).</summary>
        private bool IsTourActive => _tourActive;

        #region Start / stop

        /// <summary>
        /// Starts the tour from the first bookmark that isn't left out. Closes the pause menu and any panel.
        /// </summary>
        /// <returns>False (with a notice) when there is nothing to play.</returns>
        private bool StartTour()
        {
            if (_tourActive || _player == null) { return false; }
            FlushTourDraft();

            var records = new List<BookmarkRecord>();
            foreach (BookmarkRecord record in Bookmarks.Bookmarks)
            {
                if (!record.TourSkip) { records.Add(record); }
            }
            if (records.Count == 0)
            {
                _bookmarksNotice = Bookmarks.Bookmarks.Count == 0
                    ? "No bookmarks to tour yet: press B where you want a stop"
                    : "Every bookmark is left out of the tour (TOUR SETTINGS ticks them back in)";
                Sound.Play(SoundId.Error);
                return false;
            }

            // Remember the walkthrough as it is
            _tourRun = Bookmarks.Tour.Copy().Clean();
            _tourSavedFeet = _player.Feet;
            _tourSavedYaw = _player.Yaw;
            _tourSavedPitch = _player.Pitch;
            _tourSavedSun = _sun.Time.Copy();
            if (_sunPlaying) { _tourSavedSun.Minutes = Math.Clamp((int)MathF.Round(_playMinutes), 0, 1439); }
            _tourSavedShadows = _sun.Enabled;
            _tourSavedSunPlaying = _sunPlaying;
            _tourSavedSection = _section.Clone();
            _tourSavedVisibility = ToVisibilitySettings();
            _tourSavedIsolate = _isolateBackup;
            _tourSavedEye = _player.Controller.StandEye;
            _tourSavedPreset = _eyePreset;
            _tourSavedEyeCustom = _eyeCustom;
            _tourSavedUiHidden = _uiHidden;

            // Lay the stops out (eye height: the bookmark's, else the current one)
            _tourRecords = records.ToArray();
            var stops = new List<TourStop>(_tourRecords.Length);
            foreach (BookmarkRecord record in _tourRecords)
            {
                stops.Add(new TourStop(record.Local, record.EyeHeight ?? _tourSavedEye, record.Yaw, Math.Clamp(record.Pitch, -1.5f, 1.5f),
                    _tourRun.HoldFor(record), _tourRun.SwivelFor(record) * DEGREES));
            }
            _tour = new TourTimeline(stops, _tourRun.Transition, _tourRun.FadeSeconds, _tourRun.GlideSeconds);

            // Clear the stage: menu, panels, a gun mid-move
            CloseBookmarks();
            ClosePhotoMode();
            CloseSunPanel();
            CloseSunHours();
            CloseSectionEditor();
            if (_guns[_activeGun].CapturesInput) { _guns[_activeGun].OnCancel(); }
            if (_paused) { SetPaused(false); }

            _tourActive = true;
            _tourPaused = false;
            _tourTime = 0f;
            _tourAppliedStop = -1;
            _tourAppliedSun = null;
            _tourAppliedSection = null;
            _tourAppliedVisibility = null;
            _uiHidden = !_tourRun.ShowUi;
            _toast = null;
            _tourHintUntil = _clock + 4f;
            _window.Input.ReleaseAll();
            if (_window.IsActive) { _window.SetCaptured(true); }
            EvaluateTour();
            Utilities.Log_Utils.Write($"Tour started: {_tour.Count} stop(s), {_tour.Duration:0.0} s, {_tourRun.Transition}.");
            return true;
        }

        /// <summary>
        /// Ends the tour and puts the walkthrough back as it was when the tour started.
        /// </summary>
        /// <param name="finished">True when it played to the end (else Esc stopped it).</param>
        private void StopTour(bool finished)
        {
            if (!_tourActive) { return; }
            _tourActive = false;
            _tourPaused = false;

            SetSunQuiet(_tourSavedSun, _tourSavedShadows);
            _sunPlaying = _tourSavedSunPlaying && _tourSavedShadows;
            SetSectionQuiet(_tourSavedSection);
            ApplyVisibility(_tourSavedVisibility, record: false);
            _isolateBackup = _tourSavedIsolate;
            _player.Controller.SetStandingEye(_tourSavedEye, force: true);
            _eyePreset = _tourSavedPreset;
            _eyeCustom = _tourSavedEyeCustom;
            _player.TeleportTo(_tourSavedFeet, _tourSavedYaw, _tourSavedPitch);
            _uiHidden = _tourSavedUiHidden;

            _tour = null;
            _tourRecords = null;
            _tourSavedVisibility = null;
            _tourSavedIsolate = null;
            _window.Input.ReleaseAll();
            Toast(finished ? "Tour finished: back where you were" : "Tour stopped: back where you were", 2.4f);
        }

        #endregion

        #region Playback

        /// <summary>
        /// Per frame while the tour plays (instead of the walkthrough's keys): pause, next / previous, stop, then the
        /// clock and the pose. Losing focus doesn't pause it (presenting on another screen).
        /// </summary>
        private void UpdateTour(InputState input, float dt)
        {
            _window.FocusLost = false;

            // Recording a video: the frames drive the tour clock, only Esc (cancel) applies
            if (_video != null)
            {
                UpdateVideo(input);
                return;
            }

            if (input.IsPressed(Vk.VK_ESCAPE))
            {
                StopTour(finished: false);
                return;
            }
            if (input.IsPressed(Vk.VK_F11)) { _window.ToggleFullscreen(); }
            if (input.IsPressed(Vk.VK_SPACE))
            {
                _tourPaused = !_tourPaused;
                Sound.Play(SoundId.UiClick);
            }

            bool next = input.IsPressed(Vk.VK_RIGHT) || input.IsPressed(Vk.VK_NEXT) || input.LeftPressed;
            bool previous = input.IsPressed(Vk.VK_LEFT) || input.IsPressed(Vk.VK_PRIOR) || input.RightPressed;
            if (next || previous)
            {
                input.ConsumeClicks();
                if (!SeekTourStop(next ? +1 : -1)) { return; }
            }

            if (!_tourPaused) { _tourTime += dt; }
            if (_tourTime >= _tour.Duration)
            {
                if (_tourRun.Loop && _tour.Duration > 0f) { _tourTime %= _tour.Duration; }
                else
                {
                    StopTour(finished: true);
                    return;
                }
            }

            EvaluateTour();
            UpdateRoom();
            if (_window.IsActive && !_window.IsCaptured) { _window.SetCaptured(true); }
        }

        /// <summary>
        /// Jumps to the next stop, or to the previous one (to this stop's start when it has been showing a while).
        /// </summary>
        /// <returns>False if the tour ended (next past the last stop without looping).</returns>
        private bool SeekTourStop(int direction)
        {
            int current = _tour.StopAt(_tourTime);
            int target;
            if (direction > 0)
            {
                target = current + 1;
                if (target >= _tour.Count)
                {
                    if (!_tourRun.Loop)
                    {
                        StopTour(finished: true);
                        return false;
                    }
                    target = 0;
                }
            }
            else
            {
                bool early = _tourTime - _tour.StartOf(current) < TOUR_PREVIOUS_GRACE;
                target = early && current > 0 ? current - 1 : current;
            }
            _tourTime = _tour.StartOf(target);
            Sound.Play(SoundId.UiClick);
            return true;
        }

        /// <summary>
        /// The pose at the tour clock: applies a new stop's state, and moves the player there (the minimap, room and
        /// level readouts follow). The camera takes the pose in <see cref="UpdateCamera"/>.
        /// </summary>
        private void EvaluateTour()
        {
            _tourPose = _tour.Evaluate(_tourTime);
            if (_tourPose.Stop < 0) { return; }
            if (_tourPose.Stop != _tourAppliedStop) { ApplyTourStop(_tourPose.Stop); }
            _player.TeleportTo(_tourPose.Feet, _tourPose.Yaw, _tourPose.Pitch);
        }

        /// <summary>
        /// Applies what a stop's bookmark kept, without recording anything for saving: sun, cut, visibility, eye height.
        /// Parts the bookmark didn't keep fall back to the state from the tour's start.
        /// </summary>
        private void ApplyTourStop(int index)
        {
            _tourAppliedStop = index;
            BookmarkRecord record = _tourRecords[index];

            SunTime sun = record.Sun ?? _tourSavedSun;
            if (!ReferenceEquals(sun, _tourAppliedSun))
            {
                SetSunQuiet(sun, record.Sun != null || _tourSavedShadows);
                _tourAppliedSun = sun;
            }

            SectionCut section = record.Section ?? _tourSavedSection;
            if (!ReferenceEquals(section, _tourAppliedSection))
            {
                SetSectionQuiet(section);
                _tourAppliedSection = section;
            }

            VisibilitySettings visibility = record.Visibility ?? _tourSavedVisibility;
            if (!ReferenceEquals(visibility, _tourAppliedVisibility))
            {
                ApplyVisibility(visibility, record: false);
                _tourAppliedVisibility = visibility;
            }

            ApplyEyeHeight(_tour[index].EyeHeight);
        }

        /// <summary>The sun time and shadows on / off, without recording a change (tour).</summary>
        private void SetSunQuiet(SunTime time, bool shadows)
        {
            if (time == null) { return; }
            _sunPlaying = false;
            _sun.Time = time.Copy();
            _sun.Enabled = shadows;
            RecomputeSun();
        }

        /// <summary>The section cut, without recording a change (tour).</summary>
        private void SetSectionQuiet(SectionCut cut)
        {
            _section = (cut ?? new SectionCut()).Clone().Clean();
            _sectionCount = _section.LocalPlanes(Scene.OriginOffset, _sectionPlanes);
            _renderer?.SetSection(_sectionPlanes, _sectionCount, _section.BoxOn);
        }

        #endregion

        #region Overlay

        /// <summary>
        /// The tour's 2D layer: with the UI on, the status, coordinates, minimap, room and a tour bar; then the fade;
        /// then the key hint for the first seconds (and while paused).
        /// </summary>
        private void BuildTourOverlay(int width, int height, float mapX, float mapY)
        {
            FontAtlas f = _ui.Atlas;
            if (!_uiHidden)
            {
                BuildStatusPanel(f);
                BuildCoordinatePanel(f, S(20), S(20) + S(146) + S(10));
                if (_showMap) { DrawMinimapOverlay(mapX, mapY); }
                BuildRoomBanner(f, width);
                BuildLiveBanner(f, width, height);
                BuildTourBar(f, width, height);
                BuildToast(f, width);
            }
            else if (_toastImportant)
            {
                BuildToast(f, width);
            }

            if (_tourPose.Black > 0.002f) { _ui.Rect(0, 0, width, height, Rgba.Hex(0x000000, Math.Clamp(_tourPose.Black, 0f, 1f))); }

            // Key hint: fades out after a few seconds; stays while paused
            float hintAlpha = _tourPaused ? 1f : Math.Clamp((_tourHintUntil - _clock) / 0.6f, 0f, 1f);
            if (hintAlpha > 0f)
            {
                string hint = _tourPaused
                    ? "PAUSED · SPACE plays · ← → stops · ESC ends the tour"
                    : "SPACE pause · ← → or click for stops · ESC ends the tour";
                float hintW = UiBatch.Measure(f.Body, hint) + S(28);
                float hx = MathF.Round(width * 0.5f - hintW * 0.5f);
                float hy = height - S(_uiHidden ? 64 : 112);
                _ui.Panel(hx, hy, hintW, S(30), Rgba.WithAlpha(UiTheme.PANEL, hintAlpha), Rgba.WithAlpha(UiTheme.PANEL_BORDER, hintAlpha));
                _ui.TextCentred(f.Body, width * 0.5f, hy + S(7), hint, Rgba.WithAlpha(UiTheme.TEXT, hintAlpha));
            }
        }

        /// <summary>
        /// Bottom-centre bar (UI on): stop number, bookmark name and the tour's progress.
        /// </summary>
        private void BuildTourBar(FontAtlas f, int width, int height)
        {
            int stop = Math.Max(0, _tourPose.Stop);
            float w = MathF.Min(S(560), width - S(40)), h = S(58);
            float x = MathF.Round((width - w) * 0.5f), y = height - S(20) - h;
            _ui.Panel(x, y, w, h, UiTheme.PANEL, UiTheme.PANEL_BORDER);

            Text.Clear().Append("TOUR · ").Append(stop + 1).Append(" / ").Append(_tour.Count);
            if (_tourPaused) { Text.Append(" · PAUSED"); }
            float used = _ui.Text(f.Small, x + S(14), y + S(12), Text.Span, UiTheme.BOOKMARK_LABEL, S(1.4f));
            _ui.TextWrapped(f.Bold, x + S(14) + used + S(12), y + S(9), w - used - S(40), _tourRecords[stop].Name, UiTheme.TEXT, maxLines: 1);

            float fraction = _tour.Duration > 0f ? Math.Clamp(_tourTime / _tour.Duration, 0f, 1f) : 1f;
            float barY = y + h - S(16), barW = w - S(28);
            _ui.Rect(x + S(14), barY, barW, S(4), Rgba.Hex(0xFFFFFF, 0.15f));
            _ui.Rect(x + S(14), barY, barW * fraction, S(4), UiTheme.BOOKMARK);
            for (int i = 1; i < _tour.Count; i++)
            {
                float tick = _tour.StartOf(i) / MathF.Max(_tour.Duration, 0.001f);
                _ui.Rect(x + S(14) + barW * tick - S(1), barY - S(2), S(2), S(8), Rgba.Hex(0xFFFFFF, 0.35f));
            }
        }

        #endregion

        #region Settings view (bookmark list)

        /// <summary>Opens or closes the tour settings view in place of the bookmark rows.</summary>
        private void ToggleTourSettings()
        {
            FlushTourDraft();
            _tourSettingsOpen = !_tourSettingsOpen;
            _tourDraft = _tourSettingsOpen ? Bookmarks.Tour.Copy() : null;
            _tourStopScroll = 0;
            _activeSlider = -1;
        }

        /// <summary>Saves the draft settings if they changed.</summary>
        private void FlushTourDraft()
        {
            if (!_tourDraftDirty || _tourDraft == null) { return; }
            _tourDraftDirty = false;
            Bookmarks.SetTour(_tourDraft);
            if (Bookmarks.LastError != null) { _bookmarksNotice = Bookmarks.LastError; }
        }

        /// <summary>
        /// The tour settings view: tour-wide settings on the left, each bookmark's overrides on the right.
        /// </summary>
        private void BuildTourSettings(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            if (_tourDraft == null) { _tourDraft = Bookmarks.Tour.Copy(); }
            if (!input.LeftDown) { _activeSlider = -1; }
            TourSettings draft = _tourDraft;
            float lw = MathF.Min(S(320), w * 0.42f);
            float ly = y;

            _ui.Text(f.Body, x, ly, "Between stops", UiTheme.TEXT);
            int transition = Segmented(f, input, x, ly + S(22), lw, TRANSITION_OPTIONS, (int)draft.Transition);
            if (transition != (int)draft.Transition) { draft.Transition = (TourTransition)transition; _tourDraftDirty = true; }
            ly += S(64);

            if (draft.Transition == TourTransition.Fade)
            {
                Text.Clear().Append(draft.FadeSeconds, 1).Append(" s");
                float fade = MathF.Round(Slider(f, input, SLIDER_TOUR_FADE, x, ly, lw, "Fade (each way)", Text.Span, draft.FadeSeconds, 0f, TourSettings.MAX_FADE) * 10f) / 10f;
                if (_activeSlider == SLIDER_TOUR_FADE && fade != draft.FadeSeconds) { draft.FadeSeconds = fade; _tourDraftDirty = true; }
            }
            else
            {
                Text.Clear().Append(draft.GlideSeconds, 1).Append(" s");
                float glide = MathF.Round(Slider(f, input, SLIDER_TOUR_GLIDE, x, ly, lw, "Glide (at least)", Text.Span, draft.GlideSeconds, TourSettings.MIN_GLIDE, TourSettings.MAX_GLIDE) * 2f) / 2f;
                if (_activeSlider == SLIDER_TOUR_GLIDE && glide != draft.GlideSeconds) { draft.GlideSeconds = glide; _tourDraftDirty = true; }
            }
            ly += S(58);

            Text.Clear().Append(draft.HoldSeconds, 1).Append(" s");
            float hold = MathF.Round(Slider(f, input, SLIDER_TOUR_HOLD, x, ly, lw, "Hold at each stop", Text.Span, draft.HoldSeconds, TourSettings.MIN_HOLD, 30f) * 2f) / 2f;
            if (_activeSlider == SLIDER_TOUR_HOLD && hold != draft.HoldSeconds) { draft.HoldSeconds = hold; _tourDraftDirty = true; }
            ly += S(62);

            bool swivel = Checkbox(f, input, x, ly, lw, "Swivel slowly at each stop", draft.Swivel);
            if (swivel != draft.Swivel) { draft.Swivel = swivel; _tourDraftDirty = true; }
            ly += S(30);
            if (draft.Swivel)
            {
                Text.Clear().Append(draft.SwivelDegrees, 0).Append('°');
                float angle = MathF.Round(Slider(f, input, SLIDER_TOUR_SWIVEL, x, ly, lw, "Swivel angle", Text.Span, draft.SwivelDegrees, 5f, TourSettings.MAX_SWIVEL) / 5f) * 5f;
                if (_activeSlider == SLIDER_TOUR_SWIVEL && angle != draft.SwivelDegrees) { draft.SwivelDegrees = angle; _tourDraftDirty = true; }
                ly += S(54);
                int direction = Segmented(f, input, x, ly, lw, SWIVEL_DIRECTION_OPTIONS, (int)draft.SwivelDirection);
                if (direction != (int)draft.SwivelDirection) { draft.SwivelDirection = (TourSwivelDirection)direction; _tourDraftDirty = true; }
                ly += S(44);
            }

            bool showUi = Checkbox(f, input, x, ly, lw, "Show the UI (minimap, status, room)", draft.ShowUi);
            if (showUi != draft.ShowUi) { draft.ShowUi = showUi; _tourDraftDirty = true; }
            ly += S(28);
            bool loop = Checkbox(f, input, x, ly, lw, "Loop (start again after the last stop)", draft.Loop);
            if (loop != draft.Loop) { draft.Loop = loop; _tourDraftDirty = true; }
            ly += S(36);

            float length = TourLength(draft, out int stops);
            int seconds = (int)MathF.Round(length);
            Text.Clear().Append(stops).Append(stops == 1 ? " stop · " : " stops · ").Append(seconds / 60).Append(':');
            if (seconds % 60 < 10) { Text.Append('0'); }
            Text.Append(seconds % 60).Append(draft.Loop ? " per loop" : " in all");
            _ui.Text(f.Mono, x, ly, Text.Span, UiTheme.TEXT_SOFT);
            ly += S(32);

            // Walkthrough video (per machine): size and frame rate; RECORD VIDEO is beside PLAY TOUR
            _ui.Text(f.Small, x, ly, "VIDEO (RECORD VIDEO BELOW)", UiTheme.TEXT_MUTED, S(1.4f));
            ly += S(20);
            float sizeW = lw * 0.6f;
            int size = Segmented(f, input, x, ly, sizeW - S(6), VIDEO_SIZE_OPTIONS, (int)_videoSize);
            if (size != (int)_videoSize) { _videoSize = (VideoSize)size; }
            int rate = _videoFps >= 60 ? 1 : 0;
            int pickedRate = Segmented(f, input, x + sizeW, ly, lw - sizeW, VIDEO_FPS_OPTIONS, rate);
            if (pickedRate != rate) { _videoFps = pickedRate == 1 ? 60 : 30; }
            ly += S(40);
            if (_videoLastPath != null && SmallButton(f, input, x, ly, lw, S(28), "OPEN FOLDER (LAST VIDEO)")) { OpenVideoFolder(); }

            // Save once a change is finished (a slider is released, a click is done)
            if (_tourDraftDirty && !input.LeftDown) { FlushTourDraft(); }

            BuildTourStopRows(f, input, x + lw + S(32), y, w - lw - S(32), bottom);
        }

        /// <summary>
        /// The right-hand table: per bookmark, in or out of the tour, its hold and its swivel (each "TOUR" until set).
        /// </summary>
        private void BuildTourStopRows(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            List<BookmarkRecord> list = Bookmarks.Bookmarks;
            _ui.Text(f.Small, x, y + S(2), "STOPS · EACH CAN OVERRIDE THE TOUR", UiTheme.TEXT_MUTED, S(1.4f));
            y += S(26);
            if (list.Count == 0)
            {
                _ui.TextWrapped(f.Body, x, y, w, "No bookmarks yet: press B where you want a stop.", UiTheme.TEXT_MUTED, maxLines: 2);
                return;
            }

            float rowH = S(40);
            int visible = Math.Max(1, (int)((bottom - y) / rowH));
            int maxScroll = Math.Max(0, list.Count - visible);
            if (input.Wheel != 0) { _tourStopScroll -= input.Wheel * 2; }
            _tourStopScroll = Math.Clamp(_tourStopScroll, 0, maxScroll);

            float small = S(28), bh = S(28), gap = S(4);
            float swivelW = S(96), holdW = S(52);
            float controlsW = small + gap + holdW + small * 3 + gap * 3 + S(12) + swivelW + small * 2 + gap * 2;
            float nameW = w - controlsW - small - S(16);
            TourSettings tour = _tourDraft ?? Bookmarks.Tour;

            BookmarkRecord changed = null;
            float? newHold = null, newSwivel = null;
            bool newSkip = false;
            int last = Math.Min(list.Count, _tourStopScroll + visible);
            for (int i = _tourStopScroll; i < last; i++)
            {
                BookmarkRecord record = list[i];
                float ry = y + (i - _tourStopScroll) * rowH;
                if (((i - _tourStopScroll) & 1) == 0) { _ui.Rect(x - S(6), ry - S(4), w + S(12), rowH - S(4), Rgba.Hex(0xFFFFFF, 0.03f)); }
                float by = ry;
                float alpha = record.TourSkip ? 0.45f : 1f;

                // In the tour?
                bool inTour = Checkbox(f, input, x, by + S(6), small, string.Empty, !record.TourSkip);
                if (inTour == record.TourSkip) { changed = record; newHold = record.TourHold; newSwivel = record.TourSwivel; newSkip = !inTour; }

                Text.Clear().Append(i + 1).Append("  ").Append(record.Name);
                _ui.TextWrapped(f.Body, x + small + S(4), by + S(5), nameW, Text.Span, Rgba.WithAlpha(UiTheme.TEXT, alpha), maxLines: 1);

                // Hold: value (TOUR when not set), − + × (reset)
                float bx = x + small + S(8) + nameW;
                Text.Clear().Append(tour.HoldFor(record), 1).Append(" s");
                _ui.TextRight(f.Mono, bx + holdW, by + S(6), Text.Span, record.TourHold.HasValue ? Rgba.Hex(0x67E8F9) : UiTheme.TEXT_FAINT);
                bx += holdW + gap;
                if (SmallButton(f, input, bx, by, small, bh, "−")) { changed = record; newHold = MathF.Max(TourSettings.MIN_HOLD, tour.HoldFor(record) - 1f); newSwivel = record.TourSwivel; newSkip = record.TourSkip; }
                bx += small + gap;
                if (SmallButton(f, input, bx, by, small, bh, "+")) { changed = record; newHold = MathF.Min(TourSettings.MAX_HOLD, tour.HoldFor(record) + 1f); newSwivel = record.TourSwivel; newSkip = record.TourSkip; }
                bx += small + gap;
                if (SmallButton(f, input, bx, by, small, bh, "×") && record.TourHold.HasValue) { changed = record; newHold = null; newSwivel = record.TourSwivel; newSkip = record.TourSkip; }
                bx += small + S(12);

                // Swivel: TOUR → OFF → LEFT → RIGHT → TOUR; − + change a set angle
                string swivelLabel = SwivelLabel(record, tour);
                if (SmallButton(f, input, bx, by, swivelW, bh, swivelLabel))
                {
                    changed = record;
                    newHold = record.TourHold;
                    newSkip = record.TourSkip;
                    float magnitude = MathF.Max(5f, MathF.Abs(record.TourSwivel ?? tour.SwivelDegrees));
                    newSwivel = record.TourSwivel switch
                    {
                        null => 0f,
                        0f => magnitude,
                        > 0f => -magnitude,
                        _ => null
                    };
                }
                bx += swivelW + gap;
                if (record.TourSwivel is float set2 && set2 != 0f)
                {
                    if (SmallButton(f, input, bx, by, small, bh, "−")) { changed = record; newHold = record.TourHold; newSkip = record.TourSkip; newSwivel = MathF.Sign(set2) * MathF.Max(5f, MathF.Abs(set2) - 15f); }
                    if (SmallButton(f, input, bx + small + gap, by, small, bh, "+")) { changed = record; newHold = record.TourHold; newSkip = record.TourSkip; newSwivel = MathF.Sign(set2) * MathF.Min(TourSettings.MAX_SWIVEL, MathF.Abs(set2) + 15f); }
                }
            }

            if (maxScroll > 0)
            {
                Text.Clear().Append(_tourStopScroll + 1).Append('–').Append(last).Append(" of ").Append(list.Count).Append(" · wheel to scroll");
                _ui.TextRight(f.Small, x + w, bottom + S(2), Text.Span, UiTheme.TEXT_FAINT);
            }

            // Act after drawing (the list must not change while it is being walked)
            if (changed != null)
            {
                Bookmarks.SetTourOverrides(changed, newHold, newSwivel, newSkip);
                if (Bookmarks.LastError != null) { _bookmarksNotice = Bookmarks.LastError; }
            }
        }

        // "LEFT 30°" / "RIGHT 30°" labels by 5° step, built once each (the settings view draws them every frame)
        private static readonly string[] SWIVEL_LEFT_LABELS = new string[(int)(TourSettings.MAX_SWIVEL / 5f) + 1];
        private static readonly string[] SWIVEL_RIGHT_LABELS = new string[(int)(TourSettings.MAX_SWIVEL / 5f) + 1];

        /// <summary>
        /// The swivel button's label for a bookmark: TOUR, OFF, or the direction and angle (to the nearest 5°).
        /// </summary>
        private static string SwivelLabel(BookmarkRecord record, TourSettings tour)
        {
            if (record.TourSwivel is not float swivel) { return tour.Swivel ? "TOUR" : "TOUR (OFF)"; }
            if (swivel == 0f) { return "OFF"; }
            int step = Math.Clamp((int)MathF.Round(MathF.Abs(swivel) / 5f), 1, SWIVEL_LEFT_LABELS.Length - 1);
            string[] labels = swivel > 0f ? SWIVEL_LEFT_LABELS : SWIVEL_RIGHT_LABELS;
            return labels[step] ??= (swivel > 0f ? "LEFT " : "RIGHT ") + (step * 5).ToString(System.Globalization.CultureInfo.InvariantCulture) + "°";
        }

        /// <summary>
        /// The tour's length with these settings, worked out like <see cref="TourTimeline"/> without building one
        /// (no allocation: the settings view draws it every frame).
        /// </summary>
        private float TourLength(TourSettings settings, out int stops)
        {
            stops = 0;
            float total = 0f;
            BookmarkRecord previous = null;
            foreach (BookmarkRecord record in Bookmarks.Bookmarks)
            {
                if (record.TourSkip) { continue; }
                stops++;
                total += settings.HoldFor(record);
                if (settings.Transition == TourTransition.Fade) { total += settings.FadeSeconds * 2f; }
                else if (previous != null)
                {
                    float distance = Vector3.Distance(previous.Local, record.Local);
                    total += Math.Clamp(MathF.Max(settings.GlideSeconds, distance / TourTimeline.GLIDE_SPEED), settings.GlideSeconds,
                        MathF.Max(settings.GlideSeconds, TourTimeline.MAX_GLIDE_SECONDS));
                }
                previous = record;
            }
            if (settings.Transition == TourTransition.Glide && stops > 0) { total += settings.FadeSeconds * 2f; }
            return total;
        }

        #endregion
    }
}
