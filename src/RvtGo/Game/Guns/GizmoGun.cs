using System.Numerics;
using RvtGo.Audio;
using RvtGo.Bridge;
using RvtGo.Physics;
using RvtGo.Rendering;
using RvtGo.Scene;

// The class belongs to the Guns namespace
namespace RvtGo.Game.Guns
{
    /// <summary>
    /// Gun 7: move / rotate loadable family instances (FFE). LMB on an eligible element locks the gizmo on:
    /// WASD move it relative to the view, Q / E rotate it CCW / CW, Shift for fine control, Ctrl to snap.
    /// RMB commits (the same move and rotation are applied in Revit); Esc cancels.
    /// </summary>
    internal sealed class GizmoGun : Gun
    {
        private readonly GizmoController _gizmo;
        private int _hover = -1, _hoverDynamic;

        public GizmoGun(GameSession session) : base(session)
        {
            _gizmo = new GizmoController(session);
        }

        public override string Name => "GIZMO";
        public override string HintPrimary => _gizmo.Active ? "Esc cancel" : "Lock on (FFE)";
        public override string HintSecondary => _gizmo.Active ? "Commit to Revit" : "—";
        public override uint Colour => UiTheme.GIZMO;
        public override float PanelHeight => 118f;
        public override bool CapturesInput => _gizmo.Active;

        public override void DrawIcon(UiBatch ui, float cx, float cy, float size, uint colour) => GunIcons.Gizmo(ui, cx, cy, size, colour);

        public override void ClearMarkers() { }

        public override void OnDeselect()
        {
            _hover = -1;
            _hoverDynamic = 0;
        }

        #region Input

        public override void Update(float dt, in AimInfo aim)
        {
            if (_gizmo.Active)
            {
                _gizmo.Update(dt, Session.Input);
                return;
            }
            _hover = aim.HasHit ? aim.Hit.Element : -1;
            _hoverDynamic = aim.HasHit ? aim.Hit.DynamicId : 0;
        }

        public override void OnPrimary(in AimInfo aim)
        {
            if (_gizmo.Active) { return; }
            if (!aim.HasHit)
            {
                Session.Sound.Play(SoundId.Error);
                return;
            }

            ElementRecord record = Session.Scene.Elements[aim.Hit.Element];
            if (!record.Movable)
            {
                Session.Sound.Play(SoundId.Error);
                Session.Toast($"Can't move {record.Name}: {record.MoveBlockReason}");
                return;
            }

            DynamicInstance instance = aim.Hit.DynamicId > 0 ? Session.Dynamics.Find(aim.Hit.DynamicId) : Session.MakeDynamic(aim.Hit.Element);
            if (instance == null) { return; }

            _gizmo.Begin(instance);
            Session.Sound.Play(SoundId.Grab);
        }

        public override void OnSecondary(in AimInfo aim)
        {
            if (_gizmo.Active) { Commit(); }
        }

        public override void OnCancel()
        {
            DynamicInstance released = _gizmo.Cancel();
            Session.RestoreIfUnmoved(released);
            Session.Sound.Play(SoundId.UiClick);
            Session.Toast("Move cancelled");
        }

        #endregion

        #region Commit

        /// <summary>
        /// Keeps the new transform and applies the same change to the element in Revit.
        /// </summary>
        private void Commit()
        {
            DynamicInstance instance = _gizmo.Target;
            if (!_gizmo.HasChanges)
            {
                _gizmo.End();
                Session.RestoreIfUnmoved(instance);
                Session.Toast("Nothing moved");
                return;
            }

            Vector3 delta = _gizmo.DeltaOffset;
            float angle = _gizmo.DeltaAngle;
            Vector3 startPivot = _gizmo.StartPivot;
            ElementRecord record = Session.Scene.Elements[instance.Element];
            _gizmo.End();

            Session.Sound.Play(SoundId.Commit);
            var request = new BridgeRequest
            {
                Op = BridgeOp.Transform,
                ElementId = instance.RevitId,
                TargetCloneKey = instance.RevitId <= 0 ? instance.CloneKey : 0,
                Pivot = Session.ToRevit(startPivot),
                Translation = delta,
                Angle = angle,
                Label = "Move " + record.Name
            };

            bool sent = Session.SubmitToRevit(request, result =>
            {
                if (result.Success)
                {
                    Session.Toast($"Moved in Revit: {record.Name}");
                    return;
                }

                // Refused: undo this move in the game (later moves, if any, stay relative)
                Session.Dynamics.SetTransform(instance, instance.Offset - delta, instance.Angle - angle);
                Session.RestoreIfUnmoved(instance);
                Session.Sound.Play(SoundId.Error);
                Session.Toast($"Revit refused the move ({result.Message}). Restored.", 4f);
            });

            if (!sent) { Session.Toast($"{record.Name} moved in the walkthrough only (no Revit link)"); }
        }

