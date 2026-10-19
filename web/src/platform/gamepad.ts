import { InputAction } from '../core/scene/InputCatalog';
import { GenericPadMap } from '../core/scene/GenericPadMap';
import { KeyCodes } from '../core/scene/KeyChord';
import { PAD_DEFAULTS, type ViewerSettings } from '../game/ViewerSettings';
import { Hotkeys } from './Hotkeys';
import type { InputState } from './input';

/** What the gamepad does with the cursor when it is free. */
export enum PadCursorMode {
  /** Walking, a tour, a video, a key capture: no cursor, no clicks. */
  Off,
  /** Menus, panels, the start screen: the look stick moves the cursor, A clicks, B goes back, the move stick scrolls. */
  Menu,
  /** The free-cursor editors (photo, section box, study, sun panel, clash mode): as Menu, but the move stick looks. */
  Editor
}

/** The standard mapping's buttons → gamepad codes (W3C Gamepad "standard" layout). */
const STANDARD_BUTTONS: number[] = [
  KeyCodes.PAD_A, KeyCodes.PAD_B, KeyCodes.PAD_X, KeyCodes.PAD_Y, KeyCodes.PAD_LB, KeyCodes.PAD_RB, KeyCodes.PAD_LT, KeyCodes.PAD_RT,
  KeyCodes.PAD_BACK, KeyCodes.PAD_START, KeyCodes.PAD_LS, KeyCodes.PAD_RS,
  KeyCodes.PAD_UP, KeyCodes.PAD_DOWN, KeyCodes.PAD_LEFT, KeyCodes.PAD_RIGHT
];

const DOWN = new Array<boolean>(KeyCodes.PAD_COUNT).fill(false);
const ANALOG = new Float32Array(KeyCodes.PAD_COUNT);
const GENERIC_ANALOG = new Float32Array(KeyCodes.PAD_COUNT);
const P = (code: number) => code - KeyCodes.GAMEPAD_FIRST;

let index = -1;
let id = '';
let standard = true;
let last = 0;
let dt = 0;
let hatAxis = -1;
let clickHeld = false;
// Polish round P-B: A went down with a shoulder held (a chord): no click until it is released
let clickChord = false;
let scrollWait = 0;
let loggedMissing = false;

/**
 * The gamepad (port of BimGo.App/Platform/PadInput.cs, input round B2 build B): a secondary input beside the keyboard
 * and mouse through the browser's Gamepad API (nothing changes when none is connected). The first connected controller
 * is used. Pads the browser knows (Xbox, PlayStation, Switch Pro…) arrive in the standard layout; others ("Generic USB
 * Joystick") go through a {@link GenericPadMap} that CONTROLS → MAP BUTTONS records. Each frame {@link PadInput.poll}
 * turns the state into gamepad codes on the input (bound like keys) and {@link PadInput.driveCursor} moves the page's
 * own cursor in menus and editors (a page can't move the system's).
 */
