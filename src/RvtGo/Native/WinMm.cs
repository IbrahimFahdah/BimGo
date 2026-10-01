using System.Runtime.InteropServices;

// The class belongs to the Native namespace
namespace RvtGo.Native
{
    /// <summary>
    /// waveOut interop (winmm) for synthesised sounds.
    /// </summary>
    internal static unsafe class WinMm
    {
        public const uint WAVE_MAPPER = 0xFFFFFFFF;
        public const uint CALLBACK_NULL = 0;
        public const ushort WAVE_FORMAT_PCM = 1;
        public const uint WHDR_DONE = 0x00000001, WHDR_PREPARED = 0x00000002;
        public const uint MMSYSERR_NOERROR = 0;

        [StructLayout(LayoutKind.Sequential, Pack = 2)]
        public struct WAVEFORMATEX
        {
            public ushort wFormatTag;
            public ushort nChannels;
            public uint nSamplesPerSec;
            public uint nAvgBytesPerSec;
            public ushort nBlockAlign;
            public ushort wBitsPerSample;
            public ushort cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct WAVEHDR
        {
            public nint lpData;
            public uint dwBufferLength;
            public uint dwBytesRecorded;
            public nint dwUser;
            public uint dwFlags;
            public uint dwLoops;
            public nint lpNext;
            public nint reserved;
        }

        [DllImport("winmm.dll")]
        public static extern uint waveOutOpen(out nint handle, uint deviceId, in WAVEFORMATEX format, nint callback, nint instance, uint flags);

        [DllImport("winmm.dll")]
        public static extern uint waveOutPrepareHeader(nint handle, WAVEHDR* header, uint size);

        [DllImport("winmm.dll")]
        public static extern uint waveOutUnprepareHeader(nint handle, WAVEHDR* header, uint size);

        [DllImport("winmm.dll")]
        public static extern uint waveOutWrite(nint handle, WAVEHDR* header, uint size);

        [DllImport("winmm.dll")]
        public static extern uint waveOutReset(nint handle);

        [DllImport("winmm.dll")]
        public static extern uint waveOutClose(nint handle);
    }
}
