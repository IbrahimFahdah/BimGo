import { type ClashGroup, ClashGroups, ClashGrouping } from '../../core/clashes/ClashGroups';
import { ClashCommentRules, type ClashElementRef, ClashKind, type ClashRecord, ClashStatus, type ClashTest, elementRefKey, elementRefLabel, findTest } from '../../core/clashes/ClashModels';
import { type CommentRecord, CommentPriority, CommentStatus, hasMarkup } from '../../core/format/DocumentModels';
import { vec3 } from '../../core/math/Vector';
import { gridLocationText } from '../../core/scene/GridData';
import { Rgba } from '../../engine/ui/Rgba';
import type { FontAtlas } from '../../engine/ui/UiFont';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import type { InputState } from '../../platform/input';
import type { GameSession } from '../GameSession';
import type { ClashRow, Clashes } from './Clashes';
import { base64Bytes, clashLevel, clashStatusColour, pixelsCanvas } from './Clashes';

/** One line of the docked list: a group row, or a clash row (a member when indented under its group). */
export interface ClashDisplayRow {
  /** The group row's group, or a member row's group. */
  group: ClashGroup | null;
  /** A clash row (null for a group row). */
  row: ClashRow | null;
  /** Indented under its group. */
  member: boolean;
  title: string;
  detail: string;
  status: string;
  mixed: boolean;
  /** A group row: its first shown member (its picture). */
  first: ClashRecord | null;
}

/** SHOW: all / groups only (ungrouped hidden) / ungrouped only (grouped hidden). */
export const CLASH_SHOW_ALL = 0, CLASH_SHOW_GROUPS = 1, CLASH_SHOW_UNGROUPED = 2;
export const CLASH_SHOW_CHOICES = ['ALL', 'GROUPS ONLY (HIDE UNGROUPED)', 'UNGROUPED ONLY (HIDE GROUPED)'];
export const CLASH_SHOW_LABELS = ['SHOW: ALL', 'SHOW: GROUPS', 'SHOW: UNGROUPED'];

/** TOOLS ▾ (the grouping tools, then the automatic methods: the test's ungrouped open clashes, 2+ per group). */
export const CLASH_TOOL_ACTIONS = [
  'GROUP BY BOX…', 'PICK POINTS', 'CLUSTER AROUND THE CURRENT CLASH…',
  'AUTO: BY ELEMENT', 'AUTO: BY LEVEL', 'AUTO: BY CATEGORY PAIR', 'AUTO: BY LEVEL + CATEGORY PAIR',
  'AUTO: BY GRID', 'AUTO: BY GRID + LEVEL',
  'REMOVE AUTOMATIC GROUPS'
];
const TOOL_BOX = 0, TOOL_PICK = 1, TOOL_CLUSTER = 2, TOOL_AUTO_LEVEL = 4, TOOL_AUTO_CATEGORY = 5, TOOL_AUTO_LEVEL_CATEGORY = 6, TOOL_AUTO_GRID = 7,
  TOOL_AUTO_GRID_LEVEL = 8, TOOL_REMOVE_AUTO = 9;

const DROP_DOCK_MENU = 17, DROP_DOCK_ADD_TO = 18;
const CLASH_STATUS_SHORT = ['1 NEW', '2 ACTIVE', '3 REVIEW', '4 APPROVE', '5 RESOLVE'];
const GROUP_COMMENT_KEEP = 0, GROUP_COMMENT_LINK = 1, GROUP_COMMENT_REPLACE = 2;
const SHOT_W = 1280, SHOT_H = 720, COMMENT_THUMB_W = 192, COMMENT_THUMB_H = 108;

const plural = (n: number, word: string, many = word + 'es') => `${n.toLocaleString('en')} ${n === 1 ? word : many}`;
export const shorten = (text: string | null, max: number) => (!text || text.length <= max ? text ?? '' : text.slice(0, max - 1).trimEnd() + '…');

/**
 * Clash groups in clash mode (Round C, build C-C1; port of GameSession.ClashGroups.cs). The docked list shows group rows
 * (chevron, name, member count, status, MIXED) among the clashes, members indented when expanded; a click on a group row
 * selects its shown members and shows the group card (status 1–5 for the group and every member, ASSIGN…, NOTES…, one
 * comment for the group); right-click menus on rows; GROUP / UNGROUP / TOOLS ▾ on the dock. A clash is in one group.
 */
export class ClashGroupUi {
  readonly display: ClashDisplayRow[] = [];
  private groupOfMap = new Map<string, ClashGroup>();
  byId = new Map<string, ClashRecord>();
  private indexRevision = -1;
  private indexDocument: object | null = null;

  /** Expanded groups (per session), the group whose card shows, groups picked (click order: the first wins a merge). */
  readonly expanded = new Set<string>();
  current: ClashGroup | null = null;
  readonly picks: ClashGroup[] = [];
  groupsInTest = 0;
  /** SHOW ▾. */
  filter = CLASH_SHOW_ALL;

  private cardHeader: string | null = null;
  private cardCounts: string | null = null;
  private cardAssign: string | null = null;
  private cardNotes: string | null = null;
  private cardMixed = false;

  /** Clicks found while drawing the list, acted on after the overlays. */
  groupClick: ClashGroup | null = null;
  chevron: ClashGroup | null = null;
  menuRow: ClashDisplayRow | null = null;
  menuAt: [number, number] = [0, 0];
  markupClick: ClashGroup | null = null;

  /** The group's comment: made or updated at the start of the next frame. */
  commentPending: ClashGroup | null = null;
  private commentMode = GROUP_COMMENT_KEEP;
  private commentReplaceMarkup = false;

  constructor(private readonly session: GameSession, private readonly clashes: Clashes) {}

  private s(v: number): number { return this.session.s(v); }

  private get document() { return this.clashes.document!; }

  private get user(): string { return this.session.settings.userName; }

  private get now(): string { return new Date().toISOString(); }

  // #region Index and list

