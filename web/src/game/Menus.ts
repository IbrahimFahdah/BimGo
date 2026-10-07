import type { BookmarkRecord, CommentRecord } from '../core/format/DocumentModels';
import { setCurrentUser } from '../core/format/DocumentModels';
import { type Vec3, vec3 } from '../core/math/Vector';
import { CATEGORIES, CategoryGroup, GROUP_NAMES } from '../core/scene/CategoryCatalog';
import { linkLabel } from '../core/scene/LinkInfo';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas, UiFont } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import { BookmarkStore } from './Stores';
import { ColourMode } from './ViewerSettings';

const COLOUR_OPTIONS = ['Whitecard', 'Material', 'Realistic'];

/**
 * Immediate-mode widgets shared by the menus (port of the Widgets region of GameSession.Menu.cs). Each call draws and
 * returns what was clicked this frame.
 */
export class Widgets {
  activeSlider = -1;

  constructor(private readonly session: GameSession) {}

  private get ui(): UiBatch { return this.session.ui; }
  private get input(): InputState { return this.session.input; }
  private s(v: number): number { return this.session.s(v); }

  hover(x: number, y: number, w: number, h: number): boolean {
    const i = this.input;
    return i.mouseX >= x && i.mouseX < x + w && i.mouseY >= y && i.mouseY < y + h;
  }

  menuButton(f: FontAtlas, x: number, y: number, w: number, label: string, primary: boolean, danger: boolean, enabled = true, height = 0): boolean {
    const ui = this.ui;
    const h = height > 0 ? height : this.s(48);
    const hover = enabled && this.hover(x, y, w, h);
    const alpha = enabled ? 1 : 0.4;
    if (primary) {
      ui.rect(x, y, w, h, fade(hover ? Rgba.hex(0x67e8f9) : UiTheme.ACCENT, alpha));
    } else {
      ui.rect(x, y, w, h, hover ? Rgba.hex(0xffffff, 0.08) : Rgba.hex(0xffffff, 0));
      ui.outline(x, y, w, h, Math.max(1, ui.scale), fade(danger ? Rgba.hex(0xfca5a5, 0.45) : Rgba.hex(0xffffff, 0.2), alpha));
    }
    const textColour = primary ? Rgba.hex(0x06232a) : danger ? UiTheme.DANGER : UiTheme.TEXT;
    ui.text(f.bold, x + this.s(16), y + h * 0.5 - f.bold.lineHeight * 0.5, label, primary ? textColour : fade(textColour, alpha), this.s(1.3));
    return this.click(hover);
  }

  smallButton(f: FontAtlas, x: number, y: number, w: number, h: number, label: string, danger = false): boolean {
    const ui = this.ui;
    const hover = this.hover(x, y, w, h);
    ui.rect(x, y, w, h, hover ? Rgba.hex(0xffffff, 0.1) : UiTheme.CONTROL);
    ui.outline(x, y, w, h, Math.max(1, ui.scale), danger ? Rgba.hex(0xfca5a5, 0.45) : UiTheme.CONTROL_BORDER);
    ui.textCentred(f.small, x + w * 0.5, y + h * 0.5 - f.small.lineHeight * 0.5, label, danger ? UiTheme.DANGER : hover ? UiTheme.ACCENT : UiTheme.TEXT, this.s(0.8));
    return this.click(hover);
  }

  slider(f: FontAtlas, id: number, x: number, y: number, w: number, label: string, valueText: string, value: number, min: number, max: number): number {
    const ui = this.ui, input = this.input;
    ui.text(f.body, x, y, label, UiTheme.TEXT);
    ui.textRight(f.mono, x + w, y + this.s(1), valueText, Rgba.hex(0x67e8f9));

    const trackY = y + this.s(30), knobR = this.s(7);
    const hover = this.hover(x - knobR, trackY - this.s(12), w + knobR * 2, this.s(24));
    if (hover && input.leftPressed) { this.activeSlider = id; }
    if (this.activeSlider === id && input.leftDown) {
      value = min + Math.min(Math.max((input.mouseX - x) / w, 0), 1) * (max - min);
    }

    const fraction = Math.min(Math.max((value - min) / (max - min), 0), 1);
    ui.rect(x, trackY - this.s(2), w, this.s(4), Rgba.hex(0xffffff, 0.15));
    ui.rect(x, trackY - this.s(2), w * fraction, this.s(4), UiTheme.ACCENT);
    ui.circle(x + w * fraction, trackY, knobR, hover || this.activeSlider === id ? Rgba.hex(0x67e8f9) : UiTheme.ACCENT, 16);
    return value;
  }

  segmented(f: FontAtlas, x: number, y: number, w: number, options: string[], selected: number): number {
    const ui = this.ui;
    const h = this.s(32), segment = w / options.length;
    options.forEach((option, i) => {
      const sx = x + i * segment, on = i === selected;
      const hover = this.hover(sx, y, segment, h);
      ui.rect(sx, y, segment, h, on ? UiTheme.ACCENT : hover ? Rgba.hex(0xffffff, 0.08) : UiTheme.CONTROL);
      ui.outline(sx, y, segment, h, Math.max(1, ui.scale), UiTheme.CONTROL_BORDER);
      ui.textCentred(f.body, sx + segment * 0.5, y + h * 0.5 - f.body.lineHeight * 0.5, option, on ? Rgba.hex(0x06232a) : UiTheme.TEXT);
      if (hover && this.input.leftPressed && !on) {
        selected = i;
        this.session.sound.play(SoundId.UiClick);
      }
    });
    return selected;
  }

