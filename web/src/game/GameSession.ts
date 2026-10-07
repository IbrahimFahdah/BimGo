import type { BimGoDocument } from '../core/format/BimGoReader';
import type { BookmarkRecord, CommentRecord } from '../core/format/DocumentModels';
import { setCurrentUser } from '../core/format/DocumentModels';
import { Mat4 } from '../core/math/Matrix4x4';
import { clamp, type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import { CATEGORIES, findCategory, KEY_DOORS } from '../core/scene/CategoryCatalog';
import type { RoomInfo, SceneData } from '../core/scene/SceneData';
import { CoordinateReadout, SharedTransform, SiteCoordinates } from '../core/scene/SiteCoordinates';
import { gl } from '../engine/gl/Gl';
import { Bvh, type RayHit } from '../engine/physics/Bvh';
import { CharacterController } from '../engine/physics/CharacterController';
import { FpsCamera } from '../engine/render/FpsCamera';
import { Overlay3D } from '../engine/render/Overlay3D';
import { SceneBatches } from '../engine/render/SceneBatches';
import { type SceneDrawParams, SceneRenderer } from '../engine/render/SceneRenderer';
import { Rgba } from '../engine/ui/Rgba';
import { TextBuffer } from '../engine/ui/TextBuffer';
import { roundEven, UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId, SoundSystem } from '../platform/audio';
import { downloadBlob, safeFileName } from '../platform/files';
import { type InputState, Vk } from '../platform/input';
import type { GameWindow } from '../platform/window';
import { CommentGun } from './guns/CommentGun';
import type { AimInfo, Gun, GunHost, Highlight } from './guns/Gun';
import { MeasureGun } from './guns/MeasureGun';
import { PortalGun } from './guns/PortalGun';
import { ScanGun } from './guns/ScanGun';
import { TeleportGun } from './guns/TeleportGun';
import { PauseMenu, TextEditor } from './Menus';
import { Player } from './Player';
import { BookmarkStore, CommentStore } from './Stores';
import type { ViewerSettings } from './ViewerSettings';
import { ColourMode } from './ViewerSettings';

/** Why a walkthrough ended. */
export type SessionEnd = 'closed';

const HELP_ROWS: [string, string][] = [
  ['WASD', 'Move'],
  ['SPACE / CTRL', 'Jump / Crouch'],
  ['SHIFT', 'Run'],
  ['V', 'Fly / walk (no-clip)'],
  ['PGUP / PGDN', 'Level up / down'],
  ['H · SHIFT+H', 'Go home · Set home here'],
  ['1–5 · WHEEL', 'Select tool'],
  ['I · SHIFT+I', 'Scan: hide target · isolate its category'],
  ['X', "Clear this tool's markers"],
  ['B · ALT+1–9', 'Bookmark this view · Go to bookmark'],
  ['L', 'Coordinate readout'],
  ['TAB · ESC / P', 'Minimap · Pause menu'],
  ['F11 · SHIFT+F12', 'Fullscreen · Screenshot'],
  ['F1', 'Hide help · BimGo Web ' + __BIMGO_VERSION__]
];

const THUMB_WIDTH = 192, THUMB_HEIGHT = 108;

/**
 * One walkthrough of a model (port of BimGo.App/Game/GameSession.cs with its Render, Visibility, Coordinates,
 * Bookmarks, Screenshot and Thumbnails partials; menus and text entry live in Menus.ts). The browser drives it one
 * animation frame at a time.
 */
export class GameSession implements GunHost {
  private static readonly TICK = 1 / 120;
  private static readonly PICK_DISTANCE = 250;
  private static readonly GROUND_BELOW_LOWEST_LEVEL = 0.1;
  static readonly MAP_METRES_ACROSS = 34;

  // #region Systems

  readonly scene: SceneData;
  readonly camera = new FpsCamera();
  readonly text = new TextBuffer();
  readonly sound = new SoundSystem();
  readonly overlay = new Overlay3D();
  batches!: SceneBatches;
  renderer!: SceneRenderer;
  private bvh!: Bvh;
  player!: Player;
  comments!: CommentStore;
  bookmarks!: BookmarkStore;
  guns: Gun[] = [];
  activeGun = 0;
  portalGun!: PortalGun;
  commentGun!: CommentGun;
  readonly menu: PauseMenu;
  readonly editor: TextEditor;
  aim: AimInfo = { hasHit: false, hit: null, origin: vec3(), direction: vec3(1, 0, 0) };

  // #endregion

  // #region Visibility and lookups

  readonly categoryVisible: boolean[];
  readonly linkVisible: boolean[];
  readonly groupVisible: boolean[];
  private readonly pickMask: boolean[];
  private readonly collisionMask: boolean[];
  private readonly userHidden: boolean[];
  userHiddenCount = 0;
  private isolateBackup: boolean[] | null = null;
  private readonly elementIndexById = new Map<number, number>();
  private readonly elementIndexByUniqueId = new Map<string, number>();
  private readonly levelNamesUpper: string[];
  private readonly doorCategory: number;

  // #endregion

  // #region State

  showHelp = true;
  showMap = true;
  groundZ = 0;
  groundDefault = 0;
  paused = false;
  ended = false;
  clock = 0;
  homeSetUntil = -1;
  private startedAtSavedHome = false;
  private accumulator = 0;
  private roomIndex = -1;
  private roomCheckedAt: Vec3 = vec3(Infinity, Infinity, Infinity);
  private roomBannerUntil = 0;
  private toastText: string | null = null;
  private toastUntil = 0;
  private flashColour = 0;
  private flashUntil = 0;
  private flashLength = 0;
  private fps = 0;
  private frameMs = 0;
  private fpsAccumulator = 0;
  private fpsFrames = 0;
  private readonly mapPlanes = new Float32Array(24);
  private readonly highlights: Highlight[] = [];
  private helpScale = -1;
  private helpKeyWidth = 0;
  private helpActionWidth = 0;

  // Coordinates
  private shared: SharedTransform | null = null;
  private projectBase: [number, number, number] | null = null;

  // Screenshots and thumbnails
  private screenshotRequested = false;
  thumbnailFor: BookmarkRecord | null = null;
  private readonly thumbnailTextures = new Map<BookmarkRecord, { data: string; texture: WebGLTexture | null }>();

  // #endregion

  constructor(
    private readonly window: GameWindow,
    readonly ui: UiBatch,
    readonly document: BimGoDocument,
    readonly settings: ViewerSettings
  ) {
    const scene = document.scene;
    this.scene = scene;
    this.categoryVisible = [...scene.categoryLoaded];
    this.linkVisible = new Array<boolean>(scene.links.length + 1).fill(true);
    this.groupVisible = new Array<boolean>(SceneBatches.groupCount(scene)).fill(false);
    this.updateGroupVisibility();
    this.pickMask = new Array<boolean>(scene.elements.length).fill(false);
    this.collisionMask = new Array<boolean>(scene.elements.length).fill(false);
    this.userHidden = new Array<boolean>(scene.elements.length).fill(false);
    scene.elements.forEach((record, e) => {
      // Only host elements are looked up by id: linked models have their own id namespaces
      if (record.link > 0) { return; }
      if (!this.elementIndexById.has(record.elementId)) { this.elementIndexById.set(record.elementId, e); }
      if (record.uniqueId && !this.elementIndexByUniqueId.has(record.uniqueId)) { this.elementIndexByUniqueId.set(record.uniqueId, e); }
    });
    this.doorCategory = findCategory(KEY_DOORS)?.index ?? -1;
    this.levelNamesUpper = scene.levels.map(l => l.name.toUpperCase());
    this.menu = new PauseMenu(this);
    this.editor = new TextEditor(this);
    setCurrentUser(settings.userName);

    this.shared = SiteCoordinates.tryGetShared(scene.site);
    this.projectBase = SiteCoordinates.tryGetProjectBase(scene.site);
    if (!this.isReadoutAvailable(settings.coordinateReadout)) { settings.coordinateReadout = CoordinateReadout.Off; }
  }

  // #region GunHost

  get uiScale(): number { return this.ui.scale; }
  get screenWidth(): number { return this.window.width; }
  get screenHeight(): number { return this.window.height; }
  get input(): InputState { return this.window.input; }
  get isEditingComment(): boolean { return this.editor.active; }
  get editPoint(): Vec3 { return this.editor.point; }
  get currentLevelName(): string { return this.levelNameAt(this.player.feet.z); }
  get isCaptured(): boolean { return this.window.isCaptured; }

  // #endregion

  // #region Setup

  /**
   * Sorts the geometry, builds the collision tree and uploads to the GPU. Yields between the steps so the caller's
   * progress screen can draw.
   */
  async prepare(report: (stage: string, fraction: number) => void, signal: AbortSignal): Promise<void> {
    const started = performance.now();
    report('Sorting the geometry for drawing', 0);
    await nextFrame();
    this.batches = new SceneBatches(this.scene);
    throwIfAborted(signal);

    report('Building collision and picking', 0.45);
    await nextFrame();
    this.bvh = new Bvh(this.scene);
    throwIfAborted(signal);

    report('Uploading geometry…', 0.9);
    await nextFrame();
    this.renderer = new SceneRenderer();
    this.renderer.initialise(this.scene, this.batches);
    this.overlay.initialise();
    this.sound.initialise();
    console.info(`Batches ${this.batches.batches.length} / chunks ${this.batches.chunkTotal}, BVH nodes ${this.bvh.nodeCount} in ${Math.round(performance.now() - started)} ms.`);

    const controller = new CharacterController(this.bvh);
    controller.stepHeight = this.settings.maxStepHeightMm / 1000;
    controller.collisionMask = this.collisionMask;
    this.player = new Player(controller);
    this.refreshMasks();

    // Ground: just below the lowest level (or the model)
    this.groundDefault = (this.scene.levels.length > 0 ? this.scene.levels[0].elevation : this.scene.bounds.min.z) - GameSession.GROUND_BELOW_LOWEST_LEVEL;
    this.groundZ = this.groundDefault;
    controller.groundZ = this.groundZ;

    // Comments and bookmarks live in the file
    this.comments = new CommentStore(this.scene.modelTitle, this.scene.originOffset);
    this.comments.loadFrom(this.document.comments);
    this.bookmarks = new BookmarkStore(this.scene.modelTitle, this.scene.originOffset);
    this.bookmarks.loadFrom(this.document.bookmarks);
    this.initialiseVisibility();

    this.portalGun = new PortalGun(this);
    this.commentGun = new CommentGun(this);
    this.guns = [new ScanGun(this), new MeasureGun(this), this.portalGun, this.commentGun, new TeleportGun(this)];
    this.guns.forEach((g, i) => { g.key = String(i + 1); });

    this.spawn();
    this.window.setTitle(`${this.scene.modelTitle} · BimGo`);

    const links = this.scene.links.length > 0 ? ` · ${this.scene.links.length} linked model${this.scene.links.length === 1 ? '' : 's'}` : '';
    const edits = this.document.journal.count > 0 ? ` · ${this.document.journal.count} saved edit${this.document.journal.count === 1 ? '' : 's'} (not shown yet)` : '';
    const start = this.startedAtSavedHome ? ' Starting at your saved home (Shift+H sets it).' : '';
    if (this.scene.phaseNote) { this.toast(this.scene.phaseNote, 6); }
    else {
      this.toast(`${this.scene.elements.length.toLocaleString('en')} elements · ${(this.scene.geometry.indices.length / 3).toLocaleString('en')} triangles${links}${edits}.${start} Click to look around.`,
        this.startedAtSavedHome ? 4 : 2.6);
    }
  }

  private spawn(): void {
    const player = this.player;
    const home = this.bookmarks.home;
    if (home) {
      if (home.flying !== player.flying) { player.toggleFly(); }
      player.teleportTo(home.local, home.yaw, clamp(home.pitch, -1.5, 1.5));
      player.setHome();
      this.startedAtSavedHome = true;
      return;
    }

    const spawn = this.scene.spawn;
    if (spawn) {
      const feet = vec3(spawn.eye.x, spawn.eye.y, spawn.eye.z - CharacterController.STAND_EYE);
      player.teleportTo(feet, spawn.yaw, spawn.pitch);
      // Far above everything (e.g. an aerial perspective)? Start flying so nobody falls 100 m.
      if (feet.z > this.scene.bounds.max.z + 2) { player.toggleFly(); }
    } else {
      const { feet, yaw } = this.findRandomSpawn();
      player.teleportTo(feet, yaw, 0);
    }
    player.setHome();
  }

  private findRandomSpawn(): { feet: Vec3; yaw: number } {
    const bounds = this.scene.bounds;
    const size = bounds.size, centre = bounds.center;
    const baseZ = this.scene.levels.length > 0 ? this.scene.levels[0].elevation : bounds.min.z;

    for (let attempt = 0; attempt < 60; attempt++) {
      const x = bounds.min.x + Math.random() * size.x, y = bounds.min.y + Math.random() * size.y;
      let feet: Vec3;
      const hit = this.pick(vec3(x, y, baseZ + 1.7), vec3(0, 0, -1), 2.6);
      if (hit) {
        if (hit.normal.z < 0.7) { continue; }
        feet = vec3(hit.point.x, hit.point.y, hit.point.z + 0.02);
      } else {
        feet = vec3(x, y, this.groundZ);
      }
      if (!this.player.controller.overlaps(vec3(feet.x, feet.y, feet.z + 0.01), CharacterController.STAND_HEIGHT)) {
        return { feet, yaw: Math.atan2(centre.y - feet.y, centre.x - feet.x) };
      }
    }
    // Fallback: outside the model's south side, facing it
    return { feet: vec3(centre.x, bounds.min.y - 5, this.groundZ), yaw: Math.PI * 0.5 };
  }

  refreshMasks(): void {
    this.updateGroupVisibility();
    const elements = this.scene.elements;
    for (let e = 0; e < elements.length; e++) {
      const visible = this.groupVisible[SceneBatches.groupOf(elements[e])] && !this.userHidden[e];
      this.pickMask[e] = visible;
      // Doors render as modelled but are always no-clip, so openings stay walkable
      this.collisionMask[e] = visible && elements[e].categoryIndex !== this.doorCategory;
    }
  }

  private updateGroupVisibility(): void {
    const categories = this.categoryVisible.length;
    for (let g = 0; g < this.groupVisible.length; g++) {
      this.groupVisible[g] = this.categoryVisible[g % categories] && this.linkVisible[Math.trunc(g / categories)];
    }
  }

  // #endregion

  // #region Loop

  /**
   * Runs one frame.
   * @returns 'closed' when the walkthrough ended, else null.
   */
  frame(dt: number): SessionEnd | null {
    this.clock += dt;
    this.updateFrame();
    if (this.ended) { return 'closed'; }

    if (!this.paused) {
      this.accumulator += dt;
      let ticks = 0;
      while (this.accumulator >= GameSession.TICK && ticks < 12) {
        this.fixedUpdate(GameSession.TICK);
        this.accumulator -= GameSession.TICK;
        ticks++;
      }
      if (ticks === 12) { this.accumulator = 0; }
    }

    this.updateCamera(this.paused ? 1 : this.accumulator / GameSession.TICK, dt);
    this.updateAim();
    this.updateGuns(dt);
    this.render();
    this.updateFps(dt);
    return this.ended ? 'closed' : null;
  }

  /** Called when the browser released the mouse (Esc, focus loss). */
  onCaptureLost(): void {
    if (!this.paused && !this.editor.active) { this.setPaused(true); }
  }

  private updateFrame(): void {
    const input = this.window.input;
    if (this.window.isMinimised && !this.paused && !this.editor.active) { this.setPaused(true); }

    if (this.editor.active) {
      this.editor.update(input);
      return;
    }

    // Esc releases the mouse in the browser (onCaptureLost pauses); P and Esc toggle while it is free, and Esc
    // first closes an open list (comments / bookmarks)
    if (input.isPressed(Vk.ESCAPE) || input.isPressed(Vk.key('P'))) {
      if (!(this.paused && input.isPressed(Vk.ESCAPE) && this.menu.closePanels())) { this.setPaused(!this.paused); }
    }
    if (input.isPressed(Vk.F1)) { this.showHelp = !this.showHelp; }
    if (input.isPressed(Vk.F11)) { toggleFullscreen(); }
    if (input.isPressed(Vk.F12) && input.isDown(Vk.SHIFT)) { this.screenshotRequested = true; }

    // Alt+1..9 (Ctrl+1..9 in fullscreen, where the browser lets the page have it): jump to a bookmark
    if (!this.paused && (input.isDown(Vk.MENU) || input.isDown(Vk.CONTROL))) {
      for (let i = 0; i < 9; i++) {
        if (input.isPressed(0x31 + i)) {
          this.goToBookmarkAt(i);
          return;
        }
      }
    }
    if (this.paused) { return; }

    this.updateRoom();

    if (input.isPressed(Vk.TAB)) { this.showMap = !this.showMap; }
    if (input.isPressed(Vk.key('V'))) {
      this.player.toggleFly();
      this.toast(this.player.flying ? 'Fly mode (no-clip)' : 'Walk mode');
    }
    if (input.isPressed(Vk.key('H'))) {
      if (input.isDown(Vk.SHIFT)) { this.setHomeHere(); }
      else { this.player.goHome(); }
    }
    if (input.isPressed(Vk.PRIOR)) { this.teleportLevel(+1); }
    if (input.isPressed(Vk.NEXT)) { this.teleportLevel(-1); }
    if (input.isPressed(Vk.key('X'))) { this.guns[this.activeGun].clearMarkers(); }
    if (input.isPressed(Vk.key('B'))) {
      this.addBookmarkHere();
      return;
    }
    if (input.isPressed(Vk.key('L'))) { this.cycleCoordinateReadout(); }
    if (input.isPressed(Vk.SPACE) && !this.player.flying) { this.player.queueJump(); }

    for (let i = 0; i < this.guns.length; i++) {
      if (input.isPressed(0x31 + i) && !input.isDown(Vk.MENU) && !input.isDown(Vk.CONTROL)) { this.selectGun(i); }
    }
    if (input.wheel !== 0) {
      const n = this.guns.length;
      this.selectGun(((this.activeGun - Math.sign(input.wheel)) % n + n) % n);
    }

    this.guns[this.activeGun].onKeys(input);
    this.updateMouseLook(input);
  }

  private updateMouseLook(input: InputState): void {
    if (!this.window.isCaptured && input.leftPressed) {
      this.window.setCaptured(true);
      input.consumeClicks();
    }
    if (this.window.isCaptured) {
      this.player.look(input.mouseDeltaX, input.mouseDeltaY, this.settings.mouseSensitivity, this.settings.invertY);
    }
  }

  private fixedUpdate(dt: number): void {
    this.player.controller.groundZ = this.groundZ;
    const frozen = this.editor.active || this.window.isMinimised || this.guns[this.activeGun].capturesInput;
    this.player.fixedUpdate(dt, this.window.input, !frozen);
    this.portalGun.checkTeleport(this.player, dt);
  }

  private updateCamera(alpha: number, dt: number): void {
    const c = this.camera;
    c.position = this.player.getEye(clamp(alpha, 0, 1), dt);
    c.yaw = this.player.yaw;
    c.pitch = this.player.pitch;
    c.horizontalFovDegrees = this.settings.fieldOfView;
    c.viewportWidth = this.window.width;
    c.viewportHeight = this.window.height;
    c.aspect = this.window.width / Math.max(this.window.height, 1);
    c.update();
  }

  private updateAim(): void {
    const hit = this.pick(this.camera.position, this.camera.forward, GameSession.PICK_DISTANCE);
    this.aim = { hasHit: hit !== null, hit, origin: this.camera.position, direction: this.camera.forward };
  }

  private updateGuns(dt: number): void {
    for (const gun of this.guns) { gun.tick(dt); }
    if (this.paused || this.editor.active) { return; }

    const active = this.guns[this.activeGun];
    active.update(dt, this.aim);
    const input = this.window.input;
    if (this.window.isCaptured) {
      if (input.leftPressed) { active.onPrimary(this.aim); }
      if (input.rightPressed) { active.onSecondary(this.aim); }
    }
  }

  private updateFps(dt: number): void {
    this.fpsAccumulator += dt;
    this.fpsFrames++;
    if (this.fpsAccumulator >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccumulator;
      this.frameMs = this.fpsAccumulator * 1000 / this.fpsFrames;
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }
  }

  // #endregion

  // #region Actions

  selectGun(index: number): void {
    if (index === this.activeGun || this.guns[this.activeGun].capturesInput) { return; }
    this.guns[this.activeGun].onDeselect();
    this.activeGun = index;
    this.sound.play(SoundId.UiClick);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.window.setCaptured(!paused);
    this.window.input.releaseAll();
  }

  /** Frees the mouse for typing (the comment / bookmark name box) without pausing. */
  releaseMouseForTyping(): void {
    this.window.setCaptured(false);
    this.window.input.releaseAll();
  }

  setHomeHere(): void {
    this.player.setHome();
    this.bookmarks.setHome(this.player.feet, this.player.yaw, this.player.pitch, this.player.flying, this.currentLevelName);
    this.homeSetUntil = this.clock + 2;
    this.sound.play(SoundId.Commit);
    this.flash(UiTheme.BOOKMARK, 0.2);
    this.toast('Home set here: H returns here (stored with the file once saving is available)', 3.5);
  }

  private teleportLevel(direction: number): void {
    const levels = this.scene.levels;
    if (levels.length === 0) { return; }

    const feetZ = this.player.feet.z;
    const current = this.levelIndexAt(feetZ);
    const target = clamp(current + direction, 0, levels.length - 1);
    if (target === current && !(current === 0 && direction > 0 && feetZ < levels[0].elevation - 0.5)) {
      this.toast(direction > 0 ? 'Already on the top level' : 'Already on the lowest level');
      return;
    }

    const level = levels[target];
    const feet = vec3(this.player.feet.x, this.player.feet.y, level.elevation + 0.02);
    if (!this.player.flying) {
      const hit = this.pick(vec3(feet.x, feet.y, level.elevation + 1.7), vec3(0, 0, -1), 2.4);
      if (hit && hit.normal.z > 0.7) { feet.z = hit.point.z + 0.02; }
    }
    this.player.teleportTo(feet);
    this.toast(level.name);
  }

  levelIndexAt(z: number): number {
    let index = 0;
    this.scene.levels.forEach((l, i) => { if (l.elevation <= z + 0.4) { index = i; } });
    return index;
  }

  levelNameAt(z: number): string {
    return this.scene.levels.length === 0 ? '—' : this.scene.levels[this.levelIndexAt(z)].name;
  }

  toast(message: string, seconds = 2.6): void {
    this.toastText = message;
    this.toastUntil = this.clock + seconds;
  }

  flash(colour: number, seconds: number): void {
    this.flashColour = colour;
    this.flashLength = seconds;
    this.flashUntil = this.clock + seconds;
  }

  pick(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null {
    return this.bvh.raycast(origin, direction, maxDistance, this.pickMask);
  }

  isTargetPresent(element: number, _dynamicId: number): boolean {
    return element >= 0 && !this.userHidden[element];
  }

  // #endregion

  // #region Comments (editor in Menus.ts)

  beginCommentEdit(point: Vec3, elementId: number, level: string): void {
    this.editor.beginComment(point, elementId, level);
  }

  editComment(record: CommentRecord): void {
    this.editor.editComment(record);
  }

  /** Stands the player near a comment, looking at it. */
  teleportToComment(record: CommentRecord): void {
    const marker = record.local;
    // Approach from the player's side (so we don't end up on the far side of a wall)
    let dx = marker.x - this.player.feet.x, dy = marker.y - this.player.feet.y;
    const l = Math.hypot(dx, dy);
    if (l > 0.1) { dx /= l; dy /= l; } else { dx = 1; dy = 0; }

    const floorZ = this.scene.levels.length > 0 ? this.scene.levels[this.levelIndexAt(marker.z)].elevation : marker.z - 1.2;
    let feet = this.floorAt(marker.x - dx * 1.6, marker.y - dy * 1.6, floorZ);
    // Blocked (inside a wall or furniture)? Stand under the marker instead
    if (this.player.controller.overlaps(vec3(feet.x, feet.y, feet.z + 0.01), CharacterController.STAND_HEIGHT)) {
      feet = this.floorAt(marker.x, marker.y, floorZ);
    }

    const look = V.sub(marker, vec3(feet.x, feet.y, feet.z + CharacterController.STAND_EYE));
    const yaw = Math.atan2(look.y, look.x);
    const pitch = Math.atan2(look.z, Math.max(0.01, Math.hypot(look.x, look.y)));
    if (this.player.flying) { this.player.toggleFly(); }
    this.player.teleportTo(feet, yaw, clamp(pitch, -1.2, 1.2));
  }

  private floorAt(x: number, y: number, floorZ: number): Vec3 {
    const feet = vec3(x, y, floorZ + 0.02);
    const hit = this.pick(vec3(x, y, floorZ + 1.7), vec3(0, 0, -1), 2.4);
    if (hit && hit.normal.z > 0.7) { feet.z = hit.point.z + 0.02; }
    return feet;
  }

  exportComments(): void {
    downloadBlob(this.comments.exportCsv(), `${safeFileName(this.scene.modelTitle)} comments.csv`);
  }

  // #endregion

  // #region Bookmarks

  private addBookmarkHere(): void {
    const p = this.player;
    const record = this.bookmarks.createPending(null, p.feet, p.yaw, p.pitch, p.flying, this.currentLevelName, null);
    this.thumbnailFor = record;
    this.sound.play(SoundId.CommentPlace);
    this.editor.renameBookmark(record, true);
  }

  addBookmarkFromMenu(): BookmarkRecord {
    const p = this.player;
    const added = this.bookmarks.add(null, p.feet, p.yaw, p.pitch, p.flying, this.currentLevelName, null);
    this.thumbnailFor = added;
    return added;
  }

  setBookmarkHere(record: BookmarkRecord): void {
    const p = this.player;
    this.bookmarks.update(record, p.feet, p.yaw, p.pitch, p.flying, this.currentLevelName, null);
    this.thumbnailFor = record;
    this.sound.play(SoundId.Commit);
  }

  private goToBookmarkAt(index: number): void {
    const list = this.bookmarks.bookmarks;
    if (index < 0 || index >= list.length) {
      this.toast(list.length === 0
        ? 'No bookmarks yet: press B to save this viewpoint'
        : `Only ${list.length} bookmark${list.length === 1 ? '' : 's'} (Esc → BOOKMARKS lists them)`);
      return;
    }
    this.goToBookmark(list[index]);
  }

  goToBookmark(record: BookmarkRecord): void {
    if (record.flying !== this.player.flying) { this.player.toggleFly(); }
    this.player.teleportTo(record.local, record.yaw, clamp(record.pitch, -1.5, 1.5));
    this.sound.play(SoundId.Teleport);
    this.flash(UiTheme.BOOKMARK, 0.25);
    this.toast(record.name);
  }

  bookmarkHotkey(record: BookmarkRecord): string {
    const index = this.bookmarks.bookmarks.indexOf(record);
    return index >= 0 && index < 9 ? `Alt+${index + 1}` : 'Esc → BOOKMARKS';
  }

  /** The thumbnail texture of a bookmark (decoded once, asynchronously; null until ready or when unreadable). */
  thumbnailTexture(record: BookmarkRecord): WebGLTexture | null {
    const data = record.thumbnail;
    if (!data) { return null; }
    const cached = this.thumbnailTextures.get(record);
    if (cached && cached.data === data) { return cached.texture; }
    if (cached?.texture) { gl.deleteTexture(cached.texture); }

    const entry: { data: string; texture: WebGLTexture | null } = { data, texture: null };
    this.thumbnailTextures.set(record, entry);
    const mime = data.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
    fetch(`data:${mime};base64,${data}`)
      .then(r => r.blob())
      .then(blob => createImageBitmap(blob))
      .then(bitmap => {
        if (this.thumbnailTextures.get(record) !== entry) { return; }
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        bitmap.close();
        entry.texture = texture;
      })
      .catch(e => console.info(`Bookmark thumbnail unreadable (${record.name}): ${e instanceof Error ? e.message : String(e)}`));
    return null;
  }

  // #endregion

  // #region Visibility

  get hiddenThingsCount(): number {
    let count = this.userHiddenCount;
    this.categoryVisible.forEach((visible, c) => { if (this.scene.categoryLoaded[c] && !visible) { count++; } });
    for (let l = 1; l < this.linkVisible.length; l++) { if (!this.linkVisible[l]) { count++; } }
    return count;
  }

  private initialiseVisibility(): void {
    const saved = this.document.visibility;
    if (!saved) { return; }

    for (const key of saved.hiddenCategories) {
      const def = findCategory(key);
      if (def && this.scene.categoryLoaded[def.index]) { this.categoryVisible[def.index] = false; }
    }
    const linkByKey = new Map<string, number>();
    for (const link of this.scene.links) {
      if (link.instanceUniqueId && !linkByKey.has(link.instanceUniqueId)) { linkByKey.set(link.instanceUniqueId, link.index); }
    }
    for (const key of saved.hiddenLinks) {
      const index = linkByKey.get(key);
      if (index !== undefined) { this.linkVisible[index] = false; }
    }

    // Elements: host by UniqueId (else id), linked by (link, UniqueId)
    let linked: Map<string, number> | null = null;
    for (const item of saved.hiddenElements) {
      let element = -1;
      if (!item.link) {
        element = (item.uniqueId ? this.elementIndexByUniqueId.get(item.uniqueId) : undefined) ?? this.elementIndexById.get(item.id) ?? -1;
      } else {
        const link = linkByKey.get(item.link);
        if (link !== undefined && item.uniqueId) {
          linked ??= new Map(this.scene.elements.flatMap((r, e) => (r.link > 0 && r.uniqueId ? [[`${r.link}|${r.uniqueId}`, e] as [string, number]] : [])));
          element = linked.get(`${link}|${item.uniqueId}`) ?? -1;
        }
      }
      if (element >= 0) { this.setUserHidden(element, true); }
    }
    this.refreshMasks();
  }

  private setUserHidden(element: number, hidden: boolean): void {
    if (element < 0 || this.userHidden[element] === hidden) { return; }
    this.userHidden[element] = hidden;
    this.userHiddenCount += hidden ? 1 : -1;
    this.renderer.setElementHidden(element, hidden);
    const visible = !hidden && this.groupVisible[SceneBatches.groupOf(this.scene.elements[element])];
    this.pickMask[element] = visible;
    this.collisionMask[element] = visible && this.scene.elements[element].categoryIndex !== this.doorCategory;
  }

  hideElement(element: number, _dynamicId: number): void {
    if (element < 0) { return; }
    this.setUserHidden(element, true);
    this.sound.play(SoundId.UiClick);
    this.toast(`Hidden: ${this.scene.elements[element].name} (${this.userHiddenCount} hidden · Esc → SHOW ALL brings them back)`);
  }

  toggleIsolateCategory(element: number): void {
    this.sound.play(SoundId.UiClick);
    if (this.isolateBackup) {
      this.isolateBackup.forEach((v, i) => { this.categoryVisible[i] = v; });
      this.isolateBackup = null;
      this.refreshMasks();
      this.toast('Isolation ended: categories shown as before');
      return;
    }
    if (element < 0) { return; }

    const category = this.scene.elements[element].categoryIndex;
    this.isolateBackup = [...this.categoryVisible];
    for (let c = 0; c < this.categoryVisible.length; c++) { this.categoryVisible[c] = c === category && this.scene.categoryLoaded[c]; }
    this.refreshMasks();
    this.toast(`Showing only ${CATEGORIES[category].label} (Shift+I again shows the rest)`);
  }

  showAll(): void {
    for (let e = 0; e < this.userHidden.length && this.userHiddenCount > 0; e++) {
      if (this.userHidden[e]) { this.setUserHidden(e, false); }
    }
    this.scene.categoryLoaded.forEach((loaded, c) => { this.categoryVisible[c] = loaded; });
    this.linkVisible.fill(true);
    this.isolateBackup = null;
    this.refreshMasks();
    this.sound.play(SoundId.UiClick);
    this.toast('All hidden elements, categories and links are shown again');
  }

  // #endregion

  // #region Coordinates

  private isReadoutAvailable(readout: CoordinateReadout): boolean {
    switch (readout) {
      case CoordinateReadout.Shared: return this.shared !== null;
      case CoordinateReadout.Project: return this.projectBase !== null;
      default: return true;
    }
  }

  private cycleCoordinateReadout(): void {
    let next = this.settings.coordinateReadout;
    for (let i = 0; i < 4; i++) {
      next = (next + 1) % 4;
      if (this.isReadoutAvailable(next)) { break; }
    }
    this.settings.coordinateReadout = next;
    this.settings.save();
    this.sound.play(SoundId.UiClick);
    const message = next === CoordinateReadout.Shared
      ? this.shared?.approximate ? 'Coordinates: shared (approximate: export again from Revit for millimetre accuracy)' : 'Coordinates: shared (survey)'
      : next === CoordinateReadout.Project ? 'Coordinates: project (from the project base point)'
        : next === CoordinateReadout.Internal ? 'Coordinates: Revit internal' : 'Coordinates off';
    this.toast(message, 3);
  }

  private buildCoordinatePanel(f: FontAtlas, x: number, y: number): void {
    const readout = this.settings.coordinateReadout;
    if (readout === CoordinateReadout.Off) { return; }
    const ui = this.ui;
    const w = this.s(250), h = this.s(100);
    ui.panel(x, y, w, h, UiTheme.PANEL, UiTheme.PANEL_BORDER);

    const title = readout === CoordinateReadout.Shared ? (this.shared?.approximate ? 'SHARED COORDINATES ≈' : 'SHARED COORDINATES')
      : readout === CoordinateReadout.Project ? 'PROJECT COORDINATES' : 'INTERNAL COORDINATES';
    ui.text(f.small, x + this.s(14), y + this.s(10), title, UiTheme.TEXT_MUTED, this.s(1));
    ui.textRight(f.small, x + w - this.s(14), y + this.s(10), this.aim.hasHit ? 'AIM · L' : 'FEET · L', UiTheme.TEXT_FAINT, this.s(1));

    // The crosshair's hit, else where the player stands (scene-local → internal)
    const local = this.aim.hit ? this.aim.hit.point : this.player.feet;
    const o = this.scene.originOffset;
    const ix = local.x + o.x, iy = local.y + o.y, iz = local.z + o.z;
    let values: [number, number, number];
    if (readout === CoordinateReadout.Shared && this.shared) { values = this.shared.apply(ix, iy, iz); }
    else if (readout === CoordinateReadout.Project && this.projectBase) {
      values = [ix - this.projectBase[0], iy - this.projectBase[1], iz - this.projectBase[2]];
    } else { values = [ix, iy, iz]; }

    const grid = readout === CoordinateReadout.Shared;
    const labels = grid ? ['E', 'N', 'ELEV'] : ['X', 'Y', 'Z'];
    values.forEach((value, i) => {
      const rowY = y + this.s(32) + i * this.s(20);
      ui.text(f.body, x + this.s(14), rowY, labels[i], UiTheme.TEXT_MUTED);
      ui.textRight(f.mono, x + w - this.s(14), rowY + this.s(1), this.text.clear().appendNumber(value, 3).append(' m').text, UiTheme.COORDS);
    });
  }

  // #endregion

  // #region Rooms

  get currentRoom(): RoomInfo | null {
    return this.roomIndex >= 0 ? this.scene.rooms[this.roomIndex] : null;
  }

  private updateRoom(): void {
    if (this.scene.rooms.length === 0) { return; }
    const feet = this.player.feet, last = this.roomCheckedAt;
    const dx = feet.x - last.x, dy = feet.y - last.y, dz = feet.z - last.z;
    if (dx * dx + dy * dy + dz * dz < 0.05 * 0.05) { return; }
    this.roomCheckedAt = vec3(feet.x, feet.y, feet.z);

    const room = this.findRoom(feet.x, feet.y, feet.z + 0.3);
    if (room === this.roomIndex) { return; }
    this.roomIndex = room;
    if (room >= 0) { this.roomBannerUntil = this.clock + 2.4; }
  }

  /** The smallest room volume containing the point, or −1. Host rooms win over linked rooms. */
  private findRoom(x: number, y: number, z: number): number {
    let best = -1, bestHeight = Number.MAX_VALUE, bestIsHost = false;
    this.scene.rooms.forEach((room, i) => {
      const isHost = room.link === 0;
      if (bestIsHost && !isHost) { return; }
      if (z < room.bottomZ || z > room.topZ) { return; }
      if (x < room.min.x || x > room.max.x || y < room.min.y || y > room.max.y) { return; }
      let inside = false;
      for (const loop of room.loops) { if (insidePolygon(loop, x, y)) { inside = !inside; } }
      if (!inside) { return; }
      const height = room.topZ - room.bottomZ;
      if (height < bestHeight || (isHost && !bestIsHost)) {
        best = i;
        bestHeight = height;
        bestIsHost = isHost;
      }
    });
    return best;
  }

  // #endregion

  // #region Render

  private sceneParams(): SceneDrawParams {
    return {
      viewProjection: this.camera.viewProjection,
      planes: this.camera.planes,
      eye: this.camera.position,
      whitecard: this.settings.whitecard,
      realistic: this.settings.colour === ColourMode.Realistic,
      plan: false,
      clipZMin: -1e7,
      clipZMax: 1e7,
      fogDensity: 0.0022,
      sun: true
    };
  }

  private render(): void {
    const width = this.window.width, height = this.window.height;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    const fog = SceneRenderer.FOG_COLOUR;
    gl.clearColor(fog.x, fog.y, fog.z, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    this.renderer.drawSky(this.camera);
    const p = this.sceneParams();
    this.renderer.drawStatic(p, this.groupVisible, false);
    this.renderer.drawGround(this.camera, this.groundZ);

    // Gun highlights (scan target…)
    const active = this.guns[this.activeGun];
    this.highlights.length = 0;
    if (!this.paused) { active.collectHighlights(this.highlights); }
    if (this.highlights.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -2);
      for (const h of this.highlights) {
        if (h.element >= 0 && this.pickMask[h.element]) {
          const [r, g, b] = Rgba.toVector(h.colour);
          this.renderer.drawElementHighlight(p, h.element, r, g, b, h.strength);
        }
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.BLEND);
    }

    // Transparent pass (glass etc.)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    this.renderer.drawStatic(p, this.groupVisible, true);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // Markers: depth-tested, then a faint x-ray copy so markers behind walls stay discoverable
    this.overlay.begin(this.camera);
    this.guns.forEach((gun, i) => gun.drawWorld(this.overlay, i === this.activeGun));
    this.overlay.draw(this.camera, true, 1, false);
    this.overlay.draw(this.camera, false, 0.16, false);

    // Captures of the 3D view (no HUD)
    if (this.thumbnailFor) { this.captureThumbnail(width, height); }
    if (this.screenshotRequested) { this.captureScreenshot(width, height); }

    // ---- Window pass: minimap 3D, then all 2D UI in one batch
    gl.viewport(0, 0, width, height);
    const mapX = width - this.s(20) - this.s(220), mapY = this.s(20);
    if (this.showMap && !this.paused) { this.drawMinimapPlan(mapX + this.s(8), mapY + this.s(30), this.s(204), this.s(170)); }

    if (this.paused) { this.menu.build(); }
    else {
      this.buildHud(mapX, mapY);
      if (this.editor.active) { this.editor.build(); }
    }
    this.ui.flush(width, height);
  }

  private drawMinimapPlan(x: number, y: number, w: number, h: number): void {
    const height = this.window.height;
    const vx = Math.trunc(x), vy = height - Math.trunc(y + h), vw = Math.max(1, Math.trunc(w)), vh = Math.max(1, Math.trunc(h));

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, vy, vw, vh);
    gl.viewport(vx, vy, vw, vh);
    const [r, g, b] = Rgba.toVector(UiTheme.MAP_BACKGROUND);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const feet = this.player.feet;
    const elevation = this.scene.levels.length > 0 ? this.scene.levels[this.levelIndexAt(feet.z)].elevation : feet.z;
    const metresAcross = GameSession.MAP_METRES_ACROSS;
    const eye = vec3(feet.x, feet.y, elevation + 60);
    const view = Mat4.createLookAt(eye, vec3(eye.x, eye.y, eye.z - 1), vec3(0, 1, 0));
    const viewProjection = Mat4.multiply(view, FpsCamera.orthographic(metresAcross, metresAcross * h / w, 1, 200));
    FpsCamera.extractPlanes(viewProjection, this.mapPlanes);

    gl.enable(gl.DEPTH_TEST);
    this.renderer.drawStatic({
      viewProjection, planes: this.mapPlanes, eye, whitecard: this.settings.whitecard, realistic: false,
      plan: true, clipZMin: elevation - 0.3, clipZMax: elevation + 1.2, fogDensity: 0, sun: false
    }, this.groupVisible, false);

    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.window.width, this.window.height);
  }

  private drawMinimapOverlay(x: number, y: number): void {
    const ui = this.ui, f = ui.atlas;
    const w = this.s(220), h = this.s(208);
    const mapX = x + this.s(8), mapY = y + this.s(30), mapW = this.s(204), mapH = this.s(170);

    // Frame: header strip and border only (the plan itself was drawn in 3D)
    ui.rect(x, y, w, this.s(30), UiTheme.PANEL);
    ui.rect(x, y + this.s(30), this.s(8), h - this.s(30), UiTheme.PANEL);
    ui.rect(x + w - this.s(8), y + this.s(30), this.s(8), h - this.s(30), UiTheme.PANEL);
    ui.rect(x + this.s(8), y + h - this.s(8), w - this.s(16), this.s(8), UiTheme.PANEL);
    ui.outline(x, y, w, h, Math.max(1, roundEven(this.ui.scale)), UiTheme.PANEL_BORDER);

    const feet = this.player.feet;
    const levelIndex = this.levelIndexAt(feet.z);
    ui.text(f.small, x + this.s(8), y + this.s(9), 'MAP · ' + (this.levelNamesUpper[levelIndex] ?? '—'), UiTheme.TEXT_MUTED, this.s(1));
    ui.textRight(f.small, x + w - this.s(8), y + this.s(9), 'TAB', UiTheme.TEXT_MUTED, this.s(1));

    const metresPerPixel = GameSession.MAP_METRES_ACROSS / mapW;
    const cx = mapX + mapW * 0.5, cy = mapY + mapH * 0.5;
    const mapDot = (world: Vec3, colour: number, radius: number) => {
      const mx = cx + (world.x - feet.x) / metresPerPixel, my = cy - (world.y - feet.y) / metresPerPixel;
      if (mx < mapX + radius || mx > mapX + mapW - radius || my < mapY + radius || my > mapY + mapH - radius) { return; }
      ui.circle(mx, my, radius, colour, 12);
    };

    // Portals, comments and bookmarks on this level
    for (let i = 0; i < 2; i++) {
      if (!this.portalGun.isActive(i)) { continue; }
      const c = this.portalGun.centreOf(i);
      if (this.levelIndexAt(c.z - 1) === levelIndex) { mapDot(c, PortalGun.colourOf(i), this.s(4)); }
    }
    for (const record of this.comments.comments) {
      if (this.levelIndexAt(record.local.z - 0.5) === levelIndex) { mapDot(record.local, UiTheme.COMMENT, this.s(3.5)); }
    }
    for (const bookmark of this.bookmarks.bookmarks) {
      if (this.levelIndexAt(bookmark.local.z) === levelIndex) { mapDot(bookmark.local, UiTheme.BOOKMARK, this.s(3)); }
    }

    // View cone and player arrow (north up, screen Y down)
    const angle = -this.player.yaw;
    const halfFov = this.settings.fieldOfView * Math.PI / 360;
    ui.wedge(cx, cy, this.s(56), angle - halfFov, angle + halfFov, Rgba.withAlpha(UiTheme.ACCENT, 0.13));
    const fx = Math.cos(angle), fy = Math.sin(angle), sx = -fy, sy = fx;
    const tip = [cx + fx * this.s(10), cy + fy * this.s(10)];
    const left = [cx - fx * this.s(6) + sx * this.s(7), cy - fy * this.s(6) + sy * this.s(7)];
    const right = [cx - fx * this.s(6) - sx * this.s(7), cy - fy * this.s(6) - sy * this.s(7)];
    const notch = [cx - fx * this.s(2), cy - fy * this.s(2)];
    ui.triangle(tip[0], tip[1], left[0], left[1], notch[0], notch[1], UiTheme.ACCENT);
    ui.triangle(tip[0], tip[1], notch[0], notch[1], right[0], right[1], UiTheme.ACCENT);
  }

  // #endregion

  // #region Captures

  /** Reads the 3D view (bottom-up RGBA) right after drawing, before the browser presents it. */
  private readView(width: number, height: number): Uint8Array {
    const pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  /** The view as a top-down canvas (opaque). */
  private viewCanvas(width: number, height: number): HTMLCanvasElement {
    const pixels = this.readView(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(width, height);
    const stride = width * 4;
    for (let y = 0; y < height; y++) {
      image.data.set(pixels.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
    }
    for (let i = 3; i < image.data.length; i += 4) { image.data[i] = 255; }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  private captureScreenshot(width: number, height: number): void {
    this.screenshotRequested = false;
    if (width <= 0 || height <= 0) { return; }
    const canvas = this.viewCanvas(width, height);
    const d = new Date();
    const two = (n: number) => n.toString().padStart(2, '0');
    const name = `${safeFileName(this.scene.modelTitle)} ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.png`;
    this.sound.play(SoundId.UiClick);
    this.flash(0x60ffffff, 0.12);
    canvas.toBlob(blob => {
      if (!blob) {
        this.toast('Screenshot failed');
        return;
      }
      downloadBlob(blob, name);
      this.toast(`Screenshot saved: ${name} (your Downloads folder)`, 4);
    }, 'image/png');
  }

  private captureThumbnail(width: number, height: number): void {
    const record = this.thumbnailFor;
    this.thumbnailFor = null;
    if (!record || width < 16 || height < 16) { return; }

    try {
      // Centre crop to 16:9, scaled down by the browser
      const source = this.viewCanvas(width, height);
      const aspect = THUMB_WIDTH / THUMB_HEIGHT;
      let cropW = width, cropH = height;
      if (width / height > aspect) { cropW = Math.trunc(height * aspect); } else { cropH = Math.trunc(width / aspect); }
      const thumb = document.createElement('canvas');
      thumb.width = THUMB_WIDTH;
      thumb.height = THUMB_HEIGHT;
      const context = thumb.getContext('2d')!;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, (width - cropW) / 2, (height - cropH) / 2, cropW, cropH, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
      const data = thumb.toDataURL('image/jpeg', 0.72).replace(/^data:image\/jpeg;base64,/, '');
      if (this.bookmarks.bookmarks.includes(record)) { this.bookmarks.setThumbnail(record, data); }
      else { record.thumbnail = data; } // pending (B): saved when its name is confirmed
    } catch (e) {
      console.info(`Bookmark thumbnail failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // #endregion

  // #region HUD

  private buildHud(mapX: number, mapY: number): void {
    const ui = this.ui, f = ui.atlas;
    const width = this.window.width, height = this.window.height;
    const active = this.guns[this.activeGun];

    // Screen flash (portals, teleports)
    if (this.clock < this.flashUntil) {
      const t = (this.flashUntil - this.clock) / Math.max(this.flashLength, 0.01);
      ui.rect(0, 0, width, height, Rgba.withAlpha(this.flashColour, 0.35 * t));
    }

    // World-anchored labels
    this.guns.forEach((gun, i) => gun.drawLabels(ui, i === this.activeGun));

    // Crosshair
    const cx = roundEven(width * 0.5), cy = roundEven(height * 0.5);
    const t1 = this.s(2), gap = this.s(5), arm = this.s(9);
    ui.rect(cx - t1 * 0.5, cy - gap - arm, t1, arm, UiTheme.TEXT);
    ui.rect(cx - t1 * 0.5, cy + gap, t1, arm, UiTheme.TEXT);
    ui.rect(cx - gap - arm, cy - t1 * 0.5, arm, t1, UiTheme.TEXT);
    ui.rect(cx + gap, cy - t1 * 0.5, arm, t1, UiTheme.TEXT);
    ui.circle(cx, cy, this.s(1.8), active.colour, 10);

    if (!this.window.isCaptured && !this.editor.active) {
      const hint = 'Click to look around';
      const hintWidth = UiBatch.measure(f.body, hint) + this.s(24);
      ui.panel(cx - hintWidth * 0.5, cy + this.s(28), hintWidth, this.s(28), UiTheme.PANEL, UiTheme.PANEL_BORDER);
      ui.textCentred(f.body, cx, cy + this.s(34), hint, UiTheme.TEXT);
    }

    this.buildStatusPanel(f);
    this.buildCoordinatePanel(f, this.s(20), this.s(20) + this.s(146) + this.s(10));

    // Minimap and the gun's context panel beneath it
    if (this.showMap) { this.drawMinimapOverlay(mapX, mapY); }
    const panelTop = this.showMap ? mapY + this.s(208) + this.s(12) : this.s(20);
    const panelWidth = this.s(260), panelX = width - this.s(20) - panelWidth;
    ui.panel(panelX, panelTop, panelWidth, this.s(active.panelHeight) + this.s(24), UiTheme.PANEL, UiTheme.PANEL_BORDER);
    active.drawPanel(ui, panelX + this.s(14), panelTop + this.s(12), panelWidth - this.s(28));

    this.buildHelp(f, height);
    this.buildGunBar(f, width, height, active);
    this.buildRoomBanner(f, width);
    this.buildToast(f, width);
  }

  private buildStatusPanel(f: FontAtlas): void {
    const ui = this.ui;
    const x = this.s(20), y = this.s(20), w = this.s(250), h = this.s(146);
    ui.panel(x, y, w, h, UiTheme.PANEL, UiTheme.PANEL_BORDER);
    const titleWidth = ui.text(f.bold, x + this.s(14), y + this.s(11), 'BIMGO', UiTheme.TEXT, this.s(2));
    ui.text(f.small, x + this.s(14) + titleWidth + this.s(8), y + this.s(15), 'FILE', UiTheme.GOOD, this.s(1));

    if (this.settings.showFps) {
      this.text.clear().appendNumber(this.fps, 0).append(' fps · ').appendNumber(this.frameMs, 1).append(' ms');
      ui.textRight(f.mono, x + w - this.s(14), y + this.s(14), this.text.text, UiTheme.GOOD);
    }

    const labelX = x + this.s(14), valueX = x + this.s(14) + this.s(70);
    let rowY = y + this.s(40);
    const row = this.s(20);
    const c = this.player.controller;

    ui.text(f.body, labelX, rowY, 'MODE', UiTheme.TEXT_MUTED);
    ui.text(f.body, valueX, rowY, this.player.flying ? 'FLY' : c.crouching ? 'CROUCH' : 'WALK', UiTheme.TEXT);
    rowY += row;

    ui.text(f.body, labelX, rowY, 'LEVEL', UiTheme.TEXT_MUTED);
    if (this.scene.levels.length > 0) {
      const level = this.scene.levels[this.levelIndexAt(this.player.feet.z)];
      const used = ui.text(f.body, valueX, rowY, level.name, UiTheme.TEXT);
      ui.text(f.mono, valueX + used + this.s(6), rowY + this.s(1), this.text.clear().appendNumber(level.elevation, 3, true).text, UiTheme.TEXT_SOFT);
    } else {
      ui.text(f.body, valueX, rowY, '—', UiTheme.TEXT);
    }
    rowY += row;

    ui.text(f.body, labelX, rowY, 'ROOM', UiTheme.TEXT_MUTED);
    const room = this.currentRoom;
    if (room) {
      const used = ui.text(f.mono, valueX, rowY + this.s(1), room.number, UiTheme.ACCENT);
      ui.textWrapped(f.body, valueX + used + this.s(8), rowY, w - (valueX - x) - used - this.s(22), room.name, UiTheme.TEXT, 1);
    } else {
      ui.text(f.body, valueX, rowY, this.scene.rooms.length === 0 ? 'No rooms in this model' : '—', UiTheme.TEXT_MUTED);
    }
    rowY += row;

    ui.text(f.body, labelX, rowY, 'GROUND', UiTheme.TEXT_MUTED);
    ui.text(f.mono, valueX, rowY + this.s(1), this.text.clear().appendNumber(this.groundZ, 3).append(' m').text, UiTheme.TEXT);
    rowY += row;

    ui.text(f.body, labelX, rowY, 'VIEW', UiTheme.TEXT_MUTED);
    ui.text(f.body, valueX, rowY, this.colourModeLabel(), UiTheme.TEXT);
  }

  colourModeLabel(): string {
    switch (this.settings.colour) {
      case ColourMode.Whitecard: return 'Whitecard';
      case ColourMode.Material: return 'Material colour';
      default: return 'Realistic (no textures)';
    }
  }

  private buildHelp(f: FontAtlas, height: number): void {
    const ui = this.ui;
    const x = this.s(20);
    if (!this.showHelp) {
      ui.text(f.mono, x, height - this.s(36), 'F1  Help', UiTheme.TEXT_MUTED);
      return;
    }
    if (this.helpScale !== ui.scale) {
      this.helpScale = ui.scale;
      this.helpKeyWidth = Math.max(...HELP_ROWS.map(([key]) => UiBatch.measure(f.mono, key)));
      this.helpActionWidth = Math.max(...HELP_ROWS.map(([, action]) => UiBatch.measure(f.body, action)));
    }

    const row = this.s(17);
    const h = HELP_ROWS.length * row + this.s(20);
    const y = height - this.s(20) - h;
    const keyWidth = this.helpKeyWidth + this.s(16);
    ui.panel(x, y, this.s(12) + keyWidth + this.helpActionWidth + this.s(14), h, Rgba.hex(0x0c0e12, 0.66), Rgba.hex(0xffffff, 0.1));

    let rowY = y + this.s(10);
    HELP_ROWS.forEach(([key, action], i) => {
      const last = i === HELP_ROWS.length - 1;
      ui.text(f.mono, x + this.s(12), rowY, key, last ? UiTheme.TEXT_MUTED : UiTheme.TEXT);
      ui.text(f.body, x + this.s(12) + keyWidth, rowY - this.s(1), action, last ? UiTheme.TEXT_MUTED : UiTheme.TEXT_SOFT);
      rowY += row;
    });
  }

  private buildGunBar(f: FontAtlas, width: number, height: number, active: Gun): void {
    const ui = this.ui;
    const slot = this.s(52), gap = this.s(6), iconSize = this.s(30);
    const total = this.guns.length * slot + (this.guns.length - 1) * gap;
    const x = roundEven(width * 0.5 - total * 0.5);
    const y = height - this.s(20) - slot;

    this.guns.forEach((gun, i) => {
      const selected = i === this.activeGun;
      const bx = x + i * (slot + gap);
      ui.rect(bx, y, slot, slot, Rgba.hex(0x0c0e12, selected ? 0.9 : 0.6));
      ui.outline(bx, y, slot, slot, this.s(2), selected ? gun.colour : Rgba.hex(0xffffff, 0.14));
      gun.drawIcon(ui, bx + slot * 0.5, y + slot * 0.5 + this.s(2), iconSize, selected ? gun.colour : UiTheme.TEXT_MUTED);
      ui.text(f.small, bx + this.s(5), y + this.s(3), gun.key, selected ? gun.colour : UiTheme.TEXT_FAINT);
    });

    // Selected gun name, then the hints, on one row above the bar
    const rowY = y - this.s(8) - this.s(24);
    const nameWidth = UiBatch.measure(f.bold, active.name, this.s(1)) + this.s(20);
    const lmbWidth = this.hintWidth(f, active.hintPrimary);
    const rmbWidth = this.hintWidth(f, active.hintSecondary);
    let rowX = roundEven(width * 0.5 - (nameWidth + this.s(10) + lmbWidth + this.s(10) + rmbWidth) * 0.5);

    ui.rect(rowX, rowY, nameWidth, this.s(24), Rgba.withAlpha(active.colour, 0.9));
    ui.text(f.bold, rowX + this.s(10), rowY + this.s(4), active.name, UiTheme.SCAN_TAG_TEXT, this.s(1));
    rowX += nameWidth + this.s(10);
    this.hint(f, rowX, rowY, 'LMB', active.hintPrimary, active.colour);
    this.hint(f, rowX + lmbWidth + this.s(10), rowY, 'RMB', active.hintSecondary, active.colour);
  }

  private hintWidth(f: FontAtlas, text: string): number {
    return UiBatch.measure(f.mono, 'LMB') + this.s(6) + UiBatch.measure(f.body, text) + this.s(16);
  }

  private hint(f: FontAtlas, x: number, y: number, button: string, text: string, colour: number): void {
    this.ui.rect(x, y, this.hintWidth(f, text), this.s(24), Rgba.hex(0x0c0e12, 0.7));
    const used = this.ui.text(f.mono, x + this.s(8), y + this.s(5), button, colour);
    this.ui.text(f.body, x + this.s(8) + used + this.s(6), y + this.s(4), text, Rgba.hex(0xe5e7eb));
  }

  private buildRoomBanner(f: FontAtlas, width: number): void {
    const room = this.currentRoom;
    if (!room || this.clock >= this.roomBannerUntil) { return; }
    const ui = this.ui;
    const remaining = this.roomBannerUntil - this.clock;
    const alpha = clamp(remaining / 0.5, 0, 1) * clamp((2.4 - remaining) / 0.2, 0, 1);

    const numberWidth = UiBatch.measure(f.mono, room.number) + this.s(20);
    const nameWidth = UiBatch.measure(f.bold, room.name, this.s(1)) + this.s(24);
    const x = roundEven(width * 0.5 - (numberWidth + nameWidth) * 0.5), y = this.s(62), h = this.s(32);
    ui.rect(x, y, numberWidth, h, Rgba.withAlpha(UiTheme.ACCENT, 0.92 * alpha));
    ui.text(f.mono, x + this.s(10), y + this.s(8), room.number, Rgba.withAlpha(UiTheme.SCAN_TAG_TEXT, alpha));
    ui.rect(x + numberWidth, y, nameWidth, h, Rgba.withAlpha(UiTheme.PANEL_STRONG, 0.88 * alpha));
    ui.text(f.bold, x + numberWidth + this.s(12), y + this.s(7), room.name, Rgba.withAlpha(UiTheme.TEXT, alpha), this.s(1));
  }

  private buildToast(f: FontAtlas, width: number): void {
    if (this.toastText === null || this.clock >= this.toastUntil) { return; }
    const ui = this.ui;
    const alpha = clamp((this.toastUntil - this.clock) / 0.4, 0, 1);
    const w = UiBatch.measure(f.body, this.toastText) + this.s(32), h = this.s(32);
    const x = width * 0.5 - w * 0.5, y = this.s(20);
    ui.panel(x, y, w, h, Rgba.withAlpha(UiTheme.PANEL_STRONG, 0.88 * alpha), Rgba.withAlpha(UiTheme.ACCENT, 0.6 * alpha));
    ui.text(f.body, x + this.s(16), y + this.s(7), this.toastText, Rgba.withAlpha(UiTheme.TEXT, alpha));
  }

  // #endregion

  /** Releases GPU resources, sound and the mouse. */
  dispose(): void {
    this.window.setCaptured(false);
    this.settings.save();
    for (const { texture } of this.thumbnailTextures.values()) { if (texture) { gl.deleteTexture(texture); } }
    this.thumbnailTextures.clear();
    this.sound.dispose();
    this.overlay.dispose();
    this.renderer?.dispose();
  }

  s(value: number): number {
    return value * this.ui.scale;
  }
}

/** Crossing-number point-in-polygon test. */
function insidePolygon(polygon: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) { inside = !inside; }
  }
  return inside;
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) { throw new DOMException('Cancelled.', 'AbortError'); }
}

interface KeyboardLock { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void }

/** F11: fullscreen, with Keyboard Lock where supported so Ctrl+1–9 and Esc reach the page (Chrome / Edge). */
function toggleFullscreen(): void {
  const keyboard = (navigator as unknown as { keyboard?: KeyboardLock }).keyboard;
  if (document.fullscreenElement) {
    keyboard?.unlock?.();
    void document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen()
      .then(() => keyboard?.lock?.(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9']))
      .catch(() => undefined);
  }
}
