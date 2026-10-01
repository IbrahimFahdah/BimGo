using AVNA = RvtGo.Availability.AvailabilityNames;

// The class belongs to the root namespace
namespace RvtGo
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
        /// - Register global variables
        /// - Register General utilities to Revit events
        /// - Add the RvtGo tab, panel and launch button
        /// </summary>
        public Result OnStartup(UIControlledApplication uiCtlApp)
        {
            // Set up UIAPP subscription, register tooltips
            Globals.UICTLAPP = uiCtlApp;
            Globals.UICTLAPP.Idling += OnIdling;
            Globals.RegisterTooltips($"{Globals.ADDIN_NAME}.Resources.Files.Tooltips");

            // Add the RvtGo tab and its single panel
            uiCtlApp.Ext_AddRibbonTab(Globals.ADDIN_NAME);
            RibbonPanel panelWalkthrough = uiCtlApp.Ext_AddRibbonPanelToTab(Globals.ADDIN_NAME, "Walkthrough");

            // The one entry point: launch a session (project documents only)
            panelWalkthrough.Ext_AddPushButton<Commands.Cmds_RvtGo.Cmd_Launch>(buttonName: "Go", availability: AVNA.Project);

            // Return succeeded
            return Result.Succeeded;
        }

        /// <summary>
        /// Runs when the application shuts down.
        ///
        /// Handles the following steps:
        /// - Ends any running walkthrough session so its thread exits cleanly
        /// </summary>
        public Result OnShutdown(UIControlledApplication uiCtlApp)
        {
            // Close a running session (saves comments, releases the GL context)
            Game.GameHost.RequestShutdown(waitMilliseconds: 3000);

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
