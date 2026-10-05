using BimGo.Scene;

// The class belongs to the Extraction namespace
namespace BimGo.Extraction
{
    /// <summary>
    /// The session's two phases: "existing" (what stands before the works) and "new" (the phase the walkthrough
    /// shows, demolishes in and creates clones in). Either may be null in a model without phases.
    /// </summary>
    internal sealed class PhasePair
    {
        /// <summary>The existing phase, or null (no phase before the new one).</summary>
        public Phase Existing { get; init; }

        /// <summary>The new phase, or null (the model has no phases).</summary>
        public Phase New { get; init; }

        /// <summary>Set when a saved phase name was not found in this model and a default was used.</summary>
        public string Note { get; init; }

        /// <summary>The new phase id (InvalidElementId when none).</summary>
        public ElementId NewId => New?.Id ?? ElementId.InvalidElementId;

        /// <summary>The existing phase id (InvalidElementId when none).</summary>
        public ElementId ExistingId => Existing?.Id ?? ElementId.InvalidElementId;
    }

    /// <summary>
    /// Resolves the "existing" and "new" phases from the saved settings (by name), falling back to the launch view's
    /// phase (new) and the phase before it (existing). Also classifies elements against the pair.
    /// Revit API thread only. Never throws.
    /// </summary>
    internal static class PhaseResolver
    {
        /// <summary>
        /// The model's phases in sequence order (empty if none or unreadable).
        /// </summary>
        public static List<Phase> All(Document doc)
        {
            var phases = new List<Phase>();
            try
            {
                PhaseArray array = doc?.Phases;
                if (array == null) { return phases; }
                for (int i = 0; i < array.Size; i++)
                {
                    if (array.get_Item(i) is Phase phase) { phases.Add(phase); }
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Phase list failed: {ex.Message}");
            }
            return phases;
        }

        /// <summary>
        /// A phase by name (case-insensitive), or null.
        /// </summary>
        public static Phase FindByName(Document doc, string name)
        {
            if (string.IsNullOrWhiteSpace(name)) { return null; }
            foreach (Phase phase in All(doc))
            {
                if (string.Equals(phase.Name, name.Trim(), StringComparison.OrdinalIgnoreCase)) { return phase; }
            }
            return null;
        }

        /// <summary>
        /// Resolves the pair for a document.
        /// </summary>
        /// <param name="doc">The document.</param>
        /// <param name="activeView">The launch view (its phase is the default new phase), or null.</param>
        /// <param name="existingName">The saved existing phase name (empty = default).</param>
        /// <param name="newName">The saved new phase name (empty = default).</param>
        public static PhasePair Resolve(Document doc, DB.View activeView, string existingName, string newName)
        {
            List<Phase> phases = All(doc);
            if (phases.Count == 0) { return new PhasePair(); }

            var notes = new List<string>();

            // New: the saved name, else the view's phase, else the last phase
            Phase newPhase = FindIn(phases, newName);
            if (newPhase == null)
            {
                if (!string.IsNullOrWhiteSpace(newName)) { notes.Add($"New phase “{newName}” is not in this model"); }
                newPhase = ViewPhase(doc, activeView) ?? phases[^1];
            }
            int newIndex = IndexOf(phases, newPhase);

            // Existing: the saved name if it comes before the new phase, else the phase just before it
            Phase existing = FindIn(phases, existingName);
            if (existing != null && IndexOf(phases, existing) >= newIndex)
            {
                notes.Add($"Existing phase “{existing.Name}” is not before “{newPhase.Name}”");
                existing = null;
            }
            else if (existing == null && !string.IsNullOrWhiteSpace(existingName))
            {
                notes.Add($"Existing phase “{existingName}” is not in this model");
            }
            if (existing == null && newIndex > 0) { existing = phases[newIndex - 1]; }

            string note = notes.Count == 0 ? null : string.Join("; ", notes) + $": using {existing?.Name ?? "none"} → {newPhase.Name}.";
            if (note != null) { Utilities.Log_Utils.Write("Phases: " + note); }
            return new PhasePair { Existing = existing, New = newPhase, Note = note };
        }

        /// <summary>
        /// Resolves the pair from the launch settings.
        /// </summary>
        public static PhasePair Resolve(Document doc, DB.View activeView, LaunchSettings settings) =>
            Resolve(doc, activeView, settings?.ExistingPhase, settings?.NewPhase);

        /// <summary>
        /// True if the element should appear in a walkthrough of the new phase (not demolished by it, not built
        /// after it). Unphased elements always appear.
        /// </summary>
        public static bool StandsIn(Element element, PhasePair phases)
        {
            if (phases?.New == null)
            {
                // No phases: hide anything demolished (the previous behaviour)
                return element.DemolishedPhaseId == ElementId.InvalidElementId;
            }

            ElementOnPhaseStatus status = StatusIn(element, phases.NewId);
            return status is ElementOnPhaseStatus.Existing or ElementOnPhaseStatus.New or ElementOnPhaseStatus.None;
        }

        /// <summary>
        /// The element's role between the two phases.
        /// </summary>
        public static PhaseRole RoleOf(Element element, PhasePair phases)
        {
            if (phases?.New == null) { return PhaseRole.Existing; }

            ElementOnPhaseStatus inNew = StatusIn(element, phases.NewId);
            switch (inNew)
            {
                case ElementOnPhaseStatus.New:
                case ElementOnPhaseStatus.Temporary:
                    return PhaseRole.New;

                case ElementOnPhaseStatus.None:
                    return PhaseRole.Unphased;
            }

            // Standing in the new phase and built earlier: existing only if it was there in the existing phase
            if (phases.Existing == null) { return PhaseRole.Between; }
            ElementOnPhaseStatus inExisting = StatusIn(element, phases.ExistingId);
            return inExisting is ElementOnPhaseStatus.Existing or ElementOnPhaseStatus.New ? PhaseRole.Existing : PhaseRole.Between;
        }

        /// <summary>
        /// A short reason the element can't be demolished in the new phase, or null if it can.
        /// </summary>
        /// <param name="element">The element.</param>
        /// <param name="phases">The session phases.</param>
        /// <param name="alreadyDone">True if it is already demolished (in the new phase or earlier).</param>
        public static string DemolishBlockReason(Element element, PhasePair phases, out bool alreadyDone)
        {
            alreadyDone = false;
            if (phases?.New == null) { return "The model has no phases to demolish in"; }

            ElementOnPhaseStatus inNew = StatusIn(element, phases.NewId);
            switch (inNew)
            {
                case ElementOnPhaseStatus.Demolished:
                case ElementOnPhaseStatus.Past:
                    alreadyDone = true;
                    return $"Already demolished by {phases.New.Name}";

                case ElementOnPhaseStatus.New:
                case ElementOnPhaseStatus.Temporary:
                    return $"New work in {phases.New.Name}: delete it instead";

                case ElementOnPhaseStatus.Future:
                    return $"Not built yet in {phases.New.Name}";

                case ElementOnPhaseStatus.None:
                    return "This element has no phases: delete it instead";
            }

            if (RoleOf(element, phases) != PhaseRole.Existing)
            {
                return phases.Existing == null
                    ? $"There is no phase before {phases.New.Name} for it to exist in"
                    : $"Built after {phases.Existing.Name}: not existing";
            }
            return null;
        }

        /// <summary>
        /// The element's status in a phase (None if the element has no phases or Revit can't tell).
        /// </summary>
        public static ElementOnPhaseStatus StatusIn(Element element, ElementId phaseId)
        {
            try
            {
                return element.GetPhaseStatus(phaseId);
            }
            catch
            {
                return ElementOnPhaseStatus.None;
            }
        }

        #region Helpers

        private static Phase FindIn(List<Phase> phases, string name)
        {
            if (string.IsNullOrWhiteSpace(name)) { return null; }
            return phases.FirstOrDefault(p => string.Equals(p.Name, name.Trim(), StringComparison.OrdinalIgnoreCase));
        }

        private static int IndexOf(List<Phase> phases, Phase phase)
        {
            for (int i = 0; i < phases.Count; i++)
            {
                if (phases[i].Id == phase.Id) { return i; }
            }
            return -1;
        }

        /// <summary>
        /// The view's phase, or null.
        /// </summary>
        private static Phase ViewPhase(Document doc, DB.View view)
        {
            try
            {
                Parameter parameter = view?.get_Parameter(BuiltInParameter.VIEW_PHASE);
                if (parameter != null && parameter.StorageType == StorageType.ElementId && doc.GetElement(parameter.AsElementId()) is Phase phase)
                {
                    return phase;
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"View phase lookup failed: {ex.Message}");
            }
            return null;
        }

        #endregion
    }
}
