using System.Windows.Interop;
using RvtGo.Extraction;
using RvtGo.Scene;

// The class belongs to the Commands namespace
namespace RvtGo.Commands.Cmds_RvtGo
{
    /// <summary>
    /// Opens the launch options, extracts a snapshot of the model and starts a walkthrough session
    /// on its own thread. If a session is already running, its window is brought to the front instead.
    /// </summary>
    [Transaction(TransactionMode.ReadOnly)]
    public class Cmd_Launch : IExternalCommand
    {
        /// <summary>
        /// Execute the command.
        /// </summary>
        /// <param name="commandData">Command related data.</param>
        /// <param name="message">Command related message.</param>
        /// <param name="elements">Command related elements.</param>
        /// <returns>A Result.</returns>
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            UIApplication uiApp = commandData.Application;
            UIDocument uiDoc = uiApp.ActiveUIDocument;

            // One session at a time: focus the running one
            if (Game.GameHost.IsRunning)
            {
                Game.GameHost.BringToFront();
                return Result.Succeeded;
            }

            if (uiDoc == null || uiDoc.Document.IsFamilyDocument)
            {
                return FormCallers.Cancelled("RvtGo needs an open project document.");
            }

            try
            {
                // Options dialog
                Document doc = uiDoc.Document;
                LaunchSettings settings = LaunchSettings.LoadOrDefault();
                int[] counts = CategoryCatalog.All.Select(def => CategoryResolver.Count(doc, def)).ToArray();

                var dialog = new Forms.OptionsWindow(settings, SceneExtractor.DescribeSpawn(uiDoc), counts);
                new WindowInteropHelper(dialog).Owner = uiApp.MainWindowHandle;
                if (dialog.ShowDialog() != true)
                {
                    return Result.Cancelled;
                }
                settings.Save();

                // Extraction (Revit API thread)
                SceneData scene = SceneExtractor.Extract(uiDoc, settings);
                if (scene.Elements.Length == 0)
                {
                    return FormCallers.Cancelled("Nothing to walk through: no geometry was found in the ticked categories.");
                }

                // The write-back channel (Hammer / Gizmo / Clone). Null if unavailable: those guns then work in-game only.
                Bridge.BridgeChannel bridge = Bridge.RevitBridge.StartSession(doc, scene.PhaseId, uiApp.MainWindowHandle);

                // Hand the immutable snapshot to the game thread
                if (!Game.GameHost.Launch(scene, bridge))
                {
                    return FormCallers.Error($"The walkthrough could not be started. See the log:\n{Utilities.Log_Utils.LogPath}");
                }
                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Launch failed: {ex}");
                return FormCallers.Error($"RvtGo could not start:\n{ex.Message}\n\nLog: {Utilities.Log_Utils.LogPath}");
            }
        }
    }
}
