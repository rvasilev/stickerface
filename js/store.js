// StickerFace state store. No DOM, no canvas, no globals: the DOM never leaks
// in here. All coordinates are NORMALIZED (0..1); pixel conversion lives in
// geometry.js and happens at the render/export edge.
//
// Undo = command pattern: every mutation pushes a {undo, redo} closure pair.
// Drag coalescing: a pointer drag must feel like ONE undo step, so in-progress
// interactive edits use beginDrag()/commitDrag() — live previews are silent
// (no undo entry) and only pointerup pushes a single entry.

const DEFAULT_STRENGTH = { emoji: 0, blur: 18, mosaic: 16 };
const DEFAULT_RADIUS = 0.5;
const DEFAULT_SIZE = 0.18;
const UNDO_CAP = 100;

let nextId = 1;
function uid() {
  return `s${nextId++}`;
}

/** @param {object} st sticker to clone (plain JSON data) */
function clone(st) {
  return JSON.parse(JSON.stringify(st));
}

/** Get sticker by id, or undefined. */
function findSticker(state, id) {
  return state.stickers.find((s) => s.id === id);
}

export class Store {
  constructor() {
    /** @type {{image: object|null, stickers: object[], selection: string|null, tool: string}} */
    this.state = { image: null, stickers: [], selection: null, tool: 'emoji' };
    this._undo = [];
    this._redo = [];
    this._subs = new Set();
    /** In-progress drag frame {id, before} or null. @type {object|null} */
    this._drag = null;
  }

  /** Internal: find a sticker by id. */
  _find(id) {
    return findSticker(this.state, id);
  }

  /** Subscribe to change events. Returns an unsubscribe function. */
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _emit(event = { type: 'change' }) {
    for (const fn of this._subs) {
      try {
        fn(event, this.state);
      } catch {
        // A bad listener must not corrupt state.
      }
    }
  }

  _push(entry) {
    this._undo.push(entry);
    if (this._undo.length > UNDO_CAP) this._undo.shift();
    this._redo.length = 0;
    this._emit({ type: 'history' });
  }

  _snapshot() {
    return this.state.stickers.map(clone);
  }

  _restore(snap) {
    this.state.stickers = snap.map(clone);
    if (this.state.selection && !this._find(this.state.selection)) {
      this.state.selection = null;
    }
    this._emit({ type: 'change' });
  }

  /** Replace the whole sticker list (used by "apply layout to next photo"). */
  setStickers(stickers) {
    const before = this._snapshot();
    const list = (stickers ?? []).map(clone);
    // z is owned by the store, not the caller: a carried layout arrives with the
    // previous photo's z values, and duplicates there would let paint order and
    // array order disagree.
    list.forEach((s, i) => {
      s.z = i + 1;
    });
    this.state.stickers = list;
    const after = this._snapshot();
    this._push({ undo: () => this._restore(before), redo: () => this._restore(after) });
    this._emit({ type: 'change' });
  }

  add(sticker) {
    const before = this._snapshot();
    // z must stay unique and in array order to match moveTo's renumbering:
    // after a delete, `length + 1` can collide with an existing sticker.
    const nextZ = this.state.stickers.reduce((m, s) => Math.max(m, s.z ?? 0), 0) + 1;
    const base = {
      id: sticker.id ?? uid(),
      kind: sticker.kind ?? 'emoji',
      src: sticker.src ?? '',
      cx: sticker.cx ?? 0.5,
      cy: sticker.cy ?? 0.5,
      w: sticker.w ?? DEFAULT_SIZE,
      h: sticker.h ?? DEFAULT_SIZE,
      rot: sticker.rot ?? 0,
      z: nextZ, // the store owns z: a caller-supplied one could collide
      radius: Math.min(0.5, Math.max(0, sticker.radius ?? DEFAULT_RADIUS)),
      strength: Math.max(0, sticker.strength ?? DEFAULT_STRENGTH[sticker.kind ?? 'emoji'] ?? 0),
    };
    // Reassign ids on collision (e.g. layout copied onto a new photo).
    if (this._find(base.id)) base.id = uid();
    this.state.stickers.push(base);
    this.state.selection = base.id;
    const after = this._snapshot();
    this._push({ undo: () => this._restore(before), redo: () => this._restore(after) });
    this._emit({ type: 'add', id: base.id });
    return base;
  }

  move(id, patch) {
    const st = this._find(id);
    if (!st) return;
    if (this._drag && this._drag.id === id) {
      this._applyGeom(st, patch);
      this._emit({ type: 'change' });
      return;
    }
    const before = this._snapshot();
    if (!this._geomChanged(st, patch)) {
      this._emit({ type: 'change' });
      return;
    }
    this._applyGeom(st, patch);
    const after = this._snapshot();
    this._push({ undo: () => this._restore(before), redo: () => this._restore(after) });
    this._emit({ type: 'change' });
  }

  resize(id, patch) {
    this.move(id, patch);
  }

  rotate(id, rot) {
    this.move(id, { rot });
  }

  /**
   * Replace an emoji sticker's artwork IN PLACE. Geometry and z stay put.
   *
   * Not `move(id, { src })`: `_applyGeom` writes only the geometry keys and
   * `_geomChanged` returns false for a src-only patch, so `move` would emit a
   * 'change', report success and change NOTHING — silently. A swap built on it
   * reads correctly in review and does nothing at runtime.
   *
   * Emits 'swap', not 'change'. A layer row's VISIBLE text is the emoji's name
   * (`labelFor`), and 'change' is the geometry fast path that refreshes tooltips
   * only — so a swap emitting 'change' would leave the row naming the old emoji
   * while the canvas showed the new one.
   *
   * Returns true only when it actually swapped; a refused swap must not leave an
   * undo entry behind.
   */
  swapEmoji(id, src) {
    const st = this._find(id);
    if (!st || st.kind !== 'emoji' || typeof src !== 'string' || !src || st.src === src) return false;
    const before = this._snapshot();
    st.src = src;
    const after = this._snapshot();
    this._push({ undo: () => this._restore(before), redo: () => this._restore(after) });
    this._emit({ type: 'swap' });
    return true;
  }

