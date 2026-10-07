import { BimGoFormat } from '../core/format/BimGoFormat';
import {
  copyMaterial, type MaterialData, type SceneMaterial, TextureOrigins, TextureState, withMaterials
} from '../core/scene/MaterialData';
import { ProxyCatalog } from '../core/scene/ProxyCatalog';
import {
  directorySource, TextureFolderIndex, TextureMatchStage, TextureSearch, type TextureSearchResult
} from '../core/scene/TextureSearch';
import { ProxyPack } from '../engine/render/ProxyPack';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import type { InputState } from '../platform/input';
import type { GameSession } from './GameSession';
import { Widgets } from './Menus';

interface ScanRow {
  result: TextureSearchResult;
  choice: number;
  accepted: boolean;
  materials: number;
  name: string;
  stage: string;
}

const isMissing = (m: SceneMaterial) => m.texture === null && (m.textureState === TextureState.Missing || m.textureState === TextureState.Unreadable);

/**
 * Realistic-mode materials of a walkthrough and the TEXTURES panel (port of BimGo.App/Game/GameSession.Textures.cs,
 * file mode): pick an image, a CC0 proxy or plain colour per material, or search a folder for missing images. Changed
 * images are embedded in the file when it is saved.
 */
export class Textures {
  /** The material set drawn now (the file's, plus the user's changes). */
  current: MaterialData;
  revision = 0;
  readonly changed = new Set<number>();
  open = false;
  proxies: ProxyPack | null = null;

  private readonly w: Widgets;
  private scroll = 0;
  private filter = 0;                 // 0 missing, 1 proxy, 2 all
  private notice: string | null = null;
  private pickerFor = -1;
  private busy = false;
  // Folder search
  private scanIndex: TextureFolderIndex | null = null;
  private scanStage = TextureMatchStage.Exact;
  private scanRemaining: string[] = [];
  private scanRows: ScanRow[] | null = null;
  private scanScroll = 0;
  private scanAccepted = 0;

  constructor(private readonly session: GameSession) {
    this.current = session.scene.materials;
    this.w = new Widgets(session);
  }

  private s(v: number): number { return this.session.s(v); }

  /** True when the file has materials (the panel and Realistic mode have something to show). */
  get available(): boolean {
    return this.session.scene.materials.materials.length > 0 && this.session.scene.materials.vertexMaterial.length > 0;
  }

  /** Loads the proxy pack and builds the GPU textures (once at start, and after every change). */
  async load(): Promise<void> {
    if (!this.available) { return; }
    this.proxies ??= await ProxyPack.load();
    const warning = await this.session.renderer.loadMaterials(this.current, this.proxies);
    if (warning) { this.session.toast(warning, 5); }
  }

  effectiveProxy(m: SceneMaterial): string | null {
    return ProxyPack.effectiveProxy(m, this.current, this.session.settings.proxyMissing);
  }

  get missingCount(): number {
    return this.current.materials.filter(m => isMissing(m) && this.effectiveProxy(m) === null).length;
  }

  menuLabel(): string {
    const missing = this.missingCount;
    return missing === 0 ? 'TEXTURES' : `TEXTURES (${missing} MISSING)`;
  }

  show(): void {
    this.open = true;
    this.scroll = 0;
    this.pickerFor = -1;
    this.notice = null;
  }

  /** Esc: closes the innermost layer; false when the panel wasn't open. */
  close(): boolean {
    if (!this.open) { return false; }
    if (this.pickerFor >= 0) { this.pickerFor = -1; return true; }
    if (this.scanRows) { this.endScan(); return true; }
    this.open = false;
    return true;
  }

  // #region Panel

