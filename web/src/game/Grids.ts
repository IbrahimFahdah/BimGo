import type { ClashRecord } from '../core/clashes/ClashModels';
import { type Vec2, type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import {
  type GridLevelMode as GridLevelModeType, GridLayout, GridLevelMode, type GridLocation, GridLocator, gridLocationText, type GridNode, GridNodes, GridView,
  type GridViewSettings, gridEndOutward, gridIsValid, gridStartOutward
} from '../core/scene/GridData';
import { InputAction } from '../core/scene/InputCatalog';
import { CharacterController } from '../engine/physics/CharacterController';
import { GridOverlay } from '../engine/render/GridOverlay';
import { Overlay3D } from '../engine/render/Overlay3D';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { keyOf } from '../platform/Hotkeys';
import type { InputState } from '../platform/input';
import { CoordinateReadout } from '../core/scene/SiteCoordinates';
import type { GameSession } from './GameSession';
import { MeasureGun } from './guns/MeasureGun';
import { TeleportGun } from './guns/TeleportGun';
import { DOCK_CLOSE, ScrollRegion } from './PanelShell';
import { UnitFormat } from './UnitFormat';

/** Slider ids (unique across the panels' sliders). */
const SLIDER_GRID_OPACITY = 60, SLIDER_GRID_WIDTH = 61, SLIDER_GRID_LABELS = 62;

const GRID_LEVEL_ROW1 = ['OFF', 'UNDERFOOT', '±1', 'ALL'];
const GRID_LEVEL_ROW1_MODES = [GridLevelMode.Off, GridLevelMode.Underfoot, GridLevelMode.Adjacent, GridLevelMode.All];
const GRID_LEVEL_ROW2 = ['ABOVE', 'BELOW', 'NEAREST'];
const GRID_LEVEL_ROW2_MODES = [GridLevelMode.Above, GridLevelMode.Below, GridLevelMode.Nearest];
const GRID_DEPTH_OPTIONS = ['FAINT', 'HIDDEN', 'X-RAY'];
const GRID_LINE_OPTIONS = ['SOLID', 'DASH-DOT'];
const GRID_COLOUR_OPTIONS = ['CYAN', 'RED', 'AMBER', 'WHITE', 'DARK'];
const GRID_COLOURS = [0x4fc3f7, 0xef5350, 0xffb300, 0xffffff, 0x37474f];
/** Hover reach around a node (pixels, before UI scale). */
const GRID_HOVER_PIXELS = 12;

const gridsFoot = () => `${keyOf(InputAction.GridsPanel)} / Esc closes`; // P-A2: the dock's footer
const gridsCycle = () => `${keyOf(InputAction.GridsCycle).toUpperCase()}: OFF / UNDERFOOT / ALL`;

const parseRgb = (colour: string): number => {
  const hex = colour.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex, 16) : 0x4fc3f7;
};

/**
 * Grids rounds A / B (port of GameSession.Grids.cs and GameSession.GridNodes.cs): Revit grids drawn in the model on the
 * chosen levels (off, underfoot, above, below, underfoot ±1, nearest the eye, all), Revit-like lines with bubbles and
 * level tags, a faint outline per level, and the GRIDS panel (Shift+G; C cycles off → underfoot → all). Grid
 * intersections ("nodes"): ring dots, a hover label, a click to go there, the Teleport gun blinking to an aimed node and
 * the Measure gun snapping to one; grids on the minimap; and the clash grid location ("Near C-4 : Level 2"). Saved per
 * model with the visibility.
 */
export class Grids {
  private readonly overlay = new GridOverlay();
  private readonly nodeOverlay = new Overlay3D();
  private initialised = false;
  private settings: GridViewSettings = GridView.defaults();
  /** True while the GRIDS panel is open. */
  panelOpen = false;
  private panelRect: [number, number, number, number] = [0, 0, 0, 0];
  private readonly dockScroll = new ScrollRegion();

  // What the overlay was built for (rebuilt only when it changes) and this frame's levels
  private readonly levels: number[] = [];
  private buildKey = '';
  private linkCount = -1;
  private hostCount = 0;
  private infoText: string | null = null;
  private infoKey = '';

  // Grids round B: the intersections, the clash locator and the hovered node
  private nodes: GridNode[] | null = null;
  private locator: GridLocator = GridLocator.EMPTY;
  private hoverValid = false;
  private hoverNode = -1;
  private hoverLevel = -1;
  private hoverWorld: Vec3 = vec3();
  private hoverKey = '';
  private hoverTitle = '';
  private hoverCoords = '';
  private readonly clashCache = new Map<string, { x: number; y: number; z: number; location: GridLocation | null }>();

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  private get scene() { return this.session.scene; }

  // #region Settings

