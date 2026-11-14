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
import { exportImage, downloadBlob, cappedExportNote } from './export.js';
import {
  px,
  norm,
  stickerRect,
  hitTest,
  inStickerBox,
  resizeRect,
  rotateTo,
  angleDelta,
  clampStickerScale,
  snapAngle,
  nudge,
  MIN_STICKER_PX,
  clampViewScale,
  focalZoomView,
  wheelZoomFactor,
  isDoubleTap,
} from './geometry.js';
import { PointerTracker } from './pointer-tracker.js';
import { EMOJI } from './emoji.js';

const PREVIEW_LONG_EDGE = 1600;

const PAD_HOLD_DELAY_MS = 300;   // before a held button repeats
const PAD_HOLD_REPEAT_MS = 120;
const PAD_SIZE_DOWN = 0.9;
const PAD_SIZE_UP = 1.1;

// The stage hint is the instruction painted on the photo. There are two, because
// below FRAME_MIN_CHROME_PX the direct handles step aside and the panel's pad is
// the remaining way to move a sticker that is too small to grab. The full string is
// repeated in index.html deliberately: that is what shows before this module runs.
const CHROME_HINT = {
  full: 'Click canvas to drop a sticker · drag a sticker to move it · its corner resizes · the dot above rotates',
  mini: 'Sticker too small to grab — use the panel\'s arrows and size buttons',
};

// Below this the SE handle's 32 px hit area reaches the frame's centre and the
// chrome would block the very drag it is drawn around. Measured with
// diag-small-sticker-probe: free at 36 CSS px, blocked at 30 — so a small sticker
// keeps the BODY as its move handle and the handles hide until it grows back.
const FRAME_MIN_CHROME_PX = 36;

// The first-run coach mark, shown once per browser. Two variants because the copy
// must name the device's own gesture: a mouse user told about "fingers" learns
// nothing, and a touch user told to "click" learns the wrong thing.
const COACH_KEY = 'stickerface.coach.seen';
const COACH_TEXT = {
  touch: 'One finger moves a sticker. Two fingers move or zoom the photo. The sticker\'s corner resizes it and the dot above it rotates.',
  mouse: 'Drag a sticker to move it. Its corner resizes, the dot above it rotates. Scroll to zoom, middle-drag to pan.',
};

/** Cache of decoded bitmaps, keyed by sticker src. */
class CanvasApp {
  /**
   * @param {object} root
   */
  constructor(root = document) {
    this.root = root;
    this.store = new Store();
    this.bitmaps = new Map();
    this.fallback = new Map();
    this.customBitmaps = new Map();
    this.image = null; // HTMLImageElement (+ .name)
    this._layerRows = []; // [{id, label}] — last built layer rows, for geometry-only title updates
    this._layerCount = 0; // stickers.length at the last full rebuild
    this.scale = 1; // canvas px per natural px
    this.canvasW = 0;
    this.canvasH = 0;
    this.pendingLayout = null; // "apply layout to next photo"
    this.lastPickedSrc = EMOJI[0]?.path ?? '';
    this.drag = null;
    // Pan and pinch-zoom are view state (CSS px). Kept OUT of the store on
    // purpose: the view must never touch sticker geometry, the selection, or
    // the undo stack.
    this.view = { dx: 0, dy: 0, scale: 1 };
    // Whether the frame's chrome is currently stood down because the sticker is
    // smaller than a finger-sized handle (see _syncChrome). UI state like `view`,
    // out of the store for the same reason: crossing the threshold must never touch
    // geometry or the undo stack. `null` until the first projection, so the first
    // selection always writes.
    this._chromeSmall = null;
    // Active canvas pointers (client/CSS coords). One -> sticker mode; two or
    // more -> view (pan) mode. The tracker IS the arbitration state: a stale
    // entry makes the next one-finger tap read as a second finger and silently
    // kills tap-to-place. The live count is mirrored to canvas.dataset.pointers
    // — a deliberate measurement contract, kept in one place (see
    // _registerPointer).
    this._pointers = new PointerTracker();
    // Tap-to-place tracking. Placement happens on pointerup only when the
    // gesture stayed within ~8 CSS px and under ~500 ms and was never
    // cancelled by a second pointer — otherwise a pan attempt drops a sticker.
    this._tap = null; // {x, y, t, cancelled}
    // In-progress two-finger pan zoom: {start: {x, y} centroid, startView,
    // focalStart, startDist} — the focal anchors are the CURRENT centroid
    // and CURRENT two-finger distance (rect-relative CSS px) at gesture start.
    this._pan = null;
    // In-progress two-finger STICKER transform: {id, start, startDist,
    // startAngle, startCentroid}. Every frame is derived from these start
    // values, so per-event accumulation cannot drift. Mutually exclusive with
    // _pan: the mode is decided once, when the second pointer lands, and never
    // re-evaluated mid-gesture.
    this._xform = null;
    // Last completed tap (touch double-tap delete needs 350ms/25px windowing
    // inside this router — a separate listener would race pan arbitration).
    this._lastTap = null;
    this._bindEls();
    this._buildPicker();
    this._bindPointer();
    this._bindWheel();
    this._bindKeys();
    this._bindToolbar();
    this._bindPad();
    this._bindCoach();
    this._bindInputs();
    this.store.subscribe((event) => this.onStateChange(event));
    this.init();
  }

