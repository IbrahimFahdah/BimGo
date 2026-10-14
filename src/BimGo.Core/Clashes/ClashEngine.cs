using System.Collections.Concurrent;
using System.Diagnostics;
using System.Numerics;
using BimGo.Scene;
using BimGo.Utilities;

// The class belongs to the Clashes namespace
namespace BimGo.Clashes
{
    /// <summary>
    /// One thing to test: an element's triangles, where they are now. A static element uses the snapshot's
    /// coordinates; a moved original, clone or placement carries its rigid transform (the walkthrough "as walked").
    /// </summary>
    public struct ClashItem
    {
        /// <summary>Index into <see cref="SceneData.Elements"/> (the source of the triangles).</summary>
        public int Element;

        /// <summary>The walkthrough clone key of a clone / placement, else 0 (a model element, moved or not).</summary>
        public int CloneKey;

        /// <summary>True when <see cref="Transform"/> applies.</summary>
        public bool HasTransform;

        /// <summary>Snapshot → current position (row-vector convention, as <c>Vector3.Transform</c>).</summary>
        public Matrix4x4 Transform;

        /// <summary>The current bounds (scene-local metres).</summary>
        public Aabb Bounds;

        /// <summary>An element where the snapshot has it.</summary>
        public static ClashItem Static(SceneData scene, int element) => new()
        {
            Element = element,
            Transform = Matrix4x4.Identity,
            Bounds = scene.Elements[element].Bounds
        };

        /// <summary>A moved element, clone or placement: the source element's triangles under a transform.</summary>
        public static ClashItem Moved(int element, Matrix4x4 transform, Aabb bounds, int cloneKey) => new()
        {
            Element = element,
            CloneKey = cloneKey,
            HasTransform = true,
            Transform = transform,
            Bounds = bounds
        };
    }

    /// <summary>
    /// What one run tests.
    /// </summary>
    public sealed class ClashJob
    {
        /// <summary>The snapshot (triangles, element data).</summary>
        public SceneData Scene { get; init; }

        /// <summary>Everything that can take part (one entry per element as walked; demolished / deleted left out).</summary>
        public ClashItem[] Items { get; init; }

        /// <summary>Set A: indices into <see cref="Items"/>.</summary>
        public int[] SetA { get; init; }

        /// <summary>Set B: indices into <see cref="Items"/>, or null to test set A against itself.</summary>
        public int[] SetB { get; init; }

        /// <summary>The kind (<see cref="ClashKind"/>).</summary>
        public string Kind { get; init; } = ClashKind.HARD;

        /// <summary>Metres (hard: depth ignored; clearance: the distance).</summary>
        public float Tolerance { get; init; } = (float)ClashDefaults.HARD_TOLERANCE;

        /// <summary>The run stops after this many clashes.</summary>
        public int MaxClashes { get; init; } = ClashDefaults.MAX_CLASHES_PER_TEST;

        /// <summary>Worker threads (0 = the machine's processors, less one for the window).</summary>
        public int Threads { get; init; }
    }

    /// <summary>
    /// One clash found: the two items (set A's first), the point (scene-local), and the depth or gap.
    /// </summary>
    public readonly record struct ClashHit(int ItemA, int ItemB, Vector3 Point, float Distance, bool Crossing, bool Approximate);

    /// <summary>
    /// What a run returns.
    /// </summary>
    public sealed class ClashRunResult
    {
        /// <summary>The clashes, ordered by set A item then set B item.</summary>
        public List<ClashHit> Hits { get; init; } = new();

        /// <summary>True when the run stopped at the clash limit.</summary>
        public bool Truncated { get; init; }

        /// <summary>True when it was cancelled (nothing should be merged).</summary>
        public bool Cancelled { get; init; }

        /// <summary>Element pairs whose boxes met (narrow-phase work).</summary>
        public long Candidates { get; init; }

        /// <summary>Elements in set A and in set B.</summary>
        public int CountA { get; init; }

        /// <inheritdoc cref="CountA"/>
        public int CountB { get; init; }

