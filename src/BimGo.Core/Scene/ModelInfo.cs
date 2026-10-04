using System.Numerics;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// Where a snapshot came from. Written into every .bimgo manifest so a file can be matched back to its model
    /// (by <see cref="ModelKey"/>) and so journal edits can later be pushed into a live session of the same model.
    /// </summary>
    public sealed class ModelProvenance
    {
        /// <summary>The model title as Revit shows it.</summary>
        public string ModelTitle { get; set; } = string.Empty;

        /// <summary>The model's file path (local / central), or empty for unsaved and cloud models.</summary>
        public string ModelPath { get; set; } = string.Empty;

        /// <summary>
        /// The model identity key: <c>ProjectInformation.UniqueId</c>. Stable across local copies of a central model.
        /// </summary>
        public string ModelKey { get; set; } = string.Empty;

        /// <summary>True for cloud (ACC / BIM 360) models.</summary>
        public bool IsCloud { get; set; }

        /// <summary>Cloud project GUID, or empty.</summary>
        public string CloudProjectId { get; set; } = string.Empty;

        /// <summary>Cloud model GUID, or empty.</summary>
        public string CloudModelId { get; set; } = string.Empty;

        /// <summary>True if the model is workshared.</summary>
        public bool IsWorkshared { get; set; }

        /// <summary>The Revit version that extracted it (e.g. "2026").</summary>
        public string RevitVersion { get; set; } = string.Empty;

        /// <summary>The BimGo add-in version that extracted it.</summary>
        public string AddinVersion { get; set; } = string.Empty;

        /// <summary>The Windows user who extracted it.</summary>
        public string User { get; set; } = string.Empty;

        /// <summary>The machine it was extracted on.</summary>
        public string Machine { get; set; } = string.Empty;

        /// <summary>When it was extracted (UTC).</summary>
        public DateTime ExtractedUtc { get; set; }
    }

    /// <summary>
    /// A survey / base point: its position in Revit internal coordinates (metres) and its shared coordinates.
    /// </summary>
    public sealed class SitePoint
    {
        /// <summary>Position in Revit internal coordinates (metres).</summary>
        public Vector3 Position { get; set; }

        /// <summary>Position in shared coordinates (metres).</summary>
        public Vector3 SharedPosition { get; set; }
    }

    /// <summary>
    /// Site orientation and reference points, captured for coordinate readouts and sun / shadow studies.
    /// </summary>
    public sealed class SiteInfo
    {
        /// <summary>
        /// Angle from project north to true north (radians, as Revit's <c>ProjectPosition.Angle</c>), 0 if unknown.
        /// </summary>
        public float TrueNorthAngle { get; set; }

        /// <summary>The project base point, or null.</summary>
        public SitePoint ProjectBasePoint { get; set; }

        /// <summary>The survey point, or null.</summary>
        public SitePoint SurveyPoint { get; set; }
    }

    /// <summary>
    /// Optional parameter values per element, stored compactly: parameter names and values are pooled strings, and
    /// each element holds (name index, value index) pairs. Repeated values (levels, type marks, phases...) are stored
    /// once, which keeps extracts small even with many elements.
    /// </summary>
    public sealed class ParameterTable
    {
        /// <summary>An empty table (no extra parameters were extracted).</summary>
        public static ParameterTable Empty { get; } = new(Array.Empty<string>(), Array.Empty<string>(), Array.Empty<int[]>());

        /// <summary>
        /// Creates a table.
        /// </summary>
        /// <param name="names">Parameter names (pooled).</param>
        /// <param name="values">Parameter values (pooled).</param>
        /// <param name="rows">Per element (same order as SceneData.Elements): flattened name/value index pairs, or null.</param>
        public ParameterTable(string[] names, string[] values, int[][] rows)
        {
            Names = names ?? Array.Empty<string>();
            Values = values ?? Array.Empty<string>();
            Rows = rows ?? Array.Empty<int[]>();
        }

        /// <summary>Pooled parameter names.</summary>
        public string[] Names { get; }

        /// <summary>Pooled parameter values.</summary>
        public string[] Values { get; }

        /// <summary>Per element: [name0, value0, name1, value1, ...] indices, or null when the element has none.</summary>
        public int[][] Rows { get; }

        /// <summary>True if no parameters were extracted.</summary>
        public bool IsEmpty => Names.Length == 0;

        /// <summary>
        /// Number of parameters stored for an element.
        /// </summary>
        /// <param name="element">Index into SceneData.Elements.</param>
        public int CountFor(int element)
        {
            if ((uint)element >= (uint)Rows.Length || Rows[element] == null) { return 0; }
            return Rows[element].Length / 2;
        }

        /// <summary>
        /// Gets one parameter of an element (no allocation).
        /// </summary>
        /// <param name="element">Index into SceneData.Elements.</param>
        /// <param name="slot">0 .. <see cref="CountFor"/> - 1.</param>
        /// <param name="name">The parameter name.</param>
        /// <param name="value">The display value.</param>
        /// <returns>False if out of range.</returns>
        public bool TryGet(int element, int slot, out string name, out string value)
        {
            name = value = null;
            if ((uint)element >= (uint)Rows.Length) { return false; }
            int[] row = Rows[element];
            if (row == null || slot < 0 || slot * 2 + 1 >= row.Length) { return false; }

            int n = row[slot * 2], v = row[slot * 2 + 1];
            if ((uint)n >= (uint)Names.Length || (uint)v >= (uint)Values.Length) { return false; }
            name = Names[n];
            value = Values[v];
            return true;
        }
    }

    /// <summary>
    /// Builds a <see cref="ParameterTable"/> one element at a time (used during extraction).
    /// </summary>
    public sealed class ParameterTableBuilder
    {
        private readonly List<string> _names = new();
        private readonly Dictionary<string, int> _nameIndex = new(StringComparer.Ordinal);
        private readonly List<string> _values = new();
        private readonly Dictionary<string, int> _valueIndex = new(StringComparer.Ordinal);
        private readonly List<int[]> _rows = new();
        private readonly List<int> _current = new();

        /// <summary>
        /// Adds a value to the element being built.
        /// </summary>
        public void Add(string name, string value)
        {
            if (string.IsNullOrEmpty(name)) { return; }
            _current.Add(Intern(_names, _nameIndex, name));
            _current.Add(Intern(_values, _valueIndex, value ?? string.Empty));
        }

        /// <summary>
        /// Closes the current element's row (call once per extracted element, in element order).
        /// </summary>
        public void EndElement()
        {
            _rows.Add(_current.Count == 0 ? null : _current.ToArray());
            _current.Clear();
        }

        /// <summary>
        /// Discards the current element's values (the element was skipped).
        /// </summary>
        public void DiscardElement() => _current.Clear();

        /// <summary>
        /// The finished table (empty if nothing was added).
        /// </summary>
        public ParameterTable Build()
        {
            if (_names.Count == 0) { return ParameterTable.Empty; }
            return new ParameterTable(_names.ToArray(), _values.ToArray(), _rows.ToArray());
        }

        private static int Intern(List<string> list, Dictionary<string, int> index, string text)
        {
            if (index.TryGetValue(text, out int existing)) { return existing; }
            int added = list.Count;
            list.Add(text);
            index[text] = added;
            return added;
        }
    }
}
