using System.Numerics;
using System.Text.Json.Serialization;
using BimGo.Scene;

// The class belongs to the Format namespace
namespace BimGo.Format
{
    /// <summary>
    /// Grids round A: <c>grids.json</c> in a .bimgo (optional; written when the model has grids). Older readers ignore it.
    /// </summary>
    public sealed class GridsDto
    {
        /// <summary>The entry's own version (1).</summary>
        public int Version { get; set; } = 1;

        /// <summary>The grids, host first, then each link's.</summary>
        public List<GridDto> Grids { get; set; } = new();
    }

    /// <summary>
    /// One grid in <c>grids.json</c> (scene-local metres).
    /// </summary>
    public sealed class GridDto
    {
        /// <summary>Its name (bubble text).</summary>
        public string Name { get; set; }

        /// <summary>Link number (1..n), or absent for the host.</summary>
        public int? Link { get; set; }

        /// <summary>The plan polyline, flat x, y pairs (at least two points).</summary>
        public float[] Points { get; set; }

        /// <summary>Bottom of the 3D extent (scene Z), or absent when unknown.</summary>
        public float? Bottom { get; set; }

        /// <summary>Top of the 3D extent (scene Z), or absent when unknown.</summary>
        public float? Top { get; set; }

        /// <summary>True for an arc (or a multi-segment grid with one); absent otherwise.</summary>
        public bool? Curved { get; set; }
    }

    /// <summary>
    /// Grids round A: converts grids to and from <c>grids.json</c>, dropping damaged entries (a bad grid never fails the
    /// load).
    /// </summary>
    public static class GridFiles
    {
        /// <summary>Most points kept per grid (an arc's tessellation, many segments).</summary>
        public const int MAX_POINTS = 2048;

        /// <summary>The entry for a scene's grids, or null when it has none.</summary>
        public static GridsDto ToDto(IReadOnlyList<GridLine> grids)
        {
            if (grids == null || grids.Count == 0) { return null; }
            var dto = new GridsDto();
            foreach (GridLine grid in grids)
            {
                if (grid == null || !grid.IsValid) { continue; }
                float[] flat = new float[grid.Points.Length * 2];
                for (int i = 0; i < grid.Points.Length; i++)
                {
                    flat[i * 2] = grid.Points[i].X;
                    flat[i * 2 + 1] = grid.Points[i].Y;
                }
                dto.Grids.Add(new GridDto
                {
                    Name = grid.Name ?? string.Empty,
                    Link = grid.Link > 0 ? grid.Link : null,
                    Points = flat,
                    Bottom = grid.HasExtent ? grid.Bottom : null,
                    Top = grid.HasExtent ? grid.Top : null,
                    Curved = grid.Curved ? true : null
                });
            }
            return dto.Grids.Count == 0 ? null : dto;
        }

        /// <summary>
        /// The grids an entry holds: non-finite points, grids with fewer than two points and link numbers outside
        /// 0..<paramref name="linkCount"/> (read as the host) are dealt with; never null.
        /// </summary>
        public static GridLine[] FromDto(GridsDto dto, int linkCount)
        {
            if (dto?.Grids == null || dto.Grids.Count == 0) { return Array.Empty<GridLine>(); }
            var grids = new List<GridLine>(dto.Grids.Count);
            var points = new List<Vector2>();
            foreach (GridDto item in dto.Grids)
            {
                if (item?.Points == null || item.Points.Length < 4) { continue; }
                points.Clear();
                int count = Math.Min(item.Points.Length / 2, MAX_POINTS);
                for (int i = 0; i < count; i++)
                {
                    var p = new Vector2(item.Points[i * 2], item.Points[i * 2 + 1]);
                    if (!float.IsFinite(p.X) || !float.IsFinite(p.Y)) { continue; }
                    if (points.Count > 0 && Vector2.DistanceSquared(points[^1], p) < 1e-8f) { continue; }
                    points.Add(p);
                }
                if (points.Count < 2) { continue; }

                bool extent = item.Bottom is float b && item.Top is float t && float.IsFinite(b) && float.IsFinite(t) && t >= b;
                int link = item.Link is int l && l > 0 && l <= linkCount ? l : 0;
                grids.Add(new GridLine
                {
                    Name = string.IsNullOrWhiteSpace(item.Name) ? "?" : item.Name.Trim(),
                    Link = link,
                    Points = points.ToArray(),
                    Bottom = extent ? item.Bottom.Value : float.NegativeInfinity,
                    Top = extent ? item.Top.Value : float.PositiveInfinity,
                    Curved = item.Curved == true
                });
            }
            return grids.ToArray();
        }
    }

