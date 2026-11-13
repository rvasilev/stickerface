// Pure pointer bookkeeping for StickerFace. No DOM, no canvas, no globals, no
// imports — the live count is exposed to the page by the caller
// (canvas.dataset.pointers) so a leak is measurable from the gate, but this
// module never touches the DOM.
//
// Why a separate module: the gesture router must know the exact live contact
// count to arbitrate one-finger (sticker) vs two-finger (pan). A stale entry
// makes the next one-finger tap look like the second finger of a pan, which
// silently kills tap-to-place. Isolating the count lets it be unit-tested in
// node without a browser.

export class PointerTracker {
  constructor() {
    /** @type {Map<number, {x:number, y:number}>} */
    this._map = new Map();
  }

  /** Number of live contacts. */
  get size() {
    return this._map.size;
  }

  /** True when this pointerId is currently tracked. */
  has(id) {
    return this._map.has(id);
  }

  /**
   * Add or update a contact. Updating an existing id does not grow the count.
   * @param {number} id pointerId
   * @param {number} x client (CSS) x
   * @param {number} y client (CSS) y
   * @returns {number} the new live count
   */
  add(id, x, y) {
    this._map.set(id, { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 });
    return this._map.size;
  }

  /**
   * Remove a contact after it lifts or is cancelled.
   * @param {number} id pointerId
   * @returns {boolean} true iff the id was tracked
   */
  remove(id) {
    return this._map.delete(id);
  }

  /** Forget all contacts (new photo loaded). */
  clear() {
    this._map.clear();
  }

  /** Snapshot of live points, for centroid/pan math. */
  values() {
    return [...this._map.values()];
  }

  /** Centroid of the live contacts in client (CSS) px; {0,0} when empty. */
  centroid() {
    const pts = this.values();
    if (!pts.length) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    for (const p of pts) {
      x += p.x;
      y += p.y;
    }
    return { x: x / pts.length, y: y / pts.length };
  }
}
