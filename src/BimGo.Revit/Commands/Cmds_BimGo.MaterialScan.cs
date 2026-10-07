using System.Diagnostics;
using BimGo.Extraction;

// The class belongs to the Commands namespace
namespace BimGo.Commands.Cmds_BimGo
{
    /// <summary>
    /// Material scan (materials round, stage 0 diagnostic): writes a read-only report of the active model's and its
    /// loaded links' materials. The report covers appearance schemas and every property, texture paths and where they
    /// were found, and image sizes. Nothing in the model changes. The report lands under
    /// %LocalAppData%\BimGo\Logs\MaterialScans.
    /// <para>Temporary: removed or folded into the Options window once the materials extraction is built.</para>
    /// </summary>
    [Transaction(TransactionMode.ReadOnly)]
    public class Cmd_MaterialScan : IExternalCommand
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
            if (!CommandSteps.CheckDocument(uiDoc, out string reason)) { return FormCallers.Cancelled(reason); }

            string path, summary;
            try
            {
                var progress = new Utilities.OperationProgress();
                using (Forms.ProgressWindow.Show($"Scanning materials in {uiDoc.Document.Title}", progress, uiApp.MainWindowHandle))
                {
                    path = MaterialScan.Run(uiDoc.Document, uiApp.Application.VersionNumber, progress, out summary);
                }
            }
            catch (OperationCanceledException)
            {
                Utilities.Log_Utils.Write("Material scan cancelled.");
                return Result.Cancelled;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Material scan failed: {ex}");
                return FormCallers.Error($"The material scan failed:\n{ex.Message}\n\nLog: {Utilities.Log_Utils.LogPath}");
            }

            var dialog = new UI.TaskDialog("BimGo")
            {
                MainInstruction = "Material scan written",
                MainContent = summary + "\n\nPlease send the report file back for the materials round.\n\n" + path,
                CommonButtons = UI.TaskDialogCommonButtons.Close
            };
            dialog.AddCommandLink(UI.TaskDialogCommandLinkId.CommandLink1, "Open the report");
            dialog.AddCommandLink(UI.TaskDialogCommandLinkId.CommandLink2, "Show it in its folder");

            switch (dialog.Show())
            {
                case UI.TaskDialogResult.CommandLink1:
                    Open(path, null);
                    break;
                case UI.TaskDialogResult.CommandLink2:
                    Open("explorer.exe", $"/select,\"{path}\"");
                    break;
            }
            return Result.Succeeded;
        }

        /// <summary>
        /// Opens a file with its associated program (or runs a program with arguments). Failures are logged.
        /// </summary>
        private static void Open(string target, string arguments)
        {
            try
            {
                var start = arguments == null
                    ? new ProcessStartInfo(target) { UseShellExecute = true }
                    : new ProcessStartInfo(target, arguments) { UseShellExecute = true };
                Process.Start(start)?.Dispose();
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Could not open {target}: {ex.Message}");
            }
        }
    }
}