  /** The clash → group and id → clash lookups, rebuilt when the document changed. */
  ensureIndex(): void {
    const document = this.clashes.document;
    if (!document) { return; }
    if (this.indexRevision === this.clashes.revision && this.indexDocument === document) { return; }
    this.indexRevision = this.clashes.revision;
    this.indexDocument = document;
    this.groupOfMap = ClashGroups.index(document);
    this.byId = ClashGroups.clashesById(document);
    const groups = document.groups ?? [];
    if (this.current && !groups.includes(this.current)) { this.current = null; }
    for (let i = this.picks.length - 1; i >= 0; i--) { if (!groups.includes(this.picks[i])) { this.picks.splice(i, 1); } }
  }

  /** The group a clash is in, or null. */
  groupOf(clash: ClashRecord | null): ClashGroup | null {
    if (!clash) { return null; }
    this.ensureIndex();
    return this.groupOfMap.get(clash.id) ?? null;
  }

  /** The group name a search can match (empty when the clash is ungrouped). */
  searchText(clash: ClashRecord): string {
    const group = this.groupOfMap.get(clash.id);
    return group ? ClashGroups.displayName(group) : '';
  }

  /**
   * Builds the display rows and the navigation list from the filtered, sorted clash rows: groups first (by their own
   * status, then their deepest member), members after them (all in the list, only expanded groups' on screen), then the
   * ungrouped clashes.
   */
  buildDisplay(rows: readonly ClashRow[], list: ClashRecord[]): void {
    this.ensureIndex();
    this.display.length = 0;
    list.length = 0;
    const buckets = new Map<ClashGroup, ClashRow[]>();
    const tops: { status: number; depth: number; order: number; group: ClashGroup | null; row: ClashRow | null }[] = [];
    for (const row of rows) {
      const group = this.groupOfMap.get(row.clash.id);
      if (group) {
        if (this.filter === CLASH_SHOW_UNGROUPED) { continue; } // grouped hidden
        let members = buckets.get(group);
        if (!members) {
          members = [];
          buckets.set(group, members);
          tops.push({ status: ClashStatus.indexOf(group.status), depth: row.clash.distance, order: tops.length, group, row: null });
        }
        members.push(row);
        continue;
      }
      if (this.filter === CLASH_SHOW_GROUPS) { continue; } // ungrouped hidden
      tops.push({ status: ClashStatus.indexOf(row.clash.status), depth: row.clash.distance, order: tops.length, group: null, row });
    }
    tops.sort((p, q) => Number(p.group === null) - Number(q.group === null) || p.status - q.status || q.depth - p.depth || p.order - q.order);
    for (const { group, row } of tops) {
      if (!group) {
        this.display.push({ group: null, row, member: false, title: '', detail: '', status: '', mixed: false, first: null });
        list.push(row!.clash);
        continue;
      }
      const members = buckets.get(group)!;
      this.display.push(this.makeGroupRow(group, members));
      const open = this.expanded.has(group.id);
      for (const member of members) {
        list.push(member.clash);
        if (open) { this.display.push({ group, row: member, member: true, title: '', detail: '', status: '', mixed: false, first: null }); }
      }
    }
    this.groupsInTest = (this.document.groups ?? []).filter(g => g.testId === this.clashes.reviewTest).length;
  }

  /** A group row's text: name, "5 of 7 shown · 3 new, 2 active · assignee · notes", status. */
  private makeGroupRow(group: ClashGroup, shown: readonly ClashRow[]): ClashDisplayRow {
    const summary = ClashGroups.summarise(group, this.byId);
    const count = group.clashIds.length;
    const counted = shown.length === count ? plural(count, 'clash') : `${shown.length} of ${count} shown`;
    const detail = counted + (summary.mixed ? ' · ' + statusCounts(summary.byStatus) : '') + (group.assignedTo ? ' · ' + group.assignedTo : '')
      + (group.notes ? ' · notes' : '') + (group.commentId ? ' · comment' : '');
    return {
      group, row: null, member: false, title: ClashGroups.displayName(group), detail, status: ClashStatus.label(group.status).toUpperCase(),
      mixed: summary.mixed, first: shown.length > 0 ? shown[0].clash : null
    };
  }

  /** The group card's text (built when the group or its details change). */
  refreshCard(): void {
    const group = this.current;
    if (!group) { return; }
    this.ensureIndex();
    const summary = ClashGroups.summarise(group, this.byId);
    const count = group.clashIds.length;
    const shown = this.clashes.list.filter(c => this.groupOfMap.get(c.id) === group).length;
    this.cardMixed = summary.mixed;
    this.cardHeader = `GROUP · ${count} CLASH${count === 1 ? '' : 'ES'}` + (shown === count ? '' : ` · ${shown} SHOWN`);
    this.cardCounts = (summary.mixed ? 'Members: ' + statusCounts(summary.byStatus) : `Every member ${ClashStatus.label(group.status).toLowerCase()}`)
      + (group.keyElement ? ' · all on ' + ClashGroups.elementName(group.keyElement) : '')
      + (group.notes ? ' · Notes: ' + group.notes.replace(/\n/g, ' ') : '');
    this.cardAssign = group.assignedTo ? 'ASSIGNED: ' + group.assignedTo : 'ASSIGN…';
    this.cardNotes = group.notes ? 'NOTES (EDIT)…' : 'NOTES…';
  }

  /** A group's members the list shows, in list order. */
  shownMembers(group: ClashGroup): ClashRecord[] {
    return this.clashes.list.filter(c => this.groupOfMap.get(c.id) === group);
  }

  /** Every member of a group still in the document (shown or not). */
  allMembers(group: ClashGroup): ClashRecord[] {
    this.ensureIndex();
    return ClashGroups.members(group, this.byId);
  }

  /** After a group change: stored (live: written now), list and card rebuilt. */
  changed(): void {
    this.clashes.changed();
    this.clashes.listDirty = true;
    this.clashes.panel.rowsDirty = true;
  }

  // #endregion

  // #region Picking

