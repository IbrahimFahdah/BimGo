using System.Numerics;
using BimGo.Native;
using BimGo.Scene;
using SD = System.Drawing;
using SDI = System.Drawing.Imaging;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// GPU side of the Realistic colour mode: the material table and the texture images.
    /// <list type="bullet">
    /// <item><b>Images</b> go into up to four mipmapped RGBA8 texture arrays by size (256², 512², 1024², 2048²). Each
    /// image takes the smallest bucket that holds its longest side (never above the size it was extracted at), so a
    /// model of 256 px library textures doesn't pay for 1024² layers. Rectangular images are stretched to the square
    /// layer; their real-world width and height keep the proportions on screen.</item>
    /// <item><b>The table</b> is a small RGBA32F texture, four texels per material (read with texelFetch, so any
    /// number of materials fits on GL 3.3): (colour, fade) (tint, reflectivity) (scale U, scale V, offset U, offset V)
    /// (cos angle, sin angle, bucket or -1, layer).</item>
    /// </list>
    /// One draw path for every material: the scene shader picks the material per vertex, nothing is bound per batch.
    /// Images that can't be decoded are left out (the material shows its colour).
    /// </summary>
    internal sealed unsafe class MaterialTextures : IDisposable
    {
        #region Constants

        /// <summary>Texture unit of the material table.</summary>
        public const int TABLE_UNIT = 6;

        /// <summary>First texture unit of the size buckets (one unit per bucket: 7, 8, 9, 10).</summary>
        public const int BUCKET_UNIT = 7;

        /// <summary>The bucket sizes (px), smallest first. The shader has one sampler per bucket.</summary>
        public static readonly int[] BUCKETS = { 256, 512, 1024, 2048 };

        /// <summary>Texels per material in the table.</summary>
        private const int TEXELS = 4;

        #endregion

        #region Fields and properties

        private uint _table;
        private readonly uint[] _arrays = new uint[BUCKETS.Length];

        /// <summary>True when there is a material table (the Realistic mode can be shown).</summary>
        public bool Ready => _table != 0;

        /// <summary>Materials in the table.</summary>
        public int MaterialCount { get; private set; }

        /// <summary>Images uploaded.</summary>
        public int ImageCount { get; private set; }

        /// <summary>Approximate GPU memory used by the arrays (bytes, mipmaps included).</summary>
        public long GpuBytes { get; private set; }

        #endregion

        /// <summary>
        /// Decodes the images and uploads the arrays and the table (GL thread). Never throws: on failure the mode is
        /// unavailable and the reason is logged.
        /// </summary>
        /// <param name="materials">The snapshot's materials.</param>
        /// <returns>Null, or a short reason the textures couldn't all be shown.</returns>
        public string Initialise(MaterialData materials)
        {
            if (materials == null || materials.IsEmpty) { return null; }
            string warning = null;
            try
            {
                int maxLayers = Math.Max(64, Gl.GetInteger(Gl.MAX_ARRAY_TEXTURE_LAYERS));
                int maxSize = Math.Max(1024, Gl.GetInteger(Gl.MAX_TEXTURE_SIZE));

                // Decode each referenced image once and choose its bucket
                var placements = new Dictionary<string, (int Bucket, int Layer)>(StringComparer.Ordinal);
                var pending = new List<(int Bucket, byte[] Pixels)>[BUCKETS.Length];
                for (int b = 0; b < BUCKETS.Length; b++) { pending[b] = new List<(int, byte[])>(); }

                foreach (SceneMaterial material in materials.Materials)
                {
                    string name = material.Texture;
                    if (name == null || placements.ContainsKey(name)) { continue; }
                    if (!materials.Textures.TryGetValue(name, out byte[] bytes)) { continue; }

                    int bucket = BucketFor(bytes, Math.Min(materials.TextureMaxSize, maxSize));
                    while (bucket >= 0 && pending[bucket].Count >= maxLayers) { bucket--; }
                    if (bucket < 0)
                    {
                        warning = "Some textures were left out (too many for this graphics card).";
                        continue;
                    }

                    byte[] pixels = Decode(bytes, BUCKETS[bucket]);
                    if (pixels == null) { continue; }
                    placements[name] = (bucket, pending[bucket].Count);
                    pending[bucket].Add((bucket, pixels));
                }

                // Arrays: allocate, fill layer by layer, mipmap
                for (int b = 0; b < BUCKETS.Length; b++)
                {
                    if (pending[b].Count == 0) { continue; }
                    int size = BUCKETS[b], layers = pending[b].Count;
                    _arrays[b] = Gl.GenTexture();
                    Gl.ActiveTexture(Gl.TEXTURE0 + (uint)(BUCKET_UNIT + b));
                    Gl.BindTexture(Gl.TEXTURE_2D_ARRAY, _arrays[b]);
                    Gl.PixelStore(Gl.UNPACK_ALIGNMENT, 4);
                    Gl.TexImage3D(Gl.TEXTURE_2D_ARRAY, 0, Gl.RGBA8, size, size, layers, Gl.BGRA, Gl.UNSIGNED_BYTE, null);
                    for (int layer = 0; layer < layers; layer++)
                    {
                        fixed (byte* p = pending[b][layer].Pixels)
                        {
                            Gl.TexSubImage3D(Gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1, Gl.BGRA, Gl.UNSIGNED_BYTE, p);
                        }
                    }
                    Gl.GenerateMipmap(Gl.TEXTURE_2D_ARRAY);
                    Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_MIN_FILTER, (int)Gl.LINEAR_MIPMAP_LINEAR);
                    Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_MAG_FILTER, (int)Gl.LINEAR);
                    Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_WRAP_S, (int)Gl.REPEAT);
                    Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_WRAP_T, (int)Gl.REPEAT);
                    SetAnisotropy();
                    GpuBytes += (long)size * size * 4 * layers * 4 / 3;
                    ImageCount += layers;
                }

                UploadTable(materials.Materials, placements);
                Gl.ActiveTexture(Gl.TEXTURE0);

                uint error = Gl.GetError();
                if (error == Gl.OUT_OF_MEMORY)
                {
                    Release();
                    return "Not enough graphics memory for the textures: Realistic mode shows colours only. Try a smaller texture size.";
                }

                Utilities.Log_Utils.Write($"Materials: {MaterialCount} in the table, {ImageCount} images in " +
                    $"{string.Join(", ", BUCKETS.Select((s, b) => (s, n: pending[b].Count)).Where(x => x.n > 0).Select(x => $"{x.n}×{x.s}²"))}, ≈ {GpuBytes / (1024 * 1024)} MB.");
                return warning;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Material textures failed: {ex}");
                Release();
                return "Textures could not be loaded: Realistic mode is unavailable (see the log).";
            }
        }

        /// <summary>
        /// Binds the table and arrays to their units (call before drawing with the Realistic mode; leaves unit 0 active).
        /// </summary>
        public void Bind()
        {
            if (!Ready) { return; }
            Gl.ActiveTexture(Gl.TEXTURE0 + TABLE_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D, _table);
            for (int b = 0; b < BUCKETS.Length; b++)
            {
                Gl.ActiveTexture(Gl.TEXTURE0 + (uint)(BUCKET_UNIT + b));
                Gl.BindTexture(Gl.TEXTURE_2D_ARRAY, _arrays[b]);
            }
            Gl.ActiveTexture(Gl.TEXTURE0);
        }

        #region Upload helpers

        /// <summary>
        /// The table: four RGBA32F texels per material (see the class remarks).
        /// </summary>
        private void UploadTable(SceneMaterial[] materials, Dictionary<string, (int Bucket, int Layer)> placements)
        {
            int count = materials.Length;
            float[] data = new float[count * TEXELS * 4];
            for (int i = 0; i < count; i++)
            {
                SceneMaterial m = materials[i];
                int o = i * TEXELS * 4;
                bool textured = m.Texture != null && placements.TryGetValue(m.Texture, out _);
                (int bucket, int layer) = textured ? placements[m.Texture] : (-1, 0);
                float angle = m.Angle * MathF.PI / 180f;

                Put(o, m.Colour, textured ? m.Fade : 0f);
                Put(o + 4, m.Tint, m.Reflectivity);
                data[o + 8] = MathF.Max(m.ScaleU, 1e-3f);
                data[o + 9] = MathF.Max(m.ScaleV, 1e-3f);
                data[o + 10] = m.OffsetU;
                data[o + 11] = m.OffsetV;
                data[o + 12] = MathF.Cos(angle);
                data[o + 13] = MathF.Sin(angle);
                data[o + 14] = bucket;
                data[o + 15] = layer;
            }

            _table = Gl.GenTexture();
            Gl.ActiveTexture(Gl.TEXTURE0 + TABLE_UNIT);
            Gl.BindTexture(Gl.TEXTURE_2D, _table);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)Gl.NEAREST);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)Gl.NEAREST);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAX_LEVEL, 0);
            fixed (float* p = data)
            {
                Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA32F, TEXELS, count, Gl.RGBA, Gl.FLOAT, p);
            }
            MaterialCount = count;

            void Put(int offset, Vector3 rgb, float w)
            {
                data[offset] = rgb.X;
                data[offset + 1] = rgb.Y;
                data[offset + 2] = rgb.Z;
                data[offset + 3] = w;
            }
        }

        /// <summary>
        /// Anisotropic filtering when the driver offers it (floors at grazing angles stay sharp). Errors are cleared:
        /// without the extension the arrays simply stay trilinear.
        /// </summary>
        private static void SetAnisotropy()
        {
            int max = Gl.GetInteger(Gl.MAX_TEXTURE_MAX_ANISOTROPY);
            if (Gl.GetError() != Gl.NO_ERROR || max < 2) { return; }
            Gl.TexParameter(Gl.TEXTURE_2D_ARRAY, Gl.TEXTURE_MAX_ANISOTROPY, MathF.Min(8f, max));
            Gl.GetError();
        }

        /// <summary>
        /// The bucket for an image: the smallest that holds its longest side, capped (index into <see cref="BUCKETS"/>).
        /// </summary>
        private static int BucketFor(byte[] bytes, int cap)
        {
            int longest = cap;
            try
            {
                using var stream = new MemoryStream(bytes, writable: false);
                using var image = SD.Image.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: false);
                longest = Math.Min(Math.Max(image.Width, image.Height), cap);
            }
            catch
            {
                // Decode will fail too and leave it out
            }
            for (int b = 0; b < BUCKETS.Length; b++)
            {
                if (BUCKETS[b] >= longest || BUCKETS[b] >= cap) { return b; }
            }
            return BUCKETS.Length - 1;
        }

        /// <summary>
        /// Decodes an image and resamples it to a size × size BGRA layer (top row first; the shader flips V).
        /// Null if it can't be decoded.
        /// </summary>
        private static byte[] Decode(byte[] bytes, int size)
        {
            try
            {
                using var stream = new MemoryStream(bytes, writable: false);
                using var image = SD.Image.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: true);
                using var layer = new SD.Bitmap(size, size, SDI.PixelFormat.Format32bppArgb);
                using (var g = SD.Graphics.FromImage(layer))
                {
                    g.Clear(SD.Color.White);
                    g.InterpolationMode = SD.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = SD.Drawing2D.PixelOffsetMode.HighQuality;
                    g.CompositingMode = SD.Drawing2D.CompositingMode.SourceOver;
                    using var wrap = new SDI.ImageAttributes();
                    wrap.SetWrapMode(SD.Drawing2D.WrapMode.Tile); // tiling texture: edge samples wrap round
                    g.DrawImage(image, new SD.Rectangle(0, 0, size, size), 0, 0, image.Width, image.Height, SD.GraphicsUnit.Pixel, wrap);
                }

                var rect = new SD.Rectangle(0, 0, size, size);
                SDI.BitmapData data = layer.LockBits(rect, SDI.ImageLockMode.ReadOnly, SDI.PixelFormat.Format32bppArgb);
                try
                {
                    byte[] pixels = new byte[size * size * 4];
                    for (int y = 0; y < size; y++)
                    {
                        System.Runtime.InteropServices.Marshal.Copy(data.Scan0 + y * data.Stride, pixels, y * size * 4, size * 4);
                    }
                    for (int i = 3; i < pixels.Length; i += 4) { pixels[i] = 255; } // opaque (cutouts are out of scope)
                    return pixels;
                }
                finally
                {
                    layer.UnlockBits(data);
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Texture image could not be decoded: {ex.Message}");
                return null;
            }
        }

        #endregion

        /// <summary>
        /// Frees the GPU objects (the mode becomes unavailable).
        /// </summary>
        public void Release()
        {
            Gl.DeleteTexture(_table);
            _table = 0;
            for (int b = 0; b < _arrays.Length; b++)
            {
                Gl.DeleteTexture(_arrays[b]);
                _arrays[b] = 0;
            }
            MaterialCount = ImageCount = 0;
            GpuBytes = 0;
        }

        /// <inheritdoc/>
        public void Dispose() => Release();
    }
}
