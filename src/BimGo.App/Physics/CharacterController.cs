using System.Numerics;

// The class belongs to the Physics namespace
namespace BimGo.Physics
{
    /// <summary>
    /// Contact flags gathered while moving.
    /// </summary>
    internal struct MoveResult
    {
        /// <summary>Touched a walkable surface (normal Z &gt; 0.7) or the ground plane.</summary>
        public bool Ground;

        /// <summary>Touched a ceiling.</summary>
        public bool Ceiling;

        /// <summary>Touched a wall.</summary>
        public bool Wall;

        /// <summary>Sum of wall normals touched (for velocity clipping).</summary>
        public Vector3 WallNormal;
    }

    /// <summary>
    /// A deterministic capsule controller: gravity, jump, crouch, step-up and ground snapping,
    /// resolved by iterative depenetration against BVH triangles.
    /// Positions are the capsule's feet (bottom). Z is up.
    /// </summary>
    internal sealed class CharacterController
    {
        #region Constants

        public const float RADIUS = 0.3f;
        public const float STAND_HEIGHT = 1.75f;
        public const float CROUCH_HEIGHT = 1.2f;
        public const float STAND_EYE = 1.62f;
        public const float CROUCH_EYE = 1.07f;
        public const float GRAVITY = 12f;
        public const float JUMP_SPEED = 4.6f;
        private const float SUBSTEP = 0.08f;
        private const float WALKABLE = 0.7f;
        private const int ITERATIONS = 4;

        #endregion

        #region State

        /// <summary>Feet position.</summary>
        public Vector3 Feet;

        /// <summary>Velocity.</summary>
        public Vector3 Velocity;

        /// <summary>Standing on something.</summary>
        public bool Grounded;

        /// <summary>Current capsule height.</summary>
        public float Height = STAND_HEIGHT;

        /// <summary>Currently crouched.</summary>
        public bool Crouching;

        /// <summary>Maximum step-up height (m).</summary>
        public float StepHeight = 0.2f;

        /// <summary>The infinite ground plane elevation.</summary>
        public float GroundZ;

        /// <summary>True if the last step stepped up a riser (for camera smoothing).</summary>
        public bool SteppedThisTick { get; private set; }

        #endregion

        #region Collision sources

        private readonly Bvh _bvh;
        private int[] _query = new int[512];

        /// <summary>Per element: collide? (shared array owned by the session).</summary>
        public bool[] CollisionMask { get; set; }

        /// <summary>Moved and cloned elements (collided with their current transforms), or null.</summary>
        public DynamicSet Dynamics { get; set; }

        private BvhTriangle[] _dynamicTriangles = new BvhTriangle[256];


        #endregion

        /// <summary>
        /// Creates the controller.
        /// </summary>
        public CharacterController(Bvh bvh)
        {
            _bvh = bvh;
        }

        #region Step

        /// <summary>
        /// Advances one fixed physics tick.
        /// </summary>
        /// <param name="dt">Tick length.</param>
        /// <param name="wish">Desired horizontal velocity (world).</param>
        /// <param name="jump">Jump pressed this tick.</param>
        /// <param name="crouch">Crouch held.</param>
        public void Step(float dt, Vector3 wish, bool jump, bool crouch)
        {
            SteppedThisTick = false;
            UpdateCrouch(crouch);

            // Horizontal response (snappy on the ground, light air control)
            float accel = Grounded ? 14f : 2.5f;
            var horizontal = new Vector3(Velocity.X, Velocity.Y, 0f);
            horizontal += (new Vector3(wish.X, wish.Y, 0f) - horizontal) * MathF.Min(1f, accel * dt);
            Velocity = new Vector3(horizontal.X, horizontal.Y, Velocity.Z);

            bool jumped = false;
            if (Grounded && jump && !Crouching)
            {
                Velocity.Z = JUMP_SPEED;
                Grounded = false;
                jumped = true;
            }
            Velocity.Z -= GRAVITY * dt;
            Velocity.Z = MathF.Max(Velocity.Z, -40f);

            bool wasGrounded = Grounded;

            // Horizontal move with step-up
            var delta = new Vector3(Velocity.X * dt, Velocity.Y * dt, 0f);
            if (delta.LengthSquared() > 1e-12f)
            {
                var result = new MoveResult();
                Vector3 moved = Move(Feet, delta, ref result);
                float wanted = delta.Length();
                float got = Flat(moved - Feet).Length();

                if (wasGrounded && !jumped && got < wanted * 0.8f && StepHeight > 0f)
                {
                    Vector3 raised = Feet + new Vector3(0f, 0f, StepHeight);
                    if (!Overlaps(raised, Height))
                    {
                        var r2 = new MoveResult();
                        Vector3 across = Move(raised, delta, ref r2);
                        var r3 = new MoveResult();
                        Vector3 landed = Move(across, new Vector3(0f, 0f, -StepHeight - 0.01f), ref r3);
                        float gotStep = Flat(landed - Feet).Length();

                        if (r3.Ground && gotStep > got + 0.002f && landed.Z - Feet.Z <= StepHeight + 0.01f)
                        {
                            moved = landed;
                            result = r2;
                            SteppedThisTick = landed.Z - Feet.Z > 0.01f;
                        }
                    }
                }

                Feet = moved;
                if (result.Wall) { ClipVelocity(result.WallNormal); }
            }

            // Vertical move
            var vertical = new MoveResult();
            Feet = Move(Feet, new Vector3(0f, 0f, Velocity.Z * dt), ref vertical);
            Grounded = false;
            if (vertical.Ground && Velocity.Z <= 0f)
            {
                Grounded = true;
                Velocity.Z = 0f;
            }
            if (vertical.Ceiling && Velocity.Z > 0f) { Velocity.Z = 0f; }

            // Snap down (walking down stairs or off small lips) instead of falling
            if (!Grounded && wasGrounded && !jumped && Velocity.Z <= 0f)
            {
                var snap = new MoveResult();
                Vector3 snapped = Move(Feet, new Vector3(0f, 0f, -StepHeight - 0.02f), ref snap);
                if (snap.Ground)
                {
                    Feet = snapped;
                    Grounded = true;
                    Velocity.Z = 0f;
                }
            }

            // Ground plane catches falls
            if (Feet.Z <= GroundZ)
            {
                Feet.Z = GroundZ;
                if (Velocity.Z <= 0f)
                {
                    Grounded = true;
                    Velocity.Z = 0f;
                }
            }
        }

