using System.Runtime.InteropServices;

// The class belongs to the Native namespace
namespace BimGo.Native
{
    /// <summary>
    /// H.264 / MP4 writing through Windows Media Foundation's sink writer (tour round, build A2: walkthrough video).
    /// Media Foundation is part of Windows (the H.264 encoder is licensed by Microsoft for in-box use): no package, no
    /// bundled codec. Hand-written interop: four exported functions and the few COM methods needed, called through
    /// their vtable slots (slot numbers checked against the Windows SDK's mfobjects.idl / mfreadwrite.idl).
    /// <para>Frames go in as top-down BGRA (MFVideoFormat_RGB32); the sink writer converts to NV12 for the encoder.
    /// Not thread-safe: create, write and finish on one thread (the recorder's worker).</para>
    /// </summary>
    internal sealed unsafe class Mp4Writer : IDisposable
    {
        #region Media Foundation constants

        private const uint MF_VERSION = 0x00020070;          // MF_SDK_VERSION 2 << 16 | MF_API_VERSION 0x70
        private const uint MFSTARTUP_FULL = 0;
        private const uint MFVideoInterlace_Progressive = 2;
        private const uint eAVEncH264VProfile_High = 100;

        private static readonly Guid MF_MT_MAJOR_TYPE = new(0x48eba18e, 0xf8c9, 0x4687, 0xbf, 0x11, 0x0a, 0x74, 0xc9, 0xf9, 0x6a, 0x8f);
        private static readonly Guid MF_MT_SUBTYPE = new(0xf7e34c9a, 0x42e8, 0x4714, 0xb7, 0x4b, 0xcb, 0x29, 0xd7, 0x2c, 0x35, 0xe5);
        private static readonly Guid MF_MT_AVG_BITRATE = new(0x20332624, 0xfb0d, 0x4d9e, 0xbd, 0x0d, 0xcb, 0xf6, 0x78, 0x6c, 0x10, 0x2e);
        private static readonly Guid MF_MT_INTERLACE_MODE = new(0xe2724bb8, 0xe676, 0x4806, 0xb4, 0xb2, 0xa8, 0xd6, 0xef, 0xb4, 0x4c, 0xcd);
        private static readonly Guid MF_MT_FRAME_SIZE = new(0x1652c33d, 0xd6b2, 0x4012, 0xb8, 0x34, 0x72, 0x03, 0x08, 0x49, 0xa3, 0x7d);
        private static readonly Guid MF_MT_FRAME_RATE = new(0xc459a2e8, 0x3d2c, 0x4e44, 0xb1, 0x32, 0xfe, 0xe5, 0x15, 0x6c, 0x7b, 0xb0);
        private static readonly Guid MF_MT_PIXEL_ASPECT_RATIO = new(0xc6376a1e, 0x8d0a, 0x4027, 0xbe, 0x45, 0x6d, 0x9a, 0x0a, 0xd3, 0x9b, 0xb6);
        private static readonly Guid MF_MT_DEFAULT_STRIDE = new(0x644b4e48, 0x1e02, 0x4516, 0xb0, 0xeb, 0xc0, 0x1c, 0xa9, 0xd4, 0x9a, 0xc6);
        private static readonly Guid MF_MT_MPEG2_PROFILE = new(0xad76a80b, 0x2d5c, 0x4e0b, 0xb3, 0x75, 0x64, 0xe5, 0x20, 0x13, 0x70, 0x36);
        private static readonly Guid MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS = new(0xa634a91c, 0x822b, 0x41b9, 0xa4, 0x94, 0x4d, 0xe4, 0x64, 0x36, 0x12, 0xb0);
        private static readonly Guid MF_SINK_WRITER_DISABLE_THROTTLING = new(0x08b845d8, 0x2b74, 0x4afe, 0x9d, 0x53, 0xbe, 0x16, 0xd2, 0xd5, 0xae, 0x4f);

        private static readonly Guid MFMediaType_Video = new(0x73646976, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71);
        private static readonly Guid MFVideoFormat_H264 = MediaSubtype(0x34363248);  // FCC('H264')
        private static readonly Guid MFVideoFormat_RGB32 = MediaSubtype(22);         // D3DFMT_X8R8G8B8

