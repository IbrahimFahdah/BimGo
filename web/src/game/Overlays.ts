import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import type { InputState } from '../platform/input';
import type { GameSession } from './GameSession';

interface DropdownState {
  owner: object;
  slot: number;
  x: number;
  y: number;
  w: number;
  h: number;
  labels: string[];
  selected: number;
  scroll: number;
  fresh: boolean;
  pick: (index: number) => void;
}

interface ConfirmState {
  title: string;
  message: string;
  action: string;
  danger: boolean;
  offerSkip: boolean;
  skip: boolean;
  confirmed: (skip: boolean) => void;
  /** The tick's own label (null: "Don't ask again this session"), and an optional second action. */
  skipLabel: string | null;
  altAction: string | null;
  altConfirmed: ((skip: boolean) => void) | null;
}

const DROPDOWN_MAX_ROWS = 12;

/**
 * Small reusable overlays for the panels (port of GameSession.Overlays.cs, Round C): a dropdown (click → a list over
 * the panel, the wheel scrolls it, a click picks, Esc or a click outside closes) and an in-panel confirm (a question
 * with its action button, CANCEL, an optional tick and an optional second action). While one is open it is modal for
 * the panel that opened it: the panel calls {@link begin} before drawing (the overlay takes that frame's click and
 * wheel) and {@link draw} after (drawn on top, handling the click).
 */
export class Overlays {
  private dropdown: DropdownState | null = null;
  private confirm: ConfirmState | null = null;
  private click = false;
  private wheel = 0;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  /** True while a dropdown or a confirm is open. */
  get isOpen(): boolean { return this.dropdown !== null || this.confirm !== null; }

  /** True when this owner's dropdown (slot: which of its dropdowns) is open. */
  isDropdownOpen(owner: object, slot: number): boolean {
    return this.dropdown !== null && this.dropdown.owner === owner && this.dropdown.slot === slot;
  }

  /** Opens a dropdown under (or above) its button; pick(i) runs after the list closes. */
  openDropdown(owner: object, slot: number, x: number, y: number, w: number, h: number, labels: readonly string[], selected: number, pick: (index: number) => void): void {
    this.dropdown = { owner, slot, x, y, w, h, labels: labels.map(l => l ?? ''), selected, scroll: 0, fresh: true, pick };
    this.confirm = null;
  }

  /** Opens a confirm over the panel (confirmed(true) when "don't ask again" was ticked). */
  openConfirm(title: string, message: string, action: string, danger: boolean, offerSkip: boolean, confirmed: (skip: boolean) => void): void {
    this.confirm = { title, message, action, danger, offerSkip, skip: false, confirmed, skipLabel: null, altAction: null, altConfirmed: null };
    this.dropdown = null;
  }

  /** Opens a confirm with a second action and / or a tick of its own ("update them" / "new only", "replace … too"). */
  openChoice(title: string, message: string, action: string, danger: boolean, tickLabel: string | null, altAction: string | null,
    confirmed: (tick: boolean) => void, altConfirmed: ((tick: boolean) => void) | null): void {
    this.confirm = { title, message, action, danger, offerSkip: tickLabel !== null, skip: false, confirmed, skipLabel: tickLabel, altAction, altConfirmed };
    this.dropdown = null;
  }

  /** Esc: closes an open dropdown or confirm; false when none was open. */
  close(): boolean {
    if (!this.isOpen) { return false; }
    this.dropdown = null;
    this.confirm = null;
    return true;
  }

  /** Call before drawing a panel that can open overlays: an open overlay takes this frame's click and wheel. */
  begin(input: InputState): void {
    this.click = false;
    this.wheel = 0;

    // C-C1: a right-click closes an open list and goes through (a right-click menu may open on another row)
    if (this.dropdown && input.rightPressed) { this.dropdown = null; }
    if (!this.isOpen) { return; }
    this.click = input.leftPressed;
    this.wheel = input.wheel;
    input.consumeClicks();
    input.consumeWheel();
  }

  /** Call after drawing the panel (bounds: the panel's rectangle): draws the open overlay and handles its click. */
  draw(f: FontAtlas, input: InputState, bx: number, by: number, bw: number, bh: number): void {
    if (this.confirm) { this.drawConfirm(f, input, bx, by, bw, bh); }
    else if (this.dropdown) { this.drawDropdown(f, input, by, bh); }
    this.click = false;
    this.wheel = 0;
  }

  private hover(input: InputState, x: number, y: number, w: number, h: number): boolean {
    return input.mouseX >= x && input.mouseX < x + w && input.mouseY >= y && input.mouseY < y + h && this.session.ui.clipContains(input.mouseX, input.mouseY);
  }

