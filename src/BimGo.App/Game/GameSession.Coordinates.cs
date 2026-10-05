using System.Numerics;
using BimGo.Audio;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// The coordinate readout (L cycles Off → Shared → Project → Internal): the crosshair's hit point, or the player's
    /// feet when aiming at nothing, as easting / northing / elevation. Shared coordinates come from the model's survey
    /// setup (<see cref="SiteCoordinates"/>); project coordinates are relative to the project base point.
    /// All maths is double precision; nothing allocates per frame.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private CoordinateReadout _coordinateReadout;
        private bool _hasShared;
        private SiteCoordinates.SharedTransform _shared;
        private bool _hasProjectBase;
        private double _baseX, _baseY, _baseZ;

        #endregion

        #region Setup and switching

        /// <summary>
        /// Resolves the site transforms once and restores the remembered readout (if this model supports it).
        /// </summary>
        private void InitialiseCoordinates(CoordinateReadout remembered)
        {
            _hasShared = SiteCoordinates.TryGetShared(Scene.Site, out _shared);
            _hasProjectBase = SiteCoordinates.TryGetProjectBase(Scene.Site, out _baseX, out _baseY, out _baseZ);
            _coordinateReadout = IsReadoutAvailable(remembered) ? remembered : CoordinateReadout.Off;
        }

        /// <summary>
        /// L: the next readout this model can show.
        /// </summary>
        private void CycleCoordinateReadout()
        {
            CoordinateReadout next = _coordinateReadout;
            for (int i = 0; i < 4; i++)
            {
                next = (CoordinateReadout)(((int)next + 1) % 4);
                if (IsReadoutAvailable(next)) { break; }
            }
            _coordinateReadout = next;
            Sound.Play(SoundId.UiClick);

            string message = next switch
            {
                CoordinateReadout.Shared => _shared.Approximate
                    ? "Coordinates: shared (approximate: export again from Revit for millimetre accuracy)"
                    : "Coordinates: shared (survey)",
                CoordinateReadout.Project => "Coordinates: project (from the project base point)",
                CoordinateReadout.Internal => "Coordinates: Revit internal",
                _ => "Coordinates off"
            };
            Toast(message, 3f);
        }

        private bool IsReadoutAvailable(CoordinateReadout readout) => readout switch
        {
            CoordinateReadout.Shared => _hasShared,
            CoordinateReadout.Project => _hasProjectBase,
            _ => true
        };

        #endregion

        #region HUD

        /// <summary>
        /// Draws the readout panel below the status panel (top left).
        /// </summary>
        private void BuildCoordinatePanel(FontAtlas f, float x, float y)
        {
            if (_coordinateReadout == CoordinateReadout.Off) { return; }

            float w = S(250), h = S(100);
            _ui.Panel(x, y, w, h, UiTheme.PANEL, UiTheme.PANEL_BORDER);

            string title = _coordinateReadout switch
            {
                CoordinateReadout.Shared => _shared.Approximate ? "SHARED COORDINATES ≈" : "SHARED COORDINATES",
                CoordinateReadout.Project => "PROJECT COORDINATES",
                _ => "INTERNAL COORDINATES"
            };
            _ui.Text(f.Small, x + S(14), y + S(10), title, UiTheme.TEXT_MUTED, S(1f));
            _ui.TextRight(f.Small, x + w - S(14), y + S(10), _aim.HasHit ? "AIM · L" : "FEET · L", UiTheme.TEXT_FAINT, S(1f));

            // The crosshair's hit, else where the player stands (scene-local → internal, in double)
            Vector3 local = _aim.HasHit ? _aim.Hit.Point : _player.Feet;
            Vector3 origin = Scene.OriginOffset;
            double ix = (double)local.X + origin.X, iy = (double)local.Y + origin.Y, iz = (double)local.Z + origin.Z;

            double a, b, c;
            switch (_coordinateReadout)
            {
                case CoordinateReadout.Shared:
                    _shared.Apply(ix, iy, iz, out a, out b, out c);
                    break;
                case CoordinateReadout.Project:
                    a = ix - _baseX;
                    b = iy - _baseY;
                    c = iz - _baseZ;
                    break;
                default:
                    a = ix;
                    b = iy;
                    c = iz;
                    break;
            }

            float labelX = x + S(14), valueX = x + w - S(14);
            float rowY = y + S(32), row = S(20);
            bool grid = _coordinateReadout == CoordinateReadout.Shared;
            CoordinateRow(f, labelX, valueX, rowY, grid ? "E" : "X", a);
            CoordinateRow(f, labelX, valueX, rowY + row, grid ? "N" : "Y", b);
            CoordinateRow(f, labelX, valueX, rowY + row * 2f, grid ? "ELEV" : "Z", c);
        }

        private void CoordinateRow(FontAtlas f, float labelX, float valueRight, float y, string label, double value)
        {
            _ui.Text(f.Body, labelX, y, label, UiTheme.TEXT_MUTED);
            Text.Clear().Append(value, 3).Append(" m");
            _ui.TextRight(f.Mono, valueRight, y + S(1), Text.Span, UiTheme.COORDS);
        }

        #endregion
    }
}
