import { type ClashGroup, type ClashGroupBox, ClashGroups, ClashGrouping, GroupBox } from '../../core/clashes/ClashGroups';
import { ClashFraming } from '../../core/clashes/ClashFraming';
import { type ClashRecord, ClashStatus, elementRefLabel } from '../../core/clashes/ClashModels';
import { clamp, type Vec3, Vec3 as V, vec3 } from '../../core/math/Vector';
import { InputAction } from '../../core/scene/InputCatalog';
import { Aabb } from '../../core/scene/SceneData';
import { SectionCut } from '../../core/scene/SectionCut';
import { Overlay3D } from '../../engine/render/Overlay3D';
import { Rgba } from '../../engine/ui/Rgba';
import { UiBatch } from '../../engine/ui/UiBatch';
import type { FontAtlas } from '../../engine/ui/UiFont';
import { UiTheme } from '../../engine/ui/UiTheme';
import { SoundId } from '../../platform/audio';
import { KeyHint, keyOf } from '../../platform/Hotkeys';
import { type InputState, Vk } from '../../platform/input';
import type { GameSession } from '../GameSession';
import { closestOnAxis } from '../SectionMode';
import { UnitFormat } from '../UnitFormat';
import type { Clashes } from './Clashes';
import { clashLevel, clashStatusColour } from './Clashes';
import { shorten } from './ClashGroupUi';

export const CLASH_TOOL_NONE = 0, CLASH_TOOL_BOX = 1, CLASH_TOOL_PICK = 2, CLASH_TOOL_SPHERE = 3;
/** The most clash dots a tool draws (the nearest to the eye). */
const CLASH_TOOL_DOTS = 2000;
/** The cluster sphere's handle snaps to this step (m) unless the free-drag key is held. */
const CLASH_SPHERE_SNAP = 0.05;
const DROP_DOCK_TOOL_ADD = 20;
const BAR_NONE = 0, BAR_COMMIT = 1, BAR_CANCEL = 2, BAR_FULL_HEIGHT = 3, BAR_FIT = 4, BAR_CLEAR = 5;

const HINT_CLASH_BOX = new KeyHint(() =>
  `Drag the cyan handles (${keyOf(InputAction.SectionFreeDrag)}: free) · RMB-drag orbits · wheel zooms · move keys pan · ${keyOf(InputAction.ClashFrame)} commits · Esc cancels`);
const HINT_CLASH_PICK = new KeyHint(() =>
  `Click dots or rows to pick · Ctrl+drag a box adds · RMB-drag looks · ${keyOf(InputAction.ClashFrame)}: new group · ${keyOf(InputAction.ClashPickPoints)} or Esc leaves`);
const HINT_CLASH_SPHERE = new KeyHint(() =>
  `Drag the white handle to size the sphere (${keyOf(InputAction.SectionFreeDrag)}: free) · click a dot or row to move the centre · ${keyOf(InputAction.ClashFrame)} groups · Esc cancels`);

type Rect = [number, number, number, number];

/**
 * Clash grouping tools (Round C, build C-C2; port of GameSession.ClashTools.cs), from the dock's TOOLS ▾ and the row
 * menus. One tool at a time; each shows a bar at the bottom of the view (Enter commits, Esc leaves) and draws the clashes
 * the list shows as dots seen through walls.
 * - GROUP BY BOX…: the section box itself, sized with the section editor's face handles; the dock folds away, RMB-drag
 *   orbits, the wheel zooms, the move keys fly. FULL HEIGHT makes a plan rectangle. GROUP IN BOX makes a group of the
 *   shown clashes inside and the group keeps the box. EDIT BOX… reopens it on a group.
 * - RECOLLECT FROM ITS BOX: the test's open clashes inside the group's box join it; members outside: REMOVE / KEEP.
 * - PICK POINTS: click dots (or rows) to pick / unpick, Ctrl+drag a marquee adds; NEW GROUP / ADD TO GROUP › / CLEAR / DONE.
 * - CLUSTER AROUND…: a sphere on a clash, sized by its handle; the shown clashes inside light up; GROUP names it "Cluster N".
 * C-C3: the dot under the mouse has a label in clash mode too, and a click goes to that clash.
 */
export class ClashTools {
  tool = CLASH_TOOL_NONE;
  private barRect: Rect = [0, 0, 0, 0];
  private barAction = BAR_NONE;
  private title = '';
  private status = '';
  private commitLabel = '';
  private labelKey = '';

  // GROUP BY BOX…: the group being edited (null: a new group), the cut before, full height and its heights
  private boxGroup: ClashGroup | null = null;
  private boxSaved: SectionCut | null = null;
  private boxFullHeight = false;
  private boxMinZ = 0;
  private boxMaxZ = 0;
  private boxInside = 0;
  private orbitTarget: Vec3 = vec3();
  private orbitLastEye: Vec3 = vec3();

  // The dots: the nearest shown clashes (rebuilt when the list changes or the eye moves a metre)
  private readonly dots: ClashRecord[] = [];
  dotsDirty = true;
  private dotsEye: Vec3 = vec3(1e9, 1e9, 1e9);

  /** The dot under the mouse and its label. */
  hover: ClashRecord | null = null;
  private hoverText: string | null = null;

  // PICK POINTS: the Ctrl+drag marquee
  marquee = false;
  private marqueeFrom: [number, number] = [0, 0];

  // CLUSTER AROUND…: the centre clash, the radius (kept for the session), the clashes inside, the handle
  private sphereSeed: ClashRecord | null = null;
  private sphereRadius = 1;
  private readonly sphereMembers: ClashRecord[] = [];
  private readonly sphereLookup = new Set<ClashRecord>();
  private sphereElsewhere = 0;
  sphereDirty = true;
  private sphereHandleHover = false;
  private sphereDragging = false;
  private sphereAxis: Vec3 = vec3();