  /** A click on a group row: plain = select its shown members and show the group card; Ctrl = add / remove them. */
  clickGroupRow(group: ClashGroup, ctrl: boolean): void {
    const clashes = this.clashes, session = this.session;
    const members = this.shownMembers(group);
    if (members.length === 0) { return; }
    const animate = !session.settings.clashInstantFly;
    session.sound.play(SoundId.UiClick);
    if (!ctrl) {
      if (members.length === 1) { clashes.goTo(members[0], animate); }
      else { clashes.selectMany(members, members[0], animate); }
      this.picks.length = 0;
      this.picks.push(group);
      this.current = group;
      this.refreshCard();
      return;
    }

    // Ctrl: the group's members in or out of the selection (starting from the clash on screen)
    const keep = [...this.picks];
    const all = clashes.toggleMany(members);
    if (all) { keep.splice(keep.indexOf(group), 1); } else if (!keep.includes(group)) { keep.push(group); }
    this.current = null;
    this.picks.length = 0;
    this.picks.push(...keep); // goTo may have cleared them
    if (clashes.selectedCount > 1) {
      session.toast(`${clashes.selectedCount} clashes together · right-click a group row to merge the picked groups`, 2.5);
    }
  }

  /** The chevron: a group's members shown or hidden in the list. */
  toggleExpanded(group: ClashGroup): void {
    if (!this.expanded.delete(group.id)) { this.expanded.add(group.id); }
    this.session.sound.play(SoundId.UiClick);
    this.clashes.listDirty = true;
  }

  /** COLLAPSE GROUP from a member's menu: the group folds and its row is kept in view. */
  private collapseFrom(group: ClashGroup): void {
    this.expanded.delete(group.id);
    this.session.sound.play(SoundId.UiClick);
    this.clashes.listDirty = true;
    this.clashes.scrollToCurrent = true;
  }

  /** SHOW ▾: all, groups only or ungrouped only. */
  setFilter(filter: number): void {
    this.filter = Math.min(Math.max(filter, 0), CLASH_SHOW_LABELS.length - 1);
    this.clashes.listDirty = true;
    this.clashes.listScroll.reset();
  }

  /** The groups picked for MERGE: those clicked whose shown members are all still selected, plus the right-clicked one. */
  private pickedGroups(clicked: ClashGroup): ClashGroup[] {
    const clashes = this.clashes, groups: ClashGroup[] = [];
    for (const group of this.picks) {
      if (group.testId !== clashes.reviewTest || !(this.document.groups ?? []).includes(group)) { continue; }
      if (group !== clicked && !this.shownMembers(group).every(c => clashes.selectedCount > 1 && clashes.isSelectedClash(c))) { continue; }
      groups.push(group);
    }
    if (!groups.includes(clicked)) { groups.unshift(clicked); }
    return groups;
  }

  /** The clashes a menu on a clash row acts on: the selection when the row is in it, else that clash. */
  private menuTargets(clash: ClashRecord): ClashRecord[] {
    return this.clashes.multiActive && this.clashes.isSelectedClash(clash) ? [...this.clashes.selection] : [clash];
  }

  // #endregion

  // #region Right-click menu

  /** Opens the right-click menu for a row (after the dock is drawn), at the mouse, kept inside the dock. */
  openRowMenu(row: ClashDisplayRow, at: [number, number]): void {
    const clashes = this.clashes, labels: string[] = [], actions: (() => void)[] = [];
    const item = (label: string, action: () => void) => { labels.push(label); actions.push(action); };
    if (!row.row) {
      const group = row.group!;
      const picked = this.pickedGroups(group);
      if (picked.length >= 2) { item(`MERGE ${picked.length} GROUPS (INTO “${shorten(ClashGroups.displayName(picked[0]), 28)}”)`, () => this.merge(picked)); }
      const outside = clashes.multiActive ? clashes.selection.filter(c => this.groupOf(c) !== group).length : 0;
      if (outside > 0) { item(`ADD THE ${outside} SELECTED TO THIS GROUP`, () => this.addTo(group, [...clashes.selection])); }
      item('RENAME…', () => this.rename(group));
      item('EDIT BOX…', () => clashes.tools.beginBox(group)); // C-C2: a group without a box starts with one round its members
      if (group.box) { item('RECOLLECT FROM ITS BOX', () => clashes.tools.recollect(group, null)); }
      item(this.expanded.has(group.id) ? 'COLLAPSE' : 'EXPAND', () => this.toggleExpanded(group));
      item('UNGROUP (CLASHES STAY)', () => this.ungroup(group));
    } else {
      const clash = row.row.clash;
      const targets = this.menuTargets(clash);
      item(targets.length > 1 ? `GROUP SELECTED (${targets.length})` : 'NEW GROUP (THIS CLASH)', () => this.groupClashes(targets, null));
      if (this.groupsInTest > 0) { item(targets.length > 1 ? `ADD ${targets.length} TO GROUP ›` : 'ADD TO GROUP ›', () => this.openAddToMenu(targets, at)); }
      const grouped = targets.filter(c => this.groupOf(c) !== null).length;
      if (grouped > 0) { item(grouped > 1 ? `REMOVE ${grouped} FROM THEIR GROUPS` : 'REMOVE FROM GROUP', () => this.removeFromGroups(targets)); }
      const own = this.groupOf(clash);
      if (own && this.expanded.has(own.id)) { item(`COLLAPSE GROUP “${shorten(ClashGroups.displayName(own), 30)}”`, () => this.collapseFrom(own)); }
      item('CLUSTER AROUND THIS…', () => clashes.tools.beginSphere(clash)); // C-C2
      item(`GROUP ALL ON ${shorten(ClashGroups.elementName(clash.a), 34)}`, () => this.groupAllOn(clash.a));
      if (elementRefKey(clash.b) !== elementRefKey(clash.a)) { item(`GROUP ALL ON ${shorten(ClashGroups.elementName(clash.b), 34)}`, () => this.groupAllOn(clash.b)); }
    }
    this.openMenu(DROP_DOCK_MENU, labels, at, i => actions[i]());
  }

