import { MaterialOverrides } from '../core/scene/MaterialOverrides';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import type { InputState } from '../platform/input';
import type { GameSession } from './GameSession';
import type { Widgets } from './Menus';
import { ColourMode, cleanLookScale, cleanWaveScale, GrassLimits, LookLimits } from './ViewerSettings';

/** Colour-by modes: off, reflection tiers, reflection probe cells (not saved). */
const COLOUR_BY_OPTIONS = ['Off', 'Reflection', 'Probes'];
/** Grass round: the water colour presets' labels. */
const WATER_COLOUR_OPTIONS = MaterialOverrides.WATER_PRESETS.map(p => p[0]);
/** Grass round: blade densities. */
const GRASS_DENSITY_OPTIONS = ['Low', 'Medium', 'High'];
/** Longest keyword list typed in the session. */
const MAX_KEYWORD_TEXT = 200;
/** Slider ids (unique across the menu's sliders). */
const SLIDER = { waterReflect: 24, grassHeight: 25, grassDistance: 26, waterRipple: 27, waterSpeed: 28, grassSway: 29, waveScale: 30 } as const;
/** How much a picked water colour replaces the material's (a little of a texture's pattern stays). */
const WATER_TINT_AMOUNT = 0.85;

/**
 * QOL round: the pause menu's Appearance tab (was Debug; port of GameSession.Appearance.cs): colour by (reflection
 * tier, probe; colour round A: the Colour profiles row opens the COLOUR PROFILES panel) and the material overrides
 * (water by Revit asset / keywords; grass round: WATER and GRASS sub-pages). The water rule and look are per browser
 * (the viewer settings). Glass keywords are baked into the geometry at Go / Export, so they're set in Revit's Options.
 */
export class Appearance {
  /** Grass round: the tab's page: 0 main, 1 water, 2 grass (per session). */
  page = 0;
  /** Water round W: the ripples' clock (advanced at the ripple speed). */
  private waterClock = 0;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  // #region Water rule and look

  /** Passes the water rule to the renderer (before the materials load: sets the rule; after: rebuilds the table). */
  applyWaterOverride(): void {
    const v = this.session.settings;
    this.session.renderer.setWaterOverride(v.waterFromAsset, v.waterKeywords, v.waterKeywordsOpaque);
    this.applyWaterLook();
  }