  private overlay: Overlay3D | null = null;

  constructor(private readonly session: GameSession, private readonly clashes: Clashes) {}

  private s(v: number): number { return this.session.s(v); }

  private get section() { return this.session.section; }

  /** The eye (scene-local) as the player stands or flies. */
  private get playerEye(): Vec3 {
    const p = this.session.player;
    return vec3(p.feet.x, p.feet.y, p.feet.z + p.controller.standEye);
  }

  /** A clash point, scene-local. */
  private local(clash: ClashRecord): Vec3 {
    const o = this.session.scene.originOffset;
    return vec3(clash.x - o.x, clash.y - o.y, clash.z - o.z);
  }

  /** True when the player waits for the tool (picking points with Ctrl held: Ctrl+drag draws a marquee, Ctrl flies down). */
  get freezesPlayer(): boolean { return this.tool === CLASH_TOOL_PICK && (this.marquee || this.session.input.isDown(Vk.CONTROL)); }

  // #region Start / leave

  /** Starts a tool (leaving the one that was on): closes lists, stops typing and flying. */
  private begin(tool: number): void {
    if (this.tool !== CLASH_TOOL_NONE) { this.leave(); }
    const session = this.session;
    session.menu.closeOverlay();
    this.clashes.searchFocused = false;
    this.clashes.stopFlying();
    this.tool = tool;
    this.dotsDirty = true;
    this.hover = null;
    this.labelKey = '';
    this.marquee = false;
    session.input.releaseAll();
    session.sound.play(SoundId.UiClick);
  }

  /** Leaves the tool: the box tool puts the cut back as it was. */
  leave(): void {
    if (this.tool === CLASH_TOOL_NONE) { return; }
    const section = this.section;
    if (this.tool === CLASH_TOOL_BOX) {
      section.drag = section.hover = -1;
      section.toolHides = null;
      section.apply(this.boxSaved ?? new SectionCut(), false);
      this.boxSaved = null;
      this.boxGroup = null;
    }
    this.tool = CLASH_TOOL_NONE;
    this.barRect = [0, 0, 0, 0];
    this.marquee = false;
    this.sphereDragging = false;
    this.sphereSeed = null;
    this.hover = null;
    this.session.input.releaseAll();
  }

  /** Esc / CANCEL / DONE: leaves the tool with a word. */
  private cancel(): void {
    const tool = this.tool;
    this.leave();
    this.session.sound.play(SoundId.UiClick);
    this.session.toast(tool === CLASH_TOOL_PICK ? 'Pick points off (the picks stay selected)' : tool === CLASH_TOOL_BOX ? 'Box grouping cancelled (the cut is as it was)' : 'Cluster cancelled', 2);
  }

  /** Enter / the bar's main button: commits the tool. */
  private commit(): void {
    switch (this.tool) {
      case CLASH_TOOL_BOX: this.commitBox(); break;
      case CLASH_TOOL_PICK: this.commitPicks(); break;
      case CLASH_TOOL_SPHERE: this.commitSphere(); break;
    }
  }

  // #endregion

  // #region Frame

  /** A tool's keys and mouse (in place of clash mode's own). */
  update(input: InputState, dt: number): void {
    const session = this.session, clashes = this.clashes, overlays = session.menu.overlays;
    if (input.pressed(InputAction.Back)) {
      if (session.menu.closeOverlay()) { return; }
      if (this.marquee) { this.marquee = false; return; }
      this.cancel();
      return;
    }
    if (input.pressed(InputAction.ClashMode)) {
      clashes.exit();
      return;
    }
    if (this.tool === CLASH_TOOL_PICK && input.pressed(InputAction.ClashPickPoints)) { // P-B: K again leaves pick points
      this.cancel();
      return;
    }
    if (input.pressed(InputAction.Help)) { session.showHelp = !session.showHelp; }
    if (input.pressed(InputAction.HideUi)) { session.toggleUiHidden(); }
    if (input.pressed(InputAction.Fullscreen)) { session.toggleFullscreen(); }
    if (input.pressed(InputAction.Screenshot)) { session.requestScreenshot(); }
    if (input.pressed(InputAction.ClashView)) { clashes.cycleView(); } // C-C3: G stays live
    if (input.pressed(InputAction.ClashFrame) && !overlays.isOpen) {
      this.commit();
      return;
    }

    // RMB pressed over the dock opens a row menu, not a look (as in clash mode)
    if (input.rightPressed && clashes.overDockAt(input.mouseX, input.mouseY)) { clashes.menuLook = true; }
    if (!input.rightDown) { clashes.menuLook = false; }
    const overUi = overlays.isOpen || clashes.overDockAt(input.mouseX, input.mouseY) || this.overBar(input.mouseX, input.mouseY);
    switch (this.tool) {
      case CLASH_TOOL_BOX: this.updateBox(input, overUi); break;
      case CLASH_TOOL_PICK: this.updatePick(input, overUi); break;
      case CLASH_TOOL_SPHERE: this.updateSphere(input, overUi); break;
    }
    session.updateRoom();
    clashes.advanceFlightNow(dt);
  }

  private overBar(x: number, y: number): boolean {
    const [bx, by, bw, bh] = this.barRect;
    return bw > 0 && x >= bx && x < bx + bw && y >= by && y < by + bh;
  }

  /** RMB-drag looks (pick points and cluster), unless it began over the dock. */
  private look(input: InputState): void {
    const session = this.session;
    if (input.down(InputAction.DragLook) && !this.clashes.isFlying && !this.clashes.menuLook) {
      session.player.look(input.mouseDeltaX, input.mouseDeltaY, session.settings.mouseSensitivity, session.settings.invertY);
    }
  }

  // #endregion

  // #region Dots

