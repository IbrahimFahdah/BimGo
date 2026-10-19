import { RuleField, type SearchSet } from '../core/clashes/ClashModels';
import { SearchSets } from '../core/clashes/SearchSets';
import {
  Appearance, type AppearanceProfile, type AppearanceSettings, AppearanceProfiler, BinMethod, copyProfile, isBySet, newProfileRule, type ProfileResult,
  ProfileFiles, type ProfileRule, ruleRgb, UnmatchedLook
} from '../core/scene/AppearanceProfiles';
import { ParameterTable } from '../core/scene/ModelInfo';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { pickColour } from '../platform/colour';
import { downloadBlob, pickFile, safeFileName } from '../platform/files';
import { keyOf } from '../platform/Hotkeys';
import { InputAction } from '../core/scene/InputCatalog';
import type { InputState } from '../platform/input';
import { ClashViewMode } from './clashes/Clashes';
import type { GameSession } from './GameSession';
import { FOOTER_LEFT, PanelSize, ScrollRegion } from './PanelShell';

/** One legend row: swatch, label and count (made when the profile is evaluated). */
interface LegendRow { colour: number; label: string; count: string; off: boolean }

const PROFILE_KIND_LABELS = ['BY VALUE', 'BY SEARCH SET'];
const PROFILE_VALUE_MODES = ['Each value', 'Ranges'];
const PROFILE_TRANSPARENCY_LABELS = ['0 %', '10 %', '20 %', '30 %', '40 %', '50 %', '60 %', '70 %', '80 %', '90 %'];
const DROP = { field: 40, palette: 41, set: 42, addSet: 43, transparency: 44, ramp: 45 } as const;
const SLIDER_PROFILE_DETAIL = 70;
/** Most legend rows shown before "+ n more". */
const PROFILE_LEGEND_ROWS = 14;

const footerHint = () => `${keyOf(InputAction.ColourProfile)}: show / hide while walking and in clash mode · extra parameters: Revit Options → Parameters`;
const emptyHint = () => 'No colour profiles yet. NEW BY VALUE colours elements by a field or an extracted parameter (one colour per value); '
  + 'NEW BY SET colours clash detection\'s search sets (the first set an element is in wins). '
  + `${keyOf(InputAction.ColourProfile)} shows or hides the active profile while walking and in clash mode.`;

/**
 * Colour round A / B (port of GameSession.ColourProfiles.cs and .ColourProfilesPanel.cs): colour profiles as
 * Navisworks' appearance profiler. A profile colours elements by search set or by the values of a field or extracted
 * parameter; the rest are ghosted, keep their colours or take one flat colour. Saved per model (visibility.json →
 * appearance); one is active and the colour profile key (Shift+C) shows or hides it. The panel replaces the pause menu
 * on the right so the model shows beside it.
 */
export class ColourProfiles {
  private appearance: AppearanceSettings = Appearance.defaults();
  private dirty = true;
  private result: ProfileResult | null = null;
  private resultFor: string | null = null;
  private failure: string | null = null;
  private readonly legend: LegendRow[] = [];
  private legendTitle = '';
  private legendFooter: string | null = null;
  /** Colour round B: elements hidden by their row, and the result applied. */
  private hidden: boolean[] | null = null;
  private hiddenFrom: ProfileResult | null = null;

  /** True while the panel replaces the pause menu. */
  panelOpen = false;
  /** EDIT SETS… came from here: the CLASHES panel returns here when it closes. */
  returnFromClashes = false;
  private readonly listScroll = new ScrollRegion();
  private readonly rowScroll = new ScrollRegion();

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  // #region State

  /** The active profile, or null. */
  get active(): AppearanceProfile | null { return Appearance.find(this.appearance, this.appearance.active); }

  /** True when the active profile colours the model. */
  get showing(): boolean { return this.appearance.on && this.active !== null && this.failure === null; }

  /** Restores the saved profiles (with the visibility, at load). */
  restore(saved: AppearanceSettings | null): void {
    this.appearance = saved ? Appearance.clean(Appearance.copy(saved)) : Appearance.defaults();
    this.dirty = true;
  }

  /** The profiles for visibility.json (null when there are none). */
  forSave(): AppearanceSettings | null {
    return Appearance.isDefault(this.appearance) ? null : Appearance.copy(this.appearance);
  }

  /** A profile (or which one is active, or on / off) changed: evaluated again before the next frame, saved with the model. */
  changed(): void {
    Appearance.clean(this.appearance);
    this.dirty = true;
    this.session.visibilityChanged();
  }

  /** Something that needs no new evaluation changed (shown / hidden, the legend, the surface detail). */
  lookChanged(): void {
    Appearance.clean(this.appearance);
    const profile = this.active;
    if (profile) { this.session.renderer.setProfileDetail(profile.detail); }
    this.session.visibilityChanged();
  }

  /** The search sets changed (CLASHES panel, import): a by-set profile is evaluated again. */
  setsChanged(): void {
    if (this.active && isBySet(this.active)) { this.dirty = true; }
  }

  /** The Appearance tab's row text: the active profile and whether it shows. */
  summary(): string {
    const profile = this.active;
    return profile ? `${profile.name}${this.appearance.on ? ' · on' : ' · off'}` : 'none';
  }

  /** P-C: the active profile's id for a bookmark ("" = none showing). */
  bookmarkProfile(): string {
    return this.showing ? this.appearance.active ?? '' : '';
  }

  /** P-C: shows a bookmark's (or a path key's) profile ("" switches profiles off; an unknown id leaves it alone). */
  applySaved(id: string | null): void {
    if (id === null) { return; }
    if (id === '') {
      if (this.appearance.on) { this.appearance.on = false; this.lookChanged(); }
      return;
    }
    if (!Appearance.find(this.appearance, id)) { return; }
    if (this.appearance.active !== id || !this.appearance.on) {
      this.appearance.active = id;
      this.appearance.on = true;
      this.failure = null;
      this.changed();
    }
  }

