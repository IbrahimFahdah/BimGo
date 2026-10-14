using System.Numerics;
using System.Text.Json.Serialization;

// The class belongs to the Format namespace
namespace BimGo.Format
{
    /// <summary>
    /// One saved viewpoint: where the player stood and which way they looked. Positions are metres in Revit's internal
    /// coordinate system (like comments), so a bookmark stays put across snapshots whose scene origin differs.
    /// Stored in a .bimgo file's bookmarks.json, or (live Revit sessions) in &lt;model&gt;.bimgo-bookmarks.json beside the model.
    /// </summary>
    public sealed class BookmarkRecord
    {
        /// <summary>Stable id (GUID, no dashes).</summary>
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        /// <summary>The name shown in the list and on the map.</summary>
        public string Name { get; set; } = string.Empty;

        /// <summary>Who made it.</summary>
        public string Author { get; set; } = Environment.UserName;

        /// <summary>When it was made.</summary>
        public DateTimeOffset Created { get; set; } = DateTimeOffset.Now;

        /// <summary>Feet position X (Revit internal metres).</summary>
        public double X { get; set; }

        /// <summary>Feet position Y (Revit internal metres).</summary>
        public double Y { get; set; }

        /// <summary>Feet position Z (Revit internal metres).</summary>
        public double Z { get; set; }

        /// <summary>Look direction about +Z (radians, 0 = +X, counter-clockwise).</summary>
        public float Yaw { get; set; }

        /// <summary>Look pitch (radians, positive = up).</summary>
        public float Pitch { get; set; }

        /// <summary>True if the player was flying (no-clip) when it was saved.</summary>
        public bool Flying { get; set; }

        /// <summary>The level name at the time (for the list; informational).</summary>
        public string Level { get; set; } = string.Empty;

        /// <summary>
        /// The sun's date and time when the bookmark was saved with shadows on (GO restores it and turns shadows on),
        /// else null.
        /// </summary>
        public SunTime Sun { get; set; }

        /// <summary>
        /// The section cut when the bookmark was set (section box round): GO restores it; a cut with nothing on
        /// clears the cut; null (older bookmarks) leaves the current cut alone.
        /// </summary>
        public Scene.SectionCut Section { get; set; }

        /// <summary>
        /// What was hidden when the bookmark was set (tour round): hidden categories, links and elements. GO and the
        /// tour restore it (an empty set shows everything); null (older bookmarks) leaves visibility alone. The ground
        /// offset and the section are not kept here (the section has its own field).
        /// </summary>
        public VisibilitySettings Visibility { get; set; }

        /// <summary>
        /// The standing eye height when the bookmark was set (metres, tour round): GO and the tour use it, so a view
        /// saved seated replays seated. Null (older bookmarks) keeps the current eye height.
        /// </summary>
        public float? EyeHeight { get; set; }

        /// <summary>Tour: seconds to hold at this stop, or null for the tour's hold time.</summary>
        public float? TourHold { get; set; }

        /// <summary>
        /// Tour: this stop's swivel in degrees (positive turns left, negative right, 0 none), or null for the tour's
        /// swivel setting.
        /// </summary>
        public float? TourSwivel { get; set; }

        /// <summary>Tour: leave this bookmark out of the tour (it stays in the list).</summary>
        public bool TourSkip { get; set; }

        /// <summary>
        /// A small picture of the view (base64 JPEG, about 192 × 108 px, a few kB) for the bookmark list, or null.
        /// </summary>
        public string Thumbnail { get; set; }

        /// <summary>Scene-local feet position (not serialised).</summary>
        [JsonIgnore]
        public Vector3 Local { get; set; }

        /// <summary>Pre-formatted "Level · author · date" line for lists (not serialised).</summary>
        [JsonIgnore]
        public string Detail { get; set; } = string.Empty;
    }

    /// <summary>
    /// A set of bookmarks (bookmarks.json inside a .bimgo, or the sidecar beside a Revit model). Order is the user's
    /// order: Shift+1..9 (by default) jump to the first nine.
    /// </summary>
    public sealed class BookmarkDocument
    {
        public int Version { get; set; } = 1;
        public string Model { get; set; } = string.Empty;
        public string Units { get; set; } = "metres, Revit internal coordinates; angles in radians";
        public List<BookmarkRecord> Bookmarks { get; set; } = new();

