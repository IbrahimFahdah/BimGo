import { ClashEngine, type ClashItem, ClashItems, type ClashJob, type ClashProgress } from '../../core/clashes/ClashEngine';
import { ClashFiles } from '../../core/clashes/ClashFiles';
import { ClashFraming, type ClashView } from '../../core/clashes/ClashFraming';
import { ClashMerge } from '../../core/clashes/ClashMerge';
import {
  ClashCommentRules, ClashDefaults, type ClashDocument, type ClashElementRef, ClashKind, type ClashRecord, ClashStatus, type ClashTest, clashDocumentJson,
  elementRefKey, elementRefLabel, findSet, findTest, isSelfTest, type SearchSet
} from '../../core/clashes/ClashModels';
import { SearchSets } from '../../core/clashes/SearchSets';
import { type CommentRecord, hasMarkup } from '../../core/format/DocumentModels';
import { type Vec3, vec3 } from '../../core/math/Vector';
import { InputAction } from '../../core/scene/InputCatalog';
import { CLASH_VIEW_NAME, type ClashViewRequest } from '../../core/live/LiveProtocol';
import { Aabb, linkOf, type ElementRecord } from '../../core/scene/SceneData';
import { SectionCut } from '../../core/scene/SectionCut';
import { gl } from '../../engine/gl/Gl';
import type { DynamicInstance } from '../../engine/physics/DynamicSet';
import type { Overlay3D } from '../../engine/render/Overlay3D';
import type { SceneDrawParams } from '../../engine/render/SceneRenderer';
import { Rgba } from '../../engine/ui/Rgba';
import type { FontAtlas } from '../../engine/ui/UiFont';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { downloadBlob, pickFile, safeFileName } from '../../platform/files';
import { KeyHint, keyOf } from '../../platform/Hotkeys';
import { type InputState, Vk } from '../../platform/input';
import type { GameSession } from '../GameSession';
import { PhotoTarget } from '../PhotoMode';
import type { ProgressState } from '../ProgressScreen';
import { UnitFormat } from '../UnitFormat';
import { ScrollRegion } from '../PanelShell';
import { ClashPanel } from './ClashPanel';
import { CLASH_SHOW_CHOICES, CLASH_SHOW_LABELS, CLASH_TOOL_ACTIONS, ClashGroupUi } from './ClashGroupUi';
import { ClashReportUi } from './ClashReportUi';
import { CLASH_TOOL_BOX, CLASH_TOOL_NONE, CLASH_TOOL_PICK, CLASH_TOOL_SPHERE, ClashTools } from './ClashTools';

/** The rest of the model in the clash view (G cycles). */
export const ClashViewMode = { GHOST: 0, WIREFRAME: 1, REAL: 2, HIDDEN: 3 } as const;
export const CLASH_VIEW_NAMES = ['GHOST', 'WIREFRAME', 'REAL MODEL', 'HIDDEN'];
export const CLASH_STATUS_FILTERS = ['ALL', 'OPEN', 'NEW', 'ACTIVE', 'REVIEWED', 'APPROVED', 'RESOLVED'];
const CLASH_STATUS_SHORT = ['1 NEW', '2 ACTIVE', '3 REVIEW', '4 APPROVE', '5 RESOLVE'];
const CLASH_GHOST = 0.15, CLASH_WIRE = 0.4;
const A_TINT = [0.94, 0.27, 0.27, 0.75], B_TINT = [0.13, 0.77, 0.37, 0.75], BOTH_TINT = [0.98, 0.62, 0.10, 0.75];
const SEARCH_MAX = 40;
/** Above this many selected clashes the section box stays off; above CLASH_REVIT_WARN, R asks first. */
const CLASH_FOCUS_BOX_CAP = 200, CLASH_REVIT_WARN = 500;
const THUMB_W = 160, THUMB_H = 90, THUMB_RENDER_W = 320, THUMB_RENDER_H = 180, THUMB_CACHE_MAX = 300;
const SHOT_W = 1280, SHOT_H = 720;
const PICTURE_BUDGET_MS = 40;
const DROP_DOCK_TEST = 11, DROP_DOCK_STATUS = 12, DROP_DOCK_LEVEL = 13, DROP_DOCK_VIEW = 14, DROP_DOCK_REPORT = 15, DROP_DOCK_AUTO = 16, DROP_DOCK_SHOW = 19;
/** REPORT… (C-C3: the HTML / XML report's card first; the BimGo JSON exchange as before). */
const CLASH_REPORT_ACTIONS = ['EXPORT REPORT (HTML / XML)…', 'EXPORT BIMGO REPORT (JSON)…', 'IMPORT BIMGO REPORT (JSON)…'];
const CARD_BUTTONS_Y = 210;
/** Comment thumbnails as other comments (192 × 108 JPEG). */
const COMMENT_THUMB_W = 192, COMMENT_THUMB_H = 108;

const CLASH_HINT = new KeyHint(() =>
  `${keyOf(InputAction.ClashPrevious)} ${keyOf(InputAction.ClashNext)} previous / next · ${keyOf(InputAction.ClashFrame)} re-frame · `
  + `1–5 status · ${keyOf(InputAction.ClashView)} view · ${keyOf(InputAction.ClashSectionToggle)} box · ${keyOf(InputAction.ClashSelectAll)} all · `
  + `${keyOf(InputAction.ClashGroup)} group · right-click rows · ${keyOf(InputAction.ClashSelectInRevit)} Revit · RMB-drag looks · ${keyOf(InputAction.ClashMode)} / Esc leaves`);

/** A clash's status colour (rows, markers, chips). */
export function clashStatusColour(status: string): number {
  switch (status) {
    case ClashStatus.NEW: return Rgba.hex(0xf87171);
    case ClashStatus.ACTIVE: return Rgba.hex(0xfb923c);
    case ClashStatus.REVIEWED: return Rgba.hex(0xfcd34d);
    case ClashStatus.APPROVED: return Rgba.hex(0x60a5fa);
    default: return Rgba.hex(0x4ade80);
  }
}

/** "crossing 32 mm", "crossing", "touching" or "gap 12 mm" (display units). */
export function clashAmount(clash: ClashRecord): string {
  return clash.crossing
    ? (clash.distance > 0 ? `crossing ${UnitFormat.length(clash.distance, 3)}` : 'crossing')
    : clash.distance <= 0 ? 'touching' : `gap ${UnitFormat.length(clash.distance, 3)}`;
}

/** The level a clash is listed under (A's, else B's, else "—"). */
export function clashLevel(clash: ClashRecord): string {
  return clash.a.level.trim() && clash.a.level !== '—' ? clash.a.level : clash.b.level.trim() && clash.b.level !== '—' ? clash.b.level : '—';
}

export interface ClashRow {
  clash: ClashRecord;
  title: string;
  detail: string;
  status: string;
  search: string;
}

/**
 * One clash's row text: the pair, depth or gap, level, (P-C) the nearest grid intersection, flags, assignee; status; and
 * what search reads (so "C-4" finds the clashes there).
 */
function makeRow(clash: ClashRecord, gridNode: string | null): ClashRow {
  const detail = `${clashAmount(clash)} · ${clashLevel(clash)}${gridNode ? ' · ' + gridNode : ''}${clash.approximate ? ' · approximate (stand-in box)' : ''}`
    + (clash.assignedTo ? ` · ${clash.assignedTo}` : '') + (clash.notes ? ' · notes' : '');
  const title = `${elementRefLabel(clash.a)}  ×  ${elementRefLabel(clash.b)}`;
  return { clash, title, detail, status: ClashStatus.label(clash.status).toUpperCase(), search: `${title} ${detail} ${clash.notes ?? ''} ${clash.status}`.toLocaleLowerCase() };
}

/** Progress for a clash run on the session's progress screen. */
class RunProgress implements ClashProgress {
  private from = 0;
  private to = 1;

  constructor(readonly state: ProgressState) {}

  get cancelRequested(): boolean { return this.state.cancelRequested; }

  begin(stage: string, from: number, to: number): void {
    this.state.stage = stage;
    this.from = from;
    this.to = to;
    this.state.fraction = from;
  }

  step(done: number, total: number): void {
    this.state.fraction = this.from + (this.to - this.from) * (total > 0 ? Math.min(done / total, 1) : 0);
  }

  detail(text: string): void {
    this.state.detail = text;
  }
}

/**
 * Clash detection in the walkthrough (port of GameSession.Clashes, .ClashMode, .ClashDock, .ClashSelection and
 * .ClashPictures, Round C): dormant until switched on (Y or pause menu → CLASHES): until then nothing is parsed, built
 * or run. Switched on, it loads the model's clash document (the file's clashes.json, or the live model folder's),
 * seeding the two starter tests when there is none; runs tests behind the progress screen on the model as walked;
 * merges results across runs; stores them (files: with the next save; live: at once beside the model).
 * Clash mode docks the clash list on the right while you fly: GO flies to a clash, the section box goes round it, the
 * pair draws red / green and the rest by the G view; 1–5 set the status; R shows it in Revit; pictures on each row;
 * TO COMMENT makes comments with pictures; Ctrl / Shift click and Ctrl+A select several.
 */
export class Clashes {
  // #region State

  /** The clash document once switched on; null while dormant. */
  document: ClashDocument | null = null;
  /** Bumped with every change (Save compares it). */
  revision = 0;
  readonly panel: ClashPanel;
  /** C-C1: clash groups (rows, card, menus, actions). */
  readonly groups: ClashGroupUi;
  /** C-C2: the grouping tools. */
  readonly tools: ClashTools;
  /** C-C3: the HTML / XML report. */
  readonly report: ClashReportUi;

  modeOn = false;
  view: number = ClashViewMode.GHOST;
  boxOn = true;
  /** The current clash's section box (Revit internal metres). */
  private section: SectionCut | null = null;
  /** The current clash's framing (camera and region), kept for SHOW IN REVIT. */
  private frame: ClashView | null = null;

  current: ClashRecord | null = null;
  private elementA = -1;
  private elementB = -1;
  private dynamicA: DynamicInstance | null = null;
  private dynamicB: DynamicInstance | null = null;
  private currentRoom: string | null = null;
  private elementByKey: Map<string, number> | null = null;

  private flying = false;
  private flyTime = 0;
  private flyDuration = 0;
  private flyLift = 0;
  private flyFrom = vec3();
  private flyTo = vec3();
  private flyFromYaw = 0;
  private flyToYaw = 0;
  private flyFromPitch = 0;
  private flyToPitch = 0;

  // Dock
  reviewTest: string | null = null;
  readonly list: ClashRecord[] = [];
  private rows: ClashRow[] = [];
  private levels: string[] = [];
  listDirty = true;
  private listUnits = -1;
  private statusFilter = 1; // open
  private levelFilter: string | null = null;
  private search = '';
  searchFocused = false;
  /** The list's scroll region (P-A2: the shared ScrollRegion: wheel, thumb drag, track paging). */
  readonly listScroll = new ScrollRegion();
  /** The dock's left edge this frame (other docks sit left of it in clash mode). */
  dockLeft = 0;
  /** The dock's rectangle this frame (0 width: folded away by the box tool). */
  dockRect: [number, number, number, number] = [0, 0, 0, 0];
  /** RMB went down over the dock: no drag-look until it is released (C-C1: a right-click there is a menu). */
  menuLook = false;
  scrollToCurrent = false;
  /** A REPORT… pick (after the dock is drawn: they open file pickers): 0 none, 1 the card, 2 export JSON, 3 import JSON. */
  private reportAction = 0;
  private testCount = 0;
  private dockCounts = '';
  private dockTestName = '';
  private statusLabel = '';
  private levelLabel = '';
  private cardDetail: string | null = null;
  private cardAssign: string | null = null;
  private cardNotes: string | null = null;
  private viewLabel = '';
  private boxLabel = '';
  private thumbLabel = '';

  // Selection (C-B3, C-B4)
  private readonly selected: ClashRecord[] = [];
  private readonly selectedLookup = new Set<ClashRecord>();
  private anchor: ClashRecord | null = null;
  private multiA: number[] = [];
  private multiB: number[] = [];
  private multiBoth: number[] = [];
  private multiDynamicA: DynamicInstance[] = [];
  private multiDynamicB: DynamicInstance[] = [];
  private multiDynamicBoth: DynamicInstance[] = [];
  private multiSuspended = false;

  // Pictures (C-B2)
  private thumbVersion = 0;
  private readonly thumbs = new Map<ClashRecord, { texture: WebGLTexture | null; version: number }>();
  private readonly thumbWanted: ClashRecord[] = [];
  /** True while a clash picture renders (renderScene draws the clash view in its photo pass). */
  shot = false;
  private thumbTarget: PhotoTarget | null = null;
  private shotTarget: PhotoTarget | null = null;
  private commentPending = 0; // 0 none, 1 make / update, 2 also replace a marked-up picture
  private batch: ClashRecord[] | null = null;
  private batchReplace = false;
  private batchNext = 0;
  private batchCreated = 0;
  private batchUpdated = 0;
  private batchKept = 0;
  private batchFailed = 0;
  private markupClick: ClashRecord | null = null;

  // A run in progress (the progress screen shows)
  running: { title: string; progress: ProgressState } | null = null;

  // #endregion

  constructor(private readonly session: GameSession) {
    this.panel = new ClashPanel(session, this);
    this.groups = new ClashGroupUi(session, this);
    this.tools = new ClashTools(session, this);
    this.report = new ClashReportUi(session, this);
    this.refreshViewLabels();
  }

  private s(v: number): number { return this.session.s(v); }

  /** True while clash detection has been switched on in this session. */
  get active(): boolean { return this.document !== null; }

  /** True while the clash view is drawn: clash mode on and the current clash's pair found. */
  get viewActive(): boolean {
    return this.modeOn && this.current !== null && (this.elementA >= 0 || this.dynamicA !== null || this.elementB >= 0 || this.dynamicB !== null
      || (this.multiActive && this.multiA.length + this.multiB.length + this.multiDynamicA.length + this.multiDynamicB.length + this.multiBoth.length + this.multiDynamicBoth.length > 0));
  }

  /** True when the player's own movement waits (a flight, typing in the search box; C-C2: picking points with Ctrl held). */
  get freezesPlayer(): boolean { return this.modeOn && (this.flying || this.searchFocused || this.tools.freezesPlayer); }

  /** True while a flight to a clash is under way. */
  get isFlying(): boolean { return this.flying; }

  /** Stops a flight where it is (a tool starting, the box tool's orbit). */
  stopFlying(): void { this.flying = false; }

  /** Moves a flight on (the tools' frames). */
  advanceFlightNow(dt: number): void { this.advanceFlight(dt); }

  /** How many clashes the review test has (filters aside). */
  get testClashCount(): number { return this.testCount; }

  /** The list's filters (the report's cover). */
  get filterState(): { status: number; level: string | null; search: string; show: number } {
    return { status: this.statusFilter, level: this.levelFilter, search: this.search.trim(), show: this.groups.filter };
  }

  /** True while TO COMMENTS makes comments. */
  get commentBatchActive(): boolean { return this.batch !== null; }

