import { el, writeXml, type XmlNode } from '../format/Xml';
import { type ClashGroup, ClashGrouping, ClashGroups } from './ClashGroups';
import {
  type ClashDocument, type ClashElementRef, ClashKind, type ClashRecord, ClashStatus, elementRefKey, elementRefLabel, findSet, findTest, isSelfTest
} from './ClashModels';

/** How groups appear in a report (Round C, build C-C3). */
export const ClashReportGroups = { SECTIONS: 0, COMPACT: 1, NONE: 2 } as const;

/** What a report says about itself and how it reads. */
export interface ClashReportOptions {
  title: string;
  modelTitle: string | null;
  generator: string | null;
  author: string | null;
  /** When it was made (shown as local time). */
  created: Date;
  scopeLabel: string | null;
  groupMode: number;
  /** Lengths as shown (the display units); null: metres to 3 decimals. */
  length: ((metres: number) => string) | null;
  /** Grids round B: a clash's grid location, or null (no grids). */
  gridLocation: ((clash: ClashRecord) => string | null) | null;
}

export function defaultReportOptions(): ClashReportOptions {
  return { title: 'Clash report', modelTitle: null, generator: null, author: null, created: new Date(), scopeLabel: null, groupMode: 0, length: null, gridLocation: null };
}

/** A report section: a group and its members, or (group null) the ungrouped clashes. */
export interface ClashReportSection { group: ClashGroup | null; clashes: ClashRecord[] }

/** One picture a report wants: a group's or a clash's, by id. */
export interface ClashReportPicture { id: string; group: ClashGroup | null; clash: ClashRecord | null }

