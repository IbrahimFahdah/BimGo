using System.Globalization;
using System.Text;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// IANA time zones through Windows (location override). .NET 8 finds IANA ids directly where ICU is present
    /// (Windows 10 1903+), else through the IANA → Windows id table. Results are cached; never throws.
    /// </summary>
    public static class TimeZones
    {
        private static readonly Dictionary<string, TimeZoneInfo> _cache = new(StringComparer.OrdinalIgnoreCase);
        private static readonly object _lock = new();

        /// <summary>
        /// Finds a time zone by IANA id ("Australia/Sydney").
        /// </summary>
        /// <returns>False for null, unknown or unconvertible ids.</returns>
        public static bool TryFind(string ianaId, out TimeZoneInfo zone)
        {
            zone = null;
            if (string.IsNullOrWhiteSpace(ianaId)) { return false; }
            lock (_lock)
            {
                if (_cache.TryGetValue(ianaId, out zone)) { return zone != null; }
            }

            TimeZoneInfo found = null;
            try { found = TimeZoneInfo.FindSystemTimeZoneById(ianaId); }
            catch (Exception)
            {
                try
                {
                    if (TimeZoneInfo.TryConvertIanaIdToWindowsId(ianaId, out string windowsId)) { found = TimeZoneInfo.FindSystemTimeZoneById(windowsId); }
                }
                catch (Exception) { found = null; }
            }

            lock (_lock) { _cache[ianaId] = found; }
            zone = found;
            return found != null;
        }

        /// <summary>
        /// A zone's standard offset (hours from UTC, without daylight saving), or the longitude estimate when the zone
        /// is unknown.
        /// </summary>
        public static double StandardOffset(string ianaId, double longitude) =>
            TryFind(ianaId, out TimeZoneInfo zone) ? zone.BaseUtcOffset.TotalHours : EstimateOffset(longitude);

        /// <summary>The nearest whole-hour offset for a longitude (15° per hour): a first guess to edit.</summary>
        public static double EstimateOffset(double longitude) =>
            double.IsFinite(longitude) ? Math.Clamp(Math.Round(longitude / 15.0), -12.0, 14.0) : 0.0;
    }

    /// <summary>
    /// One place of the bundled list (location override).
    /// </summary>
    public sealed class Place
    {
        /// <summary>The place's name.</summary>
        public string Name { get; init; } = string.Empty;

        /// <summary>State / province / region, or empty.</summary>
        public string Region { get; init; } = string.Empty;

        /// <summary>Country.</summary>
        public string Country { get; init; } = string.Empty;

        /// <summary>Latitude (degrees, north positive).</summary>
        public double Latitude { get; init; }

        /// <summary>Longitude (degrees, east positive).</summary>
        public double Longitude { get; init; }

        /// <summary>IANA time zone, or empty.</summary>
        public string ZoneId { get; init; } = string.Empty;

        /// <summary>Population (ranking).</summary>
        public long Population { get; init; }

        /// <summary>"Sydney, New South Wales, Australia" (built once).</summary>
        public string Label { get; init; } = string.Empty;

        /// <summary>Folded search keys: name, then region and country (lower case, no accents).</summary>
        internal string NameKey { get; init; } = string.Empty;

        internal string AllKey { get; init; } = string.Empty;
    }

    /// <summary>
    /// The bundled place list (location override): about 7,000 cities and towns from Natural Earth's 1:10m populated
    /// places (public domain), with IANA time zones. One line per place, tab separated: name, region, country, latitude,
    /// longitude, zone, population; '#' lines are comments. Searching ranks name matches (exact, then starting with,
    /// then containing) before region / country matches, larger places first. Never throws.
    /// </summary>
    public sealed class PlaceIndex
    {
        private readonly List<Place> _places = new();

        /// <summary>Number of places.</summary>
        public int Count => _places.Count;

        /// <summary>
        /// Reads a list. Bad lines are skipped.
        /// </summary>
        public static PlaceIndex Load(TextReader reader)
        {
            var index = new PlaceIndex();
            if (reader == null) { return index; }
            try
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.Length == 0 || line[0] == '#') { continue; }
                    string[] parts = line.Split('\t');
                    if (parts.Length < 7) { continue; }
                    if (!double.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out double lat)
                        || !double.TryParse(parts[4], NumberStyles.Float, CultureInfo.InvariantCulture, out double lon)
                        || Math.Abs(lat) > 90.0 || Math.Abs(lon) > 180.0)
                    {
                        continue;
                    }
                    long.TryParse(parts[6], NumberStyles.Integer, CultureInfo.InvariantCulture, out long population);
                    string name = parts[0].Trim(), region = parts[1].Trim(), country = parts[2].Trim();
                    if (name.Length == 0) { continue; }
                    string label = string.Join(", ", new[] { name, region == name ? string.Empty : region, country }.Where(t => t.Length > 0));
                    index._places.Add(new Place
                    {
                        Name = name,
                        Region = region,
                        Country = country,
                        Latitude = lat,
                        Longitude = lon,
                        ZoneId = parts[5].Trim(),
                        Population = population,
                        Label = label,
                        NameKey = Fold(name),
                        AllKey = Fold(label)
                    });
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Place list unreadable: {ex.Message}");
            }
            return index;
        }

        /// <summary>
        /// Reads a list file (places.tsv beside the app). An empty index when it is missing or unreadable.
        /// </summary>
        public static PlaceIndex LoadFile(string path)
        {
            try
            {
                if (!File.Exists(path)) { return new PlaceIndex(); }
                using var reader = new StreamReader(path, Encoding.UTF8);
                return Load(reader);
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Place list not read ({path}): {ex.Message}");
                return new PlaceIndex();
            }
        }

        /// <summary>
        /// Searches by name, region and country. Every word of the query must match somewhere in
        /// "name, region, country"; the first word is ranked against the name.
        /// </summary>
        /// <param name="query">What was typed ("sydney", "perth aus", "sao paulo").</param>
        /// <param name="results">Filled with the best matches (cleared first).</param>
        /// <param name="max">Most results.</param>
        public void Search(string query, List<Place> results, int max = 8)
        {
            results.Clear();
            string folded = Fold(query ?? string.Empty);
            string[] words = folded.Split(new[] { ' ', ',' }, StringSplitOptions.RemoveEmptyEntries);
            if (words.Length == 0 || max <= 0) { return; }

            var scored = new List<(int Rank, long Population, Place Place)>();
            string phrase = string.Join(' ', words);
            foreach (Place place in _places)
            {
                bool all = true;
                foreach (string word in words)
                {
                    if (!place.AllKey.Contains(word, StringComparison.Ordinal)) { all = false; break; }
                }
                if (!all) { continue; }

                // 0 the name is the whole query, 1 the name is the first word ("perth aus"), 2 the name starts with the
                // query, 3 with the first word, 4 contains the first word, 5 only the region / country match
                int rank = place.NameKey == phrase ? 0
                    : place.NameKey == words[0] ? 1
                    : place.NameKey.StartsWith(phrase, StringComparison.Ordinal) ? 2
                    : place.NameKey.StartsWith(words[0], StringComparison.Ordinal) ? 3
                    : place.NameKey.Contains(words[0], StringComparison.Ordinal) ? 4
                    : 5;
                scored.Add((rank, place.Population, place));
            }
            scored.Sort((a, b) => a.Rank != b.Rank ? a.Rank.CompareTo(b.Rank) : b.Population.CompareTo(a.Population));
            for (int i = 0; i < scored.Count && results.Count < max; i++) { results.Add(scored[i].Place); }
        }

        /// <summary>
        /// The nearest place to a point (great-circle distance), within a limit: typed coordinates borrow its time zone.
        /// </summary>
        /// <param name="maxKm">Farthest place accepted (km).</param>
        /// <param name="distanceKm">Out: how far it is (km), or NaN.</param>
        /// <returns>The place, or null when none is that close.</returns>
        public Place Nearest(double latitude, double longitude, double maxKm, out double distanceKm)
        {
            distanceKm = double.NaN;
            if (!double.IsFinite(latitude) || !double.IsFinite(longitude)) { return null; }
            Place best = null;
            double bestKm = double.MaxValue;
            foreach (Place place in _places)
            {
                double km = DistanceKm(latitude, longitude, place.Latitude, place.Longitude);
                if (km < bestKm)
                {
                    bestKm = km;
                    best = place;
                }
            }
            if (best == null || bestKm > maxKm) { return null; }
            distanceKm = bestKm;
            return best;
        }

        /// <summary>Great-circle distance (km, spherical Earth).</summary>
        public static double DistanceKm(double lat1, double lon1, double lat2, double lon2)
        {
            const double R = 6371.0, D = Math.PI / 180.0;
            double a = Math.Sin((lat2 - lat1) * D / 2), b = Math.Sin((lon2 - lon1) * D / 2);
            double h = a * a + Math.Cos(lat1 * D) * Math.Cos(lat2 * D) * b * b;
            return 2.0 * R * Math.Asin(Math.Min(1.0, Math.Sqrt(h)));
        }

        /// <summary>
        /// Reads typed coordinates: "-33.86, 151.21", "-33.86 151.21", "33.86S 151.21E", "33°51′S, 151°12′E" (degrees
        /// and minutes), as copied from a map.
        /// </summary>
        /// <returns>False when the text isn't a latitude / longitude pair in range.</returns>
        public static bool TryParseCoordinates(string text, out double latitude, out double longitude)
        {
            latitude = longitude = double.NaN;
            if (string.IsNullOrWhiteSpace(text)) { return false; }

            // Split into two halves: at a comma / semicolon, else at the space between two numbers
            string t = text.Trim().Replace('−', '-');
            string[] halves = t.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries);
            if (halves.Length != 2)
            {
                halves = t.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
                if (halves.Length != 2) { return false; }
            }
            if (!TryParseAngle(halves[0], 'N', 'S', out latitude) || !TryParseAngle(halves[1], 'E', 'W', out longitude)) { return false; }
            return Math.Abs(latitude) <= 90.0 && Math.Abs(longitude) <= 180.0;
        }

        /// <summary>One angle: decimal degrees or degrees / minutes / seconds, optional hemisphere letter.</summary>
        private static bool TryParseAngle(string text, char positive, char negative, out double value)
        {
            value = double.NaN;
            string s = text.Trim().ToUpperInvariant();
            double sign = 1.0;
            if (s.EndsWith(positive)) { s = s[..^1]; }
            else if (s.EndsWith(negative)) { s = s[..^1]; sign = -1.0; }
            else if (s.StartsWith(positive)) { s = s[1..]; }
            else if (s.StartsWith(negative)) { s = s[1..]; sign = -1.0; }

            // Degrees / minutes / seconds: split on the symbols
            string[] parts = s.Split(new[] { '°', '\'', '′', '"', '″', ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0 || parts.Length > 3) { return false; }
            double total = 0.0;
            for (int i = 0; i < parts.Length; i++)
            {
                if (!double.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out double part)) { return false; }
                if (i > 0 && (part < 0 || part >= 60)) { return false; }
                total += i == 0 ? Math.Abs(part) : part / (i == 1 ? 60.0 : 3600.0);
                if (i == 0 && part < 0) { sign = -sign; }
            }
            value = sign * total;
            return double.IsFinite(value);
        }

        /// <summary>Lower case without accents ("São Paulo" → "sao paulo") for matching.</summary>
        public static string Fold(string text)
        {
            if (string.IsNullOrEmpty(text)) { return string.Empty; }
            string decomposed = text.ToLowerInvariant().Normalize(NormalizationForm.FormD);
            var builder = new StringBuilder(decomposed.Length);
            foreach (char c in decomposed)
            {
                UnicodeCategory category = CharUnicodeInfo.GetUnicodeCategory(c);
                if (category == UnicodeCategory.NonSpacingMark) { continue; }
                builder.Append(c switch { 'ł' => 'l', 'ø' => 'o', 'đ' => 'd', 'ß' => 's', '–' or '-' or '\'' => ' ', _ => c });
            }
            return string.Join(' ', builder.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries));
        }
    }
}