  /** A dropdown's button: the current choice and a drawn chevron. True when clicked (open the list then). */
  button(f: FontAtlas, input: InputState, x: number, y: number, w: number, h: number, label: string, open: boolean): boolean {
    const ui = this.session.ui;
    const hover = this.hover(input, x, y, w, h);
    ui.rect(x, y, w, h, open ? Rgba.hex(0x22d3ee, 0.14) : hover ? Rgba.hex(0xffffff, 0.1) : UiTheme.CONTROL);
    ui.outline(x, y, w, h, Math.max(1, ui.scale), open ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
    const chevron = this.s(20);
    ui.textWrapped(f.small, x + this.s(8), y + h * 0.5 - f.small.lineHeight * 0.5, w - chevron - this.s(12), label ?? '', hover || open ? UiTheme.ACCENT : UiTheme.TEXT, 1);
    this.chevron(x + w - chevron * 0.5 - this.s(4), y + h * 0.5, this.s(4.5), open, hover || open ? UiTheme.ACCENT : UiTheme.TEXT_SOFT);
    const clicked = hover && input.leftPressed;
    if (clicked) {
      input.consumeClicks();
      this.session.sound.play(SoundId.UiClick);
    }
    return clicked;
  }

  /** A small down (or up) triangle centred on a point. */
  chevron(cx: number, cy: number, r: number, up: boolean, colour: number): void {
    const ui = this.session.ui;
    if (up) { ui.triangle(cx - r, cy + r * 0.5, cx + r, cy + r * 0.5, cx, cy - r * 0.6, colour); }
    else { ui.triangle(cx - r, cy - r * 0.5, cx + r, cy - r * 0.5, cx, cy + r * 0.6, colour); }
  }

  private drawDropdown(f: FontAtlas, input: InputState, boundsY: number, boundsH: number): void {
    const d = this.dropdown!, ui = this.session.ui;
    const count = d.labels.length;
    const rowH = Math.max(d.h, this.s(30));
    const pad = this.s(4);

    // Below the button when there's room for a few rows, else above (whichever has more room)
    const below = boundsY + boundsH - (d.y + d.h) - pad * 2;
    const above = d.y - boundsY - pad * 2;
    const wanted = Math.min(Math.max(count, 1), DROPDOWN_MAX_ROWS);
    const down = below >= rowH * Math.min(wanted, 4) || below >= above;
    const visible = Math.min(Math.max(Math.trunc((down ? below : above) / rowH), 1), wanted);
    const listH = visible * rowH + pad * 2;
    const listW = Math.max(d.w, this.s(160));
    const lx = d.x;
    const ly = down ? d.y + d.h + this.s(2) : d.y - this.s(2) - listH;

    const maxScroll = Math.max(0, count - visible);
    if (d.fresh) {
      d.fresh = false;
      d.scroll = d.selected >= 0 ? d.selected - Math.trunc(visible / 2) : 0;
    }
    const overList = this.hover(input, lx, ly, listW, listH);
    if (this.wheel !== 0 && overList) { d.scroll -= this.wheel * (count > 30 ? 3 : 1); }
    d.scroll = Math.min(Math.max(d.scroll, 0), maxScroll);

    ui.rect(lx + this.s(3), ly + this.s(4), listW, listH, Rgba.hex(0x000000, 0.35)); // shadow
    ui.panel(lx, ly, listW, listH, Rgba.hex(0x111418, 0.98), UiTheme.ACCENT);

    let picked = -1;
    const last = Math.min(count, d.scroll + visible);
    const scrollW = maxScroll > 0 ? this.s(6) : 0;
    for (let i = d.scroll; i < last; i++) {
      const ry = ly + pad + (i - d.scroll) * rowH;
      const hover = this.hover(input, lx + pad, ry, listW - pad * 2, rowH);
      const current = i === d.selected;
      if (hover || current) { ui.rect(lx + pad, ry, listW - pad * 2 - scrollW, rowH, hover ? Rgba.hex(0xffffff, 0.1) : Rgba.hex(0x22d3ee, 0.12)); }
      if (current) { ui.rect(lx + pad, ry, this.s(3), rowH, UiTheme.ACCENT); }
      ui.textWrapped(f.body, lx + pad + this.s(10), ry + rowH * 0.5 - f.body.lineHeight * 0.5, listW - pad * 2 - this.s(20) - scrollW, d.labels[i],
        current ? UiTheme.ACCENT : UiTheme.TEXT, 1);
      if (hover && this.click) { picked = i; }
    }
    if (count === 0) { ui.text(f.body, lx + pad + this.s(10), ly + pad + rowH * 0.5 - f.body.lineHeight * 0.5, '(nothing to pick)', UiTheme.TEXT_MUTED); }

    if (maxScroll > 0) {
      const trackH = listH - pad * 2;
      const thumbH = Math.max(this.s(16), trackH * visible / count);
      const thumbY = ly + pad + (trackH - thumbH) * d.scroll / maxScroll;
      ui.rect(lx + listW - pad - scrollW, ly + pad, scrollW, trackH, Rgba.hex(0xffffff, 0.05));
      ui.rect(lx + listW - pad - scrollW, thumbY, scrollW, thumbH, Rgba.hex(0xffffff, 0.3));
    }

    if (!this.click) { return; }
    if (picked >= 0) {
      const pick = d.pick;
      this.dropdown = null;
      this.session.sound.play(SoundId.UiClick);
      pick(picked);
    } else if (!overList) {
      this.dropdown = null; // a click outside (the button included) closes it
    }
  }

  private drawConfirm(f: FontAtlas, input: InputState, bx: number, by: number, bw: number, bh: number): void {
    const c = this.confirm!, ui = this.session.ui;
    ui.rect(bx, by, bw, bh, Rgba.hex(0x000000, 0.45));

    const w = Math.min(this.s(560), bw - this.s(40));
    const messageH = ui.textWrapped(f.body, 0, 0, w - this.s(48), c.message, UiTheme.TEXT, 6, false);
    const h = this.s(24) + this.s(26) + messageH + this.s(16) + (c.offerSkip ? this.s(34) : 0) + this.s(40) + this.s(24);
    const x = bx + (bw - w) * 0.5, y = by + (bh - h) * 0.5;
    ui.panel(x, y, w, h, UiTheme.CARD, c.danger ? UiTheme.DANGER : UiTheme.ACCENT);

    const ix = x + this.s(24), iw = w - this.s(48);
    let cy = y + this.s(24);
    ui.text(f.small, ix, cy, c.title, c.danger ? UiTheme.DANGER : UiTheme.ACCENT, this.s(1.6));
    cy += this.s(26);
    ui.textWrapped(f.body, ix, cy, iw, c.message, UiTheme.TEXT, 6);
    cy += messageH + this.s(16);

    if (c.offerSkip) {
      const box = this.s(16);
      const hoverSkip = this.hover(input, ix, cy - this.s(3), iw, this.s(24));
      ui.rect(ix, cy, box, box, c.skip ? UiTheme.ACCENT : UiTheme.CONTROL);
      ui.outline(ix, cy, box, box, Math.max(1, ui.scale), c.skip ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
      if (c.skip) {
        ui.line(ix + box * 0.22, cy + box * 0.52, ix + box * 0.42, cy + box * 0.72, this.s(2), Rgba.hex(0x06232a));
        ui.line(ix + box * 0.42, cy + box * 0.72, ix + box * 0.8, cy + box * 0.28, this.s(2), Rgba.hex(0x06232a));
      }
      ui.text(f.body, ix + box + this.s(10), cy - this.s(1), c.skipLabel ?? "Don't ask again this session", hoverSkip ? UiTheme.ACCENT : UiTheme.TEXT_SOFT);
      if (hoverSkip && this.click) {
        c.skip = !c.skip;
        this.session.sound.play(SoundId.UiClick);
        return;
      }
      cy += this.s(34);
    }

    const bwButton = c.altAction !== null ? Math.min(this.s(150), (iw - this.s(20)) / 3) : this.s(150);
    const cancel = this.overlayButton(f, input, ix + iw - bwButton, cy, bwButton, this.s(36), 'CANCEL', false);
    const act = this.overlayButton(f, input, ix + iw - bwButton * 2 - this.s(10), cy, bwButton, this.s(36), c.action, c.danger);
    const alt = c.altAction !== null && this.overlayButton(f, input, ix + iw - bwButton * 3 - this.s(20), cy, bwButton, this.s(36), c.altAction, false);

    if (act) {
      this.confirm = null;
      c.confirmed(c.skip);
    } else if (alt) {
      this.confirm = null;
      c.altConfirmed?.(c.skip);
    } else if (cancel || (this.click && !this.hover(input, x, y, w, h))) {
      this.confirm = null;
    }
  }

  private overlayButton(f: FontAtlas, input: InputState, x: number, y: number, w: number, h: number, label: string, danger: boolean): boolean {
    const ui = this.session.ui;
    const hover = this.hover(input, x, y, w, h);
    ui.rect(x, y, w, h, hover ? Rgba.hex(0xffffff, 0.12) : UiTheme.CONTROL);
    ui.outline(x, y, w, h, Math.max(1, ui.scale), danger ? Rgba.hex(0xfca5a5, 0.6) : hover ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
    ui.textCentred(f.small, x + w * 0.5, y + h * 0.5 - f.small.lineHeight * 0.5, label, danger ? UiTheme.DANGER : hover ? UiTheme.ACCENT : UiTheme.TEXT, this.s(0.8));
    const clicked = hover && this.click;
    if (clicked) { this.session.sound.play(SoundId.UiClick); }
    return clicked;
  }
}