  /** Restores the saved grid view (or the defaults: grids off). */
  restore(saved: GridViewSettings | null): void {
    this.settings = saved ? GridView.clean(GridView.copy(saved)) : GridView.defaults();
    this.buildKey = '';
  }

  /** The grid view for visibility.json (null at the defaults). */
  forSave(): GridViewSettings | null { return GridView.isDefault(this.settings) ? null : GridView.copy(this.settings); }

  /** A grid setting changed: rebuild the lines, save with the model (dirty file / live sidecar). */
  private changed(): void {
    GridView.clean(this.settings);
    this.buildKey = '';
    this.session.visibilityChanged();
  }

  /** Counts host and link grids once (for the panel, the link toggle and the toasts). */
  private countGrids(): void {
    if (this.linkCount >= 0) { return; }
    this.hostCount = 0;
    this.linkCount = 0;
    for (const grid of this.scene.grids) {
      if (!gridIsValid(grid)) { continue; }
      if (grid.link === 0) { this.hostCount++; } else { this.linkCount++; }
    }
  }

  /** True when grid lines in clash comments are wanted. */
  get inClashComments(): boolean { return this.settings.clashComments; }

  // #endregion

  // #region Keys and panel

  /** C: off → underfoot → all → off, with a toast saying what shows (or why nothing can). */
  cycle(): void {
    const session = this.session;
    this.countGrids();
    const next = GridLayout.next(GridView.mode(this.settings));
    GridView.setMode(this.settings, next);
    this.changed();
    session.sound.play(SoundId.UiClick);
    if (next === GridLevelMode.Off) {
      session.toast('Grids off', 1.6);
      return;
    }
    if (this.hostCount + this.linkCount === 0) {
      session.toast('This model has no grids (or the snapshot is older than grids: export again / F5 to pick them up).', 4);
      return;
    }
    if (this.hostCount === 0 && !this.settings.linkGrids) {
      session.toast(`Grids: only the links have grids: tick Link grids in the grids panel (${keyOf(InputAction.GridsPanel)}).`, 4);
      return;
    }
    session.toast(`Grids: ${GridLayout.label(next).toLowerCase()} · ${keyOf(InputAction.GridsPanel)} for options`, 2);
  }

  toggle(): void {
    if (this.panelOpen) { this.close(); } else { this.show(); }
  }

  /**
   * Opens the panel. Walking: one panel at a time, the cursor is freed and the player stands still (like the sun
   * panel). Clash mode keeps its cursor, flying and keys; the panel sits beside the dock.
   */
  show(): void {
    if (this.panelOpen) { return; }
    const session = this.session;
    this.countGrids();
    if (!session.clashModeOn) {
      session.closeModes(this);
      session.releaseMouseForTyping();
    }
    session.showUi();
    this.panelOpen = true;
    session.sound.play(SoundId.UiClick);
  }

  close(): void {
    if (!this.panelOpen) { return; }
    const session = this.session;
    this.panelOpen = false;
    this.panelRect = [0, 0, 0, 0];
    session.menu.widgets.activeSlider = -1;
    if (session.clashModeOn) { return; } // clash mode keeps its free cursor
    session.input.releaseAll();
  }

  /** True while the walking grids panel has the keys (not in clash mode, which keeps its own). */
  get hasKeys(): boolean { return this.panelOpen && !this.session.clashModeOn; }

  /** Keys while the walking panel is open: Esc / Shift+G close, C cycles. */
  updateKeys(input: InputState): void {
    if (input.pressed(InputAction.Fullscreen)) { this.session.toggleFullscreen(); }
    if (input.pressed(InputAction.Back) || input.pressed(InputAction.GridsPanel)) {
      this.close();
      return;
    }
    if (input.pressed(InputAction.GridsCycle)) { this.cycle(); }
    this.clickNode(input); // grids round B: a click on a node stands you there
  }

  /** True when the mouse is over last frame's grids panel (clash mode: clicks there aren't for the 3D view). */
  overPanel(x: number, y: number): boolean {
    const [px, py, pw, ph] = this.panelRect;
    return this.panelOpen && pw > 0 && x >= px && x < px + pw && y >= py && y < py + ph;
  }

  // #endregion

  // #region Drawing

