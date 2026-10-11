import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import { MeasureMath } from '../../core/scene/MeasureMath';
import type { RayHit } from '../../engine/physics/Bvh';
import type { Overlay3D } from '../../engine/render/Overlay3D';
import { Rgba } from '../../engine/ui/Rgba';
import { UiBatch } from '../../engine/ui/UiBatch';
import type { FontAtlas, UiFont } from '../../engine/ui/UiFont';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { type InputState, Vk } from '../../platform/input';
import { UnitFormat } from '../UnitFormat';
import { type AimInfo, Gun } from './Gun';
import { GunIcons } from './GunIcons';

/** The measuring modes, in cycling order. */
export enum MeasureMode { Distance = 0, Area = 1, Angle = 2, Clearance = 3 }

/** One committed measurement. */
interface Measurement {
  mode: MeasureMode;
  /** Distance: A, B. Area: the corners. Angle: arm, vertex, arm. Clearance: top, point, bottom. */
  points: Vec3[];
  /** Area: the plane normal. */
  normal: Vec3;
  /** Area: fill triangles (indices into points). */
  fill: number[];
  /** Distance: length. Area: area (m²). Angle: degrees. Clearance: distance down. */
  value: number;
  /** Area: perimeter. Clearance: distance up. */
  value2: number;
  /** Clearance: a surface was found below / above. */
  below: boolean;
  above: boolean;
  /** Label anchor (world). */
  anchor: Vec3;
}

/** A clearance found from an aimed point. */
interface Clearance {
  point: Vec3;
  top: Vec3;
  bottom: Vec3;
  above: boolean;
  below: boolean;
}

const MODE_NAMES = ['DISTANCE', 'AREA', 'ANGLE', 'CLEARANCE'];
const MODE_CHIPS = ['DIST', 'AREA', 'ANGLE', 'CLEAR'];

/** Most corners in one area outline. */
const MAX_AREA_POINTS = 64;

/** A click this close to the first corner (screen pixels, unscaled) closes the outline. */
const CLOSE_PIXELS = 14;

/** How far clearance rays look up and down (m). */
const CLEARANCE_REACH = 60;

/** Offset off the aimed surface before casting the clearance rays (m). */
const CLEARANCE_LIFT = 0.01;

const blank = (): Measurement => ({ mode: MeasureMode.Distance, points: [], normal: vec3(0, 0, 1), fill: [], value: 0, value2: 0, below: false, above: false, anchor: vec3() });

/**
 * Gun 2: measuring, in four modes (port of MeasureGun.cs, review tools round). Pressing 2 again (while it is the
 * selected gun) cycles Distance → Area → Angle → Clearance. RMB removes the last measurement (or cancels the one being
 * made); X clears them all. Measurements are temporary markers: they are never saved.
 * - Distance: LMB start, LMB end, a rubber band in between. N snaps the end along the start face's normal.
 * - Area: LMB adds corners on the plane of the first point (the aim ray meets that plane); clicking the first corner
 *   again, or RMB with three or more corners, closes the outline. Shows the area and perimeter.
 * - Angle: three clicks: first arm, vertex, second arm (0–180°).
 * - Clearance: from the aimed point straight down to the surface below (the floor) and up to the next surface above
 *   (the ceiling), both labelled, with the total. A live preview follows the crosshair.
 * Values follow the display units (metric / imperial) chosen in the pause menu.
 */
export class MeasureGun extends Gun {
  private readonly measurements: Measurement[] = [];
  mode = MeasureMode.Distance;
  private normalSnap = false;

  // In progress: the clicked points (distance 1, area up to 64, angle up to 2) and the live point
  private readonly pending: Vec3[] = [];
  private planeNormal: Vec3 = vec3(0, 0, 1);
  private hasLive = false;
  private liveEnd: Vec3 = vec3();

  // Clearance preview (follows the crosshair)
  private preview: Clearance | null = null;

  get name(): string { return 'MEASURE'; }

