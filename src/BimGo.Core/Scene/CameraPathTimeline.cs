using System.Numerics;
using BimGo.Format;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Round K: what the tour player plays. A bookmark tour (<see cref="TourTimeline"/>) and a camera path
    /// (<see cref="CameraPathTimeline"/>) both lay their stops out in time and give the camera's pose at any moment, so
    /// one player (live playback, and video at a fixed frame rate) runs either.
    /// </summary>
    public interface ITourTimeline
    {
        /// <summary>Number of stops (bookmarks, or a path's keys).</summary>
        int Count { get; }

        /// <summary>Total length (s; one lap of a looping path).</summary>
        float Duration { get; }

        /// <summary>When a stop becomes the current one (s): seeking here plays it from its beginning.</summary>
        float StartOf(int stop);

        /// <summary>The current stop at a time (the last one reached).</summary>
        int StopAt(float time);

        /// <summary>The camera at a time. Allocation-free.</summary>
        TourPose Pose(float time);
    }

    /// <summary>
    /// One key of a camera path, resolved for playback (scene-local metres, radians, the path's defaults applied).
    /// </summary>
    public readonly struct CameraPathPoint
    {
        /// <summary>Creates a key.</summary>
        /// <param name="eye">Eye position (scene-local metres).</param>
        /// <param name="yaw">Its own look direction about +Z (radians).</param>
        /// <param name="pitch">Its own look pitch (radians).</param>
        /// <param name="heading">Its heading (follow the path, its own view, or look at <paramref name="target"/>).</param>
        /// <param name="target">The look-at target (scene-local metres; used with <see cref="CameraHeading.LookAt"/>).</param>
        /// <param name="smoothness">How round the path turns here (0 sharp – 1 round).</param>
        /// <param name="speed">Speed on the way to the next key (m/s).</param>
        /// <param name="holdSeconds">Seconds stopped here.</param>
        /// <param name="ease">Slow down into and out of this key (forced when it holds).</param>
        /// <param name="swivel">
        /// Round K-C: a pan over the hold (radians, positive turns left): with its own view and a hold only (else 0).
        /// </param>
        public CameraPathPoint(Vector3 eye, float yaw, float pitch, CameraHeading heading, Vector3 target, float smoothness, float speed, float holdSeconds, bool ease,
            float swivel = 0f)
        {
            Eye = eye;
            Yaw = float.IsFinite(yaw) ? yaw : 0f;
            Pitch = float.IsFinite(pitch) ? Math.Clamp(pitch, -1.5f, 1.5f) : 0f;
            Heading = heading;
            Target = target;
            Smoothness = float.IsFinite(smoothness) ? Math.Clamp(smoothness, 0f, 1f) : 1f;
            Speed = float.IsFinite(speed) ? Math.Clamp(speed, CameraPath.MIN_SPEED, CameraPath.MAX_SPEED) : 1.5f;
            HoldSeconds = float.IsFinite(holdSeconds) ? Math.Clamp(holdSeconds, 0f, CameraKey.MAX_HOLD) : 0f;
            Ease = ease || HoldSeconds > 0f;
            Swivel = heading == CameraHeading.Key && HoldSeconds > 0f && float.IsFinite(swivel) ? Math.Clamp(swivel, -MathF.PI, MathF.PI) : 0f;
        }

        /// <summary>Eye position (scene-local metres).</summary>
        public Vector3 Eye { get; }

        /// <summary>Its own look direction (radians).</summary>
        public float Yaw { get; }

        /// <summary>Its own look pitch (radians).</summary>
        public float Pitch { get; }

        /// <summary>Its heading.</summary>
        public CameraHeading Heading { get; }

        /// <summary>The look-at target (scene-local metres).</summary>
        public Vector3 Target { get; }

        /// <summary>How round the path turns here (0–1).</summary>
        public float Smoothness { get; }

        /// <summary>Speed on the way to the next key (m/s).</summary>
        public float Speed { get; }

        /// <summary>Seconds stopped here.</summary>
        public float HoldSeconds { get; }

        /// <summary>The camera slows into and out of this key.</summary>
        public bool Ease { get; }

        /// <summary>Round K-C: the pan over the hold (radians, positive left; 0 unless it holds its own view).</summary>
        public float Swivel { get; }

        /// <summary>True when the key overrides the path-following heading near itself.</summary>
        public bool Overrides => Heading != CameraHeading.Follow;
    }

    /// <summary>
    /// The path-wide playback settings of a <see cref="CameraPathTimeline"/>.
    /// </summary>
    public readonly struct CameraPathSettings
    {
        /// <summary>Creates the settings.</summary>
        /// <param name="loop">Back to the first key after the last (no fades).</param>
        /// <param name="fadeSeconds">Fade in at the start and out at the end (s).</param>
        /// <param name="lookAhead">Following: how far ahead along the path the camera looks (m).</param>
        /// <param name="level">Following: keep the horizon level.</param>
        /// <param name="followBetween">Round K-C: between two keys with their own views, follow the path in the middle.</param>
        public CameraPathSettings(bool loop, float fadeSeconds, float lookAhead, bool level, bool followBetween = false)
        {
            Loop = loop;
            FadeSeconds = float.IsFinite(fadeSeconds) ? Math.Clamp(fadeSeconds, 0f, CameraPath.MAX_FADE) : 0f;
            LookAhead = float.IsFinite(lookAhead) ? Math.Clamp(lookAhead, CameraPath.MIN_LOOK_AHEAD, CameraPath.MAX_LOOK_AHEAD) : 3f;
            Level = level;
            FollowBetween = followBetween;
        }

        /// <summary>Back to the first key after the last.</summary>
        public bool Loop { get; }

        /// <summary>Fade at the ends (s).</summary>
        public float FadeSeconds { get; }

        /// <summary>Look-ahead distance (m).</summary>
        public float LookAhead { get; }

        /// <summary>Keep the horizon level when following.</summary>
        public bool Level { get; }

        /// <summary>Round K-C: follow the path between two keys with their own views (segments of twice the look-ahead or more).</summary>
        public bool FollowBetween { get; }
    }

    /// <summary>
    /// Where a camera path's camera is at one moment: <see cref="CameraPathTimeline.Evaluate"/>'s result.
    /// </summary>
    public struct CameraPathPose
    {
        /// <summary>The key last reached (its state shows: sun, colour profile).</summary>
        public int Key;

        /// <summary>Eye position (scene-local metres).</summary>
        public Vector3 Eye;

        /// <summary>Look direction (radians).</summary>
        public float Yaw;

        /// <summary>Look pitch (radians).</summary>
        public float Pitch;

        /// <summary>How black the frame is (0 clear, 1 black): the fades at the ends.</summary>
        public float Black;

        /// <summary>True while moving between keys.</summary>
        public bool Moving;

        /// <summary>True once the path has played to its end.</summary>
        public bool Finished;

        /// <summary>The state (sun) blends from key <see cref="BlendFrom"/> to <see cref="BlendTo"/> by <see cref="BlendT"/> (0–1).</summary>
        public int BlendFrom, BlendTo;

        /// <summary>See <see cref="BlendFrom"/>.</summary>
        public float BlendT;

        /// <summary>Distance along the path from the first key (m).</summary>
        public float Distance;

        /// <summary>
        /// The tour player's pose: the eye split into feet and an eye height (the player stands at the feet, so the
        /// minimap and the room readout follow the camera).
        /// </summary>
        public readonly TourPose ToTourPose(float eyeHeight) => new()
        {
            Stop = Key,
            Feet = Eye - new Vector3(0f, 0f, eyeHeight),
            EyeHeight = eyeHeight,
            Yaw = Yaw,
            Pitch = Pitch,
            Black = Black,
            Moving = Moving,
            Finished = Finished,
            BlendFrom = BlendFrom,
            BlendTo = BlendTo,
            BlendT = BlendT
        };
    }

    /// <summary>
    /// The timing and shape of a keyframed camera path (Round K): pure maths, shared by live playback and video
    /// recording (stepped at a fixed frame rate).
    /// <list type="bullet">
    /// <item><b>Shape</b>: a centripetal Catmull-Rom curve through the keys (no cusps or self-loops on uneven key
    /// spacing), as Hermite segments whose tangents are scaled by each key's smoothness: 1 is the full curve, 0 a sharp
    /// corner (straight runs between keys).</item>
    /// <item><b>Speed</b>: constant along the curve (an arc-length table per segment maps distance to the curve), at
    /// each segment's speed. Where a key eases (it holds, it is an end, or it is set to) the camera speeds up and slows
    /// down smoothly (a smoothstep velocity ramp: no jolt).</item>
    /// <item><b>Time</b>: fade in → key 0 (hold) → segment → key 1 (hold) → … → last key (hold) → fade out; a loop
    /// adds the segment from the last key back to the first and has no fades.</item>
    /// <item><b>Heading</b>: following, the camera looks at the point <see cref="CameraPathSettings.LookAhead"/> metres
    /// ahead along the path (so it turns progressively, before a corner); a key that holds its own view or looks at a
    /// target takes over near itself, blending in over the half segment before it and out over the half after it (the
    /// whole segment between two such keys; Round K-C: or, with <see cref="CameraPathSettings.FollowBetween"/>, out
    /// into following and back in). A key holding its own view can pan over its hold (<see cref="CameraPathPoint.Swivel"/>,
    /// eased like the tour's swivel).</item>
    /// <item><b>State</b>: the sun blends from key to key over each segment (<see cref="CameraPathPose.BlendFrom"/>);
    /// the colour profile switches at a key.</item>
    /// </list>
    /// </summary>
    public sealed class CameraPathTimeline : ITourTimeline
    {
        /// <summary>Acceleration of an ease ramp (m/s²): ramps last speed / this (within the bounds below).</summary>
        public const float EASE_ACCELERATION = 1.5f;

        /// <summary>Shortest and longest ease ramp (s).</summary>
        public const float MIN_RAMP_SECONDS = 0.4f, MAX_RAMP_SECONDS = 4f;

        /// <summary>A segment between two keys at the same place: the time to turn from one view to the other (s).</summary>
        public const float STILL_SEGMENT_SECONDS = 1.5f;

        /// <summary>Arc-length samples per segment.</summary>
        private const int SAMPLES = 48;

        private const float EPSILON = 1e-4f;

        private readonly CameraPathPoint[] _keys;
        private readonly CameraPathSettings _settings;
        private readonly int _segments;

        // Hermite segments: start, start tangent, end, end tangent (tangents per unit parameter)
        private readonly Vector3[] _p0, _m0, _p1, _m1;

        // Arc length: per segment SAMPLES + 1 cumulative lengths (segment-local), the segment's length and where it starts
        private readonly float[] _arc;
        private readonly float[] _length;
        private readonly float[] _offset;
        private readonly float _total;

        // Motion per segment: cruise speed, ramp time at each end (0: no ramp), cruise time, total time
        private readonly float[] _speed, _rampA, _rampB, _cruise, _time;

        // Time layout: when each key is reached (its hold starts) and when each segment starts
        private readonly float[] _arrive, _segmentStart;
        private readonly float _fade;

        // Following past the end (not looping): carry on along the final direction
        private readonly Vector3 _endDirection;

        /// <summary>
        /// Lays out a path.
        /// </summary>
        /// <param name="keys">The keys in order (copied).</param>
        /// <param name="settings">Loop, fades, look-ahead and level.</param>
        /// <param name="eyeHeight">For <see cref="Pose"/>: the eye height the tour player stands the camera on (m).</param>
        public CameraPathTimeline(IReadOnlyList<CameraPathPoint> keys, CameraPathSettings settings, float eyeHeight = 1.6f)
        {
            _keys = keys?.ToArray() ?? Array.Empty<CameraPathPoint>();
            _settings = settings;
            EyeHeight = float.IsFinite(eyeHeight) ? Math.Clamp(eyeHeight, 0.1f, 5f) : 1.6f;
            int n = _keys.Length;
            bool loop = settings.Loop && n >= 2;
            _segments = n < 2 ? 0 : loop ? n : n - 1;
            _fade = loop ? 0f : settings.FadeSeconds;

            _p0 = new Vector3[_segments];
            _m0 = new Vector3[_segments];
            _p1 = new Vector3[_segments];
            _m1 = new Vector3[_segments];
            _arc = new float[_segments * (SAMPLES + 1)];
            _length = new float[_segments];
            _offset = new float[_segments];
            _speed = new float[_segments];
            _rampA = new float[_segments];
            _rampB = new float[_segments];
            _cruise = new float[_segments];
            _time = new float[_segments];
            _arrive = new float[n];
            _segmentStart = new float[_segments];

            // Centripetal Catmull-Rom tangents at every key (per unit of the knot parameter)
            var tangents = new Vector3[n];
            for (int i = 0; i < n && n >= 2; i++)
            {
                Vector3 p = _keys[i].Eye;
                Vector3 previous = loop || i > 0 ? _keys[(i - 1 + n) % n].Eye : 2f * p - _keys[1].Eye;
                Vector3 next = loop || i < n - 1 ? _keys[(i + 1) % n].Eye : 2f * p - _keys[n - 2].Eye;
                float d0 = Knot(previous, p), d1 = Knot(p, next);
                tangents[i] = (p - previous) / d0 - (next - previous) / (d0 + d1) + (next - p) / d1;
            }

            // Segments: Hermite form, tangents scaled to the segment's knot span and each key's smoothness
            float total = 0f;
            for (int s = 0; s < _segments; s++)
            {
                int a = s, b = (s + 1) % n;
                Vector3 pa = _keys[a].Eye, pb = _keys[b].Eye;
                float span = Knot(pa, pb);
                _p0[s] = pa;
                _p1[s] = pb;
                bool still = Vector3.DistanceSquared(pa, pb) < EPSILON * EPSILON;
                _m0[s] = still ? Vector3.Zero : tangents[a] * span * _keys[a].Smoothness;
                _m1[s] = still ? Vector3.Zero : tangents[b] * span * _keys[b].Smoothness;

                // Arc-length table (Simpson's rule over each sample span)
                int baseIndex = s * (SAMPLES + 1);
                float length = 0f;
                _arc[baseIndex] = 0f;
                for (int k = 1; k <= SAMPLES; k++)
                {
                    length += SpanLength(s, (k - 1) / (float)SAMPLES, k / (float)SAMPLES);
                    _arc[baseIndex + k] = length;
                }
                _length[s] = length;
                _offset[s] = total;
                total += length;

                LayOutMotion(s, length, _keys[a].Speed, _keys[a].Ease, _keys[b].Ease);
            }
            _total = total;

            // Time: the fade in, then each key's hold followed by the segment leaving it
            float t = _fade;
            for (int i = 0; i < n; i++)
            {
                _arrive[i] = i == 0 ? 0f : t;
                t += _keys[i].HoldSeconds;
                if (i < _segments)
                {
                    _segmentStart[i] = t;
                    t += _time[i];
                }
            }
            if (loop)
            {
                // The closing segment (last key → first) is the last one laid out above
                Duration = t;
            }
            else
            {
                Duration = n == 0 ? 0f : t + _fade;
            }

            // The final direction (following past the end)
            _endDirection = Vector3.UnitX;
            if (_segments > 0)
            {
                int s = _segments - 1;
                Vector3 end = Hermite(s, 1f), before = Hermite(s, 1f - 1f / SAMPLES);
                Vector3 direction = end - before;
                if (direction.LengthSquared() < EPSILON * EPSILON) { direction = _p1[s] - _p0[s]; }
                if (direction.LengthSquared() > EPSILON * EPSILON) { _endDirection = Vector3.Normalize(direction); }
            }
        }

        #region Properties

        /// <summary>Number of keys.</summary>
        public int Count => _keys.Length;

        /// <summary>Total length in time (s; one lap when looping).</summary>
        public float Duration { get; }

        /// <summary>Total length along the curve (m; the closing segment included when looping).</summary>
        public float Length => _total;

        /// <summary>True when the path loops (two keys or more and looping on).</summary>
        public bool Loops => _settings.Loop && _keys.Length >= 2;

        /// <summary>The eye height <see cref="Pose"/> stands the camera on (m).</summary>
        public float EyeHeight { get; }

        /// <summary>A key as resolved.</summary>
        public CameraPathPoint this[int index] => _keys[index];

        #endregion

        #region Layout

        /// <summary>Centripetal knot spacing (the square root of the distance), never zero.</summary>
        private static float Knot(Vector3 a, Vector3 b) => MathF.Max(MathF.Sqrt(Vector3.Distance(a, b)), 1e-3f);

        /// <summary>
        /// A segment's motion: cruise at <paramref name="speed"/>, with a smoothstep velocity ramp at each easing end.
        /// A segment too short for full ramps reaches a lower top speed (same acceleration).
        /// </summary>
        private void LayOutMotion(int s, float length, float speed, bool easeA, bool easeB)
        {
            int ramps = (easeA ? 1 : 0) + (easeB ? 1 : 0);
            if (length < EPSILON)
            {
                // Two keys at one place: a turn on the spot
                _speed[s] = 0f;
                _time[s] = STILL_SEGMENT_SECONDS;
                return;
            }

            float ramp = Math.Clamp(speed / EASE_ACCELERATION, MIN_RAMP_SECONDS, MAX_RAMP_SECONDS);
            float rampDistance = speed * ramp * 0.5f; // the smoothstep ramp covers half of ramp × speed
            if (ramps > 0 && rampDistance * ramps > length)
            {
                // Too short to reach the speed: v² R / (2 v0) per ramp = length / ramps (R scales with v)
                float top = MathF.Sqrt(2f * length * speed / (ramps * ramp));
                ramp *= top / speed;
                speed = top;
                rampDistance = speed * ramp * 0.5f;
            }
            _speed[s] = speed;
            _rampA[s] = easeA ? ramp : 0f;
            _rampB[s] = easeB ? ramp : 0f;
            _cruise[s] = MathF.Max(0f, (length - rampDistance * ramps) / speed);
            _time[s] = MathF.Max(_rampA[s] + _cruise[s] + _rampB[s], 0.05f);
        }

        /// <summary>A point on segment <paramref name="s"/> at parameter <paramref name="u"/> (0–1).</summary>
        private Vector3 Hermite(int s, float u)
        {
            float u2 = u * u, u3 = u2 * u;
            float h00 = 2f * u3 - 3f * u2 + 1f, h10 = u3 - 2f * u2 + u, h01 = -2f * u3 + 3f * u2, h11 = u3 - u2;
            return h00 * _p0[s] + h10 * _m0[s] + h01 * _p1[s] + h11 * _m1[s];
        }

        /// <summary>The curve's derivative on segment <paramref name="s"/> at <paramref name="u"/>.</summary>
        private Vector3 HermiteSlope(int s, float u)
        {
            float u2 = u * u;
            return (6f * u2 - 6f * u) * _p0[s] + (3f * u2 - 4f * u + 1f) * _m0[s] + (-6f * u2 + 6f * u) * _p1[s] + (3f * u2 - 2f * u) * _m1[s];
        }

        /// <summary>The curve's length on segment <paramref name="s"/> between two parameters (Simpson's rule).</summary>
        private float SpanLength(int s, float from, float to)
        {
            float mid = 0.5f * (from + to);
            return (to - from) / 6f * (HermiteSlope(s, from).Length() + 4f * HermiteSlope(s, mid).Length() + HermiteSlope(s, to).Length());
        }

        /// <summary>The distance covered on a segment after <paramref name="tau"/> seconds of it.</summary>
        private float DistanceIn(int s, float tau)
        {
            float length = _length[s];
            if (_speed[s] <= 0f || length < EPSILON) { return 0f; }
            float v = _speed[s], ra = _rampA[s], rb = _rampB[s];
            if (tau <= 0f) { return 0f; }
            if (tau >= _time[s]) { return length; }
            if (ra > 0f && tau < ra) { return v * ra * Ramp(tau / ra); }
            float afterRamp = ra > 0f ? v * ra * 0.5f : 0f;
            if (tau < ra + _cruise[s]) { return MathF.Min(length, afterRamp + v * (tau - ra)); }
            if (rb > 0f)
            {
                float left = MathF.Max(0f, _time[s] - tau);
                return Math.Clamp(length - v * rb * Ramp(left / rb), 0f, length);
            }
            return length;
        }

        /// <summary>Distance covered over a smoothstep velocity ramp, as a fraction of ramp time × speed (0 → 0.5).</summary>
        private static float Ramp(float x)
        {
            x = Math.Clamp(x, 0f, 1f);
            float x3 = x * x * x;
            return x3 - 0.5f * x3 * x;
        }

        /// <summary>
        /// The point at a distance along segment <paramref name="s"/>: the arc-length table brackets it, two Newton steps
        /// on the span's length place it (constant speed to well under 1 %).
        /// </summary>
        private Vector3 PointIn(int s, float distance)
        {
            int baseIndex = s * (SAMPLES + 1);
            float length = _length[s];
            if (length < EPSILON) { return _p0[s]; }
            distance = Math.Clamp(distance, 0f, length);

            // Binary search for the sample span holding the distance
            int lo = 0, hi = SAMPLES;
            while (hi - lo > 1)
            {
                int mid = (lo + hi) >> 1;
                if (_arc[baseIndex + mid] <= distance) { lo = mid; }
                else { hi = mid; }
            }
            float a = _arc[baseIndex + lo], b = _arc[baseIndex + hi];
            float f = b - a > 1e-6f ? (distance - a) / (b - a) : 0f;
            float uLow = lo / (float)SAMPLES, uHigh = hi / (float)SAMPLES;
            float u = (lo + f) / SAMPLES;
            for (int step = 0; step < 2; step++)
            {
                float rate = HermiteSlope(s, u).Length();
                if (rate < 1e-5f) { break; }
                u = Math.Clamp(u - (a + SpanLength(s, uLow, u) - distance) / rate, uLow, uHigh);
            }
            return Hermite(s, u);
        }

        /// <summary>The point at a distance from the first key (wraps when looping; carries on straight past the end).</summary>
        public Vector3 PointAt(float distance)
        {
            if (_keys.Length == 0) { return Vector3.Zero; }
            if (_segments == 0 || _total < EPSILON) { return _keys[0].Eye; }
            if (Loops)
            {
                distance %= _total;
                if (distance < 0f) { distance += _total; }
            }
            else if (distance >= _total)
            {
                return _p1[_segments - 1] + _endDirection * (distance - _total);
            }
            else if (distance <= 0f)
            {
                return _p0[0];
            }

            // The segment holding it
            int lo = 0, hi = _segments - 1;
            while (lo < hi)
            {
                int mid = (lo + hi + 1) >> 1;
                if (_offset[mid] <= distance) { lo = mid; }
                else { hi = mid - 1; }
            }
            return PointIn(lo, distance - _offset[lo]);
        }

        /// <summary>
        /// Round K-B: the segment holding a distance from the first key (clamped; -1 when there are no segments).
        /// </summary>
        public int SegmentAt(float distance)
        {
            if (_segments == 0) { return -1; }
            if (Loops && _total > EPSILON)
            {
                distance %= _total;
                if (distance < 0f) { distance += _total; }
            }
            int lo = 0, hi = _segments - 1;
            while (lo < hi)
            {
                int mid = (lo + hi + 1) >> 1;
                if (_offset[mid] <= distance) { lo = mid; }
                else { hi = mid - 1; }
            }
            return lo;
        }

        /// <summary>
        /// Round K-B: the point on the path nearest to <paramref name="point"/> (each segment's arc-length samples,
        /// then the nearest point on the chord between two samples). Allocation-free.
        /// </summary>
        /// <param name="point">The point (scene-local metres).</param>
        /// <param name="segment">The segment holding the nearest point (-1 without segments).</param>
        /// <param name="along">Its distance from the first key along the path (m).</param>
        /// <returns>The distance from <paramref name="point"/> to the path (m; infinity without segments).</returns>
        public float Nearest(Vector3 point, out int segment, out float along)
        {
            segment = -1;
            along = 0f;
            float best = float.PositiveInfinity;
            for (int s = 0; s < _segments; s++)
            {
                int baseIndex = s * (SAMPLES + 1);
                Vector3 previous = _p0[s];
                for (int k = 1; k <= SAMPLES; k++)
                {
                    Vector3 next = Hermite(s, k / (float)SAMPLES);
                    Vector3 chord = next - previous;
                    float lengthSquared = chord.LengthSquared();
                    float t = lengthSquared > 1e-10f ? Math.Clamp(Vector3.Dot(point - previous, chord) / lengthSquared, 0f, 1f) : 0f;
                    float distance = Vector3.Distance(point, previous + chord * t);
                    if (distance < best)
                    {
                        best = distance;
                        segment = s;
                        along = _offset[s] + _arc[baseIndex + k - 1] + (_arc[baseIndex + k] - _arc[baseIndex + k - 1]) * t;
                    }
                    previous = next;
                }
            }
            return best;
        }

        /// <summary>
        /// Round K-B: the time at which the camera is a distance along the path (searched on the timeline; the first
        /// time it gets there, holds excluded).
        /// </summary>
        public float TimeAtDistance(float distance)
        {
            int s = SegmentAt(distance);
            if (s < 0) { return 0f; }
            float local = Math.Clamp(distance - _offset[s], 0f, _length[s]);
            float lo = 0f, hi = _time[s];
            for (int i = 0; i < 32; i++)
            {
                float mid = 0.5f * (lo + hi);
                if (DistanceIn(s, mid) < local) { lo = mid; }
                else { hi = mid; }
            }
            return _segmentStart[s] + 0.5f * (lo + hi);
        }

        #endregion

        #region Queries

        /// <summary>When a key is reached (s): the start of its hold (the first key: the start, before the fade in).</summary>
        public float StartOf(int stop) => _keys.Length == 0 ? 0f : _arrive[Math.Clamp(stop, 0, _keys.Length - 1)];

        /// <summary>The key last reached at a time.</summary>
        public int StopAt(float time)
        {
            if (_keys.Length == 0) { return -1; }
            int key = 0;
            for (int i = 1; i < _arrive.Length; i++)
            {
                if (_arrive[i] <= time) { key = i; }
                else { break; }
            }
            return key;
        }

        /// <summary>The time a segment's motion takes (s).</summary>
        public float SegmentSeconds(int segment) => segment >= 0 && segment < _segments ? _time[segment] : 0f;

        /// <summary>A segment's length along the curve (m).</summary>
        public float SegmentLength(int segment) => segment >= 0 && segment < _segments ? _length[segment] : 0f;

        /// <summary>The tour player's pose at a time (the eye stood on <see cref="EyeHeight"/>).</summary>
        public TourPose Pose(float time) => Evaluate(time).ToTourPose(EyeHeight);

        /// <summary>
        /// The camera at a time. Allocation-free.
        /// </summary>
        /// <param name="time">Seconds from the start (clamped at 0; at or past <see cref="Duration"/> the path is finished:
        /// the last key's view, black when there are fades).</param>
        public CameraPathPose Evaluate(float time)
        {
            var pose = new CameraPathPose { Key = -1, Finished = true, BlendFrom = -1, BlendTo = -1, BlendT = 1f };
            int n = _keys.Length;
            if (n == 0) { return pose; }
            if (!float.IsFinite(time) || time < 0f) { time = 0f; }

            int key;
            float distance;
            int segment = -1;
            float u = 0f; // the time fraction through the segment
            float held = 1f; // K-C: how far through its hold the key is (its swivel): 0 before, 1 after
            if (time >= Duration)
            {
                key = Loops ? 0 : n - 1;
                distance = Loops ? 0f : _total;
                pose.Black = _fade > 0f ? 1f : 0f;
                held = Loops ? 0f : 1f;
            }
            else
            {
                pose.Finished = false;
                key = StopAt(time);
                float holdStart = key == 0 ? _fade : _arrive[key];
                float holdEnd = holdStart + _keys[key].HoldSeconds;
                distance = key < _segments ? _offset[key] : _total;
                if (time < holdStart)
                {
                    // The fade in (key 0)
                    pose.Black = _fade > 0f ? Math.Clamp(1f - time / _fade, 0f, 1f) : 0f;
                    held = 0f;
                }
                else if (time < holdEnd)
                {
                    held = TourTimeline.Smooth((time - holdStart) / _keys[key].HoldSeconds);
                }
                else if (time >= holdEnd && key < _segments)
                {
                    // Moving along the segment leaving this key
                    segment = key;
                    float tau = time - _segmentStart[segment];
                    u = _time[segment] > 0f ? Math.Clamp(tau / _time[segment], 0f, 1f) : 1f;
                    distance = _offset[segment] + DistanceIn(segment, tau);
                    pose.Moving = true;
                    pose.BlendFrom = key;
                    pose.BlendTo = (key + 1) % n;
                    pose.BlendT = u;
                }
                else if (time >= holdEnd && _fade > 0f)
                {
                    // The fade out (after the last key's hold)
                    pose.Black = Math.Clamp((time - holdEnd) / _fade, 0f, 1f);
                }
            }

            pose.Key = key;
            if (pose.BlendFrom < 0) { pose.BlendFrom = pose.BlendTo = key; }
            pose.Distance = distance;
            pose.Eye = segment >= 0 ? PointIn(segment, distance - _offset[segment]) : _keys[key].Eye;

            ApplyHeading(ref pose, key, segment, u, held);
            return pose;
        }

        /// <summary>
        /// The look direction: following the path (the point the look-ahead ahead), blended with the overriding keys'
        /// views near them.
        /// </summary>
        /// <param name="held">K-C: at a key, how far through its hold (its swivel; eased).</param>
        private void ApplyHeading(ref CameraPathPose pose, int key, int segment, float u, float held)
        {
            // Follow: look at the point ahead along the path
            float followYaw, followPitch;
            Vector3 ahead = PointAt(pose.Distance + _settings.LookAhead) - pose.Eye;
            if (_segments > 0 && ahead.LengthSquared() > 1e-6f)
            {
                ahead = Vector3.Normalize(ahead);
                followYaw = MathF.Atan2(ahead.Y, ahead.X);
                followPitch = _settings.Level ? 0f : MathF.Asin(Math.Clamp(ahead.Z, -1f, 1f));
            }
            else
            {
                followYaw = _keys[key].Yaw;
                followPitch = _settings.Level ? 0f : _keys[key].Pitch;
            }

            float yaw = followYaw, pitch = followPitch;
            if (segment < 0)
            {
                // At a key (hold, fades, the end): its own heading in full (K-C: panning over the hold)
                if (_keys[key].Overrides) { KeyView(key, pose.Eye, held, out yaw, out pitch); }
            }
            else
            {
                int a = segment, b = (segment + 1) % _keys.Length;
                bool overA = _keys[a].Overrides, overB = _keys[b].Overrides;
                bool between = overA && overB && _settings.FollowBetween && _length[segment] >= 2f * _settings.LookAhead;
                if (between)
                {
                    // K-C: out of A's view into following over the first half, into B's over the second
                    if (u < 0.5f)
                    {
                        KeyView(a, pose.Eye, 1f, out float yawA, out float pitchA);
                        float w = 1f - TourTimeline.Smooth(u * 2f);
                        yaw = TourTimeline.LerpAngle(followYaw, yawA, w);
                        pitch = followPitch + (pitchA - followPitch) * w;
                    }
                    else
                    {
                        KeyView(b, pose.Eye, 0f, out float yawB, out float pitchB);
                        float w = TourTimeline.Smooth(u * 2f - 1f);
                        yaw = TourTimeline.LerpAngle(followYaw, yawB, w);
                        pitch = followPitch + (pitchB - followPitch) * w;
                    }
                }
                else if (overA && overB)
                {
                    // Key view to key view over the whole segment
                    KeyView(a, pose.Eye, 1f, out float yawA, out float pitchA);
                    KeyView(b, pose.Eye, 0f, out float yawB, out float pitchB);
                    float w = TourTimeline.Smooth(u);
                    yaw = TourTimeline.LerpAngle(yawA, yawB, w);
                    pitch = pitchA + (pitchB - pitchA) * w;
                }
                else if (overA)
                {
                    // Out of A's view into following over the first half
                    KeyView(a, pose.Eye, 1f, out float yawA, out float pitchA);
                    float w = 1f - TourTimeline.Smooth(u * 2f);
                    yaw = TourTimeline.LerpAngle(followYaw, yawA, w);
                    pitch = followPitch + (pitchA - followPitch) * w;
                }
                else if (overB)
                {
                    // From following into B's view over the second half
                    KeyView(b, pose.Eye, 0f, out float yawB, out float pitchB);
                    float w = TourTimeline.Smooth(u * 2f - 1f);
                    yaw = TourTimeline.LerpAngle(followYaw, yawB, w);
                    pitch = followPitch + (pitchB - followPitch) * w;
                }
            }

            // Keep the yaw in (−π, π] and the pitch short of straight up / down
            yaw %= MathF.Tau;
            if (yaw > MathF.PI) { yaw -= MathF.Tau; }
            else if (yaw <= -MathF.PI) { yaw += MathF.Tau; }
            pose.Yaw = yaw;
            pose.Pitch = Math.Clamp(pitch, -1.5f, 1.5f);
        }

        /// <summary>A key's own heading from an eye position: its view (K-C: panned by its swivel), or towards its target.</summary>
        /// <param name="swivel">How much of its swivel shows (0 arriving – 1 leaving).</param>
        private void KeyView(int index, Vector3 eye, float swivel, out float yaw, out float pitch)
        {
            CameraPathPoint key = _keys[index];
            yaw = key.Yaw + key.Swivel * swivel;
            pitch = key.Pitch;
            if (key.Heading != CameraHeading.LookAt) { return; }
            Vector3 to = key.Target - eye;
            float flat = MathF.Sqrt(to.X * to.X + to.Y * to.Y);
            if (flat < 1e-4f && MathF.Abs(to.Z) < 1e-4f) { return; }
            if (flat > 1e-4f) { yaw = MathF.Atan2(to.Y, to.X); }
            pitch = MathF.Atan2(to.Z, MathF.Max(flat, 1e-4f));
        }

        #endregion
    }
}
