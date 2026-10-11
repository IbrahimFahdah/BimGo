import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import type { GameSession } from './GameSession';
import type { Widgets } from './Menus';
import { UnitFormat } from './UnitFormat';
import { EyeHeights, EyePreset, type ViewerSettings } from './ViewerSettings';

const EYE_OPTIONS = ['Standing', 'Seated', 'Child'];

/** Height step of the pause menu's − / + buttons (m). */
const EYE_STEP = 0.05;

/**
 * Eye-height presets (port of GameSession.EyeHeight.cs): standing, seated / wheelchair and child, picked in the pause
 * menu and remembered in the viewer settings with each preset's height. The capsule follows the eye (collision,
 * headroom, crouch); the step-up height stays the same. Bookmarks keep the eye height they were saved at: GO and the
 * tour use it.
 */
export class EyeHeightControl {
  /** Each preset's eye height (m). */
  readonly heights = [EyeHeights.DEFAULT_STANDING, EyeHeights.DEFAULT_SEATED, EyeHeights.DEFAULT_CHILD];
  preset = EyePreset.Standing;
  /** True when a bookmark set a height no preset has (reads CUSTOM until a preset is picked). */
  custom = false;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  /** Reads the presets from the settings (constructor). */
  read(settings: ViewerSettings): void {
    this.heights[0] = settings.eyeHeightStanding;
    this.heights[1] = settings.eyeHeightSeated;
    this.heights[2] = settings.eyeHeightChild;
    this.preset = settings.eyePreset;
  }

  /** Gives the new player the preset's height (before spawning: no headroom check). */
  initialise(): void {
    this.session.player.controller.setStandingEye(this.heights[this.preset], true);
  }

  /** Writes the presets into the settings. */
  write(settings: ViewerSettings): void {
    settings.eyePreset = this.preset;
    settings.setEyeHeight(EyePreset.Standing, this.heights[0]);
    settings.setEyeHeight(EyePreset.Seated, this.heights[1]);
    settings.setEyeHeight(EyePreset.Child, this.heights[2]);
  }

  /** The player's standing eye height now (m): what a new bookmark keeps. */
  get current(): number {
    return this.session.player?.controller.standEye ?? EyeHeights.DEFAULT_STANDING;
  }

  /** Switches to a preset. Growing taller under a low ceiling is refused (walking); flying never is. */
  select(preset: EyePreset): void {
    const player = this.session.player;
    const eye = this.heights[preset];
    if (!player.controller.setStandingEye(eye, player.flying)) {
      this.session.sound.play(SoundId.Error);
      this.session.toast(`No headroom for a ${UnitFormat.length(eye, 2)} eye height here: move somewhere taller first`, 3);
      return;
    }
    this.preset = preset;
    this.custom = false;
    this.session.settingsChanged();
  }

  /**
   * Sets an exact eye height (bookmark GO, the tour): no headroom check (the view was saved there). The preset whose
   * height matches becomes current, else the height reads CUSTOM until a preset is picked.
   */
  apply(eye: number): void {
    const controller = this.session.player.controller;
    controller.setStandingEye(eye, true);
    this.custom = true;
    for (let i = 0; i < this.heights.length; i++) {
      if (Math.abs(this.heights[i] - controller.standEye) < 0.005) {
        this.preset = i as EyePreset;
        this.custom = false;
        break;
      }
    }
  }

  /** Pause menu − / +: changes the current preset's height (5 cm steps) and applies it. */
  adjust(direction: number): void {
    const player = this.session.player;
    const before = this.heights[this.preset];
    const value = Math.round(Math.min(Math.max(before + direction * EYE_STEP, EyeHeights.MIN), EyeHeights.MAX) * 100) / 100;
    if (value === before) { return; }
    this.heights[this.preset] = value;
    if (!player.controller.setStandingEye(value, player.flying || value < before)) {
      this.heights[this.preset] = before;
      this.session.sound.play(SoundId.Error);
      this.session.toast('No headroom to raise the eye here: move somewhere taller first', 3);
      return;
    }
    this.custom = false;
    this.session.settingsChanged();
  }

  /** The status panel's MODE value: walk / crouch / fly, with the preset when it isn't standing. */
  modeLabel(): string {
    const player = this.session.player;
    if (player.flying) { return 'FLY'; }
    const crouch = player.controller.crouching;
    if (this.custom) { return crouch ? 'CROUCH · CUSTOM EYE' : 'WALK · CUSTOM EYE'; }
    switch (this.preset) {
      case EyePreset.Seated: return crouch ? 'CROUCH · SEATED' : 'WALK · SEATED';
      case EyePreset.Child: return crouch ? 'CROUCH · CHILD' : 'WALK · CHILD';
      default: return crouch ? 'CROUCH' : 'WALK';
    }
  }

  /**
   * The pause menu's eye-height row: preset buttons, then − / + for the current preset's height.
   * @returns The height used.
   */
  buildRow(f: FontAtlas, w: Widgets, x: number, y: number, width: number): number {
    const session = this.session, ui = session.ui;
    ui.text(f.small, x, y + this.s(2), 'EYE HEIGHT', UiTheme.TEXT_MUTED, this.s(1.8));
    const text = session.text.clear();
    if (this.custom) { UnitFormat.appendLength(text.append('CUSTOM '), session.player.controller.standEye, 2); }
    else { UnitFormat.appendLength(text, this.heights[this.preset], 2); }
    ui.textRight(f.mono, x + width, y + this.s(1), text.text, this.custom ? UiTheme.MEASURE_LABEL : Rgba.hex(0x67e8f9));

    const buttonW = this.s(34), gap = this.s(6);
    const segmentsW = width - buttonW * 2 - gap * 2;
    const shown = this.custom ? -1 : this.preset;
    const picked = w.segmented(f, x, y + this.s(22), segmentsW, EYE_OPTIONS, shown);
    if (picked !== shown && picked >= 0) { this.select(picked as EyePreset); }

    const bx = x + segmentsW + gap, by = y + this.s(22), bh = this.s(32);
    if (w.smallButton(f, bx, by, buttonW, bh, '−')) { this.adjust(-1); }
    if (w.smallButton(f, bx + buttonW + gap, by, buttonW, bh, '+')) { this.adjust(+1); }
    return this.s(66);
  }
}
