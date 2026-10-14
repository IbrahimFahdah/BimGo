/**
 * Key codes, modifiers and chords (port of BimGo.Core/Scene/KeyChord.cs, input round B2). Keyboard keys and mouse
 * buttons are Windows virtual-key codes (the browser's KeyboardEvent.code is mapped onto them by platform/input.ts), so
 * stored bindings read the same on the desktop and in the browser.
 */

/** Modifier keys a binding needs held (flags). */
export const KeyModifiers = {
  None: 0,
  Shift: 1,
  Ctrl: 2,
  Alt: 4,
  /** Gamepad left shoulder held (LB + D-pad and other gamepad combinations). */
  PadLB: 8,
  /** Gamepad right shoulder held. */
  PadRB: 16
} as const;
export type KeyModifiers = number;

/** Input codes a binding can use. */
export const KeyCodes = {
  NONE: 0,
  LEFT_MOUSE: 0x01, RIGHT_MOUSE: 0x02, MIDDLE_MOUSE: 0x04, MOUSE4: 0x05, MOUSE5: 0x06,
  BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0d, SHIFT: 0x10, CTRL: 0x11, ALT: 0x12,
  PAUSE: 0x13, CAPS_LOCK: 0x14, ESCAPE: 0x1b, SPACE: 0x20,
  PAGE_UP: 0x21, PAGE_DOWN: 0x22, END: 0x23, HOME: 0x24,
  LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  PRINT_SCREEN: 0x2c, INSERT: 0x2d, DELETE: 0x2e,
  D0: 0x30, A: 0x41,
  LEFT_WIN: 0x5b, RIGHT_WIN: 0x5c, APPS: 0x5d,
  NUM0: 0x60, NUM_MULTIPLY: 0x6a, NUM_ADD: 0x6b, NUM_SUBTRACT: 0x6d, NUM_DECIMAL: 0x6e, NUM_DIVIDE: 0x6f,
  F1: 0x70, F4: 0x73, F12: 0x7b, F24: 0x87,
  NUM_LOCK: 0x90, SCROLL_LOCK: 0x91,
  OEM_1: 0xba, OEM_PLUS: 0xbb, OEM_COMMA: 0xbc, OEM_MINUS: 0xbd, OEM_PERIOD: 0xbe, OEM_2: 0xbf,
  OEM_3: 0xc0, OEM_4: 0xdb, OEM_5: 0xdc, OEM_6: 0xdd, OEM_7: 0xde, OEM_102: 0xe2,
  /** Mouse wheel notches (one press per frame with a notch). */
  WHEEL_UP: 0x100, WHEEL_DOWN: 0x101,
  /** First gamepad code. */
  GAMEPAD_FIRST: 0x200,
  PAD_A: 0x200, PAD_B: 0x201, PAD_X: 0x202, PAD_Y: 0x203, PAD_LB: 0x204, PAD_RB: 0x205,
  PAD_BACK: 0x206, PAD_START: 0x207, PAD_LS: 0x208, PAD_RS: 0x209,
  PAD_UP: 0x20a, PAD_DOWN: 0x20b, PAD_LEFT: 0x20c, PAD_RIGHT: 0x20d, PAD_LT: 0x20e, PAD_RT: 0x20f,
  PAD_LS_UP: 0x210, PAD_LS_DOWN: 0x211, PAD_LS_LEFT: 0x212, PAD_LS_RIGHT: 0x213,
  PAD_RS_UP: 0x214, PAD_RS_DOWN: 0x215, PAD_RS_LEFT: 0x216, PAD_RS_RIGHT: 0x217,
  /** Number of gamepad codes (from GAMEPAD_FIRST). */
  PAD_COUNT: 24,
  /** Size of per-code state arrays. */
  CODE_COUNT: 0x218,
  KEYBOARD_MODIFIERS: 1 | 2 | 4,
  PAD_MODIFIERS: 8 | 16,

  isPad(code: number): boolean { return code >= 0x200 && code < 0x200 + 24; },
  isPadStick(code: number): boolean { return code >= 0x210 && code <= 0x217; },
  digit(n: number): number { return 0x30 + n; },
  letter(c: string): number { return c.toUpperCase().charCodeAt(0); },
  isModifier(code: number): boolean { return code === 0x10 || code === 0x11 || code === 0x12 || code === 0x204 || code === 0x205; },
  isMouse(code: number): boolean { return code === 1 || code === 2 || code === 4 || code === 5 || code === 6 || code === 0x100 || code === 0x101; },
  modifierOf(code: number): KeyModifiers {
    switch (code) {
      case 0x10: return KeyModifiers.Shift;
      case 0x11: return KeyModifiers.Ctrl;
      case 0x12: return KeyModifiers.Alt;
      case 0x204: return KeyModifiers.PadLB;
      case 0x205: return KeyModifiers.PadRB;
      default: return KeyModifiers.None;
    }
  },
  /** Keys that can never be bound: Esc, the Windows keys, Print Screen and the lock keys. */
  isReserved(code: number): boolean {
    return code === 0x1b || code === 0x5b || code === 0x5c || code === 0x2c || code === 0x14 || code === 0x90 || code === 0x91;
  }
} as const;

