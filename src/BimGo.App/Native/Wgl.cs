using System.Runtime.InteropServices;

// The class belongs to the Native namespace
namespace BimGo.Native
{
    /// <summary>
    /// WGL interop: legacy context creation, then a core-profile context via WGL_ARB_create_context.
    /// </summary>
    internal static unsafe class Wgl
    {
        public const int CONTEXT_MAJOR_VERSION_ARB = 0x2091;
        public const int CONTEXT_MINOR_VERSION_ARB = 0x2092;
        public const int CONTEXT_FLAGS_ARB = 0x2094;
        public const int CONTEXT_PROFILE_MASK_ARB = 0x9126;
        public const int CONTEXT_CORE_PROFILE_BIT_ARB = 0x0001;

        [DllImport("opengl32.dll", SetLastError = true)]
        public static extern nint wglCreateContext(nint hdc);

        [DllImport("opengl32.dll", SetLastError = true)]
        public static extern bool wglMakeCurrent(nint hdc, nint hglrc);

        [DllImport("opengl32.dll")]
        public static extern bool wglDeleteContext(nint hglrc);

        private static delegate* unmanaged<nint, nint, int*, nint> _createContextAttribs;
        private static delegate* unmanaged<int, int> _swapInterval;

        /// <summary>
        /// Creates a core-profile context on a DC whose pixel format is already set.
        /// Tries 4.1 then 3.3. Leaves the new context current.
        /// </summary>
        /// <param name="hdc">The device context.</param>
        /// <param name="version">The version obtained, e.g. "4.1".</param>
        /// <returns>The context handle, or 0 on failure.</returns>
        public static nint CreateCoreContext(nint hdc, out string version)
        {
            version = string.Empty;

            // A legacy context is needed to look up the ARB entry points
            nint legacy = wglCreateContext(hdc);
            if (legacy == 0 || !wglMakeCurrent(hdc, legacy))
            {
                return 0;
            }

            _createContextAttribs = (delegate* unmanaged<nint, nint, int*, nint>)Gl.GetProc("wglCreateContextAttribsARB", required: false);
            if (_createContextAttribs == null)
            {
                wglMakeCurrent(0, 0);
                wglDeleteContext(legacy);
                return 0;
            }

            nint context = 0;
            int[] majors = { 4, 3 };
            int[] minors = { 1, 3 };
            int* attributes = stackalloc int[7];
            for (int i = 0; i < majors.Length && context == 0; i++)
            {
                attributes[0] = CONTEXT_MAJOR_VERSION_ARB; attributes[1] = majors[i];
                attributes[2] = CONTEXT_MINOR_VERSION_ARB; attributes[3] = minors[i];
                attributes[4] = CONTEXT_PROFILE_MASK_ARB; attributes[5] = CONTEXT_CORE_PROFILE_BIT_ARB;
                attributes[6] = 0;
                context = _createContextAttribs(hdc, 0, attributes);
                if (context != 0) { version = $"{majors[i]}.{minors[i]}"; }
            }

            wglMakeCurrent(0, 0);
            wglDeleteContext(legacy);

            if (context == 0 || !wglMakeCurrent(hdc, context))
            {
                return 0;
            }

            _swapInterval = (delegate* unmanaged<int, int>)Gl.GetProc("wglSwapIntervalEXT", required: false);
            return context;
        }

        /// <summary>
        /// Sets VSync (no-op if the extension is missing).
        /// </summary>
        public static void SetSwapInterval(bool vsync)
        {
            if (_swapInterval != null) { _swapInterval(vsync ? 1 : 0); }
        }
    }
}
