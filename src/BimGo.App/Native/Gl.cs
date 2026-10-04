using System.Runtime.InteropServices;

// The class belongs to the Native namespace
namespace BimGo.Native
{
    /// <summary>
    /// Hand-written OpenGL bindings using unmanaged function pointers.
    /// GL 1.1 entry points come from opengl32.dll exports; everything newer via wglGetProcAddress.
    /// <see cref="Load"/> must be called on the game thread with a current context.
    /// </summary>
    internal static unsafe class Gl
    {
        #region Constants

        public const uint DEPTH_BUFFER_BIT = 0x00000100, COLOR_BUFFER_BIT = 0x00004000;
        public const uint TRIANGLES = 0x0004;
        public const uint NEVER = 0x0200, LESS = 0x0201, LEQUAL = 0x0203, ALWAYS = 0x0207;
        public const uint SRC_ALPHA = 0x0302, ONE_MINUS_SRC_ALPHA = 0x0303, ONE = 1, ZERO = 0;
        public const uint FRONT = 0x0404, BACK = 0x0405, CCW = 0x0901;
        public const uint CULL_FACE = 0x0B44, DEPTH_TEST = 0x0B71, BLEND = 0x0BE2, SCISSOR_TEST = 0x0C11;
        public const uint POLYGON_OFFSET_FILL = 0x8037, MULTISAMPLE = 0x809D, FRAMEBUFFER_SRGB = 0x8DB9;
        public const uint UNPACK_ALIGNMENT = 0x0CF5, MAX_SAMPLES = 0x8D57;
        public const uint TEXTURE_2D = 0x0DE1;
        public const uint UNSIGNED_BYTE = 0x1401, UNSIGNED_INT = 0x1405, FLOAT = 0x1406;
        public const uint RGBA = 0x1908, RGBA8 = 0x8058, BGRA = 0x80E1;
        public const uint VENDOR = 0x1F00, RENDERER = 0x1F01, VERSION = 0x1F02;
        public const uint NEAREST = 0x2600, LINEAR = 0x2601;
        public const uint TEXTURE_MAG_FILTER = 0x2800, TEXTURE_MIN_FILTER = 0x2801, TEXTURE_WRAP_S = 0x2802, TEXTURE_WRAP_T = 0x2803;
        public const uint CLAMP_TO_EDGE = 0x812F;
        public const uint TEXTURE0 = 0x84C0;
        public const uint ARRAY_BUFFER = 0x8892, ELEMENT_ARRAY_BUFFER = 0x8893;
        public const uint STREAM_DRAW = 0x88E0, STATIC_DRAW = 0x88E4, DYNAMIC_DRAW = 0x88E8;
        public const uint FRAGMENT_SHADER = 0x8B30, VERTEX_SHADER = 0x8B31;
        public const uint COMPILE_STATUS = 0x8B81, LINK_STATUS = 0x8B82, INFO_LOG_LENGTH = 0x8B84;
        public const uint FRAMEBUFFER = 0x8D40, READ_FRAMEBUFFER = 0x8CA8, DRAW_FRAMEBUFFER = 0x8CA9, RENDERBUFFER = 0x8D41;
        public const uint COLOR_ATTACHMENT0 = 0x8CE0, DEPTH_ATTACHMENT = 0x8D00, DEPTH_COMPONENT24 = 0x81A6;
        public const uint FRAMEBUFFER_COMPLETE = 0x8CD5;
        public const uint NO_ERROR = 0;

        #endregion

        #region Function pointers

        // GL 1.1
        private static delegate* unmanaged<uint, void> _clear;
        private static delegate* unmanaged<float, float, float, float, void> _clearColor;
        private static delegate* unmanaged<double, void> _clearDepth;
        private static delegate* unmanaged<int, int, int, int, void> _viewport;
        private static delegate* unmanaged<int, int, int, int, void> _scissor;
        private static delegate* unmanaged<uint, void> _enable;
        private static delegate* unmanaged<uint, void> _disable;
        private static delegate* unmanaged<uint, void> _depthFunc;
        private static delegate* unmanaged<byte, void> _depthMask;
        private static delegate* unmanaged<uint, uint, void> _blendFunc;
        private static delegate* unmanaged<uint, void> _cullFace;
        private static delegate* unmanaged<float, float, void> _polygonOffset;
        private static delegate* unmanaged<uint, byte*> _getString;
        private static delegate* unmanaged<uint, int*, void> _getIntegerv;
        private static delegate* unmanaged<uint> _getError;
        private static delegate* unmanaged<uint, uint, void> _bindTexture;
        private static delegate* unmanaged<int, uint*, void> _genTextures;
        private static delegate* unmanaged<int, uint*, void> _deleteTextures;
        private static delegate* unmanaged<uint, int, int, int, int, int, uint, uint, void*, void> _texImage2D;
        private static delegate* unmanaged<uint, uint, int, void> _texParameteri;
        private static delegate* unmanaged<uint, int, void> _pixelStorei;
        private static delegate* unmanaged<uint, int, uint, void*, void> _drawElements;
        private static delegate* unmanaged<uint, int, int, void> _drawArrays;

