using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Input round B2: the action catalogue, default clashes, the modifier rule, rebinding with swap, storage, keymap
    /// files and the generated README §3 controls.
    /// </summary>
    [TestClass]
    public sealed class ControlsTests
    {
        #region Fake key state

        /// <summary>Keys held and pressed this frame, for the evaluation tests.</summary>
        private sealed class FakeKeys : IKeyState
        {
            private readonly HashSet<ushort> _down = new(), _pressed = new(), _repeated = new();
            private readonly Dictionary<ushort, float> _analog = new();

            public FakeKeys Tilt(ushort code, float amount)
            {
                _analog[code] = amount;
                if (amount >= 0.5f) { _down.Add(code); }
                return this;
            }

            public FakeKeys Hold(params ushort[] codes)
            {
                foreach (ushort code in codes) { _down.Add(code); }
                return this;
            }

            public FakeKeys Press(ushort code)
            {
                _down.Add(code);
                _pressed.Add(code);
                return this;
            }

            public FakeKeys Repeat(ushort code)
            {
                _down.Add(code);
                _repeated.Add(code);
                return this;
            }

            public bool IsKeyDown(ushort code) => _down.Contains(code);
            public bool IsKeyPressed(ushort code) => _pressed.Contains(code);
            public bool IsKeyRepeated(ushort code) => _repeated.Contains(code);
            public float KeyAnalog(ushort code) => _analog.TryGetValue(code, out float value) ? value : _down.Contains(code) ? 1f : 0f;
        }

        #endregion

        #region Catalogue

        [TestMethod]
        public void Catalogue_DefinesEveryActionOnce()
        {
            var seen = new HashSet<InputAction>();
            foreach (ActionDef def in InputCatalog.All)
            {
                Assert.IsTrue(seen.Add(def.Action), $"{def.Action} is defined twice");
                Assert.AreSame(def, InputCatalog.Get(def.Action));
                Assert.IsFalse(string.IsNullOrWhiteSpace(def.Label), $"{def.Action} has no label");
                Assert.IsTrue(def.Defaults.Count <= KeyMap.MAX_SLOTS, $"{def.Action} has too many defaults");
                Assert.AreEqual(def.Action, InputCatalog.FromId(def.Id));
            }
            foreach (InputAction action in Enum.GetValues<InputAction>())
            {
                if (action == InputAction.None) { continue; }
                Assert.IsTrue(seen.Contains(action), $"{action} is in the enum but not in the catalogue");
            }
            Assert.AreEqual(InputAction.None, InputCatalog.FromId("NoSuchAction"));
            Assert.AreEqual(InputAction.SaveAs, InputCatalog.FromId(" saveas "));
        }

        [TestMethod]
        public void Catalogue_EveryActionCanFireSomewhere()
        {
            foreach (ActionDef def in InputCatalog.All)
            {
                Assert.IsTrue(InputCatalog.Situations.Any(s => s.Contains(def.Action)), $"{def.Action} is in no situation");
            }
            foreach (InputContext context in Enum.GetValues<InputContext>())
            {
                Assert.IsTrue(InputCatalog.CONTEXT_ORDER.Contains(context), $"{context} is missing from the display order");
            }
        }

        [TestMethod]
        public void Defaults_AreValidAndRebindable()
        {
            foreach (ActionDef def in InputCatalog.All)
            {
                for (int s = 0; s < def.Defaults.Count; s++)
                {
                    KeyChord chord = def.Defaults[s];
                    Assert.IsFalse(chord.IsEmpty, $"{def.Action} has an empty default");
                    Assert.IsFalse(chord.IsPad, $"{def.Action}: gamepad default {chord} in a keyboard slot");
                    if (!def.IsFixed) { Assert.IsNull(KeyMap.Refusal(def.Action, chord, s), $"{def.Action}: default {chord} would be refused"); }
                }
                if (!def.PadDefault.IsEmpty)
                {
                    Assert.IsTrue(def.PadDefault.IsPad, $"{def.Action}: gamepad default {def.PadDefault} isn't a gamepad input");
                    if (!def.IsFixed) { Assert.IsNull(KeyMap.Refusal(def.Action, def.PadDefault, KeyMap.PAD_SLOT), $"{def.Action}: gamepad default would be refused"); }
                }
                if (!def.IsFixed) { Assert.IsTrue(def.Defaults.Count > 0 || !def.PadDefault.IsEmpty, $"{def.Action} has no default key"); }
            }
        }

        [TestMethod]
        public void Defaults_HaveNoClashInAnySituation()
        {
            // Independent of KeyMap: per situation, no chord is used by two live actions
            foreach (InputSituation situation in InputCatalog.Situations)
            {
                var used = new Dictionary<KeyChord, InputAction>();
                foreach (ActionDef def in InputCatalog.All)
                {
                    if (!situation.Contains(def.Action)) { continue; }
                    foreach (KeyChord chord in def.Defaults.Append(def.PadDefault).Where(c => !c.IsEmpty))
                    {
                        if (used.TryGetValue(chord, out InputAction other) && other != def.Action)
                        {
                            Assert.Fail($"{situation.Name}: {chord} is both {other} and {def.Action}");
                        }
                        used[chord] = def.Action;
                    }
                }
            }

            // And the map agrees
            var map = new KeyMap();
            Assert.AreEqual(0, map.AllClashes().Count);
            Assert.IsTrue(map.AllDefault());
        }

        [TestMethod]
        public void Situations_SeparateContextsThatNeverMeet()
        {
            // The same letter is fine in groups that are never live together
            Assert.IsFalse(InputCatalog.LiveTogether(InputAction.ClearMarkers, InputAction.HoldStepUp)); // X walking vs X holding
            Assert.IsFalse(InputCatalog.LiveTogether(InputAction.ScanSelectInRevit, InputAction.HoldRotate)); // R
            Assert.IsFalse(InputCatalog.LiveTogether(InputAction.Gun1, InputAction.MarkupColour1));
            Assert.IsFalse(InputCatalog.LiveTogether(InputAction.ScanHide, InputAction.CommentEdit)); // two guns
            Assert.IsTrue(InputCatalog.LiveTogether(InputAction.Help, InputAction.HoldUp)); // F1 works while holding
            Assert.IsTrue(InputCatalog.LiveTogether(InputAction.Back, InputAction.MarkupSave)); // Esc everywhere
            Assert.IsTrue(InputCatalog.LiveTogether(InputAction.GizmoDrop, InputAction.FindRoom)); // F vs Ctrl+F
        }

        #endregion

        #region Chords

        [TestMethod]
        public void Chords_ParseAndFormat()
        {
            Assert.AreEqual("Ctrl+Shift+S", KeyChord.Parse("shift+ctrl+s").ToString());
            Assert.AreEqual("Shift", KeyChord.Parse("Shift").ToString());
            Assert.AreEqual("Ctrl", KeyChord.Parse("Ctrl+Ctrl").ToString());
            Assert.AreEqual("Ctrl+-", KeyChord.Parse("Ctrl+-").ToString());
            Assert.AreEqual("Mouse4", KeyChord.Parse("XButton1").ToString());
            Assert.AreEqual("PageUp", KeyChord.Parse("PgUp").ToString());
            Assert.AreEqual("Alt+F4", KeyChord.Parse("alt+f4").ToString());
            Assert.AreEqual("Shift+[", KeyChord.Parse("Shift+[").ToString());
            Assert.AreEqual(new KeyChord(0xE5), KeyChord.Parse("Key0xE5"));

            Assert.IsTrue(KeyChord.TryParse("", out KeyChord empty));
            Assert.IsTrue(empty.IsEmpty);
            Assert.IsFalse(KeyChord.TryParse("Ctrl+Nope", out _));
            Assert.IsFalse(KeyChord.TryParse("S+Ctrl", out _)); // modifiers come first
            Assert.ThrowsExactly<FormatException>(() => KeyChord.Parse("Hyper+Q"));

            // Every named code round-trips (keys with Ctrl, gamepad codes with LB)
            for (ushort code = 1; code < 0x102; code++)
            {
                string text = new KeyChord(code, KeyModifiers.Ctrl).ToString();
                Assert.IsTrue(KeyChord.TryParse(text, out KeyChord back), text);
                Assert.AreEqual(new KeyChord(code, KeyModifiers.Ctrl), back, text);
            }
            for (int i = 0; i < KeyCodes.PAD_COUNT; i++)
            {
                var chord = new KeyChord((ushort)(KeyCodes.GAMEPAD_FIRST + i), KeyModifiers.PadLB);
                Assert.IsTrue(KeyChord.TryParse(chord.ToString(), out KeyChord back), chord.ToString());
                Assert.AreEqual(chord, back, chord.ToString());
            }
            Assert.AreEqual("PadLB+PadUp", KeyChord.Parse("padlb+padup").ToString());
            Assert.AreEqual("LB+D-pad ↑", KeyChord.Parse("PadLB+PadUp").ToDisplayString());
            Assert.AreEqual("PadLB", KeyChord.Parse("PadLB+PadLB").ToString());
        }

        [TestMethod]
        public void Chords_DisplayNames()
        {
            Assert.AreEqual("Shift+[", KeyChord.Parse("Shift+[").ToDisplayString());
            Assert.AreEqual("PgUp", KeyChord.Parse("PageUp").ToDisplayString());
            Assert.AreEqual("↑", KeyChord.Parse("Up").ToDisplayString());
            Assert.AreEqual("Wheel up", KeyChord.Parse("WheelUp").ToDisplayString());
            Assert.AreEqual("Ctrl+Mouse 5", KeyChord.Parse("Ctrl+Mouse5").ToDisplayString());
            Assert.AreEqual("Ü", KeyChord.Parse("[").ToDisplayString(code => code == KeyCodes.OEM_4 ? "Ü" : null));
        }

        #endregion

        #region Evaluation

        [TestMethod]
        public void Evaluation_ModifierRule()
        {
            var map = new KeyMap();
            ushort h = KeyCodes.Letter('H'), one = KeyCodes.Digit(1), z = KeyCodes.Letter('Z');

            // H goes home; Shift+H sets home instead
            Assert.IsTrue(map.Pressed(InputAction.GoHome, new FakeKeys().Press(h)));
            Assert.IsFalse(map.Pressed(InputAction.SetHome, new FakeKeys().Press(h)));
            FakeKeys shiftH = new FakeKeys().Hold(KeyCodes.SHIFT).Press(h);
            Assert.IsTrue(map.Pressed(InputAction.SetHome, shiftH));
            Assert.IsFalse(map.Pressed(InputAction.GoHome, shiftH));

            // Shift+1 is a bookmark, not gun 1; Ctrl+1 is still gun 1 (extra modifiers don't stop a binding)
            FakeKeys shift1 = new FakeKeys().Hold(KeyCodes.SHIFT).Press(one);
            Assert.IsTrue(map.Pressed(InputAction.Bookmark1, shift1));
            Assert.IsFalse(map.Pressed(InputAction.Gun1, shift1));
            Assert.IsTrue(map.Pressed(InputAction.Gun1, new FakeKeys().Hold(KeyCodes.CTRL).Press(one)));

            // Running jump
            Assert.IsTrue(map.Pressed(InputAction.Jump, new FakeKeys().Hold(KeyCodes.SHIFT).Press(KeyCodes.SPACE)));
            Assert.IsTrue(map.Down(InputAction.Run, new FakeKeys().Hold(KeyCodes.SHIFT)));

            // Ctrl+Z undo, Ctrl+Shift+Z redo (both of Redo's keys work)
            FakeKeys ctrlZ = new FakeKeys().Hold(KeyCodes.CTRL).Press(z);
            FakeKeys ctrlShiftZ = new FakeKeys().Hold(KeyCodes.CTRL, KeyCodes.SHIFT).Press(z);
            Assert.IsTrue(map.Pressed(InputAction.Undo, ctrlZ));
            Assert.IsFalse(map.Pressed(InputAction.Redo, ctrlZ));
            Assert.IsTrue(map.Pressed(InputAction.Redo, ctrlShiftZ));
            Assert.IsFalse(map.Pressed(InputAction.Undo, ctrlShiftZ));
            Assert.IsTrue(map.Pressed(InputAction.Redo, new FakeKeys().Hold(KeyCodes.CTRL).Press(KeyCodes.Letter('Y'))));

            // Holding an element: Z steps down even with Ctrl held (undo isn't live there)
            Assert.IsTrue(map.Pressed(InputAction.HoldStepDown, ctrlZ));

            // Sun time: [ steps 5 min, Shift+[ 1 min, both on auto-repeat
            FakeKeys repeat = new FakeKeys().Repeat(KeyCodes.OEM_4);
            Assert.IsFalse(map.Pressed(InputAction.SunEarlier, repeat));
            Assert.IsTrue(map.PressedOrRepeated(InputAction.SunEarlier, repeat));
            FakeKeys shiftRepeat = new FakeKeys().Hold(KeyCodes.SHIFT).Repeat(KeyCodes.OEM_4);
            Assert.IsTrue(map.PressedOrRepeated(InputAction.SunEarlierFine, shiftRepeat));
            Assert.IsFalse(map.PressedOrRepeated(InputAction.SunEarlier, shiftRepeat));

            // Held movement ignores modifiers; the wheel and mouse buttons are keys like any other
            Assert.IsTrue(map.Down(InputAction.MoveForward, new FakeKeys().Hold(KeyCodes.CTRL, KeyCodes.Letter('W'))));
            Assert.IsTrue(map.Pressed(InputAction.GunModeNext, new FakeKeys().Press(KeyCodes.WHEEL_DOWN)));
            Assert.IsTrue(map.Pressed(InputAction.NextGun, new FakeKeys().Hold(KeyCodes.SHIFT).Press(KeyCodes.WHEEL_DOWN)));
            Assert.IsFalse(map.Pressed(InputAction.NextGun, new FakeKeys().Press(KeyCodes.WHEEL_DOWN)), "the plain wheel steps gun modes now (polish round)");
            Assert.IsTrue(map.Pressed(InputAction.TourNext, new FakeKeys().Press(KeyCodes.LEFT_MOUSE)));
            Assert.IsFalse(map.Pressed(InputAction.GunPrimary, new FakeKeys().Hold(KeyCodes.LEFT_MOUSE)));
        }

        [TestMethod]
        public void Gamepad_ShouldersAxesAndSlots()
        {
            var map = new KeyMap();

            // D-pad ↑ changes level; LB + D-pad ↑ toggles shadows instead
            Assert.IsTrue(map.Pressed(InputAction.LevelUp, new FakeKeys().Press(KeyCodes.PAD_UP)));
            FakeKeys lbUp = new FakeKeys().Hold(KeyCodes.PAD_LB).Press(KeyCodes.PAD_UP);
            Assert.IsTrue(map.Pressed(InputAction.Shadows, lbUp));
            Assert.IsFalse(map.Pressed(InputAction.LevelUp, lbUp));
            Assert.AreEqual(KeyMap.PAD_SLOT, map.PressedSlot(InputAction.Shadows, lbUp));
            Assert.AreEqual(0, map.PressedSlot(InputAction.Shadows, new FakeKeys().Press(KeyCodes.Letter('O'))));
            Assert.AreEqual(-1, map.PressedSlot(InputAction.Shadows, new FakeKeys()));

            // Analog: half tilt on the move stick, keys 0 / 1, the largest binding wins
            Assert.AreEqual(0.4f, map.Axis(InputAction.MoveForward, new FakeKeys().Tilt(KeyCodes.PAD_LS_UP, 0.4f)), 1e-6f);
            Assert.AreEqual(1f, map.Axis(InputAction.MoveForward, new FakeKeys().Tilt(KeyCodes.PAD_LS_UP, 0.4f).Hold(KeyCodes.Letter('W'))), 1e-6f);
            Assert.AreEqual(0f, map.Axis(InputAction.MoveForward, new FakeKeys()), 1e-6f);
            Assert.AreEqual(0.7f, map.Axis(InputAction.LookLeft, new FakeKeys().Tilt(KeyCodes.PAD_RS_LEFT, 0.7f)), 1e-6f);

            // Columns: gamepad inputs only in the gamepad slot, keys only in key slots
            Assert.IsNotNull(KeyMap.Refusal(InputAction.Jump, KeyChord.Parse("PadX"), 0));
            Assert.IsNotNull(KeyMap.Refusal(InputAction.Jump, KeyChord.Parse("J"), KeyMap.PAD_SLOT));
            Assert.IsNotNull(KeyMap.Refusal(InputAction.Jump, KeyChord.Parse("Ctrl+PadX"), KeyMap.PAD_SLOT));
            Assert.IsNotNull(KeyMap.Refusal(InputAction.Jump, KeyChord.Parse("PadLB+J"), 0));
            Assert.IsFalse(map.Assign(InputAction.Fly, KeyMap.PAD_SLOT, KeyChord.Parse("PadStart"), swap: true).Done); // Start is the menu (fixed)

            // A gamepad clash swaps within the gamepad column
            Assert.IsTrue(map.Assign(InputAction.Fly, KeyMap.PAD_SLOT, KeyChord.Parse("PadA"), swap: true).Done);
            Assert.AreEqual(KeyChord.Parse("PadA"), map.PadChord(InputAction.Fly));
            Assert.AreEqual(KeyChord.Parse("PadY"), map.PadChord(InputAction.Jump));
            Assert.AreEqual(KeyChord.Parse("V"), map.Primary(InputAction.Fly)); // keys untouched
            Assert.AreEqual(0, map.AllClashes().Count);

            // Swap sticks
            map.ResetAll();
            map.SwapPad(InputAction.MoveForward, InputAction.LookUp);
            Assert.AreEqual(KeyChord.Parse("PadRSUp"), map.PadChord(InputAction.MoveForward));
            Assert.AreEqual(KeyChord.Parse("PadLSUp"), map.PadChord(InputAction.LookUp));
        }

        [TestMethod]
        public void Gamepad_StoredApartFromKeys()
        {
            var map = new KeyMap();
            map.Assign(InputAction.Fly, KeyMap.PAD_SLOT, KeyChord.Parse("PadLB+PadY"), swap: false);
            map.Clear(InputAction.Minimap, KeyMap.PAD_SLOT);
            Assert.AreEqual(0, map.ToOverrides().Count); // keys unchanged
            Dictionary<string, string> pad = map.ToPadOverrides();
            Assert.AreEqual(2, pad.Count);
            Assert.AreEqual("PadLB+PadY", pad["Fly"]);
            Assert.AreEqual(string.Empty, pad["Minimap"]);

            // Through settings.json
            var settings = new LaunchSettings { PadBindings = pad };
            LaunchSettings copy = settings.Clone();
            var restored = new KeyMap();
            Assert.AreEqual(2, restored.ApplyOverrides(copy.KeyBindings, null, copy.PadBindings));
            Assert.AreEqual(KeyChord.Parse("PadLB+PadY"), restored.PadChord(InputAction.Fly));
            Assert.IsTrue(restored.PadChord(InputAction.Minimap).IsEmpty);
            Assert.AreEqual(KeyChord.Parse("V"), restored.Primary(InputAction.Fly));

            // Through a keymap file; a build-A file (no "pad") leaves the gamepad at its defaults
            var other = new KeyMap();
            Assert.IsTrue(other.Import(map.Export("test")).Valid);
            Assert.AreEqual(KeyChord.Parse("PadLB+PadY"), other.PadChord(InputAction.Fly));
            KeymapImport older = other.Import("{ \"format\": \"bimgo-keymap\", \"version\": 1, \"bindings\": { \"Help\": [\"F2\"] } }");
            Assert.IsTrue(older.Valid);
            Assert.AreEqual(KeyChord.Parse("PadY"), other.PadChord(InputAction.Fly));
            Assert.AreEqual(KeyChord.Parse("F2"), other.Primary(InputAction.Help));

            // Refused gamepad overrides are skipped and reported
            var problems = new List<string>();
            other.ApplyOverrides(null, problems, new Dictionary<string, string> { ["Jump"] = "J", ["Back"] = "PadA", ["Nope"] = "PadA" });
            Assert.AreEqual(3, problems.Count);
            Assert.AreEqual(KeyChord.Parse("PadA"), other.PadChord(InputAction.Jump));
        }

        [TestMethod]
        public void GenericPad_SourcesAndMapping()
        {
            // Sources round-trip
            foreach (string text in new[] { "B1", "B32", "POVU", "POVL", "X+", "Y-", "V-" })
            {
                Assert.IsTrue(PadSource.TryParse(text, out PadSource source), text);
                Assert.AreEqual(text, source.ToString());
            }
            Assert.IsTrue(PadSource.TryParse("", out PadSource none) && none.IsNone);
            Assert.IsFalse(PadSource.TryParse("B0", out _));
            Assert.IsFalse(PadSource.TryParse("B33", out _));
            Assert.IsFalse(PadSource.TryParse("W+", out _));
            Assert.AreEqual(PadSource.Axis(1, +1), PadSource.Axis(1, -1).Opposite);

            // Evaluate: button 3, hat up-right (both directions), left stick pushed up (Y negative), triggers on Z
            GenericPadMap map = GenericPadMap.XboxStyleGuess();
            float[] axes = { 0f, -0.8f, 0.6f, 0f, 0f, 0f };
            float[] analog = new float[KeyCodes.PAD_COUNT];
            map.Evaluate(axes, 1u << 2, 4500, analog);
            Assert.AreEqual(1f, analog[KeyCodes.PAD_X - KeyCodes.GAMEPAD_FIRST]);
            Assert.AreEqual(0f, analog[KeyCodes.PAD_A - KeyCodes.GAMEPAD_FIRST]);
            Assert.AreEqual(1f, analog[KeyCodes.PAD_UP - KeyCodes.GAMEPAD_FIRST]);
            Assert.AreEqual(1f, analog[KeyCodes.PAD_RIGHT - KeyCodes.GAMEPAD_FIRST]);
            Assert.AreEqual(0f, analog[KeyCodes.PAD_DOWN - KeyCodes.GAMEPAD_FIRST]);
            Assert.AreEqual(0.8f, analog[KeyCodes.PAD_LS_UP - KeyCodes.GAMEPAD_FIRST], 1e-6f);
            Assert.AreEqual(0f, analog[KeyCodes.PAD_LS_DOWN - KeyCodes.GAMEPAD_FIRST]);
            Assert.AreEqual(0.6f, analog[KeyCodes.PAD_LT - KeyCodes.GAMEPAD_FIRST], 1e-6f);
            Assert.AreEqual(0f, analog[KeyCodes.PAD_RT - KeyCodes.GAMEPAD_FIRST]);
            map.Evaluate(axes, 0, GenericPadMap.POV_CENTRED, analog);
            Assert.AreEqual(0f, analog[KeyCodes.PAD_UP - KeyCodes.GAMEPAD_FIRST]);

            // Detect while mapping: a new button, then the hat, then the biggest axis change (with its direction)
            float[] rest = { 0f, 0f, -1f, 0f, 0f, 0f };
            Assert.AreEqual(PadSource.Button(4), GenericPadMap.Detect(rest, 0, rest, 1u << 4, GenericPadMap.POV_CENTRED));
            Assert.AreEqual(PadSource.Pov(2), GenericPadMap.Detect(rest, 0, rest, 0, 18000));
            Assert.AreEqual(PadSource.Axis(2, +1), GenericPadMap.Detect(rest, 0, new[] { 0f, 0f, 0.9f, 0f, 0f, 0f }, 0, GenericPadMap.POV_CENTRED)); // a trigger from rest -1
            Assert.AreEqual(PadSource.Axis(1, -1), GenericPadMap.Detect(rest, 0, new[] { 0.1f, -0.9f, -1f, 0f, 0f, 0f }, 0, GenericPadMap.POV_CENTRED));
            Assert.IsTrue(GenericPadMap.Detect(rest, 1u, rest, 1u, GenericPadMap.POV_CENTRED).IsNone); // held at rest already
            Assert.IsTrue(GenericPadMap.AtRest(rest, 0, new[] { 0.2f, 0f, -0.9f, 0f, 0f, 0f }, 0, GenericPadMap.POV_CENTRED));
            Assert.IsFalse(GenericPadMap.AtRest(rest, 0, rest, 0, 0));

            // Settings: round trip; empty = the guess; bad entries skipped
            var custom = new GenericPadMap();
            custom.Set(KeyCodes.PAD_A, PadSource.Button(1));
            custom.SetStick(KeyCodes.PAD_RS_UP, PadSource.Axis(5, -1), PadSource.Axis(2, -1));
            GenericPadMap back = GenericPadMap.FromSettings(custom.ToSettings());
            Assert.AreEqual(PadSource.Button(1), back.Get(KeyCodes.PAD_A));
            Assert.AreEqual(PadSource.Axis(5, +1), back.Get(KeyCodes.PAD_RS_DOWN));
            Assert.AreEqual(PadSource.Axis(2, +1), back.Get(KeyCodes.PAD_RS_RIGHT));
            Assert.AreEqual(5, back.MappedCount);
            Assert.AreEqual(PadSource.Button(0), GenericPadMap.FromSettings(null).Get(KeyCodes.PAD_A));
            var problems = new List<string>();
            GenericPadMap.FromSettings(new Dictionary<string, string> { ["PadA"] = "B2", ["Ctrl"] = "B1", ["PadB"] = "Q?" }, problems);
            Assert.AreEqual(2, problems.Count);
        }

        #endregion

        #region Rebinding

        [TestMethod]
        public void Assign_RefusesReservedAndFixed()
        {
            var map = new KeyMap();
            Assert.IsFalse(map.Assign(InputAction.Help, 0, KeyChord.Parse("Esc"), swap: true).Done);
            Assert.IsFalse(map.Assign(InputAction.Help, 0, KeyChord.Parse("Alt+F4"), swap: true).Done);
            Assert.IsFalse(map.Assign(InputAction.Back, 0, KeyChord.Parse("F2"), swap: true).Done);
            Assert.IsFalse(map.Assign(InputAction.Run, 0, KeyChord.Parse("WheelUp"), swap: true).Done); // held
            Assert.IsFalse(map.Assign(InputAction.PhotoTake, 0, KeyChord.Parse("LMB"), swap: true).Done); // panel clicks
            Assert.IsTrue(map.AllDefault());
        }

        [TestMethod]
        public void Assign_ClashNeedsSwap()
        {
            var map = new KeyMap();
            KeyChord v = KeyChord.Parse("V");

            // Help → V clashes with Fly: refused without swap
            List<BindingClash> clashes = map.FindClashes(InputAction.Help, v);
            Assert.AreEqual(1, clashes.Count);
            Assert.AreEqual(InputAction.Fly, clashes[0].Action);
            BindResult refused = map.Assign(InputAction.Help, 0, v, swap: false);
            Assert.IsFalse(refused.Done);
            StringAssert.Contains(refused.Message, "Fly");
            Assert.AreEqual(KeyChord.Parse("F1"), map.Get(InputAction.Help, 0));

            // With swap Fly takes F1
            int version = map.Version;
            Assert.IsTrue(map.Assign(InputAction.Help, 0, v, swap: true).Done);
            Assert.AreEqual(v, map.Get(InputAction.Help, 0));
            Assert.AreEqual(KeyChord.Parse("F1"), map.Get(InputAction.Fly, 0));
            Assert.AreNotEqual(version, map.Version);
            Assert.AreEqual(0, map.AllClashes().Count);
            Assert.IsTrue(map.Pressed(InputAction.Help, new FakeKeys().Press(KeyCodes.Letter('V'))));

            // A key used only where Help isn't live is no clash (X while holding an element)
            Assert.AreEqual(0, map.FindClashes(InputAction.HoldStepUp, KeyChord.Parse("B")).Count);
        }

        [TestMethod]
        public void Assign_SwapLeavesUnboundWhenTheOldKeyWouldClash()
        {
            var map = new KeyMap();

            // Comment gun E → F (Gizmo's drop isn't live with the Comment gun: no clash at all)
            Assert.AreEqual(0, map.FindClashes(InputAction.CommentEdit, KeyChord.Parse("F")).Count);

            // Fly (V) → B clashes with Bookmark this view; B would get V back: free for it
            Assert.IsTrue(map.Assign(InputAction.Fly, 0, KeyChord.Parse("B"), swap: true).Done);
            Assert.AreEqual(KeyChord.Parse("V"), map.Get(InputAction.AddBookmark, 0));

            // Empty slot taking a used key: the other action is left unbound
            Assert.IsTrue(map.Assign(InputAction.MoveForward, 2, KeyChord.Parse("K"), swap: true).Done);
            Assert.IsTrue(map.IsUnbound(InputAction.Lights));
            Assert.AreEqual(0, map.AllClashes().Count);

            // The same chord in another slot of the action moves
            Assert.IsTrue(map.Assign(InputAction.MoveForward, 1, KeyChord.Parse("W"), swap: false).Done);
            Assert.IsTrue(map.Get(InputAction.MoveForward, 0).IsEmpty);
            Assert.AreEqual(KeyChord.Parse("W"), map.Primary(InputAction.MoveForward));
        }

        [TestMethod]
        public void ResetAndClear()
        {
            var map = new KeyMap();
            Assert.IsTrue(map.Clear(InputAction.Jump, 0));
            Assert.IsTrue(map.IsUnbound(InputAction.Jump));
            Assert.AreEqual("unbound", map.Label(InputAction.Jump));
            Assert.IsFalse(map.Clear(InputAction.Back, 0));
            map.Reset(InputAction.Jump);
            Assert.AreEqual("Space", map.Label(InputAction.Jump));
            Assert.IsTrue(map.Assign(InputAction.Jump, 0, KeyChord.Parse("Mouse4"), swap: false).Done);
            map.ResetAll();
            Assert.IsTrue(map.AllDefault());
        }

        #endregion

        #region Storage and files

        [TestMethod]
        public void Overrides_StoreOnlyChanges()
        {
            var map = new KeyMap();
            Assert.AreEqual(0, map.ToOverrides().Count);

            map.Assign(InputAction.Help, 0, KeyChord.Parse("F2"), swap: false);
            map.Clear(InputAction.MoveForward, 1);
            map.Clear(InputAction.Fly, 0);
            Dictionary<string, List<string>> overrides = map.ToOverrides();
            Assert.AreEqual(3, overrides.Count);
            CollectionAssert.AreEqual(new[] { "F2" }, overrides["Help"]);
            CollectionAssert.AreEqual(new[] { "W" }, overrides["MoveForward"]);
            CollectionAssert.AreEqual(new[] { "" }, overrides["Fly"]);

            // Through settings.json and back
            var settings = new LaunchSettings { KeyBindings = overrides };
            LaunchSettings copy = settings.Clone();
            var restored = new KeyMap();
            var problems = new List<string>();
            Assert.AreEqual(3, restored.ApplyOverrides(copy.KeyBindings, problems));
            Assert.AreEqual(0, problems.Count);
            Assert.AreEqual(KeyChord.Parse("F2"), restored.Primary(InputAction.Help));
            Assert.IsTrue(restored.Get(InputAction.MoveForward, 1).IsEmpty);
            Assert.IsTrue(restored.IsUnbound(InputAction.Fly));
            Assert.IsTrue(restored.IsDefault(InputAction.Jump));
        }

        [TestMethod]
        public void Overrides_SkipWhatCantBeRead()
        {
            var map = new KeyMap();
            var problems = new List<string>();
            var overrides = new Dictionary<string, List<string>>
            {
                ["NoSuchAction"] = new() { "F2" },
                ["Back"] = new() { "F2" },
                ["Help"] = new() { "Ctrl+Nope" },
                ["Jump"] = new() { "Esc", "Mouse4" },
                ["Run"] = new() { "WheelUp" }
            };
            Assert.AreEqual(2, map.ApplyOverrides(overrides, problems));
            Assert.AreEqual(5, problems.Count);
            Assert.AreEqual(KeyChord.Parse("F1"), map.Primary(InputAction.Help));
            Assert.AreEqual(KeyChord.Parse("Mouse4"), map.Primary(InputAction.Jump));
            Assert.IsTrue(map.IsUnbound(InputAction.Run));
            Assert.AreEqual(KeyChord.Parse("Esc"), map.Primary(InputAction.Back));
        }

        [TestMethod]
        public void Settings_CleanKeyBindings()
        {
            var settings = new LaunchSettings
            {
                KeyBindings = new Dictionary<string, List<string>>
                {
                    [" Help "] = new() { " F2 ", null, "F3", "F4" },
                    ["Help"] = new() { "F9" },
                    [""] = new() { "F5" },
                    ["Fly"] = null
                }
            };
            settings.Sanitise();
            Assert.AreEqual(1, settings.KeyBindings.Count);
            CollectionAssert.AreEqual(new[] { "F2", "", "F3" }, settings.KeyBindings["Help"]);

            settings.KeyBindings = null;
            settings.Sanitise();
            Assert.AreEqual(0, settings.KeyBindings.Count);
        }

        [TestMethod]
        public void KeymapFile_RoundTrips()
        {
            var map = new KeyMap();
            map.Assign(InputAction.Jump, 1, KeyChord.Parse("Mouse4"), swap: false);
            map.Assign(InputAction.SunEarlier, 0, KeyChord.Parse("Ctrl+["), swap: false);
            string json = map.Export("BimGo test");
            StringAssert.Contains(json, KeyMap.FILE_FORMAT);
            StringAssert.Contains(json, "\"Ctrl+[\"");

            var other = new KeyMap();
            other.Assign(InputAction.Help, 0, KeyChord.Parse("F2"), swap: false); // the file names Help: back to F1
            KeymapImport result = other.Import(json);
            Assert.IsTrue(result.Valid);
            Assert.AreEqual(0, result.Problems.Count);
            Assert.AreEqual(0, result.Clashes);
            Assert.AreEqual(KeyChord.Parse("Mouse4"), other.Get(InputAction.Jump, 1));
            Assert.AreEqual(KeyChord.Parse("Ctrl+["), other.Primary(InputAction.SunEarlier));
            Assert.AreEqual(KeyChord.Parse("F1"), other.Primary(InputAction.Help));
            CollectionAssert.AreEquivalent(map.ToOverrides().Keys.ToList(), other.ToOverrides().Keys.ToList());
        }

        [TestMethod]
        public void KeymapFile_RefusesOtherFiles()
        {
            var map = new KeyMap();
            map.Assign(InputAction.Help, 0, KeyChord.Parse("F2"), swap: false);
            Assert.IsFalse(map.Import("{ \"format\": \"something-else\" }").Valid);
            Assert.IsFalse(map.Import("not json").Valid);
            Assert.IsFalse(map.Import("{ \"format\": \"bimgo-keymap\", \"version\": 99, \"bindings\": {} }").Valid);
            Assert.AreEqual(KeyChord.Parse("F2"), map.Primary(InputAction.Help)); // nothing changed

            // A file with a clash imports, and reports it
            KeymapImport clash = map.Import("{ \"format\": \"bimgo-keymap\", \"version\": 1, \"bindings\": { \"Help\": [\"V\"] } }");
            Assert.IsTrue(clash.Valid);
            Assert.AreEqual(1, clash.Clashes);
            Assert.IsTrue(map.HasClash(InputAction.Fly));
        }

        #endregion

        #region Text

        [TestMethod]
        public void Describe_HelpText()
        {
            var map = new KeyMap();
            Assert.AreEqual("WASD", map.DescribeJoined(" ", true, InputAction.MoveForward, InputAction.MoveLeft, InputAction.MoveBack, InputAction.MoveRight));
            Assert.AreEqual("Ctrl+S · Z · Y", map.DescribeJoined(" · ", false, InputAction.Save, InputAction.Undo, InputAction.Redo));
            Assert.AreEqual("Wheel", map.DescribeJoined(" · ", false, InputAction.GunModePrevious, InputAction.GunModeNext));
            Assert.AreEqual("Shift+Wheel up · Wheel down", map.DescribeJoined(" · ", false, InputAction.PreviousGun, InputAction.NextGun), "shared modifier shown once");
            Assert.AreEqual("1–9", map.DescribeRange(InputAction.Gun1, 9));
            Assert.AreEqual("Shift+1–9", map.DescribeRange(InputAction.Bookmark1, 9));
            Assert.AreEqual("Shift", map.DescribeModifierVariant(InputAction.SunEarlier, InputAction.SunEarlierFine));
            Assert.AreEqual("W / ↑", map.AllLabels(InputAction.MoveForward));

            map.Assign(InputAction.Gun5, 0, KeyChord.Parse("F7"), swap: false);
            Assert.AreEqual("1 2 3 4 F7 6 7 8 9", map.DescribeRange(InputAction.Gun1, 9));
            map.Assign(InputAction.MoveLeft, 0, KeyChord.Parse("Ctrl+K"), swap: false);
            Assert.AreEqual("W Ctrl+K S D", map.DescribeJoined(" ", true, InputAction.MoveForward, InputAction.MoveLeft, InputAction.MoveBack, InputAction.MoveRight));
        }

        /// <summary>
        /// README §3's controls tables are generated from the defaults. When they are out of date this test rewrites
        /// the block between the markers and reports Inconclusive: review and commit the README change.
        /// </summary>
        [TestMethod]
        public void Readme_ControlsTablesAreCurrent()
        {
            string readme = FindReadme();
            if (readme == null)
            {
                Assert.Inconclusive("README.md not found above the test folder.");
                return;
            }

            string text = File.ReadAllText(readme);
            int begin = text.IndexOf(KeyMap.README_BEGIN, StringComparison.Ordinal);
            int end = text.IndexOf(KeyMap.README_END, StringComparison.Ordinal);
            Assert.IsTrue(begin >= 0 && end > begin, "README.md lacks the controls markers");

            string newline = text.Contains("\r\n") ? "\r\n" : "\n";
            string generated = KeyMap.DefaultsMarkdown().Replace("\r\n", "\n").Replace("\n", newline) + newline;
            int start = begin + KeyMap.README_BEGIN.Length;
            string current = text.Substring(start, end - start);
            if (Normalise(current) == Normalise(generated)) { return; }

            File.WriteAllText(readme, text.Substring(0, start) + generated + text.Substring(end));
            Assert.Inconclusive("README §3 controls were out of date and have been regenerated: review and commit README.md.");
        }

        private static string Normalise(string text) => text.Replace("\r\n", "\n").Trim();

        private static string FindReadme()
        {
            var folder = new DirectoryInfo(AppContext.BaseDirectory);
            while (folder != null)
            {
                string candidate = Path.Combine(folder.FullName, "README.md");
                if (File.Exists(candidate) && Directory.Exists(Path.Combine(folder.FullName, "src", "BimGo.Core"))) { return candidate; }
                folder = folder.Parent;
            }
            return null;
        }

        #endregion
    }
}
