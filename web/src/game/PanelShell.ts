import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import type { InputState } from '../platform/input';
import type { GameSession } from './GameSession';

/** A panel card's width class. */
export enum PanelSize { Standard, Wide, Side }

/** How a shell button looks. */
export enum ShellStyle { Normal, Primary, Danger }

/** The open panel's layout this frame (from beginPanel). */
export interface PanelFrame {
  x: number; y: number; w: number; h: number;
  /** The inner left and width (inside the padding). */
  ix: number; iw: number;
  /** The body: under the header, above the notice strip. */
  bodyTop: number; bodyBottom: number;
  noticeY: number; footerY: number;
  /** The header controls' top and height; headerRight moves left as controls are added. */
  headerControlY: number; headerControlH: number; headerRight: number;
}

/** The open dock's layout this frame (from beginDock). */
export interface DockFrame {
  x: number; y: number; w: number; h: number;
  ix: number; iw: number;
  bodyTop: number; bodyBottom: number;
  noticeY: number; footerY: number;
  headerControlY: number; headerControlH: number; headerRight: number;
  notice: boolean;
}

/** Footer results: nothing pressed, or the panel was left (BACK / CLOSE: return at once). */
export const FOOTER_NONE = -1;
export const FOOTER_LEFT = -2;

/** endDock's results: nothing, CLOSE, ← BACK. */
export const DOCK_NONE = 0;
export const DOCK_CLOSE = 1;
export const DOCK_BACK = 2;

/**
 * One clipped, pixel-scrolled region (a list or a form; port of ScrollRegion). The content height is measured as it is
 * drawn and used from the next frame.
 */
export class ScrollRegion {
  offset = 0;
  target = 0;
  content = 0;
  x = 0;
  y = 0;
  w = 0;
  h = 0;
  /** The content's top this frame (scrolled). */
  top = 0;
  pinEnd = false;

  get maxScroll(): number { return Math.max(0, this.content - this.h); }

  reset(): void {
    this.offset = this.target = 0;
    this.pinEnd = false;
  }

  scrollToEnd(): void { this.pinEnd = true; }

  /** Scrolls the least needed to show a span of the content (content coordinates: 0 = the content's top). */
  reveal(top: number, bottom: number): void {
    if (top < this.target) { this.target = top; } else if (bottom > this.target + this.h) { this.target = bottom - this.h; }
  }

  /** True when a span (scrolled coordinates) shows in the viewport. */
  inView(y: number, h: number): boolean { return y + h > this.y && y < this.y + this.h; }

  /** The rows of a fixed-height list that show in the viewport: [first, last). */
  visibleRows(rowH: number, count: number): [number, number] {
    if (rowH <= 0 || count <= 0) { return [0, 0]; }
    const first = Math.min(Math.max(Math.floor((this.y - this.top) / rowH), 0), count);
    const last = Math.min(Math.max(Math.ceil((this.y + this.h - this.top) / rowH), first), count);
    return [first, last];
  }
}

interface FooterItem { label: string; style: ShellStyle; enabled: boolean }

/**
 * Polish round P-A1 / P-A2: the shared shell of the big panels (a card sized to the window, a header, a body with
 * clipped scroll regions, a footer in fixed slots: ← BACK · actions · CLOSE, a notice strip) and of the docks (compact
 * panels in the right-hand column that size to their content and scroll when the column is short). Port of
 * GameSession.PanelShell.cs.
 */
export class PanelShell {
  private readonly footerItems: FooterItem[] = [];
  private scrollDrag: ScrollRegion | null = null;
  private scrollDragGrab = 0;
  /** A dock sat over the minimap this frame (a short window): the minimap hides next frame. */
  dockOverMapNext = false;
  dockOverMap = false;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  /** Start of a window frame: last frame's dock-over-map flag takes effect. */
  beginFrame(): void {
    this.dockOverMap = this.dockOverMapNext;
    this.dockOverMapNext = false;
  }

