/**
 * GLSL ES 3.00 sources, ported from BimGo.App/Rendering/Shaders.cs (GLSL 330 core).
 * Port rule: swap the #version line, add precision, keep the bodies identical so diffs against upstream stay small.
 */

const HEADER = `#version 300 es
precision highp float;
precision highp int;
`;

// #region UI

export const UI_VS = HEADER + `layout(location = 0) in vec2 aPos;
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
}`;

export const UI_FS = HEADER + `in vec2 vUv;
in vec4 vColor;
uniform sampler2D uAtlas;
out vec4 oColor;
void main()
{
    oColor = vColor * texture(uAtlas, vUv);
}`;

// #endregion
