using System.Globalization;

// The class belongs to the Rendering namespace
namespace RvtGo.Rendering
{
    /// <summary>
    /// A reusable character buffer for building HUD strings without per-frame allocations.
    /// Usage: buffer.Clear().Append("FPS ").Append(fps, 0).Span
    /// </summary>
    internal sealed class TextBuffer
    {
        private readonly char[] _chars = new char[512];
        private int _length;

        /// <summary>The current text.</summary>
        public ReadOnlySpan<char> Span => _chars.AsSpan(0, _length);

        /// <summary>Clears the buffer.</summary>
        public TextBuffer Clear()
        {
            _length = 0;
            return this;
        }

        /// <summary>Appends text.</summary>
        public TextBuffer Append(ReadOnlySpan<char> text)
        {
            int n = Math.Min(text.Length, _chars.Length - _length);
            text[..n].CopyTo(_chars.AsSpan(_length));
            _length += n;
            return this;
        }

        /// <summary>Appends a character.</summary>
        public TextBuffer Append(char c)
        {
            if (_length < _chars.Length) { _chars[_length++] = c; }
            return this;
        }

        /// <summary>Appends an integer.</summary>
        public TextBuffer Append(long value)
        {
            if (value.TryFormat(_chars.AsSpan(_length), out int written, default, CultureInfo.InvariantCulture)) { _length += written; }
            return this;
        }

        /// <summary>Appends an integer with thousands separators.</summary>
        public TextBuffer AppendGrouped(long value)
        {
            if (value.TryFormat(_chars.AsSpan(_length), out int written, "N0", CultureInfo.InvariantCulture)) { _length += written; }
            return this;
        }

        /// <summary>
        /// Appends a number with fixed decimals; negatives use a true minus sign, and an optional plus for positives.
        /// </summary>
        public TextBuffer Append(float value, int decimals, bool plusSign = false)
        {
            if (float.IsNaN(value) || float.IsInfinity(value)) { return Append("—"); }

            if (value < 0f && MathF.Abs(value) >= 0.5f * MathF.Pow(10f, -decimals)) { Append('−'); }
            else if (plusSign) { Append('+'); }

            ReadOnlySpan<char> format = decimals switch
            {
                0 => "F0",
                1 => "F1",
                2 => "F2",
                _ => "F3"
            };
            if (MathF.Abs(value).TryFormat(_chars.AsSpan(_length), out int written, format, CultureInfo.InvariantCulture)) { _length += written; }
            return this;
        }
    }
}
