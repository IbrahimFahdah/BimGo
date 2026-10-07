import type { CommentRecord } from '../../core/format/DocumentModels';
import type { Vec3 } from '../../core/math/Vector';
import type { SceneData } from '../../core/scene/SceneData';
import type { RayHit } from '../../engine/physics/Bvh';
import type { FpsCamera } from '../../engine/render/FpsCamera';
import type { Overlay3D } from '../../engine/render/Overlay3D';
import type { TextBuffer } from '../../engine/ui/TextBuffer';
import type { UiBatch } from '../../engine/ui/UiBatch';
import { UiTheme } from '../../engine/ui/UiTheme';
import type { SoundSystem } from '../../platform/audio';
import type { InputState } from '../../platform/input';
import type { Player } from '../Player';
import type { CommentStore } from '../Stores';

/** Where the crosshair points this frame (port of AimInfo). */
export interface AimInfo {
  hasHit: boolean;
  hit: RayHit | null;
  origin: Vec3;
  direction: Vec3;
}

/** An element drawn again with a colour override (port of Highlight). */
export interface Highlight {
  element: number;
  dynamicId: number;
  colour: number;
  strength: number;
}

/** What the guns may use of the walkthrough (the desktop passes the GameSession itself). */
export interface GunHost {
  readonly scene: SceneData;
  readonly camera: FpsCamera;
  readonly text: TextBuffer;
  readonly sound: SoundSystem;
  readonly player: Player;
  readonly comments: CommentStore;
  readonly uiScale: number;
  readonly screenWidth: number;
  readonly currentLevelName: string;
  readonly isEditingComment: boolean;
  readonly editPoint: Vec3;
  /** True while a live Revit session is connected. */
  readonly isLiveConnected: boolean;
  toast(message: string, seconds?: number): void;
  flash(colour: number, seconds: number): void;
  pick(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null;
  levelNameAt(z: number): string;
  isTargetPresent(element: number, dynamicId: number): boolean;
  hideElement(element: number, dynamicId: number): void;
  toggleIsolateCategory(element: number): void;
  beginCommentEdit(point: Vec3, elementId: number, level: string): void;
  editComment(record: CommentRecord): void;
  showInRevit(element: number, dynamicId: number): void;
}

/**
 * A tool in the gun bar (port of BimGo.App/Game/Guns/Gun.cs): LMB / RMB actions, keys, world markers, labels and a
 * context panel under the minimap.
 */
export abstract class Gun {
  /** The number key shown on the bar. */
  key = '';

  constructor(protected readonly session: GunHost) {}

  abstract get name(): string;
  abstract get hintPrimary(): string;
  abstract get hintSecondary(): string;
  abstract get colour(): number;
  /** Panel height in unscaled pixels. */
  abstract get panelHeight(): number;

  get highlightElement(): number { return -1; }
  get highlightDynamic(): number { return 0; }
  get highlightStrength(): number { return 0.35; }
  /** True while the gun owns the movement keys (Gizmo / Clone). */
  get capturesInput(): boolean { return false; }

  collectHighlights(highlights: Highlight[]): void {
    if (this.highlightDynamic > 0 || this.highlightElement >= 0) {
      highlights.push({ element: this.highlightElement, dynamicId: this.highlightDynamic, colour: UiTheme.SCAN, strength: this.highlightStrength });
    }
  }

  onCancel(): void { /* optional */ }
  abstract drawIcon(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void;
  update(_dt: number, _aim: AimInfo): void { /* optional */ }
  tick(_dt: number): void { /* optional */ }
  onPrimary(_aim: AimInfo): void { /* optional */ }
  onSecondary(_aim: AimInfo): void { /* optional */ }
  onKeys(_input: InputState): void { /* optional */ }
  onDeselect(): void { /* optional */ }
  abstract clearMarkers(): void;
  drawWorld(_overlay: Overlay3D, _selected: boolean): void { /* optional */ }
  drawLabels(_ui: UiBatch, _selected: boolean): void { /* optional */ }
  abstract drawPanel(ui: UiBatch, x: number, y: number, width: number): void;

  protected s(value: number): number {
    return value * this.session.uiScale;
  }
}
