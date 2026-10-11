using System.Numerics;
using BimGo.Audio;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Guns namespace
namespace BimGo.Game.Guns
{
    /// <summary>
    /// Gun 2: measuring, in four modes (review tools round). Pressing 2 again (while it is the selected gun) cycles
    /// Distance → Area → Angle → Clearance. RMB removes the last measurement (or cancels the one being made); X clears
    /// them all. Measurements are temporary markers: they are never saved.
    /// <list type="bullet">
    /// <item><b>Distance:</b> LMB start, LMB end, a rubber band in between. N snaps the end along the start face's normal.</item>
    /// <item><b>Area:</b> LMB adds corners on the plane of the first point (the aim ray meets that plane); clicking the
    /// first corner again, or RMB with three or more corners, closes the outline. Shows the area and perimeter.</item>
    /// <item><b>Angle:</b> three clicks: first arm, vertex, second arm (0–180°).</item>
    /// <item><b>Clearance:</b> from the aimed point straight down to the surface below (the floor) and up to the next
    /// surface above (the ceiling), both labelled, with the total. A live preview follows the crosshair.</item>
    /// </list>
    /// Values follow the display units (metric / imperial) chosen in the pause menu.
    /// </summary>
    internal sealed class MeasureGun : Gun
    {
        #region Types

        /// <summary>The measuring modes, in cycling order.</summary>
        public enum MeasureMode
        {
            Distance = 0,
            Area = 1,
            Angle = 2,
            Clearance = 3
        }

        /// <summary>One committed measurement.</summary>
        private sealed class Measurement
        {
            public MeasureMode Mode;

            /// <summary>Distance: A, B. Area: the corners. Angle: arm, vertex, arm. Clearance: top, point, bottom.</summary>
            public Vector3[] Points;

            /// <summary>Area: the plane normal.</summary>
            public Vector3 Normal;

            /// <summary>Area: fill triangles (indices into <see cref="Points"/>).</summary>
            public int[] Fill;

            /// <summary>Distance: length. Area: area (m²). Angle: degrees. Clearance: distance down.</summary>
            public double Value;

            /// <summary>Area: perimeter. Clearance: distance up.</summary>
            public double Value2;

            /// <summary>Clearance: a surface was found below / above.</summary>
            public bool Below, Above;

            /// <summary>Label anchor (world).</summary>
            public Vector3 Anchor;
        }

        #endregion

        #region Constants

        private static readonly string[] MODE_NAMES = { "DISTANCE", "AREA", "ANGLE", "CLEARANCE" };
        private static readonly string[] MODE_CHIPS = { "DIST", "AREA", "ANGLE", "CLEAR" };

        /// <summary>Most corners in one area outline.</summary>
        private const int MAX_AREA_POINTS = 64;

        /// <summary>A click this close to the first corner (screen pixels, unscaled) closes the outline.</summary>
        private const float CLOSE_PIXELS = 14f;

        /// <summary>How far clearance rays look up and down (m).</summary>
        private const float CLEARANCE_REACH = 60f;

        /// <summary>Offset off the aimed surface before casting the clearance rays (m).</summary>
        private const float CLEARANCE_LIFT = 0.01f;

        #endregion

        #region Fields

        private readonly List<Measurement> _measurements = new();
        private MeasureMode _mode = MeasureMode.Distance;
        private bool _normalSnap;

        // In progress: the clicked points (distance 1, area up to 64, angle up to 2) and the live point
        private readonly List<Vector3> _pending = new(MAX_AREA_POINTS);
        private Vector3 _planeNormal;
        private bool _hasLive;
        private Vector3 _liveEnd;

        // Scratch for live values (no per-frame allocation)
        private readonly List<Vector3> _scratch = new(MAX_AREA_POINTS + 1);

        // Clearance preview (follows the crosshair)
        private bool _previewValid;
        private Vector3 _previewPoint, _previewTop, _previewBottom;
        private bool _previewAbove, _previewBelow;

        #endregion

        public MeasureGun(GameSession session) : base(session) { }

        #region Gun

        public override string Name => "MEASURE";

        public override string HintPrimary => _mode switch
        {
            MeasureMode.Area => _pending.Count == 0 ? "Place the first corner" : "Add a corner (first corner closes)",
            MeasureMode.Angle => _pending.Count == 0 ? "First arm" : _pending.Count == 1 ? "Vertex" : "Second arm",
            MeasureMode.Clearance => "Measure floor to ceiling here",
            _ => _pending.Count > 0 ? "Commit end point" : "Place start point"
        };

