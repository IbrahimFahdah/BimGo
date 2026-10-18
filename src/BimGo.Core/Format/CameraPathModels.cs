using System.Numerics;
using System.Text.Json.Serialization;

// The class belongs to the Format namespace
namespace BimGo.Format
{
    /// <summary>
    /// Which way a camera path's camera looks (Round K). The path has a default; a key can override it near itself (the
    /// camera blends into the key's heading on the way in and back out on the way out).
    /// </summary>
    public enum CameraHeading
    {
        /// <summary>Looks ahead along the path, turning progressively with it (the default).</summary>
        Follow,

        /// <summary>Holds the key's own view (its yaw and pitch).</summary>
        Key,

        /// <summary>Looks at the key's target point.</summary>
        LookAt
    }

    /// <summary>
    /// One key of a camera path (Round K): where the camera's eye is, which way it looks there and how the path behaves
    /// at it. Positions are metres in Revit's internal coordinate system (like bookmarks), so a path stays put across
    /// snapshots whose scene origin differs. Optional fields left null use the path's own setting.
    /// </summary>
    public sealed class CameraKey
    {
        /// <summary>Longest hold at a key (s).</summary>
        public const float MAX_HOLD = 60f;

        /// <summary>Stable id (GUID, no dashes).</summary>
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        /// <summary>The name shown in the key list and on the playback bar.</summary>
        public string Name { get; set; } = string.Empty;

        /// <summary>Eye position X (Revit internal metres).</summary>
        public double X { get; set; }

        /// <summary>Eye position Y (Revit internal metres).</summary>
        public double Y { get; set; }

        /// <summary>Eye position Z (Revit internal metres).</summary>
        public double Z { get; set; }

        /// <summary>The key's own look direction about +Z (radians, 0 = +X, counter-clockwise): used when it holds its view.</summary>
        public float Yaw { get; set; }

        /// <summary>The key's own look pitch (radians, positive up).</summary>
        public float Pitch { get; set; }

        /// <summary>The heading near this key, or null for the path's (<see cref="CameraPath.Heading"/>).</summary>
        public CameraHeading? Heading { get; set; }

        /// <summary>Look-at target X (Revit internal metres; with <see cref="TargetY"/> and <see cref="TargetZ"/>), or null.</summary>
        public double? TargetX { get; set; }

        /// <summary>Look-at target Y.</summary>
        public double? TargetY { get; set; }

        /// <summary>Look-at target Z.</summary>
        public double? TargetZ { get; set; }

        /// <summary>How round the path turns at this key (0 sharp corner – 1 round), or null for the path's.</summary>
        public float? Smoothness { get; set; }

        /// <summary>Speed on the way to the next key (m/s), or null for the path's.</summary>
        public float? Speed { get; set; }

        /// <summary>Seconds the camera stops at this key (0: it passes through).</summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
        public float HoldSeconds { get; set; }

        /// <summary>
        /// Slow down into and out of this key: null = automatic (at the path's ends and where it holds), true = always,
        /// false = never (the camera passes at speed; a key that holds always eases).
        /// </summary>
        public bool? Ease { get; set; }

        /// <summary>
        /// The sun's date and time at this key, or null for the walkthrough's. Between keys with different suns the sun
        /// moves from one to the other (the sun animation).
        /// </summary>
        public SunTime Sun { get; set; }

        /// <summary>The colour profile from this key on (its id; "" = none showing), or null to leave it as it is.</summary>
        public string ColourProfile { get; set; }

        /// <summary>
        /// Round K-C: a slow pan over this key's hold (degrees, positive turns left, negative right), or null for none.
        /// Only with its own view (<see cref="CameraHeading.Key"/>) and a hold; a tour's swivel comes here when it is
        /// converted to a path.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public float? Swivel { get; set; }

        /// <summary>
        /// Round K-C: the section cut from this key on (a cut with nothing on clears it), or null to leave it as it is.
        /// A bookmark's cut comes here when the tour is converted to a path.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public Scene.SectionCut Section { get; set; }

