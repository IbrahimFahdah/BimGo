using RvtGo.Rendering;

// The class belongs to the Game namespace
namespace RvtGo.Game
{
    /// <summary>
    /// HUD colours, matching the RvtGo HUD mockup.
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

        public static readonly uint MAP_BACKGROUND = Rgba.Hex(0x14171C);
        public static readonly uint MENU_BACKGROUND = Rgba.Hex(0x101318, 0.94f);
        public static readonly uint CARD = Rgba.Hex(0x181C22);
        public static readonly uint CARD_BORDER = Rgba.Hex(0xFFFFFF, 0.08f);
        public static readonly uint CONTROL = Rgba.Hex(0x0F1216);
        public static readonly uint CONTROL_BORDER = Rgba.Hex(0xFFFFFF, 0.2f);
    }
}
