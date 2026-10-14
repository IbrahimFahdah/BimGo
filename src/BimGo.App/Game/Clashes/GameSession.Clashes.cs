using BimGo.Audio;
using BimGo.Clashes;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Scene;
using BimGo.Utilities;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Clash detection, session side (Round C, build C-A): dormant until switched on (Y or pause menu → CLASHES):
    /// until then nothing is parsed, built or run, and nothing runs per frame. Switched on, it loads the model's clash
    /// document (the file's <c>clashes.json</c>, or the live model folder's), seeding the two starter tests when there
    /// is none, runs tests on a worker with progress and cancel (Core <see cref="ClashEngine"/>) on the model as walked
    /// (moved elements where they are now, clones and placements included, demolished / deleted left out; hidden
    /// elements still count: the sets decide), merges results across runs and stores them (files: with the next save;
    /// live: at once in the model folder).
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>The clash document once clash detection is switched on; null while dormant.</summary>
        private ClashDocument _clashDocument;
        private int _clashRevision, _savedClashRevision;
        private string _clashSidecarPath;

        #endregion

        #region State

        /// <summary>True once clash detection has been switched on in this session.</summary>
        private bool ClashesActive => _clashDocument != null;

        /// <summary>True when clash changes wait for a save (files only).</summary>
        private bool ClashesDirty => _clashRevision != _savedClashRevision;

        /// <summary>
        /// Switches clash detection on: loads the clash document (or seeds the starter tests). Does nothing when it is
        /// already on.
        /// </summary>
        private void EnsureClashes()
        {
            if (_clashDocument != null) { return; }

            string error = null;
            if (IsFileMode)
            {
                _clashDocument = ClashFiles.Parse(_options.Document?.Clashes, out error);
            }
            else
            {
                _clashSidecarPath = ClashFiles.SidecarFor(Scene.CommentsPath);
                _clashDocument = ClashFiles.Read(_clashSidecarPath, out error);
            }
            if (error != null) { Toast(error, 5f, important: true); }

            bool seeded = _clashDocument == null;
            _clashDocument ??= SearchSets.Seeded();
            _savedClashRevision = _clashRevision;
            Log_Utils.Write($"Clash detection on: {_clashDocument.Sets.Count} sets, {_clashDocument.Tests.Count} tests, {_clashDocument.Clashes.Count} clashes" +
                (seeded ? " (starter tests seeded)." : "."));
        }

        /// <summary>
        /// Records a change to the clash document: files mark it unsaved, live sessions write the model folder now.
        /// </summary>
        private void ClashesChanged()
        {
            _clashRevision++;
            if (IsFileMode || _clashDocument == null) { return; }
            if (string.IsNullOrEmpty(_clashSidecarPath))
            {
                Log_Utils.Write("Clashes not stored: this live session has no model folder.");
                return;
            }
            if (ClashFiles.Write(_clashSidecarPath, _clashDocument, out string error)) { _savedClashRevision = _clashRevision; }
            else { Toast(error, 5f, important: true); }
        }

        /// <summary>
        /// What a save writes as <c>clashes.json</c>: the live document when clash detection was switched on, else the
        /// file's own bytes untouched (dormant: never parsed).
        /// </summary>
        private byte[] ClashBytesForSave() => _clashDocument != null ? ClashFiles.Serialize(_clashDocument) : _options.Document?.Clashes;

        /// <summary>
        /// A stamp of the model as walked (snapshot + edits), compared with each test's last run to say "model changed".
        /// </summary>
        private string ClashModelState()
        {
            DateTime extracted = Scene.Provenance?.ExtractedUtc ?? default;
            JournalEntryStamp(out int count, out DateTime last);
            return $"{extracted.Ticks}|{Scene.Elements.Length}|{Scene.TriangleCount}|{count}|{last.Ticks}";
        }

        private void JournalEntryStamp(out int count, out DateTime last)
        {
            count = _journal.Count;
            last = count > 0 ? _journal.Entries[count - 1].Utc : default;
        }

        /// <summary>True when the model as walked differs from the one a test last ran on.</summary>
        private bool ClashModelChangedSince(ClashTest test) =>
            test?.LastRunUtc != null && !string.Equals(test.LastRunModel, ClashModelState(), StringComparison.Ordinal);

        #endregion

        #region Items and sets

        /// <summary>
        /// One item per element as walked: static elements still standing, then active moved originals, clones and
        /// placements (committed ones) under their transforms. Library templates never take part.
        /// </summary>
        private ClashItem[] BuildClashItems()
        {
            ElementRecord[] elements = Scene.Elements;
            var items = new List<ClashItem>(elements.Length);
            for (int i = 0; i < elements.Length; i++)
            {
                if (elements[i].IsLibraryTemplate || _hidden[i]) { continue; } // demolished, deleted or replaced by its moved instance
                items.Add(ClashItem.Static(Scene, i));
            }
            if (Dynamics != null)
            {
                foreach (DynamicInstance instance in Dynamics.Instances)
                {
                    if (instance.Hidden || !instance.Committed || elements[instance.Element].IsLibraryTemplate && !instance.IsClone) { continue; }
                    items.Add(ClashItem.Moved(instance.Element, instance.Model, instance.WorldBounds, instance.IsClone ? instance.CloneKey : 0));
                }
            }
            return items.ToArray();
        }

        /// <summary>
        /// The items in a set (by their source element's data).
        /// </summary>
        private int[] ClashItemsIn(SearchSet set, ClashItem[] items, Dictionary<string, bool[]> cache)
        {
            if (!cache.TryGetValue(set.Id, out bool[] inSet))
            {
                inSet = new bool[Scene.Elements.Length];
                foreach (int e in SearchSets.ElementsIn(set, Scene)) { inSet[e] = true; }

                // Placements come from library templates: they belong where their template's category would
                for (int i = 0; i < Scene.Elements.Length; i++)
                {
                    if (Scene.Elements[i].IsLibraryTemplate) { inSet[i] = MatchesIgnoringTemplate(set, Scene.Elements[i]); }
                }
                cache[set.Id] = inSet;
            }

            var result = new List<int>();
            for (int i = 0; i < items.Length; i++)
            {
                if (inSet[items[i].Element]) { result.Add(i); }
            }
            return result.ToArray();
        }

        /// <summary>
        /// Set rules for a library template's own data (it is excluded from sets as itself, but its placements count).
        /// </summary>
        private bool MatchesIgnoringTemplate(SearchSet set, ElementRecord template)
        {
            var standIn = new ElementRecord
            {
                CategoryIndex = template.CategoryIndex,
                CategoryName = template.CategoryName,
                FamilyType = template.FamilyType,
                LevelName = template.LevelName,
                Link = template.Link
            };
            return SearchSets.Matches(set, Scene, standIn);
        }

        #endregion

        #region Run

        /// <summary>
        /// Runs tests one after another, each on a worker behind the progress screen (Esc / CANCEL stops; a cancelled
        /// test changes nothing and the rest are skipped), merging each finished run.
        /// </summary>
        private void RunClashTests(IReadOnlyList<ClashTest> tests)
        {
            EnsureClashes();
            if (tests == null || tests.Count == 0)
            {
                Sound.Play(SoundId.Error);
                Toast("No test to run (tick a test, or add one)", 3f);
                return;
            }

            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            ClashItem[] items = BuildClashItems();
            var setCache = new Dictionary<string, bool[]>(StringComparer.Ordinal);
            string state = ClashModelState();
            int totalFound = 0, totalNew = 0, totalResolved = 0, ran = 0;
            bool anyTruncated = false;

            for (int t = 0; t < tests.Count; t++)
            {
                ClashTest test = tests[t];
                SearchSet setA = _clashDocument.FindSet(test.SetA);
                SearchSet setB = test.IsSelfTest ? null : _clashDocument.FindSet(test.SetB);
                if (setA == null || (!test.IsSelfTest && setB == null))
                {
                    Toast($"“{test.Name}” skipped: one of its sets no longer exists", 4f, important: true);
                    continue;
                }

                var job = new ClashJob
                {
                    Scene = Scene,
                    Items = items,
                    SetA = ClashItemsIn(setA, items, setCache),
                    SetB = setB == null ? null : ClashItemsIn(setB, items, setCache),
                    Kind = test.Kind,
                    Tolerance = (float)test.Tolerance,
                    MaxClashes = ClashDefaults.MAX_CLASHES_PER_TEST
                };

                var progress = new OperationProgress();
                progress.Begin("Starting", 0.0, 0.0);
                string title = tests.Count > 1 ? $"Clash test {t + 1} of {tests.Count}: {test.Name}" : $"Clash test: {test.Name}";
                ClashRunResult result;
                try
                {
                    result = ProgressScreen.Run(_window, _ui, title, progress, () => ClashEngine.Run(job, progress));
                }
                catch (Exception ex)
                {
                    Log_Utils.Write($"Clash test “{test.Name}” failed: {ex}");
                    Sound.Play(SoundId.Error);
                    Toast($"“{test.Name}” could not run: {ex.Message}", 5f, important: true);
                    break;
                }
                _window.Input.ReleaseAll();

                if (result.Cancelled)
                {
                    Sound.Play(SoundId.UiClick);
                    Toast($"Clash run cancelled: “{test.Name}” is unchanged", 3.5f);
                    break;
                }

                List<ClashRecord> records = ClashMerge.ToRecords(job, result, test.Id);
                ClashMergeResult merged = ClashMerge.Apply(_clashDocument, test, records, complete: !result.Truncated, DateTime.UtcNow, state,
                    result.CountA, result.CountB, result.Seconds);
                totalFound += merged.Found;
                totalNew += merged.New;
                totalResolved += merged.NewlyResolved;
                anyTruncated |= result.Truncated;
                ran++;
            }

            if (ran == 0) { return; }
            ClashesChanged();
            SyncClashComments(); // C-B2: linked comments follow the statuses the run set
            _clashRowsDirty = true;
            _clashListDirty = true;
            Sound.Play(SoundId.Commit);
            string summary = $"{(ran > 1 ? $"{ran} tests" : $"“{tests[0].Name}”")}: {totalFound:N0} clash{(totalFound == 1 ? string.Empty : "es")} ({totalNew:N0} new, {totalResolved:N0} resolved)";
            if (anyTruncated)
            {
                Toast(summary + $". Stopped at {ClashDefaults.MAX_CLASHES_PER_TEST:N0} in a test: narrow its sets (nothing was marked resolved there).", 7f, important: true);
            }
            else
            {
                Toast(summary, 4f);
            }
        }

        #endregion

        #region Report

        /// <summary>
        /// EXPORT REPORT…: the whole clash document as readable BimGo JSON.
        /// </summary>
        private void ExportClashReport()
        {
            EnsureClashes();
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            string name = SafeFileName(Scene.ModelTitle) + " clashes " + DateTime.Now.ToString("yyyy-MM-dd HHmm") + ClashFiles.REPORT_EXTENSION;
            string path = FileDialogs.ShowSave(_window.Handle, "Export clash report", ClashFiles.REPORT_FILTER, SuggestedFolder(), name, ClashFiles.REPORT_EXTENSION);
            _window.Input.ReleaseAll();
            if (path == null) { return; }
            if (ClashFiles.ExportReport(path, _clashDocument, Scene.ModelTitle, Scene.Provenance?.ModelKey, $"BimGo {Program.Version}", out string error))
            {
                Sound.Play(SoundId.Commit);
                Toast($"Clash report saved: {Path.GetFileName(path)}", 3.5f);
            }
            else
            {
                Sound.Play(SoundId.Error);
                Toast(error, 5f, important: true);
            }
        }

        /// <summary>
        /// IMPORT REPORT…: merges a BimGo clash report (newer status changes win, missing tests / clashes are added).
        /// </summary>
        private void ImportClashReport()
        {
            EnsureClashes();
            _window.SetCaptured(false);
            _window.Input.ReleaseAll();
            string path = FileDialogs.ShowOpen(_window.Handle, "Import clash report", ClashFiles.REPORT_FILTER, SuggestedFolder());
            _window.Input.ReleaseAll();
            if (path == null) { return; }

            ClashImportResult? result = ClashFiles.ImportReport(path, _clashDocument, Scene.Provenance?.ModelKey, out string error);
            if (result == null)
            {
                Sound.Play(SoundId.Error);
                Toast(error, 5f, important: true);
                return;
            }
            ClashImportResult r = result.Value;
            ClashesChanged();
            SyncClashComments(); // C-B2: linked comments follow imported statuses
            _clashRowsDirty = true;
            _clashListDirty = true;
            Sound.Play(SoundId.Commit);
            string other = r.SameModel ? string.Empty : " The report names a different model: check the pairs.";
            Toast($"Report merged: {r.ClashesAdded:N0} clashes added, {r.ClashesUpdated:N0} updated, {r.Unchanged:N0} unchanged; " +
                $"{r.TestsAdded} tests and {r.SetsAdded} sets added.{other}", 6f, important: !r.SameModel);
        }

        #endregion
    }
}