        // GL 1.3+
        private static delegate* unmanaged<uint, void> _activeTexture;
        private static delegate* unmanaged<uint, int*, uint, void**, int, void> _multiDrawElements;
        private static delegate* unmanaged<uint, uint, uint, uint, void> _blendFuncSeparate;

        // Buffers
        private static delegate* unmanaged<int, uint*, void> _genBuffers;
        private static delegate* unmanaged<int, uint*, void> _deleteBuffers;
        private static delegate* unmanaged<uint, uint, void> _bindBuffer;
        private static delegate* unmanaged<uint, nint, void*, uint, void> _bufferData;
        private static delegate* unmanaged<uint, nint, nint, void*, void> _bufferSubData;

        // Vertex arrays
        private static delegate* unmanaged<int, uint*, void> _genVertexArrays;
        private static delegate* unmanaged<int, uint*, void> _deleteVertexArrays;
        private static delegate* unmanaged<uint, void> _bindVertexArray;
        private static delegate* unmanaged<uint, void> _enableVertexAttribArray;
        private static delegate* unmanaged<uint, int, uint, byte, int, void*, void> _vertexAttribPointer;
        private static delegate* unmanaged<uint, uint, void> _vertexAttribDivisor;
        private static delegate* unmanaged<uint, int, uint, void*, int, void> _drawElementsInstanced;

        // Shaders
        private static delegate* unmanaged<uint, uint> _createShader;
        private static delegate* unmanaged<uint, int, byte**, int*, void> _shaderSource;
        private static delegate* unmanaged<uint, void> _compileShader;
        private static delegate* unmanaged<uint, uint, int*, void> _getShaderiv;
        private static delegate* unmanaged<uint, int, int*, byte*, void> _getShaderInfoLog;
        private static delegate* unmanaged<uint, void> _deleteShader;
        private static delegate* unmanaged<uint> _createProgram;
        private static delegate* unmanaged<uint, uint, void> _attachShader;
        private static delegate* unmanaged<uint, void> _linkProgram;
        private static delegate* unmanaged<uint, uint, int*, void> _getProgramiv;
        private static delegate* unmanaged<uint, int, int*, byte*, void> _getProgramInfoLog;
        private static delegate* unmanaged<uint, void> _deleteProgram;
        private static delegate* unmanaged<uint, void> _useProgram;
        private static delegate* unmanaged<uint, byte*, int> _getUniformLocation;
        private static delegate* unmanaged<int, int, void> _uniform1i;
        private static delegate* unmanaged<int, float, void> _uniform1f;
        private static delegate* unmanaged<int, float, float, void> _uniform2f;
        private static delegate* unmanaged<int, float, float, float, void> _uniform3f;
        private static delegate* unmanaged<int, float, float, float, float, void> _uniform4f;
        private static delegate* unmanaged<int, int, byte, float*, void> _uniformMatrix4fv;

        // Framebuffers
        private static delegate* unmanaged<int, uint*, void> _genFramebuffers;
        private static delegate* unmanaged<int, uint*, void> _deleteFramebuffers;
        private static delegate* unmanaged<uint, uint, void> _bindFramebuffer;
        private static delegate* unmanaged<uint, uint, uint, uint, void> _framebufferRenderbuffer;
        private static delegate* unmanaged<uint, uint> _checkFramebufferStatus;
        private static delegate* unmanaged<int, uint*, void> _genRenderbuffers;
        private static delegate* unmanaged<int, uint*, void> _deleteRenderbuffers;
        private static delegate* unmanaged<uint, uint, void> _bindRenderbuffer;
        private static delegate* unmanaged<uint, int, uint, int, int, void> _renderbufferStorageMultisample;
        private static delegate* unmanaged<int, int, int, int, int, int, int, int, uint, uint, void> _blitFramebuffer;

