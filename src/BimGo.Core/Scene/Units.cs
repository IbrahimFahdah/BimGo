using System.Globalization;

// The class belongs to the Scene namespace
namespace BimGo.Scene
{
    /// <summary>
    /// The units lengths and areas are shown in (review tools round). Per machine (settings.json); the model always
    /// stays in metres.
    /// </summary>
    public enum UnitSystem
    {
        /// <summary>Metres, millimetres and square metres (the default).</summary>
        Metric = 0,

        /// <summary>Feet and inches (or decimal feet) and square feet.</summary>
        Imperial = 1
    }

    /// <summary>
    /// Unit conversions and display text for lengths and areas (review tools round). Pure maths: the app formats
    /// into its own buffers with <see cref="FeetInches"/> so the HUD doesn't allocate; the string methods are for
    /// toasts, labels made once and files.
    /// <list type="bullet">
    /// <item>Metric: "1.625 m", areas "14.2 m²".</item>
    /// <item>Imperial: feet-inches to the nearest 1/8" ("5' 7 1/2\""), or decimal feet ("5.33'") when chosen; areas
    /// "152.8 ft²". Survey coordinates use decimal feet either way (feet-inches is not how coordinates are read).</item>
    /// </list>
    /// </summary>
    public static class Units
    {
        /// <summary>Metres in an international foot.</summary>
        public const double METRES_PER_FOOT = 0.3048;

        /// <summary>Metres in an inch.</summary>
        public const double METRES_PER_INCH = 0.0254;

        /// <summary>Square feet in a square metre.</summary>
        public const double SQFT_PER_SQM = 1.0 / (METRES_PER_FOOT * METRES_PER_FOOT);

        /// <summary>Feet-inches are rounded to this fraction of an inch (1/8").</summary>
        public const int INCH_DIVISIONS = 8;

        /// <summary>Metres → feet.</summary>
        public static double ToFeet(double metres) => metres / METRES_PER_FOOT;

        /// <summary>Square metres → square feet.</summary>
        public static double ToSquareFeet(double squareMetres) => squareMetres * SQFT_PER_SQM;

        /// <summary>
        /// Splits a length into whole feet, whole inches and a reduced fraction of an inch (nearest 1/8"; 11 7/8"
        /// that rounds up carries into the next foot).
        /// </summary>
        /// <param name="metres">The length.</param>
        /// <param name="negative">True for a negative length that doesn't round to zero.</param>
        /// <param name="feet">Whole feet.</param>
        /// <param name="inches">Whole inches (0–11).</param>
        /// <param name="numerator">Fraction numerator (0 when none).</param>
        /// <param name="denominator">Fraction denominator (2, 4 or 8; 1 when none).</param>
        /// <returns>False for a value that isn't finite (outputs zero).</returns>
        public static bool FeetInches(double metres, out bool negative, out long feet, out int inches, out int numerator, out int denominator)
        {
            negative = false;
            feet = 0;
            inches = 0;
            numerator = 0;
            denominator = 1;
            if (!double.IsFinite(metres)) { return false; }

            long steps = (long)Math.Round(Math.Abs(metres) / METRES_PER_INCH * INCH_DIVISIONS, MidpointRounding.AwayFromZero);
            negative = metres < 0 && steps > 0;
            long perFoot = 12L * INCH_DIVISIONS;
            feet = steps / perFoot;
            long rest = steps % perFoot;
            inches = (int)(rest / INCH_DIVISIONS);
            numerator = (int)(rest % INCH_DIVISIONS);
            denominator = INCH_DIVISIONS;
            if (numerator == 0)
            {
                denominator = 1;
            }
            else
            {
                while (numerator % 2 == 0 && denominator > 1)
                {
                    numerator /= 2;
                    denominator /= 2;
                }
            }
            return true;
        }

        /// <summary>
        /// A length as text: "1.625 m" (metric, the given decimals), "5' 7 1/2\"" (feet-inches) or "5.33'" (decimal
        /// feet: the metric decimals, at least 2). Negative values carry a true minus sign.
        /// </summary>
        public static string Length(double metres, UnitSystem system, bool decimalFeet = false, int metricDecimals = 3)
        {
            if (!double.IsFinite(metres)) { return "—"; }
            if (system == UnitSystem.Metric) { return Signed(metres, metricDecimals) + " m"; }
            if (decimalFeet) { return Signed(ToFeet(metres), Math.Max(2, metricDecimals)) + "'"; }

            FeetInches(metres, out bool negative, out long feet, out int inches, out int numerator, out int denominator);
            string sign = negative ? "−" : string.Empty;
            string fraction = numerator > 0 ? $" {numerator}/{denominator}" : string.Empty;
            return $"{sign}{feet}' {inches}{fraction}\"";
        }

        /// <summary>
        /// A survey coordinate or elevation: metres in metric, decimal feet in imperial (both 3 decimals).
        /// </summary>
        public static string Coordinate(double metres, UnitSystem system) =>
            system == UnitSystem.Metric ? Signed(metres, 3) + " m" : Signed(ToFeet(metres), 3) + "'";

        /// <summary>
        /// An area as text: "14.2 m²" or "152.8 ft²" (the given decimals in both).
        /// </summary>
        public static string Area(double squareMetres, UnitSystem system, int decimals = 1)
        {
            if (!double.IsFinite(squareMetres)) { return "—"; }
            return system == UnitSystem.Metric
                ? Signed(squareMetres, decimals) + " m²"
                : Signed(ToSquareFeet(squareMetres), decimals) + " ft²";
        }

        /// <summary>The unit's area symbol: "m²" or "ft²".</summary>
        public static string AreaSymbol(UnitSystem system) => system == UnitSystem.Metric ? "m²" : "ft²";

        /// <summary>Fixed decimals, invariant culture, true minus sign.</summary>
        private static string Signed(double value, int decimals)
        {
            decimals = Math.Clamp(decimals, 0, 6);
            string text = Math.Abs(value).ToString("F" + decimals.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
            bool zero = Math.Abs(value) < 0.5 * Math.Pow(10, -decimals);
            return value < 0 && !zero ? "−" + text : text;
        }
    }
}
