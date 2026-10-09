import { EditOp, type EditResult } from '../../core/edits/EditMessages';
import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import { isLibraryEmpty, type LibraryEntry, libraryLabel, placeableCount } from '../../core/scene/FamilyLibrary';
import { type Aabb, type ElementRecord, PhaseRole } from '../../core/scene/SceneData';
import type { RayHit } from '../../engine/physics/Bvh';
import type { DynamicInstance, DynamicSet } from '../../engine/physics/DynamicSet';
import type { Overlay3D } from '../../engine/render/Overlay3D';
import { Rgba } from '../../engine/ui/Rgba';
import type { TextBuffer } from '../../engine/ui/TextBuffer';
import type { UiBatch } from '../../engine/ui/UiBatch';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { type InputState, Vk } from '../../platform/input';
import { type AimInfo, Gun, type GunHost, type Highlight } from './Gun';
import { GunIcons } from './GunIcons';

/** What the editing tools need on top of GunHost (the desktop passes GameSession). */
export interface EditHost extends GunHost {
  readonly dynamics: DynamicSet;
  readonly input: InputState;
  readonly editsGoToRevit: boolean;
  readonly editsLocalOnly: boolean;
  readonly editTargetName: string;
  readonly gizmoSnap: boolean;
  readonly snapMoveMm: number;
  readonly snapAngleDeg: number;
  setStaticHidden(element: number, hidden: boolean): void;
  makeDynamic(element: number): DynamicInstance;
  restoreIfUnmoved(instance: DynamicInstance | null): void;
  createClone(element: number, source: DynamicInstance | null, cloneKey?: number): DynamicInstance;
  applyRemovals(ids: number[]): number;
  toRevit(local: Vec3): Vec3;
  submitEdit(request: import('../../core/edits/EditMessages').EditRequest, onResult: (r: EditResult) => void): boolean;
  toggleGizmoSnap(): void;
  stepSnapMove(direction: number): void;
  stepSnapAngle(direction: number): void;
  /** Picks like pick() but ignores one moved / cloned element (drop to surface). */
  pickExcluding(origin: Vec3, direction: Vec3, maxDistance: number, exclude: DynamicInstance | null): RayHit | null;
  /** Opens the family library panel (Place gun). */
  openLibrary(): void;
  /** A new (uncommitted) instance of a library type: a clone of its hidden template; null when it has none. */
  createPlacement(entry: LibraryEntry, cloneKey?: number): DynamicInstance | null;
  /** Puts a placement where a scene-local pivot and angle say. */
  setPlacement(instance: DynamicInstance, pivot: Vec3, angle: number): void;
}

// #region Demolish

interface Target { element: number; dynamicId: number }
const same = (a: Target, b: Target) => a.element === b.element && a.dynamicId === b.dynamicId;

/** Prime, then demolish (phase) or delete elements (port of HammerGun.cs). */
export class HammerGun extends Gun {
  private readonly primed: Target[] = [];
  private hover: Target = { element: -1, dynamicId: 0 };
  private deleteMode = false;
  private clock = 0;

  constructor(private readonly host: EditHost) { super(host); }

  get name(): string { return 'DEMOLISH'; }
  get hintPrimary(): string { return this.isPrimed(this.hover) ? (this.deleteMode ? 'Delete' : 'Demolish') : 'Prime'; }
  get hintSecondary(): string { return 'Unprime'; }
  get colour(): number { return UiTheme.HAMMER; }
  get panelHeight(): number { return 118; }

  drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void { GunIcons.hammer(ui, cx, cy, size, colour); }
  override tick(dt: number): void { this.clock += dt; }
  override onDeselect(): void { this.hover = { element: -1, dynamicId: 0 }; }

  clearMarkers(): void {
    if (this.primed.length > 0) { this.host.toast('Primed elements cleared'); }
    this.primed.length = 0;
  }

  private get phaseLabel(): string { return this.host.scene.phaseName ?? 'no phase'; }
  private isPrimed(t: Target): boolean { return t.element >= 0 && this.primed.some(p => same(p, t)); }

  override update(_dt: number, aim: AimInfo): void {
    this.hover = aim.hit ? { element: aim.hit.element, dynamicId: aim.hit.dynamicId } : { element: -1, dynamicId: 0 };
    // Forget primes whose element has gone
    for (let i = this.primed.length - 1; i >= 0; i--) {
      if (!this.host.isTargetPresent(this.primed[i].element, this.primed[i].dynamicId)) { this.primed.splice(i, 1); }
    }
  }

  override onKeys(input: InputState): void {
    if (!input.isPressed(Vk.key('T'))) { return; }
    this.deleteMode = !this.deleteMode;
    this.host.sound.play(SoundId.UiClick);
    const where = this.host.editsGoToRevit ? '' : ' (recorded in the file)';
    this.host.toast(this.deleteMode
      ? (this.host.editsGoToRevit ? 'Demolish gun: DELETE mode (removes elements from the Revit model)' : `Demolish gun: DELETE mode${where}`)
      : `Demolish gun: demolish in phase ${this.phaseLabel}${where}`);
  }

  override onPrimary(aim: AimInfo): void {
    if (!aim.hit) {
      this.host.sound.play(SoundId.Error);
      return;
    }
    const target = { element: aim.hit.element, dynamicId: aim.hit.dynamicId };
    const hit = this.host.scene.elements[target.element];

    // Linked models are read-only (demolish or delete them in their own model)
    if (hit.link > 0) {
      this.unprime(target);
      this.host.sound.play(SoundId.Error);
      this.host.toast(`${hit.moveBlockReason ?? 'In a linked model'}: edit it in its own model.`, 3.5, true);
      return;
    }

    // Demolition is for existing elements only: say so up front
    const blocked = this.deleteMode ? null : this.blockReason(target);
    if (blocked) {
      this.unprime(target);
      this.host.sound.play(SoundId.Error);
      this.host.toast(`${blocked}, so it can't be demolished. Press T to delete it instead.`, 3.5, true);
      return;
    }

    if (this.isPrimed(target)) {
      this.unprime(target);
      this.demolish(target);
      return;
    }
    this.primed.push(target);
    this.host.sound.play(SoundId.Prime);
  }

