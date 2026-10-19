import { InputAction, InputCatalog, InputContext } from '../core/scene/InputCatalog';
import { GenericPadMap, PadSource } from '../core/scene/GenericPadMap';
import { KeyChord, KeyCodes, KeyModifiers, type KeyState } from '../core/scene/KeyChord';
import { KeyMap } from '../core/scene/KeyMap';
import { Rgba } from '../engine/ui/Rgba';
import { UiBatch } from '../engine/ui/UiBatch';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { downloadBlob, pickFile } from '../platform/files';
import { PadInput } from '../platform/gamepad';
import { Hotkeys } from '../platform/Hotkeys';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import type { Widgets } from './Menus';
import { PanelSize, ScrollRegion, ShellStyle } from './PanelShell';

const SEARCH_MAX = 40;
const SLIDER_PAD_LOOK = 51, SLIDER_PAD_DEAD = 52, SLIDER_PAD_TRIGGER = 53;
const MODIFIER_KEYS = [KeyCodes.SHIFT, KeyCodes.CTRL, KeyCodes.ALT];
const PAD_SHOULDERS = [KeyCodes.PAD_LB, KeyCodes.PAD_RB];

/** MAP BUTTONS' steps: what to press, and the gamepad code it becomes (stick steps also set the opposite direction). */
const PAD_MAP_STEPS: [number, string][] = [
  [KeyCodes.PAD_A, 'A (the bottom face button)'],
  [KeyCodes.PAD_B, 'B (the right face button)'],
  [KeyCodes.PAD_X, 'X (the left face button)'],
  [KeyCodes.PAD_Y, 'Y (the top face button)'],
  [KeyCodes.PAD_LB, 'LB (left shoulder)'],
  [KeyCodes.PAD_RB, 'RB (right shoulder)'],
  [KeyCodes.PAD_LT, 'LT (left trigger)'],
  [KeyCodes.PAD_RT, 'RT (right trigger)'],
  [KeyCodes.PAD_UP, 'D-pad up'],
  [KeyCodes.PAD_DOWN, 'D-pad down'],
  [KeyCodes.PAD_LEFT, 'D-pad left'],
  [KeyCodes.PAD_RIGHT, 'D-pad right'],
  [KeyCodes.PAD_LS_UP, 'the LEFT stick UP (push it, then let go)'],
  [KeyCodes.PAD_LS_LEFT, 'the LEFT stick LEFT'],
  [KeyCodes.PAD_RS_UP, 'the RIGHT stick UP'],
  [KeyCodes.PAD_RS_LEFT, 'the RIGHT stick LEFT'],
  [KeyCodes.PAD_LS, 'a click of the LEFT stick'],
  [KeyCodes.PAD_RS, 'a click of the RIGHT stick'],
  [KeyCodes.PAD_BACK, "Back / Select (SKIP if there isn't one)"],
  [KeyCodes.PAD_START, "Start (SKIP if there isn't one: LB + RB together will open the menu)"]
];

/**
 * Pause menu → CONTROLS (port of GameSession.Controls.cs and .PadMapping.cs, input round B2): every action with up to
 * three keys and a gamepad binding, grouped like the catalogue. Click a slot, then press the new key, mouse button or
 * wheel notch (Esc cancels; a modifier on its own binds when released); right-click clears a slot; RESET puts one
 * action back; RESET ALL every action. A key another live action uses asks first: SWAP gives that action this slot's
 * old key. Search filters by action, group or key. EXPORT / IMPORT download and read a keymap file (the desktop's
 * format). Every change is saved at once (this browser).
 */
export class ControlsPanel {
  open = false;
  private readonly scroll = new ScrollRegion();
  // Polish round P-B: RESET ALL asks first, listing what it will change
  private resetAllAsk = false;
  private resetAllText = '';
  private notice: string | null = null;
  private noticeError = false;
  private search = '';

  // Key capture: the slot waiting for a key, and a modifier pressed on its own (bound when released)
  private captureAction = InputAction.None;
  private captureSlot = 0;
  private captureModifier = 0;
  private captureModifierWith = 0;
  private captureRect: [number, number, number, number] = [0, 0, 0, 0];

  // A clash waiting for SWAP / CANCEL
  private pendingAction = InputAction.None;
  private pendingSlot = 0;
  private pendingChord = KeyChord.NONE;
  private pendingText = '';
  private pendingChordText = '';

  private typingPause = 0;
  private rows: [InputContext, InputAction][] = [];
  private rowsSearch: string | null = null;
  private rowsVersion = Number.MIN_SAFE_INTEGER;
  private slotClash: boolean[] = [];
  private padTuningDirty = false;

  // MAP BUTTONS
  private padMapStep = -1;
  private padMapWork: GenericPadMap | null = null;
  private readonly padMapRest = new Float32Array(GenericPadMap.AXES);
  private padMapRestButtons = 0;
  private padMapWaitRelease = false;