  build(): void {
    const session = this.session, ui = session.ui, f = ui.atlas, w = this.w, input = session.input;
    const settings = session.settings;
    const width = session.screenWidth, height = session.screenHeight;
    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    const pw = Math.min(this.s(1080), width - this.s(80)), ph = height - this.s(96);
    const x = (width - pw) * 0.5, y = this.s(48);
    ui.panel(x, y, pw, ph, UiTheme.CARD, UiTheme.CARD_BORDER);

    const ix = x + this.s(24), iw = pw - this.s(48);
    let cy = y + this.s(20);
    const table = this.current.materials;
    const missing = table.filter(isMissing).length;
    ui.text(f.small, ix, cy, 'TEXTURES · REALISTIC MODE', UiTheme.ACCENT, this.s(2));
    ui.textRight(f.small, ix + iw, cy, `${table.length.toLocaleString('en')} materials · ${missing} missing an image · proxy pack: ${this.proxies?.count ?? 0} textures`, UiTheme.TEXT_MUTED, this.s(0.6));
    cy += this.s(34);

    // Display options for the Realistic mode
    const colW = Math.min(this.s(360), iw * 0.4);
    const tint = w.checkbox(f, ix, cy + this.s(4), colW, 'Apply Revit tint', settings.revitTint);
    if (tint !== settings.revitTint) { settings.revitTint = tint; settings.save(); }
    ui.textWrapped(f.small, ix + this.s(26), cy + this.s(30), colW - this.s(26), "As Revit's Realistic view (off: images untinted)", UiTheme.TEXT_MUTED, 1);
    const ox = ix + colW + this.s(32), ow = iw - colW - this.s(32);
    const proxies = w.checkbox(f, ox, cy + this.s(4), ow, 'Proxy textures for missing images', settings.proxyMissing);
    const proxyColour = w.checkbox(f, ox, cy + this.s(32), ow, "Proxies take the material's colour", settings.proxyMaterialColour);
    if (proxies !== settings.proxyMissing || proxyColour !== settings.proxyMaterialColour) {
      settings.proxyMissing = proxies;
      settings.proxyMaterialColour = proxyColour;
      settings.save();
      this.applyRendererOptions();
      void this.load();
    }
    cy += this.s(70);

    const buttonsY = y + ph - this.s(24) - this.s(48);
    if (this.scanRows) {
      this.buildScanRows(f, input, ix, cy, iw, buttonsY - this.s(16));
      this.buildScanButtons(f, ix, buttonsY);
      return;
    }

    // Filter
    const proxied = table.filter(m => this.effectiveProxy(m) !== null).length;
    const filter = w.segmented(f, ix, cy, Math.min(this.s(420), iw), [`Missing (${missing})`, `Proxy (${proxied})`, `All (${table.length})`], this.filter);
    if (filter !== this.filter) {
      this.filter = filter;
      this.scroll = 0;
      this.pickerFor = -1;
    }
    cy += this.s(46);

    if (this.pickerFor >= 0) { this.buildProxyPicker(f, ix, cy, iw, buttonsY - this.s(16)); }
    else { this.buildRows(f, input, ix, cy, iw, buttonsY - this.s(16)); }

    if (this.notice) { ui.textWrapped(f.body, ix, buttonsY - this.s(30), iw, this.notice, UiTheme.MEASURE_TEXT, 1); }
    if (w.menuButton(f, ix, buttonsY, this.s(260), 'FIND IN FOLDER…', false, false, !this.busy)) { void this.startScan(); }
    if (w.menuButton(f, ix + this.s(276), buttonsY, this.s(160), 'CLOSE', false, false)) { this.open = false; }
    ui.textRight(f.small, ix + iw, buttonsY + this.s(18), 'Picked images are embedded in the file when you save', UiTheme.TEXT_FAINT, this.s(0.4));
  }

  private rows(): number[] {
    const table = this.current.materials;
    const rows = table.map((_, i) => i).filter(i => this.filter === 0 ? isMissing(table[i]) || this.changed.has(i)
      : this.filter === 1 ? this.effectiveProxy(table[i]) !== null : true);
    return rows.sort((a, b) => (Number(isMissing(table[b])) - Number(isMissing(table[a]))) || table[a].name.localeCompare(table[b].name, undefined, { sensitivity: 'base' }));
  }