        /// <summary>Seconds taken.</summary>
        public double Seconds { get; init; }
    }

    /// <summary>
    /// Clash detection (Round C). Built to stay cheap at scale and to cost nothing until asked:
    /// <list type="number">
    /// <item><b>Broad phase:</b> sweep and prune over the items' boxes along the axis the model spreads most
    /// (clearance tests grow each box by half the distance), keeping only pairs that can belong to the test.</item>
    /// <item><b>Pairs skipped:</b> an element with itself, a host with its hosted inserts (<see cref="ElementRecord.HostId"/>,
    /// same model).</item>
    /// <item><b>Narrow phase</b> (in parallel): each element's triangles inside the pair's overlap box (large elements
    /// keep a small triangle tree for the run), then a second sweep over those triangles' boxes and exact triangle
    /// tests (<see cref="ClashGeometry"/>).</item>
    /// <item><b>Hard depth</b> is an estimate: the narrowest width of the crossing outline over the axes and the
    /// crossing faces' normals; when that is within the tolerance, corners of one element lying inside the other
    /// deeper than the tolerance still make it a clash (a pipe sunk into a slab). Touching faces never clash.</item>
    /// <item><b>Clearance</b> reports crossings (tagged) and gaps under the distance, with the closest points.</item>
    /// </list>
    /// The caches live only for one run.
    /// </summary>
    public static class ClashEngine
    {
        /// <summary>Elements with at least this many triangles get a triangle tree for the run.</summary>
        private const int TREE_MIN_TRIANGLES = 384;

        /// <summary>The trees of one run stop growing past this many triangles in total (memory guard).</summary>
        private const long TREE_TRIANGLE_BUDGET = 3_000_000;

        /// <summary>Corners per element tried by the inside test of a shallow crossing.</summary>
        private const int MAX_INSIDE_CORNERS = 512;

        /// <summary>Crossing points kept per pair for the width estimate.</summary>
        private const int MAX_CROSSING_POINTS = 4096;

        #region Run