        #endregion

        #region Drawing

        public override void CollectHighlights(List<Highlight> highlights)
        {
            if (_gizmo.Active)
            {
                highlights.Add(new Highlight(_gizmo.Target.Element, _gizmo.Target.Id, UiTheme.GIZMO, 0.3f));
                return;
            }
            if (_hover < 0) { return; }
            bool movable = Session.Scene.Elements[_hover].Movable;
            highlights.Add(new Highlight(_hover, _hoverDynamic, movable ? UiTheme.GIZMO : UiTheme.TEXT_FAINT, movable ? 0.25f : 0.12f));
        }

        public override void DrawWorld(Overlay3D overlay, bool selected)
        {
            if (selected) { _gizmo.Draw(overlay, UiTheme.GIZMO); }
        }

        public override void DrawPanel(UiBatch ui, float x, float y, float width) =>
            GizmoPanel.Draw(ui, Session, _gizmo, "GIZMO", UiTheme.GIZMO_LABEL, _hover, x, y, width, Session.UiScale);

        #endregion
    }

    /// <summary>
    /// The context panel shared by the Gizmo and Clone guns.
    /// </summary>
    internal static class GizmoPanel
    {
        /// <summary>
        /// Draws the panel: locked state and controls, or the hovered element's eligibility.
        /// </summary>
        public static void Draw(UiBatch ui, GameSession session, GizmoController gizmo, string title, uint titleColour, int hover,
            float x, float y, float width, float scale)
        {
            float s(float value) => value * scale;
            FontAtlas f = ui.Atlas;
            float used = ui.Text(f.Small, x, y, title, titleColour, s(1.1f));
            if (gizmo.Active) { ui.Text(f.Small, x + used, y, " · LOCKED", titleColour, s(1.1f)); }
            y += s(20);

            if (gizmo.Active)
            {
                ElementRecord record = session.Scene.Elements[gizmo.Target.Element];
                ui.TextWrapped(f.Bold, x, y, width, record.Name, UiTheme.TEXT, maxLines: 1);
                y += s(22);
                TextBuffer delta = session.Text.Clear();
                gizmo.DescribeDelta(delta);
                ui.Text(f.Mono, x, y, delta.Span, UiTheme.TEXT);
                y += s(20);
                ui.Text(f.Body, x, y, "WASD move · Q/E rotate", UiTheme.TEXT_SOFT);
                y += s(18);
                ui.Text(f.Body, x, y, "Shift fine · Ctrl snap 50 mm / 15°", UiTheme.TEXT_MUTED);
                y += s(18);
                ui.Text(f.Body, x, y, "RMB commit · Esc cancel", UiTheme.TEXT_MUTED);
                return;
            }

            if (hover < 0)
            {
                ui.Text(f.Body, x, y, "Aim at furniture / fittings.", UiTheme.TEXT_MUTED);
                y += s(19);
                ui.Text(f.Body, x, y, "Loadable families only.", UiTheme.TEXT_MUTED);
                return;
            }

            ElementRecord hovered = session.Scene.Elements[hover];
            ui.TextWrapped(f.Bold, x, y, width, hovered.Name, UiTheme.TEXT, maxLines: 1);
            y += s(22);
            ui.TextWrapped(f.Body, x, y, width, hovered.FamilyType, UiTheme.TEXT_SOFT, maxLines: 1);
            y += s(20);
            if (hovered.Movable) { ui.Text(f.Body, x, y, "Eligible: LMB to lock on", UiTheme.GOOD); }
            else
            {
                TextBuffer reason = session.Text.Clear().Append("Not eligible: ").Append(hovered.MoveBlockReason);
                ui.TextWrapped(f.Body, x, y, width, reason.Span, UiTheme.DANGER, maxLines: 1);
            }
            y += s(20);
            if (!session.RevitLinked) { ui.Text(f.Body, x, y, "No Revit link: in-game only", UiTheme.DANGER); }
        }
    }
}
