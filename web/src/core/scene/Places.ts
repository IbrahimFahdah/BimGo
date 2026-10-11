/**
 * IANA time zones through the browser's Intl (port of TimeZones in BimGo.Core/Scene/Places.cs: the desktop asks
 * Windows; every modern browser and Node ship the IANA database). Results are cached; never throws.
 */
export const TimeZones = {
  /** True when the browser knows an IANA id ("Australia/Sydney"). */
  isKnown(ianaId: string | null | undefined): boolean {
    return formatterFor(ianaId) !== null;
  },

  /**
   * A zone's offset from UTC at an instant (hours, daylight saving included), or NaN for an unknown zone.
   */
  offsetAt(ianaId: string | null | undefined, utcMillis: number): number {
    const format = formatterFor(ianaId);
    if (!format || !Number.isFinite(utcMillis)) { return NaN; }
    const parts: Record<string, number> = {};
    for (const part of format.formatToParts(new Date(utcMillis))) {
      if (part.type !== 'literal') { parts[part.type] = Number(part.value); }
    }
    const hour = parts.hour === 24 ? 0 : parts.hour;
    const local = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
    return Math.round((local - Math.floor(utcMillis / 1000) * 1000) / 60000) / 60;
  },

  /**
   * A zone's standard offset (hours from UTC, without daylight saving: the smaller of this year's January and July
   * offsets), or the longitude estimate when the zone is unknown.
   */
  standardOffset(ianaId: string | null | undefined, longitude: number, year = new Date().getFullYear()): number {
    if (!formatterFor(ianaId)) { return TimeZones.estimateOffset(longitude); }
    const january = TimeZones.offsetAt(ianaId, Date.UTC(year, 0, 1, 12));
    const july = TimeZones.offsetAt(ianaId, Date.UTC(year, 6, 1, 12));
    return Math.min(january, july);
  },

  /**
   * Whether the zone is on daylight saving at local noon of a date.
   * @returns Null when the zone is unknown.
   */
  isDaylightSaving(ianaId: string | null | undefined, year: number, month: number, day: number): boolean | null {
    if (!formatterFor(ianaId)) { return null; }
    const standard = TimeZones.standardOffset(ianaId, 0, year);
    const instant = Date.UTC(year, month - 1, day, 12) - standard * 3600000;
    return TimeZones.offsetAt(ianaId, instant) > standard + 1e-6;
  },

  /** The nearest whole-hour offset for a longitude (15° per hour): a first guess to edit. */
  estimateOffset(longitude: number): number {
    return Number.isFinite(longitude) ? Math.min(Math.max(Math.round(longitude / 15), -12), 14) + 0 : 0;
  }
};

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(ianaId: string | null | undefined): Intl.DateTimeFormat | null {
  const id = ianaId?.trim();
  if (!id) { return null; }
  const key = id.toLowerCase();
  if (formatters.has(key)) { return formatters.get(key)!; }
  let format: Intl.DateTimeFormat | null;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: id, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
    });
  } catch {
    format = null; // RangeError: not a zone this browser knows
  }
  formatters.set(key, format);
  return format;
}

/** One place of the bundled list (port of Place). */
export interface Place {
  name: string;
  /** State / province / region, or empty. */
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  /** IANA time zone, or empty. */
  zoneId: string;
  /** Population (ranking). */
  population: number;
  /** "Sydney, New South Wales, Australia". */
  label: string;
  /** Folded search keys: the name, and name + region + country. */
  nameKey: string;
  allKey: string;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** A number in invariant form (double.TryParse with NumberStyles.Float), or NaN. */
function parseNumber(text: string): number {
  const t = text.trim();
  return NUMBER.test(t) ? Number(t) : NaN;
}

/**
 * The bundled place list (port of PlaceIndex): about 7,000 cities and towns from Natural Earth's 1:10m populated
 * places (public domain), with IANA time zones. One line per place, tab separated: name, region, country, latitude,
 * longitude, zone, population; '#' lines are comments. Searching ranks name matches (exact, then starting with, then
 * containing) before region / country matches, larger places first. Never throws.
 */
export class PlaceIndex {
  private readonly places: Place[] = [];

  /** Number of places. */
  get count(): number {
    return this.places.length;
  }