        /// <summary>
        /// Runs a test. Reports to <paramref name="progress"/> (stages: nearby elements, then pairs) and stops early on
        /// cancel (the result says so) or at the clash limit (truncated). Never throws for geometry problems.
        /// </summary>
        public static ClashRunResult Run(ClashJob job, OperationProgress progress = null)
        {
            var clock = Stopwatch.StartNew();
            SceneData scene = job.Scene;
            ClashItem[] items = job.Items ?? Array.Empty<ClashItem>();
            bool self = job.SetB == null;
            bool clearance = ClashKind.Normalise(job.Kind) == ClashKind.CLEARANCE;
            float tolerance = MathF.Max(0f, job.Tolerance);

            // Membership: 1 = set A, 2 = set B (a self test puts set A in both)
            byte[] member = new byte[items.Length];
            int countA = 0, countB = 0;
            foreach (int i in job.SetA ?? Array.Empty<int>())
            {
                if (i < 0 || i >= items.Length || (member[i] & 1) != 0) { continue; }
                member[i] |= (byte)(self ? 3 : 1);
                countA++;
            }
            if (self) { countB = countA; }
            else
            {
                foreach (int i in job.SetB)
                {
                    if (i < 0 || i >= items.Length || (member[i] & 2) != 0) { continue; }
                    member[i] |= 2;
                    countB++;
                }
            }

            progress?.Begin("Finding elements near each other", 0.0, 0.1);
            List<(int A, int B)> pairs = FindPairs(scene, items, member, self, clearance ? tolerance * 0.5f : 1e-4f, progress);
            if (progress?.CancelRequested == true)
            {
                return new ClashRunResult { Cancelled = true, CountA = countA, CountB = countB, Seconds = clock.Elapsed.TotalSeconds };
            }

            // Narrow phase, in parallel
            progress?.Begin("Testing triangles", 0.1, 1.0);
            progress?.Detail($"{pairs.Count:N0} element pairs to test");
            var context = new RunContext(scene, items);
            var found = new ConcurrentBag<ClashHit>();
            int hitCount = 0, done = 0;
            bool truncated = false;
            int threads = job.Threads > 0 ? job.Threads : Math.Max(1, Environment.ProcessorCount - 1);

            Parallel.For(0, pairs.Count, new ParallelOptions { MaxDegreeOfParallelism = threads },
                () => new PairScratch(),
                (index, state, scratch) =>
                {
                    if (progress?.CancelRequested == true || Volatile.Read(ref hitCount) >= job.MaxClashes)
                    {
                        state.Stop();
                        return scratch;
                    }

                    (int a, int b) = pairs[index];
                    try
                    {
                        if (TestPair(context, scratch, a, b, clearance, tolerance, out ClashHit hit))
                        {
                            found.Add(hit);
                            if (Interlocked.Increment(ref hitCount) >= job.MaxClashes) { truncated = true; }
                        }
                    }
                    catch (Exception ex)
                    {
                        // A broken element must not stop the run: log once per pair and carry on
                        Log_Utils.Write($"Clash test skipped a pair ({items[a].Element} × {items[b].Element}): {ex.Message}");
                    }

                    int finished = Interlocked.Increment(ref done);
                    if ((finished & 255) == 0 && progress != null)
                    {
                        progress.Step(finished, pairs.Count);
                        progress.Detail($"{finished:N0} of {pairs.Count:N0} pairs · {Volatile.Read(ref hitCount):N0} clashes");
                    }
                    return scratch;
                },
                _ => { });

            bool cancelled = progress?.CancelRequested == true;
            List<ClashHit> hits = found.ToList();
            hits.Sort((x, y) => x.ItemA != y.ItemA ? x.ItemA.CompareTo(y.ItemA) : x.ItemB.CompareTo(y.ItemB));
            if (hits.Count > job.MaxClashes)
            {
                hits.RemoveRange(job.MaxClashes, hits.Count - job.MaxClashes);
                truncated = true;
            }
            Log_Utils.Write($"Clash run ({(clearance ? "clearance" : "hard")} {tolerance * 1000f:0.#} mm): {countA:N0} × {(self ? "itself" : countB.ToString("N0"))} elements, " +
                $"{pairs.Count:N0} pairs, {hits.Count:N0} clashes{(truncated ? " (limit reached)" : string.Empty)}{(cancelled ? " (cancelled)" : string.Empty)}, " +
                $"{context.TreeTriangles:N0} triangles in trees, {clock.Elapsed.TotalSeconds:0.0} s.");

            return new ClashRunResult
            {
                Hits = hits,
                Truncated = truncated,
                Cancelled = cancelled,
                Candidates = pairs.Count,
                CountA = countA,
                CountB = countB,
                Seconds = clock.Elapsed.TotalSeconds
            };
        }

        #endregion

        #region Broad phase

