using System.Numerics;
using BimGo.Audio;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Polish round P-A2: gamepad reach in menus, panels and docks.
    /// <list type="bullet">
    /// <item>Every control that tests the mouse with <see cref="Hover"/> registers its rectangle as it is drawn (the part
    /// the clip shows; scroll regions remember which list it is in). Sliders register their knob.</item>
    /// <item>The D-pad moves a focus ring (<see cref="UiTheme.FOCUS"/>) between last frame's rectangles (nearest in the
    /// pressed direction) and puts the cursor on the focused control, so A (the cursor's click) presses it. A focused
    /// slider steps with D-pad left / right. Up / down with nothing further scrolls the list under the cursor; a
    /// focused row in a scroll region is scrolled into view.</item>
    /// <item>Moving the cursor stick (or the mouse) hides the ring: the cursor is the stick's again.</item>
    /// <item>LB / RB tapped alone switch the first tab row drawn (the pause menu's tabs, the sun dock's tabs); held,
    /// they stay chord modifiers, and the D-pad with a shoulder held keeps its chords.</item>
    /// <item>Menus (paused, text boxes, markup): the D-pad always navigates. The free-cursor editors (docks, clash
    /// mode): the D-pad navigates while the cursor is over a dock or the ring shows; elsewhere it keeps its walkthrough
    /// and clash bindings.</item>
    /// </list>
    /// Fixed bindings (not in the catalogue): P-B's hotkey review kept them fixed (the catalogue's Fixed note names them),
    /// and made A with a shoulder held a chord rather than a click (<see cref="Gamepad.DriveCursor"/>).
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Types

        /// <summary>A focusable control from one frame's UI.</summary>
        private struct FocusTarget
        {
            /// <summary>The control's rectangle (unclipped).</summary>
            public float X, Y, W, H;

            /// <summary>The clip in force when it was drawn (unbounded without one).</summary>
            public float ClipX0, ClipY0, ClipX1, ClipY1;

            /// <summary>Where the cursor goes when it is focused (the centre; a slider's knob).</summary>
            public float AnchorX, AnchorY;

            /// <summary>A slider: D-pad left / right steps it.</summary>
            public bool Slider;

            /// <summary>The scroll region it was drawn in (null: none) and that region's content top then.</summary>
            public ScrollRegion Region;
            public float RegionTop;

            /// <summary>The visible part's left / top / right / bottom.</summary>
            public readonly float VisX0 => MathF.Max(X, ClipX0);
            public readonly float VisY0 => MathF.Max(Y, ClipY0);
            public readonly float VisX1 => MathF.Min(X + W, ClipX1);
            public readonly float VisY1 => MathF.Min(Y + H, ClipY1);

            /// <summary>The visible part's centre.</summary>
            public readonly Vector2 Centre => new((VisX0 + VisX1) * 0.5f, (VisY0 + VisY1) * 0.5f);
        }

        #endregion

        #region Fields

        private const int FOCUS_MAX = 768, FOCUS_AREAS_MAX = 8;

        // This frame's targets (built while drawing) and last frame's (navigated); swapped at the end of the UI build
        private FocusTarget[] _focusBuild = new FocusTarget[FOCUS_MAX], _focusLast = new FocusTarget[FOCUS_MAX];
        private int _focusBuildCount, _focusLastCount;

        // The docks drawn (the D-pad navigates in the free-cursor editors while the cursor is over one)
        private Vector4[] _focusAreasBuild = new Vector4[FOCUS_AREAS_MAX], _focusAreasLast = new Vector4[FOCUS_AREAS_MAX];
        private int _focusAreasBuildCount, _focusAreasLastCount;

        // The scroll region being drawn (registrations remember it)
        private ScrollRegion _focusRegion;

        // The focus: shown, and the control (last frame's copy)
        private bool _padFocusOn;
        private FocusTarget _padFocus;

        // A slider step's injected click (released the next frame)
        private bool _padSliderClick;

        // LB / RB tapped alone: the tab step for the first tab row drawn this frame; whether each shoulder chorded
        private int _padTabStep;
        private bool _padLbHeld, _padRbHeld, _padLbChorded, _padRbChorded;

        #endregion

        #region Registration (while drawing)

        /// <summary>The UI build starts: this frame's targets start empty.</summary>
        private void BeginFocusFrame()
        {
            _focusBuildCount = 0;
            _focusAreasBuildCount = 0;
            _focusRegion = null;
        }

        /// <summary>
        /// The UI build ends: the ring is drawn round the focused control (found again in this frame's targets), and
        /// this frame's targets become the ones the next frame's D-pad navigates. Call with the clip reset.
        /// </summary>
        private void EndFocusFrame()
        {
            if (_padFocusOn && FindFocus(_focusBuild, _focusBuildCount, out int index))
            {
                FocusTarget t = _focusBuild[index];
                float pad = S(3);
                bool clipped = t.ClipX0 > float.MinValue;
                if (clipped) { _ui.PushClip(t.ClipX0 - pad, t.ClipY0 - pad, t.ClipX1 - t.ClipX0 + pad * 2f, t.ClipY1 - t.ClipY0 + pad * 2f); }
                _ui.Outline(t.X - S(2), t.Y - S(2), t.W + S(4), t.H + S(4), MathF.Max(2f, S(2f)), UiTheme.FOCUS);
                if (clipped) { _ui.PopClip(); }
            }

            (_focusBuild, _focusLast) = (_focusLast, _focusBuild);
            _focusLastCount = _focusBuildCount;
            _focusBuildCount = 0;
            (_focusAreasBuild, _focusAreasLast) = (_focusAreasLast, _focusAreasBuild);
            _focusAreasLastCount = _focusAreasBuildCount;
            _focusAreasBuildCount = 0;
            _focusRegion = null;
            _padTabStep = 0; // no tab row took it this frame
        }

        /// <summary>
        /// A control's rectangle (from <see cref="Hover"/>; sliders give their knob as the anchor). Panels, lists'
        /// viewports and scroll tracks pass focus: false to Hover and never get here. Too small or too tall a
        /// rectangle, or one the clip hides, is skipped; the same rectangle twice in a row is kept once.
        /// </summary>
        private void RegisterFocus(float x, float y, float w, float h, bool slider = false, float anchorX = float.NaN, float anchorY = float.NaN)
        {
            if (!Gamepad.Connected || _focusBuildCount >= FOCUS_MAX) { return; }
            if (w < S(8) || h < S(8) || h > S(220) || w > _window.Width * 0.9f) { return; }

            _ui.GetClip(out float cx0, out float cy0, out float cx1, out float cy1);
            if (MathF.Min(x + w, cx1) - MathF.Max(x, cx0) < S(4) || MathF.Min(y + h, cy1) - MathF.Max(y, cy0) < S(4)) { return; }

            // The same control tested twice (a hover check, then the click check)
            for (int i = Math.Max(0, _focusBuildCount - 4); i < _focusBuildCount; i++)
            {
                ref FocusTarget other = ref _focusBuild[i];
                if (other.X == x && other.Y == y && other.W == w && other.H == h) { return; }
            }

            ref FocusTarget t = ref _focusBuild[_focusBuildCount++];
            t.X = x;
            t.Y = y;
            t.W = w;
            t.H = h;
            t.ClipX0 = cx0;
            t.ClipY0 = cy0;
            t.ClipX1 = cx1;
            t.ClipY1 = cy1;
            t.Slider = slider;
            t.Region = _focusRegion;
            t.RegionTop = _focusRegion?.Top ?? 0f;
            Vector2 centre = t.Centre;
            t.AnchorX = float.IsNaN(anchorX) ? centre.X : Math.Clamp(anchorX, t.VisX0, MathF.Max(t.VisX0, t.VisX1 - 1f));
            t.AnchorY = float.IsNaN(anchorY) ? centre.Y : Math.Clamp(anchorY, t.VisY0, MathF.Max(t.VisY0, t.VisY1 - 1f));
        }

        /// <summary>A dock's rectangle: in the free-cursor editors the D-pad navigates while the cursor is over one.</summary>
        private void RegisterFocusArea(float x, float y, float w, float h)
        {
            if (_focusAreasBuildCount >= FOCUS_AREAS_MAX) { return; }
            _focusAreasBuild[_focusAreasBuildCount++] = new Vector4(x, y, w, h);
        }

        /// <summary>
        /// LB / RB tapped alone switch tabs: the first tab row drawn this frame takes the step.
        /// </summary>
        /// <returns>The tab to show (unchanged without a step).</returns>
        private int TakePadTabStep(int selected, int count)
        {
            if (_padTabStep == 0 || count <= 1) { return selected; }
            int step = _padTabStep;
            _padTabStep = 0;
            return ((selected + step) % count + count) % count;
        }

        #endregion

        #region Navigation (each frame, before the keys)

        /// <summary>
        /// The D-pad, LB / RB and the ring (after the gamepad cursor mode is set; before the open view reads its keys).
        /// </summary>
        private void UpdatePadFocus(InputState input)
        {
            // The slider step's click lasts one frame
            if (_padSliderClick)
            {
                _padSliderClick = false;
                input.InjectLeft(false);
            }

            PadCursorMode mode = _window.PadCursor;
            if (mode == PadCursorMode.Off || !input.PadConnected || _window.IsCaptured || !_window.IsActive)
            {
                _padFocusOn = false;
                _padLbHeld = _padRbHeld = false;
                return;
            }

            // The stick or the mouse took the cursor back
            if (_padFocusOn && (Gamepad.StickMovedCursor || MathF.Abs(input.MouseDeltaX) + MathF.Abs(input.MouseDeltaY) > 2f)) { _padFocusOn = false; }

            UpdatePadShoulders(input);

            // The D-pad (with a shoulder held it's a chord, left alone)
            bool lb = input.PadDown(KeyCodes.PAD_LB), rb = input.PadDown(KeyCodes.PAD_RB);
            int dx = 0, dy = 0;
            if (!lb && !rb)
            {
                if (input.PadPressedOrRepeated(KeyCodes.PAD_UP)) { dy = -1; }
                else if (input.PadPressedOrRepeated(KeyCodes.PAD_DOWN)) { dy = 1; }
                else if (input.PadPressedOrRepeated(KeyCodes.PAD_LEFT)) { dx = -1; }
                else if (input.PadPressedOrRepeated(KeyCodes.PAD_RIGHT)) { dx = 1; }
            }

            // Keep the focus on its control as lists scroll (and the cursor on it, so A presses it)
            int current = -1;
            bool found = _padFocusOn && FindFocus(_focusLast, _focusLastCount, out current);
            if (_padFocusOn && !found) { _padFocusOn = false; }
            if (found)
            {
                _padFocus = _focusLast[current];
                if (MathF.Abs(input.MousePosition.X - _padFocus.AnchorX) > 1f || MathF.Abs(input.MousePosition.Y - _padFocus.AnchorY) > 1f)
                {
                    if (!input.LeftDown) { Gamepad.WarpCursor(_window, input, _padFocus.AnchorX, _padFocus.AnchorY); }
                }
            }
            if (dx == 0 && dy == 0) { return; }

            // The free-cursor editors: only over a dock (or with the ring up); elsewhere the D-pad is the walkthrough's
            if (mode == PadCursorMode.Editor && !_padFocusOn && !MouseOverFocusArea(input.MousePosition)) { return; }
            input.ConsumePad(KeyCodes.PAD_UP);
            input.ConsumePad(KeyCodes.PAD_DOWN);
            input.ConsumePad(KeyCodes.PAD_LEFT);
            input.ConsumePad(KeyCodes.PAD_RIGHT);
            if (_focusLastCount == 0) { return; }

            // First press: the control under (or nearest) the cursor
            if (!_padFocusOn)
            {
                int start = NearestTarget(input.MousePosition);
                if (start < 0) { return; }
                FocusOn(input, start);
                return;
            }

            // A focused slider: left / right steps it (an injected click beside the knob)
            if (_padFocus.Slider && dx != 0)
            {
                if (input.LeftDown) { return; }
                float step = MathF.Max(S(3), _padFocus.W * 0.05f);
                float x = Math.Clamp(_padFocus.AnchorX + dx * step, _padFocus.X, _padFocus.X + _padFocus.W);
                Gamepad.WarpCursor(_window, input, x, _padFocus.AnchorY);
                input.InjectLeft(true);
                _padSliderClick = true;
                return;
            }

            int next = NextTarget(current, dx, dy);
            if (next >= 0)
            {
                FocusOn(input, next);
                Sound.Play(SoundId.UiClick);
                return;
            }

            // Nothing further up or down: scroll the list under the cursor a notch (more rows come into view)
            if (dy != 0) { input.OnWheel(dy < 0 ? 120 : -120); }
        }

        /// <summary>LB / RB: a tap (down and up with no other button meanwhile) is a tab step; anything else is a chord.</summary>
        private void UpdatePadShoulders(InputState input)
        {
            bool lb = input.PadDown(KeyCodes.PAD_LB), rb = input.PadDown(KeyCodes.PAD_RB);
            if (lb && !_padLbHeld) { _padLbChorded = false; } // a fresh press
            if (rb && !_padRbHeld) { _padRbChorded = false; }
            bool other = (lb || rb) && input.AnyPadPressedExcept(KeyCodes.PAD_LB, KeyCodes.PAD_RB);
            if (lb && (other || rb)) { _padLbChorded = true; }
            if (rb && (other || lb)) { _padRbChorded = true; }
            if (_padLbHeld && !lb && !_padLbChorded) { _padTabStep = -1; }
            if (_padRbHeld && !rb && !_padRbChorded) { _padTabStep = 1; }
            _padLbHeld = lb;
            _padRbHeld = rb;
        }

        /// <summary>Focuses a target: the cursor goes to it and a row in a scroll region is scrolled into view.</summary>
        private void FocusOn(InputState input, int index)
        {
            _padFocus = _focusLast[index];
            _padFocusOn = true;
            if (_padFocus.Region != null)
            {
                float top = _padFocus.Y - _padFocus.RegionTop;
                _padFocus.Region.Reveal(top - S(6), top + _padFocus.H + S(6));
            }
            Gamepad.WarpCursor(_window, input, _padFocus.AnchorX, _padFocus.AnchorY);
        }

        /// <summary>
        /// The focused control in a frame's targets: the closest match by place and size (in the same scroll region,
        /// by its place in the list, so scrolling keeps it).
        /// </summary>
        private bool FindFocus(FocusTarget[] targets, int count, out int index)
        {
            index = -1;
            float best = S(48);
            for (int i = 0; i < count; i++)
            {
                ref FocusTarget t = ref targets[i];
                if (t.Slider != _padFocus.Slider) { continue; }
                float dy = t.Region != null && ReferenceEquals(t.Region, _padFocus.Region)
                    ? (t.Y - t.RegionTop) - (_padFocus.Y - _padFocus.RegionTop)
                    : t.Y - _padFocus.Y;
                float score = MathF.Abs(t.X - _padFocus.X) + MathF.Abs(dy) + MathF.Abs(t.W - _padFocus.W) + MathF.Abs(t.H - _padFocus.H);
                if (score < best)
                {
                    best = score;
                    index = i;
                }
            }
            return index >= 0;
        }

        /// <summary>The target under the cursor (the smallest, so a button wins over its row), else the nearest.</summary>
        private int NearestTarget(Vector2 at)
        {
            int best = -1;
            float bestArea = float.MaxValue, bestDistance = float.MaxValue;
            bool inside = false;
            for (int i = 0; i < _focusLastCount; i++)
            {
                ref FocusTarget t = ref _focusLast[i];
                bool over = at.X >= t.VisX0 && at.X < t.VisX1 && at.Y >= t.VisY0 && at.Y < t.VisY1;
                if (over)
                {
                    float area = (t.VisX1 - t.VisX0) * (t.VisY1 - t.VisY0);
                    if (!inside || area < bestArea)
                    {
                        inside = true;
                        bestArea = area;
                        best = i;
                    }
                }
                else if (!inside)
                {
                    float distance = Vector2.DistanceSquared(t.Centre, at);
                    if (distance < bestDistance)
                    {
                        bestDistance = distance;
                        best = i;
                    }
                }
            }
            return best;
        }

        /// <summary>
        /// The nearest target in a direction from the current one: its centre must lie that way; overlapping spans
        /// across the direction count as in line, otherwise the sideways distance weighs more than the distance along.
        /// </summary>
        private int NextTarget(int current, int dx, int dy)
        {
            FocusTarget from = current >= 0 ? _focusLast[current] : _padFocus;
            Vector2 c = from.Centre;
            int best = -1;
            float bestScore = float.MaxValue;
            for (int i = 0; i < _focusLastCount; i++)
            {
                if (i == current) { continue; }
                ref FocusTarget t = ref _focusLast[i];
                Vector2 p = t.Centre;
                float along = dx != 0 ? (p.X - c.X) * dx : (p.Y - c.Y) * dy;
                if (along < S(4)) { continue; }

                // Sideways gap between the spans (0 when they overlap)
                float gap = dx != 0
                    ? MathF.Max(0f, MathF.Max(t.VisY0 - from.VisY1, from.VisY0 - t.VisY1))
                    : MathF.Max(0f, MathF.Max(t.VisX0 - from.VisX1, from.VisX0 - t.VisX1));
                float side = dx != 0 ? MathF.Abs(p.Y - c.Y) : MathF.Abs(p.X - c.X);
                float score = along + gap * 3f + side * 0.25f;
                if (score < bestScore)
                {
                    bestScore = score;
                    best = i;
                }
            }
            return best;
        }

        /// <summary>True when a point is over one of last frame's docks.</summary>
        private bool MouseOverFocusArea(Vector2 at)
        {
            for (int i = 0; i < _focusAreasLastCount; i++)
            {
                Vector4 r = _focusAreasLast[i];
                if (at.X >= r.X && at.X < r.X + r.Z && at.Y >= r.Y && at.Y < r.Y + r.W) { return true; }
            }
            return false;
        }

        #endregion
    }
}