  constructor(private readonly session: GameSession, private readonly w: Widgets) {}

  private s(v: number): number { return this.session.s(v); }

  /** True while a key slot waits for a key (it has every key; Esc cancels). */
  get capturing(): boolean { return this.captureAction !== InputAction.None; }

  /** True while MAP BUTTONS runs (it has the controller and Esc). */
  get mappingPad(): boolean { return this.padMapStep >= 0; }

  /** True while the search box has the keyboard. */
  get capturesTyping(): boolean { return this.open; }

  show(): void {
    const session = this.session;
    if (!session.paused) { session.setPaused(true); }
    this.open = true;
    this.notice = null;
    this.rowsVersion = Number.MIN_SAFE_INTEGER;
    this.resetAllAsk = false;

    // Polish round P-B: after an update that changed defaults, say what the tags mean
    const fresh = Hotkeys.freshChanges.length;
    if (fresh > 0) {
      this.setNotice(`NEW / CHANGED: ${fresh} default${fresh === 1 ? '' : 's'} this version changed (search “new” or “changed”; a red key clashes with one of yours)`, false);
    }
  }

  /** Esc / CLOSE: a clash question or MAP BUTTONS is dismissed first; otherwise the panel closes. */
  close(): boolean {
    if (!this.open) { return false; }
    this.endKeyCapture();
    if (this.mappingPad) {
      this.endPadMapping(false);
      return true;
    }
    if (this.pendingAction !== InputAction.None || this.resetAllAsk) {
      this.pendingAction = InputAction.None;
      this.resetAllAsk = false;
      this.setNotice('Not changed', false);
      return true;
    }
    this.open = false;
    return true;
  }

  private setNotice(text: string | null, error: boolean): void {
    this.notice = text;
    this.noticeError = error;
  }

  private save(): void {
    this.session.settingsChanged();
  }

  // #region Key capture

  private beginKeyCapture(action: InputAction, slot: number): void {
    this.pendingAction = InputAction.None;
    this.captureAction = action;
    this.captureSlot = slot;
    this.captureModifier = 0;
    this.captureModifierWith = 0;
    this.setNotice(null, false);
  }

  private endKeyCapture(): void {
    this.captureAction = InputAction.None;
    this.captureModifier = 0;
  }

  /**
   * While a slot waits (called before anything else reads keys): the first key, mouse button or wheel notch with the
   * modifiers held becomes the binding; a modifier pressed and released on its own binds itself; Esc cancels.
   */
  updateKeyCapture(input: InputState): void {
    if (!this.open || !document.hasFocus()) {
      this.endKeyCapture();
      return;
    }
    if (input.isPressed(KeyCodes.ESCAPE)) {
      this.endKeyCapture();
      this.setNotice('Not changed', false);
      input.consumeFrame();
      return;
    }
    const held = (input.isDown(KeyCodes.SHIFT) ? KeyModifiers.Shift : 0) | (input.isDown(KeyCodes.CTRL) ? KeyModifiers.Ctrl : 0)
      | (input.isDown(KeyCodes.ALT) ? KeyModifiers.Alt : 0);

    // LMB: on the waiting slot it is the binding; anywhere else it cancels (so a stray click doesn't bind it)
    const [rx, ry, rw, rh] = this.captureRect;
    if (input.isPressed(KeyCodes.LEFT_MOUSE) && !this.w.hover(rx, ry, rw, rh)) {
      this.endKeyCapture();
      this.setNotice('Not changed', false);
      input.consumeFrame();
      return;
    }

    if (this.captureSlot === KeyMap.PAD_SLOT) {
      this.updatePadCapture(input);
      return;
    }

    for (let code = 1; code < 256; code++) {
      if (!input.isPressed(code) || KeyCodes.isModifier(code) || (code >= 0xa0 && code <= 0xa5)) { continue; }
      this.finishKeyCapture(new KeyChord(code, held));
      input.consumeFrame();
      return;
    }
    if (input.wheel !== 0) {
      this.finishKeyCapture(new KeyChord(input.wheel > 0 ? KeyCodes.WHEEL_UP : KeyCodes.WHEEL_DOWN, held));
      input.consumeFrame();
      return;
    }

    // A modifier on its own: remembered when pressed, bound when released with no other key in between
    for (const modifier of MODIFIER_KEYS) {
      if (input.isPressed(modifier)) {
        this.captureModifier = modifier;
        this.captureModifierWith = held & ~KeyCodes.modifierOf(modifier);
      }
    }
    if (this.captureModifier !== 0 && !input.isDown(this.captureModifier)) {
      this.finishKeyCapture(new KeyChord(this.captureModifier, this.captureModifierWith));
    }
    input.consumeFrame(); // nothing else reacts to keys while waiting
  }

