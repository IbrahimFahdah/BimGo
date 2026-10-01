using System.Numerics;
using System.Text.Json;
using System.Text.Json.Serialization;

// The class belongs to the Game namespace
namespace RvtGo.Game
{
    /// <summary>
    /// One persisted comment. Coordinates are metres in Revit's internal coordinate system,
    /// so markers stay put across sessions regardless of the scene origin.
    /// </summary>
    internal sealed class CommentRecord
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");
        public string Author { get; set; } = Environment.UserName;
        public DateTimeOffset Created { get; set; } = DateTimeOffset.Now;
        public string Text { get; set; } = string.Empty;
        public double X { get; set; }
        public double Y { get; set; }
        public double Z { get; set; }
        public long ElementId { get; set; } = -1;
        public string Level { get; set; } = string.Empty;

        /// <summary>Scene-local position (not serialised).</summary>
        [JsonIgnore]
        public Vector3 Local { get; set; }

        /// <summary>Pre-formatted "AUTHOR · HH:mm" header (not serialised).</summary>
        [JsonIgnore]
        public string Header { get; set; } = string.Empty;
    }

    /// <summary>
    /// The JSON sidecar document.
    /// </summary>
    internal sealed class CommentDocument
    {
        public int Version { get; set; } = 1;
        public string Model { get; set; } = string.Empty;
        public string Units { get; set; } = "metres, Revit internal coordinates";
        public List<CommentRecord> Comments { get; set; } = new();
    }

    /// <summary>
    /// Loads and saves comments to &lt;model&gt;.rvtgo.json. All IO failures are caught and reported via <see cref="LastError"/>.
    /// </summary>
    internal sealed class CommentStore
    {
        private static readonly JsonSerializerOptions OPTIONS = new() { WriteIndented = true };

        private readonly string _path;
        private readonly string _model;
        private readonly Vector3 _origin;

        /// <summary>All comments.</summary>
        public List<CommentRecord> Comments { get; } = new();

        /// <summary>The last IO error, or null.</summary>
        public string LastError { get; private set; }

        /// <summary>The sidecar file name (for the HUD).</summary>
        public string FileName => Path.GetFileName(_path);

        /// <summary>
        /// Creates the store.
        /// </summary>
        /// <param name="path">Sidecar path.</param>
        /// <param name="model">Model title.</param>
        /// <param name="origin">Scene origin offset (metres).</param>
        public CommentStore(string path, string model, Vector3 origin)
        {
            _path = path;
            _model = model;
            _origin = origin;
        }

        /// <summary>
        /// Loads the sidecar if it exists.
        /// </summary>
        public void Load()
        {
            try
            {
                if (!File.Exists(_path)) { return; }
                CommentDocument document = JsonSerializer.Deserialize<CommentDocument>(File.ReadAllText(_path), OPTIONS);
                if (document?.Comments == null) { return; }

                foreach (CommentRecord record in document.Comments)
                {
                    if (string.IsNullOrWhiteSpace(record.Text)) { continue; }
                    Prepare(record);
                    Comments.Add(record);
                }
            }
            catch (Exception ex)
            {
                LastError = $"Comments could not be read: {ex.Message}";
                Utilities.Log_Utils.Write(LastError);
            }
        }

        /// <summary>
        /// Adds a comment at a scene-local position and saves.
        /// </summary>
        public CommentRecord Add(Vector3 local, string text, long elementId, string level)
        {
            var record = new CommentRecord
            {
                Text = text.Trim(),
                X = Math.Round(local.X + (double)_origin.X, 4),
                Y = Math.Round(local.Y + (double)_origin.Y, 4),
                Z = Math.Round(local.Z + (double)_origin.Z, 4),
                ElementId = elementId,
                Level = level ?? string.Empty
            };
            Prepare(record);
            Comments.Add(record);
            Save();
            return record;
        }

        /// <summary>
        /// Removes a comment and saves.
        /// </summary>
        public void Remove(CommentRecord record)
        {
            if (Comments.Remove(record)) { Save(); }
        }

        /// <summary>
        /// Removes all comments and saves.
        /// </summary>
        public void Clear()
        {
            Comments.Clear();
            Save();
        }

        /// <summary>
        /// Writes the sidecar (atomically via a temp file).
        /// </summary>
        /// <returns>True on success.</returns>
        public bool Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path));
                var document = new CommentDocument { Model = _model, Comments = Comments };
                string temp = _path + ".tmp";
                File.WriteAllText(temp, JsonSerializer.Serialize(document, OPTIONS));
                File.Move(temp, _path, overwrite: true);
                LastError = null;
                return true;
            }
            catch (Exception ex)
            {
                LastError = $"Comments could not be saved: {ex.Message}";
                Utilities.Log_Utils.Write(LastError);
                return false;
            }
        }

        private void Prepare(CommentRecord record)
        {
            record.Local = new Vector3((float)(record.X - _origin.X), (float)(record.Y - _origin.Y), (float)(record.Z - _origin.Z));
            record.Header = $"COMMENT · {record.Author?.ToUpperInvariant()} · {record.Created.ToLocalTime():dd MMM HH:mm}";
        }
    }
}
