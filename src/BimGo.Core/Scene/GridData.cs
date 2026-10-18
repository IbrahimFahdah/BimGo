using System.Numerics;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Grids round A: one Revit grid as the walkthrough draws it: its name, its plan line (straight, an arc's points, or a
    /// multi-segment grid's segments joined in order) and its 3D vertical extent. Host grids and grids of the extracted
    /// links (through their transforms). Scene-local metres, like the geometry.
    /// </summary>
    public sealed class GridLine
    {
        /// <summary>The grid's name (its bubble text, e.g. "A" or "12").</summary>
        public string Name { get; init; } = string.Empty;

        /// <summary>0 for the host, n for <c>SceneData.Links[n - 1]</c>.</summary>
        public int Link { get; init; }

        /// <summary>The plan polyline (at least two points; arcs are tessellated).</summary>
        public Vector2[] Points { get; init; } = Array.Empty<Vector2>();

        /// <summary>Bottom of the grid's 3D extent (scene Z, m), or −∞ when unknown.</summary>
        public float Bottom { get; init; } = float.NegativeInfinity;

        /// <summary>Top of the grid's 3D extent (scene Z, m), or +∞ when unknown.</summary>
        public float Top { get; init; } = float.PositiveInfinity;

        /// <summary>True for an arc grid (or a multi-segment grid with an arc).</summary>
        public bool Curved { get; init; }

        /// <summary>True when the vertical extent is known (both ends finite, top at or above bottom).</summary>
        public bool HasExtent => float.IsFinite(Bottom) && float.IsFinite(Top) && Top >= Bottom;

        /// <summary>True when the line can be drawn (two or more points).</summary>
        public bool IsValid => Points != null && Points.Length >= 2;

        /// <summary>The line's start (the first bubble).</summary>
        public Vector2 Start => Points[0];

        /// <summary>The line's end (the second bubble).</summary>
        public Vector2 End => Points[^1];

        /// <summary>Direction leaving the start, pointing away from the line (unit; +X when degenerate).</summary>
        public Vector2 StartOutward => Outward(Points[0], Points[1]);

        /// <summary>Direction leaving the end, pointing away from the line (unit; +X when degenerate).</summary>
        public Vector2 EndOutward => Outward(Points[^1], Points[^2]);

        private static Vector2 Outward(Vector2 tip, Vector2 inner)
        {
            Vector2 d = tip - inner;
            float length = d.Length();
            return length > 1e-6f ? d / length : Vector2.UnitX;
        }
    }

    /// <summary>Grids round A: which levels the grids are drawn on (the C key cycles them).</summary>
    public enum GridLevelMode : byte
    {
        /// <summary>No grids.</summary>
        Off = 0,

        /// <summary>Only the level underfoot (the one the status panel shows).</summary>
        Underfoot = 1,

        /// <summary>Every level (building storeys only by default).</summary>
        All = 2,

        /// <summary>The next level up from the one underfoot (storeys only by default).</summary>
        Above = 3,

        /// <summary>The next level down from the one underfoot (storeys only by default).</summary>
        Below = 4,

        /// <summary>The level nearest the eye (flying, clash mode: where you are looking from).</summary>
        Nearest = 5,

        /// <summary>The level underfoot and the next ones below and above.</summary>
        Adjacent = 6
    }

    /// <summary>
    /// Grids round A: the pure rules behind the grid overlay (which grids show on which level, the plan bounds the level
    /// outlines frame). Allocation-free where it runs per frame; testable without a GPU.
    /// </summary>
    public static class GridLayout
    {
        /// <summary>A level within this of a grid's 3D extent still shows it (m): Revit extents end on the level line.</summary>
        public const float EXTENT_TOLERANCE = 0.05f;

        /// <summary>How far the level outline stands off the grids' plan bounds (m).</summary>
        public const float OUTLINE_MARGIN = 2f;

        /// <summary>
        /// True when the grid is drawn at this elevation: always when extents are ignored or unknown, else when the
        /// elevation lies inside its 3D extent (± <see cref="EXTENT_TOLERANCE"/>).
        /// </summary>
        public static bool ShowsAt(GridLine grid, float elevation, bool respectExtents)
        {
            if (grid == null || !grid.IsValid) { return false; }
            if (!respectExtents || !grid.HasExtent) { return true; }
            return elevation >= grid.Bottom - EXTENT_TOLERANCE && elevation <= grid.Top + EXTENT_TOLERANCE;
        }

        /// <summary>
        /// The level indices to draw on, in elevation order (levels are sorted by elevation), into
        /// <paramref name="into"/> (cleared first).
        /// <list type="bullet">
        /// <item>Underfoot: just <paramref name="underfoot"/> (even when it isn't a building storey: it is where the
        /// player is).</item>
        /// <item>Above / below: the next storey up / down from it (any level when <paramref name="storeysOnly"/> is off);
        /// nothing past the top / bottom.</item>
        /// <item>Nearest: the level whose elevation is nearest <paramref name="eyeZ"/>.</item>
        /// <item>Adjacent: below, underfoot and above.</item>
        /// <item>All: every level, or only the building storeys (every level when none is a storey).</item>
        /// </list>
        /// </summary>
        public static void ShownLevels(IReadOnlyList<LevelInfo> levels, GridLevelMode mode, int underfoot, float eyeZ, bool storeysOnly, List<int> into)
        {
            into.Clear();
            if (levels == null || levels.Count == 0 || mode == GridLevelMode.Off) { return; }
            int here = Math.Clamp(underfoot, 0, levels.Count - 1);
            bool anyStorey = false;
            for (int i = 0; i < levels.Count && !anyStorey; i++) { anyStorey = levels[i].IsStorey; }
            bool filter = storeysOnly && anyStorey;

            switch (mode)
            {
                case GridLevelMode.Underfoot:
                    into.Add(here);
                    return;
                case GridLevelMode.Above:
                    AddIfAny(into, Step(levels, here, +1, filter));
                    return;
                case GridLevelMode.Below:
                    AddIfAny(into, Step(levels, here, -1, filter));
                    return;
                case GridLevelMode.Nearest:
                    int best = 0;
                    for (int i = 1; i < levels.Count; i++)
                    {
                        if (MathF.Abs(levels[i].Elevation - eyeZ) < MathF.Abs(levels[best].Elevation - eyeZ)) { best = i; }
                    }
                    into.Add(best);
                    return;
                case GridLevelMode.Adjacent:
                    AddIfAny(into, Step(levels, here, -1, filter));
                    into.Add(here);
                    AddIfAny(into, Step(levels, here, +1, filter));
                    return;
                default:
                    for (int i = 0; i < levels.Count; i++)
                    {
                        if (!filter || levels[i].IsStorey) { into.Add(i); }
                    }
                    return;
            }
        }

        // The next level from "from" in a direction (storeys only when filtered), or -1 past the end
        private static int Step(IReadOnlyList<LevelInfo> levels, int from, int direction, bool storeysOnly)
        {
            for (int i = from + direction; i >= 0 && i < levels.Count; i += direction)
            {
                if (!storeysOnly || levels[i].IsStorey) { return i; }
            }
            return -1;
        }

        private static void AddIfAny(List<int> into, int index)
        {
            if (index >= 0) { into.Add(index); }
        }

        /// <summary>The level modes in the panel's order (its dropdown).</summary>
        public static readonly GridLevelMode[] PANEL_ORDER =
        {
            GridLevelMode.Off, GridLevelMode.Underfoot, GridLevelMode.Above, GridLevelMode.Below, GridLevelMode.Adjacent,
            GridLevelMode.Nearest, GridLevelMode.All
        };

        /// <summary>A mode's label (panel, toasts).</summary>
        public static string Label(GridLevelMode mode) => mode switch
        {
            GridLevelMode.Underfoot => "Underfoot",
            GridLevelMode.Above => "Above",
            GridLevelMode.Below => "Below",
            GridLevelMode.Nearest => "Nearest the eye",
            GridLevelMode.Adjacent => "Underfoot ±1",
            GridLevelMode.All => "All levels",
            _ => "Off"
        };

        /// <summary>
        /// The plan bounds of the grids drawn at an elevation (link grids only when <paramref name="links"/>), grown by
        /// <see cref="OUTLINE_MARGIN"/>. False when none shows there.
        /// </summary>
        public static bool PlanBounds(IReadOnlyList<GridLine> grids, float elevation, bool respectExtents, bool links, out Vector2 min, out Vector2 max)
        {
            min = new Vector2(float.MaxValue);
            max = new Vector2(float.MinValue);
            bool any = false;
            if (grids != null)
            {
                foreach (GridLine grid in grids)
                {
                    if (!Included(grid, links) || !ShowsAt(grid, elevation, respectExtents)) { continue; }
                    foreach (Vector2 p in grid.Points)
                    {
                        min = Vector2.Min(min, p);
                        max = Vector2.Max(max, p);
                    }
                    any = true;
                }
            }
            if (!any) { return false; }
            min -= new Vector2(OUTLINE_MARGIN);
            max += new Vector2(OUTLINE_MARGIN);
            return true;
        }

        /// <summary>True when the grid is drawn at all: valid, and a host grid or link grids are on.</summary>
        public static bool Included(GridLine grid, bool links) => grid != null && grid.IsValid && (grid.Link == 0 || links);

        /// <summary>
        /// The next mode the cycle key goes to: off → underfoot → all → off (the other modes, picked in the panel, go to
        /// all, then off).
        /// </summary>
        public static GridLevelMode Next(GridLevelMode mode) => mode switch
        {
            GridLevelMode.Off => GridLevelMode.Underfoot,
            GridLevelMode.All => GridLevelMode.Off,
            _ => GridLevelMode.All
        };

        /// <summary>
        /// Joins a multi-segment grid's segments (in any order and direction) into one polyline: starts from a segment
        /// with a free end (no other segment's end within 1 cm), then repeatedly takes the unused segment with an end
        /// nearest the line's end. Empty when there are no points.
        /// </summary>
        public static List<Vector2> Chain(IReadOnlyList<Vector2[]> segments)
        {
            var line = new List<Vector2>();
            if (segments == null) { return line; }
            var pending = new List<Vector2[]>();
            foreach (Vector2[] s in segments)
            {
                if (s != null && s.Length >= 2) { pending.Add(s); }
            }
            if (pending.Count == 0) { return line; }

            // A free end to start from (the first segment when the chain is closed)
            int first = 0;
            bool flip = false, found = false;
            for (int i = 0; i < pending.Count && !found; i++)
            {
                for (int end = 0; end < 2 && !found; end++)
                {
                    Vector2 p = end == 0 ? pending[i][0] : pending[i][^1];
                    if (!NearAnyEnd(pending, i, p, 0.01f))
                    {
                        first = i;
                        flip = end == 1;
                        found = true;
                    }
                }
            }
            Vector2[] start = pending[first];
            pending.RemoveAt(first);
            if (flip)
            {
                for (int k = start.Length - 1; k >= 0; k--) { line.Add(start[k]); }
            }
            else { line.AddRange(start); }

            while (pending.Count > 0)
            {
                int best = 0;
                float bestDistance = float.MaxValue;
                for (int i = 0; i < pending.Count; i++)
                {
                    float d = MathF.Min(Vector2.DistanceSquared(line[^1], pending[i][0]), Vector2.DistanceSquared(line[^1], pending[i][^1]));
                    if (d < bestDistance)
                    {
                        bestDistance = d;
                        best = i;
                    }
                }
                AppendSegment(line, pending[best]);
                pending.RemoveAt(best);
            }
            return line;
        }

        private static bool NearAnyEnd(List<Vector2[]> segments, int self, Vector2 p, float tolerance)
        {
            float t2 = tolerance * tolerance;
            for (int j = 0; j < segments.Count; j++)
            {
                if (j == self) { continue; }
                if (Vector2.DistanceSquared(segments[j][0], p) < t2 || Vector2.DistanceSquared(segments[j][^1], p) < t2) { return true; }
            }
            return false;
        }

        /// <summary>
        /// Joins a segment's points onto a polyline in order (multi-segment grids): the segment is reversed when its far
        /// end meets the line, and a shared joint is kept once.
        /// </summary>
        public static void AppendSegment(List<Vector2> line, IReadOnlyList<Vector2> segment)
        {
            if (segment == null || segment.Count == 0) { return; }
            if (line.Count == 0)
            {
                line.AddRange(segment);
                return;
            }
            Vector2 last = line[^1];
            bool reverse = Vector2.DistanceSquared(last, segment[^1]) < Vector2.DistanceSquared(last, segment[0]);
            for (int k = 0; k < segment.Count; k++)
            {
                Vector2 p = segment[reverse ? segment.Count - 1 - k : k];
                if (Vector2.DistanceSquared(line[^1], p) < 1e-8f) { continue; }
                line.Add(p);
            }
        }
    }

    /// <summary>
    /// Grids round B: a grid intersection: the two grids (indices into the scene's grids), where they cross (plan,
    /// scene metres) and its name ("C-4": the lettered grid first, as Navisworks writes it).
    /// </summary>
    public readonly record struct GridNode(int A, int B, Vector2 Point, string Name);

    /// <summary>
    /// Grids round B: a clash's (or any point's) grid location: the nearest intersection's name, the level it is on and
    /// how far it is from the intersection in plan.
    /// </summary>
    public readonly record struct GridLocation(string Node, string Level, float Offset, Vector2 Point)
    {
        /// <summary>"C-4 : Level 2" (Navisworks' gridlocation), or "C-4" without a level.</summary>
        public string Text => string.IsNullOrEmpty(Level) ? Node : Node + " : " + Level;
    }

    /// <summary>
    /// Grids round B: grid intersections and the nearest-intersection lookup behind clash grid locations and the
    /// AUTO GROUP by grid methods. Pure, testable.
    /// </summary>
    public static class GridNodes
    {
        /// <summary>
        /// Every crossing of two grids of the same model (host × host, link n × link n), each segment pair tested; a
        /// crossing found twice at a shared polyline joint is kept once.
        /// </summary>
        public static GridNode[] Build(IReadOnlyList<GridLine> grids)
        {
            var nodes = new List<GridNode>();
            if (grids == null) { return Array.Empty<GridNode>(); }
            for (int a = 0; a < grids.Count; a++)
            {
                GridLine ga = grids[a];
                if (ga == null || !ga.IsValid) { continue; }
                for (int b = a + 1; b < grids.Count; b++)
                {
                    GridLine gb = grids[b];
                    if (gb == null || !gb.IsValid || gb.Link != ga.Link) { continue; }
                    int first = nodes.Count;
                    for (int i = 1; i < ga.Points.Length; i++)
                    {
                        for (int j = 1; j < gb.Points.Length; j++)
                        {
                            if (!Intersect(ga.Points[i - 1], ga.Points[i], gb.Points[j - 1], gb.Points[j], out Vector2 x)) { continue; }
                            bool seen = false;
                            for (int k = first; k < nodes.Count && !seen; k++) { seen = Vector2.DistanceSquared(nodes[k].Point, x) < 1e-6f; }
                            if (!seen) { nodes.Add(new GridNode(a, b, x, NodeName(ga.Name, gb.Name))); }
                        }
                    }
                }
            }
            return nodes.ToArray();
        }

        /// <summary>
        /// "C-4": the name starting with a letter first (Revit's lettered grids run one way, numbered the other); two of a
        /// kind in ordinal order.
        /// </summary>
        public static string NodeName(string a, string b)
        {
            a = string.IsNullOrWhiteSpace(a) ? "?" : a.Trim();
            b = string.IsNullOrWhiteSpace(b) ? "?" : b.Trim();
            bool la = char.IsLetter(a[0]), lb = char.IsLetter(b[0]);
            bool aFirst = la != lb ? la : string.CompareOrdinal(a, b) <= 0;
            return aFirst ? a + "-" + b : b + "-" + a;
        }

        /// <summary>Two segments' crossing (ends included; parallel or touching-only-by-overlap: none).</summary>
        public static bool Intersect(Vector2 p1, Vector2 p2, Vector2 q1, Vector2 q2, out Vector2 point)
        {
            point = default;
            Vector2 r = p2 - p1, s = q2 - q1;
            float denom = r.X * s.Y - r.Y * s.X;
            float scale = r.Length() * s.Length();
            if (scale < 1e-12f || MathF.Abs(denom) < 1e-6f * scale) { return false; }
            Vector2 qp = q1 - p1;
            float t = (qp.X * s.Y - qp.Y * s.X) / denom;
            float u = (qp.X * r.Y - qp.Y * r.X) / denom;
            const float E = 1e-5f;
            if (t < -E || t > 1f + E || u < -E || u > 1f + E) { return false; }
            point = p1 + r * t;
            return true;
        }

        /// <summary>True when both grids are drawn at this elevation (see <see cref="GridLayout.ShowsAt"/>).</summary>
        public static bool ShowsAt(GridNode node, IReadOnlyList<GridLine> grids, float elevation, bool respectExtents) =>
            (uint)node.A < (uint)grids.Count && (uint)node.B < (uint)grids.Count
            && GridLayout.ShowsAt(grids[node.A], elevation, respectExtents) && GridLayout.ShowsAt(grids[node.B], elevation, respectExtents);
    }

    /// <summary>
    /// Grids round B: where a point is on the grid: the level it is on (the highest building storey at or below it, any
    /// level when there are no storeys) and the nearest intersection (host grids; the links' when the host has none),
    /// preferring intersections whose grids reach that level. Built once per scene; a lookup scans the nodes.
    /// </summary>
    public sealed class GridLocator
    {
        private readonly GridLine[] _grids;
        private readonly GridNode[] _nodes;
        private readonly LevelInfo[] _levels;
        private readonly Vector3 _origin;

        /// <summary>A locator with no grids (every lookup fails).</summary>
        public static readonly GridLocator Empty = new(Array.Empty<GridLine>(), Array.Empty<GridNode>(), Array.Empty<LevelInfo>(), Vector3.Zero);

        private GridLocator(GridLine[] grids, GridNode[] nodes, LevelInfo[] levels, Vector3 origin)
        {
            _grids = grids;
            _nodes = nodes;
            _levels = levels;
            _origin = origin;
        }

        /// <summary>True when there are no intersections to locate by.</summary>
        public bool IsEmpty => _nodes.Length == 0;

        /// <summary>
        /// Builds the locator: the host's grid intersections, else (no host intersections) the links'.
        /// </summary>
        /// <param name="grids">The scene's grids.</param>
        /// <param name="nodes">Their intersections (<see cref="GridNodes.Build"/>).</param>
        /// <param name="levels">The scene's levels (sorted by elevation).</param>
        /// <param name="origin">Scene origin in internal metres (internal = local + origin).</param>
        public static GridLocator Create(GridLine[] grids, GridNode[] nodes, LevelInfo[] levels, Vector3 origin)
        {
            if (grids == null || nodes == null || nodes.Length == 0) { return Empty; }
            GridNode[] host = nodes.Where(n => grids[n.A].Link == 0).ToArray();
            GridNode[] use = host.Length > 0 ? host : nodes;
            LevelInfo[] storeys = (levels ?? Array.Empty<LevelInfo>()).Where(l => l.IsStorey).ToArray();
            if (storeys.Length == 0) { storeys = levels ?? Array.Empty<LevelInfo>(); }
            return new GridLocator(grids, use, storeys, origin);
        }

        /// <summary>
        /// The location of a point in Revit internal metres (clash points), or false when there are no intersections.
        /// </summary>
        public bool Locate(double x, double y, double z, out GridLocation location)
        {
            location = default;
            if (_nodes.Length == 0) { return false; }
            var p = new Vector2((float)(x - _origin.X), (float)(y - _origin.Y));
            float local = (float)(z - _origin.Z);

            int level = -1;
            for (int i = 0; i < _levels.Length; i++)
            {
                if (_levels[i].Elevation <= local + 0.01f) { level = i; }
            }
            if (level < 0 && _levels.Length > 0) { level = 0; } // below the lowest: the lowest
            float elevation = level >= 0 ? _levels[level].Elevation : local;

            // The nearest intersection whose grids reach the level (any, when none does)
            int best = Nearest(p, elevation, true);
            if (best < 0) { best = Nearest(p, elevation, false); }
            GridNode node = _nodes[best];
            location = new GridLocation(node.Name, level >= 0 ? _levels[level].Name : null, Vector2.Distance(p, node.Point), node.Point);
            return true;
        }

        private int Nearest(Vector2 p, float elevation, bool respectExtents)
        {
            int best = -1;
            float bestDistance = float.MaxValue;
            for (int i = 0; i < _nodes.Length; i++)
            {
                if (respectExtents && !GridNodes.ShowsAt(_nodes[i], _grids, elevation, true)) { continue; }
                float d = Vector2.DistanceSquared(p, _nodes[i].Point);
                if (d < bestDistance)
                {
                    bestDistance = d;
                    best = i;
                }
            }
            return best;
        }

        /// <summary>"C-4 : Level 2" for a point (internal metres), or null without intersections.</summary>
        public string Text(double x, double y, double z) => Locate(x, y, z, out GridLocation location) ? location.Text : null;
    }
}
