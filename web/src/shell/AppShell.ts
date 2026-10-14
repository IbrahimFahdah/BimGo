import { type BimGoDocument, BimGoReadError, BimGoReader } from '../core/format/BimGoReader';
import { readBookmarkDocument, readCommentDocument, readSunSettings, readVisibility } from '../core/format/DocumentModels';
import { LiveClient, LiveConnectError } from '../core/live/LiveClient';
import { type LaunchInfo, MessageTypes, readHelloAck, readLaunch } from '../core/live/LiveProtocol';
import { LiveSessionSource } from '../core/sources/LiveSessionSource';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import { GameSession, type SessionPose } from '../game/GameSession';
import { drawProgress, type ProgressState } from '../game/ProgressScreen';
import { ViewerSettings } from '../game/ViewerSettings';
import { PadCursorMode, PadInput } from '../platform/gamepad';
import { Hotkeys } from '../platform/Hotkeys';
import { Vk } from '../platform/input';
import { hasBimGoExtension, pickBimGoFile, type PickedFile } from '../platform/files';
import { GameWindow } from '../platform/window';
import { HomeScreen } from './HomeScreen';
import { LastLive, RecentFiles } from './RecentFiles';

/** A long operation shown on the progress screen. */
interface Loading {
  title: string;
  progress: ProgressState;
  abort: AbortController;
}

/**
 * The app: one canvas that alternates between the home screen and walkthroughs (port of BimGo.App/Shell/AppShell.cs,
 * turned inside out for the browser: requestAnimationFrame drives frames instead of a message-pump loop, and file
 * reads are asynchronous with the progress screen drawn meanwhile).
 */
export class AppShell {
  private readonly window: GameWindow;
  private readonly ui = new UiBatch();
  private readonly recent = RecentFiles.load();
  private readonly settings = ViewerSettings.load();
  private readonly home: HomeScreen;
  private browsing = false;
  private loading: Loading | null = null;
  session: GameSession | null = null;
  private previous = 0;

  constructor(canvas: HTMLCanvasElement, private readonly version: string) {
    this.window = new GameWindow(canvas);
    this.ui.initialise(this.window.dpiScale);
    this.home = new HomeScreen(this.window, this.ui, this.recent, version);
    this.window.setTitle('BimGo');
    this.window.onCaptureLost = () => this.session?.onCaptureLost();
    Hotkeys.read(this.settings);
    PadInput.read(this.settings);
    Hotkeys.learnLayout();
    // Dev server only (removed from builds): lets automated browser checks drive the app
    if (import.meta.env.DEV) { (window as unknown as { __bimgo: unknown }).__bimgo = this; }
  }