const K = KeyCodes;

const DISPLAY = new Map<number, string>([
  [K.BACKSPACE, 'Backspace'], [K.TAB, 'Tab'], [K.ENTER, 'Enter'], [K.SHIFT, 'Shift'], [K.CTRL, 'Ctrl'], [K.ALT, 'Alt'],
  [K.PAUSE, 'Pause'], [K.CAPS_LOCK, 'Caps Lock'], [K.ESCAPE, 'Esc'], [K.SPACE, 'Space'],
  [K.PAGE_UP, 'PgUp'], [K.PAGE_DOWN, 'PgDn'], [K.END, 'End'], [K.HOME, 'Home'],
  [K.LEFT, '←'], [K.UP, '↑'], [K.RIGHT, '→'], [K.DOWN, '↓'],
  [K.PRINT_SCREEN, 'PrtSc'], [K.INSERT, 'Ins'], [K.DELETE, 'Del'],
  [K.LEFT_WIN, 'Win'], [K.RIGHT_WIN, 'Win'], [K.APPS, 'Menu'],
  [K.NUM_MULTIPLY, 'Num *'], [K.NUM_ADD, 'Num +'], [K.NUM_SUBTRACT, 'Num -'], [K.NUM_DECIMAL, 'Num .'], [K.NUM_DIVIDE, 'Num /'],
  [K.NUM_LOCK, 'Num Lock'], [K.SCROLL_LOCK, 'Scroll Lock'],
  [K.OEM_1, ';'], [K.OEM_PLUS, '='], [K.OEM_COMMA, ','], [K.OEM_MINUS, '-'], [K.OEM_PERIOD, '.'], [K.OEM_2, '/'],
  [K.OEM_3, '`'], [K.OEM_4, '['], [K.OEM_5, '\\'], [K.OEM_6, ']'], [K.OEM_7, "'"], [K.OEM_102, '\\ (102)'],
  [K.LEFT_MOUSE, 'LMB'], [K.RIGHT_MOUSE, 'RMB'], [K.MIDDLE_MOUSE, 'MMB'], [K.MOUSE4, 'Mouse 4'], [K.MOUSE5, 'Mouse 5'],
  [K.WHEEL_UP, 'Wheel up'], [K.WHEEL_DOWN, 'Wheel down'],
  [K.PAD_A, 'A'], [K.PAD_B, 'B'], [K.PAD_X, 'X'], [K.PAD_Y, 'Y'], [K.PAD_LB, 'LB'], [K.PAD_RB, 'RB'],
  [K.PAD_BACK, 'Back'], [K.PAD_START, 'Start'], [K.PAD_LS, 'LS click'], [K.PAD_RS, 'RS click'],
  [K.PAD_UP, 'D-pad ↑'], [K.PAD_DOWN, 'D-pad ↓'], [K.PAD_LEFT, 'D-pad ←'], [K.PAD_RIGHT, 'D-pad →'], [K.PAD_LT, 'LT'], [K.PAD_RT, 'RT'],
  [K.PAD_LS_UP, 'LS ↑'], [K.PAD_LS_DOWN, 'LS ↓'], [K.PAD_LS_LEFT, 'LS ←'], [K.PAD_LS_RIGHT, 'LS →'],
  [K.PAD_RS_UP, 'RS ↑'], [K.PAD_RS_DOWN, 'RS ↓'], [K.PAD_RS_LEFT, 'RS ←'], [K.PAD_RS_RIGHT, 'RS →']
]);

