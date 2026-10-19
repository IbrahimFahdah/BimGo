using System.Runtime.InteropServices;
using BimGo.Native;

// The class belongs to the Audio namespace
namespace BimGo.Audio
{
    /// <summary>
    /// Round W-C: the weather's sound: a streamed waveOut channel of its own (opened the first time it's needed) mixing
    /// the rain's looping hiss and thunder rumbles, all synthesised at start (no sound files). The game loop calls
    /// <see cref="Update"/> every frame: each finished buffer is refilled with the next stretch of the mix (about three
    /// quarters of a second queued), so the level and the muffling under a roof change smoothly without restarting
    /// anything. No allocations after start; failures (no audio device) leave it silent.
    /// </summary>
    internal sealed unsafe class WeatherSound : IDisposable
    {
        #region Constants

        private const int SAMPLE_RATE = 22050;
        private const int BUFFERS = 4, BUFFER_SAMPLES = 4096; // ~0.19 s each

        /// <summary>The rain loop's length (s) and the cross-fade that makes it seamless.</summary>
        private const float RAIN_SECONDS = 4f, RAIN_FADE = 0.5f;

        /// <summary>Thunder variants, their length (s), and how many can sound at once.</summary>
        private const int THUNDERS = 3, ACTIVE_THUNDERS = 3;
        private const float THUNDER_SECONDS = 7f;

        #endregion

        #region Fields

        private nint _device;
        private readonly WinMm.WAVEHDR*[] _headers = new WinMm.WAVEHDR*[BUFFERS];
        private readonly nint[] _buffers = new nint[BUFFERS];
        private float[] _rain = Array.Empty<float>();
        private readonly float[][] _thunder = new float[THUNDERS][];
        private bool _started, _failed;

        // The mix: the rain's place in its loop, its level now and wanted, the muffling (one-pole low-pass) now and wanted
        private int _rainAt;
        private float _rainLevel, _rainTarget, _muffle = 1f, _muffleTarget = 1f, _lowpass;

        // Thunder: per slot, the sample it starts at (relative to the stream; may be in the future), its variant and gain
        private readonly long[] _thunderStart = new long[ACTIVE_THUNDERS];
        private readonly int[] _thunderVariant = new int[ACTIVE_THUNDERS];
        private readonly float[] _thunderGain = new float[ACTIVE_THUNDERS];
        private long _written;
        private int _nextVariant;

        #endregion

        /// <summary>Master volume (0–1), as the other sounds.</summary>
        public float Volume { get; set; } = 0.35f;

        /// <summary>
        /// Per frame: sets the rain's level and the muffling, and keeps the buffers full. Opens the device the first time
        /// there is something to hear.
        /// </summary>
        /// <param name="rain">The rain's loudness (0 = none, 1 = a downpour).</param>
        /// <param name="covered">Under a roof: quieter and muffled.</param>
        public void Update(float rain, bool covered)
        {
            _rainTarget = Math.Clamp(rain, 0f, 1f) * (covered ? 0.45f : 1f);
            _muffleTarget = covered ? 0.12f : 1f;
            if (!_started)
            {
                if (_failed || (_rainTarget <= 0f && !ThunderPending)) { return; }
                Start();
                if (!_started) { return; }
            }
            for (int i = 0; i < BUFFERS; i++)
            {
                WinMm.WAVEHDR* header = _headers[i];
                if ((header->dwFlags & WinMm.WHDR_PREPARED) != 0 && (header->dwFlags & WinMm.WHDR_DONE) == 0) { continue; }
                Submit(i);
            }
        }

        /// <summary>
        /// Queues a thunder rumble <paramref name="delay"/> seconds from now (the next variant; the quietest slot is
        /// replaced when all are busy).
        /// </summary>
        /// <param name="gain">0–1 (near and loud – far and soft).</param>
        /// <param name="covered">Under a roof: quieter (the muffling follows the listener).</param>
        public void Thunder(float delay, float gain, bool covered)
        {
            if (_failed) { return; }
            int slot = 0;
            for (int i = 0; i < ACTIVE_THUNDERS; i++)
            {
                if (_thunderGain[i] <= 0f) { slot = i; break; }
                if (_thunderGain[i] < _thunderGain[slot]) { slot = i; }
            }
            // The stream plays about BUFFERS buffers behind what's written: start after what's queued
            long now = _started ? _written - BUFFERS * BUFFER_SAMPLES : 0;
            _thunderStart[slot] = Math.Max(now + (long)(Math.Max(delay, 0f) * SAMPLE_RATE), _written);
            _thunderVariant[slot] = _nextVariant;
            _thunderGain[slot] = Math.Clamp(gain, 0f, 1f) * (covered ? 0.6f : 1f);
            _nextVariant = (_nextVariant + 1) % THUNDERS;
        }

