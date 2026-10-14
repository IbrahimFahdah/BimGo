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
        SectionBox, SectionPlane, SectionClear, ClashMode,

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
        ClashSelectAll,

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
        internal InputSituation(string name, InputContext[] contexts, InputAction[] extra)
        {
            Name = name;
            Contexts = contexts;
            Extra = extra;
        }

        /// <summary>Name for clash messages.</summary>
        public string Name { get; }

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
    /// The catalogue of actions and their default keys (input round B2): the single source for the action map, the
    /// CONTROLS panel, F1 help, README §3 and the default-clash tests. The defaults reproduce the keys BimGo had before
    /// B2 exactly; the hotkey review picks new ones here.
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
            Add(InputAction.Unarmed, c, "Unarmed: no gun (again, or a gun key, arms)", P, "0");
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
            InputContext.Tour, InputContext.Clashes, InputContext.Fixed
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
            InputContext.Tour => "Bookmark tour",
            InputContext.Clashes => "Clash mode",
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
            InputContext.Tour => "While a bookmark tour plays (Esc stops it).",
            InputContext.Clashes => "Clash detection's docked list (the clash mode key or Esc leaves): the move keys fly, run speeds up, RMB-drag looks, the wheel scrolls the list.",
            InputContext.Fixed => "Text boxes also keep Enter, Tab, Backspace, ↑ / ↓, Ctrl+V and Esc. Gamepad in menus and editors: the look stick moves the cursor, the move stick scrolls (menus) or looks (editors).",
            _ => null
        };

        #endregion

        #region Situations

        /// <summary>
        /// Every state of the app and what can fire in it. Mirrors <c>GameSession.UpdateFrame</c>: change both together.
        /// </summary>
        public static readonly InputSituation[] Situations = BuildSituations();

        private static InputSituation[] BuildSituations()
        {
            InputContext[] walking = { InputContext.General, InputContext.Movement, InputContext.Guns, InputContext.Tools };
            InputContext[] With(InputContext gun) => walking.Append(gun).ToArray();
            InputAction[] sunTime = { InputAction.SunEarlier, InputAction.SunEarlierFine, InputAction.SunLater, InputAction.SunLaterFine };
            InputAction[] Join(InputAction[] a, params InputAction[] b) => a.Concat(b).ToArray();
            InputAction[] padMenu = { InputAction.PadClick, InputAction.PadMenuBack };

            return new[]
            {
                new InputSituation("Walking", walking, Array.Empty<InputAction>()),
                new InputSituation("Walking with the Scan gun", With(InputContext.ScanGun), Array.Empty<InputAction>()),
                new InputSituation("Walking with the Measure gun", With(InputContext.MeasureGun), Array.Empty<InputAction>()),
                new InputSituation("Walking with the Comment gun", With(InputContext.CommentGun), Array.Empty<InputAction>()),
                new InputSituation("Walking with the Demolish gun", With(InputContext.DemolishGun), Array.Empty<InputAction>()),
                new InputSituation("Walking with the Gizmo, Clone or Place gun", With(InputContext.GizmoGuns), Array.Empty<InputAction>()),
                new InputSituation("Holding an element", new[] { InputContext.Holding, InputContext.GizmoGuns }, new[]
                {
                    InputAction.MoveForward, InputAction.MoveBack, InputAction.MoveLeft, InputAction.MoveRight,
                    InputAction.Minimap, InputAction.HideUi, InputAction.Help, InputAction.Fullscreen, InputAction.Screenshot,
                    InputAction.GunPrimary, InputAction.GunSecondary, InputAction.LookUp, InputAction.LookDown, InputAction.LookLeft, InputAction.LookRight
                }),
                new InputSituation("Markup editor", new[] { InputContext.Markup }, Join(padMenu, InputAction.Fullscreen, InputAction.Click)),
                new InputSituation("Section box editor", new[] { InputContext.SectionEditor }, Join(padMenu,
                    InputAction.SectionBox, InputAction.SectionClear, InputAction.Fullscreen, InputAction.Screenshot, InputAction.Click, InputAction.DragLook)),
                new InputSituation("Photo mode", new[] { InputContext.PhotoMode },
                    Join(sunTime, InputAction.PhotoMode, InputAction.Fullscreen, InputAction.Click, InputAction.DragLook, InputAction.PadClick, InputAction.PadMenuBack)),
                new InputSituation("Sun panel", new[] { InputContext.SunPanel },
                    Join(sunTime, InputAction.Shadows, InputAction.SunPanel, InputAction.Fullscreen, InputAction.Click, InputAction.FineAdjust, InputAction.PadClick, InputAction.PadMenuBack)),
                new InputSituation("Sun / daylight study", Array.Empty<InputContext>(), Join(padMenu,
                    InputAction.SunStudy, InputAction.Fullscreen, InputAction.Screenshot, InputAction.Click, InputAction.DragLook, InputAction.FineAdjust)),
                new InputSituation("Bookmark tour", new[] { InputContext.Tour }, new[] { InputAction.Fullscreen }),
                new InputSituation("Clash mode", new[] { InputContext.Clashes }, Join(padMenu,
                    InputAction.MoveForward, InputAction.MoveBack, InputAction.MoveLeft, InputAction.MoveRight, InputAction.Run,
                    InputAction.ClashMode, InputAction.Help, InputAction.HideUi, InputAction.Fullscreen, InputAction.Screenshot,
                    InputAction.Click, InputAction.DragLook)),
                new InputSituation("Recording a video", Array.Empty<InputContext>(), new[] { InputAction.Fullscreen }),
                new InputSituation("Start screen", Array.Empty<InputContext>(), Join(padMenu, InputAction.OpenFile, InputAction.Click)),
                new InputSituation("Pause menu and panels", Array.Empty<InputContext>(), Join(padMenu,
                    InputAction.Help, InputAction.Fullscreen, InputAction.Screenshot, InputAction.Refresh, InputAction.Save, InputAction.SaveAs,
                    InputAction.Undo, InputAction.Redo, InputAction.Click))
            };
        }

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
