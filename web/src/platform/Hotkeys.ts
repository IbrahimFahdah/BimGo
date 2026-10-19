import { type DefaultsChange, type InputAction, InputCatalog } from '../core/scene/InputCatalog';
import { KeyCodes } from '../core/scene/KeyChord';
import { type BindingClash, KeyMap } from '../core/scene/KeyMap';
import type { ViewerSettings } from '../game/ViewerSettings';

/** The punctuation keys' KeyboardEvent.code (the layout map names them). */
const OEM_CODES: [number, string][] = [
  [KeyCodes.OEM_1, 'Semicolon'], [KeyCodes.OEM_PLUS, 'Equal'], [KeyCodes.OEM_COMMA, 'Comma'], [KeyCodes.OEM_MINUS, 'Minus'],
  [KeyCodes.OEM_PERIOD, 'Period'], [KeyCodes.OEM_2, 'Slash'], [KeyCodes.OEM_3, 'Backquote'], [KeyCodes.OEM_4, 'BracketLeft'],
  [KeyCodes.OEM_5, 'Backslash'], [KeyCodes.OEM_6, 'BracketRight'], [KeyCodes.OEM_7, 'Quote'], [KeyCodes.OEM_102, 'IntlBackslash']
];

interface LayoutKeyboard { getLayoutMap?: () => Promise<Map<string, string>> }

// Polish round P-B: the controls defaults version the settings hold (-1: not read yet) and the one the tags compare
let seenVersion = -1;
let tagsSince = Number.MAX_SAFE_INTEGER;
// Per action: changed in a version newer than the one seen when this page loaded (NEW / CHANGED tags)
const fresh = new Map<InputAction, boolean>(); // action → added
let freshChanges: DefaultsChange[] = [];

function refreshFresh(): void {
  fresh.clear();
  freshChanges = InputCatalog.changesSince(tagsSince);
  for (const change of freshChanges) { fresh.set(change.action, (fresh.get(change.action) ?? false) || change.added); }
}

/**
 * The app's key map (port of BimGo.App/Platform/Hotkeys.cs, input round B2): one per browser (the viewer settings keep
 * only the changes), shared by every walkthrough. Code asks for actions through InputState.pressed(action); hints and
 * help read the bound keys from {@link Hotkeys.label} and rebuild their cached text when the version changes.
 */
