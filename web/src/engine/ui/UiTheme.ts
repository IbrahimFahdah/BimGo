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

  /** Comment status colours: open (the comment colour), in progress (amber), closed (green). */
  STATUS_OPEN: Rgba.hex(0xa78bfa),
  STATUS_PROGRESS: Rgba.hex(0xfbbf24),
  STATUS_CLOSED: Rgba.hex(0x4ade80),

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

  PLACE: Rgba.hex(0xfbbf24),
  PLACE_LABEL: Rgba.hex(0xfcd34d),

  AXIS_X: Rgba.hex(0xf87171),
  AXIS_Y: Rgba.hex(0x4ade80),
  AXIS_Z: Rgba.hex(0x60a5fa),

  MAP_BACKGROUND: Rgba.hex(0x14171c),
  MENU_BACKGROUND: Rgba.hex(0x101318, 0.94),
  CARD: Rgba.hex(0x181c22),
  CARD_BORDER: Rgba.hex(0xffffff, 0.08),
  CONTROL: Rgba.hex(0x0f1216),
  CONTROL_BORDER: Rgba.hex(0xffffff, 0.2),

  /** Keyboard / gamepad focus ring and a focused row's tint (polish round P-A). */
  FOCUS: Rgba.hex(0x67e8f9),
  HOVER: Rgba.hex(0xffffff, 0.08),
  ROW_STRIPE: Rgba.hex(0xffffff, 0.03),
  SCROLL_TRACK: Rgba.hex(0xffffff, 0.05),
  SCROLL_THUMB: Rgba.hex(0xffffff, 0.28),
  SCROLL_THUMB_HOT: Rgba.hex(0x67e8f9, 0.7),
  DIVIDER: Rgba.hex(0xffffff, 0.1),

  // ---- Spacing tokens (polish round P-A1): unscaled pixels, scaled by session.s()

  /** Panel card widths: standard, wide (two panes or a grid), side (the model shows on the left). */
  PANEL_WIDTH: 1000, PANEL_WIDTH_WIDE: 1180, PANEL_WIDTH_SIDE: 780,
  /** Space between the window edge and a panel card (small windows, then from 900 px high). */
  PANEL_MARGIN: 16, PANEL_MARGIN_LARGE: 40,
  /** A card's inner padding: left / right, and top / bottom. */
  PANEL_PAD: 24, PANEL_PAD_Y: 16,
  /** The header: title and sub-line. */
  HEADER_HEIGHT: 56,
  /** The footer's button height, and the notice / hint strip above it. */
  FOOTER_HEIGHT: 40, NOTICE_HEIGHT: 24,
  /** Footer slot widths: BACK and CLOSE, and the bounds of a centre action. */
  FOOTER_SIDE_WIDTH: 132, FOOTER_ACTION_MIN: 96, FOOTER_ACTION_MAX: 230,
  /** Standard gaps. */
  GAP: 12, GAP_SMALL: 8, GAP_LARGE: 20,
  /** Row heights: a list row, a compact row. */
  ROW_HEIGHT: 44, ROW_COMPACT: 28,
  /** Control heights: buttons, small buttons, inputs / segmented / dropdowns. */
  BUTTON_HEIGHT: 40, SMALL_BUTTON_HEIGHT: 30, CONTROL_HEIGHT: 32,
  /** A label column beside a control (forms). */
  LABEL_WIDTH: 140,
  /** A scroll region's bar, the gutter kept for it, and one wheel notch. */
  SCROLLBAR_WIDTH: 6, SCROLL_GUTTER: 14, WHEEL_STEP: 72,
  /** The cursor-mode docks (sun, study, section, grids, clash dock): width and header height (P-A2). */
  DOCK_WIDTH: 340, DOCK_HEADER_HEIGHT: 34,
  /** The wider dock (the sun and daylight study). */
  DOCK_WIDTH_WIDE: 380,
  /** A dock's inner padding. */
  DOCK_PAD: 16, DOCK_PAD_Y: 10,
  /** A dock's footer buttons, and its notice strip above them. */
  DOCK_FOOTER_HEIGHT: 30, DOCK_NOTICE_HEIGHT: 32,
  /** The right-hand column's edge margin and the gap under the minimap; a shorter column puts the dock at the top. */
  COLUMN_MARGIN: 20, COLUMN_GAP: 12, DOCK_MIN_HEIGHT: 320,
  /** The minimap's size and the sun icon's. */
  MINIMAP_WIDTH: 220, MINIMAP_HEIGHT: 208, SUN_ICON_SIZE: 52,
  /** The left column's panels: status and coordinates (their heights), and its width. */
  STATUS_HEIGHT: 146, COORDS_HEIGHT: 100, INFO_WIDTH: 250,
  /** A legend collapsed to its title row. */
  LEGEND_COLLAPSED_HEIGHT: 30
} as const;

/** The colour of a comment status (port of UiTheme.StatusColour). */
export function statusColour(status: string): number {
  return status === 'inProgress' ? UiTheme.STATUS_PROGRESS : status === 'closed' ? UiTheme.STATUS_CLOSED : UiTheme.STATUS_OPEN;
}
