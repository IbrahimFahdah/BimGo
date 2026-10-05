// The class belongs to the Utilities namespace
namespace BimGo.Utilities
{
    /// <summary>
    /// Progress and cancellation shared between a long task and the UI that shows it (possibly on another thread).
    /// The task calls <see cref="Begin"/> for each stage (with the share of the whole bar it covers), then
    /// <see cref="Step"/> as it goes, and <see cref="ThrowIfCancelled"/> at safe points; the UI polls
    /// <see cref="Read"/> and calls <see cref="Cancel"/>. Thread-safe and allocation-free per step.
    /// </summary>
    public sealed class OperationProgress
    {
        private readonly object _lock = new();
        private string _stage = string.Empty;
        private string _detail = string.Empty;
        private double _start, _end = 1.0, _fraction;
        private volatile bool _cancelled;

        /// <summary>True once the user asked to cancel.</summary>
        public bool CancelRequested => _cancelled;

        /// <summary>False while the task is in a part that must not be interrupted (the UI greys its Cancel button).</summary>
        public bool CanCancel { get; set; } = true;

        /// <summary>
        /// Starts a stage that fills the bar from <paramref name="start"/> to <paramref name="end"/> (0..1).
        /// </summary>
        /// <param name="stage">What is happening, for people ("Reading geometry").</param>
        /// <param name="start">Where the bar is when the stage starts.</param>
        /// <param name="end">Where the bar is when the stage ends.</param>
        public void Begin(string stage, double start, double end)
        {
            lock (_lock)
            {
                _stage = stage ?? string.Empty;
                _detail = string.Empty;
                _start = Math.Clamp(start, 0.0, 1.0);
                _end = Math.Clamp(Math.Max(end, start), 0.0, 1.0);
                _fraction = _start;
            }
        }

        /// <summary>
        /// Moves the bar within the current stage.
        /// </summary>
        /// <param name="local">How far through the stage (0..1).</param>
        public void Step(double local)
        {
            lock (_lock) { _fraction = _start + (_end - _start) * Math.Clamp(local, 0.0, 1.0); }
        }

        /// <summary>
        /// Moves the bar within the current stage by a count.
        /// </summary>
        public void Step(long done, long total) => Step(total <= 0 ? 0.0 : (double)done / total);

        /// <summary>
        /// Sets a short second line ("1,240 of 8,310 elements").
        /// </summary>
        public void Detail(string detail)
        {
            lock (_lock) { _detail = detail ?? string.Empty; }
        }

        /// <summary>
        /// Reads the current state (for the UI).
        /// </summary>
        public void Read(out string stage, out string detail, out double fraction)
        {
            lock (_lock)
            {
                stage = _stage;
                detail = _detail;
                fraction = _fraction;
            }
        }

        /// <summary>Asks the task to stop at its next safe point.</summary>
        public void Cancel()
        {
            if (CanCancel) { _cancelled = true; }
        }

        /// <summary>
        /// Throws <see cref="OperationCanceledException"/> if the user cancelled.
        /// </summary>
        public void ThrowIfCancelled()
        {
            if (_cancelled) { throw new OperationCanceledException("Cancelled."); }
        }
    }
}
