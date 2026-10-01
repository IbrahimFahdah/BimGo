// The class belongs to the Rendering namespace
namespace RvtGo.Rendering
{
    /// <summary>
    /// GLSL sources (330 core, runs on GL 3.3 and 4.x core contexts).
    /// Matrices are uploaded straight from System.Numerics, so "M * v" in GLSL matches "v * M" in C#.
    /// </summary>
    internal static class Shaders
    {
        #region Scene (static batches)

        public const string SCENE_VS = @"#version 330 core
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out vec4 vColor;
void main()
{
    vWorld = aPos;
    vNormal = aNormal;
    vColor = aColor;
    gl_Position = uViewProj * vec4(aPos, 1.0);
}";

        public const string SCENE_FS = @"#version 330 core
in vec3 vWorld;
in vec3 vNormal;
in vec4 vColor;
uniform vec3 uEye;
uniform vec3 uLightDir;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform int uWhitecard;
uniform int uPlan;
uniform vec2 uClipZ;
uniform vec4 uOverride;
out vec4 oColor;
void main()
{
    if (vWorld.z < uClipZ.x || vWorld.z > uClipZ.y) discard;

    vec4 base = vColor;
    if (uWhitecard == 1)
    {
        float l = dot(base.rgb, vec3(0.299, 0.587, 0.114));
        base.rgb = base.a < 0.98 ? vec3(0.76, 0.82, 0.87) : vec3(0.80 + 0.12 * l);
    }

    vec3 n = normalize(vNormal);

    if (uPlan == 1)
    {
        // Top-down plan: looking into a cut solid shows its inside (back faces) = poche
        if (!gl_FrontFacing) { oColor = vec4(0.90, 0.91, 0.93, 1.0); return; }
        float up = clamp(n.z, 0.0, 1.0);
        oColor = vec4(base.rgb * (0.30 + 0.22 * up), 1.0);
        return;
    }

    if (!gl_FrontFacing) n = -n;
    float diffuse = max(dot(n, uLightDir), 0.0);
    float hemi = 0.5 + 0.5 * n.z;
    vec3 lit = base.rgb * (0.40 + 0.20 * hemi + 0.45 * diffuse);

    float d = length(vWorld - uEye);
    float fog = clamp(1.0 - exp(-d * uFogDensity), 0.0, 0.65);
    lit = mix(lit, uFogColor, fog);

    vec4 result = vec4(lit, base.a);
    if (uOverride.a > 0.0)
    {
        result.rgb = mix(result.rgb, uOverride.rgb, uOverride.a);
        result.a = max(result.a, 0.85);
    }
    oColor = result;
}";

        #endregion

        #region Sky and ground

        public const string FULLSCREEN_VS = @"#version 330 core
out vec2 vNdc;
void main()
{
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
    vNdc = p;
    gl_Position = vec4(p, 0.0, 1.0);
}";

        public const string SKY_FS = @"#version 330 core
in vec2 vNdc;
uniform mat4 uInvViewProj;
uniform vec3 uEye;
out vec4 oColor;
void main()
{
    vec4 far = uInvViewProj * vec4(vNdc, 1.0, 1.0);
    vec3 dir = normalize(far.xyz / far.w - uEye);
    float h = dir.z;
    vec3 zenith = vec3(0.34, 0.50, 0.70);
    vec3 horizon = vec3(0.80, 0.85, 0.89);
    vec3 ground = vec3(0.46, 0.48, 0.50);
    vec3 c = h >= 0.0
        ? mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55))
        : mix(horizon * 0.88, ground, clamp(-h * 5.0, 0.0, 1.0));
    float line = 1.0 - smoothstep(0.0, 0.0035, abs(h));
    c = mix(c, vec3(0.55, 0.60, 0.66), line * 0.7);
    oColor = vec4(c, 1.0);
}";

        public const string GROUND_VS = @"#version 330 core
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform float uHalf;
out vec3 vWorld;
const vec2 CORNERS[6] = vec2[6](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0));
void main()
{
    vec3 w = vec3(uCenter.xy + CORNERS[gl_VertexID] * uHalf, uCenter.z);
    vWorld = w;
    gl_Position = uViewProj * vec4(w, 1.0);
}";

        public const string GROUND_FS = @"#version 330 core
in vec3 vWorld;
uniform vec3 uEye;
uniform vec3 uFogColor;
out vec4 oColor;
float gridLine(vec2 p, float spacing)
{
    vec2 q = p / spacing;
    vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-4));
    return 1.0 - min(min(g.x, g.y), 1.0);
}
void main()
{
    float d = length(vWorld.xy - uEye.xy);
    float minor = gridLine(vWorld.xy, 1.0) * (1.0 - smoothstep(25.0, 90.0, d));
    float major = gridLine(vWorld.xy, 10.0) * (1.0 - smoothstep(150.0, 600.0, d));
    vec3 c = vec3(0.57, 0.59, 0.61) * (1.0 - 0.10 * minor - 0.20 * major);
    c = mix(c, uFogColor, clamp(d / 1200.0, 0.0, 1.0));
    oColor = vec4(c, 1.0);
}";

        #endregion

        #region Overlay and UI

        public const string OVERLAY_VS = @"#version 330 core
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColor;
uniform mat4 uViewProj;
out vec4 vColor;
void main()
{
    vColor = aColor;
    gl_Position = uViewProj * vec4(aPos, 1.0);
}";

        public const string OVERLAY_FS = @"#version 330 core
in vec4 vColor;
uniform float uAlpha;
out vec4 oColor;
void main()
{
    oColor = vec4(vColor.rgb, vColor.a * uAlpha);
}";

        public const string UI_VS = @"#version 330 core
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
uniform vec2 uScreen;
out vec2 vUv;
out vec4 vColor;
void main()
{
    vUv = aUv;
    vColor = aColor;
    gl_Position = vec4(aPos.x / uScreen.x * 2.0 - 1.0, 1.0 - aPos.y / uScreen.y * 2.0, 0.0, 1.0);
}";

        public const string UI_FS = @"#version 330 core
in vec2 vUv;
in vec4 vColor;
uniform sampler2D uAtlas;
out vec4 oColor;
void main()
{
    oColor = vColor * texture(uAtlas, vUv);
}";

        #endregion
    }
}
