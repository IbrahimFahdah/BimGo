using System.Numerics;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;
using Vk = BimGo.Native.Win32;

// The class belongs to the Guns namespace
namespace BimGo.Game.Guns
{
    /// <summary>
    /// The move / rotate gizmo shared by the Gizmo and Clone guns.
    ///
    /// While locked on, WASD (or the arrows) move the target in plan relative to the view and Q / E rotate it
    /// counter-clockwise / clockwise about its pivot; Shift slows both down.
    ///
    /// Snap mode (G toggles it; holding Ctrl inverts it for as long as it is held) clamps the change since locking
    /// on to the session's increments (<see cref="GameSession.SnapMove"/> / <see cref="GameSession.SnapAngle"/>):
    /// each key press (and key repeat) steps one increment, moves follow the world X / Y axis nearest the view
    /// direction, so offsets stay exact multiples. Z / X and C / V change the increments while locked.
    /// The owning gun decides what committing and cancelling mean.
    /// </summary>
    internal sealed class GizmoController
    {
        #region Constants and fields

        private const float MOVE_SPEED = 1f;              // m/s
        private const float ROTATE_SPEED = MathF.PI / 2f; // rad/s (90°/s)
        private const float FINE = 0.25f;

        private readonly GameSession _session;
        private Vector3 _startOffset, _rawOffset;
        private float _startAngle, _rawAngle;
        private float _clock;

        #endregion

        /// <summary>
        /// Creates the controller.
        /// </summary>
        public GizmoController(GameSession session)
        {
            _session = session;
        }

        /// <summary>The instance being edited, or null.</summary>
        public DynamicInstance Target { get; private set; }

        /// <summary>True while locked on.</summary>
        public bool Active => Target != null;

        /// <summary>Pivot translation since locking on.</summary>
        public Vector3 DeltaOffset => Target == null ? Vector3.Zero : Target.Offset - _startOffset;

        /// <summary>Rotation since locking on (radians, CCW).</summary>
        public float DeltaAngle => Target == null ? 0f : Target.Angle - _startAngle;

        /// <summary>The pivot (scene-local) when the lock began.</summary>
        public Vector3 StartPivot => Target == null ? Vector3.Zero : Target.BasePivot + _startOffset;

        /// <summary>True if anything changed since locking on.</summary>
        public bool HasChanges => DeltaOffset.LengthSquared() > 1e-10f || MathF.Abs(DeltaAngle) > 1e-6f;

        #region Lifecycle

        /// <summary>
        /// Locks on to an instance.
        /// </summary>
        public void Begin(DynamicInstance target)
        {
            Target = target;
            _startOffset = _rawOffset = target.Offset;
            _startAngle = _rawAngle = target.Angle;
        }

        /// <summary>
        /// Puts the target back where it was when the lock began, and lets go.
        /// </summary>
        /// <returns>The released instance.</returns>
        public DynamicInstance Cancel()
        {
            DynamicInstance target = Target;
            if (target != null) { _session.Dynamics.SetTransform(target, _startOffset, _startAngle); }
            Target = null;
            return target;
        }

        /// <summary>
        /// Lets go, keeping the current transform.
        /// </summary>
        /// <returns>The released instance.</returns>
        public DynamicInstance End()
        {
            DynamicInstance target = Target;
            Target = null;
            return target;
        }

        #endregion

        #region Update

        /// <summary>
        /// Applies this frame's keys.
        /// </summary>
        public void Update(float dt, InputState input)
        {
            _clock += dt;
            if (Target == null) { return; }

            float forward = 0f, strafe = 0f, turn = 0f;
            if (input.IsDown('W') || input.IsDown(Vk.VK_UP)) { forward += 1f; }
            if (input.IsDown('S') || input.IsDown(Vk.VK_DOWN)) { forward -= 1f; }
            if (input.IsDown('D') || input.IsDown(Vk.VK_RIGHT)) { strafe += 1f; }
            if (input.IsDown('A') || input.IsDown(Vk.VK_LEFT)) { strafe -= 1f; }
            if (input.IsDown('Q')) { turn += 1f; }
            if (input.IsDown('E')) { turn -= 1f; }
            float scale = input.IsDown(Vk.VK_SHIFT) ? FINE : 1f;

            // Camera-relative in plan
            Vector3 flatForward = Flatten(_session.Camera.Forward);
            Vector3 flatRight = Flatten(_session.Camera.Right);
            Vector3 move = flatForward * forward + flatRight * strafe;
            if (move.LengthSquared() > 1f) { move = Vector3.Normalize(move); }

            Vector3 offset;
            float angle;
            if (IsSnapping(input))
            {
                // Stepped: one increment per press / key repeat, along the world axis nearest the view direction
                float step = _session.SnapMove, angleStep = _session.SnapAngle;
                Vector3 stepMove = Vector3.Zero;
                if (input.IsPressedOrRepeated('W') || input.IsPressedOrRepeated(Vk.VK_UP)) { stepMove += flatForward; }
                if (input.IsPressedOrRepeated('S') || input.IsPressedOrRepeated(Vk.VK_DOWN)) { stepMove -= flatForward; }
                if (input.IsPressedOrRepeated('D') || input.IsPressedOrRepeated(Vk.VK_RIGHT)) { stepMove += flatRight; }
                if (input.IsPressedOrRepeated('A') || input.IsPressedOrRepeated(Vk.VK_LEFT)) { stepMove -= flatRight; }
                _rawOffset += NearestAxis(stepMove) * step;
                if (input.IsPressedOrRepeated('Q')) { _rawAngle += angleStep; }
                if (input.IsPressedOrRepeated('E')) { _rawAngle -= angleStep; }

                // Clamp the change since lock-on to whole increments (also tidies a smooth move made before snapping)
                Vector3 delta = _rawOffset - _startOffset;
                _rawOffset = _startOffset + new Vector3(Snap(delta.X, step), Snap(delta.Y, step), 0f);
                _rawAngle = _startAngle + Snap(_rawAngle - _startAngle, angleStep);
                offset = _rawOffset;
                angle = _rawAngle;
            }
            else
            {
                _rawOffset += move * (MOVE_SPEED * scale * dt);
                _rawAngle += turn * ROTATE_SPEED * scale * dt;
                offset = _rawOffset;
                angle = _rawAngle;
            }

            if (offset != Target.Offset || angle != Target.Angle)
            {
                _session.Dynamics.SetTransform(Target, offset, angle);
            }
        }

