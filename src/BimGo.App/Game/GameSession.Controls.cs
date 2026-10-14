using BimGo.Audio;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Pause menu → CONTROLS (input round B2): every action with up to three keys each, grouped like the catalogue
    /// (<see cref="InputCatalog"/>). Click a key slot, then press the new key, mouse button or wheel notch (Esc cancels;
    /// a modifier on its own binds when released); right-click a slot to clear it; RESET puts one action back; RESET ALL
    /// every action. A key that another action live at the same time already uses asks first: SWAP gives that action
    /// this slot's old key. Search filters by action, group or key. EXPORT / IMPORT write and read a keymap file. Every
    /// change is saved at once (settings.json, per machine).
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private bool _controlsOpen;
        private int _controlsScroll;
        private string _controlsNotice;
        private bool _controlsNoticeError;

        // Search (typing anywhere in the panel goes here)
        private const int CONTROLS_SEARCH_MAX = 40;
        private readonly char[] _controlsSearch = new char[CONTROLS_SEARCH_MAX];
        private int _controlsSearchLength;

        // Key capture: the slot waiting for a key, and a modifier pressed on its own (bound when released)
        private InputAction _captureAction = InputAction.None;
        private int _captureSlot;
        private ushort _captureModifier;
        private KeyModifiers _captureModifierWith;

        // The waiting slot on screen (x, y, w, h): LMB binds only when clicked on it again; elsewhere it cancels
        private System.Numerics.Vector4 _captureRect;

        // A clash waiting for SWAP / CANCEL
        private InputAction _pendingAction = InputAction.None;
        private int _pendingSlot;
        private KeyChord _pendingChord;
        private string _pendingText, _pendingChordText;

        // Typing is ignored for a moment after a key capture (the captured key's character can arrive a frame later)
        private int _controlsTypingPause;

        // Group headings in capitals (made once)
        private static readonly string[] CONTEXT_HEADINGS = BuildContextHeadings();

        private static string[] BuildContextHeadings()
        {
            var headings = new string[Enum.GetValues<InputContext>().Length];
            foreach (InputContext context in Enum.GetValues<InputContext>()) { headings[(int)context] = InputCatalog.ContextName(context).ToUpperInvariant(); }
            return headings;
        }

        // The rows shown (group headers and actions), rebuilt when the search or a binding changes
        private readonly List<(InputContext Context, InputAction Action)> _controlRows = new();
        private string _controlRowsSearch;
        private int _controlRowsVersion = int.MinValue;
        private bool[] _slotClash = Array.Empty<bool>();

        #endregion

        #region Open / close

        /// <summary>True while CONTROLS shows (it replaces the pause menu).</summary>
        private bool IsControlsPanelOpen => _controlsOpen;

        /// <summary>True while a key slot waits for a key (it has every key; Esc cancels).</summary>
        private bool IsCapturingKey => _captureAction != InputAction.None;

        /// <summary>Opens CONTROLS (pausing the walkthrough).</summary>
        private void OpenControls()
        {
            if (!_paused) { SetPaused(true); }
            _controlsOpen = true;
            _controlsNotice = null;
            _controlRowsVersion = int.MinValue;
        }

        /// <summary>
        /// Esc / CLOSE: a clash question is dismissed first; otherwise the panel closes.
        /// </summary>
        /// <returns>True if the panel was open.</returns>
        private bool CloseControls()
        {
            if (!_controlsOpen) { return false; }
            EndKeyCapture();
            if (IsMappingPad)
            {
                EndPadMapping(save: false);
                return true;
            }
            if (_pendingAction != InputAction.None)
            {
                _pendingAction = InputAction.None;
                SetControlsNotice("Not changed", error: false);
                return true;
            }
            _controlsOpen = false;
            return true;
        }

        private void SetControlsNotice(string text, bool error)
        {
            _controlsNotice = text;
            _controlsNoticeError = error;
        }

        #endregion

        #region Key capture

        /// <summary>Starts waiting for a key for an action's slot.</summary>
        private void BeginKeyCapture(InputAction action, int slot)
        {
            _pendingAction = InputAction.None;
            _captureAction = action;
            _captureSlot = slot;
            _captureModifier = KeyCodes.NONE;
            _captureModifierWith = KeyModifiers.None;
            SetControlsNotice(null, false);
        }

        private void EndKeyCapture()
        {
            _captureAction = InputAction.None;
            _captureModifier = KeyCodes.NONE;
        }

        /// <summary>
        /// While a slot waits (called from <see cref="UpdateFrame"/> before anything else reads keys): the first key,
        /// mouse button or wheel notch with the modifiers held becomes the binding; a modifier pressed and released on
        /// its own binds itself (Run = Shift); Esc cancels.
        /// </summary>
        private void UpdateKeyCapture(InputState input)
        {
            if (!_controlsOpen || !_window.IsActive)
            {
                EndKeyCapture();
                return;
            }
            if (input.IsPressed(KeyCodes.ESCAPE))
            {
                EndKeyCapture();
                SetControlsNotice("Not changed", error: false);
                input.ConsumeFrame();
                return;
            }

            KeyModifiers held = HeldModifiers(input);

            // LMB: on the waiting slot it is the binding; anywhere else it cancels (so a stray click doesn't bind it)
            if (input.IsPressed(KeyCodes.LEFT_MOUSE)
                && !Hover(input, _captureRect.X, _captureRect.Y, _captureRect.Z, _captureRect.W))
            {
                EndKeyCapture();
                SetControlsNotice("Not changed", error: false);
                input.ConsumeFrame();
                return;
            }

            // The gamepad column takes gamepad buttons, triggers and stick directions (LB / RB on their own bind when
            // released, or combine with what is pressed while they are held); keys are ignored there except Esc
            if (_captureSlot == KeyMap.PAD_SLOT)
            {
                UpdatePadCapture(input);
                return;
            }

            for (int code = 1; code < 256; code++)
            {
                if (!input.IsPressed(code) || KeyCodes.IsModifier((ushort)code) || IsSideModifier(code)) { continue; }
                FinishKeyCapture(new KeyChord((ushort)code, held));
                input.ConsumeFrame();
                return;
            }
            if (input.Wheel != 0)
            {
                FinishKeyCapture(new KeyChord(input.Wheel > 0 ? KeyCodes.WHEEL_UP : KeyCodes.WHEEL_DOWN, held));
                input.ConsumeFrame();
                return;
            }

            // A modifier on its own: remembered when pressed, bound when released with no other key in between
            foreach (ushort modifier in MODIFIER_KEYS)
            {
                if (input.IsPressed(modifier))
                {
                    _captureModifier = modifier;
                    _captureModifierWith = held & ~KeyCodes.ModifierOf(modifier);
                }
            }
            if (_captureModifier != KeyCodes.NONE && !input.IsDown(_captureModifier))
            {
                FinishKeyCapture(new KeyChord(_captureModifier, _captureModifierWith));
                input.ConsumeFrame();
                return;
            }
            input.ConsumeFrame(); // nothing else reacts to keys while waiting
        }

        private static readonly ushort[] MODIFIER_KEYS = { KeyCodes.SHIFT, KeyCodes.CTRL, KeyCodes.ALT };
        private static readonly ushort[] PAD_SHOULDERS = { KeyCodes.PAD_LB, KeyCodes.PAD_RB };

        /// <summary>Key capture for the gamepad column (build B).</summary>
        private void UpdatePadCapture(InputState input)
        {
            IKeyState keys = input;
            KeyModifiers held = (keys.IsKeyDown(KeyCodes.PAD_LB) ? KeyModifiers.PadLB : KeyModifiers.None)
                | (keys.IsKeyDown(KeyCodes.PAD_RB) ? KeyModifiers.PadRB : KeyModifiers.None);
            for (int i = 0; i < KeyCodes.PAD_COUNT; i++)
            {
                ushort code = (ushort)(KeyCodes.GAMEPAD_FIRST + i);
                if (!keys.IsKeyPressed(code) || KeyCodes.IsModifier(code)) { continue; }
                FinishKeyCapture(new KeyChord(code, held));
                input.ConsumeFrame();
                return;
            }
            foreach (ushort shoulder in PAD_SHOULDERS)
            {
                if (keys.IsKeyPressed(shoulder))
                {
                    _captureModifier = shoulder;
                    _captureModifierWith = held & ~KeyCodes.ModifierOf(shoulder);
                }
            }
            if (_captureModifier != KeyCodes.NONE && !keys.IsKeyDown(_captureModifier))
            {
                FinishKeyCapture(new KeyChord(_captureModifier, _captureModifierWith));
            }
            input.ConsumeFrame();
        }

        /// <summary>Left / right Shift, Ctrl and Alt codes (Windows reports the generic ones, but just in case).</summary>
        private static bool IsSideModifier(int code) => code is >= 0xA0 and <= 0xA5;

        private static KeyModifiers HeldModifiers(InputState input) =>
            (input.IsDown(KeyCodes.SHIFT) ? KeyModifiers.Shift : KeyModifiers.None)
            | (input.IsDown(KeyCodes.CTRL) ? KeyModifiers.Ctrl : KeyModifiers.None)
            | (input.IsDown(KeyCodes.ALT) ? KeyModifiers.Alt : KeyModifiers.None);

        /// <summary>
        /// The captured chord: refused (reserved key, the wheel on a held action, a fixed key's binding), asked about
        /// (a clash), or bound and saved.
        /// </summary>
        private void FinishKeyCapture(KeyChord chord)
        {
            InputAction action = _captureAction;
            int slot = _captureSlot;
            EndKeyCapture();
            _controlsTypingPause = 3;
            KeyMap map = Hotkeys.Map;

            string refusal = KeyMap.Refusal(action, chord);
            if (refusal != null)
            {
                Sound.Play(SoundId.Error);
                SetControlsNotice(refusal, error: true);
                return;
            }

            List<BindingClash> clashes = map.FindClashes(action, chord);
            foreach (BindingClash clash in clashes)
            {
                if (clash.Def.IsFixed)
                {
                    Sound.Play(SoundId.Error);
                    SetControlsNotice($"{map.Display(chord)} is reserved for “{clash.Def.Label}”.", error: true);
                    return;
                }
            }
            if (clashes.Count > 0)
            {
                // Ask: SWAP gives the other action(s) this slot's old key
                KeyChord old = map.Get(action, slot);
                var names = new List<string>(clashes.Count);
                foreach (BindingClash clash in clashes)
                {
                    string name = $"“{clash.Def.Label}” ({InputCatalog.ContextName(clash.Def.Context)})";
                    if (!names.Contains(name)) { names.Add(name); }
                }
                _pendingAction = action;
                _pendingSlot = slot;
                _pendingChord = chord;
                _pendingChordText = map.Display(chord);
                _pendingText = $"{map.Display(chord)} is already {string.Join(" and ", names)}. SWAP gives {(names.Count == 1 ? "it" : "them")} "
                    + (old.IsEmpty ? "no key." : $"{map.Display(old)}.");
                Sound.Play(SoundId.Error);
                return;
            }

            ApplyBinding(action, slot, chord, swap: false);
        }

        /// <summary>Binds, says what happened and saves.</summary>
        private void ApplyBinding(InputAction action, int slot, KeyChord chord, bool swap)
        {
            BindResult result = Hotkeys.Map.Assign(action, slot, chord, swap);
            if (!result.Done)
            {
                Sound.Play(SoundId.Error);
                SetControlsNotice(result.Message, error: true);
                return;
            }
            Sound.Play(SoundId.UiClick);
            SetControlsNotice(result.Message ?? $"{InputCatalog.Get(action).Label}: unchanged", error: false);
            Hotkeys.Save();
        }

        #endregion

        #region Panel

        /// <summary>
        /// Draws CONTROLS full screen: search and file buttons, the clash question or the last notice, the grouped list
        /// (wheel scrolls), CLOSE.
        /// </summary>
        private void BuildControlsPanel()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            int width = _window.Width, height = _window.Height;
            _ui.Rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);
            if (!input.LeftDown) { _activeSlider = -1; }
            bool capturing = IsCapturingKey;
            bool asking = _pendingAction != InputAction.None;
            bool mapping = IsMappingPad;
            bool interactive = !capturing && !asking && !mapping;

            float x = S(56), w = width - S(112);
            float y = S(48);
            _ui.Text(f.Small, x, y, "BIMGO", UiTheme.TEXT_MUTED, S(2.6f));
            y += S(20);
            _ui.Text(f.Title, x, y, "CONTROLS", UiTheme.TEXT, S(2.4f));
            _ui.TextRight(f.Small, x + w, y + S(16), "Click a key to change it · right-click clears it · saved at once · Esc back", UiTheme.TEXT_MUTED, S(0.6f));
            y += S(60);

            // Search box and the file buttons
            if (_controlsTypingPause > 0) { _controlsTypingPause--; }
            else if (interactive) { TypeIntoControlsSearch(input); }
            float boxW = MathF.Min(S(340), w * 0.4f), boxH = S(34);
            _ui.Panel(x, y, boxW, boxH, UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
            float textY = y + boxH * 0.5f - f.Body.LineHeight * 0.5f;
            if (_controlsSearchLength == 0) { _ui.Text(f.Body, x + S(10), textY, "Search: action, group or key (e.g. jump, sun, ctrl)", UiTheme.TEXT_FAINT); }
            else
            {
                float used = _ui.Text(f.Body, x + S(10), textY, _controlsSearch.AsSpan(0, _controlsSearchLength), UiTheme.TEXT);
                if (((int)(_clock * 2f) & 1) == 0) { _ui.Rect(x + S(11) + used, y + S(8), S(2), boxH - S(16), UiTheme.TEXT_SOFT); }
            }
            float bx = x + w;
            bx -= S(150);
            if (SmallButton(f, input, bx, y + S(2), S(150), S(30), "IMPORT…") && interactive) { ImportKeymap(); }
            bx -= S(160);
            if (SmallButton(f, input, bx, y + S(2), S(150), S(30), "EXPORT…") && interactive) { ExportKeymap(); }
            bx -= S(190);
            bool allDefault = Hotkeys.Map.AllDefault();
            if (!allDefault && SmallButton(f, input, bx, y + S(2), S(180), S(30), "RESET ALL", danger: true) && interactive)
            {
                Hotkeys.Map.ResetAll();
                Hotkeys.Save();
                Sound.Play(SoundId.UiClick);
                SetControlsNotice("Every key is back to its default.", error: false);
            }
            y += boxH + S(12);

            // Gamepad tuning (build B): look speed, invert Y, dead zone, trigger threshold, swap sticks
            y += BuildPadTuning(f, input, x, y, w, interactive);

            // The clash question, or the notice
            float noticeH = S(34);
            if (mapping)
            {
                BuildPadMappingStrip(f, input, x, y, w, noticeH);
            }
            else if (asking)
            {
                _ui.Panel(x, y, w, noticeH, UiTheme.PANEL_STRONG, UiTheme.MEASURE_LABEL);
                float buttonsW = S(220);
                _ui.TextWrapped(f.Body, x + S(12), y + noticeH * 0.5f - f.Body.LineHeight * 0.5f, w - buttonsW - S(36), _pendingText, UiTheme.TEXT, maxLines: 1);
                if (SmallButton(f, input, x + w - buttonsW - S(6), y + S(3), S(100), S(28), "SWAP"))
                {
                    InputAction action = _pendingAction;
                    _pendingAction = InputAction.None;
                    ApplyBinding(action, _pendingSlot, _pendingChord, swap: true);
                }
                else if (SmallButton(f, input, x + w - S(116), y + S(3), S(110), S(28), "CANCEL"))
                {
                    _pendingAction = InputAction.None;
                    SetControlsNotice("Not changed", error: false);
                }
            }
            else if (capturing)
            {
                ActionDef def = InputCatalog.Get(_captureAction);
                if (_captureSlot == KeyMap.PAD_SLOT)
                {
                    Text.Clear().Append("Press the gamepad button, trigger, stick direction or LB / RB + button for “").Append(def?.Label ?? string.Empty)
                        .Append("” · LB / RB on their own: press and release · Esc or a click elsewhere cancels");
                }
                else
                {
                    Text.Clear().Append("Press the new key, mouse button or wheel for “").Append(def?.Label ?? string.Empty).Append("” (key ").Append(_captureSlot + 1)
                        .Append(") · a modifier on its own: press and release it · LMB: click this slot again · Esc or a click elsewhere cancels");
                }
                _ui.TextWrapped(f.Body, x, y + S(8), w, Text.Span, UiTheme.ACCENT, maxLines: 1);
            }
            else if (_controlsNotice != null)
            {
                _ui.TextWrapped(f.Body, x, y + S(8), w, _controlsNotice, _controlsNoticeError ? UiTheme.DANGER : UiTheme.MEASURE_TEXT, maxLines: 1);
            }
            y += noticeH + S(10);

            // The list
            float bottom = height - S(48) - S(44) - S(16);
            BuildControlRows(f, input, x, y, w, bottom, interactive);

            if (MenuButton(f, x, height - S(48) - S(44), S(160), "CLOSE", false, false, height: S(44))) { CloseControls(); }
            int clashes = CountSlotClashes();
            if (clashes > 0)
            {
                Text.Clear().Append(clashes).Append(clashes == 1 ? " key clashes" : " keys clash").Append(" (red): change one of each pair");
                _ui.Text(f.Body, x + S(180), height - S(48) - S(30), Text.Span, UiTheme.DANGER);
            }
        }

        /// <summary>
        /// The grouped rows: a header per group (name and note) and a row per action with its three key slots and RESET.
        /// </summary>
        private void BuildControlRows(FontAtlas f, InputState input, float x, float y, float w, float bottom, bool interactive)
        {
            RefreshControlRows();
            KeyMap map = Hotkeys.Map;

            float rowH = S(30);
            float labelW = w * 0.38f;
            float slotW = MathF.Floor((w - labelW - S(110)) / KeyMap.ALL_SLOTS);
            float resetX = x + labelW + slotW * KeyMap.ALL_SLOTS + S(10);

            // Column titles
            _ui.Text(f.Small, x, y, "ACTION", UiTheme.TEXT_MUTED, S(1.4f));
            for (int s = 0; s < KeyMap.ALL_SLOTS; s++)
            {
                if (s == KeyMap.PAD_SLOT) { Text.Clear().Append(Gamepad.Connected ? "GAMEPAD" : "GAMEPAD (none connected)"); }
                else { Text.Clear().Append("KEY ").Append(s + 1); }
                _ui.Text(f.Small, x + labelW + s * slotW + S(4), y, Text.Span, UiTheme.TEXT_MUTED, S(1.4f));
            }
            y += S(22);

            if (_controlRows.Count == 0)
            {
                _ui.Text(f.Body, x, y + S(6), "Nothing matches. Backspace to change the search.", UiTheme.TEXT_MUTED);
                return;
            }

            int visible = Math.Max(1, (int)((bottom - y) / rowH));
            int maxScroll = Math.Max(0, _controlRows.Count - visible);
            if (interactive && input.Wheel != 0) { _controlsScroll -= input.Wheel * 3; }
            _controlsScroll = Math.Clamp(_controlsScroll, 0, maxScroll);
            int last = Math.Min(_controlRows.Count, _controlsScroll + visible);

            for (int i = _controlsScroll; i < last; i++)
            {
                (InputContext context, InputAction action) = _controlRows[i];
                float ry = y + (i - _controlsScroll) * rowH;

                if (action == InputAction.None)
                {
                    // Group header
                    float used = _ui.Text(f.Small, x, ry + S(10), CONTEXT_HEADINGS[(int)context], UiTheme.ACCENT, S(1.4f));
                    string note = InputCatalog.ContextNote(context);
                    if (note != null) { _ui.TextWrapped(f.Body, x + used + S(16), ry + S(8), w - used - S(16), note, UiTheme.TEXT_FAINT, maxLines: 1); }
                    continue;
                }

                ActionDef def = InputCatalog.Get(action);
                bool rowHover = Hover(input, x, ry, w, rowH - S(2));
                _ui.Rect(x, ry, w, rowH - S(2), rowHover ? Rgba.Hex(0xFFFFFF, 0.05f) : ((i & 1) == 0 ? Rgba.Hex(0xFFFFFF, 0.025f) : 0u));
                _ui.TextWrapped(f.Body, x + S(10), ry + S(6), labelW - S(16), def.Label, def.IsFixed ? UiTheme.TEXT_MUTED : UiTheme.TEXT, maxLines: 1);

                for (int s = 0; s < KeyMap.ALL_SLOTS; s++)
                {
                    float sx = x + labelW + s * slotW;
                    float sw = slotW - S(8);
                    KeyChord chord = map.Get(action, s);
                    bool waiting = IsCapturingKey && _captureAction == action && _captureSlot == s;
                    bool pending = _pendingAction == action && _pendingSlot == s;
                    bool clash = SlotClashes(action, s);
                    bool slotHover = interactive && !def.IsFixed && Hover(input, sx, ry + S(2), sw, rowH - S(6));
                    if (waiting) { _captureRect = new System.Numerics.Vector4(sx, ry + S(2), sw, rowH - S(6)); }

                    uint fill = waiting || pending ? Rgba.WithAlpha(UiTheme.ACCENT, 0.25f) : slotHover ? Rgba.Hex(0xFFFFFF, 0.1f) : def.IsFixed ? 0u : UiTheme.CONTROL;
                    uint border = clash ? UiTheme.DANGER : waiting || pending ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER;
                    if (fill != 0u) { _ui.Rect(sx, ry + S(2), sw, rowH - S(6), fill); }
                    if (!def.IsFixed || !chord.IsEmpty) { _ui.Outline(sx, ry + S(2), sw, rowH - S(6), MathF.Max(1f, UiScale), border); }

                    string text = waiting ? "PRESS A KEY…" : pending ? _pendingChordText : map.SlotLabel(action, s);
                    uint colour = clash ? UiTheme.DANGER : waiting || pending ? UiTheme.ACCENT : def.IsFixed ? UiTheme.TEXT_MUTED : UiTheme.TEXT;
                    if (text.Length > 0) { _ui.TextWrapped(f.Mono, sx + S(8), ry + S(7), sw - S(12), text, colour, maxLines: 1); }

                    if (slotHover && input.LeftPressed)
                    {
                        input.ConsumeClicks();
                        Sound.Play(SoundId.UiClick);
                        BeginKeyCapture(action, s);
                        _captureRect = new System.Numerics.Vector4(sx, ry + S(2), sw, rowH - S(6));
                    }
                    else if (slotHover && input.RightPressed && !chord.IsEmpty)
                    {
                        input.ConsumeClicks();
                        if (map.Clear(action, s))
                        {
                            Sound.Play(SoundId.Remove);
                            SetControlsNotice($"{def.Label}: key {s + 1} cleared", error: false);
                            Hotkeys.Save();
                        }
                    }
                }

                if (def.IsFixed)
                {
                    _ui.Text(f.Small, resetX + S(8), ry + S(9), "FIXED", UiTheme.TEXT_FAINT, S(1f));
                }
                else if (!map.IsDefault(action) && interactive)
                {
                    if (SmallButton(f, input, resetX, ry + S(2), S(90), rowH - S(6), "RESET"))
                    {
                        map.Reset(action);
                        Hotkeys.Save();
                        SetControlsNotice($"{def.Label}: {map.AllLabels(action)} (default)", error: false);
                    }
                }
            }

            if (maxScroll > 0)
            {
                Text.Clear().Append(_controlsScroll + 1).Append('–').Append(last).Append(" of ").Append(_controlRows.Count).Append(" rows · wheel to scroll");
                _ui.TextRight(f.Small, x + w, bottom + S(2), Text.Span, UiTheme.TEXT_FAINT);
            }
        }

        /// <summary>
        /// Rebuilds the rows (when the search or a binding changed): every group in display order with the actions that
        /// match every word of the search in their label, group name or keys.
        /// </summary>
        private void RefreshControlRows()
        {
            string search = new string(_controlsSearch, 0, _controlsSearchLength).Trim();
            if (_controlRowsVersion == Hotkeys.Version && _controlRowsSearch == search) { return; }
            if (_controlRowsSearch != search) { _controlsScroll = 0; }
            _controlRowsSearch = search;
            _controlRowsVersion = Hotkeys.Version;
            _controlRows.Clear();

            KeyMap map = Hotkeys.Map;
            string[] words = search.Length == 0 ? Array.Empty<string>() : search.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            foreach (InputContext context in InputCatalog.CONTEXT_ORDER)
            {
                string group = InputCatalog.ContextName(context);
                bool header = false;
                foreach (ActionDef def in InputCatalog.All)
                {
                    if (def.Context != context) { continue; }
                    string keys = map.AllLabels(def.Action) + " " + map.PadLabel(def.Action);
                    bool match = true;
                    foreach (string word in words)
                    {
                        if (def.Label.Contains(word, StringComparison.OrdinalIgnoreCase) || group.Contains(word, StringComparison.OrdinalIgnoreCase)
                            || keys.Contains(word, StringComparison.OrdinalIgnoreCase)) { continue; }
                        match = false;
                        break;
                    }
                    if (!match) { continue; }
                    if (!header)
                    {
                        _controlRows.Add((context, InputAction.None));
                        header = true;
                    }
                    _controlRows.Add((context, def.Action));
                }
            }

            // Which slots clash with another live action's (red)
            int count = InputCatalog.ActionCount * KeyMap.ALL_SLOTS;
            if (_slotClash.Length != count) { _slotClash = new bool[count]; }
            else { Array.Clear(_slotClash); }
            foreach ((BindingClash first, BindingClash second) in map.AllClashes())
            {
                _slotClash[(int)first.Action * KeyMap.ALL_SLOTS + first.Slot] = true;
                _slotClash[(int)second.Action * KeyMap.ALL_SLOTS + second.Slot] = true;
            }
        }

        private bool SlotClashes(InputAction action, int slot)
        {
            int index = (int)action * KeyMap.ALL_SLOTS + slot;
            return index >= 0 && index < _slotClash.Length && _slotClash[index];
        }

        private int CountSlotClashes()
        {
            int count = 0;
            foreach (bool clash in _slotClash)
            {
                if (clash) { count++; }
            }
            return count;
        }

        /// <summary>
        /// Typed characters go into the search (Backspace deletes, Ctrl+Backspace clears; Enter ignored).
        /// </summary>
        private void TypeIntoControlsSearch(InputState input)
        {
            foreach (char c in input.Chars)
            {
                if (c == '\b')
                {
                    if (input.IsDown(KeyCodes.CTRL)) { _controlsSearchLength = 0; }
                    else if (_controlsSearchLength > 0) { _controlsSearchLength--; }
                }
                else if (c >= ' ' && c != 127 && _controlsSearchLength < CONTROLS_SEARCH_MAX)
                {
                    _controlsSearch[_controlsSearchLength++] = c;
                }
            }
        }

        #endregion

        #region Gamepad tuning

        private bool _padTuningDirty;

        /// <summary>
        /// One row of gamepad settings: look speed, dead zone, trigger threshold (sliders), invert Y, SWAP STICKS (look
        /// and move change sticks). Saved when the slider is let go.
        /// </summary>
        /// <returns>The height used.</returns>
        private float BuildPadTuning(FontAtlas f, InputState input, float x, float y, float w, bool interactive)
        {
            float h = S(44);
            float col = S(160);
            _ui.Text(f.Small, x, y + S(4), "GAMEPAD", UiTheme.TEXT_MUTED, S(1.4f));
            _ui.TextWrapped(f.Small, x, y + S(22), col - S(12), Gamepad.Description, Gamepad.Connected ? UiTheme.GOOD : UiTheme.TEXT_FAINT, maxLines: 1);

            // Right of the sliders: Invert Y, then the buttons. When the window is too narrow for the sliders to keep a
            // usable width, the buttons drop to a line of their own under the sliders (right-aligned).
            float buttonW = S(150), buttonH = S(30), gap = S(24);
            bool generic = Gamepad.IsGeneric;
            float buttonsW = generic ? buttonW * 2f + S(10) : buttonW;
            float checkW = S(110);
            float sliderW = (w - col - checkW - gap - buttonsW - gap) / 3f - gap;
            bool oneLine = sliderW >= S(150);
            if (!oneLine) { sliderW = MathF.Max(S(100), (w - col - checkW - gap) / 3f - gap); }

            float sx = x + col;
            if (interactive)
            {
                Text.Clear().Append(Gamepad.LookSensitivity, 2);
                float look = MathF.Round(Slider(f, input, SLIDER_PAD_LOOK, sx, y, sliderW, "Look speed", Text.Span, Gamepad.LookSensitivity, 0.2f, 3f) / 0.05f) * 0.05f;
                if (look != Gamepad.LookSensitivity) { Gamepad.LookSensitivity = look; _padTuningDirty = true; }
                sx += sliderW + gap;

                Text.Clear().Append(Gamepad.DeadZone * 100f, 0).Append(" %");
                float dead = MathF.Round(Slider(f, input, SLIDER_PAD_DEAD, sx, y, sliderW, "Dead zone", Text.Span, Gamepad.DeadZone, 0.05f, 0.6f) / 0.01f) * 0.01f;
                if (dead != Gamepad.DeadZone) { Gamepad.DeadZone = dead; _padTuningDirty = true; }
                sx += sliderW + gap;

                Text.Clear().Append(Gamepad.TriggerThreshold * 100f, 0).Append(" %");
                float trigger = MathF.Round(Slider(f, input, SLIDER_PAD_TRIGGER, sx, y, sliderW, "Trigger threshold", Text.Span, Gamepad.TriggerThreshold, 0.05f, 0.9f) / 0.01f) * 0.01f;
                if (trigger != Gamepad.TriggerThreshold) { Gamepad.TriggerThreshold = trigger; _padTuningDirty = true; }
                sx += sliderW + gap;

                bool invert = Checkbox(f, input, sx, y + S(22), checkW, "Invert Y", Gamepad.InvertY);
                if (invert != Gamepad.InvertY)
                {
                    Gamepad.InvertY = invert;
                    _padTuningDirty = true;
                }

                float by = oneLine ? y + S(14) : y + h;
                float bx = x + w - buttonW;
                if (SmallButton(f, input, bx, by, buttonW, buttonH, "SWAP STICKS"))
                {
                    SwapPadSticks();
                }

                // A generic controller (not XInput): record which of its buttons is which
                bx -= buttonW + S(10);
                if (generic && SmallButton(f, input, bx, by, buttonW, buttonH, "MAP BUTTONS…"))
                {
                    BeginPadMapping();
                }
            }
            if (_padTuningDirty && !input.LeftDown)
            {
                _padTuningDirty = false;
                Hotkeys.Save();
            }
            return (oneLine ? h : h + buttonH + S(6)) + S(8);
        }

        private const int SLIDER_PAD_LOOK = 51, SLIDER_PAD_DEAD = 52, SLIDER_PAD_TRIGGER = 53;

        /// <summary>SWAP STICKS: the look and move actions trade their gamepad bindings (and saved).</summary>
        private void SwapPadSticks()
        {
            KeyMap map = Hotkeys.Map;
            map.SwapPad(InputAction.MoveForward, InputAction.LookUp);
            map.SwapPad(InputAction.MoveBack, InputAction.LookDown);
            map.SwapPad(InputAction.MoveLeft, InputAction.LookLeft);
            map.SwapPad(InputAction.MoveRight, InputAction.LookRight);
            Hotkeys.Save();
            SetControlsNotice($"Sticks swapped: look on {(Gamepad.LookOnRightStick ? "the right" : "the left")} stick, move on {(Gamepad.LookOnRightStick ? "the left" : "the right")}", error: false);
        }

        #endregion

        #region Keymap files

        /// <summary>EXPORT…: the whole map to a keymap file (JSON).</summary>
        private void ExportKeymap()
        {
            string path = FileDialogs.ShowSave(_window.Handle, "Export key bindings", KEYMAP_FILTER,
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "BimGo keys.json", ".json");
            if (path == null) { return; }
            try
            {
                string temp = path + ".tmp";
                File.WriteAllText(temp, Hotkeys.Map.Export("BimGo " + Program.Version));
                File.Move(temp, path, overwrite: true);
                SetControlsNotice($"Exported to {Path.GetFileName(path)}", error: false);
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Keymap export failed: {ex}");
                SetControlsNotice($"Couldn't write {Path.GetFileName(path)}: {ex.Message}", error: true);
            }
        }

        /// <summary>IMPORT…: the defaults, then a keymap file's bindings (saved at once).</summary>
        private void ImportKeymap()
        {
            string path = FileDialogs.ShowOpen(_window.Handle, "Import key bindings", KEYMAP_FILTER, Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
            if (path == null) { return; }
            try
            {
                var info = new FileInfo(path);
                if (info.Length > 1_000_000)
                {
                    SetControlsNotice($"{info.Name} is too big to be a keymap.", error: true);
                    return;
                }
                KeymapImport result = Hotkeys.Map.Import(File.ReadAllText(path));
                if (!result.Valid)
                {
                    SetControlsNotice($"{info.Name}: {(result.Problems.Count > 0 ? result.Problems[0] : "not a keymap")}", error: true);
                    return;
                }
                foreach (string problem in result.Problems) { Utilities.Log_Utils.Write($"Keymap import ({info.Name}): skipped {problem}."); }
                Hotkeys.Save();
                string skipped = result.Problems.Count > 0 ? $" · {result.Problems.Count} skipped (see the log)" : string.Empty;
                string clashes = result.Clashes > 0 ? $" · {result.Clashes} clash{(result.Clashes == 1 ? string.Empty : "es")} to fix (red)" : string.Empty;
                SetControlsNotice($"Imported {info.Name}: {result.Applied} action{(result.Applied == 1 ? string.Empty : "s")} changed from the defaults{skipped}{clashes}", error: result.Clashes > 0);
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Keymap import failed: {ex}");
                SetControlsNotice($"Couldn't read {Path.GetFileName(path)}: {ex.Message}", error: true);
            }
        }

        private const string KEYMAP_FILTER = "BimGo keymap (*.json)|*.json|All files (*.*)|*.*";

        #endregion
    }
}