  /** This frame's levels (they follow the player / eye), and a rebuild of the lines when anything they show changed. */
  private updateLevels(): void {
    const session = this.session, scene = this.scene, s = this.settings;
    const mode = GridView.mode(s);
    if (mode === GridLevelMode.Off || scene.grids.length === 0 || scene.levels.length === 0) {
      this.levels.length = 0;
      if (this.buildKey !== 'off') {
        this.overlay.clear();
        this.buildKey = 'off';
      }
      return;
    }
    GridLayout.shownLevels(scene.levels, mode, session.levelIndexAt(session.player.feet.z), session.camera.position.z, s.storeysOnly, this.levels);
    const key = `${mode}|${s.storeysOnly}|${s.respectExtents}|${s.linkGrids}|${s.levelOutlines}|${s.colour}|${this.levels.join(',')}`;
    if (key === this.buildKey) { return; }
    this.buildKey = key;
    if (!this.initialised) {
      this.overlay.initialise();
      this.nodeOverlay.initialise();
      this.initialised = true;
    }
    const rgb = parseRgb(s.colour);
    this.overlay.build(scene.grids, scene.levels, this.levels, s.linkGrids, s.respectExtents, s.levelOutlines, Rgba.hex(rgb), Rgba.hex(rgb, 0.4));
  }

  /**
   * The grid lines (main view, with the markers: not with the UI hidden; P-C: in photo mode and photos when "Grid
   * lines in the photo" is ticked, widthScale keeping their width on 2–4× stills).
   */
  draw(widthScale = 1): void {
    this.updateLevels();
    if (this.levels.length === 0) { return; }
    const s = this.settings, camera = this.session.camera;
    this.overlay.draw(camera, GridView.depthIndex(s), s.opacity, s.width * widthScale, GridView.dashDot(s));
    this.drawNodes(); // grids round B
  }

  /** Polish round P-C: true while the grids show (any level). */
  get showing(): boolean {
    this.updateLevels();
    return this.levels.length > 0;
  }

  /** The bubbles (grid name in a circle just past each end) and level tags, as 2D UI over the view. */
  drawLabels(f: FontAtlas): void {
    const s = this.settings;
    if (this.levels.length === 0 || (!s.bubbles && !s.levelTags)) { return; }
    const session = this.session, ui = session.ui, camera = session.camera, scene = this.scene;
    const rgb = parseRgb(s.colour);
    const ring = Rgba.hex(rgb, Math.max(0.6, s.opacity));
    const fill = Rgba.hex(0x0c0e12, 0.8);
    const radius = this.s(11);
    const limit2 = s.labelDistance * s.labelDistance;
    const width = session.screenWidth, height = session.screenHeight;
    for (const index of this.levels) {
      if (index < 0 || index >= scene.levels.length) { continue; }
      const level = scene.levels[index];
      const z = level.elevation + GridOverlay.LIFT;
      for (const grid of scene.grids) {
        if (!GridLayout.included(grid, s.linkGrids) || !GridLayout.showsAt(grid, level.elevation, s.respectExtents)) { continue; }
        for (let end = 0; end < 2; end++) {
          const tip = end === 0 ? grid.points[0] : grid.points[grid.points.length - 1];
          const outward = end === 0 ? gridStartOutward(grid) : gridEndOutward(grid);
          const world = vec3(tip.x, tip.y, z);
          if (V.distanceSquared(world, camera.position) > limit2) { continue; }
          const screen = camera.worldToScreen(world);
          if (!screen) { continue; }
          if (screen.x < -this.s(60) || screen.y < -this.s(60) || screen.x > width + this.s(60) || screen.y > height + this.s(60)) { continue; }

          // The bubble sits just past the end, along the line's direction on screen
          let dx = 1, dy = 0;
          const ahead = camera.worldToScreen(vec3(tip.x + outward.x, tip.y + outward.y, z));
          if (ahead) {
            const ax = ahead.x - screen.x, ay = ahead.y - screen.y, l = Math.hypot(ax, ay);
            if (l > 1e-2) { dx = ax / l; dy = ay / l; }
          }
          const cx = screen.x + dx * radius, cy = screen.y + dy * radius;
          if (s.bubbles) {
            ui.circle(cx, cy, radius, fill, 24);
            ui.ring(cx, cy, radius, this.s(2), ring, 28);
            const font = grid.name.length > 2 ? f.small : f.bold;
            ui.textCentred(font, cx, cy - font.lineHeight * 0.5, grid.name, UiTheme.TEXT);
          }
          if (s.levelTags) {
            const tag = level.name + ' · ' + UnitFormat.appendLength(session.text.clear(), level.elevation, 3, true).text;
            ui.text(f.small, cx + radius + this.s(4), cy - f.small.lineHeight * 0.5, tag, Rgba.withAlpha(UiTheme.TEXT_SOFT, 0.85));
          }
        }
      }
    }
  }