const pad2 = (n: number) => String(n).padStart(2, '0');
const localStamp = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const localDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const n0 = (n: number) => n.toLocaleString('en-US');
const m3 = (v: number) => v.toFixed(3);
const H = (text: string | null | undefined) =>
  (text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const L = (o: ClashReportOptions, metres: number) => (o.length ? o.length(metres) : metres.toFixed(3) + ' m');
const num = (v: number) => {
  if (!Number.isFinite(v)) { return '0'; }
  let s = v.toFixed(6);
  if (s.includes('.')) { s = s.replace(/0+$/, '').replace(/\.$/, ''); }
  return s === '-0' ? '0' : s;
};
const kindLabel = (kind: string) => (ClashKind.normalise(kind) === ClashKind.CLEARANCE ? 'Clearance' : 'Hard');
const setName = (d: ClashDocument | null, id: string | null) => (d ? findSet(d, id)?.name : null) ?? '—';
const levelLabel = (c: ClashRecord) => { const l = ClashGrouping.levelOf(c); return l === '—' ? 'No level' : l; };

/** Strips the control characters XML can't hold. */
function xmlSafe(text: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  return (text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) { binary += String.fromCharCode(...bytes.subarray(i, i + chunk)); }
  return btoa(binary);
}

/**
 * Clash reports (Round C, build C-C3; port of ClashReports): a self-contained HTML page (cover and summary, a section
 * per group or one item per group, a card per clash; pictures embedded as JPEG data) and a Navisworks-style XML.
 */
export const ClashReports = {
  /** Groups in the order their first clash appears (members in the given order), then the ungrouped; NONE: one section. */
  sections(document: ClashDocument | null, clashes: readonly ClashRecord[], groupMode: number): ClashReportSection[] {
    const sections: ClashReportSection[] = [];
    if (!clashes || clashes.length === 0) { return sections; }
    if (groupMode === ClashReportGroups.NONE) { return [{ group: null, clashes: [...clashes] }]; }
    const index = ClashGroups.index(document);
    const byGroup = new Map<ClashGroup, ClashReportSection>();
    const loose: ClashReportSection = { group: null, clashes: [] };
    for (const clash of clashes) {
      if (!clash) { continue; }
      const group = index.get(clash.id);
      if (!group) { loose.clashes.push(clash); continue; }
      let section = byGroup.get(group);
      if (!section) {
        section = { group, clashes: [] };
        byGroup.set(group, section);
        sections.push(section);
      }
      section.clashes.push(clash);
    }
    if (loose.clashes.length > 0) { sections.push(loose); }
    return sections;
  },

  /** The pictures an HTML report shows, in report order. */
  pictures(document: ClashDocument | null, clashes: readonly ClashRecord[], groupMode: number): ClashReportPicture[] {
    const pictures: ClashReportPicture[] = [];
    for (const section of ClashReports.sections(document, clashes, groupMode)) {
      if (section.group) {
        pictures.push({ id: section.group.id, group: section.group, clash: null });
        if (groupMode === ClashReportGroups.COMPACT) { continue; }
      }
      for (const clash of section.clashes) { pictures.push({ id: clash.id, group: null, clash }); }
    }
    return pictures;
  },

  countByStatus(clashes: Iterable<ClashRecord>): number[] {
    const counts = new Array<number>(ClashStatus.ALL.length).fill(0);
    for (const clash of clashes) { counts[ClashStatus.indexOf(clash.status)]++; }
    return counts;
  },

  /** Counts per key, most first (ties by key, ordinal). */
  countBy(clashes: Iterable<ClashRecord>, keyOf: (c: ClashRecord) => string): [string, number][] {
    const counts = new Map<string, number>();
    for (const clash of clashes) {
      const key = keyOf(clash);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].sort((p, q) => (q[1] !== p[1] ? q[1] - p[1] : p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
  },

  /** "3 new, 2 active" (statuses with clashes only). */
  statusCounts(byStatus: readonly number[]): string {
    return byStatus.map((n, k) => (n > 0 ? `${n0(n)} ${ClashStatus.ALL[k]}` : null)).filter(s => s !== null).join(', ');
  },

  /** The HTML report (one self-contained page). pictures: JPEG bytes by clash or group id; comments: text by id. */
  html(document: ClashDocument | null, clashes: readonly ClashRecord[], options: ClashReportOptions,
    pictures: ReadonlyMap<string, Uint8Array> | null = null, comments: ReadonlyMap<string, string> | null = null): string {
    const o = options;
    const out: string[] = [];
    const title = `${o.title} · ${o.modelTitle}`;
    out.push('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n',
      '<title>', H(title), '</title>\n<style>\n', CSS, '</style>\n</head>\n<body>\n');
    writeCover(out, document, clashes, o);
    let number = 0;
    for (const section of ClashReports.sections(document, clashes, o.groupMode)) {
      if (section.group) {
        out.push('<section class="group">\n');
        writeGroupHeader(out, document, section, o, pictures, comments, o.groupMode === ClashReportGroups.COMPACT);
        if (o.groupMode !== ClashReportGroups.COMPACT) {
          for (const clash of section.clashes) { writeClashCard(out, document, clash, ++number, o, pictures, comments, true); }
        } else {
          number += section.clashes.length;
        }
        out.push('</section>\n');
        continue;
      }
      out.push('<section class="loose">\n');
      if (o.groupMode !== ClashReportGroups.NONE) {
        out.push('<h2>Ungrouped clashes <span class="muted">(', n0(section.clashes.length), ')</span></h2>\n');
      }
      for (const clash of section.clashes) { writeClashCard(out, document, clash, ++number, o, pictures, comments, false); }
      out.push('</section>\n');
    }
    if (clashes.length === 0) { out.push('<p class="muted">No clashes in this report.</p>\n'); }
    out.push('<footer>', H(o.generator ?? 'BimGo'), ' · ', H(localStamp(o.created)), '</footer>\n</body>\n</html>\n');
    return out.join('');
  },

  /** The Navisworks-style XML report: exchange → batchtest → clashtests → clashtest → clashresults (groups as clashgroup). */
  xml(document: ClashDocument | null, clashes: readonly ClashRecord[], options: ClashReportOptions, comments: ReadonlyMap<string, string> | null = null): string {
    const o = options;
    const E = (name: string, value: string | null | undefined) => el(name, null, xmlSafe(value));
    const A = (attrs: Record<string, string | null | undefined>) => {
      const r: Record<string, string> = {};
      for (const [k, v] of Object.entries(attrs)) { r[k] = xmlSafe(v); }
      return r;
    };
    const pos = (name: string, x: number, y: number, z: number) => el(name, { x: num(x), y: num(y), z: num(z) });
    const date = (name: string, iso: string) => {
      const t = new Date(iso);
      return el(name, null, el('date', {
        year: String(t.getUTCFullYear()), month: String(t.getUTCMonth() + 1), day: String(t.getUTCDate()), hour: String(t.getUTCHours()),
        minute: String(t.getUTCMinutes()), second: String(t.getUTCSeconds()), utc: 'true'
      }));
    };
    const commentsNode = (notes: string | null, id: string) => {
      const comment = comments?.get(id) ?? null;
      const hasNotes = !!notes && notes.trim().length > 0, hasComment = !!comment && comment.trim().length > 0;
      if (!hasNotes && !hasComment) { return null; }
      return el('comments', null,
        hasNotes ? el('comment', { kind: 'notes' }, E('body', notes)) : null,
        hasComment ? el('comment', { kind: 'comment' }, E('body', comment)) : null);
    };
    const object = (e: ClashElementRef) => el('clashobject', null,
      el('objectattribute', null, E('name', 'Element ID'), E('value', String(e.elementId))),
      E('layer', e.level && e.level.trim() ? e.level : ''),
      el('smarttags', null,
        tag('Item Name', e.familyType), tag('Category', e.category), tag('UniqueId', e.uniqueId),
        e.ifcGuid ? tag('IfcGUID', e.ifcGuid) : null, e.link ? tag('Link Instance UniqueId', e.link) : null,
        e.cloneKey > 0 ? tag('BimGo Clone', String(e.cloneKey)) : null));
    function tag(name: string, value: string | null) { return el('smarttag', null, E('name', name), E('value', value ?? '')); }
    let number = 0;
    const result = (c: ClashRecord): XmlNode => el('clashresult', A({
      name: 'Clash' + (++number), guid: c.id, status: ClashStatus.normalise(c.status), distance: num(c.crossing ? -Math.abs(c.distance) : c.distance),
      approximate: c.approximate ? 'true' : null
    }),
    E('description', c.crossing ? 'Hard' : 'Clearance'),
    E('resultstatus', ClashStatus.label(c.status)),
    el('clashpoint', null, pos('pos3f', c.x, c.y, c.z)),
    E('gridlocation', o.gridLocation?.(c) ?? ClashGrouping.levelOf(c)),
    date('createddate', c.foundUtc),
    date('lastseendate', c.lastSeenUtc),
    c.resolvedUtc ? date('resolveddate', c.resolvedUtc) : null,
    c.assignedTo && c.assignedTo.trim() ? E('assignedto', c.assignedTo) : null,
    commentsNode(c.notes, c.id),
    el('clashobjects', null, object(c.a), object(c.b)));
    const selection = (setId: string | null) => el('clashselection', { selfintersect: '0', primtypes: '1' }, E('locator', 'lcop_selection_set_tree/' + setName(document, setId)));

    const testIds: string[] = [];
    for (const c of clashes) { if (!testIds.includes(c.testId)) { testIds.push(c.testId); } }
    const tests = testIds.map(testId => {
      const test = document ? findTest(document, testId) : null;
      const ofTest = clashes.filter(c => c.testId === testId);
      const byStatus = ClashReports.countByStatus(ofTest);
      const summaryAttrs: Record<string, string> = { total: String(ofTest.length) };
      byStatus.forEach((n, k) => { summaryAttrs[ClashStatus.ALL[k]] = String(n); });
      const results: XmlNode[] = [];
      for (const section of ClashReports.sections(document, ofTest, o.groupMode === ClashReportGroups.NONE ? ClashReportGroups.NONE : ClashReportGroups.SECTIONS)) {
        if (!section.group) { for (const c of section.clashes) { results.push(result(c)); } continue; }
        const g = section.group;
        results.push(el('clashgroup', A({ name: ClashGroups.displayName(g), guid: g.id, status: ClashStatus.normalise(g.status), count: String(section.clashes.length), auto: g.auto || null }),
          E('resultstatus', ClashStatus.label(g.status)),
          g.assignedTo && g.assignedTo.trim() ? E('assignedto', g.assignedTo) : null,
          commentsNode(g.notes, g.id),
          g.box ? el('box', { fullheight: g.box.fullHeight ? 'true' : 'false' }, pos('min', g.box.minX, g.box.minY, g.box.minZ), pos('max', g.box.maxX, g.box.maxY, g.box.maxZ)) : null,
          el('clashresults', null, ...section.clashes.map(result))));
      }
      return el('clashtest', A({
        name: test?.name ?? '(removed test)', guid: testId ?? '', test_type: test ? ClashKind.normalise(test.kind) : 'hard', status: 'ok', tolerance: num(test?.tolerance ?? 0)
      }),
      el('left', null, selection(test?.setA ?? null)),
      el('right', null, selection(!test || isSelfTest(test) ? test?.setA ?? null : test.setB)),
      el('summary', summaryAttrs, E('testtype', test ? kindLabel(test.kind) : 'Hard'), E('teststatus', 'OK')),
      el('clashresults', null, ...results));
    });
    const c = o.created;
    const created = `${c.getFullYear()}-${pad2(c.getMonth() + 1)}-${pad2(c.getDate())}T${pad2(c.getHours())}:${pad2(c.getMinutes())}:${pad2(c.getSeconds())}`;
    return writeXml(el('exchange', A({ units: 'm', filename: o.modelTitle ?? '', generator: o.generator ?? 'BimGo', author: o.author ?? '', created, scope: o.scopeLabel ?? '' }),
      el('batchtest', A({ name: o.title ?? 'Clash report', units: 'm' }), el('clashtests', null, ...tests))));
  }
};

function meta(out: string[], name: string, value: string | null | undefined): void {
  if (!value || !value.trim()) { return; }
  out.push('<dt>', H(name), '</dt><dd>', H(value).replace(/\n/g, '<br>'), '</dd>\n');
}

function statusPill(out: string[], status: string): void {
  const s = ClashStatus.normalise(status);
  out.push('<span class="pill s-', s, '">', H(ClashStatus.label(s)), '</span>');
}

function picture(out: string[], pictures: ReadonlyMap<string, Uint8Array> | null, id: string, alt: string): void {
  const jpeg = pictures?.get(id);
  if (!jpeg || jpeg.length === 0) { out.push('<div class="pic none"></div>\n'); return; }
  out.push('<img class="pic" alt="', H(alt), '" src="data:image/jpeg;base64,', toBase64(jpeg), '">\n');
}

function countTable(out: string[], caption: string, column: string, rows: [string, number][]): void {
  if (rows.length === 0) { return; }
  out.push('<table class="counts"><caption>', H(caption), '</caption><thead><tr><th>', H(column), '</th><th>Clashes</th></tr></thead><tbody>');
  for (const [key, count] of rows) { out.push('<tr><td>', H(key), '</td><td>', n0(count), '</td></tr>'); }
  out.push('</tbody></table>\n');
}

function writeCover(out: string[], document: ClashDocument | null, clashes: readonly ClashRecord[], o: ClashReportOptions): void {
  out.push('<header class="cover">\n<h1>', H(o.title), '</h1>\n<p class="model">', H(o.modelTitle ?? 'Model'), '</p>\n<dl>\n');
  meta(out, 'Scope', o.scopeLabel);
  meta(out, 'Created', localStamp(o.created));
  meta(out, 'By', o.author);
  meta(out, 'Clashes', n0(clashes.length));
  const groups = ClashReports.sections(document, clashes, ClashReportGroups.SECTIONS).filter(s => s.group).length;
  if (groups > 0) { meta(out, 'Groups', n0(groups)); }
  meta(out, 'Generator', o.generator);
  out.push('</dl>\n');
  const byStatus = ClashReports.countByStatus(clashes);
  out.push('<div class="chips">');
  byStatus.forEach((n, k) => {
    out.push('<span class="chip s-', ClashStatus.ALL[k], '"><b>', n0(n), '</b> ', H(ClashStatus.label(ClashStatus.ALL[k])), '</span>');
  });
  out.push('</div>\n<div class="tables">\n');
  countTable(out, 'By level', 'Level', ClashReports.countBy(clashes, levelLabel));
  countTable(out, 'By category pair', 'Pair', ClashReports.countBy(clashes, ClashGrouping.categoryPairOf).slice(0, 12));
  if (o.gridLocation) {
    countTable(out, 'By grid', 'Near', ClashReports.countBy(clashes, c => {
      const grid = o.gridLocation!(c);
      if (!grid) { return 'No grid'; }
      const colon = grid.indexOf(' : ');
      return colon > 0 ? grid.slice(0, colon) : grid;
    }).slice(0, 12));
  }
  out.push('</div>\n');
  const testIds: string[] = [];
  for (const c of clashes) { if (!testIds.includes(c.testId)) { testIds.push(c.testId); } }
  if (testIds.length > 0) {
    out.push('<h2>Tests</h2>\n<table class="tests"><thead><tr><th>Test</th><th>Kind</th><th>Tolerance</th><th>A</th><th>B</th><th>Last run</th><th>In report</th></tr></thead><tbody>\n');
    for (const id of testIds) {
      const test = document ? findTest(document, id) : null;
      const a = setName(document, test?.setA ?? null);
      const b = !test || isSelfTest(test) ? a + ' (itself)' : setName(document, test.setB);
      out.push('<tr><td>', H(test?.name ?? '(removed test)'), '</td><td>', H(test ? kindLabel(test.kind) : ''), '</td><td>', H(test ? L(o, test.tolerance) : ''),
        '</td><td>', H(a), '</td><td>', H(b), '</td><td>', H(test?.lastRunUtc ? localStamp(new Date(test.lastRunUtc)) : '—'),
        '</td><td>', n0(clashes.filter(c => c.testId === id).length), '</td></tr>\n');
    }
    out.push('</tbody></table>\n');
  }
  out.push('</header>\n');
}

function writeGroupHeader(out: string[], document: ClashDocument | null, section: ClashReportSection, o: ClashReportOptions,
  pictures: ReadonlyMap<string, Uint8Array> | null, comments: ReadonlyMap<string, string> | null, compact: boolean): void {
  const group = section.group!;
  const byStatus = ClashReports.countByStatus(section.clashes);
  const mixed = section.clashes.some(c => ClashStatus.normalise(c.status) !== ClashStatus.normalise(group.status));
  const name = ClashGroups.displayName(group);
  out.push('<div class="card grouphead">\n');
  picture(out, pictures, group.id, name);
  out.push('<div class="body">\n<div class="line"><span class="tag">GROUP</span>');
  statusPill(out, group.status);
  if (mixed) { out.push('<span class="pill mixed">Mixed</span>'); }
  out.push('</div>\n<h2>', H(name), '</h2>\n<dl>\n');
  const count = group.clashIds.length;
  meta(out, 'Clashes', section.clashes.length === count ? n0(count) : `${n0(section.clashes.length)} in this report of ${n0(count)}`);
  meta(out, 'Statuses', ClashReports.statusCounts(byStatus));
  meta(out, 'Test', document ? findTest(document, group.testId)?.name : null);
  meta(out, 'Assigned to', group.assignedTo);
  meta(out, 'Notes', group.notes);
  if (group.keyElement) { meta(out, 'All on', ClashGroups.elementName(group.keyElement)); }
  if (group.box) { meta(out, 'Box', group.box.fullHeight ? 'plan area, full height' : 'yes'); }
  if (compact) {
    meta(out, 'Levels', ClashReports.countBy(section.clashes, levelLabel).map(([k, n]) => `${k} (${n})`).join(', '));
    meta(out, 'Category pairs', ClashReports.countBy(section.clashes, ClashGrouping.categoryPairOf).slice(0, 8).map(([k, n]) => `${k} (${n})`).join(', '));
    const elements = new Set(section.clashes.flatMap(c => [elementRefKey(c.a), elementRefKey(c.b)])).size;
    meta(out, 'Elements', n0(elements));
    const deepest = section.clashes.filter(c => c.crossing).sort((p, q) => q.distance - p.distance)[0];
    if (deepest && deepest.distance > 0) { meta(out, 'Deepest', L(o, deepest.distance)); }
  }
  const comment = comments?.get(group.id);
  if (comment !== undefined) { meta(out, 'Comment', comment); }
  out.push('</dl>\n</div>\n</div>\n');
}

function writeClashCard(out: string[], document: ClashDocument | null, clash: ClashRecord, number: number, o: ClashReportOptions,
  pictures: ReadonlyMap<string, Uint8Array> | null, comments: ReadonlyMap<string, string> | null, inGroup: boolean): void {
  out.push('<div class="card', inGroup ? ' member' : '', '">\n');
  picture(out, pictures, clash.id, `Clash ${number}`);
  out.push('<div class="body">\n<div class="line"><span class="tag">CLASH ', String(number), '</span>');
  statusPill(out, clash.status);
  if (clash.approximate) { out.push('<span class="pill mixed">Approximate</span>'); }
  out.push('</div>\n<h3>', H(elementRefLabel(clash.a)), ' <span class="x">×</span> ', H(elementRefLabel(clash.b)), '</h3>\n');
  out.push('<table class="pair"><tbody>\n');
  pairRow(out, 'A', clash.a);
  pairRow(out, 'B', clash.b);
  out.push('</tbody></table>\n<dl>\n');
  meta(out, clash.crossing ? 'Crossing' : 'Gap', clash.crossing ? (clash.distance > 0 ? L(o, clash.distance) : 'yes') : clash.distance <= 0 ? 'touching' : L(o, clash.distance));
  meta(out, 'Level', ClashGrouping.levelOf(clash));
  meta(out, 'Grid', o.gridLocation?.(clash) ?? null);
  meta(out, 'Point (x, y, z)', `${m3(clash.x)}, ${m3(clash.y)}, ${m3(clash.z)} m`);
  if (!inGroup || o.groupMode === ClashReportGroups.NONE) { meta(out, 'Test', document ? findTest(document, clash.testId)?.name : null); }
  meta(out, 'Assigned to', clash.assignedTo);
  meta(out, 'Notes', clash.notes);
  meta(out, 'Found', localDay(clash.foundUtc) + ' · last seen ' + localDay(clash.lastSeenUtc) + (clash.resolvedUtc ? ' · resolved ' + localDay(clash.resolvedUtc) : ''));
  const comment = comments?.get(clash.id);
  if (comment !== undefined) { meta(out, 'Comment', comment); }
  out.push('</dl>\n</div>\n</div>\n');
}

function pairRow(out: string[], side: string, e: ClashElementRef): void {
  const id = e.cloneKey > 0 ? 'clone ' + e.cloneKey : e.elementId > 0 ? String(e.elementId) : '—';
  out.push('<tr><td class="side s', side, '">', side, '</td><td>', H(e.category), '</td><td>', H(e.familyType), '</td><td>', H(id), '</td><td>',
    H(e.level && e.level.trim() ? e.level : '—'), '</td><td>', e.link ? 'linked' : 'host', '</td></tr>\n');
}

const CSS = `:root{--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--bg:#ffffff;--soft:#f9fafb;--accent:#0891b2}
*{box-sizing:border-box}
body{margin:0 auto;max-width:1100px;padding:24px;font:14px/1.45 'Segoe UI',system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg)}
h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:20px 0 8px}h3{font-size:15px;margin:2px 0 8px}
.model{font-size:17px;color:var(--muted);margin:0 0 14px}
.muted{color:var(--muted);font-weight:normal}
.cover{border-bottom:3px solid var(--accent);padding-bottom:16px;margin-bottom:20px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:6px 0}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.chip{border-radius:999px;padding:4px 12px;background:var(--soft);border:1px solid var(--line)}
.tables{display:flex;flex-wrap:wrap;gap:24px}
table{border-collapse:collapse}
th,td{text-align:left;padding:4px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
caption{text-align:left;font-weight:600;padding:4px 0}
.tests{width:100%}
.card{display:grid;grid-template-columns:minmax(220px,42%) 1fr;gap:16px;border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0;break-inside:avoid;page-break-inside:avoid;background:var(--bg)}
.card.member{margin-left:22px;border-left:4px solid var(--line)}
.grouphead{background:var(--soft);border-left:6px solid var(--accent);break-after:avoid;page-break-after:avoid}
.pic{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;background:#e5e7eb}
.pic.none{min-height:60px}
.line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tag{font-size:11px;letter-spacing:.08em;color:var(--muted);font-weight:700}
.pill{border-radius:999px;padding:1px 10px;font-size:12px;font-weight:600;color:#111827}
.x{color:var(--muted)}
.pair td{padding:2px 8px;font-size:13px}
.side{font-weight:700;color:#fff;text-align:center;border-radius:4px}.sA{background:#ef4444}.sB{background:#22c55e}
.s-new{background:#fca5a5}.s-active{background:#fdba74}.s-reviewed{background:#fde68a}.s-approved{background:#93c5fd}.s-resolved{background:#86efac}
.mixed{background:#fbbf24}
footer{margin-top:28px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:8px}
@media (max-width:700px){.card{grid-template-columns:1fr}.card.member{margin-left:8px}}
@media print{body{max-width:none;padding:0}.card{margin:8px 0}@page{size:A4;margin:12mm}}
`;
