import { ActionKind, type ActionDef, type HelpEntry, InputAction, InputCatalog } from './InputCatalog';
import { displayName, KeyChord, KeyCodes, KeyModifiers, type KeyState, modifierPrefix } from './KeyChord';

/** A binding that already uses a key (a clash). */
export interface BindingClash {
  action: InputAction;
  slot: number;
  chord: KeyChord;
}

/** What a rebinding did. */
export interface BindResult {
  done: boolean;
  message: string | null;
}

/** What an import read. */
export interface KeymapImport {
  /** True when the file was a BimGo keymap. */
  valid: boolean;
  /** Actions the file set. */
  applied: number;
  /** Entries skipped (unknown or fixed actions, unreadable keys). */
  problems: string[];
  /** Clashes left after the import. */
  clashes: number;
}

const defOf = (action: InputAction): ActionDef => InputCatalog.get(action)!;

/**
 * The live key bindings (port of BimGo.Core/Scene/KeyMap.cs, input round B2): up to MAX_SLOTS chords per action plus
 * one gamepad slot, starting from the catalogue's defaults with the user's changes on top (only the changes are
 * stored). Answers "did this action fire" for a frame's key state, finds and swaps clashes, and reads / writes keymap
 * files (the desktop's format: files move between the two).
 *
 * Modifiers: a binding fires when its key goes down while its modifiers are held; extra modifiers don't stop it
 * unless another binding live in the same situation uses the same key with more of the held modifiers (Shift+H sets
 * home instead of going home). Held actions ignore that rule.
 */
export class KeyMap {
  /** Keyboard / mouse bindings per action. */
  static readonly MAX_SLOTS = 3;
  /** The gamepad's slot, after the keyboard / mouse ones. */
  static readonly PAD_SLOT = 3;
  static readonly ALL_SLOTS = 4;
  static readonly FILE_FORMAT = 'bimgo-keymap';
  static readonly FILE_VERSION = 1;

  private readonly slots: KeyChord[][];
  private shadows: KeyModifiers[][][] = [];
  private labels: string[] = [];
  private allLabels: string[] = [];
  private slotLabels: string[] = [];
  private labelsVersion = -1;
  private keyNameFn: ((code: number) => string | null) | null = null;

  /** Changes with every edit (UI caches of key text compare it). */
  version = 0;

  constructor() {
    this.slots = [];
    for (let i = 0; i < InputCatalog.actionCount; i++) { this.slots.push(new Array<KeyChord>(KeyMap.ALL_SLOTS).fill(KeyChord.NONE)); }
    this.resetAll();
  }

  /** Names keys from the keyboard layout, or null for the US glyphs. */
  get keyName(): ((code: number) => string | null) | null { return this.keyNameFn; }
  set keyName(value: ((code: number) => string | null) | null) {
    this.keyNameFn = value;
    this.labelsVersion = -1;
    this.version++;
  }

  // #region Reading

  get(action: InputAction, slot: number): KeyChord {
    return action > 0 && action < this.slots.length && slot >= 0 && slot < KeyMap.ALL_SLOTS ? this.slots[action][slot] : KeyChord.NONE;
  }

  padChord(action: InputAction): KeyChord {
    return this.get(action, KeyMap.PAD_SLOT);
  }

  /** The first bound keyboard / mouse chord (NONE when unbound). */
  primary(action: InputAction): KeyChord {
    for (let s = 0; s < KeyMap.MAX_SLOTS; s++) {
      const chord = this.get(action, s);
      if (!chord.isEmpty) { return chord; }
    }
    return KeyChord.NONE;
  }

  isUnbound(action: InputAction): boolean {
    return this.primary(action).isEmpty;
  }

  isDefault(action: InputAction): boolean {
    const def = InputCatalog.get(action);
    if (!def) { return true; }
    return this.isKeyDefault(action) && this.get(action, KeyMap.PAD_SLOT).equals(def.padDefault);
  }

  isKeyDefault(action: InputAction): boolean {
    const def = InputCatalog.get(action);
    if (!def) { return true; }
    for (let s = 0; s < KeyMap.MAX_SLOTS; s++) {
      const expected = s < def.defaults.length ? def.defaults[s] : KeyChord.NONE;
      if (!this.get(action, s).equals(expected)) { return false; }
    }
    return true;
  }