  // #endregion

  // #region Evaluation

  /** Once a frame before drawing: evaluates the active profile when something changed; tells the renderer whether to show it. */
  update(): void {
    const renderer = this.session.renderer;
    const profile = this.active;
    if (this.dirty && profile && (this.appearance.on || this.panelOpen)) {
      this.dirty = false;
      this.evaluate(profile);
    } else if (!profile && this.result) {
      this.result = null;
      this.resultFor = null;
      this.legend.length = 0;
      renderer.clearProfile();
    }
    renderer.profileOn = this.showing && renderer.hasProfile;
    this.applyHidden();
  }

  /** True when the shown profile hides an element (its row is hidden). */
  hides(element: number): boolean {
    return this.hidden !== null && element >= 0 && element < this.hidden.length && this.hidden[element];
  }

  /** Colour round B: hides the elements of hidden rows while the profile shows (drawing, shadows, picking, collision). */
  private applyHidden(): void {
    const want = this.showing && this.result && this.result.anyHidden && this.resultFor === this.appearance.active ? this.result : null;
    if (want === this.hiddenFrom) { return; }
    this.hiddenFrom = want;
    if (!want && !this.hidden) { return; }
    const count = this.session.scene.elements.length;
    this.hidden ??= new Array<boolean>(count).fill(false);
    this.session.dynamics.sourceHidden = this.hidden; // P-C: moved / cloned copies of hidden rows hide too
    let changed = false;
    for (let e = 0; e < this.hidden.length; e++) {
      const hide = want !== null && e < want.codes.length && (want.codes[e] >>> 24) === AppearanceProfiler.CODE_HIDDEN;
      if (hide === this.hidden[e]) { continue; }
      this.hidden[e] = hide;
      changed = true;
      this.session.profileHiddenChanged(e);
    }
    if (changed) { this.session.bumpSceneRevision(); }
  }

  /** Evaluates a profile (by set: switches clash detection's sets on; by value: adds rows for new values) and uploads it. */
  private evaluate(profile: AppearanceProfile): void {
    const session = this.session;
    try {
      if (isBySet(profile)) { session.clashes.ensure(); }
      else if (AppearanceProfiler.syncValues(profile, session.scene) > 0 && this.resultFor === profile.id) { session.visibilityChanged(); }
      const document = session.clashes.document;
      const result = AppearanceProfiler.evaluate(profile, session.scene, id => (document && id ? document.sets.find(s => s.id === id) ?? null : null));
      this.result = result;
      this.resultFor = profile.id;
      this.failure = session.renderer.setProfile(result.codes, profile.detail, result.anyBlended);
      if (this.failure) {
        this.appearance.on = false;
        session.toast(this.failure, 5, true);
      }
      this.buildLegendRows(profile, result);
    } catch (e) {
      console.warn(`Colour profile "${profile.name}" failed:`, e);
      this.failure = 'The colour profile couldn\'t be shown (see the console).';
      session.toast(this.failure, 5, true);
    }
  }

  private buildLegendRows(profile: AppearanceProfile, result: ProfileResult): void {
    this.legend.length = 0;
    this.legendTitle = profile.name.toUpperCase();
    profile.rules.forEach((rule, r) => {
      const count = r < result.ruleCounts.length ? result.ruleCounts[r] : 0;
      if (!isBySet(profile) && count === 0) { return; }
      const n = count.toLocaleString('en');
      const countText = !rule.on ? 'off' : rule.hidden ? `${n} hidden` : rule.transparency > 0 ? `${n} · ${Math.round(rule.transparency * 100)} %` : n;
      this.legend.push({ colour: Rgba.hex(ruleRgb(rule)), label: this.ruleLabel(profile, rule), count: countText, off: !rule.on || rule.hidden });
    });
    const look = UnmatchedLook.normalise(profile.unmatched);
    const rest = look === UnmatchedLook.GHOST ? 'ghosted' : look === UnmatchedLook.FLAT ? 'flat colour' : 'normal colours';
    let footer: string | null = result.unmatched > 0 ? `Others (${result.unmatched.toLocaleString('en')}): ${rest}` : null;
    if (result.noNumber > 0) { footer = (footer === null ? '' : footer + ' · ') + `${result.noNumber.toLocaleString('en')} without a number`; }
    if (result.missingSets > 0) { footer = (footer === null ? '' : footer + ' · ') + `${result.missingSets} set${result.missingSets === 1 ? '' : 's'} missing`; }
    this.legendFooter = footer;
  }

  /** A row's label: the set's name (or "(missing set)"), or the value's label. */
  private ruleLabel(profile: AppearanceProfile, rule: ProfileRule): string {
    if (isBySet(profile)) { return this.findSet(rule.setId)?.name ?? '(missing set)'; }
    if (rule.label) { return rule.label; }
    return SearchSets.valueLabel(profile.field, rule.value ?? '', false, this.session.scene);
  }

  private findSet(id: string | null): SearchSet | null {
    const document = this.session.clashes.document;
    return document && id ? document.sets.find(s => s.id === id) ?? null : null;
  }

  // #endregion

  // #region Hotkey and legend

  /** The colour profile key (Shift+C): shows or hides the active profile; with none yet, says where to make one. */
  toggle(): void {
    const session = this.session;
    const profile = this.active;
    if (!profile) {
      session.sound.play(SoundId.Error);
      session.toast('No colour profile yet: Esc → Appearance → Colour profiles', 3.5);
      return;
    }
    this.appearance.on = !this.appearance.on;
    this.failure = null;
    this.lookChanged();
    session.sound.play(SoundId.UiClick);
    const where = session.clashModeOn && session.clashes.view !== ClashViewMode.REAL ? ' (shows in the real model view: G)' : '';
    session.toast(this.appearance.on ? `Colour profile: ${profile.name}${where}` : 'Colour profile off', 2.5);
  }

