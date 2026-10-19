import { InputAction } from '../core/scene/InputCatalog';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { PadInput } from '../platform/gamepad';
import { Hotkeys, KeyHint, keyOf } from '../platform/Hotkeys';
import type { InputState } from '../platform/input';
import type { GameSession } from './GameSession';

/** The wheel's radius (unscaled px): the mouse pointer stops at its edge. */
const WHEEL_RADIUS = 150;
/** Within this share of the radius the mouse pointer picks nothing. */
const WHEEL_DEAD = 0.3;
/** The hover value of the gun bar switch (the bottom slot). */
const WHEEL_BAR = -2;
/** The hover value of the UNARMED slot (beside the bar switch). */
const WHEEL_UNARMED = -3;

const HINT_MOUSE = new KeyHint(() => 'Move towards a gun and let go · let go in the middle to keep this one');
const HINT_PAD = new KeyHint(() =>
  `Point at a gun · ${Hotkeys.map.padLabel(InputAction.PadClick)} or ${Hotkeys.map.padLabel(InputAction.GunWheel)} picks · ${Hotkeys.map.padLabel(InputAction.PadMenuBack)} closes`);

/**
 * The gun wheel (port of GameSession.GunWheel.cs, input round B2 build B and the polish round): the guns on a ring
 * around the crosshair, plus a gun bar switch and UNARMED at the bottom. Mouse (MMB by default): hold, move towards a
 * gun, release to pick it (released near the centre: nothing changes). Gamepad (RS click): click, point the look stick,
 * then A or the click again picks; B closes. The number keys still pick guns directly. Looking pauses while it is open.
 */
export class GunWheel {
  open = false;
  private byPad = false;
  private pointerX = 0;
  private pointerY = 0;
  private hover = -1;

  constructor(private readonly session: GameSession) {}

  private get slotCount(): number { return this.session.guns.length + 2; }
  private get barSlot(): number { return Math.trunc(this.slotCount / 2); }

  /** Walking (no gun holding the keys): opens, steers and closes the wheel. True while it is open (the walking keys wait). */
  update(input: InputState): boolean {
    const session = this.session;
    if (!this.open) {
      if (!input.pressed(InputAction.GunWheel)) { return false; }
      this.open = true;
      this.byPad = input.pressedByPad(InputAction.GunWheel);
      this.pointerX = this.pointerY = 0;
      this.hover = -1;
      session.sound.play(SoundId.UiClick);
      return true;
    }

    if (this.byPad) {
      // The look stick points at a gun; the gun stays highlighted when the stick springs back
      const [sx, sy] = PadInput.lookStick(input);
      if (sx * sx + sy * sy >= 0.25) { this.hover = this.slotAt(sx, -sy); }
      if (input.pressed(InputAction.GunWheel) || input.pressed(InputAction.PadClick)) { this.close(true); }
      else if (input.pressed(InputAction.PadMenuBack)) { this.close(false); }
      return true;
    }

    // Mouse: the pointer follows the raw movement (the cursor stays captured), clamped to the ring
    const radius = session.s(WHEEL_RADIUS);
    this.pointerX += input.mouseDeltaX * 0.8;
    this.pointerY += input.mouseDeltaY * 0.8;
    const length = Math.hypot(this.pointerX, this.pointerY);
    if (length > radius) {
      this.pointerX *= radius / length;
      this.pointerY *= radius / length;
    }
    this.hover = Math.hypot(this.pointerX, this.pointerY) >= radius * WHEEL_DEAD ? this.slotAt(this.pointerX, this.pointerY) : -1;
    if (!input.down(InputAction.GunWheel)) { this.close(true); }
    return true;
  }

  /** Closes the wheel, picking the highlighted slot (the same gun: nothing changes). */
  close(pick: boolean): void {
    if (!this.open) { return; }
    const session = this.session;
    this.open = false;
    if (pick && this.hover === WHEEL_BAR) {
      session.settings.showGunBar = !session.settings.showGunBar;
      session.settings.save();
      session.sound.play(SoundId.UiClick);
      session.toast(session.settings.showGunBar ? "Gun bar shown (the gun wheel's bottom slot hides it)" : `Gun bar hidden: ${keyOf(InputAction.GunWheel)} opens the gun wheel`, 2.5);
    } else if (pick && this.hover === WHEEL_UNARMED) {
      session.setUnarmed(true);
    } else if (pick && this.hover >= 0 && this.hover < session.guns.length && (this.hover !== session.activeGun || session.unarmed)) {
      session.selectGun(this.hover);
    } else if (!pick) {
      session.sound.play(SoundId.UiClick);
    }
    this.hover = -1;
  }

  /** What a direction points at (screen space, y down): a gun index (gun 1 at the top, then clockwise), the bar or UNARMED. */
  private slotAt(x: number, y: number): number {
    const count = this.slotCount;
    const angle = Math.atan2(y, x) + Math.PI * 0.5; // 0 = up
    const slot = Math.round(angle / (Math.PI * 2 / count));
    return this.slotTarget(((slot % count) + count) % count);
  }

