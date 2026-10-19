import type { ClashGroup } from '../../core/clashes/ClashGroups';
import { ClashStatus, type ClashRecord, findTest } from '../../core/clashes/ClashModels';
import { ClashReportGroups, type ClashReportOptions, type ClashReportPicture, ClashReports } from '../../core/clashes/ClashReports';
import type { FontAtlas } from '../../engine/ui/UiFont';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { downloadBlob, safeFileName } from '../../platform/files';
import type { InputState } from '../../platform/input';
import type { GameSession } from '../GameSession';
import { UnitFormat } from '../UnitFormat';
import type { Clashes } from './Clashes';
import { CLASH_STATUS_FILTERS, pixelsCanvas } from './Clashes';
import { CLASH_SHOW_ALL, CLASH_SHOW_LABELS } from './ClashGroupUi';

const REPORT_SCOPE_SHOWN = 0, REPORT_SCOPE_SELECTION = 1, REPORT_SCOPE_TEST = 2, REPORT_SCOPE_ALL = 3;
const REPORT_FORMAT_BOTH = 0, REPORT_FORMAT_HTML = 1, REPORT_FORMAT_XML = 2;
const REPORT_PICTURE_W = 960, REPORT_PICTURE_H = 540;
const SHOT_W = 1280, SHOT_H = 720;
/** Above this many pictures the export asks first (time and file size). */
const REPORT_PICTURES_WARN = 300;
const PICTURE_BUDGET_MS = 40;
const DROP_DOCK_REPORT_SCOPE = 21, DROP_DOCK_REPORT_FORMAT = 22, DROP_DOCK_REPORT_GROUPS = 23;
const REPORT_FORMAT_LABELS = ['FORMAT: HTML + XML', 'FORMAT: HTML', 'FORMAT: XML'];
const REPORT_GROUP_LABELS = ['GROUPS: SECTIONS (MEMBERS LISTED)', 'GROUPS: COMPACT (ONE ITEM EACH)', 'GROUPS: IGNORED (EVERY CLASH)'];

/** An export in progress: what it holds, the pictures still to render, the file names. */
interface ClashReportJob {
  clashes: ClashRecord[];
  pictures: ClashReportPicture[];
  members: Map<ClashGroup, ClashRecord[]>;
  readonly jpegs: Map<string, Uint8Array>;
  comments: Map<string, string>;
  options: ClashReportOptions;
  html: boolean;
  xml: boolean;
  name: string;
  next: number;
  failed: number;
}

/**
 * Clash reports (Round C, build C-C3; port of GameSession.ClashReport.cs). REPORT… → EXPORT REPORT (HTML / XML)… opens a
 * card in the dock: scope (what the list shows, the selection, this test, all tests), format (HTML + XML, HTML, XML),
 * pictures on / off and groups (sections, compact, ignored); EXPORT… renders each group and clash (a few per frame,
 * progress and CANCEL in the card) and downloads the files (the XML beside the HTML, same name).
 */
export class ClashReportUi {
  cardOpen = false;
  private scope = REPORT_SCOPE_SHOWN;
  private format = REPORT_FORMAT_BOTH;
  private groupMode: number = ClashReportGroups.SECTIONS;
  private pictures = true;
  private scopeLabel = '';
  private scopeLabelKey = '';
  job: ClashReportJob | null = null;
  /** EXPORT… on the card (or after the large-report confirm): acted on after the dock's overlays. */
  exportRequested = 0; // 0 none, 1 export, 2 export confirmed

  constructor(private readonly session: GameSession, private readonly clashes: Clashes) {}

  private s(v: number): number { return this.session.s(v); }

  // #region Card

  /** REPORT… → EXPORT REPORT (HTML / XML)…: the card in the dock. */
  openCard(): void {
    if (this.clashes.commentBatchActive || this.job) { return; }
    this.cardOpen = true;
    this.scopeLabelKey = '';
    this.session.sound.play(SoundId.UiClick);
  }

