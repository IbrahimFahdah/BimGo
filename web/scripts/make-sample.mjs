// Builds public/samples/BimGo Sample Pavilion.bimgo: a small two-storey pavilion made from boxes, so visitors without
// a Revit export can try every tool. It also carries Realistic materials (polished concrete, metals, glass, a mirror and
// a pool, so reflections and probes show), comments as issues and a small family library for the Place gun. Everything here is generated (no Revit or third-party content), so it can ship
// with the site. Run: node scripts/make-sample.mjs
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../public/samples/BimGo Sample Pavilion.bimgo');

// ---- Categories (catalog keys; the file's own order)
const CATEGORY_KEYS = ['walls', 'floors', 'roofs', 'doors', 'windows', 'stairs', 'railings', 'columns', 'furniture', 'planting', 'lightfixtures', 'casework'];
const cat = key => CATEGORY_KEYS.indexOf(key);

// ---- Colours (RGBA bytes)
const C = {
  wall: [226, 222, 214], slab: [190, 188, 182], roof: [120, 124, 130], timber: [150, 104, 62], frame: [70, 74, 80],
  glass: [150, 200, 225, 90], stair: [205, 200, 192], rail: [60, 64, 70], column: [210, 210, 206], sofa: [70, 96, 140],
  table: [176, 132, 88], chair: [200, 80, 60], desk: [235, 235, 230], plant: [70, 140, 70], pot: [170, 110, 80],
  light: [255, 244, 220], counter: [90, 90, 96], shelf: [180, 150, 110],
  water: [70, 130, 160], coping: [214, 208, 196], mirror: [220, 224, 228], lounge: [120, 140, 110]
};

// ---- Realistic materials (materials.json), picked per box by its colour; anything else is matt paint
const MATERIALS = [
  { name: 'Paint - Matt', schema: 'GenericSchema', colour: [0.86, 0.85, 0.82], roughness: 1 },
  { name: 'Concrete - Polished', schema: 'ConcreteSchema', colour: [0.74, 0.73, 0.71], shine: 0.6, roughness: 0.15 },
  { name: 'Aluminium - Brushed', schema: 'MetalSchema', colour: [0.42, 0.44, 0.47], shine: 0.55, roughness: 0.35, metallic: true },
  { name: 'Steel - Polished', schema: 'MetalSchema', colour: [0.6, 0.62, 0.65], shine: 0.85, roughness: 0.05, metallic: true },
  { name: 'Glass - Clear', schema: 'GlazingSchema', colour: [0.59, 0.78, 0.88], reflectivity: 0.15 },
  { name: 'Stone - Gloss Black', schema: 'PrismOpaqueSchema', colour: [0.35, 0.35, 0.38], shine: 0.55, roughness: 0.1 },
  { name: 'Timber - Satin', schema: 'WoodSchema', colour: [0.69, 0.52, 0.35], shine: 0.3, roughness: 0.4 },
  { name: 'Laminate - Gloss White', schema: 'PlasticVinylSchema', colour: [0.92, 0.92, 0.9], shine: 0.35, roughness: 0.25 },
  { name: 'Water - Pool', schema: 'WaterSchema', colour: [0.27, 0.51, 0.63], shine: 0.6, roughness: 0.05, water: true, waterBump: 0.1 },
  { name: 'Mirror', schema: 'MirrorSchema', colour: [0.86, 0.88, 0.89], shine: 0.9, roughness: 0, metallic: true },
  { name: 'Stone - Honed', schema: 'StoneSchema', colour: [0.8, 0.78, 0.75], shine: 0.3, roughness: 0.35 }
];
const MATERIAL_OF = new Map([
  [C.slab, 1], [C.frame, 2], [C.rail, 3], [C.glass, 4], [C.counter, 5], [C.table, 6], [C.shelf, 6], [C.desk, 7],
  [C.water, 8], [C.mirror, 9], [C.stair, 10], [C.coping, 10]
]);

// ---- Geometry: per element, opaque and transparent triangles
const vertices = []; // [x, y, z, nx, ny, nz, r, g, b, a]
const vertexMaterial = []; // material index per vertex
const elements = [];
const emissive = [];
const lights = [];

