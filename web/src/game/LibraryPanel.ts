import { CATEGORIES } from '../core/scene/CategoryCatalog';
import { isLibraryEmpty, type LibraryEntry, libraryLabel, placeableCount } from '../core/scene/FamilyLibrary';
import { gl } from '../engine/gl/Gl';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import type { Widgets } from './Menus';

/** Preview images started decoding per frame at most (keeps scrolling smooth on a big library). */
const PREVIEW_DECODES_PER_FRAME = 6;
const SEARCH_MAX = 48;

/**
 * The family library (port of GameSession.Library.cs, panel half): a pause-menu panel to browse, search and filter the
 * loadable family types Revit sent with a live snapshot; picking one hands it to the Place gun.
 */
export class LibraryPanel {
  open = false;
  private scroll = 0;
  private familyScroll = 0;
  private search = '';
  private category = -1;           // catalog index, -1 = all
  private family: string | null = null;
  private placeableOnly = false;
  private notice: string | null = null;
  private noticeFor: LibraryEntry | null = null;
  private rows: number[] = [];
  private families: string[] = [];
  private categories: number[] = [];
  private rowsDirty = true;
  // Preview textures by entry name (null = decoding or undecodable)
  private readonly previews = new Map<string, WebGLTexture | null>();
  private decodes = 0;
  private disposed = false;

  /** Called with the picked entry (the session hands it to the Place gun). */
  onPick: ((entry: LibraryEntry) => void) | null = null;

  constructor(private readonly session: GameSession, private readonly w: Widgets) {}

  private s(v: number): number { return this.session.s(v); }

  get available(): boolean { return !isLibraryEmpty(this.session.scene.library); }

  /** "FAMILY LIBRARY (n)" for the pause menu. */
  menuLabel(): string { return `FAMILY LIBRARY (${this.session.scene.library.entries.length})`; }

  /** Opens the library (pausing the walkthrough); without one, says how to get it. */
  show(): void {
    const session = this.session;
    if (!this.available) {
      session.sound.play(SoundId.Error);
      session.toast(session.live
        ? 'No family library in this snapshot: tick Options → Geometry → “Family library” in Revit, then press Go (or F5)'
        : 'This file has no family library (it comes with live Revit sessions: Options → Geometry → “Family library”)', 5);
      return;
    }
    if (!session.paused) { session.setPaused(true); }
    this.open = true;
    this.notice = null;
  }

  close(): boolean {
    if (!this.open) { return false; }
    this.open = false;
    return true;
  }

