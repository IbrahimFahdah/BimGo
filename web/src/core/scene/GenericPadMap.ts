import { KeyCodes, parseKeyCode, storageName } from './KeyChord';

/** What a generic controller's input is (port of PadSourceKind, input round B2 build B2-C). */
export enum PadSourceKind { None, Button, Pov, Axis }

const AXIS_NAMES = ['X', 'Y', 'Z', 'R', 'U', 'V'];
const POV_NAMES = ['POVU', 'POVR', 'POVD', 'POVL'];

/**
 * One input of a generic controller: a button, a D-pad (hat) direction or an axis direction. Stored as text: "B1"–"B32",
 * "POVU" / "POVR" / "POVD" / "POVL", "X+" / "Y-" / "Z+" / "R-" / "U+" / "V-" (port of PadSource).
 */
export class PadSource {
  static readonly NONE = new PadSource(PadSourceKind.None, 0, 0);

  constructor(readonly kind: PadSourceKind, readonly index: number, readonly sign: number) {}

  static button(index: number): PadSource { return new PadSource(PadSourceKind.Button, index, 0); }
  static pov(direction: number): PadSource { return new PadSource(PadSourceKind.Pov, direction, 0); }
  static axis(axis: number, sign: number): PadSource { return new PadSource(PadSourceKind.Axis, axis, sign < 0 ? -1 : 1); }

  get isNone(): boolean { return this.kind === PadSourceKind.None; }

  /** The same axis the other way (a stick's opposite direction); other kinds: NONE. */
  get opposite(): PadSource { return this.kind === PadSourceKind.Axis ? PadSource.axis(this.index, -this.sign) : PadSource.NONE; }

  equals(other: PadSource): boolean {
    return this.kind === other.kind && this.index === other.index && this.sign === other.sign;
  }

  /** Stored text ("B3", "POVU", "Y-"; empty when not mapped). */
  toString(): string {
    switch (this.kind) {
      case PadSourceKind.Button: return 'B' + (this.index + 1);
      case PadSourceKind.Pov: return POV_NAMES[Math.min(Math.max(this.index, 0), 3)];
      case PadSourceKind.Axis: return AXIS_NAMES[Math.min(Math.max(this.index, 0), 5)] + (this.sign < 0 ? '-' : '+');
      default: return '';
    }
  }

  /** Shown in CONTROLS ("button 3", "D-pad ↑", "axis Y −"). */
  describe(): string {
    switch (this.kind) {
      case PadSourceKind.Button: return 'button ' + (this.index + 1);
      case PadSourceKind.Pov: return 'D-pad ' + '↑→↓←'[Math.min(Math.max(this.index, 0), 3)];
      case PadSourceKind.Axis: return 'axis ' + AXIS_NAMES[Math.min(Math.max(this.index, 0), 5)] + (this.sign < 0 ? ' −' : ' +');
      default: return '—';
    }
  }

  /** Reads stored text (empty = not mapped); null when unreadable. */
  static tryParse(text: string | null | undefined): PadSource | null {
    if (!text || !text.trim()) { return PadSource.NONE; }
    const t = text.trim().toUpperCase();
    const pov = POV_NAMES.indexOf(t);
    if (pov >= 0) { return PadSource.pov(pov); }
    if (/^B\d+$/.test(t)) {
      const button = Number(t.slice(1));
      return button >= 1 && button <= GenericPadMap.BUTTONS ? PadSource.button(button - 1) : null;
    }
    if (t.length === 2 && (t[1] === '+' || t[1] === '-')) {
      const axis = AXIS_NAMES.indexOf(t[0]);
      if (axis >= 0) { return PadSource.axis(axis, t[1] === '-' ? -1 : 1); }
    }
    return null;
  }
}

/**
 * How a generic (non-standard) controller's buttons, D-pad and axes become BimGo's gamepad codes (port of
 * BimGo.Core/Scene/GenericPadMap.cs): one source per gamepad code, recorded by CONTROLS → MAP BUTTONS. Pure maths.
 */
