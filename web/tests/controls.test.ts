import { describe, expect, it } from 'vitest';
import { InputAction, InputCatalog, InputContext } from '../src/core/scene/InputCatalog';
import { KeyChord, KeyCodes, KeyModifiers, type KeyState } from '../src/core/scene/KeyChord';
import { KeyMap } from '../src/core/scene/KeyMap';
import { GenericPadMap, PadSource } from '../src/core/scene/GenericPadMap';
import { cleanKeyBindings, cleanPadBindings } from '../src/game/ViewerSettings';

// Port of tests/BimGo.Core.Tests/ControlsTests.cs (input round B2): the action catalogue, default clashes, the
// modifier rule, rebinding with swap, storage and keymap files.

class FakeKeys implements KeyState {
  private readonly downSet = new Set<number>();
  private readonly pressedSet = new Set<number>();
  private readonly repeatedSet = new Set<number>();
  private readonly analog = new Map<number, number>();

  tilt(code: number, amount: number): this {
    this.analog.set(code, amount);
    if (amount >= 0.5) { this.downSet.add(code); }
    return this;
  }

  hold(...codes: number[]): this {
    for (const code of codes) { this.downSet.add(code); }
    return this;
  }

  press(code: number): this {
    this.downSet.add(code);
    this.pressedSet.add(code);
    return this;
  }

  repeat(code: number): this {
    this.downSet.add(code);
    this.repeatedSet.add(code);
    return this;
  }

  isKeyDown(code: number): boolean { return this.downSet.has(code); }
  isKeyPressed(code: number): boolean { return this.pressedSet.has(code); }
  isKeyRepeated(code: number): boolean { return this.repeatedSet.has(code); }
  keyAnalog(code: number): number { return this.analog.get(code) ?? (this.downSet.has(code) ? 1 : 0); }
}

const A = InputAction;
const chord = (text: string) => KeyChord.parse(text);
const same = (a: KeyChord, b: KeyChord) => expect(a.toString()).toBe(b.toString());

describe('InputCatalog', () => {
  it('defines every action once', () => {
    const seen = new Set<InputAction>();
    for (const def of InputCatalog.all) {
      expect(seen.has(def.action), `${def.id} is defined twice`).toBe(false);
      seen.add(def.action);
      expect(InputCatalog.get(def.action)).toBe(def);
      expect(def.label.trim().length).toBeGreaterThan(0);
      expect(def.defaults.length).toBeLessThanOrEqual(KeyMap.MAX_SLOTS);
      expect(InputCatalog.fromId(def.id)).toBe(def.action);
    }
    for (const value of Object.values(InputAction)) {
      if (typeof value !== 'number' || value === A.None) { continue; }
      expect(seen.has(value), `${A[value]} is in the enum but not in the catalogue`).toBe(true);
    }
    expect(InputCatalog.fromId('NoSuchAction')).toBe(A.None);
    expect(InputCatalog.fromId(' saveas ')).toBe(A.SaveAs);
  });

  it('every action can fire somewhere', () => {
    for (const def of InputCatalog.all) {
      expect(InputCatalog.situations.some(s => s.contains(def.action)), `${def.id} is in no situation`).toBe(true);
    }
    for (const value of Object.values(InputContext)) {
      if (typeof value === 'number') { expect(InputCatalog.CONTEXT_ORDER).toContain(value); }
    }
  });

  it('defaults are valid and rebindable', () => {
    for (const def of InputCatalog.all) {
      def.defaults.forEach((c, s) => {
        expect(c.isEmpty).toBe(false);
        expect(c.isPad, `${def.id}: gamepad default in a keyboard slot`).toBe(false);
        if (!def.isFixed) { expect(KeyMap.refusal(def.action, c, s), `${def.id}: default ${c} would be refused`).toBeNull(); }
      });
      if (!def.padDefault.isEmpty) {
        expect(def.padDefault.isPad).toBe(true);
        if (!def.isFixed) { expect(KeyMap.refusal(def.action, def.padDefault, KeyMap.PAD_SLOT)).toBeNull(); }
      }
      if (!def.isFixed) { expect(def.defaults.length > 0 || !def.padDefault.isEmpty, `${def.id} has no default key`).toBe(true); }
    }
  });

  it('defaults have no clash in any situation', () => {
    for (const situation of InputCatalog.situations) {
      const used = new Map<string, InputAction>();
      for (const def of InputCatalog.all) {
        if (!situation.contains(def.action)) { continue; }
        for (const c of [...def.defaults, def.padDefault].filter(x => !x.isEmpty)) {
          const other = used.get(c.toString());
          if (other !== undefined && other !== def.action) { throw new Error(`${situation.name}: ${c} is both ${A[other]} and ${def.id}`); }
          used.set(c.toString(), def.action);
        }
      }
    }
    const map = new KeyMap();
    expect(map.allClashes().length).toBe(0);
    expect(map.allDefault()).toBe(true);
  });

  it('separates contexts that never meet', () => {
    expect(InputCatalog.liveTogether(A.ClearMarkers, A.HoldStepUp)).toBe(false);
    expect(InputCatalog.liveTogether(A.ScanSelectInRevit, A.HoldRotate)).toBe(false);
    expect(InputCatalog.liveTogether(A.Gun1, A.MarkupColour1)).toBe(false);
    expect(InputCatalog.liveTogether(A.ScanHide, A.CommentEdit)).toBe(false);
    expect(InputCatalog.liveTogether(A.Help, A.HoldUp)).toBe(true);
    expect(InputCatalog.liveTogether(A.Back, A.MarkupSave)).toBe(true);
    expect(InputCatalog.liveTogether(A.GizmoDrop, A.FindRoom)).toBe(true);
  });
});