const STORAGE = (() => {
  const names = new Map<number, string>([
    [K.BACKSPACE, 'Backspace'], [K.TAB, 'Tab'], [K.ENTER, 'Enter'], [K.SHIFT, 'Shift'], [K.CTRL, 'Ctrl'], [K.ALT, 'Alt'],
    [K.PAUSE, 'Pause'], [K.CAPS_LOCK, 'CapsLock'], [K.ESCAPE, 'Esc'], [K.SPACE, 'Space'],
    [K.PAGE_UP, 'PageUp'], [K.PAGE_DOWN, 'PageDown'], [K.END, 'End'], [K.HOME, 'Home'],
    [K.LEFT, 'Left'], [K.UP, 'Up'], [K.RIGHT, 'Right'], [K.DOWN, 'Down'],
    [K.PRINT_SCREEN, 'PrintScreen'], [K.INSERT, 'Insert'], [K.DELETE, 'Delete'],
    [K.LEFT_WIN, 'LeftWin'], [K.RIGHT_WIN, 'RightWin'], [K.APPS, 'Apps'],
    [K.NUM_MULTIPLY, 'NumMultiply'], [K.NUM_ADD, 'NumAdd'], [K.NUM_SUBTRACT, 'NumSubtract'], [K.NUM_DECIMAL, 'NumDecimal'], [K.NUM_DIVIDE, 'NumDivide'],
    [K.NUM_LOCK, 'NumLock'], [K.SCROLL_LOCK, 'ScrollLock'],
    [K.OEM_1, ';'], [K.OEM_PLUS, '='], [K.OEM_COMMA, ','], [K.OEM_MINUS, '-'], [K.OEM_PERIOD, '.'], [K.OEM_2, '/'],
    [K.OEM_3, '`'], [K.OEM_4, '['], [K.OEM_5, '\\'], [K.OEM_6, ']'], [K.OEM_7, "'"], [K.OEM_102, 'Oem102'],
    [K.LEFT_MOUSE, 'LMB'], [K.RIGHT_MOUSE, 'RMB'], [K.MIDDLE_MOUSE, 'MMB'], [K.MOUSE4, 'Mouse4'], [K.MOUSE5, 'Mouse5'],
    [K.WHEEL_UP, 'WheelUp'], [K.WHEEL_DOWN, 'WheelDown'],
    [K.PAD_A, 'PadA'], [K.PAD_B, 'PadB'], [K.PAD_X, 'PadX'], [K.PAD_Y, 'PadY'], [K.PAD_LB, 'PadLB'], [K.PAD_RB, 'PadRB'],
    [K.PAD_BACK, 'PadBack'], [K.PAD_START, 'PadStart'], [K.PAD_LS, 'PadLS'], [K.PAD_RS, 'PadRS'],
    [K.PAD_UP, 'PadUp'], [K.PAD_DOWN, 'PadDown'], [K.PAD_LEFT, 'PadLeft'], [K.PAD_RIGHT, 'PadRight'], [K.PAD_LT, 'PadLT'], [K.PAD_RT, 'PadRT'],
    [K.PAD_LS_UP, 'PadLSUp'], [K.PAD_LS_DOWN, 'PadLSDown'], [K.PAD_LS_LEFT, 'PadLSLeft'], [K.PAD_LS_RIGHT, 'PadLSRight'],
    [K.PAD_RS_UP, 'PadRSUp'], [K.PAD_RS_DOWN, 'PadRSDown'], [K.PAD_RS_LEFT, 'PadRSLeft'], [K.PAD_RS_RIGHT, 'PadRSRight']
  ]);
  for (let i = 0; i < 10; i++) {
    names.set(K.digit(i), String(i));
    names.set(K.NUM0 + i, 'Num' + i);
  }
  for (let c = 65; c <= 90; c++) { names.set(c, String.fromCharCode(c)); }
  for (let i = 0; i < 24; i++) { names.set(K.F1 + i, 'F' + (i + 1)); }
  return names;
})();

const PARSE = (() => {
  const table = new Map<string, number>();
  for (const [code, name] of STORAGE) { table.set(name.toLowerCase(), code); }
  const friendly: [string, number][] = [['Escape', K.ESCAPE], ['Return', K.ENTER], ['Control', K.CTRL], ['PgUp', K.PAGE_UP], ['PgDn', K.PAGE_DOWN],
    ['Ins', K.INSERT], ['Del', K.DELETE], ['Mouse1', K.LEFT_MOUSE], ['Mouse2', K.RIGHT_MOUSE], ['Mouse3', K.MIDDLE_MOUSE],
    ['XButton1', K.MOUSE4], ['XButton2', K.MOUSE5]];
  for (const [name, code] of friendly) { table.set(name.toLowerCase(), code); }
  return table;
})();

/** The stable name a code is stored under ("Ctrl", "PageUp", "[", "Mouse4", "Key0xE5" if unnamed). */
export function storageName(code: number): string {
  return STORAGE.get(code) ?? 'Key0x' + code.toString(16).toUpperCase().padStart(2, '0');
}

/** The short name shown in the UI ("PgUp", "↑", "Wheel up"; letters and digits as themselves). */
export function displayName(code: number): string {
  const name = DISPLAY.get(code);
  if (name !== undefined) { return name; }
  if (code >= K.NUM0 && code <= K.NUM0 + 9) { return 'Num ' + (code - K.NUM0); }
  return storageName(code);
}

