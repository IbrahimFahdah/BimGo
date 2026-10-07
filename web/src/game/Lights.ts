import { Mat4 } from '../core/math/Matrix4x4';
import { type Vec3, vec3 } from '../core/math/Vector';
import { kelvinToRgb } from '../core/scene/LightingData';
import type { SceneData } from '../core/scene/SceneData';
import type { DynamicSet } from '../engine/physics/DynamicSet';
import type { FpsCamera } from '../engine/render/FpsCamera';
import { ArtificialLighting } from '../engine/render/LightShadows';
import { SceneBatches } from '../engine/render/SceneBatches';
import { smoothStep, type SunLighting } from '../engine/render/SunLighting';

/** Artificial light mode (port of ArtificialLightMode). */
export enum LightMode {
  Off = 0,
  Glow = 1,
  Lights = 2
}

/** 100 lx ≈ full albedo: lumens → the shader's light units. */
const LIGHT_SCALE = 1 / (4 * Math.PI) / 100;

/**
 * Picks the nearest lights in view each frame and fills the renderer's light list (port of
 * BimGo.App/Game/GameSession.Lights.cs). Moved and cloned fixtures carry their light with them.
 */
export class Lights {
  private readonly colour: Vec3[];
  private readonly radius: Float32Array;
  private readonly pickLight = new Int32Array(ArtificialLighting.MAX_LIGHTS);
  private readonly pickDistance = new Float32Array(ArtificialLighting.MAX_LIGHTS);
  private readonly pickPosition: Vec3[] = Array.from({ length: ArtificialLighting.MAX_LIGHTS }, () => vec3());
  private readonly pickKey = new Float64Array(ArtificialLighting.MAX_LIGHTS);
  private readonly lightOfElement = new Map<number, number>();
  private readonly viewPlanes = new Float32Array(24);
  private pickCount = 0;
  private candidateCount = 0;

  constructor(private readonly scene: SceneData) {
    const lights = scene.lighting.lights;
    this.colour = lights.map(l => {
      const c = kelvinToRgb(l.kelvin), s = l.lumens * LIGHT_SCALE;
      return vec3(c.x * s, c.y * s, c.z * s);
    });
    this.radius = Float32Array.from(lights, l => Math.min(Math.max(Math.sqrt(l.lumens) * 0.16, 2.5), 9));
    lights.forEach((l, i) => { if (!this.lightOfElement.has(l.element)) { this.lightOfElement.set(l.element, i); } });
  }

  get hasAny(): boolean {
    return this.scene.lighting.lights.length > 0 || this.scene.lighting.emissive.length > 0;
  }

  /** Fills the light list for this frame. */
  update(a: ArtificialLighting, mode: LightMode, intensity: number, bloomIntensity: number, bloomFailed: boolean,
    sun: SunLighting, camera: FpsCamera, groupVisible: boolean[], userHidden: boolean[], hidden: boolean[], dynamics: DynamicSet): void {
    a.clear();
    if (mode === LightMode.Off || !this.hasAny) { return; }

    // How much the sun drowns the fixtures out (the classic light sits in between)
    const day = sun.enabled ? smoothStep(-6, 25, sun.altitudeDegrees) : 0.6;
    const brightness = Math.min(Math.max(intensity, 0), 2);
    const glow = (0.5 + 0.5 * brightness) * lerp(1, 0.6, day);
    a.emissive = glow;
    a.bloom = bloomFailed ? 0 : 0.9 * glow * Math.min(Math.max(bloomIntensity, 0), 2);
    if (mode !== LightMode.Lights || this.scene.lighting.lights.length === 0) { return; }

    const scale = brightness * lerp(1, 0.35, day);
    if (scale <= 0) { return; }
    this.pick(camera, groupVisible, userHidden, hidden, dynamics);

    // Fade the farthest picked lights when some were left out
    let fadeFrom = Number.MAX_VALUE, fadeTo = Number.MAX_VALUE;
    if (this.candidateCount > this.pickCount && this.pickCount > 0) {
      fadeTo = this.pickDistance[this.pickCount - 1];
      fadeFrom = fadeTo * 0.7;
    }

    const lights = this.scene.lighting.lights;
    for (let k = 0; k < this.pickCount; k++) {
      const i = this.pickLight[k];
      const fade = 1 - smoothStep(fadeFrom, fadeTo, this.pickDistance[k]);
      const p = this.pickPosition[k], c = this.colour[i];
      a.position.set([p.x, p.y, p.z, this.radius[i]], k * 4);
      a.colour.set([c.x * scale, c.y * scale, c.z * scale, lights[i].downward], k * 4);
      a.shadow.set([-1, fade, 0, 0], k * 4);
      a.key[k] = this.pickKey[k];
    }
    a.count = this.pickCount;
  }