        /// <summary>
        /// Sweep and prune: every pair of items whose boxes (grown by <paramref name="grow"/>) meet and that the test
        /// asks for, set A's item first (self test: the lower index first).
        /// </summary>
        private static List<(int, int)> FindPairs(SceneData scene, ClashItem[] items, byte[] member, bool self, float grow, OperationProgress progress)
        {
            var pairs = new List<(int, int)>();
            var list = new List<int>();
            Vector3 lo = new(float.MaxValue), hi = new(float.MinValue);
            for (int i = 0; i < items.Length; i++)
            {
                if (member[i] == 0 || !items[i].Bounds.IsValid) { continue; }
                list.Add(i);
                Vector3 c = items[i].Bounds.Center;
                lo = Vector3.Min(lo, c);
                hi = Vector3.Max(hi, c);
            }
            if (list.Count < 2) { return pairs; }

            // Sweep along the axis the centres spread most
            Vector3 spread = hi - lo;
            int axis = spread.X >= spread.Y && spread.X >= spread.Z ? 0 : spread.Y >= spread.Z ? 1 : 2;
            int n = list.Count;
            int[] order = list.ToArray();
            float[] keys = new float[n];
            for (int k = 0; k < n; k++) { keys[k] = Component(items[order[k]].Bounds.Min, axis) - grow; }
            Array.Sort(keys, order);

            var active = new List<int>();
            for (int k = 0; k < n; k++)
            {
                if ((k & 1023) == 0)
                {
                    progress?.Step(k, n);
                    if (progress?.CancelRequested == true) { return pairs; }
                }

                int p = order[k];
                Aabb pb = items[p].Bounds;
                float start = Component(pb.Min, axis) - grow;
                for (int j = active.Count - 1; j >= 0; j--)
                {
                    if (Component(items[active[j]].Bounds.Max, axis) + grow < start)
                    {
                        active[j] = active[^1];
                        active.RemoveAt(active.Count - 1);
                    }
                }

                foreach (int q in active)
                {
                    Aabb qb = items[q].Bounds;
                    if (!Overlap(pb, qb, grow * 2f)) { continue; }
                    if (!Wanted(member, self, p, q, out int a, out int b)) { continue; }
                    if (Skipped(scene, items[a], items[b])) { continue; }
                    pairs.Add((a, b));
                }
                active.Add(p);
            }

            // A stable order makes runs repeatable (and the progress bar honest)
            pairs.Sort((x, y) => x.Item1 != y.Item1 ? x.Item1.CompareTo(y.Item1) : x.Item2.CompareTo(y.Item2));
            return pairs;
        }

        /// <summary>
        /// True when a pair belongs to the test; puts set A's item first.
        /// </summary>
        private static bool Wanted(byte[] member, bool self, int p, int q, out int a, out int b)
        {
            a = Math.Min(p, q);
            b = Math.Max(p, q);
            if (self) { return true; }
            bool pA = (member[p] & 1) != 0, pB = (member[p] & 2) != 0, qA = (member[q] & 1) != 0, qB = (member[q] & 2) != 0;
            if (pA && qB && qA && pB) { return true; } // both in both sets: once, lower index first
            if (pA && qB) { a = p; b = q; return true; }
            if (qA && pB) { a = q; b = p; return true; }
            return false;
        }

        /// <summary>
        /// Pairs never tested: an element with itself, a host with its own inserts (same model).
        /// </summary>
        private static bool Skipped(SceneData scene, in ClashItem a, in ClashItem b)
        {
            ElementRecord ea = scene.Elements[a.Element], eb = scene.Elements[b.Element];
            if (a.CloneKey != 0 || b.CloneKey != 0) { return a.CloneKey == b.CloneKey && a.Element == b.Element; }
            if (a.Element == b.Element) { return true; }
            if (ea.Link != eb.Link) { return false; }
            return (ea.HostId != 0 && ea.HostId == eb.ElementId) || (eb.HostId != 0 && eb.HostId == ea.ElementId);
        }

        private static bool Overlap(in Aabb a, in Aabb b, float grow) =>
            a.Min.X <= b.Max.X + grow && a.Max.X + grow >= b.Min.X
            && a.Min.Y <= b.Max.Y + grow && a.Max.Y + grow >= b.Min.Y
            && a.Min.Z <= b.Max.Z + grow && a.Max.Z + grow >= b.Min.Z;

        private static float Component(Vector3 v, int axis) => axis == 0 ? v.X : axis == 1 ? v.Y : v.Z;

        #endregion

        #region Narrow phase