        #endregion

        #region Loading

        [DllImport("opengl32.dll", CharSet = CharSet.Ansi, BestFitMapping = false)]
        private static extern nint wglGetProcAddress(string name);

        private static nint _opengl32;

        /// <summary>
        /// Resolves one entry point.
        /// </summary>
        /// <param name="name">The GL function name.</param>
        /// <param name="required">Throw if missing.</param>
        /// <returns>The function address (0 if missing and optional).</returns>
        public static nint GetProc(string name, bool required = true)
        {
            long address = wglGetProcAddress(name);

            // wglGetProcAddress returns 0..3 or -1 for failures (and for GL 1.1 functions)
            if (address >= -1 && address <= 3)
            {
                if (_opengl32 == 0) { _opengl32 = NativeLibrary.Load("opengl32.dll"); }
                address = NativeLibrary.TryGetExport(_opengl32, name, out nint export) ? export : 0;
            }

            if (address == 0 && required)
            {
                throw new InvalidOperationException($"OpenGL function '{name}' is not available. Update the graphics driver.");
            }
            return (nint)address;
        }

        /// <summary>
        /// Loads every entry point used by BimGo.
        /// </summary>
        public static void Load()
        {
            _clear = (delegate* unmanaged<uint, void>)GetProc("glClear");
            _clearColor = (delegate* unmanaged<float, float, float, float, void>)GetProc("glClearColor");
            _clearDepth = (delegate* unmanaged<double, void>)GetProc("glClearDepth");
            _viewport = (delegate* unmanaged<int, int, int, int, void>)GetProc("glViewport");
            _scissor = (delegate* unmanaged<int, int, int, int, void>)GetProc("glScissor");
            _enable = (delegate* unmanaged<uint, void>)GetProc("glEnable");
            _disable = (delegate* unmanaged<uint, void>)GetProc("glDisable");
            _depthFunc = (delegate* unmanaged<uint, void>)GetProc("glDepthFunc");
            _depthMask = (delegate* unmanaged<byte, void>)GetProc("glDepthMask");
            _blendFunc = (delegate* unmanaged<uint, uint, void>)GetProc("glBlendFunc");
            _cullFace = (delegate* unmanaged<uint, void>)GetProc("glCullFace");
            _polygonOffset = (delegate* unmanaged<float, float, void>)GetProc("glPolygonOffset");
            _getString = (delegate* unmanaged<uint, byte*>)GetProc("glGetString");
            _getIntegerv = (delegate* unmanaged<uint, int*, void>)GetProc("glGetIntegerv");
            _getError = (delegate* unmanaged<uint>)GetProc("glGetError");
            _bindTexture = (delegate* unmanaged<uint, uint, void>)GetProc("glBindTexture");
            _genTextures = (delegate* unmanaged<int, uint*, void>)GetProc("glGenTextures");
            _deleteTextures = (delegate* unmanaged<int, uint*, void>)GetProc("glDeleteTextures");
            _texImage2D = (delegate* unmanaged<uint, int, int, int, int, int, uint, uint, void*, void>)GetProc("glTexImage2D");
            _texParameteri = (delegate* unmanaged<uint, uint, int, void>)GetProc("glTexParameteri");
            _pixelStorei = (delegate* unmanaged<uint, int, void>)GetProc("glPixelStorei");
            _drawElements = (delegate* unmanaged<uint, int, uint, void*, void>)GetProc("glDrawElements");
            _drawArrays = (delegate* unmanaged<uint, int, int, void>)GetProc("glDrawArrays");

            _activeTexture = (delegate* unmanaged<uint, void>)GetProc("glActiveTexture");
            _multiDrawElements = (delegate* unmanaged<uint, int*, uint, void**, int, void>)GetProc("glMultiDrawElements");
            _blendFuncSeparate = (delegate* unmanaged<uint, uint, uint, uint, void>)GetProc("glBlendFuncSeparate");

            _genBuffers = (delegate* unmanaged<int, uint*, void>)GetProc("glGenBuffers");
            _deleteBuffers = (delegate* unmanaged<int, uint*, void>)GetProc("glDeleteBuffers");
            _bindBuffer = (delegate* unmanaged<uint, uint, void>)GetProc("glBindBuffer");
            _bufferData = (delegate* unmanaged<uint, nint, void*, uint, void>)GetProc("glBufferData");
            _bufferSubData = (delegate* unmanaged<uint, nint, nint, void*, void>)GetProc("glBufferSubData");

            _genVertexArrays = (delegate* unmanaged<int, uint*, void>)GetProc("glGenVertexArrays");
            _deleteVertexArrays = (delegate* unmanaged<int, uint*, void>)GetProc("glDeleteVertexArrays");
            _bindVertexArray = (delegate* unmanaged<uint, void>)GetProc("glBindVertexArray");
            _enableVertexAttribArray = (delegate* unmanaged<uint, void>)GetProc("glEnableVertexAttribArray");
            _vertexAttribPointer = (delegate* unmanaged<uint, int, uint, byte, int, void*, void>)GetProc("glVertexAttribPointer");
            _vertexAttribDivisor = (delegate* unmanaged<uint, uint, void>)GetProc("glVertexAttribDivisor");
            _drawElementsInstanced = (delegate* unmanaged<uint, int, uint, void*, int, void>)GetProc("glDrawElementsInstanced");

            _createShader = (delegate* unmanaged<uint, uint>)GetProc("glCreateShader");
            _shaderSource = (delegate* unmanaged<uint, int, byte**, int*, void>)GetProc("glShaderSource");
            _compileShader = (delegate* unmanaged<uint, void>)GetProc("glCompileShader");
            _getShaderiv = (delegate* unmanaged<uint, uint, int*, void>)GetProc("glGetShaderiv");
            _getShaderInfoLog = (delegate* unmanaged<uint, int, int*, byte*, void>)GetProc("glGetShaderInfoLog");
            _deleteShader = (delegate* unmanaged<uint, void>)GetProc("glDeleteShader");
            _createProgram = (delegate* unmanaged<uint>)GetProc("glCreateProgram");
            _attachShader = (delegate* unmanaged<uint, uint, void>)GetProc("glAttachShader");
            _linkProgram = (delegate* unmanaged<uint, void>)GetProc("glLinkProgram");
            _getProgramiv = (delegate* unmanaged<uint, uint, int*, void>)GetProc("glGetProgramiv");
            _getProgramInfoLog = (delegate* unmanaged<uint, int, int*, byte*, void>)GetProc("glGetProgramInfoLog");
            _deleteProgram = (delegate* unmanaged<uint, void>)GetProc("glDeleteProgram");
            _useProgram = (delegate* unmanaged<uint, void>)GetProc("glUseProgram");
            _getUniformLocation = (delegate* unmanaged<uint, byte*, int>)GetProc("glGetUniformLocation");
            _uniform1i = (delegate* unmanaged<int, int, void>)GetProc("glUniform1i");
            _uniform1f = (delegate* unmanaged<int, float, void>)GetProc("glUniform1f");
            _uniform2f = (delegate* unmanaged<int, float, float, void>)GetProc("glUniform2f");
            _uniform3f = (delegate* unmanaged<int, float, float, float, void>)GetProc("glUniform3f");
            _uniform4f = (delegate* unmanaged<int, float, float, float, float, void>)GetProc("glUniform4f");
            _uniformMatrix4fv = (delegate* unmanaged<int, int, byte, float*, void>)GetProc("glUniformMatrix4fv");

            _genFramebuffers = (delegate* unmanaged<int, uint*, void>)GetProc("glGenFramebuffers");
            _deleteFramebuffers = (delegate* unmanaged<int, uint*, void>)GetProc("glDeleteFramebuffers");
            _bindFramebuffer = (delegate* unmanaged<uint, uint, void>)GetProc("glBindFramebuffer");
            _framebufferRenderbuffer = (delegate* unmanaged<uint, uint, uint, uint, void>)GetProc("glFramebufferRenderbuffer");
            _checkFramebufferStatus = (delegate* unmanaged<uint, uint>)GetProc("glCheckFramebufferStatus");
            _genRenderbuffers = (delegate* unmanaged<int, uint*, void>)GetProc("glGenRenderbuffers");
            _deleteRenderbuffers = (delegate* unmanaged<int, uint*, void>)GetProc("glDeleteRenderbuffers");
            _bindRenderbuffer = (delegate* unmanaged<uint, uint, void>)GetProc("glBindRenderbuffer");
            _renderbufferStorageMultisample = (delegate* unmanaged<uint, int, uint, int, int, void>)GetProc("glRenderbufferStorageMultisample");
            _blitFramebuffer = (delegate* unmanaged<int, int, int, int, int, int, int, int, uint, uint, void>)GetProc("glBlitFramebuffer");
        }

