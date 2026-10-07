import { gl } from '../engine/gl/Gl';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { Vk, type InputState } from '../platform/input';
import type { GameWindow } from '../platform/window';
import type { RecentFiles } from './RecentFiles';

/** What the home screen asks the shell to do this frame. */
export type HomeAction = { kind: 'browse' } | { kind: 'sample' } | null;

/**
 * The start screen, drawn on the canvas with the same immediate-mode UI as the HUD (port of
 * BimGo.App/Shell/HomeScreen.cs). Differences from the desktop: no QUIT (a page can't close itself), and live
 * sessions are joined from Revit's Go rather than listed here (the browser can't scan the session folder).
 */
export class HomeScreen {
  /** A message shown under the buttons (e.g. why a file could not be opened), or null. */
  message: string | null = null;
  /** True when {@link message} is an error (shown in red). */
  messageIsError = false;

  constructor(
    private readonly window: GameWindow,
    private readonly ui: UiBatch,
    private readonly recent: RecentFiles,
    private readonly version: string
  ) {}

  private s(value: number): number {
    return value * this.ui.scale;
  }

  /** Sets the message line. */
  setMessage(message: string, error: boolean): void {
    this.message = message;
    this.messageIsError = error;
  }

  /**
   * Draws one frame and handles clicks and Ctrl+O.
   */
  frame(): HomeAction {
    const input = this.window.input;
    let action: HomeAction = null;
    if (input.isDown(Vk.CONTROL) && input.isPressed(Vk.key('O'))) { action = { kind: 'browse' }; }
    return this.draw(input) ?? action;
  }

  /**
   * Shows a status line on an otherwise empty frame (used while loading a file).
   */
  drawStatus(title: string, message: string): void {
    this.beginFrame();
    const f = this.ui.atlas;
    const cx = this.window.width * 0.5, cy = this.window.height * 0.5;
    this.ui.textCentred(f.title, cx, cy - this.s(40), 'BIMGO', UiTheme.TEXT, this.s(4));
    this.ui.textCentred(f.bold, cx, cy + this.s(14), title, UiTheme.TEXT, this.s(0.5));
    this.ui.textCentred(f.body, cx, cy + this.s(42), message, UiTheme.TEXT_MUTED);
    this.ui.flush(this.window.width, this.window.height);
  }

  // #region Drawing