  /** The card: scope, format, pictures, groups, EXPORT… / CANCEL (in place of the clash details). */
  buildCard(f: FontAtlas, input: InputState, x: number, y: number, w: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, overlays = session.menu.overlays, owner = this.clashes.list;
    let cy = y;
    ui.text(f.small, x, cy, 'CLASH REPORT', UiTheme.ACCENT, this.s(1.2));
    cy += this.s(22);
    this.refreshScopeLabel();
    if (overlays.button(f, input, x, cy, w, this.s(28), this.scopeLabel, overlays.isDropdownOpen(owner, DROP_DOCK_REPORT_SCOPE))) {
      overlays.openDropdown(owner, DROP_DOCK_REPORT_SCOPE, x, cy, w, this.s(28), [0, 1, 2, 3].map(s => `${scopeName(s)} (${this.scopeCount(s).toLocaleString('en')})`),
        this.scope, i => { this.scope = i; this.scopeLabelKey = ''; });
    }
    cy += this.s(34);
    const half = (w - this.s(6)) * 0.5;
    if (overlays.button(f, input, x, cy, half, this.s(28), REPORT_FORMAT_LABELS[this.format], overlays.isDropdownOpen(owner, DROP_DOCK_REPORT_FORMAT))) {
      overlays.openDropdown(owner, DROP_DOCK_REPORT_FORMAT, x, cy, half, this.s(28), REPORT_FORMAT_LABELS, this.format, i => { this.format = i; });
    }
    const html = this.format !== REPORT_FORMAT_XML;
    const pictures = !html ? 'PICTURES: —' : this.pictures ? 'PICTURES: ON' : 'PICTURES: OFF';
    if (wd.smallButton(f, x + half + this.s(6), cy, half, this.s(28), pictures) && html) { this.pictures = !this.pictures; }
    cy += this.s(34);
    if (overlays.button(f, input, x, cy, w, this.s(28), REPORT_GROUP_LABELS[this.groupMode], overlays.isDropdownOpen(owner, DROP_DOCK_REPORT_GROUPS))) {
      overlays.openDropdown(owner, DROP_DOCK_REPORT_GROUPS, x, cy, w, this.s(28), REPORT_GROUP_LABELS, this.groupMode, i => { this.groupMode = i; });
    }
    cy += this.s(34);
    if (wd.smallButton(f, x, cy, half, this.s(28), 'EXPORT…')) { this.exportRequested = 1; }
    if (wd.smallButton(f, x + half + this.s(6), cy, half, this.s(28), 'CANCEL')) { this.cardOpen = false; }
  }

  private refreshScopeLabel(): void {
    const count = this.scopeCount(this.scope);
    const key = `${this.scope}|${count}`;
    if (key === this.scopeLabelKey) { return; }
    this.scopeLabelKey = key;
    this.scopeLabel = `SCOPE: ${scopeName(this.scope)} (${count.toLocaleString('en')})`;
  }

  /** How many clashes a scope takes. */
  private scopeCount(scope: number): number {
    const clashes = this.clashes;
    switch (scope) {
      case REPORT_SCOPE_SELECTION: return clashes.multiActive ? clashes.selectedCount : clashes.current ? 1 : 0;
      case REPORT_SCOPE_TEST: return clashes.testClashCount;
      case REPORT_SCOPE_ALL: return clashes.document?.clashes.length ?? 0;
      default: return clashes.list.length;
    }
  }

  /** The clashes a scope takes, in report order. */
  private scopeClashes(scope: number): ClashRecord[] {
    const clashes = this.clashes, document = clashes.document!;
    switch (scope) {
      case REPORT_SCOPE_SELECTION: {
        if (!clashes.multiActive) { return clashes.current ? [clashes.current] : []; }
        // The list's order (selected clashes the list doesn't show come last)
        const picked = new Set(clashes.selection);
        const ordered = clashes.list.filter(c => picked.has(c));
        for (const clash of clashes.selection) { if (!ordered.includes(clash)) { ordered.push(clash); } }
        return ordered;
      }
      case REPORT_SCOPE_TEST: return this.sortForReport(document.clashes.filter(c => c.testId === clashes.reviewTest));
      case REPORT_SCOPE_ALL: return this.sortForReport(document.clashes);
      default: return [...clashes.list];
    }
  }

  /** By test (the tests' order), then status (new first), then deepest first. */
  private sortForReport(list: readonly ClashRecord[]): ClashRecord[] {
    const document = this.clashes.document!;
    const order = new Map(document.tests.map((t, i) => [t.id, i]));
    return [...list].sort((a, b) => (order.get(a.testId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.testId) ?? Number.MAX_SAFE_INTEGER)
      || ClashStatus.indexOf(a.status) - ClashStatus.indexOf(b.status) || b.distance - a.distance);
  }