  allDefault(): boolean {
    for (const def of InputCatalog.all) { if (!this.isDefault(def.action)) { return false; } }
    return true;
  }

  // #endregion

  // #region Evaluation (per frame)

  /** True when one of the action's bindings went down this frame. */
  pressed(action: InputAction, state: KeyState): boolean {
    return this.triggered(action, state, false);
  }

  /** Like pressed, also true on keyboard auto-repeat. */
  pressedOrRepeated(action: InputAction, state: KeyState): boolean {
    return this.triggered(action, state, true);
  }

  /** True while one of the action's bindings is held with its modifiers. */
  down(action: InputAction, state: KeyState): boolean {
    if (action <= 0 || action >= this.slots.length) { return false; }
    const slots = this.slots[action];
    for (let s = 0; s < KeyMap.ALL_SLOTS; s++) {
      const chord = slots[s];
      if (!chord.isEmpty && state.isKeyDown(chord.key) && KeyMap.modifiersHeld(chord.modifiers, state)) { return true; }
    }
    return false;
  }

  /** How far the action is held, 0–1 (gamepad sticks and triggers analog): the largest binding whose modifiers are held. */
  axis(action: InputAction, state: KeyState): number {
    if (action <= 0 || action >= this.slots.length) { return 0; }
    const slots = this.slots[action];
    let value = 0;
    for (let s = 0; s < KeyMap.ALL_SLOTS; s++) {
      const chord = slots[s];
      if (chord.isEmpty || !KeyMap.modifiersHeld(chord.modifiers, state)) { continue; }
      value = Math.max(value, state.keyAnalog(chord.key));
    }
    return Math.min(Math.max(value, 0), 1);
  }

  /** The slot whose binding fired this frame (PAD_SLOT for the gamepad), or −1. */
  pressedSlot(action: InputAction, state: KeyState): number {
    if (action <= 0 || action >= this.slots.length) { return -1; }
    for (let s = 0; s < KeyMap.ALL_SLOTS; s++) {
      if (this.slotTriggered(action, s, state, false)) { return s; }
    }
    return -1;
  }

  private triggered(action: InputAction, state: KeyState, repeat: boolean): boolean {
    if (action <= 0 || action >= this.slots.length) { return false; }
    for (let s = 0; s < KeyMap.ALL_SLOTS; s++) {
      if (this.slotTriggered(action, s, state, repeat)) { return true; }
    }
    return false;
  }

  private slotTriggered(action: number, slot: number, state: KeyState, repeat: boolean): boolean {
    const chord = this.slots[action][slot];
    if (chord.isEmpty) { return false; }
    if (!state.isKeyPressed(chord.key) && !(repeat && state.isKeyRepeated(chord.key))) { return false; }
    if (!KeyMap.modifiersHeld(chord.modifiers, state)) { return false; }
    const stronger = this.shadows[action][slot];
    for (const modifiers of stronger) {
      if (KeyMap.modifiersHeld(modifiers, state)) { return false; }
    }
    return true;
  }

  /** True when every modifier in the set is held. */
  static modifiersHeld(modifiers: KeyModifiers, state: KeyState): boolean {
    return (!(modifiers & KeyModifiers.Shift) || state.isKeyDown(KeyCodes.SHIFT))
      && (!(modifiers & KeyModifiers.Ctrl) || state.isKeyDown(KeyCodes.CTRL))
      && (!(modifiers & KeyModifiers.Alt) || state.isKeyDown(KeyCodes.ALT))
      && (!(modifiers & KeyModifiers.PadLB) || state.isKeyDown(KeyCodes.PAD_LB))
      && (!(modifiers & KeyModifiers.PadRB) || state.isKeyDown(KeyCodes.PAD_RB));
  }