  private beginFrame(): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.window.width, this.window.height);
    gl.clearColor(0.063, 0.075, 0.094, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  private draw(input: InputState): HomeAction {
    this.beginFrame();
    const ui = this.ui;
    const f = ui.atlas;
    const width = this.window.width, height = this.window.height;
    let action: HomeAction = null;

    const pad = this.s(56);
    const leftX = pad, leftW = this.s(300);
    const rightX = leftX + leftW + this.s(56), rightW = Math.max(this.s(320), width - rightX - pad);

    // ---- Left: title, actions, hints
    let y = pad;
    const titleWidth = ui.text(f.title, leftX, y, 'BIMGO', UiTheme.TEXT, this.s(4));
    this.drawLogo(leftX + titleWidth + this.s(14), y + f.title.lineHeight * 0.5, f.title.lineHeight * 0.62);
    y += this.s(56);
    ui.text(f.body, leftX, y, 'First-person BIM walkthroughs', UiTheme.TEXT_MUTED);
    y += this.s(44);

    if (this.button(f, input, leftX, y, leftW, 'OPEN .BIMGO…', true)) { action = { kind: 'browse' }; }
    y += this.s(60);
    if (this.button(f, input, leftX, y, leftW, 'TRY THE SAMPLE', false)) { action = { kind: 'sample' }; }
    y += this.s(72);

    if (this.message) {
      const used = ui.textWrapped(f.body, leftX, y, leftW, this.message, this.messageIsError ? UiTheme.DANGER : UiTheme.GOOD, 5);
      y += used + this.s(20);
    }

    ui.text(f.small, leftX, y, 'GET A MODEL', UiTheme.TEXT_MUTED, this.s(1.6));
    y += this.s(22);
    y += ui.textWrapped(f.body, leftX, y, leftW, 'In Revit: BimGo tab → Export .bimgo. Then open it here or drop it on this page. The file stays on your computer.', UiTheme.TEXT_SOFT, 6);
    y += this.s(18);
    ui.text(f.small, leftX, y, 'WALK A MODEL LIVE', UiTheme.TEXT_MUTED, this.s(1.6));
    y += this.s(22);
    ui.textWrapped(f.body, leftX, y, leftW, 'In Revit: Go → tick Open in the browser. Edits come back to the model; F5 loads changes made in Revit. Chrome or Edge.', UiTheme.TEXT_SOFT, 6);

    // ---- Right: recent files
    action = this.drawRecent(f, input, rightX, pad, rightW, height - pad - pad) ?? action;

    // Footer
    ui.textRight(f.small, width - pad, height - this.s(30), `BimGo Web ${this.version} · Ctrl+O open · drop a .bimgo here`, UiTheme.TEXT_FAINT, this.s(0.5));
    ui.flush(width, height);
    return action;
  }

  /**
   * The recent files list: click asks for the file again (names only for now), right-click removes it.
   */
  private drawRecent(f: FontAtlas, input: InputState, x: number, top: number, width: number, height: number): HomeAction {
    const ui = this.ui;
    ui.text(f.small, x, top + this.s(6), 'RECENT', UiTheme.TEXT_MUTED, this.s(1.8));
    let y = top + this.s(32);
    const row = this.s(58);

    if (this.recent.entries.length === 0) {
      ui.panel(x, y, width, this.s(70), UiTheme.CARD, UiTheme.CARD_BORDER);
      ui.text(f.body, x + this.s(16), y + this.s(25), 'No recent files yet.', UiTheme.TEXT_MUTED);
      return null;
    }

    let action: HomeAction = null;
    let remove: string | null = null;
    const visible = Math.max(1, Math.trunc((height - this.s(32)) / (row + this.s(8))));
    for (const entry of this.recent.entries.slice(0, visible)) {
      const hover = hit(input, x, y, width, row);
      ui.panel(x, y, width, row, hover ? Rgba.hex(0xffffff, 0.06) : UiTheme.CARD, hover ? UiTheme.ACCENT : UiTheme.CARD_BORDER);

      ui.textWrapped(f.bold, x + this.s(16), y + this.s(9), width - this.s(200), entry.name.replace(/\.bimgo$/i, ''), UiTheme.TEXT, 1);
      ui.textRight(f.small, x + width - this.s(16), y + this.s(12), formatDate(new Date(entry.lastUsedUtc)), UiTheme.TEXT_MUTED, this.s(0.5));
      ui.textWrapped(f.body, x + this.s(16), y + this.s(32), width - this.s(32), `${entry.name} · ${formatMb(entry.size)}`, UiTheme.TEXT_MUTED, 1);

      if (hover && input.leftPressed) {
        input.consumeClicks();
        this.setMessage(`Pick ${entry.name} again: the browser can't reopen files by itself yet.`, false);
        action = { kind: 'browse' };
      } else if (hover && input.rightPressed) {
        remove = entry.name;
      }
      y += row + this.s(8);
    }

    if (remove !== null) { this.recent.remove(remove); }
    return action;
  }

  /** The BimGo ">>" mark (the app icon's chevrons), centred vertically on cy. */
  private drawLogo(x: number, cy: number, height: number): void {
    const half = height * 0.5, width = height * 0.5, thickness = Math.max(2, height * 0.16);
    for (let i = 0; i < 2; i++) {
      const x0 = x + i * width * 1.05;
      this.ui.line(x0, cy - half, x0 + width, cy, thickness, UiTheme.ACCENT);
      this.ui.line(x0 + width, cy, x0, cy + half, thickness, UiTheme.ACCENT);
    }
  }

  /** A full-width button. */
  private button(f: FontAtlas, input: InputState, x: number, y: number, w: number, label: string, primary: boolean): boolean {
    const h = this.s(48);
    const hover = hit(input, x, y, w, h);
    if (primary) {
      this.ui.rect(x, y, w, h, hover ? Rgba.hex(0x67e8f9) : UiTheme.ACCENT);
    } else {
      this.ui.rect(x, y, w, h, hover ? Rgba.hex(0xffffff, 0.08) : Rgba.hex(0xffffff, 0));
      this.ui.outline(x, y, w, h, Math.max(1, this.ui.scale), Rgba.hex(0xffffff, 0.2));
    }
    this.ui.text(f.bold, x + this.s(16), y + h * 0.5 - f.bold.lineHeight * 0.5, label, primary ? Rgba.hex(0x06232a) : UiTheme.TEXT, this.s(1.3));

    const clicked = hover && input.leftPressed;
    if (clicked) { input.consumeClicks(); }
    return clicked;
  }

  // #endregion
}

function hit(input: InputState, x: number, y: number, w: number, h: number): boolean {
  return input.mouseX >= x && input.mouseX < x + w && input.mouseY >= y && input.mouseY < y + h;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "dd MMM yyyy HH:mm" in local time, as on the desktop. */
function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) { return ''; }
  const two = (n: number) => n.toString().padStart(2, '0');
  return `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