export class GenericPadMap {
  /** Axes a generic controller can report (X, Y, Z, R, U, V: the browser's first six). */
  static readonly AXES = 6;
  static readonly BUTTONS = 32;
  /** The D-pad reading when it rests. */
  static readonly POV_CENTRED = -1;
  /** An axis must move this far from rest to count while mapping. */
  static readonly DETECT_AXIS = 0.6;

  private readonly sources: PadSource[] = new Array<PadSource>(KeyCodes.PAD_COUNT).fill(PadSource.NONE);

  get(code: number): PadSource {
    return KeyCodes.isPad(code) ? this.sources[code - KeyCodes.GAMEPAD_FIRST] : PadSource.NONE;
  }

  set(code: number, source: PadSource): void {
    if (KeyCodes.isPad(code)) { this.sources[code - KeyCodes.GAMEPAD_FIRST] = source; }
  }

  get isEmpty(): boolean { return this.sources.every(s => s.isNone); }

  get mappedCount(): number { return this.sources.filter(s => !s.isNone).length; }

  /** The desktop's first guess (Windows joystick mode): buttons 1–10 = A B X Y LB RB Back Start LS RS, hat, sticks X / Y and U / R, triggers on Z. */
  static xboxStyleGuess(): GenericPadMap {
    const map = new GenericPadMap();
    const buttons = [KeyCodes.PAD_A, KeyCodes.PAD_B, KeyCodes.PAD_X, KeyCodes.PAD_Y, KeyCodes.PAD_LB, KeyCodes.PAD_RB,
      KeyCodes.PAD_BACK, KeyCodes.PAD_START, KeyCodes.PAD_LS, KeyCodes.PAD_RS];
    buttons.forEach((code, i) => map.set(code, PadSource.button(i)));
    map.setHat();
    map.setStick(KeyCodes.PAD_LS_UP, PadSource.axis(1, -1), PadSource.axis(0, -1));
    map.setStick(KeyCodes.PAD_RS_UP, PadSource.axis(3, -1), PadSource.axis(4, -1));
    map.set(KeyCodes.PAD_LT, PadSource.axis(2, +1));
    map.set(KeyCodes.PAD_RT, PadSource.axis(2, -1));
    return map;
  }

  /**
   * The browser's first guess for a pad without the standard mapping (a typical "Generic USB Joystick"): buttons 1–4
   * face, 5 / 6 shoulders, 7 / 8 triggers, 9 / 10 Back / Start, 11 / 12 stick clicks, the hat as the D-pad, the left
   * stick on axes 1 / 2, the right stick on axes 3 / 4.
   */
  static browserGuess(): GenericPadMap {
    const map = new GenericPadMap();
    const buttons = [KeyCodes.PAD_A, KeyCodes.PAD_B, KeyCodes.PAD_X, KeyCodes.PAD_Y, KeyCodes.PAD_LB, KeyCodes.PAD_RB,
      KeyCodes.PAD_LT, KeyCodes.PAD_RT, KeyCodes.PAD_BACK, KeyCodes.PAD_START, KeyCodes.PAD_LS, KeyCodes.PAD_RS];
    buttons.forEach((code, i) => map.set(code, PadSource.button(i)));
    map.setHat();
    map.setStick(KeyCodes.PAD_LS_UP, PadSource.axis(1, -1), PadSource.axis(0, -1));
    map.setStick(KeyCodes.PAD_RS_UP, PadSource.axis(3, -1), PadSource.axis(2, -1));
    return map;
  }

  private setHat(): void {
    this.set(KeyCodes.PAD_UP, PadSource.pov(0));
    this.set(KeyCodes.PAD_RIGHT, PadSource.pov(1));
    this.set(KeyCodes.PAD_DOWN, PadSource.pov(2));
    this.set(KeyCodes.PAD_LEFT, PadSource.pov(3));
  }

  /** Sets a stick's four directions from its up and left sources. */
  setStick(up: number, upSource: PadSource, leftSource: PadSource): void {
    this.set(up, upSource);
    this.set(up + 1, upSource.opposite);
    this.set(up + 2, leftSource);
    this.set(up + 3, leftSource.opposite);
  }

