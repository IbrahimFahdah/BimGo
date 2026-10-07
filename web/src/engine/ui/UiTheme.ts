import { Rgba } from './Rgba';

/**
 * HUD colours, matching the BimGo HUD mockup (port of BimGo.App/Game/UiTheme.cs).
 */
export const UiTheme = {
  PANEL: Rgba.hex(0x0c0e12, 0.74),
  PANEL_STRONG: Rgba.hex(0x0c0e12, 0.88),
  PANEL_BORDER: Rgba.hex(0xffffff, 0.12),
  TEXT: Rgba.hex(0xf4f5f7),
  TEXT_SOFT: Rgba.hex(0xc9cdd3),
  TEXT_MUTED: Rgba.hex(0xa1a7b0),
  TEXT_FAINT: Rgba.hex(0x8a919b),
  ACCENT: Rgba.hex(0x22d3ee),
  GOOD: Rgba.hex(0x86efac),
  DANGER: Rgba.hex(0xfca5a5),

  SCAN: Rgba.hex(0x22d3ee),
  SCAN_LABEL: Rgba.hex(0x67e8f9),
  SCAN_TAG_TEXT: Rgba.hex(0x06232a),

  MEASURE: Rgba.hex(0xfbbf24),
  MEASURE_LABEL: Rgba.hex(0xfcd34d),
  MEASURE_TEXT: Rgba.hex(0xfde68a),

  PORTAL_BLUE: Rgba.hex(0x3b82f6),
  PORTAL_BLUE_LIGHT: Rgba.hex(0x60a5fa),
  PORTAL_BLUE_DARK: Rgba.hex(0x1e3a8a),
  PORTAL_RED: Rgba.hex(0xef4444),
  PORTAL_RED_LIGHT: Rgba.hex(0xf87171),
  PORTAL_RED_DARK: Rgba.hex(0x7f1d1d),
  PORTAL_LABEL: Rgba.hex(0x93c5fd),

  COMMENT: Rgba.hex(0xa78bfa),
  COMMENT_LABEL: Rgba.hex(0xc4b5fd),

  SUN: Rgba.hex(0xfbbf24),
  SUN_LABEL: Rgba.hex(0xfde68a),

  BOOKMARK: Rgba.hex(0x38bdf8),
  BOOKMARK_LABEL: Rgba.hex(0x7dd3fc),

  COORDS: Rgba.hex(0xe5e7eb),

  TELEPORT: Rgba.hex(0x34d399),
  TELEPORT_LABEL: Rgba.hex(0x6ee7b7),
  TELEPORT_BLOCKED: Rgba.hex(0xf87171),

  HAMMER: Rgba.hex(0xfb923c),
  HAMMER_LABEL: Rgba.hex(0xfdba74),
  HAMMER_PRIMED: Rgba.hex(0xef4444),

  GIZMO: Rgba.hex(0xf472b6),
  GIZMO_LABEL: Rgba.hex(0xf9a8d4),

  CLONE: Rgba.hex(0xa3e635),
  CLONE_LABEL: Rgba.hex(0xbef264),

  AXIS_X: Rgba.hex(0xf87171),
  AXIS_Y: Rgba.hex(0x4ade80),
  AXIS_Z: Rgba.hex(0x60a5fa),

  MAP_BACKGROUND: Rgba.hex(0x14171c),
  MENU_BACKGROUND: Rgba.hex(0x101318, 0.94),
  CARD: Rgba.hex(0x181c22),
  CARD_BORDER: Rgba.hex(0xffffff, 0.08),
  CONTROL: Rgba.hex(0x0f1216),
  CONTROL_BORDER: Rgba.hex(0xffffff, 0.2)
} as const;
