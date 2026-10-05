using System.Numerics;
using BimGo.Native;
using BimGo.Scene;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// Cascaded sun shadow maps: a depth texture array (one layer per cascade, hardware depth comparison) and a
    /// matching transmittance array (RGB light let through by glass). Each cascade covers a slice of the camera's view
    /// with a bounding sphere, so its size never changes as the view turns, and is snapped to whole texels so edges
    /// don't shimmer as the player walks. A cascade is only re-rendered when its matrix, the sun or the scene changes;
    /// while walking, the far cascades (big texels, slow to change) refresh every 2nd / 3rd / 4th frame, and the shaders
    /// always sample with the matrix each map was actually rendered with (<see cref="RenderedMatrices"/>).
    ///
    /// GL resources are created on first use; until then (and when shadows are off) 1×1 placeholders keep the
    /// shaders' samplers valid. Never throws: failures switch shadows off and set <see cref="LastError"/>.
    /// </summary>
    internal sealed unsafe class ShadowMaps : IDisposable
    {
        #region Presets

        /// <summary>A quality preset.</summary>
        public readonly record struct Preset(int Cascades, int Size, int PcfRadius, float Distance);

        /// <summary>The preset for a quality level.</summary>
        public static Preset PresetFor(ShadowQuality quality) => quality switch
        {
            ShadowQuality.Low => new Preset(1, 2048, 0, 60f),
            ShadowQuality.High => new Preset(4, 3072, 2, 200f),
            _ => new Preset(3, 2048, 1, 120f)
        };

        /// <summary>Texture units the scene and ground shaders read the maps from (unit 0 is the UI atlas).</summary>
        public const int DEPTH_UNIT = 1, TRANSMIT_UNIT = 2;

        /// <summary>Most cascades a preset uses (the shader arrays' size).</summary>
        public const int MAX_CASCADES = 4;

        #endregion

        #region Fields

        private uint _depth, _transmit, _fbo;
        private int _size, _layers, _transmitSize;
        private bool _withTransmit;

        private readonly Matrix4x4[] _matrices = new Matrix4x4[MAX_CASCADES];
        private readonly Matrix4x4[] _rendered = new Matrix4x4[MAX_CASCADES];
        private readonly bool[] _valid = new bool[MAX_CASCADES];
        private readonly float[] _far = new float[MAX_CASCADES];
        private readonly float[] _normalOffset = new float[MAX_CASCADES];
        private readonly Vector4[] _planes = new Vector4[6];
        private readonly Vector3[] _corners = new Vector3[8];

        private Vector3 _renderedSun;
        private long _renderedSceneKey = long.MinValue;
        private float _renderedGlass = -1f;
        private int _frame;

        #endregion

        #region State

        /// <summary>The active preset.</summary>
        public Preset Current { get; private set; } = PresetFor(ShadowQuality.Medium);

        /// <summary>True once real maps are allocated and complete.</summary>
        public bool Ready { get; private set; }

        /// <summary>The last failure (allocation, incomplete framebuffer), or null.</summary>
        public string LastError { get; private set; }

        /// <summary>Cascades re-rendered last frame (stats).</summary>
        public int RenderedLastFrame { get; private set; }

        /// <summary>Light view-projection per cascade, as fitted this frame (what the next render of it uses).</summary>
        public Matrix4x4[] Matrices => _matrices;

        /// <summary>Light view-projection each cascade's map was rendered with (what the shaders sample with).</summary>
        public Matrix4x4[] RenderedMatrices => _rendered;

        /// <summary>Far view depth of each cascade (metres along the camera's forward axis).</summary>
        public float[] CascadeFar => _far;

        /// <summary>Receiver offset along the normal per cascade (about 1.5 texels, metres).</summary>
        public float[] NormalOffset => _normalOffset;

        /// <summary>One texel in texture coordinates.</summary>
        public float Texel => 1f / Math.Max(_size, 1);

        /// <summary>The depth texture array.</summary>
        public uint DepthTexture => _depth;

        /// <summary>The transmittance texture array.</summary>
        public uint TransmitTexture => _transmit;

        /// <summary>True if glass transmittance is being rendered (the model has transparent geometry).</summary>
        public bool HasTransmit => _withTransmit && Ready;

        #endregion

        #region Setup

        /// <summary>
        /// Creates the 1×1 placeholders (GL context current).
        /// </summary>
        public void Initialise()
        {
            _fbo = Gl.GenFramebuffer();
            Allocate(1, 1, withTransmit: false);
            Ready = false;
        }

        /// <summary>
        /// Allocates maps for a preset if they aren't already (first use, or the quality changed).
        /// </summary>
        /// <param name="preset">The quality preset.</param>
        /// <param name="withTransmit">True if the model has transparent geometry (glass shadows).</param>
        /// <returns>False if the GPU refused (shadows should be switched off; see <see cref="LastError"/>).</returns>
        public bool Ensure(Preset preset, bool withTransmit)
        {
            if (Ready && preset == Current && withTransmit == _withTransmit) { return true; }

            LastError = null;
            Current = preset;
            if (!Allocate(preset.Size, preset.Cascades, withTransmit))
            {
                Allocate(1, 1, withTransmit: false);
                Ready = false;
                return false;
            }
            Ready = true;
            Invalidate();
            Utilities.Log_Utils.Write($"Shadow maps: {preset.Cascades} × {preset.Size} px{(withTransmit ? " + glass" : string.Empty)}, {preset.Distance:0} m.");
            return true;
        }

        /// <summary>
        /// Frees the full-size maps (shadows switched off), keeping the placeholders.
        /// </summary>
        public void Release()
        {
            if (!Ready) { return; }
            Allocate(1, 1, withTransmit: false);
            Ready = false;
        }

        /// <summary>
        /// Forces every cascade to re-render next frame.
        /// </summary>
        public void Invalidate()
        {
            Array.Clear(_valid);
            _renderedSceneKey = long.MinValue;
        }

        /// <summary>
        /// (Re)creates both texture arrays.
        /// </summary>
        private bool Allocate(int size, int layers, bool withTransmit)
        {
            while (Gl.GetError() != Gl.NO_ERROR) { /* clear stale errors */ }

            Gl.DeleteTexture(_depth);
            Gl.DeleteTexture(_transmit);

            _depth = Gl.GenTexture();
            Gl.BindTexture(Gl.TEXTURE_2D_ARRAY, _depth);
            Gl.TexImage3D(Gl.TEXTURE_2D_ARRAY, 0, Gl.DEPTH_COMPONENT24, size, size, layers, Gl.DEPTH_COMPONENT, Gl.UNSIGNED_INT, null);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_MIN_FILTER, (int)Gl.LINEAR);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_MAG_FILTER, (int)Gl.LINEAR);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_COMPARE_MODE, (int)Gl.COMPARE_REF_TO_TEXTURE);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_COMPARE_FUNC, (int)Gl.LEQUAL);

            // Transmittance needs the same size as the depth it is tested against; without glass a 1×1 white layer set
            int transmitSize = withTransmit ? size : 1;
            _transmit = Gl.GenTexture();
            Gl.BindTexture(Gl.TEXTURE_2D_ARRAY, _transmit);
            if (withTransmit)
            {
                Gl.TexImage3D(Gl.TEXTURE_2D_ARRAY, 0, Gl.RGBA8, transmitSize, transmitSize, layers, Gl.RGBA, Gl.UNSIGNED_BYTE, null);
            }
            else
            {
                uint[] white = new uint[layers];
                Array.Fill(white, 0xFFFFFFFFu);
                fixed (uint* pixels = white)
                {
                    Gl.TexImage3D(Gl.TEXTURE_2D_ARRAY, 0, Gl.RGBA8, 1, 1, layers, Gl.RGBA, Gl.UNSIGNED_BYTE, pixels);
                }
            }
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_MIN_FILTER, (int)Gl.LINEAR);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_MAG_FILTER, (int)Gl.LINEAR);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
            Gl.BindTexture(Gl.TEXTURE_2D_ARRAY, 0);

            uint error = Gl.GetError();
            if (error != Gl.NO_ERROR)
            {
                LastError = error == Gl.OUT_OF_MEMORY
                    ? "Not enough graphics memory for shadows at this quality: try a lower quality"
                    : $"Shadow maps could not be created (GL error 0x{error:X})";
                Utilities.Log_Utils.Write(LastError);
                return false;
            }

            _size = size;
            _layers = layers;
            _transmitSize = transmitSize;
            _withTransmit = withTransmit;

            // A complete framebuffer for the first layer means every layer works
            if (size > 1)
            {
                Gl.BindFramebuffer(Gl.FRAMEBUFFER, _fbo);
                AttachLayer(0);
                uint status = Gl.CheckFramebufferStatus(Gl.FRAMEBUFFER);
                Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);
                if (status != Gl.FRAMEBUFFER_COMPLETE)
                {
                    LastError = $"Shadow framebuffer incomplete (0x{status:X}): shadows are not supported on this graphics driver";
                    Utilities.Log_Utils.Write(LastError);
                    return false;
                }
            }
            return true;
        }

        /// <summary>
        /// Attaches one layer of the arrays to the bound framebuffer. Without glass there is no colour attachment, so
        /// the draw / read buffers are NONE (GL 3.3 calls the framebuffer incomplete otherwise).
        /// </summary>
        private void AttachLayer(int layer)
        {
            Gl.FramebufferTextureLayer(Gl.FRAMEBUFFER, Gl.DEPTH_ATTACHMENT, _depth, 0, layer);
            Gl.FramebufferTextureLayer(Gl.FRAMEBUFFER, Gl.COLOR_ATTACHMENT0, _withTransmit ? _transmit : 0, 0, _withTransmit ? layer : 0);
            Gl.DrawBuffer(_withTransmit ? Gl.COLOR_ATTACHMENT0 : Gl.NONE);
            Gl.ReadBuffer(_withTransmit ? Gl.COLOR_ATTACHMENT0 : Gl.NONE);
        }

        #endregion

        #region Cascades

        /// <summary>
        /// Fits the cascades to the camera and the sun and works out which need re-rendering.
        /// </summary>
        /// <param name="camera">The player camera (updated this frame).</param>
        /// <param name="sun">Unit vector towards the sun (scene axes).</param>
        /// <param name="sceneBounds">Everything that can cast (scene-local).</param>
        /// <param name="sceneKey">Changes whenever casters change (hidden / moved / cloned elements, category toggles).</param>
        /// <param name="glass">The glass slider (changes the transmittance).</param>
        /// <param name="dirty">Per cascade: true if it must be re-rendered.</param>
        public void Fit(FpsCamera camera, Vector3 sun, in Aabb sceneBounds, long sceneKey, float glass, bool[] dirty)
        {
            Preset preset = Current;
            _frame++;
            bool everything = sun != _renderedSun || sceneKey != _renderedSceneKey || MathF.Abs(glass - _renderedGlass) > 1e-4f;

            // Light view: looking down the sun's rays (an "up" that isn't parallel to them)
            Vector3 up = MathF.Abs(sun.Z) > 0.99f ? Vector3.UnitY : Vector3.UnitZ;
            Matrix4x4 lightView = Matrix4x4.CreateLookAt(Vector3.Zero, -sun, up);

            // Casters: the scene's depth range along the light (with a margin for moved / cloned elements)
            Vector3 min = sceneBounds.Min - new Vector3(5f), max = sceneBounds.Max + new Vector3(5f);
            float casterMin = float.MaxValue, casterMax = float.MinValue;
            for (int i = 0; i < 8; i++)
            {
                var corner = new Vector3((i & 1) == 0 ? min.X : max.X, (i & 2) == 0 ? min.Y : max.Y, (i & 4) == 0 ? min.Z : max.Z);
                float z = Vector3.Transform(corner, lightView).Z;
                casterMin = MathF.Min(casterMin, z);
                casterMax = MathF.Max(casterMax, z);
            }

            float near = FpsCamera.NEAR, far = preset.Distance;
            float tanY = MathF.Tan(camera.FovY * 0.5f), tanX = tanY * camera.Aspect;
            Vector3 forward = camera.Forward, right = camera.Right;
            Vector3 cameraUp = Vector3.Normalize(Vector3.Cross(right, forward));

            float sliceNear = near;
            for (int c = 0; c < preset.Cascades; c++)
            {
                // Practical split (mostly logarithmic near the eye, linear further out)
                float t = (c + 1f) / preset.Cascades;
                float logSplit = near * MathF.Pow(far / near, t);
                float linSplit = near + (far - near) * t;
                float sliceFar = c == preset.Cascades - 1 ? far : 0.8f * logSplit + 0.2f * linSplit;
                _far[c] = sliceFar;

                // Bounding sphere of the slice (its radius depends only on the slice, so it never wobbles)
                Vector3 centre = Vector3.Zero;
                for (int i = 0; i < 8; i++)
                {
                    float d = (i & 4) == 0 ? sliceNear : sliceFar;
                    float sx = (i & 1) == 0 ? -1f : 1f, sy = (i & 2) == 0 ? -1f : 1f;
                    _corners[i] = camera.Position + forward * d + right * (sx * d * tanX) + cameraUp * (sy * d * tanY);
                    centre += _corners[i];
                }
                centre /= 8f;
                float radius = 0f;
                for (int i = 0; i < 8; i++) { radius = MathF.Max(radius, Vector3.Distance(centre, _corners[i])); }
                radius = MathF.Ceiling(radius * 4f) / 4f;

                // Snap the centre to whole texels in light space
                float texelWorld = 2f * radius / _size;
                Vector3 centreLight = Vector3.Transform(centre, lightView);
                centreLight.X = MathF.Floor(centreLight.X / texelWorld) * texelWorld;
                centreLight.Y = MathF.Floor(centreLight.Y / texelWorld) * texelWorld;

                // Depth: from the nearest caster to the far side of the slice (view looks down -Z)
                float zNear = -MathF.Max(casterMax, centreLight.Z + radius) - 1f;
                float zFar = -MathF.Min(casterMin, centreLight.Z - radius) + 1f;
                Matrix4x4 projection = OrthographicOffCenter(centreLight.X - radius, centreLight.X + radius,
                    centreLight.Y - radius, centreLight.Y + radius, zNear, zFar);

                _matrices[c] = lightView * projection;
                _normalOffset[c] = texelWorld * 1.5f;
                // Walking: cascade c refreshes every (c + 1)th frame; a sun or scene change refreshes all of them now
                dirty[c] = everything || !_valid[c] || (_rendered[c] != _matrices[c] && _frame % (c + 1) == 0);
                sliceNear = sliceFar;
            }
            for (int c = preset.Cascades; c < MAX_CASCADES; c++)
            {
                _far[c] = 0f;
                dirty[c] = false;
            }

            if (everything)
            {
                _renderedSun = sun;
                _renderedSceneKey = sceneKey;
                _renderedGlass = glass;
            }
        }

        /// <summary>
        /// Binds the framebuffer to a cascade, clears it and sets the viewport. Call <see cref="EndRender"/> after.
        /// </summary>
        public void BeginCascade(int cascade)
        {
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, _fbo);
            AttachLayer(cascade);
            Gl.Viewport(0, 0, _size, _size);
            Gl.ColorMask(true, true, true, true);
            Gl.DepthMask(true);
            Gl.ClearColor(1f, 1f, 1f, 1f);
            Gl.ClearDepth(1.0);
            Gl.Clear(Gl.DEPTH_BUFFER_BIT | (_withTransmit ? Gl.COLOR_BUFFER_BIT : 0u));
        }

        /// <summary>
        /// Records that a cascade now holds its current matrix.
        /// </summary>
        public void MarkRendered(int cascade)
        {
            _rendered[cascade] = _matrices[cascade];
            _valid[cascade] = true;
        }

        /// <summary>
        /// Restores the default framebuffer and state after rendering cascades.
        /// </summary>
        public void EndRender(int renderedCount)
        {
            RenderedLastFrame = renderedCount;
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);
            Gl.ColorMask(true, true, true, true);
            Gl.DepthMask(true);
        }

        /// <summary>
        /// Frustum planes of a cascade (for culling casters).
        /// </summary>
        public Vector4[] PlanesFor(int cascade)
        {
            FpsCamera.ExtractPlanes(_matrices[cascade], _planes);
            return _planes;
        }

        /// <summary>
        /// Binds the maps to their texture units for the scene pass (leaves unit 0 active).
        /// </summary>
        public void Bind()
        {
            Gl.ActiveTexture(Gl.TEXTURE0 + DEPTH_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D_ARRAY, _depth);
            Gl.ActiveTexture(Gl.TEXTURE0 + TRANSMIT_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D_ARRAY, _transmit);
            Gl.ActiveTexture(Gl.TEXTURE0);
        }

        /// <summary>
        /// A GL (-1..1 depth) off-centre orthographic matrix in System.Numerics (row-vector) layout.
        /// </summary>
        private static Matrix4x4 OrthographicOffCenter(float left, float right, float bottom, float top, float near, float far) => new(
            2f / (right - left), 0f, 0f, 0f,
            0f, 2f / (top - bottom), 0f, 0f,
            0f, 0f, -2f / (far - near), 0f,
            -(right + left) / (right - left), -(top + bottom) / (top - bottom), -(far + near) / (far - near), 1f);

        #endregion

        /// <summary>
        /// Releases GL resources.
        /// </summary>
        public void Dispose()
        {
            Gl.DeleteTexture(_depth);
            Gl.DeleteTexture(_transmit);
            Gl.DeleteFramebuffer(_fbo);
            _depth = _transmit = _fbo = 0;
        }
    }
}
