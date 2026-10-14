using BimGo.Game.Guns;
using BimGo.Platform;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Text that names keys (input round B2), in one place: built from the current bindings and cached until one
    /// changes (<see cref="KeyHint"/>), so panels drawn every frame show the user's keys without allocating. Toasts
    /// (made once) read <see cref="Hotkeys.Label"/> directly. The guns keep their own panel hints beside their code.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Helpers

        /// <summary>An action's key as shown in sentences ("Shift+O").</summary>
        private static string Key(InputAction action) => Hotkeys.Label(action);

        /// <summary>An action's key in capitals, for labels and buttons ("SHIFT+O").</summary>
        private static string KeyUpper(InputAction action) => Hotkeys.Label(action).ToUpperInvariant();

        #endregion

        #region HUD, help

        private static readonly KeyHint HINT_HELP = new(() => $"{Key(InputAction.Help)}: Help");
        private static readonly KeyHint HINT_MAP_KEY = new(() => KeyUpper(InputAction.Minimap));
        private static readonly KeyHint HINT_REFRESH_KEY = new(() => KeyUpper(InputAction.Refresh));

        // The gun bar's key labels (gun.Key) follow the bindings
        private int _gunKeysVersion = int.MinValue;

        /// <summary>Gives each gun its selection key's label (the gun bar's corner number).</summary>
        private void RefreshGunKeys()
        {
            if (_guns == null) { return; }
            for (int i = 0; i < _guns.Length; i++)
            {
                KeyChord chord = Hotkeys.Map.Primary(InputCatalog.GunAction(i));
                _guns[i].Key = chord.IsEmpty ? string.Empty : Hotkeys.Map.Display(chord);
            }
            _gunKeysVersion = Hotkeys.Version;
        }

        #endregion

        #region Sun panel, photo mode, study, section box

        private static readonly KeyHint HINT_SUN_CLOSE = new(() => $"ESC · {KeyUpper(InputAction.Shadows)} CLOSE");
        private static readonly KeyHint HINT_SUN_KEYS = new(() =>
            $"{Hotkeys.Map.DescribeJoined(" ", false, InputAction.SunEarlier, InputAction.SunLater).ToUpperInvariant()} TIME · {KeyUpper(InputAction.SunPlay)} PLAY");

        private static readonly KeyHint HINT_PHOTO_USE = new(() => $"{Key(InputAction.DragLook)}-drag looks · wheel: field of view · {Key(InputAction.PhotoTake)}: take");
        private static readonly KeyHint HINT_PHOTO_SHADOWS = new(() => $"Shadows off: {Key(InputAction.Shadows)} (or the sun panel) for sunlight");
        private static readonly KeyHint HINT_PHOTO_TAKE = new(() => $"TAKE PHOTO ({KeyUpper(InputAction.PhotoTake)})");
        private static readonly KeyHint HINT_PHOTO_CLOSE = new(() => $"CLOSE ({KeyUpper(InputAction.PhotoMode)} / ESC)");

        private static readonly KeyHint HINT_STUDY_CLOSE = new(() => $"CLOSE ({KeyUpper(InputAction.SunStudy)} / ESC) · results stay");

        private static readonly KeyHint HINT_SECTION_DRAG = new(() => $"Drag a handle along its arrow ({Key(InputAction.SectionFreeDrag)}: no snap) · RMB-drag to look");
        private static readonly KeyHint HINT_SECTION_CLEAR = new(() => $"CLEAR ALL CUTS ({Key(InputAction.SectionClear)})");
        private static readonly KeyHint HINT_SECTION_CLOSE = new(() => $"CLOSE ({Key(InputAction.SectionBox)} / ESC) · cut stays");

        #endregion

        #region Markup, bookmarks, tour, library, textures

        private static readonly KeyHint HINT_MARKUP = new(() =>
            $"Drag on the picture to draw · {Key(InputAction.MarkupArrow)} arrow · {Key(InputAction.MarkupBox)} box · {Key(InputAction.MarkupEllipse)} ellipse · " +
            $"{Key(InputAction.MarkupPen)} pen · {Key(InputAction.MarkupText)} text · {Hotkeys.Map.DescribeRange(InputAction.MarkupColour1, 5)} colour · " +
            $"{Key(InputAction.MarkupUndo)} / {Key(InputAction.MarkupRedo)} · {Key(InputAction.MarkupSave)} save · Esc cancel");

        private static readonly KeyHint HINT_BOOKMARKS_TOUR = new(() =>
            $"The tour plays the ticked bookmarks in list order · {KeyUpper(InputAction.TourPause)} pause · {KeyUpper(InputAction.TourPrevious)} {KeyUpper(InputAction.TourNext)} stops · ESC ends it");
        private static readonly KeyHint HINT_BOOKMARKS_KEYS = new(() =>
            $"{KeyUpper(InputAction.AddBookmark)} saves where you stand · {Hotkeys.Map.DescribeRange(InputAction.Bookmark1, 9).ToUpperInvariant()} jump to the first nine · PLAY TOUR plays them all");
        private static readonly KeyHint HINT_BOOKMARKS_EMPTY = new(() =>
            $"No bookmarks yet. Resume, stand where you want and press {Key(InputAction.AddBookmark)} (or use ADD THIS VIEW below).");

        private static readonly KeyHint HINT_TOUR_PAUSED = new(() =>
            $"PAUSED · {KeyUpper(InputAction.TourPause)} plays · {KeyUpper(InputAction.TourPrevious)} {KeyUpper(InputAction.TourNext)} stops · ESC ends the tour");
        private static readonly KeyHint HINT_TOUR_PLAYING = new(() =>
            $"{KeyUpper(InputAction.TourPause)} pause · {KeyUpper(InputAction.TourPrevious)} {KeyUpper(InputAction.TourNext)} or click for stops · ESC ends the tour");
        private static readonly KeyHint HINT_TOUR_EMPTY = new(() => $"No bookmarks yet: press {Key(InputAction.AddBookmark)} where you want a stop.");

        private static readonly KeyHint HINT_LIBRARY_PICK = new(() =>
            $"Pick a card: it appears in front of you on the Place gun ({Key(InputAction.Gun9)}) · {Key(InputAction.GunSecondary)} commits · Esc discards");

        private static readonly KeyHint HINT_TEXTURES_SAVE = new(() => $"Save ({Key(InputAction.Save)}) embeds the picked images in the file");

        #endregion
    }
}
