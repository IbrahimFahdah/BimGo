using System.Linq;
using BimGo.Edits;
using BimGo.Live;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// The journal's own rules: numbering, undo / redo, clone keys, revision tracking and what a push sends.
    /// (Replaying entries onto the scene happens in BimGo.App's GameSession and is not covered here.)
    /// </summary>
    [TestClass]
    public sealed class EditJournalTests
    {
        private static JournalEntry Hide(long id) => new() { Op = JournalOps.HIDE, Mode = JournalOps.MODE_DEMOLISH, ElementId = id, UniqueId = $"uid-{id}" };

        private static JournalEntry Clone(int key, int sourceKey = 0) => new() { Op = JournalOps.CLONE, ElementId = sourceKey == 0 ? 5 : 0, TargetCloneKey = sourceKey, NewCloneKey = key };

        [TestMethod]
        public void Add_NumbersFromOneAndBumpsRevision()
        {
            var journal = new EditJournal();
            journal.Add(Hide(1));
            journal.Add(Hide(2));

            Assert.AreEqual(2, journal.Count);
            CollectionAssert.AreEqual(new[] { 1, 2 }, journal.Entries.Select(e => e.Seq).ToArray());
            Assert.AreEqual(2, journal.Revision);
        }

        [TestMethod]
        public void LoadedEntries_AreRenumberedAndNullsSkipped()
        {
            var journal = new EditJournal(new[] { new JournalEntry { Seq = 9 }, null, new JournalEntry { Seq = 4 } });

            Assert.AreEqual(2, journal.Count);
            CollectionAssert.AreEqual(new[] { 1, 2 }, journal.Entries.Select(e => e.Seq).ToArray());
            Assert.AreEqual(0, journal.Revision, "Loading is not a change");
        }

        [TestMethod]
        public void UndoThenRedo_RestoresTheSameEntry()
        {
            var journal = new EditJournal();
            JournalEntry first = Hide(1);
            journal.Add(first);
            journal.Add(Hide(2));

            JournalEntry undone = journal.RemoveLast();
            Assert.AreEqual(2L, undone.ElementId);
            Assert.AreEqual(1, journal.Count);
            Assert.AreEqual(1, journal.RedoCount);
            Assert.AreSame(undone, journal.PeekRedo());

            JournalEntry redone = journal.Redo();
            Assert.AreSame(undone, redone);
            Assert.AreEqual(2, redone.Seq);
            Assert.AreEqual(0, journal.RedoCount);
            Assert.AreEqual(4, journal.Revision);
        }

        [TestMethod]
        public void NewEdit_ClearsRedoHistory()
        {
            var journal = new EditJournal();
            journal.Add(Hide(1));
            journal.RemoveLast();
            journal.Add(Hide(2));

            Assert.AreEqual(0, journal.RedoCount);
            Assert.IsNull(journal.Redo());
        }

        [TestMethod]
        public void UndoOnEmpty_ReturnsNullWithoutChange()
        {
            var journal = new EditJournal();
            Assert.IsNull(journal.RemoveLast());
            Assert.IsNull(journal.Redo());
            Assert.AreEqual(0, journal.Revision);
        }

        [TestMethod]
        public void MaxCloneKey_CountsUndoneClones()
        {
            var journal = new EditJournal();
            journal.Add(Clone(3));
            journal.Add(Clone(8, sourceKey: 3));
            Assert.AreEqual(8, journal.MaxCloneKey());

            journal.RemoveLast();
            Assert.AreEqual(8, journal.MaxCloneKey(), "An undone clone keeps its key reserved for redo");
        }

        [TestMethod]
        public void MarkApplied_RecordsOnceAndBumpsRevision()
        {
            var journal = new EditJournal();
            journal.Add(Hide(1));
            journal.Add(Clone(4));
            int revision = journal.Revision;

            Assert.IsTrue(journal.MarkApplied(1, 0));
            Assert.IsFalse(journal.MarkApplied(1, 0), "Already applied");
            Assert.IsTrue(journal.MarkApplied(2, 777));
            Assert.AreEqual(777L, journal.Entries[1].RevitElementId);
            Assert.IsFalse(journal.MarkApplied(3, 0), "Out of range");
            Assert.IsFalse(journal.MarkApplied(0, 0), "Out of range");
            Assert.AreEqual(revision + 2, journal.Revision);
            Assert.AreEqual(0, journal.CountNotInRevit());
        }

        [TestMethod]
        public void PendingForRevit_SkipsAppliedEntriesInOrder()
        {
            var journal = new EditJournal();
            journal.Add(Hide(1));
            journal.Add(Hide(2));
            journal.Add(Hide(3));
            journal.MarkApplied(2, 0);

            CollectionAssert.AreEqual(new long[] { 1, 3 }, journal.PendingForRevit().Select(e => e.ElementId).ToArray());
            Assert.AreEqual(2, journal.CountNotInRevit());
        }

        [TestMethod]
        public void BuildPushRequest_SendsPendingEntriesAndKnownClones()
        {
            var journal = new EditJournal();
            journal.Add(Clone(4));
            journal.Add(Hide(1));
            journal.Add(Clone(5));
            journal.MarkApplied(1, 9001); // clone already in Revit as 9001
            journal.MarkApplied(2, 0);    // applied hide: neither sent nor a known clone

            JournalApplyPayload request = JournalPush.BuildRequest(journal, dryRun: true, applyConflicts: false,
                "model-key", "Existing", "New Construction", "model.bimgo");

            Assert.IsTrue(request.DryRun);
            Assert.AreEqual("model-key", request.ModelKey);
            Assert.AreEqual("Existing", request.ExistingPhaseName);
            Assert.AreEqual("New Construction", request.PhaseName);
            Assert.AreEqual(1, request.Entries.Count);
            Assert.AreEqual(5, request.Entries[0].NewCloneKey);
            Assert.AreEqual(1, request.KnownClones.Count);
            Assert.AreEqual(4, request.KnownClones[0].CloneKey);
            Assert.AreEqual(9001L, request.KnownClones[0].ElementId);
        }
    }
}