export const Hotkeys = {
  /** The live map (defaults until a walkthrough reads the settings). */
  map: new KeyMap(),

  /** Changes with every rebinding. */
  get version(): number { return Hotkeys.map.version; },

  /** The action's primary key as the UI shows it ("Shift+O"; "unbound"). */
  label(action: InputAction): string { return Hotkeys.map.label(action); },

  /** The action's keys as the UI shows them ("W / ↑"). */
  allLabels(action: InputAction): string { return Hotkeys.map.allLabelsOf(action); },

  /** Applies the settings' changed bindings over the defaults; anything unreadable is skipped and logged. */
  read(settings: ViewerSettings): void {
    const problems: string[] = [];
    const applied = Hotkeys.map.applyOverrides(settings.keyBindings, problems, settings.padBindings);
    if (applied > 0) { console.info(`Key bindings: ${applied} action${applied === 1 ? '' : 's'} changed from the defaults.`); }
    for (const problem of problems) { console.info(`Key bindings: skipped ${problem}.`); }
    const clashes = Hotkeys.map.allClashes().length;
    if (clashes > 0) { console.info(`Key bindings: ${clashes} clash${clashes === 1 ? '' : 'es'} (shown in red in CONTROLS).`); }

    // Polish round P-B: which controls defaults the user has seen (the tags last for this page)
    seenVersion = Math.max(0, settings.controlsDefaultsVersion);
    if (tagsSince === Number.MAX_SAFE_INTEGER) { tagsSince = seenVersion; }
    refreshFresh();
  },

  /** Puts the changed bindings into the settings (saved by the caller). */
  write(settings: ViewerSettings): void {
    settings.keyBindings = Hotkeys.map.toOverrides();
    settings.padBindings = Hotkeys.map.toPadOverrides();
    if (seenVersion >= 0) { settings.controlsDefaultsVersion = seenVersion; } // P-B
  },

  /** P-B: the defaults this page's tags mark (changed after the version seen when it loaded). */
  get freshChanges(): DefaultsChange[] { return freshChanges; },

  /** P-B: the tag for a row in CONTROLS: "NEW", "CHANGED" or null. */
  freshTag(action: InputAction): string | null {
    const added = fresh.get(action);
    return added === undefined ? null : added ? 'NEW' : 'CHANGED';
  },

  /**
   * P-B: the one-time notice after an update that changed defaults ("Controls: N defaults changed · …"), or null when
   * the user has seen the current defaults. Clashes between a new default and a rebind of theirs are counted.
   */
  pendingDefaultsNotice(): string | null {
    if (seenVersion < 0 || seenVersion >= InputCatalog.DEFAULTS_VERSION) { return null; }
    const changes = InputCatalog.changesSince(seenVersion);
    if (changes.length === 0) { return null; }
    const clashes = Hotkeys.newDefaultClashes(changes).length;
    const clash = clashes === 0 ? '' : ` · ${clashes} clash${clashes === 1 ? '' : 'es'} with your own keys (red)`;
    return `Controls: ${changes.length} default${changes.length === 1 ? '' : 's'} changed${clash} · Esc → CONTROLS`;
  },

  /** P-B: the clashes left in the map that involve a changed default (a rebind of the user's now meets a new default). */
  newDefaultClashes(changes: DefaultsChange[]): [BindingClash, BindingClash][] {
    const changed = new Set(changes.map(c => c.action));
    return Hotkeys.map.allClashes().filter(([first, second]) => changed.has(first.action) || changed.has(second.action));
  },

  /** P-B: the notice was shown: the settings record the current defaults version (the tags stay for this page). */
  markDefaultsSeen(settings: ViewerSettings): void {
    if (seenVersion >= InputCatalog.DEFAULTS_VERSION) { return; }
    seenVersion = InputCatalog.DEFAULTS_VERSION;
    settings.controlsDefaultsVersion = seenVersion;
    settings.save();
  },

  /**
   * Names punctuation keys from the keyboard layout where the browser can tell (Chrome / Edge: a German keyboard's
   * BracketLeft is Ü); elsewhere the US glyphs stay.
   */
  learnLayout(): void {
    const keyboard = (navigator as unknown as { keyboard?: LayoutKeyboard }).keyboard;
    if (!keyboard?.getLayoutMap) { return; }
    keyboard.getLayoutMap().then(layout => {
      const names = new Map<number, string>();
      for (const [vk, code] of OEM_CODES) {
        const glyph = layout.get(code);
        if (glyph && glyph.length === 1 && glyph > ' ') { names.set(vk, glyph.toUpperCase()); }
      }
      if (names.size > 0) { Hotkeys.map.keyName = code => names.get(code) ?? null; }
    }).catch(() => undefined);
  }
};

/**
 * Hint text that names keys (port of KeyHint): built from the current bindings and cached until a binding changes, so
 * panels drawn every frame always show the user's keys without rebuilding strings.
 */
export class KeyHint {
  private textValue = '';
  private builtAt = Number.MIN_SAFE_INTEGER;

  constructor(private readonly build: () => string) {}

  get text(): string {
    const version = Hotkeys.version;
    if (this.builtAt !== version) {
      this.textValue = this.build() ?? '';
      this.builtAt = version;
    }
    return this.textValue;
  }
}

/** An action's key as shown in sentences ("Shift+O"). */
export function keyOf(action: InputAction): string {
  return Hotkeys.label(action);
}

/** An action's key in capitals, for labels and buttons ("SHIFT+O"). */
export function keyUpper(action: InputAction): string {
  return Hotkeys.label(action).toUpperCase();
}
