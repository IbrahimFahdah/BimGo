import { KeyChord } from './KeyChord';

/**
 * The action catalogue (port of BimGo.Core/Scene/InputCatalog.cs, input round B2): every input action, its group, label
 * and default keys, and the situations deciding which actions can fire together. The single source for the action
 * map, the CONTROLS panel, F1 help and the default-clash tests.
 */

/** Groups of actions: a heading in CONTROLS and help. */
export enum InputContext {
  General, Movement, Guns, Tools, ScanGun, MeasureGun, CommentGun, DemolishGun, GizmoGuns, Holding, Markup, SectionEditor,
  PhotoMode, SunPanel, Tour,
  /** Clash mode: the docked clash list, free cursor, flying. */
  Clashes,
  /** Sky round: the pause menu's own keys (the options preview). */
  PauseMenu,
  /** Round K: the 3D camera path editor. */
  PathEditor,
  /** Keys that can't be rebound (Esc, menus and panels' mouse). Listed for reference and clash checks. */
  Fixed
}

/** How an action reads its keys. Only matters for what can be bound: a held action can't use the wheel. */
export enum ActionKind {
  /** Fires once when the key goes down. */
  Press,
  /** Fires when the key goes down and again on keyboard auto-repeat. */
  Repeat,
  /** Read while held. */
  Hold
}

/**
 * Every input action. The enum names are the ids stored in the settings and keymap files (the desktop's names):
 * never rename one; add new ones at the end of their group.
 */
export enum InputAction {
  None = 0,

  // General
  Help, Fullscreen, Screenshot, HideUi, Minimap, Refresh, Save, SaveAs, Undo, Redo,

  // Movement
  MoveForward, MoveBack, MoveLeft, MoveRight, Jump, Run, Crouch, Fly, LevelUp, LevelDown, GoHome, SetHome, FindRoom,
  LookUp, LookDown, LookLeft, LookRight,

  // Guns
  Gun1, Gun2, Gun3, Gun4, Gun5, Gun6, Gun7, Gun8, Gun9, PreviousGun, NextGun, GunPrimary, GunSecondary, ClearMarkers, GunWheel,
  GunModePrevious, GunModeNext, Unarmed,

  // Views and tools
  AddBookmark, Bookmark1, Bookmark2, Bookmark3, Bookmark4, Bookmark5, Bookmark6, Bookmark7, Bookmark8, Bookmark9,
  Coordinates, Lights, Shadows, SunPanel, SunEarlier, SunEarlierFine, SunLater, SunLaterFine, SunStudy, PhotoMode,
  SectionBox, SectionPlane, SectionClear, ClashMode, GridsPanel, GridsCycle, ColourProfile,
  MediaPanel, // Round K-A
  PathEditMode, // Round K-B

  // Gun keys
  ScanSelectInRevit, ScanHide, ScanIsolate, MeasureNormal, CommentEdit, DemolishMode, GizmoSnap, GizmoDrop,

  // Holding an element (Gizmo / Clone / Place locked on)
  HoldUp, HoldDown, HoldRotate, HoldStepDown, HoldStepUp, HoldFine, HoldSnapInvert,

  // Markup editor
  MarkupArrow, MarkupBox, MarkupEllipse, MarkupPen, MarkupText,
  MarkupColour1, MarkupColour2, MarkupColour3, MarkupColour4, MarkupColour5, MarkupUndo, MarkupRedo, MarkupSave,

  // Section box editor, photo mode, sun panel, tour
  SectionFreeDrag, PhotoTake, SunPlay, TourPause, TourNext, TourPrevious,

  // Clash mode
  ClashNext, ClashPrevious, ClashFrame, ClashStatusNew, ClashStatusActive, ClashStatusReviewed, ClashStatusApproved,
  ClashStatusResolved, ClashSelectInRevit, ClashFlyUp, ClashFlyDown, ClashView, ClashSectionToggle,
  ClashSelectAll, ClashPictures, ClashGroup, ClashUngroup,
  ClashPickPoints, ClashStatusCycle, // polish round P-B

  // Pause menu (sky round)
  MenuPreview,

  // Path editor (P-B reserved; Round K-B)
  PathAddKey, PathDeleteKey, PathPreview, PathPreviousKey, PathNextKey,
  PathSetKey, PathMoveForward, PathMoveBack, PathMoveLeft, PathMoveRight, PathFlyUp, PathFlyDown, PathFlyFast, PathUndo,

  // Fixed (not rebindable)
  Back, CloseWindow, Click, DragLook, FineAdjust, PhotoZoom, OpenFile, PadClick, PadMenuBack
}

/** One action: its group, label, kind and default keys. */
export class ActionDef {
  /** Default gamepad binding (NONE when the gamepad has none). */
  padDefault = KeyChord.NONE;

  constructor(
    readonly action: InputAction,
    readonly context: InputContext,
    readonly label: string,
    readonly kind: ActionKind,
    readonly defaults: readonly KeyChord[],
    readonly isFixed: boolean,
    readonly everywhere: boolean
  ) {}

  /** Stored id (the enum name). */
  get id(): string { return InputAction[this.action]; }
}

/**
 * One row of the generated F1 sheet (polish round P-B): a short label and the actions whose keys it shows; keyText
 * stands in for the key column when the keyboard side isn't a binding (looking with the mouse).
 */
export class HelpEntry {
  constructor(readonly label: string, readonly keyText: string | null, readonly actions: readonly InputAction[]) {}
}

/** A default that changed in a controls defaults version (P-B): a new action, or new keys / pad binding for one. */
export interface DefaultsChange { version: number; action: InputAction; added: boolean; was: string | null }

/** A state of the app with the actions that can fire in it (and, P-B, its F1 rows). */
export class InputSituation {
  constructor(readonly name: string, readonly contexts: readonly InputContext[], readonly extra: readonly InputAction[],
    readonly help: readonly HelpEntry[] = []) {}