        /// <summary>
        /// Crouch / stand (standing only when there is headroom).
        /// </summary>
        private void UpdateCrouch(bool crouch)
        {
            if (crouch)
            {
                Crouching = true;
                Height = CROUCH_HEIGHT;
            }
            else if (Crouching && !Overlaps(Feet, STAND_HEIGHT))
            {
                Crouching = false;
                Height = STAND_HEIGHT;
            }
        }

        /// <summary>
        /// Removes the velocity component pushing into walls.
        /// </summary>
        private void ClipVelocity(Vector3 wallNormal)
        {
            Vector3 n = Flat(wallNormal);
            float length = n.Length();
            if (length < 1e-5f) { return; }
            n /= length;

            float into = Vector3.Dot(new Vector3(Velocity.X, Velocity.Y, 0f), n);
            if (into < 0f)
            {
                Velocity.X -= n.X * into;
                Velocity.Y -= n.Y * into;
            }
        }

        /// <summary>
        /// Teleports without residual velocity.
        /// </summary>
        public void Teleport(Vector3 feet)
        {
            Feet = feet;
            Velocity = Vector3.Zero;
            Grounded = false;
        }

        #endregion

        #region Movement and resolution

        /// <summary>
        /// Moves in sub-steps, resolving penetration after each.
        /// </summary>
        public Vector3 Move(Vector3 feet, Vector3 delta, ref MoveResult result)
        {
            float length = delta.Length();
            int steps = Math.Max(1, (int)MathF.Ceiling(length / SUBSTEP));
            Vector3 step = delta / steps;

            for (int i = 0; i < steps; i++)
            {
                feet += step;
                feet = Resolve(feet, Height, ref result);
            }
            return feet;
        }

        /// <summary>
        /// Pushes the capsule out of nearby triangles.
        /// Walkable contacts push straight up (no sliding on ramps); others push along the contact normal.
        /// </summary>
        private Vector3 Resolve(Vector3 feet, float height, ref MoveResult result)
        {
            for (int iteration = 0; iteration < ITERATIONS; iteration++)
            {
                bool pushed = false;
                Vector3 min = feet - new Vector3(RADIUS + 0.02f, RADIUS + 0.02f, 0.02f);
                Vector3 max = feet + new Vector3(RADIUS + 0.02f, RADIUS + 0.02f, height + 0.02f);

                int staticCount = _bvh.Query(min, max, ref _query, CollisionMask);
                for (int i = 0; i < staticCount; i++)
                {
                    ref BvhTriangle tri = ref _bvh.Triangles[_query[i]];
                    if (!Overlaps(tri, min, max)) { continue; }
                    if (PushOut(ref feet, height, tri.A, tri.B, tri.C, ref result))
                    {
                        pushed = true;
                        min = feet - new Vector3(RADIUS + 0.02f, RADIUS + 0.02f, 0.02f);
                        max = feet + new Vector3(RADIUS + 0.02f, RADIUS + 0.02f, height + 0.02f);
                    }
                }

                // Moved / cloned elements
                int dynamicCount = Dynamics != null ? Dynamics.CollectTriangles(min, max, ref _dynamicTriangles) : 0;
                for (int i = 0; i < dynamicCount; i++)
                {
                    ref BvhTriangle tri = ref _dynamicTriangles[i];
                    if (!Overlaps(tri, min, max)) { continue; }
                    if (PushOut(ref feet, height, tri.A, tri.B, tri.C, ref result))
                    {
                        pushed = true;
                        min = feet - new Vector3(RADIUS + 0.02f, RADIUS + 0.02f, 0.02f);
                        max = feet + new Vector3(RADIUS + 0.02f, RADIUS + 0.02f, height + 0.02f);
                    }
                }

                if (feet.Z < GroundZ)
                {
                    feet.Z = GroundZ;
                    result.Ground = true;
                }

                if (!pushed) { break; }
            }
            return feet;
        }

