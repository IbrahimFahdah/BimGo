using BimGo.Scene;

// The class belongs to the Extraction namespace
namespace BimGo.Extraction
{
    /// <summary>
    /// One Revit link instance placed in the host model, as offered by the Options dialog.
    /// </summary>
    internal sealed class LinkCandidate
    {
        /// <summary>The RevitLinkInstance's ElementId value in the host.</summary>
        public long InstanceId { get; init; }

        /// <summary>The RevitLinkInstance's UniqueId (the key the choice is remembered by).</summary>
        public string UniqueId { get; init; } = string.Empty;

        /// <summary>The instance name ("Structure.rvt : 2 : location Site").</summary>
        public string Name { get; init; } = string.Empty;

        /// <summary>The linked file / model name used to group instances in the dialog ("Structure.rvt").</summary>
        public string FileName { get; init; } = string.Empty;

        /// <summary>True if the link is loaded (only loaded links can be extracted).</summary>
        public bool IsLoaded { get; init; }

        /// <summary>The linked document (null when not loaded).</summary>
        public Document Document { get; init; }

        /// <summary>The instance's total transform (link coordinates → host internal coordinates, feet).</summary>
        public Transform Transform { get; init; }
    }

    /// <summary>
    /// Finds the host model's Revit link instances and resolves which ones the user ticked for extraction
    /// (<see cref="LaunchSettings.LinkedModels"/>, keyed by <see cref="HostKey"/>). Only top-level instances are
    /// offered: nested links come with their parent link's document but are not extracted (see the README).
    /// Revit API thread only. Never throws.
    /// </summary>
    internal static class LinkResolver
    {
        /// <summary>
        /// The key a host model's link choice is stored under: <c>ProjectInformation.UniqueId</c> (the provenance
        /// model key), else the title for documents without one.
        /// </summary>
        public static string HostKey(Document doc)
        {
            try
            {
                string key = doc?.ProjectInformation?.UniqueId;
                if (!string.IsNullOrEmpty(key)) { return key; }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Host model key unavailable: {ex.Message}");
            }
            return "title:" + (doc?.Title ?? string.Empty);
        }

        /// <summary>
        /// Every link instance placed in the host, sorted by file then instance name.
        /// </summary>
        public static List<LinkCandidate> Candidates(Document doc)
        {
            var candidates = new List<LinkCandidate>();
            if (doc == null) { return candidates; }

            try
            {
                foreach (RevitLinkInstance instance in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>())
                {
                    try
                    {
                        Document linkDoc = null;
                        try { linkDoc = instance.GetLinkDocument(); }
                        catch { /* unloaded or inaccessible */ }

                        string fileName = (doc.GetElement(instance.GetTypeId()) as RevitLinkType)?.Name;
                        if (string.IsNullOrWhiteSpace(fileName)) { fileName = linkDoc?.Title ?? "Revit link"; }

                        candidates.Add(new LinkCandidate
                        {
                            InstanceId = instance.Id.Value,
                            UniqueId = instance.UniqueId ?? string.Empty,
                            Name = string.IsNullOrWhiteSpace(instance.Name) ? fileName : instance.Name,
                            FileName = fileName,
                            IsLoaded = linkDoc != null,
                            Document = linkDoc,
                            Transform = linkDoc != null ? instance.GetTotalTransform() : null
                        });
                    }
                    catch (Exception ex)
                    {
                        Utilities.Log_Utils.Write($"Link instance {instance.Id.Value} skipped: {ex.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Link list failed: {ex.Message}");
            }

            candidates.Sort((a, b) =>
            {
                int byFile = string.Compare(a.FileName, b.FileName, StringComparison.CurrentCultureIgnoreCase);
                return byFile != 0 ? byFile : string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase);
            });
            return candidates;
        }

        /// <summary>
        /// The loaded link instances ticked for this host model (none unless the user picked some). Ticked links that
        /// are no longer loaded or placed are logged and left out.
        /// </summary>
        public static List<LinkCandidate> Selected(Document doc, LaunchSettings settings)
        {
            var selected = new List<LinkCandidate>();
            IReadOnlyList<string> ticked = settings?.LinksFor(HostKey(doc)) ?? Array.Empty<string>();
            if (ticked.Count == 0) { return selected; }

            var wanted = new HashSet<string>(ticked, StringComparer.Ordinal);
            foreach (LinkCandidate candidate in Candidates(doc))
            {
                if (!wanted.Remove(candidate.UniqueId)) { continue; }
                if (!candidate.IsLoaded)
                {
                    Utilities.Log_Utils.Write($"Link “{candidate.Name}” is ticked but not loaded: skipped.");
                    continue;
                }
                selected.Add(candidate);
            }
            if (wanted.Count > 0) { Utilities.Log_Utils.Write($"{wanted.Count} ticked link instance(s) are no longer in the model."); }
            return selected;
        }
    }
}