  private pick(camera: FpsCamera, groupVisible: boolean[], userHidden: boolean[], hidden: boolean[], dynamics: DynamicSet): void {
    this.pickCount = 0;
    this.candidateCount = 0;

    // Normalised view planes (sphere tests)
    for (let p = 0; p < 24; p += 4) {
      const pl = camera.planes, l = Math.hypot(pl[p], pl[p + 1], pl[p + 2]);
      for (let k = 0; k < 4; k++) { this.viewPlanes[p + k] = l > 1e-8 ? pl[p + k] / l : pl[p + k]; }
    }

    const lights = this.scene.lighting.lights, elements = this.scene.elements;
    for (let i = 0; i < lights.length; i++) {
      const e = lights[i].element;
      if (userHidden[e] || !groupVisible[SceneBatches.groupOf(elements[e])]) { continue; }
      if (!hidden[e]) {
        this.consider(i, lights[i].position, camera.position, i);
        continue;
      }
      // Hidden in the static scene: moved (follow it) or removed (dark)
      const moved = dynamics.findOriginal(e);
      if (!moved || !dynamics.isActive(moved)) { continue; }
      this.consider(i, Mat4.transformPoint(lights[i].position, moved.model), camera.position, moved.id * 0x100000 + i);
    }
    for (const instance of dynamics.instances) {
      if (!instance.isClone || !dynamics.isActive(instance)) { continue; }
      const i = this.lightOfElement.get(instance.element);
      if (i === undefined) { continue; }
      this.consider(i, Mat4.transformPoint(lights[i].position, instance.model), camera.position, instance.id * 0x100000 + i);
    }
  }

  private consider(light: number, position: Vec3, eye: Vec3, key: number): void {
    const radius = this.radius[light], planes = this.viewPlanes;
    for (let p = 0; p < 24; p += 4) {
      if (planes[p] * position.x + planes[p + 1] * position.y + planes[p + 2] * position.z + planes[p + 3] < -radius) { return; }
    }
    this.candidateCount++;

    const distance = Math.hypot(position.x - eye.x, position.y - eye.y, position.z - eye.z);
    const max = ArtificialLighting.MAX_LIGHTS;
    if (this.pickCount === max && distance >= this.pickDistance[max - 1]) { return; }

    // Insertion into the sorted list (nearest first), dropping the farthest when full
    let slot = Math.min(this.pickCount, max - 1);
    while (slot > 0 && this.pickDistance[slot - 1] > distance) {
      this.pickLight[slot] = this.pickLight[slot - 1];
      this.pickDistance[slot] = this.pickDistance[slot - 1];
      this.pickPosition[slot] = this.pickPosition[slot - 1];
      this.pickKey[slot] = this.pickKey[slot - 1];
      slot--;
    }
    this.pickLight[slot] = light;
    this.pickDistance[slot] = distance;
    this.pickPosition[slot] = position;
    this.pickKey[slot] = key;
    if (this.pickCount < max) { this.pickCount++; }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