  // #region Document

  /** Switches clash detection on: reads the clash document (or seeds the starter tests). Nothing when already on. */
  ensure(): ClashDocument {
    if (this.document) { return this.document; }
    const { document, error } = ClashFiles.parse(this.session.document.clashes);
    if (error) { this.session.toast(error, 5, true); }
    this.document = document ?? SearchSets.seeded();
    console.info(`Clash detection on: ${this.document.sets.length} sets, ${this.document.tests.length} tests, ${this.document.clashes.length} clashes${document ? '.' : ' (starter tests seeded).'}`);
    return this.document;
  }

  /** Records a change: files mark it unsaved; live sessions write the model folder now. */
  changed(): void {
    this.revision++;
    const live = this.session.live;
    if (!live || !this.document) { return; }
    if (!live.writeSidecar('clashes', clashDocumentJson(this.document)) && live.clashesUnsupported) {
      this.session.toast('This BimGo add-in keeps no clash results for the browser: update it, or save a .bimgo', 4);
    }
  }

  /** What a save writes as clashes.json: the live document when switched on, else the file's own bytes untouched. */
  bytesForSave(): Uint8Array | null {
    return this.document ? ClashFiles.serialize(this.document) : this.session.document.clashes;
  }

  /** A stamp of the model as walked (snapshot + edits), compared with each test's last run to say "model changed". */
  modelState(): string {
    const scene = this.session.scene, journal = this.session.journal;
    const last = journal.count > 0 ? journal.entries[journal.count - 1].utc : '';
    return `${scene.provenance?.extractedUtc ?? ''}|${scene.elements.length}|${scene.geometry.indices.length / 3}|${journal.count}|${last}`;
  }

  /** The clash with an id (switching clash detection on to read it), or null: BCF exports of clash comments. */
  findClash(id: string): ClashRecord | null {
    const document = this.ensure();
    const lower = id.toLowerCase();
    return document.clashes.find(c => c.id.toLowerCase() === lower) ?? null;
  }

  // #endregion

  // #region Run

  /** One item per element as walked: static elements still standing, then committed moved originals, clones and placements. */
  private buildItems(): ClashItem[] {
    const session = this.session, elements = session.scene.elements;
    const items: ClashItem[] = [];
    for (let i = 0; i < elements.length; i++) {
      if (elements[i].isLibraryTemplate || session.isStaticHidden(i)) { continue; }
      items.push(ClashItems.static(session.scene, i));
    }
    for (const instance of session.dynamics?.instances ?? []) {
      if (instance.hidden || !instance.committed || (elements[instance.element].isLibraryTemplate && !instance.isClone)) { continue; }
      items.push(ClashItems.moved(instance.element, instance.model, instance.worldBounds, instance.isClone ? instance.cloneKey : 0));
    }
    return items;
  }

  /** The items in a set (by their source element's data; placements by their template's own data). */
  private itemsIn(set: SearchSet, items: ClashItem[], cache: Map<string, boolean[]>): number[] {
    const scene = this.session.scene;
    let inSet = cache.get(set.id);
    if (!inSet) {
      inSet = new Array<boolean>(scene.elements.length).fill(false);
      for (const e of SearchSets.elementsIn(set, scene)) { inSet[e] = true; }
      scene.elements.forEach((e, i) => {
        if (e.isLibraryTemplate) { inSet![i] = SearchSets.matches(set, scene, { ...e, isLibraryTemplate: false } as ElementRecord); }
      });
      cache.set(set.id, inSet);
    }
    const result: number[] = [];
    items.forEach((item, i) => { if (inSet![item.element]) { result.push(i); } });
    return result;
  }