  /** The on-screen legend is wanted (a profile shows with its legend ticked; clash mode: the real view). */
  get legendWanted(): boolean {
    const session = this.session;
    return this.showing && this.appearance.legend && this.result !== null && this.resultFor === this.appearance.active
      && (!session.clashModeOn || session.clashes.view === ClashViewMode.REAL);
  }

  /** Colour round B: the legend is wanted in photos and screenshots. */
  get legendInShots(): boolean {
    return this.appearance.legendInShots && this.showing && this.result !== null && this.resultFor === this.appearance.active;
  }

  /** The on-screen legend in the left-hand column (P-A2): top to bottom, collapsed to its title row when asked. */
  buildLegend(f: FontAtlas, top: number, bottom: number, collapsed: boolean): void {
    if (!this.legendWanted) { return; }
    this.drawLegend(f, this.s(20), top, bottom, false, collapsed);
  }

  /** Colour round B: queues the legend for a photo or screenshot, bottom left of a target of this size. */
  queueLegendForShot(height: number): void {
    if (!this.legendInShots) { return; }
    this.drawLegend(this.session.ui.atlas, this.s(20), this.s(20), height - this.s(20), true, false);
  }

  private drawLegend(f: FontAtlas, x: number, top: number, bottom: number, anchorBottom: boolean, collapsed: boolean): void {
    const ui = this.session.ui;
    const w = this.s(250), rowH = this.s(20);
    let shown = Math.min(this.legend.length, PROFILE_LEGEND_ROWS);
    const fit = Math.max(1, Math.trunc((bottom - top - this.s(54)) / rowH));
    shown = Math.min(shown, fit);
    const more = this.legend.length - shown;
    const h = this.s(34) + shown * rowH + (more > 0 ? rowH : 0) + (this.legendFooter !== null ? rowH : 0) + this.s(8);
    if (collapsed || top + h > bottom) {
      const ch = this.s(UiTheme.LEGEND_COLLAPSED_HEIGHT);
      if (top + ch > bottom) { return; }
      if (anchorBottom) { top = bottom - ch; }
      ui.panel(x, top, w, ch, UiTheme.PANEL, UiTheme.PANEL_BORDER);
      ui.textWrapped(f.small, x + this.s(12), top + Math.round((ch - f.small.lineHeight) * 0.5), w - this.s(24), this.legendTitle, UiTheme.ACCENT, 1);
      return;
    }
    if (anchorBottom) { top = bottom - h; }
    ui.panel(x, top, w, h, UiTheme.PANEL, UiTheme.PANEL_BORDER);
    ui.textWrapped(f.small, x + this.s(12), top + this.s(10), w - this.s(24), this.legendTitle, UiTheme.ACCENT, 1);
    let y = top + this.s(32);
    for (let i = 0; i < shown; i++) {
      const row = this.legend[i];
      ui.rect(x + this.s(12), y + this.s(3), this.s(14), this.s(12), row.off ? Rgba.withAlpha(row.colour, 0.3) : row.colour);
      ui.textWrapped(f.small, x + this.s(34), y + this.s(1), w - this.s(34) - this.s(64), row.label, row.off ? UiTheme.TEXT_FAINT : UiTheme.TEXT, 1);
      ui.textRight(f.small, x + w - this.s(12), y + this.s(1), row.count, UiTheme.TEXT_MUTED);
      y += rowH;
    }
    if (more > 0) {
      ui.text(f.small, x + this.s(12), y + this.s(1), `+ ${more} more (Esc → Appearance)`, UiTheme.TEXT_FAINT);
      y += rowH;
    }
    if (this.legendFooter !== null) { ui.textWrapped(f.small, x + this.s(12), y + this.s(1), w - this.s(24), this.legendFooter, UiTheme.TEXT_MUTED, 1); }
  }

  // #endregion

  // #region Panel

  /** Opens the panel (the counts are worked out again). */
  openPanel(): void {
    const session = this.session;
    if (!session.paused) { session.setPaused(true); }
    this.panelOpen = true;
    this.rowScroll.reset();
    this.dirty = true;
    session.menu.widgets.activeSlider = -1;
    session.menu.closeOverlay();
  }

  /** Esc / BACK: an open dropdown or confirm closes first, then the panel; true if something closed. */
  closePanel(): boolean {
    if (!this.panelOpen) { return false; }
    if (this.session.menu.closeOverlay()) { return true; }
    this.panelOpen = false;
    this.session.menu.widgets.activeSlider = -1;
    return true;
  }