  /** The GRIDS panel: levels, what to draw, see-through, colour, opacity, width, label distance (the dock column). */
  buildPanel(f: FontAtlas, input: InputState): void {
    if (!this.panelOpen) { return; }
    const session = this.session, ui = session.ui, shell = session.shell, w = session.menu.widgets, s = this.settings;
    if (!input.leftDown && w.activeSlider >= SLIDER_GRID_OPACITY && w.activeSlider <= SLIDER_GRID_LABELS) { w.activeSlider = -1; }
    this.countGrids();

    // Polish round P-A2: the right-hand dock column (clash mode: left of the clash dock)
    const d = shell.beginDock('GRIDS & LEVELS', UiTheme.SCAN_LABEL, Rgba.withAlpha(UiTheme.ACCENT, 0.5), this.s(UiTheme.DOCK_WIDTH), this.dockScroll, false);
    this.panelRect = [d.x, d.y, d.w, d.h];
    const ix = d.ix, iw = d.iw;
    let cy = shell.beginDockBody(d, this.dockScroll, input);
    ui.text(f.small, ix, cy, this.info(), this.hostCount + this.linkCount === 0 ? UiTheme.MEASURE_LABEL : UiTheme.TEXT_MUTED);
    cy += this.s(24);

    // Levels: two rows of choices (one is lit)
    ui.text(f.body, ix, cy, 'Levels', UiTheme.TEXT);
    ui.textRight(f.small, ix + iw, cy + this.s(2), gridsCycle(), UiTheme.TEXT_FAINT);
    cy += this.s(22);
    const mode = GridView.mode(s);
    const row1 = GRID_LEVEL_ROW1_MODES.indexOf(mode);
    const picked1 = w.segmented(f, ix, cy, iw, GRID_LEVEL_ROW1, row1);
    if (picked1 !== row1 && picked1 >= 0) { this.setMode(GRID_LEVEL_ROW1_MODES[picked1]); }
    cy += this.s(36);
    const row2 = GRID_LEVEL_ROW2_MODES.indexOf(mode);
    const picked2 = w.segmented(f, ix, cy, iw, GRID_LEVEL_ROW2, row2);
    if (picked2 !== row2 && picked2 >= 0) { this.setMode(GRID_LEVEL_ROW2_MODES[picked2]); }
    cy += this.s(44);

    // What to draw (two columns)
    const col = iw * 0.5;
    const check = (x: number, label: string, key: 'storeysOnly' | 'respectExtents' | 'bubbles' | 'levelTags' | 'levelOutlines' | 'nodes' | 'linkGrids' | 'clashComments') => {
      const v = w.checkbox(f, x, cy, col - this.s(6), label, s[key]);
      if (v !== s[key]) { s[key] = v; this.changed(); }
    };
    check(ix, 'Storeys only', 'storeysOnly');
    check(ix + col, '3D extents', 'respectExtents');
    cy += this.s(28);
    check(ix, 'Bubbles', 'bubbles');
    check(ix + col, 'Level tags', 'levelTags');
    cy += this.s(28);
    check(ix, 'Level outlines', 'levelOutlines');
    check(ix + col, 'Nodes', 'nodes'); // grids round B
    cy += this.s(28);
    if (this.linkCount > 0) { check(ix, 'Link grids', 'linkGrids'); }
    else { ui.text(f.body, ix, cy - this.s(1), 'No link grids', UiTheme.TEXT_FAINT); }
    // Grids round B: the clash's grid location in clash comments (and so BCF), off by default
    check(ix + col, 'In clash comments', 'clashComments');
    cy += this.s(36);

    // Grids round B: line style (solid by default)
    ui.text(f.body, ix, cy + this.s(7), 'Line', UiTheme.TEXT);
    const line = GridView.dashDot(s) ? 1 : 0;
    const pickedLine = w.segmented(f, ix + this.s(90), cy, iw - this.s(90), GRID_LINE_OPTIONS, line);
    if (pickedLine !== line) {
      s.line = pickedLine === 1 ? 'dashdot' : 'solid';
      this.changed();
    }
    cy += this.s(42);

    // See-through and colour
    ui.text(f.body, ix, cy, 'Through walls', UiTheme.TEXT);
    cy += this.s(22);
    const depthIndex = GridView.depthIndex(s);
    const depth = w.segmented(f, ix, cy, iw, GRID_DEPTH_OPTIONS, depthIndex);
    if (depth !== depthIndex) {
      s.depth = GridView.DEPTHS[depth];
      this.changed();
    }
    cy += this.s(42);
    ui.text(f.body, ix, cy, 'Colour', UiTheme.TEXT);
    cy += this.s(22);
    const colour = GRID_COLOURS.indexOf(parseRgb(s.colour));
    const pickedColour = w.segmented(f, ix, cy, iw, GRID_COLOUR_OPTIONS, colour);
    if (pickedColour !== colour && pickedColour >= 0) {
      s.colour = '#' + GRID_COLOURS[pickedColour].toString(16).padStart(6, '0').toUpperCase();
      this.changed();
    }
    cy += this.s(44);

    // Opacity, width, label distance
    const opacity = w.slider(f, SLIDER_GRID_OPACITY, ix, cy, iw, 'Opacity', `${Math.round(s.opacity * 100)} %`, s.opacity, GridView.MIN_OPACITY, 1);
    if (w.activeSlider === SLIDER_GRID_OPACITY && Math.abs(Math.round(opacity * 20) / 20 - s.opacity) > 1e-4) {
      s.opacity = Math.round(opacity * 20) / 20;
      this.changed();
    }
    cy += this.s(54);
    const lineWidth = w.slider(f, SLIDER_GRID_WIDTH, ix, cy, iw, 'Line width', `${s.width.toFixed(1)} px`, s.width, GridView.MIN_WIDTH, GridView.MAX_WIDTH);
    if (w.activeSlider === SLIDER_GRID_WIDTH && Math.abs(Math.round(lineWidth * 2) / 2 - s.width) > 1e-4) {
      s.width = Math.round(lineWidth * 2) / 2;
      this.changed();
    }
    cy += this.s(54);
    const labels = w.slider(f, SLIDER_GRID_LABELS, ix, cy, iw, 'Bubbles within', UnitFormat.appendLength(session.text.clear(), s.labelDistance, 0).text,
      s.labelDistance, GridView.MIN_LABEL_DISTANCE, GridView.MAX_LABEL_DISTANCE);
    if (w.activeSlider === SLIDER_GRID_LABELS && Math.abs(Math.round(labels / 10) * 10 - s.labelDistance) > 1e-3) {
      s.labelDistance = Math.round(labels / 10) * 10;
      this.changed();
    }
    cy += this.s(58);

    if (w.smallButton(f, ix, cy, this.s(110), this.s(28), 'RESET')) {
      const keep = GridView.mode(s);
      this.settings = GridView.defaults();
      GridView.setMode(this.settings, keep);
      this.changed();
    }
    ui.textRight(f.small, ix + iw, cy + this.s(8), 'Saved with the model', UiTheme.TEXT_FAINT);
    cy += this.s(28);
    shell.endDockBody(this.dockScroll, input, cy);
    if (shell.endDock(d, null, gridsFoot()) === DOCK_CLOSE) { this.close(); }
  }