  /** Key capture for the gamepad column. */
  private updatePadCapture(input: InputState): void {
    const keys: KeyState = input;
    const held = (keys.isKeyDown(KeyCodes.PAD_LB) ? KeyModifiers.PadLB : 0) | (keys.isKeyDown(KeyCodes.PAD_RB) ? KeyModifiers.PadRB : 0);
    for (let i = 0; i < KeyCodes.PAD_COUNT; i++) {
      const code = KeyCodes.GAMEPAD_FIRST + i;
      if (!keys.isKeyPressed(code) || KeyCodes.isModifier(code)) { continue; }
      this.finishKeyCapture(new KeyChord(code, held));
      input.consumeFrame();
      return;
    }
    for (const shoulder of PAD_SHOULDERS) {
      if (keys.isKeyPressed(shoulder)) {
        this.captureModifier = shoulder;
        this.captureModifierWith = held & ~KeyCodes.modifierOf(shoulder);
      }
    }
    if (this.captureModifier !== 0 && !keys.isKeyDown(this.captureModifier)) {
      this.finishKeyCapture(new KeyChord(this.captureModifier, this.captureModifierWith));
    }
    input.consumeFrame();
  }

  /** The captured chord: refused, asked about (a clash), or bound and saved. */
  private finishKeyCapture(chord: KeyChord): void {
    const action = this.captureAction, slot = this.captureSlot;
    this.endKeyCapture();
    this.typingPause = 3;
    const map = Hotkeys.map, sound = this.session.sound;

    const refusal = KeyMap.refusal(action, chord, slot);
    if (refusal) {
      sound.play(SoundId.Error);
      this.setNotice(refusal, true);
      return;
    }

    const clashes = map.findClashes(action, chord);
    for (const clash of clashes) {
      const def = InputCatalog.get(clash.action)!;
      if (def.isFixed) {
        sound.play(SoundId.Error);
        this.setNotice(`${map.display(chord)} is reserved for “${def.label}”.`, true);
        return;
      }
    }
    if (clashes.length > 0) {
      // Ask: SWAP gives the other action(s) this slot's old key
      const old = map.get(action, slot);
      const names: string[] = [];
      for (const clash of clashes) {
        const def = InputCatalog.get(clash.action)!;
        const name = `“${def.label}” (${InputCatalog.contextName(def.context)})`;
        if (!names.includes(name)) { names.push(name); }
      }
      this.pendingAction = action;
      this.pendingSlot = slot;
      this.pendingChord = chord;
      this.pendingChordText = map.display(chord);
      this.pendingText = `${map.display(chord)} is already ${names.join(' and ')}. SWAP gives ${names.length === 1 ? 'it' : 'them'} `
        + (old.isEmpty ? 'no key.' : `${map.display(old)}.`);
      sound.play(SoundId.Error);
      return;
    }
    this.applyBinding(action, slot, chord, false);
  }

  private applyBinding(action: InputAction, slot: number, chord: KeyChord, swap: boolean): void {
    const result = Hotkeys.map.assign(action, slot, chord, swap);
    if (!result.done) {
      this.session.sound.play(SoundId.Error);
      this.setNotice(result.message, true);
      return;
    }
    this.session.sound.play(SoundId.UiClick);
    this.setNotice(result.message ?? `${InputCatalog.get(action)!.label}: unchanged`, false);
    this.save();
  }

  // #endregion

  // #region Panel