  /** Draws and handles the panel. */
  buildPanel(): void {
    const session = this.session, ui = session.ui, f = ui.atlas, input = session.input, w = session.menu.widgets, shell = session.shell;
    const overlays = session.menu.overlays;
    if (!input.leftDown) { w.activeSlider = -1; }
    overlays.begin(input);

    const checkW = this.s(100);
    const shown = this.active;
    const frame = shell.beginPanel(PanelSize.Side, 'COLOUR PROFILES', UiTheme.ACCENT, shown ? shown.name : 'No profile yet',
      checkW * 3 + this.s(20) + this.s(UiTheme.GAP_SMALL) * 2);
    const checkY = frame.headerControlY + (frame.headerControlH - this.s(16)) * 0.5;
    const legendX = shell.takeHeaderSlot(frame, checkW, this.s(UiTheme.GAP_SMALL));
    const showX = shell.takeHeaderSlot(frame, checkW, this.s(UiTheme.GAP_SMALL));
    const shotsX = shell.takeHeaderSlot(frame, checkW + this.s(20), 0);
    const ix = frame.ix, iw = frame.iw;
    const cy = frame.bodyTop;
    const shots = w.checkbox(f, shotsX, checkY, checkW + this.s(20), 'In photos', this.appearance.legendInShots);
    if (shots !== this.appearance.legendInShots) {
      this.appearance.legendInShots = shots;
      this.lookChanged();
      if (shots) { session.toast('The legend goes into photos (stills) and screenshots while the profile shows', 3.5); }
    }
    const show = w.checkbox(f, showX, checkY, checkW - this.s(10), 'Show', this.appearance.on);
    if (show !== this.appearance.on) {
      if (show && !this.active) { session.toast('Make a profile first: NEW BY VALUE or NEW BY SET', 3); }
      else {
        this.appearance.on = show;
        this.failure = null;
        this.lookChanged();
      }
    }
    const legend = w.checkbox(f, legendX, checkY, checkW, 'Legend', this.appearance.legend);
    if (legend !== this.appearance.legend) {
      this.appearance.legend = legend;
      this.lookChanged();
    }
    const bottom = frame.bodyBottom;
    const lw = Math.min(this.s(240), iw * 0.34);
    const rx = ix + lw + this.s(20), rw = iw - lw - this.s(20);
    ui.rect(rx - this.s(10), cy, Math.max(1, ui.scale), bottom - cy, UiTheme.CARD_BORDER);
    this.buildList(f, input, ix, cy, lw, bottom);
    const profile = this.active;
    if (profile) { this.buildEditor(f, input, profile, rx, cy, rw, bottom); }
    else { ui.textWrapped(f.body, rx, cy + this.s(4), rw, emptyHint(), UiTheme.TEXT_SOFT, 8); }

    if (shell.endPanel(frame, null, footerHint()) === FOOTER_LEFT || !this.panelOpen) { return; }
    overlays.draw(f, input, frame.x, frame.y, frame.w, frame.h);
  }

  /** The profiles (a click makes one active) and the buttons under them. */
  private buildList(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, shell = session.shell, wd = session.menu.widgets, overlays = session.menu.overlays;
    const buttonsH = this.s(32) * 5 + this.s(6) * 4;
    const listBottom = bottom - buttonsH - this.s(10);
    const rowH = this.s(48);
    const profiles = this.appearance.profiles;
    const top = shell.beginScroll(this.listScroll, input, x, y, w, listBottom - y);
    const cw = w - this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.listScroll.visibleRows(rowH, profiles.length);
    let pick: AppearanceProfile | null = null;
    for (let i = first; i < last; i++) {
      const p = profiles[i];
      const ry = top + i * rowH;
      const current = p.id === this.appearance.active;
      const hover = wd.hover(x, ry, cw, rowH - this.s(4));
      ui.rect(x, ry, cw, rowH - this.s(4), current ? Rgba.hex(0x22d3ee, 0.14) : hover ? Rgba.hex(0xffffff, 0.07) : Rgba.hex(0xffffff, 0.03));
      if (current) { ui.rect(x, ry, this.s(3), rowH - this.s(4), UiTheme.ACCENT); }
      ui.textWrapped(f.body, x + this.s(12), ry + this.s(5), cw - this.s(20), p.name, current ? UiTheme.ACCENT : UiTheme.TEXT, 1);
      ui.textWrapped(f.small, x + this.s(12), ry + this.s(25), cw - this.s(20), isBySet(p) ? 'By search set' : `By ${AppearanceProfiler.fieldLabel(p)}`, UiTheme.TEXT_MUTED, 1);
      if (hover && input.leftPressed && !current) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        pick = p;
      }
    }
    if (profiles.length === 0) { ui.text(f.small, x, y + this.s(4), '(none yet)', UiTheme.TEXT_FAINT); }
    shell.endScroll(this.listScroll, input, top + profiles.length * rowH);
    if (pick) {
      this.appearance.active = pick.id;
      this.rowScroll.reset();
      this.changed();
    }