  /** True when the action can fire in this situation. */
  contains(action: InputAction): boolean {
    const def = InputCatalog.get(action);
    if (!def) { return false; }
    if (def.everywhere) { return true; }
    return this.contexts.includes(def.context) || this.extra.includes(action);
  }
}

const P = ActionKind.Press, R = ActionKind.Repeat, H = ActionKind.Hold;
const A = InputAction;

function buildDefinitions(): ActionDef[] {
  const list: ActionDef[] = [];
  const add = (action: InputAction, context: InputContext, label: string, kind: ActionKind, ...keys: string[]) =>
    list.push(new ActionDef(action, context, label, kind, keys.map(k => KeyChord.parse(k)), false, false));
  const fixed = (action: InputAction, label: string, kind: ActionKind, everywhere: boolean, context: InputContext, ...keys: string[]) =>
    list.push(new ActionDef(action, context, label, kind, keys.map(k => KeyChord.parse(k)), true, everywhere));

  // General (the browser keeps F12 for its developer tools: Shift+F12 takes the screenshot)
  let c = InputContext.General;
  add(A.Help, c, 'Help on / off', P, 'F1');
  add(A.Fullscreen, c, 'Fullscreen', P, 'F11');
  add(A.Screenshot, c, 'Screenshot', P, 'Shift+F12');
  add(A.HideUi, c, 'Hide / show the UI', P, 'U');
  add(A.Minimap, c, 'Minimap', P, 'Tab');
  add(A.Refresh, c, 'Refresh from Revit (live)', P, 'F5');
  add(A.Save, c, 'Save', P, 'Ctrl+S');
  add(A.SaveAs, c, 'Save as', P, 'Ctrl+Shift+S');
  add(A.Undo, c, 'Undo (files)', P, 'Ctrl+Z');
  add(A.Redo, c, 'Redo (files)', P, 'Ctrl+Y', 'Ctrl+Shift+Z');

  // Movement
  c = InputContext.Movement;
  add(A.MoveForward, c, 'Move forward', H, 'W', 'Up');
  add(A.MoveBack, c, 'Move back', H, 'S', 'Down');
  add(A.MoveLeft, c, 'Move left', H, 'A', 'Left');
  add(A.MoveRight, c, 'Move right', H, 'D', 'Right');
  add(A.Jump, c, 'Jump (flying: up)', H, 'Space');
  add(A.Run, c, 'Run (hold)', H, 'Shift');
  add(A.Crouch, c, 'Crouch (flying: down)', H, 'Ctrl');
  add(A.Fly, c, 'Fly / walk (no-clip)', P, 'V');
  add(A.LevelUp, c, 'Level up', P, 'PageUp');
  add(A.LevelDown, c, 'Level down', P, 'PageDown');
  add(A.GoHome, c, 'Go home', P, 'H');
  add(A.SetHome, c, 'Set home here', P, 'Shift+H');
  add(A.FindRoom, c, 'Find room', P, 'Ctrl+F');
  add(A.LookUp, c, 'Look up', H);
  add(A.LookDown, c, 'Look down', H);
  add(A.LookLeft, c, 'Look left', H);
  add(A.LookRight, c, 'Look right', H);

  // Guns
  c = InputContext.Guns;
  const guns = ['Scan', 'Measure (again: next mode)', 'Portal', 'Comment', 'Teleport', 'Demolish', 'Gizmo', 'Clone', 'Place'];
  for (let i = 0; i < 9; i++) { add(InputCatalog.gunAction(i), c, `Gun ${i + 1}: ${guns[i]}`, P, String(i + 1)); }
  add(A.PreviousGun, c, 'Previous gun', P, 'Shift+WheelUp');
  add(A.NextGun, c, 'Next gun', P, 'Shift+WheelDown');
  add(A.GunModePrevious, c, 'Gun mode: previous (Measure, Demolish)', P, 'WheelUp');
  add(A.GunModeNext, c, 'Gun mode: next (Measure, Demolish)', P, 'WheelDown');
  add(A.Unarmed, c, 'None: no gun (again, or a gun key, arms)', P, '0');
  add(A.GunPrimary, c, 'Gun primary (fire)', P, 'LMB');
  add(A.GunSecondary, c, 'Gun secondary', P, 'RMB');
  add(A.ClearMarkers, c, "Clear this gun's markers", P, 'X');
  add(A.GunWheel, c, 'Gun wheel (mouse: hold, steer, release; gamepad: click, steer, A / click again picks, B cancels)', H, 'MMB');

  // Views and tools
  c = InputContext.Tools;
  add(A.AddBookmark, c, 'Bookmark this view', P, 'B');
  for (let i = 0; i < 9; i++) { add(InputCatalog.bookmarkAction(i), c, `Go to bookmark ${i + 1}`, P, `Shift+${i + 1}`); }
  add(A.Coordinates, c, 'Coordinate readout', P, 'L');
  add(A.Lights, c, 'Artificial lights', P, 'K');
  add(A.Shadows, c, 'Shadows on / off', P, 'O');
  add(A.SunPanel, c, 'Sun panel', P, 'Shift+O');
  add(A.SunEarlier, c, 'Sun time −5 min', R, '[');
  add(A.SunEarlierFine, c, 'Sun time −1 min', R, 'Shift+[');
  add(A.SunLater, c, 'Sun time +5 min', R, ']');
  add(A.SunLaterFine, c, 'Sun time +1 min', R, 'Shift+]');
  add(A.SunStudy, c, 'Sun / daylight study', P, 'J');
  add(A.PhotoMode, c, 'Photo mode', P, 'M');
  add(A.SectionBox, c, 'Section box editor', P, 'P');
  add(A.SectionPlane, c, 'Cut at the aimed surface', P, 'Shift+P');
  add(A.SectionClear, c, 'Clear all cuts', P, 'Ctrl+P');
  add(A.ClashMode, c, 'Clash mode on / off (docked clash list)', P, 'Y');
  add(A.GridsPanel, c, 'Grids panel (also in clash mode)', P, 'Shift+G');
  add(A.GridsCycle, c, 'Grids: off / level underfoot / all levels (also in clash mode)', P, 'C');
  add(A.ColourProfile, c, 'Colour profile on / off (also in clash mode)', P, 'Shift+C');
  add(A.MediaPanel, c, 'Media panel: photo, tour, camera paths, video', P, 'Shift+M');
  add(A.PathEditMode, c, 'Camera path editor in 3D on / off', P, 'Shift+K');

  // Gun keys (while that gun is selected)
  add(A.ScanSelectInRevit, InputContext.ScanGun, 'Select in Revit (live)', P, 'R');
  add(A.ScanHide, InputContext.ScanGun, 'Hide the target', P, 'I');
  add(A.ScanIsolate, InputContext.ScanGun, 'Isolate its category (again: show all)', P, 'Shift+I');
  add(A.MeasureNormal, InputContext.MeasureGun, 'Normal projection (distance mode)', P, 'N');
  add(A.CommentEdit, InputContext.CommentGun, 'Edit the hovered comment', P, 'E');
  add(A.DemolishMode, InputContext.DemolishGun, 'Demolish / delete mode', P, 'T');
  add(A.GizmoSnap, InputContext.GizmoGuns, 'Snap on / off', P, 'G');
  add(A.GizmoDrop, InputContext.GizmoGuns, 'Drop onto the surface below', P, 'F');

  // Holding an element (the move keys move it)
  c = InputContext.Holding;
  add(A.HoldUp, c, 'Move it up', H, 'E');
  add(A.HoldDown, c, 'Move it down', H, 'Q');
  add(A.HoldRotate, c, 'Move ↔ rotate', P, 'R');
  add(A.HoldStepDown, c, 'Smaller snap step', P, 'Z');
  add(A.HoldStepUp, c, 'Larger snap step', P, 'X');
  add(A.HoldFine, c, 'Fine moves (hold)', H, 'Shift');
  add(A.HoldSnapInvert, c, 'Flip snapping (hold)', H, 'Ctrl');

  // Markup editor
  c = InputContext.Markup;
  add(A.MarkupArrow, c, 'Arrow', P, 'A');
  add(A.MarkupBox, c, 'Box', P, 'R');
  add(A.MarkupEllipse, c, 'Ellipse', P, 'E');
  add(A.MarkupPen, c, 'Pen', P, 'P');
  add(A.MarkupText, c, 'Text', P, 'T');
  for (let i = 0; i < 5; i++) { add(InputCatalog.markupColourAction(i), c, `Colour ${i + 1}`, P, String(i + 1)); }
  add(A.MarkupUndo, c, 'Undo', P, 'Ctrl+Z');
  add(A.MarkupRedo, c, 'Redo', P, 'Ctrl+Y', 'Ctrl+Shift+Z');
  add(A.MarkupSave, c, 'Save the markup', P, 'Enter');

  // Editors
  add(A.SectionFreeDrag, InputContext.SectionEditor, 'Drag a handle without snapping (hold)', H, 'Shift');
  add(A.PhotoTake, InputContext.PhotoMode, 'Take the photo', P, 'Enter');
  add(A.SunPlay, InputContext.SunPanel, 'Play / pause the day', P, 'Space');
  add(A.TourPause, InputContext.Tour, 'Pause / play', P, 'Space');
  add(A.TourNext, InputContext.Tour, 'Next stop', P, 'Right', 'PageDown', 'LMB');
  add(A.TourPrevious, InputContext.Tour, "Previous stop (or this stop's start)", P, 'Left', 'PageUp', 'RMB');

  // Clash mode (the move keys fly, RMB-drag looks)
  c = InputContext.Clashes;
  add(A.ClashNext, c, 'Next clash', R, '.');
  add(A.ClashPrevious, c, 'Previous clash', R, ',');
  add(A.ClashFrame, c, 'Go to the current clash again (re-frame)', P, 'Enter');
  add(A.ClashStatusNew, c, 'Status: new', P, '1');
  add(A.ClashStatusActive, c, 'Status: active', P, '2');
  add(A.ClashStatusReviewed, c, 'Status: reviewed', P, '3');
  add(A.ClashStatusApproved, c, 'Status: approved', P, '4');
  add(A.ClashStatusResolved, c, 'Status: resolved', P, '5');
  add(A.ClashSelectInRevit, c, 'Show in Revit: the pair selected in a clash 3D view (live)', P, 'R');
  add(A.ClashFlyUp, c, 'Fly up (hold)', H, 'Space', 'E');
  add(A.ClashFlyDown, c, 'Fly down (hold)', H, 'Ctrl', 'Q');
  add(A.ClashView, c, 'Model view: ghost / wireframe / real / hidden', P, 'G');
  add(A.ClashSectionToggle, c, 'Section box on / off (on: around the current clash)', P, 'B');
  add(A.ClashSelectAll, c, 'Select all shown clashes (focus on them all) / clear', P, 'Ctrl+A');
  add(A.ClashPictures, c, 'Row pictures on / off', P, 'P');
  add(A.ClashGroup, c, 'Group the selected clashes', P, 'Ctrl+G');
  add(A.ClashUngroup, c, 'Ungroup the picked group / take the selected clashes out of their groups', P, 'Ctrl+Shift+G');
  add(A.ClashPickPoints, c, 'Pick points: click dots or rows to pick, then group them (again or Esc leaves)', P, 'K');
  add(A.ClashStatusCycle, c, 'Status: next (new → active → reviewed → approved → resolved)', P);

  // Path editor (P-B reserved; Round K-B reads them)
  c = InputContext.PathEditor;
  add(A.PathAddKey, c, 'Add a key at this view (on the path: inserted there)', P, 'K');
  add(A.PathDeleteKey, c, 'Delete the selected key', P, 'Delete');
  add(A.PathPreview, c, 'Preview the flythrough (play / pause)', P, 'Space');
  add(A.PathPreviousKey, c, 'Previous key (the camera snaps into it)', R, 'Left');
  add(A.PathNextKey, c, 'Next key (the camera snaps into it)', R, 'Right');
  add(A.PathSetKey, c, 'Set the selected key to this view', P, 'Enter');
  add(A.PathMoveForward, c, 'Fly forward', H, 'W');
  add(A.PathMoveBack, c, 'Fly back', H, 'S');
  add(A.PathMoveLeft, c, 'Fly left', H, 'A');
  add(A.PathMoveRight, c, 'Fly right', H, 'D');
  add(A.PathFlyUp, c, 'Fly up (hold)', H, 'E');
  add(A.PathFlyDown, c, 'Fly down (hold)', H, 'Q');
  add(A.PathFlyFast, c, 'Fly faster · drag a handle without snapping (hold)', H, 'Shift');
  add(A.PathUndo, c, 'Undo the last path change', P, 'Ctrl+Z');

  // Pause menu (sky round; the browser keeps Tab for the minimap elsewhere, the pause menu has it free)
  add(A.MenuPreview, InputContext.PauseMenu, 'Options preview: the scene with the graphics settings only (again or Esc returns)', P, 'Tab');

  // Fixed
  fixed(A.Back, 'Pause menu · back · cancel · stop', P, true, InputContext.Fixed, 'Esc');
  fixed(A.CloseWindow, 'Close the window', P, true, InputContext.Fixed, 'Alt+F4');
  fixed(A.Click, 'Menus, panels, handles, markup', P, false, InputContext.Fixed, 'LMB');
  fixed(A.DragLook, 'Look around (drag; photo, section box, study)', H, false, InputContext.Fixed, 'RMB');
  fixed(A.FineAdjust, 'Finer slider and stepper changes (hold)', H, false, InputContext.Fixed, 'Shift');
  fixed(A.PhotoZoom, 'Field of view (photo mode)', P, false, InputContext.PhotoMode, 'WheelUp', 'WheelDown');
  fixed(A.OpenFile, 'Open a file (start screen)', P, false, InputContext.Fixed, 'Ctrl+O');
  fixed(A.PadClick, 'Gamepad: click where the cursor is (menus, panels, editors)', P, false, InputContext.Fixed);
  fixed(A.PadMenuBack, 'Gamepad: back (menus, panels, editors)', P, false, InputContext.Fixed);

  // Gamepad (Xbox-style; standard mapping in the browser): move on the left stick, look on the right, the shoulders as
  // modifiers with the D-pad, RS click opens the gun wheel, LS click sprints
  const byAction = new Map<InputAction, ActionDef>(list.map(d => [d.action, d]));
  const pad = (action: InputAction, chord: string) => { byAction.get(action)!.padDefault = KeyChord.parse(chord); };
  pad(A.Back, 'PadStart');
  pad(A.PadClick, 'PadA');
  pad(A.PadMenuBack, 'PadB');
  pad(A.Help, 'PadLB+PadBack');
  pad(A.Minimap, 'PadBack');
  pad(A.MoveForward, 'PadLSUp');
  pad(A.MoveBack, 'PadLSDown');
  pad(A.MoveLeft, 'PadLSLeft');
  pad(A.MoveRight, 'PadLSRight');
  pad(A.LookUp, 'PadRSUp');
  pad(A.LookDown, 'PadRSDown');
  pad(A.LookLeft, 'PadRSLeft');
  pad(A.LookRight, 'PadRSRight');
  pad(A.Jump, 'PadA');
  pad(A.Crouch, 'PadB');
  pad(A.Run, 'PadLS');
  pad(A.Fly, 'PadY');
  pad(A.LevelUp, 'PadUp');
  pad(A.LevelDown, 'PadDown');
  pad(A.GoHome, 'PadLB+PadLeft');
  pad(A.GunPrimary, 'PadRT');
  pad(A.GunSecondary, 'PadLT');
  pad(A.GunWheel, 'PadRS');
  pad(A.ClearMarkers, 'PadRB+PadX');
  pad(A.Shadows, 'PadLB+PadUp');
  pad(A.Lights, 'PadLB+PadDown');
  pad(A.Coordinates, 'PadLB+PadRight');
  pad(A.SunEarlier, 'PadLeft');
  pad(A.SunLater, 'PadRight');
  pad(A.PhotoMode, 'PadRB+PadUp');
  pad(A.SectionBox, 'PadRB+PadDown');
  pad(A.SunStudy, 'PadRB+PadLeft');
  pad(A.SunPanel, 'PadRB+PadRight');
  pad(A.ScanHide, 'PadX');
  pad(A.ScanIsolate, 'PadLB+PadX');
  pad(A.MeasureNormal, 'PadX');
  pad(A.DemolishMode, 'PadX');
  pad(A.GizmoDrop, 'PadX');
  pad(A.GizmoSnap, 'PadLB+PadX');
  pad(A.HoldUp, 'PadUp');
  pad(A.HoldDown, 'PadDown');
  pad(A.HoldStepDown, 'PadLeft');
  pad(A.HoldStepUp, 'PadRight');
  pad(A.HoldRotate, 'PadY');
  pad(A.HoldFine, 'PadRS');
  pad(A.PhotoTake, 'PadRT');
  pad(A.TourPause, 'PadA');
  pad(A.TourNext, 'PadRight');
  pad(A.TourPrevious, 'PadLeft');
  pad(A.ClashNext, 'PadRight');
  pad(A.ClashPrevious, 'PadLeft');
  pad(A.ClashFrame, 'PadY');
  pad(A.ClashSelectInRevit, 'PadX');
  pad(A.ClashFlyUp, 'PadRT');
  pad(A.ClashFlyDown, 'PadLT');
  pad(A.ClashView, 'PadUp');
  pad(A.ClashSectionToggle, 'PadDown');
  pad(A.ClashSelectAll, 'PadRB+PadX');
  pad(A.ClashPictures, 'PadBack');
  pad(A.Unarmed, 'PadRB+PadB');
  pad(A.MenuPreview, 'PadY');
  // Polish round P-B: the actions that had no gamepad binding
  pad(A.AddBookmark, 'PadLB+PadA');
  pad(A.GridsCycle, 'PadLB+PadY');
  pad(A.ColourProfile, 'PadRB+PadY');
  pad(A.GridsPanel, 'PadLB+PadB');
  pad(A.ClashMode, 'PadRB+PadBack');
  pad(A.CommentEdit, 'PadX');
  pad(A.HoldSnapInvert, 'PadLS');
  pad(A.SunPlay, 'PadY');
  pad(A.ClashGroup, 'PadRB+PadA');
  pad(A.ClashUngroup, 'PadRB+PadB');
  pad(A.ClashStatusCycle, 'PadLB+PadA');
  pad(A.PathAddKey, 'PadX');
  pad(A.PathDeleteKey, 'PadLB+PadX');
  pad(A.PathPreview, 'PadY');
  pad(A.PathPreviousKey, 'PadLeft');
  pad(A.PathNextKey, 'PadRight');
  pad(A.PathSetKey, 'PadRB+PadY');
  pad(A.PathMoveForward, 'PadLSUp');
  pad(A.PathMoveBack, 'PadLSDown');
  pad(A.PathMoveLeft, 'PadLSLeft');
  pad(A.PathMoveRight, 'PadLSRight');
  pad(A.PathFlyUp, 'PadRT');
  pad(A.PathFlyDown, 'PadLT');
  pad(A.PathFlyFast, 'PadLS');
  return list;
}

