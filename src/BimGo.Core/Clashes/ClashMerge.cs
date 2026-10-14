using BimGo.Scene;

// The class belongs to the Clashes namespace
namespace BimGo.Clashes
{
    /// <summary>
    /// What merging one run changed (for the notice and the run history).
    /// </summary>
    public readonly record struct ClashMergeResult(int Found, int New, int Reopened, int NewlyResolved);

    /// <summary>
    /// Turns a run's hits into clash records and merges them into the document (Round C): a clash is the same clash
    /// in a later run when its test and element pair match (<see cref="ClashRecord.Key"/>). Found again: new → active,
    /// resolved → active; reviewed / approved stay. Missing from a complete run: resolved. A truncated run resolves
    /// nothing (it didn't look everywhere). Assignee, notes and comment links always stay.
    /// </summary>
    public static class ClashMerge
    {
        /// <summary>
        /// Builds a record per hit (points in Revit internal metres; the element pair as stable references).
        /// </summary>
        public static List<ClashRecord> ToRecords(ClashJob job, ClashRunResult result, string testId)
        {
            var records = new List<ClashRecord>(result.Hits.Count);
            SceneData scene = job.Scene;
            foreach (ClashHit hit in result.Hits)
            {
                ClashItem a = job.Items[hit.ItemA], b = job.Items[hit.ItemB];
                var record = new ClashRecord
                {
                    TestId = testId,
                    A = RefOf(scene, a),
                    B = RefOf(scene, b),
                    X = hit.Point.X + (double)scene.OriginOffset.X,
                    Y = hit.Point.Y + (double)scene.OriginOffset.Y,
                    Z = hit.Point.Z + (double)scene.OriginOffset.Z,
                    Distance = hit.Distance,
                    Crossing = hit.Crossing,
                    Approximate = hit.Approximate
                };

                // Self tests: a stable order inside the pair, so the record reads the same run after run
                if (string.CompareOrdinal(record.A.Key, record.B.Key) > 0 && job.SetB == null) { (record.A, record.B) = (record.B, record.A); }
                records.Add(record);
            }
            return records;
        }

        /// <summary>
        /// A model element's key as clashes store it (<see cref="ClashElementRef.Key"/> of an element that isn't a
        /// clone): link + UniqueId (or ElementId). Lets the app find a clash's elements again.
        /// </summary>
        public static string ElementKey(SceneData scene, int element)
        {
            ElementRecord e = scene.Elements[element];
            return LinkKey(scene, e) + "/" + (!string.IsNullOrEmpty(e.UniqueId) ? e.UniqueId : "id:" + e.ElementId);
        }

        /// <summary>The link part of an element's key: empty for the host, else the link instance's UniqueId.</summary>
        private static string LinkKey(SceneData scene, ElementRecord e)
        {
            LinkInfo link = scene.LinkOf(e);
            return link != null ? (string.IsNullOrEmpty(link.InstanceUniqueId) ? "link:" + link.Index : link.InstanceUniqueId)
                : e.IsLinked ? "link:" + e.Link : string.Empty;
        }

        /// <summary>
        /// The stable reference to an item's element.
        /// </summary>
        public static ClashElementRef RefOf(SceneData scene, in ClashItem item)
        {
            ElementRecord e = scene.Elements[item.Element];
            return new ClashElementRef
            {
                UniqueId = item.CloneKey > 0 ? string.Empty : e.UniqueId ?? string.Empty,
                ElementId = item.CloneKey > 0 ? 0 : e.ElementId,
                Link = LinkKey(scene, e),
                CloneKey = item.CloneKey,
                IfcGuid = item.CloneKey > 0 || string.IsNullOrEmpty(e.IfcGuid) ? null : e.IfcGuid,
                Category = e.CategoryName ?? string.Empty,
                FamilyType = e.FamilyType ?? string.Empty,
                Level = e.LevelName ?? string.Empty
            };
        }

