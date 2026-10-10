import { describe, expect, it } from 'vitest';
import {
  BCF_EXTENSIONS_FILE, BCF_MAX_FOV, BCF_TITLE_LENGTH, BcfCoordinates, BcfFrame, BcfMapping, blankComment, deterministicGuid, guidN, md5,
  newBcfComment, newTopic, newViewpoint, readBcf, writeBcf
} from '../src/core/format/Bcf';
import { BimGoReader } from '../src/core/format/BimGoReader';
import { writeBimGo } from '../src/core/format/BimGoWriter';
import {
  CommentPriority, CommentSnapshots, CommentStatus, isVisibilityEmpty, readBookmarkDocument, readCommentDocument, readVisibility
} from '../src/core/format/DocumentModels';
import { EditJournal } from '../src/core/edits/EditJournal';
import { IfcGuid } from '../src/core/format/IfcGuid';
import { readSunStudy } from '../src/core/format/SunStudyFiles';
import { parseXml, XmlError } from '../src/core/format/Xml';
import { ZipReader } from '../src/core/format/Zip';
import { vec3 } from '../src/core/math/Vector';
import { Daylight } from '../src/core/scene/Daylight';
import type { SiteInfo } from '../src/core/scene/ModelInfo';
import { Panorama } from '../src/core/scene/Panorama';
import { SectionCut } from '../src/core/scene/SectionCut';
import { cleanSunHoursSettings, defaultSunHoursSettings, StudyMode, SunHours, SunTarget } from '../src/core/scene/SunHours';
import { type DaylightInputs, NO_ROOM_LIGHT, RayOutcome, SunHoursFace, SunHoursStudy } from '../src/game/SunHoursStudy';
import { buildGeometry, buildZip } from './zipFixture';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

function site(): SiteInfo {
  return {
    trueNorthAngle: 0, projectBasePoint: { position: vec3(5, 6, 1), sharedPosition: vec3() }, surveyPoint: null, hasSharedTransform: true,
    sharedEast: 280000.123456, sharedNorth: 6130000.654321, sharedElevation: 50.5, sharedAngle: 0.3, hasLocation: false, latitude: 0, longitude: 0,
    timeZone: 0, placeName: '', sunStart: ''
  };
}

function comment(fields: Partial<ReturnType<typeof blankComment>> = {}) {
  return { ...blankComment(), author: 'gavin', ...fields };
}