  /** Draws and handles the library (in place of the pause menu). Typing goes into the search box. */
  build(): void {
    const session = this.session, ui = session.ui, f = ui.atlas, w = this.w;
    const width = session.screenWidth, height = session.screenHeight;
    this.decodes = 0;
    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    const pw = Math.min(this.s(1180), width - this.s(80)), ph = height - this.s(96);
    const x = (width - pw) * 0.5, y = this.s(48);
    ui.panel(x, y, pw, ph, UiTheme.CARD, UiTheme.CARD_BORDER);

    const library = session.scene.library;
    const ix = x + this.s(24), iw = pw - this.s(48);
    let cy = y + this.s(20);
    ui.text(f.small, ix, cy, 'FAMILY LIBRARY', UiTheme.PLACE_LABEL, this.s(2));
    ui.textRight(f.small, ix + iw, cy, `${library.entries.length.toLocaleString('en')} types · ${placeableCount(library).toLocaleString('en')} placeable · from Revit`,
      UiTheme.TEXT_MUTED, this.s(0.6));
    cy += this.s(32);

    // Search box (typing anywhere in the panel goes here)
    this.type();
    const searchW = Math.min(this.s(360), iw * 0.4), boxH = this.s(34);
    ui.panel(ix, cy, searchW, boxH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
    const ty = cy + boxH * 0.5 - f.body.lineHeight * 0.5;
    if (this.search.length === 0) {
      ui.text(f.body, ix + this.s(10), ty, 'Type to search family, type or category', UiTheme.TEXT_FAINT);
    } else {
      const used = ui.text(f.body, ix + this.s(10), ty, this.search, UiTheme.TEXT);
      if ((Math.trunc(session.clock * 2) & 1) === 0) { ui.rect(ix + this.s(11) + used, cy + this.s(8), this.s(2), boxH - this.s(16), UiTheme.TEXT_SOFT); }
    }
    const placeable = w.checkbox(f, ix + searchW + this.s(16), cy + this.s(9), this.s(200), 'Placeable only', this.placeableOnly);
    if (placeable !== this.placeableOnly) {
      this.placeableOnly = placeable;
      this.scroll = 0;
      this.rowsDirty = true;
    }
    cy += boxH + this.s(14);

    this.refreshRows();

    // Category chips (ALL + the categories present), wrapping
    const chip = { x: ix, y: cy };
    const chipH = this.s(28);
    this.categoryChip(f, chip, ix, iw, chipH, -1, 'ALL');
    for (const category of this.categories) { this.categoryChip(f, chip, ix, iw, chipH, category, CATEGORIES[category].label.toUpperCase()); }
    cy = chip.y + chipH + this.s(16);

    // Footer: notice and CLOSE
    const buttonsY = y + ph - this.s(24) - this.s(44);
    if (this.notice) { ui.textWrapped(f.body, ix, buttonsY - this.s(28), iw, this.notice, UiTheme.MEASURE_TEXT, 1); }
    ui.text(f.small, ix + this.s(176), buttonsY + this.s(14), 'Pick a card: it appears in front of you on the Place gun (9) · RMB commits · Esc discards', UiTheme.TEXT_MUTED);
    if (w.menuButton(f, ix, buttonsY, this.s(160), 'CLOSE', false, false, true, this.s(44))) { this.close(); return; }

    // Families on the left, cards on the right
    const listW = Math.min(this.s(240), iw * 0.24);
    const bottom = buttonsY - this.s(40);
    this.buildFamilyList(f, ix, cy, listW, bottom);
    const picked = this.buildCards(f, ix + listW + this.s(20), cy, iw - listW - this.s(20), bottom);
    if (picked) {
      this.close();
      this.onPick?.(picked);
    }
  }

  /** One category chip (wraps to a new line when the row is full); clicking it filters (again: all). */
  private categoryChip(f: FontAtlas, pos: { x: number; y: number }, left: number, width: number, h: number, category: number, label: string): void {
    const session = this.session, ui = session.ui, input = session.input;
    const w = UiBatch.measure(f.small, label, this.s(0.6)) + this.s(24);
    if (pos.x > left && pos.x + w > left + width) {
      pos.x = left;
      pos.y += h + this.s(8);
    }
    const on = this.category === category;
    const hover = this.w.hover(pos.x, pos.y, w, h);
    ui.rect(pos.x, pos.y, w, h, on ? UiTheme.PLACE : hover ? Rgba.hex(0xffffff, 0.08) : UiTheme.CONTROL);
    ui.outline(pos.x, pos.y, w, h, Math.max(1, ui.scale), on ? UiTheme.PLACE : UiTheme.CONTROL_BORDER);
    ui.textCentred(f.small, pos.x + w * 0.5, pos.y + h * 0.5 - f.small.lineHeight * 0.5, label, on ? Rgba.hex(0x1f1300) : UiTheme.TEXT, this.s(0.6));
    if (hover && input.leftPressed) {
      input.consumeClicks();
      session.sound.play(SoundId.UiClick);
      this.category = on && category >= 0 ? -1 : category;
      this.family = null;
      this.scroll = this.familyScroll = 0;
      this.rowsDirty = true;
    }
    pos.x += w + this.s(8);
  }

  /** The family list (All families, then each family of the current category and search); click to filter. */
  private buildFamilyList(f: FontAtlas, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, input = session.input;
    ui.panel(x, y, width, bottom - y, Rgba.hex(0xffffff, 0.02), UiTheme.CARD_BORDER);
    const rowH = this.s(28);
    const visible = Math.max(1, Math.trunc((bottom - y - this.s(8)) / rowH));
    const total = this.families.length + 1;
    const maxScroll = Math.max(0, total - visible);
    if (input.wheel !== 0 && this.w.hover(x, y, width, bottom - y)) { this.familyScroll -= input.wheel * 3; }
    this.familyScroll = Math.min(Math.max(this.familyScroll, 0), maxScroll);

    const last = Math.min(total, this.familyScroll + visible);
    for (let i = this.familyScroll; i < last; i++) {
      const family = i === 0 ? null : this.families[i - 1];
      const ry = y + this.s(4) + (i - this.familyScroll) * rowH;
      const on = this.family === family;
      const hover = this.w.hover(x + this.s(4), ry, width - this.s(8), rowH - this.s(2));
      if (on || hover) { ui.rect(x + this.s(4), ry, width - this.s(8), rowH - this.s(2), on ? Rgba.withAlpha(UiTheme.PLACE, 0.25) : Rgba.hex(0xffffff, 0.06)); }
      ui.textWrapped(f.body, x + this.s(12), ry + rowH * 0.5 - f.body.lineHeight * 0.5 - this.s(1), width - this.s(24), family ?? 'All families',
        on ? UiTheme.PLACE_LABEL : UiTheme.TEXT, 1);
      if (hover && input.leftPressed) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        this.family = family;
        this.scroll = 0;
        this.rowsDirty = true;
      }
    }
  }

