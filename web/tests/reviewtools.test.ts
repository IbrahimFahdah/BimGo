import { describe, expect, it } from 'vitest';
import { BimGoReader } from '../src/core/format/BimGoReader';
import { writeBimGo } from '../src/core/format/BimGoWriter';
import { cleanComment, CommentSnapshots, hasMarkup, readBookmarkDocument, readComment, readCommentDocument } from '../src/core/format/DocumentModels';
import { EditJournal } from '../src/core/edits/EditJournal';
import { type Vec3, vec3 } from '../src/core/math/Vector';
import { MeasureMath } from '../src/core/scene/MeasureMath';
import { Units, UnitSystem } from '../src/core/scene/Units';
import { buildGeometry, buildZip } from './zipFixture';

// Port of tests/BimGo.Core.Tests/ReviewToolsTests.cs (review tools round B1): display units, the Measure gun's maths
// and the unmarked original kept beside a marked-up comment picture; plus thumbnail.jpg through the .bimgo.

const MARKED = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 0xff, 0xd9]);
const ORIGINAL = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const THUMBNAIL = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 0xff, 0xd9]);

describe('Units', () => {
  it('rounds feet-inches to eighths and reduces', () => {
    // 1.715 m = 67.52" → 5' 7 1/2"
    expect(Units.feetInches(1.715)).toEqual({ negative: false, feet: 5, inches: 7, numerator: 1, denominator: 2 });
    // 11 15/16" rounds up into the next foot
    expect(Units.feetInches((12 - 1 / 16 + 0.0001) * Units.METRES_PER_INCH)).toMatchObject({ feet: 1, inches: 0, numerator: 0, denominator: 1 });
    // 3/8"
    expect(Units.feetInches(3 / 8 * Units.METRES_PER_INCH)).toMatchObject({ feet: 0, inches: 0, numerator: 3, denominator: 8 });
    expect(Units.feetInches(NaN)).toBeNull();
  });

  it('formats lengths in each system', () => {
    expect(Units.length(1.715, UnitSystem.Metric)).toBe('1.715 m');
    expect(Units.length(1.716, UnitSystem.Metric, false, 2)).toBe('1.72 m');
    expect(Units.length(1.715, UnitSystem.Imperial)).toBe('5\' 7 1/2"');
    expect(Units.length(1.715, UnitSystem.Imperial, true)).toBe("5.627'");
    expect(Units.length(1.715, UnitSystem.Imperial, true, 2)).toBe("5.63'");
    expect(Units.length(-0.3048, UnitSystem.Imperial)).toBe('−1\' 0"');
    expect(Units.length(-0.0001, UnitSystem.Imperial)).toBe('0\' 0"'); // a value that rounds to zero has no sign
    expect(Units.length(-0.25, UnitSystem.Metric)).toBe('−0.250 m');
    expect(Units.length(Infinity, UnitSystem.Metric)).toBe('—');
  });

  it('converts areas and coordinates', () => {
    expect(Units.area(10, UnitSystem.Metric)).toBe('10.0 m²');
    expect(Units.area(10, UnitSystem.Imperial)).toBe('107.6 ft²');
    expect(Units.coordinate(304.8, UnitSystem.Imperial)).toBe("1000.000'"); // coordinates use decimal feet
    expect(Units.coordinate(304.8, UnitSystem.Metric)).toBe('304.800 m');
    expect(Units.toSquareFeet(1 / Units.SQFT_PER_SQM)).toBeCloseTo(1, 12);
  });
});