  checkbox(f: FontAtlas, x: number, y: number, w: number, label: string, value: boolean): boolean {
    const ui = this.ui;
    const box = this.s(16);
    const hover = this.hover(x, y - this.s(3), w, this.s(24));
    ui.rect(x, y, box, box, value ? UiTheme.ACCENT : UiTheme.CONTROL);
    ui.outline(x, y, box, box, Math.max(1, ui.scale), value ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
    if (value) { this.tick(x, y, box, Rgba.hex(0x06232a)); }
    ui.text(f.body, x + box + this.s(10), y - this.s(1), label, hover ? UiTheme.ACCENT : UiTheme.TEXT);
    if (hover && this.input.leftPressed) {
      this.session.sound.play(SoundId.UiClick);
      return !value;
    }
    return value;
  }

  /** A check mark inside a box. */
  tick(bx: number, by: number, box: number, colour: number): void {
    this.ui.line(bx + box * 0.22, by + box * 0.52, bx + box * 0.42, by + box * 0.72, this.s(2), colour);
    this.ui.line(bx + box * 0.42, by + box * 0.72, bx + box * 0.8, by + box * 0.28, this.s(2), colour);
  }

  private click(hover: boolean): boolean {
    const clicked = hover && this.input.leftPressed;
    if (clicked) {
      this.input.consumeClicks();
      this.session.sound.play(SoundId.UiClick);
    }
    return clicked;
  }
}

function fade(colour: number, factor: number): number {
  if (factor >= 1) { return colour; }
  const alpha = Math.min(Math.max(Math.trunc((colour >>> 24) * factor + 0.5), 0), 255);
  return ((colour & 0x00ffffff) | (alpha << 24)) >>> 0;
}

/**
 * The pause menu with its comment and bookmark lists (port of GameSession.Menu.cs, .Comments.cs and .Bookmarks.cs
 * panels). Saving, push to Revit and textures join with their phases.
 */
export class PauseMenu {
  private readonly w: Widgets;
  private commentsOpen = false;
  private commentLevelFilter = -1;
  private commentScroll = 0;
  private commentDeleteArmed: CommentRecord | null = null;
  private commentDeleteArmedUntil = 0;
  private commentsNotice: string | null = null;
  private bookmarksOpen = false;
  private bookmarkScroll = 0;
  private bookmarkDeleteArmed: BookmarkRecord | null = null;
  private bookmarkDeleteArmedUntil = 0;
  private bookmarksNotice: string | null = null;

  constructor(private readonly session: GameSession) {
    this.w = new Widgets(session);
  }

  private s(v: number): number { return this.session.s(v); }

  /** Closes an open list (Esc); false when none was open. */
  closePanels(): boolean {
    if (this.commentsOpen) { this.commentsOpen = false; this.commentDeleteArmed = null; return true; }
    if (this.bookmarksOpen) { this.bookmarksOpen = false; this.bookmarkDeleteArmed = null; return true; }
    return false;
  }

  // #region Main menu

  build(): void {
    if (this.commentsOpen) { this.buildCommentsPanel(); return; }
    if (this.bookmarksOpen) { this.buildBookmarksPanel(); return; }

    const session = this.session, ui = session.ui, f = ui.atlas, w = this.w;
    const input = session.input;
    const width = session.screenWidth, height = session.screenHeight;
    if (!input.leftDown) { w.activeSlider = -1; }
    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    const pad = this.s(48);
    const leftX = this.s(56), leftW = this.s(220);
    const rightW = this.s(280), rightX = width - this.s(56) - rightW;
    const midX = leftX + leftW + this.s(40), midW = rightX - this.s(40) - midX;

    // ---- Left column
    let y = pad;
    ui.text(f.small, leftX, y, 'BIMGO', UiTheme.TEXT_MUTED, this.s(2.6));
    y += this.s(20);
    ui.text(f.title, leftX, y, 'PAUSED', UiTheme.TEXT, this.s(2.4));
    y += this.s(64);

    const endY = height - pad - this.s(48);
    const hiddenThings = session.hiddenThingsCount;
    const buttons = 6 + (hiddenThings > 0 ? 1 : 0);
    const step = Math.min(Math.max((endY - this.s(12) - y) / buttons, this.s(40)), this.s(54));
    const buttonH = step - this.s(6);

    if (w.menuButton(f, leftX, y, leftW, 'RESUME', true, false, true, buttonH)) { session.setPaused(false); return; }
    y += step;
    if (w.menuButton(f, leftX, y, leftW, 'RETURN HOME', false, false, true, buttonH)) { session.player.goHome(); session.setPaused(false); return; }
    y += step;
    if (w.menuButton(f, leftX, y, leftW, session.clock < session.homeSetUntil ? 'HOME SET HERE' : 'SET HOME HERE', false, false, true, buttonH)) { session.setHomeHere(); }
    y += step;
    const comments = session.comments.comments.length;
    if (w.menuButton(f, leftX, y, leftW, comments === 0 ? 'COMMENTS' : `COMMENTS (${comments})`, false, false, true, buttonH)) { this.openComments(); return; }
    y += step;
    const bookmarks = session.bookmarks.bookmarks.length;
    if (w.menuButton(f, leftX, y, leftW, bookmarks === 0 ? 'BOOKMARKS' : `BOOKMARKS (${bookmarks})`, false, false, true, buttonH)) { this.openBookmarks(); return; }
    y += step;
    if (hiddenThings > 0) {
      if (w.menuButton(f, leftX, y, leftW, `SHOW ALL (${hiddenThings} HIDDEN)`, false, false, true, buttonH)) { session.showAll(); }
      y += step;
    }
    if (w.menuButton(f, leftX, y, leftW, 'CLEAR MARKERS', false, false, true, buttonH)) {
      // Every gun's markers except comments (persistent: use X with the Comment gun)
      for (const gun of session.guns) { if (gun !== session.commentGun) { gun.clearMarkers(); } }
      session.toast('Markers cleared (comments are kept)');
    }

    if (w.menuButton(f, leftX, endY, leftW, 'CLOSE MODEL', false, true)) { session.ended = true; return; }

    // ---- Middle: geometry toggles
    if (midW > this.s(300)) { this.buildCategoryCards(f, midX, pad, midW); }

    // ---- Right: world and display
    this.buildDisplayCard(f, rightX, pad, rightW);

    const scene = session.scene;
    const journal = session.document.journal.count;
    ui.textRight(f.small, width - this.s(56), height - this.s(28),
      `${session.document.name} · ${scene.elements.length.toLocaleString('en')} elements · ${(scene.geometry.indices.length / 3).toLocaleString('en')} tris · ${journal} ${journal === 1 ? 'edit' : 'edits'}`,
      UiTheme.TEXT_FAINT, this.s(0.5));
  }

