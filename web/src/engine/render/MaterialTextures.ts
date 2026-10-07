import type { MaterialData, SceneMaterial } from '../../core/scene/MaterialData';
import { type Vec3, vec3 } from '../../core/math/Vector';
import { caps, gl } from '../gl/Gl';
import { ProxyPack } from './ProxyPack';

/**
 * Realistic-mode material data on the GPU (port of BimGo.App/Rendering/MaterialTextures.cs): a table of five RGBA32F
 * texels per material read with texelFetch, and the images in one texture array per size bucket (256 … 2048).
 * Images are decoded by the browser (createImageBitmap) instead of GDI+, onto white like the desktop, and uploaded RGBA.
 */
export class MaterialTextures {
  static readonly TABLE_UNIT = 6;
  static readonly BUCKET_UNIT = 7;
  static readonly BUCKETS = [256, 512, 1024, 2048];
  private static readonly TEXELS = 5;
  private static readonly PROXY_CAP = 512;
  private static readonly FLAG_INVERT = 1;
  private static readonly FLAG_PROXY = 2;

  /** Proxies take the material's colour (their pattern keeps its contrast). */
  proxyMaterialColour = true;

  private table: WebGLTexture | null = null;
  private readonly arrays: (WebGLTexture | null)[] = [null, null, null, null];
  private generation = 0;

  materialCount = 0;
  imageCount = 0;
  proxyCount = 0;
  gpuBytes = 0;

  get ready(): boolean { return this.table !== null; }

