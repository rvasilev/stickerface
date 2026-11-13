// DOM wiring for StickerFace. Keeps the store pure: this file owns every
// document/canvas call, the canvas pointer state machine, and the selection
// chrome (8 resize handles + rotate handle) drawn as DOM over the canvas.

import { Store } from './store.js';
import {
  requestDraw,
  decodeEmojiBitmaps,
  decodeCustomBitmap,
  paint,
} from './render.js';
import { exportImage, downloadBlob } from './export.js';
import {
  px,
  norm,
  stickerRect,
  hitTest,
  resizeRect,
  rotateTo,
  nudge,
} from './geometry.js';
import { EMOJI } from './emoji.js';

const PREVIEW_LONG_EDGE = 1600;

/** Cache of decoded bitmaps, keyed by sticker src. */
export class CanvasApp {
  /**
   * @param {object} root
   */
  constructor(root = document) {
    this.root = root;
    this.store = new Store();
    this.bitmaps = new Map();
    this.fallback = new Map();
    this.customBitmaps = new Map();
    this.ready = false;
    this.loadedCount = 0;
    this.totalCount = EMOJI.length;
    this.image = null; // HTMLImageElement (+ .name)
    this.scale = 1; // canvas px per natural px
    this.canvasW = 0;
    this.canvasH = 0;
    this.pendingLayout = null; // "apply layout to next photo"
    this.lastPickedSrc = EMOJI[0]?.path ?? '';
    this.drag = null;

    this._bindEls();
    this._buildPicker();
    this._bindPointer();
    this._bindKeys();
    this._bindToolbar();
    this._bindInputs();
    this.store.subscribe(() => this.onStateChange());
    this.init();
  }

  async init() {
    const { bitmaps, fallback, ready, loaded, total } = await decodeEmojiBitmaps();
    this.bitmaps = bitmaps;
    this.fallback = fallback ?? new Map();
    this.ready = ready;
    this.loadedCount = loaded;
    this.totalCount = total;
    this.onStateChange();
    if (!ready) {
      this.setExportStatus(
        `Some emoji failed to rasterize (${loaded}/${total} decoded) — affected stickers will export as a shaded block so nothing is left uncovered.`,
      );
    }
  }

  _$(sel) {
    return this.root.querySelector(sel);
  }

  _bindEls() {
    const $ = (s) => this._$(s);
    this.els = {
      stage: $('main.stage'),
      empty: $('#stage-empty'),
      wrap: $('#canvas-wrap'),
      canvas: $('#stage-canvas'),
      selectBox: $('#select-box'),
      hint: $('#stage-hint'),
      fileInput: $('#file-input'),
      customInput: $('#custom-input'),
      picker: $('#emoji-picker'),
      layerList: $('#layer-list'),
      layerEmpty: $('#layer-empty'),
      undo: $('#btn-undo'),
      redo: $('#btn-redo'),
      exportPng: $('#btn-export-png'),
      exportJpeg: $('#btn-export-jpeg'),
      exportStatus: $('#export-status'),
      applyNext: $('#btn-apply-next'),
      about: $('#btn-about'),
      aboutPanel: $('#about-panel'),
      strength: $('#strength'),
      strengthValue: $('#strength-value'),
      radius: $('#radius'),
      radiusValue: $('#radius-value'),
    };
    this.ctx = this.els.canvas.getContext('2d');
    this.toolbarTools = {
      emoji: $('#tool-emoji'),
      blur: $('#tool-blur'),
      mosaic: $('#tool-mosaic'),
    };
  }

