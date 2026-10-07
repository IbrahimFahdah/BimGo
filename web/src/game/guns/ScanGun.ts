import { CATEGORIES, GROUP_NAMES } from '../../core/scene/CategoryCatalog';
import { linkLabel } from '../../core/scene/LinkInfo';
import { linkOf, PhaseRole } from '../../core/scene/SceneData';
import { type Vec3, vec3 } from '../../core/math/Vector';
import { UiBatch } from '../../engine/ui/UiBatch';
import type { FontAtlas } from '../../engine/ui/UiFont';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { type InputState, Vk } from '../../platform/input';
import { type AimInfo, Gun } from './Gun';
import { GunIcons } from './GunIcons';

/** Identify elements: hover or lock a target to read its data and parameters (port of ScanGun.cs). */
export class ScanGun extends Gun {
  private static readonly MAX_PARAMETER_ROWS = 8;
  private hover = -1;
  private hoverDynamic = 0;
  private locked = -1;
  private lockedDynamic = 0;
  private lockPoint: Vec3 = vec3();
  private existingLabel: string | null = null;

  get name(): string { return 'SCAN'; }
  get hintPrimary(): string { return 'Lock target'; }
  get hintSecondary(): string { return 'Clear'; }
  get colour(): number { return UiTheme.SCAN; }

  drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void { GunIcons.scan(ui, cx, cy, size, colour); }

  get panelHeight(): number {
    return 169 + (this.isLinkedTarget ? 19 : 0) + 19 * Math.min(this.session.scene.parameters.countFor(this.target), ScanGun.MAX_PARAMETER_ROWS);
  }

  private get isLinkedTarget(): boolean {
    return this.target >= 0 && this.session.scene.elements[this.target].link > 0;
  }

  private get target(): number { return this.locked >= 0 ? this.locked : this.hover; }

  override get highlightElement(): number { return this.locked >= 0 ? this.locked : this.hover; }
  override get highlightDynamic(): number { return this.locked >= 0 ? this.lockedDynamic : this.hoverDynamic; }
  override get highlightStrength(): number { return this.locked >= 0 ? 0.42 : 0.22; }

  override update(_dt: number, aim: AimInfo): void {
    this.hover = aim.hit ? aim.hit.element : -1;
    this.hoverDynamic = aim.hit ? aim.hit.dynamicId : 0;

    // Drop a lock whose target was hidden / demolished
    if (this.locked >= 0 && !this.session.isTargetPresent(this.locked, this.lockedDynamic)) {
      this.locked = -1;
      this.lockedDynamic = 0;
    }
  }

  override onKeys(input: InputState): void {
    if (input.isPressed(Vk.key('R')) && this.target >= 0) {
      this.session.showInRevit(this.target, this.locked >= 0 ? this.lockedDynamic : this.hoverDynamic);
    }

    // I: hide the target in the walkthrough only; Shift+I: isolate its category (again: restore)
    if (input.isPressed(Vk.key('I'))) {
      if (input.isDown(Vk.SHIFT)) { this.session.toggleIsolateCategory(this.target); }
      else if (this.target >= 0) {
        const target = this.target;
        const dynamicId = this.locked >= 0 ? this.lockedDynamic : this.hoverDynamic;
        if (this.locked >= 0 && dynamicId === 0) { this.locked = -1; }
        this.session.hideElement(target, dynamicId);
      }
    }
  }

  override onDeselect(): void {
    this.hover = -1;
    this.hoverDynamic = 0;
  }

  override onPrimary(aim: AimInfo): void {
    if (!aim.hit) { return; }
    this.locked = aim.hit.element;
    this.lockedDynamic = aim.hit.dynamicId;
    this.lockPoint = aim.hit.point;
    this.session.sound.play(SoundId.ScanLock);
  }

  override onSecondary(): void {
    if (this.locked >= 0) { this.session.sound.play(SoundId.UiClick); }
    this.locked = -1;
  }

  clearMarkers(): void {
    this.locked = -1;
  }

