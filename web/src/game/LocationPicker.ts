import type { LocationOverride } from '../core/format/DocumentModels';
import { type Place, PlaceIndex, TimeZones } from '../core/scene/Places';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import type { Widgets } from './Menus';
import { formatZone } from './SunState';

/** Typed coordinates borrow the time zone of a listed place this close (km). */
const NEAREST_ZONE_KM = 300;

/** Results shown under the search box. */
const LOCATION_RESULTS = 6;

/** Longest search text. */
const MAX_QUERY = 64;

/** The bundled place list, loaded once per page (fetched the first time the picker opens). */
let places: Promise<PlaceIndex> | null = null;

function loadPlaces(): Promise<PlaceIndex> {
  places ??= fetch(`${import.meta.env.BASE_URL}places.tsv`)
    .then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(text => PlaceIndex.load(text))
    .catch(e => {
      console.warn('Place list not loaded', e);
      places = null; // try again next time
      return PlaceIndex.load('');
    });
  return places;
}

/**
 * Location override (port of GameSession.Location.cs): a site location chosen in BimGo replaces the Revit site's for
 * the sun, shadows, sun hours, Daylight % and Lux. Opened from the sun panel (CHANGE…): type a city (the bundled
 * Natural Earth list, offline: fetched from this site, never a web service) or paste "lat, long" from a map. A place
 * brings its IANA time zone, so daylight saving follows the date (DST AUTO); typed coordinates borrow the zone of the
 * nearest listed place within 300 km. Saved with the model in sun.json; RESET goes back to Revit's location. Revit is
 * never changed, and true north stays the model's.
 */
export class LocationPicker {
  open = false;
  private index: PlaceIndex | null = null;
  private loading = false;
  private query = '';
  private dirty = false;
  private results: Place[] = [];
  private details: string[] = [];
  private coordinates: { latitude: number; longitude: number } | null = null;
  private near: { place: Place; km: number } | null = null;
  private coordinatesTitle = '';
  private coordinatesDetail = '';
  private notice: string | null = null;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  /** Opens the picker inside the sun panel (the place list loads the first time). */
  show(): void {
    this.open = true;
    this.query = '';
    this.dirty = true;
    this.notice = null;
    this.session.input.releaseAll();
    if (!this.index && !this.loading) {
      this.loading = true;
      void loadPlaces().then(index => {
        this.index = index;
        this.loading = false;
        this.dirty = true;
        this.notice = index.count === 0 ? "The place list couldn't be loaded: type or paste coordinates (lat, long) instead" : null;
        console.info(`Place list: ${index.count} places.`);
      });
    }
  }

  /** Back to the sun panel. */
  close(): void {
    this.open = false;
    this.session.input.releaseAll();
  }

  /**
   * Keys while the picker is open: typing and Backspace edit the search, Ctrl+V pastes, Enter takes the first result,
   * Esc goes back to the sun panel.
   */
  updateKeys(input: InputState): void {
    if (input.isPressed(Vk.ESCAPE)) {
      this.close();
      return;
    }
    if (input.pasted) {
      // The clipboard's first line replaces the search (coordinates copied from a map)
      this.query = [...input.pasted.split('\n')[0].trim()].filter(c => c >= ' ').join('').slice(0, MAX_QUERY);
      this.dirty = true;
    } else {
      if (input.isPressedOrRepeated(Vk.BACK) && this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.dirty = true;
      }
      for (const c of input.typed) {
        if (c >= ' ' && this.query.length < MAX_QUERY) {
          this.query += c;
          this.dirty = true;
        }
      }
    }
    if (this.dirty) { this.search(); }

    if (input.isPressed(Vk.RETURN)) {
      if (this.coordinates) { this.useCoordinates(); }
      else if (this.results.length > 0) { this.usePlace(this.results[0]); }
    }
  }