    /// <summary>
    /// Grids round A: how the grids are shown (the grids panel), saved per model in <c>visibility.json</c>
    /// (<see cref="VisibilitySettings.Grids"/>; the live model folder's sidecar in live sessions). Strings for the
    /// modes so the file stays readable; unknown values read as the defaults.
    /// </summary>
    public sealed class GridViewSettings
    {
        /// <summary>Levels: "off", "underfoot", "above", "below", "adjacent", "nearest" or "all".</summary>
        public string Levels { get; set; } = LEVELS_OFF;

        /// <summary>Building storeys only (All mode).</summary>
        public bool StoreysOnly { get; set; } = true;

        /// <summary>Respect each grid's Revit 3D extent (off: every grid on every shown level).</summary>
        public bool RespectExtents { get; set; } = true;

        /// <summary>Link grids too (off by default).</summary>
        public bool LinkGrids { get; set; }

        /// <summary>Bubbles with the grid name at the line ends.</summary>
        public bool Bubbles { get; set; } = true;

        /// <summary>Level tags (name + elevation) beside the bubbles.</summary>
        public bool LevelTags { get; set; } = true;

        /// <summary>A faint rectangle at each shown level around the grids.</summary>
        public bool LevelOutlines { get; set; } = true;

        /// <summary>See-through: "faint" (≈ 25 % behind walls), "depth" (hidden behind walls) or "xray" (on top).</summary>
        public string Depth { get; set; } = DEPTH_FAINT;

        /// <summary>Line colour, #RRGGBB.</summary>
        public string Colour { get; set; } = DEFAULT_COLOUR;

        /// <summary>Line opacity (0.1–1).</summary>
        public float Opacity { get; set; } = 0.85f;

        /// <summary>Line width in pixels (1–6).</summary>
        public float Width { get; set; } = 2f;

        /// <summary>Bubbles and tags are drawn within this distance (m, 20–500).</summary>
        public float LabelDistance { get; set; } = 120f;

        /// <summary>Grids round B: line style, "solid" (default) or "dashdot" (Revit-like).</summary>
        public string Line { get; set; } = LINE_SOLID;

        /// <summary>Grids round B: ring dots at the grid intersections on the shown levels (hover: the label; click: go there).</summary>
        public bool Nodes { get; set; } = true;

        /// <summary>Grids round B: clash comments (and so BCF) carry the clash's grid location ("Near C-4 : Level 2"). Off by default.</summary>
        public bool ClashComments { get; set; }

        public const string LINE_SOLID = "solid", LINE_DASH_DOT = "dashdot";

        /// <summary>True for the Revit-like dash-dot.</summary>
        [JsonIgnore]
        public bool DashDot
        {
            get => Line == LINE_DASH_DOT;
            set => Line = value ? LINE_DASH_DOT : LINE_SOLID;
        }

        public const string LEVELS_OFF = "off", LEVELS_UNDERFOOT = "underfoot", LEVELS_ALL = "all", LEVELS_ABOVE = "above",
            LEVELS_BELOW = "below", LEVELS_NEAREST = "nearest", LEVELS_ADJACENT = "adjacent";
        public const string DEPTH_FAINT = "faint", DEPTH_TESTED = "depth", DEPTH_XRAY = "xray";
        public const string DEFAULT_COLOUR = "#4FC3F7";
        public const float MIN_WIDTH = 1f, MAX_WIDTH = 6f, MIN_OPACITY = 0.1f, MIN_LABEL_DISTANCE = 20f, MAX_LABEL_DISTANCE = 500f;

