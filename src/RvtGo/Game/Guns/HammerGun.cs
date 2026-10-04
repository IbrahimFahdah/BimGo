using System.Numerics;
using RvtGo.Audio;
using RvtGo.Bridge;
using RvtGo.Physics;
using RvtGo.Platform;
using RvtGo.Rendering;
using RvtGo.Scene;

// The class belongs to the Guns namespace
namespace RvtGo.Game.Guns
{
    /// <summary>
    /// Gun 6: the demolition hammer. LMB primes the element under the crosshair; LMB on a primed element
    /// demolishes it in the game and in Revit. By default it sets Phase Demolished to the session phase;
    /// T toggles to deleting instead. RMB un-primes, X clears all primes.
    ///
    /// Removal is optimistic: the element vanishes at once and comes back if Revit refuses.
    /// </summary>
    internal sealed class HammerGun : Gun
    {
        #region Types and fields

        /// <summary>A primed target.</summary>
        private readonly record struct Target(int Element, int DynamicId);

        private readonly List<Target> _primed = new();
        private Target _hover = new(-1, 0);
        private bool _deleteMode;
        private float _clock;

        #endregion

        public HammerGun(GameSession session) : base(session) { }

        public override string Name => "DEMOLISH";
        public override string HintPrimary => IsPrimed(_hover) ? (_deleteMode ? "Delete" : "Demolish") : "Prime";
        public override string HintSecondary => "Un-prime";
        public override uint Colour => UiTheme.HAMMER;
        public override float PanelHeight => 118f;

        public override void DrawIcon(UiBatch ui, float cx, float cy, float size, uint colour) => GunIcons.Hammer(ui, cx, cy, size, colour);

        public override void Tick(float dt) => _clock += dt;

        public override void OnDeselect() => _hover = new Target(-1, 0);

        public override void ClearMarkers()
        {
            if (_primed.Count > 0) { Session.Toast("Primed elements cleared"); }
            _primed.Clear();
        }

        #region Input

        public override void Update(float dt, in AimInfo aim)
        {
            _hover = aim.HasHit ? new Target(aim.Hit.Element, aim.Hit.DynamicId) : new Target(-1, 0);

            // Forget primes whose element has gone (demolished elsewhere, cloned-and-cancelled…)
            for (int i = _primed.Count - 1; i >= 0; i--)
            {
                if (!Session.IsTargetPresent(_primed[i].Element, _primed[i].DynamicId)) { _primed.RemoveAt(i); }
            }
        }

        public override void OnKeys(InputState input)
        {
            if (input.IsPressed('T'))
            {
                _deleteMode = !_deleteMode;
                Session.Sound.Play(SoundId.UiClick);
                Session.Toast(_deleteMode ? "Hammer: DELETE elements (permanent in Revit)" : $"Hammer: demolish by phase ({PhaseLabel})");
            }
        }

        public override void OnPrimary(in AimInfo aim)
        {
            if (!aim.HasHit)
            {
                Session.Sound.Play(SoundId.Error);
                return;
            }

            var target = new Target(aim.Hit.Element, aim.Hit.DynamicId);
            if (IsPrimed(target))
            {
                _primed.Remove(target);
                Demolish(target);
                return;
            }

            _primed.Add(target);
            Session.Sound.Play(SoundId.Prime);
        }

        public override void OnSecondary(in AimInfo aim)
        {
            if (_primed.Count == 0) { return; }

            // The primed element under the crosshair, else the most recent
            int index = _primed.IndexOf(_hover);
            _primed.RemoveAt(index >= 0 ? index : _primed.Count - 1);
            Session.Sound.Play(SoundId.UiClick);
        }

        private bool IsPrimed(Target target) => target.Element >= 0 && _primed.Contains(target);

        private string PhaseLabel => Session.Scene.PhaseName ?? "no phase";

        #endregion

        #region Demolition

        /// <summary>
        /// Removes the target in the game and asks Revit to demolish / delete it.
        /// </summary>
        private void Demolish(Target target)
        {
            ElementRecord record = Session.Scene.Elements[target.Element];
            DynamicInstance instance = Session.Dynamics.Find(target.DynamicId);
            if (target.DynamicId > 0 && instance == null) { return; }

            // Hide now (optimistic)
            if (instance != null) { instance.Hidden = true; }
            else { Session.SetStaticHidden(target.Element, true); }
            Session.Sound.Play(SoundId.Demolish);
            Session.Flash(UiTheme.HAMMER, 0.1f);

            bool deleting = _deleteMode;
            var request = new BridgeRequest
            {
                Op = deleting ? BridgeOp.Delete : BridgeOp.PhaseDemolish,
                ElementId = instance?.RevitId ?? record.ElementId,
                TargetCloneKey = instance != null && instance.RevitId <= 0 ? instance.CloneKey : 0,
                Label = (deleting ? "Delete " : "Demolish ") + record.Name
            };

            bool sent = Session.SubmitToRevit(request, result => OnRevitResult(result, target, instance, record));
            if (!sent) { Session.Toast($"{record.Name} removed in the walkthrough only (no Revit link)"); }
        }

