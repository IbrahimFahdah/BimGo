import { EditOp, type EditRequest, type EditResult } from '../edits/EditMessages';
import { type Json } from '../format/Json';
import { f } from '../format/BimGoWriter';

/**
 * The app ↔ Revit session protocol, version 1 (port of BimGo.Core/Live/LiveProtocol.cs): JSON envelopes, here carried
 * over a loopback WebSocket served by the add-in instead of session folders. Same shapes as the desktop's
 * System.Text.Json output: camelCase, enums as camelCase strings, Vector3 as [x, y, z].
 */
export const LiveProtocol = {
  VERSION: 1,
  /** The add-in's limit per message. */
  MAX_MESSAGE_BYTES: 4 * 1024 * 1024,
  /** The token header for snapshot downloads. */
  TOKEN_HEADER: 'X-BimGo-Token'
} as const;

/** Message types (port of MessageTypes). */
export const MessageTypes = {
  HELLO: 'hello',
  HELLO_ACK: 'hello.ack',
  EXTRACT_REQUEST: 'extract.request',
  EXTRACT_READY: 'extract.ready',
  EXTRACT_FAILED: 'extract.failed',
  EDIT: 'edit',
  EDIT_RESULT: 'edit.result',
  SELECT: 'select.elements',
  SELECT_RESULT: 'select.result',
  MODEL_CHANGED: 'model.changed',
  SESSION_CLOSING: 'session.closing',
  DETACH: 'detach',
  SIDECAR_READ: 'sidecar.read',
  SIDECAR_DATA: 'sidecar.data',
  SIDECAR_WRITE: 'sidecar.write',
  SIDECAR_RESULT: 'sidecar.result'
} as const;

/** The sidecar files kept beside the Revit model. */
export type SidecarKind = 'comments' | 'bookmarks' | 'sun' | 'visibility';

/** One protocol message. */
export interface Envelope {
  protocol: number;
  id: string;
  seq: number;
  sessionId: string;
  type: string;
  replyTo?: string;
  sentUtc: string;
  payload: Json;
}

export interface HelloAck {
  docTitle: string;
  revitVersion: string;
  phaseName: string | null;
  existingPhaseName: string | null;
  snapshotNumber: number;
  snapshotUrl: string | null;
  sidecars: boolean;
}

export interface SnapshotReady {
  snapshotNumber: number;
  snapshotUrl: string | null;
  elements: number;
  triangles: number;
  reason: string;
}

/** Where to reach the add-in: from the launch URL (?live=127.0.0.1:port&session=…#token=…). */
export interface LaunchInfo {
  /** "127.0.0.1:47800". */
  host: string;
  sessionId: string;
  token: string;
}

const OP_NAMES = ['phaseDemolish', 'delete', 'transform', 'copy', 'place'];

/** EditOp → its JSON name. */
export function editOpName(op: EditOp): string {
  return OP_NAMES[op] ?? 'transform';
}

/** An edit as the add-in reads it (EditRequest). */
export function editRequestJson(r: EditRequest): Json {
  const v = (p?: { x: number; y: number; z: number }) => (p ? [f(p.x), f(p.y), f(p.z)] : [0, 0, 0]);
  return {
    ticket: r.ticket ?? 0,
    op: editOpName(r.op),
    elementId: r.elementId,
    targetCloneKey: r.targetCloneKey ?? 0,
    newCloneKey: r.newCloneKey ?? 0,
    // Place only (an older add-in can't read the op anyway; other ops leave the type out)
    ...(r.op === EditOp.Place ? { typeUniqueId: r.typeUniqueId ?? null, typeId: r.typeId ?? 0 } : {}),
    pivot: v(r.pivot),
    translation: v(r.translation),
    angle: f(r.angle ?? 0),
    label: r.label
  };
}

/** The add-in's EditResult. */
export function readEditResult(j: Json): EditResult {
  const op = OP_NAMES.indexOf(String(j.op));
  return {
    ticket: num(j.ticket),
    op: op >= 0 ? op as EditOp : EditOp.Transform,
    success: j.success === true,
    message: typeof j.message === 'string' ? j.message : undefined,
    affectedIds: Array.isArray(j.affectedIds) ? (j.affectedIds as unknown[]).map(num).filter(id => id > 0) : [],
    newElementId: num(j.newElementId),
    cloneKey: num(j.cloneKey)
  };
}

export function readHelloAck(j: Json): HelloAck {
  return {
    docTitle: str(j.docTitle) ?? '',
    revitVersion: str(j.revitVersion) ?? '',
    phaseName: str(j.phaseName),
    existingPhaseName: str(j.existingPhaseName),
    snapshotNumber: num(j.snapshotNumber),
    snapshotUrl: str(j.snapshotUrl),
    sidecars: j.sidecars === true
  };
}

export function readSnapshotReady(j: Json): SnapshotReady {
  return {
    snapshotNumber: num(j.snapshotNumber),
    snapshotUrl: str(j.snapshotUrl),
    elements: num(j.elements),
    triangles: num(j.triangles),
    reason: str(j.reason) ?? 'refresh'
  };
}

/**
 * Reads the launch parameters: ?live=127.0.0.1:<port>&session=<32 hex> and #token=<hex>. Only loopback addresses
 * are accepted, so a crafted link can't point the viewer at another machine.
 */
export function readLaunch(search: string, hash: string): LaunchInfo | null {
  const query = new URLSearchParams(search);
  const live = query.get('live'), sessionId = query.get('session');
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  if (!live || !sessionId || !/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(live) || !/^[0-9a-fA-F]{32}$/.test(sessionId)) { return null; }
  return { host: live, sessionId: sessionId.toLowerCase(), token: token && /^[0-9a-f]{16,128}$/i.test(token) ? token : '' };
}

/** True when a snapshot URL points at the same loopback host as the session (never elsewhere). */
export function isSessionUrl(url: string, launch: LaunchInfo): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && u.host === launch.host;
  } catch {
    return false;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
