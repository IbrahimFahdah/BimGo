import { type SunStudyDocument, type SunStudyFace, type SunStudyInfo, SunStudyFiles, studyKeySource } from '../core/format/SunStudyFiles';
import { type Vec3, Vec3 as V, vec3 } from '../core/math/Vector';
import { findCategory } from '../core/scene/CategoryCatalog';
import { Daylight } from '../core/scene/Daylight';
import { Aabb, roomContains, roomDistanceToBoundary } from '../core/scene/SceneData';
import {
  cleanSunHoursSettings, defaultSunHoursSettings, passFail, STUDY_RAY_COUNTS, StudyMode, SUN_HOURS_GRID_SIZES, SUN_HOURS_STEPS, SunHours,
  type SunHoursSettings, SunTarget
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
import { type DaylightInputs, NO_ROOM_LIGHT, RayOutcome, type RoomLight, SunHoursFace, SunHoursStudy } from './SunHoursStudy';

const GRID_OPTIONS = ['0.1', '0.25', '0.5', '1 m'];
const STEP_OPTIONS = ['5 min', '10 min', '15 min'];
const MODE_OPTIONS = ['Sun hours', 'Daylight %', 'Lux'];
const RAY_OPTIONS = ['128', '256', '512'];
const REFLECTANCE_OPTIONS = ['From colours', 'Standard'];
/** Ray casting time per frame while a study runs (ms). */
const SUN_BUDGET_MS = 10;

/** "09:00". */
function clock(minutes: number): string {
  return `${String(Math.trunc(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;
const grouped = (v: number) => Math.round(v).toLocaleString('en');
/** "0.##" style: up to `decimals` places, no trailing zeros. */
const trim = (v: number, decimals: number) => String(Math.round(v * 10 ** decimals) / 10 ** decimals);

/** "Sun hours", "Daylight factor", "Illuminance". */
export function modeName(mode: StudyMode): string {
  return mode === StudyMode.DaylightFactor ? 'Daylight factor' : mode === StudyMode.Illuminance ? 'Illuminance' : 'Sun hours';
}

/**
 * The study panel (port of GameSession.SunHours.cs and GameSession.Daylight.cs): sun hours, daylight factor (CIE
 * overcast) and illuminance (CIE clear sky + sun) modes. J (or pause menu → SUN HOURS) opens it: the player stands
 * still, the cursor is free, RMB-drag looks around. The walls and floors of the room you stand in are selected (the
 * floor only in daylight modes); clicking a surface adds or removes it. RUN casts rays from every grid cell a few
 * milliseconds per frame and colours the cells on the mode's legend, or green / red with the pass / fail test.
 * Results stay until CLEAR or the session ends; EXPORT CSV, SCREENSHOT and SAVE STUDY keep them. Daylight results
 * are early design indicators, not a compliance simulation.
 */
export class SunHoursMode {
  open = false;
  private readonly w: Widgets;
  private settings: SunHoursSettings = defaultSunHoursSettings();
  readonly study = new SunHoursStudy();
  private readonly faces: SunHoursFace[] = [];
  private facesRoom = -1;
  private gridDirty = true;
  private overlay: Overlay3D | null = null;
  private overlayRevision = -1;
  private overlayColourKey = -1;
  private opaqueOnly = true;
  private panelRect = [0, 0, 0, 0];
  /** The study's screenshot (3D view + legend) is due this frame. */
  shotRequested = false;
  private notice: string | null = null;
  private summary: string | null = null;
  private legendTitle: string | null = null;
  private stale = false;
  // Daylight: the rooms' figures from the last run, for the summary and the CSV
  private roomLight: RoomLight[] | null = null;
  private roomNote: string | null = null;
  // Pass / fail legend labels (cached when results or the target change)
  private passLabel: string | null = null;
  private failLabel: string | null = null;
  // Saved studies: the list view, its rows and the armed DELETE
  private studiesView = false;
  private studyList: SunStudyInfo[] = [];
  private studyScroll = 0;
  private deleteArmed: string | null = null;
  private deleteArmedUntil = 0;

  constructor(private readonly session: GameSession) {
    this.w = new Widgets(session);
  }

  private s(v: number): number { return this.session.s(v); }

  /** The suffix of the study screenshot's file name ("sun hours", "daylight factor", "illuminance"). */
  get shotSuffix(): string {
    return modeName(this.study.mode).toLowerCase();
  }

  // #region Open / close

  /** Opens the panel; the first time (or with nothing selected) it selects the room you stand in. */
  show(): void {
    const session = this.session;
    if (this.open) { return; }
    if (session.paused) { session.setPaused(false); }
    session.closeModes(this);
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
      this.refreshSummary();
      console.info(`${modeName(this.study.mode)}: ${this.study.cellCount.toLocaleString('en')} cells, ${this.study.sunSamples} time samples, ` +
        `${(this.study.elapsed / 1000).toFixed(1)} s. ${this.summary}.`);
      session.sound.play(SoundId.Commit);
      session.toast(`${modeName(this.study.mode)} study done: ${this.summary}`, 4);
    }
  }

  /** The results' summary and the pass / fail legend labels (after a run, a load, or a target change). */
  private refreshSummary(): void {
    this.passLabel = this.failLabel = null;
    const study = this.study, s = this.settings;
    if (!study.hours || study.done === 0 || study.running) {
      this.summary = null;
      return;
    }
    const st = study.statistics();
    const note = this.roomNote ? ' · ' + this.roomNote : '';
    let target: string;
    switch (study.mode) {
      case StudyMode.DaylightFactor:
        this.summary = `Average DF ${st.average.toFixed(1)} % · min ${st.min.toFixed(1)} · max ${st.max.toFixed(1)}${note}`;
        target = `DF ≥ ${trim(s.factorTarget, 1)} %`;
        break;
      case StudyMode.Illuminance:
        this.summary = `Average ${grouped(st.average)} lux · min ${grouped(st.min)} · max ${grouped(st.max)}${note}`;
        target = `≥ ${Math.round(study.runSettings?.luxTarget ?? s.luxTarget)} lux for ${pct(s.luxShare)} of the time`;
        break;
      default:
        this.summary = `Average ${st.average.toFixed(1)} h · min ${st.min.toFixed(1)} · max ${st.max.toFixed(1)} · ${pct(st.atLeast2)} ≥ 2 h · ${pct(st.atLeast3)} ≥ 3 h`;
        target = `≥ ${trim(s.targetHours, 2)} h`;
        break;
    }
    if (passFail(s)) {
      const pass = study.passShare(s);
      this.summary += ` · pass (${target}): ${pct(pass)} of the area`;
      this.passLabel = `PASS ${target} · ${pct(pass)}`;
      this.failLabel = `FAIL · ${pct(1 - pass)}`;
    }
  }

  /** PASS / FAIL: on shows the mode's test (green / red), off the values on their legend. */
  private togglePassFail(): void {
    this.settings.target = passFail(this.settings) ? SunTarget.Off : SunTarget.On;
    this.refreshSummary();
    this.notice = passFail(this.settings) ? 'Pass / fail test on: cells pass (green) or fail (red) the target' : 'Pass / fail test off: cells show their values';
  }

  /** Mode selector: results go; the room is selected again for the mode (daylight: its floor at the work plane). */
  private setMode(mode: StudyMode): void {
    if (mode === this.settings.mode) { return; }
    this.study.cancel();
    this.settings.mode = mode;
    this.selectRoomFaces(this.facesRoom >= 0 ? this.facesRoom : this.session.currentRoomIndex);
    this.summary = null;
    this.passLabel = this.failLabel = null;
    this.legendTitle = null;
    this.notice = mode === StudyMode.DaylightFactor ? 'Daylight factor: overcast sky, no date or time. An early design indicator, not a compliance tool'
      : mode === StudyMode.Illuminance ? 'Illuminance: clear sky (+ sun) over the day\'s times. An early design indicator, not a compliance tool' : null;
  }

  /** The legend title for a run ("DIRECT SUN HOURS · 21 Jun 09:00–15:00 · 5 min…"). */
  private titleFor(settings: SunHoursSettings, studyName: string | null = null): string {
    const name = studyName ? ' · ' + studyName.toUpperCase() : '';
    const times = `${settings.day} ${MONTHS[settings.month - 1]} ${clock(settings.startMinutes)}–${clock(settings.endMinutes)} · ${settings.stepMinutes} min`;
    switch (settings.mode) {
      case StudyMode.DaylightFactor: return `DAYLIGHT FACTOR · CIE OVERCAST SKY · WORK PLANE ${settings.workPlane.toFixed(2)} m${name}`;
      case StudyMode.Illuminance: return `ILLUMINANCE · CLEAR SKY${settings.directSun ? ' + SUN' : ''} · ${times}${name}`;
      default: return `DIRECT SUN HOURS · ${times}${settings.glassBlocks ? ' · glass blocks' : ''}${name}`;
    }
  }

  // #endregion

  // #region Targets

  /**
   * Selects the walls and floors of a room (replacing the selection; daylight modes: the floor only): every opaque
   * wall or floor triangle near the room, grouped into faces by element and plane.
   */
  private selectRoomFaces(roomIndex: number): void {
    const session = this.session, scene = session.scene;
    this.faces.length = 0;
    this.facesRoom = roomIndex;
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
    const sunHours = this.settings.mode === StudyMode.SunHours;

    scene.elements.forEach((record, e) => {
      const isWall = record.categoryIndex === walls && sunHours, isFloor = record.categoryIndex === floors;
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

  /** A click on the model: removes the surface under the cursor when selected, else adds it (clipped to the room it faces). */
  private pickFace(mouseX: number, mouseY: number): void {
    const session = this.session, scene = session.scene;
    const { origin, direction } = session.screenRay(mouseX, mouseY);
    const hit = session.pickStaticVisible(origin, direction, 300);
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

    const record = scene.elements[hit.element];
    const face = new SunHoursFace(hit.element, n, offset);
    face.picked = true;
    this.addPlaneTriangles(face);
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
    this.notice = `Added: ${record.name}${face.room >= 0 ? ` (in ${session.roomLabel(face.room)})` : ''}`;
  }

  /** The face's element triangles in its plane (within 2 cm). */
  private addPlaneTriangles(face: SunHoursFace): void {
    const scene = this.session.scene, record = scene.elements[face.element];
    const g = scene.geometry, indices = g.indices, n = face.normal, offset = face.offset;
    for (let i = record.opaqueStart; i + 2 < record.opaqueStart + record.opaqueCount; i += 3) {
      const a = g.position(indices[i]), b = g.position(indices[i + 1]), c = g.position(indices[i + 2]);
      if (Math.abs(V.dot(n, a) - offset) > 0.02 || Math.abs(V.dot(n, b) - offset) > 0.02 || Math.abs(V.dot(n, c) - offset) > 0.02) { continue; }
      if (V.lengthSquared(V.cross(V.sub(b, a), V.sub(c, a))) < 1e-10) { continue; }
      face.triangles.push([a, b, c]);
    }
  }

  // #endregion

  // #region Run, clear, export

  /** RUN: sun hours (sun positions, then time-sliced ray casting) or a daylight mode. */
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
    if (settings.mode !== StudyMode.SunHours) {
      this.runDaylight(settings);
      return;
    }
    this.roomNote = null;
    this.roomLight = null;
    const { directions, samples, locationKnown } = SunHours.sunDirections(session.scene.site, year, settings);
    this.opaqueOnly = !settings.glassBlocks;
    this.study.start(directions, samples, settings);
    this.summary = null;
    this.stale = false;
    this.legendTitle = this.titleFor(settings);
    this.notice = directions.length === 0 ? 'The sun is below the horizon for the whole range: every cell gets 0 h'
      : locationKnown ? null : 'No site location in this model: Sydney assumed (set Revit\'s Location)';
    session.sound.play(SoundId.UiClick);
  }

  /** RUN in a daylight mode: rays, skies (overcast, or clear per time sample), the rooms' figures, then the study. */
  private runDaylight(settings: SunHoursSettings): void {
    const session = this.session, scene = session.scene, grid = this.study.settings!;
    const inputs: DaylightInputs = {
      mode: settings.mode,
      classify: (origin, direction, room) => this.classifyRay(origin, direction, room),
      rays: Daylight.cosineDirections(settings.rays),
      overcast: null, suns: [], clear: [], diffuse: [], directNormal: [], totalSamples: 0,
      directSun: settings.directSun,
      luxTarget: settings.luxTarget,
      rooms: null,
      cellArea: grid.gridSize * grid.gridSize
    };

    let known = true;
    if (settings.mode === StudyMode.DaylightFactor) {
      inputs.overcast = new Float32Array(Daylight.PATCHES);
      Daylight.overcastPatches(inputs.overcast);
    } else {
      const sun = SunHours.sunDirections(scene.site, new Date().getFullYear(), settings);
      known = sun.locationKnown;
      inputs.totalSamples = sun.samples;
      inputs.suns = sun.directions;
      for (const direction of sun.directions) {
        const patches = new Float32Array(Daylight.PATCHES);
        inputs.diffuse.push(Daylight.clearPatches(direction, patches));
        inputs.clear.push(patches);
        inputs.directNormal.push(Daylight.directNormalClear(direction.z));
      }
    }

    // Each room a cell is clipped to
    inputs.rooms = scene.rooms.map(() => NO_ROOM_LIGHT);
    let rooms = 0;
    for (const face of this.study.faces) {
      if (face.room < 0 || face.room >= scene.rooms.length || inputs.rooms[face.room].valid) { continue; }
      inputs.rooms[face.room] = this.computeRoomLight(face.room, settings.standardReflectance);
      rooms++;
    }
    this.roomLight = inputs.rooms;
    this.roomNote = roomNote(inputs.rooms, rooms);

    if (!this.study.startDaylight(inputs, settings)) {
      this.notice = `Too many cells × time samples for one illuminance run: pick a larger grid or a longer step (at most ${SunHoursStudy.MAX_LUX_VALUES / 1_000_000} million)`;
      session.sound.play(SoundId.Error);
      return;
    }
    this.summary = null;
    this.passLabel = this.failLabel = null;
    this.stale = false;
    this.legendTitle = this.titleFor(settings);
    this.notice = settings.mode === StudyMode.Illuminance && inputs.suns.length === 0 ? 'The sun is below the horizon for the whole range: every cell gets 0 lux'
      : !known ? 'No site location in this model: Sydney assumed (set Revit\'s Location)'
        : rooms === 0 ? 'No room under these surfaces: no internally reflected light is added (values are low)' : null;
    console.info(`${modeName(settings.mode)} run: ${this.study.cellCount} cells, ${settings.rays} rays, ${inputs.suns.length} time samples, ${rooms} rooms. ${this.roomNote ?? ''}`);
    session.sound.play(SoundId.UiClick);
  }

  /**
   * Follows a daylight ray: the first opaque surface decides between the cell's own room (internal: left to the IRC)
   * and outside surfaces; nothing in the way means sky (above the horizon) or ground. Glass in front of where it ends
   * multiplies by the glass transmittance.
   */
  private classifyRay(origin: Vec3, direction: Vec3, room: number): { outcome: RayOutcome; transmit: number } {
    const MAX = 1500;
    const session = this.session;
    let hit = session.castStatic(origin, direction, MAX, true);
    let end = hit ? hit.distance : MAX;
    const moved = session.dynamics.raycast(origin, direction, end, null, true);
    if (moved) {
      hit = moved;
      end = moved.distance;
    }
    // Anything hit before the opaque surface (or the sky) is see-through: glass
    const transmit = end > 0.002 && session.castStatic(origin, direction, end - 0.001, false) ? Daylight.GLASS_VLT : 1;
    if (hit) { return { outcome: this.isInsideRoom(room, hit.point) ? RayOutcome.Internal : RayOutcome.External, transmit }; }
    return { outcome: direction.z > 0 ? RayOutcome.Sky : RayOutcome.Ground, transmit };
  }

  /** True when a point belongs to a room's own surfaces: in its plan (or within 0.45 m of its boundary) and height. */
  private isInsideRoom(room: number, point: Vec3): boolean {
    const r = this.session.scene.rooms[room];
    if (!r || point.z < r.bottomZ - 0.3 || point.z > r.topZ + 1) { return false; }
    return roomContains(r, point) || roomDistanceToBoundary(r, point) < 0.45;
  }

  /**
   * A room's daylight figures: floor area and perimeter from its boundary, its height, the surface total; the glazed
   * area (see-through triangles in its walls and over it, halved as panes have two faces); reflectances from the
   * colours of its floor, walls and ceiling (or standard ones); and the split-flux IRC.
   */
  private computeRoomLight(roomIndex: number, standard: boolean): RoomLight {
    const session = this.session, scene = session.scene, room = scene.rooms[roomIndex];
    let floorArea = 0, perimeter = 0;
    for (const loop of room.loops) {
      if (loop.length < 3) { continue; }
      let signed = 0;
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        signed += a.x * b.y - b.x * a.y;
        perimeter += Math.hypot(b.x - a.x, b.y - a.y);
      }
      floorArea += signed * 0.5;
    }
    floorArea = Math.abs(floorArea);
    let height = room.topZ - room.bottomZ;
    if (!Number.isFinite(height) || height < 2 || height > 8) { height = 2.7; }
    if (floorArea < 0.5) { return NO_ROOM_LIGHT; }
    const wallArea = perimeter * height;

    const walls = findCategory('walls')?.index ?? -1, floors = findCategory('floors')?.index ?? -1;
    const box = new Aabb(vec3(room.min.x - 0.6, room.min.y - 0.6, room.bottomZ - 0.5), vec3(room.max.x + 0.6, room.max.y + 0.6, room.topZ + 1.5));
    let glass = 0, floorSum = 0, floorWeight = 0, wallSum = 0, wallWeight = 0, ceilingSum = 0, ceilingWeight = 0;
    const g = scene.geometry, indices = g.indices;

    scene.elements.forEach((record, e) => {
      if (!session.isPickable(e) || record.isLibraryTemplate || !record.bounds.overlaps(box)) { return; }

      // Glazing: see-through triangles in the room's walls or over it
      for (let i = record.transparentStart; i + 2 < record.transparentStart + record.transparentCount; i += 3) {
        const t = triangle(g.position(indices[i]), g.position(indices[i + 1]), g.position(indices[i + 2]));
        if (t.centre.z < room.bottomZ - 0.1 || t.centre.z > room.topZ + 1.5) { continue; }
        const vertical = Math.abs(t.normal.z) < 0.5;
        if ((vertical && (roomContains(room, t.centre) || roomDistanceToBoundary(room, t.centre) < 0.5))
          || (!vertical && roomContains(room, t.centre) && t.centre.z > room.bottomZ + 1.5)) {
          glass += t.area;
        }
      }
      if (standard) { return; }

      // Reflectances: area-weighted colours of the floor, the walls and whatever is overhead
      const isWall = record.categoryIndex === walls, isFloor = record.categoryIndex === floors;
      for (let i = record.opaqueStart; i + 2 < record.opaqueStart + record.opaqueCount; i += 3) {
        const t = triangle(g.position(indices[i]), g.position(indices[i + 1]), g.position(indices[i + 2]));
        const colour = g.colour(indices[i]);
        const reflectance = Daylight.reflectanceOf(colour & 0xff, (colour >>> 8) & 0xff, (colour >>> 16) & 0xff);
        const c = t.centre, n = t.normal;
        if (isFloor && n.z > 0.7 && Math.abs(c.z - room.bottomZ) < 0.15 && roomContains(room, c)) {
          floorSum += reflectance * t.area;
          floorWeight += t.area;
        } else if (isWall && Math.abs(n.z) < 0.3 && c.z > room.bottomZ - 0.1 && c.z < room.topZ + 0.3 && roomDistanceToBoundary(room, c) < 0.45) {
          wallSum += reflectance * t.area;
          wallWeight += t.area;
        } else if (n.z < -0.7 && c.z > room.bottomZ + 1.8 && c.z < room.topZ + 1.5 && roomContains(room, c)) {
          ceilingSum += reflectance * t.area;
          ceilingWeight += t.area;
        }
      }
    });

    const f = Math.fround;
    const light: RoomLight = {
      valid: true,
      windowArea: f(glass * 0.5),
      floorReflectance: floorWeight > 0 ? f(floorSum / floorWeight) : Daylight.FLOOR_REFLECTANCE,
      wallReflectance: wallWeight > 0 ? f(wallSum / wallWeight) : Daylight.WALL_REFLECTANCE,
      ceilingReflectance: ceilingWeight > 0 ? f(ceilingSum / ceilingWeight) : Daylight.CEILING_REFLECTANCE,
      totalArea: 0, averageReflectance: 0, lowerReflectance: 0, upperReflectance: 0, ircPercent: 0
    };
    const windows = Math.min(light.windowArea, wallArea * 0.9);
    const total = 2 * floorArea + wallArea;
    light.totalArea = f(total);
    light.averageReflectance = f((light.floorReflectance * floorArea + light.ceilingReflectance * floorArea
      + light.wallReflectance * (wallArea - windows) + 0.1 * windows) / total);
    const halfWall = wallArea * 0.5;
    light.lowerReflectance = f((light.floorReflectance * floorArea + light.wallReflectance * halfWall) / (floorArea + halfWall));
    light.upperReflectance = f((light.ceilingReflectance * floorArea + light.wallReflectance * halfWall) / (floorArea + halfWall));
    light.ircPercent = Daylight.internalReflectedPercent(windows, total, light.averageReflectance, light.lowerReflectance, light.upperReflectance);
    return light;
  }

  /** CLEAR RESULTS: the grid stays selected, the colours go. */
  private clearResults(): void {
    this.study.cancel();
    this.gridDirty = true;
    this.summary = null;
    this.passLabel = this.failLabel = null;
    this.notice = 'Results cleared';
  }

  /** The study as CSV: the settings, then one row per cell (surface, element, point and normal in Revit internal metres, value). */
  private exportCsv(): void {
    const session = this.session, study = this.study, scene = session.scene;
    const s = study.runSettings, grid = study.settings;
    if (!study.hours || study.done === 0 || !s || !grid) { return; }
    const csv = (value: string) => (/[,"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const n3 = (v: number) => trim(v, 3);
    const mode = study.mode, test = passFail(this.settings), t = this.settings;
    const lines = [`BimGo ${modeName(mode).toLowerCase()}`, `Model,${csv(scene.modelTitle)}`];
    if (mode !== StudyMode.DaylightFactor) {
      lines.push(`Date,${s.day} ${MONTHS[s.month - 1]}`, `From,${clock(s.startMinutes)}`, `To,${clock(s.endMinutes)}`, `Step (min),${s.stepMinutes}`,
        `Daylight saving,${s.daylightSaving ? 'yes' : 'no'}`, `Time samples (sun up),${study.sunSamples} of ${study.totalSamples}`);
    }
    if (mode === StudyMode.SunHours) {
      lines.push(`Glass,${s.glassBlocks ? 'blocks sun' : 'lets sun through'}`, `Floor offset (m),${grid.floorOffset}`,
        `Pass / fail test,${test ? `at least ${trim(t.targetHours, 2)} h` : 'off'}`);
    } else {
      lines.push(`Sky,${mode === StudyMode.DaylightFactor ? 'CIE overcast' : 'CIE clear' + (s.directSun ? ' + direct sun' : ' (no direct sun)')}`,
        `Work plane (m),${grid.workPlane}`, `Rays per cell,${s.rays}`, `Glass visible transmittance,${Daylight.GLASS_VLT}`,
        `Reflectances,${s.standardReflectance ? 'standard' : 'from colours'}`,
        mode === StudyMode.DaylightFactor
          ? `Pass / fail test,${test ? `DF at least ${trim(t.factorTarget, 1)} %` : 'off'}`
          : `Pass / fail test,${test ? `at least ${Math.round(s.luxTarget)} lux for ${pct(t.luxShare)} of the time` : 'off'}`,
        'Note,Early design indicator: sky and sun components by ray tracing; one external bounce; internal reflection by the BRE split-flux formula per room. Not a compliance simulation.');
      this.roomLight?.forEach((l, r) => {
        if (!l.valid) { return; }
        lines.push(`Room ${csv(session.roomLabel(r))},glazing ${l.windowArea.toFixed(1)} m2; surfaces ${l.totalArea.toFixed(1)} m2; reflectance ceiling ` +
          `${l.ceilingReflectance.toFixed(2)} walls ${l.wallReflectance.toFixed(2)} floor ${l.floorReflectance.toFixed(2)} average ${l.averageReflectance.toFixed(2)}; IRC ${l.ircPercent.toFixed(2)} %`);
      });
    }
    lines.push(`Grid (m),${grid.gridSize}`, `Wall offset (m),${grid.wallOffset}`, `Summary,${csv(this.summary ?? 'incomplete')}`, '');
    const valueColumn = mode === StudyMode.DaylightFactor ? 'Daylight factor (%)' : mode === StudyMode.Illuminance ? 'Average illuminance (lux),Time at or above target' : 'Sun hours';
    lines.push('Cell,Surface,Element id,Element,Room,X (m),Y (m),Z (m),Normal X,Normal Y,Normal Z,' + valueColumn + (test ? ',Pass' : ''));
    for (let i = 0; i < study.done; i++) {
      const cell = study.cell(i);
      const face = study.faces[cell.face];
      const record = scene.elements[face.element];
      const world = session.toRevit(cell.point);
      let value = mode === StudyMode.Illuminance ? String(Math.round(study.hours[i])) : n3(study.hours[i]);
      if (mode === StudyMode.Illuminance) { value += ',' + n3(study.shares?.[i] ?? 0); }
      lines.push([String(i + 1), face.horizontal ? 'Floor' : 'Wall', String(record.elementId), csv(record.name),
        csv(face.room >= 0 ? session.roomLabel(face.room) : ''), n3(world.x), n3(world.y), n3(world.z),
        n3(cell.normal.x), n3(cell.normal.y), n3(cell.normal.z), value].join(',') + (test ? (study.passes(i, this.settings) ? ',yes' : ',no') : ''));
    }
    const name = `${safeFileName(scene.modelTitle)} ${modeName(mode).toLowerCase()}.csv`;
    downloadBlob(new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), name);
    this.notice = `Exported ${study.done.toLocaleString('en')} cells to ${name} (your Downloads folder)`;
    session.sound.play(SoundId.Commit);
  }

  // #endregion

  // #region Saved studies

  /** The key this model's studies are stored under (browser storage; the desktop uses the model's BimGo folder). */
  private get studyKey(): string {
    const scene = this.session.scene;
    return studyKeySource(scene.provenance, this.session.documentName);
  }

  /** SAVE STUDY…: the text box asks for a name (suggested: room, day and times). */
  private beginName(): void {
    const run = this.study.runSettings ?? this.settings;
    const when = run.mode === StudyMode.DaylightFactor ? 'daylight factor'
      : `${run.mode === StudyMode.Illuminance ? 'lux ' : ''}${run.day} ${MONTHS[run.month - 1]} ${clock(run.startMinutes).replace(':', '.')}-${clock(run.endMinutes).replace(':', '.')}`;
    const suggestion = SunStudyFiles.safeName((this.facesRoom >= 0 ? this.session.roomLabel(this.facesRoom) + ' ' : '') + when);
    this.session.editor.nameSunStudy(suggestion, SunStudyFiles.MAX_NAME);
  }

  /** Saves the finished study under a name (same name replaces): settings, surfaces, every cell's point and value. */
  async saveStudy(name: string): Promise<void> {
    const session = this.session, study = this.study, scene = session.scene;
    if (!study.finished || !study.hours || !study.runSettings || !study.settings) {
      this.notice = 'Run the study first (only complete results can be saved)';
      session.sound.play(SoundId.Error);
      return;
    }
    const year = new Date().getFullYear();
    const run = cleanSunHoursSettings(study.runSettings, year);
    run.target = this.settings.target;
    run.targetHours = this.settings.targetHours;
    run.factorTarget = this.settings.factorTarget;
    run.luxShare = this.settings.luxShare;

    const origin = scene.originOffset;
    const document: SunStudyDocument = {
      version: 1, name: name.trim() || 'Study', saved: new Date().toISOString(), savedBy: session.settings.userName, model: scene.modelTitle ?? '',
      units: 'metres, Revit internal coordinates', grid: cleanSunHoursSettings(study.settings, year), run,
      sunSamples: study.sunSamples, totalSamples: study.totalSamples, faces: [], cellFaces: [], points: [], hours: [],
      shares: study.shares ? Array.from(study.shares) : null
    };
    for (const face of study.faces) {
      const record = scene.elements[face.element];
      const n = face.normal;
      const offset = face.offset + n.x * origin.x + n.y * origin.y + n.z * origin.z;
      document.faces.push({
        uniqueId: record.uniqueId || null, elementId: record.elementId, link: record.link, elementName: record.name ?? '',
        nx: Math.fround(n.x), ny: Math.fround(n.y), nz: Math.fround(n.z), offset: Math.round(offset * 1e5) / 1e5,
        bothSides: face.bothSides, picked: face.picked, roomKey: this.roomKey(face.room), roomLabel: face.room >= 0 ? session.roomLabel(face.room) : ''
      });
    }
    for (let i = 0; i < study.cellCount; i++) {
      const cell = study.cell(i);
      const world = session.toRevit(cell.point);
      document.cellFaces.push(cell.face);
      document.points.push(Math.fround(world.x), Math.fround(world.y), Math.fround(world.z));
      document.hours.push(study.hours[i]);
    }

    const error = await SunStudyFiles.write(this.studyKey, document);
    if (error) {
      this.notice = 'Study not saved: ' + error;
      session.sound.play(SoundId.Error);
      return;
    }
    this.legendTitle = this.titleFor(run, document.name);
    this.notice = `Saved “${document.name}” (${study.cellCount.toLocaleString('en')} cells) in this browser for this model`;
    session.sound.play(SoundId.Commit);
  }

  /** SAVED STUDIES…: lists this model's studies. */
  private openStudies(): void {
    this.studiesView = true;
    this.studyScroll = 0;
    this.deleteArmed = null;
    void this.refreshList();
  }

  private async refreshList(): Promise<void> {
    this.studyList = await SunStudyFiles.list(this.studyKey);
  }

  /** The saved studies list (in place of the study controls): name and date, LOAD and DELETE (twice), BACK. */
  private buildStudiesList(f: FontAtlas, x: number, y: number, w: number, bottom: number): void {
    const session = this.session, ui = session.ui, input = session.input, wd = this.w;
    ui.textWrapped(f.small, x, y, w, 'Saved in this browser for this model. LOAD shows the results again (the grid is laid again from the same surfaces).', UiTheme.TEXT_MUTED, 3);
    y += this.s(48);

    const listBottom = bottom - this.s(100), rowH = this.s(54);
    const visible = Math.max(1, Math.trunc((listBottom - y) / rowH));
    if (this.studyList.length === 0) {
      ui.textWrapped(f.body, x, y, w, 'No saved studies yet: RUN a study, then SAVE STUDY…', UiTheme.TEXT_MUTED, 2);
    } else {
      const maxScroll = Math.max(0, this.studyList.length - visible);
      if (input.wheel !== 0 && wd.hover(x, y, w, listBottom - y)) { this.studyScroll -= Math.sign(input.wheel); }
      this.studyScroll = Math.min(Math.max(this.studyScroll, 0), maxScroll);
      if (this.deleteArmed !== null && session.clock > this.deleteArmedUntil) { this.deleteArmed = null; }

      let load: SunStudyInfo | null = null, remove: SunStudyInfo | null = null;
      const last = Math.min(this.studyList.length, this.studyScroll + visible);
      for (let i = this.studyScroll; i < last; i++) {
        const info = this.studyList[i];
        const ry = y + (i - this.studyScroll) * rowH;
        ui.textWrapped(f.body, x, ry, w - this.s(150), info.name, UiTheme.TEXT, 1);
        ui.textWrapped(f.small, x, ry + this.s(22), w - this.s(150), shortDateTime(info.saved), UiTheme.TEXT_FAINT, 1);
        if (wd.smallButton(f, x + w - this.s(142), ry + this.s(4), this.s(66), this.s(30), 'LOAD')) { load = info; }
        const armed = this.deleteArmed === info.name;
        if (wd.smallButton(f, x + w - this.s(70), ry + this.s(4), this.s(70), this.s(30), armed ? 'SURE?' : 'DELETE', true)) { remove = info; }
      }
      if (load) { void this.loadStudy(load); }
      else if (remove) {
        if (this.deleteArmed === remove.name) {
          const info = remove;
          this.deleteArmed = null;
          void SunStudyFiles.delete(this.studyKey, info.name).then(ok => {
            this.notice = ok ? `Deleted “${info.name}”` : 'The study could not be deleted';
            return this.refreshList();
          });
          session.sound.play(SoundId.Remove);
        } else {
          this.deleteArmed = remove.name;
          this.deleteArmedUntil = session.clock + 3;
        }
      }
    }

    if (this.notice) { ui.textWrapped(f.small, x, bottom - this.s(92), w, this.notice, UiTheme.MEASURE_TEXT, 2); }
    if (wd.smallButton(f, x, bottom - this.s(44), w, this.s(30), 'BACK')) { this.studiesView = false; }
  }

  /**
   * Loads a saved study: its settings, its surfaces (found again by element and plane) and, when the grid comes out
   * the same, its results. Otherwise the surfaces stay selected and the study asks for a new RUN.
   */
  private async loadStudy(info: SunStudyInfo): Promise<void> {
    const session = this.session, scene = session.scene;
    const { document, error } = await SunStudyFiles.read(this.studyKey, info.name);
    if (!document) {
      this.notice = error;
      session.sound.play(SoundId.Error);
      return;
    }
    this.study.cancel();
    this.studiesView = false;

    const year = new Date().getFullYear();
    const settings = cleanSunHoursSettings(document.run, year);
    settings.gridSize = document.grid.gridSize;
    settings.floorOffset = document.grid.floorOffset;
    settings.wallOffset = document.grid.wallOffset;
    settings.workPlane = document.grid.workPlane;
    this.settings = settings;
    this.roomLight = null; // room figures aren't saved: the summary and CSV of a loaded study leave them out
    this.roomNote = null;

    this.faces.length = 0;
    let missing = 0;
    for (const saved of document.faces) {
      const face = this.rebuildFace(saved);
      if (face) { this.faces.push(face); } else { missing++; }
    }
    this.facesRoom = this.faces.length > 0 ? this.faces[0].room : -1;
    this.gridDirty = false;
    this.study.build(this.faces, cleanSunHoursSettings(this.settings, year), scene.rooms);
    this.stale = false;
    this.summary = null;
    this.passLabel = this.failLabel = null;

    const same = missing === 0 && this.cellsMatch(document);
    if (same && this.study.setResults(document.hours, document.run, document.sunSamples, document.totalSamples, document.shares)) {
      this.legendTitle = this.titleFor(document.run, document.name);
      this.refreshSummary();
      this.notice = `Loaded “${document.name}” (saved ${shortDateTime(document.saved)}${document.savedBy ? ' by ' + document.savedBy : ''})`;
      session.sound.play(SoundId.Commit);
    } else {
      this.notice = missing > 0
        ? `Loaded “${document.name}”: ${missing} of ${document.faces.length} surfaces are no longer in the model. RUN again for new results`
        : `Loaded “${document.name}”: the model changed since it was saved. RUN again for new results`;
      session.sound.play(SoundId.Error);
    }
  }

  /** True when the rebuilt grid has the saved cells (same count, each within 2 cm). */
  private cellsMatch(document: SunStudyDocument): boolean {
    const study = this.study, session = this.session;
    if (study.cellCount !== document.hours.length) { return false; }
    for (let i = 0; i < study.cellCount; i++) {
      const cell = study.cell(i);
      const world = session.toRevit(cell.point);
      const dx = world.x - document.points[i * 3], dy = world.y - document.points[i * 3 + 1], dz = world.z - document.points[i * 3 + 2];
      if (cell.face !== document.cellFaces[i] || dx * dx + dy * dy + dz * dz > 0.02 * 0.02) { return false; }
    }
    return true;
  }

  /** A saved surface found again (element, its triangles in the saved plane, its room), or null when it is gone. */
  private rebuildFace(saved: SunStudyFace): SunHoursFace | null {
    const element = this.findStudyElement(saved);
    if (element < 0) { return null; }
    let normal = vec3(saved.nx, saved.ny, saved.nz);
    if (!Number.isFinite(normal.x) || V.lengthSquared(normal) < 1e-6) { return null; }
    normal = V.normalize(normal);
    const origin = this.session.scene.originOffset;
    const offset = Math.fround(saved.offset - (normal.x * origin.x + normal.y * origin.y + normal.z * origin.z));
    const face = new SunHoursFace(element, normal, offset);
    face.bothSides = saved.bothSides;
    face.picked = saved.picked;
    face.room = this.findRoomByKey(saved.roomKey);
    this.addPlaneTriangles(face);
    return face.triangles.length > 0 ? face : null;
  }

  /** The element a saved surface belongs to (host: UniqueId, else ElementId; links: UniqueId in that link), or -1. */
  private findStudyElement(saved: SunStudyFace): number {
    const session = this.session;
    if (saved.link === 0) { return session.elementIndexOf(saved.uniqueId, saved.elementId); }
    return session.scene.elements.findIndex(r => r.link === saved.link && r.uniqueId === saved.uniqueId);
  }

  /** "number|name|link|floor height" (internal metres, 0.1 m): a room's identity across snapshots. */
  private roomKey(room: number): string {
    const scene = this.session.scene, r = scene.rooms[room];
    if (!r) { return ''; }
    const z = Math.round((r.bottomZ + scene.originOffset.z) * 10) / 10;
    return `${r.number}|${r.name}|${r.link}|${z.toFixed(1)}`;
  }

  private findRoomByKey(key: string): number {
    if (!key) { return -1; }
    return this.session.scene.rooms.findIndex((_, i) => this.roomKey(i) === key);
  }

  // #endregion

  // #region Drawing

  /**
   * The grid in the 3D pass: computed cells in their legend colour (or pass / fail), the rest grey (illuminance cells
   * stay grey until the run ends, when the sun bounce is added). Rebuilt only when the study or the colouring changes.
   */
  drawCells(): void {
    const study = this.study, camera = this.session.camera, s = this.settings;
    if (study.cellCount === 0 || (!this.open && !study.hours) || !study.settings) { return; }
    if (!this.overlay) {
      this.overlay = new Overlay3D();
      this.overlay.initialise();
    }
    const test = passFail(s);
    const colourKey = test ? 1 + Math.round(s.targetHours * 4) + 100 * Math.round(s.factorTarget * 2) + 10_000 * Math.round(s.luxShare * 10) : 0;
    if (this.overlayRevision !== study.revision || this.overlayColourKey !== colourKey) {
      this.overlayRevision = study.revision;
      this.overlayColourKey = colourKey;
      this.overlay.begin(camera);
      const half = study.settings.gridSize * 0.47;
      const pending = Rgba.hex(0xe5e7eb, study.running ? 0.25 : 0.45);
      const valuesReady = !(study.mode === StudyMode.Illuminance && study.running);
      for (let i = 0; i < study.cellCount; i++) {
        const { point: p, u, v } = study.cell(i);
        let colour = pending;
        if (study.hours && i < study.done && valuesReady) {
          const value = study.hours[i];
          const [r, g, b] = test ? (study.passes(i, s) ? SunHours.PASS : SunHours.FAIL)
            : study.mode === StudyMode.DaylightFactor ? Daylight.factorColour(value)
              : study.mode === StudyMode.Illuminance ? Daylight.luxColour(value) : SunHours.legendColour(value);
          colour = Rgba.fromFloat(r, g, b, 0.92);
        }
        const du = V.scale(u, half), dv = V.scale(v, half);
        this.overlay.quad(V.sub(V.sub(p, du), dv), V.sub(V.add(p, du), dv), V.add(V.add(p, du), dv), V.add(V.sub(p, du), dv), colour);
      }
    }
    this.overlay.draw(camera, true, 1, false);
  }

  /** The legend (bottom left, also in the study screenshot): the mode's colours with ticks, or the pass / fail swatches. */
  buildLegend(f: FontAtlas, x: number, y: number): void {
    if (!this.study.hours || !this.legendTitle) { return; }
    const ui = this.session.ui;
    const w = this.s(380), h = this.s(78);
    ui.panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.PANEL_BORDER);
    ui.text(f.small, x + this.s(12), y + this.s(8), this.legendTitle, UiTheme.SUN, this.s(0.5));

    const barX = x + this.s(12), barY = y + this.s(30), barW = w - this.s(24), barH = this.s(14);
    if (passFail(this.settings) && this.passLabel && this.failLabel) {
      // Pass / fail: two swatches with the area shares
      const half = (barW - this.s(12)) * 0.5;
      const [pr, pg, pb] = SunHours.PASS, [fr, fg, fb] = SunHours.FAIL;
      ui.rect(barX, barY, this.s(18), barH, Rgba.fromFloat(pr, pg, pb, 1));
      ui.textWrapped(f.small, barX + this.s(24), barY, half - this.s(24), this.passLabel, UiTheme.TEXT, 2);
      ui.rect(barX + half + this.s(12), barY, this.s(18), barH, Rgba.fromFloat(fr, fg, fb, 1));
      ui.text(f.small, barX + half + this.s(36), barY, this.failLabel, UiTheme.TEXT, this.s(0.4));
      return;
    }

    const steps = 56;
    for (let i = 0; i < steps; i++) {
      const [r, g, b] = SunHours.legendColour((i + 0.5) / steps * SunHours.LEGEND_MAX);
      ui.rect(barX + barW * i / steps, barY, barW / steps + 0.5, barH, Rgba.fromFloat(r, g, b, 1));
    }
    // Ticks: whole hours (0–7), whole % (0–5) or every 500 lux (0–2000)
    const mode = this.study.mode;
    const ticks = mode === StudyMode.DaylightFactor ? Daylight.DF_LEGEND_MAX : mode === StudyMode.Illuminance ? 4 : SunHours.LEGEND_MAX;
    const unit = mode === StudyMode.DaylightFactor ? '+ %' : mode === StudyMode.Illuminance ? '+ lx' : '+ h';
    for (let t = 0; t <= ticks; t++) {
      const tx = barX + barW * t / ticks;
      ui.rect(tx - this.s(0.5), barY + barH, this.s(1), this.s(4), UiTheme.TEXT_SOFT);
      const label = String(mode === StudyMode.Illuminance ? t * 500 : t) + (t === ticks ? unit : '');
      ui.textCentred(f.small, tx, barY + barH + this.s(6), label, UiTheme.TEXT_SOFT);
    }
  }

  /**
   * The study panel (right side): mode, the mode's settings, the pass / fail test, grid and offsets, surfaces, RUN /
   * progress, results, exports and saved studies.
   */
  buildPanel(f: FontAtlas, input: InputState): void {
    const session = this.session, ui = session.ui, w = this.w, study = this.study;
    if (!input.leftDown) { w.activeSlider = -1; }
    const pw = this.s(380), x = session.screenWidth - this.s(20) - pw, y = this.s(20);
    const ph = Math.min(session.screenHeight - this.s(40), this.s(820));
    this.panelRect = [x, y, pw, ph];
    ui.panel(x, y, pw, ph, UiTheme.PANEL_STRONG, UiTheme.SUN);
    const ix = x + this.s(16), iw = pw - this.s(32);
    let cy = y + this.s(14);
    ui.text(f.small, ix, cy, 'SUN AND DAYLIGHT STUDY', UiTheme.SUN, this.s(1.4));
    cy += this.s(28);
    if (this.studiesView) {
      this.buildStudiesList(f, ix, cy, iw, y + ph);
      return;
    }

    const shift = input.isDown(Vk.SHIFT);
    const locked = study.running;
    const s = this.settings;
    const year = new Date().getFullYear();

    // Mode
    const modeIndex = Math.min(Math.max(s.mode, 0), MODE_OPTIONS.length - 1);
    const newMode = w.segmented(f, ix, cy, iw, MODE_OPTIONS, modeIndex);
    if (newMode !== modeIndex && !locked) { this.setMode(newMode as StudyMode); }
    cy += this.s(42);

    if (s.mode !== StudyMode.DaylightFactor) {
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
    }

    if (s.mode === StudyMode.SunHours) {
      const glass = w.checkbox(f, ix, cy + this.s(4), iw, 'Glass blocks sun (off: sun passes through)', s.glassBlocks);
      if (glass !== s.glassBlocks && !locked) { s.glassBlocks = glass; this.changed(false); }
      cy += this.s(34);
    } else {
      if (s.mode === StudyMode.Illuminance) {
        const sun = w.checkbox(f, ix, cy + this.s(4), iw, 'Direct sun (off: the clear sky only)', s.directSun);
        if (sun !== s.directSun && !locked) { s.directSun = sun; this.changed(false); }
        cy += this.s(34);
      }
      ui.text(f.body, ix, cy + this.s(7), 'Rays per cell', UiTheme.TEXT_SOFT);
      const rayIndex = Math.max(0, STUDY_RAY_COUNTS.indexOf(s.rays));
      const newRays = w.segmented(f, ix + this.s(110), cy, iw - this.s(110), RAY_OPTIONS, rayIndex);
      if (newRays !== rayIndex && !locked) { s.rays = STUDY_RAY_COUNTS[newRays]; this.changed(false); }
      cy += this.s(40);
      ui.text(f.body, ix, cy + this.s(7), 'Reflectance', UiTheme.TEXT_SOFT);
      const reflectIndex = s.standardReflectance ? 1 : 0;
      const newReflect = w.segmented(f, ix + this.s(110), cy, iw - this.s(110), REFLECTANCE_OPTIONS, reflectIndex);
      if (newReflect !== reflectIndex && !locked) { s.standardReflectance = newReflect === 1; this.changed(false); }
      cy += this.s(40);
    }

    // Pass / fail test: a toggle, then the mode's target
    if (w.smallButton(f, ix, cy, this.s(150), this.s(30), passFail(s) ? 'PASS / FAIL: ON' : 'PASS / FAIL: OFF') && !locked) { this.togglePassFail(); }
    if (passFail(s)) {
      const tx = ix + this.s(160);
      if (s.mode === StudyMode.DaylightFactor) {
        const factor = w.stepper(f, tx, cy, s.factorTarget, 0.5, 0.5, 10, 1, ' %');
        if (factor !== s.factorTarget) { s.factorTarget = factor; this.refreshSummary(); }
      } else if (s.mode === StudyMode.Illuminance) {
        const lux = w.stepper(f, tx, cy, s.luxTarget, shift ? 10 : 50, 50, 5000, 0, ' lx');
        if (lux !== s.luxTarget && !locked) { s.luxTarget = lux; this.changed(false); }
        cy += this.s(36);
        ui.text(f.body, ix, cy + this.s(7), 'for at least', UiTheme.TEXT_SOFT);
        const share = w.stepper(f, tx, cy, s.luxShare * 100, 10, 10, 100, 0, ' % of time') / 100;
        if (Math.abs(share - s.luxShare) > 1e-4) { s.luxShare = share; this.refreshSummary(); }
      } else {
        const hours = w.stepper(f, tx, cy, s.targetHours, 0.5, 0.5, 12, 1, ' h');
        if (hours !== s.targetHours) { s.targetHours = hours; this.refreshSummary(); }
      }
    }
    cy += this.s(40);

    // Grid and offsets (these rebuild the grid)
    ui.text(f.body, ix, cy + this.s(7), 'Grid', UiTheme.TEXT_SOFT);
    const gridIndex = Math.max(0, SUN_HOURS_GRID_SIZES.indexOf(s.gridSize));
    const newGrid = w.segmented(f, ix + this.s(110), cy, iw - this.s(110), GRID_OPTIONS, gridIndex);
    if (newGrid !== gridIndex && !locked) { s.gridSize = SUN_HOURS_GRID_SIZES[newGrid]; this.changed(true); }
    cy += this.s(40);
    const daylight = s.mode !== StudyMode.SunHours;
    const flat = this.offsetRow(f, ix, cy, daylight ? 'Work plane' : 'Floor offset', daylight ? s.workPlane : s.floorOffset, 2);
    cy += this.s(38);
    const wallOffset = this.offsetRow(f, ix, cy, 'Wall offset', s.wallOffset, 1);
    cy += this.s(38);
    if (!locked && (flat !== (daylight ? s.workPlane : s.floorOffset) || wallOffset !== s.wallOffset)) {
      if (daylight) { s.workPlane = flat; } else { s.floorOffset = flat; }
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
      if (room >= 0) { this.notice = 'Selected: ' + session.roomLabel(room); }
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
        this.notice = study.mode === StudyMode.Illuminance ? 'Cancelled (illuminance needs a complete run)' : 'Cancelled: the cells done so far keep their colour';
      }
    } else if (w.menuButton(f, ix, cy, iw, this.stale ? 'RUN (settings changed)' : 'RUN', true, false, study.cellCount > 0, this.s(40))) {
      this.run();
    }
    cy += this.s(50);

    // Results, exports and saved studies
    if (this.summary) { cy += this.s(2) + ui.textWrapped(f.small, ix, cy, iw, this.summary, UiTheme.TEXT, 3) + this.s(6); }
    const results = study.finished && study.hours !== null;
    const third = (iw - this.s(16)) / 3;
    if (w.smallButton(f, ix, cy, third, this.s(30), 'EXPORT CSV') && results) { this.exportCsv(); }
    if (w.smallButton(f, ix + third + this.s(8), cy, third, this.s(30), 'SCREENSHOT') && results) { this.shotRequested = true; }
    if (w.smallButton(f, ix + (third + this.s(8)) * 2, cy, third, this.s(30), 'CLEAR') && study.hours) { this.clearResults(); }
    cy += this.s(38);
    const halfWidth = (iw - this.s(8)) * 0.5;
    if (w.smallButton(f, ix, cy, halfWidth, this.s(30), 'SAVE STUDY…') && !locked) {
      if (study.finished) { this.beginName(); } else { this.notice = 'Run the study first (only complete results can be saved)'; }
    }
    if (w.smallButton(f, ix + halfWidth + this.s(8), cy, halfWidth, this.s(30), 'SAVED STUDIES…') && !locked) { this.openStudies(); }
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

/** A triangle's centre, unit normal and area. */
function triangle(a: Vec3, b: Vec3, c: Vec3): { centre: Vec3; normal: Vec3; area: number } {
  const cross = V.cross(V.sub(b, a), V.sub(c, a));
  const length = V.length(cross);
  return {
    centre: vec3((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3),
    normal: length > 1e-9 ? V.scale(cross, 1 / length) : vec3(0, 0, 1),
    area: length * 0.5
  };
}

/** "glazing 4.2 m² · R 0.46 · IRC 1.3 %" for one room, or the number of rooms. */
function roomNote(rooms: RoomLight[], count: number): string | null {
  if (count !== 1) { return count === 0 ? null : `${count} rooms`; }
  const light = rooms.find(l => l.valid);
  return light ? `glazing ${light.windowArea.toFixed(1)} m² · R ${light.averageReflectance.toFixed(2)} · IRC ${light.ircPercent.toFixed(1)} %` : null;
}

/** "dd MMM yyyy HH:mm" in local time. */
function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) { return ''; }
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
