using BimGo.Edits;
using BimGo.Scene;

// The class belongs to the Sources namespace
namespace BimGo.Sources
{
    /// <summary>
    /// The model source for a standalone .bimgo file: there is no Revit to ask, so every edit succeeds at once.
    /// The game records successful edits in the document's journal, which is what gets saved.
    ///
    /// Removals mimic Revit's behaviour for hosted inserts: removing a host also removes the elements it hosts
    /// (doors and windows in a wall), using the host ids captured at extraction.
    /// </summary>
    public sealed class FileEditSource : IModelSource
    {
        private readonly Queue<EditResult> _results = new();
        private readonly Dictionary<long, List<long>> _hosted = new();
        private int _nextTicket;

        /// <summary>
        /// Creates the source.
        /// </summary>
        /// <param name="scene">The loaded scene (for host relationships).</param>
        /// <param name="displayName">The file name shown in the HUD.</param>
        public FileEditSource(SceneData scene, string displayName)
        {
            DisplayName = displayName ?? "BimGo file";
            foreach (ElementRecord record in scene.Elements)
            {
                if (record.HostId <= 0) { continue; }
                if (!_hosted.TryGetValue(record.HostId, out List<long> list))
                {
                    list = new List<long>();
                    _hosted[record.HostId] = list;
                }
                list.Add(record.ElementId);
            }
        }

        /// <inheritdoc/>
        public string DisplayName { get; set; }

        /// <inheritdoc/>
        public bool IsRevit => false;

        /// <inheritdoc/>
        public bool CanEdit => true;

        /// <inheritdoc/>
        public int Pending => 0;

        /// <inheritdoc/>
        public int Submit(EditRequest request)
        {
            request.Ticket = ++_nextTicket;
            var result = new EditResult
            {
                Ticket = request.Ticket,
                Op = request.Op,
                Success = true,
                AffectedIds = AffectedBy(request),
                CloneKey = request.NewCloneKey
            };
            _results.Enqueue(result);
            return request.Ticket;
        }

        /// <inheritdoc/>
        public bool TryGetResult(out EditResult result) => _results.TryDequeue(out result);

        /// <inheritdoc/>
        public void Pump(float dt) { }

        /// <summary>
        /// For removals: the target plus everything it hosts (recursively). Empty for other edits and clone targets.
        /// </summary>
        public long[] AffectedBy(EditRequest request)
        {
            bool removal = request.Op == EditOp.Delete || request.Op == EditOp.PhaseDemolish;
            if (!removal || request.ElementId <= 0) { return Array.Empty<long>(); }

            var affected = new List<long> { request.ElementId };
            for (int i = 0; i < affected.Count && i < 10_000; i++)
            {
                if (_hosted.TryGetValue(affected[i], out List<long> hosted)) { affected.AddRange(hosted); }
            }
            return affected.Distinct().ToArray();
        }
    }
}
