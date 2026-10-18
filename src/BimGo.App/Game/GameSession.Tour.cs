using System.Numerics;
using BimGo.Audio;
using BimGo.Format;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

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
        private ITourTimeline _tour; // Round K-A: a bookmark tour or a camera path (one player)
        private BookmarkRecord[] _tourRecords; // K-A: a path's keys play as records too (name, sun, colour profile)
        private CameraPath _tourPath;          // K-A: the camera path playing, or null for the bookmark tour
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
        private string _tourSavedProfile;
        private bool _tourSavedProfileOn;
        private bool _tourSavedFlying; // K-C: a key photo puts walking back

        // Polish round P-C: the sun blending between stops (a scratch time shown while it blends; NaN minutes = no blend)
        private readonly SunTime _tourBlendSun = new();
        private bool _tourSunBlending;

        // What the current stop applied (reference checks skip re-applying the same state)
        private SunTime _tourAppliedSun;
        private SectionCut _tourAppliedSection;
        private VisibilitySettings _tourAppliedVisibility;

        // The tour settings (Round K-A: MEDIA → TOUR, was in the bookmark list): a draft saved when a change is finished
        // (not mid-drag)
        private TourSettings _tourDraft;
        private bool _tourDraftDirty;
        private readonly ScrollRegion _tourStopScroll = new();
        private readonly ScrollRegion _tourSettingsScroll = new(); // polish round P-A1: the tour-wide settings scroll in a short window

        private static readonly string[] TRANSITION_OPTIONS = { "Fade", "Glide", "Smooth" }; // K-C: Smooth (TourSettings.Smooth)
        private static readonly string[] SWIVEL_DIRECTION_OPTIONS = { "Left", "Right" };
        private const int SLIDER_TOUR_FADE = 40, SLIDER_TOUR_GLIDE = 41, SLIDER_TOUR_HOLD = 42, SLIDER_TOUR_SWIVEL = 43, SLIDER_TOUR_SPEED = 44;

        // Round K-C: the smooth tour's length for the TOUR / VIDEO tabs (rebuilt when the bookmarks or the settings change)
        private float _smoothTourLength;
        private int _smoothTourStops = -1, _smoothTourRevision = -1;
        private TourSettings _smoothTourFor;
        private float _smoothTourEye;

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
                _bookmarksNotice = _mediaNotice = Bookmarks.Bookmarks.Count == 0
                    ? $"No bookmarks to tour yet: press {Key(InputAction.AddBookmark)} where you want a stop"
                    : "Every bookmark is left out of the tour (MEDIA → TOUR ticks them back in)";
                Sound.Play(SoundId.Error);
                return false;
            }

            TourSettings run = Bookmarks.Tour.Copy().Clean();
            SaveWalkthroughForTour();

            // Round K-C: SMOOTH plays the stops as a camera path (one player); one stop alone fades in and out
            if (run.Smooth && records.Count >= 2)
            {
                CameraPath smooth = TourAsPath(records, run, _tourSavedEye, forStore: false);
                BeginTour(PathTimeline(smooth), records.ToArray(), run, null);
                Utilities.Log_Utils.Write($"Tour started (smooth): {_tour.Count} stop(s), {_tour.Duration:0.0} s, {run.SmoothSpeed:0.00} m/s.");
                return true;
            }

            // Lay the stops out (eye height: the bookmark's, else the current one; P-C: a crouched bookmark films from the
            // crouched eye, in the same proportion to its standing eye as the player's)
            float crouchRatio = _player.Controller.StandEye > 0.01f ? _player.Controller.CrouchEye / _player.Controller.StandEye : 0.6f;
            var stops = new List<TourStop>(records.Count);
            foreach (BookmarkRecord record in records)
            {
                float stopEye = (record.EyeHeight ?? _tourSavedEye) * (record.Crouched && !record.Flying ? crouchRatio : 1f);
                stops.Add(new TourStop(record.Local, stopEye, record.Yaw, Math.Clamp(record.Pitch, -1.5f, 1.5f),
                    run.HoldFor(record), run.SwivelFor(record) * DEGREES));
            }
            BeginTour(new TourTimeline(stops, run.Transition, run.FadeSeconds, run.GlideSeconds), records.ToArray(), run, null);
            Utilities.Log_Utils.Write($"Tour started: {_tour.Count} stop(s), {_tour.Duration:0.0} s, {_tourRun.Transition}.");
            return true;
        }

        /// <summary>
        /// Remembers the walkthrough as it is (put back when the tour or path ends; also used by stops that kept nothing).
        /// Round K-C: the 3D editor's preview state (and a key photo's) is put back first, so it isn't what is remembered.
        /// </summary>
        private void SaveWalkthroughForTour()
        {
            if (_keyPhotoRestore) { ClosePhotoMode(); } // a key photo's walkthrough comes back first
            EndPathEditState();
            RememberWalkthrough();
        }

        /// <summary>K-C: remembers the walkthrough's position and state (<see cref="SaveWalkthroughForTour"/>'s part).</summary>
        private void RememberWalkthrough()
        {
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
            _tourSavedProfile = _appearance.Active;
            _tourSavedProfileOn = _appearance.On;
            _tourSavedFlying = _player.Flying;
        }

        /// <summary>
        /// K-C: puts back the state <see cref="RememberWalkthrough"/> kept: the sun, the colour profile, the cut and what
        /// is hidden (not the position, eye height or UI: <see cref="StopTour"/> does those).
        /// </summary>
        private void RestoreWalkthroughState()
        {
            EndTourSunBlend();
            SetSunQuiet(_tourSavedSun, _tourSavedShadows);
            if (_appearance.Active != _tourSavedProfile || _appearance.On != _tourSavedProfileOn) // P-C: the profile as it was
            {
                _appearance.Active = _tourSavedProfile;
                _appearance.On = _tourSavedProfileOn;
                _profileDirty = true;
            }
            _sunPlaying = _tourSavedSunPlaying && _tourSavedShadows;
            SetSectionQuiet(_tourSavedSection);
            ApplyVisibility(_tourSavedVisibility, record: false);
            _isolateBackup = _tourSavedIsolate;
        }

        /// <summary>
        /// Starts playing a laid-out tour or path (the walkthrough already remembered by
        /// <see cref="SaveWalkthroughForTour"/>): clears the stage and shows the first pose.
        /// </summary>
        /// <param name="timeline">The timing.</param>
        /// <param name="records">Each stop's state (bookmarks, or a path's keys as records).</param>
        /// <param name="run">The settings used while it plays (UI on / off, loop).</param>
        /// <param name="path">The camera path playing, or null for the bookmark tour.</param>
        private void BeginTour(ITourTimeline timeline, BookmarkRecord[] records, TourSettings run, CameraPath path)
        {
            _tour = timeline;
            _tourRecords = records;
            _tourRun = run;
            _tourPath = path;

            // Clear the stage: menu, panels, a gun mid-move
            CloseBookmarksPanel();
            CloseMediaPanel(); // Round K-A: drafts saved first
            ClosePhotoMode();
            CloseSunPanel();
            CloseGridsPanel(); // grids round A: one panel at a time
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

            RestoreWalkthroughState();
            _player.Controller.SetStandingEye(_tourSavedEye, force: true);
            _eyePreset = _tourSavedPreset;
            _eyeCustom = _tourSavedEyeCustom;
            _player.TeleportTo(_tourSavedFeet, _tourSavedYaw, _tourSavedPitch);
            _uiHidden = _tourSavedUiHidden;

            bool path = _tourPath != null;
            _tour = null;
            _tourRecords = null;
            _tourPath = null;
            _tourSavedVisibility = null;
            _tourSavedIsolate = null;
            _window.Input.ReleaseAll();
            Toast(path
                ? finished ? "Path finished: back where you were" : "Path stopped: back where you were"
                : finished ? "Tour finished: back where you were" : "Tour stopped: back where you were", 2.4f);
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

            // Round K-C: PHOTOS OF ALL KEYS steps from key to key itself (Esc stops)
            if (_keyPhotos != null)
            {
                UpdateKeyPhotos(input);
                return;
            }

            if (input.Pressed(InputAction.Back))
            {
                StopTour(finished: false);
                return;
            }
            if (input.Pressed(InputAction.Fullscreen)) { _window.ToggleFullscreen(); }
            if (input.Pressed(InputAction.TourPause))
            {
                _tourPaused = !_tourPaused;
                Sound.Play(SoundId.UiClick);
            }

            bool next = input.Pressed(InputAction.TourNext);
            bool previous = !next && input.Pressed(InputAction.TourPrevious);
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
            _tourPose = _tour.Pose(_tourTime);
            if (_tourPose.Stop < 0) { return; }
            if (_tourPose.Stop != _tourAppliedStop) { ApplyTourStop(_tourPose.Stop); }
            BlendTourSun(_tourPose); // polish round P-C: the sun blends between stops instead of cutting
            _player.TeleportTo(_tourPose.Feet, _tourPose.Yaw, _tourPose.Pitch);
        }

        /// <summary>
        /// Polish round P-C: between two stops with different suns, the sun's date and time move from one to the other
        /// (shadows on / off switch halfway); held at a stop, the stop's own sun (applied by <see cref="ApplyTourStop"/>).
        /// </summary>
        private void BlendTourSun(in TourPose pose)
        {
            int from = pose.BlendFrom, to = pose.BlendTo;
            if (from < 0 || to < 0 || from == to || pose.BlendT >= 1f || from >= _tourRecords.Length || to >= _tourRecords.Length)
            {
                EndTourSunBlend();
                return;
            }
            SunTime a = _tourRecords[from].Sun ?? _tourSavedSun, b = _tourRecords[to].Sun ?? _tourSavedSun;
            bool shadowsA = _tourRecords[from].Sun != null || _tourSavedShadows, shadowsB = _tourRecords[to].Sun != null || _tourSavedShadows;
            if (a == null || b == null) { return; }
            bool same = a.Month == b.Month && a.Day == b.Day && a.Minutes == b.Minutes && a.DaylightSaving == b.DaylightSaving && shadowsA == shadowsB;
            if (same)
            {
                EndTourSunBlend();
                return;
            }

            float t = pose.BlendT;
            double minutes = SunBlend.Between(a, b, t, DateTime.Today.Year, _tourBlendSun); // K-C: the date the short way round

            _tourSunBlending = true;
            _sunPlaying = false;
            _sun.Time = _tourBlendSun;
            _sun.Enabled = t < 0.5f ? shadowsA : shadowsB;
            _sunBlendMinutes = minutes; // fractional: the sun moves smoothly (RecomputeSun)
            RecomputeSun();
            _tourAppliedSun = null; // the next stop applies its own sun
        }

        /// <summary>P-C: a blend that was showing ends: the stop's own sun again.</summary>
        private void EndTourSunBlend()
        {
            if (!_tourSunBlending) { return; }
            _tourSunBlending = false;
            _sunBlendMinutes = double.NaN;
            if ((_tourActive || _pathEditState) && _tourRecords != null && _tourAppliedStop >= 0 && _tourAppliedStop < _tourRecords.Length)
            {
                BookmarkRecord record = _tourRecords[_tourAppliedStop];
                SetSunQuiet(record.Sun ?? _tourSavedSun, record.Sun != null || _tourSavedShadows);
                _tourAppliedSun = record.Sun ?? _tourSavedSun;
            }
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

            ApplyEyeHeight(record.EyeHeight ?? _tourSavedEye); // P-C: the standing eye (a crouched stop's camera is lower)
            ApplyBookmarkProfile(record.ColourProfile ?? (_tourSavedProfileOn ? _tourSavedProfile : string.Empty), quiet: true); // P-C
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
            if (_keyPhotos != null)
            {
                // K-C: PHOTOS OF ALL KEYS: only its progress (no fades, no hint)
                BuildKeyPhotosOverlay(f, width, height);
                return;
            }
            if (!_uiHidden)
            {
                BuildInfoColumn(f, height, sunLegend: false, profileLegend: false, help: false); // P-A2: the left column
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
                string hint = _tourPath != null
                    ? _tourPaused ? HINT_PATH_PAUSED.Text : HINT_PATH_PLAYING.Text // Round K-A
                    : _tourPaused ? HINT_TOUR_PAUSED.Text : HINT_TOUR_PLAYING.Text;
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

            Text.Clear().Append(_tourPath != null ? "PATH · KEY " : "TOUR · ").Append(stop + 1).Append(" / ").Append(_tour.Count);
            if (_tourPaused) { Text.Append(" · PAUSED"); }
            float used = _ui.Text(f.Small, x + S(14), y + S(12), Text.Span, UiTheme.BOOKMARK_LABEL, S(1.4f));
            _ui.TextWrapped(f.Bold, x + S(14) + used + S(12), y + S(9), w - used - S(40), _tourPath != null ? _tourPath.Name : _tourRecords[stop].Name, UiTheme.TEXT, maxLines: 1);

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

        #region Settings view (MEDIA → TOUR)

        /// <summary>Round K-A: the TOUR tab opens on a fresh draft of the saved settings.</summary>
        private void ResetTourSettingsView()
        {
            FlushTourDraft();
            _tourDraft = Bookmarks.Tour.Copy();
            _tourStopScroll.Reset();
            _tourSettingsScroll.Reset();
            _activeSlider = -1;
        }

        /// <summary>Saves the draft settings if they changed.</summary>
        private void FlushTourDraft()
        {
            if (!_tourDraftDirty || _tourDraft == null) { return; }
            _tourDraftDirty = false;
            Bookmarks.SetTour(_tourDraft);
            if (Bookmarks.LastError != null) { _mediaNotice = Bookmarks.LastError; }
        }

        /// <summary>
        /// The tour settings (MEDIA → TOUR): tour-wide settings on the left, each bookmark's overrides on the right.
        /// </summary>
        private void BuildTourSettings(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            if (_tourDraft == null) { _tourDraft = Bookmarks.Tour.Copy(); }
            if (!input.LeftDown) { _activeSlider = -1; }
            TourSettings draft = _tourDraft;
            float lw = MathF.Min(S(320), w * 0.42f);
            float ly = BeginScroll(_tourSettingsScroll, input, x, y, lw + S(UiTheme.SCROLL_GUTTER), bottom - y, out _);

            _ui.Text(f.Body, x, ly, "Between stops", UiTheme.TEXT);
            int shownTransition = draft.Smooth ? 2 : (int)draft.Transition;
            int transition = Segmented(f, input, x, ly + S(22), lw, TRANSITION_OPTIONS, shownTransition);
            if (transition != shownTransition)
            {
                // K-C: Smooth is its own field (older builds keep reading the file); Fade / Glide switch it off
                draft.Smooth = transition == 2;
                if (transition < 2) { draft.Transition = (TourTransition)transition; }
                _tourDraftDirty = true;
            }
            ly += S(64);

            if (draft.Smooth)
            {
                Text.Clear().Append(draft.SmoothSpeed, 2).Append(" m/s");
                float speed = MathF.Round(Slider(f, input, SLIDER_TOUR_SPEED, x, ly, lw, "Speed between stops", Text.Span, draft.SmoothSpeed,
                    TourSettings.MIN_SMOOTH_SPEED, TourSettings.MAX_SMOOTH_SPEED) * 4f) / 4f;
                if (_activeSlider == SLIDER_TOUR_SPEED && speed != draft.SmoothSpeed) { draft.SmoothSpeed = speed; _tourDraftDirty = true; }
            }
            else if (draft.Transition == TourTransition.Fade)
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
            if (draft.Smooth)
            {
                // K-C: what Smooth does
                ly += _ui.TextWrapped(f.Small, x, ly, lw, "Smooth: one spline through the stops; each holds (and swivels), the camera follows the path between them and turns into each view",
                    UiTheme.TEXT_FAINT, maxLines: 3) + S(10);
            }
            _ui.TextWrapped(f.Small, x, ly, lw, "Video size and frame rate: the VIDEO tab (RECORD VIDEO below records this tour)", UiTheme.TEXT_FAINT, maxLines: 2);
            ly += S(44);

            // K-C: CONVERT TO PATH copies the ticked stops into a new camera path
            bool convert = SmallButton(f, input, x, ly, lw, S(30), "CONVERT TO PATH");
            ly += S(36);
            ly += _ui.TextWrapped(f.Small, x, ly, lw, "Copies the ticked stops into a new camera path (MEDIA → PATHS) to edit freely; the tour stays as it is",
                UiTheme.TEXT_FAINT, maxLines: 3) + S(12);
            EndScroll(_tourSettingsScroll, input, ly);

            // Save once a change is finished (a slider is released, a click is done)
            if (_tourDraftDirty && !input.LeftDown) { FlushTourDraft(); }

            BuildTourStopRows(f, input, x + lw + S(32), y, w - lw - S(32), bottom);
            if (convert) { ConvertTourToPath(); } // after drawing (it switches to PATHS)
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
                _ui.TextWrapped(f.Body, x, y, w, HINT_TOUR_EMPTY.Text, UiTheme.TEXT_MUTED, maxLines: 2);
                return;
            }

            float rowH = S(40);
            float listX = x;
            float top = BeginScroll(_tourStopScroll, input, x, y, w, bottom - y, out float cw);
            VisibleRows(_tourStopScroll, rowH, list.Count, out int first, out int last);
            x += S(6);
            w = cw - S(12);

            float small = S(28), bh = S(28), gap = S(4);
            float swivelW = S(96), holdW = S(52);
            float controlsW = small + gap + holdW + small * 3 + gap * 3 + S(12) + swivelW + small * 2 + gap * 2;
            float nameW = w - controlsW - small - S(16);
            TourSettings tour = _tourDraft ?? Bookmarks.Tour;

            BookmarkRecord changed = null;
            float? newHold = null, newSwivel = null;
            bool newSkip = false;
            for (int i = first; i < last; i++)
            {
                BookmarkRecord record = list[i];
                float ry = top + i * rowH + S(4);
                if ((i & 1) == 0) { _ui.Rect(listX, ry - S(4), cw, rowH - S(4), UiTheme.ROW_STRIPE); }
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

            EndScroll(_tourStopScroll, input, top + list.Count * rowH);

            // Act after drawing (the list must not change while it is being walked)
            if (changed != null)
            {
                Bookmarks.SetTourOverrides(changed, newHold, newSwivel, newSkip);
                if (Bookmarks.LastError != null) { _mediaNotice = Bookmarks.LastError; }
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
            if (settings.Smooth && SmoothTourLength(settings, out stops, out float smooth)) { return smooth; } // K-C
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

        #region Smooth tour and CONVERT TO PATH (Round K-C)

        /// <summary>
        /// The tour's stops as a camera path (a tour is a path whose keys are the bookmarks): each key at the bookmark's
        /// eye (feet + its eye height; crouched ones lower) holding its view for the stop's hold with its swivel, the path
        /// following between them; the speed, fades, loop and UI from the tour.
        /// </summary>
        /// <param name="records">The ticked bookmarks, in order.</param>
        /// <param name="run">The tour's settings.</param>
        /// <param name="standEye">The eye height for bookmarks that kept none (m).</param>
        /// <param name="forStore">
        /// True for CONVERT TO PATH: the keys also copy each bookmark's sun, colour profile, cut and hidden items (the
        /// smooth tour reads those from the bookmarks themselves).
        /// </param>
        private CameraPath TourAsPath(List<BookmarkRecord> records, TourSettings run, float standEye, bool forStore)
        {
            float crouchRatio = _player != null && _player.Controller.StandEye > 0.01f ? _player.Controller.CrouchEye / _player.Controller.StandEye : 0.6f;
            var path = new CameraPath
            {
                Speed = Math.Clamp(run.SmoothSpeed, CameraPath.MIN_SPEED, CameraPath.MAX_SPEED),
                Heading = CameraHeading.Follow,
                FollowBetween = true,
                Level = true,
                FadeSeconds = Math.Clamp(run.FadeSeconds, 0f, CameraPath.MAX_FADE),
                Loop = run.Loop,
                ShowUi = run.ShowUi
            };
            int count = Math.Min(records.Count, CameraPath.MAX_KEYS);
            for (int i = 0; i < count; i++)
            {
                BookmarkRecord record = records[i];
                float eye = (record.EyeHeight ?? standEye) * (record.Crouched && !record.Flying ? crouchRatio : 1f);
                float swivel = run.SwivelFor(record);
                var key = new CameraKey
                {
                    Name = PathStore.CleanName(record.Name) ?? $"Stop {i + 1}",
                    Yaw = record.Yaw,
                    Pitch = Math.Clamp(record.Pitch, -1.5f, 1.5f),
                    Heading = CameraHeading.Key,
                    HoldSeconds = Math.Clamp(run.HoldFor(record), 0f, CameraKey.MAX_HOLD),
                    Swivel = swivel != 0f ? swivel : null,
                    Local = record.Local + new Vector3(0f, 0f, eye)
                };
                if (forStore)
                {
                    key.Sun = record.Sun?.Copy();
                    key.ColourProfile = record.ColourProfile;
                    key.Section = record.Section?.Clone();
                    key.Visibility = record.Visibility?.Copy();
                }
                path.Keys.Add(key);
            }
            return path;
        }

        /// <summary>
        /// The smooth tour's length and stop count for the settings view (no allocation unless the bookmarks or the
        /// settings changed).
        /// </summary>
        /// <returns>False with fewer than two stops (a single stop plays as a fade).</returns>
        private bool SmoothTourLength(TourSettings settings, out int stops, out float length)
        {
            float eye = CurrentStandingEye;
            TourSettings last = _smoothTourFor;
            bool same = last != null && _smoothTourRevision == Bookmarks.Revision && MathF.Abs(_smoothTourEye - eye) < 1e-4f
                && last.SmoothSpeed == settings.SmoothSpeed && last.HoldSeconds == settings.HoldSeconds && last.FadeSeconds == settings.FadeSeconds
                && last.Swivel == settings.Swivel && last.SwivelDegrees == settings.SwivelDegrees && last.SwivelDirection == settings.SwivelDirection
                && last.Loop == settings.Loop;
            if (!same)
            {
                _smoothTourFor = settings.Copy();
                _smoothTourRevision = Bookmarks.Revision;
                _smoothTourEye = eye;
                var records = new List<BookmarkRecord>();
                foreach (BookmarkRecord record in Bookmarks.Bookmarks)
                {
                    if (!record.TourSkip) { records.Add(record); }
                }
                _smoothTourStops = records.Count;
                _smoothTourLength = records.Count >= 2 ? PathTimeline(TourAsPath(records, settings.Copy().Clean(), eye, forStore: false)).Duration : 0f;
            }
            stops = _smoothTourStops;
            length = _smoothTourLength;
            return _smoothTourStops >= 2;
        }

        /// <summary>
        /// CONVERT TO PATH (MEDIA → TOUR): copies the ticked stops into a new camera path ("&lt;model&gt; tour") and
        /// opens it in PATHS. The tour itself is left as it is.
        /// </summary>
        private void ConvertTourToPath()
        {
            FlushTourDraft();
            var records = new List<BookmarkRecord>();
            foreach (BookmarkRecord record in Bookmarks.Bookmarks)
            {
                if (!record.TourSkip) { records.Add(record); }
            }
            if (records.Count == 0)
            {
                _mediaNotice = Bookmarks.Bookmarks.Count == 0
                    ? $"No bookmarks to convert yet: press {Key(InputAction.AddBookmark)} where you want a stop"
                    : "Every bookmark is left out of the tour: tick the stops to convert";
                Sound.Play(SoundId.Error);
                return;
            }

            CameraPath path = TourAsPath(records, Bookmarks.Tour.Copy().Clean(), CurrentStandingEye, forStore: true);
            string model = Path.GetFileNameWithoutExtension(DocumentName);
            path.Name = (string.IsNullOrWhiteSpace(model) ? "Bookmark" : model.Trim()) + " tour";
            CameraPath added = CameraPaths.AddPath(path);
            if (added == null)
            {
                _mediaNotice = CameraPaths.LastError ?? "The path could not be made";
                Sound.Play(SoundId.Error);
                return;
            }

            SwitchMediaTab(MEDIA_PATHS);
            _mediaPath = added;
            _mediaKey = null;
            _pathListScroll.ScrollToEnd();
            string capped = records.Count > CameraPath.MAX_KEYS ? $" (the first {CameraPath.MAX_KEYS})" : string.Empty;
            _mediaNotice = CameraPaths.LastError ?? $"Made “{added.Name}” from {added.Keys.Count} stop{(added.Keys.Count == 1 ? "" : "s")}{capped}: " +
                "each key keeps its bookmark's view, hold, swivel, sun, profile, cut and hidden items · EDIT IN 3D to shape it";
            Sound.Play(SoundId.Commit);
            Utilities.Log_Utils.Write($"Tour converted to path: {added.Name}, {added.Keys.Count} keys.");
        }

        #endregion
    }
}