  /**
   * Searches after the text changed: coordinates when it reads as "lat, long" (with the nearest listed place for the
   * time zone), and the place list either way.
   */
  private search(): void {
    this.dirty = false;
    this.coordinates = PlaceIndex.parseCoordinates(this.query);
    this.near = null;
    if (this.coordinates) {
      const { latitude, longitude } = this.coordinates;
      this.near = this.index?.nearest(latitude, longitude, NEAREST_ZONE_KM) ?? null;
      this.coordinatesTitle = `USE ${formatCoordinates(latitude, longitude)}`;
      const offset = TimeZones.standardOffset(this.near?.place.zoneId, longitude);
      this.coordinatesDetail = this.near
        ? `near ${this.near.place.name} (${Math.round(this.near.km)} km) · UTC${formatZone(offset)} · ${zoneOrNone(this.near.place.zoneId)}`
        : `UTC${formatZone(offset)} estimated from the longitude (no listed place within ${NEAREST_ZONE_KM} km)`;
    }

    this.results = !this.coordinates && this.index ? this.index.search(this.query, LOCATION_RESULTS) : [];
    this.details = this.results.map(place =>
      `${formatCoordinates(place.latitude, place.longitude)} · UTC${formatZone(TimeZones.standardOffset(place.zoneId, place.longitude))} · ${zoneOrNone(place.zoneId)}`);
  }

  /** Takes a listed place: its coordinates, label and time zone (daylight saving automatic when the zone is known). */
  private usePlace(place: Place): void {
    const zone = place.zoneId || null;
    this.apply({
      latitude: place.latitude, longitude: place.longitude, zoneId: zone, timeZone: TimeZones.standardOffset(zone, place.longitude),
      autoDaylightSaving: zone !== null && TimeZones.isKnown(zone), name: place.label
    });
  }

  /** Takes the typed coordinates, with the nearest listed place's time zone (else the longitude estimate). */
  private useCoordinates(): void {
    if (!this.coordinates) { return; }
    const { latitude, longitude } = this.coordinates;
    const zone = this.near?.place.zoneId || null;
    const near = this.near ? ` (near ${this.near.place.name})` : '';
    this.apply({
      latitude, longitude, zoneId: zone, timeZone: TimeZones.standardOffset(zone, longitude),
      autoDaylightSaving: zone !== null && TimeZones.isKnown(zone), name: formatCoordinates(latitude, longitude) + near
    });
  }

  /** Sets (or with null clears) the override: the sun follows, study results go out of date. */
  private apply(location: LocationOverride | null): void {
    const session = this.session;
    session.sun.setLocation(location);
    session.sunHours.markStale();
    session.sound.play(SoundId.Commit);
    session.toast(session.sun.settings.location ? `Location: ${session.sun.settings.location.name}` : 'Back to the model\'s location', 3);
    this.close();
  }

  /** − / + on the UTC offset (the offset becomes manual). */
  private stepOffset(direction: number): void {
    this.session.sun.stepOffset(direction);
    this.session.sunHours.markStale();
  }