        public override string HintSecondary => _mode == MeasureMode.Area && _pending.Count >= 3 ? "Close the outline"
            : _pending.Count > 0 ? "Cancel" : "Remove last";

        public override uint Colour => UiTheme.MEASURE;

        public override void DrawIcon(UiBatch ui, float cx, float cy, float size, uint colour) => GunIcons.Measure(ui, cx, cy, size, colour);

        public override float PanelHeight => _mode switch
        {
            MeasureMode.Distance => 176f,
            MeasureMode.Clearance => 176f,
            _ => 158f
        };

        /// <summary>The mode in use (for the help line).</summary>
        public MeasureMode Mode => _mode;

        public override void OnReselect()
        {
            _mode = (MeasureMode)(((int)_mode + 1) % MODE_NAMES.Length);
            CancelPending();
            Session.Sound.Play(SoundId.UiClick);
            Session.Toast($"Measure: {Title(_mode)} (press 2 again for {Title((MeasureMode)(((int)_mode + 1) % MODE_NAMES.Length))})", 2f);
        }

        public override void Update(float dt, in AimInfo aim)
        {
            _hasLive = false;
            _previewValid = false;
            switch (_mode)
            {
                case MeasureMode.Distance:
                    if (_pending.Count > 0 && aim.HasHit)
                    {
                        _hasLive = true;
                        _liveEnd = SnapNormal(aim.Hit.Point);
                    }
                    break;

                case MeasureMode.Area:
                    if (_pending.Count > 0 && OnPlane(aim, out Vector3 onPlane))
                    {
                        _hasLive = true;
                        _liveEnd = SnapToFirst(onPlane);
                    }
                    break;

                case MeasureMode.Angle:
                    if (_pending.Count > 0 && aim.HasHit)
                    {
                        _hasLive = true;
                        _liveEnd = aim.Hit.Point;
                    }
                    break;

                case MeasureMode.Clearance:
                    if (aim.HasHit)
                    {
                        _previewValid = Clearance(aim.Hit, out _previewPoint, out _previewTop, out _previewBottom, out _previewAbove, out _previewBelow);
                    }
                    break;
            }
        }

        public override void OnDeselect()
        {
            _hasLive = false;
            _previewValid = false;
        }

        public override void OnKeys(InputState input)
        {
            if (_mode == MeasureMode.Distance && input.IsPressed('N'))
            {
                _normalSnap = !_normalSnap;
                Session.Toast(_normalSnap ? "Normal projection ON" : "Normal projection OFF");
            }
        }

        public override void OnPrimary(in AimInfo aim)
        {
            switch (_mode)
            {
                case MeasureMode.Distance: PrimaryDistance(aim); break;
                case MeasureMode.Area: PrimaryArea(aim); break;
                case MeasureMode.Angle: PrimaryAngle(aim); break;
                case MeasureMode.Clearance: PrimaryClearance(aim); break;
            }
        }

        public override void OnSecondary(in AimInfo aim)
        {
            if (_mode == MeasureMode.Area && _pending.Count >= 3)
            {
                CloseArea();
                return;
            }
            if (_pending.Count > 0)
            {
                CancelPending();
                return;
            }
            if (_measurements.Count > 0)
            {
                _measurements.RemoveAt(_measurements.Count - 1);
                Session.Sound.Play(SoundId.Remove);
            }
        }

        public override void ClearMarkers()
        {
            _measurements.Clear();
            CancelPending();
        }

        #endregion

        #region Modes

        private void PrimaryDistance(in AimInfo aim)
        {
            if (!aim.HasHit) { return; }
            if (_pending.Count == 0)
            {
                _pending.Add(aim.Hit.Point);
                _planeNormal = aim.Hit.Normal;
            }
            else
            {
                Vector3 a = _pending[0], b = SnapNormal(aim.Hit.Point);
                _measurements.Add(new Measurement
                {
                    Mode = MeasureMode.Distance,
                    Points = new[] { a, b },
                    Value = Vector3.Distance(a, b),
                    Anchor = (a + b) * 0.5f
                });
                CancelPending();
            }
            Session.Sound.Play(SoundId.Click);
        }

