/**
 * The Revit categories BimGo extracts, in a fixed order (port of CategoryCatalog.cs). Files store category keys; the
 * reader maps them onto this build's indices, so the order may change between versions.
 */

export enum CategoryGroup {
  System = 0,
  Ffe = 1,
  Services = 2
}

export interface CategoryDef {
  index: number;
  key: string;
  label: string;
  group: CategoryGroup;
  builtInCategoryNames: string[];
  heavy: boolean;
}

export const KEY_DOORS = 'doors';
export const KEY_STAIRS = 'stairs';
export const KEY_GENERIC = 'generic';
export const KEY_OTHER = 'other';

export const GROUP_NAMES = ['System', 'FFE', 'Services'];

export const CATEGORIES: readonly CategoryDef[] = build();

export function findCategory(key: string | null | undefined): CategoryDef | null {
  if (!key) { return null; }
  return CATEGORIES.find(d => d.key === key) ?? null;
}

/** Categories on by default in the extractor (all but services and heavy ones). */
export function defaultEnabledKeys(): string[] {
  return CATEGORIES.filter(d => d.group !== CategoryGroup.Services && !d.heavy).map(d => d.key);
}

/** True when the extractor's triangle threshold applies (everything but system categories). */
export function thresholdApplies(def: CategoryDef): boolean {
  return def.group !== CategoryGroup.System;
}

function build(): CategoryDef[] {
  const list: CategoryDef[] = [];
  const add = (group: CategoryGroup, key: string, label: string, heavy: boolean, ...bics: string[]) =>
    list.push({ index: list.length, key, label, group, heavy, builtInCategoryNames: bics });
  const S = CategoryGroup.System, F = CategoryGroup.Ffe, M = CategoryGroup.Services;

  // System (collidable, no threshold)
  add(S, 'walls', 'Walls', false, 'OST_Walls');
  add(S, 'floors', 'Floors + slab edges', false, 'OST_Floors', 'OST_EdgeSlab');
  add(S, 'ceilings', 'Ceilings', false, 'OST_Ceilings');
  add(S, 'roofs', 'Roofs + gutters, fascias', false, 'OST_Roofs', 'OST_Gutter', 'OST_Fascia', 'OST_RoofSoffit');
  add(S, 'curtainpanels', 'Curtain panels', false, 'OST_CurtainWallPanels');
  add(S, 'mullions', 'Curtain wall mullions', false, 'OST_CurtainWallMullions');
  add(S, KEY_DOORS, 'Doors', false, 'OST_Doors');
  add(S, 'windows', 'Windows', false, 'OST_Windows');
  add(S, KEY_STAIRS, 'Stairs + runs, landings', false, 'OST_Stairs', 'OST_StairsRuns', 'OST_StairsLandings', 'OST_StairsStringerCarriage');
  add(S, 'ramps', 'Ramps', false, 'OST_Ramps');
  add(S, 'columns', 'Columns', false, 'OST_Columns');
  add(S, 'structcolumns', 'Structural columns', false, 'OST_StructuralColumns');
  add(S, 'framing', 'Structural framing', false, 'OST_StructuralFraming');
  add(S, 'foundations', 'Structural foundations', false, 'OST_StructuralFoundation');
  add(S, 'topo', 'Toposolid / topography', false, 'OST_Toposolid', 'OST_Topography');

  // FFE (collidable, threshold applies)
  add(F, 'casework', 'Casework', false, 'OST_Casework');
  add(F, 'furniture', 'Furniture', false, 'OST_Furniture');
  add(F, 'furnsys', 'Furniture systems', false, 'OST_FurnitureSystems');
  add(F, KEY_GENERIC, 'Generic models', false, 'OST_GenericModel');
  add(F, 'parking', 'Parking', false, 'OST_Parking');
  add(F, 'specialty', 'Specialty equipment', false, 'OST_SpecialityEquipment');
  add(F, 'plumbing', 'Plumbing fixtures', false, 'OST_PlumbingFixtures');
  add(F, 'railings', 'Railings', false, 'OST_StairsRailing', 'OST_RailingTopRail', 'OST_RailingHandRail', 'OST_RailingSupport', 'OST_RailingTermination');
  add(F, 'foodservice', 'Food service equipment', false, 'OST_FoodServiceEquipment');
  add(F, 'planting', 'Planting', false, 'OST_Planting');
  add(F, 'entourage', 'Entourage', false, 'OST_Entourage');
  add(F, 'signage', 'Signage', false, 'OST_Signage');

  // Services (collidable, threshold applies)
  add(M, 'elecfixtures', 'Electrical fixtures', false, 'OST_ElectricalFixtures');
  add(M, 'elecequipment', 'Electrical equipment', false, 'OST_ElectricalEquipment');
  add(M, 'mechequipment', 'Mechanical equipment', false, 'OST_MechanicalEquipment');
  add(M, 'lightfixtures', 'Lighting fixtures', false, 'OST_LightingFixtures');
  add(M, 'lightdevices', 'Lighting devices', false, 'OST_LightingDevices');
  add(M, 'security', 'Security devices', false, 'OST_SecurityDevices');
  add(M, 'firealarm', 'Fire alarm devices', false, 'OST_FireAlarmDevices');
  add(M, 'comms', 'Communication devices', false, 'OST_CommunicationDevices');
  add(M, 'data', 'Data devices', false, 'OST_DataDevices');
  add(M, 'nursecall', 'Nurse call devices', false, 'OST_NurseCallDevices');
  add(M, 'sprinklers', 'Sprinklers', false, 'OST_Sprinklers');
  add(M, 'airterminals', 'Air terminals', false, 'OST_DuctTerminal');

  // Services, heavy (optional, off by default)
  add(M, 'ducts', 'Ducts + fittings', true, 'OST_DuctCurves', 'OST_DuctFitting', 'OST_FlexDuctCurves');
  add(M, 'pipes', 'Pipes + fittings', true, 'OST_PipeCurves', 'OST_PipeFitting', 'OST_FlexPipeCurves');
  add(M, 'cabletrays', 'Cable trays + fittings', true, 'OST_CableTray', 'OST_CableTrayFitting');
  add(M, 'conduits', 'Conduits + fittings', true, 'OST_Conduit', 'OST_ConduitFitting');

  // Anything else a view shows (active-view-only extraction): masses, site, parts, accessories…
  add(F, KEY_OTHER, 'Other (active view)', false);

  return list;
}