  /** Runs tests one after another behind the progress screen (Esc / CANCEL stops; the rest are skipped). */
  async runTests(tests: readonly ClashTest[]): Promise<void> {
    const session = this.session, document = this.ensure();
    if (tests.length === 0) {
      session.sound.play(SoundId.Error);
      session.toast('No test to run (tick a test, or add one)', 3);
      return;
    }
    if (this.running) { return; }
    const items = this.buildItems();
    const cache = new Map<string, boolean[]>();
    const state = this.modelState();
    let totalFound = 0, totalNew = 0, totalResolved = 0, ran = 0, anyTruncated = false;

    for (let t = 0; t < tests.length; t++) {
      const test = tests[t];
      const setA = findSet(document, test.setA);
      const setB = isSelfTest(test) ? null : findSet(document, test.setB);
      if (!setA || (!isSelfTest(test) && !setB)) {
        session.toast(`“${test.name}” skipped: one of its sets no longer exists`, 4, true);
        continue;
      }
      const job: ClashJob = {
        scene: session.scene, items, setA: this.itemsIn(setA, items, cache), setB: setB ? this.itemsIn(setB, items, cache) : null,
        kind: test.kind, tolerance: test.tolerance, maxClashes: ClashDefaults.MAX_CLASHES_PER_TEST
      };
      const progress: ProgressState = { stage: 'Starting', detail: '', fraction: 0, canCancel: true, cancelRequested: false };
      this.running = { title: tests.length > 1 ? `Clash test ${t + 1} of ${tests.length}: ${test.name}` : `Clash test: ${test.name}`, progress };
      let result;
      try {
        result = await ClashEngine.run(job, new RunProgress(progress), () => new Promise(resolve => requestAnimationFrame(() => resolve())));
      } catch (e) {
        console.error(`Clash test “${test.name}” failed`, e);
        session.sound.play(SoundId.Error);
        session.toast(`“${test.name}” could not run: ${e instanceof Error ? e.message : String(e)}`, 5, true);
        break;
      } finally {
        this.running = null;
        session.input.releaseAll();
      }
      if (result.cancelled) {
        session.sound.play(SoundId.UiClick);
        session.toast(`Clash run cancelled: “${test.name}” is unchanged`, 3.5);
        break;
      }
      const records = ClashMerge.toRecords(job, result, test.id);
      const merged = ClashMerge.apply(document, test, records, !result.truncated, new Date().toISOString(), state, result.countA, result.countB,
        result.seconds, session.settings.userName);
      totalFound += merged.found;
      totalNew += merged.new;
      totalResolved += merged.newlyResolved;
      anyTruncated ||= result.truncated;
      ran++;
    }

    if (ran === 0) { return; }
    this.changed();
    this.syncComments();
    this.panel.rowsDirty = true;
    this.listDirty = true;
    session.sound.play(SoundId.Commit);
    const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 'es'}`;
    const summary = `${ran > 1 ? `${ran} tests` : `“${tests[0].name}”`}: ${plural(totalFound, 'clash')} (${totalNew.toLocaleString('en')} new, ${totalResolved.toLocaleString('en')} resolved)`;
    if (anyTruncated) {
      session.toast(`${summary}. Stopped at ${ClashDefaults.MAX_CLASHES_PER_TEST.toLocaleString('en')} in a test: narrow its sets (nothing was marked resolved there).`, 7, true);
    } else {
      session.toast(summary, 4);
    }
  }

  /** EXPORT REPORT…: the whole clash document as readable BimGo JSON (downloaded). */
  exportReport(): void {
    const session = this.session, document = this.ensure();
    const scene = session.scene;
    const d = new Date(), two = (n: number) => String(n).padStart(2, '0');
    const name = `${safeFileName(scene.modelTitle)} clashes ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}.json`;
    const json = ClashFiles.exportReport(document, scene.modelTitle, scene.provenance?.modelKey ?? null, `BimGo Web ${__BIMGO_VERSION__}`);
    downloadBlob(new Blob([json], { type: 'application/json' }), name);
    session.sound.play(SoundId.Commit);
    session.toast(`Clash report saved: ${name} (your Downloads folder)`, 3.5);
  }

  /** IMPORT REPORT…: merges a BimGo clash report (newer status changes win, missing tests / clashes are added). */
  async importReport(): Promise<void> {
    const session = this.session, document = this.ensure();
    session.input.releaseAll();
    const file = await pickFile('.json,application/json');
    if (!file) { return; }
    const { document: report, error } = ClashFiles.parse(new Uint8Array(await file.arrayBuffer()));
    if (!report) {
      session.sound.play(SoundId.Error);
      session.toast(error ?? `${file.name} has no clash data`, 5, true);
      return;
    }
    const r = ClashFiles.merge(report, document, session.scene.provenance?.modelKey ?? null);
    this.changed();
    this.syncComments();
    this.panel.rowsDirty = true;
    this.listDirty = true;
    session.sound.play(SoundId.Commit);
    const other = r.sameModel ? '' : ' The report names a different model: check the pairs.';
    session.toast(`Report merged: ${r.clashesAdded} clashes added, ${r.clashesUpdated} updated, ${r.unchanged} unchanged; ${r.testsAdded} tests and ${r.setsAdded} sets added`
      + (r.groupsAdded > 0 ? `; ${r.groupsAdded} group${r.groupsAdded === 1 ? '' : 's'} added` : '') + `.${other}`, 6, !r.sameModel);
  }

  // #endregion

  // #region Clash mode: enter / leave

  /** Y: clash mode on, or off when it is on. */
  toggle(): void {
    if (this.modeOn) { this.exit(); } else { this.enter(null); }
  }

  /**
   * Turns clash mode on (switching clash detection on the first time), on a test (null: the review test, else the
   * first with clashes), and goes to a clash (null: the first the list shows).
   */
  enter(clash: ClashRecord | null, testId: string | null = null): void {
    const session = this.session, document = this.ensure();
    this.panel.pickerRule = null;
    session.menu.closeOverlay();
    this.panel.close();
    session.closeModes(null);
    session.pathEditor.exit(); // Round K-B: one free-cursor mode at a time
    if (session.paused) { session.setPaused(false); }
    session.showUi();

    let wanted = testId ?? clash?.testId ?? this.reviewTest ?? this.panel.selectedTest;
    if (!findTest(document, wanted) || (!clash && !document.clashes.some(c => c.testId === wanted))) {
      wanted = document.tests.find(t => document.clashes.some(c => c.testId === t.id))?.id ?? document.tests[0]?.id ?? null;
    }
    this.setReviewTest(wanted);
    this.refreshViewLabels();

    this.modeOn = true;
    if (!session.player.flying) { session.player.toggleFly(); }
    session.releaseMouseForTyping();
    this.refreshList();

    const first = clash ?? (this.current && this.list.includes(this.current) ? this.current : this.list[0] ?? null);
    if (first) { this.goTo(first, !session.settings.clashInstantFly); }
    session.sound.play(SoundId.UiClick);
    session.toast(this.list.length === 0
      ? `Clash mode: no clashes to show yet (TESTS… runs them) · ${keyOf(InputAction.ClashMode)} or Esc leaves`
      : `Clash mode: ${keyOf(InputAction.ClashPrevious)} / ${keyOf(InputAction.ClashNext)} previous / next · 1–5 status · RMB-drag looks · ${keyOf(InputAction.ClashMode)} or Esc leaves`, 4);
  }

  /** Leaves clash mode: the clash view goes, flying stays. QOL round: the clash section box goes too (BOX stays on). */
  exit(): void {
    if (!this.modeOn) { return; }
    const session = this.session;
    if (this.batch) { this.finishBatch(true); }
    session.grids.close(); // grids round A
    this.report.cancel(); // C-C3
    this.report.cardOpen = false;
    this.tools.leave(); // C-C2: a box tool puts the cut back first
    this.tools.hover = null;
    this.menuLook = false;
    this.modeOn = false;
    this.flying = false;
    this.searchFocused = false;
    session.menu.closeOverlay();
    session.input.releaseAll();
    let boxCleared = false;
    if (this.boxOn && session.section.isActive) {
      session.section.apply(new SectionCut(), false);
      boxCleared = true;
    }
    session.toast(boxCleared
      ? `Clash mode off · still flying (${keyOf(InputAction.Fly)} walks) · section box off · click to look around`
      : `Clash mode off · still flying (${keyOf(InputAction.Fly)} walks) · click to look around`, 3);
  }

  // #endregion

  // #region Clash mode: frame

  /** Clash mode's keys and mouse (the dock handles its own clicks when it is drawn). */
  updateMode(input: InputState, dt: number): void {
    const session = this.session;
    if (this.searchFocused) {
      this.typeIntoSearch(input);
      this.advanceFlight(dt);
      return;
    }
    // Grids round A: the grids keys stay live in clash mode (Esc closes an open grids panel first)
    if (input.pressed(InputAction.GridsPanel)) { session.grids.toggle(); }
    if (input.pressed(InputAction.GridsCycle)) { session.grids.cycle(); }
    if (input.pressed(InputAction.ColourProfile)) { session.profiles.toggle(); } // colour round A: shows in the real model view
    if (session.grids.panelOpen && this.tools.tool === CLASH_TOOL_NONE && !session.menu.overlays.isOpen && input.pressed(InputAction.Back)) {
      session.grids.close();
      return;
    }

    // C-C2: a grouping tool (box, pick points, cluster) has the keys and the mouse
    if (this.tools.tool !== CLASH_TOOL_NONE) {
      this.tools.update(input, dt);
      return;
    }

    // Esc closes an open dropdown first, then stops making comments (C-B2) or the report (C-C3), closes its card
    if (input.pressed(InputAction.Back) && this.report.job) {
      this.report.cancel();
      return;
    }
    if (input.pressed(InputAction.Back) && this.report.cardOpen && !session.menu.overlays.isOpen) {
      this.report.cardOpen = false;
      return;
    }
    if (input.pressed(InputAction.Back) && session.menu.closeOverlay()) { return; }
    if (input.pressed(InputAction.Back) && this.batch) {
      this.finishBatch(true);
      return;
    }
    if (input.pressed(InputAction.Back) || input.pressed(InputAction.ClashMode)) {
      this.exit();
      return;
    }
    if (input.pressed(InputAction.Help)) { session.showHelp = !session.showHelp; }
    if (input.pressed(InputAction.HideUi)) { session.toggleUiHidden(); }
    if (input.pressed(InputAction.Fullscreen)) { session.toggleFullscreen(); }
    if (input.pressed(InputAction.Screenshot)) { session.requestScreenshot(); }
    // C-C1: RMB pressed over the dock opens a row menu, so it doesn't look until it is released
    if (input.rightPressed && this.overDockAt(input.mouseX, input.mouseY)) { this.menuLook = true; }
    if (!input.rightDown) { this.menuLook = false; }
    if (input.down(InputAction.DragLook) && !this.flying && !this.menuLook) { session.player.look(input.mouseDeltaX, input.mouseDeltaY, session.settings.mouseSensitivity, session.settings.invertY); }
    if (!this.flying) { session.padEditorLook(input); }
    session.updateRoom();
    // C-C3: the dots take clicks as list rows do: a click goes to that clash, Ctrl adds / removes, Shift a run
    const overDock = this.overDockAt(input.mouseX, input.mouseY), overlayOpen = session.menu.overlays.isOpen;
    this.tools.updateHover(input.mouseX, input.mouseY, overDock || overlayOpen || input.down(InputAction.DragLook) || this.flying);
    if (input.leftPressed && this.tools.hover && !overDock && !overlayOpen) {
      const hit = this.tools.hover;
      input.consumeClicks();
      session.sound.play(SoundId.UiClick);
      this.clickRow(hit, input.isDown(Vk.CONTROL), input.isDown(Vk.SHIFT));
    } else if (!overDock && !this.tools.hover) { session.grids.clickNode(input); } // grids round B: a node flies there

    if (input.pressedOrRepeated(InputAction.ClashNext)) { this.step(1); }
    else if (input.pressedOrRepeated(InputAction.ClashPrevious)) { this.step(-1); }
    else if (input.pressed(InputAction.ClashFrame) && this.current) {
      if (this.multiActive) { this.goToSelected(!session.settings.clashInstantFly); } else { this.goTo(this.current, !session.settings.clashInstantFly); }
    } else if (input.pressed(InputAction.ClashSelectInRevit)) { this.showInRevit(false); }
    else if (input.pressed(InputAction.ClashView)) { this.setView((this.view + 1) % CLASH_VIEW_NAMES.length); }
    else if (input.pressed(InputAction.ClashSectionToggle)) { this.toggleBox(); }
    else if (input.pressed(InputAction.ClashSelectAll)) { this.toggleSelectAllShown(); }
    else if (input.pressed(InputAction.ClashPictures)) { this.toggleThumbnails(); } // sky round: P / the pad's Back
    else if (input.pressed(InputAction.ClashUngroup)) { this.groups.ungroupFromKeys(); } // C-C1: Ctrl+Shift+G
    else if (input.pressed(InputAction.ClashGroup)) { this.groups.groupClashes(this.targetClashes(), null); } // C-C1: Ctrl+G
    else if (input.pressed(InputAction.ClashPickPoints)) { this.tools.startPickFromKey(); } // P-B: K (TOOLS ▾ → PICK POINTS)
    else if (input.pressed(InputAction.ClashStatusCycle)) { this.cycleStatus(); } // P-B: the gamepad's LB+A
    else {
      for (let k = 0; k < ClashStatus.ALL.length; k++) {
        if (input.pressed(InputAction.ClashStatusNew + k)) {
          this.setCurrentStatus(ClashStatus.ALL[k]);
          break;
        }
      }
    }
    this.advanceFlight(dt);
  }

  /** Moves the camera along the flight: eased, rising in the middle for longer hops. */
  private advanceFlight(dt: number): void {
    if (!this.flying) { return; }
    const player = this.session.player;
    this.flyTime += dt;
    const t = Math.min(Math.max(this.flyTime / Math.max(this.flyDuration, 0.01), 0), 1);
    const e = t * t * (3 - 2 * t);
    const lift = this.flyLift * Math.sin(Math.PI * e);
    const eye = vec3(this.flyFrom.x + (this.flyTo.x - this.flyFrom.x) * e, this.flyFrom.y + (this.flyTo.y - this.flyFrom.y) * e,
      this.flyFrom.z + (this.flyTo.z - this.flyFrom.z) * e + lift);
    const yaw = this.flyFromYaw + ClashFraming.angleBetween(this.flyToYaw, this.flyFromYaw) * e;
    const pitch = this.flyFromPitch + (this.flyToPitch - this.flyFromPitch) * e;
    player.teleportTo(vec3(eye.x, eye.y, eye.z - player.controller.standEye), yaw, pitch);
    if (t >= 1) { this.flying = false; }
  }

  // #endregion

  // #region GO

  /** Goes to a clash: finds its pair as walked, sets the section box round it and flies (or jumps) to ~2.5 m back. */
  goTo(clash: ClashRecord, animate: boolean): void {
    const session = this.session;
    this.clearSelection();
    this.groups.current = null; // C-C1: a clash row shows the clash card
    this.current = clash;
    [this.elementA, this.dynamicA] = this.resolve(clash.a);
    [this.elementB, this.dynamicB] = this.resolve(clash.b);
    const { view, point, cut } = this.frameClash(clash, session.player.yaw);
    this.section = cut;
    this.frame = view;
    // The section box (kept after leaving until Ctrl+P or the next GO); switched off (B) it stays off from clash to clash
    if (this.boxOn) { session.section.apply(cut, false); }
    this.invalidateThumbnail(clash);
    this.currentRoom = this.roomName(point);
    this.scrollToCurrent = true;
    this.refreshCard();
    this.flyToView(view, animate);
  }

  private roomName(point: Vec3): string | null {
    const session = this.session;
    const room = session.findRoomAt(point.x, point.y, point.z);
    if (room < 0) { return null; }
    const r = session.scene.rooms[room];
    return !r.number.trim() || r.number === '—' ? r.name : `${r.number} · ${r.name}`;
  }

  /** Grids round B: flies (or jumps) to look from an eye point (a grid node clicked in clash mode). */
  flyToPoint(eye: Vec3, yaw: number, pitch: number): void {
    this.flyToView({ section: Aabb.empty(), eye, yaw, pitch }, !this.session.settings.clashInstantFly);
  }

  /** Flies (or jumps) the camera to a clash view. */
  private flyToView(view: ClashView, animate: boolean): void {
    const player = this.session.player;
    const stand = player.controller.standEye;
    const from = vec3(player.feet.x, player.feet.y, player.feet.z + stand);
    const distance = Math.hypot(from.x - view.eye.x, from.y - view.eye.y, from.z - view.eye.z);
    if (!animate || distance < 0.05) {
      this.flying = false;
      player.teleportTo(vec3(view.eye.x, view.eye.y, view.eye.z - stand), view.yaw, view.pitch);
      return;
    }
    this.flying = true;
    this.flyTime = 0;
    this.flyDuration = Math.min(Math.max(0.6 + distance * 0.02, 0.8), 2);
    this.flyLift = Math.min(distance * 0.15, 6);
    this.flyFrom = from;
    this.flyTo = view.eye;
    this.flyFromYaw = player.yaw;
    this.flyToYaw = view.yaw;
    this.flyFromPitch = player.pitch;
    this.flyToPitch = view.pitch;
  }

  /** A clash's framing from the pair as currently resolved: the camera ~2.5 m back and the section box round the region. */
  private frameClash(clash: ClashRecord, currentYaw: number): { view: ClashView; point: Vec3; cut: SectionCut } {
    const origin = this.session.scene.originOffset;
    const point = vec3(clash.x - origin.x, clash.y - origin.y, clash.z - origin.z);
    const boxA = this.boundsOf(this.elementA, this.dynamicA, point), boxB = this.boundsOf(this.elementB, this.dynamicB, point);
    const region = ClashFraming.sectionFor(boxA, boxB, point);
    return { view: ClashFraming.frame(point, boxA, boxB, region, currentYaw), point, cut: this.cutOf(region) };
  }

  /** A section box cut (internal metres) for a scene-local region. */
  private cutOf(region: Aabb): SectionCut {
    const origin = this.session.scene.originOffset;
    const cut = new SectionCut();
    cut.boxOn = true;
    cut.boxMin = vec3(region.min.x + origin.x, region.min.y + origin.y, region.min.z + origin.z);
    cut.boxMax = vec3(region.max.x + origin.x, region.max.y + origin.y, region.max.z + origin.z);
    return cut;
  }

  /** The next / previous clash in the list (wrapping round, with a word when it does). */
  private step(direction: number): void {
    const session = this.session;
    this.refreshList();
    if (this.list.length === 0) {
      session.sound.play(SoundId.Error);
      session.toast('No clashes in the list (check the filters, or run the test)', 2.5);
      return;
    }
    const index = this.current ? this.list.indexOf(this.current) : -1;
    let next = index < 0 ? (direction > 0 ? 0 : this.list.length - 1) : index + direction;
    if (next >= this.list.length) { next = 0; session.toast('Back to the first clash', 1.6); }
    else if (next < 0) { next = this.list.length - 1; session.toast('The last clash', 1.6); }
    this.goTo(this.list[next], !session.settings.clashInstantFly);
  }

  /**
   * Finds a clash element as walked: a clone / placement by its clone key; a model element by link + UniqueId, or
   * its moved instance; nothing when it was demolished / deleted or isn't in this snapshot.
   */
  private resolve(reference: ClashElementRef): [number, DynamicInstance | null] {
    const session = this.session, scene = session.scene;
    if (reference.cloneKey > 0) {
      return [-1, session.dynamics?.instances.find(d => d.isClone && d.cloneKey === reference.cloneKey && !d.hidden) ?? null];
    }
    if (!this.elementByKey) {
      this.elementByKey = new Map();
      scene.elements.forEach((e, i) => {
        if (e.isLibraryTemplate) { return; }
        const key = ClashMerge.elementKey(scene, i);
        if (!this.elementByKey!.has(key)) { this.elementByKey!.set(key, i); }
      });
    }
    const found = this.elementByKey.get(elementRefKey(reference));
    if (found === undefined) { return [-1, null]; }
    if (!session.isStaticHidden(found)) { return [found, null]; }
    const moved = session.dynamics?.findOriginal(found) ?? null;
    return [-1, moved && !moved.hidden ? moved : null];
  }

  /** An element's current box (a small box round the point when it isn't found). */
  private boundsOf(element: number, instance: DynamicInstance | null, point: Vec3): Aabb {
    if (instance) { return instance.worldBounds; }
    if (element >= 0) { return this.session.scene.elements[element].bounds; }
    return new Aabb(vec3(point.x - 0.1, point.y - 0.1, point.z - 0.1), vec3(point.x + 0.1, point.y + 0.1, point.z + 0.1));
  }

  // #endregion

  // #region View, box, status, Revit

  /** G: the next view. */
  cycleView(): void { this.setView((this.view + 1) % CLASH_VIEW_NAMES.length); }

  /** G / the VIEW dropdown: how the rest of the model draws round the pair. */
  setView(view: number): void {
    const session = this.session;
    this.view = Math.min(Math.max(view, 0), CLASH_VIEW_NAMES.length - 1);
    this.thumbVersion++;
    this.refreshViewLabels();
    session.sound.play(SoundId.UiClick);
    const what = this.view === ClashViewMode.WIREFRAME ? 'Clash view: the rest of the model as wireframe'
      : this.view === ClashViewMode.REAL ? 'Clash view: the real model (the pair tinted)'
        : this.view === ClashViewMode.HIDDEN ? 'Clash view: only the pair' : 'Clash view: the rest of the model ghosted';
    session.toast(`${what} (${keyOf(InputAction.ClashView)} cycles)`, 2);
  }

  /** B / BOX: switches the section box off, or back on round the current clash. */
  toggleBox(): void {
    const session = this.session;
    if (this.boxOn) {
      this.boxOn = false;
      if (session.section.isActive) { session.section.apply(new SectionCut(), false); }
      session.sound.play(SoundId.Remove);
      session.toast(`Section box off, from clash to clash too (${keyOf(InputAction.ClashSectionToggle)} puts it back round the clash)`, 2.5);
    } else {
      if (!this.current || !this.section) {
        session.sound.play(SoundId.Error);
        session.toast('Pick a clash first: the box goes round it', 2);
        return;
      }
      this.boxOn = true;
      session.section.apply(this.section, false);
      session.sound.play(SoundId.UiClick);
      session.toast('Section box on: round each clash you go to', 2);
    }
    this.thumbVersion++;
    this.refreshViewLabels();
  }

  private refreshViewLabels(): void {
    this.viewLabel = `VIEW: ${CLASH_VIEW_NAMES[this.view]} (${keyOf(InputAction.ClashView)})`;
    this.boxLabel = `BOX: ${this.boxOn ? 'ON' : 'OFF'} (${keyOf(InputAction.ClashSectionToggle)})`;
    this.thumbLabel = this.session.settings.clashRowPictures ? 'PICTURES: ON' : 'PICTURES: OFF';
  }

  /** P-B: the next status for the picked group or the current clash (new → … → resolved → new). */
  private cycleStatus(): void {
    const status = this.groups.current?.status ?? this.current?.status;
    if (!status) {
      this.session.sound.play(SoundId.Error);
      return;
    }
    this.setCurrentStatus(ClashStatus.ALL[(ClashStatus.indexOf(status) + 1) % ClashStatus.ALL.length]);
  }

  /** 1–5: the status of every selected clash (or the current one; C-C1: the picked group and its members); comments follow. */
  setCurrentStatus(status: string): void {
    const session = this.session;
    if (this.groups.current) {
      this.groups.setGroupStatus(this.groups.current, status);
      return;
    }
    if (!this.current) {
      session.sound.play(SoundId.Error);
      return;
    }
    let changed = 0;
    const now = new Date().toISOString();
    for (const clash of this.targets()) {
      if (clash.status === status) { continue; }
      ClashMerge.setStatus(clash, status, session.settings.userName, now);
      this.syncComment(clash);
      changed++;
    }
    if (changed === 0) { return; }
    this.changed();
    this.listDirty = true;
    this.panel.rowsDirty = true;
    session.sound.play(SoundId.UiClick);
    const word = ClashStatus.label(status).toLowerCase();
    session.toast(changed === 1 ? `Clash ${word}` : `${changed} clashes ${word}`, 1.6);
  }

  /**
   * R / REVIT: shows the clash (or the selection) in Revit (live): the pair selected in a "BimGo clash" 3D view with
   * the clash's section box, turned to look the way BimGo does. Above CLASH_REVIT_WARN selected, asks first.
   */
  showInRevit(confirmed: boolean): void {
    const session = this.session, live = session.live;
    if (!this.current) { return; }
    if (!confirmed && this.multiActive && this.selected.length > CLASH_REVIT_WARN && live?.connected) {
      const elements = this.multiA.length + this.multiB.length + this.multiBoth.length + this.multiDynamicA.length + this.multiDynamicB.length + this.multiDynamicBoth.length;
      session.menu.overlays.openConfirm('SHOW IN REVIT', `${this.selected.length.toLocaleString('en')} clashes (${elements.toLocaleString('en')} elements): Revit can take a while to select that many.`,
        'SHOW THEM', false, false, () => this.showInRevit(true));
      return;
    }
    if (!live) {
      session.toast('Showing a clash in Revit needs a live Revit session (press Go in Revit)');
      return;
    }
    if (!live.connected) {
      session.toast('Not connected to Revit', 2.6, true);
      return;
    }

    const hostIds: number[] = [];
    const linked: { linkInstanceId: number; elementId: number }[] = [];
    const add = (element: number, instance: DynamicInstance | null) => {
      if (instance) {
        if (instance.revitId > 0) { hostIds.push(instance.revitId); }
        return;
      }
      if (element < 0) { return; }
      const record = session.scene.elements[element];
      const link = linkOf(session.scene, record);
      if (!link) { hostIds.push(record.elementId); }
      else if (link.instanceId > 0) { linked.push({ linkInstanceId: link.instanceId, elementId: record.elementId }); }
    };
    if (this.multiActive) {
      for (const e of [...this.multiA, ...this.multiB, ...this.multiBoth]) { add(e, null); }
      for (const d of [...this.multiDynamicA, ...this.multiDynamicB, ...this.multiDynamicBoth]) { add(-1, d); }
    } else {
      add(this.elementA, this.dynamicA);
      add(this.elementB, this.dynamicB);
    }
    if (hostIds.length === 0 && linked.length === 0) {
      session.toast('Neither element is in Revit (clones not created yet, or demolished)', 3);
      return;
    }

    const origin = session.scene.originOffset;
    const box = this.section, frame = this.frame;
    const eye = frame ? vec3(frame.eye.x + origin.x, frame.eye.y + origin.y, frame.eye.z + origin.z) : vec3();
    const cp = Math.cos(frame?.pitch ?? 0);
    const request: ClashViewRequest = {
      name: CLASH_VIEW_NAME, sectionBox: this.boxOn,
      minX: box?.boxMin.x ?? 0, minY: box?.boxMin.y ?? 0, minZ: box?.boxMin.z ?? 0,
      maxX: box?.boxMax.x ?? 0, maxY: box?.boxMax.y ?? 0, maxZ: box?.boxMax.z ?? 0,
      eyeX: eye.x, eyeY: eye.y, eyeZ: eye.z,
      directionX: frame ? cp * Math.cos(frame.yaw) : 0, directionY: frame ? cp * Math.sin(frame.yaw) : 0, directionZ: frame ? Math.sin(frame.pitch) : 0
    };
    if (!live.showClash(hostIds, linked, request)) {
      session.toast("Revit didn't take the request", 2.6, true);
      return;
    }
    session.sound.play(SoundId.UiClick);
    session.toast(`Showing the clash in Revit (“${CLASH_VIEW_NAME}” 3D view)…`, 3);
  }

  // #endregion

  // #region Drawing

  /**
   * The clash view in place of the scene passes, by view (G): ghost (the pair opaque in red / green, the ground, then
   * everything as faint grey glass behind it, no sun shadows); wireframe (the pair, then the triangles' edges in the
   * ghost colour); real model (the normal scene, the pair tinted over it); hidden (only the pair and the ground).
   */
  drawView(p: SceneDrawParams, groupVisible: boolean[], drawRealScene: () => void): void {
    const session = this.session, renderer = session.renderer;
    if (this.view === ClashViewMode.REAL) {
      drawRealScene();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -2);
      this.drawPair(p);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.BLEND);
      return;
    }

    renderer.skipScreenEffects(); // no AO or glow round the pair
    const q: SceneDrawParams = { ...p, sun: false };
    this.drawPair(q);
    renderer.drawGround(session.camera, session.groundZ);
    if (this.view === ClashViewMode.HIDDEN) { return; }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    if (this.view === ClashViewMode.WIREFRAME) {
      // Everything else as lines (the triangles' edges) in the ghost colour; moved elements ghosted
      renderer.ghostAlpha = CLASH_WIRE;
      renderer.drawStaticLines(q, groupVisible, false);
      renderer.drawStaticLines(q, groupVisible, true);
      renderer.ghostAlpha = CLASH_GHOST;
      renderer.drawDynamic(q, session.dynamics, false);
    } else {
      // Everything else, ghosted (the pair's own ghost lies behind its opaque copy and fails the depth test)
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 2);
      renderer.ghostAlpha = CLASH_GHOST;
      renderer.drawStatic(q, groupVisible, false);
      renderer.drawDynamic(q, session.dynamics, false);
      renderer.drawStatic(q, groupVisible, true);
      renderer.drawDynamic(q, session.dynamics, true);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    renderer.ghostAlpha = 0;
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /** The pair (or every selected pair), opaque, in red (A) and green (B); amber for elements on both sides. */
  private drawPair(q: SceneDrawParams): void {
    const renderer = this.session.renderer;
    const element = (e: number, t: number[]) => renderer.drawElementHighlight(q, e, t[0], t[1], t[2], t[3]);
    const dynamic = (d: DynamicInstance, t: number[]) => renderer.drawDynamicHighlight(q, d, t[0], t[1], t[2], t[3]);
    if (this.multiActive) {
      for (const e of this.multiA) { element(e, A_TINT); }
      for (const d of this.multiDynamicA) { dynamic(d, A_TINT); }
      for (const e of this.multiB) { element(e, B_TINT); }
      for (const d of this.multiDynamicB) { dynamic(d, B_TINT); }
      for (const e of this.multiBoth) { element(e, BOTH_TINT); }
      for (const d of this.multiDynamicBoth) { dynamic(d, BOTH_TINT); }
      return;
    }
    if (this.elementA >= 0) { element(this.elementA, A_TINT); }
    if (this.dynamicA) { dynamic(this.dynamicA, A_TINT); }
    if (this.elementB >= 0) { element(this.elementB, B_TINT); }
    if (this.dynamicB) { dynamic(this.dynamicB, B_TINT); }
  }

  /** The list's clashes as dots (status colours; the current one larger, ringed), overlay only. */
  drawMarkers(overlay: Overlay3D): void {
    if (!this.modeOn || this.tools.tool !== CLASH_TOOL_NONE) { return; } // C-C2: a tool draws its own dots
    const origin = this.session.scene.originOffset;
    const count = Math.min(this.list.length, 4000);
    for (let i = 0; i < count; i++) {
      const clash = this.list[i];
      if (clash === this.current) { continue; }
      const point = vec3(clash.x - origin.x, clash.y - origin.y, clash.z - origin.z);
      if (clash === this.tools.hover) { overlay.dot(point, this.s(9), Rgba.hex(0xffffff)); } // C-C3: the dot under the mouse
      if (this.selected.length > 1 && this.selectedLookup.has(clash)) { overlay.dot(point, this.s(7.5), Rgba.hex(0xffffff)); }
      overlay.dot(point, this.s(4.5), clashStatusColour(clash.status));
    }
    if (this.current) {
      const point = vec3(this.current.x - origin.x, this.current.y - origin.y, this.current.z - origin.z);
      overlay.dot(point, this.s(9), Rgba.hex(0xffffff));
      overlay.dot(point, this.s(6.5), clashStatusColour(this.current.status));
    }
  }

  // #endregion

  // #region Dock: list

  /** Shows a test in clash mode (filters kept, list rebuilt). */
  setReviewTest(testId: string | null): void {
    if (testId === this.reviewTest) { return; }
    this.tools.leave(); // C-C2: a tool works on one test's list
    this.clearSelection();
    this.reviewTest = testId;
    this.levelFilter = null;
    this.listScroll.reset();
    this.listDirty = true;
  }

  /** Rebuilds the filtered list and its rows when the data, the filters or the display units changed. */
  refreshList(): void {
    const document = this.document;
    if (!document) { return; }
    if (this.listUnits !== UnitFormat.revision) { this.listDirty = true; }
    if (!this.listDirty) { return; }
    this.listDirty = false;
    this.listUnits = UnitFormat.revision;
    const groups = this.groups;
    groups.ensureIndex(); // C-C1: rows know their group (search matches group names too)

    const words = this.search.trim() ? this.search.trim().toLocaleLowerCase().split(/\s+/) : [];
    this.rows = [];
    const levels = new Set<string>();
    this.levels = [];
    this.testCount = 0;
    for (const clash of document.clashes) {
      if (clash.testId !== this.reviewTest) { continue; }
      this.testCount++;
      const level = clashLevel(clash);
      if (!levels.has(level)) { levels.add(level); this.levels.push(level); }
      if (!this.matchesStatusFilter(clash.status)) { continue; }
      if (this.levelFilter !== null && level !== this.levelFilter) { continue; }
      const row = makeRow(clash, this.session.grids.clashLocation(clash)?.node ?? null);
      const groupName = words.length === 0 ? '' : groups.searchText(clash).toLocaleLowerCase();
      if (!words.every(w => row.search.includes(w) || groupName.includes(w))) { continue; }
      this.rows.push(row);
    }
    // Open first (new, active, reviewed, approved, resolved), deepest first
    this.rows.sort((p, q) => ClashStatus.indexOf(p.clash.status) - ClashStatus.indexOf(q.clash.status) || q.clash.distance - p.clash.distance);
    groups.buildDisplay(this.rows, this.list); // C-C1: group rows among the clashes; the list in display order (every member)
    this.tools.dotsDirty = true; // C-C2: the tools' dots and the cluster follow the list
    this.tools.sphereDirty = true;
    this.pruneSelection();

    // Levels in elevation order, unknown ones last
    const order = (name: string) => {
      const i = this.session.scene.levels.findIndex(l => l.name === name);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    this.levels.sort((a, b) => order(a) - order(b));

    const test = findTest(document, this.reviewTest);
    this.dockTestName = test ? test.name : 'No test';
    const groupCount = groups.groupsInTest;
    this.dockCounts = `${this.list.length.toLocaleString('en')} shown · ${this.testCount.toLocaleString('en')} in the test`
      + (groupCount > 0 ? ` · ${groupCount.toLocaleString('en')} group${groupCount === 1 ? '' : 's'}` : '');
    this.statusLabel = 'STATUS: ' + CLASH_STATUS_FILTERS[this.statusFilter];
    this.levelLabel = 'LEVEL: ' + (this.levelFilter ?? 'ALL');
    this.refreshViewLabels();
    if (this.current) { this.scrollToCurrent = true; }
    this.refreshCard();
  }

  refreshCard(): void {
    this.groups.refreshCard(); // C-C1
    const clash = this.current;
    if (!clash) {
      this.cardDetail = this.cardAssign = this.cardNotes = null;
      return;
    }
    const grids = this.session.grids;
    this.cardDetail = makeRow(clash, grids.clashLocation(clash)?.node ?? null).detail + (this.currentRoom ? ' · ' + this.currentRoom : '') + grids.clashSuffix(clash, true); // grids round B
    this.cardAssign = clash.assignedTo ? 'ASSIGNED: ' + clash.assignedTo : 'ASSIGN…';
    this.cardNotes = clash.notes ? 'NOTES (EDIT)…' : 'NOTES…';
  }

  private matchesStatusFilter(status: string): boolean {
    switch (this.statusFilter) {
      case 0: return true;
      case 1: return status !== ClashStatus.RESOLVED && status !== ClashStatus.APPROVED;
      default: return status === ClashStatus.ALL[this.statusFilter - 2];
    }
  }

  /** Typing into the search box: Backspace deletes (Ctrl+Backspace clears), Enter or Esc stop typing. */
  private typeIntoSearch(input: InputState): void {
    if (input.isPressed(Vk.RETURN) || input.isPressed(Vk.ESCAPE)) {
      this.searchFocused = false;
      input.releaseAll();
      return;
    }
    let changed = false;
    if (input.isPressedOrRepeated(Vk.BACK)) {
      this.search = input.isDown(Vk.CONTROL) ? '' : this.search.slice(0, -1);
      changed = true;
    }
    for (const c of input.typed) {
      if (c >= ' ' && c !== '\u007f' && this.search.length < SEARCH_MAX) {
        this.search += c;
        changed = true;
      }
    }
    if (changed) {
      this.listDirty = true;
      this.listScroll.reset();
    }
  }

  // #endregion

  // #region Dock: panel

  /** Clash mode's HUD: the dock on the right (the session draws the status panels, help, banners and toasts). */
  buildDock(f: FontAtlas): void {
    const session = this.session, ui = session.ui, input = session.input, overlays = session.menu.overlays, wd = session.menu.widgets;
    const width = session.screenWidth, height = session.screenHeight;
    this.refreshList();
    overlays.begin(input);
    const w = Math.min(this.s(420), width * 0.42);

    // C-C2: GROUP BY BOX… folds the dock away (its bar only); PICK POINTS and CLUSTER keep it beside their bar
    if (this.tools.tool === CLASH_TOOL_BOX) {
      this.dockRect = [0, 0, 0, 0];
      this.dockLeft = width;
      this.tools.buildBar(f, input, height, width);
      overlays.draw(f, input, 0, 0, width, height);
      this.tools.runBarAction();
      return;
    }
    if (this.tools.tool !== CLASH_TOOL_NONE) { this.tools.buildBar(f, input, height, width - w - this.s(16)); }
    const x = width - w - this.s(16), y = this.s(16), h = height - this.s(32);
    this.dockLeft = x;
    this.dockRect = [x, y, w, h];
    ui.panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.PANEL_BORDER);
    const overDock = this.overDockAt(input.mouseX, input.mouseY);
    if (overDock && input.rightPressed) { this.menuLook = true; } // C-C1: a right-click on the dock is a menu, not a look

    // P-A2: the docks' header (title, the counts on the right, a divider)
    const ix = x + this.s(14), iw = w - this.s(28);
    const header = this.s(UiTheme.DOCK_HEADER_HEIGHT);
    const titleY = y + Math.round((header - f.small.lineHeight) * 0.5);
    ui.text(f.small, ix, titleY, 'CLASH MODE', UiTheme.ACCENT, this.s(1.6));
    ui.textRight(f.small, ix + iw, titleY, this.dockCounts, UiTheme.TEXT_MUTED);
    ui.rect(x + this.s(1), y + header, w - this.s(2), Math.max(1, ui.scale), UiTheme.DIVIDER);
    let cy = y + header + this.s(UiTheme.GAP_SMALL);

    const document = this.document!;
    if (overlays.button(f, input, ix, cy, iw, this.s(30), this.dockTestName, overlays.isDropdownOpen(this.list, DROP_DOCK_TEST))) {
      const ids = document.tests.map(t => t.id);
      const labels = document.tests.map(t => {
        const count = ClashMerge.countByStatus(document, t.id).reduce((a, b) => a + b, 0);
        return count === 0 ? `${t.name} (no clashes)` : `${t.name} (${count.toLocaleString('en')})`;
      });
      overlays.openDropdown(this.list, DROP_DOCK_TEST, ix, cy, iw, this.s(30), labels, ids.indexOf(this.reviewTest ?? ''), i => this.pickReviewTest(ids[i]));
    }
    cy += this.s(38);

    // Filters: status, level, show (C-C2: SHOW joins them; search moved down beside SELECT ALL)
    const third = (iw - this.s(12)) / 3;
    if (overlays.button(f, input, ix, cy, third, this.s(30), this.statusLabel, overlays.isDropdownOpen(this.list, DROP_DOCK_STATUS))) {
      overlays.openDropdown(this.list, DROP_DOCK_STATUS, ix, cy, third, this.s(30), CLASH_STATUS_FILTERS, this.statusFilter, i => {
        this.statusFilter = i;
        this.listDirty = true;
        this.listScroll.reset();
      });
    }
    const lx = ix + third + this.s(6);
    if (overlays.button(f, input, lx, cy, third, this.s(30), this.levelLabel, overlays.isDropdownOpen(this.list, DROP_DOCK_LEVEL))) {
      const values = ['ALL', ...this.levels];
      overlays.openDropdown(this.list, DROP_DOCK_LEVEL, lx, cy, third, this.s(30), values, this.levelFilter === null ? 0 : values.indexOf(this.levelFilter), i => {
        this.levelFilter = i === 0 ? null : values[i];
        this.listDirty = true;
        this.listScroll.reset();
      });
    }
    const showX = ix + (third + this.s(6)) * 2;
    if (overlays.button(f, input, showX, cy, third, this.s(30), CLASH_SHOW_LABELS[this.groups.filter], overlays.isDropdownOpen(this.list, DROP_DOCK_SHOW))) {
      overlays.openDropdown(this.list, DROP_DOCK_SHOW, showX, cy, third, this.s(30), CLASH_SHOW_CHOICES, this.groups.filter, i => this.groups.setFilter(i));
    }
    cy += this.s(38);

    // The view, the section box and the row pictures
    const viewW = (iw - this.s(12)) * 0.42, toggleW = (iw - this.s(12) - viewW) * 0.5;
    if (overlays.button(f, input, ix, cy, viewW, this.s(30), this.viewLabel, overlays.isDropdownOpen(this.list, DROP_DOCK_VIEW))) {
      overlays.openDropdown(this.list, DROP_DOCK_VIEW, ix, cy, viewW, this.s(30), CLASH_VIEW_NAMES, this.view, v => this.setView(v));
    }
    if (wd.smallButton(f, ix + viewW + this.s(6), cy, toggleW, this.s(30), this.boxLabel)) { this.toggleBox(); }
    if (wd.smallButton(f, ix + viewW + toggleW + this.s(12), cy, toggleW, this.s(30), this.thumbLabel)) { this.toggleThumbnails(); }
    cy += this.s(38);

    // Search · select every clash the list shows / clear · the clash report (C-C2: one row)
    const reportW = Math.min(this.s(100), iw * 0.24), selectW = Math.min(this.s(140), iw * 0.32);
    const searchW = iw - reportW - selectW - this.s(12);
    const searchHover = wd.hover(ix, cy, searchW, this.s(28));
    ui.panel(ix, cy, searchW, this.s(28), UiTheme.CONTROL, this.searchFocused ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
    if (!this.search && !this.searchFocused) { ui.text(f.small, ix + this.s(8), cy + this.s(7), 'search…', UiTheme.TEXT_FAINT); }
    else {
      const used = ui.text(f.small, ix + this.s(8), cy + this.s(7), this.search, UiTheme.TEXT);
      if (this.searchFocused && (Math.trunc(session.clock * 2) & 1) === 0) { ui.rect(ix + this.s(9) + used, cy + this.s(6), this.s(1.5), this.s(16), UiTheme.TEXT_SOFT); }
    }
    if (input.leftPressed && overDock) {
      if (searchHover !== this.searchFocused) {
        this.searchFocused = searchHover;
        if (searchHover) { input.releaseAll(); }
      }
    } else if (input.leftPressed && this.searchFocused) { this.searchFocused = false; }
    const selectX = ix + searchW + this.s(6);
    if (wd.smallButton(f, selectX, cy, selectW, this.s(28), this.selectAllLabel())) { this.toggleSelectAllShown(); }
    const reportX = selectX + selectW + this.s(6);
    if (overlays.button(f, input, reportX, cy, reportW, this.s(28), 'REPORT…', overlays.isDropdownOpen(this.list, DROP_DOCK_REPORT))) {
      const menuW = Math.max(reportW, this.s(260));
      overlays.openDropdown(this.list, DROP_DOCK_REPORT, reportX + reportW - menuW, cy, menuW, this.s(28), CLASH_REPORT_ACTIONS, -1, i => { this.reportAction = i + 1; });
    }
    cy += this.s(36);

    // C-C1 / C-C2: GROUP and UNGROUP act on the selection or the group on the card; TOOLS ▾ holds the grouping tools
    const toolsW = Math.min(this.s(150), iw * 0.36), groupW = (iw - toolsW - this.s(12)) * 0.5;
    if (wd.smallButton(f, ix, cy, groupW, this.s(28), 'GROUP')) { this.groups.groupClashes(this.targetClashes(), null); }
    if (wd.smallButton(f, ix + groupW + this.s(6), cy, groupW, this.s(28), 'UNGROUP')) { this.groups.ungroupFromKeys(); }
    const toolsX = ix + groupW * 2 + this.s(12);
    if (overlays.button(f, input, toolsX, cy, toolsW, this.s(28), 'TOOLS', overlays.isDropdownOpen(this.list, DROP_DOCK_AUTO))) {
      const menuW = Math.min(this.s(300), iw);
      overlays.openDropdown(this.list, DROP_DOCK_AUTO, ix + iw - menuW, cy, menuW, this.s(28), CLASH_TOOL_ACTIONS, -1, i => this.groups.runToolAction(i));
    }
    cy += this.s(36);

    // The current clash's card (bottom, tall enough for its key hint) and the list above it
    const cardH = this.s(CARD_BUTTONS_Y) + this.s(34) + ui.textWrapped(f.small, 0, 0, iw, CLASH_HINT.text, UiTheme.TEXT_FAINT, 3, false) + this.s(10);
    const cardY = y + h - cardH;
    const go = this.buildRows(f, input, ix, cy, iw, cardY - this.s(10));
    this.buildCard(f, input, ix, cardY, iw);

    // C-C3: the label of the dot under the mouse (in the view), then the open dropdown on top (a pick acts here)
    if (this.tools.tool === CLASH_TOOL_NONE) { this.tools.drawHoverLabel(f, input, width); }
    overlays.draw(f, input, x, y, w, h);
    if (this.tools.runBarAction()) { return; } // C-C2: the tool bar's buttons

    // Actions after drawing
    if (this.report.exportRequested !== 0) {
      const confirmed = this.report.exportRequested === 2;
      this.report.exportRequested = 0;
      this.report.start(confirmed);
    }
    if (this.reportAction !== 0) {
      const action = this.reportAction;
      this.reportAction = 0;
      switch (action) {
        case 1: this.report.openCard(); break; // C-C3
        case 2: this.exportReport(); return;
        case 3: void this.importReport(); return;
      }
    }
    if (this.markupClick && this.modeOn) {
      const markup = this.markupClick;
      this.markupClick = null;
      this.openMarkup(markup);
      return;
    }
    if (go && this.modeOn) {
      // C-C2: while picking points a row click toggles its pick; with the cluster sphere it moves the centre
      if (this.tools.tool === CLASH_TOOL_PICK) { this.tools.togglePick(go); }
      else if (this.tools.tool === CLASH_TOOL_SPHERE) { this.tools.moveSphere(go); }
      else { this.clickRow(go, input.isDown(Vk.CONTROL), input.isDown(Vk.SHIFT)); }
    }
    const groups = this.groups;
    if (groups.markupClick && this.modeOn) {
      const markupGroup = groups.markupClick;
      groups.markupClick = null;
      groups.openMarkup(markupGroup);
      return;
    }

    // C-C1: a chevron, a group row, a right-click (the menu opens now, drawn from the next frame)
    const chevron = groups.chevron, groupClick = groups.groupClick, menuRow = groups.menuRow;
    groups.chevron = groups.groupClick = null;
    groups.menuRow = null;
    if (this.modeOn) {
      if (chevron) { groups.toggleExpanded(chevron); }
      else if (groupClick && this.tools.tool === CLASH_TOOL_PICK) { this.tools.togglePicks(groups.shownMembers(groupClick)); } // C-C2
      else if (groupClick && this.tools.tool === CLASH_TOOL_NONE) { groups.clickGroupRow(groupClick, input.isDown(Vk.CONTROL)); }
      if (menuRow) { groups.openRowMenu(menuRow, groups.menuAt); }
    }
    if (overDock && (input.leftPressed || input.rightPressed)) { input.consumeClicks(); }
  }

  /** True while the mouse is over the dock (a click there doesn't look around). */
  overDock(input: InputState): boolean { return this.overDockAt(input.mouseX, input.mouseY); }

  /** True when a point is over last frame's dock (or the grids panel beside it). */
  overDockAt(mx: number, my: number): boolean {
    const [x, y, w, h] = this.dockRect;
    return (w > 0 && mx >= x && mx < x + w && my >= y && my < y + h) || this.session.grids.overPanel(mx, my);
  }

  private pickReviewTest(testId: string): void {
    if (testId === this.reviewTest) { return; }
    const session = this.session;
    this.setReviewTest(testId);
    this.refreshList();
    if (this.list.length > 0) { this.goTo(this.list[0], !session.settings.clashInstantFly); }
    else {
      session.toast(this.document!.clashes.some(c => c.testId === testId) ? 'No clash of this test matches the filters' : 'This test has no clashes yet (TESTS… runs it)', 2.5);
    }
  }

  /**
   * The list rows (P-A2: a clipped, pixel-scrolled ScrollRegion; a step to another clash brings its row into view,
   * centred). C-C1: group rows with their members indented when expanded; a right-click on any row opens its menu.
   * Returns the clash row clicked this frame.
   */
  private buildRows(f: FontAtlas, input: InputState, x: number, y: number, w: number, bottom: number): ClashRecord | null {
    const session = this.session, ui = session.ui, shell = session.shell, wd = session.menu.widgets, groups = this.groups;
    const display = groups.display;
    if (display.length === 0) {
      ui.textWrapped(f.body, x, y + this.s(6), w, this.testCount === 0 ? 'This test has no clashes yet: TESTS… runs it.' : 'No clash matches the filters.', UiTheme.TEXT_MUTED, 3);
      return null;
    }
    // C-B2: with pictures on, each row is tall enough for a 160 × 90 picture (narrower docks shrink it)
    const pictures = session.settings.clashRowPictures;
    const region = this.listScroll;
    const viewH = Math.max(this.s(40), bottom - y - this.s(16)); // the "1–20 of 140" line sits under it
    const listW = w - this.s(UiTheme.SCROLL_GUTTER) + this.s(8); // the bar sits in the dock's padding
    const thumbW = pictures ? Math.min(this.s(THUMB_W), listW * 0.42) : 0;
    const thumbH = thumbW * THUMB_H / THUMB_W;
    const rowH = pictures ? Math.max(this.s(50), thumbH + this.s(10)) : this.s(50);
    const count = display.length;
    if (this.scrollToCurrent) {
      this.scrollToCurrent = false;
      const current = this.displayIndexOf(this.current);
      if (current >= 0) { region.reveal(current * rowH - (viewH - rowH) * 0.5, current * rowH + rowH + (viewH - rowH) * 0.5); }
    }
    const top = shell.beginScroll(region, input, x, y, w + this.s(8), viewH);
    const [first, last] = region.visibleRows(rowH, count);
    let picked: ClashRecord | null = null;
    for (let i = first; i < last; i++) {
      const line = display[i];
      const ry = top + i * rowH;
      const hover = wd.hover(x, ry, listW, rowH - this.s(4));
      if (!line.row) {
        groups.buildGroupRow(f, input, line, x, ry, listW, rowH, pictures, thumbW, thumbH, hover);
      } else {
        // Members sit indented under their group (a faint rule down the left)
        const indent = line.member ? this.s(14) : 0;
        if (line.member) { ui.rect(x + this.s(5), ry, this.s(2), rowH, Rgba.hex(0xffffff, 0.12)); }
        this.buildRowBody(f, input, line.row, x + indent, ry, listW - indent, rowH, pictures, thumbW, thumbH, hover, (i & 1) === 0);
        if (hover && input.leftPressed) {
          input.consumeClicks();
          session.sound.play(SoundId.UiClick);
          picked = line.row.clash;
        }
      }
      if (hover && input.rightPressed) {
        groups.menuRow = line;
        groups.menuAt = [input.mouseX, input.mouseY];
      }
    }
    shell.endScroll(region, input, top + count * rowH);
    if (count * rowH > viewH) {
      const from = Math.min(Math.max(Math.trunc(region.offset / rowH) + 1, 1), count);
      const to = Math.min(Math.max(Math.trunc((region.offset + viewH) / rowH), from), count);
      ui.textRight(f.small, x + w, y + viewH + this.s(2), `${from}–${to} of ${count.toLocaleString('en')}`, UiTheme.TEXT_FAINT);
    }
    return picked;
  }

  /** The display row showing a clash: its own row, or its group's row when the group is collapsed (−1: none). */
  private displayIndexOf(clash: ClashRecord | null): number {
    if (!clash) { return -1; }
    const display = this.groups.display, group = this.groups.groupOf(clash);
    let groupRow = -1;
    for (let i = 0; i < display.length; i++) {
      const line = display[i];
      if (line.row && line.row.clash === clash) { return i; }
      if (!line.row && group && line.group === group) { groupRow = i; }
    }
    return groupRow;
  }

  /** One clash row: status bar, picture or text layout, status, the comment pencil. */
  private buildRowBody(f: FontAtlas, input: InputState, row: ClashRow, x: number, ry: number, w: number, rowH: number, pictures: boolean,
    thumbW: number, thumbH: number, hover: boolean, even: boolean): void {
    const ui = this.session.ui;
    const current = row.clash === this.current || this.isSelected(row.clash);
    const fill = current ? Rgba.hex(0x22d3ee, 0.14) : hover ? Rgba.hex(0xffffff, 0.08) : even ? Rgba.hex(0xffffff, 0.03) : 0;
    if (fill) { ui.rect(x, ry, w, rowH - this.s(4), fill); }
    ui.rect(x, ry, this.s(4), rowH - this.s(4), clashStatusColour(row.clash.status));
    const titleColour = row.clash.status === ClashStatus.RESOLVED ? UiTheme.TEXT_FAINT : UiTheme.TEXT;
    if (pictures) {
      const px = x + this.s(10), py = ry + this.s(3);
      this.drawRowPicture(f, row.clash, px, py, thumbW, thumbH);
      if (this.commentPencil(input, px + thumbW - this.s(14), py + this.s(14), this.findComment(row.clash))) { this.markupClick = row.clash; }
      const tx = px + thumbW + this.s(10), tw = x + w - this.s(8) - tx;
      ui.text(f.small, tx, ry + this.s(5), row.status, clashStatusColour(row.clash.status));
      ui.textWrapped(f.body, tx, ry + this.s(22), tw, row.title, titleColour, 2);
      ui.textWrapped(f.small, tx, ry + this.s(62), tw, row.detail, UiTheme.TEXT_MUTED, 2);
    } else {
      ui.textWrapped(f.body, x + this.s(12), ry + this.s(5), w - this.s(110), row.title, titleColour, 1);
      ui.textWrapped(f.small, x + this.s(12), ry + this.s(26), w - this.s(24), row.detail, UiTheme.TEXT_MUTED, 1);
      ui.textRight(f.small, x + w - this.s(8), ry + this.s(7), row.status, clashStatusColour(row.clash.status));
      if (this.commentPencil(input, x + w - this.s(20), ry + this.s(32), this.findComment(row.clash))) { this.markupClick = row.clash; }
    }
  }

  /** A row picture (asked for when missing or stale) or its placeholder. */
  drawRowPicture(f: FontAtlas, clash: ClashRecord | null, px: number, py: number, thumbW: number, thumbH: number): void {
    const session = this.session, ui = session.ui;
    const texture = clash ? this.thumbnailTexture(clash) : null;
    if (texture) {
      ui.image(texture, px, py, thumbW, thumbH, session.screenWidth, session.screenHeight);
      ui.outline(px, py, thumbW, thumbH, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.15));
    } else {
      ui.panel(px, py, thumbW, thumbH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
      ui.textCentred(f.small, px + thumbW * 0.5, py + thumbH * 0.5 - this.s(7), '…', UiTheme.TEXT_FAINT);
    }
  }

  /** The current clash: position, the pair, depth or gap, status 1–5, assignee, notes, comments and the bottom buttons. */
  private buildCard(f: FontAtlas, input: InputState, x: number, y: number, w: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, groups = this.groups;
    ui.rect(x, y - this.s(6), w, Math.max(1, ui.scale), UiTheme.PANEL_BORDER);
    let cy = y + this.s(4);
    const clash = this.current;
    if (this.batch) {
      this.buildBatchProgress(f, x, cy, w);
    } else if (this.report.job) {
      this.report.buildProgress(f, x, cy, w); // C-C3: the report's pictures
    } else if (this.report.cardOpen) {
      this.report.buildCard(f, input, x, cy, w); // C-C3: REPORT… → EXPORT REPORT (HTML / XML)…
    } else if (groups.current) {
      groups.buildCard(f, input, x, cy, w); // C-C1: a group row was clicked
    } else if (!clash) {
      ui.text(f.body, x, cy, 'Pick a clash in the list.', UiTheme.TEXT_MUTED);
    } else {
      const index = this.list.indexOf(clash);
      const head = (this.multiActive ? `${this.selected.length} SELECTED · ` : '')
        + (index >= 0 ? `CLASH ${index + 1} OF ${this.list.length.toLocaleString('en')}` : 'CLASH (FILTERED OUT)');
      ui.text(f.small, x, cy, head, UiTheme.TEXT_MUTED, this.s(1.2));
      cy += this.s(20);
      ui.rect(x, cy + this.s(4), this.s(10), this.s(10), Rgba.hex(0xef4444));
      ui.textWrapped(f.body, x + this.s(18), cy, w - this.s(18), elementRefLabel(clash.a), UiTheme.TEXT, 1);
      cy += this.s(20);
      ui.rect(x, cy + this.s(4), this.s(10), this.s(10), Rgba.hex(0x22c55e));
      ui.textWrapped(f.body, x + this.s(18), cy, w - this.s(18), elementRefLabel(clash.b), UiTheme.TEXT, 1);
      cy += this.s(22);
      ui.textWrapped(f.small, x, cy, w, this.cardDetail ?? '', UiTheme.TEXT_MUTED, 2);
      cy += this.s(34);

      // Status 1–5
      const chip = (w - this.s(4) * 4) / 5;
      for (let k = 0; k < ClashStatus.ALL.length; k++) {
        const status = ClashStatus.ALL[k];
        const bx = x + k * (chip + this.s(4));
        const on = clash.status === status;
        const hover = wd.hover(bx, cy, chip, this.s(28));
        ui.rect(bx, cy, chip, this.s(28), on ? clashStatusColour(status) : hover ? Rgba.hex(0xffffff, 0.1) : UiTheme.CONTROL);
        ui.outline(bx, cy, chip, this.s(28), Math.max(1, ui.scale), on ? clashStatusColour(status) : UiTheme.CONTROL_BORDER);
        ui.textCentred(f.small, bx + chip * 0.5, cy + this.s(7), CLASH_STATUS_SHORT[k], on ? Rgba.hex(0x111827) : UiTheme.TEXT);
        if (hover && input.leftPressed && !on) {
          input.consumeClicks();
          this.setCurrentStatus(status);
        }
      }
      cy += this.s(34);
      const half = (w - this.s(6)) * 0.5;
      if (wd.smallButton(f, x, cy, half, this.s(28), this.cardAssign ?? 'ASSIGN…')) { this.beginAssign(clash); }
      if (wd.smallButton(f, x + half + this.s(6), cy, half, this.s(28), this.cardNotes ?? 'NOTES…')) { this.beginNotes(clash); }
    }

    // Comments: the selection (or this clash) → comments; MARKUP this clash's comment picture (C-C1: the group's comment)
    if (!this.batch && !this.report.job && !this.report.cardOpen) {
      const halfW = (w - this.s(6)) * 0.5, ty = y + this.s(CARD_BUTTONS_Y) - this.s(34);
      const group = groups.current;
      if (group) {
        if (wd.smallButton(f, x, ty, halfW, this.s(28), groups.findComment(group) ? 'UPDATE GROUP COMMENT' : 'GROUP TO COMMENT')) { groups.toComment(group); }
        if (wd.smallButton(f, x + halfW + this.s(6), ty, halfW, this.s(28), 'MARKUP')) { groups.openMarkup(group); }
      } else {
        const make = this.multiActive ? `${this.selected.length} TO COMMENTS` : clash && this.findComment(clash) ? 'UPDATE COMMENT' : 'TO COMMENT';
        if (wd.smallButton(f, x, ty, halfW, this.s(28), make)) { this.toComment(); }
        if (wd.smallButton(f, x + halfW + this.s(6), ty, halfW, this.s(28), 'MARKUP') && clash) { this.openMarkup(clash); }
      }
    }

    const quarter = (w - this.s(18)) / 4;
    const by = y + this.s(CARD_BUTTONS_Y);
    if (wd.smallButton(f, x, by, quarter, this.s(28), 'REVIT')) { this.showInRevit(false); }
    if (wd.smallButton(f, x + (quarter + this.s(6)), by, quarter, this.s(28), 'TESTS…')) {
      if (this.batch) { this.finishBatch(true); } // runs and resets wait for the comments
      this.report.cancel(); // C-C3: and for the report's pictures
      this.panel.show();
      return;
    }
    if (wd.smallButton(f, x + (quarter + this.s(6)) * 2, by, quarter, this.s(28), session.settings.clashInstantFly ? 'INSTANT' : 'FLY')) {
      session.settings.clashInstantFly = !session.settings.clashInstantFly;
      session.settings.save();
      session.toast(session.settings.clashInstantFly ? 'Clash mode jumps straight to each clash' : 'Clash mode flies to each clash', 2);
    }
    if (wd.smallButton(f, x + (quarter + this.s(6)) * 3, by, quarter, this.s(28), 'EXIT')) {
      this.exit();
      return;
    }
    ui.textWrapped(f.small, x, by + this.s(34), w, CLASH_HINT.text, UiTheme.TEXT_FAINT, 3);
  }

  private beginAssign(clash: ClashRecord): void {
    const session = this.session;
    session.editor.beginCustom('ASSIGN CLASH TO (empty = unassigned)', clash.assignedTo, 60, text => {
      ClashMerge.setDetails(clash, text, null, session.settings.userName, new Date().toISOString());
      this.changed();
      const comment = this.findComment(clash);
      if (comment) { session.comments.setIssue(comment, { assignedTo: text }); }
      this.listDirty = true;
      this.panel.rowsDirty = true;
      session.toast(text ? `Assigned to ${text}` : 'Unassigned', 2);
    }, clash.a.level);
  }

  private beginNotes(clash: ClashRecord): void {
    const session = this.session;
    session.editor.beginCustom('CLASH NOTES (empty clears)', clash.notes, 280, text => {
      ClashMerge.setDetails(clash, null, text, session.settings.userName, new Date().toISOString());
      this.changed();
      this.listDirty = true;
      this.panel.rowsDirty = true;
      session.toast(text ? 'Notes saved' : 'Notes cleared', 2);
    }, clash.a.level);
  }

  // #endregion

  // #region Selection (C-B3, C-B4)

  /** True while two or more clashes are shown together. */
  get multiActive(): boolean { return !this.multiSuspended && this.selected.length > 1; }

  private isSelected(clash: ClashRecord): boolean { return this.selected.length > 1 && this.selectedLookup.has(clash); }

  private syncLookup(): void {
    this.selectedLookup.clear();
    for (const clash of this.selected) { this.selectedLookup.add(clash); }
  }

  private get allShownSelected(): boolean { return this.list.length > 1 && this.selected.length === this.list.length; }

  /** The clashes 1–5, R and TO COMMENT act on: the selection, or the current clash. */
  private targets(): ClashRecord[] {
    if (this.multiActive) { return this.selected; }
    return this.current ? [this.current] : [];
  }

  /** The clashes GROUP, the box tool and the report act on (a copy). */
  targetClashes(): ClashRecord[] { return [...this.targets()]; }

  /** The selected clashes (C-B3). */
  get selection(): readonly ClashRecord[] { return this.selected; }

  get selectedCount(): number { return this.selected.length; }

  /** True when a clash is in the selection. */
  isSelectedClash(clash: ClashRecord): boolean { return this.selectedLookup.has(clash); }

  /** C-C1: several clashes shown together (a group row's members), with one on the card. */
  selectMany(members: readonly ClashRecord[], current: ClashRecord, animate: boolean): void {
    this.clearSelection();
    this.selected.push(...members);
    this.syncLookup();
    this.current = current;
    this.anchor = current;
    this.goToSelected(animate);
  }

  /**
   * C-C1 Ctrl+click on a group row: the members in or out of the selection (starting from the clash on screen); the view
   * follows. True when they were all selected (so they left).
   */
  toggleMany(members: readonly ClashRecord[]): boolean {
    const animate = !this.session.settings.clashInstantFly;
    if (this.selected.length === 0 && this.current && this.list.includes(this.current)) { this.selected.push(this.current); }
    this.syncLookup();
    const all = members.every(c => this.selectedLookup.has(c));
    if (all) {
      const leaving = new Set(members);
      for (let i = this.selected.length - 1; i >= 0; i--) { if (leaving.has(this.selected[i])) { this.selected.splice(i, 1); } }
    } else {
      for (const clash of members) { if (!this.selectedLookup.has(clash)) { this.selectedLookup.add(clash); this.selected.push(clash); } }
    }
    this.syncLookup();
    if (this.selected.length === 0) { return all; }
    if (this.selected.length === 1) {
      this.goTo(this.selected[0], animate);
    } else {
      if (!this.current || !this.selectedLookup.has(this.current)) { this.current = this.selected[this.selected.length - 1]; }
      this.goToSelected(animate);
    }
    return all;
  }

  /** C-C2: no selection, the current clash kept (the tools). */
  clearSelectionKeepCurrent(): void {
    const keep = this.current;
    this.clearSelection();
    this.current = keep;
  }

  /** C-C2: clashes added to the picks (the marquee); returns how many were new. */
  addToSelection(list: readonly ClashRecord[]): number {
    this.syncLookup();
    let added = 0;
    for (const clash of list) {
      if (this.selectedLookup.has(clash)) { continue; }
      this.selectedLookup.add(clash);
      this.selected.push(clash);
      added++;
    }
    if (added > 0) { this.current = this.selected[this.selected.length - 1]; }
    return added;
  }

  /** C-C2: a clash in or out of the picks (the camera stays). */
  togglePickOne(clash: ClashRecord): void {
    this.syncLookup();
    const index = this.selected.indexOf(clash);
    if (index >= 0) {
      this.selected.splice(index, 1);
      this.selectedLookup.delete(clash);
      if (this.current === clash) { this.current = this.selected[this.selected.length - 1] ?? null; }
    } else {
      this.selected.push(clash);
      this.selectedLookup.add(clash);
      this.current = clash;
    }
  }

  /** C-C2: a group's shown members in (or out, when all are picked). */
  togglePickMany(list: readonly ClashRecord[]): void {
    this.syncLookup();
    if (list.every(c => this.selectedLookup.has(c))) {
      const leaving = new Set(list);
      for (let i = this.selected.length - 1; i >= 0; i--) { if (leaving.has(this.selected[i])) { this.selected.splice(i, 1); } }
      if (this.current && leaving.has(this.current)) { this.current = this.selected[this.selected.length - 1] ?? null; }
    } else {
      for (const clash of list) { if (!this.selectedLookup.has(clash)) { this.selectedLookup.add(clash); this.selected.push(clash); } }
      this.current = list[list.length - 1];
    }
    this.syncLookup();
  }

  /** C-C2: after the picks changed: the pairs found again and drawn; the card follows; the camera and the box stay. */
  resolvePicks(): void {
    this.syncLookup();
    this.multiA = []; this.multiB = []; this.multiBoth = [];
    this.multiDynamicA = []; this.multiDynamicB = []; this.multiDynamicBoth = [];
    if (this.current) {
      [this.elementA, this.dynamicA] = this.resolve(this.current.a);
      [this.elementB, this.dynamicB] = this.resolve(this.current.b);
    }
    if (this.selected.length > 1) { this.resolveSelected(); }
    this.refreshCard();
  }

  /** A row click: plain = that clash alone; Ctrl = add / remove it; Shift = the run from the last clicked. */
  private clickRow(clash: ClashRecord, ctrl: boolean, shift: boolean): void {
    const session = this.session;
    this.groups.current = null; // C-C1: the group card goes with the selection
    this.groups.picks.length = 0;
    if (!ctrl && !shift) {
      this.anchor = clash;
      this.goTo(clash, !session.settings.clashInstantFly);
      return;
    }
    if (this.selected.length === 0 && this.current && this.list.includes(this.current)) { this.selected.push(this.current); }
    this.syncLookup();

    if (shift) {
      const anchor = this.anchor && this.list.includes(this.anchor) ? this.anchor : this.current;
      let from = anchor ? this.list.indexOf(anchor) : -1;
      const to = this.list.indexOf(clash);
      if (from < 0) { from = to; }
      if (!ctrl) {
        this.selected.length = 0;
        this.selectedLookup.clear();
      }
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        if (!this.selectedLookup.has(this.list[i])) {
          this.selectedLookup.add(this.list[i]);
          this.selected.push(this.list[i]);
        }
      }
      this.current = clash;
    } else {
      this.anchor = clash;
      const index = this.selected.indexOf(clash);
      if (index >= 0) {
        this.selected.splice(index, 1);
        this.selectedLookup.delete(clash);
        if (this.current === clash) { this.current = this.selected[this.selected.length - 1] ?? null; }
      } else {
        this.selected.push(clash);
        this.selectedLookup.add(clash);
        this.current = clash;
      }
    }

    session.sound.play(SoundId.UiClick);
    if (this.selected.length === 0) { return; }
    if (this.selected.length === 1) {
      this.goTo(this.selected[0], !session.settings.clashInstantFly);
      return;
    }
    this.goToSelected(!session.settings.clashInstantFly);
    session.toast(`${this.selected.length} clashes together · Ctrl+click adds / removes · Shift+click a run · a plain click goes back to one`, 2.5);
  }

  /** Back to a single clash (the current one stays on screen). */
  private clearSelection(): void {
    this.groups.current = null; // C-C1
    this.selected.length = 0;
    this.selectedLookup.clear();
    this.multiA = [];
    this.multiB = [];
    this.multiBoth = [];
    this.multiDynamicA = [];
    this.multiDynamicB = [];
    this.multiDynamicBoth = [];
  }

  /** After the list changed: drops selected clashes it no longer shows (one left: back to a single clash). */
  private pruneSelection(): void {
    if (this.selected.length === 0) { return; }
    const before = this.selected.length;
    const shown = new Set(this.list);
    for (let i = this.selected.length - 1; i >= 0; i--) { if (!shown.has(this.selected[i])) { this.selected.splice(i, 1); } }
    this.syncLookup();
    if (this.selected.length < 2) {
      this.clearSelection();
      return;
    }
    if (this.selected.length !== before || this.multiA.length + this.multiDynamicA.length + this.multiB.length + this.multiDynamicB.length === 0) {
      this.resolveSelected();
    }
    if (!this.current || !this.selectedLookup.has(this.current)) { this.current = this.selected[this.selected.length - 1]; }
  }

  /** SELECT ALL SHOWN (Ctrl+A): every clash the list shows, focused together; again clears back to the current clash. */
  toggleSelectAllShown(): void {
    const session = this.session;
    if (this.allShownSelected) {
      const keep = this.current;
      this.clearSelection();
      session.sound.play(SoundId.UiClick);
      if (keep) { this.goTo(keep, !session.settings.clashInstantFly); }
      return;
    }
    if (this.list.length < 2) {
      session.sound.play(SoundId.Error);
      session.toast(this.list.length === 0 ? 'No clash in the list to select' : 'Only one clash in the list', 2);
      return;
    }
    this.selected.length = 0;
    this.selected.push(...this.list);
    this.syncLookup();
    if (!this.current || !this.selectedLookup.has(this.current)) { this.current = this.list[0]; }
    this.anchor = this.current;
    session.sound.play(SoundId.UiClick);
    this.goToSelected(!session.settings.clashInstantFly);
    const box = this.selected.length > CLASH_FOCUS_BOX_CAP && this.boxOn
      ? ` · box off above ${CLASH_FOCUS_BOX_CAP} (${keyOf(InputAction.ClashSectionToggle)} boxes them all)` : '';
    session.toast(`All ${this.selected.length.toLocaleString('en')} clashes shown together${box} · ${keyOf(InputAction.ClashSelectAll)} again clears`, 3);
  }

  /** C-C2: narrower (it shares a row with search and REPORT…; the key hint names the key). */
  private selectAllLabel(): string {
    const selected = this.multiActive ? this.selected.length : 0;
    return this.allShownSelected ? `CLEAR ALL ${selected.toLocaleString('en')}` : selected > 1 ? `SELECT ALL ${this.list.length.toLocaleString('en')}` : 'SELECT ALL';
  }

  /** Shows the selected clashes together: every pair, the box over all their regions, the camera far enough back. */
  private goToSelected(animate: boolean): void {
    const session = this.session;
    if (this.selected.length < 2) { return; }
    if (!this.current || !this.selectedLookup.has(this.current)) { this.current = this.selected[this.selected.length - 1]; }
    [this.elementA, this.dynamicA] = this.resolve(this.current.a);
    [this.elementB, this.dynamicB] = this.resolve(this.current.b);
    const { region, boxesA, boxesB } = this.resolveSelected();
    const distance = ClashFraming.distanceToSee(region, session.settings.fieldOfView, session.camera.aspect);
    const view = ClashFraming.frame(region.center, boxesA, boxesB, region, session.player.yaw, null, distance);
    this.frame = view;
    this.section = this.cutOf(region);
    if (this.boxOn) {
      // A box round hundreds of clashes is most of the building: off above the cap (B puts it on)
      if (this.selected.length <= CLASH_FOCUS_BOX_CAP) { session.section.apply(this.section, false); }
      else if (session.section.isActive) { session.section.apply(new SectionCut(), false); }
    }
    const origin = session.scene.originOffset;
    this.currentRoom = this.roomName(vec3(this.current.x - origin.x, this.current.y - origin.y, this.current.z - origin.z));
    this.scrollToCurrent = true;
    this.refreshCard();
    this.flyToView(view, animate);
  }

  /** Every selected pair as walked (into the multi lists) and the boxes they make together. */
  private resolveSelected(): { region: Aabb; boxesA: Aabb; boxesB: Aabb } {
    const origin = this.session.scene.originOffset;
    const seenA = new Set<number>(), seenB = new Set<number>();
    const seenDA = new Set<DynamicInstance>(), seenDB = new Set<DynamicInstance>();
    this.multiA = [];
    this.multiB = [];
    this.multiDynamicA = [];
    this.multiDynamicB = [];
    const region = Aabb.empty(), boxesA = Aabb.empty(), boxesB = Aabb.empty();
    for (const clash of this.selected) {
      const [a, da] = this.resolve(clash.a);
      const [b, db] = this.resolve(clash.b);
      if (a >= 0 && !seenA.has(a)) { seenA.add(a); this.multiA.push(a); }
      if (da && !seenDA.has(da)) { seenDA.add(da); this.multiDynamicA.push(da); }
      if (b >= 0 && !seenB.has(b)) { seenB.add(b); this.multiB.push(b); }
      if (db && !seenDB.has(db)) { seenDB.add(db); this.multiDynamicB.push(db); }
      const point = vec3(clash.x - origin.x, clash.y - origin.y, clash.z - origin.z);
      const boxA = this.boundsOf(a, da, point), boxB = this.boundsOf(b, db, point);
      region.include(ClashFraming.sectionFor(boxA, boxB, point));
      boxesA.include(boxA);
      boxesB.include(boxB);
    }
    // An element in both lists is drawn once, amber
    this.multiBoth = this.multiA.filter(e => seenB.has(e));
    this.multiDynamicBoth = this.multiDynamicA.filter(d => seenDB.has(d));
    if (this.multiBoth.length > 0) {
      this.multiA = this.multiA.filter(e => !seenB.has(e));
      this.multiB = this.multiB.filter(e => !seenA.has(e));
    }
    if (this.multiDynamicBoth.length > 0) {
      this.multiDynamicA = this.multiDynamicA.filter(d => !seenDB.has(d));
      this.multiDynamicB = this.multiDynamicB.filter(d => !seenDA.has(d));
    }
    return { region, boxesA, boxesB };
  }

  // #endregion

  // #region Pictures (C-B2)

  /**
   * Clash pictures due this frame, before the scene renders (camera, section and targets are put back after each): a
   * pending TO COMMENT, the next TO COMMENTS pictures, or the row pictures the list wanted last frame.
   */
  renderPictures(): void {
    const session = this.session;
    if (!this.modeOn) {
      this.thumbWanted.length = 0;
      this.commentPending = 0;
      this.groups.commentPending = null;
      return;
    }
    if (this.commentPending !== 0) {
      const replace = this.commentPending === 2;
      this.commentPending = 0;
      this.thumbWanted.length = 0;
      this.makeCurrentComment(replace);
      return;
    }
    if (this.groups.commentPending) {
      this.thumbWanted.length = 0;
      this.groups.makePendingComment(); // C-C1: one comment for a group, framed on every member
      return;
    }
    if (this.report.job) {
      this.thumbWanted.length = 0;
      this.report.step(); // C-C3: the report's pictures
      return;
    }
    if (this.batch) {
      this.thumbWanted.length = 0;
      this.stepBatch();
      return;
    }
    if (!session.settings.clashRowPictures || session.paused || this.thumbWanted.length === 0) {
      this.thumbWanted.length = 0;
      return;
    }
    let budget = this.view === ClashViewMode.REAL ? 1 : 2;
    const started = performance.now();
    for (let i = 0; i < this.thumbWanted.length && budget > 0; i++) {
      if (performance.now() - started > PICTURE_BUDGET_MS) { break; }
      this.renderThumbnail(this.thumbWanted[i]);
      budget--;
    }
    this.thumbWanted.length = 0;
  }

  /**
   * Renders one clash's view off-screen and returns its pixels (bottom-up RGBA), then puts back the clash on screen,
   * the section cut, the camera, the framebuffer and the viewport.
   * @param framed True: from the clash's own framing, the box round it when on. False: the camera and cut as they are.
   */
  private renderPicture(clash: ClashRecord, target: PhotoTarget, width: number, height: number, framed: boolean): { pixels: Uint8Array; frame: ClashView; cut: SectionCut } | null {
    const session = this.session, camera = session.camera;
    let frame: ClashView = { section: Aabb.empty(), eye: camera.position, yaw: camera.yaw, pitch: camera.pitch };
    let cut = session.section.current.clone();
    const saved = {
      current: this.current, suspended: this.multiSuspended, a: this.elementA, b: this.elementB, da: this.dynamicA, db: this.dynamicB,
      section: session.section.current.clone(), position: camera.position, yaw: camera.yaw, pitch: camera.pitch,
      width: camera.viewportWidth, height: camera.viewportHeight, aspect: camera.aspect
    };
    try {
      if (!target.ensure(width, height)) { return null; }
      if (framed) {
        this.multiSuspended = true;
        this.current = clash;
        [this.elementA, this.dynamicA] = this.resolve(clash.a);
        [this.elementB, this.dynamicB] = this.resolve(clash.b);
        const framing = this.frameClash(clash, session.player.yaw);
        frame = framing.view;
        cut = this.boxOn ? framing.cut : new SectionCut();
        session.section.setQuiet(cut);
        camera.position = frame.eye;
        camera.yaw = frame.yaw;
        camera.pitch = frame.pitch;
      }
      camera.viewportWidth = width;
      camera.viewportHeight = height;
      camera.aspect = width / Math.max(height, 1);
      camera.update();
      this.shot = true;
      session.renderScene(width, height, target.framebuffer, true);
      return { pixels: target.read(), frame, cut };
    } catch (e) {
      console.info(`Clash picture failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      this.shot = false;
      this.multiSuspended = saved.suspended;
      this.current = saved.current;
      this.elementA = saved.a;
      this.elementB = saved.b;
      this.dynamicA = saved.da;
      this.dynamicB = saved.db;
      if (framed) { session.section.setQuiet(saved.section); }
      camera.position = saved.position;
      camera.yaw = saved.yaw;
      camera.pitch = saved.pitch;
      camera.viewportWidth = saved.width;
      camera.viewportHeight = saved.height;
      camera.aspect = saved.aspect;
      camera.update();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, session.screenWidth, session.screenHeight);
    }
  }

  /** A clash framed on its own (the report's pictures): pixels at a size, or null. */
  renderShot(clash: ClashRecord, width: number, height: number): { pixels: Uint8Array } | null {
    this.shotTarget ??= new PhotoTarget();
    return this.renderPicture(clash, this.shotTarget, width, height, true);
  }

  /** Frees the comment / report picture target. */
  releaseShotTarget(): void {
    this.shotTarget?.dispose();
    this.shotTarget = null;
  }

  /**
   * C-C1: a group's picture: one member from its own framing; several from the union framing (every pair drawn, the box
   * over all their regions when on and they are at most CLASH_FOCUS_BOX_CAP, far enough back to see them all). The
   * selection, camera and section on screen are put back.
   */
  renderGroupPicture(members: readonly ClashRecord[], width: number, height: number):
    { pixels: Uint8Array; frame: ClashView; cut: SectionCut; centre: Vec3 } | null {
    const session = this.session, origin = session.scene.originOffset, first = members[0];
    this.shotTarget ??= new PhotoTarget();
    let centre = vec3(first.x - origin.x, first.y - origin.y, first.z - origin.z);
    if (members.length === 1) {
      const shot = this.renderPicture(first, this.shotTarget, width, height, true);
      return shot ? { ...shot, centre } : null;
    }
    const camera = session.camera;
    const saved = {
      selected: [...this.selected], current: this.current, suspended: this.multiSuspended, section: session.section.current.clone(),
      position: camera.position, yaw: camera.yaw, pitch: camera.pitch
    };
    try {
      this.multiSuspended = false;
      this.selected.length = 0;
      this.selected.push(...members);
      this.syncLookup();
      this.current = first;
      const { region, boxesA, boxesB } = this.resolveSelected();
      centre = region.center;
      const distance = ClashFraming.distanceToSee(region, session.settings.fieldOfView, width / height);
      const view = ClashFraming.frame(region.center, boxesA, boxesB, region, session.player.yaw, null, distance);
      session.section.setQuiet(this.boxOn && members.length <= CLASH_FOCUS_BOX_CAP ? this.cutOf(region) : new SectionCut());
      camera.position = view.eye;
      camera.yaw = view.yaw;
      camera.pitch = view.pitch;
      const shot = this.renderPicture(first, this.shotTarget, width, height, false);
      return shot ? { ...shot, centre } : null;
    } finally {
      this.selected.length = 0;
      this.selected.push(...saved.selected);
      this.syncLookup();
      this.current = saved.current;
      this.multiSuspended = saved.suspended;
      if (this.selected.length > 1) { this.resolveSelected(); }
      else {
        this.multiA = []; this.multiB = []; this.multiBoth = [];
        this.multiDynamicA = []; this.multiDynamicB = []; this.multiDynamicBoth = [];
      }
      session.section.setQuiet(saved.section);
      camera.position = saved.position;
      camera.yaw = saved.yaw;
      camera.pitch = saved.pitch;
      camera.update();
    }
  }

  /** A row's picture (null = none yet): the cached texture, even a stale one, while a missing or stale one is asked for. */
  private thumbnailTexture(clash: ClashRecord): WebGLTexture | null {
    const cached = this.thumbs.get(clash);
    if (cached) {
      if (cached.version !== this.thumbVersion) { this.thumbWanted.push(clash); }
      return cached.texture;
    }
    this.thumbWanted.push(clash);
    return null;
  }

  private invalidateThumbnail(clash: ClashRecord): void {
    const cached = this.thumbs.get(clash);
    if (cached) { cached.version = -1; }
  }

  /** Renders one row picture at 320 × 180, halves it to 160 × 90 and uploads it. */
  private renderThumbnail(clash: ClashRecord): void {
    this.thumbTarget ??= new PhotoTarget();
    const shot = this.renderPicture(clash, this.thumbTarget, THUMB_RENDER_W, THUMB_RENDER_H, true);
    if (!shot) {
      // Don't ask again this version (a broken one would otherwise render every frame)
      const old = this.thumbs.get(clash);
      this.thumbs.set(clash, { texture: old?.texture ?? null, version: this.thumbVersion });
      return;
    }
    // 2 × 2 box filter, bottom-up rows in, top-down rows out (as the UI draws textures)
    const src = shot.pixels, out = new Uint8Array(THUMB_W * THUMB_H * 4);
    for (let ty = 0; ty < THUMB_H; ty++) {
      const row0 = (THUMB_RENDER_H - 1 - ty * 2) * THUMB_RENDER_W, row1 = (THUMB_RENDER_H - 2 - ty * 2) * THUMB_RENDER_W;
      for (let tx = 0; tx < THUMB_W; tx++) {
        const a = (row0 + tx * 2) * 4, b = (row1 + tx * 2) * 4, o = (ty * THUMB_W + tx) * 4;
        for (let c = 0; c < 3; c++) { out[o + c] = (src[a + c] + src[a + 4 + c] + src[b + c] + src[b + 4 + c] + 2) >> 2; }
        out[o + 3] = 255;
      }
    }
    let entry = this.thumbs.get(clash);
    if (!entry || !entry.texture) {
      if (!entry && this.thumbs.size >= THUMB_CACHE_MAX) { this.releaseThumbnails(); }
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      entry = { texture, version: -1 };
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, THUMB_W, THUMB_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.thumbs.set(clash, { texture: entry.texture, version: this.thumbVersion });
  }

  /** PICTURES: row pictures on / off (remembered in this browser). */
  private toggleThumbnails(): void {
    const session = this.session;
    session.settings.clashRowPictures = !session.settings.clashRowPictures;
    session.settings.save();
    if (!session.settings.clashRowPictures) { this.releaseThumbnails(); }
    this.scrollToCurrent = true;
    this.refreshViewLabels();
    session.sound.play(SoundId.UiClick);
    session.toast(session.settings.clashRowPictures ? 'Clash list: a picture on each row' : 'Clash list: text rows (more on screen)', 2);
  }

  private releaseThumbnails(): void {
    for (const { texture } of this.thumbs.values()) { if (texture) { gl.deleteTexture(texture); } }
    this.thumbs.clear();
  }

  /** Frees the pictures and the off-screen targets (session end). */
  dispose(): void {
    this.releaseThumbnails();
    this.thumbTarget?.dispose();
    this.thumbTarget = null;
    this.shotTarget?.dispose();
    this.shotTarget = null;
  }

  // #endregion

  // #region Comments (C-B2, C-B3)

  /**
   * TO COMMENT: the selected clashes (or the current one) → comments, one per clash. Clashes without a comment get one
   * at once; when some already have one: UPDATE THEM (new picture, view, section, status; markup only with the tick),
   * NEW ONLY or CANCEL.
   */
  private toComment(): void {
    const session = this.session;
    if (!this.current) {
      session.sound.play(SoundId.Error);
      session.toast('Pick a clash first', 2);
      return;
    }
    if (this.batch) { return; }
    const targets = [...this.targets()];
    let existing = 0, markedUp = 0;
    for (const clash of targets) {
      const comment = this.findComment(clash);
      if (!comment) { continue; }
      existing++;
      if (hasMarkup(comment)) { markedUp++; }
    }
    if (existing === 0) {
      this.makeComments(targets, false, false);
      return;
    }
    const count = targets.length, missing = count - existing;
    const message = count === 1
      ? 'This clash already has a comment. UPDATE gives it a new picture, view, section and status (its text and replies stay).'
      : `${existing} of the ${count} selected clashes already have a comment. UPDATE THEM gives those a new picture, view, section and status (text and replies stay)`
        + (missing > 0 ? ` and makes the ${missing} missing; NEW ONLY makes just the ${missing} missing.` : '.');
    session.menu.overlays.openChoice(count === 1 ? 'UPDATE COMMENT?' : 'UPDATE COMMENTS?', message, count === 1 ? 'UPDATE' : 'UPDATE THEM', false,
      markedUp > 0 ? `Replace marked-up pictures too (${markedUp})` : null, missing > 0 ? 'NEW ONLY' : null,
      replace => this.makeComments(targets, true, replace), () => this.makeComments(targets, false, false));
  }

  private makeComments(targets: ClashRecord[], update: boolean, replaceMarkup: boolean): void {
    if (targets.length === 1 && targets[0] === this.current && !this.multiActive) {
      if (!update && this.findComment(this.current)) { return; }
      this.commentPending = replaceMarkup ? 2 : 1;
      return;
    }
    const batch: ClashRecord[] = [];
    for (const clash of targets) {
      if (batch.length >= ClashCommentRules.BATCH_LIMIT) { break; }
      if (update || !this.findComment(clash)) { batch.push(clash); }
    }
    if (batch.length === 0) { return; }
    this.batch = batch;
    this.batchReplace = replaceMarkup;
    this.batchNext = this.batchCreated = this.batchUpdated = this.batchKept = this.batchFailed = 0;
    this.session.sound.play(SoundId.UiClick);
  }

  /** MARKUP / the row pencil: the markup editor on the clash's comment picture; it returns to clash mode on the same clash. */
  private openMarkup(clash: ClashRecord): void {
    const session = this.session;
    const comment = this.findComment(clash);
    if (!comment) {
      session.sound.play(SoundId.Error);
      session.toast('This clash has no comment yet: TO COMMENT makes one (with its picture)', 3);
      return;
    }
    if (!comment.snapshotData && !comment.snapshotOriginalData) {
      session.sound.play(SoundId.Error);
      session.toast("This clash's comment has no picture: UPDATE COMMENT takes one", 3);
      return;
    }
    session.markup.show(comment, true);
  }

  /** A comment's pencil (C-B3; groups since C-C1): drawn only when the comment has a picture; true when clicked. */
  commentPencil(input: InputState, cx: number, cy: number, comment: CommentRecord | null): boolean {
    if (!comment || (!comment.snapshotData && !comment.snapshotOriginalData && !comment.thumbnail)) { return false; }
    const ui = this.session.ui;
    const r = this.s(11);
    const hover = input.mouseX >= cx - r && input.mouseX < cx + r && input.mouseY >= cy - r && input.mouseY < cy + r;
    ui.circle(cx, cy, r, hover ? Rgba.hex(0x22d3ee, 0.95) : Rgba.hex(0x0b1220, 0.85), 16);
    const ink = hover ? Rgba.hex(0x06232a) : hasMarkup(comment) ? Rgba.hex(0xf59e0b) : Rgba.hex(0xffffff);
    const s = r * 0.62;
    ui.line(cx - s * 0.55, cy + s * 0.55, cx + s * 0.6, cy - s * 0.6, Math.max(2, this.s(3)), ink);
    ui.line(cx - s * 0.8, cy + s * 0.8, cx - s * 0.55, cy + s * 0.55, Math.max(1, this.s(1.5)), ink);
    if (hover && input.leftPressed) {
      input.consumeClicks();
      this.session.sound.play(SoundId.UiClick);
      return true;
    }
    return false;
  }

  /** Makes or updates the current clash's comment from what is on screen (mid-flight: from where the flight ends). */
  private makeCurrentComment(replaceMarkup: boolean): void {
    const session = this.session;
    const clash = this.current;
    if (!clash || !this.document) { return; }
    this.shotTarget ??= new PhotoTarget();
    const shot = this.renderPicture(clash, this.shotTarget, SHOT_W, SHOT_H, this.flying);
    this.shotTarget.dispose();
    this.shotTarget = null;
    if (!shot) {
      session.sound.play(SoundId.Error);
      session.toast("The clash picture couldn't be taken (see the browser console)", 3, true);
      return;
    }
    const outcome = this.makeComment(clash, shot.pixels, SHOT_W, SHOT_H, shot.frame, shot.cut, replaceMarkup);
    this.changed();
    this.listDirty = true;
    this.panel.rowsDirty = true;
    session.sound.play(SoundId.Commit);
    session.toast(outcome === 'created' ? 'Comment made from the clash (Esc → COMMENTS · EXPORT BCF)'
      : outcome === 'kept' ? "The clash's comment updated (its marked-up picture kept)" : "The clash's comment updated: new picture, view and status", 3);
  }

  /** Makes a clash's comment, or updates its own (picture, view and section, status, assignee), from rendered pixels. */
  private makeComment(clash: ClashRecord, pixels: Uint8Array, width: number, height: number, frame: ClashView, cut: SectionCut, replaceMarkup: boolean): 'created' | 'updated' | 'kept' {
    const session = this.session, comments = session.comments;
    const test = findTest(this.document!, clash.testId);
    const status = ClashCommentRules.commentStatusFor(clash.status);
    let record = this.findComment(clash);
    let outcome: 'created' | 'updated' | 'kept';
    if (!record) {
      const origin = session.scene.originOffset;
      const point = vec3(clash.x - origin.x, clash.y - origin.y, clash.z - origin.z);
      const hostA = !clash.a.link && clash.a.cloneKey === 0;
      record = comments.add(point, this.commentText(clash, test), hostA ? clash.a.elementId : -1, clashLevel(clash), hostA ? clash.a.uniqueId : null);
      record.clashId = clash.id;
      comments.setIssue(record, { status, priority: ClashCommentRules.priorityFor(clash, test?.kind ?? ClashKind.HARD), assignedTo: clash.assignedTo?.trim() ?? '' });
      clash.commentId = record.id;
      outcome = 'created';
    } else {
      comments.setIssue(record, { status, assignedTo: clash.assignedTo?.trim() ?? '' });
      record.clashId ??= clash.id;
      outcome = 'updated';
    }
    const stand = session.player.controller.standEye;
    comments.setView(record, vec3(frame.eye.x, frame.eye.y, frame.eye.z - stand), frame.yaw, frame.pitch, true, cut);
    if (hasMarkup(record) && !replaceMarkup) { return 'kept'; }
    const canvas = pixelsCanvas(pixels, width, height);
    const thumb = document.createElement('canvas');
    thumb.width = COMMENT_THUMB_W;
    thumb.height = COMMENT_THUMB_H;
    const context = thumb.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(canvas, 0, 0, COMMENT_THUMB_W, COMMENT_THUMB_H);
    const thumbnail = thumb.toDataURL('image/jpeg', 0.72).replace(/^data:image\/jpeg;base64,/, '');
    const snapshot = base64Bytes(canvas.toDataURL('image/jpeg', 0.82).replace(/^data:image\/jpeg;base64,/, ''));
    comments.setPictures(record, thumbnail, snapshot);
    return outcome;
  }

  /** The next TO COMMENTS pictures (as many as fit the frame's budget, at least one). */
  private stepBatch(): void {
    const batch = this.batch!;
    const started = performance.now();
    this.shotTarget ??= new PhotoTarget();
    while (this.batchNext < batch.length) {
      const clash = batch[this.batchNext++];
      const shot = this.renderPicture(clash, this.shotTarget, SHOT_W, SHOT_H, true);
      if (shot) {
        const outcome = this.makeComment(clash, shot.pixels, SHOT_W, SHOT_H, shot.frame, shot.cut, this.batchReplace);
        if (outcome === 'created') { this.batchCreated++; } else if (outcome === 'kept') { this.batchKept++; } else { this.batchUpdated++; }
      } else {
        this.batchFailed++;
      }
      if (performance.now() - started > PICTURE_BUDGET_MS) { break; }
    }
    if (this.batchNext >= batch.length) { this.finishBatch(false); }
  }

  /** Ends TO COMMENTS (done or cancelled: the comments made stay) and says what happened. */
  private finishBatch(cancelled: boolean): void {
    const batch = this.batch;
    if (!batch) { return; }
    const session = this.session;
    const total = batch.length, done = this.batchNext;
    this.batch = null;
    this.shotTarget?.dispose();
    this.shotTarget = null;
    this.changed();
    this.listDirty = true;
    this.panel.rowsDirty = true;
    session.sound.play(cancelled ? SoundId.UiClick : SoundId.Commit);
    const made = `${this.batchCreated} made, ${this.batchUpdated + this.batchKept} updated`
      + (this.batchKept > 0 ? ` (${this.batchKept} kept their marked-up picture)` : '')
      + (this.batchFailed > 0 ? `, ${this.batchFailed} without a picture (see the browser console)` : '');
    session.toast(cancelled ? `Comments stopped at ${done} of ${total}: ${made}` : `Clash comments: ${made} (Esc → COMMENTS · EXPORT BCF)`, 5, this.batchFailed > 0);
  }

  private buildBatchProgress(f: FontAtlas, x: number, y: number, w: number): void {
    const session = this.session, ui = session.ui, batch = this.batch!;
    ui.text(f.small, x, y, `MAKING COMMENTS · ${this.batchNext} OF ${batch.length.toLocaleString('en')}`, UiTheme.ACCENT, this.s(1.2));
    const barY = y + this.s(24);
    ui.rect(x, barY, w, this.s(8), UiTheme.CONTROL);
    ui.rect(x, barY, w * Math.min(Math.max(this.batchNext / Math.max(1, batch.length), 0), 1), this.s(8), UiTheme.ACCENT);
    ui.textWrapped(f.small, x, barY + this.s(16), w, 'Each clash is framed, pictured and saved as a comment. The ones made stay if you cancel.', UiTheme.TEXT_MUTED, 2);
    if (session.menu.widgets.smallButton(f, x, barY + this.s(54), Math.min(w, this.s(140)), this.s(28), 'CANCEL')) { this.finishBatch(true); }
  }

  /** The clash's comment, or null (none made, or it was deleted). */
  findComment(clash: ClashRecord | null): CommentRecord | null {
    return clash?.commentId ? this.session.comments.find(clash.commentId) : null;
  }

  /** A clash comment's text (grids round B: " · Near C-4 : Level 2" when "In clash comments" is on). */
  private commentText(clash: ClashRecord, test: ClashTest | null): string {
    const grids = this.session.grids;
    const text = `Clash: ${test?.name ?? 'clash test'} · ${elementRefLabel(clash.a)} × ${elementRefLabel(clash.b)} · ${clashAmount(clash)} · ${clashLevel(clash)}`
      + (grids.inClashComments ? grids.clashSuffix(clash, false) : '');
    return clash.notes?.trim() ? `${text} · Notes: ${clash.notes.trim()}` : text;
  }

  /** Makes a clash's comment show the clash's status (clash → comment, one way). */
  syncComment(clash: ClashRecord): boolean {
    const record = this.findComment(clash);
    return record !== null && this.session.comments.setIssue(record, { status: ClashCommentRules.commentStatusFor(clash.status) });
  }

  /** After a run or an imported report: every linked comment follows its clash's status. */
  private syncComments(): void {
    for (const clash of this.document?.clashes ?? []) {
      if (clash.commentId) { this.syncComment(clash); }
    }
    this.groups.syncGroupComments(); // C-C1
  }

  /** Deleted comments made from clashes: their clashes forget them (only when clash detection is on). */
  unlinkComments(deleted: readonly CommentRecord[]): void {
    if (!this.document || deleted.length === 0) { return; }
    const ids = new Set(deleted.filter(r => r.clashId).map(r => r.id.toLowerCase()));
    if (ids.size === 0) { return; }
    let changed = false;
    for (const clash of this.document.clashes) {
      if (clash.commentId && ids.has(clash.commentId.toLowerCase())) {
        clash.commentId = null;
        changed = true;
      }
    }
    if (changed) {
      this.changed();
      this.panel.rowsDirty = true;
    }
  }

  /** The clash on screen no longer exists (reset, test deleted): clash mode shows none. */
  forgetCurrentIfGone(): void {
    if (!this.current || this.document?.clashes.includes(this.current)) { return; }
    this.current = null;
    this.elementA = this.elementB = -1;
    this.dynamicA = this.dynamicB = null;
  }

  // #endregion
}

/** Bottom-up RGBA pixels as a top-down canvas (opaque). */
export function pixelsCanvas(pixels: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(width, height);
  const stride = width * 4;
  for (let y = 0; y < height; y++) { image.data.set(pixels.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride); }
  for (let i = 3; i < image.data.length; i += 4) { image.data[i] = 255; }
  context.putImageData(image, 0, 0);
  return canvas;
}

export function base64Bytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
  return bytes;
}