  /** The scope in words, for the report's cover. */
  private scopeText(scope: number, count: number): string {
    const clashes = this.clashes, document = clashes.document!;
    const test = findTest(document, clashes.reviewTest)?.name ?? '—';
    switch (scope) {
      case REPORT_SCOPE_SELECTION: return `The selection: ${count.toLocaleString('en')} clash${count === 1 ? '' : 'es'} of test “${test}”`;
      case REPORT_SCOPE_TEST: return `Test “${test}”: every clash`;
      case REPORT_SCOPE_ALL: return `Every test (${document.tests.length.toLocaleString('en')})`;
      default: {
        const { status, level, search, show } = clashes.filterState;
        return `What the list showed: test “${test}”, status ${CLASH_STATUS_FILTERS[status].toLowerCase()}, level ${level ?? 'all'}`
          + (search ? `, search “${search}”` : '') + (show === CLASH_SHOW_ALL ? '' : ', ' + CLASH_SHOW_LABELS[show].toLowerCase());
      }
    }
  }

  // #endregion

  // #region Export

  /** EXPORT… on the card: the clashes, then the files (straight away without pictures, else after the pictures render). */
  start(confirmed: boolean): void {
    const session = this.session, clashes = this.clashes, document = clashes.document;
    if (!document || this.job) { return; }
    const list = this.scopeClashes(this.scope);
    if (list.length === 0) {
      session.sound.play(SoundId.Error);
      session.toast('Nothing to report in that scope', 2.5);
      return;
    }
    const html = this.format !== REPORT_FORMAT_XML, xml = this.format !== REPORT_FORMAT_HTML;
    const wanted = html && this.pictures ? ClashReports.pictures(document, list, this.groupMode) : [];
    if (!confirmed && wanted.length > REPORT_PICTURES_WARN) {
      session.menu.overlays.openConfirm('LARGE REPORT', `${wanted.length.toLocaleString('en')} pictures to render: about ${Math.max(1, Math.trunc(wanted.length / 6)).toLocaleString('en')} s `
        + `and roughly ${Math.round(wanted.length * 0.1).toLocaleString('en')} MB of HTML. Turn PICTURES off, narrow the scope, or use GROUPS: COMPACT for a lighter report.`,
      'EXPORT', false, false, () => { this.exportRequested = 2; });
      return;
    }
    const d = new Date(), two = (n: number) => String(n).padStart(2, '0');
    const name = `${safeFileName(session.scene.modelTitle)} clash report ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}`;
    const job: ClashReportJob = {
      clashes: list, pictures: wanted, members: new Map(), jpegs: new Map(), comments: this.reportComments(list),
      options: {
        title: 'Clash report', modelTitle: session.scene.modelTitle, generator: `BimGo Web ${__BIMGO_VERSION__}`, author: session.settings.userName,
        created: new Date(), scopeLabel: this.scopeText(this.scope, list.length), groupMode: this.groupMode,
        length: m => UnitFormat.length(m, 3), gridLocation: session.grids.clashFunction() // grids round B: "C-4 : Level 2" (null without grids)
      },
      html, xml, name, next: 0, failed: 0
    };
    for (const section of ClashReports.sections(document, list, ClashReportGroups.SECTIONS)) {
      if (section.group) { job.members.set(section.group, section.clashes); }
    }
    this.cardOpen = false;
    if (wanted.length === 0) {
      this.write(job);
      return;
    }
    this.job = job;
    session.sound.play(SoundId.UiClick);
  }

  /** The comment text of each clash and group in the report that has one. */
  private reportComments(list: readonly ClashRecord[]): Map<string, string> {
    const comments = new Map<string, string>(), clashes = this.clashes;
    for (const clash of list) {
      const comment = clashes.findComment(clash);
      if (comment?.text.trim()) { comments.set(clash.id, comment.text); }
      const group = clashes.groups.groupOf(clash);
      if (group && !comments.has(group.id)) {
        const own = clashes.groups.findComment(group);
        if (own?.text.trim()) { comments.set(group.id, own.text); }
      }
    }
    return comments;
  }

