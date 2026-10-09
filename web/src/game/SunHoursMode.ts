import { Mat4 } from '../core/math/Matrix4x4';
import { type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import { findCategory } from '../core/scene/CategoryCatalog';
import { Aabb } from '../core/scene/SceneData';
import {
  cleanSunHoursSettings, defaultSunHoursSettings, SUN_HOURS_GRID_SIZES, SUN_HOURS_STEPS, SunHours, type SunHoursSettings
} from '../core/scene/SunHours';
import { Overlay3D } from '../engine/render/Overlay3D';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { downloadBlob, safeFileName } from '../platform/files';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import { Widgets } from './Menus';
import { MONTHS } from './SunState';
import { SunHoursFace, SunHoursStudy } from './SunHoursStudy';

const GRID_OPTIONS = ['0.1', '0.25', '0.5', '1 m'];
const STEP_OPTIONS = ['5 min', '10 min', '15 min'];
/** Ray casting time per frame while a study runs (ms). */
const SUN_BUDGET_MS = 10;

/** "09:00". */
function clock(minutes: number): string {
  return `${String(Math.trunc(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Direct sun hours study (J or pause menu → SUN HOURS STUDY; port of GameSession.SunHours.cs). The player stands
 * still, the cursor is free, RMB-drag looks around. The walls and floors of the room you stand in are selected;
 * clicking a surface adds or removes it. RUN casts a ray towards the sun from every grid cell every few minutes over the
 * chosen range and colours the cells on Ladybug's 0–7 h legend. Results stay until CLEAR or the session ends.
 */
export class SunHoursMode {
  open = false;
  private readonly w: Widgets;
  private settings: SunHoursSettings = defaultSunHoursSettings();
  readonly study = new SunHoursStudy();
  private readonly faces: SunHoursFace[] = [];
  private gridDirty = true;
  private overlay: Overlay3D | null = null;
  private overlayRevision = -1;
  private opaqueOnly = true;
  private panelRect = [0, 0, 0, 0];
  /** The study's screenshot (3D view + legend) is due this frame. */
  shotRequested = false;
  private notice: string | null = null;
  private summary: string | null = null;
  private legendTitle: string | null = null;
  private stale = false;

  constructor(private readonly session: GameSession) {
    this.w = new Widgets(session);
  }

  private s(v: number): number { return this.session.s(v); }

  // #region Open / close

  /** Opens the panel; the first time (or with nothing selected) it selects the room you stand in. */
  show(): void {
    const session = this.session;
    if (this.open) { return; }
    if (session.paused) { session.setPaused(false); }
    session.sunPanel.close();
    session.showUi();
    this.open = true;
    session.releaseMouseForTyping();
    session.sound.play(SoundId.UiClick);
    this.settings.daylightSaving = session.sun.settings.time.daylightSaving;
    if (this.faces.length === 0) { this.selectRoomFaces(session.currentRoomIndex); }
  }

  /** Closes the panel (a finished study stays on screen with its legend; a running one keeps running). */
  close(): void {
    if (!this.open) { return; }
    this.open = false;
    this.w.activeSlider = -1;
    this.session.input.releaseAll();
  }

  /** Keys and mouse while the panel is open: Esc / J close, RMB-drag looks, a click on the model adds / removes a surface. */
  updateMode(input: InputState): void {
    const session = this.session;
    if (input.isPressed(Vk.ESCAPE) || input.isPressed(Vk.key('J'))) {
      this.close();
      return;
    }
    if (input.rightDown) { session.player.look(input.mouseDeltaX, input.mouseDeltaY, session.settings.mouseSensitivity, session.settings.invertY); }

    const [px, py, pw, ph] = this.panelRect;
    const overPanel = input.mouseX >= px && input.mouseX < px + pw && input.mouseY >= py && input.mouseY < py + ph;
    if (input.leftPressed && !overPanel && !this.study.running) {
      input.consumeClicks();
      this.pickFace(input.mouseX, input.mouseY);
    }
  }

  /** Per frame: rebuilds the grid after a change, runs the study a few milliseconds, reports the end. */
  update(): void {
    const session = this.session;
    if (this.gridDirty) {
      this.gridDirty = false;
      this.study.build(this.faces, cleanSunHoursSettings(this.settings, new Date().getFullYear()), session.scene.rooms);
      this.summary = null;
      this.stale = false;
      if (this.study.truncated) { this.notice = `Over ${SunHoursStudy.MAX_CELLS.toLocaleString('en')} cells: pick a larger grid or fewer surfaces`; }
    }
    if (!this.study.running) { return; }

    this.study.step((origin, direction, distance) => session.sunRayBlocked(origin, direction, distance, this.opaqueOnly), SUN_BUDGET_MS);
    if (this.study.finished) {
      const st = this.study.statistics();
      const pct = (v: number) => `${Math.round(v * 100)} %`;
      this.summary = `Average ${st.average.toFixed(1)} h · min ${st.min.toFixed(1)} · max ${st.max.toFixed(1)} · ${pct(st.atLeast2)} ≥ 2 h · ${pct(st.atLeast3)} ≥ 3 h`;
      console.info(`Sun hours: ${this.study.cellCount.toLocaleString('en')} cells × ${this.study.sunSamples} sun samples in ${(this.study.elapsed / 1000).toFixed(1)} s. ${this.summary}.`);
      session.sound.play(SoundId.Commit);
      session.toast('Sun hours study done: ' + this.summary, 4);
    }
  }

  // #endregion

  // #region Targets

  /**
   * Selects the walls and floors of a room (replacing the selection): every opaque wall or floor triangle near the
   * room, grouped into faces by element and plane; the grid keeps only the cells inside the room.
   */
  private selectRoomFaces(roomIndex: number): void {
    const session = this.session, scene = session.scene;
    this.faces.length = 0;
    this.gridDirty = true;
    const room = scene.rooms[roomIndex];
    if (roomIndex < 0 || !room) {
      this.notice = 'You are not in a room: click walls or floors to test them';
      return;
    }

    const walls = findCategory('walls')?.index ?? -1, floors = findCategory('floors')?.index ?? -1;
    const box = new Aabb(vec3(room.min.x - 0.6, room.min.y - 0.6, room.bottomZ - 0.5), vec3(room.max.x + 0.6, room.max.y + 0.6, room.topZ + 0.5));
    const byKey = new Map<string, SunHoursFace>();
    const g = scene.geometry, indices = g.indices;

    scene.elements.forEach((record, e) => {
      const isWall = record.categoryIndex === walls, isFloor = record.categoryIndex === floors;
      if ((!isWall && !isFloor) || !session.isPickable(e) || !record.bounds.overlaps(box)) { return; }
      for (let i = record.opaqueStart; i + 2 < record.opaqueStart + record.opaqueCount; i += 3) {
        const a = g.position(indices[i]), b = g.position(indices[i + 1]), c = g.position(indices[i + 2]);
        const cross = V.cross(V.sub(b, a), V.sub(c, a));
        if (V.lengthSquared(cross) < 1e-10) { continue; }
        let n = V.normalize(cross);
        const centre = V.scale(V.add(V.add(a, b), c), 1 / 3);

        const horizontal = Math.abs(n.z) > 0.9;
        if (horizontal) {
          // Floor tops at the room's floor (the slab's underside belongs to the room below)
          if (Math.abs(centre.z - room.bottomZ) > 0.15) { continue; }
          n = vec3(0, 0, 1);
        } else if (Math.abs(n.z) < 0.2) {
          // Walls: one sign per plane (each cell then faces into the room)
          if (n.x < -1e-4 || (Math.abs(n.x) <= 1e-4 && n.y < 0)) { n = V.scale(n, -1); }
        } else { continue; }

        const offset = V.dot(n, centre);
        const key = `${e},${Math.round(n.x * 50)},${Math.round(n.y * 50)},${Math.round(n.z * 50)},${Math.round(offset / 0.02)}`;
        let face = byKey.get(key);
        if (!face) {
          face = new SunHoursFace(e, n, offset);
          face.room = roomIndex;
          face.bothSides = !horizontal;
          byKey.set(key, face);
          this.faces.push(face);
        }
        face.triangles.push([a, b, c]);
      }
    });
    this.notice = this.faces.length === 0 ? 'No walls or floors found around this room: click surfaces to test them' : null;
  }

  /**
   * A click on the model: removes the surface under the cursor when it is selected, else adds it (the element's
   * triangles in that plane, tested on the side facing you, clipped to the room on that side if there is one).
   */
  private pickFace(mouseX: number, mouseY: number): void {
    const session = this.session, scene = session.scene;
    const { origin, direction } = this.screenRay(mouseX, mouseY);
    const hit = session.pickStatic(origin, direction, 300);
    if (session.dynamics.raycast(origin, direction, hit ? hit.distance : 300)) {
      session.sound.play(SoundId.Error);
      this.notice = "Moved or placed elements can't be tested (they still cast shade)";
      return;
    }
    if (!hit) {
      session.sound.play(SoundId.Error);
      return;
    }

    const n = hit.normal;
    const offset = V.dot(n, hit.point);
    const existing = this.faces.findIndex(face => face.samePlane(hit.element, n, offset));
    if (existing >= 0) {
      this.faces.splice(existing, 1);
      this.gridDirty = true;
      session.sound.play(SoundId.Remove);
      this.notice = 'Surface removed';
      return;
    }

    // The element's triangles in the clicked plane
    const record = scene.elements[hit.element];
    const face = new SunHoursFace(hit.element, n, offset);
    face.picked = true;
    const g = scene.geometry, indices = g.indices;
    for (let i = record.opaqueStart; i + 2 < record.opaqueStart + record.opaqueCount; i += 3) {
      const a = g.position(indices[i]), b = g.position(indices[i + 1]), c = g.position(indices[i + 2]);
      if (Math.abs(V.dot(n, a) - offset) > 0.02 || Math.abs(V.dot(n, b) - offset) > 0.02 || Math.abs(V.dot(n, c) - offset) > 0.02) { continue; }
      face.triangles.push([a, b, c]);
    }
    if (face.triangles.length === 0) {
      session.sound.play(SoundId.Error);
      this.notice = "That surface isn't flat enough to test (pick a wall, floor or bench top)";
      return;
    }

    // Clipped to the room it faces (a slab or a long wall otherwise covers the whole level)
    const p = V.add(hit.point, V.scale(n, 0.15));
    face.room = session.findRoomAt(p.x, p.y, p.z);
    this.faces.push(face);
    this.gridDirty = true;
    session.sound.play(SoundId.UiClick);
    this.notice = `Added: ${record.name}${face.room >= 0 ? ` (in ${this.roomLabel(face.room)})` : ''}`;
  }

  /** The world ray under a window pixel. */
  private screenRay(px: number, py: number): { origin: Vec3; direction: Vec3 } {
    const session = this.session, camera = session.camera;
    const x = px / Math.max(1, session.screenWidth) * 2 - 1, y = 1 - py / Math.max(1, session.screenHeight) * 2;
    const inverse = camera.inverseViewProjection;
    const near = Mat4.transform4(x, y, -1, 1, inverse), far = Mat4.transform4(x, y, 1, 1, inverse);
    const a = vec3(near[0] / near[3], near[1] / near[3], near[2] / near[3]);
    const b = vec3(far[0] / far[3], far[1] / far[3], far[2] / far[3]);
    return { origin: camera.position, direction: V.normalize(V.sub(b, a)) };
  }

  /** "2.05 Kitchen" (number and name). */
  private roomLabel(room: number): string {
    const r = this.session.scene.rooms[room];
    if (!r) { return 'no room'; }
    return !r.number.trim() || r.number === '—' ? r.name : `${r.number} ${r.name}`;
  }

  // #endregion

  // #region Run, clear, export

  /** RUN: the sun positions over the range (above the horizon), then the time-sliced ray casting. */
  private run(): void {
    const session = this.session;
    if (this.gridDirty) { this.update(); }
    if (this.study.cellCount === 0) {
      session.sound.play(SoundId.Error);
      this.notice = 'Nothing to test: select a room (THIS ROOM) or click surfaces';
      return;
    }
    const year = new Date().getFullYear();
    const settings = cleanSunHoursSettings(this.settings, year);
    const { directions, samples, locationKnown } = SunHours.sunDirections(session.scene.site, year, settings);
    this.opaqueOnly = !settings.glassBlocks;
    this.study.start(directions, samples, settings);
    this.summary = null;
    this.stale = false;
    this.legendTitle = `DIRECT SUN HOURS · ${settings.day} ${MONTHS[settings.month - 1]} ${clock(settings.startMinutes)}–${clock(settings.endMinutes)}` +
      ` · ${settings.stepMinutes} min${settings.glassBlocks ? ' · glass blocks' : ''}`;
    this.notice = directions.length === 0 ? 'The sun is below the horizon for the whole range: every cell gets 0 h'
      : locationKnown ? null : 'No site location in this model: Sydney assumed (set Revit\'s Location)';
    session.sound.play(SoundId.UiClick);
  }

  /** CLEAR RESULTS: the grid stays selected, the colours go. */
  private clearResults(): void {
    this.study.cancel();
    this.gridDirty = true;
    this.summary = null;
    this.notice = 'Results cleared';
  }

  /** The study as CSV: the settings, then one row per cell (surface, element, point and normal in Revit internal metres, hours). */
  private exportCsv(): void {
    const session = this.session, study = this.study, scene = session.scene;
    const s = study.runSettings, grid = study.settings;
    if (!study.hours || study.done === 0 || !s || !grid) { return; }
    const csv = (value: string) => (/[,"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const n3 = (v: number) => String(Math.round(v * 1000) / 1000);
    const lines = [
      'BimGo direct sun hours',
      `Model,${csv(scene.modelTitle)}`,
      `Date,${s.day} ${MONTHS[s.month - 1]}`,
      `From,${clock(s.startMinutes)}`,
      `To,${clock(s.endMinutes)}`,
      `Step (min),${s.stepMinutes}`,
      `Daylight saving,${s.daylightSaving ? 'yes' : 'no'}`,
      `Glass,${s.glassBlocks ? 'blocks sun' : 'lets sun through'}`,
      `Grid (m),${grid.gridSize}`,
      `Floor offset (m),${grid.floorOffset}`,
      `Wall offset (m),${grid.wallOffset}`,
      `Sun samples above the horizon,${study.sunSamples} of ${study.totalSamples}`,
      `Summary,${csv(this.summary ?? 'incomplete')}`,
      '',
      'Cell,Surface,Element id,Element,Room,X (m),Y (m),Z (m),Normal X,Normal Y,Normal Z,Sun hours'
    ];
    for (let i = 0; i < study.done; i++) {
      const cell = study.cell(i);
      const face = study.faces[cell.face];
      const record = scene.elements[face.element];
      const world = session.toRevit(cell.point);
      lines.push([String(i + 1), face.horizontal ? 'Floor' : 'Wall', String(record.elementId), csv(record.name),
        csv(face.room >= 0 ? this.roomLabel(face.room) : ''), n3(world.x), n3(world.y), n3(world.z),
        n3(cell.normal.x), n3(cell.normal.y), n3(cell.normal.z), n3(study.hours[i])].join(','));
    }
    downloadBlob(new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), `${safeFileName(scene.modelTitle)} sun hours.csv`);
    this.notice = `Exported ${study.done.toLocaleString('en')} cells (your Downloads folder)`;
    session.sound.play(SoundId.Commit);
  }

  // #endregion

  // #region Drawing

  /**
   * The grid in the 3D pass: computed cells in their legend colour, the rest grey (a preview while the panel is open,
   * "not yet" while running). Rebuilt only when the study changes. Nothing when closed without results.
   */
  drawCells(): void {
    const study = this.study, camera = this.session.camera;
    if (study.cellCount === 0 || (!this.open && !study.hours) || !study.settings) { return; }
    if (!this.overlay) {
      this.overlay = new Overlay3D();
      this.overlay.initialise();
    }
    if (this.overlayRevision !== study.revision) {
      this.overlayRevision = study.revision;
      this.overlay.begin(camera);
      const half = study.settings.gridSize * 0.47;
      const pending = Rgba.hex(0xe5e7eb, study.running ? 0.25 : 0.45);
      for (let i = 0; i < study.cellCount; i++) {
        const { point: p, u, v } = study.cell(i);
        let colour = pending;
        if (study.hours && i < study.done) {
          const [r, g, b] = SunHours.legendColour(study.hours[i]);
          colour = Rgba.fromFloat(r, g, b, 0.92);
        }
        const du = V.scale(u, half), dv = V.scale(v, half);
        this.overlay.quad(V.sub(V.sub(p, du), dv), V.sub(V.add(p, du), dv), V.add(V.add(p, du), dv), V.add(V.sub(p, du), dv), colour);
      }
    }
    this.overlay.draw(camera, true, 1, false);
  }

  /** The legend (bottom left, also in the study screenshot): Ladybug's colours from 0 to 7+ h and the study's date and times. */
  buildLegend(f: FontAtlas, x: number, y: number): void {
    if (!this.study.hours || !this.legendTitle) { return; }
    const ui = this.session.ui;
    const w = this.s(360), h = this.s(78);
    ui.panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.PANEL_BORDER);
    ui.text(f.small, x + this.s(12), y + this.s(8), this.legendTitle, UiTheme.SUN, this.s(0.5));

    const barX = x + this.s(12), barY = y + this.s(30), barW = w - this.s(24), barH = this.s(14);
    const steps = 56;
    for (let i = 0; i < steps; i++) {
      const [r, g, b] = SunHours.legendColour((i + 0.5) / steps * SunHours.LEGEND_MAX);
      ui.rect(barX + barW * i / steps, barY, barW / steps + 0.5, barH, Rgba.fromFloat(r, g, b, 1));
    }
    for (let hour = 0; hour <= SunHours.LEGEND_MAX; hour++) {
      const tx = barX + barW * hour / SunHours.LEGEND_MAX;
      ui.rect(tx - this.s(0.5), barY + barH, this.s(1), this.s(4), UiTheme.TEXT_SOFT);
      ui.textCentred(f.small, tx, barY + barH + this.s(6), hour === SunHours.LEGEND_MAX ? `${hour}+ h` : String(hour), UiTheme.TEXT_SOFT);
    }
  }

  /** The study panel (right side): date, time range and step, DST, grid, offsets, glass, surfaces, RUN, results and exports. */
  buildPanel(f: FontAtlas, input: InputState): void {
    const session = this.session, ui = session.ui, w = this.w, study = this.study;
    if (!input.leftDown) { w.activeSlider = -1; }
    const pw = this.s(380), x = session.screenWidth - this.s(20) - pw, y = this.s(20);
    const ph = Math.min(session.screenHeight - this.s(40), this.s(700));
    this.panelRect = [x, y, pw, ph];
    ui.panel(x, y, pw, ph, UiTheme.PANEL_STRONG, UiTheme.SUN);
    const ix = x + this.s(16), iw = pw - this.s(32);
    let cy = y + this.s(14);
    ui.text(f.small, ix, cy, 'SUN HOURS STUDY', UiTheme.SUN, this.s(1.4));
    cy += this.s(28);

    const shift = input.isDown(Vk.SHIFT);
    const locked = study.running;
    const s = this.settings;
    const year = new Date().getFullYear();

    // Date: « month » ‹ day ›
    ui.text(f.body, ix, cy + this.s(7), 'Date', UiTheme.TEXT_SOFT);
    const fx = ix + this.s(110);
    if (w.smallButton(f, fx, cy, this.s(30), this.s(30), '«') && !locked) { s.month = (s.month + 10) % 12 + 1; this.changed(false); }
    if (w.smallButton(f, fx + this.s(34), cy, this.s(30), this.s(30), '‹') && !locked) { this.stepDay(-1, year); this.changed(false); }
    const days = new Date(Date.UTC(year, s.month, 0)).getUTCDate();
    ui.textCentred(f.bold, fx + this.s(118), cy + this.s(6), `${Math.min(s.day, days)} ${MONTHS[s.month - 1]}`, UiTheme.TEXT);
    if (w.smallButton(f, fx + this.s(172), cy, this.s(30), this.s(30), '›') && !locked) { this.stepDay(1, year); this.changed(false); }
    if (w.smallButton(f, fx + this.s(206), cy, this.s(30), this.s(30), '»') && !locked) { s.month = s.month % 12 + 1; this.changed(false); }
    cy += this.s(38);

    // From / to (15 min steps; Shift: 1 h)
    const step = shift ? 60 : 15;
    cy = this.timeRow(f, ix, cy, 'From', true, step, locked);
    cy = this.timeRow(f, ix, cy, 'To', false, step, locked);

    ui.text(f.body, ix, cy + this.s(7), 'Sample every', UiTheme.TEXT_SOFT);
    const stepIndex = Math.max(0, SUN_HOURS_STEPS.indexOf(s.stepMinutes));
    const newStep = w.segmented(f, ix + this.s(110), cy, iw - this.s(110), STEP_OPTIONS, stepIndex);
    if (newStep !== stepIndex && !locked) { s.stepMinutes = SUN_HOURS_STEPS[newStep]; this.changed(false); }
    cy += this.s(40);

    const dst = w.checkbox(f, ix, cy + this.s(4), iw, 'Daylight saving (+1 h)', s.daylightSaving);
    if (dst !== s.daylightSaving && !locked) { s.daylightSaving = dst; this.changed(false); }
    cy += this.s(28);
    const glass = w.checkbox(f, ix, cy + this.s(4), iw, 'Glass blocks sun (off: sun passes through)', s.glassBlocks);
    if (glass !== s.glassBlocks && !locked) { s.glassBlocks = glass; this.changed(false); }
    cy += this.s(34);

    // Grid and offsets (these rebuild the grid)
    ui.text(f.body, ix, cy + this.s(7), 'Grid', UiTheme.TEXT_SOFT);
    const gridIndex = Math.max(0, SUN_HOURS_GRID_SIZES.indexOf(s.gridSize));
    const newGrid = w.segmented(f, ix + this.s(110), cy, iw - this.s(110), GRID_OPTIONS, gridIndex);
    if (newGrid !== gridIndex && !locked) { s.gridSize = SUN_HOURS_GRID_SIZES[newGrid]; this.changed(true); }
    cy += this.s(40);
    const floorOffset = this.offsetRow(f, ix, cy, 'Floor offset', s.floorOffset, 2);
    cy += this.s(38);
    const wallOffset = this.offsetRow(f, ix, cy, 'Wall offset', s.wallOffset, 1);
    cy += this.s(38);
    if (!locked && (floorOffset !== s.floorOffset || wallOffset !== s.wallOffset)) {
      s.floorOffset = floorOffset;
      s.wallOffset = wallOffset;
      this.changed(true);
    }

    // Surfaces
    cy += this.s(4);
    ui.rect(ix, cy, iw, this.s(1), UiTheme.PANEL_BORDER);
    cy += this.s(10);
    ui.text(f.body, ix, cy, `${this.faces.length.toLocaleString('en')} ${this.faces.length === 1 ? 'surface' : 'surfaces'} · ${study.cellCount.toLocaleString('en')} cells`, UiTheme.TEXT);
    cy += this.s(22);
    ui.textWrapped(f.small, ix, cy, iw, 'Click a wall or floor to add / remove it · RMB-drag to look', UiTheme.TEXT_MUTED, 1);
    cy += this.s(22);
    if (w.smallButton(f, ix, cy, this.s(170), this.s(30), 'THIS ROOM') && !locked) {
      const room = session.currentRoomIndex;
      this.selectRoomFaces(room);
      if (room >= 0) { this.notice = 'Selected: ' + this.roomLabel(room); }
    }
    if (w.smallButton(f, ix + this.s(178), cy, this.s(170), this.s(30), 'CLEAR SURFACES') && !locked) {
      this.faces.length = 0;
      this.gridDirty = true;
    }
    cy += this.s(42);

    // Run / progress
    if (study.running) {
      const fraction = study.cellCount === 0 ? 1 : study.done / study.cellCount;
      ui.rect(ix, cy + this.s(8), iw - this.s(110), this.s(12), UiTheme.CONTROL);
      ui.rect(ix, cy + this.s(8), (iw - this.s(110)) * fraction, this.s(12), UiTheme.SUN);
      if (w.smallButton(f, ix + iw - this.s(100), cy, this.s(100), this.s(30), 'CANCEL')) {
        study.cancel();
        this.notice = 'Cancelled: the cells done so far keep their colour';
      }
    } else if (w.menuButton(f, ix, cy, iw, this.stale ? 'RUN (settings changed)' : 'RUN', true, false, study.cellCount > 0, this.s(40))) {
      this.run();
    }
    cy += this.s(50);

    // Results and exports
    if (this.summary) { cy += this.s(2) + ui.textWrapped(f.small, ix, cy, iw, this.summary, UiTheme.TEXT, 2) + this.s(6); }
    const results = study.hours !== null && study.done > 0 && !study.running;
    const third = (iw - this.s(16)) / 3;
    if (w.smallButton(f, ix, cy, third, this.s(30), 'EXPORT CSV') && results) { this.exportCsv(); }
    if (w.smallButton(f, ix + third + this.s(8), cy, third, this.s(30), 'SCREENSHOT') && results) { this.shotRequested = true; }
    if (w.smallButton(f, ix + (third + this.s(8)) * 2, cy, third, this.s(30), 'CLEAR') && study.hours) { this.clearResults(); }
    cy += this.s(40);

    if (this.notice) { ui.textWrapped(f.small, ix, cy, iw, this.notice, UiTheme.MEASURE_TEXT, 2); }
    if (w.smallButton(f, ix, y + ph - this.s(44), iw, this.s(30), 'CLOSE (J / ESC) · results stay')) { this.close(); }
  }

  private timeRow(f: FontAtlas, x: number, y: number, label: string, start: boolean, step: number, locked: boolean): number {
    const ui = this.session.ui, w = this.w, s = this.settings;
    ui.text(f.body, x, y + this.s(7), label, UiTheme.TEXT_SOFT);
    const fx = x + this.s(110);
    const value = start ? s.startMinutes : s.endMinutes;
    let changed = value;
    if (w.smallButton(f, fx, y, this.s(40), this.s(30), '−')) { changed = value - step; }
    ui.textCentred(f.bold, fx + this.s(99), y + this.s(6), clock(value), UiTheme.TEXT);
    if (w.smallButton(f, fx + this.s(158), y, this.s(40), this.s(30), '+')) { changed = value + step; }
    if (changed !== value && !locked) {
      if (start) { s.startMinutes = Math.min(Math.max(changed, 0), s.endMinutes - 5); }
      else { s.endMinutes = Math.min(Math.max(changed, s.startMinutes + 5), 24 * 60); }
      this.changed(false);
    }
    return y + this.s(38);
  }

  /** An offset row (0.05 m steps) with − / +; returns the value after this frame's clicks. */
  private offsetRow(f: FontAtlas, x: number, y: number, label: string, value: number, max: number): number {
    const ui = this.session.ui, w = this.w;
    ui.text(f.body, x, y + this.s(7), label, UiTheme.TEXT_SOFT);
    const fx = x + this.s(110);
    let changed = value;
    if (w.smallButton(f, fx, y, this.s(40), this.s(30), '−')) { changed = value - 0.05; }
    ui.textCentred(f.bold, fx + this.s(99), y + this.s(6), `${value.toFixed(2)} m`, UiTheme.TEXT);
    if (w.smallButton(f, fx + this.s(158), y, this.s(40), this.s(30), '+')) { changed = value + 0.05; }
    return changed === value ? value : Math.round(Math.min(Math.max(changed, 0), max) * 20) / 20;
  }

  /** A setting changed: grid settings rebuild the grid (results go); time settings only mark results stale. */
  private changed(rebuildGrid: boolean): void {
    if (rebuildGrid) { this.gridDirty = true; }
    else if (this.study.hours) { this.stale = true; }
  }

  private stepDay(delta: number, year: number): void {
    const s = this.settings;
    const days = new Date(Date.UTC(year, s.month, 0)).getUTCDate();
    const date = new Date(Date.UTC(year, s.month - 1, Math.min(Math.max(s.day, 1), days) + delta));
    s.month = date.getUTCMonth() + 1;
    s.day = date.getUTCDate();
  }

  // #endregion

  dispose(): void {
    this.overlay?.dispose();
    this.overlay = null;
  }
}