        /// <summary>
        /// Tests one pair. Hard: crossings, depth over the tolerance. Clearance: crossings or gaps under the distance.
        /// </summary>
        private static bool TestPair(RunContext context, PairScratch s, int a, int b, bool clearance, float tolerance, out ClashHit hit)
        {
            hit = default;
            ClashItem ia = context.Items[a], ib = context.Items[b];
            ElementRecord ea = context.Scene.Elements[ia.Element], eb = context.Scene.Elements[ib.Element];

            // Where the two can meet (clearance: each box grown by the distance towards the other)
            float reach = clearance ? tolerance : 0f;
            Aabb overlapA = Intersect(ia.Bounds, Grow(ib.Bounds, reach + 1e-4f));
            Aabb overlapB = Intersect(ib.Bounds, Grow(ia.Bounds, reach + 1e-4f));
            if (!overlapA.IsValid || !overlapB.IsValid) { return false; }
            Vector3 centre = (overlapA.Center + overlapB.Center) * 0.5f;

            // Hard tests also take faces within the tolerance around the overlap (the inside test needs the nearest surface)
            context.Gather(a, clearance ? overlapA : Grow(overlapA, tolerance), centre, s.TrianglesA);
            if (s.TrianglesA.Count == 0) { return false; }
            context.Gather(b, clearance ? overlapB : Grow(overlapB, tolerance), centre, s.TrianglesB);
            if (s.TrianglesB.Count == 0) { return false; }

            bool approximate = ea.IsProxy || eb.IsProxy;
            return clearance
                ? TestClearance(s, a, b, tolerance, centre, approximate, out hit)
                : TestHard(context, s, a, b, tolerance, centre, approximate, out hit);
        }

        private static bool TestHard(RunContext context, PairScratch s, int a, int b, float tolerance, Vector3 centre, bool approximate, out ClashHit hit)
        {
            hit = default;
            s.Points.Clear();
            s.Directions.Clear();
            s.Directions.Add(Vector3.UnitX);
            s.Directions.Add(Vector3.UnitY);
            s.Directions.Add(Vector3.UnitZ);

            ClashTriangle[] ta = s.TrianglesA.Items, tb = s.TrianglesB.Items;
            SweepTriangles(s, 0f, (i, j) =>
            {
                if (!ClashGeometry.Crosses(ta[i], tb[j], out Vector3 p, out Vector3 q)) { return true; }
                if (s.Points.Count < MAX_CROSSING_POINTS - 1)
                {
                    s.Points.Add(p);
                    s.Points.Add(q);
                }
                AddDirection(s.Directions, ta[i].Normal);
                AddDirection(s.Directions, tb[j].Normal);
                return true;
            });
            if (s.Points.Count == 0) { return false; }

            // Depth: the narrowest width of the crossing outline
            float depth = float.MaxValue;
            foreach (Vector3 d in s.Directions)
            {
                float min = float.MaxValue, max = float.MinValue;
                foreach (Vector3 p in s.Points)
                {
                    float t = Vector3.Dot(p, d);
                    if (t < min) { min = t; }
                    if (t > max) { max = t; }
                }
                depth = MathF.Min(depth, max - min);
            }

            // Shallow outline: corners buried deeper than the tolerance still count (a pipe lying sunk in a slab)
            if (depth <= tolerance)
            {
                float buried = MathF.Max(
                    BuriedDepth(context, s, s.TrianglesA, b, s.TrianglesB, tolerance, centre),
                    BuriedDepth(context, s, s.TrianglesB, a, s.TrianglesA, tolerance, centre));
                depth = MathF.Max(depth, buried);
            }
            if (depth <= tolerance) { return false; }

            Vector3 sum = Vector3.Zero;
            foreach (Vector3 p in s.Points) { sum += p; }
            hit = new ClashHit(a, b, sum / s.Points.Count + centre, depth, true, approximate);
            return true;
        }

        private static bool TestClearance(PairScratch s, int a, int b, float distance, Vector3 centre, bool approximate, out ClashHit hit)
        {
            hit = default;
            ClashTriangle[] ta = s.TrianglesA.Items, tb = s.TrianglesB.Items;
            float best = float.MaxValue;
            bool crossing = false;
            Vector3 bestA = Vector3.Zero, bestB = Vector3.Zero;

            SweepTriangles(s, distance, (i, j) =>
            {
                if (ClashGeometry.Crosses(ta[i], tb[j], out Vector3 p, out Vector3 q, out bool proper))
                {
                    best = 0f;
                    bestA = bestB = (p + q) * 0.5f;
                    if (!proper) { return true; } // touching: distance 0, keep looking for a real crossing
                    crossing = true;
                    return false; // a crossing settles it
                }
                float d = ClashGeometry.Distance(ta[i], tb[j], out Vector3 onA, out Vector3 onB);
                if (d < best)
                {
                    best = d;
                    bestA = onA;
                    bestB = onB;
                }
                return true;
            });

            if (!crossing && best >= distance) { return false; }
            hit = new ClashHit(a, b, (bestA + bestB) * 0.5f + centre, best, crossing, approximate);
            return true;
        }