  private setMode(mode: GridLevelModeType): void {
    GridView.setMode(this.settings, mode);
    this.changed();
  }

  /** The panel's info line ("12 grids · 4 in links · 3 levels shown"), made again only when it changes. */
  private info(): string {
    const key = `${this.hostCount}|${this.linkCount}|${this.levels.length}|${this.settings.linkGrids}`;
    if (key === this.infoKey && this.infoText !== null) { return this.infoText; }
    this.infoKey = key;
    if (this.hostCount + this.linkCount === 0) {
      this.infoText = 'No grids in this snapshot (export again / F5 with this version).';
      return this.infoText;
    }
    const links = this.linkCount === 0 ? '' : ` · ${this.linkCount} in links${this.settings.linkGrids ? '' : ' (off)'}`;
    const n = this.levels.length;
    const levels = n === 0 ? 'none shown' : n === 1 ? '1 level shown' : `${n} levels shown`;
    this.infoText = `${this.hostCount} grids${links} · ${levels}`;
    return this.infoText;
  }

  // #endregion

  // #region Nodes and locations (grids round B)

  /** Finds the intersections and builds the clash locator (once, on first use). */
  private ensureNodes(): GridNode[] {
    if (this.nodes) { return this.nodes; }
    const scene = this.scene;
    this.nodes = GridNodes.build(scene.grids);
    this.locator = GridLocator.create(scene.grids, this.nodes, scene.levels, scene.originOffset);
    if (this.nodes.length > 0) { console.info(`Grid intersections: ${this.nodes.length}.`); }
    return this.nodes;
  }

  /** A clash's grid location (cached per clash and point), or null when the model has no intersections. */
  clashLocation(clash: ClashRecord | null): GridLocation | null {
    if (!clash) { return null; }
    this.ensureNodes();
    if (this.locator.isEmpty) { return null; }
    const cached = this.clashCache.get(clash.id);
    if (cached && cached.x === clash.x && cached.y === clash.y && cached.z === clash.z) { return cached.location; }
    const location = this.locator.locate(clash.x, clash.y, clash.z);
    this.clashCache.set(clash.id, { x: clash.x, y: clash.y, z: clash.z, location });
    return location;
  }

  /** " · Near C-4 : Level 2 (1.2 m)" for the clash card, or empty without grids. */
  clashSuffix(clash: ClashRecord | null, offset: boolean): string {
    const location = this.clashLocation(clash);
    if (!location) { return ''; }
    const text = ' · Near ' + gridLocationText(location);
    return offset ? `${text} (${UnitFormat.appendLength(this.session.text.clear(), location.offset, 1).text})` : text;
  }

