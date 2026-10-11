import { type CommentRecord } from '../core/format/DocumentModels';
import { type Vec2, vec2 } from '../core/math/Vector';
import { gl } from '../engine/gl/Gl';
import { Rgba } from '../engine/ui/Rgba';
import type { FontAtlas } from '../engine/ui/UiFont';
import { UiTheme } from '../engine/ui/UiTheme';
import { SoundId } from '../platform/audio';
import { type InputState, Vk } from '../platform/input';
import type { GameSession } from './GameSession';
import type { Widgets } from './Menus';

enum MarkupTool { Arrow = 0, Box = 1, Ellipse = 2, Pen = 3, Text = 4 }

/** One markup operation: a shape, or a CLEAR (hides everything before it). */
interface MarkupShape {
  tool: MarkupTool;
  colour: number;
  width: number;
  points: Vec2[];
  text?: string;
  isClear?: boolean;
}

const MARKUP_TOOLS = ['ARROW', 'BOX', 'ELLIPSE', 'PEN', 'TEXT'];
const MARKUP_WIDTHS = ['THIN', 'MEDIUM', 'THICK'];

/** Red, amber, cyan, white, black (RGB). */
const MARKUP_COLOURS = [0xef4444, 0xf59e0b, 0x22d3ee, 0xffffff, 0x111111];

/** Stroke widths as a share of the picture's width. */
const MARKUP_STROKE = [0.0025, 0.005, 0.0095];

/** Text heights as a share of the picture's height. */
const MARKUP_TEXT = [0.034, 0.05, 0.072];

const MARKUP_TEXT_MAX = 120;

/** Thumbnail and snapshot sizes / qualities, as the comment capture writes them. */
const THUMB_WIDTH = 192, THUMB_HEIGHT = 108, THUMB_QUALITY = 0.72, SNAPSHOT_QUALITY = 0.82;

/**
 * Snapshot markup (port of GameSession.Markup.cs): draw on a comment's picture with arrows, boxes, ellipses, a pen and
 * text, in five colours and three thicknesses, with undo / redo and clear. Opens straight after a comment's picture is
 * taken (a new comment, or SET VIEW HERE) and from the comment's detail view (MARKUP…).
 *
 * SAVE burns the markup into the comment's picture and thumbnail, so BCF snapshots and every list carry it, and keeps
 * the unmarked original beside them (snapshotOriginal): the next MARKUP… starts from the clean picture. Shapes are kept
 * only while the editor is open (no editable vector layer).
 *
 * Shapes are stored in picture pixels; committed shapes are drawn with Canvas 2D (the desktop: GDI+) into a preview
 * texture (exactly what SAVE writes), the shape being dragged or typed is drawn with the UI batch on top.
 */
export class MarkupEditor {
  open = false;
  /** A picture just taken asks for the editor (set when the capture is requested, moved to pending once it exists). */
  afterCapture: CommentRecord | null = null;
  pending: CommentRecord | null = null;

  private record: CommentRecord | null = null;
  private returnToGame = false;
  private loading = false;

  // The unmarked picture and its JPEG bytes, and the preview texture (unmarked + committed shapes)
  private base: ImageBitmap | null = null;
  private baseBytes: Uint8Array | null = null;
  private texture: WebGLTexture | null = null;
  private readonly canvas = document.createElement('canvas');

  private readonly ops: MarkupShape[] = [];
  private readonly redo: MarkupShape[] = [];
  private tool = MarkupTool.Arrow;
  private colour = 0;
  private width = 1;
  private dirty = false;

  // The shape being dragged, and the text being typed (picture pixels)
  private drawing: MarkupShape | null = null;
  private typing = false;
  private textAt: Vec2 = vec2();
  private chars = '';

  // Where the picture is drawn this frame (screen)
  private px = 0;
  private py = 0;
  private pw = 0;
  private ph = 0;

  constructor(private readonly session: GameSession) {}

  private s(v: number): number { return this.session.s(v); }

