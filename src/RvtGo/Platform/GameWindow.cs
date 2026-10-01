using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using RvtGo.Native;

// The class belongs to the Platform namespace
namespace RvtGo.Platform
{
    /// <summary>
    /// The Win32 game window with its OpenGL context. Created and pumped on the game thread.
    /// Window messages feed an <see cref="InputState"/>; mouse look uses Raw Input.
    /// </summary>
    internal sealed unsafe class GameWindow : IDisposable
    {
        #region Fields

        private const string CLASS_NAME = "RvtGoGameWindow";
        private const uint WM_APP_FOCUS = Win32.WM_APP + 1;

        private static bool _classRegistered;
        private static GameWindow _current;

        private nint _hdc;
        private nint _context;
        private bool _captured;
        private bool _fullscreen;
        private Win32.WINDOWPLACEMENT _placement;

        /// <summary>The window handle.</summary>
        public nint Handle { get; private set; }

        /// <summary>Input gathered from messages.</summary>
        public InputState Input { get; } = new();

        /// <summary>Client width in pixels.</summary>
        public int Width { get; private set; }

        /// <summary>Client height in pixels.</summary>
        public int Height { get; private set; }

        /// <summary>UI scale (DPI / 96).</summary>
        public float DpiScale { get; private set; } = 1f;

        /// <summary>True while the window is the active window.</summary>
        public bool IsActive { get; private set; } = true;

        /// <summary>Set when the client size changed (cleared by the consumer).</summary>
        public bool Resized { get; set; }

        /// <summary>Set when focus was lost (cleared by the consumer).</summary>
        public bool FocusLost { get; set; }

        /// <summary>The GL version obtained.</summary>
        public string GlVersion { get; private set; } = string.Empty;

        /// <summary>Set when the user (or Revit) asked the window to close.</summary>
        public bool CloseRequested { get; private set; }

        /// <summary>True when the mouse is captured for look.</summary>
        public bool IsCaptured => _captured;

        /// <summary>True when minimised.</summary>
        public bool IsMinimised => Win32.IsIconic(Handle);

        #endregion

        #region Creation

        /// <summary>
        /// Creates and shows the window, then creates a core-profile GL context.
        /// </summary>
        /// <param name="title">Window title.</param>
        public GameWindow(string title)
        {
            _current = this;
            nint instance = Win32.GetModuleHandleW(null);

            if (!_classRegistered)
            {
                fixed (char* className = CLASS_NAME)
                {
                    var wc = new Win32.WNDCLASSEXW
                    {
                        cbSize = (uint)sizeof(Win32.WNDCLASSEXW),
                        style = Win32.CS_OWNDC | Win32.CS_HREDRAW | Win32.CS_VREDRAW,
                        lpfnWndProc = (nint)(delegate* unmanaged<nint, uint, nint, nint, nint>)&WndProc,
                        hInstance = instance,
                        hCursor = Win32.LoadCursorW(0, Win32.IDC_ARROW),
                        lpszClassName = className
                    };
                    if (Win32.RegisterClassExW(&wc) == 0)
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error != 1410) // ERROR_CLASS_ALREADY_EXISTS
                        {
                            throw new InvalidOperationException($"RegisterClassEx failed ({error}).");
                        }
                    }
                }
                _classRegistered = true;
            }

            // 80% of the primary screen, centred
            int screenW = Win32.GetSystemMetrics(0), screenH = Win32.GetSystemMetrics(1);
            int w = Math.Max(960, (int)(screenW * 0.8f)), h = Math.Max(600, (int)(screenH * 0.8f));
            int x = Math.Max(0, (screenW - w) / 2), y = Math.Max(0, (screenH - h) / 2);

            Handle = Win32.CreateWindowExW(0, CLASS_NAME, title,
                Win32.WS_OVERLAPPEDWINDOW | Win32.WS_CLIPSIBLINGS | Win32.WS_CLIPCHILDREN,
                x, y, w, h, 0, 0, instance, 0);
            if (Handle == 0)
            {
                throw new InvalidOperationException($"CreateWindowEx failed ({Marshal.GetLastWin32Error()}).");
            }

            uint dpi = Win32.GetDpiForWindow(Handle);
            DpiScale = dpi > 0 ? dpi / 96f : 1f;

