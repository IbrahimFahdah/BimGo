import { clamp } from '../core/math/Vector';
import { CoordinateReadout } from '../core/scene/SiteCoordinates';
import { readJson, writeJson } from '../platform/settings';

/** Colour mode (port of ColourMode). */
export enum ColourMode {
  Whitecard = 0,
  Material = 1,
  Realistic = 2
}

/**
 * The walkthrough settings the web viewer keeps per browser (the subset of LaunchSettings that matters in the
 * viewer; defaults as on the desktop).
 */
export class ViewerSettings {
  colour = ColourMode.Whitecard;
  fieldOfView = 90;
  mouseSensitivity = 1;
  invertY = false;
  showFps = true;
  maxStepHeightMm = 200;
  coordinateReadout = CoordinateReadout.Off;
  /** Author shown on comments and bookmarks (the browser has no user name). */
  userName = 'Web user';

  get whitecard(): boolean {
    return this.colour === ColourMode.Whitecard;
  }

  static load(): ViewerSettings {
    const s = new ViewerSettings();
    const raw = readJson<Record<string, unknown>>('viewer', {});
    if (typeof raw.colour === 'number' && raw.colour >= 0 && raw.colour <= 2) { s.colour = raw.colour; }
    else if (raw.whitecard === false) { s.colour = ColourMode.Material; }
    if (typeof raw.fieldOfView === 'number') { s.fieldOfView = clamp(raw.fieldOfView, 60, 120); }
    if (typeof raw.mouseSensitivity === 'number') { s.mouseSensitivity = clamp(raw.mouseSensitivity, 0.1, 3); }
    if (typeof raw.invertY === 'boolean') { s.invertY = raw.invertY; }
    if (typeof raw.showFps === 'boolean') { s.showFps = raw.showFps; }
    if (typeof raw.coordinateReadout === 'number' && raw.coordinateReadout >= 0 && raw.coordinateReadout <= 3) {
      s.coordinateReadout = raw.coordinateReadout;
    }
    if (typeof raw.userName === 'string' && raw.userName.trim()) { s.userName = raw.userName.trim().slice(0, 40); }
    return s;
  }

  save(): void {
    writeJson('viewer', {
      colour: this.colour,
      fieldOfView: this.fieldOfView,
      mouseSensitivity: this.mouseSensitivity,
      invertY: this.invertY,
      showFps: this.showFps,
      coordinateReadout: this.coordinateReadout,
      userName: this.userName
    });
  }
}