  // #region Open / close

  /**
   * Opens the editor on a comment's picture (the unmarked original when it has markup).
   * @param returnToGame True to resume the walkthrough when the editor closes (opened right after a new comment).
   */
  show(record: CommentRecord, returnToGame: boolean): void {
    const session = this.session;
    if (!session.comments.comments.includes(record) || this.open || this.loading) { return; }
    const bytes = record.snapshotOriginalData ?? record.snapshotData;
    if (!bytes || bytes.length === 0) {
      session.sound.play(SoundId.Error);
      session.menu.setCommentsNotice('This comment has no picture to mark up: SET VIEW HERE takes one');
      session.toast('This comment has no picture to mark up: SET VIEW HERE takes one', 3);
      return;
    }

    this.loading = true;
    createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
      .then(bitmap => {
        this.loading = false;
        if (!session.comments.comments.includes(record) || session.tour.active || session.video.active) {
          bitmap.close();
          return;
        }
        this.base = bitmap;
        this.baseBytes = bytes;
        this.record = record;
        this.ops.length = 0;
        this.redo.length = 0;
        this.drawing = null;
        this.typing = false;
        this.chars = '';
        this.dirty = false;
        this.canvas.width = bitmap.width;
        this.canvas.height = bitmap.height;
        this.rebuildPreview();

        this.returnToGame = returnToGame && !session.paused;
        if (!session.paused) { session.setPaused(true); }
        this.open = true;
        session.input.releaseAll();
        session.sound.play(SoundId.UiClick);
      })
      .catch(e => {
        this.loading = false;
        console.info(`Markup: picture of ${record.id} unreadable: ${e instanceof Error ? e.message : String(e)}`);
        session.toast("The comment's picture could not be read for markup", 3, true);
      });
  }

  /** Start of a frame: opens the editor a picture just taken asked for. */
  openPending(): void {
    const record = this.pending;
    this.pending = null;
    if (record && !this.open && !this.session.tour.active && !this.session.video.active) { this.show(record, !this.session.paused); }
  }

  /** Closes the editor: SAVE burns the markup in (and keeps the original), otherwise nothing changes. */
  close(save: boolean): void {
    if (!this.open) { return; }
    const session = this.session;
    if (this.typing) { this.commitText(); }
    const record = this.record, returnToGame = this.returnToGame;
    let notice: string | null;

    if (save && this.dirty && record) {
      try {
        this.saveMarkup(record);
        notice = this.hasVisible() ? 'Markup saved (the picture and BCF snapshot carry it)' : 'Markup removed: the picture is back to the original';
        session.sound.play(SoundId.Commit);
      } catch (e) {
        console.warn('Markup save failed', e);
        notice = 'The markup could not be saved';
        session.toast(notice, 4, true);
      }
    } else {
      notice = this.dirty ? 'Markup not saved' : null;
    }
    if (notice) { session.menu.setCommentsNotice(notice); }

    this.release();
    this.open = false;
    this.record = null;
    session.input.releaseAll();
    if (returnToGame) {
      session.setPaused(false);
      if (notice) { session.toast(notice, 2.6); }
    }
  }

  /** Frees the decoded picture and the preview texture. */
  release(): void {
    this.base?.close();
    this.base = null;
    this.baseBytes = null;
    if (this.texture) {
      gl.deleteTexture(this.texture);
      this.texture = null;
    }
    this.ops.length = 0;
    this.redo.length = 0;
    this.drawing = null;
    this.typing = false;
  }

  // #endregion

  // #region Operations

  private addOp(shape: MarkupShape): void {
    this.ops.push(shape);
    this.redo.length = 0;
    this.dirty = true;
    this.rebuildPreview();
  }

  private undo(): void {
    if (this.typing) { this.cancelText(); return; }
    const op = this.ops.pop();
    if (!op) { return; }
    this.redo.push(op);
    this.dirty = true;
    this.rebuildPreview();
    this.session.sound.play(SoundId.UiClick);
  }

