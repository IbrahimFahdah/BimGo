import type { EditRequest, EditResult } from '../edits/EditMessages';
import type { Json } from '../format/Json';
import { LiveClient } from '../live/LiveClient';
import {
  editRequestJson, type HelloAck, isSessionUrl, MessageTypes, readEditResult, readSnapshotReady, type SidecarKind, type SnapshotReady
} from '../live/LiveProtocol';
import type { ModelSource } from './ModelSource';

/**
 * A live Revit session over the add-in's WebSocket (port of BimGo.Core/Live/LiveSessionSource.cs): edits go to Revit
 * and come back as results; plus refresh, "show in Revit", model-change counts and the sidecar files. Game thread
 * only ({@link pump} each frame).
 *
 * Connection health is the socket itself: if it drops, waiting edits are answered as failed (the tools put things
 * back), further edits are refused, and it reconnects with backoff. A session Revit has ended stays read-only.
 */
export class LiveSessionSource implements ModelSource {
  readonly isRevit = true;
  readonly displayName: string;
  /** Model changes reported by Revit since this snapshot (made outside BimGo). */
  modelChanges = 0;
  /** True while Revit extracts a refresh. */
  refreshing = false;
  /** A newer snapshot than the one being walked (set by extract.ready). */
  snapshotReady: SnapshotReady | null = null;
  /** True once Revit ended the session (document closed / Revit exited). */
  closed = false;

  private readonly results: EditResult[] = [];
  private readonly pendingEdits = new Map<number, EditRequest>();
  private readonly notices: string[] = [];
  private nextTicket = 0;
  private wasOpen = true;
  private reconnectIn = 0;
  private reconnectDelay = 1;
  private reconnecting = false;

  constructor(readonly client: LiveClient, readonly hello: HelloAck, public snapshotNumber: number, private readonly appVersion: string) {
    this.displayName = hello.docTitle || 'Revit model';
  }

  get connected(): boolean { return this.client.isOpen && !this.closed; }
  get canEdit(): boolean { return this.connected; }
  get pending(): number { return this.pendingEdits.size; }

  // #region ModelSource

  submit(request: EditRequest): number {
    if (!this.canEdit) { return -1; }
    request.ticket = ++this.nextTicket;
    if (!this.client.send(MessageTypes.EDIT, editRequestJson(request))) { return -1; }
    this.pendingEdits.set(request.ticket, request);
    return request.ticket;
  }

  takeResult(): EditResult | null {
    return this.results.shift() ?? null;
  }

  pump(dt: number): void {
    for (let envelope = this.client.take(); envelope; envelope = this.client.take()) {
      try {
        this.handle(envelope.type, envelope.payload);
      } catch (e) {
        console.warn(`Live message ${envelope.type} failed`, e);
      }
    }
    this.watchConnection(dt);
  }

  // #endregion

  // #region Live link

  takeNotice(): string | null {
    return this.notices.shift() ?? null;
  }

  /** Asks Revit for a fresh snapshot; false when not connected. */
  requestRefresh(): boolean {
    if (!this.connected) { return false; }
    if (this.refreshing) { return true; }
    if (!this.client.send(MessageTypes.EXTRACT_REQUEST, { reason: 'refresh' })) { return false; }
    this.refreshing = true;
    return true;
  }

  /** Asks Revit to select and show elements; false when not connected. */
  showElements(ids: number[]): boolean {
    if (!this.connected || ids.length === 0) { return false; }
    return this.client.send(MessageTypes.SELECT, { elementIds: ids }) !== null;
  }

  /** Asks Revit to select an element inside a linked model (an older add-in selects the link). */
  showLinkedElement(linkInstanceId: number, elementId: number): boolean {
    if (!this.connected || linkInstanceId <= 0) { return false; }
    return this.client.send(MessageTypes.SELECT, {
      elementIds: [linkInstanceId],
      linked: elementId > 0 ? [{ linkInstanceId, elementId }] : null
    }) !== null;
  }