        /// <summary>
        /// Sweep and prune over the two triangle lists' boxes (grown by <paramref name="grow"/>), calling
        /// <paramref name="test"/> for each pair that meets until it returns false.
        /// </summary>
        private static void SweepTriangles(PairScratch s, float grow, Func<int, int, bool> test)
        {
            int na = s.TrianglesA.Count, nb = s.TrianglesB.Count;
            ClashTriangle[] ta = s.TrianglesA.Items, tb = s.TrianglesB.Items;
            int[] oa = s.OrderA(na), ob = s.OrderB(nb);
            float[] ka = s.KeysA(na), kb = s.KeysB(nb);
            for (int i = 0; i < na; i++) { oa[i] = i; ka[i] = ta[i].Min.X; }
            for (int j = 0; j < nb; j++) { ob[j] = j; kb[j] = tb[j].Min.X - grow; }
            Array.Sort(ka, oa, 0, na);
            Array.Sort(kb, ob, 0, nb);

            // For each A triangle (by min x), walk B triangles from the first that could still reach it
            int startB = 0;
            for (int ii = 0; ii < na; ii++)
            {
                ref ClashTriangle t = ref ta[oa[ii]];
                while (startB < nb && tb[ob[startB]].Max.X + grow < t.Min.X) { startB++; } // dead for every later A triangle too
                for (int jj = startB; jj < nb; jj++)
                {
                    if (kb[jj] > t.Max.X) { break; }
                    ref ClashTriangle u = ref tb[ob[jj]];
                    if (u.Max.X + grow < t.Min.X) { continue; }
                    if (t.Min.Y > u.Max.Y + grow || t.Max.Y + grow < u.Min.Y || t.Min.Z > u.Max.Z + grow || t.Max.Z + grow < u.Min.Z) { continue; }
                    if (!test(oa[ii], ob[jj])) { return; }
                }
            }
        }

        /// <summary>
        /// How deep the corners of <paramref name="corners"/> sit inside element item <paramref name="other"/>: the
        /// largest distance to the other's surface among corners inside it and further than the tolerance from every
        /// face near them (0 when none).
        /// </summary>
        private static float BuriedDepth(RunContext context, PairScratch s, TriangleList corners, int other, TriangleList otherNear, float tolerance, Vector3 centre)
        {
            float deepest = 0f;
            int tried = 0;
            ClashTriangle[] near = otherNear.Items;
            for (int i = 0; i < corners.Count && tried < MAX_INSIDE_CORNERS; i++)
            {
                ref ClashTriangle t = ref corners.Items[i];
                for (int k = 0; k < 3 && tried < MAX_INSIDE_CORNERS; k++)
                {
                    Vector3 p = k == 0 ? t.A : k == 1 ? t.B : t.C;
                    tried++;

                    // Nearest face of the other element (among those within reach of this pair)
                    float nearest = float.MaxValue;
                    for (int j = 0; j < otherNear.Count; j++)
                    {
                        ref ClashTriangle u = ref near[j];
                        if (p.X < u.Min.X - nearest || p.X > u.Max.X + nearest || p.Y < u.Min.Y - nearest || p.Y > u.Max.Y + nearest
                            || p.Z < u.Min.Z - nearest || p.Z > u.Max.Z + nearest) { continue; }
                        float d = Vector3.Distance(p, ClashGeometry.ClosestOnTriangle(p, u));
                        if (d < nearest) { nearest = d; }
                        if (nearest <= tolerance) { break; }
                    }
                    if (nearest <= tolerance || nearest <= deepest) { continue; }
                    if (!context.Inside(other, p + centre, s)) { continue; }

                    // No face of the other element within reach: its box gives an upper bound for the depth
                    if (nearest == float.MaxValue) { nearest = DepthInBox(context.Items[other].Bounds, p + centre); }
                    deepest = MathF.Max(deepest, nearest);
                }
            }
            return deepest;
        }

