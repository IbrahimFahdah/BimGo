import {
  type CameraKey, type CameraPath, CameraPathLimits, type CameraPathDocument, cleanPath, copyKey, copyPath, emptyPaths, keyHasTarget, newCameraKey,
  newCameraPath, pathCopyFrom
} from '../core/format/CameraPathModels';
import { clamp, f32, type Vec3, vec3 } from '../core/math/Vector';

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Round K-A (port of PathStore): the session's keyframed camera paths, kept like bookmarks: in the .bimgo file
 * (paths.json, saved with it) or, in a live Revit session, beside the model (the session sends the sidecar when the
 * revision changes). Positions are kept in Revit internal metres (like bookmarks); CameraKey.local is the scene-local
 * copy.
 */
export class PathStore {
  /** Longest path or key name accepted. */
  static readonly MAX_NAME = 60;

  /** All paths, in list order. */
  readonly paths: CameraPath[] = [];
  /** The last error, or null (kept for parity with the desktop; the browser's store doesn't write files itself). */
  lastError: string | null = null;
  /** Where paths are kept (for the panel's sub-line). */
  readonly fileName: string;
  /** Incremented on every change (dirty tracking, the live sidecar and the panel's cached timings). */
  revision = 0;

  constructor(private readonly model: string, private readonly origin: Vec3, live: boolean) {
    this.fileName = live ? 'the model folder' : 'this file';
  }

  // #region Load / save

  /** Loads paths from a document (a .bimgo's paths.json or the live sidecar). Not a change. */
  loadFrom(document: CameraPathDocument | null): void {
    for (const path of document?.paths ?? []) {
      if (!path) { continue; }
      cleanPath(path);
      for (const key of path.keys) { this.prepare(key); }
      this.paths.push(path);
    }
  }

  /** The paths as a document (for the file or the sidecar). */
  toDocument(): CameraPathDocument {
    const document = emptyPaths();
    document.model = this.model;
    document.paths = [...this.paths];
    return document;
  }

  /** The paths for a .bimgo (null when there are none). */
  forFile(): CameraPathDocument | null { return this.paths.length === 0 ? null : this.toDocument(); }

  /** Records a change (the file is marked changed; a live session sends the sidecar). */
  save(): boolean {
    this.revision++;
    return true;
  }

  // #endregion

  // #region Paths

  /** The next free default path name: "Path 1", "Path 2"… */
  nextPathName(): string {
    for (let n = this.paths.length + 1; n < this.paths.length + 1000; n++) {
      const name = `Path ${n}`;
      if (!this.paths.some(p => sameName(p.name, name))) { return name; }
    }
    return 'Path';
  }

  /** Adds an empty path and saves. */
  addPath(): CameraPath {
    const path = newCameraPath(this.nextPathName());
    this.paths.push(path);
    this.save();
    return path;
  }

  /**
   * Round K-C: adds a path built elsewhere (CONVERT TO PATH) at the end and saves. Its keys' stored positions are set
   * from their scene-local ones; its name is made unique ("… 2", "… 3"…). Null when it is already in the store.
   */
  addBuiltPath(path: CameraPath): CameraPath | null {
    if (this.paths.includes(path)) { return null; }
    path.keys ??= [];
    for (const key of path.keys) {
      this.setPosition(key, key.local);
      if (key.targetLocal) {
        key.targetX = round4(key.targetLocal.x + this.origin.x);
        key.targetY = round4(key.targetLocal.y + this.origin.y);
        key.targetZ = round4(key.targetLocal.z + this.origin.z);
      }
    }
    cleanPath(path);
    for (const key of path.keys) { this.prepare(key); }
    path.name = this.uniqueName(PathStore.cleanName(path.name) ?? this.nextPathName());
    this.paths.push(path);
    this.save();
    return path;
  }