  /** Starts the frame loop; opens ?model=<same-origin URL> when given (sample links, testing). */
  run(): void {
    const frame = (now: number) => {
      try {
        this.frame(now);
      } catch (e) {
        // A walkthrough that fails mid-frame goes back to the home screen with the reason, instead of a frozen canvas
        console.error(e);
        this.closeSession();
        this.home.setMessage(`The walkthrough stopped: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    void this.openFromUrl();
  }

  /**
   * Opens the live Revit session in ?live=…&session=…#token=… (Go in Revit), else the model named by ?model=, if it is
   * on this site (never another origin).
   */
  private async openFromUrl(): Promise<void> {
    const launch = this.readLaunch();
    if (launch) {
      this.openLive(launch, null);
      return;
    }
    const model = new URLSearchParams(location.search).get('model');
    if (!model) { return; }
    const url = new URL(model, location.href);
    if (url.origin !== location.origin) {
      this.home.setMessage('Models can only be opened from this site by link.', true);
      return;
    }
    const name = decodeURIComponent(url.pathname.split('/').pop() || 'model.bimgo');
    try {
      const response = await fetch(url);
      if (!response.ok) { throw new Error(`${response.status} ${response.statusText}`); }
      this.open({ file: new File([await response.blob()], name), handle: null });
    } catch (e) {
      this.home.setMessage(`Could not download ${name}: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /**
   * The live-session launch parameters. The token is moved out of the address bar (so it doesn't end up in bookmarks
   * or shared links) into this tab's session storage, where a reload of the tab still finds it.
   */
  private readLaunch(): LaunchInfo | null {
    const launch = readLaunch(location.search, location.hash);
    if (!launch) { return null; }
    const key = `bimgo-live-token:${launch.sessionId}`;
    try {
      if (launch.token) {
        sessionStorage.setItem(key, launch.token);
        history.replaceState(null, '', location.pathname + location.search);
      } else {
        launch.token = sessionStorage.getItem(key) ?? '';
      }
    } catch {
      // Storage blocked: the token stays in this page only
    }
    return launch;
  }

  /**
   * Connects to Revit (or reuses the connection on a reload), downloads the session's snapshot, loads the sidecars
   * kept beside the model, and starts the walkthrough. A reload puts the player back where they stood.
   */
  private openLive(launch: LaunchInfo | null, reload: { source: LiveSessionSource; pose: SessionPose } | null): void {
    const loading: Loading = {
      title: reload ? `Reloading ${reload.source.displayName} from Revit` : 'Connecting to Revit',
      progress: { stage: '', detail: '', fraction: 0, canCancel: true, cancelRequested: false },
      abort: new AbortController()
    };
    this.loading = loading;
    const signal = loading.abort.signal;
    const report = (stage: string, fraction: number, detail = '') => {
      loading.progress.stage = stage;
      loading.progress.detail = detail;
      loading.progress.fraction = fraction;
    };

    void (async () => {
      let source = reload?.source ?? null;
      let session: GameSession | null = null;
      try {
        if (!source) {
          if (!launch?.token) { throw new LiveConnectError('This link has no session key: press Go in Revit again.'); }
          const client = new LiveClient(launch);
          report('Connecting to Revit on this computer', 0, 'If the browser asks to access devices on your local network, allow it.');
          await client.connect();
          const ack = readHelloAck((await client.request(MessageTypes.HELLO, { appPid: 0, appVersion: `BimGo Web ${this.version}` })).payload);
          source = new LiveSessionSource(client, ack, ack.snapshotNumber, `BimGo Web ${this.version}`);
        }
        throwIfAborted(signal);

        const ready = reload ? source.snapshotReady : { snapshotNumber: source.hello.snapshotNumber, snapshotUrl: source.hello.snapshotUrl, elements: 0, triangles: 0, reason: 'go' };
        const url = source.snapshotUrl(ready);
        if (!ready || !url) {
          throw new LiveConnectError(source.hello.snapshotNumber === 0 ? 'Revit has no snapshot for this session yet: press Go in Revit.'
            : 'This BimGo add-in cannot serve the browser viewer: update it, then press Go again.');
        }
        loading.title = `Opening ${source.displayName} from Revit`;
        report('Downloading the snapshot from Revit', 0.02);
        const blob = await source.client.fetchSnapshot(url, f => report('Downloading the snapshot from Revit', 0.02 + 0.33 * f), signal);
        const document = await BimGoReader.read(blob, `${source.displayName}.bimgo`, { step: f => report('Reading the model', 0.35 + 0.3 * f), signal });
        source.snapshotNumber = ready.snapshotNumber;
        source.snapshotReady = null;
        source.modelChanges = 0;

        report('Reading comments and bookmarks beside the model', 0.66);
        await loadSidecars(source, document);
        throwIfAborted(signal);

        loading.title = `Preparing ${document.scene.modelTitle}`;
        session = new GameSession(this.window, this.ui, document, this.settings, null, source);
        await session.prepare((stage, f) => report(stage, 0.7 + 0.3 * f), signal);
        if (reload) { session.applyPose(reload.pose); }
        else { LastLive.save(source.displayName, source.hello.revitVersion); } // the start screen's "last live session" card
        this.startSession(session);
      } catch (e) {
        session?.dispose();
        source?.close();
        const cancelled = signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
        const reason = e instanceof Error ? e.message : String(e);
        if (!cancelled) { console.error(e); }
        this.home.setMessage(cancelled ? 'Cancelled.'
          : e instanceof LiveConnectError ? `Could not open the Revit session: ${reason} (Chrome or Edge, with Revit open and the session still running.)`
            : `The Revit session could not be loaded: ${reason}`, !cancelled);
        forgetLaunch();
      } finally {
        this.loading = null;
      }
    })();
  }

  private frame(now: number): void {
    const dt = this.previous === 0 ? 1 / 60 : Math.min((now - this.previous) / 1000, 0.1);
    this.previous = now;

    const window = this.window;
    window.syncSize();
    if (window.dpiScale !== this.ui.scale) { this.ui.rebuildAtlas(window.dpiScale); }

    // Files dropped while walking wait until the model is closed (as on the desktop); elsewhere they open
    const dropped = this.session || this.loading ? null : window.takeDroppedFile();
    if (dropped) { this.open({ file: dropped, handle: null }); }

    // The gamepad: polled once a frame; in menus and editors it drives the page's cursor (the session sets the mode)
    if (!this.session) { window.padCursor = PadCursorMode.Menu; }
    PadInput.poll(window.input, document.hasFocus());
    PadInput.driveCursor(window.input, window.padCursor, window.width, window.height, window.isCaptured, window.dpiScale);

    if (this.loading) {
      const input = window.input;
      const cancel = drawProgress(this.ui, window.width, window.height, this.loading.title, this.loading.progress, input);
      if (cancel || input.isPressed(Vk.ESCAPE)) {
        this.loading.progress.cancelRequested = true;
        this.loading.abort.abort();
      }
    } else if (this.session) {
      const end = this.session.frame(dt);
      if (end === 'closed') { this.closeSession(); }
      else if (end === 'reload') { this.reloadLive(); }
    } else if (!window.isMinimised) {
      const action = this.home.frame();
      if (action?.kind === 'browse') { this.browse(); }
      else if (action?.kind === 'sample') { void this.openSample(); }
    }
    // The gamepad's cursor over everything (the system cursor stays where the mouse left it)
    if (PadInput.cursorVisible) { drawPadCursor(this.ui, window.input.mouseX, window.input.mouseY, window.width, window.height); }
    window.input.endFrame();
  }

  /** The sample model shipped with the site (for visitors without a .bimgo yet). */
  private async openSample(): Promise<void> {
    if (this.loading) { return; }
    const name = 'BimGo Sample Pavilion.bimgo';
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}samples/${encodeURIComponent(name)}`);
      if (!response.ok) { throw new Error(`${response.status} ${response.statusText}`); }
      this.open({ file: new File([await response.blob()], name), handle: null });
    } catch (e) {
      this.home.setMessage(`Could not download the sample: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /** The Open dialog (one at a time). */
  private browse(): void {
    if (this.browsing) { return; }
    this.browsing = true;
    this.window.input.releaseAll();
    pickBimGoFile()
      .then(picked => { if (picked) { this.open(picked); } })
      .catch((e: unknown) => this.home.setMessage(`Could not open the file: ${String(e)}`, true))
      .finally(() => { this.browsing = false; });
  }

  /** Reads a file (progress screen, Esc cancels) and starts a walkthrough; failures go back to the home screen. */
  open(picked: PickedFile): void {
    const { file } = picked;
    if (!hasBimGoExtension(file.name)) {
      this.home.setMessage(`${file.name} is not a .bimgo file.`, true);
      return;
    }

    const loading: Loading = {
      title: `Opening ${file.name}`,
      progress: { stage: 'Reading the model', detail: '', fraction: 0, canCancel: true, cancelRequested: false },
      abort: new AbortController()
    };
    this.loading = loading;
    const signal = loading.abort.signal;
    const report = (stage: string, fraction: number) => {
      loading.progress.stage = stage;
      loading.progress.fraction = fraction;
    };

    void (async () => {
      let session: GameSession | null = null;
      try {
        const document = await BimGoReader.read(file, file.name, { step: f => report('Reading the model', f), signal });
        this.recent.touch(file.name, file.size, document.thumbnail);
        loading.title = `Preparing ${document.scene.modelTitle}`;
        session = new GameSession(this.window, this.ui, document, this.settings, picked.handle);
        await session.prepare(report, signal);
        this.startSession(session);
      } catch (e) {
        session?.dispose();
        const cancelled = signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
        const message = cancelled ? 'Cancelled.' : e instanceof BimGoReadError ? e.message : `Could not open the model: ${e instanceof Error ? e.message : String(e)}`;
        if (!cancelled) { console.error(e); }
        this.home.setMessage(`${file.name}: ${message}`, !cancelled);
      } finally {
        this.loading = null;
      }
    })();
  }

  /** A walkthrough is ready: it takes over the canvas (the start screen's thumbnails are freed). */
  private startSession(session: GameSession): void {
    session.onSaved = (name, size, thumbnail) => this.recent.touch(name, size, thumbnail);
    this.session = session;
    this.home.setMessage('', false);
    this.home.release();
  }

  /** A newer Revit snapshot is ready: reload it on the same connection, where the player stands. */
  private reloadLive(): void {
    const session = this.session!, source = session.live!;
    const pose = session.capturePose();
    session.dispose();
    this.session = null;
    this.openLive(null, { source, pose });
  }

  private closeSession(): void {
    const live = this.session?.live ?? null;
    this.session?.dispose();
    this.session = null;
    if (live) {
      live.close();
      forgetLaunch();
    }
    this.window.setTitle('BimGo');
    this.window.input.releaseAll();
  }
}

/** The gamepad's cursor: an arrow at the cursor position (its own small batch, drawn last). */
function drawPadCursor(ui: UiBatch, x: number, y: number, width: number, height: number): void {
  const s = ui.scale;
  ui.triangle(x - s, y - 2 * s, x - s, y + 20 * s, x + 15 * s, y + 14 * s, Rgba.hex(0x000000, 0.8));
  ui.triangle(x + s, y + 1 * s, x + s, y + 16 * s, x + 12 * s, y + 12 * s, Rgba.hex(0xffffff));
  ui.flush(width, height);
}

/** The sidecars kept beside the Revit model replace the snapshot's empty ones (comments, bookmarks, sun, visibility, clashes). */
async function loadSidecars(source: LiveSessionSource, document: BimGoDocument): Promise<void> {
  if (!source.hello.sidecars) { return; }
  const [comments, bookmarks, sun, visibility, clashes] = await Promise.all([
    source.readSidecar('comments'), source.readSidecar('bookmarks'), source.readSidecar('sun'), source.readSidecar('visibility'),
    source.readSidecar('clashes')
  ]);
  if (comments) { document.comments = readCommentDocument(comments); }
  if (bookmarks) { document.bookmarks = readBookmarkDocument(bookmarks); }
  if (sun) { document.sun = readSunSettings(sun); }
  if (visibility) { document.visibility = readVisibility(visibility); }
  // Clash detection reads its document only when switched on (Round C): kept as bytes until then
  if (clashes) { document.clashes = new TextEncoder().encode(JSON.stringify(clashes)); }
}

/** After a live session: a reload of the page opens the home screen, not the ended session. */
function forgetLaunch(): void {
  if (new URLSearchParams(location.search).has('live')) { history.replaceState(null, '', location.pathname); }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) { throw new DOMException('Cancelled.', 'AbortError'); }
}