/** Situation names (the app finds the one it is in by these: GameSession.currentSituation). */
export const Situations = {
  WALKING: 'Walking',
  SCAN: 'Walking with the Scan gun',
  MEASURE: 'Walking with the Measure gun',
  COMMENT: 'Walking with the Comment gun',
  DEMOLISH: 'Walking with the Demolish gun',
  GIZMO: 'Walking with the Gizmo, Clone or Place gun',
  HOLDING: 'Holding an element',
  MARKUP: 'Markup editor',
  SECTION: 'Section box editor',
  PHOTO: 'Photo mode',
  SUN_PANEL: 'Sun panel',
  STUDY: 'Sun / daylight study',
  TOUR: 'Bookmark tour',
  CLASHES: 'Clash mode',
  GRIDS: 'Grids panel',
  VIDEO: 'Recording a video',
  START: 'Start screen',
  PAUSE: 'Pause menu and panels',
  PATH: 'Path editor (Round K)'
} as const;

function buildSituations(): InputSituation[] {
  const walking = [InputContext.General, InputContext.Movement, InputContext.Guns, InputContext.Tools];
  const withGun = (gun: InputContext) => [...walking, gun];
  const sunTime = [A.SunEarlier, A.SunEarlierFine, A.SunLater, A.SunLaterFine];
  const padMenu = [A.PadClick, A.PadMenuBack];
  const S = Situations;

  // F1 rows (polish round P-B): most used first
  const h = (label: string, ...actions: InputAction[]) => new HelpEntry(label, null, actions);
  const hk = (label: string, keyText: string, ...actions: InputAction[]) => new HelpEntry(label, keyText, actions);
  const move = h('Move', A.MoveForward, A.MoveLeft, A.MoveBack, A.MoveRight);
  const look = hk('Look', 'MOUSE', A.LookUp, A.LookDown, A.LookLeft, A.LookRight);
  const dragLook = h('Look (drag)', A.DragLook);
  const click = h('Click · back', A.Click, A.PadClick, A.PadMenuBack);
  const sunTimeRow = h('Sun time −/+ 5 min', A.SunEarlier, A.SunLater);
  const sunFineRow = h('Sun time −/+ 1 min', A.SunEarlierFine, A.SunLaterFine);
  const fine = h('Finer slider steps (hold)', A.FineAdjust);
  const walk = (...gunRows: HelpEntry[]) => [
    move,
    h('Jump · crouch', A.Jump, A.Crouch),
    h('Run', A.Run),
    h('Fly / walk', A.Fly),
    h('Level up · down', A.LevelUp, A.LevelDown),
    h('Fire · secondary', A.GunPrimary, A.GunSecondary),
    h('Select gun · gun wheel', A.Gun1, A.Gun2, A.Gun3, A.Gun4, A.Gun5, A.Gun6, A.Gun7, A.Gun8, A.Gun9, A.GunWheel),
    ...gunRows,
    h('Bookmark this view', A.AddBookmark),
    h('Shadows · sun panel', A.Shadows, A.SunPanel),
    sunTimeRow,
    h('Section box · photo · media · paths', A.SectionBox, A.PhotoMode, A.MediaPanel, A.PathEditMode),
    h('Clash mode', A.ClashMode),
    h('Grids · colour profile', A.GridsCycle, A.ColourProfile),
    h('Minimap · hide the UI', A.Minimap, A.HideUi),
    look,
    h('Go home · go to bookmark', A.GoHome, A.Bookmark1, A.Bookmark2, A.Bookmark3, A.Bookmark4, A.Bookmark5, A.Bookmark6, A.Bookmark7, A.Bookmark8, A.Bookmark9)
  ].slice(0, 16);
  const clashHelp = [
    h('Previous · next clash', A.ClashPrevious, A.ClashNext),
    h('Go to it again', A.ClashFrame),
    h('Status 1–5 · next status', A.ClashStatusNew, A.ClashStatusActive, A.ClashStatusReviewed, A.ClashStatusApproved, A.ClashStatusResolved, A.ClashStatusCycle),
    h('Fly', A.MoveForward, A.MoveLeft, A.MoveBack, A.MoveRight),
    h('Fly up · down', A.ClashFlyUp, A.ClashFlyDown),
    dragLook,
    h('Model view · section box', A.ClashView, A.ClashSectionToggle),
    h('Show in Revit', A.ClashSelectInRevit),
    h('Select all shown', A.ClashSelectAll),
    h('Group · ungroup', A.ClashGroup, A.ClashUngroup),
    h('Pick points', A.ClashPickPoints),
    h('Row pictures', A.ClashPictures),
    h('Grids · colour profile', A.GridsCycle, A.ColourProfile),
    h('Grids panel', A.GridsPanel),
    h('Leave clash mode', A.ClashMode),
    click
  ];

  return [
    new InputSituation(S.WALKING, walking, [], walk()),
    new InputSituation(S.SCAN, withGun(InputContext.ScanGun), [], walk(
      h('Hide · isolate its category', A.ScanHide, A.ScanIsolate), h('Select in Revit (live)', A.ScanSelectInRevit))),
    new InputSituation(S.MEASURE, withGun(InputContext.MeasureGun), [], walk(
      h('Measure mode', A.GunModePrevious, A.GunModeNext), h('Normal projection', A.MeasureNormal), h('Clear the markers', A.ClearMarkers))),
    new InputSituation(S.COMMENT, withGun(InputContext.CommentGun), [], walk(h('Edit the hovered comment', A.CommentEdit))),
    new InputSituation(S.DEMOLISH, withGun(InputContext.DemolishGun), [], walk(h('Demolish / delete', A.DemolishMode))),
    new InputSituation(S.GIZMO, withGun(InputContext.GizmoGuns), [], walk(h('Drop onto the surface · snap', A.GizmoDrop, A.GizmoSnap))),
    new InputSituation(S.HOLDING, [InputContext.Holding, InputContext.GizmoGuns], [
      A.MoveForward, A.MoveBack, A.MoveLeft, A.MoveRight, A.Minimap, A.HideUi, A.Help, A.Fullscreen, A.Screenshot,
      A.GunPrimary, A.GunSecondary, A.LookUp, A.LookDown, A.LookLeft, A.LookRight
    ], [
      h('Move it', A.MoveForward, A.MoveLeft, A.MoveBack, A.MoveRight),
      h('Up · down', A.HoldUp, A.HoldDown),
      h('Move ↔ rotate', A.HoldRotate),
      h('Snap step smaller · larger', A.HoldStepDown, A.HoldStepUp),
      h('Fine moves (hold)', A.HoldFine),
      h('Flip snapping (hold)', A.HoldSnapInvert),
      h('Snap on / off', A.GizmoSnap),
      h('Drop onto the surface', A.GizmoDrop),
      h('Commit', A.GunSecondary),
      look,
      h('Cancel', A.Back)
    ]),
    new InputSituation(S.MARKUP, [InputContext.Markup], [...padMenu, A.Fullscreen, A.Click], [
      h('Arrow · box · ellipse · pen · text', A.MarkupArrow, A.MarkupBox, A.MarkupEllipse, A.MarkupPen, A.MarkupText),
      h('Colours', A.MarkupColour1, A.MarkupColour2, A.MarkupColour3, A.MarkupColour4, A.MarkupColour5),
      h('Undo · redo', A.MarkupUndo, A.MarkupRedo),
      h('Save the markup', A.MarkupSave),
      click
    ]),
    new InputSituation(S.SECTION, [InputContext.SectionEditor], [...padMenu,
      A.SectionBox, A.SectionClear, A.Fullscreen, A.Screenshot, A.Click, A.DragLook], [
      h('Drag a handle · back', A.Click, A.PadClick, A.PadMenuBack),
      h('Without snapping (hold)', A.SectionFreeDrag),
      dragLook,
      h('Clear all cuts', A.SectionClear),
      h('Close the editor', A.SectionBox)
    ]),
    new InputSituation(S.PHOTO, [InputContext.PhotoMode], [...sunTime, A.PhotoMode, A.Fullscreen, A.Click, A.DragLook, A.PadClick, A.PadMenuBack], [
      h('Take the photo', A.PhotoTake),
      h('Field of view', A.PhotoZoom),
      dragLook,
      sunTimeRow,
      h('Close photo mode', A.PhotoMode),
      click
    ]),
    new InputSituation(S.SUN_PANEL, [InputContext.SunPanel], [...sunTime, A.Shadows, A.SunPanel, A.Fullscreen, A.Click, A.FineAdjust, A.PadClick, A.PadMenuBack], [
      h('Play / pause the day', A.SunPlay),
      sunTimeRow,
      sunFineRow,
      h('Shadows on / off', A.Shadows),
      fine,
      h('Close the sun panel', A.SunPanel),
      click
    ]),
    new InputSituation(S.STUDY, [], [...padMenu, A.SunStudy, A.Fullscreen, A.Screenshot, A.Click, A.DragLook, A.FineAdjust], [
      h('Pick surfaces · back', A.Click, A.PadClick, A.PadMenuBack),
      dragLook,
      fine,
      h('Screenshot', A.Screenshot),
      h('Close the study', A.SunStudy)
    ]),
    new InputSituation(S.TOUR, [InputContext.Tour], [A.Fullscreen], [
      h('Pause / play', A.TourPause),
      h('Previous · next stop', A.TourPrevious, A.TourNext),
      h('Stop the tour', A.Back)
    ]),
    new InputSituation(S.CLASHES, [InputContext.Clashes], [...padMenu,
      A.MoveForward, A.MoveBack, A.MoveLeft, A.MoveRight, A.Run, A.ClashMode, A.Help, A.HideUi, A.Fullscreen, A.Screenshot,
      A.Click, A.DragLook, A.GridsPanel, A.GridsCycle, A.ColourProfile], clashHelp),
    new InputSituation(S.GRIDS, [], [...padMenu, A.GridsPanel, A.GridsCycle, A.Fullscreen, A.Click, A.FineAdjust], [
      h('Grids: off / underfoot / all', A.GridsCycle),
      fine,
      h('Close the grids panel', A.GridsPanel),
      click
    ]),
    new InputSituation(S.VIDEO, [], [A.Fullscreen], [h('Stop recording', A.Back), h('Fullscreen', A.Fullscreen)]),
    new InputSituation(S.START, [], [...padMenu, A.OpenFile, A.Click], [h('Open a file', A.OpenFile), click]),
    new InputSituation(S.PAUSE, [InputContext.PauseMenu], [...padMenu,
      A.Help, A.Fullscreen, A.Screenshot, A.Refresh, A.Save, A.SaveAs, A.Undo, A.Redo, A.Click], [
      click,
      h('Options preview', A.MenuPreview),
      h('Save · save as', A.Save, A.SaveAs),
      h('Undo · redo (files)', A.Undo, A.Redo),
      h('Refresh from Revit (live)', A.Refresh)
    ]),
    // Round K-B: the 3D path editor (← / → snap into keys, so it flies on its own WASD / E / Q actions)
    new InputSituation(S.PATH, [InputContext.PathEditor], [...padMenu,
      A.PathEditMode, A.Help, A.HideUi, A.Fullscreen, A.Screenshot, A.Click, A.DragLook], [
      h('Fly', A.PathMoveForward, A.PathMoveLeft, A.PathMoveBack, A.PathMoveRight),
      h('Fly up · down', A.PathFlyUp, A.PathFlyDown),
      h('Faster · free drag (hold)', A.PathFlyFast),
      dragLook,
      h('Add a key · delete it', A.PathAddKey, A.PathDeleteKey),
      h('Previous · next key (snap in)', A.PathPreviousKey, A.PathNextKey),
      h('Set the key to this view', A.PathSetKey),
      h('Preview', A.PathPreview),
      h('Undo', A.PathUndo),
      h('Leave the editor', A.PathEditMode),
      click
    ])
  ];
}