  /**
   * CONTROLS in the panel shell (polish round P-A1): IMPORT / EXPORT / RESET ALL in the header, the search, the gamepad
   * tuning, the clash question or the last notice, the grouped list (a scroll region).
   */
  build(): void {
    const session = this.session, ui = session.ui, f = ui.atlas, w = this.w, input = session.input, shell = session.shell;
    if (!input.leftDown) { w.activeSlider = -1; }
    const asking = this.pendingAction !== InputAction.None || this.resetAllAsk;
    const mapping = this.mappingPad;
    const interactive = !this.capturing && !asking && !mapping;

    // Header: IMPORT… · EXPORT… · RESET ALL on the right
    const allDefault = Hotkeys.map.allDefault();
    const controlsW = this.s(130) * 2 + this.s(UiTheme.GAP_SMALL) * 2 + (allDefault ? 0 : this.s(140));
    const frame = shell.beginPanel(PanelSize.Wide, 'CONTROLS', UiTheme.ACCENT, 'Click a key to change it · right-click clears it · saved at once', controlsW);
    if (shell.headerButton(frame, 'IMPORT…', ShellStyle.Normal, interactive, this.s(130))) { void this.importKeymap(); }
    if (shell.headerButton(frame, 'EXPORT…', ShellStyle.Normal, interactive, this.s(130))) { this.exportKeymap(); }
    if (!allDefault && shell.headerButton(frame, 'RESET ALL', ShellStyle.Danger, interactive, this.s(140))) { this.askResetAll(); } // P-B: asks first
    const x = frame.ix, pw = frame.iw;
    let y = frame.bodyTop;

    // Search box
    if (this.typingPause > 0) { this.typingPause--; }
    else if (interactive) { this.typeIntoSearch(input); }
    const boxW = Math.min(this.s(340), pw * 0.4), boxH = this.s(34);
    ui.panel(x, y, boxW, boxH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
    const textY = y + boxH * 0.5 - f.body.lineHeight * 0.5;
    if (!this.search) { ui.text(f.body, x + this.s(10), textY, 'Search: action, group or key (e.g. jump, sun, ctrl)', UiTheme.TEXT_FAINT); }
    else {
      const used = ui.text(f.body, x + this.s(10), textY, this.search, UiTheme.TEXT);
      if ((Math.trunc(session.clock * 2) & 1) === 0) { ui.rect(x + this.s(11) + used, y + this.s(8), this.s(2), boxH - this.s(16), UiTheme.TEXT_SOFT); }
    }
    y += boxH + this.s(12);

    // Gamepad tuning: look speed, dead zone, trigger threshold, invert Y, swap sticks, map buttons
    y += this.buildPadTuning(f, input, x, y, pw, interactive);

    // MAP BUTTONS, the clash question, the capture prompt or the notice
    const noticeH = this.resetAllAsk ? this.s(54) : this.s(34);
    if (mapping) {
      this.buildPadMappingStrip(f, x, y, pw, noticeH);
    } else if (asking) {
      ui.panel(x, y, pw, noticeH, UiTheme.PANEL_STRONG, UiTheme.MEASURE_LABEL);
      const buttonsW = this.s(220);
      ui.textWrapped(f.body, x + this.s(12), y + noticeH * 0.5 - f.body.lineHeight * 0.5, pw - buttonsW - this.s(36), this.pendingText, UiTheme.TEXT, 1);
      if (w.smallButton(f, x + pw - buttonsW - this.s(6), y + this.s(3), this.s(100), this.s(28), 'SWAP')) {
        const action = this.pendingAction;
        this.pendingAction = InputAction.None;
        this.applyBinding(action, this.pendingSlot, this.pendingChord, true);
      } else if (w.smallButton(f, x + pw - this.s(116), y + this.s(3), this.s(110), this.s(28), 'CANCEL')) {
        this.pendingAction = InputAction.None;
        this.setNotice('Not changed', false);
      }
    } else if (this.resetAllAsk) {
      // P-B: RESET ALL lists what it changes; CONFIRM resets, CANCEL (or Esc) keeps everything
      ui.panel(x, y, pw, noticeH, UiTheme.PANEL_STRONG, UiTheme.DANGER);
      const buttonsW = this.s(240);
      ui.textWrapped(f.body, x + this.s(12), y + this.s(6), pw - buttonsW - this.s(36), this.resetAllText, UiTheme.TEXT, 2);
      const by = y + noticeH * 0.5 - this.s(14);
      if (w.smallButton(f, x + pw - buttonsW - this.s(6), by, this.s(120), this.s(28), 'CONFIRM')) {
        this.resetAllAsk = false;
        Hotkeys.map.resetAll();
        this.save();
        session.sound.play(SoundId.UiClick);
        this.setNotice('Every key is back to its default.', false);
      } else if (w.smallButton(f, x + pw - this.s(116), by, this.s(110), this.s(28), 'CANCEL')) {
        this.resetAllAsk = false;
        this.setNotice('Not changed', false);
      }
    } else if (this.capturing) {
      const def = InputCatalog.get(this.captureAction);
      const text = this.captureSlot === KeyMap.PAD_SLOT
        ? `Press the gamepad button, trigger, stick direction or LB / RB + button for “${def?.label ?? ''}” · LB / RB on their own: press and release · Esc or a click elsewhere cancels`
        : `Press the new key, mouse button or wheel for “${def?.label ?? ''}” (key ${this.captureSlot + 1}) · a modifier on its own: press and release it · LMB: click this slot again · Esc or a click elsewhere cancels`;
      ui.textWrapped(f.body, x, y + this.s(8), pw, text, UiTheme.ACCENT, 1);
    } else if (this.notice) {
      ui.textWrapped(f.body, x, y + this.s(8), pw, this.notice, this.noticeError ? UiTheme.DANGER : UiTheme.MEASURE_TEXT, 1);
    }
    y += noticeH + this.s(10);

    // The list (a scroll region; the wheel is left alone while a key is being captured)
    this.buildRows(f, input, x, y, pw, frame.bodyBottom, interactive);

    const clashes = this.slotClash.filter(c => c).length;
    const clashText = clashes === 0 ? null : `${clashes} ${clashes === 1 ? 'key clashes' : 'keys clash'} (red): change one of each pair`;
    shell.endPanel(frame, clashText, 'Esc goes back · F1 shows the keys for what you are doing');
  }

  /** P-B: RESET ALL lists the actions it would put back (current → default, keys and gamepad) and waits for CONFIRM. */
  private askResetAll(): void {
    const map = Hotkeys.map;
    const defaults = new KeyMap();
    defaults.keyName = map.keyName;
    const parts: string[] = [];
    let count = 0;
    const blank = (label: string) => label ? label : 'none';
    for (const def of InputCatalog.all) {
      if (def.isFixed || map.isDefault(def.action)) { continue; }
      count++;
      if (parts.length >= 6) { continue; }
      const now = map.isKeyDefault(def.action) ? null : `${map.allLabelsOf(def.action)} → ${defaults.allLabelsOf(def.action)}`;
      const pad = map.padChord(def.action).equals(def.padDefault) ? null : `gamepad ${blank(map.padLabel(def.action))} → ${blank(defaults.padLabel(def.action))}`;
      parts.push(`${def.label}: ${[now, pad].filter(p => p !== null).join(', ')}`);
    }
    if (count === 0) { return; }
    const more = count > parts.length ? ` · and ${count - parts.length} more` : '';
    this.resetAllText = `RESET ALL puts ${count} action${count === 1 ? '' : 's'} back to the defaults: ${parts.join(' · ')}${more}`;
    this.resetAllAsk = true;
    this.session.sound.play(SoundId.UiClick);
  }

  /** A header per group (name and note) and a row per action with its three key slots, the gamepad's and RESET. */
  private buildRows(f: FontAtlas, input: InputState, x: number, y: number, pw: number, bottom: number, interactive: boolean): void {
    this.refreshRows();
    const ui = this.session.ui, w = this.w, map = Hotkeys.map;
    const rowH = this.s(30);
    const regionW = pw;
    pw -= this.s(UiTheme.SCROLL_GUTTER); // the columns stop short of the scroll bar
    const labelW = pw * 0.38;
    const slotW = Math.floor((pw - labelW - this.s(110)) / KeyMap.ALL_SLOTS);
    const resetX = x + labelW + slotW * KeyMap.ALL_SLOTS + this.s(10);

    ui.text(f.small, x, y, 'ACTION', UiTheme.TEXT_MUTED, this.s(1.4));
    for (let s = 0; s < KeyMap.ALL_SLOTS; s++) {
      const title = s === KeyMap.PAD_SLOT ? (PadInput.connected ? 'GAMEPAD' : 'GAMEPAD (none connected)') : `KEY ${s + 1}`;
      ui.text(f.small, x + labelW + s * slotW + this.s(4), y, title, UiTheme.TEXT_MUTED, this.s(1.4));
    }
    y += this.s(22);

    if (this.rows.length === 0) {
      ui.text(f.body, x, y + this.s(6), 'Nothing matches. Backspace to change the search.', UiTheme.TEXT_MUTED);
      return;
    }

    const shell = this.session.shell;
    const top = shell.beginScroll(this.scroll, input, x, y, regionW, bottom - y, interactive);
    const [first, last] = this.scroll.visibleRows(rowH, this.rows.length);
    for (let i = first; i < last; i++) {
      const [context, action] = this.rows[i];
      const ry = top + i * rowH;
      if (action === InputAction.None) {
        const used = ui.text(f.small, x, ry + this.s(10), InputCatalog.contextName(context).toUpperCase(), UiTheme.ACCENT, this.s(1.4));
        const note = InputCatalog.contextNote(context);
        if (note) { ui.textWrapped(f.body, x + used + this.s(16), ry + this.s(8), pw - used - this.s(16), note, UiTheme.TEXT_FAINT, 1); }
        continue;
      }

      const def = InputCatalog.get(action)!;
      const rowHover = w.hover(x, ry, pw, rowH - this.s(2));
      const stripe = rowHover ? Rgba.hex(0xffffff, 0.05) : (i & 1) === 0 ? Rgba.hex(0xffffff, 0.025) : 0;
      if (stripe) { ui.rect(x, ry, pw, rowH - this.s(2), stripe); }

      // P-B: NEW / CHANGED (a default this version changed) at the label's right
      const tag = Hotkeys.freshTag(action);
      let tagW = 0;
      if (tag) {
        let tagClash = false; // red: a new default meets one of the user's own keys
        for (let k = 0; k < KeyMap.ALL_SLOTS && !tagClash; k++) { tagClash = this.slotClash[action * KeyMap.ALL_SLOTS + k] === true; }
        const tagColour = tagClash ? UiTheme.DANGER : UiTheme.ACCENT;
        tagW = UiBatch.measure(f.small, tag, this.s(1)) + this.s(12);
        const tx = x + labelW - tagW - this.s(8);
        ui.rect(tx, ry + this.s(6), tagW, rowH - this.s(14), Rgba.withAlpha(tagColour, 0.22));
        ui.text(f.small, tx + this.s(6), ry + this.s(9), tag, tagColour, this.s(1));
        tagW += this.s(8);
      }
      ui.textWrapped(f.body, x + this.s(10), ry + this.s(6), labelW - this.s(16) - tagW, def.label, def.isFixed ? UiTheme.TEXT_MUTED : UiTheme.TEXT, 1);

      for (let s = 0; s < KeyMap.ALL_SLOTS; s++) {
        const sx = x + labelW + s * slotW, sw = slotW - this.s(8), sy = ry + this.s(2), sh = rowH - this.s(6);
        const chord = map.get(action, s);
        const waiting = this.capturing && this.captureAction === action && this.captureSlot === s;
        const pending = this.pendingAction === action && this.pendingSlot === s;
        const clash = this.slotClash[action * KeyMap.ALL_SLOTS + s] === true;
        const slotHover = interactive && !def.isFixed && w.hover(sx, sy, sw, sh);
        if (waiting) { this.captureRect = [sx, sy, sw, sh]; }

        const fill = waiting || pending ? Rgba.withAlpha(UiTheme.ACCENT, 0.25) : slotHover ? Rgba.hex(0xffffff, 0.1) : def.isFixed ? 0 : UiTheme.CONTROL;
        const border = clash ? UiTheme.DANGER : waiting || pending ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER;
        if (fill) { ui.rect(sx, sy, sw, sh, fill); }
        if (!def.isFixed || !chord.isEmpty) { ui.outline(sx, sy, sw, sh, Math.max(1, ui.scale), border); }
        const text = waiting ? 'PRESS A KEY…' : pending ? this.pendingChordText : map.slotLabel(action, s);
        const colour = clash ? UiTheme.DANGER : waiting || pending ? UiTheme.ACCENT : def.isFixed ? UiTheme.TEXT_MUTED : UiTheme.TEXT;
        if (text) { ui.textWrapped(f.mono, sx + this.s(8), ry + this.s(7), sw - this.s(12), text, colour, 1); }

        if (slotHover && input.leftPressed) {
          input.consumeClicks();
          this.session.sound.play(SoundId.UiClick);
          this.beginKeyCapture(action, s);
          this.captureRect = [sx, sy, sw, sh];
        } else if (slotHover && input.rightPressed && !chord.isEmpty) {
          input.consumeClicks();
          if (map.clear(action, s)) {
            this.session.sound.play(SoundId.Remove);
            this.setNotice(`${def.label}: ${s === KeyMap.PAD_SLOT ? 'gamepad' : `key ${s + 1}`} cleared`, false);
            this.save();
          }
        }
      }

      if (def.isFixed) {
        ui.text(f.small, resetX + this.s(8), ry + this.s(9), 'FIXED', UiTheme.TEXT_FAINT, this.s(1));
      } else if (!map.isDefault(action) && interactive) {
        if (w.smallButton(f, resetX, ry + this.s(2), this.s(90), rowH - this.s(6), 'RESET')) {
          map.reset(action);
          this.save();
          this.setNotice(`${def.label}: ${map.allLabelsOf(action)} (default)`, false);
        }
      }
    }

    shell.endScroll(this.scroll, input, top + this.rows.length * rowH);
  }

  /** Every group in display order with the actions matching every word of the search; the clashing slots (red). */
  private refreshRows(): void {
    const search = this.search.trim();
    if (this.rowsVersion === Hotkeys.version && this.rowsSearch === search) { return; }
    if (this.rowsSearch !== search) { this.scroll.reset(); }
    this.rowsSearch = search;
    this.rowsVersion = Hotkeys.version;
    this.rows = [];

    const map = Hotkeys.map;
    const words = search ? search.toLowerCase().split(/\s+/) : [];
    for (const context of InputCatalog.CONTEXT_ORDER) {
      const group = InputCatalog.contextName(context).toLowerCase();
      let header = false;
      for (const def of InputCatalog.all) {
        if (def.context !== context) { continue; }
        const keys = (map.allLabelsOf(def.action) + ' ' + map.padLabel(def.action) + ' ' + (Hotkeys.freshTag(def.action) ?? '')).toLowerCase(); // P-B: "new", "changed"
        const label = def.label.toLowerCase();
        if (!words.every(word => label.includes(word) || group.includes(word) || keys.includes(word))) { continue; }
        if (!header) {
          this.rows.push([context, InputAction.None]);
          header = true;
        }
        this.rows.push([context, def.action]);
      }
    }

    this.slotClash = new Array<boolean>(InputCatalog.actionCount * KeyMap.ALL_SLOTS).fill(false);
    for (const [first, second] of map.allClashes()) {
      this.slotClash[first.action * KeyMap.ALL_SLOTS + first.slot] = true;
      this.slotClash[second.action * KeyMap.ALL_SLOTS + second.slot] = true;
    }
  }

  /** Typed characters go into the search (Backspace deletes, Ctrl+Backspace clears). */
  private typeIntoSearch(input: InputState): void {
    if (input.isPressedOrRepeated(Vk.BACK)) { this.search = input.isDown(Vk.CONTROL) ? '' : this.search.slice(0, -1); }
    for (const c of input.typed) {
      if (c >= ' ' && c !== '\u007f' && this.search.length < SEARCH_MAX) { this.search += c; }
    }
  }

  // #endregion

  // #region Gamepad tuning

  /** One row of gamepad settings (saved when the slider is let go). Returns the height used. */
  private buildPadTuning(f: FontAtlas, input: InputState, x: number, y: number, pw: number, interactive: boolean): number {
    const ui = this.session.ui, w = this.w;
    const h = this.s(44), col = this.s(160);
    ui.text(f.small, x, y + this.s(4), 'GAMEPAD', UiTheme.TEXT_MUTED, this.s(1.4));
    ui.textWrapped(f.small, x, y + this.s(22), col - this.s(12), PadInput.description, PadInput.connected ? UiTheme.GOOD : UiTheme.TEXT_FAINT, 1);

    const buttonW = this.s(150), buttonH = this.s(30), gap = this.s(24);
    const generic = PadInput.isGeneric;
    const buttonsW = generic ? buttonW * 2 + this.s(10) : buttonW;
    const checkW = this.s(110);
    let sliderW = (pw - col - checkW - gap - buttonsW - gap) / 3 - gap;
    const oneLine = sliderW >= this.s(150);
    if (!oneLine) { sliderW = Math.max(this.s(100), (pw - col - checkW - gap) / 3 - gap); }

    let sx = x + col;
    if (interactive) {
      const look = Math.round(w.slider(f, SLIDER_PAD_LOOK, sx, y, sliderW, 'Look speed', PadInput.lookSensitivity.toFixed(2), PadInput.lookSensitivity, 0.2, 3) / 0.05) * 0.05;
      if (look !== PadInput.lookSensitivity) { PadInput.lookSensitivity = look; this.padTuningDirty = true; }
      sx += sliderW + gap;
      const dead = Math.round(w.slider(f, SLIDER_PAD_DEAD, sx, y, sliderW, 'Dead zone', `${Math.round(PadInput.deadZone * 100)} %`, PadInput.deadZone, 0.05, 0.6) / 0.01) * 0.01;
      if (dead !== PadInput.deadZone) { PadInput.deadZone = dead; this.padTuningDirty = true; }
      sx += sliderW + gap;
      const trigger = Math.round(w.slider(f, SLIDER_PAD_TRIGGER, sx, y, sliderW, 'Trigger threshold', `${Math.round(PadInput.triggerThreshold * 100)} %`, PadInput.triggerThreshold, 0.05, 0.9) / 0.01) * 0.01;
      if (trigger !== PadInput.triggerThreshold) { PadInput.triggerThreshold = trigger; this.padTuningDirty = true; }
      sx += sliderW + gap;
      const invert = w.checkbox(f, sx, y + this.s(22), checkW, 'Invert Y', PadInput.invertY);
      if (invert !== PadInput.invertY) {
        PadInput.invertY = invert;
        this.padTuningDirty = true;
      }

      const by = oneLine ? y + this.s(14) : y + h;
      let bx = x + pw - buttonW;
      if (w.smallButton(f, bx, by, buttonW, buttonH, 'SWAP STICKS')) { this.swapSticks(); }
      bx -= buttonW + this.s(10);
      if (generic && w.smallButton(f, bx, by, buttonW, buttonH, 'MAP BUTTONS…')) { this.beginPadMapping(); }
    }
    if (this.padTuningDirty && !input.leftDown) {
      this.padTuningDirty = false;
      this.save();
    }
    return (oneLine ? h : h + buttonH + this.s(6)) + this.s(8);
  }

  /** SWAP STICKS: the look and move actions trade their gamepad bindings. */
  private swapSticks(): void {
    const map = Hotkeys.map;
    map.swapPad(InputAction.MoveForward, InputAction.LookUp);
    map.swapPad(InputAction.MoveBack, InputAction.LookDown);
    map.swapPad(InputAction.MoveLeft, InputAction.LookLeft);
    map.swapPad(InputAction.MoveRight, InputAction.LookRight);
    this.save();
    const right = PadInput.lookOnRightStick;
    this.setNotice(`Sticks swapped: look on ${right ? 'the right' : 'the left'} stick, move on ${right ? 'the left' : 'the right'}`, false);
  }

  // #endregion

  // #region MAP BUTTONS

  /** Starts with the controller's current reading as "at rest". */
  private beginPadMapping(): void {
    if (!PadInput.isGeneric) { return; }
    this.endKeyCapture();
    this.pendingAction = InputAction.None;
    this.padMapWork = new GenericPadMap();
    this.padMapRest.set(PadInput.rawAxes);
    this.padMapRestButtons = PadInput.rawButtons;
    this.padMapStep = 0;
    this.padMapWaitRelease = !GenericPadMap.atRest(this.padMapRest, this.padMapRestButtons, PadInput.rawAxes, PadInput.rawButtons, PadInput.rawPov);
    PadInput.mapping = true;
    this.setNotice(null, false);
  }

  private endPadMapping(save: boolean): void {
    if (this.padMapStep < 0) { return; }
    this.padMapStep = -1;
    PadInput.mapping = false;
    if (save && this.padMapWork) {
      PadInput.genericMap = this.padMapWork;
      this.save();
      this.session.sound.play(SoundId.Commit);
      this.setNotice(`${PadInput.description}: ${this.padMapWork.mappedCount} inputs mapped and saved`, false);
    } else {
      this.setNotice('Map not changed', false);
    }
    this.padMapWork = null;
  }

  /** Each frame while mapping: Esc cancels; after each capture the pad must come back to rest; then the next input counts. */
  updatePadMapping(input: InputState): void {
    if (!this.open || !PadInput.isGeneric) {
      this.endPadMapping(false);
      return;
    }
    if (input.isPressed(KeyCodes.ESCAPE)) {
      this.endPadMapping(false);
      return;
    }
    if (this.padMapWaitRelease) {
      if (GenericPadMap.atRest(this.padMapRest, this.padMapRestButtons, PadInput.rawAxes, PadInput.rawButtons, PadInput.rawPov)) { this.padMapWaitRelease = false; }
      return;
    }
    const source = GenericPadMap.detect(this.padMapRest, this.padMapRestButtons, PadInput.rawAxes, PadInput.rawButtons, PadInput.rawPov);
    if (source.isNone) { return; }
    this.recordStep(source);
    this.padMapWaitRelease = true;
  }

  private recordStep(source: PadSource): void {
    const work = this.padMapWork!;
    const code = PAD_MAP_STEPS[this.padMapStep][0];
    work.set(code, source);
    if (KeyCodes.isPadStick(code)) {
      const offset = (code - KeyCodes.PAD_LS_UP) % 4; // 0 up, 1 down, 2 left, 3 right
      work.set(code + (offset % 2 === 0 ? 1 : -1), source.opposite);
    }
    this.session.sound.play(source.isNone ? SoundId.UiClick : SoundId.Commit);
    this.padMapStep++;
    if (this.padMapStep >= PAD_MAP_STEPS.length) { this.endPadMapping(true); }
  }

  private buildPadMappingStrip(f: FontAtlas, x: number, y: number, pw: number, h: number): void {
    const ui = this.session.ui, w = this.w;
    ui.panel(x, y, pw, h, UiTheme.PANEL_STRONG, UiTheme.ACCENT);
    const buttonsW = this.s(230);
    const text = `MAP BUTTONS ${this.padMapStep + 1} of ${PAD_MAP_STEPS.length}: ${this.padMapWaitRelease ? 'let go of the controller…' : 'press ' + PAD_MAP_STEPS[this.padMapStep][1]}`;
    ui.textWrapped(f.body, x + this.s(12), y + h * 0.5 - f.body.lineHeight * 0.5, pw - buttonsW - this.s(36), text, UiTheme.TEXT, 1);
    if (w.smallButton(f, x + pw - buttonsW - this.s(6), y + this.s(3), this.s(100), this.s(28), 'SKIP')) {
      this.padMapWaitRelease = false;
      this.recordStep(PadSource.NONE);
    } else if (w.smallButton(f, x + pw - this.s(126), y + this.s(3), this.s(120), this.s(28), 'CANCEL')) {
      this.endPadMapping(false);
    }
  }

  // #endregion

  // #region Keymap files

  /** EXPORT…: the whole map as a keymap file (downloaded). */
  private exportKeymap(): void {
    const json = Hotkeys.map.export(`BimGo Web ${__BIMGO_VERSION__}`);
    downloadBlob(new Blob([json], { type: 'application/json' }), 'BimGo keys.json');
    this.setNotice('Exported to BimGo keys.json (your Downloads folder)', false);
  }

  /** IMPORT…: the defaults, then a keymap file's bindings (saved at once). */
  private async importKeymap(): Promise<void> {
    const file = await pickFile('.json,application/json');
    if (!file) { return; }
    try {
      if (file.size > 1_000_000) {
        this.setNotice(`${file.name} is too big to be a keymap.`, true);
        return;
      }
      const result = Hotkeys.map.import(await file.text());
      if (!result.valid) {
        this.setNotice(`${file.name}: ${result.problems[0] ?? 'not a keymap'}`, true);
        return;
      }
      for (const problem of result.problems) { console.info(`Keymap import (${file.name}): skipped ${problem}.`); }
      this.save();
      const skipped = result.problems.length > 0 ? ` · ${result.problems.length} skipped (see the console)` : '';
      const clashes = result.clashes > 0 ? ` · ${result.clashes} clash${result.clashes === 1 ? '' : 'es'} to fix (red)` : '';
      this.setNotice(`Imported ${file.name}: ${result.applied} action${result.applied === 1 ? '' : 's'} changed from the defaults${skipped}${clashes}`, result.clashes > 0);
    } catch (e) {
      this.setNotice(`Couldn't read ${file.name}: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  // #endregion
}
