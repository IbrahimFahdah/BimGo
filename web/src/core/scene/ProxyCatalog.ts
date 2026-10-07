/** One proxy texture keyword (port of ProxyKeyword). */
export interface ProxyKeyword {
  keyword: string;
  label: string;
  aliases: string[];
  schemas: string[];
  /** Real-world metres one repeat covers. */
  sizeU: number;
  sizeV: number;
}

const k = (keyword: string, label: string, aliases: string[], schemas: string[], sizeU: number, sizeV: number): ProxyKeyword =>
  ({ keyword, label, aliases, schemas, sizeU, sizeV });

/** Materials that never get a proxy (they read wrong with any image). */
const NEVER = ['glass', 'glazing', 'mirror', 'acoustic', 'ceiling tile', 'light source', 'lamp', 'lens'];

/**
 * CC0 stand-in textures for materials whose image is missing, chosen by keyword (port of
 * BimGo.Core/Scene/ProxyCatalog.cs). Order matters: the first alias match wins.
 */
export const ProxyCatalog = {
  ALL: [
    k('carpet', 'Carpet', ['carpet', 'rug'], [], 2.0, 2.0),
    k('blockwork', 'Blockwork', ['block', 'blockwork', 'cmu', 'besser'], ['MasonryCMU'], 1.2, 1.8),
    k('brick', 'Brick', ['brick', 'masonry'], ['Masonry'], 0.9, 1.38),
    k('concrete-board', 'Concrete, board-formed', ['board formed', 'boardformed', 'board marked', 'off form timber'], [], 2.4, 2.4),
    k('concrete', 'Concrete', ['concrete', 'precast', 'screed', 'slab', 'off form'], ['Concrete'], 2.4, 1.2),
    k('render', 'Render / plaster', ['render', 'plaster', 'stucco', 'bagged'], [], 2.0, 2.0),
    k('plywood', 'Plywood', ['ply', 'plywood', 'osb', 'particleboard', 'mdf'], [], 1.2, 1.2),
    k('timber-floor', 'Timber floor', ['floorboard', 'timber floor', 'wood floor', 'hardwood floor', 'parquet'], ['Hardwood'], 1.2, 1.2),
    k('timber-panel', 'Timber panel', ['timber', 'wood', 'oak', 'walnut', 'maple', 'pine', 'cedar', 'birch', 'beech', 'teak', 'spotted gum', 'blackbutt', 'veneer', 'cladding'], [], 1.2, 1.2),
    k('vinyl', 'Vinyl', ['vinyl', 'lino', 'linoleum', 'rubber', 'marmoleum'], ['PlasticVinyl'], 1.0, 1.0),
    k('tile-600', 'Tile 600', ['tile 600', '600x600', '600 x 600', '600x1200', 'large format', 'porcelain'], [], 4.8, 4.8),
    k('tile-300', 'Tile 300', ['tile', 'tiles', 'ceramic', 'mosaic', 'terrazzo'], ['Ceramic'], 3.6, 3.6),
    k('marble-brushed', 'Marble, figured', ['figured marble', 'feature marble', 'onyx'], [], 1.5, 1.5),
    k('marble', 'Marble', ['marble', 'quartz', 'granite', 'caesarstone'], [], 1.5, 1.5),
    k('stone', 'Stone', ['stone', 'sandstone', 'limestone', 'bluestone', 'slate', 'travertine', 'basalt', 'rock'], ['Stone'], 2.0, 2.0),
    k('metal-galvanised', 'Metal, galvanised', ['galv', 'galvanised', 'galvanized', 'zinc', 'corrugated', 'colorbond', 'colourbond', 'zincalume', 'sheet metal'], [], 2.0, 2.0),
    k('metal-brushed', 'Metal, brushed', ['metal', 'steel', 'stainless', 'aluminium', 'aluminum', 'brushed', 'chrome', 'brass', 'copper'], ['Metal'], 1.0, 1.0),
    k('gravel', 'Gravel', ['gravel', 'pebble', 'aggregate', 'ballast', 'crushed rock'], [], 1.5, 1.5),
    k('grass', 'Grass', ['grass', 'turf', 'lawn'], [], 2.0, 2.0),
    k('asphalt', 'Asphalt', ['asphalt', 'bitumen', 'road', 'hotmix', 'tarmac'], [], 2.5, 2.5),
    k('fabric', 'Fabric', ['fabric', 'upholstery', 'textile', 'cloth', 'linen', 'felt', 'curtain'], [], 0.3, 0.3)
  ] as readonly ProxyKeyword[],

  find(keyword: string | null | undefined): ProxyKeyword | null {
    if (!keyword?.trim()) { return null; }
    const key = keyword.trim().toLowerCase();
    return ProxyCatalog.ALL.find(e => e.keyword === key) ?? null;
  },

  normalise(keyword: string | null | undefined): string | null {
    if (!keyword?.trim()) { return null; }
    const value = keyword.trim().toLowerCase();
    return value.length > 64 ? value.slice(0, 64) : value;
  },

  /** A keyword for a material: by name first (aliases, in list order), then by appearance schema; null when none suits. */
  suggest(materialName: string | null, schema: string | null): string | null {
    const name = ' ' + normaliseName(materialName) + ' ';
    if (name.trim().length > 0) {
      if (NEVER.some(never => name.includes(' ' + never))) { return null; }
      for (const entry of ProxyCatalog.ALL) {
        if (entry.aliases.some(alias => name.includes(' ' + alias))) { return entry.keyword; }
      }
    }

    if (schema?.trim()) {
      // Most specific schema fragment first (MasonryCMU before Masonry)
      const lower = schema.toLowerCase();
      let best: ProxyKeyword | null = null, bestLength = 0;
      for (const entry of ProxyCatalog.ALL) {
        for (const fragment of entry.schemas) {
          if (fragment.length > bestLength && lower.includes(fragment.toLowerCase())) {
            best = entry;
            bestLength = fragment.length;
          }
        }
      }
      return best?.keyword ?? null;
    }
    return null;
  }
};

/** Lower case words: camelCase split, punctuation to single spaces. */
export function normaliseName(name: string | null): string {
  if (!name?.trim()) { return ''; }
  let out = '';
  let previous = ' ';
  for (const c of name) {
    if (/[\p{L}\p{N}]/u.test(c)) {
      if (c !== c.toLowerCase() && previous !== previous.toUpperCase()) { out += ' '; }
      out += c.toLowerCase();
    } else if (out.length > 0 && out[out.length - 1] !== ' ') {
      out += ' ';
    }
    previous = c;
  }
  return out.trim();
}
