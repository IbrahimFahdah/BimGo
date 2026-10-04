using BimGo.Edits;

// The class belongs to the Sources namespace
namespace BimGo.Sources
{
    /// <summary>
    /// Where a walkthrough's model lives, and where its edits go. The game submits every edit (demolish, move,
    /// clone) here and receives answers asynchronously; it never knows whether Revit is involved.
    ///
    /// Implementations:
    /// <list type="bullet">
    /// <item><see cref="Live.LiveSessionSource"/>: a live Revit session; edits travel over the session folders
    /// and Revit applies them through an ExternalEvent.</item>
    /// <item><see cref="FileEditSource"/>: a standalone .bimgo; edits succeed at once and are kept in the journal.</item>
    /// </list>
    /// All members are called on the game thread.
    /// </summary>
    public interface IModelSource
    {
        /// <summary>A short name for the HUD ("Model.rvt" / "Model.bimgo").</summary>
        string DisplayName { get; }

        /// <summary>True when edits are committed to a Revit model (HUD badge, wording, journal provenance).</summary>
        bool IsRevit { get; }

        /// <summary>True when edits can be made at all (false for a read-only or disconnected source).</summary>
        bool CanEdit { get; }

        /// <summary>Requests submitted but not yet answered.</summary>
        int Pending { get; }

        /// <summary>
        /// Submits an edit.
        /// </summary>
        /// <returns>A ticket echoed in the result, or -1 if the edit could not be submitted.</returns>
        int Submit(EditRequest request);

        /// <summary>
        /// Takes the next answer, if any.
        /// </summary>
        bool TryGetResult(out EditResult result);

        /// <summary>
        /// Per-frame housekeeping (re-signalling a busy Revit, heartbeat checks...).
        /// </summary>
        /// <param name="dt">Frame time in seconds.</param>
        void Pump(float dt);
    }
}