    let by = bottom - buttonsH;
    if (wd.smallButton(f, x, by, w, this.s(32), 'NEW BY VALUE')) { this.add(AppearanceProfiler.newByValue('By level', RuleField.LEVEL, null, session.scene)); }
    by += this.s(38);
    if (wd.smallButton(f, x, by, w, this.s(32), 'NEW BY SET')) { this.add(AppearanceProfiler.newBySet('By search set', session.clashes.ensure().sets)); }
    by += this.s(38);
    const active = this.active;
    const half = (w - this.s(6)) * 0.5;
    if (wd.smallButton(f, x, by, half, this.s(32), 'DUPLICATE') && active) {
      const copy = copyProfile(active, true);
      copy.name = active.name + ' (copy)';
      this.appearance.profiles.splice(this.appearance.profiles.indexOf(active) + 1, 0, copy);
      this.appearance.active = copy.id;
      this.changed();
    }
    if (wd.smallButton(f, x + half + this.s(6), by, half, this.s(32), 'RENAME') && active) {
      const target = active;
      session.editor.beginCustom('PROFILE NAME', target.name, 60, text => {
        if (text.length === 0) { return; }
        target.name = text;
        this.changed();
      });
    }
    by += this.s(38);
    if (wd.smallButton(f, x, by, half, this.s(32), 'EXPORT…') && active) {
      if (this.appearance.profiles.length === 1) { this.exportProfiles(false); }
      else {
        overlays.openChoice('EXPORT PROFILES', `Export "${active.name}" or all ${this.appearance.profiles.length} profiles? By-set profiles take their search sets with them.`,
          'THIS ONE', false, null, 'ALL', () => this.exportProfiles(false), () => this.exportProfiles(true));
      }
    }
    if (wd.smallButton(f, x + half + this.s(6), by, half, this.s(32), 'IMPORT…')) { void this.importProfiles(); }
    by += this.s(38);
    if (wd.smallButton(f, x, by, w, this.s(32), 'DELETE', true) && active) {
      const target = active;
      overlays.openConfirm('DELETE PROFILE', `Delete the colour profile "${target.name}"?`, 'DELETE', true, false, () => {
        const index = this.appearance.profiles.indexOf(target);
        this.appearance.profiles.splice(index, 1);
        const list = this.appearance.profiles;
        this.appearance.active = list.length === 0 ? null : list[Math.min(Math.max(index, 0), list.length - 1)].id;
        this.changed();
        session.toast('Profile deleted', 2);
      });
    }
  }

  private add(profile: AppearanceProfile): void {
    this.appearance.profiles.push(profile);
    this.appearance.active = profile.id;
    this.appearance.on = true;
    this.failure = null;
    this.rowScroll.reset();
    this.listScroll.scrollToEnd();
    this.changed();
    this.session.sound.play(SoundId.UiClick);
  }

  /** The active profile's settings and rows. */
  private buildEditor(f: FontAtlas, input: InputState, profile: AppearanceProfile, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, overlays = session.menu.overlays;
    let cy = y;
    ui.textWrapped(f.bold, x, cy + this.s(2), w - this.s(150), profile.name, UiTheme.TEXT, 1);
    ui.textRight(f.small, x + w, cy + this.s(6), PROFILE_KIND_LABELS[isBySet(profile) ? 1 : 0], UiTheme.TEXT_MUTED, this.s(1.2));
    cy += this.s(30);

    const labelW = this.s(90);
    if (isBySet(profile)) {
      ui.text(f.small, x, cy + this.s(9), 'SETS', UiTheme.TEXT_MUTED, this.s(1.2));
      if (wd.smallButton(f, x + labelW, cy, this.s(160), this.s(30), 'EDIT SETS…')) {
        this.returnFromClashes = true;
        this.panelOpen = false;
        session.clashes.panel.show();
        session.clashes.panel.showSets();
        return;
      }
      ui.textWrapped(f.small, x + labelW + this.s(170), cy + this.s(2), w - labelW - this.s(170), 'Search sets live in clash detection (CLASHES → SETS).', UiTheme.TEXT_FAINT, 2);
    } else {
      ui.text(f.small, x, cy + this.s(9), 'COLOUR BY', UiTheme.TEXT_MUTED, this.s(1.2));
      const fieldW = w - labelW - this.s(140);
      if (overlays.button(f, input, x + labelW, cy, fieldW, this.s(30), AppearanceProfiler.fieldLabel(profile), overlays.isDropdownOpen(profile, DROP.field))) {
        this.openFieldDropdown(profile, x + labelW, cy, fieldW);
      }
      if (wd.smallButton(f, x + w - this.s(130), cy, this.s(130), this.s(30), profile.ranges ? 'REBUILD RANGES' : 'REFRESH VALUES')) {
        if (profile.ranges) { this.rebuildRanges(profile); }
        else {
          const added = AppearanceProfiler.syncValues(profile, session.scene);
          this.changed();
          session.toast(added === 0 ? 'No new values' : `${added} new value${added === 1 ? '' : 's'} added`, 2.5);
        }
      }
      cy += this.s(40);
      ui.text(f.small, x, cy + this.s(9), 'VALUES', UiTheme.TEXT_MUTED, this.s(1.2));
      const mode = wd.segmented(f, x + labelW, cy, this.s(220), PROFILE_VALUE_MODES, profile.ranges ? 1 : 0);
      if (mode !== (profile.ranges ? 1 : 0)) { this.setRanges(profile, mode === 1); }
      if (profile.ranges) {
        // P-C: how the ranges are cut, then the bins (− n +) or the break values (BREAKS…)
        cy += this.s(40);
        ui.text(f.small, x, cy + this.s(9), 'CUT BY', UiTheme.TEXT_MUTED, this.s(1.2));
        const binning = BinMethod.normalise(profile.binning);
        const methodW = Math.min(this.s(330), w - labelW - this.s(150));
        const method = wd.segmented(f, x + labelW, cy, methodW, [...BinMethod.LABELS], BinMethod.ALL.indexOf(binning));
        if (method >= 0 && BinMethod.ALL[method] !== binning) {
          profile.binning = BinMethod.ALL[method];
          if (profile.binning === BinMethod.CUSTOM && profile.breaks === null) { this.beginBreaks(profile); } else { this.rebuildRanges(profile); }
        }
        const bx = x + labelW + methodW + this.s(14);
        if (profile.binning === BinMethod.CUSTOM) {
          if (wd.smallButton(f, bx, cy, x + w - bx, this.s(30), 'BREAKS…')) { this.beginBreaks(profile); }
        } else {
          if (wd.smallButton(f, bx, cy, this.s(30), this.s(30), '−') && profile.bins > AppearanceProfiler.MIN_BINS) {
            profile.bins--;
            this.rebuildRanges(profile);
          }
          ui.textCentred(f.bold, bx + this.s(50), cy + this.s(6), String(profile.bins), UiTheme.TEXT);
          if (wd.smallButton(f, bx + this.s(70), cy, this.s(30), this.s(30), '+') && profile.bins < AppearanceProfiler.MAX_BINS) {
            profile.bins++;
            this.rebuildRanges(profile);
          }
        }
      }
    }
    cy += this.s(40);

    // Others: ghosted / normal / flat colour (+ its swatch)
    ui.text(f.small, x, cy + this.s(9), 'OTHERS', UiTheme.TEXT_MUTED, this.s(1.2));
    const flat = UnmatchedLook.normalise(profile.unmatched) === UnmatchedLook.FLAT;
    const segW = w - labelW - (flat ? this.s(46) : 0);
    const look = UnmatchedLook.ALL.indexOf(UnmatchedLook.normalise(profile.unmatched));
    const picked = wd.segmented(f, x + labelW, cy, segW, [...UnmatchedLook.LABELS], look);
    if (picked !== look && picked >= 0) {
      profile.unmatched = UnmatchedLook.ALL[picked];
      this.changed();
    }
    const flatRgb = parseInt(profile.unmatchedColour.replace(/^#/, ''), 16);
    if (flat && this.swatch(input, x + w - this.s(38), cy + this.s(2), this.s(38), this.s(28), Number.isFinite(flatRgb) ? flatRgb : 0xd6dadf, true)) {
      pickColour(Number.isFinite(flatRgb) ? flatRgb : 0xd6dadf, rgb => {
        profile.unmatchedColour = AppearanceProfiler.hex(rgb);
        this.changed();
      });
    }
    cy += this.s(44);

    // Surface detail and the palette (or, for ranges, the ramp)
    const sliderW = (w - this.s(20)) * 0.55;
    const detail = Math.round(wd.slider(f, SLIDER_PROFILE_DETAIL, x, cy, sliderW, 'Surface detail', `${Math.round(profile.detail * 100)} %`, profile.detail, 0, 1) * 20) / 20;
    if (Math.abs(detail - profile.detail) > 1e-4) {
      profile.detail = detail;
      this.lookChanged();
    }
    const px = x + sliderW + this.s(20), pw = w - sliderW - this.s(20);
    if (profile.ranges) {
      ui.text(f.body, px, cy, 'Ramp', UiTheme.TEXT);
      const ramp = AppearanceProfiler.RAMPS.indexOf(AppearanceProfiler.normaliseRamp(profile.ramp));
      if (overlays.button(f, input, px, cy + this.s(20), pw, this.s(28), AppearanceProfiler.RAMP_LABELS[Math.max(0, ramp)], overlays.isDropdownOpen(profile, DROP.ramp))) {
        overlays.openDropdown(profile, DROP.ramp, px, cy + this.s(20), pw, this.s(28), AppearanceProfiler.RAMP_LABELS, ramp, k => {
          AppearanceProfiler.applyRamp(profile, AppearanceProfiler.RAMPS[k]);
          this.changed();
        });
      }
    } else {
      ui.text(f.body, px, cy, 'Palette', UiTheme.TEXT);
      const palette = AppearanceProfiler.PALETTES.indexOf(AppearanceProfiler.normalisePalette(profile.palette));
      if (overlays.button(f, input, px, cy + this.s(20), pw, this.s(28), AppearanceProfiler.PALETTE_LABELS[Math.max(0, palette)], overlays.isDropdownOpen(profile, DROP.palette))) {
        overlays.openDropdown(profile, DROP.palette, px, cy + this.s(20), pw, this.s(28), AppearanceProfiler.PALETTE_LABELS, palette, k => {
          overlays.openConfirm('RECOLOUR?', `Recolour all ${profile.rules.length} rows from the ${AppearanceProfiler.PALETTE_LABELS[k]} palette? Colours picked by hand are replaced.`,
            'RECOLOUR', false, false, () => {
              AppearanceProfiler.applyPalette(profile, AppearanceProfiler.PALETTES[k]);
              this.changed();
            });
        });
      }
    }
    cy += this.s(62);

    ui.rect(x, cy, w, Math.max(1, ui.scale), UiTheme.CARD_BORDER);
    cy += this.s(8);
    const footerH = this.s(40);
    this.buildRows(f, input, profile, x, cy, w, bottom - footerH);

    // Under the rows: by set ADD SET / ALL ON / ALL OFF; by value the count, ALL ON / ALL OFF
    const by = bottom - this.s(32);
    const bw = (w - this.s(12)) / 3;
    if (isBySet(profile)) {
      if (overlays.button(f, input, x, by, bw, this.s(32), 'ADD SET', overlays.isDropdownOpen(profile, DROP.addSet))) {
        this.openSetDropdown(profile, null, DROP.addSet, x, by, bw);
      }
    } else {
      const n = profile.rules.length;
      ui.text(f.small, x, by + this.s(9), `${n.toLocaleString('en')} ${profile.ranges ? (n === 1 ? 'range' : 'ranges') : n === 1 ? 'value' : 'values'}`, UiTheme.TEXT_MUTED);
    }
    if (wd.smallButton(f, x + bw + this.s(6), by, bw, this.s(32), 'ALL ON')) { this.setAll(profile, true); }
    if (wd.smallButton(f, x + (bw + this.s(6)) * 2, by, bw, this.s(32), 'ALL OFF')) { this.setAll(profile, false); }
  }

  /** The rows: tick, swatch, label (by set: the set dropdown), count, transparency, hide and × (by set). */
  private buildRows(f: FontAtlas, input: InputState, profile: AppearanceProfile, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, shell = session.shell, wd = session.menu.widgets, overlays = session.menu.overlays;
    const rowH = this.s(34);
    const rules = profile.rules;
    const top = shell.beginScroll(this.rowScroll, input, x, y, w, bottom - y);
    w -= this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.rowScroll.visibleRows(rowH, rules.length);
    const counted = this.result !== null && this.resultFor === profile.id && this.result.ruleCounts.length === rules.length;
    let remove: ProfileRule | null = null;
    let changed = false;
    for (let i = first; i < last; i++) {
      const rule = rules[i];
      const ry = top + i * rowH;
      if ((i & 1) === 0) { ui.rect(x, ry, w, rowH - this.s(4), Rgba.hex(0xffffff, 0.03)); }
      const on = wd.checkbox(f, x + this.s(8), ry + this.s(7), this.s(20), '', rule.on);
      if (on !== rule.on) { rule.on = on; changed = true; }
      if (this.swatch(input, x + this.s(34), ry + this.s(4), this.s(38), rowH - this.s(12), ruleRgb(rule), rule.on)) {
        pickColour(ruleRgb(rule), rgb => {
          rule.colour = AppearanceProfiler.hex(rgb);
          this.changed();
        });
      }
      const lx = x + this.s(82), countW = this.s(64), transW = this.s(56), hideW = this.s(62), delW = isBySet(profile) ? this.s(32) : 0;
      const labelW = w - (lx - x) - countW - transW - hideW - delW - this.s(16);
      const label = this.ruleLabel(profile, rule);
      if (isBySet(profile)) {
        if (overlays.button(f, input, lx, ry + this.s(1), labelW, rowH - this.s(8), label, overlays.isDropdownOpen(rule, DROP.set))) {
          this.openSetDropdown(profile, rule, DROP.set, lx, ry + this.s(1), labelW);
        }
      } else {
        ui.textWrapped(f.body, lx, ry + this.s(7), labelW, label, rule.on ? UiTheme.TEXT : UiTheme.TEXT_FAINT, 1);
      }
      const countText = counted ? this.result!.ruleCounts[i].toLocaleString('en') : '…';
      ui.textRight(f.small, lx + labelW + countW, ry + this.s(9), countText, counted && this.result!.ruleCounts[i] === 0 ? UiTheme.TEXT_FAINT : UiTheme.TEXT_MUTED);
      const tx = lx + labelW + countW + this.s(6);
      const tIndex = Math.min(Math.max(Math.round(rule.transparency * 10), 0), PROFILE_TRANSPARENCY_LABELS.length - 1);
      if (overlays.button(f, input, tx, ry + this.s(1), transW, rowH - this.s(8), PROFILE_TRANSPARENCY_LABELS[tIndex], overlays.isDropdownOpen(rule, DROP.transparency))) {
        overlays.openDropdown(rule, DROP.transparency, tx, ry + this.s(1), transW, rowH - this.s(8), PROFILE_TRANSPARENCY_LABELS, tIndex, k => {
          rule.transparency = k / 10;
          this.changed();
        });
      }
      const hx = tx + transW + this.s(6);
      if (wd.smallButton(f, hx, ry + this.s(1), hideW, rowH - this.s(8), rule.hidden ? 'HIDDEN' : 'HIDE', rule.hidden)) {
        rule.hidden = !rule.hidden;
        changed = true;
      }
      if (isBySet(profile) && wd.smallButton(f, x + w - delW, ry + this.s(1), delW, rowH - this.s(8), '×', true)) { remove = rule; }
    }
    if (rules.length === 0) {
      ui.textWrapped(f.small, x, y + this.s(4), w, isBySet(profile) ? 'No sets: ADD SET.' : profile.ranges ? 'This field has no numbers in the model.' : 'This field has no values in the model.',
        UiTheme.TEXT_FAINT, 2);
    }
    shell.endScroll(this.rowScroll, input, top + rules.length * rowH);
    if (remove) {
      rules.splice(rules.indexOf(remove), 1);
      changed = true;
    }
    if (changed) { this.changed(); }
  }

  /** Colour round B: switches a by-value profile between each value and number ranges. */
  private setRanges(profile: AppearanceProfile, ranges: boolean): void {
    const session = this.session;
    this.rowScroll.reset();
    if (ranges) {
      if (AppearanceProfiler.buildRanges(profile, session.scene) === 0) {
        profile.ranges = false;
        AppearanceProfiler.syncValues(profile, session.scene);
        session.sound.play(SoundId.Error);
        session.toast(`${AppearanceProfiler.fieldLabel(profile)} has no numbers in this model`, 3);
      }
    } else {
      profile.ranges = false;
      profile.rules = [];
      AppearanceProfiler.syncValues(profile, session.scene);
    }
    this.changed();
  }

  /** P-C: BREAKS…: the custom break values as typed text ("300; 450; 600"). */
  private beginBreaks(profile: AppearanceProfile): void {
    const session = this.session;
    session.editor.beginCustom('BREAK VALUES (e.g. 300; 450; 600)', AppearanceProfiler.formatBreaks(profile.breaks), 200, text => {
      const breaks = AppearanceProfiler.parseBreaks(text);
      if (!breaks) {
        session.sound.play(SoundId.Error);
        session.toast('No numbers there: type the values where one range ends and the next starts', 3);
        if (profile.breaks === null) { profile.binning = BinMethod.EQUAL; }
        this.rebuildRanges(profile);
        return;
      }
      profile.breaks = breaks;
      profile.binning = BinMethod.CUSTOM;
      this.rebuildRanges(profile);
    });
  }

  private rebuildRanges(profile: AppearanceProfile): void {
    this.rowScroll.reset();
    if (AppearanceProfiler.buildRanges(profile, this.session.scene) === 0) { this.session.toast('No numbers in this model for that field', 3); }
    this.changed();
  }

  /** Colour round B: EXPORT…: the active profile (or all) and the search sets they use, downloaded. */
  private exportProfiles(all: boolean): void {
    const session = this.session;
    const active = this.active;
    if (!active) { return; }
    const profiles = all ? this.appearance.profiles : [active];
    if (profiles.some(isBySet)) { session.clashes.ensure(); }
    const file = ProfileFiles.build(profiles, id => this.findSet(id), session.scene.modelTitle, `BimGo Web ${__BIMGO_VERSION__}`, session.scene.links);
    const name = safeFileName(all ? session.scene.modelTitle + ' colour profiles' : active.name) + '.json';
    downloadBlob(new Blob([ProfileFiles.serialize(file)], { type: 'application/json' }), name);
    session.sound.play(SoundId.Commit);
    const sets = file.sets.length;
    session.toast(`${file.profiles.length} profile${file.profiles.length === 1 ? '' : 's'}${sets > 0 ? ` and ${sets} search set${sets === 1 ? '' : 's'}` : ''} saved: ${name}`, 3.5);
  }

  /** Colour round B: IMPORT…: adds a file's profiles; search sets matched by name, missing ones added. */
  private async importProfiles(): Promise<void> {
    const session = this.session;
    session.input.releaseAll();
    const picked = await pickFile('.json,application/json');
    if (!picked) { return; }
    const { file, error } = ProfileFiles.parse(await picked.text());
    if (!file) {
      session.sound.play(SoundId.Error);
      session.toast(error ?? 'The file could not be read.', 5, true);
      return;
    }
    if (file.profiles.length === 0) {
      session.toast('The file holds no profiles', 3);
      return;
    }
    const reconciled = ProfileFiles.reconcile(file, session.scene.links, session.scene.levels.map(l => l.name));
    for (const miss of reconciled.missing) { console.info(`Colour profile import (${picked.name}): not in this model: ${miss}.`); }
    const needsSets = file.sets.length > 0 || file.profiles.some(isBySet);
    const document = needsSets ? session.clashes.ensure() : null;
    const { added, setsMatched, setsAdded } = ProfileFiles.merge(file, this.appearance, document ? document.sets : null);
    if (setsAdded > 0) { session.clashes.changed(); }
    this.appearance.active = added[0].id;
    this.rowScroll.reset();
    this.listScroll.scrollToEnd();
    this.changed();
    session.sound.play(SoundId.Commit);
    const missing = reconciled.missing;
    session.toast(`${added.length} profile${added.length === 1 ? '' : 's'} imported`
      + (setsMatched > 0 ? ` · ${setsMatched} set${setsMatched === 1 ? '' : 's'} matched by name` : '')
      + (setsAdded > 0 ? ` · ${setsAdded} set${setsAdded === 1 ? '' : 's'} added` : '')
      + (reconciled.matched > 0 ? ` · ${reconciled.matched} link / level value${reconciled.matched === 1 ? '' : 's'} matched by name` : '')
      + (missing.length > 0 ? ` · not in this model: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` +${missing.length - 3} (see the console)` : ''}` : ''),
    missing.length > 0 ? 7 : 4);
  }

  /** A colour swatch button (faded when its row is off); true when clicked. */
  private swatch(input: InputState, x: number, y: number, w: number, h: number, rgb: number, on: boolean): boolean {
    const session = this.session, ui = session.ui;
    const hover = session.menu.widgets.hover(x, y, w, h);
    ui.rect(x, y, w, h, Rgba.hex(rgb, on ? 1 : 0.3));
    ui.outline(x, y, w, h, Math.max(1, ui.scale), hover ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
    const clicked = hover && input.leftPressed;
    if (clicked) {
      input.consumeClicks();
      session.sound.play(SoundId.UiClick);
      session.input.releaseAll();
    }
    return clicked;
  }

  private setAll(profile: AppearanceProfile, on: boolean): void {
    for (const rule of profile.rules) { rule.on = on; }
    this.changed();
  }

  /** The field dropdown: the built-in fields, then each extracted parameter ("Parameter: Fire Rating"). */
  private openFieldDropdown(profile: AppearanceProfile, x: number, y: number, w: number): void {
    const session = this.session;
    const choices: [string, string | null][] = [];
    const labels: string[] = [];
    for (const field of RuleField.ALL) {
      choices.push([field, null]);
      labels.push(SearchSets.fieldLabel(field));
    }
    for (const name of (session.scene.parameters ?? ParameterTable.empty).sortedNames()) {
      choices.push([RuleField.PARAMETER, name]);
      labels.push('Parameter: ' + name);
    }
    const selected = choices.findIndex(([field, parameter]) => field === RuleField.normalise(profile.field)
      && (field !== RuleField.PARAMETER || (parameter ?? '').toLowerCase() === (profile.parameter ?? '').toLowerCase()));
    session.menu.overlays.openDropdown(profile, DROP.field, x, y, w, this.s(30), labels, selected, k => {
      if (k < 0 || k >= choices.length || k === selected) { return; }
      const [field, parameter] = choices[k];
      const autoName = profile.name.toLowerCase() === ('By ' + AppearanceProfiler.fieldLabel(profile)).toLowerCase();
      AppearanceProfiler.setField(profile, field, parameter, session.scene);
      if (autoName) {
        const label = AppearanceProfiler.fieldLabel(profile);
        profile.name = 'By ' + (profile.field === RuleField.PARAMETER ? label : label.toLowerCase());
      }
      this.rowScroll.reset();
      this.changed();
      if (profile.rules.length === 0) { session.toast('No element in the model has a value for that', 3); }
    });
    if (labels.length === RuleField.ALL.length && session.scene.parameters.isEmpty) {
      session.toast('Tick parameters in Revit Options → Parameters (then Go / Export again) to colour by them', 4);
    }
  }

  /** A set dropdown: every search set (a row's set, or a new row with ADD SET). */
  private openSetDropdown(profile: AppearanceProfile, rule: ProfileRule | null, slot: number, x: number, y: number, w: number): void {
    const session = this.session;
    const sets = session.clashes.ensure().sets;
    if (sets.length === 0) {
      session.toast('No search sets: make some in CLASHES → SETS (EDIT SETS…)', 3);
      return;
    }
    const labels = sets.map(s => s.name);
    const selected = rule === null ? -1 : sets.findIndex(s => s.id === rule.setId);
    const ids = sets.map(s => s.id);
    session.menu.overlays.openDropdown(rule ?? profile, slot, x, y, w, this.s(30), labels, selected, k => {
      if (k < 0 || k >= ids.length) { return; }
      if (rule === null) {
        profile.rules.push({ ...newProfileRule(), setId: ids[k], colour: AppearanceProfiler.paletteColour(profile.palette, profile.rules.length) });
        this.rowScroll.scrollToEnd();
      } else {
        rule.setId = ids[k];
      }
      this.changed();
    });
  }

  // #endregion
}