        // Vtable slots: IUnknown 0–2; IMFAttributes 3–32; IMFSample adds 33–46; IMFMediaBuffer and IMFSinkWriter
        // derive from IUnknown only
        private const int SLOT_RELEASE = 2;
        private const int SLOT_ATTR_SET_UINT32 = 21, SLOT_ATTR_SET_UINT64 = 22, SLOT_ATTR_SET_GUID = 24;
        private const int SLOT_SAMPLE_SET_TIME = 36, SLOT_SAMPLE_SET_DURATION = 38, SLOT_SAMPLE_ADD_BUFFER = 42;
        private const int SLOT_BUFFER_LOCK = 3, SLOT_BUFFER_UNLOCK = 4, SLOT_BUFFER_SET_LENGTH = 6;
        private const int SLOT_WRITER_ADD_STREAM = 3, SLOT_WRITER_SET_INPUT = 4, SLOT_WRITER_BEGIN = 5, SLOT_WRITER_WRITE = 6, SLOT_WRITER_FINALIZE = 11;

        #endregion

        #region Exports

        [DllImport("mfplat.dll", ExactSpelling = true)]
        private static extern int MFStartup(uint version, uint flags);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        private static extern int MFShutdown();

        [DllImport("mfplat.dll", ExactSpelling = true)]
        private static extern int MFCreateAttributes(out IntPtr attributes, uint initialSize);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        private static extern int MFCreateMediaType(out IntPtr mediaType);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        private static extern int MFCreateSample(out IntPtr sample);

        [DllImport("mfplat.dll", ExactSpelling = true)]
        private static extern int MFCreateMemoryBuffer(uint maxLength, out IntPtr buffer);

