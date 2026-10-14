import { ClashMerge } from '../../core/clashes/ClashMerge';
import {
  allRules, type ClashTest, ClashDefaults, ClashKind, ClashStatus, copySet, findSet, findTest, isSelfTest, newRule, newSet, newTest, RuleField,
  type RuleGroup, RuleOp, ruleHasValue, ruleOperator, ruleValueAt, ruleValueCount, type SearchSet, type SetRule, setRuleField, setRuleOperator,
  setRuleValues, toggleRuleValue
} from '../../core/clashes/ClashModels';
import { type RuleValue, SearchSets } from '../../core/clashes/SearchSets';
import { Rgba } from '../../engine/ui/Rgba';
import type { FontAtlas } from '../../engine/ui/UiFont';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { type InputState, Vk } from '../../platform/input';
import type { GameSession } from '../GameSession';
import { UnitFormat } from '../UnitFormat';
import type { Clashes } from './Clashes';

interface TestRow {
  test: ClashTest;
  title: string;
  detail: string;
  setA: string;
  setB: string;
  tolerance: string;
  counts: string;
  lastRun: string;
  changed: boolean;
}

interface SetRow {
  set: SearchSet;
  title: string;
  detail: string;
  elements: number;
  usedBy: number;
}

const TABS = ['TESTS', 'SETS'];
const KINDS = ['HARD', 'CLEARANCE'];
const MATCH = ['ANY RULE', 'ALL RULES'];
const GROUP_MATCH = ['ANY OF', 'ALL OF'];
const FIELD_LABELS = RuleField.ALL.map(f => SearchSets.fieldLabel(f).toUpperCase());
const DROP_SET_A = 1, DROP_SET_B = 2, DROP_RULE_FIELD = 3, DROP_RULE_OP = 4;
const SEARCH_MAX = 40;

function plural(n: number, word: string, many = word + 's'): string {
  return `${n.toLocaleString('en')} ${n === 1 ? word : many}`;
}

function opLabel(rule: SetRule): string {
  return RuleOp.LABELS[Math.max(0, RuleOp.indexOf(ruleOperator(rule)))];
}

/**
 * The CLASHES panel (port of GameSession.ClashPanel, Round C; pause menu → CLASHES, or TESTS… in clash mode; in place
 * of the pause menu): TESTS (tick for RUN ALL; the selected test's name, hard / clearance, set A and set B dropdowns,
 * tolerance, RUN, REVIEW, RESET RESULTS, DUPLICATE, DELETE) and SETS (the selected set's name, any / all, rules with
 * field / operator dropdowns and a value picker, rule groups, DUPLICATE, DELETE). RUN ALL, EXPORT / IMPORT REPORT,
 * RESET ALL, CLOSE. Re-running tests with results and resetting ask first. Labels are built when the data changes.
 */
export class ClashPanel {
  isOpen = false;
  private tab = 0;
  private scroll = 0;
  private ruleScroll = 0;
  selectedTest: string | null = null;
  private selectedSet: string | null = null;
  rowsDirty = true;
  private rowsUnits = -1;
  private testRows: TestRow[] = [];
  private setRows: SetRow[] = [];
  private menuLabel: string | null = null;
  private menuLabelFor = Number.MIN_SAFE_INTEGER;
  private deleteArmed: object | null = null;
  private readonly ruleLabels = new Map<SetRule, { field: string; op: string; value: string }>();
  private skipRerunConfirm = false;

  // The rule value picker (SETS tab)
  pickerRule: SetRule | null = null;
  private pickerValues: RuleValue[] = [];
  private pickerMatches: RuleValue[] = [];
  private pickerSearch = '';
  private pickerScroll = 0;
  private pickerDirty = false;
  private pickerHeader = '';

  constructor(private readonly session: GameSession, private readonly clashes: Clashes) {}

  private s(v: number): number { return this.session.s(v); }

  // #region Open / close

  /** Opens the panel (pause menu → CLASHES, TESTS… in clash mode), switching clash detection on the first time. */
  show(): void {
    const session = this.session, document = this.clashes.ensure();
    if (!session.paused) { session.setPaused(true); }
    this.isOpen = true;
    this.scroll = this.ruleScroll = 0;
    this.rowsDirty = true;
    this.pickerRule = null;
    this.deleteArmed = null;
    session.menu.closeOverlay();
    if (!findTest(document, this.selectedTest)) { this.selectedTest = this.clashes.reviewTest ?? document.tests[0]?.id ?? null; }
    if (!findSet(document, this.selectedSet)) { this.selectedSet = document.sets[0]?.id ?? null; }
  }

  /** Esc / CLOSE: an open dropdown or confirm first, then the value picker, then the panel. True if something closed. */
  close(): boolean {
    if (!this.isOpen) { return false; }
    const session = this.session;
    if (session.menu.closeOverlay()) { return true; }
    if (this.pickerRule) {
      this.pickerRule = null;
      return true;
    }
    this.isOpen = false;
    this.clashes.listDirty = true;
    if (this.clashes.modeOn) { session.setPaused(false); }
    return true;
  }

  /** The pause menu button: "CLASHES", with the open count once clash detection is on. */
  label(): string {
    const document = this.clashes.document;
    const stamp = document ? this.clashes.revision : -1;
    if (stamp === this.menuLabelFor && this.menuLabel) { return this.menuLabel; }
    this.menuLabelFor = stamp;
    const open = document ? document.clashes.filter(c => c.status !== ClashStatus.RESOLVED && c.status !== ClashStatus.APPROVED).length : 0;
    this.menuLabel = open === 0 ? 'CLASHES' : `CLASHES (${open.toLocaleString('en')})`;
    return this.menuLabel;
  }

  /** True while the value picker takes typed characters. */
  get capturesTyping(): boolean { return this.isOpen && this.pickerRule !== null; }

  private setupChanged(): void {
    this.clashes.changed();
    this.rowsDirty = true;
    this.clashes.listDirty = true;
  }

