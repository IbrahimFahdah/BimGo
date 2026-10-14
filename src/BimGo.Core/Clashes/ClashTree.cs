using System.Numerics;
using BimGo.Scene;

// The class belongs to the Clashes namespace
namespace BimGo.Clashes
{
    /// <summary>
    /// A small bounding-volume tree over one large element's triangles (as walked), built once per clash run so the
    /// many pairs touching that element (a slab under a hundred pipes) don't each scan all its triangles. Median split
    /// on the longest axis, up to <see cref="LEAF_SIZE"/> triangles per leaf. Read-only after <see cref="Build"/>, so
    /// worker threads share it.
    /// </summary>
    internal sealed class TriangleTree
    {
        private const int LEAF_SIZE = 8;

        private ClashTriangle[] _triangles;   // scene-local, in leaf order
        private Vector3[] _min, _max;          // per node
        private int[] _first, _count, _right;  // leaf: first triangle and count; inner: _first = left child, _right = right child, _count = 0
        private int _nodes;

        /// <summary>
        /// Builds the tree for an item's triangles (opaque and transparent), transformed to where the item is now.
        /// </summary>
        public static TriangleTree Build(SceneData scene, ClashItem item)
        {
            ElementRecord e = scene.Elements[item.Element];
            var list = new List<ClashTriangle>((e.OpaqueCount + e.TransparentCount) / 3);
            AddRange(scene, item, e.OpaqueStart, e.OpaqueCount, list);
            AddRange(scene, item, e.TransparentStart, e.TransparentCount, list);

            var tree = new TriangleTree { _triangles = list.ToArray() };
            int capacity = Math.Max(1, 2 * (tree._triangles.Length / LEAF_SIZE + 1));
            tree._min = new Vector3[capacity];
            tree._max = new Vector3[capacity];
            tree._first = new int[capacity];
            tree._count = new int[capacity];
            tree._right = new int[capacity];
            if (tree._triangles.Length > 0) { tree.BuildNode(0, tree._triangles.Length); }
            return tree;
        }

        private static void AddRange(SceneData scene, in ClashItem item, int start, int count, List<ClashTriangle> list)
        {
            uint[] indices = scene.Indices;
            SceneVertex[] vertices = scene.Vertices;
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
                list.Add(ClashTriangle.Make(p0, p1, p2));
            }
        }

        /// <summary>
        /// Builds a node over triangles [start, start + count) and returns its index (children recursively).
        /// </summary>
        private int BuildNode(int start, int count)
        {
            int node = _nodes++;
            Grow(node);
            Vector3 min = new(float.MaxValue), max = new(float.MinValue);
            Vector3 cmin = new(float.MaxValue), cmax = new(float.MinValue);
            for (int i = start; i < start + count; i++)
            {
                min = Vector3.Min(min, _triangles[i].Min);
                max = Vector3.Max(max, _triangles[i].Max);
                Vector3 c = (_triangles[i].Min + _triangles[i].Max) * 0.5f;
                cmin = Vector3.Min(cmin, c);
                cmax = Vector3.Max(cmax, c);
            }
            _min[node] = min;
            _max[node] = max;

            Vector3 spread = cmax - cmin;
            if (count <= LEAF_SIZE || spread.LengthSquared() < 1e-12f)
            {
                _first[node] = start;
                _count[node] = count;
                return node;
            }

            // Median split along the centres' longest axis
            int axis = spread.X >= spread.Y && spread.X >= spread.Z ? 0 : spread.Y >= spread.Z ? 1 : 2;
            Array.Sort(_triangles, start, count, Comparer<ClashTriangle>.Create((a, b) => Centre(a, axis).CompareTo(Centre(b, axis))));
            int half = count / 2;
            _count[node] = 0;
            int left = BuildNode(start, half);
            int right = BuildNode(start + half, count - half);
            _first[node] = left;
            _right[node] = right;
            return node;
        }

        private static float Centre(in ClashTriangle t, int axis) => axis == 0 ? t.Min.X + t.Max.X : axis == 1 ? t.Min.Y + t.Max.Y : t.Min.Z + t.Max.Z;

