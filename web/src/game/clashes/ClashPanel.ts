import { type ClashGroup, ClashGroups } from '../../core/clashes/ClashGroups';
import { ClashMerge } from '../../core/clashes/ClashMerge';
import {
  allRules, type ClashTest, ClashDefaults, ClashKind, ClashStatus, copySet, findSet, findTest, groupAllRules, isSelfTest, newRule, newSet, newTest, RULE_GROUP_MAX_DEPTH,
  RuleField, type RuleGroup, RuleNumbers, RuleOp, ruleHasValue, ruleIsField, ruleOperator, ruleValueAt, ruleValueCount, type SearchSet, type SetRule, setRuleField,
  setRuleOperator, setRuleValues, toggleRuleValue
} from '../../core/clashes/ClashModels';
import { type ClashSetupKind, type ClashNameClash, type ClashSetupPlan, ClashSetupFiles } from '../../core/clashes/ClashSetupFiles';
import { type RuleValue, SearchSets } from '../../core/clashes/SearchSets';
import { ParameterTable } from '../../core/scene/ModelInfo';
import { Rgba } from '../../engine/ui/Rgba';
import { UiBatch } from '../../engine/ui/UiBatch';
import type { FontAtlas } from '../../engine/ui/UiFont';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { downloadBlob, pickFile, safeFileName } from '../../platform/files';
import { type InputState, Vk } from '../../platform/input';
import type { GameSession } from '../GameSession';
import { FOOTER_LEFT, PanelSize, ScrollRegion, ShellStyle } from '../PanelShell';
import { UnitFormat } from '../UnitFormat';
import { clashStatusColour, type Clashes } from './Clashes';

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
  /** Polish round P-C: the test's groups (name · members · status), shown in the editor. */
  groups: { group: ClashGroup; label: string; status: string }[];
}

interface SetRow {
  set: SearchSet;
  title: string;
  detail: string;
  elements: number;
  usedBy: number;
}

/** A set editor line: a group header has no rule; top-level rules have no group (P-C: depth, parent, "GROUP 2.1"). */
interface RuleLine { group: RuleGroup | null; rule: SetRule | null; depth: number; parent: RuleGroup | null; number: string | null }

const TABS = ['TESTS', 'SETS'];
const KINDS = ['HARD', 'CLEARANCE'];
const MATCH = ['ANY RULE', 'ALL RULES'];
const GROUP_MATCH = ['ANY OF', 'ALL OF'];
const FIELD_LABELS = RuleField.ALL.map(f => SearchSets.fieldLabel(f).toUpperCase());
const DROP_SET_A = 1, DROP_SET_B = 2, DROP_RULE_FIELD = 3, DROP_RULE_OP = 4, DROP_IMPORT_ROW = 100;
const SEARCH_MAX = 40;
/** The taken-name choice (ClashNameClash order). */
const NAME_OPTIONS = ['REPLACE', 'KEEP BOTH', 'SKIP'];
const NAME_VALUES: ClashNameClash[] = ['replace', 'keepBoth', 'skip'];
const KEEP_VALUE = '(leave as it is)', DROP_VALUE = '(remove from the rules)';

function plural(n: number, word: string, many = word + 's'): string {
  return `${n.toLocaleString('en')} ${n === 1 ? word : many}`;
}

function opLabel(rule: SetRule): string {
  return RuleOp.LABELS[Math.max(0, RuleOp.indexOf(ruleOperator(rule)))];
}

/**
 * The CLASHES panel (port of GameSession.ClashPanel, Round C; pause menu → CLASHES, or TESTS… in clash mode; on the
 * panel shell in place of the pause menu): TESTS (tick for RUN ALL; the selected test's name, kind, sets, tolerance, its
 * groups, RUN, REVIEW, RESET, DUPLICATE, DELETE) and SETS (the selected set's name, any / all, rules with field / operator
 * dropdowns and a value picker, nested rule groups, DUPLICATE, DELETE). RUN ALL in the header; EXPORT / IMPORT the tab's
 * tests or sets, RESET ALL in the footer. An import that meets taken names or missing links / levels opens a reconcile
 * card first (QOL round).
 */
export class ClashPanel {
  isOpen = false;
  private tab = 0;
  private readonly scroll = new ScrollRegion();
  private readonly ruleScroll = new ScrollRegion();
  private readonly editorScroll = new ScrollRegion();
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
  private parameterHintShown = false;
  /** P-C: a group row clicked in the test editor: REVIEW opens on it. */
  private groupPick: ClashGroup | null = null;

  // The set editor's lines (rebuilt only when the set or its structure changes)
  private readonly ruleLines: RuleLine[] = [];
  private ruleLinesSet: SearchSet | null = null;
  private ruleLinesVersion = -1;
  private ruleStructure = 0;

  // The rule value picker (SETS tab)
  pickerRule: SetRule | null = null;
  private pickerValues: RuleValue[] = [];
  private pickerMatches: RuleValue[] = [];
  private pickerSearch = '';
  private readonly pickerScroll = new ScrollRegion();
  private pickerDirty = false;
  private pickerHeader = '';

  // QOL round: the import waiting on the reconcile card
  private importPlan: ClashSetupPlan | null = null;
  private importName = '';
  private importLinkValues: string[] = [];
  private importLinkLabels: string[] = [];
  private importLevelValues: string[] = [];
  private readonly importScroll = new ScrollRegion();

  constructor(private readonly session: GameSession, private readonly clashes: Clashes) {}