  get hintPrimary(): string {
    switch (this.mode) {
      case MeasureMode.Area: return this.pending.length === 0 ? 'Place the first corner' : 'Add a corner (first corner closes)';
      case MeasureMode.Angle: return this.pending.length === 0 ? 'First arm' : this.pending.length === 1 ? 'Vertex' : 'Second arm';
      case MeasureMode.Clearance: return 'Measure floor to ceiling here';
      default: return this.pending.length > 0 ? 'Commit end point' : 'Place start point';
    }
  }

  get hintSecondary(): string {
    return this.mode === MeasureMode.Area && this.pending.length >= 3 ? 'Close the outline' : this.pending.length > 0 ? 'Cancel' : 'Remove last';
  }

  get colour(): number { return UiTheme.MEASURE; }

  get panelHeight(): number {
    return this.mode === MeasureMode.Distance || this.mode === MeasureMode.Clearance ? 176 : 158;
  }

  drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void { GunIcons.measure(ui, cx, cy, size, colour); }

  override onReselect(): void {
    this.mode = (this.mode + 1) % MODE_NAMES.length;
    this.cancelPending();
    this.session.sound.play(SoundId.UiClick);
    this.session.toast(`Measure: ${title(this.mode)} (press 2 again for ${title((this.mode + 1) % MODE_NAMES.length)})`, 2);
  }

  override update(_dt: number, aim: AimInfo): void {
    this.hasLive = false;
    this.preview = null;
    switch (this.mode) {
      case MeasureMode.Distance:
        if (this.pending.length > 0 && aim.hit) {
          this.hasLive = true;
          this.liveEnd = this.snapNormal(aim.hit.point);
        }
        break;
      case MeasureMode.Area:
        if (this.pending.length > 0) {
          const onPlane = this.onPlane(aim);
          if (onPlane) {
            this.hasLive = true;
            this.liveEnd = this.snapToFirst(onPlane);
          }
        }
        break;
      case MeasureMode.Angle:
        if (this.pending.length > 0 && aim.hit) {
          this.hasLive = true;
          this.liveEnd = aim.hit.point;
        }
        break;
      case MeasureMode.Clearance:
        if (aim.hit) { this.preview = this.clearance(aim.hit); }
        break;
    }
  }

  override onDeselect(): void {
    this.hasLive = false;
    this.preview = null;
  }

  override onKeys(input: InputState): void {
    if (this.mode === MeasureMode.Distance && input.isPressed(Vk.key('N'))) {
      this.normalSnap = !this.normalSnap;
      this.session.toast(this.normalSnap ? 'Normal projection ON' : 'Normal projection OFF');
    }
  }

  override onPrimary(aim: AimInfo): void {
    switch (this.mode) {
      case MeasureMode.Distance: this.primaryDistance(aim); break;
      case MeasureMode.Area: this.primaryArea(aim); break;
      case MeasureMode.Angle: this.primaryAngle(aim); break;
      case MeasureMode.Clearance: this.primaryClearance(aim); break;
    }
  }

  override onSecondary(): void {
    if (this.mode === MeasureMode.Area && this.pending.length >= 3) {
      this.closeArea();
      return;
    }
    if (this.pending.length > 0) {
      this.cancelPending();
      return;
    }
    if (this.measurements.length > 0) {
      this.measurements.pop();
      this.session.sound.play(SoundId.Remove);
    }
  }

  clearMarkers(): void {
    this.measurements.length = 0;
    this.cancelPending();
  }

  // #region Modes

  private primaryDistance(aim: AimInfo): void {
    if (!aim.hit) { return; }
    if (this.pending.length === 0) {
      this.pending.push(aim.hit.point);
      this.planeNormal = aim.hit.normal;
    } else {
      const a = this.pending[0], b = this.snapNormal(aim.hit.point);
      this.measurements.push({ ...blank(), mode: MeasureMode.Distance, points: [a, b], value: V.distance(a, b), anchor: V.scale(V.add(a, b), 0.5) });
      this.cancelPending();
    }
    this.session.sound.play(SoundId.Click);
  }