  private buildRows(f: FontAtlas, input: InputState, x: number, y: number, width: number, bottom: number): void {
    const ui = this.session.ui, w = this.w;
    const rows = this.rows();
    const table = this.current.materials;
    const rowH = this.s(52);
    const visible = Math.max(1, Math.trunc((bottom - y) / rowH));
    if (rows.length === 0) {
      ui.textWrapped(f.body, x, y + this.s(8), width, this.filter === 0 ? 'No material is missing its image.'
        : this.filter === 1 ? 'No material is drawn with a proxy.' : 'No materials.', UiTheme.TEXT_MUTED, 2);
      return;
    }

    const maxScroll = Math.max(0, rows.length - visible);
    if (input.wheel !== 0) { this.scroll -= input.wheel * 2; }
    this.scroll = Math.min(Math.max(this.scroll, 0), maxScroll);

    let pick = -1, proxy = -1, plain = -1, undo = -1;
    const wide = this.s(84), gap = this.s(6), buttonsW = wide * 4 + gap * 3;
    const last = Math.min(rows.length, this.scroll + visible);
    for (let r = this.scroll; r < last; r++) {
      const index = rows[r], m = table[index];
      const ry = y + (r - this.scroll) * rowH;
      if (((r - this.scroll) & 1) === 0) { ui.rect(x - this.s(8), ry - this.s(4), width + this.s(16), rowH - this.s(4), Rgba.hex(0xffffff, 0.03)); }

      // Swatch in the colour drawn under (or instead of) the image
      const sw = this.s(36);
      ui.rect(x, ry, sw, sw, packColour(m.colour));
      ui.outline(x, ry, sw, sw, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.15));

      const textX = x + sw + this.s(12), textW = width - buttonsW - sw - this.s(36);
      const [status, colour] = this.statusOf(index, m);
      ui.textWrapped(f.bold, textX, ry + this.s(2), textW * 0.55, m.name, UiTheme.TEXT, 1);
      ui.textWrapped(f.small, textX + textW * 0.57, ry + this.s(5), textW * 0.43, status, colour, 1);
      ui.textWrapped(f.small, textX, ry + this.s(24), textW, detailOf(m), UiTheme.TEXT_MUTED, 1);

      let bx = x + width - buttonsW;
      const by = ry + this.s(4), bh = this.s(30);
      if (w.smallButton(f, bx, by, wide, bh, 'IMAGE…')) { pick = index; }
      bx += wide + gap;
      if (w.smallButton(f, bx, by, wide, bh, 'PROXY')) { proxy = index; }
      bx += wide + gap;
      if (w.smallButton(f, bx, by, wide, bh, 'PLAIN')) { plain = index; }
      bx += wide + gap;
      if (this.changed.has(index) && w.smallButton(f, bx, by, wide, bh, 'UNDO')) { undo = index; }
    }
    if (maxScroll > 0) {
      ui.textRight(f.small, x + width, bottom + this.s(2), `${this.scroll + 1}–${last} of ${rows.length} · wheel to scroll`, UiTheme.TEXT_FAINT);
    }