        /// <summary>
        /// Merges a finished run of <paramref name="test"/> into the document and records it in the history.
        /// </summary>
        /// <param name="document">The clash document.</param>
        /// <param name="test">The test that ran.</param>
        /// <param name="found">The run's records (<see cref="ToRecords"/>).</param>
        /// <param name="complete">False when the run stopped at the limit (nothing is resolved then).</param>
        /// <param name="utc">When it finished.</param>
        /// <param name="modelState">The model state stamp (for "model changed since the last run").</param>
        /// <param name="countA">Elements in set A.</param>
        /// <param name="countB">Elements in set B.</param>
        /// <param name="seconds">Run time.</param>
        public static ClashMergeResult Apply(ClashDocument document, ClashTest test, IReadOnlyList<ClashRecord> found, bool complete,
            DateTime utc, string modelState, int countA, int countB, double seconds)
        {
            var existing = new Dictionary<string, ClashRecord>(StringComparer.Ordinal);
            foreach (ClashRecord clash in document.Clashes)
            {
                if (clash.TestId == test.Id) { existing.TryAdd(clash.Key, clash); }
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            int added = 0, reopened = 0;
            foreach (ClashRecord record in found)
            {
                record.TestId = test.Id; // the key includes the test: set it before matching, whatever the caller filled in
                string key = record.Key;
                if (!seen.Add(key)) { continue; }
                if (existing.TryGetValue(key, out ClashRecord known))
                {
                    known.A = record.A;
                    known.B = record.B;
                    known.X = record.X;
                    known.Y = record.Y;
                    known.Z = record.Z;
                    known.Distance = record.Distance;
                    known.Crossing = record.Crossing;
                    known.Approximate = record.Approximate;
                    known.LastSeenUtc = utc;
                    if (known.Status == ClashStatus.RESOLVED)
                    {
                        known.Status = ClashStatus.ACTIVE;
                        known.ResolvedUtc = null;
                        reopened++;
                    }
                    else if (known.Status == ClashStatus.NEW)
                    {
                        known.Status = ClashStatus.ACTIVE;
                    }
                    continue;
                }

                record.TestId = test.Id;
                record.Status = ClashStatus.NEW;
                record.FoundUtc = utc;
                record.LastSeenUtc = utc;
                document.Clashes.Add(record);
                added++;
            }

            int resolved = 0;
            if (complete)
            {
                foreach (KeyValuePair<string, ClashRecord> pair in existing)
                {
                    if (seen.Contains(pair.Key) || pair.Value.Status == ClashStatus.RESOLVED) { continue; }
                    pair.Value.Status = ClashStatus.RESOLVED;
                    pair.Value.ResolvedUtc = utc;
                    resolved++;
                }
            }

            test.LastRunUtc = utc;
            test.LastRunModel = modelState;
            test.LastRunTruncated = !complete;

            document.Runs.Add(new ClashRunRecord
            {
                Utc = utc,
                TestId = test.Id,
                Found = seen.Count,
                New = added,
                NewlyResolved = resolved,
                ByStatus = CountByStatus(document, test.Id),
                ElementsA = countA,
                ElementsB = countB,
                Seconds = Math.Round(seconds, 2),
                Truncated = !complete
            });
            if (document.Runs.Count > ClashDefaults.MAX_RUNS) { document.Runs.RemoveRange(0, document.Runs.Count - ClashDefaults.MAX_RUNS); }
            return new ClashMergeResult(seen.Count, added, reopened, resolved);
        }

        /// <summary>
        /// A test's clashes per status (<see cref="ClashStatus.All"/> order).
        /// </summary>
        public static int[] CountByStatus(ClashDocument document, string testId)
        {
            int[] counts = new int[ClashStatus.All.Length];
            foreach (ClashRecord clash in document.Clashes)
            {
                if (clash.TestId == testId) { counts[ClashStatus.IndexOf(clash.Status)]++; }
            }
            return counts;
        }

        /// <summary>
        /// A person changes a clash's status (stamped, so report imports keep the newer change).
        /// </summary>
        public static void SetStatus(ClashRecord clash, string status, string user, DateTime utc)
        {
            clash.Status = ClashStatus.Normalise(status);
            if (clash.Status != ClashStatus.RESOLVED) { clash.ResolvedUtc = null; }
            Stamp(clash, user, utc);
        }

        /// <summary>
        /// A person changes the assignee or notes (null leaves that one alone; empty clears it).
        /// </summary>
        public static void SetDetails(ClashRecord clash, string assignedTo, string notes, string user, DateTime utc)
        {
            if (assignedTo != null) { clash.AssignedTo = assignedTo.Length == 0 ? null : assignedTo; }
            if (notes != null) { clash.Notes = notes.Length == 0 ? null : notes; }
            Stamp(clash, user, utc);
        }

        private static void Stamp(ClashRecord clash, string user, DateTime utc)
        {
            clash.Updated = utc;
            clash.UpdatedBy = user;
        }

        /// <summary>
        /// RESET RESULTS (C-B1 fixes): keeps the test but drops its clashes (statuses, assignees, notes and comment
        /// links with them) and its run history, and forgets its last run, so the next RUN starts fresh (all new).
        /// </summary>
        /// <returns>How many clashes were dropped.</returns>
        public static int ResetTest(ClashDocument document, ClashTest test)
        {
            if (document == null || test == null) { return 0; }
            int removed = document.Clashes.RemoveAll(c => c.TestId == test.Id);
            document.Runs.RemoveAll(r => r.TestId == test.Id);
            test.LastRunUtc = null;
            test.LastRunModel = null;
            test.LastRunTruncated = false;
            return removed;
        }

        /// <summary>True when a test has results: it has run, or has clashes (from a run or an imported report).</summary>
        public static bool HasResults(ClashDocument document, ClashTest test)
        {
            if (document == null || test == null) { return false; }
            if (test.LastRunUtc != null) { return true; }
            foreach (ClashRecord clash in document.Clashes)
            {
                if (clash.TestId == test.Id) { return true; }
            }
            return false;
        }

        /// <summary>
        /// Removes a test and its clashes and history (its sets stay).
        /// </summary>
        public static void RemoveTest(ClashDocument document, string testId)
        {
            document.Tests.RemoveAll(t => t.Id == testId);
            document.Clashes.RemoveAll(c => c.TestId == testId);
            document.Runs.RemoveAll(r => r.TestId == testId);
        }
    }
}