        private bool ThunderPending
        {
            get
            {
                for (int i = 0; i < ACTIVE_THUNDERS; i++) { if (_thunderGain[i] > 0f) { return true; } }
                return false;
            }
        }

        #region Stream

        private void Start()
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
                if (WinMm.waveOutOpen(out _device, WinMm.WAVE_MAPPER, format, 0, 0, WinMm.CALLBACK_NULL) != WinMm.MMSYSERR_NOERROR)
                {
                    _device = 0;
                    _failed = true;
                    return;
                }
                for (int i = 0; i < BUFFERS; i++)
                {
                    _headers[i] = (WinMm.WAVEHDR*)NativeMemory.AllocZeroed((nuint)sizeof(WinMm.WAVEHDR));
                    _buffers[i] = (nint)NativeMemory.AllocZeroed((nuint)(BUFFER_SAMPLES * 2));
                }
                _rain = SynthesiseRain();
                for (int t = 0; t < THUNDERS; t++) { _thunder[t] = SynthesiseThunder(t); }
                _started = true;
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Weather sound disabled: {ex.Message}");
                _failed = true;
            }
        }

        /// <summary>Fills buffer <paramref name="i"/> with the next stretch of the mix and queues it.</summary>
        private void Submit(int i)
        {
            WinMm.WAVEHDR* header = _headers[i];
            uint size = (uint)sizeof(WinMm.WAVEHDR);
            if ((header->dwFlags & WinMm.WHDR_PREPARED) != 0) { WinMm.waveOutUnprepareHeader(_device, header, size); }

            short* pcm = (short*)_buffers[i];
            float level = _rainLevel, muffle = _muffle;
            // Ramp the level and muffling across the buffer (no zipper noise)
            float levelStep = (_rainTarget - level) / BUFFER_SAMPLES * 0.6f;
            float muffleStep = (_muffleTarget - muffle) / BUFFER_SAMPLES * 0.5f;
            float volume = Math.Clamp(Volume, 0f, 1f) * 1.9f;
            for (int s = 0; s < BUFFER_SAMPLES; s++)
            {
                float sample = _rain.Length > 0 ? _rain[_rainAt] * level : 0f;
                if (++_rainAt >= _rain.Length) { _rainAt = 0; }
                long at = _written + s;
                for (int k = 0; k < ACTIVE_THUNDERS; k++)
                {
                    if (_thunderGain[k] <= 0f) { continue; }
                    long local = at - _thunderStart[k];
                    if (local < 0) { continue; }
                    float[] rumble = _thunder[_thunderVariant[k]];
                    if (local >= rumble.Length) { _thunderGain[k] = 0f; continue; }
                    sample += rumble[local] * _thunderGain[k];
                }
                _lowpass += (sample - _lowpass) * muffle;
                pcm[s] = (short)Math.Clamp(_lowpass * volume * 32767f, -32767f, 32767f);
                level += levelStep;
                muffle += muffleStep;
            }
            _rainLevel = level;
            _muffle = muffle;
            _written += BUFFER_SAMPLES;

            header->lpData = _buffers[i];
            header->dwBufferLength = BUFFER_SAMPLES * 2;
            header->dwFlags = 0;
            header->dwLoops = 0;
            if (WinMm.waveOutPrepareHeader(_device, header, size) == WinMm.MMSYSERR_NOERROR)
            {
                WinMm.waveOutWrite(_device, header, size);
            }
        }

        #endregion

        #region Synthesis

        /// <summary>
        /// The rain: a soft wash (low-passed noise), a brighter hiss, and scattered drop ticks; the end cross-fades into
        /// the start so it loops without a seam. Peak about ±0.5.
        /// </summary>
        private static float[] SynthesiseRain()
        {
            int loop = (int)(RAIN_SECONDS * SAMPLE_RATE), fade = (int)(RAIN_FADE * SAMPLE_RATE);
            var raw = new float[loop + fade];
            var random = new Random(4242);
            float wash = 0f, hiss = 0f, hissLow = 0f, tick = 0f, tickPhase = 0f;
            for (int i = 0; i < raw.Length; i++)
            {
                float white = (float)(random.NextDouble() * 2.0 - 1.0);
                wash += (white - wash) * 0.05f;
                hissLow += (white - hissLow) * 0.5f;
                hiss = white - hissLow; // high-passed
                if (random.NextDouble() < 0.0035)
                {
                    tick = 0.25f + 0.35f * (float)random.NextDouble();
                    tickPhase = 0f;
                }
                tickPhase += MathF.Tau * 2600f / SAMPLE_RATE;
                float drop = tick * MathF.Sin(tickPhase);
                tick *= 0.993f;
                raw[i] = wash * 1.1f + hiss * 0.18f + drop * 0.18f;
            }
            var rain = new float[loop];
            for (int i = 0; i < loop; i++)
            {
                float v = raw[i];
                if (i < fade)
                {
                    float t = (float)i / fade;
                    v = raw[i] * t + raw[loop + i] * (1f - t);
                }
                rain[i] = v;
            }
            Normalise(rain, 0.5f);
            return rain;
        }

        /// <summary>
        /// A thunder rumble: a short crack (stronger in the first variant: a near strike), then deep rolling rumbles
        /// (low-passed noise under a slow random swell) dying away over a few seconds. Peak about ±0.8.
        /// </summary>
        private static float[] SynthesiseThunder(int variant)
        {
            int count = (int)(THUNDER_SECONDS * SAMPLE_RATE);
            var pcm = new float[count];
            var random = new Random(777 + variant * 31);
            float deep = 0f, low = 0f, crack = 0f, swell = 0f, swellTarget = 0.6f;
            float crackStrength = variant == 0 ? 0.8f : variant == 1 ? 0.35f : 0.12f;
            for (int i = 0; i < count; i++)
            {
                float t = (float)i / SAMPLE_RATE;
                float white = (float)(random.NextDouble() * 2.0 - 1.0);
                deep += (white - deep) * 0.015f; // ~50 Hz and below: the roll
                low += (white - low) * 0.06f;    // ~200 Hz: the body
                crack += (white - crack) * 0.35f;
                if (i % 2205 == 0) { swellTarget = 0.35f + 0.65f * (float)random.NextDouble(); }
                swell += (swellTarget - swell) * 0.0004f;
                float attack = MathF.Min(1f, t / 0.05f);
                float body = attack * MathF.Exp(-t / (1.6f + 0.4f * variant)) * swell;
                float snap = crackStrength * MathF.Exp(-t / 0.18f) * MathF.Min(1f, t / 0.01f);
                float release = MathF.Min(1f, (THUNDER_SECONDS - t) / 0.5f);
                pcm[i] = ((deep * 3f + low) * body + crack * snap) * release;
            }
            Normalise(pcm, 0.8f);
            return pcm;
        }

        /// <summary>Scales a sound so its loudest sample is <paramref name="peak"/>.</summary>
        private static void Normalise(float[] pcm, float peak)
        {
            float max = 1e-6f;
            for (int i = 0; i < pcm.Length; i++) { max = MathF.Max(max, MathF.Abs(pcm[i])); }
            float scale = peak / max;
            for (int i = 0; i < pcm.Length; i++) { pcm[i] *= scale; }
        }

        #endregion

        /// <summary>Stops playback and frees everything.</summary>
        public void Dispose()
        {
            if (_device != 0)
            {
                WinMm.waveOutReset(_device);
                for (int i = 0; i < BUFFERS; i++)
                {
                    if (_headers[i] != null && (_headers[i]->dwFlags & WinMm.WHDR_PREPARED) != 0)
                    {
                        WinMm.waveOutUnprepareHeader(_device, _headers[i], (uint)sizeof(WinMm.WAVEHDR));
                    }
                }
                WinMm.waveOutClose(_device);
                _device = 0;
            }
            for (int i = 0; i < BUFFERS; i++)
            {
                if (_headers[i] != null) { NativeMemory.Free(_headers[i]); _headers[i] = null; }
                if (_buffers[i] != 0) { NativeMemory.Free((void*)_buffers[i]); _buffers[i] = 0; }
            }
            _started = false;
        }
    }
}