  /** ADD TO GROUP ›: the test's groups as a second list (largest first). */
  private openAddToMenu(targets: ClashRecord[], at: [number, number]): void {
    const groups = ClashGroups.ofTest(this.document, this.clashes.reviewTest ?? '').sort((a, b) => b.clashIds.length - a.clashIds.length);
    if (groups.length === 0) { return; }
    this.openMenu(DROP_DOCK_ADD_TO, groups.map(g => `${shorten(ClashGroups.displayName(g), 40)} (${g.clashIds.length})`), at, i => this.addTo(groups[i], targets));
  }

  private openMenu(slot: number, labels: string[], at: [number, number], pick: (i: number) => void): void {
    const [dx, , dw] = this.clashes.dockRect;
    const w = Math.min(this.s(340), dw - this.s(20));
    const x = Math.min(Math.max(at[0], dx + this.s(6)), dx + dw - w - this.s(6));
    this.session.menu.overlays.openDropdown(this.clashes.list, slot, x, at[1], w, 0, labels, -1, pick);
  }

  // #endregion

  // #region Actions

  /**
   * GROUP / Ctrl+G / the menu: the clashes become a new group (each leaves its old group), named after the element they
   * all share when several share one, else "Group N" (or an automatic label).
   */
  groupClashes(clashList: readonly ClashRecord[], keyElement: ClashElementRef | null, autoLabel: string | null = null): ClashGroup | null {
    const session = this.session, document = this.clashes.document;
    if (!document) { return null; }
    if (clashList.length === 0) {
      session.sound.play(SoundId.Error);
      session.toast('Pick clashes first (click, Ctrl / Shift click or a group row)', 2.5);
      return null;
    }
    const already = this.groupOf(clashList[0]);
    if (already && already.clashIds.length === clashList.length && clashList.every(c => this.groupOf(c) === already)) {
      session.sound.play(SoundId.Error);
      session.toast(`Those clashes are already the group “${ClashGroups.displayName(already)}”`, 2.5);
      return null;
    }
    if (autoLabel === null) { keyElement ??= clashList.length > 1 ? ClashGroups.commonElement(clashList) : null; }
    const { group, moved } = ClashGroups.create(document, this.clashes.reviewTest ?? '', clashList, null, keyElement, autoLabel, null, this.user, this.now);
    if (!group) { return null; }
    this.expanded.add(group.id);
    this.changed();
    this.clashes.refreshList();
    this.current = group;
    this.picks.length = 0;
    this.picks.push(group);
    this.refreshCard();
    session.sound.play(SoundId.Commit);
    session.toast(`Grouped ${plural(group.clashIds.length, 'clash')}: “${ClashGroups.displayName(group)}”` + (moved > 0 ? ` (${moved} moved from other groups)` : '')
      + ' · right-click the row to rename', 3);
    return group;
  }

  /** GROUP ALL ON <element>: every unresolved clash of the test with that element (filters aside). */
  private groupAllOn(element: ClashElementRef): void {
    const found = ClashGrouping.forElement(this.document, this.clashes.reviewTest ?? '', elementRefKey(element));
    if (found.length === 0) {
      this.session.sound.play(SoundId.Error);
      this.session.toast('No open clash of this test has that element', 2.5);
      return;
    }
    this.groupClashes(found, element);
  }

  /** ADD TO GROUP: the clashes join a group (each leaves its old group). */
  addTo(group: ClashGroup, clashList: readonly ClashRecord[]): void {
    const { added, moved } = ClashGroups.addTo(this.document, group, clashList, this.user, this.now);
    if (added === 0) {
      this.session.toast('Already in that group', 2);
      return;
    }
    this.changed();
    this.session.sound.play(SoundId.Commit);
    this.session.toast(`${added} added to “${ClashGroups.displayName(group)}”` + (moved > 0 ? ` (${moved} moved from other groups)` : ''), 2.5);
  }

  /** REMOVE FROM GROUP: the clashes leave their groups (a group left empty goes). */
  removeFromGroups(clashList: readonly ClashRecord[]): void {
    const removed = ClashGroups.remove(this.document, clashList);
    if (removed === 0) { return; }
    this.changed();
    this.session.sound.play(SoundId.Remove);
    this.session.toast(`${plural(removed, 'clash')} taken out of ${removed === 1 ? 'its group' : 'their groups'}`, 2.5);
  }

  /** UNGROUP: the group goes, its clashes stay (ungrouped). Its comment, if any, stays as it is. */
  private ungroup(group: ClashGroup): void {
    const name = ClashGroups.displayName(group), count = group.clashIds.length;
    if (!ClashGroups.ungroup(this.document, group)) { return; }
    if (this.current === group) { this.current = null; }
    this.expanded.delete(group.id);
    this.changed();
    this.session.sound.play(SoundId.Remove);
    this.session.toast(`Ungrouped “${name}” (its ${plural(count, 'clash')} stay)`, 2.5);
  }

  /** Ctrl+Shift+G / UNGROUP: the group on the card goes; else the selected clashes leave their groups. */
  ungroupFromKeys(): void {
    if (this.current) {
      this.ungroup(this.current);
      return;
    }
    const targets = [...this.clashes.targetClashes()];
    if (!targets.some(c => this.groupOf(c) !== null)) {
      this.session.sound.play(SoundId.Error);
      this.session.toast('Nothing grouped is picked (click a group row, or select grouped clashes)', 2.5);
      return;
    }
    this.removeFromGroups(targets);
  }