describe('Measure maths', () => {
  const l: Vec3[] = [vec3(0, 0, 0), vec3(3, 0, 0), vec3(3, 1, 0), vec3(1, 1, 0), vec3(1, 3, 0), vec3(0, 3, 0)];

  it('measures a square on any plane and a concave outline', () => {
    const floor = [vec3(0, 0, 3), vec3(2, 0, 3), vec3(2, 2, 3), vec3(0, 2, 3)];
    expect(MeasureMath.polygonArea(floor, vec3(0, 0, 1))).toBeCloseTo(4, 5);
    expect(MeasureMath.perimeter(floor)).toBeCloseTo(8, 5);
    expect(MeasureMath.perimeter(floor, false)).toBeCloseTo(6, 5);

    // The same square on a wall (normal along −Y), clockwise from the wall's side
    const wall = [vec3(0, 5, 0), vec3(0, 5, 2), vec3(2, 5, 2), vec3(2, 5, 0)];
    expect(MeasureMath.polygonArea(wall, vec3(0, -1, 0))).toBeCloseTo(4, 5);

    // L shape (concave): 3 × 3 minus 2 × 2 = 5
    expect(MeasureMath.polygonArea(l, vec3(0, 0, 1))).toBeCloseTo(5, 5);
  });

  it('triangulates a concave outline without leaving it', () => {
    const triangles: number[] = [];
    expect(MeasureMath.triangulate(l, vec3(0, 0, 1), triangles)).toBe(true);
    expect(triangles.length).toBe((l.length - 2) * 3);
    let sum = 0;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = l[triangles[i]], b = l[triangles[i + 1]], c = l[triangles[i + 2]];
      sum += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5;
    }
    expect(sum).toBeCloseTo(5, 5); // the triangles add up to the outline's area (no triangle outside it)

    // Clockwise input works too
    expect(MeasureMath.triangulate([...l].reverse(), vec3(0, 0, 1), triangles)).toBe(true);

    // Random simple polygons (star-shaped around the origin): the triangles always add up to the area
    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 200; n++) {
      const count = 3 + Math.trunc(random() * 12);
      const points = Array.from({ length: count }, (_, i) => {
        const angle = (i + random() * 0.8) / count * Math.PI * 2, radius = 0.5 + random() * 2;
        return vec3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
      });
      MeasureMath.triangulate(points, vec3(0, 0, 1), triangles);
      let total = 0;
      for (let i = 0; i < triangles.length; i += 3) {
        const a = points[triangles[i]], b = points[triangles[i + 1]], c = points[triangles[i + 2]];
        total += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5;
      }
      expect(total).toBeCloseTo(MeasureMath.polygonArea(points, vec3(0, 0, 1)), 4);
    }
  });

  it('measures angles and meets planes', () => {
    expect(MeasureMath.angleDegrees(vec3(1, 0, 0), vec3(), vec3(0, 0, 2))).toBeCloseTo(90, 4);
    expect(MeasureMath.angleDegrees(vec3(-1, 0, 0), vec3(), vec3(3, 0, 0))).toBeCloseTo(180, 4);
    expect(MeasureMath.angleDegrees(vec3(1, 1, 0), vec3(), vec3(1, 0, 0))).toBeCloseTo(45, 4);
    expect(MeasureMath.angleDegrees(vec3(), vec3(), vec3(1, 0, 0))).toBeNaN();

    expect(MeasureMath.rayPlane(vec3(0, 0, 5), vec3(0, 0, -1), vec3(9, 9, 1), vec3(0, 0, 1))?.z).toBeCloseTo(1, 5);
    expect(MeasureMath.rayPlane(vec3(0, 0, 5), vec3(0, 0, 1), vec3(), vec3(0, 0, 1))).toBeNull(); // plane behind the ray
    expect(MeasureMath.rayPlane(vec3(), vec3(1, 0, 0), vec3(0, 0, 1), vec3(0, 0, 1))).toBeNull(); // parallel
  });
});

describe('Markup originals', () => {
  it('names the original beside the picture', () => {
    const original = CommentSnapshots.originalNameFor('abc123');
    expect(original).toBe('comments/abc123_original.jpg');
    expect(CommentSnapshots.isValidName(original)).toBe(true);
    expect(CommentSnapshots.nameFor('abc123')).not.toBe(original);
  });

  it('drops an original without a picture', () => {
    const record = cleanComment(readComment({ text: 'x', snapshotOriginal: CommentSnapshots.originalNameFor('x') }));
    expect(record.snapshotOriginal).toBeNull(); // an original only makes sense beside a picture
    expect(hasMarkup(record)).toBe(false);
  });

  it('keeps the unmarked original and the file thumbnail in a .bimgo', async () => {
    const source = buildZip({
      'manifest.json': JSON.stringify({ format: 'bimgo', formatVersion: 1, kind: 'revit-export', title: 'Box' }),
      'model.json': JSON.stringify({ originOffset: [0, 0, 0], boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], categories: [{ key: 'walls', loaded: true }] }),
      'elements.json': JSON.stringify({ elements: [{ id: 7, uniqueId: 'u7', name: 'Wall', category: 0, opaque: [0, 3], boundsMin: [0, 0, 0], boundsMax: [1, 1, 0] }] }),
      'geometry.bin': buildGeometry([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2])
    });
    const doc = await BimGoReader.read(source, 'Box.bimgo');
    expect(doc.thumbnail).toBeNull();

    const comments = readCommentDocument({ comments: [{ id: 'c1', text: 'marked', snapshot: 'comments/c1.jpg', snapshotOriginal: 'comments/c1_original.jpg' }] });
    comments.comments[0].snapshotData = MARKED;
    comments.comments[0].snapshotOriginalData = ORIGINAL;
    const saved = await writeBimGo(doc, {
      comments, journal: new EditJournal([]), bookmarks: readBookmarkDocument(null), sun: null, visibility: null, materials: doc.scene.materials,
      savedBy: 'Ann', thumbnail: THUMBNAIL
    }, { generator: 'BimGo Web', version: 'test' }, 'save');

    const back = await BimGoReader.read(saved, 'Box.bimgo');
    const comment = back.comments.comments[0];
    expect(hasMarkup(comment)).toBe(true);
    expect([...comment.snapshotData!]).toEqual([...MARKED]);
    expect([...comment.snapshotOriginalData!]).toEqual([...ORIGINAL]);
    expect([...back.thumbnail!]).toEqual([...THUMBNAIL]);
    expect([...(await BimGoReader.readThumbnail(saved))!]).toEqual([...THUMBNAIL]);
  });
});
