using System.Numerics;
using System.Runtime.InteropServices;

// The class belongs to the Scene namespace
namespace RvtGo.Scene
{
    /// <summary>
    /// One vertex of the static scene: position and normal in metres (Z up), RGBA8 colour.
    /// The layout matches the GL vertex attributes (28 bytes).
    /// </summary>
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    internal struct SceneVertex
    {
        /// <summary>Size in bytes.</summary>
        public const int SIZE = 28;

        /// <summary>Position (metres, scene-local).</summary>
        public Vector3 Position;

        /// <summary>Outward normal.</summary>
        public Vector3 Normal;

        /// <summary>Colour packed as R | G &lt;&lt; 8 | B &lt;&lt; 16 | A &lt;&lt; 24.</summary>
        public uint Colour;

        /// <summary>
        /// Creates a vertex.
        /// </summary>
        public SceneVertex(Vector3 position, Vector3 normal, uint colour)
        {
            Position = position;
            Normal = normal;
            Colour = colour;
        }
    }

    /// <summary>
    /// An axis-aligned bounding box.
    /// </summary>
    internal struct Aabb
    {
        /// <summary>Minimum corner.</summary>
        public Vector3 Min;

        /// <summary>Maximum corner.</summary>
        public Vector3 Max;

        /// <summary>An inverted (empty) box, ready to be grown.</summary>
        public static Aabb Empty => new(new Vector3(float.MaxValue), new Vector3(float.MinValue));

        /// <summary>
        /// Creates a box.
        /// </summary>
        public Aabb(Vector3 min, Vector3 max)
        {
            Min = min;
            Max = max;
        }

        /// <summary>True if the box has been grown at least once.</summary>
        public readonly bool IsValid => Min.X <= Max.X;

        /// <summary>The centre point.</summary>
        public readonly Vector3 Center => (Min + Max) * 0.5f;

        /// <summary>The extents.</summary>
        public readonly Vector3 Size => Max - Min;

        /// <summary>Grows the box to include a point.</summary>
        public void Include(Vector3 p)
        {
            Min = Vector3.Min(Min, p);
            Max = Vector3.Max(Max, p);
        }

        /// <summary>Grows the box to include another box.</summary>
        public void Include(in Aabb other)
        {
            Min = Vector3.Min(Min, other.Min);
            Max = Vector3.Max(Max, other.Max);
        }

        /// <summary>True if two boxes overlap.</summary>
        public readonly bool Overlaps(in Aabb other)
        {
            return Min.X <= other.Max.X && Max.X >= other.Min.X
                && Min.Y <= other.Max.Y && Max.Y >= other.Min.Y
                && Min.Z <= other.Max.Z && Max.Z >= other.Min.Z;
        }
    }

    /// <summary>
    /// Metadata and index ranges for one extracted Revit element.
    /// </summary>
    internal sealed class ElementRecord
    {
        /// <summary>The Revit ElementId value.</summary>
        public long ElementId { get; init; }

        /// <summary>The element name.</summary>
        public string Name { get; init; }

        /// <summary>The Revit category name.</summary>
        public string CategoryName { get; init; }

        /// <summary>"Family: Type" (or the type name for system families).</summary>
        public string FamilyType { get; init; }

        /// <summary>The associated level name, or an em dash.</summary>
        public string LevelName { get; init; }

        /// <summary>Index into <see cref="CategoryCatalog.All"/>.</summary>
        public int CategoryIndex { get; init; }

        /// <summary>First index (into <see cref="SceneData.Indices"/>) of the opaque triangles.</summary>
        public int OpaqueStart { get; set; }

        /// <summary>Number of opaque indices.</summary>
        public int OpaqueCount { get; set; }

        /// <summary>First index of the transparent triangles.</summary>
        public int TransparentStart { get; set; }

        /// <summary>Number of transparent indices.</summary>
        public int TransparentCount { get; set; }

        /// <summary>The element's bounds (scene-local metres).</summary>
        public Aabb Bounds { get; set; }

        /// <summary>True if the element was replaced by a bounding-box proxy.</summary>
        public bool IsProxy { get; init; }

    }

    /// <summary>
    /// A Revit level.
    /// </summary>
    /// <param name="Name">The level name.</param>
    /// <param name="Elevation">The elevation in metres (scene Z).</param>
    internal readonly record struct LevelInfo(string Name, float Elevation);

    /// <summary>
    /// Where the player starts.
    /// </summary>
    internal sealed class SpawnInfo
    {
        /// <summary>Eye position (scene-local metres).</summary>
        public Vector3 Eye { get; init; }

        /// <summary>Yaw (radians, 0 = +X, CCW).</summary>
        public float Yaw { get; init; }

        /// <summary>Pitch (radians).</summary>
        public float Pitch { get; init; }

        /// <summary>A short description for the HUD/log.</summary>
        public string Source { get; init; }
    }

    /// <summary>
    /// The immutable snapshot handed from the Revit thread to the game thread.
    /// After construction nothing in here is modified; the game thread builds its own derived structures.
    /// </summary>
    internal sealed class SceneData
    {
        /// <summary>All static vertices.</summary>
        public SceneVertex[] Vertices { get; init; }

        /// <summary>All static triangle indices (per element: opaque range then transparent range).</summary>
        public uint[] Indices { get; init; }

        /// <summary>All extracted elements.</summary>
        public ElementRecord[] Elements { get; init; }

        /// <summary>Levels sorted by elevation.</summary>
        public LevelInfo[] Levels { get; init; }

        /// <summary>Spawn from the active 3D view, or null to pick a random valid point.</summary>
        public SpawnInfo Spawn { get; init; }

        /// <summary>Bounds of all geometry.</summary>
        public Aabb Bounds { get; init; }

        /// <summary>Scene-local origin in Revit internal coordinates (metres). World = local + origin.</summary>
        public Vector3 OriginOffset { get; init; }

        /// <summary>The model title.</summary>
        public string ModelTitle { get; init; }

        /// <summary>Where comments are saved.</summary>
        public string CommentsPath { get; init; }

        /// <summary>Per category definition: was it loaded at launch.</summary>
        public bool[] CategoryLoaded { get; init; }

        /// <summary>Per category definition: number of extracted elements.</summary>
        public int[] CategoryElementCounts { get; init; }

        /// <summary>The launch settings.</summary>
        public LaunchSettings Settings { get; init; }

        /// <summary>Number of elements replaced by proxies.</summary>
        public int ProxyCount { get; init; }

        /// <summary>Number of elements skipped for being over the limit.</summary>
        public int SkippedCount { get; init; }

        /// <summary>Extraction duration.</summary>
        public TimeSpan ExtractionTime { get; init; }

        /// <summary>Total triangles.</summary>
        public int TriangleCount => Indices.Length / 3;
    }
}
