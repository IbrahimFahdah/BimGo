import { obj, arr, num, str } from '../../core/format/Json';
import { type MaterialData, type SceneMaterial, TextureState } from '../../core/scene/MaterialData';
import { ProxyCatalog } from '../../core/scene/ProxyCatalog';

/**
 * The CC0 proxy textures served with the site under proxies/ (port of BimGo.App/Rendering/ProxyPack.cs, which reads
 * them from beside the exe). Loaded once; images are fetched when first used.
 */
export class ProxyPack {
  private static shared: Promise<ProxyPack> | null = null;
  private readonly entries = new Map<string, { file: string; sizeU: number; sizeV: number }>();
  private readonly bytes = new Map<string, Promise<Uint8Array | null>>();

  private constructor(private readonly base: string) {}

  /** The pack shipped with the site (base URL of the page + proxies/). */
  static load(): Promise<ProxyPack> {
    ProxyPack.shared ??= ProxyPack.fetchPack(new URL('proxies/', new URL(import.meta.env.BASE_URL, location.href)).href);
    return ProxyPack.shared;
  }

  private static async fetchPack(base: string): Promise<ProxyPack> {
    const pack = new ProxyPack(base);
    try {
      const response = await fetch(base + 'proxies.json');
      if (!response.ok) { throw new Error(`${response.status}`); }
      for (const raw of arr(obj(await response.json()).proxies)) {
        const e = obj(raw);
        const keyword = ProxyCatalog.normalise(str(e.keyword, null));
        const file = str(e.file, null);
        if (!keyword || !file) { continue; }
        const known = ProxyCatalog.find(keyword);
        const sizeU = num(e.sizeU), sizeV = num(e.sizeV);
        pack.entries.set(keyword, { file, sizeU: sizeU > 0.01 ? sizeU : known?.sizeU ?? 1, sizeV: sizeV > 0.01 ? sizeV : known?.sizeV ?? 1 });
      }
    } catch (e) {
      console.info(`Proxy textures unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    return pack;
  }

  get count(): number { return this.entries.size; }

  has(keyword: string | null): boolean { return keyword !== null && this.entries.has(keyword); }

  imageBytes(keyword: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(keyword);
    if (!entry) { return Promise.resolve(null); }
    let pending = this.bytes.get(keyword);
    if (!pending) {
      pending = fetch(this.base + entry.file)
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then(b => new Uint8Array(b))
        .catch(() => null);
      this.bytes.set(keyword, pending);
    }
    return pending;
  }

  sizeOf(keyword: string): [number, number] {
    const entry = this.entries.get(keyword);
    if (entry) { return [entry.sizeU, entry.sizeV]; }
    const known = ProxyCatalog.find(keyword);
    return [known?.sizeU ?? 1, known?.sizeV ?? 1];
  }

  /** The proxy a material is drawn with: its own pick, else (missing images, auto on) a suggestion; null for none. */
  static effectiveProxy(material: SceneMaterial, data: MaterialData, autoProxy: boolean): string | null {
    if (material.texture !== null && data.textures.has(material.texture)) { return null; }
    if (material.proxy !== null) { return material.proxy; }
    if (autoProxy && material.textureOrigin === null
      && (material.textureState === TextureState.Missing || material.textureState === TextureState.Unreadable)) {
      return ProxyCatalog.suggest(material.name, material.schema);
    }
    return null;
  }
}