    // Act after drawing (the rows must not change while they are being walked)
    if (pick >= 0) { void this.pickImage(pick); }
    else if (proxy >= 0) { this.pickerFor = proxy; }
    else if (plain >= 0) { this.applyChoice([plain], null); }
    else if (undo >= 0) { this.undo(undo); }
  }

  private statusOf(index: number, m: SceneMaterial): [string, number] {
    const yours = this.changed.has(index) || m.textureOrigin === TextureOrigins.OVERRIDE;
    if (m.texture !== null) {
      return [m.textureOrigin === TextureOrigins.OVERRIDE ? 'Your image' : m.textureOrigin === TextureOrigins.SEARCH ? 'Found by search' : 'Image',
        yours ? UiTheme.ACCENT : UiTheme.GOOD];
    }
    const proxy = this.effectiveProxy(m);
    if (proxy !== null) {
      const label = ProxyCatalog.find(proxy)?.label ?? proxy;
      return [this.proxies?.has(proxy) ? `Proxy: ${label}` : `Proxy: ${label} (not in the pack)`, yours ? UiTheme.ACCENT : UiTheme.MEASURE_TEXT];
    }
    if (isMissing(m)) { return [m.textureState === TextureState.Unreadable ? 'Unreadable → colour' : 'Missing → colour', UiTheme.DANGER]; }
    return [m.textureOrigin === TextureOrigins.OVERRIDE ? 'Plain colour (yours)' : m.textureState === TextureState.Procedural ? 'Procedural → colour' : 'Plain colour',
      yours ? UiTheme.ACCENT : UiTheme.TEXT_SOFT];
  }

  private buildProxyPicker(f: FontAtlas, x: number, y: number, width: number, bottom: number): void {
    const ui = this.session.ui, w = this.w;
    const m = this.current.materials[this.pickerFor];
    const suggested = ProxyCatalog.suggest(m.name, m.schema);
    ui.textWrapped(f.bold, x, y, width, `Proxy for “${m.name}”${suggested ? ` · suggested: ${ProxyCatalog.find(suggested)?.label ?? suggested}` : ''}`, UiTheme.TEXT, 1);

    const columns = 4, gap = this.s(8), bw = (width - gap * (columns - 1)) / columns, bh = this.s(34);
    let chosen: string | null = null;
    ProxyCatalog.ALL.forEach((k, i) => {
      const bx = x + (i % columns) * (bw + gap), by = y + this.s(34) + Math.trunc(i / columns) * (bh + gap);
      if (by + bh > bottom) { return; }
      const label = ((k.keyword === suggested ? '» ' : '') + k.label + (this.proxies?.has(k.keyword) ? '' : ' (no image)')).toUpperCase();
      if (w.smallButton(f, bx, by, bw, bh, label)) { chosen = k.keyword; }
    });
    if (w.menuButton(f, x, bottom - this.s(48), this.s(160), 'CANCEL', false, false)) { this.pickerFor = -1; return; }
    if (chosen !== null) {
      const index = this.pickerFor;
      this.pickerFor = -1;
      this.applyChoice([index], chosen);
    }
  }

  // #endregion

  // #region Applying choices

  private async pickImage(index: number): Promise<void> {
    const file = await pickImageFile();
    this.session.input.releaseAll();
    if (!file) { return; }
    await this.applyImages(new Map([[index, file]]));
  }

  /** Encodes picked images (JPEG at the file's texture size) and points their materials at them. */
  private async applyImages(images: Map<number, File>): Promise<number> {
    if (images.size === 0) { return 0; }
    this.busy = true;
    this.notice = `Reading ${images.size} image${images.size === 1 ? '' : 's'}…`;
    const cap = this.current.textureMaxSize;
    const byFile = new Map<File, { entry: string; bytes: Uint8Array } | null>();
    const failed: string[] = [];
    for (const file of new Set(images.values())) {
      const encoded = await encodeTexture(file, cap);
      byFile.set(file, encoded);
      if (!encoded) { failed.push(file.name); }
    }
    this.busy = false;

    const table = this.current.materials.map(copyMaterial);
    const added = new Map<string, Uint8Array>();
    const applied: number[] = [];
    for (const [index, file] of images) {
      const encoded = byFile.get(file);
      if (!encoded) { continue; }
      added.set(encoded.entry, encoded.bytes);
      const m = table[index];
      m.texture = encoded.entry;
      m.textureState = TextureState.Embedded;
      m.textureOrigin = TextureOrigins.OVERRIDE;
      m.proxy = null;
      if (m.renderColour) {
        m.colour = m.renderColour; // the appearance's own base colour again, now that there is an image over it
        m.renderColour = null;
      }
      applied.push(index);
    }
    if (applied.length > 0) { this.commit(table, added, applied); }
    this.notice = failed.length === 0
      ? `${applied.length} material${applied.length === 1 ? '' : 's'} given an image`
      : `${applied.length} given an image; ${failed.length} couldn't be read: ${failed.slice(0, 3).join(', ')}`;
    this.session.sound.play(failed.length === 0 ? SoundId.Commit : SoundId.Error);
    return applied.length;
  }

  /** A proxy keyword, or null for plain colour. */
  private applyChoice(indices: number[], proxy: string | null): void {
    const table = this.current.materials.map(copyMaterial);
    for (const index of indices) {
      const m = table[index];
      if (m.texture !== null) {
        m.texture = null;
        m.textureState = m.textureSource === null ? TextureState.None : TextureState.Missing;
      }
      m.proxy = proxy === null ? null : ProxyCatalog.normalise(proxy);
      m.textureOrigin = proxy === null ? TextureOrigins.OVERRIDE : TextureOrigins.PROXY;
    }
    this.commit(table, null, indices);
    this.notice = proxy === null ? 'Plain colour' : `Proxy: ${ProxyCatalog.find(proxy)?.label ?? proxy}`;
    this.session.sound.play(SoundId.Commit);
  }

  private undo(index: number): void {
    const table = this.current.materials.map(copyMaterial);
    table[index] = copyMaterial(this.session.scene.materials.materials[index]);
    this.changed.delete(index);
    this.commit(table, null, [], true);
    this.notice = `“${table[index].name}” is back as it came from Revit`;
    this.session.sound.play(SoundId.UiClick);
  }

  private commit(table: SceneMaterial[], added: Map<string, Uint8Array> | null, changed: number[], keepChanged = false): void {
    this.current = withMaterials(this.current, table, added ?? undefined);
    if (!keepChanged) { for (const i of changed) { this.changed.add(i); } }
    this.revision++;
    this.session.markDirty();
    void this.load();
  }

  /** Pushes the panel's display options into the renderer. */
  applyRendererOptions(): void {
    const r = this.session.renderer, settings = this.session.settings;
    r.autoProxy = settings.proxyMissing;
    r.materials.proxyMaterialColour = settings.proxyMaterialColour;
  }

  // #endregion

  // #region Folder search

  private async startScan(): Promise<void> {
    const raws = [...new Set(this.current.materials
      .filter(m => m.texture === null && m.textureState === TextureState.Missing && m.textureSource !== null)
      .map(m => m.textureSource!))];
    if (raws.length === 0) {
      this.notice = 'No material is missing its image.';
      return;
    }
    const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) {
      this.notice = 'Searching a folder needs Chrome or Edge (this browser cannot list folders). Use IMAGE… per material instead.';
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker.call(window, { id: 'bimgo-textures', mode: 'read' });
    } catch {
      this.session.input.releaseAll();
      return;
    }
    this.session.input.releaseAll();

    this.busy = true;
    this.notice = `Searching ${handle.name}…`;
    try {
      this.scanIndex = await TextureFolderIndex.build(directorySource(handle), undefined,
        (files, folders) => { this.notice = `Searching ${handle.name}: ${files.toLocaleString('en')} images in ${folders.toLocaleString('en')} folders…`; });
    } finally {
      this.busy = false;
    }
    this.scanStage = TextureMatchStage.Exact;
    this.scanRemaining = raws;
    this.scanAccepted = 0;
    this.runScanStage();
  }

  private runScanStage(): void {
    const results = TextureSearch.runStage(this.scanIndex!, this.scanRemaining, this.scanStage);
    const table = this.current.materials;
    this.scanRows = results.filter(r => r.stage !== TextureMatchStage.None).map(r => ({
      result: r,
      choice: 0,
      accepted: r.preTicked,
      materials: table.filter(m => m.texture === null && m.textureSource?.toLowerCase() === r.raw.toLowerCase()).length,
      name: TextureSearch.fileNamesOf(r.raw)[0] ?? r.raw,
      stage: r.stage === TextureMatchStage.Exact ? (r.isAmbiguous ? `EXACT ×${r.candidates.length}` : 'EXACT')
        : r.stage === TextureMatchStage.Extension ? (r.isAmbiguous ? `EXT ×${r.candidates.length}` : 'EXTENSION') : 'LOOSE'
    }));
    this.scanRemaining = results.filter(r => r.stage === TextureMatchStage.None).map(r => r.raw);
    this.scanScroll = 0;
  }

  private buildScanRows(f: FontAtlas, input: InputState, x: number, y: number, width: number, bottom: number): void {
    const ui = this.session.ui, w = this.w, rows = this.scanRows!, index = this.scanIndex!;
    const stage = this.scanStage === TextureMatchStage.Exact ? 'STAGE 1 OF 3 · EXACT FILE NAMES'
      : this.scanStage === TextureMatchStage.Extension ? 'STAGE 2 OF 3 · SAME NAME, OTHER EXTENSION' : 'STAGE 3 OF 3 · LOOSE NAMES';
    ui.text(f.bold, x, y, stage, UiTheme.TEXT, this.s(1));
    ui.textWrapped(f.small, x, y + this.s(24), width,
      `${rows.length} found · ${this.scanRemaining.length} still missing · ${index.fileCount.toLocaleString('en')} images in ${index.folder}${index.truncated ? ' (capped)' : ''}`, UiTheme.TEXT_MUTED, 1);
    ui.textWrapped(f.body, x, y + this.s(44), width, this.scanStage === TextureMatchStage.Loose
      ? 'Loose matches are proposals: tick the right ones. Bump, cutout and reflection maps are never offered.'
      : 'Exact matches are ticked. Where several files share a name, click the file to cycle through them, then tick it.', UiTheme.TEXT_SOFT, 1);
    y += this.s(76);

    const rowH = this.s(30);
    const visible = Math.max(1, Math.trunc((bottom - y) / rowH));
    if (rows.length === 0) {
      ui.textWrapped(f.body, x, y, width, 'Nothing found at this stage.', UiTheme.TEXT_MUTED, 1);
      return;
    }
    const maxScroll = Math.max(0, rows.length - visible);
    if (input.wheel !== 0) { this.scanScroll -= input.wheel * 2; }
    this.scanScroll = Math.min(Math.max(this.scanScroll, 0), maxScroll);

    const last = Math.min(rows.length, this.scanScroll + visible);
    for (let i = this.scanScroll; i < last; i++) {
      const row = rows[i], ry = y + (i - this.scanScroll) * rowH;
      const nameW = width * 0.28, stageW = this.s(110), countW = this.s(90);
      row.accepted = w.checkbox(f, x, ry + this.s(4), nameW, row.name, row.accepted);
      ui.text(f.small, x + nameW + this.s(8), ry + this.s(6), row.stage, row.result.stage === TextureMatchStage.Loose ? UiTheme.MEASURE_TEXT : UiTheme.GOOD, this.s(0.6));

      const fileX = x + nameW + stageW, fileW = width - nameW - stageW - countW;
      const hover = row.result.candidates.length > 1 && w.hover(fileX, ry, fileW, rowH - this.s(4));
      ui.textWrapped(f.body, fileX, ry + this.s(4), fileW, row.result.candidates[row.choice] ?? '—', hover ? UiTheme.ACCENT : UiTheme.TEXT, 1);
      if (hover && input.leftPressed) {
        row.choice = (row.choice + 1) % row.result.candidates.length;
        row.accepted = true;
        input.consumeClicks();
        this.session.sound.play(SoundId.UiClick);
      }
      ui.textRight(f.small, x + width, ry + this.s(6), `${row.materials} ${row.materials === 1 ? 'material' : 'materials'}`, UiTheme.TEXT_FAINT);
    }
    if (maxScroll > 0) {
      ui.textRight(f.small, x + width, bottom + this.s(2), `${this.scanScroll + 1}–${last} of ${rows.length} · wheel to scroll`, UiTheme.TEXT_FAINT);
    }
  }

  private buildScanButtons(f: FontAtlas, x: number, y: number): void {
    const w = this.w;
    const canNext = this.scanStage < TextureMatchStage.Loose && this.scanRemaining.length > 0;
    if (w.menuButton(f, x, y, this.s(280), 'ACCEPT TICKED, NEXT STAGE', canNext, false, canNext && !this.busy)) {
      void this.acceptScan().then(() => { this.scanStage++; this.runScanStage(); });
      return;
    }
    if (w.menuButton(f, x + this.s(296), y, this.s(240), 'ACCEPT TICKED, DONE', !canNext, false, !this.busy)) {
      void this.acceptScan().then(() => this.endScan());
      return;
    }
    if (w.menuButton(f, x + this.s(552), y, this.s(130), 'STOP', false, false)) { this.endScan(); }
  }

  private async acceptScan(): Promise<void> {
    const images = new Map<number, File>();
    const table = this.current.materials;
    for (const row of this.scanRows ?? []) {
      const path = row.result.candidates[row.choice];
      if (!row.accepted || !path) { continue; }
      const file = await this.scanIndex?.openFile(path);
      if (!file) { continue; }
      table.forEach((m, i) => {
        if (m.texture === null && m.textureSource?.toLowerCase() === row.result.raw.toLowerCase()) { images.set(i, file); }
      });
    }
    const before = new Set(images.keys());
    this.scanAccepted += await this.applyImages(images);
    // Found by search, not picked by hand
    if (before.size > 0) {
      const marked = this.current.materials.map(copyMaterial);
      for (const i of before) { if (marked[i].texture !== null) { marked[i].textureOrigin = TextureOrigins.SEARCH; } }
      this.current = withMaterials(this.current, marked);
    }
  }

  private endScan(): void {
    if (this.scanIndex) { this.notice = `${this.scanAccepted} material${this.scanAccepted === 1 ? '' : 's'} given an image`; }
    this.scanIndex = null;
    this.scanRows = null;
    this.scanRemaining = [];
  }

  // #endregion
}

