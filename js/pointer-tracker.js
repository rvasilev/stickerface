// Pure pointer bookkeeping: the live contact count that arbitrates one finger
// (sticker) from two (pan). No DOM, no canvas, no imports — isolating it keeps
// the count unit-testable without a browser.

export class PointerTracker {
  constructor() {
    /** @type {Map<number, {x:number, y:number}>} */
    this._map = new Map();
  }

  /** Live contact count. */
  get size() {
    return this._map.size;
  }

  /** @param {number} id pointerId @returns {boolean} tracked? */
  has(id) {
    return this._map.has(id);
  }

  /** Add or update a contact; updating an existing id does not grow the count.
   *  @param {number} id pointerId @param {number} x client CSS px
   *  @param {number} y client CSS px @returns {number} new live count */
  add(id, x, y) {
    this._map.set(id, { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 });
    return this._map.size;
  }

  /** @param {number} id pointerId @returns {boolean} true iff the id was tracked */
  remove(id) {
    return this._map.delete(id);
  }

  /** Forget all contacts (a new photo was loaded). */
  clear() {
    this._map.clear();
  }

  /** @returns {{x:number, y:number}[]} live points, for centroid/pan maths */
  values() {
    return [...this._map.values()];
  }

  /** @returns {{x:number, y:number}} centroid in client CSS px; {0,0} when empty */
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