        /// <summary>
        /// True while snapping: the session's snap mode, inverted while Ctrl is held.
        /// </summary>
        public bool IsSnapping(InputState input) => _session.GizmoSnap ^ input.IsDown(Vk.VK_CONTROL);

        private static float Snap(float value, float step) => step > 0f ? MathF.Round(value / step) * step : value;

        /// <summary>
        /// The world X / Y unit direction nearest a plan direction (zero for no movement).
        /// </summary>
        private static Vector3 NearestAxis(Vector3 direction)
        {
            if (direction.LengthSquared() < 1e-6f) { return Vector3.Zero; }
            return MathF.Abs(direction.X) >= MathF.Abs(direction.Y)
                ? new Vector3(MathF.Sign(direction.X), 0f, 0f)
                : new Vector3(0f, MathF.Sign(direction.Y), 0f);
        }

        private static Vector3 Flatten(Vector3 v)
        {
            var flat = new Vector3(v.X, v.Y, 0f);
            return flat.LengthSquared() > 1e-8f ? Vector3.Normalize(flat) : Vector3.UnitX;
        }

        #endregion

        #region Drawing

        /// <summary>
        /// Draws the gizmo: rotate ring, view-relative move arrows, and a trail from the starting pivot.
        /// </summary>
        public void Draw(Overlay3D overlay, uint colour)
        {
            if (Target == null) { return; }

            Aabb bounds = Target.WorldBounds;
            Vector3 pivot = Target.Pivot;
            float baseZ = bounds.Min.Z + 0.02f;
            var centre = new Vector3(pivot.X, pivot.Y, baseZ);
            Vector3 size = bounds.Size;
            float radius = MathF.Max(0.35f, 0.5f * MathF.Max(size.X, size.Y) + 0.2f);
            float pulse = 0.5f + 0.5f * MathF.Sin(_clock * 5f);

            // Rotate ring with a tick showing the current heading
            overlay.Ring(centre, Vector3.UnitX, Vector3.UnitY, radius, radius, 0.03f, Rgba.WithAlpha(colour, 0.85f));
            float heading = Target.Angle;
            var tick = new Vector3(MathF.Cos(heading), MathF.Sin(heading), 0f);
            overlay.Line(centre + tick * (radius - 0.12f), centre + tick * (radius + 0.12f), 4f, colour);

            // Move arrows along the view's forward / right in plan
            Vector3 forward = Flatten(_session.Camera.Forward), right = Flatten(_session.Camera.Right);
            float arrow = radius + 0.35f;
            Arrow(overlay, centre, forward, arrow, UiTheme.AXIS_Y);
            Arrow(overlay, centre, -forward, arrow * 0.7f, Rgba.WithAlpha(UiTheme.AXIS_Y, 0.5f));
            Arrow(overlay, centre, right, arrow, UiTheme.AXIS_X);
            Arrow(overlay, centre, -right, arrow * 0.7f, Rgba.WithAlpha(UiTheme.AXIS_X, 0.5f));

            // Pivot post and the trail back to where it started
            overlay.Line(centre, new Vector3(pivot.X, pivot.Y, bounds.Max.Z + 0.1f), 1.5f, Rgba.WithAlpha(colour, 0.5f + 0.3f * pulse));
            Vector3 start = StartPivot;
            var startGround = new Vector3(start.X, start.Y, baseZ);
            if (Vector3.DistanceSquared(startGround, centre) > 1e-4f)
            {
                overlay.Line(startGround, centre, 2f, Rgba.WithAlpha(colour, 0.6f));
                overlay.Ring(startGround, Vector3.UnitX, Vector3.UnitY, 0.08f, 0.08f, 0.02f, Rgba.WithAlpha(colour, 0.6f));
            }
        }

        private static void Arrow(Overlay3D overlay, Vector3 centre, Vector3 direction, float length, uint colour)
        {
            Vector3 tip = centre + direction * length;
            Vector3 side = new Vector3(-direction.Y, direction.X, 0f) * 0.09f;
            Vector3 back = tip - direction * 0.18f;
            overlay.Line(centre + direction * 0.1f, back, 3f, colour);
            overlay.Triangle(tip, back + side, back - side, colour);
        }

        /// <summary>
        /// Writes "Δ 1.250 m · 15.0°" for the panel.
        /// </summary>
        public void DescribeDelta(TextBuffer text)
        {
            float degrees = DeltaAngle * 180f / MathF.PI;
            Vector3 delta = DeltaOffset;
            text.Append("Δ ").Append(new Vector2(delta.X, delta.Y).Length(), 3).Append(" m · ").Append(degrees, 1).Append('°');
        }

        #endregion
    }
}