describe('KeyChord', () => {
  it('parses and formats', () => {
    expect(chord('shift+ctrl+s').toString()).toBe('Ctrl+Shift+S');
    expect(chord('Shift').toString()).toBe('Shift');
    expect(chord('Ctrl+Ctrl').toString()).toBe('Ctrl');
    expect(chord('Ctrl+-').toString()).toBe('Ctrl+-');
    expect(chord('XButton1').toString()).toBe('Mouse4');
    expect(chord('PgUp').toString()).toBe('PageUp');
    expect(chord('alt+f4').toString()).toBe('Alt+F4');
    expect(chord('Shift+[').toString()).toBe('Shift+[');
    expect(chord('Key0xE5').equals(new KeyChord(0xe5))).toBe(true);

    expect(KeyChord.tryParse('')?.isEmpty).toBe(true);
    expect(KeyChord.tryParse('Ctrl+Nope')).toBeNull();
    expect(KeyChord.tryParse('S+Ctrl')).toBeNull();
    expect(() => KeyChord.parse('Hyper+Q')).toThrow();

    for (let code = 1; code < 0x102; code++) {
      const text = new KeyChord(code, KeyModifiers.Ctrl).toString();
      const back = KeyChord.tryParse(text);
      expect(back, text).not.toBeNull();
      expect(back!.equals(new KeyChord(code, KeyModifiers.Ctrl)), text).toBe(true);
    }
    for (let i = 0; i < KeyCodes.PAD_COUNT; i++) {
      const c = new KeyChord(KeyCodes.GAMEPAD_FIRST + i, KeyModifiers.PadLB);
      expect(KeyChord.tryParse(c.toString())!.equals(c), c.toString()).toBe(true);
    }
    expect(chord('padlb+padup').toString()).toBe('PadLB+PadUp');
    expect(chord('PadLB+PadUp').toDisplayString()).toBe('LB+D-pad ↑');
    expect(chord('PadLB+PadLB').toString()).toBe('PadLB');
  });

  it('display names', () => {
    expect(chord('Shift+[').toDisplayString()).toBe('Shift+[');
    expect(chord('PageUp').toDisplayString()).toBe('PgUp');
    expect(chord('Up').toDisplayString()).toBe('↑');
    expect(chord('WheelUp').toDisplayString()).toBe('Wheel up');
    expect(chord('Ctrl+Mouse5').toDisplayString()).toBe('Ctrl+Mouse 5');
    expect(chord('[').toDisplayString(code => (code === KeyCodes.OEM_4 ? 'Ü' : null))).toBe('Ü');
  });
});