  private primaryArea(aim: AimInfo): void {
    if (this.pending.length === 0) {
      if (!aim.hit) { return; }
      this.pending.push(aim.hit.point);
      this.planeNormal = V.normalize(aim.hit.normal);
      this.session.sound.play(SoundId.Click);
      return;
    }

    const point = this.onPlane(aim);
    if (!point) { return; }

    // A click on the first corner closes the outline
    if (this.pending.length >= 3 && this.nearFirst(point)) {
      this.closeArea();
      return;
    }
    const last = this.pending[this.pending.length - 1];
    if (V.lengthSquared(V.sub(point, last)) < 1e-6) { return; } // double click on the same spot
    if (this.pending.length >= MAX_AREA_POINTS) {
      this.session.toast(`An outline has at most ${MAX_AREA_POINTS} corners: closing it`, 2.5);
      this.closeArea();
      return;
    }
    this.pending.push(point);
    this.session.sound.play(SoundId.Click);
  }

  private closeArea(): void {
    if (this.pending.length < 3) {
      this.cancelPending();
      return;
    }
    const points = [...this.pending];
    const fill: number[] = [];
    MeasureMath.triangulate(points, this.planeNormal, fill);
    let centre = vec3();
    for (const p of points) { centre = V.add(centre, p); }
    this.measurements.push({
      ...blank(), mode: MeasureMode.Area, points, normal: this.planeNormal, fill,
      value: MeasureMath.polygonArea(points, this.planeNormal), value2: MeasureMath.perimeter(points), anchor: V.scale(centre, 1 / points.length)
    });
    this.cancelPending();
    this.session.sound.play(SoundId.Commit);
  }

  private primaryAngle(aim: AimInfo): void {
    if (!aim.hit) { return; }
    if (this.pending.length < 2) {
      this.pending.push(aim.hit.point);
      this.session.sound.play(SoundId.Click);
      return;
    }
    const a = this.pending[0], vertex = this.pending[1], b = aim.hit.point;
    const degrees = MeasureMath.angleDegrees(a, vertex, b);
    if (Number.isNaN(degrees)) {
      this.session.toast('Pick points away from the vertex to measure an angle');
      return;
    }
    this.measurements.push({ ...blank(), mode: MeasureMode.Angle, points: [a, vertex, b], value: degrees, anchor: vertex });
    this.cancelPending();
    this.session.sound.play(SoundId.Click);
  }

  private primaryClearance(aim: AimInfo): void {
    if (!aim.hit) { return; }
    const c = this.clearance(aim.hit);
    if (!c) {
      this.session.toast('Nothing above or below this point to measure to');
      return;
    }
    this.measurements.push({
      ...blank(), mode: MeasureMode.Clearance, points: [c.top, c.point, c.bottom], value: c.point.z - c.bottom.z, value2: c.top.z - c.point.z,
      above: c.above, below: c.below, anchor: c.point
    });
    this.session.sound.play(SoundId.Click);
  }

  /**
   * Clearance rays from an aimed point: straight down to the first surface (or the ground plane) and straight up to
   * the next one. The point is lifted 1 cm off its surface first; a surface found within 2 cm counts as the point
   * itself (aiming at a floor measures 0 down, at a ceiling 0 up).
   * @returns Null when there is nothing above and nothing below.
   */
  private clearance(hit: RayHit): Clearance | null {
    const point = hit.point;
    const normal = V.lengthSquared(hit.normal) > 1e-8 ? V.normalize(hit.normal) : vec3(0, 0, 1);
    const start = V.add(point, V.scale(normal, CLEARANCE_LIFT));

    const down = this.session.pick(start, vec3(0, 0, -1), CLEARANCE_REACH);
    let below = down !== null;
    let bottom = down ? down.point : point;
    if (below && point.z - bottom.z < 0.02) { bottom = point; }
    if (!below && point.z > this.session.groundZ) {
      // Outside, over the ground plane
      below = true;
      bottom = vec3(point.x, point.y, this.session.groundZ);
    }

    const up = this.session.pick(start, vec3(0, 0, 1), CLEARANCE_REACH);
    const above = up !== null;
    let top = up ? up.point : point;
    if (above && top.z - point.z < 0.02) { top = point; }
    return above || below ? { point, top, bottom, above, below } : null;
  }

