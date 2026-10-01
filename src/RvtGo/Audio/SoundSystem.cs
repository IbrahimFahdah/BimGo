using System.Runtime.InteropServices;
using RvtGo.Native;

// The class belongs to the Audio namespace
namespace RvtGo.Audio
{
    /// <summary>
    /// The synthesised sound effects.
    /// </summary>
    internal enum SoundId
    {
        ScanLock,
        Click,
        PortalBlue,
        PortalRed,
        Teleport,
        CommentPlace,
        Remove,
        Error,
        UiClick,
        Count
    }

    /// <summary>
    /// Tiny waveOut mixer-free player: every sound is synthesised at startup into unmanaged PCM,
    /// and played on the first idle of a few waveOut channels. No audio assets ship.
    /// Failures (no audio device) disable sound silently.
    /// </summary>
    internal sealed unsafe class SoundSystem : IDisposable
    {
        private const int SAMPLE_RATE = 22050;
        private const int CHANNELS = 4;

        private readonly nint[] _devices = new nint[CHANNELS];
        private readonly WinMm.WAVEHDR*[] _headers = new WinMm.WAVEHDR*[CHANNELS];
        private readonly nint[] _soundData = new nint[(int)SoundId.Count];
        private readonly int[] _soundBytes = new int[(int)SoundId.Count];
        private bool _enabled;

        /// <summary>Master volume 0..1.</summary>
        public float Volume { get; set; } = 0.35f;

        /// <summary>
        /// Opens the devices and synthesises the sounds.
        /// </summary>
        public void Initialise()
        {
            try
            {
                var format = new WinMm.WAVEFORMATEX
                {
                    wFormatTag = WinMm.WAVE_FORMAT_PCM,
                    nChannels = 1,
                    nSamplesPerSec = SAMPLE_RATE,
                    wBitsPerSample = 16,
                    nBlockAlign = 2,
                    nAvgBytesPerSec = SAMPLE_RATE * 2,
                    cbSize = 0
                };

                for (int i = 0; i < CHANNELS; i++)
                {
                    if (WinMm.waveOutOpen(out _devices[i], WinMm.WAVE_MAPPER, format, 0, 0, WinMm.CALLBACK_NULL) != WinMm.MMSYSERR_NOERROR)
                    {
                        _devices[i] = 0;
                        continue;
                    }
                    _headers[i] = (WinMm.WAVEHDR*)NativeMemory.AllocZeroed((nuint)sizeof(WinMm.WAVEHDR));
                }

                _enabled = _devices.Any(d => d != 0);
                if (!_enabled) { return; }

                for (int s = 0; s < (int)SoundId.Count; s++)
                {
                    short[] pcm = Synthesise((SoundId)s);
                    _soundBytes[s] = pcm.Length * 2;
                    _soundData[s] = (nint)NativeMemory.Alloc((nuint)_soundBytes[s]);
                    fixed (short* source = pcm)
                    {
                        Buffer.MemoryCopy(source, (void*)_soundData[s], _soundBytes[s], _soundBytes[s]);
                    }
                }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Audio disabled: {ex.Message}");
                _enabled = false;
            }
        }

        /// <summary>
        /// Plays a sound on the first idle channel (dropped if all are busy).
        /// </summary>
        public void Play(SoundId sound)
        {
            if (!_enabled || Volume <= 0f) { return; }

            for (int i = 0; i < CHANNELS; i++)
            {
                if (_devices[i] == 0) { continue; }
                WinMm.WAVEHDR* header = _headers[i];
                bool prepared = (header->dwFlags & WinMm.WHDR_PREPARED) != 0;
                bool done = (header->dwFlags & WinMm.WHDR_DONE) != 0;
                if (prepared && !done) { continue; }

                uint size = (uint)sizeof(WinMm.WAVEHDR);
                if (prepared) { WinMm.waveOutUnprepareHeader(_devices[i], header, size); }

                header->lpData = _soundData[(int)sound];
                header->dwBufferLength = (uint)_soundBytes[(int)sound];
                header->dwFlags = 0;
                header->dwLoops = 0;
                if (WinMm.waveOutPrepareHeader(_devices[i], header, size) == WinMm.MMSYSERR_NOERROR)
                {
                    WinMm.waveOutWrite(_devices[i], header, size);
                }
                return;
            }
        }

        #region Synthesis

