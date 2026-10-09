import { type EditRequest, type EditResult, EditOp } from '../core/edits/EditMessages';
import { type JournalEntry, JournalOps } from '../core/edits/EditJournal';
import { FileKinds } from '../core/format/BimGoFormat';
import type { BimGoDocument } from '../core/format/BimGoReader';
import { SidecarJson, writeBimGo } from '../core/format/BimGoWriter';
import type { BookmarkRecord, CommentRecord, VisibilitySettings } from '../core/format/DocumentModels';
import { cleanGroundOffset, setCurrentUser } from '../core/format/DocumentModels';
import { Mat4 } from '../core/math/Matrix4x4';
import { clamp, type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import { CATEGORIES, findCategory, KEY_DOORS } from '../core/scene/CategoryCatalog';
import { linkLabel } from '../core/scene/LinkInfo';
import type { SidecarKind } from '../core/live/LiveProtocol';
import { LiveSessionSource } from '../core/sources/LiveSessionSource';
import { FileEditSource, type ModelSource } from '../core/sources/ModelSource';
import type { RoomInfo, SceneData } from '../core/scene/SceneData';
import { CoordinateReadout, SharedTransform, SiteCoordinates } from '../core/scene/SiteCoordinates';
import { gl } from '../engine/gl/Gl';
import { Bvh, type RayHit } from '../engine/physics/Bvh';
import { CharacterController } from '../engine/physics/CharacterController';
import { type DynamicInstance, DynamicSet } from '../engine/physics/DynamicSet';
import { FpsCamera } from '../engine/render/FpsCamera';
import { Overlay3D } from '../engine/render/Overlay3D';
import { SceneBatches } from '../engine/render/SceneBatches';
import { ShadowQuality, shadowPresetFor } from '../engine/render/ShadowMaps';
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
import { CloneGun, type EditHost, GizmoGun, HammerGun } from './guns/EditGuns';
import type { AimInfo, Gun, GunHost, Highlight } from './guns/Gun';
import { MeasureGun } from './guns/MeasureGun';
import { PortalGun } from './guns/PortalGun';
import { ScanGun } from './guns/ScanGun';
import { TeleportGun } from './guns/TeleportGun';
import { LightMode, Lights } from './Lights';
import { PauseMenu, TextEditor } from './Menus';
import { Reflections } from './Reflections';
import { drawProgress, type ProgressState } from './ProgressScreen';
import { Player } from './Player';
import { BookmarkStore, CommentStore } from './Stores';
import { SunPanel } from './SunPanel';
import { SunState } from './SunState';
import { Textures } from './Textures';
import type { ViewerSettings } from './ViewerSettings';
import { ColourMode } from './ViewerSettings';

/** Why a walkthrough ended: closed, or a newer Revit snapshot is ready (reload where the player stands). */
export type SessionEnd = 'closed' | 'reload';

/** Where the player stands, in Revit internal metres, carried across a live reload (port of SessionPose). */
export interface SessionPose {
  feet: Vec3;
  yaw: number;
  pitch: number;
  flying: boolean;
  home: Vec3;
  homeYaw: number;
  homePitch: number;
  homeFlying: boolean;
  activeGun: number;
  showMap: boolean;
}

const HELP_ROWS: [string, string][] = [
  ['WASD', 'Move'],
  ['SPACE / CTRL', 'Jump / Crouch'],
  ['SHIFT', 'Run'],
  ['V', 'Fly / walk (no-clip)'],
  ['PGUP / PGDN', 'Level up / down'],
  ['H · SHIFT+H', 'Go home · Set home here'],
  ['1–8 · WHEEL', 'Select tool'],
  ['6 · 7 · 8', 'Demolish · Gizmo · Clone'],
  ['I · SHIFT+I', 'Scan: hide target · isolate its category'],
  ['X', "Clear this tool's markers"],
  ['B · ALT+1–9', 'Bookmark this view · Go to bookmark'],
  ['U', 'Hide the UI (Esc or U shows it)'],
  ['L', 'Coordinate readout'],
  ['K', 'Artificial lights: off / glow / light'],
  ['O · SHIFT+O', 'Shadows on/off · Sun panel'],
  ['[ ]', 'Sun time −/+ 5 min (Shift: 1 min)'],
  ['TAB · ESC / P', 'Minimap · Pause menu'],
  ['CTRL+S · Z · Y', 'Save · Undo · Redo'],
  ['F5 · R (SCAN)', 'Live: refresh · Show in Revit'],
  ['F11 · SHIFT+F12', 'Fullscreen · Screenshot'],
  ['F1', 'Hide help · BimGo Web ' + __BIMGO_VERSION__]
];

const THUMB_WIDTH = 192, THUMB_HEIGHT = 108;
const SNAP_MOVE_STEPS_MM = [5, 10, 25, 50, 100, 250, 500, 1000];
const SNAP_ANGLE_STEPS_DEG = [1, 5, 10, 15, 30, 45, 90];

/**
 * One walkthrough of a model (port of BimGo.App/Game/GameSession.cs with its Render, Visibility, Coordinates,
 * Bookmarks, Screenshot, Thumbnails, Edits and Document partials; menus and text entry live in Menus.ts, the editing
 * tools in guns/EditGuns.ts). The browser drives it one animation frame at a time.
 */
export class GameSession implements GunHost, EditHost {
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
  dynamics!: DynamicSet;
  player!: Player;
  comments!: CommentStore;
  bookmarks!: BookmarkStore;
  guns: Gun[] = [];
  activeGun = 0;
  portalGun!: PortalGun;
  commentGun!: CommentGun;
  readonly menu: PauseMenu;
  readonly sunPanel: SunPanel;
  textures!: Textures;
  /** Bumped by every change that Save would write (comments, bookmarks, materials, edits…). */
  dirtyRevision = 0;
  sun!: SunState;
  lights!: Lights;
  /** Set once the user picks a shadow quality (the automatic downgrade then leaves it alone). */
  qualityChosenByUser = false;
  private bloomFailed = false;
  private sceneRevision = 0;
  private slowFrameTime = 0;
  readonly editor: TextEditor;
  readonly reflections: Reflections;
  aim: AimInfo = { hasHit: false, hit: null, origin: vec3(), direction: vec3(1, 0, 0) };

  // #endregion

  // #region Visibility and lookups

  readonly categoryVisible: boolean[];
  readonly linkVisible: boolean[];
  readonly groupVisible: boolean[];
  private readonly pickMask: boolean[];
  private readonly collisionMask: boolean[];
  private readonly userHidden: boolean[];
  /** Static elements hidden by edits (demolished, deleted, or stood in for by their moved instance). */
  private readonly hidden: boolean[];
  userHiddenCount = 0;
  private isolateBackup: boolean[] | null = null;
  private readonly elementIndexById = new Map<number, number>();
  private readonly elementIndexByUniqueId = new Map<string, number>();
  private readonly levelNamesUpper: string[];
  private readonly doorCategory: number;

  // #endregion

  // #region Edits and the document

  readonly source: ModelSource;
  private readonly hostedBy = new Map<number, number[]>();
  private readonly editCallbacks = new Map<number, (result: EditResult) => void>();
  private readonly pendingRequests = new Map<number, EditRequest>();
  private nextCloneKey = 0;
  gizmoSnap = false;
  snapMoveMm = 50;
  snapAngleDeg = 15;
  private visibilityRevision = 0;
  private dynamicsSignature = '';
  private savedKey = '';
  private lastTitle = '';
  documentName: string;
  private fileHandle: FileSystemFileHandle | null;
  private saving: { title: string; progress: ProgressState; abort: AbortController } | null = null;
  private editCancelledAt = -10;
  private reloadRequested = false;
  private modelChangesShown = 0;
  private readonly sidecarRevision = new Map<SidecarKind, number>();
  private readonly sidecarTimer = new Map<SidecarKind, number>();
  private readonly unloadGuard = (e: BeforeUnloadEvent) => {
    if (!this.isDirty) { return; }
    e.preventDefault();
    e.returnValue = '';
  };

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
  private toastImportant = false;
  /** Hide-UI mode (U): HUD, minimap, crosshair, markers and ordinary toasts hidden; every control still works. */
  uiHidden = false;
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
  /** The comment whose thumbnail is taken at the end of this frame's 3D pass, or null. */
  commentThumbnailFor: CommentRecord | null = null;
  // Uploaded thumbnails (bookmarks and comments) by owner
  private readonly thumbnailTextures = new Map<object, { data: string; texture: WebGLTexture | null }>();

  // #endregion

  constructor(
    private readonly window: GameWindow,
    readonly ui: UiBatch,
    readonly document: BimGoDocument,
    readonly settings: ViewerSettings,
    fileHandle: FileSystemFileHandle | null = null,
    source: ModelSource | null = null
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
    this.hidden = new Array<boolean>(scene.elements.length).fill(false);
    this.fileHandle = fileHandle;
    this.documentName = document.name;
    this.source = source ?? new FileEditSource(scene, document.name);
    scene.elements.forEach((record, e) => {
      // Family library templates are hidden for good (never drawn, picked or collided as themselves; the Place gun
      // clones them) and have no Revit identity to look up
      if (record.isLibraryTemplate) {
        this.hidden[e] = true;
        return;
      }
      // Only host elements are looked up by id: linked models have their own id namespaces
      if (record.link > 0) { return; }
      if (record.hostId > 0) {
        const list = this.hostedBy.get(record.hostId);
        if (list) { list.push(record.elementId); } else { this.hostedBy.set(record.hostId, [record.elementId]); }
      }
      if (!this.elementIndexById.has(record.elementId)) { this.elementIndexById.set(record.elementId, e); }
      if (record.uniqueId && !this.elementIndexByUniqueId.has(record.uniqueId)) { this.elementIndexByUniqueId.set(record.uniqueId, e); }
    });
    this.doorCategory = findCategory(KEY_DOORS)?.index ?? -1;
    this.levelNamesUpper = scene.levels.map(l => l.name.toUpperCase());
    this.menu = new PauseMenu(this);
    this.sunPanel = new SunPanel(this);
    this.editor = new TextEditor(this);
    this.reflections = new Reflections(this);
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
  /** The live Revit session, or null for a .bimgo file. */
  get live(): LiveSessionSource | null { return this.source instanceof LiveSessionSource ? this.source : null; }
  get isFileMode(): boolean { return !this.source.isRevit; }
  get isLiveConnected(): boolean { return this.live?.connected ?? false; }

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
    this.renderer.probes.setOccluders(this.bvh, this.probeOccluderMask());
    this.overlay.initialise();
    this.sound.initialise();
    console.info(`Batches ${this.batches.batches.length} / chunks ${this.batches.chunkTotal}, BVH nodes ${this.bvh.nodeCount} in ${Math.round(performance.now() - started)} ms.`);

    this.dynamics = new DynamicSet(this.bvh, this.scene.elements, this.groupVisible);
    this.renderer.dynamics = this.dynamics;
    const controller = new CharacterController(this.bvh);
    controller.stepHeight = this.settings.maxStepHeightMm / 1000;
    controller.collisionMask = this.collisionMask;
    controller.dynamics = this.dynamics;
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
    const skipped = this.replayJournal();
    this.sun = new SunState(this.scene.site, this.document.sun);
    this.lights = new Lights(this.scene);
    this.textures = new Textures(this);
    this.textures.applyRendererOptions();
    void this.textures.load().then(() => {
      const missing = this.textures.missingCount;
      if (missing > 0 && this.settings.colour === ColourMode.Realistic && !this.renderer.materialWarning) {
        this.toast(`${missing} material${missing === 1 ? ' is' : 's are'} missing an image: Esc → TEXTURES to find them.`, 5);
      }
    });

    this.portalGun = new PortalGun(this);
    this.commentGun = new CommentGun(this);
    this.guns = [new ScanGun(this), new MeasureGun(this), this.portalGun, this.commentGun, new TeleportGun(this),
      new HammerGun(this), new GizmoGun(this), new CloneGun(this)];
    this.guns.forEach((g, i) => { g.key = String(i + 1); });

    this.spawn();
    this.markSaved();
    this.markSidecarsWritten();
    globalThis.addEventListener('beforeunload', this.unloadGuard);

    const links = this.scene.links.length > 0 ? ` · ${this.scene.links.length} linked model${this.scene.links.length === 1 ? '' : 's'}` : '';
    const count = this.journal.count;
    const edits = count > 0 ? ` · ${count} edit${count === 1 ? '' : 's'}${skipped > 0 ? ` (${skipped} not applied: their elements are missing)` : ''}` : '';
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

  /**
   * Elements that close a room boundary for reflection-probe blending (walls, glazing, columns…): everything static
   * except doors (always open to walk through) and movable furniture (it shouldn't decide whether two rooms connect).
   */
  private probeOccluderMask(): boolean[] {
    return this.scene.elements.map(e => !e.movable && !e.isLibraryTemplate && e.categoryIndex !== this.doorCategory);
  }

  refreshMasks(): void {
    this.sceneRevision++;
    this.visibilityRevision++;
    this.updateGroupVisibility();
    const elements = this.scene.elements;
    for (let e = 0; e < elements.length; e++) {
      const visible = this.groupVisible[SceneBatches.groupOf(elements[e])] && !this.userHidden[e] && !this.hidden[e];
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
    if (this.saving) {
      const saving = this.saving;
      if (drawProgress(this.ui, this.window.width, this.window.height, saving.title, saving.progress, this.window.input)) {
        saving.progress.cancelRequested = true;
        saving.abort.abort();
      }
      return null;
    }
    this.pumpSource(dt);
    this.updateLive(dt);
    this.updateTitle();
    if (this.reloadRequested) { return 'reload'; }
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
    this.sun.update(dt);
    this.render();
    this.updateFps(dt);
    return this.ended ? 'closed' : null;
  }

  /** Called when the browser released the mouse (Esc, focus loss). */
  onCaptureLost(): void {
    if (this.saving) { return; }
    if (this.uiHidden) {
      // The browser's Esc: show the UI and keep everything else as it was (click to look again)
      this.showUi();
      this.editCancelledAt = this.clock;
      return;
    }
    if (this.guns[this.activeGun]?.capturesInput) {
      this.cancelEdit();
      return;
    }
    if (this.clock - this.editCancelledAt < 0.5) { return; }
    if (!this.paused && !this.editor.active && !this.sunPanel.open) { this.setPaused(true); }
  }

  /** Esc while moving or cloning: puts things back (the browser also frees the mouse; that doesn't pause). */
  private cancelEdit(): void {
    this.guns[this.activeGun].onCancel();
    this.editCancelledAt = this.clock;
  }

  private updateFrame(): void {
    const input = this.window.input;
    if (this.window.isMinimised && !this.paused && !this.editor.active) { this.setPaused(true); }

    if (this.editor.active) {
      this.editor.update(input);
      return;
    }

    // The sun panel has the cursor: the player stands still and its keys take over
    if (this.sunPanel.open && !this.paused) {
      if (input.isPressed(Vk.F11)) { toggleFullscreen(); }
      this.sunPanel.updateKeys(input);
      return;
    }

    // While the UI is hidden, Esc only brings it back (even when a gun has the keys); the next Esc acts as usual
    if (input.isPressed(Vk.ESCAPE) && this.uiHidden) {
      this.showUi();
      this.editCancelledAt = this.clock;
    }

    // Esc releases the mouse in the browser (onCaptureLost pauses); P and Esc toggle while it is free, and Esc
    // first closes an open list (comments / bookmarks)
    if (input.isPressed(Vk.ESCAPE) && !this.paused && this.guns[this.activeGun].capturesInput) {
      this.cancelEdit();
    } else if (input.isPressed(Vk.ESCAPE) && this.clock - this.editCancelledAt < 0.5) {
      // The same Esc already cancelled an edit (the browser released the mouse first)
    } else if (input.isPressed(Vk.ESCAPE) || input.isPressed(Vk.key('P'))) {
      if (!(this.paused && input.isPressed(Vk.ESCAPE) && this.menu.closePanels())) { this.setPaused(!this.paused); }
    }
    if (input.isPressed(Vk.F1)) { this.showHelp = !this.showHelp; }
    if (input.isPressed(Vk.F11)) { toggleFullscreen(); }
    if (input.isPressed(Vk.F12) && input.isDown(Vk.SHIFT)) { this.screenshotRequested = true; }
    if (input.isPressed(Vk.F5) || (input.isPressed(Vk.key('R')) && input.isDown(Vk.SHIFT) && !this.paused)) { this.refreshFromRevit(); }

    // Ctrl+S save (Shift: save as), Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo
    if (input.isDown(Vk.CONTROL)) {
      if (input.isPressed(Vk.key('S'))) {
        void this.save(input.isDown(Vk.SHIFT));
        return;
      }
      if (!this.paused && input.isPressedOrRepeated(Vk.key('Z'))) {
        if (input.isDown(Vk.SHIFT)) { this.redo(); } else { this.undo(); }
        return;
      }
      if (!this.paused && input.isPressedOrRepeated(Vk.key('Y'))) {
        this.redo();
        return;
      }
    }

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

    // Hide-UI mode (works while a gun has the movement keys too: none of them uses U)
    if (input.isPressed(Vk.key('U'))) { this.toggleUiHidden(); }

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
    if (input.isPressed(Vk.key('X')) && !this.guns[this.activeGun].capturesInput) { this.guns[this.activeGun].clearMarkers(); }
    if (input.isPressed(Vk.key('B'))) {
      this.addBookmarkHere();
      return;
    }
    if (input.isPressed(Vk.key('L'))) { this.cycleCoordinateReadout(); }
    if (input.isPressed(Vk.key('K'))) { this.cycleLightMode(); }
    if (input.isPressed(Vk.key('O'))) {
      if (input.isDown(Vk.SHIFT)) { this.sunPanel.show(); } else { this.toggleShadows(); }
      return;
    }
    if (this.sun.enabled && input.isPressedOrRepeated(Vk.OEM_4)) { this.stepSunTime(input.isDown(Vk.SHIFT) ? -1 : -5); }
    if (this.sun.enabled && input.isPressedOrRepeated(Vk.OEM_6)) { this.stepSunTime(input.isDown(Vk.SHIFT) ? 1 : 5); }
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
      // A click on the sun icon (cursor free) opens the sun panel instead of capturing the mouse
      if (this.sunPanel.hoverIcon(input)) {
        input.consumeClicks();
        this.sunPanel.show();
        return;
      }
      this.window.setCaptured(true);
      input.consumeClicks();
    }
    if (this.window.isCaptured) {
      this.player.look(input.mouseDeltaX, input.mouseDeltaY, this.settings.mouseSensitivity, this.settings.invertY);
    }
  }

  private fixedUpdate(dt: number): void {
    this.player.controller.groundZ = this.groundZ;
    const frozen = this.editor.active || this.sunPanel.open || this.window.isMinimised || this.guns[this.activeGun].capturesInput;
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
    if (this.paused || this.editor.active || this.sunPanel.open) { return; }

    const active = this.guns[this.activeGun];
    active.update(dt, this.aim);
    const input = this.window.input;
    if (this.window.isCaptured) {
      if (input.leftPressed) { active.onPrimary(this.aim); }
      if (input.rightPressed) { active.onSecondary(this.aim); }
    }
  }

  private updateFps(dt: number): void {
    this.autoDowngradeShadows(dt);
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
    if (paused) {
      this.sunPanel.close();
      this.showUi(); // e.g. focus lost while hidden: come back to a normal HUD
    }
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
    this.toast('Home set here: H returns here (saved with the file: Ctrl+S)', 3.5);
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

  /**
   * Shows a short message at the top of the screen.
   * @param important True for errors and failures: shown even while the UI is hidden (U).
   */
  toast(message: string, seconds = 2.6, important = false): void {
    // While the UI is hidden an ordinary message is dropped, so it can't replace an error still showing
    if (this.uiHidden && !important) { return; }
    this.toastText = message;
    this.toastUntil = this.clock + seconds;
    this.toastImportant = important;
  }

  /** U: hides or shows the UI. Entering says how to get it back. */
  toggleUiHidden(): void {
    if (this.uiHidden) {
      this.showUi();
      return;
    }
    this.uiHidden = true;
    this.sound.play(SoundId.UiClick);
    this.toast('UI hidden · Esc or U to show it', 1.8, true);
  }

  /** Leaves hide-UI mode (Esc, U, the pause menu, the sun panel). */
  showUi(): void {
    if (!this.uiHidden) { return; }
    this.uiHidden = false;
    this.toastText = null;
    this.sound.play(SoundId.UiClick);
  }

  flash(colour: number, seconds: number): void {
    this.flashColour = colour;
    this.flashLength = seconds;
    this.flashUntil = this.clock + seconds;
  }

  pick(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null {
    const hit = this.bvh.raycast(origin, direction, maxDistance, this.pickMask);
    // A moved or cloned element in front of the static hit wins
    return this.dynamics?.raycast(origin, direction, hit ? hit.distance : maxDistance) ?? hit;
  }

  /** True if a pick target still exists: a visible static element or an active dynamic instance. */
  isTargetPresent(element: number, dynamicId: number): boolean {
    if (dynamicId > 0) {
      const instance = this.dynamics.find(dynamicId);
      return instance !== null && this.dynamics.isActive(instance);
    }
    return element >= 0 && !this.hidden[element] && !this.userHidden[element];
  }

  // #endregion

  /** Hidden things or the ground plane changed (saved with the model: visibility.json / the live sidecar). */
  visibilityChanged(): void {
    this.visibilityRevision++;
  }

  /** Something Save would write has changed (the title gets a *). */
  markDirty(): void {
    this.dirtyRevision++;
  }

  // #region Sun and lights

  toggleShadows(): void {
    this.sun.toggle();
    this.sound.play(SoundId.UiClick);
    this.toast(this.sun.enabled ? `Shadows on · ${this.sun.describeTime()} (Shift+O opens the sun panel)` : 'Shadows off');
  }

  stepSunTime(minutes: number): void {
    this.sun.stepTime(minutes);
    // Say which time is now shown (short, so holding the key reads as a ticking clock)
    if (!this.sunPanel.open) { this.toast(`${this.sun.describeTime()} · sun ${this.sun.heightText()}`, 1.4); }
  }

  cycleLightMode(): void {
    if (!this.lights.hasAny) {
      this.sound.play(SoundId.Error);
      this.toast('This model has no lighting fixtures or glowing materials');
      return;
    }
    this.setLightMode((this.settings.lightMode + 1) % 3);
  }

  setLightMode(mode: LightMode): void {
    this.settings.lightMode = mode;
    this.settings.save();
    this.sound.play(SoundId.UiClick);
    const fixtures = this.scene.lighting.lights.length;
    this.toast(mode === LightMode.Off ? 'Artificial lights off'
      : mode === LightMode.Glow ? 'Artificial lights: glow only'
        : fixtures > 0 ? `Artificial lights: glow + light (${fixtures} fixtures)` : 'Artificial lights: glow (no fixtures to light rooms)');
  }

  /** Changes whenever shadow casters change (hidden elements, category and link toggles, whitecard glass). */
  private get shadowSceneKey(): number {
    return this.sceneRevision * 2 + (this.settings.whitecard ? 1 : 0);
  }

  private onShadowFailure(reason: string): void {
    if (this.sun.enabled) { this.sun.toggle(); }
    this.sound.play(SoundId.Error);
    this.toast(reason, 6, true);
  }

  private onScreenEffectsFailure(reason: string): void {
    this.settings.ambientOcclusion = false;
    this.bloomFailed = true;
    this.renderer.disableScreenEffects();
    this.sound.play(SoundId.Error);
    this.toast(reason, 6, true);
  }

  /**
   * WebGL is slower than native: when shadows hold the frame rate under ~25 fps for 3 s, step their quality down once
   * per level (only until the user picks a quality themselves).
   */
  private autoDowngradeShadows(dt: number): void {
    if (!this.sun.enabled || this.qualityChosenByUser || this.paused || this.settings.shadowQuality === ShadowQuality.Low) {
      this.slowFrameTime = 0;
      return;
    }
    this.slowFrameTime = this.frameMs > 40 ? this.slowFrameTime + dt : 0;
    if (this.slowFrameTime < 3) { return; }
    this.slowFrameTime = 0;
    this.settings.shadowQuality = this.settings.shadowQuality - 1;
    this.settings.save();
    this.toast(`Shadows lowered to ${this.settings.shadowQuality === ShadowQuality.Low ? 'Low' : 'Medium'} to keep the frame rate up (Shift+O to change)`, 5);
  }

  // #endregion

  // #region Comments (editor in Menus.ts)

  beginCommentEdit(point: Vec3, elementId: number, level: string): void {
    this.editor.beginComment(point, elementId, level);
  }

  editComment(record: CommentRecord): void {
    this.editor.editComment(record);
  }

  /**
   * Back to where a comment was made from (its saved view); older comments without one: 1.6 m in front of the marker,
   * on its level, looking at it.
   */
  teleportToComment(record: CommentRecord): void {
    const viewFeet = this.comments.viewFeet(record);
    if (viewFeet && record.view) {
      if (record.view.flying !== this.player.flying) { this.player.toggleFly(); }
      this.player.teleportTo(viewFeet, record.view.yaw, clamp(record.view.pitch, -1.5, 1.5));
      return;
    }
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

  floorAt(x: number, y: number, floorZ: number): Vec3 {
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
    const record = this.bookmarks.createPending(null, p.feet, p.yaw, p.pitch, p.flying, this.currentLevelName, this.sun.bookmarkTime());
    this.thumbnailFor = record;
    this.sound.play(SoundId.CommentPlace);
    this.editor.renameBookmark(record, true);
  }

  addBookmarkFromMenu(): BookmarkRecord {
    const p = this.player;
    const added = this.bookmarks.add(null, p.feet, p.yaw, p.pitch, p.flying, this.currentLevelName, this.sun.bookmarkTime());
    this.thumbnailFor = added;
    return added;
  }

  setBookmarkHere(record: BookmarkRecord): void {
    const p = this.player;
    this.bookmarks.update(record, p.feet, p.yaw, p.pitch, p.flying, this.currentLevelName, this.sun.bookmarkTime());
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
    if (record.sun) { this.sun.applyTime(record.sun); }
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

  /**
   * The thumbnail texture of a bookmark or comment (decoded once, asynchronously; remade when the picture changes;
   * null until ready or when unreadable).
   */
  thumbnailTexture(record: BookmarkRecord | CommentRecord): WebGLTexture | null {
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
      .catch(e => console.info(`Thumbnail unreadable: ${e instanceof Error ? e.message : String(e)}`));
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

    // The ground plane as it was left (metres from its default)
    if (saved.groundOffset !== null) { this.groundZ = this.groundDefault + saved.groundOffset; }

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
    this.sceneRevision++;
    this.visibilityRevision++;
    this.renderer.setElementHidden(element, hidden || this.hidden[element]);
    const visible = !hidden && !this.hidden[element] && this.groupVisible[SceneBatches.groupOf(this.scene.elements[element])];
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
      ...this.reflections.drawParams(),
      tintMode: this.settings.revitTint ? 1 : 0,
      plan: false,
      clipZMin: -1e7,
      clipZMax: 1e7,
      fogDensity: 0.0022,
      sun: true
    };
  }

  private render(): void {
    const width = this.window.width, height = this.window.height;
    const renderer = this.renderer, settings = this.settings;
    this.trackDynamics();

    // ---- Sun lighting and shadow maps (only changed cascades re-render)
    renderer.lighting = this.sun.lighting();
    const shadowError = renderer.updateShadows(this.camera, this.scene.bounds, this.shadowSceneKey, this.groupVisible, settings.whitecard,
      shadowPresetFor(settings.shadowQuality));
    if (shadowError) {
      this.onShadowFailure(shadowError);
      renderer.lighting = this.sun.lighting();
    }

    // ---- Artificial lights for this frame (after the sun: daylight dims them), and their cached shadow maps
    this.lights.update(renderer.artificial, settings.lightMode, settings.lightIntensity, settings.bloomIntensity, this.bloomFailed,
      renderer.lighting, this.camera, this.groupVisible, this.userHidden, this.hidden, this.dynamics);
    const lightShadowError = renderer.updateLightShadows(this.groupVisible, this.shadowSceneKey);
    if (lightShadowError) { this.toast(lightShadowError, 6, true); }

    // ---- Ambient occlusion and glow: half-resolution geometry pre-pass, AO + blur, bloom source + blur
    const effectsError = renderer.updateScreenEffects(this.camera, width, height, this.groupVisible, this.groundZ,
      settings.ambientOcclusion, renderer.artificial.bloom > 0);
    if (effectsError) { this.onScreenEffectsFailure(effectsError); }

    // ---- Reflection probes: a couple of faces per frame until baked, re-baked a moment after things change
    this.reflections.update(this.sceneParams(), String(this.shadowSceneKey));

    // ---- 3D scene
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    const fog = renderer.fogColour;
    gl.clearColor(fog.x, fog.y, fog.z, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    this.renderer.drawSky(this.camera);
    const p = this.sceneParams();
    this.renderer.drawStatic(p, this.groupVisible, false);
    this.renderer.drawDynamic(p, this.dynamics, false);
    this.renderer.drawGround(this.camera, this.groundZ);

    // Gun highlights (scan target…)
    const active = this.guns[this.activeGun];
    this.highlights.length = 0;
    // (hidden UI: only a gun holding an element keeps its tint, so the held element stays visible)
    if (!this.paused && (!this.uiHidden || active.capturesInput)) { active.collectHighlights(this.highlights); }
    if (this.highlights.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -2);
      for (const h of this.highlights) {
        const [r, g, b] = Rgba.toVector(h.colour);
        if (h.dynamicId > 0) {
          const instance = this.dynamics.find(h.dynamicId);
          if (instance && this.dynamics.isActive(instance)) { this.renderer.drawDynamicHighlight(p, instance, r, g, b, h.strength); }
        } else if (h.element >= 0 && this.pickMask[h.element]) {
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
    this.renderer.drawDynamic(p, this.dynamics, true);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // Bloom from glowing surfaces over everything (glass included)
    this.renderer.compositeGlow();

    // Markers: depth-tested, then a faint x-ray copy so markers behind walls stay discoverable
    if (!this.uiHidden) {
      this.overlay.begin(this.camera);
      this.guns.forEach((gun, i) => gun.drawWorld(this.overlay, i === this.activeGun));
      this.overlay.draw(this.camera, true, 1, false);
      this.overlay.draw(this.camera, false, 0.16, false);
    }

    // Captures of the 3D view (no HUD)
    if (this.thumbnailFor || this.commentThumbnailFor) { this.captureThumbnail(width, height); }
    if (this.screenshotRequested) { this.captureScreenshot(width, height); }

    // ---- Window pass: minimap 3D, then all 2D UI in one batch
    gl.viewport(0, 0, width, height);
    const mapX = width - this.s(20) - this.s(220), mapY = this.s(20);
    if (this.showMap && !this.paused && !this.uiHidden) { this.drawMinimapPlan(mapX + this.s(8), mapY + this.s(30), this.s(204), this.s(170)); }

    if (this.paused) {
      // A text box opened from a panel (reply, assignee, edit) sits over the menu, which then gets no clicks
      if (this.editor.active) { this.window.input.consumeClicks(); }
      this.menu.build();
      if (this.editor.active) { this.editor.build(); }
    } else if (this.uiHidden) {
      this.buildHiddenHud(width);
    } else {
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
    const plan: SceneDrawParams = {
      viewProjection, planes: this.mapPlanes, eye, whitecard: this.settings.whitecard, realistic: false,
      plan: true, clipZMin: elevation - 0.3, clipZMax: elevation + 1.2, fogDensity: 0, sun: false
    };
    this.renderer.drawStatic(plan, this.groupVisible, false);
    this.renderer.drawDynamic(plan, this.dynamics, false);

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
    const record = this.thumbnailFor, comment = this.commentThumbnailFor;
    this.thumbnailFor = null;
    this.commentThumbnailFor = null;
    if ((!record && !comment) || width < 16 || height < 16) { return; }

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
      if (record) {
        if (this.bookmarks.bookmarks.includes(record)) { this.bookmarks.setThumbnail(record, data); }
        else { record.thumbnail = data; } // pending (B): saved when its name is confirmed
      }
      if (comment) { this.comments.setThumbnail(comment, data); }
    } catch (e) {
      console.info(`Thumbnail failed: ${e instanceof Error ? e.message : String(e)}`);
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

    if (!this.window.isCaptured && !this.editor.active && !this.sunPanel.open) {
      const hint = 'Click to look around';
      const hintWidth = UiBatch.measure(f.body, hint) + this.s(24);
      ui.panel(cx - hintWidth * 0.5, cy + this.s(28), hintWidth, this.s(28), UiTheme.PANEL, UiTheme.PANEL_BORDER);
      ui.textCentred(f.body, cx, cy + this.s(34), hint, UiTheme.TEXT);
    }

    this.buildStatusPanel(f);
    this.buildCoordinatePanel(f, this.s(20), this.s(20) + this.s(146) + this.s(10));

    // Minimap and the gun's context panel beneath it
    if (this.showMap) { this.drawMinimapOverlay(mapX, mapY); }
    // (hidden while the sun panel is open: the two would overlap on smaller screens)
    if (!this.sunPanel.open) {
      const panelTop = this.showMap ? mapY + this.s(208) + this.s(12) : this.s(20);
      const panelWidth = this.s(260), panelX = width - this.s(20) - panelWidth;
      ui.panel(panelX, panelTop, panelWidth, this.s(active.panelHeight) + this.s(24), UiTheme.PANEL, UiTheme.PANEL_BORDER);
      active.drawPanel(ui, panelX + this.s(14), panelTop + this.s(12), panelWidth - this.s(28));
    }

    this.sunPanel.buildIcon(f, this.window.input);
    if (this.sunPanel.open) { this.sunPanel.build(f, this.window.input); }

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
    const live = this.live;
    const badge = !live ? 'FILE' : live.closed ? 'REVIT · ENDED' : live.connected ? 'LIVE · REVIT' : 'REVIT · OFFLINE';
    ui.text(f.small, x + this.s(14) + titleWidth + this.s(8), y + this.s(15), badge, !live || live.connected ? UiTheme.GOOD : UiTheme.DANGER, this.s(1));

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
    if (live && (live.modelChanges > 0 || live.refreshing)) {
      ui.textRight(f.small, x + w - this.s(14), rowY + this.s(2), live.refreshing ? 'REFRESHING…' : `${live.modelChanges} CHANGES · F5`, UiTheme.ACCENT, this.s(1));
    }
  }

  colourModeLabel(): string {
    switch (this.settings.colour) {
      case ColourMode.Whitecard: return 'Whitecard';
      case ColourMode.Material: return 'Material colour';
      default: return this.renderer?.hasMaterials ? 'Realistic' : 'Realistic (no textures)';
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

  /** Hide-UI mode: only the screen flash, an open text box and important toasts. */
  private buildHiddenHud(width: number): void {
    const ui = this.ui, f = ui.atlas;
    if (this.clock < this.flashUntil) {
      const t = (this.flashUntil - this.clock) / Math.max(this.flashLength, 0.01);
      ui.rect(0, 0, width, this.window.height, Rgba.withAlpha(this.flashColour, 0.35 * t));
    }
    if (this.editor.active) { this.editor.build(); }
    if (this.toastImportant) { this.buildToast(f, width); }
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

  // #region Edits (port of GameSession.Edits.cs)

  get editsGoToRevit(): boolean { return this.source.isRevit; }
  get editsLocalOnly(): boolean { return this.source.isRevit && !this.source.canEdit; }
  get editTargetName(): string { return this.source.isRevit ? 'Revit' : 'the file'; }
  get journal() { return this.document.journal; }

  /** Hides or restores a static element (drawing, picking, collision and shadows). */
  setStaticHidden(element: number, hidden: boolean): void {
    if (this.hidden[element] === hidden) { return; }
    this.hidden[element] = hidden;
    this.sceneRevision++;
    this.renderer.setElementHidden(element, hidden || this.userHidden[element]);
    const record = this.scene.elements[element];
    const visible = this.groupVisible[SceneBatches.groupOf(record)] && !hidden && !this.userHidden[element];
    this.pickMask[element] = visible;
    this.collisionMask[element] = visible && record.categoryIndex !== this.doorCategory;
  }

  /** The dynamic instance standing in for a static element, created on first use (the static copy is hidden). */
  makeDynamic(element: number): DynamicInstance {
    const existing = this.dynamics.findOriginal(element);
    if (existing) { return existing; }
    this.renderer.ensureDynamicGeometry(element);
    const instance = this.dynamics.create(element, vec3(), 0, this.scene.elements[element].elementId, false, 0);
    this.setStaticHidden(element, true);
    return instance;
  }

  /** Puts a moved original back into the static scene if it is untransformed (after a cancelled move). */
  restoreIfUnmoved(instance: DynamicInstance | null): void {
    if (!instance || instance.isClone || instance.hidden) { return; }
    if (V.lengthSquared(instance.offset) > 1e-10 || Math.abs(instance.angle) > 1e-6) { return; }
    this.dynamics.remove(instance);
    this.setStaticHidden(instance.element, false);
  }

  /** An uncommitted clone starting at the source's current transform (cloneKey > 0 when replaying). */
  createClone(element: number, source: DynamicInstance | null, cloneKey = 0): DynamicInstance {
    this.renderer.ensureDynamicGeometry(element);
    if (cloneKey <= 0) { cloneKey = ++this.nextCloneKey; } else { this.nextCloneKey = Math.max(this.nextCloneKey, cloneKey); }
    return this.dynamics.create(element, source ? V.copy(source.offset) : vec3(), source?.angle ?? 0, 0, true, cloneKey);
  }

  /** Hides everything reported as deleted / demolished; returns how many game objects were hidden. */
  applyRemovals(ids: number[]): number {
    let count = 0;
    for (const id of ids) {
      const element = this.elementIndexById.get(id);
      if (element !== undefined && !this.dynamics.findOriginal(element) && !this.hidden[element]) {
        this.setStaticHidden(element, true);
        count++;
      }
      for (const instance of this.dynamics.instances) {
        if (instance.revitId === id && !instance.hidden) {
          instance.hidden = true;
          count++;
        }
      }
    }
    return count;
  }

  /** Scene-local metres to Revit internal metres. */
  toRevit(local: Vec3): Vec3 {
    return V.add(local, this.scene.originOffset);
  }

  /** Bumps the scene revision when a moved / cloned element changed (shadow and light caches re-render). */
  private trackDynamics(): void {
    const list = this.dynamics.instances;
    if (list.length === 0 && this.dynamicsSignature === '') { return; }
    const signature = list.map(i => `${i.id}:${i.offset.x},${i.offset.y},${i.offset.z},${i.angle},${i.hidden ? 1 : 0}`).join('|');
    if (signature === this.dynamicsSignature) { return; }
    this.dynamicsSignature = signature;
    this.sceneRevision++;
  }

  toggleGizmoSnap(): void {
    this.gizmoSnap = !this.gizmoSnap;
    this.sound.play(SoundId.UiClick);
    this.toast(this.gizmoSnap ? `Snap ON: ${this.describeSnap()}` : 'Snap OFF: smooth moves (hold Ctrl to snap for a moment)');
  }

  stepSnapMove(direction: number): void {
    this.snapMoveMm = stepPreset(SNAP_MOVE_STEPS_MM, this.snapMoveMm, direction);
    this.sound.play(SoundId.UiClick);
    this.toast(`Snap: ${this.describeSnap()}`);
  }

  stepSnapAngle(direction: number): void {
    this.snapAngleDeg = stepPreset(SNAP_ANGLE_STEPS_DEG, this.snapAngleDeg, direction);
    this.sound.play(SoundId.UiClick);
    this.toast(`Snap: ${this.describeSnap()}`);
  }

  private describeSnap(): string {
    const move = this.snapMoveMm >= 1000 ? `${+(this.snapMoveMm / 1000).toFixed(2)} m` : `${Math.round(this.snapMoveMm)} mm`;
    return `${move} · ${Math.round(this.snapAngleDeg)}°`;
  }

  /**
   * Sends an edit to the model source; the callback runs when the answer arrives (accepted edits are journalled first).
   * @returns False if the source can't take edits (the edit then stays in the walkthrough only).
   */
  submitEdit(request: EditRequest, onResult: (result: EditResult) => void): boolean {
    if (!this.source.canEdit) { return false; }
    const ticket = this.source.submit(request);
    if (ticket < 0) { return false; }
    this.pendingRequests.set(ticket, request);
    this.editCallbacks.set(ticket, onResult);
    return true;
  }

  /** Delivers the source's answers (recording accepted edits). */
  private pumpSource(dt: number): void {
    this.source.pump(dt);
    for (let result = this.source.takeResult(); result; result = this.source.takeResult()) {
      const request = this.pendingRequests.get(result.ticket);
      this.pendingRequests.delete(result.ticket);
      if (request && result.success) { this.recordEdit(request, result); }
      const callback = this.editCallbacks.get(result.ticket);
      this.editCallbacks.delete(result.ticket);
      try {
        callback?.(result);
      } catch (e) {
        console.error('Edit callback failed', e);
      }
    }
  }

  // #endregion

  // #region Journal (port of GameSession.Document.cs)

  /** Records an accepted edit by stable identity (UniqueId, or clone key for walkthrough clones). */
  private recordEdit(request: EditRequest, result: EditResult): void {
    const target = this.describeTarget(request.elementId, request.targetCloneKey ?? 0);
    this.journal.add({
      seq: 0,
      op: request.op === EditOp.Transform ? JournalOps.TRANSFORM : request.op === EditOp.Copy ? JournalOps.CLONE : JournalOps.HIDE,
      mode: request.op === EditOp.Delete ? JournalOps.MODE_DELETE : request.op === EditOp.PhaseDemolish ? JournalOps.MODE_DEMOLISH : null,
      elementId: target.elementId,
      uniqueId: target.uniqueId,
      targetCloneKey: target.cloneKey,
      newCloneKey: request.newCloneKey ?? 0,
      pivot: request.pivot ?? vec3(),
      offset: request.translation ?? vec3(),
      angle: request.angle ?? 0,
      label: request.label,
      utc: new Date().toISOString(),
      user: this.settings.userName,
      appliedToRevit: this.source.isRevit,
      revitElementId: request.op === EditOp.Copy && this.source.isRevit ? result.newElementId ?? 0 : 0
    });
  }

  private describeTarget(requestId: number, requestCloneKey: number): { cloneKey: number; uniqueId: string; elementId: number } {
    if (requestCloneKey !== 0) { return { cloneKey: requestCloneKey, uniqueId: '', elementId: 0 }; }
    if (requestId > 0) {
      const clone = this.dynamics.instances.find(i => i.isClone && i.revitId === requestId);
      if (clone) { return { cloneKey: clone.cloneKey, uniqueId: '', elementId: 0 }; }
    }
    const element = this.elementIndexById.get(requestId);
    return { cloneKey: 0, uniqueId: element !== undefined ? this.scene.elements[element].uniqueId ?? '' : '', elementId: requestId };
  }

  private resolveTarget(cloneKey: number, uniqueId: string, elementId: number): { element: number; clone: DynamicInstance | null } | null {
    if (cloneKey !== 0) {
      const clone = this.dynamics.instances.find(i => i.isClone && i.cloneKey === cloneKey);
      return clone ? { element: clone.element, clone } : null;
    }
    const element = (uniqueId ? this.elementIndexByUniqueId.get(uniqueId) : undefined) ?? (elementId > 0 ? this.elementIndexById.get(elementId) : undefined);
    return element !== undefined ? { element, clone: null } : null;
  }

  /** Applies every journal entry in order (on load and after an undo); returns how many could not be applied. */
  private replayJournal(): number {
    let failures = 0;
    for (const entry of this.journal.entries) {
      let applied = false;
      try {
        applied = this.applyEntry(entry);
      } catch (e) {
        console.warn(`Journal entry ${entry.seq} (${entry.op}) failed`, e);
      }
      if (!applied) { failures++; }
    }
    this.nextCloneKey = Math.max(this.nextCloneKey, this.journal.maxCloneKey());
    if (failures > 0) { console.info(`Journal replay: ${failures} of ${this.journal.count} entries skipped.`); }
    return failures;
  }

  private applyEntry(entry: JournalEntry): boolean {
    const target = this.resolveTarget(entry.targetCloneKey, entry.uniqueId, entry.elementId);
    if (!target) { return false; }
    const { element, clone } = target;
    switch (entry.op) {
      case JournalOps.HIDE: {
        if (clone) {
          clone.hidden = true;
          return true;
        }
        const moved = this.dynamics.findOriginal(element);
        if (moved) { moved.hidden = true; } else { this.setStaticHidden(element, true); }
        this.applyRemovals(this.collectHosted(this.scene.elements[element].elementId));
        return true;
      }
      case JournalOps.TRANSFORM: {
        const instance = clone ?? this.makeDynamic(element);
        this.dynamics.setTransform(instance, V.add(instance.offset, entry.offset), instance.angle + entry.angle);
        return true;
      }
      case JournalOps.CLONE: {
        const copy = this.createClone(element, clone ?? this.dynamics.findOriginal(element), entry.newCloneKey);
        this.dynamics.setTransform(copy, V.add(copy.offset, entry.offset), copy.angle + entry.angle);
        copy.committed = true;
        copy.revitId = entry.revitElementId;
        return true;
      }
      default:
        console.warn(`Journal entry ${entry.seq}: unknown op '${entry.op}'.`);
        return false;
    }
  }

  /** Everything hosted by an element, recursively (doors in a wall…), excluding the element itself. */
  private collectHosted(hostId: number): number[] {
    if (!this.hostedBy.has(hostId)) { return []; }
    const result: number[] = [];
    const queue = [hostId];
    while (queue.length > 0 && result.length < 10_000) {
      for (const id of this.hostedBy.get(queue.shift()!) ?? []) {
        result.push(id);
        queue.push(id);
      }
    }
    return result;
  }

  /** Back to the unedited snapshot (all elements shown, no moved or cloned instances). */
  private resetEdits(): void {
    for (let i = this.dynamics.instances.length - 1; i >= 0; i--) { this.dynamics.remove(this.dynamics.instances[i]); }
    for (let e = 0; e < this.hidden.length; e++) {
      if (this.hidden[e] && !this.scene.elements[e].isLibraryTemplate) { this.setStaticHidden(e, false); }
    }
    this.nextCloneKey = 0;
  }

  /** Ctrl+Z: removes the last entry and rebuilds the walkthrough from the rest. */
  undo(): void {
    if (!this.isFileMode) {
      this.toast('Edits are in Revit: undo them there, then press F5 to refresh');
      return;
    }
    if (this.guns[this.activeGun].capturesInput) { return; }
    const last = this.journal.removeLast();
    if (!last) {
      this.toast('Nothing to undo');
      return;
    }
    this.resetEdits();
    this.replayJournal();
    this.sound.play(SoundId.Remove);
    this.toast(last.label ? `Undone: ${last.label} (Ctrl+Y redoes)` : 'Undone (Ctrl+Y redoes)');
  }

  /** Ctrl+Y / Ctrl+Shift+Z: puts the last undone edit back (on top of the current state, as a full replay would). */
  redo(): void {
    if (!this.isFileMode) {
      this.toast('Edits are in Revit: redo them there, then press F5 to refresh');
      return;
    }
    if (this.guns[this.activeGun].capturesInput) { return; }
    const entry = this.journal.redo();
    if (!entry) {
      this.toast('Nothing to redo');
      return;
    }
    let applied = false;
    try {
      applied = this.applyEntry(entry);
    } catch (e) {
      console.warn(`Redo of entry ${entry.seq} (${entry.op}) failed`, e);
    }
    this.nextCloneKey = Math.max(this.nextCloneKey, this.journal.maxCloneKey());
    if (!applied) {
      this.sound.play(SoundId.Error);
      this.toast('Redone in the file, but its element is not in this walkthrough', 4);
      return;
    }
    this.sound.play(SoundId.Commit);
    const more = this.journal.redoCount > 0 ? ` (${this.journal.redoCount} more)` : '';
    this.toast((entry.label ? `Redone: ${entry.label}` : 'Redone') + more);
  }

  // #endregion

  // #region Live session (port of GameSession.Live.cs)

  /** Per frame: Revit's notices, the model-changed hint, sidecar writes, and a reload once a newer snapshot is ready. */
  private updateLive(dt: number): void {
    const live = this.live;
    if (!live) { return; }

    for (let notice = live.takeNotice(); notice !== null; notice = live.takeNotice()) {
      if (notice) { this.toast(notice, 4); }
    }
    if (live.modelChanges > this.modelChangesShown) {
      if (this.modelChangesShown === 0) { this.toast('The model changed in Revit: press F5 to load the changes', 4); }
      this.modelChangesShown = live.modelChanges;
    }
    this.syncSidecars(dt);

    // Reload where the player stands, once nothing is in flight
    if (live.snapshotReady && !this.reloadRequested) {
      const busy = live.pending > 0 || this.guns[this.activeGun].capturesInput || this.editor.active;
      if (!busy) {
        this.flushSidecars();
        this.reloadRequested = true;
      }
    }
  }

  /** F5 / Shift+R: asks Revit for a fresh snapshot (the walkthrough reloads where you stand when it arrives). */
  refreshFromRevit(): void {
    const live = this.live;
    if (!live) {
      this.toast('Refresh needs a live Revit session (press Go in Revit)');
      return;
    }
    if (!live.connected) {
      this.toast(live.closed ? 'The Revit session has ended' : 'Not connected to Revit');
      return;
    }
    if (live.pending > 0) {
      this.toast('Waiting for Revit to finish your edits first');
      return;
    }
    if (live.refreshing) {
      this.toast('Revit is already extracting a fresh snapshot…');
      return;
    }
    if (live.requestRefresh()) {
      this.sound.play(SoundId.UiClick);
      this.toast('Asking Revit for a fresh snapshot…', 4);
    }
  }

  /** Scan, R: selects and shows the element in Revit (a linked element: its link instance, or the element in it). */
  showInRevit(element: number, dynamicId: number): void {
    if (element < 0) { return; }
    const live = this.live;
    if (!live) {
      this.toast('Show in Revit needs a live Revit session (press Go in Revit)');
      return;
    }
    if (!live.connected) {
      this.toast('Not connected to Revit');
      return;
    }

    const record = this.scene.elements[element];
    const link = record.link > 0 ? this.scene.links.find(l => l.index === record.link) ?? null : null;
    let revitId = record.elementId;
    if (link) {
      if (link.instanceId <= 0) {
        this.toast('That element is in a linked model');
        return;
      }
      revitId = link.instanceId;
    }
    if (dynamicId > 0) { revitId = this.dynamics.find(dynamicId)?.revitId ?? 0; }
    if (revitId <= 0) {
      this.toast("That clone hasn't been created in Revit yet");
      return;
    }

    const sent = link ? live.showLinkedElement(link.instanceId, record.elementId) : live.showElements([revitId]);
    if (sent) {
      this.sound.play(SoundId.UiClick);
      this.toast(link ? `Showing it in the link “${linkLabel(link)}” in Revit…` : 'Showing in Revit…');
    }
  }

  /** Where the player stands (Revit internal metres), for carrying across a reload. */
  capturePose(): SessionPose {
    const o = this.scene.originOffset, p = this.player;
    return {
      feet: V.add(p.feet, o), yaw: p.yaw, pitch: p.pitch, flying: p.flying,
      home: V.add(p.homeFeet, o), homeYaw: p.homeYaw, homePitch: p.homePitch, homeFlying: p.homeFlying,
      activeGun: this.activeGun, showMap: this.showMap
    };
  }

  /** Puts the player back where a pose says (the new snapshot's origin may differ). */
  applyPose(pose: SessionPose): void {
    const o = this.scene.originOffset, p = this.player;
    if (pose.flying !== p.flying) { p.toggleFly(); }
    p.teleportTo(V.sub(pose.feet, o), pose.yaw, pose.pitch);
    p.setHomeTo(V.sub(pose.home, o), pose.homeYaw, pose.homePitch, pose.homeFlying);
    if (pose.activeGun >= 0 && pose.activeGun < this.guns.length) { this.activeGun = pose.activeGun; }
    this.showMap = pose.showMap;
  }

  /** The sidecar revisions now (comments, bookmarks, sun, visibility). */
  private sidecarRevisions(): [SidecarKind, number][] {
    return [['comments', this.comments.revision], ['bookmarks', this.bookmarks.revision], ['sun', this.sun.revision], ['visibility', this.visibilityRevision]];
  }

  private markSidecarsWritten(): void {
    for (const [kind, revision] of this.sidecarRevisions()) { this.sidecarRevision.set(kind, revision); }
  }

  /**
   * Live sessions keep comments, bookmarks, the sun and visibility beside the Revit model (the add-in writes the
   * files): changes are sent once they settle (the sun waits while its day plays).
   */
  private syncSidecars(dt: number): void {
    if (!this.live?.hello.sidecars) { return; }
    for (const [kind, revision] of this.sidecarRevisions()) {
      if (revision === this.sidecarRevision.get(kind)) {
        this.sidecarTimer.delete(kind);
        continue;
      }
      const delay = kind === 'sun' ? 2 : kind === 'visibility' ? 1 : 0.4;
      const left = (this.sidecarTimer.get(kind) ?? delay) - dt;
      if (left > 0 || (kind === 'sun' && this.sun.playing)) {
        this.sidecarTimer.set(kind, Math.max(left, 0));
        continue;
      }
      this.writeSidecar(kind, revision);
    }
  }

  /** Sends every changed sidecar now (before a reload or close). */
  private flushSidecars(): void {
    if (!this.live?.hello.sidecars) { return; }
    for (const [kind, revision] of this.sidecarRevisions()) {
      if (revision !== this.sidecarRevision.get(kind)) { this.writeSidecar(kind, revision); }
    }
  }

  private writeSidecar(kind: SidecarKind, revision: number): void {
    const live = this.live;
    if (!live) { return; }
    const document = kind === 'comments' ? SidecarJson.comments(this.comments.toDocument())
      : kind === 'bookmarks' ? SidecarJson.bookmarks(this.bookmarks.toDocument())
        : kind === 'sun' ? SidecarJson.sun(this.sun.settings)
          : SidecarJson.visibility(this.toVisibilitySettings());
    // Not connected: kept dirty, so it goes once the link is back
    if (live.writeSidecar(kind, document)) {
      this.sidecarRevision.set(kind, revision);
      this.sidecarTimer.delete(kind);
    }
  }

  // #endregion

  // #region Save

  /** Everything Save writes, as one comparable value. */
  private get saveKey(): string {
    return `${this.journal.revision}|${this.comments.revision}|${this.bookmarks.revision}|${this.sun.revision}|${this.visibilityRevision}|${this.dirtyRevision}`;
  }

  /** True when edits, comments, bookmarks, the sun, visibility or materials changed since the last save. */
  get isDirty(): boolean {
    return this.isFileMode && this.comments !== undefined && this.saveKey !== this.savedKey;
  }

  private markSaved(): void {
    this.savedKey = this.saveKey;
    this.updateTitle();
  }

  private updateTitle(): void {
    const title = this.isFileMode ? `${this.documentName}${this.isDirty ? ' *' : ''} · BimGo` : `${this.scene.modelTitle} · Revit · BimGo`;
    if (title === this.lastTitle) { return; }
    this.lastTitle = title;
    this.window.setTitle(title);
  }

  /** Hidden categories, links and elements, by stable keys (port of ToVisibilitySettings). */
  private toVisibilitySettings(): VisibilitySettings {
    const settings: VisibilitySettings = {
      hiddenCategories: [], hiddenLinks: [], hiddenElements: [], groundOffset: cleanGroundOffset(this.groundZ - this.groundDefault)
    };
    for (const def of CATEGORIES) {
      if (this.scene.categoryLoaded[def.index] && !this.categoryVisible[def.index]) { settings.hiddenCategories.push(def.key); }
    }
    for (const link of this.scene.links) {
      if (!this.linkVisible[link.index] && link.instanceUniqueId) { settings.hiddenLinks.push(link.instanceUniqueId); }
    }
    if (this.userHiddenCount > 0) {
      this.scene.elements.forEach((record, e) => {
        if (!this.userHidden[e]) { return; }
        const link = record.link > 0 ? this.scene.links.find(l => l.index === record.link)?.instanceUniqueId ?? null : null;
        settings.hiddenElements.push({ link, uniqueId: record.uniqueId || null, id: record.elementId });
      });
    }
    return settings;
  }

  /**
   * Ctrl+S / SAVE: writes back to the opened file where the browser allows it (Chrome / Edge), else downloads a copy.
   * Save As asks where (Chrome / Edge) or downloads. The location is chosen first, while the key press or click still
   * counts as a user gesture; the file on disk only changes once the whole file is written.
   * @returns True if saved.
   */
  async save(saveAs: boolean): Promise<boolean> {
    if (this.saving) { return false; }
    this.window.setCaptured(false);
    this.window.input.releaseAll();

    // A live walkthrough is saved as a new file (the model itself is already up to date in Revit)
    if (!this.isFileMode) { saveAs = true; }
    let handle: FileSystemFileHandle | null = null;
    let name = this.isFileMode ? this.documentName : `${safeFileName(this.scene.modelTitle)}.bimgo`;
    const picker = (window as unknown as SavePickerWindow).showSaveFilePicker;
    try {
      if (!saveAs && this.fileHandle && await canWrite(this.fileHandle)) {
        handle = this.fileHandle;
      } else if (picker) {
        handle = await picker.call(window, {
          id: 'bimgo-save',
          suggestedName: name,
          types: [{ description: 'BimGo model', accept: { 'application/octet-stream': ['.bimgo'] } }]
        });
        name = handle.name;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') { return false; }
      console.warn('Save location unavailable, downloading instead', e);
      handle = null;
    }

    const saving = {
      title: `Saving ${name}`,
      progress: { stage: 'Writing the .bimgo file', detail: '', fraction: 0, canCancel: true, cancelRequested: false } as ProgressState,
      abort: new AbortController()
    };
    this.saving = saving;
    try {
      const blob = await writeBimGo(this.document, {
        comments: this.comments.toDocument(),
        journal: this.journal,
        bookmarks: this.bookmarks.toDocument(),
        sun: { ...this.sun.settings, time: { ...this.sun.settings.time } },
        visibility: this.toVisibilitySettings(),
        materials: this.textures.current,
        savedBy: this.settings.userName
      }, { generator: 'BimGo Web', version: __BIMGO_VERSION__ }, this.isFileMode ? FileKinds.SAVE : FileKinds.SESSION_SAVE,
      f => { saving.progress.fraction = f; }, saving.abort.signal);

      if (handle) {
        saving.progress.stage = 'Writing to disk';
        const writable = await handle.createWritable();
        try {
          await writable.write(blob);
          await writable.close();
        } catch (e) {
          await writable.abort().catch(() => undefined);
          throw e;
        }
        if (this.isFileMode) { this.fileHandle = handle; }
      } else {
        downloadBlob(blob, name);
      }
    } catch (e) {
      const cancelled = saving.abort.signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
      if (!cancelled) { console.error(e); }
      this.sound.play(cancelled ? SoundId.UiClick : SoundId.Error);
      this.toast(cancelled ? 'Save cancelled: the file on disk was not changed.' : `The model could not be saved: ${e instanceof Error ? e.message : String(e)}`, 5);
      return false;
    } finally {
      this.saving = null;
      this.window.input.releaseAll();
    }

    if (this.source instanceof FileEditSource) {
      this.documentName = name;
      this.source.displayName = name;
      this.markSaved();
    }
    this.sound.play(SoundId.Commit);
    const pending = this.source.pending > 0 ? ` (${this.source.pending} edit${this.source.pending === 1 ? ' was' : 's were'} still waiting for Revit and not included)` : '';
    this.toast((handle ? `Saved ${name}` : `Saved ${name} to your Downloads folder`) + pending, handle && !pending ? 2.6 : 5);
    return true;
  }

  /** CLOSE MODEL: asks first when there are unsaved changes. */
  requestClose(): void {
    if (this.isDirty) {
      const summary = `${this.journal.count} edit(s), ${this.comments.comments.length} comment(s), ${this.bookmarks.bookmarks.length} bookmark(s)`;
      if (!confirm(`${this.documentName} has unsaved changes (${summary}).\n\nClose without saving? (Cancel, then SAVE, to keep them.)`)) { return; }
    }
    this.ended = true;
  }

  // #endregion


  /** Releases GPU resources, sound and the mouse. */
  dispose(): void {
    globalThis.removeEventListener('beforeunload', this.unloadGuard);
    if (this.comments) { this.flushSidecars(); }
    this.saving?.abort.abort();
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

/** The preset one step up (+1) or down (−1) from the one nearest the current value. */
function stepPreset(presets: number[], current: number, direction: number): number {
  let nearest = 0;
  presets.forEach((p, i) => { if (Math.abs(p - current) < Math.abs(presets[nearest] - current)) { nearest = i; } });
  return presets[clamp(nearest + Math.sign(direction), 0, presets.length - 1)];
}

interface SavePickerWindow {
  showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle>;
}

interface PermissionHandle {
  queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
}

/** True when the page may write to the handle (asks once if needed; needs a user gesture). */
async function canWrite(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as unknown as PermissionHandle;
  if (!h.queryPermission || !h.requestPermission) { return false; }
  if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') { return true; }
  return await h.requestPermission({ mode: 'readwrite' }) === 'granted';
}