  /** K-C: a name no other path has: the name itself, else "name 2", "name 3"… */
  uniqueName(name: string): string {
    const taken = (candidate: string) => this.paths.some(p => sameName(p.name, candidate));
    if (!taken(name)) { return name; }
    for (let n = 2; n < 1000; n++) {
      const candidate = PathStore.cleanName(`${name} ${n}`) ?? name;
      if (!taken(candidate)) { return candidate; }
    }
    return name;
  }

  /** Adds a copy of a path (" copy" on its name) after it and saves. */
  duplicate(path: CameraPath): CameraPath | null {
    const index = this.paths.indexOf(path);
    if (index < 0) { return null; }
    const copy = copyPath(path);
    copy.name = PathStore.cleanName(path.name + ' copy') ?? path.name;
    for (const key of copy.keys) { this.prepare(key); }
    this.paths.splice(index + 1, 0, copy);
    this.save();
    return copy;
  }

  /** Renames a path and saves (false when it isn't in the store or the name is empty). */
  rename(path: CameraPath, name: string): boolean {
    const clean = PathStore.cleanName(name);
    if (!this.paths.includes(path) || clean === null) { return false; }
    if (clean === path.name) { return true; }
    path.name = clean;
    this.save();
    return true;
  }

  /** Removes a path and saves. */
  remove(path: CameraPath): void {
    const index = this.paths.indexOf(path);
    if (index < 0) { return; }
    this.paths.splice(index, 1);
    this.save();
  }

  /** Moves a path one place up (-1) or down (+1) and saves. */
  move(path: CameraPath, direction: number): boolean {
    const index = this.paths.indexOf(path);
    const target = index + Math.sign(direction);
    if (index < 0 || target < 0 || target >= this.paths.length) { return false; }
    this.paths.splice(index, 1);
    this.paths.splice(target, 0, path);
    this.save();
    return true;
  }

  // #endregion

  // #region Keys

  /** The next free default key name in a path: "Key 1", "Key 2"… */
  static nextKeyName(path: CameraPath | null): string {
    const count = path?.keys.length ?? 0;
    for (let n = count + 1; n < count + 1000; n++) {
      const name = `Key ${n}`;
      if (!path || !path.keys.some(k => sameName(k.name, name))) { return name; }
    }
    return 'Key';
  }

  /** Adds a key at a scene-local eye position and view, at index (or the end), and saves. Null when the path is full. */
  addKey(path: CameraPath, index: number, localEye: Vec3, yaw: number, pitch: number): CameraKey | null {
    if (!this.paths.includes(path) || path.keys.length >= CameraPathLimits.MAX_KEYS) { return null; }
    const key = newCameraKey();
    key.name = PathStore.nextKeyName(path);
    key.yaw = f32(yaw);
    key.pitch = f32(clamp(pitch, -1.5, 1.5));
    this.setPosition(key, localEye);
    this.prepare(key);
    path.keys.splice(clamp(index < 0 ? path.keys.length : index, 0, path.keys.length), 0, key);
    this.save();
    return key;
  }

  /**
   * Moves a key to a new scene-local eye position and view (SET TO THIS VIEW) and saves.
   * @param save False while a handle is being dragged (K-B): the change is counted (the path redraws) but not saved
   * until touch() at the end of the drag.
   */
  setKeyView(path: CameraPath, key: CameraKey, localEye: Vec3, yaw: number, pitch: number, save = true): boolean {
    if (!this.owns(path, key)) { return false; }
    this.setPosition(key, localEye);
    key.yaw = f32(yaw);
    key.pitch = f32(clamp(pitch, -1.5, 1.5));
    this.prepare(key);
    if (save) { this.save(); } else { this.revision++; }
    return true;
  }