        /// <summary>
        /// The saved home viewpoint (Shift+H / SET HOME HERE): walkthroughs of this model start here and H returns
        /// here. Null until a home is set.
        /// </summary>
        public BookmarkRecord Home { get; set; }

        /// <summary>The bookmark tour's settings (tour round), or null for the defaults. Older readers ignore it.</summary>
        public TourSettings Tour { get; set; }

        /// <summary>True when there is nothing to save (no bookmarks and no home).</summary>
        [JsonIgnore]
        public bool IsEmpty => (Bookmarks?.Count ?? 0) == 0 && Home == null;

        /// <summary>
        /// Drops null and unusable records (no name, non-finite position). Returns the document for chaining.
        /// </summary>
        public BookmarkDocument Clean()
        {
            Bookmarks ??= new List<BookmarkRecord>();
            Bookmarks.RemoveAll(b => b == null || !double.IsFinite(b.X) || !double.IsFinite(b.Y) || !double.IsFinite(b.Z)
                || !float.IsFinite(b.Yaw) || !float.IsFinite(b.Pitch));
            if (Home != null && (!double.IsFinite(Home.X) || !double.IsFinite(Home.Y) || !double.IsFinite(Home.Z)
                || !float.IsFinite(Home.Yaw) || !float.IsFinite(Home.Pitch)))
            {
                Home = null;
            }
            foreach (BookmarkRecord bookmark in Bookmarks)
            {
                if (string.IsNullOrWhiteSpace(bookmark.Name)) { bookmark.Name = "Viewpoint"; }
                bookmark.Id = string.IsNullOrWhiteSpace(bookmark.Id) ? Guid.NewGuid().ToString("N") : bookmark.Id;
                bookmark.Section?.Clean();
                CleanTourFields(bookmark);
            }
            Tour?.Clean();
            return this;
        }

        /// <summary>
        /// Clamps a bookmark's tour-round fields (hand-edited files): visibility without ground or section, eye height,
        /// hold and swivel in range, non-finite values dropped.
        /// </summary>
        private static void CleanTourFields(BookmarkRecord bookmark)
        {
            if (bookmark.Visibility != null)
            {
                bookmark.Visibility.Clean();
                bookmark.Visibility.GroundOffset = null;
                bookmark.Visibility.Section = null;
            }
            if (bookmark.EyeHeight is float eye)
            {
                bookmark.EyeHeight = float.IsFinite(eye) ? Math.Clamp(eye, TourSettings.MIN_EYE_HEIGHT, TourSettings.MAX_EYE_HEIGHT) : null;
            }
            if (bookmark.TourHold is float hold)
            {
                bookmark.TourHold = float.IsFinite(hold) ? Math.Clamp(hold, TourSettings.MIN_HOLD, TourSettings.MAX_HOLD) : null;
            }
            if (bookmark.TourSwivel is float swivel)
            {
                bookmark.TourSwivel = float.IsFinite(swivel) ? Math.Clamp(swivel, -TourSettings.MAX_SWIVEL, TourSettings.MAX_SWIVEL) : null;
            }
        }
    }

    /// <summary>How the tour moves from one stop to the next.</summary>
    public enum TourTransition
    {
        /// <summary>Fade to black, jump, fade back in (the default).</summary>
        Fade,

        /// <summary>Fly smoothly from one stop to the next.</summary>
        Glide
    }

    /// <summary>Which way the tour's swivel turns.</summary>
    public enum TourSwivelDirection
    {
        /// <summary>Counter-clockwise seen from above.</summary>
        Left,

        /// <summary>Clockwise seen from above.</summary>
        Right
    }

    /// <summary>
    /// The bookmark tour's settings (tour round), saved with the bookmarks (inside a .bimgo, or in the live model
    /// folder). Each bookmark can override the hold and swivel (<see cref="BookmarkRecord.TourHold"/>,
    /// <see cref="BookmarkRecord.TourSwivel"/>) or be left out (<see cref="BookmarkRecord.TourSkip"/>).
    /// </summary>
    public sealed class TourSettings
    {
        /// <summary>Shortest hold at a stop (s).</summary>
        public const float MIN_HOLD = 1f;

