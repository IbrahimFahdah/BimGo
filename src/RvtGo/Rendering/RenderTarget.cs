using RvtGo.Native;

// The class belongs to the Rendering namespace
namespace RvtGo.Rendering
{
    /// <summary>
    /// The off-screen scene framebuffer (optionally multisampled). The 3D scene renders here and is then
    /// resolved/blitted to the window, which lets MSAA be toggled in session without touching the pixel format.
    /// </summary>
    internal sealed class RenderTarget : IDisposable
    {
        private static int _maxSamples = -1;
        private uint _framebuffer;
        private uint _colour;
        private uint _depth;

        /// <summary>Width in pixels.</summary>
        public int Width { get; private set; }

        /// <summary>Height in pixels.</summary>
        public int Height { get; private set; }

        /// <summary>Samples actually used (0 = no MSAA).</summary>
        public int Samples { get; private set; }

        /// <summary>
        /// (Re)creates the target if the size or sample count changed.
        /// </summary>
        /// <param name="width">Width in pixels.</param>
        /// <param name="height">Height in pixels.</param>
        /// <param name="samples">Requested MSAA samples (0, 2, 4).</param>
        public void Ensure(int width, int height, int samples)
        {
            width = Math.Max(width, 1);
            height = Math.Max(height, 1);
            if (_maxSamples < 0) { _maxSamples = Math.Max(Gl.GetInteger(Gl.MAX_SAMPLES), 0); }
            samples = Math.Clamp(samples, 0, _maxSamples);

            if (_framebuffer != 0 && width == Width && height == Height && samples == Samples) { return; }

            Dispose();
            Width = width;
            Height = height;
            Samples = samples;

            _framebuffer = Gl.GenFramebuffer();
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, _framebuffer);

            _colour = Gl.GenRenderbuffer();
            Gl.BindRenderbuffer(Gl.RENDERBUFFER, _colour);
            Gl.RenderbufferStorageMultisample(Gl.RENDERBUFFER, samples, Gl.RGBA8, width, height);
            Gl.FramebufferRenderbuffer(Gl.FRAMEBUFFER, Gl.COLOR_ATTACHMENT0, Gl.RENDERBUFFER, _colour);

            _depth = Gl.GenRenderbuffer();
            Gl.BindRenderbuffer(Gl.RENDERBUFFER, _depth);
            Gl.RenderbufferStorageMultisample(Gl.RENDERBUFFER, samples, Gl.DEPTH_COMPONENT24, width, height);
            Gl.FramebufferRenderbuffer(Gl.FRAMEBUFFER, Gl.DEPTH_ATTACHMENT, Gl.RENDERBUFFER, _depth);

            uint status = Gl.CheckFramebufferStatus(Gl.FRAMEBUFFER);
            Gl.BindRenderbuffer(Gl.RENDERBUFFER, 0);
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);

            if (status != Gl.FRAMEBUFFER_COMPLETE)
            {
                Utilities.Log_Utils.Write($"Scene framebuffer incomplete (0x{status:X}) at {samples}x MSAA; falling back to no MSAA.");
                if (samples > 0)
                {
                    // Never ask for this many samples again this process (avoids recreating every frame)
                    _maxSamples = 0;
                    Ensure(width, height, 0);
                }
            }
        }

        /// <summary>
        /// Binds the target for drawing and sets the viewport.
        /// </summary>
        public void Bind()
        {
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, _framebuffer);
            Gl.Viewport(0, 0, Width, Height);
        }

        /// <summary>
        /// Resolves the colour into the window's back buffer.
        /// </summary>
        public void BlitToWindow()
        {
            Gl.BindFramebuffer(Gl.READ_FRAMEBUFFER, _framebuffer);
            Gl.BindFramebuffer(Gl.DRAW_FRAMEBUFFER, 0);
            Gl.BlitFramebuffer(0, 0, Width, Height, 0, 0, Width, Height, Gl.COLOR_BUFFER_BIT, Gl.NEAREST);
            Gl.BindFramebuffer(Gl.FRAMEBUFFER, 0);
        }

        /// <summary>
        /// Releases GL objects.
        /// </summary>
        public void Dispose()
        {
            Gl.DeleteFramebuffer(_framebuffer);
            Gl.DeleteRenderbuffer(_colour);
            Gl.DeleteRenderbuffer(_depth);
            _framebuffer = _colour = _depth = 0;
        }
    }
}