  _applyGeom(st, patch) {
    if (!patch || typeof patch !== 'object') return;
    for (const k of ['cx', 'cy', 'w', 'h', 'rot']) {
      if (typeof patch[k] === 'number' && Number.isFinite(patch[k])) st[k] = patch[k];
    }
    if (typeof patch.radius === 'number' && Number.isFinite(patch.radius)) {
      st.radius = Math.min(0.5, Math.max(0, patch.radius));
    }
    if (typeof patch.strength === 'number' && Number.isFinite(patch.strength)) {
      st.strength = Math.max(0, patch.strength);
    }
  }

  /** True when patch would change the sticker (avoids no-op undo entries). */
  _geomChanged(st, patch) {
    if (!patch || typeof patch !== 'object') return false;
    for (const k of ['cx', 'cy', 'w', 'h', 'rot']) {
      if (typeof patch[k] === 'number' && Number.isFinite(patch[k]) && patch[k] !== st[k]) return true;
    }
    if (typeof patch.radius === 'number' && Number.isFinite(patch.radius)) {
      if (Math.min(0.5, Math.max(0, patch.radius)) !== st.radius) return true;
    }
    if (typeof patch.strength === 'number' && Number.isFinite(patch.strength)) {
      if (Math.max(0, patch.strength) !== st.strength) return true;
    }
    return false;
  }

  remove(id) {
    const index = this.state.stickers.findIndex((s) => s.id === id);
    if (index < 0) return;
    const before = this._snapshot();
    this.state.stickers.splice(index, 1);
    if (this.state.selection === id) this.state.selection = null;
    const after = this._snapshot();
    this._push({ undo: () => this._restore(before), redo: () => this._restore(after) });
    this._emit({ type: 'remove', id });
  }

  raise(id) {
    const index = this.state.stickers.findIndex((s) => s.id === id);
    this.moveTo(id, index + 1);
  }

  lower(id) {
    const index = this.state.stickers.findIndex((s) => s.id === id);
    this.moveTo(id, index - 1);
  }

  /** Move a sticker to an array position (0 = bottom). One undo entry. */
  moveTo(id, index) {
    const from = this.state.stickers.findIndex((s) => s.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(this.state.stickers.length - 1, index));
    if (to === from) return;
    const before = this._snapshot();
    const [item] = this.state.stickers.splice(from, 1);
    this.state.stickers.splice(to, 0, item);
    // z stays in lockstep with array order: render paints ascending z.
    this.state.stickers.forEach((s, i) => { s.z = i + 1; });
    const after = this._snapshot();
    this._push({ undo: () => this._restore(before), redo: () => this._restore(after) });
    // Its own event type: the layer list must rebuild when the ORDER changes.
    this._emit({ type: 'reorder' });
  }

  select(id) {
    this.state.selection = id ?? null;
    this._emit({ type: 'select', id: this.state.selection });
  }

  setTool(tool) {
    if (!['emoji', 'blur', 'mosaic', 'select'].includes(tool)) return;
    this.state.tool = tool;
    this._emit({ type: 'tool', tool });
  }

  clearHistory() {
    this._undo.length = 0;
    this._redo.length = 0;
    this._drag = null;
  }

  setImage(image, { resetStickers = false } = {}) {
    if (resetStickers) {
      // A new photo starts clean: the old photo's stickers and the undo
      // snapshots that could restore them must not survive the boundary.
      this.state.stickers = [];
      this.state.selection = null;
      this.clearHistory();
    }
    this.state.image = image ?? null;
    this._emit({ type: 'image' });
  }

  /**
   * Begin a coalesced drag. Call on pointerdown; call commitDrag() on
   * pointerup. All move/resize/rotate calls between the two are silent
   * previews; commitDrag pushes exactly ONE undo entry (and none if the
   * sticker did not actually change).
   */
  beginDrag(id) {
    const st = this._find(id);
    if (!st) return false;
    this._drag = { id, before: this._snapshot() };
    return true;
  }

  /** End a drag; pushes one undo entry iff geometry changed. Returns it. */
  commitDrag() {
    if (!this._drag) return false;
    const { before } = this._drag;
    this._drag = null;
    const after = this._snapshot();
    if (JSON.stringify(before) === JSON.stringify(after)) {
      this._emit({ type: 'change' });
      return false;
    }
    this._push({ undo: () => this._restore(before), redo: () => this._restore(after) });
    this._emit({ type: 'change' });
    return true;
  }

  /** Cancel a drag, restoring the pre-drag state silently. */
  cancelDrag() {
    if (!this._drag) return;
    this._restore(this._drag.before);
    this._drag = null;
  }

  undo() {
    const entry = this._undo.pop();
    if (!entry) return false;
    entry.undo();
    this._redo.push(entry);
    this._emit({ type: 'undo' });
    return true;
  }

  redo() {
    const entry = this._redo.pop();
    if (!entry) return false;
    entry.redo();
    this._undo.push(entry);
    if (this._undo.length > UNDO_CAP) this._undo.shift();
    this._emit({ type: 'redo' });
    return true;
  }

  get canUndo() {
    return this._undo.length > 0;
  }

  get canRedo() {
    return this._redo.length > 0;
  }

  /** Sorted copy for rendering: ascending z. */
  orderedStickers() {
    return [...this.state.stickers].sort((a, b) => a.z - b.z);
  }
}
