import { ShadowQuality, shadowPresetFor } from '../engine/render/ShadowMaps';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { InputAction } from '../core/scene/InputCatalog';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import { LightMode } from './Lights';
import { LocationPicker } from './LocationPicker';
import { Widgets } from './Menus';
import { MONTHS, TIME_STEP, two } from './SunState';
import { UnitFormat } from './UnitFormat';
import { Hints } from './Hints';
import { DOCK_CLOSE, ScrollRegion } from './PanelShell';
import { type SunSettings, weatherDefaults } from '../core/format/DocumentModels';

const QUALITY_OPTIONS = ['Low', 'Medium', 'High'];
const LIGHT_MODE_OPTIONS = ['Off', 'Glow', 'Glow + light'];
const MONTHS_UPPER = MONTHS.map(m => m.toUpperCase());
const SLIDER = {
  time: 10, sun: 11, sky: 12, shadow: 13, glass: 14, lights: 15, bloom: 16,
  clouds: 20, cloudSpeed: 21, sunSize: 22, sunGlare: 23,                                          // sky round
  moonLight: 32, starDensity: 33, starBrightness: 34, starTwinkle: 35, milkyWay: 36,                // W-A
  weather: 37, wetness: 38, snowCover: 39, flash: 31                                              // W-B / W-C
} as const;

/** Sky round / W-A: the sun dock's lower tabs. */
const SUN_TABS = ['LIGHTING', 'SKY', 'NIGHT', 'WEATHER']; // W-B: WEATHER

/** Round W-B / W-C: the WEATHER tab's choices. */
const WEATHER_OPTIONS = ['Off', 'Rain', 'Snow'];
const WEATHER_KINDS = ['off', 'rain', 'snow'] as const;
const LIGHTNING_OPTIONS = ['Rare', 'Sometimes', 'Often'];

/** Round W-A: the moon's phase: real, or a chosen lit fraction (the four chosen phases are drawn as moons). */
const MOON_PHASE_OPTIONS = ['Actual', '', '', '', ''];
const MOON_PHASE_NAMES = ['Actual phase for the date', 'Full', 'Gibbous', 'Half', 'Crescent'];
const MOON_PHASE_VALUES = [0, 1, 0.8, 0.5, 0.2];

type SunSlider = 'sunIntensity' | 'skyIntensity' | 'shadowIntensity' | 'glassTransmission' | 'cloudCover' | 'cloudSpeed' | 'sunSize' | 'sunGlare'
  | 'moonLight' | 'starDensity' | 'starBrightness' | 'starTwinkle' | 'milkyWay' | 'weatherIntensity' | 'wetness' | 'snowCover' | 'lightningFlash';

/**
 * The sun icon and the SUN, SHADOWS & LIGHTS panel (port of the panel half of BimGo.App/Game/GameSession.Sun.cs and
 * the light controls of GameSession.Lights.cs). The mouse is free while it is open; the player stands still.
 */
export class SunPanel {
  open = false;
  /** The location picker (CHANGE…), drawn in the panel's place while open. */
  readonly location: LocationPicker;
  private readonly w: Widgets;
  /** Month / day text boxes: 0 = none focused, 1 = month, 2 = day. */
  private field = 0;
  private fieldText = '';
  /** The open lower tab (0 lighting, 1 sky, 2 night, 3 weather; per session). */
  private tab = 0;
  /** P-A2: the dock's body. */
  private readonly scroll = new ScrollRegion();

  constructor(private readonly session: GameSession) {
    this.w = new Widgets(session);
    this.location = new LocationPicker(session);
  }

  private s(v: number): number { return this.session.s(v); }

  show(): void {
    if (this.open) { return; }
    this.session.closeModes(this); // one panel at a time (the study, the section editor, photo mode)
    this.session.showUi();
    this.open = true;
    this.field = 0;
    this.session.releaseMouseForTyping();
    this.session.sound.play(SoundId.UiClick);
  }

  close(): void {
    if (!this.open) { return; }
    this.commitField();
    this.location.open = false;
    this.open = false;
    this.w.activeSlider = -1;
    this.session.input.releaseAll();
  }

  // #region Keys

