using System;
using BimGo.Utilities;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Stage maths (local progress mapped into the stage's share of the bar) and cancellation.
    /// </summary>
    [TestClass]
    public sealed class OperationProgressTests
    {
        private static double Fraction(OperationProgress progress)
        {
            progress.Read(out _, out _, out double fraction);
            return fraction;
        }

        [TestMethod]
        public void Begin_StartsTheBarAtTheStageStart()
        {
            var progress = new OperationProgress();
            progress.Detail("old detail");
            progress.Begin("Reading geometry", 0.2, 0.6);

            progress.Read(out string stage, out string detail, out double fraction);
            Assert.AreEqual("Reading geometry", stage);
            Assert.AreEqual(string.Empty, detail, "A new stage clears the detail line");
            Assert.AreEqual(0.2, fraction, 1e-12);
        }

        [TestMethod]
        public void Step_MapsIntoTheStageRange()
        {
            var progress = new OperationProgress();
            progress.Begin("Stage", 0.2, 0.6);

            progress.Step(0.5);
            Assert.AreEqual(0.4, Fraction(progress), 1e-12);

            progress.Step(1.0);
            Assert.AreEqual(0.6, Fraction(progress), 1e-12);
        }

        [TestMethod]
        public void Step_ClampsOutOfRangeValues()
        {
            var progress = new OperationProgress();
            progress.Begin("Stage", 0.2, 0.6);

            progress.Step(-3);
            Assert.AreEqual(0.2, Fraction(progress), 1e-12);
            progress.Step(7);
            Assert.AreEqual(0.6, Fraction(progress), 1e-12);
        }

        [TestMethod]
        public void StepByCount_UsesDoneOverTotal()
        {
            var progress = new OperationProgress();
            progress.Begin("Stage", 0.0, 0.5);

            progress.Step(25, 100);
            Assert.AreEqual(0.125, Fraction(progress), 1e-12);
            progress.Step(5, 0); // no total: start of the stage
            Assert.AreEqual(0.0, Fraction(progress), 1e-12);
        }

        [TestMethod]
        public void Begin_ClampsAndOrdersTheRange()
        {
            var progress = new OperationProgress();
            progress.Begin("Backwards", 0.8, 0.3); // end before start: the stage has no width
            progress.Step(1.0);
            Assert.AreEqual(0.8, Fraction(progress), 1e-12);

            progress.Begin("Too wide", -1, 2);
            Assert.AreEqual(0.0, Fraction(progress), 1e-12);
            progress.Step(1.0);
            Assert.AreEqual(1.0, Fraction(progress), 1e-12);
        }

        [TestMethod]
        public void Cancel_IsSeenAtTheNextSafePoint()
        {
            var progress = new OperationProgress();
            progress.ThrowIfCancelled(); // nothing yet

            progress.Cancel();
            Assert.IsTrue(progress.CancelRequested);
            bool threw = false;
            try { progress.ThrowIfCancelled(); }
            catch (OperationCanceledException ex) { threw = true; Assert.AreEqual("Cancelled.", ex.Message); }
            Assert.IsTrue(threw);
        }

        [TestMethod]
        public void Cancel_IsIgnoredWhileTheTaskCannotBeInterrupted()
        {
            var progress = new OperationProgress { CanCancel = false };
            progress.Cancel();
            Assert.IsFalse(progress.CancelRequested);
            progress.ThrowIfCancelled(); // must not throw
        }
    }
}
