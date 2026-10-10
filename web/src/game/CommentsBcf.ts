import {
  BCF_EXTENSION, BcfCoordinates, BcfFrame, BcfMapping, type BcfComponent, type BcfTopic, type BcfViewpoint, blankComment, deterministicGuid,
  guidN, parseGuid, readBcf, writeBcf
} from '../core/format/Bcf';
import { CommentSnapshots, type CommentRecord, type CommentView } from '../core/format/DocumentModels';
import { vec3 } from '../core/math/Vector';
import { SectionCut } from '../core/scene/SectionCut';
import { CharacterController } from '../engine/physics/CharacterController';
import { SoundId } from '../platform/audio';
import { downloadBlob, pickFile, safeFileName } from '../platform/files';
import type { GameSession } from './GameSession';

const COORDINATE_LABELS = ['BCF COORDS: SHARED', 'BCF COORDS: PROJECT', 'BCF COORDS: INTERNAL'];
const THUMB_WIDTH = 192, THUMB_HEIGHT = 108;
/** Widest comment picture kept for BCF snapshots. */
export const SNAPSHOT_MAX_WIDTH = 1280;

const coordinateName = (c: BcfCoordinates) => (c === BcfCoordinates.Project ? 'project' : c === BcfCoordinates.Internal ? 'internal' : 'shared');

/**
 * BCF export and import of comments (port of GameSession.Bcf.cs), from the COMMENTS panel. Plain BCF 2.1 out (a
 * download); 2.0 / 2.1 / 3.0 in (a file you pick).
 * - Export (the comments the panel shows): one topic per comment with its status, priority, assignee, replies, a
 *   perspective viewpoint from its saved view (shared, project or internal coordinates), its section cut as clipping
 *   planes, the commented element (IFC GUID + Revit ElementId) and its picture.
 * - Import: a topic whose GUID matches a comment is merged (status, priority, assignee, new replies; nothing deleted);
 *   any other topic becomes a comment with its view, a marker where the view's centre ray meets the model (else on the
 *   named element, else 2 m ahead) and its picture.
 */
export class CommentsBcf {
  constructor(private readonly session: GameSession) {}

  private get coordinates(): BcfCoordinates {
    return this.session.settings.bcfCoordinates;
  }

  get coordinateLabel(): string {
    return COORDINATE_LABELS[Math.min(Math.max(this.coordinates, 0), 2)];
  }

  /** Steps shared → project → internal (remembered) and says which are used. */
  cycleCoordinates(): void {
    const session = this.session;
    session.settings.bcfCoordinates = (this.coordinates + 1) % 3;
    session.settings.save();
    const { fellBack } = BcfFrame.resolve(session.scene.site, this.coordinates);
    const name = coordinateName(this.coordinates);
    session.menu.setCommentsNotice(fellBack
      ? `BCF viewpoints: ${name} coordinates are not available in this model, internal will be used`
      : `BCF viewpoints use ${name} coordinates (match your IFC export's setting)`);
  }

  // #region Export

  /** Writes the given comments (the panel's filtered list) to a BCF 2.1 download. */
  async exportShown(records: CommentRecord[]): Promise<void> {
    const session = this.session, scene = session.scene;
    if (records.length === 0) {
      session.menu.setCommentsNotice('No comments to export (check the filters)');
      session.sound.play(SoundId.Error);
      return;
    }
    try {
      const { frame, fellBack } = BcfFrame.resolve(scene.site, this.coordinates);
      const revit = scene.provenance?.revitVersion?.trim();
      const system = revit ? 'Autodesk Revit ' + revit : 'Autodesk Revit';
      const topics: BcfTopic[] = [];
      for (const record of records) {
        const topic = BcfMapping.toTopic(record);
        const viewpoint = BcfMapping.toViewpoint(this.viewForBcf(record), CharacterController.STAND_EYE, frame, session.settings.fieldOfView);
        if (record.view?.section) { viewpoint.clippingPlanes.push(...BcfMapping.toClippingPlanes(record.view.section, frame)); }
        const component = this.componentFor(record, system);
        if (component) { viewpoint.selection.push(component); }
        topic.viewpoint = viewpoint;
        topic.snapshot = await toPng(record.snapshotData ?? thumbnailBytes(record));
        topic.snapshotExtension = '.png';
        topics.push(topic);
      }

      const key = scene.provenance?.modelKey?.trim() || scene.modelTitle;
      const project = { projectId: deterministicGuid('bimgo-model:' + key), name: scene.modelTitle ?? '' };
      const blob = await writeBcf(project, topics);
      const name = `${safeFileName(scene.modelTitle)} issues${BCF_EXTENSION}`;
      downloadBlob(blob, name);

      const withoutPicture = topics.filter(t => !t.snapshot).length;
      session.menu.setCommentsNotice(`Exported ${topics.length} ${topics.length === 1 ? 'issue' : 'issues'} to ${name} (${coordinateName(frame.kind)} coordinates` +
        (fellBack ? ', as the chosen ones aren\'t in this model' : '') + (withoutPicture > 0 ? `; ${withoutPicture} without a picture` : '') + ')');
      session.sound.play(SoundId.Commit);
    } catch (e) {
      console.warn('BCF export failed', e);
      session.menu.setCommentsNotice('BCF export failed: ' + (e instanceof Error ? e.message : String(e)));
      session.sound.play(SoundId.Error);
    }
  }

