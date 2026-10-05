using System.Numerics;
using BimGo.Audio;
using BimGo.Physics;
using BimGo.Rendering;

// The class belongs to the Guns namespace
namespace BimGo.Game.Guns
{
    /// <summary>
    /// Gun 3: LMB places the blue portal, RMB the red one (re-firing moves it). Walking into a portal
    /// teleports the player to the other one, keeping relative orientation.
    /// </summary>
    internal sealed class PortalGun : Gun
    {
        #region Types and fields

        private struct Portal
        {
            public bool Active;
            public Vector3 Centre, Normal, U, V;
            public float RadiusU, RadiusV;
            public float Age;
            public string Level;

            public readonly bool IsWall => MathF.Abs(Normal.Z) < 0.7f;
        }

        private readonly Portal[] _portals = new Portal[2];
        private float _cooldown;

        private static readonly uint[] FILL = { Rgba.WithAlpha(UiTheme.PORTAL_BLUE_DARK, 0.55f), Rgba.WithAlpha(UiTheme.PORTAL_RED_DARK, 0.55f) };
        private static readonly uint[] RING = { UiTheme.PORTAL_BLUE, UiTheme.PORTAL_RED };
        private static readonly uint[] GLOW = { UiTheme.PORTAL_BLUE_LIGHT, UiTheme.PORTAL_RED_LIGHT };
        private static readonly string[] NAMES = { "Blue", "Red" };

        #endregion

        public PortalGun(GameSession session) : base(session) { }

        public override string Name => "PORTAL";
        public override string HintPrimary => "Blue portal";
        public override string HintSecondary => "Red portal";
        public override uint Colour => UiTheme.PORTAL_BLUE;

        public override void DrawIcon(UiBatch ui, float cx, float cy, float size, uint colour) => GunIcons.Portal(ui, cx, cy, size, colour);

        public override float PanelHeight => 96f;

        /// <summary>True if a portal is placed (for the minimap).</summary>
        public bool IsActive(int index) => _portals[index].Active;

        /// <summary>Portal centre (for the minimap).</summary>
        public Vector3 CentreOf(int index) => _portals[index].Centre;

        /// <summary>Portal ring colour.</summary>
        public static uint ColourOf(int index) => RING[index];

        public override void OnPrimary(in AimInfo aim) => Place(0, aim);

        public override void OnSecondary(in AimInfo aim) => Place(1, aim);

        public override void ClearMarkers()
        {
            _portals[0].Active = false;
            _portals[1].Active = false;
        }

        public override void Tick(float dt)
        {
            for (int i = 0; i < 2; i++) { _portals[i].Age += dt; }
        }

        #region Placement

        /// <summary>
        /// Places (or moves) a portal on the surface under the crosshair.
        /// </summary>
        private void Place(int index, in AimInfo aim)
        {
            if (!aim.HasHit)
            {
                Session.Sound.Play(SoundId.Error);
                return;
            }

            Vector3 normal = aim.Hit.Normal;
            Vector3 centre = aim.Hit.Point;
            Vector3 u, v;
            float ru, rv;

            if (MathF.Abs(normal.Z) < 0.7f)
            {
                // Wall: upright ellipse standing on the floor below if there is one nearby
                u = Vector3.Normalize(Vector3.Cross(Vector3.UnitZ, normal));
                v = Vector3.Cross(normal, u);
                ru = 0.55f;
                rv = 1.0f;

                Vector3 probe = centre + normal * 0.4f + Vector3.UnitZ * 0.2f;
                if (Session.Pick(probe, -Vector3.UnitZ, 3f, out RayHit floor) && floor.Normal.Z > 0.7f)
                {
                    centre.Z = floor.Point.Z + rv + 0.05f;
                }
            }
            else
            {
                // Floor / ceiling: round, aligned to the view
                Vector3 right = Session.Camera.Right;
                u = Vector3.Normalize(right - normal * Vector3.Dot(right, normal));
                v = Vector3.Cross(normal, u);
                ru = rv = 0.65f;
            }

            _portals[index] = new Portal
            {
                Active = true,
                Centre = centre + normal * 0.015f,
                Normal = normal,
                U = u,
                V = v,
                RadiusU = ru,
                RadiusV = rv,
                Age = 0f,
                Level = Session.LevelNameAt(centre.Z)
            };

            Session.Sound.Play(index == 0 ? SoundId.PortalBlue : SoundId.PortalRed);
            Session.Flash(RING[index], 0.12f);
        }

        #endregion

        #region Teleport