/** Every default that changed, by version (oldest first); was: the old binding. */
const DEFAULTS_CHANGES: readonly DefaultsChange[] = [
  // Version 1 (P-B): pick points on K, the status cycle, the path editor reserved; gamepad bindings for what had none
  ...[A.ClashPickPoints, A.ClashStatusCycle, A.PathAddKey, A.PathDeleteKey, A.PathPreview, A.PathPreviousKey, A.PathNextKey]
    .map(action => ({ version: 1, action, added: true, was: null })),
  ...[A.AddBookmark, A.GridsCycle, A.ColourProfile, A.GridsPanel, A.ClashMode, A.CommentEdit, A.HoldSnapInvert, A.SunPlay, A.ClashGroup, A.ClashUngroup]
    .map(action => ({ version: 1, action, added: false, was: 'gamepad: none' })),
  // Version 2 (Round K-A): the media panel
  { version: 2, action: A.MediaPanel, added: true, was: null },
  // Version 3 (Round K-B): the 3D path editor and its own fly keys
  ...[A.PathEditMode, A.PathSetKey, A.PathMoveForward, A.PathMoveBack, A.PathMoveLeft, A.PathMoveRight, A.PathFlyUp, A.PathFlyDown, A.PathFlyFast, A.PathUndo]
    .map(action => ({ version: 3, action, added: true, was: null }))
];