  // #endregion

  // #region Helpers

  private cancelPending(): void {
    this.pending.length = 0;
    this.hasLive = false;
  }

  /** Distance mode: snaps a candidate end along the start face's normal when N is on. */
  private snapNormal(point: Vec3): Vec3 {
    if (!this.normalSnap || this.pending.length === 0) { return point; }
    const start = this.pending[0];
    return V.add(start, V.scale(this.planeNormal, V.dot(V.sub(point, start), this.planeNormal)));
  }

  /** Area mode: where the aim ray meets the outline's plane (or the aimed point projected onto it). */
  private onPlane(aim: AimInfo): Vec3 | null {
    const point = MeasureMath.rayPlane(aim.origin, aim.direction, this.pending[0], this.planeNormal);
    if (point && V.lengthSquared(V.sub(point, aim.origin)) < 250 * 250) { return point; }
    return aim.hit ? MeasureMath.projectToPlane(aim.hit.point, this.pending[0], this.planeNormal) : null;
  }

  /** True when a point shows within the close distance of the first corner on screen. */
  private nearFirst(point: Vec3): boolean {
    const camera = this.session.camera;
    const a = camera.worldToScreen(point), b = camera.worldToScreen(this.pending[0]);
    if (!a || !b) { return V.distance(point, this.pending[0]) < 0.05; }
    return Math.hypot(a.x - b.x, a.y - b.y) <= this.s(CLOSE_PIXELS);
  }

  /** Area mode: the live point snaps onto the first corner when near it (shows that a click closes). */
  private snapToFirst(point: Vec3): Vec3 {
    return this.pending.length >= 3 && this.nearFirst(point) ? this.pending[0] : point;
  }

  /** The live area outline (pending corners + the live point). */
  private liveOutline(): Vec3[] {
    const outline = [...this.pending];
    if (this.hasLive && (outline.length === 0 || this.liveEnd !== this.pending[0])) { outline.push(this.liveEnd); }
    return outline;
  }

  // #endregion

  // #region Drawing

  override drawWorld(overlay: Overlay3D, selected: boolean): void {
    const line = Rgba.withAlpha(UiTheme.MEASURE, selected ? 0.95 : 0.6);
    const fill = Rgba.withAlpha(UiTheme.MEASURE, selected ? 0.18 : 0.1);

    for (const m of this.measurements) {
      const p = m.points;
      switch (m.mode) {
        case MeasureMode.Distance:
          overlay.line(p[0], p[1], 3, line);
          overlay.dot(p[0], 4.5, line);
          overlay.dot(p[1], 4.5, line);
          break;
        case MeasureMode.Area: {
          // Lifted a couple of millimetres off the surface so the fill doesn't fight it
          const lift = V.scale(m.normal, 0.002);
          for (let i = 0; i + 2 < m.fill.length; i += 3) {
            overlay.triangle(V.add(p[m.fill[i]], lift), V.add(p[m.fill[i + 1]], lift), V.add(p[m.fill[i + 2]], lift), fill);
          }
          for (let i = 0; i < p.length; i++) {
            overlay.line(p[i], p[(i + 1) % p.length], 2.5, line);
            overlay.dot(p[i], 3.5, line);
          }
          break;
        }
        case MeasureMode.Angle:
          overlay.line(p[1], p[0], 3, line);
          overlay.line(p[1], p[2], 3, line);
          overlay.dot(p[0], 4, line);
          overlay.dot(p[1], 5.5, line);
          overlay.dot(p[2], 4, line);
          drawArc(overlay, p[0], p[1], p[2], line);
          break;
        case MeasureMode.Clearance:
          drawClearance(overlay, p[0], p[1], p[2], m.above, m.below, line);
          break;
      }
    }

    if (!selected) { return; }

    // In progress
    const pending = this.pending;
    switch (this.mode) {
      case MeasureMode.Distance:
        if (pending.length > 0) {
          overlay.dot(pending[0], 6, UiTheme.MEASURE);
          if (this.hasLive) {
            overlay.line(pending[0], this.liveEnd, 3, UiTheme.MEASURE);
            overlay.dot(this.liveEnd, 6, UiTheme.MEASURE);
          }
        }
        break;
      case MeasureMode.Area:
        for (let i = 0; i < pending.length; i++) {
          overlay.dot(pending[i], i === 0 ? 6.5 : 4.5, UiTheme.MEASURE);
          if (i > 0) { overlay.line(pending[i - 1], pending[i], 2.5, UiTheme.MEASURE); }
        }
        if (this.hasLive && pending.length > 0) {
          overlay.line(pending[pending.length - 1], this.liveEnd, 2.5, UiTheme.MEASURE);
          if (pending.length >= 2) { overlay.line(this.liveEnd, pending[0], 1.5, Rgba.withAlpha(UiTheme.MEASURE, 0.45)); }
          overlay.dot(this.liveEnd, 5, UiTheme.MEASURE);
        }
        break;
      case MeasureMode.Angle:
        for (let i = 0; i < pending.length; i++) { overlay.dot(pending[i], i === 1 ? 6.5 : 5, UiTheme.MEASURE); }
        if (pending.length === 2) { overlay.line(pending[1], pending[0], 3, UiTheme.MEASURE); }
        if (this.hasLive) {
          overlay.line(pending[pending.length - 1], this.liveEnd, 3, UiTheme.MEASURE);
          overlay.dot(this.liveEnd, 5, UiTheme.MEASURE);
          if (pending.length === 2) { drawArc(overlay, pending[0], pending[1], this.liveEnd, UiTheme.MEASURE); }
        }
        break;
      case MeasureMode.Clearance:
        if (this.preview) {
          const c = this.preview;
          drawClearance(overlay, c.top, c.point, c.bottom, c.above, c.below, Rgba.withAlpha(UiTheme.MEASURE, 0.7));
        }
        break;
    }
  }