        /// <summary>Longest hold at a stop (s).</summary>
        public const float MAX_HOLD = 60f;

        /// <summary>Longest fade (s, each way).</summary>
        public const float MAX_FADE = 2f;

        /// <summary>Shortest glide between stops (s).</summary>
        public const float MIN_GLIDE = 1f;

        /// <summary>Longest glide between stops (s).</summary>
        public const float MAX_GLIDE = 15f;

        /// <summary>Largest swivel at a stop (degrees).</summary>
        public const float MAX_SWIVEL = 180f;

        /// <summary>Lowest eye height a bookmark may keep (m).</summary>
        public const float MIN_EYE_HEIGHT = 0.9f;

        /// <summary>Highest eye height a bookmark may keep (m).</summary>
        public const float MAX_EYE_HEIGHT = 2.0f;

        /// <summary>Fade or glide between stops.</summary>
        public TourTransition Transition { get; set; } = TourTransition.Fade;

        /// <summary>Seconds at each stop (between the fades), unless a bookmark overrides it.</summary>
        public float HoldSeconds { get; set; } = 4f;

        /// <summary>Seconds to fade out, and again to fade in (0 = cut).</summary>
        public float FadeSeconds { get; set; } = 0.6f;

        /// <summary>Seconds to glide from one stop to the next (glide transition).</summary>
        public float GlideSeconds { get; set; } = 3f;

        /// <summary>Pan slowly at each stop.</summary>
        public bool Swivel { get; set; } = true;

        /// <summary>How far the swivel pans over a stop (degrees).</summary>
        public float SwivelDegrees { get; set; } = 30f;

        /// <summary>Which way the swivel pans.</summary>
        public TourSwivelDirection SwivelDirection { get; set; } = TourSwivelDirection.Left;

        /// <summary>Show the HUD (minimap, status, room) during the tour; off = a clean, UI-free view.</summary>
        public bool ShowUi { get; set; }

        /// <summary>Start again from the first stop after the last.</summary>
        public bool Loop { get; set; }

        /// <summary>
        /// The tour-wide swivel in degrees, signed like <see cref="BookmarkRecord.TourSwivel"/> (positive left).
        /// </summary>
        [JsonIgnore]
        public float SignedSwivelDegrees => !Swivel ? 0f : SwivelDirection == TourSwivelDirection.Right ? -SwivelDegrees : SwivelDegrees;

        /// <summary>A stop's hold: the bookmark's own, else the tour's (s).</summary>
        public float HoldFor(BookmarkRecord bookmark) => bookmark?.TourHold ?? HoldSeconds;

        /// <summary>A stop's swivel: the bookmark's own, else the tour's (degrees, positive left).</summary>
        public float SwivelFor(BookmarkRecord bookmark) => bookmark?.TourSwivel ?? SignedSwivelDegrees;

        /// <summary>
        /// Clamps every value into range (hand-edited files). Returns this instance.
        /// </summary>
        public TourSettings Clean()
        {
            if (!Enum.IsDefined(Transition)) { Transition = TourTransition.Fade; }
            if (!Enum.IsDefined(SwivelDirection)) { SwivelDirection = TourSwivelDirection.Left; }
            HoldSeconds = float.IsFinite(HoldSeconds) ? Math.Clamp(HoldSeconds, MIN_HOLD, MAX_HOLD) : 4f;
            FadeSeconds = float.IsFinite(FadeSeconds) ? Math.Clamp(FadeSeconds, 0f, MAX_FADE) : 0.6f;
            GlideSeconds = float.IsFinite(GlideSeconds) ? Math.Clamp(GlideSeconds, MIN_GLIDE, MAX_GLIDE) : 3f;
            SwivelDegrees = float.IsFinite(SwivelDegrees) ? Math.Clamp(SwivelDegrees, 0f, MAX_SWIVEL) : 30f;
            return this;
        }

        /// <summary>A copy (the panel edits a copy and saves it when a drag ends).</summary>
        public TourSettings Copy() => (TourSettings)MemberwiseClone();
    }
}
