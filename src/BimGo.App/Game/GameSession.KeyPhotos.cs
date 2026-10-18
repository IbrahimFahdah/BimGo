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
    /// Round K-C: camera path keys as photos.
    /// <list type="bullet">
    /// <item><b>PHOTO AT THIS KEY</b> (MEDIA → PATHS key editor, the 3D editor's dock): the camera goes to the key's view
    /// as the path plays it (its heading at the start of its hold), the key's sun, colour profile, cut and hidden items
    /// show, and photo mode opens. Closing photo mode puts the walkthrough back (and, from the 3D editor, goes back into
    /// it).</item>
    /// <item><b>PHOTOS OF ALL KEYS</b> (MEDIA → PATHS, under the path list): plays the path through the tour player,
    /// stopping at each key for one shot with the PHOTO settings (still or 360°, size, format, exposure, grid lines),
    /// saved as "01 &lt;key&gt;" in a folder of its own under Pictures\BimGo. Esc stops; the walkthrough comes back as
    /// it was.</item>
    /// </list>
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>Frames a batch waits at a key before its shot (the sun's shadows and visibility changes settle).</summary>
        private const int KEY_PHOTO_SETTLE_FRAMES = 3;

        /// <summary>A batch waits for earlier photos to finish saving while this many are being encoded.</summary>
        private const int KEY_PHOTO_MAX_SAVING = 2;

        /// <summary>A running PHOTOS OF ALL KEYS (null when none).</summary>
        private sealed class KeyPhotoBatch
        {
            public CameraPath Path;
            public string Folder;
            public int Index = -1;   // the key being shot (-1: not started)
            public int Settle;       // frames left before the shot
            public bool Shooting;    // the shot was requested; taken at the next render
            public int Taken;
            public bool Done;        // every key shot: waiting for the saves
        }

        private KeyPhotoBatch _keyPhotos;

        // PHOTO AT THIS KEY: the walkthrough to put back when photo mode closes, and the 3D editor to go back to
        private bool _keyPhotoRestore;
        private CameraPath _keyPhotoEditorPath;
        private CameraKey _keyPhotoEditorKey;

        /// <summary>A batch shot's file (folder\name without the extension), or null for the usual photo name.</summary>
        private string _photoNamed;

        /// <summary>Photos being encoded and written on workers (a batch waits when there are many).</summary>
        private int _photoSaving;

        #endregion

        #region PHOTO AT THIS KEY

        /// <summary>
        /// Opens photo mode at a key's view with its state showing; closing photo mode puts the walkthrough back.
        /// </summary>
        /// <param name="returnToEditor">True from the 3D editor's dock: closing photo mode goes back into the editor.</param>
        private void OpenPhotoAtKey(CameraPath path, CameraKey key, bool returnToEditor)
        {
            if (_player == null || path == null || key == null || _tourActive) { return; }
            int index = path.Keys.IndexOf(key);
            if (index < 0) { return; }

            if (_pathEditOn) { ExitPathEditor(); }
            CloseMediaPanel();
            if (_paused) { SetPaused(false); }
            SaveWalkthroughForTour();

            // The key's view as the path plays it, and its state (sun between keyed suns, profile / cut / hidden carried on)
            CameraPathTimeline timeline = path.Keys.Count >= 2 ? PathTimeline(path) : null;
            Vector3 eye = key.Local;
            float yaw = key.Yaw, pitch = key.Pitch;
            if (timeline != null)
            {
                CameraPathPose pose = timeline.Evaluate(timeline.StartOf(index));
                eye = pose.Eye;
                yaw = pose.Yaw;
                pitch = pose.Pitch;
            }
            _tourRecords = PathRecords(path, timeline);
            _tourAppliedStop = -1;
            _tourAppliedSun = null;
            _tourAppliedSection = null;
            _tourAppliedVisibility = null;
            ApplyTourStop(index);
            _tourRecords = null;

            if (!_player.Flying) { _player.ToggleFly(); }
            _player.TeleportTo(eye - new Vector3(0f, 0f, _player.Controller.StandEye), yaw, pitch);
            _keyPhotoRestore = true;
            _keyPhotoEditorPath = returnToEditor ? path : null;
            _keyPhotoEditorKey = returnToEditor ? key : null;
            OpenPhotoMode();
            Toast($"Photo at “{key.Name}” of {path.Name}: its sun, profile, cut and hidden items · {Key(InputAction.PhotoMode)} / Esc puts the walkthrough back", 4f);
        }

        /// <summary>
        /// Photo mode closed after PHOTO AT THIS KEY: the walkthrough as it was (position, eye, walking or flying, sun,
        /// profile, cut, hidden items), then back into the 3D editor when it came from there.
        /// </summary>
        private void EndKeyPhoto()
        {
            if (!_keyPhotoRestore) { return; }
            _keyPhotoRestore = false;
            RestoreWalkthroughState();
            _player.Controller.SetStandingEye(_tourSavedEye, force: true);
            _eyePreset = _tourSavedPreset;
            _eyeCustom = _tourSavedEyeCustom;
            if (_player.Flying != _tourSavedFlying) { _player.ToggleFly(); }
            _player.TeleportTo(_tourSavedFeet, _tourSavedYaw, _tourSavedPitch);
            _tourSavedVisibility = null;
            _tourSavedIsolate = null;

            CameraPath editor = _keyPhotoEditorPath;
            CameraKey key = _keyPhotoEditorKey;
            _keyPhotoEditorPath = null;
            _keyPhotoEditorKey = null;
            if (editor != null && CameraPaths.Paths.Contains(editor))
            {
                EnterPathEditor(editor);
                if (editor.Keys.Contains(key)) { SelectPathKey(key, target: false); }
            }
        }

        #endregion

        #region PHOTOS OF ALL KEYS

        /// <summary>
        /// PHOTOS OF ALL KEYS: plays the path through the tour player, one shot per key with the PHOTO settings.
        /// </summary>
        private void StartKeyPhotos(CameraPath path)
        {
            if (_tourActive || _video != null || _player == null || path == null) { return; }
            if (path.Keys.Count == 0)
            {
                _mediaNotice = "The path has no keys yet: ADD KEY HERE adds this view";
                Sound.Play(SoundId.Error);
                return;
            }
            if (_pathEditOn) { ExitPathEditor(); }
            FlushTourDraft();

            string model = SafeFileName(Path.GetFileNameWithoutExtension(DocumentName));
            string stamp = DateTime.Now.ToString("yyyy-MM-dd HHmmss", System.Globalization.CultureInfo.InvariantCulture);
            string folder = Path.Combine(ScreenshotFolder, $"{model} {SafeFileName(path.Name)} {stamp}");

            SaveWalkthroughForTour();
            CameraPathTimeline timeline = PathTimeline(path); // one key works too (no segments)
            BeginTour(timeline, PathRecords(path, timeline), new TourSettings { ShowUi = false, Loop = false }, path);
            _keyPhotos = new KeyPhotoBatch { Path = path, Folder = folder };
            _toast = null;
            Utilities.Log_Utils.Write($"Key photos: {path.Name}, {path.Keys.Count} key(s), {(_photoKind == 0 ? "stills" : "360s")} into {folder}.");
        }

        /// <summary>
        /// Per frame while the batch runs (from <see cref="UpdateTour"/>): Esc stops; else the next key, its settle frames,
        /// its shot; at the end, the saves are waited for.
        /// </summary>
        private void UpdateKeyPhotos(InputState input)
        {
            KeyPhotoBatch batch = _keyPhotos;
            if (input.Pressed(InputAction.Back))
            {
                FinishKeyPhotos(cancelled: true);
                return;
            }
            if (_photoShotIn > 0) { return; } // the shot renders this frame

            if (batch.Shooting)
            {
                batch.Shooting = false;
                batch.Taken++;
                _photoNamed = null;
            }
            if (batch.Done)
            {
                if (Volatile.Read(ref _photoSaving) == 0) { FinishKeyPhotos(cancelled: false); }
                return;
            }
            if (batch.Index >= 0 && batch.Settle > 0)
            {
                if (--batch.Settle == 0)
                {
                    // The shot, named by its place and key
                    CameraKey key = batch.Path.Keys[batch.Index];
                    _photoNamed = Path.Combine(batch.Folder, $"{batch.Index + 1:00} {SafeFileName(key.Name)}");
                    _photoShotIn = 1;
                    batch.Shooting = true;
                }
                return;
            }

            // On to the next key (waiting while earlier photos are still being saved)
            if (Volatile.Read(ref _photoSaving) >= KEY_PHOTO_MAX_SAVING) { return; }
            int next = batch.Index + 1;
            if (next >= _tour.Count || next >= batch.Path.Keys.Count)
            {
                batch.Done = true;
                return;
            }
            batch.Index = next;
            batch.Settle = KEY_PHOTO_SETTLE_FRAMES;
            _tourTime = _tour.StartOf(next);
            EvaluateTour();
            UpdateRoom();
        }

        /// <summary>Ends the batch: the walkthrough comes back; a toast says how many photos went where.</summary>
        private void FinishKeyPhotos(bool cancelled)
        {
            KeyPhotoBatch batch = _keyPhotos;
            if (batch == null) { return; }
            _keyPhotos = null;
            _photoNamed = null;
            _photoShotIn = 0;
            StopTour(finished: !cancelled);
            string folder = Path.GetFileName(batch.Folder);
            Toast(batch.Taken == 0
                ? "Key photos stopped: none taken"
                : cancelled
                    ? $"Key photos stopped: {batch.Taken} saved in “{folder}” (Pictures › BimGo)"
                    : $"{batch.Taken} key photo{(batch.Taken == 1 ? "" : "s")} saved in “{folder}” (Pictures › BimGo)", 5f);
            Sound.Play(cancelled ? SoundId.UiClick : SoundId.Commit);
            Utilities.Log_Utils.Write($"Key photos {(cancelled ? "stopped" : "done")}: {batch.Taken} taken.");
        }

        /// <summary>The batch's progress over the view (not in the photos).</summary>
        private void BuildKeyPhotosOverlay(FontAtlas f, int width, int height)
        {
            KeyPhotoBatch batch = _keyPhotos;
            int count = batch.Path.Keys.Count;
            int shown = Math.Clamp(batch.Index + 1, 0, count);
            Text.Clear().Append("PHOTOS OF ALL KEYS · ").Append(shown).Append(" / ").Append(count);
            if (batch.Done) { Text.Append(" · SAVING…"); }
            float w = MathF.Min(S(560), width - S(40)), h = S(64);
            float x = MathF.Round((width - w) * 0.5f), y = height - S(24) - h;
            _ui.Panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.ACCENT);
            _ui.Text(f.Small, x + S(14), y + S(12), Text.Span, UiTheme.ACCENT, S(1.4f));
            string name = batch.Index >= 0 && batch.Index < count ? batch.Path.Keys[batch.Index].Name : batch.Path.Name;
            _ui.TextWrapped(f.Bold, x + S(14), y + S(32), w - S(150), name, UiTheme.TEXT, maxLines: 1);
            _ui.TextRight(f.Small, x + w - S(14), y + S(36), "Esc stops", UiTheme.TEXT_MUTED);
            float fraction = count > 0 ? (shown - (batch.Settle > 0 || batch.Shooting ? 0.5f : 0f)) / count : 1f;
            _ui.Rect(x + S(14), y + h - S(8), (w - S(28)) * Math.Clamp(fraction, 0f, 1f), S(3), UiTheme.ACCENT);
        }

        #endregion
    }
}
