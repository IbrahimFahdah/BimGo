using System.Runtime.InteropServices;
using BimGo.Native;
using SD = System.Drawing;
using SDI = System.Drawing.Imaging;
using SDT = System.Drawing.Text;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// One glyph's atlas rectangle and metrics (pixels).
    /// </summary>
    internal struct Glyph
    {
        public float U0, V0, U1, V1;
        public float Width, Height;
        public float Advance;
        public float OffsetX, OffsetY;
        public bool Valid;
    }

    /// <summary>
    /// A rasterised font inside the shared atlas.
    /// </summary>
    internal sealed class UiFont
    {
        private readonly Glyph[] _latin = new Glyph[256];
        private readonly char[] _extraChars;
        private readonly Glyph[] _extraGlyphs;

        /// <summary>Line height in pixels.</summary>
        public float LineHeight { get; }

        internal UiFont(float lineHeight, Glyph[] latin, char[] extraChars, Glyph[] extraGlyphs)
        {
            LineHeight = lineHeight;
            _latin = latin;
            _extraChars = extraChars;
            _extraGlyphs = extraGlyphs;
        }

        /// <summary>
        /// Gets a glyph ('?' for anything not in the atlas).
        /// </summary>
        public ref readonly Glyph Get(char c)
        {
            if (c < 256)
            {
                if (_latin[c].Valid) { return ref _latin[c]; }
            }
            else
            {
                for (int i = 0; i < _extraChars.Length; i++)
                {
                    if (_extraChars[i] == c) { return ref _extraGlyphs[i]; }
                }
            }
            return ref _latin['?'];
        }
    }

    /// <summary>
    /// Builds the UI font atlas with GDI+ once at startup (white glyphs on transparent, plus a white block for solid fills).
    /// </summary>
    internal sealed unsafe class FontAtlas : IDisposable
    {
        /// <summary>Extra non-Latin-1 characters used by the HUD.</summary>
        private static readonly char[] EXTRA = { 'Δ', '−', '—', '–', '…', '•', '↑', '↓', '←', '→', '“', '”', '’' };

        /// <summary>The GL texture.</summary>
        public uint Texture { get; private set; }

        /// <summary>Atlas size in pixels.</summary>
        public int Size { get; private set; }

        /// <summary>UV of the solid white block.</summary>
        public float WhiteU { get; private set; }

        /// <summary>UV of the solid white block.</summary>
        public float WhiteV { get; private set; }

        /// <summary>Small caps labels (11 px).</summary>
        public UiFont Small { get; private set; }

        /// <summary>Body text (14 px).</summary>
        public UiFont Body { get; private set; }

        /// <summary>Emphasised body (16 px semibold).</summary>
        public UiFont Bold { get; private set; }

        /// <summary>Large title (40 px bold).</summary>
        public UiFont Title { get; private set; }

        /// <summary>Monospace readouts (13 px).</summary>
        public UiFont Mono { get; private set; }

        /// <summary>Large monospace readouts (26 px).</summary>
        public UiFont MonoLarge { get; private set; }

        /// <summary>
        /// Rasterises all fonts and uploads the atlas.
        /// </summary>
        /// <param name="scale">UI scale (DPI / 96).</param>
        public void Build(float scale)
        {
            Size = scale <= 1.01f ? 1024 : scale <= 2.01f ? 2048 : 4096;
            using var bitmap = new SD.Bitmap(Size, Size, SDI.PixelFormat.Format32bppArgb);
            using (SD.Graphics g = SD.Graphics.FromImage(bitmap))
            {
                g.Clear(SD.Color.Transparent);
                g.TextRenderingHint = SDT.TextRenderingHint.AntiAliasGridFit;
                g.FillRectangle(SD.Brushes.White, 0, 0, 4, 4);
                WhiteU = 2f / Size;
                WhiteV = 2f / Size;

                var packer = new Packer { X = 6, Y = 0, RowHeight = 6 };
                Small = Rasterise(g, ref packer, new[] { "Bahnschrift SemiBold", "Segoe UI Semibold" }, 11f * scale, SD.FontStyle.Regular);
                Body = Rasterise(g, ref packer, new[] { "Bahnschrift", "Segoe UI" }, 14f * scale, SD.FontStyle.Regular);
                Bold = Rasterise(g, ref packer, new[] { "Bahnschrift SemiBold", "Segoe UI Semibold" }, 16f * scale, SD.FontStyle.Regular);
                Title = Rasterise(g, ref packer, new[] { "Bahnschrift", "Segoe UI" }, 40f * scale, SD.FontStyle.Bold);
                Mono = Rasterise(g, ref packer, new[] { "Consolas", "Courier New" }, 13f * scale, SD.FontStyle.Regular);
                MonoLarge = Rasterise(g, ref packer, new[] { "Consolas", "Courier New" }, 26f * scale, SD.FontStyle.Bold);
            }

            Upload(bitmap);
        }

        /// <summary>
        /// Shelf packer state.
        /// </summary>
        private struct Packer
        {
            public int X, Y, RowHeight;
        }

        /// <summary>
        /// Rasterises one font into the atlas.
        /// </summary>
        private UiFont Rasterise(SD.Graphics g, ref Packer packer, string[] families, float pixelSize, SD.FontStyle style)
        {
            using SD.Font font = CreateFont(families, pixelSize, style);
            using var format = (SD.StringFormat)SD.StringFormat.GenericTypographic.Clone();
            format.FormatFlags |= SD.StringFormatFlags.MeasureTrailingSpaces | SD.StringFormatFlags.NoClip;

            float lineHeight = MathF.Ceiling(font.GetHeight(g));
            int cellHeight = (int)lineHeight + 2;
            var latin = new Glyph[256];
            var extra = new Glyph[EXTRA.Length];

            Glyph Add(char c, ref Packer p)
            {
                string text = c.ToString();
                float advance = g.MeasureString(text, font, SD.PointF.Empty, format).Width;
                int cellWidth = (int)MathF.Ceiling(advance) + 5;

                if (p.X + cellWidth >= Size) { p.X = 0; p.Y += p.RowHeight + 1; p.RowHeight = 0; }
                if (p.Y + cellHeight >= Size) { return default; }

                g.DrawString(text, font, SD.Brushes.White, p.X + 2, p.Y + 1, format);
                var glyph = new Glyph
                {
                    U0 = (float)p.X / Size,
                    V0 = (float)p.Y / Size,
                    U1 = (float)(p.X + cellWidth) / Size,
                    V1 = (float)(p.Y + cellHeight) / Size,
                    Width = cellWidth,
                    Height = cellHeight,
                    Advance = advance,
                    OffsetX = -2f,
                    OffsetY = -1f,
                    Valid = true
                };
                p.X += cellWidth + 1;
                p.RowHeight = Math.Max(p.RowHeight, cellHeight);
                return glyph;
            }

            for (int c = 32; c < 256; c++)
            {
                if (c >= 127 && c < 160) { continue; }
                latin[c] = Add((char)c, ref packer);
            }
            for (int i = 0; i < EXTRA.Length; i++)
            {
                extra[i] = Add(EXTRA[i], ref packer);
            }

            // Next font starts on a fresh row
            packer.X = 0;
            packer.Y += packer.RowHeight + 2;
            packer.RowHeight = 0;

            return new UiFont(lineHeight, latin, EXTRA, extra);
        }

        /// <summary>
        /// Creates the first available font family from a list.
        /// </summary>
        private static SD.Font CreateFont(string[] families, float pixelSize, SD.FontStyle style)
        {
            foreach (string family in families)
            {
                try
                {
                    using var test = new SD.FontFamily(family);
                    if (test.IsStyleAvailable(style))
                    {
                        return new SD.Font(family, pixelSize, style, SD.GraphicsUnit.Pixel);
                    }
                }
                catch (ArgumentException)
                {
                    // Not installed; try the next
                }
            }
            return new SD.Font(SD.FontFamily.GenericSansSerif, pixelSize, style, SD.GraphicsUnit.Pixel);
        }

        /// <summary>
        /// Converts to white-with-alpha RGBA and uploads.
        /// </summary>
        private void Upload(SD.Bitmap bitmap)
        {
            var rect = new SD.Rectangle(0, 0, Size, Size);
            SDI.BitmapData data = bitmap.LockBits(rect, SDI.ImageLockMode.ReadOnly, SDI.PixelFormat.Format32bppArgb);
            byte[] pixels = new byte[Size * Size * 4];
            try
            {
                for (int y = 0; y < Size; y++)
                {
                    Marshal.Copy(data.Scan0 + y * data.Stride, pixels, y * Size * 4, Size * 4);
                }
            }
            finally
            {
                bitmap.UnlockBits(data);
            }

            // BGRA in memory: force white RGB, keep alpha
            for (int i = 0; i < pixels.Length; i += 4)
            {
                pixels[i] = 255;
                pixels[i + 1] = 255;
                pixels[i + 2] = 255;
            }

            Texture = Gl.GenTexture();
            Gl.BindTexture(Gl.TEXTURE_2D, Texture);
            Gl.PixelStore(Gl.UNPACK_ALIGNMENT, 4);
            fixed (byte* p = pixels)
            {
                Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA8, Size, Size, Gl.BGRA, Gl.UNSIGNED_BYTE, p);
            }
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)Gl.LINEAR);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)Gl.LINEAR);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
            Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
            Gl.BindTexture(Gl.TEXTURE_2D, 0);
        }

        /// <summary>
        /// Deletes the texture.
        /// </summary>
        public void Dispose()
        {
            Gl.DeleteTexture(Texture);
            Texture = 0;
        }
    }
}