  private s(v: number): number { return this.session.s(v); }

  // #region Open / close

  /** Opens the panel (pause menu → CLASHES, TESTS… in clash mode), switching clash detection on the first time. */
  show(): void {
    const session = this.session, document = this.clashes.ensure();
    if (!session.paused) { session.setPaused(true); }
    this.isOpen = true;
    this.scroll.reset();
    this.ruleScroll.reset();
    this.editorScroll.reset();
    this.rowsDirty = true;
    this.pickerRule = null;
    this.deleteArmed = null;
    session.menu.closeOverlay();
    if (!findTest(document, this.selectedTest)) { this.selectedTest = this.clashes.reviewTest ?? document.tests[0]?.id ?? null; }
    if (!findSet(document, this.selectedSet)) { this.selectedSet = document.sets[0]?.id ?? null; }
  }

  /** Esc / CLOSE: an open dropdown or confirm first, the import card, then the value picker, then the panel. */
  close(): boolean {
    if (!this.isOpen) { return false; }
    const session = this.session;
    if (session.menu.closeOverlay()) { return true; }
    if (this.cancelImport()) { return true; } // QOL round: Esc leaves the import card first
    if (this.pickerRule) {
      this.pickerRule = null;
      return true;
    }
    this.isOpen = false;
    this.clashes.listDirty = true;
    if (session.profiles.returnFromClashes) {
      // Colour round A: EDIT SETS… came from the colour profiles panel: back there
      session.profiles.returnFromClashes = false;
      session.profiles.openPanel();
      return true;
    }
    if (this.clashes.modeOn) { session.setPaused(false); }
    return true;
  }

  /** Colour round A: opens on the SETS tab (EDIT SETS… from the colour profiles panel). */
  showSets(): void {
    this.tab = 1;
    this.scroll.reset();
    this.ruleScroll.reset();
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
    this.session.profiles.setsChanged(); // colour round A: a by-set profile follows its sets
    this.rowsDirty = true;
    this.clashes.listDirty = true;
    this.ruleStructure++; // P-C: the set editor's lines are rebuilt
  }

  // #endregion

  // #region Panel