  override onSecondary(): void {
    if (this.primed.length === 0) { return; }
    // The primed element under the crosshair, else the most recent
    const index = this.primed.findIndex(p => same(p, this.hover));
    this.primed.splice(index >= 0 ? index : this.primed.length - 1, 1);
    this.host.sound.play(SoundId.UiClick);
  }

  private unprime(t: Target): void {
    const i = this.primed.findIndex(p => same(p, t));
    if (i >= 0) { this.primed.splice(i, 1); }
  }

  private blockReason(t: Target): string | null {
    if (t.element < 0) { return null; }
    const scene = this.host.scene;
    if (scene.phaseName === null) { return 'The model has no phases'; }
    const instance = t.dynamicId > 0 ? this.host.dynamics.find(t.dynamicId) : null;
    if (instance?.isClone) { return 'Clones are new work'; }
    switch (scene.elements[t.element].phase) {
      case PhaseRole.New: return `New work in ${this.phaseLabel}`;
      case PhaseRole.Between: return scene.existingPhaseName === null ? 'Not in the existing phase' : `Built after ${scene.existingPhaseName}`;
      case PhaseRole.Unphased: return 'It has no phase';
      default: return null;
    }
  }

  private demolish(target: Target): void {
    const host = this.host;
    const record = host.scene.elements[target.element];
    const instance = host.dynamics.find(target.dynamicId);
    if (target.dynamicId > 0 && !instance) { return; }

    // Hide now (optimistic)
    if (instance) { instance.hidden = true; } else { host.setStaticHidden(target.element, true); }
    host.sound.play(SoundId.Demolish);
    host.flash(UiTheme.HAMMER, 0.1);

    const deleting = this.deleteMode;
    const sent = host.submitEdit({
      op: deleting ? EditOp.Delete : EditOp.PhaseDemolish,
      elementId: instance?.revitId ?? record.elementId,
      targetCloneKey: instance && instance.revitId <= 0 ? instance.cloneKey : 0,
      label: (deleting ? 'Delete ' : 'Demolish ') + record.name
    }, result => this.onResult(result, target, instance, record));
    if (!sent) { host.toast(`${record.name} removed in the walkthrough only (not connected to Revit)`); }
  }

  private onResult(result: EditResult, target: Target, instance: DynamicInstance | null, record: ElementRecord): void {
    const host = this.host;
    if (result.success) {
      const extra = Math.max(0, host.applyRemovals(result.affectedIds));
      const verb = result.op === EditOp.Delete ? 'Deleted' : `Demolished (${this.phaseLabel})`;
      const where = host.editsGoToRevit ? ' in Revit' : '';
      host.toast(extra > 0 ? `${verb}${where}: ${record.name} + ${extra} dependent element${extra === 1 ? '' : 's'}` : `${verb}${where}: ${record.name}`);
      return;
    }
    // Refused: restore
    if (instance) { instance.hidden = false; } else { host.setStaticHidden(target.element, false); }
    host.sound.play(SoundId.Error);
    host.toast(`${host.editTargetName} refused (${result.message}). ${record.name} restored.`, 4, true);
  }

  override collectHighlights(highlights: Highlight[]): void {
    const pulse = 0.38 + 0.18 * Math.sin(this.clock * 7);
    for (const t of this.primed) { highlights.push({ element: t.element, dynamicId: t.dynamicId, colour: UiTheme.HAMMER_PRIMED, strength: pulse }); }
    if (this.hover.element >= 0 && !this.isPrimed(this.hover) && this.host.scene.elements[this.hover.element].link === 0) {
      highlights.push({ element: this.hover.element, dynamicId: this.hover.dynamicId, colour: UiTheme.HAMMER, strength: 0.22 });
    }
  }

  override drawWorld(overlay: Overlay3D, selected: boolean): void {
    // Primed elements keep a red box even when another gun is selected
    const colour = Rgba.withAlpha(UiTheme.HAMMER_PRIMED, selected ? 0.95 : 0.45);
    for (const t of this.primed) {
      const box = this.host.dynamics.find(t.dynamicId)?.worldBounds ?? this.host.scene.elements[t.element].bounds;
      drawBox(overlay, box, colour);
    }
  }

  drawPanel(ui: UiBatch, x: number, y: number, width: number): void {
    const f = ui.atlas, host = this.host;
    ui.text(f.small, x, y, 'DEMOLISH', UiTheme.HAMMER_LABEL, this.s(1.1));
    ui.textRight(f.small, x + width, y, 'T  MODE', UiTheme.TEXT_MUTED, this.s(1));
    y += this.s(20);
    if (this.deleteMode) {
      ui.text(f.bold, x, y, host.editsGoToRevit ? 'Delete from the Revit model' : 'Delete (recorded in the file)', UiTheme.DANGER);
    } else {
      const from = host.scene.existingPhaseName !== null ? `${host.scene.existingPhaseName} → ` : '';
      ui.textWrapped(f.bold, x, y, width, `Demolish · ${from}${this.phaseLabel}`, UiTheme.TEXT, 1);
    }
    y += this.s(22);
    if (host.editsLocalOnly) {
      ui.text(f.body, x, y, 'Not connected to Revit: walkthrough only', UiTheme.DANGER);
      y += this.s(19);
    }
    ui.text(f.body, x, y, `Primed: ${this.primed.length}`, this.primed.length > 0 ? UiTheme.HAMMER_PRIMED : UiTheme.TEXT_MUTED);
    y += this.s(19);
    if (this.hover.element >= 0) {
      const record = host.scene.elements[this.hover.element];
      const blocked = this.deleteMode ? null : this.blockReason(this.hover);
      if (record.link > 0) { ui.textWrapped(f.body, x, y, width, record.moveBlockReason ?? 'In a linked model (read-only)', UiTheme.DANGER, 1); }
      else if (blocked) { ui.textWrapped(f.body, x, y, width, `${blocked}: press T to delete instead`, UiTheme.DANGER, 1); }
      else { ui.textWrapped(f.body, x, y, width, record.name, UiTheme.TEXT_SOFT, 1); }
    } else {
      ui.text(f.body, x, y, 'Aim at an element. LMB primes it, LMB again removes it.', UiTheme.TEXT_MUTED);
    }
  }
}