  async init() {
    const { bitmaps, fallback, ready, loaded, total } = await decodeEmojiBitmaps();
    this.bitmaps = bitmaps;
    this.fallback = fallback ?? new Map();
    this.onStateChange();
    if (!ready) {
      // `ready` counts BITMAPS. A sticker whose bitmap failed still draws the real
      // artwork from the <img> fallback, so this must not promise a shaded block —
      // the fallback covers everything except the doubly-failed case.
      this.setExportStatus(
        `Some emoji failed to rasterize (${loaded}/${total} decoded) — affected stickers fall back to the original artwork, or to a shaded block if that fails too.`,
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
      coach: $('#coach'),
      coachBody: $('#coach-body'),
      coachDismiss: $('#coach-dismiss'),
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
      pad: $('#sticker-pad'),
      padSizeValue: $('#pad-size-value'),
      padNudgeUp: $('#pad-nudge-up'),
      padNudgeDown: $('#pad-nudge-down'),
      padNudgeLeft: $('#pad-nudge-left'),
      padNudgeRight: $('#pad-nudge-right'),
      padStep1: $('#pad-step-1'),
      padStep10: $('#pad-step-10'),
      padSizeUp: $('#pad-size-up'),
      padSizeDown: $('#pad-size-down'),
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
        // With a sticker selected the picker EDITS that sticker; with nothing
        // selected the click only ARMS the next drop. Placement stays a canvas
        // click (`_placeStickerAt`), which is why this handler never adds one.
        // `swapEmoji` returns false for a non-emoji selection or for the emoji
        // already in place, so neither case needs a branch here.
        const st = this._selectedSticker();
        if (st) this.store.swapEmoji(st.id, entry.path);
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

  /**
   * The highlighted option is the SELECTED sticker's emoji, falling back to
   * `lastPickedSrc` ("armed for the next drop") when nothing is selected.
   * Without the preference the highlight points at an emoji unrelated to the
   * sticker being edited, so the swap reads as arbitrary.
   *
   * `lastPickedSrc` keeps its old meaning and still updates on every picker
   * click, including a refused swap.
   */
  _syncPickerSelection() {
    const st = this._selectedSticker();
    const active = st && st.kind === 'emoji' ? st.src : this.lastPickedSrc;
    for (const btn of this.els.picker.children) {
      btn.setAttribute('aria-selected', btn.dataset.src === active ? 'true' : 'false');
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
      const pending = this.pendingLayout;
      const prevAspect = prevAspectOf(pending, this.image);
      this.pendingLayout = null;
      this.image = img;
      this.store.setImage(img, { resetStickers: true });
      if (pending) {
        // The carried layout is the only undo entry on this photo: history
        // was cleared by the boundary above, so one undo empties the canvas.
        this.store.setStickers(pending);
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
      this._maybeShowCoach();
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
    this._xform = null;
    this._tap = null;
    this._lastTap = null;
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
    // normalized->screen mapping every pointer event goes through.
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
    // `100vh` guarantees the preview never extends past the fold; the viewport
    // caps it too, so the canvas fits inside the window at every size,
    // including very short ones.
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
      this.els.pad.hidden = true;
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
    this.els.pad.hidden = false;
    this.els.padSizeValue.textContent = `${Math.round(st.w * 100)}%`;
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
    // Project the chrome on every frame: the frame's size changes continuously
    // during a resize drag, and crossing the threshold has to be seen. _syncChrome
    // writes only when the state flips, and never while a drag is live — so the
    // handles cannot vanish under the finger that is holding one.
    this._syncChrome(Math.min(cw, ch) < FRAME_MIN_CHROME_PX);
  }

  /* ---------- state -> DOM ---------- */

  onStateChange(event) {
    // The layer list only depends on the sticker set (add/remove/reorder/
    // selection/undo/redo), never on geometry — a drag emits 'change' per
    // pointer move and rebuilding rows every frame is pure churn. Geometry
    // events still need the title/percentage, which changes per move; that
    // is updated here from the live sticker without touching the DOM rows.
    // The 'history' event means the undo stack changed but the sticker set
    // did NOT (commitDrag, move, add, remove all push a 'history' event
    // first) — a stale 'undo' type on that push would rebuild the list once
    // per drag commit, which for the same reason we skip rebuilds per move
    // must stay out of the list-sync set.
    // 'change' vs 'history': 'change' fires on ready/geometry/preview, but
    // may ALSO fire after a full replacement (setStickers' own 'change'
    // comes AFTER its _push 'history', and add()/remove() follow the same
    // pattern). Rebuilding the list on every 'change' would reintroduce the
    // per-move rebuild for exactly the drag case. The rows must stay
    // geometry-fresh but the COUNT must not change mid-drag.
    const needsLayerSync = !event || !event.type || (event.type !== 'change' && event.type !== 'history');
    if (needsLayerSync) {
      this._syncLayerList();
      // Same predicate, same reason: the set OR the selection changed, which is
      // exactly when the picker's highlight must follow. Deliberately NOT on
      // every 'change' — that fires per pointer move during a drag, and 76
      // setAttribute calls per frame is the churn this file already avoids.
      this._syncPickerSelection();
    } else {
      this._updateLayerTitles();
    }
    this._syncToolButtons();
    this._syncHistoryButtons();
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
    // Topmost-first, like every other editor: the store keeps ascending-z
    // array order; only this loop's direction changes.
    const ordered = [...this.store.orderedStickers()].reverse();
    this.els.layerEmpty.hidden = ordered.length > 0;
    this._layerRows = [];
    this._layerCount = ordered.length;
    for (const st of ordered) {
      const li = document.createElement('li');
      li.className = 'layer-row';
      li.setAttribute('aria-selected', st.id === this.store.state.selection ? 'true' : 'false');

      li.appendChild(this._layerGrip(st.id));

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = labelFor(st);
      label.title = rowTitle(st);
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
      this._layerRows.push({ id: st.id, label });
      list.appendChild(li);
    }
  }

  /** The drag source. Decorative, never a button: the accessible reorder
   *  path is the ⤴/⤵ buttons and `[`/`]`, so this pointer-only control
   *  does not need a name. */
  _layerGrip(id) {
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿';
    grip.addEventListener('pointerdown', (e) => this._startLayerDrag(id, grip, e));
    return grip;
  }

  /**
   * Drag one row to restack it. The store commits exactly once, on
   * pointerup: a `moveTo` emits `reorder`, which rebuilds every row, so
   * committing per midpoint crossing would both spam the undo stack and
   * pull the dragged row out from under the gesture. The target slot is
   * therefore computed against the rows' static geometry and applied at
   * drop, and the drop re-reads the array rather than trusting the index
   * captured at press.
   */
  _startLayerDrag(id, grip, e) {
    e.preventDefault();
    const row = grip.parentElement;
    const list = this.els.layerList;
    // Static geometry for the gesture: the rows do not move until the drop.
    const rows = Array.from(list.querySelectorAll('.layer-row'));
    const others = rows.filter((r) => r !== row);
    const pressY = e.clientY;

    // Insertion slot: how many of the OTHER rows the pointer has passed.
    // The dragged row is excluded, so its own transform can never re-rank
    // the rows it is being scored against mid-gesture.
    //
    // The comparison is edge-based, not midpoint-based: a drop ON a row's
    // centre is the common gesture (a pointer released exactly at the
    // midpoint of the last row) and must register as having passed it.
    // A centre-strict `>` there reads "not passed" and the whole drag
    // becomes a no-op.
    const slotFor = (y) => {
      let slot = 0;
      for (const r of others) {
        const b = r.getBoundingClientRect();
        if (y >= b.top + b.height / 2) slot++;
      }
      return slot;
    };

    let moved = false;
    let lastY = pressY;
    row.classList.add('dragging');
    grip.setPointerCapture(e.pointerId);
    const pressSlot = slotFor(pressY);

    const move = (ev) => {
      row.style.transform = `translateY(${ev.clientY - pressY}px)`;
      const slot = slotFor(ev.clientY);
      if (slot !== pressSlot) moved = true;
      let line = list.querySelector('.insertion');
      if (!line) {
        line = document.createElement('div');
        line.className = 'insertion';
        list.appendChild(line);
      }
      // The line sits after the last row the pointer has crossed, at that
      // row's static bottom — before the first row, at the list's top.
      const othersRects = others.map((r) => r.getBoundingClientRect());
      let at = 0;
      for (let i = 0; i < othersRects.length; i++) {
        if (ev.clientY > othersRects[i].top + othersRects[i].height / 2) {
          at = othersRects[i].bottom - list.getBoundingClientRect().top;
        }
      }
      line.style.transform = `translateY(${at}px)`;
    };

    const finish = (commit) => {
      row.classList.remove('dragging');
      row.style.transform = '';
      list.querySelector('.insertion')?.remove();
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', cancel);
      if (!commit || !moved) return;
      // Visual-to-array is THE conversion: the list is topmost-first and
      // array index 0 is the bottom.
      const ordered = this.store.orderedStickers();
      const arrayIndex = ordered.length - 1 - slotFor(lastY);
      this.store.moveTo(id, Math.max(0, Math.min(ordered.length - 1, arrayIndex)));
    };
    const up = (ev) => { lastY = ev.clientY; finish(true); };
    const cancel = () => finish(false);
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', cancel);
  }

  _updateLayerTitles() {
    // Geometry-only events ('change' from move/resize/rotate): the row ORDER
    // and set did not change, so rows stay; only the title's percentage
    // moves with the sticker. No DOM nodes are created here.
    // If the count DOES change (a full replacement committed after a
    // 'history' event, e.g. setStickers on a new photo), rebuild — this
    // branch is only a shortcut for the same-count drag case.
    if (!this._layerRows || this.store.state.stickers.length !== this._layerCount) {
      this._syncLayerList();
      return;
    }
    const byId = new Map();
    for (const st of this.store.state.stickers) byId.set(st.id, st);
    for (const row of this._layerRows) {
      const st = byId.get(row.id);
      if (!st) continue;
      row.label.title = rowTitle(st);
    }
  }

  /* ---------- toolbar / inputs ---------- */

  _bindToolbar() {
    for (const [tool, btn] of Object.entries(this.toolbarTools)) {
      btn.addEventListener('click', () => {
        // Hiding is not disabling: a hidden control still fires its handler
        // when clicked programmatically, so the tool must refuse to activate.
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
    this.els.fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      // Clear the value first: re-picking the SAME file fires no change event
      // otherwise, so a reload would do nothing while the old stickers stayed
      // on the canvas with no way to start clean.
      e.target.value = '';
      this.loadImageFile(file);
    });
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

  // --- arbitration helpers -------------------------------------------------
  // Register/unregister go through these two so canvas.dataset.pointers is
  // always the live count — a deliberate measurement contract, and the one
  // place a leaked contact becomes externally observable.
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
    // already holds the pre-drag snapshot from beginDrag()). The tap is
    // cancelled too, and _lastTap voided, so the gesture cannot end in a
    // placement or a delete.
    if (this._tap) this._tap.cancelled = true;
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
    const focalStart = this._canvasCssPoint(start);
    const pts = this._pointers.values();
    const startDist = pts.length >= 2
      ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      : 0;
    this._pan = { start, startView: { ...this.view }, focalStart, startDist };
    this.els.canvas.dataset.panning = '1';
  }

  _applyPanMove() {
    if (!this._pan) return;
    const rect = this.els.canvas.getBoundingClientRect();
    const focalNow = this._canvasCssPoint(this._centroid());
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

  /**
   * pointerup of a single-finger gesture: decide tap vs drag, then place or
   * delete. A second finger cancels the tap upstream (see _enterPanMode), so a
   * pan attempt can never land here.
   */
  _maybePlaceOnTap(e) {
    const tap = this._tap;
    this._tap = null;
    if (!tap || tap.cancelled || !this.image) return;
    if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) return;   // a drag, not a tap
    if (performance.now() - tap.t > 500) return;
    const curTap = { x: e.clientX, y: e.clientY, t: performance.now() };
    // The double-tap window (350 ms, 25 CSS px) is decided HERE, in the same
    // router that arbitrates pan/drag, so the two cannot race.
    if ((e.pointerType === 'touch' || e.pointerType === 'pen') && isDoubleTap(this._lastTap, curTap)) {
      // Delete the topmost sticker under the second tap. Its release point goes
      // first, then the first tap's point — which is where the sticker was
      // placed, and the correct target if the image moved between the touches.
      const first = this._lastTap;
      this._lastTap = null;
      if (!this._removeTopmostAt(e.clientX, e.clientY) && first) {
        this._removeTopmostAt(first.x, first.y);
      }
      return;
    }
    this._lastTap = curTap;
    const pt = this._canvasPoint(e);
    if (hitTest(pt, this.store.state.stickers, this.image.naturalWidth, this.image.naturalHeight)) return;
    this._placeStickerAt(pt);
  }

  /** Drop the active tool's sticker centred on `pt` (natural px). */
  _placeStickerAt(pt) {
    const { tool } = this.store.state;
    if (tool !== 'emoji' && tool !== 'blur' && tool !== 'mosaic') {
      this.store.select(null);
      return;
    }
    const cx = norm(pt.x, this.image.naturalWidth);
    const cy = norm(pt.y, this.image.naturalHeight);
    if (tool === 'emoji') {
      const w = 0.18;
      this.store.add({
        kind: 'emoji',
        src: this.lastPickedSrc,
        cx,
        cy,
        w,
        h: (w * this.image.naturalWidth) / this.image.naturalHeight,
        rot: 0,
      });
    } else {
      this.store.add({ kind: tool, cx, cy, w: 0.28, h: 0.28, rot: 0 });
    }
  }

  _endStickerGate(e) {
    this._unregisterPointer(e.pointerId);
    if (this._pointers.size === 1) {
      // Dropping from 2 -> 1: end whichever two-finger gesture was running and
      // drop the anchors so the remaining finger does not jump. It is NOT
      // promoted to a sticker drag — the gesture began as a two-finger one and
      // stays that until all fingers lift.
      this._endStickerTransform();
      this._pan = null;
      delete this.els.canvas.dataset.panning;
      return;
    }
    if (this._pointers.size !== 0) return;
    this._endStickerTransform();
    this._pan = null;
    delete this.els.canvas.dataset.panning;
    // Order matters: the tap path first (its add/remove belongs to THIS
    // gesture), then the drag commit. A drag's visit to the tap path
    // early-returns on distance without mutating, so they cannot interfere.
    if (this._tap && !this._tap.cancelled) this._maybePlaceOnTap(e);
    else this._tap = null;
    if (this.drag) {
      // Only a canvas-originated move drag commits here. A handle drag commits
      // in its own `up`, which runs first when the handle captured the pointer.
      const wasMove = this.drag.mode === 'move';
      this.drag = null;
      delete this.els.canvas.dataset.dragging;
      if (wasMove) this.store.commitDrag();
    }
  }

  /**
   * Remove the topmost sticker at a client (CSS) point. THE removal path — the
   * desktop dblclick and the touch double-tap both land here.
   * @param {number} x client (CSS) x
   * @param {number} y client (CSS) y
   * @returns {boolean} true when a sticker was removed
   */
  _removeTopmostAt(x, y) {
    if (!this.image || x == null || y == null) return false;
    const pt = this._canvasPoint({ clientX: x, clientY: y });
    const hit = hitTest(pt, this.store.state.stickers, this.image.naturalWidth, this.image.naturalHeight);
    if (!hit) return false;
    this.store.remove(hit);   // also clears the selection when the hit was selected
    this._lastTap = null;
    return true;
  }

  /** Wire the pointer state machine. A handle's pointerdown stops propagation, so
   *  the canvas never sees it; `_activeHandlePointerId` (set in
   *  _startHandleDrag) is what stops the capture-phase release net from stealing a
   *  handle's pointer. That guard is dynamic, so it does NOT depend on
   *  registration order. */
  _bindPointer() {
    this._bindDesktopDblclick();
    this._bindCanvasPointer();
    this._bindWindowMove();
    this._activeHandlePointerId = null;
    this._bindHandles();
    this._bindReleaseNet();
  }

  /**
   * Two fingers whose centroid started INSIDE the selected sticker's box
   * transform THAT sticker: pinch = scale, twist = rotate, centroid drag =
   * move (Instagram-like). The mode is decided once, here, from the first two
   * pointers, and is never re-evaluated mid-gesture.
   *
   * Returns false when there is nothing to transform, and the caller then pans
   * the photo — so this can only ever ADD a mode, never swallow a pan.
   *
   * Called only when no sticker gesture is in flight: a second finger landing
   * mid-drag cancels that drag and pans instead (see `_enterPanMode`), so a
   * stray finger can never deform something the user did not aim at.
   */
  _tryEnterStickerTransform() {
    const sel = this._selectedSticker();
    if (!sel || !this.image) return false;
    const c = this._centroidNatural();
    if (!c) return false;
    if (!inStickerBox(c, sel, this.image.naturalWidth, this.image.naturalHeight)) return false;

    // The first finger's tap must not survive as a placement once the gesture
    // becomes a transform.
    if (this._tap) this._tap.cancelled = true;
    this._lastTap = null;

    // The press that opened this gesture applied nothing, so there is no drag of
    // its own to undo — but the transform is about to take its OWN snapshot, and a
    // stale one from this press would be folded into it. Cancel it before that
    // happens: the transform commits through the same begin/commit pair.
    if (this._cancelHandleDrag) {
      this._cancelHandleDrag();
      this._cancelHandleDrag = null;
    }
    if (this.drag) {
      this.store.cancelDrag();
      this.drag = null;
      delete this.els.canvas.dataset.dragging;
    }

    const pts = this._pointers.values();
    const a = pts[0];
    const b = pts[1];
    this._xform = {
      id: sel.id,
      // The sticker's geometry AT GESTURE START. Every frame is derived from
      // this plus the current pointers: a ratio of ratios, never an
      // accumulation, which is what keeps a long gesture from drifting.
      start: { cx: sel.cx, cy: sel.cy, w: sel.w, h: sel.h, rot: sel.rot },
      startDist: Math.hypot(a.x - b.x, a.y - b.y),
      startAngle: Math.atan2(b.y - a.y, b.x - a.x),
      startCentroid: c,
    };
    // One undo entry for the whole gesture: press to release is one command.
    this.store.beginDrag(sel.id);
    this.els.canvas.dataset.transforming = '1';
    return true;
  }

  /** Drive the in-flight two-finger sticker transform from its start snapshot. */
  _applyStickerTransform() {
    const g = this._xform;
    if (!g || !this.image) return;
    const st = this.store.state.stickers.find((s) => s.id === g.id);
    if (!st) return;
    const pts = this._pointers.values();
    if (pts.length < 2) return;
    const W = this.image.naturalWidth;
    const H = this.image.naturalHeight;
    const [a, b] = pts;

    // Scale is a RATIO of the same quantity, so the units cancel and the
    // pointer space (client px) never has to be converted.
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    // Clamped on the SHORTER side, in natural px, so k stays > 0: a sticker can
    // neither vanish nor invert, however far the fingers go.
    const k = clampStickerScale(
      g.startDist > 1 ? dist / g.startDist : 1,
      Math.min(g.start.w * W, g.start.h * H),
      Math.min(W, H),
    );

    // Rotate about the sticker's own centre, from the START angle: adding a
    // delta to the start rotation is what stops the sticker walking away as
    // you twist it (a projection about the gesture centroid does exactly that).
    const rot = g.start.rot + angleDelta(g.startAngle, Math.atan2(b.y - a.y, b.x - a.x));

    // Centre follows the centroid delta, in natural px, so a two-finger drag
    // repositions as well as scales.
    const c = this._centroidNatural();
    const dxPx = c ? c.x - g.startCentroid.x : 0;
    const dyPx = c ? c.y - g.startCentroid.y : 0;
    this.store.move(g.id, {
      w: Math.max(0, g.start.w * k),
      h: Math.max(0, g.start.h * k),
      cx: norm(g.start.cx * W + dxPx, W),
      cy: norm(g.start.cy * H + dyPx, H),
    });
    this.store.rotate(g.id, rot);
    this._draw();
    this._positionSelectionBox();
  }

  /** End the transform gesture: one undo entry for the whole thing. */
  _endStickerTransform() {
    if (!this._xform) return;
    this._xform = null;
    delete this.els.canvas.dataset.transforming;
    this.store.commitDrag();
  }

  /** The pointer centroid in natural px (the space sticker geometry lives in). */
  _centroidNatural() {
    const c = this._centroid();
    if (!c) return null;
    const p = this._cssToCanvasPx(c.x, c.y);
    return { x: p.x / this.scale, y: p.y / this.scale };
  }

  /** Client-space point -> rect-relative CSS px: the space `focalZoomView` works
   *  in and the space the pan anchors are stored in. One conversion, so the wheel
   *  and the pan cannot disagree about the origin. */
  _canvasCssPoint(p) {
    const r = this.els.canvas.getBoundingClientRect();
    return { x: p.x - r.left, y: p.y - r.top };
  }

  /** The mouse wheel zooms the photo about the cursor (plain, and with Ctrl/Cmd —
   *  a trackpad pinch arrives as ctrl+wheel, so that branch comes free).
   *
   *  No separate zoom maths: focalStart === focalNow === the cursor reduces
   *  `focalZoomView` to a pure focal zoom, and it is the same clamp and the same
   *  edge cases as the pinch. Zoom is view state only — never sticker geometry,
   *  which is what keeps export normalisation true. */
  _bindWheel() {
    // `passive: false` is required, not stylistic: a passive listener ignores
    // preventDefault(), so the page would scroll AND the canvas would zoom.
    this.els.canvas.addEventListener('wheel', (ev) => {
      if (!this.image) return;
      ev.preventDefault();
      const pt = this._canvasCssPoint({ x: ev.clientX, y: ev.clientY });
      const k = wheelZoomFactor(ev.deltaY, ev.deltaMode);
      const rect = this.els.canvas.getBoundingClientRect();
      this.view = focalZoomView(this.view, pt, pt, 1, k,
        rect.width || this.canvasW, rect.height || this.canvasH);
      this._draw();
      this._positionSelectionBox();
    }, { passive: false });

    // A middle click also fires `auxclick`. Without this it autoscrolls on
    // Windows and pastes the primary selection on X11.
    this.els.canvas.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) ev.preventDefault();
    });
  }

  /** Desktop double-click removes the topmost sticker: the browser's own click
   *  sequence decides a mouse double-click. Touch has no dblclick — its
   *  double-tap is decided in _maybePlaceOnTap. */
  _bindDesktopDblclick() {
    this.els.canvas.addEventListener('dblclick', (e) => {
      if (!this.image) return;
      // A dblclick is a MouseEvent, so it always carries coordinates — a fallback
      // for their absence could never run.
      this._removeTopmostAt(e.clientX, e.clientY);
    });
  }

  /** One-finger arbitration. A press on a sticker starts a move drag; an
   *  empty-space press defers placement to pointerup. A second pointer switches
   *  the gesture to a view pan instead. */
  _bindCanvasPointer() {
    const canvas = this.els.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.image) return;

      // The first-run explainer gets out of the way the moment the user starts
      // using the canvas — a coach mark that has to be dismissed by finding its
      // button is friction, and by now the user has demonstrated they are going.
      this._dismissCoach();

      // Middle button pans the zoomed photo, and must NOT reach the sticker
      // hit-test below: a middle press on a sticker is not a click on it. The drag
      // then feeds the SAME `_applyPanMove` the two-finger gesture uses — with one
      // pointer the focal distance never changes, so `focalZoomView` reduces to a
      // pure translation through the same clamp, and there is no second pan/zoom
      // implementation to drift from the touch one.
      if (e.button === 1) {
        e.preventDefault();         // Windows autoscroll / X11 selection paste
        this._tap = null;           // releasing a pan must never place a sticker
        this._registerPointer(e.pointerId, e.clientX, e.clientY);
        try { canvas.setPointerCapture(e.pointerId); } catch { /* no active pointer */ }
        this._enterPanMode();
        return;
      }
      if (e.button !== 0) return;   // any other button is not an interaction

      this._registerPointer(e.pointerId, e.clientX, e.clientY);
      // IMPORTANT: do NOT call setPointerCapture for touch pointers. Capturing
      // pointer N on the canvas steers that pointer's moves to the canvas even
      // when it belongs to a handle — the second finger landing on a handle
      // must remain a handle event so the gesture can be cancelled, never
      // re-targeted. Mouse/synthetic events have no touch path and historically
      // need capture for drag-outside; capture is harmless there. Capture is
      // therefore only for non-touch pointers, and it is released on pointerup.
      if (e.pointerType !== 'touch') {
        try { canvas.setPointerCapture(e.pointerId); } catch { /* no active pointer */ }
      }

      if (this._pointers.size >= 2) {
        // Two fingers: the mode is decided ONCE, here. A centroid inside the
        // SELECTED sticker's box transforms that sticker (M6); anything else
        // pans the photo. A second finger that lands mid-DRAG always pans: the
        // in-flight sticker gesture is cancelled first, so a stray finger can
        // never deform something the user did not aim at. A press that has not
        // moved anything is not a drag yet — two fingers landing together are
        // the Instagram gesture, not a stray finger.
        const freshPress = !this.drag || !this.drag.moved;
        if (freshPress && this._tryEnterStickerTransform()) return;
        this._enterPanMode();
        return;
      }

      // Exactly one pointer: sticker mode.
      const pt = this._canvasPoint(e);
      this._tap = { x: e.clientX, y: e.clientY, t: performance.now(), cancelled: false };

      const hitId = hitTest(pt, this.store.state.stickers, this.image.naturalWidth, this.image.naturalHeight);
      if (hitId) {
        const st = this.store.state.stickers.find((s) => s.id === hitId);
        this.store.select(hitId);
        // The body IS the move handle, at any size: where the press lands decides
        // what it does, so a press on the sticker always drags it.
        this.drag = { mode: 'move', id: hitId, start: pt, startCx: st.cx, startCy: st.cy };
        this.store.beginDrag(hitId);
        canvas.dataset.dragging = '1';
        return;
      }
      // Empty space: tap-to-place and the selection clear are both DEFERRED to
      // pointerup, so a press that turns into a pan or a drag changes nothing.
    });

    // The hover flag must not outlive the pointer over the canvas, or the whole
    // photo keeps a `move` cursor after the pointer goes to the panel.
    canvas.addEventListener('pointerleave', () => { delete canvas.dataset.hover; });

    canvas.addEventListener('pointermove', (e) => {
      // Hover affordance, with no gesture in flight: the BODY is the move handle, so
      // the cursor is what says a press here would drag the sticker. One hit test per
      // move; the dataset flag is the only state, and the stylesheet reads it.
      if (!this._pointers.size && !this.drag && !this._pan && this.image) {
        const over = hitTest(this._canvasPoint(e), this.store.state.stickers,
                             this.image.naturalWidth, this.image.naturalHeight);
        if (over) canvas.dataset.hover = '1';
        else delete canvas.dataset.hover;
      }
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
      if (this._xform) {
        // The mode was decided when the second pointer landed; a transform
        // never becomes a pan mid-gesture.
        this._applyStickerTransform();
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
        // Did this press actually DRAG? A second finger landing decides the
        // mode from this: mid-drag it cancels and pans, but two fingers that
        // land together (the first has not moved anything yet) transform the
        // sticker. Threshold in natural px, above sensor jitter.
        if (Math.hypot(dx, dy) > 2) this.drag.moved = true;
        const cxp = px(this.drag.startCx, this.image.naturalWidth) + dx;
        const cyp = px(this.drag.startCy, this.image.naturalHeight) + dy;
        this.store.move(st.id, {
          cx: norm(cxp, this.image.naturalWidth),
          cy: norm(cyp, this.image.naturalHeight),
        });
      } else if (this.drag.mode === 'resize') {
        const patch = resizeRect(st, this.drag.handle, pt, {
          imgW: this.image.naturalWidth, imgH: this.image.naturalHeight, keepAspect: this.drag.keepAspect,
        });
        this.store.move(st.id, patch);
      } else if (this.drag.mode === 'rotate') {
        this._rotateFromDrag(st, pt, Boolean(e.shiftKey));
      }
      this._draw();
    });

    canvas.addEventListener('pointerup', (e) => this._endStickerGate(e));
    canvas.addEventListener('pointercancel', (e) => this._endStickerGate(e));
  }

