import type { BimGoDocument } from '../core/format/BimGoReader';
import { FpsCamera } from '../engine/render/FpsCamera';
import { Mat4 } from '../core/math/Matrix4x4';
import { clamp, type Vec3, vec3 } from '../core/math/Vector';
import { findCategory, KEY_DOORS } from '../core/scene/CategoryCatalog';
import type { RoomInfo, SceneData } from '../core/scene/SceneData';
import { gl } from '../engine/gl/Gl';
import { Bvh, type RayHit } from '../engine/physics/Bvh';
import { CharacterController } from '../engine/physics/CharacterController';
import { SceneBatches } from '../engine/render/SceneBatches';
import { type SceneDrawParams, SceneRenderer } from '../engine/render/SceneRenderer';
import { Rgba } from '../engine/ui/Rgba';
import { TextBuffer } from '../engine/ui/TextBuffer';
import { roundEven, UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { type InputState, Vk } from '../platform/input';
import type { GameWindow } from '../platform/window';
import { Player } from './Player';
import type { ViewerSettings } from './ViewerSettings';

/** Why a walkthrough ended. */
export type SessionEnd = 'closed';

const HELP_ROWS: [string, string][] = [
  ['WASD', 'Move'],
  ['SPACE / CTRL', 'Jump / Crouch'],
  ['SHIFT', 'Run'],
  ['V', 'Fly / walk (no-clip)'],
  ['PGUP / PGDN', 'Level up / down'],
  ['H · SHIFT+H', 'Go home · Set home here'],
  ['TAB', 'Minimap'],
  ['ESC · P', 'Pause menu'],
  ['F1', 'Hide help · BimGo Web ' + __BIMGO_VERSION__]
];

/**
 * One walkthrough of a model (port of BimGo.App/Game/GameSession.cs and GameSession.Render.cs, Phase 1: walk, fly,
 * levels, home, rooms, minimap, help and the status panel). The browser drives it one animation frame at a time.
 */
export class GameSession {
  private static readonly TICK = 1 / 120;
  private static readonly GROUND_BELOW_LOWEST_LEVEL = 0.1;
  private static readonly MAP_METRES_ACROSS = 34;

  readonly scene: SceneData;
  readonly camera = new FpsCamera();
  private readonly text = new TextBuffer();
  private batches!: SceneBatches;
  private renderer!: SceneRenderer;
  private bvh!: Bvh;
  private player!: Player;

  private readonly categoryVisible: boolean[];
  private readonly linkVisible: boolean[];
  private readonly groupVisible: boolean[];
  private readonly pickMask: boolean[];
  private readonly collisionMask: boolean[];
  private readonly levelNamesUpper: string[];
  private readonly doorCategory: number;

  private showHelp = true;
  private showMap = true;
  private groundZ = 0;
  private paused = false;
  private pausedByLockLoss = false;
  private ended = false;
  private startedAtSavedHome = false;
  private accumulator = 0;
  private clock = 0;

  // Rooms
  private roomIndex = -1;
  private roomCheckedAt: Vec3 = vec3(Infinity, Infinity, Infinity);
  private roomBannerUntil = 0;

  // Feedback and timing
  private toastText: string | null = null;
  private toastUntil = 0;
  private fps = 0;
  private frameMs = 0;
  private fpsAccumulator = 0;
  private fpsFrames = 0;
  private readonly mapPlanes = new Float32Array(24);
  private helpScale = -1;
  private helpKeyWidth = 0;
  private helpActionWidth = 0;

  constructor(
    private readonly window: GameWindow,
    private readonly ui: UiBatch,
    readonly document: BimGoDocument,
    private readonly settings: ViewerSettings
  ) {
    const scene = document.scene;
    this.scene = scene;
    this.categoryVisible = [...scene.categoryLoaded];
    this.linkVisible = new Array<boolean>(scene.links.length + 1).fill(true);
    this.groupVisible = new Array<boolean>(SceneBatches.groupCount(scene)).fill(false);
    this.updateGroupVisibility();
    this.pickMask = new Array<boolean>(scene.elements.length).fill(false);
    this.collisionMask = new Array<boolean>(scene.elements.length).fill(false);
    this.doorCategory = findCategory(KEY_DOORS)?.index ?? -1;
    this.levelNamesUpper = scene.levels.map(l => l.name.toUpperCase());
  }

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
    console.info(`Batches ${this.batches.batches.length} / chunks ${this.batches.chunkTotal}, BVH nodes ${this.bvh.nodeCount} in ${Math.round(performance.now() - started)} ms.`);

    const controller = new CharacterController(this.bvh);
    controller.stepHeight = this.settings.maxStepHeightMm / 1000;
    controller.collisionMask = this.collisionMask;
    this.player = new Player(controller);
    this.refreshMasks();

    // Ground: just below the lowest level (or the model)
    this.groundZ = (this.scene.levels.length > 0 ? this.scene.levels[0].elevation : this.scene.bounds.min.z) - GameSession.GROUND_BELOW_LOWEST_LEVEL;
    controller.groundZ = this.groundZ;

    this.spawn();
    this.window.setTitle(`${this.scene.modelTitle} · BimGo`);

    const links = this.scene.links.length > 0 ? ` · ${this.scene.links.length} linked model${this.scene.links.length === 1 ? '' : 's'}` : '';
    const edits = this.document.journal.count > 0 ? ` · ${this.document.journal.count} saved edit${this.document.journal.count === 1 ? '' : 's'} (not shown yet)` : '';
    const start = this.startedAtSavedHome ? ' Starting at your saved home.' : '';
    if (this.scene.phaseNote) { this.toast(this.scene.phaseNote, 6); }
    else {
      this.toast(`${this.scene.elements.length.toLocaleString('en')} elements · ${(this.scene.geometry.indices.length / 3).toLocaleString('en')} triangles${links}${edits}.${start} Click to look around.`,
        this.startedAtSavedHome ? 4 : 2.6);
    }
  }

  private spawn(): void {
    const player = this.player;
    const home = this.document.bookmarks.home;
    if (home) {
      if (home.flying !== player.flying) { player.toggleFly(); }
      player.teleportTo(this.toLocal(home.x, home.y, home.z), home.yaw, clamp(home.pitch, -1.5, 1.5));
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

  /** Revit internal coordinates (bookmarks, comments) to scene-local. */
  private toLocal(x: number, y: number, z: number): Vec3 {
    const o = this.scene.originOffset;
    return vec3(x - o.x, y - o.y, z - o.z);
  }

  private refreshMasks(): void {
    this.updateGroupVisibility();
    const elements = this.scene.elements;
    for (let e = 0; e < elements.length; e++) {
      const visible = this.groupVisible[SceneBatches.groupOf(elements[e])];
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
    this.render();
    this.updateFps(dt);
    return null;
  }

  /** Called when the browser released the mouse (Esc, focus loss). */
  onCaptureLost(): void {
    if (!this.paused) {
      this.setPaused(true);
      this.pausedByLockLoss = true;
    }
  }

  private updateFrame(): void {
    const input = this.window.input;
    if (this.window.isMinimised && !this.paused) { this.setPaused(true); }

    // Esc releases the mouse in the browser (onCaptureLost pauses); P and Esc toggle while it is free. Some browsers
    // also deliver the Esc that ended the lock: it must not undo that pause in the same frame.
    const escape = input.isPressed(Vk.ESCAPE) && !this.pausedByLockLoss;
    this.pausedByLockLoss = false;
    if (escape || input.isPressed(Vk.key('P'))) { this.setPaused(!this.paused); }
    if (input.isPressed(Vk.F1)) { this.showHelp = !this.showHelp; }
    if (input.isPressed(Vk.F11)) { toggleFullscreen(); }
    if (this.paused) {
      this.updatePauseMenu(input);
      return;
    }

    this.updateRoom();

    if (input.isPressed(Vk.TAB)) { this.showMap = !this.showMap; }
    if (input.isPressed(Vk.key('V'))) {
      this.player.toggleFly();
      this.toast(this.player.flying ? 'Fly mode (no-clip)' : 'Walk mode');
    }
    if (input.isPressed(Vk.key('H'))) {
      if (input.isDown(Vk.SHIFT)) {
        this.player.setHome();
        this.toast('Home set here: H returns here (saving it in the file comes with editing)', 3.5);
      } else {
        this.player.goHome();
      }
    }
    if (input.isPressed(Vk.PRIOR)) { this.teleportLevel(+1); }
    if (input.isPressed(Vk.NEXT)) { this.teleportLevel(-1); }
    if (input.isPressed(Vk.SPACE) && !this.player.flying) { this.player.queueJump(); }

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
    this.player.fixedUpdate(dt, this.window.input, !this.window.isMinimised);
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

  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.window.setCaptured(!paused);
    this.window.input.releaseAll();
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

  toast(message: string, seconds = 2.6): void {
    this.toastText = message;
    this.toastUntil = this.clock + seconds;
  }

  pick(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null {
    return this.bvh.raycast(origin, direction, maxDistance, this.pickMask);
  }

  // #endregion

  // #region Rooms

  private get currentRoom(): RoomInfo | null {
    return this.roomIndex >= 0 ? this.scene.rooms[this.roomIndex] : null;
  }

  /** Re-evaluates the current room when the player has moved a little; starts the banner on a change. */
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

      // Even-odd over all loops (islands become holes automatically)
      let inside = false;
      for (const loop of room.loops) {
        if (insidePolygon(loop, x, y)) { inside = !inside; }
      }
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

    const p: SceneDrawParams = {
      viewProjection: this.camera.viewProjection,
      planes: this.camera.planes,
      eye: this.camera.position,
      whitecard: this.settings.whitecard,
      realistic: false,
      plan: false,
      clipZMin: -1e7,
      clipZMax: 1e7,
      fogDensity: 0.0022,
      sun: true
    };

    this.renderer.drawStatic(p, this.groupVisible, false);
    this.renderer.drawGround(this.camera, this.groundZ);

    // Transparent pass (glass etc.)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    this.renderer.drawStatic(p, this.groupVisible, true);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // ---- Window pass: minimap 3D, then all 2D UI in one batch
    const mapX = width - this.s(20) - this.s(220), mapY = this.s(20);
    if (this.showMap && !this.paused) { this.drawMinimapPlan(mapX + this.s(8), mapY + this.s(30), this.s(204), this.s(170)); }

    if (this.paused) { this.buildPauseMenu(); }
    else { this.buildHud(mapX, mapY); }
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
    const metresHigh = metresAcross * h / w;

    const eye = vec3(feet.x, feet.y, elevation + 60);
    const view = Mat4.createLookAt(eye, vec3(eye.x, eye.y, eye.z - 1), vec3(0, 1, 0));
    const projection = FpsCamera.orthographic(metresAcross, metresHigh, 1, 200);
    const viewProjection = Mat4.multiply(view, projection);
    FpsCamera.extractPlanes(viewProjection, this.mapPlanes);

    gl.enable(gl.DEPTH_TEST);
    this.renderer.drawStatic({
      viewProjection,
      planes: this.mapPlanes,
      eye,
      whitecard: this.settings.whitecard,
      realistic: false,
      plan: true,
      clipZMin: elevation - 0.3,
      clipZMax: elevation + 1.2,
      fogDensity: 0,
      sun: false
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
    this.text.clear().append('MAP · ').append(this.levelNamesUpper.length > 0 ? this.levelNamesUpper[this.levelIndexAt(feet.z)] : '—');
    ui.text(f.small, x + this.s(8), y + this.s(9), this.text.text, UiTheme.TEXT_MUTED, this.s(1));
    ui.textRight(f.small, x + w - this.s(8), y + this.s(9), 'TAB', UiTheme.TEXT_MUTED, this.s(1));

    const metresPerPixel = GameSession.MAP_METRES_ACROSS / mapW;
    const cx = mapX + mapW * 0.5, cy = mapY + mapH * 0.5;
    const levelIndex = this.levelIndexAt(feet.z);

    // Bookmarks on this level
    for (const bookmark of this.document.bookmarks.bookmarks) {
      const local = this.toLocal(bookmark.x, bookmark.y, bookmark.z);
      if (this.levelIndexAt(local.z) !== levelIndex) { continue; }
      const mx = cx + (local.x - feet.x) / metresPerPixel, my = cy - (local.y - feet.y) / metresPerPixel;
      const radius = this.s(3);
      if (mx < mapX + radius || mx > mapX + mapW - radius || my < mapY + radius || my > mapY + mapH - radius) { continue; }
      ui.circle(mx, my, radius, UiTheme.BOOKMARK, 12);
    }

    // View cone and player arrow (north up, screen Y down)
    const angle = -this.player.yaw;
    const halfFov = this.settings.fieldOfView * Math.PI / 360;
    ui.wedge(cx, cy, this.s(56), angle - halfFov, angle + halfFov, Rgba.withAlpha(UiTheme.ACCENT, 0.13));
    const fx = Math.cos(angle), fy = Math.sin(angle), sx = -fy, sy = fx;
    const tipX = cx + fx * this.s(10), tipY = cy + fy * this.s(10);
    const leftX = cx - fx * this.s(6) + sx * this.s(7), leftY = cy - fy * this.s(6) + sy * this.s(7);
    const rightX = cx - fx * this.s(6) - sx * this.s(7), rightY = cy - fy * this.s(6) - sy * this.s(7);
    const notchX = cx - fx * this.s(2), notchY = cy - fy * this.s(2);
    ui.triangle(tipX, tipY, leftX, leftY, notchX, notchY, UiTheme.ACCENT);
    ui.triangle(tipX, tipY, notchX, notchY, rightX, rightY, UiTheme.ACCENT);
  }

  // #endregion

  // #region HUD

  private buildHud(mapX: number, mapY: number): void {
    const ui = this.ui, f = ui.atlas;
    const width = this.window.width, height = this.window.height;

    // Crosshair
    const cx = roundEven(width * 0.5), cy = roundEven(height * 0.5);
    const t1 = this.s(2), gap = this.s(5), arm = this.s(9);
    ui.rect(cx - t1 * 0.5, cy - gap - arm, t1, arm, UiTheme.TEXT);
    ui.rect(cx - t1 * 0.5, cy + gap, t1, arm, UiTheme.TEXT);
    ui.rect(cx - gap - arm, cy - t1 * 0.5, arm, t1, UiTheme.TEXT);
    ui.rect(cx + gap, cy - t1 * 0.5, arm, t1, UiTheme.TEXT);
    ui.circle(cx, cy, this.s(1.8), UiTheme.SCAN, 10);

    if (!this.window.isCaptured) {
      const hint = 'Click to look around';
      const hintWidth = UiBatch.measure(f.body, hint) + this.s(24);
      ui.panel(cx - hintWidth * 0.5, cy + this.s(28), hintWidth, this.s(28), UiTheme.PANEL, UiTheme.PANEL_BORDER);
      ui.textCentred(f.body, cx, cy + this.s(34), hint, UiTheme.TEXT);
    }

    this.buildStatusPanel(f);
    if (this.showMap) { this.drawMinimapOverlay(mapX, mapY); }
    this.buildHelp(f, height);
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
      this.text.clear().appendNumber(level.elevation, 3, true);
      ui.text(f.mono, valueX + used + this.s(6), rowY + this.s(1), this.text.text, UiTheme.TEXT_SOFT);
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
    this.text.clear().appendNumber(this.groundZ, 3).append(' m');
    ui.text(f.mono, valueX, rowY + this.s(1), this.text.text, UiTheme.TEXT);
    rowY += row;

    ui.text(f.body, labelX, rowY, 'VIEW', UiTheme.TEXT_MUTED);
    ui.text(f.body, valueX, rowY, this.settings.whitecard ? 'Whitecard' : 'Material colour', UiTheme.TEXT);
  }

  private buildHelp(f: FontAtlas, height: number): void {
    const ui = this.ui;
    const x = this.s(20);
    if (!this.showHelp) {
      ui.text(f.mono, x, height - this.s(36), 'F1  Help', UiTheme.TEXT_MUTED);
      return;
    }

    // Columns sized to the widest key and action (measured once per UI scale)
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
    const remaining = this.toastUntil - this.clock;
    const alpha = clamp(remaining / 0.4, 0, 1);
    const w = UiBatch.measure(f.body, this.toastText) + this.s(32), h = this.s(32);
    const x = width * 0.5 - w * 0.5, y = this.s(20);
    ui.panel(x, y, w, h, Rgba.withAlpha(UiTheme.PANEL_STRONG, 0.88 * alpha), Rgba.withAlpha(UiTheme.ACCENT, 0.6 * alpha));
    ui.text(f.body, x + this.s(16), y + this.s(7), this.toastText, Rgba.withAlpha(UiTheme.TEXT, alpha));
  }

  // #endregion

  // #region Pause menu (interim: the full desktop menu arrives with Phase 2)

  private pauseButtons: { label: string; x: number; y: number; w: number; h: number; action: () => void }[] = [];

  private buildPauseMenu(): void {
    const ui = this.ui, f = ui.atlas;
    const width = this.window.width, height = this.window.height;
    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    const w = this.s(360), x = roundEven(width * 0.5 - w * 0.5);
    let y = roundEven(height * 0.5 - this.s(150));
    ui.textCentred(f.title, width * 0.5, y, 'PAUSED', UiTheme.TEXT, this.s(4));
    y += this.s(60);
    ui.textCentred(f.body, width * 0.5, y, this.scene.modelTitle, UiTheme.TEXT_MUTED);
    y += this.s(36);

    this.pauseButtons = [
      { label: 'RESUME', action: () => this.setPaused(false) },
      { label: `VIEW: ${this.settings.whitecard ? 'WHITECARD' : 'MATERIAL COLOUR'}`, action: () => this.settings.toggleWhitecard() },
      { label: 'CLOSE MODEL', action: () => { this.ended = true; } }
    ].map((b, i) => ({ ...b, x, y: y + i * this.s(58), w, h: this.s(48) }));

    const input = this.window.input;
    for (const [i, b] of this.pauseButtons.entries()) {
      const hover = input.mouseX >= b.x && input.mouseX < b.x + b.w && input.mouseY >= b.y && input.mouseY < b.y + b.h;
      if (i === 0) { ui.rect(b.x, b.y, b.w, b.h, hover ? Rgba.hex(0x67e8f9) : UiTheme.ACCENT); }
      else {
        ui.rect(b.x, b.y, b.w, b.h, hover ? Rgba.hex(0xffffff, 0.08) : Rgba.hex(0xffffff, 0));
        ui.outline(b.x, b.y, b.w, b.h, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.2));
      }
      ui.text(f.bold, b.x + this.s(16), b.y + b.h * 0.5 - f.bold.lineHeight * 0.5, b.label, i === 0 ? Rgba.hex(0x06232a) : UiTheme.TEXT, this.s(1.3));
    }
    ui.textCentred(f.small, width * 0.5, y + 3 * this.s(58) + this.s(8), 'ESC OR P TO RESUME · CLICK THE VIEW TO LOOK AROUND', UiTheme.TEXT_FAINT, this.s(1));
  }

  private updatePauseMenu(input: InputState): void {
    if (!input.leftPressed) { return; }
    for (const b of this.pauseButtons) {
      if (input.mouseX >= b.x && input.mouseX < b.x + b.w && input.mouseY >= b.y && input.mouseY < b.y + b.h) {
        input.consumeClicks();
        b.action();
        return;
      }
    }
  }

  // #endregion

  /** Releases GPU resources and the mouse. */
  dispose(): void {
    this.window.setCaptured(false);
    this.renderer?.dispose();
  }

  private s(value: number): number {
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

function toggleFullscreen(): void {
  if (document.fullscreenElement) { void document.exitFullscreen(); }
  else { void document.documentElement.requestFullscreen().catch(() => undefined); }
}