  /** The dots to draw and pick: every shown clash, or the nearest CLASH_TOOL_DOTS to the eye. */
  private refreshDots(): void {
    const eye = this.session.camera.position;
    if (!this.dotsDirty && V.distanceSquared(eye, this.dotsEye) < 1) { return; }
    this.dotsDirty = false;
    this.dotsEye = V.copy(eye);
    this.dots.length = 0;
    const list = this.clashes.list;
    if (list.length <= CLASH_TOOL_DOTS) {
      this.dots.push(...list);
      return;
    }
    const keyed = list.map(c => ({ c, d: V.distanceSquared(eye, this.local(c)) })).sort((a, b) => a.d - b.d);
    for (let i = 0; i < CLASH_TOOL_DOTS; i++) { this.dots.push(keyed[i].c); }
  }

  /** The dot nearest the mouse within 12 px (null: none, or over the dock / bar), and its label. */
  updateHover(mx: number, my: number, overUi: boolean): void {
    let best: ClashRecord | null = null;
    if (!overUi) {
      this.refreshDots();
      let bestDistance = this.s(12) ** 2;
      const camera = this.session.camera;
      for (const clash of this.dots) {
        const screen = camera.worldToScreen(this.local(clash));
        if (!screen) { continue; }
        const d = (screen.x - mx) ** 2 + (screen.y - my) ** 2;
        if (d < bestDistance) { bestDistance = d; best = clash; }
      }
    }
    if (best === this.hover) { return; }
    this.hover = best;
    if (!best) { this.hoverText = null; return; }
    const group = this.clashes.groups.groupOf(best);
    this.hoverText = `${elementRefLabel(best.a)}  ×  ${elementRefLabel(best.b)} · ${ClashStatus.label(best.status).toLowerCase()} · ${clashLevel(best)}`
      + (group ? ` · in “${shorten(ClashGroups.displayName(group), 30)}”` : '');
  }

  // #endregion

  // #region GROUP BY BOX…

  /** GROUP BY BOX… (null) or EDIT BOX… (a group): the section box round the group's box, its members, the selection or the current clash. */
  beginBox(group: ClashGroup | null): void {
    const session = this.session, clashes = this.clashes, section = this.section;
    if (!clashes.document) { return; }
    this.begin(CLASH_TOOL_BOX);
    this.boxGroup = group;
    this.boxSaved = section.current.clone();
    this.boxFullHeight = group?.box?.fullHeight ?? false;

    const origin = session.scene.originOffset;
    let min: Vec3, max: Vec3;
    if (group?.box) {
      min = V.sub(vec3(group.box.minX, group.box.minY, group.box.minZ), origin);
      max = V.sub(vec3(group.box.maxX, group.box.maxY, group.box.maxZ), origin);
    } else {
      const around = group ? clashes.groups.allMembers(group) : clashes.targetClashes();
      if (around.length > 0) {
        const box = Aabb.empty();
        for (const clash of around) { box.includePoint(this.local(clash)); }
        min = V.sub(box.min, vec3(1, 1, 1));
        max = V.add(box.max, vec3(1, 1, 1));
      } else {
        const eye = this.playerEye, player = session.player;
        const centre = V.add(eye, vec3(Math.cos(player.yaw) * 4, Math.sin(player.yaw) * 4, 0));
        min = vec3(centre.x - 2, centre.y - 2, player.feet.z - 0.3);
        max = vec3(centre.x + 2, centre.y + 2, player.feet.z + 3);
      }
    }
    this.boxMinZ = min.z;
    this.boxMaxZ = max.z;
    if (this.boxFullHeight) { [min, max] = this.fullHeightZ(min, max); }
    this.setBox(min, max);
    section.toolHides = h => h === 6 || (this.boxFullHeight && h >= 4);
    this.fitView();
    session.toast(group === null
      ? `Group by box: drag the handles · RMB-drag orbits · wheel zooms · ${keyOf(InputAction.ClashFrame)} groups the shown clashes inside · Esc cancels`
      : `Edit the box of “${shorten(ClashGroups.displayName(group), 40)}” · ${keyOf(InputAction.ClashFrame)} updates it and recollects · Esc cancels`, 4);
  }

  private setBox(min: Vec3, max: Vec3): void {
    const session = this.session, cut = this.section.current;
    cut.boxOn = true;
    cut.planeOn = false;
    cut.boxMin = session.toRevit(min);
    cut.boxMax = session.toRevit(max);
    cut.clean();
    this.section.changed();
  }

  /** Full height: the box runs from under the model to over it (the plan rectangle is what counts). */
  private fullHeightZ(min: Vec3, max: Vec3): [Vec3, Vec3] {
    const bounds = this.session.scene.bounds;
    return [vec3(min.x, min.y, bounds.min.z - 1), vec3(max.x, max.y, bounds.max.z + 1)];
  }

  /** FULL HEIGHT on / off (off puts back the heights it had). */
  private toggleFullHeight(): void {
    const session = this.session, cut = this.section.current, origin = session.scene.originOffset;
    let min = V.sub(cut.boxMin, origin), max = V.sub(cut.boxMax, origin);
    this.boxFullHeight = !this.boxFullHeight;
    if (this.boxFullHeight) {
      this.boxMinZ = min.z;
      this.boxMaxZ = max.z;
      [min, max] = this.fullHeightZ(min, max);
    } else {
      min = vec3(min.x, min.y, this.boxMinZ);
      max = vec3(max.x, max.y, Math.max(this.boxMaxZ, this.boxMinZ + SectionCut.MIN_SIZE));
    }
    this.setBox(min, max);
    this.section.hover = this.section.drag = -1;
    session.sound.play(SoundId.UiClick);
    session.toast(this.boxFullHeight ? 'Full height: a plan rectangle catching clashes on every level (side handles only)' : 'Box heights back', 2.5);
  }