            CreateContext();
            RegisterRawMouse();

            Win32.ShowWindow(Handle, Win32.SW_SHOW);
            Win32.UpdateWindow(Handle);
            Win32.SetForegroundWindow(Handle);
            UpdateClientSize();
        }

        /// <summary>
        /// Sets the pixel format and creates the GL context.
        /// </summary>
        private void CreateContext()
        {
            _hdc = Win32.GetDC(Handle);
            var pfd = new Win32.PIXELFORMATDESCRIPTOR
            {
                nSize = (ushort)sizeof(Win32.PIXELFORMATDESCRIPTOR),
                nVersion = 1,
                dwFlags = Win32.PFD_DRAW_TO_WINDOW | Win32.PFD_SUPPORT_OPENGL | Win32.PFD_DOUBLEBUFFER,
                iPixelType = Win32.PFD_TYPE_RGBA,
                cColorBits = 32,
                cAlphaBits = 8,
                cDepthBits = 24,
                cStencilBits = 8,
                iLayerType = Win32.PFD_MAIN_PLANE
            };

            int format = Win32.ChoosePixelFormat(_hdc, pfd);
            if (format == 0 || !Win32.SetPixelFormat(_hdc, format, pfd))
            {
                throw new InvalidOperationException("No suitable OpenGL pixel format was found.");
            }

            _context = Wgl.CreateCoreContext(_hdc, out string version);
            if (_context == 0)
            {
                throw new InvalidOperationException("OpenGL 3.3+ core profile is not available. Update the graphics driver.");
            }
            GlVersion = version;
            Gl.Load();
        }

        /// <summary>
        /// Registers for raw mouse input (relative deltas for mouse look).
        /// </summary>
        private void RegisterRawMouse()
        {
            var device = new Win32.RAWINPUTDEVICE
            {
                usUsagePage = Win32.HID_USAGE_PAGE_GENERIC,
                usUsage = Win32.HID_USAGE_GENERIC_MOUSE,
                dwFlags = 0,
                hwndTarget = Handle
            };
            Win32.RegisterRawInputDevices(&device, 1, (uint)sizeof(Win32.RAWINPUTDEVICE));
        }

        #endregion

        #region Loop helpers

        /// <summary>
        /// Processes pending messages.
        /// </summary>
        /// <returns>False once the window has been closed.</returns>
        public bool PumpMessages()
        {
            while (Win32.PeekMessageW(out Win32.MSG msg, 0, 0, 0, Win32.PM_REMOVE))
            {
                if (msg.message == Win32.WM_QUIT) { return false; }
                Win32.TranslateMessage(msg);
                Win32.DispatchMessageW(msg);
            }
            return Handle != 0 && !CloseRequested;
        }

        /// <summary>
        /// Presents the back buffer.
        /// </summary>
        public void Swap() => Win32.SwapBuffers(_hdc);

        /// <summary>
        /// Captures (hides and confines) or releases the mouse.
        /// </summary>
        public void SetCaptured(bool captured)
        {
            _captured = captured;
            if (captured)
            {
                ClipToClient();
            }
            else
            {
                Win32.ClipCursor(null);
            }
            // Refresh the cursor immediately
            Win32.SetCursor(captured ? 0 : Win32.LoadCursorW(0, Win32.IDC_ARROW));
        }

        private void ClipToClient()
        {
            Win32.GetClientRect(Handle, out Win32.RECT rect);
            var topLeft = new Win32.POINT { X = rect.Left, Y = rect.Top };
            var bottomRight = new Win32.POINT { X = rect.Right, Y = rect.Bottom };
            Win32.ClientToScreen(Handle, ref topLeft);
            Win32.ClientToScreen(Handle, ref bottomRight);
            var screen = new Win32.RECT { Left = topLeft.X, Top = topLeft.Y, Right = bottomRight.X, Bottom = bottomRight.Y };
            Win32.ClipCursor(&screen);
        }

        private void UpdateClientSize()
        {
            Win32.GetClientRect(Handle, out Win32.RECT rect);
            int w = Math.Max(1, rect.Right - rect.Left), h = Math.Max(1, rect.Bottom - rect.Top);
            if (w != Width || h != Height)
            {
                Width = w;
                Height = h;
                Resized = true;
            }
            if (_captured) { ClipToClient(); }
        }

        /// <summary>
        /// Toggles borderless fullscreen on the current monitor.
        /// </summary>
        public void ToggleFullscreen()
        {
            if (!_fullscreen)
            {
                _placement.length = (uint)sizeof(Win32.WINDOWPLACEMENT);
                Win32.GetWindowPlacement(Handle, ref _placement);

                var info = new Win32.MONITORINFO { cbSize = (uint)sizeof(Win32.MONITORINFO) };
                Win32.GetMonitorInfoW(Win32.MonitorFromWindow(Handle, Win32.MONITOR_DEFAULTTONEAREST), ref info);
                Win32.SetWindowLongPtrW(Handle, Win32.GWL_STYLE, (nint)(Win32.WS_POPUP | Win32.WS_VISIBLE));
                Win32.SetWindowPos(Handle, 0, info.rcMonitor.Left, info.rcMonitor.Top,
                    info.rcMonitor.Right - info.rcMonitor.Left, info.rcMonitor.Bottom - info.rcMonitor.Top,
                    Win32.SWP_NOOWNERZORDER | Win32.SWP_FRAMECHANGED);
                _fullscreen = true;
            }
            else
            {
                Win32.SetWindowLongPtrW(Handle, Win32.GWL_STYLE, (nint)(Win32.WS_OVERLAPPEDWINDOW | Win32.WS_VISIBLE));
                Win32.SetWindowPlacement(Handle, _placement);
                Win32.SetWindowPos(Handle, 0, 0, 0, 0, 0, Win32.SWP_NOZORDER | Win32.SWP_NOOWNERZORDER | Win32.SWP_FRAMECHANGED | 0x0001 | 0x0002);
                _fullscreen = false;
            }
            UpdateClientSize();
        }

        /// <summary>
        /// Sets the window title.
        /// </summary>
        public void SetTitle(string title) => Win32.SetWindowTextW(Handle, title);

        /// <summary>
        /// Thread-safe: asks the window to come to the front (called from the Revit thread).
        /// </summary>
        public void RequestFocus()
        {
            if (Handle == 0) { return; }
            Win32.PostMessageW(Handle, WM_APP_FOCUS, 0, 0);
            Win32.SetForegroundWindow(Handle);
        }

        /// <summary>
        /// Thread-safe: asks the window to close (called from the Revit thread).
        /// </summary>
        public void RequestClose()
        {
            if (Handle != 0) { Win32.PostMessageW(Handle, Win32.WM_CLOSE, 0, 0); }
        }

        #endregion

        #region Window procedure

        [UnmanagedCallersOnly]
        private static nint WndProc(nint hwnd, uint msg, nint wParam, nint lParam)
        {
            try
            {
                GameWindow window = _current;
                if (window != null && (window.Handle == hwnd || window.Handle == 0))
                {
                    if (window.HandleMessage(hwnd, msg, wParam, lParam, out nint result)) { return result; }
                }
            }
            catch (Exception ex)
            {
                // Never let an exception cross the native boundary
                Utilities.Log_Utils.Write($"WndProc error: {ex}");
            }
            return Win32.DefWindowProcW(hwnd, msg, wParam, lParam);
        }

        /// <summary>
        /// Handles one message.
        /// </summary>
        /// <returns>True if handled (result is returned to Windows).</returns>
        private bool HandleMessage(nint hwnd, uint msg, nint wParam, nint lParam, out nint result)
        {
            result = 0;
            switch (msg)
            {
                case Win32.WM_CLOSE:
                    // The session loop sees this, releases GL resources, then disposes the window
                    SetCaptured(false);
                    CloseRequested = true;
                    return true;

                case Win32.WM_DESTROY:
                    Handle = 0;
                    Win32.PostQuitMessage(0);
                    return true;

                case Win32.WM_ERASEBKGND:
                    result = 1;
                    return true;

                case Win32.WM_SIZE:
                case Win32.WM_MOVE:
                    if (Handle != 0) { UpdateClientSize(); }
                    return false;

                case Win32.WM_DPICHANGED:
                    DpiScale = Win32.HiWordSigned(wParam) / 96f;
                    return false;

                case Win32.WM_ACTIVATE:
                    IsActive = (Win32.LoWordSigned(wParam) & 0xFFFF) != Win32.WA_INACTIVE;
                    if (!IsActive)
                    {
                        FocusLost = true;
                        Input.ReleaseAll();
                        if (_captured) { SetCaptured(false); FocusLost = true; }
                    }
                    return false;

                case Win32.WM_KILLFOCUS:
                    Input.ReleaseAll();
                    FocusLost = true;
                    return false;

                case Win32.WM_SETCURSOR:
                    if (_captured && Win32.LoWordSigned(lParam) == Win32.HTCLIENT)
                    {
                        Win32.SetCursor(0);
                        result = 1;
                        return true;
                    }
                    return false;

                case Win32.WM_SYSCOMMAND:
                    // Swallow Alt/F10 menu activation, which would otherwise freeze the loop
                    if (((long)wParam & 0xFFF0) == Win32.SC_KEYMENU) { return true; }
                    return false;

                case Win32.WM_KEYDOWN:
                case Win32.WM_SYSKEYDOWN:
                    Input.OnKey((int)wParam, true, ((long)lParam & (1L << 30)) != 0);
                    return msg == Win32.WM_KEYDOWN;

                case Win32.WM_KEYUP:
                case Win32.WM_SYSKEYUP:
                    Input.OnKey((int)wParam, false, true);
                    return msg == Win32.WM_KEYUP;

                case Win32.WM_CHAR:
                    Input.OnChar((char)wParam);
                    return true;

                case Win32.WM_MOUSEMOVE:
                    Input.OnMouseMove(Win32.LoWordSigned(lParam), Win32.HiWordSigned(lParam));
                    return true;

                case Win32.WM_LBUTTONDOWN:
                    Win32.SetCapture(hwnd);
                    Input.OnLeft(true);
                    return true;

                case Win32.WM_LBUTTONUP:
                    Win32.ReleaseCapture();
                    Input.OnLeft(false);
                    return true;

                case Win32.WM_RBUTTONDOWN:
                    Input.OnRight(true);
                    return true;

                case Win32.WM_RBUTTONUP:
                    Input.OnRight(false);
                    return true;

                case Win32.WM_MOUSEWHEEL:
                    Input.OnWheel(Win32.HiWordSigned(wParam));
                    return true;

                case Win32.WM_INPUT:
                    ReadRawInput(lParam);
                    return false; // DefWindowProc must run for WM_INPUT cleanup

                case WM_APP_FOCUS:
                    Win32.ShowWindow(hwnd, Win32.SW_RESTORE);
                    Win32.SetForegroundWindow(hwnd);
                    return true;
            }
            return false;
        }

        /// <summary>
        /// Reads a raw mouse packet.
        /// </summary>
        private void ReadRawInput(nint rawHandle)
        {
            Win32.RAWINPUTMOUSE raw;
            uint size = (uint)sizeof(Win32.RAWINPUTMOUSE);
            uint read = Win32.GetRawInputData(rawHandle, Win32.RID_INPUT, &raw, &size, (uint)sizeof(Win32.RAWINPUTHEADER));
            if (read == uint.MaxValue || read == 0) { return; }
            if (raw.header.dwType != Win32.RIM_TYPEMOUSE) { return; }
            if ((raw.mouse.usFlags & Win32.MOUSE_MOVE_ABSOLUTE) != 0) { return; }
            Input.OnRawMouse(raw.mouse.lLastX, raw.mouse.lLastY);
        }

        #endregion

        /// <summary>
        /// Releases the context and destroys the window if still open.
        /// </summary>
        public void Dispose()
        {
            Win32.ClipCursor(null);
            if (_context != 0)
            {
                Wgl.wglMakeCurrent(0, 0);
                Wgl.wglDeleteContext(_context);
                _context = 0;
            }
            if (Handle != 0)
            {
                nint handle = Handle;
                if (_hdc != 0) { Win32.ReleaseDC(handle, _hdc); }
                Win32.DestroyWindow(handle);
                Handle = 0;
                // Drain the WM_DESTROY / WM_QUIT this produces
                while (Win32.PeekMessageW(out Win32.MSG _, 0, 0, 0, Win32.PM_REMOVE)) { }
            }
            _hdc = 0;
            if (ReferenceEquals(_current, this)) { _current = null; }
        }
    }
}
