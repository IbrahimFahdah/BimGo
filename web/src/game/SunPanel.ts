import { ShadowQuality, shadowPresetFor } from '../engine/render/ShadowMaps';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import { LightMode } from './Lights';
import { Widgets } from './Menus';
import { MONTHS, TIME_STEP, two } from './SunState';

const QUALITY_OPTIONS = ['Low', 'Medium', 'High'];
const LIGHT_MODE_OPTIONS = ['Off', 'Glow', 'Glow + light'];
const MONTHS_UPPER = MONTHS.map(m => m.toUpperCase());
const SLIDER = { time: 10, sun: 11, sky: 12, shadow: 13, glass: 14, lights: 15, bloom: 16 } as const;

/**
 * The sun icon and the SUN, SHADOWS & LIGHTS panel (port of the panel half of BimGo.App/Game/GameSession.Sun.cs and
 * the light controls of GameSession.Lights.cs). The mouse is free while it is open; the player stands still.
 */
export class SunPanel {
  open = false;
  private readonly w: Widgets;
  /** Month / day text boxes: 0 = none focused, 1 = month, 2 = day. */
  private field = 0;
  private fieldText = '';

  constructor(private readonly session: GameSession) {
    this.w = new Widgets(session);
  }

  private s(v: number): number { return this.session.s(v); }

  show(): void {
    if (this.open) { return; }
    this.open = true;
    this.field = 0;
    this.session.releaseMouseForTyping();
    this.session.sound.play(SoundId.UiClick);
  }

  close(): void {
    if (!this.open) { return; }
    this.commitField();
    this.open = false;
    this.w.activeSlider = -1;
    this.session.input.releaseAll();
  }

  // #region Keys

  /** Keys while the panel is open (it has the keyboard). */
  updateKeys(input: InputState): void {
    const sun = this.session.sun;
    if (this.field !== 0) {
      for (const c of input.typed) {
        if (c >= '0' && c <= '9') { this.fieldText = (this.fieldText.length >= 2 ? '' : this.fieldText) + c; }
      }
      if (input.isPressedOrRepeated(Vk.BACK)) { this.fieldText = this.fieldText.slice(0, -1); }
      if (input.isPressed(Vk.RETURN) || input.isPressed(Vk.TAB)) {
        const next = input.isPressed(Vk.TAB) && this.field === 1 ? 2 : 0;
        this.commitField();
        if (next !== 0) { this.focusField(next); }
        return;
      }
      if (input.isPressed(Vk.ESCAPE)) {
        this.field = 0;
        return;
      }
      if (input.isPressedOrRepeated(Vk.UP) || input.isPressedOrRepeated(Vk.DOWN)) {
        const delta = input.isPressedOrRepeated(Vk.UP) ? 1 : -1;
        const field = this.field;
        this.commitField();
        if (field === 1) { sun.settings.time.month = (sun.settings.time.month - 1 + delta + 12) % 12 + 1; }
        else { sun.settings.time.day += delta; }
        sun.changed();
        this.focusField(field);
      }
      return;
    }

    if (input.isPressed(Vk.ESCAPE) || input.isPressed(Vk.key('O'))) {
      this.close();
      return;
    }
    if (input.isPressedOrRepeated(Vk.OEM_4)) { this.session.stepSunTime(input.isDown(Vk.SHIFT) ? -1 : -TIME_STEP); }
    if (input.isPressedOrRepeated(Vk.OEM_6)) { this.session.stepSunTime(input.isDown(Vk.SHIFT) ? 1 : TIME_STEP); }
    if (input.isPressed(Vk.SPACE)) { this.togglePlay(); }
  }

  private togglePlay(): void {
    this.session.sun.togglePlay();
    this.session.sound.play(SoundId.UiClick);
  }

  private focusField(field: number): void {
    this.field = field;
    const t = this.session.sun.settings.time;
    this.fieldText = String(field === 1 ? t.month : t.day);
  }

  private commitField(): void {
    if (this.field === 0) { return; }
    const field = this.field;
    this.field = 0;
    if (!this.fieldText) { return; }
    const value = Number(this.fieldText);
    const t = this.session.sun.settings.time;
    if (field === 1) { t.month = Math.min(Math.max(value, 1), 12); } else { t.day = Math.max(value, 1); }
    this.session.sun.changed(); // clamps the day to the month
  }