  // #endregion

  // #region Panel

  build(f: FontAtlas): void {
    const session = this.session, ui = session.ui, input = session.input, wd = session.menu.widgets, overlays = session.menu.overlays;
    const document = this.clashes.ensure();
    const width = session.screenWidth, height = session.screenHeight;
    overlays.begin(input);
    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    const w = Math.min(this.s(1100), width - this.s(48));
    const h = height - this.s(72);
    const x = (width - w) * 0.5, y = this.s(36);
    ui.panel(x, y, w, h, UiTheme.CARD, UiTheme.CARD_BORDER);

    this.refreshRows();
    const ix = x + this.s(24), iw = w - this.s(48);
    let cy = y + this.s(18);
    ui.text(f.small, ix, cy + this.s(8), 'CLASHES', UiTheme.ACCENT, this.s(2));
    const tab = wd.segmented(f, ix + iw - this.s(260), cy, this.s(260), TABS, this.tab);
    if (tab !== this.tab) {
      this.tab = tab;
      this.scroll = this.ruleScroll = 0;
      this.pickerRule = null;
      this.deleteArmed = null;
      session.menu.closeOverlay();
    }
    cy += this.s(48);

    const buttonsY = y + h - this.s(24) - this.s(44);
    const lw = Math.min(this.s(400), iw * 0.42);
    const rx = ix + lw + this.s(24), rw = iw - lw - this.s(24);
    const bottom = buttonsY - this.s(16);
    ui.rect(rx - this.s(12), cy, Math.max(1, ui.scale), bottom - cy, UiTheme.CARD_BORDER);

    let run: ClashTest | null = null, review: ClashTest | null = null;
    if (this.tab === 0) {
      this.buildTestList(f, input, ix, cy, lw, bottom);
      [run, review] = this.buildTestEditor(f, input, rx, cy, rw, bottom);
    } else {
      this.buildSetList(f, input, ix, cy, lw, bottom);
      if (this.pickerRule) { this.buildValuePicker(f, input, rx, cy, rw, bottom); } else { this.buildSetEditor(f, input, rx, cy, rw, bottom); }
    }

    const gap = this.s(12), closeW = this.s(200);
    const bw = Math.min(this.s(170), (iw - closeW - gap * 5) / 4);
    let bx = ix;
    const runAll = wd.menuButton(f, bx, buttonsY, bw, 'RUN ALL', true, false, document.tests.some(t => t.enabled), this.s(44));
    bx += bw + gap;
    const exportReport = wd.menuButton(f, bx, buttonsY, bw, 'EXPORT REPORT…', false, false, true, this.s(44));
    bx += bw + gap;
    const importReport = wd.menuButton(f, bx, buttonsY, bw, 'IMPORT REPORT…', false, false, true, this.s(44));
    bx += bw + gap;
    const resetAll = wd.menuButton(f, bx, buttonsY, bw, 'RESET ALL…', false, true, true, this.s(44));
    const close = wd.menuButton(f, ix + iw - closeW, buttonsY, closeW, this.clashes.modeOn ? '← CLASH MODE' : 'CLOSE', false, false, true, this.s(44));

    overlays.draw(f, input, x, y, w, h);
    if (!this.isOpen) { return; }

    if (close) {
      this.pickerRule = null;
      this.close();
      return;
    }
    if (run) { this.requestRun([run]); return; }
    if (review) { this.clashes.enter(null, review.id); return; }
    if (runAll) { this.requestRun(document.tests.filter(t => t.enabled)); return; }
    if (exportReport) { this.clashes.exportReport(); return; }
    if (importReport) { void this.clashes.importReport(); return; }
    if (resetAll) { this.requestReset(document.tests); }
  }

  /** RUN / RUN ALL: at once when none has results (or "don't ask again"); otherwise asks first. */
  private requestRun(tests: ClashTest[]): void {
    const document = this.clashes.document!;
    const withResults = tests.filter(t => ClashMerge.hasResults(document, t)).length;
    if (withResults === 0 || this.skipRerunConfirm) {
      void this.clashes.runTests(tests);
      return;
    }
    const message = withResults === 1 && tests.length === 1
      ? `Re-run “${tests[0].name}”? It has results: new clashes found before become active; ones not found become resolved.`
      : `Re-run ${withResults} test${withResults === 1 ? '' : 's'} with results? New clashes found before become active; ones not found become resolved.`;
    this.session.menu.overlays.openConfirm('RE-RUN?', message, 'RE-RUN', false, true, skip => {
      if (skip) { this.skipRerunConfirm = true; }
      void this.clashes.runTests(tests);
    });
  }

  /** RESET RESULTS / RESET ALL…: asks first, then clears the tests' clashes and run history. */
  private requestReset(tests: readonly ClashTest[]): void {
    const session = this.session, document = this.clashes.document!;
    const withResults = tests.filter(t => ClashMerge.hasResults(document, t));
    if (withResults.length === 0) {
      session.sound.play(SoundId.Error);
      session.toast(tests.length === 1 ? `“${tests[0].name}” has no results to reset` : 'No test has results to reset', 2.5);
      return;
    }
    let clashes = 0;
    for (const test of withResults) { clashes += ClashMerge.countByStatus(document, test.id).reduce((a, b) => a + b, 0); }
    const what = `${plural(clashes, 'clash', 'clashes')}, with their statuses, assignees and notes, and the run history are deleted. The next RUN starts fresh (all new).`;
    const single = tests.length === 1;
    session.menu.overlays.openConfirm(single ? 'RESET RESULTS?' : 'RESET ALL RESULTS?',
      single ? `Reset “${withResults[0].name}”? Its ${what}` : `Reset ${withResults.length} test${withResults.length === 1 ? '' : 's'} with results? ${what}`,
      single ? 'RESET' : 'RESET ALL', true, false, () => this.resetTests(withResults));
  }

