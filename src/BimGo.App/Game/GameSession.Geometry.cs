using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Pause menu → CATEGORIES & LINKS (review tools round): the category cards and the linked-model toggles, moved
    /// out of the pause menu's middle so the menu fits a 720 px high window. Same toggles as before (walkthrough-only,
    /// saved with the model's visibility).
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        private bool _geometryOpen;
        private string _geometryMenuLabel;
        private int _geometryMenuLabelFor = -1;
        private readonly ScrollRegion _geometryScroll = new();

        #endregion

        #region Open / close

        /// <summary>True while the category and link toggles show (they replace the pause menu).</summary>
        private bool IsGeometryPanelOpen => _geometryOpen;

        /// <summary>Opens the category and link toggles (pausing the walkthrough).</summary>
        private void OpenGeometry()
        {
            if (!_paused) { SetPaused(true); }
            _geometryOpen = true;
            _geometryScroll.Reset();
        }

        /// <summary>Closes the category and link toggles.</summary>
        /// <returns>True if they were open.</returns>
        private bool CloseGeometry()
        {
            if (!_geometryOpen) { return false; }
            _geometryOpen = false;
            return true;
        }

        /// <summary>"CATEGORIES & LINKS", with a * when a loaded category or link is switched off (rebuilt on change).</summary>
        private string GeometryMenuLabel()
        {
            int off = 0;
            for (int i = 0; i < _categoryVisible.Length; i++)
            {
                if (Scene.CategoryLoaded[i] && !_categoryVisible[i]) { off++; }
            }
            for (int i = 1; i < _linkVisible.Length; i++)
            {
                if (!_linkVisible[i]) { off++; }
            }
            if (off != _geometryMenuLabelFor || _geometryMenuLabel == null)
            {
                _geometryMenuLabelFor = off;
                _geometryMenuLabel = off == 0 ? "CATEGORIES & LINKS" : "CATEGORIES & LINKS *"; // * = something is switched off
            }
            return _geometryMenuLabel;
        }

        #endregion

        #region Panel

        /// <summary>
        /// Draws the category cards and the linked models in the panel shell (polish round P-A1: one scroll region).
        /// </summary>
        private void BuildGeometryPanel()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            PanelFrame frame = BeginPanel(PanelSize.Standard, "CATEGORIES & LINKS", UiTheme.ACCENT, "Walkthrough only: Revit is never changed");

            float top = BeginScroll(_geometryScroll, input, frame.Ix, frame.BodyTop, frame.Iw, frame.BodyHeight, out float cw);
            float bottom = BuildCategoryCards(f, input, frame.Ix, top, cw);
            EndScroll(_geometryScroll, input, bottom);

            EndPanel(frame, null, "Click a category to show or hide it, or a group's heading for the whole group");
        }

        #endregion
    }
}
