using BimGo.Rendering;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// HUD colours, matching the BimGo HUD mockup.
    /// </summary>
    internal static class UiTheme
    {
        public static readonly uint PANEL = Rgba.Hex(0x0C0E12, 0.74f);
        public static readonly uint PANEL_STRONG = Rgba.Hex(0x0C0E12, 0.88f);
        public static readonly uint PANEL_BORDER = Rgba.Hex(0xFFFFFF, 0.12f);
        public static readonly uint TEXT = Rgba.Hex(0xF4F5F7);
        public static readonly uint TEXT_SOFT = Rgba.Hex(0xC9CDD3);
        public static readonly uint TEXT_MUTED = Rgba.Hex(0xA1A7B0);
        public static readonly uint TEXT_FAINT = Rgba.Hex(0x8A919B);
        public static readonly uint ACCENT = Rgba.Hex(0x22D3EE);
        public static readonly uint GOOD = Rgba.Hex(0x86EFAC);
        public static readonly uint DANGER = Rgba.Hex(0xFCA5A5);

        public static readonly uint SCAN = Rgba.Hex(0x22D3EE);
        public static readonly uint SCAN_LABEL = Rgba.Hex(0x67E8F9);
        public static readonly uint SCAN_TAG_TEXT = Rgba.Hex(0x06232A);

        public static readonly uint MEASURE = Rgba.Hex(0xFBBF24);
        public static readonly uint MEASURE_LABEL = Rgba.Hex(0xFCD34D);
        public static readonly uint MEASURE_TEXT = Rgba.Hex(0xFDE68A);

        public static readonly uint PORTAL_BLUE = Rgba.Hex(0x3B82F6);
        public static readonly uint PORTAL_BLUE_LIGHT = Rgba.Hex(0x60A5FA);
        public static readonly uint PORTAL_BLUE_DARK = Rgba.Hex(0x1E3A8A);
        public static readonly uint PORTAL_RED = Rgba.Hex(0xEF4444);
        public static readonly uint PORTAL_RED_LIGHT = Rgba.Hex(0xF87171);
        public static readonly uint PORTAL_RED_DARK = Rgba.Hex(0x7F1D1D);
        public static readonly uint PORTAL_LABEL = Rgba.Hex(0x93C5FD);

        public static readonly uint COMMENT = Rgba.Hex(0xA78BFA);
        public static readonly uint COMMENT_LABEL = Rgba.Hex(0xC4B5FD);

        /// <summary>Comment status colours: open (the comment colour), in progress (amber), closed (green).</summary>
        public static readonly uint STATUS_OPEN = Rgba.Hex(0xA78BFA);
        public static readonly uint STATUS_PROGRESS = Rgba.Hex(0xFBBF24);
        public static readonly uint STATUS_CLOSED = Rgba.Hex(0x4ADE80);

        /// <summary>The colour of a comment status.</summary>
        public static uint StatusColour(string status) => status switch
        {
            Format.CommentStatus.IN_PROGRESS => STATUS_PROGRESS,
            Format.CommentStatus.CLOSED => STATUS_CLOSED,
            _ => STATUS_OPEN
        };

        public static readonly uint SUN = Rgba.Hex(0xFBBF24);
        public static readonly uint SUN_LABEL = Rgba.Hex(0xFDE68A);

        public static readonly uint BOOKMARK = Rgba.Hex(0x38BDF8);
        public static readonly uint BOOKMARK_LABEL = Rgba.Hex(0x7DD3FC);

        public static readonly uint COORDS = Rgba.Hex(0xE5E7EB);

        public static readonly uint TELEPORT = Rgba.Hex(0x34D399);
        public static readonly uint TELEPORT_LABEL = Rgba.Hex(0x6EE7B7);
        public static readonly uint TELEPORT_BLOCKED = Rgba.Hex(0xF87171);

        public static readonly uint HAMMER = Rgba.Hex(0xFB923C);
        public static readonly uint HAMMER_LABEL = Rgba.Hex(0xFDBA74);
        public static readonly uint HAMMER_PRIMED = Rgba.Hex(0xEF4444);

        public static readonly uint GIZMO = Rgba.Hex(0xF472B6);
        public static readonly uint GIZMO_LABEL = Rgba.Hex(0xF9A8D4);

        public static readonly uint CLONE = Rgba.Hex(0xA3E635);
        public static readonly uint CLONE_LABEL = Rgba.Hex(0xBEF264);

        public static readonly uint PLACE = Rgba.Hex(0xFBBF24);
        public static readonly uint PLACE_LABEL = Rgba.Hex(0xFCD34D);

        public static readonly uint AXIS_X = Rgba.Hex(0xF87171);
        public static readonly uint AXIS_Y = Rgba.Hex(0x4ADE80);
        public static readonly uint AXIS_Z = Rgba.Hex(0x60A5FA);

        public static readonly uint MAP_BACKGROUND = Rgba.Hex(0x14171C);
        public static readonly uint MENU_BACKGROUND = Rgba.Hex(0x101318, 0.94f);
        public static readonly uint CARD = Rgba.Hex(0x181C22);
        public static readonly uint CARD_BORDER = Rgba.Hex(0xFFFFFF, 0.08f);
        public static readonly uint CONTROL = Rgba.Hex(0x0F1216);
        public static readonly uint CONTROL_BORDER = Rgba.Hex(0xFFFFFF, 0.2f);

        /// <summary>Keyboard / gamepad focus ring and a focused row's tint (polish round P-A).</summary>
        public static readonly uint FOCUS = Rgba.Hex(0x67E8F9);
        public static readonly uint HOVER = Rgba.Hex(0xFFFFFF, 0.08f);
        public static readonly uint ROW_STRIPE = Rgba.Hex(0xFFFFFF, 0.03f);
        public static readonly uint SCROLL_TRACK = Rgba.Hex(0xFFFFFF, 0.05f);
        public static readonly uint SCROLL_THUMB = Rgba.Hex(0xFFFFFF, 0.28f);
        public static readonly uint SCROLL_THUMB_HOT = Rgba.Hex(0x67E8F9, 0.7f);
        public static readonly uint DIVIDER = Rgba.Hex(0xFFFFFF, 0.1f);

        // ---- Spacing tokens (polish round P-A1): unscaled pixels, scaled by GameSession.S. The panel shell and its
        // widgets read these instead of per-panel numbers.

        /// <summary>Panel card widths: standard, wide (two panes or a grid), side (the model shows on the left).</summary>
        public const float PANEL_WIDTH = 1000f, PANEL_WIDTH_WIDE = 1180f, PANEL_WIDTH_SIDE = 780f;

        /// <summary>Space between the window edge and a panel card (small windows, then from 900 px high).</summary>
        public const float PANEL_MARGIN = 16f, PANEL_MARGIN_LARGE = 40f;

        /// <summary>A card's inner padding: left / right, and top / bottom.</summary>
        public const float PANEL_PAD = 24f, PANEL_PAD_Y = 16f;

        /// <summary>The header: title and sub-line (the divider sits at its foot).</summary>
        public const float HEADER_HEIGHT = 56f;

        /// <summary>The footer's button height, and the notice / hint strip above it.</summary>
        public const float FOOTER_HEIGHT = 40f, NOTICE_HEIGHT = 24f;

        /// <summary>Footer slot widths: BACK and CLOSE, and the bounds of a centre action.</summary>
        public const float FOOTER_SIDE_WIDTH = 132f, FOOTER_ACTION_MIN = 96f, FOOTER_ACTION_MAX = 230f;

        /// <summary>Standard gaps.</summary>
        public const float GAP = 12f, GAP_SMALL = 8f, GAP_LARGE = 20f;

        /// <summary>Row heights: a list row, a compact row (settings, checkboxes).</summary>
        public const float ROW_HEIGHT = 44f, ROW_COMPACT = 28f;

        /// <summary>Control heights: buttons, small buttons, inputs / segmented / dropdowns.</summary>
        public const float BUTTON_HEIGHT = 40f, SMALL_BUTTON_HEIGHT = 30f, CONTROL_HEIGHT = 32f;

        /// <summary>A label column beside a control (forms).</summary>
        public const float LABEL_WIDTH = 140f;

        /// <summary>A scroll region's bar, the gutter kept for it, and one wheel notch.</summary>
        public const float SCROLLBAR_WIDTH = 6f, SCROLL_GUTTER = 14f, WHEEL_STEP = 72f;

        /// <summary>The cursor-mode docks (sun, study, section, grids, clash dock): width and header height (P-A2).</summary>
        public const float DOCK_WIDTH = 340f, DOCK_HEADER_HEIGHT = 34f;

        /// <summary>The wider dock (the sun and daylight study).</summary>
        public const float DOCK_WIDTH_WIDE = 380f;

        /// <summary>A dock's inner padding: left / right, and top / bottom.</summary>
        public const float DOCK_PAD = 16f, DOCK_PAD_Y = 10f;

        /// <summary>A dock's footer buttons, and its notice strip (two small lines) above them.</summary>
        public const float DOCK_FOOTER_HEIGHT = 30f, DOCK_NOTICE_HEIGHT = 32f;

        /// <summary>
        /// The right-hand column's edge margin and the gap under the minimap. A window whose column under the minimap is
        /// shorter than <see cref="DOCK_MIN_HEIGHT"/> puts the dock at the top instead (the minimap hides while it's open).
        /// </summary>
        public const float COLUMN_MARGIN = 20f, COLUMN_GAP = 12f, DOCK_MIN_HEIGHT = 320f;

        /// <summary>The minimap's size (the right column's top), and the sun icon's (the column's foot).</summary>
        public const float MINIMAP_WIDTH = 220f, MINIMAP_HEIGHT = 208f, SUN_ICON_SIZE = 52f;

        /// <summary>The left column's panels: status and coordinates (their heights), and its width.</summary>
        public const float STATUS_HEIGHT = 146f, COORDS_HEIGHT = 100f, INFO_WIDTH = 250f;

        /// <summary>A legend collapsed to its title row (the F1 sheet is open, or the column ran out of room).</summary>
        public const float LEGEND_COLLAPSED_HEIGHT = 30f;
    }
}