        /// <summary>
        /// Round K-C: what is hidden from this key on (categories, links, elements; an empty set shows everything), or
        /// null to leave it as it is. The ground, the section and the colour profiles are not kept here.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public VisibilitySettings Visibility { get; set; }

        /// <summary>Scene-local eye position (not serialised).</summary>
        [JsonIgnore]
        public Vector3 Local { get; set; }

        /// <summary>Scene-local look-at target, or null (not serialised).</summary>
        [JsonIgnore]
        public Vector3? TargetLocal { get; set; }

        /// <summary>True when the key has a look-at target.</summary>
        [JsonIgnore]
        public bool HasTarget => TargetX.HasValue && TargetY.HasValue && TargetZ.HasValue;

        /// <summary>Round K-B: an exact deep copy (same id) for undo.</summary>
        public CameraKey Snapshot()
        {
            var copy = (CameraKey)MemberwiseClone();
            copy.Sun = Sun?.Copy();
            copy.Section = Section?.Clone();
            copy.Visibility = Visibility?.Copy();
            return copy;
        }

        /// <summary>A deep copy with a new id (DUPLICATE).</summary>
        public CameraKey Copy()
        {
            CameraKey copy = Snapshot();
            copy.Id = Guid.NewGuid().ToString("N");
            return copy;
        }

        /// <summary>
        /// Drops non-finite and out-of-range values (hand-edited files).
        /// </summary>
        /// <returns>False when the key is unusable (no finite position or view).</returns>
        public bool Clean()
        {
            if (!double.IsFinite(X) || !double.IsFinite(Y) || !double.IsFinite(Z) || !float.IsFinite(Yaw) || !float.IsFinite(Pitch)) { return false; }
            Id = string.IsNullOrWhiteSpace(Id) ? Guid.NewGuid().ToString("N") : Id;
            Name ??= string.Empty;
            Pitch = Math.Clamp(Pitch, -1.5f, 1.5f);
            if (Heading is CameraHeading heading && !Enum.IsDefined(heading)) { Heading = null; }
            if (!HasTarget || !double.IsFinite(TargetX.Value) || !double.IsFinite(TargetY.Value) || !double.IsFinite(TargetZ.Value))
            {
                TargetX = TargetY = TargetZ = null;
            }
            if (Smoothness is float smooth) { Smoothness = float.IsFinite(smooth) ? Math.Clamp(smooth, 0f, 1f) : null; }
            if (Speed is float speed) { Speed = float.IsFinite(speed) ? Math.Clamp(speed, CameraPath.MIN_SPEED, CameraPath.MAX_SPEED) : null; }
            HoldSeconds = float.IsFinite(HoldSeconds) ? Math.Clamp(HoldSeconds, 0f, MAX_HOLD) : 0f;
            if (Swivel is float swivel) { Swivel = float.IsFinite(swivel) && swivel != 0f ? Math.Clamp(swivel, -TourSettings.MAX_SWIVEL, TourSettings.MAX_SWIVEL) : null; }
            Section?.Clean();
            if (Visibility != null)
            {
                Visibility.Clean();
                Visibility.GroundOffset = null;
                Visibility.Section = null;
                Visibility.Appearance = null;
            }
            return true;
        }
    }

    /// <summary>
    /// A keyframed camera path (Round K): keys in order, played at a constant speed along a smooth curve through them
    /// (centripetal Catmull-Rom, rounded by <see cref="Smoothness"/>), with holds, easing, a heading that follows the
    /// path or a key's own view, and the sun and colour profile changing along it.
    /// </summary>
    public sealed class CameraPath
    {
        /// <summary>Slowest speed (m/s).</summary>
        public const float MIN_SPEED = 0.2f;

        /// <summary>Fastest speed (m/s).</summary>
        public const float MAX_SPEED = 30f;

        /// <summary>Longest fade (s).</summary>
        public const float MAX_FADE = 2f;

        /// <summary>Shortest and longest look-ahead (m) when following the path.</summary>
        public const float MIN_LOOK_AHEAD = 0.5f, MAX_LOOK_AHEAD = 20f;

        /// <summary>Most keys a path may hold.</summary>
        public const int MAX_KEYS = 200;