describe('KeyMap evaluation', () => {
  it('follows the modifier rule', () => {
    const map = new KeyMap();
    const h = KeyCodes.letter('H'), one = KeyCodes.digit(1), z = KeyCodes.letter('Z');

    expect(map.pressed(A.GoHome, new FakeKeys().press(h))).toBe(true);
    expect(map.pressed(A.SetHome, new FakeKeys().press(h))).toBe(false);
    const shiftH = new FakeKeys().hold(KeyCodes.SHIFT).press(h);
    expect(map.pressed(A.SetHome, shiftH)).toBe(true);
    expect(map.pressed(A.GoHome, shiftH)).toBe(false);

    const shift1 = new FakeKeys().hold(KeyCodes.SHIFT).press(one);
    expect(map.pressed(A.Bookmark1, shift1)).toBe(true);
    expect(map.pressed(A.Gun1, shift1)).toBe(false);
    expect(map.pressed(A.Gun1, new FakeKeys().hold(KeyCodes.CTRL).press(one))).toBe(true);

    expect(map.pressed(A.Jump, new FakeKeys().hold(KeyCodes.SHIFT).press(KeyCodes.SPACE))).toBe(true);
    expect(map.down(A.Run, new FakeKeys().hold(KeyCodes.SHIFT))).toBe(true);

    const ctrlZ = new FakeKeys().hold(KeyCodes.CTRL).press(z);
    const ctrlShiftZ = new FakeKeys().hold(KeyCodes.CTRL, KeyCodes.SHIFT).press(z);
    expect(map.pressed(A.Undo, ctrlZ)).toBe(true);
    expect(map.pressed(A.Redo, ctrlZ)).toBe(false);
    expect(map.pressed(A.Redo, ctrlShiftZ)).toBe(true);
    expect(map.pressed(A.Undo, ctrlShiftZ)).toBe(false);
    expect(map.pressed(A.Redo, new FakeKeys().hold(KeyCodes.CTRL).press(KeyCodes.letter('Y')))).toBe(true);

    expect(map.pressed(A.HoldStepDown, ctrlZ)).toBe(true);

    const repeat = new FakeKeys().repeat(KeyCodes.OEM_4);
    expect(map.pressed(A.SunEarlier, repeat)).toBe(false);
    expect(map.pressedOrRepeated(A.SunEarlier, repeat)).toBe(true);
    const shiftRepeat = new FakeKeys().hold(KeyCodes.SHIFT).repeat(KeyCodes.OEM_4);
    expect(map.pressedOrRepeated(A.SunEarlierFine, shiftRepeat)).toBe(true);
    expect(map.pressedOrRepeated(A.SunEarlier, shiftRepeat)).toBe(false);

    expect(map.down(A.MoveForward, new FakeKeys().hold(KeyCodes.CTRL, KeyCodes.letter('W')))).toBe(true);
    expect(map.pressed(A.GunModeNext, new FakeKeys().press(KeyCodes.WHEEL_DOWN))).toBe(true);
    expect(map.pressed(A.NextGun, new FakeKeys().hold(KeyCodes.SHIFT).press(KeyCodes.WHEEL_DOWN))).toBe(true);
    expect(map.pressed(A.NextGun, new FakeKeys().press(KeyCodes.WHEEL_DOWN))).toBe(false);
    expect(map.pressed(A.TourNext, new FakeKeys().press(KeyCodes.LEFT_MOUSE))).toBe(true);
    expect(map.pressed(A.GunPrimary, new FakeKeys().hold(KeyCodes.LEFT_MOUSE))).toBe(false);
  });

  it('gamepad: shoulders, axes and slots', () => {
    const map = new KeyMap();
    expect(map.pressed(A.LevelUp, new FakeKeys().press(KeyCodes.PAD_UP))).toBe(true);
    const lbUp = new FakeKeys().hold(KeyCodes.PAD_LB).press(KeyCodes.PAD_UP);
    expect(map.pressed(A.Shadows, lbUp)).toBe(true);
    expect(map.pressed(A.LevelUp, lbUp)).toBe(false);
    expect(map.pressedSlot(A.Shadows, lbUp)).toBe(KeyMap.PAD_SLOT);
    expect(map.pressedSlot(A.Shadows, new FakeKeys().press(KeyCodes.letter('O')))).toBe(0);
    expect(map.pressedSlot(A.Shadows, new FakeKeys())).toBe(-1);

    expect(map.axis(A.MoveForward, new FakeKeys().tilt(KeyCodes.PAD_LS_UP, 0.4))).toBeCloseTo(0.4, 6);
    expect(map.axis(A.MoveForward, new FakeKeys().tilt(KeyCodes.PAD_LS_UP, 0.4).hold(KeyCodes.letter('W')))).toBeCloseTo(1, 6);
    expect(map.axis(A.MoveForward, new FakeKeys())).toBe(0);
    expect(map.axis(A.LookLeft, new FakeKeys().tilt(KeyCodes.PAD_RS_LEFT, 0.7))).toBeCloseTo(0.7, 6);

    expect(KeyMap.refusal(A.Jump, chord('PadX'), 0)).not.toBeNull();
    expect(KeyMap.refusal(A.Jump, chord('J'), KeyMap.PAD_SLOT)).not.toBeNull();
    expect(KeyMap.refusal(A.Jump, chord('Ctrl+PadX'), KeyMap.PAD_SLOT)).not.toBeNull();
    expect(KeyMap.refusal(A.Jump, chord('PadLB+J'), 0)).not.toBeNull();
    expect(map.assign(A.Fly, KeyMap.PAD_SLOT, chord('PadStart'), true).done).toBe(false);

    expect(map.assign(A.Fly, KeyMap.PAD_SLOT, chord('PadA'), true).done).toBe(true);
    same(map.padChord(A.Fly), chord('PadA'));
    same(map.padChord(A.Jump), chord('PadY'));
    same(map.primary(A.Fly), chord('V'));
    expect(map.allClashes().length).toBe(0);

    map.resetAll();
    map.swapPad(A.MoveForward, A.LookUp);
    same(map.padChord(A.MoveForward), chord('PadRSUp'));
    same(map.padChord(A.LookUp), chord('PadLSUp'));
  });

  it('gamepad bindings are stored apart from keys', () => {
    const map = new KeyMap();
    map.assign(A.Fly, KeyMap.PAD_SLOT, chord('PadRB+PadA'), false);
    map.clear(A.Minimap, KeyMap.PAD_SLOT);
    expect(Object.keys(map.toOverrides()).length).toBe(0);
    const pad = map.toPadOverrides();
    expect(Object.keys(pad).length).toBe(2);
    expect(pad.Fly).toBe('PadRB+PadA');
    expect(pad.Minimap).toBe('');

    const restored = new KeyMap();
    expect(restored.applyOverrides({}, null, cleanPadBindings(JSON.parse(JSON.stringify(pad))))).toBe(2);
    same(restored.padChord(A.Fly), chord('PadRB+PadA'));
    expect(restored.padChord(A.Minimap).isEmpty).toBe(true);
    same(restored.primary(A.Fly), chord('V'));

    const other = new KeyMap();
    expect(other.import(map.export('test')).valid).toBe(true);
    same(other.padChord(A.Fly), chord('PadRB+PadA'));
    const older = other.import('{ "format": "bimgo-keymap", "version": 1, "bindings": { "Help": ["F2"] } }');
    expect(older.valid).toBe(true);
    same(other.padChord(A.Fly), chord('PadY'));
    same(other.primary(A.Help), chord('F2'));

    const problems: string[] = [];
    other.applyOverrides(null, problems, { Jump: 'J', Back: 'PadA', Nope: 'PadA' });
    expect(problems.length).toBe(3);
    same(other.padChord(A.Jump), chord('PadA'));
  });
});

