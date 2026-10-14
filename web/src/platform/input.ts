import type { InputAction } from '../core/scene/InputCatalog';
import { KeyCodes, type KeyState } from '../core/scene/KeyChord';
import { KeyMap } from '../core/scene/KeyMap';
import { Hotkeys } from './Hotkeys';

/**
 * Keyboard, mouse and gamepad state for one frame (port of BimGo.App/Platform/InputState.cs).
 *
 * Keys are Win32 virtual-key codes so ported code reads the same as the desktop; browser KeyboardEvent.code values are
 * mapped onto them by {@link vkFromCode}, which is layout-independent like the desktop's bindings. Input round B2:
 * game code asks for actions ({@link InputState.pressed}, {@link InputState.down}), which the key map resolves to keys;
 * raw keys ({@link InputState.isPressed}) are left for text boxes. Mouse buttons live in the key arrays under their
 * virtual-key codes (LMB 1, RMB 2, MMB 4, Mouse 4 / 5 = 5 / 6), the wheel reads as two codes of its own, the gamepad
 * as codes from 0x200.
 */
export class InputState implements KeyState {
  private readonly downKeys = new Array<boolean>(256).fill(false);
  private readonly pressedKeys = new Array<boolean>(256).fill(false);
  private readonly repeatedKeys = new Array<boolean>(256).fill(false);
  private chars = '';
  private pastedText = '';
  private released = false;

  // Gamepad: digital state, edges, auto-repeat and analog amount per gamepad code (gamepad.ts fills them)
  private readonly padDown = new Array<boolean>(KeyCodes.PAD_COUNT).fill(false);
  private readonly padPressed = new Array<boolean>(KeyCodes.PAD_COUNT).fill(false);
  private readonly padRepeated = new Array<boolean>(KeyCodes.PAD_COUNT).fill(false);
  private readonly padAnalog = new Float32Array(KeyCodes.PAD_COUNT);
  private readonly padRepeatAt = new Float32Array(KeyCodes.PAD_COUNT);
  private readonly padHeld = new Float32Array(KeyCodes.PAD_COUNT);
  private injectingClick = false;

  /** Gamepad held this long starts auto-repeating; then every interval. */
  private static readonly PAD_REPEAT_DELAY = 0.4;
  private static readonly PAD_REPEAT_INTERVAL = 0.1;

  /** Raw mouse movement this frame (device pixels, Pointer Lock). */
  mouseDeltaX = 0;
  mouseDeltaY = 0;
  /** Wheel notches this frame (positive = away from the user). */
  wheel = 0;
  /** Cursor position in canvas device pixels. */
  mouseX = 0;
  mouseY = 0;

  /** A gamepad is connected. */
  padConnected = false;
  /** The gamepad's sticks after the dead zone (x right, y up; length 0–1). */
  padLeftX = 0;
  padLeftY = 0;
  padRightX = 0;
  padRightY = 0;
  /** The last thing used was the gamepad (hints show gamepad buttons then). */
  lastInputWasPad = false;

  get leftDown(): boolean { return this.downKeys[KeyCodes.LEFT_MOUSE]; }
  get rightDown(): boolean { return this.downKeys[KeyCodes.RIGHT_MOUSE]; }
  get leftPressed(): boolean { return this.pressedKeys[KeyCodes.LEFT_MOUSE]; }
  get rightPressed(): boolean { return this.pressedKeys[KeyCodes.RIGHT_MOUSE]; }
  get leftReleased(): boolean { return this.released; }

  /** Characters typed this frame (text entry). */
  get typed(): string {
    return this.chars;
  }

  /** Text pasted this frame (Ctrl+V), or empty. */
  get pasted(): string {
    return this.pastedText;
  }

  /** Key held (raw virtual-key code: text boxes and the key capture only). */
  isDown(vk: number): boolean {
    return vk >= 0 && vk < 256 && this.downKeys[vk];
  }

  /** Key pressed this frame, no auto-repeat (raw: text boxes and the key capture only). */
  isPressed(vk: number): boolean {
    return vk >= 0 && vk < 256 && this.pressedKeys[vk];
  }

  isPressedOrRepeated(vk: number): boolean {
    return vk >= 0 && vk < 256 && (this.pressedKeys[vk] || this.repeatedKeys[vk]);
  }

  // #region Actions (input round B2)