  /** Sets (or with null clears) a key's look-at target from a scene-local point and saves. */
  setKeyTarget(path: CameraPath, key: CameraKey, localTarget: Vec3 | null, save = true): boolean {
    if (!this.owns(path, key)) { return false; }
    if (localTarget) {
      key.targetX = round4(localTarget.x + this.origin.x);
      key.targetY = round4(localTarget.y + this.origin.y);
      key.targetZ = round4(localTarget.z + this.origin.z);
    } else {
      key.targetX = key.targetY = key.targetZ = null;
    }
    this.prepare(key);
    if (save) { this.save(); } else { this.revision++; }
    return true;
  }

  /** Round K-B: undo: puts a path back as a snapshot had it (the same object; its keys are fresh copies) and saves. */
  restore(path: CameraPath, snapshot: CameraPath): boolean {
    if (!this.paths.includes(path)) { return false; }
    pathCopyFrom(path, snapshot);
    for (const key of path.keys) { this.prepare(key); }
    this.save();
    return true;
  }

  /** Renames a key and saves. */
  renameKey(path: CameraPath, key: CameraKey, name: string): boolean {
    const clean = PathStore.cleanName(name);
    if (!this.owns(path, key) || clean === null) { return false; }
    if (clean === key.name) { return true; }
    key.name = clean;
    this.save();
    return true;
  }

  /** Moves a key one place up (-1) or down (+1) and saves. */
  moveKey(path: CameraPath, key: CameraKey, direction: number): boolean {
    if (!this.owns(path, key)) { return false; }
    const index = path.keys.indexOf(key);
    const target = index + Math.sign(direction);
    if (target < 0 || target >= path.keys.length) { return false; }
    path.keys.splice(index, 1);
    path.keys.splice(target, 0, key);
    this.save();
    return true;
  }

  /** Removes a key and saves. */
  removeKey(path: CameraPath, key: CameraKey): void {
    if (!this.owns(path, key)) { return; }
    path.keys.splice(path.keys.indexOf(key), 1);
    this.save();
  }

  /** Inserts a copy of a key after it (DUPLICATE; " copy" on its name) and saves. Null when the path is full. */
  duplicateKey(path: CameraPath, key: CameraKey): CameraKey | null {
    if (!this.owns(path, key) || path.keys.length >= CameraPathLimits.MAX_KEYS) { return null; }
    const copy = copyKey(key);
    copy.name = PathStore.cleanName(key.name + ' copy') ?? key.name;
    this.prepare(copy);
    path.keys.splice(path.keys.indexOf(key) + 1, 0, copy);
    this.touch(path);
    return copy;
  }

  /** A field of a path or key changed (the panel edits them in place): re-cleans the path and records the change. */
  touch(path: CameraPath | null): void {
    if (!path || !this.paths.includes(path)) { return; }
    cleanPath(path);
    this.save();
  }

  private owns(path: CameraPath | null, key: CameraKey | null): boolean {
    return !!path && !!key && this.paths.includes(path) && path.keys.includes(key);
  }

  // #endregion

  // #region Helpers

  /** A trimmed name limited to MAX_NAME characters, or null if empty. */
  static cleanName(name: string | null | undefined): string | null {
    if (!name || !name.trim()) { return null; }
    const trimmed = name.trim();
    return trimmed.length > PathStore.MAX_NAME ? trimmed.slice(0, PathStore.MAX_NAME).trimEnd() : trimmed;
  }

  private setPosition(key: CameraKey, localEye: Vec3): void {
    key.x = round4(localEye.x + this.origin.x);
    key.y = round4(localEye.y + this.origin.y);
    key.z = round4(localEye.z + this.origin.z);
  }

  /** Fills a key's scene-local positions from its stored (Revit internal) ones. */
  private prepare(key: CameraKey): void {
    const o = this.origin;
    key.local = vec3(f32(key.x - o.x), f32(key.y - o.y), f32(key.z - o.z));
    key.targetLocal = keyHasTarget(key) ? vec3(f32(key.targetX! - o.x), f32(key.targetY! - o.y), f32(key.targetZ! - o.z)) : null;
  }

  // #endregion
}
