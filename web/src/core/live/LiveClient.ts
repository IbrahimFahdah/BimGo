import { obj, type Json } from '../format/Json';
import { type Envelope, type LaunchInfo, LiveProtocol } from './LiveProtocol';

/** Why a connection could not be made, for the user. */
export class LiveConnectError extends Error {}

/**
 * The browser's end of a live session (replaces FolderChannel for the web viewer): one WebSocket to the add-in's
 * loopback server. Received envelopes queue up for {@link take}; {@link request} waits for the answer to one message.
 * The socket can be reopened after a drop ({@link connect} again); messages sent while closed are dropped, as the
 * add-in does.
 */
export class LiveClient {
  private socket: WebSocket | null = null;
  private readonly inbox: Envelope[] = [];
  private readonly waiting = new Map<string, { resolve: (e: Envelope) => void; reject: (e: Error) => void; timer: number }>();
  private seq = 0;

  constructor(readonly launch: LaunchInfo) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Opens the socket.
   * @throws LiveConnectError when Revit can't be reached (or refuses the token) within the timeout.
   */
  connect(timeoutMs = 15000): Promise<void> {
    this.socket?.close();
    const { host, sessionId, token } = this.launch;
    const socket = new WebSocket(`ws://${host}/live/${sessionId}?token=${encodeURIComponent(token)}`);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        socket.close();
        reject(new LiveConnectError('Revit did not answer in time.'));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('close', () => {
        window.clearTimeout(timer);
        reject(new LiveConnectError('Revit refused the connection or is not running this session.'));
        if (this.socket === socket) { this.failWaiting('The connection to Revit closed.'); }
      }, { once: true });
      socket.addEventListener('message', e => this.receive(e.data));
    });
  }

  /** Closes the socket for good (detach is sent first when open). */
  close(sayGoodbye: boolean): void {
    if (sayGoodbye && this.isOpen) { this.send('detach', null); }
    this.socket?.close(1000, 'Bye');
    this.socket = null;
    this.failWaiting('Closed.');
  }

  /**
   * Sends a message.
   * @returns The envelope's id, or null when not connected (or the message is too big).
   */
  send(type: string, payload: Json | null, replyTo?: string): string | null {
    if (!this.isOpen) { return null; }
    const envelope: Envelope = {
      protocol: LiveProtocol.VERSION,
      id: newId(),
      seq: ++this.seq,
      sessionId: this.launch.sessionId,
      type,
      replyTo,
      sentUtc: new Date().toISOString(),
      payload: payload ?? {}
    };
    const text = JSON.stringify(envelope);
    if (text.length > LiveProtocol.MAX_MESSAGE_BYTES) {
      console.warn(`Live message ${type} too big (${text.length} bytes): not sent.`);
      return null;
    }
    this.socket!.send(text);
    return envelope.id;
  }

  /**
   * Sends a message and waits for the answer to it.
   * @throws Error when not connected, on timeout, or when the socket closes first.
   */
  request(type: string, payload: Json | null, timeoutMs = 15000): Promise<Envelope> {
    const id = this.send(type, payload);
    if (!id) { return Promise.reject(new Error('Not connected to Revit.')); }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`Revit did not answer ${type} (an older BimGo add-in? Update it).`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
    });
  }

  /** Takes the next message that is not the answer to a {@link request}, or null. */
  take(): Envelope | null {
    return this.inbox.shift() ?? null;
  }

  /**
   * Downloads a snapshot from the add-in (token in a header).
   * @param onProgress Called with 0..1 while it downloads.
   */
  async fetchSnapshot(url: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<Blob> {
    const response = await fetch(url, { headers: { [LiveProtocol.TOKEN_HEADER]: this.launch.token }, signal, cache: 'no-store' });
    if (!response.ok) { throw new Error(response.status === 404 ? 'That snapshot is no longer in Revit (press Go again).' : `Revit answered ${response.status}.`); }
    const total = Number(response.headers.get('Content-Length')) || 0;
    if (!response.body || total <= 0) { return response.blob(); }

    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { break; }
      parts.push(value);
      received += value.length;
      onProgress(Math.min(received / total, 1));
    }
    return new Blob(parts as BlobPart[]);
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') { return; }
    let envelope: Envelope;
    try {
      const j = obj(JSON.parse(data));
      envelope = {
        protocol: typeof j.protocol === 'number' ? j.protocol : 1,
        id: String(j.id ?? ''),
        seq: typeof j.seq === 'number' ? j.seq : 0,
        sessionId: String(j.sessionId ?? ''),
        type: String(j.type ?? ''),
        replyTo: typeof j.replyTo === 'string' ? j.replyTo : undefined,
        sentUtc: String(j.sentUtc ?? ''),
        payload: obj(j.payload)
      };
    } catch {
      console.warn('Unreadable live message ignored.');
      return;
    }
    if (!envelope.type || envelope.sessionId.toLowerCase() !== this.launch.sessionId || envelope.protocol > LiveProtocol.VERSION) { return; }

    const waiter = envelope.replyTo ? this.waiting.get(envelope.replyTo) : undefined;
    if (waiter && envelope.replyTo) {
      window.clearTimeout(waiter.timer);
      this.waiting.delete(envelope.replyTo);
      waiter.resolve(envelope);
      return;
    }
    this.inbox.push(envelope);
  }

  private failWaiting(reason: string): void {
    for (const [id, waiter] of this.waiting) {
      window.clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
      this.waiting.delete(id);
    }
  }
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