  override drawLabels(ui: UiBatch, selected: boolean): void {
    const f = ui.atlas;
    const committed = Rgba.withAlpha(UiTheme.MEASURE_TEXT, selected ? 1 : 0.7);
    const text = this.session.text;

    for (const m of this.measurements) {
      const p = m.points;
      switch (m.mode) {
        case MeasureMode.Distance: this.label(ui, f.mono, m.anchor, UnitFormat.appendLength(text.clear(), m.value).text, committed, false); break;
        case MeasureMode.Area: this.label(ui, f.mono, m.anchor, UnitFormat.appendArea(text.clear(), m.value, 2).text, committed, false); break;
        case MeasureMode.Angle: this.label(ui, f.mono, m.anchor, text.clear().appendNumber(m.value, 1).append('°').text, committed, false); break;
        case MeasureMode.Clearance: this.clearanceLabels(ui, f.mono, p[0], p[1], p[2], m.above, m.below, committed, false); break;
      }
    }

    if (!selected) { return; }
    const pending = this.pending;
    if (this.mode === MeasureMode.Distance && pending.length > 0 && this.hasLive) {
      this.label(ui, f.bold, V.scale(V.add(pending[0], this.liveEnd), 0.5), UnitFormat.appendLength(text.clear(), V.distance(pending[0], this.liveEnd)).text,
        UiTheme.MEASURE_TEXT, true);
    } else if (this.mode === MeasureMode.Area && pending.length >= 2) {
      const outline = this.liveOutline();
      if (outline.length >= 3) {
        let centre = vec3();
        for (const p of outline) { centre = V.add(centre, p); }
        this.label(ui, f.bold, V.scale(centre, 1 / outline.length), UnitFormat.appendArea(text.clear(), MeasureMath.polygonArea(outline, this.planeNormal), 2).text,
          UiTheme.MEASURE_TEXT, true);
      }
    } else if (this.mode === MeasureMode.Angle && pending.length === 2 && this.hasLive) {
      const degrees = MeasureMath.angleDegrees(pending[0], pending[1], this.liveEnd);
      if (!Number.isNaN(degrees)) { this.label(ui, f.bold, pending[1], text.clear().appendNumber(degrees, 1).append('°').text, UiTheme.MEASURE_TEXT, true); }
    } else if (this.mode === MeasureMode.Clearance && this.preview) {
      const c = this.preview;
      this.clearanceLabels(ui, f.bold, c.top, c.point, c.bottom, c.above, c.below, UiTheme.MEASURE_TEXT, true);
    }
  }