  private rebuildShadows(): void {
    const n = this.slots.length;
    // Bindings by key, so each slot only looks at the others on its key
    const byKey = new Map<number, { action: number; chord: KeyChord }[]>();
    for (let b = 1; b < n; b++) {
      for (let t = 0; t < KeyMap.ALL_SLOTS; t++) {
        const chord = this.slots[b][t];
        if (chord.isEmpty) { continue; }
        let list = byKey.get(chord.key);
        if (!list) { byKey.set(chord.key, list = []); }
        list.push({ action: b, chord });
      }
    }
    const shadows: KeyModifiers[][][] = [];
    for (let a = 0; a < n; a++) {
      const row: KeyModifiers[][] = [];
      for (let s = 0; s < KeyMap.ALL_SLOTS; s++) {
        const found: KeyModifiers[] = [];
        const chord = this.slots[a][s];
        if (!chord.isEmpty) {
          for (const other of byKey.get(chord.key) ?? []) {
            if (other.chord.modifiers === chord.modifiers || (other.chord.modifiers & chord.modifiers) !== chord.modifiers) { continue; }
            if (!InputCatalog.liveTogether(a, other.action)) { continue; }
            if (!found.includes(other.chord.modifiers)) { found.push(other.chord.modifiers); }
          }
        }
        row.push(found);
      }
      shadows.push(row);
    }
    this.shadows = shadows;
  }

  // #endregion

  // #region Clashes and changes

  /** Bindings of other actions that can fire together with this one and already use the chord. */
  findClashes(action: InputAction, chord: KeyChord): BindingClash[] {
    const clashes: BindingClash[] = [];
    if (chord.isEmpty || !InputCatalog.get(action)) { return clashes; }
    for (let b = 1; b < this.slots.length; b++) {
      if (b === action || !InputCatalog.liveTogether(action, b)) { continue; }
      for (let t = 0; t < KeyMap.ALL_SLOTS; t++) {
        if (this.slots[b][t].equals(chord)) { clashes.push({ action: b, slot: t, chord }); }
      }
    }
    return clashes;
  }

  /** Every clash in the map (each pair once). */
  allClashes(): [BindingClash, BindingClash][] {
    const pairs: [BindingClash, BindingClash][] = [];
    for (let a = 1; a < this.slots.length; a++) {
      for (let s = 0; s < KeyMap.ALL_SLOTS; s++) {
        const chord = this.slots[a][s];
        if (chord.isEmpty) { continue; }
        for (const clash of this.findClashes(a, chord)) {
          if (clash.action > a) { pairs.push([{ action: a, slot: s, chord }, clash]); }
        }
      }
    }
    return pairs;
  }

  hasClash(action: InputAction): boolean {
    for (let s = 0; s < KeyMap.ALL_SLOTS; s++) {
      const chord = this.get(action, s);
      if (!chord.isEmpty && this.findClashes(action, chord).length > 0) { return true; }
    }
    return false;
  }

  /**
   * Why a chord can't go in an action's slot, or null when it can. The browser adds its own: plain F12 (developer
   * tools) and the tab / window keys it never passes to a page.
   */
  static refusal(action: InputAction, chord: KeyChord, slot = 0): string | null {
    const def = InputCatalog.get(action);
    if (!def) { return 'Unknown action.'; }
    if (def.isFixed) { return `“${def.label}” is fixed.`; }
    if (chord.isEmpty) { return null; }
    if (slot === KeyMap.PAD_SLOT) {
      if (!chord.isPad) { return 'The gamepad column takes gamepad buttons, triggers and sticks.'; }
      if (chord.modifiers & ~KeyCodes.PAD_MODIFIERS) { return 'Gamepad bindings combine with LB / RB only.'; }
    } else {
      if (chord.isPad) { return 'Gamepad buttons go in the gamepad column.'; }
      if (chord.modifiers & ~KeyCodes.KEYBOARD_MODIFIERS) { return 'Keys combine with Shift / Ctrl / Alt only.'; }
    }
    if (KeyCodes.isReserved(chord.key)) { return `${chord.toDisplayString()} is reserved.`; }
    if (chord.key === KeyCodes.F4 && chord.modifiers & KeyModifiers.Alt) { return 'Alt+F4 closes the window.'; }
    if (chord.key === KeyCodes.F12 && chord.modifiers === 0) { return "F12 opens the browser's developer tools (Shift+F12 works)."; }
    const browser = browserKeeps(chord);
    if (browser) { return `The browser keeps ${chord.toDisplayString()} (${browser}).`; }
    if (def.kind === ActionKind.Hold && (chord.key === KeyCodes.WHEEL_UP || chord.key === KeyCodes.WHEEL_DOWN)) {
      return `“${def.label}” is held, and the wheel can't be held.`;
    }
    if (chord.key >= KeyCodes.GAMEPAD_FIRST && !chord.isPad) { return `${chord.toDisplayString()} isn't a key BimGo knows.`; }
    return null;
  }

