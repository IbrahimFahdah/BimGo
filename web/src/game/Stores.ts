import {
  type BookmarkDocument, type BookmarkRecord, cleanComment, type CommentDocument, CommentPriority, type CommentRecord, type CommentReply,
  CommentSnapshots, CommentStatus, currentUser, type SunTime
} from '../core/format/DocumentModels';
import type { SectionCut } from '../core/scene/SectionCut';
import { newId } from '../core/format/Json';
import { type Vec3, vec3 } from '../core/math/Vector';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => n.toString().padStart(2, '0');

/** "dd MMM HH:mm" in local time. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * The comments of a walkthrough (port of BimGo.App/Game/CommentStore.cs, file mode). Records keep Revit internal
 * coordinates; each also carries its scene-local position and list header. They live in the document: saving the
 * .bimgo writes them (Phase 4).
 */
export class CommentStore {
  readonly comments: CommentRecord[] = [];
  revision = 0;
  lastError: string | null = null;
  /** Where comments go, for messages. */
  readonly fileName = 'this file';
  onChanged: (() => void) | null = null;

  constructor(private readonly model: string, private readonly origin: Vec3) {}

  loadFrom(document: CommentDocument | null): void {
    for (const record of document?.comments ?? []) {
      if (!record.text.trim()) { continue; }
      this.prepare(record);
      this.comments.push(record);
    }
  }

  toDocument(): CommentDocument {
    return { version: 1, model: this.model, units: 'metres, Revit internal coordinates', comments: [...this.comments] };
  }

  add(local: Vec3, text: string, elementId: number, level: string | null, elementUniqueId: string | null = null): CommentRecord {
    const record: CommentRecord = {
      id: newId(),
      author: currentUser,
      created: new Date().toISOString(),
      text: text.trim(),
      x: round4(local.x + this.origin.x),
      y: round4(local.y + this.origin.y),
      z: round4(local.z + this.origin.z),
      elementId,
      level: level ?? '',
      edited: null,
      editedBy: null,
      status: CommentStatus.OPEN,
      assignedTo: null,
      priority: CommentPriority.NORMAL,
      updated: null,
      updatedBy: null,
      replies: null,
      view: null,
      thumbnail: null,
      elementUniqueId: elementUniqueId || null,
      snapshot: null,
      snapshotData: null,
      local: vec3(),
      header: ''
    };
    this.prepare(record);
    this.comments.push(record);
    this.save();
    return record;
  }

  /**
   * Sets a comment's status, priority and / or assignee (undefined leaves a field alone; an empty assignee clears
   * it), recording who and when.
   * @returns False if the comment is not in this store or nothing changed.
   */
  setIssue(record: CommentRecord, change: { status?: string; priority?: string; assignedTo?: string }): boolean {
    if (!this.comments.includes(record)) { return false; }
    let changed = false;
    if (change.status !== undefined && CommentStatus.normalise(change.status) !== record.status) {
      record.status = CommentStatus.normalise(change.status);
      changed = true;
    }
    if (change.priority !== undefined && CommentPriority.normalise(change.priority) !== record.priority) {
      record.priority = CommentPriority.normalise(change.priority);
      changed = true;
    }
    if (change.assignedTo !== undefined) {
      const assignee = change.assignedTo.trim() || null;
      if (assignee !== record.assignedTo) {
        record.assignedTo = assignee;
        changed = true;
      }
    }
    if (!changed) { return false; }
    record.updated = new Date().toISOString();
    record.updatedBy = currentUser;
    this.save();
    return true;
  }

  /** Adds a reply to a comment's thread; null for an unknown comment or empty text. */
  addReply(record: CommentRecord, text: string): CommentReply | null {
    if (!this.comments.includes(record) || !text.trim()) { return null; }
    const reply: CommentReply = { id: newId(), author: currentUser, created: new Date().toISOString(), text: text.trim() };
    (record.replies ??= []).push(reply);
    this.save();
    return reply;
  }

  removeReply(record: CommentRecord, reply: CommentReply): void {
    const i = record.replies?.indexOf(reply) ?? -1;
    if (i < 0) { return; }
    record.replies!.splice(i, 1);
    if (record.replies!.length === 0) { record.replies = null; }
    this.save();
  }

  /** Sets the viewpoint a comment is seen from (scene-local feet; stored in Revit internal metres). */
  setView(record: CommentRecord, localFeet: Vec3, yaw: number, pitch: number, flying: boolean, section: SectionCut | null = null): void {
    record.view = {
      x: round4(localFeet.x + this.origin.x), y: round4(localFeet.y + this.origin.y), z: round4(localFeet.z + this.origin.z),
      yaw, pitch, flying, section: section?.clone() ?? null
    };
    if (this.comments.includes(record)) { this.save(); }
  }

