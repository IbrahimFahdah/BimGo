using BimGo.Audio;
using BimGo.Format;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;
using Vk = BimGo.Native.Win32;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Location override (tour round, build A2): a site location chosen in BimGo replaces the Revit site's for the sun,
    /// shadows, sun hours, Daylight % and Lux. Opened from the sun panel (CHANGE…): type a city (the bundled Natural
    /// Earth list, offline) or paste "lat, long" from a map. A place brings its IANA time zone, so daylight saving
    /// follows the date (DST AUTO); typed coordinates borrow the zone of the nearest listed place within 300 km.
    /// Saved with the model in sun.json (the .bimgo or the live model folder); RESET goes back to Revit's location.
    /// Revit is never changed, and true north stays the model's.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>Typed coordinates borrow the time zone of a listed place this close (km).</summary>
        private const double NEAREST_ZONE_KM = 300.0;

        /// <summary>Results shown under the search box.</summary>
        private const int LOCATION_RESULTS = 6;

        // The site the sun and the studies use: the model's, or a copy with the override
        private SiteInfo _sunSite;
        private string _modelPlaceLabel;

        // The bundled place list (loaded the first time the picker opens)
        private PlaceIndex _places;

        // Picker state
        private bool _locationOpen;
        private readonly char[] _locationQuery = new char[64];
        private int _locationQueryLength;
        private bool _locationQueryDirty;
        private readonly List<Place> _locationResults = new();
        private readonly List<string> _locationResultDetails = new();
        private bool _locationIsCoordinates;
        private double _locationLat, _locationLon;
        private Place _locationNear;
        private string _locationCoordinatesTitle, _locationCoordinatesDetail;
        private string _locationNotice;
        private string _locationOffsetLabel;

        #endregion

        #region Effective site

        /// <summary>The site the sun, shadows and studies use (the override applied).</summary>
        private SiteInfo SunSite => _sunSite ?? Scene.Site;

        /// <summary>True when a BimGo location replaces the model's.</summary>
        private bool HasLocationOverride => _sun?.Location != null;

        /// <summary>
        /// Rebuilds the effective site, the location and the labels from the model and the override, then the sun.
        /// </summary>
        private void RefreshSunLocation()
        {
            _sunSite = SolarPosition.EffectiveSite(Scene.Site, _sun?.Location);
            _location = SolarPosition.LocationOf(_sunSite, out _locationKnown);

            GeoLocation model = SolarPosition.LocationOf(Scene.Site, out bool modelKnown);
            _modelPlaceLabel = modelKnown ? $"{model.Name} · UTC{FormatZone(model.TimeZone)}" : "none in this file (Sydney assumed)";

            _locationOffsetLabel = HasLocationOverride
                ? $"UTC{FormatZone(_location.TimeZone)}{(_sun.Location.ZoneId == null ? " (manual)" : string.Empty)}"
                : null;
            if (HasLocationOverride)
            {
                string dst = _location.AutoDaylightSaving ? " · DST auto" : string.Empty;
                _sunPlaceLabel = $"{_location.Name} · UTC{FormatZone(_location.TimeZone)}{dst} (set in BimGo)";
            }
            else
            {
                _sunPlaceLabel = _locationKnown
                    ? $"{_location.Name} · UTC{FormatZone(_location.TimeZone)}"
                    : "No site location in this file: Sydney is assumed (CHANGE… picks one)";
            }
            RecomputeSun();
        }

        /// <summary>
        /// Sets (or with null clears) the override, records it for saving and refreshes the sun. Study results made with
        /// the old location are marked out of date.
        /// </summary>
        private void SetLocationOverride(LocationOverride location)
        {
            _sun.Location = location != null && location.Clean().IsValid ? location : null;
            _sunPlaying = false;
            SunChanged();
            RefreshSunLocation();
            MarkSunStudyStale();
            Sound.Play(SoundId.Commit);
            Toast(_sun.Location != null ? $"Location: {_sun.Location.Name}" : "Back to the model's location", 3f);
        }

        /// <summary>The effective daylight saving for the sun panel's date (the zone's when automatic, else the tick).</summary>
        private bool SunDaylightSaving => SolarPosition.IsDaylightSaving(_location, DateTime.Today.Year, _sun.Time.Month, _sun.Time.Day, _sun.Time.DaylightSaving);

        #endregion

        #region Picker

        /// <summary>Opens the picker inside the sun panel (the place list loads the first time).</summary>
        private void OpenLocationPicker()
        {
            if (_places == null)
            {
                string path = Path.Combine(AppContext.BaseDirectory, "Resources", "places.tsv");
                _places = PlaceIndex.LoadFile(path);
                Utilities.Log_Utils.Write($"Place list: {_places.Count} places ({path}).");
            }
            CommitSunField();
            _locationOpen = true;
            _locationQueryLength = 0;
            _locationQueryDirty = true;
            _locationNotice = _places.Count == 0 ? "The place list wasn't found: type or paste coordinates (lat, long) instead" : null;
            _window.Input.ReleaseAll();
        }

        /// <summary>Back to the sun panel.</summary>
        private void CloseLocationPicker()
        {
            _locationOpen = false;
            _window.Input.ReleaseAll();
        }

        /// <summary>
        /// Keys while the picker is open: typing and Backspace edit the search, Ctrl+V pastes, Enter takes the first
        /// result, Esc goes back to the sun panel.
        /// </summary>
        private void UpdateLocationKeys(InputState input)
        {
            // A text box: its keys stay outside the action map (input round B2)
            if (input.IsPressed(Vk.VK_ESCAPE))
            {
                CloseLocationPicker();
                return;
            }
            if (input.IsDown(Vk.VK_CONTROL) && input.IsPressed('V'))
            {
                PasteIntoLocationQuery();
            }
            else
            {
                foreach (char c in input.Chars)
                {
                    if (c == '\b')
                    {
                        if (_locationQueryLength > 0) { _locationQueryLength--; _locationQueryDirty = true; }
                    }
                    else if (c >= ' ' && _locationQueryLength < _locationQuery.Length)
                    {
                        _locationQuery[_locationQueryLength++] = c;
                        _locationQueryDirty = true;
                    }
                }
            }
            if (_locationQueryDirty) { RunLocationSearch(); }

            if (input.IsPressed(Vk.VK_RETURN))
            {
                if (_locationIsCoordinates) { UseTypedCoordinates(); }
                else if (_locationResults.Count > 0) { UsePlace(_locationResults[0]); }
            }
        }

        /// <summary>Ctrl+V: the clipboard's first line replaces the search (coordinates copied from a map).</summary>
        private void PasteIntoLocationQuery()
        {
            try
            {
                string text = System.Windows.Forms.Clipboard.ContainsText() ? System.Windows.Forms.Clipboard.GetText() : string.Empty;
                text = (text ?? string.Empty).Split('\n')[0].Trim();
                _locationQueryLength = 0;
                foreach (char c in text)
                {
                    if (_locationQueryLength >= _locationQuery.Length) { break; }
                    if (c >= ' ') { _locationQuery[_locationQueryLength++] = c; }
                }
                _locationQueryDirty = true;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Paste failed: {ex.Message}");
                _locationNotice = "Nothing could be pasted";
            }
        }

        /// <summary>
        /// Searches after the text changed: coordinates when it reads as "lat, long" (with the nearest listed place for
        /// the time zone), and the place list either way.
        /// </summary>
        private void RunLocationSearch()
        {
            _locationQueryDirty = false;
            string query = new string(_locationQuery, 0, _locationQueryLength);

            _locationIsCoordinates = PlaceIndex.TryParseCoordinates(query, out _locationLat, out _locationLon);
            _locationNear = null;
            if (_locationIsCoordinates)
            {
                _locationNear = _places.Nearest(_locationLat, _locationLon, NEAREST_ZONE_KM, out double km);
                _locationCoordinatesTitle = $"USE {FormatCoordinates(_locationLat, _locationLon)}";
                double offset = TimeZones.StandardOffset(_locationNear?.ZoneId, _locationLon);
                _locationCoordinatesDetail = _locationNear != null
                    ? $"near {_locationNear.Name} ({km:0} km) · UTC{FormatZone(offset)} · {ZoneOrNone(_locationNear.ZoneId)}"
                    : $"UTC{FormatZone(offset)} estimated from the longitude (no listed place within {NEAREST_ZONE_KM:0} km)";
            }

            _locationResults.Clear();
            _locationResultDetails.Clear();
            if (!_locationIsCoordinates && _places != null)
            {
                _places.Search(query, _locationResults, LOCATION_RESULTS);
                foreach (Place place in _locationResults)
                {
                    double offset = TimeZones.StandardOffset(place.ZoneId, place.Longitude);
                    _locationResultDetails.Add($"{FormatCoordinates(place.Latitude, place.Longitude)} · UTC{FormatZone(offset)} · {ZoneOrNone(place.ZoneId)}");
                }
            }
        }

        /// <summary>Takes a listed place: its coordinates, label and time zone (daylight saving automatic when Windows knows the zone).</summary>
        private void UsePlace(Place place)
        {
            if (place == null) { return; }
            string zone = string.IsNullOrEmpty(place.ZoneId) ? null : place.ZoneId;
            SetLocationOverride(new LocationOverride
            {
                Latitude = place.Latitude,
                Longitude = place.Longitude,
                ZoneId = zone,
                TimeZone = TimeZones.StandardOffset(zone, place.Longitude),
                AutoDaylightSaving = zone != null && TimeZones.TryFind(zone, out _),
                Name = place.Label
            });
            CloseLocationPicker();
        }

        /// <summary>Takes the typed coordinates, with the nearest listed place's time zone (else the longitude estimate).</summary>
        private void UseTypedCoordinates()
        {
            if (!_locationIsCoordinates) { return; }
            string zone = string.IsNullOrEmpty(_locationNear?.ZoneId) ? null : _locationNear.ZoneId;
            string near = _locationNear != null ? $" (near {_locationNear.Name})" : string.Empty;
            SetLocationOverride(new LocationOverride
            {
                Latitude = _locationLat,
                Longitude = _locationLon,
                ZoneId = zone,
                TimeZone = TimeZones.StandardOffset(zone, _locationLon),
                AutoDaylightSaving = zone != null && TimeZones.TryFind(zone, out _),
                Name = FormatCoordinates(_locationLat, _locationLon) + near
            });
            CloseLocationPicker();
        }

        /// <summary>
        /// − / + on the override's UTC offset (half hours): the offset becomes manual (no zone, the DST tick decides).
        /// </summary>
        private void StepLocationOffset(int direction)
        {
            LocationOverride location = _sun.Location?.Copy();
            if (location == null) { return; }
            location.TimeZone = Math.Clamp(Math.Round((location.TimeZone + direction * 0.5) * 2.0) / 2.0, -12.0, 14.0);
            if (location.AutoDaylightSaving) { _sun.Time.DaylightSaving = SunDaylightSaving; }
            location.ZoneId = null;
            location.AutoDaylightSaving = false;
            _sun.Location = location.Clean();
            SunChanged();
            RefreshSunLocation();
            MarkSunStudyStale();
        }

        /// <summary>The sun panel's DST control when the location decides daylight saving: switch to the manual tick.</summary>
        private void SetLocationDaylightSavingAuto(bool auto)
        {
            LocationOverride location = _sun.Location?.Copy();
            if (location == null || location.ZoneId == null) { return; }
            if (!auto) { _sun.Time.DaylightSaving = SunDaylightSaving; }
            location.AutoDaylightSaving = auto && TimeZones.TryFind(location.ZoneId, out _);
            _sun.Location = location;
            SunChanged();
            RefreshSunLocation();
            MarkSunStudyStale();
        }

        /// <summary>Marks finished study results out of date (the location changed): RUN reads "settings changed".</summary>
        private void MarkSunStudyStale()
        {
            if (_sunStudy?.Hours != null) { _sunStale = true; }
        }

        private static string ZoneOrNone(string zone) => string.IsNullOrEmpty(zone) ? "no time zone listed" : zone;

        /// <summary>"−33.8688°, 151.2093°" (allocates: labels built on change only).</summary>
        private static string FormatCoordinates(double latitude, double longitude) =>
            string.Create(System.Globalization.CultureInfo.InvariantCulture, $"{latitude:0.0000}°, {longitude:0.0000}°").Replace('-', '−');

        #endregion

        #region Panel

        /// <summary>
        /// The picker, drawn in the sun panel's place: model and current location, the search box, coordinates or
        /// results, the UTC offset (manual tweak), RESET and the place list's credit.
        /// </summary>
        private void BuildLocationPanel(FontAtlas f, InputState input, float x, float y, float w, float h)
        {
            float ix = x + S(16), iw = w - S(32);
            float cy = y + S(14);

            _ui.Text(f.Small, ix, cy, "SITE LOCATION", UiTheme.SUN_LABEL, S(2f));
            _ui.TextRight(f.Small, ix + iw, cy, "ESC BACK", UiTheme.TEXT_FAINT, S(0.6f));
            cy += S(24);
            float used = _ui.Text(f.Small, ix, cy, "REVIT MODEL  ", UiTheme.TEXT_FAINT);
            _ui.TextWrapped(f.Small, ix + used, cy, iw - used, _modelPlaceLabel ?? string.Empty, UiTheme.TEXT_MUTED, maxLines: 1);
            cy += S(18);
            used = _ui.Text(f.Small, ix, cy, "IN USE  ", UiTheme.TEXT_FAINT);
            _ui.TextWrapped(f.Small, ix + used, cy, iw - used, HasLocationOverride ? _sunPlaceLabel : "the model's location", HasLocationOverride ? UiTheme.SUN : UiTheme.TEXT_MUTED, maxLines: 1);
            cy += S(26);

            // Search box (always focused while the picker is open)
            float boxH = S(34);
            _ui.Rect(ix, cy, iw, boxH, Rgba.Hex(0xFFFFFF, 0.08f));
            _ui.Outline(ix, cy, iw, boxH, MathF.Max(1f, UiScale), UiTheme.SUN);
            float textY = cy + boxH * 0.5f - f.Body.LineHeight * 0.5f;
            if (_locationQueryLength == 0)
            {
                _ui.Text(f.Body, ix + S(10), textY, "Type a city, or paste lat, long (Ctrl+V)", UiTheme.TEXT_FAINT);
                if ((_clock % 1f) < 0.55f) { _ui.Rect(ix + S(10), cy + S(8), S(1.5f), boxH - S(16), UiTheme.SUN); }
            }
            else
            {
                float typed = _ui.Text(f.Body, ix + S(10), textY, _locationQuery.AsSpan(0, _locationQueryLength), UiTheme.TEXT);
                if ((_clock % 1f) < 0.55f) { _ui.Rect(ix + S(11) + typed, cy + S(8), S(1.5f), boxH - S(16), UiTheme.SUN); }
            }
            cy += boxH + S(10);

            // Coordinates, or the matching places
            float rowH = S(46);
            if (_locationIsCoordinates)
            {
                if (LocationRow(f, input, ix, cy, iw, rowH, _locationCoordinatesTitle, _locationCoordinatesDetail)) { UseTypedCoordinates(); }
                cy += rowH + S(4);
            }
            else if (_locationResults.Count == 0)
            {
                string hint = _locationQueryLength == 0
                    ? "About 7,000 cities and towns, offline. For an exact site, paste its coordinates, e.g. −33.8568, 151.2153."
                    : "No listed place matches. Try the city's name, or paste coordinates.";
                _ui.TextWrapped(f.Small, ix, cy + S(4), iw, hint, UiTheme.TEXT_MUTED, maxLines: 3);
            }
            Place chosen = null;
            for (int i = 0; i < _locationResults.Count; i++)
            {
                if (LocationRow(f, input, ix, cy, iw, rowH, _locationResults[i].Label, _locationResultDetails[i])) { chosen = _locationResults[i]; }
                cy += rowH + S(4);
            }
            if (chosen != null) { UsePlace(chosen); }

            // Bottom: the UTC offset (override only), RESET, credit
            float by = y + h - S(16) - S(16) - S(30) - S(40);
            if (_locationNotice != null) { _ui.TextWrapped(f.Small, ix, by - S(22), iw, _locationNotice, UiTheme.MEASURE_LABEL, maxLines: 1); }
            if (HasLocationOverride)
            {
                _ui.Text(f.Body, ix, by + S(6), "UTC offset", UiTheme.TEXT_SOFT);
                _ui.TextRight(f.Mono, ix + iw - S(80), by + S(7), _locationOffsetLabel ?? string.Empty, Rgba.Hex(0x67E8F9));
                if (SmallButton(f, input, ix + iw - S(70), by, S(32), S(30), "−")) { StepLocationOffset(-1); }
                if (SmallButton(f, input, ix + iw - S(32), by, S(32), S(30), "+")) { StepLocationOffset(+1); }
            }
            by += S(40);
            if (HasLocationOverride && SmallButton(f, input, ix, by, iw, S(30), "RESET TO THE REVIT MODEL'S LOCATION"))
            {
                SetLocationOverride(null);
                CloseLocationPicker();
                return;
            }
            by += S(38);
            _ui.Text(f.Small, ix, by, "Places: Natural Earth (public domain) · Revit is never changed", UiTheme.TEXT_FAINT, S(0.2f));
        }

        /// <summary>A clickable two-line result row.</summary>
        private bool LocationRow(FontAtlas f, InputState input, float x, float y, float w, float h, string title, string detail)
        {
            bool hover = Hover(input, x, y, w, h);
            _ui.Rect(x, y, w, h, hover ? Rgba.Hex(0xFFFFFF, 0.1f) : UiTheme.CONTROL);
            _ui.Outline(x, y, w, h, MathF.Max(1f, UiScale), hover ? UiTheme.SUN : UiTheme.CONTROL_BORDER);
            _ui.TextWrapped(f.Bold, x + S(10), y + S(6), w - S(20), title ?? string.Empty, hover ? UiTheme.SUN : UiTheme.TEXT, maxLines: 1);
            _ui.TextWrapped(f.Small, x + S(10), y + S(27), w - S(20), detail ?? string.Empty, UiTheme.TEXT_MUTED, maxLines: 1);
            bool clicked = hover && input.LeftPressed;
            if (clicked)
            {
                input.ConsumeClicks();
                Sound.Play(SoundId.UiClick);
            }
            return clicked;
        }

        #endregion
    }
}
