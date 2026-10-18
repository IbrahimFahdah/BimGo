using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Grass round (build B): grass blades on the grass materials in the Realistic mode. The grass field (where grass
    /// grows, seen from above) is built on a worker thread the first time it's needed and again when the keywords
    /// change; the renderer draws the blades from it each frame. Settings per machine (Appearance → Grass blades).
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Fields

        // Settings (saved with the other display choices)
        private bool _grassBlades = true;
        private int _grassDensity = 1;
        private int _grassHeightMm = 120;
        private int _grassDistance = 40;
        private float _grassSway = 1f; // water round W: 0–2, 1 = as before

        // The field: the keywords it was built for (null = never), the build under way and its keywords
        private string _grassBuiltFor;
        private Task<GrassField> _grassTask;
        private string _grassTaskFor;
        private CancellationTokenSource _grassCancel;
        private GrassField _grassField = GrassField.Empty;
        private string _grassError;

        // Polish round P-C: the field follows hidden elements and moved / cloned / placed copies. The scene key it was
        // built for and the one being built; a changed key waits until it has settled (a drag is one change)
        private long _grassBuiltScene, _grassTaskScene, _grassSeenScene;
        private float _grassSceneChangedAt = -1f;
        private const float GRASS_SETTLE = 0.75f;

        #endregion

        #region Settings

        private void ReadGrassSettings(LaunchSettings settings)
        {
            _grassBlades = settings.GrassBlades;
            _grassDensity = Math.Clamp(settings.GrassDensity, 0, 2);
            _grassHeightMm = Math.Clamp(settings.GrassHeightMm, LaunchSettings.MIN_GRASS_HEIGHT, LaunchSettings.MAX_GRASS_HEIGHT);
            _grassDistance = Math.Clamp(settings.GrassDistance, LaunchSettings.MIN_GRASS_DISTANCE, LaunchSettings.MAX_GRASS_DISTANCE);
            _grassSway = LaunchSettings.CleanLookScale(settings.GrassSway);
        }

        private void WriteGrassSettings(LaunchSettings settings)
        {
            settings.GrassBlades = _grassBlades;
            settings.GrassDensity = _grassDensity;
            settings.GrassHeightMm = _grassHeightMm;
            settings.GrassDistance = _grassDistance;
            settings.GrassSway = _grassSway;
        }

        #endregion

        #region Field

        /// <summary>True when blades should show this frame (and the field is worth building).</summary>
        private bool GrassWanted => _grassBlades && _realistic && !_whitecard && _renderer != null && _renderer.HasMaterials && _grassError == null;

        /// <summary>
        /// Once a frame: starts a build when the field is missing or the keywords changed, and uploads a finished one.
        /// Allocation-free while nothing changes.
        /// </summary>
        private void UpdateGrass()
        {
            if (!GrassWanted && _grassTask == null) { return; }

            // A finished build: upload it if its keywords are still the ones wanted
            if (_grassTask != null && _grassTask.IsCompleted)
            {
                Task<GrassField> done = _grassTask;
                string doneFor = _grassTaskFor;
                _grassTask = null;
                _grassTaskFor = null;
                _grassCancel?.Dispose();
                _grassCancel = null;
                if (done.Status == TaskStatus.RanToCompletion && doneFor == CurrentGrassKey())
                {
                    _grassField = done.Result ?? GrassField.Empty;
                    _grassBuiltFor = doneFor;
                    _grassBuiltScene = _grassTaskScene;
                    string error = _renderer.SetGrassField(_grassField);
                    if (error != null)
                    {
                        _grassError = error;
                        Toast(error, 6f, important: true);
                    }
                }
                else if (done.IsFaulted)
                {
                    _grassError = "Grass blades could not be placed (see the log).";
                    Utilities.Log_Utils.Write($"Grass field failed: {done.Exception?.GetBaseException()}");
                    Toast(_grassError, 5f, important: true);
                }
            }

            if (!GrassWanted) { return; }
            string key = CurrentGrassKey();

            // P-C: the scene (visibility, moved / cloned copies) settles before a rebuild; a gun holding an element waits
            long sceneKey = ShadowSceneKey();
            if (sceneKey != _grassSeenScene)
            {
                _grassSeenScene = sceneKey;
                _grassSceneChangedAt = _clock;
            }
            bool sceneSettled = _grassSceneChangedAt < 0f || (_clock - _grassSceneChangedAt > GRASS_SETTLE && !_guns[_activeGun].CapturesInput);
            bool sceneStale = sceneKey != _grassBuiltScene && sceneSettled && _grassBuiltFor != null;
            if (key == _grassBuiltFor && !sceneStale) { return; }
            if (_grassTask != null)
            {
                // A build for other keywords or an older scene: stop it (the next frame after it ends starts the right one)
                if (_grassTaskFor != key || (sceneSettled && _grassTaskScene != sceneKey)) { _grassCancel?.Cancel(); }
                return;
            }
            if (!sceneSettled && _grassBuiltFor != null) { return; }

            // Start a build (the scene is read-only: safe on a worker thread; visibility and copies are snapshots)
            List<string> keywords = new(_grassKeywords);
            SceneData scene = Scene;
            bool[] visible = GrassVisibility();
            List<(int Element, System.Numerics.Matrix4x4 Model)> instances = GrassInstances();
            _grassCancel = new CancellationTokenSource();
            CancellationToken token = _grassCancel.Token;
            _grassTaskFor = key;
            _grassTaskScene = sceneKey;
            _grassSceneChangedAt = -1f;
            _grassTask = Task.Run(() => GrassField.Build(scene, keywords, token, visible, instances), token);
        }

        /// <summary>P-C: per element, shown in the walkthrough now (category, link, hidden, demolished, moved, profile).</summary>
        private bool[] GrassVisibility()
        {
            ElementRecord[] elements = Scene.Elements;
            var visible = new bool[elements.Length];
            for (int e = 0; e < elements.Length; e++)
            {
                visible[e] = !_hidden[e] && !_userHidden[e] && !ProfileHides(e) && _groupVisible[SceneBatches.GroupOf(elements[e])];
            }
            return visible;
        }

        /// <summary>P-C: the active moved / cloned / placed copies (source element, transform).</summary>
        private List<(int Element, System.Numerics.Matrix4x4 Model)> GrassInstances()
        {
            var instances = new List<(int, System.Numerics.Matrix4x4)>();
            foreach (Physics.DynamicInstance instance in Dynamics.Instances)
            {
                if (Dynamics.IsActive(instance)) { instances.Add((instance.Element, instance.Model)); }
            }
            return instances;
        }

        /// <summary>The keywords as one string (what a field was built for).</summary>
        private string CurrentGrassKey() => MaterialOverrides.FormatKeywords(_grassKeywords);

        /// <summary>
        /// Draws the blades (main view: after the opaque scene and the ground).
        /// </summary>
        private void DrawGrass(in SceneDrawParams p)
        {
            _renderer.ProbeGrass = false;
            if (!GrassWanted || !_renderer.HasGrass || _grassBuiltFor != CurrentGrassKey()) { return; }
            _renderer.ProbeGrass = true; // P-C: reflection probes capture the blades too (sparser, nearer)
            _renderer.Grass = new GrassLook
            {
                Density = _grassDensity,
                Height = _grassHeightMm / 1000f,
                Distance = _grassDistance,
                Sway = _grassSway
            };
            _renderer.DrawGrass(p);
        }

        // The status line, made again only when what it says changes (no per-frame strings)
        private string _grassStatusText;
        private int _grassStatusKey = int.MinValue;

        /// <summary>The GRASS page's status line.</summary>
        private string GrassStatus()
        {
            int key = HashCode.Combine(_grassError, _renderer?.HasMaterials ?? false, _realistic && !_whitecard, _grassBlades,
                _grassTask != null || _grassBuiltFor != CurrentGrassKey(), _grassField.GrassCells);
            if (key == _grassStatusKey && _grassStatusText != null) { return _grassStatusText; }
            _grassStatusKey = key;
            return _grassStatusText = MakeGrassStatus();
        }

        private string MakeGrassStatus()
        {
            if (_grassError != null) { return _grassError; }
            if (_renderer == null || !_renderer.HasMaterials) { return "Needs a snapshot with materials (tick Extract materials and textures at Go)."; }
            if (!_realistic || _whitecard) { return "Shows in the Realistic colour mode."; }
            if (!_grassBlades) { return "Off."; }
            if (_grassTask != null || _grassBuiltFor != CurrentGrassKey()) { return "Finding the grass…"; }
            if (_grassField.IsEmpty) { return "No upward surfaces with a grass material: check the keywords against the material names."; }
            float area = _grassField.GrassCells * _grassField.Cell * _grassField.Cell;
            return $"{area:N0} m² of grass in {_grassField.Colours.Length} {(_grassField.Colours.Length == 1 ? "material" : "materials")}. Blades near you only; the surface's texture carries on beyond.";
        }

        #endregion
    }
}