export const PadInput = {
  /** Look speed multiplier. */
  lookSensitivity: 1,
  /** Invert the look stick's up / down. */
  invertY: false,
  /** Stick dead zone (0–1 of full tilt). */
  deadZone: PAD_DEFAULTS.DEAD_ZONE as number,
  /** Trigger threshold (0–1 of the travel). */
  triggerThreshold: PAD_DEFAULTS.TRIGGER as number,
  /** Full-tilt look speed at sensitivity 1 (radians a second). */
  LOOK_RADIANS_PER_SECOND: 3,
  /** How a generic controller's buttons, hat and axes become gamepad codes. */
  genericMap: GenericPadMap.browserGuess(),
  /** The generic controller the map was recorded with. */
  genericName: '',
  /** While MAP BUTTONS runs: the raw reading is kept, nothing reaches the actions. */
  mapping: false,
  /** The generic controller's last raw axes (−1–1), buttons (bit 0 = button 1) and hat (hundredths of a degree, or −1). */
  rawAxes: new Float32Array(GenericPadMap.AXES),
  rawButtons: 0,
  rawPov: GenericPadMap.POV_CENTRED,

  /** Where the page's cursor is drawn while the gamepad drives it, or null (drawn by the session). */
  cursorVisible: false,

  read(settings: ViewerSettings): void {
    PadInput.lookSensitivity = settings.padLookSensitivity;
    PadInput.invertY = settings.padInvertY;
    PadInput.deadZone = settings.padDeadZone;
    PadInput.triggerThreshold = settings.padTriggerThreshold;
    const problems: string[] = [];
    PadInput.genericMap = GenericPadMap.fromSettings(settings.genericPadMap, problems, GenericPadMap.browserGuess);
    PadInput.genericName = settings.genericPadName;
    for (const problem of problems) { console.info(`Gamepad map: skipped ${problem}.`); }
  },

  write(settings: ViewerSettings): void {
    settings.padLookSensitivity = PadInput.lookSensitivity;
    settings.padInvertY = PadInput.invertY;
    settings.padDeadZone = PadInput.deadZone;
    settings.padTriggerThreshold = PadInput.triggerThreshold;
    settings.genericPadMap = PadInput.genericMap.toSettings();
    if (index >= 0 && !standard && id) { settings.genericPadName = id; }
  },

  /** True when a controller is in use. */
  get connected(): boolean { return index >= 0; },

  /** True when the controller in use has no standard layout (its buttons go through the generic map). */
  get isGeneric(): boolean { return index >= 0 && !standard; },

  /** The CONTROLS status ("Xbox Wireless Controller", "none connected"). */
  get description(): string { return index >= 0 ? shortName(id) : 'none connected'; },

  /**
   * Reads the controller and hands its buttons, triggers and sticks to the input (all released while the page isn't
   * active). Never throws: without the Gamepad API the gamepad is simply off.
   */
  poll(input: InputState, active: boolean): void {
    const now = performance.now() / 1000;
    dt = Math.min(Math.max(now - last, 0), 0.1);
    last = now;
    DOWN.fill(false);
    ANALOG.fill(0);
    let lx = 0, ly = 0, rx = 0, ry = 0;

    let pads: (Gamepad | null)[] = [];
    try {
      pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    } catch (e) {
      if (!loggedMissing) { console.info(`Gamepad: not available (${e instanceof Error ? e.message : String(e)}); the gamepad is off.`); }
      loggedMissing = true;
    }
    let pad = index >= 0 ? pads[index] ?? null : null;
    if (!pad || !pad.connected) {
      if (index >= 0) { console.info(`Gamepad: “${shortName(id)}” disconnected.`); }
      index = -1;
      pad = pads.find(p => p?.connected) ?? null;
      if (pad) {
        index = pad.index;
        id = pad.id;
        standard = pad.mapping === 'standard';
        hatAxis = -1;
        console.info(`Gamepad: “${shortName(id)}” connected (${standard ? 'standard layout' : `generic: ${pad.axes.length} axes, ${pad.buttons.length} buttons`}).`);
      }
    }

    if (pad && standard) {
      if (active) { [lx, ly, rx, ry] = readStandard(pad); }
    } else if (pad) {
      readRaw(pad);
      if (active) { [lx, ly, rx, ry] = readGeneric(); }
    }

    if (PadInput.mapping) {
      DOWN.fill(false);
      ANALOG.fill(0);
      lx = ly = rx = ry = 0;
    }
    input.setPad(index >= 0, DOWN, ANALOG, lx, ly, rx, ry, dt);
  },

  /** True when looking is on the right stick (the look actions' gamepad bindings decide; the default is the right). */
  get lookOnRightStick(): boolean {
    const key = Hotkeys.map.padChord(InputAction.LookRight).key;
    return key >= KeyCodes.PAD_RS_UP && key <= KeyCodes.PAD_RS_RIGHT;
  },

  /** The look stick (x right, y up). */
  lookStick(input: InputState): [number, number] {
    return PadInput.lookOnRightStick ? [input.padRightX, input.padRightY] : [input.padLeftX, input.padLeftY];
  },

  /** The move stick (x right, y up). */
  moveStick(input: InputState): [number, number] {
    return PadInput.lookOnRightStick ? [input.padLeftX, input.padLeftY] : [input.padRightX, input.padRightY];
  },

  /** A stick with a squared response (fine control near the centre), same direction. */
  curve(x: number, y: number): [number, number] {
    const length = Math.hypot(x, y);
    return [x * length, y * length];
  },

  /**
   * Menus and editors (the cursor is free): the look stick moves the page's cursor, A is the left button, B is Esc, and
   * in menus the move stick scrolls. Off: a held click is let go.
   */
  driveCursor(input: InputState, mode: PadCursorMode, width: number, height: number, captured: boolean, dpiScale: number): void {
    if (index < 0 || mode === PadCursorMode.Off || captured || !document.hasFocus()) {
      releaseClick(input);
      scrollWait = 0;
      PadInput.cursorVisible = false;
      return;
    }

    // Cursor: up to ~1200 px a second (DPI-scaled) at full tilt, squared response
    const [sx, sy] = PadInput.lookStick(input);
    const [cx, cy] = PadInput.curve(sx, sy);
    if (cx !== 0 || cy !== 0) {
      const speed = 1200 * dpiScale * dt;
      input.movePadCursor(Math.min(Math.max(input.mouseX + cx * speed, 0), width - 1), Math.min(Math.max(input.mouseY - cy * speed, 0), height - 1));
    }
    if (input.lastInputWasPad) { PadInput.cursorVisible = true; }

    // A clicks (held: drags), B goes back. Polish round P-B: A pressed with LB / RB held is a chord (clash mode's RB+A
    // group, LB+A next status), not a click: it waits for A to come up
    const click = Hotkeys.map.down(InputAction.PadClick, input);
    if (click && !clickHeld && !clickChord) {
      if (input.isDown(KeyCodes.PAD_LB) || input.isDown(KeyCodes.PAD_RB)) { clickChord = true; }
      else {
        clickHeld = true;
        input.injectLeft(true);
        PadInput.cursorVisible = true;
      }
    } else if (!click) {
      clickChord = false;
      releaseClick(input);
    }
    if (Hotkeys.map.pressed(InputAction.PadMenuBack, input)) { input.injectEscape(); }

    // Menus: the move stick scrolls (a notch at a rate that grows with the tilt)
    const scroll = mode === PadCursorMode.Menu ? PadInput.moveStick(input)[1] : 0;
    if (Math.abs(scroll) >= 0.5) {
      scrollWait -= dt;
      if (scrollWait <= 0) {
        input.onWheel(scroll > 0 ? 1 : -1);
        scrollWait = 0.18 / Math.abs(scroll);
      }
    } else { scrollWait = 0; }
  }
};

