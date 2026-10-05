using System.Numerics;
using System.Text.Json.Serialization;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// One Revit link instance whose elements were extracted into the snapshot (picked per instance in the Options
    /// dialog; none by default). Linked elements are baked into scene coordinates with the instance's total transform,
    /// keep their own ElementId / UniqueId namespace (see <see cref="ElementRecord.Link"/>) and are read-only in the
    /// walkthrough. Also the DTO written to <c>model.json</c> (<c>links[]</c>).
    /// </summary>
    public sealed class LinkInfo
    {
        /// <summary>
        /// The link's number in the snapshot: 1 for the first link, 2 for the second… (0 is the host model, so
        /// <c>Scene.Links[n - 1]</c> is link n).
        /// </summary>
        public int Index { get; set; }

        /// <summary>The instance name as Revit shows it ("Structure.rvt : 2 : location Site").</summary>
        public string Name { get; set; } = string.Empty;

        /// <summary>The linked model's title ("Structure").</summary>
        public string Title { get; set; } = string.Empty;

        /// <summary>The RevitLinkInstance's ElementId value in the host model (Show in Revit selects it).</summary>
        public long InstanceId { get; set; }

        /// <summary>The RevitLinkInstance's UniqueId in the host model (how the Options dialog remembers the choice).</summary>
        public string InstanceUniqueId { get; set; } = string.Empty;

        /// <summary>The linked model's identity key (<c>ProjectInformation.UniqueId</c>), or empty.</summary>
        public string ModelKey { get; set; } = string.Empty;

        /// <summary>The linked model's path, or empty (cloud / unknown).</summary>
        public string ModelPath { get; set; } = string.Empty;

        /// <summary>The instance's total transform origin in host internal coordinates (metres, double precision).</summary>
        public double OriginX { get; set; }

        /// <summary>See <see cref="OriginX"/>.</summary>
        public double OriginY { get; set; }

        /// <summary>See <see cref="OriginX"/>.</summary>
        public double OriginZ { get; set; }

        /// <summary>The transform's X basis (link X axis in host coordinates).</summary>
        public Vector3 BasisX { get; set; } = Vector3.UnitX;

        /// <summary>The transform's Y basis.</summary>
        public Vector3 BasisY { get; set; } = Vector3.UnitY;

        /// <summary>The transform's Z basis.</summary>
        public Vector3 BasisZ { get; set; } = Vector3.UnitZ;

        /// <summary>The link's phase the walkthrough shows (same name as the host's new phase, else its last), or null.</summary>
        public string PhaseName { get; set; }

        /// <summary>The link's existing phase (same name as the host's existing phase, else the one before), or null.</summary>
        public string ExistingPhaseName { get; set; }

        /// <summary>Number of elements extracted from this link.</summary>
        public int ElementCount { get; set; }

        /// <summary>Number of rooms taken from this link.</summary>
        public int RoomCount { get; set; }

        /// <summary>A short label for the HUD: the title, else the instance name (not saved).</summary>
        [JsonIgnore]
        public string Label => !string.IsNullOrWhiteSpace(Title) ? Title : string.IsNullOrWhiteSpace(Name) ? $"Link {Index}" : Name;
    }
}
