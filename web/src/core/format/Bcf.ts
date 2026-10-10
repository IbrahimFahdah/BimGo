import { type ClipPlane, SectionCut } from '../scene/SectionCut';
import type { SiteInfo } from '../scene/ModelInfo';
import { type SharedTransform, SiteCoordinates } from '../scene/SiteCoordinates';
import { clamp, vec3 } from '../math/Vector';
import {
  cleanComment, CommentPriority, type CommentRecord, type CommentReply, CommentStatus, type CommentView
} from './DocumentModels';
import { newId } from './Json';
import { child, descendant, descendants, el, parseXml, valueOf, writeXml, type XmlElement, type XmlNode } from './Xml';
import { ZipReader } from './Zip';
import { ZipWriter } from './ZipWriter';

// Port of BcfModels.cs, BcfFile.cs and BcfMapping.cs: plain BCF 2.1 out, 2.0 / 2.1 / 3.0 in, and BimGo comments ↔
// BCF topics. GUIDs are kept as lower-case "D" strings (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx); dates as ISO strings.

// #region Models

/** A point or direction in a BCF viewpoint (metres, in whichever coordinates the export used). */
export interface BcfVector { x: number; y: number; z: number }

const vectorFinite = (v: BcfVector) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const vectorLength = (v: BcfVector) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

/** One element named by a viewpoint: its IFC GUID and / or the authoring tool's id (the Revit ElementId). */
export interface BcfComponent {
  ifcGuid: string | null;
  authoringToolId: string | null;
  originatingSystem: string | null;
}

/** A BCF clipping plane: a point on it and its direction, which points into the half-space that is clipped. */
export interface BcfClippingPlane { location: BcfVector; direction: BcfVector }

/** A BCF viewpoint: the camera and the selected elements. */
export interface BcfViewpoint {
  guid: string;
  position: BcfVector;
  direction: BcfVector;
  up: BcfVector;
  /** Vertical field of view (degrees); for orthogonal cameras, the view-to-world scale instead. */
  fieldOfView: number;
  orthogonal: boolean;
  selection: BcfComponent[];
  clippingPlanes: BcfClippingPlane[];
}

/** One comment in a topic's thread. */
export interface BcfComment {
  guid: string;
  date: string;
  author: string;
  text: string;
  modifiedDate: string | null;
  modifiedAuthor: string | null;
}

/** One BCF topic (an issue). Status and priority hold the file's own words. */
export interface BcfTopic {
  guid: string;
  topicType: string | null;
  status: string | null;
  title: string;
  priority: string | null;
  creationDate: string;
  creationAuthor: string;
  modifiedDate: string | null;
  modifiedAuthor: string | null;
  assignedTo: string | null;
  description: string | null;
  comments: BcfComment[];
  viewpoint: BcfViewpoint | null;
  /** The viewpoint's snapshot image (PNG or JPEG bytes), or null. */
  snapshot: Uint8Array | null;
  /** ".png" or ".jpg". */
  snapshotExtension: string;
}

export interface BcfProject { projectId: string; name: string }

export interface BcfReadResult {
  version: string;
  project: BcfProject | null;
  topics: BcfTopic[];
  /** Topics that couldn't be read. */
  skipped: number;
}

const newGuid = () => crypto.randomUUID();

export function newTopic(fields: Partial<BcfTopic> = {}): BcfTopic {
  return {
    guid: newGuid(), topicType: null, status: null, title: '', priority: null, creationDate: new Date().toISOString(),
    creationAuthor: '', modifiedDate: null, modifiedAuthor: null, assignedTo: null, description: null, comments: [],
    viewpoint: null, snapshot: null, snapshotExtension: '.png', ...fields
  };
}

export function newBcfComment(fields: Partial<BcfComment> = {}): BcfComment {
  return { guid: newGuid(), date: new Date().toISOString(), author: '', text: '', modifiedDate: null, modifiedAuthor: null, ...fields };
}

export function newViewpoint(fields: Partial<BcfViewpoint> = {}): BcfViewpoint {
  return {
    guid: newGuid(), position: vec3(), direction: vec3(1, 0, 0), up: vec3(0, 0, 1), fieldOfView: 60, orthogonal: false,
    selection: [], clippingPlanes: [], ...fields
  };
}

