using System.Numerics;
using RvtGo.Audio;
using RvtGo.Rendering;
using RvtGo.Scene;

// The class belongs to the Guns namespace
namespace RvtGo.Game.Guns
{
    /// <summary>
    /// Gun 1: highlights the element under the crosshair; LMB locks it and shows its details, RMB clears.
    /// </summary>
    internal sealed class ScanGun : Gun
    {
        private int _hover = -1;
        private int _locked = -1;
        private Vector3 _lockPoint;

        public ScanGun(GameSession session) : base(session) { }

        public override string Name => "SCAN";
        public override string Key => "1";
        public override string HintPrimary => "Lock target";
        public override string HintSecondary => "Clear";
        public override uint Colour => UiTheme.SCAN;
        public override float PanelHeight => 150f;

        public override int HighlightElement => _locked >= 0 ? _locked : _hover;
        public override float HighlightStrength => _locked >= 0 ? 0.42f : 0.22f;

        public override void Update(float dt, in AimInfo aim)
        {
            _hover = aim.HasHit ? aim.Hit.Element : -1;
        }

        public override void OnDeselect()
        {
            _hover = -1;
        }

        public override void OnPrimary(in AimInfo aim)
        {
            if (!aim.HasHit) { return; }
            _locked = aim.Hit.Element;
            _lockPoint = aim.Hit.Point;
            Session.Sound.Play(SoundId.ScanLock);
        }

        public override void OnSecondary(in AimInfo aim)
        {
            if (_locked >= 0) { Session.Sound.Play(SoundId.UiClick); }
            _locked = -1;
        }

        public override void ClearMarkers()
        {
            _locked = -1;
        }

        public override void DrawLabels(UiBatch ui, bool selected)
        {
            if (!selected || _locked < 0) { return; }
            if (!Session.Camera.WorldToScreen(_lockPoint, out Vector2 screen)) { return; }

            ElementRecord record = Session.Scene.Elements[_locked];
            TextBuffer text = Session.Text.Clear().Append(record.CategoryName).Append(" · ").Append(record.Name);
            UiFont font = ui.Atlas.Small;
            float width = UiBatch.Measure(font, text.Span, S(0.3f)) + S(16);
            float x = screen.X + S(18), y = screen.Y - S(12);
            ui.Rect(x, y, width, S(22), UiTheme.SCAN);
            ui.Text(font, x + S(8), y + S(4), text.Span, UiTheme.SCAN_TAG_TEXT, S(0.3f));
            ui.Line(screen.X, screen.Y, x, y + S(11), S(1.5f), UiTheme.SCAN);
            ui.Circle(screen.X, screen.Y, S(3.5f), UiTheme.SCAN);
        }

        public override void DrawPanel(UiBatch ui, float x, float y, float width)
        {
            FontAtlas f = ui.Atlas;
            int target = _locked >= 0 ? _locked : _hover;

            ui.Text(f.Small, x, y, _locked >= 0 ? "SCAN · TARGET" : "SCAN · HOVER", UiTheme.SCAN_LABEL, S(1.1f));
            y += S(20);

            if (target < 0)
            {
                ui.Text(f.Body, x, y, "Aim at an element. LMB locks it.", UiTheme.TEXT_MUTED);
                return;
            }

            ElementRecord record = Session.Scene.Elements[target];
            ui.TextWrapped(f.Bold, x, y, width, record.Name, UiTheme.TEXT, maxLines: 1);
            y += S(24);

            float labelWidth = S(84);
            Row(ui, f, x, ref y, labelWidth, "Category", record.CategoryName);
            Row(ui, f, x, ref y, labelWidth, "Family", record.FamilyType);
            Session.Text.Clear().Append(record.ElementId);
            ui.Text(f.Body, x, y, "Element ID", UiTheme.TEXT_MUTED);
            ui.Text(f.Mono, x + labelWidth, y + S(1), Session.Text.Span, UiTheme.TEXT);
            y += S(19);
            Row(ui, f, x, ref y, labelWidth, "Level", record.LevelName);
            string group = CategoryCatalog.GROUP_NAMES[(int)CategoryCatalog.All[record.CategoryIndex].Group];
            Row(ui, f, x, ref y, labelWidth, "Group", record.IsProxy ? group + " (proxy)" : group);

            void Row(UiBatch u, FontAtlas fonts, float rx, ref float ry, float lw, string label, string value)
            {
                u.Text(fonts.Body, rx, ry, label, UiTheme.TEXT_MUTED);
                u.TextWrapped(fonts.Body, rx + lw, ry, width - lw, value ?? "—", UiTheme.TEXT, maxLines: 1);
                ry += S(19);
            }
        }
    }
}
