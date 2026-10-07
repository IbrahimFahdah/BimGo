import { gl } from '../engine/gl/Gl';
import type { UiBatch } from '../engine/ui/UiBatch';
import { UiTheme } from '../engine/ui/UiTheme';
import type { InputState } from '../platform/input';

/** What a long operation reports to its progress screen (replaces OperationProgress.Read). */
export interface ProgressState {
  stage: string;
  detail: string;
  fraction: number;
  canCancel: boolean;
  cancelRequested: boolean;
}

/**
 * Draws one frame of the progress screen (port of BimGo.App/Game/ProgressScreen.cs). The browser can't block in a
 * loop, so the caller draws this every animation frame while its work runs.
 * @returns True when CANCEL was clicked.
 */
export function drawProgress(ui: UiBatch, width: number, height: number, title: string, progress: ProgressState, input: InputState): boolean {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, width, height);
  gl.clearColor(0.063, 0.075, 0.094, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const s = ui.scale;
  const f = ui.atlas;
  const cx = width * 0.5, cy = height * 0.5;

  ui.textCentred(f.title, cx, cy - 96 * s, 'BIMGO', UiTheme.TEXT, 4 * s);
  ui.textCentred(f.bold, cx, cy - 28 * s, title, UiTheme.TEXT, 0.5 * s);
  ui.textCentred(f.body, cx, cy + 2 * s, progress.cancelRequested ? 'Cancelling…' : progress.stage || 'Working…', UiTheme.TEXT_MUTED);

  // Bar
  const barW = Math.min(420 * s, width - 80 * s), barH = 8 * s;
  const barX = cx - barW * 0.5, barY = cy + 32 * s;
  ui.rect(barX, barY, barW, barH, UiTheme.CONTROL);
  ui.rect(barX, barY, barW * Math.min(Math.max(progress.fraction, 0), 1), barH, UiTheme.ACCENT);
  if (progress.detail) { ui.textCentred(f.small, cx, barY + barH + 10 * s, progress.detail, UiTheme.TEXT_FAINT, 0.4 * s); }

  // CANCEL (Esc)
  let clicked = false;
  if (progress.canCancel && !progress.cancelRequested) {
    const bw = 150 * s, bh = 34 * s;
    const bx = cx - bw * 0.5, by = barY + 52 * s;
    const hover = input.mouseX >= bx && input.mouseX < bx + bw && input.mouseY >= by && input.mouseY < by + bh;
    ui.panel(bx, by, bw, bh, hover ? UiTheme.CONTROL_BORDER : UiTheme.CONTROL, UiTheme.CONTROL_BORDER);
    ui.textCentred(f.body, cx, by + bh * 0.5 - f.body.lineHeight * 0.5, 'CANCEL  (ESC)', UiTheme.TEXT);
    clicked = hover && input.leftPressed;
  }

  ui.flush(width, height);
  return clicked;
}
