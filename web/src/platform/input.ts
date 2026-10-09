/**
 * Keyboard and mouse state for one frame (port of BimGo.App/Platform/InputState.cs).
 *
 * Keys are Win32 virtual-key codes so ported code reads the same as the desktop (input.isPressed(Vk.O)); browser
 * KeyboardEvent.code values are mapped onto them by {@link vkFromCode}, which is layout-independent like the
 * desktop's scan-code-driven bindings.
 */
export class InputState {
  private readonly down = new Array<boolean>(256).fill(false);
  private readonly pressed = new Array<boolean>(256).fill(false);
  private readonly repeated = new Array<boolean>(256).fill(false);
  private chars = '';

  /** Raw mouse movement this frame (device pixels, Pointer Lock). */
  mouseDeltaX = 0;
  mouseDeltaY = 0;
  /** Wheel notches this frame (positive = away from the user). */
  wheel = 0;
  /** Cursor position in canvas device pixels. */
  mouseX = 0;
  mouseY = 0;

  leftDown = false;
  rightDown = false;
  leftPressed = false;
  rightPressed = false;
  leftReleased = false;

  /** Characters typed this frame (text entry). */
  get typed(): string {
    return this.chars;
  }

  isDown(vk: number): boolean {
    return vk >= 0 && vk < 256 && this.down[vk];
  }

  isPressed(vk: number): boolean {
    return vk >= 0 && vk < 256 && this.pressed[vk];
  }

  isPressedOrRepeated(vk: number): boolean {
    return vk >= 0 && vk < 256 && (this.pressed[vk] || this.repeated[vk]);
  }

  // #region Event handlers

  onKey(vk: number, isDown: boolean, wasDown: boolean): void {
    if (vk < 0 || vk >= 256) { return; }
    if (isDown) {
      if (!wasDown) { this.pressed[vk] = true; }
      else { this.repeated[vk] = true; }
    }
    this.down[vk] = isDown;
  }

  onChar(c: string): void {
    if (this.chars.length < 64) { this.chars += c; }
  }

  onRawMouse(dx: number, dy: number): void {
    this.mouseDeltaX += dx;
    this.mouseDeltaY += dy;
  }

  onMouseMove(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
  }

  onWheel(notches: number): void {
    this.wheel += notches;
  }

  onLeft(isDown: boolean): void {
    if (isDown && !this.leftDown) { this.leftPressed = true; }
    if (!isDown && this.leftDown) { this.leftReleased = true; }
    this.leftDown = isDown;
  }

  onRight(isDown: boolean): void {
    if (isDown && !this.rightDown) { this.rightPressed = true; }
    this.rightDown = isDown;
  }

  // #endregion

  /** Clears the per-frame edges. */
  endFrame(): void {
    this.pressed.fill(false);
    this.repeated.fill(false);
    this.mouseDeltaX = this.mouseDeltaY = 0;
    this.wheel = 0;
    this.leftPressed = this.rightPressed = this.leftReleased = false;
    this.chars = '';
  }

  /** Releases everything (focus lost, dialogs). */
  releaseAll(): void {
    this.down.fill(false);
    this.leftDown = this.rightDown = false;
    this.endFrame();
  }

  /** Swallows this frame's clicks so one click doesn't hit two controls. */
  consumeClicks(): void {
    this.leftPressed = this.rightPressed = this.leftReleased = false;
  }
}

/** Win32 virtual-key codes used by the app. Letters and digits are their ASCII codes ('A' = 65, '0' = 48). */
export const Vk = {
  BACK: 0x08, TAB: 0x09, RETURN: 0x0d, SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, PAUSE: 0x13, ESCAPE: 0x1b,
  SPACE: 0x20, PRIOR: 0x21, NEXT: 0x22, END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  INSERT: 0x2d, DELETE: 0x2e,
  NUMPAD0: 0x60, MULTIPLY: 0x6a, ADD: 0x6b, SUBTRACT: 0x6d, DECIMAL: 0x6e, DIVIDE: 0x6f,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
  LSHIFT: 0xa0, RSHIFT: 0xa1, LCONTROL: 0xa2, RCONTROL: 0xa3, LMENU: 0xa4, RMENU: 0xa5,
  OEM_1: 0xba, OEM_PLUS: 0xbb, OEM_COMMA: 0xbc, OEM_MINUS: 0xbd, OEM_PERIOD: 0xbe, OEM_2: 0xbf, OEM_3: 0xc0,
  OEM_4: 0xdb, OEM_5: 0xdc, OEM_6: 0xdd, OEM_7: 0xde,
  /** The virtual-key code of a letter or digit. */
  key(c: string): number {
    return c.toUpperCase().charCodeAt(0);
  }
} as const;