        private void PrimaryArea(in AimInfo aim)
        {
            if (_pending.Count == 0)
            {
                if (!aim.HasHit) { return; }
                _pending.Add(aim.Hit.Point);
                _planeNormal = Vector3.Normalize(aim.Hit.Normal);
                Session.Sound.Play(SoundId.Click);
                return;
            }

            if (!OnPlane(aim, out Vector3 point)) { return; }

            // A click on the first corner closes the outline
            if (_pending.Count >= 3 && NearFirst(point))
            {
                CloseArea();
                return;
            }
            if (Vector3.DistanceSquared(point, _pending[^1]) < 1e-6f) { return; } // double click on the same spot
            if (_pending.Count >= MAX_AREA_POINTS)
            {
                Session.Toast($"An outline has at most {MAX_AREA_POINTS} corners: closing it", 2.5f);
                CloseArea();
                return;
            }
            _pending.Add(point);
            Session.Sound.Play(SoundId.Click);
        }

        private void CloseArea()
        {
            if (_pending.Count < 3)
            {
                CancelPending();
                return;
            }
            Vector3[] points = _pending.ToArray();
            var fill = new List<int>(points.Length * 3);
            MeasureMath.Triangulate(points, _planeNormal, fill);
            double area = MeasureMath.PolygonArea(points, _planeNormal);
            Vector3 centre = Vector3.Zero;
            foreach (Vector3 p in points) { centre += p; }
            _measurements.Add(new Measurement
            {
                Mode = MeasureMode.Area,
                Points = points,
                Normal = _planeNormal,
                Fill = fill.ToArray(),
                Value = area,
                Value2 = MeasureMath.Perimeter(points),
                Anchor = centre / points.Length
            });
            CancelPending();
            Session.Sound.Play(SoundId.Commit);
        }

        private void PrimaryAngle(in AimInfo aim)
        {
            if (!aim.HasHit) { return; }
            if (_pending.Count < 2)
            {
                _pending.Add(aim.Hit.Point);
                Session.Sound.Play(SoundId.Click);
                return;
            }
            Vector3 a = _pending[0], vertex = _pending[1], b = aim.Hit.Point;
            double degrees = MeasureMath.AngleDegrees(a, vertex, b);
            if (double.IsNaN(degrees))
            {
                Session.Toast("Pick points away from the vertex to measure an angle");
                return;
            }
            _measurements.Add(new Measurement
            {
                Mode = MeasureMode.Angle,
                Points = new[] { a, vertex, b },
                Value = degrees,
                Anchor = vertex
            });
            CancelPending();
            Session.Sound.Play(SoundId.Click);
        }

        private void PrimaryClearance(in AimInfo aim)
        {
            if (!aim.HasHit) { return; }
            if (!Clearance(aim.Hit, out Vector3 point, out Vector3 top, out Vector3 bottom, out bool above, out bool below))
            {
                Session.Toast("Nothing above or below this point to measure to");
                return;
            }
            _measurements.Add(new Measurement
            {
                Mode = MeasureMode.Clearance,
                Points = new[] { top, point, bottom },
                Value = point.Z - bottom.Z,
                Value2 = top.Z - point.Z,
                Above = above,
                Below = below,
                Anchor = point
            });
            Session.Sound.Play(SoundId.Click);
        }

        /// <summary>
        /// Clearance rays from an aimed point: straight down to the first surface (or the ground plane) and straight up
        /// to the next one. The point is lifted 1 cm off its surface first; a surface found within 2 cm counts as the
        /// point itself (aiming at a floor measures 0 down, at a ceiling 0 up).
        /// </summary>
        /// <returns>False when there is nothing above and nothing below.</returns>
        private bool Clearance(in RayHit hit, out Vector3 point, out Vector3 top, out Vector3 bottom, out bool above, out bool below)
        {
            point = hit.Point;
            Vector3 normal = hit.Normal.LengthSquared() > 1e-8f ? Vector3.Normalize(hit.Normal) : Vector3.UnitZ;
            Vector3 start = point + normal * CLEARANCE_LIFT;

            below = Session.Pick(start, -Vector3.UnitZ, CLEARANCE_REACH, out RayHit down);
            bottom = below ? down.Point : point;
            if (below && point.Z - bottom.Z < 0.02f) { bottom = point; }
            if (!below && point.Z > Session.GroundZ)
            {
                // Outside, over the ground plane
                below = true;
                bottom = new Vector3(point.X, point.Y, Session.GroundZ);
            }

            above = Session.Pick(start, Vector3.UnitZ, CLEARANCE_REACH, out RayHit up);
            top = above ? up.Point : point;
            if (above && top.Z - point.Z < 0.02f) { top = point; }

            // Aiming at a ceiling: the "up" ray hits the ceiling itself, so measure down from it
            return above || below;
        }