  /** A report's grid location function, or null without grids. */
  clashFunction(): ((clash: ClashRecord) => string | null) | null {
    this.ensureNodes();
    const locator = this.locator;
    if (locator.isEmpty) { return null; }
    return clash => (clash ? locator.text(clash.x, clash.y, clash.z) : null);
  }

  /** True when the node is drawn on this level (link grids, extents). */
  private nodeShows(node: GridNode, elevation: number): boolean {
    const grids = this.scene.grids;
    return GridLayout.included(grids[node.a], this.settings.linkGrids) && GridNodes.showsAt(node, grids, elevation, this.settings.respectExtents);
  }

  /** The ring dots on the shown levels within the bubble distance (with the grid lines; their see-through mode). */
  private drawNodes(): void {
    const s = this.settings;
    if (!s.nodes || this.levels.length === 0) { return; }
    const nodes = this.ensureNodes();
    if (nodes.length === 0) { return; }
    const camera = this.session.camera, scene = this.scene, overlay = this.nodeOverlay;
    const rgb = parseRgb(s.colour);
    const ring = Rgba.hex(rgb), core = Rgba.hex(0x0c0e12, 0.85);
    const limit2 = s.labelDistance * s.labelDistance;
    overlay.begin(camera);
    for (const level of this.levels) {
      if (level < 0 || level >= scene.levels.length) { continue; }
      const elevation = scene.levels[level].elevation;
      for (let i = 0; i < nodes.length; i++) {
        if (!this.nodeShows(nodes[i], elevation)) { continue; }
        const world = vec3(nodes[i].point.x, nodes[i].point.y, elevation + GridOverlay.LIFT);
        if (V.distanceSquared(world, camera.position) > limit2) { continue; }
        const hovered = this.hoverValid && i === this.hoverNode && level === this.hoverLevel;
        overlay.dot(world, hovered ? 8 : 5.5, hovered ? UiTheme.TEXT : ring, 14);
        overlay.dot(world, hovered ? 5 : 3, hovered ? ring : core, 12);
      }
    }
    const mode = GridView.depthIndex(s);
    const opacity = Math.max(0.5, s.opacity);
    if (mode === 2) { overlay.draw(camera, false, opacity, false); }
    else {
      if (mode === 0) { overlay.draw(camera, false, opacity * 0.25, false); }
      overlay.draw(camera, true, opacity, false);
    }
  }

  /** The hovered node's label beside it: "A-1 : Level 2", its coordinates and what a click or the gun does there. */
  drawHoverLabel(f: FontAtlas): void {
    if (!this.hoverValid) { return; }
    const session = this.session, ui = session.ui;
    const screen = session.camera.worldToScreen(this.hoverWorld);
    if (!screen) { return; }
    this.refreshHoverText();
    const hint = this.hoverHint();
    let w = Math.max(UiBatch.measure(f.bold, this.hoverTitle), UiBatch.measure(f.small, this.hoverCoords));
    if (hint !== null) { w = Math.max(w, UiBatch.measure(f.small, hint)); }
    w += this.s(20);
    const h = hint !== null ? this.s(62) : this.s(44);
    const x = Math.min(screen.x + this.s(16), session.screenWidth - w - this.s(10));
    const y = Math.min(Math.max(screen.y - h - this.s(10), this.s(10)), session.screenHeight - h - this.s(10));
    ui.panel(x, y, w, h, UiTheme.PANEL_STRONG, Rgba.hex(parseRgb(this.settings.colour), 0.8));
    ui.text(f.bold, x + this.s(10), y + this.s(6), this.hoverTitle, UiTheme.TEXT);
    ui.text(f.small, x + this.s(10), y + this.s(26), this.hoverCoords, UiTheme.COORDS);
    if (hint !== null) { ui.text(f.small, x + this.s(10), y + this.s(43), hint, UiTheme.TEXT_FAINT); }
  }

  /** What acting on the hovered node does now (or null). */
  private hoverHint(): string | null {
    const session = this.session;
    if (session.clashModeOn) { return 'Click: fly there'; }
    if (this.panelOpen) { return 'Click: go there'; }
    if (session.unarmed) { return null; }
    const gun = session.guns[session.activeGun];
    return gun instanceof TeleportGun ? 'Teleport: blink here' : gun instanceof MeasureGun ? 'Measure snaps here' : null;
  }