  /** "↓ 0.750 m" beside the lower segment and "↑ 1.950 m" beside the upper one. */
  private clearanceLabels(ui: UiBatch, font: UiFont, top: Vec3, point: Vec3, bottom: Vec3, above: boolean, below: boolean, colour: number, live: boolean): void {
    const text = this.session.text;
    const down = point.z - bottom.z, up = top.z - point.z;
    if (below && down > 1e-3) { this.label(ui, font, V.scale(V.add(point, bottom), 0.5), UnitFormat.appendLength(text.clear().append('↓ '), down).text, colour, live); }
    if (above && up > 1e-3) { this.label(ui, font, V.scale(V.add(point, top), 0.5), UnitFormat.appendLength(text.clear().append('↑ '), up).text, colour, live); }
    else if (!above) { this.label(ui, font, point, '↑ nothing above', colour, live); }
  }

  private label(ui: UiBatch, font: UiFont, anchor: Vec3, text: string, colour: number, live: boolean): void {
    const screen = this.session.camera.worldToScreen(anchor);
    if (!screen) { return; }
    const width = UiBatch.measure(font, text) + this.s(16);
    const height = font.lineHeight + this.s(6);
    const x = screen.x - width * 0.5, y = screen.y - height - this.s(6);
    if (live) { ui.panel(x, y, width, height, Rgba.hex(0x0c0e12, 0.85), UiTheme.MEASURE); }
    else { ui.rect(x, y, width, height, Rgba.hex(0x0c0e12, 0.7)); }
    ui.text(font, x + this.s(8), y + this.s(3), text, colour);
  }

  // #endregion

  // #region Panel

  drawPanel(ui: UiBatch, x: number, y: number, width: number): void {
    const f = ui.atlas;
    const live = this.hasLive || this.preview !== null || this.pending.length > 0;
    ui.text(f.small, x, y, `MEASURE · ${MODE_NAMES[this.mode]}${live ? ' · LIVE' : ''}`, UiTheme.MEASURE_LABEL, this.s(1.1));
    y += this.s(20);

    // Mode chips (2 cycles them)
    const chipW = (width - this.s(6) * 3) / 4, chipH = this.s(20);
    MODE_CHIPS.forEach((chip, i) => {
      const cx = x + i * (chipW + this.s(6));
      const on = i === this.mode;
      ui.rect(cx, y, chipW, chipH, on ? UiTheme.MEASURE : Rgba.hex(0xffffff, 0.06));
      ui.textCentred(f.small, cx + chipW * 0.5, y + this.s(4), chip, on ? Rgba.hex(0x1a1405) : UiTheme.TEXT_MUTED, this.s(0.8));
    });
    y += chipH + this.s(10);

    switch (this.mode) {
      case MeasureMode.Area: this.panelArea(ui, f, x, y, width); break;
      case MeasureMode.Angle: this.panelAngle(ui, f, x, y, width); break;
      case MeasureMode.Clearance: this.panelClearance(ui, f, x, y, width); break;
      default: this.panelDistance(ui, f, x, y, width); break;
    }
  }

  private lastOf(mode: MeasureMode): Measurement | null {
    for (let i = this.measurements.length - 1; i >= 0; i--) {
      if (this.measurements[i].mode === mode) { return this.measurements[i]; }
    }
    return null;
  }

  private countOf(mode: MeasureMode): number {
    return this.measurements.filter(m => m.mode === mode).length;
  }