        #endregion

        #region Helpers

        private void CancelPending()
        {
            _pending.Clear();
            _hasLive = false;
        }

        /// <summary>Distance mode: snaps a candidate end along the start face's normal when N is on.</summary>
        private Vector3 SnapNormal(Vector3 point)
        {
            if (!_normalSnap || _pending.Count == 0) { return point; }
            Vector3 start = _pending[0];
            return start + _planeNormal * Vector3.Dot(point - start, _planeNormal);
        }

        /// <summary>Area mode: where the aim ray meets the outline's plane (or the aimed point projected onto it).</summary>
        private bool OnPlane(in AimInfo aim, out Vector3 point)
        {
            if (MeasureMath.RayPlane(aim.Origin, aim.Direction, _pending[0], _planeNormal, out point)
                && Vector3.DistanceSquared(point, aim.Origin) < 250f * 250f)
            {
                return true;
            }
            if (aim.HasHit)
            {
                point = MeasureMath.ProjectToPlane(aim.Hit.Point, _pending[0], _planeNormal);
                return true;
            }
            point = default;
            return false;
        }

        /// <summary>True when a point shows within the close distance of the first corner on screen.</summary>
        private bool NearFirst(Vector3 point)
        {
            if (!Session.Camera.WorldToScreen(point, out Vector2 a) || !Session.Camera.WorldToScreen(_pending[0], out Vector2 b))
            {
                return Vector3.Distance(point, _pending[0]) < 0.05f;
            }
            return Vector2.Distance(a, b) <= S(CLOSE_PIXELS);
        }

        /// <summary>Area mode: the live point snaps onto the first corner when near it (shows that a click closes).</summary>
        private Vector3 SnapToFirst(Vector3 point) => _pending.Count >= 3 && NearFirst(point) ? _pending[0] : point;

        private static string Title(MeasureMode mode) => mode switch
        {
            MeasureMode.Area => "area",
            MeasureMode.Angle => "angle",
            MeasureMode.Clearance => "clearance",
            _ => "distance"
        };

        /// <summary>The live area outline (pending corners + the live point) in the scratch list.</summary>
        private List<Vector3> LiveOutline()
        {
            _scratch.Clear();
            _scratch.AddRange(_pending);
            if (_hasLive && (_scratch.Count == 0 || _liveEnd != _pending[0])) { _scratch.Add(_liveEnd); }
            return _scratch;
        }

        #endregion

        #region Drawing

