import { InputAction } from '../core/scene/InputCatalog';
import { Hotkeys, KeyHint, keyOf, keyUpper } from '../platform/Hotkeys';

/**
 * Text that names keys, in one place (port of GameSession.Hints.cs, input round B2): built from the current bindings
 * and cached until one changes, so panels drawn every frame show the user's keys. Toasts read keyOf() directly.
 */
export const Hints = {
  sunClose: new KeyHint(() => `ESC · ${keyUpper(InputAction.Shadows)} CLOSE`),
  sunKeys: new KeyHint(() => `${Hotkeys.map.describeJoined(' ', false, InputAction.SunEarlier, InputAction.SunLater).toUpperCase()} TIME · ${keyUpper(InputAction.SunPlay)} PLAY`),

  photoUse: new KeyHint(() => `${keyOf(InputAction.DragLook)}-drag looks · wheel: field of view · ${keyOf(InputAction.PhotoTake)}: take`),
  photoTake: new KeyHint(() => `TAKE PHOTO (${keyUpper(InputAction.PhotoTake)})`),
  photoClose: new KeyHint(() => `CLOSE (${keyUpper(InputAction.PhotoMode)} / ESC)`),

  studyClose: new KeyHint(() => `CLOSE (${keyUpper(InputAction.SunStudy)} / ESC) · results stay`),

  sectionDrag: new KeyHint(() => `Drag a handle along its arrow (${keyOf(InputAction.SectionFreeDrag)}: no snap) · RMB-drag to look`),
  sectionClear: new KeyHint(() => `CLEAR ALL CUTS (${keyOf(InputAction.SectionClear)})`),
  sectionClose: new KeyHint(() => `CLOSE (${keyOf(InputAction.SectionBox)} / ESC) · cut stays`),

  bookmarksTour: new KeyHint(() =>
    `The tour plays the ticked bookmarks in list order · ${keyUpper(InputAction.TourPause)} pause · ${keyUpper(InputAction.TourPrevious)} ${keyUpper(InputAction.TourNext)} stops · ESC ends it`),
  bookmarksKeys: new KeyHint(() =>
    `${keyUpper(InputAction.AddBookmark)} saves where you stand · ${Hotkeys.map.describeRange(InputAction.Bookmark1, 9).toUpperCase()} jump to the first nine · PLAY TOUR plays them all`),
  bookmarksEmpty: new KeyHint(() => `No bookmarks yet. Resume, stand where you want and press ${keyOf(InputAction.AddBookmark)} (or use ADD THIS VIEW below).`),

  tourPaused: new KeyHint(() => `PAUSED · ${keyUpper(InputAction.TourPause)} plays · ${keyUpper(InputAction.TourPrevious)} ${keyUpper(InputAction.TourNext)} stops · ESC ends the tour`),
  tourPlaying: new KeyHint(() => `${keyUpper(InputAction.TourPause)} pause · ${keyUpper(InputAction.TourPrevious)} ${keyUpper(InputAction.TourNext)} or click for stops · ESC ends the tour`),
  tourEmpty: new KeyHint(() => `No bookmarks yet: press ${keyOf(InputAction.AddBookmark)} where you want a stop.`),

  unsaved: new KeyHint(() => ` · unsaved changes (${keyOf(InputAction.Save)})`)
};