  build(f: FontAtlas): void {
    const session = this.session, ui = session.ui, input = session.input, shell = session.shell, wd = session.menu.widgets;
    const document = this.clashes.ensure();
    session.menu.overlays.begin(input);
    this.refreshRows();

    // Header: the TESTS / SETS tabs and RUN ALL on the right
    const importing = this.importPlan !== null;
    const tabsW = this.s(260), RUN_ALL = 'RUN ALL';
    const runW = importing ? 0 : shell.buttonWidth(f, RUN_ALL);
    const sub = `${plural(document.tests.length, 'test')} · ${plural(document.sets.length, 'search set')} · saved with the model`;
    const frame = shell.beginPanel(PanelSize.Wide, 'CLASHES', UiTheme.ACCENT, sub, importing ? 0 : tabsW + this.s(UiTheme.GAP) + runW);
    let runAll = false;
    if (!importing) {
      const tabsX = shell.takeHeaderSlot(frame, tabsW, this.s(UiTheme.GAP));
      const tab = wd.segmented(f, tabsX, frame.headerControlY, tabsW, TABS, this.tab);
      if (tab !== this.tab) {
        this.tab = tab;
        this.scroll.reset();
        this.ruleScroll.reset();
        this.editorScroll.reset();
        this.pickerRule = null;
        this.deleteArmed = null;
        session.menu.closeOverlay();
      }
      runAll = shell.headerButton(frame, RUN_ALL, ShellStyle.Primary, document.tests.some(t => t.enabled), runW);
    }

    const ix = frame.ix, iw = frame.iw, cy = frame.bodyTop, bottom = frame.bodyBottom;
    const lw = Math.min(this.s(400), iw * 0.42);
    const rx = ix + lw + this.s(24), rw = iw - lw - this.s(24);
    const backLabel = this.clashes.modeOn ? '← CLASH MODE' : null;

    // QOL round: an import waiting on decisions takes the body (← BACK cancels it)
    if (importing) {
      this.buildImportCard(f, input, ix, cy, iw, bottom);
      const doImport = shell.footerAction('IMPORT', ShellStyle.Primary);
      const pressed = shell.endPanel(frame, null, 'Pick what each missing link or level becomes · ← BACK cancels the import', backLabel);
      if (pressed !== FOOTER_LEFT && this.isOpen && this.importPlan && pressed === doImport) { this.finishImport(this.importPlan); }
      if (this.isOpen) { session.menu.overlays.draw(f, input, frame.x, frame.y, frame.w, frame.h); }
      return;
    }

    ui.rect(rx - this.s(12), cy, Math.max(1, ui.scale), bottom - cy, UiTheme.CARD_BORDER);
    let run: ClashTest | null = null, review: ClashTest | null = null;
    if (this.tab === 0) {
      this.buildTestList(f, input, ix, cy, lw, bottom);
      [run, review] = this.buildTestEditor(f, input, rx, cy, rw, bottom);
    } else {
      this.buildSetList(f, input, ix, cy, lw, bottom);
      if (this.pickerRule) { this.buildValuePicker(f, input, rx, cy, rw, bottom); } else { this.buildSetEditor(f, input, rx, cy, rw, bottom); }
    }

    // QOL round: the tab's own tests / sets go to and from files (the clash report lives in clash mode now)
    const exportFile = shell.footerAction(this.tab === 0 ? 'EXPORT TESTS…' : 'EXPORT SETS…');
    const importFile = shell.footerAction(this.tab === 0 ? 'IMPORT TESTS…' : 'IMPORT SETS…');
    const resetAll = shell.footerAction('RESET ALL…', ShellStyle.Danger);
    const pressed = shell.endPanel(frame, null, 'Tick the tests RUN ALL runs · REVIEW opens clash mode on a test\'s results', backLabel);
    if (pressed === FOOTER_LEFT || !this.isOpen) { return; }
    session.menu.overlays.draw(f, input, frame.x, frame.y, frame.w, frame.h);
    if (!this.isOpen) { return; }

    // Actions after drawing (they open file pickers, the progress screen, a confirm or clash mode)
    if (run) { this.requestRun([run]); return; }
    if (review) {
      const pick = this.groupPick;
      this.groupPick = null;
      this.clashes.enter(null, review.id);
      if (pick && this.clashes.modeOn) { this.clashes.refreshList(); this.clashes.groups.clickGroupRow(pick, false); } // P-C: a group row in the panel
      return;
    }
    if (runAll) { this.requestRun(document.tests.filter(t => t.enabled)); return; }
    const kind: ClashSetupKind = this.tab === 0 ? 'tests' : 'sets';
    if (pressed === exportFile) { this.exportSetup(kind); return; }
    if (pressed === importFile) { void this.importSetup(kind); return; }
    if (pressed === resetAll) { this.requestReset(document.tests); }
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

  private buildTestList(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, shell = session.shell;
    const rowH = this.s(56);
    const listBottom = bottom - this.s(44);
    const top = shell.beginScroll(this.scroll, input, x, y, w, listBottom - y);
    const cw = w - this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.scroll.visibleRows(rowH, this.testRows.length);
    for (let i = first; i < last; i++) {
      const row = this.testRows[i], test = row.test;
      const ry = top + i * rowH;
      const selected = test.id === this.selectedTest;
      ui.rect(x, ry, cw, rowH - this.s(6), selected ? Rgba.hex(0x22d3ee, 0.12) : Rgba.hex(0xffffff, 0.03));
      const enabled = wd.checkbox(f, x + this.s(10), ry + this.s(10), this.s(20), '', test.enabled);
      if (enabled !== test.enabled) {
        test.enabled = enabled;
        input.consumeClicks();
        this.setupChanged();
      }
      ui.textWrapped(f.bold, x + this.s(40), ry + this.s(6), cw - this.s(50), row.title, selected ? UiTheme.ACCENT : UiTheme.TEXT, 1);
      ui.textWrapped(f.small, x + this.s(40), ry + this.s(28), cw - this.s(50), row.detail, row.changed ? Rgba.hex(0xfcd34d) : UiTheme.TEXT_MUTED, 1);
      if (wd.hover(x + this.s(36), ry, cw - this.s(36), rowH - this.s(6)) && input.leftPressed) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        this.selectedTest = test.id;
        this.deleteArmed = null;
        this.editorScroll.reset();
      }
    }
    if (this.testRows.length === 0) { ui.text(f.body, x, y + this.s(6), 'No tests yet: NEW TEST.', UiTheme.TEXT_MUTED); }
    shell.endScroll(this.scroll, input, top + this.testRows.length * rowH);
    if (wd.smallButton(f, x, bottom - this.s(34), this.s(140), this.s(32), 'NEW TEST')) { this.addTest(); }
  }

