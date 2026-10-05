using BimGo.Format;
using Gl = BimGo.Native.Gl;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Bookmark thumbnails: a small picture of the view (192 × 108, JPEG, base64 in the bookmark) taken the frame after
    /// a bookmark is made or moved (B, ADD THIS VIEW, SET HERE), from the 3D view only (no HUD or menus), and shown in
    /// the BOOKMARKS list. Textures are made on first use and freed with the session.
    /// </summary>
    internal sealed partial class GameSession
    {
        #region Constants

        private const int THUMB_WIDTH = 192, THUMB_HEIGHT = 108;
        private const long THUMB_JPEG_QUALITY = 72L;

        #endregion

        #region Fields

        /// <summary>The bookmark whose thumbnail is taken at the end of this frame's 3D pass, or null.</summary>
        private BookmarkRecord _thumbnailFor;

        // Uploaded thumbnails: the base64 they came from (re-uploaded when it changes) and the GL texture (0 = unreadable)
        private readonly Dictionary<BookmarkRecord, (string Data, uint Texture)> _thumbnailTextures = new();

        #endregion

        #region Capture

        /// <summary>
        /// Reads the window's back buffer (scene only), crops it to 16:9 and stores a small JPEG on the bookmark.
        /// Called right after the scene is copied to the window, before the map and UI are drawn.
        /// </summary>
        private unsafe void CaptureThumbnail(int width, int height)
        {
            BookmarkRecord record = _thumbnailFor;
            _thumbnailFor = null;
            if (record == null || width < 16 || height < 16) { return; }

            try
            {
                byte[] pixels = new byte[width * height * 4];
                Gl.BindFramebuffer(Gl.READ_FRAMEBUFFER, 0);
                Gl.ReadBuffer(Gl.BACK);
                Gl.PixelStore(Gl.PACK_ALIGNMENT, 1);
                fixed (byte* p = pixels)
                {
                    Gl.ReadPixels(0, 0, width, height, Gl.BGRA, Gl.UNSIGNED_BYTE, p);
                }

                string data = EncodeThumbnail(pixels, width, height);
                if (Bookmarks.Bookmarks.Contains(record)) { Bookmarks.SetThumbnail(record, data); }
                else { record.Thumbnail = data; } // pending (B): saved when its name is confirmed
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Bookmark thumbnail failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Box-filters the centre 16:9 part of a bottom-up BGRA image down to the thumbnail size and encodes it as a
        /// base64 JPEG.
        /// </summary>
        private static string EncodeThumbnail(byte[] bgra, int width, int height)
        {
            // Centre crop to 16:9
            float aspect = (float)THUMB_WIDTH / THUMB_HEIGHT;
            int cropW = width, cropH = height;
            if ((float)width / height > aspect) { cropW = (int)(height * aspect); }
            else { cropH = (int)(width / aspect); }
            int x0 = (width - cropW) / 2, y0 = (height - cropH) / 2;

            // Average a 3 × 3 grid of samples per thumbnail pixel (cheap, smooth enough at this size)
            byte[] thumb = new byte[THUMB_WIDTH * THUMB_HEIGHT * 4];
            for (int ty = 0; ty < THUMB_HEIGHT; ty++)
            {
                for (int tx = 0; tx < THUMB_WIDTH; tx++)
                {
                    int b = 0, g = 0, r = 0;
                    for (int sy = 0; sy < 3; sy++)
                    {
                        // Thumbnail rows go top-down; GL rows bottom-up
                        int y = y0 + (int)((ty + (sy + 0.5f) / 3f) * cropH / THUMB_HEIGHT);
                        int row = height - 1 - Math.Clamp(y, 0, height - 1);
                        for (int sx = 0; sx < 3; sx++)
                        {
                            int x = Math.Clamp(x0 + (int)((tx + (sx + 0.5f) / 3f) * cropW / THUMB_WIDTH), 0, width - 1);
                            int i = (row * width + x) * 4;
                            b += bgra[i];
                            g += bgra[i + 1];
                            r += bgra[i + 2];
                        }
                    }
                    int o = (ty * THUMB_WIDTH + tx) * 4;
                    thumb[o] = (byte)(b / 9);
                    thumb[o + 1] = (byte)(g / 9);
                    thumb[o + 2] = (byte)(r / 9);
                    thumb[o + 3] = 255;
                }
            }

            using var bitmap = new System.Drawing.Bitmap(THUMB_WIDTH, THUMB_HEIGHT, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            System.Drawing.Imaging.BitmapData data = bitmap.LockBits(new System.Drawing.Rectangle(0, 0, THUMB_WIDTH, THUMB_HEIGHT),
                System.Drawing.Imaging.ImageLockMode.WriteOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            try
            {
                for (int y = 0; y < THUMB_HEIGHT; y++)
                {
                    System.Runtime.InteropServices.Marshal.Copy(thumb, y * THUMB_WIDTH * 4, data.Scan0 + y * data.Stride, THUMB_WIDTH * 4);
                }
            }
            finally
            {
                bitmap.UnlockBits(data);
            }

            System.Drawing.Imaging.ImageCodecInfo jpeg = System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders()
                .FirstOrDefault(c => c.FormatID == System.Drawing.Imaging.ImageFormat.Jpeg.Guid);
            using var stream = new MemoryStream();
            if (jpeg != null)
            {
                using var parameters = new System.Drawing.Imaging.EncoderParameters(1);
                parameters.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, THUMB_JPEG_QUALITY);
                bitmap.Save(stream, jpeg, parameters);
            }
            else
            {
                bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
            }
            return Convert.ToBase64String(stream.ToArray());
        }

        #endregion

        #region Textures

        /// <summary>
        /// The GL texture of a bookmark's thumbnail (made on first use, remade when the thumbnail changes), or 0.
        /// </summary>
        private unsafe uint ThumbnailTexture(BookmarkRecord record)
        {
            string data = record?.Thumbnail;
            if (string.IsNullOrEmpty(data)) { return 0; }
            if (_thumbnailTextures.TryGetValue(record, out (string Data, uint Texture) cached))
            {
                if (ReferenceEquals(cached.Data, data)) { return cached.Texture; }
                if (cached.Texture != 0) { Gl.DeleteTexture(cached.Texture); }
            }

            uint texture = 0;
            try
            {
                using var stream = new MemoryStream(Convert.FromBase64String(data));
                using var decoded = new System.Drawing.Bitmap(stream);
                using var bitmap = new System.Drawing.Bitmap(decoded.Width, decoded.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                using (var graphics = System.Drawing.Graphics.FromImage(bitmap)) { graphics.DrawImage(decoded, 0, 0, decoded.Width, decoded.Height); }

                System.Drawing.Imaging.BitmapData bits = bitmap.LockBits(new System.Drawing.Rectangle(0, 0, bitmap.Width, bitmap.Height),
                    System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                try
                {
                    texture = Gl.GenTexture();
                    Gl.BindTexture(Gl.TEXTURE_2D, texture);
                    Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, (int)Gl.LINEAR);
                    Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, (int)Gl.LINEAR);
                    Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, (int)Gl.CLAMP_TO_EDGE);
                    Gl.TexParameter(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, (int)Gl.CLAMP_TO_EDGE);
                    Gl.PixelStore(Gl.UNPACK_ALIGNMENT, 4);
                    Gl.TexImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA8, bitmap.Width, bitmap.Height, Gl.BGRA, Gl.UNSIGNED_BYTE, (void*)bits.Scan0);
                    Gl.BindTexture(Gl.TEXTURE_2D, 0);
                }
                finally
                {
                    bitmap.UnlockBits(bits);
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Bookmark thumbnail unreadable ({record.Name}): {ex.Message}");
                if (texture != 0) { Gl.DeleteTexture(texture); }
                texture = 0;
            }

            _thumbnailTextures[record] = (data, texture);
            return texture;
        }

        /// <summary>
        /// Frees every thumbnail texture (session end).
        /// </summary>
        private void ReleaseThumbnails()
        {
            foreach ((string _, uint texture) in _thumbnailTextures.Values)
            {
                if (texture != 0) { Gl.DeleteTexture(texture); }
            }
            _thumbnailTextures.Clear();
        }

        #endregion
    }
}