  /** The next report pictures (as many as fit the frame's budget, at least one), then the files. */
  step(): void {
    const job = this.job!, clashes = this.clashes;
    const started = performance.now();
    while (job.next < job.pictures.length) {
      const picture = job.pictures[job.next++];
      let pixels: Uint8Array | null = null;
      if (picture.group) {
        const inReport = job.members.get(picture.group);
        const members = inReport && inReport.length > 0 ? inReport : clashes.groups.allMembers(picture.group);
        pixels = members.length > 0 ? clashes.renderGroupPicture(members, SHOT_W, SHOT_H)?.pixels ?? null : null;
      } else if (picture.clash) {
        pixels = clashes.renderShot(picture.clash, SHOT_W, SHOT_H)?.pixels ?? null;
      }
      if (pixels) {
        try { job.jpegs.set(picture.id, jpegBytes(pixels, SHOT_W, SHOT_H, REPORT_PICTURE_W, REPORT_PICTURE_H)); }
        catch (e) {
          console.warn('Clash report picture failed', e);
          job.failed++;
        }
      } else { job.failed++; }
      if (performance.now() - started > PICTURE_BUDGET_MS) { break; }
    }
    if (job.next >= job.pictures.length) {
      this.job = null;
      clashes.releaseShotTarget();
      this.write(job);
    }
  }

  /** Stops an export in progress (nothing is written). */
  cancel(): void {
    if (!this.job) { return; }
    const done = this.job.next, total = this.job.pictures.length;
    this.job = null;
    this.clashes.releaseShotTarget();
    this.session.sound.play(SoundId.UiClick);
    this.session.toast(`Report cancelled at picture ${done.toLocaleString('en')} of ${total.toLocaleString('en')} (nothing written)`, 3);
  }

  /** Builds the HTML and / or XML and downloads them. */
  private write(job: ClashReportJob): void {
    const session = this.session, document = this.clashes.document!;
    try {
      if (job.html) {
        downloadBlob(new Blob([ClashReports.html(document, job.clashes, job.options, job.jpegs, job.comments)], { type: 'text/html' }), job.name + '.html');
      }
      if (job.xml) {
        downloadBlob(new Blob([ClashReports.xml(document, job.clashes, job.options, job.comments)], { type: 'application/xml' }), job.name + '.xml');
      }
    } catch (e) {
      console.error('Clash report failed', e);
      session.sound.play(SoundId.Error);
      session.toast(`The report couldn't be written: ${e instanceof Error ? e.message : String(e)}`, 5, true);
      return;
    }
    session.sound.play(SoundId.Commit);
    const files = job.html && job.xml ? `${job.name}.html + .xml` : job.name + (job.html ? '.html' : '.xml');
    session.toast(`Clash report saved: ${files} (${job.clashes.length.toLocaleString('en')} clashes`
      + (job.jpegs.size > 0 ? `, ${job.jpegs.size.toLocaleString('en')} pictures` : '')
      + (job.failed > 0 ? `, ${job.failed.toLocaleString('en')} pictures failed (see the browser console)` : '') + ') · your Downloads folder', 4, job.failed > 0);
  }

  /** The dock's progress while the report's pictures render, with CANCEL. */
  buildProgress(f: FontAtlas, x: number, y: number, w: number): void {
    const session = this.session, ui = session.ui, job = this.job!;
    const total = Math.max(1, job.pictures.length);
    ui.text(f.small, x, y, `EXPORTING REPORT · PICTURE ${job.next} OF ${job.pictures.length.toLocaleString('en')}`, UiTheme.ACCENT, this.s(1.2));
    const barY = y + this.s(24);
    ui.rect(x, barY, w, this.s(8), UiTheme.CONTROL);
    ui.rect(x, barY, w * Math.min(Math.max(job.next / total, 0), 1), this.s(8), UiTheme.ACCENT);
    ui.textWrapped(f.small, x, barY + this.s(16), w, 'Each group and clash is framed and pictured as the view and box are set now. The files download at the end.', UiTheme.TEXT_MUTED, 2);
    if (session.menu.widgets.smallButton(f, x, barY + this.s(54), Math.min(w, this.s(140)), this.s(28), 'CANCEL')) { this.cancel(); }
  }

  // #endregion
}

function scopeName(scope: number): string {
  switch (scope) {
    case REPORT_SCOPE_SELECTION: return 'THE SELECTION';
    case REPORT_SCOPE_TEST: return 'THIS TEST (EVERY CLASH)';
    case REPORT_SCOPE_ALL: return 'ALL TESTS';
    default: return 'WHAT THE LIST SHOWS';
  }
}

/** Bottom-up RGBA pixels as JPEG bytes at a size (quality 0.78). */
function jpegBytes(pixels: Uint8Array, width: number, height: number, outW: number, outH: number): Uint8Array {
  const source = pixelsCanvas(pixels, width, height);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const context = canvas.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, outW, outH);
  const binary = atob(canvas.toDataURL('image/jpeg', 0.78).replace(/^data:image\/jpeg;base64,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
  return bytes;
}