  /** The selected test's editor; returns the test to RUN and the one to REVIEW (clicked this frame). */
  private buildTestEditor(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): [ClashTest | null, ClashTest | null] {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, overlays = session.menu.overlays, shell = session.shell;
    const document = this.clashes.document!;
    const test = findTest(document, this.selectedTest);
    const row = test ? this.testRows.find(r => r.test === test) : undefined;
    if (!test || !row) {
      ui.text(f.body, x, y + this.s(6), 'Select a test, or NEW TEST.', UiTheme.TEXT_MUTED);
      return [null, null];
    }
    let run: ClashTest | null = null, review: ClashTest | null = null;

    // Polish round P-A1: the fields scroll (short windows); the buttons stay at the bottom
    const by = bottom - this.s(34);
    const editorW = w;
    let cy = shell.beginScroll(this.editorScroll, input, x, y, w, by - this.s(UiTheme.GAP) - y);
    w -= this.s(UiTheme.SCROLL_GUTTER);
    const labelW = this.s(110);
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
    cy += ui.textWrapped(f.body, x, cy, w, row.counts, UiTheme.TEXT_SOFT, 2);

    // Polish round P-C: the test's groups; a click reviews the test with that group picked
    if (row.groups.length > 0) {
      cy += this.s(12);
      ui.text(f.small, x, cy, 'GROUPS · CLICK ONE TO REVIEW IT', UiTheme.TEXT_MUTED, this.s(1.2));
      cy += this.s(22);
      const gh = this.s(30);
      for (const { group, label, status } of row.groups) {
        const hover = wd.hover(x, cy, w, gh - this.s(4));
        ui.rect(x, cy, w, gh - this.s(4), hover ? Rgba.hex(0xffffff, 0.08) : Rgba.hex(0xffffff, 0.03));
        ui.rect(x, cy, this.s(4), gh - this.s(4), clashStatusColour(group.status));
        const statusW = UiBatch.measure(f.small, status) + this.s(12);
        ui.textWrapped(f.body, x + this.s(12), cy + this.s(5), w - this.s(24) - statusW, label, UiTheme.TEXT, 1);
        ui.text(f.small, x + w - statusW, cy + this.s(8), status, clashStatusColour(group.status));
        if (hover && input.leftPressed) {
          input.consumeClicks();
          this.groupPick = group;
          review = test;
        }
        cy += gh;
      }
    }
    shell.endScroll(this.editorScroll, input, cy + this.s(8));
    w = editorW;

    const bw = (w - this.s(24)) / 5;
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
    this.scroll.scrollToEnd();
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
    const session = this.session, ui = session.ui, wd = session.menu.widgets, shell = session.shell;
    const document = this.clashes.document!;
    const rowH = this.s(52);
    const listBottom = bottom - this.s(44);
    const top = shell.beginScroll(this.scroll, input, x, y, w, listBottom - y);
    const cw = w - this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.scroll.visibleRows(rowH, this.setRows.length);
    for (let i = first; i < last; i++) {
      const row = this.setRows[i];
      const ry = top + i * rowH;
      const selected = row.set.id === this.selectedSet;
      const hover = wd.hover(x, ry, cw, rowH - this.s(6));
      ui.rect(x, ry, cw, rowH - this.s(6), selected ? Rgba.hex(0x22d3ee, 0.12) : hover ? Rgba.hex(0xffffff, 0.06) : Rgba.hex(0xffffff, 0.03));
      ui.textWrapped(f.bold, x + this.s(12), ry + this.s(6), cw - this.s(24), row.title, selected ? UiTheme.ACCENT : UiTheme.TEXT, 1);
      ui.textWrapped(f.small, x + this.s(12), ry + this.s(27), cw - this.s(24), row.detail, UiTheme.TEXT_MUTED, 1);
      if (hover && input.leftPressed) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        this.selectedSet = row.set.id;
        this.ruleScroll.reset();
        this.deleteArmed = null;
      }
    }
    if (this.setRows.length === 0) { ui.text(f.body, x, y + this.s(6), 'No sets yet: NEW SET.', UiTheme.TEXT_MUTED); }
    shell.endScroll(this.scroll, input, top + this.setRows.length * rowH);
    if (wd.smallButton(f, x, bottom - this.s(34), this.s(140), this.s(32), 'NEW SET')) {
      const set = newSet(`Set ${document.sets.length + 1}`);
      document.sets.push(set);
      this.selectedSet = set.id;
      this.scroll.scrollToEnd();
      this.setupChanged();
    }
  }

  /** The selected set's editor: name, any / all, rules and (nested) groups, the element count, DUPLICATE, DELETE. */
  private buildSetEditor(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, shell = session.shell;
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

    // C-B4: the lines: the set's own rules, then each group (a header, then its rules and groups indented)
    if (this.ruleLinesSet !== set || this.ruleLinesVersion !== this.ruleStructure) { this.buildRuleLines(set); }

    const footer = bottom - this.s(34) - this.s(52);
    const ruleH = this.s(38);
    const editorW = w, linesTop = cy;
    const top = shell.beginScroll(this.ruleScroll, input, x, cy, w, footer - cy);
    w -= this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.ruleScroll.visibleRows(ruleH, this.ruleLines.length);
    let remove: SetRule | null = null, removeFrom: RuleGroup | null = null, removeGroup: RuleGroup | null = null, removeParent: RuleGroup | null = null;
    let addTo: RuleGroup | null = null, addGroupTo: RuleGroup | null = null;
    const indent = this.s(20);
    for (let i = first; i < last; i++) {
      const line = this.ruleLines[i];
      const group = line.group, rule = line.rule;
      const ry = top + i * ruleH;
      if (!rule) {
        // Group header: "GROUP 2.1", ANY OF / ALL OF, ADD RULE, ADD GROUP (P-C: a group inside), ×
        const hx = x + Math.min(line.depth, 4) * indent, hw = w - (hx - x);
        for (let d = 0; d < line.depth && d < 4; d++) { ui.rect(x + this.s(8) + d * indent, ry, this.s(3), this.s(32), Rgba.hex(0x22d3ee, 0.35)); }
        ui.rect(hx, ry, hw, this.s(32), Rgba.hex(0x22d3ee, 0.07));
        ui.text(f.bold, hx + this.s(8), ry + this.s(8), line.number ?? '', UiTheme.ACCENT);
        const gx = hx + this.s(96), delW = this.s(32), addW = this.s(100);
        const segW = Math.max(this.s(120), Math.min(this.s(190), hw - this.s(96) - delW - addW * 2 - this.s(24)));
        const gm = wd.segmented(f, gx, ry, segW, GROUP_MATCH, group!.matchAll ? 1 : 0);
        if ((gm === 1) !== group!.matchAll) {
          group!.matchAll = gm === 1;
          this.setEdited();
        }
        if (wd.smallButton(f, x + w - delW - (addW + this.s(6)) * 2, ry, addW, this.s(32), 'ADD RULE')) { addTo = group; }
        if (wd.smallButton(f, x + w - delW - addW - this.s(6), ry, addW, this.s(32), 'ADD GROUP')) { addGroupTo = group; }
        if (wd.smallButton(f, x + w - delW, ry, delW, this.s(32), '×', true)) {
          removeGroup = group;
          removeParent = line.parent;
        }
        continue;
      }
      const rx = x + Math.min(line.depth, 4) * indent;
      for (let d = 0; d < line.depth && d < 4; d++) { ui.rect(x + this.s(8) + d * indent, ry, this.s(3), this.s(32), Rgba.hex(0x22d3ee, 0.35)); }
      if (this.buildRuleRow(f, input, rule, rx, ry, w - (rx - x), group !== null)) {
        remove = rule;
        removeFrom = group;
      }
    }
    if (this.ruleLines.length === 0) { ui.text(f.body, x, linesTop + this.s(6), 'No rules: every element is in this set. ADD RULE or ADD GROUP.', UiTheme.TEXT_MUTED); }
    shell.endScroll(this.ruleScroll, input, top + this.ruleLines.length * ruleH);
    w = editorW;
    if (remove) {
      const list = removeFrom ? removeFrom.rules : set.rules;
      list.splice(list.indexOf(remove), 1);
      this.setEdited();
    }
    if (addTo) {
      addTo.rules.push(newRule(RuleField.CATALOG, RuleOp.IS));
      this.setEdited();
    }
    if (addGroupTo) {
      // P-C: a group inside a group (ALL OF, one rule to fill in): one more condition of the outer group
      addGroupTo.groups ??= [];
      addGroupTo.groups.push({ matchAll: true, rules: [newRule(RuleField.CATALOG, RuleOp.IS)], groups: null });
      this.setEdited();
    }
    if (removeGroup) {
      const target = removeGroup, parent = removeParent;
      const rules = groupAllRules(target).length;
      if (rules === 0 && !target.groups) { this.removeGroup(set, parent, target); }
      else {
        session.menu.overlays.openConfirm('DELETE GROUP', `Delete ${this.groupNumber(target).toLowerCase()} and its ${plural(rules, 'rule')}?`,
          'DELETE', true, false, () => this.removeGroup(set, parent, target));
      }
    }

    ui.textWrapped(f.body, x, footer + this.s(10), w, row.detail, UiTheme.TEXT_SOFT, 1);
    const by = bottom - this.s(34), bw = (w - this.s(18)) / 4;
    if (wd.smallButton(f, x, by, bw, this.s(32), 'ADD RULE')) {
      // A row to fill in: BimGo category, IS, nothing picked (left out of matching until it has a value)
      set.rules.push(newRule(RuleField.CATALOG, RuleOp.IS));
      this.ruleScroll.reveal(set.rules.length * ruleH - ruleH, set.rules.length * ruleH); // the new rule sits before the groups
      this.setEdited();
    }
    if (wd.smallButton(f, x + bw + this.s(6), by, bw, this.s(32), 'ADD GROUP')) {
      set.groups ??= [];
      set.groups.push({ matchAll: true, rules: [newRule(RuleField.CATALOG, RuleOp.IS)], groups: null });
      this.ruleScroll.scrollToEnd();
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

  /** P-C: the set editor's lines (top-level rules, then each group depth first), with the headers' numbers. */
  private buildRuleLines(set: SearchSet): void {
    this.ruleLines.length = 0;
    this.ruleLinesSet = set;
    this.ruleLinesVersion = this.ruleStructure;
    for (const rule of set.rules) { this.ruleLines.push({ group: null, rule, depth: 0, parent: null, number: null }); }
    this.addGroupLines(set.groups, null, 0, 'GROUP ');
  }

  private addGroupLines(groups: RuleGroup[] | null, parent: RuleGroup | null, depth: number, prefix: string): void {
    if (!groups || depth >= RULE_GROUP_MAX_DEPTH) { return; }
    groups.forEach((group, g) => {
      if (!group) { return; }
      const number = prefix + (g + 1);
      this.ruleLines.push({ group, rule: null, depth, parent, number });
      for (const rule of group.rules) { this.ruleLines.push({ group, rule, depth: depth + 1, parent, number: null }); }
      this.addGroupLines(group.groups, group, depth + 1, number + '.');
    });
  }

  /** A group's header text ("GROUP 2.1"), from the current lines. */
  private groupNumber(group: RuleGroup): string {
    return this.ruleLines.find(l => !l.rule && l.group === group)?.number ?? 'the group';
  }

  /** One rule row: field ▾ (P-C: and each extracted parameter), operator ▾, value, ×. True when × was clicked. */
  private buildRuleRow(f: FontAtlas, input: InputState, rule: SetRule, x: number, ry: number, w: number, inGroup: boolean): boolean {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, overlays = session.menu.overlays;
    const fieldW = this.s(150), opW = this.s(150), delW = this.s(32), g = this.s(6);
    const valueW = Math.max(this.s(80), w - fieldW - opW - delW - g * 3);
    let bx = x;
    const labels = this.ruleLabelsOf(rule);

    // Field: the built-in fields, then (colour round A) each extracted parameter
    if (overlays.button(f, input, bx, ry, fieldW, this.s(32), labels.field, overlays.isDropdownOpen(rule, DROP_RULE_FIELD))) {
      const parameters = (session.scene.parameters ?? ParameterTable.empty).sortedNames();
      const choices = [...FIELD_LABELS, ...parameters.map(n => 'PARAMETER: ' + n)];
      const selected = RuleField.normalise(rule.field) === RuleField.PARAMETER
        ? FIELD_LABELS.length + parameters.findIndex(n => n.toLowerCase() === (rule.parameter ?? '').toLowerCase())
        : RuleField.ALL.indexOf(RuleField.normalise(rule.field));
      overlays.openDropdown(rule, DROP_RULE_FIELD, bx, ry, fieldW, this.s(32), choices, Math.max(-1, selected), k => {
        const field = k < RuleField.ALL.length ? RuleField.ALL[k] : RuleField.PARAMETER;
        const parameter = k < RuleField.ALL.length ? null : parameters[k - RuleField.ALL.length];
        if (ruleIsField(rule, field, parameter)) { return; }
        setRuleField(rule, field, parameter);
        this.ruleLabels.delete(rule);
        this.setEdited();
      });
      if (parameters.length === 0 && !this.parameterHintShown) {
        this.parameterHintShown = true;
        session.toast('Parameter rules: tick parameters in Revit Options → Parameters, then Go / Export again', 4);
      }
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
      const op = ruleOperator(rule);
      if (RuleOp.isText(op)) { this.beginRuleText(rule); }
      else if (RuleOp.isNumeric(op)) { this.beginRuleNumber(rule); } // colour round B
      else { this.openPicker(rule); }
    }
    bx += valueW + g;
    return wd.smallButton(f, bx, ry, delW, this.s(32), '×', true);
  }

  /** C-B4: removes a group from the set or (P-C) from the group holding it; the list goes back to null when none is left. */
  private removeGroup(set: SearchSet, parent: RuleGroup | null, group: RuleGroup): void {
    const owner = parent ? parent.groups : set.groups;
    if (!owner) { return; }
    const index = owner.indexOf(group);
    if (index < 0) { return; }
    owner.splice(index, 1);
    if (owner.length === 0) {
      if (parent) { parent.groups = null; } else { set.groups = null; }
    }
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
      labels = { field: SearchSets.ruleFieldLabel(rule).toUpperCase(), op: opLabel(rule), value: this.ruleValueLabel(rule) };
      this.ruleLabels.set(rule, labels);
    }
    return labels;
  }

  /** The value button's text: typed numbers or text, the picked value (a list: the first two and how many more), or a prompt. */
  private ruleValueLabel(rule: SetRule): string {
    const op = ruleOperator(rule), count = ruleValueCount(rule), scene = this.session.scene;
    if (RuleOp.isNumeric(op)) {
      // Colour round B: typed numbers
      if (op === RuleOp.BETWEEN) { return count < 2 ? 'TYPE TWO NUMBERS…' : `${ruleValueAt(rule, 0)} – ${ruleValueAt(rule, 1)}`; }
      return count === 0 ? 'TYPE A NUMBER…' : ruleValueAt(rule, 0);
    }
    if (RuleOp.isText(op)) { return count === 0 || !ruleValueAt(rule, 0) ? 'TYPE…' : `“${ruleValueAt(rule, 0)}”`; }
    if (count === 0) { return RuleOp.isList(op) ? 'TICK VALUES…' : 'PICK…'; }
    const field = RuleField.normalise(rule.field);
    const label = (i: number) => field === RuleField.LINK && !ruleValueAt(rule, i) ? 'HOST MODEL' : SearchSets.valueLabel(field, ruleValueAt(rule, i), false, scene);
    if (count === 1) { return label(0); }
    return count === 2 ? `${label(0)}, ${label(1)}` : `${label(0)}, ${label(1)} +${count - 2}`;
  }

  private beginRuleText(rule: SetRule): void {
    this.session.editor.beginCustom(`${SearchSets.ruleFieldLabel(rule).toUpperCase()} ${opLabel(rule)}`, ruleValueCount(rule) > 0 ? ruleValueAt(rule, 0) : '', 80, text => {
      setRuleValues(rule, [text]);
      this.setEdited();
    });
  }

  /** Colour round B: an at least / at most / between rule's numbers, typed ("600", "300 to 600"; units ignored). */
  private beginRuleNumber(rule: SetRule): void {
    const session = this.session;
    const between = ruleOperator(rule) === RuleOp.BETWEEN;
    const count = ruleValueCount(rule);
    const current = count === 0 ? '' : between && count >= 2 ? `${ruleValueAt(rule, 0)} to ${ruleValueAt(rule, 1)}` : ruleValueAt(rule, 0);
    const title = `${SearchSets.ruleFieldLabel(rule).toUpperCase()} ${opLabel(rule)}` + (between ? ' (TWO NUMBERS, E.G. 300 TO 600)' : ' (A NUMBER, UNITS AS SHOWN)');
    session.editor.beginCustom(title, current, 40, text => {
      const numbers = RuleNumbers.all(text, between ? 2 : 1);
      if (numbers.length < (between ? 2 : 1)) {
        session.toast(between ? 'Type two numbers, e.g. 300 to 600' : 'Type a number, e.g. 600', 3);
        return;
      }
      setRuleValues(rule, numbers.map(n => RuleNumbers.format(n)));
      this.setEdited();
    });
  }

  // #endregion

  // #region Value picker

  private openPicker(rule: SetRule): void {
    this.pickerRule = rule;
    this.pickerValues = SearchSets.valuesOf(this.session.scene, rule.field, rule.parameter);
    this.pickerSearch = '';
    this.pickerScroll.reset();
    this.pickerDirty = true;
    this.refreshPickerHeader();
  }

  private refreshPickerHeader(): void {
    const rule = this.pickerRule;
    if (!rule) { return; }
    const field = SearchSets.ruleFieldLabel(rule).toUpperCase(), op = opLabel(rule);
    this.pickerHeader = RuleOp.isList(ruleOperator(rule))
      ? `TICK: ${field} ${op} · ${ruleValueCount(rule)} PICKED · TYPE TO FILTER`
      : `PICK: ${field} ${op} · TYPE TO FILTER`;
  }

  /** The picker (in place of the set editor): typing filters; a click picks or ticks; TYPE A VALUE…; CLEAR / DONE or BACK. */
  private buildValuePicker(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, shell = session.shell;
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
      this.pickerScroll.reset();
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
    const pickerW = w;
    const top = shell.beginScroll(this.pickerScroll, input, x, cy, w, listBottom - cy);
    w -= this.s(UiTheme.SCROLL_GUTTER);
    const [first, last] = this.pickerScroll.visibleRows(rowH, this.pickerMatches.length);
    let picked: RuleValue | null = null;
    const tick = multi ? this.s(28) : 0;
    for (let i = first; i < last; i++) {
      const value = this.pickerMatches[i];
      const ry = top + i * rowH;
      const hover = wd.hover(x, ry, w, rowH - this.s(4));
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
    shell.endScroll(this.pickerScroll, input, top + this.pickerMatches.length * rowH);
    w = pickerW;

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
      const title = `${SearchSets.ruleFieldLabel(rule).toUpperCase()} ${opLabel(rule)}`;
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

  // #region Export / import (QOL round)

  /** EXPORT TESTS… / EXPORT SETS…: every test (with the sets it uses) or every set, downloaded. */
  private exportSetup(kind: ClashSetupKind): void {
    const session = this.session, document = this.clashes.ensure();
    const tests = kind === 'tests';
    if (tests ? document.tests.length === 0 : document.sets.length === 0) {
      session.sound.play(SoundId.Error);
      session.toast(tests ? 'No tests to export yet' : 'No sets to export yet', 2.5);
      return;
    }
    const file = ClashSetupFiles.build(document, kind, session.scene.links, session.scene.modelTitle, `BimGo Web ${__BIMGO_VERSION__}`);
    const name = safeFileName(session.scene.modelTitle) + (tests ? ' clash tests' : ' search sets') + '.json';
    downloadBlob(new Blob([ClashSetupFiles.serialize(file)], { type: 'application/json' }), name);
    session.sound.play(SoundId.Commit);
    session.toast(tests ? `${file.tests.length} tests and the ${file.sets.length} sets they use saved: ${name}` : `${file.sets.length} sets saved: ${name}`, 3.5);
  }

  /** IMPORT TESTS… / IMPORT SETS…: reads the file; straight in when nothing needs a decision, else the reconcile card. */
  private async importSetup(kind: ClashSetupKind): Promise<void> {
    const session = this.session, document = this.clashes.ensure();
    session.input.releaseAll();
    const picked = await pickFile('.json,application/json');
    if (!picked) { return; }
    const { file, error } = ClashSetupFiles.parse(await picked.text(), kind);
    if (!file) {
      session.sound.play(SoundId.Error);
      session.toast(error ?? 'The file could not be read.', 5, true);
      return;
    }
    if (file.sets.length === 0 && file.tests.length === 0) {
      session.toast('The file holds no tests or sets', 3);
      return;
    }
    const scene = session.scene;
    const levels = SearchSets.valuesOf(scene, RuleField.LEVEL);
    const plan = ClashSetupFiles.plan(file, document, scene.links, levels.map(l => l.value));
    if (plan.nameClashes.length === 0 && plan.missing.length === 0) {
      this.finishImport(plan);
      return;
    }
    // Something to decide: the card (choices: leave, remove, then what this model has)
    this.importPlan = plan;
    this.importName = picked.name;
    this.importScroll.reset();
    const links = SearchSets.valuesOf(scene, RuleField.LINK);
    this.importLinkValues = links.map(l => l.value);
    this.importLinkLabels = links.map(l => l.label);
    this.importLevelValues = levels.filter(l => l.value.length > 0).map(l => l.value);
    this.pickerRule = null;
    session.menu.closeOverlay();
    session.sound.play(SoundId.UiClick);
  }

  /** Applies the import and says what it did. */
  private finishImport(plan: ClashSetupPlan): void {
    const session = this.session;
    this.importPlan = null;
    const r = ClashSetupFiles.apply(plan, this.clashes.document!);
    this.setupChanged();
    session.sound.play(SoundId.Commit);
    const parts: string[] = [];
    if (r.testsAdded > 0) { parts.push(`${r.testsAdded} tests added`); }
    if (r.testsReplaced > 0) { parts.push(`${r.testsReplaced} tests replaced`); }
    if (r.setsAdded > 0) { parts.push(`${r.setsAdded} sets added`); }
    if (r.setsReplaced > 0) { parts.push(`${r.setsReplaced} sets replaced`); }
    if (r.skipped > 0) { parts.push(`${r.skipped} skipped`); }
    if (r.valuesChanged > 0) { parts.push(`${r.valuesChanged} link / level values changed`); }
    const from = plan.file.modelTitle ? ` from ${plan.file.modelTitle}` : '';
    session.toast(parts.length === 0 ? 'Nothing new to import' : `Imported${from}: ${parts.join(', ')}. Run the tests to see their clashes.`, 5);
  }

  /** Esc / ← BACK on the card. */
  private cancelImport(): boolean {
    if (!this.importPlan) { return false; }
    this.importPlan = null;
    this.session.menu.closeOverlay();
    this.session.toast('Import cancelled', 1.5);
    return true;
  }

  /** The reconcile card (in the panel's body): the taken-name choice and one row per missing link / level. */
  private buildImportCard(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, overlays = session.menu.overlays, shell = session.shell;
    const plan = this.importPlan!;
    const tests = ClashSetupFiles.kindOf(plan.file) === 'tests';
    let cy = y;
    ui.text(f.bold, x, cy, tests ? 'IMPORT TESTS' : 'IMPORT SETS', UiTheme.TEXT, this.s(1.2));
    ui.textRight(f.small, x + w, cy + this.s(3), `${this.importName}${plan.file.modelTitle ? ' · from ' + plan.file.modelTitle : ''} · ${plan.file.tests.length} tests, ${plan.file.sets.length} sets`,
      UiTheme.TEXT_MUTED);
    cy += this.s(34);

    if (plan.nameClashes.length > 0) {
      const names = plan.nameClashes.slice(0, 4).join(', ') + (plan.nameClashes.length > 4 ? ` and ${plan.nameClashes.length - 4} more` : '');
      cy += ui.textWrapped(f.body, x, cy, w, `Already here: ${names}.`, UiTheme.TEXT_SOFT, 2) + this.s(6);
      const segW = Math.min(w, this.s(420));
      const choice = wd.segmented(f, x, cy, segW, NAME_OPTIONS, NAME_VALUES.indexOf(plan.onNameClash));
      if (choice >= 0) { plan.onNameClash = NAME_VALUES[choice]; }
      const help = plan.onNameClash === 'replace' ? (tests ? 'Their definitions are overwritten; their clashes stay (re-run them).' : 'Their rules are overwritten.')
        : plan.onNameClash === 'keepBoth' ? 'The imported ones are added as “Name (2)”.' : 'The imported ones with these names are left out.';
      ui.text(f.small, x + segW + this.s(12), cy + this.s(9), help, UiTheme.TEXT_MUTED);
      cy += this.s(46);
    }

    if (plan.missing.length === 0) {
      ui.text(f.body, x, cy, 'Every link and level the rules name is in this model.', UiTheme.TEXT_MUTED);
      return;
    }
    ui.text(f.small, x, cy, 'NOT IN THIS MODEL: PICK WHAT EACH BECOMES', UiTheme.TEXT_MUTED, this.s(1.6));
    cy += this.s(24);
    const rowH = this.s(38);
    const top = shell.beginScroll(this.importScroll, input, x, cy, w, bottom - cy);
    const cw = w - this.s(UiTheme.SCROLL_GUTTER);
    const labelW = cw * 0.45;
    const [first, last] = this.importScroll.visibleRows(rowH, plan.missing.length);
    const labelOf = (values: string[], labels: string[], value: string) => {
      const i = values.findIndex(v => v.toLowerCase() === value.toLowerCase());
      return i >= 0 ? labels[i] : value;
    };
    for (let index = first; index < last; index++) {
      const ry = top + index * rowH;
      const m = plan.missing[index];
      const link = m.field === RuleField.LINK;
      ui.textWrapped(f.body, x, ry + this.s(7), labelW - this.s(10), `${link ? 'Link' : 'Level'}  ${m.label}${m.uses > 1 ? `  (${m.uses} rules)` : ''}`, UiTheme.TEXT, 1);
      const values = link ? this.importLinkValues : this.importLevelValues;
      const labels = link ? this.importLinkLabels : this.importLevelValues;
      const current = m.replacement === null ? KEEP_VALUE : m.replacement === ClashSetupFiles.DROP ? DROP_VALUE
        : labelOf(values, labels, m.replacement) + (m.autoMatched ? '  (matched by name)' : '');
      const dx = x + labelW, dw = cw - labelW;
      if (overlays.button(f, input, dx, ry, dw, this.s(30), current, overlays.isDropdownOpen(plan, DROP_IMPORT_ROW + index))) {
        const choices = [KEEP_VALUE, DROP_VALUE, ...labels];
        const selected = m.replacement === null ? 0 : m.replacement === ClashSetupFiles.DROP ? 1 : 2 + values.findIndex(v => v.toLowerCase() === m.replacement!.toLowerCase());
        overlays.openDropdown(plan, DROP_IMPORT_ROW + index, dx, ry, dw, this.s(30), choices, selected, i => {
          m.autoMatched = false;
          m.replacement = i === 0 ? null : i === 1 ? ClashSetupFiles.DROP : values[i - 2];
        });
      }
    }
    shell.endScroll(this.importScroll, input, top + plan.missing.length * rowH);
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
    let byId: Map<string, import('../../core/clashes/ClashModels').ClashRecord> | null = null;
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

      // Polish round P-C: its groups (members found, status; "mixed" when members differ)
      const groups: TestRow['groups'] = [];
      for (const group of ClashGroups.ofTest(document, test.id)) {
        byId ??= ClashGroups.clashesById(document);
        const summary = ClashGroups.summarise(group, byId);
        const count = group.clashIds.length;
        groups.push({
          group, label: `${ClashGroups.displayName(group)} · ${count.toLocaleString('en')} clash${count === 1 ? '' : 'es'}`,
          status: ClashStatus.label(group.status).toUpperCase() + (summary.mixed ? ' · MIXED' : '')
        });
      }
      const groupText = groups.length === 0 ? '' : ` · ${plural(groups.length, 'group')}`;
      this.testRows.push({
        test, title: test.name,
        detail: changed ? `${kind} · changed since the last run` : `${kind} · ${countText}${groupText}`,
        setA: setLabel(a),
        setB: !test.setB ? '(set A against itself)' : isSelfTest(test) ? setLabel(b) + ' · against itself' : setLabel(b),
        tolerance, counts: countText + groupText, lastRun: when, changed, groups
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