/** A GUID in any common form ("N", "D", braces) as lower-case "D", or null. */
export function parseGuid(text: string | null | undefined): string | null {
  const hex = (text ?? '').trim().replace(/^[{(]|[})]$/g, '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) { return null; }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A "D" GUID as "N" (32 hex digits). */
export const guidN = (guid: string) => guid.replace(/-/g, '');

// #endregion

// #region File

/** The file extension (with the dot). */
export const BCF_EXTENSION = '.bcf';
/** The BCF version written. */
export const BCF_VERSION = '2.1';
/** The extension schema written beside project.bcfp. */
export const BCF_EXTENSIONS_FILE = 'extensions.xsd';

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const XSD = 'http://www.w3.org/2001/XMLSchema';
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOPICS = 20000;

/** Writes topics to a BCF 2.1 archive (bcf.version, project.bcfp, extensions.xsd, a folder per topic). */
export async function writeBcf(project: BcfProject | null, topics: readonly BcfTopic[]): Promise<Blob> {
  const zip = new ZipWriter();
  await zip.addText('bcf.version', xml(el('Version', { VersionId: BCF_VERSION }, el('DetailedVersion', null, BCF_VERSION))));
  project ??= { projectId: newGuid(), name: '' };
  await zip.addText('project.bcfp', xml(el('ProjectExtension', null,
    el('Project', { ProjectId: project.projectId || newGuid() }, el('Name', null, project.name ?? '')),
    el('ExtensionSchema', null, BCF_EXTENSIONS_FILE))));
  await zip.addText(BCF_EXTENSIONS_FILE, extensionsXsd(topics));

  for (const topic of topics) {
    const folder = topic.guid;
    const snapshotName = topic.snapshot && topic.snapshot.length > 0 ? 'snapshot' + normaliseExtension(topic.snapshotExtension) : null;
    await zip.addText(`${folder}/markup.bcf`, xml(buildMarkup(topic, snapshotName)));
    if (topic.viewpoint) { await zip.addText(`${folder}/viewpoint.bcfv`, xml(buildViewpoint(topic.viewpoint))); }
    if (snapshotName) { await zip.add(`${folder}/${snapshotName}`, topic.snapshot!, false); }
  }
  return zip.finish();
}

/** The root with the xsi / xsd namespaces declared, as buildingSMART's sample files do. */
function xml(root: XmlNode): string {
  root.attributes = { ...root.attributes, 'xmlns:xsi': XSI, 'xmlns:xsd': XSD };
  return writeXml(root);
}

function buildMarkup(topic: BcfTopic, snapshotName: string | null): XmlNode {
  const markup = el('Markup', null, el('Topic', {
    Guid: topic.guid,
    TopicType: optional(topic.topicType),
    TopicStatus: optional(topic.status)
  },
  el('Title', null, truncate(topic.title, 200)),
  optionalElement('Priority', topic.priority),
  el('CreationDate', null, bcfDate(topic.creationDate)),
  el('CreationAuthor', null, topic.creationAuthor ?? ''),
  topic.modifiedDate ? el('ModifiedDate', null, bcfDate(topic.modifiedDate)) : null,
  optionalElement('ModifiedAuthor', topic.modifiedAuthor),
  optionalElement('AssignedTo', topic.assignedTo),
  optionalElement('Description', topic.description)));

  for (const comment of topic.comments) {
    if (!comment.text?.trim()) { continue; }
    markup.children!.push(el('Comment', { Guid: comment.guid },
      el('Date', null, bcfDate(comment.date)),
      el('Author', null, comment.author ?? ''),
      el('Comment', null, comment.text),
      comment.modifiedDate ? el('ModifiedDate', null, bcfDate(comment.modifiedDate)) : null,
      optionalElement('ModifiedAuthor', comment.modifiedAuthor)));
  }
  if (topic.viewpoint) {
    markup.children!.push(el('Viewpoints', { Guid: topic.viewpoint.guid },
      el('Viewpoint', null, 'viewpoint.bcfv'),
      snapshotName ? el('Snapshot', null, snapshotName) : null));
  }
  return markup;
}

function buildViewpoint(viewpoint: BcfViewpoint): XmlNode {
  const components = el('Components', null);
  const selection = el('Selection', null);
  for (const c of viewpoint.selection) {
    if (!c.ifcGuid && !c.authoringToolId) { continue; }
    selection.children!.push(el('Component', { IfcGuid: c.ifcGuid || null },
      optionalElement('OriginatingSystem', c.originatingSystem), optionalElement('AuthoringToolId', c.authoringToolId)));
  }
  if (selection.children!.length > 0) { components.children!.push(selection); }
  components.children!.push(el('Visibility', { DefaultVisibility: 'true' }));

  return el('VisualizationInfo', { Guid: viewpoint.guid },
    components,
    el('PerspectiveCamera', null,
      vector('CameraViewPoint', viewpoint.position),
      vector('CameraDirection', viewpoint.direction),
      vector('CameraUpVector', viewpoint.up),
      el('FieldOfView', null, number(viewpoint.fieldOfView))),
    viewpoint.clippingPlanes.length > 0
      ? el('ClippingPlanes', null, ...viewpoint.clippingPlanes.map(c => el('ClippingPlane', null, vector('Location', c.location), vector('Direction', c.direction))))
      : null);
}

/**
 * extensions.xsd: the topic types, statuses and priorities this file uses (BimGo's three of each plus any other value
 * a topic carries), as an XML Schema redefine of markup.xsd like buildingSMART's samples.
 */
function extensionsXsd(topics: readonly BcfTopic[]): string {
  const types = ['Issue'], statuses = ['Open', 'In Progress', 'Closed'], priorities = ['Low', 'Normal', 'High'];
  const addValue = (list: string[], value: string | null) => {
    const v = value?.trim();
    if (v && !list.some(x => x.toLowerCase() === v.toLowerCase())) { list.push(v); }
  };
  for (const t of topics) {
    addValue(types, t.topicType);
    addValue(statuses, t.status);
    addValue(priorities, t.priority);
  }
  const restriction = (name: string, values: string[]) => el('xs:simpleType', { name },
    el('xs:restriction', { base: name }, ...values.map(v => el('xs:enumeration', { value: v }))));
  return writeXml(el('xs:schema', { 'xmlns:xs': XSD },
    el('xs:redefine', { schemaLocation: 'markup.xsd' },
      restriction('TopicType', types), restriction('TopicStatus', statuses), restriction('TopicLabel', []),
      restriction('SnippetType', []), restriction('Priority', priorities), restriction('UserIdType', []), restriction('Stage', []))), true);
}

const vector = (name: string, v: BcfVector) => el(name, null, el('X', null, number(v.x)), el('Y', null, number(v.y)), el('Z', null, number(v.z)));

/** "0.#######". */
function number(value: number): string {
  if (!Number.isFinite(value)) { return '0'; }
  const s = (Math.round(value * 1e7) / 1e7).toFixed(7).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** "yyyy-MM-ddTHH:mm:ss+hh:mm" in local time. */
export function bcfDate(iso: string): string {
  let d = new Date(iso);
  if (Number.isNaN(d.getTime())) { d = new Date(); }
  const two = (n: number) => String(Math.trunc(n)).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` +
    `${sign}${two(Math.abs(offset) / 60)}:${two(Math.abs(offset) % 60)}`;
}

const optional = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);
const optionalElement = (name: string, value: string | null | undefined) => (value?.trim() ? el(name, null, value.trim()) : null);

function truncate(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

const normaliseExtension = (ext: string) => (/^\.(jpg|jpeg)$/i.test(ext) ? '.jpg' : '.png');

/** Reads a BCF archive. Never throws: a reason comes back instead of a result. */
export async function readBcf(blob: Blob): Promise<{ result: BcfReadResult | null; error: string | null }> {
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(blob);
  } catch {
    return { result: null, error: 'Not a BCF file (not a ZIP archive)' };
  }
  try {
    // Entries by normalised name (forward slashes, case-insensitive)
    const entries = new Map<string, string>();
    for (const name of zip.names) {
      const n = name.replace(/\\/g, '/').replace(/^\/+/, '');
      if (n.length > 0 && !n.endsWith('/')) { entries.set(n.toLowerCase(), name); }
    }
    const result: BcfReadResult = { version: '?', project: null, topics: [], skipped: 0 };

    const version = await loadXml(zip, entries, 'bcf.version');
    if (version) { result.version = version.attributes.get('VersionId')?.trim() || valueOf(child(version, 'DetailedVersion'))?.trim() || '?'; }

    const project = await loadXml(zip, entries, 'project.bcfp');
    const projectNode = project ? descendant(project, 'Project') : null;
    if (projectNode) {
      result.project = { projectId: projectNode.attributes.get('ProjectId') ?? '', name: valueOf(child(projectNode, 'Name')) ?? '' };
    }

    const markups = [...entries.entries()].filter(([key]) => key.endsWith('/markup.bcf')).map(([, name]) => name.replace(/\\/g, '/').replace(/^\/+/, ''))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of markups) {
      if (result.topics.length >= MAX_TOPICS) { result.skipped++; continue; }
      const topic = await readTopic(zip, entries, name.slice(0, -'/markup.bcf'.length));
      if (topic) { result.topics.push(topic); } else { result.skipped++; }
    }
    if (result.topics.length === 0 && result.skipped === 0) { return { result: null, error: 'No topics found (is this a BCF file?)' }; }
    return { result, error: null };
  } catch (e) {
    console.warn('BCF import failed', e);
    return { result: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function readTopic(zip: ZipReader, entries: Map<string, string>, folder: string): Promise<BcfTopic | null> {
  try {
    const markup = await loadXml(zip, entries, `${folder}/markup.bcf`);
    const topicNode = markup ? (markup.name === 'Topic' ? markup : descendant(markup, 'Topic')) : null;
    if (!markup || !topicNode) { return null; }

    const creationDate = parseDate(text(topicNode, 'CreationDate')) ?? new Date().toISOString();
    const topic = newTopic({
      guid: parseGuid(topicNode.attributes.get('Guid')) ?? parseGuid(folder.slice(folder.lastIndexOf('/') + 1)) ?? newGuid(),
      topicType: attr(topicNode, 'TopicType') ?? text(topicNode, 'TopicType'),
      status: attr(topicNode, 'TopicStatus') ?? text(topicNode, 'TopicStatus'),
      title: text(topicNode, 'Title') ?? '',
      priority: text(topicNode, 'Priority'),
      creationDate,
      creationAuthor: text(topicNode, 'CreationAuthor') ?? '',
      modifiedDate: parseDate(text(topicNode, 'ModifiedDate')),
      modifiedAuthor: text(topicNode, 'ModifiedAuthor'),
      assignedTo: text(topicNode, 'AssignedTo'),
      description: text(topicNode, 'Description')
    });

    // Comments: 2.x under Markup, 3.0 under Topic/Comments; either way a Comment holding a Comment (the text)
    for (const node of descendants(markup)) {
      if (node.name !== 'Comment' || !child(node, 'Comment')) { continue; }
      const body = valueOf(child(node, 'Comment'));
      if (!body?.trim()) { continue; }
      topic.comments.push(newBcfComment({
        guid: parseGuid(node.attributes.get('Guid')) ?? newGuid(),
        date: parseDate(text(node, 'Date')) ?? creationDate,
        author: text(node, 'Author') ?? '',
        text: body.trim(),
        modifiedDate: parseDate(text(node, 'ModifiedDate')),
        modifiedAuthor: text(node, 'ModifiedAuthor')
      }));
    }
    topic.comments.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

    // The first viewpoint: 2.x Markup/Viewpoints, 3.0 Topic/Viewpoints/ViewPoint
    let reference: XmlElement | null = null;
    for (const node of descendants(markup)) {
      if ((node.name === 'Viewpoints' || node.name === 'ViewPoint') && child(node, 'Viewpoint')) { reference = node; break; }
    }
    let viewpointFile = reference ? text(reference, 'Viewpoint') : null;
    let snapshotFile = reference ? text(reference, 'Snapshot') : null;
    const has = (name: string) => entries.has(`${folder}/${name}`.toLowerCase());
    viewpointFile ??= has('viewpoint.bcfv') ? 'viewpoint.bcfv' : null;
    snapshotFile ??= has('snapshot.png') ? 'snapshot.png' : has('snapshot.jpg') ? 'snapshot.jpg' : null;

    if (viewpointFile) {
      topic.viewpoint = readViewpoint(await loadXml(zip, entries, `${folder}/${viewpointFile}`));
      const guid = parseGuid(reference?.attributes.get('Guid'));
      if (topic.viewpoint && guid) { topic.viewpoint.guid = guid; }
    }
    if (snapshotFile) {
      topic.snapshot = await readBytes(zip, entries, `${folder}/${snapshotFile}`, MAX_IMAGE_BYTES);
      topic.snapshotExtension = snapshotFile.toLowerCase().endsWith('.png') ? '.png' : '.jpg';
    }
    return topic;
  } catch (e) {
    console.warn(`BCF topic ${folder} skipped`, e);
    return null;
  }
}

function readViewpoint(root: XmlElement | null): BcfViewpoint | null {
  if (!root) { return null; }
  const viewpoint = newViewpoint({ guid: parseGuid(root.attributes.get('Guid')) ?? newGuid() });
  let camera = descendant(root, 'PerspectiveCamera');
  if (!camera) {
    camera = descendant(root, 'OrthogonalCamera');
    viewpoint.orthogonal = camera !== null;
  }
  if (!camera) { return null; }

  const position = readVector(child(camera, 'CameraViewPoint'));
  const direction = readVector(child(camera, 'CameraDirection'));
  if (!position || !direction || vectorLength(direction) < 1e-9) { return null; }
  viewpoint.position = position;
  viewpoint.direction = direction;
  viewpoint.up = readVector(child(camera, 'CameraUpVector')) ?? vec3(0, 0, 1);
  const fov = parseNumber(text(camera, viewpoint.orthogonal ? 'ViewToWorldScale' : 'FieldOfView'));
  if (fov !== null) { viewpoint.fieldOfView = fov; }

  const clipping = descendant(root, 'ClippingPlanes');
  for (const node of clipping?.children ?? []) {
    if (node.name !== 'ClippingPlane') { continue; }
    const location = readVector(child(node, 'Location'));
    const clipDirection = readVector(child(node, 'Direction'));
    if (location && clipDirection && vectorLength(clipDirection) > 1e-9) { viewpoint.clippingPlanes.push({ location, direction: clipDirection }); }
  }

  const selection = descendant(root, 'Selection');
  for (const node of selection?.children ?? []) {
    if (node.name !== 'Component') { continue; }
    const component: BcfComponent = {
      ifcGuid: attr(node, 'IfcGuid'), authoringToolId: text(node, 'AuthoringToolId'), originatingSystem: text(node, 'OriginatingSystem')
    };
    if (component.ifcGuid !== null || component.authoringToolId !== null) { viewpoint.selection.push(component); }
  }
  return viewpoint;
}

function readVector(node: XmlElement | null): BcfVector | null {
  if (!node) { return null; }
  const x = parseNumber(text(node, 'X')), y = parseNumber(text(node, 'Y')), z = parseNumber(text(node, 'Z'));
  if (x === null || y === null || z === null) { return null; }
  const v = vec3(x, y, z);
  return vectorFinite(v) ? v : null;
}

function parseNumber(s: string | null): number | null {
  if (s === null || !/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(s)) { return null; }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function loadXml(zip: ZipReader, entries: Map<string, string>, name: string): Promise<XmlElement | null> {
  const bytes = await readBytes(zip, entries, name, MAX_XML_BYTES);
  return bytes ? parseXml(new TextDecoder().decode(bytes)) : null;
}

async function readBytes(zip: ZipReader, entries: Map<string, string>, name: string, max: number): Promise<Uint8Array | null> {
  const real = entries.get(name.replace(/\\/g, '/').toLowerCase());
  const entry = real ? zip.get(real) : null;
  if (!entry || entry.size > max) { return null; }
  return zip.read(entry);
}

function text(parent: XmlElement, name: string): string | null {
  const v = valueOf(child(parent, name));
  return v && v.trim() ? v.trim() : null;
}

function attr(node: XmlElement, name: string): string | null {
  const v = node.attributes.get(name);
  return v && v.trim() ? v.trim() : null;
}

/** An ISO date; a time without a zone is taken as UTC (DateTimeStyles.AssumeUniversal). Null when unreadable. */
function parseDate(s: string | null): string | null {
  if (!s) { return null; }
  let t = s.trim();
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) { t += 'Z'; }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// #endregion

// #region Coordinates

/** Which coordinates BCF viewpoints are written in (and read back with). */
export enum BcfCoordinates {
  Shared = 0,
  Project = 1,
  Internal = 2
}

/** Converts Revit internal metres to and from a BCF coordinate system, in double precision. Directions only rotate. */
export class BcfFrame {
  private constructor(
    readonly kind: BcfCoordinates,
    private readonly shared: SharedTransform | null,
    private readonly base: [number, number, number]
  ) {}

  /** The frame for a model: the wanted coordinates when the site supports them, else internal. */
  static resolve(site: SiteInfo | null, wanted: BcfCoordinates): { frame: BcfFrame; fellBack: boolean } {
    if (wanted === BcfCoordinates.Shared) {
      const shared = SiteCoordinates.tryGetShared(site);
      if (shared) { return { frame: new BcfFrame(BcfCoordinates.Shared, shared, [0, 0, 0]), fellBack: false }; }
    }
    if (wanted === BcfCoordinates.Project) {
      const base = SiteCoordinates.tryGetProjectBase(site);
      if (base) { return { frame: new BcfFrame(BcfCoordinates.Project, null, base), fellBack: false }; }
    }
    return { frame: new BcfFrame(BcfCoordinates.Internal, null, [0, 0, 0]), fellBack: wanted !== BcfCoordinates.Internal };
  }

  pointToBcf(x: number, y: number, z: number): BcfVector {
    switch (this.kind) {
      case BcfCoordinates.Shared: {
        const [e, n, h] = this.shared!.apply(x, y, z);
        return vec3(e, n, h);
      }
      case BcfCoordinates.Project: return vec3(x - this.base[0], y - this.base[1], z - this.base[2]);
      default: return vec3(x, y, z);
    }
  }

  pointFromBcf(v: BcfVector): BcfVector {
    switch (this.kind) {
      case BcfCoordinates.Shared: {
        const s = this.shared!;
        const dx = v.x - s.east, dy = v.y - s.north;
        return vec3(dx * s.cos + dy * s.sin, -dx * s.sin + dy * s.cos, v.z - s.elevation);
      }
      case BcfCoordinates.Project: return vec3(v.x + this.base[0], v.y + this.base[1], v.z + this.base[2]);
      default: return vec3(v.x, v.y, v.z);
    }
  }

  directionToBcf(x: number, y: number, z: number): BcfVector {
    if (this.kind !== BcfCoordinates.Shared) { return vec3(x, y, z); }
    const s = this.shared!;
    return vec3(x * s.cos - y * s.sin, x * s.sin + y * s.cos, z);
  }

  directionFromBcf(v: BcfVector): BcfVector {
    if (this.kind !== BcfCoordinates.Shared) { return vec3(v.x, v.y, v.z); }
    const s = this.shared!;
    return vec3(v.x * s.cos + v.y * s.sin, -v.x * s.sin + v.y * s.cos, v.z);
  }
}

// #endregion

// #region Mapping

/** Longest topic title written (the full text goes in the description). */
export const BCF_TITLE_LENGTH = 60;
/** BCF 2.1 limits the field of view to 45–60°. */
export const BCF_MIN_FOV = 45;
export const BCF_MAX_FOV = 60;
/** Who an imported change is credited to when the file doesn't say. */
export const BCF_IMPORT_AUTHOR = 'BCF import';

export const BcfMapping = {
  statusToBcf(status: string): string {
    switch (CommentStatus.normalise(status)) {
      case CommentStatus.IN_PROGRESS: return 'In Progress';
      case CommentStatus.CLOSED: return 'Closed';
      default: return 'Open';
    }
  },

  /** A BCF status → BimGo (generous: Revizto / ACC words too). */
  statusFromBcf(status: string | null): string {
    const s = (status ?? '').trim().toLowerCase();
    if (s.length === 0) { return CommentStatus.OPEN; }
    if (s.includes('reopen') || s === 'open' || s === 'new') { return CommentStatus.OPEN; }
    if (['close', 'resolv', 'done', 'fixed', 'complete', 'approved'].some(w => s.includes(w))) { return CommentStatus.CLOSED; }
    if (['progress', 'active', 'assigned', 'review', 'pending', 'answered'].some(w => s.includes(w))) { return CommentStatus.IN_PROGRESS; }
    return CommentStatus.OPEN;
  },

  priorityToBcf(priority: string): string {
    switch (CommentPriority.normalise(priority)) {
      case CommentPriority.LOW: return 'Low';
      case CommentPriority.HIGH: return 'High';
      default: return 'Normal';
    }
  },

  priorityFromBcf(priority: string | null): string {
    const p = (priority ?? '').trim().toLowerCase();
    if (['critical', 'high', 'major', 'urgent', 'blocker'].some(w => p.includes(w))) { return CommentPriority.HIGH; }
    if (['low', 'minor', 'trivial'].some(w => p.includes(w))) { return CommentPriority.LOW; }
    return CommentPriority.NORMAL;
  },

  /** The topic title for a comment: its first line, at most BCF_TITLE_LENGTH characters (… when cut). */
  titleOf(text: string): string {
    let line = (text ?? '').trim();
    const newline = line.search(/[\r\n]/);
    if (newline >= 0) { line = line.slice(0, newline).trim(); }
    return line.length <= BCF_TITLE_LENGTH ? line : line.slice(0, BCF_TITLE_LENGTH - 1).trimEnd() + '…';
  },

  /** A comment as a topic (the viewpoint and snapshot are added by the caller). */
  toTopic(record: CommentRecord): BcfTopic {
    const guid = parseGuid(record.id) ?? deterministicGuid('comment:' + record.id);
    const modified = latest(record.edited, record.updated);
    const modifiedBy = modified === null ? null : modified === record.updated ? record.updatedBy : record.editedBy;
    const topic = newTopic({
      guid, topicType: 'Issue', status: BcfMapping.statusToBcf(record.status), title: BcfMapping.titleOf(record.text),
      priority: BcfMapping.priorityToBcf(record.priority), creationDate: record.created, creationAuthor: record.author ?? '',
      modifiedDate: modified, modifiedAuthor: modifiedBy, assignedTo: record.assignedTo, description: record.text
    });
    for (const reply of record.replies ?? []) {
      if (!reply?.text?.trim()) { continue; }
      topic.comments.push(newBcfComment({
        guid: parseGuid(reply.id) ?? deterministicGuid(`reply:${record.id}:${reply.id}`),
        date: reply.created, author: reply.author ?? '', text: reply.text
      }));
    }
    return topic;
  },

  /**
   * A saved view as a BCF perspective camera: eye = feet + eye height, look direction from yaw / pitch, and the
   * vertical field of view of a 16:9 picture taken with the horizontal one (clamped to 45–60°).
   */
  toViewpoint(view: CommentView, eyeHeight: number, frame: BcfFrame, horizontalFovDegrees: number): BcfViewpoint {
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    const h = clamp(horizontalFovDegrees, 30, 150) * Math.PI / 180;
    const vertical = 2 * Math.atan(Math.tan(h * 0.5) * 9 / 16) * 180 / Math.PI;
    return newViewpoint({
      position: frame.pointToBcf(view.x, view.y, view.z + eyeHeight),
      direction: frame.directionToBcf(cp * cy, cp * sy, sp),
      up: frame.directionToBcf(-sp * cy, -sp * sy, cp),
      fieldOfView: Math.round(clamp(vertical, BCF_MIN_FOV, BCF_MAX_FOV) * 1000) / 1000
    });
  },

  /** A viewpoint's camera as a BimGo view (feet = eye − eye height); flying is left false. Null when unusable. */
  toView(viewpoint: BcfViewpoint | null, eyeHeight: number, frame: BcfFrame): CommentView | null {
    if (!viewpoint || !vectorFinite(viewpoint.position) || !vectorFinite(viewpoint.direction) || vectorLength(viewpoint.direction) < 1e-9) { return null; }
    const p = frame.pointFromBcf(viewpoint.position);
    const d0 = frame.directionFromBcf(viewpoint.direction);
    const length = vectorLength(d0);
    const dx = d0.x / length, dy = d0.y / length, dz = d0.z / length;
    const flat = Math.sqrt(dx * dx + dy * dy);
    const round4 = (v: number) => Math.round(v * 10000) / 10000;
    const view: CommentView = {
      x: round4(p.x), y: round4(p.y), z: round4(p.z - eyeHeight),
      yaw: flat < 1e-6 ? 0 : Math.fround(Math.atan2(dy, dx)),
      pitch: Math.fround(clamp(Math.atan2(dz, flat), -1.5, 1.5)),
      flying: false, section: null
    };
    return Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.z) ? view : null;
  },

  /** A section cut (internal metres) as BCF clipping planes in the frame's coordinates. */
  toClippingPlanes(cut: SectionCut | null, frame: BcfFrame): BcfClippingPlane[] {
    if (!cut?.isActive) { return []; }
    return cut.toPlanes().map(p => ({
      location: frame.pointToBcf(p.point.x, p.point.y, p.point.z),
      direction: frame.directionToBcf(p.direction.x, p.direction.y, p.direction.z)
    }));
  },

  /** BCF clipping planes back as a section cut (internal metres), or null when there are none. */
  toSection(planes: readonly BcfClippingPlane[] | null, frame: BcfFrame): { cut: SectionCut | null; dropped: number } {
    if (!planes || planes.length === 0) { return { cut: null, dropped: 0 }; }
    const internal: ClipPlane[] = planes.map(p => {
      const point = frame.pointFromBcf(p.location), direction = frame.directionFromBcf(p.direction);
      const f = Math.fround;
      return { point: vec3(f(point.x), f(point.y), f(point.z)), direction: vec3(f(direction.x), f(direction.y), f(direction.z)) };
    });
    return SectionCut.fromPlanes(internal);
  },

  /** A new comment from a topic (id = the topic GUID); marker, view, level and element are set by the caller. */
  toComment(topic: BcfTopic, blank: () => CommentRecord): CommentRecord {
    const { text, usedComment } = BcfMapping.textOf(topic);
    const record = blank();
    record.id = guidN(topic.guid);
    record.author = topic.creationAuthor?.trim() || BCF_IMPORT_AUTHOR;
    record.created = topic.creationDate;
    record.text = text;
    record.status = BcfMapping.statusFromBcf(topic.status);
    record.priority = BcfMapping.priorityFromBcf(topic.priority);
    record.assignedTo = topic.assignedTo?.trim() || null;
    record.updated = topic.modifiedDate;
    record.updatedBy = topic.modifiedDate ? (topic.modifiedAuthor ?? BCF_IMPORT_AUTHOR) : null;
    for (const comment of topic.comments) {
      if (comment === usedComment || sameText(comment.text, text)) { continue; }
      (record.replies ??= []).push(toReply(comment));
    }
    return cleanComment(record);
  },

  /**
   * Merges a topic into the comment it came from: status, priority and assignee take the file's values, replies the
   * comment doesn't have yet are added in date order. Nothing is deleted.
   */
  merge(record: CommentRecord, topic: BcfTopic): { added: number; fieldsChanged: boolean } {
    let fieldsChanged = false;
    const status = BcfMapping.statusFromBcf(topic.status);
    const priority = topic.priority?.trim() ? BcfMapping.priorityFromBcf(topic.priority) : record.priority;
    const assignee = topic.assignedTo?.trim() || null;
    if (status !== record.status || priority !== record.priority || assignee !== record.assignedTo) {
      record.status = status;
      record.priority = priority;
      record.assignedTo = assignee;
      record.updated = topic.modifiedDate ?? new Date().toISOString();
      record.updatedBy = topic.modifiedAuthor ?? BCF_IMPORT_AUTHOR;
      fieldsChanged = true;
    }
    let added = 0;
    for (const comment of topic.comments) {
      if (sameText(comment.text, record.text) || hasReply(record, comment)) { continue; }
      (record.replies ??= []).push(toReply(comment));
      added++;
    }
    if (added > 0) { record.replies!.sort((a, b) => Date.parse(a.created) - Date.parse(b.created)); }
    return { added, fieldsChanged };
  },

  /** The comment text for a topic: the description (title in front when different), else the first comment, else the title. */
  textOf(topic: BcfTopic): { text: string; usedComment: BcfComment | null } {
    const title = (topic.title ?? '').trim();
    const description = (topic.description ?? '').trim();
    const stem = title.replace(/…+$/, '').trimEnd().toLowerCase();
    if (description.length > 0) {
      if (title.length === 0 || description.toLowerCase().startsWith(stem)) { return { text: description, usedComment: null }; }
      return { text: `${title} — ${description}`, usedComment: null };
    }
    const first = topic.comments.find(c => c.text?.trim());
    if (first) {
      const t = first.text.trim();
      return { text: title.length === 0 || t.toLowerCase().startsWith(stem) ? t : `${title} — ${t}`, usedComment: first };
    }
    return { text: title.length > 0 ? title : '(untitled issue)', usedComment: null };
  }
};

function toReply(comment: BcfComment): CommentReply {
  return { id: guidN(comment.guid), author: comment.author?.trim() || BCF_IMPORT_AUTHOR, created: comment.date, text: comment.text.trim() };
}

function hasReply(record: CommentRecord, comment: BcfComment): boolean {
  const id = guidN(comment.guid);
  for (const reply of record.replies ?? []) {
    if (reply.id.toLowerCase() === id || parseGuid(reply.id) === comment.guid) { return true; }
    if (sameText(reply.text, comment.text) && (reply.author ?? '').trim().toLowerCase() === (comment.author ?? '').trim().toLowerCase()
      && Math.abs(Date.parse(reply.created) - Date.parse(comment.date)) < 2000) { return true; }
  }
  return false;
}

const sameText = (a: string | null, b: string | null) => (a ?? '').trim() === (b ?? '').trim();

function latest(a: string | null, b: string | null): string | null {
  if (a === null) { return b; }
  if (b === null) { return a; }
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * A stable GUID from text: MD5 of the UTF-8 bytes read as .NET's Guid(byte[]) does (the first three groups little-
 * endian), so the web and the desktop give the same ids.
 */
export function deterministicGuid(text: string): string {
  const h = md5(new TextEncoder().encode(text ?? ''));
  const hex = (bytes: number[]) => bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex([h[3], h[2], h[1], h[0]])}-${hex([h[5], h[4]])}-${hex([h[7], h[6]])}-${hex([h[8], h[9]])}-${hex([...h.slice(10, 16)])}`;
}

/** MD5 (RFC 1321); only for stable ids, never for security. */
export function md5(data: Uint8Array): Uint8Array {
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) { k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0; }

  const length = data.length;
  const padded = new Uint8Array(((length + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) { m[i] = view.getUint32(offset + i * 4, true); }
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + k[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << s[i]) | (sum >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}

// #endregion

/** A blank comment record for BcfMapping.toComment (the caller's store fills the runtime fields). */
export function blankComment(): CommentRecord {
  return {
    id: newId(), author: '', created: new Date().toISOString(), text: '', x: 0, y: 0, z: 0, elementId: -1, level: '',
    edited: null, editedBy: null, status: CommentStatus.OPEN, assignedTo: null, priority: CommentPriority.NORMAL,
    updated: null, updatedBy: null, replies: null, view: null, thumbnail: null, elementUniqueId: null, snapshot: null,
    snapshotData: null, local: vec3(), header: ''
  };
}