        #endregion

        #region Wrappers: state

        public static void Clear(uint mask) => _clear(mask);
        public static void ClearColor(float r, float g, float b, float a) => _clearColor(r, g, b, a);
        public static void ClearDepth(double depth) => _clearDepth(depth);
        public static void Viewport(int x, int y, int w, int h) => _viewport(x, y, w, h);
        public static void Scissor(int x, int y, int w, int h) => _scissor(x, y, w, h);
        public static void Enable(uint cap) => _enable(cap);
        public static void Disable(uint cap) => _disable(cap);
        public static void DepthFunc(uint func) => _depthFunc(func);
        public static void DepthMask(bool write) => _depthMask(write ? (byte)1 : (byte)0);
        public static void BlendFunc(uint src, uint dst) => _blendFunc(src, dst);
        public static void BlendFuncSeparate(uint srcRgb, uint dstRgb, uint srcA, uint dstA) => _blendFuncSeparate(srcRgb, dstRgb, srcA, dstA);
        public static void CullFace(uint mode) => _cullFace(mode);
        public static void PolygonOffset(float factor, float units) => _polygonOffset(factor, units);
        public static uint GetError() => _getError();
        public static void PixelStore(uint name, int value) => _pixelStorei(name, value);

        public static int GetInteger(uint name)
        {
            int value = 0;
            _getIntegerv(name, &value);
            return value;
        }