  hover(input: InputState, x: number, y: number, w: number, h: number): boolean {
    return input.mouseX >= x && input.mouseX < x + w && input.mouseY >= y && input.mouseY < y + h && this.session.ui.clipContains(input.mouseX, input.mouseY);
  }

  // #region Panels

  /** Draws the backdrop, the card and the header, and lays out the body and footer (call endPanel after the body). */
  beginPanel(size: PanelSize, title: string, titleColour: number, subLine: string, headerControls = 0): PanelFrame {
    const ui = this.session.ui, f = ui.atlas;
    const width = this.session.screenWidth, height = this.session.screenHeight;
    this.footerItems.length = 0;
    const margin = height >= this.s(900) ? this.s(UiTheme.PANEL_MARGIN_LARGE) : this.s(UiTheme.PANEL_MARGIN);
    const wanted = this.s(size === PanelSize.Wide ? UiTheme.PANEL_WIDTH_WIDE : size === PanelSize.Side ? UiTheme.PANEL_WIDTH_SIDE : UiTheme.PANEL_WIDTH);
    const w = Math.min(wanted, width - margin * 2);
    const h = height - margin * 2;
    const x = size === PanelSize.Side ? width - w - margin : Math.round((width - w) * 0.5);
    const y = margin;
    if (size === PanelSize.Side) {
      ui.rect(0, 0, width, height, Rgba.hex(0x101318, 0.25));
      ui.panel(x, y, w, h, Rgba.hex(0x181c22, 0.97), UiTheme.CARD_BORDER);
    } else {
      ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);
      ui.panel(x, y, w, h, UiTheme.CARD, UiTheme.CARD_BORDER);
    }
    const frame: PanelFrame = {
      x, y, w, h, ix: x + this.s(UiTheme.PANEL_PAD), iw: w - this.s(UiTheme.PANEL_PAD) * 2,
      bodyTop: 0, bodyBottom: 0, noticeY: 0, footerY: 0, headerControlY: 0, headerControlH: this.s(UiTheme.CONTROL_HEIGHT), headerRight: 0
    };
    frame.headerControlY = y + Math.round((this.s(UiTheme.HEADER_HEIGHT) - frame.headerControlH) * 0.5);
    frame.headerRight = frame.ix + frame.iw;
    frame.footerY = y + h - this.s(UiTheme.PANEL_PAD_Y) - this.s(UiTheme.FOOTER_HEIGHT);
    frame.noticeY = frame.footerY - this.s(UiTheme.GAP_SMALL) - this.s(UiTheme.NOTICE_HEIGHT);
    frame.bodyTop = y + this.s(UiTheme.HEADER_HEIGHT) + this.s(UiTheme.GAP);
    frame.bodyBottom = frame.noticeY - this.s(UiTheme.GAP_SMALL);
    const textW = frame.iw - headerControls - (headerControls > 0 ? this.s(UiTheme.GAP) : 0);
    ui.text(f.small, frame.ix, y + this.s(UiTheme.PANEL_PAD_Y), title, titleColour, this.s(2));
    if (subLine) { ui.textWrapped(f.small, frame.ix, y + this.s(UiTheme.PANEL_PAD_Y) + this.s(18), Math.max(textW, this.s(40)), subLine, UiTheme.TEXT_MUTED, 1); }
    ui.rect(x + this.s(1), y + this.s(UiTheme.HEADER_HEIGHT), w - this.s(2), Math.max(1, ui.scale), UiTheme.DIVIDER);
    return frame;
  }

  /** A header control slot of this width, from the right; returns its left. */
  takeHeaderSlot(frame: PanelFrame | DockFrame, width: number, gap: number): number {
    frame.headerRight -= width;
    const left = frame.headerRight;
    frame.headerRight -= gap;
    return left;
  }

  /** A button in the header's right-hand controls (right to left). */
  headerButton(frame: PanelFrame, label: string, style = ShellStyle.Normal, enabled = true, width = 0): boolean {
    const f = this.session.ui.atlas;
    const w = width > 0 ? width : this.buttonWidth(f, label);
    const x = this.takeHeaderSlot(frame, w, this.s(UiTheme.GAP_SMALL));
    return this.button(f, this.session.input, x, frame.headerControlY, w, frame.headerControlH, label, style, enabled);
  }

  /** Queues a footer action (endPanel returns its index when pressed). */
  footerAction(label: string, style = ShellStyle.Normal, enabled = true): number {
    this.footerItems.push({ label, style, enabled });
    return this.footerItems.length - 1;
  }

  /**
   * Draws the notice strip, the footer (← BACK · the queued actions · CLOSE) and handles BACK and CLOSE.
   * @returns The action pressed, FOOTER_NONE, or FOOTER_LEFT when BACK / CLOSE left the panel.
   */
  endPanel(frame: PanelFrame, notice: string | null, hint: string | null, backLabel: string | null = null): number {
    const session = this.session, ui = session.ui, f = ui.atlas, input = session.input;
    const stripY = frame.noticeY + (this.s(UiTheme.NOTICE_HEIGHT) - f.body.lineHeight) * 0.5;
    if (notice) { ui.textWrapped(f.body, frame.ix, stripY, frame.iw, notice, UiTheme.MEASURE_TEXT, 1); }
    else if (hint) { ui.textWrapped(f.small, frame.ix, stripY + this.s(2), frame.iw, hint, UiTheme.TEXT_FAINT, 1); }
    ui.rect(frame.x + this.s(1), frame.noticeY - this.s(UiTheme.GAP_SMALL) * 0.5, frame.w - this.s(2), Math.max(1, ui.scale), UiTheme.DIVIDER);
    const y = frame.footerY, h = this.s(UiTheme.FOOTER_HEIGHT);
    const side = Math.min(this.s(UiTheme.FOOTER_SIDE_WIDTH), frame.iw * 0.2);
    const back = this.button(f, input, frame.ix, y, side, h, backLabel ?? '← BACK', ShellStyle.Normal, true);
    const close = this.button(f, input, frame.ix + frame.iw - side, y, side, h, 'CLOSE', ShellStyle.Normal, true);
    let pressed = FOOTER_NONE;
    const count = this.footerItems.length;
    if (count > 0) {
      const gap = this.s(UiTheme.GAP);
      const left = frame.ix + side + gap * 2, right = frame.ix + frame.iw - side - gap * 2;
      const room = right - left - gap * (count - 1);
      const total = this.footerItems.reduce((sum, item) => sum + this.buttonWidth(f, item.label), 0);
      const squeeze = total > room && total > 0 ? room / total : 1;
      const used = total * squeeze + gap * (count - 1);
      let bx = Math.round(left + Math.max(0, (right - left - used) * 0.5));
      this.footerItems.forEach((item, i) => {
        const bw = Math.floor(this.buttonWidth(f, item.label) * squeeze);
        if (this.button(f, input, bx, y, bw, h, item.label, item.style, item.enabled)) { pressed = i; }
        bx += bw + gap;
      });
    }
    this.footerItems.length = 0;
    if (back) { session.panelBack(); return FOOTER_LEFT; }
    if (close) { session.closePanelToGame(); return FOOTER_LEFT; }
    return pressed;
  }

  // #endregion

  // #region Docks

  /**
   * The right-hand column for a dock of this width (under the minimap when it shows, down to just above the sun icon; a
   * window too short puts the dock at the top over the minimap, which hides). Clash mode: left of the clash dock.
   */
  dockColumn(width: number): { x: number; top: number; bottom: number } {
    const session = this.session;
    const screenW = session.screenWidth, screenH = session.screenHeight;
    if (session.clashModeOn) {
      const dockX = session.clashes.dockLeft;
      let x = dockX > 0 ? dockX - this.s(UiTheme.COLUMN_GAP) - width : screenW - this.s(16) - width;
      x = Math.max(this.s(10), x);
      return { x, top: this.s(16), bottom: screenH - this.s(16) };
    }
    const margin = this.s(UiTheme.COLUMN_MARGIN);
    const x = screenW - margin - width;
    let top = margin;
    let bottom = screenH - margin - this.s(UiTheme.SUN_ICON_SIZE) - this.s(10);
    if (session.showMap) {
      const under = margin + this.s(UiTheme.MINIMAP_HEIGHT) + this.s(UiTheme.COLUMN_GAP);
      if (bottom - under >= this.s(UiTheme.DOCK_MIN_HEIGHT)) { top = under; } else { this.dockOverMapNext = true; }
    }
    bottom = Math.max(bottom, top + this.s(120));
    return { x, top, bottom };
  }

  /**
   * Draws a dock and its header and lays out the body and footer. The dock is as tall as its content (last frame's)
   * and the column allows; draw the body between beginDockBody and endDockBody, then call endDock.
   */
  beginDock(title: string, titleColour: number, border: number, width: number, body: ScrollRegion | null, notice: boolean, fullHeight = false): DockFrame {
    const ui = this.session.ui, f = ui.atlas;
    const { x, top, bottom } = this.dockColumn(width);
    const padY = this.s(UiTheme.DOCK_PAD_Y), gap = this.s(UiTheme.GAP_SMALL);
    const header = this.s(UiTheme.DOCK_HEADER_HEIGHT), footer = this.s(UiTheme.DOCK_FOOTER_HEIGHT);
    const noticeH = notice ? this.s(UiTheme.DOCK_NOTICE_HEIGHT) + gap : 0;
    const chrome = header + gap * 2 + noticeH + footer + padY;
    const room = bottom - top;
    const content = !fullHeight && body && body.content > 0 ? body.content : room;
    const h = Math.round(Math.min(room, chrome + content));
    ui.panel(x, top, width, h, UiTheme.PANEL_STRONG, border);
    const d: DockFrame = {
      x, y: top, w: width, h, ix: x + this.s(UiTheme.DOCK_PAD), iw: width - this.s(UiTheme.DOCK_PAD) * 2, bodyTop: 0, bodyBottom: 0, noticeY: 0,
      footerY: 0, headerControlY: 0, headerControlH: this.s(22), headerRight: 0, notice
    };
    d.headerControlY = top + Math.round((header - d.headerControlH) * 0.5);
    d.headerRight = d.ix + d.iw;
    d.footerY = top + h - padY - footer;
    d.noticeY = d.footerY - gap - this.s(UiTheme.DOCK_NOTICE_HEIGHT);
    d.bodyTop = top + header + gap;
    d.bodyBottom = Math.max(d.bodyTop + this.s(20), (notice ? d.noticeY : d.footerY) - gap);
    ui.text(f.small, d.ix, top + Math.round((header - f.small.lineHeight) * 0.5), title, titleColour, this.s(1.6));
    ui.rect(x + this.s(1), top + header, width - this.s(2), Math.max(1, ui.scale), UiTheme.DIVIDER);
    return d;
  }

  /** A small button in the dock's header (right to left). */
  dockHeaderButton(d: DockFrame, label: string, width: number): boolean {
    d.headerRight -= width;
    const x = d.headerRight;
    d.headerRight -= this.s(UiTheme.GAP_SMALL);
    return this.session.menu.widgets.smallButton(this.session.ui.atlas, x, d.headerControlY, width, d.headerControlH, label);
  }

  /** Starts the dock's body (a clipped scroll region; the wheel is left to a dragged slider); returns its first line. */
  beginDockBody(d: DockFrame, body: ScrollRegion, input: InputState, wheel = true): number {
    const top = this.beginScroll(body, input, d.x + this.s(6), d.bodyTop, d.w - this.s(8), d.bodyBottom - d.bodyTop, wheel);
    return top + this.s(2);
  }

  /** Ends the dock's body at the content's bottom (measured for the next frame's height). */
  endDockBody(body: ScrollRegion, input: InputState, contentBottom: number): void {
    this.endScroll(body, input, contentBottom + this.s(4));
  }

  /** Draws the notice strip (when kept), a divider and the footer: ← BACK (when given), the hint, CLOSE. */
  endDock(d: DockFrame, notice: string | null, hint: string | null, backLabel: string | null = null, closeLabel = 'CLOSE'): number {
    const session = this.session, ui = session.ui, f = ui.atlas, input = session.input;
    const gap = this.s(UiTheme.GAP_SMALL);
    ui.rect(d.x + this.s(1), d.bodyBottom + gap * 0.5, d.w - this.s(2), Math.max(1, ui.scale), UiTheme.DIVIDER);
    if (d.notice && notice) { ui.textWrapped(f.small, d.ix, d.noticeY + this.s(2), d.iw, notice, UiTheme.MEASURE_TEXT, 2); }
    const y = d.footerY, h = this.s(UiTheme.DOCK_FOOTER_HEIGHT);
    const closeW = Math.max(this.s(84), UiBatch.measure(f.bold, closeLabel, this.s(1)) + this.s(28));
    let left = d.ix;
    let back = false;
    if (backLabel !== null) {
      const backW = Math.max(this.s(84), UiBatch.measure(f.bold, backLabel, this.s(1)) + this.s(28));
      back = this.button(f, input, d.ix, y, backW, h, backLabel, ShellStyle.Normal, true);
      left += backW + gap;
    }
    const close = this.button(f, input, d.ix + d.iw - closeW, y, closeW, h, closeLabel, ShellStyle.Normal, true);
    const hintW = d.ix + d.iw - closeW - gap - left;
    if (hint && hintW > this.s(30)) { ui.textWrapped(f.small, left, y + Math.round((h - f.small.lineHeight) * 0.5), hintW, hint, UiTheme.TEXT_FAINT, 1); }
    return back ? DOCK_BACK : close ? DOCK_CLOSE : DOCK_NONE;
  }

  // #endregion

  // #region Widgets

  /** A shell button's natural width (its label plus padding, within the footer bounds). */
  buttonWidth(f: FontAtlas, label: string): number {
    return Math.min(Math.max(UiBatch.measure(f.bold, label, this.s(1)) + this.s(36), this.s(UiTheme.FOOTER_ACTION_MIN)), this.s(UiTheme.FOOTER_ACTION_MAX));
  }

  /** The shell's button: a centred label, outlined, or filled when primary; a disabled button never reports a press. */
  button(f: FontAtlas, input: InputState, x: number, y: number, w: number, h: number, label: string, style: ShellStyle, enabled: boolean): boolean {
    const ui = this.session.ui;
    const hover = enabled && this.hover(input, x, y, w, h);
    const alpha = enabled ? 1 : 0.4;
    let text: number;
    if (style === ShellStyle.Primary) {
      ui.rect(x, y, w, h, fade(hover ? UiTheme.FOCUS : UiTheme.ACCENT, alpha));
      text = Rgba.hex(0x06232a);
    } else {
      ui.rect(x, y, w, h, hover ? UiTheme.HOVER : UiTheme.CONTROL);
      const border = style === ShellStyle.Danger ? Rgba.hex(0xfca5a5, 0.45) : hover ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER;
      ui.outline(x, y, w, h, Math.max(1, ui.scale), fade(border, alpha));
      text = fade(style === ShellStyle.Danger ? UiTheme.DANGER : hover ? UiTheme.ACCENT : UiTheme.TEXT, alpha);
    }
    ui.pushClip(x + this.s(4), y, w - this.s(8), h);
    const labelW = UiBatch.measure(f.bold, label, this.s(1));
    const lx = labelW <= w - this.s(16) ? x + (w - labelW) * 0.5 : x + this.s(8);
    ui.text(f.bold, lx, y + h * 0.5 - f.bold.lineHeight * 0.5, label, text, this.s(1));
    ui.popClip();
    const clicked = hover && input.leftPressed;
    if (clicked) {
      input.consumeClicks();
      this.session.sound.play(SoundId.UiClick);
    }
    return clicked;
  }

  /** A section heading inside a panel body; returns the y below it. */
  sectionLabel(f: FontAtlas, x: number, y: number, text: string): number {
    this.session.ui.text(f.small, x, y, text, UiTheme.TEXT_MUTED, this.s(1.8));
    return y + this.s(24);
  }

  // #endregion

  // #region Scroll regions

  /**
   * Starts a clipped scroll region: the wheel scrolls it while the cursor is over it. Draw the content from the
   * returned top, then call endScroll with the content's bottom. The content keeps w − SCROLL_GUTTER.
   */
  beginScroll(region: ScrollRegion, input: InputState, x: number, y: number, w: number, h: number, wheel = true): number {
    region.x = x;
    region.y = y;
    region.w = w;
    region.h = Math.max(h, 1);
    const max = region.maxScroll;
    if (wheel && input.wheel !== 0 && this.hover(input, x, y, w, h)) {
      region.target -= input.wheel * this.s(UiTheme.WHEEL_STEP);
      region.pinEnd = false;
    }
    if (!region.pinEnd) { region.target = Math.min(Math.max(region.target, 0), max); }
    if (this.scrollDrag === region) {
      region.offset = region.target;
    } else {
      const k = 1 - Math.exp(-this.session.frameTime * 18);
      region.offset += (region.target - region.offset) * k;
      if (Math.abs(region.target - region.offset) < 0.5) { region.offset = region.target; }
    }
    region.offset = Math.min(Math.max(region.offset, 0), max);
    this.session.ui.pushClip(x, y, w, h);
    region.top = Math.round(y - region.offset);
    return region.top;
  }

  /** Ends a scroll region: records the content's height and draws and handles the scroll bar. */
  endScroll(region: ScrollRegion, input: InputState, contentBottom: number): void {
    const ui = this.session.ui;
    ui.popClip();
    region.content = Math.max(0, contentBottom - region.top);
    if (region.pinEnd) {
      region.pinEnd = false;
      region.target = region.maxScroll;
    }
    const max = region.maxScroll;
    if (!input.leftDown && this.scrollDrag === region) { this.scrollDrag = null; }
    if (max <= 0) {
      if (this.scrollDrag === region) { this.scrollDrag = null; }
      return;
    }
    const barW = this.s(UiTheme.SCROLLBAR_WIDTH);
    const trackX = region.x + region.w - barW - this.s(2), trackY = region.y + this.s(2), trackH = region.h - this.s(4);
    const thumbH = Math.max(this.s(28), trackH * region.h / Math.max(region.content, 1));
    let thumbY = trackY + (trackH - thumbH) * (region.offset / max);
    const overTrack = this.hover(input, trackX - this.s(5), trackY, barW + this.s(9), trackH);
    const overThumb = overTrack && input.mouseY >= thumbY && input.mouseY < thumbY + thumbH;
    if (overTrack && input.leftPressed) {
      input.consumeClicks();
      if (overThumb) {
        this.scrollDrag = region;
        this.scrollDragGrab = input.mouseY - thumbY;
      } else {
        region.target = Math.min(Math.max(region.target + (input.mouseY < thumbY ? -1 : 1) * region.h * 0.9, 0), max);
      }
    }
    if (this.scrollDrag === region && input.leftDown) {
      const t = trackH - thumbH > 0 ? (input.mouseY - this.scrollDragGrab - trackY) / (trackH - thumbH) : 0;
      region.target = region.offset = Math.min(Math.max(t, 0), 1) * max;
      thumbY = trackY + (trackH - thumbH) * (region.offset / max);
    }
    const hot = overThumb || this.scrollDrag === region;
    ui.rect(trackX, trackY, barW, trackH, UiTheme.SCROLL_TRACK);
    ui.rect(trackX, thumbY, barW, thumbH, hot ? UiTheme.SCROLL_THUMB_HOT : UiTheme.SCROLL_THUMB);
  }

  // #endregion
}

function fade(colour: number, factor: number): number {
  if (factor >= 1) { return colour; }
  const alpha = Math.min(Math.max(Math.trunc((colour >>> 24) * factor + 0.5), 0), 255);
  return ((colour & 0x00ffffff) | (alpha << 24)) >>> 0;
}