        /// <summary>The level mode as an enum.</summary>
        [JsonIgnore]
        public GridLevelMode Mode
        {
            get => Levels switch
            {
                LEVELS_UNDERFOOT => GridLevelMode.Underfoot,
                LEVELS_ALL => GridLevelMode.All,
                LEVELS_ABOVE => GridLevelMode.Above,
                LEVELS_BELOW => GridLevelMode.Below,
                LEVELS_NEAREST => GridLevelMode.Nearest,
                LEVELS_ADJACENT => GridLevelMode.Adjacent,
                _ => GridLevelMode.Off
            };
            set => Levels = value switch
            {
                GridLevelMode.Underfoot => LEVELS_UNDERFOOT,
                GridLevelMode.All => LEVELS_ALL,
                GridLevelMode.Above => LEVELS_ABOVE,
                GridLevelMode.Below => LEVELS_BELOW,
                GridLevelMode.Nearest => LEVELS_NEAREST,
                GridLevelMode.Adjacent => LEVELS_ADJACENT,
                _ => LEVELS_OFF
            };
        }

        /// <summary>The see-through mode: 0 faint, 1 depth-tested, 2 x-ray.</summary>
        [JsonIgnore]
        public int DepthIndex
        {
            get => Depth switch { DEPTH_TESTED => 1, DEPTH_XRAY => 2, _ => 0 };
            set => Depth = value switch { 1 => DEPTH_TESTED, 2 => DEPTH_XRAY, _ => DEPTH_FAINT };
        }

        /// <summary>True when everything is at its default (the file then leaves it out).</summary>
        [JsonIgnore]
        public bool IsDefault
        {
            get
            {
                var d = new GridViewSettings();
                return Levels == d.Levels && StoreysOnly == d.StoreysOnly && RespectExtents == d.RespectExtents && LinkGrids == d.LinkGrids
                    && Bubbles == d.Bubbles && LevelTags == d.LevelTags && LevelOutlines == d.LevelOutlines && Depth == d.Depth
                    && string.Equals(Colour, d.Colour, StringComparison.OrdinalIgnoreCase) && MathF.Abs(Opacity - d.Opacity) < 1e-4f
                    && MathF.Abs(Width - d.Width) < 1e-4f && MathF.Abs(LabelDistance - d.LabelDistance) < 1e-3f
                    && Line == d.Line && Nodes == d.Nodes && ClashComments == d.ClashComments;
            }
        }

        /// <summary>
        /// Brings every field into range (guards against hand-edited files).
        /// </summary>
        /// <returns>This instance.</returns>
        public GridViewSettings Clean()
        {
            Mode = Mode;
            DepthIndex = DepthIndex;
            DashDot = DashDot;
            Colour = LaunchSettings.TryParseColour(Colour, out uint rgb) ? "#" + rgb.ToString("X6", System.Globalization.CultureInfo.InvariantCulture) : DEFAULT_COLOUR;
            Opacity = float.IsFinite(Opacity) ? MathF.Round(Math.Clamp(Opacity, MIN_OPACITY, 1f) * 20f) / 20f : 0.85f;
            Width = float.IsFinite(Width) ? MathF.Round(Math.Clamp(Width, MIN_WIDTH, MAX_WIDTH) * 2f) / 2f : 2f;
            LabelDistance = float.IsFinite(LabelDistance) ? MathF.Round(Math.Clamp(LabelDistance, MIN_LABEL_DISTANCE, MAX_LABEL_DISTANCE) / 10f) * 10f : 120f;
            return this;
        }

        /// <summary>A copy.</summary>
        public GridViewSettings Copy() => (GridViewSettings)MemberwiseClone();
    }
}
