using BimGo.Native;

// The class belongs to the Rendering namespace
namespace BimGo.Rendering
{
    /// <summary>
    /// A linked GLSL program.
    /// </summary>
    internal sealed class ShaderProgram : IDisposable
    {
        /// <summary>The GL program id.</summary>
        public uint Id { get; private set; }

        /// <summary>A short name for error messages.</summary>
        public string Name { get; }

        private ShaderProgram(string name, uint id)
        {
            Name = name;
            Id = id;
        }

        /// <summary>
        /// Compiles and links a program. Throws with the driver's log on failure.
        /// </summary>
        /// <param name="name">A short name for messages.</param>
        /// <param name="vertexSource">GLSL vertex source.</param>
        /// <param name="fragmentSource">GLSL fragment source.</param>
        /// <returns>The program.</returns>
        public static ShaderProgram Create(string name, string vertexSource, string fragmentSource)
        {
            uint vs = Compile(name, Gl.VERTEX_SHADER, vertexSource);
            uint fs = Compile(name, Gl.FRAGMENT_SHADER, fragmentSource);

            uint program = Gl.CreateProgram();
            Gl.AttachShader(program, vs);
            Gl.AttachShader(program, fs);
            Gl.LinkProgram(program);
            Gl.DeleteShader(vs);
            Gl.DeleteShader(fs);

            if (Gl.GetProgram(program, Gl.LINK_STATUS) == 0)
            {
                string log = Gl.GetProgramInfoLog(program);
                Gl.DeleteProgram(program);
                throw new InvalidOperationException($"Shader '{name}' failed to link:\n{log}");
            }
            return new ShaderProgram(name, program);
        }

        /// <summary>
        /// Gets a uniform location (-1 if unused/optimised out, which GL ignores).
        /// </summary>
        public int Uniform(string uniformName) => Gl.GetUniformLocation(Id, uniformName);

        /// <summary>
        /// Makes this program current.
        /// </summary>
        public void Use() => Gl.UseProgram(Id);

        /// <summary>
        /// Deletes the program.
        /// </summary>
        public void Dispose()
        {
            Gl.DeleteProgram(Id);
            Id = 0;
        }

        private static uint Compile(string name, uint type, string source)
        {
            uint shader = Gl.CreateShader(type);
            Gl.ShaderSource(shader, source);
            Gl.CompileShader(shader);
            if (Gl.GetShader(shader, Gl.COMPILE_STATUS) == 0)
            {
                string log = Gl.GetShaderInfoLog(shader);
                Gl.DeleteShader(shader);
                string stage = type == Gl.VERTEX_SHADER ? "vertex" : "fragment";
                throw new InvalidOperationException($"Shader '{name}' ({stage}) failed to compile:\n{log}");
            }
            return shader;
        }
    }
}
