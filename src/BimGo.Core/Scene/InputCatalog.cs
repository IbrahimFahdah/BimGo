// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Groups of actions (input round B2): a heading in the CONTROLS panel, F1 help and README §3. Which groups are
    /// live at the same time is decided by <see cref="InputCatalog.Situations"/>, not by the group alone.
    /// </summary>
    public enum InputContext : byte
    {
        General,
        Movement,
        Guns,
        Tools,
        ScanGun,
        MeasureGun,
        CommentGun,
        DemolishGun,
        GizmoGuns,
        Holding,
        Markup,
        SectionEditor,
        PhotoMode,
        SunPanel,
        Tour,

        /// <summary>Clash mode (Round C-B): the docked clash list, free cursor, flying.</summary>
        Clashes,

        /// <summary>Sky round: the pause menu's own keys (the options preview).</summary>
        PauseMenu,

        /// <summary>
        /// Polish round P-B: Round K's flythrough path editor. Reserved now (the keys are in the clash test and CONTROLS);
        /// K-A / K-B wire them.
        /// </summary>
        PathEditor,

        /// <summary>Keys that can't be rebound (Esc, menus and panels' mouse, Alt+F4). Listed for reference and clash checks.</summary>
        Fixed
    }

    /// <summary>
    /// How an action reads its keys. Only matters for what can be bound: a held action can't use the wheel.
    /// </summary>
    public enum ActionKind : byte
    {
        /// <summary>Fires once when the key goes down.</summary>
        Press,

        /// <summary>Fires when the key goes down and again on keyboard auto-repeat (stepping).</summary>
        Repeat,

        /// <summary>Read while held (movement, run, fine adjustment).</summary>
        Hold
    }

    /// <summary>
    /// Every input action in BimGo (input round B2): the one place keys are named. Code asks for actions
    /// (<c>input.Pressed(InputAction.Save)</c>), never for raw keys; only text boxes read typed characters directly.
    /// The enum names are the ids stored in settings.json and keymap files: <b>never rename one</b> (add new ones at the
    /// end of their group and give a retired one's id no new meaning).
    /// </summary>
    public enum InputAction : ushort
    {
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

        // Clash mode (Round C-B)
        ClashNext, ClashPrevious, ClashFrame, ClashStatusNew, ClashStatusActive, ClashStatusReviewed, ClashStatusApproved,
        ClashStatusResolved, ClashSelectInRevit, ClashFlyUp, ClashFlyDown, ClashView, ClashSectionToggle,
        ClashSelectAll, ClashPictures, ClashGroup, ClashUngroup,
        ClashPickPoints, ClashStatusCycle, // polish round P-B

        // Pause menu (sky round)
        MenuPreview,

        // Path editor (polish round P-B: reserved for Round K's flythrough)
        PathAddKey, PathDeleteKey, PathPreview, PathPreviousKey, PathNextKey,
        PathSetKey, PathMoveForward, PathMoveBack, PathMoveLeft, PathMoveRight, PathFlyUp, PathFlyDown, PathFlyFast, PathUndo, // Round K-B

        // Fixed (not rebindable)
        Back, CloseWindow, Click, DragLook, FineAdjust, PhotoZoom, OpenFile, PadClick, PadMenuBack
    }

    /// <summary>
    /// One action: its group, label, kind and default keys (at most <see cref="KeyMap.MAX_SLOTS"/>).
    /// </summary>
    public sealed class ActionDef
    {
        internal ActionDef(InputAction action, InputContext context, string label, ActionKind kind, KeyChord[] defaults, bool isFixed, bool everywhere)
        {
            Action = action;
            Context = context;
            Label = label;
            Kind = kind;
            Defaults = defaults;
            IsFixed = isFixed;
            Everywhere = everywhere;
        }

        /// <summary>The action.</summary>
        public InputAction Action { get; }

        /// <summary>Stored id (the enum name).</summary>
        public string Id => Action.ToString();

        /// <summary>Its group.</summary>
        public InputContext Context { get; }

        /// <summary>What it does, as the CONTROLS panel, help and README show it.</summary>
        public string Label { get; }

        /// <summary>How it reads its keys.</summary>
        public ActionKind Kind { get; }

        /// <summary>Default bindings (primary first).</summary>
        public IReadOnlyList<KeyChord> Defaults { get; }

        /// <summary>Default gamepad binding (build B; None when the gamepad has none).</summary>
        public KeyChord PadDefault { get; internal set; }

        /// <summary>True when it can't be rebound.</summary>
        public bool IsFixed { get; }

        /// <summary>True for fixed keys live in every situation (Esc, Alt+F4).</summary>
        public bool Everywhere { get; }
    }

    /// <summary>
    /// A state of the app with the actions that can fire in it (walking with the Scan gun, holding an element, the
    /// markup editor…). Two actions clash when some situation holds both and they share a binding.
    /// </summary>
    public sealed class InputSituation
    {
        internal InputSituation(string name, InputContext[] contexts, InputAction[] extra, HelpEntry[] help = null)
        {
            Name = name;
            Contexts = contexts;
            Extra = extra;
            Help = help ?? Array.Empty<HelpEntry>();
        }

        /// <summary>Name for clash messages and the F1 sheet's title (the app finds a situation by it).</summary>
        public string Name { get; }

        /// <summary>
        /// Polish round P-B: the F1 sheet's rows here, most used first (about 12–16; the sheet drops rows that don't fit
        /// and always ends with "Esc → CONTROLS" and the F1 row).
        /// </summary>
        public IReadOnlyList<HelpEntry> Help { get; }

        /// <summary>Groups live in full.</summary>
        public IReadOnlyList<InputContext> Contexts { get; }

        /// <summary>Single actions of other groups that are also live (e.g. the editors' close keys).</summary>
        public IReadOnlyList<InputAction> Extra { get; }

        /// <summary>True when the action can fire in this situation.</summary>
        public bool Contains(InputAction action)
        {
            ActionDef def = InputCatalog.Get(action);
            if (def == null) { return false; }
            if (def.Everywhere) { return true; }
            for (int i = 0; i < Contexts.Count; i++)
            {
                if (Contexts[i] == def.Context) { return true; }
            }
            for (int i = 0; i < Extra.Count; i++)
            {
                if (Extra[i] == action) { return true; }
            }
            return false;
        }
    }

    /// <summary>
    /// One row of the generated F1 sheet (polish round P-B): a short label and the actions whose keys it shows. Several
    /// actions read as one row (move: WASD / LS; status 1–5); <see cref="KeyText"/> stands in for the key column when the
    /// keyboard side isn't a binding (looking with the mouse).
    /// </summary>
    public sealed class HelpEntry
    {
        internal HelpEntry(string label, string keyText, InputAction[] actions)
        {
            Label = label;
            KeyText = keyText;
            Actions = actions;
        }

        /// <summary>What the row does (short).</summary>
        public string Label { get; }

        /// <summary>Fixed key-column text (null: the actions' keys).</summary>
        public string KeyText { get; }

        /// <summary>The actions shown (their keys and gamepad buttons).</summary>
        public IReadOnlyList<InputAction> Actions { get; }
    }

    /// <summary>
    /// A default that changed in a controls defaults version (polish round P-B): a new action, or new keys or gamepad
    /// binding for an existing one. The app shows a one-time toast and NEW / CHANGED tags for the versions a user hasn't
    /// seen (settings <c>ControlsDefaultsVersion</c>).
    /// </summary>
    public readonly record struct DefaultsChange(int Version, InputAction Action, bool Added, string Was);

    /// <summary>
    /// The catalogue of actions and their default keys (input round B2): the single source for the action map, the
    /// CONTROLS panel, F1 help, README §3 and the default-clash tests. Polish round P-B's hotkey review changed a few
    /// defaults (<see cref="DefaultsChanges"/>, <see cref="DEFAULTS_VERSION"/>) and gave each situation its F1 rows.
    /// </summary>
    public static class InputCatalog
    {
        #region Definitions

        private static readonly ActionDef[] DEFS = BuildDefinitions();
        private static readonly ActionDef[] BY_ACTION = Index(DEFS);

        /// <summary>Highest action value + 1 (array size for per-action tables).</summary>
        public static int ActionCount => BY_ACTION.Length;

        /// <summary>Every action in display order (by group, then as listed).</summary>
        public static IReadOnlyList<ActionDef> All => DEFS;

        /// <summary>The definition of an action (null for <see cref="InputAction.None"/> or an unknown value).</summary>
        public static ActionDef Get(InputAction action)
        {
            int index = (int)action;
            return index > 0 && index < BY_ACTION.Length ? BY_ACTION[index] : null;
        }

        /// <summary>Finds an action by its stored id (case-insensitive); None when unknown.</summary>
        public static InputAction FromId(string id)
        {
            if (string.IsNullOrWhiteSpace(id)) { return InputAction.None; }
            return BY_ID.TryGetValue(id.Trim(), out InputAction action) ? action : InputAction.None;
        }

        // Exact names only (Enum.TryParse would also take numbers and comma lists)
        private static readonly Dictionary<string, InputAction> BY_ID = DEFS.ToDictionary(d => d.Id, d => d.Action, StringComparer.OrdinalIgnoreCase);

        /// <summary>The gun selection action for gun slot 0–8.</summary>
        public static InputAction GunAction(int index) => (InputAction)((int)InputAction.Gun1 + Math.Clamp(index, 0, 8));

        /// <summary>The go-to-bookmark action for bookmark 0–8.</summary>
        public static InputAction BookmarkAction(int index) => (InputAction)((int)InputAction.Bookmark1 + Math.Clamp(index, 0, 8));

        /// <summary>The markup colour action for colour 0–4.</summary>
        public static InputAction MarkupColourAction(int index) => (InputAction)((int)InputAction.MarkupColour1 + Math.Clamp(index, 0, 4));

        private static ActionDef[] BuildDefinitions()
        {
            var list = new List<ActionDef>(128);
            void Add(InputAction action, InputContext context, string label, ActionKind kind, params string[] keys) =>
                list.Add(new ActionDef(action, context, label, kind, Parse(keys), isFixed: false, everywhere: false));
            void Fixed(InputAction action, string label, ActionKind kind, bool everywhere, InputContext context, params string[] keys) =>
                list.Add(new ActionDef(action, context, label, kind, Parse(keys), isFixed: true, everywhere: everywhere));

            const ActionKind P = ActionKind.Press, R = ActionKind.Repeat, H = ActionKind.Hold;

            // General
            InputContext c = InputContext.General;
            Add(InputAction.Help, c, "Help on / off", P, "F1");
            Add(InputAction.Fullscreen, c, "Fullscreen", P, "F11");
            Add(InputAction.Screenshot, c, "Screenshot", P, "F12");
            Add(InputAction.HideUi, c, "Hide / show the UI", P, "U");
            Add(InputAction.Minimap, c, "Minimap", P, "Tab");
            Add(InputAction.Refresh, c, "Refresh from Revit (live)", P, "F5");
            Add(InputAction.Save, c, "Save", P, "Ctrl+S");
            Add(InputAction.SaveAs, c, "Save as", P, "Ctrl+Shift+S");
            Add(InputAction.Undo, c, "Undo (files)", P, "Ctrl+Z");
            Add(InputAction.Redo, c, "Redo (files)", P, "Ctrl+Y", "Ctrl+Shift+Z");

            // Movement
            c = InputContext.Movement;
            Add(InputAction.MoveForward, c, "Move forward", H, "W", "Up");
            Add(InputAction.MoveBack, c, "Move back", H, "S", "Down");
            Add(InputAction.MoveLeft, c, "Move left", H, "A", "Left");
            Add(InputAction.MoveRight, c, "Move right", H, "D", "Right");
            Add(InputAction.Jump, c, "Jump (flying: up)", H, "Space");
            Add(InputAction.Run, c, "Run (hold)", H, "Shift");
            Add(InputAction.Crouch, c, "Crouch (flying: down)", H, "Ctrl");
            Add(InputAction.Fly, c, "Fly / walk (no-clip)", P, "V");
            Add(InputAction.LevelUp, c, "Level up", P, "PageUp");
            Add(InputAction.LevelDown, c, "Level down", P, "PageDown");
            Add(InputAction.GoHome, c, "Go home", P, "H");
            Add(InputAction.SetHome, c, "Set home here", P, "Shift+H");
            Add(InputAction.FindRoom, c, "Find room", P, "Ctrl+F");
            Add(InputAction.LookUp, c, "Look up", H);
            Add(InputAction.LookDown, c, "Look down", H);
            Add(InputAction.LookLeft, c, "Look left", H);
            Add(InputAction.LookRight, c, "Look right", H);

            // Guns
            c = InputContext.Guns;
            string[] guns = { "Scan", "Measure (again: next mode)", "Portal", "Comment", "Teleport", "Demolish", "Gizmo", "Clone", "Place" };
            for (int i = 0; i < 9; i++) { Add(GunAction(i), c, "Gun " + (i + 1) + ": " + guns[i], P, (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture)); }
            Add(InputAction.PreviousGun, c, "Previous gun", P, "Shift+WheelUp");
            Add(InputAction.NextGun, c, "Next gun", P, "Shift+WheelDown");
            Add(InputAction.GunModePrevious, c, "Gun mode: previous (Measure, Demolish)", P, "WheelUp");
            Add(InputAction.GunModeNext, c, "Gun mode: next (Measure, Demolish)", P, "WheelDown");
            Add(InputAction.Unarmed, c, "None: no gun (again, or a gun key, arms)", P, "0");
            Add(InputAction.GunPrimary, c, "Gun primary (fire)", P, "LMB");
            Add(InputAction.GunSecondary, c, "Gun secondary", P, "RMB");
            Add(InputAction.ClearMarkers, c, "Clear this gun's markers", P, "X");
            Add(InputAction.GunWheel, c, "Gun wheel (mouse: hold, steer, release; gamepad: click, steer, A / click again picks, B cancels)", H, "MMB");

            // Views and tools
            c = InputContext.Tools;
            Add(InputAction.AddBookmark, c, "Bookmark this view", P, "B");
            for (int i = 0; i < 9; i++) { Add(BookmarkAction(i), c, "Go to bookmark " + (i + 1), P, "Shift+" + (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture)); }
            Add(InputAction.Coordinates, c, "Coordinate readout", P, "L");
            Add(InputAction.Lights, c, "Artificial lights", P, "K");
            Add(InputAction.Shadows, c, "Shadows on / off", P, "O");
            Add(InputAction.SunPanel, c, "Sun panel", P, "Shift+O");
            Add(InputAction.SunEarlier, c, "Sun time −5 min", R, "[");
            Add(InputAction.SunEarlierFine, c, "Sun time −1 min", R, "Shift+[");
            Add(InputAction.SunLater, c, "Sun time +5 min", R, "]");
            Add(InputAction.SunLaterFine, c, "Sun time +1 min", R, "Shift+]");
            Add(InputAction.SunStudy, c, "Sun / daylight study", P, "J");
            Add(InputAction.PhotoMode, c, "Photo mode", P, "M");
            Add(InputAction.SectionBox, c, "Section box editor", P, "P");
            Add(InputAction.SectionPlane, c, "Cut at the aimed surface", P, "Shift+P");
            Add(InputAction.SectionClear, c, "Clear all cuts", P, "Ctrl+P");
            Add(InputAction.ClashMode, c, "Clash mode on / off (docked clash list)", P, "Y");
            Add(InputAction.GridsPanel, c, "Grids panel (also in clash mode)", P, "Shift+G");
            Add(InputAction.GridsCycle, c, "Grids: off / level underfoot / all levels (also in clash mode)", P, "C");
            Add(InputAction.ColourProfile, c, "Colour profile on / off (also in clash mode)", P, "Shift+C");
            Add(InputAction.MediaPanel, c, "Media panel: photo, tour, camera paths, video", P, "Shift+M"); // Round K-A
            Add(InputAction.PathEditMode, c, "Camera path editor in 3D on / off", P, "Shift+K"); // Round K-B

            // Gun keys (while that gun is selected)
            Add(InputAction.ScanSelectInRevit, InputContext.ScanGun, "Select in Revit (live)", P, "R");
            Add(InputAction.ScanHide, InputContext.ScanGun, "Hide the target", P, "I");
            Add(InputAction.ScanIsolate, InputContext.ScanGun, "Isolate its category (again: show all)", P, "Shift+I");
            Add(InputAction.MeasureNormal, InputContext.MeasureGun, "Normal projection (distance mode)", P, "N");
            Add(InputAction.CommentEdit, InputContext.CommentGun, "Edit the hovered comment", P, "E");
            Add(InputAction.DemolishMode, InputContext.DemolishGun, "Demolish / delete mode", P, "T");
            Add(InputAction.GizmoSnap, InputContext.GizmoGuns, "Snap on / off", P, "G");
            Add(InputAction.GizmoDrop, InputContext.GizmoGuns, "Drop onto the surface below", P, "F");

            // Holding an element (Gizmo / Clone / Place locked on; the move keys move it)
            c = InputContext.Holding;
            Add(InputAction.HoldUp, c, "Move it up", H, "E");
            Add(InputAction.HoldDown, c, "Move it down", H, "Q");
            Add(InputAction.HoldRotate, c, "Move ↔ rotate", P, "R");
            Add(InputAction.HoldStepDown, c, "Smaller snap step", P, "Z");
            Add(InputAction.HoldStepUp, c, "Larger snap step", P, "X");
            Add(InputAction.HoldFine, c, "Fine moves (hold)", H, "Shift");
            Add(InputAction.HoldSnapInvert, c, "Flip snapping (hold)", H, "Ctrl");

            // Markup editor
            c = InputContext.Markup;
            Add(InputAction.MarkupArrow, c, "Arrow", P, "A");
            Add(InputAction.MarkupBox, c, "Box", P, "R");
            Add(InputAction.MarkupEllipse, c, "Ellipse", P, "E");
            Add(InputAction.MarkupPen, c, "Pen", P, "P");
            Add(InputAction.MarkupText, c, "Text", P, "T");
            for (int i = 0; i < 5; i++) { Add(MarkupColourAction(i), c, "Colour " + (i + 1), P, (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture)); }
            Add(InputAction.MarkupUndo, c, "Undo", P, "Ctrl+Z");
            Add(InputAction.MarkupRedo, c, "Redo", P, "Ctrl+Y", "Ctrl+Shift+Z");
            Add(InputAction.MarkupSave, c, "Save the markup", P, "Enter");

            // Editors
            Add(InputAction.SectionFreeDrag, InputContext.SectionEditor, "Drag a handle without snapping (hold)", H, "Shift");
            Add(InputAction.PhotoTake, InputContext.PhotoMode, "Take the photo", P, "Enter");
            Add(InputAction.SunPlay, InputContext.SunPanel, "Play / pause the day", P, "Space");
            Add(InputAction.TourPause, InputContext.Tour, "Pause / play", P, "Space");
            Add(InputAction.TourNext, InputContext.Tour, "Next stop", P, "Right", "PageDown", "LMB");
            Add(InputAction.TourPrevious, InputContext.Tour, "Previous stop (or this stop's start)", P, "Left", "PageUp", "RMB");

            // Clash mode (Round C-B: Y or pause menu → CLASHES → REVIEW; the move keys fly, RMB-drag looks)
            c = InputContext.Clashes;
            Add(InputAction.ClashNext, c, "Next clash", R, ".");
            Add(InputAction.ClashPrevious, c, "Previous clash", R, ",");
            Add(InputAction.ClashFrame, c, "Go to the current clash again (re-frame)", P, "Enter");
            Add(InputAction.ClashStatusNew, c, "Status: new", P, "1");
            Add(InputAction.ClashStatusActive, c, "Status: active", P, "2");
            Add(InputAction.ClashStatusReviewed, c, "Status: reviewed", P, "3");
            Add(InputAction.ClashStatusApproved, c, "Status: approved", P, "4");
            Add(InputAction.ClashStatusResolved, c, "Status: resolved", P, "5");
            Add(InputAction.ClashSelectInRevit, c, "Show in Revit: the pair selected in a clash 3D view (live)", P, "R");
            Add(InputAction.ClashFlyUp, c, "Fly up (hold)", H, "Space", "E");
            Add(InputAction.ClashFlyDown, c, "Fly down (hold)", H, "Ctrl", "Q");
            Add(InputAction.ClashView, c, "Model view: ghost / wireframe / real / hidden", P, "G");
            Add(InputAction.ClashSectionToggle, c, "Section box on / off (on: around the current clash)", P, "B");
            Add(InputAction.ClashSelectAll, c, "Select all shown clashes (focus on them all) / clear", P, "Ctrl+A");
            Add(InputAction.ClashPictures, c, "Row pictures on / off", P, "P");
            Add(InputAction.ClashGroup, c, "Group the selected clashes", P, "Ctrl+G");
            Add(InputAction.ClashUngroup, c, "Ungroup the picked group / take the selected clashes out of their groups", P, "Ctrl+Shift+G");
            Add(InputAction.ClashPickPoints, c, "Pick points: click dots or rows to pick, then group them (again or Esc leaves)", P, "K"); // P-B
            Add(InputAction.ClashStatusCycle, c, "Status: next (new → active → reviewed → approved → resolved)", P); // P-B: gamepad LB+A

            // Path editor (polish round P-B: reserved for Round K; Round K-B: the 3D editor reads them)
            c = InputContext.PathEditor;
            Add(InputAction.PathAddKey, c, "Add a key at this view (on the path: inserted there)", P, "K");
            Add(InputAction.PathDeleteKey, c, "Delete the selected key", P, "Delete");
            Add(InputAction.PathPreview, c, "Preview the flythrough (play / pause)", P, "Space");
            Add(InputAction.PathPreviousKey, c, "Previous key (the camera snaps into it)", R, "Left");
            Add(InputAction.PathNextKey, c, "Next key (the camera snaps into it)", R, "Right");
            Add(InputAction.PathSetKey, c, "Set the selected key to this view", P, "Enter");
            Add(InputAction.PathMoveForward, c, "Fly forward", H, "W");
            Add(InputAction.PathMoveBack, c, "Fly back", H, "S");
            Add(InputAction.PathMoveLeft, c, "Fly left", H, "A");
            Add(InputAction.PathMoveRight, c, "Fly right", H, "D");
            Add(InputAction.PathFlyUp, c, "Fly up (hold)", H, "E");
            Add(InputAction.PathFlyDown, c, "Fly down (hold)", H, "Q");
            Add(InputAction.PathFlyFast, c, "Fly faster · drag a handle without snapping (hold)", H, "Shift");
            Add(InputAction.PathUndo, c, "Undo the last path change", P, "Ctrl+Z");

            // Pause menu (sky round)
            Add(InputAction.MenuPreview, InputContext.PauseMenu, "Options preview: the scene with the graphics settings only (again or Esc returns)", P, "Tab");

            // Fixed
            Fixed(InputAction.Back, "Pause menu · back · cancel · stop", P, true, InputContext.Fixed, "Esc");
            Fixed(InputAction.CloseWindow, "Close the window", P, true, InputContext.Fixed, "Alt+F4");
            Fixed(InputAction.Click, "Menus, panels, handles, markup", P, false, InputContext.Fixed, "LMB");
            Fixed(InputAction.DragLook, "Look around (drag; photo, section box, study)", H, false, InputContext.Fixed, "RMB");
            Fixed(InputAction.FineAdjust, "Finer slider and stepper changes (hold)", H, false, InputContext.Fixed, "Shift");
            Fixed(InputAction.PhotoZoom, "Field of view (photo mode)", P, false, InputContext.PhotoMode, "WheelUp", "WheelDown");
            Fixed(InputAction.OpenFile, "Open a file (start screen)", P, false, InputContext.Fixed, "Ctrl+O");
            Fixed(InputAction.PadClick, "Gamepad: click where the cursor is (menus, panels, editors)", P, false, InputContext.Fixed);
            Fixed(InputAction.PadMenuBack, "Gamepad: back (menus, panels, editors)", P, false, InputContext.Fixed);

            // Gamepad (build B; Xbox-style, a secondary input: the keyboard and mouse keys above are unchanged). Move on the
            // left stick and look on the right (SWAP STICKS in CONTROLS), the shoulders as modifiers with the D-pad, the
            // right stick's click opens the gun wheel, the left stick's click sprints.
            var byAction = new Dictionary<InputAction, ActionDef>();
            foreach (ActionDef def in list) { byAction[def.Action] = def; }
            void Pad(InputAction action, string chord) => byAction[action].PadDefault = KeyChord.Parse(chord);

            Pad(InputAction.Back, "PadStart");
            Pad(InputAction.PadClick, "PadA");
            Pad(InputAction.PadMenuBack, "PadB");
            Pad(InputAction.Help, "PadLB+PadBack");
            Pad(InputAction.Minimap, "PadBack");
            Pad(InputAction.MoveForward, "PadLSUp");
            Pad(InputAction.MoveBack, "PadLSDown");
            Pad(InputAction.MoveLeft, "PadLSLeft");
            Pad(InputAction.MoveRight, "PadLSRight");
            Pad(InputAction.LookUp, "PadRSUp");
            Pad(InputAction.LookDown, "PadRSDown");
            Pad(InputAction.LookLeft, "PadRSLeft");
            Pad(InputAction.LookRight, "PadRSRight");
            Pad(InputAction.Jump, "PadA");
            Pad(InputAction.Crouch, "PadB");
            Pad(InputAction.Run, "PadLS");
            Pad(InputAction.Fly, "PadY");
            Pad(InputAction.LevelUp, "PadUp");
            Pad(InputAction.LevelDown, "PadDown");
            Pad(InputAction.GoHome, "PadLB+PadLeft");
            Pad(InputAction.GunPrimary, "PadRT");
            Pad(InputAction.GunSecondary, "PadLT");
            Pad(InputAction.GunWheel, "PadRS");
            Pad(InputAction.ClearMarkers, "PadRB+PadX");
            Pad(InputAction.Shadows, "PadLB+PadUp");
            Pad(InputAction.Lights, "PadLB+PadDown");
            Pad(InputAction.Coordinates, "PadLB+PadRight");
            Pad(InputAction.SunEarlier, "PadLeft");
            Pad(InputAction.SunLater, "PadRight");
            Pad(InputAction.PhotoMode, "PadRB+PadUp");
            Pad(InputAction.SectionBox, "PadRB+PadDown");
            Pad(InputAction.SunStudy, "PadRB+PadLeft");
            Pad(InputAction.SunPanel, "PadRB+PadRight");
            Pad(InputAction.ScanHide, "PadX");
            Pad(InputAction.ScanIsolate, "PadLB+PadX");
            Pad(InputAction.MeasureNormal, "PadX");
            Pad(InputAction.DemolishMode, "PadX");
            Pad(InputAction.GizmoDrop, "PadX");
            Pad(InputAction.GizmoSnap, "PadLB+PadX");
            Pad(InputAction.HoldUp, "PadUp");
            Pad(InputAction.HoldDown, "PadDown");
            Pad(InputAction.HoldStepDown, "PadLeft");
            Pad(InputAction.HoldStepUp, "PadRight");
            Pad(InputAction.HoldRotate, "PadY");
            Pad(InputAction.HoldFine, "PadRS");
            Pad(InputAction.PhotoTake, "PadRT");
            Pad(InputAction.TourPause, "PadA");
            Pad(InputAction.TourNext, "PadRight");
            Pad(InputAction.TourPrevious, "PadLeft");
            Pad(InputAction.ClashNext, "PadRight");
            Pad(InputAction.ClashPrevious, "PadLeft");
            Pad(InputAction.ClashFrame, "PadY");
            Pad(InputAction.ClashSelectInRevit, "PadX");
            Pad(InputAction.ClashFlyUp, "PadRT");
            Pad(InputAction.ClashFlyDown, "PadLT");
            Pad(InputAction.ClashView, "PadUp");               // sky round: the rest of clash mode on the pad
            Pad(InputAction.ClashSectionToggle, "PadDown");
            Pad(InputAction.ClashSelectAll, "PadRB+PadX");
            Pad(InputAction.ClashPictures, "PadBack");
            Pad(InputAction.Unarmed, "PadRB+PadB");
            Pad(InputAction.MenuPreview, "PadY");

            // Polish round P-B: the actions that had no gamepad binding. Walking: LB / RB with A, B, Y and Back (the
            // D-pad chords are full); clash mode: RB+A / RB+B group / ungroup, LB+A the next status. Gun and editor keys
            // take the free face button (Comment: X like the other guns' tool; sun panel: Y plays).
            Pad(InputAction.AddBookmark, "PadLB+PadA");
            Pad(InputAction.GridsCycle, "PadLB+PadY");
            Pad(InputAction.ColourProfile, "PadRB+PadY");
            Pad(InputAction.GridsPanel, "PadLB+PadB");
            Pad(InputAction.ClashMode, "PadRB+PadBack");
            Pad(InputAction.CommentEdit, "PadX");
            Pad(InputAction.HoldSnapInvert, "PadLS");
            Pad(InputAction.SunPlay, "PadY");
            Pad(InputAction.ClashGroup, "PadRB+PadA");
            Pad(InputAction.ClashUngroup, "PadRB+PadB");
            Pad(InputAction.ClashStatusCycle, "PadLB+PadA");
            Pad(InputAction.PathAddKey, "PadX");
            Pad(InputAction.PathDeleteKey, "PadLB+PadX");
            Pad(InputAction.PathPreview, "PadY");
            Pad(InputAction.PathPreviousKey, "PadLeft");
            Pad(InputAction.PathNextKey, "PadRight");
            Pad(InputAction.PathSetKey, "PadRB+PadY"); // Round K-B (the editor itself: MEDIA → PATHS → EDIT IN 3D, DONE)
            Pad(InputAction.PathMoveForward, "PadLSUp");
            Pad(InputAction.PathMoveBack, "PadLSDown");
            Pad(InputAction.PathMoveLeft, "PadLSLeft");
            Pad(InputAction.PathMoveRight, "PadLSRight");
            Pad(InputAction.PathFlyUp, "PadRT");
            Pad(InputAction.PathFlyDown, "PadLT");
            Pad(InputAction.PathFlyFast, "PadLS");

            return list.ToArray();
        }

        private static KeyChord[] Parse(string[] keys)
        {
            var chords = new KeyChord[keys.Length];
            for (int i = 0; i < keys.Length; i++) { chords[i] = KeyChord.Parse(keys[i]); }
            return chords;
        }

        private static ActionDef[] Index(ActionDef[] defs)
        {
            int max = 0;
            foreach (InputAction action in Enum.GetValues<InputAction>()) { max = Math.Max(max, (int)action); }
            var byAction = new ActionDef[max + 1];
            foreach (ActionDef def in defs) { byAction[(int)def.Action] = def; }
            return byAction;
        }

        #endregion

        #region Groups

        /// <summary>Groups in display order.</summary>
        public static readonly InputContext[] CONTEXT_ORDER =
        {
            InputContext.General, InputContext.Movement, InputContext.Guns, InputContext.Tools,
            InputContext.ScanGun, InputContext.MeasureGun, InputContext.CommentGun, InputContext.DemolishGun, InputContext.GizmoGuns,
            InputContext.Holding, InputContext.Markup, InputContext.SectionEditor, InputContext.PhotoMode, InputContext.SunPanel,
            InputContext.Tour, InputContext.Clashes, InputContext.PauseMenu, InputContext.PathEditor, InputContext.Fixed
        };

        /// <summary>A group's heading.</summary>
        public static string ContextName(InputContext context) => context switch
        {
            InputContext.General => "General",
            InputContext.Movement => "Movement",
            InputContext.Guns => "Guns",
            InputContext.Tools => "Views and tools",
            InputContext.ScanGun => "Scan gun",
            InputContext.MeasureGun => "Measure gun",
            InputContext.CommentGun => "Comment gun",
            InputContext.DemolishGun => "Demolish gun",
            InputContext.GizmoGuns => "Gizmo, Clone and Place guns",
            InputContext.Holding => "Holding an element",
            InputContext.Markup => "Markup editor",
            InputContext.SectionEditor => "Section box editor",
            InputContext.PhotoMode => "Photo mode",
            InputContext.SunPanel => "Sun panel",
            InputContext.Tour => "Bookmark tour and camera paths",
            InputContext.Clashes => "Clash mode",
            InputContext.PauseMenu => "Pause menu",
            InputContext.PathEditor => "Path editor (Round K)",
            _ => "Fixed (not rebindable)"
        };

        /// <summary>A group's one-line note (what else is live there), or null.</summary>
        public static string ContextNote(InputContext context) => context switch
        {
            InputContext.ScanGun or InputContext.MeasureGun or InputContext.CommentGun or InputContext.DemolishGun or InputContext.GizmoGuns
                => "While the gun is selected (walking keys still work).",
            InputContext.Holding => "While the Gizmo, Clone or Place gun holds an element: the move keys move it (left / right turn it in rotate mode), gun secondary commits, Esc cancels.",
            InputContext.Markup => "After a comment's picture is taken. Text typing keeps Enter / Backspace / Esc.",
            InputContext.SectionEditor => "The section box key or Esc closes it; clear all cuts still works.",
            InputContext.PhotoMode => "The photo mode key or Esc closes it; the sun time keys work.",
            InputContext.SunPanel => "Shadows / sun panel or Esc closes it; the sun time keys work.",
            InputContext.Tour => "While a bookmark tour or a camera path plays (Esc stops it).",
            InputContext.Clashes => "Clash detection's docked list (the clash mode key or Esc leaves): the move keys fly, run speeds up, RMB-drag looks, the wheel scrolls the list.",
            InputContext.PauseMenu => "While the pause menu shows (not in its panels).",
            InputContext.PathEditor => "The 3D camera path editor (the path editor key, or MEDIA → PATHS → EDIT IN 3D; Esc leaves): free cursor, RMB-drag looks, click a key or a handle, drag the handles; the scrubber at the bottom drives the camera.",
            InputContext.Fixed => "Text boxes also keep Enter, Tab, Backspace, ↑ / ↓, Ctrl+V and Esc. Gamepad in menus and editors: the look stick moves the cursor, the move stick scrolls (menus) or looks (editors); over menus and docks the D-pad moves the focus ring and LB / RB tapped alone switch tabs; A with LB / RB held is a chord, not a click.",
            _ => null
        };

        #endregion

        #region Situations

        // Situation names (the app finds the one it is in by these: GameSession.CurrentSituation)
        public const string SIT_WALKING = "Walking";
        public const string SIT_SCAN = "Walking with the Scan gun";
        public const string SIT_MEASURE = "Walking with the Measure gun";
        public const string SIT_COMMENT = "Walking with the Comment gun";
        public const string SIT_DEMOLISH = "Walking with the Demolish gun";
        public const string SIT_GIZMO = "Walking with the Gizmo, Clone or Place gun";
        public const string SIT_HOLDING = "Holding an element";
        public const string SIT_MARKUP = "Markup editor";
        public const string SIT_SECTION = "Section box editor";
        public const string SIT_PHOTO = "Photo mode";
        public const string SIT_SUN_PANEL = "Sun panel";
        public const string SIT_STUDY = "Sun / daylight study";
        public const string SIT_TOUR = "Bookmark tour";
        public const string SIT_CLASHES = "Clash mode";
        public const string SIT_GRIDS = "Grids panel";
        public const string SIT_VIDEO = "Recording a video";
        public const string SIT_START = "Start screen";
        public const string SIT_PAUSE = "Pause menu and panels";
        public const string SIT_PATH = "Path editor (Round K)";

        /// <summary>
        /// Every state of the app and what can fire in it. Mirrors <c>GameSession.UpdateFrame</c>: change both together.
        /// </summary>
        public static readonly InputSituation[] Situations = BuildSituations();

        /// <summary>A situation by name (null when unknown).</summary>
        public static InputSituation Situation(string name)
        {
            foreach (InputSituation situation in Situations)
            {
                if (string.Equals(situation.Name, name, StringComparison.Ordinal)) { return situation; }
            }
            return null;
        }

        private static InputSituation[] BuildSituations()
        {
            InputContext[] walking = { InputContext.General, InputContext.Movement, InputContext.Guns, InputContext.Tools };
            InputContext[] With(InputContext gun) => walking.Append(gun).ToArray();
            InputAction[] sunTime = { InputAction.SunEarlier, InputAction.SunEarlierFine, InputAction.SunLater, InputAction.SunLaterFine };
            InputAction[] Join(InputAction[] a, params InputAction[] b) => a.Concat(b).ToArray();
            InputAction[] padMenu = { InputAction.PadClick, InputAction.PadMenuBack };

            // F1 rows (polish round P-B): most used first
            static HelpEntry H(string label, params InputAction[] actions) => new(label, null, actions);
            static HelpEntry HK(string label, string keyText, params InputAction[] actions) => new(label, keyText, actions);
            HelpEntry move = H("Move", InputAction.MoveForward, InputAction.MoveLeft, InputAction.MoveBack, InputAction.MoveRight);
            HelpEntry look = HK("Look", "MOUSE", InputAction.LookUp, InputAction.LookDown, InputAction.LookLeft, InputAction.LookRight);
            HelpEntry dragLook = H("Look (drag)", InputAction.DragLook);
            HelpEntry click = H("Click · back", InputAction.Click, InputAction.PadClick, InputAction.PadMenuBack);
            HelpEntry sunTimeRow = H("Sun time −/+ 5 min", InputAction.SunEarlier, InputAction.SunLater);
            HelpEntry sunFineRow = H("Sun time −/+ 1 min", InputAction.SunEarlierFine, InputAction.SunLaterFine);
            HelpEntry fine = H("Finer slider steps (hold)", InputAction.FineAdjust);

            // Walking: the movement and gun rows, the gun's own rows, then views and tools (cut to 16)
            HelpEntry[] Walk(params HelpEntry[] gunRows)
            {
                var rows = new List<HelpEntry>
                {
                    move,
                    H("Jump · crouch", InputAction.Jump, InputAction.Crouch),
                    H("Run", InputAction.Run),
                    H("Fly / walk", InputAction.Fly),
                    H("Level up · down", InputAction.LevelUp, InputAction.LevelDown),
                    H("Fire · secondary", InputAction.GunPrimary, InputAction.GunSecondary),
                    H("Select gun · gun wheel", InputAction.Gun1, InputAction.Gun2, InputAction.Gun3, InputAction.Gun4, InputAction.Gun5,
                        InputAction.Gun6, InputAction.Gun7, InputAction.Gun8, InputAction.Gun9, InputAction.GunWheel)
                };
                rows.AddRange(gunRows);
                rows.AddRange(new[]
                {
                    H("Bookmark this view", InputAction.AddBookmark),
                    H("Shadows · sun panel", InputAction.Shadows, InputAction.SunPanel),
                    sunTimeRow,
                    H("Section box · photo · media · paths", InputAction.SectionBox, InputAction.PhotoMode, InputAction.MediaPanel, InputAction.PathEditMode),
                    H("Clash mode", InputAction.ClashMode),
                    H("Grids · colour profile", InputAction.GridsCycle, InputAction.ColourProfile),
                    H("Minimap · hide the UI", InputAction.Minimap, InputAction.HideUi),
                    look,
                    H("Go home · go to bookmark", InputAction.GoHome, InputAction.Bookmark1, InputAction.Bookmark2, InputAction.Bookmark3,
                        InputAction.Bookmark4, InputAction.Bookmark5, InputAction.Bookmark6, InputAction.Bookmark7, InputAction.Bookmark8, InputAction.Bookmark9)
                });
                return rows.Take(16).ToArray();
            }

            HelpEntry[] clashHelp =
            {
                H("Previous · next clash", InputAction.ClashPrevious, InputAction.ClashNext),
                H("Go to it again", InputAction.ClashFrame),
                H("Status 1–5 · next status", InputAction.ClashStatusNew, InputAction.ClashStatusActive, InputAction.ClashStatusReviewed,
                    InputAction.ClashStatusApproved, InputAction.ClashStatusResolved, InputAction.ClashStatusCycle),
                H("Fly", InputAction.MoveForward, InputAction.MoveLeft, InputAction.MoveBack, InputAction.MoveRight),
                H("Fly up · down", InputAction.ClashFlyUp, InputAction.ClashFlyDown),
                dragLook,
                H("Model view · section box", InputAction.ClashView, InputAction.ClashSectionToggle),
                H("Show in Revit", InputAction.ClashSelectInRevit),
                H("Select all shown", InputAction.ClashSelectAll),
                H("Group · ungroup", InputAction.ClashGroup, InputAction.ClashUngroup),
                H("Pick points", InputAction.ClashPickPoints),
                H("Row pictures", InputAction.ClashPictures),
                H("Grids · colour profile", InputAction.GridsCycle, InputAction.ColourProfile),
                H("Grids panel", InputAction.GridsPanel),
                H("Leave clash mode", InputAction.ClashMode),
                click
            };

            return new[]
            {
                new InputSituation(SIT_WALKING, walking, Array.Empty<InputAction>(), Walk()),
                new InputSituation(SIT_SCAN, With(InputContext.ScanGun), Array.Empty<InputAction>(), Walk(
                    H("Hide · isolate its category", InputAction.ScanHide, InputAction.ScanIsolate),
                    H("Select in Revit (live)", InputAction.ScanSelectInRevit))),
                new InputSituation(SIT_MEASURE, With(InputContext.MeasureGun), Array.Empty<InputAction>(), Walk(
                    H("Measure mode", InputAction.GunModePrevious, InputAction.GunModeNext),
                    H("Normal projection", InputAction.MeasureNormal),
                    H("Clear the markers", InputAction.ClearMarkers))),
                new InputSituation(SIT_COMMENT, With(InputContext.CommentGun), Array.Empty<InputAction>(), Walk(
                    H("Edit the hovered comment", InputAction.CommentEdit))),
                new InputSituation(SIT_DEMOLISH, With(InputContext.DemolishGun), Array.Empty<InputAction>(), Walk(
                    H("Demolish / delete", InputAction.DemolishMode))),
                new InputSituation(SIT_GIZMO, With(InputContext.GizmoGuns), Array.Empty<InputAction>(), Walk(
                    H("Drop onto the surface · snap", InputAction.GizmoDrop, InputAction.GizmoSnap))),
                new InputSituation(SIT_HOLDING, new[] { InputContext.Holding, InputContext.GizmoGuns }, new[]
                {
                    InputAction.MoveForward, InputAction.MoveBack, InputAction.MoveLeft, InputAction.MoveRight,
                    InputAction.Minimap, InputAction.HideUi, InputAction.Help, InputAction.Fullscreen, InputAction.Screenshot,
                    InputAction.GunPrimary, InputAction.GunSecondary, InputAction.LookUp, InputAction.LookDown, InputAction.LookLeft, InputAction.LookRight
                }, new[]
                {
                    H("Move it", InputAction.MoveForward, InputAction.MoveLeft, InputAction.MoveBack, InputAction.MoveRight),
                    H("Up · down", InputAction.HoldUp, InputAction.HoldDown),
                    H("Move ↔ rotate", InputAction.HoldRotate),
                    H("Snap step smaller · larger", InputAction.HoldStepDown, InputAction.HoldStepUp),
                    H("Fine moves (hold)", InputAction.HoldFine),
                    H("Flip snapping (hold)", InputAction.HoldSnapInvert),
                    H("Snap on / off", InputAction.GizmoSnap),
                    H("Drop onto the surface", InputAction.GizmoDrop),
                    H("Commit", InputAction.GunSecondary),
                    look,
                    H("Cancel", InputAction.Back)
                }),
                new InputSituation(SIT_MARKUP, new[] { InputContext.Markup }, Join(padMenu, InputAction.Fullscreen, InputAction.Click), new[]
                {
                    H("Arrow · box · ellipse · pen · text", InputAction.MarkupArrow, InputAction.MarkupBox, InputAction.MarkupEllipse,
                        InputAction.MarkupPen, InputAction.MarkupText),
                    H("Colours", InputAction.MarkupColour1, InputAction.MarkupColour2, InputAction.MarkupColour3, InputAction.MarkupColour4,
                        InputAction.MarkupColour5),
                    H("Undo · redo", InputAction.MarkupUndo, InputAction.MarkupRedo),
                    H("Save the markup", InputAction.MarkupSave),
                    click
                }),
                new InputSituation(SIT_SECTION, new[] { InputContext.SectionEditor }, Join(padMenu,
                    InputAction.SectionBox, InputAction.SectionClear, InputAction.Fullscreen, InputAction.Screenshot, InputAction.Click, InputAction.DragLook), new[]
                {
                    H("Drag a handle · back", InputAction.Click, InputAction.PadClick, InputAction.PadMenuBack),
                    H("Without snapping (hold)", InputAction.SectionFreeDrag),
                    dragLook,
                    H("Clear all cuts", InputAction.SectionClear),
                    H("Close the editor", InputAction.SectionBox)
                }),
                new InputSituation(SIT_PHOTO, new[] { InputContext.PhotoMode },
                    Join(sunTime, InputAction.PhotoMode, InputAction.Fullscreen, InputAction.Click, InputAction.DragLook, InputAction.PadClick, InputAction.PadMenuBack), new[]
                {
                    H("Take the photo", InputAction.PhotoTake),
                    H("Field of view", InputAction.PhotoZoom),
                    dragLook,
                    sunTimeRow,
                    H("Close photo mode", InputAction.PhotoMode),
                    click
                }),
                new InputSituation(SIT_SUN_PANEL, new[] { InputContext.SunPanel },
                    Join(sunTime, InputAction.Shadows, InputAction.SunPanel, InputAction.Fullscreen, InputAction.Click, InputAction.FineAdjust, InputAction.PadClick, InputAction.PadMenuBack), new[]
                {
                    H("Play / pause the day", InputAction.SunPlay),
                    sunTimeRow,
                    sunFineRow,
                    H("Shadows on / off", InputAction.Shadows),
                    fine,
                    H("Close the sun panel", InputAction.SunPanel),
                    click
                }),
                new InputSituation(SIT_STUDY, Array.Empty<InputContext>(), Join(padMenu,
                    InputAction.SunStudy, InputAction.Fullscreen, InputAction.Screenshot, InputAction.Click, InputAction.DragLook, InputAction.FineAdjust), new[]
                {
                    H("Pick surfaces · back", InputAction.Click, InputAction.PadClick, InputAction.PadMenuBack),
                    dragLook,
                    fine,
                    H("Screenshot", InputAction.Screenshot),
                    H("Close the study", InputAction.SunStudy)
                }),
                new InputSituation(SIT_TOUR, new[] { InputContext.Tour }, new[] { InputAction.Fullscreen }, new[]
                {
                    H("Pause / play", InputAction.TourPause),
                    H("Previous · next stop", InputAction.TourPrevious, InputAction.TourNext),
                    H("Stop the tour", InputAction.Back)
                }),
                new InputSituation(SIT_CLASHES, new[] { InputContext.Clashes }, Join(padMenu,
                    InputAction.MoveForward, InputAction.MoveBack, InputAction.MoveLeft, InputAction.MoveRight, InputAction.Run,
                    InputAction.ClashMode, InputAction.Help, InputAction.HideUi, InputAction.Fullscreen, InputAction.Screenshot,
                    InputAction.Click, InputAction.DragLook, InputAction.GridsPanel, InputAction.GridsCycle, InputAction.ColourProfile), clashHelp),
                new InputSituation(SIT_GRIDS, Array.Empty<InputContext>(), Join(padMenu,
                    InputAction.GridsPanel, InputAction.GridsCycle, InputAction.Fullscreen, InputAction.Click, InputAction.FineAdjust), new[]
                {
                    H("Grids: off / underfoot / all", InputAction.GridsCycle),
                    fine,
                    H("Close the grids panel", InputAction.GridsPanel),
                    click
                }),
                new InputSituation(SIT_VIDEO, Array.Empty<InputContext>(), new[] { InputAction.Fullscreen }, new[]
                {
                    H("Stop recording", InputAction.Back),
                    H("Fullscreen", InputAction.Fullscreen)
                }),
                new InputSituation(SIT_START, Array.Empty<InputContext>(), Join(padMenu, InputAction.OpenFile, InputAction.Click), new[]
                {
                    H("Open a file", InputAction.OpenFile),
                    click
                }),
                new InputSituation(SIT_PAUSE, new[] { InputContext.PauseMenu }, Join(padMenu,
                    InputAction.Help, InputAction.Fullscreen, InputAction.Screenshot, InputAction.Refresh, InputAction.Save, InputAction.SaveAs,
                    InputAction.Undo, InputAction.Redo, InputAction.Click), new[]
                {
                    click,
                    H("Options preview", InputAction.MenuPreview),
                    H("Save · save as", InputAction.Save, InputAction.SaveAs),
                    H("Undo · redo (files)", InputAction.Undo, InputAction.Redo),
                    H("Refresh from Revit (live)", InputAction.Refresh)
                }),

                // Round K-B: the 3D path editor. ← / → snap into keys, so it flies on its own WASD / E / Q actions (the walking
                // moves keep the arrow keys)
                new InputSituation(SIT_PATH, new[] { InputContext.PathEditor }, Join(padMenu,
                    InputAction.PathEditMode, InputAction.Help, InputAction.HideUi, InputAction.Fullscreen, InputAction.Screenshot, InputAction.Click,
                    InputAction.DragLook), new[]
                {
                    H("Fly", InputAction.PathMoveForward, InputAction.PathMoveLeft, InputAction.PathMoveBack, InputAction.PathMoveRight),
                    H("Fly up · down", InputAction.PathFlyUp, InputAction.PathFlyDown),
                    H("Faster · free drag (hold)", InputAction.PathFlyFast),
                    dragLook,
                    H("Add a key · delete it", InputAction.PathAddKey, InputAction.PathDeleteKey),
                    H("Previous · next key (snap in)", InputAction.PathPreviousKey, InputAction.PathNextKey),
                    H("Set the key to this view", InputAction.PathSetKey),
                    H("Preview", InputAction.PathPreview),
                    H("Undo", InputAction.PathUndo),
                    H("Leave the editor", InputAction.PathEditMode),
                    click
                })
            };
        }

        #region Defaults versions

        /// <summary>
        /// The controls defaults version (polish round P-B). 0: the defaults up to P-A2; 1: P-B's hotkey review; 2: Round
        /// K-A's media panel; 3: Round K-B's path editor. Raise it when a default changes and add the changes to
        /// <see cref="DefaultsChanges"/> (ControlsTests checks the table against the defaults).
        /// </summary>
        public const int DEFAULTS_VERSION = 3;

        /// <summary>Every default that changed, by version (oldest first). <c>Was</c>: the old binding ("none" for none).</summary>
        public static readonly DefaultsChange[] DefaultsChanges =
        {
            // Version 1 (P-B): pick points on K, the status cycle, the path editor reserved; gamepad bindings for what had none
            new(1, InputAction.ClashPickPoints, true, null),
            new(1, InputAction.ClashStatusCycle, true, null),
            new(1, InputAction.PathAddKey, true, null),
            new(1, InputAction.PathDeleteKey, true, null),
            new(1, InputAction.PathPreview, true, null),
            new(1, InputAction.PathPreviousKey, true, null),
            new(1, InputAction.PathNextKey, true, null),
            new(1, InputAction.AddBookmark, false, "gamepad: none"),
            new(1, InputAction.GridsCycle, false, "gamepad: none"),
            new(1, InputAction.ColourProfile, false, "gamepad: none"),
            new(1, InputAction.GridsPanel, false, "gamepad: none"),
            new(1, InputAction.ClashMode, false, "gamepad: none"),
            new(1, InputAction.CommentEdit, false, "gamepad: none"),
            new(1, InputAction.HoldSnapInvert, false, "gamepad: none"),
            new(1, InputAction.SunPlay, false, "gamepad: none"),
            new(1, InputAction.ClashGroup, false, "gamepad: none"),
            new(1, InputAction.ClashUngroup, false, "gamepad: none"),

            // Version 2 (Round K-A): the media panel (photo, tour, camera paths, video)
            new(2, InputAction.MediaPanel, true, null),

            // Version 3 (Round K-B): the 3D path editor and its own fly keys
            new(3, InputAction.PathEditMode, true, null),
            new(3, InputAction.PathSetKey, true, null),
            new(3, InputAction.PathMoveForward, true, null),
            new(3, InputAction.PathMoveBack, true, null),
            new(3, InputAction.PathMoveLeft, true, null),
            new(3, InputAction.PathMoveRight, true, null),
            new(3, InputAction.PathFlyUp, true, null),
            new(3, InputAction.PathFlyDown, true, null),
            new(3, InputAction.PathFlyFast, true, null),
            new(3, InputAction.PathUndo, true, null)
        };

        /// <summary>The changes made after a version the user saw (empty when it is current or newer).</summary>
        public static List<DefaultsChange> ChangesSince(int seenVersion)
        {
            var changes = new List<DefaultsChange>();
            foreach (DefaultsChange change in DefaultsChanges)
            {
                if (change.Version > seenVersion) { changes.Add(change); }
            }
            return changes;
        }

        #endregion

        // a and b can fire in the same situation (built once)
        private static readonly bool[,] TOGETHER = BuildTogether();

        private static bool[,] BuildTogether()
        {
            int n = BY_ACTION.Length;
            var together = new bool[n, n];
            var members = new List<int>(n);
            foreach (InputSituation situation in Situations)
            {
                members.Clear();
                for (int a = 1; a < n; a++)
                {
                    if (BY_ACTION[a] != null && situation.Contains((InputAction)a)) { members.Add(a); }
                }
                foreach (int a in members)
                {
                    foreach (int b in members) { together[a, b] = true; }
                }
            }
            return together;
        }

        /// <summary>True when the two actions can fire in the same situation (an action is always live with itself).</summary>
        public static bool LiveTogether(InputAction a, InputAction b)
        {
            int ia = (int)a, ib = (int)b;
            if (ia <= 0 || ib <= 0 || ia >= BY_ACTION.Length || ib >= BY_ACTION.Length) { return false; }
            return ia == ib || TOGETHER[ia, ib];
        }

        #endregion
    }
}