  _buildPicker() {
    // Idempotent per element: the picker gets exactly one button per emoji
    // even if construction is ever re-entered.
    if (this.els.picker.dataset.built === '1' && this.els.picker.children.length === EMOJI.length) {
      return;
    }
    this.els.picker.replaceChildren();
    for (const entry of EMOJI) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', entry.path === this.lastPickedSrc ? 'true' : 'false');
      btn.title = entry.label;
      btn.dataset.src = entry.path;
      const img = document.createElement('img');
      img.src = entry.path;
      img.alt = entry.label;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 36;
      img.height = 36;
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        this.lastPickedSrc = entry.path;
        this.store.setTool('emoji');
        this._syncPickerSelection();
        this._syncToolButtons();
        this._draw();
      });
      this.els.picker.appendChild(btn);
    }
    this.els.picker.dataset.built = '1';
  }

  _syncPickerSelection() {
    for (const btn of this.els.picker.children) {
      btn.setAttribute('aria-selected', btn.dataset.src === this.lastPickedSrc ? 'true' : 'false');
    }
  }

  _syncToolButtons() {
    const tool = this.store.state.tool;
    for (const [name, btn] of Object.entries(this.toolbarTools)) {
      btn.setAttribute('aria-pressed', name === tool ? 'true' : 'false');
    }
  }

  /* ---------- image loading ---------- */

  loadImageFile(file) {
    if (!file || !String(file.type ?? '').startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      img.name = file.name || 'photo';
      const prevAspect = prevAspectOf(this.pendingLayout, this.image);
      this.image = img;
      this.store.setImage(img);
      // "Apply layout to next photo" keeps the normalized sticker layout;
      // warn when the aspect drifts by more than 5%.
      if (this.pendingLayout) {
        const prev = this.pendingLayout;
        this.pendingLayout = null;
        this.store.setStickers(prev);
        if (prevAspect > 0) {
          const nextAspect = img.naturalWidth / img.naturalHeight;
          const drift = Math.abs(nextAspect / prevAspect - 1);
          if (drift > 0.05) {
            this.setExportStatus(
              `Note: aspect ratio differs by ${Math.round(drift * 100)}% from the previous photo — stickers kept their normalized positions but may not cover faces exactly.`,
            );
          }
        }
      }
      this.fitCanvas();
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  fitCanvas() {
    if (!this.image) return;
    const W = this.image.naturalWidth;
    const H = this.image.naturalHeight;
    const scale = Math.min(1, PREVIEW_LONG_EDGE / Math.max(W, H));
    this.scale = scale;
    this.canvasW = Math.max(1, Math.round(W * scale));
    this.canvasH = Math.max(1, Math.round(H * scale));
    const canvas = this.els.canvas;
    canvas.width = this.canvasW;
    canvas.height = this.canvasH;
    // CSS size follows the canvas; cap height for small screens.
    canvas.style.width = `${this.canvasW}px`;
    canvas.style.height = `${this.canvasH}px`;
    this.els.empty.hidden = true;
    this.els.wrap.hidden = false;
    this.els.hint.hidden = false;
    this._draw();
  }

  /* ---------- painting + selection chrome ---------- */

  _draw() {
    if (!this.image) return;
    const { stickers, selection } = this.store.state;
    requestDraw(() => {
      paint(this.ctx, {
        image: this.image,
        stickers: this.store.orderedStickers(),
        bitmaps: this.bitmaps,
        fallback: this.fallback,
        customBitmaps: this.customBitmaps,
        imgW: this.image.naturalWidth,
        imgH: this.image.naturalHeight,
        scale: this.scale,
      });
      this._positionSelectionBox();
    });
  }

  _selectedSticker() {
    const sel = this.store.state.selection;
    return sel ? this.store.state.stickers.find((s) => s.id === sel) : undefined;
  }

  _positionSelectionBox() {
    const st = this._selectedSticker();
    const box = this.els.selectBox;
    if (!st || !this.image) {
      box.hidden = true;
      return;
    }
    const rect = stickerRect(st, this.image.naturalWidth, this.image.naturalHeight);
    const cw = rect.w * this.scale;
    const ch = rect.h * this.scale;
    const bx = rect.x * this.scale;
    const by = rect.y * this.scale;

    box.hidden = false;
    // The chrome box is the UN-rotated rect (keeps handle buttons simple);
    // for a rotated sticker we rotate the box itself to match the paint.
    box.style.left = `${bx}px`;
    box.style.top = `${by}px`;
    box.style.width = `${cw}px`;
    box.style.height = `${ch}px`;
    if (st.rot) {
      box.style.transform = `rotate(${st.rot}rad)`;
      box.style.transformOrigin = '50% 50%';
    } else {
      box.style.transform = '';
    }
  }

  /* ---------- state -> DOM ---------- */

  onStateChange() {
    this._syncToolButtons();
    this._syncHistoryButtons();
    this._syncLayerList();
    this._syncExportButtons();
    this._syncStrengthInputs();
    this._draw();
  }

  _syncHistoryButtons() {
    this.els.undo.disabled = !this.store.canUndo;
    this.els.redo.disabled = !this.store.canRedo;
    this.els.applyNext.disabled = this.store.state.stickers.length === 0 || !this.image;
  }

  _syncExportButtons() {
    const hasImage = Boolean(this.image);
    // Export gates on "an image is loaded", never on a fully decoded
    // catalogue: a missing asset degrades to a placeholder, it never blocks.
    this.els.exportPng.disabled = !hasImage;
    this.els.exportJpeg.disabled = !hasImage;
  }

  _syncStrengthInputs() {
    const st = this._selectedSticker();
    if (st && (st.kind === 'blur' || st.kind === 'mosaic')) {
      this.els.strength.value = String(Math.round(st.strength ?? (st.kind === 'blur' ? 18 : 16)));
      this.els.radius.value = String(st.radius ?? 0.5);
    }
    this.els.strengthValue.textContent = this.els.strength.value;
    this.els.radiusValue.textContent = Number(this.els.radius.value).toFixed(2);
  }

  _syncLayerList() {
    const list = this.els.layerList;
    list.replaceChildren();
    const ordered = this.store.orderedStickers();
    this.els.layerEmpty.hidden = ordered.length > 0;
    for (const st of ordered) {
      const li = document.createElement('li');
      li.className = 'layer-row';
      li.setAttribute('aria-selected', st.id === this.store.state.selection ? 'true' : 'false');

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = labelFor(st);
      label.title = `${st.kind}${st.src ? ` — ${st.src}` : ''} · ${Math.round(st.cx * 100)}%, ${Math.round(st.cy * 100)}%`;
      li.appendChild(label);

      const fwd = document.createElement('button');
      fwd.type = 'button';
      fwd.textContent = '⤴';
      fwd.title = 'Bring forward (])';
      fwd.setAttribute('aria-label', `Bring ${label.textContent} forward`);
      fwd.addEventListener('click', () => this.store.raise(st.id));
      li.appendChild(fwd);

      const back = document.createElement('button');
      back.type = 'button';
      back.textContent = '⤵';
      back.title = 'Send back ([)';
      back.setAttribute('aria-label', `Send ${label.textContent} back`);
      back.addEventListener('click', () => this.store.lower(st.id));
      li.appendChild(back);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'Delete (Delete)';
      del.setAttribute('aria-label', `Delete ${label.textContent}`);
      del.addEventListener('click', () => this.store.remove(st.id));
      li.appendChild(del);

      li.addEventListener('click', () => this.store.select(st.id));
      list.appendChild(li);
    }
  }

  /* ---------- toolbar / inputs ---------- */

  _bindToolbar() {
    for (const [tool, btn] of Object.entries(this.toolbarTools)) {
      btn.addEventListener('click', () => {
        this.store.setTool(tool);
        this._syncToolButtons();
      });
    }
    this.els.undo.addEventListener('click', () => this.store.undo());
    this.els.redo.addEventListener('click', () => this.store.redo());
    this.els.exportPng.addEventListener('click', () => this.doExport('image/png'));
    this.els.exportJpeg.addEventListener('click', () => this.doExport('image/jpeg'));
    this.els.applyNext.addEventListener('click', () => this.applyLayoutToNext());
    this.els.about.addEventListener('click', () => {
      const open = this.els.aboutPanel.hidden;
      this.els.aboutPanel.hidden = !open;
      this.els.about.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  _bindInputs() {
    this.els.fileInput.addEventListener('change', (e) => this.loadImageFile(e.target.files?.[0]));
    this.els.customInput.addEventListener('change', (e) => this.loadCustomFile(e.target.files?.[0]));

    // Drag & drop a photo onto the stage.
    this.els.stage.addEventListener('dragover', (e) => e.preventDefault());
    this.els.stage.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      this.loadImageFile(file);
    });

    this.els.strength.addEventListener('input', () => {
      const st = this._selectedSticker();
      if (!st || (st.kind !== 'blur' && st.kind !== 'mosaic')) return;
      this.store.move(st.id, { strength: Number(this.els.strength.value) });
      this.els.strengthValue.textContent = this.els.strength.value;
      this._draw();
    });
    this.els.radius.addEventListener('input', () => {
      const st = this._selectedSticker();
      if (!st || (st.kind !== 'blur' && st.kind !== 'mosaic')) return;
      this.store.move(st.id, { radius: Number(this.els.radius.value) });
      this.els.radiusValue.textContent = Number(this.els.radius.value).toFixed(2);
      this._draw();
    });
  }

  async loadCustomFile(file) {
    if (!file || !String(file.type ?? '').startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    try {
      const bitmap = await decodeCustomBitmap(url);
      const src = `user:${url}`;
      this.customBitmaps.set(src, bitmap);
      // A custom-image sticker behaves like an emoji sticker (translate/
      // rotate draw) but keeps its own bitmap slot; kind 'custom'.
      this.store.add({
        kind: 'custom',
        src,
        w: 0.18,
        h: 0.18,
      });
    } catch {
      URL.revokeObjectURL(url);
      this.setExportStatus('Could not decode that image — try a PNG or JPEG.');
    }
  }

  /* ---------- pointer state machine ---------- */

  _canvasPoint(e) {
    const r = this.els.canvas.getBoundingClientRect();
    // Pointer in natural px (store space is normalized; geometry is px-space
    // for resize/hit-test). The canvas bitmap is canvasW/H, so map the CSS
    // point into natural px via the scale factor.
    const cssX = (e.clientX - r.left) * (this.canvasW / r.width);
    const cssY = (e.clientY - r.top) * (this.canvasH / r.height);
    return {
      x: cssX / this.scale,
      y: cssY / this.scale,
    };
  }

  _bindPointer() {
    const canvas = this.els.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.image) return;
      canvas.setPointerCapture(e.pointerId);
      const pt = this._canvasPoint(e);
      const { tool } = this.store.state;

      // Selection hit-test first (zoomed: geometry is natural-px space).
      const hitId = hitTest(pt, this.store.state.stickers, this.image.naturalWidth, this.image.naturalHeight);
      if (hitId) {
        const st = this.store.state.stickers.find((s) => s.id === hitId);
        this.store.select(hitId);
        // Drag to move (unless a place tool is active and the user clicked
        // empty space — handled below). Handles are DOM buttons, so canvas
        // pointerdown only needs move-dragging; resize/rotate come from the
        // handle buttons themselves.
        this.drag = { mode: 'move', id: hitId, start: pt, startCx: st.cx, startCy: st.cy };
        this.store.beginDrag(hitId);
        canvas.dataset.dragging = '1';
        return;
      }

      // Empty space: drop a sticker at the point (needs a place tool).
      if (tool === 'emoji' || tool === 'blur' || tool === 'mosaic') {
        const cx = norm(pt.x, this.image.naturalWidth);
        const cy = norm(pt.y, this.image.naturalHeight);
        if (tool === 'emoji') {
          const src = this.lastPickedSrc;
          // Square default; emoji keepAspect is handled on corner drags.
          this.store.add({ kind: 'emoji', src, cx, cy, w: 0.18, h: 0.18, rot: 0 });
        } else {
          this.store.add({ kind: tool, cx, cy, w: 0.28, h: 0.28, rot: 0 });
        }
        this.store.select(this.store.state.selection);
        return;
      }
      this.store.select(null);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag || !this.image) return;
      const pt = this._canvasPoint(e);
      const st = this.store.state.stickers.find((s) => s.id === this.drag.id);
      if (!st) return;

      if (this.drag.mode === 'move') {
        const dx = pt.x - this.drag.start.x;
        const dy = pt.y - this.drag.start.y;
        const cxp = px(this.drag.startCx, this.image.naturalWidth) + dx;
        const cyp = px(this.drag.startCy, this.image.naturalHeight) + dy;
        this.store.move(st.id, {
          cx: norm(cxp, this.image.naturalWidth),
          cy: norm(cyp, this.image.naturalHeight),
        });
      } else if (this.drag.mode === 'resize') {
        const patch = resizeRect(st, this.drag.handle, pt, this.image.naturalWidth, this.image.naturalHeight, this.drag.keepAspect);
        this.store.move(st.id, patch);
      } else if (this.drag.mode === 'rotate') {
        const cxp = px(st.cx, this.image.naturalWidth);
        const cyp = px(st.cy, this.image.naturalHeight);
        const angle = rotateTo({ x: cxp, y: cyp }, pt, Boolean(e.shiftKey));
        this.store.move(st.id, { rot: angle });
      }
      this._draw();
    });

    const endPointer = () => {
      if (!this.drag) return;
      this.drag = null;
      delete canvas.dataset.dragging;
      // Drag coalescing: one undo entry for the whole gesture (commit on release).
      this.store.commitDrag();
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    // Handle buttons (DOM chrome) get their own pointer handlers so they can
    // start resize/rotate without the canvas eating the event.
    for (const el of this.els.selectBox.querySelectorAll('.handle')) {
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const st = this._selectedSticker();
        if (!st || !this.image) return;
        el.setPointerCapture(e.pointerId);
        const handle = el.dataset.handle;
        if (handle === 'rotate') {
          this.drag = { mode: 'rotate', id: st.id, startRot: st.rot ?? 0 };
        } else {
          this.drag = { mode: 'resize', id: st.id, handle, keepAspect: !e.shiftKey };
        }
        this.store.beginDrag(st.id);
        const move = (ev) => {
          if (!this.drag) return;
          const pt = this._canvasPoint(ev);
          if (this.drag.mode === 'rotate') {
            const cxp = px(st.cx, this.image.naturalWidth);
            const cyp = px(st.cy, this.image.naturalHeight);
            this.store.move(st.id, { rot: rotateTo({ x: cxp, y: cyp }, pt, Boolean(ev.shiftKey)) });
          } else {
            this.store.move(
              st.id,
              resizeRect(st, this.drag.handle, pt, this.image.naturalWidth, this.image.naturalHeight, this.drag.keepAspect),
            );
          }
          this._draw();
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          this.drag = null;
          this.store.commitDrag();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    }
  }

  /* ---------- keyboard ---------- */

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      const target = e.target;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (!this.image) return;
      const st = this._selectedSticker();

      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) this.store.redo();
        else this.store.undo();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st) {
          e.preventDefault();
          this.store.remove(st.id);
        }
        return;
      }

      if (e.key === '[' && st) {
        this.store.lower(st.id);
        return;
      }
      if (e.key === ']' && st) {
        this.store.raise(st.id);
        return;
      }

      const step = e.shiftKey ? 10 : 1; // px @ preview scale per PLAN.md
      if (st && this.image && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        // Arrows nudge 1 px @preview scale (Shift = 10): convert to natural px.
        const pxStep = step / this.scale;
        const dx = e.key === 'ArrowRight' ? pxStep : e.key === 'ArrowLeft' ? -pxStep : 0;
        const dy = e.key === 'ArrowDown' ? pxStep : e.key === 'ArrowUp' ? -pxStep : 0;
        this.store.move(st.id, (() => {
          const cur = { cx: st.cx, cy: st.cy };
          const out = nudge({ ...st, cx: cur.cx, cy: cur.cy }, dx, dy, this.image.naturalWidth, this.image.naturalHeight);
          return { cx: out.cx, cy: out.cy };
        })());
      }
    });
  }

  /* ---------- export + batch ---------- */

  async doExport(mime) {
    if (!this.image) return;
    this.setExportStatus('Exporting at full resolution…');
    try {
      // A partial asset failure must never disable the app: export runs
      // whenever an image is loaded; undecodable stickers draw as a block.
      const { blob, filename, degraded } = await exportImage(this.store.state, this.bitmaps, this.customBitmaps, mime, this.fallback);
      downloadBlob(blob, filename);
      this.setExportStatus(
        degraded
          ? `Saved ${filename} — metadata (EXIF/GPS) removed. ${degraded} sticker(s) had no decoded bitmap and were exported as a shaded block.`
          : `Saved ${filename} — metadata (EXIF/GPS) removed.`,
      );
    } catch (err) {
      this.setExportStatus(`Export failed: ${err.message}`);
    }
  }

  applyLayoutToNext() {
    if (!this.image || this.store.state.stickers.length === 0) return;
    // Keep the normalized layout; the next photo loads with the same positions.
    const layout = this.store.orderedStickers().map((s) => ({ ...s }));
    layout.__aspect = this.image.naturalWidth / this.image.naturalHeight;
    this.pendingLayout = layout;
    this.setExportStatus('Layout kept — choose the next photo. Normalized positions are reused; a >5% aspect change will warn.');
    this.els.fileInput.click();
  }

  setExportStatus(text) {
    if (this.els.exportStatus) this.els.exportStatus.textContent = text;
  }
}

function labelFor(st) {
  if (st.kind === 'emoji') {
    const found = EMOJI.find((e) => e.path === st.src);
    return found ? found.label : 'emoji';
  }
  if (st.kind === 'custom') return 'custom image';
  return st.kind;
}

function prevAspectOf(layout, image) {
  if (Array.isArray(layout) && layout.length) {
    const marker = layout.__aspect;
    if (typeof marker === 'number' && marker > 0) return marker;
  }
  if (image) return image.naturalWidth / image.naturalHeight;
  return 0;
}

// Bootstrap: one module entry, no framework. The singleton guard makes a
// second import (or a second constructed instance on the same document)
// impossible — a second one would double the picker and double every
// canvas click handler, adding two stickers per click.
let app = window.__stickerface ?? null;
if (app instanceof CanvasApp) {
  // Already booted; reuse the existing instance.
} else {
  app = new CanvasApp(document);
  window.__stickerface = app;
}
export { app };