        public static string GetString(uint name)
        {
            byte* text = _getString(name);
            return text == null ? string.Empty : Marshal.PtrToStringAnsi((nint)text) ?? string.Empty;
        }

        #endregion

        #region Wrappers: textures

        public static uint GenTexture()
        {
            uint id = 0;
            _genTextures(1, &id);
            return id;
        }

        public static void DeleteTexture(uint id)
        {
            if (id != 0) { _deleteTextures(1, &id); }
        }

        public static void ActiveTexture(uint unit) => _activeTexture(unit);
        public static void BindTexture(uint target, uint id) => _bindTexture(target, id);
        public static void TexParameter(uint target, uint name, int value) => _texParameteri(target, name, value);

        public static void TexImage2D(uint target, int level, uint internalFormat, int width, int height, uint format, uint type, void* pixels)
            => _texImage2D(target, level, (int)internalFormat, width, height, 0, format, type, pixels);

        #endregion

        #region Wrappers: buffers and arrays

        public static uint GenBuffer()
        {
            uint id = 0;
            _genBuffers(1, &id);
            return id;
        }

        public static void DeleteBuffer(uint id)
        {
            if (id != 0) { _deleteBuffers(1, &id); }
        }

        public static void BindBuffer(uint target, uint id) => _bindBuffer(target, id);
        public static void BufferData(uint target, nint size, void* data, uint usage) => _bufferData(target, size, data, usage);
        public static void BufferSubData(uint target, nint offset, nint size, void* data) => _bufferSubData(target, offset, size, data);

        public static uint GenVertexArray()
        {
            uint id = 0;
            _genVertexArrays(1, &id);
            return id;
        }

        public static void DeleteVertexArray(uint id)
        {
            if (id != 0) { _deleteVertexArrays(1, &id); }
        }

        public static void BindVertexArray(uint id) => _bindVertexArray(id);
        public static void EnableVertexAttribArray(uint index) => _enableVertexAttribArray(index);

        public static void VertexAttribPointer(uint index, int size, uint type, bool normalized, int stride, nint offset)
            => _vertexAttribPointer(index, size, type, normalized ? (byte)1 : (byte)0, stride, (void*)offset);

        public static void VertexAttribDivisor(uint index, uint divisor) => _vertexAttribDivisor(index, divisor);

        public static void DrawElements(uint mode, int count, uint type, nint byteOffset) => _drawElements(mode, count, type, (void*)byteOffset);
        public static void DrawArrays(uint mode, int first, int count) => _drawArrays(mode, first, count);

        public static void MultiDrawElements(uint mode, int* counts, uint type, void** offsets, int drawCount)
            => _multiDrawElements(mode, counts, type, offsets, drawCount);

        public static void DrawElementsInstanced(uint mode, int count, uint type, nint byteOffset, int instances)
            => _drawElementsInstanced(mode, count, type, (void*)byteOffset, instances);

        #endregion

        #region Wrappers: shaders

