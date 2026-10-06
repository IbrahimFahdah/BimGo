using System.Numerics;
using BimGo.Native;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// Cached omnidirectional shadow maps for the artificial lights: one depth "cube" (6 faces, 90° each) per light, in
    /// a depth texture array of <see cref="ArtificialLighting.MAX_LIGHTS"/> × 6 layers (16-bit, hardware comparison).
    /// Works on GL 3.3 (no cube-map arrays): the shaders pick the face from the major axis themselves, with the same
    /// face table as <see cref="FaceForward"/> / <see cref="FaceUp"/>.
    ///
    /// Fixtures don't move, so a light's map is rendered once and kept in a slot while the light stays picked. A map is
    /// re-rendered when its light moves (gizmo) or the scene changes (hide, demolish, move, category toggle); until
    /// then the stale map is still used. At most <see cref="LIGHTS_PER_FRAME"/> lights render per frame, never-rendered
    /// ones first, nearest first; a light without a map yet is left out and fades in once it has one.
    ///
    /// Never throws: failures set <see cref="LastError"/> (the renderer then lights without shadows).
    /// </summary>
    internal sealed unsafe class LightShadows : IDisposable
    {
        #region Constants

        /// <summary>Face size in pixels (about 2.5 cm texels at 3 m).</summary>
        public const int SIZE = 256;

        /// <summary>Texture unit the scene and ground shaders read the maps from (3 = AO, 4 = glow).</summary>
        public const int UNIT = 5;

        /// <summary>Near plane (m): geometry this close to the light (its own lens) never shadows it.</summary>
        public const float NEAR = 0.08f;

        /// <summary>Each face covers a little more than 90° so filtering near a face edge stays inside it.</summary>
        public const float PAD = 1.03f;

        /// <summary>Most lights (× 6 faces) rendered in one frame.</summary>
        public const int LIGHTS_PER_FRAME = 4;

        /// <summary>Frames a newly shadowed light takes to fade in.</summary>
        private const int FADE_IN_FRAMES = 8;

        /// <summary>Face view directions (keep in step with FACE_F in <see cref="Shaders.LIGHTS_GLSL"/>).</summary>
        public static readonly Vector3[] FaceForward = { Vector3.UnitX, -Vector3.UnitX, Vector3.UnitY, -Vector3.UnitY, Vector3.UnitZ, -Vector3.UnitZ };

        /// <summary>Face up vectors (keep in step with FACE_U in <see cref="Shaders.LIGHTS_GLSL"/>).</summary>
        public static readonly Vector3[] FaceUp = { Vector3.UnitZ, Vector3.UnitZ, Vector3.UnitZ, Vector3.UnitZ, Vector3.UnitY, Vector3.UnitY };

        #endregion

        #region Fields

        /// <summary>One cached light map.</summary>
        private struct Slot
        {
            public bool Assigned, Rendered;
            public long Key, SceneKey;
            public Vector3 Position;
            public float Radius;
            public int LastUsed, ReadyFrame;
        }

        private readonly Slot[] _slots = new Slot[ArtificialLighting.MAX_LIGHTS];
        private readonly Vector4[] _planes = new Vector4[6];
        private uint _depth, _fbo;
        private int _frame;

        #endregion

        #region State

        /// <summary>True once the texture array is allocated and complete.</summary>
        public bool Ready { get; private set; }

        /// <summary>The last failure, or null.</summary>
        public string LastError { get; private set; }

        /// <summary>One texel in texture coordinates.</summary>
        public static float Texel => 1f / SIZE;

        /// <summary>Lights (× 6 faces) rendered last frame (stats).</summary>
        public int RenderedLastFrame { get; private set; }

        #endregion

        #region Setup

        /// <summary>
        /// Allocates the texture array and framebuffer if they aren't already.
        /// </summary>
        /// <returns>False if the GPU refused (see <see cref="LastError"/>).</returns>
        public bool Ensure()
        {
            if (Ready) { return true; }
            if (LastError != null) { return false; }

            while (Gl.GetError() != Gl.NO_ERROR) { /* clear stale errors */ }
            int layers = ArtificialLighting.MAX_LIGHTS * 6;
            _depth = Gl.GenTexture();
            Gl.BindTexture(Gl.TEXTURE_2D_ARRAY, _depth);
            Gl.TexImage3D(Gl.TEXTURE_2D_ARRAY, 0, Gl.DEPTH_COMPONENT16, SIZE, SIZE, layers, Gl.DEPTH_COMPONENT, Gl.UNSIGNED_SHORT, null);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_MIN_FILTER, (int)Gl.LINEAR);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_MAG_FILTER, (int)Gl.LINEAR);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_COMPARE_MODE, (int)Gl.COMPARE_REF_TO_TEXTURE);
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_COMPARE_FUNC, (int)Gl.LEQUAL);
            Gl.BindTexture(Gl.TEXTURE_2D_ARRAY, 0);

            _fbo = Gl.GenFramebuffer();
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, _fbo);
            Gl.FramebufferTextureLayer(Gl.FRAMEBUFFER, Gl.DEPTH_ATTACHMENT, _depth, 0, 0);
            Gl.DrawBuffer(Gl.NONE);
            Gl.ReadBuffer(Gl.NONE);
            uint status = Gl.CheckFramebufferStatus(Gl.FRAMEBUFFER);
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);

            uint error = Gl.GetError();
            if (error != Gl.NO_ERROR || status != Gl.FRAMEBUFFER_COMPLETE)
            {
                LastError = error == Gl.OUT_OF_MEMORY
                    ? "Not enough graphics memory for light shadows: lights now pass through walls"
                    : $"Light shadows are not supported on this graphics driver (0x{(error != Gl.NO_ERROR ? error : status):X}): lights now pass through walls";
                Utilities.Log_Utils.Write(LastError);
                Release();
                return false;
            }

            Array.Clear(_slots);
            Ready = true;
            Utilities.Log_Utils.Write($"Light shadows: {ArtificialLighting.MAX_LIGHTS} × 6 faces × {SIZE} px ({layers * SIZE * SIZE * 2 / (1024 * 1024)} MB).");
            return true;
        }

        /// <summary>
        /// Frees the maps (lights off), forgetting every slot.
        /// </summary>
        public void Release()
        {
            Gl.DeleteTexture(_depth);
            Gl.DeleteFramebuffer(_fbo);
            _depth = _fbo = 0;
            Array.Clear(_slots);
            Ready = false;
        }

        #endregion

        #region Frame

        /// <summary>
        /// Gives each picked light a slot (keeping the one it had), and lists the slots to render this frame.
        /// </summary>
        /// <param name="lights">This frame's picked lights (nearest first; <see cref="ArtificialLighting.Key"/> set).</param>
        /// <param name="sceneKey">Changes whenever shadow casters change.</param>
        /// <param name="slotOf">Out: the slot per picked light.</param>
        /// <param name="render">Out: picked-light indices whose maps to render now (cleared first).</param>
        public void Assign(ArtificialLighting lights, long sceneKey, int[] slotOf, List<int> render)
        {
            _frame++;
            render.Clear();
            int count = lights.Count;

            // Keep the slots of lights that already have one
            for (int k = 0; k < count; k++)
            {
                slotOf[k] = -1;
                for (int s = 0; s < _slots.Length; s++)
                {
                    if (_slots[s].Assigned && _slots[s].Key == lights.Key[k])
                    {
                        slotOf[k] = s;
                        _slots[s].LastUsed = _frame;
                        break;
                    }
                }
            }

            // New lights take the least recently used free slot
            for (int k = 0; k < count; k++)
            {
                if (slotOf[k] >= 0) { continue; }
                int best = -1;
                for (int s = 0; s < _slots.Length; s++)
                {
                    if (_slots[s].LastUsed == _frame) { continue; }
                    if (best < 0 || !_slots[s].Assigned || (_slots[best].Assigned && _slots[s].LastUsed < _slots[best].LastUsed)) { best = s; }
                    if (!_slots[best].Assigned) { break; }
                }
                if (best < 0) { continue; }
                _slots[best] = new Slot { Assigned = true, Key = lights.Key[k], LastUsed = _frame };
                slotOf[k] = best;
            }

            // What to render: never-rendered first, then moved / stale (both nearest first)
            for (int pass = 0; pass < 2 && render.Count < LIGHTS_PER_FRAME; pass++)
            {
                for (int k = 0; k < count && render.Count < LIGHTS_PER_FRAME; k++)
                {
                    int s = slotOf[k];
                    if (s < 0) { continue; }
                    ref Slot slot = ref _slots[s];
                    Vector4 p = lights.Position[k];
                    bool stale = slot.SceneKey != sceneKey || slot.Position != new Vector3(p.X, p.Y, p.Z) || slot.Radius != p.W;
                    if (pass == 0 ? !slot.Rendered : slot.Rendered && stale) { render.Add(k); }
                }
            }
        }

        /// <summary>
        /// The light view-projection of one face.
        /// </summary>
        public static Matrix4x4 FaceMatrix(Vector3 position, float radius, int face)
        {
            Matrix4x4 view = Matrix4x4.CreateLookAt(position, position + FaceForward[face], FaceUp[face]);
            Matrix4x4 projection = FpsCamera.Perspective(2f * MathF.Atan(PAD), 1f, NEAR, MathF.Max(radius, NEAR * 2f));
            return view * projection;
        }

        /// <summary>
        /// Binds the framebuffer to one face of a slot, clears it and sets the viewport.
        /// </summary>
        /// <returns>The face's culling planes.</returns>
        public Vector4[] BeginFace(int slot, int face, in Matrix4x4 matrix)
        {
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, _fbo);
            Gl.FramebufferTextureLayer(Gl.FRAMEBUFFER, Gl.DEPTH_ATTACHMENT, _depth, 0, slot * 6 + face);
            Gl.Viewport(0, 0, SIZE, SIZE);
            Gl.DepthMask(true);
            Gl.ClearDepth(1.0);
            Gl.Clear(Gl.DEPTH_BUFFER_BIT);
            FpsCamera.ExtractPlanes(matrix, _planes);
            return _planes;
        }

        /// <summary>
        /// Records that a slot's map now matches its light and the scene.
        /// </summary>
        public void MarkRendered(int slot, Vector4 light, long sceneKey)
        {
            ref Slot s = ref _slots[slot];
            if (!s.Rendered) { s.ReadyFrame = _frame; }
            s.Rendered = true;
            s.Position = new Vector3(light.X, light.Y, light.Z);
            s.Radius = light.W;
            s.SceneKey = sceneKey;
        }

        /// <summary>
        /// True if a slot has a map, with how far its light has faded in (0–1).
        /// </summary>
        public bool HasMap(int slot, out float fadeIn)
        {
            fadeIn = 0f;
            if (slot < 0 || !_slots[slot].Rendered) { return false; }
            fadeIn = Math.Clamp((_frame - _slots[slot].ReadyFrame + 1) / (float)FADE_IN_FRAMES, 0f, 1f);
            return true;
        }

        /// <summary>
        /// Restores the default framebuffer after rendering faces.
        /// </summary>
        public void EndRender(int lightsRendered)
        {
            RenderedLastFrame = lightsRendered;
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);
        }

        /// <summary>
        /// Binds the maps to <see cref="UNIT"/> (leaves unit 0 active).
        /// </summary>
        public void Bind()
        {
            Gl.ActiveTexture(Gl.TEXTURE0 + UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D_ARRAY, _depth);
            Gl.ActiveTexture(Gl.TEXTURE0);
        }

        #endregion

        /// <summary>
        /// Releases GL resources.
        /// </summary>
        public void Dispose() => Release();
    }
}