  private panelDistance(ui: UiBatch, f: FontAtlas, x: number, y: number, width: number): void {
    const text = this.session.text;
    const last = this.lastOf(MeasureMode.Distance);
    const any = this.hasLive || last !== null;
    const a = this.hasLive ? this.pending[0] : last?.points[0] ?? vec3();
    const b = this.hasLive ? this.liveEnd : last?.points[1] ?? vec3();
    const d = V.sub(b, a);

    ui.text(f.monoLarge, x, y, any ? UnitFormat.appendLength(text.clear(), V.length(d)).text : '—', UiTheme.TEXT);
    y += this.s(36);

    // ΔX / ΔY / ΔZ in three columns (feet-inches are wider: the small font there)
    const deltaFont = UnitFormat.isImperial ? f.small : f.mono;
    const column = width / 3;
    this.delta(ui, deltaFont, x, y, 'ΔX ', d.x, any);
    this.delta(ui, deltaFont, x + column, y, 'ΔY ', d.y, any);
    this.delta(ui, deltaFont, x + column * 2, y, 'ΔZ ', d.z, any);
    y += this.s(22);

    this.row(ui, f, x, y, width, 'Distances', String(this.countOf(MeasureMode.Distance)));
    y += this.s(19);
    ui.text(f.body, x, y, 'Normal projection (N)', UiTheme.TEXT_MUTED);
    ui.textRight(f.body, x + width, y, this.normalSnap ? 'ON' : 'OFF', UiTheme.MEASURE_LABEL);
    y += this.s(19);
    ui.text(f.small, x, y, 'Press 2 again: area · angle · clearance', UiTheme.TEXT_FAINT);
  }

  private panelArea(ui: UiBatch, f: FontAtlas, x: number, y: number, width: number): void {
    const text = this.session.text;
    const last = this.lastOf(MeasureMode.Area);
    let area: number, perimeter: number, corners: number;
    if (this.pending.length > 0) {
      const outline = this.liveOutline();
      area = MeasureMath.polygonArea(outline, this.planeNormal);
      perimeter = MeasureMath.perimeter(outline, outline.length >= 3);
      corners = this.pending.length;
    } else {
      area = last?.value ?? NaN;
      perimeter = last?.value2 ?? NaN;
      corners = last?.points.length ?? 0;
    }

    ui.text(f.monoLarge, x, y, Number.isNaN(area) ? '—' : UnitFormat.appendArea(text.clear(), area, 2).text, UiTheme.TEXT);
    y += this.s(36);
    this.row(ui, f, x, y, width, 'Perimeter', Number.isNaN(perimeter) ? '—' : UnitFormat.appendLength(text.clear(), perimeter, 2).text);
    y += this.s(19);
    this.row(ui, f, x, y, width, this.pending.length > 0 ? 'Corners so far' : 'Corners', String(corners));
    y += this.s(19);
    ui.text(f.small, x, y, this.pending.length >= 3 ? 'Click the first corner or RMB to close' : "Corners lie on the first point's plane", UiTheme.TEXT_FAINT);
  }

  private panelAngle(ui: UiBatch, f: FontAtlas, x: number, y: number, width: number): void {
    let degrees = NaN;
    if (this.pending.length === 2 && this.hasLive) { degrees = MeasureMath.angleDegrees(this.pending[0], this.pending[1], this.liveEnd); }
    else if (this.pending.length === 0) { degrees = this.lastOf(MeasureMode.Angle)?.value ?? NaN; }

    ui.text(f.monoLarge, x, y, Number.isNaN(degrees) ? '—' : this.session.text.clear().appendNumber(degrees, 1).append('°').text, UiTheme.TEXT);
    y += this.s(36);
    this.row(ui, f, x, y, width, 'Angles', String(this.countOf(MeasureMode.Angle)));
    y += this.s(19);
    const step = this.pending.length === 0 ? 'Click 1 of 3: first arm' : this.pending.length === 1 ? 'Click 2 of 3: the vertex' : 'Click 3 of 3: second arm';
    ui.text(f.body, x, y, step, UiTheme.TEXT_MUTED);
    y += this.s(19);
    ui.text(f.small, x, y, 'The vertex is the middle click', UiTheme.TEXT_FAINT);
  }