        public override void DrawWorld(Overlay3D overlay, bool selected)
        {
            uint line = Rgba.WithAlpha(UiTheme.MEASURE, selected ? 0.95f : 0.6f);
            uint fill = Rgba.WithAlpha(UiTheme.MEASURE, selected ? 0.18f : 0.1f);

            foreach (Measurement m in _measurements)
            {
                Vector3[] p = m.Points;
                switch (m.Mode)
                {
                    case MeasureMode.Distance:
                        overlay.Line(p[0], p[1], 3f, line);
                        overlay.Dot(p[0], 4.5f, line);
                        overlay.Dot(p[1], 4.5f, line);
                        break;

                    case MeasureMode.Area:
                        // Lifted a millimetre off the surface so the fill doesn't fight it
                        Vector3 lift = m.Normal * 0.002f;
                        for (int i = 0; i + 2 < m.Fill.Length; i += 3)
                        {
                            overlay.Triangle(p[m.Fill[i]] + lift, p[m.Fill[i + 1]] + lift, p[m.Fill[i + 2]] + lift, fill);
                        }
                        for (int i = 0; i < p.Length; i++)
                        {
                            overlay.Line(p[i], p[(i + 1) % p.Length], 2.5f, line);
                            overlay.Dot(p[i], 3.5f, line);
                        }
                        break;

                    case MeasureMode.Angle:
                        overlay.Line(p[1], p[0], 3f, line);
                        overlay.Line(p[1], p[2], 3f, line);
                        overlay.Dot(p[0], 4f, line);
                        overlay.Dot(p[1], 5.5f, line);
                        overlay.Dot(p[2], 4f, line);
                        DrawArc(overlay, p[0], p[1], p[2], line);
                        break;

                    case MeasureMode.Clearance:
                        DrawClearance(overlay, p[0], p[1], p[2], m.Above, m.Below, line);
                        break;
                }
            }

            if (!selected) { return; }

            // In progress
            switch (_mode)
            {
                case MeasureMode.Distance:
                    if (_pending.Count > 0)
                    {
                        overlay.Dot(_pending[0], 6f, UiTheme.MEASURE);
                        if (_hasLive)
                        {
                            overlay.Line(_pending[0], _liveEnd, 3f, UiTheme.MEASURE);
                            overlay.Dot(_liveEnd, 6f, UiTheme.MEASURE);
                        }
                    }
                    break;

                case MeasureMode.Area:
                    for (int i = 0; i < _pending.Count; i++)
                    {
                        overlay.Dot(_pending[i], i == 0 ? 6.5f : 4.5f, UiTheme.MEASURE);
                        if (i > 0) { overlay.Line(_pending[i - 1], _pending[i], 2.5f, UiTheme.MEASURE); }
                    }
                    if (_hasLive && _pending.Count > 0)
                    {
                        overlay.Line(_pending[^1], _liveEnd, 2.5f, UiTheme.MEASURE);
                        if (_pending.Count >= 2) { overlay.Line(_liveEnd, _pending[0], 1.5f, Rgba.WithAlpha(UiTheme.MEASURE, 0.45f)); }
                        overlay.Dot(_liveEnd, 5f, UiTheme.MEASURE);
                    }
                    break;

                case MeasureMode.Angle:
                    for (int i = 0; i < _pending.Count; i++) { overlay.Dot(_pending[i], i == 1 ? 6.5f : 5f, UiTheme.MEASURE); }
                    if (_pending.Count == 2) { overlay.Line(_pending[1], _pending[0], 3f, UiTheme.MEASURE); }
                    if (_hasLive)
                    {
                        overlay.Line(_pending[^1], _liveEnd, 3f, UiTheme.MEASURE);
                        overlay.Dot(_liveEnd, 5f, UiTheme.MEASURE);
                        if (_pending.Count == 2) { DrawArc(overlay, _pending[0], _pending[1], _liveEnd, UiTheme.MEASURE); }
                    }
                    break;

                case MeasureMode.Clearance:
                    if (_previewValid)
                    {
                        DrawClearance(overlay, _previewTop, _previewPoint, _previewBottom, _previewAbove, _previewBelow, Rgba.WithAlpha(UiTheme.MEASURE, 0.7f));
                    }
                    break;
            }
        }

        /// <summary>A small arc at the vertex between the two arms.</summary>
        private static void DrawArc(Overlay3D overlay, Vector3 a, Vector3 vertex, Vector3 b, uint colour)
        {
            Vector3 p = a - vertex, q = b - vertex;
            float lp = p.Length(), lq = q.Length();
            if (lp < 1e-4f || lq < 1e-4f) { return; }
            p /= lp;
            q /= lq;
            float radius = MathF.Min(MathF.Min(lp, lq) * 0.3f, 0.4f);
            float angle = MathF.Acos(Math.Clamp(Vector3.Dot(p, q), -1f, 1f));
            if (angle < 1e-3f) { return; }

            // Slerp from p to q
            Vector3 previous = vertex + p * radius;
            const int SEGMENTS = 16;
            for (int i = 1; i <= SEGMENTS; i++)
            {
                float t = (float)i / SEGMENTS;
                float s = MathF.Sin(angle);
                Vector3 d = s > 1e-4f ? (MathF.Sin((1f - t) * angle) * p + MathF.Sin(t * angle) * q) / s : p;
                Vector3 next = vertex + d * radius;
                overlay.Line(previous, next, 2f, colour);
                previous = next;
            }
        }

        /// <summary>The clearance marker: a vertical line with ticks at the ends and the aimed point.</summary>
        private static void DrawClearance(Overlay3D overlay, Vector3 top, Vector3 point, Vector3 bottom, bool above, bool below, uint colour)
        {
            if (below && point.Z - bottom.Z > 1e-3f)
            {
                overlay.Line(point, bottom, 3f, colour);
                overlay.Dot(bottom, 4.5f, colour);
            }
            if (above && top.Z - point.Z > 1e-3f)
            {
                overlay.Line(point, top, 3f, colour);
                overlay.Dot(top, 4.5f, colour);
            }
            overlay.Dot(point, 5.5f, colour);
        }