        /// <summary>
        /// Revit's answer: hide anything else that went with it, or put the element back.
        /// </summary>
        private void OnRevitResult(BridgeResult result, Target target, DynamicInstance instance, ElementRecord record)
        {
            if (result.Success)
            {
                int extra = Math.Max(0, Session.ApplyRevitRemovals(result.AffectedIds));
                string verb = result.Op == BridgeOp.Delete ? "Deleted" : $"Demolished ({PhaseLabel})";
                Session.Toast(extra > 0 ? $"{verb}: {record.Name} + {extra} dependent element{(extra == 1 ? string.Empty : "s")}" : $"{verb} in Revit: {record.Name}");
                return;
            }

            // Refused: restore
            if (instance != null) { instance.Hidden = false; }
            else { Session.SetStaticHidden(target.Element, false); }
            Session.Sound.Play(SoundId.Error);
            Session.Toast($"Revit refused ({result.Message}). {record.Name} restored.", 4f);
        }

        #endregion

        #region Drawing

        public override void CollectHighlights(List<Highlight> highlights)
        {
            float pulse = 0.38f + 0.18f * MathF.Sin(_clock * 7f);
            foreach (Target target in _primed)
            {
                highlights.Add(new Highlight(target.Element, target.DynamicId, UiTheme.HAMMER_PRIMED, pulse));
            }
            if (_hover.Element >= 0 && !IsPrimed(_hover))
            {
                highlights.Add(new Highlight(_hover.Element, _hover.DynamicId, UiTheme.HAMMER, 0.22f));
            }
        }

        public override void DrawWorld(Overlay3D overlay, bool selected)
        {
            // Primed elements keep a red box even when another gun is selected
            uint colour = Rgba.WithAlpha(UiTheme.HAMMER_PRIMED, selected ? 0.95f : 0.45f);
            foreach (Target target in _primed)
            {
                DynamicInstance instance = Session.Dynamics.Find(target.DynamicId);
                Aabb box = instance?.WorldBounds ?? Session.Scene.Elements[target.Element].Bounds;
                DrawBox(overlay, box, colour);
            }
        }

        /// <summary>
        /// A wireframe box, slightly inflated.
        /// </summary>
        private static void DrawBox(Overlay3D overlay, Aabb box, uint colour)
        {
            Vector3 n = box.Min - new Vector3(0.02f), x = box.Max + new Vector3(0.02f);
            Vector3 c000 = new(n.X, n.Y, n.Z), c100 = new(x.X, n.Y, n.Z), c110 = new(x.X, x.Y, n.Z), c010 = new(n.X, x.Y, n.Z);
            Vector3 c001 = new(n.X, n.Y, x.Z), c101 = new(x.X, n.Y, x.Z), c111 = new(x.X, x.Y, x.Z), c011 = new(n.X, x.Y, x.Z);
            overlay.Line(c000, c100, 2f, colour); overlay.Line(c100, c110, 2f, colour); overlay.Line(c110, c010, 2f, colour); overlay.Line(c010, c000, 2f, colour);
            overlay.Line(c001, c101, 2f, colour); overlay.Line(c101, c111, 2f, colour); overlay.Line(c111, c011, 2f, colour); overlay.Line(c011, c001, 2f, colour);
            overlay.Line(c000, c001, 2f, colour); overlay.Line(c100, c101, 2f, colour); overlay.Line(c110, c111, 2f, colour); overlay.Line(c010, c011, 2f, colour);
        }

        public override void DrawPanel(UiBatch ui, float x, float y, float width)
        {
            FontAtlas f = ui.Atlas;
            ui.Text(f.Small, x, y, "DEMOLISH", UiTheme.HAMMER_LABEL, S(1.1f));
            ui.TextRight(f.Small, x + width, y, "T  MODE", UiTheme.TEXT_MUTED, S(1f));
            y += S(20);

            if (_deleteMode)
            {
                ui.Text(f.Bold, x, y, "Delete from model", UiTheme.DANGER);
            }
            else
            {
                TextBuffer mode = Session.Text.Clear().Append("Phase demolish · ").Append(PhaseLabel);
                ui.TextWrapped(f.Bold, x, y, width, mode.Span, UiTheme.TEXT, maxLines: 1);
            }
            y += S(22);

            if (!Session.RevitLinked)
            {
                ui.Text(f.Body, x, y, "No Revit link: in-game only", UiTheme.DANGER);
                y += S(19);
            }

            TextBuffer primed = Session.Text.Clear().Append("Primed: ").Append(_primed.Count);
            ui.Text(f.Body, x, y, primed.Span, _primed.Count > 0 ? UiTheme.HAMMER_PRIMED : UiTheme.TEXT_MUTED);
            y += S(19);

            if (_hover.Element >= 0)
            {
                ElementRecord record = Session.Scene.Elements[_hover.Element];
                ui.TextWrapped(f.Body, x, y, width, record.Name, UiTheme.TEXT_SOFT, maxLines: 1);
            }
            else
            {
                ui.Text(f.Body, x, y, "Aim at an element. LMB primes it.", UiTheme.TEXT_MUTED);
            }
        }

        #endregion
    }
}
