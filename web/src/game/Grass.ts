import type { Matrix4x4 } from '../core/math/Matrix4x4';
import { GrassField } from '../core/scene/GrassField';
import { MaterialOverrides } from '../core/scene/MaterialOverrides';
import { SceneBatches } from '../engine/render/SceneBatches';
import type { SceneDrawParams } from '../engine/render/SceneRenderer';
import type { GameSession } from './GameSession';
import { ColourMode } from './ViewerSettings';

/** A changed scene waits this long (s) before the field is rebuilt (a drag is one change). */
const GRASS_SETTLE = 0.75;

const yieldToPage = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Grass round (build B; port of GameSession.Grass.cs): grass blades on the grass materials in the Realistic mode. The
 * grass field (where grass grows, seen from above) is built in slices on the main thread the first time it's needed and
 * again when the keywords or (P-C) the visible scene change; the renderer draws the blades from it each frame.
 */
export class Grass {
  private builtFor: string | null = null;
  private task: Promise<GrassField> | null = null;
  private taskDone = false;
  private taskResult: GrassField | null = null;
  private taskFailed: unknown = null;
  private taskFor: string | null = null;
  private abort: AbortController | null = null;
  private field: GrassField = GrassField.EMPTY;
  private error: string | null = null;
  private builtScene = -1;
  private taskScene = -1;
  private seenScene = -1;
  private sceneChangedAt = -1;

  constructor(private readonly session: GameSession) {}

  /** True when blades should show this frame (and the field is worth building). */
  private get wanted(): boolean {
    const v = this.session.settings;
    return v.grassBlades && v.colour === ColourMode.Realistic && this.session.renderer.hasMaterials && this.error === null;
  }

  private currentKey(): string { return MaterialOverrides.formatKeywords(this.session.settings.grassKeywords); }

  /** Once a frame: starts a build when the field is missing or stale, and uploads a finished one. */
  update(): void {
    if (!this.wanted && this.task === null) { return; }
    const session = this.session;
    if (this.task !== null && this.taskDone) {
      const doneFor = this.taskFor, result = this.taskResult, failed = this.taskFailed;
      this.task = null;
      this.taskFor = null;
      this.abort = null;
      if (failed !== null) {
        this.error = 'Grass blades could not be placed (see the console).';
        console.warn('Grass field failed:', failed);
        session.toast(this.error, 5, true);
      } else if (result && doneFor === this.currentKey()) {
        this.field = result;
        this.builtFor = doneFor;
        this.builtScene = this.taskScene;
        const error = session.renderer.setGrassField(this.field);
        if (error) {
          this.error = error;
          session.toast(error, 6, true);
        }
      }
    }
    if (!this.wanted) { return; }
    const key = this.currentKey();
    const sceneKey = session.sceneKey;
    if (sceneKey !== this.seenScene) {
      this.seenScene = sceneKey;
      this.sceneChangedAt = session.clock;
    }
    const sceneSettled = this.sceneChangedAt < 0 || (session.clock - this.sceneChangedAt > GRASS_SETTLE && !session.activeGunCapturesInput);
    const sceneStale = sceneKey !== this.builtScene && sceneSettled && this.builtFor !== null;
    if (key === this.builtFor && !sceneStale) { return; }
    if (this.task !== null) {
      if (this.taskFor !== key || (sceneSettled && this.taskScene !== sceneKey)) { this.abort?.abort(); }
      return;
    }
    if (!sceneSettled && this.builtFor !== null) { return; }

    // Start a build (visibility and copies are snapshots)
    const keywords = [...session.settings.grassKeywords];
    const visible = session.grassVisibility();
    const instances = session.dynamics.instances.filter(i => session.dynamics.isActive(i)).map(i => ({ element: i.element, model: i.model as Matrix4x4 }));
    const abort = new AbortController();
    this.abort = abort;
    this.taskFor = key;
    this.taskScene = sceneKey;
    this.sceneChangedAt = -1;
    this.taskDone = false;
    this.taskResult = null;
    this.taskFailed = null;
    this.task = GrassField.build(session.scene, keywords, visible, instances, yieldToPage, abort.signal);
    this.task.then(field => { this.taskResult = abort.signal.aborted ? null : field; this.taskDone = true; },
      e => { this.taskFailed = e ?? 'failed'; this.taskDone = true; });
  }

  /** Draws the blades (main view: after the opaque scene and the ground). */
  draw(p: SceneDrawParams): void {
    const renderer = this.session.renderer, v = this.session.settings;
    renderer.probeGrass = false;
    if (!this.wanted || !renderer.hasGrass || this.builtFor !== this.currentKey()) { return; }
    renderer.probeGrass = true; // P-C: reflection probes capture the blades too
    renderer.grass = { density: v.grassDensity, height: v.grassHeightMm / 1000, distance: v.grassDistance, sway: v.grassSway };
    renderer.drawGrass(p);
  }

  /** The GRASS page's status line. */
  status(): string {
    const session = this.session, v = session.settings;
    if (this.error) { return this.error; }
    if (!session.renderer.hasMaterials) { return 'Needs a file with materials (tick Extract materials and textures in Revit).'; }
    if (v.colour !== ColourMode.Realistic) { return 'Shows in the Realistic colour mode.'; }
    if (!v.grassBlades) { return 'Off.'; }
    if (this.task !== null || this.builtFor !== this.currentKey()) { return 'Finding the grass…'; }
    if (this.field.isEmpty) { return 'No upward surfaces with a grass material: check the keywords against the material names.'; }
    const area = this.field.grassCells * this.field.cell * this.field.cell;
    const n = this.field.colours.length;
    return `${Math.round(area).toLocaleString('en')} m² of grass in ${n} ${n === 1 ? 'material' : 'materials'}. Blades near you only; the surface's texture carries on beyond.`;
  }

  /** Grass in a scene batch group (for the visibility snapshot). */
  static groupOf = SceneBatches.groupOf;
}