        [DllImport("mfreadwrite.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        private static extern int MFCreateSinkWriterFromURL(string url, IntPtr byteStream, IntPtr attributes, out IntPtr sinkWriter);

        #endregion

        #region State

        private IntPtr _writer;
        private uint _stream;
        private bool _started;
        private readonly int _width, _height, _fps;
        private long _frames;

        /// <summary>Frames written.</summary>
        public long Frames => _frames;

        #endregion

        private Mp4Writer(int width, int height, int fps)
        {
            _width = width;
            _height = height;
            _fps = fps;
        }

        /// <summary>
        /// Opens an MP4 for writing (hardware encoder when available, else Windows' software encoder).
        /// </summary>
        /// <param name="path">The .mp4 path (overwritten).</param>
        /// <param name="width">Frame width (even).</param>
        /// <param name="height">Frame height (even).</param>
        /// <param name="fps">Frames per second.</param>
        /// <param name="bitrate">Average bits per second.</param>
        /// <param name="error">Why it failed, or null.</param>
        /// <returns>The writer, or null.</returns>
        public static Mp4Writer Create(string path, int width, int height, int fps, int bitrate, out string error)
        {
            error = null;
            Mp4Writer writer = null;
            try
            {
                Check(MFStartup(MF_VERSION, MFSTARTUP_FULL), "start Media Foundation");
                writer = new Mp4Writer(width, height, fps) { _started = true };
                if (!writer.Open(path, bitrate, hardware: true, out string hardwareError))
                {
                    Utilities.Log_Utils.Write($"Video: the hardware encoder was refused ({hardwareError}); trying the software encoder.");
                    writer.ReleaseWriter();
                    if (!writer.Open(path, bitrate, hardware: false, out error))
                    {
                        writer.Dispose();
                        return null;
                    }
                }
                return writer;
            }
            catch (DllNotFoundException)
            {
                error = "Windows Media Foundation isn't available on this PC (on Windows N editions, install the Media Feature Pack)";
            }
            catch (EntryPointNotFoundException ex)
            {
                error = "Windows Media Foundation is missing a function: " + ex.Message;
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }
            writer?.Dispose();
            return null;
        }

        /// <summary>
        /// Creates the sink writer and its H.264 output / RGB32 input types, then starts writing.
        /// </summary>
        private bool Open(string path, int bitrate, bool hardware, out string error)
        {
            error = null;
            IntPtr attributes = IntPtr.Zero, output = IntPtr.Zero, input = IntPtr.Zero;
            try
            {
                Check(MFCreateAttributes(out attributes, 2), "create the writer settings");
                SetUInt32(attributes, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, hardware ? 1u : 0u);
                SetUInt32(attributes, MF_SINK_WRITER_DISABLE_THROTTLING, 1u);
                Check(MFCreateSinkWriterFromURL(path, IntPtr.Zero, attributes, out _writer), "create the MP4 file");

                ulong frameSize = ((ulong)(uint)_width << 32) | (uint)_height;
                ulong frameRate = ((ulong)(uint)_fps << 32) | 1u;
                const ulong square = (1ul << 32) | 1ul;

                Check(MFCreateMediaType(out output), "create the output type");
                SetGuid(output, MF_MT_MAJOR_TYPE, MFMediaType_Video);
                SetGuid(output, MF_MT_SUBTYPE, MFVideoFormat_H264);
                SetUInt32(output, MF_MT_AVG_BITRATE, (uint)Math.Max(bitrate, 500_000));
                SetUInt32(output, MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
                SetUInt32(output, MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
                SetUInt64(output, MF_MT_FRAME_SIZE, frameSize);
                SetUInt64(output, MF_MT_FRAME_RATE, frameRate);
                SetUInt64(output, MF_MT_PIXEL_ASPECT_RATIO, square);
                uint stream;
                Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint*, int>)Slot(_writer, SLOT_WRITER_ADD_STREAM))(_writer, output, &stream), "add the video stream");
                _stream = stream;

                Check(MFCreateMediaType(out input), "create the input type");
                SetGuid(input, MF_MT_MAJOR_TYPE, MFMediaType_Video);
                SetGuid(input, MF_MT_SUBTYPE, MFVideoFormat_RGB32);
                SetUInt32(input, MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
                SetUInt32(input, MF_MT_DEFAULT_STRIDE, (uint)(_width * 4)); // positive: top-down rows
                SetUInt64(input, MF_MT_FRAME_SIZE, frameSize);
                SetUInt64(input, MF_MT_FRAME_RATE, frameRate);
                SetUInt64(input, MF_MT_PIXEL_ASPECT_RATIO, square);
                Check(((delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr, IntPtr, int>)Slot(_writer, SLOT_WRITER_SET_INPUT))(_writer, _stream, input, IntPtr.Zero),
                    "accept BGRA frames (no H.264 encoder for this size?)");

                Check(((delegate* unmanaged[Stdcall]<IntPtr, int>)Slot(_writer, SLOT_WRITER_BEGIN))(_writer), "start the file");
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
            finally
            {
                Release(input);
                Release(output);
                Release(attributes);
            }
        }

        /// <summary>
        /// Writes one frame.
        /// </summary>
        /// <param name="bgra">Pixels, BGRA, <paramref name="bottomUp"/> rows as read from OpenGL or top-down.</param>
        /// <param name="bottomUp">True when the first row in <paramref name="bgra"/> is the bottom of the picture.</param>
        public void WriteFrame(byte[] bgra, bool bottomUp)
        {
            int stride = _width * 4;
            uint length = (uint)(stride * _height);
            if (bgra == null || bgra.Length < length) { throw new ArgumentException("The frame is smaller than the video."); }

            IntPtr buffer = IntPtr.Zero, sample = IntPtr.Zero;
            try
            {
                Check(MFCreateMemoryBuffer(length, out buffer), "create a frame buffer");
                byte* data;
                uint max, current;
                Check(((delegate* unmanaged[Stdcall]<IntPtr, byte**, uint*, uint*, int>)Slot(buffer, SLOT_BUFFER_LOCK))(buffer, &data, &max, &current), "lock a frame buffer");
                try
                {
                    fixed (byte* source = bgra)
                    {
                        for (int row = 0; row < _height; row++)
                        {
                            int from = (bottomUp ? _height - 1 - row : row) * stride;
                            Buffer.MemoryCopy(source + from, data + row * stride, stride, stride);
                        }
                    }
                }
                finally
                {
                    ((delegate* unmanaged[Stdcall]<IntPtr, int>)Slot(buffer, SLOT_BUFFER_UNLOCK))(buffer);
                }
                Check(((delegate* unmanaged[Stdcall]<IntPtr, uint, int>)Slot(buffer, SLOT_BUFFER_SET_LENGTH))(buffer, length), "size a frame buffer");

                Check(MFCreateSample(out sample), "create a sample");
                Check(((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)Slot(sample, SLOT_SAMPLE_ADD_BUFFER))(sample, buffer), "add the frame");
                long duration = 10_000_000L / _fps;                  // 100 ns units
                long time = _frames * 10_000_000L / _fps;
                Check(((delegate* unmanaged[Stdcall]<IntPtr, long, int>)Slot(sample, SLOT_SAMPLE_SET_TIME))(sample, time), "time the frame");
                Check(((delegate* unmanaged[Stdcall]<IntPtr, long, int>)Slot(sample, SLOT_SAMPLE_SET_DURATION))(sample, duration), "time the frame");
                Check(((delegate* unmanaged[Stdcall]<IntPtr, uint, IntPtr, int>)Slot(_writer, SLOT_WRITER_WRITE))(_writer, _stream, sample), "encode the frame");
                _frames++;
            }
            finally
            {
                Release(sample);
                Release(buffer);
            }
        }

        /// <summary>
        /// Finishes the file (flushes the encoder, writes the MP4 index). Call once, after the last frame.
        /// </summary>
        public void Finish()
        {
            if (_writer == IntPtr.Zero) { return; }
            Check(((delegate* unmanaged[Stdcall]<IntPtr, int>)Slot(_writer, SLOT_WRITER_FINALIZE))(_writer), "finish the MP4 file");
        }

        /// <summary>Releases the writer (an unfinished file is left incomplete: delete it) and shuts Media Foundation down.</summary>
        public void Dispose()
        {
            ReleaseWriter();
            if (_started)
            {
                _started = false;
                try { MFShutdown(); } catch (Exception ex) { Utilities.Log_Utils.Write($"Video: Media Foundation shutdown failed: {ex.Message}"); }
            }
        }

        private void ReleaseWriter()
        {
            Release(_writer);
            _writer = IntPtr.Zero;
        }

        #region Helpers

        /// <summary>A media subtype GUID: the FOURCC / format code, then the standard media-type suffix.</summary>
        private static Guid MediaSubtype(uint code) => new(code, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71);

        private static void* Slot(IntPtr comObject, int slot) => (*(void***)comObject)[slot];

        private static void Release(IntPtr comObject)
        {
            if (comObject != IntPtr.Zero) { ((delegate* unmanaged[Stdcall]<IntPtr, uint>)Slot(comObject, SLOT_RELEASE))(comObject); }
        }

        private static void SetGuid(IntPtr attributes, Guid key, Guid value) =>
            Check(((delegate* unmanaged[Stdcall]<IntPtr, Guid*, Guid*, int>)Slot(attributes, SLOT_ATTR_SET_GUID))(attributes, &key, &value), "set a video attribute");

        private static void SetUInt32(IntPtr attributes, Guid key, uint value) =>
            Check(((delegate* unmanaged[Stdcall]<IntPtr, Guid*, uint, int>)Slot(attributes, SLOT_ATTR_SET_UINT32))(attributes, &key, value), "set a video attribute");

        private static void SetUInt64(IntPtr attributes, Guid key, ulong value) =>
            Check(((delegate* unmanaged[Stdcall]<IntPtr, Guid*, ulong, int>)Slot(attributes, SLOT_ATTR_SET_UINT64))(attributes, &key, value), "set a video attribute");

        /// <summary>Throws with a readable message when an HRESULT failed.</summary>
        private static void Check(int hr, string what)
        {
            if (hr >= 0) { return; }
            throw new InvalidOperationException($"Couldn't {what} (Media Foundation error 0x{hr:X8}).");
        }

        #endregion
    }
}