  /** Each gamepad code's amount (0–1) for one reading (axes −1–1, buttons bit 0 = button 1, hat in hundredths of a degree). */
  evaluate(axes: ArrayLike<number>, buttons: number, povHundredths: number, analog: Float32Array | number[]): void {
    for (let i = 0; i < KeyCodes.PAD_COUNT && i < analog.length; i++) {
      const source = this.sources[i];
      switch (source.kind) {
        case PadSourceKind.Button: analog[i] = (buttons >>> Math.min(Math.max(source.index, 0), 31)) & 1 ? 1 : 0; break;
        case PadSourceKind.Pov: analog[i] = GenericPadMap.povPoints(povHundredths, source.index) ? 1 : 0; break;
        case PadSourceKind.Axis: analog[i] = source.index < axes.length ? Math.min(Math.max(axes[source.index] * source.sign, 0), 1) : 0; break;
        default: analog[i] = 0;
      }
    }
  }

  /** True when the hat points within 67.5° of a direction (0 up, 1 right, 2 down, 3 left). */
  static povPoints(povHundredths: number, direction: number): boolean {
    if (povHundredths < 0 || povHundredths >= 36000) { return false; }
    let difference = Math.abs(povHundredths - direction * 9000) % 36000;
    if (difference > 18000) { difference = 36000 - difference; }
    return difference < 6750;
  }

  /** The first input that differs from the resting reading (a new button, the hat, the biggest axis change), or NONE. */
  static detect(restAxes: ArrayLike<number>, restButtons: number, axes: ArrayLike<number>, buttons: number, povHundredths: number): PadSource {
    const pressed = (buttons & ~restButtons) >>> 0;
    if (pressed !== 0) { return PadSource.button(31 - Math.clz32(pressed & -pressed)); }
    if (povHundredths >= 0 && povHundredths < 36000) { return PadSource.pov(Math.round(povHundredths / 9000) % 4); }
    let best = -1, bestChange = GenericPadMap.DETECT_AXIS;
    for (let a = 0; a < GenericPadMap.AXES && a < axes.length && a < restAxes.length; a++) {
      const change = Math.abs(axes[a] - restAxes[a]);
      if (change > bestChange) {
        bestChange = change;
        best = a;
      }
    }
    return best >= 0 ? PadSource.axis(best, axes[best] - restAxes[best] < 0 ? -1 : 1) : PadSource.NONE;
  }

  /** True when the reading is back at rest. */
  static atRest(restAxes: ArrayLike<number>, restButtons: number, axes: ArrayLike<number>, buttons: number, povHundredths: number): boolean {
    if (((buttons & ~restButtons) >>> 0) !== 0 || (povHundredths >= 0 && povHundredths < 36000)) { return false; }
    for (let a = 0; a < GenericPadMap.AXES && a < axes.length && a < restAxes.length; a++) {
      if (Math.abs(axes[a] - restAxes[a]) > 0.3) { return false; }
    }
    return true;
  }

  /** The map as stored: gamepad code name ("PadA") → source ("B1"); unmapped codes left out. */
  toSettings(): Record<string, string> {
    const stored: Record<string, string> = {};
    this.sources.forEach((source, i) => {
      if (!source.isNone) { stored[storageName(KeyCodes.GAMEPAD_FIRST + i)] = source.toString(); }
    });
    return stored;
  }

  /** Reads a stored map (unknown codes and unreadable sources skipped); empty gives the guess. */
  static fromSettings(stored: Record<string, string> | null | undefined, problems: string[] | null = null, guess = GenericPadMap.xboxStyleGuess): GenericPadMap {
    if (!stored || Object.keys(stored).length === 0) { return guess(); }
    const map = new GenericPadMap();
    for (const [key, value] of Object.entries(stored)) {
      const code = parseKeyCode(key);
      if (!KeyCodes.isPad(code)) {
        problems?.push(`not a gamepad input: “${key}”`);
        continue;
      }
      const source = PadSource.tryParse(value);
      if (!source) {
        problems?.push(`${key}: can't read “${value}”`);
        continue;
      }
      map.set(code, source);
    }
    return map;
  }
}