  /**
   * The picker, drawn in the sun panel's place: model and current location, the search box, coordinates or results,
   * the UTC offset (manual tweak), RESET and the place list's credit.
   */
  build(f: FontAtlas, w: Widgets, input: InputState, x: number, y: number, width: number, height: number): void {
    const session = this.session, ui = session.ui, sun = session.sun;
    const ix = x + this.s(16), iw = width - this.s(32);
    let cy = y + this.s(14);

    ui.text(f.small, ix, cy, 'SITE LOCATION', UiTheme.SUN_LABEL, this.s(2));
    ui.textRight(f.small, ix + iw, cy, 'ESC BACK', UiTheme.TEXT_FAINT, this.s(0.6));
    cy += this.s(24);
    let used = ui.text(f.small, ix, cy, 'REVIT MODEL  ', UiTheme.TEXT_FAINT);
    ui.textWrapped(f.small, ix + used, cy, iw - used, sun.modelPlaceLabel, UiTheme.TEXT_MUTED, 1);
    cy += this.s(18);
    used = ui.text(f.small, ix, cy, 'IN USE  ', UiTheme.TEXT_FAINT);
    ui.textWrapped(f.small, ix + used, cy, iw - used, sun.hasOverride ? sun.placeLabel : "the model's location", sun.hasOverride ? UiTheme.SUN : UiTheme.TEXT_MUTED, 1);
    cy += this.s(26);

    // Search box (always focused while the picker is open)
    const boxH = this.s(34);
    ui.rect(ix, cy, iw, boxH, Rgba.hex(0xffffff, 0.08));
    ui.outline(ix, cy, iw, boxH, Math.max(1, ui.scale), UiTheme.SUN);
    const textY = cy + boxH * 0.5 - f.body.lineHeight * 0.5;
    const caret = session.clock % 1 < 0.55;
    if (this.query.length === 0) {
      ui.text(f.body, ix + this.s(10), textY, 'Type a city, or paste lat, long (Ctrl+V)', UiTheme.TEXT_FAINT);
      if (caret) { ui.rect(ix + this.s(10), cy + this.s(8), this.s(1.5), boxH - this.s(16), UiTheme.SUN); }
    } else {
      const typed = ui.text(f.body, ix + this.s(10), textY, this.query, UiTheme.TEXT);
      if (caret) { ui.rect(ix + this.s(11) + typed, cy + this.s(8), this.s(1.5), boxH - this.s(16), UiTheme.SUN); }
    }
    cy += boxH + this.s(10);

    // Coordinates, or the matching places
    const rowH = this.s(46);
    if (this.coordinates) {
      if (this.row(f, input, ix, cy, iw, rowH, this.coordinatesTitle, this.coordinatesDetail)) { this.useCoordinates(); return; }
      cy += rowH + this.s(4);
    } else if (this.results.length === 0) {
      const hint = this.loading ? 'Loading the place list…'
        : this.query.length === 0 ? 'About 7,000 cities and towns, offline. For an exact site, paste its coordinates, e.g. −33.8568, 151.2153.'
          : 'No listed place matches. Try the city\'s name, or paste coordinates.';
      ui.textWrapped(f.small, ix, cy + this.s(4), iw, hint, UiTheme.TEXT_MUTED, 3);
    }
    let chosen: Place | null = null;
    this.results.forEach((place, i) => {
      if (this.row(f, input, ix, cy, iw, rowH, place.label, this.details[i])) { chosen = place; }
      cy += rowH + this.s(4);
    });
    if (chosen) {
      this.usePlace(chosen);
      return;
    }

    // Bottom: the UTC offset (override only), RESET, credit
    let by = y + height - this.s(16) - this.s(16) - this.s(30) - this.s(40);
    if (this.notice) { ui.textWrapped(f.small, ix, by - this.s(22), iw, this.notice, UiTheme.MEASURE_LABEL, 1); }
    if (sun.hasOverride) {
      ui.text(f.body, ix, by + this.s(6), 'UTC offset', UiTheme.TEXT_SOFT);
      ui.textRight(f.mono, ix + iw - this.s(80), by + this.s(7), sun.offsetLabel ?? '', Rgba.hex(0x67e8f9));
      if (w.smallButton(f, ix + iw - this.s(70), by, this.s(32), this.s(30), '−')) { this.stepOffset(-1); }
      if (w.smallButton(f, ix + iw - this.s(32), by, this.s(32), this.s(30), '+')) { this.stepOffset(+1); }
    }
    by += this.s(40);
    if (sun.hasOverride && w.smallButton(f, ix, by, iw, this.s(30), "RESET TO THE REVIT MODEL'S LOCATION")) {
      this.apply(null);
      return;
    }
    by += this.s(38);
    ui.text(f.small, ix, by, 'Places: Natural Earth (public domain) · Revit is never changed', UiTheme.TEXT_FAINT, this.s(0.2));
  }

  /** A clickable two-line result row. */
  private row(f: FontAtlas, input: InputState, x: number, y: number, w: number, h: number, title: string, detail: string): boolean {
    const session = this.session, ui = session.ui;
    const hover = input.mouseX >= x && input.mouseX < x + w && input.mouseY >= y && input.mouseY < y + h;
    ui.rect(x, y, w, h, hover ? Rgba.hex(0xffffff, 0.1) : UiTheme.CONTROL);
    ui.outline(x, y, w, h, Math.max(1, ui.scale), hover ? UiTheme.SUN : UiTheme.CONTROL_BORDER);
    ui.textWrapped(f.bold, x + this.s(10), y + this.s(6), w - this.s(20), title, hover ? UiTheme.SUN : UiTheme.TEXT, 1);
    ui.textWrapped(f.small, x + this.s(10), y + this.s(27), w - this.s(20), detail, UiTheme.TEXT_MUTED, 1);
    const clicked = hover && input.leftPressed;
    if (clicked) {
      input.consumeClicks();
      session.sound.play(SoundId.UiClick);
    }
    return clicked;
  }
}

function zoneOrNone(zone: string): string {
  return zone ? zone : 'no time zone listed';
}

/** "−33.8688°, 151.2093°". */
export function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`.replace(/-/g, '−');
}