  /** The label's title and coordinate line, made again only when the node, level or readout changes. */
  private refreshHoverText(): void {
    const session = this.session;
    const key = `${this.hoverNode}|${this.hoverLevel}|${session.settings.coordinateReadout}|${UnitFormat.isImperial}|${UnitFormat.decimalFeet}`;
    if (key === this.hoverKey && this.hoverTitle) { return; }
    this.hoverKey = key;
    const node = this.ensureNodes()[this.hoverNode];
    const level = this.scene.levels[this.hoverLevel];
    this.hoverTitle = node.name + ' : ' + level.name;
    const o = this.scene.originOffset;
    const [readout, values] = session.coordinatesOf(node.point.x + o.x, node.point.y + o.y, level.elevation + o.z);
    const shared = readout === CoordinateReadout.Shared;
    const t = session.text.clear();
    t.append(shared ? 'E ' : 'X ');
    UnitFormat.appendCoordinate(t, values[0]).append(shared ? ' · N ' : ' · Y ');
    UnitFormat.appendCoordinate(t, values[1]).append(shared ? ' · ELEV ' : ' · Z ');
    this.hoverCoords = UnitFormat.appendCoordinate(t, values[2]).text;
  }

  /**
   * Once a frame (with the aim): the node nearest the crosshair (cursor captured) or the mouse (cursor free), within a
   * few pixels, on the shown levels and within the bubble distance. Then the Measure gun's snap.
   */
  updateHover(): void {
    this.hoverValid = false;
    const session = this.session, s = this.settings;
    if (!s.nodes || this.levels.length === 0 || session.uiHidden || session.paused || session.photo.open || session.tour.active) { return; }
    const nodes = this.ensureNodes();
    if (nodes.length === 0) { return; }
    const input = session.input, camera = session.camera, scene = this.scene;
    const captured = session.isCaptured;
    const tx = captured ? camera.viewportWidth * 0.5 : input.mouseX, ty = captured ? camera.viewportHeight * 0.5 : input.mouseY;
    if (!captured && (this.overPanel(tx, ty) || (session.clashModeOn && session.clashes.overDock(input)))) { return; }

    const reach = this.s(GRID_HOVER_PIXELS);
    let best = reach * reach;
    const limit2 = s.labelDistance * s.labelDistance;
    for (const level of this.levels) {
      if (level < 0 || level >= scene.levels.length) { continue; }
      const elevation = scene.levels[level].elevation;
      for (let i = 0; i < nodes.length; i++) {
        const world = vec3(nodes[i].point.x, nodes[i].point.y, elevation + GridOverlay.LIFT);
        if (V.distanceSquared(world, camera.position) > limit2 || !this.nodeShows(nodes[i], elevation)) { continue; }
        const screen = camera.worldToScreen(world);
        if (!screen) { continue; }
        const d = (screen.x - tx) ** 2 + (screen.y - ty) ** 2;
        if (d < best) {
          best = d;
          this.hoverValid = true;
          this.hoverNode = i;
          this.hoverLevel = level;
          this.hoverWorld = world;
        }
      }
    }

    // The Measure gun snaps to an aimed node (distance and angle ends, area corners)
    if (this.hoverValid && captured && !session.unarmed && session.guns[session.activeGun] instanceof MeasureGun) {
      const point = vec3(this.hoverWorld.x, this.hoverWorld.y, this.hoverWorld.z - GridOverlay.LIFT);
      const hit = { point, normal: vec3(0, 0, 1), distance: V.distance(camera.position, point), element: -1, dynamicId: 0 };
      session.aim = { ...session.aim, hasHit: true, hit };
    }
  }

  /** The Teleport gun's target when it aims at a node: a free standing spot at (or just beside) the node on its level. */
  teleportTarget(): { feet: Vec3; distance: number } | null {
    if (!this.hoverValid || !this.session.isCaptured) { return null; }
    const distance = V.distance(this.session.camera.position, this.hoverWorld);
    const feet = this.freeFeetNear(this.ensureNodes()[this.hoverNode].point, this.scene.levels[this.hoverLevel].elevation);
    return feet ? { feet, distance } : null;
  }

  /**
   * A spot to stand at or near a plan point on a level: the floor found under it (within 0.6 m of the level), else the
   * level itself; the point first, then rings 0.6 / 1.0 / 1.5 m round it (a column often stands on the node).
   */
  private freeFeetNear(point: Vec2, elevation: number): Vec3 | null {
    const session = this.session;
    for (const r of [0, 0.6, 1.0, 1.5]) {
      const steps = r === 0 ? 1 : 8;
      for (let k = 0; k < steps; k++) {
        const angle = k * Math.PI * 2 / steps;
        const px = point.x + Math.cos(angle) * r, py = point.y + Math.sin(angle) * r;
        let z = elevation;
        const floor = session.pick(vec3(px, py, elevation + 1.0), vec3(0, 0, -1), 1.6);
        if (floor && floor.normal.z > 0.7 && Math.abs(floor.point.z - elevation) < 0.6) { z = floor.point.z; }
        const candidate = vec3(px, py, z + 0.02);
        if (!session.player.controller.overlaps(vec3(px, py, candidate.z + 0.01), CharacterController.STAND_HEIGHT)) { return candidate; }
      }
    }
    return null;
  }

