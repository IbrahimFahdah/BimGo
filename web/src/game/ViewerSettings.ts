import { clamp } from '../core/math/Vector';
import { readJson, writeJson } from '../platform/settings';

/**
 * The walkthrough settings the web viewer keeps per browser (the subset of LaunchSettings that matters in the
 * viewer; defaults as on the desktop).
 */
export class ViewerSettings {
  whitecard = true;
  fieldOfView = 90;
  mouseSensitivity = 1;
  invertY = false;
  showFps = true;
  maxStepHeightMm = 200;

  static load(): ViewerSettings {
    const s = new ViewerSettings();
    const raw = readJson<Record<string, unknown>>('viewer', {});
    if (typeof raw.whitecard === 'boolean') { s.whitecard = raw.whitecard; }
    if (typeof raw.fieldOfView === 'number') { s.fieldOfView = clamp(raw.fieldOfView, 60, 120); }
    if (typeof raw.mouseSensitivity === 'number') { s.mouseSensitivity = clamp(raw.mouseSensitivity, 0.1, 5); }
    if (typeof raw.invertY === 'boolean') { s.invertY = raw.invertY; }
    if (typeof raw.showFps === 'boolean') { s.showFps = raw.showFps; }
    return s;
  }

  save(): void {
    writeJson('viewer', {
      whitecard: this.whitecard,
      fieldOfView: this.fieldOfView,
      mouseSensitivity: this.mouseSensitivity,
      invertY: this.invertY,
      showFps: this.showFps
    });
  }

  toggleWhitecard(): void {
    this.whitecard = !this.whitecard;
    this.save();
  }
}