function releaseClick(input: InputState): void {
  if (!clickHeld) { return; }
  clickHeld = false;
  input.injectLeft(false);
}

/** "Xbox 360 Controller (XInput STANDARD GAMEPAD)" → "Xbox 360 Controller"; vendor / product ids dropped. */
function shortName(text: string): string {
  const name = text.replace(/\((STANDARD GAMEPAD|XInput[^)]*)\)/gi, '').replace(/\(?\s*Vendor:.*$/i, '').replace(/[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim();
  return name || 'Gamepad';
}

function readStandard(pad: Gamepad): [number, number, number, number] {
  STANDARD_BUTTONS.forEach((code, b) => {
    const button = pad.buttons[b];
    if (!button) { return; }
    if (code === KeyCodes.PAD_LT || code === KeyCodes.PAD_RT) {
      trigger(code, button.value);
    } else {
      DOWN[P(code)] = button.pressed;
      ANALOG[P(code)] = button.pressed ? 1 : 0;
    }
  });
  const left = deadZoned(pad.axes[0] ?? 0, -(pad.axes[1] ?? 0));
  const right = deadZoned(pad.axes[2] ?? 0, -(pad.axes[3] ?? 0));
  directions(KeyCodes.PAD_LS_UP, left[0], left[1]);
  directions(KeyCodes.PAD_RS_UP, right[0], right[1]);
  return [left[0], left[1], right[0], right[1]];
}

/**
 * A pad without the standard layout: its buttons (bit mask), its first six axes and its hat. Chrome reports a hat as one
 * axis stepping −1 (up) … 1 (up-left) in sevenths, resting above 1; that axis becomes the hat, not an axis.
 */
function readRaw(pad: Gamepad): void {
  let buttons = 0;
  for (let b = 0; b < Math.min(pad.buttons.length, 32); b++) {
    if (pad.buttons[b]?.pressed) { buttons |= 1 << b; }
  }
  PadInput.rawButtons = buttons >>> 0;
  for (let a = 0; a < pad.axes.length; a++) {
    if (pad.axes[a] > 1.05 && hatAxis < 0) { hatAxis = a; }
  }
  let pov = GenericPadMap.POV_CENTRED;
  let out = 0;
  for (let a = 0; a < pad.axes.length && out < GenericPadMap.AXES; a++) {
    const value = pad.axes[a];
    if (a === hatAxis) {
      if (value >= -1.05 && value <= 1.05) { pov = (Math.round((value + 1) * 3.5) % 8) * 4500; }
      continue;
    }
    PadInput.rawAxes[out++] = Math.min(Math.max(value, -1), 1);
  }
  for (; out < GenericPadMap.AXES; out++) { PadInput.rawAxes[out] = 0; }
  PadInput.rawPov = pov;
}

function readGeneric(): [number, number, number, number] {
  PadInput.genericMap.evaluate(PadInput.rawAxes, PadInput.rawButtons, PadInput.rawPov, GENERIC_ANALOG);
  for (let i = 0; i < KeyCodes.PAD_COUNT; i++) {
    const code = KeyCodes.GAMEPAD_FIRST + i;
    if (KeyCodes.isPadStick(code)) { continue; }
    if (code === KeyCodes.PAD_LT || code === KeyCodes.PAD_RT) {
      trigger(code, GENERIC_ANALOG[i]);
    } else {
      DOWN[i] = GENERIC_ANALOG[i] >= 0.5;
      ANALOG[i] = DOWN[i] ? 1 : 0;
    }
  }
  const stick = (up: number) => {
    const i = P(up);
    return deadZoned(GENERIC_ANALOG[i + 3] - GENERIC_ANALOG[i + 2], GENERIC_ANALOG[i] - GENERIC_ANALOG[i + 1]);
  };
  const left = stick(KeyCodes.PAD_LS_UP), right = stick(KeyCodes.PAD_RS_UP);
  directions(KeyCodes.PAD_LS_UP, left[0], left[1]);
  directions(KeyCodes.PAD_RS_UP, right[0], right[1]);

  // No Start button: LB + RB together open the menu
  if (PadInput.genericMap.get(KeyCodes.PAD_START).isNone && DOWN[P(KeyCodes.PAD_LB)] && DOWN[P(KeyCodes.PAD_RB)]) {
    DOWN[P(KeyCodes.PAD_START)] = true;
    ANALOG[P(KeyCodes.PAD_START)] = 1;
  }
  return [left[0], left[1], right[0], right[1]];
}

function trigger(code: number, value: number): void {
  const threshold = Math.min(Math.max(PadInput.triggerThreshold, 0.01), 0.95);
  const down = value >= threshold;
  DOWN[P(code)] = down;
  ANALOG[P(code)] = down ? Math.min(Math.max((value - threshold) / (1 - threshold), 0), 1) : 0;
}

/** A radial dead zone, rescaled so its edge reads 0 (length ≤ 1; x right, y up). */
function deadZoned(x: number, y: number): [number, number] {
  const length = Math.hypot(x, y);
  const dead = Math.min(Math.max(PadInput.deadZone, 0), 0.9);
  if (length <= dead) { return [0, 0]; }
  const scaled = Math.min(Math.max((Math.min(length, 1) - dead) / (1 - dead), 0), 1);
  return [x * scaled / length, y * scaled / length];
}

/** A stick's four directions (up, down, left, right from first): analog amounts, down past half way. */
function directions(first: number, x: number, y: number): void {
  const i = P(first);
  ANALOG[i] = Math.max(y, 0);
  ANALOG[i + 1] = Math.max(-y, 0);
  ANALOG[i + 2] = Math.max(-x, 0);
  ANALOG[i + 3] = Math.max(x, 0);
  for (let d = 0; d < 4; d++) { DOWN[i + d] = ANALOG[i + d] >= 0.5; }
}