        public override void DrawLabels(UiBatch ui, bool selected)
        {
            FontAtlas f = ui.Atlas;
            uint committed = Rgba.WithAlpha(UiTheme.MEASURE_TEXT, selected ? 1f : 0.7f);
            TextBuffer text = Session.Text;

            foreach (Measurement m in _measurements)
            {
                Vector3[] p = m.Points;
                switch (m.Mode)
                {
                    case MeasureMode.Distance:
                        Label(ui, f.Mono, m.Anchor, text.Clear().AppendLength(m.Value), committed, false);
                        break;

                    case MeasureMode.Area:
                        Label(ui, f.Mono, m.Anchor, text.Clear().AppendArea(m.Value, 2), committed, false);
                        break;

                    case MeasureMode.Angle:
                        Label(ui, f.Mono, m.Anchor, text.Clear().Append(m.Value, 1).Append('°'), committed, false);
                        break;

                    case MeasureMode.Clearance:
                        ClearanceLabels(ui, f.Mono, p[0], p[1], p[2], m.Above, m.Below, committed, false);
                        break;
                }
            }

            if (!selected) { return; }
            switch (_mode)
            {
                case MeasureMode.Distance when _pending.Count > 0 && _hasLive:
                    Label(ui, f.Bold, (_pending[0] + _liveEnd) * 0.5f, text.Clear().AppendLength(Vector3.Distance(_pending[0], _liveEnd)), UiTheme.MEASURE_TEXT, true);
                    break;

                case MeasureMode.Area when _pending.Count >= 2:
                    List<Vector3> outline = LiveOutline();
                    if (outline.Count >= 3)
                    {
                        Vector3 centre = Vector3.Zero;
                        foreach (Vector3 p in outline) { centre += p; }
                        Label(ui, f.Bold, centre / outline.Count, text.Clear().AppendArea(MeasureMath.PolygonArea(outline, _planeNormal), 2), UiTheme.MEASURE_TEXT, true);
                    }
                    break;

                case MeasureMode.Angle when _pending.Count == 2 && _hasLive:
                    double degrees = MeasureMath.AngleDegrees(_pending[0], _pending[1], _liveEnd);
                    if (!double.IsNaN(degrees)) { Label(ui, f.Bold, _pending[1], text.Clear().Append(degrees, 1).Append('°'), UiTheme.MEASURE_TEXT, true); }
                    break;

                case MeasureMode.Clearance when _previewValid:
                    ClearanceLabels(ui, f.Bold, _previewTop, _previewPoint, _previewBottom, _previewAbove, _previewBelow, UiTheme.MEASURE_TEXT, true);
                    break;
            }
        }

        /// <summary>"↓ 0.750 m" beside the lower segment and "↑ 1.950 m" beside the upper one.</summary>
        private void ClearanceLabels(UiBatch ui, UiFont font, Vector3 top, Vector3 point, Vector3 bottom, bool above, bool below, uint colour, bool live)
        {
            TextBuffer text = Session.Text;
            float down = point.Z - bottom.Z, up = top.Z - point.Z;
            if (below && down > 1e-3f) { Label(ui, font, (point + bottom) * 0.5f, text.Clear().Append("↓ ").AppendLength(down), colour, live); }
            if (above && up > 1e-3f) { Label(ui, font, (point + top) * 0.5f, text.Clear().Append("↑ ").AppendLength(up), colour, live); }
            else if (!above) { Label(ui, font, point, text.Clear().Append("↑ nothing above"), colour, live); }
        }

        private void Label(UiBatch ui, UiFont font, Vector3 anchor, TextBuffer text, uint colour, bool live)
        {
            if (!Session.Camera.WorldToScreen(anchor, out Vector2 screen)) { return; }
            float width = UiBatch.Measure(font, text.Span) + S(16);
            float height = font.LineHeight + S(6);
            float x = screen.X - width * 0.5f, y = screen.Y - height - S(6);
            if (live) { ui.Panel(x, y, width, height, Rgba.Hex(0x0C0E12, 0.85f), UiTheme.MEASURE); }
            else { ui.Rect(x, y, width, height, Rgba.Hex(0x0C0E12, 0.7f)); }
            ui.Text(font, x + S(8), y + S(3), text.Span, colour);
        }

        #endregion

        #region Panel