        /// <summary>How far a point inside a box is from the box's nearest face.</summary>
        private static float DepthInBox(in Aabb box, Vector3 p)
        {
            Vector3 low = p - box.Min, high = box.Max - p;
            return MathF.Max(0f, MathF.Min(MathF.Min(MathF.Min(low.X, low.Y), low.Z), MathF.Min(MathF.Min(high.X, high.Y), high.Z)));
        }

        private static void AddDirection(List<Vector3> directions, Vector3 normal)
        {
            if (normal == Vector3.Zero || directions.Count >= 15) { return; }
            foreach (Vector3 d in directions)
            {
                if (MathF.Abs(Vector3.Dot(d, normal)) > 0.995f) { return; }
            }
            directions.Add(normal);
        }

        private static Aabb Grow(in Aabb box, float amount) => new(box.Min - new Vector3(amount), box.Max + new Vector3(amount));

        private static Aabb Intersect(in Aabb a, in Aabb b) => new(Vector3.Max(a.Min, b.Min), Vector3.Min(a.Max, b.Max));

        #endregion

        #region Per-run state

        /// <summary>
        /// A growable triangle list reused across pairs (one per worker thread).
        /// </summary>
        internal sealed class TriangleList
        {
            public ClashTriangle[] Items = new ClashTriangle[256];
            public int Count;

            public void Clear() => Count = 0;

            public void Add(in ClashTriangle t)
            {
                if (Count == Items.Length) { Array.Resize(ref Items, Items.Length * 2); }
                Items[Count++] = t;
            }
        }

        /// <summary>
        /// One worker thread's buffers (no allocation per pair once warmed up).
        /// </summary>
        internal sealed class PairScratch
        {
            public readonly TriangleList TrianglesA = new(), TrianglesB = new(), Whole = new();
            public readonly List<Vector3> Points = new(256);
            public readonly List<Vector3> Directions = new(16);
            public readonly Stack<int> Nodes = new(64);
            private int[] _orderA = new int[256], _orderB = new int[256];
            private float[] _keysA = new float[256], _keysB = new float[256];

            public int[] OrderA(int n) => Ensure(ref _orderA, n);
            public int[] OrderB(int n) => Ensure(ref _orderB, n);
            public float[] KeysA(int n) => Ensure(ref _keysA, n);
            public float[] KeysB(int n) => Ensure(ref _keysB, n);

            private static T[] Ensure<T>(ref T[] array, int n)
            {
                if (array.Length < n) { array = new T[Math.Max(n, array.Length * 2)]; }
                return array;
            }
        }

        /// <summary>
        /// The run's shared, read-mostly state: the scene, the items and the triangle trees of large elements
        /// (built on first use, dropped with the run).
        /// </summary>
        internal sealed class RunContext
        {
            public readonly SceneData Scene;
            public readonly ClashItem[] Items;
            private readonly ConcurrentDictionary<int, Lazy<TriangleTree>> _trees = new();
            private long _treeTriangles;

            public RunContext(SceneData scene, ClashItem[] items)
            {
                Scene = scene;
                Items = items;
            }

            /// <summary>Triangles held in trees so far (for the log).</summary>
            public long TreeTriangles => Interlocked.Read(ref _treeTriangles);

