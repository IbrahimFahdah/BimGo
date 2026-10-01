using System.Numerics;
using RvtGo.Physics;
using RvtGo.Platform;
using Vk = RvtGo.Native.Win32;

// The class belongs to the Game namespace
namespace RvtGo.Game
{
    /// <summary>
    /// The player: walk mode (capsule physics) or fly / no-clip mode, look angles, home, and
    /// render-side smoothing (interpolation between physics ticks, stair and crouch smoothing).
    /// </summary>
    internal sealed class Player
    {
        #region Constants

        private const float WALK_SPEED = 3.2f;
        private const float RUN_SPEED = 6.5f;
        private const float CROUCH_SPEED = 1.6f;
        private const float FLY_SPEED = 6f;
        private const float FLY_FAST_SPEED = 18f;
        private const float LOOK_SCALE = 0.0022f;

        #endregion

        #region State

        /// <summary>The capsule controller.</summary>
        public CharacterController Controller { get; }

        /// <summary>Fly / no-clip mode.</summary>
        public bool Flying { get; private set; }

        /// <summary>Yaw (radians).</summary>
        public float Yaw;

        /// <summary>Pitch (radians).</summary>
        public float Pitch;

        /// <summary>Home feet position.</summary>
        public Vector3 HomeFeet { get; private set; }

        private float _homeYaw, _homePitch;
        private bool _homeFlying;
        private Vector3 _previousFeet, _currentFeet;
        private float _visualZ;
        private float _eyeHeight = CharacterController.STAND_EYE;
        private bool _jumpQueued;

        /// <summary>Feet position (physics).</summary>
        public Vector3 Feet => Controller.Feet;

        #endregion

        /// <summary>
        /// Creates the player.
        /// </summary>
        public Player(CharacterController controller)
        {
            Controller = controller;
        }

        #region Per-frame (variable rate)

        /// <summary>
        /// Applies mouse look.
        /// </summary>
        public void Look(float dx, float dy, float sensitivity, bool invertY)
        {
            Yaw -= dx * LOOK_SCALE * sensitivity;
            Pitch += (invertY ? dy : -dy) * LOOK_SCALE * sensitivity;
            Pitch = Math.Clamp(Pitch, -1.55f, 1.55f);
            if (Yaw > MathF.PI) { Yaw -= MathF.Tau; }
            if (Yaw < -MathF.PI) { Yaw += MathF.Tau; }
        }

        /// <summary>
        /// Queues a jump for the next physics tick.
        /// </summary>
        public void QueueJump() => _jumpQueued = true;

        /// <summary>
        /// Toggles fly mode.
        /// </summary>
        public void ToggleFly()
        {
            Flying = !Flying;
            Controller.Velocity = Vector3.Zero;
            Controller.Grounded = false;
        }

        /// <summary>
        /// The interpolated, smoothed eye position for rendering.
        /// </summary>
        /// <param name="alpha">Interpolation between the last two ticks (0..1).</param>
        /// <param name="dt">Frame time (for smoothing).</param>
        public Vector3 GetEye(float alpha, float dt)
        {
            Vector3 feet = Vector3.Lerp(_previousFeet, _currentFeet, alpha);

            // Smooth small vertical jumps (stairs) while grounded; follow exactly otherwise
            float difference = feet.Z - _visualZ;
            if (!Flying && Controller.Grounded && MathF.Abs(difference) < 0.45f)
            {
                _visualZ += difference * (1f - MathF.Exp(-16f * dt));
            }
            else
            {
                _visualZ = feet.Z;
            }

            float targetEye = Controller.Crouching && !Flying ? CharacterController.CROUCH_EYE : CharacterController.STAND_EYE;
            _eyeHeight += (targetEye - _eyeHeight) * (1f - MathF.Exp(-12f * dt));

            return new Vector3(feet.X, feet.Y, _visualZ + _eyeHeight);
        }

        #endregion

        #region Fixed tick

