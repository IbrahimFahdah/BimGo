using System.Collections.Concurrent;
using BimGo.Native;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// Writes a walkthrough video on a worker thread (tour round, build A2). The game thread renders each frame, reads
    /// it back into a buffer rented from a small pool, and submits it; the worker encodes it with
    /// <see cref="Mp4Writer"/> and hands the buffer back. With every buffer queued, renting waits for the encoder
    /// (memory stays at a few frames, even at 4K). Cancelling deletes the file. Never throws to the caller.
    /// </summary>
    internal sealed class VideoRecorder : IDisposable
    {
        /// <summary>Frames in flight between the game thread and the encoder.</summary>
        private const int POOL = 3;

        private readonly BlockingCollection<byte[]> _free = new(POOL);
        private readonly BlockingCollection<byte[]> _queued = new(POOL);
        private readonly Thread _worker;
        private readonly string _path;
        private readonly int _width, _height, _fps, _bitrate;
        private volatile bool _cancelled;
        private volatile bool _finished;
        private volatile bool _ready;
        private volatile string _error;
        private long _written;

        /// <summary>
        /// Starts the worker, which opens the file (check <see cref="Error"/> / <see cref="IsReady"/>).
        /// </summary>
        public VideoRecorder(string path, int width, int height, int fps, int bitrate)
        {
            _path = path;
            _width = width;
            _height = height;
            _fps = fps;
            _bitrate = bitrate;
            int bytes = width * height * 4;
            for (int i = 0; i < POOL; i++) { _free.Add(new byte[bytes]); }
            _worker = new Thread(Run) { IsBackground = true, Name = "BimGo video encoder" };
            _worker.Start();
        }

        /// <summary>The output file.</summary>
        public string Path => _path;

        /// <summary>Why recording failed, or null.</summary>
        public string Error => _error;

        /// <summary>True once the encoder has opened the file.</summary>
        public bool IsReady => _ready;

        /// <summary>True once the worker has stopped (finished, cancelled or failed).</summary>
        public bool IsFinished => _finished;

        /// <summary>Frames encoded so far.</summary>
        public long Written => Interlocked.Read(ref _written);

        /// <summary>
        /// A free frame buffer (width × height × 4 bytes), waiting for the encoder when all are queued.
        /// </summary>
        /// <returns>The buffer, or null when recording failed or was cancelled.</returns>
        public byte[] Rent()
        {
            while (_error == null && !_cancelled && !_finished)
            {
                if (_free.TryTake(out byte[] buffer, 100)) { return buffer; }
            }
            return null;
        }

        /// <summary>Queues a rented buffer for encoding (bottom-up BGRA, as read from OpenGL).</summary>
        public void Submit(byte[] frame)
        {
            if (frame == null) { return; }
            try { _queued.Add(frame); }
            catch (InvalidOperationException) { /* already completed: the frame is dropped */ }
        }

        /// <summary>No more frames: the worker finishes the file after the queued ones.</summary>
        public void Complete()
        {
            try { _queued.CompleteAdding(); } catch (ObjectDisposedException) { }
        }

        /// <summary>Stops without finishing; the partial file is deleted.</summary>
        public void Cancel()
        {
            _cancelled = true;
            Complete();
        }

        /// <summary>
        /// The worker: opens the writer, encodes queued frames, then finishes (or deletes the file when cancelled or
        /// failed).
        /// </summary>
        private void Run()
        {
            Mp4Writer writer = null;
            try
            {
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(_path));
                writer = Mp4Writer.Create(_path, _width, _height, _fps, _bitrate, out string error);
                if (writer == null)
                {
                    _error = error ?? "The video file couldn't be created";
                    return;
                }
                _ready = true;

                foreach (byte[] frame in _queued.GetConsumingEnumerable())
                {
                    if (_cancelled) { break; }
                    writer.WriteFrame(frame, bottomUp: true);
                    Interlocked.Increment(ref _written);
                    _free.Add(frame);
                }
                if (!_cancelled) { writer.Finish(); }
            }
            catch (Exception ex)
            {
                Utilities.Log_Utils.Write($"Video recording failed: {ex}");
                _error = ex.Message;
            }
            finally
            {
                try { writer?.Dispose(); }
                catch (Exception ex) { Utilities.Log_Utils.Write($"Video writer cleanup failed: {ex.Message}"); }
                if (_cancelled || _error != null)
                {
                    try { if (File.Exists(_path)) { File.Delete(_path); } }
                    catch (Exception ex) { Utilities.Log_Utils.Write($"Partial video not deleted ({_path}): {ex.Message}"); }
                }
                _finished = true;
            }
        }

        /// <summary>Cancels if still running and waits briefly for the worker.</summary>
        public void Dispose()
        {
            if (!_finished) { Cancel(); }
            _worker.Join(3000);
            _free.Dispose();
            _queued.Dispose();
        }
    }
}
