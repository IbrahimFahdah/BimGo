using System.Numerics;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Which coordinates the walkthrough's readout (L) shows.
    /// </summary>
    public enum CoordinateReadout
    {
        /// <summary>No readout.</summary>
        Off = 0,

        /// <summary>Shared (survey) coordinates: easting, northing, elevation, as Revit's survey-point spot coordinates.</summary>
        Shared = 1,

        /// <summary>Relative to the project base point, project-north axes.</summary>
        Project = 2,

        /// <summary>Revit's internal coordinates (metres).</summary>
        Internal = 3
    }

    /// <summary>
    /// Converts Revit internal coordinates (metres) to shared and project coordinates using a model's
    /// <see cref="SiteInfo"/>. Everything is double precision: shared coordinates are often grid coordinates in the
    /// hundreds of kilometres, where a float is only good to about half a metre.
    ///
    /// Shared = Rz(angle) · internal + origin, where origin is the shared position of the internal origin. Files from
    /// v5.1 on carry that transform (<see cref="SiteInfo.HasSharedTransform"/>); older files derive it from the survey
    /// point and the true-north angle.
    /// </summary>
    public static class SiteCoordinates
    {
        /// <summary>
        /// A resolved internal → shared transform.
        /// </summary>
        public readonly struct SharedTransform
        {
            public SharedTransform(double east, double north, double elevation, double angle, bool approximate)
            {
                East = east;
                North = north;
                Elevation = elevation;
                Angle = angle;
                Cos = Math.Cos(angle);
                Sin = Math.Sin(angle);
                Approximate = approximate;
            }

            /// <summary>Shared position of the internal origin (metres).</summary>
            public double East { get; }
            public double North { get; }
            public double Elevation { get; }

            /// <summary>Rotation internal → shared (radians, counter-clockwise).</summary>
            public double Angle { get; }
            public double Cos { get; }
            public double Sin { get; }

            /// <summary>True when derived from float reference points (older files): sub-metre error is possible.</summary>
            public bool Approximate { get; }

            /// <summary>
            /// An internal point (metres) in shared coordinates.
            /// </summary>
            public void Apply(double x, double y, double z, out double east, out double north, out double elevation)
            {
                east = x * Cos - y * Sin + East;
                north = x * Sin + y * Cos + North;
                elevation = z + Elevation;
            }
        }

        /// <summary>
        /// The internal → shared transform for a site, or false if the site has neither a captured transform nor a
        /// survey / base point to derive one from.
        /// </summary>
        public static bool TryGetShared(SiteInfo site, out SharedTransform transform)
        {
            transform = default;
            if (site == null) { return false; }

            if (site.HasSharedTransform)
            {
                transform = new SharedTransform(site.SharedEast, site.SharedNorth, site.SharedElevation, site.SharedAngle, approximate: false);
                return true;
            }

            // Older files: anchor on the survey point (else the project base point), rotation from true north
            SitePoint anchor = site.SurveyPoint ?? site.ProjectBasePoint;
            if (anchor == null) { return false; }

            double angle = ChooseAngleSign(site, site.TrueNorthAngle);
            Vector3 p = anchor.Position, s = anchor.SharedPosition;
            double cos = Math.Cos(angle), sin = Math.Sin(angle);
            double east = s.X - (p.X * cos - p.Y * sin);
            double north = s.Y - (p.X * sin + p.Y * cos);
            double elevation = s.Z - p.Z;
            transform = new SharedTransform(east, north, elevation, angle, approximate: true);
            return true;
        }

        /// <summary>
        /// The project base point's internal position (metres), or false if the site has none.
        /// Project coordinates are internal − base point, on project-north axes.
        /// </summary>
        public static bool TryGetProjectBase(SiteInfo site, out double x, out double y, out double z)
        {
            x = y = z = 0;
            if (site?.ProjectBasePoint == null) { return false; }
            Vector3 p = site.ProjectBasePoint.Position;
            x = p.X;
            y = p.Y;
            z = p.Z;
            return true;
        }

        /// <summary>
        /// Picks +angle or −angle, whichever maps the internal offset between the survey point and the project base
        /// point onto their shared offset (Revit's angle sign conventions differ between APIs). Returns
        /// <paramref name="angle"/> unchanged when the two points are too close together to tell.
        /// </summary>
        public static double ChooseAngleSign(SiteInfo site, double angle)
        {
            if (site?.SurveyPoint == null || site.ProjectBasePoint == null || Math.Abs(angle) < 1e-9) { return angle; }

            Vector3 internalDelta = site.ProjectBasePoint.Position - site.SurveyPoint.Position;
            Vector3 sharedDelta = site.ProjectBasePoint.SharedPosition - site.SurveyPoint.SharedPosition;
            double length = Math.Sqrt((double)internalDelta.X * internalDelta.X + (double)internalDelta.Y * internalDelta.Y);
            if (length < 2.0) { return angle; }

            // The two candidates must land clearly apart (> 1 m) for the test to beat float noise on grid coordinates
            if (length * 2.0 * Math.Abs(Math.Sin(angle)) < 1.0) { return angle; }
            double plus = Misfit(internalDelta, sharedDelta, angle);
            double minus = Misfit(internalDelta, sharedDelta, -angle);
            return minus < plus ? -angle : angle;
        }

        /// <summary>
        /// Checks a captured transform against the reference points and flips the angle if the other sign fits them
        /// better (the Revit side calls this once after filling <see cref="SiteInfo.SharedAngle"/>).
        /// </summary>
        /// <returns>True if the angle was flipped.</returns>
        public static bool VerifySharedAngle(SiteInfo site)
        {
            if (site == null || !site.HasSharedTransform || Math.Abs(site.SharedAngle) < 1e-9) { return false; }

            // Prefer the full transform test on a reference point away from the internal origin
            SitePoint anchor = Far(site.SurveyPoint) ? site.SurveyPoint : Far(site.ProjectBasePoint) ? site.ProjectBasePoint : null;
            double chosen;
            if (anchor != null)
            {
                // The candidates are 2·r·|sin θ| apart; below 1 m float noise could decide, so keep the captured sign
                double radius = new Vector2(anchor.Position.X, anchor.Position.Y).Length();
                if (radius * 2.0 * Math.Abs(Math.Sin(site.SharedAngle)) < 1.0) { return false; }
                double plus = AnchorMisfit(site, anchor, site.SharedAngle);
                double minus = AnchorMisfit(site, anchor, -site.SharedAngle);
                chosen = minus < plus ? -site.SharedAngle : site.SharedAngle;
            }
            else
            {
                chosen = ChooseAngleSign(site, site.SharedAngle);
            }

            if (chosen == site.SharedAngle) { return false; }
            site.SharedAngle = chosen;
            return true;

            static bool Far(SitePoint point) => point != null && new Vector2(point.Position.X, point.Position.Y).Length() > 2f;
        }

        private static double Misfit(Vector3 internalDelta, Vector3 sharedDelta, double angle)
        {
            double cos = Math.Cos(angle), sin = Math.Sin(angle);
            double x = internalDelta.X * cos - internalDelta.Y * sin;
            double y = internalDelta.X * sin + internalDelta.Y * cos;
            return Math.Abs(x - sharedDelta.X) + Math.Abs(y - sharedDelta.Y);
        }

        private static double AnchorMisfit(SiteInfo site, SitePoint anchor, double angle)
        {
            var transform = new SharedTransform(site.SharedEast, site.SharedNorth, site.SharedElevation, angle, approximate: false);
            transform.Apply(anchor.Position.X, anchor.Position.Y, anchor.Position.Z, out double east, out double north, out _);
            return Math.Abs(east - anchor.SharedPosition.X) + Math.Abs(north - anchor.SharedPosition.Y);
        }
    }
}