describe('IFC GUIDs', () => {
  it('encodes the extremes, uses text order and round-trips', () => {
    expect(IfcGuid.encode('00000000-0000-0000-0000-000000000000')).toBe('0000000000000000000000');
    expect(IfcGuid.encode('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe('3$$$$$$$$$$$$$$$$$$$$$');
    expect(IfcGuid.encode('00000000-0000-0000-0000-000000000001')).toBe('0000000000000000000001');
    expect(IfcGuid.encode('80000000-0000-0000-0000-000000000000')).toBe('2000000000000000000000');
    for (let i = 0; i < 20; i++) {
      const guid = crypto.randomUUID();
      const text = IfcGuid.encode(guid)!;
      expect(IfcGuid.isValid(text)).toBe(true);
      expect(IfcGuid.decode(text)).toBe(guid);
    }
  });

  it('rejects bad text', () => {
    expect(IfcGuid.isValid(null)).toBe(false);
    expect(IfcGuid.isValid('short')).toBe(false);
    expect(IfcGuid.isValid('4000000000000000000000')).toBe(false);
    expect(IfcGuid.isValid('000000000000000000000!')).toBe(false);
    expect(IfcGuid.decode('nope')).toBeNull();
  });
});

describe('BCF mapping', () => {
  it('maps status and priority both ways, generously on import', () => {
    for (const s of CommentStatus.ALL) { expect(BcfMapping.statusFromBcf(BcfMapping.statusToBcf(s))).toBe(s); }
    for (const p of CommentPriority.ALL) { expect(BcfMapping.priorityFromBcf(BcfMapping.priorityToBcf(p))).toBe(p); }
    expect(BcfMapping.statusFromBcf('Resolved')).toBe(CommentStatus.CLOSED);
    expect(BcfMapping.statusFromBcf('Active')).toBe(CommentStatus.IN_PROGRESS);
    expect(BcfMapping.statusFromBcf('ReOpened')).toBe(CommentStatus.OPEN);
    expect(BcfMapping.statusFromBcf(null)).toBe(CommentStatus.OPEN);
    expect(BcfMapping.priorityFromBcf('Critical')).toBe(CommentPriority.HIGH);
    expect(BcfMapping.priorityFromBcf('Minor')).toBe(CommentPriority.LOW);
    expect(BcfMapping.priorityFromBcf('On hold')).toBe(CommentPriority.NORMAL);
  });

  it('titles take the first line and cut long ones', () => {
    expect(BcfMapping.titleOf('Door swing\nclashes with the bench')).toBe('Door swing');
    const title = BcfMapping.titleOf('x'.repeat(200));
    expect(title.length).toBe(BCF_TITLE_LENGTH);
    expect(title.endsWith('…')).toBe(true);
  });

  it('combines title and description, or uses the first comment', () => {
    expect(BcfMapping.textOf(newTopic({ title: 'Clash', description: 'Duct hits beam' })).text).toBe('Clash — Duct hits beam');
    expect(BcfMapping.textOf(newTopic({ title: 'Duct hits…', description: 'Duct hits beam at grid C' })).text).toBe('Duct hits beam at grid C');
    const first = BcfMapping.textOf(newTopic({ title: 'Clash', comments: [newBcfComment({ text: 'See the beam' })] }));
    expect(first.text).toBe('Clash — See the beam');
    expect(first.usedComment).not.toBeNull();
    expect(BcfMapping.textOf(newTopic()).text).toBe('(untitled issue)');
  });

  it('imports a topic, then merges only new replies and changed fields', () => {
    const reply = newBcfComment({ author: 'sam', text: 'On it', date: '2026-10-01T23:00:00.000Z' });
    const topic = newTopic({
      title: 'Door swing', description: 'Door swing clashes', status: 'Open', priority: 'High', assignedTo: 'sam', creationAuthor: 'gavin', comments: [reply]
    });
    const record = BcfMapping.toComment(topic, blankComment);
    expect(record.id).toBe(guidN(topic.guid));
    expect(record.text).toBe('Door swing clashes');
    expect(record.priority).toBe(CommentPriority.HIGH);
    expect(record.replies?.length).toBe(1);

    expect(BcfMapping.merge(record, topic)).toEqual({ added: 0, fieldsChanged: false });

    topic.status = 'Closed';
    topic.modifiedAuthor = 'sam';
    topic.comments.push(newBcfComment({ author: 'sam', text: 'Fixed in Revit', date: '2026-10-02T00:00:00.000Z' }));
    expect(BcfMapping.merge(record, topic)).toEqual({ added: 1, fieldsChanged: true });
    expect(record.status).toBe(CommentStatus.CLOSED);
    expect(record.updatedBy).toBe('sam');
    expect(record.replies!.at(-1)!.text).toBe('Fixed in Revit');
  });

  it('skips a description repeated as a comment', () => {
    const record = comment({ text: 'Check this door swing' });
    expect(BcfMapping.merge(record, newTopic({ comments: [newBcfComment({ text: 'Check this door swing' })] })).added).toBe(0);
    expect(record.replies).toBeNull();
  });

  it('exports ids, fields and replies; non-GUID ids get stable GUIDs like the desktop', () => {
    const record = comment({
      text: 'Check this door swing\nsecond line', status: CommentStatus.IN_PROGRESS, priority: CommentPriority.LOW, assignedTo: 'sam',
      replies: [{ id: crypto.randomUUID().replace(/-/g, ''), author: 'sam', created: new Date().toISOString(), text: 'Looking' }]
    });
    const topic = BcfMapping.toTopic(record);
    expect(guidN(topic.guid)).toBe(record.id);
    expect(topic.title).toBe('Check this door swing');
    expect(topic.status).toBe('In Progress');
    expect(topic.priority).toBe('Low');
    expect(guidN(topic.comments[0].guid)).toBe(record.replies![0].id);
    // .NET: new Guid(MD5("comment:c1"))
    expect(BcfMapping.toTopic(comment({ id: 'c1', text: 'a' })).guid).toBe('e94dbdfb-5959-588a-c158-d288b6073bbc');
    expect(deterministicGuid('comment:c1')).toBe('e94dbdfb-5959-588a-c158-d288b6073bbc');
  });

  it('computes MD5 like RFC 1321', () => {
    const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    expect(hex(md5(new Uint8Array(0)))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(md5(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')))).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
});

describe('BCF coordinates and viewpoints', () => {
  it('round-trips points and directions in every frame', () => {
    for (const kind of [BcfCoordinates.Shared, BcfCoordinates.Project, BcfCoordinates.Internal]) {
      const { frame, fellBack } = BcfFrame.resolve(site(), kind);
      expect(fellBack).toBe(false);
      expect(frame.kind).toBe(kind);
      const back = frame.pointFromBcf(frame.pointToBcf(12.345, -6.789, 3.21));
      expect(back.x).toBeCloseTo(12.345, 6);
      expect(back.y).toBeCloseTo(-6.789, 6);
      expect(back.z).toBeCloseTo(3.21, 6);
      const d = frame.directionFromBcf(frame.directionToBcf(0.6, 0.8, 0));
      expect(d.x).toBeCloseTo(0.6, 9);
      expect(d.y).toBeCloseTo(0.8, 9);
    }
    const origin = BcfFrame.resolve(site(), BcfCoordinates.Shared).frame.pointToBcf(0, 0, 0);
    expect(origin.x).toBeCloseTo(280000.123456, 6);
    expect(origin.z).toBeCloseTo(50.5, 9);
  });

  it('falls back to internal without a site', () => {
    const { frame, fellBack } = BcfFrame.resolve(null, BcfCoordinates.Shared);
    expect(fellBack).toBe(true);
    expect(frame.kind).toBe(BcfCoordinates.Internal);
  });

  it('round-trips a view through a perspective camera', () => {
    const view = { x: 3.5, y: -2.25, z: 1, yaw: 2, pitch: -0.3, flying: false, section: null };
    const { frame } = BcfFrame.resolve(site(), BcfCoordinates.Shared);
    const viewpoint = BcfMapping.toViewpoint(view, 1.6, frame, 90);
    expect(viewpoint.fieldOfView).toBeCloseTo(58.716, 2);
    const back = BcfMapping.toView(viewpoint, 1.6, frame)!;
    expect(back.x).toBeCloseTo(view.x, 3);
    expect(back.y).toBeCloseTo(view.y, 3);
    expect(back.z).toBeCloseTo(view.z, 3);
    expect(back.yaw).toBeCloseTo(view.yaw, 4);
    expect(back.pitch).toBeCloseTo(view.pitch, 4);
    expect(BcfMapping.toViewpoint(view, 1.6, frame, 120).fieldOfView).toBe(BCF_MAX_FOV);
  });

  it('carries a section box as clipping planes through shared coordinates', () => {
    const cut = new SectionCut();
    cut.boxOn = true;
    cut.boxMax = vec3(10, 8, 3);
    const { frame } = BcfFrame.resolve({ ...site(), sharedAngle: 0.4 }, BcfCoordinates.Shared);
    const planes = BcfMapping.toClippingPlanes(cut, frame);
    expect(planes.length).toBe(6);
    expect(planes[0].location.x).toBeGreaterThan(100000);
    const { cut: back, dropped } = BcfMapping.toSection(planes, frame);
    expect(dropped).toBe(0);
    expect(back!.boxOn).toBe(true);
    expect(back!.boxMax.x).toBeCloseTo(10, 2);
    expect(back!.boxMax.z).toBeCloseTo(3, 2);
  });
});

describe('BCF files', () => {
  it('writes BCF 2.1 and reads the topics back', async () => {
    const topic = BcfMapping.toTopic(comment({
      text: 'Duct clashes with beam', priority: CommentPriority.HIGH, assignedTo: 'sam',
      replies: [{ id: crypto.randomUUID().replace(/-/g, ''), author: 'sam', created: '2026-10-02T01:00:00.000Z', text: 'Will reroute' }]
    }));
    const ifc = IfcGuid.encode(crypto.randomUUID())!;
    topic.viewpoint = newViewpoint({
      position: vec3(280012.5, 6130003.25, 53.1), direction: vec3(0, 1, 0), fieldOfView: 55,
      selection: [{ ifcGuid: ifc, authoringToolId: '202', originatingSystem: 'Autodesk Revit 2026' }],
      clippingPlanes: [{ location: vec3(0, 0, 2.5), direction: vec3(0, 0, 1) }]
    });
    topic.snapshot = JPEG;
    const blob = await writeBcf({ projectId: 'p1', name: 'Test' }, [topic]);

    const zip = await ZipReader.open(blob);
    expect(zip.names).toEqual(expect.arrayContaining(['bcf.version', 'project.bcfp', BCF_EXTENSIONS_FILE,
      `${topic.guid}/markup.bcf`, `${topic.guid}/viewpoint.bcfv`, `${topic.guid}/snapshot.png`]));
    expect(await zip.readText(zip.get('project.bcfp')!)).toContain('<ExtensionSchema>extensions.xsd</ExtensionSchema>');
    const xsd = await zip.readText(zip.get(BCF_EXTENSIONS_FILE)!);
    expect(xsd).toContain('In Progress');
    expect(xsd).toContain('markup.xsd');

    const { result, error } = await readBcf(blob);
    expect(error).toBeNull();
    expect(result!.version).toBe('2.1');
    expect(result!.project!.name).toBe('Test');
    const back = result!.topics[0];
    expect(back.guid).toBe(topic.guid);
    expect(back.title).toBe(topic.title);
    expect(back.description).toBe(topic.description);
    expect(back.status).toBe('Open');
    expect(back.priority).toBe('High');
    expect(back.assignedTo).toBe('sam');
    expect(back.comments.map(c => [c.guid, c.text])).toEqual([[topic.comments[0].guid, 'Will reroute']]);
    expect(Math.floor(Date.parse(back.creationDate) / 1000)).toBe(Math.floor(Date.parse(topic.creationDate) / 1000));
    expect(back.viewpoint!.position.x).toBeCloseTo(280012.5, 6);
    expect(back.viewpoint!.fieldOfView).toBe(55);
    expect(back.viewpoint!.selection[0]).toMatchObject({ ifcGuid: ifc, authoringToolId: '202' });
    expect(back.viewpoint!.clippingPlanes[0].location.z).toBe(2.5);
    expect([...back.snapshot!]).toEqual([...JPEG]);
  });

  it('reads the BCF 3.0 layout (comments and viewpoints under the topic)', async () => {
    const guid = crypto.randomUUID();
    const markup = `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Topic Guid="${guid}" TopicType="Clash" TopicStatus="Active">
    <Title>Beam clash</Title><Priority>Critical</Priority>
    <CreationDate>2026-10-01T10:00:00Z</CreationDate><CreationAuthor>bob@example.com</CreationAuthor>
    <Comments><Comment Guid="${crypto.randomUUID()}"><Date>2026-10-01T11:00:00Z</Date><Author>bob@example.com</Author><Comment>Please &amp; check</Comment></Comment></Comments>
    <Viewpoints><ViewPoint Guid="${crypto.randomUUID()}"><Viewpoint>vp1.bcfv</Viewpoint><Snapshot>snap1.png</Snapshot></ViewPoint></Viewpoints>
  </Topic>
</Markup>`;
    const viewpoint = `<VisualizationInfo Guid="${crypto.randomUUID()}"><PerspectiveCamera>
<CameraViewPoint><X>1</X><Y>2</Y><Z>3</Z></CameraViewPoint><CameraDirection><X>0</X><Y>1</Y><Z>0</Z></CameraDirection>
<CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector><FieldOfView>50</FieldOfView></PerspectiveCamera></VisualizationInfo>`;
    const blob = buildZip({
      'bcf.version': '<?xml version="1.0"?><Version VersionId="3.0"/>', [`${guid}/markup.bcf`]: markup, [`${guid}/vp1.bcfv`]: viewpoint, [`${guid}/snap1.png`]: JPEG
    });
    const { result } = await readBcf(blob);
    expect(result!.version).toBe('3.0');
    const topic = result!.topics[0];
    expect(topic.guid).toBe(guid);
    expect(topic.comments[0].text).toBe('Please & check');
    expect(topic.viewpoint!.position.z).toBe(3);
    expect(topic.snapshotExtension).toBe('.png');

    const record = BcfMapping.toComment(topic, blankComment);
    expect(record.status).toBe(CommentStatus.IN_PROGRESS);
    expect(record.priority).toBe(CommentPriority.HIGH);
    expect(record.text).toBe('Beam clash — Please & check');
    expect(record.replies).toBeNull();
  });

  it('skips a damaged topic and refuses non-ZIPs', async () => {
    const blob = buildZip({ 'a/markup.bcf': `<Markup><Topic Guid="${crypto.randomUUID()}"><Title>Fine</Title></Topic></Markup>`, 'b/markup.bcf': '<Markup><Topic' });
    const { result } = await readBcf(blob);
    expect(result!.topics.length).toBe(1);
    expect(result!.skipped).toBe(1);
    const bad = await readBcf(new Blob(['hello']));
    expect(bad.result).toBeNull();
    expect(bad.error).toBeTruthy();
  });

  it('parses XML namespace-agnostically and refuses DTDs', () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><a:Root xmlns:a="x" a:Id="1"><B><![CDATA[<x>]]> &#65;&#x42;</B></a:Root>');
    expect(root.name).toBe('Root');
    expect(root.attributes.get('Id')).toBe('1');
    expect(root.children[0].text).toBe('<x> AB');
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>')).toThrow(XmlError);
  });
});

describe('Comment pictures, IFC GUIDs and cuts in the .bimgo', () => {
  it('names pictures safely', () => {
    expect(CommentSnapshots.nameFor('abc123')).toBe('comments/abc123.jpg');
    expect(CommentSnapshots.nameFor('a/b')).toBe('comments/a_b.jpg');
    expect(CommentSnapshots.isValidName('comments/abc.jpg')).toBe(true);
    expect(CommentSnapshots.isValidName('comments/../x.jpg')).toBe(false);
    expect(CommentSnapshots.isValidName('textures/abc.jpg')).toBe(false);
    expect(CommentSnapshots.isValidName(null)).toBe(false);
  });

  it('keeps comment pictures, element UniqueIds, IFC GUIDs and section cuts', async () => {
    const ifc = IfcGuid.encode(crypto.randomUUID())!;
    const source = buildZip({
      'manifest.json': JSON.stringify({ format: 'bimgo', formatVersion: 1, kind: 'revit-export', title: 'Box' }),
      'model.json': JSON.stringify({ originOffset: [100, 200, 0], boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], categories: [{ key: 'walls', loaded: true }] }),
      'elements.json': JSON.stringify({ elements: [{ id: 7, uniqueId: 'u7', ifcGuid: ifc, name: 'Wall', category: 0, opaque: [0, 3] }] }),
      'geometry.bin': buildGeometry([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2])
    });
    const doc = await BimGoReader.read(source, 'Box.bimgo');
    expect(doc.scene.elements[0].ifcGuid).toBe(ifc);

    const cut = { boxOn: true, minX: 100, minY: 200, minZ: 0, maxX: 105, maxY: 204, maxZ: 3, planeOn: false };
    const comments = readCommentDocument({ comments: [{ id: 'c1', text: 'Check', elementUniqueId: 'door-uid', snapshot: 'comments/c1.jpg',
      view: { x: 101, y: 201, z: 0, yaw: 1, pitch: 0, section: cut } }] });
    comments.comments[0].snapshotData = JPEG;
    const saved = await writeBimGo(doc, {
      comments, journal: new EditJournal([]), bookmarks: readBookmarkDocument({ bookmarks: [{ id: 'b', name: 'V', section: cut }] }),
      sun: null, visibility: readVisibility({ section: cut }), materials: doc.scene.materials, savedBy: 'Ann'
    }, { generator: 'BimGo Web', version: 'test' }, 'save');
    const zip = await ZipReader.open(saved);
    expect(zip.names).toContain('comments/c1.jpg');

    const back = await BimGoReader.read(saved, 'Box.bimgo');
    expect(back.scene.elements[0].ifcGuid).toBe(ifc);
    const c = back.comments.comments[0];
    expect(c.elementUniqueId).toBe('door-uid');
    expect(c.snapshot).toBe('comments/c1.jpg');
    expect([...c.snapshotData!]).toEqual([...JPEG]);
    expect(c.view!.section!.boxMax).toEqual(vec3(105, 204, 3));
    expect(back.bookmarks.bookmarks[0].section!.boxOn).toBe(true);
    expect(back.visibility!.section!.boxMin).toEqual(vec3(100, 200, 0));
  });

  it('keeps a visibility cut only when it cuts', () => {
    expect(isVisibilityEmpty(readVisibility({ section: { boxOn: true, maxX: 1, maxY: 1, maxZ: 1 } }))).toBe(false);
    const off = readVisibility({ section: { boxOn: false, planeOn: false } });
    expect(off.section).toBeNull();
    expect(isVisibilityEmpty(off)).toBe(true);
  });
});

describe('Section cut', () => {
  const box = () => {
    const c = new SectionCut();
    c.boxOn = true;
    c.boxMax = vec3(10, 8, 3);
    return c;
  };

  it('cuts outside the box and beyond the plane', () => {
    const cut = box();
    cut.planeOn = true;
    cut.planePoint = vec3(5, 0, 0);
    cut.planeNormal = vec3(1, 0, 0);
    const origin = vec3(100, 200, 10);
    const planes = cut.localPlanes(origin);
    expect(planes.length).toBe(7);
    const cutAt = (x: number, y: number, z: number) => SectionCut.isCut(planes, x - origin.x, y - origin.y, z - origin.z);
    expect(cutAt(2, 2, 1)).toBe(false);
    expect(cutAt(7, 2, 1)).toBe(true);
    expect(cutAt(2, 9, 1)).toBe(true);
    expect(cutAt(2, 2, 3.5)).toBe(true);
    expect(new SectionCut().localPlanes(origin).length).toBe(0);
  });

  it('cleans corners and normals', () => {
    const cut = new SectionCut();
    cut.boxOn = true;
    cut.boxMin = vec3(5, 0, NaN);
    cut.boxMax = vec3(1, 0.05, 2);
    cut.planeOn = true;
    cut.planeNormal = vec3(0, 3, 0);
    cut.clean();
    expect(cut.boxMin.x).toBe(1);
    expect(cut.boxMax.x).toBe(5);
    expect(cut.boxMax.y - cut.boxMin.y).toBeCloseTo(SectionCut.MIN_SIZE, 6);
    expect(cut.boxMin.z).toBe(0);
    expect(cut.planeNormal.y).toBeCloseTo(1, 6);
    const zero = new SectionCut();
    zero.planeOn = true;
    zero.planeNormal = vec3();
    expect(zero.clean().planeOn).toBe(false);
  });

  it('round-trips box and plane through clipping planes; an incomplete box becomes a plane', () => {
    const cut = box();
    cut.planeOn = true;
    cut.planePoint = vec3(1, 2, 3);
    cut.planeNormal = vec3(Math.SQRT1_2, Math.SQRT1_2, 0);
    const { cut: back, dropped } = SectionCut.fromPlanes(cut.toPlanes());
    expect(dropped).toBe(0);
    expect(back!.boxOn && back!.planeOn).toBe(true);
    expect(back!.boxMax).toEqual(cut.boxMax);
    expect(back!.planePoint).toEqual(cut.planePoint);
    expect(SectionCut.fromPlanes([]).cut).toBeNull();

    const partial = SectionCut.fromPlanes([{ point: vec3(0, 0, 2.5), direction: vec3(0, 0, 1) }, { point: vec3(), direction: vec3(0, 0, -1) }]);
    expect(partial.cut!.boxOn).toBe(false);
    expect(partial.cut!.planeOn).toBe(true);
    expect(partial.dropped).toBe(1);
  });
});

describe('Daylight', () => {
  it('patches cover the sky and round-trip', () => {
    let total = 0;
    for (let p = 0; p < Daylight.PATCHES; p++) {
      total += Daylight.patchSolidAngle(p);
      const c = Daylight.patchCentre(p);
      expect(Daylight.patchOf(c.x, c.y, c.z)).toBe(p);
    }
    expect(total).toBeCloseTo(2 * Math.PI, 9);
    expect(Daylight.patchOf(1, 0, -0.1)).toBe(-1);
    expect(Daylight.patchOf(1, 0, 0)).toBe(-1);
  });

  it('scales the overcast sky to a unit horizontal illuminance, which an open cell sees whole', () => {
    const luminance = new Float32Array(Daylight.PATCHES);
    Daylight.overcastPatches(luminance);
    expect(Daylight.horizontalIlluminance(luminance)).toBeCloseTo(1, 5);
    const rays = Daylight.cosineDirections(4096);
    let sum = 0;
    for (const r of rays) { sum += luminance[Daylight.patchOf(r.x, r.y, r.z)]; }
    expect(Math.abs(Math.PI / rays.length * sum - 1)).toBeLessThan(0.03);
    expect(rays.reduce((a, r) => a + r.z, 0) / rays.length).toBeCloseTo(2 / 3, 1);
  });

  it('brightens the clear sky near the sun and matches the IES figures', () => {
    const sun = vec3(0, Math.SQRT1_2, Math.SQRT1_2);
    const luminance = new Float32Array(Daylight.PATCHES);
    const diffuse = Daylight.clearPatches(sun, luminance);
    expect(diffuse).toBeCloseTo(Daylight.diffuseHorizontalClear(sun.z), 6);
    expect(Daylight.horizontalIlluminance(luminance)).toBeCloseTo(diffuse, 0);
    expect(luminance[Daylight.patchOf(sun.x, sun.y, sun.z)]).toBeGreaterThan(3 * luminance[Daylight.patchOf(0, -Math.SQRT1_2, Math.SQRT1_2)]);
    expect(Daylight.clearPatches(vec3(0, 1, -0.1), luminance)).toBe(0);
    const high = Daylight.directNormalClear(Math.sin(Math.PI / 3));
    expect(high).toBeGreaterThan(90000);
    expect(high).toBeLessThan(110000);
  });

  it('matches the split-flux worked example and reflectances', () => {
    expect(Daylight.internalReflectedPercent(4, 88.6, 0.5, 0.4, 0.6)).toBeCloseTo(1.4275, 3);
    expect(Daylight.internalReflectedPercent(0, 88.6, 0.5, 0.4, 0.6)).toBe(0);
    expect(Daylight.floorBounceLux(10000, 88.6, 0.5, 0.4)).toBeCloseTo(10000 * 0.4 / (88.6 * 0.5), 1);
    expect(Daylight.reflectanceOf(255, 255, 255)).toBeCloseTo(0.9, 6);
    expect(Daylight.reflectanceOf(0, 0, 0)).toBeCloseTo(0.05, 6);
    expect(Math.abs(Daylight.reflectanceOf(188, 188, 188) - 0.5)).toBeLessThan(0.02);
    expect(Daylight.factorColour(Daylight.DF_LEGEND_MAX)).toEqual(SunHours.legendColour(SunHours.LEGEND_MAX));
  });
});

describe('Studies', () => {
  it('cleans the round-2 settings (older presets read as pass / fail on)', () => {
    const s = cleanSunHoursSettings({ ...defaultSunHoursSettings(), target: 2 as SunTarget, targetHours: 2.6, rays: 300, luxShare: 0.44, mode: 7 as StudyMode }, 2026);
    expect(s.target).toBe(SunTarget.On);
    expect(s.targetHours).toBe(2.5);
    expect(s.rays).toBe(256);
    expect(s.luxShare).toBeCloseTo(0.4, 6);
    expect(s.mode).toBe(StudyMode.SunHours);
  });

  it('a daylight run on an open floor gives about 100 % and pass / fail follows the target', () => {
    const face = new SunHoursFace(0, vec3(0, 0, 1), 0);
    face.triangles.push([vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0)], [vec3(1, 0, 0), vec3(1, 1, 0), vec3(0, 1, 0)]);
    const settings = cleanSunHoursSettings({ ...defaultSunHoursSettings(), mode: StudyMode.DaylightFactor, gridSize: 0.5, factorTarget: 2 }, 2026);
    const study = new SunHoursStudy();
    study.build([face], settings, []);
    expect(study.cellCount).toBe(4);
    const overcast = new Float32Array(Daylight.PATCHES);
    Daylight.overcastPatches(overcast);
    const inputs: DaylightInputs = {
      mode: StudyMode.DaylightFactor, classify: (_o, d) => ({ outcome: d.z > 0 ? RayOutcome.Sky : RayOutcome.Ground, transmit: 1 }),
      rays: Daylight.cosineDirections(1024), overcast, suns: [], clear: [], diffuse: [], directNormal: [], totalSamples: 0, directSun: true,
      luxTarget: 300, rooms: [NO_ROOM_LIGHT], cellArea: 0.25
    };
    expect(study.startDaylight(inputs, settings)).toBe(true);
    study.step(() => false, 1e6);
    expect(study.finished).toBe(true);
    expect(Math.abs(study.hours![0] - 100)).toBeLessThan(4);
    expect(study.passShare(settings)).toBe(1);
    expect(study.setResults([1, 3, 1, 3], { ...settings, mode: StudyMode.SunHours }, 72, 72)).toBe(true);
    expect(study.passShare({ ...settings, targetHours: 2 })).toBe(0.5);
  });

  it('reads saved studies and refuses inconsistent ones', () => {
    const json = { name: 'Kitchen', grid: { gridSize: 0.25 }, run: { mode: 2, target: 1 }, faces: [{ elementId: 7, nx: 0, ny: 0, nz: 1, offset: 0 }],
      cellFaces: [0, 0], points: [0, 0, 0, 1, 0, 0], hours: [300, 450], shares: [0.5, 1] };
    const study = readSunStudy(json, 'x')!;
    expect(study.run.mode).toBe(StudyMode.Illuminance);
    expect(study.run.target).toBe(SunTarget.On);
    expect(study.shares).toEqual([0.5, 1]);
    expect(readSunStudy({ ...json, points: [0, 0] }, 'x')).toBeNull();
    expect(readSunStudy({ ...json, cellFaces: [0, 3] }, 'x')).toBeNull();
  });
});

describe('Panorama', () => {
  it('maps the centre to the heading, right turns right, the top looks up', () => {
    const W = 4096, H = 2048;
    expect(Panorama.direction(W / 2, H / 2, W, H, 0).x).toBeCloseTo(1, 3);
    expect(Panorama.direction(W * 3 / 4, H / 2, W, H, 0).y).toBeCloseTo(-1, 3);
    expect(Panorama.direction(10, 0, W, H, 0).z).toBeGreaterThan(0.999);
    expect(Panorama.direction(W / 2, H / 2, W, H, Math.PI / 2).y).toBeCloseTo(1, 3);
    expect(Panorama.faceSize(4096, 90)).toBe(Math.ceil(4096 / Math.PI));
  });

  it('adds Photo Sphere XMP after the JFIF header', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xda, 0x01, 0xff, 0xd9]);
    const tagged = Panorama.addPhotoSphereXmp(jpeg, 4096, 2048, 90);
    expect([tagged[0], tagged[1], tagged[3], tagged[8], tagged[9]]).toEqual([0xff, 0xd8, 0xe0, 0xff, 0xe1]);
    const text = new TextDecoder().decode(tagged);
    expect(text).toContain('<GPano:ProjectionType>equirectangular</GPano:ProjectionType>');
    expect(text).toContain('<GPano:FullPanoWidthPixels>4096</GPano:FullPanoWidthPixels>');
    expect(tagged.at(-1)).toBe(0xd9);
    expect((tagged[10] << 8) | tagged[11]).toBe(tagged.length - jpeg.length - 2);
    expect(Panorama.addPhotoSphereXmp(new Uint8Array([1, 2, 3, 4]), 1, 1)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