  /** Keys while the panel is open (it has the keyboard). */
  updateKeys(input: InputState): void {
    const sun = this.session.sun;
    if (this.location.open) {
      this.location.updateKeys(input);
      return;
    }
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

    if (input.pressed(InputAction.Back) || input.pressed(InputAction.Shadows) || input.pressed(InputAction.SunPanel)) {
      this.close();
      return;
    }
    this.session.stepSunTimeKeys(input);
    if (input.pressed(InputAction.SunPlay)) { this.togglePlay(); }
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

  /**
   * The sun dock (P-A2: the right-hand dock column, the shared header, scrolling body and footer): place, shadows,
   * quality, time, date, daylight saving, then the LIGHTING / SKY / NIGHT tabs. The location picker takes its place.
   */
  build(f: FontAtlas, input: InputState): void {
    const session = this.session, ui = session.ui, w = this.w, shell = session.shell;
    if (!input.leftDown) { w.activeSlider = -1; }
    const pw = this.s(UiTheme.DOCK_WIDTH);

    if (this.location.open) {
      // Its own layout (laid out against its bottom): the column's height up to the old panel's
      const column = shell.dockColumn(pw);
      let top = column.top;
      let lh = Math.min(this.s(624), column.bottom - top);
      if (lh < this.s(560) && session.showMap) {
        top = this.s(UiTheme.COLUMN_MARGIN); // too short under the minimap: over it (it hides)
        shell.dockOverMapNext = true;
        lh = Math.min(this.s(624), column.bottom - top);
      }
      ui.panel(column.x, top, pw, lh, UiTheme.PANEL_STRONG, Rgba.withAlpha(UiTheme.SUN, 0.5));
      this.location.build(f, w, input, column.x, top, pw, lh);
      return;
    }

    // A click anywhere outside a month / day box leaves it
    if (input.leftPressed && this.field !== 0) { this.commitField(); }

    const d = shell.beginDock('SUN, SHADOWS & LIGHTS', UiTheme.SUN_LABEL, Rgba.withAlpha(UiTheme.SUN, 0.5), pw, this.scroll, false);
    let cy = shell.beginDockBody(d, this.scroll, input, w.activeSlider < 0);
    const stay = this.buildBody(f, input, d.ix, cy, d.iw);
    cy = stay.bottom;
    shell.endDockBody(this.scroll, input, cy);
    if (!stay.stay) { return; } // CHANGE… or STUDY… left the dock
    if (shell.endDock(d, null, Hints.sunFoot.text) === DOCK_CLOSE) { this.close(); }
  }

  /** The dock's body from its first line; stay is false when a button left the dock (the location picker, the study). */
  private buildBody(f: FontAtlas, input: InputState, ix: number, cy: number, iw: number): { stay: boolean; bottom: number } {
    const session = this.session, ui = session.ui, w = this.w;
    const sun = session.sun, settings = sun.settings, viewer = session.settings;

    // Place: the location label, CHANGE… and (QOL round) STUDY…
    const changeW = this.s(78), studyW = this.s(70);
    const placeColour = sun.hasOverride ? UiTheme.SUN : sun.locationKnown ? UiTheme.TEXT_MUTED : UiTheme.MEASURE_LABEL;
    ui.textWrapped(f.small, ix, cy + this.s(3), iw - changeW - studyW - this.s(14), sun.placeLabel, placeColour, 1);
    if (w.smallButton(f, ix + iw - changeW, cy - this.s(2), changeW, this.s(22), 'CHANGE…')) {
      this.commitField();
      this.location.show();
      return { stay: false, bottom: cy };
    }
    if (w.smallButton(f, ix + iw - changeW - this.s(6) - studyW, cy - this.s(2), studyW, this.s(22), 'STUDY…')) {
      session.sunHours.show(); // closes this dock (one panel at a time)
      return { stay: false, bottom: cy };
    }
    cy += this.s(26);

    // Shadows on / off + quality
    const enabled = w.checkbox(f, ix, cy + this.s(6), this.s(110), 'Shadows', settings.enabled);
    if (enabled !== settings.enabled) { session.toggleShadows(); }
    const quality = w.segmented(f, ix + this.s(120), cy, iw - this.s(120), QUALITY_OPTIONS, viewer.shadowQuality);
    if (quality !== viewer.shadowQuality) {
      viewer.shadowQuality = quality as ShadowQuality;
      viewer.save();
      session.qualityChosenByUser = true;
      const preset = shadowPresetFor(quality);
      session.toast(`Shadow quality: ${QUALITY_OPTIONS[quality]} (${preset.cascades} × ${preset.size} px, ${UnitFormat.length(preset.distance, 0)})`);
    }
    cy += this.s(46);

    // Time of day: slider (5 min steps, Shift = 1 min) and play / pause
    const shownMinutes = sun.playing ? Math.trunc(sun.playMinutes) : settings.time.minutes;
    const playSize = this.s(28);
    const value = w.slider(f, SLIDER.time, ix, cy, iw - playSize - this.s(10), 'Time of day',
      `${two(Math.trunc(shownMinutes / 60))}:${two(shownMinutes % 60)}`, shownMinutes, 0, 1439);
    if (w.activeSlider === SLIDER.time && input.leftDown) {
      const step = input.down(InputAction.FineAdjust) ? 1 : TIME_STEP;
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
    if (sun.location.autoDaylightSaving) {
      // The chosen place's time zone decides (per date); a click switches to the manual tick
      if (w.smallButton(f, ix + this.s(204), cy, iw - this.s(204), this.s(30), sun.daylightSavingNow ? 'DST AUTO: ON' : 'DST AUTO: OFF')) {
        sun.setAutoDaylightSaving(false);
      }
    } else {
      const zoned = sun.canAutoDaylightSaving;
      const tickW = iw - this.s(204) - (zoned ? this.s(50) : 0);
      const dst = w.checkbox(f, ix + this.s(204), cy + this.s(6), tickW, '+1 h DST', settings.time.daylightSaving);
      if (dst !== settings.time.daylightSaving) {
        settings.time.daylightSaving = dst;
        sun.changed();
      }
      if (zoned && w.smallButton(f, ix + iw - this.s(46), cy, this.s(46), this.s(30), 'AUTO')) { sun.setAutoDaylightSaving(true); }
    }
    cy += this.s(40);

    // Where the sun is
    ui.text(f.small, ix, cy, sun.info(), sun.altitude > 0 ? UiTheme.TEXT_MUTED : UiTheme.MEASURE_LABEL, this.s(0.4));
    cy += this.s(24);

    // Sky round (the tabs' line is the divider): LIGHTING (intensities, lights) · SKY (clouds, the sun disc) · NIGHT
    const tab = w.tabs(f, ix, cy, iw, SUN_TABS, this.tab);
    if (tab !== this.tab) {
      this.tab = tab;
      w.activeSlider = -1;
    }
    cy += this.s(34);
    if (this.tab === 1) { return { stay: true, bottom: this.buildSkyTab(f, ix, cy, iw) }; }
    if (this.tab === 2) { return { stay: true, bottom: this.buildNightTab(f, ix, cy, iw) }; }
    if (this.tab === 3) { return { stay: true, bottom: this.buildWeatherTab(f, ix, cy, iw) }; } // W-B

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
    ui.textRight(f.small, ix + iw, cy + this.s(8), Hints.sunKeys.text, UiTheme.TEXT_FAINT, this.s(0.4));
    return { stay: true, bottom: cy + this.s(28) };
  }

  /** Sky round: the SKY tab: cloud cover and drift, the sun disc's size and glare (a look only), RESET SKY. */
  private buildSkyTab(f: FontAtlas, ix: number, cy: number, iw: number): number {
    const ui = this.session.ui, sun = this.session.sun, settings = sun.settings;
    this.intensity(f, SLIDER.clouds, ix, cy, iw, 'Cloud cover', 'cloudCover', 1);
    cy += this.s(54);
    this.intensity(f, SLIDER.cloudSpeed, ix, cy, iw, 'Cloud drift', 'cloudSpeed', 2);
    cy += this.s(54);
    this.intensity(f, SLIDER.sunSize, ix, cy, iw, 'Sun size', 'sunSize', 2);
    cy += this.s(54);
    this.intensity(f, SLIDER.sunGlare, ix, cy, iw, 'Sun glare', 'sunGlare', 2);
    cy += this.s(54);
    ui.textWrapped(f.small, ix, cy, iw, 'A look only: clouds and the sun disc don\'t change the lighting, shadows or studies. Saved with the model.', UiTheme.TEXT_FAINT, 3);
    cy += this.s(52);
    if (this.w.smallButton(f, ix, cy, this.s(150), this.s(28), 'RESET SKY')) {
      settings.cloudCover = 0;
      settings.cloudSpeed = settings.sunSize = settings.sunGlare = 1;
      sun.changed();
    }
    return cy + this.s(28);
  }

  /** Round W-A: the NIGHT tab: the moon (on / off, phase real or chosen, moonlight) and the stars, RESET NIGHT. */
  private buildNightTab(f: FontAtlas, ix: number, cy: number, iw: number): number {
    const ui = this.session.ui, w = this.w, sun = this.session.sun, settings = sun.settings;
    const moon = w.checkbox(f, ix, cy, iw, 'Moon (its real place in the sky)', settings.moon);
    if (moon !== settings.moon) { settings.moon = moon; sun.changed(); }
    cy += this.s(30);
    ui.text(f.small, ix, cy, sun.moonText(), sun.moonAltitude > 0 ? UiTheme.TEXT_MUTED : UiTheme.TEXT_FAINT, this.s(0.4));
    cy += this.s(24);

    let shown = 0;
    if (settings.moonPhase !== null) {
      const chosen = settings.moonPhase;
      shown = 1;
      for (let i = 2; i < MOON_PHASE_VALUES.length; i++) {
        if (Math.abs(MOON_PHASE_VALUES[i] - chosen) < Math.abs(MOON_PHASE_VALUES[shown] - chosen)) { shown = i; }
      }
    }
    ui.text(f.body, ix, cy, 'Phase', UiTheme.TEXT_SOFT);
    ui.textRight(f.small, ix + iw, cy + this.s(2), MOON_PHASE_NAMES[shown] + (shown > 0 ? ` · ${Math.round(MOON_PHASE_VALUES[shown] * 100)} % lit` : ''), UiTheme.TEXT_MUTED);
    cy += this.s(22);
    const phase = w.segmented(f, ix, cy, iw, MOON_PHASE_OPTIONS, shown);
    const segment = iw / MOON_PHASE_OPTIONS.length;
    for (let i = 1; i < MOON_PHASE_OPTIONS.length; i++) {
      this.drawMoonIcon(ix + segment * (i + 0.5), cy + this.s(16), this.s(8), MOON_PHASE_VALUES[i]);
    }
    if (phase !== shown) {
      settings.moonPhase = phase === 0 ? null : MOON_PHASE_VALUES[phase];
      sun.changed();
    }
    cy += this.s(42);
    this.intensity(f, SLIDER.moonLight, ix, cy, iw, 'Moonlight', 'moonLight', 2);
    cy += this.s(54);

    const stars = w.checkbox(f, ix, cy, iw, 'Stars (turning with the sky)', settings.stars);
    if (stars !== settings.stars) { settings.stars = stars; sun.changed(); }
    cy += this.s(32);
    if (settings.stars) {
      this.intensity(f, SLIDER.starDensity, ix, cy, iw, 'Star density', 'starDensity', 2);
      cy += this.s(54);
      this.intensity(f, SLIDER.starBrightness, ix, cy, iw, 'Star brightness', 'starBrightness', 2);
      cy += this.s(54);
      this.intensity(f, SLIDER.starTwinkle, ix, cy, iw, 'Twinkle', 'starTwinkle', 2);
      cy += this.s(54);
      this.intensity(f, SLIDER.milkyWay, ix, cy, iw, 'Milky Way', 'milkyWay', 2);
      cy += this.s(54);
    }
    ui.textWrapped(f.small, ix, cy, iw,
      'Shows with shadows on once the sun is down. With the sun below the horizon the moon lights the scene and casts the shadows. Saved with the model.',
      UiTheme.TEXT_FAINT, 3);
    cy += this.s(52);
    if (w.smallButton(f, ix, cy, this.s(150), this.s(28), 'RESET NIGHT')) {
      settings.moon = settings.stars = true;
      settings.moonPhase = null;
      settings.moonLight = settings.starDensity = settings.starBrightness = settings.starTwinkle = settings.milkyWay = 1;
      sun.changed();
    }
    return cy + this.s(28);
  }

  /**
   * Round W-B / W-C: the WEATHER tab: off / rain / snow, how hard, the wet look or the settled snow, where the cover map
   * is up to, the lens, the sound and lightning (rain only), RESET WEATHER.
   */
  private buildWeatherTab(f: FontAtlas, ix: number, cy: number, iw: number): number {
    const session = this.session, ui = session.ui, w = this.w, sun = session.sun, settings = sun.settings;
    const kind = WEATHER_KINDS.indexOf(settings.weather);
    const chosen = w.segmented(f, ix, cy, iw, WEATHER_OPTIONS, kind);
    if (chosen !== kind) {
      settings.weather = WEATHER_KINDS[chosen];
      w.activeSlider = -1;
      sun.changed();
    }
    cy += this.s(42);

    if (sun.weatherOn) {
      const raining = settings.weather === 'rain';
      this.intensity(f, SLIDER.weather, ix, cy, iw, raining ? 'Rainfall' : 'Snowfall', 'weatherIntensity', 1);
      cy += this.s(54);
      if (raining) { this.intensity(f, SLIDER.wetness, ix, cy, iw, 'Wet look', 'wetness', 1); }
      else { this.intensity(f, SLIDER.snowCover, ix, cy, iw, 'Settled snow', 'snowCover', 1); }
      cy += this.s(54);
      const weather = session.weather;
      ui.textWrapped(f.small, ix, cy, iw, weather.status(), weather.error !== null ? UiTheme.MEASURE_LABEL : UiTheme.TEXT_MUTED, 2);
      cy += this.s(40);

      // W-C: the lens, the sound, lightning (rain only)
      const drops = w.checkbox(f, ix, cy, iw, raining ? 'Drops on the lens (outdoors)' : 'Flakes on the lens (outdoors)', settings.lensDrops);
      if (drops !== settings.lensDrops) { settings.lensDrops = drops; sun.changed(); }
      cy += this.s(30);
      if (raining) {
        const sound = w.checkbox(f, ix, cy, iw, 'Rain sound and thunder', settings.weatherSound);
        if (sound !== settings.weatherSound) { settings.weatherSound = sound; sun.changed(); }
        cy += this.s(30);
        const lightning = w.checkbox(f, ix, cy, iw, 'Lightning', settings.lightning);
        if (lightning !== settings.lightning) {
          settings.lightning = lightning;
          sun.changed();
          if (lightning) { session.toast('Lightning on · at most three flashes a second; Reduce flashing turns them into slow glows', 5); }
        }
        cy += this.s(32);
        if (settings.lightning) {
          const frequency = w.segmented(f, ix, cy, iw, LIGHTNING_OPTIONS, Math.min(Math.max(settings.lightningFrequency, 0), 2));
          if (frequency !== settings.lightningFrequency) { settings.lightningFrequency = frequency; sun.changed(); }
          cy += this.s(42);
          this.intensity(f, SLIDER.flash, ix, cy, iw, 'Flash on the scene', 'lightningFlash', 1);
          cy += this.s(54);
          const reduce = w.checkbox(f, ix, cy, iw, 'Reduce flashing (slow glows only)', settings.reduceFlashing);
          if (reduce !== settings.reduceFlashing) { settings.reduceFlashing = reduce; sun.changed(); }
          cy += this.s(30);
          ui.textWrapped(f.small, ix, cy, iw,
            'Flickers are kept to three a second at most and fade in and out. If flashing lights bother you, tick Reduce flashing.', UiTheme.TEXT_FAINT, 3);
          cy += this.s(52);
        }
      }
    }
    ui.textWrapped(f.small, ix, cy, iw,
      'Shows in the classic light too; with shadows on the clouds thicken and the light dims. The wind follows the cloud drift (SKY). Saved with the model.',
      UiTheme.TEXT_FAINT, 4);
    cy += this.s(66);
    if (w.smallButton(f, ix, cy, this.s(150), this.s(28), 'RESET WEATHER')) {
      Object.assign(settings, weatherDefaults());
      sun.changed();
    }
    return cy + this.s(28);
  }

  /** Round W-A: a small moon at a lit fraction (lit on the right): the dark disc, then the lit part row by row. */
  private drawMoonIcon(cx: number, cy: number, r: number, lit: number): void {
    const ui = this.session.ui;
    ui.circle(cx, cy, r, Rgba.hex(0x000000, 0.45), 24);
    const light = Rgba.hex(0xf3f0e4);
    const step = Math.max(1, ui.scale);
    const k = Math.min(Math.max(lit, 0), 1);
    for (let y = -r + step * 0.5; y < r; y += step) {
      const half = Math.sqrt(Math.max(r * r - y * y, 0));
      const from = half * (1 - 2 * k);
      if (half - from > 0.25) { ui.rect(cx + from, cy + y - step * 0.5, half - from, step, light); }
    }
  }

  private intensity(f: FontAtlas, id: number, x: number, y: number, w: number, label: string, key: SunSlider, max: number): void {
    const sun = this.session.sun;
    const settings = sun.settings as SunSettings & Record<SunSlider, number>;
    const value = settings[key];
    const result = Math.round(this.w.slider(f, id, x, y, w, label, `${Math.round(value * 100)} %`, value, 0, max) * 20) / 20; // 5 % steps
    if (Math.abs(result - value) > 1e-4) {
      settings[key] = key === 'sunSize' ? Math.max(result, 0.25) : result;
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