  /**
   * Builds the table and arrays (a rebuild starts clean). Decoding is asynchronous; a newer call supersedes an older
   * one still running.
   * @returns Null, or a short warning for the user.
   */
  async initialise(materials: MaterialData, proxies: ProxyPack | null, autoProxy: boolean): Promise<string | null> {
    if (materials.materials.length === 0 || materials.vertexMaterial.length === 0) { return null; }
    const generation = ++this.generation;
    let warning: string | null = null;
    try {
      const maxLayers = Math.max(64, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number);
      const maxSize = Math.max(1024, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
      const table = materials.materials;

      // Each material's image key: its embedded image, else "proxy:<keyword>" (null = plain colour)
      const keys: (string | null)[] = new Array(table.length).fill(null);
      const proxyOf: (string | null)[] = new Array(table.length).fill(null);
      table.forEach((m, i) => {
        if (m.texture !== null && materials.textures.has(m.texture)) { keys[i] = m.texture; return; }
        const proxy = proxies ? ProxyPack.effectiveProxy(m, materials, autoProxy) : null;
        if (proxy && proxies?.has(proxy)) {
          keys[i] = 'proxy:' + proxy;
          proxyOf[i] = proxy;
        }
      });

      // Decode each referenced image once and choose its bucket
      const placements = new Map<string, [number, number]>();
      const averages = new Map<string, Vec3>();
      const pending: HTMLCanvasElement[][] = MaterialTextures.BUCKETS.map(() => []);
      for (let i = 0; i < keys.length; i++) {
        const name = keys[i];
        if (name === null || placements.has(name)) { continue; }
        const bytes = proxyOf[i] !== null ? await proxies!.imageBytes(proxyOf[i]!) : materials.textures.get(name)!;
        if (generation !== this.generation) { return null; }
        if (!bytes) { continue; }

        const bitmap = await decode(bytes);
        if (generation !== this.generation) { bitmap?.close(); return null; }
        if (!bitmap) { continue; }
        const cap = proxyOf[i] !== null ? Math.min(MaterialTextures.PROXY_CAP, maxSize) : Math.min(materials.textureMaxSize, maxSize);
        let bucket = bucketFor(Math.min(Math.max(bitmap.width, bitmap.height), cap), cap);
        while (bucket >= 0 && pending[bucket].length >= maxLayers) { bucket--; }
        if (bucket < 0) {
          warning = 'Some textures were left out (too many for this graphics card).';
          bitmap.close();
          continue;
        }

        const canvas = squareOnWhite(bitmap, MaterialTextures.BUCKETS[bucket]);
        bitmap.close();
        if (proxyOf[i] !== null) { averages.set(name, average(canvas)); }
        placements.set(name, [bucket, pending[bucket].length]);
        pending[bucket].push(canvas);
      }

      // Arrays: allocate, fill layer by layer, mipmap
      this.release();
      this.generation = generation;
      pending.forEach((layers, b) => {
        if (layers.length === 0) { return; }
        const size = MaterialTextures.BUCKETS[b];
        const texture = gl.createTexture();
        this.arrays[b] = texture;
        gl.activeTexture(gl.TEXTURE0 + MaterialTextures.BUCKET_UNIT + b);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.floor(Math.log2(size)) + 1, gl.RGBA8, size, size, layers.length);
        layers.forEach((canvas, layer) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, canvas));
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
        if (caps.maxAnisotropy >= 2) { gl.texParameterf(gl.TEXTURE_2D_ARRAY, caps.anisotropyEnum, Math.min(8, caps.maxAnisotropy)); }
        this.gpuBytes += size * size * 4 * layers.length * 4 / 3;
        this.imageCount += layers.length;
      });

      this.uploadTable(table, keys, proxyOf, proxies, placements, averages);
      gl.activeTexture(gl.TEXTURE0);

      if (gl.getError() === gl.OUT_OF_MEMORY) {
        this.release();
        return 'Not enough graphics memory for the textures: Realistic mode shows colours only.';
      }
      const buckets = MaterialTextures.BUCKETS.map((s, b) => [s, pending[b].length]).filter(([, n]) => n > 0).map(([s, n]) => `${n}×${s}²`).join(', ');
      console.info(`Materials: ${this.materialCount} in the table (${this.proxyCount} on proxies), ${this.imageCount} images in ${buckets || 'none'}, ≈ ${Math.round(this.gpuBytes / 1048576)} MB.`);
      return warning;
    } catch (e) {
      console.warn('Material textures failed:', e);
      this.release();
      return 'Textures could not be loaded: Realistic mode is unavailable.';
    }
  }

  /** Binds the table and arrays on their units (only when ready; otherwise the renderer's placeholders stay). */
  bind(): void {
    if (!this.ready) { return; }
    gl.activeTexture(gl.TEXTURE0 + MaterialTextures.TABLE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.table);
    this.arrays.forEach((texture, b) => {
      if (!texture) { return; }
      gl.activeTexture(gl.TEXTURE0 + MaterialTextures.BUCKET_UNIT + b);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    });
    gl.activeTexture(gl.TEXTURE0);
  }

  private uploadTable(materials: SceneMaterial[], keys: (string | null)[], proxyOf: (string | null)[], proxies: ProxyPack | null,
    placements: Map<string, [number, number]>, averages: Map<string, Vec3>): void {
    const count = materials.length, T = MaterialTextures.TEXELS;
    const data = new Float32Array(count * T * 4);
    this.proxyCount = 0;
    const put = (offset: number, rgb: Vec3, w: number) => { data[offset] = rgb.x; data[offset + 1] = rgb.y; data[offset + 2] = rgb.z; data[offset + 3] = w; };

    materials.forEach((m, i) => {
      const o = i * T * 4;
      const key = keys[i];
      const textured = key !== null && placements.has(key);
      const [bucket, layer] = textured ? placements.get(key!)! : [-1, 0];
      const proxy = textured && proxyOf[i] !== null;
      const angle = m.angle * Math.PI / 180;

      if (proxy) {
        // A stand-in: drawn fully at the proxy's own real-world size, in the material's colour (or the pack's)
        const [sizeU, sizeV] = proxies!.sizeOf(proxyOf[i]!);
        let tint = vec3(1, 1, 1);
        const avg = averages.get(key!);
        if (this.proxyMaterialColour && avg) {
          const c = (v: number, a: number) => Math.min(Math.max(v / Math.max(a, 0.02), 0), 4);
          tint = vec3(c(m.colour.x, avg.x), c(m.colour.y, avg.y), c(m.colour.z, avg.z));
        }
        put(o, m.colour, 1);
        put(o + 4, tint, m.reflectivity);
        data[o + 8] = Math.max(sizeU, 1e-3);
        data[o + 9] = Math.max(sizeV, 1e-3);
        data[o + 10] = 0;
        data[o + 11] = 0;
        this.proxyCount++;
      } else {
        put(o, m.colour, textured ? m.fade : 0);
        put(o + 4, m.tint, m.reflectivity);
        data[o + 8] = Math.max(m.scaleU, 1e-3);
        data[o + 9] = Math.max(m.scaleV, 1e-3);
        data[o + 10] = m.offsetU;
        data[o + 11] = m.offsetV;
      }
      data[o + 12] = Math.cos(angle);
      data[o + 13] = Math.sin(angle);
      data[o + 14] = bucket;
      data[o + 15] = layer;
      put(o + 16, m.assetTint ?? vec3(1, 1, 1), proxy ? MaterialTextures.FLAG_PROXY : m.invert ? MaterialTextures.FLAG_INVERT : 0);
    });

    this.table = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + MaterialTextures.TABLE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.table);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, T, count, 0, gl.RGBA, gl.FLOAT, data);
    this.materialCount = count;
  }

  release(): void {
    gl.deleteTexture(this.table);
    this.table = null;
    this.arrays.forEach((t, b) => { gl.deleteTexture(t); this.arrays[b] = null; });
    this.materialCount = this.imageCount = this.proxyCount = this.gpuBytes = 0;
  }

  dispose(): void {
    this.generation++;
    this.release();
  }
}

async function decode(bytes: Uint8Array): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    console.info('Texture image could not be decoded.');
    return null;
  }
}

function bucketFor(longest: number, cap: number): number {
  const buckets = MaterialTextures.BUCKETS;
  for (let b = 0; b < buckets.length; b++) {
    if (buckets[b] >= longest || buckets[b] >= cap) { return b; }
  }
  return buckets.length - 1;
}

/** The image stretched to a size × size square over white (cutouts are out of scope, as on the desktop). */
function squareOnWhite(bitmap: ImageBitmap, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, size, size);
  return canvas;
}

/** The average colour of an image (every 7th pixel), for tinting proxies to their material's colour. */
function average(canvas: HTMLCanvasElement): Vec3 {
  const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4 * 7) {
    r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2];
    n++;
  }
  return n === 0 ? vec3(1, 1, 1) : vec3(r / n / 255, g / n / 255, b / n / 255);
}
