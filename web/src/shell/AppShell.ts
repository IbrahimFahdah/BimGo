import { UiBatch } from '../engine/ui/UiBatch';
import { formatSize, hasBimGoExtension, pickBimGoFile, type PickedFile } from '../platform/files';
import { GameWindow } from '../platform/window';
import { HomeScreen } from './HomeScreen';
import { RecentFiles } from './RecentFiles';

/**
 * The app: one canvas that shows the home screen and (from Phase 1) walkthroughs. Port of the desktop
 * BimGo.App/Shell/AppShell.cs, turned inside out for the browser: requestAnimationFrame drives frames instead of a
 * message-pump loop, and file dialogs are asynchronous.
 */
export class AppShell {
  private readonly window: GameWindow;
  private readonly ui = new UiBatch();
  private readonly recent = RecentFiles.load();
  private readonly home: HomeScreen;
  private browsing = false;

  constructor(canvas: HTMLCanvasElement, version: string) {
    this.window = new GameWindow(canvas);
    this.ui.initialise(this.window.dpiScale);
    this.home = new HomeScreen(this.window, this.ui, this.recent, version);
    this.window.setTitle('BimGo');
  }

  /** Starts the frame loop. */
  run(): void {
    const frame = () => {
      this.frame();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private frame(): void {
    const window = this.window;
    window.syncSize();
    if (window.dpiScale !== this.ui.scale) { this.ui.rebuildAtlas(window.dpiScale); }

    const dropped = window.takeDroppedFile();
    if (dropped) { this.open({ file: dropped, handle: null }); }

    if (!window.isMinimised) {
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

  /**
   * Opens a file. Phase 0 only checks and remembers it; reading .bimgo files arrives with Phase 1.
   */
  private open(picked: PickedFile): void {
    const { file } = picked;
    if (!hasBimGoExtension(file.name)) {
      this.home.setMessage(`${file.name} is not a .bimgo file.`, true);
      return;
    }
    this.recent.touch(file.name, file.size);
    this.home.setMessage(`${file.name} (${formatSize(file.size)}) is ready. Walking a model in the browser arrives with the next build.`, false);
  }
}