  /** Reads a sidecar beside the model (null when there is none yet or it can't be read). */
  async readSidecar(kind: SidecarKind): Promise<Json | null> {
    if (!this.hello.sidecars || !this.connected) { return null; }
    try {
      const answer = await this.client.request(MessageTypes.SIDECAR_READ, { kind }, 10000);
      if (answer.payload.success === false) {
        this.notices.push(String(answer.payload.message ?? `The ${kind} could not be read`));
        return null;
      }
      const document = answer.payload.document;
      return document && typeof document === 'object' ? document as Json : null;
    } catch (e) {
      console.warn(`Sidecar ${kind} not read`, e);
      return null;
    }
  }

  /** Replaces a sidecar (answers come back as notices on failure only). */
  writeSidecar(kind: SidecarKind, document: Json): boolean {
    if (!this.hello.sidecars || !this.connected) { return false; }
    return this.client.send(MessageTypes.SIDECAR_WRITE, { kind, document }) !== null;
  }

  /** The newest snapshot's address, checked to be on the session's own host. */
  snapshotUrl(ready: SnapshotReady | null): string | null {
    const url = ready?.snapshotUrl ?? null;
    return url && isSessionUrl(url, this.client.launch) ? url : null;
  }

  /** Leaves the session (detach). */
  close(): void {
    this.client.close(!this.closed);
  }

  // #endregion

  private handle(type: string, payload: Json): void {
    switch (type) {
      case MessageTypes.EDIT_RESULT: {
        const result = readEditResult(payload);
        if (this.pendingEdits.delete(result.ticket)) { this.results.push(result); }
        break;
      }
      case MessageTypes.MODEL_CHANGED:
        this.modelChanges += Number(payload.added ?? 0) + Number(payload.modified ?? 0) + Number(payload.deleted ?? 0);
        break;
      case MessageTypes.EXTRACT_READY: {
        const ready = readSnapshotReady(payload);
        if (ready.snapshotNumber > this.snapshotNumber) {
          this.snapshotReady = ready;
          this.refreshing = false;
        }
        break;
      }
      case MessageTypes.EXTRACT_FAILED:
        this.refreshing = false;
        this.notices.push(`Revit could not refresh: ${String(payload.message ?? '')}`);
        break;
      case MessageTypes.SELECT_RESULT:
        if (typeof payload.message === 'string' && payload.message) { this.notices.push(payload.message); }
        break;
      case MessageTypes.SIDECAR_RESULT:
        if (payload.success === false) { this.notices.push(String(payload.message ?? 'Revit could not save a sidecar file')); }
        break;
      case MessageTypes.SESSION_CLOSING:
        this.markClosed(typeof payload.message === 'string' && payload.message ? payload.message : 'The Revit session ended');
        break;
    }
  }

  /** Notices a dropped socket (fails waiting edits) and reconnects with backoff until Revit ends the session. */
  private watchConnection(dt: number): void {
    const open = this.client.isOpen;
    if (open !== this.wasOpen) {
      this.wasOpen = open;
      if (!open && !this.closed) {
        this.failPending('Lost contact with Revit');
        this.notices.push('Lost contact with Revit: edits are paused while it reconnects');
        this.reconnectIn = this.reconnectDelay = 1;
      } else if (open) {
        this.reconnectDelay = 1;
      }
    }
    if (open || this.closed || this.reconnecting) { return; }
    this.reconnectIn -= dt;
    if (this.reconnectIn > 0) { return; }

    this.reconnecting = true;
    this.client.connect(8000)
      .then(() => {
        this.client.send(MessageTypes.HELLO, { appPid: 0, appVersion: this.appVersion });
        this.notices.push('Reconnected to Revit');
      })
      .catch(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10);
        this.reconnectIn = this.reconnectDelay;
      })
      .finally(() => { this.reconnecting = false; });
  }

  private markClosed(reason: string): void {
    if (this.closed) { return; }
    this.closed = true;
    this.refreshing = false;
    this.failPending(reason);
    this.notices.push(`${reason}. The walkthrough is now read-only: save it as a .bimgo file to keep working.`);
  }

  private failPending(message: string): void {
    for (const request of this.pendingEdits.values()) {
      this.results.push({ ticket: request.ticket ?? 0, op: request.op, success: false, message, affectedIds: [], cloneKey: request.newCloneKey });
    }
    this.pendingEdits.clear();
  }
}