  /**
   * A tracked pointer that moves off the canvas (a handle captured it mid-pinch)
   * must still update the tracker: the pan derives its focal distance from it, so
   * a finger that leaves a handle would otherwise be invisible to the zoom.
   *
   * It also drives the transform, and that is not optional: a touch pointer is
   * implicitly captured by the element under its press, so a two-finger pinch
   * whose fingers land on the frame's HANDLES delivers every move to the handle,
   * not the canvas. Without this the transform is entered and then receives no
   * updates at all — the mode flag says "transforming" while nothing moves.
   */
  _bindWindowMove() {
    window.addEventListener('pointermove', (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._registerPointer(e.pointerId, e.clientX, e.clientY);
      if (this._xform) this._applyStickerTransform();
      if (this._pan) this._applyPanMove();
    });
  }

  /**
   * Safety net for a pointer that lifted while an element other than the canvas
   * was under it (a handle, the panel, outside the canvas): its pointerup fires
   * THERE, so without this the contact survives in the tracker and the next
   * one-finger tap reads as a two-finger pan. Registered in the capture phase and
   * AFTER the handles, so a handle's own pointerdown still stops propagation and
   * its `up` keeps ownership of its pointer.
   */
  _bindReleaseNet() {
    const releasePointer = (e) => {
      if (e.target === this.els.canvas) return;                 // canvas handlers own it
      if (this._activeHandlePointerId === e.pointerId) return;  // the handle's `up` owns it
      if (!this._pointers.has(e.pointerId)) return;
      this._endStickerGate(e);
    };
    window.addEventListener('pointerup', releasePointer, true);
    window.addEventListener('pointercancel', releasePointer, true);
  }