        public static uint CreateShader(uint type) => _createShader(type);

        public static void ShaderSource(uint shader, string source)
        {
            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(source);
            fixed (byte* p = bytes)
            {
                byte* pp = p;
                int length = bytes.Length;
                _shaderSource(shader, 1, &pp, &length);
            }
        }

        public static void CompileShader(uint shader) => _compileShader(shader);

        public static int GetShader(uint shader, uint name)
        {
            int value = 0;
            _getShaderiv(shader, name, &value);
            return value;
        }

        public static string GetShaderInfoLog(uint shader)
        {
            int length = GetShader(shader, INFO_LOG_LENGTH);
            if (length <= 1) { return string.Empty; }
            byte[] buffer = new byte[length];
            fixed (byte* p = buffer) { _getShaderInfoLog(shader, length, null, p); }
            return System.Text.Encoding.UTF8.GetString(buffer).TrimEnd('\0');
        }

        public static void DeleteShader(uint shader) => _deleteShader(shader);
        public static uint CreateProgram() => _createProgram();
        public static void AttachShader(uint program, uint shader) => _attachShader(program, shader);
        public static void LinkProgram(uint program) => _linkProgram(program);

        public static int GetProgram(uint program, uint name)
        {
            int value = 0;
            _getProgramiv(program, name, &value);
            return value;
        }

        public static string GetProgramInfoLog(uint program)
        {
            int length = GetProgram(program, INFO_LOG_LENGTH);
            if (length <= 1) { return string.Empty; }
            byte[] buffer = new byte[length];
            fixed (byte* p = buffer) { _getProgramInfoLog(program, length, null, p); }
            return System.Text.Encoding.UTF8.GetString(buffer).TrimEnd('\0');
        }

        public static void DeleteProgram(uint program)
        {
            if (program != 0) { _deleteProgram(program); }
        }

        public static void UseProgram(uint program) => _useProgram(program);

        public static int GetUniformLocation(uint program, string name)
        {
            byte[] bytes = System.Text.Encoding.ASCII.GetBytes(name + "\0");
            fixed (byte* p = bytes) { return _getUniformLocation(program, p); }
        }

        public static void Uniform1(int location, int value) => _uniform1i(location, value);
        public static void Uniform1(int location, float value) => _uniform1f(location, value);
        public static void Uniform2(int location, float x, float y) => _uniform2f(location, x, y);
        public static void Uniform3(int location, float x, float y, float z) => _uniform3f(location, x, y, z);
        public static void Uniform4(int location, float x, float y, float z, float w) => _uniform4f(location, x, y, z, w);

        /// <summary>
        /// Uploads a System.Numerics matrix as-is (row-vector convention reads as the GL column-vector transpose).
        /// </summary>
        public static void UniformMatrix4(int location, in System.Numerics.Matrix4x4 matrix)
        {
            System.Numerics.Matrix4x4 copy = matrix;
            _uniformMatrix4fv(location, 1, 0, (float*)&copy);
        }

        #endregion

        #region Wrappers: framebuffers

        public static uint GenFramebuffer()
        {
            uint id = 0;
            _genFramebuffers(1, &id);
            return id;
        }

        public static void DeleteFramebuffer(uint id)
        {
            if (id != 0) { _deleteFramebuffers(1, &id); }
        }

        public static void BindFramebuffer(uint target, uint id) => _bindFramebuffer(target, id);
        public static void FramebufferRenderbuffer(uint target, uint attachment, uint rbTarget, uint renderbuffer) => _framebufferRenderbuffer(target, attachment, rbTarget, renderbuffer);
        public static uint CheckFramebufferStatus(uint target) => _checkFramebufferStatus(target);

        public static uint GenRenderbuffer()
        {
            uint id = 0;
            _genRenderbuffers(1, &id);
            return id;
        }

        public static void DeleteRenderbuffer(uint id)
        {
            if (id != 0) { _deleteRenderbuffers(1, &id); }
        }

        public static void BindRenderbuffer(uint target, uint id) => _bindRenderbuffer(target, id);
        public static void RenderbufferStorageMultisample(uint target, int samples, uint format, int width, int height) => _renderbufferStorageMultisample(target, samples, format, width, height);

        public static void BlitFramebuffer(int sx0, int sy0, int sx1, int sy1, int dx0, int dy0, int dx1, int dy1, uint mask, uint filter)
            => _blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter);

        #endregion
    }
}