  /** Reads a list. Bad lines are skipped. */
  static load(text: string): PlaceIndex {
    const index = new PlaceIndex();
    for (const line of (text ?? '').split(/\r?\n/)) {
      if (line.length === 0 || line[0] === '#') { continue; }
      const parts = line.split('\t');
      if (parts.length < 7) { continue; }
      const lat = parseNumber(parts[3]), lon = parseNumber(parts[4]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { continue; }
      const population = /^\s*[+-]?\d+\s*$/.test(parts[6]) ? Number(parts[6]) : 0;
      const name = parts[0].trim(), region = parts[1].trim(), country = parts[2].trim();
      if (name.length === 0) { continue; }
      const label = [name, region === name ? '' : region, country].filter(t => t.length > 0).join(', ');
      index.places.push({
        name, region, country, latitude: lat, longitude: lon, zoneId: parts[5].trim(), population, label,
        nameKey: PlaceIndex.fold(name), allKey: PlaceIndex.fold(label)
      });
    }
    return index;
  }

  /**
   * Searches by name, region and country. Every word of the query must match somewhere in "name, region, country";
   * the first word is ranked against the name.
   */
  search(query: string, max = 8): Place[] {
    const words = PlaceIndex.fold(query ?? '').split(/[ ,]+/).filter(w => w.length > 0);
    if (words.length === 0 || max <= 0) { return []; }

    const scored: { rank: number; place: Place }[] = [];
    const phrase = words.join(' ');
    for (const place of this.places) {
      if (!words.every(word => place.allKey.includes(word))) { continue; }
      // 0 the name is the whole query, 1 the name is the first word ("perth aus"), 2 the name starts with the query,
      // 3 with the first word, 4 contains the first word, 5 only the region / country match
      const rank = place.nameKey === phrase ? 0
        : place.nameKey === words[0] ? 1
          : place.nameKey.startsWith(phrase) ? 2
            : place.nameKey.startsWith(words[0]) ? 3
              : place.nameKey.includes(words[0]) ? 4
                : 5;
      scored.push({ rank, place });
    }
    scored.sort((a, b) => a.rank !== b.rank ? a.rank - b.rank : b.place.population - a.place.population);
    return scored.slice(0, max).map(s => s.place);
  }

  /**
   * The nearest place to a point (great-circle distance), within a limit: typed coordinates borrow its time zone.
   * @returns The place and how far it is, or null when none is that close.
   */
  nearest(latitude: number, longitude: number, maxKm: number): { place: Place; km: number } | null {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) { return null; }
    let best: Place | null = null, bestKm = Number.MAX_VALUE;
    for (const place of this.places) {
      const km = PlaceIndex.distanceKm(latitude, longitude, place.latitude, place.longitude);
      if (km < bestKm) {
        bestKm = km;
        best = place;
      }
    }
    return best && bestKm <= maxKm ? { place: best, km: bestKm } : null;
  }

  /** Great-circle distance (km, spherical Earth). */
  static distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371, D = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * D / 2), b = Math.sin((lon2 - lon1) * D / 2);
    const h = a * a + Math.cos(lat1 * D) * Math.cos(lat2 * D) * b * b;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * Reads typed coordinates: "-33.86, 151.21", "-33.86 151.21", "33.86S 151.21E", "33°51′S, 151°12′E" (degrees and
   * minutes), as copied from a map.
   * @returns The latitude and longitude, or null when the text isn't a pair in range.
   */
  static parseCoordinates(text: string): { latitude: number; longitude: number } | null {
    if (!text?.trim()) { return null; }
    // Split into two halves: at a comma / semicolon, else at the space between two numbers
    const t = text.trim().replace(/−/g, '-');
    let halves = t.split(/[,;]/).filter(h => h.length > 0);
    if (halves.length !== 2) {
      halves = t.split(/\s+/).filter(h => h.length > 0);
      if (halves.length !== 2) { return null; }
    }
    const latitude = parseAngle(halves[0], 'N', 'S'), longitude = parseAngle(halves[1], 'E', 'W');
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) { return null; }
    return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
  }

  /** Lower case without accents ("São Paulo" → "sao paulo") for matching. */
  static fold(text: string): string {
    if (!text) { return ''; }
    const map: Record<string, string> = { 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ß': 's', '–': ' ', '-': ' ', "'": ' ' };
    const folded = text.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').replace(/[łøđß–\-']/g, c => map[c]);
    return folded.split(' ').filter(w => w.length > 0).join(' ');
  }
}

/** One angle: decimal degrees or degrees / minutes / seconds, optional hemisphere letter; NaN when unreadable. */
function parseAngle(text: string, positive: string, negative: string): number {
  let s = text.trim().toUpperCase();
  let sign = 1;
  if (s.endsWith(positive)) { s = s.slice(0, -1); }
  else if (s.endsWith(negative)) { s = s.slice(0, -1); sign = -1; }
  else if (s.startsWith(positive)) { s = s.slice(1); }
  else if (s.startsWith(negative)) { s = s.slice(1); sign = -1; }

  // Degrees / minutes / seconds: split on the symbols
  const parts = s.split(/[°'′"″ ]/).filter(p => p.length > 0);
  if (parts.length === 0 || parts.length > 3) { return NaN; }
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parseNumber(parts[i]);
    if (!Number.isFinite(part)) { return NaN; }
    if (i > 0 && (part < 0 || part >= 60)) { return NaN; }
    total += i === 0 ? Math.abs(part) : part / (i === 1 ? 60 : 3600);
    if (i === 0 && part < 0) { sign = -sign; }
  }
  return sign * total;
}