  /**
   * Puts a chord in an action's slot. A clash with a fixed key is refused; another clash is refused unless swap is
   * set, which gives the clashing actions this slot's old chord (or leaves them unbound). The same chord in another of
   * the action's slots moves here.
   */
  assign(action: InputAction, slot: number, chord: KeyChord, swap: boolean): BindResult {
    if (slot < 0 || slot >= KeyMap.ALL_SLOTS) { return { done: false, message: 'No such slot.' }; }
    const refusal = KeyMap.refusal(action, chord, slot);
    if (refusal) { return { done: false, message: refusal }; }

    const def = defOf(action);
    const slots = this.slots[action];
    const old = slots[slot];
    if (old.equals(chord)) { return { done: true, message: null }; }

    const clashes = this.findClashes(action, chord);
    for (const clash of clashes) {
      const other = defOf(clash.action);
      if (other.isFixed) { return { done: false, message: `${chord.toDisplayString(this.keyNameFn)} is reserved for “${other.label}”.` }; }
    }
    if (clashes.length > 0 && !swap) {
      const other = defOf(clashes[0].action);
      return { done: false, message: `${chord.toDisplayString(this.keyNameFn)} is already “${other.label}” (${InputCatalog.contextName(other.context)}).` };
    }

    for (let s = 0; s < KeyMap.ALL_SLOTS; s++) {
      if (s !== slot && slots[s].equals(chord)) { slots[s] = KeyChord.NONE; }
    }
    slots[slot] = chord;

    let message = `${def.label}: ${chord.toDisplayString(this.keyNameFn)}`;
    for (const clash of clashes) {
      const theirs = this.slots[clash.action];
      let give = old;
      if (!give.isEmpty && (KeyMap.refusal(clash.action, give, clash.slot) !== null || theirs.some(c => c.equals(give)) || this.findClashes(clash.action, give).length > 0)) {
        give = KeyChord.NONE;
      }
      theirs[clash.slot] = give;
      message += ` · ${defOf(clash.action).label}${give.isEmpty ? ': unbound' : ': ' + give.toDisplayString(this.keyNameFn)}`;
    }
    this.changed();
    return { done: true, message };
  }

  /** Empties a slot (fixed actions can't be changed). */
  clear(action: InputAction, slot: number): boolean {
    const def = InputCatalog.get(action);
    if (!def || def.isFixed || slot < 0 || slot >= KeyMap.ALL_SLOTS || this.slots[action][slot].isEmpty) { return false; }
    this.slots[action][slot] = KeyChord.NONE;
    this.changed();
    return true;
  }

  /** Two actions trade their gamepad bindings (SWAP STICKS). */
  swapPad(a: InputAction, b: InputAction): void {
    if (!InputCatalog.get(a) || !InputCatalog.get(b)) { return; }
    const t = this.slots[a][KeyMap.PAD_SLOT];
    this.slots[a][KeyMap.PAD_SLOT] = this.slots[b][KeyMap.PAD_SLOT];
    this.slots[b][KeyMap.PAD_SLOT] = t;
    this.changed();
  }

  reset(action: InputAction): void {
    if (!InputCatalog.get(action)) { return; }
    this.setDefaults(action);
    this.changed();
  }

  resetAll(): void {
    for (const def of InputCatalog.all) { this.setDefaults(def.action); }
    this.changed();
  }

  private setDefaults(action: InputAction): void {
    const def = defOf(action);
    const slots = this.slots[action];
    for (let s = 0; s < KeyMap.MAX_SLOTS; s++) { slots[s] = s < def.defaults.length ? def.defaults[s] : KeyChord.NONE; }
    slots[KeyMap.PAD_SLOT] = def.padDefault;
  }

  private changed(): void {
    this.rebuildShadows();
    this.version++;
  }

  // #endregion

  // #region Settings (only the changes are stored)