  // #endregion

  // #region Icon

  private iconRect(): { x: number; y: number; size: number } {
    const size = this.s(52);
    return { x: this.session.screenWidth - this.s(20) - size, y: this.session.screenHeight - this.s(20) - size, size };
  }

  hoverIcon(input: InputState): boolean {
    const { x, y, size } = this.iconRect();
    return input.mouseX >= x && input.mouseX < x + size && input.mouseY >= y && input.mouseY < y + size;
  }

  buildIcon(f: FontAtlas, input: InputState): void {
    const ui = this.session.ui;
    const { x, y, size } = this.iconRect();
    const on = this.session.sun.enabled;
    const hover = !this.session.isCaptured && this.hoverIcon(input);
    const colour = on ? UiTheme.SUN : hover ? UiTheme.TEXT : UiTheme.TEXT_MUTED;

    ui.rect(x, y, size, size, Rgba.hex(0x0c0e12, this.open || hover ? 0.9 : 0.6));
    ui.outline(x, y, size, size, this.s(2), this.open ? UiTheme.SUN : Rgba.hex(0xffffff, 0.14));
    const cx = x + size * 0.5, cy = y + size * 0.5 + this.s(2);
    ui.circle(cx, cy, this.s(7), colour, 16);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, c = Math.cos(a), s = Math.sin(a);
      ui.line(cx + c * this.s(10), cy + s * this.s(10), cx + c * this.s(14), cy + s * this.s(14), this.s(2), colour);
    }
    ui.text(f.small, x + this.s(5), y + this.s(3), 'O', on ? UiTheme.SUN : UiTheme.TEXT_FAINT);