        /// <summary>
        /// Builds one sound's 16-bit PCM.
        /// </summary>
        private short[] Synthesise(SoundId sound)
        {
            var random = new Random(1234 + (int)sound);
            float duration = sound switch
            {
                SoundId.ScanLock => 0.09f,
                SoundId.Click => 0.035f,
                SoundId.PortalBlue => 0.28f,
                SoundId.PortalRed => 0.28f,
                SoundId.Teleport => 0.42f,
                SoundId.CommentPlace => 0.24f,
                SoundId.Remove => 0.12f,
                SoundId.Error => 0.14f,
                _ => 0.02f
            };

            int count = (int)(duration * SAMPLE_RATE);
            var pcm = new short[count];
            float phase = 0f, phase2 = 0f, lowpass = 0f;

            for (int i = 0; i < count; i++)
            {
                float t = (float)i / SAMPLE_RATE;
                float u = t / duration;                     // 0..1 progress
                float attack = MathF.Min(1f, t / 0.004f);   // click-free start
                float release = MathF.Min(1f, (duration - t) / 0.02f);
                float env = attack * MathF.Max(release, 0f);
                float sample;

                switch (sound)
                {
                    case SoundId.ScanLock:
                        phase += MathF.Tau * (u < 0.45f ? 880f : 1320f) / SAMPLE_RATE;
                        sample = MathF.Sin(phase) * 0.6f;
                        break;

                    case SoundId.Click:
                        phase += MathF.Tau * 1600f / SAMPLE_RATE;
                        sample = MathF.Sin(phase) * (1f - u) * 0.7f;
                        break;

                    case SoundId.PortalBlue:
                    case SoundId.PortalRed:
                    {
                        float f0 = sound == SoundId.PortalBlue ? 320f : 900f;
                        float f1 = sound == SoundId.PortalBlue ? 900f : 320f;
                        float f = f0 + (f1 - f0) * u + MathF.Sin(t * 60f) * 25f;
                        phase += MathF.Tau * f / SAMPLE_RATE;
                        phase2 += MathF.Tau * f * 1.5f / SAMPLE_RATE;
                        sample = (MathF.Sin(phase) * 0.45f + MathF.Sin(phase2) * 0.2f) * (1f - u * 0.6f);
                        break;
                    }

                    case SoundId.Teleport:
                    {
                        float noise = (float)(random.NextDouble() * 2.0 - 1.0);
                        float cutoff = 0.05f + 0.45f * MathF.Sin(MathF.PI * u);
                        lowpass += (noise - lowpass) * cutoff;
                        phase += MathF.Tau * (200f + 500f * u) / SAMPLE_RATE;
                        sample = lowpass * 0.7f + MathF.Sin(phase) * 0.2f;
                        break;
                    }

                    case SoundId.CommentPlace:
                        phase += MathF.Tau * (u < 0.4f ? 660f : 990f) / SAMPLE_RATE;
                        sample = MathF.Sin(phase) * 0.5f * (1f - u * 0.5f);
                        break;

                    case SoundId.Remove:
                        phase += MathF.Tau * (440f - 220f * u) / SAMPLE_RATE;
                        sample = MathF.Sin(phase) * 0.5f;
                        break;

                    case SoundId.Error:
                        phase += MathF.Tau * 140f / SAMPLE_RATE;
                        sample = MathF.Sign(MathF.Sin(phase)) * 0.25f;
                        break;

                    default:
                        phase += MathF.Tau * 1000f / SAMPLE_RATE;
                        sample = MathF.Sin(phase) * 0.3f;
                        break;
                }

                pcm[i] = (short)Math.Clamp(sample * env * Volume * 32767f, -32767f, 32767f);
            }
            return pcm;
        }

        #endregion

        /// <summary>
        /// Stops playback and frees everything.
        /// </summary>
        public void Dispose()
        {
            for (int i = 0; i < CHANNELS; i++)
            {
                if (_devices[i] != 0)
                {
                    WinMm.waveOutReset(_devices[i]);
                    if (_headers[i] != null && (_headers[i]->dwFlags & WinMm.WHDR_PREPARED) != 0)
                    {
                        WinMm.waveOutUnprepareHeader(_devices[i], _headers[i], (uint)sizeof(WinMm.WAVEHDR));
                    }
                    WinMm.waveOutClose(_devices[i]);
                    _devices[i] = 0;
                }
                if (_headers[i] != null)
                {
                    NativeMemory.Free(_headers[i]);
                    _headers[i] = null;
                }
            }
            for (int s = 0; s < _soundData.Length; s++)
            {
                if (_soundData[s] != 0)
                {
                    NativeMemory.Free((void*)_soundData[s]);
                    _soundData[s] = 0;
                }
            }
            _enabled = false;
        }
    }
}
