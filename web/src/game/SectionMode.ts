import { type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import { type LocalPlane, SectionCut } from '../core/scene/SectionCut';
import type { RayHit } from '../engine/physics/Bvh';
import { Overlay3D } from '../engine/render/Overlay3D';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import { Widgets } from './Menus';

/** The default cap colour (dark grey). */
export const DEFAULT_CAP_COLOUR = 0x3d4045;
/** A quick plane sits this far behind the aimed surface (m). */
const QUICK_PLANE_DEPTH = 0.05;
/** Handle drags snap to this step (m) unless Shift is held. */
const SECTION_SNAP = 0.05;

const axisOf = (v: Vec3, a: number) => (a === 0 ? v.x : a === 1 ? v.y : v.z);
function withAxis(v: Vec3, a: number, value: number): Vec3 {
  return vec3(a === 0 ? value : v.x, a === 1 ? value : v.y, a === 2 ? value : v.z);
}

/** "#3D4045" ↔ 0x3d4045 (port of LaunchSettings.TryParseColour). */
export function parseColour(text: unknown): number | null {
  const hex = typeof text === 'string' ? text.trim().replace(/^#/, '') : '';
  return /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : null;
}
export const formatColour = (rgb: number) => '#' + (rgb & 0xffffff).toString(16).toUpperCase().padStart(6, '0');

/**
 * Section box and quick plane (port of GameSession.Section.cs).
 * - P opens the box editor (free cursor, player still, RMB-drag looks): the first time it fits the box to the level
 *   you stand on. Drag a face's handle along its axis (0.05 m steps; Shift: free). The panel switches the box and
 *   plane, fits it again (level, room, model), sets the caps' flat colour and clears. P / Esc closes; the cut stays.
 * - Shift+P cuts at the aimed surface: a plane parallel to it, 5 cm behind it, removing your side.
 * - Ctrl+P clears every cut.
 * The scene shaders draw the cut (capped); picking and the tools skip what it removes, collision and shadows don't.
 * Saved with the model (visibility), in bookmarks and comment views, and exchanged as BCF clipping planes.
 */
export class SectionMode {
  open = false;
  /** The current cut (Revit internal metres). */
  private cut = new SectionCut();
  /** Its planes in scene-local coordinates (what the shaders and picking use). */
  planes: LocalPlane[] = [];
  /** The cap colour (0xRRGGBB) and its RGB 0–1 form. */
  capRgb = DEFAULT_CAP_COLOUR;
  capColour: Vec3 = vec3(0x3d / 255, 0x40 / 255, 0x45 / 255);
  private readonly w: Widgets;
  private overlay: Overlay3D | null = null;
  private panelRect = [0, 0, 0, 0];
  private notice: string | null = null;
  // Handles: 0–5 box faces (+X, −X, +Y, −Y, +Z, −Z), 6 the free plane; -1 none
  private hover = -1;
  private drag = -1;
  private dragAxis: Vec3 = vec3();
  private dragOrigin: Vec3 = vec3();
  private dragStartParameter = 0;
  private dragLastDelta = 0;
  private colourInput: HTMLInputElement | null = null;

  constructor(private readonly session: GameSession) {
    this.w = new Widgets(session);
    const saved = parseColour(session.settings.sectionCapColour);
    if (saved !== null) { this.setCapColour(saved, false); }
  }

  private s(v: number): number { return this.session.s(v); }

  /** The cut as it is now (a copy is taken by whoever stores it). */
  get current(): SectionCut { return this.cut; }

  get isActive(): boolean { return this.planes.length > 0; }

  // #region Cut

  /** Makes a cut current (copied); announce says what changed (off for bookmarks and comment views). */
  apply(cut: SectionCut | null, announce = true): void {
    this.cut = (cut ?? new SectionCut()).clone().clean();
    this.changed();
    if (announce) { this.session.toast(this.cut.isActive ? 'Section cut on (P edits, Ctrl+P clears)' : 'Section cut off', 3); }
  }

  /** Restores the cut saved with the model (no save is triggered). */
  restore(saved: SectionCut | null): void {
    if (!saved?.isActive) { return; }
    this.cut = saved.clone().clean();
    this.updatePlanes();
  }

  /** Recomputes the planes after any change and records it for saving. */
  private changed(): void {
    this.updatePlanes();
    this.session.visibilityChanged();
  }

  private updatePlanes(): void {
    this.planes = this.cut.localPlanes(this.session.scene.originOffset);
    this.session.renderer?.setSection(this.planes, this.cut.boxOn);
  }

  /** True when a scene-local point is cut away. */
  isCut(p: Vec3): boolean {
    return this.planes.length > 0 && SectionCut.isCut(this.planes, p.x, p.y, p.z);
  }

  /** Ctrl+P / CLEAR ALL: no box, no plane. */
  clear(): void {
    const session = this.session;
    if (!this.cut.isActive) {
      session.toast('Nothing is cut', 2);
      return;
    }
    this.cut.boxOn = false;
    this.cut.planeOn = false;
    this.changed();
    session.sound.play(SoundId.Remove);
    session.toast('Section cut cleared', 2);
  }

  /** Shift+P: a plane parallel to the aimed surface, a little behind it, cutting away the side you're on. */
  quickPlane(): void {
    const session = this.session, aim = session.aim;
    if (!aim.hasHit || !aim.hit) {
      session.sound.play(SoundId.Error);
      session.toast('Aim at a surface to cut there (Shift+P)', 3);
      return;
    }
    // The hit normal faces the eye: the cut-away side is the eye's. Follow the view ray through the aimed element (a
    // wall's thickness, a slab's depth) so the plane sits just behind it and the space beyond opens up.
    const hit = aim.hit, normal = V.normalize(hit.normal), dir = aim.direction;
    let exit = hit.point;
    for (let i = 0; i < 8; i++) {
      const next: RayHit | null = session.pickStatic(V.add(exit, V.scale(dir, 0.002)), dir, 1.5);
      if (!next || next.element !== hit.element) { break; }
      exit = next.point;
    }
    const thickness = Math.min(Math.max(V.dot(V.sub(hit.point, exit), normal), 0), 1.5);
    const point = V.sub(hit.point, V.scale(normal, thickness + QUICK_PLANE_DEPTH));
    this.cut.planeOn = true;
    this.cut.planePoint = session.toRevit(point);
    this.cut.planeNormal = normal;
    this.cut.clean();
    this.changed();
    session.sound.play(SoundId.UiClick);
    session.toast('Plane cut at the aimed surface (P to drag it, Ctrl+P clears)', 3);
  }

  /** Fits the box to the level the player stands on: model footprint, level to just under the next. */
  private fitToLevel(): void {
    const session = this.session, scene = session.scene, b = scene.bounds;
    const min = V.sub(b.min, vec3(1, 1, 1)), max = V.add(b.max, vec3(1, 1, 1));
    if (scene.levels.length > 0) {
      const level = session.levelIndexAt(session.player.feet.z);
      min.z = scene.levels[level].elevation - 1;
      max.z = level + 1 < scene.levels.length ? scene.levels[level + 1].elevation - 0.4 : b.max.z + 1;
    }
    this.setBoxLocal(min, max);
    this.notice = scene.levels.length > 0 ? 'Box fitted to ' + session.levelNameAt(session.player.feet.z) : 'Box fitted to the model';
  }

  /** Fits the box to the room the player stands in (floor to top, plus a margin). */
  private fitToRoom(): void {
    const session = this.session, room = session.currentRoom;
    if (!room) {
      this.notice = 'You are not in a room';
      session.sound.play(SoundId.Error);
      return;
    }
    this.setBoxLocal(vec3(room.min.x - 0.5, room.min.y - 0.5, room.bottomZ - 0.5), vec3(room.max.x + 0.5, room.max.y + 0.5, room.topZ + 0.2));
    this.notice = 'Box fitted to ' + session.roomLabel(session.currentRoomIndex);
  }

  private fitToModel(): void {
    const b = this.session.scene.bounds;
    this.setBoxLocal(V.sub(b.min, vec3(1, 1, 1)), V.add(b.max, vec3(1, 1, 1)));
    this.notice = 'Box fitted to the model';
  }

  private setBoxLocal(min: Vec3, max: Vec3): void {
    this.cut.boxOn = true;
    this.cut.boxMin = this.session.toRevit(min);
    this.cut.boxMax = this.session.toRevit(max);
    this.cut.clean();
    this.changed();
  }

  // #endregion

  // #region Editor

  /** P: opens the box editor (fitting a box to the current level the first time). */
  show(): void {
    const session = this.session;
    if (this.open) { return; }
    if (session.paused) { session.setPaused(false); }
    session.closeModes(this);
    session.showUi();
    if (!this.cut.boxOn && !this.cut.planeOn) { this.fitToLevel(); }
    this.open = true;
    this.drag = this.hover = -1;
    session.releaseMouseForTyping();
    session.sound.play(SoundId.UiClick);
  }

  /** Closes the editor (the cut stays). */
  close(): void {
    if (!this.open) { return; }
    this.open = false;
    this.drag = -1;
    this.session.input.releaseAll();
  }

  /** Keys and mouse while the editor is open: P / Esc close, RMB-drag looks, LMB drags a handle along its axis. */
  updateMode(input: InputState): void {
    const session = this.session;
    if (input.isPressed(Vk.ESCAPE) || (input.isPressed(Vk.key('P')) && !input.isDown(Vk.CONTROL))) {
      this.close();
      return;
    }
    if (input.rightDown) { session.player.look(input.mouseDeltaX, input.mouseDeltaY, session.settings.mouseSensitivity, session.settings.invertY); }

    const mx = input.mouseX, my = input.mouseY;
    const [px, py, pw, ph] = this.panelRect;
    const overPanel = mx >= px && mx < px + pw && my >= py && my < py + ph;
    if (this.drag >= 0) {
      if (!input.leftDown) {
        this.drag = -1;
        session.sound.play(SoundId.UiClick);
        return;
      }
      this.dragHandle(mx, my, input.isDown(Vk.SHIFT));
      return;
    }
    this.hover = overPanel ? -1 : this.handleUnder(mx, my);
    if (input.leftPressed && this.hover >= 0) {
      input.consumeClicks();
      this.beginDrag(this.hover, mx, my);
    }
  }

  /** The handle nearest the mouse (within 18 px), or -1. */
  private handleUnder(mx: number, my: number): number {
    let best = -1, bestDistance = this.s(18);
    for (let h = 0; h < 7; h++) {
      const handle = this.handlePosition(h);
      if (!handle) { continue; }
      const screen = this.session.camera.worldToScreen(handle.position);
      if (!screen) { continue; }
      const distance = Math.hypot(screen.x - mx, screen.y - my);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = h;
      }
    }
    return best;
  }

  /** A handle's position (scene-local) and its axis (outward for box faces, the plane's normal). */
  private handlePosition(handle: number): { position: Vec3; axis: Vec3 } | null {
    const origin = this.session.scene.originOffset, cut = this.cut;
    if (handle < 6) {
      if (!cut.boxOn) { return null; }
      const min = V.sub(cut.boxMin, origin), max = V.sub(cut.boxMax, origin);
      const a = handle >> 1, positive = handle % 2 === 0;
      const position = withAxis(V.scale(V.add(min, max), 0.5), a, positive ? axisOf(max, a) : axisOf(min, a));
      return { position, axis: withAxis(vec3(), a, positive ? 1 : -1) };
    }
    if (!cut.planeOn) { return null; }
    return { position: V.sub(cut.planePoint, origin), axis: V.copy(cut.planeNormal) };
  }

  private beginDrag(handle: number, mx: number, my: number): void {
    const h = this.handlePosition(handle);
    if (!h) { return; }
    const ray = this.session.screenRay(mx, my);
    const parameter = closestOnAxis(h.position, h.axis, ray.origin, ray.direction);
    if (parameter === null) { return; }
    this.drag = handle;
    this.dragAxis = h.axis;
    this.dragOrigin = h.position;
    this.dragStartParameter = parameter;
    this.dragLastDelta = 0;
    this.session.sound.play(SoundId.UiClick);
  }

  /** Moves the dragged face (or plane) to where the mouse ray passes closest to its axis, snapped unless free. */
  private dragHandle(mx: number, my: number, free: boolean): void {
    const ray = this.session.screenRay(mx, my);
    const parameter = closestOnAxis(this.dragOrigin, this.dragAxis, ray.origin, ray.direction);
    if (parameter === null) { return; }
    let delta = parameter - this.dragStartParameter;
    if (!free) { delta = Math.round(delta / SECTION_SNAP) * SECTION_SNAP; }
    if (Math.abs(delta - this.dragLastDelta) < 1e-5) { return; }
    this.dragLastDelta = delta;

    const world = this.session.toRevit(V.add(this.dragOrigin, V.scale(this.dragAxis, delta)));
    const cut = this.cut;
    if (this.drag < 6) {
      const a = this.drag >> 1;
      if (this.drag % 2 === 0) { cut.boxMax = withAxis(cut.boxMax, a, Math.max(axisOf(world, a), axisOf(cut.boxMin, a) + SectionCut.MIN_SIZE)); }
      else { cut.boxMin = withAxis(cut.boxMin, a, Math.min(axisOf(world, a), axisOf(cut.boxMax, a) - SectionCut.MIN_SIZE)); }
    } else {
      cut.planePoint = world;
    }
    this.changed();
  }

  /** CHANGE…: the browser's colour picker for the caps. */
  private pickCapColour(): void {
    if (!this.colourInput) {
      const input = document.createElement('input');
      input.type = 'color';
      input.style.position = 'fixed';
      input.style.opacity = '0';
      input.style.pointerEvents = 'none';
      input.style.left = '50%';
      input.style.top = '30%';
      input.addEventListener('input', () => {
        const rgb = parseColour(input.value);
        if (rgb !== null) { this.setCapColour(rgb, true); }
      });
      document.body.appendChild(input);
      this.colourInput = input;
    }
    this.colourInput.value = formatColour(this.capRgb).toLowerCase();
    this.session.input.releaseAll();
    this.colourInput.click();
  }

  /** Sets the cap colour (0xRRGGBB); saved with the settings. */
  setCapColour(rgb: number, save: boolean): void {
    this.capRgb = rgb & 0xffffff;
    this.capColour = vec3(((this.capRgb >> 16) & 0xff) / 255, ((this.capRgb >> 8) & 0xff) / 255, (this.capRgb & 0xff) / 255);
    if (!save) { return; }
    this.notice = `Cap colour ${formatColour(this.capRgb)}`;
    this.session.settings.sectionCapColour = formatColour(this.capRgb);
    this.session.settings.save();
  }

  // #endregion

  // #region Drawing

  /** The cut's frame and handles while the editor is open (3D pass, after the scene). */
  drawGizmo(): void {
    if (!this.open || !this.cut.isActive) { return; }
    const camera = this.session.camera;
    if (!this.overlay) {
      this.overlay = new Overlay3D();
      this.overlay.initialise();
    }
    const overlay = this.overlay, cut = this.cut, origin = this.session.scene.originOffset;
    overlay.begin(camera);
    const edge = Rgba.hex(0x22d3ee, 0.9);
    if (cut.boxOn) {
      const min = V.sub(cut.boxMin, origin), max = V.sub(cut.boxMax, origin);
      const corner = (i: number, top: boolean) => vec3(i === 1 || i === 2 ? max.x : min.x, i >= 2 ? max.y : min.y, top ? max.z : min.z);
      for (let i = 0; i < 4; i++) {
        const a = corner(i, false), b = corner((i + 1) % 4, false), c = corner(i, true), d = corner((i + 1) % 4, true);
        overlay.line(a, b, 2, edge);
        overlay.line(c, d, 2, edge);
        overlay.line(a, c, 2, edge);
      }
    }
    if (cut.planeOn) {
      const p = V.sub(cut.planePoint, origin), n = cut.planeNormal;
      const t = Math.abs(n.z) < 0.9 ? V.normalize(V.cross(vec3(0, 0, 1), n)) : V.normalize(V.cross(vec3(1, 0, 0), n));
      const s = V.cross(n, t);
      overlay.ring(p, t, s, 1.5, 1.5, 0.03, Rgba.hex(0xfbbf24, 0.9));
      overlay.line(p, V.add(p, V.scale(n, 0.8)), 3, Rgba.hex(0xfbbf24, 0.9));
    }
    for (let h = 0; h < 7; h++) {
      const handle = this.handlePosition(h);
      if (!handle) { continue; }
      const active = h === this.drag || (h === this.hover && this.drag < 0);
      const colour = active ? Rgba.hex(0xffffff, 1) : h === 6 ? Rgba.hex(0xfbbf24, 1) : Rgba.hex(0x22d3ee, 1);
      overlay.dot(handle.position, active ? 11 : 8, colour);
    }
    overlay.draw(camera, false, 1, false);
  }

  /** The editor's panel (top right): fit buttons, box / plane switches, cap colour, clear, close. */
  buildPanel(f: FontAtlas, input: InputState): void {
    if (!this.open) { return; }
    const session = this.session, ui = session.ui, w = this.w, cut = this.cut;
    if (!input.leftDown) { w.activeSlider = -1; }
    const pw = this.s(300), x = session.screenWidth - this.s(20) - pw, y = this.s(20), ph = this.s(372);
    this.panelRect = [x, y, pw, ph];
    ui.panel(x, y, pw, ph, UiTheme.PANEL_STRONG, UiTheme.ACCENT);
    const ix = x + this.s(16), iw = pw - this.s(32);
    let cy = y + this.s(14);
    ui.text(f.small, ix, cy, 'SECTION BOX', UiTheme.ACCENT, this.s(1.4));
    cy += this.s(26);
    ui.textWrapped(f.small, ix, cy, iw, 'Drag a handle along its arrow (Shift: no snap) · RMB-drag to look', UiTheme.TEXT_MUTED, 2);
    cy += this.s(38);

    const half = (iw - this.s(8)) * 0.5;
    if (w.smallButton(f, ix, cy, half, this.s(30), cut.boxOn ? 'BOX: ON' : 'BOX: OFF')) {
      if (cut.boxOn) { cut.boxOn = false; this.changed(); } else { this.fitToLevel(); }
    }
    if (w.smallButton(f, ix + half + this.s(8), cy, half, this.s(30), cut.planeOn ? 'PLANE: ON' : 'PLANE: OFF')) {
      if (cut.planeOn) { cut.planeOn = false; this.changed(); } else { this.notice = 'Aim at a surface and press Shift+P for a plane'; }
    }
    cy += this.s(40);

    ui.text(f.small, ix, cy, 'FIT THE BOX TO', UiTheme.TEXT_MUTED, this.s(0.6));
    cy += this.s(20);
    const third = (iw - this.s(16)) / 3;
    if (w.smallButton(f, ix, cy, third, this.s(30), 'LEVEL')) { this.fitToLevel(); }
    if (w.smallButton(f, ix + third + this.s(8), cy, third, this.s(30), 'ROOM')) { this.fitToRoom(); }
    if (w.smallButton(f, ix + (third + this.s(8)) * 2, cy, third, this.s(30), 'MODEL')) { this.fitToModel(); }
    cy += this.s(42);

    ui.text(f.small, ix, cy, 'CAPS', UiTheme.TEXT_MUTED, this.s(0.6));
    cy += this.s(20);
    ui.rect(ix, cy, this.s(44), this.s(30), Rgba.fromFloat(this.capColour.x, this.capColour.y, this.capColour.z, 1));
    ui.outline(ix, cy, this.s(44), this.s(30), Math.max(1, ui.scale), UiTheme.CONTROL_BORDER);
    const buttonW = (iw - this.s(60) - this.s(8)) * 0.5;
    if (w.smallButton(f, ix + this.s(52), cy, buttonW, this.s(30), 'CHANGE…')) { this.pickCapColour(); }
    if (w.smallButton(f, ix + this.s(52) + buttonW + this.s(8), cy, buttonW, this.s(30), 'RESET')) { this.setCapColour(DEFAULT_CAP_COLOUR, true); }
    cy += this.s(42);

    if (w.smallButton(f, ix, cy, iw, this.s(30), 'CLEAR ALL CUTS (Ctrl+P)', true)) { this.clear(); }
    cy += this.s(40);
    if (this.notice) { ui.textWrapped(f.small, ix, cy, iw, this.notice, UiTheme.MEASURE_TEXT, 2); }
    if (w.smallButton(f, ix, y + ph - this.s(44), iw, this.s(30), 'CLOSE (P / ESC) · cut stays')) { this.close(); }
  }

  // #endregion

  dispose(): void {
    this.overlay?.dispose();
    this.overlay = null;
    this.colourInput?.remove();
    this.colourInput = null;
  }
}

/** The parameter along an axis (point + s · axis) where a ray passes closest; null when they are near parallel. */
function closestOnAxis(point: Vec3, axis: Vec3, rayOrigin: Vec3, rayDirection: Vec3): number | null {
  const w = V.sub(point, rayOrigin);
  const b = V.dot(axis, rayDirection), d = V.dot(axis, w), e = V.dot(rayDirection, w);
  const denominator = 1 - b * b;
  if (denominator < 1e-4) { return null; }
  const parameter = (b * e - d) / denominator;
  return Number.isFinite(parameter) ? parameter : null;
}
