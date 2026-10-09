import { vec3 } from '../core/math/Vector';
import { type RoomInfo, roomContains, roomDistanceToBoundary } from '../core/scene/SceneData';
import { CharacterController } from '../engine/physics/CharacterController';
import { Rgba } from '../engine/ui/Rgba';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import type { Widgets } from './Menus';

/** One row of the list (labels made once per session). */
interface RoomRow {
  room: number;
  title: string;
  detail: string;
  search: string;
  elevation: number;
}

const SEARCH_MAX = 40;

/**
 * Find room (pause menu → FIND ROOM, or Ctrl+F; port of GameSession.Rooms.cs): every room of the model (host and
 * linked), searchable by number, name or level; picking one stands the player on a clear spot of its floor near the
 * middle, facing across it.
 */
export class RoomFinder {
  open = false;
  private scroll = 0;
  private search = '';
  private rows: RoomRow[] | null = null;
  private matches: RoomRow[] = [];
  private matchesDirty = true;

  constructor(private readonly session: GameSession, private readonly w: Widgets) {}

  private s(v: number): number { return this.session.s(v); }

  /** Opens the list (pausing the walkthrough); without rooms, says so. */
  show(): void {
    const session = this.session;
    if (session.scene.rooms.length === 0) {
      session.sound.play(SoundId.Error);
      session.toast('This model has no placed rooms to find', 3);
      return;
    }
    if (!session.paused) { session.setPaused(true); }
    this.open = true;
    this.scroll = 0;
    this.matchesDirty = true;
  }

  close(): boolean {
    if (!this.open) { return false; }
    this.open = false;
    return true;
  }

