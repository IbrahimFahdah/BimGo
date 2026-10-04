using System.Numerics;
using System.Text.Json.Serialization;

// The class belongs to the Format namespace
namespace BimGo.Format
{
    /// <summary>
    /// One persisted comment. Coordinates are metres in Revit's internal coordinate system,
    /// so markers stay put across sessions regardless of the scene origin.
    /// Stored in the Revit-session sidecar (&lt;model&gt;.bimgo-comments.json) or in a .bimgo file's comments.json.
    /// </summary>
    public sealed class CommentRecord
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

        /// <summary>When the text was last edited, or null if never.</summary>
        public DateTimeOffset? Edited { get; set; }

        /// <summary>Who last edited the text, or null.</summary>
        public string EditedBy { get; set; }

        /// <summary>Scene-local position (not serialised).</summary>
        [JsonIgnore]
        public Vector3 Local { get; set; }

        /// <summary>Pre-formatted "COMMENT · AUTHOR · date" header (not serialised).</summary>
        [JsonIgnore]
        public string Header { get; set; } = string.Empty;
    }

    /// <summary>
    /// A set of comments (the sidecar document, or comments.json inside a .bimgo).
    /// </summary>
    public sealed class CommentDocument
    {
        public int Version { get; set; } = 1;
        public string Model { get; set; } = string.Empty;
        public string Units { get; set; } = "metres, Revit internal coordinates";
        public List<CommentRecord> Comments { get; set; } = new();
    }
}
