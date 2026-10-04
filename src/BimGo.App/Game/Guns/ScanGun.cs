using System.Numerics;
using BimGo.Audio;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Guns namespace
namespace BimGo.Game.Guns
{
    /// <summary>
    /// Gun 1: highlights the element under the crosshair; LMB locks it and shows its details, RMB clears.
    /// Extra parameters picked at extraction (Options → Extra parameters) are listed under the standard rows.
    /// In a live session, R selects and shows the target (locked, else hovered) in Revit.
    /// </summary>
    internal sealed class ScanGun : Gun
    {
        private int _hover = -1, _hoverDynamic;
        private int _locked = -1, _lockedDynamic;
        private Vector3 _lockPoint;

        public ScanGun(GameSession session) : base(session) { }

        public override string Name => "SCAN";
        public override string HintPrimary => "Lock target";
        public override string HintSecondary => "Clear";
        public override uint Colour => UiTheme.SCAN;

        public override void DrawIcon(UiBatch ui, float cx, float cy, float size, uint colour) => GunIcons.Scan(ui, cx, cy, size, colour);

        /// <summary>Most extra parameter rows shown (the panel grows to fit, up to this).</summary>
        private const int MAX_PARAMETER_ROWS = 8;

        /// <summary>"Existing (phase)" for the panel, built once.</summary>
        private string _existingLabel;

        public override float PanelHeight => 169f + 19f * Math.Min(Session.Scene.Parameters.CountFor(Target), MAX_PARAMETER_ROWS);

        /// <summary>The element shown in the panel (locked, else hovered), or -1.</summary>
        private int Target => _locked >= 0 ? _locked : _hover;

        public override int HighlightElement => _locked >= 0 ? _locked : _hover;
        public override int HighlightDynamic => _locked >= 0 ? _lockedDynamic : _hoverDynamic;
        public override float HighlightStrength => _locked >= 0 ? 0.42f : 0.22f;

        public override void Update(float dt, in AimInfo aim)
        {
            _hover = aim.HasHit ? aim.Hit.Element : -1;
            _hoverDynamic = aim.HasHit ? aim.Hit.DynamicId : 0;

            // Drop a lock whose target was demolished / deleted
            if (_locked >= 0 && !Session.IsTargetPresent(_locked, _lockedDynamic)) { _locked = -1; _lockedDynamic = 0; }
        }

        public override void OnKeys(Platform.InputState input)
        {
            if (input.IsPressed('R') && Target >= 0)
            {
                Session.ShowInRevit(Target, _locked >= 0 ? _lockedDynamic : _hoverDynamic);
            }
        }

        public override void OnDeselect()
        {
            _hover = -1;
            _hoverDynamic = 0;
        }

        public override void OnPrimary(in AimInfo aim)
        {
            if (!aim.HasHit) { return; }
            _locked = aim.Hit.Element;
            _lockedDynamic = aim.Hit.DynamicId;
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
            if (Session.IsLiveConnected) { ui.TextRight(f.Small, x + width, y, "R  REVIT", UiTheme.TEXT_MUTED, S(1f)); }
            y += S(20);

            if (target < 0)
            {
                ui.Text(f.Body, x, y, "Aim at an element. LMB locks it.", UiTheme.TEXT_MUTED);
                return;
            }

            ElementRecord record = Session.Scene.Elements[target];
            Physics.DynamicInstance instance = Session.Dynamics.Find(_locked >= 0 ? _lockedDynamic : _hoverDynamic);
            ui.TextWrapped(f.Bold, x, y, width, record.Name, UiTheme.TEXT, maxLines: 1);
            y += S(24);

            float labelWidth = S(84);
            Row(ui, f, x, ref y, labelWidth, "Category", record.CategoryName);
            Row(ui, f, x, ref y, labelWidth, "Family", record.FamilyType);
            if (instance == null) { Session.Text.Clear().Append(record.ElementId); }
            else if (instance.RevitId > 0) { Session.Text.Clear().Append(instance.RevitId).Append(instance.IsClone ? " (clone)" : " (moved)"); }
            else if (!instance.Committed) { Session.Text.Clear().Append("clone (not committed)"); }
            else if (Session.EditsGoToRevit) { Session.Text.Clear().Append("creating in Revit…"); }
            else { Session.Text.Clear().Append("clone #").Append(instance.CloneKey); }
            ui.Text(f.Body, x, y, "Element ID", UiTheme.TEXT_MUTED);
            ui.Text(f.Mono, x + labelWidth, y + S(1), Session.Text.Span, UiTheme.TEXT);
            y += S(19);
            Row(ui, f, x, ref y, labelWidth, "Level", record.LevelName);
            string group = CategoryCatalog.GROUP_NAMES[(int)CategoryCatalog.All[record.CategoryIndex].Group];
            Row(ui, f, x, ref y, labelWidth, "Group", record.IsProxy ? group + " (proxy)" : group);
            Row(ui, f, x, ref y, labelWidth, "Phase", instance != null && instance.IsClone ? "New work (clone)" : PhaseText(record.Phase));

            // Extra parameters (if any were extracted)
            ParameterTable parameters = Session.Scene.Parameters;
            int count = Math.Min(parameters.CountFor(target), MAX_PARAMETER_ROWS);
            for (int i = 0; i < count; i++)
            {
                if (parameters.TryGet(target, i, out string name, out string value))
                {
                    ui.TextWrapped(f.Body, x, y, labelWidth - S(6), name, UiTheme.TEXT_MUTED, maxLines: 1);
                    ui.TextWrapped(f.Body, x + labelWidth, y, width - labelWidth, string.IsNullOrEmpty(value) ? "—" : value, UiTheme.TEXT, maxLines: 1);
                    y += S(19);
                }
            }

            string PhaseText(PhaseRole role) => role switch
            {
                PhaseRole.New => "New work",
                PhaseRole.Between => "Built between phases",
                PhaseRole.Unphased => "Not phased",
                _ => _existingLabel ??= Session.Scene.ExistingPhaseName == null ? "Existing" : "Existing (" + Session.Scene.ExistingPhaseName + ")"
            };

            void Row(UiBatch u, FontAtlas fonts, float rx, ref float ry, float lw, string label, string value)
            {
                u.Text(fonts.Body, rx, ry, label, UiTheme.TEXT_MUTED);
                u.TextWrapped(fonts.Body, rx + lw, ry, width - lw, value ?? "—", UiTheme.TEXT, maxLines: 1);
                ry += S(19);
            }
        }
    }
}