        public override void DrawPanel(UiBatch ui, float x, float y, float width)
        {
            FontAtlas f = ui.Atlas;
            TextBuffer text = Session.Text;
            bool live = _hasLive || _previewValid || _pending.Count > 0;
            text.Clear().Append("MEASURE · ").Append(MODE_NAMES[(int)_mode]).Append(live ? " · LIVE" : string.Empty);
            ui.Text(f.Small, x, y, text.Span, UiTheme.MEASURE_LABEL, S(1.1f));
            y += S(20);

            // Mode chips (2 cycles them)
            float chipW = (width - S(6) * 3f) / 4f, chipH = S(20);
            for (int i = 0; i < MODE_CHIPS.Length; i++)
            {
                float cx = x + i * (chipW + S(6));
                bool on = i == (int)_mode;
                ui.Rect(cx, y, chipW, chipH, on ? UiTheme.MEASURE : Rgba.Hex(0xFFFFFF, 0.06f));
                ui.TextCentred(f.Small, cx + chipW * 0.5f, y + S(4), MODE_CHIPS[i], on ? Rgba.Hex(0x1A1405) : UiTheme.TEXT_MUTED, S(0.8f));
            }
            y += chipH + S(10);

            switch (_mode)
            {
                case MeasureMode.Area: PanelArea(ui, f, x, y, width); break;
                case MeasureMode.Angle: PanelAngle(ui, f, x, y, width); break;
                case MeasureMode.Clearance: PanelClearance(ui, f, x, y, width); break;
                default: PanelDistance(ui, f, x, y, width); break;
            }
        }

        private Measurement LastOf(MeasureMode mode)
        {
            for (int i = _measurements.Count - 1; i >= 0; i--)
            {
                if (_measurements[i].Mode == mode) { return _measurements[i]; }
            }
            return null;
        }

        private int CountOf(MeasureMode mode)
        {
            int count = 0;
            foreach (Measurement m in _measurements) { if (m.Mode == mode) { count++; } }
            return count;
        }

        private void PanelDistance(UiBatch ui, FontAtlas f, float x, float y, float width)
        {
            TextBuffer text = Session.Text;
            Measurement last = LastOf(MeasureMode.Distance);
            bool any = _hasLive || last != null;
            Vector3 a = _hasLive ? _pending[0] : last?.Points[0] ?? Vector3.Zero;
            Vector3 b = _hasLive ? _liveEnd : last?.Points[1] ?? Vector3.Zero;
            Vector3 d = b - a;

            if (any) { text.Clear().AppendLength(d.Length()); } else { text.Clear().Append("—"); }
            ui.Text(f.MonoLarge, x, y, text.Span, UiTheme.TEXT);
            y += S(36);

            // ΔX / ΔY / ΔZ in three columns (feet-inches are wider: the small font there)
            UiFont deltaFont = UnitFormat.IsImperial ? f.Small : f.Mono;
            float column = width / 3f;
            Delta(ui, deltaFont, x, y, "ΔX ", d.X, any);
            Delta(ui, deltaFont, x + column, y, "ΔY ", d.Y, any);
            Delta(ui, deltaFont, x + column * 2f, y, "ΔZ ", d.Z, any);
            y += S(22);

            Row(ui, f, x, y, width, "Distances", text.Clear().Append(CountOf(MeasureMode.Distance)));
            y += S(19);
            ui.Text(f.Body, x, y, "Normal projection (N)", UiTheme.TEXT_MUTED);
            ui.TextRight(f.Body, x + width, y, _normalSnap ? "ON" : "OFF", UiTheme.MEASURE_LABEL);
            y += S(19);
            ui.Text(f.Small, x, y, "Press 2 again: area · angle · clearance", UiTheme.TEXT_FAINT);
        }

        private void PanelArea(UiBatch ui, FontAtlas f, float x, float y, float width)
        {
            TextBuffer text = Session.Text;
            Measurement last = LastOf(MeasureMode.Area);
            double area, perimeter;
            int corners;
            if (_pending.Count > 0)
            {
                List<Vector3> outline = LiveOutline();
                area = MeasureMath.PolygonArea(outline, _planeNormal);
                perimeter = MeasureMath.Perimeter(outline, closed: outline.Count >= 3);
                corners = _pending.Count;
            }
            else
            {
                area = last?.Value ?? double.NaN;
                perimeter = last?.Value2 ?? double.NaN;
                corners = last?.Points.Length ?? 0;
            }

            if (double.IsNaN(area)) { text.Clear().Append("—"); } else { text.Clear().AppendArea(area, 2); }
            ui.Text(f.MonoLarge, x, y, text.Span, UiTheme.TEXT);
            y += S(36);

            if (double.IsNaN(perimeter)) { text.Clear().Append("—"); } else { text.Clear().AppendLength(perimeter, 2); }
            Row(ui, f, x, y, width, "Perimeter", text);
            y += S(19);
            Row(ui, f, x, y, width, _pending.Count > 0 ? "Corners so far" : "Corners", text.Clear().Append(corners));
            y += S(19);
            ui.Text(f.Small, x, y, _pending.Count >= 3 ? "Click the first corner or RMB to close" : "Corners lie on the first point's plane", UiTheme.TEXT_FAINT);
        }