            /// <summary>
            /// An item's triangles whose boxes meet <paramref name="query"/>, relative to <paramref name="centre"/>.
            /// </summary>
            public void Gather(int itemIndex, in Aabb query, Vector3 centre, TriangleList output)
            {
                output.Clear();
                ClashItem item = Items[itemIndex];
                TriangleTree tree = TreeFor(itemIndex);
                if (tree != null)
                {
                    tree.Query(query, centre, output);
                    return;
                }

                ElementRecord e = Scene.Elements[item.Element];
                GatherRange(item, e.OpaqueStart, e.OpaqueCount, query, centre, output);
                GatherRange(item, e.TransparentStart, e.TransparentCount, query, centre, output);
            }

            /// <summary>
            /// True when a point (scene-local) is inside an item's solid (even–odd rule over all its triangles).
            /// </summary>
            public bool Inside(int itemIndex, Vector3 point, PairScratch scratch)
            {
                ClashItem item = Items[itemIndex];
                if (!Contains(item.Bounds, point)) { return false; }
                TriangleTree tree = TreeFor(itemIndex);
                if (tree != null) { return tree.Inside(point, scratch.Nodes); }

                ElementRecord e = Scene.Elements[item.Element];
                Aabb all = new(new Vector3(float.MinValue), new Vector3(float.MaxValue));
                scratch.Whole.Clear();
                GatherRange(item, e.OpaqueStart, e.OpaqueCount, all, point, scratch.Whole);
                GatherRange(item, e.TransparentStart, e.TransparentCount, all, point, scratch.Whole);
                return ClashGeometry.Inside(Vector3.Zero, scratch.Whole.Items.AsSpan(0, scratch.Whole.Count));
            }

            private static bool Contains(in Aabb box, Vector3 p) =>
                p.X >= box.Min.X && p.X <= box.Max.X && p.Y >= box.Min.Y && p.Y <= box.Max.Y && p.Z >= box.Min.Z && p.Z <= box.Max.Z;

            private void GatherRange(in ClashItem item, int start, int count, in Aabb query, Vector3 centre, TriangleList output)
            {
                uint[] indices = Scene.Indices;
                SceneVertex[] vertices = Scene.Vertices;
                int end = Math.Min(indices.Length, start + count);
                for (int k = Math.Max(0, start); k + 2 < end; k += 3)
                {
                    Vector3 p0 = vertices[indices[k]].Position, p1 = vertices[indices[k + 1]].Position, p2 = vertices[indices[k + 2]].Position;
                    if (item.HasTransform)
                    {
                        p0 = Vector3.Transform(p0, item.Transform);
                        p1 = Vector3.Transform(p1, item.Transform);
                        p2 = Vector3.Transform(p2, item.Transform);
                    }
                    Vector3 min = Vector3.Min(p0, Vector3.Min(p1, p2)), max = Vector3.Max(p0, Vector3.Max(p1, p2));
                    if (min.X > query.Max.X || max.X < query.Min.X || min.Y > query.Max.Y || max.Y < query.Min.Y || min.Z > query.Max.Z || max.Z < query.Min.Z) { continue; }
                    output.Add(ClashTriangle.Make(p0 - centre, p1 - centre, p2 - centre));
                }
            }

            private TriangleTree TreeFor(int itemIndex)
            {
                ClashItem item = Items[itemIndex];
                ElementRecord e = Scene.Elements[item.Element];
                int triangles = (e.OpaqueCount + e.TransparentCount) / 3;
                if (triangles < TREE_MIN_TRIANGLES) { return null; }

                // Keyed by item (a moved original and its clone sit in different places)
                if (_trees.TryGetValue(itemIndex, out Lazy<TriangleTree> existing)) { return existing.Value; }
                if (Interlocked.Read(ref _treeTriangles) + triangles > TREE_TRIANGLE_BUDGET) { return null; }

                ClashItem copy = item;
                Lazy<TriangleTree> lazy = _trees.GetOrAdd(itemIndex, _ => new Lazy<TriangleTree>(() =>
                {
                    Interlocked.Add(ref _treeTriangles, triangles);
                    return TriangleTree.Build(Scene, copy);
                }, LazyThreadSafetyMode.ExecutionAndPublication));
                return lazy.Value;
            }
        }

        #endregion
    }
}