  /** The view a comment is exported with: its saved view, or (older comments) a standing spot looking at the marker. */
  private viewForBcf(record: CommentRecord): CommentView {
    if (record.view) { return record.view; }
    const { feet, yaw, pitch } = this.session.approachMarker(record.local);
    const world = this.session.toRevit(feet);
    return { x: world.x, y: world.y, z: world.z, yaw, pitch, flying: false, section: null };
  }

  /** The commented element as a BCF component (IFC GUID when the file has one, plus the ElementId), or null. */
  private componentFor(record: CommentRecord, system: string): BcfComponent | null {
    const session = this.session;
    const index = session.elementIndexOf(record.elementUniqueId, record.elementId);
    if (index < 0) {
      return record.elementId > 0 ? { ifcGuid: null, authoringToolId: String(record.elementId), originatingSystem: system } : null;
    }
    const element = session.scene.elements[index];
    return { ifcGuid: element.ifcGuid || null, authoringToolId: String(element.elementId), originatingSystem: system };
  }

  // #endregion

  // #region Import

  /** IMPORT BCF…: picks a file and merges or adds its topics as comments, saving once. */
  async importFile(): Promise<void> {
    const session = this.session;
    session.input.releaseAll();
    const file = await pickFile('.bcf,.bcfzip');
    if (!file) { return; }
    const { result, error } = await readBcf(file);
    if (!result) {
      session.menu.setCommentsNotice('BCF import failed: ' + error);
      session.sound.play(SoundId.Error);
      return;
    }

    try {
      const { frame, fellBack } = BcfFrame.resolve(session.scene.site, this.coordinates);
      const byGuid = new Map<string, CommentRecord>();
      for (const record of session.comments.comments) {
        const guid = parseGuid(record.id);
        if (guid) { byGuid.set(guid, record); }
      }

      const added: CommentRecord[] = [], merged: CommentRecord[] = [];
      let replies = 0, unchanged = 0;
      for (const topic of result.topics) {
        const existing = byGuid.get(topic.guid);
        if (existing) {
          const { added: count, fieldsChanged } = BcfMapping.merge(existing, topic);
          replies += count;
          if (fieldsChanged || count > 0) { merged.push(existing); } else { unchanged++; }
          continue;
        }
        const record = BcfMapping.toComment(topic, blankComment);
        this.placeImported(record, topic, frame);
        await importPictures(record, topic);
        added.push(record);
        byGuid.set(topic.guid, record); // a file listing a topic twice merges the second
      }

      session.comments.applyImport(added, merged);
      session.menu.setCommentsNotice(`BCF ${result.version}: ${added.length} new, ${merged.length} updated` +
        (replies > 0 ? ` (${replies} ${replies === 1 ? 'reply' : 'replies'} added)` : '') +
        (unchanged > 0 ? `, ${unchanged} unchanged` : '') +
        (result.skipped > 0 ? `, ${result.skipped} unreadable skipped` : '') +
        (fellBack ? ' · views read as internal coordinates' : ''));
      console.info(`BCF import from ${file.name}: ${added.length} new, ${merged.length} updated, ${replies} replies, ${unchanged} unchanged, ${result.skipped} skipped.`);
      session.sound.play(SoundId.Commit);
    } catch (e) {
      console.warn('BCF import failed', e);
      session.menu.setCommentsNotice('BCF import failed: ' + (e instanceof Error ? e.message : String(e)));
      session.sound.play(SoundId.Error);
    }
  }