function drawBox(overlay: Overlay3D, box: Aabb, colour: number): void {
  const n = V.sub(box.min, vec3(0.02, 0.02, 0.02)), x = V.add(box.max, vec3(0.02, 0.02, 0.02));
  const c = (i: number) => vec3(i & 1 ? x.x : n.x, i & 2 ? x.y : n.y, i & 4 ? x.z : n.z);
  const edges = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [3, 7], [2, 6]];
  for (const [a, b] of edges) { overlay.line(c(a), c(b), 2, colour); }
}

// #endregion

// #region Gizmo controller

export enum GizmoMode { Move, Rotate }

/** Keyboard move / rotate of one dynamic instance, smooth or snapped (port of GizmoController.cs). */
export class GizmoController {
  private static readonly MOVE_SPEED = 1;              // m/s
  private static readonly ROTATE_SPEED = Math.PI / 2;  // rad/s
  private static readonly FINE = 0.25;
  /** Drop to surface: furthest drop (m) below the element's base. */
  static readonly MAX_DROP = 10;
  /** Drop to surface: the ray starts this far above the box's base (at most half its height), so a sunk element is lifted. */
  private static readonly LIFT_REACH = 0.3;

  target: DynamicInstance | null = null;
  // After a drop the height is exact, not a whole snap increment: snapping leaves Z alone until E / Q steps it
  private zFree = false;
  mode = GizmoMode.Move;
  private startOffset: Vec3 = vec3();
  private rawOffset: Vec3 = vec3();
  private startAngle = 0;
  private rawAngle = 0;
  private clock = 0;

  constructor(private readonly host: EditHost) {}

  get active(): boolean { return this.target !== null; }
  get deltaOffset(): Vec3 { return this.target ? V.sub(this.target.offset, this.startOffset) : vec3(); }
  get deltaAngle(): number { return this.target ? this.target.angle - this.startAngle : 0; }
  get startPivot(): Vec3 { return this.target ? V.add(this.target.basePivot, this.startOffset) : vec3(); }
  get hasChanges(): boolean { return V.lengthSquared(this.deltaOffset) > 1e-10 || Math.abs(this.deltaAngle) > 1e-6; }

  toggleMode(): void { this.mode = this.mode === GizmoMode.Move ? GizmoMode.Rotate : GizmoMode.Move; }

  begin(target: DynamicInstance): void {
    this.target = target;
    this.mode = GizmoMode.Move;
    this.startOffset = V.copy(target.offset);
    this.rawOffset = V.copy(target.offset);
    this.startAngle = this.rawAngle = target.angle;
    this.zFree = false;
  }

  cancel(): DynamicInstance | null {
    const target = this.target;
    if (target) { this.host.dynamics.setTransform(target, this.startOffset, this.startAngle); }
    this.target = null;
    return target;
  }

  end(): DynamicInstance | null {
    const target = this.target;
    this.target = null;
    return target;
  }

  isSnapping(input: InputState): boolean { return this.host.gizmoSnap !== input.isDown(Vk.CONTROL); }

  update(dt: number, input: InputState): void {
    this.clock += dt;
    const target = this.target;
    if (!target) { return; }
    const rotating = this.mode === GizmoMode.Rotate;
    const down = (k: string, alt?: number) => input.isDown(Vk.key(k)) || (alt !== undefined && input.isDown(alt));
    const tap = (k: string, alt?: number) => input.isPressedOrRepeated(Vk.key(k)) || (alt !== undefined && input.isPressedOrRepeated(alt));

    // Camera-relative in plan, plus straight up / down
    const flatForward = flatten(this.host.camera.forward), flatRight = flatten(this.host.camera.right);
    if (this.isSnapping(input)) {
      // Stepped: one increment per press / key repeat, along the world axis nearest the view direction
      const step = this.host.snapMoveMm / 1000, angleStep = this.host.snapAngleDeg * Math.PI / 180;
      if (!rotating) {
        let stepMove = vec3();
        if (tap('W', Vk.UP)) { stepMove = V.add(stepMove, flatForward); }
        if (tap('S', Vk.DOWN)) { stepMove = V.sub(stepMove, flatForward); }
        if (tap('D', Vk.RIGHT)) { stepMove = V.add(stepMove, flatRight); }
        if (tap('A', Vk.LEFT)) { stepMove = V.sub(stepMove, flatRight); }
        this.rawOffset = V.add(this.rawOffset, V.scale(nearestAxis(stepMove), step));
        if (tap('E')) { this.rawOffset.z += step; this.zFree = false; }
        if (tap('Q')) { this.rawOffset.z -= step; this.zFree = false; }
      } else {
        if (tap('A', Vk.LEFT)) { this.rawAngle += angleStep; }
        if (tap('D', Vk.RIGHT)) { this.rawAngle -= angleStep; }
      }
      // Clamp the change since lock-on to whole increments (also tidies a smooth move made before snapping)
      const d = V.sub(this.rawOffset, this.startOffset);
      this.rawOffset = V.add(this.startOffset, vec3(snap(d.x, step), snap(d.y, step), this.zFree ? d.z : snap(d.z, step)));
      this.rawAngle = this.startAngle + snap(this.rawAngle - this.startAngle, angleStep);
    } else {
      const scale = input.isDown(Vk.SHIFT) ? GizmoController.FINE : 1;
      if (!rotating) {
        const forward = (down('W', Vk.UP) ? 1 : 0) - (down('S', Vk.DOWN) ? 1 : 0);
        const strafe = (down('D', Vk.RIGHT) ? 1 : 0) - (down('A', Vk.LEFT) ? 1 : 0);
        const lift = (down('E') ? 1 : 0) - (down('Q') ? 1 : 0);
        let move = V.add(V.scale(flatForward, forward), V.scale(flatRight, strafe));
        if (V.lengthSquared(move) > 1) { move = V.normalize(move); }
        move.z = lift;
        this.rawOffset = V.add(this.rawOffset, V.scale(move, GizmoController.MOVE_SPEED * scale * dt));
      } else {
        const turn = (down('A', Vk.LEFT) ? 1 : 0) - (down('D', Vk.RIGHT) ? 1 : 0);
        this.rawAngle += turn * GizmoController.ROTATE_SPEED * scale * dt;
      }
    }

    const o = target.offset;
    if (this.rawOffset.x !== o.x || this.rawOffset.y !== o.y || this.rawOffset.z !== o.z || this.rawAngle !== target.angle) {
      this.host.dynamics.setTransform(target, this.rawOffset, this.rawAngle);
    }
  }

