using BimGo.Rendering;
using BimGo.Scene;

// The class belongs to the Game namespace
namespace BimGo.Game
{
    /// <summary>
    /// The app's current display units (review tools round) and allocation-free formatting into a
    /// <see cref="TextBuffer"/>. One walkthrough runs per app, and the choice is per machine, so it lives here rather
    /// than being passed to every gun and panel. Set from the settings when a session starts and when the pause menu
    /// or the home screen changes it. Lux and daylight % never change with it.
    /// </summary>
    internal static class UnitFormat
    {
        /// <summary>Metric or imperial.</summary>
        public static UnitSystem Current { get; private set; } = UnitSystem.Metric;

        /// <summary>Imperial lengths as decimal feet rather than feet-inches.</summary>
        public static bool DecimalFeet { get; private set; }

        /// <summary>True when imperial units are shown.</summary>
        public static bool IsImperial => Current == UnitSystem.Imperial;

        /// <summary>Incremented on every change (labels cached as strings rebuild when it moves).</summary>
        public static int Revision { get; private set; }

        /// <summary>
        /// Sets the units (no-op when unchanged).
        /// </summary>
        public static void Set(UnitSystem system, bool decimalFeet)
        {
            if (!Enum.IsDefined(system)) { system = UnitSystem.Metric; }
            if (system == Current && decimalFeet == DecimalFeet) { return; }
            Current = system;
            DecimalFeet = decimalFeet;
            Revision++;
        }

        /// <summary>Reads the units from the settings.</summary>
        public static void Read(LaunchSettings settings)
        {
            if (settings != null) { Set(settings.DisplayUnits, settings.DecimalFeet); }
        }

        /// <summary>Writes the units into the settings.</summary>
        public static void Write(LaunchSettings settings)
        {
            if (settings == null) { return; }
            settings.DisplayUnits = Current;
            settings.DecimalFeet = DecimalFeet;
        }

        /// <summary>
        /// Appends a length: "1.625 m" (the given metric decimals), "5' 7 1/2\"" or "5.33'".
        /// </summary>
        public static TextBuffer AppendLength(this TextBuffer text, double metres, int metricDecimals = 3, bool plusSign = false)
        {
            if (!double.IsFinite(metres)) { return text.Append("—"); }
            if (Current == UnitSystem.Metric) { return text.Append(metres, metricDecimals, plusSign).Append(" m"); }
            if (DecimalFeet) { return text.Append(Units.ToFeet(metres), Math.Max(2, metricDecimals), plusSign).Append('\''); }

            Units.FeetInches(metres, out bool negative, out long feet, out int inches, out int numerator, out int denominator);
            if (negative) { text.Append('−'); }
            else if (plusSign) { text.Append('+'); }
            text.Append(feet).Append("' ").Append(inches);
            if (numerator > 0) { text.Append(' ').Append(numerator).Append('/').Append(denominator); }
            return text.Append('"');
        }

        /// <summary>
        /// Appends a survey coordinate or elevation: metres, or decimal feet in imperial (3 decimals).
        /// </summary>
        public static TextBuffer AppendCoordinate(this TextBuffer text, double metres)
        {
            if (Current == UnitSystem.Metric) { return text.Append(metres, 3).Append(" m"); }
            return text.Append(Units.ToFeet(metres), 3).Append('\'');
        }

        /// <summary>
        /// Appends an area: "14.2 m²" or "152.8 ft²".
        /// </summary>
        public static TextBuffer AppendArea(this TextBuffer text, double squareMetres, int decimals = 1)
        {
            if (Current == UnitSystem.Metric) { return text.Append(squareMetres, decimals).Append(" m²"); }
            return text.Append(Units.ToSquareFeet(squareMetres), decimals).Append(" ft²");
        }

        /// <summary>A length as a string (toasts and labels made once).</summary>
        public static string Length(double metres, int metricDecimals = 3) => Units.Length(metres, Current, DecimalFeet, metricDecimals);

        /// <summary>An area as a string.</summary>
        public static string Area(double squareMetres, int decimals = 1) => Units.Area(squareMetres, Current, decimals);

        /// <summary>"m" or "ft" (column headers, axis notes).</summary>
        public static string LengthSymbol => Current == UnitSystem.Metric ? "m" : "ft";

        /// <summary>"Metric" / "Imperial".</summary>
        public static string Label => Current == UnitSystem.Metric ? "Metric" : DecimalFeet ? "Imperial (decimal feet)" : "Imperial";
    }
}
