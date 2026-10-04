using System.Numerics;
using RvtGo.Audio;
using RvtGo.Platform;
using RvtGo.Rendering;

// The class belongs to the Guns namespace
namespace RvtGo.Game.Guns
{
    /// <summary>
    /// Gun 2: LMB sets a start point then commits the end point; a live rubber band shows in between.
    /// RMB removes the last line (or cancels a started one). N toggles snapping the second point
    /// along the start face's normal (perpendicular distance).
    /// </summary>
    internal sealed class MeasureGun : Gun
    {
        private struct Segment
        {
            public Vector3 A, B;
        }

        private readonly List<Segment> _lines = new();
        private bool _hasStart;
        private Vector3 _start, _startNormal;
        private bool _hasLive;
        private Vector3 _liveEnd;
        private bool _normalSnap;

        public MeasureGun(GameSession session) : base(session) { }

        public override string Name => "MEASURE";
        public override string HintPrimary => _hasStart ? "Commit end point" : "Place start point";
        public override string HintSecondary => _hasStart ? "Cancel line" : "Remove last line";
        public override uint Colour => UiTheme.MEASURE;

        public override void DrawIcon(UiBatch ui, float cx, float cy, float size, uint colour) => GunIcons.Measure(ui, cx, cy, size, colour);

        public override float PanelHeight => 132f;

        public override void Update(float dt, in AimInfo aim)
        {
            _hasLive = _hasStart && aim.HasHit;
            if (_hasLive) { _liveEnd = Snap(aim.Hit.Point); }
        }

        public override void OnDeselect()
        {
            _hasLive = false;
        }

        public override void OnKeys(InputState input)
        {
            if (input.IsPressed('N'))
            {
                _normalSnap = !_normalSnap;
                Session.Toast(_normalSnap ? "Normal projection ON" : "Normal projection OFF");
            }
        }

        public override void OnPrimary(in AimInfo aim)
        {
            if (!aim.HasHit) { return; }

            if (!_hasStart)
            {
                _hasStart = true;
                _start = aim.Hit.Point;
                _startNormal = aim.Hit.Normal;
            }
            else
            {
                _lines.Add(new Segment { A = _start, B = Snap(aim.Hit.Point) });
                _hasStart = false;
                _hasLive = false;
            }
            Session.Sound.Play(SoundId.Click);
        }

        public override void OnSecondary(in AimInfo aim)
        {
            if (_hasStart)
            {
                _hasStart = false;
                _hasLive = false;
            }
            else if (_lines.Count > 0)
            {
                _lines.RemoveAt(_lines.Count - 1);
                Session.Sound.Play(SoundId.Remove);
            }
        }

        public override void ClearMarkers()
        {
            _lines.Clear();
            _hasStart = false;
            _hasLive = false;
        }

        /// <summary>
        /// Applies normal snapping to a candidate end point.
        /// </summary>
        private Vector3 Snap(Vector3 point)
        {
            if (!_normalSnap) { return point; }
            return _start + _startNormal * Vector3.Dot(point - _start, _startNormal);
        }

        public override void DrawWorld(Overlay3D overlay, bool selected)
        {
            uint committed = Rgba.WithAlpha(UiTheme.MEASURE, selected ? 0.95f : 0.6f);
            foreach (Segment line in _lines)
            {
                overlay.Line(line.A, line.B, 3f, committed);
                overlay.Dot(line.A, 4.5f, committed);
                overlay.Dot(line.B, 4.5f, committed);
            }

            if (_hasStart)
            {
                overlay.Dot(_start, 6f, UiTheme.MEASURE);
                if (_hasLive)
                {
                    overlay.Line(_start, _liveEnd, 3f, UiTheme.MEASURE);
                    overlay.Dot(_liveEnd, 6f, UiTheme.MEASURE);
                }
            }
        }

        public override void DrawLabels(UiBatch ui, bool selected)
        {
            FontAtlas f = ui.Atlas;
            foreach (Segment line in _lines)
            {
                Label(ui, f.Mono, line.A, line.B, Rgba.WithAlpha(UiTheme.MEASURE_TEXT, selected ? 1f : 0.7f), false);
            }
            if (_hasStart && _hasLive)
            {
                Label(ui, f.Bold, _start, _liveEnd, UiTheme.MEASURE_TEXT, true);
            }
        }

        private void Label(UiBatch ui, UiFont font, Vector3 a, Vector3 b, uint colour, bool live)
        {
            if (!Session.Camera.WorldToScreen((a + b) * 0.5f, out Vector2 screen)) { return; }
            TextBuffer text = Session.Text.Clear().Append(Vector3.Distance(a, b), 3).Append(" m");
            float width = UiBatch.Measure(font, text.Span) + S(16);
            float height = font.LineHeight + S(6);
            float x = screen.X - width * 0.5f, y = screen.Y - height - S(6);
            if (live)
            {
                ui.Panel(x, y, width, height, Rgba.Hex(0x0C0E12, 0.85f), UiTheme.MEASURE);
            }
            else
            {
                ui.Rect(x, y, width, height, Rgba.Hex(0x0C0E12, 0.7f));
            }
            ui.Text(font, x + S(8), y + S(3), text.Span, colour);
        }

        public override void DrawPanel(UiBatch ui, float x, float y, float width)
        {
            FontAtlas f = ui.Atlas;
            ui.Text(f.Small, x, y, _hasLive ? "MEASURE · LIVE" : "MEASURE · LAST", UiTheme.MEASURE_LABEL, S(1.1f));
            y += S(20);

            bool any = _hasLive || _lines.Count > 0;
            Vector3 a = _hasLive ? _start : _lines.Count > 0 ? _lines[^1].A : Vector3.Zero;
            Vector3 b = _hasLive ? _liveEnd : _lines.Count > 0 ? _lines[^1].B : Vector3.Zero;
            Vector3 d = b - a;

            if (any) { Session.Text.Clear().Append(d.Length(), 3).Append(" m"); }
            else { Session.Text.Clear().Append("—"); }
            ui.Text(f.MonoLarge, x, y, Session.Text.Span, UiTheme.TEXT);
            y += S(36);

            float column = width / 3f;
            Delta(ui, f, x, y, "ΔX ", d.X, any);
            Delta(ui, f, x + column, y, "ΔY ", d.Y, any);
            Delta(ui, f, x + column * 2f, y, "ΔZ ", d.Z, any);
            y += S(22);

            ui.Text(f.Body, x, y, "Committed lines", UiTheme.TEXT_MUTED);
            Session.Text.Clear().Append(_lines.Count);
            ui.TextRight(f.Body, x + width, y, Session.Text.Span, UiTheme.TEXT);
            y += S(19);
            ui.Text(f.Body, x, y, "Normal projection (N)", UiTheme.TEXT_MUTED);
            ui.TextRight(f.Body, x + width, y, _normalSnap ? "ON" : "OFF", UiTheme.MEASURE_LABEL);
        }

        private void Delta(UiBatch ui, FontAtlas f, float x, float y, string label, float value, bool any)
        {
            float w = ui.Text(f.Mono, x, y, label, UiTheme.TEXT_MUTED);
            if (any) { Session.Text.Clear().Append(MathF.Abs(value), 3); } else { Session.Text.Clear().Append("—"); }
            ui.Text(f.Mono, x + w, y, Session.Text.Span, UiTheme.TEXT);
        }
    }
}
