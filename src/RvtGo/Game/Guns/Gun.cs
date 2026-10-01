using System.Numerics;
using RvtGo.Physics;
using RvtGo.Rendering;

// The class belongs to the Guns namespace
namespace RvtGo.Game.Guns
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

        /// <summary>Selection key label.</summary>
        public abstract string Key { get; }

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

        /// <summary>Highlight strength (alpha of the override colour).</summary>
        public virtual float HighlightStrength => 0.35f;

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
