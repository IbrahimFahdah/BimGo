using System.Numerics;
using BimGo.Physics;
using BimGo.Rendering;

// The class belongs to the Guns namespace
namespace BimGo.Game.Guns
{
    /// <summary>
    /// What the crosshair is pointing at this frame.
    /// </summary>
    internal struct AimInfo
    {
        /// <summary>True if something was hit.</summary>
        public bool HasHit;

        /// <summary>The hit (valid when <see cref="HasHit"/>).</summary>
        public RayHit Hit;

        /// <summary>Ray origin (eye).</summary>
        public Vector3 Origin;

        /// <summary>Ray direction (unit).</summary>
        public Vector3 Direction;
    }

    /// <summary>
    /// One element to tint this frame: a static element, or a dynamic (moved / cloned) instance.
    /// </summary>
    internal readonly record struct Highlight(int Element, int DynamicId, uint Colour, float Strength);

    /// <summary>
    /// Base class for the tool guns. Markers (measure lines, portals, comments) persist and are drawn
    /// whether or not their gun is selected; input only reaches the selected gun.
    /// </summary>
    internal abstract class Gun
    {
        /// <summary>The owning session.</summary>
        protected GameSession Session { get; }

        /// <summary>
        /// Creates the gun.
        /// </summary>
        protected Gun(GameSession session)
        {
            Session = session;
        }

        /// <summary>Display name (upper case).</summary>
        public abstract string Name { get; }

        /// <summary>Selection key label (assigned from the gun's slot when the session registers it).</summary>
        public string Key { get; set; } = string.Empty;

        /// <summary>LMB hint.</summary>
        public abstract string HintPrimary { get; }

        /// <summary>RMB hint.</summary>
        public abstract string HintSecondary { get; }

        /// <summary>Gun colour (packed RGBA).</summary>
        public abstract uint Colour { get; }

        /// <summary>Height of the context panel content (unscaled px).</summary>
        public abstract float PanelHeight { get; }

        /// <summary>Element to highlight (-1 for none).</summary>
        public virtual int HighlightElement => -1;

        /// <summary>Dynamic instance to highlight instead of the static element (0 for none).</summary>
        public virtual int HighlightDynamic => 0;

        /// <summary>Highlight strength (alpha of the override colour).</summary>
        public virtual float HighlightStrength => 0.35f;

        /// <summary>
        /// True while the gun has taken over the movement keys (WASD, Q/E, Esc): the player is frozen and
        /// gun switching, jumping, fly, home and level keys are ignored.
        /// </summary>
        public virtual bool CapturesInput => false;

        /// <summary>
        /// Adds this frame's highlights (selected gun only). The default tints <see cref="HighlightElement"/> /
        /// <see cref="HighlightDynamic"/> in the scan colour.
        /// </summary>
        public virtual void CollectHighlights(List<Highlight> highlights)
        {
            if (HighlightDynamic > 0 || HighlightElement >= 0)
            {
                highlights.Add(new Highlight(HighlightElement, HighlightDynamic, UiTheme.SCAN, HighlightStrength));
            }
        }

        /// <summary>
        /// Esc while <see cref="CapturesInput"/>: cancel the current operation.
        /// </summary>
        public virtual void OnCancel() { }

        /// <summary>
        /// Draws the gun's symbol for the gun bar, centred on (cx, cy) within a square of the given size.
        /// </summary>
        public abstract void DrawIcon(UiBatch ui, float cx, float cy, float size, uint colour);

        /// <summary>Selected-gun frame update (aim is current).</summary>
        public virtual void Update(float dt, in AimInfo aim) { }

        /// <summary>Frame update for every gun (selected or not).</summary>
        public virtual void Tick(float dt) { }

        /// <summary>LMB.</summary>
        public virtual void OnPrimary(in AimInfo aim) { }

        /// <summary>RMB.</summary>
        public virtual void OnSecondary(in AimInfo aim) { }

        /// <summary>Gun-specific keys while selected.</summary>
        public virtual void OnKeys(Platform.InputState input) { }

        /// <summary>Called when deselected.</summary>
        public virtual void OnDeselect() { }

        /// <summary>X key: clear this gun's markers.</summary>
        public abstract void ClearMarkers();

        /// <summary>Adds world-space geometry (always called).</summary>
        public virtual void DrawWorld(Overlay3D overlay, bool selected) { }

        /// <summary>Adds screen-space labels anchored to world points (always called).</summary>
        public virtual void DrawLabels(UiBatch ui, bool selected) { }

        /// <summary>Draws the context panel content.</summary>
        public abstract void DrawPanel(UiBatch ui, float x, float y, float width);

        /// <summary>
        /// Scales a value by the UI scale.
        /// </summary>
        protected float S(float value) => value * Session.UiScale;
    }
}
