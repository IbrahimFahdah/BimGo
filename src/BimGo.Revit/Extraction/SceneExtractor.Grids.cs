using System.Numerics;
using BimGo.Scene;

// The class belongs to the Extraction namespace
namespace BimGo.Extraction
{
    /// <summary>
    /// Grids round A: the grids of the host and of each extracted link (through its transform), for the walkthrough's
    /// grid overlay. Each grid keeps its name, its plan line (lines as two points, arcs tessellated, multi-segment grids
    /// joined into one line) and its 3D vertical extent. Read-only; a grid that can't be read is skipped and logged.
    /// </summary>
    internal sealed partial class SceneExtractor
    {
        /// <summary>
        /// Collects the grids of every source model (host first).
        /// </summary>
        private GridLine[] CollectGrids(List<SourceModel> sources)
        {
            var grids = new List<GridLine>();
            foreach (SourceModel source in sources)
            {
                int before = grids.Count;
                try { CollectGrids(source, grids); }
                catch (Exception ex)
                {
                    Utilities.Log_Utils.Write($"{source.Describe()}: grids skipped: {ex.Message}");
                }
                if (grids.Count > before) { Utilities.Log_Utils.Write($"{source.Describe()}: {grids.Count - before} grids."); }
            }
            return grids.ToArray();
        }

        /// <summary>
        /// One model's grids: multi-segment grids first (their segments are joined and then skipped as single grids),
        /// then the plain grids.
        /// </summary>
        private void CollectGrids(SourceModel source, List<GridLine> into)
        {
            Document doc = source.Doc;
            Transform transform = source.Transform;
            var segmentIds = new HashSet<long>();

            foreach (DB.MultiSegmentGrid multi in new FilteredElementCollector(doc).OfClass(typeof(DB.MultiSegmentGrid)).Cast<DB.MultiSegmentGrid>())
            {
                try
                {
                    var segments = new List<Vector2[]>();
                    float bottom = float.PositiveInfinity, top = float.NegativeInfinity;
                    bool curved = false;
                    foreach (ElementId id in multi.GetGridIds())
                    {
                        if (doc.GetElement(id) is not DB.Grid segment) { continue; }
                        segmentIds.Add(id.Value);
                        Vector2[] points = GridPoints(segment.Curve, transform);
                        if (points == null) { continue; }
                        segments.Add(points);
                        curved |= segment.Curve is DB.Arc;
                        GridExtent(segment, transform, ref bottom, ref top);
                    }
                    List<Vector2> line = GridLayout.Chain(segments);
                    AddGrid(into, multi.Name, source.Link, line, bottom, top, curved);
                }
                catch (Exception ex)
                {
                    Utilities.Log_Utils.Write($"{source.Describe()}: multi-segment grid {multi.Id.Value} skipped: {ex.Message}");
                }
            }

            foreach (DB.Grid grid in new FilteredElementCollector(doc).OfClass(typeof(DB.Grid)).Cast<DB.Grid>())
            {
                if (segmentIds.Contains(grid.Id.Value)) { continue; }
                try
                {
                    Vector2[] points = GridPoints(grid.Curve, transform);
                    if (points == null) { continue; }
                    float bottom = float.PositiveInfinity, top = float.NegativeInfinity;
                    GridExtent(grid, transform, ref bottom, ref top);
                    AddGrid(into, grid.Name, source.Link, points, bottom, top, grid.Curve is DB.Arc);
                }
                catch (Exception ex)
                {
                    Utilities.Log_Utils.Write($"{source.Describe()}: grid {grid.Id.Value} skipped: {ex.Message}");
                }
            }
        }

        /// <summary>
        /// Adds a grid when its line has two or more points (an unknown extent stays open: ±∞).
        /// </summary>
        private static void AddGrid(List<GridLine> into, string name, int link, IReadOnlyList<Vector2> points, float bottom, float top, bool curved)
        {
            if (points == null || points.Count < 2) { return; }
            bool extent = float.IsFinite(bottom) && float.IsFinite(top) && top >= bottom;
            into.Add(new GridLine
            {
                Name = string.IsNullOrWhiteSpace(name) ? "?" : name.Trim(),
                Link = link,
                Points = points.ToArray(),
                Bottom = extent ? bottom : float.NegativeInfinity,
                Top = extent ? top : float.PositiveInfinity,
                Curved = curved
            });
        }

        /// <summary>
        /// A grid curve's plan points in scene metres (a line's two ends, an arc's tessellation), through a link's
        /// transform; null when the curve is missing or too short.
        /// </summary>
        private Vector2[] GridPoints(DB.Curve curve, Transform transform)
        {
            if (curve == null || !curve.IsBound) { return null; }
            IList<XYZ> raw = curve is DB.Line ? new[] { curve.GetEndPoint(0), curve.GetEndPoint(1) } : curve.Tessellate();
            if (raw == null || raw.Count < 2) { return null; }
            var points = new List<Vector2>(raw.Count);
            foreach (XYZ p in raw)
            {
                Vector3 scene = ToScenePoint(transform == null ? p : transform.OfPoint(p));
                var plan = new Vector2(scene.X, scene.Y);
                if (points.Count > 0 && Vector2.DistanceSquared(points[^1], plan) < 1e-8f) { continue; }
                points.Add(plan);
            }
            return points.Count >= 2 ? points.ToArray() : null;
        }

        /// <summary>
        /// Widens [bottom, top] by the grid's 3D extent (scene Z, through a link's transform). Leaves them alone when
        /// the extent can't be read or is flat.
        /// </summary>
        private void GridExtent(DB.Grid grid, Transform transform, ref float bottom, ref float top)
        {
            DB.Outline outline;
            try { outline = grid.GetExtents(); }
            catch { return; }
            if (outline == null) { return; }
            XYZ a = outline.MinimumPoint, b = outline.MaximumPoint;
            if (a == null || b == null || Math.Abs(b.Z - a.Z) < 1e-6) { return; }
            if (transform != null)
            {
                a = transform.OfPoint(a);
                b = transform.OfPoint(b);
            }
            float z0 = ToScenePoint(a).Z, z1 = ToScenePoint(b).Z;
            bottom = MathF.Min(bottom, MathF.Min(z0, z1));
            top = MathF.Max(top, MathF.Max(z0, z1));
        }
    }
}