    // Clicks only reach here while the cursor is free (panel open): the icon closes the panel
    if (this.open && hover && input.leftPressed) {
      input.consumeClicks();
      this.close();
    }
  }

  // #endregion

  // #region Panel

  build(f: FontAtlas, input: InputState): void {
    const session = this.session, ui = session.ui, w = this.w;
    const sun = session.sun, settings = sun.settings, viewer = session.settings;
    if (!input.leftDown) { w.activeSlider = -1; }

    const pw = this.s(340), ph = this.s(600);
    const icon = this.iconRect();
    const x = session.screenWidth - this.s(20) - pw;
    const y = Math.max(this.s(20), icon.y - this.s(10) - ph);
    ui.panel(x, y, pw, ph, UiTheme.PANEL_STRONG, Rgba.withAlpha(UiTheme.SUN, 0.5));

    // A click anywhere outside a month / day box leaves it
    if (input.leftPressed && this.field !== 0) { this.commitField(); }

    const ix = x + this.s(16), iw = pw - this.s(32);
    let cy = y + this.s(14);

    // Header
    ui.text(f.small, ix, cy, 'SUN, SHADOWS & LIGHTS', UiTheme.SUN_LABEL, this.s(2));
    ui.textRight(f.small, ix + iw, cy, 'ESC · O CLOSE', UiTheme.TEXT_FAINT, this.s(0.6));
    cy += this.s(22);
    ui.textWrapped(f.small, ix, cy, iw, sun.placeLabel, sun.locationKnown ? UiTheme.TEXT_MUTED : UiTheme.MEASURE_LABEL, 1);
    cy += this.s(24);

    // Shadows on / off + quality
    const enabled = w.checkbox(f, ix, cy + this.s(6), this.s(110), 'Shadows', settings.enabled);
    if (enabled !== settings.enabled) { session.toggleShadows(); }
    const quality = w.segmented(f, ix + this.s(120), cy, iw - this.s(120), QUALITY_OPTIONS, viewer.shadowQuality);
    if (quality !== viewer.shadowQuality) {
      viewer.shadowQuality = quality as ShadowQuality;
      viewer.save();
      session.qualityChosenByUser = true;
      const preset = shadowPresetFor(quality);
      session.toast(`Shadow quality: ${QUALITY_OPTIONS[quality]} (${preset.cascades} × ${preset.size} px, ${preset.distance} m)`);
    }
    cy += this.s(46);

    // Time of day: slider (5 min steps, Shift = 1 min) and play / pause
    const shownMinutes = sun.playing ? Math.trunc(sun.playMinutes) : settings.time.minutes;
    const playSize = this.s(28);
    const value = w.slider(f, SLIDER.time, ix, cy, iw - playSize - this.s(10), 'Time of day',
      `${two(Math.trunc(shownMinutes / 60))}:${two(shownMinutes % 60)}`, shownMinutes, 0, 1439);
    if (w.activeSlider === SLIDER.time && input.leftDown) {
      const step = input.isDown(Vk.SHIFT) ? 1 : TIME_STEP;
      const minutes = Math.min(Math.max(Math.round(value / step) * step, 0), 1439);
      sun.playing = false;
      if (minutes !== settings.time.minutes) {
        settings.time.minutes = minutes;
        sun.changed();
      }
    }
    if (this.playButton(input, ix + iw - playSize, cy + this.s(16), playSize)) { this.togglePlay(); }
    cy += this.s(56);

    // Date: month / day boxes (type, Enter / Tab; ↑ ↓ step) and daylight saving
    ui.text(f.body, ix, cy + this.s(6), 'Date', UiTheme.TEXT);
    if (this.numberBox(f, input, ix + this.s(52), cy, this.s(48), 1, settings.time.month)) { this.focusField(1); }
    ui.text(f.small, ix + this.s(106), cy + this.s(8), MONTHS_UPPER[Math.min(Math.max(settings.time.month, 1), 12) - 1], UiTheme.TEXT_MUTED);
    if (this.numberBox(f, input, ix + this.s(142), cy, this.s(48), 2, settings.time.day)) { this.focusField(2); }
    const dst = w.checkbox(f, ix + this.s(204), cy + this.s(6), iw - this.s(204), '+1 h DST', settings.time.daylightSaving);
    if (dst !== settings.time.daylightSaving) {
      settings.time.daylightSaving = dst;
      sun.changed();
    }
    cy += this.s(40);

    // Where the sun is
    ui.text(f.small, ix, cy, sun.info(), sun.altitude > 0 ? UiTheme.TEXT_MUTED : UiTheme.MEASURE_LABEL, this.s(0.4));
    cy += this.s(24);
    ui.rect(ix, cy, iw, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.1));
    cy += this.s(12);

    // Intensities
    this.intensity(f, SLIDER.sun, ix, cy, iw, 'Sunlight', 'sunIntensity', 2);
    cy += this.s(54);
    this.intensity(f, SLIDER.sky, ix, cy, iw, 'Sky / diffuse light', 'skyIntensity', 2);
    cy += this.s(54);
    this.intensity(f, SLIDER.shadow, ix, cy, iw, 'Shadow intensity', 'shadowIntensity', 1);
    cy += this.s(54);
    this.intensity(f, SLIDER.glass, ix, cy, iw, 'Light through glass', 'glassTransmission', 2);
    cy += this.s(54);

    // Artificial lights (saved with the browser's settings, not the model)
    cy += this.buildLightControls(f, ix, cy, iw);

    if (w.smallButton(f, ix, cy, this.s(150), this.s(28), 'RESET LIGHTING')) {
      settings.sunIntensity = settings.skyIntensity = settings.shadowIntensity = settings.glassTransmission = 1;
      viewer.lightIntensity = viewer.bloomIntensity = 1;
      viewer.save();
      sun.changed();
    }
    ui.textRight(f.small, ix + iw, cy + this.s(8), '[ ] TIME · SPACE PLAY', UiTheme.TEXT_FAINT, this.s(0.4));
  }

  private intensity(f: FontAtlas, id: number, x: number, y: number, w: number, label: string,
    key: 'sunIntensity' | 'skyIntensity' | 'shadowIntensity' | 'glassTransmission', max: number): void {
    const sun = this.session.sun;
    const value = sun.settings[key];
    const result = Math.round(this.w.slider(f, id, x, y, w, label, `${Math.round(value * 100)} %`, value, 0, max) * 20) / 20; // 5 % steps
    if (Math.abs(result - value) > 1e-4) {
      sun.settings[key] = result;
      sun.changed();
    }
  }

  private buildLightControls(f: FontAtlas, x: number, y: number, w: number): number {
    const session = this.session, ui = session.ui, viewer = session.settings;
    const top = y;
    ui.text(f.body, x, y + this.s(6), 'Lights', session.lights.hasAny ? UiTheme.TEXT : UiTheme.TEXT_MUTED);
    const mode = this.w.segmented(f, x + this.s(64), y, w - this.s(64), LIGHT_MODE_OPTIONS, viewer.lightMode);
    if (mode !== viewer.lightMode) {
      if (session.lights.hasAny) { session.setLightMode(mode as LightMode); } else { session.cycleLightMode(); }
    }
    y += this.s(46);

    // Brightness and bloom side by side (keeps the panel's height)
    const half = (w - this.s(16)) * 0.5;
    const light = Math.round(this.w.slider(f, SLIDER.lights, x, y, half, 'Light', `${Math.round(viewer.lightIntensity * 100)} %`, viewer.lightIntensity, 0, 2) * 20) / 20;
    const bloom = Math.round(this.w.slider(f, SLIDER.bloom, x + half + this.s(16), y, half, 'Bloom', `${Math.round(viewer.bloomIntensity * 100)} %`, viewer.bloomIntensity, 0, 2) * 20) / 20;
    if (light !== viewer.lightIntensity || bloom !== viewer.bloomIntensity) {
      viewer.lightIntensity = light;
      viewer.bloomIntensity = bloom;
      viewer.save();
    }
    y += this.s(54);
    return y - top;
  }

  private numberBox(f: FontAtlas, input: InputState, x: number, y: number, w: number, field: number, value: number): boolean {
    const ui = this.session.ui;
    const h = this.s(30);
    const focused = this.field === field;
    const hover = this.w.hover(x, y, w, h);
    ui.rect(x, y, w, h, focused ? Rgba.hex(0xffffff, 0.08) : UiTheme.CONTROL);
    ui.outline(x, y, w, h, Math.max(1, ui.scale), focused ? UiTheme.SUN : hover ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);

    const textY = y + h * 0.5 - f.mono.lineHeight * 0.5;
    if (focused) {
      const used = ui.text(f.mono, x + this.s(10), textY, this.fieldText, UiTheme.TEXT);
      if (this.session.clock % 1 < 0.55) { ui.rect(x + this.s(11) + used, y + this.s(7), this.s(1.5), h - this.s(14), UiTheme.SUN); }
    } else {
      ui.text(f.mono, x + this.s(10), textY, two(value), UiTheme.TEXT);
    }

    const clicked = hover && input.leftPressed;
    if (clicked) {
      input.consumeClicks();
      this.session.sound.play(SoundId.UiClick);
    }
    return clicked;
  }

  private playButton(input: InputState, x: number, y: number, size: number): boolean {
    const ui = this.session.ui, sun = this.session.sun;
    const hover = this.w.hover(x, y, size, size);
    const enabled = sun.enabled;
    const colour = !enabled ? UiTheme.TEXT_FAINT : hover || sun.playing ? UiTheme.SUN : UiTheme.TEXT;
    ui.rect(x, y, size, size, hover && enabled ? Rgba.hex(0xffffff, 0.1) : UiTheme.CONTROL);
    ui.outline(x, y, size, size, Math.max(1, ui.scale), UiTheme.CONTROL_BORDER);

    const cx = x + size * 0.5, cy = y + size * 0.5, r = size * 0.26;
    if (sun.playing) {
      ui.rect(cx - r, cy - r, r * 0.7, r * 2, colour);
      ui.rect(cx + r * 0.3, cy - r, r * 0.7, r * 2, colour);
    } else {
      ui.triangle(cx - r * 0.8, cy - r, cx - r * 0.8, cy + r, cx + r, cy, colour);
    }

    const clicked = enabled && hover && input.leftPressed;
    if (clicked) { input.consumeClicks(); }
    return clicked;
  }

  // #endregion
}