  /** MERGE GROUPS: the first picked takes the others' members (its name, status, assignee and notes stay). */
  private merge(groups: ClashGroup[]): void {
    const total = groups.reduce((n, g) => n + g.clashIds.length, 0);
    const merged = ClashGroups.merge(this.document, groups, this.user, this.now);
    if (!merged) { return; }
    for (const group of groups) { if (group !== merged) { this.expanded.delete(group.id); } }
    this.changed();
    this.clashes.refreshList();
    this.current = merged;
    this.picks.length = 0;
    this.picks.push(merged);
    this.refreshCard();
    this.session.sound.play(SoundId.Commit);
    const otherComments = groups.some(g => g !== merged && g.commentId);
    this.session.toast(`${groups.length} groups merged into “${ClashGroups.displayName(merged)}” (${total} clashes)`
      + (otherComments ? ' · the other groups\' comments stay as they were' : ''), 3);
  }

  /** RENAME…: an empty name goes back to the automatic one. */
  private rename(group: ClashGroup): void {
    this.session.editor.beginCustom('RENAME GROUP (empty = automatic name)', group.name ?? '', 80, text => {
      ClashGroups.rename(this.document, group, text, this.user, this.now);
      this.changed();
      this.syncGroupComment(group, true);
      this.session.toast(`Group: “${ClashGroups.displayName(group)}”`, 2);
    });
  }

  /** TOOLS ▾ (C-C2): the grouping tools, an automatic method over the test's ungrouped open clashes, or removing them. */
  runToolAction(action: number): void {
    const session = this.session, clashes = this.clashes, document = clashes.document, test = clashes.reviewTest;
    if (!document || !test) { return; }
    switch (action) {
      case TOOL_BOX: clashes.tools.beginBox(null); return;
      case TOOL_PICK: clashes.tools.beginPick(); return;
      case TOOL_CLUSTER: clashes.tools.beginSphere(clashes.current); return;
      case TOOL_REMOVE_AUTO: this.removeAutomatic(); return;
    }
    let method: string;
    let made: ClashGroup[];
    const user = this.user, utc = this.now;
    switch (action) {
      case TOOL_AUTO_LEVEL:
        method = 'by level';
        made = ClashGrouping.byLevel(document, test, ClashGrouping.MIN_SIZE, user, utc);
        break;
      case TOOL_AUTO_CATEGORY:
        method = 'by category pair';
        made = ClashGrouping.byCategoryPair(document, test, false, ClashGrouping.MIN_SIZE, user, utc);
        break;
      case TOOL_AUTO_LEVEL_CATEGORY:
        method = 'by level + category pair';
        made = ClashGrouping.byCategoryPair(document, test, true, ClashGrouping.MIN_SIZE, user, utc);
        break;
      case TOOL_AUTO_GRID:
      case TOOL_AUTO_GRID_LEVEL: {
        // Grids round B: the nearest grid intersection (and its level)
        if (!session.grids.clashFunction()) {
          session.sound.play(SoundId.Error);
          session.toast('AUTO by grid: this model has no grid intersections (or the snapshot is older than grids: export again / F5)', 4);
          return;
        }
        const perLevel = action === TOOL_AUTO_GRID_LEVEL;
        method = perLevel ? 'by grid + level' : 'by grid';
        made = ClashGrouping.byGrid(document, test, c => session.grids.clashLocation(c), perLevel, ClashGrouping.MIN_SIZE, user, utc);
        break;
      }
      default:
        method = 'by element';
        made = ClashGrouping.byElement(document, test, ClashGrouping.MIN_SIZE, user, utc);
        break;
    }
    const index = ClashGroups.index(document); // with the new groups
    const left = document.clashes.filter(c => c.testId === test && c.status !== ClashStatus.RESOLVED && !index.has(c.id)).length;
    if (made.length === 0) {
      session.sound.play(SoundId.Error);
      session.toast(`AUTO ${method}: no ${ClashGrouping.MIN_SIZE}+ ungrouped open clashes share one (${left.toLocaleString('en')} left ungrouped)`, 3);
      return;
    }
    const grouped = made.reduce((n, g) => n + g.clashIds.length, 0);
    this.changed();
    session.sound.play(SoundId.Commit);
    session.toast(`AUTO ${method}: ${plural(made.length, 'group', 'groups')} (${grouped.toLocaleString('en')} clashes) · `
      + `${left.toLocaleString('en')} open clashes left ungrouped (grouped ones were left alone)`, 4);
  }

  /** REMOVE AUTOMATIC GROUPS: the test's automatic groups go (their clashes stay; hand-made groups kept). */
  private removeAutomatic(): void {
    const document = this.document, test = this.clashes.reviewTest;
    const before = document.groups?.length ?? 0;
    if (document.groups) {
      document.groups = document.groups.filter(g => !(g.testId === test && g.auto !== null));
      if (document.groups.length === 0) { document.groups = null; }
    }
    const removed = before - (document.groups?.length ?? 0);
    if (removed === 0) {
      this.session.toast('This test has no automatic groups', 2);
      return;
    }
    if (this.current && !(document.groups ?? []).includes(this.current)) { this.current = null; }
    this.changed();
    this.session.sound.play(SoundId.Remove);
    this.session.toast(`${plural(removed, 'automatic group', 'automatic groups')} removed (their clashes stay; hand-made groups kept)`, 3);
  }

  /** 1–5 / the group card's chips: the group's status and every member's (their comments follow). */
  setGroupStatus(group: ClashGroup, status: string): void {
    this.ensureIndex();
    if (group.status === status && !ClashGroups.summarise(group, this.byId).mixed) { return; }
    const changed = ClashGroups.setStatus(group, status, this.byId, this.user, this.now);
    for (const clash of changed) { this.clashes.syncComment(clash); }
    this.syncGroupComment(group, false);
    this.changed();
    this.session.sound.play(SoundId.UiClick);
    this.session.toast(`Group ${ClashStatus.label(status).toLowerCase()} (${plural(group.clashIds.length, 'clash')})`, 1.8);
  }