function box(target, min, max, colour) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const faces = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [[-1, 0, 0], [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]],
    [[0, 1, 0], [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]],
    [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    [[0, 0, -1], [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]]]
  ];
  const first = vertices.length;
  for (const [n, quad] of faces) {
    const base = vertices.length;
    for (const p of quad) {
      vertices.push([...p, ...n, colour[0], colour[1], colour[2], colour[3] ?? 255]);
      vertexMaterial.push(MATERIAL_OF.get(colour) ?? 0);
    }
    target.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return [first, vertices.length - first];
}

let nextId = 400000;
function element(o) {
  const record = {
    id: o.id ?? nextId++, name: o.name, category: cat(o.category), familyType: o.familyType ?? o.name,
    level: o.level ?? 'Level 1', hostId: o.hostId ?? 0, movable: !!o.movable, phase: o.phase,
    opaqueIdx: [], transparentIdx: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
    moveBlockReason: o.movable ? undefined : o.reason ?? (o.hostId ? 'Hosted by a wall' : 'System family'),
    params: o.params ?? {}
  };
  record.uniqueId = o.library ? '' : `bimgo-sample-${record.id}`;
  record.library = !!o.library;
  for (const [min, max, colour] of o.boxes) {
    const transparent = (colour[3] ?? 255) < 255;
    const run = box(transparent ? record.transparentIdx : record.opaqueIdx, min, max, colour);
    if (o.glow) { emissive.push([run[0], run[1], o.glow]); }
    for (let k = 0; k < 3; k++) { record.min[k] = Math.min(record.min[k], min[k]); record.max[k] = Math.max(record.max[k], max[k]); }
  }
  record.pivot = [(record.min[0] + record.max[0]) / 2, (record.min[1] + record.max[1]) / 2, record.min[2]];
  elements.push(record);
  return record;
}

// Pavilion: 14 m (x) by 9 m (y); level 1 at 0, level 2 at 3.5, roof at 7.0. Walls 0.25 thick.
const W = 14, D = 9, T = 0.25, L2 = 3.5, ROOF = 7.0, SLAB = 0.3;

// Floors
element({ name: 'Ground slab', category: 'floors', familyType: 'Floor: Concrete 300', boxes: [[[0, 0, -SLAB], [W, D, 0], C.slab]], params: { 'Fire Rating': '—', Comments: 'Polished concrete' } });
// Level 2 slab, with the stair opening (x 10–12.5, y 2.4–8.75)
element({ name: 'Level 2 slab', category: 'floors', familyType: 'Floor: Concrete 300', level: 'Level 2', boxes: [
  [[0, 0, L2 - SLAB], [10, D, L2], C.slab], [[12.5, 0, L2 - SLAB], [W, D, L2], C.slab], [[10, 0, L2 - SLAB], [12.5, 2.4, L2], C.slab]
] });
element({ name: 'Roof', category: 'roofs', familyType: 'Basic Roof: Metal deck', level: 'Roof', boxes: [
  [[-0.4, -0.4, ROOF], [W + 0.4, D + 0.4, ROOF + 0.3], C.roof]
] });

// South wall, level 1: door at x 6.25–7.75, windows at x 1.5–5 and 9–12.5 (sill 0.9, head 2.6)
const south = element({ name: 'South wall L1', category: 'walls', familyType: 'Basic Wall: Render 250', boxes: [
  [[0, 0, 0], [1.5, T, L2 - SLAB], C.wall], [[5, 0, 0], [6.25, T, L2 - SLAB], C.wall], [[7.75, 0, 0], [9, T, L2 - SLAB], C.wall],
  [[12.5, 0, 0], [W, T, L2 - SLAB], C.wall],
  [[1.5, 0, 0], [5, T, 0.9], C.wall], [[1.5, 0, 2.6], [5, T, L2 - SLAB], C.wall],
  [[9, 0, 0], [12.5, T, 0.9], C.wall], [[9, 0, 2.6], [12.5, T, L2 - SLAB], C.wall],
  [[6.25, 0, 2.3], [7.75, T, L2 - SLAB], C.wall]
], params: { 'Fire Rating': '60 min', Comments: 'Existing facade' } });
element({ name: 'Entrance door', category: 'doors', familyType: 'Double Glazed Door: 1500 x 2300', hostId: south.id, boxes: [
  [[6.25, 0.08, 0], [6.3, 0.17, 2.3], C.frame], [[7.7, 0.08, 0], [7.75, 0.17, 2.3], C.frame], [[6.25, 0.08, 2.25], [7.75, 0.17, 2.3], C.frame],
  [[6.3, 0.11, 0], [7.7, 0.14, 2.25], C.glass]
] });
for (const [x0, x1, n] of [[1.5, 5, 1], [9, 12.5, 2]]) {
  element({ name: `Window S${n}`, category: 'windows', familyType: 'Fixed: 3500 x 1700', hostId: south.id, boxes: [
    [[x0, 0.08, 0.9], [x1, 0.17, 0.96], C.frame], [[x0, 0.08, 2.54], [x1, 0.17, 2.6], C.frame],
    [[x0, 0.11, 0.96], [x1, 0.14, 2.54], C.glass]
  ] });
}

