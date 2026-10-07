using AVNA = BimGo.Availability.AvailabilityNames;

// The class belongs to the root namespace
namespace BimGo
{
    /// <summary>
    /// Handles the startup and shutdown behavior of the addin.
    /// </summary>
    public class Application : IExternalApplication
    {
        /// <summary>
        /// Runs when the application starts.
        ///
        /// Handles the following steps:
        /// - Name the log, register global variables
        /// - Register General utilities to Revit events
        /// - Hook up live sessions (document events, ribbon status)
        /// - Add the BimGo tab, panel and buttons (Go, Export .bimgo, Live status)
        /// </summary>
        public Result OnStartup(UIControlledApplication uiCtlApp)
        {
            // Logs: %LocalAppData%\BimGo\Logs\BimGo.Revit.log
            Utilities.Log_Utils.Initialise("BimGo.Revit");

            // Set up UIAPP subscription, register tooltips
            Globals.UICTLAPP = uiCtlApp;
            Globals.UICTLAPP.Idling += OnIdling;
            Globals.RegisterTooltips($"{Globals.ADDIN_NAME}.Resources.Files.Tooltips");

            // Add the BimGo tab and its panel
            uiCtlApp.Ext_AddRibbonTab(Globals.ADDIN_NAME);
            RibbonPanel panelWalkthrough = uiCtlApp.Ext_AddRibbonPanelToTab(Globals.ADDIN_NAME, "Walkthrough");

            // Go: walk the open model in the BimGo app with edits coming back to Revit (live session).
            // Export: write a standalone .bimgo. Live: the session's status (text updates as the app attaches).
            panelWalkthrough.Ext_AddPushButton<Commands.Cmds_BimGo.Cmd_Launch>(buttonName: "Go", availability: AVNA.Project);
            panelWalkthrough.Ext_AddPushButton<Commands.Cmds_BimGo.Cmd_Export>(buttonName: "Export\n.bimgo", availability: AVNA.Project);
            Live.LiveDispatcher.StatusButton = panelWalkthrough.Ext_AddPushButton<Commands.Cmds_BimGo.Cmd_Status>(buttonName: "Live\noff", availability: AVNA.Project);
            Live.LiveDispatcher.Initialise(uiCtlApp);

            // Materials round, stage 0: read-only material / texture diagnostic (temporary)
            panelWalkthrough.Ext_AddPushButton<Commands.Cmds_BimGo.Cmd_MaterialScan>(buttonName: "Material\nscan", availability: AVNA.Project);

            // Return succeeded
            return Result.Succeeded;
        }

        /// <summary>
        /// Runs when the application shuts down.
        ///
        /// Handles the following steps:
        /// - Ends every live session (the app is told, session.json is marked closed)
        /// </summary>
        public Result OnShutdown(UIControlledApplication uiCtlApp)
        {
            Live.LiveDispatcher.Shutdown("Revit is closing");

            // Return succeeded
            return Result.Succeeded;
        }

        /// <summary>
        /// Registers the UIApplication as soon as Revit idles.
        /// Unsubscribes the event once it fires once.
        /// </summary>
        /// <param name="sender">The event sender object (the UIApplication).</param>
        /// <param name="e">Event related arguments..</param>
        /// <returns>Void (nothing).</returns>
        private void OnIdling(object sender, UI.Events.IdlingEventArgs e)
        {
            if (sender is UIApplication uiApp)
            {
                Globals.UICTLAPP.Idling -= OnIdling;
                Globals.UIAPP = uiApp;
            }
        }
    }
}