  /** ASSIGN… on the group card: the group's and every member's assignee (comments follow). */
  private beginAssign(group: ClashGroup): void {
    const session = this.session;
    session.editor.beginCustom('ASSIGN GROUP TO (empty = unassigned; every member too)', group.assignedTo, 60, text => {
      const members = ClashGroups.setAssignee(group, text, this.byId, this.user, this.now);
      for (const clash of members) {
        const comment = this.clashes.findComment(clash);
        if (comment) { session.comments.setIssue(comment, { assignedTo: text }); }
      }
      const own = this.findComment(group);
      if (own) { session.comments.setIssue(own, { assignedTo: text }); }
      this.changed();
      session.toast(text.length === 0 ? 'Group unassigned' : `Group assigned to ${text}`, 2);
    });
  }

  /** NOTES… on the group card: the group's own notes. */
  private beginNotes(group: ClashGroup): void {
    this.session.editor.beginCustom('GROUP NOTES (empty clears)', group.notes, 280, text => {
      ClashGroups.setNotes(group, text, this.user, this.now);
      this.changed();
      this.session.toast(text.length === 0 ? 'Group notes cleared' : 'Group notes saved', 2);
    });
  }

  // #endregion

  // #region Drawing

  /** The group card (in place of the clash details): header with MIXED, name, counts, status 1–5, ASSIGN… and NOTES…. */
  buildCard(f: FontAtlas, input: InputState, x: number, y: number, w: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, group = this.current!;
    let cy = y;
    const used = ui.text(f.small, x, cy, this.cardHeader ?? 'GROUP', UiTheme.TEXT_MUTED, this.s(1.2));
    if (this.cardMixed) { ui.text(f.small, x + used + this.s(10), cy, 'MIXED', Rgba.hex(0xf59e0b), this.s(1.2)); }
    cy += this.s(20);
    ui.textWrapped(f.body, x, cy, w, ClashGroups.displayName(group), UiTheme.TEXT, 1);
    cy += this.s(22);
    ui.textWrapped(f.small, x, cy, w, this.cardCounts ?? '', UiTheme.TEXT_MUTED, 3);
    cy += this.s(54);

    const chip = (w - this.s(4) * 4) / 5;
    for (let k = 0; k < ClashStatus.ALL.length; k++) {
      const status = ClashStatus.ALL[k];
      const bx = x + k * (chip + this.s(4));
      const on = group.status === status;
      const hover = wd.hover(bx, cy, chip, this.s(28));
      ui.rect(bx, cy, chip, this.s(28), on ? clashStatusColour(status) : hover ? Rgba.hex(0xffffff, 0.1) : UiTheme.CONTROL);
      ui.outline(bx, cy, chip, this.s(28), Math.max(1, ui.scale), on ? clashStatusColour(status) : UiTheme.CONTROL_BORDER);
      ui.textCentred(f.small, bx + chip * 0.5, cy + this.s(7), CLASH_STATUS_SHORT[k], on ? Rgba.hex(0x111827) : UiTheme.TEXT);
      if (hover && input.leftPressed && (!on || this.cardMixed)) {
        input.consumeClicks();
        this.setGroupStatus(group, status);
      }
    }
    cy += this.s(34);
    const half = (w - this.s(6)) * 0.5;
    if (wd.smallButton(f, x, cy, half, this.s(28), this.cardAssign ?? 'ASSIGN…')) { this.beginAssign(group); }
    if (wd.smallButton(f, x + half + this.s(6), cy, half, this.s(28), this.cardNotes ?? 'NOTES…')) { this.beginNotes(group); }
  }