  /** Actions whose keyboard / mouse keys differ from their defaults: id → slots ("" = empty slot). */
  toOverrides(): Record<string, string[]> {
    const overrides: Record<string, string[]> = {};
    for (const def of InputCatalog.all) {
      if (def.isFixed || this.isKeyDefault(def.action)) { continue; }
      overrides[def.id] = this.slotTexts(def.action);
    }
    return overrides;
  }

  /** Actions whose gamepad binding differs from its default: id → chord ("" = none). */
  toPadOverrides(): Record<string, string> {
    const overrides: Record<string, string> = {};
    for (const def of InputCatalog.all) {
      if (def.isFixed || this.get(def.action, KeyMap.PAD_SLOT).equals(def.padDefault)) { continue; }
      overrides[def.id] = this.get(def.action, KeyMap.PAD_SLOT).toString();
    }
    return overrides;
  }

  private slotTexts(action: InputAction): string[] {
    let last = -1;
    for (let s = 0; s < KeyMap.MAX_SLOTS; s++) { if (!this.get(action, s).isEmpty) { last = s; } }
    const texts: string[] = [];
    for (let s = 0; s <= Math.max(last, 0); s++) { texts.push(this.get(action, s).toString()); }
    return texts;
  }

  /**
   * Starts from the defaults and applies stored changes. Unknown or fixed ids, unreadable keys and refused keys are
   * skipped (listed in problems); clashes are kept.
   * @returns How many actions were set (keys and gamepad counted once each).
   */
  applyOverrides(overrides: Record<string, unknown> | null | undefined, problems: string[] | null = null,
    padOverrides: Record<string, unknown> | null = null): number {
    for (const def of InputCatalog.all) { this.setDefaults(def.action); }
    const applied = new Set<string>();
    if (overrides) {
      for (const [id, value] of Object.entries(overrides)) {
        const texts = Array.isArray(value) ? value.map(v => (typeof v === 'string' ? v : v == null ? '' : '?')) : null;
        if (this.applyOne(id, texts, problems)) { applied.add(id.trim().toLowerCase()); }
      }
    }
    if (padOverrides) {
      for (const [id, value] of Object.entries(padOverrides)) {
        if (this.applyPadOne(id, typeof value === 'string' ? value : value == null ? '' : '?', problems)) { applied.add(id.trim().toLowerCase()); }
      }
    }
    this.changed();
    return applied.size;
  }

  private applyPadOne(id: string, text: string, problems: string[] | null): boolean {
    const action = InputCatalog.fromId(id);
    const def = InputCatalog.get(action);
    if (!def) {
      problems?.push(`Unknown action “${id}” (gamepad)`);
      return false;
    }
    if (def.isFixed) {
      problems?.push(`“${def.label}” is fixed (gamepad)`);
      return false;
    }
    const chord = KeyChord.tryParse(text);
    if (!chord) {
      problems?.push(`“${def.label}”: can't read gamepad “${text}”`);
      return false;
    }
    const refusal = KeyMap.refusal(action, chord, KeyMap.PAD_SLOT);
    if (refusal) {
      problems?.push(`“${def.label}” (gamepad): ${refusal}`);
      return false;
    }
    this.slots[action][KeyMap.PAD_SLOT] = chord;
    return true;
  }

  private applyOne(id: string, texts: string[] | null, problems: string[] | null): boolean {
    const action = InputCatalog.fromId(id);
    const def = InputCatalog.get(action);
    if (!def) {
      problems?.push(`Unknown action “${id}”`);
      return false;
    }
    if (def.isFixed) {
      problems?.push(`“${def.label}” is fixed`);
      return false;
    }
    const chords = new Array<KeyChord>(KeyMap.MAX_SLOTS).fill(KeyChord.NONE);
    const count = Math.min(texts?.length ?? 0, KeyMap.MAX_SLOTS);
    for (let s = 0; s < count; s++) {
      const chord = KeyChord.tryParse(texts![s]);
      if (!chord) {
        problems?.push(`“${def.label}”: can't read “${texts![s]}”`);
        return false;
      }
      const refusal = KeyMap.refusal(action, chord, s);
      if (refusal) {
        problems?.push(`“${def.label}”: ${refusal}`);
        continue;
      }
      if (chord.isEmpty || !chords.some(c => c.equals(chord))) { chords[s] = chord; }
    }
    for (let s = 0; s < KeyMap.MAX_SLOTS; s++) { this.slots[action][s] = chords[s]; }
    return true;
  }