  /** The scene-local feet of a comment's saved view, or null when it has none. */
  viewFeet(record: CommentRecord): Vec3 | null {
    const v = record.view;
    return v ? vec3(v.x - this.origin.x, v.y - this.origin.y, v.z - this.origin.z) : null;
  }

  /** Stores a comment's thumbnail (base64 JPEG). */
  setThumbnail(record: CommentRecord, data: string): void {
    if (!data) { return; }
    record.thumbnail = data;
    if (this.comments.includes(record)) { this.save(); }
  }

  /**
   * Stores a comment's thumbnail (base64 JPEG) and, when given, the larger picture kept for BCF snapshots (JPEG bytes,
   * saved as comments/<id>.jpg in the .bimgo), then saves once.
   */
  setPictures(record: CommentRecord, thumbnail: string | null, snapshot: Uint8Array | null): void {
    if (thumbnail) { record.thumbnail = thumbnail; }
    if (snapshot && snapshot.length > 0) {
      record.snapshot = CommentSnapshots.nameFor(record.id);
      record.snapshotData = snapshot;
    }
    if (this.comments.includes(record)) { this.save(); }
  }

  /** Moves a comment's marker (scene-local) without saving: imports place markers before one save. */
  setMarker(record: CommentRecord, local: Vec3): void {
    record.x = round4(local.x + this.origin.x);
    record.y = round4(local.y + this.origin.y);
    record.z = round4(local.z + this.origin.z);
    record.local = vec3(local.x, local.y, local.z);
  }

  /** The scene-local position of an internal point (for imported views). */
  toLocal(x: number, y: number, z: number): Vec3 {
    return vec3(x - this.origin.x, y - this.origin.y, z - this.origin.z);
  }

  /** Finishes a BCF import with one save: new comments join the list, merged ones get their labels rebuilt. */
  applyImport(added: readonly CommentRecord[], merged: readonly CommentRecord[]): void {
    for (const record of added) {
      if (!record.text.trim() || this.comments.includes(record)) { continue; }
      this.prepare(record);
      this.comments.push(record);
    }
    for (const record of merged) {
      if (this.comments.includes(record)) { this.prepare(record); }
    }
    this.save();
  }

  /** The comment with this id (case-insensitive), or null. */
  find(id: string): CommentRecord | null {
    if (!id) { return null; }
    const lower = id.toLowerCase();
    return this.comments.find(c => c.id.toLowerCase() === lower) ?? null;
  }

  update(record: CommentRecord, text: string): boolean {
    if (!this.comments.includes(record) || !text.trim()) { return false; }
    text = text.trim();
    if (text === record.text) { return true; }
    record.text = text;
    record.edited = new Date().toISOString();
    record.editedBy = currentUser;
    this.prepare(record);
    this.save();
    return true;
  }

  remove(record: CommentRecord): void {
    const i = this.comments.indexOf(record);
    if (i >= 0) {
      this.comments.splice(i, 1);
      this.save();
    }
  }

  clear(): void {
    this.comments.length = 0;
    this.save();
  }

  private save(): void {
    this.revision++;
    this.onChanged?.();
  }

  private prepare(record: CommentRecord): void {
    cleanComment(record);
    record.local = vec3(record.x - this.origin.x, record.y - this.origin.y, record.z - this.origin.z);
    record.header = `COMMENT · ${record.author.toUpperCase()} · ${shortDate(record.created)}${record.edited ? ' · EDITED' : ''}`;
  }
}

/**
 * Saved viewpoints and the home position (port of BimGo.App/Game/BookmarkStore.cs, file mode).
 */
export class BookmarkStore {
  static readonly MAX_NAME = 60;

  readonly bookmarks: BookmarkRecord[] = [];
  home: BookmarkRecord | null = null;
  revision = 0;
  lastError: string | null = null;
  readonly fileName = 'this file';
  onChanged: (() => void) | null = null;

  constructor(private readonly model: string, private readonly origin: Vec3) {}

  loadFrom(document: BookmarkDocument | null): void {
    if (document?.home) {
      this.home = document.home;
      this.prepare(this.home);
    }
    for (const record of document?.bookmarks ?? []) {
      this.prepare(record);
      this.bookmarks.push(record);
    }
  }

  toDocument(): BookmarkDocument {
    return { version: 1, model: this.model, units: 'metres, Revit internal coordinates; angles in radians', bookmarks: [...this.bookmarks], home: this.home };
  }

  setHome(localFeet: Vec3, yaw: number, pitch: number, flying: boolean, level: string): void {
    this.home ??= this.blank('Home');
    this.setPosition(this.home, localFeet);
    Object.assign(this.home, { yaw, pitch, flying, level: level ?? '', author: currentUser, created: new Date().toISOString() });
    this.prepare(this.home);
    this.save();
  }