/** Reads a stored key name (case-insensitive; "Key0xNN" for unnamed codes); 0 when unreadable. */
export function parseKeyCode(text: string | null | undefined): number {
  if (!text || !text.trim()) { return K.NONE; }
  const t = text.trim();
  const known = PARSE.get(t.toLowerCase());
  if (known !== undefined) { return known; }
  if (/^key0x[0-9a-f]{1,4}$/i.test(t)) {
    const code = parseInt(t.slice(5), 16);
    if (code > 0 && code <= 0xffff) { return code; }
  }
  return K.NONE;
}

/** "Ctrl+Alt+Shift+" (then "LB+RB+" for the shoulders) for the modifiers set; stored text names them "PadLB+" / "PadRB+". */
export function modifierPrefix(modifiers: KeyModifiers, display = true): string {
  let prefix = '';
  if (modifiers & KeyModifiers.Ctrl) { prefix += 'Ctrl+'; }
  if (modifiers & KeyModifiers.Alt) { prefix += 'Alt+'; }
  if (modifiers & KeyModifiers.Shift) { prefix += 'Shift+'; }
  if (modifiers & KeyModifiers.PadLB) { prefix += display ? 'LB+' : 'PadLB+'; }
  if (modifiers & KeyModifiers.PadRB) { prefix += display ? 'RB+' : 'PadRB+'; }
  return prefix;
}

/** The live state of keys, mouse buttons, the wheel and the gamepad for one frame (InputState; tests use a fake). */
export interface KeyState {
  /** How far the key / button / stick direction is in, 0–1 (keys 0 or 1). */
  keyAnalog(code: number): number;
  /** Held now. */
  isKeyDown(code: number): boolean;
  /** Went down this frame (a wheel notch counts as a press). */
  isKeyPressed(code: number): boolean;
  /** Auto-repeated this frame. */
  isKeyRepeated(code: number): boolean;
}

/**
 * One binding: a key, mouse button, wheel direction or gamepad input plus the modifiers that must be held with it. A
 * modifier key can be the key itself (Run = Shift); its own flag is then dropped. Stored as text ("Ctrl+Shift+S").
 */
export class KeyChord {
  static readonly NONE = new KeyChord(0, 0);

  readonly key: number;
  readonly modifiers: KeyModifiers;

  constructor(key: number, modifiers: KeyModifiers = 0) {
    this.key = key;
    this.modifiers = key === K.NONE ? 0 : modifiers & ~K.modifierOf(key) & (K.KEYBOARD_MODIFIERS | K.PAD_MODIFIERS);
  }

  get isEmpty(): boolean { return this.key === K.NONE; }

  get isPad(): boolean { return K.isPad(this.key); }

  get modifierCount(): number {
    let n = 0;
    for (let m = this.modifiers; m; m &= m - 1) { n++; }
    return n;
  }

  equals(other: KeyChord): boolean {
    return this.key === other.key && this.modifiers === other.modifiers;
  }

  /** A number unique per chord (map keys). */
  get id(): number { return this.key * 32 + this.modifiers; }

  /** Stored form: modifiers Ctrl, Alt, Shift, then the key ("Ctrl+Shift+S"); empty when unbound. */
  toString(): string {
    return this.isEmpty ? '' : modifierPrefix(this.modifiers, false) + storageName(this.key);
  }

  /** Display form ("Ctrl+Shift+S", "Shift+[", "Wheel up"); keyName can name keys from the keyboard layout. */
  toDisplayString(keyName: ((code: number) => string | null) | null = null): string {
    if (this.isEmpty) { return ''; }
    const name = keyName?.(this.key);
    return modifierPrefix(this.modifiers) + (name ? name : displayName(this.key));
  }

  /** Reads a stored chord; empty text reads as unbound. Returns null when the text isn't a chord. */
  static tryParse(text: string | null | undefined): KeyChord | null {
    if (!text || !text.trim()) { return KeyChord.NONE; }
    // "Ctrl+-" splits into "Ctrl" and "-": the key is always the last token ("Ctrl++" isn't a chord)
    const parts = text.trim().split('+');
    let modifiers = 0;
    for (let i = 0; i < parts.length - 1; i++) {
      const modifier = parseKeyCode(parts[i]);
      if (modifier === K.NONE || !K.isModifier(modifier)) { return null; }
      modifiers |= K.modifierOf(modifier);
    }
    const key = parseKeyCode(parts[parts.length - 1]);
    if (key === K.NONE) { return null; }
    return new KeyChord(key, modifiers);
  }

  /** Reads a stored chord, or throws (defaults and tests). */
  static parse(text: string): KeyChord {
    const chord = KeyChord.tryParse(text);
    if (!chord) { throw new Error(`Not a key binding: "${text}".`); }
    return chord;
  }
}
