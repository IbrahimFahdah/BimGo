import { BimGoReadError, BimGoReader } from '../core/format/BimGoReader';
import { UiBatch } from '../engine/ui/UiBatch';
import { GameSession } from '../game/GameSession';
import { drawProgress, type ProgressState } from '../game/ProgressScreen';
import { ViewerSettings } from '../game/ViewerSettings';
import { Vk } from '../platform/input';
import { hasBimGoExtension, pickBimGoFile, type PickedFile } from '../platform/files';
import { GameWindow } from '../platform/window';
import { HomeScreen } from './HomeScreen';
import { RecentFiles } from './RecentFiles';

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

  constructor(canvas: HTMLCanvasElement, version: string) {
    this.window = new GameWindow(canvas);
    this.ui.initialise(this.window.dpiScale);
    this.home = new HomeScreen(this.window, this.ui, this.recent, version);
    this.window.setTitle('BimGo');
    this.window.onCaptureLost = () => this.session?.onCaptureLost();
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

  /** Opens the model named by ?model=, if it is on this site (never another origin). */
  private async openFromUrl(): Promise<void> {
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

  private frame(now: number): void {
    const dt = this.previous === 0 ? 1 / 60 : Math.min((now - this.previous) / 1000, 0.1);
    this.previous = now;

    const window = this.window;
    window.syncSize();
    if (window.dpiScale !== this.ui.scale) { this.ui.rebuildAtlas(window.dpiScale); }

    // Files dropped while walking wait until the model is closed (as on the desktop); elsewhere they open
    const dropped = this.session || this.loading ? null : window.takeDroppedFile();
    if (dropped) { this.open({ file: dropped, handle: null }); }

    if (this.loading) {
      const input = window.input;
      const cancel = drawProgress(this.ui, window.width, window.height, this.loading.title, this.loading.progress, input);
      if (cancel || input.isPressed(Vk.ESCAPE)) {
        this.loading.progress.cancelRequested = true;
        this.loading.abort.abort();
      }
    } else if (this.session) {
      if (this.session.frame(dt) === 'closed') { this.closeSession(); }
    } else if (!window.isMinimised) {
      const action = this.home.frame();
      if (action?.kind === 'browse') { this.browse(); }
    }
    window.input.endFrame();
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
        this.recent.touch(file.name, file.size);
        loading.title = `Preparing ${document.scene.modelTitle}`;
        session = new GameSession(this.window, this.ui, document, this.settings, picked.handle);
        await session.prepare(report, signal);
        this.session = session;
        this.home.setMessage('', false);
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

  private closeSession(): void {
    this.session?.dispose();
    this.session = null;
    this.window.setTitle('BimGo');
    this.window.input.releaseAll();
  }
}