  /**
   * Drops or lifts the target so the bottom of its box rests on the first surface straight below the box's bottom
   * centre: one ray down from a little above the base, against the visible static scene and the other moved / cloned
   * elements, never the target itself. The first hit wins (a lamp over a desk lands on the desk). Stays locked on.
   * @returns What happened (moved, and a message for a toast).
   */
  dropToSurface(): { moved: boolean; message: string | null } {
    const target = this.target;
    if (!target) { return { moved: false, message: null }; }
    const bounds = target.worldBounds;
    const reach = Math.min(GizmoController.LIFT_REACH, Math.max(0, bounds.size.z) * 0.5);
    const centre = bounds.center;
    const hit = this.host.pickExcluding(vec3(centre.x, centre.y, bounds.min.z + reach), vec3(0, 0, -1), reach + GizmoController.MAX_DROP, target);
    if (!hit) { return { moved: false, message: 'Nothing below to drop onto' }; }
    const change = hit.point.z - bounds.min.z;
    if (Math.abs(change) < 5e-4) { return { moved: false, message: 'Already resting on the surface below' }; }
    this.rawOffset = V.add(target.offset, vec3(0, 0, change));
    this.zFree = true;
    this.host.dynamics.setTransform(target, this.rawOffset, target.angle);
    return { moved: true, message: change < 0 ? `Dropped ${(-change).toFixed(3)} m onto the surface below` : `Lifted ${change.toFixed(3)} m onto the surface` };
  }

  draw(overlay: Overlay3D, colour: number): void {
    const target = this.target;
    if (!target) { return; }
    const bounds = target.worldBounds, pivot = target.pivot;
    const baseZ = bounds.min.z + 0.02;
    const centre = vec3(pivot.x, pivot.y, baseZ);
    const size = bounds.size;
    const radius = Math.max(0.35, 0.5 * Math.max(size.x, size.y) + 0.2);
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 5);
    const X = vec3(1, 0, 0), Y = vec3(0, 1, 0);

    // Rotate ring with a tick showing the current heading (bold in rotate mode, faint in move mode)
    const rotating = this.mode === GizmoMode.Rotate;
    overlay.ring(centre, X, Y, radius, radius, rotating ? 0.05 : 0.02, Rgba.withAlpha(colour, rotating ? 0.95 : 0.35));
    const tick = vec3(Math.cos(target.angle), Math.sin(target.angle), 0);
    overlay.line(V.add(centre, V.scale(tick, radius - 0.12)), V.add(centre, V.scale(tick, radius + 0.12)), rotating ? 5 : 2, Rgba.withAlpha(colour, rotating ? 1 : 0.5));

    if (!rotating) {
      const forward = flatten(this.host.camera.forward), right = flatten(this.host.camera.right);
      const arrow = radius + 0.35;
      arrowTo(overlay, centre, forward, arrow, UiTheme.AXIS_Y);
      arrowTo(overlay, centre, V.scale(forward, -1), arrow * 0.7, Rgba.withAlpha(UiTheme.AXIS_Y, 0.5));
      arrowTo(overlay, centre, right, arrow, UiTheme.AXIS_X);
      arrowTo(overlay, centre, V.scale(right, -1), arrow * 0.7, Rgba.withAlpha(UiTheme.AXIS_X, 0.5));
      this.verticalArrow(overlay, vec3(pivot.x, pivot.y, bounds.max.z + 0.1), 1, UiTheme.AXIS_Z);
      this.verticalArrow(overlay, centre, -1, Rgba.withAlpha(UiTheme.AXIS_Z, 0.6));
    }

    // Pivot post and the trail back to where it started
    overlay.line(centre, vec3(pivot.x, pivot.y, bounds.max.z + 0.1), 1.5, Rgba.withAlpha(colour, 0.5 + 0.3 * pulse));
    const start = this.startPivot;
    const startGround = vec3(start.x, start.y, baseZ);
    if (V.distance(startGround, centre) > 1e-2) {
      overlay.line(startGround, centre, 2, Rgba.withAlpha(colour, 0.6));
      overlay.ring(startGround, X, Y, 0.08, 0.08, 0.02, Rgba.withAlpha(colour, 0.6));
    }
  }

  private verticalArrow(overlay: Overlay3D, from: Vec3, sign: number, colour: number): void {
    const tip = V.add(from, vec3(0, 0, 0.45 * sign));
    const back = V.sub(tip, vec3(0, 0, 0.14 * sign));
    const side = V.scale(flatten(this.host.camera.right), 0.08);
    overlay.line(V.add(from, vec3(0, 0, 0.05 * sign)), back, 3, colour);
    overlay.triangle(tip, V.add(back, side), V.sub(back, side), colour);
  }

  describeDelta(text: TextBuffer): string {
    const degrees = this.deltaAngle * 180 / Math.PI;
    const d = this.deltaOffset;
    text.clear().append('Δ ').appendNumber(Math.hypot(d.x, d.y), 3).append(' m');
    if (Math.abs(d.z) > 5e-4) { text.append(' · Z ').appendNumber(d.z, 3, true).append(' m'); }
    return text.append(' · ').appendNumber(degrees, 1).append('°').text;
  }
}

function arrowTo(overlay: Overlay3D, centre: Vec3, direction: Vec3, length: number, colour: number): void {
  const tip = V.add(centre, V.scale(direction, length));
  const side = V.scale(vec3(-direction.y, direction.x, 0), 0.09);
  const back = V.sub(tip, V.scale(direction, 0.18));
  overlay.line(V.add(centre, V.scale(direction, 0.1)), back, 3, colour);
  overlay.triangle(tip, V.add(back, side), V.sub(back, side), colour);
}