// North, east and west walls, level 1 (north has a long window)
const north = element({ name: 'North wall L1', category: 'walls', familyType: 'Basic Wall: Render 250', boxes: [
  [[0, D - T, 0], [2, D, L2 - SLAB], C.wall], [[8, D - T, 0], [W, D, L2 - SLAB], C.wall],
  [[2, D - T, 0], [8, D, 0.6], C.wall], [[2, D - T, 2.6], [8, D, L2 - SLAB], C.wall]
] });
element({ name: 'Window N1', category: 'windows', familyType: 'Fixed: 6000 x 2000', hostId: north.id, boxes: [
  [[2, D - 0.17, 0.6], [8, D - 0.08, 0.66], C.frame], [[2, D - 0.17, 0.66], [8, D - 0.14, 2.6], C.glass]
] });
element({ name: 'West wall L1', category: 'walls', familyType: 'Basic Wall: Render 250', boxes: [[[0, T, 0], [T, D - T, L2 - SLAB], C.wall]] });
element({ name: 'East wall L1', category: 'walls', familyType: 'Basic Wall: Render 250', boxes: [[[W - T, T, 0], [W, D - T, L2 - SLAB], C.wall]] });
// Interior wall between lobby and lounge, with an opening (y 3–4.5)
element({ name: 'Partition L1', category: 'walls', familyType: 'Basic Wall: Stud 120', boxes: [
  [[8.4, T, 0], [8.52, 3, L2 - SLAB], C.wall], [[8.4, 4.5, 0], [8.52, D - T, L2 - SLAB], C.wall], [[8.4, 3, 2.4], [8.52, 4.5, L2 - SLAB], C.wall]
] });

// Level 2: glazed south facade (curtain wall), solid walls elsewhere
element({ name: 'South glazing L2', category: 'windows', familyType: 'Curtain Wall: Storefront', level: 'Level 2', reason: 'System family', boxes: [
  ...[0, 3.5, 7, 10.5, 14].map(x => [[x - 0.04, 0.05, L2], [x + 0.04, 0.2, ROOF], C.frame]),
  [[0, 0.05, L2], [W, 0.2, L2 + 0.08], C.frame], [[0, 0.05, ROOF - 0.08], [W, 0.2, ROOF], C.frame],
  [[0, 0.11, L2 + 0.08], [W, 0.14, ROOF - 0.08], C.glass]
] });
element({ name: 'North wall L2', category: 'walls', familyType: 'Basic Wall: Render 250', level: 'Level 2', boxes: [[[0, D - T, L2], [W, D, ROOF], C.wall]] });
element({ name: 'West wall L2', category: 'walls', familyType: 'Basic Wall: Render 250', level: 'Level 2', boxes: [[[0, T, L2], [T, D - T, ROOF], C.wall]] });
element({ name: 'East wall L2', category: 'walls', familyType: 'Basic Wall: Render 250', level: 'Level 2', boxes: [[[W - T, T, L2], [W, D - T, ROOF], C.wall]] });

// Stair: 20 risers of 175 mm, 280 mm goings, rising north along x 10.2–12.3
const steps = [];
for (let i = 0; i < 20; i++) { steps.push([[10.2, 2.6 + i * 0.28, 0], [12.3, 2.6 + (i + 1) * 0.28, (i + 1) * 0.175], C.stair]); }
element({ name: 'Stair', category: 'stairs', familyType: 'Assembled Stair: 175 / 280', boxes: steps, reason: 'System family' });
element({ name: 'Stair balustrade', category: 'railings', familyType: 'Railing: 1100 Steel', level: 'Level 2', reason: 'System family', boxes: [
  [[9.95, 2.4, L2], [10.0, 8.75, L2 + 1.1], C.rail], [[10, 2.35, L2], [12.5, 2.4, L2 + 1.1], C.rail]
] });

