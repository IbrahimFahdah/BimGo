import { InputAction } from '../core/scene/InputCatalog';
import { gl } from '../engine/gl/Gl';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import type { InputState } from '../platform/input';
import type { GameWindow } from '../platform/window';
import { LastLive, type LastLiveSession, type RecentFile, type RecentFiles } from './RecentFiles';

/** What the home screen asks the shell to do this frame. */
export type HomeAction = { kind: 'browse' } | { kind: 'sample' } | null;

/** Sky round: the trademark line (bottom left; the version is bottom right). */
const TRADEMARK_LINE = 'Revit® is a trademark of Autodesk, Inc. BimGo is not affiliated with Autodesk.';

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

  // Recent files' thumbnails as GL textures (decoded once; null while decoding or when unreadable), freed when a model opens
  private readonly thumbnails = new Map<string, { data: string; texture: WebGLTexture | null }>();
  private lastLive: LastLiveSession | null = LastLive.load();

  constructor(
    private readonly window: GameWindow,
    private readonly ui: UiBatch,
    private readonly recent: RecentFiles,
    private readonly version: string
  ) {}

  private s(value: number): number {
    return value * this.ui.scale;
  }

  /** Frees the thumbnail textures (a model opens: the walkthrough gets the memory) and re-reads the last live session. */
  release(): void {
    for (const { texture } of this.thumbnails.values()) { if (texture) { gl.deleteTexture(texture); } }
    this.thumbnails.clear();
    this.lastLive = LastLive.load();
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
    if (input.pressed(InputAction.OpenFile)) { action = { kind: 'browse' }; }
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

    // ---- Right: the last live session (greyed: Revit starts sessions), then recent files
    let top = pad;
    if (this.lastLive) { top += this.drawLastLive(f, input, rightX, top, rightW, this.lastLive) + this.s(18); }
    action = this.drawRecent(f, input, rightX, top, rightW, height - pad - top) ?? action;

    // Footer
    ui.textRight(f.small, width - pad, height - this.s(30), `BimGo Web ${this.version} · Ctrl+O open · drop a .bimgo here`, UiTheme.TEXT_FAINT, this.s(0.5));
    ui.text(f.small, pad, height - this.s(30), TRADEMARK_LINE, UiTheme.TEXT_FAINT, this.s(0.3)); // sky round: bottom left
    ui.flush(width, height);
    return action;
  }

  /**
   * The last model walked live, greyed: it can't be joined from here (Go in Revit starts sessions).
   * @returns The height drawn.
   */
  private drawLastLive(f: FontAtlas, input: InputState, x: number, top: number, width: number, last: LastLiveSession): number {
    const ui = this.ui;
    ui.text(f.small, x, top + this.s(6), 'LAST LIVE SESSION', UiTheme.TEXT_MUTED, this.s(1.8));
    const y = top + this.s(32), row = this.s(58);
    const hover = hit(input, x, y, width, row);
    ui.panel(x, y, width, row, UiTheme.CARD, Rgba.hex(0xffffff, hover ? 0.18 : 0.08));
    ui.ring(x + this.s(18), y + this.s(18), this.s(4), this.s(1.5), UiTheme.TEXT_FAINT);
    ui.textWrapped(f.bold, x + this.s(30), y + this.s(9), width - this.s(200), last.docTitle, UiTheme.TEXT_FAINT, 1);
    if (last.revitVersion) { ui.textRight(f.small, x + width - this.s(16), y + this.s(12), 'REVIT ' + last.revitVersion, UiTheme.TEXT_FAINT, this.s(0.5)); }
    const when = last.lastUsedUtc ? `Last walked ${formatDate(new Date(last.lastUsedUtc))} · ` : '';
    ui.textWrapped(f.body, x + this.s(16), y + this.s(32), width - this.s(32), when + 'open it in Revit and press Go (Open in the browser)', UiTheme.TEXT_FAINT, 1);
    if (hover && input.leftPressed) {
      input.consumeClicks();
      this.setMessage(`${last.docTitle} is walked live from Revit: open it there, press Go and tick Open in the browser (BimGo tab).`, false);
    }
    return row + this.s(32);
  }

  /**
   * The recent files list: a card per file with its thumbnail (saved since the review tools round), title, details and
   * REMOVE FROM LIST; click asks for the file again (names only for now), right-click removes it too.
   */
  private drawRecent(f: FontAtlas, input: InputState, x: number, top: number, width: number, height: number): HomeAction {
    const ui = this.ui;
    ui.text(f.small, x, top + this.s(6), 'RECENT', UiTheme.TEXT_MUTED, this.s(1.8));
    let y = top + this.s(32);
    const row = this.s(84);

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

      // Thumbnail (16:9), or a placeholder with the BimGo mark
      const thumbH = row - this.s(16), thumbW = thumbH * 16 / 9;
      const tx = x + this.s(8), ty = y + this.s(8);
      const texture = this.thumbnailTexture(entry);
      if (texture) {
        ui.image(texture, tx, ty, thumbW, thumbH, this.window.width, this.window.height);
        ui.outline(tx, ty, thumbW, thumbH, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.12));
      } else {
        ui.panel(tx, ty, thumbW, thumbH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
        this.drawLogo(tx + thumbW * 0.5 - thumbH * 0.27, ty + thumbH * 0.5, thumbH * 0.38, Rgba.withAlpha(UiTheme.ACCENT, 0.35));
      }

      const textX = tx + thumbW + this.s(14), textW = x + width - textX - this.s(16);
      ui.textWrapped(f.bold, textX, y + this.s(10), textW - this.s(150), entry.name.replace(/\.bimgo$/i, ''), UiTheme.TEXT, 1);
      ui.textRight(f.small, x + width - this.s(16), y + this.s(13), formatDate(new Date(entry.lastUsedUtc)), UiTheme.TEXT_MUTED, this.s(0.5));
      ui.textWrapped(f.body, textX, y + this.s(33), textW, `${entry.name} · ${formatMb(entry.size)}`, UiTheme.TEXT_MUTED, 1);

      // Bottom line: REMOVE FROM LIST (brighter on hover)
      const linkY = y + row - this.s(24);
      const removeW = UiBatch.measure(f.small, 'REMOVE FROM LIST', this.s(0.6)) + this.s(8);
      const removeX = x + width - this.s(16) - removeW;
      const removeHover = hit(input, removeX, linkY - this.s(2), removeW, this.s(20));
      ui.text(f.small, removeX + this.s(4), linkY + this.s(2), 'REMOVE FROM LIST', removeHover ? UiTheme.DANGER : hover ? UiTheme.TEXT_SOFT : UiTheme.TEXT_FAINT, this.s(0.6));

      if (hover && input.leftPressed) {
        input.consumeClicks();
        if (removeHover) { remove = entry.name; }
        else {
          this.setMessage(`Pick ${entry.name} again: the browser can't reopen files by itself yet.`, false);
          action = { kind: 'browse' };
        }
      } else if (hover && input.rightPressed) {
        remove = entry.name;
      }
      y += row + this.s(8);
    }

    if (remove !== null) {
      this.recent.remove(remove);
      const cached = this.thumbnails.get(remove);
      if (cached?.texture) { gl.deleteTexture(cached.texture); }
      this.thumbnails.delete(remove);
    }
    return action;
  }

  /** A recent file's thumbnail as a GL texture (decoded once, asynchronously; null until ready or when it has none). */
  private thumbnailTexture(entry: RecentFile): WebGLTexture | null {
    const data = entry.thumbnail;
    if (!data) { return null; }
    const cached = this.thumbnails.get(entry.name);
    if (cached && cached.data === data) { return cached.texture; }
    if (cached?.texture) { gl.deleteTexture(cached.texture); }

    const slot: { data: string; texture: WebGLTexture | null } = { data, texture: null };
    this.thumbnails.set(entry.name, slot);
    fetch(`data:image/jpeg;base64,${data}`)
      .then(r => r.blob())
      .then(blob => createImageBitmap(blob))
      .then(bitmap => {
        if (this.thumbnails.get(entry.name) !== slot) { bitmap.close(); return; }
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        bitmap.close();
        slot.texture = texture;
      })
      .catch(e => console.info(`Recent thumbnail unreadable (${entry.name}): ${e instanceof Error ? e.message : String(e)}`));
    return null;
  }

  /** The BimGo ">>" mark (the app icon's chevrons), centred vertically on cy. */
  private drawLogo(x: number, cy: number, height: number, colour: number = UiTheme.ACCENT): void {
    const half = height * 0.5, width = height * 0.5, thickness = Math.max(2, height * 0.16);
    for (let i = 0; i < 2; i++) {
      const x0 = x + i * width * 1.05;
      this.ui.line(x0, cy - half, x0 + width, cy, thickness, colour);
      this.ui.line(x0 + width, cy, x0, cy + half, thickness, colour);
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