  // #endregion

  // #region Keymap files

  /** The whole map as a keymap file (every rebindable action). */
  export(generator: string): string {
    const bindings: Record<string, string[]> = {};
    const pad: Record<string, string> = {};
    for (const def of InputCatalog.all) {
      if (def.isFixed) { continue; }
      bindings[def.id] = this.slotTexts(def.action);
      pad[def.id] = this.get(def.action, KeyMap.PAD_SLOT).toString();
    }
    return JSON.stringify({ format: KeyMap.FILE_FORMAT, version: KeyMap.FILE_VERSION, generator, bindings, pad }, null, 2);
  }

  /** Reads a keymap file: the defaults, then the file's bindings. A file that isn't a BimGo keymap changes nothing. */
  import(json: string): KeymapImport {
    const refuse = (problem: string): KeymapImport => ({ valid: false, applied: 0, problems: [problem], clashes: 0 });
    let root: unknown;
    try {
      root = JSON.parse(json ?? '');
    } catch (e) {
      return refuse('Not a readable keymap file: ' + (e instanceof Error ? e.message : String(e)));
    }
    if (!root || typeof root !== 'object' || Array.isArray(root) || (root as Record<string, unknown>).format !== KeyMap.FILE_FORMAT) {
      return refuse('Not a BimGo keymap file.');
    }
    const obj = root as Record<string, unknown>;
    const version = typeof obj.version === 'number' ? obj.version : 0;
    if (version > KeyMap.FILE_VERSION) { return refuse(`Made by a newer BimGo (keymap version ${version}).`); }
    const bindings = obj.bindings;
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) { return refuse('The file has no bindings.'); }