        private void PanelAngle(UiBatch ui, FontAtlas f, float x, float y, float width)
        {
            TextBuffer text = Session.Text;
            double degrees = double.NaN;
            if (_pending.Count == 2 && _hasLive) { degrees = MeasureMath.AngleDegrees(_pending[0], _pending[1], _liveEnd); }
            else if (_pending.Count == 0 && LastOf(MeasureMode.Angle) is Measurement last) { degrees = last.Value; }

            if (double.IsNaN(degrees)) { text.Clear().Append("—"); } else { text.Clear().Append(degrees, 1).Append('°'); }
            ui.Text(f.MonoLarge, x, y, text.Span, UiTheme.TEXT);
            y += S(36);

            Row(ui, f, x, y, width, "Angles", text.Clear().Append(CountOf(MeasureMode.Angle)));
            y += S(19);
            string step = _pending.Count switch
            {
                0 => "Click 1 of 3: first arm",
                1 => "Click 2 of 3: the vertex",
                _ => "Click 3 of 3: second arm"
            };
            ui.Text(f.Body, x, y, step, UiTheme.TEXT_MUTED);
            y += S(19);
            ui.Text(f.Small, x, y, "The vertex is the middle click", UiTheme.TEXT_FAINT);
        }

        private void PanelClearance(UiBatch ui, FontAtlas f, float x, float y, float width)
        {
            TextBuffer text = Session.Text;
            bool show;
            Vector3 top, point, bottom;
            bool above, below;
            if (_previewValid)
            {
                show = true;
                top = _previewTop; point = _previewPoint; bottom = _previewBottom;
                above = _previewAbove; below = _previewBelow;
            }
            else if (LastOf(MeasureMode.Clearance) is Measurement last)
            {
                show = true;
                top = last.Points[0]; point = last.Points[1]; bottom = last.Points[2];
                above = last.Above; below = last.Below;
            }
            else
            {
                show = false;
                top = point = bottom = Vector3.Zero;
                above = below = false;
            }

            float down = point.Z - bottom.Z, up = top.Z - point.Z;
            if (show && above && below) { text.Clear().AppendLength(top.Z - bottom.Z); } else { text.Clear().Append("—"); }
            ui.Text(f.MonoLarge, x, y, text.Span, UiTheme.TEXT);
            y += S(36);

            Row(ui, f, x, y, width, "↓ To the surface below", show && below ? text.Clear().AppendLength(down) : text.Clear().Append("—"));
            y += S(19);
            Row(ui, f, x, y, width, "↑ To the surface above", show && above ? text.Clear().AppendLength(up) : text.Clear().Append(show ? "none" : "—"));
            y += S(19);
            Row(ui, f, x, y, width, "Clearances", text.Clear().Append(CountOf(MeasureMode.Clearance)));
            y += S(19);
            ui.Text(f.Small, x, y, "Aim at a floor for floor to ceiling", UiTheme.TEXT_FAINT);
        }

        private void Row(UiBatch ui, FontAtlas f, float x, float y, float width, string label, TextBuffer value)
        {
            ui.Text(f.Body, x, y, label, UiTheme.TEXT_MUTED);
            ui.TextRight(f.Body, x + width, y, value.Span, UiTheme.TEXT);
        }

        private void Delta(UiBatch ui, UiFont font, float x, float y, string label, float value, bool any)
        {
            float w = ui.Text(font, x, y, label, UiTheme.TEXT_MUTED);
            // Metric: the bare number (the big value above carries the unit); imperial: feet-inches
            if (!any) { Session.Text.Clear().Append("—"); }
            else if (UnitFormat.IsImperial) { Session.Text.Clear().AppendLength(MathF.Abs(value)); }
            else { Session.Text.Clear().Append(MathF.Abs(value), 3); }
            ui.Text(font, x + w, y, Session.Text.Span, UiTheme.TEXT);
        }

        #endregion
    }
}
