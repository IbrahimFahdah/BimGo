import { InputAction } from '../core/scene/InputCatalog';
import { Hotkeys, KeyHint, keyOf, keyUpper } from '../platform/Hotkeys';

/**
 * Text that names keys, in one place (port of GameSession.Hints.cs, input round B2): built from the current bindings
 * and cached until one changes, so panels drawn every frame show the user's keys. Toasts read keyOf() directly.
 */
export const Hints = {
  help: new KeyHint(() => `${keyOf(InputAction.Help)}: Help`),
  sunClose: new KeyHint(() => `ESC · ${keyUpper(InputAction.Shadows)} CLOSE`),
  /** P-A2: the docks' footer hints (CLOSE is a button beside them). */
  sunFoot: new KeyHint(() => `${keyOf(InputAction.Shadows)} / Esc closes`),
  studyFoot: new KeyHint(() => `${keyOf(InputAction.SunStudy)} / Esc · results stay`),
  sectionFoot: new KeyHint(() => `${keyOf(InputAction.SectionBox)} / Esc · the cut stays`),
  gridsFoot: new KeyHint(() => `${keyOf(InputAction.GridsPanel)} / Esc closes · ${keyOf(InputAction.GridsCycle)} cycles the levels`),
  photoShadows: new KeyHint(() => `Shadows off: ${keyOf(InputAction.Shadows)} (or the sun panel) for sunlight`),
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

  unsaved: new KeyHint(() => ` · unsaved changes (${keyOf(InputAction.Save)})`),

  // Round K-A: the media panel and camera paths
  mediaPhotoOpen: new KeyHint(() => `OPEN PHOTO MODE (${keyUpper(InputAction.PhotoMode)})`),
  mediaPhoto: new KeyHint(() => `${keyOf(InputAction.PhotoMode)} opens photo mode straight from the walkthrough · ${keyOf(InputAction.MediaPanel)} opens this panel`),
  mediaPhotoAbout: new KeyHint(() =>
    `Photo mode keeps the frame clean (only its panel and the thirds grid). ${keyOf(InputAction.DragLook)}-drag looks, the wheel changes the field of view, ` +
    `${keyOf(InputAction.PhotoTake)} takes the photo; ${keyOf(InputAction.PhotoMode)} or Esc closes it. These settings are the same ones its panel shows.`),
  mediaPaths: new KeyHint(() =>
    `Fly to a place, ${keyOf(InputAction.MediaPanel)} → ADD KEY HERE, repeat · GO TO, fly, SET TO THIS VIEW adjusts a key · PLAY PATH: ${keyOf(InputAction.TourPause)} pause, Esc stops`),
  pathsEmpty: new KeyHint(() =>
    `No camera paths yet. NEW PATH makes one; then fly to where it starts (${keyOf(InputAction.Fly)} flies), press ${keyOf(InputAction.MediaPanel)} and ADD KEY HERE. ` +
    'Add a key at each place the camera should pass: the path curves smoothly through them at a steady speed.'),
  keysEmpty: new KeyHint(() =>
    `No keys yet. Resume, fly to where the path starts (${keyOf(InputAction.Fly)} flies), press ${keyOf(InputAction.MediaPanel)} and ADD KEY HERE: the key takes the view you left.`),
  pathPlaying: new KeyHint(() => `${keyUpper(InputAction.TourPause)} pause · ${keyUpper(InputAction.TourPrevious)} ${keyUpper(InputAction.TourNext)} or click for keys · ESC stops the path`),
  pathPaused: new KeyHint(() => `PAUSED · ${keyUpper(InputAction.TourPause)} plays · ${keyUpper(InputAction.TourPrevious)} ${keyUpper(InputAction.TourNext)} keys · ESC stops the path`),
  // Round K-B: the 3D path editor
  pathSetButton: new KeyHint(() => `SET (${keyUpper(InputAction.PathSetKey)})`),
  pathAddButton: new KeyHint(() => `ADD HERE (${keyUpper(InputAction.PathAddKey)})`),
  pathDeleteButton: new KeyHint(() => `DELETE (${keyUpper(InputAction.PathDeleteKey)})`),
  pathHandles: new KeyHint(() =>
    `Drag the arrows to move it (5 cm steps; ${keyOf(InputAction.PathFlyFast)}: free), the yellow handle to turn its view; a click picks a key or a target · ${keyOf(InputAction.PathUndo)} undoes`),
  pathEditPreview: new KeyHint(() =>
    `Previewing · ${keyOf(InputAction.PathPreview)} pauses (you stay on the path: ${keyOf(InputAction.PathAddKey)} adds a key there) · Esc stops`)
};
