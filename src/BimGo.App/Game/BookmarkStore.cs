using System.Numerics;
using BimGo.Format;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// The session's viewpoint bookmarks, persisted like comments:
    /// <list type="bullet">
    /// <item><b>Sidecar</b> (Revit sessions): &lt;model&gt;.bimgo-bookmarks.json beside the model, saved on every change.</item>
    /// <item><b>Embedded</b> (.bimgo files): kept in memory and saved with the file (bookmarks.json); changes raise
    /// <see cref="Changed"/> so the document can be marked dirty.</item>
    /// </list>
    /// All IO failures are caught and reported via <see cref="LastError"/>.
    /// </summary>
    internal sealed class BookmarkStore
    {
        /// <summary>Longest bookmark name accepted.</summary>
        public const int MAX_NAME = 60;

        private readonly string _path;
        private readonly string _model;
        private readonly Vector3 _origin;

        /// <summary>All bookmarks, in list order (Shift+1..9 by default jump to the first nine).</summary>
        public List<BookmarkRecord> Bookmarks { get; } = new();

        /// <summary>The saved home viewpoint (walkthroughs start here; H returns here), or null.</summary>
        public BookmarkRecord Home { get; private set; }

        /// <summary>The bookmark tour's settings (tour round; never null).</summary>
        public TourSettings Tour { get; private set; } = new();

        /// <summary>The last IO error, or null.</summary>
        public string LastError { get; private set; }

        /// <summary>True when bookmarks live inside a .bimgo file rather than a sidecar.</summary>
        public bool IsEmbedded => _path == null;

        /// <summary>Where bookmarks are kept (for the HUD).</summary>
        public string FileName => IsEmbedded ? "this file" : Path.GetFileName(_path);

        /// <summary>
        /// Polish round P-C: fills what the session keeps beyond the store's parameters (crouching, the colour profile)
        /// into a new or re-pointed bookmark, before it is saved.
        /// </summary>
        public Action<BookmarkRecord> Stamp { get; set; }

        /// <summary>P-C: a colour profile's name by id for the list's detail line (null when unknown).</summary>
        public Func<string, string> ProfileName { get; set; }

        /// <summary>Incremented on every change (dirty tracking for embedded bookmarks).</summary>
        public int Revision { get; private set; }

        /// <summary>Raised after any change.</summary>
        public event Action Changed;

        /// <summary>
        /// Creates the store.
        /// </summary>
        /// <param name="sidecarPath">Sidecar path, or null to keep bookmarks embedded in the document.</param>
        /// <param name="model">Model title.</param>
        /// <param name="origin">Scene origin offset (metres).</param>
        public BookmarkStore(string sidecarPath, string model, Vector3 origin)
        {
            _path = sidecarPath;
            _model = model;
            _origin = origin;
        }

        /// <summary>
        /// Loads the sidecar. No-op for embedded stores.
        /// </summary>
        public void Load()
        {
            if (IsEmbedded) { return; }
            BookmarkDocument document = BookmarkFiles.Read(_path, out string error);
            LastError = error;
            if (document != null) { LoadFrom(document); }
        }

        /// <summary>
        /// Loads bookmarks from a document (a .bimgo's bookmarks.json). Does not count as a change.
        /// </summary>
        public void LoadFrom(BookmarkDocument document)
        {
            if (document?.Home != null)
            {
                Home = document.Home;
                Prepare(Home);
            }
            if (document?.Tour != null) { Tour = document.Tour.Copy().Clean(); }
            if (document?.Bookmarks == null) { return; }
            foreach (BookmarkRecord record in document.Bookmarks)
            {
                if (record == null) { continue; }
                Prepare(record);
                Bookmarks.Add(record);
            }
        }

        /// <summary>
        /// Rebuilds every bookmark's detail line (review tools round: after the display units change). Not a change.
        /// </summary>
        public void RefreshLabels()
        {
            if (Home != null) { Prepare(Home); }
            foreach (BookmarkRecord record in Bookmarks) { Prepare(record); }
        }

        /// <summary>
        /// The bookmarks as a document (for saving into a .bimgo).
        /// </summary>
        public BookmarkDocument ToDocument() => new() { Model = _model, Bookmarks = Bookmarks.ToList(), Home = Home, Tour = Tour.Copy() };

        /// <summary>
        /// Replaces the tour settings and saves (the panel calls this when a change is finished, not while dragging).
        /// </summary>
        public void SetTour(TourSettings settings)
        {
            Tour = (settings ?? new TourSettings()).Copy().Clean();
            Save();
        }

        /// <summary>
        /// Sets a bookmark's tour overrides (null = the tour's own value) and saves.
        /// </summary>
        /// <returns>False if the bookmark is not in this store.</returns>
        public bool SetTourOverrides(BookmarkRecord record, float? hold, float? swivel, bool skip)
        {
            if (record == null || !Bookmarks.Contains(record)) { return false; }
            record.TourHold = hold is float h ? Math.Clamp(h, TourSettings.MIN_HOLD, TourSettings.MAX_HOLD) : null;
            record.TourSwivel = swivel is float s ? Math.Clamp(s, -TourSettings.MAX_SWIVEL, TourSettings.MAX_SWIVEL) : null;
            record.TourSkip = skip;
            Prepare(record);
            Save();
            return true;
        }

        /// <summary>
        /// Saves the home viewpoint (walkthroughs of this model start there) and saves.
        /// </summary>
        public void SetHome(Vector3 localFeet, float yaw, float pitch, bool flying, string level)
        {
            Home ??= new BookmarkRecord { Name = "Home" };
            SetPosition(Home, localFeet);
            Home.Yaw = yaw;
            Home.Pitch = pitch;
            Home.Flying = flying;
            Home.Level = level ?? string.Empty;
            Home.Author = Environment.UserName;
            Home.Created = DateTimeOffset.Now;
            Prepare(Home);
            Save();
        }

        /// <summary>
        /// Stores a bookmark's thumbnail (base64 JPEG) and saves.
        /// </summary>
        /// <returns>False if the bookmark is no longer in this store.</returns>
        public bool SetThumbnail(BookmarkRecord record, string thumbnail)
        {
            if (record == null || !Bookmarks.Contains(record)) { return false; }
            record.Thumbnail = thumbnail;
            Save();
            return true;
        }

        /// <summary>
        /// The next free default name: "View 1", "View 2"…
        /// </summary>
        public string NextDefaultName()
        {
            for (int n = Bookmarks.Count + 1; n < Bookmarks.Count + 1000; n++)
            {
                string name = $"View {n}";
                if (!Bookmarks.Exists(b => string.Equals(b.Name, name, StringComparison.OrdinalIgnoreCase))) { return name; }
            }
            return "View";
        }

        /// <summary>
        /// Adds a bookmark at a scene-local feet position and saves.
        /// </summary>
        /// <param name="sun">The sun's date / time when shadows are on (restored by GO), else null.</param>
        /// <param name="eyeHeight">The standing eye height (m), or null.</param>
        /// <param name="visibility">What is hidden (categories, links, elements), or null.</param>
        public BookmarkRecord Add(string name, Vector3 localFeet, float yaw, float pitch, bool flying, string level, SunTime sun = null, Scene.SectionCut section = null,
            float? eyeHeight = null, VisibilitySettings visibility = null)
        {
            BookmarkRecord record = CreatePending(name, localFeet, yaw, pitch, flying, level, sun, section, eyeHeight, visibility);
            Bookmarks.Add(record);
            Save();
            return record;
        }

        /// <summary>
        /// Makes a bookmark that is not in the list yet (B: it joins the list only when its name is confirmed with
        /// Enter; Esc throws it away). Nothing is saved.
        /// </summary>
        public BookmarkRecord CreatePending(string name, Vector3 localFeet, float yaw, float pitch, bool flying, string level, SunTime sun = null, Scene.SectionCut section = null,
            float? eyeHeight = null, VisibilitySettings visibility = null)
        {
            var record = new BookmarkRecord
            {
                Name = CleanName(name) ?? NextDefaultName(),
                Yaw = yaw,
                Pitch = pitch,
                Flying = flying,
                Level = level ?? string.Empty,
                Sun = sun?.Copy(),
                Section = section?.Clone(),
                EyeHeight = eyeHeight,
                Visibility = visibility
            };
            SetPosition(record, localFeet);
            Stamp?.Invoke(record);
            Prepare(record);
            return record;
        }

        /// <summary>
        /// Adds a pending bookmark (from <see cref="CreatePending"/>) under a confirmed name and saves.
        /// </summary>
        public void AddPending(BookmarkRecord record, string name)
        {
            if (record == null || Bookmarks.Contains(record)) { return; }
            record.Name = CleanName(name) ?? record.Name;
            Bookmarks.Add(record);
            Save();
        }

        /// <summary>
        /// Renames a bookmark and saves.
        /// </summary>
        /// <returns>False if the bookmark is not in this store or the name is empty.</returns>
        public bool Rename(BookmarkRecord record, string name)
        {
            string clean = CleanName(name);
            if (record == null || !Bookmarks.Contains(record) || clean == null) { return false; }
            if (clean == record.Name) { return true; }
            record.Name = clean;
            Save();
            return true;
        }

        /// <summary>
        /// Moves a bookmark to a new viewpoint (keeps its name and place in the list) and saves.
        /// </summary>
        /// <param name="sun">The sun's date / time when shadows are on, else null (clears it).</param>
        public bool Update(BookmarkRecord record, Vector3 localFeet, float yaw, float pitch, bool flying, string level, SunTime sun = null, Scene.SectionCut section = null,
            float? eyeHeight = null, VisibilitySettings visibility = null)
        {
            if (record == null || !Bookmarks.Contains(record)) { return false; }
            SetPosition(record, localFeet);
            record.Sun = sun?.Copy();
            record.Section = section?.Clone();
            record.EyeHeight = eyeHeight;
            record.Visibility = visibility;
            record.Yaw = yaw;
            record.Pitch = pitch;
            record.Flying = flying;
            record.Level = level ?? string.Empty;
            Stamp?.Invoke(record);
            Prepare(record);
            Save();
            return true;
        }

        /// <summary>
        /// Moves a bookmark one place up (-1) or down (+1) in the list and saves.
        /// </summary>
        public bool Move(BookmarkRecord record, int direction)
        {
            int index = Bookmarks.IndexOf(record);
            int target = index + Math.Sign(direction);
            if (index < 0 || target < 0 || target >= Bookmarks.Count) { return false; }
            Bookmarks.RemoveAt(index);
            Bookmarks.Insert(target, record);
            Save();
            return true;
        }

        /// <summary>
        /// Removes a bookmark and saves.
        /// </summary>
        public void Remove(BookmarkRecord record)
        {
            if (Bookmarks.Remove(record)) { Save(); }
        }

        /// <summary>
        /// Records a change: writes the sidecar, or (embedded) just flags the change for the document.
        /// </summary>
        /// <returns>True on success.</returns>
        public bool Save()
        {
            Revision++;
            bool saved = true;
            if (!IsEmbedded)
            {
                saved = BookmarkFiles.Write(_path, ToDocument(), out string error);
                LastError = error;
            }

            try { Changed?.Invoke(); }
            catch (Exception ex) { Utilities.Log_Utils.Write($"Bookmark change handler failed: {ex.Message}"); }
            return saved;
        }

        /// <summary>
        /// A trimmed name limited to <see cref="MAX_NAME"/> characters, or null if empty.
        /// </summary>
        public static string CleanName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) { return null; }
            name = name.Trim();
            return name.Length > MAX_NAME ? name[..MAX_NAME].TrimEnd() : name;
        }

        private void SetPosition(BookmarkRecord record, Vector3 localFeet)
        {
            record.X = Math.Round(localFeet.X + (double)_origin.X, 4);
            record.Y = Math.Round(localFeet.Y + (double)_origin.Y, 4);
            record.Z = Math.Round(localFeet.Z + (double)_origin.Z, 4);
        }

        private void Prepare(BookmarkRecord record)
        {
            record.Local = new Vector3((float)(record.X - _origin.X), (float)(record.Y - _origin.Y), (float)(record.Z - _origin.Z));
            string level = string.IsNullOrEmpty(record.Level) ? "—" : record.Level;
            string fly = record.Flying ? " · FLY" : string.Empty;
            string sun = record.Sun != null ? $" · SUN {record.Sun.Day}/{record.Sun.Month} {record.Sun.Minutes / 60:00}:{record.Sun.Minutes % 60:00}" : string.Empty;
            string eye = record.EyeHeight is float e && MathF.Abs(e - Scene.LaunchSettings.DEFAULT_EYE_STANDING) > 0.005f
                ? $" · EYE {UnitFormat.Length(e, 2)}" : string.Empty;
            string skip = record.TourSkip ? " · NOT IN TOUR" : string.Empty;
            string crouch = record.Crouched && !record.Flying ? " · CROUCHED" : string.Empty; // P-C
            string profile = record.ColourProfile == null ? string.Empty
                : record.ColourProfile.Length == 0 ? " · PROFILE OFF"
                : " · PROFILE " + (ProfileName?.Invoke(record.ColourProfile) ?? "(gone)").ToUpperInvariant();
            record.Detail = $"{level} · {record.Author} · {record.Created.ToLocalTime():dd MMM HH:mm}{fly}{crouch}{sun}{eye}{profile}{skip}";
        }
    }
}