// Columns (level 1, in the lounge)
for (const [x, y] of [[4.2, 4.5], [11.2, 1.4]]) {
  element({ name: 'Column', category: 'columns', familyType: 'Round Column: 350', reason: 'Structural', boxes: [[[x - 0.17, y - 0.17, 0], [x + 0.17, y + 0.17, L2 - SLAB], C.column]] });
}

// Furniture and fittings (movable; new work in this phase)
const NEW = 'new';
function furniture(name, familyType, category, boxes, level = 'Level 1') {
  return element({ name, familyType, category, boxes, level, movable: true, phase: NEW, params: { Mark: `F${elements.length}`, Manufacturer: 'BimGo Sample Co.' } });
}
const z1 = 0, z2 = L2;
furniture('Sofa', 'Sofa: 3 Seat', 'furniture', [[[1, 6.6, z1], [3.4, 7.5, z1 + 0.42], C.sofa], [[1, 7.3, z1], [3.4, 7.5, z1 + 0.85], C.sofa]]);
furniture('Coffee table', 'Table: Low 1200', 'furniture', [[[1.6, 5.3, z1 + 0.35], [2.8, 6, z1 + 0.4], C.table], [[1.65, 5.35, z1], [1.7, 5.4, z1 + 0.35], C.table], [[2.7, 5.9, z1], [2.75, 5.95, z1 + 0.35], C.table]]);
for (const [x, y] of [[10, 5.5], [12.6, 5.5]]) {
  furniture('Cafe table', 'Table: Round 800', 'furniture', [[[x - 0.4, y - 0.4, z1 + 0.72], [x + 0.4, y + 0.4, z1 + 0.76], C.table], [[x - 0.04, y - 0.04, z1], [x + 0.04, y + 0.04, z1 + 0.72], C.frame]]);
  for (const dx of [-0.75, 0.75]) {
    furniture('Chair', 'Chair: Stacking', 'furniture', [[[x + dx - 0.22, y - 0.22, z1 + 0.42], [x + dx + 0.22, y + 0.22, z1 + 0.46], C.chair], [[x + dx - 0.22 + (dx > 0 ? 0.4 : 0), y - 0.22, z1 + 0.46], [x + dx - 0.18 + (dx > 0 ? 0.4 : 0), y + 0.22, z1 + 0.9], C.chair], [[x + dx - 0.03, y - 0.03, z1], [x + dx + 0.03, y + 0.03, z1 + 0.42], C.frame]]);
  }
}
furniture('Reception counter', 'Casework: Counter 2400', 'casework', [[[4.8, 1.6, z1], [7.2, 2.2, z1 + 1.05], C.counter]]);
for (const [x, y, lvl] of [[0.7, 0.8, 1], [13.2, 8.2, 1], [0.8, 8.2, 2]]) {
  const z = lvl === 1 ? z1 : z2;
  furniture('Planter', 'Planting: Fiddle leaf fig', 'planting', [[[x - 0.25, y - 0.25, z], [x + 0.25, y + 0.25, z + 0.45], C.pot], [[x - 0.35, y - 0.35, z + 0.45], [x + 0.35, y + 0.35, z + 1.6], C.plant]], lvl === 1 ? 'Level 1' : 'Level 2');
}
for (let i = 0; i < 3; i++) {
  const x = 1.5 + i * 2.8;
  furniture('Desk', 'Desk: 1600 x 800', 'furniture', [[[x, 5, z2 + 0.72], [x + 1.6, 5.8, z2 + 0.75], C.desk], [[x, 5, z2], [x + 0.05, 5.8, z2 + 0.72], C.frame], [[x + 1.55, 5, z2], [x + 1.6, 5.8, z2 + 0.72], C.frame]], 'Level 2');
  furniture('Chair', 'Chair: Task', 'furniture', [[[x + 0.55, 4.2, z2 + 0.45], [x + 1.05, 4.7, z2 + 0.5], C.chair], [[x + 0.55, 4.0, z2 + 0.5], [x + 1.05, 4.05, z2 + 1.0], C.chair], [[x + 0.77, 4.42, z2], [x + 0.83, 4.48, z2 + 0.45], C.frame]], 'Level 2');
}
furniture('Bookshelf', 'Shelving: 1800', 'furniture', [[[0.3, 2, z2], [0.7, 4, z2 + 1.8], C.shelf]], 'Level 2');