  /** A click on the hovered node: walking (grids panel open), stand there; clash mode, fly to look at it. True when taken. */
  clickNode(input: InputState): boolean {
    const session = this.session;
    if (!this.hoverValid || !input.leftPressed || session.menu.overlays.isOpen) { return false; }
    input.consumeClicks();
    this.refreshHoverText();
    const node = this.ensureNodes()[this.hoverNode];
    const elevation = this.scene.levels[this.hoverLevel].elevation;
    const player = session.player;
    if (session.clashModeOn) {
      // Look at the node from 7 m back along the current heading and 4 m up
      const look = vec3(node.point.x, node.point.y, elevation + 0.5);
      const hx = Math.cos(player.yaw), hy = Math.sin(player.yaw);
      const eye = vec3(look.x - hx * 7, look.y - hy * 7, look.z + 4);
      const pitch = Math.atan2(look.z - eye.z, Math.hypot(look.x - eye.x, look.y - eye.y));
      session.clashes.flyToPoint(eye, player.yaw, pitch);
      session.sound.play(SoundId.UiClick);
      session.toast(this.hoverTitle, 1.6);
      return true;
    }
    const feet = this.freeFeetNear(node.point, elevation);
    if (!feet) {
      session.sound.play(SoundId.Error);
      session.toast(`No room to stand at ${this.hoverTitle}`, 2.5, true);
      return true;
    }
    player.teleportTo(feet);
    session.sound.play(SoundId.Blink);
    session.flash(UiTheme.TELEPORT, 0.1);
    session.toast(this.hoverTitle, 1.6);
    return true;
  }

  // #endregion

  // #region Minimap

  /** The grids of the level underfoot on the minimap (when grids are on): thin lines clipped to the map, names at the edges. */
  drawMinimap(f: FontAtlas, mapX: number, mapY: number, mapW: number, mapH: number, cx: number, cy: number, metresPerPixel: number): void {
    const s = this.settings, scene = this.scene, session = this.session, ui = session.ui;
    if (GridView.mode(s) === GridLevelMode.Off || scene.grids.length === 0 || scene.levels.length === 0) { return; }
    const feet = session.player.feet;
    const elevation = scene.levels[session.levelIndexAt(feet.z)].elevation;
    const rgb = parseRgb(s.colour);
    const line = Rgba.hex(rgb, 0.7), label = Rgba.hex(rgb);
    const toMap = (p: Vec2): [number, number] => [cx + (p.x - feet.x) / metresPerPixel, cy - (p.y - feet.y) / metresPerPixel];
    for (const grid of scene.grids) {
      if (!GridLayout.included(grid, s.linkGrids) || !GridLayout.showsAt(grid, elevation, s.respectExtents)) { continue; }
      const pts = grid.points;
      for (let i = 1; i < pts.length; i++) {
        const c = clipToRect(toMap(pts[i - 1]), toMap(pts[i]), mapX, mapY, mapX + mapW, mapY + mapH);
        if (c) { ui.line(c[0], c[1], c[2], c[3], this.s(1), line); }
      }
      // The name at each end: where the line enters the map from that end (or the end itself inside it)
      for (let end = 0; end < 2; end++) {
        const i0 = end === 0 ? 0 : pts.length - 1, step = end === 0 ? 1 : -1;
        for (let i = i0; i + step >= 0 && i + step < pts.length; i += step) {
          const c = clipToRect(toMap(pts[i]), toMap(pts[i + step]), mapX, mapY, mapX + mapW, mapY + mapH);
          if (!c) { continue; }
          const lw = UiBatch.measure(f.small, grid.name) + this.s(6);
          const lx = Math.min(Math.max(c[0] - lw * 0.5, mapX), mapX + mapW - lw);
          const ly = Math.min(Math.max(c[1] - this.s(7), mapY), mapY + mapH - this.s(14));
          ui.rect(lx, ly, lw, this.s(14), Rgba.hex(0x0c0e12, 0.8));
          ui.textCentred(f.small, lx + lw * 0.5, ly, grid.name, label);
          break;
        }
      }
    }
  }

  // #endregion
}

/** Clips a segment to a rectangle (Liang–Barsky): [ax, ay, bx, by], or null when it misses. */
function clipToRect(a: [number, number], b: [number, number], minX: number, minY: number, maxX: number, maxY: number): [number, number, number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - minX, maxX - a[0], a[1] - minY, maxY - a[1]];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) {
      if (q[i] < 0) { return null; }
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) { return null; } if (t > t0) { t0 = t; } }
    else { if (t < t0) { return null; } if (t < t1) { t1 = t; } }
  }
  return [a[0] + dx * t0, a[1] + dy * t0, a[0] + dx * t1, a[1] + dy * t1];
}