  private buildCategoryCards(f: FontAtlas, x: number, top: number, width: number): void {
    const session = this.session, ui = session.ui, w = this.w, input = session.input;
    const scene = session.scene;
    ui.text(f.small, x, top + this.s(2), 'GEOMETRY', UiTheme.TEXT_MUTED, this.s(1.8));
    const cardTop = top + this.s(26), gap = this.s(14);
    const cardW = (width - gap * 2) / 3, row = this.s(22);
    let changed = false, tallest = 0;

    for (let g = 0; g < 3; g++) {
      const group = g as CategoryGroup;
      const cx = x + g * (cardW + gap);
      const defs = CATEGORIES.filter(d => d.group === group);
      const loaded = defs.filter(d => scene.categoryLoaded[d.index]).length;
      const visible = defs.filter(d => scene.categoryLoaded[d.index] && session.categoryVisible[d.index]).length;

      const cardH = this.s(52) + defs.length * row;
      tallest = Math.max(tallest, cardH);
      ui.panel(cx, cardTop, cardW, cardH, UiTheme.CARD, UiTheme.CARD_BORDER);

      // Header: clicking the group name toggles every loaded category in it
      const headerY = cardTop + this.s(12);
      const headerHover = loaded > 0 && w.hover(cx, cardTop, cardW, this.s(40));
      ui.text(f.bold, cx + this.s(14), headerY, GROUP_NAMES[g].toUpperCase(), headerHover ? UiTheme.ACCENT : UiTheme.TEXT, this.s(1.2));
      const tag = loaded === 0 ? 'NOT LOADED' : loaded === defs.length ? 'LOADED' : 'PARTIAL';
      ui.textRight(f.small, cx + cardW - this.s(14), headerY + this.s(3), tag, loaded === 0 ? UiTheme.TEXT_MUTED : UiTheme.GOOD, this.s(0.8));
      ui.rect(cx + this.s(14), cardTop + this.s(40), cardW - this.s(28), Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.1));
      if (headerHover && input.leftPressed) {
        const show = visible === 0;
        for (const d of defs) { if (scene.categoryLoaded[d.index]) { session.categoryVisible[d.index] = show; } }
        changed = true;
      }

      let ry = cardTop + this.s(48);
      for (const def of defs) {
        const enabled = scene.categoryLoaded[def.index];
        const on = enabled && session.categoryVisible[def.index];
        const hover = enabled && w.hover(cx + this.s(8), ry - this.s(3), cardW - this.s(16), row);
        const alpha = enabled ? 1 : 0.4;
        const box = this.s(14), bx = cx + this.s(14), by = ry + this.s(1);
        ui.rect(bx, by, box, box, on ? UiTheme.ACCENT : Rgba.withAlpha(UiTheme.CONTROL, alpha));
        ui.outline(bx, by, box, box, Math.max(1, ui.scale), Rgba.withAlpha(on ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER, alpha));
        if (on) { w.tick(bx, by, box, UiTheme.SCAN_TAG_TEXT); }
        ui.textWrapped(f.body, bx + box + this.s(10), ry, cardW - this.s(90), def.label, Rgba.withAlpha(hover ? UiTheme.ACCENT : UiTheme.TEXT, alpha), 1);
        ui.textRight(f.mono, cx + cardW - this.s(14), ry + this.s(1), enabled ? scene.categoryElementCounts[def.index].toLocaleString('en') : '—',
          Rgba.withAlpha(UiTheme.TEXT_FAINT, alpha));
        if (hover && input.leftPressed) {
          session.categoryVisible[def.index] = !session.categoryVisible[def.index];
          changed = true;
        }
        ry += row;
      }
    }

    ui.text(f.body, x, cardTop + tallest + this.s(12),
      'Categories not in this file are greyed out. Export again from Revit with them ticked to include them.', UiTheme.TEXT_MUTED);
    if (scene.links.length > 0 && this.buildLinkCard(f, x, cardTop + tallest + this.s(48), width)) { changed = true; }

    if (changed) {
      session.refreshMasks();
      session.sound.play(SoundId.UiClick);
    }
  }