        /// <summary>
        /// Checks the player against both portals (called every physics tick, whatever gun is selected).
        /// </summary>
        public void CheckTeleport(Player player, float dt)
        {
            _cooldown -= dt;
            if (_cooldown > 0f || !_portals[0].Active || !_portals[1].Active) { return; }

            CharacterController controller = player.Controller;
            float height = controller.Height;

            for (int i = 0; i < 2; i++)
            {
                ref Portal from = ref _portals[i];
                ref Portal to = ref _portals[1 - i];

                // Test point: capsule centre for walls, feet for floors, head for ceilings
                Vector3 probe = from.IsWall
                    ? controller.Feet + new Vector3(0f, 0f, height * 0.5f)
                    : from.Normal.Z > 0f ? controller.Feet : controller.Feet + new Vector3(0f, 0f, height);

                Vector3 relative = probe - from.Centre;
                float distance = Vector3.Dot(relative, from.Normal);
                if (distance > CharacterController.RADIUS + 0.15f || distance < -0.4f) { continue; }

                Vector3 lateral = relative - from.Normal * distance;
                float a = Vector3.Dot(lateral, from.U) / from.RadiusU;
                float b = Vector3.Dot(lateral, from.V) / from.RadiusV;
                if (a * a + b * b > 1f) { continue; }

                Travel(player, from, to, height, 1 - i);
                _cooldown = 0.6f;
                return;
            }
        }

        /// <summary>
        /// Moves the player out of the destination portal.
        /// </summary>
        private void Travel(Player player, in Portal from, in Portal to, float height, int toIndex)
        {
            Vector3 feet;
            if (to.IsWall)
            {
                Vector3 exit = to.Centre + to.Normal * (CharacterController.RADIUS + 0.2f);
                feet = new Vector3(exit.X, exit.Y, to.Centre.Z - to.RadiusV + 0.05f);
            }
            else if (to.Normal.Z > 0f)
            {
                feet = to.Centre + new Vector3(0f, 0f, 0.05f);
            }
            else
            {
                feet = to.Centre - new Vector3(0f, 0f, height + 0.1f);
            }

            Vector3 velocity = player.Controller.Velocity;
            float yawChange = 0f;
            if (from.IsWall && to.IsWall)
            {
                // Entering against -from.Normal, leaving along +to.Normal
                float enter = MathF.Atan2(-from.Normal.Y, -from.Normal.X);
                float leave = MathF.Atan2(to.Normal.Y, to.Normal.X);
                yawChange = leave - enter;
            }

            player.TeleportTo(feet, player.Yaw + yawChange);
            player.Controller.Velocity = velocity;
            if (to.IsWall)
            {
                var exitDirection = Vector3.Normalize(new Vector3(to.Normal.X, to.Normal.Y, 0f));
                player.RotateVelocity(yawChange, 1.5f, exitDirection);
            }
            else if (to.Normal.Z > 0f)
            {
                player.Controller.Velocity = new Vector3(0f, 0f, 2.5f);
            }

            Session.Sound.Play(SoundId.Teleport);
            Session.Flash(RING[toIndex], 0.35f);
        }

        #endregion

        #region Drawing

        public override void DrawWorld(Overlay3D overlay, bool selected)
        {
            for (int i = 0; i < 2; i++)
            {
                ref Portal p = ref _portals[i];
                if (!p.Active) { continue; }

                float pulse = 0.5f + 0.5f * MathF.Sin(p.Age * 3.2f);
                overlay.Disc(p.Centre, p.U, p.V, p.RadiusU, p.RadiusV, FILL[i], 40);
                overlay.Ring(p.Centre, p.U, p.V, p.RadiusU, p.RadiusV, 0.06f, RING[i], 48);
                overlay.Ring(p.Centre, p.U, p.V, p.RadiusU + 0.08f, p.RadiusV + 0.08f, 0.05f, Rgba.WithAlpha(GLOW[i], 0.2f + 0.2f * pulse), 48);

                // Placement burst
                if (p.Age < 0.6f)
                {
                    float t = p.Age / 0.6f;
                    float grow = 0.1f + 0.5f * t;
                    overlay.Ring(p.Centre, p.U, p.V, p.RadiusU + grow, p.RadiusV + grow, 0.04f, Rgba.WithAlpha(GLOW[i], 0.8f * (1f - t)), 48);
                }
            }
        }

        public override void DrawPanel(UiBatch ui, float x, float y, float width)
        {
            FontAtlas f = ui.Atlas;
            ui.Text(f.Small, x, y, "PORTALS", UiTheme.PORTAL_LABEL, S(1.1f));
            y += S(20);

            for (int i = 0; i < 2; i++)
            {
                ui.Circle(x + S(6), y + S(9), S(6), RING[i]);
                TextBuffer text = Session.Text.Clear().Append(NAMES[i]).Append(" · ");
                if (_portals[i].Active)
                {
                    text.Append(_portals[i].Level).Append(_portals[i].IsWall ? " wall" : _portals[i].Normal.Z > 0f ? " floor" : " ceiling");
                }
                else
                {
                    text.Append("not placed");
                }
                ui.Text(f.Body, x + S(20), y, text.Span, UiTheme.TEXT);
                y += S(20);
            }

            bool linked = _portals[0].Active && _portals[1].Active;
            ui.TextWrapped(f.Body, x, y + S(2), width,
                linked ? "Connected. Walk into one to come out of the other. X clears both." : "Place both portals to connect them.",
                UiTheme.TEXT_MUTED, maxLines: 2);
        }

        #endregion
    }
}
