using System.Diagnostics;
using System.Numerics;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// One surface of a sun hours study: coplanar triangles of one element, the room it is clipped to (if any) and
    /// how its normal is chosen.
    /// </summary>
    internal sealed class SunHoursFace
    {
        /// <summary>The element (index into SceneData.Elements).</summary>
        public int Element;

        /// <summary>
        /// The plane normal. For <see cref="BothSides"/> faces its sign is arbitrary and each cell takes the side that
        /// faces <see cref="Room"/>; otherwise it is the side tested.
        /// </summary>
        public Vector3 Normal;

        /// <summary>The plane offset (dot(normal, point)).</summary>
        public float Offset;

        /// <summary>The face's triangles (world, scene-local).</summary>
        public readonly List<(Vector3 A, Vector3 B, Vector3 C)> Triangles = new();

        /// <summary>The room the cells are clipped to, or -1 (the whole face).</summary>
        public int Room = -1;

        /// <summary>True for walls found from a room: each cell faces whichever side is inside the room.</summary>
        public bool BothSides;

        /// <summary>True when picked by clicking (not part of the room selection).</summary>
        public bool Picked;

        /// <summary>True for floors and other upward / downward faces (they take the floor offset).</summary>
        public bool Horizontal => MathF.Abs(Normal.Z) > 0.7f;

        /// <summary>True when another face lies in the same plane of the same element (either normal sign).</summary>
        public bool SamePlane(int element, Vector3 normal, float offset) =>
            element == Element && MathF.Abs(Vector3.Dot(normal, Normal)) > 0.995f &&
            MathF.Abs(offset * MathF.Sign(Vector3.Dot(normal, Normal)) - Offset) < 0.02f;
    }

    /// <summary>
    /// A direct sun hours study (sun hours round): a pixelated test grid over the chosen faces, and per cell the hours
    /// of direct sun over the study's time range. The grid is built at once; the ray casting runs on the game thread
    /// a few milliseconds per frame (<see cref="Step"/>), so the BVH needs no locking and moved / placed elements
    /// block the sun too. Never throws.
    /// </summary>
    internal sealed class SunHoursStudy
    {
        /// <summary>Most cells in one study (a larger grid is suggested beyond this).</summary>
        public const int MAX_CELLS = 80_000;

        /// <summary>Test points sit this far off their surface on top of the offset (m), clear of it for the rays.</summary>
        private const float LIFT = 0.02f;

        /// <summary>A sun this close to grazing a surface (cosine) gives it no sun.</summary>
        private const float GRAZING = 0.02f;

        /// <summary>Rays stop at this distance (m): anything further can't shade a room.</summary>
        private const float MAX_DISTANCE = 1500f;

        // Cells
        private readonly List<Vector3> _points = new();
        private readonly List<Vector3> _normals = new();
        private readonly List<Vector3> _u = new(), _v = new();
        private readonly List<int> _faceOf = new();

        /// <summary>The settings the grid was built with (cell size, offsets).</summary>
        public SunHoursSettings Settings { get; private set; }

        /// <summary>The faces the grid covers.</summary>
        public IReadOnlyList<SunHoursFace> Faces { get; private set; } = Array.Empty<SunHoursFace>();

        /// <summary>Number of cells.</summary>
        public int CellCount => _points.Count;

        /// <summary>True when the faces gave more than <see cref="MAX_CELLS"/> cells (the grid stops there).</summary>
        public bool Truncated { get; private set; }

        /// <summary>Hours of direct sun per cell (valid up to <see cref="Done"/>), or null before a run.</summary>
        public float[] Hours { get; private set; }

        /// <summary>Cells computed so far in the current run.</summary>
        public int Done { get; private set; }

        /// <summary>True while a run is in progress.</summary>
        public bool Running { get; private set; }

        /// <summary>True when a run finished (results complete).</summary>
        public bool Finished { get; private set; }

        /// <summary>Changes whenever cells or results change (the overlay rebuilds on a change).</summary>
        public int Revision { get; private set; }

        /// <summary>The run's sun samples above the horizon, and all samples in the range.</summary>
        public int SunSamples { get; private set; }

        /// <inheritdoc cref="SunSamples"/>
        public int TotalSamples { get; private set; }

        /// <summary>The run's settings (date, times, glass), for the summary and the export.</summary>
        public SunHoursSettings RunSettings { get; private set; }

        /// <summary>Run time.</summary>
        public TimeSpan Elapsed { get; private set; }

        private List<Vector3> _directions = new();
        private readonly Stopwatch _clock = new();

        #region Grid

        /// <summary>
        /// Lays the test grid over the faces: square cells of the grid size in each face's plane (U horizontal on walls,
        /// along X on floors; snapped to the plane's own origin so neighbouring faces line up), kept where the cell
        /// centre lies on a triangle and, for faces clipped to a room, where its tested side faces into the room.
        /// Clears any results.
        /// </summary>
        public void Build(IReadOnlyList<SunHoursFace> faces, SunHoursSettings settings, RoomInfo[] rooms)
        {
            Cancel();
            Settings = settings;
            Faces = faces ?? Array.Empty<SunHoursFace>();
            _points.Clear();
            _normals.Clear();
            _u.Clear();
            _v.Clear();
            _faceOf.Clear();
            Hours = null;
            Finished = false;
            Done = 0;
            Truncated = false;
            Revision++;

            float g = settings.GridSize;
            for (int f = 0; f < Faces.Count && !Truncated; f++)
            {
                SunHoursFace face = Faces[f];
                if (face.Triangles.Count == 0) { continue; }
                Vector3 n = face.Normal;
                Vector3 u = MathF.Abs(n.Z) > 0.7f
                    ? Vector3.Normalize(Vector3.UnitX - n * Vector3.Dot(n, Vector3.UnitX))
                    : Vector3.Normalize(Vector3.Cross(Vector3.UnitZ, n));
                Vector3 v = Vector3.Cross(n, u);
                Vector3 origin = n * face.Offset; // the plane's point nearest the scene origin: shared by coplanar faces

                // The face in plane coordinates
                var flat = new (Vector2 A, Vector2 B, Vector2 C)[face.Triangles.Count];
                var min = new Vector2(float.MaxValue);
                var max = new Vector2(float.MinValue);
                for (int t = 0; t < flat.Length; t++)
                {
                    (Vector3 a, Vector3 b, Vector3 c) = face.Triangles[t];
                    flat[t] = (Project(a - origin, u, v), Project(b - origin, u, v), Project(c - origin, u, v));
                    min = Vector2.Min(min, Vector2.Min(flat[t].A, Vector2.Min(flat[t].B, flat[t].C)));
                    max = Vector2.Max(max, Vector2.Max(flat[t].A, Vector2.Max(flat[t].B, flat[t].C)));
                }

                RoomInfo room = face.Room >= 0 && face.Room < rooms.Length ? rooms[face.Room] : null;
                float offset = (face.Horizontal ? settings.FloorOffset : settings.WallOffset) + LIFT;
                int i0 = (int)MathF.Floor(min.X / g), i1 = (int)MathF.Floor(max.X / g);
                int j0 = (int)MathF.Floor(min.Y / g), j1 = (int)MathF.Floor(max.Y / g);
                for (int j = j0; j <= j1 && !Truncated; j++)
                {
                    for (int i = i0; i <= i1; i++)
                    {
                        var centre = new Vector2((i + 0.5f) * g, (j + 0.5f) * g);
                        if (!OnFace(flat, centre)) { continue; }
                        Vector3 p = origin + u * centre.X + v * centre.Y;
                        if (!SideOf(face, room, p, out Vector3 normal)) { continue; }

                        if (_points.Count >= MAX_CELLS)
                        {
                            Truncated = true;
                            break;
                        }
                        _points.Add(p + normal * offset);
                        _normals.Add(normal);
                        _u.Add(u);
                        _v.Add(v);
                        _faceOf.Add(f);
                    }
                }
            }
        }

        /// <summary>
        /// The side a cell is tested on (false when the cell is dropped): for room-clipped faces the cell's side must
        /// lie inside the room (walls: within 6 cm of its boundary, so the far face of a thin partition isn't taken);
        /// otherwise the face's own normal.
        /// </summary>
        private static bool SideOf(SunHoursFace face, RoomInfo room, Vector3 p, out Vector3 normal)
        {
            normal = face.Normal;
            if (room == null) { return true; }

            if (face.Horizontal)
            {
                // Floors (and other flat faces) in the room's plan, near its height range
                return room.Contains(new Vector2(p.X, p.Y)) && p.Z > room.BottomZ - 0.3f && p.Z < room.TopZ + 0.5f;
            }

            if (p.Z < room.BottomZ - 0.05f || p.Z > room.TopZ + 0.5f) { return false; }
            var plan = new Vector2(p.X, p.Y);
            if (face.BothSides && room.DistanceToBoundary(plan) > 0.06f) { return false; }
            Vector3 front = p + face.Normal * 0.1f;
            if (room.Contains(new Vector2(front.X, front.Y))) { return true; }
            if (!face.BothSides) { return false; }
            Vector3 back = p - face.Normal * 0.1f;
            if (!room.Contains(new Vector2(back.X, back.Y))) { return false; }
            normal = -face.Normal;
            return true;
        }

        private static Vector2 Project(Vector3 p, Vector3 u, Vector3 v) => new(Vector3.Dot(p, u), Vector3.Dot(p, v));

        /// <summary>True when a plane point lies on any of the face's triangles (1 mm tolerance).</summary>
        private static bool OnFace((Vector2 A, Vector2 B, Vector2 C)[] triangles, Vector2 p)
        {
            foreach ((Vector2 a, Vector2 b, Vector2 c) in triangles)
            {
                float d1 = Cross(b - a, p - a), d2 = Cross(c - b, p - b), d3 = Cross(a - c, p - c);
                bool negative = d1 < -1e-6f || d2 < -1e-6f || d3 < -1e-6f;
                bool positive = d1 > 1e-6f || d2 > 1e-6f || d3 > 1e-6f;
                if (!(negative && positive)) { return true; }
            }
            return false;
        }

        private static float Cross(Vector2 a, Vector2 b) => a.X * b.Y - a.Y * b.X;

        #endregion

        #region Run

        /// <summary>
        /// Starts (or restarts) the run with these sun directions (scene axes, sun above the horizon).
        /// </summary>
        public void Start(List<Vector3> directions, int totalSamples, SunHoursSettings settings)
        {
            _directions = directions ?? new List<Vector3>();
            SunSamples = _directions.Count;
            TotalSamples = totalSamples;
            RunSettings = settings;
            Hours = new float[_points.Count];
            Done = 0;
            Finished = false;
            Running = _points.Count > 0;
            Elapsed = TimeSpan.Zero;
            Revision++;
        }

        /// <summary>Stops a run (cells computed so far keep their hours, the rest show as not run).</summary>
        public void Cancel()
        {
            if (!Running) { return; }
            Running = false;
            Revision++;
        }

        /// <summary>
        /// Computes cells for up to <paramref name="budgetMs"/> milliseconds: per cell, every sun sample in front of
        /// its surface whose ray reaches the sky adds one step of sun.
        /// </summary>
        /// <param name="blocked">True when a ray from a point towards a direction hits something.</param>
        /// <param name="budgetMs">Time allowed this frame.</param>
        public void Step(Func<Vector3, Vector3, float, bool> blocked, double budgetMs)
        {
            if (!Running) { return; }
            _clock.Restart();
            float hoursPerSample = RunSettings.StepMinutes / 60f;
            int start = Done;
            while (Done < _points.Count)
            {
                Vector3 p = _points[Done], n = _normals[Done];
                int sunny = 0;
                foreach (Vector3 direction in _directions)
                {
                    if (Vector3.Dot(direction, n) <= GRAZING) { continue; }
                    if (!blocked(p, direction, MAX_DISTANCE)) { sunny++; }
                }
                Hours[Done] = sunny * hoursPerSample;
                Done++;
                if (((Done - start) & 7) == 0 && _clock.Elapsed.TotalMilliseconds >= budgetMs) { break; }
            }
            Elapsed += _clock.Elapsed;
            Revision++;
            if (Done >= _points.Count)
            {
                Running = false;
                Finished = true;
            }
        }

        #endregion

        #region Results

        /// <summary>
        /// Cell i: its test point, normal, in-plane axes and face index.
        /// </summary>
        public void Cell(int i, out Vector3 point, out Vector3 normal, out Vector3 u, out Vector3 v, out int face)
        {
            point = _points[i];
            normal = _normals[i];
            u = _u[i];
            v = _v[i];
            face = _faceOf[i];
        }

        /// <summary>
        /// Statistics of the computed cells: average, minimum, maximum hours and the share of cells with at least 2 h
        /// and 3 h (cells are equal areas, so these are area shares).
        /// </summary>
        public (float Average, float Min, float Max, float AtLeast2, float AtLeast3) Statistics()
        {
            if (Hours == null || Done == 0) { return (0f, 0f, 0f, 0f, 0f); }
            double sum = 0;
            float min = float.MaxValue, max = 0f;
            int two = 0, three = 0;
            for (int i = 0; i < Done; i++)
            {
                float h = Hours[i];
                sum += h;
                min = MathF.Min(min, h);
                max = MathF.Max(max, h);
                if (h >= 2f - 1e-4f) { two++; }
                if (h >= 3f - 1e-4f) { three++; }
            }
            return ((float)(sum / Done), min, max, (float)two / Done, (float)three / Done);
        }

        #endregion
    }
}