  /** FIT VIEW: the orbit centre on the box, back far enough to see it all, looking down a little. */
  private fitView(): void {
    const session = this.session, cut = this.section.current, origin = session.scene.originOffset;
    const box = new Aabb(V.sub(cut.boxMin, origin), V.sub(cut.boxMax, origin));
    if (this.boxFullHeight) {
      // Frame the plan rectangle at the height it was drawn, not the whole building's height
      box.min.z = this.boxMinZ;
      box.max.z = Math.max(this.boxMaxZ, this.boxMinZ + SectionCut.MIN_SIZE);
    }
    this.orbitTarget = box.center;
    const distance = ClashFraming.distanceToSee(box, session.settings.fieldOfView, session.camera.aspect);
    this.placeOrbit(session.player.yaw, -0.45, distance);
  }

  /** Puts the eye on the orbit: looking at the target from distance back. */
  private placeOrbit(yaw: number, pitch: number, distance: number): void {
    const player = this.session.player;
    pitch = clamp(pitch, -1.55, 1.55);
    const cp = Math.cos(pitch);
    const forward = vec3(cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch));
    const eye = V.sub(this.orbitTarget, V.scale(forward, distance));
    this.clashes.stopFlying();
    player.teleportTo(vec3(eye.x, eye.y, eye.z - player.controller.standEye), yaw, pitch);
    this.orbitLastEye = eye;
  }

  /** The box tool's mouse: drag a face handle, RMB-drag orbits the target, the wheel zooms; flying moves the target too. */
  private updateBox(input: InputState, overUi: boolean): void {
    const session = this.session, section = this.section;
    // The move keys fly: the orbit centre goes along (they pan)
    const eye = this.playerEye;
    this.orbitTarget = V.add(this.orbitTarget, V.sub(eye, this.orbitLastEye));
    this.orbitLastEye = eye;

    const mx = input.mouseX, my = input.mouseY;
    if (section.drag >= 0) {
      if (!input.leftDown) {
        section.drag = -1;
        session.sound.play(SoundId.UiClick);
      } else { section.dragHandle(mx, my, input.down(InputAction.SectionFreeDrag)); }
    } else {
      section.hover = overUi ? -1 : section.handleUnder(mx, my, this.boxFullHeight ? 3 : 5);
      if (input.leftPressed && section.hover >= 0) {
        input.consumeClicks();
        section.beginDrag(section.hover, mx, my);
      }
    }

    // Orbit (RMB-drag) and zoom (wheel) round the target
    let distance = Math.max(0.5, V.distance(eye, this.orbitTarget));
    const player = session.player;
    if (input.down(InputAction.DragLook) && !this.clashes.menuLook && (input.mouseDeltaX !== 0 || input.mouseDeltaY !== 0)) {
      player.look(input.mouseDeltaX, input.mouseDeltaY, session.settings.mouseSensitivity, session.settings.invertY);
      this.placeOrbit(player.yaw, player.pitch, distance);
    }
    if (!overUi && input.wheel !== 0) {
      distance = clamp(distance * Math.pow(0.85, input.wheel), 0.5, 2000);
      this.placeOrbit(player.yaw, player.pitch, distance);
      input.consumeWheel();
    }

    // The live count
    this.boxInside = this.clashes.list.filter(c => this.inBox(c)).length;
    this.updateHover(mx, my, overUi || section.hover >= 0 || section.drag >= 0);
  }

  /** True when a clash point is in the tool's box (internal metres; full height: plan only). */
  private inBox(clash: ClashRecord): boolean {
    const cut = this.section.current;
    return clash.x >= cut.boxMin.x && clash.x <= cut.boxMax.x && clash.y >= cut.boxMin.y && clash.y <= cut.boxMax.y
      && (this.boxFullHeight || (clash.z >= cut.boxMin.z && clash.z <= cut.boxMax.z));
  }

  /** The tool's box as a group box (internal metres; full height kept with the heights it was drawn at). */
  private toolBox(): ClashGroupBox {
    const cut = this.section.current, origin = this.session.scene.originOffset;
    return GroupBox.normalise({
      minX: cut.boxMin.x, minY: cut.boxMin.y, maxX: cut.boxMax.x, maxY: cut.boxMax.y,
      minZ: this.boxFullHeight ? this.boxMinZ + origin.z : cut.boxMin.z,
      maxZ: this.boxFullHeight ? Math.max(this.boxMaxZ, this.boxMinZ + SectionCut.MIN_SIZE) + origin.z : cut.boxMax.z,
      fullHeight: this.boxFullHeight
    });
  }

  /** GROUP IN BOX: a new group of the shown clashes inside (keeping the box); EDIT BOX…: the box updated, then RECOLLECT. */
  private commitBox(): void {
    const session = this.session, groups = this.clashes.groups, document = this.clashes.document!;
    const box = this.toolBox();
    const editing = this.boxGroup;
    const user = session.settings.userName, utc = new Date().toISOString();
    if (editing) {
      this.leave();
      if (!(document.groups ?? []).includes(editing)) { return; }
      ClashGroups.setBox(editing, box, user, utc);
      groups.changed();
      this.recollect(editing, 'Box updated');
      return;
    }
    const inside = ClashGrouping.inBox(this.clashes.list, box);
    if (inside.length === 0) {
      session.sound.play(SoundId.Error);
      session.toast('No shown clash is inside the box (drag the handles, or check the filters)', 2.5);
      return;
    }
    this.leave();
    const group = groups.groupClashes(inside, null);
    if (!group) { return; }
    ClashGroups.setBox(group, box, user, utc);
    groups.changed();
  }

  /** RECOLLECT FROM ITS BOX: the test's open clashes inside the group's box join it; members outside: REMOVE n / KEEP. */
  recollect(group: ClashGroup, prefix: string | null): void {
    const session = this.session, groups = this.clashes.groups, document = this.clashes.document!;
    const split = ClashGroups.boxSplit(document, group, null);
    if (!split) {
      session.sound.play(SoundId.Error);
      session.toast('This group has no box (EDIT BOX… draws one)', 2.5);
      return;
    }
    let added = 0, moved = 0;
    if (split.joining.length > 0) {
      ({ added, moved } = ClashGroups.addTo(document, group, split.joining, session.settings.userName, new Date().toISOString()));
      if (added > 0) { groups.changed(); }
    }
    const name = shorten(ClashGroups.displayName(group), 40);
    const summary = (prefix ? prefix + ': ' : '') + (added === 0 ? `no new clash in the box of “${name}”` : `${added} clash${added === 1 ? '' : 'es'} added to “${name}”`)
      + (moved > 0 ? ` (${moved} moved from other groups)` : '');
    session.sound.play(added > 0 ? SoundId.Commit : SoundId.UiClick);
    const outside = split.outside;
    if (outside.length === 0) {
      session.toast(summary, 3);
      return;
    }
    session.menu.overlays.openChoice('MEMBERS OUTSIDE THE BOX', `${summary}. ${outside.length} of the group's clashes now lie outside its box. `
      + 'REMOVE takes them out of the group (they stay, ungrouped); KEEP leaves them in.', `REMOVE ${outside.length}`, true, null, 'KEEP',
    () => groups.removeFromGroups(outside), () => session.toast(`${outside.length} kept in “${name}” (outside its box)`, 2.5));
  }

  // #endregion

  // #region PICK POINTS

  /** Polish round P-B: the pick points key (K) starts the tool (a test must be under review); K again or Esc leaves. */
  startPickFromKey(): void {
    if (!this.clashes.document || !this.clashes.reviewTest) {
      this.session.sound.play(SoundId.Error);
      this.session.toast('Pick points needs a clash test to review (TESTS…)', 2);
      return;
    }
    this.beginPick();
  }

  /** PICK POINTS: the dots take clicks; the picks are the list selection (kept when it already holds several). */
  beginPick(): void {
    this.begin(CLASH_TOOL_PICK);
    if (!this.clashes.multiActive) { this.clashes.clearSelectionKeepCurrent(); }
    this.picksChanged();
    this.session.toast(`Pick points: click dots (or rows) to pick · Ctrl+drag a box adds · ${keyOf(InputAction.ClashFrame)}: new group · ${keyOf(InputAction.ClashPickPoints)} or Esc leaves`, 4);
  }

  /** Clicks on dots (toggle), Ctrl+drag (marquee adds), RMB-drag looks. */
  private updatePick(input: InputState, overUi: boolean): void {
    const session = this.session, clashes = this.clashes;
    const mx = input.mouseX, my = input.mouseY;
    this.look(input);
    this.updateHover(mx, my, overUi || this.marquee);

    if (this.marquee) {
      if (input.leftDown) { return; }
      this.marquee = false;
      const [fx, fy] = this.marqueeFrom;
      if (Math.hypot(fx - mx, fy - my) < this.s(4)) {
        // A Ctrl+click without a drag: toggle the dot there
        this.updateHover(mx, my, overUi);
        if (this.hover) { this.togglePick(this.hover); }
        return;
      }
      const x0 = Math.min(fx, mx), x1 = Math.max(fx, mx), y0 = Math.min(fy, my), y1 = Math.max(fy, my);
      const inside: ClashRecord[] = [];
      for (const clash of this.dots) {
        const screen = session.camera.worldToScreen(this.local(clash));
        if (screen && screen.x >= x0 && screen.x <= x1 && screen.y >= y0 && screen.y <= y1) { inside.push(clash); }
      }
      const added = clashes.addToSelection(inside);
      if (added > 0) {
        this.picksChanged();
        session.sound.play(SoundId.UiClick);
      }
      session.toast(added === 0 ? 'No new dot in the box' : `${added} added · ${clashes.selectedCount} picked`, 1.6);
      return;
    }

    if (!input.leftPressed || overUi) { return; }
    if (input.isDown(Vk.CONTROL)) {
      // Ctrl held: start a marquee (a Ctrl+click without moving toggles, as a plain click does)
      input.consumeClicks();
      this.marquee = true;
      this.marqueeFrom = [mx, my];
      return;
    }
    if (this.hover) {
      input.consumeClicks();
      this.togglePick(this.hover);
    }
  }

  /** A dot or row click: the clash in or out of the picks (the camera stays). */
  togglePick(clash: ClashRecord | null): void {
    if (!clash) { return; }
    this.clashes.togglePickOne(clash);
    this.picksChanged();
    this.session.sound.play(SoundId.UiClick);
  }

  /** A group row click while picking: its shown members in (or out, when all are picked). */
  togglePicks(list: ClashRecord[]): void {
    if (list.length === 0) { return; }
    this.clashes.togglePickMany(list);
    this.picksChanged();
    this.session.sound.play(SoundId.UiClick);
  }

  /** After the picks changed: the pairs found again and drawn; the card follows; the camera and the box stay. */
  private picksChanged(): void {
    const groups = this.clashes.groups;
    groups.current = null;
    groups.picks.length = 0;
    this.clashes.resolvePicks();
    this.labelKey = '';
  }

  /** NEW GROUP (Enter): the picks become a group; the tool ends with its card showing. */
  private commitPicks(): void {
    const clashes = this.clashes;
    if (clashes.selectedCount === 0) {
      this.session.sound.play(SoundId.Error);
      this.session.toast('Nothing picked yet: click dots, or Ctrl+drag a box round them', 2.5);
      return;
    }
    const picks = [...clashes.selection];
    this.leave();
    clashes.groups.groupClashes(picks, null);
  }

  /** CLEAR: no picks. */
  private clearPicks(): void {
    this.clashes.clearSelectionKeepCurrent();
    this.picksChanged();
  }

  /** ADD TO GROUP ›: the test's groups (largest first); a pick adds the picks and ends the tool. */
  private openPickAddTo(x: number, y: number, w: number, h: number): void {
    const session = this.session, clashes = this.clashes;
    if (clashes.selectedCount === 0) {
      session.sound.play(SoundId.Error);
      session.toast('Nothing picked yet', 2);
      return;
    }
    const groups = ClashGroups.ofTest(clashes.document, clashes.reviewTest ?? '').sort((a, b) => b.clashIds.length - a.clashIds.length);
    if (groups.length === 0) {
      session.sound.play(SoundId.Error);
      session.toast('This test has no groups yet: NEW GROUP makes one', 2.5);
      return;
    }
    const labels = groups.map(g => `${shorten(ClashGroups.displayName(g), 40)} (${g.clashIds.length})`);
    session.menu.overlays.openDropdown(clashes.list, DROP_DOCK_TOOL_ADD, x, y, Math.max(w, this.s(320)), h, labels, -1, i => {
      const picks = [...clashes.selection];
      this.leave();
      clashes.groups.addTo(groups[i], picks);
    });
  }

  // #endregion

  // #region CLUSTER AROUND…

  /** CLUSTER AROUND…: a sphere on the clash (the radius from last time, 1 m at first). */
  beginSphere(seed: ClashRecord | null): void {
    if (!seed) {
      this.session.sound.play(SoundId.Error);
      this.session.toast('Pick a clash first: the cluster starts round it', 2.5);
      return;
    }
    this.begin(CLASH_TOOL_SPHERE);
    this.clashes.clearSelectionKeepCurrent();
    this.sphereSeed = seed;
    this.sphereDirty = true;
    this.session.toast(`Cluster: drag the sphere's white handle to size it · click a dot (or row) to move the centre · ${keyOf(InputAction.ClashFrame)} groups · Esc cancels`, 4);
  }

  /** The handle: on the sphere's edge in the XY plane, across the view (so it sits on the outline). */
  private sphereHandleAxis(): Vec3 {
    const yaw = this.session.camera.yaw;
    return vec3(Math.sin(yaw), -Math.cos(yaw), 0);
  }

  /** Drag the handle (snapped; the free-drag key: free), click a dot to move the centre, RMB-drag looks. */
  private updateSphere(input: InputState, overUi: boolean): void {
    const session = this.session;
    if (!this.sphereSeed) {
      this.leave();
      return;
    }
    const mx = input.mouseX, my = input.mouseY;
    const centre = this.local(this.sphereSeed);
    if (this.sphereDragging) {
      if (!input.leftDown) {
        this.sphereDragging = false;
        session.sound.play(SoundId.UiClick);
        return;
      }
      const ray = session.screenRay(mx, my);
      const parameter = closestOnAxis(centre, this.sphereAxis, ray.origin, ray.direction);
      if (parameter !== null) {
        let radius = Math.max(CLASH_SPHERE_SNAP, parameter);
        if (!input.down(InputAction.SectionFreeDrag)) { radius = Math.max(CLASH_SPHERE_SNAP, Math.round(radius / CLASH_SPHERE_SNAP) * CLASH_SPHERE_SNAP); }
        radius = Math.min(radius, 500);
        if (Math.abs(radius - this.sphereRadius) > 1e-4) {
          this.sphereRadius = radius;
          this.sphereDirty = true;
        }
      }
      return;
    }
    this.look(input);
    const handle = V.add(centre, V.scale(this.sphereHandleAxis(), this.sphereRadius));
    const hs = session.camera.worldToScreen(handle);
    this.sphereHandleHover = !overUi && hs !== null && Math.hypot(hs.x - mx, hs.y - my) < this.s(14);
    this.updateHover(mx, my, overUi || this.sphereHandleHover);
    if (!input.leftPressed || overUi) { return; }
    if (this.sphereHandleHover) {
      input.consumeClicks();
      this.sphereDragging = true;
      this.sphereAxis = this.sphereHandleAxis();
      session.sound.play(SoundId.UiClick);
    } else if (this.hover) {
      input.consumeClicks();
      this.moveSphere(this.hover);
    }
  }

  /** A dot or row click: the sphere's centre moves to that clash. */
  moveSphere(clash: ClashRecord | null): void {
    if (!clash || clash === this.sphereSeed) { return; }
    this.sphereSeed = clash;
    this.sphereDirty = true;
    this.session.sound.play(SoundId.UiClick);
  }

  /** The shown clashes in the sphere (nearest first) and how many are in other groups, after a change. */
  private refreshSphere(): void {
    if (!this.sphereDirty || !this.sphereSeed) { return; }
    this.sphereDirty = false;
    this.sphereMembers.length = 0;
    this.sphereLookup.clear();
    const seed = this.sphereSeed;
    this.sphereMembers.push(...ClashGrouping.inSphere(this.clashes.list, seed.x, seed.y, seed.z, this.sphereRadius));
    this.sphereElsewhere = 0;
    for (const clash of this.sphereMembers) {
      this.sphereLookup.add(clash);
      if (this.clashes.groups.groupOf(clash)) { this.sphereElsewhere++; }
    }
    this.labelKey = '';
  }

  /** GROUP (Enter): the clashes in the sphere become "Cluster N · Level × n clashes". */
  private commitSphere(): void {
    const clashes = this.clashes;
    this.refreshSphere();
    if (this.sphereMembers.length === 0) {
      this.session.sound.play(SoundId.Error);
      this.session.toast('No shown clash is in the sphere (drag its handle, or check the filters)', 2.5);
      return;
    }
    const members = [...this.sphereMembers];
    const label = ClashGrouping.clusterLabel(clashes.document, clashes.reviewTest ?? '', members);
    this.leave();
    clashes.groups.groupClashes(members, null, label);
  }

  // #endregion

  // #region Bar

  /** The tool's bar at the bottom of the free view: title, live status, the buttons and the hint. */
  buildBar(f: FontAtlas, input: InputState, height: number, freeWidth: number): void {
    const session = this.session, ui = session.ui, wd = session.menu.widgets, overlays = session.menu.overlays, clashes = this.clashes;
    this.refreshLabels();
    const w = Math.min(this.s(760), freeWidth - this.s(40)), h = this.s(100);
    const x = Math.max(this.s(20), (freeWidth - w) * 0.5), y = height - h - this.s(16);
    this.barRect = [x, y, w, h];
    ui.panel(x, y, w, h, UiTheme.PANEL_STRONG, UiTheme.ACCENT);
    const ix = x + this.s(14), iw = w - this.s(28);
    let cy = y + this.s(10);
    const used = ui.text(f.small, ix, cy, this.title, UiTheme.ACCENT, this.s(1.4));
    ui.textWrapped(f.small, ix + used + this.s(14), cy, Math.max(this.s(40), iw - used - this.s(14)), this.status, UiTheme.TEXT, 1);
    cy += this.s(24);

    const bh = this.s(30);
    switch (this.tool) {
      case CLASH_TOOL_BOX: {
        const bw = (iw - this.s(18)) / 4;
        if (wd.smallButton(f, ix, cy, bw * 1.3, bh, this.commitLabel)) { this.barAction = BAR_COMMIT; }
        const bx = ix + bw * 1.3 + this.s(6), rest = (iw - bw * 1.3 - this.s(18)) / 3;
        if (wd.smallButton(f, bx, cy, rest, bh, this.boxFullHeight ? 'FULL HEIGHT: ON' : 'FULL HEIGHT: OFF')) { this.barAction = BAR_FULL_HEIGHT; }
        if (wd.smallButton(f, bx + rest + this.s(6), cy, rest, bh, 'FIT VIEW')) { this.barAction = BAR_FIT; }
        if (wd.smallButton(f, bx + (rest + this.s(6)) * 2, cy, rest, bh, 'CANCEL')) { this.barAction = BAR_CANCEL; }
        break;
      }
      case CLASH_TOOL_PICK: {
        const bw = (iw - this.s(18)) / 4;
        if (wd.smallButton(f, ix, cy, bw, bh, this.commitLabel)) { this.barAction = BAR_COMMIT; }
        const ax = ix + bw + this.s(6);
        if (overlays.button(f, input, ax, cy, bw, bh, 'ADD TO GROUP', overlays.isDropdownOpen(clashes.list, DROP_DOCK_TOOL_ADD))) { this.openPickAddTo(ax, cy, bw, bh); }
        if (wd.smallButton(f, ix + (bw + this.s(6)) * 2, cy, bw, bh, 'CLEAR')) { this.barAction = BAR_CLEAR; }
        if (wd.smallButton(f, ix + (bw + this.s(6)) * 3, cy, bw, bh, 'DONE')) { this.barAction = BAR_CANCEL; }
        break;
      }
      default: {
        const bw = (iw - this.s(6)) / 2;
        if (wd.smallButton(f, ix, cy, bw, bh, this.commitLabel)) { this.barAction = BAR_COMMIT; }
        if (wd.smallButton(f, ix + bw + this.s(6), cy, bw, bh, 'CANCEL')) { this.barAction = BAR_CANCEL; }
        break;
      }
    }
    cy += bh + this.s(8);
    ui.textWrapped(f.small, ix, cy, iw, this.tool === CLASH_TOOL_BOX ? HINT_CLASH_BOX.text : this.tool === CLASH_TOOL_PICK ? HINT_CLASH_PICK.text : HINT_CLASH_SPHERE.text,
      UiTheme.TEXT_FAINT, 1);

    // The marquee and the hovered dot's label
    if (this.marquee) {
      const [fx, fy] = this.marqueeFrom;
      const mx = Math.min(fx, input.mouseX), my = Math.min(fy, input.mouseY), mw = Math.abs(input.mouseX - fx), mh = Math.abs(input.mouseY - fy);
      ui.rect(mx, my, mw, mh, Rgba.hex(0x22d3ee, 0.12));
      ui.outline(mx, my, mw, mh, Math.max(1, ui.scale), Rgba.hex(0x22d3ee, 0.9));
    } else {
      this.drawHoverLabel(f, input, session.screenWidth);
    }
    // Clicks on the bar stay on the bar
    if (this.overBar(input.mouseX, input.mouseY) && input.leftPressed) { input.consumeClicks(); }
  }

  /** The dot under the mouse: its pair, status, level and group beside the cursor (C-C3: in clash mode too). */
  drawHoverLabel(f: FontAtlas, input: InputState, width: number): void {
    if (!this.hoverText || !this.hover) { return; }
    const ui = this.session.ui;
    const tw = Math.min(this.s(520), UiBatch.measure(f.small, this.hoverText) + this.s(20));
    const tx = Math.min(input.mouseX + this.s(16), width - tw - this.s(8)), ty = input.mouseY + this.s(16);
    ui.panel(tx, ty, tw, this.s(26), UiTheme.PANEL_STRONG, clashStatusColour(this.hover.status));
    ui.textWrapped(f.small, tx + this.s(10), ty + this.s(6), tw - this.s(20), this.hoverText, UiTheme.TEXT, 1);
  }

  /** The bar's title, status and main button (rebuilt when the counts, radius or units change). */
  private refreshLabels(): void {
    const clashes = this.clashes;
    let count: number;
    switch (this.tool) {
      case CLASH_TOOL_BOX: count = this.boxInside * 2 + (this.boxFullHeight ? 1 : 0); break;
      case CLASH_TOOL_PICK: count = clashes.selectedCount; break;
      default: this.refreshSphere(); count = this.sphereMembers.length; break;
    }
    const key = `${count}|${this.sphereRadius}|${UnitFormat.revision}|${clashes.list.length}`;
    if (key === this.labelKey) { return; }
    this.labelKey = key;
    const n = (v: number) => v.toLocaleString('en');
    switch (this.tool) {
      case CLASH_TOOL_BOX:
        this.title = this.boxGroup ? 'EDIT BOX' : 'GROUP BY BOX';
        this.status = `${n(this.boxInside)} of ${n(clashes.list.length)} shown clashes inside` + (this.boxFullHeight ? ' · full height' : '')
          + (this.boxGroup ? ` · “${shorten(ClashGroups.displayName(this.boxGroup), 34)}”` : '');
        this.commitLabel = this.boxGroup ? 'UPDATE + RECOLLECT' : `GROUP IN BOX (${n(this.boxInside)})`;
        break;
      case CLASH_TOOL_PICK:
        this.title = 'PICK POINTS';
        this.status = `${n(clashes.selectedCount)} picked`;
        this.commitLabel = `NEW GROUP (${n(clashes.selectedCount)})`;
        break;
      default:
        this.title = 'CLUSTER';
        this.status = `radius ${UnitFormat.length(this.sphereRadius, 2)} · ${n(this.sphereMembers.length)} clash${this.sphereMembers.length === 1 ? '' : 'es'}`
          + (this.sphereElsewhere > 0 ? ` (${this.sphereElsewhere} in other groups: they move)` : '');
        this.commitLabel = `GROUP (${n(this.sphereMembers.length)})`;
        break;
    }
  }

  /** Acts on the bar's button (after the dock's overlays). True when the tool ended. */
  runBarAction(): boolean {
    const action = this.barAction;
    this.barAction = BAR_NONE;
    if (this.tool === CLASH_TOOL_NONE) { return false; }
    switch (action) {
      case BAR_COMMIT: this.commit(); return true;
      case BAR_CANCEL: this.cancel(); return true;
      case BAR_FULL_HEIGHT: this.toggleFullHeight(); return false;
      case BAR_FIT: this.fitView(); return false;
      case BAR_CLEAR: this.clearPicks(); return false;
      default: return false;
    }
  }

  // #endregion

  // #region Drawing

  /** The tool's 3D marks: the dots (marked amber), and the cluster's wire sphere and handle. */
  draw(): void {
    const session = this.session, clashes = this.clashes;
    if (!clashes.modeOn || this.tool === CLASH_TOOL_NONE) { return; }
    if (!this.overlay) {
      this.overlay = new Overlay3D();
      this.overlay.initialise();
    }
    this.refreshDots();
    if (this.tool === CLASH_TOOL_SPHERE) { this.refreshSphere(); }
    const o = this.overlay, camera = session.camera;
    o.begin(camera);
    const amber = Rgba.hex(0xf59e0b);
    const centre = this.sphereSeed ? this.local(this.sphereSeed) : vec3();
    let lines = 0;
    for (const clash of this.dots) {
      const p = this.local(clash);
      const hovered = clash === this.hover;
      const marked = this.tool === CLASH_TOOL_BOX ? this.inBox(clash)
        : this.tool === CLASH_TOOL_PICK ? clashes.selectedCount > 0 && clashes.isSelectedClash(clash) : this.sphereLookup.has(clash);
      if (marked && this.tool === CLASH_TOOL_SPHERE && lines < 400) {
        o.line(centre, p, 1.5, Rgba.hex(0xf59e0b, 0.55));
        lines++;
      }
      if (marked) {
        o.dot(p, this.s(hovered ? 10 : 8), amber);
        o.dot(p, this.s(hovered ? 6.5 : 5), clashStatusColour(clash.status));
      } else {
        if (hovered) { o.dot(p, this.s(9), Rgba.hex(0xffffff)); }
        o.dot(p, this.s(hovered ? 6.5 : 4.5), clashStatusColour(clash.status));
      }
    }
    if (this.tool === CLASH_TOOL_SPHERE && this.sphereSeed) {
      const r = this.sphereRadius, thickness = Math.max(0.01, r * 0.012);
      o.ring(centre, vec3(1, 0, 0), vec3(0, 1, 0), r, r, thickness * 1.5, Rgba.hex(0x22d3ee, 0.85), 64); // the XY ring: the handle's
      o.ring(centre, vec3(1, 0, 0), vec3(0, 0, 1), r, r, thickness, Rgba.hex(0x22d3ee, 0.5), 48);
      o.ring(centre, vec3(0, 1, 0), vec3(0, 0, 1), r, r, thickness, Rgba.hex(0x22d3ee, 0.5), 48);
      const right = this.sphereHandleAxis();
      const up = V.normalize(V.cross(right, camera.forward));
      if (Number.isFinite(up.x)) { o.ring(centre, right, up, r, r, thickness, Rgba.hex(0x22d3ee, 0.35), 64); } // the outline
      const axis = this.sphereDragging ? this.sphereAxis : right;
      const handle = V.add(centre, V.scale(axis, r));
      o.line(centre, handle, 2, Rgba.hex(0xffffff, 0.8));
      const active = this.sphereDragging || this.sphereHandleHover;
      o.dot(handle, this.s(active ? 11 : 8.5), Rgba.hex(0xffffff));
      o.dot(handle, this.s(active ? 7 : 5.5), Rgba.hex(0x22d3ee));
      o.dot(centre, this.s(7), Rgba.hex(0xffffff));
    }
    o.draw(camera, true, 1, false);
    o.draw(camera, false, 0.4, false);
  }

  // #endregion
}
