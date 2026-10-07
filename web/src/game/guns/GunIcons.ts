import { Rgba } from '../../engine/ui/Rgba';
import type { UiBatch } from '../../engine/ui/UiBatch';

const TAU = Math.PI * 2;

/** The gun bar icons, drawn with UI shapes on a 24-unit grid (port of BimGo.App/Game/Guns/GunIcons.cs). */
export const GunIcons = {
  scan(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void {
    const u = size / 24, w = 2 * u;
    ui.ring(cx, cy, 6.5 * u, w, colour, 28);
    ui.line(cx, cy - 11 * u, cx, cy - 7.5 * u, w, colour);
    ui.line(cx, cy + 7.5 * u, cx, cy + 11 * u, w, colour);
    ui.line(cx - 11 * u, cy, cx - 7.5 * u, cy, w, colour);
    ui.line(cx + 7.5 * u, cy, cx + 11 * u, cy, w, colour);
    ui.circle(cx, cy, 1.8 * u, colour, 10);
  },

  measure(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void {
    const u = size / 24, w = 2 * u;
    ui.line(cx - 10 * u, cy - 7 * u, cx - 10 * u, cy + 7 * u, w, colour);
    ui.line(cx + 10 * u, cy - 7 * u, cx + 10 * u, cy + 7 * u, w, colour);
    ui.line(cx - 7 * u, cy, cx + 7 * u, cy, w, colour);
    arrowhead(ui, cx - 8.5 * u, cy, -1, 0, 4.5 * u, colour);
    arrowhead(ui, cx + 8.5 * u, cy, 1, 0, 4.5 * u, colour);
    for (let i = -1; i <= 1; i++) { ui.line(cx + i * 4 * u, cy - 4 * u, cx + i * 4 * u, cy - 2 * u, 1.4 * u, colour); }
  },

  portal(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void {
    const u = size / 24;
    ellipseFill(ui, cx, cy, 4.5 * u, 8 * u, Rgba.withAlpha(colour, 0.25));
    ellipseRing(ui, cx, cy, 6.5 * u, 10.5 * u, 2.2 * u, colour);
    ellipseRing(ui, cx, cy, 3.5 * u, 6.5 * u, 1.3 * u, Rgba.withAlpha(colour, 0.7));
  },

  comment(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void {
    const u = size / 24, w = 2 * u;
    const left = cx - 10 * u, right = cx + 10 * u, top = cy - 8 * u, bottom = cy + 5 * u;
    ui.line(left, top, right, top, w, colour);
    ui.line(right, top - u, right, bottom + u, w, colour);
    ui.line(left, top - u, left, bottom + u, w, colour);
    ui.line(left, bottom, cx - 3 * u, bottom, w, colour);
    ui.line(cx + 1 * u, bottom, right, bottom, w, colour);
    ui.line(cx - 3 * u, bottom, cx - 5 * u, cy + 10 * u, w, colour);
    ui.line(cx - 5 * u, cy + 10 * u, cx + 1.5 * u, bottom - 0.5 * u, w, colour);
    for (let i = -1; i <= 1; i++) { ui.circle(cx + i * 4.5 * u, cy - 1.5 * u, 1.5 * u, colour, 8); }
  },

  teleport(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void {
    const u = size / 24, w = 2 * u;
    ellipseFill(ui, cx + 4 * u, cy + 7.5 * u, 6.5 * u, 2.6 * u, Rgba.withAlpha(colour, 0.3));
    ellipseRing(ui, cx + 4 * u, cy + 7.5 * u, 7 * u, 3 * u, 1.6 * u, colour);

    // Parabolic arc from lower left to the disc
    const arc = (t: number): [number, number] => [cx - 10 * u + t * 14 * u, cy + 4 * u - 4 * 13 * u * t * (1 - t) + t * 1.5 * u];
    let previous = arc(0);
    for (let i = 1; i <= 10; i++) {
      const next = arc(i / 10);
      ui.line(previous[0], previous[1], next[0], next[1], w, colour);
      previous = next;
    }
    const end = arc(1), before = arc(0.88);
    const dx = end[0] - before[0], dy = end[1] - before[1], l = Math.hypot(dx, dy) || 1;
    arrowhead(ui, end[0], end[1], dx / l, dy / l, 5 * u, colour);
  },

  hammer(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void {
    const u = size / 24;
    const ax = Math.SQRT1_2, ay = -Math.SQRT1_2, sx = -ay, sy = ax;
    ui.line(cx - ax * 10 * u, cy - ay * 10 * u, cx + ax * 4 * u, cy + ay * 4 * u, 2.6 * u, colour);
    const hx = cx + ax * 6 * u, hy = cy + ay * 6 * u;
    const corner = (s: number, a: number): [number, number] => [hx + sx * s * 7 * u + ax * a * 3 * u, hy + sy * s * 7 * u + ay * a * 3 * u];
    const [h0, h1, h2, h3] = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    ui.triangle(h0[0], h0[1], h1[0], h1[1], h2[0], h2[1], colour);
    ui.triangle(h0[0], h0[1], h2[0], h2[1], h3[0], h3[1], colour);
    ui.line(cx - 9 * u, cy - 4 * u, cx - 6 * u, cy - 6 * u, 1.4 * u, Rgba.withAlpha(colour, 0.7));
    ui.line(cx - 10 * u, cy, cx - 7 * u, cy, 1.4 * u, Rgba.withAlpha(colour, 0.7));
  },

  gizmo(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void {
    const u = size / 24, w = 2 * u;
    ui.line(cx - 6 * u, cy, cx + 6 * u, cy, w, colour);
    ui.line(cx, cy - 6 * u, cx, cy + 6 * u, w, colour);
    arrowhead(ui, cx + 6.5 * u, cy, 1, 0, 3.6 * u, colour);
    arrowhead(ui, cx - 6.5 * u, cy, -1, 0, 3.6 * u, colour);
    arrowhead(ui, cx, cy - 6.5 * u, 0, -1, 3.6 * u, colour);
    arrowhead(ui, cx, cy + 6.5 * u, 0, 1, 3.6 * u, colour);
    const r = 10.5 * u, start = -Math.PI * 0.15, end = start + Math.PI * 1.45;
    arcStroke(ui, cx, cy, r, start, end, 1.6 * u, Rgba.withAlpha(colour, 0.85));
    arrowhead(ui, cx + Math.cos(end) * r, cy + Math.sin(end) * r, -Math.sin(end), Math.cos(end), 3.4 * u, Rgba.withAlpha(colour, 0.85));
  },

  clone(ui: UiBatch, cx: number, cy: number, size: number, colour: number): void {
    const u = size / 24, w = 2 * u;
    ui.outline(cx - 10 * u, cy - 10 * u, 13 * u, 13 * u, w, Rgba.withAlpha(colour, 0.6));
    ui.rect(cx - 3 * u, cy - 3 * u, 13 * u, 13 * u, Rgba.withAlpha(colour, 0.22));
    ui.outline(cx - 3 * u, cy - 3 * u, 13 * u, 13 * u, w, colour);
    ui.line(cx + 3.5 * u, cy + 0.5 * u, cx + 3.5 * u, cy + 6.5 * u, w, colour);
    ui.line(cx + 0.5 * u, cy + 3.5 * u, cx + 6.5 * u, cy + 3.5 * u, w, colour);
  }
};

export function arrowhead(ui: UiBatch, x: number, y: number, dx: number, dy: number, length: number, colour: number): void {
  const nx = -dy, ny = dx;
  const bx = x - dx * length, by = y - dy * length;
  const half = length * 0.6;
  ui.triangle(x, y, bx + nx * half, by + ny * half, bx - nx * half, by - ny * half, colour);
}

export function ellipseRing(ui: UiBatch, cx: number, cy: number, rx: number, ry: number, thickness: number, colour: number, segments = 28): void {
  const h = thickness * 0.5;
  for (let i = 0; i < segments; i++) {
    const a0 = i * TAU / segments, a1 = (i + 1) * TAU / segments;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const ix0 = cx + c0 * (rx - h), iy0 = cy + s0 * (ry - h), ox0 = cx + c0 * (rx + h), oy0 = cy + s0 * (ry + h);
    const ix1 = cx + c1 * (rx - h), iy1 = cy + s1 * (ry - h), ox1 = cx + c1 * (rx + h), oy1 = cy + s1 * (ry + h);
    ui.triangle(ix0, iy0, ox0, oy0, ox1, oy1, colour);
    ui.triangle(ix0, iy0, ox1, oy1, ix1, iy1, colour);
  }
}

export function ellipseFill(ui: UiBatch, cx: number, cy: number, rx: number, ry: number, colour: number, segments = 24): void {
  let px = cx + rx, py = cy;
  for (let i = 1; i <= segments; i++) {
    const a = i * TAU / segments;
    const nx = cx + Math.cos(a) * rx, ny = cy + Math.sin(a) * ry;
    ui.triangle(cx, cy, px, py, nx, ny, colour);
    px = nx;
    py = ny;
  }
}

export function arcStroke(ui: UiBatch, cx: number, cy: number, r: number, start: number, end: number, thickness: number, colour: number, segments = 20): void {
  const step = (end - start) / segments, h = thickness * 0.5;
  for (let i = 0; i < segments; i++) {
    const a0 = start + i * step, a1 = a0 + step;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    ui.triangle(cx + c0 * (r - h), cy + s0 * (r - h), cx + c0 * (r + h), cy + s0 * (r + h), cx + c1 * (r + h), cy + s1 * (r + h), colour);
    ui.triangle(cx + c0 * (r - h), cy + s0 * (r - h), cx + c1 * (r + h), cy + s1 * (r + h), cx + c1 * (r - h), cy + s1 * (r - h), colour);
  }
}
