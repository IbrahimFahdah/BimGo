// The class belongs to the Platform namespace
namespace BimGo.Platform
{
    /// <summary>
    /// Hint text that names keys (input round B2): built from the current bindings (<see cref="Hotkeys.Label"/>) and
    /// cached until a binding changes, so panels drawn every frame don't allocate and always show the user's keys.
    /// Create once (a field) with the text builder: <c>new KeyHint(() => $"{Hotkeys.Label(InputAction.GizmoSnap)} snap")</c>.
    /// </summary>
    internal sealed class KeyHint
    {
        private readonly Func<string> _build;
        private string _text;
        private int _version = int.MinValue;

        /// <summary>
        /// Creates the hint.
        /// </summary>
        /// <param name="build">Makes the text (called again after a rebinding).</param>
        public KeyHint(Func<string> build)
        {
            _build = build ?? throw new ArgumentNullException(nameof(build));
        }

        /// <summary>The text for the current bindings.</summary>
        public string Text
        {
            get
            {
                int version = Hotkeys.Version;
                if (_version != version || _text == null)
                {
                    _text = _build() ?? string.Empty;
                    _version = version;
                }
                return _text;
            }
        }
    }
}
