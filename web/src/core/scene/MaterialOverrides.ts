import type { SceneMaterial } from './MaterialData';

/**
 * QOL round: the water material override (port of MaterialOverrides). Water is a shader flag, so the session re-applies
 * it on a copy of the extracted materials. (Glass keywords act in Revit at Go / Export: transparency is baked into the
 * geometry, so the browser can't change it.)
 */
export const MaterialOverrides = {
  /** Grass round: water colour presets (label, #RRGGBB; empty = the material's own colour). */
  WATER_PRESETS: [['Revit', ''], ['Pool', '#3B9AA6'], ['Pond', '#3F4F33'], ['Dark', '#16222B']] as readonly (readonly [string, string])[],

  /** The preset index for a colour (case ignored), or −1 for a custom colour. */
  waterPresetIndex(hex: string | null | undefined): number {
    const value = (hex ?? '').trim().toLowerCase();
    return MaterialOverrides.WATER_PRESETS.findIndex(p => p[1].toLowerCase() === value);
  },

  MAX_KEYWORDS: 40,
  /** Ripple strength, reflection strength and blur of a material that becomes water by keyword. */
  KEYWORD_WATER_BUMP: 0.1,
  KEYWORD_WATER_SHINE: 0.6,
  KEYWORD_WATER_ROUGHNESS: 0.05,

  /** Trims, drops blanks and duplicates (case-insensitive) and caps the count. */
  cleanKeywords(keywords: Iterable<unknown> | null | undefined): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of keywords ?? []) {
      if (typeof k !== 'string' || !k.trim()) { continue; }
      const t = k.trim();
      if (seen.has(t.toLowerCase())) { continue; }
      seen.add(t.toLowerCase());
      out.push(t);
      if (out.length >= MaterialOverrides.MAX_KEYWORDS) { break; }
    }
    return out;
  },

  /** Splits a comma / semicolon separated list typed by the user. */
  parseKeywords: (text: string | null): string[] => MaterialOverrides.cleanKeywords((text ?? '').split(/[,;]/)),

  /** The list as the user types it ("water, pool"). */
  formatKeywords: (keywords: readonly string[] | null): string => (keywords ?? []).join(', '),

  /** True when the name contains any keyword (case-insensitive). */
  matches(name: string | null, keywords: readonly string[] | null): boolean {
    if (!name || !keywords) { return false; }
    const lower = name.toLowerCase();
    return keywords.some(k => k && lower.includes(k.toLowerCase()));
  },

  /** True when the appearance schema is Revit's Water asset. */
  isWaterAsset: (m: SceneMaterial | null): boolean => !!m && (m.schema ?? '').toLowerCase().includes('water'),

  /** True when the material was see-through at extraction (older files: glass reflectivity or a non-asset water material). */
  isSeeThrough: (m: SceneMaterial | null): boolean => !!m && (m.seeThrough || m.reflectivity > 0 || (m.water && !MaterialOverrides.isWaterAsset(m))),

  isWater(m: SceneMaterial | null, fromAsset: boolean, keywords: readonly string[], keywordsOpaque: boolean): boolean {
    if (!m) { return false; }
    if (fromAsset && MaterialOverrides.isWaterAsset(m)) { return true; }
    return MaterialOverrides.matches(m.name, keywords) && (keywordsOpaque || MaterialOverrides.isSeeThrough(m));
  },

  /** How one material draws under these settings: water or not, and the reflection values that go with it. */
  look(source: SceneMaterial | null, fromAsset: boolean, keywords: readonly string[], keywordsOpaque: boolean):
    { water: boolean; shine: number; roughness: number | null; bump: number } {
    if (!source) { return { water: false, shine: 0, roughness: null, bump: 0 }; }
    const on = MaterialOverrides.isWater(source, fromAsset, keywords, keywordsOpaque);
    if (on && !source.water) {
      return { water: true, shine: Math.max(source.shine, MaterialOverrides.KEYWORD_WATER_SHINE), roughness: MaterialOverrides.KEYWORD_WATER_ROUGHNESS, bump: MaterialOverrides.KEYWORD_WATER_BUMP };
    }
    return { water: on, shine: source.shine, roughness: source.roughness, bump: on ? source.waterBump : 0 };
  },

  /** Re-applies the water rule to target from the extracted original (same order). Returns the number of water materials. */
  applyWater(original: readonly SceneMaterial[], target: SceneMaterial[], fromAsset: boolean, keywords: readonly string[], keywordsOpaque: boolean): number {
    const count = Math.min(original.length, target.length);
    let water = 0;
    for (let i = 0; i < count; i++) {
      const source = original[i], m = target[i];
      if (!source || !m) { continue; }
      const l = MaterialOverrides.look(source, fromAsset, keywords, keywordsOpaque);
      m.water = l.water;
      m.shine = l.shine;
      m.roughness = l.roughness;
      m.waterBump = l.bump;
      if (m.water) { water++; }
    }
    return water;
  }
};
