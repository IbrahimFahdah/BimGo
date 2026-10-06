using System.Numerics;
using BimGo.Audio;
using BimGo.Physics;
using BimGo.Platform;
using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Artificial lights: the mode (off / glow / glow + light), the brightness, and each frame's choice of the
    /// lights the shaders get.
    /// <list type="bullet">
    /// <item>Every lighting fixture has one light (<see cref="LightingData"/>) with a cached shadow map
    /// (<see cref="LightShadows"/>), so light goes through doorways and stops at walls.</item>
    /// <item>Each frame the nearest <see cref="ArtificialLighting.MAX_LIGHTS"/> visible lights whose sphere touches
    /// the view are used; when there are more, the farthest of them fade out over the last 30 % of the range so lights
    /// don't pop as the player walks.</item>
    /// <item>Lights follow moved fixtures, clones bring their own, and hidden / demolished fixtures go dark.</item>
    /// <item>Daylight: with the sun up, fixtures matter less next to it (light × 0.35, glow × 0.6 at full day).</item>
    /// </list>
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        /// <summary>Candela per lumen of an omnidirectional source (1 / 4π), times lux → shading units (100 lx ≈ full albedo: night-adapted eyes).</summary>
        private const float LIGHT_SCALE = 1f / (4f * MathF.PI) / 100f;

        private static readonly string[] LIGHT_MODE_OPTIONS = { "Off", "Glow", "Glow + light" };
        private const int SLIDER_LIGHTS = 15, SLIDER_BLOOM = 16;

        private ArtificialLightMode _lightMode = ArtificialLightMode.Lights;
        private float _lightIntensity = 1f, _bloomIntensity = 1f;
        private bool _bloomFailed;

        // Per light, computed once: colour × output, reach
        private Vector3[] _lightColour = Array.Empty<Vector3>();
        private float[] _lightRadius = Array.Empty<float>();
        private readonly Dictionary<int, int> _lightOfElement = new();

        // Per frame (reused): the chosen lights, nearest first, with their identity (light index + instance id)
        private readonly int[] _pickLight = new int[ArtificialLighting.MAX_LIGHTS];
        private readonly float[] _pickDistance = new float[ArtificialLighting.MAX_LIGHTS];
        private readonly Vector3[] _pickPosition = new Vector3[ArtificialLighting.MAX_LIGHTS];
        private readonly long[] _pickKey = new long[ArtificialLighting.MAX_LIGHTS];
        private readonly Vector4[] _viewPlanes = new Vector4[6];
        private int _pickCount, _candidateCount;

        #endregion

        /// <summary>True if the model has lighting fixtures or glowing surfaces.</summary>
        private bool HasArtificialLighting => !Scene.Lighting.IsEmpty;

        #region Setup

        /// <summary>
        /// Reads the mode, brightness and bloom and prepares each light's colour and reach.
        /// </summary>
        private void InitialiseLights(LaunchSettings settings)
        {
            _lightMode = settings.ArtificialLights;
            _lightIntensity = settings.ArtificialLightIntensity;
            _bloomIntensity = settings.BloomIntensity;

            LightSource[] lights = Scene.Lighting.Lights;
            _lightColour = new Vector3[lights.Length];
            _lightRadius = new float[lights.Length];
            _lightOfElement.Clear();
            for (int i = 0; i < lights.Length; i++)
            {
                LightSource light = lights[i];
                _lightColour[i] = LightingData.KelvinToRgb(light.Kelvin) * (light.Lumens * LIGHT_SCALE);
                _lightRadius[i] = Math.Clamp(MathF.Sqrt(light.Lumens) * 0.16f, 2.5f, 9f);
                _lightOfElement.TryAdd(light.Element, i);
            }
            if (lights.Length > 0 || Scene.Lighting.Emissive.Length > 0)
            {
                Utilities.Log_Utils.Write($"Artificial lights: {lights.Length} fixtures, mode {_lightMode}, brightness {_lightIntensity:0.00}, bloom {_bloomIntensity:0.00}.");
            }
        }

        #endregion

        #region Per frame

        /// <summary>
        /// Fills the renderer's <see cref="ArtificialLighting"/> for this frame (call after the sun lighting is set).
        /// </summary>
        private void UpdateArtificialLights()
        {
            ArtificialLighting a = _renderer.Artificial;
            a.Clear();
            if (_lightMode == ArtificialLightMode.Off || !HasArtificialLighting) { return; }

            // How much the sun drowns the fixtures out (the classic light sits in between)
            SunLighting sun = _renderer.Lighting;
            float day = sun.Enabled ? SmoothStep(-6f, 25f, sun.AltitudeDegrees) : 0.6f;
            float brightness = Math.Clamp(_lightIntensity, 0f, 2f);
            float glow = (0.5f + 0.5f * brightness) * Lerp(1f, 0.6f, day);
            a.Emissive = glow;
            a.Bloom = _bloomFailed ? 0f : 0.9f * glow * Math.Clamp(_bloomIntensity, 0f, 2f);
            if (_lightMode != ArtificialLightMode.Lights || Scene.Lighting.Lights.Length == 0) { return; }

            float scale = brightness * Lerp(1f, 0.35f, day);
            if (scale <= 0f) { return; }
            PickLights();

            // Fade the farthest picked lights when some were left out
            float fadeFrom = float.MaxValue, fadeTo = float.MaxValue;
            if (_candidateCount > _pickCount && _pickCount > 0)
            {
                fadeTo = _pickDistance[_pickCount - 1];
                fadeFrom = fadeTo * 0.7f;
            }

            LightSource[] lights = Scene.Lighting.Lights;
            for (int k = 0; k < _pickCount; k++)
            {
                int i = _pickLight[k];
                float fade = 1f - SmoothStep(fadeFrom, fadeTo, _pickDistance[k]);
                Vector3 p = _pickPosition[k], c = _lightColour[i] * scale;
                a.Position[k] = new Vector4(p, _lightRadius[i]);
                a.Colour[k] = new Vector4(c, lights[i].Downward);
                a.Shadow[k] = new Vector4(-1f, fade, 0f, 0f);
                a.Key[k] = _pickKey[k];
            }
            a.Count = _pickCount;
        }

        /// <summary>
        /// Chooses the nearest lights whose sphere touches the view: fixtures where they stand (or where they were moved
        /// to), plus clones of fixtures. Hidden fixtures and hidden categories / links are skipped.
        /// </summary>
        private void PickLights()
        {
            _pickCount = 0;
            _candidateCount = 0;

            // Normalised view planes (sphere tests)
            Vector4[] planes = Camera.Planes;
            for (int p = 0; p < 6; p++)
            {
                Vector4 plane = planes[p];
                float length = new Vector3(plane.X, plane.Y, plane.Z).Length();
                _viewPlanes[p] = length > 1e-8f ? plane / length : plane;
            }

            LightSource[] lights = Scene.Lighting.Lights;
            ElementRecord[] elements = Scene.Elements;
            for (int i = 0; i < lights.Length; i++)
            {
                int e = lights[i].Element;
                if (_userHidden[e] || !_groupVisible[SceneBatches.GroupOf(elements[e])]) { continue; }

                if (!_hidden[e])
                {
                    Consider(i, lights[i].Position, i);
                    continue;
                }

                // Hidden in the static scene: moved (follow it) or removed (dark)
                DynamicInstance moved = Dynamics.FindOriginal(e);
                if (moved == null || !Dynamics.IsActive(moved)) { continue; }
                Consider(i, Vector3.Transform(lights[i].Position, moved.Model), ((long)moved.Id << 32) | (uint)i);
            }

            foreach (DynamicInstance instance in Dynamics.Instances)
            {
                if (!instance.IsClone || !Dynamics.IsActive(instance)) { continue; }
                if (!_lightOfElement.TryGetValue(instance.Element, out int i)) { continue; }
                Consider(i, Vector3.Transform(lights[i].Position, instance.Model), ((long)instance.Id << 32) | (uint)i);
            }
        }

        /// <summary>
        /// Keeps a light if it is among the nearest so far and its sphere touches the view.
        /// </summary>
        /// <param name="light">Index into the scene's lights.</param>
        /// <param name="position">Where it is now.</param>
        /// <param name="key">Its identity across frames (its shadow map is cached under it).</param>
        private void Consider(int light, Vector3 position, long key)
        {
            float radius = _lightRadius[light];
            for (int p = 0; p < 6; p++)
            {
                Vector4 plane = _viewPlanes[p];
                if (plane.X * position.X + plane.Y * position.Y + plane.Z * position.Z + plane.W < -radius) { return; }
            }
            _candidateCount++;

            float distance = Vector3.Distance(position, Camera.Position);
            int max = ArtificialLighting.MAX_LIGHTS;
            if (_pickCount == max && distance >= _pickDistance[max - 1]) { return; }

            // Insertion into the sorted list (nearest first), dropping the farthest when full
            int slot = Math.Min(_pickCount, max - 1);
            while (slot > 0 && _pickDistance[slot - 1] > distance)
            {
                _pickLight[slot] = _pickLight[slot - 1];
                _pickDistance[slot] = _pickDistance[slot - 1];
                _pickPosition[slot] = _pickPosition[slot - 1];
                _pickKey[slot] = _pickKey[slot - 1];
                slot--;
            }
            _pickLight[slot] = light;
            _pickDistance[slot] = distance;
            _pickPosition[slot] = position;
            _pickKey[slot] = key;
            if (_pickCount < max) { _pickCount++; }
        }

        #endregion

        #region Controls

        /// <summary>
        /// K: off → glow → glow + light → off.
        /// </summary>
        private void CycleLightMode()
        {
            if (!HasArtificialLighting)
            {
                Sound.Play(SoundId.Error);
                Toast("This model has no lighting fixtures or glowing materials");
                return;
            }
            SetLightMode((ArtificialLightMode)(((int)_lightMode + 1) % 3));
        }

        /// <summary>
        /// Changes the mode and says what it does.
        /// </summary>
        private void SetLightMode(ArtificialLightMode mode)
        {
            _lightMode = mode;
            Sound.Play(SoundId.UiClick);
            int fixtures = Scene.Lighting.Lights.Length;
            Toast(mode switch
            {
                ArtificialLightMode.Off => "Artificial lights off",
                ArtificialLightMode.Glow => "Artificial lights: glow only",
                _ => fixtures > 0 ? $"Artificial lights: glow + light ({fixtures} fixtures)" : "Artificial lights: glow (no fixtures to light rooms)"
            });
        }

        /// <summary>
        /// The sun panel's artificial-light rows: mode and brightness.
        /// </summary>
        /// <returns>The height used.</returns>
        private float BuildLightControls(FontAtlas f, InputState input, float x, float y, float w)
        {
            float top = y;
            _ui.Text(f.Body, x, y + S(6), "Lights", HasArtificialLighting ? UiTheme.TEXT : UiTheme.TEXT_MUTED);
            int mode = Segmented(f, input, x + S(64), y, w - S(64), LIGHT_MODE_OPTIONS, (int)_lightMode);
            if (mode != (int)_lightMode)
            {
                if (HasArtificialLighting) { SetLightMode((ArtificialLightMode)mode); }
                else { CycleLightMode(); }
            }
            y += S(46);

            // Brightness and bloom side by side (keeps the panel's height)
            float half = (w - S(16)) * 0.5f;
            Text.Clear().Append((long)MathF.Round(_lightIntensity * 100f)).Append(" %");
            float value = Slider(f, input, SLIDER_LIGHTS, x, y, half, "Light", Text.Span, _lightIntensity, 0f, 2f);
            _lightIntensity = MathF.Round(value * 20f) / 20f;
            Text.Clear().Append((long)MathF.Round(_bloomIntensity * 100f)).Append(" %");
            value = Slider(f, input, SLIDER_BLOOM, x + half + S(16), y, half, "Bloom", Text.Span, _bloomIntensity, 0f, 2f);
            _bloomIntensity = MathF.Round(value * 20f) / 20f;
            y += S(54);
            return y - top;
        }

        #endregion

        private static float Lerp(float a, float b, float t) => a + (b - a) * t;

        private static float SmoothStep(float edge0, float edge1, float x)
        {
            if (edge1 <= edge0) { return x >= edge1 ? 1f : 0f; }
            float t = Math.Clamp((x - edge0) / (edge1 - edge0), 0f, 1f);
            return t * t * (3f - 2f * t);
        }
    }
}