  /**
   * Gives an imported comment its view, marker, element and level: the view from the viewpoint (walking when there
   * is a floor just under the feet, else flying); the marker where the view's centre ray first meets the model, else
   * at the named element's centre, else 2 m ahead of the camera.
   */
  private placeImported(record: CommentRecord, topic: BcfTopic, frame: BcfFrame): void {
    const session = this.session, scene = session.scene;
    let element = this.findElement(topic.viewpoint);
    let marker;
    const view = BcfMapping.toView(topic.viewpoint, CharacterController.STAND_EYE, frame);
    if (view && topic.viewpoint) {
      const feet = session.comments.toLocal(view.x, view.y, view.z);
      const floor = session.pick(vec3(feet.x, feet.y, feet.z + 0.5), vec3(0, 0, -1), 0.9);
      view.flying = !(floor && floor.normal.z > 0.7);
      view.section = BcfMapping.toSection(topic.viewpoint.clippingPlanes, frame).cut ?? new SectionCut();
      record.view = view;

      const eye = vec3(feet.x, feet.y, feet.z + CharacterController.STAND_EYE);
      const cp = Math.cos(view.pitch);
      const look = vec3(cp * Math.cos(view.yaw), cp * Math.sin(view.yaw), Math.sin(view.pitch));
      const hit = session.pick(eye, look, 300);
      if (hit) {
        marker = vec3(hit.point.x + hit.normal.x * 0.06, hit.point.y + hit.normal.y * 0.06, hit.point.z + hit.normal.z * 0.06);
        if (element < 0) { element = hit.element; }
      } else if (element >= 0) {
        marker = scene.elements[element].bounds.center;
      } else {
        marker = vec3(eye.x + look.x * 2, eye.y + look.y * 2, eye.z + look.z * 2);
      }
    } else if (element >= 0) {
      marker = scene.elements[element].bounds.center;
    } else {
      // No camera and no element: at the player, so it can be found and moved on
      const p = session.player.feet;
      marker = vec3(p.x, p.y, p.z + 1.2);
    }

    session.comments.setMarker(record, marker);
    record.level = session.levelNameAt(marker.z);
    if (element >= 0 && element < scene.elements.length) {
      const found = scene.elements[element];
      const foreign = found.link > 0 || found.isLibraryTemplate;
      record.elementId = foreign ? -1 : found.elementId;
      record.elementUniqueId = foreign || !found.uniqueId ? null : found.uniqueId;
    }
  }

  /** The element a viewpoint selects: by IFC GUID (any model), else by the authoring tool's id (host ElementId), else -1. */
  private findElement(viewpoint: BcfViewpoint | null): number {
    const session = this.session;
    for (const component of viewpoint?.selection ?? []) {
      if (component.ifcGuid) {
        const index = session.elementIndexOfIfcGuid(component.ifcGuid);
        if (index >= 0) { return index; }
      }
      const id = component.authoringToolId?.trim() ?? '';
      if (/^-?\d+$/.test(id)) {
        const index = session.elementIndexOf(null, Number(id));
        if (index >= 0) { return index; }
      }
    }
    return -1;
  }

  // #endregion
}

/** The thumbnail's JPEG bytes (older comments without a larger picture), or null. */
function thumbnailBytes(record: CommentRecord): Uint8Array | null {
  if (!record.thumbnail) { return null; }
  try {
    const text = atob(record.thumbnail);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) { bytes[i] = text.charCodeAt(i); }
    return bytes;
  } catch {
    return null;
  }
}

/** A picture as PNG bytes (BCF viewers expect snapshot.png), or null when it can't be read. */
async function toPng(image: Uint8Array | null): Promise<Uint8Array | null> {
  if (!image || image.length === 0) { return null; }
  try {
    const bitmap = await createImageBitmap(new Blob([image as BlobPart]));
    const blob = await drawScaled(bitmap, bitmap.width, bitmap.height, false, 'image/png', 1);
    bitmap.close();
    return new Uint8Array(await blob.arrayBuffer());
  } catch (e) {
    console.info('Comment picture not converted for BCF', e);
    return null;
  }
}

/**
 * The topic's snapshot as the comment's thumbnail (192 × 108, centre-cropped) and BCF picture (JPEG, at most 1280 px
 * wide). Unreadable images leave the comment without pictures.
 */
async function importPictures(record: CommentRecord, topic: BcfTopic): Promise<void> {
  if (!topic.snapshot || topic.snapshot.length === 0) { return; }
  try {
    const bitmap = await createImageBitmap(new Blob([topic.snapshot as BlobPart]));
    const thumb = await drawScaled(bitmap, THUMB_WIDTH, THUMB_HEIGHT, true, 'image/jpeg', 0.72);
    record.thumbnail = await base64(thumb);
    const width = Math.min(SNAPSHOT_MAX_WIDTH, bitmap.width);
    const height = Math.max(1, Math.round(bitmap.height * width / Math.max(1, bitmap.width)));
    record.snapshotData = new Uint8Array(await (await drawScaled(bitmap, width, height, false, 'image/jpeg', 0.82)).arrayBuffer());
    record.snapshot = CommentSnapshots.nameFor(record.id);
    bitmap.close();
  } catch (e) {
    console.info(`BCF snapshot of ${guidN(topic.guid)} unreadable`, e);
  }
}

/** Draws an image into a new size (crop: the centre part of the target's aspect) and encodes it. */
export function drawScaled(image: CanvasImageSource & { width: number; height: number }, width: number, height: number, crop: boolean,
  type: string, quality: number): Promise<Blob> {
  let sx = 0, sy = 0, sw = image.width, sh = image.height;
  if (crop) {
    const aspect = width / height;
    if (image.width / image.height > aspect) { sw = Math.trunc(image.height * aspect); sx = (image.width - sw) / 2; }
    else { sh = Math.trunc(image.width / aspect); sy = (image.height - sh) / 2; }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encoding failed'))), type, quality));
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) { text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); }
  return btoa(text);
}
