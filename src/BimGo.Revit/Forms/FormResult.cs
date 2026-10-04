// The class belongs to the Forms namespace
namespace BimGo.Forms
{
    /// <summary>
    /// A class for holding form outcomes, used by custom forms.
    /// </summary>
    /// <typeparam name="T">The type of object being stored.</typeparam>
    public class FormResult<T>
    {
        /// <summary>
        /// Returned objects from the form.
        /// </summary>
        public List<T> Objects { get; set; }

        /// <summary>
        /// Returned object from the form.
        /// </summary>
        public T Object { get; set; }

        /// <summary>
        /// Was the form cancelled.
        /// </summary>
        public bool Cancelled { get; set; }

        /// <summary>
        /// Was the outcome of the form valid.
        /// </summary>
        public bool Valid { get; set; }

        /// <summary>
        /// Was the outcome of the form affirmative.
        /// </summary>
        public bool Affirmative { get; set; }

        /// <summary>
        /// Default constructor
        /// </summary>
        public FormResult() { }

        /// <summary>
        /// Constructor to begin a FormResult.
        /// </summary>
        /// <param name="valid">Should the result begin as valid.</param>
        public FormResult(bool valid)
        {
            Objects = new List<T>();
            Object = default;
            Cancelled = !valid;
            Valid = valid;
            Affirmative = valid;
        }

        /// <summary>
        /// Sets all dialog related results to valid.
        /// </summary>
        public void Validate()
        {
            Cancelled = false;
            Valid = true;
            Affirmative = true;
        }

        /// <summary>
        /// Sets the dialog result to valid, passing an object.
        /// </summary>
        /// <param name="obj">Object to pass to result.</param>
        public void Validate(T obj)
        {
            this.Validate();
            this.Object = obj;
        }

        /// <summary>
        /// Sets the dialog result to valid, passing a list of objects.
        /// </summary>
        /// <param name="objs">Objects to pass to result.</param>
        public void Validate(List<T> objs)
        {
            this.Validate();
            this.Objects = objs;
        }
    }
}