        /// <summary>Stable id (GUID, no dashes).</summary>
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        /// <summary>The name shown in the list.</summary>
        public string Name { get; set; } = "Path";

        /// <summary>Who made it.</summary>
        public string Author { get; set; } = Environment.UserName;

        /// <summary>When it was made.</summary>
        public DateTimeOffset Created { get; set; } = DateTimeOffset.Now;

        /// <summary>The keys in order.</summary>
        public List<CameraKey> Keys { get; set; } = new();

        /// <summary>Speed along the curve (m/s) unless a key sets its own.</summary>
        public float Speed { get; set; } = 1.5f;

        /// <summary>How round the path turns at its keys (0 sharp corners – 1 round) unless a key sets its own.</summary>
        public float Smoothness { get; set; } = 0.8f;

        /// <summary>The heading unless a key sets its own (default: follow the path).</summary>
        public CameraHeading Heading { get; set; } = CameraHeading.Follow;

        /// <summary>Following the path: how far ahead along it the camera looks (m). Longer turns earlier and more gently.</summary>
        public float LookAhead { get; set; } = 3f;

        /// <summary>Following the path: keep the horizon level (no pitch from climbs and drops).</summary>
        public bool Level { get; set; } = true;

        /// <summary>Fade in at the start and out at the end (s; 0 = cut; not when looping).</summary>
        public float FadeSeconds { get; set; } = 0.5f;

        /// <summary>Show the HUD while it plays (off: a clean view).</summary>
        public bool ShowUi { get; set; }

        /// <summary>Back to the first key after the last (a closed loop: no fades).</summary>
        public bool Loop { get; set; }

        /// <summary>
        /// Round K-C: between two keys that hold their own views (or look at targets), turn out of the first into
        /// following the path, then into the second (off: turn straight from one view to the other). Short segments
        /// (under twice the look-ahead) always turn straight. A tour converted to a path has it on.
        /// </summary>
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
        public bool FollowBetween { get; set; }

        /// <summary>
        /// Clamps every value into range and drops unusable keys (hand-edited files). Returns this instance.
        /// </summary>
        public CameraPath Clean()
        {
            Id = string.IsNullOrWhiteSpace(Id) ? Guid.NewGuid().ToString("N") : Id;
            if (string.IsNullOrWhiteSpace(Name)) { Name = "Path"; }
            Author ??= string.Empty;
            Keys ??= new List<CameraKey>();
            Keys.RemoveAll(k => k == null || !k.Clean());
            if (Keys.Count > MAX_KEYS) { Keys.RemoveRange(MAX_KEYS, Keys.Count - MAX_KEYS); }
            Speed = float.IsFinite(Speed) ? Math.Clamp(Speed, MIN_SPEED, MAX_SPEED) : 1.5f;
            Smoothness = float.IsFinite(Smoothness) ? Math.Clamp(Smoothness, 0f, 1f) : 0.8f;
            if (!Enum.IsDefined(Heading)) { Heading = CameraHeading.Follow; }
            LookAhead = float.IsFinite(LookAhead) ? Math.Clamp(LookAhead, MIN_LOOK_AHEAD, MAX_LOOK_AHEAD) : 3f;
            FadeSeconds = float.IsFinite(FadeSeconds) ? Math.Clamp(FadeSeconds, 0f, MAX_FADE) : 0.5f;
            return this;
        }

        /// <summary>A key's smoothness: its own, else the path's.</summary>
        public float SmoothnessFor(CameraKey key) => key?.Smoothness ?? Smoothness;

        /// <summary>A key's speed on the way to the next key: its own, else the path's (m/s).</summary>
        public float SpeedFor(CameraKey key) => key?.Speed ?? Speed;

        /// <summary>A key's heading: its own, else the path's.</summary>
        public CameraHeading HeadingFor(CameraKey key) => key?.Heading ?? Heading;