  /** The action fired this frame (one of its keys went down; see KeyMap for modifiers). */
  pressed(action: InputAction): boolean {
    return Hotkeys.map.pressed(action, this);
  }

  /** The action fired this frame or its key auto-repeated (stepping keys). */
  pressedOrRepeated(action: InputAction): boolean {
    return Hotkeys.map.pressedOrRepeated(action, this);
  }

  /** One of the action's keys is held (with its modifiers). */
  down(action: InputAction): boolean {
    return Hotkeys.map.down(action, this);
  }

  /** How far the action is held, 0–1 (gamepad sticks and triggers in between; keys 0 or 1). */
  axis(action: InputAction): number {
    return Hotkeys.map.axis(action, this);
  }

  /** The action fired this frame from its gamepad binding. */
  pressedByPad(action: InputAction): boolean {
    return Hotkeys.map.pressedSlot(action, this) === KeyMap.PAD_SLOT;
  }

  isKeyDown(code: number): boolean {
    if (code < 256) { return code >= 0 && this.downKeys[code]; }
    if (KeyCodes.isPad(code)) { return this.padDown[code - KeyCodes.GAMEPAD_FIRST]; }
    return code === KeyCodes.WHEEL_UP ? this.wheel > 0 : code === KeyCodes.WHEEL_DOWN && this.wheel < 0;
  }

  isKeyPressed(code: number): boolean {
    if (code < 256) { return code >= 0 && this.pressedKeys[code]; }
    if (KeyCodes.isPad(code)) { return this.padPressed[code - KeyCodes.GAMEPAD_FIRST]; }
    return code === KeyCodes.WHEEL_UP ? this.wheel > 0 : code === KeyCodes.WHEEL_DOWN && this.wheel < 0;
  }

  isKeyRepeated(code: number): boolean {
    if (code < 256) { return code >= 0 && this.repeatedKeys[code]; }
    return KeyCodes.isPad(code) && this.padRepeated[code - KeyCodes.GAMEPAD_FIRST];
  }

  keyAnalog(code: number): number {
    if (code < 256) { return code >= 0 && this.downKeys[code] ? 1 : 0; }
    if (KeyCodes.isPad(code)) { return this.padAnalog[code - KeyCodes.GAMEPAD_FIRST]; }
    return this.isKeyPressed(code) ? 1 : 0;
  }

  // #endregion

  // #region Event handlers

  onKey(vk: number, isDown: boolean, wasDown: boolean): void {
    if (vk < 0 || vk >= 256) { return; }
    if (isDown) {
      this.lastInputWasPad = false;
      if (!wasDown) { this.pressedKeys[vk] = true; }
      else { this.repeatedKeys[vk] = true; }
    }
    this.downKeys[vk] = isDown;
  }

  onChar(c: string): void {
    if (this.chars.length < 64) { this.chars += c; }
  }

  onPaste(text: string): void {
    this.pastedText = text.slice(0, 1024);
  }

  onRawMouse(dx: number, dy: number): void {
    if (Math.abs(dx) + Math.abs(dy) > 2) { this.lastInputWasPad = false; }
    this.mouseDeltaX += dx;
    this.mouseDeltaY += dy;
  }

  onMouseMove(x: number, y: number): void {
    if (Math.abs(x - this.mouseX) + Math.abs(y - this.mouseY) > 2) { this.lastInputWasPad = false; }
    this.mouseX = x;
    this.mouseY = y;
  }

  /** The gamepad's cursor moved (menus, editors): no switch to mouse hints. */
  movePadCursor(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
  }

  onWheel(notches: number): void {
    this.wheel += notches;
  }

  onLeft(isDown: boolean): void {
    if (!isDown && this.downKeys[KeyCodes.LEFT_MOUSE]) { this.released = true; }
    this.onButton(KeyCodes.LEFT_MOUSE, isDown);
  }

  onRight(isDown: boolean): void {
    this.onButton(KeyCodes.RIGHT_MOUSE, isDown);
  }

  /** A mouse button (LMB, RMB, MMB, Mouse 4, Mouse 5 by virtual-key code) went down or up. */
  onButton(code: number, isDown: boolean): void {
    if (code < 0 || code >= 256) { return; }
    if (isDown && !this.injectingClick) { this.lastInputWasPad = false; }
    if (isDown && !this.downKeys[code]) { this.pressedKeys[code] = true; }
    this.downKeys[code] = isDown;
  }

