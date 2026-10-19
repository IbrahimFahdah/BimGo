import { type BookmarkRecord, CommentPriority, type CommentRecord, type CommentReply, CommentStatus, hasMarkup } from '../core/format/DocumentModels';
import { setCurrentUser } from '../core/format/DocumentModels';
import { type Vec3, vec3 } from '../core/math/Vector';
import { CATEGORIES, CategoryGroup, GROUP_NAMES } from '../core/scene/CategoryCatalog';
import { UnitSystem } from '../core/scene/Units';
import { linkLabel } from '../core/scene/LinkInfo';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas, UiFont } from '../engine/ui/UiFont';
import { statusColour, UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import { QualityProfile, QualityProfiles } from './QualityProfiles';
import { ControlsPanel } from './ControlsPanel';
import { LibraryPanel } from './LibraryPanel';
import { Overlays } from './Overlays';
import { RoomFinder } from './RoomFinder';
import { BookmarkStore, shortDate } from './Stores';
import { UnitFormat } from './UnitFormat';
import { ColourMode } from './ViewerSettings';
import { Hints } from './Hints';
import { FOOTER_LEFT, PanelSize, ScrollRegion, ShellStyle } from './PanelShell';
import { MediaTab } from './MediaPanel';
import { InputAction } from '../core/scene/InputCatalog';
import { keyOf } from '../platform/Hotkeys';

const COLOUR_OPTIONS = ['Whitecard', 'Material', 'Realistic'];
const STATUS_FILTERS = ['All', 'Open', 'In progress', 'Closed'];
const TYPE_FILTERS = ['All', 'Issues', 'Clashes'];
const STATUS_OPTIONS = ['Open', 'In progress', 'Closed'];
const PRIORITY_OPTIONS = ['Low', 'Normal', 'High'];
/** Reflections: off, some (shine tiers 50 % +), or all (25 % +). */
const REFLECTION_OPTIONS = ['Off', 'Some', 'All'];
/** Reflection source: the sky, probes, or probes at 256 px. */
const SOURCE_OPTIONS = ['Sky', 'Probes', 'Probes HQ'];
/** Debug colours: off, reflection tiers, reflection probe cells. */
/** Display units (review tools round). */
const UNIT_OPTIONS = ['Metric', 'Imperial'];
/** The pause menu's settings tabs. */
const RIGHT_TABS = ['DISPLAY', 'REFLECTIONS', 'APPEARANCE'];
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
    // P-A1: what a scroll region clips can't be clicked
    return i.mouseX >= x && i.mouseX < x + w && i.mouseY >= y && i.mouseY < y + h && this.ui.clipContains(i.mouseX, i.mouseY);
  }

  /** A full-width menu button; compact (QOL round): the body font and tighter padding (the pause menu's stacks). */
  menuButton(f: FontAtlas, x: number, y: number, w: number, label: string, primary: boolean, danger: boolean, enabled = true, height = 0, compact = false): boolean {
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
    const font = compact ? f.body : f.bold;
    ui.text(font, x + this.s(compact ? 12 : 16), y + h * 0.5 - font.lineHeight * 0.5, label, primary ? textColour : fade(textColour, alpha), this.s(compact ? 0.9 : 1.3));
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

  /**
   * A compact [−] value [+] stepper (port of StepperValue).
   * @returns The value after this frame's clicks (clamped, rounded to the step).
   */
  stepper(f: FontAtlas, x: number, y: number, value: number, step: number, min: number, max: number, decimals: number, unit: string): number {
    let changed = value;
    if (this.smallButton(f, x, y, this.s(30), this.s(30), '−')) { changed = value - step; }
    this.ui.textCentred(f.bold, x + this.s(94), y + this.s(6), value.toFixed(decimals) + unit, UiTheme.TEXT);
    if (this.smallButton(f, x + this.s(158), y, this.s(30), this.s(30), '+')) { changed = value + step; }
    return changed === value ? value : Math.round(Math.min(Math.max(changed, min), max) / step) * step;
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
  private readonly commentScroll = new ScrollRegion();
  private commentDeleteArmed: CommentRecord | null = null;
  private commentDeleteArmedUntil = 0;
  private commentsNotice: string | null = null;
  private commentStatusFilter = 0; // 0 all, 1 open, 2 in progress, 3 closed
  // C-B3: the type filter (0 all, 1 issues, 2 clashes), the ticked comments and the last one ticked (Shift runs)
  private commentTypeFilter = 0;
  private readonly commentSelected = new Set<CommentRecord>();
  private commentAnchor: CommentRecord | null = null;
  /** The comment shown in full (null = the list). */
  private commentDetail: CommentRecord | null = null;
  /** P-A1: the detail view (picture, issue fields and the thread) scrolls as one. */
  private readonly commentDetailScroll = new ScrollRegion();
  private replyDeleteArmed: CommentReply | null = null;
  private replyDeleteArmedUntil = 0;
  /** Open right-column tab: 0 display, 1 reflections, 2 debug (per session). */
  private rightTab = 0;
  /** QOL round: the options preview is showing (the scene without the menu's backdrop). */
  preview = false;
  private previewLabel: string | null = null;
  private readonly settingsScroll = new ScrollRegion();
  private bookmarksOpen = false;
  private readonly bookmarkScroll = new ScrollRegion();
  private bookmarkDeleteArmed: BookmarkRecord | null = null;
  private bookmarkDeleteArmedUntil = 0;
  private bookmarksNotice: string | null = null;
  /** CATEGORIES & LINKS (the category cards and link toggles, out of the pause menu's middle). */
  private geometryOpen = false;
  private readonly geometryScroll = new ScrollRegion();

  /** FIND ROOM (Ctrl+F). */
  readonly rooms: RoomFinder;
  /** FAMILY LIBRARY (Place gun). */
  readonly library: LibraryPanel;
  /** CONTROLS (every key binding, rebindable). */
  readonly controls: ControlsPanel;
  /** Dropdowns and confirms over the panels. */
  readonly overlays: Overlays;

  constructor(private readonly session: GameSession) {
    this.w = new Widgets(session);
    this.rooms = new RoomFinder(session, this.w);
    this.library = new LibraryPanel(session, this.w);
    this.library.onPick = entry => session.pickFromLibrary(entry);
    this.controls = new ControlsPanel(session, this.w);
    this.overlays = new Overlays(session);
  }

  /** Closes an open dropdown or confirm (a new screen, Esc); false when none was open. */
  closeOverlay(): boolean {
    return this.overlays.close();
  }

  /** The menus' widgets (shared with panels drawn elsewhere: the video progress). */
  get widgets(): Widgets { return this.w; }

  /** True while a panel with a search box has the keyboard (letters must not act as shortcuts, e.g. P). */
  get capturesTyping(): boolean {
    return this.session.paused && (this.rooms.open || this.library.open || this.controls.open || this.session.clashes.panel.capturesTyping);
  }

  private s(v: number): number { return this.session.s(v); }

  /** Closes an open list (Esc); false when none was open. */
  closePanels(): boolean {
    if (this.closePreview()) { return true; }
    if (this.overlays.close()) { return true; }
    if (this.session.textures?.close()) { return true; }
    if (this.rooms.close()) { return true; }
    if (this.library.close()) { return true; }
    if (this.session.clashes.panel.close()) { return true; }
    if (this.session.profiles.closePanel()) { return true; }
    if (this.session.media.close()) { return true; }
    if (this.commentsOpen && this.commentDetail) { this.commentDetail = null; return true; }
    if (this.commentsOpen) { this.commentsOpen = false; this.commentDeleteArmed = null; return true; }
    if (this.closeBookmarks()) { return true; }
    if (this.geometryOpen) { this.geometryOpen = false; return true; }
    if (this.controls.close()) { return true; }
    return false;
  }

  // #region Main menu

  build(): void {
    // The markup editor and the full-menu panels take over the whole menu while open
    if (this.session.markup.open) { this.session.markup.build(this.w); return; }
    if (this.commentsOpen) { this.buildCommentsPanel(); return; }
    if (this.bookmarksOpen) { this.buildBookmarksPanel(); return; }
    if (this.session.media.isOpen) { this.session.media.build(); return; } // Round K-A
    if (this.session.textures?.open) { this.session.textures.build(); return; }
    if (this.rooms.open) { this.rooms.build(); return; }
    if (this.library.open) { this.library.build(); return; }
    if (this.session.clashes.panel.isOpen) { this.session.clashes.panel.build(this.session.ui.atlas); return; }
    if (this.session.profiles.panelOpen) { this.session.profiles.buildPanel(); return; } // colour round A
    if (this.geometryOpen) { this.buildGeometryPanel(); return; }
    if (this.controls.open) { this.controls.build(); return; }

    const session = this.session, ui = session.ui, f = ui.atlas, w = this.w;
    const input = session.input;
    const width = session.screenWidth, height = session.screenHeight;
    if (!input.leftDown) { w.activeSlider = -1; }

    // Sky round: Tab (the pad's Y) toggles the preview
    if (!session.editor.active && input.pressed(InputAction.MenuPreview)) {
      this.preview = !this.preview;
      w.activeSlider = -1;
      session.sound.play(SoundId.UiClick);
    }

    // QOL round: the options preview (no backdrop, graphics settings only; Esc returns)
    if (this.preview) {
      this.buildPreview(f, width, height);
      return;
    }

    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    // Layout (review tools round, to keep the menu inside a 720 px high window): the buttons in two stacks (session ·
    // review) when the window is wide enough, else one; the settings in two columns (profile, eye height, units · the
    // Display / Reflections / Debug tabs) when they fit, else stacked. The category cards moved to their own panel
    // (CATEGORIES & LINKS).
    const pad = this.s(48);
    const leftX = this.s(56), stackW = this.s(196), stackGap = this.s(20); // QOL round: slimmer buttons (were 220 px, 54 px pitch)
    const columnW = this.s(280), columnGap = this.s(24);
    const rightEdge = width - this.s(56);
    const twoStacks = width >= leftX + stackW * 2 + stackGap + this.s(40) + columnW * 2 + columnGap + this.s(56);
    const stacksRight = leftX + stackW + (twoStacks ? stackGap + stackW : 0);
    const twoColumns = rightEdge - (columnW * 2 + columnGap) >= stacksRight + this.s(40);

    // ---- Buttons
    let y = pad;
    ui.text(f.small, leftX, y, 'BIMGO', UiTheme.TEXT_MUTED, this.s(2.6));
    y += this.s(20);
    ui.text(f.title, leftX, y, 'PAUSED', UiTheme.TEXT, this.s(2.4));
    y += this.s(56);
    const buttonsTop = y;

    // Button pitch: 44 px, tightened when a stack would run into CLOSE MODEL (small or high-DPI screens)
    const endY = height - pad - this.s(40);
    const hiddenThings = session.hiddenThingsCount;
    const texturesButton = session.textures?.available ?? false;
    const roomsButton = session.scene.rooms.length > 0;
    const libraryButton = this.library.available;
    const sessionButtons = 5; // + CONTROLS
    const reviewButtons = 6 + (hiddenThings > 0 ? 1 : 0) + (texturesButton ? 1 : 0) + (libraryButton ? 1 : 0) + (roomsButton ? 1 : 0);
    const rows = twoStacks ? Math.max(sessionButtons, reviewButtons) : sessionButtons + reviewButtons;
    const step = Math.min(Math.max((endY - this.s(12) - buttonsTop) / rows, this.s(32)), this.s(44));
    const buttonH = step - this.s(6);

    // Stack 1: the session
    let x = leftX;
    if (w.menuButton(f, x, y, stackW, 'RESUME', true, false, true, buttonH, true)) { session.setPaused(false); return; }
    y += step;
    if (w.menuButton(f, x, y, stackW, 'RETURN HOME', false, false, true, buttonH, true)) { session.player.goHome(); session.setPaused(false); return; }
    y += step;
    if (w.menuButton(f, x, y, stackW, session.clock < session.homeSetUntil ? 'HOME SET HERE' : 'SET HOME HERE', false, false, true, buttonH, true)) { session.setHomeHere(); }
    y += step;
    // Save in place (Chrome / Edge) or download; Save As picks a new file
    const half = (stackW - this.s(6)) / 2;
    if (w.menuButton(f, x, y, half, session.isDirty ? 'SAVE *' : 'SAVE', false, false, true, buttonH, true)) { void session.save(false); return; }
    if (w.menuButton(f, x + half + this.s(6), y, half, 'SAVE AS', false, false, true, buttonH, true)) { void session.save(true); return; }
    y += step;
    // Keys, mouse buttons, the wheel and the gamepad: every binding, rebindable
    if (w.menuButton(f, x, y, stackW, 'CONTROLS', false, false, true, buttonH, true)) { this.controls.show(); return; }
    y += step;

    // Stack 2: review tools and panels (beside the first, or below it)
    if (twoStacks) {
      x = leftX + stackW + stackGap;
      y = buttonsTop;
    }
    const comments = session.comments.comments.length;
    if (w.menuButton(f, x, y, stackW, comments === 0 ? 'COMMENTS' : `COMMENTS (${comments})`, false, false, true, buttonH, true)) { this.openComments(); return; }
    y += step;
    const bookmarks = session.bookmarks.bookmarks.length;
    if (w.menuButton(f, x, y, stackW, bookmarks === 0 ? 'BOOKMARKS' : `BOOKMARKS (${bookmarks})`, false, false, true, buttonH, true)) { this.openBookmarks(); return; }
    y += step;
    if (w.menuButton(f, x, y, stackW, 'MEDIA', false, false, true, buttonH, true)) { session.media.open(); return; } // Round K-A
    y += step;
    if (texturesButton) {
      if (w.menuButton(f, x, y, stackW, session.textures.menuLabel(), false, false, true, buttonH, true)) { session.textures.show(); return; }
      y += step;
    }
    if (roomsButton) {
      if (w.menuButton(f, x, y, stackW, 'FIND ROOM', false, false, true, buttonH, true)) { this.rooms.show(); return; }
      y += step;
    }
    if (w.menuButton(f, x, y, stackW, 'SUN HOURS STUDY', false, false, true, buttonH, true)) { session.sunHours.show(); return; }
    y += step;
    // Clash detection (Round C): tests, sets and runs (switching it on the first time); Y is clash mode
    if (w.menuButton(f, x, y, stackW, session.clashes.panel.label(), false, false, true, buttonH, true)) { session.clashes.panel.show(); return; }
    y += step;
    if (libraryButton) {
      if (w.menuButton(f, x, y, stackW, this.library.menuLabel(), false, false, true, buttonH, true)) { this.library.show(); return; }
      y += step;
    }
    if (w.menuButton(f, x, y, stackW, this.geometryMenuLabel(), false, false, true, buttonH, true)) { this.geometryOpen = true; this.geometryScroll.reset(); return; }
    y += step;
    if (hiddenThings > 0) {
      if (w.menuButton(f, x, y, stackW, `SHOW ALL (${hiddenThings} HIDDEN)`, false, false, true, buttonH, true)) { session.showAll(); }
    }
    // Round W-A: CLEAR MARKERS left the menu (each gun clears its own markers with the clear key; comments are
    // issues, managed in COMMENTS)

    if (w.menuButton(f, leftX, endY, stackW, 'CLOSE MODEL', false, true, true, this.s(40), true)) { session.requestClose(); return; }

    // ---- Settings: quality profile, eye height and units · Display / Reflections / Appearance
    const tabsX = rightEdge - columnW;

    // QOL round: PREVIEW hides the backdrop and everything but the graphics settings (Esc returns)
    this.previewLabel ??= `PREVIEW (${keyOf(InputAction.MenuPreview)})`;
    if (w.menuButton(f, rightEdge - this.s(150), this.s(10), this.s(150), this.previewLabel, false, false, true, this.s(28), true)) {
      this.preview = true;
      w.activeSlider = -1;
      return;
    }
    if (twoColumns) {
      this.buildSettingsColumn(f, tabsX - columnGap - columnW, pad, columnW);
      this.buildSettingsTabs(f, tabsX, pad, columnW, this.s(32)); // the file footer stays clear
    } else {
      const used = this.buildSettingsColumn(f, tabsX, pad, columnW);
      this.buildSettingsTabs(f, tabsX, pad + used + this.s(12), columnW, this.s(32));
    }

    const scene = session.scene;
    const journal = session.journal.count;
    ui.textRight(f.small, width - this.s(56), height - this.s(28),
      `${session.document.name} · ${scene.elements.length.toLocaleString('en')} elements · ${(scene.geometry.indices.length / 3).toLocaleString('en')} tris · ${journal} ${journal === 1 ? 'edit' : 'edits'}${session.isDirty ? Hints.unsaved.text : ''}`,
      UiTheme.TEXT_FAINT, this.s(0.5));
  }

  /** "CATEGORIES & LINKS", with the number of loaded categories and links switched off. */
  private geometryMenuLabel(): string {
    const session = this.session;
    let off = 0;
    session.categoryVisible.forEach((visible, c) => { if (session.scene.categoryLoaded[c] && !visible) { off++; } });
    for (let l = 1; l < session.linkVisible.length; l++) { if (!session.linkVisible[l]) { off++; } }
    return off === 0 ? 'CATEGORIES & LINKS' : 'CATEGORIES & LINKS *';
  }

  /**
   * Pause menu → CATEGORIES & LINKS (review tools round): the category cards and the linked-model toggles in the panel
   * shell (polish round P-A1: one scroll region). Walkthrough only, saved with the model's visibility.
   */
  private buildGeometryPanel(): void {
    const session = this.session, shell = session.shell, f = session.ui.atlas, input = session.input;
    const frame = shell.beginPanel(PanelSize.Standard, 'CATEGORIES & LINKS', UiTheme.ACCENT, 'Walkthrough only: Revit is never changed');
    const top = shell.beginScroll(this.geometryScroll, input, frame.ix, frame.bodyTop, frame.iw, frame.bodyBottom - frame.bodyTop);
    const bottom = this.buildCategoryCards(f, frame.ix, top, frame.iw - this.s(12));
    shell.endScroll(this.geometryScroll, input, bottom);
    shell.endPanel(frame, null, 'Click a category to show or hide it, or a group\'s heading for the whole group');
  }

  /** The three category cards, the note and the linked models. @returns The bottom. */
  private buildCategoryCards(f: FontAtlas, x: number, top: number, width: number): number {
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

    let bottom = cardTop + tallest + this.s(12);
    bottom += ui.textWrapped(f.body, x, bottom, width,
      session.isFileMode ? 'Categories not in this file are greyed out. Export again from Revit with them ticked to include them.'
        : 'Categories not loaded are greyed out. Tick them in Revit\'s Options and press Go again to include them.', UiTheme.TEXT_MUTED, 2);
    if (scene.links.length > 0) {
      const links = this.buildLinkCard(f, x, bottom + this.s(UiTheme.GAP_LARGE), width);
      if (links.changed) { changed = true; }
      bottom = links.bottom;
    }

    if (changed) {
      session.refreshMasks();
      session.sound.play(SoundId.UiClick);
    }
    return bottom;
  }

  /** The linked models, each with a show / hide toggle; every row is listed (the panel's body scrolls). */
  private buildLinkCard(f: FontAtlas, x: number, top: number, width: number): { changed: boolean; bottom: number } {
    const session = this.session, ui = session.ui, w = this.w, input = session.input;
    const links = session.scene.links;
    const row = this.s(22);
    const rows = links.length;
    let changed = false;

    ui.text(f.small, x, top + this.s(2), 'LINKED MODELS (READ-ONLY)', UiTheme.TEXT_MUTED, this.s(1.8));
    const cardTop = top + this.s(26);
    const cardH = this.s(20) + rows * row;
    ui.panel(x, cardTop, width, cardH, UiTheme.CARD, UiTheme.CARD_BORDER);

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
    return { changed, bottom: cardTop + cardH };
  }

  /**
   * The first settings column: the quality profile, the eye height and the display units (always visible).
   * @returns Its height.
   */
  private buildSettingsColumn(f: FontAtlas, x: number, top: number, width: number): number {
    const session = this.session, w = this.w;
    this.buildProfileRow(f, x, top, width);

    // Eye height: standing / seated / child (tour round), then the units (review tools round)
    let y = top + this.s(68);
    y += session.eye.buildRow(f, w, x, y, width);
    y += this.buildUnitsRow(f, x, y, width);
    return y - top;
  }

  /** The units row: Metric / Imperial, and (imperial) decimal feet instead of feet-inches. Per browser. */
  private buildUnitsRow(f: FontAtlas, x: number, y: number, width: number): number {
    const session = this.session, ui = session.ui, w = this.w;
    ui.text(f.small, x, y + this.s(2), 'UNITS', UiTheme.TEXT_MUTED, this.s(1.8));
    ui.textRight(f.mono, x + width, y + this.s(1), UnitFormat.isImperial ? (UnitFormat.decimalFeet ? "5.63'" : '5\' 7 1/2"') : '1.715 m', Rgba.hex(0x67e8f9));
    const current = UnitFormat.isImperial ? 1 : 0;
    const picked = w.segmented(f, x, y + this.s(22), width, UNIT_OPTIONS, current);
    if (picked !== current) { session.setDisplayUnits(picked === 1 ? UnitSystem.Imperial : UnitSystem.Metric, UnitFormat.decimalFeet); }
    if (!UnitFormat.isImperial) { return this.s(66); }

    const decimalFeet = w.checkbox(f, x, y + this.s(64), width, 'Decimal feet (5.63\' not 5\' 7 1/2")', UnitFormat.decimalFeet);
    if (decimalFeet !== UnitFormat.decimalFeet) { session.setDisplayUnits(UnitSystem.Imperial, decimalFeet); }
    return this.s(94);
  }

  /** Quality profile: Basic / Medium / Realistic, or "Custom" once anything it sets was changed by hand (68 px). */
  private buildProfileRow(f: FontAtlas, x: number, top: number, width: number): void {
    const session = this.session, ui = session.ui, w = this.w;
    const profile = QualityProfiles.detect(session.settings);
    ui.text(f.small, x, top + this.s(2), 'QUALITY PROFILE', UiTheme.TEXT_MUTED, this.s(1.8));
    if (profile === QualityProfile.Custom) { ui.textRight(f.small, x + width, top + this.s(2), 'CUSTOM', UiTheme.MEASURE_LABEL, this.s(1.2)); }
    const shown = profile === QualityProfile.Custom ? -1 : profile - 1;
    const picked = w.segmented(f, x, top + this.s(22), width, QualityProfiles.LABELS, shown);
    if (picked !== shown && picked >= 0) { session.reflections.applyProfile(QualityProfiles.PICKABLE[picked]); }
  }

  /** Leaves the options preview (Esc): back to the full pause menu. True when the preview was open. */
  closePreview(): boolean {
    if (!this.preview) { return false; }
    this.preview = false;
    this.w.activeSlider = -1;
    return true;
  }

  /**
   * The options preview: no backdrop, no buttons, only the quality profile and the Display / Reflections / Appearance
   * card on a light panel, so the scene behind can be judged while tuning.
   */
  private buildPreview(f: FontAtlas, width: number, height: number): void {
    const ui = this.session.ui, w = this.w;
    // Polish round P-A1: the card's height comes from the window (it scrolls when short), DONE always fits under it
    const columnW = this.s(280), pad = this.s(48);
    const x = width - this.s(56) - columnW;
    const cardTop = pad + this.s(68) + this.s(32), doneReserve = this.s(12) + this.s(36);
    let cardH = this.settingsCardHeight(cardTop, doneReserve);
    const panelTop = pad - this.s(36), panelBottom = cardTop + cardH + doneReserve + this.s(12);
    ui.rect(x - this.s(16), panelTop, columnW + this.s(32), Math.min(panelBottom, height - this.s(8)) - panelTop, Rgba.hex(0x101318, 0.55));

    ui.text(f.small, x, panelTop + this.s(10), 'PREVIEW', UiTheme.ACCENT, this.s(2));
    ui.textRight(f.small, x + columnW, panelTop + this.s(10), 'ESC RETURNS', UiTheme.TEXT_MUTED, this.s(1.2));
    this.buildProfileRow(f, x, pad, columnW);
    cardH = this.buildSettingsTabs(f, x, pad + this.s(68), columnW, doneReserve);

    const doneY = cardTop + cardH + this.s(12);
    if (w.menuButton(f, x, doneY, columnW, 'DONE', false, false, true, this.s(36), true)) { this.closePreview(); }
  }

  /** The settings card's height below a top: the full height, or what the window has left (less reserve), at least 160 px. */
  private settingsCardHeight(cardTop: number, reserve = 0): number {
    return Math.min(this.s(RIGHT_CARD_HEIGHT), Math.max(this.s(160), this.session.screenHeight - this.s(UiTheme.PANEL_MARGIN) - reserve - cardTop));
  }

  /**
   * The Display · Reflections · Appearance tabs and the open tab's card. One fixed card height so the column doesn't
   * jump between tabs (shorter, and scrolled, in a short window).
   * @param reserve Height kept free under the card (the preview's DONE).
   * @returns The card's height.
   */
  private buildSettingsTabs(f: FontAtlas, x: number, top: number, width: number, reserve = 0): number {
    const session = this.session, ui = session.ui, w = this.w, input = session.input;
    const tab = w.tabs(f, x, top, width, RIGHT_TABS, this.rightTab);
    if (tab !== this.rightTab) {
      this.rightTab = tab;
      w.activeSlider = -1;
      this.settingsScroll.reset();
    }

    const cardTop = top + this.s(32);
    const cardH = this.settingsCardHeight(cardTop, reserve);
    ui.panel(x, cardTop, width, cardH, UiTheme.CARD, UiTheme.CARD_BORDER);
    const ix = x + this.s(14), iw = width - this.s(28);

    // The tab's content scrolls when the card is shorter than it (the bar sits in the card's right padding)
    const y = session.shell.beginScroll(this.settingsScroll, input, x + this.s(1), cardTop + this.s(1), width - this.s(2), cardH - this.s(2), w.activeSlider < 0) + this.s(13);
    let bottom = y - this.s(13) + this.s(RIGHT_CARD_HEIGHT) - this.s(2);
    switch (this.rightTab) {
      case 1: bottom = Math.max(bottom, this.buildReflectionsTab(f, ix, y, iw)); break;
      case 2: bottom = Math.max(bottom, session.appearance.buildTab(f, w, input, ix, y, iw) + this.s(14)); break;
      default: this.buildDisplayTab(f, ix, y, iw); break;
    }
    session.shell.endScroll(this.settingsScroll, input, bottom);
    return cardH;
  }

  /** Display tab: ground plane, colour, FOV, sensitivity, toggles and the author name. */
  private buildDisplayTab(f: FontAtlas, ix: number, y: number, iw: number): void {
    const session = this.session, ui = session.ui, w = this.w;
    const settings = session.settings;

    // Ground plane (relative to the default, shown absolute); saved with the model like hidden elements
    const ground = w.slider(f, 0, ix, y, iw, 'Ground plane', UnitFormat.appendLength(session.text.clear(), session.groundZ, 3).text,
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
  private buildReflectionsTab(f: FontAtlas, ix: number, y: number, iw: number): number {
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

    y += ui.textWrapped(f.body, ix, y, iw,
      'Realistic colour mode. Some = shiny surfaces (50 %+), All = satin too (25 %+); glass and water always reflect. Probes capture each room with a reflective surface; the sky is cheaper.',
      UiTheme.TEXT_MUTED, 6) + this.s(14);
    return y;
  }

  // #endregion

  // #region Comments list

  private openComments(): void {
    const session = this.session;
    this.commentsOpen = true;
    this.commentScroll.reset();
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
    const session = this.session, ui = session.ui, f = ui.atlas, w = this.w, shell = session.shell;
    if (this.commentDetail && !session.comments.comments.includes(this.commentDetail)) { this.commentDetail = null; }
    if (this.commentDetail) {
      this.buildCommentDetail(f, this.commentDetail);
      return;
    }

    const input = session.input;
    this.overlays.begin(input); // C-B3: the bulk delete confirm takes the click while it is open
    const count = session.comments.comments.length;
    const frame = shell.beginPanel(PanelSize.Standard, 'COMMENTS', UiTheme.COMMENT_LABEL,
      `${count.toLocaleString('en')} ${count === 1 ? 'comment' : 'comments'} · kept in ${session.comments.fileName}`);
    const ix = frame.ix, iw = frame.iw;
    let cy = frame.bodyTop;

    // Filters: ← level → and status
    let filterX = ix;
    if (session.scene.levels.length > 0) {
      if (w.smallButton(f, ix, cy, this.s(32), this.s(32), '←')) { this.stepCommentFilter(-1); }
      ui.panel(ix + this.s(38), cy, this.s(240), this.s(32), UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
      ui.textCentred(f.body, ix + this.s(38) + this.s(120), cy + this.s(16) - f.body.lineHeight * 0.5, this.commentFilterLabel(), UiTheme.TEXT);
      if (w.smallButton(f, ix + this.s(284), cy, this.s(32), this.s(32), '→')) { this.stepCommentFilter(+1); }
      filterX = ix + this.s(336);
    }
    const statusW = Math.min(this.s(340), (ix + iw - filterX - this.s(12)) * 0.58);
    const status = w.segmented(f, filterX, cy, statusW, STATUS_FILTERS, this.commentStatusFilter);
    if (status !== this.commentStatusFilter) {
      this.commentStatusFilter = status;
      this.commentScroll.reset();
      this.commentSelected.clear();
    }
    // C-B3: the type (comments made from clashes are their own type)
    const type = w.segmented(f, filterX + statusW + this.s(12), cy, Math.min(this.s(260), ix + iw - filterX - statusW - this.s(12)), TYPE_FILTERS, this.commentTypeFilter);
    if (type !== this.commentTypeFilter) {
      this.commentTypeFilter = type;
      this.commentScroll.reset();
      this.commentSelected.clear();
    }
    cy += this.s(UiTheme.CONTROL_HEIGHT + UiTheme.GAP);

    const selectY = frame.bodyBottom - this.s(UiTheme.SMALL_BUTTON_HEIGHT);
    this.buildCommentRows(f, ix, cy, iw, selectY - this.s(UiTheme.GAP_SMALL));
    if (this.commentDetail || !this.commentsOpen) { return; }

    // C-B3: the ticked comments: select all shown, clear, delete (a confirm)
    let sx = ix;
    if (w.smallButton(f, sx, selectY, this.s(170), this.s(30), 'SELECT ALL SHOWN')) {
      for (const record of session.comments.comments) { if (this.matchesCommentFilter(record)) { this.commentSelected.add(record); } }
    }
    sx += this.s(178);
    if (this.commentSelected.size > 0) {
      if (w.smallButton(f, sx, selectY, this.s(90), this.s(30), 'CLEAR')) { this.commentSelected.clear(); }
      sx += this.s(98);
      if (w.smallButton(f, sx, selectY, this.s(220), this.s(30), `DELETE SELECTED (${this.commentSelected.size})…`, true)) { this.confirmDeleteSelected(); }
    }

    // EXPORT BCF (the comments shown) · IMPORT BCF · BCF coordinates; the open confirm is drawn on top
    const exportBcf = shell.footerAction('EXPORT BCF…', ShellStyle.Normal, count > 0);
    const importBcf = shell.footerAction('IMPORT BCF…');
    const coordinates = shell.footerAction(session.bcf.coordinateLabel);
    const pressed = shell.endPanel(frame, this.commentsNotice, 'GO stands where the comment was made · OPEN shows it in full · Ctrl / Shift+click ticks rows');
    if (pressed === FOOTER_LEFT) { return; }
    this.overlays.draw(f, input, frame.x, frame.y, frame.w, frame.h);
    if (pressed === exportBcf) { void session.bcf.exportShown(session.comments.comments.filter(r => this.matchesCommentFilter(r))); }
    else if (pressed === importBcf) { void session.bcf.importFile(); }
    else if (pressed === coordinates) { session.bcf.cycleCoordinates(); }
  }

  /** Ticks or unticks a comment (C-B3); run: ticks every shown comment from the last one ticked to this one. */
  private tickComment(record: CommentRecord, run: boolean): void {
    const comments = this.session.comments.comments;
    const anchor = this.commentAnchor;
    if (run && anchor && comments.includes(anchor) && this.matchesCommentFilter(anchor)) {
      let inside = false;
      for (const shown of comments) {
        if (!this.matchesCommentFilter(shown)) { continue; }
        const end = shown === record || shown === anchor;
        if (end || inside) { this.commentSelected.add(shown); }
        if (end && record !== anchor) { inside = !inside; }
      }
    } else if (!this.commentSelected.delete(record)) {
      this.commentSelected.add(record);
    }
    this.commentAnchor = record;
  }

  /** DELETE SELECTED…: a confirm, then the ticked comments go (one save; clash comments unlinked). */
  private confirmDeleteSelected(): void {
    const session = this.session;
    for (const record of [...this.commentSelected]) { if (!session.comments.comments.includes(record)) { this.commentSelected.delete(record); } }
    const count = this.commentSelected.size;
    if (count === 0) { return; }
    const clashes = [...this.commentSelected].filter(r => r.clashId).length;
    const fromClashes = clashes > 0 ? ` ${clashes} of them were made from clashes: those clashes stay (TO COMMENT makes a new comment).` : '';
    this.overlays.openConfirm(count === 1 ? 'DELETE COMMENT?' : 'DELETE COMMENTS?',
      `Delete ${count === 1 ? 'the ticked comment' : `the ${count} ticked comments`} with their pictures and replies?${fromClashes} This can't be undone.`,
      'DELETE', true, false, () => {
        const doomed = [...this.commentSelected];
        const removed = session.comments.removeMany(doomed);
        session.clashes.unlinkComments(doomed);
        this.commentSelected.clear();
        this.commentAnchor = null;
        this.commentDeleteArmed = null;
        this.commentsNotice = session.comments.lastError ?? `${removed} comment${removed === 1 ? '' : 's'} deleted`;
        session.sound.play(SoundId.Remove);
      });
  }

  /** The rows (a clipped scroll region): status bar, thumbnail, header, text, issue line and GO / OPEN / DELETE. */
  private buildCommentRows(f: FontAtlas, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, w = this.w, input = session.input, shell = session.shell;
    const rowH = this.s(84);
    const list = session.comments.comments.filter(r => this.matchesCommentFilter(r));

    if (list.length === 0) {
      ui.textWrapped(f.body, x, y + this.s(8), width, session.comments.comments.length === 0
        ? 'No comments yet. Use the Comment tool (4): LMB places a marker and opens a text box.'
        : 'No comments match. Use ← → for another level, or pick All.', UiTheme.TEXT_MUTED, 2);
      return;
    }

    if (this.commentDeleteArmed && session.clock > this.commentDeleteArmedUntil) { this.commentDeleteArmed = null; }

    // Polish round P-A1: a clipped, pixel-scrolled list (only the rows in view are drawn)
    const top = shell.beginScroll(this.commentScroll, input, x, y, width, bottom - y);
    const cw = width - this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.commentScroll.visibleRows(rowH, list.length);
    x += this.s(8);
    width = cw - this.s(16);

    let go: CommentRecord | null = null, open: CommentRecord | null = null, remove: CommentRecord | null = null, tick: CommentRecord | null = null;
    let tickRun = false;
    const buttonW = this.s(70), gap = this.s(6);
    const buttonsW = buttonW * 3 + gap * 2;
    const thumbW = this.s(120), thumbH = this.s(68);
    const tickW = this.s(30); // C-B3: the tick column
    const ctrl = input.isDown(Vk.CONTROL), shift = input.isDown(Vk.SHIFT);
    for (let i = first; i < last; i++) {
      const record = list[i];
      const ry = top + i * rowH + this.s(4);
      if ((i & 1) === 0) { ui.rect(x - this.s(8), ry - this.s(4), width + this.s(16), rowH - this.s(4), UiTheme.ROW_STRIPE); }

      // Status bar on the left edge, the tick (C-B3), then the thumbnail
      ui.rect(x - this.s(8), ry - this.s(4), this.s(3), rowH - this.s(4), statusColour(record.status));
      const ticked = this.commentSelected.has(record);
      if (ticked) { ui.rect(x - this.s(5), ry - this.s(4), width + this.s(13), rowH - this.s(4), Rgba.hex(0x22d3ee, 0.10)); }
      const box = this.s(18), boxY = ry + thumbH * 0.5 - box * 0.5;
      const tickHover = w.hover(x - this.s(4), ry - this.s(4), tickW, rowH - this.s(4));
      ui.rect(x, boxY, box, box, ticked ? UiTheme.ACCENT : tickHover ? Rgba.hex(0xffffff, 0.12) : UiTheme.CONTROL);
      ui.outline(x, boxY, box, box, Math.max(1, ui.scale), ticked ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
      if (ticked) { w.tick(x, boxY, box, Rgba.hex(0x06232a)); }
      if (tickHover && input.leftPressed) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        tick = record;
        tickRun = shift;
      }
      this.drawCommentThumbnail(f, record, x + tickW, ry, thumbW, thumbH);

      const textX = x + tickW + thumbW + this.s(14);
      const textW = width - buttonsW - tickW - thumbW - this.s(30);
      const header = record.header + (record.clashId ? ' · CLASH' : '') + (record.level ? ` · ${record.level}` : '');
      ui.textWrapped(f.small, textX, ry + this.s(2), textW, header, UiTheme.COMMENT_LABEL, 1);
      ui.textWrapped(f.body, textX, ry + this.s(20), textW, record.text, record.status === CommentStatus.CLOSED ? UiTheme.TEXT_MUTED : UiTheme.TEXT, 1);
      this.issueLine(f, record, textX, ry + this.s(46), textW);

      const bx = x + width - buttonsW, by = ry + this.s(18);
      if (w.smallButton(f, bx, by, buttonW, this.s(30), 'GO')) { go = record; }
      if (w.smallButton(f, bx + buttonW + gap, by, buttonW, this.s(30), 'OPEN')) { open = record; }
      const armed = this.commentDeleteArmed === record;
      if (w.smallButton(f, bx + (buttonW + gap) * 2, by, buttonW, this.s(30), armed ? 'SURE?' : 'DELETE', true)) { remove = record; }

      // Ctrl+click (or Shift+click) on the rest of the row ticks it too (C-B3)
      if ((ctrl || shift) && input.leftPressed && w.hover(x - this.s(8), ry - this.s(4), width + this.s(16), rowH - this.s(4))) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        tick = record;
        tickRun = shift;
      }
    }
    shell.endScroll(this.commentScroll, input, top + list.length * rowH);

    // Act after drawing (the list must not change while it is being walked)
    if (tick) { this.tickComment(tick, tickRun); }
    else if (go) { this.goToComment(go); }
    else if (open) {
      this.commentDetail = open;
      this.commentDetailScroll.reset();
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
  private buildCommentDetail(f: FontAtlas, record: CommentRecord): void {
    const session = this.session, ui = session.ui, w = this.w, comments = session.comments, shell = session.shell, input = session.input;
    const REPLY = 'REPLY…';
    const frame = shell.beginPanel(PanelSize.Standard, 'COMMENT', UiTheme.COMMENT_LABEL, record.level ? `${record.header} · ${record.level}` : record.header,
      shell.buttonWidth(f, REPLY));
    if (shell.headerButton(frame, REPLY, ShellStyle.Primary)) { session.editor.replyToComment(record); }
    const ix = frame.ix;

    // Polish round P-A1: the picture, the issue fields and the whole thread scroll as one
    let cy = shell.beginScroll(this.commentDetailScroll, input, frame.ix, frame.bodyTop, frame.iw, frame.bodyBottom - frame.bodyTop);
    const iw = frame.iw - this.s(UiTheme.SCROLL_GUTTER);

    // Picture (left) and the issue fields (right)
    const picW = Math.min(this.s(384), iw * 0.42), picH = picW * 9 / 16;
    this.drawCommentThumbnail(f, record, ix, cy, picW, picH);

    // Markup (review tools round): on the picture's corner; MARKED UP when it carries markup
    if (record.snapshotData) {
      const mw = this.s(96), mh = this.s(26);
      if (w.smallButton(f, ix + picW - mw - this.s(6), cy + picH - mh - this.s(6), mw, mh, 'MARKUP…')) {
        ui.popClip(); // the scroll region ends here: the markup editor takes over
        session.markup.show(record, false);
        return;
      }
      if (hasMarkup(record)) {
        ui.rect(ix + this.s(6), cy + picH - mh - this.s(6), this.s(92), mh, Rgba.hex(0x0c0e12, 0.75));
        ui.textCentred(f.small, ix + this.s(6) + this.s(46), cy + picH - mh - this.s(6) + mh * 0.5 - f.small.lineHeight * 0.5, 'MARKED UP', UiTheme.COMMENT_LABEL, this.s(0.6));
      }
    }
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

    cy = this.buildReplies(f, record, ix, cy, iw);
    shell.endScroll(this.commentDetailScroll, input, cy);

    // GO TO VIEW · SET VIEW HERE · EDIT TEXT · DELETE (← LIST returns to the list, as Esc)
    const goTo = shell.footerAction('GO TO VIEW');
    const setView = shell.footerAction('SET VIEW HERE');
    const edit = shell.footerAction('EDIT TEXT');
    const armed = this.commentDeleteArmed === record && session.clock <= this.commentDeleteArmedUntil;
    const del = shell.footerAction(armed ? 'SURE?' : 'DELETE', ShellStyle.Danger);
    const pressed = shell.endPanel(frame, this.commentsNotice, 'REPLY… adds to the thread · ← LIST (or Esc) returns to the list', '← LIST');
    if (pressed === FOOTER_LEFT) { return; }
    if (pressed === goTo) { this.goToComment(record); return; }
    if (pressed === setView) {
      // Where the player stands now (the picture is taken from the 3D view behind the menu, next frame)
      const p = session.player;
      comments.setView(record, p.feet, p.yaw, p.pitch, p.flying, session.section.current);
      session.commentThumbnailFor = record;
      session.markup.afterCapture = record; // then the markup editor (SKIP keeps the clean picture)
      this.commentsNotice = 'View and picture set to where you stand';
      session.sound.play(SoundId.Commit);
    } else if (pressed === edit) {
      session.editor.editCommentText(record);
    } else if (pressed === del) {
      this.deleteComment(record);
      if (!comments.comments.includes(record)) { this.commentDetail = null; }
    }
  }

  /** The reply thread (oldest first, inside the detail view's scroll region), each with its author, date and DELETE. Returns its bottom. */
  private buildReplies(f: FontAtlas, record: CommentRecord, x: number, y: number, width: number): number {
    const session = this.session, ui = session.ui, w = this.w;
    const replies = record.replies ?? [];
    if (replies.length === 0) {
      ui.text(f.body, x, y + this.s(4), 'No replies yet: REPLY… adds one.', UiTheme.TEXT_MUTED);
      return y + this.s(32);
    }

    const rowH = this.s(58);
    if (this.replyDeleteArmed && session.clock > this.replyDeleteArmedUntil) { this.replyDeleteArmed = null; }

    let remove: CommentReply | null = null;
    for (let i = 0; i < replies.length; i++) {
      const reply = replies[i];
      const ry = y + i * rowH;
      if (!this.commentDetailScroll.inView(ry, rowH)) { continue; }
      ui.rect(x, ry, this.s(2), rowH - this.s(10), UiTheme.COMMENT);
      ui.text(f.small, x + this.s(12), ry, `${reply.author.toUpperCase()} · ${shortDate(reply.created)}`, UiTheme.COMMENT_LABEL, this.s(0.6));
      ui.textWrapped(f.body, x + this.s(12), ry + this.s(18), width - this.s(110), reply.text, UiTheme.TEXT, 2);
      const armed = this.replyDeleteArmed === reply;
      if (w.smallButton(f, x + width - this.s(84), ry + this.s(4), this.s(84), this.s(28), armed ? 'SURE?' : 'DELETE', true)) { remove = reply; }
    }
    const bottom = y + replies.length * rowH;

    if (!remove) { return bottom; }
    if (this.replyDeleteArmed === remove) {
      session.comments.removeReply(record, remove);
      this.replyDeleteArmed = null;
      this.commentsNotice = 'Reply deleted';
      session.sound.play(SoundId.Remove);
    } else {
      this.replyDeleteArmed = remove;
      this.replyDeleteArmedUntil = session.clock + 3;
    }
    return bottom;
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
      session.clashes.unlinkComments([record]);
      this.commentSelected.delete(record);
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
    this.commentScroll.reset();
    this.commentDeleteArmed = null;
  }

  private matchesCommentFilter(record: CommentRecord): boolean {
    if (this.commentTypeFilter === 1 && record.clashId) { return false; } // C-B3: issues only
    if (this.commentTypeFilter === 2 && !record.clashId) { return false; } // clashes only
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

  /** Opens the bookmark list. */
  openBookmarks(): void {
    this.bookmarksOpen = true;
    this.bookmarkScroll.reset();
    this.bookmarkDeleteArmed = null;
    this.bookmarksNotice = null;
  }

  /** One level back: the list closes (Round K-A: the tour settings moved to MEDIA → TOUR); false when it wasn't open. */
  closeBookmarks(): boolean {
    if (!this.bookmarksOpen) { return false; }
    this.bookmarksOpen = false;
    this.bookmarkDeleteArmed = null;
    return true;
  }

  /** A notice under the bookmark list (tour and video messages). */
  setBookmarksNotice(notice: string): void {
    this.bookmarksNotice = notice;
  }

  private buildBookmarksPanel(): void {
    const session = this.session, ui = session.ui, f = ui.atlas, shell = session.shell;
    const count = session.bookmarks.bookmarks.length;
    const ADD = 'ADD THIS VIEW';
    const frame = shell.beginPanel(PanelSize.Standard, 'BOOKMARKS', UiTheme.BOOKMARK_LABEL,
      `${count.toLocaleString('en')} ${count === 1 ? 'viewpoint' : 'viewpoints'} · kept in ${session.bookmarks.fileName}`, shell.buttonWidth(f, ADD));
    if (shell.headerButton(frame, ADD)) {
      const added = session.addBookmarkFromMenu();
      this.bookmarksNotice = `Added “${added.name}” (RENAME to change it)`;
      this.bookmarkScroll.scrollToEnd();
    }

    this.buildBookmarkRows(f, frame.ix, frame.bodyTop, frame.iw, frame.bodyBottom);
    if (!this.bookmarksOpen) { return; } // GO / RENAME left the panel

    const settings = shell.footerAction('TOUR SETTINGS'); // Round K-A: MEDIA → TOUR
    const play = shell.footerAction('PLAY TOUR', ShellStyle.Primary);
    const pressed = shell.endPanel(frame, this.bookmarksNotice, Hints.bookmarksKeys.text);
    if (pressed === settings) {
      this.closeBookmarks();
      session.media.open(MediaTab.Tour);
    } else if (pressed === play) {
      session.tour.start();
    }
  }

  /** The rows (a clipped scroll region): number, thumbnail, name, details and GO / RENAME / SET HERE / ↑ / ↓ / DELETE. */
  private buildBookmarkRows(f: FontAtlas, x: number, y: number, width: number, bottom: number): void {
    const session = this.session, ui = session.ui, w = this.w, input = session.input, shell = session.shell;
    const list = session.bookmarks.bookmarks;
    const rowH = this.s(74);

    if (list.length === 0) {
      ui.textWrapped(f.body, x, y + this.s(8), width, Hints.bookmarksEmpty.text, UiTheme.TEXT_MUTED, 2);
      return;
    }
    if (this.bookmarkDeleteArmed && session.clock > this.bookmarkDeleteArmedUntil) { this.bookmarkDeleteArmed = null; }

    // Polish round P-A1: a clipped, pixel-scrolled list (rows drawn from 4 px inside, so the stripe fits)
    const top = shell.beginScroll(this.bookmarkScroll, input, x, y, width, bottom - y);
    const cw = width - this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.bookmarkScroll.visibleRows(rowH, list.length);
    const listX = x;
    x += this.s(8);
    width = cw - this.s(16);

    let go: BookmarkRecord | null = null, rename: BookmarkRecord | null = null, here: BookmarkRecord | null = null;
    let up: BookmarkRecord | null = null, down: BookmarkRecord | null = null, remove: BookmarkRecord | null = null;
    const small = this.s(34), wide = this.s(84), gap = this.s(6);
    const buttonsW = wide * 4 + small * 2 + gap * 5;
    for (let i = first; i < last; i++) {
      const record = list[i];
      const ry = top + i * rowH + this.s(4);
      if ((i & 1) === 0) { ui.rect(listX, ry - this.s(4), cw, rowH - this.s(4), UiTheme.ROW_STRIPE); }

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
    shell.endScroll(this.bookmarkScroll, input, top + list.length * rowH);

    // Act after drawing (the list must not change while it is being walked)
    if (go) {
      this.closeBookmarks();
      session.setPaused(false);
      session.goToBookmark(go);
    } else if (rename) {
      this.closeBookmarks();
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

type EditMode = 'comment' | 'bookmark' | 'user' | 'reply' | 'assign' | 'sunStudy' | 'custom';

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
  /** Any other short text (Round C: clash test / set names, rule values, clash assignee and notes): what Enter does. */
  private customCommit: ((text: string) => void) | null = null;
  private customTitle = '';

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

  /** A name for the finished sun / daylight study (same name replaces). */
  nameSunStudy(suggestion: string, max: number): void {
    this.start('sunStudy', max, suggestion.slice(0, max));
    this.level = null;
  }

  /** The author name (from the pause menu; returns there afterwards). */
  renameUser(): void {
    this.start('user', 40, this.session.settings.userName);
    this.resumeMenuAfter = true;
    this.session.paused = false;
  }

  /**
   * Opens the text box for any short text: commit gets the trimmed text on Enter; Esc leaves everything as it was.
   * @param level The second part of the heading (default: an em dash).
   */
  beginCustom(title: string, initial: string | null, max: number, commit: (text: string) => void, level: string | null = null): void {
    this.start('custom', max, (initial ?? '').slice(0, max));
    this.customCommit = commit;
    this.customTitle = title;
    this.level = level;
    this.session.input.releaseAll();
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
    if (this.mode === 'custom') {
      this.customCommit = null;
      session.toast('Not changed');
    } else if (this.mode === 'bookmark') {
      if (this.bookmarkIsNew && session.thumbnailFor === this.bookmark) { session.thumbnailFor = null; }
      session.toast(this.bookmarkIsNew ? 'Bookmark cancelled (nothing was saved)' : 'Name not changed');
    } else if (this.mode === 'sunStudy') {
      session.toast('Study not saved');
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

    if (mode === 'custom') {
      const commit = this.customCommit;
      this.customCommit = null;
      commit?.(text);
      return;
    }

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

    if (mode === 'sunStudy') {
      void session.sunHours.saveStudy(text);
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
    const added = session.comments.add(this.point, text, this.elementId, this.level, session.uniqueIdOf(this.elementId));
    const p = session.player;
    session.comments.setView(added, p.feet, p.yaw, p.pitch, p.flying, session.section.current);
    session.commentThumbnailFor = added;
    session.markup.afterCapture = added; // the markup editor opens once the picture is taken
    session.sound.play(SoundId.CommentPlace);
    session.toast(`Comment added (kept in ${session.comments.fileName})`);
  }

  build(): void {
    const session = this.session, ui = session.ui, f = ui.atlas;
    const w = this.s(460);
    const textHeight = Math.max(f.body.lineHeight * 1.15, ui.textWrapped(f.body, 0, 0, w - this.s(48), this.text, 0, 10, false));
    const h = this.s(96) + textHeight;
    const x = session.screenWidth * 0.5 - w * 0.5, y = session.screenHeight * 0.5 + this.s(48);

    const naming = this.mode === 'bookmark' || this.mode === 'user' || this.mode === 'custom';
    const study = this.mode === 'sunStudy';
    const frame = study ? UiTheme.SUN : naming ? UiTheme.BOOKMARK : UiTheme.COMMENT;
    const label = study ? UiTheme.SUN_LABEL : naming ? UiTheme.BOOKMARK_LABEL : UiTheme.COMMENT_LABEL;
    ui.panel(x, y, w, h, UiTheme.PANEL_STRONG, frame);
    const title = this.mode === 'custom' ? `${this.customTitle} · ${this.level ?? '—'}`
      : this.mode === 'user' ? 'YOUR NAME (SHOWN ON COMMENTS)'
      : study ? 'SUN STUDY NAME (same name replaces)'
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