  override drawLabels(ui: UiBatch, selected: boolean): void {
    if (!selected || this.locked < 0) { return; }
    const screen = this.session.camera.worldToScreen(this.lockPoint);
    if (!screen) { return; }

    const record = this.session.scene.elements[this.locked];
    const text = this.session.text.clear().append(record.categoryName).append(' · ').append(record.name).text;
    const font = ui.atlas.small;
    const width = UiBatch.measure(font, text, this.s(0.3)) + this.s(16);
    const x = screen.x + this.s(18), y = screen.y - this.s(12);
    ui.rect(x, y, width, this.s(22), UiTheme.SCAN);
    ui.text(font, x + this.s(8), y + this.s(4), text, UiTheme.SCAN_TAG_TEXT, this.s(0.3));
    ui.line(screen.x, screen.y, x, y + this.s(11), this.s(1.5), UiTheme.SCAN);
    ui.circle(screen.x, screen.y, this.s(3.5), UiTheme.SCAN);
  }

  drawPanel(ui: UiBatch, x: number, y: number, width: number): void {
    const f = ui.atlas;
    const target = this.target;
    const scene = this.session.scene;

    ui.text(f.small, x, y, this.locked >= 0 ? 'SCAN · TARGET' : 'SCAN · HOVER', UiTheme.SCAN_LABEL, this.s(1.1));
    if (this.session.isLiveConnected) { ui.textRight(f.small, x + width, y, 'R  REVIT', UiTheme.TEXT_MUTED, this.s(1)); }
    y += this.s(20);

    if (target < 0) {
      ui.text(f.body, x, y, 'Aim at an element. LMB locks it.', UiTheme.TEXT_MUTED);
      return;
    }

    const record = scene.elements[target];
    ui.textWrapped(f.bold, x, y, width, record.name, UiTheme.TEXT, 1);
    y += this.s(24);

    const labelWidth = this.s(84);
    const row = (label: string, value: string | null) => {
      ui.text(f.body, x, y, label, UiTheme.TEXT_MUTED);
      ui.textWrapped(f.body, x + labelWidth, y, width - labelWidth, value ?? '—', UiTheme.TEXT, 1);
      y += this.s(19);
    };

    const link = linkOf(scene, record);
    if (link) { row('Model', 'Link · ' + linkLabel(link)); }
    row('Category', record.categoryName);
    row('Family', record.familyType);
    ui.text(f.body, x, y, 'Element ID', UiTheme.TEXT_MUTED);
    ui.text(f.mono, x + labelWidth, y + this.s(1), String(record.elementId), UiTheme.TEXT);
    y += this.s(19);
    row('Level', record.levelName);
    const group = GROUP_NAMES[CATEGORIES[record.categoryIndex].group];
    row('Group', record.isProxy ? group + ' (proxy)' : group);
    row('Phase', record.link > 0 && record.phase === PhaseRole.Existing ? 'Existing' : this.phaseText(record.phase));

    // Extra parameters (if any were extracted)
    this.drawParameters(ui, f, target, x, y, width, labelWidth);
  }

  private drawParameters(ui: UiBatch, f: FontAtlas, target: number, x: number, y: number, width: number, labelWidth: number): void {
    const parameters = this.session.scene.parameters;
    const count = Math.min(parameters.countFor(target), ScanGun.MAX_PARAMETER_ROWS);
    for (let i = 0; i < count; i++) {
      const p = parameters.get(target, i);
      if (!p) { continue; }
      ui.textWrapped(f.body, x, y, labelWidth - this.s(6), p.name, UiTheme.TEXT_MUTED, 1);
      ui.textWrapped(f.body, x + labelWidth, y, width - labelWidth, p.value || '—', UiTheme.TEXT, 1);
      y += this.s(19);
    }
  }

  private phaseText(role: PhaseRole): string {
    switch (role) {
      case PhaseRole.New: return 'New work';
      case PhaseRole.Between: return 'Built between phases';
      case PhaseRole.Unphased: return 'Not phased';
      default:
        this.existingLabel ??= this.session.scene.existingPhaseName === null ? 'Existing' : `Existing (${this.session.scene.existingPhaseName})`;
        return this.existingLabel;
    }
  }
}
