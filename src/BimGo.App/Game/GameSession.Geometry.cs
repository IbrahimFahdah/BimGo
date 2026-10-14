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

        #endregion

        #region Open / close

        /// <summary>True while the category and link toggles show (they replace the pause menu).</summary>
        private bool IsGeometryPanelOpen => _geometryOpen;

        /// <summary>Opens the category and link toggles (pausing the walkthrough).</summary>
        private void OpenGeometry()
        {
            if (!_paused) { SetPaused(true); }
            _geometryOpen = true;
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
        /// Draws the category cards and the linked models full width, with CLOSE (Esc goes back too).
        /// </summary>
        private void BuildGeometryPanel()
        {
            FontAtlas f = _ui.Atlas;
            InputState input = _window.Input;
            int width = _window.Width, height = _window.Height;
            _ui.Rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

            float x = S(56), w = width - S(112);
            float y = S(48);
            _ui.Text(f.Small, x, y, "BIMGO", UiTheme.TEXT_MUTED, S(2.6f));
            y += S(20);
            _ui.Text(f.Title, x, y, "CATEGORIES & LINKS", UiTheme.TEXT, S(2.4f));
            _ui.TextRight(f.Small, x + w, y + S(16), "Walkthrough only: Revit is never changed · Esc back", UiTheme.TEXT_MUTED, S(0.6f));
            y += S(64);

            BuildCategoryCards(f, input, x, y, w);

            if (MenuButton(f, x, height - S(48) - S(44), S(160), "CLOSE", false, false, height: S(44))) { CloseGeometry(); }
        }

        #endregion
    }
}