describe('KeyMap rebinding', () => {
  it('refuses reserved and fixed keys', () => {
    const map = new KeyMap();
    expect(map.assign(A.Help, 0, chord('Esc'), true).done).toBe(false);
    expect(map.assign(A.Help, 0, chord('Alt+F4'), true).done).toBe(false);
    expect(map.assign(A.Back, 0, chord('F2'), true).done).toBe(false);
    expect(map.assign(A.Run, 0, chord('WheelUp'), true).done).toBe(false);
    expect(map.assign(A.PhotoTake, 0, chord('LMB'), true).done).toBe(false);
    // The browser's own keys
    expect(map.assign(A.Help, 0, chord('F12'), true).done).toBe(false);
    expect(map.assign(A.Help, 0, chord('Ctrl+W'), true).done).toBe(false);
    expect(map.allDefault()).toBe(true);
  });

  it('needs a swap for a clash', () => {
    const map = new KeyMap();
    const v = chord('V');
    const clashes = map.findClashes(A.Help, v);
    expect(clashes.length).toBe(1);
    expect(clashes[0].action).toBe(A.Fly);
    const refused = map.assign(A.Help, 0, v, false);
    expect(refused.done).toBe(false);
    expect(refused.message).toContain('Fly');
    same(map.get(A.Help, 0), chord('F1'));

    const version = map.version;
    expect(map.assign(A.Help, 0, v, true).done).toBe(true);
    same(map.get(A.Help, 0), v);
    same(map.get(A.Fly, 0), chord('F1'));
    expect(map.version).not.toBe(version);
    expect(map.allClashes().length).toBe(0);
    expect(map.pressed(A.Help, new FakeKeys().press(KeyCodes.letter('V')))).toBe(true);
    expect(map.findClashes(A.HoldStepUp, chord('B')).length).toBe(0);
  });

  it('swap leaves unbound when the old key would clash', () => {
    const map = new KeyMap();
    expect(map.findClashes(A.CommentEdit, chord('F')).length).toBe(0);
    expect(map.assign(A.Fly, 0, chord('B'), true).done).toBe(true);
    same(map.get(A.AddBookmark, 0), chord('V'));
    expect(map.assign(A.MoveForward, 2, chord('K'), true).done).toBe(true);
    expect(map.isUnbound(A.Lights)).toBe(true);
    expect(map.allClashes().length).toBe(0);
    expect(map.assign(A.MoveForward, 1, chord('W'), false).done).toBe(true);
    expect(map.get(A.MoveForward, 0).isEmpty).toBe(true);
    same(map.primary(A.MoveForward), chord('W'));
  });

  it('resets and clears', () => {
    const map = new KeyMap();
    expect(map.clear(A.Jump, 0)).toBe(true);
    expect(map.isUnbound(A.Jump)).toBe(true);
    expect(map.label(A.Jump)).toBe('unbound');
    expect(map.clear(A.Back, 0)).toBe(false);
    map.reset(A.Jump);
    expect(map.label(A.Jump)).toBe('Space');
    expect(map.assign(A.Jump, 0, chord('Mouse4'), false).done).toBe(true);
    map.resetAll();
    expect(map.allDefault()).toBe(true);
  });
});

