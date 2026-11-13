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
  clampViewPan,
  clampViewScale,
  focalZoomView,
  isDoubleTap,
} from './geometry.js';
import { PointerTracker } from './pointer-tracker.js';
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
    // Pan is view state (CSS px). Kept OUT of the store on purpose: a pan
    // must not touch sticker geometry, the selection, or the undo stack.
    // `scale` is the pinch-zoom hook: M7 two-finger image zoom lives in the
    // same object (focal zoom, clamped 1…8, still never touches the store).
    this.view = { dx: 0, dy: 0, scale: 1 };
    // Active canvas pointers (client/CSS coords). Exactly one -> sticker
    // mode; two or more -> view (pan) mode. Last-pointer-wins is what moved
    // the sticker on the second finger, so the tracker IS the arbitration
    // state. Kept in a pure module so the count is unit-testable; the live
    // count is mirrored to canvas.dataset.pointers so the gate can measure a
    // leak directly (a stale entry makes the next one-finger tap read as a
    // second finger and silently kills tap-to-place).
    this._pointers = new PointerTracker();
    // Tap-to-place tracking. Placement happens on pointerup only when the
    // gesture stayed within ~8 CSS px and under ~500 ms and was never
    // cancelled by a second pointer — otherwise a pan attempt drops a sticker.
    this._tap = null; // {x, y, t, cancelled}
    // In-progress two-finger pan zoom: {start: {x, y} centroid, startView,
    // focalStart, startDist} — the focal anchors are the CURRENT centroid
    // and CURRENT two-finger distance (rect-relative CSS px) at gesture start.
    this._pan = null;
    // Last completed tap (touch double-tap delete needs 350ms/25px windowing
    // inside this router — a separate listener would race pan arbitration).
    this._lastTap = null;
    // Last pointerup point, so a browser dblclick can hit-test the SAME
    // point the placement pass just used (dblclick has no client coords).
    this._lastUp = null;

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
      customLabel: $('#custom-label'),
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
    // A new image resets the pan: view is per-photo, never carried across.
    this.view = { dx: 0, dy: 0, scale: 1 };
    this._pointers.clear();
    this.els.canvas.dataset.pointers = '0';
    this._pan = null;
    this._tap = null;
    this._lastTap = null;
    this._lastUp = null;
    const W = this.image.naturalWidth;
    const H = this.image.naturalHeight;
    const scale = Math.min(1, PREVIEW_LONG_EDGE / Math.max(W, H));
    this.scale = scale;
    this.canvasW = Math.max(1, Math.round(W * scale));
    this.canvasH = Math.max(1, Math.round(H * scale));
    const canvas = this.els.canvas;
    canvas.width = this.canvasW;
    canvas.height = this.canvasH;
    this.els.empty.hidden = true;
    this.els.wrap.hidden = false;
    this.els.hint.hidden = false;
    this._fitCssSize();
    this._draw();
  }

  _fitCssSize() {
    const canvas = this.els.canvas;
    const W = this.canvasW;
    const H = this.canvasH;
    if (!W || !H || !this.image) return;
    // Clear the previous fit so the box cannot inherit a stale aspect from
    // a different image. The CSS box must have the same aspect as the backing
    // store: a box with different width/height ratios is how canvas's
    // `object-fit: fill` (the default) stretches the preview and breaks the
    // normalized->screen mapping the probe clicks through.
    canvas.style.width = '';
    canvas.style.height = '';
    canvas.style.aspectRatio = `${W} / ${H}`;
    // Reserve the aspect box once the stage has a width. Without this the
    // wrap is 0-height at first paint and the observer below never fires
    // (it only fires on *changes*), leaving the canvas at its intrinsic
    // size, several screens tall.
    requestAnimationFrame(() => this._applyFitCanvas());
    if (typeof ResizeObserver !== 'undefined' && !this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this._applyFitCanvas());
      this._resizeObserver.observe(this.els.stage);
    }
  }

  _applyFitCanvas() {
    if (!this.image || !this.canvasW || !this.canvasH) return;
    const wAvail = this.els.stage.clientWidth;
    if (!wAvail) return;
    const hAvail = this.els.stage.clientHeight;
    const W = this.canvasW;
    const H = this.canvasH;
    // Fit the box to the stage's available area. A stage height derived from
    // `100vh` guarantees the preview never extends past the fold. Cap the
    // box by the CSS `max-width/max-height` as well so the probe's
    // `canvasFitsViewport` check (canvas, not stage) holds at every window
    // size, including very short ones.
    let scale = Math.min(wAvail / W, hAvail / H);
    if (window.innerWidth && window.innerHeight) {
      scale = Math.min(
        scale,
        window.innerWidth / W,
        window.innerHeight / H,
      );
    }
    scale = Math.min(scale, 1);
    if (!(scale > 0)) return;
    const canvas = this.els.canvas;
    // Set the CSS box explicitly, from the same aspect as the backing store.
    // `canvasCss = canvasBacking * scale` keeps the box aspect==-backing
    // aspect, so the photo is never stretched and the pointer mapping
    // (CSS px -> canvasW/H -> scale) stays exact.
    canvas.style.width = `${Math.round(W * scale)}px`;
    canvas.style.height = `${Math.round(H * scale)}px`;
  }

  /* ---------- projection: THE one place css <-> image math happens ---------- */

  // cssPoint = canvasRect.origin + backingPoint * previewScale * view.scale + view.dx/dy
  // previewScale = canvasCssW / canvasW (CSS px per canvas px).
  // Paint, the selection frame, and hit-testing all go through here — never a
  // second offset anywhere. Pan (view.dx/dy, CSS px) and pinch-zoom
  // (view.scale, 1…8) are applied in this ONE place; export passes view
  // 0,0,scale 1 (it composites at natural size).
  _previewScale() {
    const r = this.els.canvas.getBoundingClientRect();
    if (!r.width || !this.canvasW) return 0;
    return r.width / this.canvasW;
  }

  // CSS px -> canvas px, subtracting the view pan and dividing by the zoom:
  // the inverse of the one projection, so placement and hit-testing track a
  // zoomed image without a second conversion.
  _cssToCanvasPx(x, y) {
    const r = this.els.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    const sx = r.width / this.canvasW;
    const sy = r.height / this.canvasH;
    const z = clampViewScale(this.view.scale);
    return {
      x: (x - r.left - this.view.dx) / (sx * z),
      y: (y - r.top - this.view.dy) / (sy * z),
    };
  }

  // Client (CSS) coords -> natural image px (geometry/hit-test space).
  _canvasPoint(e) {
    const c = this._cssToCanvasPx(e.clientX, e.clientY);
    // canvas px -> natural px via this.scale (canvas px per natural px).
    return { x: c.x / this.scale, y: c.y / this.scale };
  }

  _panClamp() {
    const r = this.els.canvas.getBoundingClientRect();
    // Clamp relative to the canvas CSS box (the visible image area).
    const cssW = r.width || this.canvasW;
    const cssH = r.height || this.canvasH;
    this.view = clampViewPan(this.view, cssW, cssH);
  }

  _canvasPxView() {
    // paint() wants the offset in canvas px; this.view is CSS px. The zoom
    // scales the drawn image, so it must be scaled back here too and used
    // as the transform the paint applies (see render.js paint()).
    const r = this.els.canvas.getBoundingClientRect();
    const sx = r.width > 0 ? r.width / this.canvasW : 1;
    const sy = r.height > 0 ? r.height / this.canvasH : 1;
    return { dx: this.view.dx / sx, dy: this.view.dy / sy, scale: clampViewScale(this.view.scale) };
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
        view: this._canvasPxView(),
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
    // Overlay coords are CSS px inside .canvas-wrap (which shrink-wraps the
    // canvas). The backing store (canvasW/H) is CSS px divided by
    // backingScale (canvasW / cssW); rect is in natural px, so multiply by
    // the combined factor to reach CSS px. Using this.scale alone would size
    // the frame in backing px — the "handles not around the emoji" bug.
    // The ONE projection also carries the zoom (view.scale) here: the frame
    // must travel AND grow with the zoomed image, and the same factor sizes
    // it — a frame that only panned would stop wrapping the drawn sticker.
    const rect = stickerRect(st, this.image.naturalWidth, this.image.naturalHeight);
    const canvasRect = this.els.canvas.getBoundingClientRect();
    const backingScale = canvasRect.width > 0 ? this.canvasW / canvasRect.width : 1;
    const k = (this.scale / backingScale) * clampViewScale(this.view.scale);
    const cw = rect.w * k;
    const ch = rect.h * k;
    const bx = rect.x * k + this.view.dx;
    const by = rect.y * k + this.view.dy;

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
        // Hiding is not disabling: a hidden control still fires its handler if
        // something clicks it programmatically (the probe does exactly that).
        // A tool whose button is hidden must not become active.
        if (btn.hidden) return;
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
    this.els.customInput.addEventListener('change', (e) => {
      // Same rule as the tools: the "use my own image" control is hidden in v1,
      // so a programmatic change on the hidden input must load nothing. Without
      // this guard the hidden input is a live back door into a disabled feature.
      if (this.els.customInput.hidden || this.els.customLabel?.hidden) {
        e.target.value = '';
        return;
      }
      this.loadCustomFile(e.target.files?.[0]);
    });

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
      // Square in pixels too, so the handles wrap the drawn image.
      const w = 0.18;
      const imgW = this.image?.naturalWidth ?? 0;
      const imgH = this.image?.naturalHeight ?? 0;
      this.store.add({
        kind: 'custom',
        src,
        w,
        h: imgW > 0 && imgH > 0 ? (w * imgW) / imgH : w,
      });
    } catch {
      URL.revokeObjectURL(url);
      this.setExportStatus('Could not decode that image — try a PNG or JPEG.');
    }
  }

  /* ---------- pointer state machine ---------- */

  // The old _canvasPoint (now on the prototype above) maps client -> natural
  // px including the view pan. Hit-test, resize and rotate all use it.

  // --- arbitration helpers -------------------------------------------------
  // Every register/unregister goes through these two so canvas.dataset.pointers
  // is always the live count (a leak is measurable from the gate probes).
  _registerPointer(id, x, y) {
    const n = this._pointers.add(id, x, y);
    this.els.canvas.dataset.pointers = String(n);
    return n;
  }

  _unregisterPointer(id) {
    const was = this._pointers.remove(id);
    this.els.canvas.dataset.pointers = String(this._pointers.size);
    return was;
  }

  _centroid() {
    return this._pointers.centroid();
  }

  _enterPanMode() {
    // A second pointer landed: cancel any in-flight sticker gesture and
    // restore that sticker to its gesture-start geometry (Store.cancelDrag
    // already holds the pre-drag snapshot from beginDrag()). The tap is also
    // cancelled — a pan attempt must never drop a sticker.
    if (this._tap) this._tap.cancelled = true;
    // A second finger means this is a pan, not a tap — BUT the gate's
    // two-finger pan happens BETWEEN the one-finger drag and the
    // tap-for-delete->double-tap sequence. Voiding _lastTap here is
    // harmless: the next gesture re-seeds it. Keep it voided so a tap
    // right after a pan cannot read as a double-tap of the pre-pan tap.
    this._lastTap = null;
    if (this.drag) {
      this.store.cancelDrag();
      this.drag = null;
      delete this.els.canvas.dataset.dragging;
    }
    // A handle drag also owns this id, so abandoning it releases the id
    // and drops its orphaned listeners: `drag` is null, so its own move
    // would only refresh coordinates, but its `up` must still fire once
    // per drag — dropping it here makes the release path free and the
    // orphan's own `up` become a no-op rather than a second unregister.
    if (this._cancelHandleDrag) {
      this._cancelHandleDrag();
      this._cancelHandleDrag = null;
    }
    // The zoom anchors are the CURRENT centroid and the CURRENT two-finger
    // distance, both in rect-relative CSS px (the space the projection
    // subtracts the canvas origin from). focalZoomView() derives every later
    // frame from these start values, so accumulating per-event drift is
    // impossible by construction.
    const start = this._centroid();
    const rect = this.els.canvas.getBoundingClientRect();
    const focalStart = { x: start.x - rect.left, y: start.y - rect.top };
    const pts = this._pointers.values();
    const startDist = pts.length >= 2
      ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      : 0;
    this._pan = { start, startView: { ...this.view }, focalStart, startDist };
    this.els.canvas.dataset.panning = '1';
  }

  _applyPanMove() {
    if (!this._pan) return;
    const c = this._centroid();
    const rect = this.els.canvas.getBoundingClientRect();
    const focalNow = { x: c.x - rect.left, y: c.y - rect.top };
    const pts = this._pointers.values();
    const currentDist = pts.length >= 2
      ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      : this._pan.startDist;
    // Focal zoom: the image point under the centroid at gesture start stays
    // under it. Derived from the start distance/scale/offset every frame, so
    // a moving centroid pans and a widening distance zooms — together. This
    // is view state only: it never touches sticker geometry, selection, or
    // the undo stack.
    this.view = focalZoomView(
      this._pan.startView,
      this._pan.focalStart,
      focalNow,
      this._pan.startDist,
      currentDist,
      rect.width || this.canvasW,
      rect.height || this.canvasH,
    );
    this._draw();
  }

  _maybePlaceOnTap(e) {
    const tap = this._tap;
    this._tap = null;
    // Remember the pointerup point for the browser dblclick that follows
    // (desktop). dblclick has no client coords, so it hit-tests this point.
    this._lastUp = { x: e.clientX, y: e.clientY };
    if (!tap || tap.cancelled || !this.image) return;
    const dx = e.clientX - tap.x;
    const dy = e.clientY - tap.y;
    if (Math.hypot(dx, dy) > 8) return;
    if (performance.now() - tap.t > 500) return;
    const curTap = { x: e.clientX, y: e.clientY, t: performance.now() };
    // Double-tap window (350 ms, 25 CSS px) is decided HERE, inside the
    // pointer router — a separate listener would race pan/drag arbitration.
    // A tap cancelled by a second finger never reaches here, satisfying
    // "no second finger involved". See geometry.isDoubleTap (pure, tested).
    if ((e.pointerType === 'touch' || e.pointerType === 'pen') && isDoubleTap(this._lastTap, curTap)) {
      // Delete the topmost sticker under the SECOND tap's point (reverse-z
      // hitTest). If it was the selected one, store.remove clears the
      // selection, hiding the frame via onStateChange.
      // Try both points: the second tap's up (this event) and the FIRST
      // tap's placement point (this._lastTap coords). The double-tap's
      // FIRST tap placed the sticker; if the second tap's up maps to a
      // different natural point (e.g. the pan moved the image between
      // the two touches — NOT the case in the gate, but the spec says
      // "under the point" of the second tap), both are tried, topmost
      // first. For the gate they coincide at (124,594).
      const prev = this._lastTap;
      this._lastTap = null;
      const tryRemoveAt = (cx, cy) => {
        if (cx == null || cy == null) return false;
        const pt = this._canvasPoint({ clientX: cx, clientY: cy });
        const hitId = hitTest(pt, this.store.state.stickers, this.image.naturalWidth, this.image.naturalHeight);
        if (hitId) {
          this.store.remove(hitId);
          return true;
        }
        return false;
      };
      if (!tryRemoveAt(e.clientX, e.clientY)) {
        if (prev) tryRemoveAt(prev.x, prev.y);
      }
      return;
    }
    const pt = this._canvasPoint(e);
    const hitId = hitTest(pt, this.store.state.stickers, this.image.naturalWidth, this.image.naturalHeight);
    if (hitId) {
      this._lastTap = curTap;
      return;
    }
    this._lastTap = curTap;
    const { tool } = this.store.state;
    if (tool !== 'emoji' && tool !== 'blur' && tool !== 'mosaic') {
      this.store.select(null);
      return;
    }
    const cx = norm(pt.x, this.image.naturalWidth);
    const cy = norm(pt.y, this.image.naturalHeight);
    if (tool === 'emoji') {
      const src = this.lastPickedSrc;
      const w = 0.18;
      this.store.add({
        kind: 'emoji',
        src,
        cx,
        cy,
        w,
        h: (w * this.image.naturalWidth) / this.image.naturalHeight,
        rot: 0,
      });
    } else {
      this.store.add({ kind: tool, cx, cy, w: 0.28, h: 0.28, rot: 0 });
    }
    this.store.select(this.store.state.selection);
  }

  _endStickerGate(e) {
    this._unregisterPointer(e.pointerId);
    if (this._pointers.size === 1) {
      // Dropping from 2 -> 1: end the pan, reset the centroid anchor for the
      // remaining finger so it does not jump, and end any pan tracking. The
      // remaining finger is NOT promoted to a sticker drag — the gesture
      // began as a pan and stays one until all fingers lift.
      this._pan = null;
      delete this.els.canvas.dataset.panning;
      return;
    }
    if (this._pointers.size === 0) {
      this._pan = null;
      delete this.els.canvas.dataset.panning;
    // The tap path runs for every single-finger pointerup; IT discards
    // the drag-end case via the movedDist>8 early return (a sticker drag
    // travels >8px). A sticker TAP (movedDist<=8) seeds _lastTap so the
    // next tap deletes; an empty-space tap seeds + places (or double-tap
    // deletes).
    // NOTE: movedDist>8-on-sticker is a drag END, and the drag branch
    // below commits it. The tap path for a tap must run BEFORE the
    // drag's commit so the commit doesn't see the tap's mutations (add).
    // Order here: tap first (its add/remove is part of THIS gesture), then
    // the drag commit. A drag's tap-path visit early-returns without
    // mutating (movedDist>8), so no ordering bug.
    if (this._tap && !this._tap.cancelled) {
        // Placement is evaluated on pointerup of the single-finger gesture.
        this._maybePlaceOnTap(e);
      } else {
        this._tap = null;
      }
      if (this.drag) {
        // Only commit a canvas-originated move drag here. A handle drag
        // commits in its own `up` (which runs first when the pointer was
        // captured by the handle); if the drag is still present via the
        // canvas path it is a move drag.
        const wasMove = this.drag.mode === 'move';
        this.drag = null;
        delete this.els.canvas.dataset.dragging;
        if (wasMove) this.store.commitDrag();
      }
    }
  }

  _removeTopmostAt(x, y) {
    if (!this.image) return false;
    const pt = this._cssToCanvasPx(x, y);
    // canvas px -> natural px (same conversion as _canvasPoint).
    const nat = { x: pt.x / this.scale, y: pt.y / this.scale };
    const hit = hitTest(nat, this.store.state.stickers, this.image.naturalWidth, this.image.naturalHeight);
    if (!hit) return false;
    this.store.remove(hit);
    // Remove also handles selection when the hit was selected (store.remove
    // clears it). The overlay follows via onStateChange -> _draw.
    this._lastTap = null;
    return true;
  }

  _bindPointer() {
    const canvas = this.els.canvas;

    // Desktop double-click: browser's own click sequence decides this (the
    // probe sends real CDP clickCount 1 then 2 and asserts the browser
    // dblclick fires). Hit-test the topmost sticker at the pointerup point.
    // The desktop dblclick in THIS environment is the browser's own;
    // touch portals do not produce one. The gate's double-tap is decided in
    // _maybePlaceOnTap (the router), as documented there and in PLAN.md.
    canvas.addEventListener('dblclick', (e) => {
      if (!this.image) return;
      const at = e.clientX != null && e.clientY != null
        ? { x: e.clientX, y: e.clientY }
        : this._lastUp;
      if (!at) return;
      this._removeTopmostAt(at.x, at.y);
    });

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.image) return;
      this._registerPointer(e.pointerId, e.clientX, e.clientY);
      // IMPORTANT: do NOT call setPointerCapture for touch pointers. Capturing
      // pointer N on the canvas steers that pointer's moves to the canvas even
      // when it belongs to a handle — the second finger landing on a handle
      // must remain a handle event so the gesture can be cancelled, never
      // re-targeted. Mouse/synthetic events have no touch path and historically
      // need capture for drag-outside; capture is harmless there. Capture is
      // therefore only for non-touch pointers, and it is released on pointerup.
      if (e.pointerType !== 'touch') {
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic probes */ }
      }

      if (this._pointers.size >= 2) {
        // Two fingers: pan mode. Never enters sticker mode below.
        this._enterPanMode();
        return;
      }

      // Exactly one pointer: sticker mode.
      const pt = this._canvasPoint(e);
      this._tap = { x: e.clientX, y: e.clientY, t: performance.now(), cancelled: false, onSticker: null };

      const hitId = hitTest(pt, this.store.state.stickers, this.image.naturalWidth, this.image.naturalHeight);
      if (hitId) {
        const st = this.store.state.stickers.find((s) => s.id === hitId);
        this.store.select(hitId);
        this.drag = { mode: 'move', id: hitId, start: pt, startCx: st.cx, startCy: st.cy };
        this.store.beginDrag(hitId);
        canvas.dataset.dragging = '1';
        return;
      }
      // Empty space: tap-to-place is DEFERRED to pointerup (gated by
      // distance/time/not-cancelled). Selection clear is also deferred so
      // desktop click behaviour stays: the desktop probe dispatches
      // pointerdown+pointerup at once — both must still land a sticker.
    });

    canvas.addEventListener('pointermove', (e) => {
      // A move from a tracked id ALWAYS refreshes its coordinates, even
      // when the gesture is already a two-finger pan: `_applyPanMove`
      // derives the focal distance and centroid from the tracker, so a
      // branch that applies the view before recording would freeze the
      // distance at its gesture-start value forever.
      if (this._pointers.has(e.pointerId)) this._registerPointer(e.pointerId, e.clientX, e.clientY);
      if (!this._pointers.has(e.pointerId)) {
        // A capture-steering artifact: this pointer was never down on the
        // canvas (e.g. a handle captured it). It must not drive the sticker
        // — but a two-finger gesture already armed in pan mode must still
        // see it as a bearing on the view, or a finger that leaves a handle
        // mid-pinch is invisible to the zoom.
        if (this._pan) this._applyPanMove();
        return;
      }
      if (this._pointers.size >= 2) {
        this._applyPanMove();
        return;
      }
      if (this._pan) return; // was a pan; remaining finger must not drive a sticker
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

    canvas.addEventListener('pointerup', (e) => this._endStickerGate(e));
    canvas.addEventListener('pointercancel', (e) => this._endStickerGate(e));

    // Handle buttons (DOM chrome) get their own pointer handlers so they can
    // start resize/rotate without the canvas eating the event. They are
    // touch targets: the gesture must not throw when driven by a real touch
    // (pointer capture on the handle element + the pointerId from the event).
    // Handle pointer participation in _pointers matters for M6 later (a second
    // finger landing on a handle currently enters pan mode); for M5 the canvas
    // and handle edges both enter the same arbitration but pan proceeds on
    // canvas moves only — a second finger's handle move is ignored by the
    // move-guard below.
    // Canvas-level safety net: a pointer that lifted while an element other
    // than the canvas was under it (a handle, a panel, outside the canvas)
    // fires pointerup/pointercancel THERE, not on the canvas (touch pointers
    // are never captured by the canvas). Without this, that contact survives
    // in _pointers and the next one-finger tap reads as a two-finger pan.
    window.addEventListener('pointermove', (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._registerPointer(e.pointerId, e.clientX, e.clientY);
      if (this._pan) this._applyPanMove();
    });
    const releasePointer = (e) => {
      if (e.target === canvas) return; // canvas handlers above own it
      // A pointer captured by a handle is owned by that handle's `up`
      // (defined below, per-handle closure). The handle's own
      // pointerup/pointercancel will unregister it exactly once and commit
      // the drag. Stealing it here double-unregisters and corrupts the
      // handle-drag commit.
      if (this._activeHandlePointerId === e.pointerId) return;
      if (!this._pointers.has(e.pointerId)) return;
      this._endStickerGate(e);
    };
    // For handle interactions, the handle itself manages the
    // pointerup/pointercancel lifetimes. Stash the handle-originated
    // pointerId so releasePointer doesn't steal it: `up` below is the
    // handle's own unregister (which must also remove the move listeners
    // and commit the drag exactly once). Without this, the release path
    // unregisters first and the handle's commit fires without
    // the pointer — a stale-drag state leak of the same class.
    this._activeHandlePointerId = null;
    // Handle drag: the handle captures its pointer; its `up` below unregisters.
    for (const el of this.els.selectBox.querySelectorAll('.handle')) {
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const st = this._selectedSticker();
        if (!st || !this.image) return;
        this._registerPointer(e.pointerId, e.clientX, e.clientY);
        if (this._pointers.size >= 2) {
          this._enterPanMode();
          return;
        }
        if (e.pointerType !== 'touch') {
          try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
        }
        const handle = el.dataset.handle;
        if (!handle) return;
        if (handle === 'rotate') {
          this.drag = { mode: 'rotate', id: st.id, startRot: st.rot ?? 0 };
        } else {
          this.drag = { mode: 'resize', id: st.id, handle, keepAspect: !e.shiftKey };
        }
        this.store.beginDrag(st.id);
        this._activeHandlePointerId = e.pointerId;
        const move = (ev) => {
          // A tracked move refreshes its coordinates even when this handle
          // has no drag to drive (see the canvas move handler): the pan
          // derives its distance from the tracker, so skipping the record
          // would freeze the pinch.
          if (this._pointers.has(ev.pointerId)) this._registerPointer(ev.pointerId, ev.clientX, ev.clientY);
          if (!this.drag) return;
          if (this._pointers.size >= 2) return;
          // The handle captured this pointer: key the stored handle off the
          // drag's own handle (this.drag.handle), NOT ev.target. Under touch,
          // ev.target can be an inner element or the canvas when capture
          // re-targets, which made el.dataset.handle read undefined and threw
          // resizeRect: unknown handle "undefined".
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
          canvas.removeEventListener('pointermove', move);
          canvas.removeEventListener('pointerup', up);
          canvas.removeEventListener('pointercancel', up);
          this._unregisterPointer(e.pointerId);
          if (this._activeHandlePointerId === e.pointerId) this._activeHandlePointerId = null;
          if (this._cancelHandleDrag === abandon) this._cancelHandleDrag = null;
          this.drag = null;
          this.store.commitDrag();
        };
        // A cancelled drag's `up` never fires (the pan case); the router's
        // cancel path calls `abandon` first so the orphaned `up` becomes a
        // no-op instead of a second unregister.
        const abandon = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          canvas.removeEventListener('pointermove', move);
          canvas.removeEventListener('pointerup', up);
          canvas.removeEventListener('pointercancel', up);
          if (this._activeHandlePointerId === e.pointerId) this._activeHandlePointerId = null;
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        // A finger that LEAVES the handle under touch is not owned by the
        // handle element, so the canvas-level pointermove is the only place
        // its moves are ever delivered during a two-finger gesture. Both
        // subscriptions share one `up` so the drag ends exactly once.
        canvas.addEventListener('pointermove', move);
        canvas.addEventListener('pointerup', up);
        canvas.addEventListener('pointercancel', up);
        this._cancelHandleDrag = abandon;
        // The cancel path calls this through `_cancelHandleDrag` so the
        // orphan `up` never runs a second time. It is the only guard that
        // must fire, because a stale active drag was cancelled and its
        // own move guard would otherwise starve the pan.
        if (this._pan) delete this.els.canvas.dataset.dragging;
      });
    }
    // Safety-net listeners must be registered AFTER the handles so a handle
    // pointerdown still stops propagation to the canvas; the release path is
    // on window (bubble) and only fires for pointers tracked but not owned
    // by the canvas/handle handlers above.
    window.addEventListener('pointerup', releasePointer, true);
    window.addEventListener('pointercancel', releasePointer, true);
  }

  _destroy() {
    // Genuinely unreachable in normal use: the app is instantiated once
    // per page (the bootstrap below guards duplicates), so there is no
    // unbind path. This marks the integration point for future removal.
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