// Ceiling lights (glowing, with a light each)
const GLOW = (255 | 244 << 8 | 220 << 16 | 64 << 24) >>> 0; // warm white, strength 1
for (const [x, y, lvl] of [[2.5, 3, 1], [5.5, 6, 1], [10.5, 3.5, 1], [12.5, 7, 1], [3, 3, 2], [7, 6.5, 2], [11, 1.2, 2]]) {
  const top = lvl === 1 ? L2 - SLAB : ROOF;
  const record = element({ name: 'Pendant light', category: 'lightfixtures', familyType: 'Pendant: LED 600', level: `Level ${lvl}`, movable: true, glow: GLOW,
    boxes: [[[x - 0.3, y - 0.3, top - 0.08], [x + 0.3, y + 0.3, top - 0.02], C.light]] });
  lights.push({ element: elements.indexOf(record), position: [x, y, top - 0.1], lumens: 2500, kelvin: 3000, downward: 0.85, estimated: false });
}

// A mirror on the studio's west wall (level 2) and a pool in front of the building (outside every room)
element({ name: 'Mirror', category: 'casework', familyType: 'Mirror: 1200 x 1800', level: 'Level 2', reason: 'Wall mounted',
  boxes: [[[T, 5.4, L2 + 0.6], [T + 0.02, 6.6, L2 + 2.4], C.mirror]] });
element({ name: 'Pool', category: 'floors', familyType: 'Floor: Pool', params: { Comments: 'Reflecting pool' }, boxes: [
  [[3, -8, -0.3], [11, -4, -0.06], C.water],
  [[2.6, -8.4, -0.3], [11.4, -8, 0.05], C.coping], [[2.6, -4, -0.3], [11.4, -3.6, 0.05], C.coping],
  [[2.6, -8, -0.3], [3, -4, 0.05], C.coping], [[11, -8, -0.3], [11.4, -4, 0.05], C.coping]
] });

// ---- Family library: hidden templates (2 km down, after every model element) for the Place gun
const LIB_Z = -2000;
const templateVertexStart = vertices.length;
const libraryEntries = [];
function template(entry, boxes) {
  const record = element({ id: 0, name: entry.family, category: entry.category, familyType: `${entry.family}: ${entry.type}`, movable: true,
    phase: 'new', library: true, boxes: boxes.map(([min, max, colour]) => [[min[0], min[1], LIB_Z + min[2]], [max[0], max[1], LIB_Z + max[2]], colour]) });
  libraryEntries.push({ ...entry, placement: 'levelBased', placeable: true, element: elements.indexOf(record), preview: `library/${libraryEntries.length}.png`, boxes });
}
template({ typeId: 900001, typeUniqueId: 'bimgo-sample-type-desk', family: 'Desk', type: '1600 x 800', category: 'furniture', placed: 3 }, [
  [[0, 0, 0.72], [1.6, 0.8, 0.75], C.desk], [[0, 0, 0], [0.05, 0.8, 0.72], C.frame], [[1.55, 0, 0], [1.6, 0.8, 0.72], C.frame]
]);
template({ typeId: 900002, typeUniqueId: 'bimgo-sample-type-chair', family: 'Chair', type: 'Task', category: 'furniture', placed: 3 }, [
  [[0, 0, 0.45], [0.5, 0.5, 0.5], C.chair], [[0, 0, 0.5], [0.5, 0.05, 1.0], C.chair], [[0.22, 0.22, 0], [0.28, 0.28, 0.45], C.frame]
]);
template({ typeId: 900003, typeUniqueId: 'bimgo-sample-type-lounge', family: 'Lounge chair', type: 'Single', category: 'furniture', placed: 0 }, [
  [[0, 0, 0], [0.8, 0.8, 0.42], C.lounge], [[0, 0.65, 0], [0.8, 0.8, 0.85], C.lounge], [[0, 0, 0], [0.12, 0.8, 0.6], C.lounge], [[0.68, 0, 0], [0.8, 0.8, 0.6], C.lounge]
]);
template({ typeId: 900004, typeUniqueId: 'bimgo-sample-type-table', family: 'Cafe table', type: 'Round 800', category: 'furniture', placed: 2 }, [
  [[0, 0, 0.72], [0.8, 0.8, 0.76], C.table], [[0.36, 0.36, 0], [0.44, 0.44, 0.72], C.frame], [[0.2, 0.2, 0], [0.6, 0.6, 0.02], C.frame]
]);
template({ typeId: 900005, typeUniqueId: 'bimgo-sample-type-shelf', family: 'Bookshelf', type: '1800', category: 'furniture', placed: 1 }, [
  [[0, 0, 0], [1.2, 0.4, 0.04], C.shelf], [[0, 0, 0.6], [1.2, 0.4, 0.64], C.shelf], [[0, 0, 1.2], [1.2, 0.4, 1.24], C.shelf], [[0, 0, 1.76], [1.2, 0.4, 1.8], C.shelf],
  [[0, 0, 0], [0.04, 0.4, 1.8], C.shelf], [[1.16, 0, 0], [1.2, 0.4, 1.8], C.shelf]
]);
template({ typeId: 900006, typeUniqueId: 'bimgo-sample-type-planter', family: 'Planter', type: 'Fiddle leaf fig', category: 'planting', placed: 3 }, [
  [[0.1, 0.1, 0], [0.6, 0.6, 0.45], C.pot], [[0, 0, 0.45], [0.7, 0.7, 1.6], C.plant]
]);
// Listed, not placeable (as Revit sends ceiling- and wall-hosted types)
libraryEntries.push({ typeId: 900007, typeUniqueId: 'bimgo-sample-type-pendant', family: 'Pendant light', type: 'LED 600', category: 'lightfixtures',
  placement: 'hosted', placeable: false, reason: 'Ceiling-hosted: not placeable yet', element: -1, placed: 7, preview: `library/${libraryEntries.length}.png`,
  boxes: [[[0, 0, 0.9], [0.6, 0.6, 0.96], C.light], [[0.29, 0.29, 0.96], [0.31, 0.31, 1.6], C.frame]] });