  /**
   * A group row (C-C1): a chevron (expand / collapse), the first shown member's picture stacked (pictures on), the
   * group's status and MIXED, its name and counts. Picked when it is the card's group or its members are selected.
   */
  buildGroupRow(f: FontAtlas, input: InputState, line: ClashDisplayRow, x: number, ry: number, w: number, rowH: number, pictures: boolean,
    thumbW: number, thumbH: number, hover: boolean): void {
    const session = this.session, ui = session.ui, clashes = this.clashes, group = line.group!;
    const current = group === this.current || (this.picks.includes(group) && clashes.multiActive);
    const h = rowH - this.s(4);
    ui.rect(x, ry, w, h, current ? Rgba.hex(0x22d3ee, 0.18) : hover ? Rgba.hex(0xffffff, 0.1) : Rgba.hex(0xffffff, 0.06));
    ui.rect(x, ry, this.s(4), h, clashStatusColour(group.status));
    ui.outline(x, ry, w, h, Math.max(1, ui.scale), current ? UiTheme.ACCENT : Rgba.hex(0xffffff, 0.14));

    // The chevron: right when collapsed, down when expanded
    const open = this.expanded.has(group.id);
    const cw = this.s(26), ccx = x + this.s(4) + cw * 0.5, ccy = ry + h * 0.5, r = this.s(5);
    const chevronHover = session.menu.widgets.hover(x + this.s(4), ry, cw, h);
    const chevronColour = chevronHover ? UiTheme.ACCENT : UiTheme.TEXT_SOFT;
    if (open) { ui.triangle(ccx - r, ccy - r * 0.5, ccx + r, ccy - r * 0.5, ccx, ccy + r * 0.6, chevronColour); }
    else { ui.triangle(ccx - r * 0.5, ccy - r, ccx - r * 0.5, ccy + r, ccx + r * 0.6, ccy, chevronColour); }

    let tx = x + this.s(4) + cw;
    const comment = this.findComment(group);
    if (pictures) {
      // Two offset frames behind the first member's picture read as "several"
      const px = tx, py = ry + this.s(3), pw = thumbW - this.s(8), ph = thumbH - this.s(6);
      ui.outline(px + this.s(8), py, pw, ph, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.2));
      ui.outline(px + this.s(4), py + this.s(3), pw, ph, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.3));
      clashes.drawRowPicture(f, line.first, px, py + this.s(6), pw, ph);
      if (clashes.commentPencil(input, px + pw - this.s(14), py + this.s(6) + this.s(14), comment)) { this.markupClick = group; }
      tx = px + thumbW + this.s(6);
    }
    const tw = x + w - this.s(8) - tx;
    let after = tx + ui.text(f.small, tx, ry + this.s(5), line.status, clashStatusColour(group.status)) + this.s(8);
    if (line.mixed) { after += ui.text(f.small, after, ry + this.s(5), 'MIXED', Rgba.hex(0xf59e0b)) + this.s(8); }
    const tagW = ui.textRight(f.small, x + w - this.s(8), ry + this.s(5), 'GROUP', UiTheme.TEXT_FAINT);
    if (pictures) {
      ui.textWrapped(f.body, tx, ry + this.s(22), tw, line.title, UiTheme.TEXT, 2);
      ui.textWrapped(f.small, tx, ry + this.s(62), tw, line.detail, UiTheme.TEXT_MUTED, 2);
    } else {
      const detailW = x + w - this.s(16) - tagW - after;
      if (detailW > this.s(40)) { ui.textWrapped(f.small, after, ry + this.s(5), detailW, line.detail, UiTheme.TEXT_MUTED, 1); }
      if (clashes.commentPencil(input, x + w - this.s(20), ry + this.s(32), comment)) { this.markupClick = group; }
      ui.textWrapped(f.body, tx, ry + this.s(23), tw - (comment ? this.s(30) : 0), line.title, UiTheme.TEXT, 1);
    }
    if (hover && input.leftPressed) {
      input.consumeClicks();
      if (chevronHover) { this.chevron = group; } else { this.groupClick = group; }
    }
  }

  // #endregion

  // #region Group comment

  /** The group's comment, or null. */
  findComment(group: ClashGroup | null): CommentRecord | null {
    return group?.commentId ? this.session.comments.find(group.commentId) : null;
  }

  /**
   * TO COMMENT on a group: one comment for every member. When it is the group's first comment and members already have
   * their own: LINK (theirs stay, the group's lists them), REPLACE (theirs are closed, pointing here) or CANCEL. An
   * existing group comment is updated (a marked-up picture only after a confirm).
   */
  toComment(group: ClashGroup): void {
    const overlays = this.session.menu.overlays;
    const members = this.allMembers(group);
    if (members.length === 0) { return; }
    const own = this.findComment(group);
    if (own) {
      if (hasMarkup(own)) {
        overlays.openChoice('UPDATE GROUP COMMENT?', 'The group\'s comment picture has markup. UPDATE refreshes its view, status and text and keeps the marked-up picture; tick to replace it.',
          'UPDATE', false, 'Replace the marked-up picture', null, replace => this.queueComment(group, GROUP_COMMENT_KEEP, replace), () => {});
        return;
      }
      this.queueComment(group, GROUP_COMMENT_KEEP, true);
      return;
    }
    const theirs = members.filter(c => this.clashes.findComment(c) !== null).length;
    if (theirs === 0) {
      this.queueComment(group, GROUP_COMMENT_KEEP, true);
      return;
    }
    overlays.openChoice('GROUP COMMENT', `${theirs} of the group's ${members.length} clashes already have their own comment. LINK keeps them and lists them in the group's comment; `
      + 'REPLACE closes them with a reply pointing to the group\'s comment (and unlinks them from their clashes).', 'LINK', false, null, 'REPLACE',
    () => this.queueComment(group, GROUP_COMMENT_LINK, true), () => this.queueComment(group, GROUP_COMMENT_REPLACE, true));
  }

  /** MARKUP on the group card: the markup editor on the group comment's picture (back to clash mode after). */
  openMarkup(group: ClashGroup): void {
    const session = this.session, comment = this.findComment(group);
    if (!comment || (!comment.snapshotData && !comment.snapshotOriginalData)) {
      session.sound.play(SoundId.Error);
      session.toast(!comment ? 'This group has no comment yet: GROUP TO COMMENT makes one (with its picture)'
        : 'The group\'s comment has no picture: UPDATE GROUP COMMENT takes one', 3);
      return;
    }
    session.markup.show(comment, true);
  }

  private queueComment(group: ClashGroup, mode: number, replaceMarkup: boolean): void {
    this.commentPending = group;
    this.commentMode = mode;
    this.commentReplaceMarkup = replaceMarkup;
  }

  /** The pending group comment (start of a frame): framed on every member, then made or updated. */
  makePendingComment(): void {
    const session = this.session, group = this.commentPending;
    const mode = this.commentMode, replaceMarkup = this.commentReplaceMarkup;
    this.commentPending = null;
    const document = this.clashes.document;
    if (!group || !document || !(document.groups ?? []).includes(group)) { return; }
    const members = this.allMembers(group);
    if (members.length === 0) { return; }
    const shot = this.clashes.renderGroupPicture(members, SHOT_W, SHOT_H);
    if (!shot) {
      session.sound.play(SoundId.Error);
      session.toast('The group picture couldn\'t be taken (see the browser console)', 3, true);
      return;
    }
    const { created, replaced } = this.makeComment(group, members, shot, mode, replaceMarkup);
    this.changed();
    session.sound.play(SoundId.Commit);
    session.toast((created ? `Group comment made (${members.length} clashes, every element listed)` : 'Group comment updated: new picture, view, status and text')
      + (replaced > 0 ? ` · ${replaced} member comment${replaced === 1 ? '' : 's'} closed, pointing to it` : '') + ' (Esc → COMMENTS · EXPORT BCF)', 3.5);
  }

  /**
   * Makes or updates the group's comment from the rendered picture: text, status from the group, priority high when any
   * member is a deep hard crossing, the group's assignee, the view and section; LINK / REPLACE for members' comments.
   */
  private makeComment(group: ClashGroup, members: ClashRecord[], shot: { pixels: Uint8Array; frame: { eye: { x: number; y: number; z: number }; yaw: number; pitch: number };
    cut: import('../../core/scene/SectionCut').SectionCut; centre: { x: number; y: number; z: number } }, mode: number, replaceMarkup: boolean): { created: boolean; replaced: number } {
    const session = this.session, comments = session.comments;
    const test = findTest(this.document, group.testId);
    const status = ClashCommentRules.commentStatusFor(group.status);
    const priority = members.some(c => ClashCommentRules.priorityFor(c, test?.kind ?? ClashKind.HARD) === CommentPriority.HIGH) ? CommentPriority.HIGH : CommentPriority.NORMAL;
    let replaced = 0;

    // REPLACE: members' comments are closed with a reply pointing here, and unlinked from their clashes
    if (mode === GROUP_COMMENT_REPLACE) {
      const name = ClashGroups.displayName(group);
      for (const clash of members) {
        const theirs = this.clashes.findComment(clash);
        if (!theirs) { continue; }
        comments.setIssue(theirs, { status: CommentStatus.CLOSED });
        comments.addReply(theirs, `Replaced by the group comment “${name}”.`);
        clash.commentId = null;
        replaced++;
      }
    }

    const text = this.commentText(group, test, members);
    let record = this.findComment(group);
    const created = record === null;
    if (!record) {
      const key = group.keyElement;
      const host = key !== null && !key.link && key.cloneKey === 0;
      record = comments.add(vec3(shot.centre.x, shot.centre.y, shot.centre.z), text, host ? key!.elementId : -1, clashLevel(members[0]), host ? key!.uniqueId : null);
      record.clashId = group.id; // C-C1: a group comment holds the group's id
      comments.setIssue(record, { status, priority, assignedTo: group.assignedTo?.trim() ?? '' });
      group.commentId = record.id;
    } else {
      comments.setIssue(record, { status, priority, assignedTo: group.assignedTo ?? '' });
      record.clashId ??= group.id;
      if (record.text !== text) { comments.update(record, text); }
    }
    const stand = session.player.controller.standEye;
    comments.setView(record, vec3(shot.frame.eye.x, shot.frame.eye.y, shot.frame.eye.z - stand), shot.frame.yaw, shot.frame.pitch, true, shot.cut);
    if (!hasMarkup(record) || replaceMarkup) {
      const canvas = pixelsCanvas(shot.pixels, SHOT_W, SHOT_H);
      const thumb = document.createElement('canvas');
      thumb.width = COMMENT_THUMB_W;
      thumb.height = COMMENT_THUMB_H;
      const context = thumb.getContext('2d')!;
      context.imageSmoothingQuality = 'high';
      context.drawImage(canvas, 0, 0, COMMENT_THUMB_W, COMMENT_THUMB_H);
      const thumbnail = thumb.toDataURL('image/jpeg', 0.72).replace(/^data:image\/jpeg;base64,/, '');
      comments.setPictures(record, thumbnail, base64Bytes(canvas.toDataURL('image/jpeg', 0.82).replace(/^data:image\/jpeg;base64,/, '')));
    }
    return { created, replaced };
  }

  /** "Clash group: test · name · 7 clashes · Level 1, Level 2 · Elements: … · Near … · Notes: … · Linked clash comments: …". */
  private commentText(group: ClashGroup, test: ClashTest | null, members: ClashRecord[]): string {
    const MAX_ELEMENTS = 24, MAX_LINKED = 10;
    const levels: string[] = [], elements: string[] = [], seen = new Set<string>();
    for (const clash of members) {
      const level = clashLevel(clash);
      if (!levels.includes(level)) { levels.push(level); }
      for (const element of [clash.a, clash.b]) {
        const key = elementRefKey(element);
        if (!seen.has(key)) {
          seen.add(key);
          elements.push(`${element.category} · ${ClashGroups.elementName(element)}`);
        }
      }
    }
    const elementText = elements.slice(0, MAX_ELEMENTS).join(', ') + (elements.length > MAX_ELEMENTS ? ` (+${elements.length - MAX_ELEMENTS} more)` : '');
    let text = `Clash group: ${test?.name ?? 'clash test'} · ${ClashGroups.displayName(group)} · ${plural(members.length, 'clash')} · ${levels.join(', ')} · Elements (${elements.length}): ${elementText}`;
    const grids = this.session.grids;
    if (grids.inClashComments) {
      // Grids round B: the members' grid locations (most common first, up to five)
      const counts = new Map<string, number>();
      for (const clash of members) {
        const location = grids.clashLocation(clash);
        if (location) { const t = gridLocationText(location); counts.set(t, (counts.get(t) ?? 0) + 1); }
      }
      const near = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(e => e[0]);
      if (near.length > 0) { text += ' · Near ' + near.slice(0, 5).join(', ') + (near.length > 5 ? ` (+${near.length - 5} more)` : ''); }
    }
    if (group.notes?.trim()) { text += ' · Notes: ' + group.notes.replace(/\n/g, ' ').trim(); }
    const linked = members.filter(c => this.clashes.findComment(c) !== null);
    if (linked.length > 0) {
      text += ` · Linked clash comments (${linked.length}): ` + linked.slice(0, MAX_LINKED).map(c => `${elementRefLabel(c.a)} × ${elementRefLabel(c.b)}`).join('; ')
        + (linked.length > MAX_LINKED ? ` (+${linked.length - MAX_LINKED} more)` : '');
    }
    return text;
  }

  /** The group's comment follows the group (status; with text, its name in the text too). True when it changed. */
  syncGroupComment(group: ClashGroup, text: boolean): boolean {
    const record = this.findComment(group);
    if (!record) { return false; }
    let changed = this.session.comments.setIssue(record, { status: ClashCommentRules.commentStatusFor(group.status) });
    if (text) {
      const updated = this.commentText(group, findTest(this.document, group.testId), this.allMembers(group));
      if (updated !== record.text) { changed = this.session.comments.update(record, updated) || changed; }
    }
    return changed;
  }

  /** After a run or an imported report: group comments follow their groups' statuses. */
  syncGroupComments(): void {
    for (const group of this.clashes.document?.groups ?? []) {
      if (group.commentId) { this.syncGroupComment(group, false); }
    }
  }

  // #endregion
}

/** "3 new, 2 active" (statuses with members only). */
function statusCounts(byStatus: readonly number[]): string {
  return byStatus.map((n, k) => (n > 0 ? `${n} ${ClashStatus.ALL[k]}` : '')).filter(Boolean).join(', ');
}