  /**
   * Stands the player in a room: the clear floor spot nearest the middle of the room (at least 0.45 m from its walls),
   * on the floor under it, facing across the room.
   * @returns False when no clear spot was found (the player stays put).
   */
  teleportToRoom(index: number): boolean {
    const session = this.session, player = session.player;
    const room = session.scene.rooms[index];
    if (!room) { return false; }
    const cx = (room.min.x + room.max.x) * 0.5, cy = (room.min.y + room.max.y) * 0.5;

    // Candidate spots on a 0.4 m grid inside the room, nearest the middle first
    let spots: { x: number; y: number }[] = [];
    for (let y = room.min.y + 0.2; y <= room.max.y; y += 0.4) {
      for (let x = room.min.x + 0.2; x <= room.max.x; x += 0.4) {
        const p = { x, y };
        if (roomContains(room, p) && roomDistanceToBoundary(room, p) >= 0.45) { spots.push(p); }
      }
    }
    if (spots.length === 0) {
      // A tiny or thin room: any point inside will do
      outer: for (let y = room.min.y + 0.05; y <= room.max.y; y += 0.1) {
        for (let x = room.min.x + 0.05; x <= room.max.x; x += 0.1) {
          if (roomContains(room, { x, y })) { spots.push({ x, y }); break outer; }
        }
      }
    }
    spots.sort((a, b) => ((a.x - cx) ** 2 + (a.y - cy) ** 2) - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
    spots = spots.slice(0, 400);

    for (const spot of spots) {
      const feet = session.floorAt(spot.x, spot.y, room.bottomZ);
      if (feet.z > room.topZ - 1) { continue; }
      if (player.controller.overlaps(vec3(feet.x, feet.y, feet.z + 0.01), CharacterController.STAND_HEIGHT)) { continue; }

      // Face the far side of the room (along its longer side when standing at the middle)
      let lx = cx - spot.x, ly = cy - spot.y;
      if (lx * lx + ly * ly < 0.25) {
        const wide = room.max.x - room.min.x >= room.max.y - room.min.y;
        lx = wide ? 1 : 0;
        ly = wide ? 0 : 1;
      }
      if (player.flying) { player.toggleFly(); }
      player.teleportTo(feet, Math.atan2(ly, lx), 0);
      return true;
    }
    return false;
  }

  /** Draws and handles the room list (in place of the pause menu). Typing goes into the search box. */
  build(): void {
    const session = this.session, ui = session.ui, f = ui.atlas, w = this.w;
    const width = session.screenWidth, height = session.screenHeight;
    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    const pw = Math.min(this.s(820), width - this.s(80)), ph = height - this.s(96);
    const x = (width - pw) * 0.5, y = this.s(48);
    ui.panel(x, y, pw, ph, UiTheme.CARD, UiTheme.CARD_BORDER);

    const ix = x + this.s(24), iw = pw - this.s(48);
    let cy = y + this.s(20);
    ui.text(f.small, ix, cy, 'FIND ROOM', UiTheme.ACCENT, this.s(2));
    ui.textRight(f.small, ix + iw, cy, `${session.scene.rooms.length.toLocaleString('en')} rooms · type a number, name or level`, UiTheme.TEXT_MUTED, this.s(0.6));
    cy += this.s(32);

    // Search box (typing anywhere in the panel goes here; Enter goes to the first match)
    const enter = this.type();
    const boxH = this.s(36);
    ui.panel(ix, cy, iw, boxH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
    const ty = cy + boxH * 0.5 - f.body.lineHeight * 0.5;
    if (this.search.length === 0) {
      ui.text(f.body, ix + this.s(10), ty, 'e.g. 2.05, kitchen, Level 2', UiTheme.TEXT_FAINT);
    } else {
      const used = ui.text(f.body, ix + this.s(10), ty, this.search, UiTheme.TEXT);
      if ((Math.trunc(session.clock * 2) & 1) === 0) { ui.rect(ix + this.s(11) + used, cy + this.s(8), this.s(2), boxH - this.s(16), UiTheme.TEXT_SOFT); }
    }
    cy += boxH + this.s(16);

    this.refreshMatches();
    const buttonsY = y + ph - this.s(24) - this.s(44);
    let go = this.buildRows(ix, cy, iw, buttonsY - this.s(16));
    if (enter && this.matches.length > 0) { go = this.matches[0]; }

    ui.text(f.small, ix + this.s(176), buttonsY + this.s(14), 'Click a room (or Enter for the first) to go there · Esc back', UiTheme.TEXT_MUTED);
    if (w.menuButton(f, ix, buttonsY, this.s(160), 'CLOSE', false, false, true, this.s(44))) { this.close(); return; }

    if (!go) { return; }
    this.close();
    session.setPaused(false);
    if (this.teleportToRoom(go.room)) {
      session.sound.play(SoundId.Teleport);
      session.toast(`${go.title} · ${go.detail}`, 2.6);
    } else {
      session.sound.play(SoundId.Error);
      session.toast(`No clear spot to stand in ${go.title}`, 3, true);
    }
  }

  private buildRows(x: number, y: number, width: number, bottom: number): RoomRow | null {
    const session = this.session, ui = session.ui, f = ui.atlas, input = session.input;
    if (this.matches.length === 0) {
      ui.text(f.body, x, y + this.s(6), 'No room matches. Backspace to change the search.', UiTheme.TEXT_MUTED);
      return null;
    }

    const rowH = this.s(44);
    const visible = Math.max(1, Math.trunc((bottom - y) / rowH));
    const maxScroll = Math.max(0, this.matches.length - visible);
    if (input.wheel !== 0) { this.scroll -= input.wheel * 3; }
    this.scroll = Math.min(Math.max(this.scroll, 0), maxScroll);

    let picked: RoomRow | null = null;
    const current = session.currentRoom;
    const last = Math.min(this.matches.length, this.scroll + visible);
    for (let i = this.scroll; i < last; i++) {
      const row = this.matches[i];
      const ry = y + (i - this.scroll) * rowH;
      const hover = this.w.hover(x, ry, width, rowH - this.s(4));
      const here = current !== null && session.scene.rooms[row.room] === current;
      if (hover || (i & 1) === 0) { ui.rect(x, ry, width, rowH - this.s(4), hover ? Rgba.hex(0xffffff, 0.08) : Rgba.hex(0xffffff, 0.03)); }
      ui.textWrapped(f.bold, x + this.s(12), ry + this.s(10), width * 0.55, row.title, here ? UiTheme.ACCENT : UiTheme.TEXT, 1);
      ui.textRight(f.body, x + width - this.s(12), ry + this.s(11), row.detail, UiTheme.TEXT_MUTED);
      if (hover && input.leftPressed) {
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
        picked = row;
      }
    }
    if (maxScroll > 0) {
      ui.textRight(f.small, x + width, bottom + this.s(2), `${this.scroll + 1}–${last} of ${this.matches.length} · wheel to scroll`, UiTheme.TEXT_FAINT);
    }
    return picked;
  }

  /** Typed characters go into the search (Backspace deletes, Ctrl+Backspace clears). True when Enter was pressed. */
  private type(): boolean {
    const input = this.session.input;
    const before = this.search;
    if (input.isPressedOrRepeated(Vk.BACK)) { this.search = input.isDown(Vk.CONTROL) ? '' : this.search.slice(0, -1); }
    for (const c of input.typed) {
      if (c >= ' ' && c !== '\u007f' && this.search.length < SEARCH_MAX) { this.search += c; }
    }
    if (this.search !== before) {
      this.matchesDirty = true;
      this.scroll = 0;
    }
    return input.isPressed(Vk.RETURN);
  }

  /** The rows (built once), then the matches for the current search (every word in the number, name or level). */
  private refreshMatches(): void {
    this.rows ??= this.buildRowList();
    if (!this.matchesDirty) { return; }
    this.matchesDirty = false;

    const words = this.search.toLowerCase().split(' ').filter(Boolean);
    this.matches = this.rows.filter(row => words.every(word => row.search.includes(word)));

    // An exact number match goes first (typing "2.05" then Enter goes to 2.05, not 12.05)
    if (words.length === 1) {
      const rooms = this.session.scene.rooms;
      const exact = this.matches.findIndex(r => rooms[r.room].number.toLowerCase() === words[0]);
      if (exact > 0) { this.matches.unshift(...this.matches.splice(exact, 1)); }
    }
  }

  /** One row per room ("2.05 · Kitchen", "Level 2 · 14.2 m²" + the link's name), sorted by level then title. */
  private buildRowList(): RoomRow[] {
    const session = this.session, scene = session.scene;
    const rows = scene.rooms.map((room, i): RoomRow => {
      const level = session.levelNameAt(room.bottomZ);
      const link = room.link > 0 && room.link <= scene.links.length ? ` · ${scene.links[room.link - 1].name}` : '';
      const title = !room.number.trim() || room.number === '—' ? room.name : `${room.number} · ${room.name}`;
      return {
        room: i,
        title,
        detail: `${level} · ${planArea(room).toFixed(1)} m²${link}`,
        search: `${room.number} ${room.name} ${level}${link}`.toLowerCase(),
        elevation: room.bottomZ
      };
    });
    rows.sort((a, b) => a.elevation - b.elevation || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    return rows;
  }
}

/** The room's plan area (outer loop minus holes: the largest loop is the outline). */
export function planArea(room: RoomInfo): number {
  let outer = 0, holes = 0;
  for (const loop of room.loops) {
    if (loop.length < 3) { continue; }
    let area = 0;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) { area += loop[j].x * loop[i].y - loop[i].x * loop[j].y; }
    area = Math.abs(area) * 0.5;
    if (area > outer) { holes += outer; outer = area; } else { holes += area; }
  }
  return Math.max(0, outer - holes);
}