  private redoOp(): void {
    const op = this.redo.pop();
    if (!op) { return; }
    this.ops.push(op);
    this.dirty = true;
    this.rebuildPreview();
    this.session.sound.play(SoundId.UiClick);
  }

  private clear(): void {
    if (this.typing) { this.cancelText(); }
    if (!this.hasVisible()) { return; }
    this.addOp({ tool: MarkupTool.Arrow, colour: 0, width: 0, points: [], isClear: true });
    this.session.sound.play(SoundId.Remove);
  }

  /** Index of the first shape that shows (after the last CLEAR). */
  private firstVisible(): number {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      if (this.ops[i].isClear) { return i + 1; }
    }
    return 0;
  }

  private hasVisible(): boolean {
    return this.firstVisible() < this.ops.length;
  }

  private commitText(): void {
    this.typing = false;
    const text = this.chars.trim();
    this.chars = '';
    if (text.length === 0) { return; }
    this.addOp({ tool: MarkupTool.Text, colour: this.colour, width: this.width, points: [this.textAt], text });
  }

  private cancelText(): void {
    this.typing = false;
    this.chars = '';
  }

  // #endregion

  // #region Input

  /**
   * Keys while the editor is open: typing (text tool), Ctrl+Z / Ctrl+Y undo / redo, tool letters, Enter saves, Esc
   * cancels. Mouse drawing happens with the panel (build).
   */
  updateKeys(input: InputState): void {
    if (input.isPressed(Vk.F11)) { this.session.toggleFullscreen(); }

    if (this.typing) {
      if (input.isPressed(Vk.RETURN)) { this.commitText(); return; }
      if (input.isPressed(Vk.ESCAPE)) { this.cancelText(); return; }
      if (input.isPressedOrRepeated(Vk.BACK) && this.chars.length > 0) { this.chars = this.chars.slice(0, -1); }
      for (const c of input.typed) {
        if (c >= ' ' && this.chars.length < MARKUP_TEXT_MAX) { this.chars += c; }
      }
      return;
    }

    if (input.isDown(Vk.CONTROL)) {
      if (input.isPressedOrRepeated(Vk.key('Z'))) {
        if (input.isDown(Vk.SHIFT)) { this.redoOp(); } else { this.undo(); }
      } else if (input.isPressedOrRepeated(Vk.key('Y'))) { this.redoOp(); }
      return;
    }

    if (input.isPressed(Vk.ESCAPE)) { this.close(false); return; }
    if (input.isPressed(Vk.RETURN)) { this.close(true); return; }
    if (input.isPressed(Vk.key('A'))) { this.tool = MarkupTool.Arrow; }
    if (input.isPressed(Vk.key('R'))) { this.tool = MarkupTool.Box; }
    if (input.isPressed(Vk.key('E'))) { this.tool = MarkupTool.Ellipse; }
    if (input.isPressed(Vk.key('P'))) { this.tool = MarkupTool.Pen; }
    if (input.isPressed(Vk.key('T'))) { this.tool = MarkupTool.Text; }
    for (let i = 0; i < MARKUP_COLOURS.length; i++) {
      if (input.isPressed(0x31 + i)) { this.colour = i; }
    }
  }

  /** Screen → picture pixels. */
  private toImage(x: number, y: number): Vec2 {
    if (!this.base || this.pw <= 0) { return vec2(); }
    return vec2(Math.min(Math.max((x - this.px) / this.pw, 0), 1) * this.base.width, Math.min(Math.max((y - this.py) / this.ph, 0), 1) * this.base.height);
  }

  /** Picture pixels → screen. */
  private toScreen(p: Vec2): Vec2 {
    if (!this.base) { return vec2(); }
    return vec2(this.px + p.x / this.base.width * this.pw, this.py + p.y / this.base.height * this.ph);
  }

  /** Mouse on the picture: starts, drags and finishes shapes, or places a text. */
  private updateMouse(input: InputState): void {
    const base = this.base!;
    const over = input.mouseX >= this.px && input.mouseX < this.px + this.pw && input.mouseY >= this.py && input.mouseY < this.py + this.ph;

    if (input.leftPressed && over) {
      if (this.typing) { this.commitText(); }
      const at = this.toImage(input.mouseX, input.mouseY);
      if (this.tool === MarkupTool.Text) {
        this.typing = true;
        this.textAt = at;
        this.chars = '';
      } else {
        this.drawing = { tool: this.tool, colour: this.colour, width: this.width, points: [at, vec2(at.x, at.y)] };
      }
      return;
    }

    const shape = this.drawing;
    if (!shape) { return; }
    const point = this.toImage(input.mouseX, input.mouseY);
    const points = shape.points;
    if (shape.tool === MarkupTool.Pen) {
      // A new pen point every couple of screen pixels
      const minStep = 2 * this.session.ui.scale * base.width / Math.max(this.pw, 1);
      const last = points[points.length - 1];
      if (Math.hypot(last.x - point.x, last.y - point.y) >= minStep) { points.push(point); }
    } else {
      points[1] = point;
    }

    if (!input.leftDown || input.leftReleased) {
      this.drawing = null;
      if (shape.tool === MarkupTool.Pen) {
        if (points.length >= 2) { this.addOp(shape); }
      } else {
        // A click without a drag draws nothing
        const minSize = 4 * this.session.ui.scale * base.width / Math.max(this.pw, 1);
        if (Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) >= minSize) { this.addOp(shape); }
      }
    }
  }

  // #endregion

  // #region Panel

  /** Draws and handles the editor (in place of the pause menu): toolbar, the picture with the markup, hints. */
  build(w: Widgets): void {
    const session = this.session, ui = session.ui, f = ui.atlas, input = session.input;
    const width = session.screenWidth, height = session.screenHeight;
    if (!this.base) { this.close(false); return; }
    ui.rect(0, 0, width, height, UiTheme.MENU_BACKGROUND);

    const margin = this.s(40);
    let y = this.s(22);

    // Title row with CANCEL / SAVE on the right
    ui.text(f.small, margin, y + this.s(4), 'MARKUP', UiTheme.COMMENT_LABEL, this.s(2));
    const saveW = this.s(120), cancelW = this.s(120);
    const buttonsX = width - margin - saveW - this.s(10) - cancelW;
    ui.textWrapped(f.body, margin + this.s(110), y + this.s(2), Math.max(this.s(60), buttonsX - margin - this.s(130)), this.record?.text ?? '', UiTheme.TEXT_SOFT, 1);
    if (w.menuButton(f, buttonsX, y - this.s(6), cancelW, this.returnToGame && !this.dirty ? 'SKIP' : 'CANCEL', false, false, true, this.s(36))) {
      this.close(false);
      return;
    }
    if (w.menuButton(f, buttonsX + cancelW + this.s(10), y - this.s(6), saveW, 'SAVE', true, false, this.dirty || this.typing, this.s(36))) {
      this.close(true);
      return;
    }
    y += this.s(44);

    // Toolbar: tools · colours · thickness · undo / redo / clear (wraps on narrow windows)
    let x = margin;
    const rowH = this.s(32), right = width - margin;
    const toolsW = this.s(380);
    const tool = w.segmented(f, x, y, toolsW, MARKUP_TOOLS, this.tool);
    if (tool !== this.tool) {
      if (this.typing) { this.commitText(); }
      this.tool = tool;
    }
    x += toolsW + this.s(18);

    const swatch = this.s(30), swatchGap = this.s(6);
    const swatchesW = MARKUP_COLOURS.length * (swatch + swatchGap);
    if (x + swatchesW > right) { x = margin; y += rowH + this.s(10); }
    MARKUP_COLOURS.forEach((rgb, i) => {
      const sx = x + i * (swatch + swatchGap);
      const on = i === this.colour;
      ui.rect(sx, y + this.s(1), swatch, swatch, Rgba.hex(rgb));
      ui.outline(sx, y + this.s(1), swatch, swatch, on ? this.s(3) : Math.max(1, ui.scale), on ? UiTheme.ACCENT : UiTheme.CONTROL_BORDER);
      if (w.hover(sx, y, swatch, swatch) && input.leftPressed) {
        this.colour = i;
        input.consumeClicks();
        session.sound.play(SoundId.UiClick);
      }
    });
    x += swatchesW + this.s(12);

    const widthsW = this.s(240);
    if (x + widthsW > right) { x = margin; y += rowH + this.s(10); }
    this.width = w.segmented(f, x, y, widthsW, MARKUP_WIDTHS, this.width);
    x += widthsW + this.s(18);

    const smallW = this.s(72), smallGap = this.s(6);
    if (x + smallW * 3 + smallGap * 2 > right) { x = margin; y += rowH + this.s(10); }
    if (w.smallButton(f, x, y, smallW, rowH, 'UNDO')) { this.undo(); }
    x += smallW + smallGap;
    if (w.smallButton(f, x, y, smallW, rowH, 'REDO')) { this.redoOp(); }
    x += smallW + smallGap;
    if (w.smallButton(f, x, y, smallW, rowH, 'CLEAR', true)) { this.clear(); }
    y += rowH + this.s(16);

    // The picture, fitted
    const base = this.base;
    const areaW = width - margin * 2, areaH = height - y - this.s(52);
    const aspect = base.width / base.height;
    this.pw = Math.min(areaW, areaH * aspect);
    this.ph = this.pw / aspect;
    this.px = margin + (areaW - this.pw) * 0.5;
    this.py = y + (areaH - this.ph) * 0.5;
    ui.image(this.texture, this.px, this.py, this.pw, this.ph, width, height);
    ui.outline(this.px, this.py, this.pw, this.ph, Math.max(1, ui.scale), Rgba.hex(0xffffff, 0.2));

    this.updateMouse(input);
    if (this.drawing) { this.drawShapePreview(this.drawing); }
    if (this.typing) { this.drawTextPreview(f); }

    // Hints
    const hint = this.typing
      ? 'Type the text · Enter places it · Esc cancels it'
      : 'Drag on the picture to draw · A arrow · R box · E ellipse · P pen · T text · 1–5 colour · Ctrl+Z / Ctrl+Y · Enter save · Esc cancel';
    ui.textCentred(f.body, width * 0.5, height - this.s(36), hint, UiTheme.TEXT_MUTED);
  }

  /** The shape being dragged, drawn with the UI batch (screen space). */
  private drawShapePreview(shape: MarkupShape): void {
    const ui = this.session.ui, base = this.base!;
    const scale = this.pw / base.width;
    const stroke = Math.max(1.5, MARKUP_STROKE[shape.width] * base.width * scale);
    const colour = Rgba.hex(MARKUP_COLOURS[shape.colour]);
    const points = shape.points;
    const a = this.toScreen(points[0]), b = this.toScreen(points[points.length - 1]);

    switch (shape.tool) {
      case MarkupTool.Arrow: {
        const g = arrowGeometry(a, b, stroke);
        ui.line(a.x, a.y, g.shaftEnd.x, g.shaftEnd.y, stroke, colour);
        ui.triangle(g.tip.x, g.tip.y, g.left.x, g.left.y, g.right.x, g.right.y, colour);
        break;
      }
      case MarkupTool.Box:
        ui.line(a.x, a.y, b.x, a.y, stroke, colour);
        ui.line(b.x, a.y, b.x, b.y, stroke, colour);
        ui.line(b.x, b.y, a.x, b.y, stroke, colour);
        ui.line(a.x, b.y, a.x, a.y, stroke, colour);
        break;
      case MarkupTool.Ellipse: {
        const cx = (a.x + b.x) * 0.5, cy = (a.y + b.y) * 0.5, rx = Math.abs(b.x - a.x) * 0.5, ry = Math.abs(b.y - a.y) * 0.5;
        const SEGMENTS = 48;
        let px = cx + rx, py = cy;
        for (let i = 1; i <= SEGMENTS; i++) {
          const angle = i * Math.PI * 2 / SEGMENTS;
          const nx = cx + Math.cos(angle) * rx, ny = cy + Math.sin(angle) * ry;
          ui.line(px, py, nx, ny, stroke, colour);
          px = nx;
          py = ny;
        }
        break;
      }
      case MarkupTool.Pen:
        for (let i = 1; i < points.length; i++) {
          const p0 = this.toScreen(points[i - 1]), p1 = this.toScreen(points[i]);
          ui.line(p0.x, p0.y, p1.x, p1.y, stroke, colour);
        }
        break;
    }
  }

  /** The text being typed, with a caret (an approximation of the burned text's size). */
  private drawTextPreview(f: FontAtlas): void {
    const session = this.session, ui = session.ui;
    const at = this.toScreen(this.textAt);
    const colour = Rgba.hex(MARKUP_COLOURS[this.colour]);
    const font = this.width === 2 ? f.title : f.bold;
    const top = at.y - font.lineHeight * 0.5;
    const used = ui.text(font, at.x, top, this.chars, colour);
    if (session.clock % 1 < 0.55) { ui.rect(at.x + used + this.s(2), top, this.s(2), font.lineHeight, colour); }
    if (this.chars.length === 0) { ui.text(f.small, at.x + this.s(8), top + font.lineHeight + this.s(4), 'Type, then Enter', UiTheme.TEXT_MUTED); }
  }

  // #endregion

  // #region Burning

  /** Draws the picture with the visible shapes into the work canvas (anti-aliased) and returns it. */
  private burn(): HTMLCanvasElement {
    const base = this.base!, canvas = this.canvas;
    const g = canvas.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(base, 0, 0);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const imageW = base.width, imageH = base.height;

    for (let i = this.firstVisible(); i < this.ops.length; i++) {
      const shape = this.ops[i];
      if (shape.isClear) { continue; }
      const colour = '#' + MARKUP_COLOURS[shape.colour].toString(16).padStart(6, '0');
      const stroke = Math.max(1.5, MARKUP_STROKE[shape.width] * imageW);
      g.strokeStyle = colour;
      g.fillStyle = colour;
      g.lineWidth = stroke;
      g.lineJoin = 'round';
      const p = shape.points;

      switch (shape.tool) {
        case MarkupTool.Arrow: {
          const a = arrowGeometry(p[0], p[p.length - 1], stroke);
          g.beginPath();
          g.moveTo(p[0].x, p[0].y);
          g.lineTo(a.shaftEnd.x, a.shaftEnd.y);
          g.stroke();
          g.beginPath();
          g.moveTo(a.tip.x, a.tip.y);
          g.lineTo(a.left.x, a.left.y);
          g.lineTo(a.right.x, a.right.y);
          g.closePath();
          g.fill();
          break;
        }
        case MarkupTool.Box:
          g.lineJoin = 'miter';
          g.strokeRect(Math.min(p[0].x, p[1].x), Math.min(p[0].y, p[1].y), Math.abs(p[1].x - p[0].x), Math.abs(p[1].y - p[0].y));
          break;
        case MarkupTool.Ellipse:
          g.beginPath();
          g.ellipse((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2, Math.abs(p[1].x - p[0].x) / 2, Math.abs(p[1].y - p[0].y) / 2, 0, 0, Math.PI * 2);
          g.stroke();
          break;
        case MarkupTool.Pen:
          g.beginPath();
          g.moveTo(p[0].x, p[0].y);
          for (let k = 1; k < p.length; k++) { g.lineTo(p[k].x, p[k].y); }
          g.stroke();
          break;
        case MarkupTool.Text:
          drawText(g, shape, MARKUP_COLOURS[shape.colour], imageH);
          break;
      }
    }
    return canvas;
  }

  /** Redraws the preview texture (the picture with the committed shapes). */
  private rebuildPreview(): void {
    if (!this.base) { return; }
    try {
      const canvas = this.burn();
      if (!this.texture) {
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.bindTexture(gl.TEXTURE_2D, null);
    } catch (e) {
      console.info(`Markup preview failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * SAVE: the burned picture (same size, JPEG) and thumbnail (192 × 108), with the unmarked original kept; or, when
   * everything was cleared, the original back as the picture.
   */
  private saveMarkup(record: CommentRecord): void {
    const marked = this.hasVisible();
    const burned = this.burn(); // with nothing visible: the original drawn plain
    const thumbnail = encodeThumbnail(burned);
    const snapshot = marked ? dataUrlBytes(burned.toDataURL('image/jpeg', SNAPSHOT_QUALITY)) : this.baseBytes!;
    this.session.comments.setMarkup(record, thumbnail, snapshot, marked ? this.baseBytes : null);
  }

  // #endregion
}

/** An arrow's shaft end and head (a triangle at least 4 strokes long). */
function arrowGeometry(from: Vec2, to: Vec2, stroke: number): { shaftEnd: Vec2; tip: Vec2; left: Vec2; right: Vec2 } {
  let dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-3) { return { shaftEnd: to, tip: to, left: to, right: to }; }
  dx /= length;
  dy /= length;
  const head = Math.min(Math.max(stroke * 4.5, 6), length);
  const sx = -dy, sy = dx;
  const bx = to.x - dx * head, by = to.y - dy * head;
  return {
    shaftEnd: vec2(to.x - dx * head * 0.8, to.y - dy * head * 0.8),
    tip: to,
    left: vec2(bx + sx * head * 0.55, by + sy * head * 0.55),
    right: vec2(bx - sx * head * 0.55, by - sy * head * 0.55)
  };
}

/**
 * Text in bold with a contrasting outline (dark for light colours, white for black) so it reads on any background;
 * centred vertically on the click.
 */
function drawText(g: CanvasRenderingContext2D, shape: MarkupShape, rgb: number, imageH: number): void {
  const size = Math.max(10, MARKUP_TEXT[shape.width] * imageH);
  const at = shape.points[0];
  g.font = `bold ${size}px "Segoe UI", system-ui, -apple-system, sans-serif`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  const r = (rgb >> 16) & 0xff, gr = (rgb >> 8) & 0xff, b = rgb & 0xff;
  const brightness = (Math.max(r, gr, b) + Math.min(r, gr, b)) / 510;
  g.lineJoin = 'round';
  g.lineWidth = size * 0.14;
  g.strokeStyle = brightness < 0.25 ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.86)';
  g.strokeText(shape.text ?? '', at.x, at.y);
  g.fillStyle = '#' + rgb.toString(16).padStart(6, '0');
  g.fillText(shape.text ?? '', at.x, at.y);
}

/** The 192 × 108 thumbnail (centre crop to 16:9) as base64 JPEG. */
function encodeThumbnail(source: HTMLCanvasElement): string {
  const thumb = document.createElement('canvas');
  thumb.width = THUMB_WIDTH;
  thumb.height = THUMB_HEIGHT;
  const context = thumb.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  const aspect = THUMB_WIDTH / THUMB_HEIGHT;
  let cropW = source.width, cropH = source.height;
  if (source.width / source.height > aspect) { cropW = Math.trunc(source.height * aspect); } else { cropH = Math.trunc(source.width / aspect); }
  context.drawImage(source, (source.width - cropW) / 2, (source.height - cropH) / 2, cropW, cropH, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
  return thumb.toDataURL('image/jpeg', THUMB_QUALITY).replace(/^data:image\/jpeg;base64,/, '');
}

/** A data: URL's bytes. */
function dataUrlBytes(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
  return bytes;
}