// ---- Index buffer: each element's opaque run, then its transparent run
const indices = [];
for (const e of elements) {
  e.opaque = [indices.length, e.opaqueIdx.length]; indices.push(...e.opaqueIdx);
  e.transparent = [indices.length, e.transparentIdx.length]; indices.push(...e.transparentIdx);
}

const geometry = new Uint8Array(24 + vertices.length * 28 + indices.length * 4);
const gv = new DataView(geometry.buffer);
gv.setUint32(0, 0x4f454742, true); // "BGEO"
gv.setInt32(4, 1, true);
gv.setInt32(8, 28, true);
gv.setInt32(12, vertices.length, true);
gv.setInt32(16, indices.length, true);
vertices.forEach((v, i) => {
  const o = 24 + i * 28;
  for (let k = 0; k < 6; k++) { gv.setFloat32(o + k * 4, v[k], true); }
  geometry.set([v[6], v[7], v[8], v[9]], o + 24);
});
indices.forEach((n, i) => gv.setUint32(24 + vertices.length * 28 + i * 4, n, true));

// ---- JSON entries
const created = '2026-10-07T00:00:00Z';
const r3 = v => v.map(x => Math.round(x * 1000) / 1000);
const manifest = {
  format: 'bimgo', formatVersion: 1, generator: 'BimGo Web sample generator', generatorVersion: '1.0', kind: 'revit-export',
  title: 'BimGo Sample Pavilion', createdUtc: created, units: 'metres',
  provenance: { modelTitle: 'BimGo Sample Pavilion', revitVersion: '', extractedBy: 'scripts/make-sample.mjs', extractedUtc: created },
  counts: { elements: elements.length, triangles: indices.length / 3, rooms: 3, comments: 3, bookmarks: 3 }
};
const model = {
  originOffset: [0, 0, 0], boundsMin: [-0.4, -8.8, -SLAB], boundsMax: [W + 0.4, D + 0.4, ROOF + 0.3],
  phaseId: 2, phaseName: 'New Construction', existingPhaseId: 1, existingPhaseName: 'Existing',
  site: { hasLocation: true, latitude: -27.4698, longitude: 153.0251, timeZone: 10, placeName: 'Brisbane', sunStart: '2026-06-21T14:30', trueNorthAngle: 0 },
  spawn: { eye: [7, -13, 1.62], yaw: Math.PI / 2, pitch: 0.06, source: 'sample' },
  levels: [{ name: 'Level 1', elevation: 0 }, { name: 'Level 2', elevation: L2 }, { name: 'Roof', elevation: ROOF }],
  rooms: [
    { number: '01', name: 'Lobby', bottomZ: 0, topZ: L2 - SLAB, loops: [[T, T, 8.4, T, 8.4, D - T, T, D - T]] },
    { number: '02', name: 'Cafe', bottomZ: 0, topZ: L2 - SLAB, loops: [[8.52, T, W - T, T, W - T, D - T, 8.52, D - T]] },
    { number: '11', name: 'Studio', bottomZ: L2, topZ: ROOF, loops: [[T, T, W - T, T, W - T, D - T, T, D - T]] }
  ],
  categories: CATEGORY_KEYS.map(key => ({ key, loaded: true }))
};
const elementsJson = {
  elements: elements.map(e => ({
    id: e.id, uniqueId: e.uniqueId, name: e.name, category: e.category, familyType: e.familyType, level: e.level,
    ...(e.hostId ? { hostId: e.hostId } : {}), movable: e.movable, ...(e.moveBlockReason ? { moveBlockReason: e.moveBlockReason } : {}),
    ...(e.phase ? { phase: e.phase } : {}), pivot: r3(e.pivot), boundsMin: r3(e.min), boundsMax: r3(e.max),
    opaque: e.opaque, transparent: e.transparent, ...(e.library ? { library: true } : {})
  }))
};