  private buildLinkCard(f: FontAtlas, x: number, top: number, width: number): boolean {
    const session = this.session, ui = session.ui, w = this.w, input = session.input;
    const links = session.scene.links;
    const row = this.s(22);
    const fit = Math.max(1, Math.trunc((session.screenHeight - this.s(48) - top - this.s(70)) / row));
    const rows = Math.min(links.length, fit);
    let changed = false;

    ui.text(f.small, x, top + this.s(2), 'LINKED MODELS (READ-ONLY)', UiTheme.TEXT_MUTED, this.s(1.8));
    const cardTop = top + this.s(26);
    ui.panel(x, cardTop, width, this.s(20) + rows * row + (rows < links.length ? row : 0), UiTheme.CARD, UiTheme.CARD_BORDER);

    let ry = cardTop + this.s(10);
    for (let i = 0; i < rows; i++) {
      const link = links[i];
      const on = session.linkVisible[i + 1];
      const hover = w.hover(x + this.s(8), ry - this.s(3), width - this.s(16), row);
      const box = this.s(14), bx = x + this.s(14), by = ry + this.s(1);
      ui.rect(bx, by, box, box, on ? UiTheme.ACCENT : UiTheme.CONTROL);
      ui.outline(bx, by, box, box, Math.max(1, ui.scale), on ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
      if (on) { w.tick(bx, by, box, UiTheme.SCAN_TAG_TEXT); }
      ui.textWrapped(f.body, bx + box + this.s(10), ry, width - this.s(130), linkLabel(link), hover ? UiTheme.ACCENT : UiTheme.TEXT, 1);
      ui.textRight(f.mono, x + width - this.s(14), ry + this.s(1), link.elementCount.toLocaleString('en'), UiTheme.TEXT_FAINT);
      if (hover && input.leftPressed) {
        session.linkVisible[i + 1] = !on;
        changed = true;
      }
      ry += row;
    }
    if (rows < links.length) {
      ui.text(f.body, x + this.s(14), ry, `+${links.length - rows} more (make the window taller to list them)`, UiTheme.TEXT_MUTED);
    }
    return changed;
  }

  private buildDisplayCard(f: FontAtlas, x: number, top: number, width: number): void {
    const session = this.session, ui = session.ui, w = this.w;
    const settings = session.settings;
    ui.text(f.small, x, top + this.s(2), 'WORLD & DISPLAY', UiTheme.TEXT_MUTED, this.s(1.8));
    const cardTop = top + this.s(26);
    ui.panel(x, cardTop, width, this.s(440), UiTheme.CARD, UiTheme.CARD_BORDER);

    const ix = x + this.s(14), iw = width - this.s(28);
    let y = cardTop + this.s(14);

    // Ground plane (relative to the default, shown absolute)
    const ground = w.slider(f, 0, ix, y, iw, 'Ground plane', session.text.clear().appendNumber(session.groundZ, 3).append(' m').text,
      session.groundZ, session.groundDefault - 10, session.groundDefault + 10);
    // Snap only while dragging (the desktop snaps every frame, which nudged the exact default on opening the menu)
    if (w.activeSlider === 0) { session.groundZ = Math.round(ground / 0.05) * 0.05; }
    y += this.s(58);

    // Colour mode
    ui.text(f.body, ix, y, 'Colour mode', UiTheme.TEXT);
    const colour = w.segmented(f, ix, y + this.s(22), iw, COLOUR_OPTIONS, settings.colour);
    if (colour !== settings.colour) {
      settings.colour = colour;
      settings.save();
      if (colour === ColourMode.Realistic) {
        session.toast('Realistic materials come to the web viewer in a later update: material colours are shown meanwhile.', 5);
      }
    }
    y += this.s(64);

    // FOV and sensitivity
    const fov = w.slider(f, 1, ix, y, iw, 'Field of view', `${Math.round(settings.fieldOfView)}°`, settings.fieldOfView, 60, 120);
    if (Math.round(fov) !== settings.fieldOfView) { settings.fieldOfView = Math.round(fov); settings.save(); }
    y += this.s(58);
    const sensitivity = Math.round(w.slider(f, 2, ix, y, iw, 'Mouse sensitivity', settings.mouseSensitivity.toFixed(2),
      settings.mouseSensitivity, 0.1, 3) / 0.05) * 0.05;
    if (Math.abs(sensitivity - settings.mouseSensitivity) > 1e-6) { settings.mouseSensitivity = sensitivity; settings.save(); }
    y += this.s(62);

    // Toggles
    const invertY = w.checkbox(f, ix, y, iw, 'Invert Y', settings.invertY);
    if (invertY !== settings.invertY) { settings.invertY = invertY; settings.save(); }
    y += this.s(28);
    const showFps = w.checkbox(f, ix, y, iw, 'Show FPS', settings.showFps);
    if (showFps !== settings.showFps) { settings.showFps = showFps; settings.save(); }
    y += this.s(28);
    const ao = w.checkbox(f, ix, y, iw, 'Ambient occlusion', settings.ambientOcclusion);
    if (ao !== settings.ambientOcclusion) { settings.ambientOcclusion = ao; settings.save(); }
    y += this.s(40);

    // Author name for comments and bookmarks (the browser has no user name)
    ui.text(f.body, ix, y, 'Your name (comments)', UiTheme.TEXT_MUTED);
    if (w.smallButton(f, ix + iw - this.s(90), y - this.s(4), this.s(90), this.s(26), 'CHANGE')) { session.editor.renameUser(); return; }
    y += this.s(24);
    ui.textWrapped(f.bold, ix, y, iw, settings.userName, UiTheme.TEXT, 1);
  }

  // #endregion

  // #region Comments list

  private openComments(): void {
    const session = this.session;
    this.commentsOpen = true;
    this.commentScroll = 0;
    this.commentDeleteArmed = null;
    this.commentsNotice = null;
    const level = session.scene.levels.length > 0 ? session.levelIndexAt(session.player.feet.z) : -1;
    this.commentLevelFilter = level >= 0 && this.countCommentsOn(level) > 0 ? level : -1;
  }

  private buildCommentsPanel(): void {
    const session = this.session, ui = session.ui, f = ui.atlas, w = this.w;
    const width = session.screenWidth, height = session.screenHeight;
    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    const pw = Math.min(this.s(920), width - this.s(80)), ph = height - this.s(96);
    const x = (width - pw) * 0.5, y = this.s(48);
    ui.panel(x, y, pw, ph, UiTheme.CARD, UiTheme.CARD_BORDER);

    const ix = x + this.s(24), iw = pw - this.s(48);
    let cy = y + this.s(20);
    const count = session.comments.comments.length;
    ui.text(f.small, ix, cy, 'COMMENTS', UiTheme.COMMENT_LABEL, this.s(2));
    ui.textRight(f.small, ix + iw, cy, `${count.toLocaleString('en')} ${count === 1 ? 'comment' : 'comments'} · kept in ${session.comments.fileName}`, UiTheme.TEXT_MUTED, this.s(0.6));
    cy += this.s(30);

    // Level filter: ← All levels / Level name →
    if (session.scene.levels.length > 0) {
      if (w.smallButton(f, ix, cy, this.s(32), this.s(28), '←')) { this.stepCommentFilter(-1); }
      ui.panel(ix + this.s(38), cy, this.s(260), this.s(28), UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
      ui.textCentred(f.body, ix + this.s(38) + this.s(130), cy + this.s(14) - f.body.lineHeight * 0.5, this.commentFilterLabel(), UiTheme.TEXT);
      if (w.smallButton(f, ix + this.s(304), cy, this.s(32), this.s(28), '→')) { this.stepCommentFilter(+1); }
      cy += this.s(40);
    }

    const buttonsY = y + ph - this.s(24) - this.s(48);
    this.buildCommentRows(f, ix, cy, iw, buttonsY - this.s(16));

    if (this.commentsNotice) { ui.textWrapped(f.body, ix, buttonsY - this.s(30), iw, this.commentsNotice, UiTheme.MEASURE_TEXT, 1); }
    if (w.menuButton(f, ix, buttonsY, this.s(200), 'EXPORT CSV…', false, false, count > 0)) {
      session.exportComments();
      this.commentsNotice = `Exported ${count} comments (your Downloads folder)`;
      session.sound.play(SoundId.Commit);
    }
    if (w.menuButton(f, ix + this.s(216), buttonsY, this.s(160), 'CLOSE', false, false)) { this.closePanels(); }
  }

  private buildCommentRows(f: FontAtlas, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, w = this.w, input = session.input;
    const rowH = this.s(64);
    const visible = Math.max(1, Math.trunc((bottom - y) / rowH));
    const list = session.comments.comments.filter(r => this.matchesCommentFilter(r));

    if (list.length === 0) {
      ui.textWrapped(f.body, x, y + this.s(8), width, session.comments.comments.length === 0
        ? 'No comments yet. Use the Comment tool (4): LMB places a marker and opens a text box.'
        : 'No comments on this level. Use ← → to pick another level or all levels.', UiTheme.TEXT_MUTED, 2);
      return;
    }

    const maxScroll = Math.max(0, list.length - visible);
    if (input.wheel !== 0) { this.commentScroll -= input.wheel * 2; }
    this.commentScroll = Math.min(Math.max(this.commentScroll, 0), maxScroll);
    if (this.commentDeleteArmed && session.clock > this.commentDeleteArmedUntil) { this.commentDeleteArmed = null; }

    let go: CommentRecord | null = null, edit: CommentRecord | null = null, remove: CommentRecord | null = null;
    const buttonsW = this.s(66) * 3 + this.s(12);
    const last = Math.min(list.length, this.commentScroll + visible);
    for (let i = this.commentScroll; i < last; i++) {
      const record = list[i];
      const ry = y + (i - this.commentScroll) * rowH;
      if (((i - this.commentScroll) & 1) === 0) { ui.rect(x - this.s(8), ry - this.s(4), width + this.s(16), rowH - this.s(4), Rgba.hex(0xffffff, 0.03)); }

      const textW = width - buttonsW - this.s(16);
      ui.textWrapped(f.small, x, ry + this.s(2), textW, record.level ? `${record.header} · ${record.level}` : record.header, UiTheme.COMMENT_LABEL, 1);
      ui.textWrapped(f.body, x, ry + this.s(20), textW, record.text, UiTheme.TEXT, 2);

      const bx = x + width - buttonsW;
      if (w.smallButton(f, bx, ry + this.s(8), this.s(66), this.s(30), 'GO')) { go = record; }
      if (w.smallButton(f, bx + this.s(72), ry + this.s(8), this.s(66), this.s(30), 'EDIT')) { edit = record; }
      const armed = this.commentDeleteArmed === record;
      if (w.smallButton(f, bx + this.s(144), ry + this.s(8), this.s(66), this.s(30), armed ? 'SURE?' : 'DELETE', true)) { remove = record; }
    }
    if (maxScroll > 0) {
      ui.textRight(f.small, x + width, bottom + this.s(2), `${this.commentScroll + 1}–${last} of ${list.length} · wheel to scroll`, UiTheme.TEXT_FAINT);
    }

    // Act after drawing (the list must not change while it is being walked)
    if (go) {
      this.closePanels();
      session.setPaused(false);
      session.teleportToComment(go);
      session.selectGun(session.guns.indexOf(session.commentGun));
      session.toast(go.text.length > 60 ? go.text.slice(0, 57) + '…' : go.text, 3);
    } else if (edit) {
      this.closePanels();
      session.paused = false;
      session.teleportToComment(edit);
      session.editComment(edit);
    } else if (remove) {
      if (this.commentDeleteArmed === remove) {
        session.comments.remove(remove);
        this.commentDeleteArmed = null;
        this.commentsNotice = 'Comment deleted';
        session.sound.play(SoundId.Remove);
      } else {
        this.commentDeleteArmed = remove;
        this.commentDeleteArmedUntil = session.clock + 3;
      }
    }
  }

  private stepCommentFilter(direction: number): void {
    const count = this.session.scene.levels.length + 1; // + "all"
    const current = this.commentLevelFilter + 1;
    this.commentLevelFilter = ((current + direction) % count + count) % count - 1;
    this.commentScroll = 0;
    this.commentDeleteArmed = null;
  }

  private matchesCommentFilter(record: CommentRecord): boolean {
    const levels = this.session.scene.levels;
    if (this.commentLevelFilter < 0 || this.commentLevelFilter >= levels.length) { return true; }
    return record.level === levels[this.commentLevelFilter].name;
  }

  private countCommentsOn(level: number): number {
    const name = this.session.scene.levels[level].name;
    return this.session.comments.comments.filter(r => r.level === name).length;
  }

  private commentFilterLabel(): string {
    const all = this.session.comments.comments.length;
    return this.commentLevelFilter < 0 ? `All levels (${all})`
      : `${this.session.scene.levels[this.commentLevelFilter].name} (${this.countCommentsOn(this.commentLevelFilter)})`;
  }

  // #endregion

  // #region Bookmarks list

  private openBookmarks(): void {
    this.bookmarksOpen = true;
    this.bookmarkScroll = 0;
    this.bookmarkDeleteArmed = null;
    this.bookmarksNotice = null;
  }

  private buildBookmarksPanel(): void {
    const session = this.session, ui = session.ui, f = ui.atlas, w = this.w;
    const width = session.screenWidth, height = session.screenHeight;
    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    const pw = Math.min(this.s(920), width - this.s(80)), ph = height - this.s(96);
    const x = (width - pw) * 0.5, y = this.s(48);
    ui.panel(x, y, pw, ph, UiTheme.CARD, UiTheme.CARD_BORDER);

    const ix = x + this.s(24), iw = pw - this.s(48);
    let cy = y + this.s(20);
    const count = session.bookmarks.bookmarks.length;
    ui.text(f.small, ix, cy, 'BOOKMARKS', UiTheme.BOOKMARK_LABEL, this.s(2));
    ui.textRight(f.small, ix + iw, cy, `${count.toLocaleString('en')} ${count === 1 ? 'viewpoint' : 'viewpoints'} · kept in ${session.bookmarks.fileName}`, UiTheme.TEXT_MUTED, this.s(0.6));
    cy += this.s(30);
    ui.text(f.body, ix, cy, 'B saves where you stand · ALT+1–9 jump to the first nine', UiTheme.TEXT_MUTED);
    cy += this.s(34);

    const buttonsY = y + ph - this.s(24) - this.s(48);
    this.buildBookmarkRows(f, ix, cy, iw, buttonsY - this.s(16));

    if (this.bookmarksNotice) { ui.textWrapped(f.body, ix, buttonsY - this.s(30), iw, this.bookmarksNotice, UiTheme.MEASURE_TEXT, 1); }
    if (w.menuButton(f, ix, buttonsY, this.s(240), 'ADD THIS VIEW', false, false)) {
      const added = session.addBookmarkFromMenu();
      this.bookmarksNotice = `Added “${added.name}” (RENAME to change it)`;
      this.bookmarkScroll = session.bookmarks.bookmarks.length;
    }
    if (w.menuButton(f, ix + this.s(256), buttonsY, this.s(160), 'CLOSE', false, false)) { this.closePanels(); }
  }

  private buildBookmarkRows(f: FontAtlas, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, w = this.w, input = session.input;
    const list = session.bookmarks.bookmarks;
    const rowH = this.s(70);
    const visible = Math.max(1, Math.trunc((bottom - y) / rowH));

    if (list.length === 0) {
      ui.textWrapped(f.body, x, y + this.s(8), width, 'No bookmarks yet. Resume, stand where you want and press B (or use ADD THIS VIEW below).', UiTheme.TEXT_MUTED, 2);
      return;
    }

    const maxScroll = Math.max(0, list.length - visible);
    if (input.wheel !== 0) { this.bookmarkScroll -= input.wheel * 2; }
    this.bookmarkScroll = Math.min(Math.max(this.bookmarkScroll, 0), maxScroll);
    if (this.bookmarkDeleteArmed && session.clock > this.bookmarkDeleteArmedUntil) { this.bookmarkDeleteArmed = null; }

    let go: BookmarkRecord | null = null, rename: BookmarkRecord | null = null, here: BookmarkRecord | null = null;
    let up: BookmarkRecord | null = null, down: BookmarkRecord | null = null, remove: BookmarkRecord | null = null;
    const small = this.s(34), wide = this.s(84), gap = this.s(6);
    const buttonsW = wide * 4 + small * 2 + gap * 5;
    const last = Math.min(list.length, this.bookmarkScroll + visible);
    for (let i = this.bookmarkScroll; i < last; i++) {
      const record = list[i];
      const ry = y + (i - this.bookmarkScroll) * rowH;
      if (((i - this.bookmarkScroll) & 1) === 0) { ui.rect(x - this.s(8), ry - this.s(4), width + this.s(16), rowH - this.s(4), Rgba.hex(0xffffff, 0.03)); }

      // Number (Alt+n for the first nine), thumbnail, name, then "Level · author · date"
      ui.text(f.mono, x, ry + this.s(4), String(i + 1), i < 9 ? UiTheme.BOOKMARK_LABEL : UiTheme.TEXT_FAINT);
      const thumbX = x + this.s(30), thumbW = this.s(110), thumbH = this.s(62);
      const thumbnail = session.thumbnailTexture(record);
      if (thumbnail) {
        ui.image(thumbnail, thumbX, ry, thumbW, thumbH, session.screenWidth, session.screenHeight);
        ui.outline(thumbX, ry, thumbW, thumbH, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.15));
      } else {
        ui.panel(thumbX, ry, thumbW, thumbH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
        ui.textCentred(f.small, thumbX + thumbW * 0.5, ry + thumbH * 0.5 - this.s(7), record.thumbnail ? '…' : 'NO PICTURE', UiTheme.TEXT_FAINT, this.s(0.4));
      }
      const textX = thumbX + thumbW + this.s(14);
      const textW = width - buttonsW - this.s(46) - thumbW - this.s(14);
      ui.textWrapped(f.bold, textX, ry + this.s(10), textW, record.name, UiTheme.TEXT, 1);
      ui.textWrapped(f.small, textX, ry + this.s(34), textW, record.detail, UiTheme.TEXT_MUTED, 1);

      let bx = x + width - buttonsW;
      const by = ry + this.s(14), bh = this.s(30);
      if (w.smallButton(f, bx, by, wide, bh, 'GO')) { go = record; }
      bx += wide + gap;
      if (w.smallButton(f, bx, by, wide, bh, 'RENAME')) { rename = record; }
      bx += wide + gap;
      if (w.smallButton(f, bx, by, wide, bh, 'SET HERE')) { here = record; }
      bx += wide + gap;
      if (w.smallButton(f, bx, by, small, bh, '↑') && i > 0) { up = record; }
      bx += small + gap;
      if (w.smallButton(f, bx, by, small, bh, '↓') && i < list.length - 1) { down = record; }
      bx += small + gap;
      const armed = this.bookmarkDeleteArmed === record;
      if (w.smallButton(f, bx, by, wide, bh, armed ? 'SURE?' : 'DELETE', true)) { remove = record; }
    }
    if (maxScroll > 0) {
      ui.textRight(f.small, x + width, bottom + this.s(2), `${this.bookmarkScroll + 1}–${last} of ${list.length} · wheel to scroll`, UiTheme.TEXT_FAINT);
    }

    // Act after drawing (the list must not change while it is being walked)
    if (go) {
      this.closePanels();
      session.setPaused(false);
      session.goToBookmark(go);
    } else if (rename) {
      this.closePanels();
      session.paused = false;
      session.editor.renameBookmark(rename, false);
    } else if (here) {
      session.setBookmarkHere(here);
      this.bookmarksNotice = `“${here.name}” now points at where you are`;
    } else if (up || down) {
      session.bookmarks.move((up ?? down)!, up ? -1 : 1);
    } else if (remove) {
      if (this.bookmarkDeleteArmed === remove) {
        session.bookmarks.remove(remove);
        this.bookmarkDeleteArmed = null;
        this.bookmarksNotice = `Deleted “${remove.name}”`;
        session.sound.play(SoundId.Remove);
      } else {
        this.bookmarkDeleteArmed = remove;
        this.bookmarkDeleteArmedUntil = session.clock + 3;
      }
    }
  }

  // #endregion
}

type EditMode = 'comment' | 'bookmark' | 'user';

/**
 * The text box for comments, bookmark names and the author name (port of the Comment editor region of
 * GameSession.Menu.cs). The mouse is released while typing so Esc reaches the page (it cancels).
 */
export class TextEditor {
  active = false;
  point: Vec3 = vec3();
  private text = '';
  private max = 280;
  private mode: EditMode = 'comment';
  private elementId = -1;
  private level: string | null = null;
  private record: CommentRecord | null = null;
  private bookmark: BookmarkRecord | null = null;
  private bookmarkIsNew = false;
  private resumeMenuAfter = false;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  beginComment(point: Vec3, elementId: number, level: string): void {
    this.start('comment', 280, '');
    this.point = point;
    this.elementId = elementId;
    this.level = level;
  }

  editComment(record: CommentRecord): void {
    this.start('comment', 280, record.text.slice(0, 280));
    this.record = record;
    this.point = record.local;
    this.elementId = record.elementId;
    this.level = record.level || null;
  }

  renameBookmark(record: BookmarkRecord, isNew: boolean): void {
    this.start('bookmark', BookmarkStore.MAX_NAME, record.name.slice(0, BookmarkStore.MAX_NAME));
    this.bookmark = record;
    this.bookmarkIsNew = isNew;
    this.level = record.level || null;
  }

  /** The author name (from the pause menu; returns there afterwards). */
  renameUser(): void {
    this.start('user', 40, this.session.settings.userName);
    this.resumeMenuAfter = true;
    this.session.paused = false;
  }

  private start(mode: EditMode, max: number, text: string): void {
    this.active = true;
    this.mode = mode;
    this.max = max;
    this.text = text;
    this.record = null;
    this.bookmark = null;
    this.resumeMenuAfter = false;
    this.session.releaseMouseForTyping();
  }

  update(input: InputState): void {
    if (input.isPressed(Vk.ESCAPE)) {
      this.cancel();
      return;
    }
    if (input.isPressed(Vk.RETURN)) {
      this.commit();
      return;
    }
    if (input.isPressedOrRepeated(Vk.BACK) && this.text.length > 0) { this.text = this.text.slice(0, -1); }
    for (const c of input.typed) {
      if (c >= ' ' && this.text.length < this.max) { this.text += c; }
    }
  }

  private finish(): void {
    this.active = false;
    this.record = null;
    this.bookmark = null;
    if (this.resumeMenuAfter) { this.session.paused = true; }
  }

  private cancel(): void {
    const session = this.session;
    if (this.mode === 'bookmark') {
      if (this.bookmarkIsNew && session.thumbnailFor === this.bookmark) { session.thumbnailFor = null; }
      session.toast(this.bookmarkIsNew ? 'Bookmark cancelled (nothing was saved)' : 'Name not changed');
    } else if (this.mode === 'comment') {
      session.toast(this.record ? 'Edit cancelled' : 'Comment cancelled');
    }
    this.finish();
  }

  private commit(): void {
    const session = this.session;
    const text = this.text.trim();
    const { mode, record, bookmark } = this;
    this.finish();

    if (mode === 'user') {
      if (text) {
        session.settings.userName = text;
        session.settings.save();
        setCurrentUser(text);
      }
      return;
    }

    if (bookmark) {
      // A new bookmark joins the list only now (Esc discarded it); an existing one is renamed
      if (this.bookmarkIsNew) { session.bookmarks.addPending(bookmark, text); }
      else if (text) { session.bookmarks.rename(bookmark, text); }
      session.sound.play(SoundId.Commit);
      session.toast(`${this.bookmarkIsNew ? 'Bookmarked' : 'Renamed to'} “${bookmark.name}” (${session.bookmarkHotkey(bookmark)})`);
      return;
    }

    if (record) {
      if (!text) {
        session.toast('The text is empty, so the comment was not changed (RMB on the marker deletes it)');
        return;
      }
      session.comments.update(record, text);
      session.sound.play(SoundId.CommentPlace);
      session.toast('Comment updated');
      return;
    }

    if (!text) {
      session.toast('Empty comment not saved');
      return;
    }
    session.comments.add(this.point, text, this.elementId, this.level);
    session.sound.play(SoundId.CommentPlace);
    session.toast(`Comment added (kept in ${session.comments.fileName})`);
  }

  build(): void {
    const session = this.session, ui = session.ui, f = ui.atlas;
    const w = this.s(460);
    const textHeight = Math.max(f.body.lineHeight * 1.15, ui.textWrapped(f.body, 0, 0, w - this.s(48), this.text, 0, 10, false));
    const h = this.s(96) + textHeight;
    const x = session.screenWidth * 0.5 - w * 0.5, y = session.screenHeight * 0.5 + this.s(48);

    const naming = this.mode !== 'comment';
    const frame = naming ? UiTheme.BOOKMARK : UiTheme.COMMENT;
    const label = naming ? UiTheme.BOOKMARK_LABEL : UiTheme.COMMENT_LABEL;
    ui.panel(x, y, w, h, UiTheme.PANEL_STRONG, frame);
    const title = this.mode === 'user' ? 'YOUR NAME (SHOWN ON COMMENTS)'
      : `${this.mode === 'bookmark' ? 'BOOKMARK NAME' : this.record ? 'EDIT COMMENT' : 'NEW COMMENT'} · ${this.level ?? '—'}`;
    ui.text(f.small, x + this.s(14), y + this.s(12), title, label, this.s(1));

    const boxY = y + this.s(32), boxH = textHeight + this.s(16);
    ui.panel(x + this.s(14), boxY, w - this.s(28), boxH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
    ui.textWrapped(f.body, x + this.s(24), boxY + this.s(8), w - this.s(48), this.text, UiTheme.TEXT, 10);

    // Caret at the end of the last line (blinking)
    if (session.clock % 1 < 0.55) {
      const { caretX, line } = this.caret(f.body, w - this.s(48));
      ui.rect(x + this.s(24) + caretX + this.s(1), boxY + this.s(8) + line * f.body.lineHeight * 1.15 + this.s(2), this.s(1.5), f.body.lineHeight - this.s(2), label);
    }

    ui.text(f.body, x + this.s(14), y + h - this.s(26),
      this.mode === 'bookmark' && this.bookmarkIsNew ? 'ENTER save the bookmark · ESC cancel it' : 'ENTER save · ESC cancel', UiTheme.TEXT_MUTED);
    ui.textRight(f.mono, x + w - this.s(14), y + h - this.s(25), `${this.text.length} / ${this.max}`, UiTheme.TEXT_MUTED);
  }

  private caret(font: UiFont, maxWidth: number): { caretX: number; line: number } {
    const { lines, lastWidth } = UiBatch.wrapEnd(font, maxWidth, this.text, 10);
    return { caretX: Math.min(lastWidth, maxWidth), line: Math.max(lines - 1, 0) };
  }
}