describe('KeyMap storage and files', () => {
  it('stores only changes', () => {
    const map = new KeyMap();
    expect(Object.keys(map.toOverrides()).length).toBe(0);
    map.assign(A.Help, 0, chord('F2'), false);
    map.clear(A.MoveForward, 1);
    map.clear(A.Fly, 0);
    const overrides = map.toOverrides();
    expect(Object.keys(overrides).length).toBe(3);
    expect(overrides.Help).toEqual(['F2']);
    expect(overrides.MoveForward).toEqual(['W']);
    expect(overrides.Fly).toEqual(['']);

    const restored = new KeyMap();
    const problems: string[] = [];
    expect(restored.applyOverrides(cleanKeyBindings(JSON.parse(JSON.stringify(overrides))), problems)).toBe(3);
    expect(problems.length).toBe(0);
    same(restored.primary(A.Help), chord('F2'));
    expect(restored.get(A.MoveForward, 1).isEmpty).toBe(true);
    expect(restored.isUnbound(A.Fly)).toBe(true);
    expect(restored.isDefault(A.Jump)).toBe(true);
  });

  it('skips what it cannot read', () => {
    const map = new KeyMap();
    const problems: string[] = [];
    expect(map.applyOverrides({
      NoSuchAction: ['F2'], Back: ['F2'], Help: ['Ctrl+Nope'], Jump: ['Esc', 'Mouse4'], Run: ['WheelUp']
    }, problems)).toBe(2);
    expect(problems.length).toBe(5);
    same(map.primary(A.Help), chord('F1'));
    same(map.primary(A.Jump), chord('Mouse4'));
    expect(map.isUnbound(A.Run)).toBe(true);
    same(map.primary(A.Back), chord('Esc'));
  });

  it('cleans stored key bindings', () => {
    const cleaned = cleanKeyBindings({ ' Help ': [' F2 ', null, 'F3', 'F4'], Help: ['F9'], '': ['F5'], Fly: null });
    expect(Object.keys(cleaned).length).toBe(1);
    expect(cleaned.Help).toEqual(['F2', '', 'F3']);
    expect(Object.keys(cleanKeyBindings(null)).length).toBe(0);
  });

  it('round-trips a keymap file', () => {
    const map = new KeyMap();
    map.assign(A.Jump, 1, chord('Mouse4'), false);
    map.assign(A.SunEarlier, 0, chord('Ctrl+['), false);
    const json = map.export('BimGo test');
    expect(json).toContain(KeyMap.FILE_FORMAT);
    expect(json).toContain('"Ctrl+["');

    const other = new KeyMap();
    other.assign(A.Help, 0, chord('F2'), false);
    const result = other.import(json);
    expect(result.valid).toBe(true);
    expect(result.problems.length).toBe(0);
    expect(result.clashes).toBe(0);
    same(other.get(A.Jump, 1), chord('Mouse4'));
    same(other.primary(A.SunEarlier), chord('Ctrl+['));
    same(other.primary(A.Help), chord('F1'));
    expect(Object.keys(other.toOverrides()).sort()).toEqual(Object.keys(map.toOverrides()).sort());
  });

  it('refuses other files', () => {
    const map = new KeyMap();
    map.assign(A.Help, 0, chord('F2'), false);
    expect(map.import('{ "format": "something-else" }').valid).toBe(false);
    expect(map.import('not json').valid).toBe(false);
    expect(map.import('{ "format": "bimgo-keymap", "version": 99, "bindings": {} }').valid).toBe(false);
    same(map.primary(A.Help), chord('F2'));

    const clash = map.import('{ "format": "bimgo-keymap", "version": 1, "bindings": { "Help": ["V"] } }');
    expect(clash.valid).toBe(true);
    expect(clash.clashes).toBe(1);
    expect(map.hasClash(A.Fly)).toBe(true);
  });
});