        private void Grow(int node)
        {
            if (node < _min.Length) { return; }
            int size = _min.Length * 2;
            Array.Resize(ref _min, size);
            Array.Resize(ref _max, size);
            Array.Resize(ref _first, size);
            Array.Resize(ref _count, size);
            Array.Resize(ref _right, size);
        }

        /// <summary>
        /// Adds the triangles whose boxes meet <paramref name="query"/> (scene-local) to <paramref name="output"/>,
        /// relative to <paramref name="centre"/>.
        /// </summary>
        public void Query(in Aabb query, Vector3 centre, ClashEngine.TriangleList output)
        {
            if (_nodes == 0) { return; }
            Span<int> stack = stackalloc int[64];
            int top = 0;
            stack[top++] = 0;
            while (top > 0)
            {
                int node = stack[--top];
                if (_min[node].X > query.Max.X || _max[node].X < query.Min.X || _min[node].Y > query.Max.Y || _max[node].Y < query.Min.Y
                    || _min[node].Z > query.Max.Z || _max[node].Z < query.Min.Z) { continue; }
                if (_count[node] > 0)
                {
                    for (int i = _first[node]; i < _first[node] + _count[node]; i++)
                    {
                        ref ClashTriangle t = ref _triangles[i];
                        if (t.Min.X > query.Max.X || t.Max.X < query.Min.X || t.Min.Y > query.Max.Y || t.Max.Y < query.Min.Y
                            || t.Min.Z > query.Max.Z || t.Max.Z < query.Min.Z) { continue; }
                        output.Add(ClashTriangle.Make(t.A - centre, t.B - centre, t.C - centre));
                    }
                    continue;
                }
                if (top + 2 > stack.Length) { continue; } // can't happen with median splits (depth ≈ log2 n)
                stack[top++] = _first[node];
                stack[top++] = _right[node];
            }
        }

        /// <summary>
        /// True when a scene-local point is inside the element's solid (even–odd rule along the same three skewed rays
        /// as <see cref="ClashGeometry.Inside"/>, two of three agreeing).
        /// </summary>
        public bool Inside(Vector3 point, Stack<int> scratch)
        {
            int votes = 0;
            if ((Crossings(point, ClashGeometry.InsideRay(0), scratch) & 1) == 1) { votes++; }
            if ((Crossings(point, ClashGeometry.InsideRay(1), scratch) & 1) == 1) { votes++; }
            if (votes == 1 && (Crossings(point, ClashGeometry.InsideRay(2), scratch) & 1) == 1) { votes++; }
            return votes >= 2;
        }

        private int Crossings(Vector3 origin, Vector3 direction, Stack<int> stack)
        {
            if (_nodes == 0) { return 0; }
            int count = 0;
            Vector3 inverse = new(1f / direction.X, 1f / direction.Y, 1f / direction.Z);
            stack.Clear();
            stack.Push(0);
            while (stack.Count > 0)
            {
                int node = stack.Pop();
                if (!RayMeetsBox(origin, inverse, _min[node], _max[node])) { continue; }
                if (_count[node] > 0)
                {
                    for (int i = _first[node]; i < _first[node] + _count[node]; i++)
                    {
                        if (ClashGeometry.RayHits(origin, direction, _triangles[i])) { count++; }
                    }
                    continue;
                }
                stack.Push(_first[node]);
                stack.Push(_right[node]);
            }
            return count;
        }

        /// <summary>Slab test for a ray (from the origin forwards) against a box.</summary>
        private static bool RayMeetsBox(Vector3 origin, Vector3 inverse, Vector3 min, Vector3 max)
        {
            Vector3 t1 = (min - origin) * inverse, t2 = (max - origin) * inverse;
            Vector3 lo = Vector3.Min(t1, t2), hi = Vector3.Max(t1, t2);
            float enter = MathF.Max(MathF.Max(lo.X, lo.Y), lo.Z), leave = MathF.Min(MathF.Min(hi.X, hi.Y), hi.Z);
            return leave >= MathF.Max(enter, 0f);
        }
    }
}