const CODE_MAP: Record<string, number> = {
  Backspace: Vk.BACK, Tab: Vk.TAB, Enter: Vk.RETURN, NumpadEnter: Vk.RETURN, Pause: Vk.PAUSE, Escape: Vk.ESCAPE,
  Space: Vk.SPACE, PageUp: Vk.PRIOR, PageDown: Vk.NEXT, End: Vk.END, Home: Vk.HOME,
  ArrowLeft: Vk.LEFT, ArrowUp: Vk.UP, ArrowRight: Vk.RIGHT, ArrowDown: Vk.DOWN, Insert: Vk.INSERT, Delete: Vk.DELETE,
  NumpadMultiply: Vk.MULTIPLY, NumpadAdd: Vk.ADD, NumpadSubtract: Vk.SUBTRACT, NumpadDecimal: Vk.DECIMAL, NumpadDivide: Vk.DIVIDE,
  ShiftLeft: Vk.LSHIFT, ShiftRight: Vk.RSHIFT, ControlLeft: Vk.LCONTROL, ControlRight: Vk.RCONTROL, AltLeft: Vk.LMENU, AltRight: Vk.RMENU,
  Semicolon: Vk.OEM_1, Equal: Vk.OEM_PLUS, Comma: Vk.OEM_COMMA, Minus: Vk.OEM_MINUS, Period: Vk.OEM_PERIOD, Slash: Vk.OEM_2,
  Backquote: Vk.OEM_3, BracketLeft: Vk.OEM_4, Backslash: Vk.OEM_5, BracketRight: Vk.OEM_6, Quote: Vk.OEM_7
};

/**
 * Maps a KeyboardEvent.code to a virtual-key code, or -1 when BimGo has no use for the key.
 */
export function vkFromCode(code: string): number {
  if (code.length === 4 && code.startsWith('Key')) { return code.charCodeAt(3); }
  if (code.length === 6 && code.startsWith('Digit')) { return code.charCodeAt(5); }
  if (code.length === 7 && code.startsWith('Numpad')) {
    const n = code.charCodeAt(6) - 48;
    if (n >= 0 && n <= 9) { return Vk.NUMPAD0 + n; }
  }
  if (/^F([1-9]|1[0-2])$/.test(code)) { return Vk.F1 + Number(code.slice(1)) - 1; }
  return CODE_MAP[code] ?? -1;
}

/** The generic modifier a left / right modifier also sets (the desktop's GetKeyState(VK_SHIFT) etc.). */
export function genericModifier(vk: number): number {
  switch (vk) {
    case Vk.LSHIFT: case Vk.RSHIFT: return Vk.SHIFT;
    case Vk.LCONTROL: case Vk.RCONTROL: return Vk.CONTROL;
    case Vk.LMENU: case Vk.RMENU: return Vk.MENU;
    default: return -1;
  }
}

/**
 * True when the browser's default for this key must be blocked (it would reload, open help, move focus, save the
 * page…). F12 (DevTools) and the browser's own tab / window shortcuts are left alone.
 */
export function blocksBrowserDefault(vk: number, ctrl: boolean, alt: boolean): boolean {
  if (vk === Vk.F12) { return false; }
  if (vk >= Vk.F1 && vk <= Vk.F11) { return true; }
  switch (vk) {
    case Vk.TAB: case Vk.SPACE: case Vk.BACK: case Vk.PRIOR: case Vk.NEXT: case Vk.END: case Vk.HOME:
    case Vk.LEFT: case Vk.UP: case Vk.RIGHT: case Vk.DOWN: case Vk.LMENU: case Vk.RMENU:
      return true;
  }
  if (ctrl && (vk === Vk.key('S') || vk === Vk.key('O') || vk === Vk.key('F'))) { return true; } // Ctrl+F: find room
  if (alt && vk >= 0x31 && vk <= 0x39) { return true; } // Alt+1–9: bookmarks
  return false;
}