  setThumbnail(record: BookmarkRecord, thumbnail: string): boolean {
    if (!this.bookmarks.includes(record)) { return false; }
    record.thumbnail = thumbnail;
    this.save();
    return true;
  }

  nextDefaultName(): string {
    for (let n = this.bookmarks.length + 1; n < this.bookmarks.length + 1000; n++) {
      const name = `View ${n}`;
      if (!this.bookmarks.some(b => b.name.toLowerCase() === name.toLowerCase())) { return name; }
    }
    return 'View';
  }

  add(name: string | null, localFeet: Vec3, yaw: number, pitch: number, flying: boolean, level: string, sun: SunTime | null = null,
    section: SectionCut | null = null): BookmarkRecord {
    const record = this.createPending(name, localFeet, yaw, pitch, flying, level, sun, section);
    this.bookmarks.push(record);
    this.save();
    return record;
  }

  /** A bookmark that joins the list only once its name is confirmed (B). */
  createPending(name: string | null, localFeet: Vec3, yaw: number, pitch: number, flying: boolean, level: string, sun: SunTime | null = null,
    section: SectionCut | null = null): BookmarkRecord {
    const record = this.blank(BookmarkStore.cleanName(name) ?? this.nextDefaultName());
    Object.assign(record, { yaw, pitch, flying, level: level ?? '', sun: sun ? { ...sun } : null, section: section?.clone() ?? null });
    this.setPosition(record, localFeet);
    this.prepare(record);
    return record;
  }

  addPending(record: BookmarkRecord, name: string): void {
    if (this.bookmarks.includes(record)) { return; }
    record.name = BookmarkStore.cleanName(name) ?? record.name;
    this.bookmarks.push(record);
    this.save();
  }

  rename(record: BookmarkRecord, name: string): boolean {
    const clean = BookmarkStore.cleanName(name);
    if (!this.bookmarks.includes(record) || clean === null) { return false; }
    if (clean !== record.name) {
      record.name = clean;
      this.save();
    }
    return true;
  }

  update(record: BookmarkRecord, localFeet: Vec3, yaw: number, pitch: number, flying: boolean, level: string, sun: SunTime | null = null,
    section: SectionCut | null = null): boolean {
    if (!this.bookmarks.includes(record)) { return false; }
    this.setPosition(record, localFeet);
    Object.assign(record, { yaw, pitch, flying, level: level ?? '', sun: sun ? { ...sun } : null, section: section?.clone() ?? null });
    this.prepare(record);
    this.save();
    return true;
  }

  move(record: BookmarkRecord, direction: number): boolean {
    const index = this.bookmarks.indexOf(record);
    const target = index + Math.sign(direction);
    if (index < 0 || target < 0 || target >= this.bookmarks.length) { return false; }
    this.bookmarks.splice(index, 1);
    this.bookmarks.splice(target, 0, record);
    this.save();
    return true;
  }

  remove(record: BookmarkRecord): void {
    const i = this.bookmarks.indexOf(record);
    if (i >= 0) {
      this.bookmarks.splice(i, 1);
      this.save();
    }
  }

  static cleanName(name: string | null): string | null {
    if (!name?.trim()) { return null; }
    const trimmed = name.trim();
    return trimmed.length > BookmarkStore.MAX_NAME ? trimmed.slice(0, BookmarkStore.MAX_NAME).trimEnd() : trimmed;
  }

  private save(): void {
    this.revision++;
    this.onChanged?.();
  }

  private blank(name: string): BookmarkRecord {
    return {
      id: newId(), name, author: currentUser, created: new Date().toISOString(), x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
      flying: false, level: '', sun: null, section: null, thumbnail: null, local: vec3(), detail: ''
    };
  }

  private setPosition(record: BookmarkRecord, localFeet: Vec3): void {
    record.x = round4(localFeet.x + this.origin.x);
    record.y = round4(localFeet.y + this.origin.y);
    record.z = round4(localFeet.z + this.origin.z);
  }

  private prepare(record: BookmarkRecord): void {
    record.local = vec3(record.x - this.origin.x, record.y - this.origin.y, record.z - this.origin.z);
    const level = record.level || '—';
    const fly = record.flying ? ' · FLY' : '';
    const s = record.sun;
    const sun = s ? ` · SUN ${s.day}/${s.month} ${two(Math.trunc(s.minutes / 60))}:${two(s.minutes % 60)}` : '';
    record.detail = `${level} · ${record.author} · ${shortDate(record.created)}${fly}${sun}`;
  }
}
