import { type BookmarkRecord, CommentPriority, type CommentRecord, type CommentReply, CommentStatus } from '../core/format/DocumentModels';
import { setCurrentUser } from '../core/format/DocumentModels';
import { type Vec3, vec3 } from '../core/math/Vector';
import { CATEGORIES, CategoryGroup, GROUP_NAMES } from '../core/scene/CategoryCatalog';
import { linkLabel } from '../core/scene/LinkInfo';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas, UiFont } from '../engine/ui/UiFont';
import { statusColour, UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import { QualityProfile, QualityProfiles } from './QualityProfiles';
import { LibraryPanel } from './LibraryPanel';
import { RoomFinder } from './RoomFinder';
import { BookmarkStore, shortDate } from './Stores';
import { ColourMode } from './ViewerSettings';

const COLOUR_OPTIONS = ['Whitecard', 'Material', 'Realistic'];
const STATUS_FILTERS = ['All', 'Open', 'In progress', 'Closed'];
const STATUS_OPTIONS = ['Open', 'In progress', 'Closed'];
const PRIORITY_OPTIONS = ['Low', 'Normal', 'High'];
/** Reflections: off, some (shine tiers 50 % +), or all (25 % +). */
const REFLECTION_OPTIONS = ['Off', 'Some', 'All'];
/** Reflection source: the sky, probes, or probes at 256 px. */
const SOURCE_OPTIONS = ['Sky', 'Probes', 'Probes HQ'];
/** Debug colours: off, reflection tiers, reflection probe cells. */
const DEBUG_OPTIONS = ['Off', 'Reflection', 'Probes'];
/** The pause menu's right-column tabs. */
const RIGHT_TABS = ['DISPLAY', 'REFLECTIONS', 'DEBUG'];
/** Height of the right column's card (unscaled): fits the Display tab, the tallest. */
const RIGHT_CARD_HEIGHT = 440;
/** Slider id of the reflection strength (unique across the menu's sliders). */
const SLIDER_REFLECT = 17;
/** Longest assignee name. */
const MAX_ASSIGNEE = 60;

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

  /** A row of tabs (text with an accent underline on the open one); returns the open tab (changed by a click). */
  tabs(f: FontAtlas, x: number, y: number, w: number, labels: string[], selected: number): number {
    const ui = this.ui;
    const h = this.s(28), tab = w / labels.length;
    ui.rect(x, y + h - Math.max(1, ui.scale), w, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.12));
    labels.forEach((label, i) => {
      const tx = x + i * tab, on = i === selected;
      const hover = !on && this.hover(tx, y, tab, h);
      ui.textCentred(f.small, tx + tab * 0.5, y + this.s(7), label, on ? UiTheme.TEXT : hover ? UiTheme.ACCENT : UiTheme.TEXT_MUTED, this.s(1.4));
      if (on) { ui.rect(tx + this.s(6), y + h - this.s(2), tab - this.s(12), this.s(2), UiTheme.ACCENT); }
      if (hover && this.input.leftPressed) {
        selected = i;
        this.session.sound.play(SoundId.UiClick);
      }
    });
    return selected;
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
  private commentStatusFilter = 0; // 0 all, 1 open, 2 in progress, 3 closed
  /** The comment shown in full (null = the list). */
  private commentDetail: CommentRecord | null = null;
  private replyScroll = 0;
  private replyDeleteArmed: CommentReply | null = null;
  private replyDeleteArmedUntil = 0;
  /** Open right-column tab: 0 display, 1 reflections, 2 debug (per session). */
  private rightTab = 0;
  private bookmarksOpen = false;
  private bookmarkScroll = 0;
  private bookmarkDeleteArmed: BookmarkRecord | null = null;
  private bookmarkDeleteArmedUntil = 0;
  private bookmarksNotice: string | null = null;

  /** FIND ROOM (Ctrl+F). */
  readonly rooms: RoomFinder;
  /** FAMILY LIBRARY (Place gun). */
  readonly library: LibraryPanel;

  constructor(private readonly session: GameSession) {
    this.w = new Widgets(session);
    this.rooms = new RoomFinder(session, this.w);
    this.library = new LibraryPanel(session, this.w);
    this.library.onPick = entry => session.pickFromLibrary(entry);
  }

  /** True while a panel with a search box has the keyboard (letters must not act as shortcuts, e.g. P). */
  get capturesTyping(): boolean {
    return this.session.paused && (this.rooms.open || this.library.open);
  }

  private s(v: number): number { return this.session.s(v); }

  /** Closes an open list (Esc); false when none was open. */
  closePanels(): boolean {
    if (this.session.textures?.close()) { return true; }
    if (this.rooms.close()) { return true; }
    if (this.library.close()) { return true; }
    if (this.commentsOpen && this.commentDetail) { this.commentDetail = null; return true; }
    if (this.commentsOpen) { this.commentsOpen = false; this.commentDeleteArmed = null; return true; }
    if (this.bookmarksOpen) { this.bookmarksOpen = false; this.bookmarkDeleteArmed = null; return true; }
    return false;
  }

  // #region Main menu

  build(): void {
    if (this.commentsOpen) { this.buildCommentsPanel(); return; }
    if (this.bookmarksOpen) { this.buildBookmarksPanel(); return; }
    if (this.session.textures?.open) { this.session.textures.build(); return; }
    if (this.rooms.open) { this.rooms.build(); return; }
    if (this.library.open) { this.library.build(); return; }

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
    const texturesButton = session.textures?.available ?? false;
    const roomsButton = session.scene.rooms.length > 0;
    const libraryButton = this.library.available;
    const buttons = 8 + (hiddenThings > 0 ? 1 : 0) + (texturesButton ? 1 : 0) + (roomsButton ? 1 : 0) + (libraryButton ? 1 : 0);
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
    if (texturesButton) {
      if (w.menuButton(f, leftX, y, leftW, session.textures.menuLabel(), false, false, true, buttonH)) { session.textures.show(); return; }
      y += step;
    }
    if (roomsButton) {
      if (w.menuButton(f, leftX, y, leftW, 'FIND ROOM', false, false, true, buttonH)) { this.rooms.show(); return; }
      y += step;
    }
    if (w.menuButton(f, leftX, y, leftW, 'SUN HOURS STUDY', false, false, true, buttonH)) { session.sunHours.show(); return; }
    y += step;
    if (libraryButton) {
      if (w.menuButton(f, leftX, y, leftW, this.library.menuLabel(), false, false, true, buttonH)) { this.library.show(); return; }
      y += step;
    }
    if (hiddenThings > 0) {
      if (w.menuButton(f, leftX, y, leftW, `SHOW ALL (${hiddenThings} HIDDEN)`, false, false, true, buttonH)) { session.showAll(); }
      y += step;
    }
    // Save in place (Chrome / Edge) or download; Save As picks a new file
    const half = (leftW - this.s(6)) / 2;
    if (w.menuButton(f, leftX, y, half, session.isDirty ? 'SAVE *' : 'SAVE', false, false, true, buttonH)) { void session.save(false); return; }
    if (w.menuButton(f, leftX + half + this.s(6), y, half, 'SAVE AS', false, false, true, buttonH)) { void session.save(true); return; }
    y += step;
    if (w.menuButton(f, leftX, y, leftW, 'CLEAR MARKERS', false, false, true, buttonH)) {
      // Every gun's markers except comments (persistent: use X with the Comment gun)
      for (const gun of session.guns) { if (gun !== session.commentGun) { gun.clearMarkers(); } }
      session.toast('Markers cleared (comments are kept)');
    }

    if (w.menuButton(f, leftX, endY, leftW, 'CLOSE MODEL', false, true)) { session.requestClose(); return; }

    // ---- Middle: geometry toggles
    if (midW > this.s(300)) { this.buildCategoryCards(f, midX, pad, midW); }

    // ---- Right: quality profile, then Display · Reflections · Debug
    this.buildRightColumn(f, rightX, pad, rightW);

    const scene = session.scene;
    const journal = session.journal.count;
    ui.textRight(f.small, width - this.s(56), height - this.s(28),
      `${session.document.name} · ${scene.elements.length.toLocaleString('en')} elements · ${(scene.geometry.indices.length / 3).toLocaleString('en')} tris · ${journal} ${journal === 1 ? 'edit' : 'edits'}${session.isDirty ? ' · unsaved changes (Ctrl+S)' : ''}`,
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

  /**
   * The right column: the quality profile (always visible), then the Display · Reflections · Debug tabs and the open
   * tab's card. One fixed card height so the column doesn't jump between tabs.
   */
  private buildRightColumn(f: FontAtlas, x: number, top: number, width: number): void {
    const session = this.session, ui = session.ui, w = this.w;

    // Quality profile: Basic / Medium / Realistic, or "Custom" once anything it sets was changed by hand
    const profile = QualityProfiles.detect(session.settings);
    ui.text(f.small, x, top + this.s(2), 'QUALITY PROFILE', UiTheme.TEXT_MUTED, this.s(1.8));
    if (profile === QualityProfile.Custom) { ui.textRight(f.small, x + width, top + this.s(2), 'CUSTOM', UiTheme.MEASURE_LABEL, this.s(1.2)); }
    const shown = profile === QualityProfile.Custom ? -1 : profile - 1;
    const picked = w.segmented(f, x, top + this.s(22), width, QualityProfiles.LABELS, shown);
    if (picked !== shown && picked >= 0) { session.reflections.applyProfile(QualityProfiles.PICKABLE[picked]); }

    // Tabs
    const tabsY = top + this.s(68);
    const tab = w.tabs(f, x, tabsY, width, RIGHT_TABS, this.rightTab);
    if (tab !== this.rightTab) {
      this.rightTab = tab;
      w.activeSlider = -1;
    }

    const cardTop = tabsY + this.s(32);
    ui.panel(x, cardTop, width, this.s(RIGHT_CARD_HEIGHT), UiTheme.CARD, UiTheme.CARD_BORDER);
    const ix = x + this.s(14), iw = width - this.s(28), y = cardTop + this.s(14);
    switch (this.rightTab) {
      case 1: this.buildReflectionsTab(f, ix, y, iw); break;
      case 2: this.buildDebugTab(f, ix, y, iw); break;
      default: this.buildDisplayTab(f, ix, y, iw); break;
    }
  }

  /** Display tab: ground plane, colour, FOV, sensitivity, toggles and the author name. */
  private buildDisplayTab(f: FontAtlas, ix: number, y: number, iw: number): void {
    const session = this.session, ui = session.ui, w = this.w;
    const settings = session.settings;

    // Ground plane (relative to the default, shown absolute); saved with the model like hidden elements
    const ground = w.slider(f, 0, ix, y, iw, 'Ground plane', session.text.clear().appendNumber(session.groundZ, 3).append(' m').text,
      session.groundZ, session.groundDefault - 10, session.groundDefault + 10);
    // Only while dragging (the default needn't sit on the 5 cm steps, and must not mark the file changed)
    const snapped = Math.round(ground / 0.05) * 0.05;
    if (w.activeSlider === 0 && snapped !== session.groundZ) {
      session.groundZ = snapped;
      session.visibilityChanged();
    }
    y += this.s(58);

    // Colour mode
    ui.text(f.body, ix, y, 'Colour mode', UiTheme.TEXT);
    const colour = w.segmented(f, ix, y + this.s(22), iw, COLOUR_OPTIONS, settings.colour);
    if (colour !== settings.colour) {
      settings.colour = colour;
      settings.save();
      if (colour === ColourMode.Realistic && !session.renderer.hasMaterials) {
        session.toast('No textures in this file: export again from Revit with “Extract materials and textures” ticked to see them.', 5);
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

  /** Reflections tab: Off / Some / All, the source (sky or probes), strength, probe status and REFRESH. */
  private buildReflectionsTab(f: FontAtlas, ix: number, y: number, iw: number): void {
    const session = this.session, ui = session.ui, w = this.w;
    const settings = session.settings;

    ui.text(f.body, ix, y, 'Reflections', UiTheme.TEXT);
    const level = !settings.reflections ? 0 : settings.reflectionThreshold <= 37 ? 2 : 1;
    const pickedLevel = w.segmented(f, ix, y + this.s(22), iw, REFLECTION_OPTIONS, level);
    if (pickedLevel !== level) {
      settings.reflections = pickedLevel > 0;
      if (pickedLevel > 0) { settings.reflectionThreshold = pickedLevel === 2 ? 25 : 50; }
      settings.save();
    }
    y += this.s(66);

    ui.text(f.body, ix, y, 'Source', UiTheme.TEXT);
    const source = !settings.reflectionProbes ? 0 : settings.probeResolution >= 192 ? 2 : 1;
    const pickedSource = w.segmented(f, ix, y + this.s(22), iw, SOURCE_OPTIONS, source);
    if (pickedSource !== source) {
      const probesWereOn = settings.reflectionProbes;
      settings.reflectionProbes = pickedSource > 0;
      if (pickedSource > 0) { settings.probeResolution = pickedSource === 2 ? 256 : 128; }
      settings.save();
      if (settings.reflectionProbes && !probesWereOn) { session.reflections.refresh(false); }
    }
    y += this.s(66);

    const strength = Math.round(w.slider(f, SLIDER_REFLECT, ix, y, iw, 'Reflection strength', `${Math.round(settings.reflectionStrength * 100)} %`,
      settings.reflectionStrength, 0.5, 2) / 0.05) * 0.05;
    if (Math.abs(strength - settings.reflectionStrength) > 1e-6) { settings.reflectionStrength = strength; settings.save(); }
    y += this.s(62);

    ui.textWrapped(f.body, ix, y + this.s(5), iw - this.s(110), session.reflections.status(), UiTheme.TEXT_SOFT, 2);
    if (w.smallButton(f, ix + iw - this.s(100), y, this.s(100), this.s(28), 'REFRESH')) { session.reflections.refresh(true); }
    y += this.s(54);

    ui.textWrapped(f.body, ix, y, iw,
      'Realistic colour mode. Some = shiny surfaces (50 %+), All = satin too (25 %+); glass and water always reflect. Probes capture each room with a reflective surface; the sky is cheaper.',
      UiTheme.TEXT_MUTED, 6);
  }

  /** Debug tab: colour surfaces by reflection tier or by reflection probe (not saved). */
  private buildDebugTab(f: FontAtlas, ix: number, y: number, iw: number): void {
    const session = this.session, ui = session.ui, w = this.w;
    ui.text(f.body, ix, y, 'Debug colours', UiTheme.TEXT);
    const debug = w.segmented(f, ix, y + this.s(22), iw, DEBUG_OPTIONS, session.reflections.debug);
    if (debug !== session.reflections.debug) {
      session.reflections.debug = debug;
      if (debug !== 0 && (session.settings.colour !== ColourMode.Realistic || !session.renderer.hasMaterials)) {
        session.toast('Debug colours need the Realistic colour mode and a file with materials.', 4);
      }
    }
    y += this.s(66);

    const help = session.reflections.debug === 1 ? 'Reflection: red 75 %+, orange 50 %, yellow 25 %, grey none, cyan glass, blue water.'
      : session.reflections.debug === 2 ? 'Probes: one colour per reflection probe, blended at room edges; grey = sky. Probes bake as you look around.'
        : 'Colours surfaces by reflection tier or by the probe they read. Needs the Realistic colour mode. Not saved.';
    ui.textWrapped(f.body, ix, y, iw, help, UiTheme.TEXT_MUTED, 6);
  }

  // #endregion

  // #region Comments list

  private openComments(): void {
    const session = this.session;
    this.commentsOpen = true;
    this.commentScroll = 0;
    this.commentDeleteArmed = null;
    this.commentsNotice = null;
    this.commentDetail = null;
    const level = session.scene.levels.length > 0 ? session.levelIndexAt(session.player.feet.z) : -1;
    this.commentLevelFilter = level >= 0 && this.countCommentsOn(level) > 0 ? level : -1;
  }

  /** A notice under the comment list (e.g. from the text box: reply added). */
  setCommentsNotice(notice: string): void {
    this.commentsNotice = notice;
  }

  private buildCommentsPanel(): void {
    const session = this.session, ui = session.ui, f = ui.atlas, w = this.w;
    const width = session.screenWidth, height = session.screenHeight;
    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    const pw = Math.min(this.s(1000), width - this.s(80)), ph = height - this.s(96);
    const x = (width - pw) * 0.5, y = this.s(48);
    ui.panel(x, y, pw, ph, UiTheme.CARD, UiTheme.CARD_BORDER);

    if (this.commentDetail && !session.comments.comments.includes(this.commentDetail)) { this.commentDetail = null; }
    if (this.commentDetail) {
      this.buildCommentDetail(f, x, y, pw, ph, this.commentDetail);
      return;
    }

    const ix = x + this.s(24), iw = pw - this.s(48);
    let cy = y + this.s(20);
    const count = session.comments.comments.length;
    ui.text(f.small, ix, cy, 'COMMENTS', UiTheme.COMMENT_LABEL, this.s(2));
    ui.textRight(f.small, ix + iw, cy, `${count.toLocaleString('en')} ${count === 1 ? 'comment' : 'comments'} · kept in ${session.comments.fileName}`, UiTheme.TEXT_MUTED, this.s(0.6));
    cy += this.s(30);

    // Filters: ← level → and status
    let filterX = ix;
    if (session.scene.levels.length > 0) {
      if (w.smallButton(f, ix, cy, this.s(32), this.s(32), '←')) { this.stepCommentFilter(-1); }
      ui.panel(ix + this.s(38), cy, this.s(240), this.s(32), UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
      ui.textCentred(f.body, ix + this.s(38) + this.s(120), cy + this.s(16) - f.body.lineHeight * 0.5, this.commentFilterLabel(), UiTheme.TEXT);
      if (w.smallButton(f, ix + this.s(284), cy, this.s(32), this.s(32), '→')) { this.stepCommentFilter(+1); }
      filterX = ix + this.s(336);
    }
    const status = w.segmented(f, filterX, cy, Math.min(this.s(420), ix + iw - filterX), STATUS_FILTERS, this.commentStatusFilter);
    if (status !== this.commentStatusFilter) {
      this.commentStatusFilter = status;
      this.commentScroll = 0;
    }
    cy += this.s(46);

    const buttonsY = y + ph - this.s(24) - this.s(48);
    this.buildCommentRows(f, ix, cy, iw, buttonsY - this.s(16));
    if (this.commentDetail) { return; }

    if (this.commentsNotice) { ui.textWrapped(f.body, ix, buttonsY - this.s(30), iw, this.commentsNotice, UiTheme.MEASURE_TEXT, 1); }
    if (w.menuButton(f, ix, buttonsY, this.s(200), 'EXPORT CSV…', false, false, count > 0)) {
      session.exportComments();
      this.commentsNotice = `Exported ${count} comments (your Downloads folder)`;
      session.sound.play(SoundId.Commit);
    }
    if (w.menuButton(f, ix + this.s(216), buttonsY, this.s(160), 'CLOSE', false, false)) { this.closePanels(); }
  }

  /** The scrolling rows: status bar, thumbnail, header, text, issue line and GO / OPEN / DELETE. */
  private buildCommentRows(f: FontAtlas, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, w = this.w, input = session.input;
    const rowH = this.s(84);
    const visible = Math.max(1, Math.trunc((bottom - y) / rowH));
    const list = session.comments.comments.filter(r => this.matchesCommentFilter(r));

    if (list.length === 0) {
      ui.textWrapped(f.body, x, y + this.s(8), width, session.comments.comments.length === 0
        ? 'No comments yet. Use the Comment tool (4): LMB places a marker and opens a text box.'
        : 'No comments match. Use ← → for another level, or pick All.', UiTheme.TEXT_MUTED, 2);
      return;
    }

    const maxScroll = Math.max(0, list.length - visible);
    if (input.wheel !== 0) { this.commentScroll -= input.wheel * 2; }
    this.commentScroll = Math.min(Math.max(this.commentScroll, 0), maxScroll);
    if (this.commentDeleteArmed && session.clock > this.commentDeleteArmedUntil) { this.commentDeleteArmed = null; }

    let go: CommentRecord | null = null, open: CommentRecord | null = null, remove: CommentRecord | null = null;
    const buttonW = this.s(70), gap = this.s(6);
    const buttonsW = buttonW * 3 + gap * 2;
    const thumbW = this.s(120), thumbH = this.s(68);
    const last = Math.min(list.length, this.commentScroll + visible);
    for (let i = this.commentScroll; i < last; i++) {
      const record = list[i];
      const ry = y + (i - this.commentScroll) * rowH;
      if (((i - this.commentScroll) & 1) === 0) { ui.rect(x - this.s(8), ry - this.s(4), width + this.s(16), rowH - this.s(4), Rgba.hex(0xffffff, 0.03)); }

      // Status bar on the left edge, then the thumbnail
      ui.rect(x - this.s(8), ry - this.s(4), this.s(3), rowH - this.s(4), statusColour(record.status));
      this.drawCommentThumbnail(f, record, x, ry, thumbW, thumbH);

      const textX = x + thumbW + this.s(14);
      const textW = width - buttonsW - thumbW - this.s(30);
      ui.textWrapped(f.small, textX, ry + this.s(2), textW, record.level ? `${record.header} · ${record.level}` : record.header, UiTheme.COMMENT_LABEL, 1);
      ui.textWrapped(f.body, textX, ry + this.s(20), textW, record.text, record.status === CommentStatus.CLOSED ? UiTheme.TEXT_MUTED : UiTheme.TEXT, 1);
      this.issueLine(f, record, textX, ry + this.s(46), textW);

      const bx = x + width - buttonsW, by = ry + this.s(18);
      if (w.smallButton(f, bx, by, buttonW, this.s(30), 'GO')) { go = record; }
      if (w.smallButton(f, bx + buttonW + gap, by, buttonW, this.s(30), 'OPEN')) { open = record; }
      const armed = this.commentDeleteArmed === record;
      if (w.smallButton(f, bx + (buttonW + gap) * 2, by, buttonW, this.s(30), armed ? 'SURE?' : 'DELETE', true)) { remove = record; }
    }
    if (maxScroll > 0) {
      ui.textRight(f.small, x + width, bottom + this.s(2), `${this.commentScroll + 1}–${last} of ${list.length} · wheel to scroll`, UiTheme.TEXT_FAINT);
    }

    // Act after drawing (the list must not change while it is being walked)
    if (go) { this.goToComment(go); }
    else if (open) {
      this.commentDetail = open;
      this.replyScroll = 0;
      this.replyDeleteArmed = null;
      this.commentsNotice = null;
    } else if (remove) { this.deleteComment(remove); }
  }

  /** "● Open · High priority · → Sam · 3 replies" (status coloured; the rest only when set). */
  private issueLine(f: FontAtlas, record: CommentRecord, x: number, y: number, width: number): void {
    const ui = this.session.ui;
    const colour = statusColour(record.status);
    ui.circle(x + this.s(5), y + f.small.lineHeight * 0.5, this.s(4), colour, 12);
    const used = this.s(14) + ui.text(f.small, x + this.s(14), y, CommentStatus.label(record.status), colour, this.s(0.4));
    let rest = '';
    if (record.priority !== CommentPriority.NORMAL) { rest += ` · ${CommentPriority.label(record.priority)} priority`; }
    if (record.assignedTo) { rest += ` · → ${record.assignedTo}`; }
    const replies = record.replies?.length ?? 0;
    if (replies > 0) { rest += ` · ${replies} ${replies === 1 ? 'reply' : 'replies'}`; }
    if (rest) {
      ui.textWrapped(f.small, x + used, y, width - used, rest, record.priority === CommentPriority.HIGH ? UiTheme.DANGER : UiTheme.TEXT_SOFT, 1);
    }
  }

  /** A comment's thumbnail (or a "NO PICTURE" tile for older comments). */
  private drawCommentThumbnail(f: FontAtlas, record: CommentRecord, x: number, y: number, w: number, h: number): void {
    const session = this.session, ui = session.ui;
    const thumbnail = session.thumbnailTexture(record);
    if (thumbnail) {
      ui.image(thumbnail, x, y, w, h, session.screenWidth, session.screenHeight);
      ui.outline(x, y, w, h, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.15));
    } else {
      ui.panel(x, y, w, h, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
      ui.textCentred(f.small, x + w * 0.5, y + h * 0.5 - this.s(7), record.thumbnail ? '…' : 'NO PICTURE', UiTheme.TEXT_FAINT, this.s(0.4));
    }
  }

  /** One comment in full: picture, text, status / priority / assignee, the reply thread and its actions. */
  private buildCommentDetail(f: FontAtlas, x: number, y: number, pw: number, ph: number, record: CommentRecord): void {
    const session = this.session, ui = session.ui, w = this.w, comments = session.comments;
    const ix = x + this.s(24), iw = pw - this.s(48);
    let cy = y + this.s(20);
    ui.text(f.small, ix, cy, 'COMMENT', UiTheme.COMMENT_LABEL, this.s(2));
    ui.textRight(f.small, ix + iw, cy, record.level ? `${record.header} · ${record.level}` : record.header, UiTheme.TEXT_MUTED, this.s(0.6));
    cy += this.s(32);

    // Picture (left) and the issue fields (right)
    const picW = Math.min(this.s(384), iw * 0.42), picH = picW * 9 / 16;
    this.drawCommentThumbnail(f, record, ix, cy, picW, picH);
    const rx = ix + picW + this.s(24), rw = iw - picW - this.s(24);
    const textH = ui.textWrapped(f.body, rx, cy, rw, record.text, UiTheme.TEXT, 5);
    let fy = cy + Math.max(textH, f.body.lineHeight) + this.s(14);

    ui.text(f.small, rx, fy + this.s(9), 'STATUS', UiTheme.TEXT_MUTED, this.s(0.6));
    const statusIndex = Math.max(0, CommentStatus.ALL.indexOf(record.status));
    const newStatus = w.segmented(f, rx + this.s(90), fy, Math.min(this.s(330), rw - this.s(90)), STATUS_OPTIONS, statusIndex);
    if (newStatus !== statusIndex) {
      comments.setIssue(record, { status: CommentStatus.ALL[newStatus] });
      this.commentsNotice = `Status: ${STATUS_OPTIONS[newStatus]}`;
    }
    fy += this.s(40);

    ui.text(f.small, rx, fy + this.s(9), 'PRIORITY', UiTheme.TEXT_MUTED, this.s(0.6));
    const priorityIndex = Math.max(0, CommentPriority.ALL.indexOf(record.priority));
    const newPriority = w.segmented(f, rx + this.s(90), fy, Math.min(this.s(330), rw - this.s(90)), PRIORITY_OPTIONS, priorityIndex);
    if (newPriority !== priorityIndex) {
      comments.setIssue(record, { priority: CommentPriority.ALL[newPriority] });
      this.commentsNotice = `Priority: ${PRIORITY_OPTIONS[newPriority]}`;
    }
    fy += this.s(40);

    ui.text(f.small, rx, fy + this.s(9), 'ASSIGNED', UiTheme.TEXT_MUTED, this.s(0.6));
    ui.textWrapped(f.body, rx + this.s(90), fy + this.s(6), Math.max(this.s(60), rw - this.s(90) - this.s(130)), record.assignedTo ?? 'Nobody',
      record.assignedTo ? UiTheme.TEXT : UiTheme.TEXT_FAINT, 1);
    if (w.smallButton(f, rx + rw - this.s(120), fy, this.s(120), this.s(30), 'ASSIGN…')) { session.editor.assignComment(record); }
    fy += this.s(40);

    if (record.updated) {
      ui.textWrapped(f.small, rx, fy, rw, `Updated by ${record.updatedBy ?? '?'} · ${shortDate(record.updated)}`, UiTheme.TEXT_FAINT, 1);
    }

    // Thread
    cy += Math.max(picH, fy + this.s(20) - cy) + this.s(16);
    ui.text(f.small, ix, cy, `REPLIES (${record.replies?.length ?? 0})`, UiTheme.COMMENT_LABEL, this.s(1));
    cy += this.s(24);

    const buttonsY = y + ph - this.s(24) - this.s(44);
    this.buildReplies(f, record, ix, cy, iw, buttonsY - this.s(40));

    if (this.commentsNotice) { ui.textWrapped(f.body, ix, buttonsY - this.s(28), iw, this.commentsNotice, UiTheme.MEASURE_TEXT, 1); }

    const bh = this.s(44), bw = this.s(150), bg = this.s(10);
    let bx = ix;
    if (w.menuButton(f, bx, buttonsY, this.s(110), 'BACK', false, false, true, bh)) { this.commentDetail = null; return; }
    bx += this.s(110) + bg;
    if (w.menuButton(f, bx, buttonsY, this.s(130), 'REPLY…', true, false, true, bh)) { session.editor.replyToComment(record); }
    bx += this.s(130) + bg;
    if (w.menuButton(f, bx, buttonsY, bw, 'GO TO VIEW', false, false, true, bh)) { this.goToComment(record); return; }
    bx += bw + bg;
    if (w.menuButton(f, bx, buttonsY, bw, 'SET VIEW HERE', false, false, true, bh)) {
      // Where the player stands now (the picture is taken from the 3D view behind the menu, next frame)
      const p = session.player;
      comments.setView(record, p.feet, p.yaw, p.pitch, p.flying);
      session.commentThumbnailFor = record;
      this.commentsNotice = 'View and picture set to where you stand';
      session.sound.play(SoundId.Commit);
    }
    bx += bw + bg;
    if (w.menuButton(f, bx, buttonsY, this.s(130), 'EDIT TEXT', false, false, true, bh)) { session.editor.editCommentText(record); }
    bx += this.s(130) + bg;
    const armed = this.commentDeleteArmed === record && session.clock <= this.commentDeleteArmedUntil;
    if (w.menuButton(f, bx, buttonsY, this.s(120), armed ? 'SURE?' : 'DELETE', false, true, true, bh)) {
      this.deleteComment(record);
      if (!comments.comments.includes(record)) { this.commentDetail = null; }
    }
  }

  /** The reply thread (oldest first, wheel scrolls), each with its author, date and DELETE. */
  private buildReplies(f: FontAtlas, record: CommentRecord, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, w = this.w, input = session.input;
    const replies = record.replies ?? [];
    if (replies.length === 0) {
      ui.text(f.body, x, y + this.s(4), 'No replies yet: REPLY… adds one.', UiTheme.TEXT_MUTED);
      return;
    }

    const rowH = this.s(58);
    const visible = Math.max(1, Math.trunc((bottom - y) / rowH));
    const maxScroll = Math.max(0, replies.length - visible);
    if (input.wheel !== 0 && w.hover(x, y, width, bottom - y)) { this.replyScroll -= input.wheel; }
    this.replyScroll = Math.min(Math.max(this.replyScroll, 0), maxScroll);
    if (this.replyDeleteArmed && session.clock > this.replyDeleteArmedUntil) { this.replyDeleteArmed = null; }

    let remove: CommentReply | null = null;
    const last = Math.min(replies.length, this.replyScroll + visible);
    for (let i = this.replyScroll; i < last; i++) {
      const reply = replies[i];
      const ry = y + (i - this.replyScroll) * rowH;
      ui.rect(x, ry, this.s(2), rowH - this.s(10), UiTheme.COMMENT);
      ui.text(f.small, x + this.s(12), ry, `${reply.author.toUpperCase()} · ${shortDate(reply.created)}`, UiTheme.COMMENT_LABEL, this.s(0.6));
      ui.textWrapped(f.body, x + this.s(12), ry + this.s(18), width - this.s(110), reply.text, UiTheme.TEXT, 2);
      const armed = this.replyDeleteArmed === reply;
      if (w.smallButton(f, x + width - this.s(84), ry + this.s(4), this.s(84), this.s(28), armed ? 'SURE?' : 'DELETE', true)) { remove = reply; }
    }
    if (maxScroll > 0) {
      ui.textRight(f.small, x + width, bottom + this.s(2), `${this.replyScroll + 1}–${last} of ${replies.length} · wheel to scroll`, UiTheme.TEXT_FAINT);
    }

    if (!remove) { return; }
    if (this.replyDeleteArmed === remove) {
      session.comments.removeReply(record, remove);
      this.replyDeleteArmed = null;
      this.commentsNotice = 'Reply deleted';
      session.sound.play(SoundId.Remove);
    } else {
      this.replyDeleteArmed = remove;
      this.replyDeleteArmedUntil = session.clock + 3;
    }
  }

  /** Leaves the menu and goes to a comment's view (its text as a note). */
  private goToComment(record: CommentRecord): void {
    const session = this.session;
    this.commentDetail = null;
    this.closePanels();
    session.setPaused(false);
    session.teleportToComment(record);
    session.selectGun(session.guns.indexOf(session.commentGun));
    session.toast(record.text.length > 60 ? record.text.slice(0, 57) + '…' : record.text, 3);
  }

  /** DELETE: the first click arms it for 3 s, the second deletes. */
  private deleteComment(record: CommentRecord): void {
    const session = this.session;
    if (this.commentDeleteArmed === record && session.clock <= this.commentDeleteArmedUntil) {
      session.comments.remove(record);
      this.commentDeleteArmed = null;
      this.commentsNotice = 'Comment deleted';
      session.sound.play(SoundId.Remove);
    } else {
      this.commentDeleteArmed = record;
      this.commentDeleteArmedUntil = session.clock + 3;
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
    if (this.commentStatusFilter > 0 && record.status !== CommentStatus.ALL[this.commentStatusFilter - 1]) { return false; }
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

type EditMode = 'comment' | 'bookmark' | 'user' | 'reply' | 'assign';

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
  /** Reply / assign / edit text opened from the comment panel: the menu stays open behind the box. */
  private overMenu = false;

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

  /** A reply to a comment (from the comment panel; the menu stays open behind the box). */
  replyToComment(record: CommentRecord): void {
    this.start('reply', 280, '');
    this.record = record;
    this.level = record.level || null;
    this.overMenu = true;
  }

  /** A comment's assignee (ready to change; empty + Enter clears it). */
  assignComment(record: CommentRecord): void {
    this.start('assign', MAX_ASSIGNEE, (record.assignedTo ?? '').slice(0, MAX_ASSIGNEE));
    this.record = record;
    this.level = record.level || null;
    this.overMenu = true;
  }

  /** EDIT TEXT in the comment detail view (over the menu). */
  editCommentText(record: CommentRecord): void {
    this.editComment(record);
    this.overMenu = true;
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
    this.overMenu = false;
    if (!this.session.paused) { this.session.releaseMouseForTyping(); }
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
    } else if (this.mode === 'reply' || this.mode === 'assign') {
      session.menu.setCommentsNotice(this.mode === 'reply' ? 'Reply cancelled' : 'Assignee not changed');
    } else if (this.mode === 'comment') {
      if (this.overMenu) { session.menu.setCommentsNotice('Edit cancelled'); } else { session.toast(this.record ? 'Edit cancelled' : 'Comment cancelled'); }
    }
    this.finish();
  }

  private commit(): void {
    const session = this.session;
    const text = this.text.trim();
    const { mode, record, bookmark } = this;
    this.finish();

    if (mode === 'reply' && record) {
      if (!text) { session.menu.setCommentsNotice('Empty reply not saved'); return; }
      session.comments.addReply(record, text);
      session.sound.play(SoundId.CommentPlace);
      session.menu.setCommentsNotice(`Reply added (${record.replies?.length ?? 0} in the thread)`);
      return;
    }
    if (mode === 'assign' && record) {
      session.comments.setIssue(record, { assignedTo: text });
      session.sound.play(SoundId.UiClick);
      session.menu.setCommentsNotice(text ? `Assigned to ${text}` : 'Unassigned');
      return;
    }

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
      if (this.overMenu) { session.menu.setCommentsNotice('Comment text updated'); } else { session.toast('Comment updated'); }
      return;
    }

    if (!text) {
      session.toast('Empty comment not saved');
      return;
    }
    // The new comment remembers where it was made from, and a picture of that view (taken next frame: the capture
    // reads the 3D view before the UI is drawn, so the text box isn't in it)
    const added = session.comments.add(this.point, text, this.elementId, this.level);
    const p = session.player;
    session.comments.setView(added, p.feet, p.yaw, p.pitch, p.flying);
    session.commentThumbnailFor = added;
    session.sound.play(SoundId.CommentPlace);
    session.toast(`Comment added (kept in ${session.comments.fileName})`);
  }

  build(): void {
    const session = this.session, ui = session.ui, f = ui.atlas;
    const w = this.s(460);
    const textHeight = Math.max(f.body.lineHeight * 1.15, ui.textWrapped(f.body, 0, 0, w - this.s(48), this.text, 0, 10, false));
    const h = this.s(96) + textHeight;
    const x = session.screenWidth * 0.5 - w * 0.5, y = session.screenHeight * 0.5 + this.s(48);

    const naming = this.mode === 'bookmark' || this.mode === 'user';
    const frame = naming ? UiTheme.BOOKMARK : UiTheme.COMMENT;
    const label = naming ? UiTheme.BOOKMARK_LABEL : UiTheme.COMMENT_LABEL;
    ui.panel(x, y, w, h, UiTheme.PANEL_STRONG, frame);
    const title = this.mode === 'user' ? 'YOUR NAME (SHOWN ON COMMENTS)'
      : `${this.mode === 'bookmark' ? 'BOOKMARK NAME' : this.mode === 'reply' ? 'REPLY' : this.mode === 'assign' ? 'ASSIGN TO (empty = unassigned)'
        : this.record ? 'EDIT COMMENT' : 'NEW COMMENT'} · ${this.level ?? '—'}`;
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