function packColour(c: { x: number; y: number; z: number }): number {
  const b = (v: number) => Math.min(Math.max(Math.trunc(v * 255 + 0.5), 0), 255);
  return (b(c.x) | (b(c.y) << 8) | (b(c.z) << 16) | 0xff000000) >>> 0;
}

function detailOf(m: SceneMaterial): string {
  const schema = !m.schema ? 'no appearance' : m.schema.endsWith('Schema') ? m.schema.slice(0, -6) : m.schema;
  return `${schema} · ${m.textureSource?.trim() ? m.textureSource : 'no image in Revit'}`;
}

function pickImageFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/bmp,image/gif,image/webp';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/**
 * An image as an embedded texture (port of TextureEncoder): longest side capped at the file's texture size, over
 * white, JPEG 85 %, named textures/<hash>.jpg so the same image is stored once.
 */
async function encodeTexture(file: File, cap: number): Promise<{ entry: string; bytes: Uint8Array } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, cap / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) { return null; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const key = new TextEncoder().encode(`${file.name.toLowerCase()}|${file.size}|${file.lastModified}|${cap}`);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', key));
    const hex = [...hash.slice(0, 10)].map(b => b.toString(16).padStart(2, '0')).join('');
    return { entry: `${BimGoFormat.TEXTURE_FOLDER}${hex}.jpg`, bytes };
  } catch (e) {
    console.info(`Texture ${file.name} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
