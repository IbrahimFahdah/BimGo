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
    /// Round K-A: keyframed camera paths. MEDIA → PATHS lists the model's paths (left) and edits the selected one
    /// (right): its settings in a strip (speed, smoothness, heading, look-ahead, fade, level, loop, UI), its keys in a
    /// list, and the selected key's fields (hold, speed, smoothness, ease, heading and look-at target, sun time, colour
    /// profile; SET TO THIS VIEW, GO TO, reorder, duplicate, delete). PLAY PATH plays it through the tour player (the
    /// same save / restore, keys and HUD bar); RECORD VIDEO records it. Saved like bookmarks (<see cref="PathStore"/>).
    /// <para>Editing in 3D (the path drawn, K / ← / → in flight, the gizmo, a scrubber) is build K-B's.</para>
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>A path's cached timing for the lists (rebuilt when the store changes, never per frame).</summary>
        private readonly struct PathStats
        {
            public PathStats(float duration, float length, string label)
            {
                Duration = duration;
                Length = length;
                Label = label;
            }

            public float Duration { get; }
            public float Length { get; }
            public string Label { get; }
        }

        private static readonly string[] PATH_HEADING_OPTIONS = { "Follow path", "Key views" };
        private static readonly string[] KEY_EASE_OPTIONS = { "Auto", "On", "Off" };
        private static readonly string[] KEY_HEADING_OPTIONS = { "Path", "Follow", "Own view", "Look at" };

        /// <summary>Distance a look-at target goes ahead of the eye when nothing is aimed at (m).</summary>
        private const float TARGET_FALLBACK_DISTANCE = 10f;

        private CameraPath _mediaPath;
        private CameraKey _mediaKey;
        private CameraPath _pathDeleteArmed;
        private CameraKey _keyDeleteArmed;
        private float _pathDeleteArmedUntil;
        private readonly ScrollRegion _pathListScroll = new(), _keyListScroll = new(), _keyEditorScroll = new();

        private readonly Dictionary<CameraPath, PathStats> _pathStats = new();
        private int _pathStatsRevision = -1, _pathStatsUnits = -1;

        #endregion

        /// <summary>Round K-A: the model's camera paths.</summary>
        public PathStore CameraPaths { get; private set; }

        #region Setup

        /// <summary>Creates the path store: embedded in a .bimgo, else paths.json in the model folder.</summary>
        private void InitialisePaths()
        {
            if (IsFileMode)
            {
                CameraPaths = new PathStore(null, Scene.ModelTitle, Scene.OriginOffset);
                CameraPaths.LoadFrom(_options.Document?.Paths);
            }
            else
            {
                CameraPaths = new PathStore(CameraPathFiles.SidecarFor(Scene.CommentsPath), Scene.ModelTitle, Scene.OriginOffset);
                CameraPaths.Load();
            }
            CameraPaths.Changed += UpdateTitle;
        }

        #endregion

        #region Timing

        /// <summary>
        /// The playback keys of a path, resolved: scene-local, the path's defaults applied (a look-at key without a
        /// target holds its own view).
        /// </summary>
        private static CameraPathPoint[] PathPoints(CameraPath path)
        {
            var points = new CameraPathPoint[path.Keys.Count];
            for (int i = 0; i < points.Length; i++)
            {
                CameraKey key = path.Keys[i];
                CameraHeading heading = path.HeadingFor(key);
                if (heading == CameraHeading.LookAt && key.TargetLocal == null) { heading = CameraHeading.Key; }
                points[i] = new CameraPathPoint(key.Local, key.Yaw, key.Pitch, heading, key.TargetLocal ?? key.Local,
                    path.SmoothnessFor(key), path.SpeedFor(key), key.HoldSeconds, path.EasesAt(i), (key.Swivel ?? 0f) * DEGREES); // K-C: the swivel
            }
            return points;
        }

        /// <summary>A path's timeline (allocates: on start and when the store changes).</summary>
        private CameraPathTimeline PathTimeline(CameraPath path) =>
            new(PathPoints(path), new CameraPathSettings(path.Loop, path.FadeSeconds, path.LookAhead, path.Level, path.FollowBetween), CurrentStandingEye);

        /// <summary>Rebuilds every path's cached duration, length and list label when the store has changed.</summary>
        private void RefreshPathStats()
        {
            if (_pathStatsRevision == CameraPaths.Revision && _pathStatsUnits == UnitFormat.Revision) { return; }
            _pathStatsRevision = CameraPaths.Revision;
            _pathStatsUnits = UnitFormat.Revision;
            _pathStats.Clear();
            foreach (CameraPath path in CameraPaths.Paths)
            {
                float duration = 0f, length = 0f;
                if (path.Keys.Count >= 2)
                {
                    CameraPathTimeline timeline = PathTimeline(path);
                    duration = timeline.Duration;
                    length = timeline.Length;
                }
                int seconds = (int)MathF.Round(duration);
                string keys = path.Keys.Count == 1 ? "1 key" : $"{path.Keys.Count} keys";
                string label = path.Keys.Count < 2
                    ? keys + " · add keys to play it"
                    : $"{keys} · {UnitFormat.Length(length, 1)} · {seconds / 60}:{seconds % 60:00}{(path.Loop ? " · loop" : string.Empty)}";
                _pathStats[path] = new PathStats(duration, length, label);
            }
        }

        /// <summary>A path's list label ("6 keys · 48.2 m · 0:36").</summary>
        private string PathStatsLabel(CameraPath path) => _pathStats.TryGetValue(path, out PathStats stats) ? stats.Label : string.Empty;

        /// <summary>A path's duration (s; 0 below two keys).</summary>
        private float PathDuration(CameraPath path)
        {
            RefreshPathStats();
            return _pathStats.TryGetValue(path, out PathStats stats) ? stats.Duration : 0f;
        }

        #endregion

        #region Playback

        /// <summary>
        /// PLAY PATH: plays a camera path through the tour player (the walkthrough comes back as it was at the end).
        /// Keys without a sun take one between their neighbours' (by time), so the sun animates along the path; a key
        /// without a colour profile keeps the one showing.
        /// </summary>
        /// <returns>False (with a notice) when there is nothing to play.</returns>
        private bool StartPath(CameraPath path)
        {
            if (_tourActive || _player == null || path == null) { return false; }
            FlushTourDraft();
            if (path.Keys.Count < 2)
            {
                _mediaNotice = "A path needs two keys or more: fly to each place and ADD KEY HERE";
                Sound.Play(SoundId.Error);
                return false;
            }

            SaveWalkthroughForTour();
            CameraPathTimeline timeline = PathTimeline(path);
            BookmarkRecord[] records = PathRecords(path, timeline);
            var run = new TourSettings { ShowUi = path.ShowUi, Loop = path.Loop };
            BeginTour(timeline, records, run, path);
            Utilities.Log_Utils.Write($"Path started: {path.Name}, {path.Keys.Count} keys, {timeline.Length:0.0} m, {timeline.Duration:0.0} s, loop {path.Loop}.");
            return true;
        }

        /// <summary>
        /// Each key's state as a record for the tour player (playback, the 3D editor's preview, key photos): name, the sun
        /// (filled in between keyed suns), and the colour profile, cut and hidden items carried on from the key that set
        /// them (Round K-C: cut and hidden items; before any key sets one, the walkthrough's).
        /// </summary>
        private static BookmarkRecord[] PathRecords(CameraPath path, CameraPathTimeline timeline)
        {
            var records = new BookmarkRecord[path.Keys.Count];
            string profile = null;
            SectionCut section = null;
            VisibilitySettings visibility = null;
            for (int i = 0; i < records.Length; i++)
            {
                CameraKey key = path.Keys[i];
                profile = key.ColourProfile ?? profile;
                section = key.Section ?? section;
                visibility = key.Visibility ?? visibility;
                records[i] = new BookmarkRecord
                {
                    Name = key.Name, Local = key.Local, Sun = SunForKey(path, timeline, i), ColourProfile = profile, Section = section, Visibility = visibility
                };
            }
            return records;
        }

        /// <summary>
        /// A key's sun for playback: its own; else between the nearest keys before and after that have one (by the time
        /// each is reached); else the nearest one's; else null (the walkthrough's).
        /// </summary>
        private static SunTime SunForKey(CameraPath path, CameraPathTimeline timeline, int index)
        {
            if (path.Keys[index].Sun != null) { return path.Keys[index].Sun.Copy(); }
            int before = -1, after = -1;
            for (int i = index - 1; i >= 0; i--)
            {
                if (path.Keys[i].Sun != null) { before = i; break; }
            }
            for (int i = index + 1; i < path.Keys.Count; i++)
            {
                if (path.Keys[i].Sun != null) { after = i; break; }
            }
            if (before < 0 && after < 0) { return null; }
            if (before < 0) { return path.Keys[after].Sun.Copy(); }
            if (after < 0) { return path.Keys[before].Sun.Copy(); }

            float t0 = timeline.StartOf(before), t1 = timeline.StartOf(after), t = timeline.StartOf(index);
            float u = t1 > t0 ? Math.Clamp((t - t0) / (t1 - t0), 0f, 1f) : 0f;
            var sun = new SunTime();
            double minutes = SunBlend.Between(path.Keys[before].Sun, path.Keys[after].Sun, u, DateTime.Today.Year, sun); // K-C: the short way round
            sun.Minutes = Math.Clamp((int)Math.Round(minutes), 0, 1439);
            return sun;
        }

        #endregion

        #region Selection

        /// <summary>Drops a selection that is no longer in the store (deleted, or the store reloaded).</summary>
        private void ValidatePathSelection()
        {
            if (_mediaPath != null && !CameraPaths.Paths.Contains(_mediaPath)) { _mediaPath = null; }
            if (_mediaPath == null && CameraPaths.Paths.Count > 0) { _mediaPath = CameraPaths.Paths[0]; }
            if (_mediaKey != null && (_mediaPath == null || !_mediaPath.Keys.Contains(_mediaKey))) { _mediaKey = null; }
        }

        /// <summary>The camera's view now (for ADD KEY HERE / SET TO THIS VIEW): the eye shown, the player's look.</summary>
        private void CurrentView(out Vector3 eye, out float yaw, out float pitch)
        {
            eye = Camera.Position;
            yaw = _player.Yaw;
            pitch = _player.Pitch;
        }

        /// <summary>
        /// GO TO: closes the panel and flies the player to a key's view (fly mode, the eye on the key), ready to adjust
        /// it and come back (the media key) to SET TO THIS VIEW.
        /// </summary>
        private void GoToKey(CameraPath path, CameraKey key)
        {
            if (path == null || key == null || _player == null) { return; }
            _mediaPath = path;
            _mediaKey = key;
            CloseMediaPanel();
            SetPaused(false);
            if (!_player.Flying) { _player.ToggleFly(); }
            _player.TeleportTo(key.Local - new Vector3(0f, 0f, _player.Controller.StandEye), key.Yaw, key.Pitch);
            Sound.Play(SoundId.Teleport);
            Flash(UiTheme.BOOKMARK, 0.2f);
            Toast($"{key.Name} of {path.Name}: fly to adjust, then {Key(InputAction.MediaPanel)} → SET TO THIS VIEW", 4f);
        }

        #endregion

        #region Tab

        /// <summary>
        /// PATHS: the path list on the left; the selected path's settings, keys and key editor on the right.
        /// </summary>
        private void BuildPathsTab(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            RefreshPathStats();
            ValidatePathSelection();
            if ((_pathDeleteArmed != null || _keyDeleteArmed != null) && _clock > _pathDeleteArmedUntil)
            {
                _pathDeleteArmed = null;
                _keyDeleteArmed = null;
            }

            float lw = MathF.Min(S(270), w * 0.26f);
            BuildPathList(f, input, x, y, lw, bottom);
            if (!_mediaOpen) { return; }

            float rx = x + lw + S(UiTheme.GAP_LARGE), rw = w - lw - S(UiTheme.GAP_LARGE);
            _ui.Rect(rx - S(10), y, MathF.Max(1f, UiScale), bottom - y, UiTheme.DIVIDER);
            if (_mediaPath == null)
            {
                _ui.TextWrapped(f.Body, rx, y + S(8), rw, HINT_PATHS_EMPTY.Text, UiTheme.TEXT_MUTED, maxLines: 4);
                return;
            }

            CameraPath path = _mediaPath;
            float cy = BuildPathSettings(f, input, path, rx, y, rw);
            if (CameraPaths.LastError != null) { _mediaNotice = CameraPaths.LastError; }
            BuildKeyArea(f, input, path, rx, cy, rw, bottom);
        }

        /// <summary>The path list: NEW PATH, the paths (name, keys · length · time), the selected path's buttons.</summary>
        private void BuildPathList(FontAtlas f, InputState input, float x, float y, float w, float bottom)
        {
            bool add = SmallButton(f, input, x, y, w, S(30), "NEW PATH");
            float listTop = y + S(38);
            bool selected = _mediaPath != null;
            float controlsH = selected ? S(30) * 3 + S(8) * 2 + S(10) : 0f; // K-C: a third row (PHOTOS OF ALL KEYS)
            float listBottom = bottom - controlsH;

            float rowH = S(52);
            List<CameraPath> list = CameraPaths.Paths;
            float top = BeginScroll(_pathListScroll, input, x, listTop, w, listBottom - listTop, out float cw);
            VisibleRows(_pathListScroll, rowH, list.Count, out int first, out int last);
            CameraPath picked = null;
            for (int i = first; i < last; i++)
            {
                CameraPath path = list[i];
                float ry = top + i * rowH;
                bool on = ReferenceEquals(path, _mediaPath);
                if (on)
                {
                    _ui.Rect(x, ry, cw, rowH - S(4), Rgba.WithAlpha(UiTheme.ACCENT, 0.16f));
                    _ui.Rect(x, ry, S(3), rowH - S(4), UiTheme.ACCENT);
                }
                else if ((i & 1) == 0) { _ui.Rect(x, ry, cw, rowH - S(4), UiTheme.ROW_STRIPE); }
                if (Hover(input, x, ry, cw, rowH - S(4)) && input.LeftPressed && !on)
                {
                    input.ConsumeClicks();
                    Sound.Play(SoundId.UiClick);
                    picked = path;
                }
                _ui.TextWrapped(f.Bold, x + S(12), ry + S(6), cw - S(20), path.Name, on ? UiTheme.TEXT : UiTheme.TEXT_SOFT, maxLines: 1);
                _ui.TextWrapped(f.Small, x + S(12), ry + S(28), cw - S(20), PathStatsLabel(path), UiTheme.TEXT_MUTED, maxLines: 1);
            }
            EndScroll(_pathListScroll, input, top + list.Count * rowH);
            if (list.Count == 0) { _ui.TextWrapped(f.Small, x, listTop + S(4), w, "No paths yet", UiTheme.TEXT_FAINT, maxLines: 1); }

            // The selected path's buttons
            bool rename = false, duplicate = false, up = false, down = false, delete = false, photos = false;
            if (selected)
            {
                float by = listBottom + S(10), gap = S(6), half = (w - gap) * 0.5f, third = (w - gap * 2f) / 3f;
                rename = SmallButton(f, input, x, by, half, S(30), "RENAME…");
                duplicate = SmallButton(f, input, x + half + gap, by, half, S(30), "DUPLICATE");
                by += S(38);
                up = SmallButton(f, input, x, by, third, S(30), "↑");
                down = SmallButton(f, input, x + third + gap, by, third, S(30), "↓");
                bool armed = ReferenceEquals(_pathDeleteArmed, _mediaPath);
                delete = SmallButton(f, input, x + (third + gap) * 2f, by, third, S(30), armed ? "SURE?" : "DELETE", danger: true);
                by += S(38);
                photos = SmallButton(f, input, x, by, w, S(30), "PHOTOS OF ALL KEYS"); // K-C
            }

            // Act after drawing (the list must not change while it is being walked)
            if (picked != null)
            {
                _mediaPath = picked;
                _mediaKey = null;
                _keyListScroll.Reset();
                _keyEditorScroll.Reset();
                _pathDeleteArmed = null;
                _keyDeleteArmed = null;
            }
            else if (add)
            {
                _mediaPath = CameraPaths.AddPath();
                _mediaKey = null;
                _pathListScroll.ScrollToEnd();
                _mediaNotice = CameraPaths.LastError ?? $"Made “{_mediaPath.Name}”: ADD KEY HERE adds this view; fly to the next place ({Key(InputAction.MediaPanel)} brings you back) and add again";
                Sound.Play(SoundId.Commit);
            }
            else if (rename)
            {
                CameraPath target = _mediaPath;
                BeginTextEdit("PATH NAME", target.Name, PathStore.MAX_NAME, text =>
                {
                    if (!CameraPaths.Rename(target, text)) { return; }
                    _mediaNotice = CameraPaths.LastError ?? $"Renamed “{target.Name}”";
                });
            }
            else if (duplicate)
            {
                CameraPath copy = CameraPaths.Duplicate(_mediaPath);
                if (copy != null)
                {
                    _mediaPath = copy;
                    _mediaKey = null;
                    _mediaNotice = CameraPaths.LastError ?? $"Made “{copy.Name}”";
                    Sound.Play(SoundId.Commit);
                }
            }
            else if (up || down)
            {
                CameraPaths.Move(_mediaPath, up ? -1 : +1);
                _mediaNotice = CameraPaths.LastError;
            }
            else if (photos)
            {
                StartKeyPhotos(_mediaPath); // K-C
            }
            else if (delete)
            {
                if (ReferenceEquals(_pathDeleteArmed, _mediaPath))
                {
                    string name = _mediaPath.Name;
                    if (ReferenceEquals(_videoPath, _mediaPath)) { _videoPath = null; }
                    CameraPaths.Remove(_mediaPath);
                    _mediaPath = null;
                    _mediaKey = null;
                    _pathDeleteArmed = null;
                    _mediaNotice = CameraPaths.LastError ?? $"Deleted “{name}”";
                    Sound.Play(SoundId.Remove);
                    ValidatePathSelection();
                }
                else
                {
                    _pathDeleteArmed = _mediaPath;
                    _keyDeleteArmed = null;
                    _pathDeleteArmedUntil = _clock + 3f;
                }
            }
        }

        /// <summary>
        /// The path's settings strip: speed, smoothness and heading; look-ahead, fade, level, loop and UI; the summary.
        /// </summary>
        /// <returns>The y below the strip.</returns>
        private float BuildPathSettings(FontAtlas f, InputState input, CameraPath path, float x, float y, float w)
        {
            bool changed = false;
            float fx = x, fy = y, rowH = S(38), gap = S(16);
            float blockW = S(260);

            // Places a block in the strip, starting a new row when it doesn't fit
            void Place(float width)
            {
                if (fx > x && fx + width > x + w)
                {
                    fx = x;
                    fy += rowH;
                }
            }

            Place(blockW);
            float speed = PathStepper(f, input, fx, fy, "Speed", path.Speed, 0.25f, CameraPath.MIN_SPEED, CameraPath.MAX_SPEED, 2, " m/s", own: true, out _);
            if (speed != path.Speed) { path.Speed = speed; changed = true; }
            fx += blockW + gap;

            Place(blockW);
            float smooth = PathStepper(f, input, fx, fy, "Smoothness", path.Smoothness * 100f, 10f, 0f, 100f, 0, " %", own: true, out _) / 100f;
            if (MathF.Abs(smooth - path.Smoothness) > 1e-4f) { path.Smoothness = smooth; changed = true; }
            fx += blockW + gap;

            float headingW = MathF.Min(S(240), w);
            Place(headingW);
            int shownHeading = path.Heading == CameraHeading.Key ? 1 : 0;
            int heading = Segmented(f, input, fx, fy, headingW, PATH_HEADING_OPTIONS, shownHeading);
            if (heading != shownHeading) { path.Heading = heading == 1 ? CameraHeading.Key : CameraHeading.Follow; changed = true; }
            fx = x;
            fy += rowH;

            Place(blockW);
            float ahead = PathStepper(f, input, fx, fy, "Look ahead", path.LookAhead, 0.5f, CameraPath.MIN_LOOK_AHEAD, CameraPath.MAX_LOOK_AHEAD, 1, " m", own: true, out _);
            if (ahead != path.LookAhead) { path.LookAhead = ahead; changed = true; }
            fx += blockW + gap;

            Place(blockW);
            float fade = PathStepper(f, input, fx, fy, "Fade", path.FadeSeconds, 0.25f, 0f, CameraPath.MAX_FADE, 2, " s", own: true, out _);
            if (fade != path.FadeSeconds) { path.FadeSeconds = fade; changed = true; }
            fx += blockW + gap;

            float checkW = S(110);
            Place(checkW * 3f);
            bool level = Checkbox(f, input, fx, fy + S(8), checkW - S(6), "Level", path.Level);
            if (level != path.Level) { path.Level = level; changed = true; }
            bool loop = Checkbox(f, input, fx + checkW, fy + S(8), checkW - S(6), "Loop", path.Loop);
            if (loop != path.Loop) { path.Loop = loop; changed = true; }
            bool ui = Checkbox(f, input, fx + checkW * 2f, fy + S(8), checkW - S(6), "Show UI", path.ShowUi);
            if (ui != path.ShowUi) { path.ShowUi = ui; changed = true; }
            fx += checkW * 3f + gap;

            // K-C: between two keys with their own views, follow the path in the middle (a converted tour has it on)
            float betweenW = S(210);
            Place(betweenW);
            bool between = Checkbox(f, input, fx, fy + S(8), betweenW - S(6), "Follow between key views", path.FollowBetween);
            if (between != path.FollowBetween) { path.FollowBetween = between; changed = true; }
            fy += rowH;

            if (changed)
            {
                CameraPaths.Touch(path);
                RefreshPathStats();
            }

            // Summary
            _ui.TextWrapped(f.Mono, x, fy + S(2), w, PathStatsLabel(path), UiTheme.TEXT_SOFT, maxLines: 1);
            fy += S(28);
            _ui.Rect(x, fy, w, MathF.Max(1f, UiScale), UiTheme.DIVIDER);
            return fy + S(10);
        }

        /// <summary>
        /// A compact labelled stepper: label, −, the value, + (and, for a key's own value, × back to the path's).
        /// </summary>
        /// <param name="own">True when the value is set here (bright); false when it is the path's (faint, no ×).</param>
        /// <param name="reset">True when × was pressed.</param>
        /// <returns>The new value (stepped and clamped), or the old one.</returns>
        private float PathStepper(FontAtlas f, InputState input, float x, float y, string label, float value, float step, float min, float max, int decimals,
            string unit, bool own, out bool reset, bool resettable = false)
        {
            reset = false;
            float labelW = S(92), button = S(28), valueW = S(96);
            _ui.Text(f.Body, x, y + S(6), label, UiTheme.TEXT_SOFT);
            float bx = x + labelW;
            float changed = value;
            if (SmallButton(f, input, bx, y, button, S(30), "−")) { changed = value - step; }
            Text.Clear().Append(value, decimals).Append(unit);
            _ui.TextCentred(f.Bold, bx + button + valueW * 0.5f, y + S(6), Text.Span, own ? Rgba.Hex(0x67E8F9) : UiTheme.TEXT_FAINT);
            if (SmallButton(f, input, bx + button + valueW, y, button, S(30), "+")) { changed = value + step; }
            if (resettable && own && SmallButton(f, input, bx + button * 2f + valueW + S(4), y, button, S(30), "×")) { reset = true; }
            return changed == value ? value : MathF.Round(Math.Clamp(changed, min, max) / step) * step;
        }

        /// <summary>The key list (left) and the selected key's editor (right).</summary>
        private void BuildKeyArea(FontAtlas f, InputState input, CameraPath path, float x, float y, float w, float bottom)
        {
            float kw = MathF.Min(S(330), w * 0.42f);
            BuildKeyList(f, input, path, x, y, kw, bottom);
            float ex = x + kw + S(UiTheme.GAP_LARGE), ew = w - kw - S(UiTheme.GAP_LARGE);
            BuildKeyEditor(f, input, path, ex, y, ew, bottom);
        }

        /// <summary>The keys: ADD KEY HERE, then one row each (number, name, what it does).</summary>
        private void BuildKeyList(FontAtlas f, InputState input, CameraPath path, float x, float y, float w, float bottom)
        {
            _ui.Text(f.Small, x, y + S(8), "KEYS", UiTheme.TEXT_MUTED, S(1.8f));
            float addW = MathF.Min(S(150), w * 0.55f);
            bool add = SmallButton(f, input, x + w - addW, y, addW, S(30), "ADD KEY HERE");
            float listTop = y + S(40);

            List<CameraKey> keys = path.Keys;
            float rowH = S(44);
            if (keys.Count == 0)
            {
                _ui.TextWrapped(f.Small, x, listTop, w, HINT_KEYS_EMPTY.Text, UiTheme.TEXT_MUTED, maxLines: 5);
            }
            float top = BeginScroll(_keyListScroll, input, x, listTop, w, bottom - listTop, out float cw);
            VisibleRows(_keyListScroll, rowH, keys.Count, out int first, out int last);
            CameraKey picked = null;
            for (int i = first; i < last; i++)
            {
                CameraKey key = keys[i];
                float ry = top + i * rowH;
                bool on = ReferenceEquals(key, _mediaKey);
                if (on)
                {
                    _ui.Rect(x, ry, cw, rowH - S(4), Rgba.WithAlpha(UiTheme.ACCENT, 0.16f));
                    _ui.Rect(x, ry, S(3), rowH - S(4), UiTheme.ACCENT);
                }
                else if ((i & 1) == 0) { _ui.Rect(x, ry, cw, rowH - S(4), UiTheme.ROW_STRIPE); }
                if (Hover(input, x, ry, cw, rowH - S(4)) && input.LeftPressed && !on)
                {
                    input.ConsumeClicks();
                    Sound.Play(SoundId.UiClick);
                    picked = key;
                }
                Text.Clear().Append(i + 1);
                _ui.Text(f.Mono, x + S(10), ry + S(5), Text.Span, UiTheme.BOOKMARK_LABEL);
                _ui.TextWrapped(f.Bold, x + S(40), ry + S(4), cw - S(48), key.Name, on ? UiTheme.TEXT : UiTheme.TEXT_SOFT, maxLines: 1);
                AppendKeyDetail(path, key, i);
                _ui.TextWrapped(f.Small, x + S(40), ry + S(24), cw - S(48), Text.Span, UiTheme.TEXT_MUTED, maxLines: 1);
            }
            EndScroll(_keyListScroll, input, top + keys.Count * rowH);

            if (picked != null)
            {
                _mediaKey = picked;
                _keyDeleteArmed = null;
                _keyEditorScroll.Reset();
            }
            else if (add)
            {
                // After the selected key (or at the end)
                CurrentView(out Vector3 eye, out float yaw, out float pitch);
                int index = _mediaKey != null ? keys.IndexOf(_mediaKey) + 1 : keys.Count;
                CameraKey key = CameraPaths.AddKey(path, index, eye, yaw, pitch);
                if (key == null)
                {
                    _mediaNotice = $"A path holds at most {CameraPath.MAX_KEYS} keys";
                    Sound.Play(SoundId.Error);
                }
                else
                {
                    _mediaKey = key;
                    if (index >= keys.Count - 1) { _keyListScroll.ScrollToEnd(); }
                    _mediaNotice = CameraPaths.LastError ?? $"Added “{key.Name}” at this view · fly to the next place and {Key(InputAction.MediaPanel)} → ADD KEY HERE";
                    Sound.Play(SoundId.Commit);
                    Flash(UiTheme.BOOKMARK, 0.15f);
                }
            }
        }

        /// <summary>A key row's detail into <see cref="Text"/>: hold, own speed, heading, sun, profile (no allocation).</summary>
        private void AppendKeyDetail(CameraPath path, CameraKey key, int index)
        {
            Text.Clear();
            int parts = 0;
            void Separator()
            {
                if (parts++ > 0) { Text.Append(" · "); }
            }
            if (key.HoldSeconds > 0f) { Separator(); Text.Append("hold ").Append(key.HoldSeconds, 1).Append(" s"); }
            else if (path.EasesAt(index)) { Separator(); Text.Append("eases"); }
            if (key.Speed is float speed) { Separator(); Text.Append(speed, 2).Append(" m/s"); }
            switch (path.HeadingFor(key))
            {
                case CameraHeading.Key: Separator(); Text.Append("own view"); break;
                case CameraHeading.LookAt: Separator(); Text.Append(key.HasTarget ? "looks at a point" : "look at (no target)"); break;
            }
            if (key.Sun != null)
            {
                Separator();
                Text.Append("sun ").Append(key.Sun.Minutes / 60).Append(':');
                AppendTwoDigits(key.Sun.Minutes % 60);
            }
            if (key.ColourProfile != null) { Separator(); Text.Append(key.ColourProfile.Length == 0 ? "profile off" : "profile"); }
            if (key.Swivel is float swivel && key.HoldSeconds > 0f && path.HeadingFor(key) == CameraHeading.Key) { Separator(); Text.Append("swivel ").Append(swivel, 0).Append('°'); } // K-C
            if (key.Section != null || key.Visibility != null) { Separator(); Text.Append("cut / hidden"); } // K-C
            if (parts == 0) { Text.Append("passes through"); }
        }

        /// <summary>
        /// The selected key's fields (a scroll region): name, view buttons, order, hold, speed, smoothness, ease,
        /// heading (and target), sun, colour profile.
        /// </summary>
        private void BuildKeyEditor(FontAtlas f, InputState input, CameraPath path, float x, float y, float w, float bottom)
        {
            CameraKey key = _mediaKey;
            if (key == null)
            {
                _ui.TextWrapped(f.Body, x, y + S(8), w, path.Keys.Count == 0 ? "The selected key's settings show here." : "Pick a key on the left to edit it.",
                    UiTheme.TEXT_FAINT, maxLines: 3);
                return;
            }
            int index = path.Keys.IndexOf(key);
            float cy = BeginScroll(_keyEditorScroll, input, x, y, w, bottom - y, out float cw);
            float gap = S(6);
            bool changed = false;

            // Name
            Text.Clear().Append("KEY ").Append(index + 1).Append(" OF ").Append(path.Keys.Count);
            _ui.Text(f.Small, x, cy + S(2), Text.Span, UiTheme.TEXT_MUTED, S(1.6f));
            bool rename = SmallButton(f, input, x + cw - S(100), cy, S(100), S(26), "RENAME…");
            cy += S(24);
            _ui.TextWrapped(f.Bold, x, cy, cw, key.Name, UiTheme.TEXT, maxLines: 1);
            cy += S(30);

            // The view and the order
            float half = (cw - gap) * 0.5f;
            bool setView = SmallButton(f, input, x, cy, half, S(30), "SET TO THIS VIEW");
            bool goTo = SmallButton(f, input, x + half + gap, cy, half, S(30), "GO TO");
            cy += S(36);
            float quarter = (cw - gap * 3f) / 4f;
            bool up = SmallButton(f, input, x, cy, quarter, S(30), "↑");
            bool down = SmallButton(f, input, x + quarter + gap, cy, quarter, S(30), "↓");
            bool duplicate = SmallButton(f, input, x + (quarter + gap) * 2f, cy, quarter, S(30), "DUPLICATE");
            bool armed = ReferenceEquals(_keyDeleteArmed, key);
            bool delete = SmallButton(f, input, x + (quarter + gap) * 3f, cy, quarter, S(30), armed ? "SURE?" : "DELETE", danger: true);
            cy += S(36);
            bool photo = SmallButton(f, input, x, cy, cw, S(30), "PHOTO AT THIS KEY"); // K-C
            cy += S(44);

            // Motion
            float hold = PathStepper(f, input, x, cy, "Hold", key.HoldSeconds, 0.5f, 0f, CameraKey.MAX_HOLD, 1, " s", own: key.HoldSeconds > 0f, out _);
            if (hold != key.HoldSeconds) { key.HoldSeconds = hold; changed = true; }
            cy += S(38);
            float speed = PathStepper(f, input, x, cy, "Speed", path.SpeedFor(key), 0.25f, CameraPath.MIN_SPEED, CameraPath.MAX_SPEED, 2, " m/s",
                own: key.Speed.HasValue, out bool resetSpeed, resettable: true);
            if (resetSpeed) { key.Speed = null; changed = true; }
            else if (speed != path.SpeedFor(key)) { key.Speed = speed; changed = true; }
            cy += S(38);
            float smooth = PathStepper(f, input, x, cy, "Smoothness", path.SmoothnessFor(key) * 100f, 10f, 0f, 100f, 0, " %",
                own: key.Smoothness.HasValue, out bool resetSmooth, resettable: true) / 100f;
            if (resetSmooth) { key.Smoothness = null; changed = true; }
            else if (MathF.Abs(smooth - path.SmoothnessFor(key)) > 1e-4f) { key.Smoothness = smooth; changed = true; }
            cy += S(40);

            _ui.Text(f.Body, x, cy + S(7), "Ease", UiTheme.TEXT_SOFT);
            int ease = Segmented(f, input, x + S(92), cy, MathF.Min(S(240), cw - S(92)), KEY_EASE_OPTIONS, key.Ease is bool e ? (e ? 1 : 2) : 0);
            bool? newEase = ease == 1 ? true : ease == 2 ? false : null;
            if (newEase != key.Ease) { key.Ease = newEase; changed = true; }
            cy += S(36);
            if (key.HoldSeconds > 0f) { _ui.Text(f.Small, x + S(92), cy, "A key that holds always eases", UiTheme.TEXT_FAINT); cy += S(20); }
            cy += S(8);

            // Heading
            _ui.Text(f.Body, x, cy + S(7), "Heading", UiTheme.TEXT_SOFT);
            int headingIndex = key.Heading switch { CameraHeading.Follow => 1, CameraHeading.Key => 2, CameraHeading.LookAt => 3, _ => 0 };
            int pickedHeading = Segmented(f, input, x + S(92), cy, cw - S(92), KEY_HEADING_OPTIONS, headingIndex);
            if (pickedHeading != headingIndex)
            {
                key.Heading = pickedHeading switch { 1 => CameraHeading.Follow, 2 => CameraHeading.Key, 3 => CameraHeading.LookAt, _ => null };
                changed = true;
            }
            cy += S(38);
            bool setTarget = false, clearTarget = false;
            switch (path.HeadingFor(key))
            {
                case CameraHeading.Key:
                    cy += _ui.TextWrapped(f.Small, x + S(92), cy, cw - S(92), "Holds the view this key was set with (SET TO THIS VIEW changes it); the camera turns into it and back out",
                        UiTheme.TEXT_FAINT, maxLines: 2) + S(8);
                    break;
                case CameraHeading.LookAt:
                    if (key.TargetLocal is Vector3 target)
                    {
                        Text.Clear().Append("Target ").AppendLength(Vector3.Distance(target, key.Local), 1).Append(" from the key");
                        _ui.Text(f.Small, x + S(92), cy + S(8), Text.Span, Rgba.Hex(0x67E8F9));
                    }
                    else
                    {
                        _ui.Text(f.Small, x + S(92), cy + S(8), "No target yet: holds its own view", UiTheme.TEXT_FAINT);
                    }
                    float tw = S(150);
                    setTarget = SmallButton(f, input, x + cw - tw - (key.HasTarget ? S(34) : 0f), cy, tw, S(28), "SET TARGET: AIMED");
                    if (key.HasTarget) { clearTarget = SmallButton(f, input, x + cw - S(28), cy, S(28), S(28), "×"); }
                    cy += S(36);
                    cy += _ui.TextWrapped(f.Small, x + S(92), cy, cw - S(92), "The target is the surface you were aiming at when you opened this panel (or a point 10 m ahead)",
                        UiTheme.TEXT_FAINT, maxLines: 2) + S(8);
                    break;
                default:
                    cy += _ui.TextWrapped(f.Small, x + S(92), cy, cw - S(92), "Looks ahead along the path, turning with it", UiTheme.TEXT_FAINT, maxLines: 1) + S(8);
                    break;
            }

            // Sun
            _ui.Text(f.Body, x, cy + S(7), "Sun", UiTheme.TEXT_SOFT);
            float sx = x + S(92);
            if (key.Sun != null)
            {
                Text.Clear().Append(key.Sun.Day).Append('/').Append(key.Sun.Month).Append("  ");
                AppendTwoDigits(key.Sun.Minutes / 60).Append(':');
                AppendTwoDigits(key.Sun.Minutes % 60);
                _ui.Text(f.Bold, sx, cy + S(6), Text.Span, Rgba.Hex(0x67E8F9));
            }
            else
            {
                _ui.Text(f.Small, sx, cy + S(8), "Between its neighbours' (or the walkthrough's)", UiTheme.TEXT_FAINT);
            }
            cy += S(30);
            float sunW = S(72);
            bool sunNow = SmallButton(f, input, sx, cy, S(120), S(28), "USE THE SUN NOW");
            bool sunEarlier = key.Sun != null && SmallButton(f, input, sx + S(126), cy, sunW, S(28), "−30 MIN");
            bool sunLater = key.Sun != null && SmallButton(f, input, sx + S(126) + sunW + gap, cy, sunW, S(28), "+30 MIN");
            bool sunClear = key.Sun != null && SmallButton(f, input, sx + S(126) + (sunW + gap) * 2f, cy, S(28), S(28), "×");
            cy += S(40);

            // Colour profile
            _ui.Text(f.Body, x, cy + S(7), "Profile", UiTheme.TEXT_SOFT);
            string profileLabel = key.ColourProfile == null ? "Leave as it is"
                : key.ColourProfile.Length == 0 ? "None (profiles off)"
                : _appearance.Find(key.ColourProfile)?.Name ?? "(gone)";
            bool cycleProfile = SmallButton(f, input, sx, cy, MathF.Min(S(240), cw - S(92)), S(30), profileLabel);
            cy += S(36);
            _ui.TextWrapped(f.Small, sx, cy, cw - S(92), "Switches at this key; the next keys keep it until one changes it", UiTheme.TEXT_FAINT, maxLines: 2);
            cy += S(34);

            // K-C: the swivel (own view + a hold) and the cut / hidden items
            bool swivelOn = path.HeadingFor(key) == CameraHeading.Key && key.HoldSeconds > 0f;
            float swivelValue = key.Swivel ?? 0f;
            bool resetSwivel = false;
            if (swivelOn)
            {
                float swivel = PathStepper(f, input, x, cy, "Swivel", swivelValue, 15f, -TourSettings.MAX_SWIVEL, TourSettings.MAX_SWIVEL, 0, "°",
                    own: key.Swivel.HasValue, out resetSwivel, resettable: true);
                if (!resetSwivel && swivel != swivelValue) { key.Swivel = swivel == 0f ? null : swivel; changed = true; }
                cy += S(34);
                _ui.Text(f.Small, sx, cy, "Pans over the hold: + turns left, − right", UiTheme.TEXT_FAINT);
                cy += S(26);
            }
            else
            {
                _ui.Text(f.Body, x, cy + S(2), "Swivel", UiTheme.TEXT_SOFT);
                _ui.Text(f.Small, sx, cy + S(4), "With Own view and a hold", UiTheme.TEXT_FAINT);
                cy += S(30);
            }

            _ui.Text(f.Body, x, cy + S(7), "Cut, hidden", UiTheme.TEXT_SOFT);
            AppendKeyStateLabel(key);
            _ui.TextWrapped(f.Small, sx, cy + S(8), cw - S(92), Text.Span, key.Section != null || key.Visibility != null ? Rgba.Hex(0x67E8F9) : UiTheme.TEXT_FAINT, maxLines: 1);
            cy += S(30);
            bool stateNow = SmallButton(f, input, sx, cy, S(120), S(28), "USE THE VIEW NOW");
            bool stateClear = (key.Section != null || key.Visibility != null) && SmallButton(f, input, sx + S(126), cy, S(28), S(28), "×");
            cy += S(36);
            _ui.TextWrapped(f.Small, sx, cy, cw - S(92), "The section cut and hidden items from this key on (a converted tour keeps each bookmark's)", UiTheme.TEXT_FAINT, maxLines: 2);
            cy += S(34);
            EndScroll(_keyEditorScroll, input, cy);

            if (resetSwivel) { key.Swivel = null; changed = true; }
            if (stateNow)
            {
                key.Section = _section.Clone();
                key.Visibility = BookmarkVisibility();
                changed = true;
                _mediaNotice = $"“{key.Name}” keeps the cut and hidden items showing now";
            }
            else if (stateClear)
            {
                key.Section = null;
                key.Visibility = null;
                changed = true;
            }

            // Act after drawing
            if (sunNow)
            {
                key.Sun = _sun.Time.Copy();
                if (_sunPlaying) { key.Sun.Minutes = Math.Clamp((int)_playMinutes, 0, 1439); }
                changed = true;
                if (!ShadowsOn) { _mediaNotice = "Shadows are off now: the path turns them on from this key when it plays"; }
            }
            else if (sunEarlier || sunLater)
            {
                key.Sun.Minutes = Math.Clamp(key.Sun.Minutes + (sunLater ? 30 : -30), 0, 1439);
                changed = true;
            }
            else if (sunClear)
            {
                key.Sun = null;
                changed = true;
            }
            if (cycleProfile)
            {
                key.ColourProfile = NextProfileChoice(key.ColourProfile);
                changed = true;
            }
            if (setTarget)
            {
                Vector3 point = _aim.HasHit ? _aim.Hit.Point : Camera.Position + Camera.Forward * TARGET_FALLBACK_DISTANCE;
                CameraPaths.SetKeyTarget(path, key, point);
                _mediaNotice = CameraPaths.LastError ?? (_aim.HasHit ? "Target set to the aimed surface" : "Nothing aimed at: the target is 10 m ahead of the view");
            }
            else if (clearTarget)
            {
                CameraPaths.SetKeyTarget(path, key, null);
            }
            if (changed)
            {
                CameraPaths.Touch(path);
                RefreshPathStats();
            }

            if (rename)
            {
                CameraKey target = key;
                BeginTextEdit("KEY NAME", target.Name, PathStore.MAX_NAME, text => CameraPaths.RenameKey(path, target, text));
            }
            else if (setView)
            {
                CurrentView(out Vector3 eye, out float yaw, out float pitch);
                CameraPaths.SetKeyView(path, key, eye, yaw, pitch);
                _mediaNotice = CameraPaths.LastError ?? $"“{key.Name}” now sits at this view";
                Sound.Play(SoundId.Commit);
            }
            else if (goTo)
            {
                GoToKey(path, key);
            }
            else if (photo)
            {
                OpenPhotoAtKey(path, key, returnToEditor: false); // K-C
            }
            else if (up || down)
            {
                CameraPaths.MoveKey(path, key, up ? -1 : +1);
                _mediaNotice = CameraPaths.LastError;
            }
            else if (duplicate)
            {
                if (path.Keys.Count >= CameraPath.MAX_KEYS)
                {
                    _mediaNotice = $"A path holds at most {CameraPath.MAX_KEYS} keys";
                }
                else
                {
                    CameraKey copy = key.Copy();
                    copy.Name = PathStore.CleanName(key.Name + " copy") ?? key.Name;
                    path.Keys.Insert(index + 1, copy);
                    CameraPaths.Touch(path);
                    _mediaKey = copy;
                    _mediaNotice = CameraPaths.LastError ?? $"Made “{copy.Name}” (at the same place: SET TO THIS VIEW moves it)";
                }
            }
            else if (delete)
            {
                if (armed)
                {
                    string name = key.Name;
                    CameraPaths.RemoveKey(path, key);
                    _mediaKey = path.Keys.Count == 0 ? null : path.Keys[Math.Clamp(index, 0, path.Keys.Count - 1)];
                    _keyDeleteArmed = null;
                    _mediaNotice = CameraPaths.LastError ?? $"Deleted “{name}”";
                    Sound.Play(SoundId.Remove);
                }
                else
                {
                    _keyDeleteArmed = key;
                    _pathDeleteArmed = null;
                    _pathDeleteArmedUntil = _clock + 3f;
                }
            }
        }

        /// <summary>
        /// K-C: a key's cut and hidden items into <see cref="Text"/> ("Leave as it is", "a cut · 3 hidden"…; no allocation).
        /// </summary>
        private void AppendKeyStateLabel(CameraKey key)
        {
            Text.Clear();
            if (key.Section == null && key.Visibility == null)
            {
                Text.Append("Leave as it is");
                return;
            }
            if (key.Section != null) { Text.Append(key.Section.IsActive ? "a cut" : "no cut"); }
            if (key.Visibility != null)
            {
                if (key.Section != null) { Text.Append(" · "); }
                int hidden = (key.Visibility.HiddenCategories?.Count ?? 0) + (key.Visibility.HiddenLinks?.Count ?? 0) + (key.Visibility.HiddenElements?.Count ?? 0);
                if (hidden == 0) { Text.Append("shows everything"); }
                else { Text.Append(hidden).Append(" hidden"); }
            }
        }

        /// <summary>The colour profile choice after this one: leave → none → each profile → leave.</summary>
        private string NextProfileChoice(string current)
        {
            List<AppearanceProfile> profiles = _appearance.Profiles;
            if (current == null) { return string.Empty; }
            if (current.Length == 0) { return profiles.Count > 0 ? profiles[0].Id : null; }
            int index = profiles.FindIndex(p => p.Id == current);
            return index >= 0 && index + 1 < profiles.Count ? profiles[index + 1].Id : null;
        }

        #endregion
    }
}