describe('KeyMap text', () => {
  it('describes keys for help', () => {
    const map = new KeyMap();
    expect(map.describeJoined(' ', true, A.MoveForward, A.MoveLeft, A.MoveBack, A.MoveRight)).toBe('WASD');
    expect(map.describeJoined(' · ', false, A.Save, A.Undo, A.Redo)).toBe('Ctrl+S · Z · Y');
    expect(map.describeJoined(' · ', false, A.GunModePrevious, A.GunModeNext)).toBe('Wheel');
    expect(map.describeJoined(' · ', false, A.PreviousGun, A.NextGun)).toBe('Shift+Wheel up · Wheel down');
    expect(map.describeRange(A.Gun1, 9)).toBe('1–9');
    expect(map.describeRange(A.Bookmark1, 9)).toBe('Shift+1–9');
    expect(map.describeModifierVariant(A.SunEarlier, A.SunEarlierFine)).toBe('Shift');
    expect(map.allLabelsOf(A.MoveForward)).toBe('W / ↑');

    map.assign(A.Gun5, 0, chord('F7'), false);
    expect(map.describeRange(A.Gun1, 9)).toBe('1 2 3 4 F7 6 7 8 9');
    map.assign(A.MoveLeft, 0, chord('Ctrl+K'), false);
    expect(map.describeJoined(' ', true, A.MoveForward, A.MoveLeft, A.MoveBack, A.MoveRight)).toBe('W Ctrl+K S D');
  });
});

