import { gl } from './Gl';

/**
 * A linked GLSL program.
 */
export class ShaderProgram {
  private constructor(
    /** A short name for error messages. */
    readonly name: string,
    /** The GL program. */
    public id: WebGLProgram | null
  ) {}

  /**
   * Compiles and links a program. Throws with the driver's log on failure.
   */
  static create(name: string, vertexSource: string, fragmentSource: string): ShaderProgram {
    const vs = compile(name, gl.VERTEX_SHADER, vertexSource);
    const fs = compile(name, gl.FRAGMENT_SHADER, fragmentSource);

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      throw new Error(`Shader '${name}' failed to link:\n${log}`);
    }
    return new ShaderProgram(name, program);
  }

  /** Gets a uniform location (null if unused / optimised out, which GL ignores). */
  uniform(uniformName: string): WebGLUniformLocation | null {
    return this.id ? gl.getUniformLocation(this.id, uniformName) : null;
  }

  /** Makes this program current. */
  use(): void {
    gl.useProgram(this.id);
  }

  /** Deletes the program. */
  dispose(): void {
    gl.deleteProgram(this.id);
    this.id = null;
  }
}

function compile(name: string, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) { throw new Error(`Shader '${name}': could not create a shader object.`); }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`Shader '${name}' (${stage}) failed to compile:\n${log}`);
  }
  return shader;
}