  /** The resize/rotate handles are DOM chrome, so they need their own pointer
   *  handlers; the drag itself lives in _startHandleDrag. */
  _bindHandles() {
    for (const el of this.els.selectBox.querySelectorAll('.handle')) {
      el.addEventListener('pointerdown', (e) => this._startHandleDrag(el, e));
    }
  }

  /**
   * Rotate the sticker by ONE pointer move, as a delta from the previous move.
   * `rawRot` accumulates so a sweep past 180° keeps following the hand, and Shift
   * snaps the RESULT (the sticker's own rotation), never the pointer's angle.
   */
  _rotateFromDrag(st, pt, snap) {
    const centre = { x: px(st.cx, this.image.naturalWidth), y: px(st.cy, this.image.naturalHeight) };
    const now = rotateTo(centre, pt, false);
    this.drag.rawRot += angleDelta(this.drag.lastAngle, now);
    this.drag.lastAngle = now;
    this.store.move(st.id, { rot: snap ? snapAngle(this.drag.rawRot) : this.drag.rawRot });
  }

  /**
   * Drive one resize/rotate drag. The handle owns its pointer for the drag's
   * lifetime; `_cancelHandleDrag` lets the pan path abandon it (a second finger
   * landing) so the orphaned `up` cannot unregister that pointer twice.
   */
  _startHandleDrag(el, e) {
    e.stopPropagation();
    // Hiding is not disabling: a hidden handle still fires this handler when
    // something activates it (a stale shortcut, a programmatic click). The chrome
    // hides itself when the sticker is smaller than the target, so refuse them
    // explicitly rather than relying on the markup.
    if (el.hidden) return;
    const st = this._selectedSticker();
    if (!st || !this.image) return;
    this._registerPointer(e.pointerId, e.clientX, e.clientY);
    if (this._pointers.size >= 2) {
      // Second finger landing on a HANDLE: the same decision as on the canvas.
      // The handles sit on the frame's edge, so a two-finger pinch aimed at the
      // sticker's interior can easily land on two of them — and because a handle
      // press stops propagation, the canvas branch never sees it. A press that
      // has moved nothing is not a gesture yet: it may still become a transform.
      if (!this.drag || !this.drag.moved) {
        if (this._tryEnterStickerTransform()) return;
      }
      this._enterPanMode();
      return;
    }
    if (e.pointerType !== 'touch') {
      try { el.setPointerCapture(e.pointerId); } catch { /* no active pointer */ }
    }
    const handle = el.dataset.handle;
    if (!handle) return;
    this.drag = handle === 'rotate'
      // Rotation accumulates a DELTA per move. The handle sits above the centre,
      // so the pointer's absolute angle at the grab is -90°: writing that in
      // directly snapped the sticker to -90° the moment the drag began.
      ? {
        mode: 'rotate',
        id: st.id,
        lastAngle: rotateTo(
          { x: px(st.cx, this.image.naturalWidth), y: px(st.cy, this.image.naturalHeight) },
          this._canvasPoint(e),
          false,
        ),
        rawRot: st.rot || 0,
      }
      : { mode: 'resize', id: st.id, handle, keepAspect: !e.shiftKey };
    const myDrag = this.drag;   // this listener must only ever drive THIS drag
    this.store.beginDrag(st.id);
    this._activeHandlePointerId = e.pointerId;

    const move = (ev) => {
      // A tracked move refreshes its coordinates even when this handle has no
      // drag to drive: the pan derives its distance from the tracker.
      if (this._pointers.has(ev.pointerId)) this._registerPointer(ev.pointerId, ev.clientX, ev.clientY);
      if (!this.drag) return;
      // This listener OUTLIVES its drag when the gesture ends without a pointerup
      // this element ever sees (a cancelled pointer, a release delivered to
      // whatever captured it). The identity check stops it then firing for the
      // NEXT canvas drag and calling resizeRect with a handle of undefined —
      // which throws inside that pointermove and corrupts the move it interrupted.
      if (this.drag !== myDrag) return;
      if (this._pointers.size >= 2) return;
      // Key the handle off the DRAG, not ev.target: under touch capture,
      // ev.target can be an inner element or the canvas.
      const pt = this._canvasPoint(ev);
      // This drag has now moved something, so it is a real gesture: a second
      // finger landing from here on cancels it and pans (never transforms).
      this.drag.moved = true;
      if (this.drag.mode === 'rotate') {
        this._rotateFromDrag(st, pt, Boolean(ev.shiftKey));
      } else {
        this.store.move(
          st.id,
          resizeRect(st, this.drag.handle, pt, {
            imgW: this.image.naturalWidth, imgH: this.image.naturalHeight, keepAspect: this.drag.keepAspect,
          }),
        );
      }
      this._draw();
    };
    // Both subscriptions (handle + canvas: a finger that LEAVES the handle is
    // only delivered on the canvas) share one detach and one `up`, so the drag
    // ends exactly once.
    const detach = () => {
      for (const target of [el, this.els.canvas]) {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
      }
    };
    const up = () => {
      detach();
      this._unregisterPointer(e.pointerId);
      if (this._activeHandlePointerId === e.pointerId) this._activeHandlePointerId = null;
      if (this._cancelHandleDrag === abandon) this._cancelHandleDrag = null;
      this.drag = null;
      this.store.commitDrag();
    };
    // A cancelled drag's `up` never fires (the pan case); the cancel path calls
    // `abandon` first, so the orphaned `up` is already detached.
    const abandon = () => {
      detach();
      if (this._activeHandlePointerId === e.pointerId) this._activeHandlePointerId = null;
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    this.els.canvas.addEventListener('pointermove', move);
    this.els.canvas.addEventListener('pointerup', up);
    this.els.canvas.addEventListener('pointercancel', up);
    this._cancelHandleDrag = abandon;
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
        const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
        const dy = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0;
        this._nudgeSelected(dx, dy);
      }
    });
  }

  /* ---------- selected-sticker pad ---------- */

  /** Move the selected sticker by preview-px deltas. */
  _nudgeSelected(dxPx, dyPx) {
    const st = this._selectedSticker();
    if (!st || !this.image) return;
    const k = 1 / this.scale;   // preview px -> natural px, one place
    const out = nudge(st, dxPx * k, dyPx * k, this.image.naturalWidth, this.image.naturalHeight);
    this.store.move(st.id, { cx: out.cx, cy: out.cy });
  }

  /** Scale the selected sticker about its centre. */
  _scaleSelected(k) {
    const st = this._selectedSticker();
    if (!st || !this.image) return;
    // The SAME floor a pinch uses (natural px), not a second rule in preview px:
    // the two differed by the view scale, so the pad could shrink a sticker far
    // below what a pinch cannot, or refuse to reach it. Every emoji is square, so
    // flooring w floors the shorter side, which is what the pinch clamp bounds.
    const minW = MIN_STICKER_PX / this.image.naturalWidth;
    const w = Math.max(minW, st.w * k);
    const f = w / st.w;
    this.store.move(st.id, { w, h: st.h * f });
  }

  /**
   * A press-and-hold button. beginDrag/commitDrag wrap the WHOLE hold, so
   * a held button is exactly ONE undo entry.
   */
  _bindHoldButton(btn, apply) {
    let delayTimer = null;
    let repeatTimer = null;
    let heldId = null;
    const stop = () => {
      if (heldId === null) return;
      heldId = null;
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
      delayTimer = repeatTimer = null;
      btn.removeEventListener('pointerup', stop);
      btn.removeEventListener('pointercancel', stop);
      this.store.commitDrag();
    };
    btn.addEventListener('pointerdown', (ev) => {
      const st = this._selectedSticker();
      if (!st) return;
      ev.preventDefault();
      // Capture the pointer, or a hold released OFF the button never reaches
      // `stop`: the interval then repeats for the life of the page and
      // commitDrag never runs, so the whole hold is runaway AND un-undoable.
      // Best-effort — a mouse with no capture support still works through the
      // button's own listeners below.
      try { btn.setPointerCapture(ev.pointerId); } catch { /* no capture available */ }
      heldId = st.id;
      this.store.beginDrag(st.id);
      apply();
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointercancel', stop);
      // Capture can be lost without a pointerup (another element takes it, the
      // window blurs). `stop` is idempotent, so this can only ever help.
      btn.addEventListener('lostpointercapture', stop);
      delayTimer = setTimeout(() => {
        repeatTimer = setInterval(() => {
          // The selection can change mid-hold; never keep editing a
          // sticker the user has moved on from.
          if (this._selectedSticker()?.id !== heldId) return stop();
          apply();
        }, PAD_HOLD_REPEAT_MS);
      }, PAD_HOLD_DELAY_MS);
    });
  }

  _bindPad() {
    this.els.pad.hidden = true;
    this._padStep = 1;
    const arrows = [
      ['padNudgeUp', 0, -1], ['padNudgeDown', 0, 1],
      ['padNudgeLeft', -1, 0], ['padNudgeRight', 1, 0],
    ];
    for (const [key, sx, sy] of arrows) {
      this._bindHoldButton(this.els[key], () => this._nudgeSelected(sx * this._padStep, sy * this._padStep));
    }
    this._bindHoldButton(this.els.padSizeDown, () => this._scaleSelected(PAD_SIZE_DOWN));
    this._bindHoldButton(this.els.padSizeUp, () => this._scaleSelected(PAD_SIZE_UP));

    const setStep = (n) => {
      this._padStep = n;
      this.els.padStep1.setAttribute('aria-pressed', String(n === 1));
      this.els.padStep10.setAttribute('aria-pressed', String(n === 10));
    };
    this.els.padStep1.addEventListener('click', () => setStep(1));
    this.els.padStep10.addEventListener('click', () => setStep(10));
  }

  /**
   * The ONE place the chrome's visibility reaches the DOM: every handle's `hidden`,
   * the frame's own class, the stage hint and the move mark (via the class).
   *
   * Called on every frame — the frame's size changes continuously during a resize
   * drag — so it writes only when the state FLIPS, and never while a drag is live:
   * removing the element under the pointer mid-gesture is how a captured pointer
   * changes target. Nothing here touches the store, so no undo entry can come out
   * of a size crossing the threshold.
   */
  _syncChrome(frameTooSmall) {
    const small = frameTooSmall && !this.drag;
    if (small === this._chromeSmall) return;
    this._chromeSmall = small;
    // `hidden` removes reach AND rendering (no author rule sets `display` on these
    // elements, so the UA sheet applies). Hiding is still not disabling, which is
    // why _startHandleDrag refuses a hidden handle as well.
    for (const el of this.els.selectBox.querySelectorAll('.handle')) el.hidden = small;
    this.els.selectBox.classList.toggle('chrome-mini', small);
    this.els.hint.textContent = small ? CHROME_HINT.mini : CHROME_HINT.full;
  }

  /* ---------- first-run coach mark ---------- */

  _bindCoach() {
    // Hidden in the markup; this is the only place it is revealed.
    this.els.coach.hidden = true;
    this.els.coachDismiss.addEventListener('click', () => this._dismissCoach());
  }

  /**
   * Show the explainer on the FIRST photo only. Called from the image's onload, so
   * there is nothing to explain before a photo exists.
   */
  _maybeShowCoach() {
    if (this._coachSeen()) return;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    this.els.coachBody.textContent = coarse ? COACH_TEXT.touch : COACH_TEXT.mouse;
    this.els.coach.hidden = false;
  }

  /**
   * Has this browser seen the explainer? Storage can throw (private mode, blocked
   * site data) and that must never take the app down — an unreadable flag just
   * means the mark may appear again, which is the harmless direction to fail in.
   */
  _coachSeen() {
    try { return localStorage.getItem(COACH_KEY) === '1'; } catch { return false; }
  }

  /** Hide the explainer and remember it, for either dismissal path. */
  _dismissCoach() {
    if (this.els.coach.hidden) return;
    this.els.coach.hidden = true;
    try { localStorage.setItem(COACH_KEY, '1'); } catch { /* see _coachSeen */ }
  }

  /* ---------- export + batch ---------- */

  async doExport(mime) {
    if (!this.image) return;
    this.setExportStatus('Exporting at full resolution…');
    try {
      // A partial asset failure must never disable the app: export runs
      // whenever an image is loaded; undecodable stickers draw as a block.
      const { blob, filename, degraded, compositeSize } = await exportImage(this.store.state, this.bitmaps, this.customBitmaps, mime, this.fallback);
      downloadBlob(blob, filename);
      // Loud, never silent: when the photo exceeds the canvas cap the
      // export is lower resolution than requested — say exactly what
      // was exported and what was asked for, next to the saved line.
      // (export.js keeps this text in one place: cappedExportNote().)
      const capNote = cappedExportNote(compositeSize);
      this.setExportStatus(
        (degraded
          ? `Saved ${filename} — metadata (EXIF/GPS) removed. ${degraded} sticker(s) had no drawable asset and were exported as a shaded block.`
          : `Saved ${filename} — metadata (EXIF/GPS) removed.`)
        + (capNote ? ` ${capNote}` : ''),
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

/** One title string for a layer row, wherever the row is built or refreshed. */
function rowTitle(st) {
  return `${st.kind}${st.src ? ` — ${st.src}` : ''} · ${Math.round(st.cx * 100)}%, ${Math.round(st.cy * 100)}%`;
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