describe('GenericPadMap', () => {
  it('reads sources, evaluates, detects and stores', () => {
    for (const text of ['B1', 'B32', 'POVU', 'POVL', 'X+', 'Y-', 'V-']) {
      expect(PadSource.tryParse(text)!.toString()).toBe(text);
    }
    expect(PadSource.tryParse('')!.isNone).toBe(true);
    expect(PadSource.tryParse('B0')).toBeNull();
    expect(PadSource.tryParse('B33')).toBeNull();
    expect(PadSource.tryParse('W+')).toBeNull();
    expect(PadSource.axis(1, -1).opposite.equals(PadSource.axis(1, +1))).toBe(true);

    const map = GenericPadMap.xboxStyleGuess();
    const axes = [0, -0.8, 0.6, 0, 0, 0];
    const analog = new Float32Array(KeyCodes.PAD_COUNT);
    const at = (code: number) => analog[code - KeyCodes.GAMEPAD_FIRST];
    map.evaluate(axes, 1 << 2, 4500, analog);
    expect(at(KeyCodes.PAD_X)).toBe(1);
    expect(at(KeyCodes.PAD_A)).toBe(0);
    expect(at(KeyCodes.PAD_UP)).toBe(1);
    expect(at(KeyCodes.PAD_RIGHT)).toBe(1);
    expect(at(KeyCodes.PAD_DOWN)).toBe(0);
    expect(at(KeyCodes.PAD_LS_UP)).toBeCloseTo(0.8, 6);
    expect(at(KeyCodes.PAD_LS_DOWN)).toBe(0);
    expect(at(KeyCodes.PAD_LT)).toBeCloseTo(0.6, 6);
    expect(at(KeyCodes.PAD_RT)).toBe(0);
    map.evaluate(axes, 0, GenericPadMap.POV_CENTRED, analog);
    expect(at(KeyCodes.PAD_UP)).toBe(0);

    const rest = [0, 0, -1, 0, 0, 0];
    const C = GenericPadMap.POV_CENTRED;
    expect(GenericPadMap.detect(rest, 0, rest, 1 << 4, C).equals(PadSource.button(4))).toBe(true);
    expect(GenericPadMap.detect(rest, 0, rest, 0, 18000).equals(PadSource.pov(2))).toBe(true);
    expect(GenericPadMap.detect(rest, 0, [0, 0, 0.9, 0, 0, 0], 0, C).equals(PadSource.axis(2, +1))).toBe(true);
    expect(GenericPadMap.detect(rest, 0, [0.1, -0.9, -1, 0, 0, 0], 0, C).equals(PadSource.axis(1, -1))).toBe(true);
    expect(GenericPadMap.detect(rest, 1, rest, 1, C).isNone).toBe(true);
    expect(GenericPadMap.atRest(rest, 0, [0.2, 0, -0.9, 0, 0, 0], 0, C)).toBe(true);
    expect(GenericPadMap.atRest(rest, 0, rest, 0, 0)).toBe(false);

    const custom = new GenericPadMap();
    custom.set(KeyCodes.PAD_A, PadSource.button(1));
    custom.setStick(KeyCodes.PAD_RS_UP, PadSource.axis(5, -1), PadSource.axis(2, -1));
    const back = GenericPadMap.fromSettings(custom.toSettings());
    expect(back.get(KeyCodes.PAD_A).equals(PadSource.button(1))).toBe(true);
    expect(back.get(KeyCodes.PAD_RS_DOWN).equals(PadSource.axis(5, +1))).toBe(true);
    expect(back.get(KeyCodes.PAD_RS_RIGHT).equals(PadSource.axis(2, +1))).toBe(true);
    expect(back.mappedCount).toBe(5);
    expect(GenericPadMap.fromSettings(null).get(KeyCodes.PAD_A).equals(PadSource.button(0))).toBe(true);
    const problems: string[] = [];
    GenericPadMap.fromSettings({ PadA: 'B2', Ctrl: 'B1', PadB: 'Q?' }, problems);
    expect(problems.length).toBe(2);
  });
});