  /** Grass round / water round W: water's colour, reflection, ripples and wave size for the renderer (uniforms). */
  applyWaterLook(): void {
    const v = this.session.settings, renderer = this.session.renderer;
    const hex = v.waterColour.replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      const rgb = parseInt(hex, 16);
      renderer.waterTint = [((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255, WATER_TINT_AMOUNT];
    } else {
      renderer.waterTint = [0, 0, 0, 0];
    }
    renderer.waterReflect = v.waterReflection;
    renderer.waterWaves = v.waterRipple;
    renderer.waveScale = v.waterWaveScale;
  }

  /** Water round W: once a frame, moves the ripples' clock on at the ripple speed (wrapped every hour of water time). */
  advanceWater(dt: number): void {
    this.waterClock += dt * this.session.settings.waterRippleSpeed;
    if (this.waterClock > 3600) { this.waterClock -= 3600; }
    this.session.renderer.waterClock = this.waterClock;
  }

  /** The water rule changed: rebuilds the material table and says how many materials are water now. */
  private waterOverrideChanged(): void {
    this.session.settings.save();
    this.applyWaterOverride();
    const renderer = this.session.renderer;
    if (!renderer.hasMaterials) {
      this.session.toast('Saved for next time: water overrides need a file with materials (Extract materials and textures in Revit).', 4);
      return;
    }
    this.session.toast(`Water materials: ${renderer.waterMaterialCount}`, 2);
  }

  // #endregion

  // #region Appearance tab

  /** The Appearance tab (was Debug): colour by, then the material overrides (water and grass on their own pages). */
  buildTab(f: FontAtlas, w: Widgets, input: InputState, ix: number, y: number, iw: number): number {
    if (this.page === 1) { return this.buildWaterPage(f, w, input, ix, y, iw); }
    if (this.page === 2) { return this.buildGrassPage(f, w, input, ix, y, iw); }
    const session = this.session, ui = session.ui, v = session.settings, renderer = session.renderer;

    // ---- Colour by (debug colours; colour round A: colour profiles, their own panel)
    ui.text(f.small, ix, y, 'COLOUR BY', UiTheme.TEXT_MUTED, this.s(1.8));
    const mode = w.segmented(f, ix, y + this.s(20), iw, COLOUR_BY_OPTIONS, session.reflections.debug);
    if (mode !== session.reflections.debug) {
      session.reflections.debug = mode;
      if (mode !== 0 && (v.colour !== ColourMode.Realistic || !renderer.hasMaterials)) {
        session.toast('Colour by reflection / probe needs the Realistic colour mode and a file with materials.', 4);
      }
    }
    y += this.s(60);
    const help = session.reflections.debug === 1 ? 'Red 75 %+, orange 50 %, yellow 25 %, grey none, cyan glass, blue water.'
      : session.reflections.debug === 2 ? 'One colour per reflection probe, blended at room edges; grey = sky.'
        : 'Colours surfaces by reflection tier or probe (Realistic mode). Not saved.';
    y += ui.textWrapped(f.small, ix, y, iw, help, UiTheme.TEXT_MUTED, 3) + this.s(6);
    if (this.pageRow(f, w, input, ix, y, iw, 'Colour profiles', session.profiles.summary())) {
      session.sound.play(SoundId.UiClick);
      session.profiles.openPanel();
      return y;
    }
    y += this.s(44);

    // ---- Material overrides
    ui.text(f.small, ix, y, 'MATERIAL OVERRIDES', UiTheme.TEXT_MUTED, this.s(1.8));
    y += this.s(26);
    const preset = MaterialOverrides.waterPresetIndex(v.waterColour);
    let water = renderer.hasMaterials ? `${renderer.waterMaterialCount} · ` : '';
    water += `${preset >= 0 ? WATER_COLOUR_OPTIONS[preset] : v.waterColour} · ${Math.round(v.waterReflection * 100)} %`;
    if (v.waterRipple <= 0) { water += ' · still'; }
    if (this.pageRow(f, w, input, ix, y, iw, 'Water', water)) { this.openPage(1); }
    y += this.s(30);
    const grass = !v.grassBlades ? 'Off' : `${GRASS_DENSITY_OPTIONS[Math.min(Math.max(v.grassDensity, 0), 2)]} · ${v.grassHeightMm} mm · ${v.grassDistance} m`;
    if (this.pageRow(f, w, input, ix, y, iw, 'Grass blades', grass)) { this.openPage(2); }
    y += this.s(34);

    // Glass is baked into the geometry at Go / Export (Revit's Options window), so the browser only explains it
    ui.text(f.body, ix, y, 'Glass keywords', UiTheme.TEXT_MUTED);
    y += this.s(22);
    y += ui.textWrapped(f.small, ix, y, iw, 'Set in Revit\'s Options (Materials): see-through is baked into the geometry at Go / Export.', UiTheme.TEXT_FAINT, 2);
    return y + this.s(8);
  }

  /** Grass round: switches the tab to a page (0 main, 1 water, 2 grass). */
  openPage(page: number): void {
    this.page = page;
    this.session.menu.widgets.activeSlider = -1;
    this.session.sound.play(SoundId.UiClick);
  }

  /** A page's heading with BACK on the right; returns the y below it. */
  private pageHeader(f: FontAtlas, w: Widgets, x: number, y: number, width: number, title: string): number {
    this.session.ui.text(f.small, x, y + this.s(4), title, UiTheme.ACCENT, this.s(1.8));
    if (w.smallButton(f, x + width - this.s(70), y, this.s(70), this.s(24), '‹ BACK')) { this.openPage(0); }
    return y + this.s(36);
  }

  /** A label with a summary on the right and a chevron; true when clicked. */
  private pageRow(f: FontAtlas, w: Widgets, input: InputState, x: number, y: number, width: number, label: string, summary: string): boolean {
    const ui = this.session.ui;
    const hover = w.hover(x, y - this.s(4), width, this.s(26));
    if (hover) { ui.rect(x - this.s(4), y - this.s(4), width + this.s(8), this.s(26), Rgba.hex(0xffffff, 0.06)); }
    ui.text(f.body, x, y, label, hover ? UiTheme.ACCENT : UiTheme.TEXT);
    ui.textRight(f.small, x + width - this.s(16), y + this.s(2), summary, Rgba.hex(0x67e8f9));
    ui.text(f.body, x + width - this.s(10), y, '›', hover ? UiTheme.ACCENT : UiTheme.TEXT_MUTED);
    if (hover && input.leftPressed) {
      input.consumeClicks();
      return true;
    }
    return false;
  }

  /** A label with its keyword list (shortened to fit) on the right; true when clicked. */
  private keywordRow(f: FontAtlas, w: Widgets, input: InputState, x: number, y: number, width: number, label: string, keywords: readonly string[]): boolean {
    const ui = this.session.ui;
    const hover = w.hover(x, y - this.s(3), width, this.s(24));
    const labelW = ui.text(f.body, x, y, label, hover ? UiTheme.ACCENT : UiTheme.TEXT);
    let value = keywords.length === 0 ? 'none' : MaterialOverrides.formatKeywords(keywords);
    const room = width - labelW - this.s(12);
    if (UiBatch.measure(f.small, value) > room) {
      let n = value.length;
      while (n > 1 && UiBatch.measure(f.small, value.slice(0, n)) + UiBatch.measure(f.small, '...') > room) { n--; }
      value = value.slice(0, n) + '...';
    }
    ui.textRight(f.small, x + width, y + this.s(2), value, keywords.length === 0 ? UiTheme.TEXT_FAINT : Rgba.hex(0x67e8f9));
    if (hover && input.leftPressed) {
      input.consumeClicks();
      this.session.sound.play(SoundId.UiClick);
      return true;
    }
    return false;
  }

  /** Grass round: the WATER page: which materials are water, its colour, reflection, ripples and wave size. */
  private buildWaterPage(f: FontAtlas, w: Widgets, input: InputState, ix: number, y: number, iw: number): number {
    const session = this.session, ui = session.ui, v = session.settings, renderer = session.renderer;
    y = this.pageHeader(f, w, ix, y, iw, 'WATER');
    const fromAsset = w.checkbox(f, ix, y, iw, 'Water from Revit asset', v.waterFromAsset);
    if (fromAsset !== v.waterFromAsset) {
      v.waterFromAsset = fromAsset;
      this.waterOverrideChanged();
    }
    y += this.s(28);
    if (this.keywordRow(f, w, input, ix, y, iw, 'Water keywords', v.waterKeywords)) {
      session.editor.beginCustom('WATER KEYWORDS (COMMA SEPARATED)', MaterialOverrides.formatKeywords(v.waterKeywords), MAX_KEYWORD_TEXT, text => {
        v.waterKeywords = MaterialOverrides.parseKeywords(text);
        this.waterOverrideChanged();
      });
    }
    y += this.s(28);
    const opaque = w.checkbox(f, ix, y, iw, 'Keywords match opaque too', v.waterKeywordsOpaque);
    if (opaque !== v.waterKeywordsOpaque) {
      v.waterKeywordsOpaque = opaque;
      this.waterOverrideChanged();
    }
    y += this.s(36);

    // Colour: Revit's (the material's own) or a preset; CUSTOM… types a hex colour
    ui.text(f.body, ix, y, 'Colour', UiTheme.TEXT);
    const hex = v.waterColour.replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      ui.rect(ix + this.s(62), y + this.s(1), this.s(28), this.s(16), Rgba.hex(parseInt(hex, 16)));
      ui.outline(ix + this.s(62), y + this.s(1), this.s(28), this.s(16), Math.max(1, ui.scale), UiTheme.CONTROL_BORDER);
    }
    if (w.smallButton(f, ix + iw - this.s(84), y - this.s(4), this.s(84), this.s(24), 'CUSTOM…')) {
      session.editor.beginCustom('WATER COLOUR (#RRGGBB, EMPTY = THE MATERIAL\'S OWN)', v.waterColour, 7, text => {
        const value = (text ?? '').trim();
        if (value.length === 0) { this.setWaterColour(''); }
        else if (/^#?[0-9a-fA-F]{6}$/.test(value)) { this.setWaterColour('#' + value.replace(/^#/, '').toUpperCase()); }
        else { session.toast('Type a colour as #RRGGBB (e.g. #3B9AA6), or leave it empty for the material\'s own', 4); }
      });
    }
    const preset = MaterialOverrides.waterPresetIndex(v.waterColour);
    const picked = w.segmented(f, ix, y + this.s(24), iw, WATER_COLOUR_OPTIONS, preset);
    if (picked !== preset && picked >= 0) { this.setWaterColour(MaterialOverrides.WATER_PRESETS[picked][1]); }
    y += this.s(68);

    // Two sliders a row: reflection | ripples, ripple speed | wave size
    const half = (iw - this.s(16)) * 0.5, ix2 = ix + half + this.s(16);
    const reflect = Math.round(w.slider(f, SLIDER.waterReflect, ix, y, half, 'Reflection', `${Math.round(v.waterReflection * 100)} %`, v.waterReflection, 0, 1) * 20) / 20;
    if (Math.abs(reflect - v.waterReflection) > 1e-4) {
      v.waterReflection = reflect;
      v.save();
      this.applyWaterLook();
    }
    const ripple = cleanLookScale(w.slider(f, SLIDER.waterRipple, ix2, y, half, 'Ripples', v.waterRipple <= 0 ? 'Still' : `${Math.round(v.waterRipple * 100)} %`,
      v.waterRipple, 0, LookLimits.MAX_LOOK_SCALE));
    if (Math.abs(ripple - v.waterRipple) > 1e-4) {
      v.waterRipple = ripple;
      v.save();
      this.applyWaterLook();
    }
    y += this.s(58);
    const speed = cleanLookScale(w.slider(f, SLIDER.waterSpeed, ix, y, half, 'Ripple speed', v.waterRippleSpeed <= 0 ? 'Paused' : `${Math.round(v.waterRippleSpeed * 100)} %`,
      v.waterRippleSpeed, 0, LookLimits.MAX_LOOK_SCALE));
    if (Math.abs(speed - v.waterRippleSpeed) > 1e-4) { v.waterRippleSpeed = speed; v.save(); }
    const scale = cleanWaveScale(w.slider(f, SLIDER.waveScale, ix2, y, half, 'Wave size', `${Math.round(v.waterWaveScale * 100)} %`, v.waterWaveScale,
      LookLimits.MIN_WAVE_SCALE, LookLimits.MAX_WAVE_SCALE));
    if (Math.abs(scale - v.waterWaveScale) > 1e-4) {
      v.waterWaveScale = scale;
      v.save();
      this.applyWaterLook();
    }
    y += this.s(58);
    const note = !renderer.hasMaterials ? 'Needs a file with materials (Realistic).' : `${renderer.waterMaterialCount} water materials. Less reflection shows more of the colour.`;
    y += ui.textWrapped(f.small, ix, y, iw, note, UiTheme.TEXT_FAINT, 3);
    return y;
  }

  /** Grass round: a new water colour (#RRGGBB or empty), shown at once. */
  private setWaterColour(hex: string): void {
    this.session.settings.waterColour = hex ?? '';
    this.session.settings.save();
    this.applyWaterLook();
    this.session.sound.play(SoundId.UiClick);
  }

  /** Grass round: the GRASS page: blades on / off, density, height, distance, sway, keywords and what was found. */
  private buildGrassPage(f: FontAtlas, w: Widgets, input: InputState, ix: number, y: number, iw: number): number {
    const session = this.session, ui = session.ui, v = session.settings;
    y = this.pageHeader(f, w, ix, y, iw, 'GRASS BLADES');
    const on = w.checkbox(f, ix, y, iw, 'Grass blades (Realistic mode)', v.grassBlades);
    if (on !== v.grassBlades) {
      v.grassBlades = on;
      v.save();
      if (on && (v.colour !== ColourMode.Realistic || !session.renderer.hasMaterials)) {
        session.toast('Grass blades show in the Realistic colour mode, on a file with materials.', 4);
      }
    }
    y += this.s(32);
    ui.text(f.body, ix, y, 'Density', UiTheme.TEXT);
    const density = w.segmented(f, ix, y + this.s(22), iw, GRASS_DENSITY_OPTIONS, v.grassDensity);
    if (density !== v.grassDensity) { v.grassDensity = density; v.save(); }
    y += this.s(64);
    const height = w.slider(f, SLIDER.grassHeight, ix, y, iw, 'Blade height', `${v.grassHeightMm} mm`, v.grassHeightMm, GrassLimits.MIN_HEIGHT, GrassLimits.MAX_HEIGHT);
    if (w.activeSlider === SLIDER.grassHeight) {
      const mm = Math.round(height / 10) * 10;
      if (mm !== v.grassHeightMm) { v.grassHeightMm = mm; v.save(); }
    }
    y += this.s(56);
    const distance = w.slider(f, SLIDER.grassDistance, ix, y, iw, 'Distance', `${v.grassDistance} m`, v.grassDistance, GrassLimits.MIN_DISTANCE, GrassLimits.MAX_DISTANCE);
    if (w.activeSlider === SLIDER.grassDistance) {
      const m = Math.round(distance / 5) * 5;
      if (m !== v.grassDistance) { v.grassDistance = m; v.save(); }
    }
    y += this.s(58);
    const sway = cleanLookScale(w.slider(f, SLIDER.grassSway, ix, y, iw, 'Sway', v.grassSway <= 0 ? 'Off (still)' : `${Math.round(v.grassSway * 100)} %`,
      v.grassSway, 0, LookLimits.MAX_LOOK_SCALE));
    if (Math.abs(sway - v.grassSway) > 1e-4) { v.grassSway = sway; v.save(); }
    y += this.s(58);
    if (this.keywordRow(f, w, input, ix, y, iw, 'Grass keywords', v.grassKeywords)) {
      session.editor.beginCustom('GRASS KEYWORDS (COMMA SEPARATED)', MaterialOverrides.formatKeywords(v.grassKeywords), MAX_KEYWORD_TEXT, text => {
        v.grassKeywords = MaterialOverrides.parseKeywords(text);
        v.save();
        session.toast('Grass keywords changed: finding the grass again…', 2.5);
      });
    }
    y += this.s(28);
    y += ui.textWrapped(f.small, ix, y, iw, session.grass.status(), UiTheme.TEXT_FAINT, 3);
    return y;
  }

  // #endregion
}