  /** The grid of cards (preview, type, family, status); wheel scrolls. Returns the entry clicked this frame. */
  private buildCards(f: FontAtlas, x: number, y: number, width: number, bottom: number): LibraryEntry | null {
    const session = this.session, ui = session.ui, input = session.input;
    const entries = session.scene.library.entries;
    if (this.rows.length === 0) {
      ui.textWrapped(f.body, x, y + this.s(8), width, 'Nothing matches. Clear the search (Backspace) or pick ALL.', UiTheme.TEXT_MUTED, 2);
      return null;
    }

    const cardW = this.s(168), cardH = this.s(214), gap = this.s(12);
    const columns = Math.max(1, Math.trunc((width + gap) / (cardW + gap)));
    const rowsVisible = Math.max(1, Math.trunc((bottom - y + gap) / (cardH + gap)));
    const rowCount = Math.ceil(this.rows.length / columns);
    const maxScroll = Math.max(0, rowCount - rowsVisible);
    if (input.wheel !== 0 && this.w.hover(x, y, width, bottom - y)) { this.scroll -= input.wheel; }
    this.scroll = Math.min(Math.max(this.scroll, 0), maxScroll);

    let picked: LibraryEntry | null = null;
    const first = this.scroll * columns, last = Math.min(this.rows.length, first + rowsVisible * columns);
    for (let i = first; i < last; i++) {
      const entry = entries[this.rows[i]];
      const slot = i - first;
      const cx = x + (slot % columns) * (cardW + gap), cy = y + Math.trunc(slot / columns) * (cardH + gap);
      const usable = entry.placeable && entry.element >= 0;
      const hovering = this.w.hover(cx, cy, cardW, cardH);
      const hover = usable && hovering;
      ui.panel(cx, cy, cardW, cardH, hover ? Rgba.hex(0xffffff, 0.07) : UiTheme.CONTROL, hover ? UiTheme.PLACE : UiTheme.CONTROL_BORDER);

      // Preview (Revit's own, on a light tile like Revit's browser)
      const pad = this.s(10), image = cardW - pad * 2;
      ui.rect(cx + pad, cy + pad, image, image, Rgba.hex(0xf4f5f7, usable ? 1 : 0.35));
      const texture = this.previewTexture(entry);
      if (texture) { ui.image(texture, cx + pad, cy + pad, image, image, session.screenWidth, session.screenHeight, usable ? 0xffffffff : Rgba.hex(0xffffff, 0.4)); }
      else { ui.textCentred(f.small, cx + cardW * 0.5, cy + pad + image * 0.5 - this.s(7), entry.preview ? '…' : 'NO PREVIEW', Rgba.hex(0x6b7280), this.s(0.4)); }

      const ty = cy + pad + image + this.s(6);
      ui.textWrapped(f.bold, cx + pad, ty, image, entry.type, usable ? UiTheme.TEXT : UiTheme.TEXT_FAINT, 1);
      ui.textWrapped(f.small, cx + pad, ty + this.s(20), image, entry.family, UiTheme.TEXT_MUTED, 1);
      const status = usable ? (entry.placed > 0 ? `${entry.placed.toLocaleString('en')} in the model` : 'Not placed in the model yet') : entry.reason ?? 'Not placeable';
      ui.textWrapped(f.small, cx + pad, ty + this.s(38), image, status, usable ? UiTheme.PLACE_LABEL : UiTheme.TEXT_FAINT, 1);

      if (hover && input.leftPressed) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        picked = entry;
      } else if (!usable && hovering && this.noticeFor !== entry) {
        this.noticeFor = entry;
        this.notice = `${libraryLabel(entry)}: ${entry.reason ?? 'not placeable'}`;
      }
    }
    if (maxScroll > 0) {
      ui.textRight(f.small, x + width, bottom + this.s(6), `${first + 1}–${last} of ${this.rows.length} · wheel to scroll`, UiTheme.TEXT_FAINT);
    }
    return picked;
  }

  /** Typed characters go into the search (Backspace deletes, Ctrl+Backspace clears). */
  private type(): void {
    const input = this.session.input;
    const before = this.search;
    if (input.isPressedOrRepeated(Vk.BACK)) { this.search = input.isDown(Vk.CONTROL) ? '' : this.search.slice(0, -1); }
    for (const c of input.typed) {
      if (c >= ' ' && c !== '\u007f' && this.search.length < SEARCH_MAX) { this.search += c; }
    }
    if (this.search !== before) {
      this.scroll = 0;
      this.rowsDirty = true;
    }
  }

  /** Rebuilds the filtered rows, the family list and the category list when the search or a filter changed. */
  private refreshRows(): void {
    if (!this.rowsDirty) { return; }
    this.rowsDirty = false;
    const words = this.search.trim().toLowerCase().split(' ').filter(Boolean);
    const entries = this.session.scene.library.entries;
    const families = new Set<string>(), categories = new Set<number>();
    this.rows = [];
    entries.forEach((entry, i) => {
      if (this.placeableOnly && !(entry.placeable && entry.element >= 0)) { return; }
      const category = entry.categoryIndex >= 0 ? CATEGORIES[entry.categoryIndex].label : entry.category;
      const text = `${entry.family} ${entry.type} ${category}`.toLowerCase();
      if (!words.every(word => text.includes(word))) { return; }
      if (entry.categoryIndex >= 0) { categories.add(entry.categoryIndex); }
      if (this.category >= 0 && entry.categoryIndex !== this.category) { return; }
      families.add(entry.family);
      if (this.family !== null && entry.family !== this.family) { return; }
      this.rows.push(i);
    });
    this.families = [...families].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    this.categories = [...categories].sort((a, b) => a - b);
    if (this.family !== null && !families.has(this.family)) { this.family = null; }
  }

  /** The texture of an entry's preview (decoded asynchronously on first sight, a few per frame), or null. */
  private previewTexture(entry: LibraryEntry): WebGLTexture | null {
    const name = entry.preview;
    if (!name) { return null; }
    if (this.previews.has(name)) { return this.previews.get(name) ?? null; }
    const png = this.session.scene.library.previews.get(name);
    if (!png || this.decodes >= PREVIEW_DECODES_PER_FRAME) { return null; }
    this.decodes++;
    this.previews.set(name, null);
    createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }))
      .then(bitmap => {
        if (this.disposed) { bitmap.close(); return; }
        // Composed over Revit's light tile colour (previews are often transparent)
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#f4f5f7';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.previews.set(name, texture);
      })
      .catch(e => console.info(`Family library preview unreadable (${libraryLabel(entry)}): ${e instanceof Error ? e.message : String(e)}`));
    return null;
  }

  /** Frees every preview texture (session end). */
  dispose(): void {
    this.disposed = true;
    for (const texture of this.previews.values()) { if (texture) { gl.deleteTexture(texture); } }
    this.previews.clear();
  }
}