        /// <summary>
        /// Whether the camera slows into and out of a key: its own setting, else at the path's ends (not looping) and
        /// where it holds. A key that holds always eases (the camera has to stop).
        /// </summary>
        public bool EasesAt(int index)
        {
            if (index < 0 || index >= Keys.Count) { return false; }
            CameraKey key = Keys[index];
            if (key.HoldSeconds > 0f) { return true; }
            if (key.Ease is bool ease) { return ease; }
            return !Loop && (index == 0 || index == Keys.Count - 1);
        }

        /// <summary>
        /// Round K-B: an exact deep copy (same ids; the scene-local positions too) for undo.
        /// </summary>
        public CameraPath Snapshot()
        {
            var copy = (CameraPath)MemberwiseClone();
            copy.Keys = Keys.Select(k => k.Snapshot()).ToList();
            return copy;
        }

        /// <summary>
        /// Round K-B: takes every setting and key from a snapshot (undo), keeping this instance (so lists and selections
        /// that hold it stay valid; the keys are fresh copies).
        /// </summary>
        public void CopyFrom(CameraPath snapshot)
        {
            if (snapshot == null || ReferenceEquals(snapshot, this)) { return; }
            Id = snapshot.Id;
            Name = snapshot.Name;
            Author = snapshot.Author;
            Created = snapshot.Created;
            Speed = snapshot.Speed;
            Smoothness = snapshot.Smoothness;
            Heading = snapshot.Heading;
            LookAhead = snapshot.LookAhead;
            Level = snapshot.Level;
            FadeSeconds = snapshot.FadeSeconds;
            ShowUi = snapshot.ShowUi;
            Loop = snapshot.Loop;
            FollowBetween = snapshot.FollowBetween;
            Keys = snapshot.Keys.Select(k => k.Snapshot()).ToList();
        }

        /// <summary>A deep copy with new ids (DUPLICATE).</summary>
        public CameraPath Copy()
        {
            var copy = (CameraPath)MemberwiseClone();
            copy.Id = Guid.NewGuid().ToString("N");
            copy.Created = DateTimeOffset.Now;
            copy.Author = Environment.UserName;
            copy.Keys = Keys.Select(k => k.Copy()).ToList();
            return copy;
        }
    }

    /// <summary>
    /// The camera paths of a model (Round K): <c>paths.json</c> inside a .bimgo, or in the live model folder (or
    /// &lt;model&gt;.bimgo-paths.json beside an older snapshot). Optional: older readers ignore it.
    /// </summary>
    public sealed class CameraPathDocument
    {
        public int Version { get; set; } = 1;
        public string Model { get; set; } = string.Empty;
        public string Units { get; set; } = "metres, Revit internal coordinates; angles in radians; speeds in m/s";
        public List<CameraPath> Paths { get; set; } = new();

        /// <summary>True when there is nothing to save.</summary>
        [JsonIgnore]
        public bool IsEmpty => (Paths?.Count ?? 0) == 0;

        /// <summary>Drops null paths and cleans the rest. Returns the document for chaining.</summary>
        public CameraPathDocument Clean()
        {
            Paths ??= new List<CameraPath>();
            Paths.RemoveAll(p => p == null);
            foreach (CameraPath path in Paths) { path.Clean(); }
            return this;
        }
    }

    /// <summary>
    /// Reads and writes the camera path sidecar of a live Revit session (<c>paths.json</c> in the model folder, or
    /// &lt;model&gt;.bimgo-paths.json beside an older snapshot). Same JSON as paths.json inside a .bimgo. Never throws.
    /// </summary>
    public static class CameraPathFiles
    {
        /// <summary>The path sidecar that goes with a comments sidecar (same folder and base name), or null.</summary>
        public static string SidecarFor(string commentsSidecarPath) => SidecarJson.BesideComments(commentsSidecarPath, BimGoFormat.PATHS_SIDECAR_SUFFIX);

        /// <summary>Reads a sidecar (null if missing or unreadable).</summary>
        public static CameraPathDocument Read(string path, out string error) => SidecarJson.Read<CameraPathDocument>(path, "Camera paths", out error)?.Clean();

        /// <summary>Writes a sidecar atomically.</summary>
        public static bool Write(string path, CameraPathDocument document, out string error) => SidecarJson.Write(path, document, "Camera paths", out error);
    }
}