  // #endregion

  // #region Gamepad

  /**
   * This frame's gamepad: per gamepad code whether it is down and how far (0–1), and the dead-zoned sticks. Works out
   * the edges and the auto-repeat.
   */
  setPad(connected: boolean, down: ArrayLike<boolean>, analog: ArrayLike<number>, lx: number, ly: number, rx: number, ry: number, dt: number): void {
    this.padConnected = connected;
    this.padLeftX = lx;
    this.padLeftY = ly;
    this.padRightX = rx;
    this.padRightY = ry;
    let any = false;
    for (let i = 0; i < KeyCodes.PAD_COUNT; i++) {
      const now = down[i];
      this.padAnalog[i] = analog[i];
      if (now && !this.padDown[i]) {
        this.padPressed[i] = true;
        this.padHeld[i] = 0;
        this.padRepeatAt[i] = InputState.PAD_REPEAT_DELAY;
        any = true;
      } else if (now) {
        this.padHeld[i] += dt;
        if (this.padHeld[i] >= this.padRepeatAt[i]) {
          this.padRepeated[i] = true;
          this.padRepeatAt[i] += InputState.PAD_REPEAT_INTERVAL;
        }
      }
      this.padDown[i] = now;
    }
    if (any || lx * lx + ly * ly > 0.25 || rx * rx + ry * ry > 0.25) { this.lastInputWasPad = true; }
  }

  /** The gamepad's click (A in menus) as the left button, without counting as mouse use. */
  injectLeft(isDown: boolean): void {
    this.injectingClick = true;
    this.onLeft(isDown);
    this.injectingClick = false;
  }

  /** The gamepad's back (B in menus): an Esc press and the Esc character text boxes read. */
  injectEscape(): void {
    this.pressedKeys[KeyCodes.ESCAPE] = true;
    this.onChar('\u001b');
  }

  // #endregion

  /** Clears the per-frame edges. */
  endFrame(): void {
    this.pressedKeys.fill(false);
    this.repeatedKeys.fill(false);
    this.padPressed.fill(false);
    this.padRepeated.fill(false);
    this.mouseDeltaX = this.mouseDeltaY = 0;
    this.wheel = 0;
    this.released = false;
    this.chars = '';
    this.pastedText = '';
  }

  /** Releases everything (focus lost, dialogs). The gamepad is polled, so its held state stays (Start would repeat). */
  releaseAll(): void {
    this.downKeys.fill(false);
    this.endFrame();
  }

  /** Consumes everything this frame's keys, buttons, wheel and typing did (after a key capture took one). */
  consumeFrame(): void {
    this.pressedKeys.fill(false);
    this.repeatedKeys.fill(false);
    this.padPressed.fill(false);
    this.padRepeated.fill(false);
    this.wheel = 0;
    this.released = false;
    this.chars = '';
    this.pastedText = '';
  }

  /** Consumes the wheel so nothing else scrolls this frame (an open dropdown took it). */
  consumeWheel(): void {
    this.wheel = 0;
  }

  /** Swallows this frame's clicks so one click doesn't hit two controls. */
  consumeClicks(): void {
    for (const code of [KeyCodes.LEFT_MOUSE, KeyCodes.RIGHT_MOUSE, KeyCodes.MIDDLE_MOUSE, KeyCodes.MOUSE4, KeyCodes.MOUSE5]) { this.pressedKeys[code] = false; }
    this.released = false;
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
  // Ctrl+letters the browser would act on (save, open, find, print, select all, history…) go to the page: any of them
  // may be bound. Copy / cut / paste stay the browser's (text boxes read the paste); reload too (CONTROLS refuses it,
  // like Ctrl+W / T / N, which never reach a page)
  if (ctrl && vk >= 0x41 && vk <= 0x5a) { return !'CVXR'.includes(String.fromCharCode(vk)); }
  if (ctrl && (vk === Vk.OEM_4 || vk === Vk.OEM_6 || vk === Vk.OEM_PLUS || vk === Vk.OEM_MINUS)) { return true; }
  // Alt: the browser's menus and back / forward
  if (alt && ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5a) || vk === Vk.LEFT || vk === Vk.RIGHT)) { return true; }
  return false;
}