const ACTION_COUNT = Math.max(...Object.values(InputAction).filter((v): v is number => typeof v === 'number')) + 1;

let defs: ActionDef[] | null = null;
let byAction: (ActionDef | undefined)[] = [];
let byId: Map<string, InputAction> = new Map();
let situations: InputSituation[] | null = null;
let together: Uint8Array | null = null;

function ensure(): void {
  if (defs) { return; }
  const built = buildDefinitions();
  byAction = new Array<ActionDef | undefined>(ACTION_COUNT);
  for (const def of built) { byAction[def.action] = def; }
  byId = new Map(built.map(d => [d.id.toLowerCase(), d.action]));
  defs = built;
}

/** The catalogue of actions and their defaults. */
export const InputCatalog = {
  /** Highest action value + 1. */
  get actionCount(): number { return ACTION_COUNT; },

  /**
   * The controls defaults version (polish round P-B). 0: up to P-A2; 1: P-B's hotkey review; 2: Round K-A's media panel;
   * 3: Round K-B's path editor. Raise it when a default changes and add the changes to defaultsChanges.
   */
  DEFAULTS_VERSION: 3,

  /** Every default that changed, by version. */
  get defaultsChanges(): readonly DefaultsChange[] { return DEFAULTS_CHANGES; },

  /** The changes made after a version the user saw. */
  changesSince(seenVersion: number): DefaultsChange[] {
    return DEFAULTS_CHANGES.filter(c => c.version > seenVersion);
  },

  /** A situation by name (null when unknown). */
  situation(name: string): InputSituation | null {
    return InputCatalog.situations.find(s => s.name === name) ?? null;
  },

  /** Every action in display order. */
  get all(): readonly ActionDef[] {
    ensure();
    return defs!;
  },

  /** The definition of an action (undefined for None or an unknown value). */
  get(action: InputAction): ActionDef | undefined {
    ensure();
    return action > 0 && action < ACTION_COUNT ? byAction[action] : undefined;
  },

  /** An action by its stored id (case-insensitive); None when unknown. */
  fromId(id: string | null | undefined): InputAction {
    if (!id || !id.trim()) { return A.None; }
    ensure();
    return byId.get(id.trim().toLowerCase()) ?? A.None;
  },

  /** The gun selection action for gun slot 0–8. */
  gunAction(index: number): InputAction { return A.Gun1 + Math.min(Math.max(index, 0), 8); },

  /** The go-to-bookmark action for bookmark 0–8. */
  bookmarkAction(index: number): InputAction { return A.Bookmark1 + Math.min(Math.max(index, 0), 8); },

  /** The markup colour action for colour 0–4. */
  markupColourAction(index: number): InputAction { return A.MarkupColour1 + Math.min(Math.max(index, 0), 4); },

  /** Groups in display order. */
  CONTEXT_ORDER: [
    InputContext.General, InputContext.Movement, InputContext.Guns, InputContext.Tools,
    InputContext.ScanGun, InputContext.MeasureGun, InputContext.CommentGun, InputContext.DemolishGun, InputContext.GizmoGuns,
    InputContext.Holding, InputContext.Markup, InputContext.SectionEditor, InputContext.PhotoMode, InputContext.SunPanel,
    InputContext.Tour, InputContext.Clashes, InputContext.PauseMenu, InputContext.PathEditor, InputContext.Fixed
  ] as readonly InputContext[],

  /** A group's heading. */
  contextName(context: InputContext): string {
    switch (context) {
      case InputContext.General: return 'General';
      case InputContext.Movement: return 'Movement';
      case InputContext.Guns: return 'Guns';
      case InputContext.Tools: return 'Views and tools';
      case InputContext.ScanGun: return 'Scan gun';
      case InputContext.MeasureGun: return 'Measure gun';
      case InputContext.CommentGun: return 'Comment gun';
      case InputContext.DemolishGun: return 'Demolish gun';
      case InputContext.GizmoGuns: return 'Gizmo, Clone and Place guns';
      case InputContext.Holding: return 'Holding an element';
      case InputContext.Markup: return 'Markup editor';
      case InputContext.SectionEditor: return 'Section box editor';
      case InputContext.PhotoMode: return 'Photo mode';
      case InputContext.SunPanel: return 'Sun panel';
      case InputContext.Tour: return 'Bookmark tour and camera paths';
      case InputContext.Clashes: return 'Clash mode';
      case InputContext.PauseMenu: return 'Pause menu';
      case InputContext.PathEditor: return 'Path editor (Round K)';
      default: return 'Fixed (not rebindable)';
    }
  },

  /** A group's one-line note, or null. */
  contextNote(context: InputContext): string | null {
    switch (context) {
      case InputContext.ScanGun: case InputContext.MeasureGun: case InputContext.CommentGun: case InputContext.DemolishGun: case InputContext.GizmoGuns:
        return 'While the gun is selected (walking keys still work).';
      case InputContext.Holding:
        return 'While the Gizmo, Clone or Place gun holds an element: the move keys move it (left / right turn it in rotate mode), gun secondary commits, Esc cancels.';
      case InputContext.Markup: return "After a comment's picture is taken. Text typing keeps Enter / Backspace / Esc.";
      case InputContext.SectionEditor: return 'The section box key or Esc closes it; clear all cuts still works.';
      case InputContext.PhotoMode: return 'The photo mode key or Esc closes it; the sun time keys work.';
      case InputContext.SunPanel: return 'Shadows / sun panel or Esc closes it; the sun time keys work.';
      case InputContext.Tour: return 'While a bookmark tour or a camera path plays (Esc stops it).';
      case InputContext.Clashes:
        return "Clash detection's docked list (the clash mode key or Esc leaves): the move keys fly, run speeds up, RMB-drag looks, the wheel scrolls the list.";
      case InputContext.PauseMenu: return 'While the pause menu shows (not in its panels).';
      case InputContext.PathEditor:
        return 'The 3D camera path editor (the path editor key, or MEDIA → PATHS → EDIT IN 3D; Esc leaves): free cursor, RMB-drag looks, click a key or a handle, drag the handles; the scrubber at the bottom drives the camera.';
      case InputContext.Fixed:
        return 'Text boxes also keep Enter, Tab, Backspace, ↑ / ↓, Ctrl+V and Esc. Gamepad in menus and editors: the look stick moves the cursor, the move stick scrolls (menus) or looks (editors); over menus and docks the D-pad moves the focus ring and LB / RB tapped alone switch tabs; A with LB / RB held is a chord, not a click.';
      default: return null;
    }
  },

  /** Every state of the app and what can fire in it (mirrors GameSession.updateFrame: change both together). */
  get situations(): readonly InputSituation[] {
    situations ??= buildSituations();
    return situations;
  },

  /** True when the two actions can fire in the same situation (an action is always live with itself). */
  liveTogether(a: InputAction, b: InputAction): boolean {
    if (a <= 0 || b <= 0 || a >= ACTION_COUNT || b >= ACTION_COUNT) { return false; }
    if (a === b) { return true; }
    if (!together) {
      ensure();
      const n = ACTION_COUNT;
      const table = new Uint8Array(n * n);
      for (const situation of InputCatalog.situations) {
        const members: number[] = [];
        for (let x = 1; x < n; x++) { if (byAction[x] && situation.contains(x)) { members.push(x); } }
        for (const x of members) { for (const y of members) { table[x * n + y] = 1; } }
      }
      together = table;
    }
    return together[a * ACTION_COUNT + b] === 1;
  }
};