// Parameters: pooled names / values, rows of name / value index pairs
const names = [], values = [];
const pool = (list, s) => { let i = list.indexOf(s); if (i < 0) { i = list.length; list.push(s); } return i; };
const parameters = {
  names, values,
  rows: elements.map(e => Object.entries({ ...e.params, 'Model': 'BimGo Sample Pavilion' }).flatMap(([n, v]) => [pool(names, n), pool(values, v)]))
};

const comments = {
  model: 'BimGo Sample Pavilion', units: 'metres, Revit internal coordinates',
  comments: [
    { id: 'sample-c1', author: 'BimGo', created, text: 'Welcome! Esc opens the menu, F1 shows the keys. Try the tools 1–9 at the bottom.', x: 7, y: 1.2, z: 1.6, elementId: 0, level: 'Level 1',
      view: { x: 7, y: -3, z: 0, yaw: Math.PI / 2, pitch: 0.05, flying: false } },
    { id: 'sample-c2', author: 'BimGo', created, text: 'Tool 7 (Gizmo) moves furniture: click a chair, WASD to move, right-click to commit.', x: 10, y: 5.5, z: 1.2, elementId: 0, level: 'Level 1',
      status: 'inProgress', priority: 'high', assignedTo: 'Sam', updated: created, updatedBy: 'BimGo',
      replies: [{ id: 'sample-r1', author: 'Sam', created, text: 'F drops a moved chair onto the floor or a table below it.' }] },
    { id: 'sample-c3', author: 'BimGo', created, text: 'Realistic colour mode (Esc → Display) shows the polished floor, the mirror upstairs and the pool reflecting.', x: 7, y: -3.4, z: 0.8, elementId: 0, level: 'Level 1',
      status: 'closed' }
  ]
};
const bookmarks = {
  version: 1, model: 'BimGo Sample Pavilion',
  bookmarks: [
    { id: 'sample-b1', name: 'Street view', author: 'BimGo', created, x: 7, y: -13, z: 0, yaw: Math.PI / 2, pitch: 0.06, flying: false, level: 'Level 1' },
    { id: 'sample-b2', name: 'Cafe', author: 'BimGo', created, x: 9.2, y: 2.2, z: 0, yaw: 0.9, pitch: -0.1, flying: false, level: 'Level 1' },
    { id: 'sample-b3', name: 'Studio', author: 'BimGo', created, x: 12.8, y: 1.2, z: L2, yaw: 2.6, pitch: -0.1, flying: false, level: 'Level 2' }
  ]
};
const sun = { version: 1, enabled: true, time: { month: 6, day: 21, minutes: 870, daylightSaving: false }, sunIntensity: 1, skyIntensity: 1, shadowIntensity: 0.85, glassTransmission: 1 };
const lighting = { emissive, lights };