function snap(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

function nearestAxis(d: Vec3): Vec3 {
  if (V.lengthSquared(d) < 1e-6) { return vec3(); }
  return Math.abs(d.x) >= Math.abs(d.y) ? vec3(Math.sign(d.x), 0, 0) : vec3(0, Math.sign(d.y), 0);
}

function flatten(v: Vec3): Vec3 {
  const flat = vec3(v.x, v.y, 0);
  return V.lengthSquared(flat) > 1e-8 ? V.normalize(flat) : vec3(1, 0, 0);
}

// #endregion

// #region Gizmo and clone guns

/** Keys and the context panel shared by Gizmo and Clone (port of GizmoPanel). */
const GizmoPanel = {
  handleKeys(host: EditHost, gizmo: GizmoController, input: InputState): void {
    if (input.isPressed(Vk.key('G'))) { host.toggleGizmoSnap(); }
    if (!gizmo.active) { return; }
    if (input.isPressed(Vk.key('F'))) { GizmoPanel.drop(host, gizmo); }
    if (input.isPressed(Vk.key('R'))) {
      gizmo.toggleMode();
      host.sound.play(SoundId.UiClick);
    }
    const rotating = gizmo.mode === GizmoMode.Rotate;
    if (input.isPressed(Vk.key('Z'))) { if (rotating) { host.stepSnapAngle(-1); } else { host.stepSnapMove(-1); } }
    if (input.isPressed(Vk.key('X'))) { if (rotating) { host.stepSnapAngle(1); } else { host.stepSnapMove(1); } }
  },

  /** F while locked on: drop or lift onto the surface below, with a sound and a note; true when it moved. */
  drop(host: EditHost, gizmo: GizmoController): boolean {
    const { moved, message } = gizmo.dropToSurface();
    host.sound.play(moved ? SoundId.UiClick : SoundId.Error);
    if (message) { host.toast(moved ? message + ' (RMB commits)' : message); }
    return moved;
  },

  snapText(host: EditHost): string {
    const move = host.snapMoveMm >= 1000 ? `${(host.snapMoveMm / 1000).toFixed(2)} m` : `${Math.round(host.snapMoveMm)} mm`;
    return `${move} · ${Math.round(host.snapAngleDeg)}°`;
  },

  draw(ui: UiBatch, host: EditHost, gizmo: GizmoController, title: string, titleColour: number, hover: number, x: number, y: number, width: number): void {
    const s = (v: number) => v * host.uiScale;
    const f = ui.atlas;
    const used = ui.text(f.small, x, y, title, titleColour, s(1.1));
    if (gizmo.active) { ui.text(f.small, x + used, y, gizmo.mode === GizmoMode.Rotate ? ' · ROTATE' : ' · MOVE', titleColour, s(1.1)); }
    y += s(20);

    if (gizmo.active && gizmo.target) {
      ui.textWrapped(f.bold, x, y, width, host.scene.elements[gizmo.target.element].name, UiTheme.TEXT, 1);
      y += s(22);
      ui.text(f.mono, x, y, gizmo.describeDelta(host.text), UiTheme.TEXT);
      y += s(20);
      const rotating = gizmo.mode === GizmoMode.Rotate;
      ui.text(f.body, x, y, rotating ? 'A/D rotate · R move' : 'WASD · E/Q up/down · R rotate', UiTheme.TEXT_SOFT);
      y += s(18);
      if (gizmo.isSnapping(host.input)) {
        ui.text(f.body, x, y, `SNAP ${GizmoPanel.snapText(host)}${host.gizmoSnap ? ' · G off' : ' · Ctrl'}`, UiTheme.ACCENT);
      } else {
        ui.text(f.body, x, y, 'Shift fine · G snap on/off · Ctrl flips snap', UiTheme.TEXT_MUTED);
      }
      y += s(18);
      ui.text(f.body, x, y, rotating ? 'Z/X angle step · F drop to surface' : 'Z/X move step · F drop to surface', UiTheme.TEXT_MUTED);
      y += s(18);
      ui.text(f.body, x, y, 'RMB commit · Esc cancel', UiTheme.TEXT_MUTED);
      return;
    }

    ui.textRight(f.small, x + width, y - s(20), host.gizmoSnap ? `Snap on · ${GizmoPanel.snapText(host)} (G)` : 'Snap off (G)',
      host.gizmoSnap ? UiTheme.ACCENT : UiTheme.TEXT_FAINT, s(0.5));
    if (hover < 0) {
      ui.text(f.body, x, y, 'Aim at furniture or fittings.', UiTheme.TEXT_MUTED);
      ui.text(f.body, x, y + s(19), 'Point-based loadable families only.', UiTheme.TEXT_MUTED);
      return;
    }
    const hovered = host.scene.elements[hover];
    ui.textWrapped(f.bold, x, y, width, hovered.name, UiTheme.TEXT, 1);
    y += s(22);
    ui.textWrapped(f.body, x, y, width, hovered.familyType, UiTheme.TEXT_SOFT, 1);
    y += s(20);
    if (hovered.movable) { ui.text(f.body, x, y, title === 'GIZMO' ? 'Movable: LMB locks on · F drops to surface' : 'Movable: LMB clones', UiTheme.GOOD); }
    else { ui.textWrapped(f.body, x, y, width, `Can't move: ${hovered.moveBlockReason}`, UiTheme.DANGER, 1); }
    y += s(20);
    if (host.editsLocalOnly) { ui.text(f.body, x, y, 'Not connected to Revit: walkthrough only', UiTheme.DANGER); }
  }
};

/** Move / rotate movable elements (port of GizmoGun.cs). */
export class GizmoGun extends Gun {
  private readonly gizmo: GizmoController;
  private hover = -1;
  private hoverDynamic = 0;

  constructor(private readonly host: EditHost) {
    super(host);
    this.gizmo = new GizmoController(host);
  }

  get name(): string { return 'GIZMO'; }
  get hintPrimary(): string { return this.gizmo.active ? 'Esc cancel' : 'Lock on (FFE)'; }
  get hintSecondary(): string { return this.gizmo.active ? (this.host.editsGoToRevit ? 'Commit to Revit' : 'Commit') : '—'; }
  get colour(): number { return UiTheme.GIZMO; }
  get panelHeight(): number { return 140; }
  override get capturesInput(): boolean { return this.gizmo.active; }

  drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void { GunIcons.gizmo(ui, cx, cy, size, colour); }
  clearMarkers(): void { /* none */ }
  override onKeys(input: InputState): void {
    // Aim + F (not locked on): drop or lift the aimed element onto the surface below and commit it at once
    if (!this.gizmo.active && input.isPressed(Vk.key('F'))) {
      this.dropAimed();
      return;
    }
    GizmoPanel.handleKeys(this.host, this.gizmo, input);
  }
  override onDeselect(): void { this.hover = -1; this.hoverDynamic = 0; }

  override update(dt: number, aim: AimInfo): void {
    if (this.gizmo.active) {
      this.gizmo.update(dt, this.host.input);
      return;
    }
    this.hover = aim.hit ? aim.hit.element : -1;
    this.hoverDynamic = aim.hit ? aim.hit.dynamicId : 0;
  }

  override onPrimary(aim: AimInfo): void {
    if (this.gizmo.active) { return; }
    if (!aim.hit) {
      this.host.sound.play(SoundId.Error);
      return;
    }
    if (this.lockOn(aim.hit.element, aim.hit.dynamicId)) { this.host.sound.play(SoundId.Grab); }
  }

  /** Locks the gizmo on to an element (its moved / cloned instance when dynamicId > 0); refuses elements that can't move. */
  private lockOn(element: number, dynamicId: number): boolean {
    const host = this.host;
    const record = host.scene.elements[element];
    if (!record.movable) {
      host.sound.play(SoundId.Error);
      host.toast(`Can't move ${record.name}: ${record.moveBlockReason}`, 2.6, true);
      return false;
    }
    const instance = dynamicId > 0 ? host.dynamics.find(dynamicId) : host.makeDynamic(element);
    if (!instance) { return false; }
    this.gizmo.begin(instance);
    return true;
  }

  /**
   * F while aiming (not locked on): locks on to the aimed element, drops or lifts it onto the first surface below and
   * commits that as one move (Ctrl+Z undoes it in a file). Nothing below or already resting: nothing changes.
   */
  private dropAimed(): void {
    const host = this.host;
    if (this.hover < 0) {
      host.sound.play(SoundId.Error);
      host.toast('Aim at furniture or a fitting, then F drops it onto the surface below');
      return;
    }
    if (!this.lockOn(this.hover, this.hoverDynamic)) { return; }
    if (GizmoPanel.drop(host, this.gizmo)) {
      this.commit();
      return;
    }
    host.restoreIfUnmoved(this.gizmo.cancel());
  }

  override onSecondary(): void {
    if (this.gizmo.active) { this.commit(); }
  }

  override onCancel(): void {
    this.host.restoreIfUnmoved(this.gizmo.cancel());
    this.host.sound.play(SoundId.UiClick);
    this.host.toast('Move cancelled');
  }

  private commit(): void {
    const host = this.host, gizmo = this.gizmo;
    const instance = gizmo.target!;
    if (!gizmo.hasChanges) {
      gizmo.end();
      host.restoreIfUnmoved(instance);
      host.toast('Nothing moved');
      return;
    }
    const delta = gizmo.deltaOffset, angle = gizmo.deltaAngle, startPivot = gizmo.startPivot;
    const record = host.scene.elements[instance.element];
    gizmo.end();

    host.sound.play(SoundId.Commit);
    const sent = host.submitEdit({
      op: EditOp.Transform,
      elementId: instance.revitId,
      targetCloneKey: instance.revitId <= 0 ? instance.cloneKey : 0,
      pivot: host.toRevit(startPivot),
      translation: delta,
      angle,
      label: 'Move ' + record.name
    }, result => {
      if (result.success) {
        host.toast(host.editsGoToRevit ? `Moved in Revit: ${record.name}` : `Moved: ${record.name}`);
        return;
      }
      // Refused: undo this move in the game (later moves, if any, stay relative)
      host.dynamics.setTransform(instance, V.sub(instance.offset, delta), instance.angle - angle);
      host.restoreIfUnmoved(instance);
      host.sound.play(SoundId.Error);
      host.toast(`${host.editTargetName} refused the move (${result.message}). Restored.`, 4, true);
    });
    if (!sent) { host.toast(`${record.name} moved in the walkthrough only (not connected to Revit)`); }
  }

  override collectHighlights(highlights: Highlight[]): void {
    const target = this.gizmo.target;
    if (target) {
      highlights.push({ element: target.element, dynamicId: target.id, colour: UiTheme.GIZMO, strength: 0.3 });
      return;
    }
    if (this.hover < 0) { return; }
    const movable = this.host.scene.elements[this.hover].movable;
    highlights.push({ element: this.hover, dynamicId: this.hoverDynamic, colour: movable ? UiTheme.GIZMO : UiTheme.TEXT_FAINT, strength: movable ? 0.25 : 0.12 });
  }

  override drawWorld(overlay: Overlay3D, selected: boolean): void {
    if (selected) { this.gizmo.draw(overlay, UiTheme.GIZMO); }
  }

  drawPanel(ui: UiBatch, x: number, y: number, width: number): void {
    GizmoPanel.draw(ui, this.host, this.gizmo, 'GIZMO', UiTheme.GIZMO_LABEL, this.hover, x, y, width);
  }
}

/** Copy movable elements, then place the copy (port of CloneGun.cs). */
export class CloneGun extends Gun {
  private readonly gizmo: GizmoController;
  private hover = -1;
  private hoverDynamic = 0;
  private sourceRevitId = 0;
  private sourceCloneKey = 0;

  constructor(private readonly host: EditHost) {
    super(host);
    this.gizmo = new GizmoController(host);
  }

  get name(): string { return 'CLONE'; }
  get hintPrimary(): string { return this.gizmo.active ? 'Esc discard' : 'Clone (FFE)'; }
  get hintSecondary(): string { return this.gizmo.active ? (this.host.editsGoToRevit ? 'Commit to Revit' : 'Commit') : '—'; }
  get colour(): number { return UiTheme.CLONE; }
  get panelHeight(): number { return 140; }
  override get capturesInput(): boolean { return this.gizmo.active; }

  drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void { GunIcons.clone(ui, cx, cy, size, colour); }
  clearMarkers(): void { /* none */ }
  override onKeys(input: InputState): void { GizmoPanel.handleKeys(this.host, this.gizmo, input); }
  override onDeselect(): void { this.hover = -1; this.hoverDynamic = 0; }

  override update(dt: number, aim: AimInfo): void {
    if (this.gizmo.active) {
      this.gizmo.update(dt, this.host.input);
      return;
    }
    this.hover = aim.hit ? aim.hit.element : -1;
    this.hoverDynamic = aim.hit ? aim.hit.dynamicId : 0;
  }

  override onPrimary(aim: AimInfo): void {
    if (this.gizmo.active) { return; }
    const host = this.host;
    if (!aim.hit) {
      host.sound.play(SoundId.Error);
      return;
    }
    const record = host.scene.elements[aim.hit.element];
    if (!record.movable) {
      host.sound.play(SoundId.Error);
      host.toast(`Can't clone ${record.name}: ${record.moveBlockReason}`, 2.6, true);
      return;
    }
    // Clone from whatever was hit: the static element, a moved original or another clone
    const source = aim.hit.dynamicId > 0 ? host.dynamics.find(aim.hit.dynamicId) : null;
    if (aim.hit.dynamicId > 0 && !source) { return; }
    this.sourceRevitId = source?.revitId ?? record.elementId;
    this.sourceCloneKey = source && source.revitId <= 0 ? source.cloneKey : 0;

    this.gizmo.begin(host.createClone(aim.hit.element, source));
    host.sound.play(SoundId.Grab);
    host.toast('Clone made: move it, then RMB commits it (Esc discards it)');
  }

  override onSecondary(): void {
    if (this.gizmo.active) { this.commit(); }
  }

  override onCancel(): void {
    const clone = this.gizmo.end();
    if (clone) { this.host.dynamics.remove(clone); }
    this.host.sound.play(SoundId.Remove);
    this.host.toast('Clone discarded');
  }

  private commit(): void {
    const host = this.host, gizmo = this.gizmo;
    const delta = gizmo.deltaOffset, angle = gizmo.deltaAngle, startPivot = gizmo.startPivot;
    const clone = gizmo.end()!;
    clone.committed = true;
    const record = host.scene.elements[clone.element];

    host.sound.play(SoundId.Commit);
    const sent = host.submitEdit({
      op: EditOp.Copy,
      elementId: this.sourceRevitId,
      targetCloneKey: this.sourceCloneKey,
      newCloneKey: clone.cloneKey,
      pivot: host.toRevit(startPivot),
      translation: delta,
      angle,
      label: 'Clone ' + record.name
    }, result => {
      if (result.success) {
        if (result.newElementId && result.newElementId > 0) {
          clone.revitId = result.newElementId;
          host.toast(`Created in Revit: ${record.name} (id ${result.newElementId})`);
        } else {
          host.toast(`Cloned: ${record.name}`);
        }
        return;
      }
      host.dynamics.remove(clone);
      host.sound.play(SoundId.Error);
      host.toast(`${host.editTargetName} refused the copy (${result.message}). Clone removed.`, 4, true);
    });
    if (!sent) { host.toast(`Clone of ${record.name} kept in the walkthrough only (not connected to Revit)`); }
  }

  override collectHighlights(highlights: Highlight[]): void {
    const target = this.gizmo.target;
    if (target) {
      highlights.push({ element: target.element, dynamicId: target.id, colour: UiTheme.CLONE, strength: 0.32 });
      return;
    }
    if (this.hover < 0) { return; }
    const movable = this.host.scene.elements[this.hover].movable;
    highlights.push({ element: this.hover, dynamicId: this.hoverDynamic, colour: movable ? UiTheme.CLONE : UiTheme.TEXT_FAINT, strength: movable ? 0.25 : 0.12 });
  }

  override drawWorld(overlay: Overlay3D, selected: boolean): void {
    if (selected) { this.gizmo.draw(overlay, UiTheme.CLONE); }
  }

  drawPanel(ui: UiBatch, x: number, y: number, width: number): void {
    GizmoPanel.draw(ui, this.host, this.gizmo, 'CLONE', UiTheme.CLONE_LABEL, this.hover, x, y, width);
  }
}

/**
 * Gun 9: places new instances of loadable family types from the family library (port of PlaceGun.cs). Not holding
 * anything: LMB opens the library, RMB places the last picked type again. A picked type appears in front of the
 * player, resting on the surface below, in the gizmo's move mode (Clone's controls, F included). RMB commits (Revit
 * places the type, or the file records a `place`); Esc discards. A placement is a clone of the type's hidden template,
 * so once committed every other gun treats it like a clone.
 */
export class PlaceGun extends Gun {
  /** How far in front of the player a new placement appears (m, plus half its plan size). */
  private static readonly PLACE_DISTANCE = 1.6;
  private readonly gizmo: GizmoController;
  private entry: LibraryEntry | null = null;
  private last: LibraryEntry | null = null;

  constructor(private readonly host: EditHost) {
    super(host);
    this.gizmo = new GizmoController(host);
  }

  get name(): string { return 'PLACE'; }
  get hintPrimary(): string { return this.gizmo.active ? 'Esc discard' : 'Family library'; }
  get hintSecondary(): string {
    return this.gizmo.active ? (this.host.editsGoToRevit ? 'Commit to Revit' : 'Commit') : this.last ? 'Place again' : '—';
  }
  get colour(): number { return UiTheme.PLACE; }
  get panelHeight(): number { return 140; }
  override get capturesInput(): boolean { return this.gizmo.active; }

  drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void { GunIcons.place(ui, cx, cy, size, colour); }
  clearMarkers(): void { /* none */ }
  override onKeys(input: InputState): void { GizmoPanel.handleKeys(this.host, this.gizmo, input); }

  override update(dt: number): void {
    if (this.gizmo.active) { this.gizmo.update(dt, this.host.input); }
  }

  override onPrimary(): void {
    if (!this.gizmo.active) { this.host.openLibrary(); }
  }

  override onSecondary(): void {
    if (this.gizmo.active) {
      this.commit();
      return;
    }
    if (this.last) { this.begin(this.last); }
    else {
      this.host.sound.play(SoundId.Error);
      this.host.toast('Pick a family first: LMB opens the family library');
    }
  }

  override onCancel(): void {
    const placed = this.gizmo.end();
    if (placed) { this.host.dynamics.remove(placed); }
    this.entry = null;
    this.host.sound.play(SoundId.Remove);
    this.host.toast('Placement discarded');
  }

  /**
   * Makes a new instance of a library type in front of the player, drops it onto the surface below and locks the
   * gizmo on in move mode. Discards a placement still being held.
   */
  begin(entry: LibraryEntry): void {
    const host = this.host;
    if (!entry.placeable || entry.element < 0) {
      host.sound.play(SoundId.Error);
      host.toast(`${libraryLabel(entry)}: ${entry.reason ?? 'not placeable'}`, 2.6, true);
      return;
    }
    if (this.gizmo.active) { this.onCancel(); }

    const placed = host.createPlacement(entry);
    if (!placed) {
      host.sound.play(SoundId.Error);
      host.toast(`${libraryLabel(entry)} has no geometry in this snapshot`, 2.6, true);
      return;
    }

    // In front of the player at foot level, far enough that its footprint clears the player
    const template = host.scene.elements[entry.element].bounds;
    const size = template.size;
    const reach = PlaceGun.PLACE_DISTANCE + 0.5 * Math.max(size.x, size.y);
    const forward = host.camera.forward;
    let fx = forward.x, fy = forward.y;
    const l = Math.hypot(fx, fy);
    if (l > 1e-3) { fx /= l; fy /= l; } else { fx = 1; fy = 0; }
    const feet = host.player.feet;
    const pivotToBase = placed.basePivot.z - template.min.z; // the template's pivot relative to its box bottom
    host.setPlacement(placed, vec3(feet.x + fx * reach, feet.y + fy * reach, feet.z + Math.max(0, pivotToBase)), 0);

    this.entry = entry;
    this.last = entry;
    this.gizmo.begin(placed);
    this.gizmo.dropToSurface(); // quietly onto the floor (or desk) in front; F does it again after moving
    host.sound.play(SoundId.Grab);
    host.toast(`${libraryLabel(entry)}: move it, then RMB commits it (Esc discards it)`);
  }

  /** Keeps the placement and asks the model source to create it (Revit places the type; a file records a `place`). */
  private commit(): void {
    const host = this.host, entry = this.entry;
    const placed = this.gizmo.end();
    this.entry = null;
    if (!placed || !entry) { return; }
    placed.committed = true;
    const label = libraryLabel(entry);

    host.sound.play(SoundId.Commit);
    const sent = host.submitEdit({
      op: EditOp.Place,
      elementId: 0,
      newCloneKey: placed.cloneKey,
      typeUniqueId: entry.typeUniqueId,
      typeId: entry.typeId,
      pivot: host.toRevit(placed.pivot),
      translation: vec3(),
      angle: placed.angle,
      label: 'Place ' + label
    }, result => {
      if (result.success) {
        if (result.newElementId && result.newElementId > 0) {
          placed.revitId = result.newElementId;
          host.toast(`Placed in Revit: ${label} (id ${result.newElementId})`);
        } else {
          host.toast(`Placed: ${label}`);
        }
        return;
      }
      host.dynamics.remove(placed);
      host.sound.play(SoundId.Error);
      host.toast(`${host.editTargetName} refused the placement (${result.message}). Removed.`, 4, true);
    });
    if (!sent) { host.toast(`${label} kept in the walkthrough only (not connected to Revit)`); }
  }

  override collectHighlights(highlights: Highlight[]): void {
    const target = this.gizmo.target;
    if (target) { highlights.push({ element: target.element, dynamicId: target.id, colour: UiTheme.PLACE, strength: 0.3 }); }
  }

  override drawWorld(overlay: Overlay3D, selected: boolean): void {
    if (selected) { this.gizmo.draw(overlay, UiTheme.PLACE); }
  }

  drawPanel(ui: UiBatch, x: number, y: number, width: number): void {
    const host = this.host;
    if (this.gizmo.active) {
      GizmoPanel.draw(ui, host, this.gizmo, 'PLACE', UiTheme.PLACE_LABEL, -1, x, y, width);
      return;
    }
    const f = ui.atlas;
    ui.text(f.small, x, y, 'PLACE', UiTheme.PLACE_LABEL, this.s(1.1));
    y += this.s(20);
    const library = host.scene.library;
    if (isLibraryEmpty(library)) {
      ui.textWrapped(f.body, x, y, width, 'No family library in this model.', UiTheme.TEXT_MUTED, 1);
      y += this.s(19);
      ui.textWrapped(f.body, x, y, width, 'Revit: Options → Geometry → Family library, then Go.', UiTheme.TEXT_MUTED, 2);
      return;
    }
    ui.text(f.body, x, y, `${placeableCount(library).toLocaleString('en')} family types to place`, UiTheme.TEXT);
    y += this.s(22);
    ui.text(f.body, x, y, 'LMB opens the family library', UiTheme.TEXT_SOFT);
    y += this.s(20);
    if (this.last) {
      ui.textWrapped(f.body, x, y, width, libraryLabel(this.last), UiTheme.PLACE_LABEL, 1);
      y += this.s(19);
      ui.text(f.body, x, y, 'RMB places it again', UiTheme.TEXT_MUTED);
      y += this.s(19);
    }
    if (host.editsLocalOnly) { ui.text(f.body, x, y, 'Not connected to Revit: walkthrough only', UiTheme.DANGER); }
  }
}

// #endregion
