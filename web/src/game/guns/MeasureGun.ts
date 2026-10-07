import { type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import type { Overlay3D } from '../../engine/render/Overlay3D';
import { Rgba } from '../../engine/ui/Rgba';
import { UiBatch } from '../../engine/ui/UiBatch';
import type { FontAtlas, UiFont } from '../../engine/ui/UiFont';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { type InputState, Vk } from '../../platform/input';
import { type AimInfo, Gun } from './Gun';
import { GunIcons } from './GunIcons';

/** Point-to-point distances with ΔX/ΔY/ΔZ and optional normal projection (port of MeasureGun.cs). */
export class MeasureGun extends Gun {
  private readonly lines: { a: Vec3; b: Vec3 }[] = [];
  private hasStart = false;
  private start: Vec3 = vec3();
  private startNormal: Vec3 = vec3();
  private hasLive = false;
  private liveEnd: Vec3 = vec3();
  private normalSnap = false;

  get name(): string { return 'MEASURE'; }
  get hintPrimary(): string { return this.hasStart ? 'Commit end point' : 'Place start point'; }
  get hintSecondary(): string { return this.hasStart ? 'Cancel line' : 'Remove last line'; }
  get colour(): number { return UiTheme.MEASURE; }
  get panelHeight(): number { return 132; }

  drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void { GunIcons.measure(ui, cx, cy, size, colour); }

  override update(_dt: number, aim: AimInfo): void {
    this.hasLive = this.hasStart && aim.hit !== null;
    if (this.hasLive && aim.hit) { this.liveEnd = this.snap(aim.hit.point); }
  }

  override onDeselect(): void {
    this.hasLive = false;
  }

  override onKeys(input: InputState): void {
    if (input.isPressed(Vk.key('N'))) {
      this.normalSnap = !this.normalSnap;
      this.session.toast(this.normalSnap ? 'Normal projection ON' : 'Normal projection OFF');
    }
  }

  override onPrimary(aim: AimInfo): void {
    if (!aim.hit) { return; }
    if (!this.hasStart) {
      this.hasStart = true;
      this.start = aim.hit.point;
      this.startNormal = aim.hit.normal;
    } else {
      this.lines.push({ a: this.start, b: this.snap(aim.hit.point) });
      this.hasStart = false;
      this.hasLive = false;
    }
    this.session.sound.play(SoundId.Click);
  }

  override onSecondary(): void {
    if (this.hasStart) {
      this.hasStart = false;
      this.hasLive = false;
    } else if (this.lines.length > 0) {
      this.lines.pop();
      this.session.sound.play(SoundId.Remove);
    }
  }

  clearMarkers(): void {
    this.lines.length = 0;
    this.hasStart = false;
    this.hasLive = false;
  }

  private snap(point: Vec3): Vec3 {
    if (!this.normalSnap) { return point; }
    return V.add(this.start, V.scale(this.startNormal, V.dot(V.sub(point, this.start), this.startNormal)));
  }

  override drawWorld(overlay: Overlay3D, selected: boolean): void {
    const committed = Rgba.withAlpha(UiTheme.MEASURE, selected ? 0.95 : 0.6);
    for (const line of this.lines) {
      overlay.line(line.a, line.b, 3, committed);
      overlay.dot(line.a, 4.5, committed);
      overlay.dot(line.b, 4.5, committed);
    }
    if (this.hasStart) {
      overlay.dot(this.start, 6, UiTheme.MEASURE);
      if (this.hasLive) {
        overlay.line(this.start, this.liveEnd, 3, UiTheme.MEASURE);
        overlay.dot(this.liveEnd, 6, UiTheme.MEASURE);
      }
    }
  }

  override drawLabels(ui: UiBatch, selected: boolean): void {
    const f = ui.atlas;
    for (const line of this.lines) {
      this.label(ui, f.mono, line.a, line.b, Rgba.withAlpha(UiTheme.MEASURE_TEXT, selected ? 1 : 0.7), false);
    }
    if (this.hasStart && this.hasLive) { this.label(ui, f.bold, this.start, this.liveEnd, UiTheme.MEASURE_TEXT, true); }
  }

  private label(ui: UiBatch, font: UiFont, a: Vec3, b: Vec3, colour: number, live: boolean): void {
    const screen = this.session.camera.worldToScreen(V.scale(V.add(a, b), 0.5));
    if (!screen) { return; }
    const text = this.session.text.clear().appendNumber(V.distance(a, b), 3).append(' m').text;
    const width = UiBatch.measure(font, text) + this.s(16);
    const height = font.lineHeight + this.s(6);
    const x = screen.x - width * 0.5, y = screen.y - height - this.s(6);
    if (live) { ui.panel(x, y, width, height, Rgba.hex(0x0c0e12, 0.85), UiTheme.MEASURE); }
    else { ui.rect(x, y, width, height, Rgba.hex(0x0c0e12, 0.7)); }
    ui.text(font, x + this.s(8), y + this.s(3), text, colour);
  }

  drawPanel(ui: UiBatch, x: number, y: number, width: number): void {
    const f = ui.atlas;
    ui.text(f.small, x, y, this.hasLive ? 'MEASURE · LIVE' : 'MEASURE · LAST', UiTheme.MEASURE_LABEL, this.s(1.1));
    y += this.s(20);

    const any = this.hasLive || this.lines.length > 0;
    const last = this.lines[this.lines.length - 1];
    const a = this.hasLive ? this.start : last ? last.a : vec3();
    const b = this.hasLive ? this.liveEnd : last ? last.b : vec3();
    const d = V.sub(b, a);

    const text = this.session.text.clear();
    if (any) { text.appendNumber(V.length(d), 3).append(' m'); } else { text.append('—'); }
    ui.text(f.monoLarge, x, y, text.text, UiTheme.TEXT);
    y += this.s(36);

    const column = width / 3;
    this.delta(ui, f, x, y, 'ΔX ', d.x, any);
    this.delta(ui, f, x + column, y, 'ΔY ', d.y, any);
    this.delta(ui, f, x + column * 2, y, 'ΔZ ', d.z, any);
    y += this.s(22);

    ui.text(f.body, x, y, 'Committed lines', UiTheme.TEXT_MUTED);
    ui.textRight(f.body, x + width, y, String(this.lines.length), UiTheme.TEXT);
    y += this.s(19);
    ui.text(f.body, x, y, 'Normal projection (N)', UiTheme.TEXT_MUTED);
    ui.textRight(f.body, x + width, y, this.normalSnap ? 'ON' : 'OFF', UiTheme.MEASURE_LABEL);
  }

  private delta(ui: UiBatch, f: FontAtlas, x: number, y: number, label: string, value: number, any: boolean): void {
    const w = ui.text(f.mono, x, y, label, UiTheme.TEXT_MUTED);
    const text = this.session.text.clear();
    if (any) { text.appendNumber(Math.abs(value), 3); } else { text.append('—'); }
    ui.text(f.mono, x + w, y, text.text, UiTheme.TEXT);
  }
}