  private resetTests(tests: readonly ClashTest[]): void {
    const session = this.session, document = this.clashes.document!;
    let removed = 0;
    for (const test of tests) { removed += ClashMerge.resetTest(document, test); }
    this.clashes.forgetCurrentIfGone();
    this.setupChanged();
    session.sound.play(SoundId.Remove);
    session.toast(`Results reset: ${plural(removed, 'clash', 'clashes')} removed; RUN starts fresh`, 3);
  }

  // #endregion

  // #region Tests

  private hover(input: InputState, x: number, y: number, w: number, h: number): boolean {
    return input.mouseX >= x && input.mouseX < x + w && input.mouseY >= y && input.mouseY < y + h;
  }

  private buildTestList(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets;
    const rowH = this.s(56);
    const listBottom = bottom - this.s(44);
    const visible = Math.max(1, Math.trunc((listBottom - y) / rowH));
    const maxScroll = Math.max(0, this.testRows.length - visible);
    if (input.wheel !== 0 && this.hover(input, x, y, w, listBottom - y)) { this.scroll -= input.wheel; }
    this.scroll = Math.min(Math.max(this.scroll, 0), maxScroll);

    const last = Math.min(this.testRows.length, this.scroll + visible);
    for (let i = this.scroll; i < last; i++) {
      const row = this.testRows[i], test = row.test;
      const ry = y + (i - this.scroll) * rowH;
      const selected = test.id === this.selectedTest;
      ui.rect(x, ry, w, rowH - this.s(6), selected ? Rgba.hex(0x22d3ee, 0.12) : Rgba.hex(0xffffff, 0.03));
      const enabled = wd.checkbox(f, x + this.s(10), ry + this.s(10), this.s(20), '', test.enabled);
      if (enabled !== test.enabled) {
        test.enabled = enabled;
        input.consumeClicks();
        this.setupChanged();
      }
      ui.textWrapped(f.bold, x + this.s(40), ry + this.s(6), w - this.s(50), row.title, selected ? UiTheme.ACCENT : UiTheme.TEXT, 1);
      ui.textWrapped(f.small, x + this.s(40), ry + this.s(28), w - this.s(50), row.detail, row.changed ? Rgba.hex(0xfcd34d) : UiTheme.TEXT_MUTED, 1);
      if (this.hover(input, x + this.s(36), ry, w - this.s(36), rowH - this.s(6)) && input.leftPressed) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        this.selectedTest = test.id;
        this.deleteArmed = null;
      }
    }
    if (this.testRows.length === 0) { ui.text(f.body, x, y + this.s(6), 'No tests yet: NEW TEST.', UiTheme.TEXT_MUTED); }
    if (maxScroll > 0) { ui.textRight(f.small, x + w, listBottom - this.s(16), `${this.scroll + 1}–${last} of ${this.testRows.length}`, UiTheme.TEXT_FAINT); }
    if (wd.smallButton(f, x, bottom - this.s(34), this.s(140), this.s(32), 'NEW TEST')) { this.addTest(); }
  }

  /** The selected test's editor; returns the test to RUN and the one to REVIEW (clicked this frame). */
  private buildTestEditor(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): [ClashTest | null, ClashTest | null] {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, overlays = session.menu.overlays;
    const document = this.clashes.document!;
    const test = findTest(document, this.selectedTest);
    const row = test ? this.testRows.find(r => r.test === test) : undefined;
    if (!test || !row) {
      ui.text(f.body, x, y + this.s(6), 'Select a test, or NEW TEST.', UiTheme.TEXT_MUTED);
      return [null, null];
    }
    let run: ClashTest | null = null, review: ClashTest | null = null;
    const labelW = this.s(110);
    let cy = y;
    const fx = x + labelW, fw = w - labelW;

    this.editorLabel(f, x, cy, 'NAME');
    ui.textWrapped(f.bold, fx, cy + this.s(7), fw - this.s(110), test.name, UiTheme.TEXT, 1);
    if (wd.smallButton(f, x + w - this.s(100), cy, this.s(100), this.s(30), 'RENAME…')) {
      session.editor.beginCustom('TEST NAME', test.name, 60, text => {
        if (!text) { return; }
        test.name = text;
        this.setupChanged();
      });
    }
    cy += this.s(44);

    this.editorLabel(f, x, cy, 'KIND');
    const kind = wd.segmented(f, fx, cy, Math.min(fw, this.s(300)), KINDS, test.kind === ClashKind.CLEARANCE ? 1 : 0);
    const newKind = kind === 1 ? ClashKind.CLEARANCE : ClashKind.HARD;
    if (newKind !== test.kind) {
      test.kind = newKind;
      test.tolerance = ClashDefaults.toleranceFor(newKind);
      this.markTestEdited(test);
    }
    cy += this.s(44);

    // Sets (A and B stay as picked: changing one never changes the other)
    this.editorLabel(f, x, cy, 'SET A');
    if (overlays.button(f, input, fx, cy, fw, this.s(30), row.setA, overlays.isDropdownOpen(test, DROP_SET_A))) {
      const ids = document.sets.map(s => s.id);
      overlays.openDropdown(test, DROP_SET_A, fx, cy, fw, this.s(30), this.setChoices(), ids.indexOf(test.setA ?? ''), i => {
        if (ids[i] === test.setA) { return; }
        test.setA = ids[i];
        this.markTestEdited(test);
      });
    }
    cy += this.s(44);
    this.editorLabel(f, x, cy, 'SET B');
    if (overlays.button(f, input, fx, cy, fw, this.s(30), row.setB, overlays.isDropdownOpen(test, DROP_SET_B))) {
      const ids: (string | null)[] = [null, ...document.sets.map(s => s.id)];
      const labels = ['(set A against itself)', ...this.setChoices()];
      overlays.openDropdown(test, DROP_SET_B, fx, cy, fw, this.s(30), labels, test.setB ? ids.indexOf(test.setB) : 0, i => {
        if (ids[i] === test.setB) { return; }
        test.setB = ids[i];
        this.markTestEdited(test);
      });
    }
    cy += this.s(44);

    this.editorLabel(f, x, cy, test.kind === ClashKind.CLEARANCE ? 'DISTANCE' : 'TOLERANCE');
    if (wd.smallButton(f, fx, cy, this.s(32), this.s(30), '−')) { this.stepTolerance(test, -1); }
    ui.textCentred(f.bold, fx + this.s(32) + this.s(70), cy + this.s(7), row.tolerance, UiTheme.TEXT);
    if (wd.smallButton(f, fx + this.s(32) + this.s(140), cy, this.s(32), this.s(30), '+')) { this.stepTolerance(test, 1); }
    ui.textWrapped(f.small, fx + this.s(220), cy + this.s(8), fw - this.s(220),
      test.kind === ClashKind.CLEARANCE ? 'closer than this is reported' : 'crossings up to this deep are ignored', UiTheme.TEXT_MUTED, 1);
    cy += this.s(48);

    ui.textWrapped(f.small, x, cy, w, row.lastRun, row.changed ? Rgba.hex(0xfcd34d) : UiTheme.TEXT_MUTED, 2);
    cy += this.s(36);
    ui.textWrapped(f.body, x, cy, w, row.counts, UiTheme.TEXT_SOFT, 2);

    const by = bottom - this.s(34), bw = (w - this.s(24)) / 5;
    if (wd.smallButton(f, x, by, bw, this.s(32), 'RUN')) { run = test; }
    if (wd.smallButton(f, x + (bw + this.s(6)), by, bw, this.s(32), 'REVIEW')) { review = test; }
    if (wd.smallButton(f, x + (bw + this.s(6)) * 2, by, bw, this.s(32), bw >= this.s(124) ? 'RESET RESULTS…' : 'RESET…', true)) { this.requestReset([test]); }
    if (wd.smallButton(f, x + (bw + this.s(6)) * 3, by, bw, this.s(32), 'DUPLICATE')) {
      const copy: ClashTest = { ...newTest(test.name + ' (copy)'), kind: test.kind, setA: test.setA, setB: test.setB, tolerance: test.tolerance, enabled: test.enabled };
      document.tests.splice(document.tests.indexOf(test) + 1, 0, copy);
      this.selectedTest = copy.id;
      this.setupChanged();
    }
    const armed = this.deleteArmed === test;
    if (wd.smallButton(f, x + (bw + this.s(6)) * 4, by, bw, this.s(32), armed ? 'SURE?' : 'DELETE', true)) {
      if (!armed) {
        this.deleteArmed = test;
        session.toast('Click DELETE again to delete the test and its clashes', 3);
      } else {
        ClashMerge.removeTest(document, test.id);
        if (this.clashes.reviewTest === test.id) { this.clashes.setReviewTest(null); }
        this.clashes.forgetCurrentIfGone();
        this.selectedTest = document.tests[0]?.id ?? null;
        this.deleteArmed = null;
        this.setupChanged();
        session.toast('Test deleted', 2);
      }
    }
    return [run, review];
  }

  private editorLabel(f: FontAtlas, x: number, y: number, label: string): void {
    this.session.ui.text(f.small, x, y + this.s(8), label, UiTheme.TEXT_MUTED, this.s(1.2));
  }

  /** The sets as dropdown choices ("Services (1,234)"). */
  private setChoices(): string[] {
    return this.clashes.document!.sets.map(set => {
      const row = this.setRows.find(r => r.set === set);
      return row ? `${set.name} (${row.elements.toLocaleString('en')})` : set.name;
    });
  }

  /** A test's sets, kind or tolerance changed: its last results no longer match (until RUN). */
  private markTestEdited(test: ClashTest): void {
    if (test.lastRunUtc) { test.lastRunModel = 'edited'; }
    this.setupChanged();
  }

  /** NEW TEST: hard, 5 mm, the first two sets. */
  private addTest(): void {
    const document = this.clashes.document!;
    const test = newTest(`Test ${document.tests.length + 1}`);
    test.setA = document.sets[0]?.id ?? null;
    test.setB = document.sets[1]?.id ?? null;
    document.tests.push(test);
    this.selectedTest = test.id;
    this.scroll = Number.MAX_SAFE_INTEGER;
    this.setupChanged();
  }

  /** − / +: hard in 1 mm steps (5 mm past 10 mm), clearance in 5 mm steps (25 mm past 100 mm). */
  private stepTolerance(test: ClashTest, direction: number): void {
    let mm = test.tolerance * 1000;
    const clearance = test.kind === ClashKind.CLEARANCE;
    const coarseFrom = clearance ? 100 : 10;
    const coarse = direction > 0 ? mm >= coarseFrom - 1e-6 : mm > coarseFrom + 1e-6;
    const step = clearance ? (coarse ? 25 : 5) : (coarse ? 5 : 1);
    mm = Math.round((mm + direction * step) / step) * step;
    test.tolerance = Math.min(Math.max(mm, 0), ClashDefaults.MAX_TOLERANCE * 1000) / 1000;
    this.markTestEdited(test);
  }

  // #endregion

  // #region Sets

  private buildSetList(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets;
    const document = this.clashes.document!;
    const rowH = this.s(52);
    const listBottom = bottom - this.s(44);
    const visible = Math.max(1, Math.trunc((listBottom - y) / rowH));
    const maxScroll = Math.max(0, this.setRows.length - visible);
    if (input.wheel !== 0 && this.hover(input, x, y, w, listBottom - y)) { this.scroll -= input.wheel; }
    this.scroll = Math.min(Math.max(this.scroll, 0), maxScroll);

    const last = Math.min(this.setRows.length, this.scroll + visible);
    for (let i = this.scroll; i < last; i++) {
      const row = this.setRows[i];
      const ry = y + (i - this.scroll) * rowH;
      const selected = row.set.id === this.selectedSet;
      const hover = this.hover(input, x, ry, w, rowH - this.s(6));
      ui.rect(x, ry, w, rowH - this.s(6), selected ? Rgba.hex(0x22d3ee, 0.12) : hover ? Rgba.hex(0xffffff, 0.06) : Rgba.hex(0xffffff, 0.03));
      ui.textWrapped(f.bold, x + this.s(12), ry + this.s(6), w - this.s(24), row.title, selected ? UiTheme.ACCENT : UiTheme.TEXT, 1);
      ui.textWrapped(f.small, x + this.s(12), ry + this.s(27), w - this.s(24), row.detail, UiTheme.TEXT_MUTED, 1);
      if (hover && input.leftPressed) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        this.selectedSet = row.set.id;
        this.ruleScroll = 0;
        this.deleteArmed = null;
      }
    }
    if (this.setRows.length === 0) { ui.text(f.body, x, y + this.s(6), 'No sets yet: NEW SET.', UiTheme.TEXT_MUTED); }
    if (wd.smallButton(f, x, bottom - this.s(34), this.s(140), this.s(32), 'NEW SET')) {
      const set = newSet(`Set ${document.sets.length + 1}`);
      document.sets.push(set);
      this.selectedSet = set.id;
      this.scroll = Number.MAX_SAFE_INTEGER;
      this.setupChanged();
    }
  }

  /** The selected set's editor: name, any / all, rules and groups, the element count, DUPLICATE, DELETE. */
  private buildSetEditor(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets;
    const document = this.clashes.document!;
    const set = findSet(document, this.selectedSet);
    const row = set ? this.setRows.find(r => r.set === set) : undefined;
    if (!set || !row) {
      ui.text(f.body, x, y + this.s(6), 'Select a set, or NEW SET.', UiTheme.TEXT_MUTED);
      return;
    }
    const labelW = this.s(110);
    let cy = y;
    const fx = x + labelW, fw = w - labelW;
    this.editorLabel(f, x, cy, 'NAME');
    ui.textWrapped(f.bold, fx, cy + this.s(7), fw - this.s(110), set.name, UiTheme.TEXT, 1);
    if (wd.smallButton(f, x + w - this.s(100), cy, this.s(100), this.s(30), 'RENAME…')) {
      session.editor.beginCustom('SET NAME', set.name, 60, text => {
        if (!text) { return; }
        set.name = text;
        this.setupChanged();
      });
    }
    cy += this.s(44);

    this.editorLabel(f, x, cy, 'INCLUDE IF');
    const match = wd.segmented(f, fx, cy, Math.min(fw, this.s(300)), MATCH, set.matchAll ? 1 : 0);
    if ((match === 1) !== set.matchAll) {
      set.matchAll = match === 1;
      this.setEdited();
    }
    cy += this.s(44);
    ui.textWrapped(f.small, x, cy, w, 'RULES · TOP-LEVEL "NOT" RULES TAKE ELEMENTS OUT · IN A GROUP THEY ARE ORDINARY CONDITIONS', UiTheme.TEXT_MUTED, 1);
    cy += this.s(22);

    // The lines: the set's own rules, then each group (a header, then its rules indented)
    const lines: { group: RuleGroup | null; rule: SetRule | null }[] = [];
    for (const rule of set.rules) { lines.push({ group: null, rule }); }
    for (const group of set.groups ?? []) {
      lines.push({ group, rule: null });
      for (const rule of group.rules) { lines.push({ group, rule }); }
    }

    const footer = bottom - this.s(34) - this.s(52);
    const ruleH = this.s(38);
    const visible = Math.max(1, Math.trunc((footer - cy) / ruleH));
    const maxScroll = Math.max(0, lines.length - visible);
    if (input.wheel !== 0 && this.hover(input, x, cy, w, footer - cy)) { this.ruleScroll -= input.wheel; }
    this.ruleScroll = Math.min(Math.max(this.ruleScroll, 0), maxScroll);
    let remove: SetRule | null = null, removeFrom: RuleGroup | null = null, removeGroup: RuleGroup | null = null, addTo: RuleGroup | null = null;
    const last = Math.min(lines.length, this.ruleScroll + visible);
    const indent = this.s(24);
    for (let i = this.ruleScroll; i < last; i++) {
      const { group, rule } = lines[i];
      const ry = cy + (i - this.ruleScroll) * ruleH;
      if (!rule) {
        const number = set.groups!.indexOf(group!) + 1;
        ui.rect(x, ry, w, this.s(32), Rgba.hex(0x22d3ee, 0.07));
        ui.text(f.bold, x + this.s(8), ry + this.s(8), `GROUP ${number}`, UiTheme.ACCENT);
        const gm = wd.segmented(f, x + this.s(90), ry, this.s(190), GROUP_MATCH, group!.matchAll ? 1 : 0);
        if ((gm === 1) !== group!.matchAll) {
          group!.matchAll = gm === 1;
          this.setEdited();
        }
        const delW = this.s(32);
        if (wd.smallButton(f, x + w - delW - this.s(6) - this.s(110), ry, this.s(110), this.s(32), 'ADD RULE')) { addTo = group; }
        if (wd.smallButton(f, x + w - delW, ry, delW, this.s(32), '×', true)) { removeGroup = group; }
        continue;
      }
      const rx = group ? x + indent : x;
      if (group) { ui.rect(x + this.s(8), ry, this.s(3), this.s(32), Rgba.hex(0x22d3ee, 0.35)); }
      if (this.buildRuleRow(f, input, rule, rx, ry, group ? w - indent : w, group !== null)) {
        remove = rule;
        removeFrom = group;
      }
    }
    if (lines.length === 0) { ui.text(f.body, x, cy + this.s(6), 'No rules: every element is in this set. ADD RULE or ADD GROUP.', UiTheme.TEXT_MUTED); }
    else if (maxScroll > 0) {
      ui.textRight(f.small, x + w, footer - this.s(4), `${this.ruleScroll + 1}–${last} of ${lines.length} lines (wheel scrolls)`, UiTheme.TEXT_FAINT);
    }
    if (remove) {
      const list = removeFrom ? removeFrom.rules : set.rules;
      list.splice(list.indexOf(remove), 1);
      this.setEdited();
    }
    if (addTo) {
      addTo.rules.push(newRule(RuleField.CATALOG, RuleOp.IS));
      this.setEdited();
    }
    if (removeGroup) {
      const target = removeGroup;
      if (target.rules.length === 0) { this.removeGroup(set, target); }
      else {
        session.menu.overlays.openConfirm('DELETE GROUP', `Delete group ${set.groups!.indexOf(target) + 1} and its ${plural(target.rules.length, 'rule')}?`,
          'DELETE', true, false, () => this.removeGroup(set, target));
      }
    }

    ui.textWrapped(f.body, x, footer + this.s(10), w, row.detail, UiTheme.TEXT_SOFT, 1);
    const by = bottom - this.s(34), bw = (w - this.s(18)) / 4;
    if (wd.smallButton(f, x, by, bw, this.s(32), 'ADD RULE')) {
      set.rules.push(newRule(RuleField.CATALOG, RuleOp.IS));
      this.ruleScroll = set.rules.length;
      this.setEdited();
    }
    if (wd.smallButton(f, x + bw + this.s(6), by, bw, this.s(32), 'ADD GROUP')) {
      set.groups ??= [];
      set.groups.push({ matchAll: true, rules: [newRule(RuleField.CATALOG, RuleOp.IS)] });
      this.ruleScroll = Number.MAX_SAFE_INTEGER;
      this.setEdited();
    }
    if (wd.smallButton(f, x + (bw + this.s(6)) * 2, by, bw, this.s(32), 'DUPLICATE')) {
      const copy = copySet(set, true);
      copy.name = set.name + ' (copy)';
      document.sets.splice(document.sets.indexOf(set) + 1, 0, copy);
      this.selectedSet = copy.id;
      this.setupChanged();
    }
    const armed = this.deleteArmed === set;
    if (wd.smallButton(f, x + (bw + this.s(6)) * 3, by, bw, this.s(32), armed ? 'SURE?' : 'DELETE', true)) {
      if (row.usedBy > 0) {
        session.sound.play(SoundId.Error);
        session.toast(`“${set.name}” is used by ${plural(row.usedBy, 'test')}: change ${row.usedBy === 1 ? 'it' : 'them'} first`, 3.5);
      } else if (!armed) {
        this.deleteArmed = set;
        session.toast('Click DELETE again to delete the set', 3);
      } else {
        document.sets.splice(document.sets.indexOf(set), 1);
        this.selectedSet = document.sets[0]?.id ?? null;
        this.deleteArmed = null;
        this.setupChanged();
        session.toast('Set deleted', 2);
      }
    }
  }

  /** One rule row: field ▾, operator ▾, value, ×. True when × was clicked. */
  private buildRuleRow(f: FontAtlas, input: InputState, rule: SetRule, x: number, ry: number, w: number, inGroup: boolean): boolean {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, overlays = session.menu.overlays;
    const fieldW = this.s(150), opW = this.s(150), delW = this.s(32), g = this.s(6);
    const valueW = Math.max(this.s(80), w - fieldW - opW - delW - g * 3);
    let bx = x;
    const labels = this.ruleLabelsOf(rule);

    if (overlays.button(f, input, bx, ry, fieldW, this.s(32), labels.field, overlays.isDropdownOpen(rule, DROP_RULE_FIELD))) {
      overlays.openDropdown(rule, DROP_RULE_FIELD, bx, ry, fieldW, this.s(32), FIELD_LABELS, RuleField.ALL.indexOf(RuleField.normalise(rule.field)), k => {
        if (RuleField.ALL[k] === RuleField.normalise(rule.field)) { return; }
        setRuleField(rule, RuleField.ALL[k]);
        this.setEdited();
      });
    }
    bx += fieldW + g;

    if (overlays.button(f, input, bx, ry, opW, this.s(32), labels.op, overlays.isDropdownOpen(rule, DROP_RULE_OP))) {
      overlays.openDropdown(rule, DROP_RULE_OP, bx, ry, opW, this.s(32), RuleOp.LABELS, RuleOp.indexOf(ruleOperator(rule)), k => {
        if (RuleOp.ALL[k] === ruleOperator(rule)) { return; }
        setRuleOperator(rule, RuleOp.ALL[k]);
        this.setEdited();
      });
    }
    if (RuleOp.isNegative(ruleOperator(rule))) {
      ui.rect(bx, ry + this.s(32) - this.s(3), opW, this.s(3), inGroup ? Rgba.hex(0xffffff, 0.25) : Rgba.hex(0xfca5a5, 0.7));
    }
    bx += opW + g;

    if (wd.smallButton(f, bx, ry, valueW, this.s(32), labels.value)) {
      if (RuleOp.isText(ruleOperator(rule))) { this.beginRuleText(rule); } else { this.openPicker(rule); }
    }
    bx += valueW + g;
    return wd.smallButton(f, bx, ry, delW, this.s(32), '×', true);
  }

  private removeGroup(set: SearchSet, group: RuleGroup): void {
    if (!set.groups) { return; }
    const index = set.groups.indexOf(group);
    if (index < 0) { return; }
    set.groups.splice(index, 1);
    if (set.groups.length === 0) { set.groups = null; }
    this.setEdited();
  }

  /** A set's rules changed: the tests using it no longer match their last results. */
  private setEdited(): void {
    for (const test of this.clashes.document!.tests) {
      if ((test.setA === this.selectedSet || test.setB === this.selectedSet) && test.lastRunUtc) { test.lastRunModel = 'edited'; }
    }
    this.setupChanged();
  }

  private ruleLabelsOf(rule: SetRule): { field: string; op: string; value: string } {
    let labels = this.ruleLabels.get(rule);
    if (!labels) {
      labels = { field: SearchSets.fieldLabel(rule.field).toUpperCase(), op: opLabel(rule), value: this.ruleValueLabel(rule) };
      this.ruleLabels.set(rule, labels);
    }
    return labels;
  }

  /** The value button's text: the typed text, the picked value (a list: the first two and how many more), or a prompt. */
  private ruleValueLabel(rule: SetRule): string {
    const op = ruleOperator(rule), count = ruleValueCount(rule), scene = this.session.scene;
    if (RuleOp.isText(op)) { return count === 0 || !ruleValueAt(rule, 0) ? 'TYPE…' : `“${ruleValueAt(rule, 0)}”`; }
    if (count === 0) { return RuleOp.isList(op) ? 'TICK VALUES…' : 'PICK…'; }
    const field = RuleField.normalise(rule.field);
    const label = (i: number) => field === RuleField.LINK && !ruleValueAt(rule, i) ? 'HOST MODEL' : SearchSets.valueLabel(field, ruleValueAt(rule, i), false, scene);
    if (count === 1) { return label(0); }
    return count === 2 ? `${label(0)}, ${label(1)}` : `${label(0)}, ${label(1)} +${count - 2}`;
  }

  private beginRuleText(rule: SetRule): void {
    this.session.editor.beginCustom(`${SearchSets.fieldLabel(rule.field).toUpperCase()} ${opLabel(rule)}`, ruleValueCount(rule) > 0 ? ruleValueAt(rule, 0) : '', 80, text => {
      setRuleValues(rule, [text]);
      this.setEdited();
    });
  }

  // #endregion

  // #region Value picker

  private openPicker(rule: SetRule): void {
    this.pickerRule = rule;
    this.pickerValues = SearchSets.valuesOf(this.session.scene, rule.field);
    this.pickerSearch = '';
    this.pickerScroll = 0;
    this.pickerDirty = true;
    this.refreshPickerHeader();
  }

  private refreshPickerHeader(): void {
    const rule = this.pickerRule;
    if (!rule) { return; }
    const field = SearchSets.fieldLabel(rule.field).toUpperCase(), op = opLabel(rule);
    this.pickerHeader = RuleOp.isList(ruleOperator(rule))
      ? `TICK: ${field} ${op} · ${ruleValueCount(rule)} PICKED · TYPE TO FILTER`
      : `PICK: ${field} ${op} · TYPE TO FILTER`;
  }

  /** The picker (in place of the set editor): typing filters; a click picks or ticks; TYPE A VALUE…; CLEAR / DONE or BACK. */
  private buildValuePicker(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets;
    const rule = this.pickerRule!;
    const multi = RuleOp.isList(ruleOperator(rule));
    if (input.isPressedOrRepeated(Vk.BACK)) {
      this.pickerSearch = input.isDown(Vk.CONTROL) ? '' : this.pickerSearch.slice(0, -1);
      this.pickerDirty = true;
    }
    for (const c of input.typed) {
      if (c >= ' ' && c !== '\u007f' && this.pickerSearch.length < SEARCH_MAX) {
        this.pickerSearch += c;
        this.pickerDirty = true;
      }
    }
    if (this.pickerDirty) {
      this.pickerDirty = false;
      this.pickerScroll = 0;
      const search = this.pickerSearch.trim().toLocaleLowerCase();
      this.pickerMatches = search ? this.pickerValues.filter(v => v.label.toLocaleLowerCase().includes(search)) : [...this.pickerValues];
    }

    ui.text(f.small, x, y + this.s(4), this.pickerHeader, UiTheme.ACCENT, this.s(1.2));
    let cy = y + this.s(26);
    const boxH = this.s(34);
    ui.panel(x, cy, w, boxH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
    if (!this.pickerSearch) { ui.text(f.body, x + this.s(10), cy + this.s(8), 'type part of a name…', UiTheme.TEXT_FAINT); }
    else {
      const used = ui.text(f.body, x + this.s(10), cy + this.s(8), this.pickerSearch, UiTheme.TEXT);
      if ((Math.trunc(session.clock * 2) & 1) === 0) { ui.rect(x + this.s(11) + used, cy + this.s(7), this.s(2), boxH - this.s(14), UiTheme.TEXT_SOFT); }
    }
    cy += boxH + this.s(10);

    const listBottom = bottom - this.s(44);
    const rowH = this.s(34);
    const visible = Math.max(1, Math.trunc((listBottom - cy) / rowH));
    const maxScroll = Math.max(0, this.pickerMatches.length - visible);
    if (input.wheel !== 0) { this.pickerScroll -= input.wheel * 3; }
    this.pickerScroll = Math.min(Math.max(this.pickerScroll, 0), maxScroll);
    let picked: RuleValue | null = null;
    const last = Math.min(this.pickerMatches.length, this.pickerScroll + visible);
    const tick = multi ? this.s(28) : 0;
    for (let i = this.pickerScroll; i < last; i++) {
      const value = this.pickerMatches[i];
      const ry = cy + (i - this.pickerScroll) * rowH;
      const hover = this.hover(input, x, ry, w, rowH - this.s(4));
      const current = ruleHasValue(rule, value.value);
      const fill = current ? Rgba.hex(0x22d3ee, 0.14) : hover ? Rgba.hex(0xffffff, 0.08) : (i & 1) === 0 ? Rgba.hex(0xffffff, 0.03) : 0;
      if (fill) { ui.rect(x, ry, w, rowH - this.s(4), fill); }
      if (multi) {
        const box = this.s(16), bxx = x + this.s(8), byy = ry + (rowH - this.s(4) - box) * 0.5;
        ui.rect(bxx, byy, box, box, current ? UiTheme.ACCENT : UiTheme.CONTROL);
        ui.outline(bxx, byy, box, box, Math.max(1, ui.scale), current ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
        if (current) { wd.tick(bxx, byy, box, Rgba.hex(0x06232a)); }
      }
      ui.textWrapped(f.body, x + this.s(10) + tick, ry + this.s(6), w - this.s(110) - tick, value.label, UiTheme.TEXT, 1);
      ui.textRight(f.small, x + w - this.s(10), ry + this.s(8), value.count.toLocaleString('en'), UiTheme.TEXT_MUTED);
      if (hover && input.leftPressed) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        picked = value;
      }
    }
    if (this.pickerMatches.length === 0) { ui.text(f.body, x, cy + this.s(6), 'Nothing in the model matches: TYPE A VALUE… instead.', UiTheme.TEXT_MUTED); }

    const by = bottom - this.s(34);
    let typeValue: boolean, clear = false, back: boolean;
    if (multi) {
      const bw3 = (w - this.s(12)) / 3;
      typeValue = wd.smallButton(f, x, by, bw3, this.s(32), 'TYPE A VALUE…');
      clear = wd.smallButton(f, x + bw3 + this.s(6), by, bw3, this.s(32), 'CLEAR');
      back = wd.smallButton(f, x + (bw3 + this.s(6)) * 2, by, bw3, this.s(32), 'DONE');
    } else {
      const bw2 = (w - this.s(6)) / 2;
      typeValue = wd.smallButton(f, x, by, bw2, this.s(32), 'TYPE A VALUE…');
      back = wd.smallButton(f, x + bw2 + this.s(6), by, bw2, this.s(32), 'BACK');
    }

    if (picked) {
      if (multi) {
        toggleRuleValue(rule, picked.value);
        this.refreshPickerHeader();
      } else {
        setRuleValues(rule, [picked.value]);
        this.pickerRule = null;
      }
      this.setEdited();
    } else if (clear) {
      setRuleValues(rule, []);
      this.refreshPickerHeader();
      this.setEdited();
    } else if (typeValue) {
      this.pickerRule = null;
      const title = `${SearchSets.fieldLabel(rule.field).toUpperCase()} ${opLabel(rule)}`;
      session.editor.beginCustom(multi ? title + ' (ADDS A VALUE)' : title, multi || ruleValueCount(rule) === 0 ? '' : ruleValueAt(rule, 0), 80, text => {
        if (multi) {
          if (!ruleHasValue(rule, text)) { toggleRuleValue(rule, text); }
        } else {
          setRuleValues(rule, [text]);
        }
        this.setEdited();
      });
    } else if (back) {
      this.pickerRule = null;
    }
  }

  // #endregion

  // #region Labels

  /** Rebuilds the test and set labels when something changed (data or display units). */
  private refreshRows(): void {
    const document = this.clashes.document!;
    const scene = this.session.scene;
    if (this.rowsUnits !== UnitFormat.revision) { this.rowsDirty = true; }
    if (!this.rowsDirty) { return; }
    this.rowsDirty = false;
    this.rowsUnits = UnitFormat.revision;
    this.ruleLabels.clear();

    this.setRows = [];
    const sizes = new Map<string, number>();
    for (const set of document.sets) {
      const members = SearchSets.elementsIn(set, scene);
      const linked = members.filter(i => scene.elements[i].link > 0).length;
      const usedBy = document.tests.filter(t => t.setA === set.id || t.setB === set.id).length;
      const rules = allRules(set).length, groups = set.groups?.length ?? 0;
      sizes.set(set.id, members.length);
      this.setRows.push({
        set, title: set.name, elements: members.length, usedBy,
        detail: `${members.length.toLocaleString('en')} elements${linked > 0 ? ` (${linked.toLocaleString('en')} in links)` : ''} · ${plural(rules, 'rule')}`
          + (groups > 0 ? ` in ${plural(groups, 'group')}` : '') + (usedBy > 0 ? ` · used by ${plural(usedBy, 'test')}` : '')
      });
    }

    const state = this.clashes.modelState();
    this.testRows = [];
    for (const test of document.tests) {
      const a = findSet(document, test.setA), b = test.setB ? findSet(document, test.setB) : null;
      const setLabel = (s: SearchSet | null) => s ? `${s.name} (${(sizes.get(s.id) ?? 0).toLocaleString('en')})` : '(missing set)';
      const changed = test.lastRunUtc !== null && test.lastRunModel !== state;
      const when = !test.lastRunUtc ? 'Not run yet.'
        : changed ? (test.lastRunModel === 'edited' ? 'The test changed since its last run: RUN again.' : 'The model changed since the last run: RUN again.')
          : `Last run ${formatWhen(test.lastRunUtc)}${test.lastRunTruncated ? ' (stopped at the limit: narrow the sets)' : ''}.`;
      const counts = ClashMerge.countByStatus(document, test.id);
      const total = counts.reduce((p, q) => p + q, 0);
      const countText = total === 0 ? 'No clashes.'
        : counts.map((n, k) => n > 0 ? `${n.toLocaleString('en')} ${ClashStatus.ALL[k]}` : '').filter(Boolean).join(' · ');
      const tolerance = UnitFormat.length(test.tolerance, 3);
      const kind = test.kind === ClashKind.CLEARANCE ? `clearance ${tolerance}` : `hard, ignore ≤ ${tolerance}`;
      this.testRows.push({
        test, title: test.name,
        detail: changed ? `${kind} · changed since the last run` : `${kind} · ${countText}`,
        setA: setLabel(a),
        setB: !test.setB ? '(set A against itself)' : isSelfTest(test) ? setLabel(b) + ' · against itself' : setLabel(b),
        tolerance, counts: countText, lastRun: when, changed
      });
    }
  }

  // #endregion
}

/** "7 Oct 14:05" in local time. */
function formatWhen(utc: string): string {
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) { return utc; }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