  private slotTarget(slot: number): number {
    const bar = this.barSlot;
    return slot === bar ? WHEEL_BAR : slot === bar + 1 ? WHEEL_UNARMED : slot < bar ? slot : slot - 2;
  }

  /** Draws the wheel: a dark disc, a wedge per slot with its icon and key, the highlighted name in the middle. */
  build(f: FontAtlas, width: number, height: number): void {
    if (!this.open) { return; }
    const session = this.session, ui = session.ui, s = (v: number) => session.s(v);
    const cx = Math.round(width * 0.5), cy = Math.round(height * 0.5);
    const radius = s(WHEEL_RADIUS), inner = radius * 0.34;
    const count = this.slotCount, step = Math.PI * 2 / count;
    const showBar = session.settings.showGunBar;

    ui.circle(cx, cy, radius + s(10), Rgba.hex(0x0c0e12, 0.78), 48);
    for (let slot = 0; slot < count; slot++) {
      const target = this.slotTarget(slot);
      const mid = -Math.PI * 0.5 + slot * step;
      const hover = target === this.hover;
      const ix = cx + Math.cos(mid) * radius * 0.68, iy = cy + Math.sin(mid) * radius * 0.68;

      const edge = mid - step * 0.5;
      ui.line(cx + Math.cos(edge) * inner, cy + Math.sin(edge) * inner, cx + Math.cos(edge) * radius, cy + Math.sin(edge) * radius,
        Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.12));

      if (target === WHEEL_BAR) {
        // The gun bar switch: three little slots, lit when the bar is shown
        if (hover) { ui.wedge(cx, cy, radius, mid - step * 0.5, mid + step * 0.5, Rgba.hex(0xffffff, 0.16), 10); }
        const colour = hover ? UiTheme.TEXT : showBar ? UiTheme.ACCENT : UiTheme.TEXT_FAINT;
        const cell = s(hover ? 9 : 8);
        for (let k = -1; k <= 1; k++) { ui.outline(ix + k * (cell + s(2)) - cell * 0.5, iy - cell * 0.5 - s(4), cell, cell, Math.max(1, s(1.5)), colour); }
        ui.textCentred(f.small, ix, iy + s(10), showBar ? 'BAR ON' : 'BAR OFF', colour);
        continue;
      }
      if (target === WHEEL_UNARMED) {
        // Unarmed: a ring with a slash, lit while no gun is out
        if (hover) { ui.wedge(cx, cy, radius, mid - step * 0.5, mid + step * 0.5, Rgba.hex(0xffffff, 0.16), 10); }
        const colour = hover ? UiTheme.TEXT : session.unarmed ? UiTheme.ACCENT : UiTheme.TEXT_FAINT;
        const r = s(hover ? 10 : 9);
        ui.ring(ix, iy - s(4), r, Math.max(1, s(1.5)), colour, 20);
        ui.line(ix - r * 0.7, iy - s(4) + r * 0.7, ix + r * 0.7, iy - s(4) - r * 0.7, Math.max(1, s(1.5)), colour);
        ui.textCentred(f.small, ix, iy + s(10), 'NONE', colour);
        continue;
      }

      const gun = session.guns[target];
      const current = target === session.activeGun && !session.unarmed;
      if (hover) { ui.wedge(cx, cy, radius, mid - step * 0.5, mid + step * 0.5, Rgba.withAlpha(gun.colour, 0.35), 10); }
      gun.drawIcon(ui, ix, iy, s(hover ? 34 : 28), hover || current ? gun.colour : UiTheme.TEXT_MUTED);
      ui.textCentred(f.small, ix, iy + s(18), gun.key, hover ? gun.colour : UiTheme.TEXT_FAINT);
    }
    ui.ring(cx, cy, radius, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.18), 48);
    ui.circle(cx, cy, inner, Rgba.hex(0x0c0e12, 0.9), 32);

    const middle = cy - f.bold.lineHeight * 0.5;
    if (this.hover === WHEEL_UNARMED) {
      ui.textCentred(f.bold, cx, middle, 'None', UiTheme.TEXT, s(1));
    } else if (this.hover === WHEEL_BAR) {
      ui.textCentred(f.bold, cx, middle, showBar ? 'Hide gun bar' : 'Show gun bar', UiTheme.TEXT, s(1));
    } else {
      const shown = session.guns[this.hover >= 0 ? this.hover : session.activeGun];
      const name = this.hover < 0 && session.unarmed ? 'None' : shown.name;
      ui.textCentred(f.bold, cx, middle, name, this.hover >= 0 ? shown.colour : UiTheme.TEXT_MUTED, s(1));
    }
    ui.textCentred(f.small, cx, cy + radius + s(18), this.byPad ? HINT_PAD.text : HINT_MOUSE.text, UiTheme.TEXT_SOFT);

    // The mouse pointer
    if (!this.byPad) { ui.circle(cx + this.pointerX, cy + this.pointerY, s(4), UiTheme.TEXT, 12); }
  }
}