  private panelClearance(ui: UiBatch, f: FontAtlas, x: number, y: number, width: number): void {
    const text = this.session.text;
    const last = this.lastOf(MeasureMode.Clearance);
    const c: Clearance | null = this.preview ?? (last ? { top: last.points[0], point: last.points[1], bottom: last.points[2], above: last.above, below: last.below } : null);
    const down = c ? c.point.z - c.bottom.z : 0, up = c ? c.top.z - c.point.z : 0;

    ui.text(f.monoLarge, x, y, c && c.above && c.below ? UnitFormat.appendLength(text.clear(), c.top.z - c.bottom.z).text : '—', UiTheme.TEXT);
    y += this.s(36);
    this.row(ui, f, x, y, width, '↓ To the surface below', c && c.below ? UnitFormat.appendLength(text.clear(), down).text : '—');
    y += this.s(19);
    this.row(ui, f, x, y, width, '↑ To the surface above', c && c.above ? UnitFormat.appendLength(text.clear(), up).text : c ? 'none' : '—');
    y += this.s(19);
    this.row(ui, f, x, y, width, 'Clearances', String(this.countOf(MeasureMode.Clearance)));
    y += this.s(19);
    ui.text(f.small, x, y, 'Aim at a floor for floor to ceiling', UiTheme.TEXT_FAINT);
  }

  private row(ui: UiBatch, f: FontAtlas, x: number, y: number, width: number, label: string, value: string): void {
    ui.text(f.body, x, y, label, UiTheme.TEXT_MUTED);
    ui.textRight(f.body, x + width, y, value, UiTheme.TEXT);
  }

  private delta(ui: UiBatch, font: UiFont, x: number, y: number, label: string, value: number, any: boolean): void {
    const w = ui.text(font, x, y, label, UiTheme.TEXT_MUTED);
    const text = this.session.text.clear();
    // Metric: the bare number (the big value above carries the unit); imperial: feet-inches
    if (!any) { text.append('—'); }
    else if (UnitFormat.isImperial) { UnitFormat.appendLength(text, Math.abs(value)); }
    else { text.appendNumber(Math.abs(value), 3); }
    ui.text(font, x + w, y, text.text, UiTheme.TEXT);
  }

  // #endregion
}

function title(mode: MeasureMode): string {
  switch (mode) {
    case MeasureMode.Area: return 'area';
    case MeasureMode.Angle: return 'angle';
    case MeasureMode.Clearance: return 'clearance';
    default: return 'distance';
  }
}

/** A small arc at the vertex between the two arms. */
function drawArc(overlay: Overlay3D, a: Vec3, vertex: Vec3, b: Vec3, colour: number): void {
  let p = V.sub(a, vertex), q = V.sub(b, vertex);
  const lp = V.length(p), lq = V.length(q);
  if (lp < 1e-4 || lq < 1e-4) { return; }
  p = V.scale(p, 1 / lp);
  q = V.scale(q, 1 / lq);
  const radius = Math.min(Math.min(lp, lq) * 0.3, 0.4);
  const angle = Math.acos(Math.min(Math.max(V.dot(p, q), -1), 1));
  if (angle < 1e-3) { return; }

  // Slerp from p to q
  let previous = V.add(vertex, V.scale(p, radius));
  const SEGMENTS = 16;
  const s = Math.sin(angle);
  for (let i = 1; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    const d = s > 1e-4 ? V.scale(V.add(V.scale(p, Math.sin((1 - t) * angle)), V.scale(q, Math.sin(t * angle))), 1 / s) : p;
    const next = V.add(vertex, V.scale(d, radius));
    overlay.line(previous, next, 2, colour);
    previous = next;
  }
}

/** The clearance marker: a vertical line with dots at the ends and the aimed point. */
function drawClearance(overlay: Overlay3D, top: Vec3, point: Vec3, bottom: Vec3, above: boolean, below: boolean, colour: number): void {
  if (below && point.z - bottom.z > 1e-3) {
    overlay.line(point, bottom, 3, colour);
    overlay.dot(bottom, 4.5, colour);
  }
  if (above && top.z - point.z > 1e-3) {
    overlay.line(point, top, 3, colour);
    overlay.dot(top, 4.5, colour);
  }
  overlay.dot(point, 5.5, colour);
}
