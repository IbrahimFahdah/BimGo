using System.Numerics;
using RvtGo.Extraction;

// The class belongs to the Bridge namespace
namespace RvtGo.Bridge
{
    /// <summary>
    /// The only route from a walkthrough session back into the Revit API.
    ///
    /// The game thread queues <see cref="BridgeRequest"/>s on a <see cref="BridgeChannel"/> and raises an
    /// <see cref="ExternalEvent"/>; Revit then calls <see cref="Execute"/> on its own thread when it is idle,
    /// and every request runs in its own named transaction with warnings swallowed and errors rolled back.
    /// Results go back on the channel. Nothing here throws to the caller.
    /// </summary>
    internal sealed class RevitBridge : IExternalEventHandler
    {
        #region Fields

        private static readonly object LOCK = new();
        private static RevitBridge _instance;
        private static ExternalEvent _event;
        private static nint _revitWindow;

        private Document _doc;
        private ElementId _phaseId = ElementId.InvalidElementId;
        private BridgeChannel _channel;

        /// <summary>Clones made this session: game key to Revit id (Revit thread only).</summary>
        private readonly Dictionary<int, ElementId> _cloneIds = new();

        #endregion

        #region Session

        /// <summary>
        /// Revit thread (inside a command): prepares the bridge for a new session and returns its channel.
        /// The external event is created once and reused by later sessions.
        /// </summary>
        /// <param name="doc">The document the session was extracted from.</param>
        /// <param name="phaseId">The working phase's ElementId value (-1 if none).</param>
        /// <param name="revitWindow">Revit's main window handle (woken after each raise), or 0.</param>
        /// <returns>The channel, or null if the external event could not be created.</returns>
        public static BridgeChannel StartSession(Document doc, long phaseId, nint revitWindow)
        {
            try
            {
                lock (LOCK)
                {
                    if (_event == null)
                    {
                        _instance = new RevitBridge();
                        _event = ExternalEvent.Create(_instance);
                    }

                    _revitWindow = revitWindow;
                    var channel = new BridgeChannel(Raise);
                    _instance._doc = doc;
                    _instance._phaseId = phaseId > 0 ? new ElementId(phaseId) : ElementId.InvalidElementId;
                    _instance._channel = channel;
                    _instance._cloneIds.Clear();
                    return channel;
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Revit bridge unavailable: {ex}");
                return null;
            }
        }

        /// <summary>
        /// Any thread: asks Revit to run the handler at its next idle moment. Revit only checks for raised
        /// events when its message loop turns over, which may not happen while our window has focus, so a
        /// WM_NULL is posted to its main window to wake it.
        /// </summary>
        private static void Raise()
        {
            ExternalEvent externalEvent = _event;
            externalEvent?.Raise();
            if (_revitWindow != 0) { Native.Win32.PostMessageW(_revitWindow, Native.Win32.WM_NULL, 0, 0); }
        }

        #endregion

        #region IExternalEventHandler

        /// <summary>
        /// Revit thread: processes every queued request in order.
        /// </summary>
        public void Execute(UIApplication app)
        {
            BridgeChannel channel;
            Document doc;
            lock (LOCK)
            {
                channel = _channel;
                doc = _doc;
            }
            if (channel == null) { return; }

            while (channel.TryTakeRequest(out BridgeRequest request))
            {
                BridgeResult result;
                try
                {
                    result = Process(doc, request);
                }
                catch (Exception ex)
                {
                    Utilities.Log_Utils.Write($"Bridge request {request.Op} failed: {ex}");
                    result = Fail(request, ex.Message);
                }
                channel.Post(result);
            }
        }

        /// <summary>
        /// The handler's name (shown by Revit if something goes wrong).
        /// </summary>
        public string GetName() => "RvtGo walkthrough edits";

        #endregion

        #region Processing

        /// <summary>
        /// Runs one request in its own transaction.
        /// </summary>
        private BridgeResult Process(Document doc, BridgeRequest request)
        {
            if (doc == null || !doc.IsValidObject) { return Fail(request, "The model is no longer open in Revit"); }
            if (doc.IsReadOnly) { return Fail(request, "The model is read-only"); }
            if (doc.IsModifiable) { return Fail(request, "Revit is busy with another edit"); }

            // Resolve the target (clones made earlier this session are found by key)
            ElementId id;
            if (request.TargetCloneKey != 0)
            {
                if (!_cloneIds.TryGetValue(request.TargetCloneKey, out id)) { return Fail(request, "The clone was never created in Revit"); }
            }
            else
            {
                id = new ElementId(request.ElementId);
            }

            Element element = doc.GetElement(id);
            if (element == null || !element.IsValidObject) { return Fail(request, "The element no longer exists in Revit"); }

            if (doc.IsWorkshared && WorksharingUtils.GetCheckoutStatus(doc, id) == CheckoutStatus.OwnedByOtherUser)
            {
                return Fail(request, "The element is borrowed by another user");
            }

            return request.Op switch
            {
                BridgeOp.PhaseDemolish => PhaseDemolish(doc, element, request),
                BridgeOp.Delete => Delete(doc, element, request),
                BridgeOp.Transform => TransformElement(doc, element, request),
                BridgeOp.Copy => Copy(doc, element, request),
                _ => Fail(request, "Unknown request")
            };
        }

        /// <summary>
        /// Sets Phase Demolished to the session phase. Reports the element and any dependants Revit demolished with it.
        /// </summary>
        private BridgeResult PhaseDemolish(Document doc, Element element, BridgeRequest request)
        {
            if (_phaseId == ElementId.InvalidElementId) { return Fail(request, "The model has no phase to demolish in"); }

            Parameter parameter = element.get_Parameter(BuiltInParameter.PHASE_DEMOLISHED);
            if (parameter == null || parameter.IsReadOnly) { return Fail(request, "This element can't be demolished by phase"); }

            string error = RunTransaction(doc, request.Label, () => parameter.Set(_phaseId));
            if (error != null) { return Fail(request, error); }

            // The element plus anything that went with it (e.g. doors in a demolished wall)
            var affected = new List<long> { element.Id.Value };
            try
            {
                foreach (ElementId dependentId in element.GetDependentElements(null))
                {
                    if (dependentId == element.Id) { continue; }
                    if (doc.GetElement(dependentId) is Element dependent && dependent.DemolishedPhaseId == _phaseId)
                    {
                        affected.Add(dependentId.Value);
                    }
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Dependent lookup failed: {ex.Message}");
            }

            return new BridgeResult { Ticket = request.Ticket, Op = request.Op, Success = true, AffectedIds = affected.ToArray() };
        }

        /// <summary>
        /// Deletes the element. Reports everything Revit deleted with it.
        /// </summary>
        private BridgeResult Delete(Document doc, Element element, BridgeRequest request)
        {
            ICollection<ElementId> deleted = null;
            ElementId id = element.Id;
            string error = RunTransaction(doc, request.Label, () => deleted = doc.Delete(id));
            if (error != null) { return Fail(request, error); }

            long[] affected = deleted?.Select(d => d.Value).ToArray() ?? new[] { id.Value };
            return new BridgeResult { Ticket = request.Ticket, Op = request.Op, Success = true, AffectedIds = affected };
        }

        /// <summary>
        /// Rotates about the element's location point, then moves it.
        /// </summary>
        private BridgeResult TransformElement(Document doc, Element element, BridgeRequest request)
        {
            ElementId id = element.Id;
            XYZ pivot = PivotOf(element, request.Pivot);
            string error = RunTransaction(doc, request.Label, () => ApplyTransform(doc, id, pivot, request));
            if (error != null) { return Fail(request, error); }
            return new BridgeResult { Ticket = request.Ticket, Op = request.Op, Success = true };
        }

        /// <summary>
        /// Copies the element by the translation, then rotates the copy about its own location point.
        /// </summary>
        private BridgeResult Copy(Document doc, Element element, BridgeRequest request)
        {
            ElementId sourceId = element.Id;
            ElementId newId = ElementId.InvalidElementId;
            XYZ sourcePivot = PivotOf(element, request.Pivot);

            string error = RunTransaction(doc, request.Label, () =>
            {
                ICollection<ElementId> copies = ElementTransformUtils.CopyElement(doc, sourceId, ToFeet(request.Translation));
                newId = copies.FirstOrDefault(c => doc.GetElement(c) is FamilyInstance) ?? copies.FirstOrDefault() ?? ElementId.InvalidElementId;
                if (newId == ElementId.InvalidElementId) { throw new InvalidOperationException("Revit did not create a copy"); }

                if (MathF.Abs(request.Angle) > 1e-6f)
                {
                    XYZ pivot = sourcePivot + ToFeet(request.Translation);
                    ElementTransformUtils.RotateElement(doc, newId, DB.Line.CreateBound(pivot, pivot + XYZ.BasisZ), request.Angle);
                }
            });
            if (error != null) { return Fail(request, error); }

            _cloneIds[request.NewCloneKey] = newId;
            return new BridgeResult
            {
                Ticket = request.Ticket,
                Op = request.Op,
                Success = true,
                NewElementId = newId.Value,
                CloneKey = request.NewCloneKey
            };
        }

        /// <summary>
        /// Rotation (about a vertical axis through the pivot) then translation.
        /// </summary>
        private static void ApplyTransform(Document doc, ElementId id, XYZ pivot, BridgeRequest request)
        {
            if (MathF.Abs(request.Angle) > 1e-6f)
            {
                ElementTransformUtils.RotateElement(doc, id, DB.Line.CreateBound(pivot, pivot + XYZ.BasisZ), request.Angle);
            }
            if (request.Translation.LengthSquared() > 1e-10f)
            {
                ElementTransformUtils.MoveElement(doc, id, ToFeet(request.Translation));
            }
        }

        #endregion

        #region Helpers

        /// <summary>
        /// Runs an action in a named transaction. Warnings are deleted; errors roll back.
        /// </summary>
        /// <returns>Null on success, else a short reason.</returns>
        private static string RunTransaction(Document doc, string label, Action action)
        {
            var failures = new SwallowFailures();
            using var transaction = new Transaction(doc, "RvtGo: " + (string.IsNullOrWhiteSpace(label) ? "Edit" : label));

            FailureHandlingOptions options = transaction.GetFailureHandlingOptions();
            options.SetFailuresPreprocessor(failures);
            options.SetClearAfterRollback(true);
            transaction.SetFailureHandlingOptions(options);

            try
            {
                transaction.Start();
                action();
            }
            catch (Exception ex)
            {
                if (transaction.HasStarted() && !transaction.HasEnded()) { transaction.RollBack(); }
                return ex.Message;
            }

            TransactionStatus status = transaction.Commit();
            if (status == TransactionStatus.Committed) { return null; }
            return failures.FirstError ?? "Revit rolled the change back";
        }

        /// <summary>
        /// The element's current location point (feet), falling back to the game's pivot.
        /// </summary>
        private static XYZ PivotOf(Element element, Vector3 fallbackMetres)
        {
            if (element.Location is LocationPoint point) { return point.Point; }
            return ToFeet(fallbackMetres);
        }

        /// <summary>
        /// Metres (Revit internal axes) to an XYZ in feet.
        /// </summary>
        private static XYZ ToFeet(Vector3 metres) => new(metres.X / SceneExtractor.FT, metres.Y / SceneExtractor.FT, metres.Z / SceneExtractor.FT);

        /// <summary>
        /// A failed result.
        /// </summary>
        private static BridgeResult Fail(BridgeRequest request, string message)
        {
            Utilities.Log_Utils.Write($"Bridge {request.Op} ({request.ElementId}/{request.TargetCloneKey}) refused: {message}");
            return new BridgeResult { Ticket = request.Ticket, Op = request.Op, Success = false, Message = message, CloneKey = request.NewCloneKey };
        }

        #endregion

        /// <summary>
        /// Deletes warnings so no dialog appears; any error rolls the transaction back (first message kept).
        /// </summary>
        private sealed class SwallowFailures : IFailuresPreprocessor
        {
            /// <summary>The first error's description, if any.</summary>
            public string FirstError { get; private set; }

            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                bool hasError = false;
                foreach (FailureMessageAccessor message in accessor.GetFailureMessages())
                {
                    if (message.GetSeverity() == FailureSeverity.Warning)
                    {
                        accessor.DeleteWarning(message);
                    }
                    else
                    {
                        hasError = true;
                        FirstError ??= message.GetDescriptionText();
                    }
                }
                return hasError ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
            }
        }
    }
}