// ---- ZIP (deflated, UTF-8 names)
function crc32(data) {
  let crc = 0xffffffff;
  for (const b of data) { crc ^= b; for (let k = 0; k < 8; k++) { crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const packed = deflateRawSync(data, { level: 9 }), nb = enc.encode(name), crc = crc32(data);
    const local = Buffer.alloc(30 + nb.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nb.length, 26); local.set(nb, 30);
    const head = Buffer.alloc(46 + nb.length);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x800, 8); head.writeUInt16LE(8, 10);
    head.writeUInt16LE(0x21, 14); head.writeUInt32LE(crc, 16); head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nb.length, 28); head.writeUInt32LE(offset, 42); head.set(nb, 46);
    parts.push(local, packed); central.push(head);
    offset += local.length + packed.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

// Materials: the table, then material.bin (BMAT header, ushort index per vertex; no surface coordinates)
const materials = { version: 1, textureMaxSize: 512, materials: MATERIALS.map(m => ({ textureState: 'none', ...m })) };
const materialBin = new Uint8Array(16 + vertices.length * 2);
const mv = new DataView(materialBin.buffer);
mv.setUint32(0, 0x54414d42, true); // "BMAT"
mv.setInt32(4, 1, true);
mv.setInt32(8, vertices.length, true);
mv.setInt32(12, 0, true);
vertexMaterial.forEach((m, i) => mv.setUint16(16 + i * 2, m, true));

// Library previews: a small oblique drawing of each type's boxes (PNG, transparent background)
function preview(boxes) {
  const size = 128, px = new Uint8Array(size * size * 4);
  const corners = boxes.flatMap(([a, b]) => [a, b]);
  const project = ([x, y, z]) => [x + y * 0.45, z + y * 0.35];
  const pts = corners.flatMap(([x0, y0, z0]) => [project([x0, y0, z0])]);
  for (const [a, b] of boxes) { pts.push(project(b), project([a[0], b[1], a[2]]), project([b[0], a[1], b[2]])); }
  const minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0])), minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
  const scale = 0.8 * size / Math.max(maxX - minX, maxY - minY, 0.01);
  const ox = (size - (maxX - minX) * scale) / 2, oy = (size - (maxY - minY) * scale) / 2;
  const fill = (poly, rgb) => {
    const sp = poly.map(p => [ox + (p[0] - minX) * scale, size - (oy + (p[1] - minY) * scale)]);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let inside = false;
        for (let i = 0, j = sp.length - 1; i < sp.length; j = i++) {
          const [ax, ay] = sp[i], [bx, by] = sp[j];
          if ((ay > y + 0.5) !== (by > y + 0.5) && x + 0.5 < (bx - ax) * (y + 0.5 - ay) / (by - ay) + ax) { inside = !inside; }
        }
        if (inside) { px.set([rgb[0], rgb[1], rgb[2], 255], (y * size + x) * 4); }
      }
    }
  };
  const shade = (c, f) => c.slice(0, 3).map(v => Math.min(255, Math.round(v * f)));
  // Back to front: furthest (largest y), then lowest
  for (const [a, b, c] of [...boxes].sort((p, q) => q[0][1] - p[0][1] || p[0][2] - q[0][2])) {
    const [x0, y0, z0] = a, [x1, y1, z1] = b;
    fill([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]].map(project), shade(c, 0.85));        // front
    fill([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]].map(project), shade(c, 0.65));        // side
    fill([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(project), shade(c, 1.05));        // top
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
    b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const library = {
  version: 1, vertexStart: templateVertexStart,
  entries: libraryEntries.map(({ boxes: _boxes, ...entry }) => entry)
};
const previews = libraryEntries.map(e => [e.preview, preview(e.boxes)]);

const json = (v, indent) => JSON.stringify(v, null, indent ? 2 : 0);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, zip([
  ['manifest.json', json(manifest, true)], ['model.json', json(model, true)], ['elements.json', json(elementsJson)],
  ['parameters.json', json(parameters)], ['geometry.bin', geometry], ['comments.json', json(comments, true)],
  ['journal.json', json({ entries: [] }, true)], ['bookmarks.json', json(bookmarks, true)], ['sun.json', json(sun, true)],
  ['lighting.json', json(lighting)], ['materials.json', json(materials)], ['material.bin', materialBin], ['library.json', json(library)],
  ...previews
]));
console.log(`Wrote ${OUT}: ${elements.length} elements (${libraryEntries.length} library types), ${indices.length / 3} triangles, ${lights.length} lights, ${MATERIALS.length} materials.`);