        /// <summary>
        /// One physics tick from the current keyboard state.
        /// </summary>
        public void FixedUpdate(float dt, InputState input, bool inputEnabled)
        {
            _previousFeet = _currentFeet;

            float forward = 0f, strafe = 0f;
            bool run = false, up = false, down = false;
            if (inputEnabled)
            {
                if (input.IsDown('W') || input.IsDown(Vk.VK_UP)) { forward += 1f; }
                if (input.IsDown('S') || input.IsDown(Vk.VK_DOWN)) { forward -= 1f; }
                if (input.IsDown('D') || input.IsDown(Vk.VK_RIGHT)) { strafe += 1f; }
                if (input.IsDown('A') || input.IsDown(Vk.VK_LEFT)) { strafe -= 1f; }
                run = input.IsDown(Vk.VK_SHIFT);
                up = input.IsDown(Vk.VK_SPACE);
                down = input.IsDown(Vk.VK_CONTROL);
            }

            float cy = MathF.Cos(Yaw), sy = MathF.Sin(Yaw);
            var flatForward = new Vector3(cy, sy, 0f);
            var right = new Vector3(sy, -cy, 0f);

            if (Flying)
            {
                float cp = MathF.Cos(Pitch), sp = MathF.Sin(Pitch);
                var lookForward = new Vector3(cp * cy, cp * sy, sp);
                Vector3 move = lookForward * forward + right * strafe + Vector3.UnitZ * ((up ? 1f : 0f) - (down ? 1f : 0f));
                if (move.LengthSquared() > 1f) { move = Vector3.Normalize(move); }
                Controller.Feet += move * (run ? FLY_FAST_SPEED : FLY_SPEED) * dt;
                Controller.Velocity = Vector3.Zero;
                _jumpQueued = false;
            }
            else
            {
                Vector3 wish = flatForward * forward + right * strafe;
                if (wish.LengthSquared() > 1f) { wish = Vector3.Normalize(wish); }
                float speed = Controller.Crouching ? CROUCH_SPEED : run ? RUN_SPEED : WALK_SPEED;
                Controller.Step(dt, wish * speed, _jumpQueued, down);
                _jumpQueued = false;
            }

            _currentFeet = Controller.Feet;
        }

        #endregion

        #region Teleport and home

        /// <summary>
        /// Moves the player instantly (no interpolation across the jump).
        /// </summary>
        public void TeleportTo(Vector3 feet, float? yaw = null, float? pitch = null)
        {
            Controller.Teleport(feet);
            _previousFeet = _currentFeet = feet;
            _visualZ = feet.Z;
            if (yaw.HasValue) { Yaw = yaw.Value; }
            if (pitch.HasValue) { Pitch = pitch.Value; }
        }

        /// <summary>
        /// Rotates the horizontal velocity (portals keep relative motion).
        /// </summary>
        public void RotateVelocity(float angle, float minimumSpeedAlong, Vector3 exitDirection)
        {
            Vector3 v = Controller.Velocity;
            float c = MathF.Cos(angle), s = MathF.Sin(angle);
            var rotated = new Vector3(v.X * c - v.Y * s, v.X * s + v.Y * c, v.Z);
            float along = Vector3.Dot(new Vector3(rotated.X, rotated.Y, 0f), exitDirection);
            if (along < minimumSpeedAlong) { rotated += exitDirection * (minimumSpeedAlong - along); }
            Controller.Velocity = rotated;
        }

        /// <summary>
        /// Sets home to the current position and view.
        /// </summary>
        public void SetHome()
        {
            HomeFeet = Controller.Feet;
            _homeYaw = Yaw;
            _homePitch = Pitch;
            _homeFlying = Flying;
        }

        /// <summary>
        /// Sets home explicitly.
        /// </summary>
        public void SetHome(Vector3 feet, float yaw, float pitch, bool flying)
        {
            HomeFeet = feet;
            _homeYaw = yaw;
            _homePitch = pitch;
            _homeFlying = flying;
        }

        /// <summary>
        /// Returns to home.
        /// </summary>
        public void GoHome()
        {
            if (Flying != _homeFlying) { ToggleFly(); }
            TeleportTo(HomeFeet, _homeYaw, _homePitch);
        }

        #endregion
    }
}
