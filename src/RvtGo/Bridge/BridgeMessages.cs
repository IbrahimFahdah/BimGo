using System.Collections.Concurrent;
using System.Numerics;

// The class belongs to the Bridge namespace
namespace RvtGo.Bridge
{
    /// <summary>
    /// What a request asks Revit to do.
    /// </summary>
    internal enum BridgeOp
    {
        /// <summary>Set Phase Demolished to the session's phase.</summary>
        PhaseDemolish,

        /// <summary>Delete the element (and anything Revit deletes with it).</summary>
        Delete,

        /// <summary>Rotate about a vertical axis through a pivot, then translate.</summary>
        Transform,

        /// <summary>Copy the element, then rotate and translate the copy.</summary>
        Copy
    }

    /// <summary>
    /// A request from the game thread to the Revit thread. Plain data only: no Revit types.
    /// All points and vectors are Revit internal coordinates in metres (scene-local + origin offset).
    /// </summary>
    internal sealed class BridgeRequest
    {
        /// <summary>Unique id, echoed in the result.</summary>
        public int Ticket { get; set; }

        /// <summary>The operation.</summary>
        public BridgeOp Op { get; init; }

        /// <summary>The target's Revit ElementId value, or 0 when the target is a pending clone (see <see cref="TargetCloneKey"/>).</summary>
        public long ElementId { get; init; }

        /// <summary>
        /// When non-zero, the target is a clone created earlier in this session whose Revit id the game may not
        /// know yet; the Revit side resolves it from its own key map (requests run in order).
        /// </summary>
        public int TargetCloneKey { get; init; }

        /// <summary>For <see cref="BridgeOp.Copy"/>: the key the new element is registered under.</summary>
        public int NewCloneKey { get; init; }

        /// <summary>Rotation pivot (metres, Revit internal) before any translation.</summary>
        public Vector3 Pivot { get; init; }

        /// <summary>Translation applied after the rotation (metres).</summary>
        public Vector3 Translation { get; init; }

        /// <summary>Rotation about +Z (radians, counter-clockwise).</summary>
        public float Angle { get; init; }

        /// <summary>A short label for the Revit transaction / undo list.</summary>
        public string Label { get; init; }
    }

    /// <summary>
    /// The Revit thread's answer to a request.
    /// </summary>
    internal sealed class BridgeResult
    {
        /// <summary>The request's ticket.</summary>
        public int Ticket { get; init; }

        /// <summary>The request's operation.</summary>
        public BridgeOp Op { get; init; }

        /// <summary>True if the change was committed in Revit.</summary>
        public bool Success { get; init; }

        /// <summary>A short, user-facing reason on failure (or a note on success).</summary>
        public string Message { get; init; }

        /// <summary>For delete / demolish: every element Revit deleted or demolished as a result (ElementId values).</summary>
        public long[] AffectedIds { get; init; } = Array.Empty<long>();

        /// <summary>For copy: the new element's ElementId value.</summary>
        public long NewElementId { get; init; }

        /// <summary>For copy: the clone key from the request.</summary>
        public int CloneKey { get; init; }
    }

    /// <summary>
    /// The thread-safe link between one game session and the Revit thread.
    /// The game thread submits requests and drains results; the Revit-side handler does the reverse.
    /// </summary>
    internal sealed class BridgeChannel
    {
        private readonly ConcurrentQueue<BridgeRequest> _requests = new();
        private readonly ConcurrentQueue<BridgeResult> _results = new();
        private readonly Action _raise;
        private int _nextTicket;
        private int _pending;

        /// <summary>
        /// Creates a channel.
        /// </summary>
        /// <param name="raise">Wakes the Revit-side handler (ExternalEvent.Raise).</param>
        public BridgeChannel(Action raise)
        {
            _raise = raise;
        }

        /// <summary>Requests submitted but not yet answered.</summary>
        public int Pending => Volatile.Read(ref _pending);

        /// <summary>
        /// Game thread: queues a request and wakes Revit.
        /// </summary>
        /// <returns>The request's ticket, or -1 if Revit could not be signalled.</returns>
        public int Submit(BridgeRequest request)
        {
            request.Ticket = Interlocked.Increment(ref _nextTicket);
            _requests.Enqueue(request);
            Interlocked.Increment(ref _pending);
            try
            {
                _raise();
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Bridge raise failed: {ex.Message}");
            }
            return request.Ticket;
        }

        /// <summary>
        /// Game thread: re-signals Revit (used when requests have waited a while, in case a raise was missed
        /// while the handler was finishing its previous batch).
        /// </summary>
        public void Nudge()
        {
            try { _raise(); }
            catch (Exception ex) { Utilities.Log_Utils.Write($"Bridge nudge failed: {ex.Message}"); }
        }

        /// <summary>
        /// Game thread: takes the next result, if any.
        /// </summary>
        public bool TryGetResult(out BridgeResult result) => _results.TryDequeue(out result);

        /// <summary>
        /// Revit thread: takes the next request, if any.
        /// </summary>
        internal bool TryTakeRequest(out BridgeRequest request) => _requests.TryDequeue(out request);

        /// <summary>
        /// Revit thread: posts a result.
        /// </summary>
        internal void Post(BridgeResult result)
        {
            _results.Enqueue(result);
            Interlocked.Decrement(ref _pending);
        }
    }
}