        /// <summary>
        /// Resolves one triangle contact.
        /// </summary>
        /// <returns>True if the capsule was moved.</returns>
        private static bool PushOut(ref Vector3 feet, float height, Vector3 a, Vector3 b, Vector3 c, ref MoveResult result)
        {
            Vector3 p = feet + new Vector3(0f, 0f, RADIUS);
            Vector3 q = feet + new Vector3(0f, 0f, height - RADIUS);
            float distanceSquared = GeoMath.ClosestSegmentTriangle(p, q, a, b, c, out Vector3 onSegment, out Vector3 onTriangle);
            if (distanceSquared >= RADIUS * RADIUS) { return false; }

            float distance = MathF.Sqrt(distanceSquared);
            Vector3 normal;
            if (distance > 1e-5f)
            {
                normal = (onSegment - onTriangle) / distance;
            }
            else
            {
                // Pierced: use the face normal facing the capsule centre
                normal = Vector3.Cross(b - a, c - a);
                float length = normal.Length();
                if (length < 1e-12f) { return false; }
                normal /= length;
                Vector3 centre = (p + q) * 0.5f;
                if (Vector3.Dot(centre - onTriangle, normal) < 0f) { normal = -normal; }
            }

            float depth = RADIUS - distance + 0.0005f;
            if (normal.Z > WALKABLE)
            {
                feet.Z += depth / normal.Z;
                result.Ground = true;
            }
            else if (normal.Z < -WALKABLE)
            {
                feet += normal * depth;
                result.Ceiling = true;
            }
            else
            {
                feet += normal * depth;
                result.Wall = true;
                result.WallNormal += normal;
            }
            return true;
        }

        /// <summary>
        /// True if a capsule at feet with the given height intersects anything.
        /// </summary>
        public bool Overlaps(Vector3 feet, float height)
        {
            Vector3 min = feet - new Vector3(RADIUS, RADIUS, 0f);
            Vector3 max = feet + new Vector3(RADIUS, RADIUS, height);
            Vector3 p = feet + new Vector3(0f, 0f, RADIUS);
            Vector3 q = feet + new Vector3(0f, 0f, height - RADIUS);
            float limit = (RADIUS - 0.01f) * (RADIUS - 0.01f);

            int staticCount = _bvh.Query(min, max, ref _query, CollisionMask);
            for (int i = 0; i < staticCount; i++)
            {
                ref BvhTriangle tri = ref _bvh.Triangles[_query[i]];
                if (GeoMath.ClosestSegmentTriangle(p, q, tri.A, tri.B, tri.C, out _, out _) < limit) { return true; }
            }

            int dynamicCount = Dynamics != null ? Dynamics.CollectTriangles(min, max, ref _dynamicTriangles) : 0;
            for (int i = 0; i < dynamicCount; i++)
            {
                ref BvhTriangle tri = ref _dynamicTriangles[i];
                if (GeoMath.ClosestSegmentTriangle(p, q, tri.A, tri.B, tri.C, out _, out _) < limit) { return true; }
            }

            return false;
        }

        private static Vector3 Flat(Vector3 v) => new(v.X, v.Y, 0f);

        /// <summary>
        /// Cheap triangle-box rejection before the exact capsule test.
        /// </summary>
        private static bool Overlaps(in BvhTriangle t, Vector3 min, Vector3 max)
        {
            Vector3 tmin = Vector3.Min(t.A, Vector3.Min(t.B, t.C));
            Vector3 tmax = Vector3.Max(t.A, Vector3.Max(t.B, t.C));
            return tmax.X >= min.X && tmin.X <= max.X
                && tmax.Y >= min.Y && tmin.Y <= max.Y
                && tmax.Z >= min.Z && tmin.Z <= max.Z;
        }

        #endregion
    }
}
