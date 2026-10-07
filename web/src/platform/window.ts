import { blocksBrowserDefault, genericModifier, InputState, vkFromCode } from './input';

/**
 * The browser stand-in for BimGo.App/Platform/GameWindow.cs: a full-page canvas sized in device pixels, keyboard and
 * mouse routed into an {@link InputState}, Pointer Lock for mouse look, and files dropped on the page.
 */
export class GameWindow {
  readonly input = new InputState();
  private readonly dropped: File[] = [];
  private readonly resizeObserver: ResizeObserver;
  private _width = 1;
  private _height = 1;
  private _dpiScale = 1;

  /** Called when Pointer Lock ends without {@link setCaptured}(false): Esc, focus loss (opens the pause menu). */
  onCaptureLost: (() => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.resizeObserver = new ResizeObserver(entries => this.onResize(entries[entries.length - 1]));
    try {
      this.resizeObserver.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      this.resizeObserver.observe(canvas);
    }
    this.measure(canvas.clientWidth * devicePixelRatio, canvas.clientHeight * devicePixelRatio);
    this.hookInput();
    this.hookDrop();
  }

  /** Drawable width in device pixels. */
  get width(): number { return this._width; }
  /** Drawable height in device pixels. */
  get height(): number { return this._height; }
  /** UI scale: the device pixel ratio (the desktop uses DPI / 96). */
  get dpiScale(): number { return this._dpiScale; }
  /** True while the mouse is captured for mouse look. */
  get isCaptured(): boolean { return document.pointerLockElement === this.canvas; }
  /** True while the page is hidden (minimised or a background tab). */
  get isMinimised(): boolean { return document.hidden; }

  /** Sets the page title. */
  setTitle(title: string): void {
    document.title = title;
  }

  /**
   * Captures or releases the mouse. Capturing needs a recent user gesture (a click or key press), and Chrome refuses
   * for about a second after the user pressed Esc; a refused request is ignored and the next click tries again.
   */
  setCaptured(captured: boolean): void {
    if (captured && !this.isCaptured) {
      Promise.resolve(this.canvas.requestPointerLock()).catch(() => { /* refused: retried on the next click */ });
    } else if (!captured && this.isCaptured) {
      this.releasing = true;
      document.exitPointerLock();
    }
  }

  private releasing = false;

  /** Takes the oldest file dropped on the page, if any. */
  takeDroppedFile(): File | null {
    return this.dropped.shift() ?? null;
  }

  // #region Size

  private onResize(entry: ResizeObserverEntry): void {
    const box = entry.devicePixelContentBoxSize?.[0];
    if (box) { this.measure(box.inlineSize, box.blockSize); }
    else { this.measure(entry.contentRect.width * devicePixelRatio, entry.contentRect.height * devicePixelRatio); }
  }

  private measure(width: number, height: number): void {
    this._width = Math.max(1, Math.round(width));
    this._height = Math.max(1, Math.round(height));
    this._dpiScale = devicePixelRatio || 1;
  }

  /** Applies the measured size to the drawing buffer; call at the start of each frame. */
  syncSize(): void {
    if (this.canvas.width !== this._width) { this.canvas.width = this._width; }
    if (this.canvas.height !== this._height) { this.canvas.height = this._height; }
  }

  // #endregion

  // #region Input

  private hookInput(): void {
    const input = this.input;

    window.addEventListener('keydown', e => {
      const vk = vkFromCode(e.code);
      if (blocksBrowserDefault(vk, e.ctrlKey, e.altKey)) { e.preventDefault(); }
      if (vk >= 0) {
        input.onKey(vk, true, e.repeat);
        const generic = genericModifier(vk);
        if (generic >= 0) { input.onKey(generic, true, e.repeat); }
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { input.onChar(e.key); }
    });
    window.addEventListener('keyup', e => {
      const vk = vkFromCode(e.code);
      if (vk >= 0) {
        input.onKey(vk, false, true);
        const generic = genericModifier(vk);
        if (generic >= 0) { input.onKey(generic, false, true); }
      }
    });
    window.addEventListener('blur', () => input.releaseAll());

    const toCanvas = (e: MouseEvent): [number, number] => {
      const r = this.canvas.getBoundingClientRect();
      const sx = this._width / Math.max(1, r.width), sy = this._height / Math.max(1, r.height);
      return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
    };

    window.addEventListener('mousemove', e => {
      if (this.isCaptured) {
        input.onRawMouse(e.movementX * this._dpiScale, e.movementY * this._dpiScale);
      } else {
        const [x, y] = toCanvas(e);
        input.onMouseMove(x, y);
      }
    });
    this.canvas.addEventListener('mousedown', e => {
      this.canvas.focus();
      if (e.button === 0) { input.onLeft(true); }
      else if (e.button === 2) { input.onRight(true); }
    });
    window.addEventListener('mouseup', e => {
      if (e.button === 0) { input.onLeft(false); }
      else if (e.button === 2) { input.onRight(false); }
    });
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.deltaY !== 0) { input.onWheel(-Math.sign(e.deltaY)); }
    }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      if (this.isCaptured) { return; }
      if (this.releasing) { this.releasing = false; return; }
      input.releaseAll();
      this.onCaptureLost?.();
    });
  }

  private hookDrop(): void {
    window.addEventListener('dragover', e => {
      e.preventDefault();
      if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
    });
    window.addEventListener('drop', e => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) { this.dropped.push(files[0]); }
    });
  }

  // #endregion
}
