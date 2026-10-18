using System.Numerics;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// One stop of a bookmark tour, resolved for playback: where the camera stands and looks, how long it holds and how
    /// far it pans. Scene-local metres; angles in radians.
    /// </summary>
    public readonly struct TourStop
    {
        /// <summary>Creates a stop.</summary>
        /// <param name="feet">Feet position (scene-local metres).</param>
        /// <param name="eyeHeight">Eye height above the feet (m).</param>
        /// <param name="yaw">Look direction about +Z (radians, 0 = +X, counter-clockwise).</param>
        /// <param name="pitch">Look pitch (radians, positive up).</param>
        /// <param name="holdSeconds">Seconds at the stop (between the fades, or between the glides).</param>
        /// <param name="swivel">Pan over the stop (radians, positive turns left, 0 none).</param>
        public TourStop(Vector3 feet, float eyeHeight, float yaw, float pitch, float holdSeconds, float swivel)
        {
            Feet = feet;
            EyeHeight = eyeHeight;
            Yaw = yaw;
            Pitch = pitch;
            HoldSeconds = MathF.Max(0f, float.IsFinite(holdSeconds) ? holdSeconds : 0f);
            Swivel = float.IsFinite(swivel) ? swivel : 0f;
        }

        /// <summary>Feet position (scene-local metres).</summary>
        public Vector3 Feet { get; }

        /// <summary>Eye height above the feet (m).</summary>
        public float EyeHeight { get; }

        /// <summary>Look direction (radians).</summary>
        public float Yaw { get; }

        /// <summary>Look pitch (radians).</summary>
        public float Pitch { get; }

        /// <summary>Seconds at the stop.</summary>
        public float HoldSeconds { get; }

        /// <summary>Pan over the stop (radians, positive left).</summary>
        public float Swivel { get; }
    }

    /// <summary>
    /// Where the tour's camera is at one moment: <see cref="TourTimeline.Evaluate"/>'s result.
    /// </summary>
    public struct TourPose
    {
        /// <summary>The stop whose state (sun, section, visibility) should be showing. During a glide: the stop being
        /// flown to.</summary>
        public int Stop;

        /// <summary>Feet position (scene-local metres).</summary>
        public Vector3 Feet;

        /// <summary>Eye height above the feet (m).</summary>
        public float EyeHeight;

        /// <summary>Look direction (radians).</summary>
        public float Yaw;

        /// <summary>Look pitch (radians).</summary>
        public float Pitch;

        /// <summary>How black the frame is (0 clear, 1 black): the fades.</summary>
        public float Black;

        /// <summary>True while gliding between stops.</summary>
        public bool Moving;

        /// <summary>True once the tour has played to its end.</summary>
        public bool Finished;

        /// <summary>
        /// Polish round P-C: the state (sun) blends from stop <see cref="BlendFrom"/> to <see cref="BlendTo"/> by
        /// <see cref="BlendT"/> (0–1, eased). Glide: the stop flown from → the one flown to, over the glide. Fades: half
        /// over the fade-out (→ 0.5 at black) and half over the next fade-in, so the cut at black is seamless. Holding
        /// a stop: from = to = <see cref="Stop"/>, 1.
        /// </summary>
        public int BlendFrom, BlendTo;

        /// <summary>See <see cref="BlendFrom"/>.</summary>
        public float BlendT;

        /// <summary>The eye position.</summary>
        public readonly Vector3 Eye => Feet + new Vector3(0f, 0f, EyeHeight);
    }

    /// <summary>
    /// The timing of a bookmark tour (tour round): pure maths, shared by live playback and (build A2) video recording,
    /// which steps it at a fixed frame rate.
    /// <list type="bullet">
    /// <item><b>Fade</b>: each stop is fade in (<c>fade</c> s) → hold → fade out (<c>fade</c> s); the stop changes at
    /// black. The swivel pans over the whole visible stop, eased in and out.</item>
    /// <item><b>Glide</b>: the first stop fades in and the last fades out; between stops the camera flies from the end
    /// of one stop's swivel to the next stop's view (position, eye height, yaw and pitch, eased). A glide takes at
    /// least <c>glide</c> s, longer when the stops are far apart (at most <see cref="GLIDE_SPEED"/> m/s). The swivel pans
    /// over the hold.</item>
    /// </list>
    /// </summary>
    public sealed class TourTimeline : ITourTimeline
    {
        /// <summary>Fastest glide between stops (m/s): far-apart stops glide for longer than the set time.</summary>
        public const float GLIDE_SPEED = 4f;

        /// <summary>Longest single glide (s), however far apart the stops are.</summary>
        public const float MAX_GLIDE_SECONDS = 30f;

        private readonly TourStop[] _stops;
        private readonly float[] _start;     // when each stop becomes the current one
        private readonly float[] _holdStart; // when each stop's hold begins
        private readonly float[] _glide;     // glide into each stop (glide transition; 0 for the first)
        private readonly bool _glideMode;
        private readonly float _fade;

        /// <summary>
        /// Lays out a tour.
        /// </summary>
        /// <param name="stops">The stops in order (copied).</param>
        /// <param name="transition">Fade or glide.</param>
        /// <param name="fadeSeconds">Fade length each way (s, 0 = cut).</param>
        /// <param name="glideSeconds">Shortest glide between stops (s).</param>
        public TourTimeline(IReadOnlyList<TourStop> stops, Format.TourTransition transition, float fadeSeconds, float glideSeconds)
        {
            _stops = stops?.ToArray() ?? Array.Empty<TourStop>();
            _glideMode = transition == Format.TourTransition.Glide;
            _fade = float.IsFinite(fadeSeconds) ? MathF.Max(0f, fadeSeconds) : 0f;
            float glide = float.IsFinite(glideSeconds) ? MathF.Max(0.1f, glideSeconds) : 3f;

            int n = _stops.Length;
            _start = new float[n];
            _holdStart = new float[n];
            _glide = new float[n];
            float t = 0f;
            for (int i = 0; i < n; i++)
            {
                if (!_glideMode)
                {
                    _start[i] = t;
                    _holdStart[i] = t + _fade;
                    t += _fade + _stops[i].HoldSeconds + _fade;
                }
                else if (i == 0)
                {
                    _start[i] = 0f;
                    _holdStart[i] = _fade;
                    t = _fade + _stops[i].HoldSeconds;
                }
                else
                {
                    float distance = Vector3.Distance(_stops[i - 1].Feet, _stops[i].Feet);
                    _glide[i] = Math.Clamp(MathF.Max(glide, distance / GLIDE_SPEED), glide, MathF.Max(glide, MAX_GLIDE_SECONDS));
                    _start[i] = t;
                    _holdStart[i] = t + _glide[i];
                    t = _holdStart[i] + _stops[i].HoldSeconds;
                }
            }
            Duration = n == 0 ? 0f : _glideMode ? t + _fade : t;
        }

        /// <summary>Number of stops.</summary>
        public int Count => _stops.Length;

        /// <summary>Total length (s).</summary>
        public float Duration { get; }

        /// <summary>A stop (for the HUD and for applying its state).</summary>
        public TourStop this[int index] => _stops[index];

        /// <summary>
        /// When a stop becomes the current one (s): its fade-in, or the start of the glide into it. Seeking here plays
        /// the stop from its beginning.
        /// </summary>
        public float StartOf(int stop) => _stops.Length == 0 ? 0f : _start[Math.Clamp(stop, 0, _stops.Length - 1)];

        /// <summary>
        /// The current stop at a time (clamped to the tour).
        /// </summary>
        public int StopAt(float time)
        {
            if (_stops.Length == 0) { return -1; }
            int stop = 0;
            for (int i = 1; i < _start.Length; i++)
            {
                if (_start[i] <= time) { stop = i; }
                else { break; }
            }
            return stop;
        }

        /// <summary>
        /// The camera at a time. Allocation-free.
        /// </summary>
        /// <param name="time">Seconds from the start (clamped at 0; at or past <see cref="Duration"/> the tour is
        /// finished and the frame is black when there are fades).</param>
        public TourPose Evaluate(float time)
        {
            var pose = new TourPose { Stop = -1, Finished = true, BlendFrom = -1, BlendTo = -1, BlendT = 1f };
            int n = _stops.Length;
            if (n == 0) { return pose; }

            if (!float.IsFinite(time) || time < 0f) { time = 0f; }
            if (time >= Duration)
            {
                // The last stop's final view
                TourStop last = _stops[n - 1];
                pose.Stop = n - 1;
                pose.BlendFrom = pose.BlendTo = n - 1;
                pose.Feet = last.Feet;
                pose.EyeHeight = last.EyeHeight;
                pose.Yaw = last.Yaw + last.Swivel;
                pose.Pitch = last.Pitch;
                pose.Black = _fade > 0f ? 1f : 0f;
                return pose;
            }

            pose.Finished = false;
            int i = StopAt(time);
            TourStop stop = _stops[i];
            pose.Stop = i;
            pose.BlendFrom = pose.BlendTo = i;
            pose.Pitch = stop.Pitch;

            if (!_glideMode)
            {
                // Fade in → hold → fade out; the swivel runs across the whole visible stop
                float local = time - _start[i];
                float window = _fade + stop.HoldSeconds + _fade;
                pose.Feet = stop.Feet;
                pose.EyeHeight = stop.EyeHeight;
                pose.Yaw = stop.Yaw + stop.Swivel * Smooth(window > 0f ? local / window : 1f);
                if (_fade > 0f)
                {
                    if (local < _fade)
                    {
                        pose.Black = 1f - local / _fade;
                        if (i > 0) { SetBlend(ref pose, i - 1, i, 0.5f + 0.5f * Smooth(local / _fade)); } // P-C
                    }
                    else if (local > _fade + stop.HoldSeconds)
                    {
                        pose.Black = Math.Clamp((local - _fade - stop.HoldSeconds) / _fade, 0f, 1f);
                        if (i + 1 < n) { SetBlend(ref pose, i, i + 1, 0.5f * Smooth(pose.Black)); }
                    }
                }
                return pose;
            }

            // Glide: flying in from the previous stop?
            if (i > 0 && time < _holdStart[i])
            {
                TourStop from = _stops[i - 1];
                float s = Smooth((time - _start[i]) / _glide[i]);
                pose.Feet = Vector3.Lerp(from.Feet, stop.Feet, s);
                pose.EyeHeight = from.EyeHeight + (stop.EyeHeight - from.EyeHeight) * s;
                pose.Yaw = LerpAngle(from.Yaw + from.Swivel, stop.Yaw, s);
                pose.Pitch = from.Pitch + (stop.Pitch - from.Pitch) * s;
                pose.Moving = true;
                SetBlend(ref pose, i - 1, i, s); // P-C: the sun blends over the glide
                return pose;
            }

            // The first stop's fade-in, the hold (swivel), and the last stop's fade-out
            float hold = time - _holdStart[i];
            pose.Feet = stop.Feet;
            pose.EyeHeight = stop.EyeHeight;
            if (hold < 0f)
            {
                pose.Yaw = stop.Yaw;
                pose.Black = _fade > 0f ? Math.Clamp(-hold / _fade, 0f, 1f) : 0f;
            }
            else if (hold <= stop.HoldSeconds)
            {
                pose.Yaw = stop.Yaw + stop.Swivel * Smooth(stop.HoldSeconds > 0f ? hold / stop.HoldSeconds : 1f);
            }
            else
            {
                pose.Yaw = stop.Yaw + stop.Swivel;
                pose.Black = _fade > 0f ? Math.Clamp((hold - stop.HoldSeconds) / _fade, 0f, 1f) : 0f;
            }
            return pose;
        }

        /// <summary>Round K: the tour player's pose (the same as <see cref="Evaluate"/>).</summary>
        public TourPose Pose(float time) => Evaluate(time);

        private static void SetBlend(ref TourPose pose, int from, int to, float t)
        {
            pose.BlendFrom = from;
            pose.BlendTo = to;
            pose.BlendT = Math.Clamp(t, 0f, 1f);
        }

        /// <summary>
        /// Smoothstep: eases in and out over 0..1 (clamped).
        /// </summary>
        public static float Smooth(float u)
        {
            u = Math.Clamp(u, 0f, 1f);
            return u * u * (3f - 2f * u);
        }

        /// <summary>
        /// Interpolates two angles the short way round (radians).
        /// </summary>
        public static float LerpAngle(float from, float to, float t)
        {
            float delta = (to - from) % MathF.Tau;
            if (delta > MathF.PI) { delta -= MathF.Tau; }
            else if (delta < -MathF.PI) { delta += MathF.Tau; }
            return from + delta * t;
        }
    }
}
