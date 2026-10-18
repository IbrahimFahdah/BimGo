using System.Numerics;
using BimGo.Audio;
using BimGo.Format;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Round K-B: the camera path editor in 3D (the path editor key, Shift+K by default, or MEDIA → PATHS → EDIT IN 3D).
    /// Like clash mode: a dock on the right, a free cursor, the editor's own fly keys (WASD, E / Q, Shift faster),
    /// RMB-drag looks.
    /// <list type="bullet">
    /// <item><b>Drawn</b>: the path as a line (red where it passes through the model), direction ticks, the keys
    /// (numbered; the selected one larger), each key's view, look-at targets, a marker where K would insert.</item>
    /// <item><b>Keys</b>: K adds a key at the view (on the path: inserted into that segment; after the scrubber placed you:
    /// exactly there); Del deletes the selected key; ← / → snap the camera into the previous / next key; fly and look,
    /// then Enter (SET) writes the view into the key (snapping away leaves it as it was). A click picks a key.</item>
    /// <item><b>Handles</b>: the selected key (or its target) gets X / Y / Z arrows (5 cm steps; Shift: free) and a
    /// view handle (drag it where the key should look; 5° steps).</item>
    /// <item><b>Scrubber</b>: the bar at the bottom (keys as ticks) drives the camera along the path with its heading;
    /// Space plays from there and pauses; stopping leaves you on the path.</item>
    /// <item>Ctrl+Z undoes path changes (this session's, per path). Esc / the editor key leaves (still flying).</item>
    /// </list>
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private static readonly InputAction[] PATH_MOVES =
        {
            InputAction.PathMoveForward, InputAction.PathMoveBack, InputAction.PathMoveLeft, InputAction.PathMoveRight, InputAction.PathFlyFast
        };

        /// <summary>K inserts into the path when the eye is this close to it (m).</summary>
        private const float PATH_ON_DISTANCE = 1f;

        /// <summary>The path line's sample spacing (m; longer paths space them out to <see cref="PATH_MAX_SAMPLES"/>).</summary>
        private const float PATH_SAMPLE_STEP = 0.25f;
        private const int PATH_MAX_SAMPLES = 4000;

        /// <summary>Handle drag steps: position (m) and view (radians).</summary>
        private const float PATH_SNAP = 0.05f, PATH_VIEW_SNAP = 5f * MathF.PI / 180f;

        /// <summary>Undo steps kept per session.</summary>
        private const int PATH_UNDO_MAX = 40;

        private const int PATH_HANDLE_X = 0, PATH_HANDLE_Y = 1, PATH_HANDLE_Z = 2, PATH_HANDLE_VIEW = 3;

        private bool _pathEditOn;
        private string _pathEditNotice;
        private readonly ScrollRegion _pathDockScroll = new();
        private Vector4 _pathDockRect, _pathBarRect;
        private Overlay3D _pathOverlay;

        // The edited path's timeline and its drawing (rebuilt when the store changes; collision when the path rests)
        private CameraPathTimeline _pathEditTimeline;
        private CameraPath _pathEditTimelineFor;
        private int _pathEditRevision = -1;
        private readonly Vector3[] _pathSamples = new Vector3[PATH_MAX_SAMPLES + 1];
        private readonly bool[] _pathBlocked = new bool[PATH_MAX_SAMPLES];
        private int _pathSampleCount;
        private float _pathSampleStep;
        private bool _pathCollisionDirty;
        private int _pathBlockedSegments;

        // Snapped into a key (← / →): the key and the view it was snapped at (moved since: SET writes it)
        private CameraKey _pathSnapped;
        private Vector3 _pathSnapEye;
        private float _pathSnapYaw, _pathSnapPitch;

        // Scrubber and preview; the camera was put on the path there (until it moves)
        private float _pathScrubTime;
        private bool _pathScrubDrag, _pathPreviewPlaying, _pathOnScrub;
        private Vector3 _pathScrubEye;

        // Picking and handles
        private int _pathKeyHover = -1, _pathTargetHover = -1;
        private int _pathHandleHover = -1, _pathHandleDrag = -1;
        private bool _pathSubjectTarget;   // the handles sit on the selected key's look-at target
        private bool _pathPickTarget;      // the next click on a surface sets the selected key's target
        private Vector3 _pathDragOrigin, _pathDragAxis;
        private float _pathDragStartParameter, _pathDragApplied = float.NaN;
        private float _pathDragStartYaw, _pathDragStartPitch;

        // K's insert marker (where on the path a key would go), refreshed per frame
        private bool _pathInsertShown;
        private Vector3 _pathInsertPoint;

        // Undo: (path, snapshot before a change), newest last
        private readonly List<(CameraPath Path, CameraPath Snapshot)> _pathUndo = new();

        // Round K-C: while the camera is on the path (scrubbing, previewing) the path's state shows: its sun (moving
        // between keys), colour profile, cut and hidden items, and (previewing) its fades. The walkthrough's state is put
        // back when the camera leaves the path, the editor closes, or a tour starts.
        private bool _pathEditState;
        private BookmarkRecord[] _pathEditRecords;
        private float _pathEditBlack;

        // K-C: the scrubber's sun strip (the sun's height along the path, rebuilt with the timeline)
        private const int PATH_SUN_CELLS = 96;
        private readonly uint[] _pathSunStrip = new uint[PATH_SUN_CELLS];
        private bool _pathSunStripOn;
        private readonly SunTime _pathStripSun = new();

        #endregion

        /// <summary>True while the player waits for the editor: a preview, a scrub or a handle drag moves the camera.</summary>
        private bool PathFreezesPlayer => _pathEditOn && (_pathPreviewPlaying || _pathScrubDrag || _pathHandleDrag >= 0);

        #region Enter / leave

        /// <summary>
        /// Opens the 3D editor on a path (null: the selected or first one; with no paths, a new one): panels close, the
        /// player flies, the cursor is free.
        /// </summary>
        private void EnterPathEditor(CameraPath path)
        {
            if (_player == null) { return; }
            if (path == null || !CameraPaths.Paths.Contains(path)) { path = CameraPaths.Paths.Count > 0 ? CameraPaths.Paths[0] : CameraPaths.AddPath(); }
            if (_clashModeOn) { ExitClashMode(); }
            CloseMediaPanel();
            CloseBookmarksPanel();
            CloseOverlay();
            ClosePhotoMode();
            CloseSectionEditor();
            CloseSunPanel();
            CloseSunHours();
            CloseGridsPanel();
            if (_guns[_activeGun].CapturesInput) { _guns[_activeGun].OnCancel(); }
            if (_paused) { SetPaused(false); }
            ShowUi();

            if (!ReferenceEquals(_mediaPath, path)) { _mediaKey = null; }
            _mediaPath = path;
            _pathEditOn = true;
            _pathEditNotice = null;
            _pathSnapped = null;
            _pathScrubTime = 0f;
            _pathScrubDrag = _pathPreviewPlaying = _pathOnScrub = false;
            _pathHandleDrag = _pathHandleHover = _pathKeyHover = _pathTargetHover = -1;
            _pathSubjectTarget = _pathPickTarget = false;
            _pathEditRevision = -1;
            _pathDockScroll.Reset();
            if (!_player.Flying) { _player.ToggleFly(); }
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            Sound.Play(SoundId.UiClick);
            Toast($"Path editor: {path.Name} · {Key(InputAction.PathAddKey)} adds a key · {Key(InputAction.PathPreviousKey)} / {Key(InputAction.PathNextKey)} snap into keys · " +
                $"{Key(InputAction.PathSetKey)} sets · {Key(InputAction.PathPreview)} previews · Esc leaves", 5f);
        }

        /// <summary>Leaves the editor (still flying; the path is saved as it is).</summary>
        private void ExitPathEditor()
        {
            if (!_pathEditOn) { return; }
            EndPathDrag();
            EndPathEditState(); // K-C: the walkthrough's sun, profile, cut and hidden items again
            _pathEditOn = false;
            _pathPreviewPlaying = _pathScrubDrag = false;
            _pathSnapped = null;
            _pathPickTarget = false;
            _window.Input.ReleaseAll();
            if (!_paused && _window.IsActive) { _window.SetCaptured(true); }
            Toast($"Path editor closed · still flying ({Key(InputAction.Fly)} walks)", 2.5f);
        }

        #endregion

        #region Frame

        /// <summary>
        /// The editor's keys and mouse (the dock and the scrubber handle their own clicks when they are drawn).
        /// </summary>
        private void UpdatePathEditor(InputState input, float dt)
        {
            CameraPath path = _mediaPath;
            if (path == null || !CameraPaths.Paths.Contains(path))
            {
                ExitPathEditor();
                return;
            }
            ValidatePathSelection();
            EnsurePathTimeline(path);

            // Leaving, or one step back (target picking, the preview)
            if (input.Pressed(InputAction.Back))
            {
                if (_uiHidden) { ShowUi(); }
                else if (_pathPickTarget) { _pathPickTarget = false; }
                else if (_pathPreviewPlaying) { _pathPreviewPlaying = false; }
                else { ExitPathEditor(); }
                return;
            }
            if (input.Pressed(InputAction.PathEditMode))
            {
                ExitPathEditor();
                return;
            }
            if (input.Pressed(InputAction.Help)) { _showHelp = !_showHelp; }
            if (input.Pressed(InputAction.HideUi)) { ToggleUiHidden(); }
            if (input.Pressed(InputAction.Fullscreen)) { _window.ToggleFullscreen(); }
            if (input.Pressed(InputAction.Screenshot)) { RequestScreenshot(); }
            if (input.Down(InputAction.DragLook) && !_pathPreviewPlaying && !_pathScrubDrag) { _player.Look(input.MouseDeltaX, input.MouseDeltaY, _sensitivity, _invertY); }
            UpdateRoom();

            // The preview plays the camera along the path
            if (_pathPreviewPlaying) { AdvancePathPreview(dt); }

            // Off the scrubber's spot once the camera moves
            if (_pathOnScrub && !_pathPreviewPlaying && !_pathScrubDrag && Vector3.DistanceSquared(Camera.Position, _pathScrubEye) > 1e-4f)
            {
                _pathOnScrub = false;
                EndPathEditState(); // K-C
            }

            // Keys
            if (input.Pressed(InputAction.PathUndo)) { UndoPathChange(); }
            else if (input.Pressed(InputAction.PathAddKey)) { AddPathKeyHere(); }
            else if (input.Pressed(InputAction.PathDeleteKey)) { DeleteSelectedPathKey(); }
            else if (input.Pressed(InputAction.PathSetKey)) { SetSelectedPathKey(); }
            else if (input.PressedOrRepeated(InputAction.PathNextKey)) { SnapToPathKey(+1); }
            else if (input.PressedOrRepeated(InputAction.PathPreviousKey)) { SnapToPathKey(-1); }
            else if (input.Pressed(InputAction.PathPreview)) { TogglePathPreview(); }

            // The mouse in the scene (not over the dock or the scrubber)
            Vector2 mouse = input.MousePosition;
            bool overUi = Inside(_pathDockRect, mouse) || Inside(_pathBarRect, mouse) || OverlayOpen;
            if (_pathHandleDrag >= 0)
            {
                if (!input.LeftDown) { EndPathDrag(); }
                else { DragPathHandle(mouse, input.Down(InputAction.PathFlyFast)); }
                _pathInsertShown = false;
                return;
            }

            bool looking = input.Down(InputAction.DragLook);
            _pathHandleHover = overUi || looking || _pathPickTarget ? -1 : PathHandleUnder(mouse);
            _pathKeyHover = overUi || looking || _pathHandleHover >= 0 ? -1 : PathKeyUnder(mouse);
            _pathTargetHover = overUi || looking || _pathHandleHover >= 0 || _pathKeyHover >= 0 ? -1 : PathTargetUnder(mouse);
            UpdatePathInsertMarker();

            if (!input.LeftPressed || overUi) { return; }
            if (_pathPickTarget)
            {
                input.ConsumeClicks();
                PickPathTarget(mouse);
            }
            else if (_pathHandleHover >= 0)
            {
                input.ConsumeClicks();
                BeginPathDrag(_pathHandleHover, mouse);
            }
            else if (_pathKeyHover >= 0)
            {
                input.ConsumeClicks();
                SelectPathKey(path.Keys[_pathKeyHover], target: false);
                Sound.Play(SoundId.UiClick);
            }
            else if (_pathTargetHover >= 0)
            {
                input.ConsumeClicks();
                SelectPathKey(path.Keys[_pathTargetHover], target: true);
                Sound.Play(SoundId.UiClick);
            }
        }

        private static bool Inside(Vector4 rect, Vector2 point) =>
            rect.Z > 0f && point.X >= rect.X && point.X < rect.X + rect.Z && point.Y >= rect.Y && point.Y < rect.Y + rect.W;

        /// <summary>Selects a key (and whether the handles sit on it or on its target).</summary>
        private void SelectPathKey(CameraKey key, bool target)
        {
            _mediaKey = key;
            _pathSubjectTarget = target && key != null && key.TargetLocal.HasValue;
            if (!ReferenceEquals(_pathSnapped, key)) { _pathSnapped = null; }
        }

        #endregion

        #region Timeline, drawing samples, collision

        /// <summary>Rebuilds the timeline and the line's samples when the path changed (allocates only then).</summary>
        private void EnsurePathTimeline(CameraPath path)
        {
            if (ReferenceEquals(_pathEditTimelineFor, path) && _pathEditRevision == CameraPaths.Revision) { return; }
            _pathEditTimelineFor = path;
            _pathEditRevision = CameraPaths.Revision;
            _pathEditTimeline = path.Keys.Count >= 2 ? PathTimeline(path) : null;
            _pathSampleCount = 0;
            _pathBlockedSegments = 0;
            Array.Clear(_pathBlocked);

            // K-C: each key's state (the preview shows it) and the scrubber's sun strip
            _pathEditRecords = _pathEditTimeline != null ? PathRecords(path, _pathEditTimeline) : null;
            if (_pathEditState)
            {
                if (_pathEditRecords == null) { EndPathEditState(); }
                else
                {
                    _tourRecords = _pathEditRecords;
                    _tourAppliedStop = -1;
                    _tourAppliedSun = null;
                    _tourAppliedSection = null;
                    _tourAppliedVisibility = null;
                }
            }
            BuildPathSunStrip();
            if (_pathEditTimeline == null) { return; }

            float length = _pathEditTimeline.Length;
            _pathSampleStep = MathF.Max(PATH_SAMPLE_STEP, length / PATH_MAX_SAMPLES);
            int count = Math.Clamp((int)MathF.Ceiling(length / _pathSampleStep), 1, PATH_MAX_SAMPLES);
            _pathSampleStep = length / count;
            for (int i = 0; i <= count; i++) { _pathSamples[i] = _pathEditTimeline.PointAt(MathF.Min(i * _pathSampleStep, length - 1e-4f)); }
            _pathSampleCount = count + 1;
            _pathCollisionDirty = true;
            _pathScrubTime = Math.Clamp(_pathScrubTime, 0f, _pathEditTimeline.Duration);
        }

        /// <summary>
        /// Marks the gaps between samples that pass through the model (visible static geometry, cuts honoured), and
        /// counts the segments that have one. Run when the path rests (not mid-drag).
        /// </summary>
        private void UpdatePathCollision()
        {
            if (!_pathCollisionDirty || _pathHandleDrag >= 0 || _pathEditTimeline == null) { return; }
            _pathCollisionDirty = false;
            _pathBlockedSegments = 0;
            int lastSegment = -1;
            for (int i = 0; i + 1 < _pathSampleCount; i++)
            {
                Vector3 a = _pathSamples[i], b = _pathSamples[i + 1];
                Vector3 d = b - a;
                float length = d.Length();
                _pathBlocked[i] = length > 1e-4f && PickStaticVisible(a, d / length, length, out _);
                if (_pathBlocked[i])
                {
                    int segment = _pathEditTimeline.SegmentAt((i + 0.5f) * _pathSampleStep);
                    if (segment != lastSegment)
                    {
                        _pathBlockedSegments++;
                        lastSegment = segment;
                    }
                }
            }
        }

        /// <summary>K's insert marker: the nearest point on the path when the eye is within reach of it.</summary>
        private void UpdatePathInsertMarker()
        {
            _pathInsertShown = false;
            if (_pathEditTimeline == null) { return; }
            if (_pathOnScrub)
            {
                _pathInsertShown = true;
                _pathInsertPoint = _pathScrubEye;
                return;
            }
            float distance = _pathEditTimeline.Nearest(Camera.Position, out _, out float along);
            if (distance <= PATH_ON_DISTANCE)
            {
                _pathInsertShown = true;
                _pathInsertPoint = _pathEditTimeline.PointAt(along);
            }
        }

        #endregion

        #region Keys

        /// <summary>
        /// K: a key at the view. Placed by the scrubber: exactly there; within <see cref="PATH_ON_DISTANCE"/> of the path:
        /// into that segment; else after the selected key (or at the end).
        /// </summary>
        private void AddPathKeyHere()
        {
            CameraPath path = _mediaPath;
            CurrentView(out Vector3 eye, out float yaw, out float pitch);
            int index;
            string where;
            if (_pathOnScrub && _pathEditTimeline != null)
            {
                CameraPathPose pose = _pathEditTimeline.Evaluate(_pathScrubTime);
                index = PathInsertIndex(path, _pathEditTimeline.SegmentAt(pose.Distance));
                eye = pose.Eye;
                yaw = pose.Yaw;
                pitch = pose.Pitch;
                where = "on the path at the scrubber";
            }
            else if (_pathEditTimeline != null && _pathEditTimeline.Nearest(eye, out int segment, out _) <= PATH_ON_DISTANCE)
            {
                index = PathInsertIndex(path, segment);
                where = "into the path here";
            }
            else
            {
                int selected = _mediaKey != null ? path.Keys.IndexOf(_mediaKey) : -1;
                index = selected >= 0 ? selected + 1 : path.Keys.Count;
                where = selected >= 0 ? "after the selected key" : "at the end";
            }

            PushPathUndo(path);
            CameraKey key = CameraPaths.AddKey(path, index, eye, yaw, pitch);
            if (key == null)
            {
                _pathUndo.RemoveAt(_pathUndo.Count - 1);
                _pathEditNotice = $"A path holds at most {CameraPath.MAX_KEYS} keys";
                Sound.Play(SoundId.Error);
                return;
            }
            SelectPathKey(key, target: false);
            _pathSnapped = key;
            RememberSnapView();
            _pathEditNotice = CameraPaths.LastError ?? $"Added “{key.Name}” {where} (key {path.Keys.IndexOf(key) + 1} of {path.Keys.Count})";
            Sound.Play(SoundId.Commit);
            Flash(UiTheme.BOOKMARK, 0.12f);
        }

        /// <summary>The key index a key inserted into a segment takes (the segment after the last key: the end).</summary>
        private static int PathInsertIndex(CameraPath path, int segment) => segment < 0 ? path.Keys.Count : Math.Min(segment + 1, path.Keys.Count);

        /// <summary>Del: deletes the selected key (Ctrl+Z brings it back); the next one is selected.</summary>
        private void DeleteSelectedPathKey()
        {
            CameraPath path = _mediaPath;
            CameraKey key = _mediaKey;
            if (key == null)
            {
                _pathEditNotice = "Pick a key first (click it, or ← / →)";
                Sound.Play(SoundId.Error);
                return;
            }
            int index = path.Keys.IndexOf(key);
            PushPathUndo(path);
            CameraPaths.RemoveKey(path, key);
            SelectPathKey(path.Keys.Count == 0 ? null : path.Keys[Math.Clamp(index, 0, path.Keys.Count - 1)], target: false);
            _pathSnapped = null;
            _pathEditNotice = CameraPaths.LastError ?? $"Deleted “{key.Name}” · {Key(InputAction.PathUndo)} brings it back";
            Sound.Play(SoundId.Remove);
        }

        /// <summary>Enter / SET: the selected key takes the view (position and look).</summary>
        private void SetSelectedPathKey()
        {
            CameraPath path = _mediaPath;
            CameraKey key = _mediaKey;
            if (key == null)
            {
                _pathEditNotice = $"Pick a key first ({Key(InputAction.PathPreviousKey)} / {Key(InputAction.PathNextKey)} snap into one)";
                Sound.Play(SoundId.Error);
                return;
            }
            CurrentView(out Vector3 eye, out float yaw, out float pitch);
            PushPathUndo(path);
            CameraPaths.SetKeyView(path, key, eye, yaw, pitch);
            _pathSnapped = key;
            RememberSnapView();
            _pathEditNotice = CameraPaths.LastError ?? $"“{key.Name}” set to this view";
            Sound.Play(SoundId.Commit);
            Flash(UiTheme.BOOKMARK, 0.12f);
        }

        /// <summary>
        /// ← / →: the camera snaps into the previous / next key (from the selected one; none selected: the first / last).
        /// </summary>
        private void SnapToPathKey(int direction)
        {
            CameraPath path = _mediaPath;
            if (path.Keys.Count == 0)
            {
                _pathEditNotice = $"No keys yet: {Key(InputAction.PathAddKey)} adds one at this view";
                return;
            }
            int index = _mediaKey != null ? path.Keys.IndexOf(_mediaKey) : -1;
            int target = index < 0 ? (direction > 0 ? 0 : path.Keys.Count - 1)
                : path.Loop ? (index + direction + path.Keys.Count) % path.Keys.Count
                : Math.Clamp(index + direction, 0, path.Keys.Count - 1);
            CameraKey key = path.Keys[target];
            _pathPreviewPlaying = false;
            SelectPathKey(key, target: false);
            _pathSnapped = key;
            _pathOnScrub = false;
            EndPathEditState(); // K-C: off the path: the walkthrough's state
            _player.TeleportTo(key.Local - new Vector3(0f, 0f, _player.Controller.StandEye), key.Yaw, key.Pitch);
            _pathSnapEye = key.Local;
            _pathSnapYaw = key.Yaw;
            _pathSnapPitch = key.Pitch;
            if (_pathEditTimeline != null) { _pathScrubTime = _pathEditTimeline.StartOf(target); }
            Sound.Play(SoundId.Click);
        }

        /// <summary>Remembers the view a key was snapped or set at (moving off it makes SET meaningful again).</summary>
        private void RememberSnapView()
        {
            CurrentView(out _pathSnapEye, out _pathSnapYaw, out _pathSnapPitch);
        }

        /// <summary>True when the camera moved or turned since it snapped into the key.</summary>
        private bool PathSnapMoved =>
            _pathSnapped != null && (Vector3.DistanceSquared(Camera.Position, _pathSnapEye) > 1e-4f
                || MathF.Abs(TourTimeline.LerpAngle(_pathSnapYaw, _player.Yaw, 1f) - _pathSnapYaw) > 1e-3f || MathF.Abs(_player.Pitch - _pathSnapPitch) > 1e-3f);

        /// <summary>PICK TARGET, then a click: the selected key looks at the surface clicked.</summary>
        private void PickPathTarget(Vector2 mouse)
        {
            _pathPickTarget = false;
            CameraKey key = _mediaKey;
            if (key == null) { return; }
            ScreenRay(mouse, out Vector3 origin, out Vector3 direction);
            if (!PickStaticVisible(origin, direction, 500f, out RayHit hit))
            {
                _pathEditNotice = "Nothing there: click a surface for the target";
                Sound.Play(SoundId.Error);
                return;
            }
            PushPathUndo(_mediaPath);
            if (key.Heading != CameraHeading.LookAt && _mediaPath.HeadingFor(key) != CameraHeading.LookAt) { key.Heading = CameraHeading.LookAt; }
            CameraPaths.SetKeyTarget(_mediaPath, key, hit.Point);
            _pathSubjectTarget = true;
            _pathEditNotice = CameraPaths.LastError ?? $"“{key.Name}” looks at the point clicked (drag its handles to adjust)";
            Sound.Play(SoundId.Commit);
        }

        #endregion

        #region Undo

        /// <summary>Remembers the path before a change (Ctrl+Z puts it back).</summary>
        private void PushPathUndo(CameraPath path)
        {
            if (path == null) { return; }
            _pathUndo.Add((path, path.Snapshot()));
            if (_pathUndo.Count > PATH_UNDO_MAX) { _pathUndo.RemoveAt(0); }
        }

        /// <summary>Ctrl+Z: the last change to a path still in the store is undone (the selection follows by id).</summary>
        private void UndoPathChange()
        {
            while (_pathUndo.Count > 0)
            {
                (CameraPath path, CameraPath snapshot) = _pathUndo[^1];
                _pathUndo.RemoveAt(_pathUndo.Count - 1);
                if (!CameraPaths.Paths.Contains(path)) { continue; }
                string selected = _mediaKey?.Id;
                CameraPaths.Restore(path, snapshot);
                _mediaPath = path;
                _mediaKey = selected == null ? null : path.Keys.Find(k => k.Id == selected);
                _pathSnapped = null;
                _pathSubjectTarget = _pathSubjectTarget && _mediaKey?.TargetLocal != null;
                _pathEditNotice = CameraPaths.LastError ?? (_pathUndo.Count == 0 ? "Undone (nothing more to undo)" : $"Undone ({_pathUndo.Count} more)");
                Sound.Play(SoundId.UiClick);
                return;
            }
            _pathEditNotice = "Nothing to undo";
            Sound.Play(SoundId.Error);
        }

        #endregion

        #region Scrubber and preview

        /// <summary>Puts the camera on the path at a time (scrubber, preview): its position and heading.</summary>
        private void PlacePathCamera(float time)
        {
            if (_pathEditTimeline == null) { return; }
            _pathScrubTime = Math.Clamp(time, 0f, _pathEditTimeline.Duration);
            CameraPathPose pose = _pathEditTimeline.Evaluate(MathF.Min(_pathScrubTime, _pathEditTimeline.Duration - 1e-4f));
            _player.TeleportTo(pose.Eye - new Vector3(0f, 0f, _player.Controller.StandEye), pose.Yaw, pose.Pitch);
            _pathScrubEye = pose.Eye;
            _pathOnScrub = true;
            _pathSnapped = null;
            ShowPathEditState(pose); // K-C
        }

        /// <summary>
        /// K-C: the path's state at a pose: the key's (sun, profile, cut, hidden items, applied once per key) and the
        /// sun blending between keys; the fade while previewing. The walkthrough is remembered the first time.
        /// </summary>
        private void ShowPathEditState(in CameraPathPose pose)
        {
            _pathEditBlack = _pathPreviewPlaying ? pose.Black : 0f;
            if (_pathEditRecords == null || _tourActive || pose.Key < 0 || pose.Key >= _pathEditRecords.Length) { return; }
            if (!_pathEditState)
            {
                RememberWalkthrough();
                _pathEditState = true;
                _tourAppliedStop = -1;
                _tourAppliedSun = null;
                _tourAppliedSection = null;
                _tourAppliedVisibility = null;
            }
            _tourRecords = _pathEditRecords;
            if (pose.Key != _tourAppliedStop) { ApplyTourStop(pose.Key); }
            BlendTourSun(pose.ToTourPose(_player.Controller.StandEye));
        }

        /// <summary>
        /// K-C: the camera left the path (or the editor closed, or a tour starts): the walkthrough's sun, colour profile,
        /// cut and hidden items again. The position stays where it is.
        /// </summary>
        private void EndPathEditState()
        {
            _pathEditBlack = 0f;
            if (!_pathEditState) { return; }
            RestoreWalkthroughState();
            _pathEditState = false;
            _tourRecords = null;
            _tourSavedVisibility = null;
            _tourSavedIsolate = null;
        }

        /// <summary>Space: plays the camera along the path from the scrubber (from the start at the end), or pauses.</summary>
        private void TogglePathPreview()
        {
            if (_pathEditTimeline == null)
            {
                _pathEditNotice = "The path needs two keys or more to preview";
                Sound.Play(SoundId.Error);
                return;
            }
            _pathPreviewPlaying = !_pathPreviewPlaying;
            _pathEditBlack = 0f; // K-C: a paused preview shows the view
            if (_pathPreviewPlaying && _pathScrubTime >= _pathEditTimeline.Duration - 0.01f) { _pathScrubTime = 0f; }
            if (_pathPreviewPlaying) { PlacePathCamera(_pathScrubTime); }
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>The preview's clock: on along the path (round again when looping; stops at the end).</summary>
        private void AdvancePathPreview(float dt)
        {
            if (_pathEditTimeline == null)
            {
                _pathPreviewPlaying = false;
                return;
            }
            float time = _pathScrubTime + dt;
            if (time >= _pathEditTimeline.Duration)
            {
                if (_mediaPath.Loop && _pathEditTimeline.Duration > 0f) { time %= _pathEditTimeline.Duration; }
                else
                {
                    time = _pathEditTimeline.Duration;
                    _pathPreviewPlaying = false;
                }
            }
            PlacePathCamera(time);
        }

        /// <summary>
        /// K-C: the scrubber's sun strip: the sun's height along the path (the same blend as playback), as colours. Off
        /// when no key keeps a sun (the walkthrough's sun then shows all the way).
        /// </summary>
        private void BuildPathSunStrip()
        {
            _pathSunStripOn = false;
            CameraPathTimeline timeline = _pathEditTimeline;
            BookmarkRecord[] records = _pathEditRecords;
            if (timeline == null || records == null || timeline.Duration <= 0f || records.Length == 0 || records[0].Sun == null) { return; }
            int year = DateTime.Today.Year;
            for (int c = 0; c < PATH_SUN_CELLS; c++)
            {
                CameraPathPose pose = timeline.Evaluate((c + 0.5f) / PATH_SUN_CELLS * timeline.Duration);
                int key = Math.Clamp(pose.Key, 0, records.Length - 1);
                int from = Math.Clamp(pose.BlendFrom, 0, records.Length - 1), to = Math.Clamp(pose.BlendTo, 0, records.Length - 1);
                SunTime a = records[from].Sun ?? records[key].Sun, b = records[to].Sun ?? records[key].Sun;
                double minutes = from != to && pose.BlendT < 1f
                    ? SunBlend.Between(a, b, pose.BlendT, year, _pathStripSun)
                    : SunBlend.Between(records[key].Sun, records[key].Sun, 0f, year, _pathStripSun);
                SolarPosition.Compute(_location, year, _pathStripSun.Month, _pathStripSun.Day, minutes, _pathStripSun.DaylightSaving, out double altitude, out _);
                _pathSunStrip[c] = SunStripColour((float)(altitude * 180.0 / Math.PI));
            }
            _pathSunStripOn = true;
        }

        /// <summary>K-C: a sun height (degrees) as a strip colour: night, dusk orange, low warm sun, high pale sun.</summary>
        private static uint SunStripColour(float altitude)
        {
            // Stops: −8° night, 0° orange, 12° warm yellow, 45° pale
            Vector3 night = new(0.16f, 0.20f, 0.33f), dusk = new(0.98f, 0.45f, 0.09f), low = new(0.99f, 0.83f, 0.30f), high = new(1f, 0.97f, 0.84f);
            Vector3 colour;
            if (altitude <= -8f) { colour = night; }
            else if (altitude <= 0f) { colour = Vector3.Lerp(night, dusk, (altitude + 8f) / 8f); }
            else if (altitude <= 12f) { colour = Vector3.Lerp(dusk, low, altitude / 12f); }
            else { colour = Vector3.Lerp(low, high, Math.Clamp((altitude - 12f) / 33f, 0f, 1f)); }
            return Rgba.FromFloat(colour.X, colour.Y, colour.Z, 0.9f);
        }

        #endregion

        #region Handles

        /// <summary>The handles' subject: the selected key, or its look-at target.</summary>
        private bool PathSubject(out Vector3 position)
        {
            position = Vector3.Zero;
            CameraKey key = _mediaKey;
            if (key == null) { return false; }
            if (_pathSubjectTarget && key.TargetLocal is Vector3 target)
            {
                position = target;
                return true;
            }
            position = key.Local;
            return true;
        }

        /// <summary>The handles' length: about the same on screen at any distance.</summary>
        private float PathHandleLength(Vector3 subject) => Math.Clamp(Vector3.Distance(Camera.Position, subject) * 0.12f, 0.25f, 4f);

        /// <summary>A key's look direction.</summary>
        private static Vector3 ViewDirection(float yaw, float pitch) =>
            new(MathF.Cos(pitch) * MathF.Cos(yaw), MathF.Cos(pitch) * MathF.Sin(yaw), MathF.Sin(pitch));

        /// <summary>A handle's position and axis (X, Y, Z arrows; the view handle on the key only).</summary>
        private bool PathHandlePosition(int handle, out Vector3 position, out Vector3 axis)
        {
            position = axis = Vector3.Zero;
            if (!PathSubject(out Vector3 subject)) { return false; }
            float length = PathHandleLength(subject);
            switch (handle)
            {
                case PATH_HANDLE_X: axis = Vector3.UnitX; break;
                case PATH_HANDLE_Y: axis = Vector3.UnitY; break;
                case PATH_HANDLE_Z: axis = Vector3.UnitZ; break;
                case PATH_HANDLE_VIEW:
                    if (_pathSubjectTarget) { return false; }
                    axis = ViewDirection(_mediaKey.Yaw, _mediaKey.Pitch);
                    position = subject + axis * length * 1.4f;
                    return true;
                default: return false;
            }
            position = subject + axis * length;
            return true;
        }

        /// <summary>The handle nearest the mouse (within 16 px), or -1.</summary>
        private int PathHandleUnder(Vector2 mouse)
        {
            int best = -1;
            float bestDistance = S(16);
            for (int h = 0; h <= PATH_HANDLE_VIEW; h++)
            {
                if (!PathHandlePosition(h, out Vector3 position, out _) || !Camera.WorldToScreen(position, out Vector2 screen)) { continue; }
                float distance = Vector2.Distance(screen, mouse);
                if (distance < bestDistance)
                {
                    bestDistance = distance;
                    best = h;
                }
            }
            return best;
        }

        /// <summary>The key marker nearest the mouse (within 14 px), or -1.</summary>
        private int PathKeyUnder(Vector2 mouse)
        {
            List<CameraKey> keys = _mediaPath.Keys;
            int best = -1;
            float bestDistance = S(14);
            for (int i = 0; i < keys.Count; i++)
            {
                if (!Camera.WorldToScreen(keys[i].Local, out Vector2 screen)) { continue; }
                float distance = Vector2.Distance(screen, mouse);
                if (distance < bestDistance)
                {
                    bestDistance = distance;
                    best = i;
                }
            }
            return best;
        }

        /// <summary>The look-at target nearest the mouse (within 14 px): its key's index, or -1.</summary>
        private int PathTargetUnder(Vector2 mouse)
        {
            List<CameraKey> keys = _mediaPath.Keys;
            int best = -1;
            float bestDistance = S(14);
            for (int i = 0; i < keys.Count; i++)
            {
                if (keys[i].TargetLocal is not Vector3 target || _mediaPath.HeadingFor(keys[i]) != CameraHeading.LookAt) { continue; }
                if (!Camera.WorldToScreen(target, out Vector2 screen)) { continue; }
                float distance = Vector2.Distance(screen, mouse);
                if (distance < bestDistance)
                {
                    bestDistance = distance;
                    best = i;
                }
            }
            return best;
        }

        /// <summary>Starts dragging a handle (the path is remembered for undo).</summary>
        private void BeginPathDrag(int handle, Vector2 mouse)
        {
            if (!PathHandlePosition(handle, out _, out Vector3 axis) || !PathSubject(out Vector3 subject)) { return; }
            ScreenRay(mouse, out Vector3 rayOrigin, out Vector3 rayDirection);
            float parameter = 0f;
            if (handle != PATH_HANDLE_VIEW && !ClosestOnAxis(subject, axis, rayOrigin, rayDirection, out parameter)) { return; }
            PushPathUndo(_mediaPath);
            _pathHandleDrag = handle;
            _pathDragOrigin = subject;
            _pathDragAxis = axis;
            _pathDragStartParameter = parameter;
            _pathDragApplied = float.NaN;
            _pathDragStartYaw = _mediaKey.Yaw;
            _pathDragStartPitch = _mediaKey.Pitch;
            _pathSnapped = null;
            Sound.Play(SoundId.UiClick);
        }

        /// <summary>
        /// Moves the subject along the dragged arrow to where the mouse ray passes closest (5 cm steps unless free), or
        /// turns the key's view towards the mouse (5° steps unless free).
        /// </summary>
        private void DragPathHandle(Vector2 mouse, bool free)
        {
            CameraKey key = _mediaKey;
            if (key == null)
            {
                EndPathDrag();
                return;
            }
            ScreenRay(mouse, out Vector3 rayOrigin, out Vector3 rayDirection);
            if (_pathHandleDrag == PATH_HANDLE_VIEW)
            {
                // Where the ray meets the sphere round the key (the near side), else its closest approach
                float radius = PathHandleLength(_pathDragOrigin) * 1.4f;
                Vector3 m = rayOrigin - _pathDragOrigin;
                float b = Vector3.Dot(m, rayDirection), c = m.LengthSquared() - radius * radius;
                float discriminant = b * b - c;
                float root = discriminant >= 0f ? MathF.Sqrt(discriminant) : 0f;
                float t = discriminant >= 0f ? -b - root : -b;
                if (t < 0f) { t = discriminant >= 0f ? -b + root : MathF.Max(0f, -b); } // the eye inside the sphere: the far side
                Vector3 towards = rayOrigin + rayDirection * t - _pathDragOrigin;
                if (towards.LengthSquared() < 1e-8f) { return; }
                towards = Vector3.Normalize(towards);
                float yaw = MathF.Atan2(towards.Y, towards.X);
                float pitch = Math.Clamp(MathF.Asin(Math.Clamp(towards.Z, -1f, 1f)), -1.5f, 1.5f);
                if (!free)
                {
                    yaw = MathF.Round(yaw / PATH_VIEW_SNAP) * PATH_VIEW_SNAP;
                    pitch = Math.Clamp(MathF.Round(pitch / PATH_VIEW_SNAP) * PATH_VIEW_SNAP, -1.5f, 1.5f);
                }
                if (MathF.Abs(yaw - key.Yaw) < 1e-5f && MathF.Abs(pitch - key.Pitch) < 1e-5f) { return; }
                CameraPaths.SetKeyView(_mediaPath, key, key.Local, yaw, pitch, save: false);
                return;
            }

            if (!ClosestOnAxis(_pathDragOrigin, _pathDragAxis, rayOrigin, rayDirection, out float parameter)) { return; }
            float delta = parameter - _pathDragStartParameter;
            if (!free) { delta = MathF.Round(delta / PATH_SNAP) * PATH_SNAP; }
            if (MathF.Abs(delta - _pathDragApplied) < 1e-5f) { return; }
            _pathDragApplied = delta;
            Vector3 moved = _pathDragOrigin + _pathDragAxis * delta;
            if (_pathSubjectTarget) { CameraPaths.SetKeyTarget(_mediaPath, key, moved, save: false); }
            else { CameraPaths.SetKeyView(_mediaPath, key, moved, key.Yaw, key.Pitch, save: false); }
        }

        /// <summary>Ends a drag: the path is saved and its collision checked again.</summary>
        private void EndPathDrag()
        {
            if (_pathHandleDrag < 0) { return; }
            bool changed = !float.IsNaN(_pathDragApplied) || (_mediaKey != null && (_mediaKey.Yaw != _pathDragStartYaw || _mediaKey.Pitch != _pathDragStartPitch));
            _pathHandleDrag = -1;
            if (changed)
            {
                CameraPaths.Touch(_mediaPath);
                _pathCollisionDirty = true;
                Sound.Play(SoundId.Click);
            }
            else if (_pathUndo.Count > 0)
            {
                _pathUndo.RemoveAt(_pathUndo.Count - 1); // nothing moved: no undo step
            }
        }

        #endregion

        #region Drawing (3D)

        /// <summary>
        /// The path in the scene while the editor is on: the line (red through the model), direction ticks, keys and
        /// their views, look-at targets, the handles, the scrubber's spot and K's insert marker. Depth-tested, then a
        /// faint copy through walls.
        /// </summary>
        private void DrawPathEditor()
        {
            if (!_pathEditOn || _tourActive || _mediaPath == null) { return; }
            if (_pathOverlay == null)
            {
                _pathOverlay = new Overlay3D();
                _pathOverlay.Initialise();
            }
            UpdatePathCollision();
            CameraPath path = _mediaPath;
            _pathOverlay.Begin(Camera);

            // The line and the direction ticks (about every 2 m)
            uint lineColour = Rgba.Hex(0x22D3EE, 0.95f), blockedColour = Rgba.Hex(0xEF4444, 1f);
            int tickEvery = Math.Max(1, (int)MathF.Round(2f / MathF.Max(_pathSampleStep, 0.01f)));
            for (int i = 0; i + 1 < _pathSampleCount; i++)
            {
                Vector3 a = _pathSamples[i], b = _pathSamples[i + 1];
                _pathOverlay.Line(a, b, 3f, _pathBlocked[i] ? blockedColour : lineColour);
                if (i % tickEvery != tickEvery / 2) { continue; }
                Vector3 d = b - a;
                if (d.LengthSquared() < 1e-8f) { continue; }
                d = Vector3.Normalize(d);
                Vector3 side = Vector3.Cross(d, MathF.Abs(d.Z) > 0.95f ? Vector3.UnitX : Vector3.UnitZ);
                side = Vector3.Normalize(side);
                Vector3 tip = a + d * 0.15f;
                _pathOverlay.Line(tip, tip - d * 0.22f + side * 0.14f, 2f, lineColour);
                _pathOverlay.Line(tip, tip - d * 0.22f - side * 0.14f, 2f, lineColour);
            }

            // Keys: a dot, the view as a short line; look-at targets
            List<CameraKey> keys = path.Keys;
            uint keyColour = Rgba.Hex(0xFBBF24, 1f), viewColour = Rgba.Hex(0xFDE68A, 0.85f), targetColour = Rgba.Hex(0xE879F9, 1f);
            for (int i = 0; i < keys.Count; i++)
            {
                CameraKey key = keys[i];
                bool selected = ReferenceEquals(key, _mediaKey);
                bool hover = i == _pathKeyHover;
                float viewLength = selected ? 0f : 0.7f;
                if (viewLength > 0f) { _pathOverlay.Line(key.Local, key.Local + ViewDirection(key.Yaw, key.Pitch) * viewLength, 2f, viewColour); }
                _pathOverlay.Dot(key.Local, selected ? 10f : hover ? 9f : 7f, selected || hover ? Rgba.Hex(0xFFFFFF, 1f) : keyColour);
                if (key.TargetLocal is Vector3 target && path.HeadingFor(key) == CameraHeading.LookAt)
                {
                    _pathOverlay.Line(key.Local, target, selected ? 2f : 1f, Rgba.WithAlpha(targetColour, selected ? 0.9f : 0.5f));
                    bool targetOn = selected && _pathSubjectTarget;
                    _pathOverlay.Dot(target, targetOn || i == _pathTargetHover ? 9f : 6f, targetOn || i == _pathTargetHover ? Rgba.Hex(0xFFFFFF, 1f) : targetColour);
                }
            }

            // The scrubber's spot and K's insert marker
            if (_pathInsertShown) { _pathOverlay.Dot(_pathInsertPoint, 6f, Rgba.Hex(0x4ADE80, 1f)); }

            // The handles on the selected key (or its target)
            if (PathSubject(out Vector3 subject))
            {
                for (int h = 0; h <= PATH_HANDLE_VIEW; h++)
                {
                    if (!PathHandlePosition(h, out Vector3 position, out _)) { continue; }
                    bool active = h == _pathHandleDrag || (h == _pathHandleHover && _pathHandleDrag < 0);
                    uint colour = active ? Rgba.Hex(0xFFFFFF, 1f) : h switch
                    {
                        PATH_HANDLE_X => UiTheme.AXIS_X,
                        PATH_HANDLE_Y => UiTheme.AXIS_Y,
                        PATH_HANDLE_Z => UiTheme.AXIS_Z,
                        _ => Rgba.Hex(0xFDE68A, 1f)
                    };
                    _pathOverlay.Line(subject, position, h == PATH_HANDLE_VIEW ? 3f : 2.5f, colour);
                    _pathOverlay.Dot(position, active ? 10f : 7f, colour);
                }
            }

            _pathOverlay.Draw(Camera, depthTest: true, alpha: 1f, additive: false);
            _pathOverlay.Draw(Camera, depthTest: false, alpha: 0.3f, additive: false);
        }

        #endregion

        #region HUD

        /// <summary>
        /// The editor's HUD: key numbers by the markers, the info column (status, coordinates, F1), the dock, the
        /// scrubber, the snapped banner, the room banner and toasts. No crosshair, guns or gun bar.
        /// </summary>
        private void BuildPathEditorHud(FontAtlas f, int width, int height, float mapX, float mapY)
        {
            CameraPath path = _mediaPath;
            if (path == null) { return; }

            // K-C: the path's fades while previewing (under the dock and the scrubber)
            if (_pathPreviewPlaying && _pathEditBlack > 0.002f) { _ui.Rect(0, 0, width, height, Rgba.Hex(0x000000, Math.Clamp(_pathEditBlack, 0f, 1f))); }

            // Key numbers beside the markers
            for (int i = 0; i < path.Keys.Count; i++)
            {
                if (!Camera.WorldToScreen(path.Keys[i].Local, out Vector2 screen)) { continue; }
                Text.Clear().Append(i + 1);
                bool selected = ReferenceEquals(path.Keys[i], _mediaKey);
                _ui.Text(f.Bold, screen.X + S(9), screen.Y - S(18), Text.Span, selected ? UiTheme.TEXT : Rgba.Hex(0xFBBF24, 0.95f));
            }

            if (_showMap && !_dockOverMap) { DrawMinimapOverlay(mapX, mapY); }
            BuildPathDock(f, _window.Input);
            if (!_pathEditOn) { return; } // the dock left the editor
            BuildPathScrubber(f, _window.Input, width, height);
            BuildPathSnapBanner(f, width, height);
            BuildInfoColumn(f, height, sunLegend: false, profileLegend: true, help: true);
            BuildRoomBanner(f, width);
            BuildLiveBanner(f, width, height);
            BuildToast(f, width);
        }

        /// <summary>The line above the scrubber: snapped into a key (and whether SET would change it), or picking a target.</summary>
        private void BuildPathSnapBanner(FontAtlas f, int width, int height)
        {
            string text = null;
            uint colour = UiTheme.TEXT;
            if (_pathPickTarget)
            {
                text = "Click a surface for the key's look-at target (Esc cancels)";
                colour = Rgba.Hex(0xE879F9);
            }
            else if (_pathPreviewPlaying)
            {
                text = HINT_PATH_EDIT_PREVIEW.Text;
            }
            else if (_pathSnapped != null && ReferenceEquals(_pathSnapped, _mediaKey))
            {
                bool moved = PathSnapMoved;
                Text.Clear().Append(moved ? "Moved from “" : "At “").Append(_pathSnapped.Name).Append(moved ? "”: " : "”: fly and look, then ")
                    .Append(Key(InputAction.PathSetKey)).Append(moved ? " sets it here · ← / → leaves it as it was" : " sets it");
                float tw = UiBatch.Measure(f.Body, Text.Span) + S(28);
                float tx = MathF.Round((_pathBarRect.Z > 0f ? _pathBarRect.X + _pathBarRect.Z * 0.5f : width * 0.5f) - tw * 0.5f);
                float ty = (_pathBarRect.W > 0f ? _pathBarRect.Y : height - S(80)) - S(40);
                _ui.Panel(tx, ty, tw, S(30), UiTheme.PANEL_STRONG, moved ? UiTheme.ACCENT : UiTheme.PANEL_BORDER);
                _ui.Text(f.Body, tx + S(14), ty + S(7), Text.Span, moved ? UiTheme.ACCENT : UiTheme.TEXT);
                return;
            }
            if (text == null) { return; }
            float w = UiBatch.Measure(f.Body, text) + S(28);
            float x = MathF.Round((_pathBarRect.Z > 0f ? _pathBarRect.X + _pathBarRect.Z * 0.5f : width * 0.5f) - w * 0.5f);
            float y = (_pathBarRect.W > 0f ? _pathBarRect.Y : height - S(80)) - S(40);
            _ui.Panel(x, y, w, S(30), UiTheme.PANEL_STRONG, UiTheme.PANEL_BORDER);
            _ui.Text(f.Body, x + S(14), y + S(7), text, colour);
        }

        /// <summary>
        /// The scrubber (bottom, left of the dock): the timeline with the keys as numbered ticks and the playhead; drag
        /// to fly the camera along the path; PLAY / PAUSE; the time.
        /// </summary>
        private void BuildPathScrubber(FontAtlas f, InputState input, int width, int height)
        {
            float right = _pathDockRect.Z > 0f ? _pathDockRect.X - S(16) : width - S(16);
            float left = S(UiTheme.COLUMN_MARGIN) + S(UiTheme.INFO_WIDTH) + S(16);
            if (right - left < S(320)) { left = S(16); }
            float w = right - left, h = S(58);
            float x = left, y = height - S(16) - h;
            _pathBarRect = new Vector4(x, y, w, h);
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.PANEL_BORDER);
            RegisterFocusArea(x, y, w, h);

            CameraPathTimeline timeline = _pathEditTimeline;
            float playW = S(70);
            if (SmallButton(f, input, x + S(10), y + S(14), playW, S(30), _pathPreviewPlaying ? "PAUSE" : "PLAY")) { TogglePathPreview(); }
            float tx = x + S(10) + playW + S(16), tw = w - playW - S(10) - S(16) - S(110);
            float trackY = y + S(34);

            if (timeline == null || timeline.Duration <= 0f)
            {
                _ui.Text(f.Small, tx, y + S(20), "Add two keys or more to see the timeline", UiTheme.TEXT_FAINT);
                _pathScrubDrag = false;
                return;
            }

            // The track, the keys' ticks and numbers, the playhead
            float duration = timeline.Duration;
            _ui.Rect(tx, trackY - S(2), tw, S(4), Rgba.Hex(0xFFFFFF, 0.15f));
            float fraction = Math.Clamp(_pathScrubTime / duration, 0f, 1f);
            _ui.Rect(tx, trackY - S(2), tw * fraction, S(4), UiTheme.BOOKMARK);
            for (int i = 0; i < timeline.Count; i++)
            {
                float kx = tx + tw * Math.Clamp(timeline.StartOf(i) / duration, 0f, 1f);
                bool selected = i < _mediaPath.Keys.Count && ReferenceEquals(_mediaPath.Keys[i], _mediaKey);
                _ui.Rect(kx - S(1), trackY - S(8), S(2), S(16), selected ? UiTheme.TEXT : Rgba.Hex(0xFBBF24, 0.8f));
                Text.Clear().Append(i + 1);
                _ui.TextCentred(f.Small, kx, y + S(6), Text.Span, selected ? UiTheme.TEXT : UiTheme.TEXT_MUTED);
            }
            // K-C: the sun along the path (dark: night; orange: dawn and dusk; pale: high sun), dots at keys with their own sun
            if (_pathSunStripOn)
            {
                float stripY = trackY + S(12), cell = tw / PATH_SUN_CELLS;
                for (int c = 0; c < PATH_SUN_CELLS; c++) { _ui.Rect(tx + c * cell, stripY, cell + 0.5f, S(4), _pathSunStrip[c]); }
                for (int i = 0; i < timeline.Count && i < _mediaPath.Keys.Count; i++)
                {
                    if (_mediaPath.Keys[i].Sun == null) { continue; }
                    float kx = tx + tw * Math.Clamp(timeline.StartOf(i) / duration, 0f, 1f);
                    _ui.Circle(kx, stripY + S(2), S(3.5f), Rgba.Hex(0xFBBF24), 10);
                }
            }
            _ui.Circle(tx + tw * fraction, trackY, S(7), _pathScrubDrag ? Rgba.Hex(0xFFFFFF) : UiTheme.ACCENT, 16);

            // Drag along the track: the camera follows
            bool overTrack = Hover(input, tx - S(8), trackY - S(14), tw + S(16), S(28), focus: false);
            if (overTrack && input.LeftPressed)
            {
                input.ConsumeClicks();
                _pathScrubDrag = true;
                _pathPreviewPlaying = false;
            }
            if (_pathScrubDrag)
            {
                if (!input.LeftDown) { _pathScrubDrag = false; }
                else { PlacePathCamera(Math.Clamp((input.MousePosition.X - tx) / tw, 0f, 1f) * duration); }
            }

            // The time
            Text.Clear();
            AppendClock(_pathScrubTime).Append(" / ");
            AppendClock(duration);
            _ui.TextRight(f.Mono, x + w - S(12), y + S(20), Text.Span, UiTheme.TEXT_SOFT);
        }

        /// <summary>
        /// The dock: the path (switch, summary, collision), the selected key (prev / SET / next, add / delete, hold,
        /// ease, heading and target, speed, smoothness), the handles' note; MEDIA (the panel) and DONE.
        /// </summary>
        private void BuildPathDock(FontAtlas f, InputState input)
        {
            CameraPath path = _mediaPath;
            RefreshPathStats();
            DockFrame d = BeginDock("PATH EDITOR", UiTheme.BOOKMARK_LABEL, Rgba.WithAlpha(UiTheme.BOOKMARK, 0.6f), S(UiTheme.DOCK_WIDTH_WIDE), _pathDockScroll,
                notice: _pathEditNotice != null);
            _pathDockRect = d.Rect;
            if (input.RightPressed && Inside(_pathDockRect, input.MousePosition)) { input.ConsumeClicks(); }
            float x = d.Ix, w = d.Iw;
            float cy = BeginDockBody(d, _pathDockScroll, input);
            float gap = S(6);
            bool changed = false;
            int index = _mediaKey != null ? path.Keys.IndexOf(_mediaKey) : -1;

            // The path: switch, name, summary, collision
            bool previousPath = false, nextPath = false;
            if (CameraPaths.Paths.Count > 1)
            {
                previousPath = SmallButton(f, input, x, cy, S(28), S(28), "‹");
                nextPath = SmallButton(f, input, x + w - S(28), cy, S(28), S(28), "›");
                _ui.TextWrapped(f.Bold, x + S(36), cy + S(5), w - S(72), path.Name, UiTheme.TEXT, maxLines: 1);
            }
            else
            {
                _ui.TextWrapped(f.Bold, x, cy + S(5), w, path.Name, UiTheme.TEXT, maxLines: 1);
            }
            cy += S(34);
            _ui.TextWrapped(f.Small, x, cy, w, PathStatsLabel(path), UiTheme.TEXT_MUTED, maxLines: 1);
            cy += S(20);
            if (_pathEditTimeline != null)
            {
                if (_pathBlockedSegments > 0)
                {
                    Text.Clear().Append(_pathBlockedSegments).Append(_pathBlockedSegments == 1 ? " segment passes" : " segments pass").Append(" through the model (red)");
                    _ui.Text(f.Small, x, cy, Text.Span, Rgba.Hex(0xF87171));
                }
                else
                {
                    _ui.Text(f.Small, x, cy, "Clear of the model", UiTheme.TEXT_FAINT);
                }
                cy += S(20);
            }
            _ui.Rect(x, cy + S(4), w, MathF.Max(1f, UiScale), UiTheme.DIVIDER);
            cy += S(14);

            // Key buttons: previous / SET / next, add / delete
            float third = (w - gap * 2f) / 3f, half = (w - gap) * 0.5f;
            bool previous = SmallButton(f, input, x, cy, third, S(30), "‹ KEY");
            bool set = SmallButton(f, input, x + third + gap, cy, third, S(30), HINT_PATH_SET_BUTTON.Text);
            bool next = SmallButton(f, input, x + (third + gap) * 2f, cy, third, S(30), "KEY ›");
            cy += S(36);
            bool add = SmallButton(f, input, x, cy, half, S(30), HINT_PATH_ADD_BUTTON.Text);
            bool delete = SmallButton(f, input, x + half + gap, cy, half, S(30), HINT_PATH_DELETE_BUTTON.Text, danger: true);
            cy += S(42);

            CameraKey key = _mediaKey;
            bool pickTarget = false, clearTarget = false, resetSpeed = false, resetSmooth = false;
            bool sunNow = false, sunEarlier = false, sunLater = false, sunClear = false, photo = false; // K-C
            if (key == null)
            {
                cy += _ui.TextWrapped(f.Small, x, cy, w, path.Keys.Count == 0
                    ? $"No keys yet: fly to where the path starts and press {Key(InputAction.PathAddKey)}."
                    : $"Click a key in the scene, or {Key(InputAction.PathPreviousKey)} / {Key(InputAction.PathNextKey)} to snap into one.", UiTheme.TEXT_MUTED, maxLines: 3) + S(8);
            }
            else
            {
                Text.Clear().Append("KEY ").Append(index + 1).Append(" OF ").Append(path.Keys.Count).Append(_pathSubjectTarget ? " · ITS TARGET" : string.Empty);
                _ui.Text(f.Small, x, cy, Text.Span, UiTheme.TEXT_MUTED, S(1.4f));
                cy += S(18);
                _ui.TextWrapped(f.Bold, x, cy, w, key.Name, UiTheme.TEXT, maxLines: 1);
                cy += S(28);

                float hold = PathStepper(f, input, x, cy, "Hold", key.HoldSeconds, 0.5f, 0f, CameraKey.MAX_HOLD, 1, " s", own: key.HoldSeconds > 0f, out _);
                if (hold != key.HoldSeconds) { PushPathUndo(path); key.HoldSeconds = hold; changed = true; }
                cy += S(36);
                float speed = PathStepper(f, input, x, cy, "Speed", path.SpeedFor(key), 0.25f, CameraPath.MIN_SPEED, CameraPath.MAX_SPEED, 2, " m/s",
                    own: key.Speed.HasValue, out resetSpeed, resettable: true);
                if (!resetSpeed && speed != path.SpeedFor(key)) { PushPathUndo(path); key.Speed = speed; changed = true; }
                cy += S(36);
                float smooth = PathStepper(f, input, x, cy, "Smoothness", path.SmoothnessFor(key) * 100f, 10f, 0f, 100f, 0, " %",
                    own: key.Smoothness.HasValue, out resetSmooth, resettable: true) / 100f;
                if (!resetSmooth && MathF.Abs(smooth - path.SmoothnessFor(key)) > 1e-4f) { PushPathUndo(path); key.Smoothness = smooth; changed = true; }
                cy += S(38);

                _ui.Text(f.Body, x, cy + S(7), "Ease", UiTheme.TEXT_SOFT);
                int ease = Segmented(f, input, x + S(92), cy, w - S(92), KEY_EASE_OPTIONS, key.Ease is bool e ? (e ? 1 : 2) : 0);
                bool? newEase = ease == 1 ? true : ease == 2 ? false : null;
                if (newEase != key.Ease) { PushPathUndo(path); key.Ease = newEase; changed = true; }
                cy += S(38);

                // K-C: the key's sun (the scrubber's strip shows it along the path)
                _ui.Text(f.Body, x, cy + S(2), "Sun", UiTheme.TEXT_SOFT);
                if (key.Sun != null)
                {
                    Text.Clear().Append(key.Sun.Day).Append('/').Append(key.Sun.Month).Append("  ");
                    AppendTwoDigits(key.Sun.Minutes / 60).Append(':');
                    AppendTwoDigits(key.Sun.Minutes % 60);
                    _ui.Text(f.Bold, x + S(92), cy + S(1), Text.Span, Rgba.Hex(0x67E8F9));
                }
                else
                {
                    _ui.TextWrapped(f.Small, x + S(92), cy + S(3), w - S(92), "Between its neighbours'", UiTheme.TEXT_FAINT, maxLines: 1);
                }
                cy += S(24);
                float stepW = S(58), clearW = S(28);
                float nowW = key.Sun != null ? w - stepW * 2f - clearW - gap * 3f : w;
                sunNow = SmallButton(f, input, x, cy, nowW, S(28), "USE THE SUN NOW");
                if (key.Sun != null)
                {
                    sunEarlier = SmallButton(f, input, x + nowW + gap, cy, stepW, S(28), "−30 MIN");
                    sunLater = SmallButton(f, input, x + nowW + gap + stepW + gap, cy, stepW, S(28), "+30 MIN");
                    sunClear = SmallButton(f, input, x + w - clearW, cy, clearW, S(28), "×");
                }
                cy += S(38);

                _ui.Text(f.Body, x, cy, "Heading", UiTheme.TEXT_SOFT);
                cy += S(22);
                int headingIndex = key.Heading switch { CameraHeading.Follow => 1, CameraHeading.Key => 2, CameraHeading.LookAt => 3, _ => 0 };
                int pickedHeading = Segmented(f, input, x, cy, w, KEY_HEADING_OPTIONS, headingIndex);
                if (pickedHeading != headingIndex)
                {
                    PushPathUndo(path);
                    key.Heading = pickedHeading switch { 1 => CameraHeading.Follow, 2 => CameraHeading.Key, 3 => CameraHeading.LookAt, _ => null };
                    changed = true;
                }
                cy += S(38);
                if (path.HeadingFor(key) == CameraHeading.LookAt)
                {
                    float pickW = w - (key.HasTarget ? S(34) : 0f);
                    pickTarget = SmallButton(f, input, x, cy, pickW, S(28), _pathPickTarget ? "CLICK A SURFACE…" : key.HasTarget ? "PICK ANOTHER TARGET" : "PICK THE TARGET");
                    if (key.HasTarget) { clearTarget = SmallButton(f, input, x + w - S(28), cy, S(28), S(28), "×"); }
                    cy += S(34);
                }
                else if (path.HeadingFor(key) == CameraHeading.Key)
                {
                    cy += _ui.TextWrapped(f.Small, x, cy, w, "Holds the key's own view: drag the yellow handle, or snap in, look and SET", UiTheme.TEXT_FAINT, maxLines: 2) + S(6);
                }
                photo = SmallButton(f, input, x, cy, w, S(30), "PHOTO AT THIS KEY"); // K-C
                cy += S(38);
                cy += _ui.TextWrapped(f.Small, x, cy, w, HINT_PATH_HANDLES.Text, UiTheme.TEXT_FAINT, maxLines: 3) + S(6);
                cy += _ui.TextWrapped(f.Small, x, cy, w, "Colour profile, swivel, cut and the path's own settings: MEDIA → PATHS", UiTheme.TEXT_FAINT, maxLines: 2) + S(4);
            }
            EndDockBody(_pathDockScroll, input, cy);
            int footer = EndDock(d, _pathEditNotice, null, backLabel: "MEDIA", closeLabel: "DONE");

            // Act after drawing
            if (resetSpeed) { PushPathUndo(path); key.Speed = null; changed = true; }
            if (resetSmooth) { PushPathUndo(path); key.Smoothness = null; changed = true; }
            if (sunNow)
            {
                // K-C: the sun showing (on the path: the path's own, as previewed)
                PushPathUndo(path);
                key.Sun = _sun.Time.Copy();
                if (_sunPlaying) { key.Sun.Minutes = Math.Clamp((int)_playMinutes, 0, 1439); }
                changed = true;
                _pathEditNotice = ShadowsOn ? null : "Shadows are off now: the path turns them on from this key when it plays";
            }
            else if (sunEarlier || sunLater)
            {
                PushPathUndo(path);
                key.Sun.Minutes = Math.Clamp(key.Sun.Minutes + (sunLater ? 30 : -30), 0, 1439);
                changed = true;
            }
            else if (sunClear)
            {
                PushPathUndo(path);
                key.Sun = null;
                changed = true;
            }
            if (changed)
            {
                CameraPaths.Touch(path);
                RefreshPathStats();
            }
            if (pickTarget) { _pathPickTarget = !_pathPickTarget; }
            else if (clearTarget)
            {
                PushPathUndo(path);
                CameraPaths.SetKeyTarget(path, key, null);
                _pathSubjectTarget = false;
            }
            if (photo) { OpenPhotoAtKey(path, key, returnToEditor: true); } // K-C (leaves the editor until photo mode closes)
            else if (previous) { SnapToPathKey(-1); }
            else if (next) { SnapToPathKey(+1); }
            else if (set) { SetSelectedPathKey(); }
            else if (add) { AddPathKeyHere(); }
            else if (delete) { DeleteSelectedPathKey(); }
            else if (previousPath || nextPath)
            {
                int at = CameraPaths.Paths.IndexOf(path);
                int count = CameraPaths.Paths.Count;
                EndPathEditState(); // K-C
                _mediaPath = CameraPaths.Paths[((at + (nextPath ? 1 : -1)) % count + count) % count];
                _mediaKey = null;
                _pathSnapped = null;
                _pathSubjectTarget = false;
                _pathScrubTime = 0f;
                _pathPreviewPlaying = false;
                _pathEditNotice = null;
            }

            if (footer == DOCK_BACK)
            {
                // MEDIA → PATHS over the editor (CLOSE there comes back here)
                _pathPreviewPlaying = false;
                OpenMedia(MEDIA_PATHS);
            }
            else if (footer == DOCK_CLOSE)
            {
                ExitPathEditor();
            }
        }

        #endregion
    }
}