    const overrides: Record<string, string[]> = {};
    const problems: string[] = [];
    for (const [id, value] of Object.entries(bindings as Record<string, unknown>)) {
      if (!Array.isArray(value)) {
        problems.push(`“${id}”: not a list of keys`);
        continue;
      }
      overrides[id] = value.map(v => (v == null ? '' : typeof v === 'string' ? v : '?'));
    }
    let padOverrides: Record<string, string> | null = null;
    if (obj.pad && typeof obj.pad === 'object' && !Array.isArray(obj.pad)) {
      padOverrides = {};
      for (const [id, value] of Object.entries(obj.pad as Record<string, unknown>)) {
        padOverrides[id] = value == null ? '' : typeof value === 'string' ? value : '?';
      }
    }
    const applied = this.applyOverrides(overrides, problems, padOverrides);
    return { valid: true, applied, problems, clashes: this.allClashes().length };
  }

  // #endregion

  // #region Text

  /** The primary binding as shown in the UI ("Shift+O"; "unbound"). */
  label(action: InputAction): string {
    this.ensureLabels();
    return this.labels[action] ?? '';
  }

  /** Every binding of the action ("W / ↑"; "unbound"). */
  allLabelsOf(action: InputAction): string {
    this.ensureLabels();
    return this.allLabels[action] ?? '';
  }

  /** One slot's chord as the UI shows it (empty when the slot is empty). */
  slotLabel(action: InputAction, slot: number): string {
    this.ensureLabels();
    return action > 0 && slot >= 0 && slot < KeyMap.ALL_SLOTS ? this.slotLabels[action * KeyMap.ALL_SLOTS + slot] ?? '' : '';
  }

  /** The gamepad binding as the UI shows it (empty when none). */
  padLabel(action: InputAction): string {
    return this.slotLabel(action, KeyMap.PAD_SLOT);
  }

  /** A chord as the UI shows it. */
  display(chord: KeyChord): string {
    return chord.isEmpty ? '' : chord.toDisplayString(this.keyNameFn);
  }

  private ensureLabels(): void {
    if (this.labelsVersion === this.version) { return; }
    const n = this.slots.length;
    this.labels = new Array<string>(n).fill('');
    this.allLabels = new Array<string>(n).fill('');
    this.slotLabels = new Array<string>(n * KeyMap.ALL_SLOTS).fill('');
    for (let a = 1; a < n; a++) {
      if (!InputCatalog.get(a)) { continue; }
      const all: string[] = [];
      for (let s = 0; s < KeyMap.MAX_SLOTS; s++) {
        const chord = this.slots[a][s];
        if (chord.isEmpty) { continue; }
        const text = chord.toDisplayString(this.keyNameFn);
        this.slotLabels[a * KeyMap.ALL_SLOTS + s] = text;
        all.push(text);
      }
      const pad = this.slots[a][KeyMap.PAD_SLOT];
      if (!pad.isEmpty) { this.slotLabels[a * KeyMap.ALL_SLOTS + KeyMap.PAD_SLOT] = pad.toDisplayString(this.keyNameFn); }
      this.labels[a] = all[0] ?? 'unbound';
      this.allLabels[a] = all.length > 0 ? all.join(' / ') : 'unbound';
    }
    this.labelsVersion = this.version;
  }

  /** Consecutive digit keys with the same modifiers read as a range ("1–9", "Shift+1–9"); else the keys joined by spaces. */
  describeRange(first: InputAction, count: number): string {
    const start = this.primary(first);
    let range = count > 1 && !start.isEmpty && start.key >= KeyCodes.D0 && start.key <= KeyCodes.D0 + 9;
    for (let i = 1; range && i < count; i++) {
      const chord = this.primary(first + i);
      range = chord.key === start.key + i && chord.modifiers === start.modifiers;
    }
    if (range) {
      const last = this.primary(first + count - 1);
      return modifierPrefix(start.modifiers) + displayName(start.key) + '–' + displayName(last.key);
    }
    const parts: string[] = [];
    for (let i = 0; i < count; i++) { parts.push(this.label(first + i)); }
    return parts.join(' ');
  }

  /**
   * Several actions' primary keys joined; a shared modifier prefix is written once ("Ctrl+S · Z · Y"). Four
   * single-character keys run together ("WASD") when compact. The wheel pair reads "Wheel".
   */
  describeJoined(separator: string, compact: boolean, ...actions: InputAction[]): string {
    if (actions.length === 0) { return ''; }
    const chords = actions.map(a => this.primary(a));
    if (chords.length === 2 && chords[0].modifiers === 0 && chords[1].modifiers === 0
      && ((chords[0].key === KeyCodes.WHEEL_UP && chords[1].key === KeyCodes.WHEEL_DOWN) || (chords[0].key === KeyCodes.WHEEL_DOWN && chords[1].key === KeyCodes.WHEEL_UP))) {
      return 'Wheel';
    }
    const allBound = chords.every(c => !c.isEmpty);
    if (compact && allBound && chords.every(c => c.modifiers === 0 && [...this.display(c)].length === 1)) {
      return chords.map(c => this.display(c)).join('');
    }
    const common = chords[0].modifiers;
    const shared = allBound && chords.length > 1 && common !== 0 && chords.every(c => c.modifiers === common);
    return chords.map((c, i) => {
      if (c.isEmpty) { return 'unbound'; }
      if (shared && i > 0) { return this.keyNameFn?.(c.key) || displayName(c.key); }
      return this.display(c);
    }).join(separator);
  }

  /** When fine is coarse plus modifiers, those modifiers ("Shift"); else the fine action's key. */
  describeModifierVariant(coarse: InputAction, fine: InputAction): string {
    const a = this.primary(coarse), b = this.primary(fine);
    if (!a.isEmpty && !b.isEmpty && a.key === b.key && (b.modifiers & a.modifiers) === a.modifiers && b.modifiers !== a.modifiers) {
      return modifierPrefix(b.modifiers & ~a.modifiers).replace(/\+$/, '');
    }
    return this.label(fine);
  }

  /**
   * Polish round P-B: an F1 row's key column: its fixed text, or its actions' primary keys joined by " · " (unbound
   * left out; five or more consecutive actions read as a range; the four move keys run together; upper case).
   */
  helpKeys(entry: HelpEntry | null): string {
    if (!entry) { return ''; }
    if (entry.keyText !== null) { return entry.keyText; }
    const actions = entry.actions;
    const isMove = (a: InputAction) => a === InputAction.MoveForward || a === InputAction.MoveBack || a === InputAction.MoveLeft || a === InputAction.MoveRight;
    if (actions.length === 4 && actions.every(isMove)) { return this.describeJoined(' ', true, ...actions).toUpperCase(); }
    if (actions.length === 2 && !this.isUnbound(actions[0]) && !this.isUnbound(actions[1])) {
      return this.describeJoined(' · ', false, actions[0], actions[1]).toUpperCase();
    }
    const parts: string[] = [];
    for (let i = 0; i < actions.length;) {
      let run = 1;
      while (i + run < actions.length && actions[i + run] === actions[i] + run) { run++; }
      if (run >= 5) {
        parts.push(this.describeRange(actions[i], run));
        i += run;
        continue;
      }
      if (!this.isUnbound(actions[i])) { parts.push(this.label(actions[i])); }
      i++;
    }
    return parts.join(' · ').toUpperCase();
  }

  /**
   * Polish round P-B: an F1 row's gamepad column: its actions' pad bindings joined by " · ", a shared prefix written once
   * ("D-pad ← · →"); a stick's four directions read as the stick ("LS"). Empty when the row has none.
   */
  helpPad(entry: HelpEntry | null): string {
    if (!entry) { return ''; }
    const labels: string[] = [];
    for (const action of entry.actions) {
      const label = this.padLabel(action);
      if (label.length > 0 && !labels.includes(label)) { labels.push(label); }
    }
    if (labels.length === 0) { return ''; }
    if (labels.length === 1) { return labels[0]; }
    const first = labels[0];
    let common = first.length;
    for (const label of labels) {
      let n = 0;
      while (n < common && n < label.length && label[n] === first[n]) { n++; }
      common = n;
    }
    const space = first.lastIndexOf(' ', Math.max(0, Math.min(common, first.length) - 1));
    if (space <= 0 || labels.some(l => l.length <= space + 1)) { return labels.join(' · '); }
    const prefix = first.slice(0, space);
    const rests = labels.map(l => l.slice(space + 1));
    if (rests.length === 4 && ['↑', '↓', '←', '→'].every(r => rests.includes(r))) { return prefix; }
    return prefix + ' ' + rests.join(' · ');
  }

  /** The default controls as Markdown tables, one per group (the web README). */
  static defaultsMarkdown(): string {
    const map = new KeyMap();
    let md = '';
    const code = (text: string) => (text.includes('`') ? '`` ' + text + ' ``' : '`' + text + '`');
    for (const context of InputCatalog.CONTEXT_ORDER) {
      md += '\n**' + InputCatalog.contextName(context) + '**';
      const note = InputCatalog.contextNote(context);
      if (note) { md += ' ' + note; }
      md += '\n\n| Action | Keys | Gamepad |\n|---|---|---|\n';
      for (const def of InputCatalog.all) {
        if (def.context !== context) { continue; }
        const keys: string[] = [];
        for (let s = 0; s < KeyMap.MAX_SLOTS; s++) {
          const chord = map.get(def.action, s);
          if (!chord.isEmpty) { keys.push(code(chord.toDisplayString())); }
        }
        md += `| ${def.label} | ${keys.join(' · ')} | ${def.padDefault.isEmpty ? '' : code(def.padDefault.toDisplayString())} |\n`;
      }
    }
    return md;
  }

  // #endregion
}

/** The tab / window keys browsers never pass to a page, or null. */
function browserKeeps(chord: KeyChord): string | null {
  const ctrl = (chord.modifiers & KeyModifiers.Ctrl) !== 0;
  if (!ctrl) { return null; }
  switch (chord.key) {
    case KeyCodes.letter('W'): return 'it closes the tab';
    case KeyCodes.letter('T'): return 'it opens a tab';
    case KeyCodes.letter('N'): return 'it opens a window';
    case KeyCodes.letter('R'): return 'it reloads the page';
    case KeyCodes.letter('C'): case KeyCodes.letter('V'): case KeyCodes.letter('X'): return 'copy and paste';
    case KeyCodes.TAB: case KeyCodes.PAGE_UP: case KeyCodes.PAGE_DOWN: return 'it switches tabs';
    default: return null;
  }
}

